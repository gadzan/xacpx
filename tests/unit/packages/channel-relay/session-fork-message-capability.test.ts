import { expect, test } from "bun:test";

import {
  MSG,
  RELAY_CAPABILITIES,
  RELAY_PROTOCOL_VERSION,
  parseControlPayload,
  type RelayEnvelope,
} from "../../../../packages/relay-protocol/src/index";
import { RelayChannel, supportsSessionForkMessage } from "../../../../packages/channel-relay/src/channel";
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
    control: {
      events: { subscribe: () => () => {} },
      listSessions: () => [],
      supportsSessionForkHandoff: () => true,
      supportsSessionForkMessage: () => true,
      forkSession: async () => ({}),
      ...control,
    },
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

async function dispatch(bridge: ControlBridge, envelope: RelayEnvelope): Promise<unknown> {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  bridge(envelope, resolve);
  return await promise;
}

/** A connector build that predates the node source point refuses the shape. */
const legacyParse: typeof parseControlPayload = (message, payload) =>
  message === MSG.sessionsFork
  && typeof payload === "object"
  && payload !== null
  && "sourcePoint" in payload
    ? null
    : parseControlPayload(message, payload);

test("the capability constant has the wire name the web reads", () => {
  expect(RELAY_CAPABILITIES.sessionForkMessageV1).toBe("session.fork.message.v1");
});

test("the payload validator accepts a node source point and keeps latest_stable valid", () => {
  const base = { chatKey: "relay:a", sourceAlias: "backend", targetAlias: "backend-fork", requestId: "r" };
  expect(parseControlPayload(MSG.sessionsFork, { ...base, sourcePoint: { type: "node", nodeId: "n1" } })).not.toBeNull();
  expect(parseControlPayload(MSG.sessionsFork, { ...base, sourcePoint: { type: "latest_stable" } })).not.toBeNull();
  expect(parseControlPayload(MSG.sessionsFork, base)).not.toBeNull();
  expect(parseControlPayload(MSG.sessionsFork, { ...base, sourcePoint: { type: "node" } })).toBeNull();
  expect(parseControlPayload(MSG.sessionsFork, { ...base, sourcePoint: { type: "message", messageId: "m" } })).toBeNull();
});

test("both capabilities are advertised when core and connector accept the node payload", async () => {
  const caps = await advertisedCapabilities({});
  expect(caps).toContain(RELAY_CAPABILITIES.sessionForkHandoffV1);
  expect(caps).toContain(RELAY_CAPABILITIES.sessionForkMessageV1);
});

test("a head-only core keeps the head capability and never advertises the node entry", async () => {
  const caps = await advertisedCapabilities({ supportsSessionForkMessage: undefined });
  expect(caps).toContain(RELAY_CAPABILITIES.sessionForkHandoffV1);
  expect(caps).not.toContain(RELAY_CAPABILITIES.sessionForkMessageV1);
});

test("a false or non-callable node probe keeps the node capability off", () => {
  const control = {
    supportsSessionForkHandoff: () => true,
    forkSession: async () => ({}),
    supportsSessionForkMessage: () => false,
  };
  expect(supportsSessionForkMessage(control)).toBe(false);
  expect(supportsSessionForkMessage({ ...control, supportsSessionForkMessage: true })).toBe(false);
  expect(supportsSessionForkMessage({ ...control, supportsSessionForkMessage: () => "yes" })).toBe(false);
  expect(supportsSessionForkMessage({ ...control, supportsSessionForkMessage: () => true })).toBe(true);
});

test("an older connector validator hides the node capability while the head stays", () => {
  const control = {
    supportsSessionForkHandoff: () => true,
    forkSession: async () => ({}),
    supportsSessionForkMessage: () => true,
  };
  expect(supportsSessionForkMessage(control, legacyParse)).toBe(false);
  expect(supportsSessionForkMessage(control)).toBe(true);
});

test("the control bridge forwards the node source point to forkSession", async () => {
  const calls: unknown[] = [];
  const control = {
    events: { subscribe: () => () => {} },
    listSessions: () => [],
    supportsSessionForkHandoff: () => true,
    supportsSessionForkMessage: () => true,
    forkSession: async (input: unknown) => {
      calls.push(input);
      return { alias: "backend-fork" };
    },
  };
  const bridge = createControlBridge(control as never);
  const result = await dispatch(bridge, req(MSG.sessionsFork, {
    chatKey: "relay:a",
    sourceAlias: "backend",
    targetAlias: "backend-fork",
    requestId: "r-1",
    sourcePoint: { type: "node", nodeId: "n1" },
  }));
  expect(result).toEqual({ alias: "backend-fork" });
  expect(calls[0]).toMatchObject({ sourcePoint: { type: "node", nodeId: "n1" } });
});
