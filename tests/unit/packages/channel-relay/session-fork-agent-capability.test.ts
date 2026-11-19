import { expect, test } from "bun:test";

import {
  MSG,
  RELAY_CAPABILITIES,
  RELAY_PROTOCOL_VERSION,
  parseControlPayload,
  type RelayEnvelope,
} from "../../../../packages/relay-protocol/src/index";
import { RelayChannel, supportsSessionForkAgent } from "../../../../packages/channel-relay/src/channel";
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
      supportsSessionForkAgent: () => true,
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

/** A connector build that predates `targetAgent` refuses the shape. */
const legacyParse: typeof parseControlPayload = (message, payload) =>
  message === MSG.sessionsFork
  && typeof payload === "object"
  && payload !== null
  && "targetAgent" in payload
    ? null
    : parseControlPayload(message, payload);

const controlWithProbe = {
  supportsSessionForkHandoff: () => true,
  forkSession: async () => ({}),
  supportsSessionForkAgent: () => true,
};

test("the capability constant has the wire name the web reads", () => {
  expect(RELAY_CAPABILITIES.sessionForkAgentV1).toBe("session.fork.agent.v1");
});

test("the payload validator accepts targetAgent and keeps the plain fork valid", () => {
  const base = { chatKey: "relay:a", sourceAlias: "backend", targetAlias: "backend-fork", requestId: "r" };
  expect(parseControlPayload(MSG.sessionsFork, { ...base, targetAgent: "claude" })).not.toBeNull();
  expect(parseControlPayload(MSG.sessionsFork, base)).not.toBeNull();
  expect(parseControlPayload(MSG.sessionsFork, {
    ...base,
    sourcePoint: { type: "node", nodeId: "n1" },
    targetAgent: "claude",
  })).not.toBeNull();
  expect(parseControlPayload(MSG.sessionsFork, { ...base, targetAgent: 7 })).toBeNull();
  expect(parseControlPayload(MSG.sessionsFork, { ...base, targetAgent: null })).toBeNull();
});

test("both fork capabilities are advertised when core and connector accept the agent field", async () => {
  const caps = await advertisedCapabilities({});
  expect(caps).toContain(RELAY_CAPABILITIES.sessionForkHandoffV1);
  expect(caps).toContain(RELAY_CAPABILITIES.sessionForkAgentV1);
});

test("a core without the agent probe keeps the head capability and hides the switch", async () => {
  const caps = await advertisedCapabilities({ supportsSessionForkAgent: undefined });
  expect(caps).toContain(RELAY_CAPABILITIES.sessionForkHandoffV1);
  expect(caps).not.toContain(RELAY_CAPABILITIES.sessionForkAgentV1);
});

test("a false or non-callable agent probe keeps the switch capability off", () => {
  expect(supportsSessionForkAgent({ ...controlWithProbe, supportsSessionForkAgent: () => false })).toBe(false);
  expect(supportsSessionForkAgent({ ...controlWithProbe, supportsSessionForkAgent: true })).toBe(false);
  expect(supportsSessionForkAgent({ ...controlWithProbe, supportsSessionForkAgent: () => "yes" })).toBe(false);
  expect(supportsSessionForkAgent({ ...controlWithProbe, supportsSessionForkAgent: () => true })).toBe(true);
});

test("the switch capability requires the base fork probe and RPC", () => {
  expect(supportsSessionForkAgent({ supportsSessionForkAgent: () => true })).toBe(false);
  const { forkSession: _omitted, ...withoutFork } = controlWithProbe;
  expect(supportsSessionForkAgent(withoutFork)).toBe(false);
});

test("an older connector validator hides the switch capability while the head stays", () => {
  expect(supportsSessionForkAgent(controlWithProbe, legacyParse)).toBe(false);
  expect(supportsSessionForkAgent(controlWithProbe)).toBe(true);
});

test("the control bridge forwards targetAgent to forkSession", async () => {
  const calls: unknown[] = [];
  const control = {
    events: { subscribe: () => () => {} },
    listSessions: () => [],
    supportsSessionForkHandoff: () => true,
    supportsSessionForkAgent: () => true,
    forkSession: async (input: unknown) => {
      calls.push(input);
      return { alias: "backend-claude-fork" };
    },
  };
  const bridge = createControlBridge(control as never);
  const result = await dispatch(bridge, req(MSG.sessionsFork, {
    chatKey: "relay:a",
    sourceAlias: "backend",
    targetAlias: "backend-claude-fork",
    requestId: "r-1",
    targetAgent: "claude",
  }));
  expect(result).toEqual({ alias: "backend-claude-fork" });
  expect(calls[0]).toMatchObject({ targetAgent: "claude" });
});
