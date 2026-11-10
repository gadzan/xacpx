import { describe, expect, it, vi, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import {
  emptyCapability,
  errorCapability,
  knownEfforts,
  needsSetupCapability,
  readyCapability,
  unsupportedCapability,
  type AgentCapabilityState,
} from "@ganglion/xacpx-relay-protocol";
import { i18n } from "../i18n";
import { effortsForModel, mergeEffortRefresh, tagEffortScope } from "../lib/capability-view";
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

  it("can explicitly refresh a verified catalog after the adapter changes", async () => {
    const wrapper = mountPicker(readyCapability("cache", [{ modelId: "old" }], { fetchedAt: FETCHED }));
    await wrapper.get('[data-test="model-picker-fetch"]').trigger("click");
    expect(wrapper.emitted("fetch")).toEqual([[]]);
    await wrapper.setProps({ state: { status: "loading" } });
    expect(wrapper.find('[data-test="model-picker-fetch"]').exists()).toBe(false);
    await wrapper.setProps({ state: readyCapability("probe", [{ modelId: "new" }], { fetchedAt: FETCHED }) });
    await wrapper.get('[data-test="ns-model"]').trigger("focus");
    expect(wrapper.get('[data-test="model-option"]').attributes("data-model-id")).toBe("new");
    expect(wrapper.find('[data-test="model-picker-fetch"]').exists()).toBe(true);
  });

  it("renders a recovery identical to the reason only once", () => {
    const state = unsupportedCapability(
      { code: "probe-unavailable", message: "Enter a model now." },
      "Enter a model now.",
      { fetchedAt: FETCHED },
    );
    const wrapper = mountPicker(state);
    expect(wrapper.get('[data-test="model-picker-reason"]').text()).toBe("Enter a model now.");
    expect(wrapper.find('[data-test="model-picker-recovery"]').exists()).toBe(false);
  });

  it("hides the bot applies-later note when showAppliesLater is false", async () => {
    const wrapper = mountPicker(readyCapability("cache", [{ modelId: "m" }], { fetchedAt: FETCHED }));
    expect(wrapper.find('[data-test="model-picker-applies-later"]').exists()).toBe(true);
    await wrapper.setProps({ showAppliesLater: false });
    expect(wrapper.find('[data-test="model-picker-applies-later"]').exists()).toBe(false);
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
    // Suggestions render under a group label that marks them unverified.
    expect(unsupportedView.get('[data-test="ns-model-list"]').text()).toContain("Suggestion, not adapter-verified");
    expect(unsupportedView.get('[data-test="model-suggestion"]').text()).toContain("my-config-id");

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

  it("keeps a saved list usable while naming the failed refresh, and offers a retry", async () => {
    const saved = readyCapability("cache", [{ modelId: "gpt-saved", name: "GPT Saved" }], {
      fetchedAt: FETCHED,
      reason: { code: "unauthenticated", message: "the adapter requires authentication before it can list models" },
    });
    const wrapper = mountPicker(saved);
    // The models stay selectable — a failed refresh must not look like no list.
    await wrapper.get('[data-test="ns-model"]').trigger("focus");
    expect(wrapper.get('[data-test="model-option"]').attributes("data-model-id")).toBe("gpt-saved");
    // The stale-ness is stated, not hidden behind a plain ready list.
    expect(wrapper.get('[data-test="model-picker-reason"]').text()).toContain("Saved list");
    expect(wrapper.get('[data-test="model-picker-reason"]').text()).toContain("requires authentication");
    await wrapper.get('[data-test="model-picker-fetch"]').trigger("click");
    expect(wrapper.emitted("fetch")).toBeTruthy();
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

  it("writes ID in capitals in the zh-CN unadvertised custom model line", () => {
    const previous = i18n.global.locale.value;
    i18n.global.locale.value = "zh-CN";
    try {
      const state = readyCapability("runtime", [{ modelId: "gpt-real" }], {
        fetchedAt: FETCHED,
        efforts: { status: "known", options: [] },
      });
      const wrapper = mountPicker(state, "vendor/custom");
      expect(wrapper.get('[data-test="model-picker-effect"]').text()).toBe("自定义 ID vendor/custom 不是适配器公布的模型。");
    } finally {
      i18n.global.locale.value = previous;
    }
  });

  it("refreshes effort options with the model and keeps the previous legal list when the refresh fails", async () => {
    const high = readyCapability("session", [{ modelId: "gpt-a" }], {
      fetchedAt: FETCHED,
      efforts: { status: "known", options: [{ id: "high", name: "high", source: "adapter" }, { id: "low", name: "low", source: "adapter" }] },
    });
    const wrapper = mountPicker(high, "gpt-a", "high");
    await wrapper.get('[data-test="model-picker-effort"]').trigger("click");
    expect(wrapper.findAll('[data-test="effort-option"]').map((option) => option.attributes("data-value"))).toEqual(["", "high", "low"]);
    const xhigh = readyCapability("session", [{ modelId: "gpt-b" }], {
      fetchedAt: FETCHED,
      efforts: { status: "known", options: [{ id: "xhigh", name: "xhigh", source: "adapter" }] },
    });
    await wrapper.setProps({ state: xhigh, model: "gpt-b" });
    expect(wrapper.findAll('[data-test="effort-option"]').map((option) => option.attributes("data-value"))).toEqual(["", "xhigh"]);

    const failed = errorCapability(
      { code: "transport", message: "offline" },
      "Retry.",
      { fetchedAt: FETCHED },
    );
    const merged = mergeEffortRefresh(xhigh, failed);
    expect(merged.efforts).toEqual(xhigh.efforts);
    await wrapper.setProps({ state: failed, carriedEfforts: xhigh.efforts.status === "known" ? xhigh.efforts.options : [] });
    expect(wrapper.findAll('[data-test="effort-option"]').map((option) => option.attributes("data-value"))).toEqual(["", "xhigh"]);
    expect(wrapper.get('[data-test="model-picker-reason"]').text()).toContain("offline");
  });
});

describe("ModelPicker state matrix", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("marks a stale list with its last-verified time and keeps it selectable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T00:06:00.000Z"));
    const state = readyCapability("cache", [{ modelId: "gpt-saved", name: "GPT Saved" }], {
      fetchedAt: FETCHED,
      freshness: "stale",
      lastVerifiedAt: "2026-10-09T00:03:00.000Z",
    });
    const wrapper = mountPicker(state);
    expect(wrapper.get('[data-test="model-picker-stale"]').text()).toContain("3 min ago");
    expect(wrapper.find('[data-test="model-picker-fetch"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="model-picker-refreshing"]').exists()).toBe(false);
    await wrapper.get('[data-test="ns-model"]').trigger("focus");
    await wrapper.get('[data-test="model-option"]').trigger("mousedown");
    expect(wrapper.emitted("update:model")?.[0]).toEqual(["gpt-saved"]);
  });

  it("shows a fresh list without any stale marker", () => {
    const state = readyCapability("cache", [{ modelId: "gpt-fresh" }], {
      fetchedAt: FETCHED,
      freshness: "fresh",
      lastVerifiedAt: FETCHED,
    });
    const wrapper = mountPicker(state);
    expect(wrapper.find('[data-test="model-picker-stale"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="model-picker-refreshing"]').exists()).toBe(false);
  });

  it("keeps the old list up while a background refresh runs", async () => {
    const state = readyCapability("cache", [{ modelId: "gpt-saved" }], {
      fetchedAt: FETCHED,
      freshness: "stale",
      refreshing: true,
      lastVerifiedAt: FETCHED,
    });
    const wrapper = mountPicker(state);
    expect(wrapper.get('[data-test="model-picker-refreshing"]').text()).toContain("background");
    await wrapper.get('[data-test="ns-model"]').trigger("focus");
    expect(wrapper.get('[data-test="model-option"]').attributes("data-model-id")).toBe("gpt-saved");
  });

  it("renders empty with default, custom id, and suggestions usable", async () => {
    const state = emptyCapability(
      { code: "discovery-available", message: "the adapter answered but advertised no models" },
      "Use the default model or type a custom id.",
      { fetchedAt: FETCHED, suggestions: ["my-config-id"] },
    );
    const wrapper = mountPicker(state);
    expect(wrapper.get('[data-test="model-picker-reason"]').text()).toContain("no models");
    expect(wrapper.get('[data-test="model-picker-recovery"]').text()).toContain("custom id");
    await wrapper.get('[data-test="ns-model"]').trigger("focus");
    expect(wrapper.find('[data-test="model-option"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="model-picker-default"]').text()).toContain("Default");
    expect(wrapper.get('[data-test="model-suggestion"]').text()).toContain("my-config-id");
    await wrapper.get('[data-test="ns-model"]').setValue("vendor/custom");
    expect(wrapper.emitted("update:model")?.at(-1)).toEqual(["vendor/custom"]);
  });

  it("hides effort options scoped to another model", async () => {
    const state = readyCapability("session", [{ modelId: "gpt-a" }, { modelId: "gpt-b" }], {
      fetchedAt: FETCHED,
      efforts: knownEfforts(["high"], "high", "gpt-a"),
    });
    const scoped = mountPicker(state, "gpt-a");
    await scoped.get('[data-test="model-picker-effort"]').trigger("click");
    expect(scoped.findAll('[data-test="effort-option"]').map((o) => o.attributes("data-value"))).toEqual(["", "high"]);
    const other = mountPicker(state, "gpt-b");
    expect(other.find('[data-test="model-picker-effort"]').element.tagName).toBe("INPUT");
  });

  it("writes the zh-CN stale line", () => {
    const previous = i18n.global.locale.value;
    i18n.global.locale.value = "zh-CN";
    try {
      const wrapper = mountPicker(readyCapability("cache", [{ modelId: "m" }], {
        fetchedAt: FETCHED, freshness: "stale",
      }));
      expect(wrapper.get('[data-test="model-picker-stale"]').text()).toBe("列表已过期。");
    } finally {
      i18n.global.locale.value = previous;
    }
  });
});

describe("effort model scope", () => {
  it("tags an untagged list with the model in effect at read", () => {
    const untagged = readyCapability("session", [{ modelId: "gpt-a" }], {
      fetchedAt: FETCHED, efforts: knownEfforts(["high"]),
    });
    const tagged = tagEffortScope(untagged, "gpt-a");
    const scoped = effortsForModel(tagged, "gpt-a");
    expect(scoped?.status).toBe("known");
    if (scoped?.status === "known") expect(scoped.options.map((o) => o.id)).toEqual(["high"]);
    const already = readyCapability("session", [{ modelId: "gpt-a" }], {
      fetchedAt: FETCHED, efforts: knownEfforts(["high"], undefined, "gpt-a"),
    });
    expect(tagEffortScope(already, "gpt-b")).toBe(already);
  });

  it("a cold probe never yields known efforts", () => {
    const probe = readyCapability("probe", [{ modelId: "gpt-a" }], {
      fetchedAt: FETCHED, efforts: knownEfforts(["high"], undefined, "gpt-a"),
    });
    const merged = mergeEffortRefresh(undefined, probe, "gpt-a");
    expect(merged.efforts).toEqual({ status: "unavailable" });
    expect(merged.state.status).toBe("ready");
  });

  it("a model switch drops the previous model's carried efforts", () => {
    const previous = readyCapability("session", [{ modelId: "gpt-a" }], {
      fetchedAt: FETCHED, efforts: knownEfforts(["high"], undefined, "gpt-a"),
    });
    const failed = errorCapability({ code: "transport", message: "offline" }, "Retry.", { fetchedAt: FETCHED });
    expect(mergeEffortRefresh(previous, failed, "gpt-a").efforts?.status).toBe("known");
    expect(mergeEffortRefresh(previous, failed, "gpt-b").efforts).toBeUndefined();
    const other = readyCapability("session", [{ modelId: "gpt-b" }], {
      fetchedAt: FETCHED, efforts: knownEfforts(["xhigh"], undefined, "gpt-b"),
    });
    expect(mergeEffortRefresh(previous, other, "gpt-a").efforts).toBeUndefined();
  });

  it("an empty pick with no applied model drops a tagged carry", () => {
    const previous = readyCapability("session", [{ modelId: "gpt-a" }], {
      fetchedAt: FETCHED, efforts: knownEfforts(["high"], undefined, "gpt-a"),
    });
    const failed = errorCapability({ code: "transport", message: "offline" }, "Retry.", { fetchedAt: FETCHED });
    expect(mergeEffortRefresh(previous, failed, undefined).efforts).toBeUndefined();
    expect(mergeEffortRefresh(previous, failed, "").efforts).toBeUndefined();
    // Untagged legacy lists still carry when no scope was ever proven.
    const legacy = readyCapability("session", [{ modelId: "gpt-a" }], {
      fetchedAt: FETCHED, efforts: knownEfforts(["high"]),
    });
    expect(mergeEffortRefresh(legacy, failed, undefined).efforts?.status).toBe("known");
  });
});