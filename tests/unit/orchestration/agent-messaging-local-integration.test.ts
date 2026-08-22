import { expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../../src/main";
import { createEmptyState } from "../../../src/state/types";

test("a managed worker lists and queues a one-way message to its peer through daemon RPC", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-agent-messaging-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const orchestrationSocketPath = join(dir, "runtime", "orchestration.sock");
  const state = createEmptyState();
  state.sessions.coordinator = {
    alias: "coordinator",
    agent: "codex",
    workspace: "backend",
    transport_session: "coordinator-session",
    logical_session_id: "11111111-1111-4111-8111-111111111111",
    created_at: "2026-08-18T00:00:00.000Z",
    last_used_at: "2026-08-18T00:00:00.000Z",
  };
  state.orchestration.workerBindings["worker-a"] = {
    sourceHandle: "worker-a",
    agentEndpointId: "endpoint_worker-a",
    coordinatorSession: "coordinator-session",
    workspace: "backend",
    cwd: "/tmp/backend",
    targetAgent: "codex",
  };
  state.orchestration.workerBindings["worker-b"] = {
    sourceHandle: "worker-b",
    agentEndpointId: "endpoint_worker-b",
    coordinatorSession: "coordinator-session",
    workspace: "backend",
    cwd: "/tmp/backend",
    targetAgent: "codex",
  };
  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: { cwd: "/tmp/backend", allowed_agents: ["codex"] },
      },
    }),
  );
  await writeFile(statePath, JSON.stringify(state));

  const injectMessage = mock(async () => ({
    status: "queued" as const,
    modeUsed: "queue" as const,
  }));
  const runtime = await buildApp(
    { configPath, statePath, orchestrationSocketPath },
    {
      stateSaveDebounceMs: 0,
      provisionAgentOverlays: async () => ({ outcomes: {}, raced: false }),
      createCliTransport: () => ({
        ensureSession: async () => {},
        prompt: async () => ({ text: "ok" }),
        injectMessage,
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
        listSessions: async () => [],
      }),
    },
  );

  try {
    const listResponse = JSON.parse(
      await runtime.orchestration.server.handleLine(
        JSON.stringify({
          id: "list-1",
          method: "agent.list",
          params: {
            coordinatorSession: "coordinator-session",
            sourceHandle: "worker-a",
          },
        }),
      ),
    ) as
      | {
          ok: true;
          result: Awaited<
            ReturnType<(typeof runtime.orchestration.server)["handleLine"]>
          >;
        }
      | {
          ok: false;
          error: { code: string; message: string };
        };
    expect(listResponse.ok).toBe(true);
    const peers = (
      listResponse as unknown as {
        result: Array<{ address: { endpointId: string }; handle: string }>;
      }
    ).result;
    const workerB = peers.find(
      (peer) => peer.address.endpointId === "endpoint_worker-b",
    );
    expect(peers.map((peer) => peer.address.endpointId).sort()).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "endpoint_worker-b",
    ]);
    expect(workerB).toBeDefined();

    const sendResponse = JSON.parse(
      await runtime.orchestration.server.handleLine(
        JSON.stringify({
          id: "send-1",
          method: "agent.send",
          params: {
            coordinatorSession: "coordinator-session",
            sourceHandle: "worker-a",
            to: workerB!.handle,
            message: "schema updated",
            mode: "auto",
          },
        }),
      ),
    ) as
      | {
          ok: true;
          result: {
            messageId: string;
            status: string;
            modeUsed?: string;
            route: string;
          };
        }
      | {
          ok: false;
          error: { code: string; message: string };
        };
    expect(sendResponse.ok).toBe(true);
    const receipt = (sendResponse as Extract<typeof sendResponse, { ok: true }>)
      .result;

    expect(receipt).toMatchObject({
      messageId: expect.stringMatching(/^msg_/),
      status: "queued",
      modeUsed: "queue",
      route: "local",
    });
    expect(injectMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        transportSession: "worker-b",
        mcpCoordinatorSession: "coordinator-session",
        mcpSourceHandle: "worker-b",
      }),
      expect.objectContaining({
        mode: "auto",
        messageId: receipt.messageId,
        text: expect.stringContaining("schema updated"),
      }),
    );
  } finally {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
test("Phase 6: router-level local send with completion 'none' attaches exact peerOrigin to target submitPeerTurn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-agent-messaging-p6-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const orchestrationSocketPath = join(dir, "runtime", "orchestration.sock");
  const state = createEmptyState();
  state.sessions.coordinator = {
    alias: "coordinator",
    agent: "codex",
    workspace: "backend",
    transport_session: "coordinator-session",
    logical_session_id: "11111111-1111-4111-8111-111111111111",
    created_at: "2026-08-18T00:00:00.000Z",
    last_used_at: "2026-08-18T00:00:00.000Z",
  };
  state.orchestration.workerBindings["worker-a"] = {
    sourceHandle: "worker-a",
    agentEndpointId: "endpoint_worker-a",
    coordinatorSession: "coordinator-session",
    workspace: "backend",
    cwd: "/tmp/backend",
    targetAgent: "codex",
  };
  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: { cwd: "/tmp/backend", allowed_agents: ["codex"] },
      },
    }),
  );
  await writeFile(statePath, JSON.stringify(state));

  let capturedSubmitPeerTurnParams: any = null;
  const runtime = await buildApp(
    { configPath, statePath, orchestrationSocketPath },
    {
      stateSaveDebounceMs: 0,
      provisionAgentOverlays: async () => ({ outcomes: {}, raced: false }),
      createCliTransport: () => ({
        ensureSession: async () => {},
        prompt: async () => ({ text: "ok" }),
        injectMessage: async () => ({ status: "queued", modeUsed: "queue" }),
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
        listSessions: async () => [],
      }),
    },
  );

  // Spy on controlService.submitPeerTurn
  const origSubmitPeerTurn = runtime.control.submitPeerTurn.bind(runtime.control);
  runtime.control.submitPeerTurn = async (input) => {
    capturedSubmitPeerTurnParams = input;
    return { status: "queued" };
  };

  try {
    const listResponse = JSON.parse(
      await runtime.orchestration.server.handleLine(
        JSON.stringify({
          id: "list-p6",
          method: "agent.list",
          params: {
            coordinatorSession: "coordinator-session",
            sourceHandle: "worker-a",
          },
        }),
      ),
    );
    expect(listResponse.ok).toBe(true);
    const coordinatorPeer = listResponse.result.find(
      (peer: any) => peer.address.endpointId === "11111111-1111-4111-8111-111111111111",
    );
    expect(coordinatorPeer).toBeDefined();

    const sendResponse = JSON.parse(
      await runtime.orchestration.server.handleLine(
        JSON.stringify({
          id: "send-p6",
          method: "agent.send",
          params: {
            coordinatorSession: "coordinator-session",
            sourceHandle: "worker-a",
            to: coordinatorPeer.handle,
            message: "status update",
            mode: "queue",
            completion: "none",
          },
        }),
      ),
    );
    expect(sendResponse.ok).toBe(true);
    const receipt = sendResponse.result;

    expect(capturedSubmitPeerTurnParams).toBeDefined();
    expect(capturedSubmitPeerTurnParams).toMatchObject({
      sessionAlias: "coordinator",
      boundSessionAlias: "coordinator",
      messageId: receipt.messageId,
      peerOrigin: {
        requestMessageId: receipt.messageId,
        completion: "none",
        source: {
          nodeId: expect.any(String),
          endpointId: "endpoint_worker-a",
        },
        target: {
          nodeId: expect.any(String),
          endpointId: "11111111-1111-4111-8111-111111111111",
        },
      },
    });
  } finally {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Phase 7: end-to-end local peer turn completion delivery routes back to source session as trusted turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-agent-messaging-p7-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const orchestrationSocketPath = join(dir, "runtime", "orchestration.sock");
  const state = createEmptyState();
  state.sessions.coordinator = {
    alias: "coordinator",
    agent: "codex",
    workspace: "backend",
    transport_session: "coordinator-session",
    logical_session_id: "11111111-1111-4111-8111-111111111111",
    created_at: "2026-08-18T00:00:00.000Z",
    last_used_at: "2026-08-18T00:00:00.000Z",
  };
  state.sessions.peer = {
    alias: "peer",
    agent: "codex",
    workspace: "backend",
    transport_session: "peer-session",
    logical_session_id: "22222222-2222-4222-8222-222222222222",
    created_at: "2026-08-18T00:00:00.000Z",
    last_used_at: "2026-08-18T00:00:00.000Z",
  };
  state.orchestration.workerBindings["worker-a"] = {
    sourceHandle: "worker-a",
    agentEndpointId: "endpoint_worker-a",
    coordinatorSession: "coordinator-session",
    workspace: "backend",
    cwd: "/tmp/backend",
    targetAgent: "codex",
  };
  state.orchestration.workerBindings["worker-b"] = {
    sourceHandle: "worker-b",
    agentEndpointId: "endpoint_worker-b",
    coordinatorSession: "coordinator-session",
    workspace: "backend",
    cwd: "/tmp/backend",
    targetAgent: "codex",
  };
  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: { cwd: "/tmp/backend", allowed_agents: ["codex"] },
      },
    }),
  );
  await writeFile(statePath, JSON.stringify(state));
  let capturedCompletionTurnParams: {
    sourceAlias: string;
    completion: { requestMessageId: string; status: string; result?: string };
    requestMessageId: string;
  } | null = null;
  const runtime = await buildApp(
    { configPath, statePath, orchestrationSocketPath },
    {
      stateSaveDebounceMs: 0,
      provisionAgentOverlays: async () => ({ outcomes: {}, raced: false }),
      createCliTransport: () => ({
        ensureSession: async () => {},
        prompt: async () => ({ text: "ok" }),
        injectMessage: async () => ({ status: "queued", modeUsed: "queue" }),
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
        listSessions: async () => [],
      }),
    },
  );

  const completionDelivered = Promise.withResolvers<void>();
  // Spy on controlService.submitCompletionTurn
  const origSubmitCompletionTurn = runtime.control.submitCompletionTurn.bind(runtime.control);
  runtime.control.submitCompletionTurn = async (input) => {
    capturedCompletionTurnParams = input;
    const res = await origSubmitCompletionTurn(input);
    completionDelivered.resolve();
    return res;
  };

  try {
    // v0.3: completion requires a LOGICAL sender and LOGICAL target — the
    // canonical TurnQueue path is the only one that can produce a correlated
    // terminal event. The logical coordinator session sends to the logical peer.
    const listResponse = JSON.parse(
      await runtime.orchestration.server.handleLine(
        JSON.stringify({
          id: "list-p7",
          method: "agent.list",
          params: {
            coordinatorSession: "coordinator-session",
          },
        }),
      ),
    );
    expect(listResponse.ok).toBe(true);
    const coordinatorPeer = listResponse.result.find(
      (peer: { address: { endpointId: string } }) => peer.address.endpointId === "22222222-2222-4222-8222-222222222222",
    );
    expect(coordinatorPeer).toBeDefined();

    // Send message with completion = result
    const sendResponse = JSON.parse(
      await runtime.orchestration.server.handleLine(
        JSON.stringify({
          id: "send-p7",
          method: "agent.send",
          params: {
            coordinatorSession: "coordinator-session",
            to: coordinatorPeer.handle,
            message: "please calculate total",
            completion: "result",
          },
        }),
      ),
    );
    expect(sendResponse.ok).toBe(true);
    const receipt = sendResponse.result;
    expect(receipt.messageId).toBeDefined();

    // Simulate the target turn finishing on controlEvents
    runtime.control["deps"].events.emit({
      type: "turn-finished",
      chatKey: "relay:agent-message:coordinator",
      sessionAlias: "coordinator",
      ok: true,
      text: "Total is 42",
      peerOrigin: {
        requestMessageId: receipt.messageId,
        completion: "result",
        source: {
          nodeId: coordinatorPeer.address.nodeId,
          endpointId: "11111111-1111-4111-8111-111111111111",
        },
        target: coordinatorPeer.address,
      },
    });

    // Await completion delivery deterministically
    await completionDelivered.promise;

    expect(capturedCompletionTurnParams).toBeDefined();
    expect(capturedCompletionTurnParams!.sourceAlias).toBe("coordinator");
    expect(capturedCompletionTurnParams!.requestMessageId).toBe(receipt.messageId);
    // The router hands over a STRUCTURED completion; the trusted envelope is
    // composed inside the SessionTurnRunner after user text is disarmed.
    expect(capturedCompletionTurnParams!.completion.status).toBe("completed");
    expect(capturedCompletionTurnParams!.completion.result).toBe("Total is 42");
  } finally {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
