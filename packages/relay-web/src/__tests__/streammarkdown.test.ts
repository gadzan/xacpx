import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import StreamMarkdown from "../components/StreamMarkdown.vue";
import MermaidViewer from "../components/MermaidViewer.vue";
import { renderMarkdown } from "../lib/render-markdown";
import { useThemeStore } from "../stores/theme";
import { closeLightbox, useImageLightbox } from "../lib/use-image-lightbox";

// Stale wrappers keep reactive effects alive across tests; the singleton lightbox
// state would make them re-patch cleared DOM. Unmount everything in afterEach.
const wrappers: VueWrapper[] = [];

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

// Mock the inline enhancer so the tests can assert the WIRING (enhance called once per rendered
// block, viewer opened on ⤢) via call count — the real enhancer is covered by inline-mermaid.test.ts.
// The stand-in produces just enough DOM (a .mmd-viewport keeping the svg, a Fullscreen button wired
// to onExpand) for those assertions.
const enhanceCalls: HTMLElement[] = [];
// Each enhance returns a detacher that records its id here, so tests can assert that a
// re-render (or unmount) actually detaches the previous block's enhancers.
const detachCalls: number[] = [];
let enhanceSeq = 0;
vi.mock("../lib/inline-mermaid", () => ({
  enhanceMermaidBlock: (block: HTMLElement, opts: { onExpand: () => void }) => {
    const id = (enhanceSeq += 1);
    enhanceCalls.push(block);
    const svg = block.querySelector("svg");
    const viewport = document.createElement("div");
    viewport.className = "mmd-viewport";
    if (svg) viewport.appendChild(svg);
    const bar = document.createElement("div");
    bar.className = "mmd-controls";
    for (let i = 0; i < 3; i += 1) bar.appendChild(document.createElement("button"));
    const expand = document.createElement("button");
    expand.setAttribute("aria-label", "Fullscreen");
    expand.addEventListener("click", () => opts.onExpand());
    bar.appendChild(expand);
    block.replaceChildren(viewport, bar);
    return () => detachCalls.push(id);
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
  renderSpy.mockClear();
  enhanceCalls.length = 0;
  detachCalls.length = 0;
  enhanceSeq = 0;
});

afterEach(() => {
  while (wrappers.length) void wrappers.pop()!.unmount();
  closeLightbox();
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

  test("a rendered mermaid block is enhanced exactly once (idempotent across the mount double-schedule)", async () => {
    // Mount schedules hydrate twice (module-level render() + onMounted). Each pass runs through a
    // chained promise with several microtask hops, so use real timers + flushPromises to drain it.
    vi.useRealTimers();
    // hydrate's inferred type is `(..._args: unknown[]) => Promise<void>`, so take rest args and
    // cast internally rather than a concrete `root: HTMLElement` param (param-variance typecheck).
    hydrate.mockImplementation(async (...args: unknown[]) => {
      renderFirstMermaidBlock(args[0] as HTMLElement);
    });
    const wrapper = mount(StreamMarkdown, {
      props: { text: "```mermaid\ngraph TD\nA-->B\n```", streaming: false },
      global: { stubs: { MermaidViewer: true } },
    });
    await flushPromises();
    expect(wrapper.element.querySelector(".mmd-viewport")).not.toBeNull();
    // The `:not([data-mmd-enhanced])` guard means the block is enhanced ONCE despite two hydrate
    // passes on mount. Without the guard this is 2 — the assertion that actually locks it.
    expect(enhanceCalls.length).toBe(1);
    hydrate.mockImplementation(async () => {});
    wrapper.unmount();
  });

  test("re-enhances a diagram after a theme switch (reset + re-hydrate)", async () => {
    vi.useRealTimers();
    hydrate.mockImplementation(async (...args: unknown[]) => {
      renderFirstMermaidBlock(args[0] as HTMLElement);
    });
    // reset mimics the real resetMermaidBlocks: it rebuilds each block to an un-rendered fallback
    // and does NOT clear `data-mmd-enhanced` (clearing that marker is StreamMarkdown's job — the
    // bug this test locks: without it, the re-rendered block is skipped and loses pan/zoom).
    reset.mockImplementation((...args: unknown[]) => {
      (args[0] as HTMLElement).querySelectorAll("pre.mermaid-block").forEach((b) => {
        b.classList.remove("mermaid-rendered");
        b.innerHTML = "<code>graph TD</code>";
      });
    });
    const themeStore = useThemeStore();
    const wrapper = mount(StreamMarkdown, {
      props: { text: "```mermaid\ngraph TD\nA-->B\n```", streaming: false },
      global: { stubs: { MermaidViewer: true } },
    });
    await flushPromises();
    expect(enhanceCalls.length).toBe(1); // enhanced on mount
    themeStore.set(themeStore.mode === "dark" ? "light" : "dark"); // → scheduleHydrate(reset = true)
    await flushPromises();
    // The reset cleared the enhancement DOM and marker; the re-hydrated block must be enhanced again.
    expect(enhanceCalls.length).toBe(2);
    expect(wrapper.element.querySelector(".mmd-viewport")).not.toBeNull();
    reset.mockImplementation(() => {});
    hydrate.mockImplementation(async () => {});
    wrapper.unmount();
  });

  test("a queued hydration that releases after streaming resumed does not hydrate (re-checks streaming)", async () => {
    // Pass 1 (mount, streaming=false) is held in-flight; while it is parked, streaming flips back
    // to true. When pass 1 releases and the chained pass runs, it must see streaming=true and bail
    // — otherwise it hydrates a diagram whose source is still mid-stream. The guard is the
    // in-callback `hydrationStale()` recheck; without it this second hydrate fires.
    vi.useRealTimers();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    hydrate.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) await gate; // park the first pass
    });
    const wrapper = mount(StreamMarkdown, {
      props: { text: "```mermaid\ngraph TD\nA-->B\n```", streaming: false },
      global: { stubs: { MermaidViewer: true } },
    });
    await nextTick();
    await wrapper.setProps({ streaming: true }); // resume streaming while pass 1 is parked
    release(); // let the chain drain
    await flushPromises();
    expect(calls).toBe(1); // the queued follow-up bailed on the streaming recheck
    hydrate.mockImplementation(async () => {});
    wrapper.unmount();
  });

  test("a plain (finalized) text re-render detaches the previous block's enhancers", async () => {
    // Replacing v-html discards the enhanced viewport DOM; render() must detach its listeners
    // rather than strand them until the next theme switch/unmount. Observed via the detacher the
    // enhancer mock returns (records its id in detachCalls). Without the detach in render() this
    // stays empty and the assertion fails.
    vi.useRealTimers();
    hydrate.mockImplementation(async (...args: unknown[]) => {
      renderFirstMermaidBlock(args[0] as HTMLElement);
    });
    const wrapper = mount(StreamMarkdown, {
      props: { text: "```mermaid\ngraph TD\nA-->B\n```", streaming: false },
      global: { stubs: { MermaidViewer: true } },
    });
    await flushPromises();
    expect(enhanceCalls.length).toBe(1);
    expect(detachCalls).toEqual([]); // enhanced, nothing detached yet
    await wrapper.setProps({ text: "```mermaid\ngraph TD\nA-->C\n```" }); // finalized change → render()
    await flushPromises();
    expect(detachCalls).toContain(1); // the first block's enhancer was detached on the re-render
    hydrate.mockImplementation(async () => {});
    wrapper.unmount();
  });

  test("unmount mid-hydration: the abort predicate reaches INTO the hydrator and reports torn-down", async () => {
    // Component-level teardown-during-hydration. The contract Codex flagged: the guard must reach
    // INTO the hydrator, not merely gate the caller. We capture the 3rd arg (shouldAbort) the
    // component hands hydrateMermaidBlocks, sample it AFTER unmount, and assert it reports stale —
    // and that no post-hydrate enhancement touched the torn-down block. If the component stopped
    // passing the predicate, `sampled` stays null and this reddens.
    vi.useRealTimers();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const enteredP = new Promise<void>((r) => (entered = r));
    let sampled: boolean | null = null;
    hydrate.mockImplementation(async (...args: unknown[]) => {
      const shouldAbort = args[2] as (() => boolean) | undefined;
      entered(); // signal hydration is now in-flight (before any unmount)
      await gate; // park here until after unmount
      sampled = shouldAbort ? shouldAbort() : null;
      renderFirstMermaidBlock(args[0] as HTMLElement);
    });
    const wrapper = mount(StreamMarkdown, {
      props: { text: "```mermaid\ngraph TD\nA-->B\n```", streaming: false },
      global: { stubs: { MermaidViewer: true } },
    });
    await enteredP; // hydrate is genuinely parked in-flight — not short-circuited before it ran
    wrapper.unmount(); // tear down while hydration is parked
    release(); // resolve against the disposed component
    await flushPromises();
    expect(sampled).toBe(true); // hydrator was handed a live predicate that reports torn-down
    expect(enhanceCalls.length).toBe(0); // disposed → no enhancement of a torn-down block
    hydrate.mockImplementation(async () => {});
  });

  test("a failed diagram gets a localized muted error label (spec error affordance)", async () => {
    vi.useRealTimers();
    hydrate.mockImplementation(async (...args: unknown[]) => {
      const root = args[0] as HTMLElement;
      if (root.querySelectorAll("pre.mermaid-block").length === 0) {
        const b = document.createElement("pre");
        b.className = "mermaid-block mermaid-error"; // a render that failed keeps its code fallback
        b.innerHTML = "<code>bad diagram</code>";
        root.appendChild(b);
      }
    });
    const wrapper = mount(StreamMarkdown, {
      props: { text: "```mermaid\nbad\n```", streaming: false },
      global: { stubs: { MermaidViewer: true } },
    });
    await flushPromises();
    const errBlock = wrapper.element.querySelector("pre.mermaid-block.mermaid-error");
    // Label text comes from i18n (en default); without labelErrorBlocks the attribute is absent.
    expect(errBlock?.getAttribute("data-mmd-error-label")).toBe("Diagram failed to render");
    hydrate.mockImplementation(async () => {});
    wrapper.unmount();
  });

  test("clicking the ⤢ button opens the fullscreen viewer with the diagram svg", async () => {
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

describe("StreamMarkdown image lightbox delegation", () => {
  afterEach(() => {
    closeLightbox();
  });

  function mountWith(text: string) {
    const wrapper = mount(StreamMarkdown, {
      props: { text, streaming: false },
      global: { stubs: { MermaidViewer: true } },
    });
    wrappers.push(wrapper);
    return wrapper;
  }

  test("a delegated img click opens the fullscreen viewer on the clicked image", async () => {
    // The suite mocks renderMarkdown, so inject real <img> markup the way the
    // real pipeline emits for ![alt](data:...) — via the mocked renderer itself.
    renderSpy.mockImplementationOnce(
      (_text: string) =>
        '<p><img src="data:image/png;base64,AA" alt="one"> and <img src="data:image/png;base64,BB" alt="two"></p>',
    );
    const wrapper = mountWith("ignored");
    const imgs = wrapper.element.querySelectorAll("img");
    expect(imgs.length).toBe(2);
    (imgs[1]!).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(useImageLightbox().state.value).toMatchObject({ index: 1 });
    expect(useImageLightbox().state.value!.images).toHaveLength(2);
    expect(useImageLightbox().current.value?.src).toBe("data:image/png;base64,BB");
  });

  test("non-viewable srcs never open the viewer", async () => {
    // A relative src resolves to an absolute http URL on .src; the raw-attribute
    // check must still reject it.
    renderSpy.mockImplementationOnce((_text: string) => '<p><img src="relative.png" alt="x"></p>');
    const wrapper = mountWith("ignored");
    const imgEl = wrapper.element.querySelector("img")!;
    imgEl.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(useImageLightbox().state.value).toBeNull();
  });
});
