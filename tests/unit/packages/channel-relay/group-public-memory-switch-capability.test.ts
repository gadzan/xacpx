import { expect, test } from "bun:test";

import { RELAY_CAPABILITIES } from "../../../../packages/relay-protocol/src/index";
import { RelayChannel, supportsGroupPublicMemorySwitch } from "../../../../packages/channel-relay/src/channel";
import type { RelayCredential } from "../../../../packages/channel-relay/src/credential-store";

/**
 * `groups.public-memory-switch.v1` tells the web it may offer a Group's
 * public-memory projection choice. An older core drops the field and keeps
 * projecting, so the switch must stay hidden there instead of silently
 * storing nowhere.
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
  // Registration is the signal: no polling, and a missing one fails the test
  // through its own timeout instead of a guessed sleep.
  const caps = await seen.promise;
  controller.abort();
  return caps;
}

test("the capability constant has the wire name the web reads", () => {
  expect(RELAY_CAPABILITIES.groupPublicMemorySwitchV1).toBe("groups.public-memory-switch.v1");
});

test("a core that stores the Group projection gets the capability advertised at registration", async () => {
  const caps = await advertisedCapabilities({ supportsGroupPublicMemorySwitch: () => true });
  expect(caps).toContain(RELAY_CAPABILITIES.groupPublicMemorySwitchV1);
});

test("an older core without the probe does not get the capability", async () => {
  const caps = await advertisedCapabilities({});
  expect(caps).not.toContain(RELAY_CAPABILITIES.groupPublicMemorySwitchV1);
  // The rest of the snapshot is unaffected.
  expect(caps).toContain(RELAY_CAPABILITIES.interactionElicitationFormV1);
});

test("the probe must be a function returning exactly true", () => {
  expect(supportsGroupPublicMemorySwitch(null)).toBe(false);
  expect(supportsGroupPublicMemorySwitch({})).toBe(false);
  expect(supportsGroupPublicMemorySwitch({ supportsGroupPublicMemorySwitch: true })).toBe(false);
  expect(supportsGroupPublicMemorySwitch({ supportsGroupPublicMemorySwitch: () => "yes" })).toBe(false);
  expect(supportsGroupPublicMemorySwitch({ supportsGroupPublicMemorySwitch: () => true })).toBe(true);
});
