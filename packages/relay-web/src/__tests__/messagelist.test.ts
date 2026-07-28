import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

// MessageList imports AgentIcon at module evaluation time. Stub the raw SVG catalog so
// this suite does not depend on Windows being able to open every optional @lobehub icon
// file (some hosts return EPERM for openclaw-color.svg).
vi.mock("../lib/agent-icons", () => ({ agentIconSvg: () => null }));

import MessageList from "../components/MessageList.vue";
import type { ChatMessage, LiveTurn } from "../stores/chat";
import ToolCallPanel from "../components/ToolCallPanel.vue";
import ToolStepCard from "../components/ToolStepCard.vue";
import CopyButton from "../components/CopyButton.vue";

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

  it("renders user input as markdown, same as agent output", () => {
    const wrapper = mount(MessageList, {
      props: { messages: [msg({ direction: "in", text: "**bold input**" })], liveTurn: null },
    });
    const inEl = wrapper.find('[data-test="msg-in"]');
    expect(inEl.exists()).toBe(true);
    expect(inEl.html()).toContain("<strong>bold input</strong>");
  });

  it("escapes raw HTML from user input instead of dropping it", () => {
    const wrapper = mount(MessageList, {
      props: { messages: [msg({ direction: "in", text: "<script>alert(1)</script>" })], liveTurn: null },
    });
    const inEl = wrapper.find('[data-test="msg-in"]');
    expect(inEl.text()).toContain("alert(1)");
    expect(wrapper.find("script").exists()).toBe(false);
  });

  it("wraps user code fences and tables in scrollable containers", () => {
    const text = "```js\nconst x = 1\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |";
    const wrapper = mount(MessageList, {
      props: { messages: [msg({ direction: "in", text })], liveTurn: null },
    });
    const inEl = wrapper.find('[data-test="msg-in"]');
    expect(inEl.find("pre").exists()).toBe(true);
    expect(inEl.find(".md-table-wrap").exists()).toBe(true);
  });

  it("offers a copy button on user messages carrying the verbatim source text", () => {
    const wrapper = mount(MessageList, {
      props: { messages: [msg({ direction: "in", text: "**raw source**" })], liveTurn: null },
    });
    const copy = wrapper.findComponent(CopyButton);
    expect(copy.exists()).toBe(true);
    expect(copy.props("text")).toBe("**raw source**");
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

describe("progressive tail-first mounting", () => {
  let rafQueue: FrameRequestCallback[];

  beforeEach(() => {
    rafQueue = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => vi.unstubAllGlobals());

  const many = (n: number): ChatMessage[] =>
    Array.from({ length: n }, (_, i) => msg({ direction: "in", text: `m${i}`, id: i + 1 }));

  async function flushFrames(wrapper: ReturnType<typeof mount>): Promise<void> {
    while (rafQueue.length) {
      for (const cb of rafQueue.splice(0)) cb(0);
      await wrapper.vm.$nextTick();
    }
  }

  it("mounts only the newest rows when a large history lands, then reveals the rest in batches", async () => {
    const wrapper = mount(MessageList, { props: { messages: [], liveTurn: null, sessionKey: "a\0one" } });
    await wrapper.setProps({ messages: many(80) });
    // Only the tail is mounted immediately; older rows come in over later frames.
    expect(wrapper.findAll(".cv-row").length).toBe(30);
    expect(wrapper.text()).toContain("m79"); // newest row visible from frame one
    await flushFrames(wrapper);
    expect(wrapper.findAll(".cv-row").length).toBe(80);
    expect(wrapper.text()).toContain("m0");
  });

  it("suppresses load-older while older rows are still revealing locally", async () => {
    const wrapper = mount(MessageList, {
      props: { messages: [], liveTurn: null, hasMoreOlder: true, loadingOlder: false },
    });
    await wrapper.setProps({ messages: many(80) });
    const scroller = wrapper.find('[data-test="msg-scroller"]');
    const el = scroller.element as HTMLElement;
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 5000 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 800 });
    el.scrollTop = 10; // within TOP_THRESHOLD
    await scroller.trigger("scroll");
    // Rows are still mounting locally — nothing to fetch yet.
    expect(wrapper.emitted("loadOlder")).toBeFalsy();
    await flushFrames(wrapper);
    // The reveal/settle passes re-pin the scroller to the bottom; scroll back near the top.
    el.scrollTop = 10;
    await scroller.trigger("scroll");
    expect(wrapper.emitted("loadOlder")).toBeTruthy();
  });

  it("mounts everything synchronously when rAF is unavailable (jsdom fallback)", async () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    const wrapper = mount(MessageList, { props: { messages: [], liveTurn: null } });
    await wrapper.setProps({ messages: many(80) });
    expect(wrapper.findAll(".cv-row").length).toBe(80);
  });

  it("does not re-hide rows on an in-place history replace (turn-finished convergence)", async () => {
    const wrapper = mount(MessageList, { props: { messages: [], liveTurn: null } });
    await wrapper.setProps({ messages: many(80) });
    await flushFrames(wrapper);
    expect(wrapper.findAll(".cv-row").length).toBe(80);
    // Same-session reload replaces the array with fresh row objects (stable keys).
    await wrapper.setProps({ messages: many(81) });
    expect(wrapper.findAll(".cv-row").length).toBe(81);
  });

  // Spec #205: a cache-seeded transcript (≤30 stale rows) is replaced by the full
  // authoritative page without passing through 0 — the arming must still trigger so
  // the ~70 prepended older rows mount in rAF batches, not one synchronous tick.
  it("re-arms progressive mounting when a cache-seeded tail is replaced by the full page", async () => {
    const wrapper = mount(MessageList, { props: { messages: [], liveTurn: null } });
    await wrapper.setProps({ messages: many(20) }); // cached tail seed (< INITIAL_ROWS)
    expect(wrapper.findAll(".cv-row").length).toBe(20);
    await wrapper.setProps({ messages: many(100) }); // authoritative replace
    expect(wrapper.findAll(".cv-row").length).toBe(30); // only the tail mounts immediately
    await flushFrames(wrapper);
    expect(wrapper.findAll(".cv-row").length).toBe(100);
  });
});
