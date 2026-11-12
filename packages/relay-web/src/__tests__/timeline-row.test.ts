import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import type { ConversationMessageDto } from "@ganglion/xacpx-relay-protocol";
import TimelineRow from "../components/TimelineRow.vue";
import { i18n } from "../i18n";
import type { RoomView, TimelineRow as TimelineRowModel } from "../lib/room-view";

const NOW = "2026-11-12T00:00:00.000Z";
const CONVERSATION = "conversation_1";
const TOPIC = "topic_1";

const ROOM: RoomView = {
  conversationId: CONVERSATION,
  topicId: TOPIC,
  participants: [{ botId: "bot_a", name: "Ada", role: "Lead", enabled: true }],
};

function message(role: "human" | "bot", seq: number): ConversationMessageDto {
  return {
    id: `message_${seq}`,
    conversationId: CONVERSATION,
    topicId: TOPIC,
    seq,
    role,
    content: `row ${seq}`,
    createdAt: NOW,
    ...(role === "bot" ? { senderBotId: "bot_a" } : {}),
  };
}

function rowOf(source: ConversationMessageDto): TimelineRowModel {
  return {
    kind: "message",
    key: `message:${source.id}`,
    anchorSeq: source.seq,
    entry: { kind: "message", key: `message:${source.id}`, anchorSeq: source.seq, message: source },
  };
}

/**
 * The per-row fork control is a capability surface: it exists only when the
 * parent hands a callback. Everything else about the row is unchanged, so the
 * gating test mounts the same row twice and compares the operations slot.
 */
function mountRow(source: ConversationMessageDto, forkMessage?: (messageId: string) => void) {
  return mount(TimelineRow, {
    props: {
      row: rowOf(source),
      room: ROOM,
      ...(forkMessage ? { forkMessage } : {}),
    },
    global: { plugins: [i18n] },
  });
}

describe("TimelineRow fork control", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("renders no fork control without a callback", () => {
    for (const role of ["human", "bot"] as const) {
      const wrapper = mountRow(message(role, role === "human" ? 1 : 2));
      expect(wrapper.find('[data-test="timeline-fork-message"]').exists()).toBe(false);
      // The copy action is the baseline operation: the slot still renders.
      expect(wrapper.find('[data-test="copy-button"]').exists()).toBe(true);
      wrapper.unmount();
    }
  });

  it("hands the row's own message id to the callback", async () => {
    for (const role of ["human", "bot"] as const) {
      const forkMessage = vi.fn();
      const source = message(role, role === "human" ? 1 : 2);
      const wrapper = mountRow(source, forkMessage);
      const control = wrapper.find('[data-test="timeline-fork-message"]');
      expect(control.exists()).toBe(true);
      expect(control.attributes("aria-label")).toBe("Fork from this message");
      await control.trigger("click");
      expect(forkMessage).toHaveBeenCalledWith(source.id);
      wrapper.unmount();
    }
  });
});
