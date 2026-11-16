import { mount } from "@vue/test-utils";
import { test, expect, vi, afterEach } from "vitest";
import Tooltip from "../components/Tooltip.vue";

// The bubble is the only way a thumb learns what an icon button does, so its
// show/hide contract is pinned here: pointer-enter shows it (immediately for a
// touch pointer, after the hover delay for a mouse), pointer-leave hides it, and
// it lives in <body> so no overflow-hidden ancestor can clip it.

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function mountTip() {
  return mount(Tooltip, {
    props: { text: "Open the process for Ada" },
    slots: { default: `<button data-test="trigger">i</button>` },
    attachTo: document.body,
  });
}

const bubble = () => document.querySelector('[data-test="tooltip"]');

test("shows after the hover delay and hides on leave", async () => {
  vi.useFakeTimers();
  const wrapper = mountTip();
  const anchor = wrapper.element as HTMLElement;

  anchor.dispatchEvent(new MouseEvent("pointerenter"));
  expect(bubble()).toBeNull();
  vi.advanceTimersByTime(300);
  await wrapper.vm.$nextTick();

  expect(bubble()).not.toBeNull();
  expect(bubble()!.textContent).toContain("Ada");
  expect(bubble()!.getAttribute("role")).toBe("tooltip");
  // Teleported out of the component tree.
  expect(bubble()!.closest("body")).toBe(document.body);

  anchor.dispatchEvent(new MouseEvent("pointerleave"));
  await wrapper.vm.$nextTick();
  expect(bubble()).toBeNull();
  wrapper.unmount();
});

test("a touch pointer shows it without the delay", async () => {
  const wrapper = mountTip();
  const anchor = wrapper.element as HTMLElement;
  const enter = new Event("pointerenter");
  Object.defineProperty(enter, "pointerType", { value: "touch" });

  anchor.dispatchEvent(enter);
  await wrapper.vm.$nextTick();
  expect(bubble()).not.toBeNull();
  wrapper.unmount();
});

test("keyboard focus shows it too", async () => {
  vi.useFakeTimers();
  const wrapper = mountTip();
  (wrapper.element as HTMLElement).dispatchEvent(new FocusEvent("focusin"));
  await wrapper.vm.$nextTick();
  expect(bubble()).not.toBeNull();
  wrapper.unmount();
});
