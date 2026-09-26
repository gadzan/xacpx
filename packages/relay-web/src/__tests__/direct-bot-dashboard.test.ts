import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { WebServerEvent } from "@ganglion/xacpx-relay-protocol";
import { i18n } from "../i18n";

const disconnect = vi.fn();
const captured: { onEvent?: (e: WebServerEvent) => void; onStatus?: (online: boolean) => void } = {};
const { sendSubscribe } = vi.hoisted(() => ({ sendSubscribe: vi.fn() }));

vi.mock("../api/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/events")>();
  return {
    ...actual,
    connectEvents: (onEvent: (e: WebServerEvent) => void, onStatus?: (online: boolean) => void) => {
      captured.onEvent = onEvent;
      captured.onStatus = onStatus;
      return disconnect;
    },
    sendSubscribe,
    sendWebClientMessage: vi.fn(),
    isRetryableTerminalError: () => false,
    TerminalRequestError: class TerminalRequestError extends Error {},
    // Desktop RPC: no live socket in this harness, so resolve stably.
    isEventsSocketOpen: () => true,
    requestDesktop: vi.fn(async () => ({
      requestId: "r1",
      instanceId: "i1",
      streamId: "s1",
      wsPath: "/desktop/observe?ticket=t",
      expiresAt: 1,
      security: "vnc-auth",
    })),
  };
});

vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../lib/agent-icons", () => ({ agentIconSvg: () => null }));
// noVNC is not exercised here: only the session/stream bookkeeping.
vi.mock("../lib/desktop-client", () => ({
  connectDesktopRfb: vi.fn(() => ({ sendCredentials: vi.fn(), setScaleViewport: vi.fn(), dispose: vi.fn() })),
}));

import DashboardView from "../views/DashboardView.vue";
import { useInstancesStore } from "../stores/instances";
import { useChatStore } from "../stores/chat";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useDesktopStore } from "../stores/desktop";

describe("DashboardView Direct Bot integration", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    captured.onEvent = undefined;
    captured.onStatus = undefined;
    sendSubscribe.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/instances")) {
          return new Response(JSON.stringify({ instances: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ turns: [], usage: [], commands: [] }), { status: 200 });
      }),
    );
  });

  it("renders DirectBotPane when a bot is selected and disables ordinary terminal", async () => {
    const instances = useInstancesStore();
    instances.instances = [
      {
        id: "i1",
        name: "Local",
        online: true,
        lastSeenAt: null,
        capabilities: ["terminal.rmux.recovery.v1", "terminal.multi-view.v1"],
        sessions: [{ alias: "ordinary_session", agent: "codex", workspace: "repo" }],
        sessionsLoaded: true,
        agents: [{ name: "codex", driver: "codex" }],
        workspaces: [{ name: "repo", cwd: "/repo" }],
      } as never,
    ];

    const directBots = useDirectBotsStore();
    directBots.botsByInstance["i1"] = [
      { id: "bot_1", name: "SecurityBot", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
    ];
    directBots.botsLoaded["i1"] = true;

    const wrapper = mount(DashboardView, {
      global: {
        plugins: [i18n],
        stubs: {
          routerLink: true,
        },
      },
    });

    await flushPromises();

    // Select the bot
    await directBots.selectBot("i1", "bot_1");
    await flushPromises();

    // Verify DirectBotPane is mounted in center
    expect(wrapper.findComponent({ name: "DirectBotPane" }).exists()).toBe(true);

    // Verify terminal toggle button in header is disabled because no ordinary session is selected
    const terminalBtn = wrapper.find('[data-test="toggle-terminal"]');
    expect((terminalBtn.element as HTMLButtonElement).disabled).toBe(true);

    // Verify right drawer for files/tasks is hidden in Bot mode
    expect(wrapper.find('[data-drawer="right"]').exists()).toBe(false);

    // Switch back to ordinary session
    const chat = useChatStore();
    chat.select("i1", "ordinary_session");
    directBots.clearSelection();
    await flushPromises();

    // Now ChatPane is visible, DirectBotPane unmounted
    expect(wrapper.findComponent({ name: "DirectBotPane" }).exists()).toBe(false);
    expect(wrapper.find('[data-drawer="right"]').exists()).toBe(true);
  });

  it("reconciles direct bots state on WebSocket reconnect", async () => {
    const instances = useInstancesStore();
    instances.instances = [
      {
        id: "i1",
        name: "Local",
        online: true,
        lastSeenAt: null,
        sessions: [],
        agents: [],
        workspaces: [],
      } as never,
    ];

    const directBots = useDirectBotsStore();
    const reconcileSpy = vi.spyOn(directBots, "reconcileOnReconnect").mockResolvedValue();

    mount(DashboardView, {
      global: {
        plugins: [i18n],
        stubs: {
          routerLink: true,
        },
      },
    });

    await flushPromises();

    expect(captured.onStatus).toBeTruthy();

    // Simulate initial online
    captured.onStatus!(true);
    await flushPromises();

    // Simulate reconnect after drop
    captured.onStatus!(true);
    await flushPromises();

    expect(reconcileSpy).toHaveBeenCalled();
  });

  it("restores persisted bot selection on page load", async () => {
    localStorage.setItem("xrelay.selectedBot", JSON.stringify({ instanceId: "i1", botId: "bot_saved" }));

    const instances = useInstancesStore();
    instances.instances = [
      {
        id: "i1",
        name: "Local",
        online: true,
        lastSeenAt: null,
        sessions: [],
        agents: [{ name: "codex", driver: "codex" }],
        workspaces: [{ name: "repo", cwd: "/repo" }],
      } as never,
    ];
    vi.spyOn(instances, "loadInstances").mockResolvedValue();

    const directBots = useDirectBotsStore();
    const selectBotSpy = vi.spyOn(directBots, "selectBot").mockResolvedValue();

    mount(DashboardView, {
      global: {
        plugins: [i18n],
        stubs: {
          routerLink: true,
        },
      },
    });

    await flushPromises();

    expect(selectBotSpy).toHaveBeenCalledWith("i1", "bot_saved");
  });

  it("leaves the desktop tab when switching to a Direct Bot", async () => {
    // Regression: onSelectBot only cleared the chat selection, leaving
    // desktopTabOpen true. DesktopTab unmounts (chat.instanceId is null), but a
    // later ordinary-session select re-mounts it via the v-if and silently
    // re-prepares a desktop stream the user never asked for again.
    localStorage.clear();
    sessionStorage.clear();
    const instances = useInstancesStore();
    instances.instances = [
      {
        id: "i1",
        name: "Local",
        online: true,
        lastSeenAt: null,
        capabilities: ["desktop.rfb.v1"],
        sessions: [{ alias: "ordinary_session", agent: "codex", workspace: "repo" }],
        sessionsLoaded: true,
        agents: [{ name: "codex", driver: "codex" }],
        workspaces: [{ name: "repo", cwd: "/repo" }],
      } as never,
    ];

    const directBots = useDirectBotsStore();
    directBots.botsByInstance["i1"] = [
      { id: "bot_1", name: "SecurityBot", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
    ];
    directBots.botsLoaded["i1"] = true;
    vi.spyOn(directBots, "selectBot").mockResolvedValue();

    const wrapper = mount(DashboardView, {
      global: { plugins: [i18n], stubs: { routerLink: true } },
    });
    await flushPromises();
    // Seed AFTER mount: the mount-time loadInstances() (fetch-stubbed to an
    // empty list) would otherwise overwrite a pre-seeded array.
    instances.instances = [
      {
        id: "i1",
        name: "Local",
        online: true,
        lastSeenAt: null,
        capabilities: ["desktop.rfb.v1"],
        sessions: [{ alias: "ordinary_session", agent: "codex", workspace: "repo" }],
        sessionsLoaded: true,
        agents: [{ name: "codex", driver: "codex" }],
        workspaces: [{ name: "repo", cwd: "/repo" }],
      } as never,
    ];

    // Open the desktop tab through the real control.
    const chat = useChatStore();
    chat.select("i1", "ordinary_session");
    await flushPromises();
    const toggle = wrapper.find('[data-test="toggle-desktop"]');
    expect(toggle.exists()).toBe(true);
    await toggle.trigger("click");
    await flushPromises();
    expect(wrapper.findComponent({ name: "DesktopTab" }).exists()).toBe(true);

    // Switch to the Direct Bot: DesktopTab must go away.
    const tree = wrapper.findComponent({ name: "InstanceTree" });
    expect(tree.exists()).toBe(true);
    await tree.vm.$emit("select-bot", "i1", "bot_1");
    await flushPromises();
    expect(wrapper.findComponent({ name: "DesktopTab" }).exists()).toBe(false);

    // Now pick the ordinary session again: DesktopTab must NOT come back on its
    // own — only an explicit desktop open may bring it back.
    await tree.vm.$emit("select", "i1", "ordinary_session");
    await flushPromises();
    expect(wrapper.findComponent({ name: "DesktopTab" }).exists()).toBe(false);
  });

  it("opens Desktop for a capable instance that has no sessions", async () => {
    // Design §2/§3: Desktop is an instance-level resource opened from the
    // instance entry, not bound to a logical session. An online instance
    // advertising desktop.rfb.v1 with zero sessions used to have no way to
    // reach it (the toolbar button and DesktopTab both keyed off chat.instanceId).
    localStorage.clear();
    sessionStorage.clear();
    const instances = useInstancesStore();
    const wrapper = mount(DashboardView, {
      global: { plugins: [i18n], stubs: { routerLink: true } },
    });
    await flushPromises();
    instances.instances = [
      {
        id: "i1",
        name: "Headless",
        online: true,
        lastSeenAt: null,
        capabilities: ["desktop.rfb.v1"],
        sessions: [],
        sessionsLoaded: true,
        agents: [{ name: "codex", driver: "codex" }],
        workspaces: [{ name: "repo", cwd: "/repo" }],
      } as never,
    ];
    await flushPromises();

    // No session (and no bot) is selected at all.
    const chat = useChatStore();
    expect(chat.instanceId).toBeNull();
    expect(wrapper.find('[data-test="toggle-desktop"]').exists()).toBe(false);

    const entry = wrapper.find('[data-test="instance-desktop"]');
    expect(entry.exists()).toBe(true);
    await entry.trigger("click");
    await flushPromises();
    expect(wrapper.findComponent({ name: "DesktopTab" }).exists()).toBe(true);
    const store = useDesktopStore();
    await vi.waitFor(() => expect(store.viewFor("i1").streamId).toBe("s1"));
  });

  it("opens Desktop from the instance entry while a Direct Bot is selected", async () => {
    localStorage.clear();
    sessionStorage.clear();
    const instances = useInstancesStore();
    const directBots = useDirectBotsStore();
    directBots.botsByInstance["i1"] = [
      { id: "bot_1", name: "SecurityBot", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
    ];
    directBots.botsLoaded["i1"] = true;
    vi.spyOn(directBots, "selectBot").mockResolvedValue();

    const wrapper = mount(DashboardView, {
      global: { plugins: [i18n], stubs: { routerLink: true } },
    });
    await flushPromises();
    instances.instances = [
      {
        id: "i1",
        name: "Botted",
        online: true,
        lastSeenAt: null,
        capabilities: ["desktop.rfb.v1"],
        sessions: [{ alias: "ordinary_session", agent: "codex", workspace: "repo" }],
        sessionsLoaded: true,
        agents: [{ name: "codex", driver: "codex" }],
        workspaces: [{ name: "repo", cwd: "/repo" }],
      } as never,
    ];
    await flushPromises();

    // Switch into Direct Bot mode: the chat selection is cleared, and with it
    // the old session-keyed toolbar entry.
    const chat = useChatStore();
    chat.select("i1", "ordinary_session");
    await flushPromises();
    directBots.selectBot("i1", "bot_1");
    await flushPromises();
    expect(wrapper.findComponent({ name: "DesktopTab" }).exists()).toBe(false);

    // The instance-level entry is still there and works.
    const entry = wrapper.find('[data-test="instance-desktop"]');
    expect(entry.exists()).toBe(true);
    await entry.trigger("click");
    await flushPromises();
    expect(wrapper.findComponent({ name: "DesktopTab" }).exists()).toBe(true);
  });
});
