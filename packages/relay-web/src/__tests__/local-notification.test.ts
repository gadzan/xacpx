import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import {
  showLocalTurnNotification,
  formatNotificationBody,
  isSessionActiveInAnyTab,
  claimNotificationSlot,
  recordTabFocus,
  initTabFocusTracker,
  setNotificationClickHandler,
  triggerNotificationClick,
  LOCAL_NOTIFICATION_BODY_CAP,
} from "../lib/local-notification";
import { DESKTOP_NOTIFICATIONS_ENABLED_KEY } from "../lib/web-push";
import { useChatStore } from "../stores/chat";
import { useInstancesStore } from "../stores/instances";

describe("local-notification helper", () => {
  let showNotificationMock: Mock;
  let notificationConstructorMock: Mock;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(DESKTOP_NOTIFICATIONS_ENABLED_KEY, "true");
    showNotificationMock = vi.fn().mockResolvedValue(undefined);
    notificationConstructorMock = vi.fn();

    vi.stubGlobal("Notification", Object.assign(
      function (this: unknown, title: string, options?: NotificationOptions) {
        notificationConstructorMock(title, options);
        return {
          title,
          ...options,
          close: vi.fn(),
          onclick: null,
        };
      },
      { permission: "granted" }
    ));

    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue({
          active: true,
          showNotification: showNotificationMock,
        }),
        ready: Promise.resolve({
          active: true,
          showNotification: showNotificationMock,
        }),
      },
    });
  });

  afterEach(() => {
    localStorage.clear();
    setNotificationClickHandler(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("suppresses notifications when desktop notifications are explicitly disabled in settings", async () => {
    localStorage.setItem(DESKTOP_NOTIFICATIONS_ENABLED_KEY, "false");

    await showLocalTurnNotification({
      instanceId: "i1",
      instanceName: "MacBook",
      sessionAlias: "backend",
      ok: true,
      text: "Done",
    });

    expect(showNotificationMock).not.toHaveBeenCalled();
    expect(notificationConstructorMock).not.toHaveBeenCalled();
  });

  it("does nothing when Notification permission is denied or default", async () => {
    (Notification as unknown as { permission: string }).permission = "denied";
    await showLocalTurnNotification({
      instanceId: "i1",
      instanceName: "MacBook",
      sessionAlias: "backend",
      ok: true,
      text: "done",
    });
    expect(showNotificationMock).not.toHaveBeenCalled();
    expect(notificationConstructorMock).not.toHaveBeenCalled();

    (Notification as unknown as { permission: string }).permission = "default";
    await showLocalTurnNotification({
      instanceId: "i1",
      instanceName: "MacBook",
      sessionAlias: "backend",
      ok: true,
      text: "done",
    });
    expect(showNotificationMock).not.toHaveBeenCalled();
    expect(notificationConstructorMock).not.toHaveBeenCalled();
  });

  it("sends success notification via Service Worker with per-session tag", async () => {
    await showLocalTurnNotification({
      instanceId: "inst-123",
      instanceName: "Workstation",
      sessionAlias: "frontend",
      ok: true,
      text: "All 50 unit tests passed successfully.",
    });

    expect(showNotificationMock).toHaveBeenCalledTimes(1);
    const [title, options] = showNotificationMock.mock.calls[0] as [string, NotificationOptions];
    expect(title).toBe("Workstation · frontend");
    expect(options.body).toBe("All 50 unit tests passed successfully.");
    expect(options.tag).toBe("xacpx-turn:inst-123:frontend");
    expect(options.icon).toBe("/pwa-192x192.png");
    expect(options.data).toEqual({
      instanceId: "inst-123",
      sessionAlias: "frontend",
      url: "/",
    });
  });

  it("falls back to localized 'Task completed' when success text is empty", () => {
    expect(formatNotificationBody(true, "")).toBe("Task completed");
    expect(formatNotificationBody(true, "   ")).toBe("Task completed");
  });

  it("formats error notifications with 'Task failed: <msg>'", () => {
    expect(formatNotificationBody(false, undefined, "Connection timeout")).toBe("Task failed: Connection timeout");
    expect(formatNotificationBody(false, undefined, "")).toBe("Task failed: Unknown error");
  });

  it("caps notification body to 200 characters", () => {
    const longText = "a".repeat(300);
    const formatted = formatNotificationBody(true, longText);
    expect(formatted.length).toBe(LOCAL_NOTIFICATION_BODY_CAP);
    expect(formatted).toBe("a".repeat(200));
  });

  it("falls back to window Notification when service worker is unavailable or hanging", async () => {
    const { promise: hangingReady } = Promise.withResolvers<ServiceWorkerRegistration>();
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue(null),
        ready: hangingReady,
      },
    });

    await showLocalTurnNotification({
      instanceId: "inst-123",
      instanceName: "Workstation",
      sessionAlias: "frontend",
      ok: true,
      text: "Fallback test",
    });

    expect(showNotificationMock).not.toHaveBeenCalled();
    expect(notificationConstructorMock).toHaveBeenCalledTimes(1);
    expect(notificationConstructorMock).toHaveBeenCalledWith(
      "Workstation · frontend",
      expect.objectContaining({
        body: "Fallback test",
        tag: "xacpx-turn:inst-123:frontend",
      }),
    );
  });

  it("triggers registered click handler on notification click", () => {
    const clickHandler = vi.fn();
    setNotificationClickHandler(clickHandler);

    triggerNotificationClick("inst-99", "api-session");

    expect(clickHandler).toHaveBeenCalledTimes(1);
    expect(clickHandler).toHaveBeenCalledWith("inst-99", "api-session");
  });
});

describe("cross-tab active session suppression and slot deduplication", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(document, "hidden", { value: false, writable: true, configurable: true });
    Object.defineProperty(document, "hasFocus", { value: () => true, writable: true, configurable: true });
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("suppresses notification when session is active in another tab via focus heartbeat", () => {
    localStorage.setItem(
      "xrelay.activeFocus",
      JSON.stringify({ tabId: "tab-other", instanceId: "i1", sessionAlias: "backend", at: Date.now() - 1000 }),
    );

    const isActive = isSessionActiveInAnyTab("i1", "backend", false);
    expect(isActive).toBe(true);
  });

  it("does not suppress notification if the other tab focus heartbeat is expired (>3.5s ago)", () => {
    localStorage.setItem(
      "xrelay.activeFocus",
      JSON.stringify({ tabId: "tab-other", instanceId: "i1", sessionAlias: "backend", at: Date.now() - 5000 }),
    );

    const isActive = isSessionActiveInAnyTab("i1", "backend", false);
    expect(isActive).toBe(false);
  });

  it("deduplicates notifications for the same notificationId, but allows different notificationIds in same session", () => {
    // Turn A with notificationId notif-1
    expect(claimNotificationSlot("notif-1", 3000)).toBe(true);
    expect(claimNotificationSlot("notif-1", 3000)).toBe(false);

    // Turn B in the same session with notificationId notif-2 (both must be notified)
    expect(claimNotificationSlot("notif-2", 3000)).toBe(true);
  });

  it("records tab focus state to localStorage when window is active", () => {
    recordTabFocus("i1", "backend");
    const raw = localStorage.getItem("xrelay.activeFocus");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.instanceId).toBe("i1");
    expect(parsed.sessionAlias).toBe("backend");
  });

  it("initTabFocusTracker lifecycle: maintains heartbeat while focused and clears on blur/visibility", () => {
    const tracker = initTabFocusTracker("tab-A");
    tracker.updateFocus("i1", "backend");

    // Heartbeat written
    const raw1 = localStorage.getItem("xrelay.activeFocus");
    expect(raw1).toBeTruthy();
    expect(JSON.parse(raw1!).tabId).toBe("tab-A");

    // Window blur event (e.g. user Alt-Tabs to VS Code) -> immediately removes Tab A's focus
    window.dispatchEvent(new Event("blur"));
    expect(localStorage.getItem("xrelay.activeFocus")).toBeNull();

    // Window focus restored -> writes heartbeat back
    window.dispatchEvent(new Event("focus"));
    expect(localStorage.getItem("xrelay.activeFocus")).toBeTruthy();

    // Tab B's blur does not erase Tab A's record
    const trackerB = initTabFocusTracker("tab-B");
    window.dispatchEvent(new Event("blur")); // Tab B blur
    // Tab B's cleanup will not touch Tab A's key because tabId is tab-B (and current focus is tab-A)
    tracker.dispose();
    trackerB.dispose();
  });
});

describe("chat store local notification integration", () => {
  let showNotificationMock: Mock;

  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    localStorage.setItem(DESKTOP_NOTIFICATIONS_ENABLED_KEY, "true");
    showNotificationMock = vi.fn().mockResolvedValue(undefined);

    vi.stubGlobal("Notification", Object.assign(
      function (this: unknown, title: string, options?: NotificationOptions) {
        return { title, ...options, close: vi.fn() };
      },
      { permission: "granted" }
    ));

    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue({
          active: true,
          showNotification: showNotificationMock,
        }),
        ready: Promise.resolve({
          active: true,
          showNotification: showNotificationMock,
        }),
      },
    });

    Object.defineProperty(document, "hidden", { value: false, writable: true, configurable: true });
    Object.defineProperty(document, "hasFocus", { value: () => true, writable: true, configurable: true });
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("suppresses notification when user is actively viewing the session with focused tab", async () => {
    const instancesStore = useInstancesStore();
    instancesStore.instances = [{ id: "i1", name: "MacBook Pro", online: true, lastSeenAt: null, sessions: [], workspaces: [], agents: [] }] as never;

    const chatStore = useChatStore();
    chatStore.select("i1", "backend");

    chatStore.applyEvent({
      kind: "turn-completion",
      instanceId: "i1",
      sessionAlias: "backend",
      notificationId: "notif-1",
      ok: true,
      text: "Finished task",
    });

    await vi.waitFor(() => {
      expect(showNotificationMock).not.toHaveBeenCalled();
    });
  });

  it("emits notification when user is on the session but tab is in background (document.hidden = true)", async () => {
    Object.defineProperty(document, "hidden", { value: true, writable: true, configurable: true });

    const instancesStore = useInstancesStore();
    instancesStore.instances = [{ id: "i1", name: "MacBook Pro", online: true, lastSeenAt: null, sessions: [], workspaces: [], agents: [] }] as never;

    const chatStore = useChatStore();
    chatStore.select("i1", "backend");

    chatStore.applyEvent({
      kind: "turn-completion",
      instanceId: "i1",
      sessionAlias: "backend",
      notificationId: "notif-1",
      ok: true,
      text: "Finished background task",
    });

    await vi.waitFor(() => {
      expect(showNotificationMock).toHaveBeenCalledTimes(1);
    });

    const [title, options] = showNotificationMock.mock.calls[0] as [string, NotificationOptions];
    expect(title).toBe("MacBook Pro · backend");
    expect(options.body).toBe("Finished background task");
  });

  it("emits notification when turn finishes in a different (unselected) session", async () => {
    const instancesStore = useInstancesStore();
    instancesStore.instances = [{ id: "i1", name: "MacBook Pro", online: true, lastSeenAt: null, sessions: [], workspaces: [], agents: [] }] as never;

    const chatStore = useChatStore();
    chatStore.select("i1", "other-session");

    chatStore.applyEvent({
      kind: "turn-completion",
      instanceId: "i1",
      sessionAlias: "backend",
      notificationId: "notif-1",
      ok: true,
      text: "Finished other session task",
    });

    await vi.waitFor(() => {
      expect(showNotificationMock).toHaveBeenCalledTimes(1);
    });

    const [title, options] = showNotificationMock.mock.calls[0] as [string, NotificationOptions];
    expect(title).toBe("MacBook Pro · backend");
    expect(options.body).toBe("Finished other session task");
  });

  it("does not emit notification on raw turn-finished (only on authoritative turn-completion notice)", async () => {
    Object.defineProperty(document, "hidden", { value: true, writable: true, configurable: true });

    const chatStore = useChatStore();
    chatStore.select("i1", "backend");

    chatStore.applyEvent({
      kind: "control-event",
      instanceId: "i1",
      event: {
        type: "turn-finished",
        chatKey: "relay:a1",
        sessionAlias: "backend",
        cancelled: false,
        ok: true,
        text: "raw turn finished",
      },
    });

    await vi.waitFor(() => {
      expect(showNotificationMock).not.toHaveBeenCalled();
    });
  });

  it("does not emit notification on connector instanceNotice (only on Hub turn-completion)", async () => {
    Object.defineProperty(document, "hidden", { value: true, writable: true, configurable: true });

    const chatStore = useChatStore();
    chatStore.select("i1", "backend");

    chatStore.applyEvent({
      kind: "notice",
      instanceId: "i1",
      notice: {
        kind: "task-progress",
        text: "progress update",
      },
    });

    await vi.waitFor(() => {
      expect(showNotificationMock).not.toHaveBeenCalled();
    });
  });
});
