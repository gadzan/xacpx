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

function turn(botId: string, state: MemberTurnSummaryDto["state"], over: Partial<MemberTurnSummaryDto> = {}): MemberTurnSummaryDto {
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
    ...over,
  };
}

function dispatchHandoff(
  botId: string,
  task: string,
  seq: number,
): ConversationMessageDto & { handoff: NonNullable<ConversationMessageDto["handoff"]> } {
  return {
    id: `handoff_${botId}`,
    conversationId: "conversation_g",
    topicId: "topic_1",
    runId: "run_1",
    seq,
    role: "system",
    content: "Public handoff",
    createdAt: "now",
    handoff: {
      senderMemberTurnId: "turn_leader",
      to: botId,
      assignmentId: `assignment_${botId}`,
      memberTurnId: `turn_${botId}`,
      task,
    },
  };
}

function entry(
  botId: string,
  state: MemberTurnSummaryDto["state"],
  over: { task?: string; seq?: number; turn?: Partial<MemberTurnSummaryDto> } = {},
): GroupDispatchEntry {
  return {
    message: dispatchHandoff(botId, over.task ?? `Review ${botId}`, over.seq ?? 1),
    memberTurn: turn(botId, state, over.turn),
  };
}

/** A member's own reply, addressed by that member turn's prompt identity. */
function replyMessage(botId: string, promptRequestId: string, content: string, seq: number): ConversationMessageDto {
  return {
    id: `reply_${botId}`,
    conversationId: "conversation_g",
    topicId: "topic_1",
    runId: "run_1",
    seq,
    role: "bot",
    senderBotId: botId,
    promptRequestId,
    content,
    createdAt: "now",
  };
}

function row(
  states: MemberTurnSummaryDto["state"][],
  botIds = ["bot_a", "bot_b", "bot_c", "bot_d", "bot_e"],
  over: {
    dispatches?: GroupDispatchEntry[];
    messages?: ConversationMessageDto[];
    supportsCancelMember?: boolean;
  } = {},
) {
  return mount(GroupDispatchRow, {
    props: {
      presentation: presentGroupDispatch({
        leader: { botId: "bot_lead", memberTurnId: "turn_leader", state: "running" },
        dispatches: over.dispatches ?? states.map((state, index) => entry(botIds[index]!, state)),
        bots: BOTS,
        drivers: {},
        supportsCancelMember: over.supportsCancelMember ?? false,
        ...(over.messages ? { messages: over.messages } : {}),
      }),
    },
    global: { plugins: [i18n] },
  });
}

describe("GroupDispatchRow", () => {
  beforeEach(() => {
    i18n.global.locale.value = "en";
  });

  it("reports running members with a spinner", async () => {
    const wrapper = row(["running", "running", "queued", "queued"]);
    expect(wrapper.get('[data-test="group-dispatch-title"]').text()).toBe("Sent to 4 bots");
    expect(wrapper.get('[data-test="group-dispatch-status-active"]').text()).toBe("2 running · 2 queued");
    expect(wrapper.find('[data-test="group-dispatch-overflow"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("expands and collapses the card when the row is clicked", async () => {
    const wrapper = row(["completed", "completed"]);
    const trigger = wrapper.get('[data-test="group-dispatch-row"]');
    expect(wrapper.find('[data-test="group-dispatch-card"]').exists()).toBe(false);
    expect(trigger.attributes("aria-expanded")).toBe("false");

    await trigger.trigger("click");
    expect(wrapper.find('[data-test="group-dispatch-card"]').exists()).toBe(true);
    expect(trigger.attributes("aria-expanded")).toBe("true");
    expect(wrapper.get('[data-test="group-dispatch-chevron"]').classes()).toContain("rotate-180");

    await trigger.trigger("click");
    expect(wrapper.find('[data-test="group-dispatch-card"]').exists()).toBe(false);
    expect(trigger.attributes("aria-expanded")).toBe("false");
    expect(wrapper.get('[data-test="group-dispatch-chevron"]').classes()).not.toContain("rotate-180");
    wrapper.unmount();
  });

  it("opens the card from the keyboard", async () => {
    const wrapper = row(["completed", "completed"]);
    const trigger = wrapper.get('[data-test="group-dispatch-row"]');
    await trigger.trigger("keydown", { key: "Enter" });
    expect(wrapper.find('[data-test="group-dispatch-card"]').exists()).toBe(true);
    await trigger.trigger("keydown", { key: " " });
    expect(wrapper.find('[data-test="group-dispatch-card"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("names the dispatch content exactly once", async () => {
    const wrapper = row(["completed", "completed"]);
    await wrapper.get('[data-test="group-dispatch-row"]').trigger("click");
    expect(wrapper.findAll('[data-test="group-dispatch-instructions-label"]')).toHaveLength(1);
    expect(wrapper.get('[data-test="group-dispatch-instructions"]').text()).toBe("Review bot_a");
    expect(wrapper.get('[data-test="group-dispatch-instructions"]').classes()).toContain("line-clamp-2");
    wrapper.unmount();
  });

  it("shows one line per dispatched bot with its state and reply preview", async () => {
    const wrapper = row([], ["bot_a", "bot_b"], {
      dispatches: [
        entry("bot_a", "completed", { task: "Review the diff", seq: 1, turn: { promptRequestId: "prompt_a" } }),
        entry("bot_b", "running", { task: "Review the diff", seq: 2, turn: { promptRequestId: "prompt_b" } }),
      ],
      messages: [replyMessage("bot_a", "prompt_a", "Looks good", 5)],
    });
    await wrapper.get('[data-test="group-dispatch-row"]').trigger("click");

    const members = wrapper.findAll('[data-test="group-dispatch-member"]');
    expect(members).toHaveLength(2);
    expect(members[0]!.get('[data-test="group-dispatch-member-name"]').text()).toBe("Reviewer");
    expect(members[0]!.get('[data-test="group-dispatch-member-status"]').text()).toBe("Completed");
    expect(members[0]!.get('[data-test="group-dispatch-member-preview"]').text()).toBe("Looks good");
    expect(members[1]!.get('[data-test="group-dispatch-member-name"]').text()).toBe("Tester");
    expect(members[1]!.get('[data-test="group-dispatch-member-status"]').text()).toBe("Running");
    // No reply yet: no preview line at all.
    expect(members[1]!.find('[data-test="group-dispatch-member-preview"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("jumps to the reply of a member that answered", async () => {
    const wrapper = row([], ["bot_a", "bot_b"], {
      dispatches: [
        entry("bot_a", "completed", { task: "Review the diff", seq: 1, turn: { promptRequestId: "prompt_a" } }),
        entry("bot_b", "running", { task: "Review the diff", seq: 2, turn: { promptRequestId: "prompt_b" } }),
      ],
      messages: [replyMessage("bot_a", "prompt_a", "Looks good", 5)],
    });
    await wrapper.get('[data-test="group-dispatch-row"]').trigger("click");

    const members = wrapper.findAll('[data-test="group-dispatch-member"]');
    expect(members[0]!.attributes("disabled")).toBeUndefined();
    expect(members[1]!.attributes("disabled")).toBeDefined();

    await members[0]!.trigger("click");
    expect(wrapper.emitted("jump")).toEqual([["reply_bot_a"]]);
    wrapper.unmount();
  });

  it("keeps a member without a reply inert", async () => {
    const wrapper = row([], ["bot_a"], {
      dispatches: [entry("bot_a", "running", { task: "Review the diff" })],
    });
    await wrapper.get('[data-test="group-dispatch-row"]').trigger("click");

    const member = wrapper.get('[data-test="group-dispatch-member"]');
    expect(member.attributes("disabled")).toBeDefined();
    await member.trigger("click");
    expect(wrapper.emitted("jump")).toBeUndefined();
    wrapper.unmount();
  });

  it("offers a stop button only for members that can be stopped", async () => {
    const wrapper = row([], ["bot_a", "bot_b", "bot_c"], {
      dispatches: [
        entry("bot_a", "running", { task: "Review the diff", seq: 1, turn: { id: "turn_a" } }),
        entry("bot_b", "queued", { task: "Review the diff", seq: 2, turn: { id: "turn_b" } }),
        entry("bot_c", "completed", { task: "Review the diff", seq: 3, turn: { id: "turn_c" } }),
      ],
      supportsCancelMember: true,
    });
    await wrapper.get('[data-test="group-dispatch-row"]').trigger("click");

    const stops = wrapper.findAll('[data-test="group-dispatch-stop-member"]');
    expect(stops).toHaveLength(2);
    expect(stops[0]!.attributes("data-bot-id")).toBe("bot_a");
    expect(stops[1]!.attributes("data-bot-id")).toBe("bot_b");
    wrapper.unmount();
  });

  it("emits the durable run and member turn when a member is stopped", async () => {
    const wrapper = row([], ["bot_a"], {
      dispatches: [entry("bot_a", "running", { task: "Review the diff", seq: 1, turn: { id: "turn_a", runId: "run_9" } })],
      supportsCancelMember: true,
    });
    await wrapper.get('[data-test="group-dispatch-row"]').trigger("click");

    await wrapper.get('[data-test="group-dispatch-stop-member"]').trigger("click");
    expect(wrapper.emitted("stopMember")).toEqual([[{ runId: "run_9", memberTurnId: "turn_a" }]]);
    wrapper.unmount();
  });

  it("keeps the stop action out of the jump action", async () => {
    const wrapper = row([], ["bot_a", "bot_b"], {
      dispatches: [
        entry("bot_a", "running", { task: "Review the diff", seq: 1, turn: { id: "turn_a", promptRequestId: "prompt_a" } }),
        entry("bot_b", "running", { task: "Review the diff", seq: 2, turn: { id: "turn_b" } }),
      ],
      messages: [replyMessage("bot_a", "prompt_a", "Looks good", 5)],
      supportsCancelMember: true,
    });
    await wrapper.get('[data-test="group-dispatch-row"]').trigger("click");
    const trigger = wrapper.get('[data-test="group-dispatch-row"]');

    await wrapper.get('[data-test="group-dispatch-stop-member"]').trigger("click");
    expect(wrapper.emitted("jump")).toBeUndefined();
    // The card stays open: stopping a member never collapses the row.
    expect(trigger.attributes("aria-expanded")).toBe("true");
    wrapper.unmount();
  });

  it("offers no stop button when the core cannot cancel a single member", async () => {
    const wrapper = row(["running", "queued"], ["bot_a", "bot_b"], { supportsCancelMember: false });
    await wrapper.get('[data-test="group-dispatch-row"]').trigger("click");
    expect(wrapper.find('[data-test="group-dispatch-stop-member"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("offers no stop button for a member that already finished", async () => {
    const wrapper = row(["completed"], ["bot_a"], { supportsCancelMember: true });
    await wrapper.get('[data-test="group-dispatch-row"]').trigger("click");
    expect(wrapper.find('[data-test="group-dispatch-stop-member"]').exists()).toBe(false);
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
    ["en", "Sent to 2 bots", "2 queued", "Stopped", "Instructions"],
    ["zh-CN", "派发给 2 个 Bot", "2 等待中", "已停止", "派发内容"],
  ] as const)(
    "localizes title, status, stopped note and dispatch content in %s",
    (locale, title, status, stopped, instructions) => {
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
      expect(i18n.global.t("group.dispatch.instructions")).toBe(instructions);
      wrapper.unmount();
    },
  );
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

  it("jumps to a member's reply from the expanded card", async () => {
    seedTranscript(
      [
        handoffMessage(1),
        handoffMessage(2),
        {
          id: "reply_b",
          conversationId: "group_1",
          topicId: "topic_1",
          runId: "run_1",
          seq: 9,
          role: "bot",
          senderBotId: "bot_b",
          promptRequestId: "prompt_member_1",
          content: "Tester findings",
          createdAt: "now",
        },
      ],
      [
        memberTurn("turn_a", "bot_a", "completed"),
        { ...memberTurn("turn_member_1", "bot_b", "completed"), promptRequestId: "prompt_member_1" },
        memberTurn("turn_member_2", "bot_c", "queued"),
      ],
    );
    const wrapper = mount(GroupTranscript, {
      props: { bots: profiles },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    await flushPromises();
    await wrapper.get('[data-test="group-dispatch-row"]').trigger("click");
    const members = wrapper.findAll('[data-test="group-dispatch-member"]');
    expect(members).toHaveLength(2);
    expect(members[0]!.attributes("disabled")).toBeUndefined();
    expect(members[1]!.attributes("disabled")).toBeDefined();
    await members[0]!.trigger("click");
    await flushPromises();
    const reply = wrapper.get('[data-message-id="reply_b"]');
    expect(document.activeElement).toBe(reply.element);
    wrapper.unmount();
  });

  it("stops one member through the store when the row asks for it", async () => {
    const groups = seedTranscript(
      [handoffMessage(1), handoffMessage(2)],
      [
        memberTurn("turn_a", "bot_a", "completed"),
        memberTurn("turn_member_1", "bot_b", "running"),
        memberTurn("turn_member_2", "bot_c", "running"),
      ],
    );
    const cancelMember = vi.spyOn(groups, "cancelMember").mockResolvedValue(undefined);
    const wrapper = mount(GroupTranscript, { props: { bots: profiles }, global: { plugins: [i18n] } });
    await flushPromises();

    const dispatchRow = wrapper.findComponent(GroupDispatchRow);
    expect(dispatchRow.exists()).toBe(true);
    dispatchRow.vm.$emit("stopMember", { runId: "run_1", memberTurnId: "turn_member_1" });
    await flushPromises();

    expect(cancelMember).toHaveBeenCalledWith("instance_1", "run_1", "turn_member_1");
    wrapper.unmount();
  });
});
