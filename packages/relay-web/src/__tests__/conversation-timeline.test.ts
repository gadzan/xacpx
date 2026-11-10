import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type {
  ConversationMessageDto,
  ConversationRoundSummaryDto,
  ConversationRunDto,
  ConversationTimelineDto,
  ConversationTimelineEntryDto,
  MemberTurnSummaryDto,
} from "@ganglion/xacpx-relay-protocol";
import { i18n } from "../i18n";
import ConversationTimeline from "../components/ConversationTimeline.vue";
import ConversationStatusBar from "../components/ConversationStatusBar.vue";
import type { RoomView, TimelineLiveTurn } from "../lib/room-view";

const NOW = "2026-11-07T00:00:00.000Z";
const CONVERSATION = "conversation_1";
const TOPIC = "topic_1";

const DIRECT_ROOM: RoomView = {
  conversationId: CONVERSATION,
  topicId: TOPIC,
  participants: [{ botId: "bot_a", name: "Ada", role: "Lead", enabled: true }],
};

const GROUP_ROOM: RoomView = {
  conversationId: CONVERSATION,
  topicId: TOPIC,
  participants: [
    { botId: "bot_a", name: "Ada", role: "Lead", enabled: true },
    { botId: "bot_b", name: "Bob", role: "Reviewer", enabled: true },
    { botId: "bot_c", name: "Cara", role: "Tester", enabled: true },
  ],
};

function message(seq: number, patch: Partial<ConversationMessageDto> = {}): ConversationMessageDto {
  return {
    id: `m${seq}`,
    conversationId: CONVERSATION,
    topicId: TOPIC,
    seq,
    role: "bot",
    senderBotId: "bot_a",
    content: `message ${seq}`,
    createdAt: NOW,
    ...patch,
  };
}

function messageEntry(seq: number, patch: Partial<ConversationMessageDto> = {}, ownership: "exact" | "inferred" | "unresolved" = "exact"): ConversationTimelineEntryDto {
  const row = message(seq, patch);
  return {
    kind: "message",
    key: `message:${row.id}`,
    anchorSeq: seq,
    message: row,
    ...(row.memberTurnId ? { memberTurnId: row.memberTurnId } : {}),
    ...(row.runId ? { runId: row.runId } : {}),
    ...(ownership === "exact" ? {} : { ownership }),
  };
}

function activityEntry(id: string, anchorSeq: number, patch: Partial<MemberTurnSummaryDto> = {}): ConversationTimelineEntryDto {
  return {
    kind: "activity",
    key: `activity:${id}`,
    anchorSeq,
    runId: "run_1",
    memberTurn: {
      id,
      runId: "run_1",
      conversationId: CONVERSATION,
      topicId: TOPIC,
      botId: "bot_b",
      batch: 1,
      memberIndex: 0,
      attempt: 1,
      origin: "human-explicit",
      state: "running",
      createdAt: NOW,
      ...patch,
    },
  };
}

function timeline(entries: ConversationTimelineEntryDto[], patch: Partial<ConversationTimelineDto> = {}): ConversationTimelineDto {
  return {
    conversationId: CONVERSATION,
    topicId: TOPIC,
    entries,
    hasMoreBefore: false,
    hasMoreAfter: false,
    ...patch,
  };
}

function run(patch: Partial<ConversationRunDto> = {}): ConversationRunDto {
  return {
    id: "run_1",
    conversationId: CONVERSATION,
    topicId: TOPIC,
    requestMessageId: "m1",
    requestId: "req_1",
    mode: "explicit",
    state: "running",
    profileRevision: 1,
    createdAt: NOW,
    ...patch,
  } as ConversationRunDto;
}

function member(id: string, patch: Partial<MemberTurnSummaryDto> = {}): MemberTurnSummaryDto {
  return {
    id,
    runId: "run_1",
    conversationId: CONVERSATION,
    topicId: TOPIC,
    botId: "bot_b",
    batch: 1,
    memberIndex: 0,
    attempt: 1,
    origin: "human-explicit",
    state: "running",
    createdAt: NOW,
    ...patch,
  };
}

function mountTimeline(input: {
  room?: RoomView;
  data: ConversationTimelineDto;
  liveOverlay?: TimelineLiveTurn[];
}) {
  return mount(ConversationTimeline, {
    props: {
      room: input.room ?? GROUP_ROOM,
      timeline: input.data,
      ...(input.liveOverlay ? { liveOverlay: input.liveOverlay } : {}),
    },
    global: { plugins: [i18n] },
  });
}

describe("ConversationTimeline.vue", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("renders Direct and Group through the same component", () => {
    const data = timeline([
      messageEntry(1, { role: "human", senderBotId: undefined, content: "hello" }),
      messageEntry(2, { content: "on it" }),
    ]);
    const direct = mountTimeline({ room: DIRECT_ROOM, data });
    const group = mountTimeline({ room: GROUP_ROOM, data });
    for (const wrapper of [direct, group]) {
      expect(wrapper.find('[data-test="conversation-timeline-scroller"]').exists()).toBe(true);
      expect(wrapper.findAll('[data-test="timeline-bot-message"]')).toHaveLength(1);
      expect(wrapper.text()).toContain("Ada");
      wrapper.unmount();
    }
  });

  it("renders one entry per message, never a duplicate", () => {
    const data = timeline([
      messageEntry(1, { role: "human", senderBotId: undefined, content: "hi" }),
      messageEntry(2, { content: "one" }),
      messageEntry(3, { content: "two" }),
    ]);
    const wrapper = mountTimeline({ data });
    expect(wrapper.findAll("[data-row-key]")).toHaveLength(3);
    expect(wrapper.findAll('[data-test="timeline-bot-message"]')).toHaveLength(2);
    wrapper.unmount();
  });

  it("renders a handoff as one line under its sender, not a card", () => {
    const data = timeline([
      messageEntry(1, { content: "splitting the work" }),
      messageEntry(2, {
        role: "system",
        senderBotId: "bot_a",
        content: "",
        memberTurnId: undefined,
        runId: "run_1",
        handoff: {
          senderMemberTurnId: "turn_a",
          to: "bot_b",
          assignmentId: "assignment_1",
          memberTurnId: "turn_b",
          task: "check the lock",
        },
      }),
    ]);
    const wrapper = mountTimeline({ data });
    const handoff = wrapper.find('[data-test="timeline-handoff"]');
    expect(handoff.exists()).toBe(true);
    expect(handoff.text()).toContain("Ada");
    expect(handoff.text()).toContain("Bob");
    expect(handoff.text()).toContain("check the lock");
    // The handoff never becomes a second bubble.
    expect(wrapper.findAll('[data-test="timeline-bot-message"]')).toHaveLength(1);
    wrapper.unmount();
  });

  it("suppresses the empty settlement evidence bubble but keeps the activity row", () => {
    const data = timeline([
      activityEntry("turn_silent", 1, { state: "cancelled", botId: "bot_b" }),
      messageEntry(2, { content: "   ", memberTurnId: "turn_silent", senderBotId: "bot_b", runId: "run_1" }),
    ]);
    const wrapper = mountTimeline({ data });
    expect(wrapper.findAll('[data-test="timeline-bot-message"]')).toHaveLength(0);
    expect(wrapper.find('[data-test="timeline-activity"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("shows a live bubble for the current speaker and drops it when durable speech lands", async () => {
    const live: TimelineLiveTurn = {
      memberTurnId: "turn_live",
      botId: "bot_b",
      text: "here is a TOCTOU",
      status: "streaming",
      revision: 1,
    };
    const wrapper = mountTimeline({
      data: timeline([activityEntry("turn_live", 1)]),
      liveOverlay: [live],
    });
    expect(wrapper.find('[data-test="timeline-live-bubble"]').text()).toContain("here is a TOCTOU");

    // The durable message claims the same MemberTurn: the overlay disappears
    // and the speech is drawn exactly once.
    await wrapper.setProps({
      timeline: timeline([
        activityEntry("turn_live", 1),
        messageEntry(2, {
          content: "here is a TOCTOU",
          memberTurnId: "turn_live",
          senderBotId: "bot_b",
          runId: "run_1",
        }),
      ]),
    });
    expect(wrapper.find('[data-test="timeline-live-bubble"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="timeline-activity"]').exists()).toBe(false);
    const bubbles = wrapper.findAll('[data-test="timeline-bot-message"]');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]!.text()).toContain("here is a TOCTOU");
    wrapper.unmount();
  });

  it("renders queued, all-pass and failed notices as light lines", () => {
    const data = timeline([
      { kind: "notice", key: "notice:run_1:queued", anchorSeq: 1, tone: "queued", runId: "run_1", text: "Queued" },
      { kind: "notice", key: "notice:run_1:empty", anchorSeq: 2, tone: "empty", runId: "run_1", text: "No member added" },
      { kind: "notice", key: "notice:run_1:failed", anchorSeq: 3, tone: "failed", runId: "run_1", text: "Run failed: boom" },
    ]);
    const wrapper = mountTimeline({ data });
    const notices = wrapper.findAll('[data-test="timeline-notice"]');
    expect(notices).toHaveLength(3);
    expect(notices[0]!.attributes("data-tone")).toBe("queued");
    expect(notices[1]!.text()).toContain("No member added to this discussion.");
    expect(notices[2]!.text()).toContain("Run failed");
    wrapper.unmount();
  });

  it("labels an unresolved owner without dropping the row", () => {
    const data = timeline([
      messageEntry(1, { content: "provenance unknown", runId: "run_1" }, "unresolved"),
    ]);
    const wrapper = mountTimeline({ data });
    expect(wrapper.find('[data-test="timeline-bot-message"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="timeline-unresolved"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("opens the detail drawer from the bot meta and from a handoff", async () => {
    const data = timeline([
      messageEntry(1, { content: "lead spoke", memberTurnId: "turn_a", runId: "run_1" }),
      messageEntry(2, {
        role: "system",
        senderBotId: "bot_a",
        content: "",
        runId: "run_1",
        handoff: {
          senderMemberTurnId: "turn_a",
          to: "bot_b",
          assignmentId: "assignment_1",
          memberTurnId: "turn_b",
          task: "check the lock",
        },
      }),
    ]);
    const wrapper = mountTimeline({ data });
    await wrapper.find('[data-test="timeline-open-detail"]').trigger("click");
    expect(wrapper.emitted("openDetail")?.[0]).toEqual([{ runId: "run_1", memberTurnId: "turn_a" }]);
    await wrapper.find('[data-test="timeline-handoff"]').trigger("click");
    expect(wrapper.emitted("openDetail")?.[1]).toEqual([{ runId: "run_1", memberTurnId: "turn_b" }]);
    wrapper.unmount();
  });

  it("shows the load-older control only when the page has earlier history", async () => {
    const wrapper = mountTimeline({ data: timeline([messageEntry(5, { content: "latest" })]) });
    expect(wrapper.find('[data-test="timeline-load-older"]').exists()).toBe(false);
    await wrapper.setProps({ timeline: timeline([messageEntry(5, { content: "latest" })], { hasMoreBefore: true }) });
    expect(wrapper.find('[data-test="timeline-load-older"]').exists()).toBe(true);
    wrapper.unmount();
  });
});

describe("ConversationStatusBar.vue", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  function round(patch: Partial<ConversationRoundSummaryDto> = {}): ConversationRoundSummaryDto {
    return {
      runId: "run_1",
      roundIndex: 1,
      rounds: 1,
      speakerCount: 3,
      spoken: 1,
      passed: 1,
      activeMemberTurnId: "turn_b",
      state: "running",
      ...patch,
    };
  }

  it("shows Stop all and the live round summary for a multi-speaker Run", async () => {
    const wrapper = mount(ConversationStatusBar, {
      props: {
        room: GROUP_ROOM,
        run: run(),
        memberTurns: [member("turn_a", { state: "completed" }), member("turn_b"), member("turn_c", { state: "completed", speechOutcome: "pass" })],
        round: round(),
        activeSpeakerName: "Bob",
      },
      global: { plugins: [i18n] },
    });
    expect(wrapper.find('[data-test="conversation-status-bar"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="round-strip"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="round-strip-spoken"]').text()).toContain("1/3 spoken");
    expect(wrapper.find('[data-test="round-strip-passed"]').text()).toContain("1 passed");
    expect(wrapper.find('[data-test="round-strip-speaker"]').text()).toContain("Bob");
    await wrapper.find('[data-test="conversation-stop-all"]').trigger("click");
    expect(wrapper.emitted("stopAll")).toHaveLength(1);
    wrapper.unmount();
  });

  it("hides the RoundStrip for a single-speaker Run", () => {
    const wrapper = mount(ConversationStatusBar, {
      props: {
        room: DIRECT_ROOM,
        run: run({ shape: "single" } as Partial<ConversationRunDto>),
        memberTurns: [member("turn_a", { botId: "bot_a" })],
        round: round({ speakerCount: 1, spoken: 0, passed: 0 }),
      },
      global: { plugins: [i18n] },
    });
    expect(wrapper.find('[data-test="conversation-status-bar"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="round-strip"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("renders nothing when no Run is active and no round exists", () => {
    const wrapper = mount(ConversationStatusBar, {
      props: { room: DIRECT_ROOM, run: null },
      global: { plugins: [i18n] },
    });
    expect(wrapper.find('[data-test="conversation-status-bar"]').exists()).toBe(false);
    wrapper.unmount();
  });
});

describe("ConversationTimeline fork banner", () => {
  const fork = {
    requestId: "fork-1",
    sourceConversationId: CONVERSATION,
    sourceTopicId: "topic_source",
    sourceTitle: "Original",
    throughSeq: 2,
    rootTopicId: "topic_source",
    copiedMessages: 12,
    omittedMessages: 3,
    createdAt: NOW,
  };

  function mountForked(input: { sourceAvailable?: boolean; forkedFrom?: typeof fork } = {}) {
    return mount(ConversationTimeline, {
      props: {
        room: GROUP_ROOM,
        timeline: timeline([messageEntry(1)]),
        forkedFrom: input.forkedFrom ?? { ...fork, omittedMessages: 0 },
        forkSourceAvailable: input.sourceAvailable ?? true,
      },
      global: { plugins: [i18n] },
    });
  }

  it("renders the banner outside the scroller and adds no timeline row", () => {
    const wrapper = mountForked();
    const banner = wrapper.find('[data-test="topic-fork-banner"]');
    expect(banner.exists()).toBe(true);
    expect(banner.text()).toContain("Original");
    expect(wrapper.find('[data-test="topic-fork-banner-count"]').text()).toContain("12");
    expect(wrapper.find('[data-test="topic-fork-banner-omitted"]').exists()).toBe(false);
    const scroller = wrapper.find('[data-test="conversation-timeline-scroller"]');
    expect(scroller.element.contains(banner.element)).toBe(false);
    expect(wrapper.findAll("[data-row-key]")).toHaveLength(1);
    wrapper.unmount();
  });

  it("shows omitted history and only links a surviving source", async () => {
    const wrapper = mountForked({ forkedFrom: fork });
    expect(wrapper.find('[data-test="topic-fork-banner-omitted"]').text()).toContain("3");
    await wrapper.find('[data-test="topic-fork-banner-source"]').trigger("click");
    expect(wrapper.emitted("openSourceTopic")).toHaveLength(1);
    wrapper.unmount();

    const gone = mountForked({ sourceAvailable: false });
    expect(gone.find('[data-test="topic-fork-banner-source"]').exists()).toBe(false);
    gone.unmount();
  });
});
