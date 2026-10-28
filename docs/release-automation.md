# Release automation

`scripts/release.mjs` drives a coordinated release: it works out which packages
changed, decides their next versions, applies the derived metadata, and (only
with an explicit flag) commits, tags, pushes, and waits for the publish
workflows.

The pure logic lives in `scripts/release-lib.mjs` — no git, no filesystem, no
network — so the version policy and the derived-metadata table are unit tested
directly in `tests/unit/scripts/release-lib.test.ts`.

```bash
node ./scripts/release.mjs plan      # read-only: what would ship, and why
node ./scripts/release.mjs apply --yes
node ./scripts/release.mjs check     # fail on drift; safe in CI
node ./scripts/release.mjs publish --yes
```

`bun run release:plan` and friends are aliases. `plan --json` emits the whole
plan for scripting.

`apply` writes the tree and stops so the CHANGELOG prose and the diff can be
reviewed. `publish` reads the tree `apply` produced — it does **not** re-derive
versions, because `apply` has already bumped every manifest and re-running the
policy would propose a second bump. `publish` without `--yes` is a dry run of
exactly what would be pushed.

`plan` and `apply` diff **committed** state: the baseline is each package's last
tag and the target is `HEAD`, so uncommitted work is invisible to detection (as
it is to CI). Commit or merge first.

## What is automated

| Step | How |
|---|---|
| Which packages changed | `git diff <pkg's own last tag>..HEAD`, classified by the path table in `release-lib.mjs` |
| Publish order | Static waves: `relay-protocol` first, then `relay` + `channel-relay`, then the independent packages |
| Next version | The beta/stable policy below |
| Derived metadata | The edit table below, printed by `plan` and applied by `apply` |
| Protocol ranges | Rewritten in `relay`, `relay-web`, `channel-relay` whenever protocol ships |
| `minXacpxVersion` + peer floors | Rewritten in the three compatible plugins whenever core ships |
| rmux-bridge versions | `scripts/sync-rmux-bridge-versions.mjs` when channel-relay ships |
| Lockfiles | `npm install --package-lock-only`, then `bun install`, then reconcile both |
| CHANGELOG headings | `spliceChangelog` — keeps authored prose, adds a heading per package |

One entry there looks like over-reach and is not: **a consumer's protocol range
is rewritten even when that consumer is not released.** npm semver excludes
prereleases unless the range names one, so `^0.4.0` does not match a workspace
`0.4.2-beta.0` — npm then quietly resolves a stale registry copy into
`packages/<consumer>/node_modules/`. Local builds stay green while `npm ci` or
`build:packages` fails, or ships against the wrong protocol. `relay-web` is the
easy one to miss: it is private, but its `vue-tsc` typecheck still needs the
current protocol.

## Version policy

**While a base version is unreleased, a new beta increments the counter.**
`0.24.10-beta.3` → `0.24.10-beta.4`. It does not move the base and reset to
`-beta.0`; that claims a version nobody shipped and burns a number per beta.

| Current | `--beta` | `--stable` |
|---|---|---|
| `X.Y.Z-beta.N` (base unreleased) | `X.Y.Z-beta.(N+1)` — `--bump` is **ignored** | `X.Y.Z` — `--bump` is **ignored** |
| `X.Y.Z-beta.N` (base already tagged) | refuses — reconcile the manifest | `X.Y.Z` |
| `X.Y.Z` | `bump(Z, --bump)-beta.0` | `bump(Z, --bump)` |

`--bump` is never inferred: nothing in a diff reliably separates a feature from
a fix, so the tool does not guess. It is read only when the manifest is a
**stable** version, and it defaults to `patch`. Every other path ignores it, which
is why a beta release needs no flag at all.

`--new-cycle` forces the next base while the manifest is a prerelease
(`--beta --bump minor --new-cycle` turns `0.24.10-beta.3` into
`0.25.0-beta.0`); it refuses when that base is already tagged. Use it when you
decide to abandon a doomed prerelease line rather than promote it.

"Base already tagged" is read from git tags (`<prefix>X.Y.Z`), not the registry,
so the policy is deterministic and offline-testable. A tag existing is not proof
the npm publish succeeded, but the two diverge only when a release failed
mid-flight, which is exactly the case that deserves a human.

## Which packages get released

A package ships when a file it owns changed since its own last tag. Two
propagations are not obvious:

- **`packages/relay-web/**` → `relay`.** relay-web is private and bundled into
  relay at build time.
- **A core release republishes `channel-relay`, `channel-feishu`, and
  `channel-discord` even with no source change.** Those plugins statically
  import runtime named exports from `xacpx/plugin-api`, which ESM resolves
  during linking — before the plugin's default export runs, and therefore
  before `minXacpxVersion`'s runtime check can refuse. The published peer range
  is the only guard, so it must track core. `plan` labels these
  `(republished so its published floor tracks core)`.

`channel-yuanbao` does not track the core floor (its peer is `0.17.0` and it
imports no newer runtime export), and `weacpx-compat` never releases on its own
— it is republished from the core workflow.

The root `package.json` is judged by its **shipped fields** (`bin`, `exports`,
`files`, `engines`, `dependencies`, …), not by "it changed". Adding an npm
script or a devDependency ships nothing, and because a core release republishes
every floor tracker, treating that as a core change would fan one tooling edit
out into five releases. The `version` field is excluded too — bumping it *is*
the release, not evidence for one.

Paths that ship no bytes — `docs/`, `tests/`, `scripts/`, `.github/` — map to no
package, so a docs-only or test-only change releases nothing.

`apply` refuses to run when a manifest already carries a version with no tag:
that means a previous `apply` has not been published, and applying again would
compute the next version from it and burn a number nobody ships. Pass `--force`
to bump past it.

## Publish mechanics

Waves exist because nothing in a later wave may start before the earlier wave's
packages resolve from the registry, or its smoke steps fail with
`ETARGET No matching version found`.

1. wave 1 — `relay-protocol`
2. wave 2 — `relay`, `channel-relay`
3. wave 3 — `core`, `channel-feishu`, `channel-discord`, `channel-yuanbao`

Tags are pushed one at a time even inside a wave: `relay` and `channel-relay`
are both heavy ubuntu jobs, and dispatching them together invites
`The job was not acquired by Runner of type hosted`. `publish` waits for each
tag's workflow to leave `queued`/`in_progress` before moving on.

Pushing a tag is the point of no return: it fires the npm workflow, and npm
refuses to republish a version.

npm can accept a publish asynchronously — the workflow logs
`Your package is being processed and may take a few minutes to become available`
and still exits 0 with `+ <pkg>@<version>`. Until that finishes, both the
packument and the version document return 404, and the dist-tag still points at
the previous release. A 404 in the first minutes after a green publish run is
propagation, not failure; re-check before touching tags.

The three views update at different times, measured on 0.14.12-beta.7: the
version document resolved ~3.5 min after the run went green, the packument
(`npm view <pkg> dist-tags`) still served the previous tag a minute later, and
the dedicated dist-tags endpoint — a separate cache — reported the new tag
immediately. `publish` therefore polls that endpoint after each wave's workflows
finish, with up to 24 attempts and 15-second retry delays. Each request, including
its response body, has a 10-second timeout. A six-minute deadline includes both
requests and delays; the final request or delay is shortened to fit. An
unconfirmed version stops the command with exit code 1 and prints the URL to
re-check; this does not mean npm rejected the publish.

```bash
curl -s https://registry.npmjs.org/-/package/@ganglion%2Fxacpx-relay/dist-tags
```

`publish` refuses to run when the modified paths include anything outside the
set this tool owns, so unrelated work in progress cannot be swept into the
release commit. That set includes each rmux-bridge platform manifest under
`platform-packages/` — `apply` rewrites all five from channel-relay's version —
but nothing else inside those directories, so an edit to a shipped binary,
checksum or README still stops a release. It also drops build-only churn in
`packages/relay-protocol/dist` when protocol is not part of the release — the
artifact gate rebuilds that file and bun's bundler sometimes renames a local,
producing a diff with no semantic content.

A wave is confirmed before the next one starts. `publish` polls that wave's
packages together — their publishes run in parallel, so serialising the polls
only adds up their propagation delays — and if any of them is still invisible it
stops *there*, printing the URLs to re-check and naming the waves it did not
push. Continuing would push a tag whose workflow installs a package that is not
on the registry yet, which is the `ETARGET` failure the waves exist to prevent.

Every publish job runs `npm test` before publishing — 488s measured — for a
commit the Test workflow already covers on its way to main.
`scripts/ci-test-gate.mjs` skips that duplicate only when the ubuntu `test` job
of a **push run on main** has already succeeded for **the commit the job has
checked out**. Both qualifiers are load-bearing. The commit comes from
`git rev-parse HEAD`, never `GITHUB_SHA`: a `workflow_dispatch` with `inputs.tag`
checks that tag out while `GITHUB_SHA` stays on the ref the dispatch started
from, so reading it would vouch for a commit other than the one being published.
The run has to be a push on main because a `pull_request` run tests the synthetic
merge commit. Red, cancelled, still running, missing or unreadable all mean "run
it here", which is what the job did before the gate existed — so a flaky Test run
can cost the eight minutes and can never block a release. The step is
`continue-on-error`, so even a tree too old to contain this script (re-dispatching
a tag from before it existed) produces no output and simply runs the suite.

The gate itself never waits for an in-flight run, because a publish job has
nothing else to do meanwhile. `publish` does, and that is where the duplicate is
removed: for a **multi-package** release it holds every tag until the release
commit's Test run concludes (20-second polls, 15-minute cap), so each publish job
finds the run already green and skips the suite. Measured on 0.24.10-beta.8, five
publish jobs spent 43 min re-running a suite the 12-minute Test run had just
covered; the hold replaces that with one wait.

A **single-package** release does not hold: one duplicate suite is 8.6 min
against a ~12 min run, so waiting would cost more than it saves. Red, missing,
timed out and unreadable all fall through to tagging, where the publish jobs run
the suite themselves — the behaviour that predates the hold — so a flaky Test run
can still cost the eight minutes and can never block a release. `--skip-gates`
skips the hold with the rest of the proof steps. The other Test jobs (macOS, E2E,
windows) are deliberately not consulted: they flake for their own reasons, and
re-running the ubuntu suite because of them would trade a flake for eight minutes
without proving anything new.

That stop is resumable by design. Tags are created only when their package is
about to be pushed, so waves that never started remain in the pending set.
Re-running `publish --yes` picks up those waves. A **clean tree is the marker for
that resume**: the bumps are already committed, so `publish` skips the commit and
refuses to tag if the gates left the tree altered. Before resuming a relay or
channel-relay release whose protocol tag already exists, it confirms that
protocol version on the registry again. An unconfirmed protocol stops the retry
before any new tag is pushed.

## Recovery

| Symptom | Action |
|---|---|
| A tag produced no workflow run | Re-push that one tag: `git push origin <tag>`. GitHub drops some multi-tag push events. |
| `git push` of a release tag fails | If the remote has no such tag (`ls-remote --exit-code` exits 2), `publish` deletes its local tag and exits, so the next run re-tags. If the remote already has it, recovery is `git push origin <tag>` (the row above). An `ls-remote` network or auth failure is neither outcome: the tag is kept and the run exits without polling the registry for that wave. Then check `git ls-remote --tags origin <tag>`: if it is absent, delete the local tag and re-run `publish --yes`; if it is present, `git push origin <tag>` and let its workflow run before continuing. |
| Smoke step fails with `ETARGET` | The previous wave is not on npm yet. Do not bump versions — re-run the failed jobs of the same tag. |
| `publish` stopped after a wave as unconfirmed | Not a failed publish: the workflows reported success and the registry is catching up. Re-check the printed URLs, then re-run `publish --yes` — it resumes at the untagged waves. |
| `npm test` fails on one unrelated timeout | Confirm locally on the release commit, then re-run the same tag. npm will not republish, so a new version would only add noise. |
| `E403 ... previously published versions` | That package already published. Verify with `npm view <pkg> dist-tags` and treat it as done. |
| `check` reports an rmux-bridge entry missing or versionless after `apply` | npm dropped the pin while the bridge version is unpublished. Re-derive both lockfiles from the manifests: `node ./scripts/release.mjs sync-lockfiles`. Never edit `package-lock.json` by hand. |
| A broken release commit, nothing published | Fix on main, `git tag -f`, force-push the tags. |
| A broken release commit, some packages published | Move only the still-failing package's tag. Re-pointing a published package's tag re-fires its workflow, which fails with `E403`. |

## Manual steps that remain

- **The CHANGELOG prose.** The draft picks its source per package: merged PR
  **titles** when `gh` is available and the PR touched a path that changed since
  that package's last tag, otherwise commit subjects. PR *bodies* are never
  used — they run to several paragraphs, and the file's convention is a one-line
  bullet per change. Either way it is a starting point: read it and rewrite what
  needs a human. `plan` prints which source it used, plus the tag and UTC commit
  time the window was bounded by and how many bullets that produced — so there is
  no reason to re-derive the window by hand, timezones included.
- **`--bump` across a stable boundary.** See the version policy table.
- **Deciding that a release is worth making.** `plan` reports changes; whether a
  three-line CSS tweak deserves its own `next` tag is a judgement call.

## Verification

`check` re-derives the invariants from the manifests and fails on drift:

- compat shim version and `@ganglion/xacpx` range match core
- each compatible plugin's `peerDependencies.xacpx` and `minXacpxVersion` match core
- each protocol consumer's range matches the protocol version
- every `rmux-bridge` optional pin has a matching installed package entry in
  `package-lock.json`; missing entries fail `npm ci` with `Missing:`, and
  versionless entries can crash it with `Invalid Version:`

```bash
node ./scripts/release.mjs check
```

It is not wired into CI. `apply` reconciles bridge entries from channel-relay's
manifest after `npm install --package-lock-only --ignore-scripts` and `bun install`.
When a bridge version has not been published yet, npm can omit its optional
entry or leave a versionless stub. Reconciliation restores `{ optional: true,
version: <manifest pin> }` in either case and keeps registry metadata on entries
whose versions already match. The npm generation options remain unchanged.

`publish` runs three gates before it commits:

1. `tsc --noEmit` — root `src/**/*.ts`, ~40s. The release commit is source, so
   this does not shrink with the release.
2. `check` — the invariants above, under a second.
3. Build every package this release ships, then `verify-publish.mjs --packages
   <those ids>`.

Gate 3 is scoped on purpose. A package outside the release set owns no changed
path — that is what put it outside the set — so its artifact is the one already
on npm, and rebuilding it spends minutes re-verifying bytes nobody is about to
publish. Measured for a relay-only release: **209s scoped against 446s
unscoped**, with relay itself still built and verified in full.

One thing the scope does *not* cover, because the release ships it without
publishing it: **a protocol release rewrites the protocol range in `relay`,
`relay-web` and `channel-relay`**, and a consumer's own build is only in the gate
when that consumer also ships. Two things make that a real hole — the relay
builds mark the protocol `--external`, so a removed or renamed export surfaces
when a consumer is compiled rather than when it is bundled; and the root `tsc
--noEmit` does not cover it, because its `include` lists `src` only. So a
protocol release additionally *compiles* every consumer it is not publishing
(13s + 17s + 117s, measured). A consumer that also ships is skipped: its build
compiles it, and relay's build compiles relay-web, which it bundles.

Scoping does not weaken what ships. The publish workflow runs the *unscoped*
`bun run verify:publish` before `npm publish`, so no artifact reaches npm on the
strength of a partial local gate; the local gate exists to move a failure in
front of the tag, and it now does that for exactly the packages at risk. A
release id with no entry in `RELEASE_ARTIFACTS` falls back to the unscoped gate,
because an artifact that cannot be described cannot be assumed unchanged.

`--skip-gates` exists only to recover from a tree already proven green.

## Host requirements (Linux, macOS, Windows)

The script is plain Node and runs unchanged on Linux, macOS and Windows. Three
things it must not assume about the host, all of which have broken a release:

**npm is not an executable named `npm` everywhere.** It is a shell script on
POSIX and `npm.cmd` on Windows. `execFileSync("npm", …)` therefore fails with
`ENOENT` on Windows (nothing by that bare name is on `PATH`) and `EINVAL` for
`npm.cmd` (Node refuses to spawn a `.cmd` without a shell), and `shell: true`
would concatenate the arguments unescaped. npm ships as JavaScript next to the
running `node`, so the tool spawns that entry with `process.execPath`: no `PATH`
lookup, no shell.

The entry's location depends on the installer, so every known layout is tried
and the error lists all of them:

| Installer | Entry |
|---|---|
| Windows installer, fnm, nvm-windows | `<dir>/node_modules/npm/bin/npm-cli.js` |
| nvm, fnm, Homebrew, distro packages | `<dir>/../lib/node_modules/npm/bin/npm-cli.js` |
| some global installs | `<dir>/../node_modules/npm/bin/npm-cli.js` |

`realpathSync` runs first, because nvm/fnm/Homebrew put a symlink shim on `PATH`
and `process.execPath` may name the shim rather than the install it points at.
Under `bun`, `process.execPath` names the bun binary — which ships no npm — so
the tool refuses to start rather than reporting a missing npm. Every `release:*`
npm script already uses `node`.

The same reasoning applies to the script's own `node` children: `apply` and the
gates spawn `process.execPath`, not a bare `node`, so a release launched by
absolute path does not depend on `node` being on `PATH`.

**Line endings are not LF on every checkout.** `CHANGELOG.md` and `bun.lock` are
committed with LF, but Windows checks them out with CRLF under the default
`core.autocrlf=true`. `spliceChangelog` normalises to LF before parsing, so the
header test and every section boundary hold either way, and it writes LF back —
the format the file is committed in. `bun.lock` needs no normalisation: its
block terminator is searched as `"\n    },"`, which a CRLF file still contains.

**`gh` has to be new enough.** `publish` reads workflow state through
`gh run list --json` / `gh run view --json`, which older releases (2.3.0 and
before, still shipped by some package managers) reject with
`unknown flag: --json`. The release itself still completes: the tag is pushed
and the registry is polled, but each tag's workflow is no longer awaited, so
waves can be reported unconfirmed while their runs are merely still going. Check
`gh --version` before releasing, or watch `gh run list` alongside.
