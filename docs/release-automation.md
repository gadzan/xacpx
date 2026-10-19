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
release commit. It also drops build-only churn in `packages/relay-protocol/dist`
when protocol is not part of the release — the artifact gate rebuilds that file
and bun's bundler sometimes renames a local, producing a diff with no semantic
content.

A wave is confirmed before the next one starts. `publish` polls that wave's
packages together — their publishes run in parallel, so serialising the polls
only adds up their propagation delays — and if any of them is still invisible it
stops *there*, printing the URLs to re-check and naming the waves it did not
push. Continuing would push a tag whose workflow installs a package that is not
on the registry yet, which is the `ETARGET` failure the waves exist to prevent.

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
| `git push` of a release tag fails | If the remote has no such tag (`ls-remote --exit-code` exits 2), `publish` deletes its local tag and exits, so the next run re-tags. If the remote already has it, recovery is `git push origin <tag>` (the row above). An `ls-remote` network or auth failure is neither outcome: the tag is kept and the run exits, asking for `git ls-remote --tags origin <tag>` before re-running. |
| Smoke step fails with `ETARGET` | The previous wave is not on npm yet. Do not bump versions — re-run the failed jobs of the same tag. |
| `publish` stopped after a wave as unconfirmed | Not a failed publish: the workflows reported success and the registry is catching up. Re-check the printed URLs, then re-run `publish --yes` — it resumes at the untagged waves. |
| `npm test` fails on one unrelated timeout | Confirm locally on the release commit, then re-run the same tag. npm will not republish, so a new version would only add noise. |
| `E403 ... previously published versions` | That package already published. Verify with `npm view <pkg> dist-tags` and treat it as done. |
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
- no version-less `rmux-bridge` stub in `package-lock.json` (that shape crashes
  `npm ci` with `Invalid Version:` once the platform packages exist on the registry)

```bash
node ./scripts/release.mjs check
```

It is not wired into CI. All of this metadata is derived by `apply`, so drift can
only be introduced by a hand edit; if nobody hand-edits it, `check` never fires.
Wiring it into `test.yml` would catch such an edit on the PR instead of at
tag-push time, at the cost of one narrow false positive: a PR that regenerates
`package-lock.json` while the bridge pins point at an unpublished version gets
version-less stubs, which is exactly what `check` reports (and what `apply`
pins). That is a deliberate call for the operator, not a default.

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
