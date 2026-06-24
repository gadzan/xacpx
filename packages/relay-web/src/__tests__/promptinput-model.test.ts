import { mount } from "@vue/test-utils";
import { beforeEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const rpc = vi.fn();
vi.mock("../api/client", () => ({
  ApiError: class extends Error {},
  api: { rpc: (id: string, type: string, payload?: unknown) => rpc(id, type, payload) },
}));

import PromptInput from "../components/PromptInput.vue";

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  rpc.mockReset();
});

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

it("renders the model chip with the current model and lets you switch", async () => {
  rpc.mockResolvedValueOnce({ current: "gpt-5.2[high]", available: ["gpt-5.2[high]", "gpt-5.2[low]"] });
  const w = mount(PromptInput, { props: { instanceId: "i1", sessionAlias: "backend" }, global: { plugins: [pinia] } });
  await flush();
  await w.vm.$nextTick();

  const chip = w.find('[data-test="model-chip"]');
  expect(chip.exists()).toBe(true);
  // Display normalizes the bracketed reasoning-effort suffix to model/effort (display only).
  expect(chip.text()).toContain("gpt-5.2/high");
  expect(chip.text()).not.toContain("gpt-5.2[high]");

  await chip.trigger("click");
  const options = w.findAll('[data-test="model-option"]');
  expect(options.length).toBe(2);
  expect(options[1].text()).toContain("gpt-5.2/low"); // option label is normalized too

  rpc.mockResolvedValueOnce({ ok: true });
  // ...but selecting still sends the RAW agent-advertised id, not the normalized label.
  await options[1].trigger("click");
  await flush();
  expect(rpc).toHaveBeenLastCalledWith("i1", "control.session.model.set", { sessionAlias: "backend", modelId: "gpt-5.2[low]" });
});

it("hides the chip when there is no session", () => {
  const w = mount(PromptInput, { props: {}, global: { plugins: [pinia] } });
  expect(w.find('[data-test="model-chip"]').exists()).toBe(false);
});
