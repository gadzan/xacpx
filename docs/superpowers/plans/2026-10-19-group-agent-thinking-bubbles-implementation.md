# Implement Group Agent Thinking Bubbles — Executable Engineering Plan

Status: Ready for implementing Agent; code implementation NOT started
Date: 2026-10-19
Branch: feat/group-agent-thinking-bubbles
Contract: docs/superpowers/specs/2026-10-19-group-agent-thinking-bubbles-design.md
Agent handoff: docs/superpowers/plans/2026-10-19-group-agent-thinking-bubbles-agent-handoff.md

## 0. Delivery instruction

This PR is the **feature PR**, not a docs-only PR. Implement every phase on the existing head branch; do not open a separate implementation PR. Keep this PR draft until requirements, regression tests, real reload recovery, and UI verification pass. Commit incrementally by boundary. Never merge automatically.

The accepted UX decisions are frozen in the spec. Resolve implementation details through code inspection and tests; do not silently narrow the scope (especially persistent history). Report any unavoidable requirement conflict with concrete code evidence rather than inventing a new user experience.

## 1. Source map and invariants to read first

| Concern | Current source | Existing invariant |
| --- | --- | --- |
| Group transcript/render | packages/relay-web/src/components/GroupTranscript.vue | TranscriptRow, Handoff, seq order, scroll anchor, group-run-card |
| Group state | packages/relay-web/src/stores/groups.ts | activeRun owner, memberTurns projected only for active Run, idempotent prompt/cancel/reconnect |
| Direct reference | packages/relay-web/src/components/ConversationMessageList.vue | Avatar + live HUD + trace parts; do not change Direct UX |
| Group public handoff | packages/relay-web/src/components/GroupHandoffEntry.vue | scoped member/result joins and read-only history |
| Bot states | packages/relay-web/src/components/BotAvatar.vue; src/lib/bot-avatar-state.ts | exact member state, observed completion, no global busy |
| Rich trace | packages/relay-web/src/components/TurnParts.vue, PlanPanel.vue | canonical ordered TurnPartDto / ToolStepDto |
| Message/run types | src/conversations/conversation-types.ts; src/control/conversation-control-dtos.ts; packages/relay-protocol/src/dtos.ts | requestMessageId, sourceTurnId, member attempt, seq |
| Scheduling | src/conversations/conversation-run-service.ts; conversation-dispatcher.ts; conversation-turn-runner.ts | Run authority, retry, recovery, safe cancellation |
| Source stream | src/control/session-turn-runner.ts; control-event-bus.ts | exact conversation correlation, turn events |
| Tool mapping | packages/channel-relay/src/tool-presentation.ts | bounded user-visible ToolStepDto; must not duplicate drift |
| Durable data | src/conversations/sqlite-conversation-store.ts; conversation-store.ts | idempotent SQLite migrations, topic lifecycle deletion |
| Core wiring | src/conversations/conversation-composition.ts; src/main.ts | production Conversation store lifetime and event bus |
| Public RPC | src/control/control-service.ts; packages/channel-relay/src/control-bridge.ts; packages/relay-protocol/src/messages.ts | validated requests; forbid private peer topics |
| Existing tests | packages/relay-web/src/__tests__/group-components.test.ts, groups-store.test.ts, group-handoff-history.test.ts; tests/unit/conversations/ | keep old scheduling guarantees |

Required preflight: confirm current branch/head and any intervening changes. The plan describes the audited October 19 default branch. If specific symbols have moved, locate the equivalent; do not blindly paste old code.

## 2. Phase 1: foundation — immutable identities and secure normalized trace model

### 2.1 Physical turn identity

Problem: existing ConversationTurnCorrelation carries only conversationId/topicId/botId/runId/memberTurnId, while recovered MemberTurns can advance attempt and sourceTurnId. Correlation alone cannot tell a delayed old-attempt tool event from current execution.

Implement:

1. Add the **trusted** member attempt and sourceTurnId (optional wire-compat fields) from the dispatcher after markExecutionStarted to ConversationTurnRunInput, then into ControlConversationTurnRunner.run → session-turn-runner's conversation metadata on *every* public correlated stream event.
2. Propagate optional fields through src/control/conversation-control-dtos.ts, src/control/control-event-bus.ts, packages/relay-protocol/src/dtos.ts and relevant Relay projection/strict parsing. Existing consumers that only read the five original keys must keep working.
3. Trace recorder validates that the durable store's MemberTurn is in the requested scope, Bot and Run match, and current sourceTurnId/attempt exactly matches the emitted event before writing. Reject stale, missing or conflicting identity. Do not infer attempt from a timestamp or use a sessionAlias fallback.
4. Do not alter authorization origin, private groupExecutionToken handling, cancellation identity or how dispatcher claims/retries work.
5. Add unit tests for active attempt, old-attempt late event, sourceTurn mismatch, foreign topic/Run/Bot, synthetic event without required correlation, and private peer Topic.

### 2.2 Shared public tool normalization

Refactor existing pure tool presentation conversion without changing output:
- Source of truth currently packages/channel-relay/src/tool-presentation.ts (toolUseEventToStepDto and its helpers, including truncation markers and subagent/agent-send logic).
- Move the pure mapper to an appropriately dependency-safe shared source/package and re-export the old channel-relay API as needed. Avoid Core → channel-relay dependency, circular dependencies, and importing a production transport into Core.
- The recorder writes the same sanitized ToolStepDto shape that clients currently see; adapt interfaces structurally instead of requiring plugin-api package implementation dependencies in a low-level shared package.
- Test golden equivalence on tool event fixtures (diff, command, read, search, errors, subagent, agent_send, terminal-only and truncation). Ensure the recorder does not persist rawInput/rawOutput fields or private metadata.

Definition of done: the same public normalized event has identical visible rendering in existing live Group and new persisted Group detail; incompatible/malicious inputs cannot disclose new information.

## 3. Phase 2: durable Group trace store, migrations and replay

### 3.1 Database schema and lifecycle

Add idempotent additive tables in existing conversations.sqlite schema/migration, with concrete names such as:

~~~sql
CREATE TABLE IF NOT EXISTS member_turn_traces (
  member_turn_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  conversation_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  recording_state TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  plan_json TEXT,
  interruption_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (member_turn_id, attempt)
);
CREATE TABLE IF NOT EXISTS member_turn_trace_events (
  member_turn_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (member_turn_id, attempt, seq)
);
CREATE INDEX IF NOT EXISTS idx_member_trace_scope
  ON member_turn_traces (conversation_id, topic_id, run_id);
~~~

The schema is an implementation sketch, not license to duplicate an existing database abstraction: use the established SqliteConversationStore transaction/migration adapter and matching compile-time types. Check SQLite adapter FK policy before choosing explicit cascades. Do not delete prior records during migration.

Apply deletion inside *each* existing transactional path:
- deleteTopicRows (teardown)
- deleteTopicHistory / retireTopicContext (clear default Topic)
- deleteConversationRows (Group delete)
- any additional migration/garbage-collection path deleting member_turns/runs

Delete both trace tables before parent rows unless appropriate verified cascading FKs are in place. Ensure rejected/rollback lifecycle operations retain traces. Add migration-from-real-older-schema, repeated-open, duplicate-cleanup and Topic clear/teardown tests.

### 3.2 Durable event writer

Implement a store helper / recorder supporting:
- start-or-resume an exact (memberTurnId, attempt, sourceTurnId) physical stream with durable scope;
- append text and visible reasoning in order, tool step updates, plan replace-latest, and final marker;
- allocate seq monotonically within SQLite transaction; retried same writer batch must not duplicate events;
- replay normalized ordered events and plan; return explicit recording state and pagination cursor;
- on process restart, mark unclosed recording sessions as **interrupted**, not complete. If live recovery resumes a new attempt, do not append new events to old attempt.
- source of event state may arrive before/after product member-finished events; write final observed trace marker only when the true turn-finished event is accepted, never just because Run status turned terminal.
- if a Group member was cancelled/fails *before* the provider turn starts, it has no physical trace; show durable member outcome without fabricated turn events.
- if a recorder write fails, preserve execution/cancellation semantics and make the missing/partial trace visible; never persist fake completion.

Choose a bounded batch strategy whose flush and order correctness are proved by tests. The event bus currently emits synchronously; avoid a synchronous disk write for every text token if it measurably blocks execution. Flush on the exact terminal path, ensure shutdown/drain awaits outstanding flushes where safe, bound memory/backlog, and record an explicit loss/partial state if events could not be made durable.

Plan output is Run-level today; define the current Run Plan snapshot and, if exact per-member plan events are retained, annotate their actual source. Do not assume every Plan entry belongs exclusively to the selected Agent.

Keep full public recorded history for the lifetime of the Topic; do not silently discard old pages, impose tiny ring buffers, or replace detailed events with only a summary. Page read responses to limit memory and protocol payload.

### 3.3 Recorder wiring

Production wiring: src/main.ts creates core event bus before createConversationRuntime. Bind the Group trace recorder **after** ConversationRuntime/store is created and before dispatch can execute (respect consumer-lock activation). Dispose it during shutdown; avoid leaked handlers or double subscription on restart/rebind.

Write tests proving:
- interleaved events preserve text, thought, tool, Plan ordering;
- toolCallId progress→terminal updates replay correctly;
- concurrent MemberTurns never collide in seq or result;
- sourceTurnId/attempt mismatch is rejected;
- mid-write crash/restart yields interrupted, not fabricated complete;
- terminal marker persists before reader observes complete;
- lifecycle deletes traces together with Run rows;
- recorder cannot observe or return private peer/direct conversation data.

## 4. Phase 3: explicit read-only RPC and backward compatibility

### 4.1 Batch details

Proposed new message: control.runs.details.batch

Request:
~~~ts
{ conversationId: string; topicId: string; runIds: string[] } // unique, 1..50
~~~

Response:
~~~ts
{ runs: ConversationRunDetailDto[]; missingRunIds?: string[] }
~~~

Only return runs verified by durable store as public Group members of exact conversation+topic. Reject duplicate IDs, excessive batch length, bad types or foreign scope. Never leak a member profile's private instructions/execution secrets. Existing runs.get returns profileSnapshot: scope this new surface to presentation-safe snapshots only, if saved removed-Bot avatar/name fallback is needed.

### 4.2 Paged trace

Proposed new message: control.runs.trace.get

Request:
~~~ts
{
  conversationId: string; topicId: string;
  runId: string; memberTurnId: string; attempt: number;
  afterSeq?: number; limit?: number;
}
~~~

Response:
~~~ts
{
  memberTurnId: string; attempt: number; recordingState: "recording" | "complete" | "interrupted" | "unavailable";
  completenessReason?: string; events: Array<{seq:number;kind:string;payload:unknown;createdAt:string}>;
  nextSeq?: number; hasMore: boolean; plan?: PlanEntryDto[];
}
~~~

Strictly decode inputs and response shapes with existing protocol validator conventions. Clamp page size (recommend default 50, max 100) and payload bytes; use monotonically ordered seq. Distinguish empty trace from unavailable/legacy trace. If old connectors return unknown-type, show honest limited-history status; never silently use ephemeral browser state as a claim of historical durability.

### 4.3 Core ↔ Connector ↔ Relay ↔ Web

Implement DTOs/messages/decoders, channel-relay control-bridge dispatch, PublicControlService/Core read-only access, Hub RPC routing where applicable, and Web api calls. Keep existing runs.get, runs.list, history, prompt, cancel and other channels backward compatible. Public reads must use the same private peer Topic denial as existing Control getRun.

Do **not** add a second HTTP endpoint outside the established Relay RPC path. Do not leak execution/writer identifiers not required by the UI. Pagination and cache requests cannot mutate current run/composer/cancel state.

Required tests: strict validation negative cases, wrong scope, private peer, missing trace, pagination and bounds, legacy connector unknown-type, synthetic id collisions, and request coalescing.

## 5. Phase 4: Group presentation and store projection

### 5.1 Model: independent of activeRun

Create packages/relay-web/src/lib/group-run-presentation.ts, pure projection from:
- ConversationMessageDto[] in durable seq order;
- scoped RunDetailDto map (history + current);
- member turns and their current attempts;
- current stream/current ownership metadata.

Output discriminated items for human message, canonical Bot message with attached MemberTurn, public handoff, system message, temporary MemberTurn activity, and neutral routing entry. Use stable IDs and do not write synthetic records into groups.messages.

Algorithm:
1. Iterate messages in seq order.
2. Associate each Run via Run.requestMessageId and exact conversation/topic.
3. Resolve strict MemberTurn↔Bot reply correlation by promptRequestId; only fallback with provable unique Bot membership in same Run.
4. Render canonical Bot message once at its original seq with member bubble above its text; duplicate outputs remain separate canonical messages but the single member bubble anchors on first proven reply.
5. Render activity-only MemberTurn items at the owning request for members with no proven reply; group deterministic sibling order by (batch, memberIndex, id), not by latest runtime event timing.
6. Render neutral router item only when a real Run has no known members and routing/stop/waiting/error still needs an entry.
7. Never assign mismatching/ambiguous public reply to a MemberTurn or drop that message; show a scoped not-linked explanation, not an invented completed step.

Be explicit about synthetic row scroll IDs: do not conflate rowId, message id and member id. Maintain stable keyed identity through promotion of temporary item into canonical message; if its DOM node necessarily moves from request anchor to seq reply, restore scroll anchor while keeping the durable message at the correct position.

### 5.2 Store read-model

Keep groups.activeRun and its ownership/cancel/recovery exactly as is. Add **separate** scoped historical projection/cache for runs, members, and trace pages. Cache keyed on [instanceId, conversationId, topicId, runId] plus memberTurnId/attempt; share coalesced in-flight reads; fence responses on scope generation; bounded client memory and clear on Topic switch/deletion/instance change. No historical API call may set activeRun, memberTurnsById, cancellingRunId, uncertainPrompt, planByRunId or transcript cursors.

On initial/newer/older conversation history page: collect visible runIds, batch fetch absent summaries without blocking the Composer. In-flight run events update only the exact matched historical/current read-model. For new accepted group runs, mirror known member metadata into the read-model promptly so first bubble appears before later history RPC.

Lazy-fetch trace when popover opens; fetch subsequent pages via cursor; coalesce repeated opens; when open during live turn, combine fast presentation with durable cursor without duplication and reconcile on reconnect. Do not reuse existing completeRunParts-only semantics as historical authority.

### 5.3 UI components

Add focused components (names can vary if codebase has equivalent):
- GroupAgentTurnRow.vue — normal TranscriptRow/32px BotAvatar + speaker + bubble + final StreamMarkdown and existing CopyButton/time.
- AgentThinkingBubble.vue — 44px hit target, small thought outline/three dots, state styles/animation, aria-label/aria-expanded.
- GroupRunDetailPopover.vue — anchored floating layer, focus/outside/Escape lifecycle, lazy detail load.
- GroupRunDetailContent.vue — member trace via TurnParts, Run metadata and stop/waiting sections.

Keep GroupHandoffEntry unchanged except unavoidable shared-safe presentation refactors. For popover geometry, prefer a small tested positioning utility or Floating UI Vue if dependency size/build impact is acceptable. Verify fixed/absolute parent stacking and scroll clipping; don't assume an absolute child of GroupTranscript can escape overflow-y-auto.

The former group-run-card content should be moved, not deleted: plan, run budget, routed choice/reason, worktree/isolation note, assignment, dependsOn, blockedReason, member status, elapsed, waitingQuestion, failure/indeterminate, stop. Preserve existing translations with zh-CN/en keys and no raw internal identifiers in normal transcript.

Transition the Bot response path from inline TurnParts to **canonical public reply Markdown** plus bubble; TurnParts now lives inside details. Ensure copying uses canonical reply and never includes hidden reasoning/tool text. Preserve Agent avatar activity state and observed-completion signal without displaying all member run statuses globally.

### 5.4 Loading/scrolling

Current GroupTranscript uses identity-based scroll anchors and watches message count plus live revisions. Projection now adds/removes/repositions synthetic rows independently of messages.length; adjust anchors to watch projection structure, not a naive array length. Keep:
- initial Topic open scroll-to-latest;
- Load Older preserve first visible durable row;
- tail output does not force scroll when reader is parked;
- canonical reply arrival does not jump reader off an older row;
- popover open/close does not change scroll height;
- live bottom auto-follow only when already at bottom.

Tests should inject meaningful jsdom geometry as existing group-components tests do, rather than assert scrollHeight=0.

## 6. Phase 5: tests and proof

### 6.1 Core and protocol regression

Add tests under tests/unit/conversations and existing control/relay-protocol test locations covering:
- new schema on fresh DB and historical DB; re-open/migration idempotence;
- rollback/teardown/clear/delete exact trace removal;
- physically concurrent siblings; same Bot multiple batches; recovery/late event stale attempt rejection;
- live emit to durable trace, actual process restart, paged retrieval yields same normalized TurnParts/Plan;
- interrupted, unavailable, redacted, duplicate output and no-provider-start cases;
- foreign scope/private peer read denial and tool payload sanitization;
- no extra canceled/retried work, no changed scheduler behavior;
- protocol compatibility with older connectors on unrelated operations.

### 6.2 Vue + Vitest

Replace old structural assertions that demand group-run-card/group-member-row with tests asserting:
- one Agent row/bubble per MemberTurn (one, many, same Bot twice);
- immediate/queued/streaming/complete and every failure/waiting/indeterminate state;
- bubble always above own reply and preserved after completion;
- exact membership/reply association and fallback ambiguity;
- popover contains previous run-card information, Stop only for active exact owner;
- eager old history + delayed RPC switching Topic does not change activeRun or show stale data;
- Handoff not broken and Direct Bot unchanged;
- scroll anchor under historical prepend/live appends/promotion;
- aria keyboard/focus and reduced-motion.

### 6.3 Playwright browser/E2E

Add an e2e case in packages/relay-web/e2e for both desktop and mobile:
- visual checks for light/dark and 1/2+ Bot rows;
- popover placement near viewport edges/bottom with no clipping;
- click/outside/Escape/Tab/touch, stable transcript scroll;
- read-only detail loading and transitions;
- completed bubble remains clickable after reload and Topic switch;
- Stop operation from details targets only the exact active Run.

Test against the real RPC/Core once, not only mocked Vue state: write a short trace containing visible thought, tool progress/complete, Plan, final response; then restart Core/Connector, reload web, read and compare member-specific trace. Include explicit test for missing/unrecorded legacy history.

### 6.4 Suggested verification commands

Use repo scripts, adjust only if files/scripts changed:

~~~bash
bun test tests/unit/conversations
bun test tests/unit/control
bun run build:relay-protocol
bun run build:channel-relay
bun run build:relay-web
bun run test:web
bun run --cwd packages/relay-web test:e2e:desktop
bun run --cwd packages/relay-web test:e2e:mobile
bun run build
~~~

Run relevant other project tests for touched files before requesting review. Use the repo's actual package scripts; preserve CI for Windows/macOS/Linux where affected. Do not report unrun tests as passed. Record meaningful screenshots/traces or concise evidence in PR comments rather than committing binary media by default.

## 7. Implementation sequencing and PR hygiene

Recommended commits on the SAME branch:
1. refactor(protocol): carry physical member attempt identity through Group events
2. refactor(trace): share user-visible tool normalization
3. feat(conversations): persist and replay scoped Group MemberTurn traces
4. feat(relay): expose bounded read-only Group Run/trace RPC
5. feat(relay-web): project per-member rows from historical and live Runs
6. feat(relay-web): replace Group card with thinking bubble and anchored details
7. test(group): validate history, retries, popover and scroll behavior
8. docs(group): update module docs for shipped behavior

Keep incremental commits compileable or explicitly mark interim phases. Do not leave both old card and bubble as a permanent alternative, and do not introduce a setting to switch between them without a requirement.

**Do not over-fix:** prefer a small, scope-limited API/store change to a new event bus framework. Reuse current SQLite store, event bus, protocol parser and components. Avoid broad Session/Direct transcript rewrites.

## 8. Exit checklist

- [ ] Existing card + terminal banners removed from normal Group transcript, all actions/details preserved in popover.
- [ ] Each real MemberTurn gets one bubble with correct Bot name/avatar and exact process; neutral non-Agent fallback for zero-member run.
- [ ] Same-Bot repeated assignment, multiple replies, handoffs, scheduled/concurrent members do not misjoin or duplicate.
- [ ] Existing active Run/uncertain-send/cancel/indeterminate authority unchanged.
- [ ] New recorded public traces survive real Core restart, browser refresh, and Topic switches; legacy/missing/incomplete clearly labeled.
- [ ] New RPC validated, bounded, read-only, scoped, private-peer-safe, and backwards-compatible for unaffected operations.
- [ ] Schema migration + all data deletion paths tested.
- [ ] Current Group scroll anchor and mobile popover placement verified.
- [ ] No new private data or raw secret-bearing tool events persisted or exposed.
- [ ] Unit, protocol, build, browser, end-to-end and relevant CI checks green; results reported accurately.
- [ ] docs/relay-web-module.md, docs/conversation-runtime.md, relevant protocol docs updated after implementation.
- [ ] PR summary updated from plan-stage to delivered files/tests; draft converted to ready only after explicit completed evidence.

## 9. Non-negotiable review blockers

Block completion if any of these are found:
- Stale physical attempt can append to a new MemberTurn trace.
- An Agent bubble displays another Agent's reply or tool trace.
- A completed trace is claimed durable when only browser memory held it.
- Historical detail fetch changes activeRun, composer/Stop target or server scheduling.
- Group/private peer/source isolation is weaker than existing public API.
- Raw unsanitized tool payload/hidden provider reasoning is newly exposed.
- Lossy trace storage is silently presented as a complete process.
- Handoff or Direct UX regresses, or long-history scroll jumps unexpectedly.
- Changes or tests are described as delivered when they have not run.
