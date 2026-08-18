import { expect, mock, test } from "bun:test";

import { LocalAgentMessageDeliveryAdapter } from "../../../src/orchestration/local-agent-message-delivery";
import { AgentMessagingError } from "../../../src/orchestration/agent-messaging-error";
import { MessageInjectionError } from "../../../src/transport/message-injection";
import type { ResolvedAgentEndpoint } from "../../../src/orchestration/agent-endpoint-registry";
import type { AgentMessage } from "../../../src/orchestration/agent-messaging-types";
import type { ResolvedSession } from "../../../src/transport/types";

const logicalTarget: ResolvedAgentEndpoint = {
  endpoint: {
    address: { nodeId: "node_a", endpointId: "logical_a" },
    handle: "agent:node_a:logical_a",
    node: "node_a",
    agent: "codex",
    workspace: "backend",
    state: "idle",
    capabilities: {
      receive: true,
      steer: false,
      queue: true,
      interrupt: false,
    },
  },
  runtime: {
    kind: "logical",
    alias: "coordinator",
    transportSession: "coordinator-session",
  },
};

const message: AgentMessage = {
  id: "msg_1",
  from: { nodeId: "node_a", endpointId: "sender" },
  to: logicalTarget.endpoint.address,
  content: "hello",
  requestedMode: "queue",
  createdAt: 1,
};

const logicalSession: ResolvedSession = {
  alias: "coordinator",
  agent: "codex",
  workspace: "backend",
  transportSession: "coordinator-session",
  cwd: "/repo",
};

test("delivers a logical endpoint through SessionTransport.injectMessage", async () => {
  const injectMessage = mock(async () => ({
    status: "queued" as const,
    modeUsed: "queue" as const,
  }));
  const delivery = new LocalAgentMessageDeliveryAdapter({
    transport: {
      injectMessage,
    },
    resolveLogicalSession: async () => logicalSession,
    resolveWorkerSession: () => null,
  });

  await expect(
    delivery.deliver(
      logicalTarget,
      message,
      "<xacpx-message>hello</xacpx-message>",
    ),
  ).resolves.toEqual({ status: "queued", modeUsed: "queue" });
  expect(injectMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      transportSession: "coordinator-session",
      mcpCoordinatorSession: "coordinator-session",
    }),
    {
      text: "<xacpx-message>hello</xacpx-message>",
      messageId: "msg_1",
      mode: "queue",
    },
  );
});

test("binds a worker target to its own MCP sender identity", async () => {
  const workerTarget: ResolvedAgentEndpoint = {
    endpoint: {
      ...logicalTarget.endpoint,
      address: { nodeId: "node_a", endpointId: "worker_b" },
      handle: "agent:node_a:worker_b",
    },
    runtime: {
      kind: "worker",
      workerSession: "worker-session-b",
      binding: {
        sourceHandle: "worker-session-b",
        agentEndpointId: "endpoint_worker-b",
        coordinatorSession: "coordinator-session",
        workspace: "backend",
        targetAgent: "codex",
      },
    },
  };
  const injectMessage = mock(async () => ({
    status: "queued" as const,
    modeUsed: "queue" as const,
  }));
  const delivery = new LocalAgentMessageDeliveryAdapter({
    transport: { injectMessage },
    resolveLogicalSession: async () => null,
    resolveWorkerSession: () => ({
      ...logicalSession,
      alias: "worker-session-b",
      transportSession: "worker-session-b",
    }),
  });

  await delivery.deliver(
    workerTarget,
    { ...message, to: workerTarget.endpoint.address },
    "hello",
  );

  expect(injectMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      transportSession: "worker-session-b",
      mcpCoordinatorSession: "coordinator-session",
      mcpSourceHandle: "worker-session-b",
    }),
    expect.objectContaining({ messageId: "msg_1" }),
  );
});

test("fails with TARGET_UNAVAILABLE when a persisted target cannot resolve a session", async () => {
  const delivery = new LocalAgentMessageDeliveryAdapter({
    transport: {
      injectMessage: async () => ({ status: "queued", modeUsed: "queue" }),
    },
    resolveLogicalSession: async () => null,
    resolveWorkerSession: () => null,
  });

  try {
    await delivery.deliver(logicalTarget, message, "hello");
    throw new Error("expected delivery to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(AgentMessagingError);
    expect(error).toMatchObject({ code: "TARGET_UNAVAILABLE" });
  }
});

test("fails closed when the configured transport cannot inject messages", async () => {
  const delivery = new LocalAgentMessageDeliveryAdapter({
    transport: {},
    resolveLogicalSession: async () => logicalSession,
    resolveWorkerSession: () => null,
  });

  try {
    await delivery.deliver(logicalTarget, message, "hello");
    throw new Error("expected delivery to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(MessageInjectionError);
    expect(error).toMatchObject({ code: "DELIVERY_FAILED" });
  }
});
