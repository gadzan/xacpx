import { expect, test } from "bun:test";
import { WebSocketServer } from "ws";

import {
  MSG,
  RELAY_PROTOCOL_VERSION,
  decodeEnvelope,
  encodeEnvelope,
  errorPayload,
  type RelayEnvelope,
} from "../../../../packages/relay-protocol/src/index";
import { RelayClient, applyReconnectJitter } from "../../../../packages/channel-relay/src/relay-client";
import type { RelayCredential } from "../../../../packages/channel-relay/src/credential-store";

class MemoryCredentialStore {
  constructor(private value: RelayCredential | null = null) {}
  load() { return this.value; }
  save(credential: RelayCredential) { this.value = credential; }
  clear() { this.value = null; }
}

async function makeFakeRelay(onEnvelope: (envelope: RelayEnvelope, reply: (env: RelayEnvelope) => void, raw: import("ws").WebSocket) => void) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      const decoded = decodeEnvelope(String(data));
      if (decoded.ok) onEnvelope(decoded.envelope, (env) => socket.send(encodeEnvelope(env)), socket);
    });
  });
  return { wss, url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}` };
}

const res = (envelope: RelayEnvelope, payload: unknown): RelayEnvelope => ({
  protocolVersion: RELAY_PROTOCOL_VERSION, kind: "res", id: envelope.id, type: envelope.type, payload,
});

test("registers with pairing token, saves credential, reports ready", async () => {
  const { wss, url } = await makeFakeRelay((envelope, reply) => {
    if (envelope.type === MSG.instanceRegister) {
      expect((envelope.payload as { pairingToken: string }).pairingToken).toBe("pair-1");
      reply(res(envelope, { instanceId: "i-1", credential: "cred-1" }));
    }
  });
  const store = new MemoryCredentialStore();
  const controller = new AbortController();
  const ready = new Promise<void>((resolve) => {
    const client = new RelayClient({
      url, credentialStore: store, pairingToken: "pair-1", coreVersion: "0.11.0",
      onRequest: () => {}, onReady: resolve, reconnectDelaysMs: [0],
    });
    client.start(controller.signal);
  });
  await ready;
  expect(store.load()).toEqual({ instanceId: "i-1", credential: "cred-1", relayUrl: url });
  controller.abort();
  wss.close();
});

test("handshake sends constructor capabilities snapshot on register and auth", async () => {
  const caps = ["terminal.rmux.recovery.v1", "terminal.multi-view.v1"];
  let registerPayload: Record<string, unknown> | undefined;
  const { wss, url } = await makeFakeRelay((envelope, reply) => {
    if (envelope.type === MSG.instanceRegister) {
      registerPayload = envelope.payload as Record<string, unknown>;
      reply(res(envelope, { instanceId: "i-1", credential: "cred-1" }));
    }
  });
  const store = new MemoryCredentialStore();
  const controller = new AbortController();
  await new Promise<void>((resolve) => {
    const client = new RelayClient({
      url, credentialStore: store, pairingToken: "pair-1", coreVersion: "0.11.0",
      capabilities: caps,
      onRequest: () => {}, onReady: resolve, reconnectDelaysMs: [0],
    });
    client.start(controller.signal);
  });
  expect(registerPayload?.capabilities).toEqual(caps);
  controller.abort();
  wss.close();

  let authPayload: Record<string, unknown> | undefined;
  const { wss: wss2, url: url2 } = await makeFakeRelay((envelope, reply) => {
    if (envelope.type === MSG.instanceAuth) {
      authPayload = envelope.payload as Record<string, unknown>;
      reply(res(envelope, { ok: true }));
    }
  });
  const store2 = new MemoryCredentialStore({ instanceId: "i-1", credential: "cred-1", relayUrl: url2 });
  const controller2 = new AbortController();
  await new Promise<void>((resolve) => {
    const client = new RelayClient({
      url: url2, credentialStore: store2, capabilities: caps,
      onRequest: () => {}, onReady: resolve, reconnectDelaysMs: [0],
    });
    client.start(controller2.signal);
  });
  expect(authPayload?.capabilities).toEqual(caps);
  controller2.abort();
  wss2.close();
});

test("handshake omits backfill: missing capabilities option sends empty array", async () => {
  let registerPayload: Record<string, unknown> | undefined;
  const { wss, url } = await makeFakeRelay((envelope, reply) => {
    if (envelope.type === MSG.instanceRegister) {
      registerPayload = envelope.payload as Record<string, unknown>;
      reply(res(envelope, { instanceId: "i-1", credential: "cred-1" }));
    }
  });
  const store = new MemoryCredentialStore();
  const controller = new AbortController();
  await new Promise<void>((resolve) => {
    const client = new RelayClient({
      url, credentialStore: store, pairingToken: "pair-1",
      onRequest: () => {}, onReady: resolve, reconnectDelaysMs: [0],
    });
    client.start(controller.signal);
  });
  expect(registerPayload?.capabilities).toEqual([]);
  controller.abort();
  wss.close();
});

test("auths with stored credential, dispatches incoming req to onRequest, sends events", async () => {
  const seen: RelayEnvelope[] = [];
  let instanceSocketSend: ((env: RelayEnvelope) => void) | undefined;
  const { wss, url } = await makeFakeRelay((envelope, reply) => {
    seen.push(envelope);
    if (envelope.type === MSG.instanceAuth) {
      reply(res(envelope, { ok: true }));
      instanceSocketSend = reply;
      // immediately push a control req at the instance
      reply({ protocolVersion: RELAY_PROTOCOL_VERSION, kind: "req", id: "r-1", type: MSG.sessionsList, payload: {} });
    }
  });
  const store = new MemoryCredentialStore({ instanceId: "i-1", credential: "cred-1", relayUrl: url });
  const controller = new AbortController();
  const client = new RelayClient({
    url, credentialStore: store,
    onRequest: (envelope, respond) => {
      if (envelope.type === MSG.sessionsList) respond({ sessions: [] });
    },
    reconnectDelaysMs: [0],
  });
  client.start(controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const resEnvelope = seen.find((e) => e.kind === "res" && e.id === "r-1");
  expect(resEnvelope?.payload).toEqual({ sessions: [] });

  client.sendEvent(MSG.instanceEvent, { event: { type: "sessions-changed" } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(seen.some((e) => e.kind === "event" && e.type === MSG.instanceEvent)).toBe(true);
  controller.abort();
  wss.close();
});

function makeFakeLogger() {
  const errors: Array<{ code: string; message: string; meta: unknown }> = [];
  return {
    logger: {
      info: () => {},
      warn: () => {},
      error: (code: string, message: string, meta?: unknown) => { errors.push({ code, message, meta }); },
      debug: () => {},
    } as never,
    errors,
  };
}

test("logs and stops reconnecting on a protocol version mismatch", async () => {
  let connections = 0;
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  wss.on("connection", (socket) => {
    connections += 1;
    // push a raw line whose protocolVersion is not RELAY_PROTOCOL_VERSION
    socket.send(JSON.stringify({ protocolVersion: 999, kind: "event", type: "x", payload: {} }));
  });
  const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
  const store = new MemoryCredentialStore({ instanceId: "i-1", credential: "cred-1", relayUrl: url });
  const { logger, errors } = makeFakeLogger();
  const controller = new AbortController();
  const client = new RelayClient({ url, credentialStore: store, onRequest: () => {}, reconnectDelaysMs: [0], logger });
  client.start(controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(connections).toBe(1); // fatal version mismatch -> no reconnect
  expect(errors.some((e) => /decode/i.test(e.code) || /version/i.test(e.message))).toBe(true);
  controller.abort();
  wss.close();
});

test("logs a relay.protocol-error event and stops", async () => {
  let connections = 0;
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  wss.on("connection", (socket) => {
    connections += 1;
    socket.send(encodeEnvelope({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "event",
      type: "relay.protocol-error",
      payload: errorPayload("version-mismatch", "relay is newer than this connector"),
    }));
  });
  const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
  const store = new MemoryCredentialStore({ instanceId: "i-1", credential: "cred-1", relayUrl: url });
  const { logger, errors } = makeFakeLogger();
  const controller = new AbortController();
  const client = new RelayClient({ url, credentialStore: store, onRequest: () => {}, reconnectDelaysMs: [0], logger });
  client.start(controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(connections).toBe(1); // protocol-error event -> no reconnect
  expect(errors.some((e) => e.code === "relay.protocol_error")).toBe(true);
  controller.abort();
  wss.close();
});

test("onEvent throwing does not tear down the socket — subsequent events are still received", async () => {
  let eventCount = 0;
  let socketSendEvent: ((env: RelayEnvelope) => void) | undefined;
  const { wss, url } = await makeFakeRelay((envelope, reply) => {
    if (envelope.type === MSG.instanceAuth) {
      reply(res(envelope, { ok: true }));
      socketSendEvent = reply;
    }
  });
  const store = new MemoryCredentialStore({ instanceId: "i-1", credential: "cred-1", relayUrl: url });
  const { logger, errors } = makeFakeLogger();
  const controller = new AbortController();
  let callCount = 0;
  const client = new RelayClient({
    url, credentialStore: store, reconnectDelaysMs: [0], logger,
    onRequest: () => {},
    onEvent: (_env) => {
      callCount++;
      if (callCount === 1) throw new Error("onEvent boom"); // first call throws
      eventCount++;
    },
    onReady: () => {
      // push two events back-to-back once ready
      setTimeout(() => {
        socketSendEvent?.({ protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.terminalInput, payload: { terminalId: "t1", data: "a" } });
        socketSendEvent?.({ protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.terminalInput, payload: { terminalId: "t1", data: "b" } });
      }, 20);
    },
  });
  client.start(controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 300));
  // Second event must still arrive even though first threw.
  expect(eventCount).toBe(1);
  // The throw was logged as relay.event_dispatch_failed.
  expect(errors.some((e) => e.code === "relay.event_dispatch_failed")).toBe(true);
  controller.abort();
  wss.close();
});

test("reconnect delay gets +/-20% jitter around the configured base", () => {
  expect(applyReconnectJitter(1000, () => 0)).toBe(800);
  expect(applyReconnectJitter(1000, () => 0.5)).toBe(1000);
  expect(applyReconnectJitter(1000, () => 1)).toBe(1200);
  expect(applyReconnectJitter(0, () => 1)).toBe(0); // zero-delay test configs stay zero
});

test("respond after the socket closed is dropped safely instead of throwing", async () => {
  let capturedRespond: ((payload: unknown) => void) | undefined;
  const seen: RelayEnvelope[] = [];
  const { wss, url } = await makeFakeRelay((envelope, reply) => {
    seen.push(envelope);
    if (envelope.type === MSG.instanceAuth) {
      reply(res(envelope, { ok: true }));
      // Push a control req; the handler will answer only after the socket is gone.
      reply({ protocolVersion: RELAY_PROTOCOL_VERSION, kind: "req", id: "late-1", type: MSG.sessionsList, payload: {} });
    }
  });
  const store = new MemoryCredentialStore({ instanceId: "i-1", credential: "cred-1", relayUrl: url });
  const droppedLogs: string[] = [];
  const logger = {
    info: async () => {}, error: async () => {}, cleanup: async () => {}, flush: async () => {},
    debug: async (code: string) => { droppedLogs.push(code); },
  } as never;
  const controller = new AbortController();
  const client = new RelayClient({
    url, credentialStore: store, reconnectDelaysMs: [0], logger,
    onRequest: (_envelope, respond) => { capturedRespond = respond; },
  });
  client.start(controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(capturedRespond).toBeDefined();

  controller.abort(); // closes the socket
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(() => capturedRespond!({ sessions: [] })).not.toThrow();
  expect(droppedLogs).toContain("relay.response_dropped");
  // No res frame ever reached the relay for the late request.
  expect(seen.some((e) => e.kind === "res" && e.id === "late-1")).toBe(false);
  wss.close();
});

test("liveness watchdog terminates a silent connection and reconnects", async () => {
  let connections = 0;
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  wss.on("connection", (socket) => {
    connections += 1;
    // Auth ok, then total silence: no pings, no frames.
    socket.on("message", (data) => {
      const decoded = decodeEnvelope(String(data));
      if (decoded.ok && decoded.envelope.type === MSG.instanceAuth) {
        socket.send(encodeEnvelope(res(decoded.envelope, { ok: true })));
      }
    });
  });
  const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
  const store = new MemoryCredentialStore({ instanceId: "i-1", credential: "cred-1", relayUrl: url });
  const { logger, errors } = makeFakeLogger();
  const controller = new AbortController();
  const client = new RelayClient({
    url, credentialStore: store, onRequest: () => {}, reconnectDelaysMs: [0], logger,
    livenessTimeoutMs: 120,
  });
  client.start(controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(connections).toBeGreaterThanOrEqual(2); // watchdog fired -> close -> reconnect
  expect(errors.some((e) => e.code === "relay.connection_stalled")).toBe(true);
  controller.abort();
  wss.close();
});

test("server pings keep the liveness watchdog from firing", async () => {
  let connections = 0;
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  const pingTimers: ReturnType<typeof setInterval>[] = [];
  wss.on("connection", (socket) => {
    connections += 1;
    socket.on("message", (data) => {
      const decoded = decodeEnvelope(String(data));
      if (decoded.ok && decoded.envelope.type === MSG.instanceAuth) {
        socket.send(encodeEnvelope(res(decoded.envelope, { ok: true })));
      }
    });
    const timer = setInterval(() => { if (socket.readyState === socket.OPEN) socket.ping(); }, 40);
    pingTimers.push(timer);
    socket.on("close", () => clearInterval(timer));
  });
  const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
  const store = new MemoryCredentialStore({ instanceId: "i-1", credential: "cred-1", relayUrl: url });
  const controller = new AbortController();
  const client = new RelayClient({
    url, credentialStore: store, onRequest: () => {}, reconnectDelaysMs: [0],
    livenessTimeoutMs: 150,
  });
  client.start(controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(connections).toBe(1); // pings kept it alive
  controller.abort();
  pingTimers.forEach((timer) => clearInterval(timer));
  wss.close();
});

test("reconnects after a drop; fatal handshake rejection stops retrying", async () => {
  let connections = 0;
  const { wss, url } = await makeFakeRelay((envelope, reply, raw) => {
    if (envelope.type === MSG.instanceAuth) {
      connections += 1;
      if (connections === 1) {
        reply(res(envelope, { ok: true }));
        setTimeout(() => raw.close(), 20); // drop after handshake -> should reconnect
      } else {
        reply(res(envelope, errorPayload("auth-failed", "bad credential"))); // fatal -> stop
      }
    }
  });
  const store = new MemoryCredentialStore({ instanceId: "i-1", credential: "cred-1", relayUrl: url });
  const controller = new AbortController();
  const client = new RelayClient({ url, credentialStore: store, onRequest: () => {}, reconnectDelaysMs: [0] });
  client.start(controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(connections).toBe(2); // reconnected once, then stopped after fatal rejection
  controller.abort();
  wss.close();
});

test("sendRequest round-trips to relay server and resolves response", async () => {
  const { wss, url } = await makeFakeRelay((envelope, reply) => {
    if (envelope.type === MSG.instanceAuth) {
      reply(res(envelope, { ok: true }));
      return;
    }
    if (envelope.kind === "req" && envelope.type === MSG.agentMessageRoute) {
      reply({
        protocolVersion: RELAY_PROTOCOL_VERSION,
        kind: "res",
        id: envelope.id,
        type: envelope.type,
        payload: {
          messageId: "msg-123",
          status: "queued",
          modeUsed: "queue",
        },
      });
    }
  });
  const store = new MemoryCredentialStore({ instanceId: "i-1", credential: "cred-1", relayUrl: url });
  const controller = new AbortController();
  const client = new RelayClient({ url, credentialStore: store, onRequest: () => {}, reconnectDelaysMs: [0] });
  client.start(controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 200));

  const result = await client.sendRequest<{ status: string }>(MSG.agentMessageRoute, {
    targetNodeId: "node_2",
    targetEndpointId: "ep_2",
    messageId: "msg-123",
    content: "hi",
    requestedMode: "auto",
  });
  expect(result.status).toBe("queued");

  controller.abort();
  wss.close();
});
