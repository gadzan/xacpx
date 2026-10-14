# Group Agent Communication Entry — Implementation Plan

Status: Implementation planned  
Date: 2026-10-14  
Area: Relay Web / Group Conversations  
Tracking PR: the feature PR containing this document

## 1. Product intent

A Group conversation should let a person **reach and understand communication between the participating Bots** without turning every coordination step into a prominent chat bubble.

For a public Group handoff, show a small, inline entry made from **two overlapping Bot avatars**: sender → recipient. It is a functional entry point, not a decorative status icon. Activating it reveals the communication details and, where the system can reliably associate one, its outcome.

The Group's ordinary human/Bot conversation remains the visual priority. Communication is discoverable in context, but the default transcript stays quiet.

**Terminology:** call this an "Agent communication entry", "handoff", or "collaboration detail", as appropriate. Do not present the feature as an audit subsystem. The interface is for user access to communication, not compliance reporting.

### User stories

1. While reading a Group Topic, I can notice that Bot A passed work to Bot B without wading through a full coordination card.
2. I can open the entry to see who sent it, who received it, what was requested, any expected output, and the linked outcome when known.
3. I can distinguish "not started", "in progress", "completed", "failed", "cancelled", "indeterminate", and "not available" rather than mistake absence of a reply for a pending task.
4. After refresh or reconnect, the same Group communication remains reachable through the durable transcript.
5. A Group with many interactions remains readable and accessible on desktop and mobile.

## 2. Verified architecture baseline

Do not implement this from the assumption that Agent-to-Agent coordination is not yet modeled. The existing product already has:

- **Public Group handoff:** `group_send({ to, task, expectedOutput? })` emits a durable `ConversationMessage` with `handoff` metadata, within an existing Conversation / Topic / Run. See `src/conversations/group-handoff.ts` and `src/conversations/conversation-types.ts`.
- **Existing Group presentation:** `packages/relay-web/src/components/GroupTranscript.vue` already renders `m.handoff` as a full-width information card (`data-test="group-handoff"`).
- **Existing transport/history:** `ConversationMessageDto` contains `id`, `conversationId`, `topicId`, `seq`, `runId`, `senderBotId`, and `handoff { senderMemberTurnId, to, assignmentId, memberTurnId, task, expectedOutput? }`. The Group store receives `conversation-message` events and loads SQLite-backed history.
- **Existing execution identity:** `MemberTurnSummaryDto` has `id`, `runId`, `botId`, `state`, `assignmentId`, and optional `promptRequestId`. `ConversationMessageDto.promptRequestId` is available for result correlation.
- **Existing detail endpoint:** the Relay RPC `MSG.runsGet` returns `ConversationRunDetailDto` with `memberTurns`. However, `groups.memberTurns` currently selects only the tracked `activeRun`. Old Run details are not guaranteed to be present when a historical handoff expands.
- **Other messaging is not equivalent:** ordinary `agent_send` is point-to-point Agent Messaging; the product-owned Direct path also uses `agent_send` and has private peer Topics. Group execution exposes `group_send` only. Task Orchestration is separate. These streams must not be presented as interchangeable.

Authoritative references:

- `docs/conversation-runtime.md`
- `docs/runtime-mcp.md`
- `docs/design/issue-399-direct-completions.md`
- `packages/relay-protocol/src/dtos.ts`
- `packages/relay-web/src/stores/groups.ts`
- `packages/relay-web/src/components/GroupTranscript.vue`
- `packages/relay-web/src/components/TranscriptRow.vue`

### Current defect worth fixing within the feature

`GroupTranscript.handoffResult()` currently selects the first later Bot message whose Bot ID and Run ID match the handoff target. Two handoffs to the same Bot in one Run can therefore display **the wrong result**. The UI must instead use the recorded target `handoff.memberTurnId` and the corresponding MemberTurn's `promptRequestId`, with scope checks. Never use same-Bot, textual similarity, or timestamp proximity as proof of a result.

## 3. Scope and non-goals

### In scope — first deliverable

- An unobtrusive clickable entry for **existing public Group handoffs** in the Group Topic transcript.
- A detail view containing the sender, recipient, task, optional expected output, associated state, and **correctly attributed** output when available.
- History/reconnect behavior based on existing durable messages; loading older messages must preserve scroll position and expansion must not corrupt the active Run.
- Accessibility, both existing UI locales, and automated tests.

### Explicit non-goals

- No new Agent-to-Agent messaging protocol, extra MCP tool, new SQLite interaction table, or parallel `group.bot_inter_comm` event family.
- No change to who can communicate, what a Bot can read, the Group execution capability ceiling, the Run scheduler, or recovery policy.
- No automatic copying of ordinary `agent_send` messages, private Direct peer Topics, tool arguments, hidden Chain-of-Thought, or Task Orchestration traffic into a public Group Topic.
- No user ability to send a new Bot-to-Bot message from this entry; it is a **read-only communication entry**.
- No claim that the page exposes **all** internal Agent communication.

A separate feature can later unify additional messaging surfaces **only** after specifying provenance, authorization, visibility consent, retention, versioning, and durable history. Do not broaden this first change as a shortcut.

## 4. Interaction and visual specification

### 4.1 Collapsed — default

- Replace the existing always-expanded handoff card with **one minimal inline visual entry**.
- Two overlapping round Bot avatars represent **sender on the left**, **recipient on the right**. Target approximately 24 × 24 CSS px avatars and 7–9 px overlap. Use current Bot profile avatar where supported; otherwise the existing Bot/driver icon or safe initials fallback.
- **No visible label, arrow text, task preview, status sentence, timestamps, or large background card** when collapsed. A faint hover/focus treatment and optional tiny nonverbal state indicator are acceptable only if they remain legible and quiet.
- Keep a comfortably operable pointer/touch area (target approximately 40–44 px) without enlarging the visible artwork. A single semantic button controls the entry.
- Use a localized accessible label such as "Communication: Reviewer to Tester", `aria-expanded`, focus visibility, and standard Enter/Space behavior. Do not rely on avatar colors alone.
- Do not accidentally render the default leading `TranscriptRow` avatar **in addition** to the two communication avatars. Make a small optional row presentation variant / hide-leading-avatar prop that preserves other existing callers.

### 4.2 Expanded — on demand

Reveal a compact detail panel **in place** under the avatar entry, in transcript order:

- "From [Bot]" and "To [Bot]", using current safe display metadata and a graceful fallback for renamed/retired/unavailable Bots.
- The durable handoff task text and optional expected output, rendered as untrusted text or through an existing safe text renderer; never as executable HTML.
- The target MemberTurn's canonical state when known. Treat `indeterminate` as **outcome unknown**, not failure or success; a missing detail does not imply "still running".
- A result section only if correlation is proven. Preserve readable wrapping and avoid duplicating excessively long replies when a link/jump to the existing message is possible.
- A clear, localized "Result not available" or "Details not loaded" state if the exact target result is not accessible. Never substitute another Bot's reply.
- A close/collapse affordance (including keyboard interaction). Expanding one entry should not unexpectedly scroll the reader to the bottom.

Interaction should work identically after history reload. Opening a detail must not run a new Agent turn, mutate a Run, or persist presentation-only state.

### 4.3 Placement and responsiveness

Render the entry in the original public handoff message's transcript position, ordered by authoritative Topic `seq`. Do **not** insert a second duplicate timeline item or aggregate all handoffs at the bottom of the conversation. Honor existing `data-message-id` anchor, `TranscriptRow` identity, pagination, and virtual/offscreen rendering behavior.

On mobile, the entry and expanded panel must fit the available width without horizontal scrolling. A Group without handoffs looks and behaves as before.

## 5. Data and result association

### 5.1 Source of truth

Read the existing `ConversationMessageDto.handoff` shape. Identity chain:

1. Public message `m` defines `conversationId`, `topicId`, `runId`, `seq`, and `handoff.memberTurnId`.
2. Resolve **that exact** target MemberTurn (`turn.id === m.handoff.memberTurnId`), scoped to the same Conversation, Topic, and Run. Validate `turn.botId === m.handoff.to`.
3. For response text, require `turn.promptRequestId` and find a canonical Bot message with the **same** `promptRequestId`, `runId`, `topicId`, `conversationId`, and target `senderBotId`. If any evidence conflicts or multiple incompatible matches exist, show no result.
4. Use the MemberTurn's actual state for progress/error display; do not infer terminal state merely because a Bot has replied elsewhere.
5. Preserve existing `id` and `seq`. Do not create a separate interaction identity from `Date.now()` or text hashes.

`assignmentId` may be useful for additional consistency checking, but it must not replace the target MemberTurn identity. A single Run can have multiple assignments to the same Bot.

### 5.2 Historical Run details

The current reactive `groups.memberTurns` list filters to `activeRun`. A handoff in a past Run may appear in paginated transcript history even when its MemberTurn is absent from local memory.

Preferred minimal approach:

- On expansion, first use already-known `memberTurnsById[handoff.memberTurnId]` only when its full scope matches.
- If missing and `m.runId` exists, lazily request the existing `MSG.runsGet` detail for **that Run**. Add a small **read-only, bounded, per-Run cache** (or a component-local request keyed by instance + Conversation + Topic + Run), with in-flight de-duplication.
- Do **not** call the existing active-owner `enrichRunDetail()` for a historical Run: it updates `activeRun` by design. Historical detail loading must be independent and must never alter composer ownership, queued requests, cancellation state, or latest-plan display.
- Guard the async response against instance/Group/Topic selection changes and deleted Runs; discard stale results. Report an unavailable state on RPC failure without retry loops.
- If a canonical response is absent from currently loaded transcript pages, do **not** scan unbounded history or guess by Bot ID. A bounded, on-demand history lookup can be added **only if existing history RPC/cursor semantics prove it possible without changing the main transcript cursor**. Otherwise show a truthful missing-result state while retaining the handoff details and terminal MemberTurn status.
- Cache keys must prevent identical Run IDs on different instances/topics from leaking across selection. Bound cache size and clear on appropriate identity changes.

No DTO changes are required for the basic two-avatar entry or for the already-exposed public handoff details.

### 5.3 Source and lifecycle rules

- A public `handoff` belongs to the Group Topic transcript; `group_send` acceptance is **not** proof that the receiving Bot started or completed its work.
- In-progress, queued, failed, cancelled, and indeterminate transitions come from the existing durable MemberTurn/Run contract.
- New WebSocket events update existing Group state; reconnect/history loading recovers from durable SQLite data.
- Missing Bot profile: retain interaction access with a fallback icon and safe identifier, including after member retirement.
- Missing or malformed optional values: fail gracefully. Do not synthesize identities or results.

## 6. Execution plan

Implement as small reviewable commits to this feature PR. Complete each task and its tests before moving to unrelated scope.

### Task 0 — Baseline and fixture (no behavior change)

**Inspect:**
- `packages/relay-web/src/components/GroupTranscript.vue`
- `packages/relay-web/src/components/TranscriptRow.vue`
- `packages/relay-web/src/stores/groups.ts`
- `packages/relay-web/src/__tests__/group-components.test.ts`
- `packages/relay-protocol/src/dtos.ts`
- `src/conversations/group-handoff.ts`

**Deliver:**
- A focused test fixture containing public handoff A→B and two distinct B assignments in one Run.
- Documented proof of current `handoffResult()` false association.
- Check the existing avatar component and local theme/layout conventions before adding another visual primitive.

**Exit:** the test demonstrates the wrong-association risk; no new persistence or protocol has been proposed.

### Task 1 — Compact communication entry

**Likely files:**
- `packages/relay-web/src/components/GroupTranscript.vue`
- New local component such as `packages/relay-web/src/components/GroupHandoffEntry.vue` only if it keeps the transcript simpler
- `packages/relay-web/src/components/TranscriptRow.vue` (optional leading-avatar control)
- Existing `packages/relay-web/src/i18n/` locale files (verify exact locale paths)

**Implement:**
- Replace the current `data-test="group-handoff"` card with the two-avatar entry. Preserve a stable row/message test hook.
- Keep collapsed markup free of visible text while remaining semantically accessible.
- Add inline detail expansion, predictable focus and a locale-aware accessible name.
- Reuse Bot metadata and existing UI icons; avoid a design-system fork.

**Exit:** two overlapping avatars by default; one click/keyboard action opens the correct details and collapse closes them; normal transcript rows are unchanged.

### Task 2 — Exact result association and historical details

**Likely files:**
- `packages/relay-web/src/components/GroupHandoffEntry.vue` and/or `GroupTranscript.vue`
- `packages/relay-web/src/stores/groups.ts` only if a small read-only historical detail helper is warranted

**Implement:**
- Replace heuristic `handoffResult()` matching with exact `handoff.memberTurnId` → MemberTurn `promptRequestId` → Bot message matching, plus Conversation/Topic/Run/Bot fences.
- Use already loaded MemberTurns for current Run and lazy `runs.get` for old Runs. Keep historical data separate from active ownership.
- Expose truthful loading / result unavailable / terminal outcome states.
- Do not add protocol or storage merely to improve presentation.

**Exit:** concurrent or repeated handoffs to the same target never cross-link results; historical detail expansion works without affecting the live Run.

### Task 3 — History, responsive behavior and hardening

**Likely files:**
- `packages/relay-web/src/__tests__/group-components.test.ts`
- `packages/relay-web/src/__tests__/groups-store.test.ts`
- Any existing locale snapshots / browser E2E tests needed for affected behaviors

**Implement:**
- Verify history prepend, WebSocket replay/reconnect, duplicated delivery handling, selection switching during lazy `runs.get`, and expansion while new messages append.
- Verify missing/retired Bot avatars and narrow-screen layout.
- Ensure untrusted task/result text cannot inject markup.

**Exit:** existing message `id`, `seq`, anchor and store merge invariants remain intact; read-only details do not mutate execution state.

### Task 4 — Verification and product review

Run from repo root as appropriate:

1. `bun run test:web` (or targeted `bun run --cwd packages/relay-web test src/__tests__/group-components.test.ts` during iteration).
2. `bun run build:relay-web` (Vue typecheck and production build).
3. If protocol/backend is touched, run the corresponding targeted unit/acceptance suites and `bun run build:relay-protocol`.
4. Existing desktop/mobile browser tests for this interaction, using `bun run --cwd packages/relay-web test:e2e:desktop` and `test:e2e:mobile` where the environment supports them.

Record exact test counts and any environment limitations in the PR. Do not say a check passed unless it was run.

## 7. Mandatory test matrix

| Scenario | Expected |
| --- | --- |
| No handoff in Group Topic | No entry; existing messages unaffected |
| One handoff, default render | Exactly two overlapping Bot avatars; no visible communication text |
| Click / Enter / Space | Detail opens; `aria-expanded` updates; collapse works |
| Multiple handoffs A→B in the same Run | Distinct entries, distinct result associations |
| Target B replies for another assignment | No false result shown for this handoff |
| Target MemberTurn still queued/running | Appropriate state; no invented result |
| Target completed, canonical reply loaded | Exact matching reply shown or linked |
| Target failed/cancelled/indeterminate | Accurate state and truthful outcome label |
| Old Run not in `activeRun` | Lazy read-only detail resolves; composer ownership unchanged |
| `runs.get` fails or response absent from loaded history | Entry remains usable; no guessed result |
| Instance/Topic switched while detail RPC in flight | Stale result discarded; no cross-Topic display |
| History prepend + live appended message | Scroll anchor and message order preserved |
| Restart/reconnect/repeated WS event | No duplicate entries; durable source remains authoritative |
| Avatar absent/Bot retired | Safe fallback; sender/recipient still identifiable |
| Mobile + keyboard + screen reader | Touch target/focus/localized semantics work |
| Malicious-looking task or output string | Rendered as content, never active HTML/script |

## 8. Acceptance criteria

The feature is ready only when **all** of the following hold:

- [ ] In the Group transcript, every authorized **public** `group_send` handoff visible in loaded history has one small default-collapsed two-avatar entry.
- [ ] The expanded entry exposes the actual sender, recipient, request and expected output, and a truthful status/result where available.
- [ ] No result is attributed without exact durable identity evidence. Repeat-to-same-target is tested.
- [ ] Existing Group history, active Run, message ordering, cancellation, composer, and responsive chat UX have no regressions.
- [ ] No private Direct / generic `agent_send` traffic is copied into a Group by default.
- [ ] Both supported locales, keyboard semantics, mobile interaction and regression tests pass.
- [ ] The PR description reports implemented tasks and actual verification evidence before review/merge.

## 9. Change discipline / review guardrails

- Prefer **UI and read-only retrieval changes first**. The existing public handoff schema is sufficient; require a concrete failing test and documented justification before any backend, SQLite or wire-schema expansion.
- Keep authorization and public/private boundaries unchanged.
- Preserve existing fields, cursors and event semantics; never invent a second `interactionId` or duplicate delivery channel.
- Prefer one focused presentation component and a small read-only helper over a generic cross-system "communication framework".
- Avoid broad refactors, style churn and speculative recovery features.
- A wrong result association is worse than a clearly labeled unavailable result.
- This plan defines the implementation sequence; it is not evidence that code is already implemented.

## 10. Future extension boundary

A broader "Agent communication" view might eventually include point-to-point `agent_send` traffic and Direct peer message history, but **that is a different visibility and authorization contract**. Before implementation, decide whose communication is eligible, where it may be displayed, how the user opts in, whether it is durably retained, who can read it, and how message/response provenance is proven. Keep that decision separate from the first Group UI delivery.
