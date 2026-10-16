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

## Version policy

**While a base version is unreleased, a new beta increments the counter.**
`0.24.10-beta.3` → `0.24.10-beta.4`. It does not move the base and reset to
`-beta.0`; that claims a version nobody shipped and burns a number per beta.
`--bump minor|major` with `newCycle` is the escape hatch for deliberately
starting a new base.

| Current | `--beta` | `--stable` |
|---|---|---|
| `X.Y.Z-beta.N` (base unreleased) | `X.Y.Z-beta.(N+1)` | `X.Y.Z` |
| `X.Y.Z-beta.N` (base already tagged) | refuses — reconcile the manifest | `X.Y.Z` |
| `X.Y.Z` | `bump(Z)-beta.0` | `bump(Z)` |

"Base already tagged" is read from git tags (`<prefix>X.Y.Z`), not the registry,
so the policy is deterministic and offline-testable. A tag existing is not proof
the npm publish succeeded, but the two diverge only when a release failed
mid-flight, which is exactly the case that deserves a human.

Automatic *base* bumps use `--bump patch` by default. `plan` prints the level it
used; a feature release across a stable boundary should pass `--bump minor`
explicitly.

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

`publish` refuses to run when the modified paths include anything outside the
set this tool owns, so unrelated work in progress cannot be swept into the
release commit. It also drops build-only churn in `packages/relay-protocol/dist`
when protocol is not part of the release — `verify:publish` rebuilds that file
and bun's bundler sometimes renames a local, producing a diff with no semantic
content.

## Recovery

| Symptom | Action |
|---|---|
| A tag produced no workflow run | Re-push that one tag: `git push origin <tag>`. GitHub drops some multi-tag push events. |
| Smoke step fails with `ETARGET` | The previous wave is not on npm yet. Do not bump versions — re-run the failed jobs of the same tag. |
| `npm test` fails on one unrelated timeout | Confirm locally on the release commit, then re-run the same tag. npm will not republish, so a new version would only add noise. |
| `E403 ... previously published versions` | That package already published. Verify with `npm view <pkg> dist-tags` and treat it as done. |
| A broken release commit, nothing published | Fix on main, `git tag -f`, force-push the tags. |
| A broken release commit, some packages published | Move only the still-failing package's tag. Re-pointing a published package's tag re-fires its workflow, which fails with `E403`. |

## Manual steps that remain

- **The CHANGELOG prose.** `apply` drafts one bullet per commit subject under a
  heading per package. That is a starting point, not a finished entry — read it
  and rewrite the parts that need a human. An `## [Unreleased]` section as the
  first section is honoured instead (relabelled, prose kept), so a cycle that
  wrote its own notes keeps them. Older `## [Unreleased]` headings elsewhere in
  the file are left alone.
- **`--bump` across a stable boundary.** The tool cannot tell a feature from a
  fix, so it defaults to `patch`.
- **Deciding that a release is worth making.** `plan` reports changes; whether a
  three-line CSS tweak deserves its own `next` tag is a judgement call.

## Verification

`check` is the CI-able guard against the drift this tool exists to prevent:

- compat shim version and `@ganglion/xacpx` range match core
- each compatible plugin's `peerDependencies.xacpx` and `minXacpxVersion` match core
- each protocol consumer's range matches the protocol version
- no version-less `rmux-bridge` stub in `package-lock.json` (that shape crashes
  `npm ci` with `Invalid Version:` once the platform packages exist on the registry)

```bash
node ./scripts/release.mjs check
```

`publish` runs `check`, `tsc --noEmit`, and `bun run verify:publish` before it
commits. Pass `--skip-gates` only to recover from a tree already proven green.
