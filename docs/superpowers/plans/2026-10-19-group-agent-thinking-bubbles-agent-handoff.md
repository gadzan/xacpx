# Implementation Agent Handoff — Group Thinking Bubbles

Status: Agent instructions for the existing DRAFT feature PR
Branch: feat/group-agent-thinking-bubbles
Scope: Code implementation, tests, and docs completion on this same PR

## Copy/paste prompt

You are the implementation agent for the existing xacpx feature PR:
"feat(relay-web): replace group run cards with per-agent thinking bubbles".

Work in repository gadzan/xacpx on **feat/group-agent-thinking-bubbles**.
Do **not** create another PR or a second feature branch, and do not merge the PR.

First read and treat these as binding:
1. docs/superpowers/specs/2026-10-19-group-agent-thinking-bubbles-design.md
2. docs/superpowers/plans/2026-10-19-group-agent-thinking-bubbles-implementation.md
3. docs/superpowers/plans/2026-10-14-group-agent-communication-entry.md
4. docs/superpowers/specs/2026-10-18-general-automatic-collaboration-design.md
5. Relevant source files and nearby tests identified in the implementation plan.

## Task

Deliver the complete feature described by the spec, including Core durable public MemberTurn trace storage, safe attempt/sourceTurn fencing, shared public tool normalization, validated historical batch+trace RPC, per-MemberTurn live/history projection, existing-avatar thinking bubbles, anchored read-only/detail/control popovers, migration, tests, and documentation.

The initial commits in this PR are **design and implementation instructions only**, not the finished feature. The PR title and description intentionally describe the final intended functionality. Do not rewrite the PR as "add docs" or mark checklists done before code/evidence exists.

### Required order

A. Inspect the current branch and code. Write down invariants and the shortest safe integration points; identify product-surface regressions before editing.

B. Implement attempt-safe correlation, sanitized tool normalization and Core durable trace recorder first. A trace must survive daemon restart; missing events must be marked incomplete. Never persist new private/raw tool data. Keep all old run and cancellation semantics.

C. Implement scoped read-only batch details and paged trace RPC via the existing Control → channel-relay → Relay Protocol path. Preserve existing protocol and clients. Tests must deny private peer/wrong scope and late stale attempts.

D. Refactor Group store projection so history uses Run.requestMessageId and exact MemberTurn/source identity independent of activeRun. Render canonical reply once, even during temporary-row promotion, and keep Handoff entries in original seq position.

E. Implement thought bubble UI and anchored popover. Each MemberTurn owns its own Agent avatar, bubble and detail; status and Stop/waiting/errors/Plan move into details. Existing Direct/session views and Group Handoff behavior remain untouched.

F. Test actual SQLite migration, restart/reload/Topic switch, multi-agent same Bot different batches, automatic no-member routing, ambiguity fail-closed, Stop exactness, scroll anchoring, desktop/mobile popover and accessibility. Run the listed build/test commands and all relevant regressions; if a test cannot run, say why and do not claim it passed.

G. Update the existing feature PR description with what was actually implemented, evidence, commands/results and remaining risks; leave as Draft until all acceptance criteria are met. Do not rename it to a documentation PR or silently remove incomplete acceptance items.

### Hard constraints

- One bubble **per MemberTurn**, not one per Run and not one per Bot ID.
- User-requesting human message and historical Bot message must stay at durable transcript ordering.
- Stop cancels the **whole exact active Run** (existing API) and is only shown in details.
- Never replace an unknown Bot or unmatched reply with a guessed owner.
- Complete post-refresh history comes from the Core SQLite authoritative store; browser memory alone is not a solution.
- Persist only the public displayable trace already present in existing Group process UI; keep private peer and sensitive tool internals out.
- Follow fail-closed semantics for stale events, unknown send/cancel outcomes and interrupted traces.
- No broad rewrite, unnecessary new scheduling framework, backward-incompatible RPC mutation, fake passing assertions or cosmetic-only completion.

### Working method

For each phase:
1. Make a small focused set of code changes.
2. Add focused regression tests **before moving to the next phase**.
3. Run targeted checks; fix real defects, do not water down assertions.
4. Commit to this branch with a descriptive functional commit message.
5. Update the PR as implementation progresses.

At handoff/completion, provide:
- commit hashes and file changes;
- tests executed and their actual results;
- before/after screenshot or reliable E2E observation of the Group interface;
- a replay proof for a single member containing reasoning, a tool step and a final answer across real daemon restart;
- residual limitations (especially older unrecorded traces and interrupted recordings);
- explicit verdict against every exit checklist item in the plan.

Stop and flag a blocking **product contradiction**, if one truly emerges despite the frozen decisions. For a normal engineering tradeoff, use the simplest correct implementation and document the choice. Never ask the user to re-confirm the eight UX decisions already fixed by the spec.

## Definition of done

The PR delivers Group transcript UX, durable Group member tracing and test evidence in the **same branch**. A documentation-only diff is not deliverable. Preserve existing conversation/run/permission authority, and do not merge without user direction.
