# Conversation runtime (Direct + Group persistence and lifecycle)

Direct and Group Conversation execution is durable. Relay Web Group UX, the stateless automatic ConversationRouter (PR8), public structured handoff with bounded recovery (PR9), and external channel bindings (PR10) are part of this contract. Private handoff remains out of scope.

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

### Topic execution concurrency (Phase 10A)

`ConversationTopic.maxConcurrentMemberTurns` is an optional creation-time scheduling
limit, separate from `ExecutionTarget`. Control/Relay Topic creation accepts an
integer from 1 through 64. Omission preserves the existing dispatcher behavior;
it does not enable cross-Topic parallelism. There is no hot-edit API in this phase.
The field persists in AppState; legacy Topics need no migration or SQLite changes.

Logical collaboration parallelism != physical execution concurrency != filesystem
write concurrency. A limit never changes Run/batch/assignment identity, frozen
transcripts, dependencies, Router decisions or authority. Current public explicit,
Router and handoff producers carry unknown effects, so their writers still
serialize under the existing filesystem gate even when the limit is greater than 1.
Only the existing `read-only` + `declared-enforced` proof can permit overlap.

Capacity is reserved by the existing durable `claimed` dispatches (including
pre-start materialization); the claim transaction checks the per-Topic count.
Full capacity leaves work pending without stripping ingress or changing origin.
Configured cohorts refill after an individual execution settles. Every claim
this process still holds — in-flight provider turns and writer-slot waits,
with or without `maxConcurrentMemberTurns` — has its lease extended on a
period of at most one third of the lease. That renewal is independent of the
provider round completing and of the drain loop being inside `Promise.race`.
It is fenced on dispatch id + owner + generation and only moves
`leaseExpiresAt`. Terminal, cancelled, recovered, and lost-owner claims are
not renewed. The dispatcher also renews those same claims immediately before
its own `recoverExpiredClaims`. A closed SQLite store stops renewal. Any
other renewal I/O error, including a rejection whose value is `undefined`,
stops the keeper, marks the Conversation consumer unavailable
(`conversations_unavailable`), and is retained for the next `kick` and for
shutdown. The failure flag is separate from the error value, so `undefined`
is still saved and rethrown. An unexpected background `kick()` failure that
is not a stale owner/generation fence or `run_not_runnable` also marks the
consumer unavailable. That drain error is already returned by `kick()`;
shutdown does not throw it again, so hold retirement still runs. A later
explicit kick may drain work that was already accepted. Handled cancellation
and those fences do not fail-close accept. Later accept fails closed before
a new Run is persisted. Background `kick` rejections are caught. Shutdown
still drains in-flight execution and closes SQLite, then reports a saved
lease-keeper error, including when that error value is `undefined`. The
failure does not seal the live provider turn as `indeterminate`.
Restart has no in-memory promises, so it still converges
previous-owner claims under the exclusive consumer lock and then reconstructs
reservations from SQLite. Started unknown writers remain indeterminate;
bounded proven read-only recovery uses the same limit. No semaphore count,
second queue or additional executor is persisted.

```text
accept transaction commits request + pending dispatch
→ dispatcher claims with owner + generation + lease
→ runtime materialize (AppState) + CAS execution-start fence
→ completion transaction records result + terminal MemberTurn/Run
```

  Claims use `owner`, `generation`, and `leaseExpiresAt`. Steady-state recovery is **lease-driven**: without explicit process-death evidence, a live claim is left until its lease expires.

  Startup handoff after the exclusive consumer lock: the lock IS explicit process-death evidence — the previous dispatcher is proven gone — so `activateAfterConsumerLock()` converges foreign `claimed` rows immediately via `convergePreviousOwnerClaims()` instead of waiting out their old lease:

  - claimed, **never started** → `pending` with owner cleared, provenance verbatim (orderly handoff, never the recovery rewrite)
  - claimed, **started**, completion unproven → bounded enforced-read-only retry under the PR9 policy below, otherwise `indeterminate` (MemberTurn and Run, `started_result_unknown`); **never** blindly replayed
  - members of terminal Runs → dispatch finished (already finished business)

  Lease-expiry reclaim (no lock held, e.g. mid-process drain):

  - claimed, **never started** → requeue (`pending`, generation++); safe to dispatch again
  - claimed, **started**, completion unproven → bounded enforced-read-only retry under the PR9 policy below, otherwise `indeterminate` (MemberTurn and Run); **never** blindly replayed

  Execution start is that same fence plus run/member still runnable. A stale worker whose claim was recovered must not call the underlying runner.

Do not treat “dispatcher process disappeared” as “task never ran” when `startedAt` / `sourceTurnId` exist.

Queued Runs on a Topic are claimed in **human request message `seq` order**, not `created_at` + lexical Run id.

A drain pass that hits a generic pre-start failure **requeues that claim and defers its Topic for the rest of the pass**. It does not abort the drain. Each `kick()` records a monotonic wake generation. A pass may skip deferred Topics so a poison row cannot starve other work and cannot hot-loop. If a new wake arrived during that pass — including a same-Topic accept — the dispatcher starts one fresh pass with the deferred set cleared. Without a new wake, a permanently failing Topic is not retried.

## Execution correlation

On execution start the dispatcher persists `sessionAlias`, `logicalSessionId`, and a minted `sourceTurnId`. That id is passed into Control as `promptRequestId` so TurnQueue can treat it as the durable execution identity for **this** prompt. It is not a pre-existing transport turn id.

Cancel/inspect uses a request-id-aware seam (`cancelTurnForPromptRequest` / `inspectPromptRequest`). Aborting the session lane alone does not prove the turn produced no effects. `ControlConversationTurnRunner.cancel()` aborts the exact prompt, then waits a **bounded** settlement deadline (TurnQueue drain timeout by default). A proven completed/failed/cancelled result is persisted as such; if the provider ignores abort, both `cancel()` and the outward `runner.run()` resolve as `unknown` and the Run/MemberTurn become `indeterminate`. A late provider settle cannot resurrect that Run. Teardown observes indeterminate instead of hanging.

After `markExecutionStarted`, the dispatcher re-reads Run/MemberTurn following every await before `runner.run()`. If the Run is no longer `running`, or the member/source no longer matches this attempt, it returns without invoking Control. When the live matching attempt observes durable cancel intent before calling `runner.run()`, the dispatcher has local proof of non-admission: it persists the member as cancelled and completes its dispatch through normal cancellation settlement. The durable start and source remain audit evidence; this settled attempt counts once in `consumedMemberTurns`, and the Run retains its cancellation provenance without returning to the Router. `startedAt` alone is still conservative evidence after process loss, not proof of provider admission or non-admission. The runner registers `promptRequestId` synchronously before `ConversationExecutionPort.promptImmediate`, with an `AbortController` covering the whole pre-admission interval (including a pending `sessionConfigSetTails` wait). Cancel aborts that controller before/alongside `cancelTurnForPromptRequest`. After any config-tail wait and immediately before `TurnQueue.submit`, `promptImmediate` returns a typed cancelled result (`cancelled: true`) and never admits the turn if the signal is already aborted. Once TurnQueue has admitted the `promptRequestId`, cancel stays on that exact request-id path. A terminal or indeterminate Run must never start new side effects afterward. Settled runner entries are kept for late-cancel `completed` reporting, bounded by TTL/max like TurnQueue request-id tombstones.

Recovery never uses latest-turn-in-alias, text match, or timestamp proximity.

The runner seam is `ConversationTurnRunner` / `ControlConversationTurnRunner` wrapping the core-private `ConversationExecutionPort` (`promptImmediate` / request-id-aware cancel / `cancelQueuedConversationItem`). That port is obtained only via `conversationKernel(control)` — a WeakMap companion, not methods on the `ControlService` class. `promptImmediate` uses the same TurnQueue / SessionTurnRunner path as interactive `prompt()`, but **never FIFO-enqueues** when the session lane is busy (`queueable: false`). ConversationStore already owns durable queuing; a busy lane fails the Run immediately instead of leaving a TurnQueue item that can execute after the durable Run is already failed.

That port is **not** the public Control facade. `ChannelStartInput.control` and `xacpx/plugin-api` expose `PublicControlService` only. The `ControlService` class itself has no `promptImmediate`, `cancelTurnForPromptRequest`, `inspectPromptRequest`, `cancelQueuedConversationItem`, or `{ conversationSeam: true }` bypass. Public `ControlPromptInput` has no writable `executionOrigin` or `conversation` correlation. `ConversationTurnCorrelation` remains an **output** event DTO. Public callers route by Bot / Conversation / Topic / Run IDs; they cannot mint human permission authority or address a hidden session.

`BotRuntimeManager` is **runtime materialization/binding only**. Direct Bot turns enter solely through `ConversationRunService` → dispatcher → runner. There is no second Bot execution engine and no `promptDirect` bypass.

Interactive `PublicControlService.prompt()` is always `turnOrigin: "human"` and always applies the ordinary-session owner guard. Conversation `promptImmediate` lives only on `ConversationExecutionPort`, takes store-derived `executionOrigin`, and **fail-closes to `orchestration`** unless that value is exactly `"human"`. Omitting origin cannot mint human authority. Extra fields on the public prompt input are stripped before admission. Public `promptConversation` strips `humanIngress` / `executionOrigin`; only `conversationKernel().promptConversationFromHumanIngress` may bind trusted ingress.

## Execution permission provenance

Product routing identity (`ConversationId` / `TopicId` / `RunId`, plus TurnQueue isolation `bot:<conversationId>:<topicId>`) is **not** human permission authority.

Human interactive permission authority requires **both**:

- a fresh same-process `authorityEpoch` match on the claimed dispatch row, **and**
- complete server-derived `HumanIngressContext` (authenticated `senderId` + a permission return `chatKey` that is **not** a `bot:` isolation key)

```text
trusted human ingress + same-daemon epoch     → human
public / plugin promptConversation (no ingress) → orchestration
accept committed → daemon crash before first claim
  → startup redispatch (new authority epoch; ingress discarded) → orchestration
claim expires before start → automatic redispatch                 → orchestration
automatic pre-start retry after an internal failure              → orchestration
```

Public `ConversationPromptPayload` / `promptConversation` stay `{ conversationId, topicId, requestId, text, target? }`. Callers must **not** send `executionOrigin`. Relay Hub overwrites `humanIngress` from the authenticated account on `control.conversation.prompt` without adding that RPC to `CHAT_SCOPED_TYPES`. Connector `trustedConversationPrompt` is the only path that may pass ingress into `conversationKernel().promptConversationFromHumanIngress`.

The durable boundary is the dispatch `authorityEpoch` **bound to** `humanIngress`. Accept stamps both together or neither. `recoverExpiredClaims` and `releaseClaimToPending` null both. Claim compares the live epoch to that row — not `generation > 1` (crash-before-first-claim is still generation 1) — and requires complete ingress for `human`. MemberTurn.origin becomes `recovery` otherwise. The dispatcher copies that durable origin into Control and, for human MemberTurns, a separate `permissionChatKey` from ingress. It never hardcodes `"human"` and never uses the product `bot:` chatKey as a permission return route.

`PermissionInteractionBroker` resolves via `resolvePermissionTurnRoute`: origin must be `human`, and the return chatKey is `metadata.permissionChatKey` (trusted ingress) rather than the isolation `chatKey`. A `bot:` key never mints an interaction.

  ## `indeterminate`

  If a side-effect-capable underlying turn has started and completion cannot be proven (crash after start, cancel of a write-capable started turn with unknown outcome):

  ```text
  MemberTurn.state = indeterminate
  Run.state = indeterminate
  ```

  Unknown side effects seal the Run in **either mode** — even an explicit multi-member batch: every still-runnable sibling settles as `indeterminate` with its dispatch finished in the same transaction, so no new side-effect-capable turn can start after unproven execution. Sealed scheduling stays dead, but proof from an execution admitted before the seal still persists: a concurrently running sibling (reachable on a `shared` Topic) that later returns a proven completion/failure reclassifies to its outcome with its evidence durable (message / `failedBotIds`), and the Run re-derives from the whole batch — an unknown sibling keeps it `indeterminate`. Only already-started proof lands; nothing new is ever claimed after the seal.

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
3. Reconcile indeterminate by recovering **expired** claims in the teardown scope only. The scope is enforced in the SQLite query, not by recovering every claim and filtering the result. Direct teardown passes its Conversation id. Group Topic teardown passes that Conversation and Topic. Group teardown passes the Group Conversation id, which includes every Topic and ghost durable work of that Group and no other Group or Direct Conversation. Before that recovery, the dispatcher flushes leases for claims this process still holds, so a live provider turn is not classified as a crash merely because the teardown clock moved. A claim with no live owner whose lease has actually expired still seals or requeues under the existing rules. Cancel/delete fences remain part of claim and physical start.
4. Verified owned-session release via `releaseOwnedSession(alias)` (production wiring: `createStrictOwnedSessionRelease` → `removeAliasWithPhysicalLifecycle` with `physicalFailurePolicy: "strict"`). Any physical Runtime **or CLI** release/delete failure throws **before** the LogicalSession row disappears. Ordinary `/session rm` keeps the helper's default legacy CLI best-effort path and is not this seam. `SessionService.removeSession` is logical-only. `BotRuntimeManager.releaseDirectBinding` uses the same strict seam under the per-Bot lifecycle gate.
5. Per-Bot lifecycle gate for finalization: remaining ownership release through that same seam, AppState binding/topic/conversation cleanup, **then** delete ConversationStore rows / deleting tombstone.

A crash before step 5 leaves the SQLite `deleting` barrier in place: new accepts fail closed and teardown is retryable.

Injected release failure leaves `deleting` + ownership in place for retry.

**Remaining Bot-delete boundary:** `BotService.deleteBot` stays fail-closed (`bot_in_use` / `bot_in_group`) and does **not** auto-teardown. It consults AppState runtime references **and** ConversationStore durable work (`hasDurableBotWork`) so an accepted Run/outbox cannot outlive a deleted Bot through a crash-before-materialize window. Call `ConversationRunService.teardownDirectConversation` first, then delete the Bot.

## Group foundations and explicit routing (PR6 + PR7)

Group Conversations are durable membership records (`kind: "group"`, `botIds` ≥ 2 unique, optional lead in membership, opaque `conversation_` id). No execution, routing, or member sessions happen at Group CRUD time.

Group Topics carry an explicit `ExecutionTarget` (`workspace` + optional `cwd` + `isolation`). `cwd` is forward-compatible persisted shape only: `createGroupTopic()` rejects any non-empty `cwd` with `cwd_unsupported`, and member materialization also fails closed on a persisted non-empty `cwd` — until launcher execution honors it. `shared-single-writer` is the engineering default. `worktree-per-member` remains readable as a legacy persisted enum value, but `createGroupTopic()` rejects it with `invalid-isolation` until PR10 provisioning exists. Topic teardown mirrors the direct order at Topic scope: mark deleting → cancel active Runs → reconcile expired claims for that Topic only → verified member-session release → remove member bindings → delete store rows → remove Topic metadata. Retryable on release failure. Group delete's final recovery pass uses the Group Conversation id, so ghost rows of that Group are included and other Conversations are not.

Group delete is barrier-first: mark the Group deleting in SQLite + AppState (new Topics and new Group work fail closed from there), teardown every remaining Topic, verified-release residual member runtime, delete residual Conversation-store rows, then remove the Group record last. Rows-after-release-before-record means a physical release failure leaves durable Run/message history intact, and a store-cleanup failure leaves the Group row and the barrier intact for retry; the fail-closed metadata delete reuses the same Topics/bindings/durable-rows guards.

Member sessions run Bot agent/model/effort on the Topic workspace (Topic owns the work target; runs in the workspace root — per-Topic `cwd` is not honored yet). Member bindings scope `conversationId × topicId × botId` with a `group-member`-separated deterministic id, `brt_group_` aliases, and `group-member` session owners. Direct vs Group, Group A vs Group B, and Topic A vs Topic B all isolate. No Router/controller session exists.

PR7 adds explicit Group routing with same-Run member cohorts: a Group prompt (`ConversationPromptRequestDto.target` via `control.promptConversation`, message `control.conversation.prompt`) carries a structured target — `{mode: "members", botIds}` (explicit assignment), `{mode: "everyone"}` (eligible-member expansion), or `{mode: "automatic"}` (rejected for explicit prompts; Direct-only preview surface). `{botId}` is the Direct variant of the same union. The wire validator, `parseGroupTarget`, and the public-Control sanitizer enforce the same mutually exclusive union: mixed shapes fail closed with `invalid-target` (never laundered, never dropped-then-defaulted). Target member IDs must be unique in caller order — duplicates are rejected with `invalid-target`, not deduplicated. `everyone` expansion is capped at `MAX_GROUP_TARGET_MEMBERS` (64); larger requests fail `target_too_large` before persisting anything.

The filesystem seam (`conversation-filesystem-policy.ts`) classifies a declared `MemberTurnEffect` plus provenance: only `effect === "read-only"` **with** `effectProvenance === "declared-enforced"` is concurrency-safe under `shared`/`shared-single-writer`; every other combination takes the single-writer slot, so unproven work serializes against any in-flight execution on overlapping trees. The effect is never inferred from Bot names. PR7 accept persists every member as `unknown` provenance, so current user Group turns serialize — sharing a tree today means taking turns, not overlapping. The UI keeps the `Shared` option with copy that says exactly this.

Request-snapshot integrity uses one unified invariant (`requestSnapshotMatches`): the `runs.request_message_id` row must exist with the Run's own Conversation AND Topic, the human role, **and** the Run's own `run_id`. A missing or mismatched row fails the claim terminally before execution start (`missing_request_snapshot` / `request_snapshot_mismatch`), in replay and transcript paths alike — a corrupted reference can never feed another message's content into a prompt. Claim reads LEFT JOIN the message so a poison row reaches that check instead of being silently skipped.

## Automatic collaboration and the stateless ConversationRouter (PR8)

PR8 adds automatic collaboration for Group Conversations. A human explicitly selects automatic mode; the durable Run then carries **zero** MemberTurns (`members: []` + `mode: "automatic"`), because no human chose anyone, and a stateless **ConversationRouter** decides each step. Accept and durable replay return `memberTurns: []` with the singular `memberTurn` absent until members exist. The same `requestId` replays the same Run before current Router/configuration or membership checks, including after a lost response and Router removal. Cancellation and verified teardown also work for zero-member queued, routing and waiting-human Runs. Cancelling a routing/waiting-human Run after its members settled records cancelled/human-cancelled on the Run while preserving completed members and their results.

```
queued ──accept──▶ routing ──decision──▶ dispatching ──batch terminal──▶ routing again
                                                              │                  │
                                                              └── complete ◀─────┘
                                                                   need-human
                                                                   failed (budget / router / rejected)
                                                                   cancelled / indeterminate (sealed)
```

`routing` is a durable `runs.routing_state` substate, not a new top-level Run state: `queued` → `routing` → `dispatching` → `done` (written with a terminal or waiting-human Run state). Restart behavior is derived from rows alone: a `dispatching` Run waits for its MemberTurns, and `queued`/`routing` recomputes the decision, so there is no in-process state to lose. Explicit Runs never carry `routing_state` and never route.

Routing uses per-Run singleflight across accept, batch settlement and activation recovery. Before asking the Router, the store increments `routing_generation` and reserves the Run as running. Routing and dispatch claims respect the Topic's earlier queued requests and active/waiting owner, including zero-member automatic requests; a settled or cancelled owner wakes eligible successors. Every dispatch, need-human, complete and routing-failure commit checks this generation and the current routing state. A restarted process can acquire a new generation; older output cannot terminalize or fail its newer batch. Shutdown waits for every tracked routing call.

The engine enforces a 30,000 ms decision deadline, configurable through `decisionTimeoutMs` (composition: `routerDecisionTimeoutMs`). Adapters receive an AbortSignal. Timeout settles the owning generation as `failed/router_timeout`; human cancellation seals the Run as `cancelled`. Graceful shutdown aborts tracked calls with a distinct `router_shutdown` reason and drains this process's routing work without terminalizing an uncommitted Run: `queued` or `running/routing` remains recoverable, with completed members, results and budget intact. The next consumer's activation recomputes the decision under a new routing generation. The engine races provider work against abort itself, so an adapter that ignores the signal cannot hold awaitRouting or shutdown indefinitely. Detached late resolution/rejection cannot commit, overwrite a recovered generation or reopen a terminal Run. Shutdown interruption also applies while awaiting selected Bot lifecycle gates before decision commit.

**Capability boundary (fail closed, pre-execution).** `bindRouter` accepts only a Router implementation that declares, before any model call, that it has no tools, no filesystem/terminal, no permission interaction, no Agent Messaging/Orchestration side effects, and bounded structured output only (`isRouterCapabilityRestricted` — every one of the seven flags must be `true`). A missing or permissive declaration means `bindRouter` returns `undefined`, so no engine is built and `{mode: "automatic"}` accepts fail closed with `automatic_unsupported`. Observing "no tool events" after the fact is never a proof. No Router configured for an already-accepted automatic Run fails that Run durably rather than parking it forever.

**RoutingInput is public-only.** `ConversationRouterEngine.buildRoutingInput` derives every field from durable rows or live product metadata: the Run's own human request (referentially fenced by conversation+topic+run+role), a bounded newest-first window of THIS Topic's public messages (`ROUTER_PUBLIC_TRANSCRIPT_MESSAGES = 200`), current live Group membership with Bot profiles, the durable Run row, this Run's durable MemberTurns with their public results, `maxMemberTurns - consumedMemberTurns` as the remaining budget, and the Topic's `ExecutionTarget`. No Direct history, no private content, no other Topic, no hidden session, no Bot `instructions`, and no Router-side conversational history: each `decide` call rebuilds the snapshot from rows, so a warm model process cannot carry state across decisions.

Router output bounds include 128-character assignment/Bot/reference IDs, 64 dependencies, and 64 supplied trigger IDs per assignment; duplicate references are rejected before any store lookup. Input uses a 131,072-character serialized JSON ceiling. Deterministic text budgets retain request prefixes (16,000 characters), transcript prefixes by descending message `seq` (2,000 per row / 32,000 total), and completed result prefixes (4,000 per result / 32,000 total). Transcript budget allocation prioritizes the newest messages independently of array order and preserves that array order; the production engine supplies the nearest 200 rows newest-first. Historical task/expected-output descriptions and presentation metadata are also capped, with explicit truncation flags; durable rows and actual member execution input remain intact. Identity fields are never truncated. Excess fixed structure fails as `router_input_too_large` before the model call. Large Groups expose at most 128 routing candidates: enabled members first in Group order, then disabled members in Group order, with `omittedMemberCount` disclosed. This bounds the model snapshot without imposing a Group membership/admission cap.

**Decision gate.** `gateRoutingDecision` is two layers, both fail-closed. `parseRoutingDecision` decodes strictly: unknown fields/types, missing required trigger arrays, over-long fields, non-string ids and malformed arrays reject with a machine-readable code. PR8 rejects `synthesisBotId` as unsupported; synthesis must use a concrete dispatch assignment. Then domain validation runs against the input: every `botId` must be a live **enabled** member, assignment ids must be unique throughout the Run (also enforced by a SQLite unique index), `dependsOn` must resolve inside the decision or to a durable assignment of this Run, the dependency graph must be acyclic, `single` must carry exactly one assignment, `parallel` at least two, dependencies require sequential mode, a Bot may not appear twice in one batch, and the batch must fit the remaining budget. After the asynchronous Router call, the engine acquires lifecycle gates for selected Bots and re-reads current Group membership, enabled state and execution snapshots immediately before the synchronous durable write. No lifecycle gate is held across the model call. A rejected decision creates no MemberTurns for that decision.

Commit-time revalidation checks Group membership before reading the selected Bot profile: a member removed and then deleted during the Router call fails with `router_unknown_member` before any MemberTurn is created. Typed Bot lifecycle errors are also durable domain rejections (`bot_not_found` → `router_unknown_member`, `bot_disabled` → `router_disabled_member`), under the same routing-generation fence. They cannot leave the attempt parked in routing or fail a newer owner; settling the failed owner wakes the Topic's eligible queued automatic successor.

**Commit.** `store.applyRoutingDecision` inserts one MemberTurn + one pending dispatch per assignment in the next batch with `origin: "router"`, preserving `assignmentId`/`task`/`expectedOutput`/`dependsOn`, and takes the Topic single-writer effect policy (`unknown` — automatic work carries no enforceable read-only proof). Batch numbering begins at 1. Router-supplied trigger references are extended with the Run's own request and exact completed dependency results to form the MemberTurn's effective `triggerMessageIds`; this derived set is not a verbatim copy of Router output. `need-human` parks the Run as `waiting-human` with `completionReason: "needs-input"` and records the question durably, leaving `finishedAt` absent until actual settlement. `complete` settles `completed` with the Router's reason. Every decision appends one audit row to `routing_decisions` (never read for scheduling); verified Topic/Group teardown deletes these rows with their Runs. Budget exhaustion is an explicit `failed` + `budget-exhausted` terminal: `maxMemberTurns` is a loop guard, never a completion definition.

Automatic admission locks and snapshots one enabled member as the zero-member Run's carrier; it does not expand an explicit target or apply its 64-member cap to Group membership. The carrier is revalidated under its lifecycle gate, with acquisition retried if the eligible carrier changes. Other members may enable concurrently. Router-selected members still acquire their own lifecycle gates at decision commit, and the decision must fit the Run's remaining turn budget.

`failedBotIds` and `unavailableBotIds` describe the active batch. A settled batch retains its aggregates for the next Router input; committing a new dispatch batch atomically resets both lists alongside `activeBatch`. Settlement and cancellation aggregate only active-batch members. PR9 separately retains monotonic Run-wide `quarantinedBotIds`; clearing batch aggregates cannot make a failed Bot eligible again in that Run. Assignment history, exact results and consumed turn budget remain intact.

Group execution with a durable assignment prepends a server-generated envelope with `Task:` and optional `Expected output:` to a separately delimited `Public Group context:`. Assignment semantics follow durable assignment identity, including when provenance changes from `router` or `handoff` to `recovery`; task validation and blocked-step evidence remain active after recovery. Each Bot receives its own assignment instructions; parallel Router siblings retain identical public context without seeing each other's tasks. Sequential successors receive their own assignment plus exact dependency results. Initial explicit Group prompts retain their existing composition and authority.

An automatic `waiting-human` Run exposes the durable question as optional `waitingQuestion` in Control Run DTOs/detail, Relay events and reconnect reads. The waiting transition writes this field atomically with its audit row. Existing waiting Runs are backfilled from their last committed need-human audit decision during migration. The projection omits it once the Run leaves waiting-human; no answer/resume UI is implied.

**Parallel vs sequential transcripts.** Each member receives the same newest bounded pre-request public baseline, the Run's own request, and only explicitly referenced trigger/dependency rows. A sequential successor adds its completed dependencies' public results by the exact join `MemberTurn.sourceTurnId → ConversationMessage.sourceTurn.turnId`, scoped by Conversation, Topic, Run and Bot. Repeated assignments to the same Bot therefore retain distinct results, with no content match or lookback limit. Allowed rows are deduplicated and sorted by seq; extending dependencies never includes intervening later queued Runs' requests. Parallel siblings share a frozen effective reference set, so an early sibling result cannot change the other members' selected input. Every trigger is revalidated in scope at dispatch.

A completed assignment must have its exact public result row. Router input, decision commit and dispatcher prompt composition share `requireMemberResult`; a missing/corrupt source identity rejects with `member_result_missing`, while an existing row with empty content remains a valid result. Dependency evidence is validated before runtime materialization/execution start, so a missing successful result cannot silently become empty input for a successor.

Web state merges preserve the backend's one-way transition from running to waiting-human: a delayed running snapshot of the same Run cannot erase its confirmed waiting state or question. Terminal settlement still clears the waiting question.

**Filesystem policy is unchanged.** Router-requested parallelism never bypasses the PR7 writer-slot gate: `mustDeferForWriterSlot` still serializes any turn that is not `read-only` + `declared-enforced`, and PR8 never supplies that proof, so automatic Group work always takes the Topic single-writer slot.

**Provenance.** Router-selected MemberTurns are `origin: "router"` and execute as `orchestration`: the accept-time human ingress authorizes the Run's request, never the downstream automatic work, so dispatch rows for automatic work carry no `authorityEpoch` and no `humanIngress`. A typed provider permission failure (`RUNTIME_PERMISSION_DENIED` / `PERMISSION_DENIED`) passes through SessionTurnRunner, TurnQueue and the Conversation runner to atomically persist `blockedReason: "human-authority-unknown"` with the failed MemberTurn. Error text is never parsed to infer permission authority, and denial does not prove that a human would be allowed. The domain also accepts explicit `human-authority-required` evidence from a runner that can prove it. The future UX action creates a NEW explicit human request and never upgrades the stored origin.

**Cancellation and sealing.** A cancelled Run is never re-routed, a sealed `indeterminate` Run never receives a dispatch (no blind retry), and late Router output for a terminal Run is a durable no-op.

While physical cancellation is pending, a completion reason on a queued/running Run is durable cancel intent. Routing eligibility, generation acquisition, decision commit and routing failure all respect that intent. Natural member settlement may preserve successful or failed evidence, but cannot create another automatic batch; once the current batch settles, the Run classifies from its proven outcomes. At activation, previous-owner started work first seals as indeterminate; pending cancellation whose members already settled (including late evidence persisted before a crash) is then classified before dispatcher/Router work resumes.

Terminal pre-start member failures also wake eligible automatic routing through the same durable batch-settlement path as provider results. A failed member cannot leave its Run parked in dispatching; corrupted completed dependency evidence subsequently fails the Run before another Router call. Shutdown stops new dispatcher claims at entry, before draining routing and existing execution, so an active member's settlement cannot start another queued Topic during shutdown.

## Production composition

`buildApp` (`src/main.ts`) constructs the production Conversation runtime via `createConversationRuntime` (`src/conversations/conversation-composition.ts`) **before** Control/Relay accept Conversation requests. Construction is **passive**:

- SQLite path is `dirname(config.json)/runtime/conversations.sqlite` (`resolveRuntimeDirFromConfigPath`).
- Each daemon process mints a fresh `authorityEpoch`.
- The daemon-wide AppState `stateMutex` is injected into `SessionService`, `BotService`, `BotRuntimeManager`, and `ConversationRunService`. Conversation COW publication uses that same mutex for short `structuredClone` → `saveNow` → `replaceRuntimeState` sections only; it is never held across `SessionService` awaits. Do not invent a Conversation-only mutex.
- `BotService` create/update/delete is durability-gated COW: clone → mutate next → `stateStore.saveNow(next)` → `replaceRuntimeState`. `createBot` / `updateBot` returning success means the Bot (including `profileRevision` / execution identity) is already on disk. Conversation SQLite accept may snapshot that Bot; it must not depend on a pending `DebouncedStateStore.save()` flush.
- `buildApp` must **not** call `dispatcher.kick()` / `conversations.kick()`. Accept-time `autoKick` stays inert until activation. `autoKick: false` also suppresses accept-time and routing kicks, so an accepted Run stays queued until something calls `wakePendingWork()` or `dispatcher.kick()`. `wakePendingWork()` itself does not consult `autoKick`; Bot re-enable and handoff use it, and it still no-ops when the consumer is unavailable or closed.
- `runConsole` acquires the daemon consumer lock, runs stale-owner / orphan convergence, **then** `runtime.conversations.activateAfterConsumerLock()` (recovery kick), **then** starts channels. A process that loses the lock must not claim or execute durable Conversation work.
- `activateAfterConsumerLock` sets the consumer activated **only after** the initial `dispatcher.kick()` succeeds. A failed first drain marks the Conversation consumer unavailable (`conversations_unavailable`): later accept fails closed and does not `autoKick`. The same unavailable state is set if a later lease renewal or an unexpected background `kick()` hits an error that is not a stale fence or `run_not_runnable`, including when the thrown value is `undefined`. Accept cannot persist a Run this process can no longer schedule. `runConsole` logs `conversations.recover_failed` for that initial activation failure. The first later fatal lease or background-kick error is reported once, synchronously, through `onSchedulingFailure` (production: `conversations.scheduling_failed`) with the original value. Shutdown still does not rethrow a drain error that `kick()` already returned.
- `stale_claim` and `run_not_runnable` are absorbed inside renew, writer-slot recheck, hold, and execution start. `claimNextDispatch` does not throw them: it claims one pending row or returns undefined. A benign fence therefore does not end the kick, and the in-flight member of that kick still settles without another user message. A lost held claim is dropped from the in-memory hold because the store fence says this process no longer owns it.
- `ConversationRunService.shutdown()` awaits dispatcher shutdown (which waits for in-flight provider turns) and then closes SQLite even when that shutdown reports a saved lease-keeper error. The error is thrown after the connection is closed.
- Crash-before-first-claim work recovered after activation is claimed as `recovery` / `orchestration` (new epoch; saved human ingress discarded).
- Shutdown stops the dispatcher, waits for in-flight drain, then closes SQLite **before** disposing `state.json`. The composition marks the runtime `stopping` first so **new** Control Bot/Conversation APIs fail `runtime_closed` immediately, then **waits for in-flight public mutations** (operation lease) before `bots.close()` / dispatcher shutdown / SQLite close. Concurrent `shutdown()` callers share one promise. `shutdown()` resolving means the Bot/Conversation subsystem is quiescent: no later `replaceRuntimeState` from a mutation that entered before shutdown.

Public Control / Relay APIs are projections of this domain. Callers address Bot ID, Conversation ID, Topic ID, Run ID, and message `seq` only. They never choose hidden session aliases, `logicalSessionId`, TurnQueue ids, `bindingId`, or `chatKey` as product routing identities.

```text
Untrusted/public client
        │
        ▼
PublicControlService / Relay API
        │
        ├── Bot IDs
        ├── Conversation IDs
        ├── Topic IDs
        └── Run IDs
        │
        ▼
ConversationRunService
        │
        ▼
durable store / dispatcher
        │
        ▼
core-private conversationKernel() / ConversationExecutionPort
        │
        ▼
hidden LogicalSession / TurnQueue
```

Ordinary alias-addressed Session APIs (`PublicControlService.prompt` / `removeSession` / archive / rename / model / effort / cancel, chat `/session` lifecycle) fail `hidden_session` when `LogicalSession.owner` is product-owned. The check is owner metadata, not a `brt_` alias prefix. Conversation execution/release uses only `ConversationExecutionPort` (`promptImmediate` + store-derived correlation, request-id cancel, `cancelQueuedConversationItem`) and `releaseOwnedSession`.

Native-session list/attach is a second ordinary Session door onto the same model context. Ownership is the native catalog — resolved cwd (path-equivalent) plus a **physical selector** after stripping xacpx-owned ACP output-guard wrappers: unwrapped argv identity, raw `--agent` command, or bare positional agent. Config labels (`driver`, overlay `acpxAgent`, workspace/agent names) are not part of that store identity. Same argv or same raw command at the same cwd occupy one catalog even when `driver` strings differ. Distinct argv remain distinct. Selector evidence is argv → explicit `rawCommand` → managed overlay without argv (unproven) → historical `agentCommand` → ordinary bare agent. Explicit `rawCommand` proves a raw `--agent` selector; recorded `agentCommand` is only historical identity and cannot override a managed overlay alias that lost its argv. An unproven selector keeps a known cwd: same-cwd attach fail-closes, a proven different cwd is not blocked. Guarded Bot `ResolvedSession` identity and unguarded native-list `resolveConfiguredAgentLaunch` must canonicalize through `nativeCatalogIdentityForLaunch`. `SessionControlService.assertNativeSessionAddressable(agent, workspace, agentSessionId)` resolves that catalog, enumerates product-owned LogicalSessions in it, prefers persisted `agent_session_id`, and otherwise reverse-looks up via transport `getAgentSessionId()`. Public `listNativeSessions` hides those proven IDs (presentation only). `createSession(..., agentSessionId)` / `attachNativeSessionWithTransport` re-check before `resumeAgentSession`: a hidden native ID fails `hidden_session`, and a product-owned candidate whose native identity (or catalog membership) cannot be proven fail-closes rather than guessing "not conflicting". Chat `/ssn` uses the same guard.

Direct Conversation **identity** (Conversation id, owning Bot id, default Topic id) is durable and stable across rename and materialization. Direct Conversation **presentation** (`title`, `createdAt`, `updatedAt`) is always the current owning Bot projection, whether or not an AppState Conversation row has been materialized. First prompt / `createTopic` is not a presentation freeze point. Rename does not rewrite durable Conversation identity.

Default Topic identity is independent of Bot rename. `createdAt` is the owning Bot's creation time. `updatedAt` is the last real Topic mutation; until a Topic rename/archive API exists, synthetic and first-persisted `updatedAt` equal `createdAt` (not `Bot.updatedAt`). Hidden materialization must not change the public default Topic DTO.

Before a Direct Conversation is persisted, public list/get synthesize the bounded Conversation/default Topic from durable Bot timestamps (`createdAt` / `updatedAt` for Conversation; default Topic uses Bot `createdAt` for both clocks), never read-time `now`. After persist, list/get still overlay Conversation presentation from the Bot, and default Topic `createdAt` **and** `updatedAt` from the Bot (so a PR3 row that stored materialize-now timestamps presents identically to a PR4-created Topic). The semantic default Topic id is `createDirectTopicId(botId)`.

Successful `createBot` / `updateBot` / `deleteBot` emit both `bots-changed` and `conversations-changed`, because `conversations.list` includes a Direct Conversation for every Bot (synthetic until materialized).

Idempotent `requestId` retries reuse the durable accept result and do not re-emit the initial `conversation-message` / queued `conversation-run-changed` projection.

`ConversationRuntime` owns process lifecycle (`open` → `stopping` → `closed`). After `shutdown()` **returns**, every public Bot/Conversation Control mutation **and** read fails `runtime_closed` (including Bot CRUD, Topic create, prompt, history, Run cancel), and in-flight mutations that entered before shutdown have already completed. Concurrent `shutdown()` awaits the same promise. In-flight dispatcher drain may finish after the public lease drains; new product work must not start. `BotService.close()` fail-closes Bot mutations as a second gate after the public lease is idle.

Shutdown first marks the runtime stopping to reject new operation leases, then waits for entered operations, including `group_send` waiting on Bot lifecycle gates. It stops and drains the Run service/dispatcher before closing the handoff service. Live execution capabilities remain available through this drain, so an entered handoff can commit and an already started execution can bind its capability. Handoff capability revocation runs in `finally`, including a failed drain; shutdown failures remain visible rather than reporting success.

`topic archive/delete` is not a public Control method until domain lifecycle owns it. `BotService.deleteBot` remains fail-closed while durable/runtime ownership exists.

## Out of scope

Private member-to-member handoff, cross-account routing, and the full blocked-permission "Start this step myself" product flow. PR9 preserves structured blocked-step evidence; a future continuation must create a new explicit human request rather than promote an existing assignment.

## Public structured handoff (PR9)

`group_send({ to, task, expectedOutput? })` is available only on a currently executing Group member's xacpx MCP launch. Input is strict: no sender, scope, Run, origin, authority, or idempotency fields. Bot IDs are at most 128 characters, task 16,000, expected output 8,000; empty/whitespace-only, NUL, unknown fields and malformed values reject before durable work. Public member metadata supplies canonical Bot IDs without hidden Bot instructions.

`GroupHandoffService` binds a private random capability after the durable execution-start fence, carrying the exact sender MemberTurn/sourceTurn/dispatch owner/generation. The core-private Control execution port passes it through TurnQueue/Chat metadata into immutable MCP launch identity. A Group launch exposes only `group_send`; it does not register an external orchestration coordinator. The capability is never a tool argument, prompt body or public event/DTO. Return, shutdown and replacement execution revoke old capabilities. Public Control callers cannot set one. Local IPC retains the same-OS-user trust boundary; an execution capability is not an OS sandbox.

The sender guarantee applies to the bound MCP tool interface: model arguments cannot choose or override its identity. The local IPC endpoint authenticates no presenting process; it validates the execution named by the bearer capability. A same-user process that obtains another live execution's capability can present that identity. Group member subprocesses normally share the daemon's OS account and fall within the existing [same-user trust boundary](external-mcp.md#security-the-trust-boundary-is-the-user-account), which predates PR9. Mutually untrusted Bots with unrestricted terminal access require an additional isolation boundary; neither the internal WeakMap nor launch rotation provides that boundary.

The real ConsoleAgent/CommandRouter path retains the ordinary hidden-session guard. `SessionTurnRunner` stamps the metadata object's identity in a core-private WeakMap with exact Group/Bot/Topic/session/logical-session scope. Only that object and matching owned session may use the Group execution path. A serialized/copied object or caller-supplied token string has no bypass authority. The private Control submit binds the exact alias and preserves the existing coordinator route; ordinary and Direct paths are unchanged.

The Conversation execution path also requires core-private, one-shot `ChatRequest` provenance consumed by ConsoleAgent, with correlation checked against the exact bound session owner. Group launch metadata adds its capability binding to this common Conversation gate. A cloned or replayed request cannot use still-live Group metadata to bypass the gate, and mutable `current_session` cannot retarget the trusted execution.

Runner settlement revokes the WeakMap route in `finally`; retaining even the original metadata object cannot launch a later owned prompt.

Before acquiring target lifecycle gates, handoff checks current Group membership and target Bot existence without allocating locks. Invalid target IDs cannot grow the per-Bot gate registry. Sender and target lifecycle gates then revalidate current membership, enabled target, active Topic, Conversation deleting barrier and exact runtime/session ownership. The synchronous SQLite transaction proves the sender is running under the live claim, the Run is running without cancel intent, and the target is not quarantined. No await separates final lifecycle reads from this write.

That transaction appends one public `system` message with sender Bot/Run and structured `handoff` metadata (`senderMemberTurnId`, `to`, `assignmentId`, `memberTurnId`, `task`, `expectedOutput?`), one existing MemberTurn with `origin: "handoff"`, and one pending dispatch. It extends the current Run/batch, with no new human Run or handoff runner. Public history and `conversation-message` expose the envelope to the user and Group. Events notify committed rows; reconnect reads history and deduplicates by message ID.

Target references freeze the sender's legal public references, the Run's own request, completed exact public results of this Run and the envelope at acceptance. The dispatcher adds only legal dependency evidence and the pre-request public Topic baseline. Direct/private/other-Topic data, future sibling output, unrelated queued requests and sender hidden model state cannot enter through a widened sequence window. Task and expected output always reach the actual runner. Router/handoff commit and execution-time consumption share one scope predicate: the exact human request snapshot must be valid, and a trigger must match Conversation/Topic and either precede that request boundary or belong to this Run. Corrupted durable references to a later queued Run fail before provider start.

### Idempotency and budget

The Topic's 64-nonterminal-Run queue limit controls admission of new requests. Public handoff extends an already admitted Run, so a full Topic queue does not reject it; deletion barriers, current execution identity and that Run's work budget still apply. Dispatch finishes the active Run before later queued requests, and completing it releases one admission slot.

The durable key is `(sender sourceTurnId, host MCP invocationId)`. The MCP host stamps JSON-RPC request identity separately from model arguments, retaining number/string type. Retransmission returns the original receipt without another envelope, assignment, dispatch, event, wake or debit; changed arguments under that key fail `handoff_idempotency_conflict`. Names, aliases, content equality and latest-Bot-result lookup never define identity. A fresh invocation ID represents fresh work, even when text matches. Clients must retain invocation identity when retransmitting a lost response; model reissue under a new ID is not a retransmission. A revoked capability cannot accept work or impersonate a later execution. After daemon restart committed assignments recover from SQLite; the retired caller cannot replay side effects.

Every accepted MemberTurn reserves one slot. A started safe retry reserves another through `recovery_attempts`: allocated work is the Run's MemberTurn count plus retired recovery attempts. Router/handoff commits and retries check this same durable limit. Explicit Groups reserve at least 24 total slots (or the initial member count when larger); initial execution behavior is unchanged. Idempotent replay and not-started redispatch consume no extra slot. Handoff budget rejection commits `budget_exhausted`; accepted work settles, then the Run fails with `budget-exhausted`, even if the sender caught the tool error or receives a known typed execution cancellation. Execution cancellation still fences scheduling and retains cancelled member evidence, but cannot override the durable budget failure. Unproven execution keeps its `indeterminate` seal; once late proof removes every unknown outcome, the durable budget rejection still governs final classification. Live human cancel retains its existing classification priority, distinguished by `cancellation_reason = 'human-cancelled'`; this exception does not extend to an already sealed indeterminate Run. Restart cannot reset this flag or the allocation count.

### Permission, filesystem, failure and recovery

Handoff work is `handoff`/orchestration-equivalent; retry and failover work is `recovery`/orchestration. Neither has `authorityEpoch` or `humanIngress`, including when a human started the sender. Human-only permission actions fail closed with durable `blockedReason`. Physical start uses the existing filesystem scheduler: unknown effects are potential writers, shared-tree writers serialize, and only `read-only` plus `declared-enforced` can overlap. Same-Bot assignments serialize within a Run to protect the owned Topic session. Acceptance proves durable queuing, not physical start.

Relay Web compares the durable MemberTurn `attempt` before applying same-attempt status precedence. A higher attempt replaces prior execution identity/start/terminal evidence and retires that member's live/output trace caches and completeness flags; it may validly return a running assignment to queued recovery. Both reconnect detail and member-start events use this retirement path, so an old trace cannot attach to the new attempt's result. A lower attempt cannot overwrite the current source or reset its live trace through delayed member-started/member-finished events. Assignment identity and task/dependency metadata remain stable across retry.

A durable result with a source ID renders a detailed trace only after an exact source join within the same Conversation, Topic and Run. Thin or failed detail retrieval preserves canonical message text, including when the same Bot has several assignments. Legacy messages without a source may use a trace only if that Bot has exactly one candidate in this scope.

Known member failure adds Run-wide quarantine without disabling the global Bot or deleting healthy results. Router metadata marks quarantine unavailable; commit/start independently recheck it. The store checks current member eligibility at materialization and the execution-start transaction, including after async waits; a quarantined claim fails before physical start with `member_quarantined` rather than requeueing forever. Durable quarantine JSON must be an array containing only strings; missing, malformed or wrong-type state fails with `run_corrupt`, never an empty quarantine fallback. Legacy schema migration supplies the valid `[]` default before any Run is read. Automatic failover uses the existing stateless Router, remaining budget, assignment/dispatch rows and `origin: "recovery"`. Explicit Runs settle all accepted work without invoking the Router. Quarantine has no automatic same-Run release path; a later independent Run can use the enabled Bot again.

Pending/not-started claims may redispatch through existing fences. A started unknown execution gets **at most one** automatic retry, only for a Group MemberTurn with `effect: "read-only"`, `effectProvenance: "declared-enforced"`, remaining budget, no cancel/delete barrier and no committed downstream handoff from that attempt. A filesystem read-only proof does not prove replaying committed orchestration safe. Model declarations alone never grant the enforced proof; current Router/handoff-created work has `unknown` effect and does not qualify.

Safe retry audits the retired sourceTurn/generation, requeues the same MemberTurn/assignment as `recovery`, increments attempt, clears old physical-start identity and strips authority. Task, expected output, dependencies, exact references, blocked reason, execution snapshot, effect/proof and filesystem policy survive. New start mints a new sourceTurn/capability. Retired success, failure and physical cancel evidence cannot settle the new attempt, including through `reconcileLateResult` after another sibling seals the Run. An unstarted sealed sibling has no physical outcome to reconcile; a late proof must join its actual started source. A second unknown attempt, absent proof, exhausted budget or potential writer becomes `indeterminate` and seals scheduling. Late exact evidence can reconcile outcome under existing rules without restarting work.

On the real ConsoleAgent path, Runtime terminal evidence is preserved: `RUNTIME_TURN_FAILED` is a known failure eligible for Run-local quarantine/failover, `RUNTIME_TURN_CANCELLED` is a known cancellation even without a local abort, and `RUNTIME_PERMISSION_DENIED` / `PERMISSION_DENIED` is a known blocked failure. Control returns/emits the typed Group cancellation flag; it does not infer it from error text. Idle timeout retains its existing classification. Other transport throws after execution-start, including rejection with `undefined`, are carried as an explicit unknown outcome through SessionTurnRunner/TurnQueue/Conversation runner and seal `indeterminate`. They cannot become a successful assistant error message or a failed assignment eligible for blind failover.

A known execution cancellation stops further work for the whole Run. Its member settlement transaction writes durable cancellation intent before returning, cancels every never-started sibling and completes those dispatches. Already-started siblings retain their physical outcomes and public results as they drain. Subsequent member settlement, claim/start, handoff, Router and restart paths observe the same intent; neither `cancelled → completed` nor `completed → cancelled` can resume automatic routing. Batch outcome precedence remains indeterminate > failed > cancelled > completed. A cancelled Run reports `execution-cancelled` when no human Stop was requested; human Stop retains `human-cancelled`. The store keeps cancellation provenance in `runs.cancellation_reason` independently of the live `completion_reason` marker, so an unknown seal and later exact proof cannot misattribute an execution cancellation to a human. Human Stop while the Run is still live takes precedence over the execution cancellation provenance.

Human cancel uses existing durable intent, generations and exact physical cancel. Cancel/delete blocks fresh handoff, retry and Router commits; pending targets cannot start, active targets receive cancel and late tool/evidence cannot revive scheduling. A live original execution can replay an already committed receipt after cancel without new work. Old∪new membership lifecycle gates refuse removing accepted active/pending members; corrupted external removal/deletion fails durably before target start.

### Additive migration and crash windows

Open adds `messages.handoff_json`, `member_turns.handoff_source_turn_id` / `handoff_invocation_id`, `runs.quarantined_bot_ids_json` (default `[]`) / `budget_exhausted` (default 0), unique partial indexes for invocation/envelope identity, and `recovery_attempts` keyed by `(member_turn_id, source_turn_id)`. On first PR9 schema migration, nonterminal explicit Group Runs accepted by PR8 receive at least 24 total MemberTurn slots, preserving larger budgets; Direct and terminal rows retain their budgets. The schema marker and backfill commit atomically, so later opens never refill PR9 budgets or reset consumed work. No second task table exists. Verified Topic/Group teardown deletes attempt audit with dispatch/member/Run/message rows, including Group teardown for Runs whose Topic metadata is already missing.

The additive `runs.cancellation_reason` column preserves cancellation provenance without a new public DTO or request field. Existing cancellation semantics remain the legacy human-cancelled fallback when provenance predates this column; new execution cancellation writes execution-cancelled, and human Stop writes human-cancelled. Reopening does not reset either provenance or the work budget.

Pre-commit failure leaves no handoff rows. Commit before response/start leaves one recoverable assignment/envelope. Claim without start evidence requeues; started unknown effects seal the Run, including pending downstream work. Result commit before notification remains discoverable through history, with exact source joins preventing duplicate append. Tests cover rollback, restart/claim windows, retired evidence, cancel/lifecycle races, same-Bot assignments, mixed-schema reopen, permission refusal, budget loops and Web replay.

**Follow-up before Direct Bot product release:** global dispatcher parallelism (more than one claimed execution in flight across Topics/Bots) is not part of this contract. Keep the current drain/claim sequencing until that work is designed. The drain launches the first claim globally, then admits only same-Run siblings concurrently (Topic isolation decides overlap); unrelated Topics/Bots wait for the next pass, after the cohort settles. A pass that defers Topics on pre-start failure takes at most chained extra passes with the deferrals preserved — never a retry without progress. An unexpected execution failure that escapes the handled settlement paths rejects the drain (and therefore fails activation) after every launched execution settles; it is never swallowed into a successful kick.

## External channel bindings (PR10)

An admitted channel chat may bind to one Conversation and Topic through
`bindConversation({chatKey, conversationId, topicId?})`; `listConversationBindings()`
and `unbindConversation(chatKey)` manage the same durable mapping. Group bindings
require an active Topic; Direct bindings may omit the deterministic default Topic.
Bindings live in `conversations.sqlite`, survive restarts, and are removed when
their Topic or Conversation is torn down. Discord channels and threads, Feishu
chats and threads, and Weixin direct chats use exact chat keys: no parent inheritance.
Conversation bindings for Weixin group chats are not supported by the current sender-addressed
reply adapter. Group events select a distinct account/group key, never a sender's
DM binding or receipt; a selected group binding fails `external_group_unsupported`
before acceptance or Stop. Unbound group events retain the existing Session path.
An unused Direct binding also keeps Bot deletion closed until it is unbound;
creating the binding revalidates through the Bot lifecycle gate.
Other channel plugins can implement the same ingress metadata contract; Relay
keeps its existing structured Conversation API instead of this text adapter.
The namespace before the first `:` uses the registered channel type contract:
nonempty after trimming, with no `:`. Case, underscores, internal spaces and
types longer than 64 characters are supported; chat keys use the canonical
trimmed type. The complete chat key remains bounded to 2048 characters and
requires a nonempty, whitespace-free route suffix. Product namespaces (`bot`,
`control`, `relay`, `group-execution`) remain excluded from this external seam.
The bundled Yuanbao adapter also selects before Session lifecycle; its current
gateway does not prove authenticated-human origin, so bound input remains
fail-closed rather than entering an ordinary Session.
Yuanbao selects using the admitted message's original text and raw media facts,
before consuming group history or downloading attachments. Bound input prepares
before reply heartbeats and does not consume that history; known commands keep
their original text on the Session path. Selector errors provide a rejecting
preparation method as well as `chat`, so adapters fail before UI setup.

The registry supplies an optional `routeConversation` ingress selector. After
authentication/admission, adapters call it before reading the current Session,
marking a Session active, or choosing its executor lane. A selected Conversation
uses its own executor and Agent, without Session foreground/background hooks.
Conversation turns enter acceptance concurrently, without waiting for an older
Run's settlement or channel reply; the durable core Topic queue orders execution.
The selected Agent's `prepareConversation` commits ingress and installs Stop and
settlement tracking before typing/card setup; `chat` then awaits the same result.
Weixin keeps polling with its in-memory cursor while bound preparation is pending,
but persists cursor checkpoints in response order only after each batch's bound
messages have committed acceptance or reached a deterministic ingress rejection.
Selected-but-rejected platform input commits a durable rejection receipt before
it is acknowledged. The source key and admitted-input fingerprint freeze its
original rejection across checkpoint failure, rebind, unbind, teardown and restart.
Replays return the original rejection before command/binding classification;
changed input conflicts. Prompt, Stop and rejection receipts are mutually exclusive.
Re-enabling a target or correcting a binding does not retry a rejected source;
a new platform message identity is required for a fresh admission attempt.
The binding service normalizes Topic lifecycle races to `binding_topic_invalid`
and disabled/missing targets to `external_target_unavailable`. Adapters recognize
the committed ingress-decision type, rather than enumerating internal Run/Bot
errors. Unknown errors, failed receipt writes and channel lifecycle abort remain
retryable/unknown and cannot acknowledge preparation.
Polling/webhook plugins use the exported `isConversationIngressRejection(error)`
predicate from `xacpx/plugin-api` to recognize an already durable rejection and
safely acknowledge it. Matching an error code alone is insufficient. Direct
bindings reject Group-shaped structured targets as `external_target_invalid`.
An inactive/archived bound Topic (`binding_topic_invalid`) is a completed ingress
rejection and can checkpoint, so it cannot poison later account traffic or be
retried as ordinary input after teardown removes the binding.
Prompt checkpointing does not wait for Run settlement; Stop additionally waits
for its cancellation writes. Neither barrier blocks polling for incoming Stop.
Ordinary Session prompts and commands wait until a cursor covering their poll
batch has been persisted, before quota hooks, typing/media work, active-turn
tracking or Agent execution. Conversation preparation/Stop remains concurrent
with this wait. Responses without a new cursor retain ordinary input until a
later checkpoint covers it. Channel abort and credential epoch checks fence
deferred dispatch, so replayed deferred events have not entered the ordinary
pipeline. This preserves
the existing ordinary save-before-dispatch semantics, not a durable Session inbox.
Unexpected preparation/checkpoint errors hold back durable advancement until
restart and also hold ordinary dispatch; restart replays from the last safe
checkpoint through platform receipts.
Selection captures the exact Conversation/Topic binding, its durable opaque revision and receipt existence;
acceptance first replays an existing receipt, otherwise requires the same binding
revision under a mutex keyed by external chatKey. Every bind writes a new revision,
including rebinding the same target; unbind/rebind and A→B→A cannot revive an old
selection. Legacy rows acquire revisions on schema upgrade. Replacement and removal both fail closed.
Bind/unbind/accept for one route serialize, while unrelated routes and ordinary unbound traffic remain
independent. Unused mutex entries are removed. If a selected binding disappears
before acceptance, the request fails closed instead of falling back to Session.
The adapter supplies explicit human origin, sender/account identity and a stable platform message id. Scheduled, peer,
model-generated and provenance-unknown input cannot create a bound human Run.
The metadata contract is `channel`, `channelMessageId`, `origin: "human"`,
`authenticatedHuman: true`, and `senderId`; `accountId` comes from ChatRequest.
Discord proves human origin with `author.bot === false`; Feishu requires the
platform's `sender_type === "user"`. Missing sender type does not qualify.
Bound Feishu ingress uses only an unexpired cached group-owner fact; a cache miss
supplies an adapter assertion of `isOwner: false` and prepares durable acceptance
immediately. The shared configured `ownerIds` policy can still make the final
durable owner flag true. A background
lookup after preparation may enrich later turns, never the accepted turn's authority.
Ordinary Session/control turns retain the awaited owner lookup. Weixin bound text
uses the stable English `[Quote: ...]` marker, including nested quotes, so locale
changes do not change its receipt fingerprint; ordinary Session text stays localized.
Bound canonical text places the current authored text before the quote context,
so leading member addresses are parsed from the user's input. The admitted prompt
keeps that quote context after member selection. Older quote-first receipts retain
their original fingerprint; a layout mismatch fails closed rather than creating
or retargeting work.
Receipts accepted by earlier builds keep their stored fingerprint. A historical
localized quote cannot be safely backfilled from the stored flattened text, so
such a receipt still rejects a locale-derived mismatch rather than relaxing
changed-input checks.
An existing platform prompt/Stop/rejection receipt determines the execution domain before
current command classification, including Weixin local commands. Replays retain
their original receipt kind; changed command-shaped input fails the same
fingerprint fence. Fresh known commands retain their command path except bound Stop.
`hadInboundMedia` records original platform attachment presence before download,
limits or skipped-resource degradation, including Weixin quoted image, file,
voice and video items using the same descriptor semantics as ordinary extraction.
Weixin follows the entire nested text-quote chain for each item. Media extraction
and canonical/localized text rendering share this traversal, which is iterative and detects repeated
objects to avoid recursive stack growth or cycles. Deep quotes are not silently
classified as media-free by a depth cutoff.
Text is assembled from the innermost quote outward before preparation, preserving
the existing authored-text order, titles, empty-quote and quoted-media rules.
Cycles render each reachable object once, with the repeated edge treated as absent.
Deep pure-text input can commit acceptance; deep media input can commit its
deterministic rejection and advance the covering checkpoint.
Bound media is rejected before downloading
until Conversation requests support attachments; it never falls back to a Session.

Adapters may supply a structured `conversationTarget`. Otherwise a leading
`@Name ` or `@{Name with spaces} ` selects an exact, unique current Group member.
Unknown/ambiguous names fail closed. With no selection the Group lead is used;
missing lead fails closed. Direct requests always target their owning Bot.
Name selection is revalidated for exact, unique current membership inside the
target Bot lifecycle gate after the final asynchronous wait. The check and
SQLite acceptance are synchronous, so sibling rename cannot commit between
name validation and Run persistence; a racing rename fails
`external_target_changed`. Structured Bot IDs keep their existing semantics.
External human ingress applies the shared `withEffectiveOwner` policy using the
original channel and configured `ownerIds` before freezing durable authority.
Feishu's conservative cache assertion is combined with that configured policy.
An empty attachment array means zero media; original raw media presence still
rejects a request even when normalized downloads are empty.

Platform-message receipts and Run acceptance commit in one SQLite transaction.
Retries replay the original Run even after rebinding; different sender/content/
target for the same source is rejected. Teardown retains a receipt tombstone so
old messages cannot create new work after rebinding. Receipts grant no permission
authority on replay or recovery. The channel returns the settled Run's public
Bot results through its existing delivery path. Stop cancels that exact Run.
Durable Conversation ownership is resolved before each adapter's Session Stop
fast path, including after restart when only Session tasks are present in memory.
Discord and Feishu track each task's execution domain; admitted Stop signals only
owned Conversation tasks, including acceptance still waiting on a lifecycle gate.
Weixin tracks bound turns with separate controllers. Concurrent Session tasks
remain unsuppressed and keep their abort signals, even after a foreground Session
switch. An unbound Stop with no durable Conversation targets retains the existing
Session stop behavior. Stop with raw attachments is rejected without cancellation.
Channel shutdown still aborts tasks in both domains.
Human Stop is explicit: adapters supply `ChatRequest.humanStopSignal` and abort
it only after admitting an owned user Stop. `abortSignal` covers all causes,
including lifecycle termination, and never independently grants human Stop
provenance. Adapters abort both signals for human Stop; `stop("disabled")`,
`stop("removed")`, logout and daemon shutdown abort only the lifecycle/request
signal. This detaches channel result waiting and fences unaccepted work, without
cancelling an already accepted durable Run. Its execution and recovery stay
owned by the Conversation runtime. Plugins must provide the separate human
signal to support bound Stop; a generic abort without it fails closed for intent.
Weixin combines a fresh per-start channel controller with the daemon signal;
channel stop/logout aborts that controller even while the daemon remains live.
The monitor checks it after network waits and before dispatching each message.
After restart, authenticated Stop is selected before Session command bypass.
Receipt `stop_ingress` holds only the original chatKey/account/sender facts and
is joined to live exact receipt Runs (queued, running or waiting-human), including work accepted before a rebind or
unbind. Owner resolution currently scans and validates all live external receipts
before filtering by route/account/sender. Its cost grows with the instance's live
external Runs, and corruption in an unrelated receipt can reject this Stop too.
An indexed owner-specific query that filters before full receipt validation is a
follow-up for both performance and corruption isolation.
Stop freezes that target set, revalidates its owner and cancels through
the existing Run service; it creates no new Run. It never restores permission
authority or execution human ingress cleared by recovery. Durable Stop does not
acquire the bind/accept route mutex: receipt ownership is immutable, and Run
cancellation uses its own durable state fences. A new acceptance waiting on a
Bot lifecycle gate cannot delay cancellation or acknowledgement for an existing
Run. Its independent human signal still prevents it from creating a new Run.
On schema upgrade,
legacy receipts copy surviving original dispatch facts before recovery; a live
legacy receipt whose Stop owner is already lost fails closed where bound, rather
than inferring ownership from the current binding or sender. Receipt tombstones
without a live Run cannot become Stop targets.
Bound Stop has its own durable platform receipt. The first admitted Stop
atomically records its source key, input fingerprint, original owner and frozen
target Run IDs, including an empty set, before any cancellation or adapter human
signal. In that same transaction it records `external_request_aborted` rejection
receipts for the owned platform sources whose acceptance is already pending,
including those waiting for the route mutex or a Bot lifecycle gate. These
source/fingerprint tombstones survive a crash before pending acceptance wakes
or writes its own rejection; restart cannot resurrect the stopped prompt.
Accepted sources remain Run targets, and other owners/accounts/routes are excluded.
Failure to persist any pending fence rolls back the entire Stop admission.
Replay uses the original receipts without capturing new pending sources and
cannot cancel later Runs. Prompt and
Stop receipts share source identity: changing the input or switching event kind
fails closed. Stop receipts survive unbind, rebind, restart and target teardown.
Only fresh Stop admission authorizes adapters to fence the owned pending tasks
captured at that Stop's selection, never tasks arriving later;
replayed Stop never fires controllers for later channel tasks. The preparation
result reports `stopPendingAcceptance` for this purpose. A failed cancellation
can retry only the original targets. Stop records have the same unlimited
retention contract as prompt receipts. Earlier releases stored no Stop source
identity, so historical Stop events cannot be backfilled.
Stop receipts created before pending-source fences cannot recover the lost
in-memory pending set; replay never guesses targets for those historical receipts.

Stop receipt corruption checks reject malformed JSON, invalid/duplicate target
IDs and mismatched owner facts. These checks do not prove the historical
membership of a syntactically valid target set after database corruption. If a
stored target ID is replaced with a later live Run owned by the same
route/account/sender, owner revalidation can still accept and cancel that Run.
Normal writers preserve the frozen set; stronger integrity checks for semantic
retargeting require additional immutable association evidence and remain a
follow-up. The replay guarantee above assumes the stored target set is intact.

Waiting for settlement holds no runtime operation lease. There is no durable
outbound-delivery claim: provider-result retransmission and channel delivery
exactly-once remain separate validation work.
Daemon-triggered channel abort does not acquire human Stop provenance: queued
work remains subject to the existing shutdown/recovery rules.

External receipts currently have unlimited retention, including after Topic or
Conversation teardown. Each accepted platform message retains its hashed source
key, fingerprint, original Run/Conversation/Topic identifiers and the minimal
Stop owner facts. Stop receipts additionally retain their frozen target ID set;
rejection receipts retain only source/fingerprint and the original rejection code/message.
No receipt kind retains a second copy of inbound text or attachments. This is a deliberate cost
of rejecting arbitrary old replays after unbind, rebind and teardown: receipt
storage grows with the lifetime count of accepted or rejected bound messages. There is no
automatic TTL, maximum-row eviction or user-facing purge in PR10. A follow-up
may compact retired receipts while preserving exact replay/conflict rejection,
or introduce a bounded retention policy only after establishing an enforceable
platform replay horizon (including manual retransmission). Such a policy must
define expiry behavior and migration; deleting receipts while accepting the
same old source again would weaken the current exactly-once contract.
