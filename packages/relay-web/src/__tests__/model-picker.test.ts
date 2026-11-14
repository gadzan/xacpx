import { describe, expect, it, vi, afterEach } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
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

function mountPicker(state: { status: "loading" } | AgentCapabilityState, model = "", effort = "", carried: Array<{ id: string; name: string }> = []): VueWrapper {
  return mount(ModelPicker, {
    props: { state, model, effort, carriedEfforts: carried, audience: "bot", modelTestId: "ns-model", listTestId: "ns-model-list" },
    global: { plugins: [i18n] },
  });
}

function refreshControl(wrapper: VueWrapper) {
  return wrapper.get('[data-test="model-picker-refresh"]');
}
function isSpinning(wrapper: VueWrapper): boolean {
  return refreshControl(wrapper).find("svg").classes().includes("animate-spin");
}

describe("ModelPicker", () => {
  it("spins the refresh icon during the first load, with no prose and no list", () => {
    const wrapper = mountPicker({ status: "loading" });
    expect(isSpinning(wrapper)).toBe(true);
    expect(refreshControl(wrapper).attributes("disabled")).toBeDefined();
    expect(wrapper.find('[data-test="model-option"]').exists()).toBe(false);
    expect(wrapper.findAll("p")).toHaveLength(2);
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

  it("refreshes a verified catalog from the icon and stays selectable while it runs", async () => {
    const wrapper = mountPicker(readyCapability("cache", [{ modelId: "old" }], { fetchedAt: FETCHED }));
    expect(isSpinning(wrapper)).toBe(false);
    await refreshControl(wrapper).trigger("click");
    expect(wrapper.emitted("fetch")).toEqual([[]]);
    await wrapper.setProps({ state: { status: "loading" } });
    expect(isSpinning(wrapper)).toBe(true);
    await wrapper.setProps({ state: readyCapability("probe", [{ modelId: "new" }], { fetchedAt: FETCHED }) });
    await wrapper.get('[data-test="ns-model"]').trigger("focus");
    expect(wrapper.get('[data-test="model-option"]').attributes("data-model-id")).toBe("new");
    expect(isSpinning(wrapper)).toBe(false);
  });

  it("keeps the fields usable while a silent re-read is in flight", async () => {
    const wrapper = mountPicker(readyCapability("cache", [{ modelId: "gpt-saved" }], { fetchedAt: FETCHED }), "gpt-saved");
    await wrapper.setProps({ refreshing: true });
    expect(isSpinning(wrapper)).toBe(true);
    expect(refreshControl(wrapper).attributes("disabled")).toBeDefined();
    await wrapper.get('[data-test="ns-model"]').trigger("focus");
    expect(wrapper.get('[data-test="model-option"]').attributes("data-model-id")).toBe("gpt-saved");
    await wrapper.get('[data-test="model-option"]').trigger("mousedown");
    expect(wrapper.emitted("update:model")?.[0]).toEqual(["gpt-saved"]);
  });

  it("puts the failure reason on the icon instead of a prose hint", () => {
    const state = unsupportedCapability(
      { code: "probe-unavailable", message: "Enter a model now." },
      "Enter a model now.",
      { fetchedAt: FETCHED },
    );
    const wrapper = mountPicker(state);
    const control = refreshControl(wrapper);
    expect(control.attributes("title")).toBe("Refresh models. Last read failed: Enter a model now.");
    expect(control.attributes("aria-label")).toBe(control.attributes("title"));
    expect(control.classes()).toContain("text-danger");
  });

  it("carries a needs-setup recovery next to the failure instead of dropping it", () => {
    const setup = needsSetupCapability(
      { code: "discovery-available", message: "no saved model list" },
      "Fetch the model list.",
      { fetchedAt: FETCHED },
    );
    const wrapper = mountPicker(setup);
    const control = refreshControl(wrapper);
    expect(control.attributes("title")).toBe("Refresh models. no saved model list. Fetch the model list.");
    expect(control.classes()).not.toContain("text-danger");
  });

  it("states a real read failure as a failure and then the recovery", () => {
    const wrapper = mountPicker(errorCapability(
      { code: "timeout", message: "the probe timed out" },
      "Retry the model fetch.",
      { fetchedAt: FETCHED },
    ));
    const control = refreshControl(wrapper);
    expect(control.attributes("title")).toBe("Refresh models. Last read failed: the probe timed out. Retry the model fetch.");
    expect(control.classes()).toContain("text-danger");
  });

  it("keeps the refresh enabled while the daemon says a background probe is running", async () => {
    // A daemon-reported `refreshing` bit can outlive the background probe: no
    // completion event replaces it. Disabling the only retry leaves the user
    // with no way to force a fresh read.
    const wrapper = mountPicker(readyCapability("cache", [{ modelId: "gpt-saved" }], {
      fetchedAt: FETCHED,
      freshness: "stale",
      refreshing: true,
      lastVerifiedAt: FETCHED,
    }));
    expect(isSpinning(wrapper)).toBe(true);
    const control = refreshControl(wrapper);
    expect(control.attributes("disabled")).toBeUndefined();
    await control.trigger("click");
    expect(wrapper.emitted("fetch")).toEqual([[]]);
  });

  it("does not double-terminate a reason that already ends in punctuation", () => {
    const wrapper = mountPicker(errorCapability(
      { code: "transport", message: "Authentication required!" },
      "Sign in again?",
      { fetchedAt: FETCHED },
    ));
    const title = refreshControl(wrapper).attributes("title")!;
    expect(title).not.toMatch(/[!?。！？][.。]/);
    expect(title).toContain("Authentication required!");
    expect(title).toContain("Sign in again?");
  });

  it("drops a recovery made only of punctuation", () => {
    const wrapper = mountPicker(errorCapability(
      { code: "transport", message: "the probe timed out" },
      "...",
      { fetchedAt: FETCHED },
    ));
    const title = refreshControl(wrapper).attributes("title")!;
    expect(title).toBe("Refresh models. Last read failed: the probe timed out.");
  });

  it("hides the bot applies-later note when showAppliesLater is false", async () => {
    const wrapper = mountPicker(readyCapability("cache", [{ modelId: "m" }], { fetchedAt: FETCHED }));
    expect(wrapper.find('[data-test="model-picker-applies-later"]').exists()).toBe(true);
    await wrapper.setProps({ showAppliesLater: false });
    expect(wrapper.find('[data-test="model-picker-applies-later"]').exists()).toBe(false);
  });

  it("keeps suggestions unmarked as adapter models behind a silent refresh icon", async () => {
    const unsupported = unsupportedCapability(
      { code: "adapter-cannot-enumerate", message: "this adapter cannot list models" },
      "Type a custom id or use the default.",
      { fetchedAt: FETCHED, suggestions: ["my-config-id"] },
    );
    const unsupportedView = mountPicker(unsupported);
    expect(refreshControl(unsupportedView).attributes("title")).toContain("cannot list models");
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
    expect(setupView.findAll("button")).toHaveLength(1);
    await refreshControl(setupView).trigger("click");
    expect(setupView.emitted("fetch")).toEqual([[]]);
  });

  it("reports an error through the icon without presenting an empty catalog as success", async () => {
    const wrapper = mountPicker(errorCapability(
      { code: "timeout", message: "the probe timed out" },
      "Retry the model fetch.",
      { fetchedAt: FETCHED },
    ));
    expect(refreshControl(wrapper).attributes("title")).toContain("timed out");
    await refreshControl(wrapper).trigger("click");
    expect(wrapper.emitted("fetch")).toEqual([[]]);
    expect(wrapper.find('[data-test="model-option"]').exists()).toBe(false);
  });

  it("keeps a saved list usable while naming the failed refresh on the icon", async () => {
    const saved = readyCapability("cache", [{ modelId: "gpt-saved", name: "GPT Saved" }], {
      fetchedAt: FETCHED,
      reason: { code: "unauthenticated", message: "the adapter requires authentication before it can list models" },
    });
    const wrapper = mountPicker(saved);
    // The models stay selectable — a failed refresh must not look like no list.
    await wrapper.get('[data-test="ns-model"]').trigger("focus");
    expect(wrapper.get('[data-test="model-option"]').attributes("data-model-id")).toBe("gpt-saved");
    // The stale-ness is stated, not hidden behind a plain ready list.
    expect(refreshControl(wrapper).attributes("title")).toContain("requires authentication");
    expect(refreshControl(wrapper).classes()).toContain("text-danger");
    await refreshControl(wrapper).trigger("click");
    expect(wrapper.emitted("fetch")).toEqual([[]]);
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
    expect(refreshControl(wrapper).attributes("title")).toContain("offline");
  });
});

describe("ModelPicker state matrix", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("keeps a stale list selectable without claiming anything in prose", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T00:06:00.000Z"));
    const state = readyCapability("cache", [{ modelId: "gpt-saved", name: "GPT Saved" }], {
      fetchedAt: FETCHED,
      freshness: "stale",
      lastVerifiedAt: "2026-10-09T00:03:00.000Z",
    });
    const wrapper = mountPicker(state);
    expect(refreshControl(wrapper).classes()).not.toContain("text-danger");
    expect(isSpinning(wrapper)).toBe(false);
    await wrapper.get('[data-test="ns-model"]').trigger("focus");
    await wrapper.get('[data-test="model-option"]').trigger("mousedown");
    expect(wrapper.emitted("update:model")?.[0]).toEqual(["gpt-saved"]);
  });

  it("spins for the daemon's background probe and keeps the old list up", async () => {
    const state = readyCapability("cache", [{ modelId: "gpt-saved" }], {
      fetchedAt: FETCHED,
      freshness: "stale",
      refreshing: true,
      lastVerifiedAt: FETCHED,
    });
    const wrapper = mountPicker(state);
    expect(isSpinning(wrapper)).toBe(true);
    await wrapper.get('[data-test="ns-model"]').trigger("focus");
    expect(wrapper.get('[data-test="model-option"]').attributes("data-model-id")).toBe("gpt-saved");
  });

  it("does not spin for a fresh list", () => {
    const state = readyCapability("cache", [{ modelId: "gpt-fresh" }], {
      fetchedAt: FETCHED,
      freshness: "fresh",
      lastVerifiedAt: FETCHED,
    });
    const wrapper = mountPicker(state);
    expect(isSpinning(wrapper)).toBe(false);
    expect(refreshControl(wrapper).classes()).not.toContain("text-danger");
  });

  it("renders empty with default, custom id, and suggestions usable", async () => {
    const state = emptyCapability(
      { code: "discovery-available", message: "the adapter answered but advertised no models" },
      "Use the default model or type a custom id.",
      { fetchedAt: FETCHED, suggestions: ["my-config-id"] },
    );
    const wrapper = mountPicker(state);
    expect(refreshControl(wrapper).attributes("title")).toContain("no models");
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

  it("writes the zh-CN refresh title", () => {
    const previous = i18n.global.locale.value;
    i18n.global.locale.value = "zh-CN";
    try {
      const fresh = mountPicker(readyCapability("cache", [{ modelId: "m" }], { fetchedAt: FETCHED }));
      expect(refreshControl(fresh).attributes("title")).toBe("刷新模型");
      const failed = mountPicker(errorCapability(
        { code: "transport", message: "离线" },
        "重试。",
        { fetchedAt: FETCHED },
      ));
      expect(refreshControl(failed).attributes("title")).toBe("刷新模型。上次读取失败：离线。重试。");
    } finally {
      i18n.global.locale.value = previous;
    }
  });
});

describe("effort model scope", () => {
  it("tags an untagged list with the model in effect at read", () => {
    const state = readyCapability("session", [{ modelId: "gpt-a" }], {
      fetchedAt: FETCHED,
      efforts: { status: "known", options: [{ id: "high", name: "high", source: "adapter" }] },
    });
    const tagged = tagEffortScope(state, "gpt-a");
    expect(tagged.status === "ready" && tagged.efforts.status === "known" ? tagged.efforts.forModelId : undefined).toBe("gpt-a");
    expect(effortsForModel(tagged, "gpt-b")).toBeUndefined();
    expect(effortsForModel(tagged, "gpt-a")?.status).toBe("known");
  });

  it("drops a carried list that belongs to another model", () => {
    const previous = readyCapability("session", [{ modelId: "gpt-a" }], {
      fetchedAt: FETCHED,
      efforts: { status: "known", options: [{ id: "high", name: "high", source: "adapter" }], forModelId: "gpt-a" },
    });
    const merged = mergeEffortRefresh(
      previous,
      errorCapability({ code: "transport", message: "offline" }, "Retry.", { fetchedAt: FETCHED }),
      "gpt-b",
    );
    expect(merged.efforts).toBeUndefined();
  });
});
