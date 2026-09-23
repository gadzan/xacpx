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
  } as unknown as MessageChannelRuntime;
}

function plainChannel(id: string): MessageChannelRuntime {
  return {
    id,
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
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
