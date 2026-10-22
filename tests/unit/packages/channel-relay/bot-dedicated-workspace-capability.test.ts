import { expect, test } from "bun:test";

import { RELAY_CAPABILITIES } from "../../../../packages/relay-protocol/src/index";
import { RelayChannel, supportsBotDedicatedWorkspace } from "../../../../packages/channel-relay/src/channel";
import type { RelayCredential } from "../../../../packages/channel-relay/src/credential-store";

/**
 * `bots.dedicated-workspace.v1` tells the web it may create a Bot without a
 * `workspace`. Only a core that allocates a dedicated workspace may advertise
 * it: an older core rejects the omission, so the web must keep sending one.
 */

class MemoryCredentialStore {
  constructor(private value: RelayCredential | null = null) {}
  load() { return this.value; }
  save(credential: RelayCredential) { this.value = credential; }
  clear() { this.value = null; }
}

async function advertisedCapabilities(control: Record<string, unknown>): Promise<string[]> {
  const seen: Array<{ capabilities?: string[] }> = [];
  const client = { start: () => {}, stop: () => {}, sendEvent: () => {}, isReady: () => true, sendRequest: async () => ({}) };
  const channel = new RelayChannel({ url: "ws://h:1", pairingToken: "t" }, {
    credentialStore: new MemoryCredentialStore(),
    createClient: (opts) => { seen.push(opts); return client as never; },
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
  const deadline = Date.now() + 2_000;
  while (seen.length === 0) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for channel start");
    await Bun.sleep(5);
  }
  controller.abort();
  return seen[0]?.capabilities ?? [];
}

test("the capability constant has the wire name the web reads", () => {
  expect(RELAY_CAPABILITIES.botsDedicatedWorkspaceV1).toBe("bots.dedicated-workspace.v1");
});

test("a core that supports dedicated Bot workspaces gets the capability advertised at registration", async () => {
  const caps = await advertisedCapabilities({ supportsBotDedicatedWorkspace: () => true });
  expect(caps).toContain(RELAY_CAPABILITIES.botsDedicatedWorkspaceV1);
});

test("an older core without the probe does not get the capability", async () => {
  const caps = await advertisedCapabilities({});
  expect(caps).not.toContain(RELAY_CAPABILITIES.botsDedicatedWorkspaceV1);
  // The rest of the snapshot is unaffected.
  expect(caps).toContain(RELAY_CAPABILITIES.interactionElicitationFormV1);
});

test("the probe must be a function returning exactly true", () => {
  expect(supportsBotDedicatedWorkspace(null)).toBe(false);
  expect(supportsBotDedicatedWorkspace({})).toBe(false);
  expect(supportsBotDedicatedWorkspace({ supportsBotDedicatedWorkspace: true })).toBe(false);
  expect(supportsBotDedicatedWorkspace({ supportsBotDedicatedWorkspace: () => "yes" })).toBe(false);
  expect(supportsBotDedicatedWorkspace({ supportsBotDedicatedWorkspace: () => true })).toBe(true);
});
