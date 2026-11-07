import { expect, test } from "bun:test";

import {
  MSG,
  RELAY_CAPABILITIES,
  RELAY_PROTOCOL_VERSION,
  parseControlPayload,
  type RelayEnvelope,
} from "../../../../packages/relay-protocol/src/index";
import { RelayChannel, supportsConversationTimeline } from "../../../../packages/channel-relay/src/channel";
import { createControlBridge, type ControlBridge } from "../../../../packages/channel-relay/src/control-bridge";
import type { RelayCredential } from "../../../../packages/channel-relay/src/credential-store";

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

const req = (type: string, payload: unknown): RelayEnvelope => ({
  protocolVersion: RELAY_PROTOCOL_VERSION,
  kind: "req",
  id: "r-1",
  type,
  payload,
});

async function dispatch(
  bridge: ControlBridge,
  envelope: RelayEnvelope,
): Promise<unknown> {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  bridge(envelope, resolve);
  return await promise;
}

/** A connector build that predates the timeline RPC has no validator for it. */
const legacyParse: typeof parseControlPayload = (message, payload) =>
  message === MSG.conversationTimeline ? null : parseControlPayload(message, payload);

test("the capability constant has the wire name the web reads", () => {
  expect(RELAY_CAPABILITIES.conversationTimelineV1).toBe("conversations.timeline.v1");
});

test("a core that serves the timeline gets the capability", async () => {
  const caps = await advertisedCapabilities({ supportsConversationTimelineV1: () => true });
  expect(caps).toContain(RELAY_CAPABILITIES.conversationTimelineV1);
});

test("no probe, a non-callable probe, or a false probe never advertises", async () => {
  for (const control of [
    {},
    { supportsConversationTimelineV1: true },
    { supportsConversationTimelineV1: () => false },
    { supportsConversationTimelineV1: () => "yes" },
  ]) {
    const caps = await advertisedCapabilities(control);
    expect(caps).not.toContain(RELAY_CAPABILITIES.conversationTimelineV1);
  }
});

test("the probe itself requires a function returning exactly true", () => {
  expect(supportsConversationTimeline(null)).toBe(false);
  expect(supportsConversationTimeline({})).toBe(false);
  expect(supportsConversationTimeline({ supportsConversationTimelineV1: true })).toBe(false);
  expect(supportsConversationTimeline({ supportsConversationTimelineV1: () => false })).toBe(false);
  expect(supportsConversationTimeline({ supportsConversationTimelineV1: () => true })).toBe(true);
});

test("a true core probe is not enough when the connector validator is old", () => {
  expect(supportsConversationTimeline({ supportsConversationTimelineV1: () => true }, legacyParse)).toBe(false);
  expect(supportsConversationTimeline({ supportsConversationTimelineV1: () => true })).toBe(true);
});

test("the bridge forwards the timeline RPC and refuses a daemon without it", async () => {
  const seen: unknown[] = [];
  const timeline = {
    conversationId: "conversation_1",
    topicId: "topic_1",
    entries: [],
    hasMoreBefore: false,
    hasMoreAfter: false,
  };
  const bridge = createControlBridge({
    events: { subscribe: () => () => {} },
    conversationTimeline: (input: unknown) => {
      seen.push(input);
      return timeline;
    },
  } as never);
  expect(await dispatch(bridge, req(MSG.conversationTimeline, {
    conversationId: "conversation_1",
    topicId: "topic_1",
    beforeSeq: 40,
    limit: 20,
  }))).toEqual(timeline);
  expect(seen).toEqual([{ conversationId: "conversation_1", topicId: "topic_1", beforeSeq: 40, limit: 20 }]);
  expect(await dispatch(bridge, req(MSG.conversationTimeline, {
    conversationId: "conversation_1",
    topicId: "topic_1",
    direction: "newest-first",
    afterSeq: 1,
  }))).toMatchObject({ error: { code: "invalid-payload" } });

  // An older daemon has no such method: the connector answers unsupported-rpc
  // instead of crashing, which the Web treats as "keep the legacy transcript".
  const legacyBridge = createControlBridge({
    events: { subscribe: () => () => {} },
  } as never);
  expect(await dispatch(legacyBridge, req(MSG.conversationTimeline, {
    conversationId: "conversation_1",
    topicId: "topic_1",
  }))).toMatchObject({ error: { code: "unsupported-rpc" } });
});
