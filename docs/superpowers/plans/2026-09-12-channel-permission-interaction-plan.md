# Channel Permission Interaction Execution Plan

> Status: proposed execution plan
>
> Date: 2026-09-12
>
> Base verified against: `main@d7d38cca7dae904f5d5219937e55296f8f75e136`
>
> Scope: xacpx Runtime/acpx interactive permission escalation → daemon → exact originating turn → channel UI → user decision → acpx

## 0. Executive summary

Upstream `acpx` now exposes an embedding callback:

```ts
onPermissionRequest?: (
  req: AcpPermissionRequest,
  ctx: { signal: AbortSignal },
) => Promise<AcpPermissionDecision | undefined>;
```

with normalized outcomes:

```ts
"allow_once" | "allow_always" | "reject_once" | "reject_always" | "cancel"
```

xacpx already has most of the lower half of this path wired:

1. Runtime worker constructs an acpx Runtime with `onPermissionRequest`.
2. `RuntimePermissionResolver` decides `autoDeny → autoApprove → escalate → defaultAction → permissionMode`.
3. Only `needs_interaction` requests are forwarded to the host.
4. Worker → RuntimeEngine → bridge → daemon already carries `logicalSessionId`, `requestId`, `toolCallId`, `policyGeneration`, and `workerGeneration`.
5. RuntimeEngine already validates policy generation and live worker identity before accepting a host decision.
6. The daemon currently terminates the chain deliberately with `return { outcome: "reject_once" }` because no real channel/human UI is wired.

The implementation should therefore **not** redesign acpx permission policy or Runtime fencing. The missing feature is a xacpx-owned human interaction layer.

The target design is:

```text
ACP agent
  ↓ session/request_permission
acpx onPermissionRequest
  ↓
Runtime worker policy resolver
  ├─ auto allow/deny ────────────────► immediate decision
  └─ needs_interaction
        ↓
RuntimeEngine / bridge
        ↓ resolvePermissionRequest
PermissionInteractionBroker
        ↓ interactionId
exact originating turn route
        ↓ chatKey
MessageChannelRuntime.requestPermission()
        ↓
Discord / Feishu / Relay UI
        ↓ authenticated user decision
PermissionInteractionBroker
        ↓
bridge / RuntimeEngine / worker
        ↓
acpx decision
        ↓
agent continues
```

The central invariant is:

> A permission request belongs to the **exact prompt turn that caused it**, not merely to a logical session. Permission routing MUST never be inferred from “the latest chat using this session”.

That requires a new opaque `interactionId` generated at prompt dispatch and propagated through the Runtime permission request path.

---

## 1. Goals

### 1.1 Functional goals

1. Allow an interactive channel user to approve or reject an ACP permission request without leaving the channel.
2. Route each permission request back to the exact channel/chat/user context that started the active turn.
3. Preserve existing Runtime permission policy semantics and generation fencing.
4. Expose a narrow channel capability that supports Discord buttons first and can later support Feishu cards and Relay Web dialogs without changing Runtime semantics.
5. Abort/expire pending prompts safely on turn cancellation, timeout, worker recycle, policy transition, channel shutdown, or daemon shutdown.
6. Keep unattended turns non-interactive by default.

### 1.2 Security goals

1. Explicit human approval is the only path to an allow result once Runtime has classified a request as `needs_interaction`.
2. Missing routing state, stale generations, unsupported channel UI, channel failure, timeout, shutdown, or malformed decisions all fail closed to `reject_once`.
3. Only the authenticated initiator of the turn may approve/reject the request in the first implementation.
4. Pending permission state is ephemeral; daemon restart must not resurrect an old approval surface.
5. Channel plugins do not interpret or mutate xacpx permission policy.
6. Channel UI does not receive or render unbounded raw ACP payloads by default.

### 1.3 Product goals

1. Discord gets a first-class button UI, not a text-parser workaround.
2. Users see enough context to make a decision: title/kind + a bounded summary of the tool input.
3. Expired or already-resolved controls visibly become inert.
4. The design supports future Relay Web and Feishu surfaces without another core architecture change.

---

## 2. Non-goals

This work does **not**:

- replace `RuntimePermissionResolver`;
- change the precedence of `autoDeny`, `autoApprove`, `escalate`, `defaultAction`, or `permissionMode`;
- make channel plugins aware of `permissionMode` / `permissionPolicy`;
- add persistent approval queues;
- permit scheduled/orchestration/peer turns to block waiting for a human in v1;
- treat `allow_always` as a request to edit xacpx global policy;
- invent a new permission protocol separate from acpx/ACP;
- permit approval based only on possession of a button/custom-id token;
- route permissions by “current session”, “current chat”, or “last channel seen”.

---

## 3. Verified current state

### 3.1 Upstream acpx contract

`acpx` exports:

```ts
export type AcpPermissionRequest = {
  sessionId: string;
  raw: RequestPermissionRequest;
  inferredKind: ToolKind | undefined;
};

export type AcpPermissionDecision =
  | { outcome: "allow_once" }
  | { outcome: "allow_always" }
  | { outcome: "reject_once" }
  | { outcome: "reject_always" }
  | { outcome: "cancel" };
```

and Runtime/client options carry the optional `onPermissionRequest(req, { signal })` callback.

acpx maps the normalized outcome back onto the ACP request’s actual option list. xacpx therefore should expose normalized outcomes to channels, not ACP `optionId` internals.

### 3.2 xacpx Runtime worker

`src/bridge/engine/runtime/runtime-worker-main.ts` already:

- snapshots the current Runtime permission configuration/generation;
- evaluates every acpx permission request through `RuntimePermissionResolver`;
- immediately returns local allow/deny decisions;
- forwards only `needs_interaction` requests;
- tracks pending permission requests by `requestId`;
- aborts pending requests with the acpx callback’s `AbortSignal`;
- includes `policyGeneration` and `workerGeneration` in the host payload.

### 3.3 RuntimeEngine / bridge

`src/bridge/engine/runtime-engine.ts` already exposes a host-side `onPermissionRequest` seam. It validates that:

- the engine is not deleting/shutting down;
- `policyGeneration` is still current;
- the owning worker still exists and is alive.

`src/bridge/bridge-main.ts` then forwards the request to daemon RPC `resolvePermissionRequest`.

### 3.4 Daemon gap

`src/main.ts` currently handles `resolvePermissionRequest` by returning `reject_once` with a comment explaining that channel UI is not yet wired.

This is the exact implementation gap this plan closes.

### 3.5 Existing channel/plugin shape

`MessageChannelRuntime` has no permission UI capability today. `MessageChannelRegistry.getByChatKey(chatKey)` already provides the correct channel-runtime lookup primitive. `src/plugin-api.ts` is the only supported runtime API imported by channel plugins.

### 3.6 Existing turn context

The current chat stack already carries the route facts required to construct a human interaction route:

- `conversationId` / chatKey;
- `accountId`;
- `replyContextToken`;
- `senderId`, `senderName`, `isOwner`;
- dispatch-time `boundSessionAlias`.

These facts must be captured for the exact turn before transport execution begins.

---

## 4. Core invariants

The implementation must preserve these invariants. Treat violations as Blocking during review.

### I1 — exact-turn ownership

A permission request is bound to the precise prompt dispatch that caused it.

Never use:

```text
logicalSessionId -> latest chatKey
session alias    -> latest chatKey
transportSession -> latest chatKey
```

as permission routing state.

A logical session can be used by different chats/clients over time; queued turns can coexist with newer route state. Session-level “latest route” therefore permits cross-chat approval.

### I2 — opaque interaction identity

Every human-originated prompt gets a fresh, unguessable `interactionId` (UUID is sufficient). Only this opaque id is propagated into Runtime/worker permission payloads.

Runtime/worker layers must not know Discord channel ids, Feishu chat ids, sender ids, or reply tokens.

### I3 — initiator-only approval in v1

The channel must prove that the responder identity equals the sender identity captured for the originating turn.

If the platform cannot prove responder identity, it must not implement `requestPermission()` yet.

No owner/admin override in v1.

### I4 — first terminal decision wins

For one permission request, exactly one terminal outcome may be committed. Duplicate button clicks, repeated callbacks, late transport responses, and stale UI events must not change the first resolved outcome.

### I5 — stale UI cannot pierce fencing

A decision is accepted only while all relevant identities remain valid:

- pending broker request exists;
- turn interaction still exists;
- request not expired/aborted;
- Runtime `policyGeneration` is current;
- Runtime worker generation/ownership is current.

Existing Runtime fencing stays authoritative even if channel UI is stale.

### I6 — fail closed

The following all resolve to `reject_once` from xacpx’s perspective:

- missing interaction route;
- unsupported channel;
- missing initiator identity where authentication is required;
- channel exception/disconnect;
- malformed channel decision;
- timeout;
- aborted turn;
- daemon shutdown;
- channel shutdown;
- stale generation/worker;
- non-human origin in v1.

### I7 — permission policy remains core-owned

Channels render a decision request; they do not evaluate xacpx policy.

`allow_always` is an ACP/acpx decision outcome. It must not mutate xacpx `permissionPolicy` behind the user’s back.

### I8 — pending permission state is ephemeral

Do not persist pending requests or button tokens in `state.json`, acpx session records, or plugin files.

After daemon restart, old approval UI is invalid and cannot be restored into an actionable request.

### I9 — bounded presentation

Do not blindly `JSON.stringify(rawInput)` into a channel message. Core produces a bounded, presentation-oriented summary.

### I10 — unattended work does not become interactive accidentally

Scheduled, orchestration, peer-agent, and other non-human-origin turns reject `needs_interaction` in v1. Their correct automation mechanism is explicit permission policy, not an unexpected late-night approval prompt.

---

## 5. Target data model

### 5.1 Permission outcomes

Add a core-owned public type under the channel contract:

```ts
export type PermissionOutcome =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always"
  | "cancel";
```

### 5.2 Turn interaction route

Core-private:

```ts
export type PermissionInteractionOrigin =
  | "human"
  | "scheduled"
  | "peer"
  | "orchestration";

export interface TurnInteractionContext {
  interactionId: string;

  chatKey: string;
  accountId?: string;
  replyContextToken?: string;

  senderId?: string;
  senderName?: string;
  isOwner?: boolean;

  origin: PermissionInteractionOrigin;
}
```

This route is registered before prompt dispatch and removed in `finally` after the turn is terminal.

### 5.3 Channel permission request

Public plugin contract:

```ts
export interface ChannelPermissionRequest {
  requestId: string;
  chatKey: string;
  accountId?: string;
  replyContextToken?: string;

  requester: {
    senderId: string;
    senderName?: string;
    isOwner?: boolean;
  };

  toolCallId: string;
  title?: string;
  kind?: string;
  summary?: string;

  availableOutcomes: PermissionOutcome[];
  expiresAt: number;
  signal: AbortSignal;
}

export interface ChannelPermissionDecision {
  outcome: PermissionOutcome;
  /**
   * Platform user id that activated the approval control. REQUIRED: every
   * `requestPermission()` implementation must return an authenticated
   * responder; the broker re-verifies it against the bound initiator (I3).
   * `requestPermission()` is new in this change, so no legacy compatibility
   * concern applies — a platform that cannot prove responder identity must
   * not implement the capability at all.
   */
  responderId: string;
}
```

### 5.4 Channel runtime capability

Add an optional method:

```ts
export interface MessageChannelRuntime {
  // existing members...

  requestPermission?(
    request: ChannelPermissionRequest,
  ): Promise<ChannelPermissionDecision>;
}
```

The method is optional so already-published third-party plugins remain source/runtime compatible. Missing capability means interactive permission is unavailable for that channel and the request fails closed.

Export the new types via `xacpx/plugin-api`.

---

## 6. interactionId plumbing

### 6.1 Where the id is created

Create `interactionId` at the boundary where a concrete human chat turn is bound to a concrete session and is about to invoke transport.

Do **not** create it in Runtime worker or in the channel plugin. The core must own the route mapping.

Recommended ownership:

```text
channel ChatRequest
  ↓
ConsoleAgent / CommandRouter
  ↓
handlePromptWithSession
  ↓ create + bind interaction route
TransportInvoker.promptTransportSession
```

Only `origin === "human"` may mint/bind an `interactionId`. An ABSENT origin
fails closed (no approval UI) — never infer human for compatibility. Every
built-in chat channel sets `"human"` explicitly for user turns (Discord,
Feishu, Yuanbao, WeChat, dry-run) and `"scheduled"` for its scheduled
dispatch; legacy plugin markers (`scheduledSessionAlias`,
`preserveCoordinatorRoute`) remain only as a backstop for pre-existing
channels. Never guess from `senderId` strings.
### 6.2 PromptOptions

Extend `src/transport/types.ts`:

```ts
export interface PromptOptions {
  // existing fields...
  interactionId?: string;
}
```

Pass it through `TransportInvoker` into bridge transport.

### 6.3 Bridge protocol

Extend prompt request data from daemon → bridge with optional `interactionId`.

Then extend:

```ts
export interface EnginePromptInput extends EngineSessionInput {
  text: string;
  // existing fields...
  interactionId?: string;
}
```

and the corresponding Runtime worker prompt params.

The field is optional for compatibility with non-human/internal prompt call sites.

### 6.4 Worker active interaction

During one worker prompt:

```ts
state.activeInteractionId = params.interactionId;
try {
  return await runPrompt(...);
} finally {
  if (state.activeInteractionId === params.interactionId) {
    state.activeInteractionId = undefined;
  }
}
```

When worker `onPermissionRequest` produces a host payload, include:

```ts
interactionId?: string;
```

If Runtime decides interaction is required but no interaction id exists, reject locally with `reject_once`; do not generate a synthetic route.

This is what keeps scheduled/peer/internal turns fail closed by default.

---

## 7. PermissionInteractionBroker

Create a small core subsystem, e.g.:

```text
src/permissions/
  permission-types.ts
  permission-interaction-broker.ts
  permission-summary.ts
```

### 7.1 Responsibilities

The broker owns:

1. active turn route registration (`interactionId → TurnInteractionContext`);
2. pending permission lifecycle;
3. deadline/abort composition;
4. channel lookup by `chatKey`;
5. calling `channel.requestPermission()`;
6. validating returned outcomes against the ACP-supported outcomes;
7. first-terminal-decision-wins semantics;
8. fail-closed conversion to `reject_once`;
9. cleanup on turn/daemon/channel shutdown.

The broker does **not** evaluate permission policy and does **not** persist pending state.

### 7.2 Suggested API

```ts
export interface PermissionInteractionBroker {
  bindTurn(context: TurnInteractionContext, abortSignal?: AbortSignal): () => void;

  requestPermission(input: RuntimePermissionInteractionRequest):
    Promise<{ outcome: PermissionOutcome }>;

  shutdown(): void;
}
```

`bindTurn()` should refuse duplicate live `interactionId`s. The optional
owning-turn `AbortSignal` is subscribed directly: a `/cancel` or Stop aborts
every pending request for the interaction immediately, without waiting for a
slow `transport.cancel()` to settle the prompt. No extra worker→host cancel
event is needed — the worker already drops its pending entry and returns
`reject_once` on its own abort, so both ends fail closed independently off
the same turn abort.


The returned disposer must only remove the exact binding it created (identity-check the entry) so a stale disposer cannot delete a later binding in pathological tests.

### 7.3 Channel lookup

Use the existing `MessageChannelRegistry.getByChatKey(chatKey)` semantics. Avoid copying chatKey-prefix parsing into the broker.

Production wiring may inject a narrow resolver:

```ts
getChannelByChatKey(chatKey: string): MessageChannelRuntime | null
```

rather than making the broker depend on the full registry class. This keeps `buildApp` and tests easy to compose.

### 7.4 Timeout

The current bridge → daemon permission RPC uses an ~8 second timeout. That is acceptable for machine RPC but unusable for a person.

Introduce one business deadline, initially:

```ts
const PERMISSION_INTERACTION_TIMEOUT_MS = 120_000;
```

The broker owns this deadline. Every layer above it is only a transport
guard set slightly wider — never a second business timeout:

- `src/bridge/engine/runtime/runtime-worker-main.ts` host-permission watchdog: 125s;
- `src/bridge/engine/runtime/runtime-worker-client.ts` permission watchdog: 125s (seam `permissionTimeoutMs` for fast tests);
- `src/bridge/engine/runtime-engine.ts` permission watchdog: 125s (seam `permissionRequestTimeoutMs`, fanned into worker clients);
- `src/bridge/bridge-main.ts` daemon `resolvePermissionRequest` RPC: 125s.

The absolute business deadline travels as `expiresAt` on
`ChannelPermissionRequest`; a second independent timeout with different
semantics MUST NOT be introduced at any layer.

On timeout the broker aborts the channel request and returns `reject_once`.

### 7.5 Abort sources

A pending request must settle/abort on:

- active interaction unbind/turn completion;
- owning prompt abort/cancel — subscribed DIRECTLY via `bindTurn(ctx, signal)`, not via turn-finally, so a hung `transport.cancel()` cannot keep the UI alive;
- broker shutdown;
- channel stop/disconnect where surfaced;
- business timeout.

Runtime generation/worker invalidation remains enforced by the existing Runtime path; a late UI result still cannot become an allow result after Runtime identity changes.

---

## 8. Permission presentation normalization

### 8.1 Available outcomes

Worker/core should derive the normalized outcomes supported by the ACP request’s actual options and include them in the permission interaction request.

Channels should not inspect ACP `optionId` values.

If only `allow_once` and `reject_once` exist, only those actions are rendered.

### 8.2 Bounded summary

Add `summarizePermissionRequest()` in core. Prefer reusing the existing tool-input summarization primitives where possible.

Target shape:

```ts
{
  title: "Run shell command",
  kind: "execute",
  summary: "npm run test",
}
```

Recommended bounds:

- title: max ~200 characters;
- summary: max ~800 characters;
- no automatic raw JSON dump;
- no environment-variable expansion;
- no file-content expansion;
- no logging of raw secrets.

If summarization fails, show title/kind only rather than falling back to unrestricted serialization.

---

## 9. Daemon/Runtime integration

Replace the hard-coded daemon `reject_once` handler for `resolvePermissionRequest` with broker delegation.

Conceptually:

```ts
if (method === "resolvePermissionRequest") {
  return permissionInteractionBroker.requestPermission(params);
}
```

The RuntimeEngine callback remains the source of generation/worker fencing.

### 9.1 `permissionInteractionAvailable`

The Runtime already distinguishes “an RPC callback exists” from “a real human UI exists” using `permissionInteractionAvailable`.

After this feature lands, set this true only when production wiring can actually dispatch to at least one supported interactive channel path. A bridge callback by itself must not qualify.


The SAME authoritative value enters every gate — it is not a per-construction guess:

- `SessionService` (`permissionInteractionAvailable`) for new-session affinity;
- `RuntimeEngine` (bridge subprocess) for eligibility;
- the shared `assertEligibleForRuntimePermissionChange(..., { interactionAvailable })` used by daemon startup, the config watcher hot-apply, `/config set`, and `/pm`;
- `CommandRouterContext.permissionInteractionAvailable`, threaded from `buildApp` into the `/config` + `/pm` handlers.

Without this, persisted Runtime bindings stay stuck on "escalate without interactive" even after Discord approval ships.
Do not loosen Runtime eligibility merely because `onPermissionRequest` is non-null.

### 9.2 Mixed channel installations

If some configured channels support permissions and others do not, Runtime can remain interaction-capable globally because each request is still routed by its exact turn. A request originating from a non-supporting channel fails closed at broker dispatch.

If the current Runtime eligibility calculation requires a process-wide boolean, document this distinction clearly and ensure it means “human interaction infrastructure is installed”, not “every channel supports it”.

---

## 10. Discord implementation

Discord should be the first channel implementation because it already uses `discord.js` and already processes `interactionCreate` for slash commands.

### 10.1 Client seam

Extend `DiscordClientLike.start()` handlers to support button interactions, e.g.:

```ts
handlers: {
  onMessage(m: DiscordInboundMessage): void;
  onButton?(i: DiscordButtonInteraction): void;
}
```

Add a narrow normalized button interaction type instead of leaking discord.js objects into `channel.ts`.

It must provide at least:

```ts
interface DiscordButtonInteraction {
  customId: string;
  userId: string;
  channelId: string;
  guildId?: string;

  acknowledge(): Promise<void>;
  replyEphemeral(text: string): Promise<void>;
}
```

### 10.2 Outbound components

Extend the Discord-private outbound body with button/component support. Keep this type inside `packages/channel-discord`; do not add Discord concepts to core channel types.

### 10.3 Pending token design

Do not encode raw identities into Discord `customId`.

Use an unguessable per-request token:

```text
xacpx-perm:<random-token>:<action>
```

and keep:

```ts
Map<token, PendingDiscordPermission>
```

in memory.

The entry binds:

- core request id;
- exact expected requester user id;
- allowed actions;
- resolver/terminal state;
- expiry;
- message/channel ids needed to edit the UI.

### 10.4 Responder authentication

On button click:

```ts
if (interaction.userId !== pending.requesterId) {
  await interaction.replyEphemeral(
    "Only the user who started this request can approve it.",
  );
  return;
}
```

Do not permit “server owner”, “channel admin”, or “bot owner” as implicit override in v1.

The plugin check alone is not the security boundary: the resolved decision
MUST carry `responderId: interaction.userId` back to the broker, which
re-verifies `responderId === requester.senderId` before accepting any allow.
A forged or mismatched identity fails closed to `reject_once` even if the
plugin check is ever bypassed.

### 10.5 First decision wins

Resolve and remove/invalidate the pending entry atomically before doing best-effort cosmetic message edits.

The UI edit must never be required for the core decision to settle.

Duplicate clicks get an ephemeral “already resolved/expired” response and do not call the core resolver again.

### 10.6 UI state

Initial message should contain:

```text
Permission required

<tool title>
<bounded summary>
```

and render only supported actions, typically:

- Allow once
- Always allow
- Deny
- Always deny

After resolution, edit components away and append/render terminal state:

```text
Allowed once
Denied
Expired
Cancelled
```

All Discord messages continue to use `allowedMentions: { parse: [] }`.

### 10.7 Abort/stop cleanup

When core aborts `ChannelPermissionRequest.signal`, remove the pending token and best-effort edit the message to expired/cancelled.

`DiscordChannel.stop()` must invalidate every pending permission before destroying clients.

---

## 11. Feishu and Relay follow-ups

Do not block the core PR on these implementations.

### 11.1 Feishu

Implement `requestPermission()` as an interactive card action later. The same initiator-only rule applies; callback identity must match the captured sender Open ID.

### 11.2 Relay Web

Relay should eventually surface a structured permission request event/modal. It must carry the same core request id and authenticated relay user/session identity; the web client must not become the authority for permission policy.

---

## 12. File-by-file implementation plan

Exact names may adjust during implementation, but responsibilities should stay separated.

### PR A — core interaction plumbing

Core contracts:

- `src/channels/types.ts`
  - add `PermissionOutcome`;
  - add `ChannelPermissionRequest` / `ChannelPermissionDecision`;
  - add optional `MessageChannelRuntime.requestPermission()`.
- `src/plugin-api.ts`
  - export new public plugin contract types.

Broker:

- `src/permissions/permission-types.ts`
  - core-private turn/origin/runtime request types.
- `src/permissions/permission-interaction-broker.ts`
  - route registry, pending lifecycle, timeout, channel dispatch, validation, shutdown;
  - `bindTurn(ctx, abortSignal?)` direct turn-abort subscription (T3);
  - `responderId` re-verification against the bound initiator (I3).
- `src/permissions/permission-summary.ts`
  - bounded request presentation.

Turn plumbing:

- `src/weixin/agent/interface.ts`
  - REQUIRED explicit `origin: "human" | "scheduled" | "peer" | "orchestration"` provenance (Control producers set it; built-in chat channels set `"human"`/`"scheduled"`; absent fails closed).
- `src/control/control-service.ts`
  - `prompt` → `"human"`, `runScheduledTurn` → `"scheduled"`, peer/completion params → `"peer"`.
- `src/control/turn-queue.ts` (`SubmitParams`/`QueuedPrompt`/`pendingInterrupts`/drain/runTurn req)
- `src/control/session-turn-runner.ts` (`TurnRequest`) + `src/control/turn-support.ts` (`buildControlMetadata`)
  - carry `turnOrigin` end to end into `ChatRequestMetadata.origin`.
- `src/commands/router-types.ts` (`CommandRouterContext.permissionInteractionAvailable`)
- `src/commands/command-router.ts` (constructor + handler context threading)
- `src/bridge/engine/runtime/runtime-permission-policy.ts`
  - `assertEligibleForRuntimePermissionChange(..., { interactionAvailable })`; same value in daemon startup, watcher hot-apply, `/config set`, `/pm`.
- `src/commands/transport-invoker.ts`
  - accept/forward `interactionId`.
- `src/commands/handlers/session-handler.ts`
  - mint/bind ONLY on explicit `origin === "human"` (legacy scheduled/peer markers as backstop; absent fails closed); pass the owning turn `AbortSignal` into `bindTurn`.
- `packages/channel-discord/src/channel.ts`, `packages/channel-feishu/src/channel.ts`, `packages/channel-yuanbao/src/channel.ts`, `src/weixin/messaging/handle-weixin-message-turn.ts`, `src/weixin/messaging/scheduled-turn.ts`, `src/dry-run.ts`
  - explicit `"human"` for user turns / `"scheduled"` for scheduled dispatch (absent would fail closed).
- `src/transport/types.ts`
  - `PromptOptions.interactionId?: string`.

Bridge/runtime protocol:

- `src/transport/acpx-bridge/acpx-bridge-transport.ts`
  - forward `interactionId` in prompt RPC.
- `src/transport/acpx-bridge/acpx-bridge-protocol.ts`
  - extend relevant prompt/permission shapes.
- `src/bridge/engine/bridge-engine.ts`
  - `EnginePromptInput.interactionId?: string`.
- `src/bridge/engine/runtime/runtime-worker-protocol.ts`
  - add prompt interaction id + permission interaction id.
- `src/bridge/engine/runtime/runtime-worker-main.ts`
  - bind active interaction during prompt; include it in escalated permission payload; fail closed if absent.
  - host-permission watchdog 125s (was 9s — otherwise every human decision times out before the user reads the prompt).
- `src/bridge/engine/runtime-engine.ts`
  - carry `interactionId`, normalized available outcomes, existing generation fences unchanged;
  - permission watchdog 125s with `permissionRequestTimeoutMs` seam (fanned into worker clients).
- `src/bridge/bridge-main.ts`
  - daemon `resolvePermissionRequest` RPC watchdog 125s; `permissionInteractionAvailable: true` (per-request fail-closed covers unsupported channels).

Production wiring:

- `src/main.ts`
  - construct/inject broker;
  - replace hard-coded `reject_once` daemon handler;
  - ensure shutdown invalidates pending requests;
  - wire real interaction availability.
- channel bootstrap/registry composition files as needed
  - expose a narrow `getChannelByChatKey` resolver to the broker.

Tests:

- bridge protocol/transport tests for `interactionId` propagation;
- Runtime worker/engine tests for no-interaction-id fail-closed and stale generation behavior;
- integration test from fake channel → real Runtime permission callback → decision return.
- `tests/unit/permissions/permission-interaction-broker.test.ts` (T1–T4, T7–T15 + turn-abort-during-hang + responder mismatch/legacy);
- `tests/unit/bridge/engine/runtime/runtime-permission-policy.test.ts` (shared gate admits escalate with bindings only when interaction is available);
- `tests/unit/control/control-service-scheduled.test.ts` (`metadata.origin` scheduled/human end to end);
- `tests/unit/control/control-service-prompt.test.ts` (human origin in metadata);
- `tests/unit/control/turn-queue.test.ts` (`turnOrigin` drain preservation);
- `tests/unit/commands/handlers/session-handler.test.ts` (mint gate: only explicit human mints; absent fails closed);

### PR B — Discord permission UI

- `packages/channel-discord/src/types.ts`
  - button interaction and outbound component shapes.
- `packages/channel-discord/src/discord-client.ts`
  - normalize `isButton()` interactions;
  - send/edit components.
- `packages/channel-discord/src/channel.ts`
  - implement `requestPermission()`;
  - pending token lifecycle;
  - initiator check + `responderId` on every resolved decision;
  - only a real button click may RESOLVE; expiry/stop/abort REJECT (the broker fails closed on throw), so no fabricated identity ever flows;
  - stop/abort cleanup.
- `packages/channel-discord/src/i18n/*`
  - permission labels/messages.
- optional `packages/channel-discord/src/permission-ui.ts`
  - extract pending request state machine if `channel.ts` becomes too large.

Tests:

- initiator allow once;
- initiator deny;
- allow-always only if offered;
- unauthorized user click;
- duplicate click;
- abort before click;
- click after expiry;
- channel stop with pending request;
- button custom-id token cannot be forged into an unrelated request;
- UI edit failure does not change committed decision.
- decision carries `responderId` (broker re-verification contract);
- forged disallowed action cannot escalate (e.g. no `allow_always` button, forged `:always` click is inert);

### PR C — structured channel follow-ups

- Relay Web structured event/modal;
- Feishu interactive card;
- documentation for supported channels;
- optional policy/UX refinements after real use.

---

## 13. Required race/concurrency tests

These are the most important acceptance tests. Happy-path-only coverage is insufficient.

### T1 — basic allow

```text
human prompt
→ Runtime needs interaction
→ fake channel receives request
→ allow_once
→ acpx callback receives allow_once
→ prompt continues
```

### T2 — basic reject

Same path returning `reject_once`.

### T3 — cancel while pending

```text
permission pending
→ owning prompt `/cancel` / abort signal
→ broker aborts channel request
→ channel pending UI invalidated
→ effective outcome reject_once
```

### T4 — timeout

No user decision before deadline → exactly one `reject_once`; late click is inert.

### T5 — worker recycle

Permission pending → worker generation changes/recycles → stale allow cannot succeed.

### T6 — permission generation change

Permission pending → live permission config transition increments generation → stale allow cannot succeed.

### T7 — queued turn must not steal route

```text
Turn A from Discord chat A starts on logical session S
Turn A requests permission and waits
Turn B from chat B is queued for S / updates unrelated route state
User interaction for A MUST still target chat A and user A
```

This test is the proof that session-level latest-route mapping was not used.

### T8 — cross-channel reuse

```text
Discord turn uses S
Relay turn later uses S
permission created by the Discord turn
→ must route only to Discord origin
```

and vice versa.

### T9 — channel unsupported

Originating channel has no `requestPermission()` → no prompt leak/hang; return `reject_once`.

### T10 — non-human origin

Scheduled/peer/orchestration prompt needs interaction → channel UI is never invoked; return `reject_once`.

### T11 — duplicate decision

Two concurrent button callbacks race. Exactly one resolver wins; the second observes terminal state.

### T12 — channel failure

`requestPermission()` throws/rejects → `reject_once`; pending maps cleaned.

### T13 — daemon shutdown

Shutdown with pending request → abort all requests, no unresolved promises/timers.

### T14 — exact-route disposal

Old turn disposer executes after a later binding in an adversarial test → it cannot delete the newer binding.

### T15 — summary safety

Large/nested/raw tool input cannot produce unbounded channel output and does not fall back to a full raw JSON dump.

---

## 14. Observability

Add structured logs without raw tool payloads or secrets.

Suggested event codes:

```text
permission.interaction.requested
permission.interaction.dispatched
permission.interaction.resolved
permission.interaction.rejected_unavailable
permission.interaction.expired
permission.interaction.aborted
permission.interaction.channel_failed
permission.interaction.stale
```

Useful safe fields:

- `requestId`;
- `interactionId` (or shortened/hash form if preferred);
- channel id/type derived from chatKey;
- logical session id;
- tool kind;
- outcome;
- durationMs;
- reason code.

Do not log raw input, token/secret values, or full message content.

Discord plugin logs can use its existing `discord.<area>.<verb>` convention, e.g.:

```text
discord.permission.sent
discord.permission.resolved
discord.permission.unauthorized
discord.permission.expired
discord.permission.edit_failed
```

---

## 15. Compatibility and rollout

### 15.1 Plugin compatibility

`requestPermission()` is optional. Existing plugins continue to load. New public types are additive.

### 15.2 Transport compatibility

`interactionId` fields are optional at each internal prompt boundary. CLI/non-Runtime transports can ignore them.

### 15.3 Behavior before Discord PR lands

Core PR A may land first while no production channel implements `requestPermission()`. In that state, Runtime requests still fail closed exactly as today. This gives a safe incremental merge path.

### 15.4 Runtime eligibility

Do not switch `permissionInteractionAvailable` to true merely because PR A added the broker. It becomes true only when production actually has a human-capable channel dispatch surface wired.

### 15.5 Default timeout

Start at 120 seconds. Make it a core constant first rather than a public config knob. Add configuration only after real usage demonstrates a need.

---

## 16. Review checklist

Reviewers should explicitly answer these questions before approval:

1. Can any permission response be routed using mutable “current/latest chat” state?
2. Can a second turn on the same logical session steal the first turn’s approval route?
3. Can a user other than the exact initiator approve the request?
4. Can a stale Discord/Feishu/Web UI action survive worker/policy generation changes?
5. Can any unsupported/error path become allow instead of `reject_once`?
6. Can pending approval state survive daemon restart?
7. Can a channel mutate xacpx permission policy as a side effect of `allow_always`?
8. Can raw tool input or secrets be dumped into UI/logs?
9. Can duplicate responses resolve the same request twice?
10. Are scheduled/peer/orchestration turns guaranteed not to surprise a human with an approval prompt in v1?
11. Are all timers/listeners/pending promises cleaned on cancellation and shutdown?
12. Does the integration test exercise the real Runtime permission callback path rather than only mocking the broker directly?

Any “yes” to 1–9 (except where the question expects “yes” for cleanup/integration semantics) should block merge.

---

## 17. Acceptance criteria

The feature is complete for Discord v1 when all of the following are true:

1. A real Runtime/acpx `needs_interaction` request from a Discord-originated turn produces a Discord permission message with buttons.
2. The initiating Discord user can choose an ACP-supported decision and the agent continues accordingly.
3. Another Discord user cannot approve or reject it.
4. A queued or later turn on the same logical session cannot redirect the permission UI.
5. A stale/expired/aborted request cannot later become an allow.
6. Runtime policy and worker generation fences continue to reject stale decisions.
7. Unsupported channels and non-human turns remain fail-closed.
8. No pending permission state is persisted across daemon restart.
9. Core/plugin public API additions are additive and third-party plugins without `requestPermission()` continue to work.
10. Unit/integration tests cover T1–T15 above.
11. Existing Runtime permission-policy tests remain green.
12. Existing Discord channel tests remain green.
13. `npx tsc --noEmit`, package builds, and repository test suites pass.

---

## 18. Recommended implementation order

Execute in this order rather than starting in Discord:

1. Add permission public/core types and broker tests.
2. Add `interactionId` route binding around exact human prompt dispatch.
3. Propagate `interactionId` through transport → bridge → Runtime worker.
4. Add worker/runtime fail-closed behavior when interaction is required without an id.
5. Replace daemon hard-coded `reject_once` with broker dispatch.
6. Prove race tests T3–T14 with a fake channel.
7. Land PR A.
8. Add Discord button client seam and outbound components.
9. Implement Discord `requestPermission()` state machine + initiator auth.
10. Add Discord race/UI tests and a real Runtime-to-fake/Discord-adapter integration test.
11. Land PR B.
12. Add Relay Web / Feishu surfaces separately after observing Discord behavior.

This ordering keeps the security-critical routing/lifecycle logic core-owned and testable independently from any platform UI.