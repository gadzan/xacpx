// Covers the cross-socket race the markReady-clear missed:
//   prepare resolves -> connector reports ready (state waiting-browser)
//   -> browser has NOT attached its binary side yet
//   -> close by requestId + immediate reopen arrive on /ws
//
// At that point the requestId is the only handle either side has, so the hub
// must still release the reservation, otherwise the reopen sees the old stream
// live and fails busy.

import { expect, test } from "bun:test";
import { WebSocket, WebSocketServer } from "ws";

import { MSG, decodeEnvelope, encodeEnvelope, RELAY_PROTOCOL_VERSION, type RelayEnvelope } from "../../../../../packages/relay-protocol/src/index";
import { createSqlDriver, initSchema } from "../../../../../packages/relay/src/db";
import { AccountStore } from "../../../../../packages/relay/src/stores/accounts";
import { InstanceStore } from "../../../../../packages/relay/src/stores/instances";
import { InstanceGateway } from "../../../../../packages/relay/src/gateway/instance-gateway";
import { DesktopStreamGateway } from "../../../../../packages/relay/src/gateway/desktop-stream-gateway";
import { WebGateway } from "../../../../../packages/relay/src/gateway/web-gateway";
import { cancelViewerDesktopStreams, cancelViewerDesktopStreamByRequest, type DesktopStreamOwner } from "../../../../../packages/relay/src/gateway/desktop-viewer-cancel";
import { handleWebClientMessage, type WebClientDeps } from "../../../../../packages/relay/src/gateway/web-inbound";

class BrowserSocket {
  sent: string[] = [];
  readyState = 1;
  private closeListeners: Array<() => void> = [];
  send(data: string) { this.sent.push(data); }
  on(event: "close", listener: () => void) {
    if (event === "close") this.closeListeners.push(listener);
  }
  close() { this.readyState = 3; for (const l of this.closeListeners) l(); }
}

/** A live connector socket so the hub can send it `desktopPrepare`/`desktopCancel`. */
async function testConnector() {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  const accounts = new AccountStore(db);
  const instances = new InstanceStore(db);
  accounts.createAccount("alice");
  const accountId = accounts.findByUsername("alice")!.id;

  const wire: RelayEnvelope[] = [];
  const gateway = new InstanceGateway({ accounts, instances, requestTimeoutMs: 500, onEvent: () => {} });
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => { wss.on("listening", () => r()); });
  wss.on("connection", (socket) => {
    const original = socket.send.bind(socket);
    socket.send = ((data: unknown, ...rest: unknown[]) => {
      const decoded = decodeEnvelope(String(data));
      if (decoded.ok) wire.push(decoded.envelope);
      return (original as (...a: unknown[]) => unknown)(data, ...rest);
    }) as typeof socket.send;
    gateway.handleConnection(socket as never);
  });

  const redeemed = instances.redeemPairingToken(instances.issuePairingToken(accountId, "pc", 600_000).token, "1.0.0")!;
  const socket = new WebSocket(`ws://127.0.0.1:${(wss.address() as { port: number }).port}`);
  await new Promise<void>((r, j) => { socket.on("open", () => r()); socket.on("error", j); });
  const authenticated = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("connector never authenticated")), 4000);
    socket.once("message", (data) => {
      const decoded = decodeEnvelope(String(data));
      if (decoded.ok && decoded.envelope.kind === "res") { clearTimeout(timer); resolve(); }
    });
  });
  socket.send(encodeEnvelope({
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "req", id: "hs-1",
    type: MSG.instanceAuth,
    payload: { instanceId: redeemed.instanceId, credential: redeemed.credential, coreVersion: "1.0.0" },
  }));
  await authenticated;
  return { gateway, instanceId: redeemed.instanceId, wire, close: () => new Promise((r) => { socket.close(); wss.close(() => r()); }) };
}

function sendClient(deps: WebClientDeps, accountId: string, socket: BrowserSocket, msg: Record<string, unknown>): void {
  handleWebClientMessage(deps, accountId, socket as never, JSON.stringify({ protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: "web.client", payload: msg }));
}

test("a close by requestId still releases the reservation after the connector reports ready", async () => {
  const connector = await testConnector();

  // The SERVER-side bindings, copied from packages/relay/src/server.ts so this
  // test fails if the production wiring regresses.
  const owners = new Map<string, DesktopStreamOwner>();
  const desktop = new DesktopStreamGateway({ onStreamClosed: (streamId) => { owners.delete(streamId); } });
  const webGateway = new WebGateway({
    onViewerClosed: (viewerId) => cancelViewerDesktopStreams(connector.gateway, desktop, owners, viewerId),
  });

  // prepare resolves as soon as it is asked. The hub's `desktopPrepare` request
  // carries the real streamId, so echo it back — the hub validates
  // `result.streamId === streamId` before it will report the connector ready.
  const prepareResponse = (streamId: string): unknown => ({ streamId, security: "vnc-auth" as const });
  const browser = new BrowserSocket();
  webGateway.register("acc-1", browser as never);

  function makeDeps(): WebClientDeps {
    return {
      instances: { getOwned: () => ({ id: connector.instanceId, capabilities: ["desktop.rfb.v1"] }), listByAccount: () => [{ id: connector.instanceId }] },
      gateway: {
        sendEvent: (id, type, payload) => connector.gateway.sendEvent(id, type, payload),
        sendRequest: (_id, _type, payload) => Promise.resolve(
          prepareResponse((payload as { streamId: string }).streamId),
        ),
        isOnline: () => true,
      },
      webGateway: {
        setSubscription: () => {}, send: ((s: unknown, e: unknown) => { (s as BrowserSocket).sent.push(JSON.stringify(e)); return true; }) as never,
        getViewerId: ((s: unknown) => webGateway.getViewerId(s as never)) as never,
        bindAttachment: () => {}, unbindAttachment: () => undefined,
        socketOwnsAttachment: () => true, getAttachmentBinding: () => undefined,
      },
      stateSnapshot: () => ({ turns: [], usage: [], commands: [], finishedOffline: [] }) as never,
      desktop: {
        reserve: (reserveAccountId, reserveInstanceId) => {
          const r = desktop.reserve({ accountId: reserveAccountId, instanceId: reserveInstanceId, ttlMs: 60_000 });
          return r.ok ? { ok: true as const, streamId: r.record.streamId } : r;
        },
        mintConnectorTicket: (streamId, ticketAccountId, ticketInstanceId) =>
          desktop.ticketStore.mintTicket({ streamId, accountId: ticketAccountId, instanceId: ticketInstanceId, side: "connector" }),
        mintBrowserTicket: (streamId, ticketAccountId, ticketInstanceId) =>
          desktop.mintBrowserTicket({ streamId, accountId: ticketAccountId, instanceId: ticketInstanceId }),
        markReady: (streamId, security) => desktop.reportConnectorReady(streamId, security),
        cancel: (streamId, reason) => { owners.delete(streamId); desktop.closeStream(streamId, reason); },
        // Production helper, not a copy: a regression in the helper's state
        // gate must fail this test rather than leave a stale copy green.
        cancelPendingByRequest: (requestId, ownerViewerId, reason) =>
          cancelViewerDesktopStreamByRequest(connector.gateway, desktop, owners, requestId, ownerViewerId, reason),
        ownsStream: (streamId, ownerViewerId) => owners.get(streamId)?.viewerId === ownerViewerId,
        trackOwner: (streamId, owner) => { owners.set(streamId, owner); },
      } as never,
    };
  }

  const deps = makeDeps();
  sendClient(deps, "acc-1", browser, { kind: "desktop-open", requestId: "r1", instanceId: connector.instanceId });
  await new Promise((r) => setTimeout(r, 30));

  // The connector reported ready, so the stream is `waiting-browser`: the
  // browser's own binary attach has NOT happened yet. This is the window.
  const streamId = [...owners.keys()][0];
  expect(streamId).toBeDefined();
  expect(owners.get(streamId)?.requestId).toBe("r1");
  expect(desktop.streamState(streamId)).toBe("waiting-browser");

  // The user closes the panel before the binary socket connects.
  sendClient(deps, "acc-1", browser, { kind: "desktop-close", instanceId: connector.instanceId, requestId: "r1" });
  expect(owners.size).toBe(0);

  // The reopen must now succeed instead of colliding with the stream the viewer
  // just abandoned — that is the user-visible symptom.
  const reopenErrors: unknown[] = [];
  const deps2 = makeDeps();
  sendClient(deps2, "acc-1", browser, { kind: "desktop-open", requestId: "r2", instanceId: connector.instanceId });
  await new Promise((r) => setTimeout(r, 30));
  for (const raw of browser.sent) {
    const decoded = JSON.parse(raw) as { kind?: string; code?: string };
    if (decoded.kind === "desktop-request-failed") reopenErrors.push(decoded.code);
  }
  expect(reopenErrors).toEqual([]);

  // The abandoned stream was actually torn down, including on the connector side.
  expect(connector.wire.some((e) => e.type === MSG.desktopCancel)).toBe(true);

  await connector.close();
  expect(deps).toBeDefined();
});
