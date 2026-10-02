# ACP Elicitation M3 — Relay Web Readiness Assessment

```text
Date: 2026-09-23
Trigger: PR #350 merged to main (mergeCommit f9090253, mergedAt 2026-09-22T16:23:56Z)
Question: can M3 start now?
Verdict: READY_WITH_CAVEATS — start on the core routing seam, not the UI
```

## What #350 actually delivered

48 files, +17,744/-160 across `packages/relay-protocol`, `packages/relay`,
`packages/relay-web`, `packages/channel-relay`, `src/conversations`, `src/control`.

All eleven contracts M3 plan §2 requires are **landed, mostly under their original
names** (`origin/main` @ `f9090253`):

| Plan contract | Landed as | Location |
|---|---|---|
| `HumanIngressContext` | same | `src/conversations/conversation-types.ts:112-120` |
| trusted ingress path | `trustedConversationPrompt` option + `promptConversationFromHumanIngress` | `packages/channel-relay/src/control-bridge.ts:101-108,1038-1053` |
| `authorityEpoch` | same (see caveat C3) | `src/conversations/conversation-dispatcher.ts:37-38` |
| `ConversationRun` | same | `src/conversations/conversation-types.ts:73-90` |
| `MemberTurnRecord` | same | `src/conversations/conversation-types.ts:92-108` |
| `ConversationTurnCorrelation` | same / `…Dto` on the wire | `src/control/conversation-control-dtos.ts:10-18` |
| `runId` / `memberTurnId` / `promptRequestId` | same | `packages/relay-protocol/src/dtos.ts:262-263,332` |
| `waiting-human` | same literal | `packages/relay-protocol/src/dtos.ts:338` |
| reconnect reconciliation | `reconcileOnReconnect()` | `packages/relay-web/src/stores/direct-bots.ts:2150-2231` |
| hidden Bot identity separation | `ownedDirectSessionAlias()` / `isHiddenProductSessionOwner()` / `bot-direct` | `src/domain/ids.ts:96-107` |

So the plan's "do not invent provisional replacements" gate is **satisfied**: M3
can build on real, landed contracts rather than scaffolding.

## The five things that change the plan's shape

Independently verified by reading `origin/main` directly, not taken on trust.

### B1 — The renderer does not exist anywhere on the relay side

`git grep requestElicitation|elicitationModes|Elicitation` over
`packages/channel-relay/src`, `packages/relay/src`, `packages/relay-web/src`
returns **zero matches**. M1's plugin API exists only in core
(`src/interactions/elicitation-types.ts:196-263`). Discord and Feishu implement it;
Relay does not.

**Consequence:** M3's workload is a from-scratch renderer, not an integration.
The plan's "reuse landed contracts" framing understates this.

### B2 — Direct Bot turns currently CANNOT receive any interaction

This is the hard blocker, verified in three places:

1. `src/permissions/permission-turn-route.ts:23-25` — `resolvePermissionTurnRoute`
   returns `undefined` for any direct-conversation (`bot:`) chatKey.
2. `src/commands/handlers/session-handler.ts:1065-1067` — no route means no
   `interactionId` is minted.
3. `src/interactions/elicitation-interaction-broker.ts:199-204` — the broker
   cancels when no route exists.

Additionally `src/channels/channel-scope.ts:15-18` maps an unknown chatKey prefix
to `'weixin'`, so even with a route the `bot:` key resolves to the **wrong
channel**.

**Consequence:** no relay-side renderer can ever be invoked until this is fixed.
This is step 1, and it is core-side work, not web work.

### B3 — `authorityEpoch` is identity comparison, not durable fencing

`conversation-dispatcher.ts:48-49` — `randomUUID()` per dispatcher, at
composition time. `sqlite-conversation-store.ts:562-565` compares it for equality.
`sqlite-conversation-store.ts:994-996` — member origin becomes `'human'` only when
**both** `humanIngress` and `authorityEpoch` are present. There is no counter,
no ordering, no generation arithmetic. The store's own comment (`:46-47`) says it
is "compared to the dispatch row, never to generation" — the monotonic thing is
`PendingDispatch.generation` / `ConversationRun.generation`, a separate field.

It matters because an elicitation is exactly the long-lived case:
`ELICITATION_INTERACTION_TIMEOUT_MS = 120_000` (`elicitation-interaction-broker.ts:50`),
transport watchdog 125s. Three concrete degradation surfaces:

- **Core daemon restart mid-turn** → new UUID, old row's epoch no longer matches
  → every in-flight human dispatch degrades to `orchestration` → broker cancels
  (`route.origin !== 'human'`).
- **Lease expiry / recovered claim** → `humanIngress` is explicitly *"Discarded on
  recovery"* (`conversation-types.ts:131-133`).
- Both are plausible inside a 2-minute human interaction window.

**Consequence for M3:** the relay renderer must NOT assume that a
`waiting-human` Run, or a pending elicitation, implies the route is still
bindable. The fail-closed path is by design, so the correct behaviour on a lost
route is **cancel**, and the web UI should render that as a cancellation rather
than an error. If the plan instead assumes durable fencing that survives restart
and re-binds through the hub, that one assumption is contradicted by the landed
semantics.

### B4 — `waiting-human` is read but never written

Every occurrence on `origin/main` is a read/compare: the literal
(`conversation-types.ts:15,338`), `ACTIVE_RUN_STATES` (`:153`), the store's
active-run query (`sqlite-conversation-store.ts:549`), and #350's rendering
(`ConversationMessageList.vue:262,277`). **Nothing transitions a Run into it.**

Run state is store-mediated (`ConversationStore.completeExecution` /
`failExecution` via the dispatcher), so a plugin cannot set it directly.

**Consequence:** M3 must implement the transition, and must first decide who owns
it. This is a product decision, not an implementation detail.

### B5 — There is no relay permission round-trip and therefore no web permission UI to copy

`git grep requestPermission` over `packages/relay*/packages/channel-relay/src`
returns only browser `Notification.requestPermission` in web-push tests. #350
explicitly deferred "Relay permission interaction (protocol + Hub request/downlink
+ `RelayChannel.requestPermission()` + Web approval UI/response flow)".

**Consequence:** do not plan around an existing web permission UI as a template.
The closest precedents are the non-interactive forms (`BotDialog.vue`,
`NewTopicDialog.vue`) and the Direct Bot run-lifecycle banner
(`ConversationMessageList.vue:262-289`, which already switches on
`activeRun.state` including `'waiting-human'`).

## Protocol surface: closed and exhaustiveness-guarded

`control-bridge.ts:246-1094` is a `switch (envelope.type)` with **72 arms** and a
fail-closed `default:` returning `unknown-type` (`:1091-1094`). The
`relay-protocol` message-kind union is closed. A new request/event type touches at
least five files:

- `messages.ts` (MSG key + payload/result types)
- `dtos.ts` (`ControlEventDto` union)
- `payload-validators.ts` (validator + registry + the `Expect<Equal>` payload bound)
- `web-dtos.ts` (`WebServerEvent` + an exhaustiveness-guarded switch — a
  **compile-time guard**, so a missed member fails the build)
- the connector dispatch switch

A missed `payload-validators.ts` entry is the dangerous one: the hub silently
drops the frame instead of erroring.

## Decisions needed from you before step 2 is finalized

1. **Who owns the `waiting-human` transition?** Nothing on main sets it, and run
   state is store-mediated so a plugin cannot set it directly. Options: the
   dispatcher transitions on elicitation dispatch; or the elicitation broker
   calls a run-service method. This is a product call.
2. **What is the relay responder identity?** The broker rejects a route with no
   `senderId` (`broker:215-217`). The only landed candidate is the hub account id
   — `packages/relay/src/http/app.ts:601-615` stamps `chatKey relay:<account.id>`
   and `senderId account.id`, `isOwner: true`. Whether that is accepted as the
   responder identity is unlanded.
3. **Product identity for the elicitation row.** Web keys everything by
   `conversationId`/`topicId`/`runId`/`memberTurnId`, but
   `ChannelElicitationRequest` carries none of them — only an ephemeral
   `requestId` the broker documents as "never persisted"
   (`elicitation-interaction-broker.ts:60`). M3 must decide how the decision
   correlates back to the exact run/memberTurn.
4. **The ~120s open RPC.** `control-bridge.ts:60` defaults `CONTROL_RPC_TIMEOUT_MS`
   to 60s with a `CONNECTOR_TIMEOUT_EXEMPT_TYPES` list (`:118-128`), and the hub's
   own default request timeout is 120s. A 120-second human interaction holding an
   RPC open needs either a timeout exemption or a two-frame request/decision pair.

## Recommended order

Start on the **core routing seam**, not the UI — B2 means nothing else is
reachable until it is fixed:

1. **Route resolver.** Map `bot:<conversationId>:<topicId>` plus the persisted
   `HumanIngressContext` onto the relay account/channel with a real `senderId`.
   Mirror `resolvePermissionTurnRoute`'s structure without changing its
   permission semantics (B2). Fix the `channel-scope.ts` prefix resolution for
   `bot:` keys while here.
2. **Protocol surface, in ONE coherent change.** All five files from the list
   above, plus the validator registry entry — because a missed entry drops frames
   silently. Requires decisions 1 and 2 above.
3. **`channel-relay` renderer.** `requestElicitation` + `elicitationModes:
   ["form"]`. Once both exist the registry probe
   (`channel-registry.ts:135-139`) and the daemon gate (`main.ts:617-629`) pick
   the capability up automatically. Wire `request.signal`, and decide the RPC
   timeout question (decision 4).
4. **Web store.** Extend `applyEvent()` (`direct-bots.ts:2423`) with the new
   `ControlEventDto` type keyed by run/memberTurn; submit via `api.rpc` with
   `unwrapRpc` mapping `unknown-type` → `connectorOutdated` so old connectors
   degrade instead of hanging (`direct-bots.ts:66-71`).
5. **Form component** in the existing active-run banner region
   (`ConversationMessageList.vue:262-289`).

## Verdict

`READY_WITH_CAVEATS`. The dependency is genuinely unblocked and the contracts are
real. But M3 is larger than "integrate with the Conversation product layer": it is
a from-scratch renderer (B1) behind a blocked routing seam (B2), with two product
decisions (1, 2) that gate the protocol work, one semantic correction to the plan's
assumption about `authorityEpoch` (B3), and one transition nothing has implemented
yet (B4).
