import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_CAPABILITIES } from "@ganglion/xacpx-relay-protocol";

vi.mock("../api/client", () => ({
  ApiError: class extends Error { constructor(public code: string, public status: number) { super(code); } },
  api: { get: vi.fn(), rpc: vi.fn() },
}));
vi.mock("../lib/agent-icons", () => ({ agentIconSvg: () => null }));

import ChatPane from "../components/ChatPane.vue";
import { api } from "../api/client";
import { useChatStore } from "../stores/chat";
import { useInstancesStore } from "../stores/instances";
import { useToasts } from "../lib/use-toasts";

const rpc = vi.mocked(api.rpc);

function seedInstance(capabilities: string[] = [
  RELAY_CAPABILITIES.sessionForkHandoffV1,
  RELAY_CAPABILITIES.sessionForkMessageV1,
]): void {
  const instances = useInstancesStore();
  instances.instances.push({
    id: "i1", name: "pc", online: true, lastSeenAt: null, capabilities,
    sessions: [{ alias: "backend", agent: "codex", workspace: "gaia" }],
    agents: [], workspaces: [], agentCatalog: [], sessionsLoaded: true,
  } as never);
}

function sessionList() {
  return { sessions: [], hasMore: false, nextOffset: 0 };
}

beforeEach(() => {
  setActivePinia(createPinia());
  rpc.mockReset();
  useToasts().value = [];
});

describe("instances store forkSessionAtNode", () => {
  it("sends the node source point and coalesces a concurrent second call", async () => {
    seedInstance();
    const created = Promise.withResolvers<{ alias: string }>();
    rpc.mockImplementation(async (instanceId, type) => {
      if (type === "control.sessions.fork") return created.promise as never;
      return sessionList() as never;
    });
    const store = useInstancesStore();

    const first = store.forkSessionAtNode("i1", "backend", "node-1");
    await expect(store.forkSessionAtNode("i1", "backend", "node-1")).rejects.toThrow("session-fork-in-flight");
    expect(rpc.mock.calls.filter(([, type]) => type === "control.sessions.fork")).toHaveLength(1);

    created.resolve({ alias: "backend-fork" });
    await expect(first).resolves.toEqual({ alias: "backend-fork" });
    const forkCall = rpc.mock.calls.find(([, type]) => type === "control.sessions.fork")!;
    expect(forkCall[2]).toMatchObject({
      sourceAlias: "backend",
      sourcePoint: { type: "node", nodeId: "node-1" },
    });
  });

  it("retries an ambiguous failure with the same request id and target", async () => {
    seedInstance();
    let attempt = 0;
    rpc.mockImplementation(async (_instanceId, type, payload) => {
      if (type !== "control.sessions.fork") return sessionList() as never;
      attempt += 1;
      if (attempt === 1) throw new Error("instance-reconnected");
      return { alias: (payload as { targetAlias: string }).targetAlias } as never;
    });
    const store = useInstancesStore();

    await expect(store.forkSessionAtNode("i1", "backend", "node-1")).rejects.toThrow("instance-reconnected");
    await expect(store.forkSessionAtNode("i1", "backend", "node-1")).resolves.toEqual({ alias: "backend-fork" });

    const forkCalls = rpc.mock.calls.filter(([, type]) => type === "control.sessions.fork");
    expect(forkCalls).toHaveLength(2);
    expect((forkCalls[0]![2] as { requestId: string }).requestId)
      .toBe((forkCalls[1]![2] as { requestId: string }).requestId);
    expect((forkCalls[0]![2] as { targetAlias: string }).targetAlias)
      .toBe((forkCalls[1]![2] as { targetAlias: string }).targetAlias);
  });

  it("mints a fresh request id and alias after a taken target", async () => {
    const instances = useInstancesStore();
    instances.instances.push({
      id: "i1", name: "pc", online: true, lastSeenAt: null,
      capabilities: [RELAY_CAPABILITIES.sessionForkHandoffV1, RELAY_CAPABILITIES.sessionForkMessageV1],
      sessions: [
        { alias: "backend", agent: "codex", workspace: "gaia" },
        { alias: "backend-fork", agent: "codex", workspace: "gaia" },
      ],
      agents: [], workspaces: [], agentCatalog: [], sessionsLoaded: true,
    } as never);
    let attempt = 0;
    rpc.mockImplementation(async (_instanceId, type, payload) => {
      if (type !== "control.sessions.fork") {
        return {
          sessions: [
            { alias: "backend", agent: "codex", workspace: "gaia" },
            { alias: "backend-fork", agent: "codex", workspace: "gaia" },
          ],
          hasMore: false,
          nextOffset: 0,
        } as never;
      }
      attempt += 1;
      if (attempt === 1) return { error: { code: "session-fork-target-exists", message: "session-fork-target-exists: taken" } } as never;
      return { alias: (payload as { targetAlias: string }).targetAlias } as never;
    });

    await expect(instances.forkSessionAtNode("i1", "backend", "node-1")).rejects.toThrow(/target-exists/);
    await expect(instances.forkSessionAtNode("i1", "backend", "node-1")).resolves.toEqual({ alias: "backend-fork-2" });
    const forkCalls = rpc.mock.calls.filter(([, type]) => type === "control.sessions.fork");
    expect((forkCalls[0]![2] as { requestId: string }).requestId)
      .not.toBe((forkCalls[1]![2] as { requestId: string }).requestId);
  });
});

describe("ChatPane node fork entry", () => {
  function seedPrompt(nodeId: string | undefined = "node-1"): void {
    const chat = useChatStore();
    chat.select("i1", "backend");
    chat.messages.push({
      id: 1,
      instanceId: "i1",
      sessionAlias: "backend",
      direction: "in",
      text: "fork me",
      createdAt: "2026-11-16T00:00:00.000Z",
      ...(nodeId ? { nodeId } : {}),
    });
  }

  it("hides the row entry when only the head capability is advertised", async () => {
    seedInstance([RELAY_CAPABILITIES.sessionForkHandoffV1]);
    seedPrompt();
    const wrapper = mount(ChatPane);
    await flushPromises();
    expect(wrapper.find('[data-test="msg-fork-node"]').exists()).toBe(false);
  });

  it("sends one fork RPC on a double click and selects the materialized alias", async () => {
    seedInstance();
    seedPrompt();
    const instances = useInstancesStore();
    const created = Promise.withResolvers<{ alias: string }>();
    const fork = vi.spyOn(instances, "forkSessionAtNode").mockReturnValue(created.promise as never);
    const wrapper = mount(ChatPane);
    await flushPromises();

    const entry = wrapper.find('[data-test="msg-fork-node"]');
    expect(entry.exists()).toBe(true);
    await entry.trigger("click");
    await entry.trigger("click");
    expect(fork).toHaveBeenCalledTimes(1);
    expect(fork.mock.calls[0]?.slice(0, 3)).toEqual(["i1", "backend", "node-1"]);

    created.resolve({ alias: "backend-fork-2" });
    await flushPromises();
    const chat = useChatStore();
    expect(chat.instanceId).toBe("i1");
    expect(chat.sessionAlias).toBe("backend-fork-2");
    expect(useToasts().value[0]).toMatchObject({ tone: "success", key: "instance.forkCreated" });
  });

  it("surfaces a typed fork failure without changing the selection", async () => {
    seedInstance();
    seedPrompt();
    const instances = useInstancesStore();
    vi.spyOn(instances, "forkSessionAtNode").mockRejectedValue(new Error("session-fork-source-changed: moved"));
    const wrapper = mount(ChatPane);
    await flushPromises();

    await wrapper.find('[data-test="msg-fork-node"]').trigger("click");
    await flushPromises();
    expect(useChatStore().sessionAlias).toBe("backend");
    expect(useToasts().value[0]).toMatchObject({ tone: "error", key: "instance.forkFailed" });
  });
});
