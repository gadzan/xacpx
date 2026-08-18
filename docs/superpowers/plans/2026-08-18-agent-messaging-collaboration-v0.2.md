# Agent Messaging Collaboration v0.2 Implementation Plan

> **Goal:** Upgrade Agent Messaging from functional point-to-point infrastructure to low-noise, high-value agent collaboration within the same Relay account.
> **Spec:** [Agent Messaging Collaboration v0.2 Spec](../specs/2026-08-18-agent-messaging-collaboration-v0.2.md)

---

## 1. Scope & Invariants

### Included:
1. Rich discovery metadata in `agent_list` (`displayName`, `workspace`, `activity: { status, summary }`) derived from existing tasks and sessions (reusing `isAttentionRequiredTask` and `sanitizePublishedActivity`).
2. Deterministic `conversationId` and `depth` thread propagation backed by an in-memory `MessageContext` registry with fail-closed `REPLY_CONTEXT_UNAVAILABLE` (no guessing/fallbacks).
3. Strict anti-spam, anti-ping-pong MCP descriptions and prompt instructions.
4. Idempotency-first inbound execution: transport retries never pollute guard state, conversation counters, or trace logs.
5. Deterministic depth (`maxConversationDepth = 6`), volume (`maxMessagesPerConversation = 12`), duplicate content (30s window), and peer rate limits in `AgentMessageRouter`.
6. Bounded metadata-only trace ring buffer (last 256 messages, storing `contentHash = sha256(content)`, zero raw text).
7. Same-account Relay federation parity for discovery and conversation metadata with fail-closed `REPLY_NOT_SUPPORTED` on older nodes.

### Excluded:
1. Realtime steering (remains paused).
2. Cross-account / user-to-user collaboration.
3. Durable store-and-forward mail.
4. Group chat / broadcast messaging.
5. External MCP trace search tool for agents.

---

## 2. Tasks & Detailed Steps

### Task 1: Relay Protocol DTO Updates
**Files:**
- `packages/relay-protocol/src/dtos.ts`
- `packages/relay-protocol/src/messages.ts`

**Changes:**
- Update `PublishedAgentEndpointDto`:
  - Ensure single unified `displayName?: string`.
  - Add optional `workspace?: string` and `activity?: { status: "idle" | "working" | "waiting"; summary?: string }`.
  - Add `conversation?: boolean` to `capabilities`.
- Update `AgentMessageRoutePayload` and `AgentMessageDeliverPayload` to include optional `conversationId?: string` and `depth?: number`.
- Build protocol package: `bun run build:relay-protocol`.

---

### Task 2: Endpoint Registry Activity & Metadata Derivation
**Files:**
- `src/orchestration/agent-messaging-types.ts`
- `src/orchestration/agent-endpoint-registry.ts`
- `tests/unit/orchestration/agent-endpoint-registry.test.ts`

**Changes:**
- Add `AgentActivityView` and `conversation: boolean` to `agent-messaging-types.ts`.
- In `agent-endpoint-registry.ts`:
  - Implement derived `activity` calculation in `listCandidates`:
    - For workers: use `activeTask.status === "running"` -> `working` + `sanitizePublishedActivity(activeTask.summary)`. Use `isAttentionRequiredTask(activeTask)` -> `waiting`. Otherwise -> `idle`. (NEVER read raw `task.task`).
    - For logical sessions: `activity.status = sessionHasActiveTurn ? "working" : "idle"`, `summary = undefined`.
  - Populate `displayName` (worker role / targetAgent, or session alias/displayName) and `workspace`.
  - Update `syncRemoteDirectorySnapshot` and `getPublishedEndpoints` to map the updated DTO fields and advertise `capabilities.conversation = true`.
- Unit tests: verify idle/working/waiting activity derivation for workers, title/status derivation for logical sessions, and remote snapshot sync.

---

### Task 3: Conversation Context, Threading & Fail-Closed Errors
**Files:**
- `src/orchestration/agent-messaging-types.ts`
- `src/orchestration/agent-messaging-error.ts`
- `src/orchestration/agent-message-envelope.ts`
- `src/orchestration/agent-message-router.ts`
- `src/orchestration/relay-agent-message-route.ts`
- `tests/unit/orchestration/agent-message-envelope.test.ts`
- `tests/unit/orchestration/agent-message-router.test.ts`

**Changes:**
- Add typed errors to `agent-messaging-error.ts`:
  - `REPLY_CONTEXT_UNAVAILABLE`
  - `REPLY_NOT_SUPPORTED`
  - `CONVERSATION_LIMIT_REACHED`
  - `DUPLICATE_MESSAGE`
- Update `renderAgentMessageEnvelope` to include `conversation-id="{conversationId}"`.
- In `agent-message-router.ts`:
  - Maintain `messageContexts` Map (`{ messageId, conversationId, depth, from, to, createdAt, expiresAt }`).
  - Maintain conversation volume tracker Map (`conversationId -> count`).
  - In `send()`:
    - If `replyTo`: verify target `capabilities.conversation === true` (else `REPLY_NOT_SUPPORTED`). Lookup `MessageContext` (else `REPLY_CONTEXT_UNAVAILABLE`).
    - Assign `conversationId` and `depth`.
    - Check `depth <= maxConversationDepth` (6) and `volume < maxMessagesPerConversation` (12) (else `CONVERSATION_LIMIT_REACHED`).
    - Check duplicate content window (30s per `(pairKey, sha256(content))`) (else `DUPLICATE_MESSAGE`).
    - Check peer rate limit (8 msgs / 10s) (else `MESSAGE_RATE_LIMITED`).
    - Register sent `MessageContext`.
  - In `deliverInbound()`:
    - **IDEMPOTENCY FIRST**: Outcome cache check & single-flight join happen BEFORE any guard evaluation, context registration, or counter increments.
    - On first logical delivery: register inbound `MessageContext` so recipient can subsequently reply.
- Update `relay-agent-message-route.ts` to forward `conversationId` and `depth`.
- Unit tests: verify conversation identity assignment, missing context rejection (`REPLY_CONTEXT_UNAVAILABLE`), depth/volume limits, duplicate content suppression, and idempotency-first isolation.

---

### Task 4: Bounded Metadata-Only Trace Ring Buffer
**Files:**
- `src/orchestration/agent-messaging-types.ts`
- `src/orchestration/agent-message-router.ts`
- `src/control/control-service.ts`
- `tests/unit/orchestration/agent-message-router.test.ts`

**Changes:**
- Define `AgentMessageTraceRecord` in `agent-messaging-types.ts` with `contentHash` and `contentLength` (zero raw text).
- In `agent-message-router.ts`:
  - Maintain circular buffer of the last 256 `AgentMessageTraceRecord`s.
  - Record metadata on every logical send and inbound delivery outcome.
  - Expose `getTraceRecords(limit?: number)` method.
- Expose diagnostic query in `control-service.ts`.
- Unit tests: verify ring buffer rollover, metadata accuracy, and content hash correlation.

---

### Task 5: MCP Tool Instructions & Output Formatting
**Files:**
- `src/mcp/xacpx-mcp-tools.ts`
- `tests/unit/mcp/xacpx-mcp-tools.test.ts`

**Changes:**
- Update `agent_list` description to emphasize inspecting peer roles, workspaces, and activities.
- Format `agent_list` text output to display `displayName`, `workspace`, `activity.status`, `activity.summary`, and capabilities.
- Update `agent_send` description with concise collaboration policy (strict blocker/critical update rule, no ACK rule, one-way notification rule, no conversationId input parameter).

---

### Task 6: End-to-End Collaboration Integration Suite
**Files:**
- `tests/integration/agent-messaging-collaboration.test.ts`

**Scenarios Covered:**
- **Scenario A:** High-value notification (Worker A modifies schema -> Worker B consumes without ACK).
- **Scenario B:** Meaningful reply thread (A -> B -> A with shared `conversationId`, increasing depth, and exact context resolution).
- **Scenario C:** Missing / expired reply context (replying with invalid `replyTo` -> `REPLY_CONTEXT_UNAVAILABLE`).
- **Scenario D:** Conversation depth and volume limit enforcement (`CONVERSATION_LIMIT_REACHED` at depth 7 / volume 12).
- **Scenario E:** Same-Account Relay federation collaboration (cross-daemon discovery, conversation ID preservation, loop guards, and duplicate content rejection across nodes).

---

### Task 7: Documentation Updates
**Files:**
- `docs/external-mcp.md`
- `docs/superpowers/specs/2026-08-11-agent-messaging-design.md`

**Changes:**
- Update `docs/external-mcp.md` to document the new `agent_list` output format and `agent_send` collaboration policy.
- Update design spec status and roadmap to reflect Collaboration v0.2.

---

## 3. Definition of Done (DoD)

1. `npx tsc --noEmit` and `bun run build:packages` complete with zero errors.
2. All unit and integration tests pass cleanly:
   ```bash
   bun test tests/unit/orchestration/
   bun test tests/integration/agent-messaging-collaboration.test.ts
   ```
3. Full test sweep passes with zero regressions on existing suites.
4. No new persistent database tables or authoritative state drift introduced.
5. All 5 E2E collaboration scenarios verified.
