import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";
import Tooltip from "../components/Tooltip.vue";

afterEach(() => { document.body.innerHTML = ""; });

describe("Tooltip", () => {
  it("renders the bubble outside overflow-hidden ancestors (teleported to body) on focus, hides on blur", async () => {
    const host = document.createElement("div");
    host.style.overflow = "hidden";
    document.body.appendChild(host);
    const w = mount(Tooltip, { props: { text: "cold" }, slots: { default: '<button data-test="anchor">x</button>' }, attachTo: host });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    (w.find('[data-test="anchor"]').element as HTMLElement).focus();
    await nextTick();
    const tip = document.querySelector<HTMLElement>('[role="tooltip"]');
    expect(tip?.textContent).toContain("cold");
    expect(host.contains(tip)).toBe(false);
    expect(tip!.className).toContain("fixed");
    (w.find('[data-test="anchor"]').element as HTMLElement).blur();
    await nextTick();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    w.unmount();
  });
});

describe("Tooltip positioning", () => {
  // Viewport 1000×800, bubble 100×24; the anchor rect is mutable per test.
  const BUBBLE = { width: 100, height: 24 };
  let anchorRect = { top: 100, left: 400, width: 40, height: 20 };
  let frames: FrameRequestCallback[] = [];
  const origW = window.innerWidth;
  const origH = window.innerHeight;

  function rect(r: { top: number; left: number; width: number; height: number }): DOMRect {
    return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
  }
  function flushFrames(): void {
    const pending = frames;
    frames = [];
    for (const cb of pending) cb(0);
  }

  beforeEach(() => {
    anchorRect = { top: 100, left: 400, width: 40, height: 20 };
    frames = [];
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", () => { frames = []; });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("role") === "tooltip") return rect({ top: 0, left: 0, ...BUBBLE });
      return rect(anchorRect);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: origW });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: origH });
  });

  async function open(props: Record<string, unknown> = {}) {
    const w = mount(Tooltip, {
      props: { text: "cold", ...props },
      slots: { default: '<button data-test="anchor">x</button>' },
      attachTo: document.body,
    });
    (w.find('[data-test="anchor"]').element as HTMLElement).focus();
    await nextTick();
    await nextTick();
    return w;
  }
  const tip = () => document.querySelector<HTMLElement>('[role="tooltip"]');

  it("places below the anchor by default, centered", async () => {
    const w = await open();
    expect(tip()!.style.top).toBe("128px"); // 100 + 20 + 8
    expect(tip()!.style.left).toBe("370px"); // 420 - 50
    expect(tip()!.dataset.placement).toBe("below");
    w.unmount();
  });

  it("repositions after a nested scroller scrolls (capture phase, rAF-throttled)", async () => {
    const w = await open();
    const scroller = document.createElement("div");
    document.body.appendChild(scroller);
    anchorRect = { ...anchorRect, top: 300, left: 200 };
    // scroll events don't bubble; the capture listener on window must still see them.
    scroller.dispatchEvent(new Event("scroll"));
    scroller.dispatchEvent(new Event("scroll"));
    expect(frames).toHaveLength(1);
    expect(tip()!.style.top).toBe("128px"); // not yet: waits for the frame
    flushFrames();
    await nextTick();
    expect(tip()!.style.top).toBe("328px");
    expect(tip()!.style.left).toBe("170px");
    w.unmount();
  });

  it("repositions on window resize", async () => {
    const w = await open();
    anchorRect = { ...anchorRect, left: 900 };
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 950 });
    window.dispatchEvent(new Event("resize"));
    flushFrames();
    await nextTick();
    expect(tip()!.style.left).toBe("842px"); // 950 - 100 - 8
    w.unmount();
  });

  it("flips above when the preferred bottom side overflows the viewport", async () => {
    anchorRect = { top: 770, left: 400, width: 40, height: 20 };
    const w = await open();
    expect(tip()!.dataset.placement).toBe("above");
    expect(tip()!.style.top).toBe("738px"); // 770 - 24 - 8
    w.unmount();
  });

  it("flips below when placement=top overflows the top edge", async () => {
    anchorRect = { top: 10, left: 400, width: 40, height: 20 };
    const w = await open({ placement: "top" });
    expect(tip()!.dataset.placement).toBe("below");
    expect(tip()!.style.top).toBe("38px"); // 10 + 20 + 8
    w.unmount();
  });

  it("keeps placement=top above when it fits", async () => {
    anchorRect = { top: 300, left: 400, width: 40, height: 20 };
    const w = await open({ placement: "top" });
    expect(tip()!.dataset.placement).toBe("above");
    expect(tip()!.style.top).toBe("268px"); // 300 - 24 - 8
    w.unmount();
  });

  it("clamps 8px inside the right edge and keeps the arrow on the anchor", async () => {
    anchorRect = { top: 100, left: 975, width: 20, height: 20 };
    const w = await open();
    expect(tip()!.style.left).toBe("892px"); // 1000 - 100 - 8
    const arrow = tip()!.querySelector<HTMLElement>("span")!;
    expect(arrow.style.left).toBe("92px"); // clamped to bubble width - 8 inset (anchor center 985 - 892 = 93)
    w.unmount();
  });

  it("clamps 8px inside the left edge", async () => {
    anchorRect = { top: 100, left: 0, width: 20, height: 20 };
    const w = await open();
    expect(tip()!.style.left).toBe("8px");
    const arrow = tip()!.querySelector<HTMLElement>("span")!;
    expect(arrow.style.left).toBe("8px"); // anchor center 10 - 8 = 2 → inset 8
    w.unmount();
  });

  it("hides when the anchor scrolls fully out of the viewport, and stops listening", async () => {
    const w = await open();
    anchorRect = { top: -60, left: 400, width: 40, height: 20 };
    window.dispatchEvent(new Event("scroll"));
    flushFrames();
    await nextTick();
    expect(tip()).toBeNull();
    window.dispatchEvent(new Event("scroll"));
    expect(frames).toHaveLength(0);
    w.unmount();
  });

  it("removes its scroll/resize listeners on unmount", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const w = await open();
    const scrollAdd = add.mock.calls.find(([type]) => type === "scroll");
    const resizeAdd = add.mock.calls.find(([type]) => type === "resize");
    expect(scrollAdd?.[2]).toMatchObject({ capture: true });
    w.unmount();
    expect(remove.mock.calls.find(([type, fn]) => type === "scroll" && fn === scrollAdd![1])?.[2]).toMatchObject({ capture: true });
    expect(remove.mock.calls.some(([type, fn]) => type === "resize" && fn === resizeAdd![1])).toBe(true);
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    expect(frames).toHaveLength(0);
  });

  it("removes its listeners on hide", async () => {
    const w = await open();
    (w.find('[data-test="anchor"]').element as HTMLElement).blur();
    await nextTick();
    expect(tip()).toBeNull();
    window.dispatchEvent(new Event("scroll"));
    expect(frames).toHaveLength(0);
    w.unmount();
  });
});
