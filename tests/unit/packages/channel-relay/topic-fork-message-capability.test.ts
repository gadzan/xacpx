import { expect, test } from "bun:test";

import {
  RELAY_CAPABILITIES,
  parseControlPayload,
  MSG,
} from "../../../../packages/relay-protocol/src/index";
import {
  RelayChannel,
  supportsDirectTopicFork,
  supportsDirectTopicForkMessage,
  supportsGroupTopicFork,
  supportsGroupTopicForkMessage,
} from "../../../../packages/channel-relay/src/channel";
import type { RelayCredential } from "../../../../packages/channel-relay/src/credential-store";

/**
 * The per-row message entry is a separate capability from the base fork: a new
 * web against an old connector or core would advertise `group.topics.fork.v1`
 * and then fail the row's message payload with `invalid-payload`. The message
 * capability therefore requires the core's message probe AND a validator that
 * accepts the message shape.
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

function newStack(): Record<string, unknown> {
  return {
    supportsGroupTopicFork: () => true,
    supportsGroupTopicForkMessage: () => true,
    forkGroupTopic: async () => ({}),
    supportsDirectTopicFork: () => true,
    supportsDirectTopicForkMessage: () => true,
    forkDirectTopic: async () => ({}),
  };
}

test("the message capability constants have the wire names the web reads", () => {
  expect(RELAY_CAPABILITIES.groupTopicForkMessageV1).toBe("group.topics.fork.message.v1");
  expect(RELAY_CAPABILITIES.directTopicForkMessageV1).toBe("direct.topics.fork.message.v1");
});

test("the message capability is advertised only when the message probe and validator agree", async () => {
  expect(supportsGroupTopicForkMessage(newStack())).toBe(true);
  // A core without the message probe keeps the base capability but not the
  // message one: the older fork entries keep working, the row entry hides.
  const noProbe = { ...newStack() };
  delete noProbe.supportsGroupTopicForkMessage;
  delete noProbe.supportsDirectTopicForkMessage;
  expect(supportsGroupTopicFork(noProbe)).toBe(true);
  expect(supportsGroupTopicForkMessage(noProbe)).toBe(false);
  expect(supportsDirectTopicFork(noProbe)).toBe(true);
  expect(supportsDirectTopicForkMessage(noProbe)).toBe(false);
  // A probe that returns false keeps the capability off.
  expect(supportsGroupTopicForkMessage({
    ...newStack(),
    supportsGroupTopicForkMessage: () => false,
  })).toBe(false);
  // An old connector whose validator rejects the message shape keeps the
  // capability off even when the core knows the branch.
  expect(supportsGroupTopicForkMessage({
    ...newStack(),
    forkGroupTopic: undefined,
  })).toBe(false);
  const caps = await advertisedCapabilities(newStack());
  expect(caps).toContain(RELAY_CAPABILITIES.groupTopicForkV1);
  expect(caps).toContain(RELAY_CAPABILITIES.groupTopicForkMessageV1);
  expect(caps).toContain(RELAY_CAPABILITIES.directTopicForkV1);
  expect(caps).toContain(RELAY_CAPABILITIES.directTopicForkMessageV1);
  const old = await advertisedCapabilities(noProbe);
  expect(old).toContain(RELAY_CAPABILITIES.groupTopicForkV1);
  expect(old).not.toContain(RELAY_CAPABILITIES.groupTopicForkMessageV1);
  expect(old).toContain(RELAY_CAPABILITIES.directTopicForkV1);
  expect(old).not.toContain(RELAY_CAPABILITIES.directTopicForkMessageV1);
});

test("the message probe payload passes the new validator shape", () => {
  expect(parseControlPayload(MSG.groupTopicsFork, {
    conversationId: "probe",
    sourceTopicId: "probe",
    targetTopicId: "probe",
    requestId: "probe",
    sourcePoint: { type: "message", messageId: "probe" },
  })).not.toBeNull();
  expect(parseControlPayload(MSG.directTopicsFork, {
    conversationId: "probe",
    sourceTopicId: "probe",
    targetTopicId: "probe",
    requestId: "probe",
    sourcePoint: { type: "message", messageId: "probe" },
  })).not.toBeNull();
});
