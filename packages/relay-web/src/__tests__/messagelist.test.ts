import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import MessageList from "../components/MessageList.vue";
import type { ChatMessage, LiveTurn } from "../stores/chat";
import ToolCallPanel from "../components/ToolCallPanel.vue";
import ToolStepCard from "../components/ToolStepCard.vue";

// StreamMarkdown (rendered for "out" messages) reads useThemeStore() to re-hydrate mermaid
// diagrams on theme change, so every mount here needs an active Pinia instance.
beforeEach(() => {
  setActivePinia(createPinia());
});

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
function live(parts: LiveTurn["parts"]): LiveTurn {
  return { parts, status: "streaming", startedAt: 0 };
}

describe("MessageList", () => {
  it("shows agent text immediately while keeping inline tool details collapsed by default", () => {
    const wrapper = mount(MessageList, {
      props: {
        messages: [msg({
          direction: "out",
          text: "**finished**",
          structured: {
            parts: [
              {
                type: "tool",
                step: {
                  toolCallId: "t1",
                  toolName: "Bash",
                  kind: "execute",
                  status: "success",
                  title: "npm test",
                  detail: { type: "command", command: "npm test", output: "passed" },
                },
              },
              { type: "text", text: "**finished**" },
            ],
          },
        })],
        liveTurn: null,
      },
    });

    expect(wrapper.find('[data-test="msg-content"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="msg-out"]').html()).toContain("<strong>finished</strong>");
    expect(wrapper.findComponent(ToolStepCard).exists()).toBe(true);
    expect(wrapper.find('[data-test="cmd-output"]').exists()).toBe(false);
  });

  it("renders agent output as markdown without a message-level expand step", () => {
    const wrapper = mount(MessageList, {
      props: { messages: [msg({ direction: "out", text: "**bold**" })], liveTurn: null },
    });
    const out = wrapper.find('[data-test="msg-out"]');
    expect(out.find('[data-test="msg-content"]').exists()).toBe(true);
    expect(out.find('[data-test="msg-toggle"]').exists()).toBe(false);
    expect(out.html()).toContain("<strong>bold</strong>");
  });

  it("keeps user input as plain text (no markdown rendering)", () => {
    const wrapper = mount(MessageList, {
      props: { messages: [msg({ direction: "in", text: "**not bold**" })], liveTurn: null },
    });
    const inEl = wrapper.find('[data-test="msg-in"]');
    expect(inEl.exists()).toBe(true);
    expect(inEl.html()).not.toContain("<strong>");
    expect(inEl.text()).toContain("**not bold**");
  });

  it("badges an inbound prompt from a fired scheduled task (live origin)", () => {
    const wrapper = mount(MessageList, {
      props: { messages: [msg({ direction: "in", text: "summarize commits", scheduled: { taskId: "ab12", executeAt: "2026-06-16T09:00:00.000Z" } })], liveTurn: null },
    });
    expect(wrapper.find('[data-test="msg-scheduled-badge"]').exists()).toBe(true);
    expect(wrapper.find('[data-scheduled-task="ab12"]').exists()).toBe(true);
  });

  it("badges a persisted scheduled prompt from history (structured.scheduled)", () => {
    const wrapper = mount(MessageList, {
      props: { messages: [msg({ direction: "in", text: "ran", structured: { scheduled: { taskId: "cd34", executeAt: "2026-06-16T09:00:00.000Z" } } })], liveTurn: null },
    });
    expect(wrapper.find('[data-test="msg-scheduled-badge"]').exists()).toBe(true);
    expect(wrapper.find('[data-scheduled-task="cd34"]').exists()).toBe(true);
  });

  it("a normal user message carries no schedule badge", () => {
    const wrapper = mount(MessageList, {
      props: { messages: [msg({ direction: "in", text: "hi there" })], liveTurn: null },
    });
    expect(wrapper.find('[data-test="msg-scheduled-badge"]').exists()).toBe(false);
  });

  it("does not render raw HTML from agent output", () => {
    const wrapper = mount(MessageList, {
      props: { messages: [msg({ direction: "out", text: "<script>alert(1)</script>" })], liveTurn: null },
    });
    expect(wrapper.html()).not.toContain("<script>alert(1)</script>");
  });

  it("renders the live streaming bubble as healed markdown", () => {
    const wrapper = mount(MessageList, {
      props: { messages: [], liveTurn: live([{ type: "text", text: "answer **important" }]) },
    });
    const bubble = wrapper.find('[data-test="msg-streaming"]');
    expect(bubble.exists()).toBe(true);
    expect(bubble.html()).toContain("<strong>important</strong>");
  });

  it("marks failed output messages", () => {
    const wrapper = mount(MessageList, {
      props: { messages: [msg({ direction: "out", text: "boom", failed: true })], liveTurn: null },
    });
    expect(wrapper.find('[data-test="msg-failed"]').exists()).toBe(true);
  });

  it("offers a copy button on agent messages and hides jump-latest while pinned", () => {
    const wrapper = mount(MessageList, {
      props: { messages: [msg({ direction: "out", text: "copy me" })], liveTurn: null },
    });
    expect(wrapper.find('[data-test="copy-button"]').exists()).toBe(true);
    // atBottom defaults true → the jump-latest affordance is hidden (v-show).
    const jump = wrapper.find('[data-test="jump-latest"]');
    expect(jump.exists() && jump.isVisible()).toBe(false);
  });

  it("puts copy + time in a dedicated action row at the bottom of the record", () => {
    const wrapper = mount(MessageList, {
      props: { messages: [msg({ direction: "out", text: "hi", createdAt: "2026-06-13T08:30:00.000Z" })], liveTurn: null },
    });
    const actions = wrapper.find('[data-test="msg-actions"]');
    expect(actions.exists()).toBe(true);
    expect(actions.find('[data-test="copy-button"]').exists()).toBe(true);
    expect(actions.find('[data-test="msg-time"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="msg-out"]').element.lastElementChild?.getAttribute("data-test")).toBe("msg-actions");
  });

  it("shows a history skeleton while the initial page loads, then swaps in the transcript", async () => {
    const wrapper = mount(MessageList, {
      props: { messages: [], liveTurn: null, loadingHistory: true },
    });
    const skeleton = wrapper.find('[data-test="history-skeleton"]');
    expect(skeleton.exists()).toBe(true);
    expect(skeleton.attributes("aria-hidden")).toBe("true");
    expect(wrapper.find('[data-test="msg-out"]').exists()).toBe(false);

    await wrapper.setProps({ messages: [msg({ direction: "out", text: "hi" })], loadingHistory: false });
    expect(wrapper.find('[data-test="history-skeleton"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="msg-out"]').exists()).toBe(true);
  });

  it("keeps the skeleton hidden once messages exist, even if a reload is in flight", () => {
    const wrapper = mount(MessageList, {
      props: { messages: [msg({ direction: "in", text: "hey" })], liveTurn: null, loadingHistory: true },
    });
    expect(wrapper.find('[data-test="history-skeleton"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="msg-in"]').exists()).toBe(true);
  });

  it("prefers live streaming content over the skeleton", () => {
    const wrapper = mount(MessageList, {
      props: { messages: [], liveTurn: live([{ type: "text", text: "working" }]), loadingHistory: true },
    });
    expect(wrapper.find('[data-test="history-skeleton"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="msg-streaming"]').exists()).toBe(true);
  });
});

it("renders legacy persisted tool steps (no parts) in a collapsed panel", () => {
  const wrapper = mount(MessageList, {
    props: {
      messages: [msg({ direction: "out", text: "done", status: "done", structured: { toolSteps: [{ toolCallId: "t1", toolName: "Bash", kind: "execute", status: "success", title: "ls" }] } })],
      liveTurn: null,
    },
  });
  // Legacy rows (no `parts`) fall back to the aggregated panel.
  expect(wrapper.findComponent(ToolCallPanel).exists()).toBe(true);
  expect(wrapper.find('[data-test="tool-row"]').exists()).toBe(false);
});

it("renders persisted `parts` inline in arrival order (tool then text)", () => {
  const wrapper = mount(MessageList, {
    props: {
      messages: [msg({
        direction: "out", text: "all done", status: "done",
        structured: {
          toolSteps: [{ toolCallId: "t1", toolName: "Bash", kind: "execute", status: "success", title: "ls" }],
          parts: [
            { type: "tool", step: { toolCallId: "t1", toolName: "Bash", kind: "execute", status: "success", title: "ls" } },
            { type: "text", text: "all done" },
          ],
        },
      })],
      liveTurn: null,
    },
  });
  // Inline cards, not the aggregated legacy panel.
  expect(wrapper.findComponent(ToolStepCard).exists()).toBe(true);
  expect(wrapper.findComponent(ToolCallPanel).exists()).toBe(false);
  expect(wrapper.find('[data-test="msg-out"]').text()).toContain("all done");
});

it("shows a failed tool's error message in red when its card is expanded", async () => {
  const wrapper = mount(MessageList, {
    props: {
      messages: [msg({
        direction: "out", text: "", status: "done",
        structured: {
          toolSteps: [],
          parts: [{ type: "tool", step: { toolCallId: "t1", toolName: "read", kind: "read", status: "error", title: "missing.txt", error: "Error: File not found: missing.txt" } }],
        },
      })],
      liveTurn: null,
    },
  });
  expect(wrapper.find('[data-test="tool-step-error"]').exists()).toBe(false);
  await wrapper.find('[data-test="tool-step-header"]').trigger("click");
  const err = wrapper.find('[data-test="tool-step-error"]');
  expect(err.exists()).toBe(true);
  expect(err.text()).toContain("File not found");
});

it("shows a resend control on a failed user message and emits the message on click", async () => {
  const failed = msg({ direction: "in", text: "retry me", failed: true });
  const wrapper = mount(MessageList, { props: { messages: [failed], liveTurn: null } });
  const btn = wrapper.find('[data-test="msg-resend"]');
  expect(btn.exists()).toBe(true);
  expect(wrapper.find('[data-test="msg-failed"]').exists()).toBe(true);
  await btn.trigger("click");
  expect(wrapper.emitted("resend")?.[0]?.[0]).toMatchObject({ text: "retry me", failed: true });
});

it("shows no resend control on a successful user message", () => {
  const wrapper = mount(MessageList, { props: { messages: [msg({ direction: "in", text: "ok" })], liveTurn: null } });
  expect(wrapper.find('[data-test="msg-resend"]').exists()).toBe(false);
});

it("emits load-older when scrolled near the top with older history available", async () => {
  const wrapper = mount(MessageList, {
    props: { messages: [msg({ direction: "out", text: "x" })], liveTurn: null, hasMoreOlder: true, loadingOlder: false },
  });
  const scroller = wrapper.find('[data-test="msg-scroller"]');
  const el = scroller.element as HTMLElement;
  // jsdom doesn't lay out, so fake the scroll metrics: near the top of a tall scroller.
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: 5000 });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 800 });
  el.scrollTop = 10; // within TOP_THRESHOLD
  await scroller.trigger("scroll");
  expect(wrapper.emitted("loadOlder")).toBeTruthy();
});

it("does not emit load-older when already loading or no older history", async () => {
  const wrapper = mount(MessageList, {
    props: { messages: [msg({ direction: "out", text: "x" })], liveTurn: null, hasMoreOlder: false, loadingOlder: false },
  });
  const scroller = wrapper.find('[data-test="msg-scroller"]');
  const el = scroller.element as HTMLElement;
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: 5000 });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 800 });
  el.scrollTop = 0;
  await scroller.trigger("scroll");
  expect(wrapper.emitted("loadOlder")).toBeFalsy();
});

it("re-pins to the bottom when the session changes (atBottom reset)", async () => {
  const wrapper = mount(MessageList, {
    props: { messages: [msg({ direction: "out", text: "hi" })], liveTurn: null, sessionKey: "a\0one" },
  });
  const scroller = wrapper.find('[data-test="msg-scroller"]');
  const el = scroller.element as HTMLElement;
  // User scrolls up in session "one" → detached from bottom, jump-latest shows.
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: 5000 });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 800 });
  el.scrollTop = 100;
  await scroller.trigger("scroll");
  // Detached from the bottom → the jump-latest affordance is shown (v-show, not display:none).
  expect(wrapper.find('[data-test="jump-latest"]').attributes("style") ?? "").not.toContain("display: none");
  // Switching to another session re-pins to the bottom (new session opens at newest).
  await wrapper.setProps({ sessionKey: "a\0two" });
  await wrapper.vm.$nextTick();
  expect(el.scrollTop).toBe(5000); // jumped to scrollHeight
  expect(wrapper.find('[data-test="jump-latest"]').attributes("style") ?? "").toContain("display: none");
});

it("marks message rows as content-visibility virtualized (cv-row)", () => {
  const wrapper = mount(MessageList, {
    props: { messages: [msg({ direction: "in", text: "a" }), msg({ direction: "out", text: "b" })], liveTurn: null },
  });
  // Both the user and assistant row roots opt into off-screen render skipping.
  expect(wrapper.findAll(".cv-row").length).toBe(2);
});

it("shows a spinner while an older page is loading", () => {
  const wrapper = mount(MessageList, {
    props: { messages: [msg({ direction: "out", text: "x" })], liveTurn: null, hasMoreOlder: true, loadingOlder: true },
  });
  expect(wrapper.find('[data-test="loading-older"]').exists()).toBe(true);
});

it("renders a cancelled marker on a stopped message", () => {
  const wrapper = mount(MessageList, {
    props: { messages: [msg({ direction: "out", text: "partial", status: "cancelled" })], liveTurn: null },
  });
  expect(wrapper.find('[data-test="msg-cancelled"]').exists()).toBe(true);
});

it("renders live tool steps inline in the streaming bubble", () => {
  const wrapper = mount(MessageList, {
    props: {
      messages: [],
      liveTurn: live([
        { type: "tool", step: { toolCallId: "t1", toolName: "R", kind: "read", status: "running", title: "a.ts" } },
        { type: "text", text: "thinking" },
      ]),
    },
  });
  expect(wrapper.findComponent(ToolStepCard).exists()).toBe(true);
  expect(wrapper.find('[data-test="msg-streaming"]').text()).toContain("thinking");
});
