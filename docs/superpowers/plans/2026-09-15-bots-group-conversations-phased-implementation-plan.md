# xacpx Bots & Group Conversations — Phased Implementation Plan

> **Status:** Ready for implementation under revised architecture contracts  
> **Date:** 2026-09-15  
> **Design spec:** `docs/superpowers/specs/2026-09-15-bots-group-conversations-design.md`  
> **Roadmap:** `docs/superpowers/plans/2026-09-15-bots-group-conversations-roadmap.md`

---

# 1. Execution strategy

Implement this feature as a sequence of independently reviewable PRs. Each PR must establish one durable boundary and leave the repository in a coherent state.

The revised merge sequence is:

```text
PR 1   Domain/state foundations
PR 2   Bot CRUD + direct runtime binding
PR 3   Direct Conversation persistence + lifecycle
PR 4   Control/Relay Bot + Conversation API
PR 5   Relay Web direct Bot vertical slice
PR 6   Group/Topic/Run/ExecutionTarget foundations
PR 7   Explicit Group routing + Group UX
PR 8   Stateless automatic Router
PR 9   Public handoff + recovery
PR 10  External channel binding seam
```

The key change from the original plan is that direct persistence/lifecycle now lands **before** the public API/UI, and Group execution does not begin until `ConversationRun` and `ExecutionTarget` exist.

Do not begin with automatic routing. Do not make a browser-only history model. Do not treat session isolation as filesystem isolation.

---

# 2. Cross-cutting invariants

Every implementation PR must preserve:

```text
Bot identity              != logical session identity
Conversation identity     != chatKey
Topic                      = public context + runtime context + execution target boundary
Message                    != ConversationRun
ConversationRun            != MemberTurn
Group identity             != Orchestration Group identity
Group routing              != Agent Messaging broadcast
member display name        != canonical member identity
transcript snapshot        != filesystem snapshot
explicit human Run         != automatic Run
Router                     != persistent participant
failed                     != indeterminate
profile edit               != silent runtime drift
authority                  != mutable provenance flag
```

Any shortcut that violates one of these should be rejected even if it makes an early UI demo easier.

---

# 3. Current implementation alignment

The first two implementation PRs already exist:

```text
PR 1  #344 — Bot and Conversation durable state foundations
PR 2  #345 — BotService, direct Bot runtime binding and profile prompt
```

The revised architecture does not invalidate those PRs, but it changes several future-facing assumptions:

- a persistent `group-controller` runtime binding is not required by the target design;
- `GroupTurnRecord` should evolve into a Run-scoped `MemberTurnRecord` before Group execution ships;
- presentation-only `role` should become `description` or be explicitly kept out of model prompt composition before the public API freezes;
- direct Conversation history/lifecycle moves earlier than Relay Web UI;
- runtime workspace/cwd semantics belong to the effective Topic execution target once Groups exist.

Do not rewrite PR 1 solely to pre-land future Run fields. Keep it as a stable foundation and add new durable records in the PR that owns their lifecycle.

---

# 4. PR 1 — Domain and durable-state foundations

## Status

Implementation PR: `#344`.

## Objective

Land stable Bot/Conversation identities, durable state slots, opaque IDs and hidden-session ownership metadata.

## Required results

- `BotProfile` durable metadata.
- `ConversationRecord` and `ConversationTopic` durable metadata.
- `BotRuntimeBinding` foundation.
- `LogicalSession.owner` foundation.
- additive AppState maps.
- old-state parsing/migration.
- explicit runtime-state publish list.
- orchestration/state goldens updated for the new `AppState` shape.

## Review invariants

- `replaceRuntimeState` copies durable Bot/Conversation collections explicitly.
- live-only `native_session_lists` is not replaced from a copy-on-write snapshot.
- missing new sections load as empty maps without converting ordinary sessions.
- malformed new records follow existing state-store discipline.
- opaque IDs do not derive from names.

## Target-design note

The currently defined `group-controller` owner/binding scope may remain as a provisional unused schema value in PR 1. No later implementation should depend on it. Before automatic Group routing is public, either remove/migrate it or leave it permanently unused with an explicit compatibility rationale.

---

# 5. PR 2 — Bot service, profile prompt and direct runtime binding

## Status

Implementation PR: `#345`.

## Objective

Prove the first real Bot behavior without public Relay API/UI yet.

## 5.1 BotService

Responsibilities:

```text
listBots
getBot
createBot
updateBot
deleteBot
```

Validation:

- non-empty bounded name;
- Agent exists;
- workspace exists;
- nullable fields have explicit semantics;
- presentation metadata is distinct from model-facing instructions;
- deletion fails closed while durable Conversation/runtime references exist.

## 5.2 Profile composition

Requirements:

- durable server-owned profile is authoritative;
- ordinary Bot turns receive current instructions;
- whole-input runtime commands remain recognizable;
- clearing instructions stops future injection but does not claim to erase historical model context;
- presentation-only description/role is not accidentally treated as a trusted model instruction unless the product explicitly changes that contract.

## 5.3 Direct runtime get-or-create

`BotRuntimeManager.getOrCreateDirectSession()` must establish:

```text
Bot direct scope
  => one authoritative binding
  => one authoritative owned LogicalSession
```

Do not hold the shared non-reentrant daemon mutex across `SessionService` awaits.

Use:

- scoped single-flight/reservation for one direct Bot scope;
- deterministic/recoverable binding/session identity where appropriate;
- pure planning that does not mutate live Conversation state before durable publication;
- short publish section after session creation;
- restart recovery for session-created/binding-not-yet-published interruption.

Required tests:

- concurrent first create leaves exactly one owned session/binding;
- shared mutex create/reuse does not deadlock;
- stale binding repairs by logical-session identity, not alias coincidence;
- reload through `parseState` restores the live binding;
- injected failure between session persistence and binding publication recovers without orphan proliferation.

## 5.4 Runtime-affecting Bot updates

Until verified rebind lifecycle exists:

- name/avatar/description may update freely;
- instructions update next turn;
- model/effort may align at a safe turn boundary if supported;
- Agent/workspace/cwd changes must either recreate/rebind correctly or reject fail-closed;
- storing `cwd` while silently ignoring it at runtime is not allowed.

PR 2 may defer cwd support entirely by rejecting it until the lifecycle PR can bind it correctly.

## 5.5 Deletion

Until direct runtime teardown exists, delete only unused Bots.

Reject if any of the following exists:

- Group membership;
- direct Conversation;
- runtime binding;
- owned Bot logical session.

Later PRs may replace rejection with verified teardown.

---

# 6. PR 3 — Direct Conversation persistence and lifecycle

## Objective

Complete direct Bot durability before public API/UI is built.

This PR owns the first `ConversationRun` implementation.

## 6.1 Durable types

Add/evolve:

```ts
ConversationMessage {
  id
  conversationId
  topicId
  seq
  role
  senderBotId?
  content
  runId?
  sourceTurn?
  createdAt
}

ConversationRun {
  id
  conversationId
  topicId
  requestMessageId
  requestId
  mode
  state
  completionReason?
  generation
  maxMemberTurns
  consumedMemberTurns
  createdAt
  startedAt?
  finishedAt?
}

MemberTurnRecord {
  id
  runId
  conversationId
  topicId
  botId
  sessionAlias
  batch
  attempt
  origin
  state
  triggerMessageIds
  source turn correlation
}
```

Direct Bot uses one `MemberTurnRecord` per Run in the common case.

## 6.2 Store backend

Implement the durable Conversation store under `src/conversations/`.

Preferred backend: SQLite.

Reason: the feature now needs atomic state transitions, not just append-only transcript storage.

Required atomic operation for accepted human input:

```text
human message
+ ConversationRun
+ initial pending dispatch intent
```

Either all are durable or none are.

If a non-SQLite backend is chosen, it must demonstrate equivalent atomic/idempotent semantics in tests.

## 6.3 Idempotency

Public/internal request entry accepts caller `requestId`.

Uniqueness scope should be explicit, for example:

```text
conversationId + topicId + requestId
```

A retry after network timeout returns/reuses the already accepted Run rather than creating a duplicate.

## 6.4 Topic sequence cursor

Maintain monotonically increasing `seq` for canonical Topic events/messages.

History/reconnect queries support:

```text
afterSeq
beforeSeq
limit
```

Do not use timestamp or “latest received websocket event” as the only recovery cursor.

## 6.5 Pending dispatch / outbox

Persist dispatch intent before execution starts.

Minimum conceptual record:

```ts
PendingDispatch {
  id
  runId
  memberTurnId
  state: "pending" | "claimed" | "completed"
  generation
  createdAt
}
```

Dispatcher claims idempotently and records enough identity to avoid double-start after restart.

## 6.6 Direct execution flow

```text
submit(requestId, text)
→ transaction: human message + Run + pending dispatch
→ dispatcher claims
→ resolve direct runtime binding
→ create/start MemberTurn
→ existing xacpx turn runner
→ transaction: visible result + terminal MemberTurn + Run progress
```

## 6.7 Cancellation

Add exact cancellation by `runId`.

Cancel:

- marks Run cancel requested/terminal according to final outcome;
- stops future dispatch for that Run;
- delegates active turn cancellation to existing infrastructure;
- records late/unknown execution outcome safely.

## 6.8 Indeterminate state

Introduce `indeterminate` before Group writes exist so recovery semantics are not bolted on later.

If a side-effect-capable turn started and xacpx cannot prove whether it completed before interruption:

```text
MemberTurn = indeterminate
Run = indeterminate or waiting for recovery/human action
```

Do not automatically replay the same write-capable work.

## 6.9 Direct lifecycle/delete

Add verified teardown for direct Conversation/Topic/Bot where practical.

Required order:

```text
reject new Runs
→ cancel/drain active Run
→ verified hidden-session release
→ delete runtime binding
→ delete Conversation store rows
→ delete metadata/Bot when requested
```

Injected release failure must leave retryable durable ownership state.

## Tests

- requestId duplicate retry returns same Run;
- seq strictly monotonic after restart;
- crash after request transaction but before dispatch resumes once;
- result durable before reconnect replays once;
- cancel exact Run;
- indeterminate side-effect path;
- verified direct teardown failure/retry;
- direct history pagination/order.

---

# 7. PR 4 — Control and Relay protocol surface

## Objective

Expose stable Bot/Conversation/Run contracts only after direct persistence semantics are known.

## 7.1 DTOs

Add DTOs for:

```text
BotSummary / BotDetail
BotCreate / BotUpdate
ConversationSummary / TopicSummary
ConversationMessage
ConversationRun
MemberTurnSummary
Prompt request / response
Run cancel
history/events cursor replay
```

Do not expose hidden aliases as primary identifiers.

## 7.2 Control methods

Suggested surface:

```text
control.bots.list/get/create/update/delete
control.conversations.list/get
control.topics.list/create/archive/delete
control.conversation.prompt
control.conversation.history
control.runs.get
control.runs.cancel
```

Names should follow existing ControlService conventions.

## 7.3 Prompt input

Direct prompt input includes:

```ts
{
  conversationId,
  topicId,
  requestId,
  text,
  target // direct server-derived or later group structured target
}
```

The caller never supplies a trusted hidden session alias.

## 7.4 Events

Add Run-aware identity events only where existing turn events are insufficient:

```text
bots-changed
conversations-changed
conversation-topic-changed
conversation-message
conversation-run-changed
member-turn-started
member-turn-finished
```

Underlying tool/thought/plan/usage events continue to use existing event machinery and are joined through exact session/turn correlation.

## 7.5 Session-list filtering

Owned Bot/Group sessions are hidden from ordinary product Session lists by explicit owner metadata, never alias parsing.

## Tests

- backward-compatible DTO additions;
- prompt request idempotency;
- hidden alias cannot be selected by public Bot prompt API;
- run cancel routes to exact Run;
- history replay by seq;
- hidden owned sessions absent from ordinary Sessions list.

---

# 8. PR 5 — Relay Web direct Bot vertical slice

## Objective

Ship the complete direct Bot user flow.

## 8.1 Navigation/state

Add Bot and Conversation stores keyed by stable product IDs.

Recommended selection key:

```text
instanceId × conversationId × topicId
```

Underlying execution buffers may remain keyed by session alias internally, but the product selection must not be.

## 8.2 Bot editor

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

Show a clear warning/behavior when execution-affecting changes require runtime rebind.

> Scope note (PR5 / #350): Bot teardown/rebind is deferred to a dedicated
> lifecycle follow-up PR. A used Bot (one that has materialized a direct
> runtime) is identity-locked in PR5: agent/workspace are read-only and delete
> is fail-closed (`runtime_identity_locked` / `bot_in_use`), because context
> persists by design and no public teardown/rebind RPC exists yet. PR5
> surfaces this honestly in the UI instead of failing at submit. The follow-up
> owns the destructive surface (explicit history/context consequences) and the
> verified rebind path for identity changes.

## 8.3 Direct chat

Must support:

- durable history;
- streaming live response;
- existing TurnParts/tool/thought/plan UI;
- Stop current Run;
- reconnect by seq;
- new Topic (fresh context within the same Bot);
- delete status (unused Bots deletable; used Bots fail-closed per the scope
  note above — no teardown surface in PR5).

> Scope note (PR5 / #350): Relay Web permission interaction is deferred to a
> dedicated follow-up PR. It needs protocol + Hub request/downlink +
> RelayChannel `requestPermission()` + Web approval UI/response flow — an
> independent feature surface. Until then RelayChannel has no permission
> round-trip and the broker retains fail-closed `reject_once` semantics.

## 8.4 Profile-edit semantics in UI

Explain:

```text
Instructions changed
→ applies to future turns
→ does not erase existing conversation memory
```

“New topic” is the primary clean-context action.

## Tests
- Bot rename preserves selected ID;
- live + durable history converge;
- reconnect does not duplicate final message;
- cancel targets current Run;
- used Bot shows identity-locked agent/workspace and fail-closed delete
  (teardown/rebind deferred per the scope note above);
- ordinary Sessions navigation unchanged.

Follow-up (deferred from PR5): permission request uses exact current human
turn — tracked with the Relay permission interaction milestone/PR above.

---

# 9. PR 6 — Group/Topic/Run/ExecutionTarget foundations

## Objective

Land all durable Group collaboration state before executing multiple members.

## 9.1 Group metadata

Implement:

```text
create/update/delete Group
membership
lead
Topic create/archive/delete
history
```

Constraints:

- min two Group members;
- unique Bot IDs;
- lead belongs to membership;
- disabled/missing member policy explicit.

## 9.2 ExecutionTarget

Add effective Topic target:

```ts
ExecutionTarget {
  workspace: string
  cwd?: string
  isolation:
    | "shared"
    | "shared-single-writer"
    | "worktree-per-member"
}
```

Bot workspace/cwd are defaults. A Group Topic owns the actual work target.

Initial product should support `shared` and `shared-single-writer`; `worktree-per-member` may remain a future enum/state value only if migration semantics are clear, otherwise add it later.

## 9.3 Run generalization

Ensure `ConversationRun` supports:

```text
mode = explicit | automatic
one active Run per Topic
queued later requests
generation
batch
budget
failed/unavailable members
indeterminate state
```

## 9.4 MemberTurn generalization

Add Group assignment fields:

```text
batch
assignmentId
task
expectedOutput
dependsOn / trigger IDs
origin
attempt
```

Rename provisional `GroupTurnRecord` before public Group APIs freeze if needed.

## 9.5 Group member runtime bindings

Implement only member bindings:

```ts
getOrCreateGroupMemberSession({ botId, conversationId, topicId })
```

No persistent Router/controller session is required.

Isolation tests:

```text
direct vs Group
Group A vs Group B
Topic A vs Topic B
```

## 9.6 Filesystem scheduling seam

Add explicit effect classification input to scheduling.

Rule:

- if read-only capability is enforceably proven, parallel shared-tree execution may be allowed;
- otherwise treat the MemberTurn as side-effect-capable;
- `shared-single-writer` serializes side-effect-capable turns;
- never infer from Bot name/description.

## 9.7 Teardown

Topic deletion:

```text
mark deleting
→ stop/settle active Run
→ release all member runtimes
→ remove bindings
→ remove Conversation-store rows
→ remove Topic metadata
```

Failure must be retryable.

---

# 10. PR 7 — Explicit Group routing and Group UX

## Objective

Deliver deterministic useful multi-Bot collaboration without automatic Router behavior.

## 10.1 Structured target input

Use a product-level target contract:

```ts
type ConversationTarget =
  | { mode: "members"; botIds: string[] }
  | { mode: "everyone" };
```

Relay Web mention ranges may accompany the target for text highlighting but are not the authority.

Server validates current membership and deduplicates IDs.

## 10.2 Composer UX

Show target next to the input:

```text
Handle with: Lead ▾

Lead
Select members…
Everyone
```

`@` updates structured selection.

Default visible selection is Lead during the explicit-only release.

## 10.3 Explicit Run semantics

```text
human message
→ explicit Run
→ one or more MemberTurns
→ terminal selected MemberTurns
→ Run completed/failed/cancelled/indeterminate
```

Do not invoke any Router when selected members finish.

## 10.4 Parallel transcript semantics

Members selected for one parallel batch receive one frozen public transcript snapshot.

A member finishing early does not change another already-selected primary member's input.

## 10.5 Filesystem enforcement

Requested parallelism passes through the Topic isolation policy.

In `shared-single-writer`, side-effect-capable turns execute sequentially even when the user selected multiple members.

The Run UI may still show all members as part of one batch while execution scheduling is safely serialized.

## 10.6 Permission provenance

Explicit human target:

```text
ChatRequestMetadata.origin = human
MemberTurn.origin = human-explicit
```

This preserves ordinary exact permission routing.

## 10.7 Run card

Group transcript shows one collaboration card:

```text
Reviewer   completed
Tester     running
Builder    waiting

[View activity] [Stop]
```

Expanding a member reuses existing `TurnParts`.

## Tests

- one target;
- multiple targets;
- everyone;
- unknown/removed member rejection;
- display-name collision irrelevant;
- explicit Run never auto-continues;
- frozen transcript batch;
- shared-single-writer serialization;
- human explicit permission interaction;
- cancel exact Run and suppress new dispatches;
- direct/other-Topic context exclusion.

---

# 11. PR 8 — Stateless automatic ConversationRouter

## Objective

Add automatic collaboration only after explicit Group behavior is stable.

## 11.1 Domain interface

Create:

```ts
interface ConversationRouter {
  decide(input: RoutingInput): Promise<RoutingDecision>;
}
```

Input contains only current explicit state:

- public context snapshot;
- latest human request;
- member metadata/capabilities/availability;
- Run state;
- completed/failed assignments;
- remaining budget;
- ExecutionTarget policy.

Do not depend on hidden Router history.

## 11.2 Decision schema

```ts
type RoutingDecision =
  | {
      type: "dispatch";
      mode: "single" | "parallel" | "sequential";
      assignments: Array<{
        id: string;
        botId: string;
        task: string;
        expectedOutput?: string;
        dependsOn?: string[];
        triggerMessageIds: string[];
      }>;
    }
  | { type: "need-human"; question: string }
  | { type: "complete"; reason: string; synthesisBotId?: string };
```

Do not implement `none`.

## 11.3 Capability boundary

A model Router is available only when the adapter can disable before execution:

```text
tools
filesystem/terminal
permission requests
Agent Messaging / Orchestration side effects
```

If the adapter cannot prove this restriction, automatic mode is unsupported for that configuration.

Do not rely on post-hoc observation of tool events.

## 11.4 Automatic Run state machine

```text
queued
→ routing
→ dispatching/running
→ routing after completed planned batch if required
→ complete | waiting-human | failed | cancelled | indeterminate
```

Implementation may represent routing as a Run substate/event rather than adding another top-level state, but persistence/restart behavior must be deterministic.

## 11.5 Completion

Automatic Run ends only through explicit completion semantics:

- Router `complete`;
- Router `need-human`;
- planned work complete;
- human cancel;
- budget exhaustion;
- unrecoverable failure;
- unsafe unknown side effect.

`maxMemberTurns` is a loop guard, not normal completion.

## 11.6 Provenance

```text
Router-selected MemberTurn => orchestration
```

No human permission authority is inherited.

## 11.7 Blocked-permission UX contract

When an automatic step requires human-origin execution, emit structured blocked-step information.

Relay Web may offer:

```text
[Start this step myself]
```

Clicking creates a new explicit human request referencing the blocked assignment. It does not mutate the origin of the old automatic turn.

## Tests

- explicit target bypasses Router entirely;
- Router input contains no private/direct/other-Topic state;
- tools unavailable before Router execution;
- unsupported adapter disables automatic mode;
- malformed schema rejected;
- unknown member rejected;
- dispatch assignments preserve task/expectedOutput/dependencies;
- need-human persists `waiting-human`;
- complete persists terminal state;
- budget exhaustion explicit;
- automatic selected member cannot mint human permission interaction.

---

# 12. PR 9 — Public handoff and recovery

## Objective

Continue collaboration across members without name parsing and recover safely from member failure/interruption.

## 12.1 Public handoff primitive

Add:

```ts
group_send({
  to: botId,
  task: string,
  expectedOutput?: string
})
```

Server derives:

- sender Bot ID;
- Conversation ID;
- Topic ID;
- Run ID;
- current MemberTurn.

Tool input cannot spoof sender identity.

## 12.2 Handoff semantics

Public handoff:

- validates target membership;
- records structured assignment/visible envelope as designed;
- extends the current Run;
- remains peer/orchestration provenance;
- respects Run budget and filesystem policy.

No private handoff in this PR.

## 12.3 Recovery classification

Distinguish:

```text
failed
  execution is known not to have completed successfully

indeterminate
  side effects may have occurred but terminal state cannot be proven
```

Policy:

- pending/not-started may redispatch;
- enforceably read-only work may retry under policy;
- side-effect-capable indeterminate work does not blind retry;
- recovery may inspect current state before deciding whether to continue.

## 12.4 Quarantine/failover

- failed member may be unavailable for the current Run;
- preserve healthy completed outputs;
- recovery assignments use remaining budget;
- no unbounded handoff loop;
- lead/synthesis behavior uses explicit assignments rather than hidden controller history.

## Tests

- sender spoof rejected by construction;
- non-member target rejected;
- public handoff appended once;
- handoff target triggered once after restart;
- indeterminate write not automatically replayed;
- healthy results preserved after sibling failure;
- recovery respects filesystem single-writer policy;
- turn/assignment budget prevents loops.

---

# 13. PR 10 — External channel binding seam

## Objective

Map admitted channel chats/threads onto the same Conversation domain.

## 13.1 Binding model

```ts
interface ConversationBinding {
  chatKey: string;
  conversationId: string;
  topicId?: string;
}
```

## 13.2 Order of trust decisions

```text
channel admission/authentication
→ Conversation binding lookup
→ structured/fallback target resolution
→ Conversation request creation
```

Binding never bypasses admission.

## 13.3 Candidate mappings

```text
Discord channel → Group
Discord thread  → Topic
Feishu group    → Group
DM              → direct Bot Conversation
```

## 13.4 Text-only addressing

Fallback name parsing:

- searches only current Group membership;
- exact/unique match required;
- ambiguity fails closed;
- generated model text is never treated as a trusted human target selection.

## Tests

- admission failure cannot reach bound Conversation;
- binding restore after daemon restart;
- thread/topic isolation;
- ambiguous member text fails closed;
- human external request preserves correct human provenance only when the channel adapter supplied explicit authenticated human origin.

---

# 14. Persistence architecture

## 14.1 AppState

Keep bounded metadata in AppState where appropriate:

```text
Bots
Conversation metadata
Topic metadata / execution target
runtime bindings
small lifecycle indexes if needed
```

Do not put unbounded transcript/Run event history in `state.json`.

## 14.2 Conversation database

Preferred durable store owns:

```text
messages
runs
member_turns
pending_dispatches
conversation/topic sequence allocation
possibly durable conversation events
```

The exact schema can evolve, but transactions must support the recovery contracts.

## 14.3 Canonical ordering

Allocate `seq` transactionally per Topic.

Do not infer ordering from:

- wall clock;
- websocket arrival;
- member completion timestamp;
- session history merge.

---

# 15. Dispatcher and queue integration

Reuse existing per-session `TurnQueue` for actual model execution.

Conversation-level scheduler owns only:

```text
which MemberTurns should exist
which are eligible now
which runtime binding to use
filesystem concurrency constraints
Run budget/state
```

It does not replace TurnQueue.

Recommended conceptual pipeline:

```text
Conversation request transaction
→ PendingDispatch
→ ConversationDispatcher
→ BotRuntimeManager
→ existing SessionService / TurnQueue
→ exact result correlation
→ Conversation result transaction
```

Never find a result using “latest turn for alias” or content matching. Store exact correlation IDs.

---

# 16. Filesystem execution policy

The scheduler must distinguish requested conversational parallelism from safe filesystem concurrency.

## 16.1 Effect classification

If xacpx cannot enforce that a turn is read-only/non-mutating, classify it as potentially side-effecting.

Do not infer from Bot identity or prompt wording.

## 16.2 `shared`

Only allow true parallelism where the configured/enforced capability policy makes it safe for the intended task.

## 16.3 `shared-single-writer`

Recommended initial software-work default.

- non-mutating readers may run concurrently when enforceably read-only;
- side-effect-capable turns acquire a Topic execution write slot;
- only one writer executes at a time;
- Run/assignment semantics remain unchanged even if execution is serialized.

## 16.4 `worktree-per-member`

Defer unless the repository already has a reusable worktree lifecycle abstraction.

When implemented, it must include:

- deterministic worktree creation;
- cleanup/recovery;
- base commit identity;
- explicit integration/merge step;
- conflict state surfaced to the Run.

---

# 17. Bot profile revision and runtime fingerprint

Before Group runtime reuse becomes public, add enough data to detect execution drift.

Recommended:

```text
BotProfile.profileRevision
BotRuntimeBinding.profileRevision
BotRuntimeBinding.runtimeFingerprint
```

Fingerprint covers at least:

```text
Agent
workspace
cwd
```

Model/effort belong either in fingerprint or a separately versioned turn-boundary setting policy.

Rules:

- presentation changes do not force rebind;
- instruction revision changes prompt composition but does not promise context erasure;
- runtime fingerprint mismatch cannot silently reuse old Agent/workspace/cwd.

---

# 18. Permission matrix

| Producer | Request origin | Human interactive authority |
|---|---|---|
| direct human → Bot | `human` | yes |
| explicit Group member(s) | `human` | yes |
| Router decision | internal/orchestration | no |
| Router-selected MemberTurn | `orchestration` | no |
| public handoff | `peer` or orchestration-equivalent | no |
| recovery | `orchestration` | no |
| scheduled task | `scheduled` | no |

Every newly introduced execution path needs an exact test for this table.

The UI continuation button for a blocked automatic step creates a new `human` request; it never changes the old turn's provenance.

---

# 19. Relay Web state model

Product-level state should be keyed by stable Conversation domain identity.

Recommended keys:

```text
Bot selection:
  instanceId × botId

Conversation Topic:
  instanceId × conversationId × topicId

Run detail:
  instanceId × runId
```

Underlying streaming buffers may retain session/turn keys internally.

Do not derive current Topic/Run from hidden session alias.

---

# 20. Adversarial tests

The feature is not complete without tests for hostile or unlucky timing.

## Identity/routing

- duplicate Bot display names;
- renamed Bot with existing runtime;
- fake text containing another Bot name;
- client sends valid-looking non-member Bot ID;
- model generates `@Name` but no structured handoff/target metadata.

## Concurrency

- two simultaneous direct first requests;
- two queued same-Topic requests;
- cancel while a dispatch is being claimed;
- member finishes while cancel commits;
- reconnect during final-result commit;
- Router decision races with human cancel.

## Persistence

- crash after human message transaction;
- crash after pending dispatch claim;
- crash after owned session create but before binding publish;
- crash after model side effect but before completion persistence;
- crash after result persistence but before websocket delivery.

## Filesystem

- two potentially mutating members requested in parallel under `shared-single-writer`;
- read-only flag not enforceable → treated as writer/potentially mutating;
- worktree cleanup failure when that mode eventually exists.

## Permissions

- automatic member tries permission-gated action;
- generated metadata attempts to claim `origin=human`;
- blocked-step continuation creates new human request rather than upgrading old one.

## Lifecycle

- Topic delete during active Run;
- Bot delete with direct binding;
- session release failure during delete;
- Group membership edit while a Run references removed member;
- stale runtime fingerprint after profile edit.

---

# 21. Performance guards

Initial conservative limits:

```text
one active Run per Topic
bounded queued Runs per Topic
max member turns per automatic Run: 24
max Router attempts/failovers: small bounded value
Router decision timeout: ~30s initial target
bounded context snapshots
bounded per-Group member concurrency
one side-effect writer per shared-single-writer Topic
```

These are safety/performance guards, not product completion rules.

Measure before increasing concurrency.

---

# 22. Review checklist for every PR

## Identity

- Are stable product IDs used instead of aliases/names?
- Does any code infer ownership by parsing alias text?

## Context

- Can direct/other-Group/other-Topic hidden history leak into this input?
- Does an instructions edit make unsupported “forgetting” claims?

## Run lifecycle

- What durable object represents this user request?
- Can it be cancelled by exact ID?
- What happens after restart at every await boundary?

## Concurrency

- Is shared daemon mutex held across code that can reacquire it?
- Is get-or-create single-flight/reserved?
- Can a loser leave an orphan runtime?

## Persistence

- Are message/Run/dispatch acceptance atomic enough?
- Is replay idempotent?
- Is ordering based on durable seq?

## Runtime configuration

- Does profile change cause silent execution-environment drift?
- Is cwd actually applied if accepted?

## Filesystem

- Is requested parallelism safe for the effective workspace policy?
- Is read-only status enforceable rather than inferred?

## Provenance

- Who created the turn?
- Could non-human work accidentally mint human permission routing?

## Recovery

- Is this a known failure or unknown side-effect state?
- Could retry duplicate writes?

## Lifecycle

- Are hidden resources released before ownership records disappear?
- Does failure leave retryable durable state?

---

# 23. Implementation readiness decisions

The following decisions are now part of the target direction:

1. **ConversationRun is first-class.** Do not model Group execution only as independent member turns.
2. **MemberTurn replaces GroupTurn as the execution-level lifecycle concept before Group APIs freeze.**
3. **Topic owns effective ExecutionTarget.** Bot workspace/cwd are defaults.
4. **Filesystem isolation is explicit.** Initial engineering default should be `shared-single-writer` unless read-only parallelism is enforceably safe.
5. **Automatic coordination uses a stateless `ConversationRouter`.** No persistent controller history is required.
6. **Router decision has `dispatch | need-human | complete`; no `none`.**
7. **Router assignments contain concrete task/expectedOutput/dependencies.**
8. **Automatic Router requires pre-execution capability restriction.** Post-hoc tool-event detection is insufficient.
9. **Direct persistence/lifecycle precedes public direct Bot UI.**
10. **Request idempotency and Topic seq are part of the storage contract.**
11. **`indeterminate` is a real execution state.** Unknown side effects do not become automatic retries.
12. **Private handoff is deferred.** First collaboration handoff is public and structured.
13. **Profile revision/runtime fingerprint detect stale execution environments.**
14. **Authority is never upgraded in place.** Human continuation creates a new human-origin request.

Open implementation choices that can be decided in the owning PR:

- exact SQLite schema and migration layout;
- whether durable Conversation events share the message `seq` stream or use a companion event stream;
- exact effect-capability representation used by filesystem scheduling;
- whether model/effort are part of runtime fingerprint or managed by a separate adapter settings revision;
- exact Control/Relay method names consistent with repository naming conventions.

---

# 24. End-state validation scenario

Before calling the feature architecture-complete, run an end-to-end scenario covering:

1. Create Reviewer/Builder/Tester Bots.
2. Direct chat Reviewer; durable Run/history created.
3. Restart daemon; direct binding/history restore.
4. Change Reviewer instructions; next turn uses new instructions without claiming old history is erased.
5. Change execution-affecting runtime setting; verified rebind/reject behavior occurs rather than silent old-runtime reuse.
6. Create Group and Topic targeting a real workspace with `shared-single-writer`.
7. Composer visibly targets Lead by default.
8. Explicitly select Reviewer + Tester; one explicit Run created.
9. Their transcript inputs use one frozen snapshot; unsafe shared-tree writers serialize.
10. Run card aggregates existing TurnParts activity.
11. Start Automatic collaboration; Router receives only explicit bounded public state and no tools.
12. Router emits concrete assignments with expected outputs.
13. Automatic Builder action requiring human provenance becomes blocked.
14. User clicks “Start this step myself”; a new explicit human Run/turn is created.
15. Simulate browser disconnect after durable result; reconnect by seq restores exactly once.
16. Simulate process loss after a potentially mutating turn started; state becomes indeterminate and is not blindly retried.
17. Public structured handoff targets a current member and preserves non-human provenance.
18. Create a new Topic; membership remains while model conversation context starts fresh.
19. Delete/teardown with injected runtime-release failure leaves retryable ownership state.

If this scenario works without alias parsing, hidden-history merging, origin promotion or unsafe duplicate writes, the architecture is ready for wider collaboration features.
