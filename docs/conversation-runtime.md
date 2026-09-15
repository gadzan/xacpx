# Conversation runtime (Direct persistence + lifecycle)

Direct Conversation execution is durable. Group routing, Relay Web UI, automatic Router, and channel bindings are out of scope.

## Store ownership

Two durability systems exist. They are **not** one ACID transaction.

| Concept | Authoritative store |
| --- | --- |
| Bot metadata, Conversation/Topic bounded metadata, `BotRuntimeBinding`, LogicalSession ownership | AppState `state.json` |
| Messages, Runs, MemberTurns, dispatch/outbox, `seq`, request idempotency | Conversation SQLite DB |

A crash between SQLite commit and AppState runtime materialization is expected. Recovery is the outbox: restart discovers `pending` / expired-or-orphaned `claimed` rows without reading UI state.

## Transaction boundary (accept)

One `BEGIN IMMEDIATE` transaction writes:

- human `ConversationMessage` (monotonic per-Topic `seq`)
- `ConversationRun` (`mode: "explicit"`)
- initial `MemberTurnRecord`
- `PendingDispatch` (`pending`)

All four exist, or none do. `seq` is allocated by incrementing `topic_seq` inside that transaction — never `SELECT MAX(seq)+1` outside the write lock.

Idempotency key: **`conversationId × topicId × requestId`** (`UNIQUE` constraint). Sequential or concurrent retries reuse the existing Run/message/dispatch.

## Outbox / claim recovery

```text
accept transaction commits request + pending dispatch
→ dispatcher claims with owner + lease
→ runtime materialize (AppState) + persist exact turn identity
→ completion transaction records result + terminal MemberTurn/Run
```

Claims use a lease (`owner`, `leaseExpiresAt`). Restart recovers:

- claimed, **never started** → requeue (`pending`); safe to dispatch again
- claimed, **started**, completion unproven → `indeterminate` (MemberTurn and Run); **never** blindly replayed

Do not treat “dispatcher process disappeared” as “task never ran” when `startedAt` / `sourceTurnId` exist.

## Exact turn correlation

On execution start the dispatcher persists `sessionAlias`, `logicalSessionId`, and a minted `sourceTurnId` (also the Control `promptRequestId`) **before** calling the normal xacpx turn runner. Recovery never uses latest-turn-in-alias, text match, or timestamp proximity.

The runner seam is `ConversationTurnRunner` / `ControlConversationTurnRunner` wrapping `ControlService.prompt` / `cancelTurn`. There is no second Bot execution engine.

## `indeterminate`

If a side-effect-capable underlying turn has started and completion cannot be proven (crash after start, cancel of a write-capable started turn with unknown outcome):

```text
MemberTurn.state = indeterminate
Run.state = indeterminate
```

Accepted-but-never-started is a different recovery case (redispatch). Started-but-result-unknown is not.

## Profile revision snapshot

Each Bot has a monotonic `profileRevision` (PR2 records default to `1` on parse). `updateBot` increments it.

At accept, the Run stores `profileRevision` plus a snapshot of:

- presentation: name / avatar / role
- behavior: instructions
- execution: agent / workspace / model / effort

Execute composes the prompt from **that** snapshot. Clearing instructions does not erase the owned LogicalSession history. A Run must not mix old runtime identity with newer instructions or an unrelated model; if the owned session identity no longer matches the accepted execution snapshot, the Run fails `runtime_revision_mismatch`.

## Direct multi-Topic binding

Runtime key: **`conversationId × topicId × botId`**.

- New bindings use `createScopedDirectBindingId(...)`.
- PR2 default Topic bindings used `createDirectBindingId(botId)` and alias `brt_<legacyId>`.
- Adoption: on the default Topic, a live legacy binding/owned session is rewritten onto the scoped binding id; the **alias is kept** so the owned session is not orphaned.

## Cancellation

Cancel is by `runId`. Queued/claimed-never-started Runs become `cancelled` and will not dispatch. Running cancel goes through existing `cancelTurn` / `cancelQueuedItem` for that Topic’s chatKey (`bot:<conversationId>:<topicId>`). Late completion cannot resurrect a cancelled Run. If a started write-capable turn’s effect cannot be proven, terminal state is `indeterminate`, not a false `cancelled`.

Policy: one active Run per Topic; later accepted requests stay queued in durable dispatch order.

## Teardown

Order: mark Conversation/Topic deleting (SQLite authoritative for dispatch; AppState flag is bounded metadata) → stop future accept/dispatch → cancel/drain → reconcile indeterminate → verified `removeSession` → drop bindings → delete ConversationStore rows → delete Conversation/Topic metadata.

Injected release failure leaves `deleting` + ownership in place for retry.

**Remaining Bot-delete boundary:** `BotService.deleteBot` stays fail-closed (`bot_in_use` / `bot_in_group`) and does **not** auto-teardown. Call `ConversationRunService.teardownDirectConversation` first, then delete the Bot. Group teardown is out of scope.

## Out of scope

Group routing, member selection, Router, parallel batches, `group_send`, Group UI, external channels, Relay protocol/UI, daemon `main.ts` wiring.
