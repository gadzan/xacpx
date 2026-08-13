import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectEvents,
  nextTerminalRequestId,
  requestTerminal,
  sendSubscribe,
  sendWebClientMessage,
  setEventsReconnectHandler,
  settleTerminalRequest,
  TerminalRequestError,
  _resetTerminalRequestStateForTests,
} from "../api/events";
import {
  decodeEnvelope,
  encodeEnvelope,
  parseWebClientMessage,
  TERMINAL_RPC_TIMEOUT_MS,
  webEventEnvelope,
} from "@ganglion/xacpx-relay-protocol";

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

describe("connectEvents", () => {
  beforeEach(() => {
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

  it("does not reconnect after the disposer runs during backoff", () => {
    const dispose = connectEvents(() => {});
    FakeWS.instances[0].onclose?.();
    dispose();
    vi.runOnlyPendingTimers();
    expect(FakeWS.instances).toHaveLength(1);
  });

  it("reports status across drop and reopen", () => {
    const status: boolean[] = [];
    connectEvents(() => {}, (o) => status.push(o));
    FakeWS.instances[0].onopen?.();
    FakeWS.instances[0].onclose?.();
    vi.runOnlyPendingTimers();
    FakeWS.instances[1]?.onopen?.();
    expect(status).toEqual([true, false, true]);
  });

  it("sendSubscribe sends an encoded subscribe frame on the open socket", () => {
    connectEvents(() => {});
    const ws = FakeWS.instances[0];
    ws.onopen?.();
    sendSubscribe(["iA", "iB"]);
    expect(ws.send).toHaveBeenCalledTimes(1);
    const decoded = decodeEnvelope(ws.send.mock.calls[0][0] as string);
    if (!decoded.ok) throw new Error("decode failed");
    expect(parseWebClientMessage(decoded.envelope)).toEqual({ kind: "subscribe", instanceIds: ["iA", "iB"] });
  });

  it("requestTerminal resolves opened and rejects on failure / timeout / close", async () => {
    connectEvents(() => {});
    const ws = FakeWS.instances[0];
    ws.onopen?.();

    const id = nextTerminalRequestId();
    const pending = requestTerminal(
      { kind: "terminal-open", requestId: id, instanceId: "i1", sessionAlias: "s", cols: 80, rows: 24 },
      { expect: "opened" },
    );
    pushEvent(ws, {
      kind: "terminal-opened",
      requestId: id,
      instanceId: "i1",
      terminalId: "t1",
      generation: "g1",
      attachmentId: "a1",
      role: "controller",
      viewerCount: 1,
    });
    await expect(pending).resolves.toMatchObject({ terminalId: "t1", attachmentId: "a1", role: "controller" });

    const failId = nextTerminalRequestId();
    const failing = requestTerminal(
      { kind: "terminal-open", requestId: failId, instanceId: "i1", sessionAlias: "s", cols: 80, rows: 24 },
      { expect: "opened" },
    );
    pushEvent(ws, {
      kind: "terminal-request-failed",
      requestId: failId,
      instanceId: "i1",
      code: "terminal-disabled",
      message: "off",
    });
    await expect(failing).rejects.toMatchObject({ code: "terminal-disabled" });

    const timeoutId = nextTerminalRequestId();
    const timingOut = requestTerminal(
      { kind: "terminal-resync", requestId: timeoutId, instanceId: "i1", attachmentId: "a1", generation: "g1" },
      { expect: "ack", timeoutMs: 1000 },
    );
    const timeoutAssertion = expect(timingOut).rejects.toMatchObject({ code: "terminal-timeout" });
    await vi.advanceTimersByTimeAsync(1000);
    await timeoutAssertion;

    const closeId = nextTerminalRequestId();
    const closing = requestTerminal(
      { kind: "terminal-terminate", requestId: closeId, instanceId: "i1", terminalId: "t1", generation: "g1" },
      { expect: "ack" },
    );
    ws.onclose?.();
    await expect(closing).rejects.toBeInstanceOf(TerminalRequestError);
  });

  it("treats ok/terminated/cleanup-pending request-failed codes as ack success", async () => {
    connectEvents(() => {});
    FakeWS.instances[0].onopen?.();
    const id = nextTerminalRequestId();
    const pending = requestTerminal(
      { kind: "terminal-terminate", requestId: id, instanceId: "i1", terminalId: "t1", generation: "g1" },
      { expect: "ack" },
    );
    pushEvent(FakeWS.instances[0], {
      kind: "terminal-request-failed",
      requestId: id,
      instanceId: "i1",
      code: "terminated",
      message: "terminated",
    });
    await expect(pending).resolves.toEqual({
      code: "terminated",
      message: "terminated",
      instanceId: "i1",
      requestId: id,
    });
  });

  it("rejects pending on close and invokes reconnect handler after reopen", async () => {
    const onReconnect = vi.fn();
    setEventsReconnectHandler(onReconnect);
    connectEvents(() => {});
    FakeWS.instances[0].onopen?.();

    const id = nextTerminalRequestId();
    const pending = requestTerminal(
      { kind: "terminal-open", requestId: id, instanceId: "i1", sessionAlias: "s", cols: 80, rows: 24 },
      { expect: "opened" },
    );
    FakeWS.instances[0].onclose?.();
    await expect(pending).rejects.toMatchObject({ code: "events-offline" });

    await vi.runOnlyPendingTimersAsync();
    FakeWS.instances[1]?.onopen?.();
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("settleTerminalRequest is idempotent for unknown requestIds", () => {
    expect(settleTerminalRequest({
      kind: "terminal-opened",
      requestId: "missing",
      instanceId: "i1",
      terminalId: "t",
      generation: "g",
      attachmentId: "a",
      role: "controller",
      viewerCount: 1,
    })).toBe(false);
  });

  it("default timeout still resolves terminal-opened after 18s", async () => {
    expect(TERMINAL_RPC_TIMEOUT_MS).toBeGreaterThan(18_000);
    connectEvents(() => {});
    const ws = FakeWS.instances[0];
    ws.onopen?.();

    const id = nextTerminalRequestId();
    const pending = requestTerminal(
      { kind: "terminal-open", requestId: id, instanceId: "i1", sessionAlias: "s", cols: 80, rows: 24 },
      { expect: "opened" },
    );
    await vi.advanceTimersByTimeAsync(18_000);
    pushEvent(ws, {
      kind: "terminal-opened",
      requestId: id,
      instanceId: "i1",
      terminalId: "t1",
      generation: "g1",
      attachmentId: "a1",
      role: "controller",
      viewerCount: 1,
    });
    await expect(pending).resolves.toMatchObject({ terminalId: "t1", attachmentId: "a1" });
  });

  it("sendWebClientMessage is a no-op without an open socket", () => {
    expect(() => sendWebClientMessage({ kind: "subscribe", instanceIds: [] })).not.toThrow();
  });

  it("requestTerminal before the socket is open is events-offline, not instance-offline", async () => {
    connectEvents(() => {});
    FakeWS.instances[0].readyState = 0;
    const pending = requestTerminal(
      { kind: "terminal-open", requestId: nextTerminalRequestId(), instanceId: "i1", sessionAlias: "s", cols: 80, rows: 24 },
      { expect: "opened" },
    );
    await expect(pending).rejects.toMatchObject({ code: "events-offline" });
  });
});
