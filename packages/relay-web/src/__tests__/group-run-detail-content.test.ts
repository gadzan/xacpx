import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import type { ConversationRunDto, MemberTurnSummaryDto } from "@ganglion/xacpx-relay-protocol";
import GroupRunDetailContent from "../components/GroupRunDetailContent.vue";

function turnOf(overrides: Partial<MemberTurnSummaryDto> = {}): MemberTurnSummaryDto {
  return {
    id: "turn_a", runId: "run_1", conversationId: "conversation_g", topicId: "topic_1",
    botId: "bot_a", batch: 1, memberIndex: 0, attempt: 1, origin: "human-explicit",
    state: "running", createdAt: "2026-09-01T00:00:00.000Z",
    startedAt: "2026-09-01T00:00:01.000Z", assignmentId: "step-1", task: "Review",
    expectedOutput: "A reviewed patch",
    ...overrides,
  };
}

function runOf(overrides: Partial<ConversationRunDto> = {}): ConversationRunDto {
  return {
    id: "run_1", conversationId: "conversation_g", topicId: "topic_1",
    requestMessageId: "msg_1", requestId: "req_1", mode: "explicit", state: "running",
    profileRevision: 1, createdAt: "2026-09-01T00:00:00.000Z", startedAt: "2026-09-01T00:00:01.000Z",
    ...overrides,
  };
}

describe("GroupRunDetailContent", () => {
  it("renders the identity explanation and hides trace/stop", () => {
    const wrapper = mount(GroupRunDetailContent, {
      props: {
        run: runOf(),
        memberTurn: turnOf(),
        memberName: "Reviewer",
        attempt: 1,
        attempts: [1, 2],
        explanation: "This reply could not be linked to exactly one member turn, so no process is attached.",
      },
    });
    expect(wrapper.find('[data-test="group-detail-explanation"]').text()).toContain("could not be linked");
    expect(wrapper.find('[data-test="group-trace-status"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="group-stop-run-button"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("renders exactly one explanation and one duration in the content", () => {
    const wrapper = mount(GroupRunDetailContent, {
      props: {
        run: runOf({ state: "completed", finishedAt: "2026-09-01T00:01:01.000Z" }),
        explanation: "This reply could not be linked to exactly one member turn, so no process is attached.",
      },
    });
    const el = wrapper.find('[data-test="group-run-detail"]').element as HTMLElement;
    expect(el.querySelectorAll('[data-test="group-detail-explanation"]')).toHaveLength(1);
    expect(el.querySelectorAll('[data-test="group-detail-duration"]')).toHaveLength(1);
    wrapper.unmount();
  });

  it("confirms a cancelled run at the top of the detail", () => {
    const wrapper = mount(GroupRunDetailContent, {
      props: {
        run: runOf({ state: "cancelled" }),
        memberTurn: turnOf({ state: "cancelled" }),
        memberName: "Reviewer",
        attempt: 1,
        attempts: [1],
      },
    });
    const detail = wrapper.find('[data-test="group-run-detail"]').element as HTMLElement;
    const note = detail.querySelector<HTMLElement>('[data-test="group-detail-stopped"]');
    expect(note?.textContent).toContain("Run stopped");
    wrapper.unmount();
  });
});
