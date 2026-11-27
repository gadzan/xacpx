import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import {
  errorCapability,
  needsSetupCapability,
  readyCapability,
  unsupportedCapability,
  type AgentCapabilityState,
} from "@ganglion/xacpx-relay-protocol";
import AgentReadinessRow from "../components/AgentReadinessRow.vue";
import AgentsManager from "../components/AgentsManager.vue";
import { useInstancesStore, type InstanceStore } from "../stores/instances";
import { i18n } from "../i18n";
const FETCHED = "2026-10-09T00:00:00.000Z";

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => { i18n.global.locale.value = "en"; });

function seed(store: InstanceStore, opts?: {
  agents?: Array<{ name: string; driver: string }>;
  workspaces?: Array<{ name: string; cwd: string; description: string }>;
  catalog?: Array<{ driver: string; configured: boolean; installed: string }>;
}) {
  store.instances = [{
    id: "i1", name: "n", online: true, sessions: [],
    agents: opts?.agents ?? [{ name: "codex", driver: "codex" }],
    workspaces: opts?.workspaces ?? [{ name: "repo", cwd: "/repo", description: "" }],
    agentCatalog: opts?.catalog ?? [{ driver: "codex", configured: true, installed: "builtin" }],
  }] as never;
}

function mountRow(state: AgentCapabilityState, props?: {
  agentName?: string;
  installedHint?: string;
  workspaceNames?: string[];
}) {
  const store = useInstancesStore();
  seed(store, props?.workspaceNames ? {
    workspaces: props.workspaceNames.map((name) => ({ name, cwd: `/${name}`, description: "" })),
  } : undefined);
  const getCaps = vi.spyOn(store, "getAgentCapabilities").mockResolvedValue(state);
  const w = mount(AgentReadinessRow, {
    props: {
      instanceId: "i1",
      agentName: props?.agentName ?? "codex",
      installedHint: props?.installedHint ?? "built-in",
      workspaceNames: props?.workspaceNames ?? ["repo"],
    },
  });
  return { store, getCaps, w };
}

describe("AgentReadinessRow", () => {
  test("shows the installed hint and last capability state without probing on mount", async () => {
    const { getCaps, w } = mountRow(
      readyCapability("cache", [{ modelId: "gpt-a" }, { modelId: "gpt-b" }], { fetchedAt: FETCHED }),
    );
    await flushPromises();
    expect(getCaps).toHaveBeenCalledTimes(1);
    expect(getCaps).toHaveBeenCalledWith("i1", { agent: "codex", workspace: "repo" });
    expect(getCaps.mock.calls.every(([, input]) => !input.probe)).toBe(true);
    expect(w.get('[data-test="arr-installed"]').text()).toBe("built-in");
    expect(w.get('[data-test="arr-status"]').text()).toBe("Ready");
    expect(w.get('[data-test="arr-models"]').text()).toBe("2 models");
    // No workspace picker: capability answers are agent-global.
    expect(w.find('[data-test="arr-workspace"]').exists()).toBe(false);
    expect(w.find('[data-test="arr-checked-in"]').exists()).toBe(false);
    const items = w.findAll('[data-test="arr-model-item"]');
    expect(items.map((i) => i.text())).toEqual(["gpt-a", "gpt-b"]);
  });

  test("Check performs exactly one probe for the selected agent and workspace", async () => {
    const { getCaps, w } = mountRow(
      readyCapability("cache", [{ modelId: "gpt-a" }], { fetchedAt: FETCHED }),
    );
    await flushPromises();
    getCaps.mockClear();
    await w.get('[data-test="arr-check"]').trigger("click");
    await flushPromises();
    expect(getCaps).toHaveBeenCalledTimes(1);
    expect(getCaps).toHaveBeenCalledWith("i1", { agent: "codex", workspace: "repo", probe: true });
    expect(w.get('[data-test="arr-status"]').text()).toBe("Ready");
  });

  test("renders needs-setup with its reason and recovery hint", async () => {
    const { w } = mountRow(needsSetupCapability(
      { code: "discovery-available", message: "no saved model list" },
      "Fetch the model list.",
      { fetchedAt: FETCHED },
    ));
    await flushPromises();
    expect(w.get('[data-test="arr-status"]').text()).toBe("Needs setup");
    expect(w.get('[data-test="arr-reason"]').text()).toBe("no saved model list");
    expect(w.get('[data-test="arr-recovery"]').text()).toBe("Fetch the model list.");
    expect(w.find('[data-test="arr-models"]').exists()).toBe(false);
  });

  test("renders an error with its reason", async () => {
    const { w } = mountRow(errorCapability(
      { code: "transport", message: "the connector is offline" },
      "Retry after reconnecting.",
      { fetchedAt: FETCHED },
    ));
    await flushPromises();
    expect(w.get('[data-test="arr-status"]').text()).toBe("Error");
    expect(w.get('[data-test="arr-reason"]').text()).toBe("the connector is offline");
    expect(w.get('[data-test="arr-recovery"]').text()).toBe("Retry after reconnecting.");
  });

  test("renders unsupported with its reason", async () => {
    const { w } = mountRow(unsupportedCapability(
      { code: "adapter-cannot-enumerate", message: "this adapter cannot list models" },
      "Type a custom id or use the default.",
      { fetchedAt: FETCHED },
    ));
    await flushPromises();
    expect(w.get('[data-test="arr-status"]').text()).toBe("Unsupported");
    expect(w.get('[data-test="arr-reason"]').text()).toBe("this adapter cannot list models");
  });

  test("renders the agent model list when ready", async () => {
    const { w } = mountRow(
      readyCapability("cache", [{ modelId: "opus", name: "Opus" }, { modelId: "sonnet" }], { fetchedAt: FETCHED }),
    );
    await flushPromises();
    const items = w.findAll('[data-test="arr-model-item"]');
    expect(items.map((i) => i.text())).toEqual(["Opus (opus)", "sonnet"]);
  });

  test("a late probe never overwrites a newer settled row", async () => {
    const store = useInstancesStore();
    seed(store);
    const cached = readyCapability("cache", [{ modelId: "cached" }], { fetchedAt: FETCHED });
    const staleProbe = readyCapability("probe", [{ modelId: "stale-probe-model" }], { fetchedAt: FETCHED });
    const { promise: probeGate, resolve: resolveProbe } = Promise.withResolvers<AgentCapabilityState>();
    let calls = 0;
    const getCaps = vi.spyOn(store, "getAgentCapabilities").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return cached;
      return probeGate;
    });
    const w = mount(AgentReadinessRow, {
      props: { instanceId: "i1", agentName: "codex", workspaceNames: ["repo"] },
    });
    await flushPromises();
    // Singular form: the plural pipe must not render "1 models".
    expect(w.get('[data-test="arr-models"]').text()).toBe("1 model");
    await w.get('[data-test="arr-check"]').trigger("click");
    await flushPromises();
    resolveProbe(staleProbe);
    await flushPromises();
    expect(getCaps).toHaveBeenCalledWith("i1", { agent: "codex", workspace: "repo", probe: true });
    expect(w.get('[data-test="arr-models"]').text()).toBe("1 model");
    expect(w.find('[data-test="arr-workspace"]').exists()).toBe(false);
  });

  test("disables Check when no workspace exists and never reads", async () => {
    const { getCaps, w } = mountRow(
      readyCapability("cache", [{ modelId: "gpt-a" }], { fetchedAt: FETCHED }),
      { workspaceNames: [] },
    );
    await flushPromises();
    expect(getCaps).not.toHaveBeenCalled();
    expect(w.get('[data-test="arr-status"]').text()).toBe("Not checked yet");
    expect(w.get('[data-test="arr-check"]').attributes("disabled")).toBeDefined();
    expect(w.find('[data-test="arr-no-workspace"]').exists()).toBe(true);
  });

  test("renders Chinese copy when the locale is zh-CN", async () => {
    i18n.global.locale.value = "zh-CN";
    const { w } = mountRow(
      readyCapability("cache", [{ modelId: "gpt-a" }, { modelId: "gpt-b" }], { fetchedAt: FETCHED }),
      { installedHint: "内置" },
    );
    await flushPromises();
    expect(w.get('[data-test="arr-status"]').text()).toBe("就绪");
    expect(w.get('[data-test="arr-models"]').text()).toBe("2 个模型");
    expect(w.get('[data-test="arr-check"]').text()).toContain("检查");
    expect(w.get('[data-test="arr-installed"]').text()).toBe("内置");
  });
});

describe("AgentsManager readiness", () => {
  test("shows one readiness row per agent with its catalog hint", async () => {
    const store = useInstancesStore();
    seed(store);
    vi.spyOn(store, "getAgentCapabilities").mockResolvedValue(
      readyCapability("cache", [{ modelId: "gpt-a" }], { fetchedAt: FETCHED }),
    );
    const w = mount(AgentsManager, { props: { instanceId: "i1" } });
    await flushPromises();
    expect(w.find('[data-test="arr-row-codex"]').exists()).toBe(true);
    expect(w.get('[data-test="arr-installed"]').text()).toBe("built-in");
    expect(w.get('[data-test="arr-status"]').text()).toBe("Ready");
  });

  test("hides the installed hint when the catalog is empty", async () => {
    const store = useInstancesStore();
    seed(store, { catalog: [] });
    vi.spyOn(store, "getAgentCapabilities").mockResolvedValue(
      readyCapability("cache", [{ modelId: "gpt-a" }], { fetchedAt: FETCHED }),
    );
    const w = mount(AgentsManager, { props: { instanceId: "i1" } });
    await flushPromises();
    expect(w.find('[data-test="arr-row-codex"]').exists()).toBe(true);
    expect(w.find('[data-test="arr-installed"]').exists()).toBe(false);
  });

  test("offers no install, download, sign-in, or update action", async () => {
    const store = useInstancesStore();
    seed(store);
    vi.spyOn(store, "getAgentCapabilities").mockResolvedValue(needsSetupCapability(
      { code: "discovery-available", message: "no saved model list" },
      "Fetch the model list.",
      { fetchedAt: FETCHED },
    ));
    const w = mount(AgentsManager, { props: { instanceId: "i1" } });
    await flushPromises();
    const html = w.html();
    // "built-in" is a catalog hint, not an action; the verbs themselves are.
    expect(html).not.toMatch(/\b(install|download|sign[- ]?in|update|upgrade)\b/i);
    expect(w.find('[data-test="arr-check"]').exists()).toBe(true);
  });
});
