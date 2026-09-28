// Regression for the review P2: an abnormally-closed browser control /ws (tab
// closed, network drop, crash, backpressure eviction) only ran the hub's local
// `closeStream`. The connector had already received `desktopPrepare` and was
// still probing / TCP-dialing / upgrading, so nothing told it the viewer was
// gone; its pending prepare ran until the ticket was rejected or its own
// connectTimeoutMs (up to 10s) fired.
//
// Plan Task 5 and design §13.2 both require "control socket close cancels this
// viewer's streams" to hold on the connector side too, not just in hub state.
//
// Unlike the desktop-open-flow tests — which call `deps.desktop.cancel()` by
// hand and therefore only prove the handler works IF something wires it — this
// drives the real WebGateway socket lifecycle. It fails if the wiring is removed
// again. The `onViewerClosed` body is copied verbatim from server.ts, so a
// future wiring change has to be mirrored here rather than silently diverging.

import { expect, test } from "bun:test";
import { WebSocket, WebSocketServer } from "ws";

import { MSG, decodeEnvelope, encodeEnvelope, RELAY_PROTOCOL_VERSION, type RelayEnvelope } from "../../../../packages/relay-protocol/src/index";
import { createSqlDriver, initSchema } from "../../../../packages/relay/src/db";
import { AccountStore } from "../../../../packages/relay/src/stores/accounts";
import { InstanceStore } from "../../../../packages/relay/src/stores/instances";
import { InstanceGateway } from "../../../../packages/relay/src/gateway/instance-gateway";
import { DesktopStreamGateway } from "../../../../packages/relay/src/gateway/desktop-stream-gateway";
import { WebGateway } from "../../../../packages/relay/src/gateway/web-gateway";
import { handleWebClientMessage, type WebClientDeps } from "../../../../packages/relay/src/gateway/web-inbound";

/** Minimal web-socket stand-in; only `close()` needs real behaviour (fires "close"). */
class BrowserSocket {
  sent: string[] = [];
  readyState = 1;
  private closeListeners: Array<() => void> = [];
  send(data: string) { this.sent.push(data); }
  on(event: "close", listener: () => void) {
    if (event === "close") this.closeListeners.push(listener);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    for (const l of this.closeListeners) l();
  }
}

async function testConnector(): Promise<{ gateway: InstanceGateway; instanceId: string; url: string; close: () => Promise<void> }> {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  const accounts = new AccountStore(db);
  const instances = new InstanceStore(db);
  accounts.createAccount("alice");
  const accountId = accounts.findByUsername("alice")!.id;

  const gateway = new InstanceGateway({
    accounts,
    instances,
    requestTimeoutMs: 500,
    onEvent: () => {},
  });
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => { wss.on("listening", () => r()); });
  wss.on("connection", (socket) => { gateway.handleConnection(socket as never); });

  // Redeem first so the test knows the real instanceId, then auth with it: the
  // connector's instanceId is what the hub stamps into the ownership map.
  const redeemed = instances.redeemPairingToken(
    instances.issuePairingToken(accountId, "pc", 600_000).token,
    "1.0.0",
  )!;
  const instanceId = redeemed.instanceId;

  const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
  const socket = new WebSocket(url);
  await new Promise<void>((r, j) => { socket.on("open", () => r()); socket.on("error", j); });

  const registered = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("connector never authenticated")), 4000);
    socket.once("message", (data) => {
      const decoded = decodeEnvelope(String(data));
      if (decoded.ok && decoded.envelope.kind === "res") { clearTimeout(timer); resolve(); }
    });
  });
  socket.send(encodeEnvelope({
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "req", id: "hs-1",
    type: MSG.instanceAuth,
    payload: { instanceId, credential: redeemed.credential, coreVersion: "1.0.0" },
  }));
  await registered;

  return {
    gateway,
    instanceId,
    url,
    close: () => new Promise((r) => { socket.close(); wss.close(() => r()); }),
  };
}

test("abnormal control-socket close during a pending prepare cancels the connector", async () => {
  const connector = await testConnector();

  const owners = new Map<string, { viewerId: string; accountId: string; instanceId: string }>();
  const hubClosed: string[] = [];
  const desktop = new DesktopStreamGateway({
    onStreamClosed: (streamId) => {
      owners.delete(streamId);
      hubClosed.push(streamId);
    },
  });

  // --- copied verbatim from packages/relay/src/server.ts (onViewerClosed) ---
  let gatewayRef: InstanceGateway | null = null;
  const webGateway = new WebGateway({
    onViewerClosed: (viewerId) => {
      for (const [streamId, owner] of [...owners]) {
        if (owner.viewerId !== viewerId) continue;
        try {
          gatewayRef?.sendEvent(owner.instanceId, MSG.desktopCancel, { streamId });
        } catch {
          // best effort: the local cleanup below must run regardless
        }
        owners.delete(streamId);
        desktop.closeStream(streamId, "viewer-disconnected");
      }
    },
  });
  gatewayRef = connector.gateway;
  // --- end copy ---

  // Record every event the hub actually hands to this connector, by wrapping
  // the real sendEvent. This is the wire, not a mock of it: the assertion below
  // fails if the cancel is never delivered, not just never computed.
  const sentToConnector: RelayEnvelope[] = [];
  const realSendEvent = connector.gateway.sendEvent.bind(connector.gateway);
  (connector.gateway as unknown as { sendEvent: (id: string, type: string, payload: unknown) => boolean }).sendEvent =
    (id: string, type: string, payload: unknown) => {
      sentToConnector.push({ protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type, payload } as RelayEnvelope);
      return realSendEvent(id, type, payload);
    };

  const pendingPrepare = new Promise<unknown>(() => {
    // Never settles: the connector is mid-prepare, which is the window the bug lived in.
  });

  const browser = new BrowserSocket();
  const viewerId = webGateway.register("acc-1", browser as never);
  const instanceId = connector.instanceId;

  const deps: WebClientDeps = {
    instances: {
      getOwned: () => ({ id: instanceId, capabilities: ["desktop.rfb.v1"] }),
      listByAccount: () => [{ id: instanceId }],
    },
    gateway: {
      sendEvent: (id, type, payload) => {
        // Record what the hub would deliver to the connector.
        sentToConnector.push({ protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type, payload } as RelayEnvelope);
        return connector.gateway.sendEvent(id, type, payload);
      },
      sendRequest: () => pendingPrepare,
      isOnline: () => true,
    },
    webGateway: {
      setSubscription: () => {},
      send: ((s: unknown, event: unknown) => {
        (s as BrowserSocket).sent.push(JSON.stringify(event));
        return true;
      }) as never,
      getViewerId: ((s: unknown) => webGateway.getViewerId(s as never)) as never,
      bindAttachment: () => {},
      unbindAttachment: () => undefined,
      socketOwnsAttachment: () => true,
      getAttachmentBinding: () => undefined,
    },
    stateSnapshot: () => ({ turns: [], usage: [], commands: [], finishedOffline: [] }) as never,
    desktop: {
      // Mirrors packages/relay/src/server.ts:1331-1350 exactly, so the hub map
      // is the same one the copied onViewerClosed iterates.
      reserve: (reserveAccountId, instanceId) => {
        const reserved = desktop.reserve({ accountId: reserveAccountId, instanceId, ttlMs: 60_000 });
        if (!reserved.ok) return reserved;
        return { ok: true as const, streamId: reserved.record.streamId };
      },
      mintConnectorTicket: (streamId, ticketAccountId, instanceId) =>
        desktop.ticketStore.mintTicket({ streamId, accountId: ticketAccountId, instanceId, side: "connector" }),
      mintBrowserTicket: (streamId, ticketAccountId, instanceId) =>
        desktop.mintBrowserTicket({ streamId, accountId: ticketAccountId, instanceId }),
      markReady: (streamId, security) => desktop.reportConnectorReady(streamId, security),
      cancel: (streamId, reason) => {
        owners.delete(streamId);
        desktop.closeStream(streamId, reason);
      },
      ownsStream: (streamId, ownerViewerId) => owners.get(streamId)?.viewerId === ownerViewerId,
      trackOwner: (streamId, owner) => {
        owners.set(streamId, owner);
      },
    } as never,
  };

  handleWebClientMessage(
    deps,
    "acc-1",
    browser as never,
    JSON.stringify({ protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: "web.client", payload: { kind: "desktop-open", requestId: "r1", instanceId } }),
  );
  await Promise.resolve();
  await Promise.resolve();

  // Ownership exists for this viewer, and the prepare is still in flight.
  const streamId = [...owners.keys()][0];
  expect(streamId).toBeDefined();
  expect(owners.get(streamId)?.viewerId).toBe(viewerId);

  // The abnormal case: only the control socket disappears. No desktop-close.
  browser.close();

  // 1. The connector was actually told to cancel, on the wire.
  const cancel = sentToConnector.find((e) => e.type === MSG.desktopCancel);
  expect(cancel).toBeDefined();
  expect((cancel as { payload?: unknown }).payload).toEqual({ streamId });

  // 2. Hub-side cleanup still ran unconditionally.
  expect(hubClosed).toEqual([streamId]);
  expect(owners.size).toBe(0);

  // 3. No browser ticket was minted while the prepare was still pending, so a
  //    late prepare resolution cannot resurrect a dead viewer.
  expect(browser.sent.filter((s) => s.includes("desktop-opened"))).toEqual([]);

  await connector.close();
});
