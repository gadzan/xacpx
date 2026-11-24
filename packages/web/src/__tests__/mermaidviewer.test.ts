import { afterEach, expect, test, vi } from "vitest";
import { mount } from "@vue/test-utils";
import MermaidViewer from "../components/MermaidViewer.vue";

const SVG = '<svg data-test="diagram"><text>hi</text></svg>';
afterEach(() => { document.body.innerHTML = ""; document.body.style.overflow = ""; });

const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
function fire(el: EventTarget, type: string, props: Record<string, unknown>): void {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, props);
  el.dispatchEvent(e);
}

test("teleports and renders the svg; locks body scroll while open", () => {
  const wrapper = mount(MermaidViewer, { props: { svg: SVG } });
  expect(q('[data-test="diagram"]')).not.toBeNull();
  expect(document.body.style.overflow).toBe("hidden");
  wrapper.unmount();
  expect(document.body.style.overflow).toBe("");
});

test("opens on a fitted, centered view (scales the diagram down to the stage)", async () => {
  // jsdom returns zero rects; stub so the diagram (800×400) and stage (400×300) differ.
  const rectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const isSvg = this.tagName === "svg";
    const w = isSvg ? 800 : 400;
    const h = isSvg ? 400 : 300;
    return { width: w, height: h, x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, toJSON() {} } as DOMRect;
  });
  try {
    const wrapper = mount(MermaidViewer, { props: { svg: SVG } });
    await wrapper.vm.$nextTick(); // the fit is applied in onMounted; let the reactive :style flush
    const content = q(".mv-content")!;
    // scale = min(400/800, 300/400, 1) = 0.5; centered x = (400-400)/2 = 0, y = (300-200)/2 = 50.
    expect(content.style.transform).toBe("translate(0px, 50px) scale(0.5)");
    wrapper.unmount();
  } finally {
    rectSpy.mockRestore(); // restore even if the assertion throws, so the spy can't leak
  }
});

test("wheel changes the transform; reset restores it", async () => {
  const wrapper = mount(MermaidViewer, { props: { svg: SVG } });
  const content = q(".mv-content")!;
  const before = content.style.transform;
  fire(q(".mv-stage")!, "wheel", { deltaY: -100, clientX: 0, clientY: 0 });
  await wrapper.vm.$nextTick();
  expect(content.style.transform).not.toBe(before);
  q('[aria-label="Reset"]')!.click();
  await wrapper.vm.$nextTick();
  expect(content.style.transform).toBe("translate(0px, 0px) scale(1)");
  wrapper.unmount();
});

test("Escape, close button, and background click each emit close", async () => {
  const wrapper = mount(MermaidViewer, { props: { svg: SVG } });
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  q('[aria-label="Close"]')!.click();
  q(".mv-stage")!.click(); // background (target === stage)
  await wrapper.vm.$nextTick();
  expect(wrapper.emitted("close")!.length).toBeGreaterThanOrEqual(3);
  wrapper.unmount();
});

test("a drag on the empty backdrop does not close; only a stationary click does", async () => {
  const wrapper = mount(MermaidViewer, { props: { svg: SVG } });
  const stage = q(".mv-stage")!;
  // pointer moved between down and click → a drag-pan, not a close
  fire(stage, "pointerdown", { clientX: 0, clientY: 0 });
  fire(stage, "click", { clientX: 60, clientY: 60 });
  await wrapper.vm.$nextTick();
  expect(wrapper.emitted("close")).toBeFalsy();
  // stationary click on the backdrop → close
  fire(stage, "pointerdown", { clientX: 10, clientY: 10 });
  fire(stage, "click", { clientX: 10, clientY: 10 });
  await wrapper.vm.$nextTick();
  expect(wrapper.emitted("close")).toHaveLength(1);
  wrapper.unmount();
});
