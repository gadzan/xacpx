import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { encodeEnvelope, webEventEnvelope } from "@ganglion/xacpx-relay-protocol";

vi.mock("../api/client", () => ({ api: { rpc: vi.fn(async () => ({ terminalId: "t1" })) } }));

import { api } from "../api/client";
import {
  connectEvents,
  nextTerminalRequestId,
  sendWebClientMessage,
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

function lastClientMsg(ws: FakeWS): unknown {
  const raw = ws.send.mock.calls.at(-1)?.[0] as string;
  const { decodeEnvelope, parseWebClientMessage } = require("@ganglion/xacpx-relay-protocol") as typeof import("@ganglion/xacpx-relay-protocol");
  const decoded = decodeEnvelope(raw);
  if (!decoded.ok) throw new Error("bad envelope");
  return parseWebClientMessage(decoded.envelope);
}

describe("terminal store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    FakeWS.instances = [];
    _resetTerminalRequestStateForTests();
    vi.stubGlobal("WebSocket", FakeWS as never);
    vi.stubGlobal("location", { protocol: "http:", host: "x" } as never);
    vi.mocked(api.rpc).mockReset();
    vi.mocked(api.rpc).mockResolvedValue({ terminalId: "t1" } as never);
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
    const openPromise = store.openOrResume(key, {
      instanceId: "i1",
      sessionAlias: "demo",
      cols: 80,
      rows: 24,
    });

    // Find the open requestId from the wire.
    const { decodeEnvelope, parseWebClientMessage } = await import("@ganglion/xacpx-relay-protocol");
    const openRaw = ws.send.mock.calls[0][0] as string;
    const openDecoded = decodeEnvelope(openRaw);
    if (!openDecoded.ok) throw new Error("decode");
    const openMsg = parseWebClientMessage(openDecoded.envelope) as { requestId: string };
    pushEvent(ws, {
      kind: "terminal-opened",
      requestId: openMsg.requestId,
      instanceId: "i1",
      terminalId: "term-1",
      generation: "gen-1",
      attachmentId: "att-1",
      role: "controller",
      viewerCount: 1,
    });

    const view = await openPromise;
    expect(view.localKey).toBe(key);
    expect(view.terminalId).toBe("term-1");
    expect(view.attachmentId).toBe("att-1");
    expect(view.role).toBe("controller");

    const streamMsg = parseWebClientMessage(
      (decodeEnvelope(ws.send.mock.calls[1][0] as string) as { ok: true; envelope: unknown }).envelope as never,
    );
    // Fix: decode properly
    const streamDecoded = decodeEnvelope(ws.send.mock.calls[1][0] as string);
    if (!streamDecoded.ok) throw new Error("decode stream");
    expect(parseWebClientMessage(streamDecoded.envelope)).toMatchObject({
      kind: "terminal-stream-start",
      attachmentId: "att-1",
    });

    // Same local key, different terminalId still addresses the same tab entry.
    expect(store.get(key)?.terminalId).toBe("term-1");
  });

  it("sendInput/sendResize only when controller; role-changed updates both sides", async () => {
    connectEvents((e) => { void useTerminalStore().applyEvent(e); });
    FakeWS.instances[0].onopen?.();
    const store = useTerminalStore();
    const key = terminalLocalKey("i1", "demo");

    const openPromise = store.openOrResume(key, {
      instanceId: "i1",
      sessionAlias: "demo",
      cols: 80,
      rows: 24,
    });
    const { decodeEnvelope, parseWebClientMessage } = await import("@ganglion/xacpx-relay-protocol");
    const openDecoded = decodeEnvelope(FakeWS.instances[0].send.mock.calls[0][0] as string);
    if (!openDecoded.ok) throw new Error("decode");
    const openMsg = parseWebClientMessage(openDecoded.envelope) as { requestId: string };
    pushEvent(FakeWS.instances[0], {
      kind: "terminal-opened",
      requestId: openMsg.requestId,
      instanceId: "i1",
      terminalId: "t1",
      generation: "g1",
      attachmentId: "a1",
      role: "spectator",
      viewerCount: 2,
    });
    await openPromise;

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
    const inputDecoded = decodeEnvelope(FakeWS.instances[0].send.mock.calls.at(-1)![0] as string);
    if (!inputDecoded.ok) throw new Error("decode");
    expect(parseWebClientMessage(inputDecoded.envelope)).toMatchObject({
      kind: "terminal-input",
      attachmentId: "a1",
      generation: "g1",
    });
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

    const openPromise = store.openOrResume(key, {
      instanceId: "i1",
      sessionAlias: "demo",
      cols: 80,
      rows: 24,
    });
    const { decodeEnvelope, parseWebClientMessage } = await import("@ganglion/xacpx-relay-protocol");
    const openDecoded = decodeEnvelope(FakeWS.instances[0].send.mock.calls[0][0] as string);
    if (!openDecoded.ok) throw new Error("decode");
    const openMsg = parseWebClientMessage(openDecoded.envelope) as { requestId: string };
    pushEvent(FakeWS.instances[0], {
      kind: "terminal-opened",
      requestId: openMsg.requestId,
      instanceId: "i1",
      terminalId: "t1",
      generation: "g1",
      attachmentId: "a1",
      role: "controller",
      viewerCount: 1,
    });
    await openPromise;
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
    const openPromise = store.openOrResume(key, {
      instanceId: "i1",
      sessionAlias: "demo",
      cols: 80,
      rows: 24,
    });
    const { decodeEnvelope, parseWebClientMessage } = await import("@ganglion/xacpx-relay-protocol");
    const openDecoded = decodeEnvelope(FakeWS.instances[0].send.mock.calls[0][0] as string);
    if (!openDecoded.ok) throw new Error("decode");
    const openMsg = parseWebClientMessage(openDecoded.envelope) as { requestId: string };
    pushEvent(FakeWS.instances[0], {
      kind: "terminal-opened",
      requestId: openMsg.requestId,
      instanceId: "i1",
      terminalId: "t1",
      generation: "g1",
      attachmentId: "a1",
      role: "controller",
      viewerCount: 1,
    });
    await openPromise;

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

    // Re-open then simulate offline terminate.
    const open2 = store.openOrResume(key, {
      instanceId: "i1",
      sessionAlias: "demo",
      cols: 80,
      rows: 24,
    });
    const open2Decoded = decodeEnvelope(FakeWS.instances[0].send.mock.calls.at(-1)![0] as string);
    if (!open2Decoded.ok) throw new Error("decode");
    const open2Msg = parseWebClientMessage(open2Decoded.envelope) as { requestId: string };
    pushEvent(FakeWS.instances[0], {
      kind: "terminal-opened",
      requestId: open2Msg.requestId,
      instanceId: "i1",
      terminalId: "t1",
      generation: "g2",
      attachmentId: "a2",
      role: "controller",
      viewerCount: 1,
    });
    await open2;

    const offlineTerm = store.terminate(key);
    FakeWS.instances[0].onclose?.();
    await expect(offlineTerm).rejects.toMatchObject({ code: "instance-offline" });
    expect(store.get(key)?.terminateRetryable).toBe(true);
    expect(store.get(key)?.active).toBe(true);
  });

  it("detach clears attachment without terminate; heartbeat ticks while attached", async () => {
    connectEvents((e) => { void useTerminalStore().applyEvent(e); });
    FakeWS.instances[0].onopen?.();
    const store = useTerminalStore();
    const key = terminalLocalKey("i1", "demo");
    const openPromise = store.openOrResume(key, {
      instanceId: "i1",
      sessionAlias: "demo",
      cols: 80,
      rows: 24,
    });
    const { decodeEnvelope, parseWebClientMessage } = await import("@ganglion/xacpx-relay-protocol");
    const openDecoded = decodeEnvelope(FakeWS.instances[0].send.mock.calls[0][0] as string);
    if (!openDecoded.ok) throw new Error("decode");
    const openMsg = parseWebClientMessage(openDecoded.envelope) as { requestId: string };
    pushEvent(FakeWS.instances[0], {
      kind: "terminal-opened",
      requestId: openMsg.requestId,
      instanceId: "i1",
      terminalId: "t1",
      generation: "g1",
      attachmentId: "a1",
      role: "controller",
      viewerCount: 1,
    });
    await openPromise;
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

  // Legacy surface still used by TerminalTab until Task 23.
  it("legacy create/attach/input/resize/close still work", async () => {
    const { sendWebClientMessage: send } = await import("../api/events");
    const spy = vi.spyOn(await import("../api/events"), "sendWebClientMessage");
    // Use real send through store after connecting.
    connectEvents(() => {});
    FakeWS.instances[0].onopen?.();
    const s = useTerminalStore();
    const id = await s.create("i1", "demo", 100, 30);
    expect(id).toBe("t1");
    expect(api.rpc).toHaveBeenCalledWith("i1", "control.terminal.create", { sessionAlias: "demo", cols: 100, rows: 30 });

    vi.mocked(api.rpc).mockResolvedValueOnce({ ok: true, buffer: "scroll", lastSeq: 7 } as never);
    await expect(s.attach("i1", "term-x")).resolves.toEqual({ ok: true, buffer: "scroll", lastSeq: 7 });

    s.input("i1", "t1", "ls\n");
    s.resize("i1", "t1", 90, 20);
    s.close("i1", "t1");
    const { decodeEnvelope, parseWebClientMessage } = await import("@ganglion/xacpx-relay-protocol");
    const kinds = FakeWS.instances[0].send.mock.calls.map((c) => {
      const d = decodeEnvelope(c[0] as string);
      if (!d.ok) return null;
      return (parseWebClientMessage(d.envelope) as { kind: string }).kind;
    });
    expect(kinds).toContain("terminal-input");
    expect(kinds).toContain("terminal-resize");
    expect(kinds).toContain("terminal-close");
    void send; void spy;
  });

  it("legacy applyEvent forwards terminal-output to onOutput subscribers", async () => {
    const s = useTerminalStore();
    const out = vi.fn();
    const exit = vi.fn();
    s.onOutput(out);
    s.onExit(exit);
    await s.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "terminal-output", terminalId: "t1", seq: 0, data: "hi" } } as never);
    await s.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "terminal-exit", terminalId: "t1", code: 0 } } as never);
    expect(out).toHaveBeenCalledWith("t1", "hi", 0);
    expect(exit).toHaveBeenCalledWith("t1", 0);
  });
});
