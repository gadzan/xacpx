import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { RELAY_CAPABILITIES } from "@ganglion/xacpx-relay-protocol";
import InstanceTree from "../components/InstanceTree.vue";
import { useInstancesStore } from "../stores/instances";

const instance = () => ({
  id: "i1",
  name: "pc",
  online: true,
  lastSeenAt: null,
  capabilities: [RELAY_CAPABILITIES.sessionForkHandoffV1],
  sessions: [{
    alias: "backend",
    agent: "claude",
    workspace: "home",
    transportSession: "t",
    running: false,
    archived: false,
  }],
  sessionsLoaded: true,
  agents: [],
  workspaces: [],
  agentCatalog: [],
});

async function openFork(w: VueWrapper): Promise<void> {
  await w.find('[data-test="session-menu"]').trigger("click");
  await w.find('[data-test="action-fork-session"]').trigger("click");
  await flushPromises();
}

describe("InstanceTree fork entry", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("sends one fork RPC for a double click", async () => {
    const store = useInstancesStore();
    store.instances = [instance()] as never;
    const result = Promise.withResolvers<{ alias: string }>();
    const fork = vi.spyOn(store, "forkSession").mockReturnValue(result.promise as never);
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });

    await openFork(w);
    await openFork(w);
    expect(fork).toHaveBeenCalledTimes(1);

    result.resolve({ alias: "backend-fork" });
    await flushPromises();
  });

  it("refreshes the row list when the target alias is taken", async () => {
    const store = useInstancesStore();
    store.instances = [instance()] as never;
    vi.spyOn(store, "forkSession").mockRejectedValue(new Error("session-fork-target-exists: taken"));
    const load = vi.spyOn(store, "loadSessions").mockResolvedValue();
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });

    await openFork(w);
    expect(load).toHaveBeenCalledWith("i1");
  });
});
