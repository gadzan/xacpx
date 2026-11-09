import { expect, test } from "bun:test";

import { RELAY_CAPABILITIES } from "../../../../packages/relay-protocol/src/index";
import { RelayChannel, supportsHandoffMemorySummary } from "../../../../packages/channel-relay/src/channel";
import type { RelayCredential } from "../../../../packages/channel-relay/src/credential-store";

/**
 * `groups.handoff-memory-summary.v1` tells the web it may offer the Group
 * handoff task-summary opt-in. An older core ignores the field and projects
 * nothing, so the choice must stay hidden there instead of silently doing
 * nothing.
 */

class MemoryCredentialStore {
  constructor(private value: RelayCredential | null = null) {}
  load() { return this.value; }
  save(credential: RelayCredential) { this.value = credential; }
  clear() { this.value = null; }
}

async function advertisedCapabilities(control: Record<string, unknown>): Promise<string[]> {
  const seen = Promise.withResolvers<string[]>();
  const client = { start: () => {}, stop: () => {}, sendEvent: () => {}, isReady: () => true, sendRequest: async () => ({}) };
  const channel = new RelayChannel({ url: "ws://h:1", pairingToken: "t" }, {
    credentialStore: new MemoryCredentialStore(),
    createClient: (opts) => { seen.resolve(opts.capabilities ?? []); return client as never; },
  });
  const controller = new AbortController();
  void channel.start({
    agent: { chat: async () => ({ text: "" }) },
    abortSignal: controller.signal,
    quota: {} as never,
    logger: { info: async () => {}, warn: async () => {}, error: async () => {}, debug: async () => {} },
    control: { events: { subscribe: () => () => {} }, listSessions: () => [], ...control },
    coreVersion: "0.24.10",
  } as never);
  const caps = await seen.promise;
  controller.abort();
  return caps;
}

test("the capability constant has the wire name the web reads", () => {
  expect(RELAY_CAPABILITIES.handoffMemorySummaryV1).toBe("groups.handoff-memory-summary.v1");
});

test("a core that accepts the opt-in gets the capability advertised at registration", async () => {
  const caps = await advertisedCapabilities({ supportsHandoffMemorySummary: () => true });
  expect(caps).toContain(RELAY_CAPABILITIES.handoffMemorySummaryV1);
});

test("an older core without the probe does not get the capability", async () => {
  const caps = await advertisedCapabilities({});
  expect(caps).not.toContain(RELAY_CAPABILITIES.handoffMemorySummaryV1);
  expect(caps).toContain(RELAY_CAPABILITIES.interactionElicitationFormV1);
});

test("the probe must be a function returning exactly true", () => {
  expect(supportsHandoffMemorySummary(null)).toBe(false);
  expect(supportsHandoffMemorySummary({})).toBe(false);
  expect(supportsHandoffMemorySummary({ supportsHandoffMemorySummary: true })).toBe(false);
  expect(supportsHandoffMemorySummary({ supportsHandoffMemorySummary: () => "yes" })).toBe(false);
  expect(supportsHandoffMemorySummary({ supportsHandoffMemorySummary: () => true })).toBe(true);
});
