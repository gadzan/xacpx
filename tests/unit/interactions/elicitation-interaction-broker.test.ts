import { describe, expect, test } from "bun:test";

import type {
  ChannelElicitationDecision,
  ChannelElicitationRequest,
  MessageChannelRuntime,
} from "../../../src/channels/types.js";
import {
  ElicitationInteractionBroker,
  ELICITATION_INTERACTION_TIMEOUT_MS,
  ELICITATION_RPC_TIMEOUT_MS,
  resetGlobalElicitationBrokerForTests,
  setGlobalElicitationBroker,
  getGlobalElicitationBroker,
  type RuntimeElicitationRequest,
} from "../../../src/interactions/elicitation-interaction-broker.js";
import { createTurnInteractionRegistry } from "../../../src/interactions/turn-interaction-registry.js";
import type { TurnInteractionContext } from "../../../src/interactions/turn-interaction-registry.js";
import type { AppLogger } from "../../../src/logging/app-logger.js";

const SENTINEL_ANSWER = "SENTINEL-ELICITATION-ANSWER-9f3c2a";

function turn(overrides: Partial<TurnInteractionContext> = {}): TurnInteractionContext {
  return {
    interactionId: `ix-${Math.random().toString(36).slice(2, 10)}`,
    chatKey: "discord:default:g:c1",
    accountId: "default",
    replyContextToken: "msg-1",
    senderId: "user-A",
    senderName: "Ada",
    isOwner: true,
    origin: "human",
    ...overrides,
  };
}

/** ACP form request carrying one required text field. */
function acpFormRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "acp-1",
    mode: "form",
    message: "Provide the migration note",
    requestedSchema: {
      type: "object",
      properties: { note: { type: "string", title: "Note", minLength: 1, maxLength: 200 } },
      required: ["note"],
    },
    ...overrides,
  };
}

function request(overrides: Partial<RuntimeElicitationRequest> = {}): RuntimeElicitationRequest {
  return {
    promptRequestId: `prompt-${Math.random().toString(36).slice(2, 10)}`,
    elicitationRequestId: `elicit-${Math.random().toString(36).slice(2, 10)}`,
    // ACP User Interaction Requirements: the client must identify the
    // requesting Agent, so every production request carries a trusted name.
    agentName: "codex",
    request: acpFormRequest(),
    ...overrides,
  };
}

type FakeChannel = MessageChannelRuntime & {
  requestElicitation?: (request: ChannelElicitationRequest) => Promise<ChannelElicitationDecision>;
};

/**
 * An unbounded pending decision: models a channel UI that never settles.
 * Held via a resolver so tests can release it late (race coverage).
 */
function pendingDecision(): {
  promise: Promise<ChannelElicitationDecision>;
  settle: (decision: ChannelElicitationDecision) => void;
} {
  const { promise, resolve } = Promise.withResolvers<ChannelElicitationDecision>();
  return { promise, settle: resolve };
}

function formChannel(
  behavior: (request: ChannelElicitationRequest) => Promise<ChannelElicitationDecision>,
  seen: ChannelElicitationRequest[] = [],
  opts: { modes?: readonly ("form" | "url")[] } = {},
): FakeChannel {
  return {
    id: "fake",
    isLoggedIn: () => true,
    login: async () => "token",
    logout: () => {},
    start: async () => {},
    notifyTaskCompletion: async () => {},
    notifyTaskProgress: async () => {},
    sendCoordinatorMessage: async () => {},
    elicitationModes: opts.modes ?? ["form"],
    requestElicitation: async (request) => {
      seen.push(request);
      return await behavior(request);
    },
  } as unknown as FakeChannel;
}

interface Harness {
  broker: ElicitationInteractionBroker;
  registry: ReturnType<typeof createTurnInteractionRegistry>;
  logs: Array<{ event: string; fields: Record<string, unknown> }>;
}

function harness(options: {
  channel?: MessageChannelRuntime | null;
  timeoutMs?: number;
} = {}): Harness {
  const registry = createTurnInteractionRegistry();
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const logger: AppLogger = {
    info: async (event, _message, fields) => {
      logs.push({ event, fields: fields ?? {} });
    },
    warn: async () => {},
    error: async () => {},
    debug: async () => {},
  } as unknown as AppLogger;
  const broker = new ElicitationInteractionBroker({
    registry,
    getChannelByChatKey: () => options.channel ?? null,
    logger,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  return { broker, registry, logs };
}

describe("ElicitationInteractionBroker accept path", () => {
  test("validated answer becomes accept with exact AC novelty", async () => {
    const seen: ChannelElicitationRequest[] = [];
    const channel = formChannel(async () => ({
      action: "accept",
      responderId: "user-A",
      content: { note: SENTINEL_ANSWER },
    }), seen);
    const { broker, registry } = harness({ channel });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({ interactionId: route.interactionId }));
      expect(result).toEqual({ action: "accept", content: { note: SENTINEL_ANSWER } });
      // Exact-turn requester identity and server-side pending state reached
      // the channel with no persisted answer anywhere.
      expect(seen).toHaveLength(1);
      expect(seen[0].requester.senderId).toBe("user-A");
      expect(seen[0].mode).toBe("form");
      expect(seen[0].fields[0]).toMatchObject({ key: "note", required: true, kind: "text" });
      expect(broker.pendingCount).toBe(0);
    } finally {
      dispose();
    }
  });

  test("explicit decline maps to decline", async () => {
    const channel = formChannel(async () => ({ action: "decline", responderId: "user-A" }));
    const { broker } = harness({ channel });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({ interactionId: route.interactionId }));
      expect(result).toEqual({ action: "decline" });
    } finally {
      dispose();
    }
  });

  test("channel-returned cancel maps to cancel, not decline", async () => {
    const channel = formChannel(async () => ({ action: "cancel", responderId: "user-A" }));
    const { broker } = harness({ channel });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({ interactionId: route.interactionId }));
      expect(result).toEqual({ action: "cancel" });
    } finally {
      dispose();
    }
  });

  test("null content accept is preserved as null", async () => {
    // All fields optional: a valid ACP accept may carry null content.
    const channel = formChannel(async () => ({ action: "accept", responderId: "user-A", content: null }));
    const { broker } = harness({ channel });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({
        interactionId: route.interactionId,
        request: {
          sessionId: "acp-1",
          mode: "form",
          message: "Nothing to fill",
          requestedSchema: { type: "object", properties: { note: { type: "string" } } },
        },
      }));
      expect(result).toEqual({ action: "accept", content: null });
    } finally {
      dispose();
    }
  });
});

describe("ElicitationInteractionBroker fail-closed paths", () => {
  test("missing interactionId cancels without invoking channel UI", async () => {
    const seen: ChannelElicitationRequest[] = [];
    const channel = formChannel(async () => ({ action: "accept", responderId: "user-A", content: { note: "x" } }), seen);
    const { broker } = harness({ channel });
    const result = await broker.resolveElicitation(request());
    expect(result).toEqual({ action: "cancel" });
    expect(seen).toHaveLength(0);
  });

  test("unknown interactionId cancels", async () => {
    const seen: ChannelElicitationRequest[] = [];
    const channel = formChannel(async () => ({ action: "accept", responderId: "user-A", content: { note: "x" } }), seen);
    const { broker } = harness({ channel });
    const result = await broker.resolveElicitation(request({ interactionId: "ix-unknown" }));
    expect(result).toEqual({ action: "cancel" });
    expect(seen).toHaveLength(0);
  });

  test("non-human origin cancels without UI", async () => {
    const seen: ChannelElicitationRequest[] = [];
    const channel = formChannel(async () => ({ action: "accept", responderId: "user-A", content: { note: "x" } }), seen);
    const { broker, registry } = harness({ channel });
    const scheduledRoute = turn({ origin: "scheduled" });
    const dispose = registry.bindTurn(scheduledRoute);
    try {
      const result = await broker.resolveElicitation(request({ interactionId: scheduledRoute.interactionId }));
      expect(result).toEqual({ action: "cancel" });
      expect(seen).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  test("route without initiator identity cancels", async () => {
    const seen: ChannelElicitationRequest[] = [];
    const channel = formChannel(async () => ({ action: "accept", responderId: "user-A", content: { note: "x" } }), seen);
    const { broker, registry } = harness({ channel });
    const route = turn({ senderId: undefined });
    const dispose = registry.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({ interactionId: route.interactionId }));
      expect(result).toEqual({ action: "cancel" });
      expect(seen).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  test("channel without requestElicitation cancels (unsupported plugin)", async () => {
    const channel = {
      id: "textonly",
      isLoggedIn: () => true,
      login: async () => "t",
      logout: () => {},
      start: async () => {},
      notifyTaskCompletion: async () => {},
      notifyTaskProgress: async () => {},
      sendCoordinatorMessage: async () => {},
    } as unknown as MessageChannelRuntime;
    const { broker } = harness({ channel });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({ interactionId: route.interactionId }));
      expect(result).toEqual({ action: "cancel" });
    } finally {
      dispose();
    }
  });

  test("declared form mode without an implementation is not support", async () => {
    const seen: ChannelElicitationRequest[] = [];
    const channel = formChannel(async () => ({ action: "accept", responderId: "user-A", content: { note: "x" } }), seen);
    delete (channel as { requestElicitation?: unknown }).requestElicitation;
    const { broker } = harness({ channel });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({ interactionId: route.interactionId }));
      expect(result).toEqual({ action: "cancel" });
      expect(seen).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  test("url-only channel cancels a form request", async () => {
    const channel = formChannel(async () => ({ action: "cancel", responderId: "user-A" }), [], { modes: ["url"] });
    const { broker } = harness({ channel });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({ interactionId: route.interactionId }));
      expect(result).toEqual({ action: "cancel" });
    } finally {
      dispose();
    }
  });

  test("invalid schema cancels without UI", async () => {
    const seen: ChannelElicitationRequest[] = [];
    const channel = formChannel(async () => ({ action: "accept", responderId: "user-A", content: { note: "x" } }), seen);
    const { broker } = harness({ channel });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({
        interactionId: route.interactionId,
        request: acpFormRequest({ mode: "url", elicitationId: "e-1" }),
      }));
      expect(result).toEqual({ action: "cancel" });
      expect(seen).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  test("invalid accepted answer cancels instead of accepting it", async () => {
    const channel = formChannel(async () => ({ action: "accept", responderId: "user-A", content: { note: 12345 } }));
    const { broker } = harness({ channel });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({ interactionId: route.interactionId }));
      expect(result).toEqual({ action: "cancel" });
    } finally {
      dispose();
    }
  });

  test("accepted answer with an unexpected extra key cancels", async () => {
    const channel = formChannel(async () => ({
      action: "accept",
      responderId: "user-A",
      content: { note: "fine", extra: "unrequested" },
    }));
    const { broker } = harness({ channel });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({ interactionId: route.interactionId }));
      expect(result).toEqual({ action: "cancel" });
    } finally {
      dispose();
    }
  });

  test("plugin throw cancels", async () => {
    const channel = formChannel(async () => {
      throw new Error("discord exploded");
    });
    const { broker } = harness({ channel });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({ interactionId: route.interactionId }));
      expect(result).toEqual({ action: "cancel" });
    } finally {
      dispose();
    }
  });

  test("wrong authenticated responder is never accepted and never declines", async () => {
    const channel = formChannel(async () => ({
      action: "accept",
      responderId: "user-INTRUDER",
      content: { note: SENTINEL_ANSWER },
    }));
    const { broker } = harness({ channel });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({ interactionId: route.interactionId }));
      expect(result).toEqual({ action: "cancel" });
    } finally {
      dispose();
    }
  });

  test("missing responderId cancels", async () => {
    const channel = formChannel(async () => ({
      action: "accept",
      content: { note: "x" },
    } as unknown as ChannelElicitationDecision));
    const { broker } = harness({ channel });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({ interactionId: route.interactionId }));
      expect(result).toEqual({ action: "cancel" });
    } finally {
      dispose();
    }
  });

  test("shutdown cancels and refuses later requests", async () => {
    const channel = formChannel(async () => ({ action: "accept", responderId: "user-A", content: { note: "x" } }));
    const { broker } = harness({ channel });
    const route = turn();
    const dispose = broker.bindTurn(route);
    broker.shutdown();
    try {
      const result = await broker.resolveElicitation(request({ interactionId: route.interactionId }));
      expect(result).toEqual({ action: "cancel" });
    } finally {
      dispose();
    }
  });
});

describe("ElicitationInteractionBroker deadlines and races", () => {
  test("timeout cancels when the channel never settles", async () => {
    const seen: ChannelElicitationRequest[] = [];
    // Never settles: the broker deadline must win. Tiny timeout is the tested
    // deadline itself, and the channel must observe its signal abort.
    const pending = pendingDecision();
    const channel = formChannel((request) => {
      seen.push(request);
      return pending.promise;
    }, seen);
    const { broker } = harness({ channel, timeoutMs: 20 });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({ interactionId: route.interactionId }));
      expect(result).toEqual({ action: "cancel" });
      expect(seen[0].signal.aborted).toBe(true);
      expect(broker.pendingCount).toBe(0);
    } finally {
      dispose();
    }
  });

  test("channel that ignores the abort still settles on timeout", async () => {
    // The channel resolves only AFTER the broker settled: the late answer
    // must fail closed. The barrier is the broker's own promise, not a sleep.
    const pending = pendingDecision();
    const channel = formChannel(() => pending.promise);
    const { broker } = harness({ channel, timeoutMs: 20 });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const settled = await broker.resolveElicitation(request({ interactionId: route.interactionId }));
      expect(settled).toEqual({ action: "cancel" });
      pending.settle({ action: "accept", responderId: "user-A", content: { note: SENTINEL_ANSWER } });
      await Promise.resolve();
      expect(broker.pendingCount).toBe(0);
    } finally {
      dispose();
    }
  });

  test("turn abort cancels the pending request immediately", async () => {
    const seen: ChannelElicitationRequest[] = [];
    const received = Promise.withResolvers<ChannelElicitationRequest>();
    const pending = pendingDecision();
    const channel = formChannel((request) => {
      seen.push(request);
      received.resolve(request);
      return pending.promise;
    }, seen);
    const { broker } = harness({ channel, timeoutMs: 60_000 });
    const route = turn();
    const controller = new AbortController();
    const dispose = broker.bindTurn(route, controller.signal);
    // Barrier on the real dispatch event: no guessed duration.
    const pending_result = broker.resolveElicitation(request({ interactionId: route.interactionId }));
    await received.promise;
    controller.abort();
    expect(await pending_result).toEqual({ action: "cancel" });
    expect(seen[0].signal.aborted).toBe(true);
    dispose();
  });

  test("request-scoped cancellation stops the renderer without ending the turn", async () => {
    // Regression: the abort path was turn-disposal only. An agent withdrawing a
    // single `elicitation/create` (ACP `$/cancel_request`) left the renderer
    // collecting input until the 120s deadline, because nothing propagated the
    // cancellation out of the worker into the broker.
    const seen: ChannelElicitationRequest[] = [];
    const firstReceived = Promise.withResolvers<ChannelElicitationRequest>();
    const firstPending = pendingDecision();
    let calls = 0;
    const channel = formChannel((request) => {
      seen.push(request);
      calls += 1;
      // First request never settles (models a live renderer); the next request
      // on the same turn settles at once, proving the route survived.
      if (calls === 1) {
        firstReceived.resolve(request);
        return firstPending.promise;
      }
      return Promise.resolve({ action: "accept", responderId: "user-A", content: { note: SENTINEL_ANSWER } });
    }, seen);
    const { broker } = harness({ channel, timeoutMs: 60_000 });
    const route = turn();
    const dispose = broker.bindTurn(route);
    const inflight = request({ interactionId: route.interactionId });
    const result = broker.resolveElicitation(inflight);
    await firstReceived.promise;

    // Cancel by request id ONLY. The turn route must stay bound: the agent's
    // prompt continues and could legitimately ask another question on the
    // same turn.
    expect(broker.cancelElicitationRequest(inflight.elicitationRequestId, { reason: "agent_cancel_request" })).toBe(true);
    expect(await result).toEqual({ action: "cancel" });
    expect(seen[0].signal.aborted).toBe(true);

    // Turn route still live: a later elicitation on the SAME turn is served
    // instead of failing closed, which is what proves this was request-scoped
    // cancellation and not turn disposal.
    const second = await broker.resolveElicitation(request({ interactionId: route.interactionId }));
    expect(second).toEqual({ action: "accept", content: { note: SENTINEL_ANSWER } });
    dispose();
  });

  test("request-scoped cancellation is idempotent and fails closed for unknown ids", () => {
    const { broker } = harness();
    // Unknown id: nothing to cancel, no throw. A cancel for a request this
    // broker never saw must not fabricate a cancellation.
    expect(broker.cancelElicitationRequest("does-not-exist")).toBe(false);
    expect(broker.pendingCount).toBe(0);
  });

  test("a late answer after request-scoped cancellation is ignored", async () => {
    // Same first-terminal-wins discipline as the timeout/turn paths: the
    // channel resolving afterwards must not change the terminal action.
    const seen: ChannelElicitationRequest[] = [];
    const received = Promise.withResolvers<ChannelElicitationRequest>();
    const pending = pendingDecision();
    const channel = formChannel((request) => {
      seen.push(request);
      received.resolve(request);
      return pending.promise;
    }, seen);
    const { broker } = harness({ channel, timeoutMs: 60_000 });
    const route = turn();
    const dispose = broker.bindTurn(route);
    const inflight = request({ interactionId: route.interactionId });
    const result = broker.resolveElicitation(inflight);
    await received.promise;
    broker.cancelElicitationRequest(inflight.elicitationRequestId);
    expect(await result).toEqual({ action: "cancel" });
    pending.settle({ action: "accept", responderId: "user-A", content: { note: SENTINEL_ANSWER } });
    await Promise.resolve();
    expect(broker.pendingCount).toBe(0);
    dispose();
  });

  test("an already-aborted external signal cancels before any UI is shown", async () => {
    // The upstream caller (daemon bridge RPC) may already be aborted by the
    // time the broker runs. Rejecting here must not leave a dispatched UI.
    const controller = new AbortController();
    controller.abort();
    const seen: ChannelElicitationRequest[] = [];
    const channel = formChannel(async () => ({ action: "accept", responderId: "user-A", content: { note: "x" } }), seen);
    const { broker } = harness({ channel, timeoutMs: 60_000 });
    const route = turn();
    const dispose = broker.bindTurn(route);
    const result = await broker.resolveElicitation(
      request({ interactionId: route.interactionId }),
      controller.signal,
    );
    expect(result).toEqual({ action: "cancel" });
    // No renderer was ever invoked for a request cancelled before dispatch.
    expect(seen.length).toBe(0);
    dispose();
  });

  test("an external abort never reaches the renderer's decision path", async () => {
    // Regression (round 15): round 14 added a responder-free
    // `{ action: "cancel" }` union member so a renderer could report an
    // external abort. That branch was UNREACHABLE on a real abort — the
    // `aborted` race rejects first, and if the renderer's decision somehow wins
    // the race the post-decision `controller.signal.aborted` check sends it to
    // `settleStale`. Its only reachable effect was letting a live request
    // settle a cancel WITHOUT the authenticated responder a user dismissal
    // must carry.
    //
    // So the contract is: external abort is NOT a ChannelElicitationDecision.
    // The renderer withdraws its UI and throws/never settles; core finishes.
    const seen: ChannelElicitationRequest[] = [];
    const received = Promise.withResolvers<ChannelElicitationRequest>();
    const pending = pendingDecision();
    const channel = formChannel((request) => {
      seen.push(request);
      received.resolve(request);
      // Models the WORST CASE, not the documented behaviour. A broken renderer
      // that settles a responder-free cancel on abort (the round-14 mistake)
      // must STILL end in core's cancel, and must NOT have that settle treated
      // as a user action — the `aborted` race / post-decision checks own it.
      request.signal.addEventListener("abort", () => {
        pending.settle({ action: "cancel" } as unknown as ChannelElicitationDecision);
      }, { once: true });
      return pending.promise;
    }, seen);
    const { broker } = harness({ channel, timeoutMs: 60_000 });
    const route = turn();
    const dispose = broker.bindTurn(route);
    const inflight = request({ interactionId: route.interactionId });
    const result = broker.resolveElicitation(inflight);
    await received.promise;
    // Core's own request-scoped cancellation, not the renderer's.
    expect(broker.cancelElicitationRequest(inflight.elicitationRequestId)).toBe(true);
    expect(await result).toEqual({ action: "cancel" });
    expect(seen[0].signal.aborted).toBe(true);
    dispose();
  });

  test("a cancel without a responder id is rejected on a live request", async () => {
    // Regression (round 15): the responder-free variant let a renderer or
    // control-path bug settle a user `cancel` anonymously. Fail-closed result,
    // but the actor boundary was bypassed. Every decision this broker accepts
    // now requires the platform-authenticated responder.
    const seen: ChannelElicitationRequest[] = [];
    const channel = formChannel(async () => ({
      action: "cancel",
    } as unknown as ChannelElicitationDecision), seen);
    const { broker, logs } = harness({ channel });
    const route = turn();
    const dispose = broker.bindTurn(route);
    const result = await broker.resolveElicitation(request({ interactionId: route.interactionId }));
    // Still cancel overall (fail closed), but recorded as a channel failure,
    // NOT as an accepted user dismissal.
    expect(result).toEqual({ action: "cancel" });
    const events = logs.map((entry) => entry.event);
    expect(events).toContain("elicitation.interaction.channel_failed");
    expect(broker.pendingCount).toBe(0);
    dispose();
  });

  test("a cancel carrying answer content but no responder is rejected", async () => {
    // Content smuggled into a responder-free cancel would bypass the
    // responder-identity check every accept goes through, so it must fail
    // closed rather than be treated as a partial accept.
    const seen: ChannelElicitationRequest[] = [];
    const channel = formChannel(async () => ({
      action: "cancel",
      content: { note: SENTINEL_ANSWER },
    } as unknown as ChannelElicitationDecision), seen);
    const { broker, logs } = harness({ channel });
    const route = turn();
    const dispose = broker.bindTurn(route);
    const result = await broker.resolveElicitation(request({ interactionId: route.interactionId }));
    expect(result).toEqual({ action: "cancel" });
    // The smuggled content must never reach the agent.
    const serialized = JSON.stringify(logs.map((entry) => entry.fields));
    expect(serialized).not.toContain(SENTINEL_ANSWER);
    dispose();
  });

  test("turn disposal (prompt settled) cancels the pending request", async () => {
    const seen: ChannelElicitationRequest[] = [];
    const received = Promise.withResolvers<ChannelElicitationRequest>();
    const pending = pendingDecision();
    const channel = formChannel((request) => {
      seen.push(request);
      received.resolve(request);
      return pending.promise;
    }, seen);
    const { broker } = harness({ channel, timeoutMs: 60_000 });
    const route = turn();
    const dispose = broker.bindTurn(route);
    const result = broker.resolveElicitation(request({ interactionId: route.interactionId }));
    await received.promise;
    dispose();
    expect(await result).toEqual({ action: "cancel" });
  });

  test("late decision after abort is ignored (first terminal wins)", async () => {
    const received = Promise.withResolvers<ChannelElicitationRequest>();
    const pending = pendingDecision();
    const channel = formChannel((request) => {
      received.resolve(request);
      return pending.promise;
    });
    const { broker } = harness({ channel, timeoutMs: 60_000 });
    const route = turn();
    const controller = new AbortController();
    const dispose = broker.bindTurn(route, controller.signal);
    const result = broker.resolveElicitation(request({ interactionId: route.interactionId }));
    await received.promise;
    controller.abort();
    expect(await result).toEqual({ action: "cancel" });
    // The channel resolving after the abort must not change the outcome.
    pending.settle({ action: "accept", responderId: "user-A", content: { note: SENTINEL_ANSWER } });
    await Promise.resolve();
    expect(broker.pendingCount).toBe(0);
    // A second request on the dead route still fails closed.
    const after = await broker.resolveElicitation(request({ interactionId: route.interactionId }));
    expect(after).toEqual({ action: "cancel" });
    dispose();
  });

  test("duplicate elicitationRequestId cancels the second attempt", async () => {
    const seen: ChannelElicitationRequest[] = [];
    const channel = formChannel(async () => ({ action: "accept", responderId: "user-A", content: { note: "x" } }), seen);
    const { broker } = harness({ channel });
    const route = turn();
    const dispose = broker.bindTurn(route);
    const id = "elicit-dup-1";
    try {
      const [first, second] = await Promise.all([
        broker.resolveElicitation(request({ elicitationRequestId: id, interactionId: route.interactionId })),
        broker.resolveElicitation(request({ elicitationRequestId: id, interactionId: route.interactionId })),
      ]);
      expect([first.action, second.action]).toEqual(["accept", "cancel"]);
      expect(seen).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  test("two turns sharing one logical session stay distinct", async () => {
    const seen: ChannelElicitationRequest[] = [];
    const channel = formChannel(async (request) => ({
      action: "accept",
      responderId: request.requester.senderId,
      content: { note: request.requester.senderId },
    }), seen);
    const { broker, registry } = harness({ channel });
    const routeA = turn({ chatKey: "discord:default:g:c1", senderId: "user-A" });
    const routeB = turn({ chatKey: "discord:default:g:c2", senderId: "user-B" });
    const disposeA = broker.bindTurn(routeA);
    const disposeB = broker.bindTurn(routeB);
    try {
      const resultA = await broker.resolveElicitation(request({ interactionId: routeA.interactionId }));
      const resultB = await broker.resolveElicitation(request({ interactionId: routeB.interactionId }));
      expect(resultA).toEqual({ action: "accept", content: { note: "user-A" } });
      expect(resultB).toEqual({ action: "accept", content: { note: "user-B" } });
      expect(registry.resolve(routeA.interactionId)?.senderId).toBe("user-A");
      expect(registry.resolve(routeB.interactionId)?.senderId).toBe("user-B");
    } finally {
      disposeA();
      disposeB();
    }
  });

  test("a renderer that widens options cannot authorize a value the agent never offered", async () => {
    // Regression: the renderer received the same mutable object graph core
    // validated against, so pushing an option made an unauthorized value pass.
    const { broker, registry } = harness({
      channel: formChannel(async (request) => {
        // Innocent UI tidying that changes core's validation truth.
        (request.fields[0] as { options: unknown[] }).options.push({ value: "green", label: "Green" });
        return { action: "accept", responderId: "user-A", content: { note: "green" } };
      }),
    });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({
        interactionId: route.interactionId,
        request: acpFormRequest({
          requestedSchema: {
            type: "object",
            properties: { note: { type: "string", enum: ["red", "blue"] } },
            required: ["note"],
          },
        }),
      }));
      expect(result).toEqual({ action: "cancel" });
    } finally {
      dispose();
    }
  });

  test("a renderer that clears required cannot make a missing answer pass", async () => {
    const { broker, registry } = harness({
      channel: formChannel(async (request) => {
        (request.fields[0] as { required: boolean }).required = false;
        return { action: "accept", responderId: "user-A", content: {} };
      }),
    });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({ interactionId: route.interactionId }));
      expect(result).toEqual({ action: "cancel" });
    } finally {
      dispose();
    }
  });

  test("a renderer that relaxes minLength cannot authorize a short answer", async () => {
    const { broker, registry } = harness({
      channel: formChannel(async (request) => {
        (request.fields[0] as { minLength?: number }).minLength = 1;
        return { action: "accept", responderId: "user-A", content: { note: "x" } };
      }),
    });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({
        interactionId: route.interactionId,
        request: acpFormRequest({
          requestedSchema: {
            type: "object",
            properties: { note: { type: "string", minLength: 5 } },
            required: ["note"],
          },
        }),
      }));
      expect(result).toEqual({ action: "cancel" });
    } finally {
      dispose();
    }
  });

  test("the renderer receives a frozen presentation copy", async () => {
    // Freezing turns silent validation drift into a loud throw, which the
    // broker maps to cancel.
    let frozen = false;
    const { broker, registry } = harness({
      channel: formChannel(async (request) => {
        frozen = Object.isFrozen(request.fields) && Object.isFrozen(request.fields[0]);
        return { action: "decline", responderId: "user-A" };
      }),
    });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      await broker.resolveElicitation(request({ interactionId: route.interactionId }));
      expect(frozen).toBe(true);
    } finally {
      dispose();
    }
  });

test("a multi-select answer array is cloned, not aliased to the plugin's", async () => {
  // Regression: the validator returned the plugin's own string[] reference,
  // so a post-validation mutation could still reach the agent.
  const submitted: string[] = ["a"];
    const { broker, registry } = harness({
      channel: formChannel(async () => ({
        action: "accept",
        responderId: "user-A",
        content: { tags: submitted },
      })),
    });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({
        interactionId: route.interactionId,
        request: {
          sessionId: "acp-1",
          mode: "form",
          message: "Pick tags",
          requestedSchema: {
            type: "object",
            properties: { tags: { type: "array", items: { type: "string", enum: ["a", "b"] } } },
            required: ["tags"],
          },
        },
      }));
      expect(result).toEqual({ action: "accept", content: { tags: ["a"] } });
      if (result.action !== "accept" || result.content === null) throw new Error("unreachable");
      // Mutating the plugin's array afterwards must not change what core
      // already returned.
      submitted.push("b");
      expect(result.content.tags).toEqual(["a"]);
    } finally {
      dispose();
    }
  });

  test("a content getter cannot turn a validated answer into accept + null", async () => {
    // Regression: the broker validated `decision.content` and then READ IT
    // AGAIN to decide the shape. A getter returning a valid required answer on
    // the first read and `null` on the second produced
    // `{ action: "accept", content: null }` after core had already approved the
    // content — bypassing the private validation snapshot.
    let reads = 0;
    const { broker, registry } = harness({
      channel: formChannel(async () => ({
        action: "accept",
        responderId: "user-A",
        get content() {
          reads += 1;
          return reads === 1 ? { note: "valid" } : null;
        },
      } as never)),
    });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({ interactionId: route.interactionId }));
      // The accessor is rejected outright: a plain object is all a renderer
      // needs, so this must never reach accept.
      expect(result).toEqual({ action: "cancel" });
      expect(reads).toBe(0);
      expect(broker.pendingCount).toBe(0);
    } finally {
      dispose();
    }
  });

  test("a decision with accessor action or responderId is rejected", async () => {
    for (const key of ["action", "responderId"]) {
      const { broker, registry } = harness({
        channel: formChannel(async () => ({
          action: "accept",
          responderId: "user-A",
          content: { note: "valid" },
          get [key]() {
            return key === "action" ? "accept" : "user-A";
          },
        } as never)),
      });
      const route = turn();
      const dispose = broker.bindTurn(route);
      try {
        const result = await broker.resolveElicitation(request({ interactionId: route.interactionId }));
        expect(result).toEqual({ action: "cancel" });
      } finally {
        dispose();
      }
    }
  });

  test("a request without agent identity cancels without showing UI", async () => {
    // ACP User Interaction Requirements oblige the client to identify the
    // requesting Agent. Without a trusted name the renderer would have to
    // guess from the chat route, so core fails closed instead.
    const seen: ChannelElicitationRequest[] = [];
    const { broker, registry } = harness({
      channel: formChannel(async () => ({ action: "accept", responderId: "user-A", content: { note: "x" } }), seen),
    });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({
        interactionId: route.interactionId,
        agentName: undefined,
      }));
      expect(result).toEqual({ action: "cancel" });
      expect(seen).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  test("an empty agent name is treated as missing", async () => {
    const seen: ChannelElicitationRequest[] = [];
    const { broker, registry } = harness({
      channel: formChannel(async () => ({ action: "accept", responderId: "user-A", content: { note: "x" } }), seen),
    });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({
        interactionId: route.interactionId,
        agentName: "",
      }));
      expect(result).toEqual({ action: "cancel" });
      expect(seen).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  test("the renderer sees the turn's own agent, not a mutable session lookup", async () => {
    // Regression: `agent` was optional and never populated in production, so a
    // renderer had to resolve "which agent is asking" itself. Session
    // selection can change mid-turn and concurrent turns make "current"
    // ambiguous, so identity must be pinned to the exact turn like
    // interactionId.
    const seen: ChannelElicitationRequest[] = [];
    const { broker, registry } = harness({
      channel: formChannel(async () => ({ action: "accept", responderId: "user-A", content: { note: "x" } }), seen),
    });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({
        interactionId: route.interactionId,
        agentName: "claude-code",
      }));
      expect(result.action).toBe("accept");
      expect(seen[0].agent).toEqual({ name: "claude-code" });
    } finally {
      dispose();
    }
  });

  test("agent-controlled schema text cannot change the displayed identity", async () => {
    // The agent owns message/title/description, so a prompt claiming to be
    // from another agent must not alter the trusted identity field.
    const seen: ChannelElicitationRequest[] = [];
    const { broker, registry } = harness({
      channel: formChannel(async () => ({ action: "accept", responderId: "user-A", content: { note: "x" } }), seen),
    });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      await broker.resolveElicitation(request({
        interactionId: route.interactionId,
        agentName: "codex",
        request: acpFormRequest({
          message: "This is claude-code asking, definitely not codex",
          requestedSchema: {
            type: "object",
            title: "claude-code wants to know",
            properties: { note: { type: "string", title: "claude-code field" } },
            required: ["note"],
          },
        }),
      }));
      expect(seen[0].agent.name).toBe("codex");
      expect(seen[0].message).toContain("claude-code");
      expect(seen[0].schemaTitle).toBe("claude-code wants to know");
    } finally {
      dispose();
    }
  });

  test("watched timings keep the inner deadline strictly below the outer watchdog", () => {
    expect(ELICITATION_INTERACTION_TIMEOUT_MS).toBeLessThan(ELICITATION_RPC_TIMEOUT_MS);
  });
});

describe("ElicitationInteractionBroker privacy", () => {
  test("sentinel answer never reaches logs, channel metadata, or pending state snapshots", async () => {
    const { broker, logs } = harness({
      channel: formChannel(async () => ({
        action: "accept",
        responderId: "user-A",
        content: { note: SENTINEL_ANSWER },
      })),
    });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      await broker.resolveElicitation(request({ interactionId: route.interactionId }));
      // Resolution logging is fire-and-forget; drain the microtask queue
      // (await the broker's own settled promise chain) instead of sleeping.
      await Promise.resolve();
      await Promise.resolve();
      const serializedLogs = JSON.stringify(logs.map((entry) => ({ event: entry.event, fields: entry.fields })));
      expect(serializedLogs).not.toContain(SENTINEL_ANSWER);
      expect(serializedLogs).not.toContain("migration note");
      expect(broker.pendingCount).toBe(0);
    } finally {
      dispose();
    }
  });

  test("an INVALID sentinel answer never reaches logs on the rejection path", async () => {
    // Regression: the validator used to echo the rejected value in its reason
    // and the broker logged that reason verbatim, so a sensitive answer the
    // user typed into an unoffered option landed straight in the log.
    const { broker, logs } = harness({
      channel: formChannel(async () => ({
        action: "accept",
        responderId: "user-A",
        // Valid key, invalid value: enum violation carrying the sentinel.
        content: { note: SENTINEL_ANSWER },
      })),
    });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      // Enum-restricted schema so the sentinel is an enum violation.
      const result = await broker.resolveElicitation(request({
        interactionId: route.interactionId,
        request: {
          sessionId: "acp-1",
          mode: "form",
          message: "Pick one",
          requestedSchema: {
            type: "object",
            properties: { note: { type: "string", enum: ["red", "blue"] } },
            required: ["note"],
          },
        },
      }));
      expect(result).toEqual({ action: "cancel" });
      await Promise.resolve();
      await Promise.resolve();
      const serializedLogs = JSON.stringify(logs.map((entry) => ({ event: entry.event, fields: entry.fields })));
      expect(serializedLogs).not.toContain(SENTINEL_ANSWER);
      // The stable reason is still recorded so the failure is diagnosable.
      expect(serializedLogs).toContain("not an offered option");
    } finally {
      dispose();
    }
  });

  test("a throwing renderer's message never reaches logs", async () => {
    // Regression: the broker logged `error.message` verbatim, and a renderer
    // that echoes submitted values into its exception text would leak them.
    const { broker, logs } = harness({
      channel: formChannel(async () => {
        throw new Error(`renderer failed while rendering ${SENTINEL_ANSWER}`);
      }),
    });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({ interactionId: route.interactionId }));
      expect(result).toEqual({ action: "cancel" });
      await Promise.resolve();
      await Promise.resolve();
      const serializedLogs = JSON.stringify(logs.map((entry) => ({ event: entry.event, fields: entry.fields })));
      expect(serializedLogs).not.toContain(SENTINEL_ANSWER);
      // The error TYPE is still recorded so the failure is diagnosable.
      expect(serializedLogs).toContain("errorType");
    } finally {
      dispose();
    }
  });

  test("a renderer that hides its answer in constructor.name cannot leak it", async () => {
    // Regression: `error.constructor.name` is renderer-controlled. A real Error
    // instance with an overriding `constructor` property passes `instanceof`
    // while its name is an arbitrary string — including the submitted answer.
    const { broker, logs } = harness({
      channel: formChannel(async () => {
        const error = new Error("boom");
        Object.defineProperty(error, "constructor", {
          value: { name: SENTINEL_ANSWER },
          configurable: true,
        });
        throw error;
      }),
    });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({ interactionId: route.interactionId }));
      expect(result).toEqual({ action: "cancel" });
      await Promise.resolve();
      await Promise.resolve();
      const serializedLogs = JSON.stringify(logs.map((entry) => ({ event: entry.event, fields: entry.fields })));
      expect(serializedLogs).not.toContain(SENTINEL_ANSWER);
      // The classification is the fixed literal, not anything the thrown value
      // provides.
      expect(serializedLogs).toContain('"errorType":"thrown"');
    } finally {
      dispose();
    }
  });

  test("a renderer whose constructor getter throws does not break the broker", async () => {
    // A throwing getter used to make the broker's own catch handler throw.
    const { broker, logs } = harness({
      channel: formChannel(async () => {
        const error = new Error("boom");
        Object.defineProperty(error, "constructor", {
          get() {
            throw new Error("constructor getter exploded");
          },
          configurable: true,
        });
        throw error;
      }),
    });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({ interactionId: route.interactionId }));
      expect(result).toEqual({ action: "cancel" });
      expect(broker.pendingCount).toBe(0);
      await Promise.resolve();
      await Promise.resolve();
      const serializedLogs = JSON.stringify(logs.map((entry) => ({ event: entry.event, fields: entry.fields })));
      expect(serializedLogs).toContain('"errorType":"thrown"');
    } finally {
      dispose();
    }
  });

  test("a throwing getPrototypeOf trap does not leak the pending entry", async () => {
    // Regression: `error instanceof Error` invokes a Proxy's
    // [[GetPrototypeOf]], so a throwing trap escaped the catch handler, skipped
    // unsubscribeTurnAbort()/settleStale(), and left the pending map entry
    // behind forever (turn dispose only marks settled, it never deletes).
    const { broker } = harness({
      channel: formChannel(async () => {
        throw new Proxy({}, {
          getPrototypeOf() {
            throw new Error("getPrototypeOf trap exploded");
          },
        });
      }),
    });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({ interactionId: route.interactionId }));
      expect(result).toEqual({ action: "cancel" });
      // The pending entry must be gone, not just marked settled.
      expect(broker.pendingCount).toBe(0);
    } finally {
      dispose();
    }
  });

  test("an unexpected answer key is never logged by key", async () => {
    const { broker, logs } = harness({
      channel: formChannel(async () => ({
        action: "accept",
        responderId: "user-A",
        content: { a: "1", b: "2", c: "3", d: "4", SENTINEL_ANSWER: "extra" },
      })) as never,
    });
    const route = turn();
    const dispose = broker.bindTurn(route);
    try {
      const result = await broker.resolveElicitation(request({
        interactionId: route.interactionId,
        request: {
          sessionId: "acp-1",
          mode: "form",
          message: "Four fields",
          requestedSchema: {
            type: "object",
            properties: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" }, d: { type: "string" } },
          },
        },
      }));
      expect(result).toEqual({ action: "cancel" });
      await Promise.resolve();
      await Promise.resolve();
      const serializedLogs = JSON.stringify(logs.map((entry) => ({ event: entry.event, fields: entry.fields })));
      // The key itself must never appear — neither the index form nor the
      // count-bound form may echo it.
      expect(serializedLogs).not.toContain(SENTINEL_ANSWER);
      expect(serializedLogs).toMatch(/unexpected answer key/);
    } finally {
      dispose();
    }
  });

  test("global broker accessors round-trip and reset cleanly", () => {
    const { broker } = harness();
    setGlobalElicitationBroker(broker);
    expect(getGlobalElicitationBroker()).toBe(broker);
    resetGlobalElicitationBrokerForTests();
    expect(getGlobalElicitationBroker()).toBeNull();
  });
});
