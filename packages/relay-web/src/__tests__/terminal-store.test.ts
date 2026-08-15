import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { encodeEnvelope, webEventEnvelope, decodeEnvelope, parseWebClientMessage } from "@ganglion/xacpx-relay-protocol";
import {
  connectEvents,
  _resetTerminalRequestStateForTests,
} from "../api/events";
import { useTerminalStore, terminalLocalKey } from "../stores/terminal";

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

function pushEvent(ws: FakeWS, event: Parameters<typeof webEventEnvelope>[0]): void {
  ws.onmessage?.({ data: encodeEnvelope(webEventEnvelope(event)) });
}

function sentMessages(ws: FakeWS): unknown[] {
  return ws.send.mock.calls.map((c) => {
    const decoded = decodeEnvelope(c[0] as string);
    if (!decoded.ok) throw new Error("decode");
    return parseWebClientMessage(decoded.envelope);
  });
}

async function openAttached(
  store: ReturnType<typeof useTerminalStore>,
  key: string,
  ws: FakeWS,
  overrides?: Partial<{ terminalId: string; generation: string; attachmentId: string; role: "controller" | "spectator"; viewerCount: number }>,
) {
  const openPromise = store.openOrResume(key, {
    instanceId: "i1",
    sessionAlias: "demo",
    cols: 80,
    rows: 24,
  });
  const openDecoded = decodeEnvelope(ws.send.mock.calls.at(-1)![0] as string);
  if (!openDecoded.ok) throw new Error("decode");
  const openMsg = parseWebClientMessage(openDecoded.envelope) as { requestId: string };
  pushEvent(ws, {
    kind: "terminal-opened",
    requestId: openMsg.requestId,
    instanceId: "i1",
    terminalId: overrides?.terminalId ?? "t1",
    generation: overrides?.generation ?? "g1",
    attachmentId: overrides?.attachmentId ?? "a1",
    role: overrides?.role ?? "controller",
    viewerCount: overrides?.viewerCount ?? 1,
  });
  return openPromise;
}

describe("terminal store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    FakeWS.instances = [];
    _resetTerminalRequestStateForTests();
    vi.stubGlobal("WebSocket", FakeWS as never);
    vi.stubGlobal("location", { protocol: "http:", host: "x" } as never);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    _resetTerminalRequestStateForTests();
  });

  it("openOrResume opens, streams, and keys by local tab not terminalId", async () => {
    connectEvents((e) => { void useTerminalStore().applyEvent(e); });
    const ws = FakeWS.instances[0];
    ws.onopen?.();

    const store = useTerminalStore();
    const key = terminalLocalKey("i1", "demo");
    const view = await openAttached(store, key, ws, { terminalId: "term-1", attachmentId: "att-1" });
    expect(view.localKey).toBe(key);
    expect(view.terminalId).toBe("term-1");
    expect(view.attachmentId).toBe("att-1");
    expect(view.role).toBe("controller");

    const streamDecoded = decodeEnvelope(ws.send.mock.calls[1][0] as string);
    if (!streamDecoded.ok) throw new Error("decode stream");
    expect(parseWebClientMessage(streamDecoded.envelope)).toMatchObject({
      kind: "terminal-stream-start",
      attachmentId: "att-1",
    });
    expect(store.get(key)?.terminalId).toBe("term-1");
  });

  it("sendInput/sendResize only when controller; role-changed updates both sides", async () => {
    connectEvents((e) => { void useTerminalStore().applyEvent(e); });
    FakeWS.instances[0].onopen?.();
    const store = useTerminalStore();
    const key = terminalLocalKey("i1", "demo");
    await openAttached(store, key, FakeWS.instances[0], { role: "spectator", viewerCount: 2 });

    const before = FakeWS.instances[0].send.mock.calls.length;
    store.sendInput(key, "x");
    store.sendResize(key, 90, 20);
    expect(FakeWS.instances[0].send.mock.calls.length).toBe(before);

    await store.applyEvent({
      kind: "terminal-role-changed",
      instanceId: "i1",
      attachmentId: "a1",
      terminalId: "t1",
      role: "controller",
      viewerCount: 2,
    });
    expect(store.get(key)?.role).toBe("controller");
    store.sendInput(key, "y");
    const added = sentMessages(FakeWS.instances[0]).slice(before);
    expect(added).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "terminal-input", attachmentId: "a1", generation: "g1" }),
      expect.objectContaining({ kind: "terminal-stream-start", attachmentId: "a1" }),
    ]));
  });

  it("takeControl re-issues stream-start when recover is still waiting", async () => {
    connectEvents((e) => { void useTerminalStore().applyEvent(e); });
    const ws = FakeWS.instances[0];
    ws.onopen?.();
    const store = useTerminalStore();
    const key = terminalLocalKey("i1", "demo");
    await openAttached(store, key, ws, { role: "spectator", viewerCount: 2 });
    ws.send.mockClear();

    const takePromise = store.takeControl(key);
    const takeDecoded = decodeEnvelope(ws.send.mock.calls.at(-1)![0] as string);
    if (!takeDecoded.ok) throw new Error("decode");
    const takeMsg = parseWebClientMessage(takeDecoded.envelope) as { requestId: string };
    expect(takeMsg).toMatchObject({ kind: "terminal-take-control", attachmentId: "a1" });
    pushEvent(ws, {
      kind: "terminal-opened",
      requestId: takeMsg.requestId,
      instanceId: "i1",
      terminalId: "t1",
      generation: "g1",
      attachmentId: "a1",
      role: "controller",
      viewerCount: 2,
    });
    await takePromise;
    expect(store.get(key)?.role).toBe("controller");
    expect(sentMessages(ws)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "terminal-stream-start", attachmentId: "a1" }),
    ]));
  });

  it("sendInput while live does not restart the output stream", async () => {
    connectEvents((e) => { void useTerminalStore().applyEvent(e); });
    const ws = FakeWS.instances[0];
    ws.onopen?.();
    const store = useTerminalStore();
    const key = terminalLocalKey("i1", "demo");
    await openAttached(store, key, ws);
    await store.applyEvent({
      kind: "terminal-rebase-start",
      instanceId: "i1",
      attachmentId: "a1",
      generation: "g1",
      epoch: 1,
      nextSequence: 0,
      cols: 80,
      rows: 24,
      alternate: false,
      totalBytes: 0,
      chunkCount: 0,
    });
    await store.applyEvent({
      kind: "terminal-rebase-end",
      instanceId: "i1",
      attachmentId: "a1",
      generation: "g1",
      epoch: 1,
    });
    expect(store.get(key)?.recovery.phase).toBe("live");
    ws.send.mockClear();
    store.sendInput(key, "z");
    expect(sentMessages(ws)).toEqual([
      expect.objectContaining({ kind: "terminal-input", attachmentId: "a1" }),
    ]);
  });

  it("bytes before rebase trigger a resync instead of a silent drop", async () => {
    connectEvents((e) => { void useTerminalStore().applyEvent(e); });
    const ws = FakeWS.instances[0];
    ws.onopen?.();
    const store = useTerminalStore();
    const key = terminalLocalKey("i1", "demo");
    await openAttached(store, key, ws);
    ws.send.mockClear();

    await store.applyEvent({
      kind: "terminal-bytes",
      instanceId: "i1",
      attachmentId: "a1",
      generation: "g1",
      epoch: 1,
      sequence: 0,
      dataBase64: Buffer.from("hi").toString("base64"),
    });
    expect(store.get(key)?.recovery.phase).toBe("resyncing");
    expect(sentMessages(ws)).toEqual([
      expect.objectContaining({ kind: "terminal-resync", attachmentId: "a1", generation: "g1" }),
    ]);
  });

  it("applies rebase then bytes via recovery callbacks; gap triggers one resync", async () => {
    connectEvents((e) => { void useTerminalStore().applyEvent(e); });
    FakeWS.instances[0].onopen?.();
    const store = useTerminalStore();
    const key = terminalLocalKey("i1", "demo");
    const rebases: Uint8Array[] = [];
    const bytes: Uint8Array[] = [];
    store.onRebase((_k, kf) => { rebases.push(kf); });
    store.onBytes((_k, d) => { bytes.push(d); });

    await openAttached(store, key, FakeWS.instances[0]);
    FakeWS.instances[0].send.mockClear();

    await store.applyEvent({
      kind: "terminal-rebase-start",
      instanceId: "i1",
      attachmentId: "a1",
      generation: "g1",
      epoch: 1,
      nextSequence: 0,
      cols: 80,
      rows: 24,
      alternate: false,
      totalBytes: 0,
      chunkCount: 0,
    });
    await store.applyEvent({
      kind: "terminal-rebase-end",
      instanceId: "i1",
      attachmentId: "a1",
      generation: "g1",
      epoch: 1,
    });
    expect(rebases).toHaveLength(1);

    await store.applyEvent({
      kind: "terminal-bytes",
      instanceId: "i1",
      attachmentId: "a1",
      generation: "g1",
      epoch: 1,
      sequence: 0,
      dataBase64: Buffer.from("hi").toString("base64"),
    });
    expect(new TextDecoder().decode(bytes[0])).toBe("hi");

    await store.applyEvent({
      kind: "terminal-bytes",
      instanceId: "i1",
      attachmentId: "a1",
      generation: "g1",
      epoch: 1,
      sequence: 9,
      dataBase64: Buffer.from("gap").toString("base64"),
    });
    expect(store.get(key)?.recovery.phase).toBe("resyncing");
    const resyncDecoded = decodeEnvelope(FakeWS.instances[0].send.mock.calls[0][0] as string);
    if (!resyncDecoded.ok) throw new Error("decode");
    expect(parseWebClientMessage(resyncDecoded.envelope)).toMatchObject({
      kind: "terminal-resync",
      attachmentId: "a1",
      generation: "g1",
    });
  });

  it("terminate waits for ack; offline keeps tab retryable", async () => {
    connectEvents((e) => { void useTerminalStore().applyEvent(e); });
    FakeWS.instances[0].onopen?.();
    const store = useTerminalStore();
    const key = terminalLocalKey("i1", "demo");
    await openAttached(store, key, FakeWS.instances[0]);

    const termPromise = store.terminate(key);
    const termDecoded = decodeEnvelope(FakeWS.instances[0].send.mock.calls.at(-1)![0] as string);
    if (!termDecoded.ok) throw new Error("decode");
    const termMsg = parseWebClientMessage(termDecoded.envelope) as { requestId: string };
    pushEvent(FakeWS.instances[0], {
      kind: "terminal-request-failed",
      requestId: termMsg.requestId,
      instanceId: "i1",
      code: "terminated",
      message: "terminated",
    });
    await expect(termPromise).resolves.toEqual({ status: "terminated" });
    expect(store.get(key)?.active).toBe(false);
    expect(store.get(key)?.recovery.phase).toBe("exited");

    await openAttached(store, key, FakeWS.instances[0], { generation: "g2", attachmentId: "a2" });
    const offlineTerm = store.terminate(key);
    FakeWS.instances[0].onclose?.();
    await expect(offlineTerm).rejects.toMatchObject({ code: "events-offline" });
    expect(store.get(key)?.terminateRetryable).toBe(true);
    expect(store.get(key)?.active).toBe(true);
  });

  it("detach clears attachment without terminate; heartbeat ticks while attached", async () => {
    connectEvents((e) => { void useTerminalStore().applyEvent(e); });
    FakeWS.instances[0].onopen?.();
    const store = useTerminalStore();
    const key = terminalLocalKey("i1", "demo");
    await openAttached(store, key, FakeWS.instances[0]);
    FakeWS.instances[0].send.mockClear();

    await vi.advanceTimersByTimeAsync(10_000);
    const hb = decodeEnvelope(FakeWS.instances[0].send.mock.calls[0][0] as string);
    if (!hb.ok) throw new Error("decode");
    expect(parseWebClientMessage(hb.envelope)).toMatchObject({
      kind: "terminal-heartbeat",
      attachmentId: "a1",
    });

    store.detach(key);
    expect(store.get(key)?.attachmentId).toBeUndefined();
    expect(store.get(key)?.active).toBe(false);
    const detachDecoded = decodeEnvelope(FakeWS.instances[0].send.mock.calls.at(-1)![0] as string);
    if (!detachDecoded.ok) throw new Error("decode");
    expect(parseWebClientMessage(detachDecoded.envelope)).toMatchObject({
      kind: "terminal-detach",
      attachmentId: "a1",
    });
  });

  it("terminal-recovery-failed sets lastErrorCode and requests resync", async () => {
    connectEvents((e) => { void useTerminalStore().applyEvent(e); });
    FakeWS.instances[0].onopen?.();
    const store = useTerminalStore();
    const key = terminalLocalKey("i1", "demo");
    await openAttached(store, key, FakeWS.instances[0]);
    FakeWS.instances[0].send.mockClear();

    await store.applyEvent({
      kind: "terminal-recovery-failed",
      instanceId: "i1",
      attachmentId: "a1",
      generation: "g1",
      code: "terminal-recovery-too-large",
      message: "queue overflow",
    });
    expect(store.get(key)?.lastErrorCode).toBe("terminal-recovery-too-large");
    expect(store.get(key)?.recovery.phase).toBe("resyncing");
    const resyncDecoded = decodeEnvelope(FakeWS.instances[0].send.mock.calls[0][0] as string);
    if (!resyncDecoded.ok) throw new Error("decode");
    expect(parseWebClientMessage(resyncDecoded.envelope)).toMatchObject({
      kind: "terminal-resync",
      attachmentId: "a1",
      generation: "g1",
    });
  });

  it("fatal recovery failure does not resync and keeps a visible error code", async () => {
    connectEvents((e) => { void useTerminalStore().applyEvent(e); });
    FakeWS.instances[0].onopen?.();
    const store = useTerminalStore();
    const key = terminalLocalKey("i1", "demo");
    await openAttached(store, key, FakeWS.instances[0]);
    FakeWS.instances[0].send.mockClear();

    await store.applyEvent({
      kind: "terminal-recovery-failed",
      instanceId: "i1",
      attachmentId: "a1",
      generation: "g1",
      code: "terminal-rmux-unavailable",
      message: "terminal-rmux-unavailable",
    });
    expect(store.get(key)?.lastErrorCode).toBe("terminal-rmux-unavailable");
    expect(store.get(key)?.recovery.phase).toBe("waiting");
    expect(store.get(key)?.role).toBe("controller");
    expect(FakeWS.instances[0].send.mock.calls.length).toBe(0);
  });
});
