import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { supportsDesktop } from "../stores/instances";
import { useDesktopStore } from "../stores/desktop";
import { DesktopRequestError } from "../api/events";
import { RELAY_CAPABILITIES } from "@ganglion/xacpx-relay-protocol";


vi.mock("../api/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/events")>();
  return {
    ...actual,
    // requestDesktop rejects early ("events-offline") when no live socket is
    // recorded; the tests drive open() synchronously, so record one.
    isEventsSocketOpen: vi.fn(() => true),
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

async function lastConnectInput(): Promise<{ target?: HTMLElement; fit?: boolean } | undefined> {
  const { connectDesktopRfb } = await import("../lib/desktop-client");
  const calls = (connectDesktopRfb as unknown as { mock: { calls: Array<[{ target?: HTMLElement; fit?: boolean }]> } }).mock.calls;
  return calls[calls.length - 1]?.[0];
}

describe("desktop store", () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    // clearAllMocks() also wipes implementations, so re-seed the default
    // requestDesktop AFTER clearing — otherwise the next open() awaits
    // `undefined` and times out.
    vi.clearAllMocks();
    const { requestDesktop } = await import("../api/events");
    (requestDesktop as unknown as { mockImplementation: (fn: () => Promise<unknown>) => void })
      .mockImplementation(async () => ({
        requestId: "r1",
        instanceId: "i1",
        streamId: "s1",
        wsPath: "/desktop/observe?ticket=t",
        expiresAt: 1,
        security: "vnc-auth",
      }));
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

  it("a superseded attempt cannot delete the newer attempt's session row", async () => {
    // Generation race: A prepare pending → close A → B opened. The hub still
    // holds A's single-viewer slot, so B fails fast with desktop-busy and writes
    // its own error row. A then succeeds; its abandoned-cleanup must NOT delete
    // B's row, otherwise DesktopTab's lazy viewFor() turns a clear Busy/Error
    // state back into a bare idle row with no reconnect affordance.
    const store = useDesktopStore();
    const { requestDesktop, sendWebClientMessage } = await import("../api/events");
    let releaseA!: (value: unknown) => void;
    let rejectB!: (err: unknown) => void;
    let call = 0;
    (requestDesktop as unknown as { mockImplementation: (fn: () => Promise<unknown>) => void })
      .mockImplementation(async () => {
        call += 1;
        return call === 1
          ? new Promise((resolve) => { releaseA = resolve; })
          : new Promise((_resolve, reject) => { rejectB = reject; });
      });
    const openA = store.open("i1", {});
    store.close("i1"); // aborts A and bumps the generation
    const openB = store.open("i1", {});
    // The hub still holds A's single-viewer slot, so B fails fast with
    // desktop-busy before A's prepare ever settles.
    let thrownB: unknown;
    expect(rejectB).toBeDefined();
    rejectB(new DesktopRequestError("desktop-busy", "instance already has a desktop stream"));
    await openB.catch((err: unknown) => { thrownB = err; });
    expect(thrownB).toBeInstanceOf(DesktopRequestError);
    expect((thrownB as DesktopRequestError).code).toBe("desktop-busy");
    // B's own failure row is set by its catch branch.
    expect(store.viewFor("i1").status).toBe("error");
    const bRow = store.viewFor("i1");
    // Now A succeeds late: its stream must be closed, but B's row survives.
    releaseA({ requestId: "rA", instanceId: "i1", streamId: "sA", wsPath: "/desktop/observe?ticket=tA", expiresAt: 1, security: "vnc-auth" });
    await openA;
    expect(sendWebClientMessage).toHaveBeenCalledWith({ kind: "desktop-close", instanceId: "i1", streamId: "sA" });
    expect(store.viewFor("i1")).toEqual(bRow);
    expect(store.viewFor("i1").status).toBe("error");
    expect(store.viewFor("i1").lastErrorCode).toBeTruthy();
  });

  it("stale connection hooks cannot overwrite a newer attempt's row", async () => {
    // After a supersede the old RFB connection is disposed, but its queued hooks
    // must be inert: onConnect/onDisconnect/onSecurityFailure all patch the row,
    // which would resurrect a closed panel.
    const store = useDesktopStore();
    const { connectDesktopRfb } = await import("../lib/desktop-client");
    const hookSets: Array<Record<string, (...args: unknown[]) => void>> = [];
    (connectDesktopRfb as unknown as {
      mockImplementation: (fn: (input: { hooks?: Record<string, (...args: unknown[]) => void> }) => unknown) => void;
    }).mockImplementation((input) => {
      hookSets.push(input.hooks ?? {});
      return { sendCredentials: vi.fn(), setScaleViewport: vi.fn(), dispose: vi.fn() };
    });
    // First open completes fully.
    await store.open("i1", {});
    expect(hookSets.length).toBe(1);
    const first = hookSets[0];
    expect(first).toBeDefined();
    first?.onConnect?.();
    expect(store.viewFor("i1").status).toBe("open");
    // close + reopen: the second attempt owns the row now.
    store.close("i1");
    expect(store.sessions.has("i1")).toBe(false);
    await store.open("i1", {});
    expect(hookSets.length).toBe(2);
    // Firing the FIRST connection's (stale) hooks must not touch the row.
    first?.onConnect?.();
    first?.onDisconnect?.({ clean: true, reason: "stale" });
    first?.onSecurityFailure?.("stale failure");
    expect(store.viewFor("i1").status).not.toBe("closed");
    expect(store.viewFor("i1").lastErrorCode).not.toBe("desktop-auth-unsupported");
  });

  it("applies the session's fit state to the RFB client", async () => {
    // Regression: `scaleViewport: true` was passed in the noVNC constructor
    // options bag, which noVNC ignores (scaleViewport is a post-construction
    // writable property defaulting to false). The desired fit must reach the
    // connection instead.
    const store = useDesktopStore();
    await store.open("i1", {});
    expect(await lastConnectInput()).toMatchObject({ fit: true });
    store.setFit("i1", false);
    expect(store.viewFor("i1").fit).toBe(false);
  });
});
