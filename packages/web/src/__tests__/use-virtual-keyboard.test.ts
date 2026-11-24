import { describe, it, expect, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h, type Ref } from "vue";
import { useVirtualKeyboardInset } from "../lib/use-virtual-keyboard";

function harness() {
  let inset!: Ref<number>;
  const Comp = defineComponent({ setup() { inset = useVirtualKeyboardInset(); return () => h("div"); } });
  const w = mount(Comp);
  return { w, get: () => inset.value };
}

function setViewport(innerHeight: number, vvHeight: number) {
  Object.defineProperty(window, "visualViewport", {
    value: { height: vvHeight, offsetTop: 0, addEventListener() {}, removeEventListener() {} },
    configurable: true,
  });
  Object.defineProperty(window, "innerHeight", { value: innerHeight, configurable: true });
}

afterEach(() => {
  Reflect.deleteProperty(window, "visualViewport");
  Object.defineProperty(window, "innerHeight", { value: 768, configurable: true });
});

describe("useVirtualKeyboardInset", () => {
  it("reports the covered height only while an editable element is focused", () => {
    setViewport(800, 400); // delta 400 > 120
    const { get } = harness();
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    expect(get()).toBe(0); // nothing focused yet
    ta.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(get()).toBe(400);
    ta.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(get()).toBe(0);
    ta.remove();
  });

  it("ignores focus on a non-editable element (no keyboard)", () => {
    setViewport(800, 400);
    const { get } = harness();
    const div = document.createElement("div");
    document.body.appendChild(div);
    div.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(get()).toBe(0);
    div.remove();
  });

  it("ignores a sub-threshold delta (browser toolbar) even when focused", () => {
    setViewport(800, 720); // delta 80 < 120
    const { get } = harness();
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(get()).toBe(0);
    ta.remove();
  });
});
