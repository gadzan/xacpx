import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_CAPABILITIES } from "@ganglion/xacpx-relay-protocol";

vi.mock("../api/client", () => ({
  ApiError: class extends Error { constructor(public code: string, public status: number) { super(code); } },
  api: { get: vi.fn(), rpc: vi.fn() },
}));
vi.mock("../lib/agent-icons", () => ({ agentIconSvg: () => null }));

import { api } from "../api/client";
import {
  nextSessionForkAgentAlias,
  supportsSessionForkAgent,
  useInstancesStore,
} from "../stores/instances";

const rpc = vi.mocked(api.rpc);

function seedInstance(capabilities: string[] = [
  RELAY_CAPABILITIES.sessionForkHandoffV1,
  RELAY_CAPABILITIES.sessionForkAgentV1,
]): void {
  const instances = useInstancesStore();
  instances.instances.push({
    id: "i1", name: "pc", online: true, lastSeenAt: null, capabilities,
    sessions: [{ alias: "backend", agent: "codex", workspace: "gaia" }],
    agents: [
      { name: "codex", driver: "codex" },
      { name: "claude", driver: "claude" },
    ],
    workspaces: [], agentCatalog: [], sessionsLoaded: true,
  } as never);
}

function sessionList() {
  return { sessions: [], hasMore: false, nextOffset: 0 };
}

function forkPayload(index: number): Record<string, unknown> {
  const payload = rpc.mock.calls.filter(([, type]) => type === "control.sessions.fork")[index]?.[2];
  if (!payload || typeof payload !== "object") throw new Error("fork call recorded no payload object");
  // Narrowed for assertions only: the RPC takes `unknown` by design.
  return payload as Record<string, unknown>;
}

beforeEach(() => {
  setActivePinia(createPinia());
  rpc.mockReset();
});

describe("supportsSessionForkAgent", () => {
  it("is gated on the advertised capability, not on the core version", () => {
    expect(supportsSessionForkAgent({ capabilities: [RELAY_CAPABILITIES.sessionForkAgentV1] })).toBe(true);
    expect(supportsSessionForkAgent({ capabilities: [RELAY_CAPABILITIES.sessionForkHandoffV1] })).toBe(false);
    expect(supportsSessionForkAgent(null)).toBe(false);
  });
});

describe("nextSessionForkAgentAlias", () => {
  it("names the branch after the agent and skips taken rows", () => {
    const sessions = [{ alias: "backend" }, { alias: "backend-claude-fork" }];
    expect(nextSessionForkAgentAlias(sessions, "backend", "claude")).toBe("backend-claude-fork-2");
    expect(nextSessionForkAgentAlias(sessions, "backend", "Gemini Code")).toBe("backend-gemini-code-fork");
    expect(nextSessionForkAgentAlias([{ alias: "backend" }], "backend", "claude")).toBe("backend-claude-fork");
  });
});

describe("instances store forkSessionAtAgent", () => {
  it("sends targetAgent and coalesces a concurrent second call", async () => {
    seedInstance();
    const created = Promise.withResolvers<{ alias: string }>();
    rpc.mockImplementation(async (_instanceId, type) => {
      if (type === "control.sessions.fork") return created.promise as never;
      return sessionList() as never;
    });
    const store = useInstancesStore();

    const first = store.forkSessionAtAgent("i1", "backend", "claude");
    await flushPromises();
    await expect(store.forkSessionAtAgent("i1", "backend", "claude")).rejects.toThrow("session-fork-in-flight");
    expect(rpc.mock.calls.filter(([, type]) => type === "control.sessions.fork")).toHaveLength(1);

    created.resolve({ alias: "backend-claude-fork" });
    await expect(first).resolves.toEqual({ alias: "backend-claude-fork" });
    expect(forkPayload(0)).toMatchObject({
      sourceAlias: "backend",
      targetAlias: "backend-claude-fork",
      targetAgent: "claude",
    });
  });

  it("retries an ambiguous failure with the same request id and target", async () => {
    seedInstance();
    let attempt = 0;
    rpc.mockImplementation(async (_instanceId, type) => {
      if (type !== "control.sessions.fork") return sessionList() as never;
      attempt += 1;
      if (attempt === 1) throw new Error("instance-reconnected");
      return { alias: "backend-claude-fork" } as never;
    });
    const store = useInstancesStore();

    await expect(store.forkSessionAtAgent("i1", "backend", "claude")).rejects.toThrow("instance-reconnected");
    await expect(store.forkSessionAtAgent("i1", "backend", "claude"))
      .resolves.toEqual({ alias: "backend-claude-fork" });

    expect(forkPayload(0).requestId).toBe(forkPayload(1).requestId);
    expect(forkPayload(0).targetAlias).toBe(forkPayload(1).targetAlias);
    expect(forkPayload(0).targetAgent).toBe("claude");
  });

  it("keeps a separate pin per target agent", async () => {
    seedInstance();
    rpc.mockImplementation(async (_instanceId, type) => {
      if (type !== "control.sessions.fork") return sessionList() as never;
      return { alias: "branch" } as never;
    });
    const store = useInstancesStore();

    await store.forkSessionAtAgent("i1", "backend", "claude");
    await store.forkSessionAtAgent("i1", "backend", "gemini");

    expect(forkPayload(0).requestId).not.toBe(forkPayload(1).requestId);
    expect(forkPayload(0).targetAgent).toBe("claude");
    expect(forkPayload(1).targetAgent).toBe("gemini");
  });

  it("mints a fresh request id and alias after a taken target", async () => {
    const instances = useInstancesStore();
    instances.instances.push({
      id: "i1", name: "pc", online: true, lastSeenAt: null,
      capabilities: [RELAY_CAPABILITIES.sessionForkHandoffV1, RELAY_CAPABILITIES.sessionForkAgentV1],
      sessions: [
        { alias: "backend", agent: "codex", workspace: "gaia" },
        { alias: "backend-claude-fork", agent: "claude", workspace: "gaia" },
      ],
      agents: [], workspaces: [], agentCatalog: [], sessionsLoaded: true,
    } as never);
    let attempt = 0;
    rpc.mockImplementation(async (_instanceId, type) => {
      if (type !== "control.sessions.fork") {
        return {
          sessions: [
            { alias: "backend", agent: "codex", workspace: "gaia" },
            { alias: "backend-claude-fork", agent: "claude", workspace: "gaia" },
          ],
          hasMore: false,
          nextOffset: 0,
        } as never;
      }
      attempt += 1;
      if (attempt === 1) {
        return { error: { code: "session-fork-target-exists", message: "session-fork-target-exists: taken" } } as never;
      }
      return { alias: "backend-claude-fork-2" } as never;
    });

    await expect(instances.forkSessionAtAgent("i1", "backend", "claude")).rejects.toThrow(/target-exists/);
    await expect(instances.forkSessionAtAgent("i1", "backend", "claude"))
      .resolves.toEqual({ alias: "backend-claude-fork-2" });

    expect(forkPayload(0).requestId).not.toBe(forkPayload(1).requestId);
    expect(forkPayload(1).targetAlias).toBe("backend-claude-fork-2");
  });

  it("forwards targetAgent from the plain fork call only when given", async () => {
    seedInstance();
    rpc.mockImplementation(async (_instanceId, type) => {
      if (type === "control.sessions.fork") return { alias: "backend-fork" } as never;
      return sessionList() as never;
    });
    const store = useInstancesStore();

    await store.forkSession("i1", "backend", "backend-fork", "req-plain");
    await store.forkSession("i1", "backend", "backend-claude-fork", "req-switch", "claude");

    expect(forkPayload(0)).not.toHaveProperty("targetAgent");
    expect(forkPayload(1)).toMatchObject({ targetAgent: "claude" });
  });
});
