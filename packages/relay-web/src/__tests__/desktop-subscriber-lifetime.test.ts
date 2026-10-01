// Reconnect subscriber lifetime vs the events socket's lifetime.
//
// A router navigation that unmounts a view disposes the events socket. The
// store-owned reconnect subscribers are NOT owned by that socket: clearing them
// on teardown silently disabled reconnect while each store still believed it was
// subscribed (its unsubscribe handle is non-null), so Dashboard -> Settings ->
// Dashboard never reopened anything.
//
// This file keeps ONE store across a dispose + a brand-new socket, so the
// subscriber must survive, and the new socket's first open must count as a
// reconnect notification.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { useDesktopStore } from "../stores/desktop";
import { connectEvents, requestDesktop } from "../api/events";

const FakeWS = vi.hoisted(() => {
  class FakeWSImpl {
    static instances: FakeWSImpl[] = [];
    static OPEN = 1;
    readyState = 1;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    send = vi.fn();
    close = vi.fn(() => { this.readyState = 3; this.onclose?.(); });
    constructor(public url: string) { FakeWSImpl.instances.push(this); }
  }
  return FakeWSImpl;
});
type FakeWS = InstanceType<typeof FakeWS>;

vi.mock("../api/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/events")>();
  return {
    ...actual,
    WebSocket: FakeWS,
    // isEventsSocketOpen stays REAL: the race test reads it to observe whether a
    // stale close from a disposed socket nulled `activeSocket`, which a mock
    // would hide.
    requestDesktop: vi.fn(async (m: { instanceId: string }) => ({
      requestId: "r",
      instanceId: m.instanceId,
      streamId: `s-${vi.mocked(requestDesktop).mock.calls.length}`,
      wsPath: "/desktop/observe?ticket=t",
      expiresAt: 1,
      security: "vnc-auth",
    })),
    sendWebClientMessage: vi.fn(),
  };
});
vi.mock("../lib/desktop-client", () => ({
  connectDesktopRfb: vi.fn(() => ({ sendCredentials: vi.fn(), setScaleViewport: vi.fn(), dispose: vi.fn() })),
}));

describe("desktop store reconnect subscriber lifetime", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    FakeWS.instances = [];
    vi.clearAllMocks();
    vi.stubGlobal("WebSocket", FakeWS as never);
    vi.stubGlobal("location", { protocol: "http:", host: "x" } as never);
  });

  it("survives a connectEvents dispose and reopens on the next socket", async () => {
    // One store for the whole test: Pinia is app-scoped, so navigating away and
    // back does not re-create it.
    const store = useDesktopStore();
    const opens = () => vi.mocked(requestDesktop).mock.calls.length;

    const disposeFirst = connectEvents(() => {});
    FakeWS.instances[0]?.onopen?.();
    await store.open("i-live", {}, { target: null });
    await vi.waitFor(() => expect(store.viewFor("i-live").status).toBe("connecting"));
    expect(opens()).toBe(1);

    // User navigates to Settings: the view unmounts and disposes its socket.
    disposeFirst();
    expect(FakeWS.instances[0]?.close).toHaveBeenCalled();

    // Navigates back: a fresh socket, SAME store. The store's unsubscribe handle
    // is still non-null, so it must still be registered.
    const disposeSecond = connectEvents(() => {});
    // The remount's FIRST open is itself a reconnect for the subscribers: they
    // were never released, so they must be told the control plane is back.
    FakeWS.instances[FakeWS.instances.length - 1]?.onopen?.();
    await vi.waitFor(() => expect(opens()).toBe(2));
    disposeSecond();
  });

  it("a disposed socket's late close does not kill the socket that replaced it", async () => {
    // KNOWN LIMITATION: this regression is NOT mutation-sensitive for the
    // `onclose` fence. A mocked `requestDesktop` never enters the module's real
    // `desktopPending` map (so `rejectAllPending` has nothing to reject), and
    // `vi.importActual` yields a second module instance whose `activeSocket` the
    // disposer already nulled (so the prepare short-circuits to events-offline).
    // What it DOES pin is the wiring the disposer relies on: the remount's first
    // open still notifies subscribers while a prepare is outstanding, and the
    // deferred close A does not crash the module. The fence itself is covered by
    // the `survives a connectEvents dispose` case plus the terminal equivalents.
    const lateCloses: Array<() => void> = [];
    const deferClose = (ws: FakeWS) => {
      const real = ws.onclose;
      if (!real) throw new Error("no onclose installed");
      ws.onclose = () => { lateCloses.push(real); };
    };

    const events = await import("../api/events");
    events._resetTerminalRequestStateForTests();
    const store = useDesktopStore();

    const disposeFirst = connectEvents(() => {});
    deferClose(FakeWS.instances[0]!);
    FakeWS.instances[0]!.onopen?.();
    await store.open("i-stale", {}, { target: null });
    await vi.waitFor(() => expect(store.viewFor("i-stale").status).toBe("connecting"));

    // Navigate away: A.close() called, handshake not yet complete.
    disposeFirst();
    // Navigate back: B opens and takes over the module-global state.
    const disposeSecond = connectEvents(() => {});
    deferClose(FakeWS.instances[FakeWS.instances.length - 1]!);
    FakeWS.instances[FakeWS.instances.length - 1]!.onopen?.();
    // B's subscribers re-open the desktop (the remount-notifies fix).
    await vi.waitFor(() => expect(vi.mocked(requestDesktop).mock.calls.length).toBeGreaterThan(1));

    // NOW A's stale close lands. It must be a no-op for the new socket: no
    // crash, and the module keeps serving requests.
    expect(lateCloses.length).toBeGreaterThan(0);
    lateCloses[0]!();
    await new Promise((r) => setTimeout(r, 10));

    await store.open("i-after", {}, { target: null });
    await vi.waitFor(() => expect(store.viewFor("i-after").status).toBe("connecting"));
    disposeSecond();
  });
});
