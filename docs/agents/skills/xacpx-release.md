---
name: xacpx-release
description: Release packages in the xacpx monorepo — version bumps, derived metadata, lockfiles, CHANGELOG, tags, GitHub releases and CI-triggered npm publish. Use when asked to publish, release, ship, bump a version, cut a tag, or create a release; scripts/release.mjs does the work, this skill routes you to it.
---

# xacpx Monorepo Release

Release is a script. Run it; never hand-edit a version, a derived field, or a
lockfile — one release writes the same version into ~14 files, and a miss is
green locally, failing only at tag-push time.

```bash
node ./scripts/release.mjs plan            # read-only: what changed, what ships, which version, CHANGELOG draft
node ./scripts/release.mjs notes           # raw material for the prose: merged PR bodies, bounded to the same window
node ./scripts/release.mjs apply --yes     # writes versions + derived metadata + lockfiles + CHANGELOG skeleton
node ./scripts/release.mjs publish --yes   # gates, commit, one tag at a time, waits for each workflow
node ./scripts/release.mjs check           # re-derives the metadata invariants; reports drift, changes nothing
```

`plan`, `apply` and `publish` without `--yes` are dry runs that print what they
would do.

Flags: `--beta` (default) / `--stable`, `--bump patch|minor|major`,
`--new-cycle`, `--force`, `--skip-gates`, `--json`. `--bump` is read only from a
**stable** manifest — a beta line just increments its counter, so a beta release
needs no flag at all. The full policy table lives in
`docs/release-automation.md`.

## The parts that stay with you

- **The CHANGELOG prose.** `plan` drafts it from merged PR titles (commit
  subjects when `gh` is unavailable), grouped into the file's own
  `### Added`/`### Changed`/`### Fixed` sections with type prefixes stripped;
  it says which source it used. `notes` prints the PR bodies for the same
  window. Read both, then rewrite in the file's voice — one bullet per
  user-visible change, naming real components.
- **`--bump` across a stable boundary.** Never inferred from the diff.
- **Whether the release is worth making at all.** `plan` reports changes; that a
  change deserves its own tag is your call.

## What `publish` refuses

Every one of these is a check with a message that names the fix. Read it; do not
work around it.

- `--yes` missing, or the branch is not `main`.
- The checkout is behind `origin/main` — a release reads the working tree, so
  pull first.
- A tag already exists for a package in the plan.
- **Unrelated modified paths**: anything outside the set a release owns
  (manifests, `package-lock.json`, `bun.lock`, `CHANGELOG.md`, the core floor
  trackers, the metadata tests, `packages/relay-protocol/dist`). A half-finished
  edit never rides into a release commit.
- **An already-pushed tag in this batch whose version is not on npm** (resume
  only). A tag is created before its workflow runs, so the remaining waves must
  not ship against a version that is not on npm. The message names the tag and
  the version, and one shared helper picks the repair line from that tag's
  workflow run. An unreadable `gh run list` gets a line saying the workflow
  state could not be read and asking for `gh run list`. A tag with no run gets
  `git push origin <tag>`. A concluded failure gets `gh run rerun <run-id>
  --failed`. A queued or in-progress run gets `gh run view <run-id> --watch`
  and a later `publish --yes`. A successful run gets a propagation line that
  asks for a dist-tags re-check. Any other terminal conclusion gets a full
  `gh run rerun <run-id>` and names that conclusion. A failed tag workflow
  prints the run URL and failed jobs only when `gh run view` answers, and its
  repair line comes from the same helper. `plan` shows the same state in a
  `resume state` section.

**A clean tree is not a refusal — it is the resume path.** When the bump is
already committed, `publish` says so and picks up at the tags, so a release that
stopped mid-flight is finished by re-running `publish --yes` unchanged. A tag is
created per package immediately before its push, and a push that fails with the
tag absent on the remote is rolled back — waves that never started stay pending.
Before resuming a relay or channel-relay release whose protocol tag already
exists, it re-confirms that protocol version on the registry.

`apply` refuses when a manifest already carries a bump with no tag (a previous
`apply` was never published, and applying again would burn a version nobody
ships); `--force` bumps past it.

## Manual cases

**A tag that has to move, or be dropped.** Moving a tag re-fires its workflow;
for a package already on the registry that run fails with
`E403 ... previously published versions`, so move only tags that never
published.

```bash
git tag -f vX.Y.Z && git push --force origin vX.Y.Z
git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z   # drop it outright instead
gh release delete vX.Y.Z --yes          # add --cleanup-tag to drop the tag too
```

Anything beyond this — a broken release commit with some packages already
published, a wave that failed on `ETARGET` — has a row in the recovery table in
`docs/release-automation.md`. Read it before improvising.

## Reference

`docs/release-automation.md` — version policy, which packages ship and why,
publish waves, the recovery table. `AGENTS.md` (Gotchas) carries the hard rule
about generated versions and their derived metadata.
