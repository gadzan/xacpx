import { expect, test } from "bun:test";

import { RELAY_CAPABILITIES } from "../../../../packages/relay-protocol/src/index";
import { RelayChannel, supportsGroupTopicIsolation } from "../../../../packages/channel-relay/src/channel";
import type { RelayCredential } from "../../../../packages/channel-relay/src/credential-store";

/**
 * `group.topics.isolation.v1` tells the web it may offer the Group Topic
 * isolation switch. A core without `control.group.topics.set-isolation` answers
 * `unknown-type`, which a user cannot act on, so the web must not offer it there.
 */

class MemoryCredentialStore {
  constructor(private value: RelayCredential | null = null) {}
  load() { return this.value; }
  save(credential: RelayCredential) { this.value = credential; }
  clear() { this.value = null; }
}
async function advertisedCapabilities(control: Record<string, unknown>): Promise<string[]> {
  const { promise: registration, resolve: registered } = Promise.withResolvers<string[]>();
  const client = { start: () => {}, stop: () => {}, sendEvent: () => {}, isReady: () => true, sendRequest: async () => ({}) };
  const channel = new RelayChannel({ url: "ws://h:1", pairingToken: "t" }, {
    credentialStore: new MemoryCredentialStore(),
    createClient: (opts) => { registered(opts.capabilities ?? []); return client as never; },
  });
  const controller = new AbortController();
  const starting = channel.start({
    agent: { chat: async () => ({ text: "" }) },
    abortSignal: controller.signal,
    quota: {} as never,
    logger: { info: async () => {}, warn: async () => {}, error: async () => {}, debug: async () => {} },
    control: { events: { subscribe: () => () => {} }, listSessions: () => [], ...control },
    coreVersion: "0.24.10",
  } as never);
  try {
    return await Promise.race([
      registration,
      starting.then(
        () => { throw new Error("channel stopped before registration"); },
        (error: unknown) => { throw error; },
      ),
    ]);
  } finally {
    controller.abort();
    await starting.catch(() => {});
  }
}

test("the capability constant has the wire name the web reads", () => {
  expect(RELAY_CAPABILITIES.groupTopicIsolationV1).toBe("group.topics.isolation.v1");
});

test("a core that implements set-isolation gets the capability advertised at registration", async () => {
  const caps = await advertisedCapabilities({ setGroupTopicIsolation: async () => ({}) });
  expect(caps).toContain(RELAY_CAPABILITIES.groupTopicIsolationV1);
});

test("an older core without the method does not get the capability", async () => {
  const caps = await advertisedCapabilities({});
  expect(caps).not.toContain(RELAY_CAPABILITIES.groupTopicIsolationV1);
  expect(caps).toContain(RELAY_CAPABILITIES.interactionElicitationFormV1);
});

test("the probe requires a callable method, not a truthy field", () => {
  expect(supportsGroupTopicIsolation(null)).toBe(false);
  expect(supportsGroupTopicIsolation({})).toBe(false);
  expect(supportsGroupTopicIsolation({ setGroupTopicIsolation: true })).toBe(false);
  expect(supportsGroupTopicIsolation({ setGroupTopicIsolation: async () => ({}) })).toBe(true);
});
