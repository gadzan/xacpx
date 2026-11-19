import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import MobileSheet from "../components/MobileSheet.vue";
import { pushModal } from "../lib/mobile-back";

// The sheet's pull-to-close is pointer-driven: tests dispatch pointer-typed
// mouse events (jsdom has no PointerEvent) straight at the grabber strip.
function pointer(type: string, clientY: number): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 0, clientY, button: 0 });
}

function mountSheet() {
  return mount(MobileSheet, {
    props: { title: "Sessions", testId: "sheet" },
    slots: { default: '<button data-test="content-row">row</button>' },
    attachTo: document.body,
  });
}

function panelEl(): HTMLElement {
  return document.querySelector('[data-test="sheet"]') as HTMLElement;
}

function grabberEl(): HTMLElement {
  return document.querySelector('[data-test="sheet-grabber"]') as HTMLElement;
}

/** jsdom reports no layout; pin the panel height the threshold is measured against. */
function mockPanelHeight(height: number): void {
  vi.spyOn(panelEl(), "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, width: 390, height, top: 0, left: 0, right: 390, bottom: height, toJSON() {},
  } as DOMRect);
}

/** Deterministic clock for the flick-velocity math (px per ms between moves). */
function mockClock(times: number[]): void {
  const now = vi.spyOn(performance, "now");
  times.forEach((t) => now.mockReturnValueOnce(t));
}

async function drag(clientYs: number[]): Promise<void> {
  const grabber = grabberEl();
  grabber.dispatchEvent(pointer("pointerdown", clientYs[0]!));
  for (const y of clientYs.slice(1)) grabber.dispatchEvent(pointer("pointermove", y));
  await nextTick();
}

describe("MobileSheet pull-to-close", () => {
  it("renders a decorative grab handle: a centred 36x5 rounded bar", () => {
    const wrapper = mountSheet();
    // The sheet teleports to <body>, so assertions read the document.
    const grabber = grabberEl();
    expect(grabber).not.toBeNull();
    expect(grabber.getAttribute("aria-hidden")).toBe("true");
    const bar = grabber.firstElementChild as HTMLElement;
    expect(bar.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["mx-auto", "h-[5px]", "w-9", "rounded-full"]),
    );
    wrapper.unmount();
  });

  it("carries the glass treatment, 24px top radius, an 85dvh cap with top headroom and glass scrim", () => {
    const wrapper = mountSheet();
    const panel = panelEl();
    expect(panel.className.split(/\s+/)).toEqual(
      expect.arrayContaining([
        "bg-glass-strong",
        "backdrop-blur-glass",
        "backdrop-saturate-glass",
        "shadow-glass-float",
        "rounded-t-[24px]",
        "max-h-[85dvh]",
      ]),
    );
    expect(panel.className).not.toContain("bg-raised");
    // The measured cap is one notch headroom above the panel: 85dvh in normal
    // viewports, shrinking when the notch (`safe-area-inset-top`) claims space.
    expect(panel.style.maxHeight).toBe("min(85dvh, calc(100dvh - env(safe-area-inset-top, 0px) - 12px))");
    const scrim = document.querySelector('[data-test="sheet-backdrop"]') as HTMLElement;
    // One scrim blur for every dimming layer.
    expect(scrim.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["bg-scrim", "backdrop-blur-scrim"]),
    );
    expect(scrim.className).not.toContain("bg-black/50");

    wrapper.unmount();
  });

  it("keeps the #fixed band outside the scrolling body", () => {
    const wrapper = mount(MobileSheet, {
      props: { title: "Sessions", testId: "sheet" },
      slots: {
        fixed: '<input data-test="fixed-search" />',
        default: '<button data-test="content-row">row</button>',
      },
      attachTo: document.body,
    });
    const search = document.querySelector('[data-test="fixed-search"]') as HTMLElement;
    const row = document.querySelector('[data-test="content-row"]') as HTMLElement;
    const scroller = row.closest(".thin-scroll") as HTMLElement;
    expect(search).not.toBeNull();
    expect(scroller.contains(search)).toBe(false);
    expect(scroller.contains(row)).toBe(true);
    wrapper.unmount();
  });

  it("escapes a containing-block ancestor and, over a lower modal, drops its own dimming", async () => {
    // The Agent picker inside NewSessionDialog: a dialog panel that establishes a
    // containing block (backdrop-filter in the browser, transform here), with the
    // dialog already on the layer stack.
    const trap = document.createElement("div");
    trap.style.transform = "translateX(0)";
    document.body.appendChild(trap);
    const closeLower = pushModal({ id: "parent-dialog", close: () => {} });
    const over = mount(MobileSheet, {
      props: { title: "Agents", testId: "sheet" },
      slots: { default: '<button data-test="content-row">row</button>' },
      attachTo: trap,
    });
    await nextTick();
    await nextTick();
    // It left the trapping ancestor for <body>, so fixed resolves on the viewport.
    expect(trap.querySelector('[data-test="sheet-backdrop"]')).toBeNull();
    const overScrim = document.querySelector('[data-test="sheet-backdrop"]') as HTMLElement;
    expect(overScrim.parentElement).toBe(document.body);
    expect(overScrim.className.split(/\s+/)).not.toContain("bg-scrim");
    expect(overScrim.className.split(/\s+/)).toContain("bg-transparent");
    expect(panelEl().className.split(/\s+/)).toContain("z-dialog-nested");
    over.unmount();
    closeLower();
    trap.remove();

    // Same pane, no filter: the sheet stays in place, keeps its own scrim and its
    // base rung, so a layer that mounts after it still paints above by DOM order.
    const plain = document.createElement("div");
    document.body.appendChild(plain);
    const under = mount(MobileSheet, {
      props: { title: "Sessions", testId: "sheet" },
      slots: { default: '<button data-test="content-row">row</button>' },
      attachTo: plain,
    });
    await nextTick();
    const closeUpper = pushModal({ id: "late-dialog", close: () => {} });
    await nextTick();
    const underScrim = plain.querySelector('[data-test="sheet-backdrop"]') as HTMLElement;
    expect(underScrim).not.toBeNull();
    expect(underScrim.className.split(/\s+/)).toContain("bg-scrim");
    expect(panelEl().className.split(/\s+/)).toContain("z-sheet");
    closeUpper();
    under.unmount();
  });

  it("follows the finger, then closes past a quarter of the panel height", async () => {
    const wrapper = mountSheet();
    mockPanelHeight(400);
    mockClock([1000, 1001, 1002]);
    await drag([100, 200, 300]);
    // 200px down the panel tracks the finger.
    expect(panelEl().style.transform).toBe("translateY(200px)");
    grabberEl().dispatchEvent(pointer("pointerup", 300));
    await nextTick();
    // 200px > 25% of 400px: the sheet closes through the standard close path.
    expect(wrapper.emitted("close")).toBeTruthy();
    wrapper.unmount();
  });

  it("springs back without closing on a short release", async () => {
    const wrapper = mountSheet();
    mockPanelHeight(400);
    mockClock([1000, 2000, 3000]);
    await drag([100, 140]);
    expect(panelEl().style.transform).toBe("translateY(40px)");
    grabberEl().dispatchEvent(pointer("pointerup", 140));
    await nextTick();
    // 40px < 25% of 400px and no flick: open, parked at rest.
    expect(wrapper.emitted("close")).toBeUndefined();
    expect(panelEl().style.transform).toBe("");
    wrapper.unmount();
  });

  it("closes on a fast flick below the distance threshold", async () => {
    const wrapper = mountSheet();
    mockPanelHeight(600);
    // 30px in 5ms, then 30px more in 5ms: 6px/ms at a 60px offset.
    mockClock([1000, 1005, 1010]);
    await drag([100, 130, 160]);
    grabberEl().dispatchEvent(pointer("pointerup", 160));
    await nextTick();
    expect(wrapper.emitted("close")).toBeTruthy();
    wrapper.unmount();
  });

  it("ignores drags that start in the scrolling content", async () => {
    const wrapper = mountSheet();
    mockPanelHeight(400);
    const row = document.querySelector('[data-test="content-row"]') as HTMLElement;
    row.dispatchEvent(pointer("pointerdown", 100));
    row.dispatchEvent(pointer("pointermove", 300));
    await nextTick();
    expect(panelEl().style.transform).toBe("");
    row.dispatchEvent(pointer("pointerup", 300));
    await nextTick();
    expect(wrapper.emitted("close")).toBeUndefined();
    wrapper.unmount();
  });
});
