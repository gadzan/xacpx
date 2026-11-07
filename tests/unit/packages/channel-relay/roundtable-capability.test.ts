import { expect, test } from "bun:test";

import { RELAY_CAPABILITIES } from "../../../../packages/relay-protocol/src/index";
import { RelayChannel, supportsRoundtableV1 } from "../../../../packages/channel-relay/src/channel";
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

test("the capability constant has the wire name the web reads", () => {
  expect(RELAY_CAPABILITIES.roundtableV1).toBe("conversations.roundtable.v1");
});

test("a core that accepts a roundtable target and returns roundtable history gets the capability", async () => {
  const caps = await advertisedCapabilities({ supportsRoundtableV1: () => true });
  expect(caps).toContain(RELAY_CAPABILITIES.roundtableV1);
});

test("no probe, a non-callable probe, or a false probe never advertises", async () => {
  for (const control of [
    {},
    { supportsRoundtableV1: true },
    { supportsRoundtableV1: () => false },
    { supportsRoundtableV1: () => "yes" },
  ]) {
    const caps = await advertisedCapabilities(control);
    expect(caps).not.toContain(RELAY_CAPABILITIES.roundtableV1);
  }
});

test("the probe itself requires a function returning exactly true", () => {
  expect(supportsRoundtableV1(null)).toBe(false);
  expect(supportsRoundtableV1({})).toBe(false);
  expect(supportsRoundtableV1({ supportsRoundtableV1: true })).toBe(false);
  expect(supportsRoundtableV1({ supportsRoundtableV1: () => false })).toBe(false);
  expect(supportsRoundtableV1({ supportsRoundtableV1: () => "yes" })).toBe(false);
  expect(supportsRoundtableV1({ supportsRoundtableV1: () => true })).toBe(true);
});
