# Group Agent Thinking Bubbles — Product and Architecture Design

Status: Approved interaction contract; implementation pending
Date: 2026-10-19
Area: Relay Web / Group Conversations / Core durable traces
Delivery: The feature PR on branch feat/group-agent-thinking-bubbles
Related: docs/superpowers/plans/2026-10-19-group-agent-thinking-bubbles-implementation.md

## 1. Intent and frozen decisions

Group messages should read like ordinary conversation. The current bottom-of-transcript "Collaboration Run" card consumes too much vertical space and repeats information that belongs in context.

This feature replaces the prominent Group Run card with **one ordinary Bot reply/activity row per participating MemberTurn**:

1. **Scope:** multi-Agent Group Topics in xacpx relay-web only, not messaging-channel groups, Direct Bot, or regular sessions.
2. **Identity:** the real assigned Bot's existing 32px avatar is the leading avatar of its normal transcript row. Do not substitute a Group-wide avatar, generic fake Bot, or a duplicated avatar inside a second Run card.
3. **Entry:** below Bot name, before final reply text, show a compact animated thought-bubble button rather than a spinning loading icon. The button persists when work finishes.
4. **Multiple Agents:** distinct MemberTurns get distinct avatars, bubbles, and complete process detail; even repeated work by the same Bot must not be conflated.
5. **Popover:** clicking the bubble opens a panel anchored to that exact bubble. Stop, errors, waiting-for-human, plan, dispatch rationale, assignments, dependencies, and execution steps are inside it, not separately repeated as banners in the transcript.
6. **History:** users can reopen the full *recorded public* execution process after reload, browser disconnect, switching Topic, and re-entering a Group. Necessary Core persistence and protocol changes are explicitly in scope.
7. **Group Handoff:** the existing public sender → recipient overlapping-avatar Handoff entry stays as-is. It is a different feature.

This is a feature-delivery PR. The initial docs commit is scaffolding; the PR must stay draft until code, migration, tests, and verification are delivered.

## 2. Code-verified baseline

- packages/relay-web/src/components/GroupTranscript.vue renders ordinary Group Bot messages using TranscriptRow/BotAvatar, then a bottom group-run-card sourced from groups.activeRun; each member row expands to TurnParts, and the card shows routing, Stop, waiting-human, budget, assignment and Plan.
- packages/relay-web/src/stores/groups.ts only projects groups.memberTurns for activeRun. liveTurnsByMember, runParts and planByRunId are client-run-time state; completeRunParts is only populated for complete, non-truncated local streams. Existing refresh/history recovery primarily discovers the Topic's active owner, not all historical runs.
- src/conversations/conversation-types.ts has durable ConversationRun.requestMessageId, MemberTurn.id/runId/botId/attempt/batch/memberIndex/sourceTurnId/assignmentId and ConversationMessage.runId/sourceTurn. src/control/conversation-control-dtos.ts projects MemberTurn.sourceTurnId as promptRequestId.
- src/conversations/conversation-run-service.ts getRun returns durable Run plus MemberTurns; runs.list limits returned summaries; neither provides full reasoning/tools/Plan.
- src/control/session-turn-runner.ts emits conversation-correlated turn-started, turn-output, turn-thought, tool-event, plan, turn-finished through ControlEventBus. packages/channel-relay/src/tool-presentation.ts converts tool events to bounded ToolStepDto, and the connector forwards normalized Web events.
- Core persists Conversations in src/conversations/sqlite-conversation-store.ts; Topic clear/teardown and Group deletion explicitly delete durable rows. This is the authoritative persistence lifetime.
- GroupHandoffEntry and groups.loadHandoffRunDetail already demonstrate history-only, scope-fenced reads that do not affect the active Run.
- docs/superpowers/specs/2026-10-18-general-automatic-collaboration-design.md allows repeated, sequential automatic assignments, including need-human before any member exists.

No claim is made that data omitted by older adapters, redacted for presentation, never emitted by a provider, or lost before durable commit can be reconstructed.

## 3. User-facing behavior

### 3.1 Visual hierarchy

- Human messages keep their right-aligned bubbles.
- Each actual MemberTurn is represented by a Bot-like left-aligned activity/reply row: leading configured avatar; Bot name; thought-bubble button; final public message underneath the bubble if one exists.
- The thought-bubble graphic uses a small speech/thought outline with three staggered dots, a subtle pulse in running/streaming states, and no broad animated card or spinning Loader2. Status is accessible through the button's localized label/title and within the detail.
- The clickable region is >=44x44 CSS px. Preserve the current theme tokens, existing BotAvatar behavior, dark/light themes, mobile hit areas, and prefers-reduced-motion.
- Completed bubbles are static and remain actionable; failure, cancellation, indeterminate, and waiting-human use distinct understated badge/icon treatments without a large inline banner. Avoid using color alone for state.
- No separate persistent run-card, PlanPanel, stop banner or terminal-error card below the main transcript.

### 3.2 Trigger and lifecycle

- On durable accept, place a temporary row for each *known* MemberTurn adjacent to the owning request; its bubble shows queued. The temporary row does **not** claim a bot has answered.
- For an automatic Run with no MemberTurn yet, display one **neutral routing entry** associated with the owning human request, without pretending a real Agent was selected. This entry exists only to expose routing/waiting/error/Stop before a member is known and transitions away once a MemberTurn exists. Zero-member terminal Runs keep this entry so the result remains reachable.
- On member-started, use the real Bot identity and current attempt; stream status into the bubble and opened details, not into a giant transcript card.
- On canonical Bot reply, render it **once** at its durable message seq, attach the owning member bubble above its body, and remove the corresponding temporary row. Preserve original seq ordering, especially interleaved Handoffs or concurrent members. A member with no canonical reply retains its temporary row anchored to the request.
- If one MemberTurn produces multiple canonical public message rows, render every message exactly once at its seq; show the MemberTurn bubble on the earliest proven owning reply and do not create duplicate trace entry points.
- Group Handoff messages remain in their existing seq position and continue to show the original overlapping-avatar entry.
- A newly started Run must not take over the previous Run's bubbles. Old rows use their original run/member identities rather than activeRun.

### 3.3 Exact correlation and safe fallback

Authoritative joins:
- Run.requestMessageId === human message.id AND both share conversationId/topicId; do not join to a nearby human bubble.
- MemberTurn.runId === Run.id with matching conversationId/topicId; MemberTurn.id is the bubble's durable identity.
- Bot reply candidate must match conversationId, topicId, runId, botId and, when supplied, Message.promptRequestId === MemberTurn.promptRequestId. If an older message has no promptRequestId, allow fallback only if exactly one candidate MemberTurn of that Bot exists in the Run and no conflicting evidence exists.
- Explicit contradictions, duplicated ownership, missing scoped Run or uncertain identity **must not** trigger a guessed merge or wrong Agent trace. Retain the canonical reply and a separately labeled unresolved activity entry, with a non-fabricated explanation in its details.
- Same-bot multiple assignments, retries and late outputs must retain their own MemberTurn/attempt identity. No matching by timestamp, response text, Bot ID alone, or arbitrary array position.
- Existing record IDs and message seqs are authoritative; projection nodes are ephemeral UI constructs, never persisted as fake ConversationMessage.

### 3.4 Anchored popover contract

- Desktop: rounded, shadowed overlay anchored below/beside the selected thought-bubble, with flip/shift for viewport edges. Target width around 400–440px; max height limited to viewport and its own scroll container.
- Narrow screens: still an anchored viewport-constrained popover (not a replacement MobileSheet), correctly usable near left/right/bottom edges. Teleport to body or use an equivalent collision-safe layer so transcript overflow cannot clip it.
- Single-open policy; click again/outside/Escape to close; trap no focus; return keyboard focus to trigger on Escape; preserve accessible aria-expanded, aria-controls and status announcement. Close on scope switch, deleted row, unmount or trigger off-screen. Keep pointer interaction inside without accidental outside close.
- The floating layer never contributes height to a message row or invalidates transcript scroll anchoring. Opening a detail while reading old history does not auto-scroll to newest.
- Within detail: Bot + MemberTurn status, assignment and task, attempt and duration, failure/blocked reason, ordered recorded TurnParts, global Run state/reason/budget/router decision/Plan, and Run-level Stop action if genuinely cancellable.
- Other members may be summarized by name and state but their tools/reasoning are never shown in this Agent's trace. Their complete process is reached through **their own bubble**.
- A Run-level Stop action is labeled "Stop this run" / "停止本次任务", including a clear indication it applies to all participating members; never pretend cancellation is scoped to a single member.
- Stop is shown only when current activeRun id + conversation/topic + safe ownership state agree, and state is queued/running/waiting-human. Preserve existing cancelCurrentRun fencing, uncertain-outcome and retry behavior.
- Waiting-human is not running. The popover exposes waitingQuestion and existing guidance only: no invented "resume", permission grant or new scheduling path. Preserve failed/cancelled/indeterminate semantics and actionable reasons.

## 4. Durable trace and read semantics

### 4.1 Persistence boundary

The **Core Conversation runtime** is the canonical owner of historical Group MemberTurn execution traces. Relay Hub/browser storage and the Group Pinia store are transport/presentation caches only.

Persist exactly the public presentation surface previously available from the Group Run detail:
- ordered text output, visible streamed reasoning, normalized tool-step updates, Plan replacement snapshots, terminal observations;
- member attempt identity, scoped Run and result completeness;
- essential current Run/member metadata already held in durable Conversation tables.

Do not persist private provider chain-of-thought that is not part of the existing emitted user-visible reasoning stream, full raw ToolUseEvent internals, secret-bearing unfiltered payloads, private peer Topics, or duplicated Agent Messaging data.

A "complete" trace means all events **received and accepted by the recorder** for a particular physical attempt have been durably committed and an authenticated terminal marker was observed. It does not imply an adapter emitted every internal step. Distinguish complete / recording / interrupted / unavailable / truncated-or-redacted appropriately.

### 4.2 Proposed storage

Extend conversations.sqlite with tables conceptually equivalent to:
- member_turn_trace: key (member_turn_id, attempt), parent run/topic/conversation, source_turn_id, recording_state, last_seq, created/updated/finished times, failure/truncation reason, optional plan snapshot.
- member_turn_trace_events: key (member_turn_id, attempt, seq), event kind, sanitized normalized JSON, created_at. Index for exact ordered scoped paging; foreign keys/transactional deletion where supported.

MemberTurn's durable attempt and sourceTurnId must fence every write; late events from a retired attempt cannot appear under a new attempt. Preserve the final state and events of earlier attempts for readable recovery history.

Use idempotent monotone sequence allocation *inside the durable transaction*, not client-clock timestamps or a shared run-level counter. Coalesce adjacent text/reasoning without changing text order. Tool updates may share toolCallId but must preserve the ordered event stream; the replay reducer may upsert their visible state. Plan events are replace-latest, not cumulatively concatenated.

Use bounded in-memory batching and SQLite transactions for stream pressure, flush on terminal; record incomplete on crash, uncertain execution or failed flush. Never label a stream complete when persistence is unproven. A permanently failed recorder must not stall or change agent execution, but should surface trace partial/unavailable.

New writes begin at the new version's activation; legacy runs retain existing summary/history and explicitly say detailed trace was not recorded, rather than synthesizing a full process. Delete trace rows atomically with existing Topic clear/teardown/Conversation deletion. No silently shortened retention lifetime compared to the conversation.

### 4.3 Data path and compatibility

- The trusted Core emitter supplies a ConversationTurnCorrelation identifying exact conversation/topic/run/member/bot; add optional sourceTurnId/attempt metadata through the trusted dispatcher → turn runner → ControlEvent pipeline for correct physical-attempt fencing.
- Normalize tool events once through a shared **pure** converter with current ToolStepDto output, truncation and safe display behavior. Do not make Core import channel-relay internals or duplicate an independently drifting 493-line normalization implementation.
- Record only public Group executions (never Direct/private peer). Validate scope against the durable store, not only client-supplied correlation values.
- Keep existing ControlEvent and Web event types working for Direct Bot/Session and older connectors. Additive RPC fields/types, strict decoding, unsupported-RPC fallback and no behavior downgrade for scheduling.
- Read API: batch Run/member details for history paging and lazy paged trace reading for an opened member/attempt. Validate exact run/member/scope and private peer exclusion; cap batch size/page size and payload bytes. Calls must be read-only and never change activeRun ownership.
- Live UI may render current in-memory events immediately, but the persisted event cursor is authoritative for catch-up/reopen. Deduplicate on stable attempt+seq or toolCallId; replace rather than append snapshots where needed. Reconnection re-queries committed cursor. No duplicate transcript rows or tool steps.

## 5. Failure matrix

| Scenario | Expected |
| --- | --- |
| Explicit one Bot | One Agent row and bubble; exact reply only |
| Explicit 2+ Bots | One distinct bubble per MemberTurn; no cross-member trace |
| Automatic multi-step, same Bot twice | Two independently clickable attempts/assignments and correct replies |
| Router still deciding/no members | Neutral routing entry only, no invented Bot identity |
| Waiting-human with no members | Neutral entry contains question, no spurious running |
| Handoff within Run | Handoff entry preserved at durable seq, no merged process |
| Member failed with no Bot message | Durable activity row remains; scoped failure shown in popover |
| Run completed/next Run starts | Old bubbles remain bound to old Run |
| Recovery changes attempt | Old attempt trace readable; current attempt never includes stale events |
| Refresh/Topic switch/browser restart | Rehydrate summaries; lazy replay full recorded trace |
| Daemon crash before last events flush | Mark partial/interrupted; never claim full trace |
| Legacy pre-feature history | Reply/status visible; "process not recorded" explanation |
| Unauthorized/private Topic | Read denied; no content leak |
| Topic clear/teardown | Associated trace is deleted with Topic data |
| Indeterminate/cancel uncertain | No false success/cancel; Stop uses exact authority |
| Mobile/screen-edge popover | Anchored, inside viewport, keyboard accessible |
| Reduced motion | Animation off, same controls and status |

## 6. Performance and privacy boundaries

- No N+1 per-message runs.get on initial transcript; batch visible historical runs with a bounded concurrency policy and stale-generation cancellation.
- Do not fetch every trace eagerly; fetch only on popover open, in seq pages, and continue live incremental reads while open. Only keep bounded UI caches; server data remains durable.
- Keep public payload sizes bounded; do not impose unrequested silent irreversible trace truncation. If a configured hard cap is unavoidable, explicitly mark truncated and show why.
- Avoid full transcript recomputation on every token. Use stable MemberTurn/Message keys and incremental revision projection.
- Keep all RPC/public DTO authorization, error and execution boundaries intact; no new capability for bots or broader read access to private conversations.
- Localized zh-CN/en accessible labels for all statuses and controls. No raw Run/Member IDs in default transcript; identifiers may appear in expanded details as appropriate.

## 7. Delivery definition

The feature is complete only when:
1. No full-width Group Run card or its duplicate terminal banners remain.
2. Every real MemberTurn has exactly one accessible Agent bubble, with canonical reply deduplication.
3. Member/Run state and Stop semantics are correct under cancel, reconnect, retry, automatic routing, waiting-human, failure and indeterminate.
4. Freshly recorded public process persists across browser reload, Topic switch and actual Core process restart; old/partial records are honestly labeled.
5. Existing Handoff/Direct/session behavior and key scroll-anchor guarantees are preserved.
6. Schema migration, public RPC shape and privacy/fencing tests, Vue unit tests and Playwright desktop/mobile coverage pass.

Implementation order and exact testing instructions: see paired implementation plan.
