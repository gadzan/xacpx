# Non-blocking send + server-authoritative message queue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While an agent turn runs, let relay-web users keep sending prompts; extra prompts queue server-side (control layer), run FIFO as the agent frees up, and the web visualizes the queue (per-item text preview + cancel), animating a queued item into the live turn when it starts.

**Architecture:** Build a real per-session queue in `ControlService` (today it *rejects* mid-turn prompts). `executeTurn` enqueues instead of rejecting; the turn's `finally` drains the head while holding the busy slot (no parallel turns). A queued item is persisted/streamed only when it drains, via the existing `turn-started{prompt}` machinery (same path scheduled turns use). A new `queue-updated` control event (full replace-latest snapshot) + a `queue.cancel` RPC flow through relay-protocol → connector → web. The web unblocks the composer, keeps the send button always "Send" (cancel lives only in the Turn HUD), and renders a queue strip.

**Tech Stack:** TypeScript (core), relay-protocol (built with **tsc**, not bun), channel-relay connector, Vue 3 + Pinia + vue-i18n (relay-web), Vitest (web) + bun test (core/connector).

## Global Constraints

- **Queue is control-path scoped**, keyed by `turnKey(chatKey, sessionAlias)`. WeChat's separate `conversation-executor` queue is NOT touched or unified.
- **Only interactive `ControlService.prompt` enqueues.** `runScheduledTurn` keeps its current immediate-or-reject behavior (a `queueable` flag distinguishes them).
- **No parallel turns:** the drain holds the `inFlight` slot across the turn-N→N+1 hand-off; a prompt arriving in that window enqueues.
- **FIFO**, replace-latest snapshots. Every queue change (enqueue / drain / cancel) emits a `queue-updated` event carrying the full ordered item list `{ id, textPreview, enqueuedAt }` (textPreview truncated ~120 chars server-side).
- **A queued message is NOT persisted to history nor shown as a delivered transcript bubble until it drains.** It lives only in the queue until it runs; on drain it is streamed/persisted via `turn-started{prompt, queueItemId}` exactly like a scheduled turn.
- **Cancel (Stop / HUD) cancels only the running turn; the queue survives** and drains next. Per-item ✕ removes a queued item. No global "clear queue" button.
- **Additive, backward-compatible protocol:** new event type + new RPC + optional result fields. Old web clients ignore the unknown event. Protocol stays `0.1.x` (`^0.1.0`).
- **relay-protocol builds with `tsc`** (bun tree-shakes `export *` barrels to empty → runtime "no export named MSG"). Rebuild protocol dist before downstream packages pick up new DTOs.
- **Connector repackage + reinstall into plugin home + console restart** required for new RPC/event to take effect (stale-tarball pitfall) — this is a runtime/deploy note, not a code task.
- Core tests: `node scripts/run-tests.mjs` (or focused `bun test <file>`). Web tests: `cd packages/relay-web && npx vitest run <file>` (NOT bun). Connector tests: `bun test <file>`.
- **Out of scope (YAGNI):** unifying with WeChat's queue; reorder/edit queued items; enqueuing scheduled turns; cross-session global queue view; **queue restore across a web refresh/reconnect** (the queue is ephemeral; after a reload the strip re-syncs on the next `queue-updated`). Document the refresh limitation; do not build snapshot-seeding.

---

## Phase A — Core queue engine (`src/control/`)

### Task 1: Queue state + enqueue-instead-of-reject + `queue-updated` event

**Files:**
- Modify: `src/control/control-event-bus.ts` (add `queue-updated` to `ControlEvent`; add `queueItemId?` to `turn-started`)
- Modify: `src/control/control-service.ts` (queue map; `ControlPromptResult` + `executeTurn` params; enqueue branch; a `queueable` flag; a `QUEUE_PREVIEW_MAX` const + `emitQueueUpdated` helper)
- Test: `tests/unit/control/control-service-queue.test.ts`

**Interfaces:**
- Consumes: existing `executeTurn` (control-service.ts:424-651), `inFlight: Map<string,{controller,settled}>` (line 393), `turnKey` (line 698), `this.deps.events.emit`.
- Produces:
  - `ControlEvent` gains `| { type: "queue-updated"; chatKey: string; sessionAlias: string; items: QueuedItemInfo[] }` where `QueuedItemInfo = { id: string; textPreview: string; enqueuedAt: string }` (export the type from control-event-bus.ts), and `turn-started` gains `queueItemId?: string`.
  - `ControlPromptResult` gains `queued?: boolean; queueItemId?: string`.
  - Private `queues: Map<string, QueuedPrompt[]>` and `emitQueueUpdated(chatKey, sessionAlias)` on `ControlService`. `QueuedPrompt = { id, text, enqueuedAt, senderId, isOwner?, accountId?, media? }`.
  - `executeTurn` gains a `queueable?: boolean` param; `prompt()` passes `queueable: true`, `runScheduledTurn` passes `queueable: false`/omits.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/control/control-service-queue.test.ts`. Use the existing control-service test setup as the template — open `tests/unit/control/control-service.test.ts` (or the nearest existing control-service test) and copy its harness (fake deps, how `ControlService` is constructed, how `events` are captured). Then add:

```ts
// Pseudocode shape — adapt to the real harness in the sibling control-service test.
// A fake agent.chat that blocks until released, so a turn stays "in flight".
test("a second prompt while a turn is running is queued, not rejected, and emits queue-updated", async () => {
  const { service, events, releaseChat } = makeService(); // harness: releaseChat resolves the in-flight agent.chat
  const p1 = service.prompt({ chatKey: "c", sessionAlias: "s", text: "first", senderId: "u" });
  // let turn 1 register as in-flight before sending the second
  await tick();
  const r2 = await service.prompt({ chatKey: "c", sessionAlias: "s", text: "second", senderId: "u" });
  expect(r2.ok).toBe(true);
  expect(r2.queued).toBe(true);
  expect(typeof r2.queueItemId).toBe("string");
  const qEvents = events.filter(e => e.type === "queue-updated");
  expect(qEvents.at(-1)).toMatchObject({ chatKey: "c", sessionAlias: "s" });
  expect(qEvents.at(-1).items.map(i => i.textPreview)).toEqual(["second"]);
  releaseChat(); await p1;
});

test("scheduled turns are NOT queued (still reject) while a turn runs", async () => {
  const { service, releaseChat } = makeService();
  const p1 = service.prompt({ chatKey: "c", sessionAlias: "s", text: "first", senderId: "u" });
  await tick();
  const r = await service.runScheduledTurn({ chatKey: "c", sessionAlias: "s", promptText: "sched", taskId: "t1", executeAt: "2026-07-01T00:00:00Z" });
  expect(r.ok).toBe(false);
  expect(r.errorMessage).toBe("turn-already-running");
  releaseChat(); await p1;
});
```

If the existing harness can't hold a turn in-flight, add a controllable `agent.chat` that returns a promise you resolve via `releaseChat()`. Model `tick()` as `await new Promise(r => setTimeout(r, 0))`.

- [ ] **Step 2: Run RED** — `bun test tests/unit/control/control-service-queue.test.ts` → FAIL (`queued` undefined / second prompt rejected).

- [ ] **Step 3: Implement**

In `src/control/control-event-bus.ts`: add the exported `QueuedItemInfo` interface, the `queue-updated` union member, and `queueItemId?: string` on the `turn-started` member (line 15).

In `src/control/control-service.ts`:
- Add `export interface QueuedPrompt { id: string; text: string; enqueuedAt: string; senderId: string; isOwner?: boolean; accountId?: string; media?: PromptAttachmentRef[]; }` and `private readonly queues = new Map<string, QueuedPrompt[]>();` near `inFlight` (line 393). Add `const QUEUE_PREVIEW_MAX = 120;` near the other module consts (e.g. near `CANCEL_DRAIN_TIMEOUT_MS`, line 682).
- Add `queued?: boolean; queueItemId?: string;` to `ControlPromptResult` (line 129).
- Add an id minter. There is likely an existing id utility in the repo (grep `randomUUID`/`nanoid` under `src/`); reuse it. If none, `import { randomUUID } from "node:crypto"`.
- Add a helper:
```ts
  private emitQueueUpdated(chatKey: string, sessionAlias: string): void {
    const items = (this.queues.get(turnKey(chatKey, sessionAlias)) ?? []).map((q) => ({
      id: q.id,
      textPreview: q.text.length > QUEUE_PREVIEW_MAX ? q.text.slice(0, QUEUE_PREVIEW_MAX) : q.text,
      enqueuedAt: q.enqueuedAt,
    }));
    this.deps.events.emit({ type: "queue-updated", chatKey, sessionAlias, items });
  }
```
- Change `prompt()` to call `executeTurn({ ..., queueable: true })`. Add `queueable?: boolean;` to the `executeTurn` params object (line 424-435). `runScheduledTurn` (line 411) already omits it → treated as non-queueable.
- In `executeTurn`, replace the reject in the `existing && !aborted` branch (lines 440-442):
```ts
      if (!existing.controller.signal.aborted) {
        if (params.queueable) {
          const id = randomUUID();
          const item: QueuedPrompt = {
            id, text: params.text, enqueuedAt: new Date().toISOString(), senderId: params.senderId,
            ...(params.isOwner !== undefined ? { isOwner: params.isOwner } : {}),
            ...(params.accountId !== undefined ? { accountId: params.accountId } : {}),
            ...(params.media !== undefined ? { media: params.media } : {}),
          };
          const q = this.queues.get(key) ?? [];
          q.push(item); this.queues.set(key, q);
          this.emitQueueUpdated(params.chatKey, params.sessionAlias);
          return { ok: true, queued: true, queueItemId: id };
        }
        return { ok: false, errorMessage: "turn-already-running" };
      }
```
(The `existing && aborted` unwinding path below it is unchanged.)

**Persistence-timing pin (do this before finishing the task):** confirm WHERE an inbound web prompt is persisted to history. Grep the hub/connector for how `turn-started`'s `prompt` field and normal prompts reach history persistence (start from `packages/channel-relay` subscribeControlEvents + the hub message store, and the comment at control-event-bus.ts:13-14 "letting the hub persist the inbound prompt"). Requirement: a QUEUED message must be persisted **once, at drain time** (Task 2 emits `turn-started{prompt}` for it), NOT at enqueue. If you find inbound persistence keyed off the `control.prompt` RPC call itself (i.e. it would persist at enqueue), note it in your report as a BLOCKER for Task 2 and stop — the controller will adjust the plan. If persistence is driven by `turn-started{prompt}` (as it is for scheduled turns), no change is needed here.

- [ ] **Step 4: Run GREEN** — `bun test tests/unit/control/control-service-queue.test.ts` → PASS. Also run the existing control-service test to confirm no regression: `bun test tests/unit/control/control-service.test.ts`.

- [ ] **Step 5: Typecheck** — `npx tsc --noEmit` → clean.

- [ ] **Step 6: Commit**
```bash
git add src/control/control-event-bus.ts src/control/control-service.ts tests/unit/control/control-service-queue.test.ts
git commit -m "feat(control): queue mid-turn prompts instead of rejecting + queue-updated event"
```

---

### Task 2: Drain the queue on turn-finish (FIFO, busy-slot held)

**Files:**
- Modify: `src/control/control-service.ts` (the `executeTurn` `finally`, lines 634-650; stamp `turn-started` with `queueItemId`)
- Test: `tests/unit/control/control-service-queue.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's `queues` map, `emitQueueUpdated`, `QueuedPrompt`; `executeTurn`; the existing `turn-started` emit (lines 491-497).
- Produces: after a turn finishes, the head queued item runs as the next turn without releasing the busy slot; its `turn-started` carries `prompt: item.text` and `queueItemId: item.id`.

- [ ] **Step 1: Write the failing test** (append):
```ts
test("queued prompts drain FIFO after the running turn finishes, each as its own turn", async () => {
  const { service, events, nextChat } = makeService(); // nextChat: resolve each in-flight chat one at a time, in order
  const p1 = service.prompt({ chatKey: "c", sessionAlias: "s", text: "first", senderId: "u" });
  await tick();
  await service.prompt({ chatKey: "c", sessionAlias: "s", text: "second", senderId: "u" });
  await service.prompt({ chatKey: "c", sessionAlias: "s", text: "third", senderId: "u" });
  nextChat(); await tick();   // finish turn 1 → drain "second"
  const started = events.filter(e => e.type === "turn-started");
  expect(started.at(-1)).toMatchObject({ prompt: "second" });
  expect(typeof started.at(-1).queueItemId).toBe("string");
  // queue now shows only "third"
  const q = events.filter(e => e.type === "queue-updated").at(-1);
  expect(q.items.map(i => i.textPreview)).toEqual(["third"]);
  nextChat(); await tick();   // finish "second" → drain "third"
  nextChat(); await tick();   // finish "third" → queue empty
  expect(events.filter(e => e.type === "queue-updated").at(-1).items).toEqual([]);
  await p1;
});

test("a prompt arriving during the drain hand-off is queued (no parallel turn)", async () => {
  const { service, events, nextChat } = makeService();
  const p1 = service.prompt({ chatKey: "c", sessionAlias: "s", text: "first", senderId: "u" });
  await tick();
  await service.prompt({ chatKey: "c", sessionAlias: "s", text: "second", senderId: "u" });
  nextChat(); // finish turn1; drain starts "second"
  const r3 = await service.prompt({ chatKey: "c", sessionAlias: "s", text: "third", senderId: "u" });
  expect(r3.queued).toBe(true); // saw "second" as in-flight, enqueued
  nextChat(); nextChat(); await p1;
});
```

- [ ] **Step 2: Run RED** — the drain isn't implemented → "second" never starts; FAIL.

- [ ] **Step 3: Implement**

Add `queueItemId` to the `turn-started` emit (line 491-497):
```ts
      ...(params.turnStarted?.queueItemId ? { queueItemId: params.turnStarted.queueItemId } : {}),
```
and add `queueItemId?: string` to the `turnStarted` param shape (line 434).

Rework the `finally` (lines 634-650) so that instead of only `this.inFlight.delete(key); resolveSettled();`, it drains the head **while keeping the slot busy**. Structure:
```ts
    } finally {
      const next = (this.queues.get(key) ?? []).shift();
      if (next && (this.queues.get(key)?.length ?? 0) === 0) this.queues.delete(key);
      // ... keep the existing sessions-changed detection block (lines 640-648) ...
      if (next) {
        this.emitQueueUpdated(params.chatKey, params.sessionAlias);
        // Start the next turn WITHOUT clearing inFlight first (slot stays busy → no race).
        // Fire-and-forget: this drained turn drives its own settled lifecycle.
        void this.executeTurn({
          chatKey: params.chatKey, sessionAlias: params.sessionAlias, text: next.text, senderId: next.senderId,
          queueable: true,
          ...(next.isOwner !== undefined ? { isOwner: next.isOwner } : {}),
          ...(next.accountId !== undefined ? { accountId: next.accountId } : {}),
          ...(next.media !== undefined ? { media: next.media } : {}),
          turnStarted: { prompt: next.text, queueItemId: next.id },
        });
        // NOTE: the drained executeTurn call re-sets inFlight[key] at its top (a fresh
        // controller). To avoid a gap, set the new inFlight entry BEFORE deleting this
        // turn's — see the ordering note below.
        resolveSettled();
      } else {
        this.inFlight.delete(key);
        resolveSettled();
      }
    }
```

**Ordering correctness (critical):** `executeTurn` sets `this.inFlight.set(key, …)` at its top (line 463) only after two `await`s (resolveAliasForChat, useSession). Between this turn's `inFlight.delete` and the drained turn's `inFlight.set`, an incoming `prompt` could see no in-flight and start a parallel turn. To close this window, DO NOT delete `inFlight` before the drained `executeTurn` re-sets it. Simplest robust approach: keep a per-key `draining` guard — set `this.inFlight` to a placeholder busy entry for `key` synchronously (a fresh `AbortController` + a settled promise) BEFORE the `void this.executeTurn(...)`, and have the drained `executeTurn` overwrite it. If overwriting the inFlight entry conflicts with the drained turn's own controller wiring, instead add a synchronous `private draining = new Set<string>()`: mark `draining.add(key)` before the drain call and treat `draining.has(key)` as "busy" in the enqueue check at the top of `executeTurn` (so `existing || this.draining.has(key)` gates enqueue), clearing it once the drained turn has registered its own `inFlight`. Implement whichever keeps the invariant; the "prompt during hand-off is queued" test above is the guard. Explain your chosen mechanism in the report.

- [ ] **Step 4: Run GREEN** — `bun test tests/unit/control/control-service-queue.test.ts` → PASS (all, incl. the hand-off test). Re-run `bun test tests/unit/control/control-service.test.ts`.

- [ ] **Step 5: Typecheck** — `npx tsc --noEmit`.

- [ ] **Step 6: Commit**
```bash
git add src/control/control-service.ts tests/unit/control/control-service-queue.test.ts
git commit -m "feat(control): drain queued prompts FIFO on turn-finish, no parallel turns"
```

---

### Task 3: `cancelQueuedItem`

**Files:**
- Modify: `src/control/control-service.ts` (new public method near `cancelTurn`, line 653)
- Test: `tests/unit/control/control-service-queue.test.ts` (extend)

**Interfaces:**
- Produces: `cancelQueuedItem(chatKey: string, sessionAlias: string, itemId: string): { cancelled: boolean }` — splices the item from `queues[key]`, emits `queue-updated`, returns `{ cancelled: false }` when the id is absent/already drained.

- [ ] **Step 1: Write the failing test** (append):
```ts
test("cancelQueuedItem removes a queued item and emits queue-updated; false for unknown id", async () => {
  const { service, events, releaseChat } = makeService();
  const p1 = service.prompt({ chatKey: "c", sessionAlias: "s", text: "first", senderId: "u" });
  await tick();
  const r2 = await service.prompt({ chatKey: "c", sessionAlias: "s", text: "second", senderId: "u" });
  expect(service.cancelQueuedItem("c", "s", r2.queueItemId!)).toEqual({ cancelled: true });
  expect(events.filter(e => e.type === "queue-updated").at(-1).items).toEqual([]);
  expect(service.cancelQueuedItem("c", "s", "nope")).toEqual({ cancelled: false });
  releaseChat(); await p1;
});
```

- [ ] **Step 2: RED** — method missing.

- [ ] **Step 3: Implement**
```ts
  cancelQueuedItem(chatKey: string, sessionAlias: string, itemId: string): { cancelled: boolean } {
    const key = turnKey(chatKey, sessionAlias);
    const q = this.queues.get(key);
    if (!q) return { cancelled: false };
    const i = q.findIndex((x) => x.id === itemId);
    if (i < 0) return { cancelled: false };
    q.splice(i, 1);
    if (q.length === 0) this.queues.delete(key);
    this.emitQueueUpdated(chatKey, sessionAlias);
    return { cancelled: true };
  }
```

- [ ] **Step 4: GREEN** — `bun test tests/unit/control/control-service-queue.test.ts`.

- [ ] **Step 5: Commit**
```bash
git add src/control/control-service.ts tests/unit/control/control-service-queue.test.ts
git commit -m "feat(control): cancelQueuedItem removes a pending queued prompt"
```

---

## Phase B — Protocol (`packages/relay-protocol/`)

### Task 4: DTOs + MSG + payloads (built with tsc)

**Files:**
- Modify: `packages/relay-protocol/src/dtos.ts` (`ControlEventDto` union at 178-200; `turn-started` member at 182)
- Modify: `packages/relay-protocol/src/messages.ts` (`MSG` at 6-41; `PromptResult` at 225-229; new payload/result)
- Test: `packages/relay-protocol/` has minimal tests; add or extend a message-shape test if one exists, else this task is verified by tsc + the connector test in Task 5.

**Interfaces:**
- Produces:
  - `ControlEventDto` gains `| { type: "queue-updated"; chatKey: string; sessionAlias: string; items: QueueItemDto[] }` with `export interface QueueItemDto { id: string; textPreview: string; enqueuedAt: string }`, and `queueItemId?: string` on its `turn-started` member.
  - `MSG.queueCancel = "control.queue.cancel"`.
  - `export interface QueueCancelPayload { chatKey: string; sessionAlias: string; itemId: string }` and `export interface QueueCancelResult { cancelled: boolean }`.
  - `PromptResult` gains `queued?: boolean; queueItemId?: string;`.

- [ ] **Step 1: Implement the type additions** (mirror the existing `promptCancel`/`PromptCancel*` shapes at messages.ts:26,230-236, and the `ControlEventDto` `plan` member for the array-carrying pattern).

- [ ] **Step 2: Build the protocol with tsc** (NOT bun — bun empties the barrel):
Run the package's build script — check `packages/relay-protocol/package.json` for the `build` script (it uses tsc). Run: `cd packages/relay-protocol && npm run build` (or the exact script). Confirm `dist/` regenerated and `MSG.queueCancel` is present in `dist/messages.js`.

- [ ] **Step 3: Typecheck the workspace root** — `npx tsc --noEmit` → clean (root src consumes protocol types via path/dist).

- [ ] **Step 4: Commit**
```bash
git add packages/relay-protocol/src/dtos.ts packages/relay-protocol/src/messages.ts packages/relay-protocol/dist
git commit -m "feat(relay-protocol): queue-updated event + queue.cancel RPC + queued PromptResult fields"
```
(Commit the rebuilt `dist/` — downstream packages import from it. Confirm whether `dist/` is tracked in this repo; if it is git-ignored, skip adding it and note that consumers rebuild.)

---

## Phase C — Connector (`packages/channel-relay/`)

### Task 5: `queue.cancel` dispatch (events auto-forward)

**Files:**
- Modify: `packages/channel-relay/src/control-bridge.ts` (add a `case MSG.queueCancel` near the `MSG.promptCancel` case at line 152)
- Test: `tests/unit/packages/channel-relay/…` — find the existing control-bridge dispatch test (grep for `promptCancel` under `tests/`) and mirror it.

**Interfaces:**
- Consumes: `control.cancelQueuedItem` (Task 3), `MSG.queueCancel` + `QueueCancelPayload` (Task 4).
- Produces: `MSG.queueCancel` → `{ cancelled: boolean }`. `queue-updated` events require NO new wiring — `subscribeControlEvents` forwards every `ControlEvent` as `MSG.instanceEvent` (line 281).

- [ ] **Step 1: Write the failing test** — mirror the existing promptCancel dispatch test: assert `MSG.queueCancel` with `{ chatKey, sessionAlias, itemId }` calls `control.cancelQueuedItem(chatKey, sessionAlias, itemId)` and returns its result. Also assert (if the existing event-forwarding test exists) that a `queue-updated` `ControlEvent` is forwarded via `instanceEvent` — the generic path already covers it, so this is a light confirmation.

- [ ] **Step 2: RED** — `bun test <the control-bridge test file>`.

- [ ] **Step 3: Implement** — add after the `promptCancel` case:
```ts
    case MSG.queueCancel: {
      const input = params as QueueCancelPayload;
      return control.cancelQueuedItem(input.chatKey, input.sessionAlias, input.itemId);
    }
```
(Match the file's actual param-casting style; import `QueueCancelPayload`/`MSG` as the file already imports protocol types.)

- [ ] **Step 4: GREEN** — `bun test <the control-bridge test file>`. Typecheck: `npx tsc --noEmit`.

- [ ] **Step 5: Commit**
```bash
git add packages/channel-relay/src/control-bridge.ts tests/unit/packages/channel-relay/
git commit -m "feat(channel-relay): dispatch control.queue.cancel to cancelQueuedItem"
```

---

## Phase D — Web (`packages/relay-web/`)

### Task 6: chat store — queue state, event handler, cancel, send-while-busy routing

**Files:**
- Modify: `packages/relay-web/src/stores/chat.ts` (state; `applyEvent` at 292-360; `send` at 363-402; new `cancelQueuedItem`; export)
- Test: `packages/relay-web/src/__tests__/chat-queue.test.ts`

**Interfaces:**
- Consumes: `WebServerEvent`/`ControlEventDto` (now with `queue-updated` + `turn-started.queueItemId`), `PromptResult.queued/queueItemId`, `MSG.queueCancel`.
- Produces (added to the store's return): `queues: Record<sessionKey, QueueItemDto[]>` (reactive), `sessionQueue` computed for the selected session, `cancelQueuedItem(instanceId, alias, itemId)`. `send()` now: if a turn is running for the target session (`liveTurns[key]` present, i.e. `busy`), route to the queue (optimistic chip, no transcript bubble) and reconcile from `queue-updated`; else current behavior (optimistic bubble + immediate turn).

- [ ] **Step 1: Write the failing test** — create `chat-queue.test.ts`:
```ts
// setup: pinia + a mock api.rpc. Two scenarios.
it("queue-updated replaces the per-session queue list", () => {
  const chat = useChatStore(); chat.select("i1", "s");
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "queue-updated", chatKey: "c", sessionAlias: "s", items: [{ id: "q1", textPreview: "hi", enqueuedAt: "t" }] } } as WebServerEvent);
  expect(chat.sessionQueue.map(i => i.id)).toEqual(["q1"]);
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "queue-updated", chatKey: "c", sessionAlias: "s", items: [] } } as WebServerEvent);
  expect(chat.sessionQueue).toEqual([]);
});

it("sending while busy issues the RPC and does NOT push a transcript bubble", async () => {
  const chat = useChatStore(); chat.select("i1", "s");
  // make the session busy: a live turn exists
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "s" } } as WebServerEvent);
  const before = chat.messages.length;
  await chat.send("queued msg");
  expect(chat.messages.length).toBe(before); // no optimistic bubble while busy
  // rpc called with control.prompt (mock asserts)
});

it("cancelQueuedItem issues control.queue.cancel and optimistically drops the chip", async () => {
  const chat = useChatStore(); chat.select("i1", "s");
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "queue-updated", chatKey: "c", sessionAlias: "s", items: [{ id: "q1", textPreview: "hi", enqueuedAt: "t" }] } } as WebServerEvent);
  await chat.cancelQueuedItem("i1", "s", "q1");
  expect(chat.sessionQueue.find(i => i.id === "q1")).toBeUndefined();
});
```
Mock `api.rpc` (mirror the existing chat.test.ts mock) and assert the RPC method names/args.

- [ ] **Step 2: RED** — `cd packages/relay-web && npx vitest run src/__tests__/chat-queue.test.ts`.

- [ ] **Step 3: Implement**
- Add state: `const queues = ref<Record<string, QueueItemDto[]>>({});` and `const sessionQueue = computed<QueueItemDto[]>(() => selectedKey.value ? queues.value[selectedKey.value] ?? [] : []);`. Import `QueueItemDto` from the protocol package.
- `applyEvent`: add `else if (e.type === "queue-updated") { queues.value[bufKey(event.instanceId, e.sessionAlias)] = e.items; }`.
- `send()`: at the top, compute `const key = bufKey(instanceId.value, sessionAlias.value); const willQueue = !!liveTurns.value[key];`. When `willQueue`, DON'T push the optimistic transcript bubble; instead push an optimistic chip into `queues.value[key]` (a temporary `{ id: "optimistic-"+…, textPreview: text.slice(0,120), enqueuedAt: new Date().toISOString() }`), send the RPC as today, and let the authoritative `queue-updated` replace the list. Keep the existing non-busy path unchanged. (The drained item later arrives as a `turn-started{prompt,queueItemId}` which the EXISTING handler at 310-319 already turns into an inbound bubble when selected — no change needed there.)
- Add `async function cancelQueuedItem(instanceId: string, alias: string, itemId: string) { const key = bufKey(instanceId, alias); const list = queues.value[key]; if (list) queues.value[key] = list.filter(i => i.id !== itemId); try { await api.rpc(instanceId, "control.queue.cancel", { sessionAlias: alias, itemId }); } catch { /* best-effort; a queue-updated will re-sync */ } }`.
- Add `queues, sessionQueue, cancelQueuedItem` to the store's returned object (line 430).

- [ ] **Step 4: GREEN** — `npx vitest run src/__tests__/chat-queue.test.ts`; regression `npx vitest run src/__tests__/chat.test.ts`.

- [ ] **Step 5: Commit**
```bash
git add packages/relay-web/src/stores/chat.ts packages/relay-web/src/__tests__/chat-queue.test.ts
git commit -m "feat(relay-web): chat store queue state, queue-updated handler, send-while-busy routing"
```

---

### Task 7: Composer — unblock send, always-Send button

**Files:**
- Modify: `packages/relay-web/src/components/PromptInput.vue` (`submit()` at 123-125; the Stop/Send buttons at 288-291; keep the Esc-cancel at 169)
- Test: `packages/relay-web/src/__tests__/promptinput-queue.test.ts`

**Interfaces:**
- Consumes: the `busy` prop still flows in (drives placeholder + Esc-cancel), but no longer blocks submit and no longer swaps the button to Stop.
- Produces: `submit()` emits `send` even while busy; the primary button is always the `type="submit"` Send button (the `v-if="busy"` Stop button is removed). Cancel now lives only in the Turn HUD (Task 8 leaves it there).

- [ ] **Step 1: Write the failing test** — mount `PromptInput` with `busy: true`, type text, submit; assert a `send` event is emitted (today it's suppressed). Assert `[data-test="composer-stop"]` is NOT rendered and `[data-test="composer-send"]` IS rendered while busy.

- [ ] **Step 2: RED** — `npx vitest run src/__tests__/promptinput-queue.test.ts`.

- [ ] **Step 3: Implement**
- Remove `if (props.busy) return;` at line 124.
- Replace the busy/else button pair (288-291) with a single always-rendered Send button (`data-test="composer-send"`, `type="submit"`, same `:disabled` upload/empty guard as the current send button). Delete the `data-test="composer-stop"` button.
- Keep the Esc-cancel handler (169) so Esc still cancels the running turn; update the composer comment (227-228) to reflect that send now queues while busy.

- [ ] **Step 4: GREEN** — `npx vitest run src/__tests__/promptinput-queue.test.ts`; regression on any existing PromptInput test.

- [ ] **Step 5: Commit**
```bash
git add packages/relay-web/src/components/PromptInput.vue packages/relay-web/src/__tests__/promptinput-queue.test.ts
git commit -m "feat(relay-web): non-blocking composer — send always enabled, Stop moves to HUD only"
```

---

### Task 8: QueueStrip component + wire into ChatPane

**Files:**
- Create: `packages/relay-web/src/components/QueueStrip.vue`
- Modify: `packages/relay-web/src/components/ChatPane.vue` (render `<QueueStrip>` in the composer area, above `PromptInput`, below the Turn HUD)
- Modify: `packages/relay-web/src/i18n/messages/en.ts` + `zh-CN.ts` (queue strip strings)
- Test: `packages/relay-web/src/__tests__/queuestrip.test.ts`

**Interfaces:**
- Consumes: `useChatStore().sessionQueue` (Task 6), `cancelQueuedItem` (Task 6).
- Produces: a strip rendering `sessionQueue` as chips (`data-test="queue-item"`), each with the `textPreview` and a ✕ (`data-test="queue-cancel"`) calling `chat.cancelQueuedItem(chat.instanceId, chat.sessionAlias, item.id)`. Uses `<TransitionGroup>` so a drained item animates out. Renders nothing when `sessionQueue` is empty.

- [ ] **Step 1: Add i18n keys** (both locales, parity-enforced — identical keys, no empty values): `chat.queuedHeader` (e.g. en "Queued" / zh "排队中"), `chat.queueCancelAria` (e.g. "Remove from queue" / "从队列移除").

- [ ] **Step 2: Write the failing test** — `queuestrip.test.ts`: mount `QueueStrip` with a pinia where `chat.select("i1","s")` and a `queue-updated` seeded 2 items; assert two `[data-test="queue-item"]` with the previews; click the first `[data-test="queue-cancel"]` and assert `chat.cancelQueuedItem` is called with `("i1","s", firstId)` (spy on the store action, shared-pinia pattern from the Task-4 settings test in Feature 1). Assert the strip renders nothing when the queue is empty.

- [ ] **Step 3: RED** — `npx vitest run src/__tests__/queuestrip.test.ts`.

- [ ] **Step 4: Implement** `QueueStrip.vue` (script setup + `<TransitionGroup>` list, Tailwind classes consistent with the existing HUD/chip styling in ChatPane), and render it in `ChatPane.vue` right below the Turn HUD block (after line 187) and above the composer. Guard with `v-if="chat.sessionQueue.length"`.

- [ ] **Step 5: GREEN** — `npx vitest run src/__tests__/queuestrip.test.ts`; run i18n parity: `npx vitest run src/__tests__/i18n-parity.test.ts`.

- [ ] **Step 6: Commit**
```bash
git add packages/relay-web/src/components/QueueStrip.vue packages/relay-web/src/components/ChatPane.vue packages/relay-web/src/i18n/messages/en.ts packages/relay-web/src/i18n/messages/zh-CN.ts packages/relay-web/src/__tests__/queuestrip.test.ts
git commit -m "feat(relay-web): QueueStrip shows pending messages with per-item cancel"
```

---

### Task 9: Full-suite + typecheck gate (web + core + connector)

**Files:** none (verification).

- [ ] **Step 1:** `cd packages/relay-web && npx vitest run` — all green (capture real exit code, don't pipe through tail).
- [ ] **Step 2:** `cd packages/relay-web && npx vue-tsc --noEmit` — clean.
- [ ] **Step 3:** From repo root: `node scripts/run-tests.mjs` — root typecheck + core bun tests + relay-web vitest all green (this rebuilds plugin-api + relay-protocol first).
- [ ] **Step 4:** `git status` clean; `git log --oneline main..HEAD` shows the spec + Tasks 1-8 commits.

---

## Phase E — Release prep (do NOT publish here; the user runs the release skill)

### Task 10: Version bumps + changelog + lockfile (staged, not tagged)

**Files:**
- Modify: `package.json` (core version bump, e.g. 0.16.0 → 0.17.0)
- Modify: `tests/unit/packages/package-metadata.test.ts` (hardcoded core version string + `expect(pkg.version).toBe(...)`)
- Modify: `weacpx-compat/package.json` (`version` === root.version; `dependencies["@ganglion/xacpx"]` === `^${root.version}`)
- Modify: `packages/channel-relay/package.json` (bump; it carries the new dispatch)
- Modify: `packages/relay-protocol/package.json` (bump patch within 0.1.x — additive/back-compat)
- Modify: `CHANGELOG.md` (English entries for core + channel-relay + relay-protocol)
- Regenerate: `package-lock.json` via `npm install --package-lock-only` (bun.lock needs NO change — see [[reference_release_version_coupling]])

**Interfaces:** none (metadata only).

- [ ] **Step 1:** Decide versions (confirm with the human at execution time): core minor bump (new feature), channel-relay bump, relay-protocol patch (stays `0.1.x` so `^0.1.0` consumers are compatible).
- [ ] **Step 2:** Apply the version edits + the two coupling points (package-metadata.test.ts, weacpx-compat) — see [[reference_release_version_coupling]].
- [ ] **Step 3:** `npm install --package-lock-only`; confirm `package-lock.json` updated, `bun.lock` unchanged.
- [ ] **Step 4:** Write CHANGELOG entries (English) describing: non-blocking send + server-side per-session message queue + web queue strip; new `queue-updated` event + `control.queue.cancel` RPC (additive, back-compat).
- [ ] **Step 5:** `node scripts/run-tests.mjs` — package-metadata test now green on the new version.
- [ ] **Step 6: Commit**
```bash
git add package.json weacpx-compat/package.json packages/channel-relay/package.json packages/relay-protocol/package.json tests/unit/packages/package-metadata.test.ts CHANGELOG.md package-lock.json
git commit -m "chore: bump core + channel-relay + relay-protocol for message-queue feature"
```
- [ ] **Step 7:** STOP. Do not tag/publish. The human runs the release skill (relay stack topology: protocol → core → connector → hub; core tag `vX.Y.Z`, channel tag `channel-<pkg>-vX.Y.Z`; wait for main CI green before tags). See [[release_npm_publish_ci]].

---

## Self-review checklist (controller, before executing)
- Persistence-timing (queued message persisted only on drain) is a genuine unknown pinned in Task 1 Step 3 — if the implementer reports it persists at enqueue, the plan needs a small adjustment (move persistence to the drain path).
- The no-parallel-turn invariant hinges on Task 2's hand-off ordering — the "prompt during hand-off is queued" test is the guard; if it's flaky, prefer the explicit `draining` Set mechanism.
- Refresh-restore of the queue is explicitly OUT of scope; the strip re-syncs on the next `queue-updated`. Documented as a known limitation.
- Protocol `dist/` tracking: Task 4 Step 4 checks whether `dist/` is committed; adapt.
