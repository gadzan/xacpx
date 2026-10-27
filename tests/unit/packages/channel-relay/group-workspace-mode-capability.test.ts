import { expect, test } from "bun:test";

import { RELAY_CAPABILITIES } from "../../../../packages/relay-protocol/src/index";
import { RelayChannel, supportsGroupWorkspaceMode } from "../../../../packages/channel-relay/src/channel";
import type { RelayCredential } from "../../../../packages/channel-relay/src/credential-store";

/**
 * `groups.workspace-mode.v1` tells the web it may offer a creation-time Group
 * workspace mode. An older core drops the field and builds a `shared` Group,
 * so the choice must stay hidden there instead of silently downgrading.
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
  expect(RELAY_CAPABILITIES.groupWorkspaceModeV1).toBe("groups.workspace-mode.v1");
});

test("a core that accepts a Group workspace mode gets the capability advertised at registration", async () => {
  const caps = await advertisedCapabilities({ supportsGroupWorkspaceMode: () => true });
  expect(caps).toContain(RELAY_CAPABILITIES.groupWorkspaceModeV1);
});

test("an older core without the probe does not get the capability", async () => {
  const caps = await advertisedCapabilities({});
  expect(caps).not.toContain(RELAY_CAPABILITIES.groupWorkspaceModeV1);
  // The rest of the snapshot is unaffected.
  expect(caps).toContain(RELAY_CAPABILITIES.interactionElicitationFormV1);
});

test("the probe must be a function returning exactly true", () => {
  expect(supportsGroupWorkspaceMode(null)).toBe(false);
  expect(supportsGroupWorkspaceMode({})).toBe(false);
  expect(supportsGroupWorkspaceMode({ supportsGroupWorkspaceMode: true })).toBe(false);
  expect(supportsGroupWorkspaceMode({ supportsGroupWorkspaceMode: () => "yes" })).toBe(false);
  expect(supportsGroupWorkspaceMode({ supportsGroupWorkspaceMode: () => true })).toBe(true);
});
