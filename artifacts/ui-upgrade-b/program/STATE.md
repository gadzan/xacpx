# autopilot-full program state

Standing objective (operator go, 2026-11-16): take the scheme B relay-web UI
upgrade from its verified local branch to a merged PR on `main`, with one owner
carrying the lifecycle and the root keeping every verdict.

Completion criteria
- One PR from `ui-upgrade-b` into `main`, squash-merged with `--match-head-commit`
  set to the exact SHA that passed both gates below.
- Clean root verdict at that published head: gate re-run, live-surface proof, two
  diff-audit lanes, plan compliance against `docs/design/upgrade-plan.md`.
- CI (`test.yml`) green at that same head.
- Visual acceptance signed off by the operator through Gadzan.
- No merge before all four are true. A new head voids the verdict and the signoff
  applies to the PR, not to a SHA, so re-check the head after any push.

Queue
| item | branch | base | code head | owner | state |
| --- | --- | --- | --- | --- | --- |
| scheme B UI upgrade (WP-1..18) | `ui-upgrade-b` | `main` @ `5b89cab` lineage | `478929a4` (evidence `90cee28e`) | one owner subagent | authorized to publish; merge after acceptance |

Forge
`gh`, resolved once. `command -v origin` fails, so the `origin pr …` path is
unavailable and this fallback is recorded. Repo `gadzan/xacpx`, default branch
`main`, squash merge allowed, CI gate `.github/workflows/test.yml`.

Gates
1. Root verdict, aggregated from independent verifier lanes at the published head.
2. CI green at that head.
3. Operator's visual acceptance.
4. Merge is an irreversible write to a shared branch, so it happens only after 1
   to 3, with the current-head guard.

Countersigns
None anticipated. A raise of a CI-pinned gate or budget value would need a fresh
countersign with verifier proof; this change touches no CI config.

Audit ticks
Root audit over the owner every ~30 minutes while the PR is open. The owner posts
its head SHA and CI state at each tick.

Stand-down
Any operator hold reaches the owner as a zero-writes order immediately. The owner
pauses until released.

Evidence
Local pack and handoff live in `artifacts/ui-upgrade-b/` (`HANDOFF.md`,
`manifest.json`, `decision-log.tsv`, `measurements/`, `after/`, `before/`).
