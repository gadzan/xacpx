import { expect, test } from "bun:test";

import { MSG } from "../../../../packages/relay-protocol/src/index";
import { RelayChannel } from "../../../../packages/channel-relay/src/channel";
import type { RelayCredential } from "../../../../packages/channel-relay/src/credential-store";

class MemoryCredentialStore {
  constructor(private value: RelayCredential | null = null) {}
  load() { return this.value; }
  save(credential: RelayCredential) { this.value = credential; }
  clear() { this.value = null; }
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

function makeStartInput(overrides: Record<string, unknown> = {}) {
  const subscribed: unknown[] = [];
  return {
    input: {
      agent: { chat: async () => ({ text: "" }) },
      abortSignal: new AbortController().signal,
      quota: {} as never,
      logger: { info: async () => {}, error: async () => {}, debug: async () => {} },
      control: {
        events: { subscribe: (listener: unknown) => { subscribed.push(listener); return () => {}; } },
        listSessions: () => [],
      },
      coreVersion: "0.11.0",
      ...overrides,
    },
    subscribed,
  };
}

test("isLoggedIn true with credential or pairing token; logout clears credential", async () => {
  const withCredential = new RelayChannel({ url: "ws://h:1" }, {
    credentialStore: new MemoryCredentialStore({ instanceId: "i", credential: "c", relayUrl: "ws://h:1" }),
  });
  expect(withCredential.isLoggedIn()).toBe(true);
  await withCredential.logout();
  expect(withCredential.isLoggedIn()).toBe(false);

  const withToken = new RelayChannel({ url: "ws://h:1", pairingToken: "t" }, {
    credentialStore: new MemoryCredentialStore(),
  });
  expect(withToken.isLoggedIn()).toBe(true);
});

test("start requires ChannelStartInput.control and wires client + event subscription", async () => {
  const clientCalls: string[] = [];
  const fakeClient = {
    start: () => clientCalls.push("start"),
    stop: () => clientCalls.push("stop"),
    sendEvent: (type: string) => clientCalls.push(`event:${type}`),
  };
  const channel = new RelayChannel({ url: "ws://h:1", pairingToken: "t" }, {
    credentialStore: new MemoryCredentialStore(),
    createClient: () => fakeClient as never,
  });
  const controller = new AbortController();
  const { input, subscribed } = makeStartInput({ abortSignal: controller.signal });
  const startPromise = channel.start(input as never);
  await waitUntil(() => clientCalls.includes("start"), "client.start");
  expect(subscribed).toHaveLength(1);
  controller.abort();
  await startPromise; // start resolves on abort
  expect(clientCalls).toContain("stop");

  const noControl = new RelayChannel({ url: "ws://h:1", pairingToken: "t" }, { credentialStore: new MemoryCredentialStore() });
  const bad = makeStartInput({ control: undefined });
  await expect(noControl.start(bad.input as never)).rejects.toThrow(/control/);
});

test("onReady pushes an instance state sync; dead aliases are filtered now and pruned only on a confirmed flush", async () => {
  const events: Array<{ type: string; payload: unknown }> = [];
  const flushes: Array<((error?: Error) => void) | undefined> = [];
  const fakeClient = {
    start: () => {},
    stop: () => {},
    sendEvent: (type: string, payload: unknown, onFlush?: (error?: Error) => void) => {
      events.push({ type, payload });
      flushes.push(onFlush);
    },
    isReady: () => true,
  };
  let capturedOptions: { onReady?: () => void } = {};
  const channel = new RelayChannel({ url: "ws://h:1", pairingToken: "t" }, {
    credentialStore: new MemoryCredentialStore(),
    createClient: (options) => { capturedOptions = options; return fakeClient as never; },
  });
  const controller = new AbortController();
  const { input, subscribed } = makeStartInput({ abortSignal: controller.signal });
  (input.control as Record<string, unknown>).listSessions = () => [
    { alias: "backend", agent: "codex", workspace: "w", transportSession: "t", running: true, archived: false },
  ];
  const startPromise = channel.start(input as never);
  await waitUntil(() => subscribed.length > 0, "event subscription");
  const fireEvent = (event: unknown) => (subscribed[0] as (event: unknown) => void)(event);
  const lastSync = () => (events.findLast((e) => e.type === MSG.instanceStateSync)!.payload as { turns: Array<{ sessionAlias: string }> });

  // Simulate a daemon turn the daemon emitted before the hub link (re)authed.
  fireEvent({ type: "turn-started", chatKey: "relay:acc", sessionAlias: "backend", prompt: "hi" });
  events.length = 0;
  flushes.length = 0; // the forward above pushed an undefined; keep only the sync's
  capturedOptions.onReady!();
  expect(lastSync().turns).toHaveLength(1);
  flushes[0]!(); // confirmed flush → prune (backend is live, stays)

  // A session disappears while offline; the mirror still holds its turn.
  (input.control as Record<string, unknown>).listSessions = () => [];
  fireEvent({ type: "turn-started", chatKey: "relay:acc", sessionAlias: "frontend" });
  events.length = 0;
  capturedOptions.onReady!();
  // buildStateSync filters the dead alias out of the payload immediately…
  expect(lastSync().turns).toEqual([]);
  // …but the flush FAILS → pruneStateMirror must NOT run (the mirror keeps the
  // turn, so a later sync with a corrected session list can still recover it).
  flushes.at(-1)!(new Error("half-open socket"));

  (input.control as Record<string, unknown>).listSessions = () => [
    { alias: "backend", agent: "codex", workspace: "w", transportSession: "t", running: true, archived: false },
    { alias: "frontend", agent: "codex", workspace: "w", transportSession: "t", running: true, archived: false },
  ];
  events.length = 0;
  capturedOptions.onReady!();
  expect(lastSync().turns.map((t) => t.sessionAlias).sort()).toEqual(["backend", "frontend"]);

  controller.abort();
  await startPromise;
});

test("finishedOffline entries clear only on the hub's recovery ack, not on a flush", async () => {
  const events: Array<{ type: string; payload: unknown; onFlush?: (error?: Error) => void }> = [];
  let capturedOptions: { onReady?: () => void; onEvent?: (envelope: unknown) => void } = {};
  const fakeClient = {
    start: () => {},
    stop: () => {},
    sendEvent: (type: string, payload: unknown, onFlush?: (error?: Error) => void) => {
      events.push({ type, payload, onFlush });
    },
    isReady: () => true,
  };
  const channel = new RelayChannel({ url: "ws://h:1", pairingToken: "t" }, {
    credentialStore: new MemoryCredentialStore(),
    createClient: (options) => { capturedOptions = options; return fakeClient as never; },
  });
  const controller = new AbortController();
  const { input, subscribed } = makeStartInput({ abortSignal: controller.signal });
  (input.control as Record<string, unknown>).listSessions = () => [
    { alias: "backend", agent: "codex", workspace: "w", transportSession: "t", running: true, archived: false },
  ];
  const startPromise = channel.start(input as never);
  await waitUntil(() => subscribed.length > 0, "event subscription");
  const fireEvent = (event: unknown) => (subscribed[0] as (event: unknown) => void)(event);
  const lastSync = () => (events.findLast((e) => e.type === MSG.instanceStateSync)!.payload as { finishedOffline: unknown[] });
  const lastForwardedEvent = () => (events.findLast((e) => e.type === MSG.instanceEvent)!.payload as { event: { recoveryId?: string } }).event;

  // A turn finishes → the mirror FIFO holds it AND the live frame carries its
  // recoveryId. The hub will persist it and ack the id.
  fireEvent({ type: "turn-started", chatKey: "relay:acc", sessionAlias: "backend", prompt: "hi" });
  fireEvent({ type: "turn-output", chatKey: "relay:acc", sessionAlias: "backend", chunk: "ans" });
  fireEvent({ type: "turn-finished", chatKey: "relay:acc", sessionAlias: "backend", ok: true, text: "ans" });
  const recoveryId = lastForwardedEvent().recoveryId!;
  expect(recoveryId).toBeString();

  // A sync rides the reconnect; the entry is still in the FIFO.
  capturedOptions.onReady!();
  expect(lastSync().finishedOffline).toHaveLength(1);

  // Even a CONFIRMED sync flush must not clear the FIFO — it only prunes dead
  // aliases; the finished entry's session is live, so it stays until the hub acks.
  const syncFlush = events.findLast((e) => e.type === MSG.instanceStateSync)!.onFlush!;
  syncFlush();
  capturedOptions.onReady!();
  expect(lastSync().finishedOffline).toHaveLength(1);

  // The hub acks the recovery id AFTER its SQLite commit → the FIFO clears.
  capturedOptions.onEvent!({
    protocolVersion: 1, kind: "event", type: MSG.instanceRecoveryAck, payload: { recoveryIds: [recoveryId] },
  });
  capturedOptions.onReady!();
  expect(lastSync().finishedOffline).toEqual([]);

  controller.abort();
  await startPromise;
});

test("sendScheduledMessage runs the fired task as a control turn (not a side notice)", async () => {
  const calls: unknown[] = [];
  const fakeClient = { start: () => {}, stop: () => {}, sendEvent: () => {} };
  const channel = new RelayChannel({ url: "ws://h:1", pairingToken: "t" }, {
    credentialStore: new MemoryCredentialStore(),
    createClient: () => fakeClient as never,
  });
  const controller = new AbortController();
  const { input, subscribed } = makeStartInput({ abortSignal: controller.signal });
  (input.control as Record<string, unknown>).runScheduledTurn = async (arg: unknown) => { calls.push(arg); return { ok: true }; };
  const startPromise = channel.start(input as never);
  await waitUntil(() => subscribed.length > 0, "event subscription");

  await channel.sendScheduledMessage({
    chatKey: "relay:acc", sessionAlias: "backend", taskId: "ab12", executeAt: "2026-06-16T09:00:00.000Z",
    noticeText: "fired", promptText: "summarize commits",
  } as never);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ chatKey: "relay:acc", sessionAlias: "backend", taskId: "ab12", promptText: "summarize commits", executeAt: "2026-06-16T09:00:00.000Z" });

  controller.abort();
  await startPromise;
});

test("sendScheduledMessage throws when the turn fails, so the scheduler records a failed run", async () => {
  const fakeClient = { start: () => {}, stop: () => {}, sendEvent: () => {} };
  const channel = new RelayChannel({ url: "ws://h:1", pairingToken: "t" }, {
    credentialStore: new MemoryCredentialStore(),
    createClient: () => fakeClient as never,
  });
  const controller = new AbortController();
  const { input, subscribed } = makeStartInput({ abortSignal: controller.signal });
  (input.control as Record<string, unknown>).runScheduledTurn = async () => ({ ok: false, errorMessage: "turn-already-running" });
  const startPromise = channel.start(input as never);
  await waitUntil(() => subscribed.length > 0, "event subscription");

  await expect(channel.sendScheduledMessage({
    chatKey: "relay:acc", sessionAlias: "backend", taskId: "ab12", executeAt: "2026-06-16T09:00:00.000Z",
    noticeText: "fired", promptText: "x",
  } as never)).rejects.toThrow(/turn-already-running/);

  controller.abort();
  await startPromise;
});

test("notify methods forward as instance notices through the client", async () => {
  const events: Array<{ type: string; payload: unknown }> = [];
  const fakeClient = { start: () => {}, stop: () => {}, sendEvent: (type: string, payload: unknown) => events.push({ type, payload }) };
  const channel = new RelayChannel({ url: "ws://h:1", pairingToken: "t" }, {
    credentialStore: new MemoryCredentialStore(),
    createClient: () => fakeClient as never,
  });
  const controller = new AbortController();
  const { input, subscribed } = makeStartInput({ abortSignal: controller.signal });
  const startPromise = channel.start(input as never);
  await waitUntil(() => subscribed.length > 0, "event subscription");
  await channel.notifyTaskCompletion({ taskId: "t1", summary: "done", resultText: "" } as never);
  await channel.notifyTaskProgress({ taskId: "t1" } as never, "50%");
  await channel.sendCoordinatorMessage({ coordinatorSession: "c", chatKey: "k", text: "hello" });
  expect(events.map((e) => (e.payload as { kind: string }).kind)).toEqual([
    "task-completion", "task-progress", "coordinator-message",
  ]);
  controller.abort();
  await startPromise;
});
