import { expect, test } from "bun:test";

import { ControlService } from "../../../src/control/control-service";
import { createControlEventBus } from "../../../src/control/control-event-bus";
import { UploadStore } from "../../../src/control/upload-store";

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

  expect(res).toEqual({ status: "injected" });
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

test("Phase 7: ControlService.submitCompletionTurn passes prompt to TurnQueue without peerOrigin", async () => {
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

  const res = await service.submitCompletionTurn({
    sourceAlias: "main",
    prompt: "<xacpx-peer-result>result</xacpx-peer-result>",
    requestMessageId: "msg_comp_1",
  });

  expect(res).toEqual({ status: "injected" });
  expect(capturedParams).toMatchObject({
    chatKey: "relay:agent-message:main",
    sessionAlias: "main",
    boundSessionAlias: "main",
    text: "<xacpx-peer-result>result</xacpx-peer-result>",
    senderId: "agent-messaging",
    promptRequestId: "msg_comp_1",
    isPeerMessage: true,
    allowRestoreArchived: false,
    preserveCoordinatorRoute: true,
  });
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
