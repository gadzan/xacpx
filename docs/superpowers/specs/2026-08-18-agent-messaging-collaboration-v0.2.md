# Agent Messaging Collaboration v0.2 Specification

Status: Ready for Implementation  
Date: 2026-08-18  
Scope: Enhanced agent-to-agent collaboration semantics, discovery metadata, conversation threading, loop/spam guards, and lightweight trace for xacpx Agent Messaging within the same Relay account.

---

## 1. Problem Statement

Following the completion and verification of Local Queue-First v0.1 and Same-Account Relay Federation v0.1, xacpx provides reliable, exactly-once point-to-point message delivery across local and remote daemon processes (`agent_list`, `agent_send`).

However, the collaboration layer currently exhibits four major usability and safety deficiencies:

1. **Blind Discovery:** `agent_list` returns low-level technical handles (`agent:nodeId:endpointId`) and generic engine tags (`codex`, `running`), without conveying the peer's assigned role, logical workspace, or what it is actively doing. Senders cannot determine whether a peer is relevant to their task.
2. **Missing Conversation Identity:** While `replyTo` exists as an opaque correlation field, there is no top-level `conversationId` thread identity. Multi-turn interactions cannot be tracked as a coherent thread across retries, reconnects, or relay hops.
3. **Chat-Room & Ping-Pong Degeneration:** Without explicit behavioral constraints and deterministic system guardrails, autonomous LLM agents naturally fall into social conversational patterns (e.g. sending "Received!", "OK!", or "What are you working on?"), causing infinite acknowledgment ping-pong and wasted token budgets.
4. **Explainability Blind Spot:** When an agent abruptly changes its implementation direction or fails a turn, there is no lightweight trace to identify which peer message influenced that decision.

---

## 2. Goals & Non-Goals

### 2.1 Goals
- **Informed Discovery:** Enrich `agent_list` with derived, low-noise role, workspace, and activity metadata (`displayName`, `workspace`, `activity: { status, summary }`) without adding new authoritative state stores.
- **Fail-Closed Conversation Threading:** Establish deterministic `conversationId` threading backed by a bounded in-memory `MessageContext` registry. Root messages self-anchor (`conversationId = messageId`, `depth = 0`); replies require a resolvable parent context and increment `depth`. Missing or expired context fails closed with `REPLY_CONTEXT_UNAVAILABLE`.
- **Strict Communication Policy:** Provide concise, machine-friendly MCP descriptions and prompt instructions that restrict `agent_send` to genuine blockers and critical out-of-band updates, explicitly prohibiting acknowledgment messages.
- **Deterministic Loop & Spam Guards:** Enforce hard conversation depth limits, message count limits, duplicate content suppression, and rate limits inside `AgentMessageRouter` without fuzzy heuristics.
- **Idempotency-First Guard Execution:** Ensure transport-level retries hit the terminal outcome cache before evaluating any collaboration guards or incrementing counters.
- **Metadata-Only Trace:** Maintain a bounded in-memory ring buffer recording delivery metadata and content SHA-256 hashes (zero default raw text persistence) for diagnostics.
- **Mixed-Version Federation Safety:** Advertise `capabilities.conversation: boolean` across Relay presence, failing closed with `REPLY_NOT_SUPPORTED` if a reply targets an older node without thread support.

### 2.2 Non-Goals
- **No Realtime Steering:** Steering remains paused. Delivery remains strictly queue-first (`mode=queue` / `mode=auto` -> queue).
- **No Cross-Account / User-to-User Collaboration:** Collaboration is strictly bounded to the same user / same Relay account.
- **No Durable Agent Mail / Store-and-Forward:** Offline targets fail-fast (`TARGET_NODE_OFFLINE` / `TARGET_UNAVAILABLE`).
- **No Group Chat / Broadcast / Pub-Sub:** Every message is strictly point-to-point (one sender -> one target).
- **No External / Agent-Facing Trace Query Tool:** Trace history is for diagnostics, control API, and structured logs; no MCP tool is added for agents to browse message archives.

---

## 3. System Architecture & Boundaries

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Agent A (Coordinator / Worker)                     │
│  1. agent_list() -> Inspects peer roles, workspaces & derived activities    │
│  2. agent_send(to, message, replyTo?) -> Evaluates collaboration policy     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                             AgentMessageRouter                              │
│  Outbound Send:                                                             │
│  • Enforce sender identity & recipient authorization                        │
│  • Check target capability (if replyTo: verify capabilities.conversation)   │
│  • Check outbound guards: rate limit, duplicate content, depth, volume      │
│  • Resolve conversationId + depth from MessageContext (or fail-closed)      │
│  • Record sent MessageContext into local registry                           │
│  • Record metadata-only trace record (contentHash, contentLength)           │
│                                                                             │
│  Inbound Delivery:                                                          │
│  • 1. Idempotency First: outcome tombstone cache & in-flight single-flight  │
│  • 2. Duplicate retry -> return cached outcome (NO guard/counter pollution) │
│  • 3. First logical delivery -> register received MessageContext -> deliver │
└──────────────────────┬───────────────────────────────┬──────────────────────┘
                       │ Local Route                   │ Relay Route
                       ▼                               ▼
       ┌───────────────────────────────┐ ┌────────────────────────────────────┐
       │ LocalAgentMessageDelivery     │ │ RelayAgentMessageRoute             │
       │ Enqueues into target acpx     │ │ Forwards via Relay Hub to Remote B │
       └───────────────────────────────┘ └────────────────────────────────────┘
```

### Core Invariant: Zero Authoritative State Drift
Activity metadata is strictly a **derived view** computed at query time from existing state sources:
- **Workers:** Derived from `state.orchestration.tasks` (active task summary, role, status via `isAttentionRequiredTask`) and `workerBindings`.
- **Logical Sessions:** Derived from `state.sessions` (`alias`, `display_name`, `workspace`).
- **Remote Endpoints:** Replaced wholesale from `PublishedAgentEndpointDto` snapshots.

---

## 4. Data Model & Wire Envelope

### 4.1 Discovery Model (`AgentEndpointView`)

```ts
export interface AgentActivityView {
  /**
   * Operational status:
   * - "idle": Ready for instructions; no active task or turn.
   * - "working": Actively executing a task or turn.
   * - "waiting": Blocked on human confirmation or open question.
   */
  status: "idle" | "working" | "waiting";
  /**
   * Short, sanitized task summary (max 80 chars, no raw prompt/paths/secrets).
   * Present only when actively working on a task with a known summary.
   */
  summary?: string;
}

export interface AgentCapabilities {
  receive: boolean;
  steer: boolean;
  queue: boolean;
  interrupt: boolean;
  /** True when the endpoint supports v0.2 conversation threading (replyTo/conversationId). */
  conversation: boolean;
}

export interface AgentEndpointView {
  /** Opaque routing handle, e.g. "agent:node_1:endpoint_123" */
  handle: string;
  /** Friendly display identity: worker role or session displayName / alias */
  displayName?: string;
  /** Agent driver name, e.g. "codex", "claude", "opencode" */
  agent: string;
  /** Logical workspace name, e.g. "backend", "frontend" (NEVER absolute CWD) */
  workspace?: string;
  /** Legacy 3-state preserved for backward compatibility */
  state: "idle" | "running" | "unreachable";
  /** Derived collaboration activity */
  activity: AgentActivityView;
  /** Live message capabilities */
  capabilities: AgentCapabilities;
}
```

#### Derivation Rules in `AgentEndpointRegistry`:
1. **Worker Endpoints (`WorkerBindingRecord`):**
   ```ts
   const activeTask = Object.values(state.orchestration.tasks).find(
     (t) =>
       t.workerSession === workerSession &&
       (t.status === "running" || isAttentionRequiredTask(t)),
   );
   let activity: AgentActivityView;
   if (!activeTask) {
     activity = {
       status: "idle",
       summary: worker.role ? `Idle (${worker.role})` : "Idle",
     };
   } else if (activeTask.status === "running") {
     activity = {
       status: "working",
       summary: sanitizePublishedActivity(activeTask.summary),
     };
   } else {
     // isAttentionRequiredTask: needs_confirmation / blocked / waiting_for_human
     activity = {
       status: "waiting",
       summary:
         activeTask.status === "needs_confirmation"
           ? "Waiting for confirmation"
           : "Waiting for question response",
     };
   }
   ```
   *Note: `sanitizePublishedActivity` cleans newlines and clamps to 80 chars. It NEVER reads raw `activeTask.task`.*

2. **Logical Coordinator Sessions (`LogicalSession`):**
   ```ts
   const activity: AgentActivityView = {
     status: sessionHasActiveTurn ? "working" : "idle",
     // Logical coordinator sessions do not fabricate activity summaries from identity fields
     summary: undefined,
   };
   ```

### 4.2 Conversation Model & In-Memory Context Registry

```ts
export interface MessageContext {
  messageId: string;
  conversationId: string;
  depth: number;
  from: AgentAddress;
  to: AgentAddress;
  createdAt: number;
  expiresAt: number;
}

export interface AgentMessage {
  id: string;
  conversationId: string;
  depth: number;
  from: AgentAddress;
  to: AgentAddress;
  content: string;
  replyTo?: string;
  requestedMode: AgentMessageMode;
  createdAt: number;
  expiresAt?: number;
}
```

#### Conversation Identity Rules:
1. **Root Message (`replyTo` is undefined):**
   - `conversationId = message.id`
   - `depth = 0`
   - Router registers `MessageContext` into local `messageContexts` map (TTL: 1 hour).

2. **Reply Message (`replyTo` is provided):**
   - Router queries local `messageContexts` map for `replyTo`.
   - **Context Found:**
     - `conversationId = parent.conversationId`
     - `depth = parent.depth + 1`
     - If `depth > maxConversationDepth` (default 6) -> throw `CONVERSATION_LIMIT_REACHED`.
     - If total messages in `conversationId > maxMessagesPerConversation` (default 12) -> throw `CONVERSATION_LIMIT_REACHED`.
     - Router registers new reply's `MessageContext`.
   - **Context Not Found (Restart, Expired TTL, Unknown ID):**
     - Throw `REPLY_CONTEXT_UNAVAILABLE` (non-retryable).
     - The caller must initiate a new root message.
     - **No silent fallback** to `conversationId = replyTo`.

3. **Inbound Delivery Context Registration:**
   - Upon successful first logical inbound delivery, the destination router records the incoming message's context:
     `{ messageId, conversationId, depth, from, to, createdAt, expiresAt }`.
   - When the recipient agent later calls `agent_send({ to: fromHandle, replyTo: messageId })`, its local router resolves this context immediately.

4. **Agent-Facing MCP Contract:**
   - `agent_send` input schema **does not** accept `conversationId`.
   - `conversationId` is 100% server-managed and tamper-proof.

### 4.3 Envelope Representation (`<xacpx-message>`)

Rendered by `renderAgentMessageEnvelope`:

```xml
<xacpx-message id="msg_123" conversation-id="conv_abc" from="agent:node_1:endpoint_worker" replyable="true" reply-to="msg_120">
User schema updated: field `legacy_token` is removed; use `bearer_token`.
</xacpx-message>
```

---

## 5. Agent Communication Policy & MCP Tooling

### 5.1 MCP Tool Specifications

#### `agent_list`
```ts
{
  name: "agent_list",
  description:
    "List authorized peer agent sessions in scope, including their assigned roles, workspaces, and current activities (`status` and `summary`). Inspect this list before sending messages to ensure the target is relevant to your task.",
  inputSchema: z.object({}).strict(),
}
```

**Formatted MCP Output Example:**
```text
Authorized peer agents:
- agent:node_1:ep_worker1: API Worker [backend] (working: Implementing OAuth token migration; receive=true, queue=true, conversation=true)
- agent:node_1:ep_worker2: Test Runner [tests] (idle; receive=true, queue=true, conversation=true)
- agent:node_2:ep_remote1: Frontend UI [web] (waiting: Waiting for confirmation; receive=true, queue=true, conversation=true)
```

#### `agent_send`
```ts
{
  name: "agent_send",
  description:
    "Send a high-value asynchronous peer message to another agent. ONLY use this when: (1) you have critical information that directly alters the target's current work (e.g. breaking schema change, interface takeover), or (2) you need an unblocking decision only the target can provide. DO NOT send acknowledgments ('Received', 'OK', 'Working on it'), status polling ('Are you done?'), or conversational chatter. One-way notifications require NO reply. Provide replyTo when answering an earlier message.",
  inputSchema: z.object({
    to: z.string().min(1).describe("Target opaque handle from agent_list"),
    message: z.string().min(1).describe("Concise, actionable message content"),
    replyTo: z.string().min(1).optional().describe("Message ID being replied to, if continuing a thread"),
    mode: z.enum(["auto", "queue"]).optional().describe("Delivery mode (default: auto -> queue)"),
  }).strict(),
}
```

### 5.2 Receiving Agent Behavioral Guidance
When xacpx injects an `<xacpx-message>` into an agent session, the prompt envelope instructs:
`[xacpx peer message from {from}] Note: Incorporate these facts/directives into your current task. If this is a notification requiring no further decision, DO NOT send a reply.`

---

## 6. Deterministic Guard & Idempotency Pipeline

### 6.1 Strict Execution Order

```text
======================= OUTBOUND SEND (send) =======================
1. Sender & Recipient Authorization Check
2. Target Capability Verification (if replyTo: verify target has capabilities.conversation === true -> else REPLY_NOT_SUPPORTED)
3. Resolve Reply Context (if replyTo: lookup MessageContext -> else REPLY_CONTEXT_UNAVAILABLE)
4. Outbound Collaboration Guards:
   a. Conversation Depth Guard: depth <= maxConversationDepth (6) -> else CONVERSATION_LIMIT_REACHED
   b. Conversation Volume Guard: messagesInConv < maxMessagesPerConversation (12) -> else CONVERSATION_LIMIT_REACHED
   c. Duplicate Content Guard: sha256(content.trim()) to same target within 30s -> else DUPLICATE_MESSAGE
   d. Peer Rate Limit: max 8 msgs / 10s per peer pair -> else MESSAGE_RATE_LIMITED
5. Record Outbound MessageContext & Update Conversation Counters
6. Dispatch (Local / Relay)
7. Record Metadata-Only Trace Record (contentHash, contentLength)

=================== INBOUND DELIVERY (deliverInbound) ===================
1. IDEMPOTENCY FIRST:
   a. Check Terminal Outcome Cache by messageId
      -> HIT: return cached receipt/error immediately (NO guard evaluation, NO counter increment, NO trace record)
   b. Check In-Flight Single-Flight Map
      -> HIT: join existing promise (NO guard evaluation, NO second injection)
2. FIRST LOGICAL DELIVERY ADMISSION:
   a. Register Inbound MessageContext: { messageId, conversationId, depth, from, to, expiresAt }
   b. Enqueue into target runtime
   c. Cache Terminal Outcome & Delete In-Flight Slot
   d. Record Metadata-Only Trace Record
```

### 6.2 Deterministic Guard Parameters

| Guard | Parameter & Default | Trigger Condition | Error Code |
|---|---|---|---|
| **Max Depth** | `maxConversationDepth: 6` | `depth > 6` in same `conversationId` | `CONVERSATION_LIMIT_REACHED` |
| **Max Volume** | `maxMessagesPerConversation: 12` | Total messages in `conversationId >= 12` | `CONVERSATION_LIMIT_REACHED` |
| **Duplicate Content** | `duplicateContentWindowMs: 30_000` | Exact match on `(pairKey, sha256(content.trim()))` within 30s | `DUPLICATE_MESSAGE` |
| **Peer Rate Limit** | `maxMessages: 8, windowMs: 10_000` | Exceeding peer-pair throughput limit | `MESSAGE_RATE_LIMITED` |

All guard errors are typed `AgentMessagingError`, non-retryable, and logged to the metadata trace buffer.

---

## 7. Metadata-Only Trace Policy

### 7.1 Data Structure
A bounded in-memory ring buffer (capacity: 256 records) inside `AgentMessageRouter`:

```ts
export interface AgentMessageTraceRecord {
  messageId: string;
  conversationId: string;
  depth: number;
  replyTo?: string;
  from: AgentAddress;
  to: AgentAddress;
  route: "local" | "relay";
  createdAt: number;
  deliveredAt?: number;
  status: "injected" | "queued" | "failed";
  modeUsed?: "steer" | "queue" | "interrupt" | "prompt";
  deduplicated?: boolean;
  errorCode?: AgentMessagingErrorCode;
  contentLength: number;
  contentHash: string; // SHA-256 hex digest of trimmed content
}
```

### 7.2 Safety & Privacy Rules
- **No Raw Content Persistence:** Message text is **never** stored in the trace buffer by default.
- **Deterministic Correlation:** `contentHash` (`sha256(content.trim())`) allows tracking duplicates and verifying data flow without leaking text.
- **Diagnostic API:** Exposed via `ControlService.getAgentMessageTrace(limit?: number)` for daemon diagnostics and test assertions; **not exposed as an MCP tool** to agents.

---

## 8. Relay / Presence Protocol DTO Updates

### 8.1 DTO Updates in `@ganglion/xacpx-relay-protocol`

#### `PublishedAgentEndpointDto`
```ts
export interface PublishedAgentEndpointDto {
  nodeId: string;
  endpointId: string;
  displayName?: string;        // Unified friendly name (worker role or session alias/displayName)
  agent: string;
  workspace?: string;          // Logical workspace name
  state: "idle" | "running";
  activity?: {                 // Derived activity view
    status: "idle" | "working" | "waiting";
    summary?: string;
  };
  capabilities: {
    receive: boolean;
    steer: boolean;
    queue: boolean;
    interrupt: boolean;
    conversation?: boolean;    // NEW: v0.2 conversation threading support
  };
  labels?: string[];
  updatedAt: number;
}
```

#### `AgentMessageRoutePayload` & `AgentMessageDeliverPayload`
```ts
export interface AgentMessageRoutePayload {
  sourceNodeId: string;
  sourceEndpointId: string;
  targetNodeId: string;
  targetEndpointId: string;
  messageId: string;
  conversationId?: string;     // Thread identity
  depth?: number;              // Thread depth
  content: string;
  requestedMode: string;
  replyTo?: string;
}
```

*Note: Wire fields are optional. Mixed-version federation handles absent `conversation` capability by rejecting replies with `REPLY_NOT_SUPPORTED`.*

---

## 9. Failure & Error Matrix

| Error Code | Layer | Retryable | Cause | Agent Remediation |
|---|---|---|---|---|
| `REPLY_CONTEXT_UNAVAILABLE` | Router (Send) | No | `replyTo` context expired, unknown, or lost due to daemon restart. | Re-send as a fresh root message without `replyTo`. |
| `REPLY_TARGET_MISMATCH` | Router (Send) | No | A reply was directed to an endpoint other than the parent message's author. | Send replies only back to the peer that authored the parent message. |
| `REPLY_NOT_SUPPORTED` | Router (Send) | No | Target endpoint does not advertise `capabilities.conversation: true`. | Send a root message without `replyTo`. |
| `CONVERSATION_LIMIT_REACHED` | Router (Send) | No | Thread depth (>6) or volume (>=12) exceeded. | Stop replying in this thread; start fresh task. |
| `DUPLICATE_MESSAGE` | Router (Send) | No | Identical content sent to same target within 30s. | Do not repeat identical messages. |
| `MESSAGE_RATE_LIMITED` | Router (Send) | No | Rate limit (8 msgs / 10s) exceeded for peer pair. | Back off and wait before sending again. |
| `SELF_MESSAGE_NOT_ALLOWED` | Router (Send) | No | Agent attempted to send message to its own handle. | Send to a distinct peer. |
| `TARGET_NOT_FOUND` | Router / Hub | No | Target endpointId does not exist in local/remote directory. | Re-run `agent_list` to fetch updated handles. |
| `TARGET_NODE_OFFLINE` | Router / Hub | No | Remote destination daemon is disconnected. | Wait for node reconnection or reassign task. |
