import { expect, test } from "bun:test";

import {
  MSG,
  parseWebClientMessage,
  parseWebServerEvent,
  webClientEnvelope,
  webEventEnvelope,
} from "../../../../../packages/relay-protocol/src/index";
import { handleWebClientMessage, type WebClientDeps } from "../../../../../packages/relay/src/gateway/web-inbound";

interface SentEvent {
  socket: FakeSocket;
  event: unknown;
}

class FakeSocket {
  sent: string[] = [];
  viewerId?: string;
  sendEvent(event: unknown) { this.sent.push(JSON.stringify(event)); }
}

function desktopDeps(overrides: Partial<{
  capabilities: string[] | undefined;
  online: boolean;
  reserve: WebClientDeps["desktop"];
  prepareResult: unknown;
  prepareError: unknown;
}> = {}): { deps: WebClientDeps; socket: FakeSocket; sent: SentEvent[]; requests: Array<{ type: string; payload: unknown }>; events: Array<{ type: string; payload: unknown }>; owners: Map<string, { viewerId: string; accountId: string; instanceId: string; requestId?: string }>; cancelled: string[] } {
  const socket = new FakeSocket();
  socket.viewerId = "viewer-1";
  const sent: SentEvent[] = [];
  const requests: Array<{ type: string; payload: unknown }> = [];
  const events: Array<{ type: string; payload: unknown }> = [];
  const capabilities = overrides.capabilities ?? ["desktop.rfb.v1"];
  const owners = new Map<string, { viewerId: string; accountId: string; instanceId: string; requestId?: string }>();
  const cancelled: string[] = [];
  const desktop = overrides.reserve ?? {
    reserve: () => ({ ok: true as const, streamId: "s-1" }),
    mintConnectorTicket: () => ({ ticket: "t-connector", expiresAt: 1_700_000_000_000 }),
    mintBrowserTicket: () => ({ ticket: "t-browser", expiresAt: 1_700_000_001_000 }),
    markReady: () => true,
    cancel: (streamId: string) => {
      owners.delete(streamId);
      cancelled.push(streamId);
    },
    ownsStream: (streamId: string, viewerId: string) => owners.get(streamId)?.viewerId === viewerId,
    streamOwner: (streamId: string) => owners.get(streamId),
    cancelPendingByRequest: (requestId: string, viewerId: string, reason: string) => {
      for (const [streamId, owner] of [...owners]) {
        if (owner.requestId !== requestId || owner.viewerId !== viewerId) continue;
        owners.delete(streamId);
        cancelled.push(streamId);
        events.push({ instanceId: owner.instanceId, type: MSG.desktopCancel, payload: { streamId } });
        return true;
      }
      return false;
    },
    trackOwner: (streamId: string, owner: { viewerId: string; accountId: string; instanceId: string; requestId?: string }) => {
      owners.set(streamId, owner);
    },
  };
  const deps: WebClientDeps = {
    instances: {
      getOwned: () => ({ id: "i1", capabilities }),
      listByAccount: () => [{ id: "i1" }],
    },
    gateway: {
      sendEvent: (instanceId, type, payload) => {
        // Record the instanceId the hub chose to talk to: the routing assertions
        // depend on it, not just on which message was built.
        events.push({ instanceId, type, payload });
        return true;
      },
      sendRequest: async (instanceId, type, payload) => {
        requests.push({ type, payload });
        if (overrides.prepareError) throw overrides.prepareError;
        return overrides.prepareResult ?? { streamId: "s-1", security: "vnc-auth" };
      },
      isOnline: () => overrides.online ?? true,
    },
    webGateway: {
      setSubscription: () => {},
      send: ((s: unknown, event: unknown) => {
        sent.push({ socket: s as FakeSocket, event });
        (s as FakeSocket).sent.push(JSON.stringify(event));
        return true;
      }) as never,
      getViewerId: ((s: unknown) => (s as FakeSocket).viewerId) as never,
      bindAttachment: () => {},
      unbindAttachment: () => undefined,
      socketOwnsAttachment: () => true,
      getAttachmentBinding: () => undefined,
    },
    stateSnapshot: () => ({ turns: [], usage: [], commands: [], finishedOffline: [] }) as never,
    desktop,
  };
  return { deps, socket, sent, requests, events, owners, cancelled };
}

function sendDesktop(deps: WebClientDeps, accountId: string, socket: FakeSocket, kind: "desktop-open" | "desktop-close") {
  const msg = kind === "desktop-open"
    ? { kind, requestId: "r1", instanceId: "i1" }
    : { kind, instanceId: "i1", streamId: "s-1" };
  expect(parseWebClientMessage(webClientEnvelope(msg as never))).not.toBeNull();
  handleWebClientMessage(deps, accountId, socket as never, JSON.stringify(webClientEnvelope(msg as never)));
}

/** Close by requestId instead of streamId: the stream never reported back yet. */
function sendDesktopCloseRequest(deps: WebClientDeps, accountId: string, socket: FakeSocket, requestId: string) {
  const msg = { kind: "desktop-close", instanceId: "i1", requestId };
  expect(parseWebClientMessage(webClientEnvelope(msg as never))).not.toBeNull();
  handleWebClientMessage(deps, accountId, socket as never, JSON.stringify(webClientEnvelope(msg as never)));
}
test("desktop-open reserves, prepares, and emits a targeted desktop-opened", async () => {
  const { deps, socket, sent, requests } = desktopDeps();
  sendDesktop(deps, "a1", socket, "desktop-open");
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(requests.length).toBe(1);
  expect(requests[0]?.type).toBe(MSG.desktopPrepare);
  expect(requests[0]?.payload).toEqual({ streamId: "s-1", ticket: "t-connector", expiresAt: 1_700_000_000_000 });
  expect(sent.length).toBe(1);
  const event = sent[0]?.event as Record<string, unknown>;
  expect(event.kind).toBe("desktop-opened");
  expect(event).toMatchObject({
    requestId: "r1",
    instanceId: "i1",
    streamId: "s-1",
    wsPath: "/desktop/observe?ticket=t-browser",
    security: "vnc-auth",
  });
  expect(parseWebServerEvent(webEventEnvelope(event as never))).not.toBeNull();
});

test("an oversized connector error is bounded so the browser still receives it", async () => {
  // A connector failure message is free-form: an RFB 3.7/3.8 server listing 255
  // unknown security types produces `unsupported RFB security types: ...` well
  // past 1 KiB. The web validator drops an over-length `desktop-request-failed`
  // outright, so forwarding the raw text would replace a precise failure with a
  // silent one — the pending RPC would then only ever see its own timeout.
  const huge = "unsupported RFB security types: " + Array.from({ length: 255 }, (_, i) => "t" + i).join(",");
  expect(huge.length).toBeGreaterThan(512);
  const { deps, socket, sent } = desktopDeps({
    prepareResult: { error: { code: "desktop-auth-unsupported", message: huge.slice(0, 4096) } },
  });
  sendDesktop(deps, "a1", socket, "desktop-open");
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(sent.length).toBe(1);
  const event = sent[0]?.event as Record<string, unknown>;
  expect(event.kind).toBe("desktop-request-failed");
  expect(event.code).toBe("desktop-auth-unsupported");
  const message = String(event.message);
  // Bounded: still a valid WebServerEvent, so the browser can act on it.
  expect(message.length).toBeLessThanOrEqual(512);
  expect(message).not.toBe(huge);
  expect(parseWebServerEvent(webEventEnvelope(event as never))).not.toBeNull();
});

test("an empty connector error code is normalized, not silently dropped", async () => {
  // The web validator requires a NON-EMPTY bounded code. An empty string sails
  // through the connector-side isErrorPayload check, so forwarding it verbatim
  // produced an event relay-web then discarded as malformed - and the user saw
  // only the local 15s timeout instead of the actual failure.
  const { deps, socket, sent } = desktopDeps({
    prepareResult: { error: { code: "", message: "connector said nothing useful" } },
  });
  sendDesktop(deps, "a1", socket, "desktop-open");
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(sent.length).toBe(1);
  const event = sent[0]?.event as Record<string, unknown>;
  expect(event.kind).toBe("desktop-request-failed");
  expect(event.code).toBe("desktop-protocol-error");
  expect(parseWebServerEvent(webEventEnvelope(event as never))).not.toBeNull();
});

test("desktop-open fails closed without capability, offline, busy, or bad prepare", async () => {
  const busyStub = (scope: "instance" | "account") => ({
    reserve: () => ({ ok: false as const, code: "desktop-busy", scope }),
    mintConnectorTicket: () => ({ ticket: "x", expiresAt: 1 }),
    mintBrowserTicket: () => ({ ticket: "y", expiresAt: 1 }),
    markReady: () => true,
    cancel: () => {},
    ownsStream: () => false,
    trackOwner: () => {},
  });
  const busyInstance = desktopDeps({ reserve: busyStub("instance") });
  const busyAccount = desktopDeps({ reserve: busyStub("account") });
  const cases: Array<{ setup: { deps: WebClientDeps; socket: FakeSocket; sent: SentEvent[]; events: Array<{ type: string; payload: unknown }> }; code: string; message: string; reserveHappened: boolean }> = [
    { setup: desktopDeps({ capabilities: [] }), code: "desktop-disabled", message: "desktop is not enabled on this instance", reserveHappened: false },
    { setup: desktopDeps({ online: false }), code: "desktop-instance-offline", message: "instance is offline", reserveHappened: false },
    { setup: busyInstance, code: "desktop-busy", message: "another desktop viewer is active", reserveHappened: false },
    { setup: busyAccount, code: "desktop-busy", message: "too many active desktop viewers on this account", reserveHappened: false },
    { setup: desktopDeps({ prepareResult: { error: { code: "desktop-rfb-unavailable", message: "no VNC" } } }), code: "desktop-rfb-unavailable", message: "no VNC", reserveHappened: true },
    { setup: desktopDeps({ prepareResult: { streamId: "s-1", security: "ard" } }), code: "desktop-auth-unsupported", message: "Apple Remote Desktop auth needs Phase B", reserveHappened: true },
    { setup: desktopDeps({ prepareResult: { streamId: "wrong", security: "vnc-auth" } }), code: "desktop-protocol-error", message: "malformed prepare result", reserveHappened: true },
    { setup: desktopDeps({ prepareError: new Error("timeout") }), code: "desktop-stream-timeout", message: "desktop prepare timed out", reserveHappened: true },
  ];
  for (const { setup } of cases) sendDesktop(setup.deps, "a1", setup.socket, "desktop-open");
  for (let i = 0; i < 10; i++) await Promise.resolve();
  for (const { setup, code, message, reserveHappened } of cases) {
    expect(setup.sent.length).toBe(1);
    const event = setup.sent[0]?.event as Record<string, unknown>;
    expect(event.kind).toBe("desktop-request-failed");
    expect(event.code).toBe(code);
    expect(event.message).toBe(message);
    expect(parseWebServerEvent(webEventEnvelope(event as never))).not.toBeNull();
    // Once the stream exists the connector owns a live prepare attempt, so the
    // hub must tell it to stop — the local reservation teardown alone leaves a
    // pending dial running until the connector's own stage timeouts. Cases that
    // fail BEFORE reserve have no stream to name and must send nothing.
    expect(setup.events).toEqual(reserveHappened
      ? [{ instanceId: "i1", type: MSG.desktopCancel, payload: { streamId: "s-1" } }]
      : []);
  }
});

test("terminal-take-control still routes alongside desktop-open/desktop-close", async () => {
  // Insertion-guard: desktop branches were added between stream-start and
  // take-control; a dropped take-control branch silently breaks multi-view
  // terminal (spectator can never become controller).
  const { deps, socket, sent, requests } = desktopDeps();
  deps.webGateway.bindAttachment({ socket: socket as never, attachmentId: "a1", terminalId: "t1", generation: "g1" });
  const msg = { kind: "terminal-take-control", requestId: "r-tc", instanceId: "i1", attachmentId: "a1", generation: "g1" };
  expect(parseWebClientMessage(webClientEnvelope(msg as never))).not.toBeNull();
  handleWebClientMessage(deps, "a1", socket as never, JSON.stringify(webClientEnvelope(msg as never)));
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(requests.length).toBe(1);
  expect(requests[0]?.type).toBe(MSG.terminalTakeControl);
  expect(requests[0]?.payload).toMatchObject({ attachmentId: "a1", generation: "g1", viewerId: "viewer-1" });
  expect(sent.length).toBe(1);
  expect((sent[0]?.event as Record<string, unknown>).kind).toBe("terminal-opened");
});

test("desktop-close cancels the stream and notifies the connector", () => {
  const { deps, socket, events, owners } = desktopDeps();
  owners.set("s-1", { viewerId: "viewer-1", accountId: "a1", instanceId: "i1" });
  sendDesktop(deps, "a1", socket, "desktop-close");
  expect(events).toEqual([{ instanceId: "i1", type: MSG.desktopCancel, payload: { streamId: "s-1" } }]);
});

test("desktop-close routes the cancel to the owner instance, not the browser-supplied one", () => {
  // The browser chooses which stream to close, not which connector to talk to.
  // The hub stamped the authoritative {viewerId, accountId, instanceId} at
  // reserve, so the cancel must follow that record even when the message names
  // a different instance.
  const { deps, socket, events, owners } = desktopDeps();
  owners.set("s-1", { viewerId: "viewer-1", accountId: "a1", instanceId: "i-owner" });
  // Forge the instanceId: the viewer genuinely owns the stream, but says i2.
  const msg = { kind: "desktop-close", instanceId: "i-other", streamId: "s-1" };
  expect(parseWebClientMessage(webClientEnvelope(msg as never))).not.toBeNull();
  handleWebClientMessage(deps, "a1", socket as never, JSON.stringify(webClientEnvelope(msg as never)));

  // The event went to the owner instance, never to the requested one.
  expect(events).toEqual([{ instanceId: "i-owner", type: MSG.desktopCancel, payload: { streamId: "s-1" } }]);
});

test("desktop-close from another viewer is rejected", () => {
  const { deps, socket, events, owners } = desktopDeps();
  owners.set("s-1", { viewerId: "viewer-other", accountId: "a1", instanceId: "i1" });
  sendDesktop(deps, "a1", socket, "desktop-close");
  expect(events).toEqual([]);
});

// P2 regression: close an open that is still preparing, then reopen. The
// browser has no streamId yet, so it must close by requestId and the hub must
// release the reservation. Otherwise the immediate reopen hits desktop-busy.
test("desktop-close by requestId releases a pending prepare so reopen is not busy", async () => {
  // The prepare never resolves on its own: the reservation is held exactly as
  // long as a real slow prepare would hold it.
  const gate = new Promise<unknown>(() => {});
  const { deps, socket, sent, requests, owners, cancelled, events } = desktopDeps({ prepareResult: gate });

  sendDesktop(deps, "a1", socket, "desktop-open");
  await Promise.resolve();
  await Promise.resolve();
  expect(owners.get("s-1")?.requestId).toBe("r1");

  // The close arrives before the prepare answered: requestId is the only handle
  // the browser has on the reservation.
  sendDesktopCloseRequest(deps, "a1", socket, "r1");
  expect(cancelled).toEqual(["s-1"]);
  expect(owners.size).toBe(0);
  // The connector is told symmetrically with the streamId path.
  expect(events).toEqual([{ instanceId: "i1", type: MSG.desktopCancel, payload: { streamId: "s-1" } }]);
  // Nothing was reported to the browser, but the prepare was still issued.
  expect(requests.length).toBe(1);
  expect(sent.length).toBe(0);
});

test("desktop-close by an unknown requestId is a no-op, not a foreign stream kill", () => {
  const { deps, socket, owners, cancelled } = desktopDeps();
  owners.set("s-1", { viewerId: "viewer-1", accountId: "a1", instanceId: "i1", requestId: "other-open" });
  // A close naming a requestId that does not match must not resolve to this
  // stream: it would kill another viewer's prepare.
  sendDesktopCloseRequest(deps, "a1", socket, "not-mine");
  expect(cancelled).toEqual([]);
  expect(owners.size).toBe(1);
});

test("socket close during prepare cancels the exact stream", async () => {
  let release!: (payload: unknown) => void;
  const gate = new Promise<unknown>((resolve) => { release = resolve; });
  const { deps, socket, cancelled, owners } = desktopDeps({
    prepareResult: gate,
  });
  sendDesktop(deps, "a1", socket, "desktop-open");
  await Promise.resolve();
  await Promise.resolve();
  expect(owners.get("s-1")?.viewerId).toBe("viewer-1");
  // Control socket closes mid-prepare: cancel exactly this stream.
  deps.desktop!.cancel("s-1", "viewer-disconnected");
  expect(cancelled).toEqual(["s-1"]);
  release({ streamId: "s-1", security: "vnc-auth" });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(cancelled).toEqual(["s-1", "s-1"]);
});

test("prepare success after viewer disconnect rolls back instead of minting a ticket", async () => {
  let release!: (payload: unknown) => void;
  const gate = new Promise<unknown>((resolve) => { release = resolve; });
  const { deps, socket, sent, owners } = desktopDeps({
    prepareResult: gate,
  });
  sendDesktop(deps, "a1", socket, "desktop-open");
  await Promise.resolve();
  await Promise.resolve();
  // Viewer disconnected (or socket superseded) before the connector answered.
  owners.delete("s-1");
  socket.viewerId = undefined;
  release({ streamId: "s-1", security: "vnc-auth" });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(sent.length).toBe(1);
  expect((sent[0]?.event as Record<string, unknown>).code).toBe("desktop-stream-timeout");
});
