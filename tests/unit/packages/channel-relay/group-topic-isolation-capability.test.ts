import { expect, test } from "bun:test";

import { RELAY_CAPABILITIES } from "../../../../packages/relay-protocol/src/index";
import {
  RelayChannel,
  supportsDirectTopicFork,
  supportsGroupTopicFork,
  supportsGroupTopicIsolation,
} from "../../../../packages/channel-relay/src/channel";
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

test("the fork capability is advertised only when core and validator agree", async () => {
  expect(RELAY_CAPABILITIES.groupTopicForkV1).toBe("group.topics.fork.v1");
  expect(supportsGroupTopicFork({
    supportsGroupTopicFork: () => true,
    forkGroupTopic: async () => ({}),
  })).toBe(true);
  expect(supportsGroupTopicFork({ forkGroupTopic: async () => ({}) })).toBe(false);
  expect(supportsGroupTopicFork({ supportsGroupTopicFork: () => true })).toBe(false);
  expect(supportsGroupTopicFork({ supportsGroupTopicFork: () => false, forkGroupTopic: async () => ({}) })).toBe(false);

  const caps = await advertisedCapabilities({
    supportsGroupTopicFork: () => true,
    forkGroupTopic: async () => ({}),
  });
  expect(caps).toContain(RELAY_CAPABILITIES.groupTopicForkV1);
  expect(await advertisedCapabilities({})).not.toContain(RELAY_CAPABILITIES.groupTopicForkV1);
});

test("the Direct fork capability is advertised only when core and validator agree", async () => {
  expect(RELAY_CAPABILITIES.directTopicForkV1).toBe("direct.topics.fork.v1");
  expect(supportsDirectTopicFork({
    supportsDirectTopicFork: () => true,
    forkDirectTopic: async () => ({}),
  })).toBe(true);
  // Either half missing keeps the entry hidden: a core without the RPC or a
  // connector whose validator rejects the payload would answer an unactionable
  // `unsupported-rpc` / `invalid-payload`.
  expect(supportsDirectTopicFork({ forkDirectTopic: async () => ({}) })).toBe(false);
  expect(supportsDirectTopicFork({ supportsDirectTopicFork: () => true })).toBe(false);
  expect(supportsDirectTopicFork({ supportsDirectTopicFork: () => false, forkDirectTopic: async () => ({}) })).toBe(false);
  expect(supportsDirectTopicFork(null)).toBe(false);

  const caps = await advertisedCapabilities({
    supportsDirectTopicFork: () => true,
    forkDirectTopic: async () => ({}),
  });
  expect(caps).toContain(RELAY_CAPABILITIES.directTopicForkV1);
  expect(await advertisedCapabilities({})).not.toContain(RELAY_CAPABILITIES.directTopicForkV1);
  // A Group-only fork core must not advertise the Direct capability.
  const groupOnly = await advertisedCapabilities({
    supportsGroupTopicFork: () => true,
    forkGroupTopic: async () => ({}),
  });
  expect(groupOnly).not.toContain(RELAY_CAPABILITIES.directTopicForkV1);
});
