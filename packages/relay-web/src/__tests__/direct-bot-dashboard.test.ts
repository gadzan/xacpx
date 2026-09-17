import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { WebServerEvent } from "@ganglion/xacpx-relay-protocol";
import { i18n } from "../i18n";

const disconnect = vi.fn();
const captured: { onEvent?: (e: WebServerEvent) => void; onStatus?: (online: boolean) => void } = {};
const { sendSubscribe } = vi.hoisted(() => ({ sendSubscribe: vi.fn() }));

vi.mock("../api/events", () => ({
  connectEvents: (onEvent: (e: WebServerEvent) => void, onStatus?: (online: boolean) => void) => {
    captured.onEvent = onEvent;
    captured.onStatus = onStatus;
    return disconnect;
  },
  sendSubscribe,
  sendWebClientMessage: vi.fn(),
  subscribeWebEvents: () => () => {},
  isRetryableTerminalError: () => false,
  TerminalRequestError: class TerminalRequestError extends Error {},
}));

vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../lib/agent-icons", () => ({ agentIconSvg: () => null }));

import DashboardView from "../views/DashboardView.vue";
import { useInstancesStore } from "../stores/instances";
import { useChatStore } from "../stores/chat";
import { useDirectBotsStore } from "../stores/direct-bots";

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
});
