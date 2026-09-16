# Conversation runtime (Direct persistence + lifecycle)

Direct Conversation execution is durable. Group routing, Relay Web UI, automatic Router, and channel bindings are out of scope.

## Store ownership

Two durability systems exist. They are **not** one ACID transaction.

| Concept | Authoritative store |
| --- | --- |
| Bot metadata, Conversation/Topic bounded metadata, `BotRuntimeBinding`, LogicalSession ownership | AppState `state.json` |
| Messages, Runs, MemberTurns, dispatch/outbox, `seq`, request idempotency | Conversation SQLite DB |

A crash between SQLite commit and AppState runtime materialization is expected. Recovery is the outbox: restart discovers `pending` / lease-expired `claimed` rows without reading UI state.

## Transaction boundary (accept)

One `BEGIN IMMEDIATE` transaction writes:

- human `ConversationMessage` (monotonic per-Topic `seq`)
- `ConversationRun` (`mode: "explicit"`)
- initial `MemberTurnRecord`
- `PendingDispatch` (`pending`)

All four exist, or none do. `seq` is allocated by incrementing `topic_seq` inside that transaction — never `SELECT MAX(seq)+1` outside the write lock.

Idempotency key: **`conversationId × topicId × requestId`** (`UNIQUE` constraint). Sequential or concurrent retries reuse the existing Run/message/dispatch. `ConversationRunService.acceptDirectPrompt` looks up that key **before** mutable policy gates (`enabled`, topic existence, deleting). A lost response after a successful accept still returns the same accepted Run if the Bot is later disabled or Conversation teardown has started. New requests still fail those gates.

## Outbox / claim recovery

```text
accept transaction commits request + pending dispatch
→ dispatcher claims with owner + generation + lease
→ runtime materialize (AppState) + CAS execution-start fence
→ completion transaction records result + terminal MemberTurn/Run
```

Claims use `owner`, `generation`, and `leaseExpiresAt`. Recovery is **lease-driven**. A different owner is not proof that the previous owner is dead; without explicit process-death evidence, a live claim is left until its lease expires.

Restart / reclaim after lease expiry:

- claimed, **never started** → requeue (`pending`, generation++); safe to dispatch again
- claimed, **started**, completion unproven → `indeterminate` (MemberTurn and Run); **never** blindly replayed

Every pre-start mutation by a claimed worker is a transactional CAS on `dispatchId + owner + generation` (and a still-valid lease): `markExecutionStarted`, `releaseClaimToPending`, and `failClaimBeforeStart`. A stale generation is `stale_claim` / a no-op; it must not clear or terminalize a newer claim.

Execution start is that same fence plus run/member still runnable. A stale worker whose claim was recovered must not call the underlying runner.

Do not treat “dispatcher process disappeared” as “task never ran” when `startedAt` / `sourceTurnId` exist.

Queued Runs on a Topic are claimed in **human request message `seq` order**, not `created_at` + lexical Run id.

A drain pass that hits a generic pre-start failure **requeues that claim and defers its Topic for the rest of the pass**. It does not abort the drain. Each `kick()` records a monotonic wake generation. A pass may skip deferred Topics so a poison row cannot starve other work and cannot hot-loop. If a new wake arrived during that pass — including a same-Topic accept — the dispatcher starts one fresh pass with the deferred set cleared. Without a new wake, a permanently failing Topic is not retried.

## Execution correlation

On execution start the dispatcher persists `sessionAlias`, `logicalSessionId`, and a minted `sourceTurnId`. That id is passed into Control as `promptRequestId` so TurnQueue can treat it as the durable execution identity for **this** prompt. It is not a pre-existing transport turn id.

Cancel/inspect uses a request-id-aware seam (`cancelTurnForPromptRequest` / `inspectPromptRequest`). Aborting the session lane alone does not prove the turn produced no effects. `ControlConversationTurnRunner.cancel()` aborts the exact prompt, then waits a **bounded** settlement deadline (TurnQueue drain timeout by default). A proven completed/failed/cancelled result is persisted as such; if the provider ignores abort, both `cancel()` and the outward `runner.run()` resolve as `unknown` and the Run/MemberTurn become `indeterminate`. A late provider settle cannot resurrect that Run. Teardown observes indeterminate instead of hanging.

After `markExecutionStarted`, the dispatcher re-reads Run/MemberTurn following every await before `runner.run()`. If the Run is no longer `running` (cancel, indeterminate recovery, another worker), it returns without invoking Control. The runner registers `promptRequestId` synchronously before `Control.promptImmediate`, with an `AbortController` covering the whole pre-admission interval (including a pending `sessionConfigSetTails` wait). Cancel aborts that controller before/alongside `cancelTurnForPromptRequest`. After any config-tail wait and immediately before `TurnQueue.submit`, `promptImmediate` returns a typed cancelled result (`cancelled: true`) and never admits the turn if the signal is already aborted. Once TurnQueue has admitted the `promptRequestId`, cancel stays on that exact request-id path. A terminal or indeterminate Run must never start new side effects afterward. Settled runner entries are kept for late-cancel `completed` reporting, bounded by TTL/max like TurnQueue request-id tombstones.

Recovery never uses latest-turn-in-alias, text match, or timestamp proximity.

The runner seam is `ConversationTurnRunner` / `ControlConversationTurnRunner` wrapping `ControlService.promptImmediate` / request-id-aware cancel. `promptImmediate` uses the same TurnQueue / SessionTurnRunner path as interactive `prompt()`, but **never FIFO-enqueues** when the session lane is busy (`queueable: false`). ConversationStore already owns durable queuing; a busy lane fails the Run immediately instead of leaving a TurnQueue item that can execute after the durable Run is already failed.

`BotRuntimeManager` is **runtime materialization/binding only**. Direct Bot turns enter solely through `ConversationRunService` → dispatcher → runner. There is no second Bot execution engine and no `promptDirect` bypass.

`prompt()` (interactive Control) is always `turnOrigin: "human"`. Conversation `promptImmediate` takes store-derived `executionOrigin` and **fail-closes to `orchestration`** unless that value is exactly `"human"`. Callers cannot mint human permission authority by omitting it.

## Execution permission provenance

Fresh direct work that a human just accepted, claimed, and executed by the **same live dispatcher authority epoch** is human: interactive permission authority is allowed.

Recovery / automatic redispatch is orchestration and cannot mint a human permission interaction:

```text
fresh human accept + ordinary same-daemon dispatch     → human
accept committed → daemon crash before first claim
  → startup redispatch (new authority epoch)           → orchestration
claim expires before start → automatic redispatch      → orchestration
automatic pre-start retry after an internal failure    → orchestration
```

The durable boundary is the dispatch `authorityEpoch`, stamped at accept with the live process epoch. `recoverExpiredClaims` and `releaseClaimToPending` revoke it. Claim compares the live epoch to that row — not `generation > 1` (crash-before-first-claim is still generation 1). MemberTurn.origin becomes `recovery` for those executions. The dispatcher copies that durable origin into Control; it never hardcodes `"human"`.

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

Execute composes the prompt from **that** snapshot and materializes/aligns the owned session to the **accepted execution fields**, including model and effort. Clearing instructions does not erase the owned LogicalSession history. A Run must not mix old instructions with a newer model (or any other mixed execution field).

Sticky identity is `agent` / `workspace`. The dispatcher may reject an obvious mismatch as an optimization, but the **authoritative** accepted-vs-live check runs inside the same per-Bot lifecycle gate that materializes or reuses the owned session — before any LogicalSession creation. A mismatch throws/returns stable `runtime_revision_mismatch`; the dispatcher terminalizes that exact fenced claim via `failClaimBeforeStart` and does not generic-requeue it. Model and effort remain safely mutable and are aligned to the accepted snapshot (including on PR2 legacy binding adoption). If the owned session still cannot be made to match the accepted execution snapshot, the Run fails `runtime_revision_mismatch` before the model is called.

The same gate also proves the claimed work is still live before any Session/AppState mutation: exact dispatch + owner + generation + live lease, Run/MemberTurn still runnable, Conversation/Topic not deleting. That check is `assertLiveDispatchForMaterialize`, invoked through `getOrCreateDirectSession({ assertStillDispatchable })`. Every materialization caller enters `bots.runLifecycle` itself — callers do not join another in-flight authorization promise. A later claimant therefore runs its own fence, then observes or reuses any binding/session the previous caller already published. If teardown wins the gate first, the old worker exits without creating a session. If materialization wins first, teardown subsequently sees and releases that ownership. After teardown has marked Conversation/Topic deleting, a not-yet-started claimant must fail that fence and must not reach `markExecutionStarted`. `BotRuntimeManager.releaseDirectBinding` also runs the full release/re-read/conditional-binding-delete transaction under `bots.runLifecycle(botId)`.

## Direct multi-Topic binding

Runtime key: **`conversationId × topicId × botId`**.

- New bindings use `createScopedDirectBindingId(...)`.
- PR2 default Topic bindings used `createDirectBindingId(botId)` and alias `brt_<legacyId>`.
- Adoption: on the default Topic, a live legacy binding/owned session is aligned to the accepted `model` / `effort`, then rewritten onto the scoped binding id; the **alias is kept** so the owned session is not orphaned.

`LogicalSession.owner` for a scoped bot-direct session stores `botId` (and conversation/topic ids) in addition to `bindingId`, so a crash after session persist and before binding publish still attributes the orphan to the Bot. PR2 owners that only have `bindingId` still parse. `deleteBot` stays fail-closed on those orphans.

## Cancellation

Cancel is by `runId`. Queued/claimed-never-started Runs become `cancelled` and will not dispatch. Running cancel goes through request-id-aware cancel for that Topic’s chatKey (`bot:<conversationId>:<topicId>`). A late cancel after the runner has already completed must persist the proven completion (or `indeterminate` if unproven), never a false clean `cancelled`. Late completion cannot resurrect a cancelled Run.

Policy: one active Run per Topic; later accepted requests stay queued in durable **message seq** order.

## Teardown

Order:

1. Mark Conversation/Topic deleting (SQLite is authoritative for accept/dispatch; AppState flag is bounded metadata). This uses the per-Bot lifecycle gate briefly, shared with accept **and** `createDirectTopic`.
2. Stop future accept/dispatch/topic creation. Cancel/drain active turns **without** holding the lifecycle gate (so runtime materialize is not deadlocked). `createDirectTopic` during this window fails `conversation_deleting` and never returns an active Topic that final teardown would immediately remove.
3. Reconcile indeterminate.
4. Verified owned-session release via `releaseOwnedSession(alias)` (production wiring: `createStrictOwnedSessionRelease` → `removeAliasWithPhysicalLifecycle` with `physicalFailurePolicy: "strict"`). Any physical Runtime **or CLI** release/delete failure throws **before** the LogicalSession row disappears. Ordinary `/session rm` keeps the helper's default legacy CLI best-effort path and is not this seam. `SessionService.removeSession` is logical-only. `BotRuntimeManager.releaseDirectBinding` uses the same strict seam under the per-Bot lifecycle gate.
5. Per-Bot lifecycle gate for finalization: remaining ownership release through that same seam, AppState binding/topic/conversation cleanup, **then** delete ConversationStore rows / deleting tombstone.

A crash before step 5 leaves the SQLite `deleting` barrier in place: new accepts fail closed and teardown is retryable.

Injected release failure leaves `deleting` + ownership in place for retry.

**Remaining Bot-delete boundary:** `BotService.deleteBot` stays fail-closed (`bot_in_use` / `bot_in_group`) and does **not** auto-teardown. It consults AppState runtime references **and** ConversationStore durable work (`hasDurableBotWork`) so an accepted Run/outbox cannot outlive a deleted Bot through a crash-before-materialize window. Call `ConversationRunService.teardownDirectConversation` first, then delete the Bot. Group teardown is out of scope.

## Production composition

`buildApp` (`src/main.ts`) constructs the production Conversation runtime via `createConversationRuntime` (`src/conversations/conversation-composition.ts`) **before** Control/Relay accept Conversation requests:

- SQLite path is `dirname(config.json)/runtime/conversations.sqlite` (`resolveRuntimeDirFromConfigPath`).
- Each daemon process mints a fresh `authorityEpoch`.
- The daemon-wide AppState `stateMutex` is injected into `SessionService`, `BotService`, `BotRuntimeManager`, and `ConversationRunService`. Conversation COW publication uses that same mutex for short `structuredClone` → `saveNow` → `replaceRuntimeState` sections only; it is never held across `SessionService` awaits. Do not invent a Conversation-only mutex.
- Startup `kick()` recovers durable pending dispatch. Crash-before-first-claim work is claimed in the new process as `recovery` / `orchestration`.
- Shutdown stops the dispatcher, waits for in-flight drain, then closes SQLite **before** disposing `state.json`.

Public Control / Relay APIs are projections of this domain. Callers address Bot ID, Conversation ID, Topic ID, Run ID, and message `seq` only. They never choose hidden session aliases, `logicalSessionId`, TurnQueue ids, `bindingId`, or `chatKey` as product routing identities.

Ordinary alias-addressed Session APIs (`ControlService.prompt` / `removeSession` / archive / rename / model / effort / cancel, chat `/session` lifecycle) fail `hidden_session` when `LogicalSession.owner` is product-owned. The check is owner metadata, not a `brt_` alias prefix. Conversation execution/release keeps using `promptImmediate` + correlation, request-id cancel, and `releaseOwnedSession`.

Before a Direct Conversation is persisted, public list/get synthesize the bounded Conversation/default Topic from durable Bot timestamps (`createdAt` / `updatedAt`), never read-time `now`. The semantic default Topic id is `createDirectTopicId(botId)`.

Idempotent `requestId` retries reuse the durable accept result and do not re-emit the initial `conversation-message` / queued `conversation-run-changed` projection.

`topic archive/delete` is not a public Control method until domain lifecycle owns it. `BotService.deleteBot` remains fail-closed while durable/runtime ownership exists.

## Out of scope

Group routing, member selection, Router, parallel batches, `group_send`, Group UI, Relay Web Bot/Conversation UI, external channel Conversation bindings.

**Follow-up before Direct Bot product release:** global dispatcher parallelism (more than one claimed execution in flight across Topics/Bots) is not part of this contract. Keep the current drain/claim sequencing until that work is designed.
