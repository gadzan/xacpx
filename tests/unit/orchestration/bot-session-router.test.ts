import { expect, test } from "bun:test";

import {
  createControlEventBus,
  type ControlEvent,
  type ControlEventBus,
} from "../../../src/control/control-event-bus";
import { AgentEndpointRegistry } from "../../../src/orchestration/agent-endpoint-registry";
import { encodeAgentHandle } from "../../../src/orchestration/agent-handle";
import { AgentMessageRouter } from "../../../src/orchestration/agent-message-router";
import type { BotPeerDeliveryInput } from "../../../src/orchestration/agent-messaging-types";
import { createEmptyState, type AppState } from "../../../src/state/types";

const nodeId = "node_11111111-1111-4111-8111-111111111111";

function makeState(): AppState {
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
  // Product plumbing hidden by owner metadata — must never surface as a peer.
  state.sessions.brt_shadow = {
    alias: "brt_shadow",
    agent: "codex",
    workspace: "project",
    transport_session: "coordinator",
    logical_session_id: "33333333-3333-4333-8333-333333333333",
    owner: {
      kind: "bot-direct",
      bindingId: "binding-1",
      botId: "helper",
      conversationId: "conv-1",
      topicId: "topic-1",
    },
    created_at: "2026-08-18T00:00:00.000Z",
    last_used_at: "2026-08-18T00:00:00.000Z",
  };
  return state;
}

const botProfiles = [
  {
    id: "helper",
    name: "Helper Bot",
    agent: "codex",
    workspace: "project",
    enabled: true,
  },
  {
    id: "sleeping",
    name: "Sleeping Bot",
    agent: "claude",
    workspace: "project",
    enabled: false,
  },
];

function makeRegistry(state: AppState): AgentEndpointRegistry {
  return new AgentEndpointRegistry({
    nodeId,
    loadState: async () => state,
    listBots: () => botProfiles.map((b) => ({ ...b })),
  });
}

function makeRouter(
  state: AppState,
  registry: AgentEndpointRegistry,
  options: {
    events: ControlEventBus;
    deliveredToBot?: BotPeerDeliveryInput[];
    injectedTexts?: string[];
  },
) {
  return new AgentMessageRouter({
    registry,
    loadState: async () => state,
    delivery: {
      deliver: async (_target, _message, renderedText) => {
        options.injectedTexts?.push(renderedText);
        return { status: "injected" as const, modeUsed: "queue" as const };
      },
    },
    deliverToBot: async (input) => {
      options.deliveredToBot?.push(input);
      return { messageId: input.messageId, deliveryState: "accepted" };
    },
    createId: () => "bot-msg-1",
    now: () => 1_000,
    events: options.events,
  });
}

test("enabled bots are listed as bot endpoints; brt_* sessions never surface", async () => {
  const state = makeState();
  const registry = makeRegistry(state);

  const reachable = await registry.listReachable({
    coordinatorSession: "coordinator",
  });
  const bot = reachable.find((e) => e.endpointKind === "bot");
  expect(bot).toMatchObject({
    agent: "codex",
    workspace: "project",
    displayName: "Helper Bot",
    state: "idle",
    endpointKind: "bot",
    botId: "helper",
  });
  expect(bot?.address.endpointId).toBe("product-bot-helper");
  expect(bot?.capabilities).toMatchObject({
    receive: true,
    completion: false,
  });
  expect(
    reachable.some(
      (e) => e.address.endpointId === "product-bot-sleeping",
    ),
  ).toBe(false);
  expect(
    reachable.some(
      (e) =>
        e.address.endpointId === "33333333-3333-4333-8333-333333333333" ||
        e.sessionAlias === "brt_shadow",
    ),
  ).toBe(false);

  const published = await registry.getPublishedEndpoints();
  expect(
    published.some(
      (e) => e.endpointId === "product-bot-helper" && e.botId === "helper",
    ),
  ).toBe(true);
  expect(
    published.some((e) => e.endpointId === "product-bot-sleeping"),
  ).toBe(false);
  expect(
    published.some(
      (e) => e.endpointId === "33333333-3333-4333-8333-333333333333",
    ),
  ).toBe(false);
});

test("resolveTargetByHandle finds bot endpoints", async () => {
  const registry = makeRegistry(makeState());
  const resolved = await registry.resolveTargetByHandle(
    encodeAgentHandle({ nodeId, endpointId: "product-bot-helper" }),
  );
  expect(resolved).toMatchObject({
    endpointKind: "bot",
    botId: "helper",
    displayName: "Helper Bot",
  });
});

test("session → bot send is fire-and-forget with completion downgraded to none", async () => {
  const state = makeState();
  const registry = makeRegistry(state);
  const events = createControlEventBus();
  const emitted: ControlEvent[] = [];
  events.subscribe((e) => emitted.push(e));
  const deliveredToBot: BotPeerDeliveryInput[] = [];
  const injectedTexts: string[] = [];
  const router = makeRouter(state, registry, {
    events,
    deliveredToBot,
    injectedTexts,
  });

  const receipt = await router.send({ coordinatorSession: "coordinator" }, {
    to: encodeAgentHandle({ nodeId, endpointId: "product-bot-helper" }),
    content: "hello bot",
    completion: "notify",
  });

  expect(receipt).toEqual({
    messageId: "msg_bot-msg-1",
    status: "injected",
    route: "local",
  });
  // Session-lane delivery is never used for bots.
  expect(injectedTexts).toHaveLength(0);
  expect(deliveredToBot).toHaveLength(1);
  expect(deliveredToBot[0]).toMatchObject({
    toBotId: "helper",
    fromHandle: "main",
    fromName: "main",
    fromKind: "session",
    messageId: "msg_bot-msg-1",
    content: "hello bot",
  });
  // Downgrade note: the sent history entry records completion none.
  const sent = emitted.find(
    (e) => e.type === "agent-message" && e.message.direction === "sent",
  );
  expect(sent).toBeDefined();
  if (sent && sent.type === "agent-message") {
    expect(sent.sessionAlias).toBe("main");
    expect(sent.message).toMatchObject({
      messageId: "msg_bot-msg-1",
      completion: "none",
      peer: {
        handle: encodeAgentHandle({
          nodeId,
          endpointId: "product-bot-helper",
        }),
      },
    });
  }
});

test("bot → session injection carries from-kind bot, replyable true, and reply-to passthrough", async () => {
  const state = makeState();
  const registry = makeRegistry(state);
  const events = createControlEventBus();
  const emitted: ControlEvent[] = [];
  events.subscribe((e) => emitted.push(e));
  const injectedTexts: string[] = [];
  const router = makeRouter(state, registry, { events, injectedTexts });

  const receipt = await router.deliverFromBot({
    toSessionAlias: "main",
    fromBotId: "helper",
    fromName: "Helper Bot",
    content: "task done <ok>",
    messageId: "msg_frombot_1",
    replyTo: "msg_parent_9",
  });

  expect(receipt).toMatchObject({
    messageId: "msg_frombot_1",
    status: "injected",
    route: "local",
  });
  expect(injectedTexts).toHaveLength(1);
  const text = injectedTexts[0]!;
  expect(text).toContain('from-kind="bot"');
  expect(text).toContain('replyable="true"');
  expect(text).toContain('reply-to="msg_parent_9"');
  expect(text).toContain('from-name="Helper Bot"');
  expect(text).toContain("product-bot-helper");
  expect(text).toContain("task done &lt;ok&gt;");

  const received = emitted.find(
    (e) => e.type === "agent-message" && e.message.direction === "received",
  );
  expect(received).toBeDefined();
  if (received && received.type === "agent-message") {
    expect(received.sessionAlias).toBe("main");
    expect(received.message).toMatchObject({
      messageId: "msg_frombot_1",
      completion: "none",
      peer: { displayName: "Helper Bot" },
    });
  }
});

test("bot → session delivery rejects archived and brt_* targets", async () => {
  const state = makeState();
  state.sessions.old = {
    alias: "old",
    agent: "codex",
    workspace: "project",
    transport_session: "coordinator",
    logical_session_id: "44444444-4444-4444-4444-444444444444",
    archived: true,
    created_at: "2026-08-18T00:00:00.000Z",
    last_used_at: "2026-08-18T00:00:00.000Z",
  };
  const registry = makeRegistry(state);
  const events = createControlEventBus();
  const router = makeRouter(state, registry, { events });
  const base = {
    fromBotId: "helper",
    fromName: "Helper Bot",
    content: "ping",
    messageId: "msg_rejected_1",
  };

  await expect(
    router.deliverFromBot({ ...base, toSessionAlias: "old" }),
  ).rejects.toMatchObject({ code: "TARGET_NOT_REACHABLE" });
  await expect(
    router.deliverFromBot({ ...base, toSessionAlias: "brt_shadow" }),
  ).rejects.toMatchObject({ code: "TARGET_NOT_REACHABLE" });
  await expect(
    router.deliverFromBot({ ...base, toSessionAlias: "missing" }),
  ).rejects.toMatchObject({ code: "TARGET_NOT_REACHABLE" });
});
