# xacpx Bots & Group Conversations — Design Spec

> **Status:** Proposed, revised after architecture review  
> **Date:** 2026-09-15  
> **Scope:** first-class Bot profiles, direct and group conversations, Topics, Runs, runtime/filesystem isolation, routing, permissions, persistence/recovery, Relay Web presentation, and future channel bindings  
> **Repository:** `gadzan/xacpx`

---

# 1. Summary

xacpx already has strong execution primitives:

- durable logical sessions;
- ACP-backed Agents;
- per-session turn queues and cancellation;
- streaming text, tools, thoughts, plans and usage;
- Agent Messaging for point-to-point peer delivery;
- Task Orchestration for bounded delegated work;
- Relay Web for live and historical session interaction;
- exact turn provenance for permission interaction routing.

This feature adds a conversation domain above those primitives. The design keeps identity, conversation history, one user request, one Bot execution, runtime identity and filesystem state as separate layers.

The primary user-facing concepts are:

1. **Bot** — a reusable named persona with runtime defaults, independent from a concrete logical session.
2. **Conversation** — a durable human-facing conversation containing one Bot or a group of Bots.
3. **Topic** — a transcript and runtime-context boundary inside a Conversation.
4. **Conversation Run** — the durable lifecycle of one user request and all collaboration caused by that request.
5. **Member Turn** — one Bot execution inside a Run.

The target architecture is:

```text
Human / channel / Relay Web
          │
          ▼
Conversation Service
  ├─ Bot profiles
  ├─ Conversations / Topics
  ├─ canonical public transcript
  ├─ Conversation Runs
  ├─ Conversation Router
  ├─ execution targets / workspace policy
  └─ runtime bindings
          │
          ▼
LogicalSession / TurnQueue
          │
          ▼
Agent / ACP runtime
```

The core separation rules are:

```text
Bot identity          != LogicalSession identity
Conversation          != chatKey
Topic                 != merged hidden session history
Message               != ConversationRun
ConversationRun       != MemberTurn
Model-context isolation != filesystem isolation
Explicit human target != automatic collaboration
Failure               != unknown side-effect state
Router                != persistent participant
```

A Group is not an Agent Messaging broadcast and is not an Orchestration Group.

---

# 2. Goals

## 2.1 Product goals

The complete feature should support:

- creating reusable Bots with stable identities;
- direct human ↔ Bot conversations;
- putting multiple Bots into one Group Conversation;
- Topics that reset conversation/runtime context without changing group membership;
- explicit target selection for one or more members;
- deterministic `@Bot` / `@everyone` shortcuts backed by structured member IDs;
- optional automatic collaboration through a restricted Router;
- single-member, parallel and sequential execution;
- a durable Run representing one user request;
- shared public transcript with sender attribution;
- isolated runtime context per Bot × Conversation × Topic;
- explicit workspace/filesystem execution policy per Topic;
- cancellation, retry and crash recovery with defined semantics;
- public structured member handoff;
- first-class Relay Web presentation;
- future binding of external channels to Conversations and Topics.

## 2.2 Architectural goals

- Reuse existing `LogicalSession`, TurnQueue, Agent, transport, permission and Relay primitives.
- Keep Bot identity independent of runtime identity.
- Keep Conversation and Group semantics separate from Agent Messaging and Task Orchestration.
- Make the daemon and Conversation store canonical; the browser is never the only owner of durable collaboration state.
- Preserve exact turn provenance through every dispatch.
- Make explicit human routing deterministic and never infer authorization from display names.
- Make automatic routing tool-free and permission-free before execution starts.
- Make deletion and teardown fail closed.
- Make crash recovery a defined contract rather than best-effort replay.
- Keep the domain independent from Relay Web and any one external channel.

---

# 3. Non-goals

This feature does **not** redefine:

- Agent Messaging as room/broadcast messaging;
- Task Orchestration as chat;
- `config.agents` as user-facing Bot personas;
- logical session aliases as Bot IDs;
- permission policy or transport security;
- cross-account trust semantics;
- ACP itself.

Initial releases do not require:

- cross-account shared groups;
- public internet group rooms;
- arbitrary third-party participants;
- voice/video group chat;
- private intra-group message secrecy guarantees;
- fully automatic concurrent source-code mutation in one shared working tree;
- model-driven routing on adapters that cannot prove tools are disabled before execution;
- automatic inheritance of human permission authority by downstream model-selected turns.

Private handoff is intentionally deferred. Preventing the private message body from entering the public transcript does not guarantee that the receiving model will not repeat that information in a later public response.

---

# 4. Ubiquitous language

## 4.1 Agent

An **Agent** is the runtime definition in `config.agents` that tells xacpx how an ACP-capable implementation is launched.

It answers:

> How is the runtime launched?

It does not answer:

> Who is this assistant in the product?

## 4.2 Logical Session

A **Logical Session** is xacpx's durable execution identity backed by a transport session. It owns runtime continuity, model/session settings and turn execution.

It remains an execution primitive, never the product identity for a Bot or Group.

## 4.3 Bot

A **Bot** is a stable user-facing profile independent from its current logical session.

The same Bot may participate in:

- its direct Conversation;
- multiple Groups;
- multiple Topics;
- future channel-bound Conversations.

The same Bot therefore may have many isolated logical sessions.

## 4.4 Conversation

A **Conversation** is the durable human-facing collaboration object.

Initial kinds:

```text
bot
  one Bot + human

group
  multiple Bots + human
```

## 4.5 Topic

A **Topic** is a public transcript boundary, runtime-context boundary and execution-target boundary inside a Conversation.

A new Topic keeps the Conversation membership/configuration but starts from a fresh Bot runtime context.

## 4.6 Conversation Run

A **Conversation Run** represents one user request and the complete collaboration caused by that request.

It answers:

- what is currently running;
- what the user should stop;
- what can be retried;
- what state must be reconstructed after restart;
- which Member Turns belong to this request;
- whether the outcome is completed, failed, cancelled or indeterminate.

A Topic initially allows only one active Run at a time. Later user requests for the same Topic queue behind the active Run unless the user creates a new Topic.

## 4.7 Member Turn

A **Member Turn** is one Bot execution inside a Run.

It references the underlying xacpx session turn and carries Conversation-specific metadata such as Run ID, Bot ID, batch, assignment and provenance.

## 4.8 Conversation Router

A **Conversation Router** is a restricted decision interface used only for automatic collaboration.

It is not a visible participant, not a Bot, and does not require a persistent conversational session. Its decision must be determined from explicit input supplied for the current Run.

---

# 5. Domain model

## 5.1 Bot profile

Target semantic shape:

```ts
export interface BotProfile {
  id: string;
  name: string;
  avatar?: string;

  /** Human-facing description. Never treated as trusted model instruction. */
  description?: string;

  /** Model-facing behavior guidance. */
  instructions?: string;

  /** Defaults used when a Conversation/Topic does not override execution target. */
  agent: string;
  workspace: string;
  cwd?: string;
  model?: string;
  effort?: string;

  enabled: boolean;
  profileRevision: number;
  createdAt: string;
  updatedAt: string;
}
```

The current implementation may still use the field name `role` for presentation metadata. Before the public API is frozen, either rename it to `description` or explicitly preserve the rule that presentation metadata is not injected into model prompts.

Bot runtime defaults do not grant security capabilities and must not override transport permission mode, channel admission, peer trust, filesystem/terminal capability gates or runtime fencing.

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

- `kind="bot"` requires exactly one Bot;
- `kind="group"` requires at least two Bots;
- `leadBotId`, when present, belongs to `botIds`;
- membership stores Bot IDs, never aliases.

## 5.3 Topic and execution target

```ts
export type WorkspaceIsolationPolicy =
  | "shared"
  | "shared-single-writer"
  | "worktree-per-member";

export interface ExecutionTarget {
  workspace: string;
  cwd?: string;
  isolation: WorkspaceIsolationPolicy;
}

export interface ConversationTopic {
  id: string;
  conversationId: string;
  title: string;
  status: "active" | "archived";
  executionTarget: ExecutionTarget;
  createdAt: string;
  updatedAt: string;
}
```

Bot `workspace` / `cwd` values are defaults. The effective task location belongs to the Topic so the same Bot can safely work in different projects without changing identity.

## 5.4 Conversation message

```ts
export interface ConversationMessage {
  id: string;
  conversationId: string;
  topicId: string;
  seq: number;

  role: "human" | "bot" | "system";
  senderBotId?: string;
  recipients?: string[];

  content: string;
  replyTo?: string;
  runId?: string;

  createdAt: string;
  sourceTurn?: {
    sessionAlias: string;
    turnId?: string;
  };
}
```

`seq` is monotonically increasing within a Topic and is the authoritative replay cursor. Timestamp is presentation metadata, not the only ordering primitive.

## 5.5 Conversation Run

```ts
export type ConversationRunState =
  | "queued"
  | "running"
  | "waiting-human"
  | "completed"
  | "failed"
  | "cancelled"
  | "indeterminate";

export type ConversationRunMode = "explicit" | "automatic";

export interface ConversationRun {
  id: string;
  conversationId: string;
  topicId: string;
  requestMessageId: string;
  requestId: string;

  mode: ConversationRunMode;
  state: ConversationRunState;

  completionReason?:
    | "members-completed"
    | "plan-completed"
    | "needs-input"
    | "human-cancelled"
    | "budget-exhausted"
    | "execution-failed"
    | "execution-state-unknown";

  generation: number;
  activeBatch?: number;
  maxMemberTurns: number;
  consumedMemberTurns: number;
  failedBotIds: string[];
  unavailableBotIds: string[];

  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}
```

`requestId` is caller-supplied idempotency identity scoped to the Conversation/Topic API. Retrying a timed-out request with the same `requestId` must not create a second Run.

## 5.6 Member Turn

```ts
export interface MemberTurnRecord {
  id: string;
  runId: string;
  conversationId: string;
  topicId: string;
  botId: string;

  sessionAlias: string;
  triggerMessageIds: string[];

  batch: number;
  assignmentId?: string;
  task?: string;
  expectedOutput?: string;
  attempt: number;

  origin:
    | "human-explicit"
    | "router"
    | "handoff"
    | "recovery";

  state:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "indeterminate";

  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}
```

`indeterminate` means xacpx cannot prove whether a side-effect-capable execution changed external state before interruption. Such work must not be blindly retried.

## 5.7 Runtime binding

```ts
export interface BotRuntimeBinding {
  id: string;
  scope: "bot-direct" | "group-member";
  conversationId: string;
  topicId: string;
  botId: string;

  logicalSessionId: string;
  sessionAlias: string;

  profileRevision: number;
  runtimeFingerprint: string;

  createdAt: string;
  updatedAt: string;
}
```

The runtime fingerprint covers execution-affecting configuration such as effective Agent, workspace and cwd. Model/effort may be applied at a turn boundary where the adapter supports that safely; Agent/workspace/cwd changes require rebind/recreate unless a verified migration primitive exists.

A Router does not require a `group-controller` binding in the target design.

---

# 6. Identity and isolation invariants

## 6.1 Runtime-context isolation

```text
Bot direct session
  != same Bot in any Group

Bot in Group A
  != same Bot in Group B

Bot in Topic A
  != same Bot in Topic B
```

Effective member key:

```text
conversationId × topicId × botId
```

No direct/private/other-Topic hidden history may leak into a Group Topic context.

## 6.2 Filesystem isolation is separate

Different logical sessions may still read/write the same working tree. Therefore:

```text
same transcript snapshot
!=
same filesystem snapshot
```

`parallel` is safe only when the execution target policy allows it.

Initial policy:

- `shared`: parallel execution is allowed only for operations proven non-mutating by enforced capability/tool policy; if xacpx cannot prove read-only behavior, treat the turn as potentially mutating.
- `shared-single-writer`: multiple readers may be planned, but side-effect-capable member turns execute serially. This is the recommended default for software work.
- `worktree-per-member`: future advanced mode; each member receives an isolated worktree and integration is an explicit later step.

Never infer read-only behavior from a Bot name such as `Reviewer` or `Tester`.

---

# 7. Bot configuration semantics

Bot edits must not be treated uniformly.

| Change | Required behavior |
|---|---|
| name / avatar / description | immediate presentation update; runtime identity unchanged |
| instructions | next ordinary turn uses new instructions; existing model history is not erased |
| model / effort | apply at turn boundary when supported; otherwise recreate/rebind |
| agent | recreate/rebind runtime (locked by any materialized runtime: direct or group-member) |
| workspace | recreate/rebind runtime, but only when the Bot default is actually consumed — direct sessions. Group Topics always carry an explicit workspace, so a Bot-default change never rebuilds existing member sessions |
| cwd | recreate/rebind runtime |
| reset context | create a new Topic or explicit reset operation |

Clearing `instructions` guarantees only that future prompt composition does not inject the old text. It does not guarantee that a persistent model session forgets instructions already present in historical context.

Every execution-affecting binding records the profile revision/fingerprint it was created against so stale runtime state is detectable rather than silently reused.

---

# 8. BotRuntimeManager

The daemon-side runtime manager resolves the logical session for one Bot execution scope.

Responsibilities:

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

  releaseTopicBindings(...): Promise<void>;
  releaseConversationBindings(...): Promise<void>;
}
```

It does not own provider process lifetime.

Hard invariants:

```text
one effective scope key
  => at most one authoritative binding
  => at most one authoritative owned logical session

failed creation
  => no half-published Conversation metadata

restart
  => binding/session relationship is recoverable without minting orphan runtimes
```

Runtime creation must not hold a non-reentrant shared daemon mutex across `SessionService` awaits. Use a scoped single-flight/reservation mechanism and a short publish transaction instead.

---

# 9. Conversation persistence and recovery

The Conversation store is not only transcript storage. It defines durable request/recovery semantics.

SQLite is preferred before Group execution ships because Run creation, message ordering and pending dispatch need transactional guarantees. Another backend is acceptable only if it provides the same contract.

Minimum store responsibilities:

```ts
interface ConversationStore {
  createRequest(input: {
    requestId: string;
    message: ConversationMessage;
    run: ConversationRun;
    dispatches: PendingDispatch[];
  }): Promise<{ message: ConversationMessage; run: ConversationRun }>;

  appendMessage(...): Promise<ConversationMessage>;
  createMemberTurn(...): Promise<MemberTurnRecord>;
  updateMemberTurn(...): Promise<void>;
  updateRun(...): Promise<void>;

  listMessages(input: {
    conversationId: string;
    topicId: string;
    afterSeq?: number;
    beforeSeq?: number;
    limit: number;
  }): Promise<ConversationMessage[]>;

  listEventsAfter(input: {
    conversationId: string;
    topicId: string;
    afterSeq: number;
    limit: number;
  }): Promise<ConversationEvent[]>;

  claimPendingDispatches(...): Promise<PendingDispatch[]>;
  deleteTopic(...): Promise<void>;
  deleteConversation(...): Promise<void>;
}
```

The following transitions must be durable:

```text
human message + Run + initial pending dispatch intent
  => one transaction

member visible result + MemberTurn terminal state + Run progress
  => one transaction where practical
```

Crash cases must be explicitly defined:

1. Message persisted, dispatch not started: dispatcher can resume from pending intent.
2. Dispatch started, completion not durably known: potentially side-effecting work becomes `indeterminate` unless the underlying execution primitive proves otherwise.
3. Result persisted, browser disconnected: reconnect by `seq` cursor, never by hoping WebSocket delivery was received.

Relay Web events are presentation transport. Durable Conversation state is authoritative.

---

# 10. Direct Bot flow

Direct Bot interaction uses the same Run model even though there is only one member.

```text
human submit
  → persist human message + explicit Run
  → resolve direct Bot binding
  → create MemberTurn(origin=human-explicit)
  → run normal xacpx turn
  → persist visible Bot result + terminal MemberTurn/Run
```

The underlying request preserves:

```text
origin = human
```

Streaming, tools, thoughts, plans, usage, cancellation and permission interactions reuse the existing turn execution path.

Direct Conversation history and deletion lifecycle must be implemented before the direct Bot UI is considered complete.

---

# 11. Explicit Group routing

Explicit human target selection is deterministic and never invokes the Router.

The preferred API is structured intent, not inferred text:

```ts
type ConversationTarget =
  | { mode: "members"; botIds: string[] }
  | { mode: "everyone" }
  | { mode: "automatic" };
```

Relay Web may also send mention ranges for highlighting, but IDs are the authority.

Examples:

```text
Reviewer
  → explicit Run with Reviewer only

Reviewer + Tester
  → explicit Run containing those members

Everyone
  → explicit Run containing every eligible current member
```

An explicit Run ends when the selected member turns reach terminal states. It does **not** automatically fall through into model-driven routing afterward.

`@Bot` / `@everyone` remain shortcuts that update the same structured target state.

---

# 12. Automatic collaboration and Router contract

Automatic collaboration is a different Run mode selected explicitly by the human.

```text
run.mode = automatic
```

The domain interface is:

```ts
interface ConversationRouter {
  decide(input: RoutingInput): Promise<RoutingDecision>;
}
```

A Router receives only explicit current input:

- bounded public Topic context;
- current human request;
- member IDs/descriptions/capabilities/availability;
- current Run state;
- completed/failed assignments;
- remaining budget;
- effective ExecutionTarget policy.

It must not depend on hidden conversational history from previous Router calls.

A model implementation may reuse a warm process for performance, but the semantic decision must be stateless with respect to prior Router decisions.

## 12.1 Decision shape

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
  | {
      type: "need-human";
      question: string;
    }
  | {
      type: "complete";
      reason: string;
      synthesisBotId?: string;
    };
```

There is no ambiguous `none` decision. The Router must say whether it wants to dispatch work, needs human input or considers the Run complete.

## 12.2 Router capability restriction

Automatic routing must be disabled unless the adapter can prove before execution that the Router has:

```text
no tools
no filesystem/terminal capability
no permission interaction
no Agent Messaging / Orchestration side effects
bounded structured output only
```

Detecting a tool event after it starts is not a security boundary and is insufficient.

The Router is not a persistent product participant and produces no visible assistant message.

---

# 13. Parallel and sequential semantics

## 13.1 Transcript semantics

For a `parallel` assignment batch, all primary members receive the same frozen public transcript snapshot.

```text
snapshot S
  ├─ A sees S
  ├─ B sees S
  └─ C sees S
```

Completion order must not change already-selected primary inputs.

For `sequential` assignments, later members may see earlier public results.

## 13.2 Filesystem semantics

Transcript parallelism does not automatically allow filesystem write parallelism.

Before dispatch:

```text
requested execution mode
+ Topic isolation policy
+ enforceable capability/effect classification
→ actual dispatch schedule
```

If xacpx cannot prove that a turn is non-mutating in a shared working tree, `shared-single-writer` serializes side-effect-capable turns even if the Router produced independent assignments.

---

# 14. Completion, cancellation and retry

## 14.1 Explicit Run completion

For `mode=explicit`:

```text
selected members terminal
→ Run terminal
```

No Router reevaluation occurs.

## 14.2 Automatic Run completion

For `mode=automatic`, the Router may continue only while the Run has unfinished planned work and budget remains.

The Run ends through an explicit condition:

- Router returns `complete`;
- Router returns `need-human` → `waiting-human`;
- all planned assignments complete according to the Run plan;
- human cancels;
- budget exhausts;
- unrecoverable failure;
- execution state becomes unknown and safe automatic recovery is not possible.

A maximum member-turn count is a guardrail, not a completion definition.

## 14.3 Cancellation

Cancel targets a `runId`, not a vague “latest group task”.

Cancellation:

- prevents new dispatches for that Run;
- asks active Member Turns to cancel using existing turn cancellation;
- records terminal/indeterminate outcome per active turn;
- ignores late results for scheduling decisions while retaining any durable evidence needed for audit/history.

## 14.4 Retry

Automatic retry is allowed only when the system can prove retry safety.

```text
queued/not-started
  → safe to redispatch

read-only execution with enforced capability
  → may retry under policy

started side-effect-capable execution with unknown outcome
  → indeterminate; no blind retry
```

---

# 15. Handoff

Initial collaboration supports **public structured handoff only**.

Recommended primitive:

```ts
group_send({
  to: string,
  task: string,
  expectedOutput?: string
})
```

The server derives sender Bot, Conversation, Topic and Run from the trusted runtime binding. The model cannot spoof sender identity or target a Bot outside current membership.

A public handoff:

- creates canonical Conversation-visible metadata/message as appropriate;
- creates or extends a Run assignment;
- preserves structured target identity;
- never grants human permission provenance.

Private handoff remains a future feature requiring its own information-flow threat model.

---

# 16. Permission provenance

The existing origin boundary remains authoritative.

| Producer | Turn provenance | Interactive human approval authority? |
|---|---|---|
| direct Bot request sent by human | `human` | yes, through existing exact routing |
| explicit Group member target sent by human | `human` | yes |
| Router decision | orchestration/internal | no |
| Router-selected Member Turn | `orchestration` | no |
| public handoff | `peer` or orchestration-equivalent | no |
| recovery | `orchestration` | no |
| scheduled work | `scheduled` | no |

A broad human request never upgrades all downstream automatic work to human authority.

If an automatic Member Turn is blocked because it needs human-origin permission, the UI may offer:

```text
[Start this step myself]
```

Clicking creates a **new** explicit human-origin request targeting that Bot and referencing the blocked step. The old automatic turn keeps its original provenance.

> Authority is never upgraded in place; the human creates a new authoritative turn.

---

# 17. Relay Web interaction model

## 17.1 Navigation

Recommended top-level sections:

```text
Bots
Groups
Sessions
```

Hidden Bot/group sessions do not appear as ordinary Sessions by default.

## 17.2 Group composer

Group input has an explicit target selector:

```text
Handle with: Reviewer ▾

Reviewer
Select members…
Everyone
Automatic collaboration
```

`@` remains a shortcut that updates structured target selection.

During the explicit-Group release, default target is the lead Bot so the user can send immediately without receiving an error telling them to mention someone.

Because the currently selected target is visible next to the send action, sending with that selection is explicit human intent.

## 17.3 Run card

Group activity is organized by Run rather than flattening every tool event into the public transcript.

```text
Check whether this change can ship

┌ Collaboration
│ Reviewer   completed · 2 blockers
│ Tester     running · View activity
│ Builder    waiting
│
│ 2 / 6 steps
│ [View activity] [Stop]
└
```

Each Member Turn can expand into the existing `TurnParts` presentation. The feature reuses current tool/thought/plan/subagent rendering instead of introducing a second execution renderer.

## 17.4 New Topic UX

Users see “New topic”, not internal session terminology.

Short explanation:

> A new topic keeps the members and settings but starts with fresh conversation context.

Topic archive, Run stop and Session sleep remain distinct operations.

## 17.5 Bot editor

Primary fields:

- name;
- description/responsibility;
- instructions;
- Agent;
- default workspace.

Advanced fields:

- avatar;
- cwd;
- model;
- effort.

Execution-affecting changes must explain whether a runtime will be recreated. Presentation metadata and model instructions must not be conflated.

---

# 18. Events and reconnect contract

Public APIs should be Run-aware.

Suggested events:

```text
bots-changed
conversations-changed
conversation-topic-changed
conversation-message
conversation-run-changed
member-turn-started
member-turn-finished
```

Existing underlying turn events remain associated through exact IDs rather than content/time inference.

Reconnect:

```text
client lastSeq=N
→ server returns canonical events/messages with seq > N
→ live subscription resumes after that cursor
```

A WebSocket disconnect must not create uncertainty about whether a message or completion exists durably.

---

# 19. Deletion and lifecycle

## 19.1 Bot deletion

Until full verified teardown exists, deletion fails closed when the Bot has:

- Group membership;
- a direct Conversation;
- a runtime binding;
- an owned hidden logical session.

Later lifecycle support may convert those rejections into explicit verified teardown.

## 19.2 Topic deletion

```text
mark deleting / reject new Runs
→ cancel or drain active Runs
→ verify hidden runtime release
→ remove runtime bindings
→ remove transcript / Run state
→ remove Topic metadata
```

Failure before verified release leaves enough durable state to retry cleanup.

## 19.3 Conversation deletion

Delete all Topics using the same verified lifecycle before Conversation metadata disappears.

---

# 20. External channel binding

Future binding shape:

```ts
interface ConversationBinding {
  chatKey: string;
  conversationId: string;
  topicId?: string;
}
```

Examples:

```text
Discord channel → Group Conversation
Discord thread  → Topic
Feishu group    → Group Conversation
DM              → direct Bot Conversation
```

Channel admission runs first. Binding never bypasses channel authorization.

Text-only mentions are only a fallback for current Group membership and ambiguous names fail closed.

---

# 21. Security invariants

The implementation must preserve all of the following:

1. Opaque IDs are canonical; names are presentation.
2. Clients cannot provide trusted Bot profile content, sender identity or provenance.
3. Router output is schema-validated.
4. Router has no tool/permission capability before execution begins.
5. Automatic work never inherits human permission authority.
6. Public transcript excludes direct/other-Topic hidden history.
7. Membership constrains every structured handoff/dispatch.
8. Hidden sessions do not bypass normal transport/session safety.
9. Filesystem parallelism requires an explicit enforceable policy.
10. `indeterminate` work is not silently retried.
11. Deletion never removes ownership records before verified runtime release.
12. External bindings occur only after channel admission.

---

# 22. Required tests

## Identity and persistence

- Bot ID stable across rename.
- Conversation/Topic/Run/MemberTurn IDs independent from display names.
- old state loads without new fields.
- malformed records fail according to existing state-store policy.
- runtime binding/session restore survives daemon restart.
- concurrent get-or-create does not leave orphan owned sessions.

## Context isolation

- direct vs Group session inequality.
- Group A vs Group B inequality.
- Topic A vs Topic B inequality.
- direct/private/other-Topic history excluded from context.
- clearing instructions affects future prompt composition but does not claim historical forgetting.

## Runtime configuration

- name/avatar/description edit does not recreate runtime.
- Agent/workspace/cwd change cannot silently reuse old execution environment.
- model/effort follow adapter turn-boundary/recreate policy.
- stale runtime fingerprint is detected.

## Run lifecycle

- one human request creates one idempotent Run.
- Topic has at most one active Run initially.
- later same-Topic request queues.
- cancel targets exact Run.
- restart with pending dispatch resumes once.
- persisted result replays by seq after reconnect.
- unknown side-effect completion becomes `indeterminate`.
- no automatic retry for indeterminate write-capable work.

## Explicit routing

- explicit target bypasses Router.
- multi-target IDs deduplicate.
- unknown/non-member target rejects.
- explicit Run ends after selected members terminal.
- no surprise automatic continuation.

## Automatic routing

- Router receives only explicit bounded input.
- Router cannot invoke tools before decision validation.
- unsupported adapter disables automatic mode.
- malformed/unknown member decisions reject/fail over according to policy.
- `need-human` and `complete` are explicit states.
- assignment task/expectedOutput/dependencies preserved.
- turn budget prevents loops but is not treated as normal completion.

## Filesystem policy

- shared-single-writer serializes side-effect-capable Member Turns.
- read-only parallelism requires enforced capability classification.
- transcript frozen-snapshot tests remain independent from filesystem scheduling.

## Permission provenance

- direct and explicit human turns can use normal permission interaction.
- Router-selected/handoff/recovery turns cannot mint human approval routing.
- “Start this step myself” creates a new human-origin request rather than mutating origin.

## UI / presentation

- target selector sends structured intent.
- Run card aggregates Member Turns.
- expanded activity reuses TurnParts.
- reconnect by seq converges history/live state.
- hidden runtime sessions remain absent from normal Sessions navigation.

---

# 23. Implementation invariants

The feature is ready to expand only while these remain true:

```text
Bot != session
Conversation != transport/chat route
Topic = public context + runtime context + execution target boundary
Message != Run
Run != MemberTurn
Router != participant
Transcript snapshot != filesystem snapshot
Explicit human execution != automatic collaboration
failed != indeterminate
profile edit != silent runtime drift
permission provenance is never upgraded in place
```

These invariants are more important than preserving any provisional class name or PR boundary.

---

# 24. End-to-end acceptance scenario

A representative mature flow:

1. User creates `Reviewer`, `Builder`, `Tester` Bots.
2. User creates Group `Release Team` with `Reviewer` as lead.
3. Default Topic inherits an explicit `ExecutionTarget` for the xacpx workspace using `shared-single-writer`.
4. Composer visibly defaults to `Reviewer`.
5. User asks Reviewer to inspect a change. An explicit Run is created and ends when Reviewer completes.
6. User switches to “Automatic collaboration” and asks whether the change can ship.
7. Human message, Run and initial dispatch intent are committed atomically.
8. Stateless Router returns assignments with concrete `task` / `expectedOutput` fields.
9. Read-only Reviewer/Tester work may run in parallel if capability policy proves it is non-mutating; write-capable work is serialized in the shared tree.
10. Run card shows member progress while detailed tool activity remains expandable through existing TurnParts.
11. A downstream automatic Builder step requires human-origin permission. It stays blocked with orchestration provenance.
12. User clicks “Start this step myself”; xacpx creates a new explicit human-origin request instead of changing the old turn origin.
13. Browser disconnects and reconnects using Topic `seq`; persisted messages/Run progress replay without duplication.
14. If a write-capable process disappears after starting and completion cannot be proven, the Member Turn and Run enter an indeterminate/recovery state rather than automatically repeating the mutation.
15. User creates a new Topic for an unrelated task. Membership and settings remain, while Bot runtime context starts fresh.

This is the target user experience: choose assistants, choose a topic, choose who handles the request, and manage one durable collaboration Run without needing to understand hidden sessions.
