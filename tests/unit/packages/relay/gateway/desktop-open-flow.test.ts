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
}> = {}): { deps: WebClientDeps; socket: FakeSocket; sent: SentEvent[]; requests: Array<{ type: string; payload: unknown }>; events: Array<{ type: string; payload: unknown }>; owners: Map<string, { viewerId: string; accountId: string; instanceId: string }>; cancelled: string[] } {
  const socket = new FakeSocket();
  socket.viewerId = "viewer-1";
  const sent: SentEvent[] = [];
  const requests: Array<{ type: string; payload: unknown }> = [];
  const events: Array<{ type: string; payload: unknown }> = [];
  const capabilities = overrides.capabilities ?? ["desktop.rfb.v1"];
  const owners = new Map<string, { viewerId: string; accountId: string; instanceId: string }>();
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
    trackOwner: (streamId: string, owner: { viewerId: string; accountId: string; instanceId: string }) => {
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
        events.push({ type, payload });
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
  const cases: Array<{ setup: { deps: WebClientDeps; socket: FakeSocket; sent: SentEvent[] }; code: string; message: string }> = [
    { setup: desktopDeps({ capabilities: [] }), code: "desktop-disabled", message: "desktop is not enabled on this instance" },
    { setup: desktopDeps({ online: false }), code: "desktop-instance-offline", message: "instance is offline" },
    { setup: busyInstance, code: "desktop-busy", message: "another desktop viewer is active" },
    { setup: busyAccount, code: "desktop-busy", message: "too many active desktop viewers on this account" },
    { setup: desktopDeps({ prepareResult: { error: { code: "desktop-rfb-unavailable", message: "no VNC" } } }), code: "desktop-rfb-unavailable", message: "no VNC" },
    { setup: desktopDeps({ prepareResult: { streamId: "s-1", security: "ard" } }), code: "desktop-auth-unsupported", message: "Apple Remote Desktop auth needs Phase B" },
    { setup: desktopDeps({ prepareResult: { streamId: "wrong", security: "vnc-auth" } }), code: "desktop-protocol-error", message: "malformed prepare result" },
    { setup: desktopDeps({ prepareError: new Error("timeout") }), code: "desktop-stream-timeout", message: "desktop prepare timed out" },
  ];
  for (const { setup } of cases) sendDesktop(setup.deps, "a1", setup.socket, "desktop-open");
  for (let i = 0; i < 10; i++) await Promise.resolve();
  for (const { setup, code, message } of cases) {
    expect(setup.sent.length).toBe(1);
    const event = setup.sent[0]?.event as Record<string, unknown>;
    expect(event.kind).toBe("desktop-request-failed");
    expect(event.code).toBe(code);
    expect(event.message).toBe(message);
    expect(parseWebServerEvent(webEventEnvelope(event as never))).not.toBeNull();
  }
});

test("desktop-close cancels the stream and notifies the connector", () => {
  const { deps, socket, events, owners } = desktopDeps();
  owners.set("s-1", { viewerId: "viewer-1", accountId: "a1", instanceId: "i1" });
  sendDesktop(deps, "a1", socket, "desktop-close");
  expect(events).toEqual([{ type: MSG.desktopCancel, payload: { streamId: "s-1" } }]);
});

test("desktop-close from another viewer is rejected", () => {
  const { deps, socket, events, owners } = desktopDeps();
  owners.set("s-1", { viewerId: "viewer-other", accountId: "a1", instanceId: "i1" });
  sendDesktop(deps, "a1", socket, "desktop-close");
  expect(events).toEqual([]);
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
