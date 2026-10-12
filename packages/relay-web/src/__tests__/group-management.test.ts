import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type {
  BotSummaryDto,
  ConversationRunDetailDto,
  ConversationRunDto,
  GroupSummaryDto,
  TopicSummaryDto,
} from "@ganglion/xacpx-relay-protocol";

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
import { useDirectBotsStore } from "../stores/direct-bots";
import { useGroupsStore } from "../stores/groups";
import { useInstancesStore } from "../stores/instances";
import GroupDialog from "../components/GroupDialog.vue";
import GroupPane from "../components/GroupPane.vue";
import InstanceTree from "../components/InstanceTree.vue";

// Keep form/store assertions local; browser E2E covers the real Teleport layout.
config.global.stubs.teleport = true;

const REVIEWER: BotSummaryDto = { id: "bot_a", name: "Reviewer", role: "Code review", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" };
const TESTER: BotSummaryDto = { id: "bot_b", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" };
const SLEEPER: BotSummaryDto = { id: "bot_off", name: "Sleeper", agent: "codex", workspace: "repo", enabled: false, updatedAt: "now" };

const GROUP: GroupSummaryDto = {
  id: "conversation_g",
  kind: "group",
  title: "Release Team",
  botIds: ["bot_a", "bot_b", "bot_off"],
  leadBotId: "bot_a",
  createdAt: "now",
  updatedAt: "now",
};

const TOPIC: TopicSummaryDto = {
  id: "topic_1",
  conversationId: "conversation_g",
  title: "Sprint",
  status: "active",
  createdAt: "now",
  updatedAt: "now",
};

function run(id: string, state: ConversationRunDto["state"]): ConversationRunDto {
  return {
    id,
    conversationId: "conversation_g",
    topicId: "topic_1",
    requestMessageId: `msg_${id}`,
    requestId: `req_${id}`,
    mode: "explicit",
    state,
    profileRevision: 1,
    createdAt: "now",
  };
}

function seedInstance(): void {
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
}

function seedBots(bots: BotSummaryDto[]): void {
  const direct = useDirectBotsStore();
  direct.botsByInstance["i1"] = bots;
  direct.botsLoaded["i1"] = true;
}

function rpcError(code: string, message = code) {
  return { error: { code, message } };
}

function transportError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function rpcCalls(type: string) {
  return calls.filter((call) => call.type === type);
}

let wrappers: VueWrapper[] = [];
function track<T extends VueWrapper>(wrapper: T): T {
  wrappers.push(wrapper);
  return wrapper;
}

async function selectMembers(wrapper: VueWrapper, ids: string[]): Promise<void> {
  for (const id of ids) {
    await wrapper.find(`[data-test="group-dialog-member-${id}"] input`).setValue(true);
  }
}

describe("Group management", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    routes.clear();
    calls.length = 0;
    localStorage.clear();
    seedInstance();
    i18n.global.locale.value = "en";
  });

  afterEach(() => {
    for (const wrapper of wrappers) wrapper.unmount();
    wrappers = [];
  });

  describe("GroupDialog.vue create", () => {
    it("creates a Group with the first enabled member suggested as Lead and lists it only after the RPC succeeds", async () => {
      routes.set("control.bots.list", () => ({ bots: [SLEEPER, REVIEWER, TESTER] }));
      const created = { ...GROUP, id: "conversation_new", title: "Launch", botIds: ["bot_off", "bot_b"], leadBotId: "bot_b" };
      const gate = Promise.withResolvers<void>();
      routes.set("control.groups.create", async () => {
        await gate.promise;
        return { group: created };
      });
      routes.set("control.groups.list", () => ({ groups: [created] }));
      const groups = useGroupsStore();
      const wrapper = track(mount(GroupDialog, { props: { instanceId: "i1" }, global: { plugins: [i18n] } }));
      await flushPromises();

      await wrapper.find('[data-test="group-dialog-title"]').setValue("Launch");
      await selectMembers(wrapper, ["bot_off", "bot_b"]);
      expect((wrapper.find('[data-test="group-dialog-lead"]').element as HTMLSelectElement).value).toBe("bot_b");

      await wrapper.find('[data-test="group-dialog-save"]').trigger("click");
      expect(groups.groupsByInstance["i1"] ?? []).toEqual([]);
      gate.resolve();
      await flushPromises();

      expect(rpcCalls("control.groups.create")[0]?.payload).toEqual({
        title: "Launch",
        botIds: ["bot_off", "bot_b"],
        leadBotId: "bot_b",
      });
      expect(groups.groupsByInstance["i1"]?.map((g) => g.id)).toEqual(["conversation_new"]);
      expect(wrapper.emitted("saved")).toEqual([[created]]);
      expect(wrapper.emitted("close")).toHaveLength(1);
    });

    it("keeps Save disabled until there is a name and two distinct members", async () => {
      seedBots([REVIEWER, TESTER]);
      const wrapper = track(mount(GroupDialog, { props: { instanceId: "i1" }, global: { plugins: [i18n] } }));
      await flushPromises();
      const save = () => wrapper.find('[data-test="group-dialog-save"]').attributes("disabled");

      await selectMembers(wrapper, ["bot_a", "bot_b"]);
      expect(save()).toBeDefined();
      await wrapper.find('[data-test="group-dialog-title"]').setValue("Pair");
      expect(save()).toBeUndefined();
      await wrapper.find('[data-test="group-dialog-member-bot_b"] input').setValue(false);
      expect(save()).toBeDefined();
      expect(wrapper.find('[data-test="group-dialog-member-count"]').text()).toBe("1 selected");
    });

    it("guides the user to create Bots when the instance has fewer than two", async () => {
      seedBots([REVIEWER]);
      const wrapper = track(mount(GroupDialog, { props: { instanceId: "i1" }, global: { plugins: [i18n] } }));
      await flushPromises();

      expect(wrapper.find('[data-test="group-dialog-need-bots"]').text()).toContain("This instance has 1.");
      await wrapper.find('[data-test="group-dialog-create-bot"]').trigger("click");
      expect(wrapper.emitted("createBot")).toHaveLength(1);
    });

    it("tells Bots with the same name apart by their stable ID", async () => {
      seedBots([REVIEWER, { ...TESTER, name: "Reviewer" }]);
      const wrapper = track(mount(GroupDialog, { props: { instanceId: "i1" }, global: { plugins: [i18n] } }));
      await flushPromises();
      await selectMembers(wrapper, ["bot_a", "bot_b"]);

      expect(wrapper.find('[data-test="group-dialog-member-bot_b"] [data-test="group-dialog-member-id"]').text()).toBe("bot_b");
      const options = wrapper.findAll('[data-test="group-dialog-lead"] option').map((o) => o.text());
      expect(options).toEqual(["No Lead", "Reviewer (bot_a)", "Reviewer (bot_b)"]);
    });

    it("does not report a timed-out create as failed or saved and refreshes the list", async () => {
      seedBots([REVIEWER, TESTER]);
      routes.set("control.groups.create", () => {
        throw transportError("timeout");
      });
      routes.set("control.groups.list", () => ({ groups: [] }));
      const wrapper = track(mount(GroupDialog, { props: { instanceId: "i1" }, global: { plugins: [i18n] } }));
      await flushPromises();
      await wrapper.find('[data-test="group-dialog-title"]').setValue("Pair");
      await selectMembers(wrapper, ["bot_a", "bot_b"]);
      await wrapper.find('[data-test="group-dialog-save"]').trigger("click");
      await flushPromises();

      expect(wrapper.find('[data-test="group-dialog-error"]').text()).toContain("The Group may already exist");
      expect(rpcCalls("control.groups.list")).toHaveLength(1);
      expect(wrapper.emitted("saved")).toBeUndefined();
      expect(wrapper.emitted("close")).toBeUndefined();
    });

    it("maps backend validation codes to readable messages in both locales", async () => {
      seedBots([REVIEWER, TESTER]);
      routes.set("control.groups.create", () => rpcError("group_lead_not_member", "lead must be a member"));
      const wrapper = track(mount(GroupDialog, { props: { instanceId: "i1" }, global: { plugins: [i18n] } }));
      await flushPromises();
      await wrapper.find('[data-test="group-dialog-title"]').setValue("Pair");
      await selectMembers(wrapper, ["bot_a", "bot_b"]);
      await wrapper.find('[data-test="group-dialog-save"]').trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-test="group-dialog-error"]').text()).toBe("The Lead must be one of the members.");

      i18n.global.locale.value = "zh-CN";
      await wrapper.find('[data-test="group-dialog-save"]').trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-test="group-dialog-error"]').text()).toBe("负责人必须是群组成员。");
    });
  });

  describe("GroupDialog.vue edit", () => {
    it("moves the Lead to the next enabled member when the Lead is removed and sends only changed fields", async () => {
      seedBots([REVIEWER, TESTER, SLEEPER]);
      const groups = useGroupsStore();
      groups.groupsByInstance["i1"] = [GROUP];
      const updated = { ...GROUP, botIds: ["bot_b", "bot_off"], leadBotId: "bot_b" };
      routes.set("control.groups.update", () => ({ group: updated }));
      routes.set("control.groups.list", () => ({ groups: [updated] }));
      const wrapper = track(mount(GroupDialog, { props: { instanceId: "i1", group: GROUP }, global: { plugins: [i18n] } }));
      await flushPromises();

      await wrapper.find('[data-test="group-dialog-member-bot_a"] input').setValue(false);
      expect((wrapper.find('[data-test="group-dialog-lead"]').element as HTMLSelectElement).value).toBe("bot_b");
      expect(wrapper.find('[data-test="group-dialog-lead-reassigned"]').text()).toBe("Reviewer is no longer a member, so the Lead is now Tester.");

      await wrapper.find('[data-test="group-dialog-save"]').trigger("click");
      await flushPromises();
      expect(rpcCalls("control.groups.update")[0]?.payload).toEqual({
        id: "conversation_g",
        botIds: ["bot_b", "bot_off"],
        leadBotId: "bot_b",
      });
      expect(groups.groupsByInstance["i1"]?.[0]?.botIds).toEqual(["bot_b", "bot_off"]);
    });

    it("blocks dropping below two members", async () => {
      seedBots([REVIEWER, TESTER]);
      const pair = { ...GROUP, botIds: ["bot_a", "bot_b"] };
      const wrapper = track(mount(GroupDialog, { props: { instanceId: "i1", group: pair }, global: { plugins: [i18n] } }));
      await flushPromises();
      await wrapper.find('[data-test="group-dialog-member-bot_b"] input').setValue(false);
      expect(wrapper.find('[data-test="group-dialog-save"]').attributes("disabled")).toBeDefined();
    });

    it("does not roll back a remote rename that lands after the dialog opened", async () => {
      seedBots([REVIEWER, TESTER, SLEEPER]);
      const groups = useGroupsStore();
      groups.groupsByInstance["i1"] = [GROUP];
      routes.set("control.groups.update", (payload) => ({ group: { ...GROUP, ...payload } }));
      routes.set("control.groups.list", () => ({ groups: [GROUP] }));
      const wrapper = track(mount(GroupDialog, { props: { instanceId: "i1", group: GROUP }, global: { plugins: [i18n] } }));
      await flushPromises();

      await wrapper.setProps({ group: { ...GROUP, title: "Renamed elsewhere" } });
      await wrapper.find('[data-test="group-dialog-description"]').setValue("Ships the release");
      await wrapper.find('[data-test="group-dialog-save"]').trigger("click");
      await flushPromises();

      expect(rpcCalls("control.groups.update")[0]?.payload).toEqual({ id: "conversation_g", description: "Ships the release" });
    });

    it("finds the Run that holds a removed member, stops it, and confirms nothing is left", async () => {
      seedBots([REVIEWER, TESTER, SLEEPER]);
      const groups = useGroupsStore();
      groups.groupsByInstance["i1"] = [GROUP];
      let cancelled = false;
      routes.set("control.groups.update", () =>
        rpcError("group_member_has_work", 'bot "bot_off" still has nonterminal work'));
      routes.set("control.groups.get", () => ({ group: { ...GROUP, topics: [TOPIC] } }));
      routes.set("control.runs.list", () => ({
        conversationId: "conversation_g",
        topicId: "topic_1",
        runs: [run("run_done", "completed"), run("run_live", cancelled ? "cancelled" : "running")],
      }));
      routes.set("control.runs.get", (payload): { run: ConversationRunDetailDto } => ({
        run: {
          ...run(String(payload.runId), "running"),
          memberTurns: [{
            id: "mt_1",
            runId: String(payload.runId),
            conversationId: "conversation_g",
            topicId: "topic_1",
            botId: "bot_off",
            batch: 0,
            attempt: 1,
            origin: "human-explicit",
            state: "running",
            createdAt: "now",
          }],
        },
      }));
      routes.set("control.runs.cancel", () => {
        cancelled = true;
        return { run: { ...run("run_live", "cancelled"), memberTurns: [] } };
      });
      const wrapper = track(mount(GroupDialog, { props: { instanceId: "i1", group: GROUP }, global: { plugins: [i18n] } }));
      await flushPromises();

      await wrapper.find('[data-test="group-dialog-member-bot_off"] input').setValue(false);
      await wrapper.find('[data-test="group-dialog-save"]').trigger("click");
      await flushPromises();

      expect(wrapper.find('[data-test="group-dialog-error"]').text()).toBe("A member you removed still has unfinished work in this Group.");
      const rows = wrapper.findAll('[data-test="group-dialog-member-work-row"]');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.text()).toContain("Sprint · Running · Sleeper");
      expect(rpcCalls("control.runs.get").map((c) => c.payload.runId)).toEqual(["run_live"]);

      await wrapper.find('[data-test="group-dialog-stop-run-run_live"]').trigger("click");
      await flushPromises();
      expect(rpcCalls("control.runs.cancel")[0]?.payload).toEqual({ runId: "run_live" });
      expect(wrapper.findAll('[data-test="group-dialog-member-work-row"]')).toHaveLength(0);
      expect(wrapper.find('[data-test="group-dialog-member-work"]').text()).toContain("No unfinished work is left");
    });
  });

  describe("GroupDialog.vue delete", () => {
    it("states the consequences with the Topic count and removes the Group after the teardown succeeds", async () => {
      seedBots([REVIEWER, TESTER, SLEEPER]);
      const groups = useGroupsStore();
      groups.groupsByInstance["i1"] = [GROUP];
      routes.set("control.groups.get", () => ({ group: { ...GROUP, topics: [TOPIC, { ...TOPIC, id: "topic_2" }] } }));
      routes.set("control.groups.delete", () => ({ ok: true }));
      routes.set("control.groups.list", () => ({ groups: [] }));
      const wrapper = track(mount(GroupDialog, { props: { instanceId: "i1", group: GROUP }, global: { plugins: [i18n] } }));
      await flushPromises();

      await wrapper.find('[data-test="group-dialog-delete"]').trigger("click");
      await flushPromises();
      const confirmText = wrapper.find('[data-test="group-dialog-delete-confirm"]').text();
      expect(confirmText).toContain("Topics in this Group: 2.");
      expect(confirmText).toContain("never discarded");
      expect(confirmText).toContain("The member Bots and their Direct chats are kept.");
      expect(rpcCalls("control.groups.delete")).toHaveLength(0);

      await wrapper.find('[data-test="group-dialog-delete-confirm-button"]').trigger("click");
      await flushPromises();
      expect(rpcCalls("control.groups.delete")[0]?.payload).toEqual({ id: "conversation_g" });
      expect(groups.groupsByInstance["i1"]).toEqual([]);
      expect(wrapper.emitted("deleted")).toEqual([["conversation_g"]]);
    });

    it("keeps a timed-out delete visible as unfinished and lets the user retry it", async () => {
      seedBots([REVIEWER, TESTER, SLEEPER]);
      const groups = useGroupsStore();
      groups.groupsByInstance["i1"] = [GROUP];
      let deleteAttempts = 0;
      routes.set("control.groups.get", () => ({ group: { ...GROUP, topics: [TOPIC] } }));
      routes.set("control.groups.delete", () => {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw transportError("timeout");
        return { ok: true };
      });
      routes.set("control.groups.list", () => ({
        groups: deleteAttempts === 1 ? [{ ...GROUP, lifecycle: "deleting" }] : [],
      }));
      const wrapper = track(mount(GroupDialog, { props: { instanceId: "i1", group: GROUP }, global: { plugins: [i18n] } }));
      await flushPromises();

      await wrapper.find('[data-test="group-dialog-delete"]').trigger("click");
      await flushPromises();
      await wrapper.find('[data-test="group-dialog-delete-confirm-button"]').trigger("click");
      await flushPromises();

      expect(wrapper.find('[data-test="group-dialog-error"]').text()).toContain("did not confirm the delete in time");
      expect(wrapper.find('[data-test="group-dialog-deleting"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="group-dialog-save"]').attributes("disabled")).toBeDefined();
      expect(wrapper.emitted("deleted")).toBeUndefined();
      expect(groups.groupsByInstance["i1"]?.[0]?.lifecycle).toBe("deleting");

      await wrapper.find('[data-test="group-dialog-retry-delete"]').trigger("click");
      await flushPromises();
      expect(deleteAttempts).toBe(2);
      expect(groups.groupsByInstance["i1"]).toEqual([]);
      expect(wrapper.emitted("deleted")).toEqual([["conversation_g"]]);
    });

    it("treats a timed-out delete as done when the re-read no longer lists the Group", async () => {
      seedBots([REVIEWER, TESTER, SLEEPER]);
      const groups = useGroupsStore();
      groups.groupsByInstance["i1"] = [GROUP];
      routes.set("control.groups.get", () => ({ group: { ...GROUP, topics: [] } }));
      routes.set("control.groups.delete", () => {
        throw transportError("timeout");
      });
      routes.set("control.groups.list", () => ({ groups: [] }));
      const wrapper = track(mount(GroupDialog, { props: { instanceId: "i1", group: GROUP }, global: { plugins: [i18n] } }));
      await flushPromises();

      await wrapper.find('[data-test="group-dialog-delete"]').trigger("click");
      await flushPromises();
      await wrapper.find('[data-test="group-dialog-delete-confirm-button"]').trigger("click");
      await flushPromises();

      expect(wrapper.emitted("deleted")).toEqual([["conversation_g"]]);
      expect(groups.groupsByInstance["i1"]).toEqual([]);
    });
  });

  describe("InstanceTree.vue Group entries", () => {
    it("offers New Group on an empty list and selects the created Group", async () => {
      seedBots([REVIEWER, TESTER]);
      const groups = useGroupsStore();
      groups.groupsLoaded["i1"] = true;
      groups.groupsByInstance["i1"] = [];
      const created = { ...GROUP, id: "conversation_new", botIds: ["bot_a", "bot_b"] };
      routes.set("control.groups.create", () => ({ group: created }));
      routes.set("control.groups.list", () => ({ groups: [created] }));
      const wrapper = track(mount(InstanceTree, { attachTo: document.body, global: { plugins: [i18n] } }));
      await wrapper.find('[data-test="instance-nav-groups"]').trigger("click");
      expect(wrapper.find('[data-test="no-groups"]').exists()).toBe(true);

      await wrapper.find('[data-test="new-group-button"]').trigger("click");
      const dialog = wrapper.findComponent(GroupDialog);
      await dialog.find('[data-test="group-dialog-title"]').setValue("Release Team");
      await selectMembers(dialog, ["bot_a", "bot_b"]);
      await dialog.find('[data-test="group-dialog-save"]').trigger("click");
      await flushPromises();

      expect(wrapper.emitted("selectGroup")).toEqual([["i1", "conversation_new"]]);
      expect(wrapper.findComponent(GroupDialog).exists()).toBe(false);
      expect(wrapper.findAll('[data-test="group-row"]')).toHaveLength(1);
    });

    it.each([
      ["saved", true],
      ["cancelled", false],
    ])("returns to the Group form after the Bot form opened from its guidance is %s", async (_label, saved) => {
      seedBots([REVIEWER]);
      routes.set("control.agents.list", () => ({ agents: [{ name: "codex", driver: "codex" }] }));
      routes.set("control.workspaces.list", () => ({ workspaces: [{ name: "repo", cwd: "/repo" }] }));
      routes.set("control.agents.catalog", () => ({ agents: [] }));
      const groups = useGroupsStore();
      groups.groupsLoaded["i1"] = true;
      const wrapper = track(mount(InstanceTree, { attachTo: document.body, global: { plugins: [i18n] } }));
      await wrapper.find('[data-test="instance-nav-groups"]').trigger("click");
      await wrapper.find('[data-test="new-group-button"]').trigger("click");
      await flushPromises();

      await wrapper.find('[data-test="group-dialog-create-bot"]').trigger("click");
      expect(wrapper.findComponent(GroupDialog).exists()).toBe(false);
      const botDialog = wrapper.findComponent({ name: "BotDialog" });
      expect(botDialog.exists()).toBe(true);
      if (saved) botDialog.vm.$emit("saved", { ...TESTER, instructions: null, profileRevision: 1 });
      botDialog.vm.$emit("close");
      await flushPromises();

      expect(wrapper.findComponent({ name: "BotDialog" }).exists()).toBe(false);
      expect(wrapper.findComponent(GroupDialog).exists()).toBe(true);
      expect(wrapper.emitted("selectBot")).toBeUndefined();
    });

    it("still selects a Bot created from the Bots footer", async () => {
      seedBots([REVIEWER]);
      routes.set("control.agents.list", () => ({ agents: [{ name: "codex", driver: "codex" }] }));
      routes.set("control.workspaces.list", () => ({ workspaces: [{ name: "repo", cwd: "/repo" }] }));
      routes.set("control.agents.catalog", () => ({ agents: [] }));
      const wrapper = track(mount(InstanceTree, { attachTo: document.body, global: { plugins: [i18n] } }));
      await wrapper.find('[data-test="instance-nav-bots"]').trigger("click");
      await wrapper.find('[data-test="new-bot-button"]').trigger("click");
      const botDialog = wrapper.findComponent({ name: "BotDialog" });
      botDialog.vm.$emit("saved", { ...TESTER, instructions: null, profileRevision: 1 });
      botDialog.vm.$emit("close");
      await flushPromises();

      expect(wrapper.emitted("selectBot")).toEqual([["i1", "bot_b"]]);
      expect(wrapper.findComponent(GroupDialog).exists()).toBe(false);
    });

    it("marks a Group whose delete has not finished", async () => {
      const groups = useGroupsStore();
      groups.groupsLoaded["i1"] = true;
      groups.groupsByInstance["i1"] = [{ ...GROUP, lifecycle: "deleting" }];
      const wrapper = track(mount(InstanceTree, { global: { plugins: [i18n] } }));
      await wrapper.find('[data-test="instance-nav-groups"]').trigger("click");
      expect(wrapper.find('[data-test="group-deleting-badge"]').text()).toBe("Deleting");
    });
  });

  describe("GroupPane.vue first use", () => {
    function seedSelectedGroup(topics: TopicSummaryDto[]) {
      seedBots([REVIEWER, TESTER, SLEEPER]);
      const groups = useGroupsStore();
      groups.instanceId = "i1";
      groups.selectedGroupId = GROUP.id;
      groups.activeConversationId = GROUP.id;
      groups.activeTopicId = topics[0]?.id ?? null;
      groups.topicReady = true;
      groups.groupsByInstance["i1"] = [GROUP];
      groups.topicsByConversation[`i1:${GROUP.id}`] = topics;
      return groups;
    }

    it("leads a Group with no Topics to create its first Topic", async () => {
      seedSelectedGroup([]);
      const wrapper = track(mount(GroupPane, { global: { plugins: [i18n] } }));
      await flushPromises();

      expect(wrapper.find('[data-test="group-first-topic"]').text()).toContain("Start with a Topic");
      await wrapper.find('[data-test="group-first-topic-button"]').trigger("click");
      expect(wrapper.find("#group-topic-title").exists()).toBe(true);
    });

    it("loads the instance workspaces for the first Topic on a fresh page", async () => {
      seedSelectedGroup([]);
      useInstancesStore().instances[0]!.workspaces = [];
      routes.set("control.workspaces.list", () => ({ workspaces: [{ name: "repo", cwd: "/repo" }] }));
      routes.set("control.group.topics.create", () => ({ topic: TOPIC }));
      routes.set("control.runs.list", () => ({ conversationId: GROUP.id, topicId: TOPIC.id, runs: [] }));
      const wrapper = track(mount(GroupPane, { global: { plugins: [i18n] } }));
      await flushPromises();

      await wrapper.find('[data-test="group-first-topic-button"]').trigger("click");
      await flushPromises();
      const select = wrapper.find('[data-test="group-topic-workspace"]');
      expect(select.findAll("option").map((o) => o.text())).toEqual(["Select a workspace", "repo"]);

      await wrapper.find('#group-topic-title ~ form input[type="text"]').setValue("Sprint");
      await select.setValue("repo");
      await wrapper.find("#group-topic-title ~ form").trigger("submit");
      await flushPromises();
      expect(rpcCalls("control.group.topics.create").map((c) => c.payload)).toEqual([
        { conversationId: GROUP.id, title: "Sprint", target: { workspace: "repo", isolation: "shared-single-writer" } },
      ]);
    });

    it("offers a retry when the first Topic cannot load workspaces", async () => {
      seedSelectedGroup([]);
      useInstancesStore().instances[0]!.workspaces = [];
      let attempts = 0;
      routes.set("control.workspaces.list", () => {
        attempts += 1;
        if (attempts === 1) throw transportError("relay_timeout");
        return { workspaces: [{ name: "repo", cwd: "/repo" }] };
      });
      const wrapper = track(mount(GroupPane, { global: { plugins: [i18n] } }));
      await flushPromises();

      await wrapper.find('[data-test="group-first-topic-button"]').trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-test="group-topic-workspaces-failed"]').text()).toContain("Could not load the workspaces for this instance.");
      await wrapper.find('[data-test="group-topic-workspaces-retry"]').trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-test="group-topic-workspaces-failed"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="group-topic-workspace"]').findAll("option").map((o) => o.text())).toEqual(["Select a workspace", "repo"]);
    });

    it("hides the first-Topic prompt once a Topic exists", async () => {
      seedSelectedGroup([TOPIC]);
      routes.set("control.runs.list", () => ({ conversationId: GROUP.id, topicId: TOPIC.id, runs: [] }));
      const wrapper = track(mount(GroupPane, { global: { plugins: [i18n] } }));
      await flushPromises();
      expect(wrapper.find('[data-test="group-first-topic"]').exists()).toBe(false);
    });

    it("opens the Group editor from the header", async () => {
      seedSelectedGroup([TOPIC]);
      const wrapper = track(mount(GroupPane, { global: { plugins: [i18n] } }));
      await flushPromises();
      await wrapper.find('[data-test="group-edit-button"]').trigger("click");
      const dialog = wrapper.findComponent(GroupDialog);
      expect(dialog.exists()).toBe(true);
      expect((dialog.find('[data-test="group-dialog-title"]').element as HTMLInputElement).value).toBe("Release Team");
    });
  });
});
