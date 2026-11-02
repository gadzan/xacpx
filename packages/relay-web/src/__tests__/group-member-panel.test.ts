import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { BotSummaryDto, GroupSummaryDto } from "@ganglion/xacpx-relay-protocol";
import { i18n } from "../i18n";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useGroupsStore } from "../stores/groups";
import { useInstancesStore } from "../stores/instances";
import GroupMemberPanel from "../components/GroupMemberPanel.vue";
import GroupPane from "../components/GroupPane.vue";

const BOTS: BotSummaryDto[] = [
  { id: "bot_a", name: "Reviewer", role: "Code review", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_b", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_off", name: "Sleeper", agent: "codex", workspace: "repo", enabled: false, updatedAt: "now" },
];

const GROUP: GroupSummaryDto = {
  id: "conversation_g",
  kind: "group",
  title: "Release Team",
  botIds: ["bot_a", "bot_b", "bot_off"],
  leadBotId: "bot_a",
  createdAt: "now",
  updatedAt: "now",
};

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

function seedGroupSelection(): void {
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
  direct.botsLoaded["i1"] = true;
}

/** A running member turn for one Bot, the way a live run lands it. */
function runningTurn(botId: string, id = "turn_a") {
  return {
    id,
    runId: "run_1",
    conversationId: "conversation_g",
    topicId: "topic_1",
    botId,
    batch: 1,
    memberIndex: 0,
    attempt: 1,
    origin: "human-explicit" as const,
    state: "running" as const,
    createdAt: "now",
  };
}

describe("Group member panel", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    seedInstance();
    vi.spyOn(useInstancesStore(), "loadRouterAvailability").mockResolvedValue(undefined);
    vi.spyOn(useInstancesStore(), "loadJevSettings").mockResolvedValue(undefined);
    i18n.global.locale.value = "en";
  });

  afterEach(() => {
    window.innerWidth = 1024;
    i18n.global.locale.value = "en";
  });

  describe("the roster", () => {
    it("lists enabled and disabled members, and names the disabled count in the accessible label", async () => {
      seedGroupSelection();
      const wrapper = mount(GroupMemberPanel, { global: { plugins: [i18n], stubs: { teleport: true } } });
      await flushPromises();

      const rows = wrapper.findAll('[data-test="group-member-row"]');
      expect(rows).toHaveLength(3);
      // The Lead comes first, then the Group's own member order.
      expect(rows[0]!.attributes("data-bot-id")).toBe("bot_a");
      expect(rows[1]!.attributes("data-bot-id")).toBe("bot_b");
      expect(rows[2]!.attributes("data-bot-id")).toBe("bot_off");

      // A disabled member is still a member: it is listed, with its state.
      expect(rows[0]!.attributes("data-state")).toBe("enabled");
      expect(rows[2]!.attributes("data-state")).toBe("disabled");
      expect(rows[2]!.find('[data-test="group-member-state"]').text()).toContain("Disabled");
      // ... and the reason is spelled out, not left to the colour.
      expect(rows[2]!.find('[data-test="group-member-disabled-reason"]').text()).toContain("takes no new work");

      // The count of disabled members rides in the accessible name.
      const label = wrapper.find('[data-test="group-member-dialog"]').attributes("aria-label") ?? "";
      expect(label).toContain("Release Team");
      expect(label).toContain("3 members");
      expect(label).toContain("1 disabled");
      wrapper.unmount();
    });
    it("marks the Lead and keeps the enabled count out of the disabled tally", async () => {
      seedGroupSelection();
      const wrapper = mount(GroupMemberPanel, { global: { plugins: [i18n], stubs: { teleport: true } } });
      await flushPromises();

      const rows = wrapper.findAll('[data-test="group-member-row"]');
      expect(rows[0]!.find('[data-test="group-member-lead"]').exists()).toBe(true);
      expect(rows[1]!.find('[data-test="group-member-lead"]').exists()).toBe(false);
      // The role rides with the name.
      expect(rows[0]!.find('[data-test="group-member-role"]').text()).toBe("Code review");
      wrapper.unmount();
    });
  });

  describe("the who-is-working row", () => {
    it("names the member that is executing a turn, and disappears when nobody runs", async () => {
      seedGroupSelection();
      const groups = useGroupsStore();
      groups.activeRun = {
        id: "run_1", conversationId: "conversation_g", topicId: "topic_1",
        requestMessageId: "msg_1", requestId: "req_1", mode: "explicit", state: "running",
        profileRevision: 1, createdAt: "now",
      };
      groups.memberTurnsById = { turn_a: runningTurn("bot_a") };

      const wrapper = mount(GroupPane, { global: { plugins: [i18n] } });
      await flushPromises();

      const row = wrapper.find('[data-test="group-working-row"]');
      expect(row.exists()).toBe(true);
      expect(row.find('[data-test="group-working-text"]').text()).toContain("Reviewer");

      // The turn ends: the row is gone, because an idle Group shows no status.
      groups.memberTurnsById = { turn_a: { ...runningTurn("bot_a"), state: "completed" } };
      await flushPromises();
      expect(wrapper.find('[data-test="group-working-row"]').exists()).toBe(false);
      wrapper.unmount();
    });

    it("shows nothing while the Group has no run at all", async () => {
      seedGroupSelection();
      const wrapper = mount(GroupPane, { global: { plugins: [i18n] } });
      await flushPromises();
      expect(wrapper.find('[data-test="group-working-row"]').exists()).toBe(false);
      wrapper.unmount();
    });
  });

  describe("the entry points", () => {
    it("opens the panel from the top bar's ⋯ menu", async () => {
      seedGroupSelection();
      window.innerWidth = 500;
      const wrapper = mount(GroupPane, { global: { plugins: [i18n], stubs: { teleport: true } } });
      await flushPromises();

      expect(wrapper.find('[data-test="group-member-sheet"]').exists()).toBe(false);
      await wrapper.find('[data-test="mobile-group-more"]').trigger("click");
      await flushPromises();
      const sheet = wrapper.find('[data-test="group-more-sheet"]');
      expect(sheet.exists()).toBe(true);

      await sheet.find('[data-test="sheet-group-members"]').trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-test="group-member-sheet"]').exists()).toBe(true);
      expect(wrapper.findAll('[data-test="group-member-row"]')).toHaveLength(3);
      wrapper.unmount();
    });

    it("opens the panel from the top bar's avatar collage", async () => {
      seedGroupSelection();
      const wrapper = mount(GroupPane, { global: { plugins: [i18n], stubs: { teleport: true } } });
      await flushPromises();

      expect(wrapper.find('[data-test="group-member-dialog"]').exists()).toBe(false);
      await wrapper.find('[data-test="group-desktop-avatar-button"]').trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-test="group-member-dialog"]').exists()).toBe(true);
      wrapper.unmount();
    });

    it("closes the panel again from the desktop dialog's close button", async () => {
      seedGroupSelection();
      const wrapper = mount(GroupPane, { global: { plugins: [i18n], stubs: { teleport: true } } });
      await flushPromises();

      await wrapper.find('[data-test="group-desktop-avatar-button"]').trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-test="group-member-dialog"]').exists()).toBe(true);

      await wrapper.find('[data-test="group-member-close"]').trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-test="group-member-dialog"]').exists()).toBe(false);
      wrapper.unmount();
    });
  });
});
