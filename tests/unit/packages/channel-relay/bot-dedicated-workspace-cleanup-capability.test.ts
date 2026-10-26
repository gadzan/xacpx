import { expect, test } from "bun:test";

import { RELAY_CAPABILITIES } from "../../../../packages/relay-protocol/src/index";
import { RelayChannel, supportsBotDedicatedWorkspaceCleanup } from "../../../../packages/channel-relay/src/channel";
import type { RelayCredential } from "../../../../packages/channel-relay/src/credential-store";

/**
 * `bots.dedicated-workspace-cleanup.v1` tells the web it may ask a removal to
 * delete the Bot's dedicated workspace folder. Only a core that performs the
 * cleanup may advertise it: an older core ignores the flag, so the web must
 * not offer the option there.
 */

class MemoryCredentialStore {
  constructor(private value: RelayCredential | null = null) {}
  load() { return this.value; }
  save(credential: RelayCredential) { this.value = credential; }
  clear() { this.value = null; }
}
/**
 * The registration payload is the awaited condition, not a guessed delay:
 * the connector hands the assembled capability list to `createClient`, and
 * that call is the only moment the list exists.
 */
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

test("the capability constant has the wire name the web reads", () => {
  expect(RELAY_CAPABILITIES.botsDedicatedWorkspaceCleanupV1).toBe("bots.dedicated-workspace-cleanup.v1");
});

test("a core that cleans up dedicated Bot workspaces gets the capability advertised at registration", async () => {
  const caps = await advertisedCapabilities({ supportsBotDedicatedWorkspaceCleanup: () => true });
  expect(caps).toContain(RELAY_CAPABILITIES.botsDedicatedWorkspaceCleanupV1);
});

test("an older core without the probe does not get the capability", async () => {
  const caps = await advertisedCapabilities({});
  expect(caps).not.toContain(RELAY_CAPABILITIES.botsDedicatedWorkspaceCleanupV1);
  // The rest of the snapshot is unaffected.
  expect(caps).toContain(RELAY_CAPABILITIES.interactionElicitationFormV1);
});

test("the probe must be a function returning exactly true", () => {
  expect(supportsBotDedicatedWorkspaceCleanup(null)).toBe(false);
  expect(supportsBotDedicatedWorkspaceCleanup({})).toBe(false);
  expect(supportsBotDedicatedWorkspaceCleanup({ supportsBotDedicatedWorkspaceCleanup: true })).toBe(false);
  expect(supportsBotDedicatedWorkspaceCleanup({ supportsBotDedicatedWorkspaceCleanup: () => "yes" })).toBe(false);
  expect(supportsBotDedicatedWorkspaceCleanup({ supportsBotDedicatedWorkspaceCleanup: () => true })).toBe(true);
});
