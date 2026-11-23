import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { RELAY_CAPABILITIES } from "@ganglion/xacpx-relay-protocol";
import InstanceTree from "../components/InstanceTree.vue";
import { useInstancesStore } from "../stores/instances";
import { useToasts } from "../lib/use-toasts";

function instance(options: {
  capabilities?: string[];
  agents?: Array<{ name: string; driver: string }>;
} = {}) {
  return {
    id: "i1",
    name: "pc",
    online: true,
    lastSeenAt: null,
    capabilities: options.capabilities ?? [
      RELAY_CAPABILITIES.sessionForkHandoffV1,
      RELAY_CAPABILITIES.sessionForkAgentV1,
    ],
    sessions: [{
      alias: "backend",
      agent: "codex",
      driver: "codex",
      workspace: "home",
      transportSession: "t",
      running: false,
      archived: false,
    }],
    sessionsLoaded: true,
    agents: options.agents ?? [
      { name: "codex", driver: "codex" },
      { name: "claude", driver: "claude" },
      { name: "gemini", driver: "gemini" },
    ],
    workspaces: [],
    agentCatalog: [],
  };
}

async function openMenu(w: VueWrapper): Promise<void> {
  await w.find('[data-test="session-menu"]').trigger("click");
  await flushPromises();
}

function mountTree(): VueWrapper {
  return mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
}

describe("InstanceTree agent switch entry", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useToasts().value = [];
  });

  it("hides the switch group from an instance without the capability", async () => {
    const store = useInstancesStore();
    store.instances = [instance({
      capabilities: [RELAY_CAPABILITIES.sessionForkHandoffV1],
    })] as never;
    const w = mountTree();

    await openMenu(w);
    expect(w.find('[data-test="action-fork-session"]').exists()).toBe(true);
    expect(w.find('[data-test="action-switch-agent-claude"]').exists()).toBe(false);
    expect(w.find('[data-test="action-switch-agent-source"]').exists()).toBe(false);
  });

  it("hides the group when the source agent is the only configured agent", async () => {
    const store = useInstancesStore();
    store.instances = [instance({ agents: [{ name: "codex", driver: "codex" }] })] as never;
    const w = mountTree();

    await openMenu(w);
    expect(w.find('[data-test="action-switch-agent-source"]').exists()).toBe(false);
    expect(w.findAll('[data-test^="action-switch-agent-"]')).toHaveLength(0);
  });

  it("lists configured agents except the source and marks it current", async () => {
    const store = useInstancesStore();
    store.instances = [instance()] as never;
    const w = mountTree();

    await openMenu(w);
    const claude = w.find('[data-test="action-switch-agent-claude"]');
    expect(claude.exists()).toBe(true);
    expect(claude.attributes("data-value")).toBe("switch-agent:claude");
    expect(claude.text()).toContain("claude");
    expect(w.find('[data-test="action-switch-agent-gemini"]').exists()).toBe(true);
    // The source agent is excluded from the choices and shown as a disabled row.
    expect(w.find('[data-test="action-switch-agent-codex"]').exists()).toBe(false);
    const source = w.find('[data-test="action-switch-agent-source"]');
    expect(source.attributes("disabled")).toBeDefined();
    expect(source.text()).toContain("codex");
    expect(source.text()).toContain("current agent");
  });

  it("runs one switch for a double click, selects the branch, and toasts", async () => {
    const store = useInstancesStore();
    store.instances = [instance()] as never;
    const created = Promise.withResolvers<{ alias: string }>();
    const switchTo = vi.spyOn(store, "forkSessionAtAgent").mockReturnValue(created.promise as never);
    const w = mountTree();

    await openMenu(w);
    await w.find('[data-test="action-switch-agent-claude"]').trigger("click");
    // The menu closed on the first click; reopen it while the switch is still in
    // flight and click again. The guard must not start a second request.
    await openMenu(w);
    await w.find('[data-test="action-switch-agent-claude"]').trigger("click");
    expect(switchTo).toHaveBeenCalledTimes(1);
    expect(useToasts().value[0]).toMatchObject({ tone: "loading", key: "instance.switchAgentPending" });
    expect(w.find('[data-test="session-action-pending"]').exists()).toBe(true);
    expect(switchTo).toHaveBeenCalledWith("i1", "backend", "claude");

    created.resolve({ alias: "backend-claude-fork" });
    await flushPromises();
    expect(w.emitted("select")).toEqual([["i1", "backend-claude-fork"]]);
    expect(useToasts().value[0]).toMatchObject({ tone: "success", key: "instance.switchAgentCreated" });
    expect(useToasts().value.some((toast) => toast.tone === "loading")).toBe(false);
    expect(w.find('[data-test="session-action-pending"]').exists()).toBe(false);
  });

  it("toasts a failed switch and keeps the current selection", async () => {
    const store = useInstancesStore();
    store.instances = [instance()] as never;
    vi.spyOn(store, "forkSessionAtAgent")
      .mockRejectedValue(new Error("session-fork-agent-unavailable: not configured"));
    const w = mountTree();

    await openMenu(w);
    await w.find('[data-test="action-switch-agent-claude"]').trigger("click");
    await flushPromises();

    expect(w.emitted("select")).toBeUndefined();
    expect(useToasts().value.some((toast) => toast.tone === "loading")).toBe(false);
    expect(w.find('[data-test="session-action-pending"]').exists()).toBe(false);
    expect(useToasts().value[0]).toMatchObject({ tone: "error", key: "instance.switchAgentFailed" });
  });
});
