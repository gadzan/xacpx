import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import type {
  BotSummaryDto,
  ConversationMessageDto,
  GroupSummaryDto,
  MemberTurnSummaryDto,
} from "@ganglion/xacpx-relay-protocol";
import { i18n } from "../i18n";
import { useConnectionStore } from "../stores/connection";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useGroupsStore } from "../stores/groups";
import { useInstancesStore } from "../stores/instances";
import GroupTranscript from "../components/GroupTranscript.vue";

// The group transcript's polite live region speaks one sentence when a
// dispatch round ends while the user watches, and stays silent otherwise.

const BOTS: BotSummaryDto[] = [
  { id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_b", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_c", name: "Writer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_d", name: "Checker", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_e", name: "Linter", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
];
const MEMBERS = ["bot_b", "bot_c", "bot_d", "bot_e"] as const;

const GROUP: GroupSummaryDto = {
  id: "conversation_g",
  kind: "group",
  title: "Release Team",
  botIds: BOTS.map((bot) => bot.id),
  leadBotId: "bot_a",
  createdAt: "now",
  updatedAt: "now",
};

type TurnState = MemberTurnSummaryDto["state"];

function seed() {
  useInstancesStore().instances = [
    {
      id: "i1", name: "Local", online: true, lastSeenAt: null, sessions: [],
      agents: [{ name: "codex", driver: "codex" }], workspaces: [{ name: "repo", cwd: "/repo" }], agentCatalog: [],
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
    { id: "topic_2", conversationId: "conversation_g", title: "Next", status: "active", createdAt: "now", updatedAt: "now" },
  ];
  useDirectBotsStore().botsByInstance["i1"] = BOTS;
  return groups;
}

/** A round: the leader's handoffs to `n` members, all inside run `runId`. */
function round(runId: string, n: number, opts: { topicId?: string; seq?: number } = {}): ConversationMessageDto[] {
  const topicId = opts.topicId ?? "topic_1";
  const seq = opts.seq ?? 10;
  return MEMBERS.slice(0, n).map((to, index) => ({
    id: `${runId}_handoff_${index}`, conversationId: "conversation_g", topicId, seq: seq + index,
    role: "system" as const, senderBotId: "bot_a", runId, createdAt: "now",
    content: `Public handoff: Reviewer → ${to}`,
    handoff: {
      senderMemberTurnId: `${runId}_lead`, to, assignmentId: `${runId}_assign_${index}`,
      memberTurnId: `${runId}_m${index}`, task: "Review patch", expectedOutput: "Findings",
    },
  }));
}

/** Turns for `round(runId, states.length)`: the leader plus one per member. */
function turns(
  runId: string,
  states: TurnState[],
  leader: { state?: TurnState; cancellationReason?: string } = {},
  topicId = "topic_1",
): MemberTurnSummaryDto[] {
  const base = { runId, conversationId: "conversation_g", topicId, batch: 1, attempt: 1, createdAt: "now" };
  return [
    {
      ...base, id: `${runId}_lead`, botId: "bot_a", memberIndex: 0, origin: "human-explicit",
      state: leader.state ?? "completed",
      ...(leader.cancellationReason ? { cancellationReason: leader.cancellationReason } : {}),
    } as MemberTurnSummaryDto,
    ...states.map((state, index) => ({
      ...base, id: `${runId}_m${index}`, botId: MEMBERS[index]!, memberIndex: index + 1,
      origin: "handoff", assignmentId: `${runId}_assign_${index}`, state,
    }) as MemberTurnSummaryDto),
  ];
}

function setLiveRun(runId: string, state: "running" | "completed" = "running", topicId = "topic_1"): void {
  useGroupsStore().activeRun = {
    id: runId, conversationId: "conversation_g", topicId,
    requestMessageId: "msg_1", requestId: "req_1", mode: "explicit", state,
    profileRevision: 1, createdAt: "now",
  } as never;
}

function setLiveTurns(list: MemberTurnSummaryDto[]): void {
  useGroupsStore().memberTurnsById = Object.fromEntries(list.map((turn) => [turn.id, turn]));
}

/** Land a finished run the way a history read does. */
function setHistoryRun(runId: string, list: MemberTurnSummaryDto[], topicId = "topic_1"): void {
  const groups = useGroupsStore();
  groups.runHistoryDetails = {
    ...groups.runHistoryDetails,
    [`i1:conversation_g:${topicId}:${runId}`]: {
      id: runId, conversationId: "conversation_g", topicId,
      requestMessageId: "msg_0", requestId: "req_0", mode: "explicit", state: "completed",
      profileRevision: 1, createdAt: "now", memberTurns: list,
    } as never,
  };
  groups.runHistoryDetailRevision++;
}

function mountTranscript(): VueWrapper {
  return mount(GroupTranscript, { props: { bots: BOTS }, global: { plugins: [i18n] } });
}

function region(wrapper: VueWrapper) {
  return wrapper.get('[data-test="group-dispatch-announcer"]');
}

/** Every non-empty text the region was given after this call. */
function recordAnnouncements(wrapper: VueWrapper): string[] {
  const spoken: string[] = [];
  const element = region(wrapper).element;
  new MutationObserver(() => {
    const text = element.textContent ?? "";
    if (text !== "") spoken.push(text);
  }).observe(element, { childList: true, characterData: true, subtree: true });
  return spoken;
}

async function settle(): Promise<void> {
  await flushPromises();
  await nextTick();
  await flushPromises();
}

describe("GroupTranscript dispatch-end announcer", () => {
  let previousLocale: string;
  beforeEach(() => {
    setActivePinia(createPinia());
    previousLocale = i18n.global.locale.value;
    i18n.global.locale.value = "zh-CN";
    const connection = useConnectionStore();
    connection.online = true;
    connection.everOpened = true;
    vi.spyOn(useInstancesStore(), "loadRouterAvailability").mockResolvedValue(undefined);
    vi.spyOn(useInstancesStore(), "loadJevSettings").mockResolvedValue(undefined);
    vi.spyOn(useGroupsStore(), "ensureRunDetails").mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    i18n.global.locale.value = previousLocale as never;
    vi.restoreAllMocks();
  });

  it("mounts a polite live region that starts empty", async () => {
    seed();
    const wrapper = mountTranscript();
    const live = region(wrapper);
    expect(live.attributes("aria-live")).toBe("polite");
    expect(live.attributes("role")).toBe("status");
    expect(live.text()).toBe("");
    await settle();
    expect(region(wrapper).text()).toBe("");
    wrapper.unmount();
  });

  it("stays silent while members progress and announces the round end once", async () => {
    const groups = seed();
    groups.messages = round("run_1", 2);
    setLiveRun("run_1");
    setLiveTurns(turns("run_1", ["queued", "queued"], { state: "running" }));
    const wrapper = mountTranscript();
    await settle();
    const spoken = recordAnnouncements(wrapper);
    setLiveTurns(turns("run_1", ["running", "queued"], { state: "completed" }));
    await settle();
    setLiveTurns(turns("run_1", ["completed", "running"]));
    await settle();
    expect(region(wrapper).text()).toBe("");
    setLiveTurns(turns("run_1", ["completed", "completed"]));
    await settle();
    expect(region(wrapper).text()).toBe("派发已结束：2 个已完成");
    expect(spoken).toEqual(["派发已结束：2 个已完成"]);
    wrapper.unmount();
  });

  it("appends the non-zero cancelled, failed and unknown counts in row order", async () => {
    const groups = seed();
    groups.messages = round("run_1", 4);
    setLiveRun("run_1");
    setLiveTurns(turns("run_1", ["running", "running", "running", "running"]));
    const wrapper = mountTranscript();
    await settle();
    setLiveTurns(turns("run_1", ["indeterminate", "failed", "cancelled", "completed"]));
    await settle();
    expect(region(wrapper).text()).toBe("派发已结束：1 个已完成，1 个已取消，1 个失败，1 个结果未知");
    wrapper.unmount();
  });

  it("leaves zero counts out of the sentence", async () => {
    const groups = seed();
    groups.messages = round("run_1", 3);
    setLiveRun("run_1");
    setLiveTurns(turns("run_1", ["running", "running", "running"]));
    const wrapper = mountTranscript();
    await settle();
    setLiveTurns(turns("run_1", ["completed", "completed", "cancelled"]));
    await settle();
    expect(region(wrapper).text()).toBe("派发已结束：2 个已完成，1 个已取消");
    wrapper.unmount();
  });

  it("announces a stopped leader by name, then never the same round again", async () => {
    const groups = seed();
    groups.messages = round("run_1", 1);
    setLiveRun("run_1");
    setLiveTurns(turns("run_1", ["running"], { state: "running" }));
    const wrapper = mountTranscript();
    await settle();
    const spoken = recordAnnouncements(wrapper);
    setLiveTurns(turns("run_1", ["running"], { state: "cancelled", cancellationReason: "human-cancelled" }));
    await settle();
    expect(region(wrapper).text()).toBe("Reviewer 已停止");
    // The members settle afterwards: the round already spoke.
    setLiveTurns(turns("run_1", ["completed"], { state: "cancelled", cancellationReason: "human-cancelled" }));
    await settle();
    expect(spoken).toEqual(["Reviewer 已停止"]);
    wrapper.unmount();
  });

  it("speaks English with the English strings", async () => {
    i18n.global.locale.value = "en";
    const groups = seed();
    groups.messages = round("run_1", 2);
    setLiveRun("run_1");
    setLiveTurns(turns("run_1", ["running", "running"]));
    const wrapper = mountTranscript();
    await settle();
    setLiveTurns(turns("run_1", ["completed", "failed"]));
    await settle();
    expect(region(wrapper).text()).toBe("Dispatch finished: 1 completed, 1 failed");
    setLiveTurns(turns("run_1", ["completed", "failed"], { state: "cancelled", cancellationReason: "human-cancelled" }));
    await settle();
    expect(region(wrapper).text()).toBe("Dispatch finished: 1 completed, 1 failed");
    wrapper.unmount();
  });

  it("re-announces an identical sentence for a later round by clearing first", async () => {
    const groups = seed();
    groups.messages = round("run_1", 1);
    setLiveRun("run_1");
    setLiveTurns(turns("run_1", ["running"]));
    const wrapper = mountTranscript();
    await settle();
    setLiveTurns(turns("run_1", ["completed"]));
    await settle();
    expect(region(wrapper).text()).toBe("派发已结束：1 个已完成");
    const texts: string[] = [];
    const element = region(wrapper).element;
    new MutationObserver(() => texts.push(element.textContent ?? "")).observe(element, { childList: true, characterData: true, subtree: true });
    setHistoryRun("run_1", turns("run_1", ["completed"]));
    groups.messages = [...round("run_1", 1), ...round("run_2", 1, { seq: 20 })];
    setLiveRun("run_2");
    setLiveTurns(turns("run_2", ["running"]));
    await settle();
    setLiveTurns(turns("run_2", ["completed"]));
    await settle();
    expect(texts).toEqual(["", "派发已结束：1 个已完成"]);
    wrapper.unmount();
  });

  describe("never announces", () => {
    it("rounds that load already finished with the topic history", async () => {
      const groups = seed();
      groups.topicReady = false;
      const wrapper = mountTranscript();
      await settle();
      const spoken = recordAnnouncements(wrapper);
      groups.messages = round("run_0", 2);
      setHistoryRun("run_0", turns("run_0", ["completed", "cancelled"]));
      groups.topicReady = true;
      await settle();
      expect(wrapper.findAll('[data-test="group-dispatch-row"]').length).toBeGreaterThan(0);
      expect(spoken).toEqual([]);
      expect(region(wrapper).text()).toBe("");
      wrapper.unmount();
    });

    it("a history round whose details arrive after its placeholder rendered", async () => {
      const groups = seed();
      // No run details yet: the members render as queued placeholders.
      groups.messages = round("run_0", 2);
      const wrapper = mountTranscript();
      await settle();
      const spoken = recordAnnouncements(wrapper);
      setHistoryRun("run_0", turns("run_0", ["completed", "completed"]));
      await settle();
      expect(spoken).toEqual([]);
      wrapper.unmount();
    });

    it("a live run that is already finished when the page mounts", async () => {
      const groups = seed();
      groups.messages = round("run_1", 1);
      setLiveRun("run_1", "completed");
      setLiveTurns(turns("run_1", ["completed"]));
      const wrapper = mountTranscript();
      await settle();
      expect(region(wrapper).text()).toBe("");
      wrapper.unmount();
    });

    it("finished rounds met by switching topic, even back to a round seen running", async () => {
      const groups = seed();
      groups.messages = round("run_1", 1);
      setLiveRun("run_1");
      setLiveTurns(turns("run_1", ["running"]));
      const wrapper = mountTranscript();
      await settle();
      const spoken = recordAnnouncements(wrapper);
      // Switch to another topic that holds a finished round.
      groups.activeTopicId = "topic_2";
      groups.activeRun = null;
      groups.memberTurnsById = {};
      groups.messages = round("run_9", 1, { topicId: "topic_2" });
      setHistoryRun("run_9", turns("run_9", ["completed"], {}, "topic_2"), "topic_2");
      await settle();
      // Back to topic 1, where the round seen running has finished meanwhile.
      groups.activeTopicId = "topic_1";
      groups.messages = round("run_1", 1);
      setHistoryRun("run_1", turns("run_1", ["completed"]));
      await settle();
      expect(spoken).toEqual([]);
      expect(region(wrapper).text()).toBe("");
      wrapper.unmount();
    });

    it("finished rounds prepended by an older-page load", async () => {
      const groups = seed();
      groups.messages = round("run_1", 1, { seq: 50 });
      setLiveRun("run_1");
      setLiveTurns(turns("run_1", ["running"]));
      const wrapper = mountTranscript();
      await settle();
      const spoken = recordAnnouncements(wrapper);
      groups.loadingOlder = true;
      // The older page lands before its run details: placeholders first...
      groups.messages = [...round("run_0", 2, { seq: 1 }), ...groups.messages];
      groups.loadingOlder = false;
      await settle();
      // ...then the details settle them as finished.
      setHistoryRun("run_0", turns("run_0", ["completed", "failed"]));
      await settle();
      expect(spoken).toEqual([]);
      // The live round still speaks when it ends.
      setLiveTurns(turns("run_1", ["completed"]));
      await settle();
      expect(spoken).toEqual(["派发已结束：1 个已完成"]);
      wrapper.unmount();
    });

    it("a round that finished while the socket was down and lands with the resync", async () => {
      const groups = seed();
      groups.messages = round("run_1", 1);
      setLiveRun("run_1");
      setLiveTurns(turns("run_1", ["running"]));
      const wrapper = mountTranscript();
      await settle();
      const spoken = recordAnnouncements(wrapper);
      const connection = useConnectionStore();
      connection.online = false;
      await settle();
      // Reconnect: online first, the resync drops topicReady in the same tick
      // and replays the finished state before the topic is ready again.
      connection.online = true;
      groups.topicReady = false;
      await settle();
      setLiveTurns(turns("run_1", ["completed"]));
      await settle();
      groups.topicReady = true;
      await settle();
      expect(spoken).toEqual([]);
      expect(region(wrapper).text()).toBe("");
      // Live again: a fresh round ends while watched and is announced.
      groups.messages = [...round("run_1", 1), ...round("run_2", 1, { seq: 20 })];
      setHistoryRun("run_1", turns("run_1", ["completed"]));
      setLiveRun("run_2");
      setLiveTurns(turns("run_2", ["running"]));
      await settle();
      setLiveTurns(turns("run_2", ["completed"]));
      await settle();
      expect(spoken).toEqual(["派发已结束：1 个已完成"]);
      wrapper.unmount();
    });

    it("the same round twice, through the post-run history reload", async () => {
      const groups = seed();
      groups.messages = round("run_1", 2);
      setLiveRun("run_1");
      setLiveTurns(turns("run_1", ["running", "running"]));
      const wrapper = mountTranscript();
      await settle();
      const spoken = recordAnnouncements(wrapper);
      setLiveTurns(turns("run_1", ["completed", "completed"]));
      await settle();
      expect(spoken).toEqual(["派发已结束：2 个已完成"]);
      // The leader hands the same round one more task: the round reads in
      // progress again, then settles again — it already spoke.
      groups.messages = [...round("run_1", 3)];
      setLiveTurns(turns("run_1", ["completed", "completed", "running"]));
      await settle();
      setLiveTurns(turns("run_1", ["completed", "completed", "completed"]));
      await settle();
      expect(spoken).toEqual(["派发已结束：2 个已完成"]);
      // The run ends and the transcript reloads its history: the round
      // re-renders from placeholders to its details and must stay quiet.
      groups.activeRun = null;
      groups.memberTurnsById = {};
      groups.topicReady = false;
      groups.loadingHistory = true;
      groups.messages = [...round("run_1", 3)];
      await settle();
      setHistoryRun("run_1", turns("run_1", ["completed", "completed", "completed"]));
      groups.loadingHistory = false;
      groups.topicReady = true;
      await settle();
      expect(spoken).toEqual(["派发已结束：2 个已完成"]);
      wrapper.unmount();
    });
  });
});
