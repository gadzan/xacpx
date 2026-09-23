# ACP Elicitation M3 — Unified Relay Interaction Protocol (design)

> **Status:** design locked; implement in stages
>
> **Date:** 2026-09-23
>
> **Inputs:** `2026-09-20-acp-elicitation-relay-conversation-plan.md` (§5-§7),
> `2026-09-23-acp-elicitation-m3-readiness.md`, PR #350's Scope Boundary
> ("Deferred to dedicated follow-up PR: Relay Web permission interaction").

## 1. Why one envelope instead of two

PR #350 explicitly deferred the relay *permission* interaction to a follow-up PR,
naming the same four pieces M3 needs: protocol + Hub downlink + channel renderer +
Web response flow. Adding an elicitation-only mechanism now would leave the
permission follow-up to either redo the transport or grow a second parallel one.

So this is a **single interaction transport carrying two decision kinds**. Each
kind keeps its own payload and decision semantics; nothing is merged at the
business level. This mirrors core, where `TurnInteractionRegistry` is shared but
`PermissionInteractionBroker` and `ElicitationInteractionBroker` are not.

```text
             TurnInteractionRegistry (exact-turn ownership, M1)
                          |
      +-------------------+-------------------+
      |                                       |
PermissionInteractionBroker        ElicitationInteractionBroker
      |                                       |
  permission outcomes                  accept/decline/cancel
```

The relay protocol mirror:

```text
        control.interaction.request  (hub -> connector -> web/user)
        control.interaction.respond  (web -> hub -> connector -> core)
                          |
             kind: "permission" | "elicitation"
```

## 2. Message pair

Naming follows the landed `control.<verb>` convention.

```
control.interaction.request    hub -> connector : open an interaction
control.interaction.respond    connector -> hub : deliver the decision
```

`control.interaction.request` is a **long-lived RPC** (the answer is its result),
unlike every other `control.*` which is a quick query. This is the one place the
existing 60s `CONTROL_RPC_TIMEOUT_MS` default must be overridden for this type —
see §6.

The request is *not* broadcast to browsers directly. The hub relays it as a
`ControlEventDto` variant (which the web store already consumes) and the browser's
answer comes back over the same RPC that opened it. One round trip, one
correlation id, no separate downlink queue.

## 3. Payload

### Request (hub → connector → core channel)

```ts
interface InteractionRequestPayload {
  /** xacpx broker correlation id. Ephemeral, never persisted by core. */
  requestId: string;
  /** Which decision model this is. */
  kind: "permission" | "elicitation";
  /**
   * Product identity for the web UI. Optional because permission turns on an
   * ordinary channel have no Conversation product row; Direct Bot turns do.
   */
  conversation?: {
    conversationId: string;
    topicId: string;
    runId: string;
    memberTurnId: string;
    promptRequestId?: string;
  };
  /** Epoch-seconds ms at which the interaction is no longer answerable. */
  expiresAt: number;
  /** Present iff kind === "elicitation". */
  elicitation?: {
    mode: "form";
    message: string;
    fields: InteractionFieldDto[];
    schemaTitle?: string;
  };
  /** Present iff kind === "permission". Not implemented in M3 — reserved. */
  permission?: {
    title?: string;
    kind?: string;
    summary?: string;
    availableOutcomes: string[];
  };
}
```

Field notes:

- **No ACP SDK types cross the wire.** `InteractionFieldDto` is a normalized,
  already-core-validated field (the same `ChannelElicitationField` the Discord and
  Feishu renderers receive), so the web cannot be handed a raw schema.
- **No hidden `brt_*` aliases anywhere.** Product routing is
  `conversationId/topicId/runId/memberTurnId`, per #350's identity rules.
- **`responderId` is never in the request.** The browser may not assert who is
  answering (§4).

### Response (connector → hub → core)

```ts
interface InteractionResponsePayload {
  requestId: string;
  kind: "permission" | "elicitation";
  action: string;               // per kind; see below
  content?: Record<string, InteractionValue> | null;   // elicitation accept only
}
```

| kind | actions |
|---|---|
| `elicitation` | `accept` (with optional `content`) / `decline` / `cancel` |
| `permission` | `allow_once` / `allow_always` / `reject_once` / `reject_always` / `cancel` |

The **authoritative responder identity is stamped by the hub** from the
authenticated session before the response is forwarded to the connector — the
browser's payload contains no identity field at all, so there is nothing to
forge. This is the relay equivalent of core's "never trust self-reported payload
ids" rule (M1 roadmap §5.7).

## 4. Identity model

| Question | Answer | Basis |
|---|---|---|
| Who is allowed to answer? | The human whose trusted `HumanIngressContext` minted the turn | `HumanIngressContext` is server-derived; `conversation-execution.ts` accepts `bot:` chatKeys and `authorityEpoch` + ingress → origin `human` |
| What identity reaches core? | The **hub account id**, stamped at the hub, not the browser | `packages/relay/src/http/app.ts:601-615` already stamps `chatKey relay:<account.id>` / `senderId account.id` / `isOwner: true` for the trusted conversation prompt path |
| Who re-verifies? | core's brokers re-check the responder against the exact turn initiator | M1 broker contract; `channel-registry` capability gate |
| Browser payload trusted for? | the answer's *content* only | no identity field exists in it |

## 5. The B2 routing fix (blocking)

Direct Bot turns cannot receive any interaction today, because
`resolvePermissionTurnRoute` returns `undefined` for a `bot:` chatKey and
`getChannelIdFromChatKey` then mis-resolves the prefix to `weixin`.

Fix, without changing permission semantics:

1. **`src/permissions/permission-turn-route.ts`** — extract the shared part into
   `resolveTurnInteractionRoute()` and have `resolvePermissionTurnRoute()` keep
   its current `bot:` refusal by calling it with a flag. The refusal is
   permission-specific policy, not a routing impossibility.
2. **A new `resolveElicitationTurnRoute()`** (sibling, in
   `src/interactions/`) that *accepts* a `bot:` key and resolves it onto the
   owning relay account by consulting the persisted `HumanIngressContext` on the
   dispatch row.
3. **`src/channels/channel-scope.ts`** — teach `getChannelIdFromChatKey` about the
   `bot:` prefix so it no longer falls through to `weixin`.

The bot key's shape is `bot:<conversationId>:<topicId>`
(`src/domain/ids.ts:96-107`, `conversation-turn-runner.ts:130,164`).

## 6. Timeout

`ELICITATION_INTERACTION_TIMEOUT_MS = 120_000` (core broker) with a 125s transport
watchdog. `CONTROL_RPC_TIMEOUT_MS` defaults to 60s with a
`CONNECTOR_TIMEOUT_EXEMPT_TYPES` escape list (`control-bridge.ts:118-128`).

`control.interaction.request` goes on the exempt list. Rationale: splitting into
two frames (open, then a separate decision downlink) would require a hub-side
pending map with its own expiry, reconnect reconciliation, and a second failure
mode — more machinery than the timeout it saves. The hub's own default request
timeout is already 120s, so one exemption aligns the whole chain.

## 7. Capability

Add `interactionElicitationFormV1` to `RELAY_CAPABILITIES`
(`relay-protocol/src/messages.ts:928`). A hub or web without it cannot ask, so
old clients simply never open an interaction rather than hanging on a message
type they do not understand. This is the plan's §5 requirement.

The permission kind is **reserved, not implemented**: the wire shape carries the
discriminant so the later follow-up adds a payload without touching the
transport, but `channel-relay` does not implement `requestPermission` in M3 and
the broker keeps fail-closed `reject_once` for relay permission turns.

## 8. What this deliberately does not do

- **No `waiting-human` transition.** Nothing on `main` sets it, and run state is
  store-mediated. Deferred to decision 1 in the readiness assessment; M3 ships
  with the run in `running` and the interaction rendered alongside it.
- **No durable interaction store.** Core's correlation is already documented as
  ephemeral ("never persisted"); a hub restart drops in-flight interactions and
  the abort path cancels them. Making them survive restart means carrying
  `HumanIngressContext` through the hub, which is a larger product change.
- **No authorityEpoch rewrite.** M3 works within the landed identity-comparison
  semantics and treats a lost route as a cancel (see readiness B3).

## 9. Landing order

1. `relay-protocol`: messages, DTOs, validators, `web-dtos` exhaustiveness,
   capability constant. Compile-time guarded, so a missed member fails the build.
2. Core routing: `resolveElicitationTurnRoute` + `channel-scope` `bot:` prefix (§5).
3. `channel-relay`: `requestElicitation` + `elicitationModes`, driven through the
   unified transport with `request.signal` wired.
4. Hub: forward the request as a `ControlEventDto`, stamp the responder on the
   way back.
5. Web store: pending-interaction state keyed by run/memberTurn + reconciler.
6. Web component: form renderer in the existing active-run banner region.

Steps 1-2 are prerequisites for everything else and carry no product decisions
beyond §8.
