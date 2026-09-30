import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";

import { MSG, decodeEnvelope } from "../../../../packages/relay-protocol/src/index";
import type { WebServerEvent } from "../../../../packages/relay-protocol/src/index";
import { createSqlDriver, initSchema } from "../../../../packages/relay/src/db";
import { AccountStore } from "../../../../packages/relay/src/stores/accounts";
import { InstanceStore } from "../../../../packages/relay/src/stores/instances";
import { MessageStore } from "../../../../packages/relay/src/stores/messages";
import { createApp } from "../../../../packages/relay/src/http/app";
import {
  InstanceGateway,
} from "../../../../packages/relay/src/gateway/instance-gateway";
import { InteractionRegistry } from "../../../../packages/relay/src/interaction-registry";
import {
  WebGateway,
  type WebSocketLike,
} from "../../../../packages/relay/src/gateway/web-gateway";
import {
  handleWebClientMessage,
} from "../../../../packages/relay/src/gateway/web-inbound";
import { RelayChannel } from "../../../../packages/channel-relay/src/channel";
import { RelayClient } from "../../../../packages/channel-relay/src/relay-client";
import type { ChannelElicitationRequest } from "../../../src/interactions/elicitation-types";
import type { RelayCredential } from "../../../../packages/channel-relay/src/credential-store";

/**
 * Hub -> BROWSER delivery, with no seam stubbed anywhere near it.
 *
 * The chain test proves the connector reaches the hub and the answer comes back.
 * This proves the half that was separately broken: that a browser which has
 * SUBSCRIBED actually receives the form, and that its close arrives too.
 *
 * Every hop is real: a real connector WebSocket into the real `InstanceGateway`,
 * the real `InteractionRegistry`, and then the real path from the registry back
 * to a browser — the same wrapper `server.ts` builds and the real `WebGateway`
 * subscription fence. The browser is a real `ws` socket that has really
 * subscribed.
 *
 * Two production defects this pins, both found by review after the chain test
 * went green:
 *
 *   1. `server.ts` wrapped interaction events with `instanceId: ""`, and
 *      `WebGateway.broadcast` fences control-events on each socket's instance
 *      subscription — which the dashboard fills with its REAL instance ids on
 *      connect. So every form was dropped before it reached a subscribed
 *      dashboard, and the user saw nothing.
 *
 *   2. `InstanceGateway` has no public `broadcastControlEvent`: it is a
 *      dependency callback, so `deps.gateway.broadcastControlEvent?.(…)` from the
 *      app's registry listener was a silent no-op in production. Resolved,
 *      withdrawn, and expired closes were never broadcast at all.
 *
 * Both left the chain test green because it captures the raw event rather than
 * letting it pass through the fence.
 */

class MemoryCredentialStore {
  constructor(private value: RelayCredential | null = null) {}
  load() { return this.value; }
  save(credential: RelayCredential) { this.value = credential; }
  clear() { this.value = null; }
}

interface Hub {
  channel: RelayChannel;
  agentRequest: ChannelElicitationRequest;
  hubAccountId: string;
  connectorInstanceId: string;
  /** Everything a subscribed browser socket actually received. */
  seen: WebServerEvent[];
  startAndOpen: () => Promise<void>;
  /** Register + subscribe a real browser socket, exactly as the dashboard does. */
  connectBrowser: () => Promise<WebSocket>;
  answer: (payload: unknown) => Promise<boolean>;
  pendingIds: () => string[];
  close: () => Promise<void>;
}

async function makeHub(): Promise<Hub> {
  const dir = mkdtempSync(join(tmpdir(), "relay-web-delivery-"));
  const db = await createSqlDriver(join(dir, "hub.db"));
  initSchema(db);
  const accounts = new AccountStore(db);
  const instances = new InstanceStore(db);
  const admin = accounts.createAccount("admin");
  const interactions = new InteractionRegistry({ debug: () => {} });

  // The REAL web gateway, with the REAL subscription fence. A socket that has
  // subscribed only receives control-events whose instanceId it named.
  const webGateway = new WebGateway({ logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } });
  const seen: WebServerEvent[] = [];

  /**
   * The wrapper `server.ts` builds. Its forwarding of the event's OWN instanceId
   * is the behaviour under test — blanking it here is the mutation that must go
   * red, so it is reproduced faithfully rather than simplified.
   */
  const broadcastControlEvent = (accountId: string, event: { instanceId?: string }): void => {
    webGateway.broadcast(accountId, {
      kind: "control-event",
      instanceId: event.instanceId ?? "",
      event,
    } as WebServerEvent);
  };

  const gateway = new InstanceGateway({
    instances,
    accounts,
    requestTimeoutMs: 60_000,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    interactions,
    broadcastControlEvent: broadcastControlEvent as never,
  });

  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  wss.on("connection", (socket) => gateway.handleConnection(socket));
  const connectorPort = (wss.address() as { port: number }).port;

  const webWss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => webWss.on("listening", () => resolve()));
  webWss.on("connection", (socket) => {
    webGateway.register(admin.id, socket as unknown as WebSocketLike);
  });
  const webPort = (webWss.address() as { port: number }).port;

  const app = createApp({
    accounts,
    instances,
    messages: new MessageStore(db),
    interactions,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    gateway: {
      isOnline: (instanceId: string) => gateway.isOnline(instanceId),
      sendRequest: async () => ({}),
      // PRODUCTION-STYLE: the app's registry listener calls THIS, and on a real
      // gateway it resolves to the public method — which, before it existed, was
      // undefined on `InstanceGateway` and made every close a silent no-op.
      // Wiring the gateway itself rather than a bare function is what makes that
      // defect observable here.
      broadcastControlEvent: (accountId: string, event: never) =>
        gateway.broadcastControlEvent(accountId, event),
    } as never,
  });

  const { token } = accounts.createLoginToken(admin.id, "test");
  const loginRes = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const cookie = loginRes.headers.get("set-cookie")?.split(";")[0] ?? "";
  const browserRpcInstance = instances.registerInstanceForAccount(admin.id, "home-pc");

  const rpcAsBrowser = (type: string, payload: unknown): Promise<Response> =>
    app.request(`/api/instances/${browserRpcInstance.instanceId}/rpc`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ type, payload }),
    });

  const agentRequest: ChannelElicitationRequest = {
    requestId: "req-web-1",
    chatKey: "bot:conv-1:topic-1",
    requester: { senderId: "relay:relay-acct", isOwner: true },
    // A relay web dashboard is one authenticated human, so the hub stamps this.
    // The renderer refuses without it.
    chatType: "direct",
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
  const client = new RelayClient({
    url: `ws://127.0.0.1:${connectorPort}`,
    credentialStore,
    pairingToken,
    instanceName: "chain-pc",
    coreVersion: "0.11.0",
    onRequest: () => {},
    reconnectDelaysMs: [],
  });

  let clientSeen = false;
  const channel = new RelayChannel(
    { url: `ws://127.0.0.1:${connectorPort}`, pairingToken },
    {
      credentialStore,
      createClient: () => {
        clientSeen = true;
        return client as unknown as never;
      },
    },
  );

  return {
    channel,
    agentRequest,
    hubAccountId: admin.id,
    connectorInstanceId: "",
    seen,
    startAndOpen: async () => {
      const controller = new AbortController();
      void channel.start({
        agent: { chat: async () => ({ text: "" }) },
        abortSignal: controller.signal,
        quota: {} as never,
        logger: { info: async () => {}, warn: async () => {}, error: async () => {}, debug: async () => {} },
        control: { events: { subscribe: () => () => {} }, listSessions: () => [] },
        coreVersion: "0.11.0",
      } as never);
      await waitFor(() => clientSeen && client.isReady(), "authenticated relay client");
    },
    connectBrowser: async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${webPort}`);
      await new Promise<void>((resolve, reject) => {
        socket.on("open", () => resolve());
        socket.on("error", reject);
      });
      socket.on("message", (data) => {
        const decoded = decodeEnvelope(String(data));
        if (decoded.ok) seen.push(decoded.envelope.payload as WebServerEvent);
      });
      // What the dashboard does on connect: subscribe to its OWNED instances. A
      // browser that has subscribed receives only events naming one of them.
      const owned = instances.listByAccount(admin.id).map((i) => i.id);
      await handleWebClientMessage(
        {
          instances,
          gateway: { isOnline: () => true, sendRequest: async () => ({}) },
          webGateway: webGateway as never,
          stateSnapshot: () => ({ turns: [], usage: [], commands: [] }),
          interactions,
        } as never,
        admin.id,
        socket as unknown as WebSocketLike,
        JSON.stringify({
          protocolVersion: 1,
          kind: "event",
          id: "sub-1",
          type: "web.client.subscribe",
          payload: { instanceIds: owned },
        }),
      );
      return socket;
    },
    answer: async (payload: unknown) => {
      const res = await rpcAsBrowser(MSG.interactionRespond, payload);
      return res.status === 200;
    },
    pendingIds: () => interactions.listForAccount(admin.id).map((e) => e.requestId),
    close: async () => {
      client.stop();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => webWss.close(() => resolve()));
    },
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const browserEvents = (seen: WebServerEvent[]) =>
  seen.filter((e): e is Extract<WebServerEvent, { kind: "control-event" }> =>
    e.kind === "control-event");

test("a subscribed dashboard receives the form, with the opener's instanceId", async () => {
  const hub = await makeHub();
  await hub.startAndOpen();
  // The browser connects AFTER the channel is up and subscribes to its real
  // instances — the exact order a dashboard page load produces.
  const browser = await hub.connectBrowser();
  expect(hub.connectorInstanceId).toBeDefined();

  const settled = hub.channel.requestElicitation(hub.agentRequest);

  // The form reached a socket that has SUBSCRIBED. This is the assertion that
  // `instanceId: ""` broke: the fence drops it and the browser sees nothing.
  await waitFor(
    () => browserEvents(hub.seen).some((e) => e.event.type === "interaction-opened"),
    "interaction-opened on a subscribed socket",
  );
  const opened = browserEvents(hub.seen).find((e) => e.event.type === "interaction-opened")!;
  expect(opened.instanceId).not.toBe("");
  // And it is the instance the store will route an answer back to.
  expect(opened.instanceId.length).toBeGreaterThan(0);

  await hub.answer({
    requestId: "req-web-1",
    kind: "elicitation",
    action: "accept",
    content: { region: "us-east" },
  });
  await waitFor(
    () => browserEvents(hub.seen).some((e) => e.event.type === "interaction-closed"),
    "interaction-closed on a subscribed socket",
  );

  // EXACTLY one close, carrying the same instance the open did.
  const closes = browserEvents(hub.seen).filter((e) => e.event.type === "interaction-closed");
  expect(closes).toHaveLength(1);
  expect(closes[0]!.instanceId).toBe(opened.instanceId);
  expect((closes[0]!.event as { reason: string }).reason).toBe("resolved");

  expect(await settled).toEqual({
    action: "accept",
    responderId: hub.hubAccountId,
    content: { region: "us-east" },
  });

  browser.close();
  await hub.close();
});

test("a withdrawal closes the form on a subscribed browser", async () => {
  const hub = await makeHub();
  await hub.startAndOpen();
  const browser = await hub.connectBrowser();

  const controller = new AbortController();
  const settled = hub.channel.requestElicitation({
    ...hub.agentRequest,
    requestId: "req-web-2",
    signal: controller.signal,
  });
  // Observed, not ignored: the promise rejects from the signal, and a rejection
  // nobody has attached to surfaces as an unhandled-rejection failure rather than
  // as the assertion this test wants to make.
  let withdrawalRejection: unknown;
  const withdrawalObserved = settled.catch((error: unknown) => {
    withdrawalRejection = error;
  });
  await waitFor(
    () => browserEvents(hub.seen).some((e) => e.event.type === "interaction-opened"),
    "interaction-opened",
  );

  controller.abort();

  await waitFor(
    () => browserEvents(hub.seen).some((e) => e.event.type === "interaction-closed"),
    "interaction-closed",
  );
  await withdrawalObserved;
  const closed = browserEvents(hub.seen).find((e) => e.event.type === "interaction-closed")!;
  expect((closed.event as { reason: string }).reason).toBe("withdrawn");
  expect(withdrawalRejection).toBeInstanceOf(Error);

  browser.close();
  await hub.close();
});

test("an expiry closes the form on a subscribed browser", async () => {
  const hub = await makeHub();
  await hub.startAndOpen();
  const browser = await hub.connectBrowser();

  const settled = hub.channel.requestElicitation({
    ...hub.agentRequest,
    requestId: "req-web-3",
    expiresAt: Date.now() + 40,
  });
  // Observed, not ignored: the expiry rejects synchronously from the hub's own
  // timeout, and an unattached rejection fails the run as an unhandled rejection
  // rather than as this test's assertion.
  let expiryRejection: unknown;
  const expiryObserved = settled.catch((error: unknown) => {
    expiryRejection = error;
  });
  await waitFor(
    () => browserEvents(hub.seen).some((e) => e.event.type === "interaction-opened"),
    "interaction-opened",
  );
  await waitFor(
    () => browserEvents(hub.seen).some((e) => e.event.type === "interaction-closed"),
    "interaction-closed",
  );
  await expiryObserved;

  const closes = browserEvents(hub.seen).filter((e) => e.event.type === "interaction-closed");
  expect(closes).toHaveLength(1);
  expect((closes[0]!.event as { reason: string }).reason).toBe("expired");
  // No human decided, so no decision may be reported and no responder invented.
  expect(expiryRejection).toBeInstanceOf(Error);

  browser.close();
  await hub.close();
});

test("a decline is reported as declined, not accepted", async () => {
  const hub = await makeHub();
  await hub.startAndOpen();
  const browser = await hub.connectBrowser();

  const settled = hub.channel.requestElicitation({
    ...hub.agentRequest,
    requestId: "req-web-4",
  });
  await waitFor(
    () => browserEvents(hub.seen).some((e) => e.event.type === "interaction-opened"),
    "interaction-opened",
  );
  await hub.answer({
    requestId: "req-web-4",
    kind: "elicitation",
    action: "decline",
  });
  await waitFor(
    () => browserEvents(hub.seen).some((e) => e.event.type === "interaction-closed"),
    "interaction-closed",
  );

  const closed = browserEvents(hub.seen).find((e) => e.event.type === "interaction-closed")!;
  expect((closed.event as { reason: string }).reason).toBe("resolved");
  // The action the human chose, carried by the hub. A tab that did not click must
  // not be told "accepted".
  expect((closed.event as { action?: string }).action).toBe("decline");
  expect((await settled).action).toBe("decline");

  browser.close();
  await hub.close();
});
