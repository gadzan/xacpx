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

### Round 2 (delta) at c50a6c47, and the docs-only head

Three delta lanes ran at `c50a6c47`:
- `DeltaGates`: PASS. tsc clean, vitest 213 files / 2989 tests, playwright 187
  passed / 0 failed / 51 skipped; CI's macOS job reports the same pass/skip totals.
- `DeltaReview`: PASS on all seven fixes, with the dialog-shell hygiene proven by
  running that spec with the env unset and seeing `git status` stay empty.
- `DeltaProse`: ISSUES, docs only: the handoff and the wp13 measurement still
  quoted 2977, the handoff's head line implied the fix commit carried no code
  changes, the manifest's `unit_final.head` was prose, and one "已知失败" bullet
  was duplicated. Fixed in `343988bf`; `git diff c50a6c47..343988bf -- packages`
  is empty.

Standing at the docs-only head: CI green required, then the operator's visual
acceptance, then the squash merge with `--match-head-commit`. No merge has run.

### Trunk #588 merge and the fork-button fix, head 84cede67

Trunk moved to `eeac4e63` (#588, portable session fork at a recorded turn
node) while CI watched the docs-only head. Merged as `d933e9a4`
(no conflicts); an intersection review found one real defect: the new
`msg-fork-node` button in `MessageList.vue` was a bare 12px icon with no
WP-4 coarse-pointer sizing. Fixed in `84cede67` (CopyButton's h-11/w-11
grid-centering recipe, row hover pad, icon 12 -> 14). Gates: tsc clean +
vitest 214 files / 2997 tests at the merged head, tsc clean after the fix,
messagelist.test.ts 86/86. The 390x844 timeline touch loops were left alone:
they exercise the group surface, which never renders this button, so adding
the id there would fail, not cover. Structural parity with the gated
CopyButton recipe is the guarantee. Standing at `84cede67`: CI green
required, then the operator's visual acceptance, then the squash merge with
`--match-head-commit`. No merge has run.

### Third review round (6 findings), code + design

- Doc: the 1451-line Model Discovery V2 design doc rode in with WP-7's commit.
  Removed from this branch; filed separately (branch + PR, path per the doc's
  own header: `docs/superpowers/specs/2026-11-10-model-discovery-v2-design.md`).
- Evidence: `dialog-shell.spec.ts` double-appended the viewport
  (`after/m390/m390/20-dialog-nested-light.png` etc.); fixed to shoot only the
  loop turn matching `UI_SHOTS_DIR`. Nested dirs + `tests/*.log` deleted
  (7.6M -> ~5.5M). At merge, `before/`+`after/` PNGs are dropped; text evidence
  stays. Decision recorded in HANDOFF.
- `ComposerConfirmDialog` gains `level="top"` (restores pre-shell z-70; the
  default z-50 sits level with the run-detail drawer).
- `.glass-1`/`.glass-2` (zero callers) and `--glass-hover` (zero refs) deleted;
  WP-9 marked partial in HANDOFF. The shared-selector cut briefly took
  `.glass-control`'s blur with it; restored and re-verified (tsc + shots).
- 06 (group mobile): meta row indented to the bubble edge (`ml-11`, `lg:ml-11`
  where the avatar is desktop-only), process entry `BotAvatar` 16 -> `ListTree`
  14, speaker button `justify-center` -> start (44px touch box kept). Real-DOM
  probe: meta x16 vs bubble x60 (off by exactly the avatar column), glyph x71.
- 08 (settings mobile): retention value shortened (`retentionShort`), both
  explanations moved behind an info button (`Tooltip`, tap-to-show on touch);
  notification row back to one line. New keys `retentionShort`/`moreInfo` in
  en + zh-CN; three unit tests updated to the tooltip props.
- 06/08 re-shot (m390 light+dark) plus the two `20-dialog-nested` shots at the
  correct paths; verified by eye. iPhone glass check on 03/06: no iPhone here,
  left to the designer.
