import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MSG } from "../../../../packages/relay-protocol/src/index";
import { createSqlDriver, initSchema } from "../../../../packages/relay/src/db";
import { AccountStore } from "../../../../packages/relay/src/stores/accounts";
import { InstanceStore } from "../../../../packages/relay/src/stores/instances";
import { MessageStore } from "../../../../packages/relay/src/stores/messages";
import { createApp } from "../../../../packages/relay/src/http/app";
import { InteractionRegistry } from "../../../../packages/relay/src/interaction-registry";
import { RelayChannel } from "../../../../packages/channel-relay/src/channel";
import type { ChannelElicitationRequest } from "../../../src/interactions/elicitation-types";
import type { RelayCredential } from "../../../../packages/channel-relay/src/credential-store";

/**
 * The M3 chain, production-shaped, in one test.
 *
 * Every hop is real code; the ONLY thing faked is the WebSocket between the
 * connector and the hub, which is the network edge and nothing else:
 *
 *   core's broker      → RelayChannel.requestElicitation   (real, via a real channel)
 *   connector          → hub HTTP RPC                      (real Hono app, real stores)
 *   hub                → registers + broadcasts            (real InteractionRegistry)
 *   browser            → hub HTTP RPC                      (real authenticated session)
 *   hub                → stamps its identity               (real session account)
 *   connector          → maps the answer                   (real relay-interaction)
 *   the decision       → what core would re-verify         (asserted, not stripped)
 *
 * The two "fakes" worth naming, because they are the ones that would otherwise
 * hide a wiring gap:
 *
 *   - the channel's `createClient` seam returns a client whose `sendRequest`
 *     performs the hub's HTTP call. That is exactly what the real WebSocket
 *     does, so the frame the channel builds is the frame the hub validates.
 *   - the "browser" is a test caller on the hub's authenticated HTTP API, which
 *     is exactly what a browser is in production.
 *
 * There is no injected renderer anywhere. `requestElicitation` is the real
 * method, and it is the only way the form appears.
 */

class MemoryCredentialStore {
  constructor(private value: RelayCredential | null = null) {}
  load() { return this.value; }
  save(credential: RelayCredential) { this.value = credential; }
  clear() { this.value = null; }
}

interface HubHarness {
  channel: RelayChannel;
  agentRequest: ChannelElicitationRequest;
  /** Start the channel and open the interaction; resolves once the hub has it. */
  startAndOpen: () => Promise<boolean>;
  /** The browser's answer, on the answer direction. */
  answer: (payload: unknown) => Promise<void>;
  /** The browser-facing events the hub actually produced. */
  events: Array<{ type: string; chatKey: string; requestId?: string }>;
}

async function makeHub(): Promise<HubHarness> {
  const dir = mkdtempSync(join(tmpdir(), "relay-chain-"));
  const db = await createSqlDriver(join(dir, "hub.db"));
  initSchema(db);
  const accounts = new AccountStore(db);
  const instances = new InstanceStore(db);
  const admin = accounts.createAccount("admin");
  const { token } = accounts.createLoginToken(admin.id, "test");
  const created = instances.registerInstanceForAccount(admin.id, "home-pc");

  const events: Array<{ type: string; chatKey: string; requestId?: string }> = [];
  const interactions = new InteractionRegistry({ debug: () => {} });
  const app = createApp({
    accounts,
    instances,
    messages: new MessageStore(db),
    interactions,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    gateway: {
      isOnline: () => true,
      sendRequest: async () => ({}),
      broadcastControlEvent: (_accountId, event) => {
        events.push({
          type: event.type,
          chatKey: (event as { chatKey?: string }).chatKey ?? "",
          requestId: (event as { requestId?: string }).requestId,
        });
      },
    },
  });

  const loginRes = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const cookie = loginRes.headers.get("set-cookie")?.split(";")[0] ?? "";

  const agentRequest: ChannelElicitationRequest = {
    requestId: "req-chain-1",
    // A Direct Conversation turn — the shape that made this path necessary.
    chatKey: "bot:conv-1:topic-1",
    requester: { senderId: "relay:relay-acct", isOwner: true },
    agent: { name: "codex" },
    message: "Which region should I deploy to?",
    mode: "form",
    fields: [
      { kind: "text", key: "region", title: "Region", required: true },
    ] as ChannelElicitationRequest["fields"],
    expiresAt: Date.now() + 60_000,
    signal: new AbortController().signal,
  } as ChannelElicitationRequest;

  let clientSeen = false;
  const channel = new RelayChannel({ url: "ws://h:1", pairingToken: "t" }, {
    credentialStore: new MemoryCredentialStore(),
    createClient: () => {
      clientSeen = true;
      return {
        start: () => {},
        stop: () => {},
        sendEvent: () => {},
        isReady: () => true,
        sendRequest: async (type: string, payload: unknown) => {
          // The connector's real dial: this client method IS the WebSocket send.
          const res = await app.request(`/api/instances/${created.instanceId}/rpc`, {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({ type, payload }),
          });
          return await res.json();
        },
      } as never;
    },
  });

  /**
   * Start the channel so it can dial the hub.
   *
   * `start()` parks on the channel's lifetime abort signal by design, so
   * awaiting it would hang every test. What matters is that it installed its
   * client — which is the observable the channel needs in order to dial, and the
   * only thing this waits for.
   */
  const startAndOpen = async (): Promise<void> => {
    const controller = new AbortController();
    void channel.start({
      agent: { chat: async () => ({ text: "" }) },
      abortSignal: controller.signal,
      quota: {} as never,
      logger: { info: async () => {}, warn: async () => {}, error: async () => {}, debug: async () => {} },
      control: {
        events: { subscribe: () => () => {} },
        listSessions: () => [],
      },
      coreVersion: "0.11.0",
    } as never);
    await waitFor(() => clientSeen, "channel client");
  };

  /** The browser's answer, on the answer direction. Returns false when the hub
   *  refused it (an identity-asserting frame is rejected, not ignored). */
  const answer = async (payload: unknown): Promise<boolean> => {
    const res = await app.request(`/api/instances/${created.instanceId}/rpc`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ type: MSG.interactionRespond, payload }),
    });
    expect([200, 400, 409]).toContain(res.status);
    return res.status === 200;
  };

  return { channel, agentRequest, startAndOpen, answer, events };
}

test("the full M3 chain: agent form → hub → browser → hub identity → connector → decision", async () => {
  const hub = await makeHub();
  await hub.startAndOpen();

  // 1. Core's broker calls the channel. Nothing is injected; this is the entry.
  const settled = hub.channel.requestElicitation(hub.agentRequest);

  // 2. The hub opened the interaction and told the browsers. Both events are
  //    produced by real hub code, not by a store fixture.
  await waitFor(() => hub.events.some((e) => e.type === "interaction-opened"), "interaction-opened");
  const opened = hub.events.find((e) => e.type === "interaction-opened")!;
  expect(opened.requestId).toBeUndefined(); // the OPEN event names no decision
  expect(opened.chatKey).toMatch(/^relay:/);

  // 3. The browser answers, on the ANSWER direction, with no identity of its own.
  await hub.answer({
    requestId: "req-chain-1",
    kind: "elicitation",
    action: "accept",
    content: { region: "us-east" },
  });

  // 4. The hub resolves the close, and the connector's request settles.
  await waitFor(() => hub.events.some((e) => e.type === "interaction-closed"), "interaction-closed");
  const closed = hub.events.find((e) => e.type === "interaction-closed")!;
  expect(closed.requestId).toBe("req-chain-1");

  // 5. The decision core receives: the answer, and the responder identity the
  //    HUB stamped (never the browser, which carried none). Core re-verifies
  //    `responderId` against the exact turn initiator, so this is the value that
  //    matters.
  expect(await settled).toEqual({
    action: "accept",
    responderId: "relay:relay-acct",
    content: { region: "us-east" },
  });
});

test("a browser cannot assert the responder identity end to end", async () => {
  // The chain-level form of the identity rule: whatever the browser puts in the
  // frame must not survive into the decision core sees.
  const hub = await makeHub();
  await hub.startAndOpen();
  const settled = hub.channel.requestElicitation(hub.agentRequest);
  await waitFor(() => hub.events.some((e) => e.type === "interaction-opened"), "interaction-opened");

  // A forged identity makes the answer invalid at the validator, not merely
  // ignored — the hub refuses it, so the frame never becomes a decision at all.
  const accepted = await hub.answer({
    requestId: "req-chain-1",
    kind: "elicitation",
    action: "accept",
    content: { region: "us-east" },
    responderId: "attacker",
  });
  expect(accepted).toBe(false);
  // Nothing resolved: the form is still open, and the browser can still answer.
  await waitForTick();
  expect(hub.events.filter((e) => e.type === "interaction-closed")).toHaveLength(0);

  await hub.answer({
    requestId: "req-chain-1",
    kind: "elicitation",
    action: "accept",
    content: { region: "ap-south" },
  });
  await waitFor(() => hub.events.some((e) => e.type === "interaction-closed"), "interaction-closed");

  const decision = await settled;
  expect(decision.action).toBe("accept");
  expect(decision.action === "accept" && decision.responderId).toBe("relay:relay-acct");
});

test("a hub close is a cancel, never a decision the human did not make", async () => {
  // The window closes with no answer: the agent must see an abort, not a decline.
  const hub = await makeHub();
  await hub.startAndOpen();
  const decision = await hub.channel.requestElicitation({
    ...hub.agentRequest,
    requestId: "req-timeout",
    // Already past: the hub refuses to open it, and the connector reports a close.
    expiresAt: Date.now() - 1,
  });
  expect(decision).toEqual({ action: "cancel", responderId: "relay:relay-acct" });
  // And no form was ever shown.
  expect(hub.events.filter((e) => e.type === "interaction-opened")).toHaveLength(0);
});

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function waitForTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
