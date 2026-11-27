import { expect, test } from "bun:test";

import {
  MSG,
  RELAY_PROTOCOL_VERSION,
  type RelayEnvelope,
} from "../../../packages/relay-protocol/src/index";
import {
  createControlBridge,
  subscribeControlEvents,
} from "../../../packages/channel-relay/src/control-bridge";

const req = (type: string, payload: unknown): RelayEnvelope => ({
  protocolVersion: RELAY_PROTOCOL_VERSION,
  kind: "req",
  id: "r-1",
  type,
  payload,
});

function makeControl(overrides: Record<string, unknown> = {}) {
  const listeners: Array<(event: unknown) => void> = [];
  const control = {
    events: {
      subscribe: (listener: (event: unknown) => void) => {
        listeners.push(listener);
        return () => {};
      },
    },
    isPrivateConversationTopic: () => false,
    ...overrides,
  };
  return {
    control,
    emit: (event: unknown) => listeners.forEach((l) => l(event)),
  };
}

function dispatch(
  bridge: ReturnType<typeof createControlBridge>,
  envelope: RelayEnvelope,
): Promise<unknown> {
  return new Promise((resolve) => bridge(envelope, resolve));
}

const dispatchedSession = {
  sessionAlias: "sess_1",
  displayName: "Workbench",
  agent: "codex",
  workspace: "ws",
  taskPreview: "do things",
};

test("conversation-message events passthrough dispatchedSession verbatim and never leak brt_*", () => {
  const { control, emit } = makeControl();
  const sent: Array<{ type: string; payload: unknown }> = [];
  subscribeControlEvents(control as never, (type, payload) =>
    sent.push({ type, payload }),
  );
  const message = {
    id: "m1",
    conversationId: "c1",
    topicId: "t1",
    seq: 1,
    role: "system",
    content: "dispatched",
    createdAt: "now",
    dispatchedSession: { ...dispatchedSession },
  };
  emit({ type: "conversation-message", message });
  expect(sent).toEqual([
    {
      type: MSG.instanceEvent,
      payload: {
        event: { type: "conversation-message", message },
      },
    },
  ]);
  const forwarded = (sent[0]!.payload as { event: { message: { dispatchedSession: typeof dispatchedSession } } })
    .event.message.dispatchedSession;
  expect(forwarded).toEqual(dispatchedSession);
  expect(forwarded.sessionAlias.startsWith("brt_")).toBe(false);
  expect(JSON.stringify(sent)).not.toContain("brt_");
});

test("conversation.timeline responses passthrough dispatchedSession verbatim", async () => {
  const message = {
    id: "m1",
    conversationId: "c1",
    topicId: "t1",
    seq: 1,
    role: "system",
    content: "dispatched",
    createdAt: "now",
    dispatchedSession: { ...dispatchedSession },
  };
  const timeline = {
    conversationId: "c1",
    topicId: "t1",
    entries: [{ kind: "message", key: "k1", anchorSeq: 1, message }],
    hasMoreBefore: false,
    hasMoreAfter: false,
  };
  const { control } = makeControl({
    conversationTimeline: async () => timeline,
  });
  const bridge = createControlBridge(control as never);
  const result = await dispatch(
    bridge,
    req(MSG.conversationTimeline, { conversationId: "c1", topicId: "t1" }),
  );
  expect(result).toEqual(timeline);
  expect(
    (result as typeof timeline).entries[0]!.message.dispatchedSession,
  ).toEqual(dispatchedSession);
  expect(JSON.stringify(result)).not.toContain("brt_");
});

test("conversationCompletions passthrough targetKind/sessionAlias/botId and keeps legacy items", async () => {
  const completions = {
    version: 1,
    scope: { conversationId: "c", topicId: "t", botId: "bot_a" },
    revision: "r",
    commands: { status: "ready", items: [] },
    mentions: {
      status: "ready",
      items: [
        {
          handle: "agent:node:product-bot-bot_1",
          displayName: "Helper",
          botId: "bot_1",
          agent: "codex",
          targetKind: "bot",
        },
        {
          handle: "sess_1",
          displayName: "Session",
          agent: "codex",
          workspace: "ws",
          targetKind: "session",
          sessionAlias: "sess_1",
        },
        // Back-compat: items without targetKind read as bot mentions.
        { handle: "legacy", displayName: "Legacy", agent: "codex" },
      ],
    },
  };
  const seen: unknown[] = [];
  const { control } = makeControl({
    getConversationCompletions: async (input: unknown) => {
      seen.push(input);
      return completions;
    },
  });
  const bridge = createControlBridge(control as never);
  const result = await dispatch(
    bridge,
    req(MSG.conversationCompletionsGet, { conversationId: "c", topicId: "t" }),
  );
  expect(seen).toEqual([{ conversationId: "c", topicId: "t" }]);
  expect(result).toEqual(completions);
});
