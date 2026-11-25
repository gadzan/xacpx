import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { i18n } from "../i18n";
import TimelineRow from "../components/TimelineRow.vue";
import { buildTimelineRows } from "../lib/room-view";

const room = {
  conversationId: "c1",
  topicId: "t1",
  participants: [],
} as never;

function partsRow(withParts: boolean) {
  // Built through the real projection so the row shape matches production.
  const rows = buildTimelineRows({
    entries: [
      {
        kind: "activity",
        key: "activity:turn_1",
        anchorSeq: 1,
        runId: "run_1",
        memberTurnId: "turn_1",
        memberTurn: {
          id: "turn_1",
          runId: "run_1",
          conversationId: "c1",
          topicId: "t1",
          botId: "b1",
          batch: 1,
          memberIndex: 0,
          attempt: 1,
          origin: "human-explicit",
          state: "running",
          createdAt: "now",
        },
      },
    ] as never,
    liveOverlay: [{
      memberTurnId: "turn_1",
      botId: "b1",
      text: "",
      status: "working" as const,
      ...(withParts ? {
        parts: [{
          type: "tool",
          step: {
            toolCallId: "t1",
            toolName: "Bash",
            kind: "execute",
            status: "running",
            title: "npm test",
            detail: { type: "command", command: "npm test", output: "" },
          },
        }],
      } : {}),
    }],
    conversationId: "c1",
    topicId: "t1",
  });
  return rows.find((r) => r.kind === "activity")!;
}

/** Several finished tool steps, so a "latest only" cap is observable. */
function manyPartsRow() {
  const rows = buildTimelineRows({
    entries: [
      {
        kind: "activity",
        key: "activity:turn_1",
        anchorSeq: 1,
        runId: "run_1",
        memberTurnId: "turn_1",
        memberTurn: {
          id: "turn_1", runId: "run_1", conversationId: "c1", topicId: "t1",
          botId: "b1", batch: 1, memberIndex: 0, attempt: 1,
          origin: "human-explicit", state: "running", createdAt: "now",
        },
      },
    ] as never,
    liveOverlay: [{
      memberTurnId: "turn_1",
      botId: "b1",
      text: "",
      status: "working" as const,
      parts: ["a", "b", "c"].map((n) => ({
        type: "tool",
        step: {
          toolCallId: "t" + n,
          toolName: "Bash",
          kind: "execute",
          status: "success",
          title: "step " + n,
          detail: { type: "command", command: "cmd " + n, output: "" },
        },
      })),
    }],
    conversationId: "c1",
    topicId: "t1",
  });
  return rows.find((r) => r.kind === "activity")!;
}

describe("TimelineRow live stack", () => {  it("reports the latest activity above the bubble, not inside it", () => {
    const w = mount(TimelineRow, {
      props: { row: partsRow(true) as never, room },
      global: { plugins: [i18n] },
    });
    const bubble = w.find('[data-test="timeline-live-bubble"]');
    expect(bubble.exists()).toBe(true);
    // The stack is a progress line of its own. Inside the bubble it read as part of a
    // reply that had not been written yet.
    expect(bubble.find('[data-test="trace-live-row"]').exists()).toBe(false);
    expect(w.find('[data-test="trace-live-row"]').exists()).toBe(true);
  });

  it("shows one row, not a scrolling log", () => {
    const w = mount(TimelineRow, {
      props: { row: manyPartsRow() as never, room },
      global: { plugins: [i18n] },
    });
    // Only the newest activity: the reply is what the reader waits for, and a log
    // above it competes with that.
    expect(w.findAll('[data-test="trace-live-row"]').length).toBe(1);
  });

  it("shows only the working indicator when the turn has no parts yet", () => {
    const w = mount(TimelineRow, {
      props: { row: partsRow(false) as never, room },
      global: { plugins: [i18n] },
    });
    expect(w.find('[data-test="trace-live-row"]').exists()).toBe(false);
  });
});
