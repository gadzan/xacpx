// tests/unit/packages/relay-protocol/bot-session-comm-split.test.ts
// Phase 1 SHARED PROTOCOL: bot endpointKind + dispatchedSession validation.
import { expect, test } from "bun:test";
import {
  decodeEnvelope,
  encodeEnvelope,
  parseWebServerEvent,
  validControlEvent,
  webEventEnvelope,
  type ConversationCompletionMention,
  type WebServerEvent,
} from "../../../../packages/relay-protocol/src/index";

const baseMessage = {
  id: "m1",
  conversationId: "c1",
  topicId: "t1",
  seq: 1,
  content: "dispatched",
  createdAt: "now",
};

const validDispatch = {
  sessionAlias: "sess_1",
  displayName: "Workbench",
  agent: "codex",
  workspace: "ws",
  taskPreview: "do things",
};

const conversationMessage = (role: string, dispatchedSession?: unknown) => ({
  ...baseMessage,
  role,
  ...(dispatchedSession === undefined ? {} : { dispatchedSession }),
});

type AgentDirectoryEndpoints = Extract<WebServerEvent, { kind: "agent-directory" }>["endpoints"];

const agentDirectoryEvent = (endpoints: Array<Record<string, unknown>>): WebServerEvent => ({
  kind: "agent-directory",
  endpoints: endpoints as unknown as AgentDirectoryEndpoints,
});

function parses(event: WebServerEvent): boolean {
  const wire = encodeEnvelope(webEventEnvelope(event));
  const decoded = decodeEnvelope(wire);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) return false;
  return parseWebServerEvent(decoded.envelope) !== null;
}

test("endpointKind bot is accepted on agent-directory", () => {
  const event = agentDirectoryEvent([
    {
      instanceId: "i1",
      nodeId: "node_a",
      endpointId: "ep_bot",
      agent: "codex",
      state: "idle",
      capabilities: { receive: true, steer: false, queue: true, interrupt: false },
      updatedAt: 1771234567890,
      endpointKind: "bot",
      botId: "bot_1",
    },
  ]);
  expect(parses(event)).toBe(true);
});

test("endpointKind logical/worker/omitted still accepted; unknown rejected", () => {
  const ok = (endpointKind?: string) =>
    parses(
      agentDirectoryEvent([
        {
          instanceId: "i1",
          nodeId: "node_a",
          endpointId: "ep_1",
          agent: "codex",
          state: "idle",
          capabilities: { receive: true, steer: false, queue: true, interrupt: false },
          updatedAt: 1771234567890,
          ...(endpointKind === undefined ? {} : { endpointKind }),
        },
      ]),
    );
  expect(ok(undefined)).toBe(true);
  expect(ok("logical")).toBe(true);
  expect(ok("worker")).toBe(true);
  expect(ok("bot")).toBe(true);
  expect(ok("ghost")).toBe(false);
});

test("agent-directory never leaks brt_ session aliases", () => {
  const event = agentDirectoryEvent([
    {
      instanceId: "i1",
      nodeId: "node_a",
      endpointId: "ep_1",
      agent: "codex",
      sessionAlias: "brt_hidden",
      state: "idle",
      capabilities: { receive: true, steer: false, queue: true, interrupt: false },
      updatedAt: 1771234567890,
    },
  ]);
  expect(parses(event)).toBe(false);
});

test("valid dispatchedSession on a system message is accepted", () => {
  expect(
    validControlEvent({
      type: "conversation-message",
      message: conversationMessage("system", validDispatch),
    }),
  ).toBe(true);
});

test("dispatchedSession on non-system roles is rejected", () => {
  for (const role of ["human", "bot"]) {
    expect(
      validControlEvent({
        type: "conversation-message",
        message: conversationMessage(role, validDispatch),
      }),
    ).toBe(false);
  }
});

test("dispatchedSession with brt_ alias is rejected", () => {
  expect(
    validControlEvent({
      type: "conversation-message",
      message: conversationMessage("system", { ...validDispatch, sessionAlias: "brt_hidden" }),
    }),
  ).toBe(false);
});

test("dispatchedSession with empty alias, null byte, or control chars is rejected", () => {
  for (const sessionAlias of ["", "sess_\0_1", "sess_\n_1", "sess_\u007f_1"]) {
    expect(
      validControlEvent({
        type: "conversation-message",
        message: conversationMessage("system", { ...validDispatch, sessionAlias }),
      }),
    ).toBe(false);
  }
});

test("dispatchedSession oversize fields are rejected", () => {
  const cases: Array<[string, unknown]> = [
    ["sessionAlias", "x".repeat(257)],
    ["displayName", "x".repeat(257)],
    ["agent", "x".repeat(129)],
    ["workspace", "x".repeat(257)],
    ["taskPreview", "x".repeat(2001)],
  ];
  for (const [key, value] of cases) {
    expect(
      validControlEvent({
        type: "conversation-message",
        message: conversationMessage("system", { ...validDispatch, [key]: value }),
      }),
    ).toBe(false);
  }
});

test("ConversationCompletionMention targetKind/sessionAlias are optional, missing reads as bot", () => {
  const botMention: ConversationCompletionMention = {
    handle: "@helper",
    displayName: "Helper",
    botId: "bot_1",
    agent: "codex",
  };
  const sessionMention: ConversationCompletionMention = {
    handle: "@sess",
    displayName: "Session",
    agent: "codex",
    targetKind: "session",
    sessionAlias: "sess_1",
  };
  const targetOf = (m: ConversationCompletionMention) => m.targetKind ?? "bot";
  expect(targetOf(botMention)).toBe("bot");
  expect(targetOf(sessionMention)).toBe("session");
  expect(sessionMention.sessionAlias).toBe("sess_1");
});
