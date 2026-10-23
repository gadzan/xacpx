import { expect, test } from "bun:test";

import { RELAY_CAPABILITIES } from "../../../../packages/relay-protocol/src/index";
import { RelayChannel, supportsRunsCancelMember } from "../../../../packages/channel-relay/src/channel";
import type { RelayCredential } from "../../../../packages/channel-relay/src/credential-store";

/**
 * `runs.cancel-member.v1` tells the web this instance can cancel ONE member
 * turn of a Run without stopping the whole Run. Only a core that exposes
 * `cancelMemberTurn` may advertise it: an older core has no such method, so
 * the web must not offer the scoped action there.
 */

class MemoryCredentialStore {
  constructor(private value: RelayCredential | null = null) {}
  load() { return this.value; }
  save(credential: RelayCredential) { this.value = credential; }
  clear() { this.value = null; }
}

/**
 * The registration payload is the awaited condition, not a guessed delay: the
 * connector hands the assembled capability list to `createClient`, and that
 * call is the only moment the list exists.
 */
async function advertisedCapabilities(control: Record<string, unknown>): Promise<string[]> {
  let registered!: (capabilities: string[]) => void;
  const registration = new Promise<string[]>((resolve) => { registered = resolve; });
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
      // A start that ends without registering is a failure with its own cause,
      // not a hang: surface it instead of waiting out the test timeout.
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

test("scoped member cancellation advertises the agreed capability when supported", async () => {
  expect(RELAY_CAPABILITIES.runsCancelMemberV1).toBe("runs.cancel-member.v1");
  const caps = await advertisedCapabilities({ cancelMemberTurn: async () => ({}) });
  expect(caps).toContain(RELAY_CAPABILITIES.runsCancelMemberV1);
});

test("older cores omit scoped member cancellation while preserving other capabilities", async () => {
  const caps = await advertisedCapabilities({});
  expect(caps).not.toContain(RELAY_CAPABILITIES.runsCancelMemberV1);
  expect(caps).toContain(RELAY_CAPABILITIES.interactionElicitationFormV1);
});

test("scoped member cancellation requires a method without invoking it during probing", () => {
  expect(supportsRunsCancelMember(null)).toBe(false);
  expect(supportsRunsCancelMember({})).toBe(false);
  for (const cancelMemberTurn of [null, {}, true, "yes"]) {
    expect(supportsRunsCancelMember({ cancelMemberTurn })).toBe(false);
  }
  expect(supportsRunsCancelMember({ cancelMemberTurn: () => { throw new Error("must not execute"); } })).toBe(true);
});
