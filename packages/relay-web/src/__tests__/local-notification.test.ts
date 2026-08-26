import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { showLocalTurnNotification, LOCAL_NOTIFICATION_BODY_CAP } from "../lib/local-notification";
import { useChatStore } from "../stores/chat";
import { useInstancesStore } from "../stores/instances";

describe("local-notification helper", () => {
  let showNotificationMock: Mock;
  let notificationConstructorMock: Mock;

  beforeEach(() => {
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
        ready: Promise.resolve({
          showNotification: showNotificationMock,
        }),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does nothing when Notification is unsupported or permission is denied/default", async () => {
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

  it("sends success notification via Service Worker with truncated text and proper tags", async () => {
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
    expect(options.tag).toBe("xacpx-task:inst-123");
    expect(options.icon).toBe("/pwa-192x192.png");
    expect(options.data).toEqual({
      instanceId: "inst-123",
      sessionAlias: "frontend",
      url: "/",
    });
  });

  it("falls back to 'Task completed' when success text is empty or blank", async () => {
    await showLocalTurnNotification({
      instanceId: "inst-123",
      instanceName: "Workstation",
      sessionAlias: "frontend",
      ok: true,
      text: "   ",
    });

    expect(showNotificationMock).toHaveBeenCalledTimes(1);
    const [, options] = showNotificationMock.mock.calls[0] as [string, NotificationOptions];
    expect(options.body).toBe("Task completed");
  });

  it("caps notification body to 200 characters", async () => {
    const longText = "a".repeat(300);
    await showLocalTurnNotification({
      instanceId: "inst-123",
      instanceName: "Workstation",
      sessionAlias: "frontend",
      ok: true,
      text: longText,
    });

    expect(showNotificationMock).toHaveBeenCalledTimes(1);
    const [, options] = showNotificationMock.mock.calls[0] as [string, NotificationOptions];
    expect(options.body?.length).toBe(LOCAL_NOTIFICATION_BODY_CAP);
    expect(options.body).toBe("a".repeat(200));
  });

  it("formats error notifications as 'Task failed: <msg>'", async () => {
    await showLocalTurnNotification({
      instanceId: "inst-123",
      instanceName: "Workstation",
      sessionAlias: "frontend",
      ok: false,
      errorMessage: "Connection timeout while talking to acpx",
    });

    expect(showNotificationMock).toHaveBeenCalledTimes(1);
    const [, options] = showNotificationMock.mock.calls[0] as [string, NotificationOptions];
    expect(options.body).toBe("Task failed: Connection timeout while talking to acpx");
  });

  it("formats error notifications as 'Task failed: Unknown error' when errorMessage is missing", async () => {
    await showLocalTurnNotification({
      instanceId: "inst-123",
      instanceName: "Workstation",
      sessionAlias: "frontend",
      ok: false,
    });

    expect(showNotificationMock).toHaveBeenCalledTimes(1);
    const [, options] = showNotificationMock.mock.calls[0] as [string, NotificationOptions];
    expect(options.body).toBe("Task failed: Unknown error");
  });

  it("falls back to window Notification when service worker is unavailable", async () => {
    vi.stubGlobal("navigator", {}); // no serviceWorker

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
        tag: "xacpx-task:inst-123",
      }),
    );
  });
});

describe("chat store local notification integration", () => {
  let showNotificationMock: Mock;

  beforeEach(() => {
    setActivePinia(createPinia());
    showNotificationMock = vi.fn().mockResolvedValue(undefined);

    vi.stubGlobal("Notification", Object.assign(
      function (this: unknown, title: string, options?: NotificationOptions) {
        return { title, ...options, close: vi.fn() };
      },
      { permission: "granted" }
    ));

    vi.stubGlobal("navigator", {
      serviceWorker: {
        ready: Promise.resolve({
          showNotification: showNotificationMock,
        }),
      },
    });
    // Default document state: visible and focused
    Object.defineProperty(document, "hidden", { value: false, writable: true, configurable: true });
    Object.defineProperty(document, "hasFocus", { value: () => true, writable: true, configurable: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("suppresses notification when user is actively viewing the session with focused tab", () => {
    const instancesStore = useInstancesStore();
    instancesStore.instances = [{ id: "i1", name: "MacBook Pro", online: true, lastSeenAt: null, sessions: [], workspaces: [], agents: [] }] as never;

    const chatStore = useChatStore();
    chatStore.select("i1", "backend");

    chatStore.applyEvent({
      kind: "control-event",
      instanceId: "i1",
      event: {
        type: "turn-finished",
        chatKey: "relay:a1",
        sessionAlias: "backend",
        ok: true,
        text: "Finished task",
      },
    });

    expect(showNotificationMock).not.toHaveBeenCalled();
  });

  it("emits notification when user is on the session but tab is in background (document.hidden = true)", async () => {
    Object.defineProperty(document, "hidden", { value: true, writable: true, configurable: true });

    const instancesStore = useInstancesStore();
    instancesStore.instances = [{ id: "i1", name: "MacBook Pro", online: true, lastSeenAt: null, sessions: [], workspaces: [], agents: [] }] as never;

    const chatStore = useChatStore();
    chatStore.select("i1", "backend");

    chatStore.applyEvent({
      kind: "control-event",
      instanceId: "i1",
      event: {
        type: "turn-finished",
        chatKey: "relay:a1",
        sessionAlias: "backend",
        ok: true,
        text: "Finished background task",
      },
    });

    await vi.waitFor(() => {
      expect(showNotificationMock).toHaveBeenCalledTimes(1);
    });

    const [title, options] = showNotificationMock.mock.calls[0] as [string, NotificationOptions];
    expect(title).toBe("MacBook Pro · backend");
    expect(options.body).toBe("Finished background task");
  });

  it("emits notification when user is on the session but window is not focused (!document.hasFocus())", async () => {
    Object.defineProperty(document, "hidden", { value: false, writable: true, configurable: true });
    Object.defineProperty(document, "hasFocus", { value: () => false, writable: true, configurable: true });

    const instancesStore = useInstancesStore();
    instancesStore.instances = [{ id: "i1", name: "MacBook Pro", online: true, lastSeenAt: null, sessions: [], workspaces: [], agents: [] }] as never;

    const chatStore = useChatStore();
    chatStore.select("i1", "backend");

    chatStore.applyEvent({
      kind: "control-event",
      instanceId: "i1",
      event: {
        type: "turn-finished",
        chatKey: "relay:a1",
        sessionAlias: "backend",
        ok: true,
        text: "Finished unfocused task",
      },
    });

    await vi.waitFor(() => {
      expect(showNotificationMock).toHaveBeenCalledTimes(1);
    });

    const [title] = showNotificationMock.mock.calls[0] as [string, NotificationOptions];
    expect(title).toBe("MacBook Pro · backend");
  });

  it("emits notification when turn finishes in a different (unselected) session", async () => {
    const instancesStore = useInstancesStore();
    instancesStore.instances = [{ id: "i1", name: "MacBook Pro", online: true, lastSeenAt: null, sessions: [], workspaces: [], agents: [] }] as never;

    const chatStore = useChatStore();
    chatStore.select("i1", "other-session");

    chatStore.applyEvent({
      kind: "control-event",
      instanceId: "i1",
      event: {
        type: "turn-finished",
        chatKey: "relay:a1",
        sessionAlias: "backend",
        ok: true,
        text: "Finished other session task",
      },
    });

    await vi.waitFor(() => {
      expect(showNotificationMock).toHaveBeenCalledTimes(1);
    });

    const [title, options] = showNotificationMock.mock.calls[0] as [string, NotificationOptions];
    expect(title).toBe("MacBook Pro · backend");
    expect(options.body).toBe("Finished other session task");
  });

  it("does not emit notification when turn was cancelled by user", () => {
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
        cancelled: true,
        ok: false,
      },
    });

    expect(showNotificationMock).not.toHaveBeenCalled();
  });
});
