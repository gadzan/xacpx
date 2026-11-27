import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { ConversationMessageDto, ConversationTimelineDto } from "@ganglion/xacpx-relay-protocol";
import MessageList from "../components/MessageList.vue";
import ConversationTimeline from "../components/ConversationTimeline.vue";
import { useSplitLayoutStore } from "../stores/split-layout";
import type { ChatMessage } from "../stores/chat";
import type { RoomView } from "../lib/room-view";

vi.mock("../lib/agent-icons", () => ({ agentIconSvg: () => null }));

const NOW = "2026-11-07T00:00:00.000Z";

function chatMsg(text: string): ChatMessage {
  return {
    instanceId: "i1",
    sessionAlias: "s1",
    direction: "out",
    text,
    createdAt: NOW,
  } as ChatMessage;
}

function timelineMessage(seq: number): ConversationMessageDto {
  return {
    id: `m${seq}`,
    conversationId: "c1",
    topicId: "t1",
    seq,
    role: "bot",
    senderBotId: "bot_a",
    content: `message ${seq}`,
    createdAt: NOW,
  } as ConversationMessageDto;
}

function timelineDto(count: number): ConversationTimelineDto {
  const entries = Array.from({ length: count }, (_, i) => ({
    kind: "message" as const,
    key: `message:m${i + 1}`,
    anchorSeq: i + 1,
    message: timelineMessage(i + 1),
  }));
  return { conversationId: "c1", topicId: "t1", entries, hasMoreBefore: false, hasMoreAfter: false } as ConversationTimelineDto;
}

const ROOM: RoomView = {
  conversationId: "c1",
  topicId: "t1",
  participants: [{ botId: "bot_a", name: "Ada", enabled: true }],
};

let now = 1000;
let dateSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  sessionStorage.clear();
  now = 1000;
  dateSpy = vi.spyOn(Date, "now").mockImplementation(() => (now += 200));
});

afterEach(() => {
  dateSpy?.mockRestore();
  dateSpy = null;
  vi.restoreAllMocks();
});

function fakeScrollMetrics(el: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
  (el as unknown as { scrollTo: (opts: { top: number }) => void }).scrollTo = (opts: { top: number }) => {
    el.scrollTop = opts.top;
  };
}

describe("MessageList scrollPaneKey restore", () => {
  it("saves on scroll and restores exact offset when content lands", async () => {
    const first = mount(MessageList, {
      props: { messages: [chatMsg("one"), chatMsg("two")], liveTurn: null, scrollPaneKey: "pane-a" },
    });
    const scroller = first.find('[data-test="msg-scroller"]');
    const el = scroller.element as HTMLElement;
    fakeScrollMetrics(el, 5000, 800);
    el.scrollTop = 1234;
    await scroller.trigger("scroll");
    expect(useSplitLayoutStore().getScroll("pane-a")).toEqual({ scrollTop: 1234, atBottom: false });
    first.unmount();

    const second = mount(MessageList, {
      props: { messages: [], liveTurn: null, scrollPaneKey: "pane-a" },
    });
    const el2 = second.find('[data-test="msg-scroller"]').element as HTMLElement;
    fakeScrollMetrics(el2, 5000, 800);
    expect(el2.scrollTop).toBe(0);
    await second.setProps({ messages: [chatMsg("one"), chatMsg("two")] });
    await second.vm.$nextTick();
    await second.vm.$nextTick();
    expect(el2.scrollTop).toBe(1234);
    second.unmount();
  });

  it("sticks to bottom when the saved record says atBottom", async () => {
    useSplitLayoutStore().saveScroll("pane-bottom", { scrollTop: 0, atBottom: true });
    const wrapper = mount(MessageList, {
      props: { messages: [], liveTurn: null, scrollPaneKey: "pane-bottom" },
    });
    const el = wrapper.find('[data-test="msg-scroller"]').element as HTMLElement;
    fakeScrollMetrics(el, 5000, 800);
    await wrapper.setProps({ messages: [chatMsg("one")] });
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(el.scrollTop).toBe(5000);
    wrapper.unmount();
  });
});

describe("ConversationTimeline scrollPaneKey restore", () => {
  it("saves on scroll and restores exact offset when content lands", async () => {
    const first = mount(ConversationTimeline, {
      props: { room: ROOM, timeline: timelineDto(3), scrollPaneKey: "tl-a" },
    });
    const scroller = first.find('[data-test="conversation-timeline-scroller"]');
    const el = scroller.element as HTMLElement;
    fakeScrollMetrics(el, 4000, 600);
    el.scrollTop = 777;
    await scroller.trigger("scroll");
    expect(useSplitLayoutStore().getScroll("tl-a")).toEqual({ scrollTop: 777, atBottom: false });
    first.unmount();

    const second = mount(ConversationTimeline, {
      props: { room: ROOM, timeline: null, scrollPaneKey: "tl-a" },
    });
    const el2 = second.find('[data-test="conversation-timeline-scroller"]').element as HTMLElement;
    fakeScrollMetrics(el2, 4000, 600);
    await second.setProps({ timeline: timelineDto(3) });
    await second.vm.$nextTick();
    await second.vm.$nextTick();
    expect(el2.scrollTop).toBe(777);
    second.unmount();
  });

  it("sticks to bottom when atBottom or no record", async () => {
    const wrapper = mount(ConversationTimeline, {
      props: { room: ROOM, timeline: null, scrollPaneKey: "tl-fresh" },
    });
    const el = wrapper.find('[data-test="conversation-timeline-scroller"]').element as HTMLElement;
    fakeScrollMetrics(el, 4000, 600);
    await wrapper.setProps({ timeline: timelineDto(2) });
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(el.scrollTop).toBe(4000);
    wrapper.unmount();
  });
});
