// packages/relay-web/src/__tests__/ui-switch.test.ts
import { expect, test } from "vitest";
import { mount } from "@vue/test-utils";
import UiSwitch from "../components/UiSwitch.vue";

// Geometry is measured on the real surfaces in e2e/surface-geometry.spec.ts;
// this file pins the behaviour every caller relies on.
test("carries the switch semantics, not button semantics", () => {
  const off = mount(UiSwitch, { props: { checked: false, label: "Desktop notifications", testId: "sw" } });
  const el = off.get('[data-test="sw"]');
  expect(el.element.tagName).toBe("BUTTON");
  expect(el.attributes("role")).toBe("switch");
  expect(el.attributes("aria-checked")).toBe("false");
  expect(el.attributes("aria-label")).toBe("Desktop notifications");
  expect(el.text()).toBe("");

  const on = mount(UiSwitch, { props: { checked: true, label: "Desktop notifications" } });
  expect(on.get('[role="switch"]').attributes("aria-checked")).toBe("true");
});

test("reports busy and disabled states to assistive tech", () => {
  const w = mount(UiSwitch, { props: { checked: false, label: "Terminal", busy: true, disabled: true } });
  const el = w.get('[role="switch"]');
  expect(el.attributes("aria-busy")).toBe("true");
  expect(el.attributes("disabled")).toBeDefined();
});

test("emits one toggle per tap, and none while disabled", async () => {
  const live = mount(UiSwitch, { props: { checked: false, label: "Files" } });
  await live.get('[role="switch"]').trigger("click");
  await live.get('[role="switch"]').trigger("click");
  expect(live.emitted("toggle")).toHaveLength(2);

  const locked = mount(UiSwitch, { props: { checked: false, label: "Files", disabled: true } });
  await locked.get('[role="switch"]').trigger("click");
  expect(locked.emitted("toggle")).toBeUndefined();
});
