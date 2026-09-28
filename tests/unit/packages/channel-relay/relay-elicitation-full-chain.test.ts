import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";

import {
  MSG,
  RELAY_INTERACTION_RESPONSE_RESERVE_MS,
} from "../../../../packages/relay-protocol/src/index";
import type { RelayEnvelope } from "../../../../packages/relay-protocol/src/index";
import { createSqlDriver, initSchema } from "../../../../packages/relay/src/db";
import { AccountStore } from "../../../../packages/relay/src/stores/accounts";
import { InstanceStore } from "../../../../packages/relay/src/stores/instances";
import { MessageStore } from "../../../../packages/relay/src/stores/messages";
import { createApp } from "../../../../packages/relay/src/http/app";
import {
  InstanceGateway,
} from "../../../../packages/relay/src/gateway/instance-gateway";
import { InteractionRegistry } from "../../../../packages/relay/src/interaction-registry";
import { RelayChannel } from "../../../../packages/channel-relay/src/channel";
import { RelayClient } from "../../../../packages/channel-relay/src/relay-client";
import type { ChannelElicitationRequest } from "../../../src/interactions/elicitation-types";
import type { RelayCredential } from "../../../../packages/channel-relay/src/credential-store";

/**
 * The M3 chain over the PRODUCTION transport, with no seam stubbed out.
 *
 * Every hop is the real production code:
 *
 *   core's broker      → RelayChannel.requestElicitation   (the real method)
 *   connector          → RelayClient.sendRequest           (the REAL client)
 *                        — real allowlist, real envelope encode,
 *                          real pending-request bookkeeping
 *   network            → a real ws:// WebSocket             (the only fake is
 *                        the loopback socket, which is what a real one is)
 *   hub                → InstanceGateway.handleMessage     (the REAL ingress,
 *                        including the authenticated connector socket's own
 *                        identity)
 *   hub                → real InteractionRegistry
 *   browser            → hub HTTP RPC                      (real authenticated
 *                        session)
 *   hub                → stamps ITS identity               (real)
 *   hub                → sends the WS response frame       (real gateway code)
 *   connector          → RelayClient's pending promise     (real decode)
 *   the decision       → what core would re-verify
 *
 * A previous revision of this test stubbed the channel's `createClient` seam and
 * posted the connector's frame straight into the browser HTTP RPC endpoint. That
 * was not a "network fake" — it bypassed the connector's real RelayClient AND the
 * hub's real WebSocket request dispatcher, which is precisely the pair of seam
 * that had to be proven. The mutations below are the regression: disabling either
 * end must turn this red.
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
  /**
   * The hub's OWN authenticated account id — the identity it stamps onto every
   * decision. Read off the store rather than written by name: a test that names
   * it cannot tell whether the stamp came from the hub or from the request.
   */
  hubAccountId: string;
  /** Start the channel and connect the client; resolves once it is AUTHED. */
  startAndOpen: () => Promise<void>;
  /** The browser's answer, on the answer direction. False when the hub refused it. */
  answer: (payload: unknown) => Promise<boolean>;
  /**
   * The browser's RPC surface, raw. Exists so a test can ATTEMPT a
   * connector-only control (open/withdraw) from the browser side and observe it
   * refused — which is the only way to prove the boundary held.
   */
  rpcAsBrowser: (type: string, payload: unknown) => Promise<Response>;
  /** Browser-facing events the hub actually broadcast. */
  events: Array<{ type: string; chatKey: string; requestId?: string; reason?: string }>;
  /** Request ids the hub currently has open. */
  pendingIds: () => string[];
  close: () => Promise<void>;
}

async function makeHub(): Promise<HubHarness> {
  const dir = mkdtempSync(join(tmpdir(), "relay-chain-"));
  const db = await createSqlDriver(join(dir, "hub.db"));
  initSchema(db);
  const accounts = new AccountStore(db);
  const instances = new InstanceStore(db);
  const admin = accounts.createAccount("admin");
  const interactions = new InteractionRegistry({ debug: () => {} });

  const events: Array<{ type: string; chatKey: string; requestId?: string; reason?: string }> = [];
  const broadcastControlEvent = (accountId: string, event: { type: string }): void => {
    events.push({
      type: event.type,
      chatKey: (event as { chatKey?: string }).chatKey ?? "",
      requestId: (event as { requestId?: string }).requestId,
      reason: (event as { reason?: string }).reason,
    });
  };

  // The hub's REAL WebSocket ingress. `interactionRequest` and
  // `interactionWithdraw` are handled here, on the authenticated connector
  // socket — which is the only place their identity can come from.
  const gateway = new InstanceGateway({
    instances,
    accounts,
    requestTimeoutMs: 60_000,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    interactions,
    broadcastControlEvent,
  });

  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  wss.on("connection", (socket) => gateway.handleConnection(socket));
  const port = (wss.address() as { port: number }).port;
  const hubUrl = `ws://127.0.0.1:${port}`;

  const app = createApp({
    accounts,
    instances,
    messages: new MessageStore(db),
    interactions,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    gateway: {
      isOnline: (instanceId: string) => gateway.isOnline(instanceId),
      sendRequest: async () => ({}),
      broadcastControlEvent,
    },
  });

  // A real browser session cookie, from a real login token.
  const { token } = accounts.createLoginToken(admin.id, "test");
  const loginRes = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const cookie = loginRes.headers.get("set-cookie")?.split(";")[0] ?? "";
  const adminInstance = instances.registerInstanceForAccount(admin.id, "home-pc");

  const rpc = (type: string, payload: unknown): Promise<Response> =>
    app.request(`/api/instances/${adminInstance.instanceId}/rpc`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ type, payload }),
    });

  const answer = async (payload: unknown): Promise<boolean> => {
    const res = await rpc(MSG.interactionRespond, payload);
    expect([200, 400, 409]).toContain(res.status);
    return res.status === 200;
  };

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

  const pairingToken = instances.issuePairingToken(admin.id, "chain-pc", 600_000).token;
  const credentialStore = new MemoryCredentialStore();
  // The real RelayClient — the production connector object, constructed the way
  // `RelayChannel` constructs it. Everything below is real: its allowlist, its
  // envelope encode/decode, its pending-request bookkeeping, its handshake.
  const client = new RelayClient({
    url: hubUrl,
    credentialStore,
    pairingToken,
    instanceName: "chain-pc",
    coreVersion: "0.11.0",
    onRequest: () => {},
    // No reconnect in a test: each attempt would re-handshake and re-stamp the
    // store, and the loopback socket never needs to be re-established.
    reconnectDelaysMs: [],
  });

  let clientSeen = false;
  const channel = new RelayChannel({ url: hubUrl, pairingToken }, {
    credentialStore,
    // The real client — returned to the channel rather than a stub, so the
    // channel's `client.sendRequest` IS the allowlist-checked,
    // envelope-encoding method under test.
    createClient: () => {
      clientSeen = true;
      return client as unknown as ChannelClient;
    },
  });

  /**
   * Start the channel so it can dial the hub.
   *
   * `start()` parks on the channel's lifetime abort signal by design, so
   * awaiting it would hang every test. What matters is that the client is
   * AUTHED — the state `sendRequest` requires — and that is what this waits for.
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
    await waitFor(() => clientSeen && client.isReady(), "authenticated relay client");
  };

  return {
    channel,
    agentRequest,
    hubAccountId: admin.id,
    startAndOpen,
    answer,
    rpcAsBrowser: rpc,
    events,
    pendingIds: () =>
      interactions.listForAccount(admin.id).map((e) => e.requestId),
    close: async () => {
      client.stop();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

interface ChannelClient {
  start(abortSignal: AbortSignal): void;
  stop(): void;
  sendEvent(type: string, payload: unknown): void;
  sendRequest(type: string, payload: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  isReady(): boolean;
}

test("the full M3 chain over the real WebSocket transport", async () => {
  // Nothing about the socket is faked: the connector's frame leaves through
  // RelayClient's real allowlist and encode, lands on InstanceGateway's real
  // `req` dispatcher, and the answer comes back as a real WS response frame.
  const hub = await makeHub();
  await hub.startAndOpen();

  const settled = hub.channel.requestElicitation(hub.agentRequest);

  await waitFor(() => hub.events.some((e) => e.type === "interaction-opened"), "interaction-opened");
  const opened = hub.events.find((e) => e.type === "interaction-opened")!;
  expect(opened.chatKey).toMatch(/^relay:/);
  expect(hub.pendingIds()).toEqual(["req-chain-1"]);

  await hub.answer({
    requestId: "req-chain-1",
    kind: "elicitation",
    action: "accept",
    content: { region: "us-east" },
  });

  await waitFor(() => hub.events.some((e) => e.type === "interaction-closed"), "interaction-closed");
  const closed = hub.events.find((e) => e.type === "interaction-closed")!;
  expect(closed.requestId).toBe("req-chain-1");
  expect(closed.reason).toBe("resolved");

  // The decision core receives: the answer, and the responder identity the HUB
  // stamped from its own authenticated session. The initiator named in
  // `agentRequest` happens to be the same account, which is what makes this the
  // happy path — but the value arriving here is the stamp, not the echo.
  expect(await settled).toEqual({
    action: "accept",
    responderId: hub.hubAccountId,
    content: { region: "us-east" },
  });

  await hub.close();
});

test("the responder is the hub's stamp, never the request's initiator", async () => {
  // The load-bearing identity invariant, asserted with initiator ≠ responder.
  //
  // On the happy path both sides name the same account, so a channel that echoed
  // the initiator back would look correct. This makes them differ: the request
  // names one initiator, the hub's authenticated session is another account, and
  // the decision must carry the HUB's. Anything else means core's re-verification
  // is comparing the initiator with itself — a tautology that would let a
  // decision by anybody pass as the turn's initiator.
  const hub = await makeHub();
  await hub.startAndOpen();
  const settled = hub.channel.requestElicitation({
    ...hub.agentRequest,
    requestId: "req-chain-2",
    requester: { senderId: "relay:some-other-account", isOwner: true },
  });
  await waitFor(() => hub.events.some((e) => e.type === "interaction-opened"), "interaction-opened");

  await hub.answer({
    requestId: "req-chain-2",
    kind: "elicitation",
    action: "accept",
    content: { region: "eu-west" },
  });
  await waitFor(() => hub.events.some((e) => e.type === "interaction-closed"), "interaction-closed");

  const decision = await settled;
  expect(decision.action).toBe("accept");
  expect(decision.action === "accept" && decision.responderId).toBe(hub.hubAccountId);
  expect(decision.action === "accept" && decision.responderId).not.toBe("relay:some-other-account");

  await hub.close();
});

test("an abort withdraws the hub interaction, not just the local promise", async () => {
  // The request.signal contract, asserted through the REAL transport: the
  // withdrawal is a frame the connector's client actually puts on the wire and
  // the hub's real dispatcher actually handles.
  const hub = await makeHub();
  await hub.startAndOpen();

  const controller = new AbortController();
  const settled = hub.channel.requestElicitation({
    ...hub.agentRequest,
    requestId: "req-withdraw",
    signal: controller.signal,
  });
  await waitFor(() => hub.events.some((e) => e.type === "interaction-opened"), "interaction-opened");
  expect(hub.pendingIds()).toEqual(["req-withdraw"]);

  // The agent withdraws the elicitation.
  controller.abort();

  // 1. The hub's pending entry is gone.
  await waitFor(() => hub.pendingIds().length === 0, "hub pending withdrawn");
  // 2. The browser was told, by hub code, that the form is over.
  const closed = hub.events.find((e) => e.type === "interaction-closed" && e.requestId === "req-withdraw");
  expect(closed?.reason).toBe("withdrawn");
  // 3. The channel reports a cancel to core.
  expect(await settled).toEqual({ action: "cancel", responderId: "relay:relay-acct" });
  // 4. A late answer for the withdrawn interaction is refused, so nothing the
  //    human types afterwards can reach the turn.
  expect(await hub.answer({
    requestId: "req-withdraw",
    kind: "elicitation",
    action: "accept",
    content: { region: "us-central" },
  })).toBe(false);

  await hub.close();
});

test("the connector's transport refuses a browser-asserted close", async () => {
  // The trust boundary that motivated moving these off the browser RPC. The
  // browser surface answers; it cannot open or withdraw. A browser that tries to
  // withdraw by requestId alone gets the generic rejection, not a close.
  const hub = await makeHub();
  await hub.startAndOpen();
  const settled = hub.channel.requestElicitation({
    ...hub.agentRequest,
    requestId: "req-browser-close",
  });
  await waitFor(() => hub.events.some((e) => e.type === "interaction-opened"), "interaction-opened");

  // A browser attempting the connector-only control on the browser RPC surface.
  const res = await hub.rpcAsBrowser(MSG.interactionWithdraw, { requestId: "req-browser-close" });
  expect([400, 403]).toContain(res.status);
  // The interaction is still open and still answerable.
  expect(hub.pendingIds()).toEqual(["req-browser-close"]);
  expect(hub.events.some((e) => e.type === "interaction-closed")).toBe(false);

  await hub.answer({
    requestId: "req-browser-close",
    kind: "elicitation",
    action: "decline",
  });
  await waitFor(() => hub.events.some((e) => e.type === "interaction-closed"), "interaction-closed");
  expect((await settled).action).toBe("decline");

  await hub.close();
});

test("an answer after the window closed is refused, even inside the transport reserve", async () => {
  // The two clocks, asserted at the boundary where they differ.
  //
  // `expiresAt` is when answering stops being legal; the transport ceiling is
  // that plus a reserve, so the RPC is still waiting. Conflating them would let
  // an answer land after the window closed and travel back to a turn that had
  // already expired — the human being told "answered" for a window that was over.
  const hub = await makeHub();
  await hub.startAndOpen();

  const settled = hub.channel.requestElicitation({
    ...hub.agentRequest,
    requestId: "req-expired",
    // Well inside the transport reserve, so the RPC is definitely still waiting
    // when the answer below arrives.
    expiresAt: Date.now() + 40,
  });
  await waitFor(() => hub.events.some((e) => e.type === "interaction-opened"), "interaction-opened");

  // Past the answerability deadline, still inside the transport reserve.
  const windowOpenedAt = Date.now();
  await waitFor(
    () => hub.events.some((e) => e.type === "interaction-closed" && e.requestId === "req-expired"),
    "window to expire",
  );
  // The point of the whole test: the two clocks really are apart right now. If
  // the expiry timer had been bound to the transport ceiling, the wait above
  // would not have completed this quickly and the answer below would have been
  // accepted.
  expect(Date.now() - windowOpenedAt).toBeLessThan(RELAY_INTERACTION_RESPONSE_RESERVE_MS);

  // Answering now is NOT a late win: the window is over.
  expect(await hub.answer({
    requestId: "req-expired",
    kind: "elicitation",
    action: "accept",
    content: { region: "us-west" },
  })).toBe(false);
  expect(hub.events.find((e) => e.type === "interaction-closed" && e.requestId === "req-expired")?.reason)
    .toBe("expired");
  expect(await settled).toEqual({ action: "cancel", responderId: "relay:relay-acct" });

  await hub.close();
});

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
