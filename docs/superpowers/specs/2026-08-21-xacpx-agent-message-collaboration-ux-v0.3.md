# xacpx Agent Messaging Collaboration UX v0.3 Spec

> **Status:** Ready for implementation  
> **Date:** 2026-08-21  
> **Scope:** Agent Messaging collaboration UX and completion semantics  
> **Repository:** `gadzan/xacpx`

---

# 1. Background

Agent Messaging v0.2 has established the core collaboration path:

```text
Agent A
→ xacpx built-in MCP `agent_send`
→ canonical Agent Messaging routing
→ local / Relay delivery
→ Agent B session
→ normal xacpx turn execution
→ Relay Web live-turn visibility
→ Agent Message history cards
```

The deployed implementation is functionally usable, but real Relay Web usage exposed three product gaps:

1. **Sender-side Agent Message card is rendered in the wrong place.**
   - A sent card currently appears as a standalone timeline row before / above the entire assistant turn.
   - It should instead appear immediately after the `agent_send` tool call that caused it.

2. **`@Agent` autocomplete is technically complete but contextually noisy.**
   - It includes reachable sessions that do not appear in the current Relay Web sidebar.
   - Some belong to another channel, another instance, worker/internal endpoints, or otherwise have low relevance to the current user context.
   - The directory should remain complete, but the UI must rank candidates by collaboration relevance.

3. **Agent A cannot express whether it needs a completion signal or a result from Agent B.**
   - For one-way notifications, no reply is correct.
   - For work requests such as:
     ```text
     @文件浏览器功能 简要总结刚刚做了什么？
     ```
     B may correctly complete its own turn without explicitly calling `agent_send` back to A.
   - A therefore needs a system-level way to request:
     - no return signal,
     - completion-only notification,
     - or the peer turn's final result.

The solution must preserve the core v0.2 principles:

```text
queue-first
one-way by default
no forced Agent-to-Agent acknowledgements
no semantic ping-pong
no cross-user collaboration
no durable offline mailbox
no upstream acpx/codex changes
```

---

# 2. Goals

This spec adds three tightly scoped capabilities:

```text
A. Sender Card Turn Anchoring
B. Context-Aware @Agent Autocomplete Ranking
C. System-Managed Peer Completion Policy
```

The target user experience is:

```text
User asks Agent A:
“@文件浏览器功能 简要总结刚刚做了什么？”

Agent A:
  explains intent
  calls agent_send(completion="result")

  [agent_send tool]
  → 文件浏览器功能
    简要总结刚刚做了什么？
    Waiting for result

Agent A may continue its current work.

Agent B:
  receives peer request
  runs normal turn
  produces final answer
  does NOT need to call agent_send back

xacpx:
  observes B's exact peer-triggered turn completion
  returns a system-managed result to A

Agent A:
  is reactivated when appropriate
  receives the peer result
  continues its task
  does NOT send an acknowledgement back
```

---

# 3. Non-Goals

Do **not** implement:

- synchronous `agent_send` waiting for peer model completion
- mandatory peer reply behavior
- automatic Agent-to-Agent conversational loops
- generic RPC request/response
- cross-account / cross-user collaboration
- durable offline mail
- group chat
- broadcast / pub-sub
- realtime same-turn steering
- long-lived distributed task orchestration
- replacing `delegate_request`
- changing canonical Agent handle format
- changing canonical Agent identity
- upstream `acpx` / `codex-acp` changes

`agent_send` remains:

> asynchronous peer delivery + delivery admission ACK

It must **not** become:

> wait until the peer model finishes and return its response inline.

---

# 4. Capability A — Sender Card Turn Anchoring

## 4.1 Current problem

Today sender and receiver Agent Message cards are both persisted as standalone history entries.

For the receiver this is correct:

```text
← From Agent A
message
```

The peer message is an external input that caused a new turn.

For the sender it is wrong.

A sender message is a side effect of an `agent_send` tool call executed *inside the current assistant turn*.

Current layout can look like:

```text
→ Sent to Agent B
message

Agent A:
  text...
  [agent_send tool]
  text...
```

The correct structure is:

```text
Agent A:
  text...

  [agent_send tool]

  → Sent to Agent B
    message

  text...
```

The sent card is semantically part of the assistant turn, not a new top-level timeline message.

---

# 5. Sender / Receiver Presentation Semantics

## 5.1 Receiver

Keep receiver behavior unchanged:

```text
AgentMessageCard
direction = received
```

It remains a standalone history row.

Example:

```text
← From Reviewer · Claude · xacpx
User schema changed: legacy_id has been removed.
```

## 5.2 Sender

Sender-side cards should be anchored to the `agent_send` tool step that produced them.

Example:

```text
Agent A

我先问文件浏览器总结一下。

┌ agent_send ─────────────────────┐
│ 文件浏览器功能                  │
└─────────────────────────────────┘

→ 文件浏览器功能
  简要总结刚刚做了什么？
  Waiting for result

我同时继续检查其它部分。
```

The card must survive:

- live streaming
- turn finish
- history reload
- browser refresh
- pagination / compact history hydration

---

# 6. Sender Card Correlation

Do not correlate by:

- timestamp proximity
- message text equality
- target display name
- list position
- “nearest previous tool”

Use an explicit stable identifier.

The existing `agent_send` result already contains:

```ts
messageId
```

The existing tool transcript has:

```ts
toolCallId
```

The Relay tool normalization path should extract the Agent Messaging receipt from the tool result and attach the message ID to the corresponding tool step.

Recommended wire addition:

```ts
interface ToolStepDto {
  toolCallId: string;
  toolName: string;
  ...
  agentMessageId?: string;
}
```

Only populate this for the `agent_send` tool when a valid structured Agent Messaging receipt is present.

Do not infer from arbitrary tool output text.

---

# 7. Sender Card Join Algorithm

The persisted sender Agent Message history entry remains canonical durable history.

Do **not** move message persistence into the assistant turn record.

At presentation time:

```text
sender AgentMessage history row
        +
TurnPartDto.tool.step.agentMessageId
        ↓
join by messageId
```

Relay Web presentation should:

1. Build a map:
   ```ts
   sentAgentMessageById
   ```

2. While rendering an assistant turn:
   - render its normal turn parts in order
   - when a tool step has:
     ```ts
     agentMessageId
     ```
     render the matching sender `AgentMessageCard` immediately after that tool step

3. Do not render that successfully joined sent card again as a standalone timeline row.

4. If a sent card has no matching tool correlation:
   - old history
   - unsupported adapter
   - compact history missing tool detail
   - malformed/legacy event
   - correlation unavailable

   then fallback to the existing standalone Agent Message card.

This preserves backwards compatibility.

---

# 8. TurnPart Presentation Extension

Do not special-case this in `MessageList.vue` by manually scanning DOM positions.

Keep the transcript presentation model explicit.

Recommended presentation shape:

```ts
type PresentedTurnItem =
  | { type: "text"; ... }
  | { type: "reasoning"; ... }
  | { type: "tool"; step: ToolStepDto }
  | {
      type: "agent-message";
      message: PeerMessageHistoryEntry;
      anchorToolCallId: string;
    };
```

`deriveTurnPresentation()` or an adjacent composition layer should insert the sender card after its anchor tool.

The underlying persisted turn parts stay unchanged.

---

# 9. Sender Card Status

Sender card may expose completion state.

Minimum v0.3 states:

```ts
type PeerRequestUiStatus =
  | "sent"
  | "queued"
  | "waiting"
  | "completed"
  | "failed";
```

For `completion = "none"`:

```text
Sent
```

For `completion = "notify"` or `"result"` after delivery:

```text
Waiting for completion
```

When terminal completion arrives:

```text
Completed
```

Failure:

```text
Failed
```

---

# 10. Capability B — Context-Aware `@Agent` Autocomplete

## 10.1 Core principle

The Canonical Agent Directory remains the sole **eligibility truth**.

Relay Web must **not** recreate reachability rules.

The autocomplete change is ranking/presentation only.

Directory decides:

```text
what can be addressed
```

Relay Web decides:

```text
what is most relevant to show first
```

---

# 11. Eligibility

Candidates shown in autocomplete must already be canonical-directory endpoints.

The Web must not independently include archived/deleted endpoints.

Expected effective rules:

```text
deleted
→ absent

archived / sleeping
→ absent / not discoverable

offline
→ absent from reachable directory

active + online
→ eligible
```

Do not duplicate these rules in `PromptInput.vue`.

---

# 12. Why Non-Sidebar Sessions Exist

The Agent Messaging directory may legitimately include endpoints that do not currently appear in the Relay Web sidebar, including:

- another Relay instance
- another channel
- worker endpoint
- internal / non-Relay logical session
- session outside the current sidebar's presentation scope

These endpoints should not be deleted from the directory.

They should simply rank lower.

---

# 13. New Directory Presentation Metadata

Relay Web needs explicit metadata to distinguish endpoint context.

Do not infer endpoint/channel type from display alias strings.

Recommended additions:

```ts
interface PublishedAgentEndpointDto {
  ...
  endpointKind?: "logical" | "worker";
  channelId?: string;
}
```

Semantics:

```text
endpointKind = logical
→ normal logical session endpoint

endpointKind = worker
→ orchestration worker endpoint
```

`channelId` should identify the source channel namespace when known:

```text
relay
weixin
feishu
...
```

Old peers / old connectors may omit these fields.

Missing metadata must remain compatible and fall into the lowest contextual priority tier.

---

# 14. Current Composer Context

Autocomplete ranking must know the current Relay Web context:

```ts
interface AgentAutocompleteContext {
  currentInstanceId?: string;
  currentWorkspace?: string;
  currentSessionAlias?: string;
  currentEndpointHandle?: string;
}
```

Self endpoint must be excluded when canonical identity is known.

Do not rely only on displayName/alias equality for self exclusion.

---

# 15. Context Priority Tiers

When no meaningful query is typed, rank by collaboration relevance:

```text
Tier 0
same workspace
eligible logical session
non-archived / non-deleted
prefer Relay-visible endpoints

Tier 1
same Relay instance
different workspace
eligible logical session

Tier 2
different Relay instance
eligible logical session

Tier 3
non-Relay logical session
worker endpoint
unknown / legacy endpoint context
```

Important:

> Same workspace ranks above same instance.

Reason:

Two Agents working in the same repository/workspace are usually more relevant collaborators than two unrelated sessions merely running on the same machine.

---

# 16. Query Ranking vs Context Ranking

When the user types only:

```text
@
```

or a very broad fragment:

```text
@b
```

context relevance should strongly influence ordering.

When the user types a clear query:

```text
@文件浏览器
```

text match must dominate scope ranking.

Recommended comparison:

```text
1. textual relevance rank
2. contextual tier
3. current instance preference
4. activity
5. presentation name
6. stable canonical handle
```

Do not let a fuzzy same-workspace match outrank an exact explicitly typed remote target.

---

# 17. Recommended Ranking Model

Example scoring concept:

```ts
interface RankedCandidate {
  textRank: number;
  contextTier: 0 | 1 | 2 | 3;
  sameInstance: boolean;
  item: AgentMentionItem;
}
```

Sorting:

```ts
a.textRank - b.textRank
|| a.contextTier - b.contextTier
|| Number(b.sameInstance) - Number(a.sameInstance)
|| activityRank(a) - activityRank(b)
|| presentationNameCompare(a, b)
|| handleCompare(a, b)
```

Do not introduce semantic / fuzzy-vector ranking.

Keep behavior deterministic.

---

# 18. Autocomplete Presentation for Low-Priority Sources

Normal Relay session:

```text
@文件浏览器功能
xacpx · codex
```

Other Relay instance:

```text
@Reviewer
xacpx · claude · MacBook Air
```

Other channel:

```text
@旧审查 Agent
xacpx · claude · WeChat
```

Worker:

```text
@Review Worker
xacpx · codex · Worker
```

Do not expose raw `nodeId` except as last-resort collision suffix under the existing presentation rules.

---

# 19. Capability C — System-Managed Completion Policy

## 19.1 Problem

`agent_send` currently means:

```text
deliver message
return delivery ACK
```

That is correct.

However, the sender cannot state whether it wants a later system-level completion signal.

We need to distinguish three intents:

```text
notification
work + completion signal
work + result
```

---

# 20. `agent_send` API Extension

Add:

```ts
completion?: "none" | "notify" | "result";
```

Default:

```text
none
```

Updated MCP schema:

```ts
agent_send({
  to?: string,
  selector?: {...},
  message: string,
  mode?: "auto" | "steer" | "queue" | "interrupt",
  replyTo?: string,
  completion?: "none" | "notify" | "result"
})
```

Description:

```text
none:
  one-way message; no completion signal is returned

notify:
  after the peer turn triggered by this message reaches terminal state,
  xacpx notifies the sender that the peer completed/failed/cancelled

result:
  after the peer turn reaches terminal state,
  xacpx returns the peer's bounded final assistant result to the sender
```

`agent_send` itself still immediately returns delivery admission status.

---

# 21. Completion Policy Examples

## 21.1 Notification only

```ts
agent_send({
  to,
  message: "legacy_id has been removed; update your code accordingly",
  completion: "none"
})
```

## 21.2 Need to know work finished

```ts
agent_send({
  to,
  message: "Please regenerate the type fixtures after the schema update.",
  completion: "notify"
})
```

## 21.3 Need peer result

```ts
agent_send({
  to,
  message: "简要总结刚刚做了什么？",
  completion: "result"
})
```

---

# 22. Do Not Force Peer Agent Reply

This is a hard invariant:

> `completion != none` must not require Agent B to call `agent_send` back.

Agent B should simply execute its normal turn.

The completion mechanism is owned by xacpx runtime.

---

# 23. Completion Is Not a Normal AgentMessage

Do not implement completion by generating a normal peer message with:

```ts
replyTo = originalMessageId
```

Completion must be a distinct protocol semantic.

Reasons:

A normal AgentMessage would:

- increase conversation depth
- count toward conversation volume
- pass duplicate-content guards
- consume peer rate limits
- be replyable
- invite another response
- re-enter the normal collaboration conversation

Completion should be:

```text
one-shot
system-managed
non-replyable
terminal
correlated to one original request
```

---

# 24. Completion Data Model

Recommended:

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

Do not expose:

- raw tool transcript
- hidden reasoning
- full internal turn structure
- credentials / paths / runtime metadata

---

# 25. Persist Completion Intent in AgentMessage

The original AgentMessage must carry:

```ts
completion: AgentMessageCompletionMode;
```

Default old messages:

```text
none
```

Federation must preserve this field.

Old peer version behavior:

```text
missing completion support
→ treat as none
```

If strict negotiation is already available, new sender may expose capability.

---

# 26. Peer Turn Correlation

Completion must be tied to the **exact target turn caused by the peer message**.

Never implement:

```text
wait for the next turn-finished in target session
```

That races with:

- queued human prompts
- scheduled prompts
- other peer messages
- concurrent sessions
- target already working

The target turn queue item must retain peer-origin metadata.

Recommended:

```ts
interface PeerTurnOrigin {
  requestMessageId: string;
  completion: AgentMessageCompletionMode;
  source: AgentAddress;
  target: AgentAddress;
}
```

Queued/execution context:

```ts
interface QueuedPrompt {
  ...
  peerOrigin?: PeerTurnOrigin;
}
```

---

# 27. Peer Turn Lifecycle

Delivery:

```text
AgentMessage received
↓
admission into target canonical TurnQueue
↓
peerOrigin stored on exact turn item
↓
queued / started receipt returned
```

Execution:

```text
turn-started(peerOrigin)
↓
normal Agent turn
↓
tool / reasoning / output
↓
turn-finished(peerOrigin)
```

Completion generation happens only from that correlated terminal turn.

---

# 28. Result Extraction

For:

```text
completion = result
```

capture only the final user-visible assistant result.

Do not include:

- hidden reasoning
- full tool logs
- command output unless included by Agent in final text
- complete structured transcript

Recommended source:

```text
the same final assistant text persisted/rendered as the turn's final assistant response
```

Apply a bounded size.

Recommended default:

```ts
maxPeerCompletionResultBytes = 16 * 1024
```

If truncated, append a stable truncation marker.

---

# 29. Completion Routing

Completion must travel reverse to the original source Agent endpoint.

Local:

```text
target daemon
→ local source endpoint
```

Remote:

```text
target daemon
→ Relay Hub
→ source daemon
→ source endpoint
```

The reverse route must be based on authenticated source/target identity from the original request.

Do not let the peer model choose the return destination.

---

# 30. Completion Delivery Semantics

Completion should be exactly-once by:

```text
requestMessageId
```

Target maintains terminal completion outcome state.

Recommended target-side key:

```text
completion:<requestMessageId>
```

States:

```text
pending
completed
failed
cancelled
```

Retry / reconnect should not cause duplicate source injections.

Completion transport may be at-least-once.

Source effect must be idempotent.

---

# 31. Source-Side Completion Consumption

When completion reaches Agent A:

```text
if A is idle
→ start a new normal xacpx-observable turn

if A is working
→ queue completion into A's canonical TurnQueue

if A is archived/sleeping
→ do not auto-restore
```

For archived source session:

```text
persist completion state/card
do not wake Agent
```

---

# 32. Trusted Completion Envelope

Do not inject completion as a fake User/System message.

Use an xacpx-owned trusted envelope.

For `notify`:

```xml
<xacpx-peer-completion
  request-id="msg_..."
  from="agent:node:endpoint"
  status="completed"
>
The peer request has completed.
</xacpx-peer-completion>
```

For `result`:

```xml
<xacpx-peer-result
  request-id="msg_..."
  from="agent:node:endpoint"
  status="completed"
>
刚刚完成了……
</xacpx-peer-result>
```

Add xacpx-owned instruction framing:

```text
This is the terminal outcome of a peer request you explicitly initiated.

Do not send an acknowledgement back to the peer.

Use the completion/result to continue the user's task.

Contact the peer again only if new substantive information is required.
```

Apply the same provenance protections used by existing collaboration directive framing.

---

# 33. Failure Completion

For:

```text
completion = notify | result
```

if target peer turn ends with failure/cancellation, source should receive a terminal completion event.

Example:

```xml
<xacpx-peer-completion
  request-id="msg_..."
  from="agent:..."
  status="failed"
>
Peer turn failed: command timeout
</xacpx-peer-completion>
```

Error must be:

- bounded
- sanitized
- user-safe
- not raw exception object
- not stack trace

---

# 34. Delivery ACK vs Completion

These are separate concepts.

Immediate `agent_send` result:

```ts
{
  messageId,
  status: "injected" | "queued",
  ...
}
```

Meaning:

```text
the target accepted the message for execution
```

Later completion:

```ts
AgentMessageCompletion
```

Meaning:

```text
the peer turn actually reached a terminal state
```

Do not conflate them.

---

# 35. MCP Tool Result Guidance

When completion is `none`:

```text
Peer message msg_x accepted with status=queued.
No reply is expected.
```

When completion is `notify`:

```text
Peer message msg_x accepted with status=queued.
xacpx will notify this session when the peer turn completes.
Do not poll or send acknowledgement messages.
```

When completion is `result`:

```text
Peer message msg_x accepted with status=queued.
xacpx will return the peer's final result to this session when it completes.
Do not poll or send acknowledgement messages.
```

---

# 36. Sender Card Completion UX

For `completion = none`:

```text
→ 文件浏览器功能
  migration schema updated
  Sent
```

For `completion = notify`:

```text
→ 文件浏览器功能
  regenerate fixtures
  Waiting for completion
```

Terminal:

```text
→ 文件浏览器功能
  regenerate fixtures
  Completed
```

For `completion = result`:

```text
→ 文件浏览器功能
  简要总结刚刚做了什么？
  Waiting for result
```

Terminal:

```text
→ 文件浏览器功能
  简要总结刚刚做了什么？
  Result returned
```

The result itself belongs to A's later system-triggered turn, not expanded inline into the sent card.

---

# 37. Persistence

Persist enough metadata to reconstruct:

```text
sent message
completion policy
terminal completion status
tool anchor
```

Recommended sender history metadata:

```ts
interface PeerMessageHistoryEntry {
  ...
  completion?: "none" | "notify" | "result";
  completionStatus?: "pending" | "completed" | "failed" | "cancelled";
}
```

Refresh must preserve sender status.

---

# 38. Compatibility

## Old history

Missing fields:

```text
completion
tool anchor
```

Fallback:

```text
completion = none
standalone sender card
```

## Old peers

Missing completion capability:

```text
treat completion as none
```

If capability negotiation exists, expose optional support.

Recommended typed failure for explicitly requested unsupported mode:

```text
COMPLETION_NOT_SUPPORTED
```

or compatible equivalent.

---

# 39. Required Hard Gates

## Gate A — Sender tool anchoring

Real Relay Web turn:

```text
A text
→ agent_send
→ A text
```

Assert presentation order:

```text
A text
agent_send ToolStep
Sent AgentMessageCard
A later text
```

Assert the sent card is not rendered as a duplicate standalone row.

Refresh and reload history.

Order must remain identical.

## Gate B — Receiver remains standalone

A sends to B.

B history:

```text
Received AgentMessageCard
B assistant turn
```

## Gate C — Legacy sender fallback

History contains a sender AgentMessage card with no matching tool correlation.

It must still render as a standalone card.

## Gate D — Autocomplete same-workspace priority

Current:

```text
instance A
workspace xacpx
```

Candidates:

```text
same workspace / other instance
same instance / other workspace
other instance / other workspace
non-relay
```

Empty query ordering:

```text
same workspace
same instance
other instance
non-relay
```

## Gate E — Explicit remote text match beats scope

Input:

```text
@文件浏览器功能
```

Exact remote target must rank above contextual fuzzy matches.

## Gate F — Archived/deleted absent

Archived/deleted endpoints must not appear if canonical directory excludes them.

## Gate G — Non-Relay presentation

A non-Relay endpoint remains selectable but visibly identifies its source.

## Gate H — Completion none

B completes.

Assert:

```text
no completion injected to A
no automatic follow-up turn on A
```

## Gate I — Completion notify

A sends:

```ts
completion: "notify"
```

B completes.

Assert:

```text
A receives exactly one trusted completion signal
no result body
B never calls agent_send
```

## Gate J — Completion result

A sends:

```ts
completion: "result"
```

B completes with final assistant text.

Assert A receives exactly one trusted peer-result with the bounded final assistant result.

## Gate K — Busy target correlation

B is already working.

A sends `completion=result`.

Another human/scheduled/peer prompt is also present.

Assert completion is generated only from the exact peer-triggered turn correlated with the original message ID.

## Gate L — Busy source completion queue

A is working when B finishes.

Assert completion queues behind A's current turn and does not start a parallel A turn.

## Gate M — Archived source

A sends request, then user archives A before B completes.

Assert:

```text
completion persisted / recorded
A not auto-restored
no live turn starts
```

## Gate N — Exactly-once completion

Simulate duplicate Relay completion delivery.

Assert:

```text
one source injection
one sender-card terminal update
one completion history effect
```

## Gate O — Peer failure

B's peer-triggered turn fails.

For `completion=result` or `notify`:

```text
A receives terminal failed completion exactly once
```

---

# 40. Suggested Implementation Areas

Likely core files:

```text
src/orchestration/agent-messaging-types.ts
src/orchestration/agent-message-router.ts
src/orchestration/agent-message-envelope.ts
src/orchestration/agent-endpoint-registry.ts

src/mcp/xacpx-mcp-tools.ts
src/mcp/xacpx-mcp-transport.ts

src/control/turn-queue.ts
src/control/session-turn-runner.ts
src/control/control-event-bus.ts

packages/relay-protocol/src/dtos.ts
packages/relay-protocol/src/messages.ts
packages/relay-protocol/src/web-dtos.ts

packages/channel-relay/src/control-bridge.ts
packages/channel-relay/src/tool-presentation.ts
packages/channel-relay/src/channel.ts

packages/relay/src/gateway/instance-gateway.ts
packages/relay/src/gateway/web-inbound.ts
packages/relay/src/http/app.ts

packages/relay-web/src/components/PromptInput.vue
packages/relay-web/src/components/MessageList.vue
packages/relay-web/src/components/TurnParts.vue
packages/relay-web/src/components/AgentMessageCard.vue
packages/relay-web/src/stores/chat.ts
packages/relay-web/src/stores/instances.ts
packages/relay-web/src/lib/turn-presentation.ts
```

Use actual repo architecture as source of truth.

Do not create parallel duplicate systems when an existing event/correlation path can be extended.

---

# 41. Engineering Invariants

The implementation must preserve:

```text
1. Agent Messaging directory is canonical eligibility truth.
2. Relay Web only ranks/presents directory entries.
3. Human identity and canonical routing identity remain separate.
4. agent_send returns delivery ACK, never peer model result inline.
5. Peer Agent never needs to acknowledge completion manually.
6. Completion is not a normal AgentMessage.
7. Completion is non-replyable and system-managed.
8. Completion result is bounded final assistant text only.
9. Exact peer turn correlation is explicit, never inferred by timing.
10. Sender card anchoring is explicit by messageId/tool correlation.
11. Receiver card remains standalone.
12. All session execution uses canonical TurnQueue serialization.
13. Archived sessions are never silently restored by peer completion.
14. Relay delivery retries must not duplicate completion effects.
15. No upstream dependency changes.
```

---

# 42. Definition of Done

This work is complete when:

1. Sender Agent Message cards render directly after the corresponding `agent_send` tool call.
2. Sender cards remain correctly positioned after refresh/history reload.
3. Receiver cards remain standalone.
4. Legacy sender cards without correlation still render.
5. `@Agent` autocomplete prioritizes:
   ```text
   same workspace
   → same instance
   → other instance
   → non-Relay / worker / unknown
   ```
6. Explicit text match outranks context priority.
7. Archived/deleted sessions are absent through canonical directory rules.
8. Non-Relay candidates remain available but visibly labeled.
9. `agent_send` accepts:
   ```text
   completion = none | notify | result
   ```
10. Default remains:
   ```text
   none
   ```
11. `agent_send` still returns immediately after delivery admission.
12. Peer Agent does not need to send a reply.
13. Exact peer-triggered turn is correlated with the original request message ID.
14. `notify` produces exactly one terminal completion signal.
15. `result` produces exactly one bounded final peer result.
16. Completion does not count as AgentMessage conversation traffic.
17. Completion cannot trigger automatic reply loops.
18. Busy source/target serialization is correct.
19. Archived source is not auto-restored.
20. Local and Relay federation paths behave consistently.
21. Unit tests, integration hard gates, Relay Web tests, type checks, builds, and CI are green.

---

# 43. Final Product Model

After v0.3, Agent Messaging should feel like:

```text
@ discovery
→ find the most relevant peer

agent_send
→ send one high-value message
→ optionally request completion/result

sender timeline
→ shows the send exactly where the tool call happened

receiver
→ gets a normal peer-input card
→ executes normal turn
→ does not need to send an acknowledgement

runtime
→ observes exact peer turn completion
→ optionally returns system-managed completion/result

sender
→ automatically resumes when needed
→ continues the user's task
→ no ping-pong
```

The guiding rule is:

> **Agents decide when collaboration is useful. xacpx owns identity, routing, ordering, completion correlation, and loop prevention.**
