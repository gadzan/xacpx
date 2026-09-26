import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { supportsDesktop } from "../stores/instances";
import { useDesktopStore } from "../stores/desktop";
import { RELAY_CAPABILITIES } from "@ganglion/xacpx-relay-protocol";

vi.mock("../api/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/events")>();
  return {
    ...actual,
    requestDesktop: vi.fn(async () => ({
      requestId: "r1",
      instanceId: "i1",
      streamId: "s1",
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

async function lastConnectTarget(): Promise<HTMLElement | undefined> {
  const { connectDesktopRfb } = await import("../lib/desktop-client");
  const calls = (connectDesktopRfb as unknown as { mock: { calls: Array<[{ target?: HTMLElement }]> } }).mock.calls;
  return calls[calls.length - 1]?.[0]?.target;
}

describe("desktop store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("gates on the desktop capability and online state", () => {
    expect(supportsDesktop({ online: true, capabilities: [RELAY_CAPABILITIES.desktopRfbV1] })).toBe(true);
    expect(supportsDesktop({ online: false, capabilities: [RELAY_CAPABILITIES.desktopRfbV1] })).toBe(false);
    expect(supportsDesktop({ online: true, capabilities: [] })).toBe(false);
    expect(supportsDesktop({ online: true })).toBe(false);
  });

  it("open() requests a stream without persisting tickets or passwords", async () => {
    const store = useDesktopStore();
    await store.open("i1", {});
    const view = store.viewFor("i1");
    expect(view.streamId).toBe("s1");
    expect(view.status).toBe("connecting");
    expect(localStorage.getItem("xacpx.desktop.ticket")).toBeNull();
    expect(sessionStorage.getItem("xacpx.desktop.ticket")).toBeNull();
    expect(JSON.stringify(view)).not.toContain("t-browser");
  });

  it("open() forwards the mounted host element as the noVNC target", async () => {
    const store = useDesktopStore();
    const target = document.createElement("div");
    target.dataset.test = "desktop-host";
    await store.open("i1", {}, { target });
    expect(await lastConnectTarget()).toBe(target);
  });

  it("open() without a target still opens (client falls back, tab stays responsible)", async () => {
    const store = useDesktopStore();
    await store.open("i1", {});
    expect(await lastConnectTarget()).toBeUndefined();
  });

  it("close() drops the in-memory session and notifies the hub", async () => {
    const store = useDesktopStore();
    await store.open("i1", {});
    const { sendWebClientMessage } = await import("../api/events");
    store.close("i1");
    expect(sendWebClientMessage).toHaveBeenCalledWith({ kind: "desktop-close", instanceId: "i1", streamId: "s1" });
    expect(store.sessions.has("i1")).toBe(false);
  });

  it("close() during prepare abandons the pending open and closes the stream", async () => {
    const store = useDesktopStore();
    let release!: (value: unknown) => void;
    const { requestDesktop, sendWebClientMessage } = await import("../api/events");
    (requestDesktop as unknown as { mockImplementationOnce: (fn: () => Promise<unknown>) => void })
      .mockImplementationOnce(async () => new Promise((resolve) => { release = resolve; }));
    const pending = store.open("i1", {});
    // Panel disappears before `desktop-opened` ever lands.
    store.close("i1");
    release({
      requestId: "r1",
      instanceId: "i1",
      streamId: "s9",
      wsPath: "/desktop/observe?ticket=t9",
      expiresAt: 1,
      security: "vnc-auth",
    });
    await pending;
    expect(sendWebClientMessage).toHaveBeenCalledWith({ kind: "desktop-close", instanceId: "i1", streamId: "s9" });
    // The late resolve must not resurrect the session or bind noVNC to a dead host.
    expect(await lastConnectTarget()).toBeUndefined();
    expect(store.sessions.has("i1")).toBe(false);
  });

  it("A/B interleaved prepares keep the newer open abortable across the older finally", async () => {
    // Regression (generation race): A opens → close() aborts A → B opens
    // (map now holds B's controller) → A's prepare settles and its `finally`
    // must NOT delete B's entry, otherwise the next close() cannot abort B and
    // B's late resolve would resurrect the panel and open a noVNC stream.
    const store = useDesktopStore();
    const { requestDesktop, sendWebClientMessage } = await import("../api/events");
    let releaseA!: (value: unknown) => void;
    let releaseB!: (value: unknown) => void;
    let aCalls = 0;
    (requestDesktop as unknown as { mockImplementation: (fn: () => Promise<unknown>) => void })
      .mockImplementation(async () => {
        aCalls += 1;
        return aCalls === 1
          ? new Promise((resolve) => { releaseA = resolve; })
          : new Promise((resolve) => { releaseB = resolve; });
      });
    const openA = store.open("i1", {});
    store.close("i1");            // aborts A
    const openB = store.open("i1", {}); // B supersedes A in the pending map
    // A settles AFTER B started: its finally must leave B's controller intact.
    releaseA({ requestId: "rA", instanceId: "i1", streamId: "sA", wsPath: "/desktop/observe?ticket=tA", expiresAt: 1, security: "vnc-auth" });
    await openA;
    // Second close() must still be able to abort B's in-flight prepare.
    store.close("i1");
    releaseB({ requestId: "rB", instanceId: "i1", streamId: "sB", wsPath: "/desktop/observe?ticket=tB", expiresAt: 1, security: "vnc-auth" });
    await openB;
    // Both abandoned prepares sent their close; no noVNC connection was created
    // and no session row survives for a panel that was closed twice.
    expect(sendWebClientMessage).toHaveBeenCalledWith({ kind: "desktop-close", instanceId: "i1", streamId: "sA" });
    expect(sendWebClientMessage).toHaveBeenCalledWith({ kind: "desktop-close", instanceId: "i1", streamId: "sB" });
    const { connectDesktopRfb } = await import("../lib/desktop-client");
    expect(connectDesktopRfb).not.toHaveBeenCalled();
    expect(store.sessions.has("i1")).toBe(false);
  });

  it("an aborted prepare that ends in an error does not recreate the session row", async () => {
    // The catch branch must not patch(): close() already deleted the row, and a
    // patch would resurrect an idle/error row for a panel that is gone.
    const store = useDesktopStore();
    const { requestDesktop } = await import("../api/events");
    let rejectA!: (err: unknown) => void;
    (requestDesktop as unknown as { mockImplementationOnce: (fn: () => Promise<unknown>) => void })
      .mockImplementationOnce(async () => new Promise((_resolve, reject) => { rejectA = reject; }));
    const openA = store.open("i1", {});
    store.close("i1");
    rejectA(new Error("hub closed the socket"));
    await expect(openA).rejects.toThrow("hub closed the socket");
    expect(store.sessions.has("i1")).toBe(false);
  });
});
