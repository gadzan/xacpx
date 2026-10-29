import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { ConversationMessageDto, MemberTurnSummaryDto } from "@ganglion/xacpx-relay-protocol";
import GroupAgentTurnRow from "../components/GroupAgentTurnRow.vue";
import { i18n } from "../i18n";

beforeEach(() => {
  setActivePinia(createPinia());
  i18n.global.locale.value = "zh-CN";
});

const turn = (over: Partial<MemberTurnSummaryDto> = {}): MemberTurnSummaryDto => ({
  id: "turn_b",
  runId: "run_1",
  conversationId: "conversation_g",
  topicId: "topic_1",
  botId: "bot_b",
  batch: 1,
  attempt: 1,
  origin: "handoff",
  state: "completed",
  createdAt: "now",
  ...over,
});

const message = (over: Partial<ConversationMessageDto> = {}): ConversationMessageDto => ({
  id: "msg_b",
  conversationId: "conversation_g",
  topicId: "topic_1",
  seq: 3,
  role: "bot",
  senderBotId: "bot_b",
  content: "70 lines of process narrative",
  runId: "run_1",
  createdAt: "now",
  ...over,
});

function mountRow(props: Record<string, unknown>) {
  return mount(GroupAgentTurnRow, {
    props: { memberTurn: turn(), name: "Builder", ...props },
    global: { plugins: [i18n], stubs: { teleport: true } },
  });
}

describe("GroupAgentTurnRow timeline projection", () => {
  it("renders the timeline projection instead of the raw process text", () => {
    const wrapper = mountRow({
      message: message({ timelineContent: "结论：目标已达成 — 过滤已完成。" }),
      memberTurn: turn({ finalReportVerdict: "achieved" }),
    });
    expect(wrapper.text()).toContain("结论：目标已达成");
    expect(wrapper.text()).not.toContain("70 lines of process narrative");
    expect(wrapper.attributes("data-final-verdict") ?? wrapper.find("[data-final-verdict]").attributes("data-final-verdict")).toBe("achieved");
  });

  it("folds an intermediate conclusion behind a verdict summary and keeps the final answer expanded", () => {
    const folded = mountRow({
      message: message({ timelineContent: "结论：目标已达成 — 中间结论。" }),
      memberTurn: turn({ finalReportVerdict: "achieved" }),
      collapsed: true,
    });
    expect(folded.find("[data-test='group-intermediate-conclusion']").exists()).toBe(true);
    expect(folded.text()).toContain("中间结论");
    expect(folded.text()).toContain("目标已达成");
    const expanded = mountRow({
      message: message({ timelineContent: "结论：目标已达成 — 最终答案。" }),
      memberTurn: turn({ finalReportVerdict: "achieved" }),
      collapsed: false,
    });
    expect(expanded.find("[data-test='group-intermediate-conclusion']").exists()).toBe(false);
    expect(expanded.text()).toContain("最终答案");
  });

  it("falls back to raw content when no projection was derived", () => {
    const wrapper = mountRow({ message: message(), memberTurn: turn() });
    expect(wrapper.text()).toContain("70 lines of process narrative");
  });
});
