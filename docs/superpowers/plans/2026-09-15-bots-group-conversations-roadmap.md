# xacpx Bots & Group Conversations — Roadmap

> **Status:** Proposed, revised after architecture review  
> **Date:** 2026-09-15  
> **Companion spec:** `docs/superpowers/specs/2026-09-15-bots-group-conversations-design.md`

---

# 1. Purpose

This roadmap turns the Bots & Group Conversations design into an incremental delivery sequence while preserving xacpx's existing session, permission, Agent Messaging and Orchestration guarantees.

The updated guiding rule is:

> Build identity first, then durable request lifecycle, then explicit collaboration, and only then automatic coordination.

Do not make Relay Web, a hidden Router implementation or Group UI establish semantics that the durable domain does not already own.

The delivery order must prove five boundaries before automatic collaboration ships:

1. Bot identity is independent from `LogicalSession`.
2. Direct Conversation history and lifecycle are durable.
3. One user request has a first-class `ConversationRun` identity.
4. Topic execution target/filesystem policy is explicit.
5. Explicit member routing is complete without a model choosing recipients.

---

# 2. Target end state

The finished product exposes four distinct collaboration surfaces:

```text
1. Ordinary Session
   human ↔ one logical xacpx session

2. Bot Conversation
   human ↔ reusable Bot identity
   durable history + Runs

3. Group Conversation
   human + reusable Bots
   Topics + Runs + explicit/automatic target selection

4. Existing internal collaboration
   Agent Messaging + Task Orchestration
```

Execution remains shared:

```text
Conversation / Topic / Run
          │
          ▼
MemberTurn
          │
          ▼
BotRuntimeBinding
          │
          ▼
LogicalSession / TurnQueue
          │
          ▼
Agent / ACP
```

Automatic collaboration adds a restricted `ConversationRouter` beside this execution stack. It is not a participant or persistent conversation owner.

---

# 3. Delivery principles

Every phase must preserve:

1. Existing ordinary session chat continues unchanged.
2. Agent Messaging remains point-to-point, not Group broadcast.
3. Orchestration Groups remain task-lifecycle objects, not chat rooms.
4. Bot identity never derives from session alias or display name.
5. Topic is a public-context, runtime-context and execution-target boundary.
6. Message, Run and MemberTurn remain distinct durable identities.
7. Structured Bot IDs are canonical routing identities.
8. Explicit human target selection and automatic collaboration are separate Run modes.
9. Only explicit human-origin turns may use interactive human permission routing.
10. Automatic Router/member work remains non-human provenance.
11. Filesystem isolation is not inferred from session isolation.
12. Unknown side effects become `indeterminate`, not ordinary `failed`.
13. Deletion fails closed unless hidden runtime cleanup is verified.
14. Durable store state is canonical; Relay Web events are not the only record.
15. Private handoff remains deferred until its information-flow contract is designed.

---

# 4. Roadmap overview

| Phase | Theme | User-visible capability | Automatic Router? |
|---|---|---|---|
| 0 | Domain foundations | none | no |
| 1 | Direct Bot runtime | service-level reusable Bot identity | no |
| 2 | Direct Conversation durability | direct history, Run, cancel/recovery lifecycle | no |
| 3 | Control/Relay API | stable public Bot/Conversation contracts | no |
| 4 | Direct Bot product slice | complete direct Bot UI | no |
| 5 | Group foundations | Group/Topic/Run/ExecutionTarget | no |
| 6 | Explicit Group collaboration | choose members/everyone, Run cards | no |
| 7 | Automatic Router | automatic assignments/completion | yes |
| 8 | Public handoff + recovery | structured continuation and recovery | yes |
| 9 | External channel binding | Discord/Feishu/etc. → Conversation/Topic | yes where supported |
| 10 | Advanced collaboration | worktrees, richer policies, optional privacy features | optional |

---

# 5. Phase 0 — Domain/state foundations

## Goal

Introduce stable identities and state seams without exposing a half-built product.

## Deliverables

- `BotProfile`.
- `ConversationRecord` and `ConversationTopic`.
- `ConversationMessage` interface boundary.
- runtime binding identity and hidden-session ownership marker.
- opaque ID factories.
- durable Bot/Conversation metadata slots.
- old-state parsing/migration tests.
- explicit state replacement semantics for new durable collections.

The initial landed schema may contain provisional fields needed by the first PRs. Before public APIs freeze, align provisional names with the target semantic contract in the design spec.

## Acceptance

- old state loads safely;
- ordinary sessions remain ownerless;
- Bot/Conversation IDs never derive from names;
- new state collections publish without replacing live-only cache fields;
- malformed new records follow established state-store fail/drop/report behavior.

## Exit criterion

Later work can depend on stable product identities without alias conventions.

---

# 6. Phase 1 — Bot service and direct runtime

## Goal

Prove that a reusable Bot is a product identity above a normal xacpx logical session.

## Deliverables

- Bot CRUD service.
- server-owned profile/instruction composition.
- direct runtime binding.
- direct Conversation/default Topic bootstrap.
- safe create/reuse/restore semantics.
- exact `origin=human` for direct user turns.

## Required hardening

Runtime get-or-create must prove:

```text
same Bot/direct scope
  => one authoritative binding
  => one authoritative owned session
```

Concurrent callers use scoped single-flight/reservation rather than holding a non-reentrant daemon mutex across `SessionService` awaits.

Crash after session creation but before binding publication must recover the same logical ownership rather than mint an orphan.

Bot execution-affecting changes are not silently applied to a stale runtime:

- name/avatar/description: presentation-only;
- instructions: next turn;
- model/effort: turn-boundary or recreate according to adapter support;
- Agent/workspace/cwd: recreate/rebind or reject until lifecycle support exists.

Delete rejects any Bot that still has durable Conversation/runtime ownership until verified teardown exists.

## Exit criterion

Direct runtime ownership is correct under concurrency, restart and profile edits.

---

# 7. Phase 2 — Direct Conversation durability and lifecycle

## Goal

Complete the durable direct Bot backend before public UI is built.

This phase is intentionally moved ahead of the old Relay Web milestone so the UI does not depend on temporary history/deletion behavior.

## Deliverables

- concrete `ConversationStore` implementation;
- direct `ConversationMessage` history;
- per-Topic monotonic `seq`;
- caller `requestId` idempotency;
- `ConversationRun` for each direct request;
- `MemberTurn` correlation to the underlying xacpx turn;
- durable pending dispatch intent/outbox or equivalent transactional mechanism;
- direct cancellation by `runId`;
- reconnect/history replay by cursor;
- direct Conversation/Topic/Bot deletion lifecycle.

SQLite is preferred at this point because message + Run + pending dispatch need atomic durable transitions. Another backend is acceptable only if it provides equivalent semantics.

## Required recovery cases

```text
message committed, dispatch not started
  → resume pending dispatch once

member execution started, durable result unknown
  → recover if underlying execution proves state;
     otherwise classify side-effect-capable work as indeterminate

result committed, browser disconnected
  → replay by seq without duplication
```

## Exit criterion

A daemon restart or browser reconnect does not require inference from hidden session history to understand the direct Bot request lifecycle.

---

# 8. Phase 3 — Control and Relay API

## Goal

Expose stable server-owned Bot/Conversation contracts after persistence/lifecycle semantics are known.

## Deliverables

- Bot list/get/create/update/delete DTOs.
- Conversation/Topic/history DTOs.
- prompt API with `requestId` and structured target intent.
- run get/cancel APIs.
- cursor-based history/event replay.
- hidden owned sessions filtered from normal Sessions presentation.
- exact correlation between Conversation Run/MemberTurn and underlying session turns.

## API rule

Public clients operate on:

```text
Bot ID
Conversation ID
Topic ID
Run ID
```

They do not choose hidden session aliases.

## Exit criterion

A non-Web client can drive the direct Bot lifecycle without reaching into session internals.

---

# 9. Phase 4 — Direct Bot product slice

## Goal

Ship direct Bots as a complete product rather than a diagnostic wrapper around a hidden session.

## User experience

- Bots navigation separate from Sessions.
- create/edit Bot.
- direct Conversation history.
- new Topic / context reset behavior.
- streaming response/tool/thought/plan rendering through existing `TurnParts`.
- permission interaction through existing exact-turn routing.
- stop current Run.
- recover/reload after browser disconnect.
- safe delete behavior.

## Bot editor

Primary:

```text
name
description
instructions
Agent
default workspace
```

Advanced:

```text
avatar
cwd
model
effort
```

The UI explains execution-affecting changes that require runtime recreation.

## Exit criterion

Release A is a real vertical slice: create Bot → chat → history → cancel → reconnect → delete/reset without temporary semantics.

---

# 10. Phase 5 — Group foundations

## Goal

Introduce Group/Topic collaboration state before any multi-Bot execution.

## Deliverables

- Group membership and lead validation.
- Topic lifecycle.
- `ExecutionTarget` per Topic.
- `ConversationRun` and `MemberTurn` generalized for Group use.
- one-active-Run-per-Topic policy with queued later requests.
- explicit workspace isolation policy:
  - `shared`;
  - `shared-single-writer`;
  - future `worktree-per-member`.
- Group transcript/history.
- verified group-member runtime bindings.
- safe Topic/Group teardown.

No persistent controller session is required.

## Filesystem rule

Do not assume that separate logical sessions imply separate working trees.

For the initial engineering use case, `shared-single-writer` is the recommended default. Parallel work in a shared tree is allowed only when non-mutating capability is actually enforced; names like Reviewer/Tester do not prove read-only behavior.

## Exit criterion

Group identity, Topic context, Run lifecycle and execution target are durable before routing code starts work.

---

# 11. Phase 6 — Explicit Group collaboration

## Goal

Ship useful multi-Bot collaboration without model-driven recipient selection.

## Composer contract

The Group composer exposes an explicit target selector:

```text
Handle with: Lead ▾

Lead
Select members…
Everyone
```

`@Bot` and `@everyone` are shortcuts that update the same structured selection.

During this phase, default target is the visible Lead selection so a normal send works without an error requiring a mention.

## Execution semantics

```text
one selected member
  → one MemberTurn

multiple selected members
  → requested parallel batch,
     subject to execution-target filesystem policy

Everyone
  → all eligible current members,
     subject to the same policy
```

Explicit Run terminates when selected Member Turns become terminal. It never automatically invokes the Router afterward.

## UX

Introduce Run card aggregation:

```text
Reviewer   completed
Tester     running
Builder    waiting
[View activity] [Stop]
```

Expanded member activity reuses existing `TurnParts`.

## Exit criterion

Release B provides deterministic, secure Group collaboration that is useful without automatic planning.

---

# 12. Phase 7 — Automatic Router

## Goal

Add automatic collaboration only after explicit Group semantics are stable.

## Domain contract

```text
ConversationRouter.decide(
  public context,
  member capabilities/availability,
  Run state,
  execution target,
  remaining budget
)
→ dispatch | need-human | complete
```

Dispatch assignments contain:

- Bot ID;
- concrete `task`;
- optional `expectedOutput`;
- dependencies;
- trigger message IDs.

There is no ambiguous `none` result.

## Router constraints

A model Router is enabled only when the adapter can prove before execution:

```text
no tools
no filesystem/terminal capability
no permission interaction
no collaboration side effects
bounded structured output
```

The Router is stateless at the semantic level and is not a visible participant.

## Completion semantics

Automatic Run continues only while the plan requires work. Completion is explicit:

- `complete`;
- `need-human`;
- plan complete;
- cancel;
- budget exhaustion;
- unrecoverable failure;
- indeterminate side-effect state requiring recovery/human inspection.

Turn-count limits are guardrails, not completion policy.

## Exit criterion

Release C can coordinate an unaddressed request without weakening provenance, capability or completion semantics.

---

# 13. Phase 8 — Public handoff and recovery

## Goal

Allow collaboration to continue across assignments while keeping routing structured and recovery explicit.

## Public handoff

Initial primitive:

```ts
group_send({
  to: botId,
  task,
  expectedOutput?
})
```

Sender identity comes from the trusted runtime binding. Targets must be current Group members.

Public handoff extends the current Run and remains non-human provenance.

## Recovery

- failed members may be quarantined for the current Run;
- healthy completed results remain durable;
- recovery dispatches are explicit and budgeted;
- an unknown side-effect state is `indeterminate`, not a normal retry candidate;
- read-only/never-started work may be retried according to policy;
- write-capable indeterminate work requires inspection or human decision.

Private handoff remains out of scope.

## Exit criterion

Automatic collaboration can recover and continue without ambiguous text routing or blind duplicate side effects.

---

# 14. Phase 9 — External channel bindings

## Goal

Bind admitted external chats to the same Conversation/Topic domain.

Potential mapping:

```text
Discord channel → Group
Discord thread  → Topic
Feishu group    → Group
DM              → direct Bot Conversation
```

Rules:

- channel admission runs first;
- binding never grants extra authority;
- text-only names resolve only within current Group membership;
- ambiguous display names fail closed;
- structured target metadata is preferred when a channel integration can provide it;
- automatic downstream work retains non-human provenance.

## Exit criterion

Conversation semantics are independent from Relay Web.

---

# 15. Phase 10 — Advanced collaboration

Optional later capabilities:

- `worktree-per-member` execution with explicit integration step;
- richer read/write capability policies;
- group templates;
- workspace presets;
- configurable concurrency limits;
- resumable long-running Runs;
- richer synthesis policies;
- cross-instance membership with explicit trust/persistence contracts;
- private handoff after a dedicated information-flow threat model;
- analytics/usage summaries;
- channel-specific Topic UX.

Do not schedule cross-account/federated Group semantics until local membership, Run lifecycle and recovery are proven.

---

# 16. Release slicing

## Release A — Direct Bots

Ships Phases 0–4.

User value:

> Create reusable assistants and use them as durable direct conversations with history, cancellation and recovery.

Release A is not complete if direct history/deletion/reconnect still rely on temporary UI or hidden session behavior.

## Release B — Groups (Explicit)

Ships Phases 5–6.

User value:

> Put Bots in one Topic, choose exactly who handles a request, and see one collaboration Run with member activity.

This is intentionally valuable without model-driven routing.

## Release C — Groups (Automatic)

Ships Phase 7.

User value:

> Choose Automatic collaboration and let a restricted Router assign concrete work until a defined completion state.

## Release D — Collaboration Recovery

Ships Phase 8 plus remaining Group polish.

User value:

> Structured public handoff and safe recovery across member failures/interruption.

## Release E — Channel Bindings

Ships Phase 9.

---

# 17. Quality gates

Every implementation release must pass normal repository validation plus feature-specific gates.

Baseline:

```text
npm test / bun test according to repository convention
focused unit suites
npx tsc --noEmit
Relay Web tests/build when UI/protocol changes
git diff --check
```

Required architecture gates:

- state migration from prior released schema;
- no hidden session leakage into ordinary Sessions UI;
- runtime binding concurrency/restart tests;
- exact origin/provenance assertions for every new turn producer;
- request idempotency and cursor replay tests;
- cancellation by exact Run ID;
- no blind retry of indeterminate side-effect-capable work;
- filesystem scheduling policy tests;
- deletion lifecycle with injected release failure;
- protocol backward compatibility for additive DTO changes;
- automatic Router tests proving tools are disabled before execution.

---

# 18. Stop/go checkpoints

## After Phase 1

Do not expose Bot APIs widely until runtime binding create/reuse/recovery and configuration-change behavior are correct.

## After Phase 2

Do not build the direct Web product on a temporary history model. Verify idempotency, Run persistence, cancellation and reconnect first.

## After Phase 4

Release A should be usable independently. If direct Bot lifecycle still needs hidden-session manual cleanup, stop before Group work.

## After Phase 6

Evaluate whether explicit Groups already satisfy the main collaboration use case. Do not rush automatic routing if Run cards, workspace policy or cancellation remain confusing.

## After Phase 7

Automatic collaboration may expand only if Router capability restriction, completion and indeterminate recovery semantics remain understandable in real use.

---

# 19. Definition of done

The complete feature is done only when:

- Bots have stable identity independent from sessions;
- direct and Group histories are canonical and durable;
- Topics isolate public/model context and define execution target;
- every human request has a durable Run;
- every member execution is correlated to that Run and underlying session turn;
- explicit target selection is deterministic;
- automatic Router is restricted, stateless and structured;
- Group completion is explicit rather than “until the turn limit”;
- filesystem parallelism follows a declared enforceable policy;
- permission provenance is never upgraded in place;
- crash/reconnect recovery does not duplicate accepted requests;
- unknown side effects are represented as `indeterminate`;
- hidden runtime lifecycle is verified before deletion;
- ordinary Sessions, Agent Messaging and Task Orchestration keep their original semantics;
- external channel bindings reuse the same domain instead of inventing a second collaboration model.
