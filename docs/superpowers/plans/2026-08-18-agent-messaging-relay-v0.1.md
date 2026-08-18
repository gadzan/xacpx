# Agent Messaging — Relay Route & Remote Messaging v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement location-independent Agent Messaging across xacpx daemons connected via Relay Hub (Phases 10–12 of the spec): Relay Protocol wire types, Relay Hub message forwarding and soft directory cache, Channel Relay presence sync and delivery handler, and xacpx AgentMessageRouter multi-node routing.

**Architecture:** Location independence is achieved through route selection at the router layer. When `target.nodeId === self.nodeId`, the local delivery adapter executes the command; when `target.nodeId !== self.nodeId`, the router delegates to `RelayAgentMessageRoute` which invokes the authenticated Relay connection. Relay Hub authenticates the source instance/account, checks destination reachability, and forwards the message to the target instance via `agent.message.deliver`.

**Tech Stack:** TypeScript, Bun, WebSocket (`ws`), Node.js, SQLite (Relay Hub state).

**Spec:** [Agent Messaging design](../specs/2026-08-11-agent-messaging-design.md) (Sections 9, 12, 13, 14, 15, 17)

## Global Constraints

- Never expose secret tokens, raw IPC paths, PIDs, OS usernames, or absolute file paths in published endpoint metadata.
- Sender identity is stamped and verified by Relay Hub from the authenticated instance connection; client payloads cannot spoof source `accountId`, `nodeId`, or `instanceId`.
- Messages are one-way with delivery acknowledgement; delivery returns after the target daemon accepts injection/queueing.
- Message payload cap is 16 KiB measured with `Buffer.byteLength(content, "utf8")`.
- Offline target instances return `TARGET_NODE_OFFLINE` or `ROUTE_UNAVAILABLE` fail-fast (no store-and-forward in `agent_send`).
- All existing Task Orchestration, local terminal, and unit tests must remain passing.

---

### Task 1: Extend Relay Protocol with Agent Messaging Wire Messages

**Files:**

- Modify: `packages/relay-protocol/src/messages.ts`
- Modify: `packages/relay-protocol/src/dtos.ts`
- Test: `tests/unit/packages/relay-protocol/messages.test.ts` (or create if missing)

**Interfaces:**

- Produces:
  - `MSG.instanceAgentEndpointsSync`: `"instance.agent-endpoints.sync"`
  - `MSG.agentMessageRoute`: `"agent.message.route"`
  - `MSG.agentMessageDeliver`: `"agent.message.deliver"`
  - `PublishedAgentEndpointDto`: `{ nodeId, endpointId, displayName?, agent, state, capabilities, updatedAt }`
  - `InstanceAgentEndpointsSyncPayload`: `{ endpoints: PublishedAgentEndpointDto[] }`
  - `AgentMessageRoutePayload`: `{ targetNodeId: string; targetEndpointId: string; messageId: string; content: string; requestedMode: string; replyTo?: string }`
  - `AgentMessageDeliverPayload`: `{ sourceNodeId: string; sourceEndpointId: string; targetEndpointId: string; messageId: string; content: string; requestedMode: string; replyTo?: string; replyable: boolean }`
  - `AgentMessageRouteResult`: `{ messageId: string; status: "injected" | "queued" | "failed"; modeUsed?: string; targetState?: string; errorCode?: string }`

- [ ] **Step 1: Write the failing tests for message encoding/decoding**
- [ ] **Step 2: Add wire constants and payload interfaces in `packages/relay-protocol`**
- [ ] **Step 3: Run tests and typecheck**
- [ ] **Step 4: Commit**
      `feat(relay-protocol): define agent messaging wire protocol`

---

### Task 2: Implement Relay Hub Message Routing and Soft Directory Cache

**Files:**

- Modify: `packages/relay/src/gateway/instance-gateway.ts`
- Modify: `packages/relay/src/stores/instances.ts` (if instance metadata needed)
- Test: `tests/unit/packages/relay/gateway/agent-messaging-routing.test.ts`

**Interfaces:**

- Consumes: `MSG.agentMessageRoute`, `MSG.agentMessageDeliver`, `MSG.instanceAgentEndpointsSync`
- Produces: In-memory directory cache per account, message forwarding between online instances of the same account.

- [ ] **Step 1: Write failing tests for Hub routing: online target delivery, offline target failure, endpoint sync, and cross-account isolation**
- [ ] **Step 2: Implement `instanceAgentEndpointsSync` handler in `InstanceGateway`**
- [ ] **Step 3: Implement `agent.message.route` handler in `InstanceGateway` with same-account validation and forwarding to target socket via `agent.message.deliver`**
- [ ] **Step 4: Handle target instance offline with `errorPayload("TARGET_NODE_OFFLINE", "Target node is offline")`**
- [ ] **Step 5: Run tests and typecheck**
- [ ] **Step 6: Commit**
      `feat(relay-hub): route peer messages between authenticated instances`

---

### Task 3: Implement Channel Relay Presence Sync and Inbound Delivery

**Files:**

- Modify: `packages/channel-relay/src/channel.ts`
- Modify: `packages/channel-relay/src/control-bridge.ts`
- Test: `tests/unit/packages/channel-relay/channel-agent-messaging.test.ts`

**Interfaces:**

- Consumes: Inbound `MSG.agentMessageDeliver` from Relay Hub, outbound `MSG.instanceAgentEndpointsSync` and `MSG.agentMessageRoute`
- Produces: Bridge RPC to deliver incoming remote messages to local daemon, and push local endpoint changes to Hub.

- [ ] **Step 1: Write failing tests for inbound `agent.message.deliver` handling and sync on connect**
- [ ] **Step 2: Implement `onEvent` handling for `agent.message.deliver` in `RelayChannel`**
- [ ] **Step 3: Push `instanceAgentEndpointsSync` on `onReady` and endpoint inventory changes**
- [ ] **Step 4: Wire outbound `routeMessage` from control bridge to `RelayClient.sendRequest(MSG.agentMessageRoute, ...)`**
- [ ] **Step 5: Run tests and typecheck**
- [ ] **Step 6: Commit**
      `feat(channel-relay): handle remote agent message delivery and endpoint sync`

---

### Task 4: Implement Route Abstraction in AgentMessageRouter

**Files:**

- Modify: `src/orchestration/agent-message-router.ts`
- Modify: `src/orchestration/agent-endpoint-registry.ts`
- Modify: `src/orchestration/agent-messaging-types.ts`
- Create: `src/orchestration/relay-agent-message-route.ts`
- Test: `tests/unit/orchestration/agent-message-router.test.ts`
- Test: `tests/unit/orchestration/relay-agent-message-route.test.ts`

**Interfaces:**

- Consumes: `AgentMessageRoute` interface
- Produces: Router selects `LocalAgentMessageDelivery` when `target.nodeId === self.nodeId`, or `RelayAgentMessageRoute` when `target.nodeId !== self.nodeId`.

- [ ] **Step 1: Write failing tests for multi-node routing and remote endpoint directory resolution**
- [ ] **Step 2: Implement `RelayAgentMessageRoute` and wire remote dispatch in `AgentMessageRouter`**
- [ ] **Step 3: Return `ROUTE_UNAVAILABLE` when target is a foreign node and Relay Route is not connected**
- [ ] **Step 4: Run tests and typecheck**
- [ ] **Step 5: Commit**
      `feat(agent-messaging): route peer messages across messaging nodes`

---

### Task 5: End-to-End Multi-Daemon Integration Tests

**Files:**

- Create: `tests/unit/orchestration/agent-messaging-remote-integration.test.ts`

- [ ] **Step 1: Test simulated Node A sending message to Node B via in-memory Relay Gateway**
- [ ] **Step 2: Test bidirectional messaging and replyTo correlation across daemons**
- [ ] **Step 3: Test fail-fast error reporting when target daemon disconnects**
- [ ] **Step 4: Run all unit tests and verify 100% pass**
- [ ] **Step 5: Commit**
      `test(agent-messaging): verify multi-node remote message delivery`

---

### Task 6: Documentation and Full Repository Verification

**Files:**

- Modify: `docs/external-mcp.md`
- Modify: `docs/code-wiki.md`
- Modify: `docs/superpowers/specs/2026-08-11-agent-messaging-design.md`

- [ ] **Step 1: Update documentation reflecting location-independent Relay routing**
- [ ] **Step 2: Run `prettier`, `tsc --noEmit`, `npm test`, `bun run build:packages`**
- [ ] **Step 3: Commit**
      `docs(agent-messaging): document relay remote messaging`
