import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import MobileSheet from "../components/MobileSheet.vue";

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
    const grabber = wrapper.find('[data-test="sheet-grabber"]');
    expect(grabber.exists()).toBe(true);
    expect(grabber.attributes("aria-hidden")).toBe("true");
    const bar = grabber.element.firstElementChild as HTMLElement;
    expect(bar.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["mx-auto", "h-[5px]", "w-9", "rounded-full"]),
    );
    wrapper.unmount();
  });

  it("carries the glass treatment, 20px top radius, glass scrim and 17px title", () => {
    const wrapper = mountSheet();
    const panel = wrapper.find('[data-test="sheet"]');
    expect(panel.classes()).toEqual(
      expect.arrayContaining([
        "bg-glass-strong",
        "backdrop-blur-glass",
        "backdrop-saturate-glass",
        "shadow-glass-float",
        "rounded-t-[20px]",
        "max-h-[78dvh]",
      ]),
    );
    expect(panel.classes()).not.toContain("bg-raised");
    const scrim = document.querySelector('[data-test="sheet-backdrop"]') as HTMLElement;
    expect(scrim.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["bg-scrim", "backdrop-blur-sm"]),
    );
    expect(scrim.className).not.toContain("bg-black/50");
    expect(wrapper.find("h2").classes()).toContain("text-[17px]");
    wrapper.unmount();
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
