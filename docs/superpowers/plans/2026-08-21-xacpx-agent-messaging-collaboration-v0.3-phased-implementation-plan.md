# xacpx Agent Messaging Collaboration UX v0.3 — Phased Implementation Plan

> **Status:** Ready for execution  
> **Date:** 2026-08-21  
> **Repository:** `gadzan/xacpx`  
> **Companion Spec:** `2026-08-21-xacpx-agent-message-collaboration-ux-v0.3.md`  
> **Implementation strategy:** Small, reviewable phases with explicit correctness gates

---

# 0. Purpose

This plan turns the v0.3 spec into an execution sequence that can be implemented and reviewed incrementally.

The work has three product goals:

```text
A. Sender-side Agent Message card anchors after the exact `agent_send` tool call.

B. `@Agent` autocomplete ranks collaboration targets by current Relay Web context.

C. `agent_send` can request:
   completion = none | notify | result
   without forcing the peer Agent to reply manually.
```

The implementation must preserve existing v0.2 behavior:

```text
queue-first
canonical Agent identity
same-account Relay federation
canonical TurnQueue serialization
fail-closed archive behavior
one-way messaging by default
no semantic ping-pong
no upstream acpx/codex dependency changes
```

---

# 1. Overall Execution Order

Implement in this order:

```text
Phase 0 — Baseline + observability inventory
Phase 1 — Durable sender/tool correlation foundation
Phase 2 — Sender card turn anchoring in Relay Web
Phase 3 — Context-aware autocomplete ranking metadata
Phase 4 — Context-aware autocomplete ranking UX
Phase 5 — Completion protocol/data model foundation
Phase 6 — Exact peer-turn completion correlation
Phase 7 — Local completion delivery
Phase 8 — Relay federation completion delivery
Phase 9 — Completion-aware sender UX
Phase 10 — Full hard-gate matrix + cleanup
```

Do not start Phase 5 before Phases 1–4 are stable.

Do not start remote completion federation before local completion is proven.

---

# 2. Branch / Commit Strategy

Recommended branch:

```text
feat/agent-messaging-collaboration-v0.3
```

Recommended commit granularity:

```text
1. test(agent-messaging): pin v0.3 baseline invariants
2. feat(relay): correlate agent_send tool steps with message ids
3. feat(relay-web): anchor sent peer cards to agent_send steps
4. feat(agent-directory): publish endpoint context metadata
5. feat(relay-web): rank @agent candidates by collaboration context
6. feat(agent-messaging): add completion policy protocol types
7. feat(control): correlate peer requests with exact target turns
8. feat(agent-messaging): deliver local peer completion/result
9. feat(relay): federate peer completion/result
10. feat(relay-web): surface peer completion state
11. test(agent-messaging): add v0.3 production hard gates
12. docs(agent-messaging): document v0.3 behavior
```

Do not squash all implementation into one giant commit before review.

Each phase should leave the repository green.

---

# 3. Phase 0 — Baseline and Architecture Inventory

## Goal

Before changing behavior, pin the exact current architecture and add regression coverage for behavior that must not regress.

## Required investigation

Confirm current production paths:

```text
agent_send MCP
→ XacpxMcpTransport
→ AgentMessageRouter.send
→ LocalAgentMessageDelivery / RelayAgentMessageRoute

peer target delivery
→ TurnQueue
→ SessionTurnRunner
→ control events
→ Relay Hub
→ Relay Web

tool events
→ ToolUseEvent
→ channel-relay toolUseEventToStepDto
→ ToolStepDto
→ TurnParts
```

Also confirm:

```text
where agent_send structuredContent is visible in ToolUseEvent rawOutput/content
where assistant turn final text is assembled/persisted
where turn terminal status is available
where sender/receiver AgentMessage history rows are persisted
```

## Tests to add first

Add baseline tests proving:

```text
1. agent_send still returns admission ACK without waiting for peer completion.
2. receiver AgentMessage card is standalone.
3. sender AgentMessage card currently persists independently.
4. archived Agent endpoints remain undiscoverable.
5. agent_send completion behavior does not exist yet / defaults effectively one-way.
```

These tests may initially document current behavior and later be updated only where the spec intentionally changes it.

## Exit criteria

Phase 0 is complete when:

```text
- architecture notes are confirmed against production code
- no implementation behavior changed
- baseline tests are green
```

---

# 4. Phase 1 — Durable Sender / Tool Correlation Foundation

## Goal

Make the `agent_send` tool step explicitly carry the Agent Messaging `messageId`.

This phase must not change Relay Web layout yet.

## Core rule

Never correlate sender cards by:

```text
timestamp
message content
target name
tool order
nearest tool
```

Use only explicit `messageId`.

## Data model

Extend wire tool step:

```ts
interface ToolStepDto {
  ...
  agentMessageId?: string;
}
```

Only valid for:

```text
toolName == agent_send
```

and only when a valid structured Agent Messaging receipt exists.

## Implementation path

Likely:

```text
src/mcp/xacpx-mcp-tools.ts
→ agent_send returns structuredContent with receipt.messageId

ToolUseEvent path
→ packages/channel-relay/src/tool-presentation.ts
→ toolUseEventToStepDto()

packages/relay-protocol/src/dtos.ts
→ ToolStepDto.agentMessageId?
```

Prefer structured output parsing.

Do not parse:

```text
"Peer message msg_123 accepted..."
```

from display text.

## Required tests

### Unit

```text
agent_send success structuredContent
→ ToolStepDto.agentMessageId = exact messageId
```

Negative:

```text
other tools
→ no agentMessageId

agent_send malformed/missing structured receipt
→ no guessed agentMessageId
```

### Persistence

Verify:

```text
tool step with agentMessageId
→ survives Relay event transport
→ survives assistant turn persistence
→ survives history reload
```

## Exit criteria

```text
- correlation ID is durable through refresh
- no UI behavior changed yet
- no message routing behavior changed
- all existing Relay Web / Agent Messaging tests green
```

---

# 5. Phase 2 — Sender Card Turn Anchoring

## Goal

Render sent AgentMessage cards immediately after the exact `agent_send` tool step.

Receiver cards remain unchanged.

## Presentation architecture

Do not mutate database ordering.

Do not merge AgentMessage data into the persisted assistant row.

Keep:

```text
AgentMessage history row = durable collaboration record
Assistant turn parts = durable model/tool transcript
```

Join only in presentation.

## Suggested composition

Build:

```ts
sentAgentMessageById: Map<string, PeerMessageHistoryEntry>
```

Then enhance turn presentation:

```ts
type PresentedTurnItem =
  | text
  | reasoning
  | tool
  | anchored-agent-message
```

When:

```text
ToolStepDto.agentMessageId === sent history messageId
```

render:

```text
ToolStep
Sent AgentMessageCard
```

and suppress the standalone duplicate row.

## Legacy fallback

If sender card cannot be joined:

```text
old history
missing compact detail
old connector
correlation absent
```

keep rendering standalone sender card.

No data loss.

## Required tests

### Gate A

```text
assistant text
agent_send tool
sent peer card
assistant later text
```

Assert exact visual order.

### Refresh

Persist and reload.

Assert same order after history reconstruction.

### Gate B

Receiver remains:

```text
Received card
Receiver assistant turn
```

### Gate C

Uncorrelated legacy sender card remains standalone.

## Exit criteria

```text
- deployed sender UX issue #1 is fixed
- no completion semantics yet
- no autocomplete changes yet
```

Recommended review checkpoint after Phase 2.

---

# 6. Phase 3 — Agent Directory Context Metadata

## Goal

Give Relay Web enough canonical metadata to rank targets without guessing from aliases.

Do not change autocomplete ranking yet.

## Problem

Current directory tells Web:

```text
identity
displayName
sessionAlias
agent
workspace
instance ownership
activity
```

but Web cannot reliably determine:

```text
logical vs worker
Relay vs another channel
```

without string inference.

## Data model

Add optional fields:

```ts
endpointKind?: "logical" | "worker";
channelId?: string;
```

Keep optional for compatibility.

## Derivation

For logical sessions:

```text
endpointKind = logical
channelId = channel namespace owning that logical session
```

For worker endpoints:

```text
endpointKind = worker
channelId may be omitted unless authoritative
```

Do not derive channel by fragile UI string parsing.

Use existing channel-scope / known-channel architecture.

## Federation

Ensure remote snapshot preserves optional fields.

Old peers:

```text
missing metadata
→ accepted
→ Web treats as lowest-priority context
```

## Required tests

```text
local relay logical
local non-relay logical
worker
remote relay logical
legacy endpoint without new fields
```

Verify serialization round-trip.

## Exit criteria

```text
- directory remains canonical eligibility truth
- no Web-side lifecycle duplicate logic introduced
- no ranking changes yet
```

---

# 7. Phase 4 — Context-Aware `@Agent` Autocomplete Ranking

## Goal

Fix deployed UX issue #2.

Keep all canonical reachable endpoints available, but rank them by relevance.

## Required current context

PromptInput or parent context must provide:

```ts
currentInstanceId?
currentWorkspace?
currentSessionAlias?
currentEndpointHandle?
```

Exclude self only by canonical identity/handle when available.

Do not exclude by display name.

## Context tiers

Exact required order for broad/empty query:

```text
Tier 0
same workspace

Tier 1
same instance, different workspace

Tier 2
other Relay instance

Tier 3
non-Relay logical / worker / unknown legacy
```

Within Tier 0:

```text
same instance may be tie-break preference
```

but workspace tier remains stronger.

## Text matching

Text relevance must dominate once user types a specific target.

Required order conceptually:

```text
exact visible name
exact visible alias
exact raw alias
prefix...
contains...
workspace / agent
```

Then contextual tier.

Example:

```text
@文件浏览器功能
```

must rank the exact remote target first even if a same-workspace fuzzy candidate exists.

## Low-priority source labeling

Examples:

```text
@Reviewer
xacpx · claude · MacBook Air

@Legacy Reviewer
xacpx · claude · WeChat

@Review Worker
xacpx · codex · Worker
```

Reuse existing collision/disambiguation model.

Do not expose raw nodeId except last-resort suffix.

## Required tests

### Gate D

No query:

```text
same workspace
same instance
other instance
non-relay
```

### Gate E

Exact explicit remote target beats contextual fuzzy match.

### Gate F

Archived/deleted absent because directory excludes them.

### Gate G

Non-Relay remains selectable and visibly labeled.

### Self

Current endpoint absent from list.

## Exit criteria

```text
- deployed autocomplete relevance issue fixed
- no completion semantics introduced yet
```

Recommended review checkpoint after Phase 4.

---

# 8. Phase 5 — Completion Protocol / Data Model Foundation

## Goal

Introduce the semantic model for:

```text
completion = none | notify | result
```

without yet delivering completion turns.

## MCP input

Extend:

```ts
completion?: "none" | "notify" | "result";
```

Default:

```text
none
```

## AgentMessage model

Add:

```ts
completion: AgentMessageCompletionMode;
```

with compatibility default:

```text
missing → none
```

## New types

```ts
type AgentMessageCompletionMode =
  | "none"
  | "notify"
  | "result";

type AgentMessageCompletionStatus =
  | "completed"
  | "failed"
  | "cancelled";

interface AgentMessageCompletion {
  requestMessageId: string;
  from: AgentAddress;
  to: AgentAddress;
  status: AgentMessageCompletionStatus;
  result?: string;
  error?: string;
  completedAt: number;
}
```

## Hard invariant

Completion is **not**:

```text
normal AgentMessage
replyTo
conversation thread message
```

It must not consume:

```text
conversation depth
message volume
peer rate limit
duplicate-content guard
```

## MCP result guidance

Update agent_send tool result text:

```text
none
→ no reply expected

notify
→ xacpx will notify when peer terminal

result
→ xacpx will return final peer result

Do not poll.
Do not send acknowledgement messages.
```

## Compatibility

Before remote completion support exists:

```text
local may advertise support internally
remote request must not falsely claim support
```

If capability negotiation exists, add completion capability.

Otherwise defer explicit remote result support until Phase 8.

## Required tests

```text
default completion = none
schema accepts all three
invalid completion rejected
message serialization preserves completion
old message with no field behaves as none
normal reply semantics unchanged
```

## Exit criteria

No runtime completion should fire yet.

---

# 9. Phase 6 — Exact Peer-Turn Correlation

## Goal

Associate one peer request with the exact target TurnQueue item and exact SessionTurnRunner execution.

This is the most important correctness phase.

## Never do

```text
"wait for next turn-finished"
```

or:

```text
"target session became idle"
```

Those are race-prone.

## New execution metadata

Recommended:

```ts
interface PeerTurnOrigin {
  requestMessageId: string;
  completion: AgentMessageCompletionMode;
  source: AgentAddress;
  target: AgentAddress;
}
```

Store on exact peer queue item:

```ts
QueuedPrompt.peerOrigin?
```

and carry into execution context.

## Lifecycle

```text
delivery admission
→ peerOrigin attached

queued
→ metadata preserved

drain
→ metadata preserved

turn start
→ exact origin known

turn finish/fail/cancel
→ exact origin known
```

## Canonical lane invariant

Do not alter the canonical TurnQueue serialization already established.

Peer request must continue sharing the same target logical-session lane as human/scheduled prompts.

## Required tests

### Busy target

```text
B human turn running
A sends peer request R1
another prompt queued

R1 completion must bind only to R1's turn
```

### Multiple peer requests

```text
R1
R2
```

each completion maps to its own messageId.

### Cross-session concurrency

Two target sessions may run independently without metadata bleed.

## Exit criteria

```text
- exact correlation proven
- no completion delivery yet required
```

Recommended focused review here before continuing.

---

# 10. Phase 7 — Local Completion Delivery

## Goal

Implement completion end-to-end when source and target are on the same messaging node.

Do local first.

## Result extraction

For:

```text
completion = result
```

capture only:

```text
final user-visible assistant answer
```

Use the same final assistant text that Relay Web/history already considers the turn's answer.

Do not include:

```text
reasoning
tool transcript
raw command logs
full TurnParts
```

Bound:

```ts
maxPeerCompletionResultBytes = 16 * 1024
```

Use stable truncation marker.

## Completion generation

At exact peer-origin turn terminal:

```text
none
→ generate nothing

notify
→ terminal status only

result
→ terminal status + bounded final result
```

On failure/cancel:

```text
notify/result
→ terminal failed/cancelled completion
```

## Source injection

If source:

```text
idle
→ start normal observable turn

working
→ enqueue same canonical source lane

archived
→ persist completion state only
→ DO NOT wake
```

## Trusted envelope

Use:

```xml
<xacpx-peer-completion ...>
```

or:

```xml
<xacpx-peer-result ...>
```

with trusted runtime instruction:

```text
Do not acknowledge back.
Use result to continue.
Contact peer again only for new substantive information.
```

Disarm user-authored fake tags using existing trusted framing pattern.

## Idempotency

Source completion effect keyed by:

```text
requestMessageId
```

Duplicate local completion:

```text
one injection
one history status update
```

## Required gates

### Gate H

completion=none → no follow-up.

### Gate I

notify → one completion-only source turn.

### Gate J

result → one exact bounded result.

### Gate K

busy target exact correlation.

### Gate L

busy source queues, no parallel turn.

### Gate M

archived source not restored.

### Gate N

duplicate completion idempotent.

### Gate O

peer failure returns failed terminal result exactly once.

## Exit criteria

Local completion semantics fully green before any Relay federation work.

---

# 11. Phase 8 — Relay Federation Completion Delivery

## Goal

Extend local completion semantics across same-account Relay federation.

Do not change security/trust boundaries.

## Protocol

Add explicit Relay completion route messages.

Recommended conceptual flow:

```text
target daemon
→ Hub authenticated completion route
→ source instance
→ source daemon
→ source Agent endpoint
```

Use original authenticated identities:

```text
request source
request target
requestMessageId
```

Peer model must never select reverse destination.

## Required payload

Only:

```text
requestMessageId
source/target canonical identity
terminal status
bounded result/error
completedAt
```

Do not send raw turn transcript.

## Capability / compatibility

Old remote daemon:

```text
completion unsupported
```

For explicit:

```text
completion=notify/result
```

prefer typed failure:

```text
COMPLETION_NOT_SUPPORTED
```

rather than silently downgrade when sender explicitly requested a completion.

`completion=none` must remain compatible.

## Reliability

Transport:

```text
may retry at-least-once
```

Source effect:

```text
exactly once
```

Target terminal completion cache should prevent contradictory re-generation.

## Required tests

```text
remote notify
remote result
remote failure
duplicate Hub delivery
source reconnect retry
remote old-peer unsupported
```

## Production hard gate

Use:

```text
real Relay Hub
two real buildApp daemons
real WebSocket
real acpx-cli
mock ACP agent
```

Do not fake the result route through direct router calls only.

## Exit criteria

Local and remote completion semantics match.

---

# 12. Phase 9 — Completion-Aware Sender UX

## Goal

Make the sender card reflect asynchronous completion state.

## Sender card states

For `none`:

```text
Sent
```

For `notify`:

```text
Waiting for completion
→ Completed / Failed
```

For `result`:

```text
Waiting for result
→ Result returned / Failed
```

Do not embed full result inside the sent card in v0.3.

The actual result belongs to the later source Agent turn.

## Persistence

Persist enough state for refresh:

```ts
completion?
completionStatus?
```

Do not depend on in-memory Web store.

## Anchored card update

The same card anchored under the `agent_send` tool must update terminal status.

Do not create a second completion card in the sender timeline unless the trusted completion turn itself naturally appears through normal turn history.

## Tests

```text
live pending state
terminal state
refresh pending
refresh terminal
failure
legacy sender card
```

## Exit criteria

Deployed issue #1 and issue #3 have coherent UI together.

---

# 13. Phase 10 — Full Hard-Gate Matrix and Cleanup

## Goal

Prove the complete v0.3 product path and remove accidental complexity.

## Full required gates

Run all v0.3 Spec Gates A–O:

```text
A  sender tool anchoring
B  receiver standalone
C  legacy sender fallback
D  same-workspace autocomplete priority
E  explicit text match beats context
F  archived/deleted absent
G  non-Relay presentation
H  completion none
I  completion notify
J  completion result
K  busy target exact correlation
L  busy source serialization
M  archived source
N  completion exactly-once
O  peer failure
```

## Add two extra production safety gates

### Gate P — Concurrent independent requests

```text
A → B completion=result
C → D completion=result
```

Run concurrently.

Ensure:

```text
no cross-request result contamination
no source/target identity bleed
```

### Gate Q — Sender card/message correlation collision

Two `agent_send` calls in one assistant turn:

```text
tool1 → messageId1
tool2 → messageId2
```

Assert:

```text
card1 after tool1
card2 after tool2
```

No swapping by timestamp/order.

---

# 14. Full Production E2E Scenario

The final hard gate should cover:

```text
Relay Web user opens session A
↓
@ autocomplete initially prioritizes same-workspace active peers
↓
user selects B through canonical handle binding
↓
A receives trusted collaboration directive
↓
A calls agent_send(completion=result)
↓
sender tool step gets messageId correlation
↓
sender card renders directly below agent_send tool
↓
B receives standalone inbound AgentMessage card
↓
B is idle or queued behind existing work
↓
B runs exact peer-correlated normal turn
↓
Relay Web sees B working / output / finished
↓
B never calls agent_send back
↓
runtime captures B final assistant result
↓
Relay completion routes back to A
↓
A busy → queues OR A idle → starts
↓
A receives trusted peer-result
↓
A continues user's task
↓
sender anchored card becomes Result returned
↓
refresh both sessions
↓
all cards, order, statuses, assistant turns persist correctly
```

Use real:

```text
Relay Hub
Relay Web websocket/API boundary
two daemon instances if testing federation
acpx-cli
mock ACP agent
SQLite persistence
```

---

# 15. Test Layering Strategy

Do not rely only on one giant integration test.

Use four levels.

## Level 1 — Pure unit

```text
ranking
DTO parsing
completion mode
result bounding
secondary correlation
idempotency keys
trusted envelope rendering
```

## Level 2 — Component / store

```text
PromptInput ranking
MessageList anchoring
TurnParts presentation
AgentMessageCard state
history reload composition
```

## Level 3 — Core integration

```text
TurnQueue exact peerOrigin
busy target
busy source
archive
local completion
federation completion
```

## Level 4 — Production hard gate

```text
Web → Hub → daemon → MCP/tool → target turn → completion → source turn
```

A Level 4 green test does not replace focused Level 1–3 tests.

---

# 16. Failure Semantics

Use typed failures.

Recommended additions where necessary:

```text
COMPLETION_NOT_SUPPORTED
COMPLETION_ROUTE_UNAVAILABLE
COMPLETION_DELIVERY_FAILED
```

Do not overload unrelated codes if doing so hides the distinction between:

```text
initial AgentMessage admission failure
later completion delivery failure
```

Immediate send failure:

```text
agent_send itself fails
```

Later completion-route failure:

```text
original send remains accepted
sender card becomes completion failed/unavailable
```

Do not retroactively claim the original message was never delivered.

---

# 17. Logging / Trace

Metadata-only.

Allowed:

```text
requestMessageId
completion mode
source canonical address
target canonical address
route local/relay
terminal status
result byte length
result hash
timestamps
deduplicated
```

Do not log raw result text in diagnostics by default.

Keep user-visible result in normal history path only.

---

# 18. Migration / Compatibility Rules

## Existing persisted AgentMessage rows

Missing:

```text
completion
completionStatus
tool correlation
```

interpret as:

```text
completion = none
standalone sender presentation if no correlation
```

## Existing assistant history

Missing `agentMessageId`:

```text
no anchoring
legacy fallback
```

## Mixed daemon versions

```text
completion=none
→ continue to work

completion=notify/result
→ must not falsely report supported
```

Prefer typed unsupported failure when capability cannot be proven.

---

# 19. Strict Scope Controls

During implementation, do not:

```text
- redesign Agent Messaging addressing
- change PeerLink/cross-account trust
- add persistent mailbox
- add steering
- add groups/broadcast
- replace Task Orchestration
- rewrite TurnQueue architecture beyond required metadata propagation
- change unrelated Relay terminal behavior
- change session restore semantics for humans
- refactor unrelated UI components
```

If a required change appears to need an upstream acpx modification:

```text
STOP
```

and report the dependency instead of patching/forking upstream.

---

# 20. Review Checkpoints

Recommended formal review after:

```text
Checkpoint 1 — Phase 2
Sender card correlation/anchoring

Checkpoint 2 — Phase 4
Autocomplete relevance

Checkpoint 3 — Phase 6
Exact peer-turn correlation

Checkpoint 4 — Phase 7
Local completion semantics

Checkpoint 5 — Phase 8
Relay completion federation

Checkpoint 6 — Phase 10
Final production hard gate
```

Do not wait until the entire v0.3 feature is finished to review correctness.

---

# 21. Per-Phase Verification Command Expectations

At minimum after each phase:

```text
npx tsc --noEmit
bun run build:packages
targeted unit tests
targeted integration tests
git diff --check
```

For Relay Web phases:

```text
packages/relay-web full Vitest
vue-tsc --noEmit
relevant Playwright E2E
```

For federation phases:

```text
agent-messaging federation integration suite
collaboration UX hard gate
```

Before merge:

```text
full repository test suite
full package build
CI matrix
```

---

# 22. Definition of Phase Safety

A phase is not complete just because tests pass.

It must satisfy:

```text
1. Production path changed, not test-only scaffolding.
2. Test observes the actual behavior being claimed.
3. No fake correlation based on timing.
4. No silent fallback that violates semantics.
5. Mixed-version behavior is explicit.
6. Existing queue/archive/idempotency invariants remain intact.
7. Scope is limited to the phase.
```

---

# 23. Final Merge Criteria

Do not merge v0.3 until all are true:

```text
[ ] Sender cards anchor to exact agent_send tools.
[ ] Receiver cards remain standalone.
[ ] Refresh preserves sender anchor.
[ ] Legacy history remains readable.
[ ] Autocomplete prioritizes same workspace.
[ ] Same instance comes next.
[ ] Other Relay instance comes next.
[ ] Non-Relay/worker remains available but lowest priority.
[ ] Explicit text match beats contextual ranking.
[ ] agent_send default remains one-way.
[ ] completion=notify works locally and remotely.
[ ] completion=result works locally and remotely.
[ ] Peer Agent does not need to manually reply.
[ ] Result comes from exact peer-triggered turn.
[ ] Busy target ordering is correct.
[ ] Busy source ordering is correct.
[ ] Archived source is not restored.
[ ] Completion duplicate delivery is idempotent.
[ ] Failure/cancel completion is terminal and exactly-once.
[ ] Sender completion state persists.
[ ] No AgentMessage conversation guard is consumed by completion.
[ ] No new automatic ping-pong path exists.
[ ] No upstream dependency modification exists.
[ ] Production E2E hard gate passes.
[ ] Full CI is green.
```

---

# 24. Execution Guidance for the Implementing Agent

Use the companion v0.3 spec as the product/semantic authority.

Use this plan as the implementation sequence.

When the existing repository architecture differs from an illustrative type/file name in the spec:

```text
preserve the semantic invariant
reuse the existing production abstraction
avoid parallel systems
```

At the end of each phase, report:

```text
Phase:
Head SHA:
Files changed:
Production path changed:
Tests added:
Tests run:
Known limitations:
Next phase:
```

If a phase uncovers a correctness conflict with a previous invariant:

```text
stop before broadening scope
document the conflict
request review
```

Do not hide unresolved semantics behind additional mocks.

---

# 25. Final Target Architecture

```text
                        CANONICAL DIRECTORY
                               │
                               ▼
                     context-aware @ discovery
                               │
                               ▼
USER → AGENT A → agent_send(completion=...)
                    │
                    ├─ immediate admission ACK
                    │
                    ├─ ToolStep.agentMessageId
                    │        │
                    │        └─→ anchored sender card
                    │
                    ▼
               AgentMessage route
                    │
                    ▼
              TARGET TURN QUEUE
                    │
             exact peerOrigin
                    │
                    ▼
                 AGENT B
              normal model turn
                    │
                    ▼
             exact turn terminal
                    │
          ┌─────────┴─────────┐
          │                   │
   completion=none      notify / result
          │                   │
        stop                  ▼
                     system completion route
                              │
                              ▼
                         AGENT A lane
                              │
                 idle → start / busy → queue
                              │
                              ▼
                    trusted completion/result
```

The key design boundary is:

> **AgentMessage delivery, peer turn execution, completion routing, and Relay Web presentation are separate concerns linked by explicit canonical IDs — never by timing or heuristics.**
