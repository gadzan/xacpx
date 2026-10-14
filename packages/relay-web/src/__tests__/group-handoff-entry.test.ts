import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type {
  BotSummaryDto,
  ConversationMessageDto,
  ConversationRunDetailDto,
  MemberTurnSummaryDto,
} from "@ganglion/xacpx-relay-protocol";
import GroupTranscript from "../components/GroupTranscript.vue";
import { useGroupsStore } from "../stores/groups";
import { useInstancesStore } from "../stores/instances";
import { i18n } from "../i18n";

const bots: BotSummaryDto[] = [
  { id: "bot_a", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
  { id: "bot_b", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" },
];
const unmounts: (() => void)[] = [];

function handoff(index = 1): ConversationMessageDto {
  return {
    id: `handoff_${index}`, conversationId: "group_1", topicId: "topic_1", runId: "run_1",
    seq: index * 2, role: "system", senderBotId: "bot_a", content: "Public handoff", createdAt: "now",
    handoff: { senderMemberTurnId: "turn_a", to: "bot_b", memberTurnId: `turn_b_${index}`,
      assignmentId: `assignment_${index}`, task: `Review assignment ${index}`, expectedOutput: `Findings ${index}` },
  };
}
function member(index = 1, overrides: Partial<MemberTurnSummaryDto> = {}): MemberTurnSummaryDto {
  return {
    id: `turn_b_${index}`, conversationId: "group_1", topicId: "topic_1", runId: "run_1", botId: "bot_b",
    batch: 1, attempt: 1, origin: "handoff", state: "completed", createdAt: "now",
    assignmentId: `assignment_${index}`, promptRequestId: `prompt_${index}`, ...overrides,
  };
}
function reply(index = 1, overrides: Partial<ConversationMessageDto> = {}): ConversationMessageDto {
  return {
    id: `reply_${index}`, conversationId: "group_1", topicId: "topic_1", runId: "run_1",
    seq: index * 2 + 1, role: "bot", senderBotId: "bot_b", promptRequestId: `prompt_${index}`,
    content: `Assignment ${index} canonical findings`, createdAt: "now", ...overrides,
  };
}
function runDetail(turns = [member()]): ConversationRunDetailDto {
  return {
    id: "run_1", conversationId: "group_1", topicId: "topic_1", requestMessageId: "request_message",
    requestId: "request", mode: "explicit", state: "completed", profileRevision: 1, createdAt: "now",
    memberTurns: turns,
  };
}
function render(messages = [handoff()], turns = [member()], profiles = bots) {
  const groups = useGroupsStore();
  groups.instanceId = "instance_1";
  groups.selectedGroupId = groups.activeConversationId = "group_1";
  groups.activeTopicId = "topic_1";
  groups.topicReady = true;
  groups.messages = messages;
  groups.memberTurnsById = Object.fromEntries(turns.map((turn) => [turn.id, turn]));
  const load = vi.spyOn(groups, "loadHandoffRunDetail").mockResolvedValue(null);
  const wrapper = mount(GroupTranscript, { props: { bots: profiles }, attachTo: document.body,
    global: { plugins: [i18n] } });
  unmounts.push(() => wrapper.unmount());
  return { wrapper, groups, load };
}

beforeEach(() => {
  setActivePinia(createPinia());
  i18n.global.locale.value = "en";
  useInstancesStore().instances = [{ id: "instance_1", agents: [{ name: "codex", driver: "codex" }] } as never];
});
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
  i18n.global.locale.value = "en";
  vi.restoreAllMocks();
});

describe("Public Group handoff entries", () => {
  it("does not introduce communication entries into ordinary Group messages", () => {
    const { wrapper } = render([reply()]);
    expect(wrapper.get('[data-message-id="reply_1"]').text()).toContain("Assignment 1 canonical findings");
    expect(wrapper.findAll('[data-test="group-handoff"]')).toHaveLength(0);
  });

  it("starts with two avatars and no visible text or extra row avatar, leaving normal rows intact", async () => {
    const { wrapper } = render([handoff(), reply()]);
    const entry = wrapper.get('[data-message-id="handoff_1"]');
    expect(entry.findAll("[data-handoff-avatar]")).toHaveLength(2);
    expect(entry.find('[data-avatar-key="row"]').exists()).toBe(false);
    expect(wrapper.get('[data-message-id="reply_1"]').text()).toContain("Assignment 1 canonical findings");
    expect(wrapper.get('[data-message-id="reply_1"]').find('[data-avatar-key="row"]').exists()).toBe(true);
    const trigger = entry.get('[data-test="group-handoff-toggle"]');
    expect(trigger.element.tagName).toBe("BUTTON");
    expect(trigger.attributes("aria-expanded")).toBe("false");
    await trigger.trigger("click");
    expect(entry.get('[data-test="group-handoff-details"]').attributes("id")).toBe(trigger.attributes("aria-controls"));
    expect(trigger.attributes("aria-expanded")).toBe("true");
    expect(entry.text()).toContain("Review assignment 1");
    expect(entry.text()).toContain("Findings 1");
  });

  it("omits absent expected output while preserving access to the durable task", async () => {
    const message = handoff();
    delete message.handoff!.expectedOutput;
    const { wrapper } = render([message]);
    await wrapper.get('[data-test="group-handoff-toggle"]').trigger("click");
    expect(wrapper.get('[data-test="group-handoff-details"]').findAll("dd").map((value) => value.text()))
      .toEqual(["Reviewer", "Tester", "Review assignment 1", "Completed"]);
  });

  it.each([
    ["en", "Communication: Reviewer to Tester", "Outcome unknown"],
    ["zh-CN", "通信：Reviewer 发给 Tester", "结果未知"],
  ] as const)("localizes accessible names and unknown outcomes in %s", async (locale, label, state) => {
    i18n.global.locale.value = locale;
    const { wrapper } = render([handoff()], [member(1, { state: "indeterminate" })]);
    const trigger = wrapper.get('[data-test="group-handoff-toggle"]');
    expect(trigger.attributes("aria-label")).toBe(label);
    await trigger.trigger("click");
    expect(wrapper.get('[data-test="group-handoff-state"]').text()).toBe(state);
    expect(wrapper.get('[data-test="group-handoff-result-unavailable"]').text()).toBe(locale === "en" ? "Result not available" : "结果不可用");
  });

  it("keeps each same-bot assignment paired with its own canonical result regardless of reply order", async () => {
    const { wrapper } = render([handoff(), handoff(2), reply(2), reply()], [member(), member(2)]);
    const entries = wrapper.findAll('[data-test="group-handoff"]');
    for (const entry of entries) await entry.get("button").trigger("click");
    expect(entries[0]!.get('[data-test="group-handoff-result"]').text()).toContain("Assignment 1 canonical findings");
    expect(entries[1]!.get('[data-test="group-handoff-result"]').text()).toContain("Assignment 2 canonical findings");
    expect(entries[0]!.get('[data-test="group-handoff-result"]').text()).not.toContain("Assignment 2 canonical findings");
    expect(entries[1]!.get('[data-test="group-handoff-result"]').text()).not.toContain("Assignment 1 canonical findings");
  });

  it.each([
    { id: "another_turn" }, { conversationId: "other_group" }, { topicId: "other_topic" },
    { runId: "other_run" }, { botId: "bot_a" }, { assignmentId: "other_assignment" },
  ])("rejects conflicting MemberTurn identity %j and reacts to exact live evidence", async (mismatch) => {
    const { wrapper, groups } = render([handoff(), reply()], [member(1, mismatch)]);
    await wrapper.get('[data-test="group-handoff-toggle"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-test="group-handoff-availability"]').text()).toBe("Details not available");
    expect(wrapper.get('[data-test="group-handoff-result-unavailable"]').text()).toBe("Result not available");
    groups.memberTurnsById = { turn_b_1: member() };
    await flushPromises();
    expect(wrapper.get('[data-test="group-handoff-result"]').text()).toContain("Assignment 1 canonical findings");
  });

  it.each([
    { conversationId: "other_group" }, { topicId: "other_topic" }, { runId: "other_run" },
    { senderBotId: "bot_a" }, { promptRequestId: "prompt_2" }, { seq: 1 },
    { role: "human" as const }, { content: " \n " }, { handoff: handoff(2).handoff },
  ])("does not substitute a reply with conflicting evidence %j", async (mismatch) => {
    const { wrapper, groups } = render([handoff(), reply(1, mismatch)]);
    await wrapper.get('[data-test="group-handoff-toggle"]').trigger("click");
    expect(wrapper.get('[data-test="group-handoff-result-unavailable"]').text()).toBe("Result not available");
    groups.messages = [handoff(), reply()];
    await flushPromises();
    expect(wrapper.get('[data-test="group-handoff-result"]').text()).toContain("Assignment 1 canonical findings");
  });

  it("requires prompt identity, rejects conflicting canonical replies, and accepts nonconflicting absent assignment", async () => {
    const { wrapper, groups } = render([handoff(), reply()], [member(1, { promptRequestId: undefined })]);
    await wrapper.get('[data-test="group-handoff-toggle"]').trigger("click");
    expect(wrapper.get('[data-test="group-handoff-result-unavailable"]').text()).toBe("Result not available");
    groups.memberTurnsById = { turn_b_1: member(1, { assignmentId: undefined }) };
    groups.messages.push(reply(1, { id: "conflicting_reply", seq: 6, content: "Contradictory findings" }));
    await flushPromises();
    expect(wrapper.get('[data-test="group-handoff-result-unavailable"]').text()).toBe("Result not available");
    groups.messages = [handoff(), reply()];
    await flushPromises();
    expect(wrapper.get('[data-test="group-handoff-result"]').text()).toContain("Assignment 1 canonical findings");
  });

  it.each([
    ["queued", "Queued"], ["dispatched", "Dispatched"], ["running", "Running"],
    ["completed", "Completed"], ["failed", "Failed"], ["cancelled", "Cancelled"],
    ["indeterminate", "Outcome unknown"],
  ] as const)("shows durable %s state without inventing a missing historical reply", async (state, label) => {
    const { wrapper } = render([handoff()], [member(1, { state })]);
    await wrapper.get('[data-test="group-handoff-toggle"]').trigger("click");
    expect(wrapper.get('[data-test="group-handoff-state"]').attributes("data-state")).toBe(state);
    expect(wrapper.get('[data-test="group-handoff-state"]').text()).toBe(label);
    expect(wrapper.get('[data-test="group-handoff-result-unavailable"]').text()).toBe("Result not available");
  });

  it("loads historical state without fabricating an unloaded result and then prefers reactive live evidence", async () => {
    const { wrapper, groups, load } = render([handoff(), reply(2)], []);
    const pending = Promise.withResolvers<ConversationRunDetailDto | null>();
    load.mockReturnValue(pending.promise);
    await wrapper.get('[data-test="group-handoff-toggle"]').trigger("click");
    expect(wrapper.get('[data-test="group-handoff-availability"]').text()).toBe("Loading communication details...");
    pending.resolve(runDetail());
    await flushPromises();
    expect(wrapper.get('[data-test="group-handoff-state"]').text()).toBe("Completed");
    expect(wrapper.get('[data-test="group-handoff-result-unavailable"]').text()).toBe("Result not available");
    groups.memberTurnsById = { turn_b_1: member(1, { state: "running", promptRequestId: "prompt_2" }) };
    await flushPromises();
    expect(wrapper.get('[data-test="group-handoff-state"]').text()).toBe("Running");
    expect(wrapper.get('[data-test="group-handoff-result"]').text()).toContain("Assignment 2 canonical findings");
  });

  it.each([
    { conversationId: "other_group" }, { topicId: "other_topic" }, { id: "other_run" },
    { memberTurns: [member(1, { botId: "bot_a" })] },
    { memberTurns: [member(), member(1, { promptRequestId: "conflicting_prompt" })] },
  ])("does not trust conflicting fetched detail %j", async (mismatch) => {
    const { wrapper, load } = render([handoff(), reply()], []);
    load.mockResolvedValue({ ...runDetail(), ...mismatch });
    await wrapper.get('[data-test="group-handoff-toggle"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-test="group-handoff-availability"]').text()).toBe("Details not available");
    expect(wrapper.get('[data-test="group-handoff-result-unavailable"]').text()).toBe("Result not available");
  });

  it("leaves the durable task accessible after a failed detail RPC", async () => {
    const { wrapper, load } = render([handoff(), reply()], []);
    load.mockRejectedValue(new Error("offline"));
    await wrapper.get('[data-test="group-handoff-toggle"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-test="group-handoff-details"]').text()).toContain("Review assignment 1");
    expect(wrapper.get('[data-test="group-handoff-availability"]').text()).toBe("Details not available");
    expect(wrapper.get('[data-test="group-handoff-result-unavailable"]').text()).toBe("Result not available");
    await wrapper.get('[data-test="group-handoff-collapse"]').trigger("click");
    expect(wrapper.get('[data-test="group-handoff-toggle"]').attributes("aria-expanded")).toBe("false");
    load.mockResolvedValue(runDetail());
    await wrapper.get('[data-test="group-handoff-toggle"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-test="group-handoff-result"]').text()).toContain("Assignment 1 canonical findings");
  });

  it.each(["instanceId", "selectedGroupId", "activeConversationId", "activeTopicId"] as const)("discards stale requests and expansion across an ABA change to %s", async (field) => {
    const { wrapper, groups, load } = render([handoff(), reply()], []);
    const pending = Promise.withResolvers<ConversationRunDetailDto | null>();
    load.mockReturnValue(pending.promise);
    await wrapper.get('[data-test="group-handoff-toggle"]').trigger("click");
    const original = groups[field];
    groups[field] = "elsewhere";
    groups[field] = original;
    pending.resolve(runDetail());
    await flushPromises();
    expect(wrapper.get('[data-test="group-handoff-toggle"]').attributes("aria-expanded")).toBe("false");
    load.mockResolvedValue(null);
    await wrapper.get('[data-test="group-handoff-toggle"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-test="group-handoff-availability"]').text()).toBe("Details not available");
    expect(wrapper.get('[data-test="group-handoff-result-unavailable"]').text()).toBe("Result not available");
  });

  it("reloads invalidated historical detail and ignores an older in-flight response", async () => {
    const { wrapper, groups, load } = render([handoff()], []);
    const pending = Promise.withResolvers<ConversationRunDetailDto | null>();
    load.mockReturnValueOnce(pending.promise).mockResolvedValue(runDetail([member(1, { state: "cancelled" })]));
    await wrapper.get('[data-test="group-handoff-toggle"]').trigger("click");
    groups.handoffDetailRevision++;
    await flushPromises();
    expect(wrapper.get('[data-test="group-handoff-state"]').text()).toBe("Cancelled");
    pending.resolve(runDetail());
    await flushPromises();
    expect(wrapper.get('[data-test="group-handoff-state"]').text()).toBe("Cancelled");
  });

  it("restores trigger focus on collapse and Escape without moving the transcript", async () => {
    const { wrapper } = render();
    await flushPromises();
    const scroller = wrapper.get('[data-test="group-transcript-scroller"]').element as HTMLElement;
    scroller.scrollTop = 137;
    const trigger = wrapper.get('[data-test="group-handoff-toggle"]');
    await trigger.trigger("click");
    await wrapper.get('[data-test="group-handoff-collapse"]').trigger("click");
    expect(document.activeElement).toBe(trigger.element);
    expect(scroller.scrollTop).toBe(137);
    await trigger.trigger("click");
    const close = wrapper.get('[data-test="group-handoff-collapse"]');
    (close.element as HTMLButtonElement).focus();
    await close.trigger("keydown", { key: "Escape" });
    expect(document.activeElement).toBe(trigger.element);
    expect(trigger.attributes("aria-expanded")).toBe("false");
    expect(scroller.scrollTop).toBe(137);
  });

  it("preserves the open message anchor through prepend and replay", async () => {
    const { wrapper, groups } = render([handoff(), reply()]);
    await wrapper.get('[data-test="group-handoff-toggle"]').trigger("click");
    groups.messages = [reply(9, { id: "older", seq: 1 }), ...groups.messages.map((message) => ({ ...message }))];
    groups.applyEvent({ kind: "control-event", instanceId: "instance_1", event: { type: "conversation-message", message: handoff() } } as never);
    await flushPromises();
    const anchor = wrapper.get('[data-message-id="handoff_1"]');
    expect(anchor.attributes("data-row-id")).toBe("handoff_1");
    expect(anchor.get('[data-test="group-handoff-toggle"]').attributes("aria-expanded")).toBe("true");
    expect(anchor.get('[data-test="group-handoff-result"]').text()).toContain("Assignment 1 canonical findings");
    expect(wrapper.findAll('[data-test="group-handoff"]')).toHaveLength(1);
  });

  it("keeps retired and unavailable Bots identifiable without fetching avatar URLs", async () => {
    const { wrapper } = render([handoff()], [member()], [{ ...bots[0]!, retired: true }]);
    expect(wrapper.get('[data-test="group-handoff-toggle"]').attributes("aria-label")).toContain("bot_b");
    await wrapper.get('[data-test="group-handoff-toggle"]').trigger("click");
    expect(wrapper.get('[data-test="group-handoff-details"]').text()).toContain("Reviewer");
    expect(wrapper.get('[data-test="group-handoff-details"]').text()).toContain("bot_b");
    expect(wrapper.findAll("img")).toHaveLength(0);
  });

  it("renders untrusted task, expected output and result as text and bounds the preview with a canonical jump", async () => {
    const message = handoff();
    message.handoff!.task = '<img src=x onerror="alert(1)">';
    message.handoff!.expectedOutput = "<script>alert(2)</script>";
    const content = '<svg onload="alert(3)">' + "x".repeat(400);
    const { wrapper } = render([message, reply(1, { content })]);
    await wrapper.get('[data-test="group-handoff-toggle"]').trigger("click");
    const details = wrapper.get('[data-test="group-handoff-details"]');
    expect(details.text()).toContain('<img src=x onerror="alert(1)">');
    expect(details.text()).toContain("<script>alert(2)</script>");
    expect(details.find("img, script, svg[onload]").exists()).toBe(false);
    expect(details.get('[data-test="group-handoff-result"] p.whitespace-pre-wrap').text()).toBe(content.slice(0, 240) + "…");
    await flushPromises();
    const scroller = wrapper.get('[data-test="group-transcript-scroller"]').element as HTMLElement;
    const canonical = wrapper.get('[data-message-id="reply_1"]').element as HTMLElement;
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({ top: 10 } as DOMRect);
    vi.spyOn(canonical, "getBoundingClientRect").mockReturnValue({ top: 210 } as DOMRect);
    scroller.scrollTop = 25;
    await details.get('[data-test="group-handoff-jump"]').trigger("click");
    expect(scroller.scrollTop).toBe(225);
  });
});
