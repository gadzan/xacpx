# Bounded automatic collaboration evidence

Follow-up to #439. Keep the existing Router, SQLite audit, dispatcher and
execution capabilities; do not add a second scheduler or domain-specific roles.

## Problems

- Every generated assignment depends on every successful predecessor, replaying
  an increasing amount of public output on every turn.
- A verifier that repeatedly exceeds the Router's evidence budget can consume
  the entire Run budget while attempting to summarize the same artifact.

## Design

1. Generated assignments automatically depend on the latest successful production
   batch, latest successful analysis batch, latest successful verification batch
   and latest successful settled batch (deduplicated). Keep all successful siblings
   in a selected batch; a failed new attempt cannot hide the previous artifact.
   Unknown/legacy/handoff actions count as production. This is an input frontier,
   not a declaration that older findings are resolved.
2. Add `group_read_result` beside `group_send`. A live execution capability can
   list settled assignment metadata or page through an exact completed public
   result in its own Run. No caller-supplied Run, Topic, sender or session IDs;
   reject stale bindings, cancellation, foreign evidence and private messages.
   Pages have explicit continuation offsets and immutable message identities.
3. For bundled automatic assignments only, inline dependency previews are
   bounded to 4,000 characters each and 16,000 characters total. Mark omissions
   with assignment IDs and instruct members to read all necessary pages before
   approving. Do not change custom router or explicit/handoff prompt semantics.
   Baseline pre-request transcript handling remains unchanged.
   Enforced read-only launches keep full selected dependencies inline, since
   their runtime deliberately exposes no MCP tools. Missing evidence is a blocker.
4. Keep the complete durable audit and existing newest-first Router budget.
   Router truncation never becomes approval evidence. Two oversized/empty successful
   verification batches of an unchanged production version cause a deterministic
   `need-human` pause unless a later compact report already recovered it. Original
   durable result lengths survive budgeting: old compact reports clipped by the
   shared history budget do not count as failed recovery attempts or lose their
   ability to reset the retry counter. Size alone never authorizes completion.
   Analyses and member changes do not reset this limit; new production does.
   This bounds repeated evidence recovery without replaying production effects.
5. Summaries must retain versions, unresolved findings and blockers. Older
   findings remain discoverable through the result catalog; no prose heuristic
   marks them resolved. Jev continues to assess goal coverage, and a verifier
   must report missing access as a blocker.

## Plan and checks

- [x] Implement durable recovery limit and focused dependency selection.
- [x] Wire paginated public-result reads through existing MCP/IPC composition.
- [x] Bound only bundled automatic dependency previews.
- [x] Cover long histories, parallel siblings, retained feedback, repeated
  oversized verification across fresh routing calls, successful recovery and
  new production reset.
- [x] Exercise real SQLite/dispatcher result paging, tail findings, stale tokens,
  forged identities and cross-Run isolation; verify MCP and IPC schemas.
- [x] Run targeted Conversation/MCP/IPC suites, typecheck and build; open PR.

Real Jev model quality and external-channel end-to-end acceptance remain separate
from deterministic policy/runtime tests. This change cannot prove that a model
interpreted every finding correctly or force it to use its read capability.

## Validation

- Core Conversation/MCP suites: 417 tests passed across 10 files. Covers
  long histories, bounded parallel previews, paged tail findings, independent
  verification, durable early pause and existing cross-Run scheduling.
- Runtime composition/policy/permission/SQLite suites: 250 tests passed across
  6 files (some coverage overlaps the core run).
- IPC client/server: 45 tests passed; two pre-existing Windows failures were
  filtered after reproduction with unmodified main-branch test files: socket
  chmod reporting expects a Unix endpoint, and the non-responsive socket test
  hangs while closing on Windows. The initial unfiltered run failed those same
  two tests. No unrelated platform-test changes are included.
- TypeScript no-emit check and acpx import boundary lint passed.
- Full CLI/bridge/Router build passed.
- No real Jev/external-channel end-to-end run was performed.
