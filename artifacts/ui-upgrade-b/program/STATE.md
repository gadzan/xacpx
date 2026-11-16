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

## Round 1 (2026-11-16, head 787fd4b1)

PR https://github.com/gadzan/xacpx/pull/590, non-draft, base `main`.
- Owner `PrOwner`: pushed the branch, opened the PR, then held for the merged head.
- Trunk drift: `cf1f0a10` (#585, raw bot id in @ rows) and `f45f76d6` (#586,
  session fork). `GroupComposer.vue` conflicted semantically; resolved by keeping
  the shared `CompletionList` rows and dropping the bot-id chip, so #585's added
  test passes on the merged tree. Merge commit `616e2ef8`.
- Evidence follow-up `787fd4b1`: replaced the junk `13-completions.png` (it showed
  a harness error banner) with per-viewport captures from
  `e2e/group-completions.spec.ts`, and recorded the merged-head unit result.
- Gates at `787fd4b1` before the round started: typecheck clean,
  `bunx vitest run` 213 files / 2977 passed.
- Verifier lanes at `787fd4b1`: gates, live-surface, diff-correctness,
  plan-compliance, slop-comments. One aggregated verdict expected.

### Round 1 verdict and its fix pass

Verdict: ISSUES from all five lanes. The findings converged on seven defects,
each fixed in one follow-up commit:

1. The process entry sat on its own line as an unlabelled 16px avatar (WP-12's DoD
   says the timestamp row). Moved into `ConversationMeta`'s default slot.
2. The selected member's failure printed three times in the drawer. The body line
   now appears only when the trace suppresses its own copy (historical attempt or
   a raw kernel code); the list row keeps its summary.
3. `e2e/dialog-shell.spec.ts` wrote two tracked pack files on every plain run.
   Gated on `UI_SHOTS_DIR`, like the other writers.
4. `tooltip.test.ts` lost the placement suite in the merge while `Tooltip.vue`
   stayed byte-identical. Restored from `origin/main`; unit 213 / 2989.
5. Dead `menu` radius token plus a comment claiming an adoption that never
   happened. Token deleted, comment rewritten.
6. WP-13's exception list omitted `BotAvatarQuickView`, `FueCallout` and
   `MermaidViewer`; the first also bypassed the ladder (`z-[60]`, `bg-black/60`).
   Listed, and moved onto `z-dialog-nested` / `bg-scrim`.
7. HANDOFF and manifest quoted the pre-merge head and counts. Refreshed.

Docs prose also lost every `WP-N` comment label and the restated prop docs.
