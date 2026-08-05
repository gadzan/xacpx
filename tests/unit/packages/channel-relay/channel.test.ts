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

test("isLoggedIn true with credential or pairing token; logout clears credential", () => {
  const withCredential = new RelayChannel({ url: "ws://h:1" }, {
    credentialStore: new MemoryCredentialStore({ instanceId: "i", credential: "c", relayUrl: "ws://h:1" }),
  });
  expect(withCredential.isLoggedIn()).toBe(true);
  withCredential.logout();
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
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(clientCalls).toContain("start");
  expect(subscribed).toHaveLength(1);
  controller.abort();
  await startPromise; // start resolves on abort
  expect(clientCalls).toContain("stop");

  const noControl = new RelayChannel({ url: "ws://h:1", pairingToken: "t" }, { credentialStore: new MemoryCredentialStore() });
  const bad = makeStartInput({ control: undefined });
  await expect(noControl.start(bad.input as never)).rejects.toThrow(/control/);
});

test("onReady pushes an instance state sync with the mirrored running turn", async () => {
  const events: Array<{ type: string; payload: unknown }> = [];
  const fakeClient = {
    start: () => {},
    stop: () => {},
    sendEvent: (type: string, payload: unknown) => events.push({ type, payload }),
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
  await new Promise((resolve) => setTimeout(resolve, 10));

  // Simulate a daemon turn the daemon emitted before the hub link (re)authed.
  (subscribed[0] as (event: unknown) => void)({ type: "turn-started", chatKey: "relay:acc", sessionAlias: "backend", prompt: "hi" });
  events.length = 0; // the forwarded instanceEvent itself is not what we assert here
  capturedOptions.onReady!();

  const syncs = events.filter((e) => e.type === MSG.instanceStateSync);
  expect(syncs).toHaveLength(1);
  const payload = syncs[0]!.payload as { turns: Array<{ sessionAlias: string; prompt?: string }>; finishedOffline: unknown[] };
  expect(payload.turns).toHaveLength(1);
  expect(payload.turns[0]).toMatchObject({ sessionAlias: "backend", prompt: "hi" });
  expect(payload.finishedOffline).toEqual([]);

  // Sessions removed while offline are pruned from the sync.
  (input.control as Record<string, unknown>).listSessions = () => [];
  events.length = 0;
  capturedOptions.onReady!();
  const prunedSync = (events.find((e) => e.type === MSG.instanceStateSync)!).payload as { turns: unknown[] };
  expect(prunedSync.turns).toEqual([]);

  controller.abort();
  await startPromise;
});

test("finishedOffline entries clear only on the hub's recovery ack, not on a flush", async () => {
  const events: Array<{ type: string; payload: unknown }> = [];
  let capturedOptions: { onReady?: () => void; onEvent?: (envelope: unknown) => void } = {};
  const fakeClient = {
    start: () => {},
    stop: () => {},
    sendEvent: (type: string, payload: unknown, _onFlush?: (error?: Error) => void) => {
      events.push({ type, payload });
      // The channel must NOT confirm on flush: an ack-callback-less send is a
      // deliberate statement that delivery is confirmed by the hub's ack event.
      expect(_onFlush).toBeUndefined();
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
  await new Promise((resolve) => setTimeout(resolve, 10));
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

  // No ack yet → the FIFO keeps the entry across a (hypothetical) flush/re-sync.
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
  const { input } = makeStartInput({ abortSignal: controller.signal });
  (input.control as Record<string, unknown>).runScheduledTurn = async (arg: unknown) => { calls.push(arg); return { ok: true }; };
  const startPromise = channel.start(input as never);
  await new Promise((resolve) => setTimeout(resolve, 10));

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
  const { input } = makeStartInput({ abortSignal: controller.signal });
  (input.control as Record<string, unknown>).runScheduledTurn = async () => ({ ok: false, errorMessage: "turn-already-running" });
  const startPromise = channel.start(input as never);
  await new Promise((resolve) => setTimeout(resolve, 10));

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
  const { input } = makeStartInput({ abortSignal: controller.signal });
  const startPromise = channel.start(input as never);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await channel.notifyTaskCompletion({ taskId: "t1", summary: "done", resultText: "" } as never);
  await channel.notifyTaskProgress({ taskId: "t1" } as never, "50%");
  await channel.sendCoordinatorMessage({ coordinatorSession: "c", chatKey: "k", text: "hello" });
  expect(events.map((e) => (e.payload as { kind: string }).kind)).toEqual([
    "task-completion", "task-progress", "coordinator-message",
  ]);
  controller.abort();
  await startPromise;
});
