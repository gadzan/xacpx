import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import StreamMarkdown from "../components/StreamMarkdown.vue";
import MermaidViewer from "../components/MermaidViewer.vue";
import { renderMarkdown } from "../lib/render-markdown";
import { useThemeStore } from "../stores/theme";

// Count parses without paying for the real pipeline (healing + markdown-it + DOMPurify).
vi.mock("../lib/render-markdown", () => ({
  renderMarkdown: vi.fn((text: string) => `<p>${text}</p>`),
}));
const renderSpy = vi.mocked(renderMarkdown);

// Explicit rest-param signatures (rather than 0-arity) so the `(...a) => fn(...a)` spread
// wrappers below typecheck: TS rejects spreading a non-tuple array into a fixed-arity call.
const hydrate = vi.fn(async (..._args: unknown[]) => {});
const reset = vi.fn((..._args: unknown[]) => {});
vi.mock("../lib/render-mermaid", () => ({
  hydrateMermaidBlocks: (...a: unknown[]) => hydrate(...a),
  resetMermaidBlocks: (...a: unknown[]) => reset(...a),
}));

beforeEach(() => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
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

// renderMarkdown is mocked to a bare `<p>` (see top of file), so no real pre.mermaid-block ever
// lands in the DOM from the render step. This stands one up itself the first time hydrate runs,
// then marks it rendered + injects an svg — mirroring the real hydrateMermaidBlocks' idempotency
// (only touch un-rendered blocks) so a second, overlapping hydrate pass (module-level render() +
// onMounted both schedule one on initial mount) does not re-clobber an already-enhanced block.
function renderFirstMermaidBlock(root: HTMLElement): void {
  if (root.querySelectorAll("pre.mermaid-block").length === 0) {
    const b = document.createElement("pre");
    b.className = "mermaid-block";
    root.appendChild(b);
  }
  root.querySelectorAll("pre.mermaid-block:not(.mermaid-rendered)").forEach((b) => {
    b.classList.add("mermaid-rendered");
    b.innerHTML = '<svg data-test="d"><text>x</text></svg>';
  });
}

describe("StreamMarkdown mermaid hydration", () => {
  test("does not hydrate mermaid while streaming", async () => {
    hydrate.mockClear();
    const wrapper = mount(StreamMarkdown, { props: { text: "```mermaid\ngraph TD\nA-->B\n```", streaming: true } });
    await nextTick();
    await nextTick();
    expect(hydrate).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  test("hydrates mermaid once streaming ends", async () => {
    hydrate.mockClear();
    const wrapper = mount(StreamMarkdown, { props: { text: "```mermaid\ngraph TD\nA-->B\n```", streaming: true } });
    await nextTick();
    await wrapper.setProps({ streaming: false });
    await nextTick();
    await nextTick();
    expect(hydrate).toHaveBeenCalled();
    wrapper.unmount();
  });

  test("hydrates a non-streaming (finalized) message on mount", async () => {
    hydrate.mockClear();
    const wrapper = mount(StreamMarkdown, { props: { text: "```mermaid\ngraph TD\nA-->B\n```", streaming: false } });
    await nextTick();
    await nextTick();
    expect(hydrate).toHaveBeenCalled();
    wrapper.unmount();
  });

  // Amendment: hydrateMermaidBlocks is async, and two overlapping schedule triggers on the
  // same root (e.g. rapid theme toggles) could otherwise run concurrently. scheduleHydrate
  // chains through a per-instance promise so only one hydration pass runs at a time.
  test("serializes hydration — overlapping triggers never run concurrently", async () => {
    vi.useRealTimers(); // this test drives real async timing via the mocked hydrate's setTimeout
    let inFlight = 0;
    let maxInFlight = 0;
    hydrate.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });
    const themeStore = useThemeStore();
    const wrapper = mount(StreamMarkdown, { props: { text: "```mermaid\ngraph TD\nA-->B\n```", streaming: false } });
    themeStore.set("light");
    themeStore.set("dark"); // two rapid re-hydrate triggers
    await new Promise((r) => setTimeout(r, 40));
    expect(maxInFlight).toBe(1);
    hydrate.mockImplementation(async () => {}); // restore for other tests
    wrapper.unmount();
  });

  test("a rendered mermaid block is enhanced with an inline pan/zoom viewport + controls", async () => {
    // Mount schedules hydrate through a chained promise with several microtask hops, so — like
    // the "serializes hydration" test above — use real timers + flushPromises to reliably drain
    // it instead of guessing a fixed nextTick count.
    vi.useRealTimers();
    // hydrate's inferred type is `(..._args: unknown[]) => Promise<void>` (see the file's rest-
    // param note up top), so the mock body takes rest args and casts internally rather than
    // declaring a concrete `root: HTMLElement` param, which fails typecheck as a param variance
    // violation.
    hydrate.mockImplementation(async (...args: unknown[]) => {
      renderFirstMermaidBlock(args[0] as HTMLElement);
    });
    const wrapper = mount(StreamMarkdown, {
      props: { text: "```mermaid\ngraph TD\nA-->B\n```", streaming: false },
      global: { stubs: { MermaidViewer: true } },
    });
    await flushPromises();
    expect(wrapper.element.querySelector(".mmd-viewport")).not.toBeNull();
    expect(wrapper.element.querySelectorAll(".mmd-controls button").length).toBe(4);
    // idempotent: a second hydrate pass must not double-enhance
    await wrapper.setProps({ streaming: false });
    await flushPromises();
    expect(wrapper.element.querySelectorAll(".mmd-viewport").length).toBe(1);
    hydrate.mockImplementation(async () => {});
    wrapper.unmount();
  });

  test("clicking the ⤢ button opens the fullscreen viewer with the diagram svg", async () => {
    // Same rationale as above: real timers + flushPromises to drain the chained hydrate, and the
    // rest-args form to keep hydrate.mockImplementation typechecking.
    vi.useRealTimers();
    hydrate.mockImplementation(async (...args: unknown[]) => {
      renderFirstMermaidBlock(args[0] as HTMLElement);
    });
    const wrapper = mount(StreamMarkdown, {
      props: { text: "```mermaid\ngraph TD\nA-->B\n```", streaming: false },
      global: { stubs: { MermaidViewer: true } },
    });
    await flushPromises();
    expect(wrapper.findComponent(MermaidViewer).exists()).toBe(false);
    (wrapper.element.querySelector('[aria-label="Fullscreen"]') as HTMLElement).click();
    await nextTick();
    const viewer = wrapper.findComponent(MermaidViewer);
    expect(viewer.exists()).toBe(true);
    expect(viewer.props("svg")).toContain('data-test="d"');
    hydrate.mockImplementation(async () => {});
    wrapper.unmount();
  });
});
