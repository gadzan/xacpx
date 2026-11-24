import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectEvents,
  nextTerminalRequestId,
  requestDesktop,
  requestTerminal,
  sendSubscribe,
  sendWebClientMessage,
  setEventsReconnectHandler,
  onEventsReconnect,
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

  it("an unexpected terminal-opened rejects a live ack request immediately", async () => {
    // Regression: the desktop refactor made settleTerminalRequest ignore a
    // terminal-opened whose pending entry expected an "ack", so a hub that
    // answers take-control/resync/terminate with the wrong frame left the
    // caller hanging until the RPC deadline instead of surfacing the protocol
    // error at once.
    connectEvents(() => {});
    const ws = FakeWS.instances[0];
    ws.onopen?.();

    const id = nextTerminalRequestId();
    const pending = requestTerminal(
      { kind: "terminal-take-control", requestId: id, instanceId: "i1", attachmentId: "a1", generation: "g1" },
      { expect: "ack", timeoutMs: 60_000 },
    );
    const settled = expect(pending).rejects.toMatchObject({ code: "terminal-protocol-error" });
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
    await settled;
    // The entry is gone: a second delivery settles nothing.
    expect(settleTerminalRequest({
      kind: "terminal-opened",
      requestId: id,
      instanceId: "i1",
      terminalId: "t1",
      generation: "g1",
      attachmentId: "a1",
      role: "controller",
      viewerCount: 1,
    })).toBe(false);
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

  it("reconnect supports several subscribers, not just the first registrar", async () => {
    // Terminal and desktop both re-open on /ws recovery. A single-slot handler
    // meant whichever store registered second silently displaced the first, so
    // the desktop panel stayed dead until a manual Reconnect.
    _resetTerminalRequestStateForTests();
    const first = vi.fn();
    const second = vi.fn();
    setEventsReconnectHandler(first);
    onEventsReconnect(second);

    connectEvents(() => {});
    FakeWS.instances[0].onopen?.();
    FakeWS.instances[0].onclose?.();
    await vi.runOnlyPendingTimersAsync();
    FakeWS.instances[1]?.onopen?.();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
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

  it("a disposed socket's late close does not kill its replacement", async () => {
    // Two connectEvents() instances can overlap: `A.close()` is called while the
    // close handshake is still in flight, the replacement view opens B, and only
    // THEN does A's `onclose` land. A's handler must not touch state that now
    // belongs to B — not the module-global `activeSocket`, and not the pending
    // RPCs B has in flight. B stays physically OPEN, so nothing fires a
    // reconnect and the corruption is permanent.
    //
    // This uses the REAL requestDesktop against a FakeWS, so the promise is
    // genuinely registered in the module-level pending map: `rejectAllPending`
    // has something real to destroy, which is what makes this mutation-sensitive.
    const lateCloses: Array<() => void> = [];
    const deferClose = (ws: FakeWS) => {
      const real = ws.onclose;
      if (!real) throw new Error("no onclose installed");
      ws.onclose = () => { lateCloses.push(real); };
    };

    // Mount A and dispose it, but hold its close event: the handshake has not
    // finished, so A's `onclose` has not run.
    const disposeA = connectEvents(() => {});
    deferClose(FakeWS.instances[0]!);
    FakeWS.instances[0]!.onopen?.();

    disposeA();

    // Navigate back: B opens and becomes the module-global owner.
    const disposeB = connectEvents(() => {});
    deferClose(FakeWS.instances[1]!);
    FakeWS.instances[1]!.onopen?.();

    // A fresh prepare on B, in flight. It can only be ended by
    // `rejectAllPending`, which is exactly what A's stale close would call.
    const pending = requestDesktop(
      { kind: "desktop-open", requestId: "dr-stale-close", instanceId: "i1" },
      { timeoutMs: 30_000 },
    );
    const settled: string[] = [];
    void pending.then(
      () => settled.push("resolved"),
      (err: unknown) => settled.push("rejected:" + (err as { code?: string }).code),
    );

    // NOW A's late close lands. With the fence on the module-global owner, A's
    // handler bails and B is untouched. Without it, A nulls `activeSocket` and
    // rejects B's in-flight prepare as events-offline.
    expect(lateCloses.length).toBeGreaterThan(0);
    lateCloses[0]!();
    await vi.advanceTimersByTimeAsync(1);

    expect(settled).toEqual([]);

    // The control plane is still considered live, and B's RPC completes normally
    // once its reply arrives.
    pushEvent(FakeWS.instances[1]!, {
      kind: "desktop-opened",
      requestId: "dr-stale-close",
      instanceId: "i1",
      streamId: "s-stale",
      wsPath: "/desktop/observe?ticket=t",
      expiresAt: 1,
      security: "vnc-auth",
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual(["resolved"]);
    disposeB();
  });
});
