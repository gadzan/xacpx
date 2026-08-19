# Agent Messaging Collaboration UX v0.2 — Implementation Plan

> **Goal:** Deliver the user interaction, target selector resolution, structured `@Agent` mentions, trusted collaboration directives, and persistent chat timeline cards defined in the UX Spec.

---

## Plan Structure

### Phase 1: Core Target Selector & Lifecycle Filtering
- **Task 1.1**: Add `TARGET_AMBIGUOUS` error code and selector matching in `AgentEndpointRegistry`.
- **Task 1.2**: Filter sleeping and archived sessions from candidate discovery.
- **Task 1.3**: Wire `selector` into `AgentMessageRouter.send()` and MCP `agent_send` tool schema.
- **Task 1.4**: Unit test coverage for selector resolution, ambiguous matches, and lifecycle exclusion.

### Phase 2: Trusted Collaboration Directive & Context Injection
- **Task 2.1**: Extend `PromptRequest` with `agentMentions: Array<{ range: [number, number]; handle: string }>`.
- **Task 2.2**: Validate mention handles and format `<xacpx-collaboration-directive>` in `SessionTurnRunner`.
- **Task 2.3**: Prevent prompt-level XML spoofing by injecting directives exclusively through server-owned context.

### Phase 3: Persistent Peer Message Timeline Events
- **Task 3.1**: Define `PeerMessageHistoryEntry` in session history types.
- **Task 3.2**: Record outbound and inbound `agent_message` events in session transcript on delivery.
- **Task 3.3**: Expose peer message history entries in `ControlService.getSessionHistory()`.

### Phase 4: Relay Web UX (Composer @Mention & Timeline Cards)
- **Task 4.1**: Relay protocol DTO updates for `agentMentions` and `PeerMessageHistoryDto`.
- **Task 4.2**: Relay Web composer `@` autocomplete dropdown populated from active online agent directory.
- **Task 4.3**: `AgentMessageCard.svelte` rendering sender and receiver timeline cards with status indicators.
- **Task 4.4**: Background session active-idle auto-activation and unread badge synchronization.

### Phase 5: Integration & Verification
- **Task 5.1**: Comprehensive integration tests covering selector dispatch, directive injection, and timeline history.
- **Task 5.2**: Full test suite pass (`bun test` + `npx tsc --noEmit` + `bun run build:packages`).
