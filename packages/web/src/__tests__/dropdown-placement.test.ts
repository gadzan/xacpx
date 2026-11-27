import { afterEach, describe, expect, it } from "vitest";
import { defineComponent, nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { readyCapability } from "@ganglion/xacpx-relay-protocol";
import { i18n } from "../i18n";
import { measureDropdownPlacement } from "../lib/use-dropdown";
import ModelPicker from "../components/ModelPicker.vue";

// A dropdown inside a scrolling dialog form used to open downward no matter
// what, so a field near the footer pushed its list under the footer and the
// form's own overflow cut it in half. These pin the fitting rule and the markup
// ModelPicker emits when it kicks in.

const FETCHED = "2026-10-09T00:00:00.000Z";

function box(el: Element, top: number, height: number, width = 200): void {
  const rect = {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: width,
    width,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
  el.getBoundingClientRect = () => rect;
}

/** A form that clips, with a trigger parked at its bottom edge. */
function stage({ clipTop = 100, clipBottom = 500, triggerTop = 430, triggerHeight = 34 } = {}) {
  const host = document.createElement("div");
  host.style.overflowY = "auto";
  host.style.overflowX = "hidden";
  const trigger = document.createElement("input");
  host.appendChild(trigger);
  document.body.appendChild(host);
  box(host, clipTop, clipBottom - clipTop);
  box(trigger, triggerTop, triggerHeight, 320);
  return { host, trigger };
}

afterEach(() => {
  document.body.innerHTML = "";
  Object.defineProperty(window, "innerHeight", { value: 768, configurable: true, writable: true });
});

describe("measureDropdownPlacement", () => {
  it("keeps the panel below the trigger and untouched when there is room", () => {
    const { trigger } = stage({ clipTop: 0, clipBottom: 700, triggerTop: 200 });
    // 458px below (roomier than max-h-80), 192px above → stays down, no cap.
    expect(measureDropdownPlacement(trigger)).toEqual({ upward: false, maxHeight: null });
  });

  it("flips above the trigger when the space below is short and above is roomier", () => {
    const { trigger } = stage({ triggerTop: 430 });
    const fit = measureDropdownPlacement(trigger);
    expect(fit.upward).toBe(true);
    // 430 - 100 - 8 = 322 → roomy enough, so no cap.
    expect(fit.maxHeight).toBeNull();
  });

  it("caps the height to the side it opens on when neither side is roomy", () => {
    const { trigger } = stage({ clipTop: 260, clipBottom: 500, triggerTop: 430, triggerHeight: 34 });
    const fit = measureDropdownPlacement(trigger);
    // Below: 500-464-8 = 28; above: 430-260-8 = 162 → flip, capped to 162.
    expect(fit.upward).toBe(true);
    expect(fit.maxHeight).toBe(162);
  });

  it("honours an explicit top placement even with room below", () => {
    const { trigger } = stage({ clipTop: 0, clipBottom: 700, triggerTop: 200 });
    expect(measureDropdownPlacement(trigger, "top").upward).toBe(true);
    expect(measureDropdownPlacement(trigger, "top-end").upward).toBe(true);
    expect(measureDropdownPlacement(trigger, "bottom-end").upward).toBe(false);
  });

  it("stays neutral when nothing can be measured (jsdom's zeroed rects)", () => {
    const plain = document.createElement("input");
    document.body.appendChild(plain);
    expect(measureDropdownPlacement(plain)).toEqual({ upward: false, maxHeight: null });
    expect(measureDropdownPlacement(null)).toEqual({ upward: false, maxHeight: null });
  });

  it("never collapses below a readable height", () => {
    const { trigger } = stage({ clipTop: 440, clipBottom: 500, triggerTop: 430, triggerHeight: 34 });
    const fit = measureDropdownPlacement(trigger);
    // Neither side fits a list, so it stays put and keeps a usable minimum.
    expect(fit.upward).toBe(false);
    expect(fit.maxHeight).toBe(140);
  });
});

describe("ModelPicker fitting inside a clipping form", () => {
  function mountInForm() {
    const Host = defineComponent({
      components: { ModelPicker },
      template: `<div data-test="form" style="overflow-x: hidden; overflow-y: auto"><ModelPicker
        :state="state" model="" effort="" audience="bot" :show-effort="false"
        model-test-id="ns-model" list-test-id="ns-model-list" /></div>`,
      data: () => ({
        state: readyCapability("runtime", [{ modelId: "gpt-a" }, { modelId: "gpt-b" }], { fetchedAt: FETCHED }),
      }),
    });
    return mount(Host, { global: { plugins: [i18n] }, attachTo: document.body });
  }

  it("opens above the field and caps its height when the form bottom is close", async () => {
    const wrapper = mountInForm();
    const form = wrapper.get('[data-test="form"]').element;
    const input = wrapper.get('[data-test="ns-model"]').element;
    // Form 260..500, field at 430..464: 28px below, 162px above.
    box(form, 260, 240);
    box(input, 430, 34, 320);

    await wrapper.get('[data-test="ns-model"]').trigger("focus");
    await nextTick();
    await nextTick();

    const list = wrapper.get('[data-test="ns-model-list"]');
    expect(list.classes()).toContain("bottom-full");
    expect(list.classes()).not.toContain("mt-1");
    expect(list.attributes("style") ?? "").toMatch(/max-height: 162px/);
    wrapper.unmount();
  });

  it("keeps the default downward panel when the layout cannot be measured", async () => {
    const wrapper = mountInForm();
    await wrapper.get('[data-test="ns-model"]').trigger("focus");
    await nextTick();
    await nextTick();

    const list = wrapper.get('[data-test="ns-model-list"]');
    expect(list.classes()).toContain("mt-1");
    expect(list.classes()).not.toContain("bottom-full");
    expect(list.attributes("style") ?? "").not.toContain("max-height");
    wrapper.unmount();
  });
});
