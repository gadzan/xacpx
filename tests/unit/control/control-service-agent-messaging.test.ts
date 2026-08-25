import { expect, test } from "bun:test";

import { ControlService } from "../../../src/control/control-service";
import { createControlEventBus } from "../../../src/control/control-event-bus";
import { UploadStore } from "../../../src/control/upload-store";
import { AgentMessagingError } from "../../../src/orchestration/agent-messaging-error";

function makeControlService(agentMessagingDeps?: unknown) {
  const events = createControlEventBus();
  const service = new ControlService({
    agent: { chat: async () => ({ text: "ok" }) },
    sessions: {
      listAllResolvedSessions: () => [],
      removeSession: async () => {},
      useSession: async () => ({
        alias: "main",
        agent: "codex",
        workspace: "ws",
        transportSession: "ts",
        created_at: "",
        last_used_at: "",
      }),
      resolveAliasForChat: async () => "main",
      getSession: () => undefined,
      setSessionModel: async () => ({ applied: true }),
      setSessionEffort: async () => ({ applied: true }),
      setDisplayName: async () => ({ applied: true }),
    },
    transport: {
      setModel: async () => {},
      getSessionModel: async () => ({ available: [] }),
      setSessionEffort: async () => {},
      getSessionEffort: async () => ({ current: "medium", available: [] }),
    },
    createSessionWithTransport: async () => ({}) as never,
    removeSessionWithTransport: async () => ({ wasActive: false }),
    archiveSessionWithTransport: async () => {},
    unarchiveSession: async () => {},
    listNativeSessions: async () => [],
    attachNativeSessionWithTransport: async () => ({}) as never,
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: {
      listPending: () => [],
      listRecentForChat: () => [],
      createTask: async () => ({}) as never,
      cancelPending: async () => false,
    },
    orchestration: {
      listTasks: async () => [],
      getTask: async () => null,
      requestTaskCancellation: async () => ({}) as never,
    },
    events,
    agents: {
      list: () => [],
      catalog: () => [],
      create: async () => ({}) as never,
      remove: async () => {},
    },
    workspaces: {
      list: () => [],
      create: async () => ({}) as never,
      remove: async () => {},
    },
    uploadStore: new UploadStore(),
    terminal: {} as never,
    terminalEnabled: () => false,
    filesWriteEnabled: () => false,
    agentMessaging: agentMessagingDeps as never,
  });
  return { service, events };
}

test("ControlService delegates deliverAgentMessage to agentMessaging dependency", async () => {
  let capturedInput: unknown = null;
  const { service } = makeControlService({
    deliverInbound: async (input: unknown) => {
      capturedInput = input;
      return {
        messageId: "msg_1",
        status: "queued",
        modeUsed: "queue",
      };
    },
    getPublishedEndpoints: async () => [],
  });

  const res = await service.deliverAgentMessage({
    sourceNodeId: "node_1",
    sourceEndpointId: "ep_1",
    targetEndpointId: "ep_2",
    messageId: "msg_1",
    content: "hello",
    requestedMode: "auto",
    replyTo: "reply_1",
    replyable: true,
  });

  expect(res).toEqual({
    messageId: "msg_1",
    status: "queued",
    modeUsed: "queue",
  });
  expect(capturedInput).toEqual({
    sourceNodeId: "node_1",
    sourceEndpointId: "ep_1",
    targetEndpointId: "ep_2",
    messageId: "msg_1",
    content: "hello",
    requestedMode: "auto",
    replyTo: "reply_1",
    replyable: true,
  });
});

test("ControlService returns empty published endpoints when agentMessaging is not configured", async () => {
  const { service } = makeControlService();
  expect(await service.getPublishedAgentEndpoints()).toEqual([]);
});
test("Phase 6: ControlService.submitPeerTurn passes peerOrigin to TurnQueue", async () => {
  const { service } = makeControlService();
  (service as any).deps.sessions.getSession = async () => ({
    alias: "main",
    archived: false,
  });

  let capturedParams: any = null;
  (service as any).turnQueue.submitPeerTurn = (params: any) => {
    capturedParams = params;
    return { status: "injected" };
  };

  const peerOrigin = {
    requestMessageId: "msg_ctrl_1",
    completion: "notify" as const,
    source: { nodeId: "node-1", endpointId: "ep-1" },
    target: { nodeId: "node-2", endpointId: "ep-2" },
  };

  const res = await service.submitPeerTurn({
    chatKey: "relay:agent-message:main",
    sessionAlias: "main",
    boundSessionAlias: "main",
    text: "<xacpx-message>hello</xacpx-message>",
    senderId: "agent-messaging",
    messageId: "msg_ctrl_1",
    peerOrigin,
  });

  expect(res).toEqual({ status: "injected", modeUsed: "queue" });
  expect(capturedParams).toMatchObject({
    chatKey: "relay:agent-message:main",
    sessionAlias: "main",
    boundSessionAlias: "main",
    text: "<xacpx-message>hello</xacpx-message>",
    senderId: "agent-messaging",
    promptRequestId: "msg_ctrl_1",
    isPeerMessage: true,
    peerOrigin,
  });
});

// White-box seam: `turnQueue` and `deps.sessions` are private on ControlService.
// The stubs pin the ROUTING contract (which TurnQueue API a requestedMode picks,
// and how admissions map to receipts) without a real lane underneath.
interface LaneQueueStub {
  submitPeerTurn: (params: Record<string, unknown>) => unknown;
  submitPeerInterrupt: (params: Record<string, unknown>) => unknown;
}
function exposeLane(service: ControlService): {
  queue: LaneQueueStub;
  setSession: (session: { alias: string; archived?: boolean } | undefined) => void;
} {
  const internals = service as unknown as {
    turnQueue: LaneQueueStub;
    deps: {
      sessions: {
        getSession: (alias: string) => Promise<{ alias: string; archived?: boolean } | undefined>;
      };
    };
  };
  return {
    queue: internals.turnQueue,
    setSession: (session) => {
      internals.deps.sessions.getSession = async () => session;
    },
  };
}

test("v0.4: submitPeerTurn(requestedMode=interrupt) routes through TurnQueue.submitPeerInterrupt with mapped receipts", async () => {
  const { service } = makeControlService();
  const lane = exposeLane(service);
  lane.setSession({ alias: "main", archived: false });

  const capturedParams: Array<Record<string, unknown>> = [];
  let nextAdmission: unknown = { status: "queued", modeUsed: "interrupt", queueItemId: "qi_1" };
  lane.queue.submitPeerInterrupt = (params) => {
    capturedParams.push(params);
    return nextAdmission;
  };

  const peerOrigin = {
    requestMessageId: "msg_intr_1",
    completion: "result" as const,
    source: { nodeId: "node-1", endpointId: "ep-1" },
    target: { nodeId: "node-2", endpointId: "ep-2" },
  };

  // Busy target: reservation receipt (spec §6.4).
  const busy = await service.submitPeerTurn({
    chatKey: "relay:agent-message:main",
    sessionAlias: "main",
    boundSessionAlias: "main",
    text: "<xacpx-message>preempt</xacpx-message>",
    senderId: "agent-messaging",
    messageId: "msg_intr_1",
    requestedMode: "interrupt",
    peerOrigin,
  });
  expect(busy).toEqual({ status: "queued", modeUsed: "interrupt", targetState: "running" });
  expect(capturedParams[0]).toMatchObject({
    promptRequestId: "msg_intr_1",
    isPeerMessage: true,
    peerOrigin,
  });

  // Idle target: ordinary admission receipt, zero cancellations.
  nextAdmission = { status: "injected", modeUsed: "prompt" };
  const idle = await service.submitPeerTurn({
    chatKey: "relay:agent-message:main",
    sessionAlias: "main",
    boundSessionAlias: "main",
    text: "<xacpx-message>preempt</xacpx-message>",
    senderId: "agent-messaging",
    messageId: "msg_intr_2",
    requestedMode: "interrupt",
  });
  expect(idle).toEqual({ status: "injected", modeUsed: "prompt", targetState: "idle" });

  // One-slot rule: the pending-interrupt rejection maps to MESSAGE_QUEUE_FULL
  // with the interrupt-specific detail (spec §16).
  nextAdmission = { status: "rejected", reason: "queue-full" };
  try {
    await service.submitPeerTurn({
      chatKey: "relay:agent-message:main",
      sessionAlias: "main",
      boundSessionAlias: "main",
      text: "x",
      senderId: "agent-messaging",
      messageId: "msg_intr_3",
      requestedMode: "interrupt",
    });
    throw new Error("expected MESSAGE_QUEUE_FULL");
  } catch (error) {
    expect(error).toBeInstanceOf(AgentMessagingError);
    expect((error as AgentMessagingError).code).toBe("MESSAGE_QUEUE_FULL");
    expect((error as AgentMessagingError).message).toContain("pending peer interrupt");
  }
});

// Zero-delay macrotask boundary (same helper as turn-queue.test.ts) — lets
// queued promise continuations (turn starts, drain hand-offs) land before
// asserting. Not a wall-clock wait.
const tick = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

test("v0.4 contract boundary: interrupt signals the running turn once, never overlaps it, and starts only after natural settlement", async () => {
  const { service } = makeControlService();
  const lane = exposeLane(service);
  lane.setSession({ alias: "main", archived: false });

  // A transport/agent that IGNORES cancellation: chat() parks until the TEST
  // settles it, recording every signal it received. This is the worst case
  // the contract boundary allows — the cancel request has no early effect.
  const chatSignals: AbortSignal[] = [];
  const chatSettled = Promise.withResolvers<{ text: string }>();
  const internals = service as unknown as {
    // White-box: deps.agent is the ChatAgent the SessionTurnRunner drives.
    deps: { agent: { chat: (req: { abortSignal?: AbortSignal }) => Promise<{ text: string }> } };
  };
  internals.deps.agent.chat = (req) => {
    chatSignals.push(req.abortSignal ?? new AbortController().signal);
    return chatSettled.promise;
  };

  // 1. Predecessor turn runs and parks (busy lane).
  const promptPromise = service.prompt({
    chatKey: "c",
    sessionAlias: "main",
    text: "old turn",
    senderId: "human",
  });
  await tick();
  expect(chatSignals).toHaveLength(1);

  // 2. Interrupt arrives: accepted queued/interrupt; the parked predecessor's
  //    signal is aborted — exactly ONE cancellation request.
  const admission = await service.submitPeerTurn({
    chatKey: "c",
    sessionAlias: "main",
    boundSessionAlias: "main",
    text: "<xacpx-message>interrupt content</xacpx-message>",
    senderId: "agent-messaging",
    messageId: "msg_seam_i",
    requestedMode: "interrupt",
  });
  expect(admission).toEqual({ status: "queued", modeUsed: "interrupt", targetState: "running" });
  expect(chatSignals).toHaveLength(1);
  expect(chatSignals[0]!.aborted).toBe(true);

  // 3. The transport ignores the cancel: while the predecessor stays
  //    unresolved, the interrupt turn MUST NOT start (no overlap).
  await tick();
  expect(chatSignals).toHaveLength(1);

  // 4. The transport finishes the predecessor NATURALLY. The interrupt turn
  //    starts only after true settlement, with a FRESH (non-aborted) signal —
  //    and the predecessor's result is whatever the transport produced.
  chatSettled.resolve({ text: "natural completion" });
  await promptPromise;
  await tick();
  expect(chatSignals).toHaveLength(2);
  expect(chatSignals[1]!.aborted).toBe(false);
});

test("v0.4 G12: default/auto peer turns never touch the interrupt admission path", async () => {
  const { service } = makeControlService();
  const lane = exposeLane(service);
  lane.setSession({ alias: "main", archived: false });
  lane.queue.submitPeerInterrupt = () => {
    throw new Error("interrupt admission must not run for default/auto modes");
  };
  lane.queue.submitPeerTurn = () => ({ status: "injected" });

  const res = await service.submitPeerTurn({
    chatKey: "relay:agent-message:main",
    sessionAlias: "main",
    boundSessionAlias: "main",
    text: "plain",
    senderId: "agent-messaging",
    messageId: "msg_plain_1",
  });
  expect(res).toEqual({ status: "injected", modeUsed: "queue" });
});

test("Phase 7: ControlService.submitCompletionTurn passes the STRUCTURED completion to TurnQueue (never pre-rendered prompt text)", async () => {
  const { service } = makeControlService();
  (service as any).deps.sessions.getSession = async () => ({
    alias: "main",
    archived: false,
  });

  let capturedParams: any = null;
  (service as any).turnQueue.submitPeerTurn = (params: any) => {
    capturedParams = params;
    return { status: "injected" };
  };

  const completion = {
    requestMessageId: "msg_comp_1",
    from: { nodeId: "node_1", endpointId: "peer" },
    to: { nodeId: "node_1", endpointId: "source" },
    status: "completed" as const,
    result: "the answer",
    completedAt: 123,
  };

  const res = await service.submitCompletionTurn({
    sourceAlias: "main",
    completion,
    requestMessageId: "msg_comp_1",
  });

  expect(res).toEqual({ status: "injected" });
  expect(capturedParams).toMatchObject({
    chatKey: "relay:agent-message:main",
    sessionAlias: "main",
    boundSessionAlias: "main",
    // Prompt text is empty: the trusted envelope is composed inside the
    // SessionTurnRunner AFTER user text is disarmed.
    text: "",
    senderId: "agent-messaging",
    promptRequestId: "msg_comp_1",
    isPeerMessage: true,
    allowRestoreArchived: false,
    preserveCoordinatorRoute: true,
  });
  expect(capturedParams.trustedPeerCompletion).toEqual(completion);
  // Completion turn must NOT carry peerOrigin (one-shot, non-replyable)
  expect(capturedParams.peerOrigin).toBeUndefined();
});

test("Phase 7: ControlService.submitCompletionTurn rejects when session is archived or missing", async () => {
  const { service } = makeControlService();

  // Missing session
  (service as any).deps.sessions.getSession = async () => null;
  const resMissing = await service.submitCompletionTurn({
    sourceAlias: "missing",
    prompt: "prompt",
    requestMessageId: "msg_1",
  });
  expect(resMissing).toEqual({ status: "rejected", reason: "target-unavailable" });

  // Archived session
  (service as any).deps.sessions.getSession = async () => ({
    alias: "archived-session",
    archived: true,
  });
  const resArchived = await service.submitCompletionTurn({
    sourceAlias: "archived-session",
    prompt: "prompt",
    requestMessageId: "msg_2",
  });
  expect(resArchived).toEqual({ status: "rejected", reason: "target-unavailable" });
});
