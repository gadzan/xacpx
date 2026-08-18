# Agent Messaging Federation — Same-Account Relay v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement end-to-end Agent Messaging Federation across multiple real xacpx daemons connected to a Relay Hub under the same account.

**Architecture:** Location-independent messaging is wired end-to-end:

1. Daemons publish their active agent endpoints to Relay Hub via `instance.agent-endpoints.sync`.
2. Relay Hub maintains an authenticated, account-scoped soft directory and routes `agent.message.route` requests to target daemon sockets via `agent.message.deliver`.
3. Target daemon validates the inbound delivery, performs destination-side `messageId` deduplication, wraps the message in an `<xacpx-message>` envelope with an unforgeable canonical `from` handle, and injects it into the target session's `acpx` queue owner.
4. Returns the genuine target runtime delivery receipt to the source daemon.

**Tech Stack:** TypeScript, Bun, WebSocket (`ws`), Node.js, SQLite (Relay Hub state).

**Spec:** [Agent Messaging design](../specs/2026-08-11-agent-messaging-design.md) (Sections 4, 9, 12, 13, 14, 15, 17)

## Global Constraints

- Never expose secrets, raw IPC paths, PIDs, OS usernames, or absolute paths in published endpoint metadata.
- Sender identity is stamped by Relay Hub from the authenticated instance socket; client payloads cannot spoof `sourceNodeId` or `accountId`.
- All `agent_send` operations are one-way with delivery acknowledgement; delivery returns after the target daemon accepts injection.
- Message payload cap is 16 KiB measured with `Buffer.byteLength(content, "utf8")`.
- Offline target instances return `TARGET_NODE_OFFLINE` or `ROUTE_UNAVAILABLE` fail-fast (no offline store-and-forward).
- Target-side `messageId` deduplication guarantees exactly-once injection effect on network retries.
- E2E tests must use real daemons, real Relay Hub, and real mock ACP agents (no mocked registries or faked delivery ACKs).

---

### Task 1: Protocol & DTO Refinements for Federation

**Files:**

- Modify: `packages/relay-protocol/src/messages.ts`
- Modify: `packages/relay-protocol/src/dtos.ts`
- Test: `tests/unit/packages/relay-protocol/messages.test.ts`

- [ ] Add `sourceNodeId` and `sourceEndpointId` to `AgentMessageRoutePayload`.
- [ ] Ensure `AgentMessageDeliverPayload` has required `sourceNodeId`, `sourceEndpointId`, `targetEndpointId`, `messageId`, `content`, `requestedMode`, `replyTo`, and `replyable`.
- [ ] Add `relay.agent-directory.snapshot` message type if needed for remote presence fanout.
- [ ] Run `bun run build:relay-protocol` and `bun test tests/unit/packages/relay-protocol/`.
- [ ] Commit: `feat(relay-protocol): refine agent messaging federation payload types`

---

### Task 2: Connector-Side Upward Request Support in RelayClient

**Files:**

- Modify: `packages/channel-relay/src/relay-client.ts`
- Test: `tests/unit/packages/channel-relay/relay-client.test.ts`

- [ ] Add `sendRequest<T>(type: string, payload: unknown, options?: { timeoutMs?: number }): Promise<T>` to `RelayClient`.
- [ ] Generate request IDs (`relay-req-<seq>`), track pending requests with timeout timers, resolve on matching `res` envelope from server, reject on disconnect/timeout.
- [ ] Run `bun test tests/unit/packages/channel-relay/relay-client.test.ts`.
- [ ] Commit: `feat(channel-relay): add upward request support to RelayClient`

---

### Task 3: Relay Hub Identity Enforcement, Presence Directory & Routing

**Files:**

- Modify: `packages/relay/src/gateway/instance-gateway.ts`
- Test: `tests/unit/packages/relay/gateway/agent-messaging-routing.test.ts`

- [ ] Stamp `sourceAccountId` and `sourceInstanceId` from authenticated socket.
- [ ] Bind `nodeId` to `instanceId` on `instance.agent-endpoints.sync` — reject attempts to claim/hijack another instance's `nodeId` within the same account.
- [ ] Validate `targetEndpointId` is currently published by the target instance.
- [ ] Forward `agent.message.deliver` preserving exact `sourceNodeId` and `sourceEndpointId`.
- [ ] Broadcast/return directory snapshots or query methods for same-account instances.
- [ ] Handle empty sync list clearing stale entries, and disconnect clearing instance endpoints.
- [ ] Run `bun test tests/unit/packages/relay/gateway/agent-messaging-routing.test.ts`.
- [ ] Commit: `feat(relay-hub): enforce sender identity and route agent messages`

---

### Task 4: ControlService Delivery & Channel-Relay Inbound/Outbound Wiring

**Files:**

- Modify: `src/control/control-service.ts`
- Modify: `packages/channel-relay/src/channel.ts`
- Modify: `packages/channel-relay/src/control-bridge.ts`
- Test: `tests/unit/packages/channel-relay/control-bridge.test.ts`
- Test: `tests/unit/packages/channel-relay/channel.test.ts`

- [ ] Implement `deliverAgentMessage` in `ControlService` and wire to `AgentMessageRouter` / `SessionTransport.injectMessage`.
- [ ] Implement `getPublishedAgentEndpoints` in `ControlService` and wire to `AgentEndpointRegistry`.
- [ ] In `packages/channel-relay/src/control-bridge.ts`: dispatch `MSG.agentMessageDeliver` to `control.deliverAgentMessage(input)`.
- [ ] In `packages/channel-relay/src/channel.ts`: sync endpoints on `onReady` and provide `routeAgentMessage` helper for outbound messages.
- [ ] Run `bun run build:channel-relay` and `bun test tests/unit/packages/channel-relay/`.
- [ ] Commit: `feat(channel-relay): wire real agent message delivery and presence sync`

---

### Task 5: Remote Endpoint Directory & Router Multi-Node Dispatch

**Files:**

- Modify: `src/orchestration/agent-endpoint-registry.ts`
- Modify: `src/orchestration/agent-message-router.ts`
- Modify: `src/orchestration/relay-agent-message-route.ts`
- Modify: `src/main.ts`
- Test: `tests/unit/orchestration/agent-endpoint-registry.test.ts`
- Test: `tests/unit/orchestration/agent-message-router.test.ts`

- [ ] Support remote endpoint registration and discovery in `AgentEndpointRegistry`: `updateRemoteEndpoints(nodeId, endpoints)`.
- [ ] `listReachable` returns local candidates + authorized remote endpoints.
- [ ] `resolveTarget` resolves remote targets to remote endpoints without throwing `ROUTE_UNAVAILABLE`.
- [ ] `AgentMessageRouter` routes foreign node messages through `RelayAgentMessageRoute`.
- [ ] Destination-side dedupe in `AgentMessageRouter`: return cached receipt for already-delivered `messageId` on retry.
- [ ] Wire `RelayAgentMessageRoute` in `src/main.ts`.
- [ ] Run `bun test tests/unit/orchestration/`.
- [ ] Commit: `feat(orchestration): wire remote directory and router multi-node dispatch`

---

### Task 6: Full Multi-Daemon End-to-End Integration Test

**Files:**

- Create: `tests/integration/agent-messaging-federation.test.ts`

- [ ] Setup Daemon A, Relay Hub, and Daemon B with real mock ACP agents.
- [ ] Test A `agent_list` sees B's endpoints.
- [ ] Test A `agent_send` to B delivers `<xacpx-message>` into B's mock agent.
- [ ] Test B `agent_send` replies to A via `replyTo`.
- [ ] Test target offline returns `TARGET_NODE_OFFLINE`.
- [ ] Test network retry with same `messageId` performs exactly-once injection.
- [ ] Test presence update / empty sync cleans stale endpoints.
- [ ] Run `bun test tests/integration/agent-messaging-federation.test.ts`.
- [ ] Commit: `test(orchestration): add full multi-daemon agent messaging federation integration test`

---

### Task 7: Documentation, Prettier, and Full Monorepo Verification

**Files:**

- Modify: `docs/external-mcp.md`
- Modify: `docs/code-wiki.md`
- Modify: `docs/superpowers/specs/2026-08-11-agent-messaging-design.md`

- [ ] Update documentation and spec status reflecting production-wired same-account federation.
- [ ] Run `prettier`, `tsc --noEmit`, `bun run build:packages`, and full `bun test`.
- [ ] Commit: `docs(orchestration): document same-account agent messaging federation`

---

## Final Hardening (PR #284 review round)

Closed after the initial federation delivery, without expanding feature scope:

1. **Hub source identity fail-closed** — `agent.message.route` source node/endpoint must belong to the authenticated instance's currently published directory; mismatch → `DELIVERY_DENIED` (+ spoof regression tests). `replyable` derived from the source endpoint's `receive` capability + reverse-route availability, never hardcoded.
2. **Presence lifecycle** — instance disconnect removes endpoints and immediately broadcasts the shrunken snapshot to remaining same-account instances; online endpoint create/delete/capability change triggers a debounced FULL endpoint sync to the Hub (full replace, no delta protocol). E2E: remote `agent_list` auto-updates on disconnect/create/delete.
3. **Real network retry/idempotency** — the source route performs a bounded retry (default 3 attempts, linear backoff) on ambiguous network failures reusing the SAME `messageId`; typed business failures (`TARGET_NODE_OFFLINE`, `DELIVERY_DENIED`, …) never retry. ACK-loss E2E: target already injected, first ACK dropped at the Hub, source retries the same messageId, destination returns `deduplicated: true`, injection count exactly 1.
4. **Federation hard gate** — new `tests/integration/agent-messaging-federation-hardgate.test.ts`: real `buildApp` daemon A → real Relay Hub → real `buildApp` daemon B, real `SessionTransport.injectMessage` (npm-installed acpx), mock ACP agent; final proof is the mock agent's actual `.mock-agent-prompts.json` consumption of the remote `<xacpx-message>` (plus B→A reply, offline fail-fast, ACK-loss exactly-once, disconnect auto-update).
5. **Convergence** — `RelayClient.sendRequest` enforces an upward request-type allowlist (`agent.message.route`); remote Agent Message delivery logs report `route: "relay"` (derived from addresses, not hardcoded `"local"`); production `MessageChannelRegistry` now delegates `sendAgentMessageRoute`/`syncAgentEndpoints` so a real daemon's router actually reaches the relay channel (previously the registry lacked the method and the production route silently stayed unavailable); `AppRuntime.agentMessaging` exposes the production router for the hard gate.
