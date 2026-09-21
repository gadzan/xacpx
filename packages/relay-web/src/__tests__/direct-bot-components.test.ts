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

      // Hydrated: Save is enabled and preserves the backend instructions.
      expect((saveBtn!.element as HTMLButtonElement).disabled).toBe(false);
      expect((wrapper.find("#bot-instructions").element as HTMLTextAreaElement).value).toBe("Review races");
      await wrapper.find("form").trigger("submit.prevent");
      await flushPromises();
      expect(updateSpy).toHaveBeenCalledWith("i1", "bot_1", expect.objectContaining({
        name: "Renamed",
        instructions: "Review races",
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
      expect(wrapper.text()).toContain("running");
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
