# General automatic collaboration

Tracking: GitHub issue #438. Implementation entry: `src/conversations/collaboration-policy.ts`.

## Problem and scope

The bundled Jev policy selects one member and completes after any member result.
The engine already supplies durable assignment outcomes, results, dependencies,
budget and generation fences, but the bundled CLI discards the results. A short
human request therefore does not produce an adaptive collaboration loop.

Replace that policy with a domain-neutral, result-driven loop. Do not hardcode
engineering job titles, require every member to speak, or interpret natural
language phrases such as "done" as execution or approval evidence. Code changes,
research, writing and planning all use the same actions and durable executor.

## Decision model

Each routing pass reconstructs progress from the Run's bounded durable assignment
records, including result, outcome, attempt, batch and truncation flags. Jev keeps
its existing finite-choice HTTP contract. It first chooses an admissible action,
then a suitable enabled member for an action that needs execution. There are at
most two Jev calls per pass, within the existing router deadline.

Actions:

| Action | Purpose |
| --- | --- |
| answer | Directly answer a self-contained question that needs no produced artifact |
| analyze | Investigate requirements, decompose work, identify the next deliverable |
| execute | Produce the next concrete unfinished deliverable |
| verify | Independently examine the latest deliverable and its evidence |
| revise | Address specific findings, preserving completed work |
| complete | All requested outcomes are satisfied by the available evidence |
| need-human | Required facts, authority or a trustworthy next decision are unavailable |

The first pass cannot complete without member output. After production work,
completion is unavailable until a successful verification of the latest work.
Verification is independent of the producer whenever another enabled member
exists; a single-member group may explicitly self-check. A later execute/revise
invalidates the previous verification. A successful direct answer may complete
without a ceremonial review. These are product policy constraints, not proof
that any member's substantive conclusions are correct.

Jev receives the request, bounded public context, member roles, and durable result
history. Its structured action choice evaluates whether verification actually
supports completion or requires revision, further work or human clarification.
It cannot approve an unknown/failed execution just because text claims success.
Unrecognized legacy or public-handoff work is treated conservatively as production
work requiring verification; no decision depends on hidden session memory.

## Assignments and evidence

Each new assignment gets a deterministic unused `jev-v2-<ordinal>-<action>` id,
an action-specific task, expected output, and dependencies on successful prior
assignments of this Run. Existing sequential-mode dependency delivery carries exact
public results into the next member prompt. The original request is always a
trigger. Task composition reserves space for instructions before bounding the
request, so long requests cannot truncate the verification requirements.

Member selection uses the action and previous results as well as public roles;
names do not grant permissions or imply filesystem read-only proof. Verify tasks
must identify the artifact/revision they inspected, findings, checks and blockers.
Members must report inaccessible artifacts (including isolated worktrees) rather
than certify work they could not inspect. No implicit integration or publication
is introduced. Member results remain untrusted evidence for the routing model.

The Router is the automatic progression owner. Existing explicit `group_send`
remains valid and its durable results are included; the new policy does not ask
members to create a second scheduling workflow or rely on their doing so.

## Failure, bounds and recovery

- Empty requests and no enabled members ask for human input rather than claim
  that work finished. Engine budget exhaustion stays `failed/budget-exhausted`.
- On the first pass only, a failed, malformed or low-confidence Jev action
  choice may fall back to an analysis by the enabled lead (or first enabled
  member). Once work exists, uncertainty pauses as `waiting-human`; it cannot
  manufacture approval, silently repeat writes or consume the whole budget on
  fallback analysis.
- Member-selection ambiguity alone does not require human personnel decisions.
  A confidently chosen action uses the eligible lead, else first eligible member,
  on a failed/unknown/low-confidence member pick. Verification candidates still
  exclude producers, including the lead, before applying this fallback.
- Indeterminate/cancelled evidence cannot cause new work. Existing engine seals,
  cancellation, membership checks and generation fencing remain authoritative.
- Repeated identical completed results from the same member/action pause for
  human input; productive successive analyses remain valid. The durable turn budget bounds all other refinement
  loops. No additional in-memory scheduling state is authoritative.
- Calls retain the existing secret redaction, timeout and capability restriction.
  The no-key legacy fan-out and custom routers retain their existing contracts.

## Implementation plan

1. Document the contract here and in conversation/config/Web module docs.
2. Add a pure collaboration policy alongside the bundled router; retain full
   validated durable history across the CLI boundary and reuse the Jev client.
3. Cover action transitions, member selection, independent verification,
   refinement invalidation, failures, bounds, legacy/handoff results and malformed
   input with deterministic tests and loopback HTTP.
4. Exercise the policy through the real Conversation Router engine and SQLite,
   including continued execution, recovery, cancellation and budget boundaries.
5. Run typecheck, relevant subsystem tests and builds; review the final diff and
   create a PR containing design, implementation and verification evidence.

## Acceptance

- A short artifact request can progress analyze → execute → verify → revise →
  verify → complete without the human describing a personnel workflow.
- Research/writing requests use the same transitions with arbitrary member names;
  a simple factual question can answer → complete.
- Changing a result/outcome changes the admissible next decisions; removing a
  reviewer or losing Jev does not turn unfinished work into success.
- Reconstructing a policy from the same durable snapshot yields the same valid
  assignment identity; a new step cannot collide with previous assignments.
- Waiting-human, failed, cancelled and indeterminate outcomes remain honest and
  visible through existing public Run projections.

Live Jev quality and provider-side artifact access require live acceptance beyond
deterministic/loopback tests. Tests establish orchestration behavior, not model
judgment quality or an independent security boundary around member text.

## Verification record (2026-10-18)

### Review follow-up plan

Implemented in the follow-up commit on PR #439; 261 focused tests pass, including
real-engine long-history completion and exact evidence recovery. The root
TypeScript check passes. The original implementation record below remains for
comparison; expanded Windows regression limitations still apply.

1. Allocate the 32,000-character result budget by descending batch recency while
   preserving the caller's history order. A long earlier history must not starve
   the latest verification; per-result limits and truncation flags remain strict.
2. Offer another verification when a completed batch has incomplete/truncated
   result evidence. Give that member exact durable dependencies and explicit
   instructions to inspect the full evidence, preserve findings and return a
   concise complete verification. A truncated verification cannot reset producer
   independence or directly authorize completion.
3. Scope repeated verification/analysis text to the current production frontier.
   Identical checks on distinct execute/revise outputs are valid. Consecutive
   identical execution results and repeated checks without intervening production
   still stop as no progress. Do not compare parallel siblings as repeated rounds.
4. Defensively refuse the no-key legacy path when Jev assignments already exist.
   Production credential gating remains authoritative and is tested separately.
5. Regress long histories, oversized evidence recovery, repeated PASS on distinct
   artifacts, real loops and key-loss entry points; rerun focused suites, typecheck
   and build, then update PR #439. Keep full-history execution dependencies as-is;
   optimizing that frontier is a separate change that must preserve required proof.

- Initial implementation: 250 tests pass across default-router, Conversation Router engine, production
  router subprocess, Jev client, SQLite store and Topic lifecycle suites. This
  includes domain-neutral transitions, independent verification, revision,
  cancellation, exact dependency results, process reconstruction and loopback
  HTTP. Member ambiguity retains a confident action without asking the human
  to pick personnel.
- Root TypeScript checking and the CLI/runtime build pass. No real-provider or
  real-WeChat smoke is claimed; live Jev judgment remains a live acceptance item.
- Expanded Conversation checks hit the existing Windows worktree file's 180s
  runner limit. Its completed cases passed before the extended run was stopped;
  that entire file was not verified. The separate Jev settings mode-0600 test
  fails on Windows with mode 0666, reproduced using the unchanged main-branch
  test and implementation. These are reported separately from the focused passes.
