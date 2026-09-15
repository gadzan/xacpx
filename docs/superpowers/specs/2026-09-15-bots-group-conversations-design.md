# xacpx Bots & Group Conversations — Design Spec

> **Status:** Proposed  
> **Date:** 2026-09-15  
> **Scope:** first-class Bot profiles, direct Bot conversations, multi-Bot group conversations, Topics, runtime/session isolation, routing, permissions, persistence, Relay Web presentation, and future channel bindings  
> **Repository:** `gadzan/xacpx`

---

# 1. Summary

xacpx already has strong execution primitives:

- durable logical sessions;
- multiple ACP-backed Agents;
- per-session turn queues and cancellation;
- streaming text, tool, thought, plan and usage side channels;
- Agent Messaging for point-to-point peer delivery;
- Task Orchestration for bounded delegated work;
- Relay Web for live and historical session interaction;
- explicit turn provenance for permission interaction routing.

What it does not yet have is a first-class conversation domain above those execution primitives.

This spec adds two new user-facing concepts:

1. **Bot** — a reusable, named persona with runtime defaults, independent from a concrete logical session.
2. **Conversation** — a durable human-facing conversation that may contain one Bot or a group of Bots, optionally split into Topics.

A group conversation is not a broadcast channel and is not an Orchestration Group. It owns a shared transcript and uses isolated logical sessions for each participating Bot. An invisible controller decides which Bot or Bots should act when the human did not explicitly address members.

The target architecture is:

```text
Human / channel / Relay Web
          │
          ▼
Conversation Service
  ├─ Bot profiles
  ├─ Topics
  ├─ shared transcript
  ├─ group router/controller
  └─ runtime bindings
          │
          ▼
LogicalSession / TurnQueue
          │
          ▼
Agent / ACP runtime
```

The central invariant is:

> **Conversation identity and runtime session identity are different layers.**

A Bot is not a `LogicalSession`. A Group is not an Agent Messaging broadcast. A Group Topic is not reconstructed by merging hidden session histories.

---

# 2. Goals

## 2.1 Product goals

The complete feature should support:

- creating reusable Bots with a stable identity;
- assigning a Bot an Agent, workspace, model, effort and instructions;
- direct human ↔ Bot conversations;
- putting multiple Bots into one group conversation;
- choosing a stable lead Bot for an unaddressed group task;
- explicit `@Bot` and `@everyone` routing;
- automatic routing for unaddressed requests;
- single-member, parallel and sequential group work;
- shared public transcript with sender attribution;
- independent Topics inside a group;
- isolated runtime context per Bot × conversation × Topic;
- public and private intra-group handoff semantics;
- graceful member/controller failure handling;
- first-class Relay Web presentation;
- future binding of Discord/Feishu/other channel chats or threads to a Conversation/Topic.

## 2.2 Architectural goals

- Reuse existing `LogicalSession`, TurnQueue, Agent, transport, permission and Relay primitives.
- Keep Bot identity independent of provider/runtime identity.
- Keep Group Conversation separate from Agent Messaging and Task Orchestration.
- Make the daemon the canonical owner of Conversation state and transcript.
- Keep group routing deterministic where the human supplied an explicit recipient.
- Use structured server-trusted identities for routing whenever the client can provide them.
- Preserve exact turn provenance through all group dispatches.
- Make deletion and teardown fail closed rather than leaving hidden orphan sessions.
- Allow the first implementation to be Relay-Web-first without coupling the domain model to Relay.

---

# 3. Non-goals

This feature does **not** redefine:

- Agent Messaging as room/broadcast messaging;
- Task Orchestration as chat;
- `config.agents` as user-facing Bot personas;
- logical session aliases as Bot IDs;
- permission policy or transport security;
- cross-account trust semantics;
- provider-specific multi-agent features;
- ACP itself.

Initial phases do not need:

- cross-account shared groups;
- public internet group rooms;
- durable offline group mail to disconnected remote accounts;
- arbitrary third-party participants;
- voice/video group chat;
- hidden controller tool execution;
- automatic inheritance of human permission authority by model-selected members.

---

# 4. Ubiquitous language

## 4.1 Agent

An **Agent** is the runtime definition in `config.agents` that tells xacpx how to start and configure an ACP-capable implementation.

Examples:

```text
codex
claude
opencode
```

Agent answers:

> How is this runtime launched?

It does not answer:

> Who is this assistant in the product?

## 4.2 Logical Session

A **Logical Session** is xacpx's durable execution identity backed by a transport session. It owns runtime continuity, model/session settings and turn execution.

It remains the execution primitive used by Bot conversations.

## 4.3 Bot

A **Bot** is a stable user-facing profile independent from its current runtime session.

A Bot may participate in:

- its direct conversation;
- multiple groups;
- multiple Topics;
- future channel-bound conversations.

The same Bot therefore may have many isolated logical sessions.

## 4.4 Conversation

A **Conversation** is the durable human-facing collaboration object.

Two initial kinds exist:

```text
bot
  one Bot + human

group
  multiple Bots + human
```

## 4.5 Topic

A **Topic** is a transcript and runtime-isolation boundary inside a Conversation.

Group work that belongs to unrelated tasks should use separate Topics instead of one indefinite shared transcript.

## 4.6 Group Controller

A **Group Controller** is a hidden coordination session used only when routing cannot be determined directly from structured human addressing.

It chooses an execution mode and member IDs. Its output is not a visible participant message.

## 4.7 Group Turn

A **Group Turn** is one member execution caused by a human message, controller decision, handoff or recovery decision.

It references the underlying xacpx logical-session turn but carries Conversation-specific metadata such as `triggerMessageIds` and `botId`.

---

# 5. Domain model

## 5.1 Bot profile

Recommended core shape:

```ts
export interface BotProfile {
  id: string;                  // stable opaque id, e.g. bot_01K...
  name: string;
  avatar?: string;

  /** Human-facing role/summary. */
  role?: string;

  /** Model-facing behavior and responsibility guidance. */
  instructions?: string;

  /** Runtime defaults. */
  agent: string;               // key in config.agents
  workspace: string;
  cwd?: string;
  model?: string;
  effort?: string;

  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
```

`role` and `instructions` are intentionally separate:

- `role` is presentation metadata;
- `instructions` affects model behavior.

A Bot profile must not override security-sensitive daemon configuration such as:

- transport permission mode;
- channel owner IDs;
- peer trust;
- media roots;
- filesystem/terminal capability gates;
- runtime fencing or worker policy.

## 5.2 Conversation record

```ts
export interface ConversationRecord {
  id: string;
  kind: "bot" | "group";
  title: string;
  description?: string;

  botIds: string[];
  leadBotId?: string;

  createdAt: string;
  updatedAt: string;
}
```

Invariants:

- `kind="bot"` requires exactly one Bot.
- `kind="group"` requires at least two Bots.
- `leadBotId`, when present, must belong to `botIds`.
- Group membership stores Bot IDs, never session aliases.

## 5.3 Topic

```ts
export interface ConversationTopic {
  id: string;
  conversationId: string;
  title: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}
```

Every Conversation has at least one logical Topic. A default Topic may be created eagerly with the Conversation or lazily on first message.

## 5.4 Conversation message

```ts
export interface ConversationMessage {
  id: string;
  conversationId: string;
  topicId: string;

  role: "human" | "bot" | "system";
  senderBotId?: string;
  recipients?: string[];

  content: string;
  replyTo?: string;

  createdAt: string;

  /** Optional reference back to an executed xacpx turn. */
  sourceTurn?: {
    sessionAlias: string;
    turnId?: string;
  };
}
```

The Conversation store is the canonical source for public group transcript ordering and attribution.

Do not reconstruct a Group transcript by merging hidden member session histories.

## 5.5 Group turn record

```ts
export interface GroupTurnRecord {
  id: string;
  conversationId: string;
  topicId: string;
  botId: string;

  sessionAlias: string;
  triggerMessageIds: string[];

  origin:
    | "human-explicit"
    | "controller"
    | "handoff"
    | "recovery";

  state:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled";

  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}
```

## 5.6 Runtime binding

```ts
export interface BotRuntimeBinding {
  id: string;

  scope:
    | "bot-direct"
    | "group-member"
    | "group-controller";

  conversationId: string;
  topicId: string;
  botId?: string;

  logicalSessionId: string;
  sessionAlias: string;

  createdAt: string;
  updatedAt: string;
}
```

The binding is the authoritative mapping from Conversation domain identity to xacpx execution identity.

Session aliases may remain readable for debugging, but domain correctness must never depend on parsing an alias string.

---

# 6. Session isolation invariants

The following must be enforced by code and tests:

```text
Bot direct session
  != same Bot in any Group

Bot in Group A
  != same Bot in Group B

Bot in Topic A
  != same Bot in Topic B

Group controller
  != lead Bot member session
```

For a group member the effective isolation key is:

```text
conversationId × topicId × botId
```

For a controller:

```text
conversationId × topicId × controller
```

This prevents private/direct context from leaking into shared group context and prevents unrelated group tasks from sharing hidden model state.

---

# 7. Bot runtime behavior

## 7.1 BotRuntimeManager

Add a daemon-side service responsible for resolving or creating the correct logical session for a Bot execution scope.

Suggested responsibilities:

```ts
interface BotRuntimeManager {
  getOrCreateDirectSession(input: {
    botId: string;
    conversationId: string;
    topicId: string;
  }): Promise<BotRuntimeBinding>;

  getOrCreateGroupMemberSession(input: {
    botId: string;
    conversationId: string;
    topicId: string;
  }): Promise<BotRuntimeBinding>;

  getOrCreateGroupControllerSession(input: {
    conversationId: string;
    topicId: string;
    coordinatorBotId: string;
  }): Promise<BotRuntimeBinding>;

  releaseTopicBindings(...): Promise<void>;
  releaseConversationBindings(...): Promise<void>;
}
```

It does **not** own provider processes. Process warmth and restore remain the responsibility of existing session/transport infrastructure.

## 7.2 Bot profile injection

Bot identity/instructions should be added by a server-owned prompt composition layer on every ordinary Bot turn.

Reasons:

- profile edits should take effect on the next turn;
- clearing instructions should not require a new logical session;
- the client must not be trusted to supply the authoritative Bot profile;
- the underlying runtime/model must remain accurately identifiable.

Runtime commands that must remain whole-input commands must not be broken by profile composition.

The profile may state name, role and instructions, but must explicitly avoid implying changes to model, tools or permissions.

---

# 8. Conversation store

Conversation metadata may live in normal xacpx durable state initially, but message history should use a storage abstraction rather than growing the main state JSON without bound.

Recommended interface:

```ts
interface ConversationStore {
  appendMessage(message: ConversationMessage): Promise<void>;
  appendTurn(turn: GroupTurnRecord): Promise<void>;
  updateTurn(turnId: string, patch: Partial<GroupTurnRecord>): Promise<void>;

  listMessages(input: {
    conversationId: string;
    topicId: string;
    before?: string;
    limit: number;
  }): Promise<ConversationMessage[]>;

  getContextWindow(input: {
    conversationId: string;
    topicId: string;
    triggerMessageIds?: string[];
    budget: number;
  }): Promise<ConversationMessage[]>;

  deleteTopic(conversationId: string, topicId: string): Promise<void>;
  deleteConversation(conversationId: string): Promise<void>;
}
```

A first implementation may use local JSONL files. SQLite is also acceptable. The domain API must prevent storage choice from leaking into Group routing logic.

The daemon is the canonical owner. Relay Hub history is presentation/storage for Relay, not the source of truth required to continue group coordination.

---

# 9. Direct Bot conversation flow

Direct Bot conversation is intentionally simple:

```text
human message
   │
   ▼
Conversation(kind=bot)
   │
   ▼
resolve BotRuntimeBinding
   │
   ▼
normal xacpx turn
   │
   ├─ stream text/tools/thought/plan/usage
   └─ normal human permission interaction
```

The turn uses:

```text
origin = human
```

All current exact-turn permission routing behavior remains available.

Direct Bot chat therefore gains existing xacpx behavior rather than implementing a second chat engine.

---

# 10. Group routing

## 10.1 Explicit addressing first

When the human supplied structured member targets, routing is deterministic and bypasses the controller.

Examples:

```text
@Reviewer check this change
  → single Reviewer turn

@Reviewer @Tester check this
  → parallel Reviewer + Tester turns

@everyone review this
  → parallel all eligible members
```

Relay Web should send opaque member IDs as structured metadata. The display name is not canonical routing identity.

Text-only channels may use a conservative name parser as a fallback, but the result must resolve to exact current membership before execution.

## 10.2 Unaddressed work

When no explicit target exists, the hidden controller receives bounded shared context and returns a structured decision.

```ts
export interface GroupDecision {
  mode: "none" | "single" | "parallel" | "sequential";
  memberIds: string[];
  triggerMessageIds: string[];
}
```

Semantics:

```text
none
  no more member execution is required

single
  run exactly one member

parallel
  run independent members against the same transcript snapshot

sequential
  run ordered members, where later members observe earlier results
```

The transport layer validates the decision. It never guesses a missing recipient or repairs an unknown member name.

---

# 11. Parallel and sequential semantics

These modes are execution contracts, not display hints.

## 11.1 Parallel

All primary members in one batch receive the same public transcript snapshot and trigger set.

```text
snapshot S
  ├─ A sees S
  ├─ B sees S
  └─ C sees S
```

A fast reply from A must not leak into B's already-selected parallel context.

Results are appended to the canonical Conversation transcript as they complete, but the batch execution input remains stable.

## 11.2 Sequential

Each later member receives transcript state after earlier selected members have completed.

```text
S
↓ A
S + A
↓ B
S + A + B
↓ C
```

A sequential member may also receive explicit handoff trigger IDs created by earlier members.

---

# 12. Controller contract

## 12.1 Controller identity

The controller has an isolated logical session per Conversation Topic.

It may reuse the lead Bot's runtime defaults:

- Agent;
- model;
- effort;
- workspace/cwd where appropriate.

It does not reuse the lead Bot member session.

## 12.2 Controller capability restrictions

The controller performs a coordination decision only.

Hard restrictions:

- no tools;
- no permission requests;
- no Agent Messaging;
- no Task Orchestration;
- no visible user reply;
- bounded structured output only.

Any tool or permission event is a controller failure, not a request to surface approval UI.

## 12.3 Initial limits

Recommended initial guards:

```text
per-decision timeout      30 seconds
controller candidates     max 3
conversation turn guard   24 member turns
controller output limit   16 KiB
```

These are safety/availability guards and may be tuned later from telemetry.

## 12.4 Controller failover

Preferred candidate order:

1. current lead Bot;
2. remaining healthy group members in stable order;
3. at most three attempts total.

A controller candidate that times out, emits invalid output, calls a tool, requests permission or otherwise violates the contract is quarantined as a controller candidate for the current run.

The Conversation does not silently change its saved `leadBotId` because of a transient failover.

---

# 13. Shared group context

Each member turn gets a server-built group context containing only data in the current Conversation Topic plus member/group profile metadata.

It must not include:

- the Bot's direct-chat transcript;
- another Group transcript;
- another Topic transcript;
- controller private history;
- unrelated logical-session history.

Recommended selection priority:

```text
P0 latest human request
P0 triggerMessageIds
P1 original request for the current group run
P2 recent explicit handoffs
P3 recent public transcript
P4 older public transcript if budget remains
```

Use model-aware token budgeting where available; use a conservative character fallback otherwise.

Every assistant/public message exposed to a member should retain stable sender identity metadata:

```ts
{
  id,
  role: "bot",
  senderBotId,
  recipients,
  content
}
```

Human transcript roles must never be interpreted as Bot names or mention targets.

---

# 14. Structured group handoff

Group collaboration should use a structured primitive rather than a magic text envelope.

Recommended internal/MCP capability:

```ts
group_send({
  to: string, // current-group Bot id
  message: string,
  visibility: "public" | "private"
})
```

The server derives from the bound session:

- source Bot;
- Conversation;
- Topic;
- current Group Turn.

The model does not provide a trusted sender identity.

## 14.1 Public handoff

A public handoff:

- creates a canonical Conversation message;
- records sender and recipient Bot IDs;
- becomes a trigger for the recipient;
- remains visible in group history.

## 14.2 Private handoff

A private handoff:

- stores body in a private group-delivery store;
- is readable only to sender/recipient and trusted server components;
- may expose a body-free public envelope such as “Reviewer sent a private note to Tester” if desired;
- may trigger the recipient;
- never enters the ordinary shared transcript body.

A future private delivery to the human may be delivered to the Bot's direct inbox, but that is not required for the first group phase.

## 14.3 Why this is separate from `agent_send`

`agent_send` is canonical point-to-point Agent Messaging and may target another reachable logical endpoint.

`group_send` has additional invariants:

- target must be a current member of the same Group Topic;
- group transcript/storage must be updated;
- visibility must be preserved;
- a `triggerMessageId` is created;
- scheduler state must be updated.

The implementation may reuse lower-level delivery/queue machinery, but the semantic API remains distinct.

---

# 15. Permission provenance

This is a security boundary.

xacpx currently distinguishes human, peer, orchestration and scheduled turn origins. Only an explicit human-origin turn may mint interactive permission routing.

Group conversations must preserve this behavior.

## 15.1 Human explicitly addresses a member

Example:

```text
@Reviewer run the migration and let me approve what you need
```

The selected member turn is:

```text
origin = human
GroupTurn.origin = human-explicit
```

It may use the normal exact-turn permission interaction path.

## 15.2 Hidden controller

Controller execution is:

```text
origin = orchestration
```

It may not request permission or call tools.

## 15.3 Controller-selected member

Example:

```text
Human: check whether this feature is ready
Controller selects Reviewer
```

The member turn is:

```text
origin = orchestration
GroupTurn.origin = controller
```

It must not inherit the initiating human's ability to mint a permission interaction simply because the original group message was human-authored.

If the selected Bot requires an unavailable interactive permission, the turn fails/blocks according to non-interactive policy and the Group can report or recover.

The human can then explicitly address the member in a later message to create a real human-origin turn.

## 15.4 Handoff/recovery

Bot-triggered handoff turns are `peer` or `orchestration` according to the final internal routing abstraction, but never `human` unless the human explicitly targeted that execution.

---

# 16. Group execution loop

Recommended high-level algorithm:

```text
persist human message
      │
      ▼
resolve explicit structured targets
      │
      ├─ targets found
      │     └─ direct single/parallel schedule
      │
      └─ no targets
            └─ controller decision
                    │
                    ▼
             execute batch/sequence
                    │
                    ▼
             persist public replies
                    │
                    ▼
             process handoffs
                    │
                    ├─ explicit next member(s)
                    │
                    └─ no handoff
                           ▼
                    controller reevaluate
                           │
                           ├─ more work
                           └─ none → finish
```

The controller is not called merely to confirm an explicit recipient supplied by the human.

---

# 17. Failure and recovery

## 17.1 Member failure quarantine

When a member turn fails during one group run:

- mark the failed Bot unavailable for that run;
- do not repeatedly reschedule it;
- preserve already completed results;
- allow other members to continue where safe.

## 17.2 Parallel failure handling

For a parallel batch:

1. launch the primary members against the same snapshot;
2. record healthy outcomes;
3. quarantine all failed primaries before selecting any replacements;
4. perform replacement/recovery serially so one healthy member session is not accidentally reused concurrently.

## 17.3 Recovery owner

If a member is unavailable, a healthy lead may receive a recovery turn with explicit `unavailableMemberIds`.

The recovery prompt must instruct it:

- do not claim unavailable members completed work;
- report useful status accurately;
- reorganize, reassign or finish missing work where possible.

If the lead itself is unavailable, the controller may select another healthy recovery owner.

## 17.4 Exhaustion

If no valid controller/member path remains, terminate the group run with an explicit failure result. Do not loop indefinitely.

---

# 18. Relay/control API

Names are provisional; the important point is to expose domain-level operations rather than session aliases as the product API.

## 18.1 Bot operations

```text
control.bots.list
control.bots.create
control.bots.update
control.bots.delete
```

## 18.2 Conversation operations

```text
control.conversations.list
control.conversations.create
control.conversations.update
control.conversations.delete
control.conversations.history
```

## 18.3 Topic operations

```text
control.topics.list
control.topics.create
control.topics.archive
control.topics.delete
```

## 18.4 Prompt/cancel

```text
control.conversation.prompt
control.conversation.cancel
```

The server resolves Bot/Group runtime bindings and does not require the client to know hidden session aliases.

---

# 19. Events

Candidate domain events:

```text
bots-changed
conversations-changed
conversation-topic-changed
conversation-message

group-planning
 group-turn-started
 group-turn-finished
 group-run-finished
 group-run-failed
```

For text/tools/thought/plan/usage generated by a member turn, prefer referencing/reusing the existing turn event/presentation contract rather than introducing a second parallel tool-event schema.

A `group-turn-started` event should include enough identity to join the existing session turn stream to:

- Conversation;
- Topic;
- Bot;
- GroupTurn.

---

# 20. Relay Web UX

Relay Web currently presents instance/session-centric chat. Bots/Groups should become an additional first-class navigation surface, not hidden session aliases in the normal session list.

Recommended navigation:

```text
Instance
  ├─ Bots
  │   ├─ Reviewer
  │   └─ Builder
  │
  ├─ Groups
  │   └─ Release Team
  │
  └─ Sessions
      ├─ backend
      └─ frontend
```

Hidden Bot/group logical sessions must not appear as normal user-created sessions unless a diagnostic mode explicitly exposes them.

## 20.1 Bot editor

Fields:

```text
Avatar
Name
Role
Instructions
Agent
Workspace
Working directory
Model
Effort
Enabled
```

## 20.2 Group editor

Fields:

```text
Name
Description
Members (minimum 2)
Lead member
```

## 20.3 Group composer mention scope

Inside a Group:

```text
@ = current Group members + @everyone
```

Inside an ordinary session:

```text
@ = existing Agent Messaging endpoint autocomplete
```

These scopes are intentionally different even if the visible UX uses the same `@` character.

Relay Web should send structured member IDs with ranges instead of requiring the server to resolve the display text again.

## 20.4 Group activity

The UI should expose per-member state where available:

```text
Reviewer · working
Tester   · running tests
Lead     · waiting
```

Because member turns reuse normal xacpx turn presentation, their tool/subagent/plan activity can use the existing renderer instead of a custom simplified log.

---

# 21. Channel bindings

The Conversation domain must not depend on Relay Web.

Future channels may bind an external route to a Conversation/Topic:

```ts
export interface ConversationBinding {
  chatKey: string;
  conversationId: string;
  topicId?: string;
}
```

Examples:

- Discord channel → Group Conversation;
- Discord thread → Group Topic;
- Feishu group → Group Conversation;
- direct channel route → direct Bot Conversation.

Inbound channel access policy remains a channel responsibility. Once admitted, the binding chooses the Conversation target.

External platforms without structured Bot mention IDs may use a conservative current-members-only parser. Ambiguous names must fail closed rather than guessing.

---

# 22. Relationship to Agent Messaging

Agent Messaging remains:

> one Agent/session sends a high-value point-to-point peer message to another reachable endpoint.

Group Conversation remains:

> a human-facing shared transcript with explicit membership, Topics, routing and scheduling.

They can reuse transport/queue concepts, but neither replaces the other.

Do not implement:

```text
Group = agent_send broadcast list
```

because that loses:

- canonical transcript ordering;
- group membership policy;
- Topic isolation;
- group-specific trigger IDs;
- controller scheduling;
- visibility semantics;
- recovery state.

---

# 23. Relationship to Task Orchestration

Task Orchestration remains a bounded work-ownership/lifecycle subsystem.

Group Conversation is a durable collaboration/conversation subsystem.

Do not reuse `OrchestrationGroupRecord` as the group-chat record. The two models have different lifecycle and completion semantics.

A future Bot may call Orchestration tools while acting in a **human-explicit** turn if normal capability/permission policy allows it. Controller-selected non-interactive turns must retain their non-human provenance.

---

# 24. Lifecycle and deletion

Deletion must be transactional/fail closed with respect to hidden runtime sessions.

## 24.1 Delete Topic

Recommended sequence:

```text
mark Topic deleting
→ stop/cancel/drain active group turns
→ verified release of controller/member bindings
→ remove bindings
→ delete/retire transcript data
→ delete Topic metadata
```

Do not delete Topic metadata first and then attempt best-effort session cleanup.

## 24.2 Delete Group

The same pattern applies across all Topics.

## 24.3 Delete Bot

If a Bot is currently referenced by Groups, initial behavior should reject deletion and return the referencing Groups, or require an explicit remove-from-groups flow first.

Do not silently mutate Group membership as a side effect of Bot deletion.

---

# 25. Security boundaries

Hard requirements:

1. Bot IDs are opaque server-owned identities.
2. User-visible Bot names are never authorization identities.
3. Clients cannot provide trusted Bot profile/system context.
4. Clients cannot claim a different sender Bot in `group_send`.
5. Controller output is schema-validated and membership-checked.
6. Controller cannot call tools or request permission.
7. Automatic member turns do not inherit human permission authority.
8. Private message bodies never enter public transcript/context.
9. Group membership changes immediately constrain future routing.
10. Hidden logical sessions cannot bypass normal runtime/session security policy.
11. Deletion cannot erase the durable binding before verified runtime release where release is required.
12. Future channel bindings must pass channel admission policy before Conversation routing.

---

# 26. Observability

Add structured logs/events around domain decisions without logging secrets or large message bodies.

Suggested event keys:

```text
bot.created
bot.updated
bot.deleted

conversation.created
conversation.deleted
conversation.topic_created

group.route.explicit
group.controller.started
group.controller.decided
group.controller.failed
group.turn.started
group.turn.finished
group.turn.failed
group.member.quarantined
group.run.finished

group.binding.created
group.binding.released
group.binding.release_failed
```

Useful structured fields:

```text
conversationId
topicId
botId
groupTurnId
mode
memberCount
origin
attempt
failureClass
```

Do not log full prompt bodies by default.

---

# 27. Compatibility and migration

This feature should be additive.

Existing:

- logical sessions;
- normal Relay session chat;
- channel chat contexts;
- Agent Messaging;
- Task Orchestration;
- scheduled tasks

continue to work without migration into Bot/Conversation objects.

Do not automatically convert every existing session into a Bot.

Bots are explicitly created product identities.

Hidden Bot/group sessions should use normal session storage and transport semantics while carrying an internal ownership marker/binding that lets ordinary session-list presentation exclude them.

---

# 28. Testing requirements

## 28.1 Identity/isolation

Required tests:

```text
same Bot + different Group      => different logical session
same Bot + different Topic      => different logical session
direct Bot + same Bot in Group  => different logical session
controller + lead member        => different logical session
restart                         => stable binding restored
```

## 28.2 Context

```text
direct private history never enters group context
another Group history never enters current context
another Topic history never enters current context
latest human message is retained
trigger messages are retained
sender attribution is retained
human role never becomes a Bot mention target
```

## 28.3 Routing

```text
structured @A        => A only, controller not called
structured @A @B     => parallel A+B
@everyone            => all eligible members
unaddressed           => controller
parallel              => identical input snapshot
sequential            => later member sees earlier result
unknown member id     => rejected
removed member        => rejected
```

## 28.4 Controller

```text
valid JSON decision           => accepted
unknown member                => rejected
inaccessible trigger id       => rejected
malformed output              => failover
controller tool event         => failover
controller permission event   => failover
controller timeout            => failover
max attempts exhausted        => clean group failure
```

## 28.5 Permission provenance

```text
human explicit @Bot
  => origin human
  => interactive permission can be minted

controller-selected Bot
  => non-human origin
  => no interactive permission mint

handoff/recovery turn
  => no accidental human origin
```

## 28.6 Failure/recovery

```text
one parallel member fails
  => healthy results remain valid

failed member
  => quarantined for current run

recovery owner
  => receives unavailableMemberIds

max turn guard
  => deterministic limited terminal state
```

## 28.7 Lifecycle

```text
delete referenced Bot
  => rejected or explicit remove required

delete Topic with running turn
  => active turn drained/cancelled before metadata removal

delete Group
  => no orphan runtime binding remains

release failure
  => domain deletion fails closed
```

---

# 29. Recommended source layout

Provisional layout:

```text
src/bots/
  bot-types.ts
  bot-service.ts
  bot-profile-prompt.ts
  bot-runtime-manager.ts

src/conversations/
  conversation-types.ts
  conversation-service.ts
  conversation-store.ts
  conversation-context.ts
  conversation-bindings.ts

src/groups/
  group-runtime.ts
  group-router.ts
  group-controller.ts
  group-decision.ts
  group-handoff.ts
  group-failover.ts

src/control/
  bot-control-service.ts
  conversation-control-service.ts

packages/relay-protocol/
  bot/conversation DTO additions

packages/relay-web/src/
  stores/bots.ts
  stores/conversations.ts
  components/BotDialog.vue
  components/GroupDialog.vue
  components/GroupHeader.vue
  components/GroupMessage.vue
  components/GroupMentionMenu.vue
  views/BotConversationView.vue
  views/GroupConversationView.vue
```

File placement may be adjusted during implementation, but domain boundaries should remain explicit.

---

# 30. Key invariants to preserve during implementation

The implementation is not complete if any of these are violated:

1. **Bot != AgentConfig.** AgentConfig launches a runtime; Bot is a reusable product identity.
2. **Bot != LogicalSession.** A Bot can own multiple isolated runtime sessions.
3. **Group != Orchestration Group.** Chat and delegated task lifecycle remain distinct.
4. **Group != Agent Messaging broadcast.** Shared transcript and routing are first-class.
5. **Direct context never leaks into Group context.**
6. **Topics isolate both transcript and runtime sessions.**
7. **Explicit human addressing bypasses the controller.**
8. **Parallel and sequential have deterministic, different visibility semantics.**
9. **Controller is hidden, structured and tool-less.**
10. **Automatic dispatch never silently upgrades to human permission authority.**
11. **Daemon owns canonical Conversation state.**
12. **Display names are not canonical identities.**
13. **Hidden sessions are execution details, not the product model.**
14. **Deletion verifies runtime cleanup before forgetting ownership.**

---

# 31. Acceptance criteria for the complete feature

A complete implementation should demonstrate the following end-to-end scenario:

1. User creates `Reviewer`, `Builder` and `Tester` Bots with different runtime defaults.
2. User talks directly to `Reviewer`; the direct conversation survives daemon/runtime restart.
3. User creates `Release Team` with all three Bots and `Reviewer` as lead.
4. Group Topic `PR 400` is created.
5. A direct `@Tester` message runs only Tester's group-member session and can use human permission interaction when required.
6. An unaddressed request invokes the hidden controller, which selects independent Reviewer/Tester work in parallel and Builder later in sequence.
7. Parallel members see the same starting transcript; Builder sees their completed public results.
8. No Bot's private direct-chat history appears in the Group prompt.
9. Automatic controller-selected turns cannot mint human permission interactions.
10. Tools and subagent activity display through existing Relay turn presentation.
11. A failed member is quarantined without discarding healthy results.
12. A new Topic creates isolated member/controller bindings and does not share the previous Topic's hidden runtime sessions.
13. Deleting the Topic releases all of its hidden bindings before its metadata disappears.
14. Existing ordinary sessions, Agent Messaging and Task Orchestration continue to behave unchanged.
