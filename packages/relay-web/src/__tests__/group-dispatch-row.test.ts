import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type {
  BotSummaryDto,
  ConversationMessageDto,
  MemberTurnSummaryDto,
} from "@ganglion/xacpx-relay-protocol";
import GroupDispatchRow from "../components/GroupDispatchRow.vue";
import GroupTranscript from "../components/GroupTranscript.vue";
import { i18n } from "../i18n";
import {
  GROUP_DISPATCH_AVATAR_LIMIT,
  presentGroupDispatch,
  type GroupDispatchEntry,
} from "../lib/group-dispatch-presentation";
import { useGroupsStore } from "../stores/groups";
import { useInstancesStore } from "../stores/instances";

const BOTS: BotSummaryDto[] = [
  { id: "bot_lead", name: "Leader", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_b", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_c", name: "Builder", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_d", name: "Auditor", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_e", name: "Planner", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
];

function turn(botId: string, state: MemberTurnSummaryDto["state"]): MemberTurnSummaryDto {
  return {
    id: `turn_${botId}`,
    runId: "run_1",
    conversationId: "conversation_g",
    topicId: "topic_1",
    botId,
    batch: 1,
    attempt: 1,
    origin: "handoff",
    state,
    createdAt: "now",
  };
}

function entry(botId: string, state: MemberTurnSummaryDto["state"]): GroupDispatchEntry {
  return {
    handoff: {
      senderMemberTurnId: "turn_leader",
      to: botId,
      assignmentId: `assignment_${botId}`,
      memberTurnId: `turn_${botId}`,
      task: `Review ${botId}`,
    },
    memberTurn: turn(botId, state),
  };
}

function row(states: MemberTurnSummaryDto["state"][], botIds = ["bot_a", "bot_b", "bot_c", "bot_d", "bot_e"]) {
  return mount(GroupDispatchRow, {
    props: {
      presentation: presentGroupDispatch({
        leader: { botId: "bot_lead", memberTurnId: "turn_leader", state: "running" },
        dispatches: states.map((state, index) => entry(botIds[index]!, state)),
        bots: BOTS,
        drivers: {},
        supportsCancelMember: false,
      }),
    },
    global: { plugins: [i18n] },
  });
}

describe("GroupDispatchRow", () => {
  beforeEach(() => {
    i18n.global.locale.value = "en";
  });

  it("reports running members with a spinner and no expand behaviour", async () => {
    const wrapper = row(["running", "running", "queued", "queued"]);
    expect(wrapper.get('[data-test="group-dispatch-title"]').text()).toBe("Sent to 4 bots");
    expect(wrapper.get('[data-test="group-dispatch-status-active"]').text()).toBe("2 running · 2 queued");
    expect(wrapper.find('[data-test="group-dispatch-overflow"]').exists()).toBe(false);
    await wrapper.trigger("click");
    expect(wrapper.find('[data-test="group-handoff-details"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("reports all completed with a green check", () => {
    const wrapper = row(["completed", "completed", "completed", "completed"]);
    expect(wrapper.get('[data-test="group-dispatch-status-done"]').text()).toContain("4 done");
    expect(wrapper.get('[data-test="group-dispatch-status-done"]').classes()).toContain("text-success");
    wrapper.unmount();
  });

  it("reports all cancelled in muted tone", () => {
    const wrapper = row(["cancelled", "cancelled"]);
    expect(wrapper.get('[data-test="group-dispatch-status-cancelled"]').text()).toContain("Cancelled");
    wrapper.unmount();
  });

  it("reports mixed completed and cancelled outcomes", () => {
    const wrapper = row(["completed", "completed", "cancelled", "cancelled"]);
    const status = wrapper.get('[data-test="group-dispatch-status"]').text();
    expect(status).toContain("✓ 2 done");
    expect(status).toContain("2 Cancelled");
    expect(wrapper.find('[data-test="group-dispatch-status-active"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("appends the failure count in danger colour", () => {
    const wrapper = row(["completed", "completed", "failed"]);
    const status = wrapper.get('[data-test="group-dispatch-status"]').text();
    expect(status).toContain("✓ 2 done");
    expect(status).toContain("1 failed");
    expect(wrapper.get('[data-test="group-dispatch-status-failed"]').classes()).toContain("text-danger");
    wrapper.unmount();
  });

  it("collapses avatars past the limit into an overflow count", () => {
    const wrapper = row(
      ["completed", "completed", "completed", "completed", "completed"],
      ["bot_a", "bot_b", "bot_c", "bot_d", "bot_e"],
    );
    expect(wrapper.get('[data-test="group-dispatch-overflow"]').text()).toBe("+1");
    expect(wrapper.get('[data-test="group-dispatch-title"]').text()).toBe("Sent to 5 bots");
    expect(GROUP_DISPATCH_AVATAR_LIMIT).toBe(4);
    wrapper.unmount();
  });

  it("omits the overflow counter when every avatar fits", () => {
    const wrapper = row(["completed", "completed"]);
    expect(wrapper.find('[data-test="group-dispatch-overflow"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it.each([
    ["en", "Sent to 2 bots", "2 queued", "Stopped"],
    ["zh-CN", "派发给 2 个 Bot", "2 等待中", "已停止"],
  ] as const)("localizes title, status and stopped note in %s", (locale, title, status, stopped) => {
    i18n.global.locale.value = locale;
    const wrapper = mount(GroupDispatchRow, {
      props: {
        presentation: {
          ...presentGroupDispatch({
            leader: { botId: "bot_lead", memberTurnId: "turn_leader", state: "running" },
            dispatches: [entry("bot_a", "queued"), entry("bot_b", "queued")],
            bots: BOTS,
            drivers: {},
            supportsCancelMember: false,
          }),
          leaderStopped: true,
        },
      },
      global: { plugins: [i18n] },
    });
    expect(wrapper.get('[data-test="group-dispatch-title"]').text()).toBe(title);
    expect(wrapper.get('[data-test="group-dispatch-status-active"]').text()).toBe(status);
    // The stopped note itself lives in GroupTranscript below the leader bubble;
    // the row only carries the flag — the locale key must still resolve here.
    expect(i18n.global.t("group.dispatch.stopped")).toBe(stopped);
    wrapper.unmount();
  });
});

function handoffMessage(index: number, over: Partial<ConversationMessageDto> = {}): ConversationMessageDto {
  return {
    id: `handoff_${index}`,
    conversationId: "group_1",
    topicId: "topic_1",
    runId: "run_1",
    seq: index * 2,
    role: "system",
    senderBotId: "bot_a",
    content: "Public handoff",
    createdAt: "now",
    handoff: {
      senderMemberTurnId: "turn_a",
      to: index === 1 ? "bot_b" : "bot_c",
      assignmentId: `assignment_${index}`,
      memberTurnId: `turn_member_${index}`,
      task: `Review assignment ${index}`,
    },
    ...over,
  };
}

function memberTurn(id: string, botId: string, state: MemberTurnSummaryDto["state"]): MemberTurnSummaryDto {
  return {
    id,
    conversationId: "group_1",
    topicId: "topic_1",
    runId: "run_1",
    botId,
    batch: 1,
    attempt: 1,
    origin: id === "turn_a" ? "human-explicit" : "handoff",
    state,
    createdAt: "now",
  };
}

function seedTranscript(messages: ConversationMessageDto[], turns: MemberTurnSummaryDto[]) {
  setActivePinia(createPinia());
  const instances = useInstancesStore();
  instances.instances = [
    {
      id: "instance_1",
      name: "Local",
      online: true,
      lastSeenAt: null,
      sessions: [],
      agents: [{ name: "codex", driver: "codex" }],
      workspaces: [{ name: "repo", cwd: "/repo" }],
      agentCatalog: [],
    } as never,
  ];
  vi.spyOn(instances, "loadRouterAvailability").mockResolvedValue(undefined);
  vi.spyOn(instances, "loadJevSettings").mockResolvedValue(undefined);
  const groups = useGroupsStore();
  groups.instanceId = "instance_1";
  groups.selectedGroupId = groups.activeConversationId = "group_1";
  groups.activeTopicId = "topic_1";
  groups.topicReady = true;
  groups.messages = messages;
  groups.memberTurnsById = Object.fromEntries(turns.map((turn) => [turn.id, turn]));
  groups.activeRun = {
    id: "run_1",
    conversationId: "group_1",
    topicId: "topic_1",
    requestMessageId: "request_message",
    requestId: "request",
    mode: "explicit",
    state: "running",
    profileRevision: 1,
    createdAt: "now",
  };
  return groups;
}

const profiles: BotSummaryDto[] = [
  { id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_b", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_c", name: "Builder", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
];

describe("GroupTranscript dispatch aggregation", () => {
  beforeEach(() => {
    i18n.global.locale.value = "en";
  });

  it("aggregates same-round handoffs into one row below the leader message", async () => {
    seedTranscript(
      [
        {
          id: "msg_1",
          conversationId: "group_1",
          topicId: "topic_1",
          runId: "run_1",
          seq: 1,
          role: "bot",
          senderBotId: "bot_a",
          promptRequestId: "prompt_leader",
          content: "Dispatching two reviews",
          createdAt: "now",
        },
        handoffMessage(1),
        handoffMessage(2),
      ],
      [
        { ...memberTurn("turn_a", "bot_a", "running"), promptRequestId: "prompt_leader" },
        memberTurn("turn_member_1", "bot_b", "running"),
        memberTurn("turn_member_2", "bot_c", "queued"),
      ],
    );
    const wrapper = mount(GroupTranscript, { props: { bots: profiles }, global: { plugins: [i18n] } });
    await flushPromises();
    const rows = wrapper.findAll('[data-test="group-dispatch-row"]');
    expect(rows).toHaveLength(1);
    expect(wrapper.findAll('[data-test="group-handoff"]').filter((entry) => entry.isVisible())).toHaveLength(0);
    const rowText = rows[0]!.text();
    expect(rowText).toContain("Sent to 2 bots");
    expect(rowText).toContain("1 running");
    expect(rowText).toContain("1 queued");
    // The row anchors below the leader's own bubble, not in handoff position:
    // the leader row's bubble template owns the dispatch row as its tail.
    const leaderRow = wrapper.get('[data-message-id="msg_1"]');
    expect(leaderRow.element.parentElement?.textContent ?? "").toContain("Sent to 2 bots");
    expect(wrapper.find('[data-message-id="handoff_2"]')?.exists() ?? false).toBe(false);
    wrapper.unmount();
  });

  it("keeps a lone handoff as its own expandable entry", async () => {
    seedTranscript([handoffMessage(1)], [memberTurn("turn_a", "bot_a", "completed")]);
    const wrapper = mount(GroupTranscript, { props: { bots: profiles }, global: { plugins: [i18n] } });
    await flushPromises();
    expect(wrapper.findAll('[data-test="group-dispatch-row"]')).toHaveLength(0);
    expect(wrapper.findAll('[data-test="group-handoff"]')).toHaveLength(1);
    expect(wrapper.find('[data-test="group-handoff-toggle"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("replaces the anchor handoff entry with the row when no leader message is loaded", async () => {
    seedTranscript([handoffMessage(1), handoffMessage(2)], [memberTurn("turn_a", "bot_a", "completed")]);
    const wrapper = mount(GroupTranscript, { props: { bots: profiles }, global: { plugins: [i18n] } });
    await flushPromises();
    expect(wrapper.findAll('[data-test="group-dispatch-row"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-test="group-handoff"]')).toHaveLength(0);
    wrapper.unmount();
  });

  it("marks the leader message stopped when the leader turn was cancelled", async () => {
    seedTranscript([handoffMessage(1), handoffMessage(2)], [memberTurn("turn_a", "bot_a", "cancelled")]);
    const wrapper = mount(GroupTranscript, { props: { bots: profiles }, global: { plugins: [i18n] } });
    await flushPromises();
    expect(wrapper.findAll('[data-test="group-dispatch-row"]')).toHaveLength(1);
    expect(wrapper.get('[data-test="group-dispatch-stopped"]').text()).toBe("Stopped");
    wrapper.unmount();
  });
});
