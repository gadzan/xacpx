import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { BotDetailDto, BotSummaryDto } from "@ganglion/xacpx-relay-protocol";

type Handler = (payload: Record<string, unknown>) => unknown;
const routes = new Map<string, Handler>();
const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(public code: string, public status: number) {
      super(code);
    }
  },
  api: {
    rpc: async (_instanceId: string, type: string, payload: Record<string, unknown> = {}) => {
      calls.push({ type, payload });
      const handler = routes.get(type);
      if (!handler) throw new Error(`unexpected rpc ${type}`);
      return await handler(payload);
    },
  },
}));

import { i18n } from "../i18n";
import { useToasts } from "../lib/use-toasts";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useInstancesStore } from "../stores/instances";
import BotDialog from "../components/BotDialog.vue";
import InstanceTree from "../components/InstanceTree.vue";
import ToastHost from "../components/ToastHost.vue";

const REVIEWER: BotSummaryDto = { id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now", profileRevision: 1 };
const TESTER: BotSummaryDto = { id: "bot_b", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now", profileRevision: 1 };
const SLEEPER: BotSummaryDto = { id: "bot_off", name: "Sleeper", agent: "codex", workspace: "repo", enabled: false, updatedAt: "now", profileRevision: 1 };

function detail(bot: BotSummaryDto, patch: Partial<BotDetailDto> = {}): BotDetailDto {
  return { ...bot, profileRevision: bot.profileRevision ?? 1, createdAt: "now", ...patch };
}

function seedInstance(): void {
  useInstancesStore().instances = [
    {
      id: "i1",
      name: "Local",
      online: true,
      lastSeenAt: null,
      sessions: [],
      sessionsLoaded: true,
      agents: [{ name: "codex", driver: "codex" }],
      workspaces: [{ name: "repo", cwd: "/repo" }],
      agentCatalog: [],
    } as never,
  ];
}

function seedBots(bots: BotSummaryDto[]): void {
  const direct = useDirectBotsStore();
  direct.botsByInstance["i1"] = bots;
  direct.botsLoaded["i1"] = true;
}

let wrappers: VueWrapper[] = [];
function track<T extends VueWrapper>(wrapper: T): T {
  wrappers.push(wrapper);
  return wrapper;
}

async function mountBotsTree(): Promise<VueWrapper> {
  const wrapper = track(mount(InstanceTree, { global: { plugins: [i18n] } }));
  track(mount(ToastHost, { global: { plugins: [i18n] } }));
  await flushPromises();
  await wrapper.find('[data-test="instance-nav-bots"]').trigger("click");
  await flushPromises();
  return wrapper;
}

function botNames(wrapper: VueWrapper): string[] {
  return wrapper.findAll('[data-test="bot-name"]').map((node) => node.text());
}

function toastTexts(): string[] {
  return [...document.body.querySelectorAll('[data-test="toast"] span')].map((node) => node.textContent ?? "");
}

async function mountBotDialog(bot: BotSummaryDto): Promise<VueWrapper> {
  routes.set("control.agents.list", () => ({ agents: [{ name: "codex", driver: "codex" }] }));
  routes.set("control.workspaces.list", () => ({ workspaces: [{ name: "repo", cwd: "/repo" }] }));
  routes.set("control.agents.catalog", () => ({ agents: [] }));
  routes.set("control.bots.get", () => ({ bot: detail(bot) }));
  const wrapper = track(mount(BotDialog, {
    props: { instanceId: "i1", instanceName: "Local", bot },
    global: { plugins: [i18n] },
  }));
  await flushPromises();
  return wrapper;
}

function enabledCheckbox(wrapper: VueWrapper) {
  return wrapper.find('input[type="checkbox"]');
}

describe("Disabled Bots", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    routes.clear();
    calls.length = 0;
    localStorage.clear();
    useToasts().value = [];
    seedInstance();
    i18n.global.locale.value = "en";
  });

  afterEach(() => {
    for (const wrapper of wrappers) wrapper.unmount();
    wrappers = [];
  });

  describe("InstanceTree Bots list", () => {
    it("keeps disabled Bots out of the daily list behind a Disabled count", async () => {
      seedBots([REVIEWER, SLEEPER, TESTER]);
      const wrapper = await mountBotsTree();

      expect(botNames(wrapper)).toEqual(["Reviewer", "Tester"]);
      const toggle = wrapper.find('[data-test="bots-disabled-toggle"]');
      expect(toggle.text()).toBe("Disabled (1)");
      expect(toggle.attributes("aria-expanded")).toBe("false");

      await toggle.trigger("click");
      expect(botNames(wrapper)).toEqual(["Reviewer", "Tester", "Sleeper"]);
      expect(toggle.attributes("aria-expanded")).toBe("true");
      const enableButtons = wrapper.findAll('[data-test="enable-bot-tree-button"]');
      expect(enableButtons.map((button) => button.text())).toEqual(["Enable"]);

      await toggle.trigger("click");
      expect(botNames(wrapper)).toEqual(["Reviewer", "Tester"]);
    });

    it("hides the Disabled toggle when every Bot is enabled", async () => {
      seedBots([REVIEWER, TESTER]);
      const wrapper = await mountBotsTree();

      expect(botNames(wrapper)).toEqual(["Reviewer", "Tester"]);
      expect(wrapper.find('[data-test="bots-disabled-toggle"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="enable-bot-tree-button"]').exists()).toBe(false);
    });

    it("keeps the selected disabled Bot visible while the Disabled list is collapsed", async () => {
      seedBots([REVIEWER, SLEEPER]);
      const direct = useDirectBotsStore();
      direct.instanceId = "i1";
      direct.selectedBotId = "bot_off";
      const wrapper = await mountBotsTree();

      expect(botNames(wrapper)).toEqual(["Reviewer", "Sleeper"]);
      expect(wrapper.find('[data-test="bots-disabled-toggle"]').attributes("aria-expanded")).toBe("false");
    });

    it("says every Bot is disabled instead of showing an empty list", async () => {
      seedBots([SLEEPER, { ...TESTER, enabled: false }]);
      const wrapper = await mountBotsTree();

      expect(botNames(wrapper)).toEqual([]);
      expect(wrapper.find('[data-test="no-bots"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="no-enabled-bots"]').text()).toBe(
        "Every Bot here is disabled. Open the disabled list to enable one.",
      );
      expect(wrapper.find('[data-test="bots-disabled-toggle"]').text()).toBe("Disabled (2)");

      await wrapper.find('[data-test="bots-disabled-toggle"]').trigger("click");
      expect(botNames(wrapper)).toEqual(["Sleeper", "Tester"]);
      expect(wrapper.find('[data-test="no-enabled-bots"]').exists()).toBe(false);
    });

    it("re-enables a Bot from the Disabled list and says queued work may start", async () => {
      seedBots([REVIEWER, SLEEPER]);
      const enabled = { ...SLEEPER, enabled: true, profileRevision: 2 };
      routes.set("control.bots.update", () => ({ bot: detail(enabled) }));
      routes.set("control.bots.list", () => ({ bots: [REVIEWER, enabled] }));
      const wrapper = await mountBotsTree();

      await wrapper.find('[data-test="bots-disabled-toggle"]').trigger("click");
      await wrapper.find('[data-test="enable-bot-tree-button"]').trigger("click");
      await flushPromises();

      expect(calls.filter((call) => call.type === "control.bots.update").map((call) => call.payload)).toEqual([
        { id: "bot_off", enabled: true },
      ]);
      expect(botNames(wrapper)).toEqual(["Reviewer", "Sleeper"]);
      expect(wrapper.find('[data-test="bots-disabled-toggle"]').exists()).toBe(false);
      expect(toastTexts()).toEqual(["Sleeper is enabled. Work queued while it was disabled may start now."]);
    });

    it("keeps the Bot in the Disabled list and says so when re-enable fails", async () => {
      seedBots([REVIEWER, SLEEPER]);
      routes.set("control.bots.update", () => ({ error: { code: "bot_not_found", message: "gone" } }));
      routes.set("control.bots.list", () => ({ bots: [REVIEWER, SLEEPER] }));
      const wrapper = await mountBotsTree();

      await wrapper.find('[data-test="bots-disabled-toggle"]').trigger("click");
      await wrapper.find('[data-test="enable-bot-tree-button"]').trigger("click");
      await flushPromises();

      expect(botNames(wrapper)).toEqual(["Reviewer", "Sleeper"]);
      expect(wrapper.find('[data-test="bots-disabled-toggle"]').text()).toBe("Disabled (1)");
      expect(calls.filter((call) => call.type === "control.bots.list")).toHaveLength(1);
      expect(toastTexts()).toEqual([
        "Could not confirm that Sleeper is enabled. The list shows the current state once it refreshes.",
      ]);
    });

    it("shows the Disabled copy in Chinese", async () => {
      i18n.global.locale.value = "zh-CN";
      seedBots([SLEEPER]);
      const wrapper = await mountBotsTree();

      expect(wrapper.find('[data-test="bots-disabled-toggle"]').text()).toBe("已禁用（1）");
      expect(wrapper.find('[data-test="no-enabled-bots"]').text()).toBe("此实例的 Bot 均已禁用。展开已禁用列表即可重新启用。");
      await wrapper.find('[data-test="bots-disabled-toggle"]').trigger("click");
      expect(wrapper.find('[data-test="enable-bot-tree-button"]').text()).toBe("启用");
    });
  });

  describe("BotDialog Enabled switch", () => {
    it("explains that disabling blocks new messages but does not stop running work", async () => {
      seedBots([REVIEWER]);
      const wrapper = await mountBotDialog(REVIEWER);

      expect(wrapper.find('[data-test="bot-dialog-disable-note"]').exists()).toBe(false);
      await enabledCheckbox(wrapper).setValue(false);
      expect(wrapper.find('[data-test="bot-dialog-disable-note"]').text()).toBe(
        "Disabling blocks new messages to this Bot. A Run that is already going keeps running until it ends or you press Stop in the chat. Queued work waits and may start when the Bot is enabled again. A task another Bot hands to it while it is disabled fails.",
      );
      expect(wrapper.find('[data-test="bot-dialog-reenable-note"]').exists()).toBe(false);

      await enabledCheckbox(wrapper).setValue(true);
      expect(wrapper.find('[data-test="bot-dialog-disable-note"]').exists()).toBe(false);
    });

    it("warns that enabling a disabled Bot may start queued work", async () => {
      seedBots([SLEEPER]);
      const wrapper = await mountBotDialog(SLEEPER);

      expect(wrapper.find('[data-test="bot-dialog-reenable-note"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="bot-dialog-disable-note"]').exists()).toBe(false);
      await enabledCheckbox(wrapper).setValue(true);
      expect(wrapper.find('[data-test="bot-dialog-reenable-note"]').text()).toBe(
        "Enabling this Bot may start work that was queued while it was disabled.",
      );
    });

    it("compares against the stored detail, not the summary the dialog opened with", async () => {
      seedBots([REVIEWER]);
      routes.set("control.agents.list", () => ({ agents: [{ name: "codex", driver: "codex" }] }));
      routes.set("control.workspaces.list", () => ({ workspaces: [{ name: "repo", cwd: "/repo" }] }));
      routes.set("control.agents.catalog", () => ({ agents: [] }));
      routes.set("control.bots.get", () => ({ bot: detail(REVIEWER, { enabled: false, profileRevision: 2 }) }));
      const wrapper = track(mount(BotDialog, {
        props: { instanceId: "i1", instanceName: "Local", bot: REVIEWER },
        global: { plugins: [i18n] },
      }));
      await flushPromises();

      expect((enabledCheckbox(wrapper).element as HTMLInputElement).checked).toBe(false);
      expect(wrapper.find('[data-test="bot-dialog-disable-note"]').exists()).toBe(false);
      await enabledCheckbox(wrapper).setValue(true);
      expect(wrapper.find('[data-test="bot-dialog-reenable-note"]').exists()).toBe(true);
    });
  });
});
