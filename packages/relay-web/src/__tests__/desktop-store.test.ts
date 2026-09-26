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
});
