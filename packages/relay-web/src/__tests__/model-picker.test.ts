import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import {
  errorCapability,
  needsSetupCapability,
  readyCapability,
  unsupportedCapability,
  type AgentCapabilityState,
} from "@ganglion/xacpx-relay-protocol";
import { i18n } from "../i18n";
import { mergeEffortRefresh } from "../lib/capability-view";
import ModelPicker from "../components/ModelPicker.vue";

const FETCHED = "2026-10-09T00:00:00.000Z";

function mountPicker(state: { status: "loading" } | AgentCapabilityState, model = "", effort = "", carried: Array<{ id: string; name: string }> = []) {
  return mount(ModelPicker, {
    props: { state, model, effort, carriedEfforts: carried, audience: "bot", modelTestId: "ns-model", listTestId: "ns-model-list" },
    global: { plugins: [i18n] },
  });
}

describe("ModelPicker", () => {
  it("shows a loading state without a model list", () => {
    const wrapper = mountPicker({ status: "loading" });
    expect(wrapper.get('[data-test="model-picker-loading"]').text()).toContain("Loading models");
    expect(wrapper.find('[data-test="model-option"]').exists()).toBe(false);
  });

  it("lists adapter models, keeps the id intact, and offers default plus custom entry", async () => {
    const state = readyCapability("probe", [
      { modelId: "gpt-5.5[high]", name: "GPT 5.5 high" },
    ], { fetchedAt: FETCHED, efforts: { status: "known", options: [{ id: "high", name: "high", source: "adapter" }] } });
    const wrapper = mountPicker(state);
    await wrapper.get('[data-test="ns-model"]').trigger("focus");
    expect(wrapper.get('[data-test="model-picker-default"]').text()).toContain("Default");
    const option = wrapper.get('[data-test="model-option"]');
    expect(option.attributes("data-model-id")).toBe("gpt-5.5[high]");
    expect(option.text()).toContain("GPT 5.5 high");
    await option.trigger("mousedown");
    expect(wrapper.emitted("update:model")?.[0]).toEqual(["gpt-5.5[high]"]);
    await wrapper.get('[data-test="ns-model"]').setValue("vendor/custom");
    expect(wrapper.emitted("update:model")?.at(-1)).toEqual(["vendor/custom"]);
  });

  it("shows unsupported and needs-setup with a reason, and keeps suggestions unmarked as adapter models", async () => {
    const unsupported = unsupportedCapability(
      { code: "adapter-cannot-enumerate", message: "this adapter cannot list models" },
      "Type a custom id or use the default.",
      { fetchedAt: FETCHED, suggestions: ["my-config-id"] },
    );
    const unsupportedView = mountPicker(unsupported);
    expect(unsupportedView.get('[data-test="model-picker-reason"]').text()).toContain("cannot list models");
    expect(unsupportedView.get('[data-test="model-picker-recovery"]').text()).toContain("custom id");
    await unsupportedView.get('[data-test="ns-model"]').trigger("focus");
    expect(unsupportedView.find('[data-test="model-option"]').exists()).toBe(false);
    expect(unsupportedView.get('[data-test="model-suggestion"]').text()).toContain("my-config-id");
    expect(unsupportedView.get('[data-test="model-suggestion"]').text()).toContain("not adapter-verified");

    const setup = needsSetupCapability(
      { code: "discovery-available", message: "no saved model list" },
      "Fetch the model list.",
      { fetchedAt: FETCHED },
    );
    const setupView = mountPicker(setup);
    expect(setupView.get('[data-test="model-picker-fetch"]').text()).toContain("Fetch model list");
    await setupView.get('[data-test="model-picker-fetch"]').trigger("click");
    expect(setupView.emitted("fetch")).toBeTruthy();
  });

  it("shows an error and a retry without presenting an empty catalog as success", async () => {
    const wrapper = mountPicker(errorCapability(
      { code: "timeout", message: "the probe timed out" },
      "Retry the model fetch.",
      { fetchedAt: FETCHED },
    ));
    expect(wrapper.get('[data-test="model-picker-reason"]').text()).toContain("timed out");
    await wrapper.get('[data-test="model-picker-retry"]').trigger("click");
    expect(wrapper.emitted("fetch")).toBeTruthy();
    expect(wrapper.find('[data-test="model-option"]').exists()).toBe(false);
  });

  it("does not present an unadvertised custom id as the model that took effect", () => {
    const state = readyCapability("runtime", [{ modelId: "gpt-real" }], {
      fetchedAt: FETCHED,
      appliedModelId: "gpt-real",
      efforts: { status: "known", options: [] },
    });
    const wrapper = mountPicker(state, "not-a-real-model");
    expect(wrapper.get('[data-test="model-picker-effect"]').text()).toContain("did not take effect");
    expect(wrapper.get('[data-test="model-picker-effect"]').text()).toContain("gpt-real");
  });

  it("refreshes effort options with the model and keeps the previous legal list when the refresh fails", async () => {
    const high = readyCapability("session", [{ modelId: "gpt-a" }], {
      fetchedAt: FETCHED,
      efforts: { status: "known", options: [{ id: "high", name: "high", source: "adapter" }, { id: "low", name: "low", source: "adapter" }] },
    });
    const wrapper = mountPicker(high, "gpt-a", "high");
    expect(wrapper.findAll('[data-test="effort-option"]').map((option) => option.attributes("value"))).toEqual(["high", "low"]);
    const xhigh = readyCapability("session", [{ modelId: "gpt-b" }], {
      fetchedAt: FETCHED,
      efforts: { status: "known", options: [{ id: "xhigh", name: "xhigh", source: "adapter" }] },
    });
    await wrapper.setProps({ state: xhigh, model: "gpt-b" });
    expect(wrapper.findAll('[data-test="effort-option"]').map((option) => option.attributes("value"))).toEqual(["xhigh"]);

    const failed = errorCapability(
      { code: "transport", message: "offline" },
      "Retry.",
      { fetchedAt: FETCHED },
    );
    const merged = mergeEffortRefresh(xhigh, failed);
    expect(merged.efforts).toEqual(xhigh.efforts);
    await wrapper.setProps({ state: failed, carriedEfforts: xhigh.efforts.status === "known" ? xhigh.efforts.options : [] });
    expect(wrapper.findAll('[data-test="effort-option"]').map((option) => option.attributes("value"))).toEqual(["xhigh"]);
    expect(wrapper.get('[data-test="model-picker-reason"]').text()).toContain("offline");
  });
});
