import { beforeAll, expect, test } from "bun:test";

import { AgentMessagingError } from "../../../src/orchestration/agent-messaging-error";
import { AgentEndpointRegistry } from "../../../src/orchestration/agent-endpoint-registry";
import { encodeAgentHandle } from "../../../src/orchestration/agent-handle";
import { registerKnownChannelId } from "../../../src/channels/channel-scope";
import { createEmptyState } from "../../../src/state/types";

beforeAll(() => {
  // channelId derivation resolves the internal-alias namespace prefix against
  // the process-wide known-channel registry, exactly like production channel
  // plugins do at startup (registerChannelFactory → registerKnownChannelId).
  registerKnownChannelId("relay");
  registerKnownChannelId("feishu");
});

const nodeId = "node_11111111-1111-4111-8111-111111111111";

function makeRegistry() {
  const state = createEmptyState();
  state.sessions.main = {
    alias: "main",
    agent: "codex",
    workspace: "project",
    transport_session: "coordinator",
    logical_session_id: "22222222-2222-4222-8222-222222222222",
    created_at: "2026-08-18T00:00:00.000Z",
    last_used_at: "2026-08-18T00:00:00.000Z",
  };
  state.orchestration.workerBindings.workerA = {
    sourceHandle: "workerA",
    agentEndpointId: "endpoint_worker-a",
    coordinatorSession: "coordinator",
    workspace: "project",
    targetAgent: "claude",
  };
  state.orchestration.workerBindings.workerB = {
    sourceHandle: "workerB",
    agentEndpointId: "endpoint_worker-b",
    coordinatorSession: "coordinator",
    workspace: "project",
    targetAgent: "gemini",
  };
  state.orchestration.workerBindings.otherWorker = {
    sourceHandle: "otherWorker",
    agentEndpointId: "endpoint_other-worker",
    coordinatorSession: "other-coordinator",
    workspace: "other",
    targetAgent: "codex",
  };
  state.orchestration.externalCoordinators.external = {
    coordinatorSession: "external",
    agentEndpointId: "endpoint_external",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };

  return {
    registry: new AgentEndpointRegistry({
      nodeId,
      loadState: async () => structuredClone(state),
    }),
    state,
  };
}

test("worker lists same-coordinator peers without private runtime metadata", async () => {
  const { registry } = makeRegistry();

  const endpoints = await registry.listReachable({
    coordinatorSession: "coordinator",
    sourceHandle: "workerA",
  });

  expect(endpoints.map((endpoint) => endpoint.address.endpointId)).toEqual([
    "22222222-2222-4222-8222-222222222222",
    "endpoint_worker-b",
  ]);
  expect(endpoints.every((endpoint) => endpoint.capabilities.receive)).toBe(
    true,
  );
  expect(endpoints.every((endpoint) => endpoint.capabilities.queue)).toBe(true);
  expect(
    endpoints.every((endpoint) => endpoint.capabilities.steer === false),
  ).toBe(true);
  expect(
    endpoints.every((endpoint) => endpoint.capabilities.interrupt === false),
  ).toBe(true);
  expect(endpoints.every((endpoint) => !("cwd" in endpoint))).toBe(true);
  expect(
    endpoints.some(
      (endpoint) => endpoint.address.endpointId === "endpoint_other-worker",
    ),
  ).toBe(false);
});

test("registry resolves an authorized peer and rejects self, foreign-node, and cross-coordinator handles", async () => {
  const { registry } = makeRegistry();
  const sender = await registry.resolveSender({
    coordinatorSession: "coordinator",
    sourceHandle: "workerA",
  });
  const peerHandle = encodeAgentHandle({
    nodeId,
    endpointId: "endpoint_worker-b",
  });

  await expect(
    registry.resolveTarget(sender, peerHandle),
  ).resolves.toMatchObject({
    endpoint: {
      address: { nodeId, endpointId: "endpoint_worker-b" },
      agent: "gemini",
    },
    runtime: {
      kind: "worker",
      workerSession: "workerB",
    },
  });

  await expect(
    registry.resolveTarget(sender, encodeAgentHandle(sender.address)),
  ).rejects.toMatchObject<Partial<AgentMessagingError>>({
    code: "SELF_MESSAGE_NOT_ALLOWED",
  });
  await expect(
    registry.resolveTarget(
      sender,
      encodeAgentHandle({
        nodeId: "node_33333333-3333-4333-8333-333333333333",
        endpointId: "endpoint_remote",
      }),
    ),
  ).rejects.toMatchObject<Partial<AgentMessagingError>>({
    code: "ROUTE_UNAVAILABLE",
  });
  await expect(
    registry.resolveTarget(
      sender,
      encodeAgentHandle({
        nodeId,
        endpointId: "endpoint_other-worker",
      }),
    ),
  ).rejects.toMatchObject<Partial<AgentMessagingError>>({
    code: "TARGET_NOT_REACHABLE",
  });
});

test("external coordinators resolve as send-capable but do not appear as receive targets", async () => {
  const { registry } = makeRegistry();

  const sender = await registry.resolveSender({
    coordinatorSession: "external",
    sourceHandle: "external",
  });

  expect(sender.receive).toBe(false);
  await expect(
    registry.listReachable({
      coordinatorSession: "external",
      sourceHandle: "external",
    }),
  ).resolves.toEqual([]);
});

test("unknown or stale sourceHandle must not fall back to coordinator identity", async () => {
  const { registry } = makeRegistry();

  // When sourceHandle is unknown / deleted, it must reject with DELIVERY_DENIED,
  // NEVER fall back to the logical coordinator "coordinator"
  await expect(
    registry.resolveSender({
      coordinatorSession: "coordinator",
      sourceHandle: "staleWorkerOld",
    }),
  ).rejects.toMatchObject<Partial<AgentMessagingError>>({
    code: "DELIVERY_DENIED",
  });
});

test("derives worker activity status and summary from orchestration task state", async () => {
  const { registry, state } = makeRegistry();
  // Set workerA role and workspace
  state.orchestration.workerBindings.workerA.role = "worker-a-role";
  state.orchestration.workerBindings.workerA.workspace = "worker-a-ws";

  // Initially workerA is idle
  let endpoints = await registry.listReachable({
    coordinatorSession: "coordinator",
    sourceHandle: "workerB",
  });
  const workerAIdle = endpoints.find(
    (e) => e.address.endpointId === "endpoint_worker-a",
  );
  expect(workerAIdle?.activity.status).toBe("idle");
  expect(workerAIdle?.activity.summary).toBe("Idle (worker-a-role)");
  expect(workerAIdle?.displayName).toBe("worker-a-role");
  expect(workerAIdle?.workspace).toBe("worker-a-ws");
  expect(workerAIdle?.capabilities.conversation).toBe(true);

  // Set task to running with summary
  state.orchestration.tasks.task1 = {
    taskId: "task_1",
    sourceHandle: "workerA",
    sourceKind: "coordinator",
    coordinatorSession: "coordinator",
    workerSession: "workerA",
    workspace: "worker-a-ws",
    targetAgent: "codex",
    task: "Secret raw prompt: write internal token to /tmp/secret",
    summary: "Implementing User OAuth Migration",
    status: "running",
    resultText: "",
    createdAt: "2026-08-18T00:00:00Z",
    updatedAt: "2026-08-18T00:00:00Z",
  };

  endpoints = await registry.listReachable({
    coordinatorSession: "coordinator",
    sourceHandle: "workerB",
  });
  const workerARunning = endpoints.find(
    (e) => e.address.endpointId === "endpoint_worker-a",
  );
  expect(workerARunning?.activity.status).toBe("working");
  expect(workerARunning?.activity.summary).toBe(
    "Implementing User OAuth Migration",
  );
  // Must NEVER expose the raw prompt text
  expect(JSON.stringify(workerARunning)).not.toContain("Secret raw prompt");

  // Set task to needs_confirmation (attention-required)
  state.orchestration.tasks.task1.status = "needs_confirmation";
  endpoints = await registry.listReachable({
    coordinatorSession: "coordinator",
    sourceHandle: "workerB",
  });
  const workerAWaiting = endpoints.find(
    (e) => e.address.endpointId === "endpoint_worker-a",
  );
  expect(workerAWaiting?.activity.status).toBe("waiting");
  expect(workerAWaiting?.activity.summary).toBe("Waiting for confirmation");
});

test("syncRemoteDirectorySnapshot preserves activity and conversation capabilities", async () => {
  const { registry } = makeRegistry();
  const remoteNode = "node_remote_2222";
  registry.syncRemoteDirectorySnapshot([
    {
      nodeId: remoteNode,
      endpointId: "ep_remote_1",
      displayName: "Remote API Worker",
      agent: "claude",
      workspace: "frontend",
      state: "running",
      activity: {
        status: "working",
        summary: "Refactoring Client Components",
      },
      capabilities: {
        receive: true,
        steer: false,
        queue: true,
        interrupt: false,
        conversation: true,
      },
    },
  ]);

  const endpoints = await registry.listReachable({
    coordinatorSession: "coordinator",
    sourceHandle: "workerA",
  });
  const remote = endpoints.find((e) => e.address.nodeId === remoteNode);
  expect(remote?.displayName).toBe("Remote API Worker");
  expect(remote?.workspace).toBe("frontend");
  expect(remote?.activity.status).toBe("working");
  expect(remote?.activity.summary).toBe("Refactoring Client Components");
  expect(remote?.capabilities.conversation).toBe(true);
});

test("archived sessions are excluded from candidates, reachable list, and target resolution", async () => {
  const { registry, state } = makeRegistry();
  state.sessions.archivedSession = {
    alias: "archived-worker",
    agent: "codex",
    workspace: "project",
    transport_session: "coordinator",
    logical_session_id: "33333333-3333-4333-8333-333333333333",
    display_name: "Archived Specialist",
    archived: true,
    created_at: "2026-08-18T00:00:00.000Z",
    last_used_at: "2026-08-18T00:00:00.000Z",
  };

  const reachable = await registry.listReachable({
    coordinatorSession: "coordinator",
    sourceHandle: "workerA",
  });
  expect(
    reachable.some(
      (e) => e.address.endpointId === "33333333-3333-4333-8333-333333333333",
    ),
  ).toBe(false);
  expect(reachable.some((e) => e.displayName === "Archived Specialist")).toBe(
    false,
  );

  const published = await registry.getPublishedEndpoints();
  expect(
    published.some(
      (e) => e.endpointId === "33333333-3333-4333-8333-333333333333",
    ),
  ).toBe(false);

  const sender = await registry.resolveSender({
    coordinatorSession: "coordinator",
    sourceHandle: "workerA",
  });
  const archivedHandle = encodeAgentHandle({
    nodeId,
    endpointId: "33333333-3333-4333-8333-333333333333",
  });
  await expect(
    registry.resolveTarget(sender, archivedHandle),
  ).rejects.toMatchObject<Partial<AgentMessagingError>>({
    code: "TARGET_NOT_REACHABLE",
  });

  await expect(
    registry.resolveSelector(sender, { displayName: "Archived Specialist" }),
  ).rejects.toMatchObject<Partial<AgentMessagingError>>({
    code: "TARGET_NOT_FOUND",
  });
});

test("resolveSelector resolves a unique match by displayName, workspace, or agent", async () => {
  const { registry, state } = makeRegistry();
  state.orchestration.workerBindings.workerB.role = "Reviewer";
  const sender = { coordinatorSession: "coordinator", sourceHandle: "workerA" };

  // Match by displayName (case-insensitive with trimming)
  const byName = await registry.resolveSelector(sender, {
    displayName: "  reviewer  ",
  });
  expect(byName.endpoint.address.endpointId).toBe("endpoint_worker-b");

  // Match by logical session alias
  const byAlias = await registry.resolveSelector(sender, {
    displayName: "main",
  });
  expect(byAlias.endpoint.address.endpointId).toBe(
    "22222222-2222-4222-8222-222222222222",
  );

  // Match by agent
  const byAgent = await registry.resolveSelector(sender, { agent: "gemini" });
  expect(byAgent.endpoint.address.endpointId).toBe("endpoint_worker-b");

  // Match by combined criteria
  const byCombined = await registry.resolveSelector(sender, {
    agent: "gemini",
    workspace: "project",
    displayName: "Reviewer",
  });
  expect(byCombined.endpoint.address.endpointId).toBe("endpoint_worker-b");
});

test("resolveSelector throws TARGET_NOT_FOUND when 0 candidates match", async () => {
  const { registry } = makeRegistry();
  const sender = { coordinatorSession: "coordinator", sourceHandle: "workerA" };

  await expect(
    registry.resolveSelector(sender, { displayName: "nonexistent-agent" }),
  ).rejects.toMatchObject<Partial<AgentMessagingError>>({
    code: "TARGET_NOT_FOUND",
  });

  await expect(
    registry.resolveSelector(sender, { workspace: "nonexistent-workspace" }),
  ).rejects.toMatchObject<Partial<AgentMessagingError>>({
    code: "TARGET_NOT_FOUND",
  });
});
test("resolveSelector throws TARGET_AMBIGUOUS with candidate details when multiple match", async () => {
  const { registry, state } = makeRegistry();
  state.orchestration.workerBindings.workerB.role = "workerB";
  // Add a second worker with the same agent and workspace
  state.orchestration.workerBindings.workerC = {
    sourceHandle: "workerC",
    agentEndpointId: "endpoint_worker-c",
    coordinatorSession: "coordinator",
    workspace: "project",
    targetAgent: "gemini",
    role: "workerC",
  };

  const sender = { coordinatorSession: "coordinator", sourceHandle: "workerA" };

  try {
    await registry.resolveSelector(sender, { agent: "gemini" });
    expect.unreachable("should have thrown TARGET_AMBIGUOUS");
  } catch (error) {
    expect(error).toBeInstanceOf(AgentMessagingError);
    const err = error as AgentMessagingError;
    expect(err.code).toBe("TARGET_AMBIGUOUS");
    expect(err.message).toContain("endpoint_worker-b");
    expect(err.message).toContain("endpoint_worker-c");
    expect(err.message).toContain("workerB");
    expect(err.message).toContain("workerC");
  }
});

test("resolveTargetByHandle resolves local and remote endpoints by handle", async () => {
  const { registry } = makeRegistry();
  const localHandle = encodeAgentHandle({
    nodeId,
    endpointId: "22222222-2222-4222-8222-222222222222",
  });

  const resolvedLocal = await registry.resolveTargetByHandle(localHandle);
  expect(resolvedLocal).toMatchObject({
    handle: localHandle,
    displayName: "main",
    agent: "codex",
    workspace: "project",
  });

  const remoteNodeId = "node_remote-9999-9999-9999-999999999999";
  const remoteEndpointId = "endpoint_remote_worker";
  const remoteHandle = encodeAgentHandle({
    nodeId: remoteNodeId,
    endpointId: remoteEndpointId,
  });

  registry.updateRemoteEndpoints(remoteNodeId, [
    {
      address: { nodeId: remoteNodeId, endpointId: remoteEndpointId },
      handle: remoteHandle,
      node: remoteNodeId,
      agent: "claude",
      workspace: "billing",
      displayName: "Remote Billing",
      state: "idle",
      activity: { status: "idle" },
      capabilities: {
        receive: true,
        steer: false,
        queue: true,
        interrupt: false,
        conversation: true,
      },
    },
  ]);

  const resolvedRemote = await registry.resolveTargetByHandle(remoteHandle);
  expect(resolvedRemote).toMatchObject({
    handle: remoteHandle,
    displayName: "Remote Billing",
    agent: "claude",
    workspace: "billing",
  });

  expect(await registry.resolveTargetByHandle("invalid:handle")).toBeNull();
  expect(
    await registry.resolveTargetByHandle(
      encodeAgentHandle({ nodeId, endpointId: "endpoint_missing" }),
    ),
  ).toBeNull();
});

test("logical session endpoint reflects active status when isSessionActive returns true", async () => {
  const state = createEmptyState();
  state.sessions.backend = {
    alias: "backend",
    agent: "codex",
    workspace: "project",
    transport_session: "coordinator",
    logical_session_id: "33333333-3333-4333-8333-333333333333",
    created_at: "2026-08-18T00:00:00.000Z",
    last_used_at: "2026-08-18T00:00:00.000Z",
  };
  const activeRegistry = new AgentEndpointRegistry({
    nodeId,
    loadState: async () => state,
    isSessionActive: (alias) => alias === "backend",
  });
  const endpoints = await activeRegistry.getPublishedEndpoints();
  const ep = endpoints.find(
    (e) => e.endpointId === "33333333-3333-4333-8333-333333333333",
  );
  expect(ep).toBeDefined();
  expect(ep!.state).toBe("running");
  expect(ep!.activity).toEqual({ status: "working" });
});
test("getPublishedEndpoints publishes sessionAlias and displayName separately for logical sessions", async () => {
  const state = createEmptyState();
  state.sessions.withCustomName = {
    alias: "weixin:omp-2",
    display_name: "发布机器人",
    agent: "codex",
    workspace: "weacpx-github",
    transport_session: "coordinator",
    logical_session_id: "44444444-4444-4444-4444-444444444444",
    created_at: "2026-08-18T00:00:00.000Z",
    last_used_at: "2026-08-18T00:00:00.000Z",
  };
  state.sessions.plain = {
    alias: "omp-3",
    agent: "claude",
    workspace: "weacpx-github",
    transport_session: "coordinator",
    logical_session_id: "55555555-5555-5555-5555-555555555555",
    created_at: "2026-08-18T00:00:00.000Z",
    last_used_at: "2026-08-18T00:00:00.000Z",
  };

  const reg = new AgentEndpointRegistry({
    nodeId,
    loadState: async () => state,
  });

  const endpoints = await reg.getPublishedEndpoints();
  const customEp = endpoints.find(
    (e) => e.endpointId === "44444444-4444-4444-4444-444444444444",
  );
  const plainEp = endpoints.find(
    (e) => e.endpointId === "55555555-5555-5555-5555-555555555555",
  );

  expect(customEp).toMatchObject({
    displayName: "发布机器人",
    sessionAlias: "omp-2",
    agent: "codex",
    workspace: "weacpx-github",
  });

  expect(plainEp).toMatchObject({
    displayName: "omp-3",
    sessionAlias: "omp-3",
    agent: "claude",
    workspace: "weacpx-github",
  });
});

test("resolveSelector throws TARGET_NOT_FOUND when selector is empty object", async () => {
  const { registry } = makeRegistry();
  const sender = { coordinatorSession: "coordinator", sourceHandle: "workerA" };
  await expect(registry.resolveSelector(sender, {})).rejects.toMatchObject({
    code: "TARGET_NOT_FOUND",
  });
});

test("getPublishedEndpoints derives endpointKind logical and channelId from the owning channel namespace", async () => {
  const state = createEmptyState();
  const base = {
    agent: "codex",
    workspace: "project",
    transport_session: "coordinator",
    created_at: "2026-08-18T00:00:00.000Z",
    last_used_at: "2026-08-18T00:00:00.000Z",
  };
  state.sessions.relayBot = {
    ...base,
    alias: "relay:omp-2",
    logical_session_id: "66666666-6666-4666-8666-666666666666",
  };
  state.sessions.feishuBot = {
    ...base,
    alias: "feishu:omp-3",
    logical_session_id: "77777777-7777-4777-8777-777777777777",
  };
  state.sessions.legacyBot = {
    ...base,
    alias: "omp-4",
    logical_session_id: "88888888-8888-4888-8888-888888888888",
  };

  const reg = new AgentEndpointRegistry({
    nodeId,
    loadState: async () => state,
  });

  const endpoints = await reg.getPublishedEndpoints();
  expect(
    endpoints.find((e) => e.endpointId === "66666666-6666-4666-8666-666666666666"),
  ).toMatchObject({ endpointKind: "logical", channelId: "relay" });
  expect(
    endpoints.find((e) => e.endpointId === "77777777-7777-4777-8777-777777777777"),
  ).toMatchObject({ endpointKind: "logical", channelId: "feishu" });
  // Unprefixed (legacy default-namespace) aliases resolve to "weixin".
  expect(
    endpoints.find((e) => e.endpointId === "88888888-8888-4888-8888-888888888888"),
  ).toMatchObject({ endpointKind: "logical", channelId: "weixin" });
});

test("worker endpoints publish endpointKind worker without channelId", async () => {
  const { registry } = makeRegistry();

  const published = await registry.getPublishedEndpoints();
  const workerEp = published.find((e) => e.endpointId === "endpoint_worker-a");
  expect(workerEp?.endpointKind).toBe("worker");
  expect("channelId" in (workerEp ?? {})).toBe(false);

  // Sanity: the local logical session still carries its logical kind + namespace.
  const logicalEp = published.find(
    (e) => e.endpointId === "22222222-2222-4222-8222-222222222222",
  );
  expect(logicalEp?.endpointKind).toBe("logical");
  expect(logicalEp?.channelId).toBe("weixin");
});

test("syncRemoteDirectorySnapshot preserves remote context fields and accepts legacy rows without them", async () => {
  const { registry } = makeRegistry();
  const remoteNode = "node_remote_ctx";
  registry.syncRemoteDirectorySnapshot([
    {
      nodeId: remoteNode,
      endpointId: "ep_remote_ctx",
      displayName: "Remote Logical",
      agent: "claude",
      state: "idle",
      capabilities: {
        receive: true,
        steer: false,
        queue: true,
        interrupt: false,
      },
      endpointKind: "logical",
      channelId: "feishu",
    },
    {
      nodeId: remoteNode,
      endpointId: "ep_remote_legacy",
      displayName: "Legacy Daemon Row",
      agent: "codex",
      state: "idle",
      capabilities: {
        receive: true,
        steer: false,
        queue: true,
        interrupt: false,
      },
    },
  ]);

  const endpoints = await registry.listReachable({
    coordinatorSession: "coordinator",
    sourceHandle: "workerA",
  });
  const ctx = endpoints.find((e) => e.address.endpointId === "ep_remote_ctx");
  expect(ctx?.endpointKind).toBe("logical");
  expect(ctx?.channelId).toBe("feishu");

  const legacy = endpoints.find(
    (e) => e.address.endpointId === "ep_remote_legacy",
  );
  expect(legacy).toBeDefined();
  expect("endpointKind" in (legacy ?? {})).toBe(false);
  expect("channelId" in (legacy ?? {})).toBe(false);
});
