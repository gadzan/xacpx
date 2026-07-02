# Non-blocking send + server-authoritative message queue (relay-web)

**Date:** 2026-07-01
**Status:** Approved (brainstorm) — ready for implementation plan
**Scope:** core (`src/control`) + `packages/relay-protocol` + `packages/channel-relay`
+ `packages/relay-web`. **Requires a core release** (relay stack: protocol → core →
connector → hub). This is the second, larger of two features brainstormed together;
the first (away-turn desktop notification) is a separate relay-web-only spec.

## Goal

While an agent turn is running, let the user keep sending prompts from relay-web
instead of being blocked. Extra prompts **queue server-side** and run in order as
the agent frees up. The web UI shows the queue (each item: text preview + a
per-item cancel ✕) and animates a queued item into the live turn when it starts.

Removes the redundant "Stop" affordance: the send button stays **Send** at all
times; cancelling the running turn lives only in the Turn HUD.

## Reality correction (why this is "build", not "expose")

Initial framing assumed the relay path already queued prompts (via the bridge's
`pendingNormals`) and we'd just surface the count. **That is false for the relay
path.** Verified in `src/control/control-service.ts:438-452`: `executeTurn`
tracks `inFlight: Map<turnKey, {controller, settled}>`, and a second prompt while
a live, un-aborted turn exists is **rejected**:

```ts
// control-service.ts:439-442
if (!existing.controller.signal.aborted) {
  return { ok: false, errorMessage: "turn-already-running" };
}
```

The implicit Promise-chain queues found elsewhere are on **other** paths:
`src/runtime/conversation-executor.ts` (`normalTails`) serializes the **WeChat/
text channel** path, and `src/bridge/bridge-request-scheduler.ts` serializes
**transport ops inside the bridge subprocess** — neither holds relay-web prompts
as cancelable user messages. So Feature 2 must **build** a real queue at the
control layer: turn `reject` into `enqueue`, and drain on turn completion.

## Decisions

- **Queue lives in `ControlService`, keyed by `turnKey(chatKey, sessionAlias)`.**
  This is the relay/control path only. WeChat's separate `conversation-executor`
  queue is untouched (unifying them is out of scope — different mechanism, and
  relay-web vs WeChat address a session under different chatKeys anyway).
- **`prompt()` enqueues; scheduled turns do not.** Only interactive
  `ControlService.prompt` (the relay-web send path) enqueues on collision.
  `runScheduledTurn` keeps its current immediate-or-reject behavior, so a
  time-sensitive scheduled dispatch isn't silently delayed behind a long manual
  turn. (Deliberate scope boundary.)
- **Cancel (Stop / HUD) cancels only the running turn; the queue persists** and
  drains next. Per-item ✕ is the way to drop a queued message. No global
  "clear queue / stop everything" button (YAGNI; the visible per-item list makes
  bulk removal unnecessary). *Confirmed with the user: Stop is turn-only; the
  queue survives a Stop.*
- **Server-authoritative, replace-latest snapshots.** Every queue change emits a
  `queue-updated` `ControlEvent` carrying the full ordered item list for that
  session (like `plan`). The web renders from the snapshot; it does not maintain
  its own authoritative queue.
- **Text preview only.** Each queue item ships `{ id, textPreview, enqueuedAt }`
  with `textPreview` truncated server-side (~120 chars). The full prompt text
  stays server-side until the item runs; no need to re-ship large prompts in
  every snapshot.
- **Additive, backward-compatible protocol.** A new event type + a new RPC.
  Old web clients ignore the unknown event (the `applyEvent` if/else chain falls
  through). Protocol stays `0.1.x` (`^0.1.0` range compat).

## Architecture (by layer)

### Core — `src/control/control-service.ts`

New per-session queue state alongside `inFlight`:

```ts
type QueuedPrompt = {
  id: string;
  text: string;              // full text, run verbatim when dequeued
  enqueuedAt: string;        // ISO
  senderId: string;
  isOwner?: boolean;
  accountId?: string;
  media?: PromptAttachmentRef[];
};
private readonly queues = new Map<string, QueuedPrompt[]>();
```

1. **Enqueue path** — in `executeTurn`, the `existing && !aborted` branch changes
   from reject to: mint an `id`, push a `QueuedPrompt` onto `queues[key]`, emit
   `queue-updated`, and return `{ ok: true, queued: true, queueItemId: id }`.
   - Only for the interactive `prompt()` entry. Add an internal
     `queueable: boolean` param to `executeTurn`; `prompt()` passes `true`,
     `runScheduledTurn` passes `false` (keeps the existing reject).
   - The `existing && aborted` (Stop unwinding) branch keeps its current
     bounded `raceWithTimeout(existing.settled, …)` then start-fresh behavior —
     unchanged, to preserve the CANCEL_DRAIN semantics.

2. **Drain path** — the turn's `finally` (currently `inFlight.delete(key)` at
   line 635) becomes: if `queues[key]` has a head, **atomically** pop it and
   start it as the next turn *without releasing the busy slot* (so a concurrently
   arriving prompt still sees "busy" and enqueues rather than racing a second
   concurrent turn). Implement as a loop/continuation that reuses `executeTurn`
   for the head item, stamping `turnStarted.prompt = item.text` and a new
   `turnStarted.queueItemId = item.id` so the web can correlate. Emit
   `queue-updated` when the item leaves the queue. Only when the queue is empty
   is `inFlight` cleared.
   - **Invariant:** between finishing turn N and starting queued turn N+1, `key`
     is continuously present in `inFlight` — there is no window where an incoming
     prompt starts a parallel turn.

3. **Per-item cancel** — new `cancelQueuedItem(chatKey, sessionAlias, itemId):
   { cancelled: boolean }`: splice the item out of `queues[key]`, emit
   `queue-updated`, return `cancelled: false` if it was already drained/absent.

4. **Preserve** `src/runtime/turn-lane.ts` control-lane preemption and existing
   `cancelTurn`. The queue is orthogonal to the control lane (`/use`, `/cancel`,
   `/stop` still run immediately and never enqueue).

### Core — `src/control/control-event-bus.ts`

Add to the `ControlEvent` union:

```ts
| { type: "queue-updated"; chatKey: string; sessionAlias: string;
    items: { id: string; textPreview: string; enqueuedAt: string }[] }
```

And stamp `queueItemId?: string` onto the existing `turn-started` variant (set
only for drained-from-queue turns).

### Protocol — `packages/relay-protocol/src`

- **`dtos.ts`** — mirror both changes in `ControlEventDto`: add the
  `queue-updated` variant and `queueItemId?: string` on `turn-started`.
- **`messages.ts`** — add `MSG.queueCancel: "control.queue.cancel"`, plus
  `QueueCancelPayload { chatKey; sessionAlias; itemId }` and
  `QueueCancelResult { cancelled: boolean }` (mirror `PromptCancel*`). Extend
  `PromptResult` with optional `queued?: boolean; queueItemId?: string`.

### Connector — `packages/channel-relay/src/control-bridge.ts`

- Add `case MSG.queueCancel:` → `control.cancelQueuedItem(input.chatKey,
  input.sessionAlias, input.itemId)` (mirrors the `MSG.promptCancel` case at
  line 152).
- **Events need no new wiring**: `subscribeControlEvents` forwards every
  `ControlEvent` generically as `MSG.instanceEvent` (line 281), so `queue-updated`
  flows through automatically once it's in both unions.

### Web — `packages/relay-web/src`

- **`components/PromptInput.vue`** — remove the `props.busy` early-return in
  `submit()`; the send button is always **Send** (delete the Stop variant at
  ~lines 289-295). (Keep Escape-to-cancel as a keyboard convenience; it targets
  the running turn, not the send button.)
- **`stores/chat.ts`**
  - State: `queues: reactive Record<sessionKey, QueuedItemDto[]>`.
  - `applyEvent`: add `else if (e.type === "queue-updated") queues[key] = e.items`
    (authoritative wholesale replace).
  - `prompt()`: allow sending while `busy`. On send, optimistically append a
    provisional chip; the authoritative `queue-updated` snapshot then replaces the
    list. (`turn-started` carrying `queueItemId` reconciles the drained item.)
  - `cancelQueuedItem(instanceId, alias, itemId)` → `api.rpc(instanceId,
    "control.queue.cancel", { alias, itemId })`; optimistically remove the chip.
- **Queue strip UI** — a component (e.g. `QueueStrip.vue`) rendered in the
  composer area (above `PromptInput`, below the Turn HUD) listing
  `queues[selectedKey]` as chips: text preview + ✕. Use a Vue `<TransitionGroup>`
  so an item animates out when it drains into the live turn.
- **Turn HUD** (`ChatPane.vue` ~lines 177-187) keeps its single Cancel for the
  running turn — now the only cancel affordance.
- **i18n** — queue strip label ("排队中 / Queued"), per-item cancel aria-label,
  empty/among-N helper text, in `zh` and `en`.

## Data flow

```
busy session, user sends
  relay-web PromptInput.submit (no longer blocked)
    → chat.prompt() → control.prompt RPC
      → control-bridge MSG.prompt → ControlService.prompt(queueable:true)
        → executeTurn: existing && !aborted → enqueue, emit queue-updated,
                       return { ok:true, queued:true, queueItemId }
  ... server → web: queue-updated (full snapshot) → chat.queues[key] = items
                    → QueueStrip renders chips

current turn finishes
  executeTurn finally → pop queue head (busy slot held) → start next turn
    → emit queue-updated (item removed) + turn-started{ prompt, queueItemId }
    → web: chip animates out, becomes the live turn

user clicks ✕ on a queued chip
  chat.cancelQueuedItem → control.queue.cancel RPC → ControlService.cancelQueuedItem
    → splice + emit queue-updated → web list updates
```

## Concurrency / invariants

- **No parallel turns:** the drain holds the `inFlight` slot across the
  turn-N→turn-N+1 hand-off; an incoming prompt during that window sees "busy" and
  enqueues.
- **Order preserved:** FIFO per session; drain always takes the head.
- **Idempotent cancels:** `cancelQueuedItem` on a drained/absent id returns
  `cancelled:false` and emits no spurious state.
- **Control lane untouched:** `/use`, `/cancel`, `/stop` never enqueue.

## Build / release caveats (from project memory)

- **`relay-protocol` must be built with `tsc`**, not the bun barrel build (bun
  tree-shakes `export *` barrels to empty → runtime "no export named MSG"). New
  `MSG.queueCancel` / DTO fields won't exist at runtime otherwise.
- **Connector must be repackaged, reinstalled into the plugin home, and the
  console restarted** for the new RPC + event to take effect (stale-tarball
  pitfall — otherwise the queue silently does nothing).
- **Core release required** (control-service + event-bus are core). Follow the
  relay-stack topology: protocol → core → connector → hub. Protocol change is
  additive/backward-compatible → stays `0.1.x` (`^0.1.0`). Bump `channel-relay`.
- **Core version coupling:** bumping core means updating
  `tests/unit/packages/package-metadata.test.ts` (hardcoded version) and the
  `weacpx-compat/package.json` shim (`version` + `^dep`), and
  `npm install --package-lock-only` (bun.lock needs no change).

## Testing

- **core (bun):** `executeTurn` enqueues instead of rejecting when busy (manual
  path); scheduled path still rejects; drain runs queued items FIFO on
  turn-finish; the busy slot is held across the hand-off (no parallel turn);
  `cancelQueuedItem` removes an item and returns `false` for a drained id;
  `queue-updated` emitted on enqueue/drain/cancel with correct ordered snapshots;
  Stop cancels the running turn while the queue persists and then drains;
  `turn-started` carries `queueItemId` only for drained turns; control-lane
  commands never enqueue.
- **connector (bun):** `MSG.queueCancel` dispatches to `cancelQueuedItem`;
  `queue-updated` forwards through `subscribeControlEvents` as `instanceEvent`.
- **web (vitest, not bun):** send while busy issues the RPC + shows an optimistic
  chip; `queue-updated` replaces the list; `cancelQueuedItem` issues the RPC and
  removes the chip; a `turn-started` with `queueItemId` drains the chip into the
  live turn; the send button never renders "Stop".

## Out of scope (YAGNI)

- Unifying with the WeChat `conversation-executor` queue.
- Reordering (drag) or editing queued messages.
- A global "clear queue / stop everything" control.
- Enqueuing scheduled turns.
- A cross-session global queue view.
