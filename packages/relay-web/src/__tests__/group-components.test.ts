import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { BotSummaryDto, GroupSummaryDto } from "@ganglion/xacpx-relay-protocol";
import { i18n } from "../i18n";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useGroupsStore } from "../stores/groups";
import { useInstancesStore } from "../stores/instances";
import GroupPane from "../components/GroupPane.vue";
import GroupComposer from "../components/GroupComposer.vue";
import GroupTranscript from "../components/GroupTranscript.vue";
import InstanceTree from "../components/InstanceTree.vue";

const BOTS: BotSummaryDto[] = [
  { id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_b", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_off", name: "Sleeper", agent: "codex", workspace: "repo", enabled: false, updatedAt: "now" },
];

const GROUP: GroupSummaryDto = {
  id: "conversation_g",
  kind: "group",
  title: "Release Team",
  botIds: ["bot_a", "bot_b"],
  leadBotId: "bot_a",
  createdAt: "now",
  updatedAt: "now",
};

function seedInstance() {
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

function seedGroupSelection() {
  const groups = useGroupsStore();
  groups.instanceId = "i1";
  groups.selectedGroupId = "conversation_g";
  groups.activeConversationId = "conversation_g";
  groups.activeTopicId = "topic_1";
  groups.topicReady = true;
  groups.groupsByInstance["i1"] = [GROUP];
  groups.groupDetails["i1:conversation_g"] = { ...GROUP, topics: [] };
  groups.topicsByConversation["i1:conversation_g"] = [
    { id: "topic_1", conversationId: "conversation_g", title: "Sprint", status: "active", createdAt: "now", updatedAt: "now" },
  ];
  const direct = useDirectBotsStore();
  direct.botsByInstance["i1"] = BOTS;
  return groups;
}

describe("Group Components", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    seedInstance();
  });

  describe("GroupComposer.vue", () => {
    it("defaults the target button to the lead Bot", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS.filter((b) => GROUP.botIds.includes(b.id)) },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      expect(wrapper.find('[data-test="group-target-button"]').text()).toContain("Reviewer");
    });

    it("toggles members and switches to everyone", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS.filter((b) => GROUP.botIds.includes(b.id)) },
        global: { plugins: [i18n] },
      });
      await wrapper.find('[data-test="group-target-button"]').trigger("click");
      await wrapper.find('[data-test="group-target-member-bot_b"]').trigger("click");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_a", "bot_b"] });
      await wrapper.find('[data-test="group-target-everyone"]').trigger("click");
      expect(groups.targetSelection).toEqual({ mode: "everyone" });
      expect(wrapper.find('[data-test="group-target-button"]').text()).toContain("Everyone");
    });

    it("disables rows for disabled members", async () => {
      seedGroupSelection();
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS },
        global: { plugins: [i18n] },
      });
      await wrapper.find('[data-test="group-target-button"]').trigger("click");
      const off = wrapper.find('[data-test="group-target-member-bot_off"]');
      expect(off.exists()).toBe(true);
      expect(off.attributes("disabled")).toBeDefined();
    });

    it("only commits @everyone on the full token", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS.filter((b) => GROUP.botIds.includes(b.id)) },
        global: { plugins: [i18n] },
      });
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      await textarea.setValue("@");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_a"] });
      await textarea.setValue("@e");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_a"] });
      await textarea.setValue("@everyon");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_a"] });
      await textarea.setValue("@everyone");
      expect(groups.targetSelection).toEqual({ mode: "everyone" });
    });

    it("resolves @Name only for a unique enabled member", async () => {
      const groups = seedGroupSelection();
      groups.targetSelection = { mode: "members", botIds: ["bot_b"] };
      const wrapper = mount(GroupComposer, {
        props: { bots: BOTS },
        global: { plugins: [i18n] },
      });
      const textarea = wrapper.find('[data-test="group-composer-textarea"]');
      await textarea.setValue("@Tester");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_b"] });
      // Disabled Sleeper is not routable even though its name is exact.
      await textarea.setValue("@Sleeper");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_b"] });
      // Ambiguous duplicate name: never auto-pick the first row.
      groups.targetSelection = { mode: "members", botIds: [] };
      const dup = [
        { ...BOTS[0]!, id: "bot_a", name: "Same" },
        { ...BOTS[1]!, id: "bot_b", name: "Same" },
      ];
      await wrapper.setProps({ bots: dup });
      await textarea.setValue("@Same");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: [] });
      // Unique match still routes after the ambiguity is removed.
      await wrapper.setProps({ bots: [dup[0]!] });
      await textarea.setValue("@Same");
      expect(groups.targetSelection).toEqual({ mode: "members", botIds: ["bot_a"] });
    });
  });

  describe("GroupTranscript.vue", () => {
    it("renders one Run card row per member with exact statuses", async () => {
      const groups = seedGroupSelection();
      groups.activeRun = {
        id: "run_1", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "msg_1", requestId: "req_1", mode: "explicit", state: "running",
        profileRevision: 1, createdAt: "now",
      };
      groups.memberTurnsById = {
        turn_a: {
          id: "turn_a", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_a", batch: 1, memberIndex: 0, attempt: 1, origin: "human-explicit",
          state: "completed", createdAt: "now",
        },
        turn_b: {
          id: "turn_b", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_b", batch: 1, memberIndex: 1, attempt: 1, origin: "human-explicit",
          state: "running", createdAt: "now",
        },
      };
      const wrapper = mount(GroupTranscript, {
        props: { bots: BOTS.filter((b) => GROUP.botIds.includes(b.id)) },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      expect(wrapper.find('[data-test="group-run-card"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="group-run-card"]').attributes("data-run-id")).toBe("run_1");
      const rows = wrapper.findAll('[data-test="group-member-row"]');
      expect(rows).toHaveLength(2);
      expect(rows[0]?.attributes("data-bot-id")).toBe("bot_a");
      expect(rows[0]?.attributes("data-state")).toBe("completed");
      expect(rows[1]?.attributes("data-bot-id")).toBe("bot_b");
      expect(rows[1]?.attributes("data-state")).toBe("running");
    });

    it("expands member activity on toggle", async () => {
      const groups = seedGroupSelection();
      groups.activeRun = {
        id: "run_1", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "msg_1", requestId: "req_1", mode: "explicit", state: "running",
        profileRevision: 1, createdAt: "now",
      };
      groups.memberTurnsById = {
        turn_a: {
          id: "turn_a", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
          botId: "bot_a", batch: 1, memberIndex: 0, attempt: 1, origin: "human-explicit",
          state: "running", createdAt: "now",
        },
      };
      groups.liveTurnsByMember = {
        turn_a: { parts: [{ type: "text", text: "hello" }], status: "streaming", startedAt: Date.now(), revision: 1 },
      };
      const wrapper = mount(GroupTranscript, {
        props: { bots: BOTS.filter((b) => GROUP.botIds.includes(b.id)) },
        global: { plugins: [i18n] },
      });
      expect(wrapper.find('[data-test="group-member-activity"]').exists()).toBe(false);
      await wrapper.find('[data-test="group-member-toggle"]').trigger("click");
      expect(wrapper.find('[data-test="group-member-activity"]').exists()).toBe(true);
    });

    it("stops the exact active run from the card", async () => {
      const groups = seedGroupSelection();
      groups.activeRun = {
        id: "run_stop", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "msg_1", requestId: "req_1", mode: "explicit", state: "running",
        profileRevision: 1, createdAt: "now",
      };
      const spy = vi.spyOn(groups, "cancelCurrentRun").mockResolvedValue(undefined);
      const wrapper = mount(GroupTranscript, {
        props: { bots: BOTS.filter((b) => GROUP.botIds.includes(b.id)) },
        global: { plugins: [i18n] },
      });
      await wrapper.find('[data-test="group-stop-run-button"]').trigger("click");
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });
  });

  describe("GroupPane.vue", () => {
    it("binds transcript, composer, and topic strip without touching Direct state", async () => {
      seedGroupSelection();
      const direct = useDirectBotsStore();
      const wrapper = mount(GroupPane, { global: { plugins: [i18n] } });
      await flushPromises();
      expect(wrapper.find('[data-test="group-topic-pill"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="group-send-prompt-button"]').exists()).toBe(true);
      expect(direct.isBotSelected).toBe(false);
    });
  });

  describe("InstanceTree.vue groups nav", () => {
    it("lists groups and emits selectGroup", async () => {
      seedInstance();
      const groups = useGroupsStore();
      groups.groupsByInstance["i1"] = [GROUP];
      groups.groupsLoaded["i1"] = true;
      const wrapper = mount(InstanceTree, { global: { plugins: [i18n] } });
      await wrapper.find('[data-test="instance-nav-groups"]').trigger("click");
      const rows = wrapper.findAll('[data-test="group-row"]');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.text()).toContain("Release Team");
      await rows[0]?.find("button").trigger("click");
      expect(wrapper.emitted("selectGroup")).toEqual([["i1", "conversation_g"]]);
      expect(wrapper.emitted("selectBot")).toBeUndefined();
    });
  });
});
