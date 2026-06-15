import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import MessageList from "../components/MessageList.vue";
import type { ChatMessage } from "../stores/chat";
import ToolCallPanel from "../components/ToolCallPanel.vue";

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    instanceId: "i1",
    sessionAlias: "s1",
    direction: "out",
    text: "",
    createdAt: "2026-06-13T00:00:00.000Z",
    ...partial,
  };
}

describe("MessageList", () => {
  it("renders agent output as markdown", () => {
    const wrapper = mount(MessageList, {
      props: { messages: [msg({ direction: "out", text: "**bold**" })], streaming: "", liveTurn: null },
    });
    const out = wrapper.find('[data-test="msg-out"]');
    expect(out.html()).toContain("<strong>bold</strong>");
  });

  it("keeps user input as plain text (no markdown rendering)", () => {
    const wrapper = mount(MessageList, {
      props: { messages: [msg({ direction: "in", text: "**not bold**" })], streaming: "", liveTurn: null },
    });
    const inEl = wrapper.find('[data-test="msg-in"]');
    expect(inEl.exists()).toBe(true);
    expect(inEl.html()).not.toContain("<strong>");
    expect(inEl.text()).toContain("**not bold**");
  });

  it("does not render raw HTML from agent output", () => {
    const wrapper = mount(MessageList, {
      props: { messages: [msg({ direction: "out", text: "<script>alert(1)</script>" })], streaming: "", liveTurn: null },
    });
    expect(wrapper.html()).not.toContain("<script>alert(1)</script>");
  });

  it("renders the live streaming bubble as healed markdown", () => {
    const wrapper = mount(MessageList, {
      props: { messages: [], streaming: "answer **important", liveTurn: null },
    });
    const bubble = wrapper.find('[data-test="msg-streaming"]');
    expect(bubble.exists()).toBe(true);
    expect(bubble.html()).toContain("<strong>important</strong>");
  });

  it("marks failed output messages", () => {
    const wrapper = mount(MessageList, {
      props: { messages: [msg({ direction: "out", text: "boom", failed: true })], streaming: "", liveTurn: null },
    });
    expect(wrapper.find('[data-test="msg-failed"]').exists()).toBe(true);
  });

  it("offers a copy button on agent messages and hides jump-latest while pinned", () => {
    const wrapper = mount(MessageList, {
      props: { messages: [msg({ direction: "out", text: "copy me" })], streaming: "", liveTurn: null },
    });
    expect(wrapper.find('[data-test="copy-button"]').exists()).toBe(true);
    // atBottom defaults true → the jump-latest affordance is hidden (v-show).
    const jump = wrapper.find('[data-test="jump-latest"]');
    expect(jump.exists() && jump.isVisible()).toBe(false);
  });
});

it("renders persisted tool steps under a completed out message", () => {
  const wrapper = mount(MessageList, {
    props: {
      messages: [msg({ direction: "out", text: "done", status: "done", structured: { toolSteps: [{ toolCallId: "t1", toolName: "Bash", kind: "execute", status: "success", title: "ls" }] } })],
      streaming: "",
      liveTurn: null,
    },
  });
  expect(wrapper.findComponent(ToolCallPanel).exists()).toBe(true);
});

it("renders a cancelled marker on a stopped message", () => {
  const wrapper = mount(MessageList, {
    props: { messages: [msg({ direction: "out", text: "partial", status: "cancelled" })], streaming: "", liveTurn: null },
  });
  expect(wrapper.find('[data-test="msg-cancelled"]').exists()).toBe(true);
});

it("renders live tool panel above the streaming bubble", () => {
  const wrapper = mount(MessageList, {
    props: {
      messages: [], streaming: "thinking",
      liveTurn: { text: "thinking", toolSteps: [{ toolCallId: "t1", toolName: "R", kind: "read", status: "running", title: "a.ts" }], reasoning: "", status: "streaming", startedAt: 0 },
    },
  });
  expect(wrapper.findComponent(ToolCallPanel).exists()).toBe(true);
});
