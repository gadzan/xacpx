import { mount } from "@vue/test-utils";
import { beforeEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const rpc = vi.fn();
vi.mock("../api/client", () => ({
  ApiError: class extends Error {},
  api: { rpc: (id: string, type: string, payload?: unknown) => rpc(id, type, payload) },
}));

import PromptInput from "../components/PromptInput.vue";
import { dismissToast, useToasts } from "../lib/use-toasts";
import { useChatStore } from "../stores/chat";
import { useSessionControlsStore } from "../stores/session-controls";
import { useInstancesStore } from "../stores/instances";

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  rpc.mockReset();
  for (const toast of [...useToasts().value]) dismissToast(toast.id);
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
  expect(rpc).toHaveBeenCalledWith("i1", "control.session.model.set", { sessionAlias: "backend", modelId: "gpt-5.2[low]" });
});

it("hides the chip when there is no session", () => {
  const w = mount(PromptInput, { props: {}, global: { plugins: [pinia] } });
  expect(w.find('[data-test="model-chip"]').exists()).toBe(false);
});

it("shows a model-switch failure through the global toast instead of beside the chip", async () => {
  rpc.mockResolvedValueOnce({ current: "gpt-5.2[high]", available: ["gpt-5.2[high]", "gpt-5.2[low]"] });
  const w = mount(PromptInput, { props: { instanceId: "i1", sessionAlias: "backend" }, global: { plugins: [pinia] } });
  await flush();
  await w.get('[data-test="model-chip"]').trigger("click");

  rpc.mockResolvedValueOnce({ error: { code: "internal", message: "acpx command timed out during set-model after 30s" } });
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await w.findAll('[data-test="model-option"]')[1].trigger("click");
  await flush();

  expect(w.find('[data-test="model-error"]').exists()).toBe(false);
  expect(useToasts().value[0]).toMatchObject({ tone: "error", key: "chat.modelSetFailed" });
  log.mockRestore();
});

it("shows an effort chip only when the adapter advertises choices and switches effort", async () => {
  rpc.mockImplementation(async (_instanceId: string, type: string) => {
    if (type === "control.session.model.get") return { current: "gpt-5.2", available: ["gpt-5.2"] };
    if (type === "control.session.effort.get") {
      return { current: "medium", available: ["low", "medium", "high"] };
    }
    if (type === "control.session.effort.set") return { ok: true, current: "high" };
    return {};
  });
  const w = mount(PromptInput, {
    props: { instanceId: "i1", sessionAlias: "backend" },
    global: { plugins: [pinia] },
  });
  await flush();
  await w.vm.$nextTick();

  const chip = w.get('[data-test="effort-chip"]');
  expect(chip.text()).toContain("medium");
  await chip.trigger("click");
  const options = w.findAll('[data-test="effort-option"]');
  expect(options.map((option) => option.text())).toEqual(["low", "medium", "high"]);
  await options[2].trigger("click");
  await flush();

  expect(rpc).toHaveBeenLastCalledWith("i1", "control.session.effort.set", {
    sessionAlias: "backend",
    effort: "high",
  });
});

it("refreshes adapter-advertised effort choices after switching models", async () => {
  let effortReads = 0;
  rpc.mockImplementation(async (_instanceId: string, type: string) => {
    if (type === "control.session.model.get") {
      return { current: "model-a", available: ["model-a", "model-b"] };
    }
    if (type === "control.session.model.set") return { ok: true, current: "model-b" };
    if (type === "control.session.effort.get") {
      effortReads += 1;
      return effortReads === 1
        ? { current: "medium", available: ["medium", "high"] }
        : { current: "xhigh", available: ["high", "xhigh"] };
    }
    return {};
  });
  const w = mount(PromptInput, {
    props: { instanceId: "i1", sessionAlias: "backend" },
    global: { plugins: [pinia] },
  });
  await flush();
  await w.vm.$nextTick();

  await w.get('[data-test="model-chip"]').trigger("click");
  await w.findAll('[data-test="model-option"]')[1].trigger("click");
  await flush();
  await w.vm.$nextTick();

  expect(effortReads).toBe(2);
  expect(w.get('[data-test="effort-chip"]').text()).toContain("xhigh");
  await w.get('[data-test="effort-chip"]').trigger("click");
  expect(w.findAll('[data-test="effort-option"]').map((option) => option.text()))
    .toEqual(["high", "xhigh"]);
});

it("OMP restore failure: refresh fetches via refresh RPC and replacement selection clears only the matching error", async () => {
  const chat = useChatStore();
  const instancesStore = useInstancesStore();
  // On a pinia store the setup-ref is already unwrapped: `store.instances` IS
  // the array. Writing `store.instances.value` parks the rows on a detached
  // object and findSessionRow never sees them.
  instancesStore.instances = [{ id: "i1", sessions: [{ alias: "backend", agent: "omp", driver: "omp", workspace: "w" }] }] as never;
  chat.error = 'Could not restore model gpt-5.2[high]: the ACP agent did not advertise that model';
  rpc.mockResolvedValueOnce({ current: "gpt-5.2[high]", available: ["gpt-5.2[high]"] });
  const w = mount(PromptInput, { props: { instanceId: "i1", sessionAlias: "backend" }, global: { plugins: [pinia] } });
  await flush();

  rpc.mockResolvedValueOnce({ current: "gpt-5.2[high]", available: ["gpt-5.2[high]"] });
  await w.vm.refreshModels();
  expect(rpc).toHaveBeenLastCalledWith("i1", "control.session.model.get", { sessionAlias: "backend", refresh: true });

  rpc.mockResolvedValueOnce({ ok: true, current: "gpt-5.2[low]" });
  await w.findAll('[data-test="model-option"]')[0].trigger("click");
  await flush();
  // pickModel follows the set with an effort reload (existing behavior), so the
  // set call is the second-to-last RPC; assert it specifically instead of
  // "last called with".
  expect(rpc).toHaveBeenCalledWith("i1", "control.session.model.set", { sessionAlias: "backend", modelId: "gpt-5.2[high]" });
  expect(chat.error).toBe("");
});

it("a refresh that lands after the session switched does not publish to the new session", async () => {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  rpc.mockResolvedValueOnce({ current: "model-a", available: ["model-a"] });
  const w = mount(PromptInput, { props: { instanceId: "i1", sessionAlias: "session-a" }, global: { plugins: [pinia] } });
  await flush();

  rpc.mockReturnValueOnce(promise);
  const pending = w.vm.refreshModels();
  await w.setProps({ sessionAlias: "session-b" });
  resolve({ current: "stale-a", available: ["stale-a"] });
  await pending;

  const controls = useSessionControlsStore();
  expect(controls.modelCurrent).toBeUndefined();
  expect(controls.modelAvailable).toEqual([]);
});

it("a deferred model set followed by a session switch leaves the new session's chip enabled", async () => {
  // Seed RPC by method so initial load/effort reads can't steal the set mock.
  const setDeferred = Promise.withResolvers<unknown>();
  rpc.mockImplementation(async (_instanceId: string, type: string, payload?: unknown) => {
    if (type === "control.session.model.set") return setDeferred.promise;
    if (type === "control.session.model.get") {
      const alias = payload && typeof payload === "object" && "sessionAlias" in payload
        ? String(payload.sessionAlias)
        : "";
      return alias === "session-a"
        ? { current: "model-a", available: ["model-a", "model-b"] }
        : { current: "model-x", available: ["model-x"] };
    }
    return {};
  });
  const w = mount(PromptInput, { props: { instanceId: "i1", sessionAlias: "session-a" }, global: { plugins: [pinia] } });
  await flush();
  await w.vm.$nextTick();

  await w.get('[data-test="model-chip"]').trigger("click");
  await w.findAll('[data-test="model-option"]')[0].trigger("click"); // starts the deferred set
  await w.vm.$nextTick();
  expect((w.get('[data-test="model-chip"]').element as HTMLButtonElement).disabled).toBe(true);

  await w.setProps({ sessionAlias: "session-b" });
  await flush();
  await w.vm.$nextTick();

  setDeferred.resolve({ ok: true, current: "model-a" }); // stale op lands after the switch
  await flush();
  await w.vm.$nextTick();

  expect((w.get('[data-test="model-chip"]').element as HTMLButtonElement).disabled).toBe(false);
});
