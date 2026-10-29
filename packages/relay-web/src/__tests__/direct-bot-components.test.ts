import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import {
  RELAY_CAPABILITIES,
  needsSetupCapability,
  readyCapability,
  type BotDetailDto,
  type BotSummaryDto,
  type ConversationMessageDto,
  type ConversationRunDto,
  type MemberTurnSummaryDto,
  type TopicSummaryDto,
  type ToolStepDto,
  type TurnPartDto,
} from "@ganglion/xacpx-relay-protocol";
import { i18n } from "../i18n";
import { api } from "../api/client";
import { dismissToast, useToasts } from "../lib/use-toasts";
import { useInstancesStore } from "../stores/instances";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useGroupsStore } from "../stores/groups";
import { useChatStore } from "../stores/chat";
import { useComposerStore } from "../stores/composer";
import BotDialog from "../components/BotDialog.vue";
import ConversationPromptInput from "../components/ConversationPromptInput.vue";
import ConversationMessageList from "../components/ConversationMessageList.vue";
import DirectBotPane from "../components/DirectBotPane.vue";
import InstanceTree from "../components/InstanceTree.vue";

// Keep form/store assertions local; browser E2E covers the real Teleport layout.
config.global.stubs.teleport = true;

function seedLocalInstance(): void {
  useInstancesStore().instances = [
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
}

describe("Direct Bot Components", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("BotDialog.vue", () => {
    beforeEach(() => {
      vi.spyOn(useInstancesStore(), "getAgentCapabilities").mockResolvedValue(needsSetupCapability(
        { code: "discovery-available", message: "no saved model list" },
        "Fetch the model list.",
        { fetchedAt: "2026-10-09T00:00:00.000Z" },
      ));
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

      vi.spyOn(useInstancesStore(), "getAgentCapabilities").mockResolvedValue(readyCapability("runtime", [
        { modelId: "gpt-real" },
      ], {
        fetchedAt: "2026-10-09T00:00:00.000Z",
        efforts: {
          status: "known",
          options: [
            { id: "medium", name: "medium", source: "adapter" },
            { id: "high", name: "high", source: "adapter" },
            { id: "xhigh", name: "xhigh", source: "adapter" },
          ],
        },
      }));
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

      const effortSelect = wrapper.find('[data-test="model-picker-effort"]');
      expect(effortSelect.exists()).toBe(true);
      await effortSelect.trigger("click");
      const values = wrapper.findAll('[data-test="effort-option"]').map((o) => o.attributes("data-value"));
      // Must include Default, medium, high, and xhigh
      expect(values).toEqual(["", "medium", "high", "xhigh"]);
      // Unadvertised low and max must NOT be present
      expect(values).not.toContain("low");
      expect(values).not.toContain("max");
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

      const effortInput = wrapper.find('[data-test="model-picker-effort"]');
      expect(effortInput.element.tagName).toBe("INPUT");
      expect(wrapper.find("datalist#bot-effort-options").exists()).toBe(false);
      expect(wrapper.text()).not.toContain("max");
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
      const options = wrapper.find("#bot-agent");
      await options.trigger("click");
      const values = wrapper.findAll("[data-value]").map((o) => o.attributes("data-value"));
      expect(values).toEqual(["reviewer"]);
    });

    it.each([
      { label: "dedicated workspace by default", workspaces: [{ name: "repo", cwd: "/repo" }], selectedWorkspace: undefined },
      { label: "dedicated workspace with no registered workspaces", workspaces: [], selectedWorkspace: undefined },
      { label: "an explicitly selected workspace", workspaces: [{ name: "repo", cwd: "/repo" }], selectedWorkspace: "repo" },
    ])("submits create bot with $label", async ({ workspaces, selectedWorkspace }) => {
      const instances = useInstancesStore();
      instances.instances = [
        {
          id: "i1",
          name: "Local",
          online: true,
          lastSeenAt: null,
          sessions: [],
          capabilities: [RELAY_CAPABILITIES.botsDedicatedWorkspaceV1],
          agents: [{ name: "codex", driver: "codex" }],
          workspaces,
          agentCatalog: [],
        } as never,
      ];

      vi.spyOn(instances, "loadFormOptions").mockResolvedValue(undefined);
      const directBots = useDirectBotsStore();
      const createSpy = vi.spyOn(directBots, "createBot").mockResolvedValue({
        id: "bot_1",
        name: "Code Reviewer",
        agent: "codex",
        workspace: selectedWorkspace ?? "code-reviewer",
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
      expect(wrapper.find("#bot-workspace").attributes("data-selected")).toBe("");
      expect(wrapper.find("#bot-workspace").text()).toContain(i18n.global.t("bot.fields.dedicatedWorkspace"));
      expect(wrapper.find('[data-test="bot-dedicated-workspace-hint"]').text()).toContain("~/.xacpx/bots/");
      if (selectedWorkspace) {
        await wrapper.find("#bot-workspace").trigger("click");
        await wrapper.find(`[data-value="${selectedWorkspace}"]`).trigger("click");
        expect(wrapper.find('[data-test="bot-dedicated-workspace-hint"]').exists()).toBe(false);
      }
      if (workspaces.length > 0) {
        expect(instances.getAgentCapabilities).toHaveBeenCalledWith("i1", { agent: "codex", workspace: "repo" });
      } else {
        expect(instances.getAgentCapabilities).not.toHaveBeenCalled();
        expect(wrapper.find('[data-test="model-picker-loading"]').exists()).toBe(false);
      }

      await wrapper.find("#bot-name").setValue("Code Reviewer");
      await wrapper.find("#bot-instructions").setValue("Look for bugs");
      await wrapper.find('[data-test="bot-model"]').setValue("custom-model");
      await wrapper.find('[data-test="model-picker-effort"]').setValue("high");
      await wrapper.find("form").trigger("submit.prevent");
      await flushPromises();

      expect(createSpy).toHaveBeenCalledWith("i1", expect.objectContaining({
        name: "Code Reviewer",
        agent: "codex",
        // The create-time avatar is drawn at random; only its character shape is contractual.
        avatar: expect.objectContaining({ version: 1, kind: "character", motion: "auto" }),
        instructions: "Look for bugs",
        model: "custom-model",
        effort: "high",
        enabled: true,
      }));
      const payload = createSpy.mock.calls[0]![1];
      if (selectedWorkspace) expect(payload.workspace).toBe(selectedWorkspace);
      else expect(payload).not.toHaveProperty("workspace");
      expect(wrapper.emitted("saved")).toBeTruthy();
      expect(wrapper.emitted("close")).toBeTruthy();
    });

    function mountCreateDialog(opts: { dedicated: boolean; createImpl?: () => Promise<never>; workspaces?: Array<{ name: string; cwd: string }> }) {
      const instances = useInstancesStore();
      instances.instances = [
        {
          id: "i1",
          name: "Local",
          online: true,
          lastSeenAt: null,
          sessions: [],
          agents: [{ name: "codex", driver: "codex" }],
          workspaces: opts.workspaces ?? [{ name: "repo", cwd: "/repo" }],
          agentCatalog: [],
          ...(opts.dedicated ? { capabilities: [RELAY_CAPABILITIES.botsDedicatedWorkspaceV1] } : { capabilities: [] }),
        } as never,
      ];
      vi.spyOn(instances, "loadFormOptions").mockResolvedValue(undefined);
      const directBots = useDirectBotsStore();
      const createSpy = vi.spyOn(directBots, "createBot");
      if (opts.createImpl) createSpy.mockImplementation(opts.createImpl);
      else createSpy.mockImplementation(async (_id, payload) => ({
        id: "bot_1",
        name: payload.name,
        agent: payload.agent,
        workspace: payload.workspace ?? "workspace-12345678",
        enabled: true,
        profileRevision: 1,
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
      }));
      const wrapper = mount(BotDialog, {
        props: { instanceId: "i1", instanceName: "Local" },
        global: { plugins: [i18n] },
      });
      const createButton = () => wrapper.findAll("button").find((b) => b.text() === i18n.global.t("common.create"))!;
      return { wrapper, instances, createSpy, createButton };
    }

    it("without the dedicated-workspace capability keeps the original form: first workspace preselected and submitted", async () => {
      const { wrapper, instances, createSpy, createButton } = mountCreateDialog({ dedicated: false });
      await flushPromises();
      const select = wrapper.find("#bot-workspace");
      expect(select.attributes("data-selected")).toBe("repo");
      expect(select.text()).toBe("repo");
      expect(wrapper.find('label[for="bot-workspace"]').text()).toContain("*");
      expect(wrapper.find('[data-test="bot-dedicated-workspace-hint"]').exists()).toBe(false);
      expect(instances.getAgentCapabilities).toHaveBeenCalledWith("i1", { agent: "codex", workspace: "repo" });
      // The "New workspace" option is not rendered at all.
      await select.trigger("click");
      expect(wrapper.find('[data-value=""]').exists()).toBe(false);
      expect(wrapper.text()).not.toContain(i18n.global.t("bot.fields.dedicatedWorkspace"));
      expect(wrapper.find('[data-value="repo"]').exists()).toBe(true);
      await wrapper.find('[data-value="repo"]').trigger("click");

      // A name with no letters is fine here: the workspace is explicit.
      await wrapper.find("#bot-name").setValue("!!!");
      await flushPromises();
      expect(wrapper.find('[data-test="bot-name-error"]').exists()).toBe(false);
      expect((createButton().element as HTMLButtonElement).disabled).toBe(false);
      await wrapper.find("form").trigger("submit.prevent");
      await flushPromises();
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy.mock.calls[0]![1]).toMatchObject({ name: "!!!", agent: "codex", workspace: "repo" });
      expect(wrapper.emitted("saved")).toBeTruthy();
    });

    it("without the capability and no workspaces, a workspace is still required", async () => {
      const instances = useInstancesStore();
      instances.instances = [
        {
          id: "i1", name: "Local", online: true, lastSeenAt: null, sessions: [],
          agents: [{ name: "codex", driver: "codex" }], workspaces: [], agentCatalog: [], capabilities: [],
        } as never,
      ];
      vi.spyOn(instances, "loadFormOptions").mockResolvedValue(undefined);
      const createSpy = vi.spyOn(useDirectBotsStore(), "createBot");
      const wrapper = mount(BotDialog, { props: { instanceId: "i1", instanceName: "Local" }, global: { plugins: [i18n] } });
      await flushPromises();
      expect(wrapper.find("#bot-workspace").attributes("data-selected")).toBe("");
      expect(instances.getAgentCapabilities).not.toHaveBeenCalled();
      await wrapper.find("#bot-name").setValue("Reviewer");
      await wrapper.find("form").trigger("submit.prevent");
      await flushPromises();
      expect(createSpy).not.toHaveBeenCalled();
      expect(wrapper.text()).toContain(i18n.global.t("bot.validation.workspaceRequired"));
    });

    it("with the capability defaults to a new dedicated workspace and omits workspace from the payload", async () => {
      const { wrapper, createSpy } = mountCreateDialog({ dedicated: true });
      await flushPromises();
      expect(wrapper.find("#bot-workspace").attributes("data-selected")).toBe("");
      expect(wrapper.find("#bot-workspace").text()).toBe(i18n.global.t("bot.fields.dedicatedWorkspace"));
      expect(wrapper.find('label[for="bot-workspace"]').text()).not.toContain("*");
      expect(wrapper.find('[data-test="bot-dedicated-workspace-hint"]').exists()).toBe(true);
      await wrapper.find("#bot-name").setValue("Reviewer");
      await wrapper.find("form").trigger("submit.prevent");
      await flushPromises();
      expect(createSpy.mock.calls[0]![1]).not.toHaveProperty("workspace");
    });

    it.each(["!!!", "🤖"])("name %s with New workspace shows a live error under the name and disables Create", async (botName) => {
      const { wrapper, createSpy, createButton } = mountCreateDialog({ dedicated: true });
      await flushPromises();
      const invalid = i18n.global.t("bot.validation.dedicatedWorkspaceNameInvalid");
      await wrapper.find("#bot-name").setValue(botName);
      await flushPromises();
      const error = wrapper.find('[data-test="bot-name-error"]');
      expect(error.exists()).toBe(true);
      expect(error.text()).toBe(invalid);
      // Directly under the name input, not in the form-level error banner.
      expect(error.element.previousElementSibling?.id).toBe("bot-name");
      expect(wrapper.find("#bot-name").attributes("aria-invalid")).toBe("true");
      expect((createButton().element as HTMLButtonElement).disabled).toBe(true);
      await wrapper.find("form").trigger("submit.prevent");
      await flushPromises();
      expect(createSpy).not.toHaveBeenCalled();

      // Picking an explicit workspace clears the error and enables Create.
      await wrapper.find("#bot-workspace").trigger("click");
      await wrapper.find('[data-value="repo"]').trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-test="bot-name-error"]').exists()).toBe(false);
      expect((createButton().element as HTMLButtonElement).disabled).toBe(false);
      await createButton().trigger("click");
      await flushPromises();
      expect(createSpy.mock.calls[0]![1]).toMatchObject({ name: botName, workspace: "repo" });
    });

    it("a new Bot does not show the applies-to-later-turns note under system instructions", async () => {
      const { wrapper } = mountCreateDialog({ dedicated: false });
      await flushPromises();
      expect(wrapper.find("#bot-instructions").exists()).toBe(true);
      expect(wrapper.find('[data-test="bot-instructions-hint"]').exists()).toBe(false);
      expect(wrapper.text()).not.toContain(i18n.global.t("bot.fields.instructionsHint"));
    });

    it("New workspace with nothing to preview shows a single model hint", async () => {
      const { wrapper } = mountCreateDialog({ dedicated: true, workspaces: [] });
      await flushPromises();
      const hints = wrapper.findAll('[data-test="model-picker-reason"], [data-test="model-picker-recovery"], [data-test="model-picker-applies-later"]');
      expect(hints).toHaveLength(1);
      expect(hints[0]!.attributes("data-test")).toBe("model-picker-reason");
      expect(hints[0]!.text()).toBe(i18n.global.t("bot.fields.workspacePreviewHint"));
    });

    it("focused name in error state uses the danger ring, not the default focus ring", async () => {
      const { wrapper } = mountCreateDialog({ dedicated: true });
      await flushPromises();
      await wrapper.find("#bot-name").setValue("!!!");
      await wrapper.find("#bot-name").trigger("focus");
      await flushPromises();
      const input = wrapper.find("#bot-name");
      expect(input.attributes("aria-invalid")).toBe("true");
      const classes = input.classes();
      // Unfocused error styling is unchanged.
      expect(classes).toEqual(expect.arrayContaining(["ring-1", "ring-danger"]));
      // Focused: danger ring instead of the accent focus ring.
      expect(classes).toEqual(expect.arrayContaining(["focus-visible:ring-2", "focus-visible:ring-danger"]));
      expect(classes.some((c) => c.includes("ring-accent"))).toBe(false);

      await wrapper.find("#bot-name").setValue("Reviewer");
      await flushPromises();
      expect(wrapper.find("#bot-name").attributes("aria-invalid")).toBeUndefined();
      expect(wrapper.find("#bot-name").classes().some((c) => c.includes("ring-danger"))).toBe(false);
    });

    it("an all-CJK name with New workspace has no error and submits without workspace", async () => {
      const { wrapper, createSpy, createButton } = mountCreateDialog({ dedicated: true });
      await flushPromises();
      await wrapper.find("#bot-name").setValue("代码审查");
      await flushPromises();
      expect(wrapper.find('[data-test="bot-name-error"]').exists()).toBe(false);
      expect((createButton().element as HTMLButtonElement).disabled).toBe(false);
      await createButton().trigger("click");
      await flushPromises();
      expect(createSpy.mock.calls[0]![1]).toMatchObject({ name: "代码审查" });
      expect(createSpy.mock.calls[0]![1]).not.toHaveProperty("workspace");
    });

    it("maps the server workspace_name_underivable error to the same copy", async () => {
      const serverError = Object.assign(new Error("Name needs a letter or number, or pick a workspace."), {
        code: "workspace_name_underivable",
      });
      const { wrapper, createButton } = mountCreateDialog({ dedicated: true, createImpl: async () => { throw serverError; } });
      await flushPromises();
      await wrapper.find("#bot-name").setValue("Reviewer");
      await createButton().trigger("click");
      await flushPromises();
      expect(wrapper.text()).toContain(i18n.global.t("bot.validation.dedicatedWorkspaceNameInvalid"));
      expect(wrapper.emitted("saved")).toBeFalsy();
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
      expect(wrapper.find('[data-test="bot-dedicated-workspace-hint"]').exists()).toBe(false);
      // Editing an existing Bot keeps the "applies to later runs" note.
      expect(wrapper.find('[data-test="model-picker-applies-later"]').exists()).toBe(true);
      // ...and the instructions note, which only makes sense for an existing Bot.
      expect(wrapper.get('[data-test="bot-instructions-hint"]').text()).toBe(i18n.global.t("bot.fields.instructionsHint"));
      await wrapper.find("#bot-workspace").trigger("click");
      expect(wrapper.findAll("[data-value]").map((option) => option.attributes("data-value"))).toEqual(["repo"]);
      await wrapper.find("#bot-workspace").trigger("click");

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
    it("does not roll back a remote rename when only other fields are touched", async () => {
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
      // Hydrate at rev1 name="Existing Bot"; a remote client renames to
      // "Remote Name" (rev2). The local user only toggles enabled.
      vi.spyOn(directBots, "loadBotDetail").mockResolvedValue({
        id: "bot_1", name: "Existing Bot", agent: "codex", workspace: "repo",
        enabled: true, profileRevision: 1,
        createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z",
      });
      const updateSpy = vi.spyOn(directBots, "updateBot").mockResolvedValue({
        id: "bot_1",
        name: "Remote Name",
        agent: "codex",
        workspace: "repo",
        enabled: false,
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
      // Touch only enabled: name input keeps its hydrated value but is NOT
      // dirty, so the patch must not carry the stale rev1 name.
      const enabledCheckbox = wrapper.find('input[type="checkbox"]');
      await enabledCheckbox.setValue(false);
      await wrapper.find("form").trigger("submit.prevent");
      await flushPromises();
      expect(updateSpy).toHaveBeenCalledTimes(1);
      const patch = updateSpy.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(patch).not.toHaveProperty("name");
      expect(patch.enabled).toBe(false);
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
      expect((wrapper.find("#bot-agent").element as HTMLButtonElement).disabled).toBe(false);
      expect((wrapper.find("#bot-workspace").element as HTMLButtonElement).disabled).toBe(false);

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
      expect((wrapper.find("#bot-agent").element as HTMLButtonElement).disabled).toBe(true);
      expect((wrapper.find("#bot-workspace").element as HTMLButtonElement).disabled).toBe(true);
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
      expect((wrapper.find("#bot-agent").element as HTMLButtonElement).disabled).toBe(false);

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

      expect((wrapper.find("#bot-agent").element as HTMLButtonElement).disabled).toBe(true);
      expect((wrapper.find("#bot-workspace").element as HTMLButtonElement).disabled).toBe(true);
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

    it("opens Save immediately when the cached detail is authoritative without instructions", async () => {
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
      // Seed authority through the REAL updateBot path with a mocked RPC:
      // the committed detail (no instructions key — the server omits empty
      // instructions) records authoritative hydration in the store.
      const { api } = await import("../api/client");
      const apiSpy = vi.spyOn(api, "rpc").mockImplementation(async (iid: string, type: string) => {
        if (type === "control.bots.update") {
          return {
            bot: {
              id: "bot_1", name: "Bot", agent: "codex", workspace: "repo",
              enabled: true, profileRevision: 3,
              createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z",
            },
          } as never;
        }
        if (type === "control.bots.list") {
          return { bots: [directBots.botsByInstance["i1"]?.[0] ?? {
            id: "bot_1", name: "Bot", agent: "codex", workspace: "repo",
            enabled: true, profileRevision: 3, updatedAt: "2026-09-18T00:00:00.000Z",
          }] } as never;
        }
        return {} as never;
      });
      const committed = await directBots.updateBot("i1", "bot_1", {});
      expect("instructions" in committed).toBe(false);
      expect(directBots.isBotDetailHydrated("i1", "bot_1")).toBe(true);
      apiSpy.mockRestore();
      // A redundant detail fetch would now fail — the dialog must not need it.
      const loadSpy = vi.spyOn(directBots, "loadBotDetail").mockRejectedValue(new Error("redundant fetch drop"));
      const updateSpy = vi.spyOn(directBots, "updateBot").mockResolvedValue({
        ...committed, name: "Renamed",
      });
      const wrapper = mount(BotDialog, {
        props: { instanceId: "i1", instanceName: "Local", bot: { ...committed } as never },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      await wrapper.vm.$nextTick();
      // Save is enabled immediately; submitting renames without tripping the
      // detailLoading gate and without the redundant fetch.
      const saveBtn = wrapper.findAll("button").find((b) => b.text().includes("Save"));
      expect(saveBtn).toBeTruthy();
      expect((saveBtn!.element as HTMLButtonElement).disabled).toBe(false);
      await wrapper.find("#bot-name").setValue("Renamed");
      await wrapper.find("form").trigger("submit.prevent");
      await flushPromises();
      expect(updateSpy).toHaveBeenCalled();
      expect(loadSpy).not.toHaveBeenCalled();
    });
    it("fills cached authoritative instructions when opened from a sidebar summary", async () => {
      seedLocalInstance();
      const directBots = useDirectBotsStore();
      const { api } = await import("../api/client");
      const apiSpy = vi.spyOn(api, "rpc").mockImplementation(async (_iid: string, type: string) => {
        if (type === "control.bots.get") {
          return {
            bot: {
              id: "bot_1", name: "Bot", agent: "codex", workspace: "repo",
              instructions: "Always review security", enabled: true, profileRevision: 2,
              createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z",
            },
          } as never;
        }
        return {} as never;
      });
      await directBots.loadBotDetail("i1", "bot_1");
      const summary: BotSummaryDto = {
        id: "bot_1", name: "Bot", agent: "codex", workspace: "repo",
        enabled: true, profileRevision: 2, updatedAt: "2026-09-18T00:00:00.000Z",
      };
      const wrapper = mount(BotDialog, {
        props: { instanceId: "i1", instanceName: "Local", bot: summary },
        global: { plugins: [i18n] },
      });
      const textarea = wrapper.find("#bot-instructions").element as HTMLTextAreaElement;
      expect(textarea.value).toBe("Always review security");
      expect(textarea.disabled).toBe(false);
      await flushPromises();
      expect(apiSpy.mock.calls.filter(([, type]) => type === "control.bots.get")).toHaveLength(1);
    });

    it("shows instructions as loading, not as an editable empty value, until the detail arrives", async () => {
      seedLocalInstance();
      const directBots = useDirectBotsStore();
      const detailGate = Promise.withResolvers<BotDetailDto>();
      vi.spyOn(directBots, "loadBotDetail").mockImplementation(() => detailGate.promise);
      const summary: BotSummaryDto = {
        id: "bot_1", name: "Bot", agent: "codex", workspace: "repo",
        enabled: true, updatedAt: "2026-09-18T00:00:00.000Z",
      };
      const wrapper = mount(BotDialog, {
        props: { instanceId: "i1", instanceName: "Local", bot: summary },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      const textarea = () => wrapper.find("#bot-instructions").element as HTMLTextAreaElement;
      expect(textarea().disabled).toBe(true);
      expect(textarea().placeholder).toBe("Loading instructions...");
      detailGate.resolve({
        id: "bot_1", name: "Bot", agent: "codex", workspace: "repo",
        instructions: "Server instructions", enabled: true, profileRevision: 1,
        createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z",
      });
      await flushPromises();
      expect(textarea().disabled).toBe(false);
      expect(textarea().value).toBe("Server instructions");
    });

    it("refetches on a newer remote revision and clears instructions the server no longer has", async () => {
      seedLocalInstance();
      const directBots = useDirectBotsStore();
      const rev1: BotDetailDto = {
        id: "bot_1", name: "Bot", agent: "codex", workspace: "repo",
        instructions: "Old instructions", enabled: true, profileRevision: 1,
        createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "rev1",
      };
      const rev2: BotDetailDto = { ...rev1, instructions: undefined, profileRevision: 2, updatedAt: "rev2" };
      const { api } = await import("../api/client");
      let served: BotDetailDto = rev1;
      vi.spyOn(api, "rpc").mockImplementation(async (_iid: string, type: string) => {
        if (type === "control.bots.get") return { bot: served } as never;
        if (type === "control.bots.list") {
          const { instructions: _omit, createdAt: _c, ...row } = served;
          return { bots: [row] } as never;
        }
        return {} as never;
      });
      await directBots.loadBots("i1");
      await directBots.loadBotDetail("i1", "bot_1");
      const wrapper = mount(BotDialog, {
        props: { instanceId: "i1", instanceName: "Local", bot: directBots.botsByInstance["i1"]![0]! },
        global: { plugins: [i18n] },
      });
      const textarea = () => wrapper.find("#bot-instructions").element as HTMLTextAreaElement;
      expect(textarea().value).toBe("Old instructions");
      served = rev2;
      await directBots.loadBots("i1");
      await flushPromises();
      expect(textarea().value).toBe("");
    });

    it("persists a user clear of hydrated instructions as an explicit null", async () => {
      seedLocalInstance();
      const directBots = useDirectBotsStore();
      vi.spyOn(directBots, "loadBotDetail").mockResolvedValue({
        id: "bot_1", name: "Bot", agent: "codex", workspace: "repo",
        instructions: "Server instructions", enabled: true, profileRevision: 1,
        createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z",
      });
      const updateSpy = vi.spyOn(directBots, "updateBot").mockResolvedValue({
        id: "bot_1", name: "Bot", agent: "codex", workspace: "repo",
        enabled: true, profileRevision: 2,
        createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z",
      });
      const wrapper = mount(BotDialog, {
        props: {
          instanceId: "i1", instanceName: "Local",
          bot: { id: "bot_1", name: "Bot", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
        },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      await wrapper.find("#bot-instructions").setValue("");
      await wrapper.find("form").trigger("submit.prevent");
      await flushPromises();
      expect(updateSpy).toHaveBeenCalledWith("i1", "bot_1", { instructions: null });
    });

    it("surfaces a retry after detail hydration fails, then hydrates and preserves user edits", async () => {
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
      const authoritative = {
        id: "bot_1", name: "Server Name", agent: "codex", workspace: "repo",
        instructions: "Server instructions", enabled: true, profileRevision: 2,
        createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z",
      } as BotDetailDto;
      let calls = 0;
      const loadSpy = vi.spyOn(directBots, "loadBotDetail").mockImplementation(async (iid: string, bid: string) => {
        calls += 1;
        if (calls === 1) throw new Error("transient bots.get drop");
        directBots.botDetails[`${iid}:${bid}`] = authoritative;
        return authoritative;
      });
      const updateSpy = vi.spyOn(directBots, "updateBot").mockResolvedValue({
        ...authoritative, name: "User Name",
      });
      const existingBot: BotSummaryDto = {
        id: "bot_1", name: "Bot", agent: "codex", workspace: "repo",
        enabled: true, updatedAt: "2026-09-18T00:00:00.000Z",
      };
      const wrapper = mount(BotDialog, {
        props: { instanceId: "i1", instanceName: "Local", bot: existingBot },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      // First attempt failed: visible retry banner, Save stays gated.
      expect(wrapper.find('[data-test="bot-detail-retry"]').exists()).toBe(true);
      const saveBtn = wrapper.findAll("button").find((b) => b.text().includes("Save"));
      expect(saveBtn).toBeTruthy();
      expect((saveBtn!.element as HTMLButtonElement).disabled).toBe(true);
      // User edits while failed: retry must preserve them.
      await wrapper.find("#bot-name").setValue("User Name");
      await wrapper.find('[data-test="bot-detail-retry-button"]').trigger("click");
      await flushPromises();
      expect(loadSpy).toHaveBeenCalledTimes(2);
      expect(wrapper.find('[data-test="bot-detail-retry"]').exists()).toBe(false);
      // Untouched fields hydrated from authority; user edit preserved.
      expect((wrapper.find("#bot-name").element as HTMLInputElement).value).toBe("User Name");
      expect((wrapper.find("#bot-instructions").element as HTMLTextAreaElement).value).toBe("Server instructions");
      // Save is now enabled and submits the dirty-only patch.
      // The Teleport stub replaces DOM nodes when the async form updates.
      expect(wrapper.findAll("button").find((b) => b.text().includes("Save"))!.attributes("disabled")).toBeUndefined();
      await wrapper.find("form").trigger("submit.prevent");
      await flushPromises();
      expect(updateSpy).toHaveBeenCalled();
    });
    it("auto-releases the gate when background authority converges without manual retry", async () => {
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
      const authoritative = {
        id: "bot_1", name: "Server Name", agent: "codex", workspace: "repo",
        instructions: "Server instructions", enabled: true, profileRevision: 2,
        createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z",
      } as BotDetailDto;
      // Fail the dialog's own hydrate through the real store path (so no
      // authority is recorded), then let a background loadBotDetail succeed.
      const { api } = await import("../api/client");
      let getCalls = 0;
      const apiSpy = vi.spyOn(api, "rpc").mockImplementation(async (iid: string, type: string) => {
        if (type === "control.bots.get") {
          getCalls += 1;
          if (getCalls === 1) throw new Error("transient bots.get drop");
          return { bot: authoritative } as never;
        }
        return {} as never;
      });
      const existingBot: BotSummaryDto = {
        id: "bot_1", name: "Bot", agent: "codex", workspace: "repo",
        enabled: true, updatedAt: "2026-09-18T00:00:00.000Z",
      };
      const wrapper = mount(BotDialog, {
        props: { instanceId: "i1", instanceName: "Local", bot: existingBot },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      expect(wrapper.find('[data-test="bot-detail-retry"]').exists()).toBe(true);
      const saveBtn = wrapper.findAll("button").find((b) => b.text().includes("Save"));
      expect(saveBtn).toBeTruthy();
      expect((saveBtn!.element as HTMLButtonElement).disabled).toBe(true);
      // User edits while failed; then a background path (bots-changed)
      // hydrates the store through the real path — no manual retry click.
      await wrapper.find("#bot-name").setValue("User Name");
      await directBots.loadBotDetail("i1", "bot_1");
      await flushPromises();
      await wrapper.vm.$nextTick();
      expect(getCalls).toBe(2);
      expect(wrapper.find('[data-test="bot-detail-retry"]').exists()).toBe(false);
      expect((wrapper.find("#bot-name").element as HTMLInputElement).value).toBe("User Name");
      expect((wrapper.find("#bot-instructions").element as HTMLTextAreaElement).value).toBe("Server instructions");
      expect(wrapper.findAll("button").find((b) => b.text().includes("Save"))!.attributes("disabled")).toBeUndefined();
      apiSpy.mockRestore();
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
      expect(wrapper.findAll("button").find((b) => b.text().includes("Save"))!.attributes("disabled")).toBeUndefined();
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
      await wrapper.find("#bot-agent").trigger("click");
      await wrapper.find('[data-value="claude"]').trigger("click");
      await wrapper.find("#bot-agent").trigger("click");
      await wrapper.find('[data-value="codex"]').trigger("click");
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
      expect(wrapper.find("#bot-agent").text()).toContain("codex");

      await wrapper.find("form").trigger("submit.prevent");
      await flushPromises();
      expect(updateSpy).toHaveBeenCalledWith("i1", "bot_1", expect.objectContaining({
        agent: "codex",
      }));
    });

    it("keeps user-typed instructions when a newer remote revision arrives", async () => {
      seedLocalInstance();
      const directBots = useDirectBotsStore();
      const rev1: BotDetailDto = {
        id: "bot_1", name: "Bot", agent: "codex", workspace: "repo",
        instructions: "Old instructions", enabled: true, profileRevision: 1,
        createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "rev1",
      };
      const { api } = await import("../api/client");
      let served: BotDetailDto = rev1;
      vi.spyOn(api, "rpc").mockImplementation(async (_iid: string, type: string) => {
        if (type === "control.bots.get") return { bot: served } as never;
        if (type === "control.bots.list") {
          const { instructions: _omit, createdAt: _c, ...row } = served;
          return { bots: [row] } as never;
        }
        return {} as never;
      });
      await directBots.loadBots("i1");
      await directBots.loadBotDetail("i1", "bot_1");
      const wrapper = mount(BotDialog, {
        props: { instanceId: "i1", instanceName: "Local", bot: directBots.botsByInstance["i1"]![0]! },
        global: { plugins: [i18n] },
      });
      await wrapper.find("#bot-instructions").setValue("User typed instructions");
      served = { ...rev1, instructions: "Remote instructions", role: "Remote role", profileRevision: 2, updatedAt: "rev2" };
      await directBots.loadBots("i1");
      await flushPromises();
      expect((wrapper.find("#bot-instructions").element as HTMLTextAreaElement).value).toBe("User typed instructions");
      expect((wrapper.find("#bot-role").element as HTMLInputElement).value).toBe("Remote role");
    });

    it("keeps a user-cleared instructions field when a newer remote revision arrives", async () => {
      seedLocalInstance();
      const directBots = useDirectBotsStore();
      const rev1: BotDetailDto = {
        id: "bot_1", name: "Bot", agent: "codex", workspace: "repo",
        instructions: "Old instructions", enabled: true, profileRevision: 1,
        createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "rev1",
      };
      const { api } = await import("../api/client");
      let served: BotDetailDto = rev1;
      vi.spyOn(api, "rpc").mockImplementation(async (_iid: string, type: string) => {
        if (type === "control.bots.get") return { bot: served } as never;
        if (type === "control.bots.list") {
          const { instructions: _omit, createdAt: _c, ...row } = served;
          return { bots: [row] } as never;
        }
        return {} as never;
      });
      await directBots.loadBots("i1");
      await directBots.loadBotDetail("i1", "bot_1");
      const wrapper = mount(BotDialog, {
        props: { instanceId: "i1", instanceName: "Local", bot: directBots.botsByInstance["i1"]![0]! },
        global: { plugins: [i18n] },
      });
      await wrapper.find("#bot-instructions").setValue("draft");
      await wrapper.find("#bot-instructions").setValue("");
      served = { ...rev1, instructions: "Remote instructions", role: "Remote role", profileRevision: 2, updatedAt: "rev2" };
      await directBots.loadBots("i1");
      await flushPromises();
      expect((wrapper.find("#bot-instructions").element as HTMLTextAreaElement).value).toBe("");
      expect((wrapper.find("#bot-role").element as HTMLInputElement).value).toBe("Remote role");
    });

    it("loads the detail without waiting for slow form options", async () => {
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
      const optionsGate = Promise.withResolvers<void>();
      vi.spyOn(instances, "loadFormOptions").mockImplementation(() => optionsGate.promise);
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
      expect(detailSpy).toHaveBeenCalledWith("i1", "bot_1");
      expect((wrapper.find("#bot-instructions").element as HTMLTextAreaElement).value).toBe("Server instructions");
      wrapper.unmount();
      optionsGate.resolve();
      await flushPromises();
    });

    it("reuses the verified catalog across two editor opens with unchanged config", async () => {
      vi.restoreAllMocks();
      seedLocalInstance();
      const capability = readyCapability("cache", [{ modelId: "gpt-cached" }], {
        fetchedAt: "2026-10-19T00:00:00.000Z",
        efforts: { status: "known", options: [] },
      });
      const rpc = vi.spyOn(api, "rpc").mockImplementation(async (_instanceId, type) => {
        if (type === "control.agents.capabilities.get") return capability;
        if (type === "control.workspaces.list") return { workspaces: [{ name: "repo", cwd: "/repo" }] };
        if (type === "control.agents.list") return { agents: [{ name: "codex", driver: "codex" }] };
        return { agents: [] };
      });

      const first = mount(BotDialog, { props: { instanceId: "i1", instanceName: "Local" }, global: { plugins: [i18n] } });
      await flushPromises();
      expect(rpc.mock.calls.filter(([, type]) => type === "control.agents.capabilities.get")).toHaveLength(1);
      first.unmount();

      // Closing and reopening the editor reloads form options, but the adapter,
      // workspace, and auth are unchanged: the cached catalog must still answer.
      const second = mount(BotDialog, { props: { instanceId: "i1", instanceName: "Local" }, global: { plugins: [i18n] } });
      await flushPromises();
      expect(rpc.mock.calls.filter(([, type]) => type === "control.agents.capabilities.get")).toHaveLength(1);
      await second.get('[data-test="bot-model"]').trigger("focus");
      expect(second.get('[data-test="model-option"]').attributes("data-model-id")).toBe("gpt-cached");
      second.unmount();
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
      expect(wrapper.emitted("send")?.[0]).toEqual(["Hello world", [], []]);
    });

    it("keeps the composer editable, blocks Enter, and offers Stop while a run is active", async () => {
      const directBots = useDirectBotsStore();
      directBots.instanceId = "i1";
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

      // A running turn must not lock the textarea: the takeover action
      // composes into it.
      const textarea = wrapper.find("textarea");
      expect((textarea.element as HTMLTextAreaElement).disabled).toBe(false);

      // Empty composer during a run offers Stop as the only action, and it
      // dispatches the store's cancel for this exact run.
      const cancelSpy = vi.spyOn(directBots, "cancelCurrentRun").mockResolvedValue({
        status: "blocked", scope: null, runId: null, reason: "no-active-run",
      });
      const stopBtn = wrapper.find('[data-test="stop-run-button"]');
      expect(stopBtn.exists()).toBe(true);
      await stopBtn.trigger("click");
      await flushPromises();
      expect(cancelSpy).toHaveBeenCalledWith({ runId: "run_1" });

      // Typed text swaps nothing: the button stays Stop while a run is
      // active, and Enter still refuses to send.
      await textarea.setValue("steer this");
      await textarea.trigger("keydown", { key: "Enter", shiftKey: false });
      expect(wrapper.emitted("send")).toBeUndefined();
      expect(wrapper.find('[data-test="send-prompt-button"]').exists()).toBe(false);
      // The persistent Stop dispatches the store's cancel for this exact run
      // and never sends mid-run.
      await wrapper.find('[data-test="stop-run-button"]').trigger("click");
      await flushPromises();
      expect(wrapper.emitted("send")).toBeUndefined();
      expect(cancelSpy).toHaveBeenCalledTimes(2);
      expect(cancelSpy).toHaveBeenLastCalledWith({ runId: "run_1" });
    });

    it("keeps Stop (not Send) with a staged image while a run is active", async () => {
      const directBots = useDirectBotsStore();
      directBots.instanceId = "i1";
      directBots.selectedBotId = "b1";
      directBots.activeConversationId = "c1";
      directBots.activeTopicId = "t1";
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
      const composer = useComposerStore();
      composer.bindInstance("i1", JSON.stringify(["direct", "i1", "c1", "t1", "b1"]));
      composer.pending.push({
        id: "local-1",
        uploadId: "u1",
        filename: "shot.png",
        mimeType: "image/png",
        size: 3,
        kind: "image",
        filePath: "/uploads/u1/shot.png",
        status: "ready",
      });
      const wrapper = mount(ConversationPromptInput, { global: { plugins: [i18n] } });
      await flushPromises();
      // A staged image counts as sendable, but with stopWhileBusy the
      // button stays Stop for the whole run and never flips back to Send.
      const stop = wrapper.find('[data-test="stop-run-button"]');
      expect(stop.exists()).toBe(true);
      expect((stop.element as HTMLButtonElement).disabled).toBe(false);
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
      expect((textarea.element as HTMLTextAreaElement).placeholder).toBe("Loading history…");
      await textarea.setValue("too early");
      await textarea.trigger("keydown", { key: "Enter", shiftKey: false });
      expect(wrapper.emitted("send")).toBeUndefined();
    });
    it("shows the normal placeholder (not Recovering) for a Bot with zero Topics once selection settles", async () => {
      seedLocalInstance();
      vi.spyOn(api, "rpc").mockImplementation(async (_inst: string, type: string) => {
        if (type === "control.bots.list") return { bots: [{ id: "b1", name: "Bot", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" }] } as never;
        if (type === "control.conversations.list") return { conversations: [{ id: "c1", kind: "bot", title: "Bot", botId: "b1", createdAt: "now", updatedAt: "now" }] } as never;
        if (type === "control.topics.list") return { topics: [] } as never;
        return {} as never;
      });
      const directBots = useDirectBotsStore();
      await directBots.selectBot("i1", "b1");
      expect(directBots.topicReady).toBe(true);
      const wrapper = mount(ConversationPromptInput, {
        global: { plugins: [i18n] },
      });
      const textarea = wrapper.find("textarea").element as HTMLTextAreaElement;
      expect(textarea.placeholder).toBe(i18n.global.t("bot.prompt.placeholder"));
      expect(textarea.placeholder).not.toBe(i18n.global.t("bot.prompt.recoveringPlaceholder"));
      // Enabled: the first send creates the Default Topic.
      expect(textarea.disabled).toBe(false);
      wrapper.unmount();
    });

    describe("first message to a topicless Bot", () => {
      const BOT = { id: "b1", name: "Bot", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" };
      const CONV = { id: "c1", kind: "bot", title: "Bot", botId: "b1", createdAt: "now", updatedAt: "now" };
      const NEW_TOPIC = { id: "t_new", conversationId: "c1", title: "Default", status: "active", createdAt: "now", updatedAt: "now" };
      function promptAccepted(payload: { requestId: string; text: string; topicId: string }) {
        return {
          reused: false, conversationId: "c1", topicId: payload.topicId, requestId: payload.requestId,
          message: { id: "m1", conversationId: "c1", topicId: payload.topicId, seq: 1, role: "human", content: payload.text, createdAt: "now" },
          run: { id: "r1", conversationId: "c1", topicId: payload.topicId, requestMessageId: "m1", requestId: payload.requestId, mode: "explicit", state: "completed", profileRevision: 1, createdAt: "now" },
          activeRunId: "r1",
        };
      }
      /** Routes the RPCs a Bot page makes; `create` drives control.topics.create. */
      function routeRpc(opts: { create: () => Promise<unknown>; conversations?: () => unknown[] }) {
        const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
        topicsAfterCreate = [];
        vi.spyOn(api, "rpc").mockImplementation((async (_inst: string, type: string, payload: Record<string, unknown> = {}) => {
          calls.push({ type, payload });
          if (type === "control.bots.list") return { bots: [BOT] };
          if (type === "control.conversations.list") return { conversations: opts.conversations ? opts.conversations() : [CONV] };
          if (type === "control.topics.list") return { topics: topicsAfterCreate };
          if (type === "control.topics.create") {
            const res = await opts.create();
            topicsAfterCreate = [NEW_TOPIC];
            return res;
          }
          if (type === "control.conversation.history") return { conversationId: "c1", topicId: payload.topicId, messages: [], hasMoreBefore: false, hasMoreAfter: false };
          if (type === "control.runs.list") return { runs: [] };
          if (type === "control.conversation.prompt") return promptAccepted(payload as never);
          return {};
        }) as never);
        return calls;
      }
      let topicsAfterCreate: unknown[] = [];
      async function mountTopicless() {
        seedLocalInstance();
        window.innerWidth = 1280;
        const directBots = useDirectBotsStore();
        await directBots.selectBot("i1", "b1");
        const wrapper = mount(DirectBotPane, { global: { plugins: [i18n] } });
        await flushPromises();
        const input = wrapper.findComponent(ConversationPromptInput);
        return { directBots, wrapper, textarea: input.find("textarea"), sendButton: () => input.find('[data-test="send-prompt-button"]') };
      }
      // jsdom has no Element.scrollTo; the transcript auto-scrolls once the
      // first message lands.
      const hadScrollTo = "scrollTo" in HTMLElement.prototype;
      beforeEach(() => {
        if (!hadScrollTo) HTMLElement.prototype.scrollTo = () => {};
      });
      afterEach(() => {
        for (const t of [...useToasts().value]) dismissToast(t.id);
        if (!hadScrollTo) Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
      });

      it("enables the composer with the normal placeholder when the Bot has zero Topics", async () => {
        routeRpc({ create: async () => ({ topic: NEW_TOPIC }) });
        const { directBots, wrapper, textarea } = await mountTopicless();
        expect(directBots.activeTopicId).toBeNull();
        const el = textarea.element as HTMLTextAreaElement;
        expect(el.disabled).toBe(false);
        expect(el.placeholder).toBe(i18n.global.t("bot.prompt.placeholder"));
        // Intro and composer tell the same story.
        expect(wrapper.find('[data-test="bot-empty-hint"]').text()).toBe(i18n.global.t("bot.chat.emptyHint"));
        wrapper.unmount();
      });

      it("a disabled Bot's intro says to enable it, matching the disabled composer", async () => {
        routeRpc({ create: async () => ({ topic: NEW_TOPIC }) });
        const { directBots, wrapper } = await mountTopicless();
        directBots.botsByInstance["i1"] = [{ ...BOT, enabled: false }];
        await flushPromises();
        const el = wrapper.findComponent(ConversationPromptInput).find("textarea").element as HTMLTextAreaElement;
        expect(el.disabled).toBe(true);
        expect(el.placeholder).toBe(i18n.global.t("bot.prompt.botDisabledPlaceholder"));
        expect(wrapper.find('[data-test="bot-empty-hint"]').text()).toBe(i18n.global.t("bot.chat.emptyHintDisabled"));
        wrapper.unmount();
      });

      it("creates a Default Topic via topics.create, activates it and sends the first message into it", async () => {
        let resolveCreate!: (v: unknown) => void;
        const calls = routeRpc({ create: () => new Promise((resolve) => { resolveCreate = resolve; }) });
        const { directBots, wrapper, textarea, sendButton } = await mountTopicless();
        await textarea.setValue("hello bot");
        await textarea.trigger("keydown", { key: "Enter", shiftKey: false });
        await flushPromises();
        // Sending state starts immediately, before the Topic exists.
        expect(sendButton().attributes("disabled")).toBeDefined();
        expect(sendButton().find(".animate-spin").exists()).toBe(true);
        expect(calls.filter((c) => c.type === "control.conversation.prompt")).toHaveLength(0);
        // Double-send guard: a second Enter while creating creates no second Topic.
        await textarea.trigger("keydown", { key: "Enter", shiftKey: false });
        await sendButton().trigger("click");
        await flushPromises();
        expect(calls.filter((c) => c.type === "control.topics.create")).toHaveLength(1);
        expect(calls.find((c) => c.type === "control.topics.create")?.payload).toEqual({ conversationId: "c1", title: "Default" });

        resolveCreate({ topic: NEW_TOPIC });
        await flushPromises();
        expect(directBots.activeTopicId).toBe("t_new");
        // The new Topic is opened through the normal loadHistory path (history
        // + durable run discovery reopen topicReady) before the prompt goes out.
        const order = calls.map((c) => c.type);
        const created = order.indexOf("control.topics.create");
        const history = order.indexOf("control.conversation.history", created);
        const runs = order.indexOf("control.runs.list", created);
        expect(history).toBeGreaterThan(created);
        expect(runs).toBeGreaterThan(created);
        expect(order.indexOf("control.conversation.prompt")).toBeGreaterThan(Math.max(history, runs));
        expect(directBots.topicReady).toBe(true);
        const prompts = calls.filter((c) => c.type === "control.conversation.prompt");
        expect(prompts).toHaveLength(1);
        expect(prompts[0]?.payload).toMatchObject({ conversationId: "c1", topicId: "t_new", text: "hello bot", target: { botId: "b1" } });
        expect(directBots.messages.map((m) => m.content)).toEqual(["hello bot"]);
        expect((wrapper.findComponent(ConversationPromptInput).find("textarea").element as HTMLTextAreaElement).value).toBe("");
        expect(useToasts().value).toHaveLength(0);
        wrapper.unmount();
      });

      it("materializes the Direct Conversation through the existing list when none is known yet", async () => {
        let listed = 0;
        const calls = routeRpc({
          create: async () => ({ topic: NEW_TOPIC }),
          conversations: () => (listed++ === 0 ? [] : [CONV]),
        });
        const { directBots, wrapper, textarea } = await mountTopicless();
        expect(directBots.activeConversationId).toBeNull();
        await textarea.setValue("first");
        await textarea.trigger("keydown", { key: "Enter", shiftKey: false });
        await flushPromises();
        expect(directBots.activeConversationId).toBe("c1");
        expect(calls.find((c) => c.type === "control.topics.create")?.payload).toEqual({ conversationId: "c1", title: "Default" });
        expect(calls.find((c) => c.type === "control.conversation.prompt")?.payload).toMatchObject({ conversationId: "c1", topicId: "t_new", text: "first" });
        wrapper.unmount();
      });

      it("on Topic creation failure shows a toast, keeps the draft and sends nothing", async () => {
        const calls = routeRpc({ create: async () => { throw new Error("topics down"); } });
        const { directBots, wrapper, textarea, sendButton } = await mountTopicless();
        await textarea.setValue("keep me");
        await textarea.trigger("keydown", { key: "Enter", shiftKey: false });
        await flushPromises();
        expect(useToasts().value.map((t) => [t.tone, t.key])).toEqual([["error", "bot.prompt.createTopicFailed"]]);
        expect(calls.filter((c) => c.type === "control.conversation.prompt")).toHaveLength(0);
        expect(directBots.activeTopicId).toBeNull();
        const el = wrapper.findComponent(ConversationPromptInput).find("textarea").element as HTMLTextAreaElement;
        expect(el.value).toBe("keep me");
        // Composer usable again for a retry.
        expect(el.disabled).toBe(false);
        expect(sendButton().attributes("disabled")).toBeUndefined();
        wrapper.unmount();
      });
    });

    it("shows the Recovering placeholder only while a real history load is in flight", async () => {
      seedLocalInstance();
      let releaseHistory!: () => void;
      vi.spyOn(api, "rpc").mockImplementation((_inst: string, type: string) => {
        if (type === "control.bots.list") return Promise.resolve({ bots: [{ id: "b1", name: "Bot", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" }] } as never);
        if (type === "control.conversations.list") return Promise.resolve({ conversations: [{ id: "c1", kind: "bot", title: "Bot", botId: "b1", defaultTopicId: "t1", createdAt: "now", updatedAt: "now" }] } as never);
        if (type === "control.topics.list") return Promise.resolve({ topics: [{ id: "t1", conversationId: "c1", title: "Default", status: "active", createdAt: "now", updatedAt: "now" }] } as never);
        if (type === "control.conversation.history") return new Promise((resolve) => {
          releaseHistory = () => resolve({ conversationId: "c1", topicId: "t1", messages: [], hasMoreBefore: false, hasMoreAfter: false } as never);
        });
        if (type === "control.runs.list") return Promise.resolve({ runs: [] } as never);
        return Promise.resolve({} as never);
      });
      const directBots = useDirectBotsStore();
      const selecting = directBots.selectBot("i1", "b1");
      const wrapper = mount(ConversationPromptInput, { global: { plugins: [i18n] } });
      await flushPromises();
      const textarea = () => wrapper.find("textarea").element as HTMLTextAreaElement;
      expect(textarea().placeholder).toBe(i18n.global.t("bot.prompt.recoveringPlaceholder"));
      expect(textarea().disabled).toBe(true);
      releaseHistory();
      await selecting;
      await flushPromises();
      expect(textarea().placeholder).toBe(i18n.global.t("bot.prompt.placeholder"));
      expect(textarea().disabled).toBe(false);
      wrapper.unmount();
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

  describe("finished-row trace completeness", () => {
    it("renders the durable final answer when the cached trace never finished", async () => {
      // Partial live parts (stream cut by disconnect, no turn-finished) must
      // not shadow the durable final row recovered on reconnect.
      const wrapper = mount(ConversationMessageList, {
        props: {
          messages: [
            {
              id: "msg_final",
              conversationId: "c1",
              topicId: "t1",
              seq: 2,
              role: "bot",
              runId: "run_A",
              content: "complete durable answer",
              createdAt: "2026-09-18T00:02:00.000Z",
            },
          ],
          liveTurn: null,
          activeRun: null,
          activeMemberTurn: null,
          // Stale partial: only completeRunParts (filtered) reaches the
          // component, so this entry must be absent.
          runParts: {},
          bot: { id: "b1", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
        },
        global: {
          plugins: [i18n],
        },
      });
      await flushPromises();
      expect(wrapper.text()).toContain("complete durable answer");
    });

    it("keeps rich trace cards only for turn-finished runs", async () => {
      const directBots = useDirectBotsStore();
      directBots.instanceId = "inst_1";
      directBots.selectedBotId = "bot_1";
      directBots.activeConversationId = "conv_1";
      directBots.activeTopicId = "top_1";
      // Partial snapshot without turn-finished: excluded from completeRunParts.
      directBots.runParts["run_partial"] = [{ type: "text", text: "partial..." } as never];
      expect(directBots.completeRunParts["run_partial"]).toBeUndefined();
      // turn-finished proves completeness: included.
      directBots.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "turn-output",
          chatKey: "rk",
          sessionAlias: "brt_1",
          chunk: "full text",
          conversation: { conversationId: "conv_1", topicId: "top_1", botId: "bot_1", runId: "run_full", memberTurnId: "m1" },
        } as never,
      });
      directBots.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "turn-finished",
          chatKey: "rk",
          sessionAlias: "brt_1",
          conversation: { conversationId: "conv_1", topicId: "top_1", botId: "bot_1", runId: "run_full", memberTurnId: "m1" },
        } as never,
      });
      expect(directBots.completeRunParts["run_full"]).toHaveLength(1);
      // Durable final row for the partial run prunes the stale cache.
      directBots.applyEvent({
        kind: "control-event",
        instanceId: "inst_1",
        event: {
          type: "conversation-message",
          message: { id: "msg_f", conversationId: "conv_1", topicId: "top_1", seq: 9, role: "bot", runId: "run_partial", content: "complete durable answer", createdAt: "now" },
        } as never,
      });
      expect(directBots.runParts["run_partial"]).toBeUndefined();
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

    it("renders a streaming live turn without a status capsule or stop button", async () => {
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
      expect(wrapper.text()).toContain("Analyzing code...");
      // The status capsule is gone: no lifecycle label, no stop action, no second
      // liveness indicator. Streamed content is the whole signal; Stop is the
      // composer's.
      expect(wrapper.find('[data-test="run-status"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="run-stop-button"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="run-empty-slot"]').exists()).toBe(false);
    });

    it("shows the thinking bubble until the run produces output", () => {
      const activeRun: ConversationRunDto = {
        id: "run_think",
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
          liveTurn: null,
          activeRun,
          activeMemberTurn: null,
          runParts: {},
          bot: { id: "b1", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
        },
        global: { plugins: [i18n] },
      });
      const dots = wrapper.find('[data-test="run-empty-slot"]');
      expect(dots.exists()).toBe(true);
      expect(dots.attributes("role")).toBe("status");
      expect(dots.element.children).toHaveLength(3);
      expect(wrapper.find('[data-test="run-stop-button"]').exists()).toBe(false);
    });

    // The dot, not a colour tint on the label, is what separates the lifecycle states:
    // "waiting for a human" must stop breathing so it cannot be mistaken for work.
    it("switches the status chip from a breathing run dot to a still warn dot when waiting for a human", () => {
      const waitingRun: ConversationRunDto = {
        id: "run_wait",
        conversationId: "c1",
        topicId: "t1",
        requestMessageId: "m1",
        requestId: "r1",
        mode: "explicit",
        state: "waiting-human",
        profileRevision: 1,
        createdAt: "2026-09-18T00:00:00.000Z",
      };
      const wrapper = mount(ConversationMessageList, {
        props: {
          messages: [],
          liveTurn: null,
          activeRun: waitingRun,
          activeMemberTurn: null,
          runParts: {},
          bot: { id: "b1", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
        },
        global: { plugins: [i18n] },
      });
      const chip = wrapper.find('[data-test="run-status"]');
      expect(chip.attributes("data-status-state")).toBe("waiting");
      const dot = chip.find('[data-test="hud-dot"]');
      expect(dot.classes()).not.toContain("pulse-dot");
      expect(dot.classes()).toContain("bg-warn");
      expect(chip.find('[data-test="hud-quip"]').text()).toBe("Waiting for human");
      // A run blocked on the user is not thinking: the chip stands alone.
      expect(wrapper.find('[data-test="run-empty-slot"]').exists()).toBe(false);
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
      expect(wrapper.find('[data-test="run-stop-button"]').exists()).toBe(false);
      expect(wrapper.text()).toContain("Run cancelled");
    });

    it("renders a failed run banner with the provider message but not a bare code", () => {
      const failedRun = (completionReason: string): ConversationRunDto => ({
        id: "run_failed",
        conversationId: "c1",
        topicId: "t1",
        requestMessageId: "m1",
        requestId: "r1",
        mode: "explicit",
        state: "failed",
        completionReason,
        profileRevision: 1,
        createdAt: "2026-09-18T00:00:00.000Z",
      });
      const mountRun = (completionReason: string) => mount(ConversationMessageList, {
        props: {
          messages: [],
          liveTurn: null,
          activeRun: failedRun(completionReason),
          activeMemberTurn: null,
          runParts: {},
          bot: { id: "b1", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
        },
        global: {
          plugins: [i18n],
        },
      });
      const coded = mountRun("execution-failed");
      expect(coded.text()).toContain("Run failed");
      expect(coded.text()).not.toContain("execution-failed");
      const provider = mountRun("model overloaded, retry later");
      expect(provider.text()).toContain("model overloaded, retry later");
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

    it("enables the Load Older button after a topic switch retires a deferred page", async () => {
      // Store-level UI contract: navigation releases loadingOlder so the
      // button is clickable on the new Topic while the old page still hangs.
      const directBots = useDirectBotsStore();
      directBots.instanceId = "inst_1";
      directBots.selectedBotId = "bot_1";
      directBots.activeConversationId = "conv_1";
      directBots.activeTopicId = "top_A";
      const { api } = await import("../api/client");
      const { promise: pageAGate } = Promise.withResolvers<unknown>();
      const olderCalls: string[] = [];
      const apiSpy = vi.spyOn(api, "rpc").mockImplementation(async (iid: string, type: string, payload?: unknown) => {
        if (type === "control.conversation.history") {
          const pl = payload as { beforeSeq?: number; topicId: string; limit?: number; direction?: string } | undefined;
          if (pl?.beforeSeq !== undefined) {
            olderCalls.push(pl.topicId);
            if (pl.topicId === "top_A") return pageAGate as never;
            return {
              conversationId: "conv_1", topicId: "top_B", messages: [],
              hasMoreBefore: false, hasMoreAfter: true,
            } as never;
          }
          const topicId = pl?.topicId ?? "top_A";
          return {
            conversationId: "conv_1", topicId,
            messages: Array.from({ length: 5 }, (_, i) => ({
              id: `msg_${topicId}_${i}`, conversationId: "conv_1", topicId,
              seq: 100 + i, role: "human", content: "m", createdAt: "now",
            })),
            oldestSeq: 100, newestSeq: 104, hasMoreBefore: true, hasMoreAfter: false,
          } as never;
        }
        if (type === "control.runs.list") {
          return { conversationId: "conv_1", topicId: (payload as { topicId: string }).topicId, runs: [] } as never;
        }
        return {} as never;
      });
      const msgA = (seq: number) => ({
        id: `msg_top_A_${seq}`, conversationId: "conv_1", topicId: "top_A",
        seq, role: "human", content: "m", createdAt: "now",
      });
      directBots.messages = Array.from({ length: 5 }, (_, i) => msgA(100 + i)) as never;
      directBots.oldestSeq = 100;
      directBots.hasMoreBefore = true;
      void directBots.loadOlder();
      await flushPromises();
      expect(directBots.loadingOlder).toBe(true);
      await directBots.switchTopic("top_B");
      for (let i = 0; i < 10; i += 1) {
        await flushPromises();
      }
      // Spinner released by navigation: the button binds this prop.
      expect(directBots.loadingOlder).toBe(false);
      const wrapper = mount(ConversationMessageList, {
        props: {
          messages: [],
          liveTurn: null,
          activeRun: null,
          activeMemberTurn: null,
          runParts: {},
          hasMoreOlder: true,
          loadingOlder: directBots.loadingOlder,
          loadOlder: () => directBots.loadOlder(),
        },
        global: {
          plugins: [i18n],
        },
      });
      const btn = wrapper.find('[data-test="load-older-button"]');
      expect(btn.exists()).toBe(true);
      expect((btn.element as HTMLButtonElement).disabled).toBe(false);
      await btn.trigger("click");
      await flushPromises();
      expect(olderCalls).toContain("top_B");
      apiSpy.mockRestore();
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

      const scrollerEl = wrapper.find("[data-test=conversation-scroller]").element as HTMLElement;
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
      const scrollerEl = wrapper.find("[data-test=conversation-scroller]").element as HTMLElement;
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
      const scrollerEl = wrapper.find("[data-test=conversation-scroller]").element as HTMLElement;
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
    it("desktop header: a role-less (or blank-role) Bot shows exactly one separator between topic and workspace", async () => {
      seedLocalInstance();
      const prevWidth = window.innerWidth;
      window.innerWidth = 1280;
      const directBots = useDirectBotsStore();
      directBots.instanceId = "i1";
      directBots.selectedBotId = "b1";
      for (const role of [undefined, "   ", "Code QA"]) {
        directBots.botsByInstance["i1"] = [
          { id: "b1", name: "Bot", agent: "codex", workspace: "repo", ...(role !== undefined ? { role } : {}), enabled: true, updatedAt: "now" },
        ];
        const wrapper = mount(DirectBotPane, { global: { plugins: [i18n] } });
        await flushPromises();
        const meta = wrapper.find('[data-test="bot-header-meta"]').text().replace(/\s+/g, "");
        expect(meta).toBe(role?.trim() ? "Default·CodeQA·repo·codex" : "Default·repo·codex");
        wrapper.unmount();
      }
      window.innerWidth = prevWidth;
    });

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

      await wrapper.find('[data-test="topic-menu"]').trigger("click");
      const topicRows = wrapper.findAll('[data-test="topic-row"]');
      expect(topicRows).toHaveLength(2);

      await topicRows[1]?.find("button").trigger("click");
      expect(switchTopicSpy).toHaveBeenCalledWith("t2");
    });

    function seedBot(overrides: Partial<BotSummaryDto> = {}): void {
      useInstancesStore().instances = [
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
        { id: "b1", name: "ReviewerBot", agent: "codex", workspace: "repo", role: "Code QA", enabled: true, updatedAt: "now", ...overrides },
        { id: "b2", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
      ];
      directBots.topicsByConversation["i1:c1"] = [
        { id: "t1", conversationId: "c1", title: "Default", status: "active", createdAt: "now", updatedAt: "now" },
        { id: "t2", conversationId: "c1", title: "PR Review", status: "active", createdAt: "now", updatedAt: "now" },
      ];
    }

    it("mobile ⋯ sheet's topic row closes itself and opens the shared topic sheet", async () => {
      seedBot();
      const directBots = useDirectBotsStore();
      const switchTopicSpy = vi.spyOn(directBots, "switchTopic").mockResolvedValue();
      const prevWidth = window.innerWidth;
      window.innerWidth = 500;
      try {
        const wrapper = mount(DirectBotPane, { global: { plugins: [i18n] } });
        // Below lg the switcher is parked offscreen, never rendered in the header.
        expect(wrapper.find('header [data-test="topic-menu"]').exists()).toBe(false);
        const parked = wrapper.find('[data-test="topic-menu"]');
        expect(parked.element.closest(".parked-topic")).not.toBeNull();
        expect(parked.text()).toBe("Default");
        await wrapper.find('[data-test="mobile-bot-more"]').trigger("click");
        const topicRow = wrapper.find('[data-test="mobile-bot-more-sheet"] [data-test="sheet-bot-topic"]');
        expect(topicRow.exists()).toBe(true);
        expect(topicRow.text()).toContain("Default");
        await topicRow.trigger("click");
        await flushPromises();
        // One sheet at a time: the ⋯ sheet yields to the shared topic sheet.
        expect(wrapper.find('[data-test="mobile-bot-more-sheet"]').exists()).toBe(false);
        const sheet = wrapper.find('[data-test="bot-topic-sheet"]');
        expect(sheet.exists()).toBe(true);
        const rows = sheet.findAll('[data-test="topic-row"]');
        expect(rows).toHaveLength(2);
        // Same row anatomy as the group chat sheet: trailing ⋯, no inline action chips.
        expect(rows[1]!.find('[data-test="topic-row-more"]').exists()).toBe(true);
        expect(sheet.find('[data-test="topic-rename"]').exists()).toBe(false);
        expect(sheet.find('[data-test="topic-delete"]').exists()).toBe(false);
        // 「新建话题」 is the last entry of the sheet.
        const newTopic = sheet.find('[data-test="new-topic-button"]');
        expect(newTopic.exists()).toBe(true);
        const buttons = sheet.findAll("button");
        expect(buttons[buttons.length - 1]!.element).toBe(newTopic.element);
        await rows[1]!.find("button").trigger("click");
        expect(switchTopicSpy).toHaveBeenCalledWith("t2");
        expect(wrapper.find('[data-test="bot-topic-sheet"]').exists()).toBe(false);
      } finally {
        window.innerWidth = prevWidth;
      }
    });

    it("mounts exactly one TopicSwitcher per breakpoint: in the header on desktop, parked below lg", async () => {
      seedBot();
      const prevWidth = window.innerWidth;
      try {
        window.innerWidth = 1280;
        const desktop = mount(DirectBotPane, { global: { plugins: [i18n] } });
        expect(desktop.findAll('[data-test="topic-menu"]')).toHaveLength(1);
        expect(desktop.find('header [data-test="topic-menu"]').exists()).toBe(true);
        desktop.unmount();
        window.innerWidth = 500;
        const mobile = mount(DirectBotPane, { global: { plugins: [i18n] } });
        expect(mobile.findAll('[data-test="topic-menu"]')).toHaveLength(1);
        expect(mobile.find('header [data-test="topic-menu"]').exists()).toBe(false);
        expect(mobile.find('[data-test="topic-menu"]').element.closest(".parked-topic")).not.toBeNull();
        mobile.unmount();
      } finally {
        window.innerWidth = prevWidth;
      }
    });

    it("swaps the mounted TopicSwitcher when the viewport crosses lg", async () => {
      seedBot();
      const prevWidth = window.innerWidth;
      try {
        window.innerWidth = 1280;
        const wrapper = mount(DirectBotPane, { global: { plugins: [i18n] } });
        expect(wrapper.find('header [data-test="topic-menu"]').exists()).toBe(true);
        window.innerWidth = 500;
        window.dispatchEvent(new Event("resize"));
        await flushPromises();
        expect(wrapper.findAll('[data-test="topic-menu"]')).toHaveLength(1);
        expect(wrapper.find('header [data-test="topic-menu"]').exists()).toBe(false);
        expect(wrapper.find('[data-test="topic-menu"]').element.closest(".parked-topic")).not.toBeNull();
        wrapper.unmount();
      } finally {
        window.innerWidth = prevWidth;
      }
    });

    it("shows Default on both breakpoints when no topic is active (not the bot role)", async () => {
      seedBot();
      useDirectBotsStore().activeTopicId = null;
      const prevWidth = window.innerWidth;
      try {
        for (const width of [1280, 500]) {
          window.innerWidth = width;
          const wrapper = mount(DirectBotPane, { global: { plugins: [i18n] } });
          const pills = wrapper.findAll('[data-test="topic-menu"]');
          expect(pills).toHaveLength(1);
          expect(pills[0]!.text()).toBe("Default");
          expect(pills[0]!.text()).not.toContain("Code QA");
          wrapper.unmount();
        }
      } finally {
        window.innerWidth = prevWidth;
      }
    });

    it("desktop topic panel opens left-aligned under the pill, with new topic only at its bottom", async () => {
      seedBot();
      const wrapper = mount(DirectBotPane, { global: { plugins: [i18n] } });
      // No standalone header 「新建话题」 entry any more.
      expect(wrapper.find('[data-test="new-topic-button"]').exists()).toBe(false);
      await wrapper.find('[data-test="topic-menu"]').trigger("click");
      const panel = wrapper.find('[data-test="topic-panel"]');
      expect(panel.exists()).toBe(true);
      expect(panel.classes()).toContain("left-0");
      expect(panel.classes()).not.toContain("right-0");
      expect(wrapper.findAll('[data-test="new-topic-button"]')).toHaveLength(1);
      expect(panel.find('[data-test="new-topic-button"]').exists()).toBe(true);
    });

    it("desktop row ⋯ menu renames, archives and deletes Bot topics through the store", async () => {
      seedBot();
      const directBots = useDirectBotsStore();
      const updateTopic = vi.spyOn(directBots, "updateTopic").mockResolvedValue({} as never);
      const archiveTopic = vi.spyOn(directBots, "archiveTopic").mockResolvedValue({} as never);
      vi.spyOn(directBots, "previewTopic").mockResolvedValue({
        topic: directBots.topicsByConversation["i1:c1"]![1]!, bindings: [], unsettledRunIds: [], indeterminateRunIds: [], worktreeRunIds: [],
        actions: { rename: true, archive: true, restore: false, teardown: true, clear: false },
      } as never);
      const teardownTopic = vi.spyOn(directBots, "teardownTopic").mockResolvedValue({} as never);
      const wrapper = mount(DirectBotPane, { global: { plugins: [i18n] } });
      const openRowMenu = async () => {
        if (!wrapper.find('[data-test="topic-panel"]').exists()) await wrapper.find('[data-test="topic-menu"]').trigger("click");
        await wrapper.find('[data-test="topic-panel"]').findAll('[data-test="topic-row-more"]')[1]!.trigger("click");
        return wrapper.find('[data-test="context-menu"]');
      };

      let menu = await openRowMenu();
      expect(menu.find('[data-test="menu-rename"]').exists()).toBe(true);
      expect(menu.find('[data-test="menu-archive"]').exists()).toBe(true);
      expect(menu.find('[data-test="menu-delete"]').exists()).toBe(true);
      await menu.find('[data-test="menu-rename"]').trigger("click");
      await wrapper.find('[data-test="topic-rename-input"]').setValue("Renamed");
      await wrapper.find('[data-test="topic-panel"] form').trigger("submit");
      await flushPromises();
      expect(updateTopic).toHaveBeenCalledWith("i1", "c1", "t2", "Renamed");

      menu = await openRowMenu();
      await menu.find('[data-test="menu-archive"]').trigger("click");
      await flushPromises();
      expect(archiveTopic).toHaveBeenCalledWith("i1", "c1", "t2");

      menu = await openRowMenu();
      await menu.find('[data-test="menu-delete"]').trigger("click");
      await flushPromises();
      await wrapper.find('[data-test="topic-confirm-submit"]').trigger("click");
      await flushPromises();
      expect(teardownTopic).toHaveBeenCalledWith("i1", "c1", "t2", expect.any(String), false);
    });

    it("mobile more sheet carries nav / edit / delete, and delete is disabled for a retired bot", async () => {
      seedBot({ retired: true });
      useGroupsStore().groupsByInstance["i1"] = [
        { id: "g1", kind: "group", title: "Release", botIds: ["b1", "b2"], createdAt: "now", updatedAt: "now" },
      ];
      const wrapper = mount(DirectBotPane, { global: { plugins: [i18n] } });

      await wrapper.find('[data-test="mobile-bot-more"]').trigger("click");
      const sheet = wrapper.find('[data-test="mobile-bot-more-sheet"]');
      expect(sheet.exists()).toBe(true);
      expect(sheet.find('[data-test="sheet-bot-nav"]').exists()).toBe(true);
      expect(sheet.find('[data-test="sheet-bot-edit"]').exists()).toBe(true);
      const del = sheet.find('[data-test="sheet-bot-delete"]');
      expect(del.attributes("disabled")).toBeDefined();
      // Danger styling stays on the delete item.
      expect(del.classes()).toContain("text-danger");
      expect(del.classes()).toContain("hover:bg-danger/10");

      // "Talk with" opens the same other-bots + groups lists as the desktop nav menu.
      // It replaces the ⋯ sheet rather than stacking on it: one sheet dialog at a time.
      await sheet.find('[data-test="sheet-bot-nav"]').trigger("click");
      const nav = wrapper.find('[data-test="bot-nav-sheet"]');
      expect(nav.exists()).toBe(true);
      expect(wrapper.find('[data-test="mobile-bot-more-sheet"]').exists()).toBe(false);
      expect(wrapper.findAll('[role="dialog"]')).toHaveLength(1);
      await nav.find('[data-test="sheet-bot-option"]').trigger("click");
      expect(wrapper.emitted("navigateBot")?.[0]).toEqual(["i1", "b2"]);
      expect(wrapper.find('[data-test="bot-nav-sheet"]').exists()).toBe(false);
      await wrapper.find('[data-test="mobile-bot-more"]').trigger("click");
      await wrapper.find('[data-test="sheet-bot-nav"]').trigger("click");
      await wrapper.find('[data-test="sheet-group-option"]').trigger("click");
      expect(wrapper.emitted("navigateGroup")?.[0]).toEqual(["i1", "g1"]);
    });

    it("mobile bar's ← emits back (DashboardView returns to the home list)", async () => {
      seedBot();
      const wrapper = mount(DirectBotPane, { global: { plugins: [i18n] } });
      const back = wrapper.find('[data-test="mobile-back"]');
      expect(back.exists()).toBe(true);
      expect(back.attributes("aria-label")).toBe("Back");
      await back.trigger("click");
      expect(wrapper.emitted("back")).toHaveLength(1);
      expect(wrapper.find('[data-test="open-instances"]').exists()).toBe(false);
    });

    it("mobile more sheet's edit entry opens the bot dialog", async () => {
      seedBot();
      vi.spyOn(useInstancesStore(), "getAgentCapabilities").mockResolvedValue(needsSetupCapability(
        { code: "discovery-available", message: "no saved model list" },
        "Fetch the model list.",
        { fetchedAt: "2026-10-09T00:00:00.000Z" },
      ));
      const wrapper = mount(DirectBotPane, { global: { plugins: [i18n] } });
      await wrapper.find('[data-test="mobile-bot-more"]').trigger("click");
      await wrapper.find('[data-test="sheet-bot-edit"]').trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-test="mobile-bot-more-sheet"]').exists()).toBe(false);
      expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    });

    it("navigates to another Bot or a Group without treating @ as a handoff", async () => {
      const directBots = useDirectBotsStore();
      const groups = useGroupsStore();
      directBots.instanceId = "i1";
      directBots.selectedBotId = "b1";
      directBots.activeConversationId = "c1";
      directBots.activeTopicId = "t1";
      directBots.botsByInstance["i1"] = [
        { id: "b1", name: "ReviewerBot", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
        { id: "b2", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
      ];
      groups.groupsByInstance["i1"] = [
        { id: "g1", kind: "group", title: "Release", botIds: ["b1", "b2"], createdAt: "now", updatedAt: "now" },
      ];
      const wrapper = mount(DirectBotPane, { global: { plugins: [i18n] } });
      await wrapper.find('[data-test="direct-nav-button"]').trigger("click");
      await wrapper.find('[data-test="direct-nav-bot"]').trigger("click");
      expect(wrapper.emitted("navigateBot")?.[0]).toEqual(["i1", "b2"]);
      await wrapper.find('[data-test="direct-nav-button"]').trigger("click");
      await wrapper.find('[data-test="direct-nav-group"]').trigger("click");
      expect(wrapper.emitted("navigateGroup")?.[0]).toEqual(["i1", "g1"]);
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
      // 「新建话题」 sits at the bottom of the topic panel; the pill is the focus anchor.
      const trigger = wrapper.find('[data-test="topic-menu"]');
      (trigger.element as HTMLElement).focus();
      await trigger.trigger("click");
      await wrapper.find('[data-test="topic-panel"] [data-test="new-topic-button"]').trigger("click");
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
