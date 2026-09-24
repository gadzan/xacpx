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

  it("close() drops the in-memory session and notifies the hub", async () => {
    const store = useDesktopStore();
    await store.open("i1", {});
    const { sendWebClientMessage } = await import("../api/events");
    store.close("i1");
    expect(sendWebClientMessage).toHaveBeenCalledWith({ kind: "desktop-close", instanceId: "i1", streamId: "s1" });
    expect(store.sessions.has("i1")).toBe(false);
  });
});
