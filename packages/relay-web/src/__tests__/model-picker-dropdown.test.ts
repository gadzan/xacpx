import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ModelPicker from "../components/ModelPicker.vue";
import { readyCapability } from "@ganglion/xacpx-relay-protocol";
import { i18n } from "../i18n";

const prevWidth = window.innerWidth;
afterEach(() => {
  window.innerWidth = prevWidth;
  document.body.innerHTML = "";
});

function mountPicker() {
  return mount(ModelPicker, {
    props: {
      state: readyCapability("probe", [{ modelId: "gpt-5.5", name: "GPT 5.5" }], { fetchedAt: "2026-10-09T00:00:00.000Z" }),
      model: "",
      effort: "",
      modelTestId: "ns-model",
      listTestId: "ns-model-list",
    },
    global: { plugins: [i18n] },
    attachTo: document.body,
  });
}

describe("ModelPicker dropdown contract", () => {
  it("closes on an outside pointerdown at desktop width, and that click still reaches the page", async () => {
    window.innerWidth = 1280;
    const covered = document.createElement("button");
    const onCovered = vi.fn();
    covered.addEventListener("click", onCovered);
    document.body.appendChild(covered);

    const w = mountPicker();
    await w.get('[data-test="ns-model"]').trigger("focus");
    await nextTick();
    expect(document.querySelector('[data-test="ns-model-list"]')).not.toBeNull();

    // The desktop popover has no scrim to tear down, so it closes on the
    // pointerdown itself and the click that follows belongs to the page.
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 }));
    await nextTick();
    expect(document.querySelector('[data-test="ns-model-list"]')).toBeNull();

    covered.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onCovered).toHaveBeenCalledTimes(1);
    covered.remove();
    w.unmount();
  });

  it("closes on Escape, like every other dropdown", async () => {
    window.innerWidth = 1280;
    const w = mountPicker();
    await w.get('[data-test="ns-model"]').trigger("focus");
    await nextTick();
    expect(document.querySelector('[data-test="ns-model-list"]')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(document.querySelector('[data-test="ns-model-list"]')).toBeNull();
    w.unmount();
  });

  it("renders the model list as a glass surface", async () => {
    window.innerWidth = 1280;
    const w = mountPicker();
    await w.get('[data-test="ns-model"]').trigger("focus");
    await flushPromises();
    const list = document.querySelector<HTMLElement>('[data-test="ns-model-list"]')!;
    expect(list).not.toBeNull();
    const cls = list.className.split(/\s+/);
    expect(cls).toContain("bg-glass-strong");
    expect(cls).toContain("backdrop-blur-glass");
    expect(cls).toContain("shadow-glass-float");
    w.unmount();
  });
});
