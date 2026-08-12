import { expect, test } from "bun:test";

import {
  TerminalAttachmentGenerationMismatchError,
  TerminalAttachmentNotFoundError,
  TerminalAttachmentRegistry,
  TerminalNotControllerError,
  TerminalViewerCapacityExceededError,
  type TerminalAttachmentEvent,
} from "../../../../packages/channel-relay/src/terminal/terminal-attachments";

function makeRegistry(overrides: Partial<ConstructorParameters<typeof TerminalAttachmentRegistry>[0]> = {}) {
  const events: TerminalAttachmentEvent[] = [];
  let now = 0;
  const registry = new TerminalAttachmentRegistry({
    maxViewersPerTerminal: 4,
    attachmentTtlMs: 45_000,
    clock: { now: () => now },
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  return { registry, events, advance: (ms: number) => { now += ms; } };
}

// ---------------------------------------------------------------------------
// attach: first controller, later spectators, capacity
// ---------------------------------------------------------------------------

test("first attachment becomes controller, later attachments become spectators", () => {
  const { registry } = makeRegistry();

  const first = registry.attach({ viewerId: "viewer-a", terminalId: "term-1", generation: "gen-1" });
  expect(first.role).toBe("controller");
  expect(first.viewerCount).toBe(1);

  const second = registry.attach({ viewerId: "viewer-b", terminalId: "term-1", generation: "gen-1" });
  expect(second.role).toBe("spectator");
  expect(second.viewerCount).toBe(2);

  const third = registry.attach({ viewerId: "viewer-c", terminalId: "term-1", generation: "gen-1" });
  expect(third.role).toBe("spectator");
  expect(third.viewerCount).toBe(3);
});

test("attachmentIds are unpredictable, not sequential/guessable", () => {
  const { registry } = makeRegistry();
  const a = registry.attach({ viewerId: "viewer-a", terminalId: "term-1", generation: "gen-1" });
  const b = registry.attach({ viewerId: "viewer-b", terminalId: "term-1", generation: "gen-1" });
  expect(a.attachmentId).not.toBe(b.attachmentId);
  expect(a.attachmentId.length).toBeGreaterThanOrEqual(16);
  expect(/^[0-9a-f-]+$/i.test(a.attachmentId)).toBe(true);
});

test("attach rejects once maxViewersPerTerminal is reached", () => {
  const { registry } = makeRegistry({ maxViewersPerTerminal: 2 });
  registry.attach({ viewerId: "viewer-a", terminalId: "term-1", generation: "gen-1" });
  registry.attach({ viewerId: "viewer-b", terminalId: "term-1", generation: "gen-1" });
  expect(() => registry.attach({ viewerId: "viewer-c", terminalId: "term-1", generation: "gen-1" })).toThrow(
    TerminalViewerCapacityExceededError,
  );
});

test("attachments are isolated per terminalId", () => {
  const { registry } = makeRegistry();
  const a = registry.attach({ viewerId: "viewer-a", terminalId: "term-1", generation: "gen-1" });
  const b = registry.attach({ viewerId: "viewer-b", terminalId: "term-2", generation: "gen-2" });
  expect(a.role).toBe("controller");
  expect(b.role).toBe("controller");
  expect(registry.getViewerCount("term-1")).toBe(1);
  expect(registry.getViewerCount("term-2")).toBe(1);
});

// ---------------------------------------------------------------------------
// input / resize validation
// ---------------------------------------------------------------------------

test("controller can input/resize; spectator is rejected at this layer", () => {
  const { registry } = makeRegistry();
  const controller = registry.attach({ viewerId: "viewer-a", terminalId: "term-1", generation: "gen-1" });
  const spectator = registry.attach({ viewerId: "viewer-b", terminalId: "term-1", generation: "gen-1" });

  expect(() => registry.assertCanInput(controller.attachmentId, "gen-1")).not.toThrow();
  expect(() => registry.assertCanResize(controller.attachmentId, "gen-1")).not.toThrow();

  expect(() => registry.assertCanInput(spectator.attachmentId, "gen-1")).toThrow(TerminalNotControllerError);
  expect(() => registry.assertCanResize(spectator.attachmentId, "gen-1")).toThrow(TerminalNotControllerError);
});

test("input/resize reject unknown attachment and generation mismatch", () => {
  const { registry } = makeRegistry();
  const controller = registry.attach({ viewerId: "viewer-a", terminalId: "term-1", generation: "gen-1" });

  expect(() => registry.assertCanInput("unknown-id", "gen-1")).toThrow(TerminalAttachmentNotFoundError);
  expect(() => registry.assertCanInput(controller.attachmentId, "stale-gen")).toThrow(
    TerminalAttachmentGenerationMismatchError,
  );
});

// ---------------------------------------------------------------------------
// takeControl: atomic demotion, generation checks
// ---------------------------------------------------------------------------

test("takeControl atomically demotes the old controller and emits role-changed to both", () => {
  const { registry, events } = makeRegistry();
  const controller = registry.attach({ viewerId: "viewer-a", terminalId: "term-1", generation: "gen-1" });
  const spectator = registry.attach({ viewerId: "viewer-b", terminalId: "term-1", generation: "gen-1" });
  events.length = 0;

  const result = registry.takeControl({ attachmentId: spectator.attachmentId, generation: "gen-1" });
  expect(result.role).toBe("controller");
  expect(result.viewerCount).toBe(2);

  expect(registry.getAttachment(controller.attachmentId)?.role).toBe("spectator");
  expect(registry.getAttachment(spectator.attachmentId)?.role).toBe("controller");

  const roleChanged = events.filter((e): e is Extract<TerminalAttachmentEvent, { type: "role-changed" }> => e.type === "role-changed");
  const forOldController = roleChanged.find((e) => e.attachmentId === controller.attachmentId);
  const forNewController = roleChanged.find((e) => e.attachmentId === spectator.attachmentId);
  expect(forOldController?.role).toBe("spectator");
  expect(forNewController?.role).toBe("controller");
  expect(forOldController?.viewerCount).toBe(2);
});

test("takeControl by the current controller is idempotent", () => {
  const { registry } = makeRegistry();
  const controller = registry.attach({ viewerId: "viewer-a", terminalId: "term-1", generation: "gen-1" });
  const result = registry.takeControl({ attachmentId: controller.attachmentId, generation: "gen-1" });
  expect(result.role).toBe("controller");
  expect(registry.getAttachment(controller.attachmentId)?.role).toBe("controller");
});

test("takeControl rejects unknown attachment and stale generation", () => {
  const { registry } = makeRegistry();
  const controller = registry.attach({ viewerId: "viewer-a", terminalId: "term-1", generation: "gen-1" });

  expect(() => registry.takeControl({ attachmentId: "unknown", generation: "gen-1" })).toThrow(
    TerminalAttachmentNotFoundError,
  );
  expect(() => registry.takeControl({ attachmentId: controller.attachmentId, generation: "stale" })).toThrow(
    TerminalAttachmentGenerationMismatchError,
  );
});

// ---------------------------------------------------------------------------
// detach: no auto-promotion after the controller leaves
// ---------------------------------------------------------------------------

test("after the controller detaches, the terminal has no controller and spectators are not auto-promoted", () => {
  const { registry } = makeRegistry();
  const controller = registry.attach({ viewerId: "viewer-a", terminalId: "term-1", generation: "gen-1" });
  const spectator = registry.attach({ viewerId: "viewer-b", terminalId: "term-1", generation: "gen-1" });

  registry.detach(controller.attachmentId);

  expect(registry.getAttachment(spectator.attachmentId)?.role).toBe("spectator");
  expect(registry.listByTerminal("term-1").some((a) => a.role === "controller")).toBe(false);
  expect(registry.getViewerCount("term-1")).toBe(1);

  // The spectator can still explicitly take control.
  const result = registry.takeControl({ attachmentId: spectator.attachmentId, generation: "gen-1" });
  expect(result.role).toBe("controller");
});

test("a fresh attach after the controller left fills the empty controller slot", () => {
  const { registry } = makeRegistry();
  const controller = registry.attach({ viewerId: "viewer-a", terminalId: "term-1", generation: "gen-1" });
  registry.attach({ viewerId: "viewer-b", terminalId: "term-1", generation: "gen-1" });
  registry.detach(controller.attachmentId);

  const rejoined = registry.attach({ viewerId: "viewer-c", terminalId: "term-1", generation: "gen-1" });
  expect(rejoined.role).toBe("controller");
});

test("detach is idempotent for an unknown/already-detached attachment", () => {
  const { registry } = makeRegistry();
  const controller = registry.attach({ viewerId: "viewer-a", terminalId: "term-1", generation: "gen-1" });
  registry.detach(controller.attachmentId);
  expect(() => registry.detach(controller.attachmentId)).not.toThrow();
  expect(() => registry.detach("never-existed")).not.toThrow();
});

test("detachMany bulk-detaches without auto-promoting remaining spectators", () => {
  const { registry } = makeRegistry();
  const controller = registry.attach({ viewerId: "viewer-a", terminalId: "term-1", generation: "gen-1" });
  const spectatorB = registry.attach({ viewerId: "viewer-b", terminalId: "term-1", generation: "gen-1" });
  const spectatorC = registry.attach({ viewerId: "viewer-c", terminalId: "term-1", generation: "gen-1" });

  registry.detachMany([controller.attachmentId, spectatorB.attachmentId, "unknown-id"]);

  expect(registry.getViewerCount("term-1")).toBe(1);
  expect(registry.getAttachment(spectatorC.attachmentId)?.role).toBe("spectator");
  expect(registry.listByTerminal("term-1").some((a) => a.role === "controller")).toBe(false);
});

// ---------------------------------------------------------------------------
// TTL expiry via injectable clock — no real sleeps
// ---------------------------------------------------------------------------

test("expireStale removes attachments past attachmentTtlMs and recomputes viewerCount", () => {
  const { registry, advance, events } = makeRegistry({ attachmentTtlMs: 1_000 });
  const a = registry.attach({ viewerId: "viewer-a", terminalId: "term-1", generation: "gen-1" });
  const b = registry.attach({ viewerId: "viewer-b", terminalId: "term-1", generation: "gen-1" });

  advance(500);
  registry.heartbeat(b.attachmentId); // keep b alive
  advance(600); // a is now 1100ms stale, b is 600ms since its heartbeat

  events.length = 0;
  const expired = registry.expireStale();

  expect(expired).toEqual([a.attachmentId]);
  expect(registry.getAttachment(a.attachmentId)).toBeUndefined();
  expect(registry.getAttachment(b.attachmentId)).toBeDefined();
  expect(registry.getViewerCount("term-1")).toBe(1);

  const broadcast = events.find((e) => e.type === "role-changed" && e.attachmentId === b.attachmentId);
  expect(broadcast && broadcast.type === "role-changed" && broadcast.viewerCount).toBe(1);
});

test("heartbeat refreshes TTL and throws for an unknown attachment", () => {
  const { registry, advance } = makeRegistry({ attachmentTtlMs: 1_000 });
  const a = registry.attach({ viewerId: "viewer-a", terminalId: "term-1", generation: "gen-1" });

  advance(900);
  registry.heartbeat(a.attachmentId);
  advance(900);
  expect(registry.expireStale()).toEqual([]);

  expect(() => registry.heartbeat("unknown")).toThrow(TerminalAttachmentNotFoundError);
});

test("expireStale never touches attachments below the TTL threshold", () => {
  const { registry, advance } = makeRegistry({ attachmentTtlMs: 1_000 });
  const a = registry.attach({ viewerId: "viewer-a", terminalId: "term-1", generation: "gen-1" });
  advance(999);
  expect(registry.expireStale()).toEqual([]);
  expect(registry.getAttachment(a.attachmentId)).toBeDefined();
});

// ---------------------------------------------------------------------------
// per-attachment outbound queue: hard byte cap, isolated overflow
// ---------------------------------------------------------------------------

test("enqueueOutbound accepts bytes under the cap and rejects once it overflows", () => {
  const registry = new TerminalAttachmentRegistry({ maxViewersPerTerminal: 4, attachmentTtlMs: 45_000, maxQueueBytes: 100 });
  const att = registry.attach({ viewerId: "viewer-a", terminalId: "term-1", generation: "gen-1" });

  expect(registry.enqueueOutbound(att.attachmentId, new Uint8Array(60))).toBe(true);
  expect(registry.isOutboundQueueClosed(att.attachmentId)).toBe(false);

  expect(registry.enqueueOutbound(att.attachmentId, new Uint8Array(60))).toBe(false);
  expect(registry.isOutboundQueueClosed(att.attachmentId)).toBe(true);

  // Further enqueue attempts stay rejected without growing the counter further.
  expect(registry.enqueueOutbound(att.attachmentId, new Uint8Array(10))).toBe(false);
});

test("queue overflow on one attachment does not affect another viewer's queue", () => {
  const registry = new TerminalAttachmentRegistry({ maxViewersPerTerminal: 4, attachmentTtlMs: 45_000, maxQueueBytes: 50 });
  const a = registry.attach({ viewerId: "viewer-a", terminalId: "term-1", generation: "gen-1" });
  const b = registry.attach({ viewerId: "viewer-b", terminalId: "term-1", generation: "gen-1" });

  expect(registry.enqueueOutbound(a.attachmentId, new Uint8Array(100))).toBe(false);
  expect(registry.isOutboundQueueClosed(a.attachmentId)).toBe(true);

  expect(registry.enqueueOutbound(b.attachmentId, new Uint8Array(30))).toBe(true);
  expect(registry.isOutboundQueueClosed(b.attachmentId)).toBe(false);
});

test("enqueueOutbound emits queue-overflow exactly for the affected attachment", () => {
  const events: TerminalAttachmentEvent[] = [];
  const registry = new TerminalAttachmentRegistry({
    maxViewersPerTerminal: 4,
    attachmentTtlMs: 45_000,
    maxQueueBytes: 20,
    onEvent: (e) => events.push(e),
  });
  const a = registry.attach({ viewerId: "viewer-a", terminalId: "term-1", generation: "gen-1" });
  events.length = 0;

  registry.enqueueOutbound(a.attachmentId, new Uint8Array(30));
  const overflow = events.filter((e) => e.type === "queue-overflow");
  expect(overflow).toEqual([{ type: "queue-overflow", attachmentId: a.attachmentId, terminalId: "term-1" }]);
});

test("resetOutboundQueue reopens a closed queue for resync without touching role/generation", () => {
  const registry = new TerminalAttachmentRegistry({ maxViewersPerTerminal: 4, attachmentTtlMs: 45_000, maxQueueBytes: 10 });
  const a = registry.attach({ viewerId: "viewer-a", terminalId: "term-1", generation: "gen-1" });

  registry.enqueueOutbound(a.attachmentId, new Uint8Array(20));
  expect(registry.isOutboundQueueClosed(a.attachmentId)).toBe(true);

  registry.resetOutboundQueue(a.attachmentId);
  expect(registry.isOutboundQueueClosed(a.attachmentId)).toBe(false);
  expect(registry.getOutboundQueueBytes(a.attachmentId)).toBe(0);
  expect(registry.getAttachment(a.attachmentId)?.role).toBe("controller");

  expect(registry.enqueueOutbound(a.attachmentId, new Uint8Array(5))).toBe(true);
});

test("enqueueOutbound on an unknown/detached attachment returns false without throwing", () => {
  const registry = new TerminalAttachmentRegistry({ maxViewersPerTerminal: 4, attachmentTtlMs: 45_000 });
  expect(registry.enqueueOutbound("never-existed", new Uint8Array(1))).toBe(false);

  const a = registry.attach({ viewerId: "viewer-a", terminalId: "term-1", generation: "gen-1" });
  registry.detach(a.attachmentId);
  expect(registry.enqueueOutbound(a.attachmentId, new Uint8Array(1))).toBe(false);
});

test("releaseOutbound frees pending bytes so healthy streams do not trip lifetime caps", () => {
  const registry = new TerminalAttachmentRegistry({
    maxViewersPerTerminal: 4,
    attachmentTtlMs: 45_000,
    maxQueueBytes: 100,
  });
  const a = registry.attach({ viewerId: "viewer-a", terminalId: "term-1", generation: "gen-1" });
  expect(registry.enqueueOutbound(a.attachmentId, new Uint8Array(80))).toBe(true);
  registry.releaseOutbound(a.attachmentId, 80);
  expect(registry.getOutboundQueueBytes(a.attachmentId)).toBe(0);
  expect(registry.enqueueOutbound(a.attachmentId, new Uint8Array(80))).toBe(true);
});
