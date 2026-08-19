import { expect, test } from "bun:test";
import { AgentEndpointRegistry } from "../../src/orchestration/agent-endpoint-registry";
import { AgentMessageRouter } from "../../src/orchestration/agent-message-router";
import { LocalAgentMessageDeliveryAdapter } from "../../src/orchestration/local-agent-message-delivery";
import { createControlEventBus, type ControlEvent } from "../../src/control/control-event-bus";
import { SessionTurnRunner } from "../../src/control/session-turn-runner";
import { createEmptyState } from "../../src/state/types";
import type { AppState, LogicalSession } from "../../src/state/types";
import type { WechatAgent } from "../../src/agent";
import type { SessionService } from "../../src/sessions/session-service";

test("End-to-End Collaboration UX: @Mention -> Directive -> Selector Dispatch -> History Cards", async () => {
  const state: AppState = createEmptyState();

  // Create two logical sessions: Coordinator ("Main") and Backend Agent ("Backend")
  const sessionMain: LogicalSession = {
    alias: "main",
    agent: "claude",
    workspace: "xacpx",
    transport_session: "ts-main",
    logical_session_id: "ep-main-1111",
    display_name: "Main Coordinator",
    created_at: new Date().toISOString(),
    last_used_at: new Date().toISOString(),
  };

  const sessionBackend: LogicalSession = {
    alias: "backend",
    agent: "codex",
    workspace: "xacpx",
    transport_session: "ts-backend",
    logical_session_id: "ep-backend-2222",
    display_name: "Backend",
    created_at: new Date().toISOString(),
    last_used_at: new Date().toISOString(),
  };

  state.sessions.main = sessionMain;
  state.sessions.backend = sessionBackend;

  const events = createControlEventBus();
  const emittedEvents: ControlEvent[] = [];
  events.subscribe((e) => emittedEvents.push(e));

  const registry = new AgentEndpointRegistry({
    nodeId: "node_test_local",
    loadState: async () => state,
  });

  const injectedPrompts: Array<{ session: string; text: string }> = [];
  const fakeTransport = {
    injectMessage: async (
      session: { transportSession: string },
      input: { text: string },
    ) => {
      injectedPrompts.push({ session: session.transportSession, text: input.text });
      return { status: "queued" as const, deduplicated: false };
    },
  };

  const delivery = new LocalAgentMessageDeliveryAdapter({
    transport: fakeTransport,
    resolveLogicalSession: async (transportSession) => ({
      transportSession,
      agent: "codex",
      workspace: "xacpx",
    }),
    resolveWorkerSession: () => null,
  });

  const router = new AgentMessageRouter({
    nodeId: "node_test_local",
    registry,
    delivery,
    events,
  });

  // 1. Verify Selector Resolution via Registry
  const senderIdentity = await registry.resolveSender({ coordinatorSession: "ts-main" });
  const backendTarget = await registry.resolveSelector(senderIdentity, {
    displayName: "Backend",
  });
  expect(backendTarget.endpoint.handle).toBe("agent:node_test_local:ep-backend-2222");
  expect(backendTarget.endpoint.displayName).toBe("Backend");
  expect(backendTarget.endpoint.agent).toBe("codex");

  // 2. Simulate User Prompt with Structured Mention in SessionTurnRunner
  let agentReceivedPrompt = "";
  const mockAgent: WechatAgent = {
    chat: async (req) => {
      agentReceivedPrompt = req.text;
      return { ok: true, text: "I have coordinated with Backend." };
    },
  } as never;

  const fakeSessions: SessionService = {
    resolveAliasForChat: async () => "main",
    getSession: async (alias) => state.sessions[alias] ? {
      alias,
      transportSession: state.sessions[alias]!.transport_session,
      agent: state.sessions[alias]!.agent,
      workspace: state.sessions[alias]!.workspace,
      archived: false,
    } : undefined,
    useSession: async () => {},
  } as never;

  const turnRunner = new SessionTurnRunner({
    agent: mockAgent,
    sessions: fakeSessions,
    events,
    uploadStore: { root: "/tmp" } as never,
    resolveAgentTarget: async (handle: string) => {
      const target = await registry.resolveTarget(senderIdentity, handle);
      return {
        handle: target.endpoint.handle,
        displayName: target.endpoint.displayName ?? target.endpoint.agent,
        agent: target.endpoint.agent,
        workspace: target.endpoint.workspace,
      };
    },
  });

  const userPromptText = "Please ask @Backend if legacy_id can be deleted.";
  await turnRunner.run({
    chatKey: "wx:test",
    sessionAlias: "main",
    text: userPromptText,
    senderId: "user-1",
    agentMentions: [
      {
        range: [11, 19],
        handle: "agent:node_test_local:ep-backend-2222",
      },
    ],
  }, new AbortController().signal);

  // 3. Assert Trusted Directive was Injected into the Agent Prompt
  expect(agentReceivedPrompt).toContain("<xacpx-collaboration-directive>");
  expect(agentReceivedPrompt).toContain('handle="agent:node_test_local:ep-backend-2222"');
  expect(agentReceivedPrompt).toContain('display-name="Backend"');
  expect(agentReceivedPrompt).toContain('agent="codex"');
  expect(agentReceivedPrompt).toContain(userPromptText);

  // 4. Agent calls agent_send using selector
  const receipt = await router.send(
    { coordinatorSession: "ts-main" },
    {
      selector: { displayName: "Backend" },
      content: "Do we still need legacy_id in the user schema?",
    },
  );

  expect(receipt.status).toBe("queued");
  expect(receipt.messageId).toBeDefined();

  // 5. Verify Injected Message in Backend Agent Session
  expect(injectedPrompts.length).toBe(1);
  expect(injectedPrompts[0]!.session).toBe("ts-backend");
  expect(injectedPrompts[0]!.text).toContain("<xacpx-message");
  expect(injectedPrompts[0]!.text).toContain("Do we still need legacy_id in the user schema?");

  // 6. Verify Persistent Timeline History Events
  const agentMessageEvents = emittedEvents.filter(
    (e): e is Extract<ControlEvent, { type: "agent-message" }> =>
      e.type === "agent-message",
  );
  expect(agentMessageEvents.length).toBe(2);

  // Outbound Sent Event (for Main session)
  const sentEvent = agentMessageEvents.find((e) => e.message.direction === "sent");
  expect(sentEvent).toBeDefined();
  expect(sentEvent!.sessionAlias).toBe("main");
  expect(sentEvent!.message.peer.displayName).toBe("Backend");
  expect(sentEvent!.message.content).toBe("Do we still need legacy_id in the user schema?");

  // Inbound Received Event (for Backend session)
  const receivedEvent = agentMessageEvents.find((e) => e.message.direction === "received");
  expect(receivedEvent).toBeDefined();
  expect(receivedEvent!.sessionAlias).toBe("backend");
  expect(receivedEvent!.message.peer.displayName).toBe("Main Coordinator");
  expect(receivedEvent!.message.content).toBe("Do we still need legacy_id in the user schema?");
});
