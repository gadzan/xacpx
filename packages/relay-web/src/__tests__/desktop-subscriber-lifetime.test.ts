// Subscriber lifetime vs socket lifetime.
//
// A router navigation that unmounts a view disposes the events socket. The
// store-owned reconnect subscriber is NOT owned by that socket: clearing it on
// teardown silently disabled reconnect while the store still believed it was
// subscribed (its unsubscribe handle is non-null), so a later /ws drop left the
// desktop panel dead until a manual Reconnect.
//
// This test keeps ONE store across a dispose + a brand-new socket, so the
// subscriber must survive.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { useDesktopStore } from "../stores/desktop";
import { connectEvents, requestDesktop, sendWebClientMessage } from "../api/events";

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
    isEventsSocketOpen: vi.fn(() => true),
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

    // First mount: Dashboard opens a desktop and subscribes.
    const disposeFirst = connectEvents(() => {});
    FakeWS.instances[0]?.onopen?.();
    await store.open("i-live", {}, { target: null });
    await vi.waitFor(() => expect(store.viewFor("i-live").status).toBe("connecting"));
    const opens = () => vi.mocked(requestDesktop).mock.calls.length;
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
});
