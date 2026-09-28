/**
 * Registry-level live-capability semantics.
 *
 * The daemon reads form-Elicitation capability ONCE, before channels exist, and
 * `startAll()` tolerates partial failure. These tests prove the answer still
 * becomes false when the only form-capable channel fails to start, and stays
 * true when a healthy one backs it.
 */

import { describe, expect, test } from "bun:test";
import { MessageChannelRegistry } from "../../../src/channels/channel-registry";
import type {
  ChannelStartInput,
  MessageChannelRuntime,
} from "../../../src/channels/types.js";

function formChannel(id: string, fails = false): MessageChannelRuntime {
  return {
    id,
    elicitationModes: ["form"] as const,
    requestElicitation: () => Promise.resolve({ action: "decline" as const, responderId: "u" }),
    async start(): Promise<void> {
      if (fails) throw new Error("card host bind failed: EADDRINUSE");
    },
    async stop(): Promise<void> {},
    logout(): void {},
  } as unknown as MessageChannelRuntime;
}

function plainChannel(id: string): MessageChannelRuntime {
  return {
    id,
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    logout(): void {},
  } as unknown as MessageChannelRuntime;
}

function startInput(): ChannelStartInput {
  return {
    logger: {
      info: async () => {},
      warn: async () => {},
      error: async () => {},
      debug: async () => {},
    } as never,
    abortSignal: new AbortController().signal,
  } as never;
}

describe("live form capability", () => {
  test("a healthy form channel makes the capability true", async () => {
    const registry = new MessageChannelRegistry([formChannel("discord"), plainChannel("weixin")]);
    // Before start: the declaration already says form, and it stays true after.
    expect(registry.hasElicitationFormCapability()).toBe(true);
    await registry.startAll(startInput());
    expect(registry.hasElicitationFormCapability()).toBe(true);
    expect(registry.failedStartupChannelIds()).toEqual([]);
    expect(registry.formElicitationChannelIds()).toEqual(["discord"]);
  });

  test("a form channel that fails to start makes the capability false", async () => {
    const registry = new MessageChannelRegistry([formChannel("feishu", true), plainChannel("weixin")]);
    // Before start: the declaration is all we know, and it says form.
    expect(registry.hasElicitationFormCapability()).toBe(true);
    await registry.startAll(startInput());
    // After start: the channel cannot deliver a form, so the capability is false.
    expect(registry.hasElicitationFormCapability()).toBe(false);
    expect(registry.failedStartupChannelIds()).toEqual(["feishu"]);
    expect(registry.formElicitationChannelIds()).toEqual([]);
    expect(registry.supportedElicitationModes()).toEqual([]);
  });
  test("one healthy form channel keeps the capability true alongside a failed one", async () => {
    const registry = new MessageChannelRegistry([formChannel("discord"), formChannel("feishu", true)]);
    await registry.startAll(startInput());
    expect(registry.failedStartupChannelIds()).toEqual(["feishu"]);
    // Degraded, not lost: forms are still deliverable through Discord.
    expect(registry.hasElicitationFormCapability()).toBe(true);
    expect(registry.formElicitationChannelIds()).toEqual(["discord"]);
  });

  test("a successful restart clears the failed set", async () => {
    let attempt = 0;
    const flaky: MessageChannelRuntime = {
      id: "feishu",
      elicitationModes: ["form"] as const,
      requestElicitation: () => Promise.resolve({ action: "decline" as const, responderId: "u" }),
      async start(): Promise<void> {
        attempt += 1;
        if (attempt === 1) throw new Error("EADDRINUSE");
      },
    } as unknown as MessageChannelRuntime;
    const registry = new MessageChannelRegistry([flaky, plainChannel("weixin")]);
    await registry.startAll(startInput());
    expect(registry.hasElicitationFormCapability()).toBe(false);
    await registry.startAll(startInput());
    expect(registry.hasElicitationFormCapability()).toBe(true);
    expect(registry.failedStartupChannelIds()).toEqual([]);
  });

  test("a channel implementing the method without declaring a mode is not support", async () => {
    const undeclared: MessageChannelRuntime = {
      id: "ghost",
      requestElicitation: () => Promise.resolve({ action: "decline" as const, responderId: "u" }),
      async start(): Promise<void> {},
    } as unknown as MessageChannelRuntime;
    const registry = new MessageChannelRegistry([undeclared]);
    await registry.startAll(startInput());
    expect(registry.hasElicitationFormCapability()).toBe(false);
    expect(registry.formElicitationChannelIds()).toEqual([]);
  });

  test("all channels failing still throws, and the capability is false", async () => {
    const registry = new MessageChannelRegistry([formChannel("discord", true)]);
    await expect(registry.startAll(startInput())).rejects.toThrow(/all channels failed/);
    expect(registry.hasElicitationFormCapability()).toBe(false);
  });
});

// --- Readiness is published per channel, not after allSettled ---------------
//
// startAll() is NOT a readiness barrier: a healthy channel's start() can stay
// pending for the daemon's whole lifetime. A capability failure that only
// surfaced after allSettled would therefore never surface at all.

test("readiness fires the moment the failing channel's start returns", async () => {
  // A healthy form channel whose start() never settles, plus a form channel that
  // fails immediately. `startAll()` stays pending on the healthy one, so the
  // ONLY observable signal is the listener — anything computed after
  // `allSettled` would never run at all.
  const events: Array<{ formCapable: boolean; failed: string[]; live: string[] }> = [];
  const registry = new MessageChannelRegistry([formChannel("feishu", true), longRunningFormChannel("healthy")]);
  registry.setElicitationReadinessListener((readiness) => {
    events.push({
      formCapable: readiness.formCapable,
      failed: readiness.failedChannelIds,
      live: readiness.formChannelIds,
    });
  });
  // Deliberately not awaited: with the long-running channel it never settles.
  void registry.startAll(startInput());
  // Yield the event loop: the failing channel's `finally` logs (an await)
  // before it publishes readiness.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(events.length).toBeGreaterThan(0);
  const last = events[events.length - 1]!;
  // The failure is named, and it happened BEFORE allSettled resolved.
  expect(last.failed).toEqual(["feishu"]);
  // Degraded rather than lost: the healthy channel still delivers forms, which
  // is why the caller must distinguish the two rather than treating any failure
  // as a dead capability.
  expect(last.formCapable).toBe(true);
  expect(last.live).toEqual(["healthy"]);
  expect(registry.declaredElicitationFormChannelIds()).toEqual(["feishu", "healthy"]);
  expect(registry.formElicitationChannelIds()).toEqual(["healthy"]);
  void registry.stopAll();
});

test("a capability that is fully lost is reported as such, immediately", async () => {
  // The case the daemon must refuse on: every declared form channel failed, so
  // the bridge's `form=true` describes nothing.
  const events: Array<{ formCapable: boolean; failed: string[]; live: string[] }> = [];
  const registry = new MessageChannelRegistry([formChannel("feishu", true), plainChannel("weixin")]);
  registry.setElicitationReadinessListener((readiness) => {
    events.push({
      formCapable: readiness.formCapable,
      failed: readiness.failedChannelIds,
      live: readiness.formChannelIds,
    });
  });
  void registry.startAll(startInput());
  await new Promise((resolve) => setTimeout(resolve, 50));
  const last = events[events.length - 1]!;
  expect(last.formCapable).toBe(false);
  expect(last.live).toEqual([]);
  expect(last.failed).toEqual(["feishu"]);
  expect(registry.hasElicitationFormCapability()).toBe(false);
  void registry.stopAll();
});

/** A channel whose start() stays pending — the normal daemon state. */
function longRunningFormChannel(id: string): MessageChannelRuntime {
  return {
    id,
    elicitationModes: ["form"] as const,
    requestElicitation: () => Promise.resolve({ action: "decline" as const, responderId: "u" }),
    start: (): Promise<void> => new Promise<void>(() => {}),
    async stop(): Promise<void> {},
  } as unknown as MessageChannelRuntime;
}
