import { mount } from "@vue/test-utils";
import { beforeEach, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import SessionModelBanner from "../components/SessionModelBanner.vue";
import { useSessionControlsStore } from "../stores/session-controls";

beforeEach(() => {
  setActivePinia(createPinia());
  document.body.innerHTML = "";
});

function banner(): Element | null {
  return document.body.querySelector('[data-test="model-banner"]');
}

it("shows an automatic load failure in the global banner", async () => {
  const controls = useSessionControlsStore();
  controls.modelError = 'bridge request "getSessionModel" timed out after 45000ms';
  controls.modelErrorSource = "load";

  mount(SessionModelBanner);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const el = banner();
  expect(el).not.toBeNull();
  // Long bridge diagnostics wrap and scroll instead of being clipped by the composer.
  expect(el?.textContent).toContain('bridge request "getSessionModel" timed out after 45000ms');
  expect(el?.textContent).toContain("Model state unavailable");
});

it("keeps explicit switch failures on the toast and out of the banner", async () => {
  const controls = useSessionControlsStore();
  controls.modelError = "requested model-b; authoritative model is model-a";
  controls.modelErrorSource = "set";

  mount(SessionModelBanner);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(banner()).toBeNull();
});

it("dismisses the banner and clears the diagnostic", async () => {
  const controls = useSessionControlsStore();
  controls.modelError = "timed out";
  controls.modelErrorSource = "load";

  const wrapper = mount(SessionModelBanner);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const dismiss = document.body.querySelector<HTMLButtonElement>('[data-test="model-banner-dismiss"]');
  expect(dismiss).not.toBeNull();
  dismiss?.click();
  await wrapper.vm.$nextTick();

  expect(banner()).toBeNull();
  expect(controls.modelError).toBe("");
  expect(controls.modelErrorSource).toBe("");
});
