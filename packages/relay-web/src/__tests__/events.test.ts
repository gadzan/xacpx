import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectEvents, sendSubscribe } from "../api/events";
import { decodeEnvelope, parseWebClientMessage } from "@ganglion/xacpx-relay-protocol";

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

describe("connectEvents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWS.instances = [];
    vi.stubGlobal("WebSocket", FakeWS as never);
    vi.stubGlobal("location", { protocol: "http:", host: "x" } as never);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("does not reconnect after the disposer runs during backoff", () => {
    const dispose = connectEvents(() => {});
    FakeWS.instances[0].onclose?.();   // drop → schedules reconnect timer
    dispose();                          // teardown during backoff window
    vi.runOnlyPendingTimers();          // any pending reconnect fires
    expect(FakeWS.instances).toHaveLength(1); // NO second socket created
  });

  it("reports status across drop and reopen", () => {
    const status: boolean[] = [];
    connectEvents(() => {}, (o) => status.push(o));
    FakeWS.instances[0].onopen?.();
    FakeWS.instances[0].onclose?.();
    vi.runOnlyPendingTimers();          // reconnect fires → new socket
    FakeWS.instances[1]?.onopen?.();
    expect(status).toEqual([true, false, true]);
  });

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
});
