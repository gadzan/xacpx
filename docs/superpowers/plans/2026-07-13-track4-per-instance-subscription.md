# Per-instance Subscription Routing (Track 4 · B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scope the hub→web `control-event` firehose to the instance(s) a socket is viewing, via a backward-compatible `subscribe` protocol message + a per-socket subscription registry in `WebGateway`, killing cross-instance amplification.

**Architecture:** Four layers, one task each. (1) Protocol: add `{ kind:"subscribe"; instanceIds:string[] }` to `WebClientMessage`. (2) Hub `WebGateway`: per-socket subscription set (absent = all); `control-event` broadcast scoped to it; `instance-status`/`notice` stay account-wide. (3) Hub inbound: a `subscribe` frame binds to its socket via `gateway.setSubscription`. (4) Web: send `subscribe([activeInstance])` on connect/reconnect/instance-switch. No server-event shape change; connector untouched.

**Tech Stack:** TypeScript. Core/relay/protocol tests: Bun (`bun test <file>`), run per-file. relay-web tests: **vitest** (`npx vitest run <file>` — never bun). Protocol changes require rebuilding its dist for downstream packages.

## Global Constraints

- **No `WebServerEvent` / `ControlEventDto` shape change.** Only `WebClientMessage` gains a variant.
- **Backward-compatible:** a socket with no subscription (never sent `subscribe`, or a legacy client) defaults to receiving **all** control-events. Absent-from-map = all.
- **Routing rule (the simple rule):** all `control-event`s are subscription-scoped by `event.instanceId`; `instance-status` and `notice` are always account-wide.
- **No ownership gate on `subscribe`** — it only narrows a socket's own feed; `broadcast` already iterates one account's sockets, so no cross-account leak is possible.
- **Composes with A (#157):** the subscription filter sits in front of the existing per-socket `readyState` + `bufferedAmount` guards in the same `broadcast` loop (this branch is stacked on A, so `web-gateway.ts` already has them).
- `subscribe` is a full-set **replace**, idempotent.
- Connector (`packages/channel-relay`) is **not** modified.
- The implementer runs **no git**; the controller commits.
- After Task 1 edits protocol `src`, rebuild its dist (`bun run build:relay-protocol`) so Tasks 3–4 (which import the package → `dist`) resolve the new message. (The full test runner does this up front; per-file runs need it.)

---

### Task 1: Protocol — the `subscribe` client message

**Files:**
- Modify: `packages/relay-protocol/src/web-dtos.ts` (the `WebClientMessage` union + `parseWebClientMessage`)
- Test: `tests/unit/packages/relay-protocol/web-dtos.test.ts`

**Interfaces:**
- Produces: `WebClientMessage` union member `{ kind:"subscribe"; instanceIds:string[] }`; `parseWebClientMessage` accepts/validates it. Later tasks consume this type (hub `web-inbound`, web `sendSubscribe`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/packages/relay-protocol/web-dtos.test.ts` (imports: add `parseWebClientMessage`, `webClientEnvelope` to the existing `../../../../packages/relay-protocol/src/index` import):

```ts
test("parseWebClientMessage round-trips a subscribe frame", () => {
  const wire = encodeEnvelope(webClientEnvelope({ kind: "subscribe", instanceIds: ["a", "b"] }));
  const decoded = decodeEnvelope(wire);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) return;
  expect(parseWebClientMessage(decoded.envelope)).toEqual({ kind: "subscribe", instanceIds: ["a", "b"] });
});

test("parseWebClientMessage accepts an empty subscribe set", () => {
  const wire = encodeEnvelope(webClientEnvelope({ kind: "subscribe", instanceIds: [] }));
  const decoded = decodeEnvelope(wire);
  if (!decoded.ok) throw new Error("decode failed");
  expect(parseWebClientMessage(decoded.envelope)).toEqual({ kind: "subscribe", instanceIds: [] });
});

test("parseWebClientMessage rejects subscribe with a non-array / non-string instanceIds", () => {
  const bad1 = { protocolVersion: 1, kind: "event", type: "web-client", payload: { kind: "subscribe", instanceIds: "nope" } } as never;
  const bad2 = { protocolVersion: 1, kind: "event", type: "web-client", payload: { kind: "subscribe", instanceIds: [1, 2] } } as never;
  expect(parseWebClientMessage(bad1)).toBeNull();
  expect(parseWebClientMessage(bad2)).toBeNull();
});

test("parseWebClientMessage still round-trips terminal-input (regression)", () => {
  const wire = encodeEnvelope(webClientEnvelope({ kind: "terminal-input", instanceId: "i1", terminalId: "t1", data: "ls\n" }));
  const decoded = decodeEnvelope(wire);
  if (!decoded.ok) throw new Error("decode failed");
  expect(parseWebClientMessage(decoded.envelope)).toEqual({ kind: "terminal-input", instanceId: "i1", terminalId: "t1", data: "ls\n" });
});
```

Note: `bad1`/`bad2` build the envelope literally rather than via `webClientEnvelope` (whose parameter type wouldn't accept the malformed payload). If the literal `type: "web-client"` mismatches the real `WEB_CLIENT_TYPE` constant, import `WEB_CLIENT_TYPE` and use it instead.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/packages/relay-protocol/web-dtos.test.ts`
Expected: the subscribe tests FAIL — `parseWebClientMessage` currently returns `null` for a `subscribe` frame (the top-level `instanceId`/`terminalId` string guard rejects it).

- [ ] **Step 3: Add the union member**

In `packages/relay-protocol/src/web-dtos.ts`, extend `WebClientMessage`:

```ts
export type WebClientMessage =
  | { kind: "terminal-input"; instanceId: string; terminalId: string; data: string }
  | { kind: "terminal-resize"; instanceId: string; terminalId: string; cols: number; rows: number }
  | { kind: "terminal-close"; instanceId: string; terminalId: string }
  | { kind: "subscribe"; instanceIds: string[] };
```

- [ ] **Step 4: Restructure `parseWebClientMessage` so the terminal string-guard gates only the terminal variants**

Replace the body of `parseWebClientMessage` (from the `const c = ...` line through the final `return null;`) with:

```ts
  const c = p as Record<string, unknown>;
  if (c.kind === "subscribe") {
    return Array.isArray(c.instanceIds) && c.instanceIds.every((x) => typeof x === "string")
      ? (p as WebClientMessage)
      : null;
  }
  // terminal-* frames all require instanceId + terminalId strings.
  if (typeof c.instanceId !== "string" || typeof c.terminalId !== "string") return null;
  if (c.kind === "terminal-input") return typeof c.data === "string" ? (p as WebClientMessage) : null;
  if (c.kind === "terminal-resize") return typeof c.cols === "number" && typeof c.rows === "number" ? (p as WebClientMessage) : null;
  if (c.kind === "terminal-close") return p as WebClientMessage;
  return null;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/unit/packages/relay-protocol/web-dtos.test.ts`
Expected: PASS (all subscribe cases + the terminal regression).

- [ ] **Step 6: Typecheck and rebuild the protocol dist**

Run: `npx tsc -p packages/relay-protocol/tsconfig.json --noEmit`  → no errors.
Run: `bun run build:relay-protocol`  → rebuilds `packages/relay-protocol/dist` (ends with the `assert:relay-protocol` runtime-export check) so downstream packages resolve the new message. Expected: "relay-protocol dist exports OK".

- [ ] **Step 7: Commit** (controller performs git)

```
feat(protocol): add subscribe client message for per-instance routing

Add { kind:"subscribe"; instanceIds:string[] } to WebClientMessage and
restructure parseWebClientMessage so the instanceId/terminalId string
guard gates only the terminal-* variants. Foundation for Track 4·B
hub-side per-instance control-event scoping. No server-event change.
```

---

### Task 2: Hub `WebGateway` — subscription registry + scoped broadcast

**Files:**
- Modify: `packages/relay/src/gateway/web-gateway.ts`
- Test: `tests/unit/packages/relay/gateway/web-gateway.test.ts`

**Interfaces:**
- Consumes: nothing new from Task 1 (routing keys on `WebServerEvent.kind`/`instanceId`, unchanged types).
- Produces: `WebGateway.setSubscription(socket: WebSocketLike, instanceIds: string[]): void`; `broadcast` now scopes `control-event`s per subscription. Task 3 consumes `setSubscription`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/packages/relay/gateway/web-gateway.test.ts`. Add a control-event helper near the existing `evt` helper:

```ts
const ctrl = (instanceId: string): WebServerEvent => ({
  kind: "control-event",
  instanceId,
  event: { type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "hi" },
});
```

Then the tests:

```ts
test("a socket with no subscription receives all control-events (backward-compat)", () => {
  const gw = new WebGateway();
  const s = new FakeSocket();
  gw.register("a1", s as never);
  gw.broadcast("a1", ctrl("iA"));
  gw.broadcast("a1", ctrl("iB"));
  expect(s.sent.length).toBe(2);
});

test("after subscribe([iA]) a socket gets iA control-events but not iB", () => {
  const gw = new WebGateway();
  const s = new FakeSocket();
  gw.register("a1", s as never);
  gw.setSubscription(s as never, ["iA"]);
  gw.broadcast("a1", ctrl("iA"));
  gw.broadcast("a1", ctrl("iB"));
  expect(s.sent.length).toBe(1);
  const decoded = decodeEnvelope(s.sent[0]!);
  expect(decoded.ok && parseWebServerEvent(decoded.envelope)).toEqual(ctrl("iA"));
});

test("instance-status and notice reach a subscribed socket regardless of subscription", () => {
  const gw = new WebGateway();
  const s = new FakeSocket();
  gw.register("a1", s as never);
  gw.setSubscription(s as never, ["iA"]);
  gw.broadcast("a1", { kind: "instance-status", instanceId: "iB", online: false });
  gw.broadcast("a1", { kind: "notice", instanceId: "iB", notice: { kind: "info", text: "hi" } as never });
  expect(s.sent.length).toBe(2);
});

test("subscribe([]) blocks all control-events but still delivers status/notice", () => {
  const gw = new WebGateway();
  const s = new FakeSocket();
  gw.register("a1", s as never);
  gw.setSubscription(s as never, []);
  gw.broadcast("a1", ctrl("iA"));
  gw.broadcast("a1", { kind: "instance-status", instanceId: "iA", online: true });
  expect(s.sent.length).toBe(1);
});

test("setSubscription replaces the prior set", () => {
  const gw = new WebGateway();
  const s = new FakeSocket();
  gw.register("a1", s as never);
  gw.setSubscription(s as never, ["iA"]);
  gw.setSubscription(s as never, ["iB"]);
  gw.broadcast("a1", ctrl("iA"));
  gw.broadcast("a1", ctrl("iB"));
  expect(s.sent.length).toBe(1); // only iB now
});

test("closing a socket clears its subscription (no leak)", () => {
  const gw = new WebGateway();
  const s = new FakeSocket();
  gw.register("a1", s as never);
  gw.setSubscription(s as never, ["iA"]);
  s.close(); // fires the close handler → removes from byAccount AND subscriptions
  // Re-register a fresh socket at the same account: with no subscription it defaults to all.
  const s2 = new FakeSocket();
  gw.register("a1", s2 as never);
  gw.broadcast("a1", ctrl("iZ"));
  expect(s2.sent.length).toBe(1);
});

test("backpressure still evicts an over-threshold socket for a subscribed control-event", () => {
  const gw = new WebGateway();
  const s = new FakeSocket();
  s.bufferedAmount = 4 * 1024 * 1024 + 1;
  gw.register("a1", s as never);
  gw.setSubscription(s as never, ["iA"]);
  gw.broadcast("a1", ctrl("iA"));
  expect(s.sent.length).toBe(0);
  expect(s.terminated).toBe(true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/packages/relay/gateway/web-gateway.test.ts`
Expected: FAIL — `gw.setSubscription` is not a function; the scoping tests fail (all control-events currently reach every socket).

- [ ] **Step 3: Add the subscription registry field**

In `packages/relay/src/gateway/web-gateway.ts`, inside `class WebGateway`, next to `private readonly byAccount = ...`, add:

```ts
  // Per-socket instance subscription. ABSENT from this map = "all" (a freshly-registered
  // socket, or a legacy client that never sends `subscribe`) → backward-compatible.
  private readonly subscriptions = new Map<WebSocketLike, Set<string>>();
```

- [ ] **Step 4: Add `setSubscription` and clear it on close**

Add the method (e.g. after `register`):

```ts
  /** Replace a socket's instance subscription (full-set, idempotent). A socket not present
   *  in the map receives every control-event; call with [] to receive none. */
  setSubscription(socket: WebSocketLike, instanceIds: string[]): void {
    this.subscriptions.set(socket, new Set(instanceIds));
  }
```

In `register`'s `socket.on("close", ...)` handler, add the subscription cleanup alongside the existing `set.delete(socket)`:

```ts
    socket.on("close", () => {
      set.delete(socket);
      this.subscriptions.delete(socket);
      if (set.size === 0) this.byAccount.delete(accountId);
      this.options.logger?.debug("relay.web.disconnected", "web client disconnected", { accountId });
    });
```

- [ ] **Step 5: Scope `control-event`s in `broadcast`**

Replace the whole `broadcast` method with (only the `const scoped` line and the `if (scoped)` block are new; the `readyState`/backpressure/send body is A's, unchanged):

```ts
  broadcast(accountId: string, event: WebServerEvent): void {
    const set = this.byAccount.get(accountId);
    if (!set) return;
    const data = encodeEnvelope(webEventEnvelope(event));
    // control-events are scoped to the socket's instance subscription; a socket with no
    // subscription (absent from the map) receives all. instance-status / notice are
    // account-wide (the global instance list needs them regardless of the active instance).
    const scoped = event.kind === "control-event";
    for (const socket of set) {
      if (scoped) {
        const sub = this.subscriptions.get(socket);
        if (sub && !sub.has(event.instanceId)) continue;
      }
      // One dead/throwing socket must not starve the remaining dashboards.
      if (typeof socket.readyState === "number" && socket.readyState !== WS_OPEN) continue;
      // Backpressure: a stalled client's send buffer grows without bound. Evict it (it
      // reconnects and re-attaches, replaying the bounded scrollback) rather than OOM the hub.
      if (typeof socket.bufferedAmount === "number" && socket.bufferedAmount > BACKPRESSURE_MAX) {
        this.options.logger?.info("relay.web.backpressure_evict", "evicting slow web client", { accountId, bufferedAmount: socket.bufferedAmount });
        try { socket.terminate?.(); } catch { /* already gone */ }
        continue;
      }
      try {
        socket.send(data);
      } catch (err) {
        this.options.logger?.error("relay.web.broadcast_failed", "broadcast send failed", { error: String(err) });
      }
    }
  }
```

(`event.instanceId` is present on all three `WebServerEvent` kinds, so it type-checks on the union without narrowing.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/unit/packages/relay/gateway/web-gateway.test.ts`
Expected: PASS (new subscription tests + the pre-existing broadcast/backpressure tests unchanged).

- [ ] **Step 7: Typecheck**

Run: `npx tsc -p packages/relay/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit** (controller performs git)

```
feat(relay): scope control-event broadcast to per-socket subscription

WebGateway tracks a per-socket instance subscription (absent = all, so
legacy clients are unaffected). broadcast now delivers control-events only
to sockets subscribed to the event's instance; instance-status/notice stay
account-wide. Composes with A's readyState/backpressure guards. Track 4·B.
```

---

### Task 3: Hub inbound — route `subscribe` to `setSubscription`

**Files:**
- Modify: `packages/relay/src/gateway/web-inbound.ts`, `packages/relay/src/server.ts`
- Test: `tests/unit/packages/relay/terminal-web-inbound.test.ts`

**Interfaces:**
- Consumes: Task 1 `parseWebClientMessage` (returns `subscribe`), Task 2 `WebGateway.setSubscription`.
- Produces: `handleWebClientMessage` gains a `socket` parameter and a `webGateway.setSubscription` dep; a `subscribe` frame updates the socket's subscription and is not forwarded to the connector.

- [ ] **Step 1: Update the existing tests + add the subscribe test**

In `tests/unit/packages/relay/terminal-web-inbound.test.ts`:

Extend `deps(...)` to include the new `webGateway` capability, and thread a socket through the calls. Replace the `deps` helper with:

```ts
function deps(owned: boolean) {
  return {
    instances: { getOwned: mock((id: string, acc: string) => (owned && id === "i1" && acc === "a1" ? { id: "i1" } : undefined)) },
    gateway: { sendEvent: mock(() => true) },
    webGateway: { setSubscription: mock(() => {}) },
  };
}
const sock = {} as never; // opaque socket handle; identity is all setSubscription needs
```

Update every existing `handleWebClientMessage(d as never, "a1", <raw>)` call to pass the socket: `handleWebClientMessage(d as never, "a1", sock, <raw>)`. Then add:

```ts
test("a subscribe frame updates the socket subscription and is NOT forwarded to the connector", () => {
  const d = deps(true);
  handleWebClientMessage(d as never, "a1", sock, encodeEnvelope(webClientEnvelope({ kind: "subscribe", instanceIds: ["i1", "i2"] })));
  expect((d.webGateway.setSubscription as ReturnType<typeof mock>).mock.calls[0]).toEqual([sock, ["i1", "i2"]]);
  expect((d.gateway.sendEvent as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/packages/relay/terminal-web-inbound.test.ts`
Expected: FAIL — the signature has no `socket` param yet, and `subscribe` isn't handled (the subscribe test's `setSubscription` is never called; also the updated arity won't match).

- [ ] **Step 3: Add the socket param + subscribe handling in `web-inbound.ts`**

Replace `packages/relay/src/gateway/web-inbound.ts` with:

```ts
import { decodeEnvelope, MSG, parseWebClientMessage } from "@ganglion/xacpx-relay-protocol";
import type { WebSocketLike } from "./web-gateway.js";

export interface WebClientDeps {
  instances: { getOwned(id: string, accountId: string): unknown };
  gateway: { sendEvent(instanceId: string, type: string, payload: unknown): boolean };
  webGateway: { setSubscription(socket: WebSocketLike, instanceIds: string[]): void };
}

/** Decode + route a browser→hub frame. `subscribe` updates this socket's instance
 *  subscription (hub-local); terminal frames are authorized and forwarded to the connector. */
export function handleWebClientMessage(deps: WebClientDeps, accountId: string, socket: WebSocketLike, raw: string): void {
  const decoded = decodeEnvelope(raw);
  if (!decoded.ok) return;
  const msg = parseWebClientMessage(decoded.envelope);
  if (!msg) return;
  // Hub-local, inherently safe (only narrows this socket's own feed) — no ownership gate.
  if (msg.kind === "subscribe") { deps.webGateway.setSubscription(socket, msg.instanceIds); return; }
  if (!deps.instances.getOwned(msg.instanceId, accountId)) return; // ownership gate (connector actions)
  if (msg.kind === "terminal-input") deps.gateway.sendEvent(msg.instanceId, MSG.terminalInput, { terminalId: msg.terminalId, data: msg.data });
  else if (msg.kind === "terminal-resize") deps.gateway.sendEvent(msg.instanceId, MSG.terminalResize, { terminalId: msg.terminalId, cols: msg.cols, rows: msg.rows });
  else if (msg.kind === "terminal-close") deps.gateway.sendEvent(msg.instanceId, MSG.terminalClose, { terminalId: msg.terminalId });
}
```

- [ ] **Step 4: Pass the socket + webGateway dep at the call site in `server.ts`**

In `packages/relay/src/server.ts`, the `/ws` message handler is currently:

```ts
        ws.on("message", (data: unknown) => handleWebClientMessage({ instances: runtime.instances, gateway: runtime.gateway }, account.id, String(data)));
```

Replace it with (adds `webGateway` to deps and passes `ws` as the socket):

```ts
        ws.on("message", (data: unknown) => handleWebClientMessage({ instances: runtime.instances, gateway: runtime.gateway, webGateway: runtime.webGateway }, account.id, ws, String(data)));
```

(`runtime.webGateway` is the `WebGateway` instance registered on the same `ws` a few lines above — same socket identity, so `setSubscription` keys correctly.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/unit/packages/relay/terminal-web-inbound.test.ts`
Expected: PASS (subscribe routes to `setSubscription`; terminal-* still forward; garbage still ignored).

- [ ] **Step 6: Typecheck**

Run: `npx tsc -p packages/relay/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit** (controller performs git)

```
feat(relay): route subscribe frames to WebGateway.setSubscription

handleWebClientMessage gains the socket handle; a subscribe frame updates
that socket's instance subscription (hub-local, no ownership gate — it only
narrows the socket's own feed) and is not forwarded to the connector.
terminal-* frames are unchanged. Track 4·B.
```

---

### Task 4: Web — send `subscribe` on connect/reconnect/instance-switch

**Files:**
- Modify: `packages/relay-web/src/api/events.ts`, `packages/relay-web/src/views/DashboardView.vue`
- Test: `packages/relay-web/src/__tests__/events.test.ts`, `packages/relay-web/src/__tests__/dashboard.test.ts`

**Interfaces:**
- Consumes: Task 1 `subscribe` `WebClientMessage`; the existing `sendWebClientMessage` guarded-send.
- Produces: `sendSubscribe(instanceIds: string[])` in `api/events.ts`; DashboardView calls it on socket-open and active-instance change.

- [ ] **Step 1: Write the failing events.test.ts test**

In `packages/relay-web/src/__tests__/events.test.ts`, extend `FakeWS` with a `send` spy, an OPEN `readyState`, and the `OPEN` static (so the guarded send in `sendSubscribe` passes), then add the test. Update the imports to add `sendSubscribe` from `../api/events` and `decodeEnvelope`, `parseWebClientMessage` from the protocol package.

Extend `FakeWS`:

```ts
class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => this.onclose?.());
  constructor(public url: string) { FakeWS.instances.push(this); }
}
```

Add the test:

```ts
it("sendSubscribe sends an encoded subscribe frame on the open socket", () => {
  connectEvents(() => {});
  const ws = FakeWS.instances[0];
  ws.onopen?.(); // marks activeSocket usable
  sendSubscribe(["iA", "iB"]);
  expect(ws.send).toHaveBeenCalledTimes(1);
  const decoded = decodeEnvelope(ws.send.mock.calls[0][0] as string);
  if (!decoded.ok) throw new Error("decode failed");
  expect(parseWebClientMessage(decoded.envelope)).toEqual({ kind: "subscribe", instanceIds: ["iA", "iB"] });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/relay-web/src/__tests__/events.test.ts`
Expected: FAIL — `sendSubscribe` is not exported.

- [ ] **Step 3: Add `sendSubscribe` to `api/events.ts`**

`sendWebClientMessage` already performs the guarded send for any `WebClientMessage`. Add a thin, named wrapper below it:

```ts
/** Tell the hub which instance(s) this socket is viewing, so it scopes control-events. */
export function sendSubscribe(instanceIds: string[]): void {
  sendWebClientMessage({ kind: "subscribe", instanceIds });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run packages/relay-web/src/__tests__/events.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing dashboard wiring test**

In `packages/relay-web/src/__tests__/dashboard.test.ts`, the `vi.mock("../api/events", ...)` currently exports only `connectEvents`. Extend it to also export a `sendSubscribe` spy, and expose it for assertions:

```ts
const sendSubscribe = vi.fn();
vi.mock("../api/events", () => ({
  connectEvents: (onEvent: (e: unknown) => void, onStatus?: (online: boolean) => void) => {
    captured.onEvent = onEvent;
    captured.onStatus = onStatus;
    return disconnect;
  },
  sendSubscribe,
}));
```

Add `sendSubscribe.mockClear();` in `beforeEach`. Then add the test:

```ts
test("subscribes to the active instance on connect and on instance change", async () => {
  const chat = useChatStore();
  mount(DashboardView, { global: { stubs: { ChatPane: true, InstanceTree: true, "router-link": true } } });
  await flushPromises();

  // On connect, with no instance selected yet, subscribe to the empty set.
  captured.onStatus?.(true);
  expect(sendSubscribe).toHaveBeenLastCalledWith([]);

  // Selecting an instance re-scopes the socket to it.
  chat.select("iA", "backend");
  await flushPromises();
  expect(sendSubscribe).toHaveBeenLastCalledWith(["iA"]);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run packages/relay-web/src/__tests__/dashboard.test.ts`
Expected: FAIL — DashboardView does not call `sendSubscribe` yet.

- [ ] **Step 7: Wire `sendSubscribe` into DashboardView**

In `packages/relay-web/src/views/DashboardView.vue`:

1. Add `sendSubscribe` to the `../api/events` import (which currently imports `connectEvents`):

```ts
import { connectEvents, sendSubscribe } from "../api/events";
```

2. In `onStatus(online)`, after `conn.setOnline(online)`, subscribe on (re)connect. The updated function:

```ts
function onStatus(online: boolean) {
  conn.setOnline(online);
  if (online) {
    sendSubscribe(chat.instanceId ? [chat.instanceId] : []);
    if (everOnline) void reloadSnapshot();
    everOnline = true;
  }
}
```

3. Add a watch (place it near the other `watch(...)` calls, after `chat` is available) that re-subscribes when the active instance changes:

```ts
// Re-scope the hub fan-out whenever the viewed instance changes. The existing
// loadSessions/loadFor watch is the self-heal for state that went stale while unsubscribed.
watch(() => chat.instanceId, (id) => sendSubscribe(id ? [id] : []));
```

(Confirm `watch` is already imported from `vue` in this file — it is used elsewhere in the component. If not, add it to the `vue` import.)

- [ ] **Step 8: Run both relay-web tests to verify they pass**

Run: `npx vitest run packages/relay-web/src/__tests__/events.test.ts packages/relay-web/src/__tests__/dashboard.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck relay-web**

Run: `npx vue-tsc --noEmit -p packages/relay-web/tsconfig.json`
Expected: no errors.

- [ ] **Step 10: Commit** (controller performs git)

```
feat(relay-web): subscribe to the active instance's event stream

Add sendSubscribe(); DashboardView subscribes to the viewed instance on
socket (re)connect and whenever the active instance changes, so the hub
scopes control-events to it. Empty set before an instance is selected.
Track 4·B (web half).
```

---

## Self-Review

**Spec coverage:**
- Protocol `subscribe` message + parser restructure → Task 1. ✔
- Per-socket subscription registry, absent=all, `setSubscription`, close cleanup, scoped `control-event` vs account-wide status/notice, composes with A guards → Task 2. ✔
- Inbound `subscribe` → `setSubscription` (hub-local, no ownership gate), socket threaded from `server.ts`, terminal-* unchanged → Task 3. ✔
- Web `sendSubscribe` on connect/reconnect/instance-change; empty set pre-selection; existing reload-on-switch is the self-heal → Task 4. ✔
- Backward-compat (no-subscribe socket = all) → Task 2 Step 1 first test + the `broadcast` absent-map default. ✔
- No `WebServerEvent` change; connector untouched → no task modifies either. ✔

**Placeholder scan:** none — every code step carries complete code; every run step names the command + expected outcome.

**Type consistency:** `WebClientMessage.subscribe` defined (T1) before use (T3 `web-inbound`, T4 `sendSubscribe`); `WebGateway.setSubscription(socket, instanceIds)` signature identical in T2 (definition), T3 (`WebClientDeps.webGateway`), and its call sites; `handleWebClientMessage(deps, accountId, socket, raw)` new arity applied in both `server.ts` (T3 Step 4) and every test call (T3 Step 1); `sendSubscribe(instanceIds: string[])` identical in `api/events.ts` (T4 Step 3), the events test (T4 Step 1), and the dashboard mock (T4 Step 5); `WebSocketLike` imported into `web-inbound.ts` from `./web-gateway.js` (T3 Step 3).

**Cross-task build:** Task 1 Step 6 rebuilds the protocol dist so Task 3 (`@ganglion/xacpx-relay-protocol` → dist) and Task 4 (relay-web → dist) resolve `subscribe`. The controller must run `bun run build:relay-protocol` after Task 1 before dispatching Task 3.
