import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DesktopRequestError,
  isRetryableDesktopError,
  nextDesktopRequestId,
  requestDesktop,
  sendWebClientMessage,
  settleTerminalRequest,
  _resetTerminalRequestStateForTests,
} from "../api/events";
import { decodeEnvelope, encodeEnvelope, webEventEnvelope } from "@ganglion/xacpx-relay-protocol";

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

describe("desktop control RPC", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWS.instances = [];
    _resetTerminalRequestStateForTests();
    vi.stubGlobal("WebSocket", FakeWS as never);
    vi.stubGlobal("location", { protocol: "http:", host: "x" } as never);
  });

  it("requestDesktop resolves desktop-opened and rejects desktop-request-failed", async () => {
    const { connectEvents } = await import("../api/events");
    connectEvents(() => {});
    const ws = FakeWS.instances[0];
    ws.onopen?.();

    const id = nextDesktopRequestId();
    const pending = requestDesktop({ kind: "desktop-open", requestId: id, instanceId: "i1" });
    pushEvent(ws, {
      kind: "desktop-opened",
      requestId: id,
      instanceId: "i1",
      streamId: "s1",
      wsPath: "/desktop/observe?ticket=t",
      expiresAt: 1_700_000_000_000,
      security: "vnc-auth",
    });
    await expect(pending).resolves.toMatchObject({ streamId: "s1", wsPath: "/desktop/observe?ticket=t" });

    const failId = nextDesktopRequestId();
    const failing = requestDesktop({ kind: "desktop-open", requestId: failId, instanceId: "i1" });
    pushEvent(ws, { kind: "desktop-request-failed", requestId: failId, instanceId: "i1", code: "desktop-busy", message: "busy" });
    await expect(failing).rejects.toMatchObject({ code: "desktop-busy" });
    await expect(failing).rejects.toBeInstanceOf(DesktopRequestError);
  });

  it("duplicate requestIds and offline sockets fail fast", async () => {
    const { connectEvents } = await import("../api/events");
    connectEvents(() => {});
    const ws = FakeWS.instances[0];
    ws.onopen?.();
    const id = nextDesktopRequestId();
    const first = requestDesktop({ kind: "desktop-open", requestId: id, instanceId: "i1" });
    await expect(requestDesktop({ kind: "desktop-open", requestId: id, instanceId: "i1" })).rejects.toMatchObject({
      code: "desktop-protocol-error",
    });
    pushEvent(ws, {
      kind: "desktop-opened",
      requestId: id,
      instanceId: "i1",
      streamId: "s1",
      wsPath: "/desktop/observe?ticket=t",
      expiresAt: 1,
      security: "vnc-auth",
    });
    await first;
    ws.readyState = 3;
    await expect(requestDesktop({ kind: "desktop-open", requestId: nextDesktopRequestId(), instanceId: "i1" })).rejects.toMatchObject({
      code: "events-offline",
    });
  });

  it("settleTerminalRequest routes desktop events without touching terminal pendings", async () => {
    const { connectEvents, requestTerminal, nextTerminalRequestId } = await import("../api/events");
    connectEvents(() => {});
    const ws = FakeWS.instances[0];
    ws.onopen?.();
    const terminalPending = requestTerminal(
      { kind: "terminal-open", requestId: nextTerminalRequestId(), instanceId: "i1", sessionAlias: "s", cols: 80, rows: 24 },
      { expect: "opened" },
    );
    const desktopPending = requestDesktop({ kind: "desktop-open", requestId: nextDesktopRequestId(), instanceId: "i1" });
    // Desktop opened must not settle the terminal request.
    expect(settleTerminalRequest({
      kind: "desktop-opened",
      requestId: "nope",
      instanceId: "i1",
      streamId: "s1",
      wsPath: "/desktop/observe?ticket=t",
      expiresAt: 1,
      security: "vnc-auth",
    })).toBe(false);
    ws.onclose?.();
    await expect(terminalPending).rejects.toMatchObject({ code: "events-offline" });
    await expect(desktopPending).rejects.toMatchObject({ code: "events-offline" });
  });

  it("retryable desktop codes cover offline and prepare timeouts", () => {
    expect(isRetryableDesktopError("desktop-instance-offline")).toBe(true);
    expect(isRetryableDesktopError("desktop-stream-timeout")).toBe(true);
    expect(isRetryableDesktopError("events-offline")).toBe(true);
    expect(isRetryableDesktopError("desktop-busy")).toBe(false);
    expect(isRetryableDesktopError("desktop-auth-unsupported")).toBe(false);
    expect(sendWebClientMessage).toBeDefined();
    expect(decodeEnvelope).toBeDefined();
  });
});
