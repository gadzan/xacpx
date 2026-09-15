# xacpx Bots & Group Conversations — Phased Implementation Plan

> **Status:** Ready for implementation after design review  
> **Date:** 2026-09-15  
> **Design spec:** `docs/superpowers/specs/2026-09-15-bots-group-conversations-design.md`  
> **Roadmap:** `docs/superpowers/plans/2026-09-15-bots-group-conversations-roadmap.md`

---

# 1. Execution strategy

Implement this feature as a sequence of independently reviewable PRs. Each PR should establish one durable boundary and leave the repository in a coherent state.

Do **not** begin with the automatic group controller. The controller depends on identity, transcript, Topic isolation, runtime ownership and provenance semantics that must already be trustworthy.

Recommended merge order:

```text
PR 1  Domain/state foundations
PR 2  Bot CRUD + direct Bot runtime
PR 3  Relay protocol/control Bot surface
PR 4  Relay Web Bot UX
PR 5  Conversation/Topic store + lifecycle
PR 6  Explicit Group routing
PR 7  Group Relay Web UX
PR 8  Hidden controller
PR 9  Structured handoff + recovery
PR 10 Channel binding seam
```

PRs may be split further when review size becomes large. Do not collapse PRs 1–8 into one branch implementation.

---

# 2. Cross-cutting invariants

Every implementation PR must preserve:

```text
Bot identity            != logical session identity
Conversation identity   != chatKey
Group identity          != Orchestration Group identity
Group routing           != Agent Messaging broadcast
Topic                    = transcript + runtime isolation boundary
member display name     != canonical member identity
controller output        != visible chat message
controller/member auto   != human permission authority
```

Any proposed shortcut that violates one of these should be rejected even if it makes the first UI demo faster.

---

# 3. PR 1 — Domain and durable-state foundations

## Objective

Land the stable types, IDs, state shape, migration behavior and hidden-session ownership marker before adding product behavior.

## 3.1 Add domain modules

Create:

```text
src/bots/bot-types.ts
src/conversations/conversation-types.ts
src/conversations/conversation-store.ts
```

Initial types:

```ts
BotProfile
ConversationRecord
ConversationTopic
ConversationMessage
GroupTurnRecord
BotRuntimeBinding
```

Keep API fields aligned with the design spec. Avoid adding controller-only fields to the base Conversation record unless they are truly durable product state.

## 3.2 Extend AppState metadata

Update:

```text
src/state/types.ts
```

Recommended additive fields:

```ts
bots: Record<string, BotProfile>;
conversations: Record<string, ConversationRecord>;
conversation_topics: Record<string, ConversationTopic>;
bot_runtime_bindings: Record<string, BotRuntimeBinding>;
```

Do **not** store unbounded transcript bodies directly in `AppState`.

Update `createEmptyState()` with empty collections.

## 3.3 State parser/migration

Update the state validation/migration path in:

```text
src/state/state-store.ts
```

Requirements:

- old state with no Bot/Conversation fields loads successfully;
- missing collections migrate to empty collections;
- malformed new records are handled with the same inspect/report discipline used by existing state sections;
- migration is persisted before startup exposes the migrated state where current state-store semantics require durable migration.

Do not auto-create Bots from existing sessions.

## 3.4 Hidden-session ownership metadata

Add explicit ownership metadata to `LogicalSession` rather than encoding ownership in aliases.

Recommended shape:

```ts
interface LogicalSessionOwner {
  kind: "bot-direct" | "group-member" | "group-controller";
  bindingId: string;
}

interface LogicalSession {
  ...
  owner?: LogicalSessionOwner;
}
```

Naming may change during implementation, but the semantics should remain explicit.

Existing sessions have no owner and remain ordinary user sessions.

This marker will later allow session-list presentation to hide internal conversation sessions without parsing aliases.

## 3.5 ID factories

Add stable opaque ID creation for:

```text
bot
conversation
topic
conversation message
group turn
runtime binding
```

Prefer existing repository ID conventions/helpers where available. IDs must never derive from display names.

## 3.6 Tests

Update/add:

```text
tests/unit/state/state-store.test.ts
```

Add focused Bot/Conversation type/parser tests under a new suitable directory, for example:

```text
tests/unit/bots/
tests/unit/conversations/
```

Must cover:

- empty-state fields;
- migration from pre-feature state;
- malformed record handling;
- owner metadata round-trip;
- existing ordinary sessions remain ownerless;
- no generated ID collision in deterministic test fixture volume.

## 3.7 Validation

```text
npm test -- state-store focused suites
npx tsc --noEmit
git diff --check
```

## Explicitly out of scope

- Bot CRUD RPC;
- Relay UI;
- runtime session creation;
- Group execution;
- controller.

---

# 4. PR 2 — Bot service, profile prompt and direct runtime binding

## Objective

Create the first real Bot behavior without Relay protocol work yet.

## 4.1 BotService

Create:

```text
src/bots/bot-service.ts
```

Responsibilities:

```ts
listBots()
getBot(id)
createBot(input)
updateBot(id, patch)
deleteBot(id)
```

Validation:

- name non-empty and bounded;
- referenced Agent exists;
- referenced workspace exists;
- cwd policy follows existing workspace/session safety conventions;
- model/effort are preferences, not trusted capabilities;
- delete fails if the Bot is referenced by a Group once Groups exist.

For this PR, direct Conversation ownership may be created lazily.

## 4.2 Bot profile prompt composition

Create:

```text
src/bots/bot-profile-prompt.ts
```

Requirements:

- server uses durable `BotProfile`, never client-supplied trusted profile data;
- profile is refreshed every ordinary Bot turn;
- slash/runtime commands that require whole-input recognition remain unmodified;
- prompt explicitly distinguishes profile identity from underlying model/runtime/tool capability;
- empty optional fields do not generate stale persona instructions.

Provide pure-function unit tests.

## 4.3 BotRuntimeManager

Create:

```text
src/bots/bot-runtime-manager.ts
```

Implement direct scope first:

```ts
getOrCreateDirectSession({ botId, conversationId, topicId })
```

The manager should:

1. resolve the Bot profile;
2. look for a durable binding;
3. verify the bound logical session still exists and belongs to the binding;
4. if missing/stale, create a logical session using Bot runtime defaults;
5. persist session ownership and binding coherently;
6. return the binding.

Do not own queue-owner/process lifetime. Reuse existing session creation/transport machinery.

## 4.4 Direct Conversation bootstrap

Add an internal helper/service that ensures a direct Bot has a `ConversationRecord(kind="bot")` and default Topic.

Do not use Bot ID itself as Conversation ID; the two identities must remain separate even if the first release creates exactly one direct Conversation per Bot.

## 4.5 Execute direct Bot turn

Add a daemon-side method that:

```text
Bot + Conversation + Topic
→ resolve runtime binding
→ compose Bot profile
→ run normal turn
```

The request must preserve:

```text
origin = human
```

and reuse the ordinary turn execution path for:

- streaming;
- tools;
- thoughts;
- plans;
- usage;
- cancel;
- permission interactions.

Do not create a parallel Bot-specific transport stack.

## 4.6 Tests

Required:

- direct binding creation;
- binding reuse;
- binding survives Bot rename;
- Bot profile edit changes next composed turn;
- direct Bot session is not an ordinary pre-existing session;
- stale/missing binding repair is deterministic;
- direct Bot turn retains `origin=human`;
- slash/runtime command is not broken by profile composition;
- process/session restore delegates to existing session machinery.

## Validation

Run focused Bot/session/command tests plus full typecheck.

---

# 5. PR 3 — Control and Relay protocol surface for Bots

## Objective

Expose the Bot domain through server-owned APIs before building UI.

## 5.1 Relay protocol DTOs

Update:

```text
packages/relay-protocol/src/dtos.ts
```

or split into a dedicated Bot/Conversation DTO module if the existing file is already too broad.

Add DTOs for:

```text
BotSummaryDto
BotDetailDto
BotCreateInputDto
BotUpdateInputDto
BotConversationSummaryDto
BotPromptInputDto
```

Do not expose hidden session aliases unless explicitly required for diagnostics. Public UI identity is Bot/Conversation/Topic ID.

## 5.2 Control methods

Add methods such as:

```text
control.bots.list
control.bots.get
control.bots.create
control.bots.update
control.bots.delete
control.conversations.list
control.conversation.prompt
```

Exact naming should follow existing ControlService naming conventions.

## 5.3 Event signals

Add minimal change signals:

```text
bots-changed
conversations-changed
```

Direct Bot turns should continue using existing turn-output/tool/etc. events where possible. If the Web needs a join between Conversation identity and a hidden session turn, add explicit identity fields/event correlation rather than inferring by alias.

## 5.4 Ordinary session-list filtering

Update the authoritative session-list presentation path so hidden Bot-owned sessions do not appear as ordinary user sessions by default.

Rules:

```text
owner absent            => normal session list
owner bot/group         => hidden from ordinary product session list
explicit diagnostic API => may include
```

Do not delete them from canonical session state or discovery code that legitimately needs internal ownership.

## 5.5 Tests

- DTO compatibility.
- Bot CRUD RPC.
- prompt RPC selects Bot binding, not caller-supplied session alias.
- hidden Bot session absent from normal session list.
- old clients tolerate new optional events/fields.
- authorization remains at existing Relay/control account boundaries.

---

# 6. PR 4 — Relay Web direct Bot UX

## Objective

Ship direct Bots as a usable product surface before Group complexity.

## 6.1 Stores

Add:

```text
packages/relay-web/src/stores/bots.ts
packages/relay-web/src/stores/conversations.ts
```

Responsibilities:

- list/reload Bots;
- create/update/delete;
- select direct Bot Conversation/Topic;
- route prompt through Bot Conversation API;
- join live turn events to the selected Conversation.

## 6.2 Components/views

Add or adapt:

```text
BotDialog.vue
BotConversationView.vue
Bot identity/avatar component reuse
```

Navigation should visibly separate:

```text
Bots
Sessions
```

Do not pretend hidden session rows are Bots.

## 6.3 Bot editor

Initial fields:

```text
name
avatar
role
instructions
agent
workspace
cwd
model
effort
enabled
```

All new UI strings must update both Relay Web locales and pass existing i18n parity tests.

## 6.4 Chat presentation

Reuse existing:

- Markdown presentation;
- TurnParts;
- tool/subagent cards;
- permission UI;
- cancel behavior;
- usage/context UI where applicable.

Avoid a separate “Bot message renderer” for execution details.

## 6.5 Tests

- create/edit dialog validation;
- Bot list refresh on event;
- rename retains selected Bot by ID;
- direct prompt sends Bot/Conversation IDs, not hidden alias;
- live and history turn rendering;
- permission request in direct Bot conversation routes normally;
- ordinary session navigation unchanged.

---

# 7. PR 5 — Conversation store, Group/Topic metadata and lifecycle

## Objective

Land the persistent Group object and Topic lifecycle without automatic routing.

## 7.1 ConversationStore implementation

Create an implementation under:

```text
src/conversations/
```

Preferred requirement:

- append-only or transactional enough to preserve message order;
- pagination;
- bounded context-window query;
- crash-safe enough that a persisted public message is not silently reordered after restart.

The initial backend may be JSONL or SQLite. Pick one implementation in the PR and keep the interface stable.

## 7.2 ConversationService

Create/update:

```text
src/conversations/conversation-service.ts
```

Implement:

```text
create Group
update title/description
set membership
set lead
create Topic
archive Topic
delete Topic
delete Group
history query
```

Validation:

- Group min 2 members;
- all members exist/enabled according to product policy;
- lead belongs to membership;
- membership contains unique Bot IDs.

## 7.3 Group runtime binding methods

Extend `BotRuntimeManager`:

```ts
getOrCreateGroupMemberSession(...)
getOrCreateGroupControllerSession(...)
releaseTopicBindings(...)
releaseConversationBindings(...)
```

Controller binding exists structurally but is not executed until PR 8.

## 7.4 Safe teardown

Topic deletion sequence:

```text
mark deleting / reject new work
→ cancel/drain active Conversation turns
→ release hidden sessions through existing verified session teardown
→ only after release succeeds remove binding ownership
→ delete transcript/Topic metadata
```

A release failure must leave enough durable state to retry; do not orphan a runtime by deleting ownership first.

## 7.5 Bot deletion guard

Update BotService deletion:

- if referenced by any Group, reject with structured references;
- require explicit membership edit first.

## 7.6 Tests

- Group create validation;
- Topic isolation;
- direct vs group member binding inequality;
- Group A vs Group B inequality;
- Topic A vs Topic B inequality;
- controller vs lead-member inequality;
- Topic deletion order with injected release failure;
- Group deletion across multiple Topics;
- referenced Bot deletion rejection;
- store restart/pagination ordering.

---

# 8. PR 6 — Explicit Group routing and execution

## Objective

Deliver secure useful Group chat using only explicit human routing.

## 8.1 Structured mention input

Extend Relay/control prompt input with:

```ts
groupMentions?: Array<{
  range: [number, number];
  botId: string;
}>;
```

Keep ordinary existing `agentMentions` semantics unchanged for normal session collaboration.

Server rules:

- verify ranges are structurally valid;
- deduplicate Bot IDs;
- every target must be a current Group member;
- display text is not used as the authority.

Add a structured `everyone` form rather than requiring the literal text to be canonical if practical.

## 8.2 GroupRouter explicit path

Create:

```text
src/groups/group-router.ts
src/groups/group-runtime.ts
```

Behavior:

```text
one target    => single
many targets  => parallel
all           => parallel all eligible members
no target     => reject with “address a member” during this phase
```

No controller call yet.

## 8.3 Member context builder

Create:

```text
src/conversations/conversation-context.ts
```

Inputs:

- Bot profile;
- Group profile;
- Topic transcript;
- trigger message IDs;
- latest human message;
- budget.

Hard exclusion tests must prove direct/private/other-Topic history cannot enter.

## 8.4 Execution and provenance

For human explicit routing:

```text
ChatRequestMetadata.origin = human
GroupTurn.origin = human-explicit
```

Use the existing turn runner/queue path where possible.

Parallel members must receive the same frozen transcript snapshot.

## 8.5 Transcript append

Persist:

- human input before scheduling;
- visible Bot replies with sender Bot ID;
- final error/status system messages only when the product semantics need a public row.

Do not persist controller-like metadata because no controller exists in this PR.

## 8.6 Events

Add:

```text
group-turn-started
group-turn-finished
group-run-finished
group-run-failed
conversation-message
```

Correlate to the underlying session turn explicitly.

## 8.7 Tests

- single structured target;
- multi structured target;
- everyone;
- controller path not invoked;
- parallel frozen snapshot;
- member attribution;
- target not in Group rejected;
- duplicate name does not matter with Bot IDs;
- group session isolation;
- explicit human permission interaction works;
- cancellation stops active member work and prevents late transcript append after suppression semantics require it.

---

# 9. PR 7 — Relay Web Group and Topic UX

## Objective

Make explicit-routing Groups usable before controller automation.

## 9.1 Navigation

Add Group section alongside Bots/Sessions.

## 9.2 Group editor

Add:

```text
GroupDialog.vue
```

Capabilities:

- create Group;
- select at least two Bots;
- choose lead;
- edit membership;
- change lead;
- delete Group through lifecycle-aware API.

## 9.3 Topic UX

- Topic selector;
- create Topic;
- archive/delete Topic;
- switch Topic without mixing live buffers.

Live state keys must include Conversation + Topic identity, not only hidden session alias.

## 9.4 Group composer mention menu

Inside Group:

```text
@ → only current members + everyone
```

Output structured Bot IDs/ranges.

Do not use the existing full Agent Messaging endpoint directory for Group membership autocomplete.

## 9.5 Message presentation

Public group timeline shows:

```text
human message
Bot-attributed reply
Bot-attributed reply
```

Member execution detail may reuse the existing turn/tool presentation through explicit source-turn correlation.

## 9.6 Member activity

Minimum status:

```text
idle
planning
queued
working
failed
```

Do not fabricate progress from display text. Use group/turn events.

## 9.7 Tests

- Group/Topic selection isolation;
- mention menu only lists current membership;
- duplicate Bot display names remain distinguishable by stable UI metadata;
- live turn belongs to correct Topic after switching;
- hidden session does not appear under ordinary Sessions;
- i18n parity;
- history/live convergence.

---

# 10. PR 8 — Hidden automatic group controller

## Objective

Enable unaddressed Group requests after explicit routing and persistence are already proven.

## 10.1 Decision module

Create:

```text
src/groups/group-decision.ts
src/groups/group-controller.ts
```

Schema:

```ts
interface GroupDecision {
  mode: "none" | "single" | "parallel" | "sequential";
  memberIds: string[];
  triggerMessageIds: string[];
}
```

Validator requirements:

- object only;
- known mode;
- member list constraints by mode;
- every member currently belongs to Group;
- `none` requires empty members/triggers;
- non-`none` requires at least one trigger;
- trigger IDs must be visible/accessible to selected members;
- parallel member IDs unique;
- sequential may intentionally repeat a member later when consolidation requires it.

Do not infer or repair unknown output.

## 10.2 Controller prompt

The controller receives:

- Group name/description;
- lead profile;
- current member profiles;
- human identity label;
- bounded public transcript;
- completed Group turns;
- unavailable members;
- private delivery envelopes only, never private bodies.

Prompt contract:

```text
coordination only
choose mode/members/triggers
no tools
no user-facing prose
JSON only
```

## 10.3 Restricted runtime execution

Controller execution must fail if it emits:

- tool call;
- permission request;
- Agent Messaging action;
- unsupported structured event that implies side effects.

Use a dedicated capability-restricted path or event guard; do not rely only on prompt wording.

## 10.4 Controller provenance

Controller:

```text
origin = orchestration
```

Controller-selected members:

```text
origin = orchestration
GroupTurn.origin = controller
```

They do not mint interactive human permission requests.

## 10.5 Failover

Candidate order:

1. saved lead;
2. healthy members in stable order;
3. max three attempts.

Initial timeout:

```text
30 seconds / candidate
```

A transient failover does not mutate saved lead.

## 10.6 Run loop

Extend `GroupRuntime`:

```text
explicit target?
  yes → existing direct path
  no  → decide

execute selected work
append results
reevaluate when appropriate
stop on none / failure / cancellation / max turns
```

Initial hard guard:

```text
24 completed/scheduled member turns per group run
```

## 10.7 Parallel/sequential tests

Required race-sensitive tests:

- parallel members receive byte-for-byte equivalent transcript snapshot inputs;
- completion order cannot affect another primary's input;
- sequential B sees A result;
- repeated sequential member is allowed intentionally;
- controller does not run for explicit route;
- none ends without fake message;
- timeout/malformed/tool/permission failures fail over;
- max attempts terminates;
- auto-selected permission request fails non-interactively and does not create human approval UI.

---

# 11. PR 9 — Structured group handoff and recovery

## Objective

Support multi-step member-to-member collaboration without parsing model-generated `@name` text as a trusted route.

## 11.1 `group_send`

Add a group-bound structured tool/API.

Suggested input:

```ts
{
  to: string;
  message: string;
  visibility: "public" | "private";
}
```

No `from`, `conversationId` or `topicId` trusted input. Derive all from the current bound runtime/turn.

## 11.2 Authorization

Before admission:

- source binding exists;
- source Bot belongs to Group;
- target Bot belongs to same Group;
- target is not invalid/deleted/disabled under current policy;
- body within size limits;
- current Group run is active and not cancelled.

## 11.3 Public delivery

- append canonical Conversation message;
- sender/recipient IDs explicit;
- create trigger ID;
- schedule recipient according to run state;
- prevent duplicate scheduling within the same batch where already scheduled.

## 11.4 Private delivery

Create a dedicated store/type, for example:

```text
src/groups/group-private-messages.ts
```

Private body visibility:

```text
sender
recipient
trusted server controller envelope metadata only
```

Shared context never receives body.

## 11.5 Recovery

Create:

```text
src/groups/group-failover.ts
```

Rules:

- failed member quarantined for current run;
- parallel healthy outcomes recorded before recovery;
- failed parallel replacements run sequentially;
- one healthy logical session is never used concurrently for multiple recovery tasks;
- lead receives `unavailableMemberIds` when appropriate;
- if lead unavailable, controller may select healthy recovery owner;
- exhausted recovery terminates explicitly.

## 11.6 Tests

Include adversarial tests for:

- spoofed sender fields impossible/ignored;
- out-of-group recipient rejected;
- private body never in public transcript/controller body context/log event;
- duplicate delivery ID idempotency if transport can retry;
- handoff to already-scheduled member merges trigger IDs rather than double-runs;
- failed primary not rescheduled indefinitely;
- recovery session concurrency guard;
- cancellation while handoff queued;
- 24-turn guard still applies.

---

# 12. PR 10 — External channel binding seam

## Objective

Make the Conversation domain reusable outside Relay Web without yet forcing every channel to expose configuration UX.

## 12.1 Binding type/service

Add:

```ts
interface ConversationBinding {
  chatKey: string;
  conversationId: string;
  topicId?: string;
}
```

Service:

```text
bind
unbind
resolve by chatKey
validate target exists
```

## 12.2 Channel integration contract

After the channel admits a human message under its own access policy:

```text
chatKey
→ resolve Conversation binding
→ if bound: Conversation prompt path
→ otherwise: existing channel/session path
```

Do not let Conversation binding bypass channel `allowFrom`/owner/group policy.

## 12.3 Mention fallback

For channels that cannot send structured Bot IDs:

- parse only current Group member names;
- normalize conservatively;
- longest unambiguous match wins only where unambiguous;
- duplicate display names require explicit disambiguation/configuration;
- ignore mentions in code/link/email/quoted contexts where feasible;
- never search all xacpx Agent endpoints to resolve a Group member mention.

## 12.4 First channel target

Prefer the channel whose threading semantics make Topic mapping easiest and whose current implementation already has clear `chatKey`/delivery separation.

Keep actual channel rollout in a follow-up PR if it would make this seam PR large.

---

# 13. Data/storage implementation notes

## 13.1 Metadata vs transcript

Use existing durable state for bounded metadata:

```text
Bots
Conversations
Topics
Runtime bindings
```

Use `ConversationStore` for unbounded/bounded-retention history:

```text
messages
GroupTurn records
private delivery bodies if implemented
```

## 13.2 JSONL vs SQLite

Either is acceptable initially if these properties hold:

- daemon canonical ownership;
- deterministic ordering;
- pagination;
- restart safety;
- bounded context queries;
- Topic/Conversation deletion;
- future storage replacement behind interface.

If using JSONL, design compaction/retention and deletion semantics explicitly rather than assuming files remain tiny.

If using SQLite, keep schema migration isolated from Relay Hub's separate persistence concerns.

## 13.3 Message IDs

Message IDs must be stable before scheduling because controller/member decisions use `triggerMessageIds` as causal references.

Persist the human message before dispatch.

---

# 14. Turn execution integration notes

## 14.1 Prefer existing TurnQueue

Do not create a second concurrency scheduler for ACP session turns.

`GroupRuntime` decides **which member session** should run. Existing per-session TurnQueue decides **when that session turn** executes.

## 14.2 Group-run coordination state

The group layer still needs run-level state for:

- pending member selections;
- parallel batch snapshot;
- completed Group turns;
- unavailable members;
- cancellation;
- max-turn guard.

Keep that distinct from per-session TurnQueue state.

## 14.3 Exact correlation

Never correlate a GroupTurn to an ACP/session turn using:

- time proximity;
- content equality;
- display name;
- “latest turn in session”.

Carry stable correlation IDs through the turn request/event path.

---

# 15. Permission integration plan

Audit every new producer of a `ChatRequest`/turn request.

Expected matrix:

| Producer | origin | May mint interactive permission? |
|---|---|---:|
| Direct Bot human prompt | `human` | yes |
| Group explicit human target | `human` | yes |
| Group controller | `orchestration` | no |
| Controller-selected member | `orchestration` | no |
| Bot handoff | `peer` or `orchestration` | no |
| Recovery turn | `orchestration` | no |
| Scheduled future Conversation turn | `scheduled` | no |

Add exact tests at the session-handler/broker boundary, not only high-level UI tests.

Do not create a new “group-human” origin unless the existing four-way origin model is proven insufficient. Prefer mapping group producers into the current security semantics.

---

# 16. Relay Web implementation notes

## 16.1 State keys

Live buffers must not collide across Topics.

Use a canonical key such as:

```text
instanceId \0 conversationId \0 topicId
```

where Conversation UI state is concerned.

Underlying session turn buffers may still use session alias keys internally, but the UI selection/join layer must be Conversation-aware.

## 16.2 Turn presentation reuse

Keep the current turn presentation engine authoritative for ordered text/tool/reasoning/activity presentation.

Group public message card supplies:

- speaker identity;
- Conversation ordering;
- source-turn correlation.

The existing turn renderer supplies:

- streamed narrative;
- tool rows;
- subagent details;
- plan;
- error/final state.

Do not copy tool events into ConversationMessage bodies.

## 16.3 Hidden sessions

Hidden conversation-owned sessions should stay reachable to internal RPC/event systems but not appear as normal session tree rows.

Add explicit diagnostics later if operators need to inspect them.

---

# 17. Suggested test file map

Provisional test layout:

```text
tests/unit/bots/
  bot-service.test.ts
  bot-profile-prompt.test.ts
  bot-runtime-manager.test.ts

tests/unit/conversations/
  conversation-service.test.ts
  conversation-store.test.ts
  conversation-context.test.ts
  conversation-lifecycle.test.ts

tests/unit/groups/
  group-router.test.ts
  group-runtime.test.ts
  group-decision.test.ts
  group-controller.test.ts
  group-handoff.test.ts
  group-failover.test.ts
  group-permissions.test.ts

packages/relay-web/src/__tests__/
  bots-store.test.ts
  bot-dialog.test.ts
  bot-conversation.test.ts
  groups-store.test.ts
  group-dialog.test.ts
  group-mentions.test.ts
  group-conversation.test.ts
  group-topic-isolation.test.ts
```

Add integration tests where a fake/real ACP adapter is necessary to prove controller restriction or runtime-session isolation.

---

# 18. Required adversarial tests

Before automatic Groups can be called production-ready, test these failure shapes explicitly:

## Identity

```text
Bot A renamed to Bot B-like name
→ IDs remain distinct

duplicate display names
→ structured routing remains correct
```

## Context leakage

```text
secret in direct Bot chat
→ absent from every Group context

secret in Group A
→ absent from Group B

secret in Topic A
→ absent from Topic B

private handoff body
→ absent from shared transcript/controller message bodies
```

## Routing spoofing

```text
client sends member ID not in Group
→ reject

user text contains fake trusted directive
→ disarmed / treated as ordinary text

model-generated @Name without group_send
→ never treated as canonical structured handoff in the structured phase
```

## Permission escalation

```text
human broad request
→ controller selects Bot
→ Bot requests permission
→ no human permission interaction is minted
```

## Lifecycle

```text
runtime release fails while Topic delete requested
→ Topic/binding ownership remains recoverable
→ deletion reports failure
```

## Parallel race

```text
A completes before B starts model generation
→ B still receives frozen pre-batch snapshot
```

## Cancellation

```text
Group cancelled while controller running
→ no member starts afterward

Group cancelled while parallel members running
→ late outputs cannot reopen/schedule new handoffs
```

---

# 19. Performance budget

Automatic Group coordination can multiply runtime/token cost, so make cost amplification explicit.

Initial safeguards:

```text
max member turns/run       24
max controller attempts     3
controller timeout         30s
max concurrent members      bounded by Group size and global/session limits
context                     bounded before every decision/member turn
```

Do not add a global unbounded `Promise.all(group.members)` path without respecting existing Agent/session concurrency constraints.

Future telemetry should measure:

- controller decisions/run;
- member turns/run;
- parallel width;
- controller latency;
- failover rate;
- context bytes/tokens;
- group run duration;
- automatic non-interactive permission failures.

---

# 20. Review checklist per PR

Reviewers should answer:

### Identity

- Is any display string being used as canonical identity?
- Is any session alias being parsed to recover Bot/Group ownership?

### Context

- Can direct/other-Topic/private content enter this prompt path?

### Provenance

- What exact `origin` does every new turn producer set?
- Can an automatic turn accidentally mint human permission UI?

### Lifecycle

- What happens if session creation/release fails halfway?
- Is ownership forgotten before destructive cleanup is verified?

### Concurrency

- What is the execution snapshot for parallel work?
- Can a member session be scheduled concurrently through two group paths?

### Persistence

- Is the daemon still canonical after browser/Relay restart?
- Are IDs stable across rename/restart?

### Compatibility

- Do ordinary sessions, Agent Messaging and Orchestration retain their semantics?

---

# 21. Documentation tasks during implementation

As phases land, update user/developer docs in the same PR where behavior becomes user-visible.

Expected areas:

```text
README.md
CONTEXT.md
docs/code-wiki.md
docs/config-reference.md (only if config surface is added)
docs/relay-web-module.md
packages/docs/ site content where appropriate
```

Document terminology consistently:

```text
Agent        runtime definition
Bot          reusable profile
Session      execution context
Conversation human-facing durable chat
Topic        isolated conversation task/context
Group        multi-Bot Conversation
```

Avoid presenting hidden session aliases as public Bot identifiers.

---

# 22. First implementation recommendation

Start with PR 1 and PR 2 only.

A good first milestone branch should prove this end-to-end path:

```text
create Bot Reviewer
      │
      ▼
open direct Conversation
      │
      ▼
create/reuse Bot-owned LogicalSession
      │
      ▼
compose server-owned Bot profile
      │
      ▼
normal xacpx turn
      │
      ├─ streaming/tools
      ├─ permission interaction
      └─ durable session restore
```

Do not implement Group routing until that abstraction feels natural and does not require special casing inside the core transport.

---

# 23. Definition of implementation readiness

The design is ready to code when maintainers agree on five decisions:

1. **Metadata storage:** exact `AppState` fields and parser/migration rules.
2. **Transcript backend:** JSONL vs SQLite for the first `ConversationStore` implementation.
3. **Hidden-session ownership field:** exact `LogicalSession` owner shape/name.
4. **Control/Relay naming:** final public RPC/DTO names for Bot/Conversation operations.
5. **Permission mapping:** controller/member automatic turns remain `orchestration` (recommended) vs any new provenance type.

None of these choices require changing the core architectural boundaries in the companion design spec.

---

# 24. End-to-end completion checklist

The feature can be considered complete when all are true:

- [ ] Bots have stable opaque identities independent from runtime sessions.
- [ ] Direct Bot conversations reuse the ordinary xacpx execution path.
- [ ] Bot profile changes apply without leaking old profile state into new instructions.
- [ ] Groups and Topics are durable daemon-owned domain objects.
- [ ] Group transcript is canonical outside hidden session histories.
- [ ] Every Bot × Group × Topic execution context is isolated.
- [ ] Explicit human member addressing bypasses the controller.
- [ ] Structured member IDs are authoritative in Relay Web.
- [ ] Human explicit member turns retain exact human permission routing.
- [ ] Automatic controller/member turns cannot mint human permission interactions.
- [ ] Controller is isolated, structured, hidden and tool-less.
- [ ] Single/parallel/sequential/none semantics are validated.
- [ ] Parallel primary inputs are snapshot-stable.
- [ ] Sequential later members see prior selected results.
- [ ] Structured public/private handoff is membership-scoped.
- [ ] Private bodies cannot leak into public context.
- [ ] Member failure quarantine/recovery terminates safely.
- [ ] Group cancellation prevents late scheduling.
- [ ] Topic/Group deletion verifies hidden runtime cleanup before forgetting ownership.
- [ ] Relay Web exposes Bots/Groups separately from ordinary Sessions.
- [ ] Existing Agent Messaging behavior is unchanged.
- [ ] Existing Task Orchestration behavior is unchanged.
- [ ] Existing channels remain compatible when no Conversation binding exists.
- [ ] Full unit/type/build suites are green.
