import { describe, expect, test } from "bun:test";

import { PermissionInteractionBroker } from "../../../src/permissions/permission-interaction-broker.js";
import {
  createTurnInteractionRegistry,
  type TurnInteractionContext,
} from "../../../src/interactions/turn-interaction-registry.js";

function turn(overrides: Partial<TurnInteractionContext> = {}): TurnInteractionContext {
  return {
    interactionId: `ix-${Math.random().toString(36).slice(2, 10)}`,
    chatKey: "discord:default:g:c1",
    accountId: "default",
    senderId: "user-A",
    origin: "human",
    ...overrides,
  };
}

describe("TurnInteractionRegistry", () => {
  test("resolve returns exactly the bound turn", () => {
    const registry = createTurnInteractionRegistry();
    const route = turn();
    registry.bindTurn(route);
    expect(registry.resolve(route.interactionId)).toBe(route);
    expect(registry.resolve("ix-does-not-exist")).toBeUndefined();
    registry.clear();
  });

  test("dispose removes only the binding it created", () => {
    const registry = createTurnInteractionRegistry();
    const a = turn();
    const b = turn();
    const disposeA = registry.bindTurn(a);
    const disposeB = registry.bindTurn(b);
    disposeA();
    expect(registry.resolve(a.interactionId)).toBeUndefined();
    expect(registry.resolve(b.interactionId)).toBe(b);
    disposeB();
    expect(registry.boundTurnCount).toBe(0);
  });

  test("dispose is idempotent and never unblocks another turn's subscription", () => {
    const registry = createTurnInteractionRegistry();
    const a = turn();
    const b = turn();
    const disposeA = registry.bindTurn(a);
    const disposeB = registry.bindTurn(b);
    let aFired = 0;
    let bFired = 0;
    registry.subscribeAbort(a.interactionId, () => {
      aFired += 1;
    });
    registry.subscribeAbort(b.interactionId, () => {
      bFired += 1;
    });
    disposeA();
    disposeA();
    expect(aFired).toBe(1);
    expect(bFired).toBe(0);
    disposeB();
    expect(bFired).toBe(1);
  });

  test("abort signal fires the subscription and unbinds the route", () => {
    const registry = createTurnInteractionRegistry();
    const controller = new AbortController();
    const route = turn();
    registry.bindTurn(route, controller.signal);
    let fired = 0;
    registry.subscribeAbort(route.interactionId, () => {
      fired += 1;
    });
    controller.abort();
    controller.abort();
    expect(fired).toBe(1);
    expect(registry.resolve(route.interactionId)).toBeUndefined();
  });

  test("binding an already-aborted signal unbinds immediately", () => {
    const registry = createTurnInteractionRegistry();
    const controller = new AbortController();
    controller.abort();
    registry.bindTurn(turn(), controller.signal);
    expect(registry.boundTurnCount).toBe(0);
  });

  test("duplicate interactionId binding is rejected, not overwritten", () => {
    const registry = createTurnInteractionRegistry();
    const route = turn();
    registry.bindTurn(route);
    expect(() => registry.bindTurn(turn({ interactionId: route.interactionId }))).toThrow();
    expect(registry.resolve(route.interactionId)).toBe(route);
    registry.clear();
  });

  test("unsubscribe stops further notifications", () => {
    const registry = createTurnInteractionRegistry();
    const route = turn();
    const dispose = registry.bindTurn(route);
    let fired = 0;
    const unsubscribe = registry.subscribeAbort(route.interactionId, () => {
      fired += 1;
    });
    unsubscribe();
    dispose();
    expect(fired).toBe(0);
  });

  test("subscriber failure does not break the registry", () => {
    const registry = createTurnInteractionRegistry();
    const route = turn();
    const dispose = registry.bindTurn(route);
    let later = 0;
    registry.subscribeAbort(route.interactionId, () => {
      throw new Error("listener exploded");
    });
    registry.subscribeAbort(route.interactionId, () => {
      later += 1;
    });
    expect(() => dispose()).not.toThrow();
    expect(later).toBe(1);
    expect(registry.resolve(route.interactionId)).toBeUndefined();
  });

  test("two turns sharing one logical session remain distinct", () => {
    const registry = createTurnInteractionRegistry();
    const a = turn({ chatKey: "discord:default:g:c1", senderId: "user-A" });
    const b = turn({ chatKey: "discord:default:g:c2", senderId: "user-B" });
    const disposeA = registry.bindTurn(a);
    const disposeB = registry.bindTurn(b);
    expect(registry.resolve(a.interactionId)?.senderId).toBe("user-A");
    expect(registry.resolve(b.interactionId)?.senderId).toBe("user-B");
    disposeA();
    expect(registry.resolve(b.interactionId)?.senderId).toBe("user-B");
    disposeB();
  });

  test("scheduled/peer/orchestration routes cannot masquerade as human", () => {
    const registry = createTurnInteractionRegistry();
    const scheduled = turn({ origin: "scheduled" });
    const peer = turn({ origin: "peer" });
    const orchestration = turn({ origin: "orchestration" });
    const disposers = [scheduled, peer, orchestration].map((route) => registry.bindTurn(route));
    // The route EXISTS (permission routing can find it) but its origin is
    // authoritative: neither broker may treat it as a human interaction.
    expect(registry.resolve(scheduled.interactionId)?.origin).toBe("scheduled");
    expect(registry.resolve(peer.interactionId)?.origin).toBe("peer");
    expect(registry.resolve(orchestration.interactionId)?.origin).toBe("orchestration");
    for (const dispose of disposers) dispose();
  });
});

describe("PermissionInteractionBroker registry sharing", () => {
  test("broker shares an injected registry and keeps its own pending set", () => {
    const registry = createTurnInteractionRegistry();
    const broker = new PermissionInteractionBroker({
      getChannelByChatKey: () => null,
      registry,
    });
    const route = turn();
    broker.bindTurn(route);
    // The route is visible through the shared registry: the same binding is
    // what the Elicitation broker resolves against (G2/G3).
    expect(registry.resolve(route.interactionId)).toBe(route);
    expect(broker.boundTurnCount).toBe(1);
    expect(broker.pendingCount).toBe(0);
    broker.shutdown();
    expect(registry.boundTurnCount).toBe(0);
  });

  test("permission outcome stays reject_once when the shared registry is shut down", async () => {
    const registry = createTurnInteractionRegistry();
    const broker = new PermissionInteractionBroker({
      getChannelByChatKey: () => ({
        id: "fake",
        isLoggedIn: () => true,
        login: async () => "t",
        logout: () => {},
        start: async () => {},
        notifyTaskCompletion: async () => {},
        notifyTaskProgress: async () => {},
        sendCoordinatorMessage: async () => {},
        requestPermission: async () => ({ outcome: "allow_once", responderId: "user-A" }),
      } as never),
      registry,
    });
    const route = turn();
    broker.bindTurn(route);
    const decision = await broker.requestPermission({
      logicalSessionId: "s1",
      sessionKey: "s1",
      requestId: "req-1",
      toolCallId: "tool-1",
      title: "edit",
      kind: "edit",
      rawInput: { path: "a.ts" },
      policyGeneration: 0,
      workerGeneration: "w1",
      interactionId: route.interactionId,
      availableOutcomes: ["allow_once", "reject_once"],
    });
    expect(decision).toEqual({ outcome: "allow_once" });
  });

  test("interaction ids are unique UUIDs", () => {
    const ids = new Set(Array.from({ length: 50 }, () => PermissionInteractionBroker.createInteractionId()));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });
});
