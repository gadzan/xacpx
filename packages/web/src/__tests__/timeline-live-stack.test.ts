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

describe("TimelineRow live stack", () => {
  it("reports what the Bot is doing inside its live bubble", () => {
    const w = mount(TimelineRow, {
      props: { row: partsRow(true) as never, room },
      global: { plugins: [i18n] },
    });
    const bubble = w.find('[data-test="timeline-live-bubble"]');
    expect(bubble.exists()).toBe(true);
    // Without the turn's parts the bubble showed only a working indicator, so a Bot
    // running tools looked idle for the whole turn.
    expect(bubble.find('[data-test="trace-live-row"]').exists()).toBe(true);
  });

  it("shows only the working indicator when the turn has no parts yet", () => {
    const w = mount(TimelineRow, {
      props: { row: partsRow(false) as never, room },
      global: { plugins: [i18n] },
    });
    expect(w.find('[data-test="trace-live-row"]').exists()).toBe(false);
  });
});
