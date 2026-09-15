# xacpx Bots & Group Conversations — Roadmap

> **Status:** Proposed  
> **Date:** 2026-09-15  
> **Companion spec:** `docs/superpowers/specs/2026-09-15-bots-group-conversations-design.md`

---

# 1. Purpose

This roadmap turns the Bots & Group Conversations design into an incremental delivery sequence that preserves xacpx's existing session, permission, Agent Messaging and Orchestration guarantees.

The guiding rule is:

> Build the conversation domain first, then add automatic coordination.

Do not begin with a hidden group controller. The first milestones must establish stable Bot identity, direct Bot sessions, Conversation persistence, Topic isolation and deterministic explicit-member routing. Once those foundations are proven, automatic group scheduling can be added without making session aliases or ad-hoc prompt text part of the public model.

---

# 2. Target end state

The finished product should expose four distinct collaboration surfaces:

```text
1. Ordinary Session
   human ↔ one logical xacpx session

2. Bot Conversation
   human ↔ reusable Bot profile

3. Group Conversation
   human + multiple reusable Bots
   shared transcript + Topics + controller

4. Existing internal collaboration
   Agent Messaging + Task Orchestration
```

The execution stack remains shared:

```text
Conversation / Bot / Group
          │
          ▼
BotRuntimeBinding
          │
          ▼
LogicalSession
          │
          ▼
TurnQueue
          │
          ▼
Agent / ACP
```

---

# 3. Delivery principles

Every phase must obey these rules:

1. Existing session chat continues to work unchanged.
2. Agent Messaging remains point-to-point and is not converted into group broadcast.
3. Orchestration Groups remain task-lifecycle objects, not chat rooms.
4. Hidden Bot/group sessions never become the product identity.
5. Group runtime contexts are isolated by Conversation + Topic + Bot.
6. Structured IDs, not display names, are the canonical route in Relay Web.
7. Only explicit human-origin member turns may mint interactive permission routing.
8. Controller-selected work remains non-human provenance.
9. Daemon-side state remains canonical; Relay Web is not the only owner of Bot/Group data.
10. Deletion and teardown fail closed when hidden runtime cleanup cannot be verified.

---

# 4. Roadmap overview

| Phase | Theme | Main user-visible capability | Automatic controller? |
|---|---|---|---|
| 0 | Contracts and storage seams | none | no |
| 1 | First-class Bots | create/edit Bots and direct Bot chat | no |
| 2 | Conversations and Topics | durable group objects, Topics, shared transcript | no |
| 3 | Explicit group routing | `@Bot`, multi-mention, `@everyone`, parallel execution | no |
| 4 | Automatic group controller | unaddressed single/parallel/sequential routing | yes |
| 5 | Handoffs and recovery | structured public/private handoff, failover | yes |
| 6 | Relay Web product polish | full Bot/Group navigation, activity, unread/search | yes |
| 7 | External channel bindings | Discord/Feishu/etc. binding to Bot/Group/Topic | yes |
| 8 | Advanced collaboration | optional richer policies, cross-instance/group features | yes |

---

# 5. Phase 0 — Contracts and storage seams

## Goal

Introduce the domain and persistence interfaces without exposing a half-built product.

## Deliverables

- `BotProfile` type.
- `ConversationRecord` and `ConversationTopic` types.
- `ConversationMessage` and `GroupTurnRecord` types.
- `BotRuntimeBinding` type.
- `ConversationStore` interface.
- durable state slots for Bot/Conversation metadata.
- internal ID factories for Bot, Conversation, Topic, GroupTurn and binding identities.
- explicit internal ownership marker for hidden Bot/group logical sessions.
- serialization/migration tests for old state without the new fields.

## Acceptance

- Existing state files load without changes from the user.
- Empty new collections are migrated/persisted deterministically.
- No existing logical session is auto-converted into a Bot.
- Hidden-session ownership metadata can be round-tripped without affecting existing session behavior.

## Exit criterion

All later phases can depend on stable domain IDs and storage interfaces without inventing temporary alias conventions.

---

# 6. Phase 1 — First-class Bots and direct Bot chat

## Goal

Ship the first useful slice: reusable Bot profiles that talk through isolated normal xacpx logical sessions.

## Core implementation

- `BotService` CRUD.
- `BotRuntimeManager.getOrCreateDirectSession()`.
- server-owned Bot profile prompt composition.
- profile updates apply on the next turn without recreating the logical session.
- direct Bot Conversation creation.
- direct Bot Topic creation/default Topic.
- Relay/control DTOs and RPCs for Bot CRUD and direct prompt.
- Relay Web Bot list/editor and direct chat surface.

## User experience

The user can create:

```text
Name: Reviewer
Role: Code reviewer
Instructions: Focus on correctness, races and unsafe behavior.
Agent: codex
Workspace: xacpx
Model: ...
Effort: ...
```

Then open `Reviewer` and chat normally.

## Required invariants

- Bot ID is stable across rename/runtime changes.
- Bot direct chat uses a separate logical session from ordinary existing sessions.
- Bot profile does not override daemon permission/security settings.
- direct Bot turns are `origin=human`.
- runtime commands remain recognizable.
- queue-owner/session restore behavior remains normal xacpx behavior.

## Tests

- Bot create/update/delete validation.
- profile live update.
- direct-session binding restore after daemon restart.
- Bot rename does not change binding identity.
- changing model/effort follows the selected runtime policy without changing Bot ID.
- normal permission interaction works in a direct Bot chat.
- old sessions remain visible and unchanged.

## Exit criterion

A Bot is proven to be a product identity above LogicalSession rather than a renamed session row.

---

# 7. Phase 2 — Conversation and Topic foundations

## Goal

Add durable Group and Topic objects plus canonical shared transcript storage, but do not add model-driven routing yet.

## Core implementation

- `ConversationService` CRUD.
- Group membership and lead validation.
- Topic create/archive/delete.
- `ConversationStore` implementation.
- canonical public transcript ordering.
- BotRuntimeManager group-member/controller binding methods, although controller execution remains unused.
- verified Topic/Conversation binding teardown.
- Relay/control DTOs for Conversation/Topic list/create/update/delete/history.
- Relay Web Group creation/editing and Topic selector.

## User experience

The user can:

- create a Group with at least two Bots;
- choose a lead;
- open a default Topic;
- create additional Topics;
- see an empty shared transcript.

No unaddressed prompt execution is available yet unless the product chooses an explicit lead-only fallback. Preferred behavior is to require a member mention during this phase.

## Required invariants

```text
same Bot, direct vs Group    => different session
same Bot, Group A vs Group B => different session
same Bot, Topic A vs Topic B => different session
controller vs lead member    => different session
```

## Tests

- membership constraints.
- duplicate membership rejection.
- lead membership validation.
- Topic isolation.
- durable transcript pagination/order.
- delete Topic drains/releases hidden bindings before metadata deletion.
- delete Group releases all Topic bindings.
- referenced Bot deletion rejects cleanly.

## Exit criterion

Group identity, Topic identity, transcript and hidden runtime ownership are durable and independent from Relay Web process state.

---

# 8. Phase 3 — Explicit group routing

## Goal

Ship useful multi-Bot group interaction without trusting a model to choose recipients.

## Supported routing

```text
@Reviewer ...
  → Reviewer only

@Reviewer @Tester ...
  → Reviewer + Tester in parallel

@everyone ...
  → all eligible members in parallel
```

Relay Web sends structured member IDs and mention ranges. The server verifies membership and ignores display text as an authorization identity.

## Core implementation

- Group router explicit-target path.
- group-member turn creation.
- public transcript append on member completion/stream finalization.
- per-member attribution.
- group-turn lifecycle events.
- parallel batch execution with one frozen input snapshot.
- group cancel behavior.
- current-members-only fallback parser for future text-only channels, tested but not required for Relay Web routing.

## Permission behavior

Explicit human member addressing creates:

```text
turn origin = human
GroupTurn.origin = human-explicit
```

Normal exact-turn permission UI remains available.

## Tests

- one explicit target bypasses any controller path.
- multiple targets execute parallel against the same transcript snapshot.
- `@everyone` selects the current eligible membership exactly once.
- removed/unknown member IDs reject.
- duplicate structured mentions deduplicate.
- Bot display-name collisions do not affect structured-ID routing.
- human explicit member turn can mint permission interaction.
- no direct/private Bot history appears in group context.

## Exit criterion

The product already provides deterministic, secure multi-Bot group chat before automatic coordination exists.

---

# 9. Phase 4 — Automatic group controller

## Goal

Allow an unaddressed human request to be routed automatically.

## Decision contract

```ts
{
  mode: "none" | "single" | "parallel" | "sequential";
  memberIds: string[];
  triggerMessageIds: string[];
}
```

## Controller behavior

- separate hidden controller session per Topic;
- prefer lead runtime configuration;
- strict structured-output validation;
- no tool calls;
- no permission requests;
- no visible assistant message;
- 30s decision timeout initially;
- at most three controller candidates;
- 24 member-turn guard per group run initially.

## Permission behavior

Controller and controller-selected members are not treated as human-origin turns.

```text
controller              => orchestration
controller-selected Bot => orchestration
```

A broad human request does not grant interactive approval authority to every automatically selected downstream member.

## Execution semantics

Parallel:

```text
A, B, C all see the same pre-batch public snapshot
```

Sequential:

```text
A result becomes visible to B
B result becomes visible to C
```

## UX

While the controller decides, Relay Web shows a non-message status such as:

```text
Lead is coordinating…
```

Do not require an extra visible lead-model turn before specialists start.

## Tests

- explicit targets still bypass controller.
- valid single/parallel/sequential/none decisions.
- unknown member rejected.
- trigger message must be accessible.
- malformed output failover.
- tool/permission event failover.
- timeout failover.
- max attempts fail cleanly.
- controller-selected members cannot mint human permission interaction.
- `none` only terminates without adding a fake controller message.

## Exit criterion

Unaddressed group tasks can coordinate across members without weakening routing or permission boundaries.

---

# 10. Phase 5 — Structured handoff and recovery

## Goal

Allow members to continue collaboration without relying on display-name parsing in generated text.

## New group primitive

```ts
group_send({
  to: botId,
  message,
  visibility: "public" | "private"
})
```

## Public handoff

- becomes a canonical group message;
- records sender/recipient IDs;
- becomes a trigger for the target;
- schedules next execution without ambiguous name parsing.

## Private handoff

- body visible only to sender/recipient server contexts;
- body excluded from shared transcript;
- optional public envelope contains no private body;
- can trigger the recipient.

## Recovery

- failed members quarantined for the current run;
- healthy parallel results preserved;
- replacements selected only from healthy members;
- recovery attempts serial after failed parallel primaries;
- lead may receive `unavailableMemberIds` and reorganize work;
- controller may choose another recovery owner if lead unavailable.

## Tests

- sender identity derived from runtime binding, not tool input.
- group member cannot send to a Bot outside the Group.
- public handoff appears once in transcript and triggers target.
- private body never appears in public transcript/context.
- failed member is not repeatedly scheduled.
- recovery owner receives accurate unavailable-member metadata.
- no infinite handoff loop beyond the group-run turn guard.

## Exit criterion

Group collaboration can evolve beyond one controller decision while preserving structured membership and visibility rules.

---

# 11. Phase 6 — Relay Web product completion

## Goal

Make Bots and Groups feel native rather than like diagnostic wrappers around hidden sessions.

## Navigation

Recommended sections:

```text
Bots
Groups
Sessions
```

Hidden Bot/group sessions stay out of ordinary Sessions presentation.

## Bot UI

- avatar/name/role;
- Agent/workspace/model/effort;
- instructions editor;
- enabled state;
- direct topics/conversation history;
- runtime activity indicators.

## Group UI

- member avatars;
- lead indicator;
- Topic selector/create/archive;
- member status;
- shared public transcript;
- tool/plan/subagent activity from existing turn presentation;
- planning/failure/limited status;
- edit membership/lead.

## Composer

Inside Group:

```text
@ => current members + everyone
```

Inside ordinary Session:

```text
@ => canonical Agent Messaging directory
```

These remain separate scopes.

## History/presentation

Conversation messages remain the public timeline authority. Member turn detail links/reuses existing session turn presentation so tools/reasoning are not duplicated into a new wire format.

## Exit criterion

A user can manage ordinary sessions, direct Bots and Groups without needing to understand hidden runtime sessions.

---

# 12. Phase 7 — External channel bindings

## Goal

Allow admitted external chats to target the same Bot/Conversation domain.

## Binding

```ts
{
  chatKey,
  conversationId,
  topicId?
}
```

## Candidate mappings

```text
Discord channel → Group
Discord thread  → Topic
Feishu group    → Group
DM              → direct Bot Conversation
```

## Rules

- channel access policy runs first;
- Conversation binding runs only after admission;
- external sender identity remains channel identity;
- text-only member mentions resolve only among current Group members;
- ambiguous display names fail closed;
- controller-selected downstream work retains non-human provenance.

## Exit criterion

Conversation semantics are proven independent from Relay Web.

---

# 13. Phase 8 — Advanced collaboration

These are optional follow-ons, not prerequisites for a correct first implementation.

Possible capabilities:

- group templates;
- default Bot sets per workspace;
- Topic search/retention policy;
- richer group controller policies;
- max parallelism per Group/Bot;
- manual “take over as lead” controls;
- cross-instance Bot membership where trust and persistence semantics are explicit;
- private-to-human Bot delivery;
- group analytics/usage summaries;
- resumable/retryable group runs;
- channel-specific Topic binding UX;
- group-level configurable completion policy.

Do not schedule advanced cross-account or federated groups until canonical membership, permission and transcript ownership rules are proven locally.

---

# 14. Suggested release slicing

A practical release sequence:

## Release A — Bots

Ships Phase 0 + Phase 1.

User value:

> reusable named assistants with stable direct conversations.

## Release B — Groups (Explicit)

Ships Phase 2 + Phase 3.

User value:

> put Bots in one shared Topic and explicitly address one or several members.

This is already a meaningful product without model-driven scheduling.

## Release C — Groups (Automatic)

Ships Phase 4.

User value:

> unaddressed tasks are automatically decomposed/routed among group members.

## Release D — Collaboration

Ships Phase 5 + most Phase 6.

User value:

> structured handoffs, recovery, richer native group UX.

## Release E — Channel Bindings

Ships Phase 7.

User value:

> external chat routes can become persistent Bot/Group conversations.

---

# 15. Quality gates for every release

Every release that changes the feature must pass:

```text
npm test
relevant focused unit suites
npx tsc --noEmit
Relay Web tests/build when protocol/UI changed
git diff --check
```

Additional required gates:

- state migration test from the prior released schema;
- no hard-coded security downgrade for group turns;
- deletion lifecycle test when hidden sessions are involved;
- exact origin/provenance assertions for every newly introduced turn producer;
- protocol backward-compatibility tests for optional DTO additions;
- no hidden session leakage into normal session lists unless intentionally requested.

---

# 16. Stop/go checkpoints

## After Phase 1

Ask:

- Is Bot identity stable and clearly separate from LogicalSession?
- Does profile editing work without context corruption?
- Is direct Bot chat compelling enough to keep the abstraction?

If not, stop before building Group behavior.

## After Phase 3

Ask:

- Is shared transcript persistence correct?
- Are Topic/session isolation rules proven?
- Does structured explicit routing work deterministically?
- Are permission interactions correct for explicit human member turns?

If not, do not add the controller.

## After Phase 4

Ask:

- Does automatic routing improve outcomes without excessive extra turns/tokens?
- Are `parallel` and `sequential` semantics predictable?
- Does controller failover terminate cleanly?
- Are non-human permission boundaries understandable to users?

Only then add richer automatic handoffs/recovery.

---

# 17. Final roadmap definition of done

The roadmap is complete when xacpx can demonstrate all of the following without special-case session alias logic:

1. A reusable Bot can participate in direct chat and multiple Groups.
2. Direct/Group/Topic contexts are isolated by distinct logical sessions.
3. A Group owns its own canonical transcript and Topics.
4. Explicit human member addressing is deterministic and permission-capable.
5. Unaddressed work is routed by a hidden, structured, tool-less controller.
6. Parallel/sequential modes have deterministic visibility semantics.
7. Structured handoffs preserve membership and visibility rules.
8. Member/controller failures recover or terminate cleanly.
9. Relay Web renders Bots/Groups as first-class product objects while reusing existing turn/tool presentation.
10. Existing Sessions, Agent Messaging and Task Orchestration retain their original semantics.
11. Topic/Group deletion leaves no orphan hidden runtime ownership.
12. The same Conversation domain can later be bound to non-Relay channels without redesigning its identity model.
