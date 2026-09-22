import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type {
  BotDetailDto,
  BotSummaryDto,
  ConversationMessageDto,
  ConversationRunDto,
  MemberTurnSummaryDto,
  TopicSummaryDto,
  ToolStepDto,
  TurnPartDto,
} from "@ganglion/xacpx-relay-protocol";
import { i18n } from "../i18n";
import { useInstancesStore } from "../stores/instances";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useChatStore } from "../stores/chat";
import BotDialog from "../components/BotDialog.vue";
import ConversationPromptInput from "../components/ConversationPromptInput.vue";
import ConversationMessageList from "../components/ConversationMessageList.vue";
import DirectBotPane from "../components/DirectBotPane.vue";
import InstanceTree from "../components/InstanceTree.vue";

describe("Direct Bot Components", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  describe("BotDialog.vue", () => {
    it("renders create bot dialog with required fields and NO cwd input", async () => {
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
          agentCatalog: [],
        } as never,
      ];

      const wrapper = mount(BotDialog, {
        props: {
          instanceId: "i1",
          instanceName: "Local",
        },
        global: {
          plugins: [i18n],
        },
      });

      await flushPromises();

      expect(wrapper.find("#bot-name").exists()).toBe(true);
      expect(wrapper.find("#bot-agent").exists()).toBe(true);
      expect(wrapper.find("#bot-workspace").exists()).toBe(true);
      expect(wrapper.find("#bot-role").exists()).toBe(true);
      expect(wrapper.find("#bot-instructions").exists()).toBe(true);
      expect(wrapper.find("#bot-model").exists()).toBe(true);
      expect(wrapper.find("#bot-effort").exists()).toBe(true);
      expect(wrapper.find("#bot-avatar").exists()).toBe(true);

      // Red line check: NEVER add cwd
      expect(wrapper.find("#bot-cwd").exists()).toBe(false);
      expect(wrapper.find('input[name="cwd"]').exists()).toBe(false);
    });

    it("renders adapter-advertised effort choices (including xhigh) and omits unadvertised low/max", async () => {
      const instances = useInstancesStore();
      instances.instances = [
        {
          id: "i1",
          name: "Local",
          online: true,
          lastSeenAt: null,
          sessions: [],
          agents: [{ name: "reviewer", driver: "codex" }],
          workspaces: [{ name: "repo", cwd: "/repo" }],
        } as never,
      ];

      // Mount with advertised efforts: ["medium", "high", "xhigh"]
      const wrapper = mount(BotDialog, {
        props: {
          instanceId: "i1",
          instanceName: "Local",
          advertisedEfforts: ["medium", "high", "xhigh"],
        },
        global: {
          plugins: [i18n],
        },
      });

      await flushPromises();

      const effortSelect = wrapper.find("select#bot-effort");
      expect(effortSelect.exists()).toBe(true);
      const options = effortSelect.findAll("option").map((o) => o.attributes("value"));
      // Must include Default, medium, high, and xhigh
      expect(options).toEqual(["", "medium", "high", "xhigh"]);
      // Unadvertised low and max must NOT be present
      expect(options).not.toContain("low");
      expect(options).not.toContain("max");
    });

    it("renders open effort input with datalist when no advertised efforts are provided", async () => {
      const instances = useInstancesStore();
      instances.instances = [
        {
          id: "i1",
          name: "Local",
          online: true,
          lastSeenAt: null,
          sessions: [],
          agents: [{ name: "reviewer", driver: "codex" }],
          workspaces: [{ name: "repo", cwd: "/repo" }],
        } as never,
      ];

      const wrapper = mount(BotDialog, {
        props: {
          instanceId: "i1",
          instanceName: "Local",
        },
        global: {
          plugins: [i18n],
        },
      });

      await flushPromises();

      const effortInput = wrapper.find("input#bot-effort");
      expect(effortInput.exists()).toBe(true);
      expect(effortInput.attributes("list")).toBe("bot-effort-options");
      const datalist = wrapper.find("datalist#bot-effort-options");
      expect(datalist.exists()).toBe(true);
      // Not a rigid select locking the user to 4 values
      expect(wrapper.find("select#bot-effort").exists()).toBe(false);
    });

    it("lists only configured agent names, never raw catalog drivers", async () => {
      const instances = useInstancesStore();
      instances.instances = [
        {
          id: "i1",
          name: "Local",
          online: true,
          lastSeenAt: null,
          sessions: [],
          agents: [{ name: "reviewer", driver: "codex" }],
          workspaces: [{ name: "repo", cwd: "/repo" }],
          agentCatalog: [
            { driver: "codex", configured: true, installed: "yes" },
            { driver: "claude", configured: false, installed: "yes" },
          ],
        } as never,
      ];
      const wrapper = mount(BotDialog, {
        props: { instanceId: "i1", instanceName: "Local" },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      const options = wrapper.find("#bot-agent").findAll("option").map((o) => (o.element as HTMLOptionElement).value);
      expect(options).toEqual(["reviewer"]);
    });

    it("submits create bot with valid inputs", async () => {
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
          agentCatalog: [],
        } as never,
      ];

      vi.spyOn(instances, "loadFormOptions").mockResolvedValue(undefined);
      const directBots = useDirectBotsStore();
      const createSpy = vi.spyOn(directBots, "createBot").mockResolvedValue({
        id: "bot_1",
        name: "Code Reviewer",
        agent: "codex",
        workspace: "repo",
        instructions: "Look for bugs",
        enabled: true,
        profileRevision: 1,
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
      });

      const wrapper = mount(BotDialog, {
        props: {
          instanceId: "i1",
          instanceName: "Local",
        },
        global: {
          plugins: [i18n],
        },
      });

      await flushPromises();

      await wrapper.find("#bot-name").setValue("Code Reviewer");
      await wrapper.find("#bot-instructions").setValue("Look for bugs");
      await wrapper.find("form").trigger("submit.prevent");
      await flushPromises();

      expect(createSpy).toHaveBeenCalledWith("i1", expect.objectContaining({
        name: "Code Reviewer",
        agent: "codex",
        workspace: "repo",
        instructions: "Look for bugs",
        enabled: true,
      }));
      expect(wrapper.emitted("saved")).toBeTruthy();
      expect(wrapper.emitted("close")).toBeTruthy();
    });

    it("submits edit bot when bot prop is passed", async () => {
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
          agentCatalog: [],
        } as never,
      ];
      vi.spyOn(instances, "loadFormOptions").mockResolvedValue(undefined);
      const directBots = useDirectBotsStore();
      vi.spyOn(directBots, "loadBotDetail").mockResolvedValue({
        id: "bot_1", name: "Existing Bot", agent: "codex", workspace: "repo",
        enabled: true, profileRevision: 1,
        createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z",
      });
      const updateSpy = vi.spyOn(directBots, "updateBot").mockResolvedValue({
        id: "bot_1",
        name: "Updated Bot",
        agent: "codex",
        workspace: "repo",
        enabled: true,
        profileRevision: 2,
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
      });

      const existingBot: BotSummaryDto = {
        id: "bot_1",
        name: "Existing Bot",
        agent: "codex",
        workspace: "repo",
        enabled: true,
        updatedAt: "2026-09-18T00:00:00.000Z",
      };

      const wrapper = mount(BotDialog, {
        props: {
          instanceId: "i1",
          instanceName: "Local",
          bot: existingBot,
        },
        global: {
          plugins: [i18n],
        },
      });

      await flushPromises();
      await flushPromises();
      expect((wrapper.findAll("button").find((b) => b.text().includes("Save"))!.element as HTMLButtonElement).disabled).toBe(false);
      expect((wrapper.find("#bot-name").element as HTMLInputElement).value).toBe("Existing Bot");

      await wrapper.find("#bot-name").setValue("Updated Bot");
      await wrapper.find("form").trigger("submit.prevent");
      await flushPromises();

      expect(updateSpy).toHaveBeenCalledWith("i1", "bot_1", expect.objectContaining({
        name: "Updated Bot",
      }));
      expect(wrapper.emitted("saved")).toBeTruthy();
    });
    it("sends only touched fields on edit so a remote rev2 is not clobbered", async () => {
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
      vi.spyOn(instances, "loadFormOptions").mockResolvedValue(undefined);
      const directBots = useDirectBotsStore();
      // Hydrate at rev1 with stale instructions; a remote client then moves
      // the Bot to rev2 (new instructions + model) via bots-changed.
      vi.spyOn(directBots, "loadBotDetail").mockResolvedValue({
        id: "bot_1", name: "Existing Bot", agent: "codex", workspace: "repo",
        instructions: "rev1 instructions", model: "rev1-model",
        enabled: true, profileRevision: 1,
        createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z",
      });
      const updateSpy = vi.spyOn(directBots, "updateBot").mockResolvedValue({
        id: "bot_1",
        name: "Renamed Bot",
        agent: "codex",
        workspace: "repo",
        enabled: true,
        profileRevision: 3,
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
      });
      const existingBot: BotSummaryDto = {
        id: "bot_1",
        name: "Existing Bot",
        agent: "codex",
        workspace: "repo",
        enabled: true,
        updatedAt: "2026-09-18T00:00:00.000Z",
      };
      const wrapper = mount(BotDialog, {
        props: {
          instanceId: "i1",
          instanceName: "Local",
          bot: existingBot,
        },
        global: {
          plugins: [i18n],
        },
      });
      await flushPromises();
      await flushPromises();
      // Local user touches only the name; remote rev2 rows must not go out.
      await wrapper.find("#bot-name").setValue("Renamed Bot");
      await wrapper.find("form").trigger("submit.prevent");
      await flushPromises();
      expect(updateSpy).toHaveBeenCalledTimes(1);
      const patch = updateSpy.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(patch.name).toBe("Renamed Bot");
      expect(patch).not.toHaveProperty("instructions");
      expect(patch).not.toHaveProperty("model");
      expect(patch).not.toHaveProperty("effort");
      expect(patch).not.toHaveProperty("agent");
      expect(patch).not.toHaveProperty("workspace");
    });

    it("locks agent/workspace once authoritative detail resolves hasRuntime=true", async () => {
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
          agentCatalog: [],
        } as never,
      ];
      const directBots = useDirectBotsStore();
      directBots.botsByInstance["i1"] = [
        {
          id: "bot_1", name: "Existing Bot", agent: "codex", workspace: "repo",
          enabled: true, updatedAt: "2026-09-18T00:00:00.000Z",
        },
      ];
      const detailGate = Promise.withResolvers<{ bot: BotDetailDto }>();
      const loadDetailSpy = vi.spyOn(directBots, "loadBotDetail").mockImplementation(async () => {
        const res = await detailGate.promise;
        directBots.botDetails["i1:bot_1"] = res.bot;
        return res.bot;
      });
      const existingBot: BotSummaryDto = {
        id: "bot_1",
        name: "Existing Bot",
        agent: "codex",
        workspace: "repo",
        enabled: true,
        updatedAt: "2026-09-18T00:00:00.000Z",
      };
      const wrapper = mount(BotDialog, {
        props: { instanceId: "i1", instanceName: "Local", bot: existingBot },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      // Unlocked before the authoritative detail arrives.
      expect((wrapper.find("#bot-agent").element as HTMLSelectElement).disabled).toBe(false);
      expect((wrapper.find("#bot-workspace").element as HTMLSelectElement).disabled).toBe(false);

      detailGate.resolve({
        bot: {
          id: "bot_1", name: "Existing Bot", agent: "codex", workspace: "repo",
          enabled: true, profileRevision: 2,
          createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:01:00.000Z",
          hasRuntime: true,
        },
      });
      await flushPromises();
      await flushPromises();

      expect(loadDetailSpy).toHaveBeenCalledWith("i1", "bot_1");
      expect((wrapper.find("#bot-agent").element as HTMLSelectElement).disabled).toBe(true);
      expect((wrapper.find("#bot-workspace").element as HTMLSelectElement).disabled).toBe(true);
    });

    it("locks an open dialog when the list row converges hasRuntime=true despite a stale detail row", async () => {
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
          agentCatalog: [],
        } as never,
      ];
      const directBots = useDirectBotsStore();
      directBots.botsByInstance["i1"] = [
        {
          id: "bot_1", name: "Existing Bot", agent: "codex", workspace: "repo",
          enabled: true, updatedAt: "2026-09-18T00:00:00.000Z",
        },
      ];
      // Faithful store semantics: the mount-time detail load writes a
      // hasRuntime-unset row into botDetails (production loadBotDetail does
      // this; a mockResolvedValue return alone would skip the cache write).
      vi.spyOn(directBots, "loadBotDetail").mockImplementation(async () => {
        const detail: BotDetailDto = {
          id: "bot_1", name: "Existing Bot", agent: "codex", workspace: "repo",
          enabled: true, profileRevision: 1,
          createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z",
        };
        directBots.botDetails["i1:bot_1"] = detail;
        return detail;
      });
      const existingBot: BotSummaryDto = {
        id: "bot_1",
        name: "Existing Bot",
        agent: "codex",
        workspace: "repo",
        enabled: true,
        updatedAt: "2026-09-18T00:00:00.000Z",
      };
      const wrapper = mount(BotDialog, {
        props: { instanceId: "i1", instanceName: "Local", bot: existingBot },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      expect((wrapper.find("#bot-agent").element as HTMLSelectElement).disabled).toBe(false);

      // Later catalog lifecycle convergence (e.g. remote topic creation for
      // this Bot) flips only the list row to hasRuntime=true while the stale
      // detail row stays unset; the open dialog must still lock without
      // close/reopen.
      directBots.botsByInstance["i1"] = [
        {
          id: "bot_1", name: "Existing Bot", agent: "codex", workspace: "repo",
          enabled: true, updatedAt: "2026-09-18T00:00:00.000Z", hasRuntime: true,
        },
      ];
      await flushPromises();
      await wrapper.vm.$nextTick();

      expect((wrapper.find("#bot-agent").element as HTMLSelectElement).disabled).toBe(true);
      expect((wrapper.find("#bot-workspace").element as HTMLSelectElement).disabled).toBe(true);
    });

    it("keeps newer instructions when a stale detail response resolves after a newer one", async () => {
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
          agentCatalog: [],
        } as never,
      ];
      const directBots = useDirectBotsStore();
      const older = Promise.withResolvers<{ bot: BotDetailDto }>();
      const newer = Promise.withResolvers<{ bot: BotDetailDto }>();
      let calls = 0;
      vi.spyOn(directBots, "loadBotDetail").mockImplementation(async (iid: string, bid: string) => {
        calls += 1;
        if (calls === 1) {
          const res = await older.promise;
          // Faithful stale path: the store drops the write but returns the
          // current (newer) cache instead of the stale payload.
          const key = `${iid}:${bid}`;
          return directBots.botDetails[key] ?? res.bot;
        }
        const res = await newer.promise;
        directBots.botDetails[`${iid}:${bid}`] = res.bot;
        return res.bot;
      });
      const existingBot = {
        id: "bot_1", name: "Bot", agent: "codex", workspace: "repo",
      } as never;
      const wrapper = mount(BotDialog, {
        props: { instanceId: "i1", instanceName: "Local", bot: existingBot },
        global: { plugins: [i18n] },
      });
      const first = directBots.loadBotDetail("i1", "bot_1");
      const second = directBots.loadBotDetail("i1", "bot_1");
      newer.resolve({
        bot: {
          id: "bot_1", name: "Bot", agent: "codex", workspace: "repo",
          instructions: "New", enabled: true, profileRevision: 2,
          createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "new",
        },
      });
      await second;
      older.resolve({
        bot: {
          id: "bot_1", name: "Bot", agent: "codex", workspace: "repo",
          instructions: "Old", enabled: true, profileRevision: 1,
          createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "old",
        },
      });
      const staleResult = await first;
      // Stale D1 must return the newer cache, so a Dialog filling from it
      // keeps New instead of rolling back to Old.
      expect(staleResult.instructions).toBe("New");
      expect(directBots.botDetails["i1:bot_1"]?.instructions).toBe("New");
      expect(wrapper.vm).toBeTruthy();
    });

    it("blocks Save until summary-backed detail hydration completes", async () => {
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
          agentCatalog: [],
        } as never,
      ];
      const directBots = useDirectBotsStore();
      const detailGate = Promise.withResolvers<{ bot: BotDetailDto }>();
      const updateSpy = vi.spyOn(directBots, "updateBot").mockResolvedValue({
        id: "bot_1", name: "Renamed", agent: "codex", workspace: "repo",
        enabled: true, profileRevision: 2,
        createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z",
      });
      vi.spyOn(directBots, "loadBotDetail").mockImplementation(async () => {
        const res = await detailGate.promise;
        directBots.botDetails["i1:bot_1"] = res.bot;
        return res.bot;
      });
      // Summary-backed edit: no instructions field, so hydration is required.
      const existingBot: BotSummaryDto = {
        id: "bot_1", name: "Bot", agent: "codex", workspace: "repo",
        enabled: true, updatedAt: "2026-09-18T00:00:00.000Z",
      };
      const wrapper = mount(BotDialog, {
        props: { instanceId: "i1", instanceName: "Local", bot: existingBot },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      await wrapper.find("#bot-name").setValue("Renamed");

      // Detail still deferred: Save is disabled and submit is gated.
      const saveBtn = wrapper.findAll("button").find((b) => b.text().includes("Save"));
      expect(saveBtn).toBeTruthy();
      expect((saveBtn!.element as HTMLButtonElement).disabled).toBe(true);
      await wrapper.find("form").trigger("submit.prevent");
      await flushPromises();
      expect(updateSpy).not.toHaveBeenCalled();
      expect(directBots.botDetails["i1:bot_1"]).toBeUndefined();

      // Authoritative detail arrives with backend instructions.
      detailGate.resolve({
        bot: {
          id: "bot_1", name: "Bot", agent: "codex", workspace: "repo",
          instructions: "Review races", enabled: true, profileRevision: 1,
          createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z",
        },
      });
      await flushPromises();
      await flushPromises();

      // Hydrated: Save is enabled and shows the backend instructions.
      expect((saveBtn!.element as HTMLButtonElement).disabled).toBe(false);
      expect((wrapper.find("#bot-instructions").element as HTMLTextAreaElement).value).toBe("Review races");
      await wrapper.find("form").trigger("submit.prevent");
      await flushPromises();
      // Dirty-only submit: only the touched name goes out. The hydrated
      // instructions stay visible in the form but are NOT resent, so a
      // concurrent remote edit cannot be clobbered by this save.
      expect(updateSpy).toHaveBeenCalledWith("i1", "bot_1", { name: "Renamed" });
    });

    it("hydrates every untouched field from the authoritative rev2 detail", async () => {
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
          agentCatalog: [],
        } as never,
      ];
      const directBots = useDirectBotsStore();
      // Sidebar rendered rev1 (model old, enabled true); the authoritative
      // detail is rev2 (model new, enabled false). Only the name is touched.
      vi.spyOn(directBots, "loadBotDetail").mockImplementation(async () => {
        const detail: BotDetailDto = {
          id: "bot_1", name: "Bot", agent: "codex", workspace: "repo",
          model: "new", enabled: false, profileRevision: 2,
          createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "new",
        };
        directBots.botDetails["i1:bot_1"] = detail;
        return detail;
      });
      const updateSpy = vi.spyOn(directBots, "updateBot").mockResolvedValue({
        id: "bot_1", name: "Renamed", agent: "codex", workspace: "repo",
        enabled: false, profileRevision: 3,
        createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z",
      });
      const existingBot: BotSummaryDto = {
        id: "bot_1", name: "Bot", agent: "codex", workspace: "repo",
        model: "old", enabled: true, updatedAt: "2026-09-18T00:00:00.000Z",
      };
      const wrapper = mount(BotDialog, {
        props: { instanceId: "i1", instanceName: "Local", bot: existingBot },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      await flushPromises();
      // Untouched fields converge to rev2; the open-time rev1 values are gone.
      expect((wrapper.find("#bot-model").element as HTMLInputElement).value).toBe("new");
      const enabledCheckbox = wrapper.find('input[type="checkbox"]');
      expect((enabledCheckbox.element as HTMLInputElement).checked).toBe(false);

      await wrapper.find("#bot-name").setValue("Renamed");
      await wrapper.find("form").trigger("submit.prevent");
      await flushPromises();
      // Dirty-only submit: rev2 model/enabled stay displayed but are NOT
      // resent — only the touched name goes out, so this save cannot roll
      // the remote rev2 rows back to the open-time rev1 values.
      expect(updateSpy).toHaveBeenCalledWith("i1", "bot_1", { name: "Renamed" });
    });

    it("keeps a touched-then-reverted model when the authoritative detail resolves", async () => {
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
          agentCatalog: [],
        } as never,
      ];
      const directBots = useDirectBotsStore();
      const detailGate = Promise.withResolvers<{ bot: BotDetailDto }>();
      const updateSpy = vi.spyOn(directBots, "updateBot").mockResolvedValue({
        id: "bot_1", name: "Bot", agent: "codex", workspace: "repo",
        enabled: true, profileRevision: 3,
        createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z",
      });
      vi.spyOn(directBots, "loadBotDetail").mockImplementation(async () => {
        const res = await detailGate.promise;
        directBots.botDetails["i1:bot_1"] = res.bot;
        return res.bot;
      });
      // Open-time summary: model old.
      const existingBot: BotSummaryDto = {
        id: "bot_1", name: "Bot", agent: "codex", workspace: "repo",
        model: "old", enabled: true, updatedAt: "2026-09-18T00:00:00.000Z",
      };
      const wrapper = mount(BotDialog, {
        props: { instanceId: "i1", instanceName: "Local", bot: existingBot },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      // User edits old -> tmp, then deliberately reverts tmp -> old while the
      // detail request is still in flight.
      await wrapper.find("#bot-model").setValue("tmp");
      await wrapper.find("#bot-model").setValue("old");
      // Authoritative rev2 detail arrives with model new.
      detailGate.resolve({
        bot: {
          id: "bot_1", name: "Bot", agent: "codex", workspace: "repo",
          model: "new", enabled: true, profileRevision: 2,
          createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "new",
        },
      });
      await flushPromises();
      await flushPromises();
      // The explicit user choice (old) survives hydration, not rev2 new.
      expect((wrapper.find("#bot-model").element as HTMLInputElement).value).toBe("old");

      await wrapper.find("form").trigger("submit.prevent");
      await flushPromises();
      expect(updateSpy).toHaveBeenCalledWith("i1", "bot_1", expect.objectContaining({
        model: "old",
      }));
    });

    it("keeps a touched-then-reverted agent when the authoritative detail resolves", async () => {
      const instances = useInstancesStore();
      instances.instances = [
        {
          id: "i1",
          name: "Local",
          online: true,
          lastSeenAt: null,
          sessions: [],
          agents: [{ name: "codex", driver: "codex" }, { name: "claude", driver: "claude" }],
          workspaces: [{ name: "repo", cwd: "/repo" }],
          agentCatalog: [],
        } as never,
      ];
      const directBots = useDirectBotsStore();
      const detailGate = Promise.withResolvers<{ bot: BotDetailDto }>();
      const updateSpy = vi.spyOn(directBots, "updateBot").mockResolvedValue({
        id: "bot_1", name: "Bot", agent: "codex", workspace: "repo",
        enabled: true, profileRevision: 3,
        createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z",
      });
      vi.spyOn(directBots, "loadBotDetail").mockImplementation(async () => {
        const res = await detailGate.promise;
        directBots.botDetails["i1:bot_1"] = res.bot;
        return res.bot;
      });
      // Open-time summary: agent codex (bot never materialized, so the
      // select stays editable and backend permits the change).
      const existingBot: BotSummaryDto = {
        id: "bot_1", name: "Bot", agent: "codex", workspace: "repo",
        enabled: true, updatedAt: "2026-09-18T00:00:00.000Z",
      };
      const wrapper = mount(BotDialog, {
        props: { instanceId: "i1", instanceName: "Local", bot: existingBot },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      // User edits codex -> claude, then deliberately reverts claude ->
      // codex while the detail request is still in flight.
      await wrapper.find("#bot-agent").setValue("claude");
      await wrapper.find("#bot-agent").setValue("codex");
      // Authoritative rev2 detail arrives with agent claude.
      detailGate.resolve({
        bot: {
          id: "bot_1", name: "Bot", agent: "claude", workspace: "repo",
          enabled: true, profileRevision: 2,
          createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "new",
        },
      });
      await flushPromises();
      await flushPromises();
      // The explicit user choice (codex) survives hydration, not rev2 claude.
      expect((wrapper.find("#bot-agent").element as HTMLSelectElement).value).toBe("codex");

      await wrapper.find("form").trigger("submit.prevent");
      await flushPromises();
      expect(updateSpy).toHaveBeenCalledWith("i1", "bot_1", expect.objectContaining({
        agent: "codex",
      }));
    });

    it("keeps user-typed instructions when the slow detail fetch resolves", async () => {
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
          agentCatalog: [],
        } as never,
      ];
      const directBots = useDirectBotsStore();
      let resolveDetail!: (value: unknown) => void;
      const detailGate = new Promise<unknown>((resolve) => { resolveDetail = resolve; });
      vi.spyOn(directBots, "loadBotDetail").mockImplementation(() => detailGate as never);
      const existingBot = {
        id: "bot_1",
        name: "Existing Bot",
        agent: "codex",
        workspace: "repo",
        enabled: true,
        updatedAt: "2026-09-18T00:00:00.000Z",
      } as never;
      const wrapper = mount(BotDialog, {
        props: { instanceId: "i1", instanceName: "Local", bot: existingBot },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      await wrapper.find("#bot-instructions").setValue("User typed instructions");
      resolveDetail({
        id: "bot_1",
        name: "Existing Bot",
        agent: "codex",
        workspace: "repo",
        instructions: "Server instructions",
        enabled: true,
        profileRevision: 2,
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
      });
      await flushPromises();
      expect((wrapper.find("#bot-instructions").element as HTMLTextAreaElement).value).toBe("User typed instructions");
    });

    it("keeps a user-cleared instructions field when the slow detail fetch resolves", async () => {
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
          agentCatalog: [],
        } as never,
      ];
      const directBots = useDirectBotsStore();
      let resolveDetail!: (value: unknown) => void;
      const detailGate = new Promise<unknown>((resolve) => { resolveDetail = resolve; });
      vi.spyOn(directBots, "loadBotDetail").mockImplementation(() => detailGate as never);
      const existingBot = {
        id: "bot_1",
        name: "Existing Bot",
        agent: "codex",
        workspace: "repo",
        enabled: true,
        updatedAt: "2026-09-18T00:00:00.000Z",
      } as never;
      const wrapper = mount(BotDialog, {
        props: { instanceId: "i1", instanceName: "Local", bot: existingBot },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      // Type then clear back to "": value comparison alone would call this
      // pristine and let the server value overwrite the explicit clear.
      await wrapper.find("#bot-instructions").setValue("draft");
      await wrapper.find("#bot-instructions").setValue("");
      resolveDetail({
        id: "bot_1",
        name: "Existing Bot",
        agent: "codex",
        workspace: "repo",
        instructions: "Server instructions",
        enabled: true,
        profileRevision: 2,
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
      });
      await flushPromises();
      expect((wrapper.find("#bot-instructions").element as HTMLTextAreaElement).value).toBe("");
    });

    it("loads form options then instructions without a stale race overwriting fields", async () => {
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
          agentCatalog: [],
        } as never,
      ];
      const directBots = useDirectBotsStore();
      let resolveOptions!: () => void;
      const optionsGate = new Promise<void>((resolve) => { resolveOptions = resolve; });
      const optionsSpy = vi.spyOn(instances, "loadFormOptions").mockImplementation(async () => {
        await optionsGate;
        instances.instances = [
          {
            id: "i1",
            name: "Local",
            online: true,
            lastSeenAt: null,
            sessions: [],
            agents: [{ name: "codex", driver: "codex" }],
            workspaces: [{ name: "repo", cwd: "/repo" }],
            agentCatalog: [],
          } as never,
        ];
      });
      const detailSpy = vi.spyOn(directBots, "loadBotDetail").mockResolvedValue({
        id: "bot_1",
        name: "Existing Bot",
        agent: "codex",
        workspace: "repo",
        instructions: "Server instructions",
        enabled: true,
        profileRevision: 2,
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
      });
      const existingBot: BotSummaryDto = {
        id: "bot_1",
        name: "Existing Bot",
        agent: "codex",
        workspace: "repo",
        enabled: true,
        updatedAt: "2026-09-18T00:00:00.000Z",
      };
      const wrapper = mount(BotDialog, {
        props: { instanceId: "i1", instanceName: "Local", bot: existingBot },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      wrapper.unmount();
      resolveOptions();
      await flushPromises();
      expect(optionsSpy).toHaveBeenCalledWith("i1");
      expect(detailSpy).not.toHaveBeenCalled();
    });
  });

  describe("ConversationPromptInput.vue", () => {
    it("emits send on Enter and disables send when empty", async () => {
      const directBots = useDirectBotsStore();
      directBots.instanceId = "i1";
      directBots.selectedBotId = "b1";
      directBots.activeConversationId = "c1";

      const wrapper = mount(ConversationPromptInput, {
        global: {
          plugins: [i18n],
        },
      });

      const sendBtn = wrapper.find('[data-test="send-prompt-button"]');
      expect((sendBtn.element as HTMLButtonElement).disabled).toBe(true);

      const textarea = wrapper.find("textarea");
      await textarea.setValue("Hello world");
      expect((sendBtn.element as HTMLButtonElement).disabled).toBe(false);

      await textarea.trigger("keydown", { key: "Enter", shiftKey: false });
      expect(wrapper.emitted("send")?.[0]).toEqual(["Hello world"]);
    });

    it("displays stop run button, disables textarea, and blocks Enter when a run is active", async () => {
      const directBots = useDirectBotsStore();
      directBots.activeRun = {
        id: "run_1",
        conversationId: "c1",
        topicId: "t1",
        requestMessageId: "m1",
        requestId: "r1",
        mode: "explicit",
        state: "running",
        profileRevision: 1,
        createdAt: "2026-09-18T00:00:00.000Z",
      };

      const wrapper = mount(ConversationPromptInput, {
        global: {
          plugins: [i18n],
        },
      });

      // Textarea is disabled during active run
      const textarea = wrapper.find("textarea");
      expect((textarea.element as HTMLTextAreaElement).disabled).toBe(true);

      // Pressing Enter does NOT emit send
      await textarea.trigger("keydown", { key: "Enter", shiftKey: false });
      expect(wrapper.emitted("send")).toBeUndefined();

      // Stop button is shown and emits cancel
      const stopBtn = wrapper.find('[data-test="stop-run-button"]');
      expect(stopBtn.exists()).toBe(true);
      await stopBtn.trigger("click");
      expect(wrapper.emitted("cancel")).toBeTruthy();
    });

    it("disables the composer while topic recovery is still in flight", async () => {
      const directBots = useDirectBotsStore();
      directBots.instanceId = "i1";
      directBots.selectedBotId = "b1";
      directBots.activeConversationId = "c1";
      directBots.activeTopicId = "t1";
      directBots.botsByInstance["i1"] = [
        { id: "b1", name: "Bot", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
      ];
      directBots.topicReady = false;

      const wrapper = mount(ConversationPromptInput, {
        global: {
          plugins: [i18n],
        },
      });

      const textarea = wrapper.find("textarea");
      expect((textarea.element as HTMLTextAreaElement).disabled).toBe(true);
      expect((textarea.element as HTMLTextAreaElement).placeholder).toContain("Recovering");
      await textarea.setValue("too early");
      await textarea.trigger("keydown", { key: "Enter", shiftKey: false });
      expect(wrapper.emitted("send")).toBeUndefined();
    });
    it("shows warning when bot is disabled", async () => {
      const directBots = useDirectBotsStore();
      directBots.instanceId = "i1";
      directBots.selectedBotId = "b1";
      directBots.botsByInstance["i1"] = [
        { id: "b1", name: "DisabledBot", agent: "codex", workspace: "repo", enabled: false, updatedAt: "now" },
      ];

      const wrapper = mount(ConversationPromptInput, {
        global: {
          plugins: [i18n],
        },
      });

      expect(wrapper.text()).toContain("disabled");
      const textarea = wrapper.find("textarea");
      expect((textarea.element as HTMLTextAreaElement).disabled).toBe(true);
    });
  });

  describe("ConversationMessageList.vue", () => {
    it("renders human and bot messages", async () => {
      const messages: ConversationMessageDto[] = [
        {
          id: "msg_1",
          conversationId: "c1",
          topicId: "t1",
          seq: 1,
          role: "human",
          content: "Can you review this?",
          createdAt: "2026-09-18T00:01:00.000Z",
        },
        {
          id: "msg_2",
          conversationId: "c1",
          topicId: "t1",
          seq: 2,
          role: "bot",
          content: "Looks good to me!",
          createdAt: "2026-09-18T00:02:00.000Z",
        },
      ];

      const wrapper = mount(ConversationMessageList, {
        props: {
          messages,
          liveTurn: null,
          activeRun: null,
          activeMemberTurn: null,
          runParts: {},
          bot: { id: "b1", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
        },
        global: {
          plugins: [i18n],
        },
      });

      expect(wrapper.text()).toContain("Can you review this?");
      expect(wrapper.text()).toContain("Looks good to me!");
    });

    it("renders live turn with status HUD and stop button", async () => {
      const activeRun: ConversationRunDto = {
        id: "run_1",
        conversationId: "c1",
        topicId: "t1",
        requestMessageId: "m1",
        requestId: "r1",
        mode: "explicit",
        state: "running",
        profileRevision: 1,
        createdAt: "2026-09-18T00:00:00.000Z",
      };

      const wrapper = mount(ConversationMessageList, {
        props: {
          messages: [],
          liveTurn: {
            parts: [{ type: "text", text: "Analyzing code..." }],
            status: "streaming",
            startedAt: Date.now(),
            revision: 1,
          },
          activeRun,
          activeMemberTurn: null,
          runParts: {},
          bot: { id: "b1", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
        },
        global: {
          plugins: [i18n],
        },
      });

      expect(wrapper.find('[data-test="live-turn-container"]').exists()).toBe(true);
      expect(wrapper.text()).toContain("Running");
      expect(wrapper.text()).toContain("Analyzing code...");

      const stopBtn = wrapper.find('[data-test="stop-turn-hud-button"]');
      expect(stopBtn.exists()).toBe(true);
      await stopBtn.trigger("click");
      expect(wrapper.emitted("cancelRun")).toBeTruthy();
    });

    it("hides the HUD stop button for terminal runs so no second cancel fires", async () => {
      const terminalRun: ConversationRunDto = {
        id: "run_done",
        conversationId: "c1",
        topicId: "t1",
        requestMessageId: "m1",
        requestId: "r1",
        mode: "explicit",
        state: "cancelled",
        profileRevision: 1,
        createdAt: "2026-09-18T00:00:00.000Z",
      };
      const wrapper = mount(ConversationMessageList, {
        props: {
          messages: [],
          liveTurn: null,
          activeRun: terminalRun,
          activeMemberTurn: null,
          runParts: {},
          bot: { id: "b1", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
        },
        global: {
          plugins: [i18n],
        },
      });
      expect(wrapper.find('[data-test="live-turn-container"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="stop-turn-hud-button"]').exists()).toBe(false);
      expect(wrapper.text()).toContain("Run cancelled");
    });

    it("renders load older messages button and emits event", async () => {
      const wrapper = mount(ConversationMessageList, {
        props: {
          messages: [{ id: "m1", conversationId: "c1", topicId: "t1", seq: 5, role: "human", content: "Hi", createdAt: "now" }],
          liveTurn: null,
          activeRun: null,
          activeMemberTurn: null,
          runParts: {},
          hasMoreOlder: true,
        },
        global: {
          plugins: [i18n],
        },
      });

      const loadOlderBtn = wrapper.find('[data-test="load-older-button"]');
      expect(loadOlderBtn.exists()).toBe(true);

      await loadOlderBtn.trigger("click");
      expect(wrapper.emitted("loadOlder")).toBeTruthy();
    });

    it("awaits async loadOlder prop and preserves scroll distance from bottom", async () => {
      const messages: ConversationMessageDto[] = [
        { id: "m2", conversationId: "c1", topicId: "t1", seq: 2, role: "human", content: "Second", createdAt: "now" },
      ];

      const loadOlderFn = vi.fn().mockImplementation(async () => {
        messages.unshift({
          id: "m1",
          conversationId: "c1",
          topicId: "t1",
          seq: 1,
          role: "human",
          content: "First",
          createdAt: "now",
        });
      });

      const wrapper = mount(ConversationMessageList, {
        props: {
          messages,
          liveTurn: null,
          activeRun: null,
          activeMemberTurn: null,
          runParts: {},
          hasMoreOlder: true,
          loadOlder: loadOlderFn,
        },
        global: {
          plugins: [i18n],
        },
      });

      const scrollerEl = wrapper.element as HTMLElement;
      // Simulate initial scroll position before loading older:
      // e.g. scrollHeight = 500, scrollTop = 100 -> distance from bottom anchor = 400
      Object.defineProperty(scrollerEl, "scrollHeight", {
        configurable: true,
        get: () => (messages.length === 2 ? 800 : 500),
      });
      scrollerEl.scrollTop = 100;

      const loadOlderBtn = wrapper.find('[data-test="load-older-button"]');
      await loadOlderBtn.trigger("click");
      await flushPromises();

      expect(loadOlderFn).toHaveBeenCalledTimes(1);
      // Anchor was 500 - 100 = 400.
      // After prepending, scrollHeight is 800, so new scrollTop = 800 - 400 = 400.
      expect(scrollerEl.scrollTop).toBe(400);
    });
    it("follows in-place text growth inside one part while at bottom", async () => {
      const textPart = { type: "text", text: "Hello" } as { type: "text"; text: string };
      const liveTurn: { parts: { type: "text"; text: string }[]; status: "streaming"; startedAt: number; revision: number } = {
        parts: [textPart],
        status: "streaming",
        startedAt: Date.now(),
        revision: 1,
      };
      const activeRun = {
        id: "run_1", conversationId: "c1", topicId: "t1", requestMessageId: "m1",
        requestId: "r1", mode: "explicit", state: "running", profileRevision: 1,
        createdAt: "now",
      } as never;
      const wrapper = mount(ConversationMessageList, {
        props: {
          messages: [],
          liveTurn,
          activeRun,
          activeMemberTurn: null,
          runParts: {},
        },
        global: {
          plugins: [i18n],
        },
      });
      const scrollerEl = wrapper.element as HTMLElement;
      let scrollCalls = 0;
      const recordScroll: typeof scrollerEl.scrollTo = () => { scrollCalls += 1; };
      scrollerEl.scrollTo = recordScroll;
      // In-place growth: same part object extended (store appendText mutates
      // last.text), so parts.length stays 1 while the transcript grows; the
      // store bumps revision, which is what the follower watches.
      textPart.text = "Hello world, streaming more tokens";
      await wrapper.setProps({ liveTurn: { parts: [textPart], status: "streaming", startedAt: liveTurn.startedAt, revision: 2 } });
      await flushPromises();
      expect(scrollCalls).toBeGreaterThan(0);
    });
    it("follows in-place tool updates with an unchanged toolCallId while at bottom", async () => {
      const toolStep = { toolCallId: "call_1", toolName: "bash", kind: "command", status: "running", title: "ls" } as unknown as ToolStepDto;
      const toolPart = { type: "tool", step: toolStep } as TurnPartDto;
      const liveTurn: { parts: TurnPartDto[]; status: "streaming"; startedAt: number; revision: number } = {
        parts: [toolPart],
        status: "streaming",
        startedAt: Date.now(),
        revision: 1,
      };
      const activeRun = {
        id: "run_1", conversationId: "c1", topicId: "t1", requestMessageId: "m1",
        requestId: "r1", mode: "explicit", state: "running", profileRevision: 1,
        createdAt: "now",
      } as never;
      const wrapper = mount(ConversationMessageList, {
        props: {
          messages: [],
          liveTurn,
          activeRun,
          activeMemberTurn: null,
          runParts: {},
        },
        global: {
          plugins: [i18n],
        },
      });
      const scrollerEl = wrapper.element as HTMLElement;
      let scrollCalls = 0;
      const recordScroll: typeof scrollerEl.scrollTo = () => { scrollCalls += 1; };
      scrollerEl.scrollTo = recordScroll;
      // Same toolCallId, new status (store upsertTool replaces the row):
      // the old toolCallId.length heuristic never fired; revision does.
      toolStep.status = "success";
      await wrapper.setProps({ liveTurn: { parts: [toolPart], status: "streaming", startedAt: liveTurn.startedAt, revision: 2 } });
      await flushPromises();
      expect(scrollCalls).toBeGreaterThan(0);
    });
  });

  describe("DirectBotPane.vue", () => {
    it("renders bot header, topics, and handles topic switching", async () => {
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

      const directBots = useDirectBotsStore();
      directBots.instanceId = "i1";
      directBots.selectedBotId = "b1";
      directBots.activeConversationId = "c1";
      directBots.activeTopicId = "t1";
      directBots.botsByInstance["i1"] = [
        { id: "b1", name: "ReviewerBot", agent: "codex", workspace: "repo", role: "Code QA", enabled: true, updatedAt: "now" },
      ];
      directBots.topicsByConversation["i1:c1"] = [
        { id: "t1", conversationId: "c1", title: "Default", status: "active", createdAt: "now", updatedAt: "now" },
        { id: "t2", conversationId: "c1", title: "PR Review", status: "active", createdAt: "now", updatedAt: "now" },
      ];

      const switchTopicSpy = vi.spyOn(directBots, "switchTopic").mockResolvedValue();

      const wrapper = mount(DirectBotPane, {
        global: {
          plugins: [i18n],
        },
      });

      expect(wrapper.text()).toContain("ReviewerBot");
      expect(wrapper.text()).toContain("Code QA");
      expect(wrapper.text()).toContain("repo");

      const topicPills = wrapper.findAll('[data-test="topic-pill"]');
      expect(topicPills).toHaveLength(2);

      await topicPills[1]?.trigger("click");
      expect(switchTopicSpy).toHaveBeenCalledWith("t2");
    });
    it("opens the New Topic dialog with focus, traps Tab, and restores focus on Escape", async () => {
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
      const directBots = useDirectBotsStore();
      directBots.instanceId = "i1";
      directBots.selectedBotId = "b1";
      directBots.activeConversationId = "c1";
      directBots.activeTopicId = "t1";
      directBots.botsByInstance["i1"] = [
        { id: "b1", name: "ReviewerBot", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
      ];
      directBots.topicsByConversation["i1:c1"] = [
        { id: "t1", conversationId: "c1", title: "Default", status: "active", createdAt: "now", updatedAt: "now" },
      ];
      const wrapper = mount(DirectBotPane, {
        attachTo: document.body,
        global: {
          plugins: [i18n],
        },
      });
      const trigger = wrapper.find('[data-test="new-topic-button"]');
      (trigger.element as HTMLElement).focus();
      await trigger.trigger("click");
      await flushPromises();
      const dialog = wrapper.find('[role="dialog"]');
      expect(dialog.exists()).toBe(true);
      expect(dialog.attributes("aria-modal")).toBe("true");
      // Opening focus moves inside the dialog (first field), not the trigger.
      expect(dialog.element.contains(document.activeElement)).toBe(true);
      // Tab on the last focusable wraps to the first (focus trap).
      const focusables = dialog.element.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      );
      expect(focusables.length).toBeGreaterThan(1);
      const last = focusables[focusables.length - 1];
      const first = focusables[0];
      if (!last || !first) throw new Error("expected focusable dialog controls");
      last.focus();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      expect(document.activeElement).toBe(first);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await flushPromises();
      expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
      // Closing focus restores to the trigger that opened the dialog.
      expect(document.activeElement).toBe(trigger.element);
      wrapper.unmount();
    });
  });

  describe("InstanceTree.vue with Bots navigation", () => {
    it("switches between Sessions and Bots mode, lists bots, and selects bot", async () => {
      const instances = useInstancesStore();
      instances.instances = [
        {
          id: "i1",
          name: "Local",
          online: true,
          lastSeenAt: null,
          sessions: [{ alias: "session_1", agent: "codex", workspace: "repo" }],
          sessionsLoaded: true,
          agents: [{ name: "codex", driver: "codex" }],
          workspaces: [{ name: "repo", cwd: "/repo" }],
        } as never,
      ];

      const directBots = useDirectBotsStore();
      directBots.botsByInstance["i1"] = [
        { id: "b1", name: "SecurityBot", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
      ];
      directBots.botsLoaded["i1"] = true;

      const chat = useChatStore();
      chat.select("i1", "session_1");

      const selectBotSpy = vi.spyOn(directBots, "selectBot").mockResolvedValue();

      const wrapper = mount(InstanceTree, {
        global: {
          plugins: [i18n],
        },
      });
      await flushPromises();

      // Switch to Bots mode
      const botsNavBtn = wrapper.find('[data-test="instance-nav-bots"]');
      expect(botsNavBtn.exists()).toBe(true);
      await botsNavBtn.trigger("click");

      // Verify Bot row is displayed
      const botRow = wrapper.find('[data-test="bot-row"]');
      expect(botRow.exists()).toBe(true);
      expect(botRow.text()).toContain("SecurityBot");

      // Click bot row
      await botRow.find("button").trigger("click");
      // InstanceTree is pure presenter: emits selectBot and leaves selection coordination to parent DashboardView
      expect(wrapper.emitted("selectBot")?.[0]).toEqual(["i1", "b1"]);
      expect(selectBotSpy).not.toHaveBeenCalled();
    });
  });
});
