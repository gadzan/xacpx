import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { isVNode, type VNode } from "vue";
import { createPinia, setActivePinia } from "pinia";
import {
  RELAY_CAPABILITIES,
  type BotSummaryDto,
  type ConversationMessageDto,
  type MemberTurnSummaryDto,
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
import { settleConfirm, useConfirmState } from "../lib/use-confirm";

afterEach(() => settleConfirm(false));

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
  memberTurnId = `turn_${botId}`,
): ConversationMessageDto & { handoff: NonNullable<ConversationMessageDto["handoff"]> } {
  return {
    id: `handoff_${botId}_${seq}`,
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
      assignmentId: `assignment_${botId}_${seq}`,
      memberTurnId,
      task,
    },
  };
}

function entry(
  botId: string,
  state: MemberTurnSummaryDto["state"],
  over: { task?: string; seq?: number; turn?: Partial<MemberTurnSummaryDto>; memberTurnId?: string } = {},
): GroupDispatchEntry {
  const memberTurnId = over.memberTurnId ?? `turn_${botId}`;
  return {
    message: dispatchHandoff(botId, over.task ?? `Review ${botId}`, over.seq ?? 1, memberTurnId),
    memberTurn: turn(botId, state, { id: memberTurnId, ...over.turn }),
  };
}

/** A member's own reply, addressed by that member turn's prompt identity. */
function replyMessage(
  botId: string,
  promptRequestId: string,
  content: string,
  seq: number,
  id = `reply_${botId}`,
): ConversationMessageDto {
  return {
    id,
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

/**
 * The vnode keys of the dispatch member rows.
 *
 * The rendered DOM cannot show a key, so the row identity is read from the
 * rendered vnode tree: it is the only place a duplicate key is visible.
 */
function memberRowKeys(wrapper: VueWrapper): PropertyKey[] {
  const keys: PropertyKey[] = [];
  const visit = (vnode: VNode, depth: number): void => {
    if (depth > 40) return;
    if (vnode.type === "ul") {
      const children = Array.isArray(vnode.children) ? vnode.children : [];
      for (const child of children) {
        if (!isVNode(child)) continue;
        const rows = Array.isArray(child.children) ? child.children : [];
        for (const row of rows) {
          if (isVNode(row)) keys.push(row.key ?? "");
        }
      }
    }
    if (vnode.component) visit(vnode.component.subTree, depth + 1);
    if (Array.isArray(vnode.children)) {
      for (const child of vnode.children) {
        if (isVNode(child)) visit(child, depth + 1);
      }
    }
  };
  visit(wrapper.vm.$.subTree, 0);
  return keys;
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
    global: { plugins: [i18n], stubs: { teleport: true } },
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

  it("keeps a member without a reply readable instead of dimmed", async () => {
    const wrapper = row([], ["bot_a"], {
      dispatches: [entry("bot_a", "running", { task: "Review the diff" })],
    });
    await wrapper.get('[data-test="group-dispatch-row"]').trigger("click");
    const member = wrapper.get('[data-test="group-dispatch-member"]');
    // The row stays inert, but the name and the state keep full opacity.
    expect(member.attributes("disabled")).toBeDefined();
    expect(member.classes()).not.toContain("disabled:opacity-70");
    wrapper.unmount();
  });

  it("renders one row per dispatch when the same bot is dispatched twice", async () => {
    const wrapper = row([], ["bot_a"], {
      dispatches: [
        entry("bot_a", "completed", { task: "Review the diff", seq: 1, memberTurnId: "turn_a_1", turn: { promptRequestId: "prompt_a_1" } }),
        entry("bot_a", "completed", { task: "Review the diff", seq: 2, memberTurnId: "turn_a_2", turn: { promptRequestId: "prompt_a_2" } }),
      ],
      messages: [
        replyMessage("bot_a", "prompt_a_1", "First answer", 5, "reply_a_1"),
        replyMessage("bot_a", "prompt_a_2", "Second answer", 6, "reply_a_2"),
      ],
    });
    await wrapper.get('[data-test="group-dispatch-row"]').trigger("click");

    // The row keys are the member turns, never the bot ids: the same bot
    // dispatched twice must produce two keyed rows.
    expect(memberRowKeys(wrapper)).toEqual(["turn_a_1", "turn_a_2"]);

    const members = wrapper.findAll('[data-test="group-dispatch-member"]');
    expect(members).toHaveLength(2);
    const memberTurnIds = members.map((member) => member.attributes("data-member-turn-id"));
    expect(memberTurnIds).toEqual(["turn_a_1", "turn_a_2"]);
    expect(new Set(memberTurnIds).size).toBe(2);
    expect(members[0]!.get('[data-test="group-dispatch-member-preview"]').text()).toBe("First answer");
    expect(members[1]!.get('[data-test="group-dispatch-member-preview"]').text()).toBe("Second answer");

    // The second row jumps to the SECOND dispatch's reply, not the first.
    await members[1]!.trigger("click");
    expect(wrapper.emitted("jump")).toEqual([["reply_a_2"]]);
    wrapper.unmount();
  });

  it("names the lone dispatched bot instead of counting it", () => {
    const wrapper = row(["running"], ["bot_a"]);
    expect(wrapper.get('[data-test="group-dispatch-title"]').text()).toBe("Sent to Reviewer");
    // The status count and the stop action are the same as for a fan-out round.
    expect(wrapper.get('[data-test="group-dispatch-status-active"]').text()).toBe("1 running");
    wrapper.unmount();
  });

  it("names the lone dispatched bot in Chinese", () => {
    i18n.global.locale.value = "zh-CN";
    const wrapper = row(["queued"], ["bot_b"]);
    expect(wrapper.get('[data-test="group-dispatch-title"]').text()).toBe("派发给 Tester");
    wrapper.unmount();
  });

  it("keeps the lone dispatch's stop and card identical to a fan-out round", async () => {
    const wrapper = row(["running"], ["bot_a"], { supportsCancelMember: true });
    await wrapper.get('[data-test="group-dispatch-row"]').trigger("click");
    const members = wrapper.findAll('[data-test="group-dispatch-member"]');
    expect(members).toHaveLength(1);
    expect(members[0]!.get('[data-test="group-dispatch-member-name"]').text()).toBe("Reviewer");
    expect(members[0]!.get('[data-test="group-dispatch-member-status"]').text()).toBe("Running");
    expect(wrapper.findAll('[data-test="group-dispatch-stop-member"]')).toHaveLength(1);
    wrapper.unmount();
  });

  it("draws the member stop action as a filled square", async () => {
    const wrapper = row(["running"], ["bot_a"], { supportsCancelMember: true });
    await wrapper.get('[data-test="group-dispatch-row"]').trigger("click");
    expect(wrapper.get('[data-test="group-dispatch-stop-member"] svg').classes()).toContain("fill-current");
    wrapper.unmount();
  });

  it("words the Chinese member stop action without an inner space", async () => {
    i18n.global.locale.value = "zh-CN";
    const wrapper = row(["running"], ["bot_a"], { supportsCancelMember: true });
    await wrapper.get('[data-test="group-dispatch-row"]').trigger("click");
    expect(wrapper.get('[data-test="group-dispatch-stop-member"]').attributes("aria-label")).toBe("停止Reviewer");
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

  it("offers stop all only while the round still has active members", async () => {
    const active = row(["running", "queued"]);
    await active.get('[data-test="group-dispatch-row"]').trigger("click");
    expect(active.get('[data-test="group-dispatch-stop-all"]').text()).toBe("Stop all");
    active.unmount();

    const done = row(["completed", "completed"]);
    await done.get('[data-test="group-dispatch-row"]').trigger("click");
    expect(done.find('[data-test="group-dispatch-stop-all"]').exists()).toBe(false);
    done.unmount();

    const cancelled = row(["cancelled", "cancelled"]);
    await cancelled.get('[data-test="group-dispatch-row"]').trigger("click");
    expect(cancelled.find('[data-test="group-dispatch-stop-all"]').exists()).toBe(false);
    cancelled.unmount();
  });

  it("asks for a round-level stop without jumping or collapsing the card", async () => {
    const wrapper = row(["running", "queued"], ["bot_a", "bot_b"]);
    const trigger = wrapper.get('[data-test="group-dispatch-row"]');
    await trigger.trigger("click");

    await wrapper.get('[data-test="group-dispatch-stop-all"]').trigger("click");
    expect(wrapper.emitted("stopAll")).toEqual([[]]);
    expect(wrapper.emitted("jump")).toBeUndefined();
    expect(wrapper.emitted("stopMember")).toBeUndefined();
    // Stopping the round never collapses the card underneath the user.
    expect(trigger.attributes("aria-expanded")).toBe("true");
    wrapper.unmount();
  });

  it("reports all completed with a green check", () => {
    const wrapper = row(["completed", "completed", "completed", "completed"]);
    expect(wrapper.get('[data-test="group-dispatch-status-done"]').text()).toContain("4 done");
    expect(wrapper.get('[data-test="group-dispatch-status-done"]').classes()).toContain("text-run");
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

  it("words a mixed Chinese round with the compact done count", () => {
    i18n.global.locale.value = "zh-CN";
    const wrapper = row(["completed", "completed", "cancelled", "cancelled"]);
    const status = wrapper.get('[data-test="group-dispatch-status"]').text();
    expect(status).toContain("✓ 2 已完成");
    expect(status).toContain("2 已取消");
    // The all-done headline is reserved for a round that is entirely done.
    expect(status).not.toContain("个已完成");
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

  it("reports members whose outcome is unknown", () => {
    const wrapper = row(["completed", "completed", "indeterminate"]);
    const status = wrapper.get('[data-test="group-dispatch-status"]').text();
    expect(status).toContain("✓ 2 done");
    expect(wrapper.get('[data-test="group-dispatch-status-indeterminate"]').text()).toContain("1 unknown");
    // An unknown outcome is never folded into the failure count.
    expect(wrapper.find('[data-test="group-dispatch-status-failed"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("puts the unknown count last and in muted tone", () => {
    const wrapper = row(["running", "failed", "indeterminate"]);
    const status = wrapper.get('[data-test="group-dispatch-status"]');
    const children = Array.from(status.element.children)
      .filter((child) => child.getAttribute("data-test") !== null)
      .map((child) => child.getAttribute("data-test"));
    // The unknown count is the gap in what is known: it comes after every
    // proven outcome, and it is never read as a failure.
    expect(children).toEqual([
      "group-dispatch-status-active",
      "group-dispatch-status-failed",
      "group-dispatch-status-indeterminate",
    ]);
    const unknown = wrapper.get('[data-test="group-dispatch-status-indeterminate"]');
    expect(unknown.classes()).toContain("text-fg-muted");
    expect(unknown.classes()).not.toContain("text-warn");
    expect(unknown.classes()).not.toContain("text-danger");
    // The question-mark icon marks the gap without shouting.
    expect(unknown.find("svg").exists()).toBe(true);
    wrapper.unmount();
  });

  it("words the unknown count in Chinese", () => {
    i18n.global.locale.value = "zh-CN";
    const wrapper = row(["completed", "indeterminate"]);
    expect(wrapper.get('[data-test="group-dispatch-status-indeterminate"]').text()).toContain("1 个结果未知");
    wrapper.unmount();
  });

  it("separates the stacked avatars with a surface ring", () => {
    const wrapper = row(
      ["completed", "completed", "completed", "completed", "completed"],
      ["bot_a", "bot_b", "bot_c", "bot_d", "bot_e"],
    );
    const avatars = Array.from(wrapper.get('[data-test="group-dispatch-avatars"]').element.children);
    expect(avatars).toHaveLength(5);
    for (const avatar of avatars) {
      expect(avatar.classList.contains("ring-2")).toBe(true);
      expect(avatar.classList.contains("ring-surface")).toBe(true);
    }
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
    ["zh-CN", "派发给 2 个 Bot", "2 排队中", "已停止", "派发内容"],
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

function memberTurn(
  id: string,
  botId: string,
  state: MemberTurnSummaryDto["state"],
  over: Partial<MemberTurnSummaryDto> = {},
): MemberTurnSummaryDto {
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
    ...over,
  };
}

function seedTranscript(
  messages: ConversationMessageDto[],
  turns: MemberTurnSummaryDto[],
  options: { capabilities?: string[] } = {},
) {
  setActivePinia(createPinia());
  const instances = useInstancesStore();
  instances.instances = [
    {
      id: "instance_1",
      name: "Local",
      online: true,
      lastSeenAt: null,
      sessions: [],
      capabilities: options.capabilities ?? [],
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

  it("aggregates a lone dispatch into the same row as a fan-out round", async () => {
    seedTranscript(
      [handoffMessage(1)],
      [
        memberTurn("turn_a", "bot_a", "completed"),
        memberTurn("turn_member_1", "bot_b", "running"),
      ],
    );
    const wrapper = mount(GroupTranscript, { props: { bots: profiles }, global: { plugins: [i18n] } });
    await flushPromises();
    const rows = wrapper.findAll('[data-test="group-dispatch-row"]');
    expect(rows).toHaveLength(1);
    // The lone dispatch names its bot instead of counting it.
    expect(rows[0]!.get('[data-test="group-dispatch-title"]').text()).toBe("Sent to Tester");
    expect(rows[0]!.text()).toContain("1 running");
    // The old per-handoff entry is gone: the row is the only entry point.
    expect(wrapper.find('[data-test="group-handoff"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("collapses a lone dispatch into the leader's own row", async () => {
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
          content: "Dispatching one review",
          createdAt: "now",
        },
        handoffMessage(1),
      ],
      [
        { ...memberTurn("turn_a", "bot_a", "running"), promptRequestId: "prompt_leader" },
        memberTurn("turn_member_1", "bot_b", "queued"),
      ],
    );
    const wrapper = mount(GroupTranscript, { props: { bots: profiles }, global: { plugins: [i18n] } });
    await flushPromises();
    expect(wrapper.findAll('[data-test="group-dispatch-row"]')).toHaveLength(1);
    // The handoff itself collapses: the round renders below the leader bubble.
    expect(wrapper.find('[data-message-id="handoff_1"]').exists()).toBe(false);
    const leaderRow = wrapper.get('[data-message-id="msg_1"]');
    expect(leaderRow.element.parentElement?.textContent ?? "").toContain("Sent to Tester");
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

  it("marks the leader message stopped when the leader turn carries the stop reason", async () => {
    seedTranscript(
      [handoffMessage(1), handoffMessage(2)],
      [memberTurn("turn_a", "bot_a", "completed", { cancellationReason: "human-cancelled" })],
    );
    const wrapper = mount(GroupTranscript, { props: { bots: profiles }, global: { plugins: [i18n] } });
    await flushPromises();
    expect(wrapper.findAll('[data-test="group-dispatch-row"]')).toHaveLength(1);
    expect(wrapper.get('[data-test="group-dispatch-stopped"]').text()).toBe("Stopped");
    wrapper.unmount();
  });

  it("shows a stopped leader with a completed aggregate row in Chinese", async () => {
    i18n.global.locale.value = "zh-CN";
    seedTranscript(
      [handoffMessage(1), handoffMessage(2)],
      [
        memberTurn("turn_a", "bot_a", "completed", { cancellationReason: "human-cancelled" }),
        memberTurn("turn_member_1", "bot_b", "completed"),
        memberTurn("turn_member_2", "bot_c", "completed"),
      ],
    );
    const wrapper = mount(GroupTranscript, { props: { bots: profiles }, global: { plugins: [i18n] } });
    await flushPromises();
    expect(wrapper.get('[data-test="group-dispatch-stopped"]').text()).toBe("已停止");
    expect(wrapper.get('[data-test="group-dispatch-status-done"]').text()).toBe("✓ 2 个已完成");
    wrapper.unmount();
  });

  it("drops the stopped note when every dispatched member is cancelled", async () => {
    seedTranscript(
      [handoffMessage(1), handoffMessage(2)],
      [
        memberTurn("turn_a", "bot_a", "cancelled", { cancellationReason: "human-cancelled" }),
        memberTurn("turn_member_1", "bot_b", "cancelled"),
        memberTurn("turn_member_2", "bot_c", "cancelled"),
      ],
    );
    const wrapper = mount(GroupTranscript, { props: { bots: profiles }, global: { plugins: [i18n] } });
    await flushPromises();
    // "⊘ Cancelled" on the aggregate row already says the round stopped.
    expect(wrapper.get('[data-test="group-dispatch-status-cancelled"]').text()).toContain("Cancelled");
    expect(wrapper.find('[data-test="group-dispatch-stopped"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("marks the leader message stopped when its wake turn carries the stop reason", async () => {
    seedTranscript(
      [handoffMessage(1), handoffMessage(2)],
      [
        memberTurn("turn_a", "bot_a", "completed"),
        memberTurn("turn_member_1", "bot_b", "completed"),
        memberTurn("turn_member_2", "bot_c", "completed"),
        {
          ...memberTurn("turn_wake", "bot_a", "cancelled"),
          origin: "followup",
          followupSenderMemberTurnId: "turn_a",
          cancellationReason: "human-cancelled",
        },
      ],
    );
    const wrapper = mount(GroupTranscript, { props: { bots: profiles }, global: { plugins: [i18n] } });
    await flushPromises();
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

  it("stops the whole round through the store after confirmation", async () => {
    const groups = seedTranscript(
      [handoffMessage(1), handoffMessage(2)],
      [
        memberTurn("turn_a", "bot_a", "completed"),
        memberTurn("turn_member_1", "bot_b", "running"),
        memberTurn("turn_member_2", "bot_c", "queued"),
      ],
    );
    groups.groupsByInstance = {
      instance_1: [{
        id: "group_1",
        kind: "group",
        title: "Release",
        botIds: ["bot_a", "bot_b", "bot_c"],
        createdAt: "now",
        updatedAt: "now",
      }],
    };
    const cancel = vi.spyOn(groups, "cancelCurrentRun").mockResolvedValue({
      status: "blocked", scope: null, runId: "run_1", reason: "ownership",
    });
    const wrapper = mount(GroupTranscript, { props: { bots: profiles }, global: { plugins: [i18n] } });
    await flushPromises();

    await wrapper.get('[data-test="group-dispatch-row"]').trigger("click");
    await wrapper.get('[data-test="group-dispatch-stop-all"]').trigger("click");
    await flushPromises();

    expect(useConfirmState().value?.title).toBe("Stop all tasks?");
    expect(useConfirmState().value?.message).toBe("Reviewer and the 2 dispatched tasks will stop");
    expect(useConfirmState().value?.confirmLabel).toBe("Stop all");
    expect(useConfirmState().value?.tone).toBe("danger");
    expect(cancel).not.toHaveBeenCalled();

    settleConfirm(true);
    await flushPromises();
    expect(cancel).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("names the leader in the Chinese stop-all confirmation", async () => {
    i18n.global.locale.value = "zh-CN";
    seedTranscript(
      [handoffMessage(1), handoffMessage(2)],
      [
        memberTurn("turn_a", "bot_a", "completed"),
        memberTurn("turn_member_1", "bot_b", "running"),
        memberTurn("turn_member_2", "bot_c", "queued"),
      ],
    );
    const wrapper = mount(GroupTranscript, { props: { bots: profiles }, global: { plugins: [i18n] } });
    await flushPromises();

    await wrapper.get('[data-test="group-dispatch-row"]').trigger("click");
    await wrapper.get('[data-test="group-dispatch-stop-all"]').trigger("click");
    await flushPromises();

    expect(useConfirmState().value?.message).toBe("Reviewer和已派发的 2 个任务都会停止");
    wrapper.unmount();
  });

  it("names the leader in the Chinese stop pill without an inner space", async () => {
    i18n.global.locale.value = "zh-CN";
    seedTranscript(
      [handoffMessage(1), handoffMessage(2)],
      [
        memberTurn("turn_a", "bot_a", "running"),
        memberTurn("turn_member_1", "bot_b", "running"),
        memberTurn("turn_member_2", "bot_c", "queued"),
      ],
      { capabilities: [RELAY_CAPABILITIES.runsCancelMemberV1] },
    );
    const wrapper = mount(GroupTranscript, { props: { bots: profiles }, global: { plugins: [i18n] } });
    await flushPromises();
    expect(wrapper.get('[data-test="group-dispatch-stop-leader"]').text()).toBe("停止Reviewer");
    wrapper.unmount();
  });

  it("leaves the run alone when the stop-all confirmation is dismissed", async () => {
    const groups = seedTranscript(
      [handoffMessage(1), handoffMessage(2)],
      [
        memberTurn("turn_a", "bot_a", "completed"),
        memberTurn("turn_member_1", "bot_b", "running"),
        memberTurn("turn_member_2", "bot_c", "running"),
      ],
    );
    const cancel = vi.spyOn(groups, "cancelCurrentRun").mockResolvedValue({
      status: "blocked", scope: null, runId: "run_1", reason: "ownership",
    });
    const wrapper = mount(GroupTranscript, { props: { bots: profiles }, global: { plugins: [i18n] } });
    await flushPromises();

    await wrapper.get('[data-test="group-dispatch-row"]').trigger("click");
    await wrapper.get('[data-test="group-dispatch-stop-all"]').trigger("click");
    await flushPromises();
    settleConfirm(false);
    await flushPromises();

    expect(cancel).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("offers the leader pill while the leader's own turn is still running", async () => {
    const groups = seedTranscript(
      [handoffMessage(1), handoffMessage(2)],
      [
        memberTurn("turn_a", "bot_a", "running"),
        memberTurn("turn_member_1", "bot_b", "running"),
        memberTurn("turn_member_2", "bot_c", "queued"),
      ],
      { capabilities: [RELAY_CAPABILITIES.runsCancelMemberV1] },
    );
    const wrapper = mount(GroupTranscript, { props: { bots: profiles }, global: { plugins: [i18n] } });
    await flushPromises();

    const pill = wrapper.get('[data-test="group-dispatch-stop-leader"]');
    expect(pill.text()).toContain("Stop Reviewer");

    // The leader's turn ends, but its dispatch has not settled yet: the wake
    // row does not exist yet, so there is still work to stop.
    groups.memberTurnsById = {
      ...groups.memberTurnsById,
      turn_a: { ...groups.memberTurnsById.turn_a!, state: "completed" },
    };
    await flushPromises();

    expect(wrapper.find('[data-test="group-dispatch-stop-leader"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("draws the leader stop pill as a filled square", async () => {
    seedTranscript(
      [handoffMessage(1), handoffMessage(2)],
      [
        memberTurn("turn_a", "bot_a", "running"),
        memberTurn("turn_member_1", "bot_b", "running"),
        memberTurn("turn_member_2", "bot_c", "queued"),
      ],
      { capabilities: [RELAY_CAPABILITIES.runsCancelMemberV1] },
    );
    const wrapper = mount(GroupTranscript, { props: { bots: profiles }, global: { plugins: [i18n] } });
    await flushPromises();
    expect(wrapper.get('[data-test="group-dispatch-stop-leader"] svg').classes()).toContain("fill-current");
    wrapper.unmount();
  });

  it("offers the leader pill while the leader's wake is still live", async () => {
    const groups = seedTranscript(
      [handoffMessage(1), handoffMessage(2)],
      [
        memberTurn("turn_a", "bot_a", "completed"),
        memberTurn("turn_member_1", "bot_b", "completed"),
        memberTurn("turn_member_2", "bot_c", "completed"),
        { ...memberTurn("turn_wake", "bot_a", "running"), origin: "followup", followupSenderMemberTurnId: "turn_a" },
      ],
      { capabilities: [RELAY_CAPABILITIES.runsCancelMemberV1] },
    );
    const wrapper = mount(GroupTranscript, { props: { bots: profiles }, global: { plugins: [i18n] } });
    await flushPromises();

    expect(wrapper.find('[data-test="group-dispatch-stop-leader"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("drops the leader pill once the leader's wake settled", async () => {
    const groups = seedTranscript(
      [handoffMessage(1), handoffMessage(2)],
      [
        memberTurn("turn_a", "bot_a", "completed"),
        memberTurn("turn_member_1", "bot_b", "completed"),
        memberTurn("turn_member_2", "bot_c", "completed"),
        { ...memberTurn("turn_wake", "bot_a", "completed"), origin: "followup", followupSenderMemberTurnId: "turn_a" },
      ],
      { capabilities: [RELAY_CAPABILITIES.runsCancelMemberV1] },
    );
    const wrapper = mount(GroupTranscript, { props: { bots: profiles }, global: { plugins: [i18n] } });
    await flushPromises();

    expect(wrapper.find('[data-test="group-dispatch-stop-leader"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("stops a finished leader through its own turn while its dispatch is still running", async () => {
    const groups = seedTranscript(
      [handoffMessage(1), handoffMessage(2)],
      [
        memberTurn("turn_a", "bot_a", "completed"),
        memberTurn("turn_member_1", "bot_b", "running"),
        memberTurn("turn_member_2", "bot_c", "queued"),
      ],
      { capabilities: [RELAY_CAPABILITIES.runsCancelMemberV1] },
    );
    const cancelMember = vi.spyOn(groups, "cancelMember").mockResolvedValue(undefined);
    const wrapper = mount(GroupTranscript, { props: { bots: profiles }, global: { plugins: [i18n] } });
    await flushPromises();

    await wrapper.get('[data-test="group-dispatch-stop-leader"]').trigger("click");
    await flushPromises();

    expect(cancelMember).toHaveBeenCalledWith("instance_1", "run_1", "turn_a");
    wrapper.unmount();
  });

  it("stops the live wake turn instead of the finished leader", async () => {
    const groups = seedTranscript(
      [handoffMessage(1), handoffMessage(2)],
      [
        memberTurn("turn_a", "bot_a", "completed"),
        memberTurn("turn_member_1", "bot_b", "completed"),
        memberTurn("turn_member_2", "bot_c", "completed"),
        { ...memberTurn("turn_wake", "bot_a", "running"), origin: "followup", followupSenderMemberTurnId: "turn_a" },
      ],
      { capabilities: [RELAY_CAPABILITIES.runsCancelMemberV1] },
    );
    const cancelMember = vi.spyOn(groups, "cancelMember").mockResolvedValue(undefined);
    const wrapper = mount(GroupTranscript, { props: { bots: profiles }, global: { plugins: [i18n] } });
    await flushPromises();

    await wrapper.get('[data-test="group-dispatch-stop-leader"]').trigger("click");
    await flushPromises();

    expect(cancelMember).toHaveBeenCalledWith("instance_1", "run_1", "turn_wake");
    wrapper.unmount();
  });

  it("stops the leader without a confirmation when the core can scope the cancel", async () => {
    const groups = seedTranscript(
      [handoffMessage(1), handoffMessage(2)],
      [
        memberTurn("turn_a", "bot_a", "running"),
        memberTurn("turn_member_1", "bot_b", "running"),
        memberTurn("turn_member_2", "bot_c", "queued"),
      ],
      { capabilities: [RELAY_CAPABILITIES.runsCancelMemberV1] },
    );
    const cancelMember = vi.spyOn(groups, "cancelMember").mockResolvedValue(undefined);
    const cancel = vi.spyOn(groups, "cancelCurrentRun").mockResolvedValue({
      status: "blocked", scope: null, runId: "run_1", reason: "ownership",
    });
    const wrapper = mount(GroupTranscript, { props: { bots: profiles }, global: { plugins: [i18n] } });
    await flushPromises();

    await wrapper.get('[data-test="group-dispatch-stop-leader"]').trigger("click");
    await flushPromises();

    expect(useConfirmState().value).toBeNull();
    expect(cancelMember).toHaveBeenCalledTimes(1);
    expect(cancelMember).toHaveBeenCalledWith("instance_1", "run_1", "turn_a");
    expect(cancel).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("falls back to the confirmed stop-all on a core without scoped cancellation", async () => {
    const groups = seedTranscript(
      [handoffMessage(1), handoffMessage(2)],
      [
        memberTurn("turn_a", "bot_a", "running"),
        memberTurn("turn_member_1", "bot_b", "running"),
        memberTurn("turn_member_2", "bot_c", "queued"),
      ],
    );
    const cancel = vi.spyOn(groups, "cancelCurrentRun").mockResolvedValue({
      status: "blocked", scope: null, runId: "run_1", reason: "ownership",
    });
    const wrapper = mount(GroupTranscript, { props: { bots: profiles }, global: { plugins: [i18n] } });
    await flushPromises();

    const pill = wrapper.get('[data-test="group-dispatch-stop-leader"]');
    expect(pill.text()).toContain("Stop all");

    await pill.trigger("click");
    await flushPromises();

    expect(useConfirmState().value?.title).toBe("Stop all tasks?");
    expect(cancel).not.toHaveBeenCalled();

    settleConfirm(true);
    await flushPromises();
    expect(cancel).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
});

/** The mobile branch of the row is width-driven (useIsMobile: < 1024). */
function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
}

describe("GroupDispatchRow on mobile", () => {
  const realWidth = window.innerWidth;
  beforeEach(() => {
    i18n.global.locale.value = "en";
    setViewportWidth(375);
  });
  afterEach(() => {
    setViewportWidth(realWidth);
  });

  it("collapses the row into one non-wrapping bots · status line", () => {
    const wrapper = row(["running", "running", "queued", "queued"]);
    const summary = wrapper.get('[data-test="group-dispatch-summary"]');
    expect(summary.text()).toBe("4 bots · 2 running · 2 queued");
    expect(summary.classes()).toContain("whitespace-nowrap");
    // The desktop title/status split is gone.
    expect(wrapper.find('[data-test="group-dispatch-title"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="group-dispatch-status"]').exists()).toBe(false);
    wrapper.unmount();
  });
  it("shows the expand chevron and a running spinner with desktop emphasis on mobile", () => {
    const wrapper = row(["running", "running", "queued", "queued"]);
    const chevron = wrapper.get('[data-test="group-dispatch-chevron"]');
    expect(chevron.classes()).not.toContain("rotate-180");
    const spinner = wrapper.get('[data-test="group-dispatch-summary-spinner"]');
    expect(spinner.classes()).toContain("animate-spin");
    expect(spinner.classes()).toContain("text-accent");
    expect(wrapper.get('[data-test="group-dispatch-summary-status"]').classes()).toContain("text-accent");
    wrapper.unmount();
  });

  it("reads the mobile status with the desktop emphasis tokens", () => {
    const done = row(["completed", "completed"]);
    expect(done.get('[data-test="group-dispatch-summary-status"]').classes()).toContain("text-run");
    expect(done.find('[data-test="group-dispatch-summary-spinner"]').exists()).toBe(false);
    done.unmount();

    const failed = row(["completed", "failed"]);
    expect(failed.get('[data-test="group-dispatch-summary-status"]').classes()).toContain("text-danger");
    failed.unmount();
  });

  it("localizes the mobile summary", () => {
    i18n.global.locale.value = "zh-CN";
    const wrapper = row(["running", "running", "completed", "completed"]);
    expect(wrapper.get('[data-test="group-dispatch-summary"]').text()).toBe("4 个 Bot · 2 执行中");
    wrapper.unmount();
  });

  it("names the lone dispatched bot in the mobile summary", () => {
    const wrapper = row(["running"], ["bot_a"]);
    expect(wrapper.get('[data-test="group-dispatch-summary"]').text()).toBe("Sent to Reviewer · 1 running");
    wrapper.unmount();
  });

  it("names the lone dispatched bot in the Chinese mobile summary", () => {
    i18n.global.locale.value = "zh-CN";
    const wrapper = row(["running"], ["bot_a"]);
    expect(wrapper.get('[data-test="group-dispatch-summary"]').text()).toBe("派发给 Reviewer · 1 执行中");
    wrapper.unmount();
  });

  it("words a mixed Chinese mobile summary with the compact done count", () => {
    i18n.global.locale.value = "zh-CN";
    const wrapper = row(["completed", "completed", "cancelled", "cancelled"]);
    expect(wrapper.get('[data-test="group-dispatch-summary"]').text()).toBe("4 个 Bot · 2 已完成 · 2 已取消");
    wrapper.unmount();
  });

  it("reports members whose outcome is unknown in the mobile summary", () => {
    i18n.global.locale.value = "zh-CN";
    const wrapper = row(["completed", "completed", "indeterminate"]);
    // The mobile pill has no room for the long wording: it says "1 未知".
    expect(wrapper.get('[data-test="group-dispatch-summary"]').text()).toBe("3 个 Bot · 2 已完成 · 1 未知");
    wrapper.unmount();
  });

  it("reports members whose outcome is unknown in the English mobile summary", () => {
    const wrapper = row(["running", "running", "completed", "completed", "indeterminate"]);
    expect(wrapper.get('[data-test="group-dispatch-summary"]').text()).toBe("5 bots · 2 running · 1 unknown");
    wrapper.unmount();
  });

  it("opens a bottom sheet instead of the desktop card", async () => {
    const wrapper = row([], ["bot_a", "bot_b"], {
      dispatches: [entry("bot_a", "running", { task: "Review the diff" }), entry("bot_b", "completed", { task: "Review the diff" })],
    });
    const trigger = wrapper.get('[data-test="group-dispatch-row"]');
    await trigger.trigger("click");

    expect(wrapper.find('[data-test="group-dispatch-card"]').exists()).toBe(false);
    expect(trigger.attributes("aria-expanded")).toBe("true");
    expect(wrapper.find('[data-test="group-dispatch-sheet"]').exists()).toBe(true);

    const rows = wrapper.findAll('[data-test="group-dispatch-sheet-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.get('[data-test="group-dispatch-sheet-member-name"]').text()).toBe("Reviewer");
    expect(rows[0]!.get('[data-test="group-dispatch-sheet-member-status"]').text()).toBe("Running");
    expect(rows[1]!.get('[data-test="group-dispatch-sheet-member-name"]').text()).toBe("Tester");
    expect(rows[1]!.get('[data-test="group-dispatch-sheet-member-status"]').text()).toBe("Completed");
    // Touch target: every row is at least 44px tall.
    for (const sheetRow of rows) expect(sheetRow.classes()).toContain("min-h-11");
    wrapper.unmount();
  });
  it("shows each member's avatar in the sheet row", async () => {
    const wrapper = row([], ["bot_a", "bot_b"], {
      dispatches: [entry("bot_a", "running", { task: "Review the diff" }), entry("bot_b", "completed", { task: "Review the diff" })],
    });
    await wrapper.get('[data-test="group-dispatch-row"]').trigger("click");
    const rows = wrapper.findAll('[data-test="group-dispatch-sheet-row"]');
    expect(rows).toHaveLength(2);
    for (const sheetRow of rows) {
      expect(sheetRow.find('[data-test="group-dispatch-sheet-member-avatar"] [data-test="bot-avatar"]').exists()).toBe(true);
    }
    wrapper.unmount();
  });

  it("stops one member from the sheet with the desktop stop logic", async () => {
    const wrapper = row([], ["bot_a", "bot_b", "bot_c"], {
      dispatches: [
        entry("bot_a", "running", { task: "Review the diff", seq: 1, turn: { id: "turn_a", runId: "run_9" } }),
        entry("bot_b", "queued", { task: "Review the diff", seq: 2, turn: { id: "turn_b", runId: "run_9" } }),
        entry("bot_c", "completed", { task: "Review the diff", seq: 3, turn: { id: "turn_c", runId: "run_9" } }),
      ],
      supportsCancelMember: true,
    });
    await wrapper.get('[data-test="group-dispatch-row"]').trigger("click");
    const stops = wrapper.findAll('[data-test="group-dispatch-sheet-stop-member"]');
    expect(stops).toHaveLength(2);
    expect(stops.map((stop) => stop.attributes("data-bot-id"))).toEqual(["bot_a", "bot_b"]);
    expect(stops[0]!.attributes("aria-label")).toBe("Stop Reviewer");
    expect(stops[0]!.get("svg").classes()).toContain("fill-current");
    await stops[0]!.trigger("click");
    expect(wrapper.emitted("stopMember")).toEqual([[{ runId: "run_9", memberTurnId: "turn_a" }]]);
    expect(wrapper.emitted("jump")).toBeUndefined();
    wrapper.unmount();
  });

  it("offers no sheet member stop when the core cannot cancel a single member", async () => {
    const wrapper = row(["running", "queued"], ["bot_a", "bot_b"], { supportsCancelMember: false });
    await wrapper.get('[data-test="group-dispatch-row"]').trigger("click");
    expect(wrapper.find('[data-test="group-dispatch-sheet-stop-member"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("renders one sheet row per dispatch when the same bot is dispatched twice", async () => {
    const wrapper = row([], ["bot_a"], {
      dispatches: [
        entry("bot_a", "completed", { task: "Review the diff", seq: 1, memberTurnId: "turn_a_1" }),
        entry("bot_a", "completed", { task: "Review the diff", seq: 2, memberTurnId: "turn_a_2" }),
      ],
    });
    await wrapper.get('[data-test="group-dispatch-row"]').trigger("click");

    const sheetRows = wrapper.findAll('[data-test="group-dispatch-sheet-row"]');
    expect(sheetRows).toHaveLength(2);
    expect(sheetRows.map((row) => row.attributes("data-member-turn-id"))).toEqual(["turn_a_1", "turn_a_2"]);
    wrapper.unmount();
  });

  it("offers stop all in the sheet only while a member is active", async () => {
    const active = row(["running", "queued"]);
    await active.get('[data-test="group-dispatch-row"]').trigger("click");
    expect(active.get('[data-test="group-dispatch-sheet-stop-all"]').text()).toBe("Stop all");
    active.unmount();

    const done = row(["completed", "completed"]);
    await done.get('[data-test="group-dispatch-row"]').trigger("click");
    expect(done.find('[data-test="group-dispatch-sheet-stop-all"]').exists()).toBe(false);
    done.unmount();
  });

  it("runs the desktop stop-all confirmation from the sheet", async () => {
    const groups = seedTranscript(
      [handoffMessage(1), handoffMessage(2)],
      [
        memberTurn("turn_a", "bot_a", "completed"),
        memberTurn("turn_member_1", "bot_b", "running"),
        memberTurn("turn_member_2", "bot_c", "queued"),
      ],
    );
    groups.groupsByInstance = {
      instance_1: [{
        id: "group_1",
        kind: "group",
        title: "Release",
        botIds: ["bot_a", "bot_b", "bot_c"],
        createdAt: "now",
        updatedAt: "now",
      }],
    };
    const cancel = vi.spyOn(groups, "cancelCurrentRun").mockResolvedValue({
      status: "blocked", scope: null, runId: "run_1", reason: "ownership",
    });
    const wrapper = mount(GroupTranscript, { props: { bots: profiles }, global: { plugins: [i18n], stubs: { teleport: true } } });
    await flushPromises();

    await wrapper.get('[data-test="group-dispatch-row"]').trigger("click");
    await wrapper.get('[data-test="group-dispatch-sheet-stop-all"]').trigger("click");
    await flushPromises();

    expect(useConfirmState().value?.title).toBe("Stop all tasks?");
    expect(useConfirmState().value?.message).toBe("Reviewer and the 2 dispatched tasks will stop");
    expect(cancel).not.toHaveBeenCalled();

    settleConfirm(true);
    await flushPromises();
    expect(cancel).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("keeps the desktop card on desktop", async () => {
    setViewportWidth(1280);
    const wrapper = row(["completed", "completed"]);
    await wrapper.get('[data-test="group-dispatch-row"]').trigger("click");
    expect(wrapper.find('[data-test="group-dispatch-card"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="group-dispatch-summary"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="group-dispatch-sheet"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
