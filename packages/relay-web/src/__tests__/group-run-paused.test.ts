import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { BotSummaryDto, ConversationRunDto, GroupSummaryDto } from "@ganglion/xacpx-relay-protocol";
import { i18n } from "../i18n";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useGroupsStore } from "../stores/groups";
import { useInstancesStore } from "../stores/instances";
import GroupComposer from "../components/GroupComposer.vue";
import GroupRunDetailHeader from "../components/GroupRunDetailHeader.vue";

const BOTS: BotSummaryDto[] = [
  { id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_b", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
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

const RUN: ConversationRunDto = {
  id: "run_1",
  conversationId: "conversation_g",
  topicId: "topic_1",
  requestMessageId: "message_1",
  requestId: "req_1",
  mode: "explicit",
  state: "paused",
  profileRevision: 1,
  controlRevision: 4,
  pauseReason: "human-paused",
  pauseRequestedAt: "now",
  pausedAt: "now",
  maxMemberTurns: 24,
  consumedMemberTurns: 1,
  failedBotIds: [],
  unavailableBotIds: [],
  createdAt: "now",
};

function seedGroupSelection(run: ConversationRunDto) {
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
      capabilities: ["runs.pause.v1"],
    } as never,
  ];
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
  groups.activeRun = run;
  groups.targetSelection = { mode: "members", botIds: ["bot_a"] };
  useDirectBotsStore().botsByInstance["i1"] = BOTS;
  return groups;
}

describe("paused Run presentation", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.spyOn(useInstancesStore(), "loadRouterAvailability").mockResolvedValue(undefined);
    vi.spyOn(useInstancesStore(), "loadJevSettings").mockResolvedValue(undefined);
  });

  it("shows the paused state and offers Resume instead of Pause", async () => {
    seedGroupSelection(RUN);
    const wrapper = mount(GroupRunDetailHeader, {
      props: { run: RUN, variant: "popover", pauseAvailable: true },
      global: { plugins: [i18n] },
    });
    await flushPromises();
    expect(wrapper.find('[data-test="group-detail-state"]').text()).toBe("Paused");
    const button = wrapper.find('[data-test="group-pause-run-button"]');
    expect(button.exists()).toBe(true);
    expect(button.attributes("data-paused")).toBe("true");
    expect(button.text()).toBe("Resume");
    await button.trigger("click");
    expect(wrapper.emitted("pause")).toHaveLength(1);
  });

  it("offers Pause on a running Run", async () => {
    const running = { ...RUN, state: "running" as const, pausedAt: undefined };
    seedGroupSelection(running);
    const wrapper = mount(GroupRunDetailHeader, {
      props: { run: running, variant: "popover", pauseAvailable: true },
      global: { plugins: [i18n] },
    });
    const button = wrapper.find('[data-test="group-pause-run-button"]');
    expect(button.attributes("data-paused")).toBe("false");
    expect(button.text()).toBe("Pause");
  });

  it("hides the control when the core has no pause capability", async () => {
    seedGroupSelection(RUN);
    const wrapper = mount(GroupRunDetailHeader, {
      props: { run: RUN, variant: "popover" },
      global: { plugins: [i18n] },
    });
    expect(wrapper.find('[data-test="group-pause-run-button"]').exists()).toBe(false);
  });

  it("offers Send and Stop side by side while the Run is paused", async () => {
    const groups = seedGroupSelection(RUN);
    const wrapper = mount(GroupComposer, {
      props: { bots: BOTS },
      global: { plugins: [i18n] },
    });
    await flushPromises();
    expect(groups.isRunActive).toBe(true);
    await wrapper.find('[data-test="group-composer-textarea"]').setValue("next step");
    await wrapper.vm.$nextTick();
    // A paused Run still owns the Topic, but the backend queues a prompt
    // behind it, so Send and Stop coexist — exactly like a running Run.
    expect(wrapper.find('[data-test="group-send-prompt-button"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="group-stop-run-button"]').exists()).toBe(true);
  });
});
