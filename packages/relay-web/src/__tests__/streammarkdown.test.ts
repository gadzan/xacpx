import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import StreamMarkdown from "../components/StreamMarkdown.vue";
import { renderMarkdown } from "../lib/render-markdown";

// Count parses without paying for the real pipeline (healing + markdown-it + DOMPurify).
vi.mock("../lib/render-markdown", () => ({
  renderMarkdown: vi.fn((text: string) => `<p>${text}</p>`),
}));
const renderSpy = vi.mocked(renderMarkdown);

beforeEach(() => {
  vi.useFakeTimers();
  renderSpy.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("StreamMarkdown streaming throttle", () => {
  it("non-streaming: re-renders synchronously on every text change (no throttle)", async () => {
    const w = mount(StreamMarkdown, { props: { text: "a", streaming: false } });
    expect(w.html()).toContain("<p>a</p>");
    await w.setProps({ text: "ab" });
    expect(w.html()).toContain("<p>ab</p>");
    await w.setProps({ text: "abc" });
    expect(w.html()).toContain("<p>abc</p>");
    expect(renderSpy).toHaveBeenCalledTimes(3); // mount + 2 updates, zero timers involved
    expect(vi.getTimerCount()).toBe(0);
  });

  it("streaming: coalesces a burst of chunks into one trailing render with the full text", async () => {
    const w = mount(StreamMarkdown, { props: { text: "a", streaming: true } });
    expect(renderSpy).toHaveBeenCalledTimes(1); // initial mount render
    // Rapid chunks well inside the throttle window: no immediate re-parse.
    await w.setProps({ text: "ab" });
    await w.setProps({ text: "abc" });
    await w.setProps({ text: "abcd" });
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(w.html()).toContain("<p>a</p>"); // still the last painted frame
    // Trailing edge fires once and picks up the LATEST text.
    vi.advanceTimersByTime(80);
    await nextTick();
    expect(renderSpy).toHaveBeenCalledTimes(2);
    expect(w.html()).toContain("<p>abcd</p>");
  });

  it("streaming: a chunk arriving after the throttle window renders immediately", async () => {
    const w = mount(StreamMarkdown, { props: { text: "a", streaming: true } });
    vi.advanceTimersByTime(100); // let the window elapse with no pending chunk
    await w.setProps({ text: "ab" });
    expect(renderSpy).toHaveBeenCalledTimes(2); // leading edge, no wait
    expect(w.html()).toContain("<p>ab</p>");
  });

  it("streaming -> false renders the final full text immediately and drops the pending timer", async () => {
    const w = mount(StreamMarkdown, { props: { text: "a", streaming: true } });
    await w.setProps({ text: "ab" }); // schedules a trailing render
    expect(vi.getTimerCount()).toBe(1);
    await w.setProps({ text: "ab final", streaming: false });
    expect(w.html()).toContain("<p>ab final</p>"); // no waiting for the timer
    expect(vi.getTimerCount()).toBe(0);
    const calls = renderSpy.mock.calls.length;
    vi.advanceTimersByTime(200); // nothing left to fire
    expect(renderSpy).toHaveBeenCalledTimes(calls);
  });

  it("unmount clears a pending throttled render (no stray timer callback)", async () => {
    const w = mount(StreamMarkdown, { props: { text: "a", streaming: true } });
    await w.setProps({ text: "ab" });
    expect(vi.getTimerCount()).toBe(1);
    w.unmount();
    expect(vi.getTimerCount()).toBe(0);
    const calls = renderSpy.mock.calls.length;
    vi.advanceTimersByTime(200);
    expect(renderSpy).toHaveBeenCalledTimes(calls);
  });
});
