import { expect, test, mock } from "bun:test";
import {
  MSG,
  encodeEnvelope,
  webClientEnvelope,
  webEventEnvelope,
  decodeEnvelope,
  parseWebServerEvent,
} from "@ganglion/xacpx-relay-protocol";
import { handleWebClientMessage, handleConnectorTerminalEvent } from "../../../../packages/relay/src/gateway/web-inbound";
import { WebGateway } from "../../../../packages/relay/src/gateway/web-gateway";

class FakeSocket {
  sent: string[] = [];
  closeListeners: (() => void)[] = [];
  bufferedAmount = 0;
  readyState = 1;
  send(data: string) { this.sent.push(data); }
  terminate() { this.close(); }
  on(event: string, listener: () => void) { if (event === "close") this.closeListeners.push(listener); return this; }
  close() { for (const l of this.closeListeners) l(); }
}

function deps(owned: boolean, extras: Record<string, unknown> = {}) {
  const webGateway = new WebGateway();
  const sock = new FakeSocket();
  webGateway.register("a1", sock as never);
  return {
    instances: {
      getOwned: mock((id: string, acc: string) => (owned && id === "i1" && acc === "a1" ? { id: "i1" } : undefined)),
      listByAccount: mock((acc: string) => (owned && acc === "a1" ? [{ id: "i1" }] : [])),
    },
    gateway: {
      sendEvent: mock(() => true),
      sendRequest: mock(async () => ({
        terminalId: "t1",
        generation: "g1",
        attachmentId: "att-1",
        role: "controller",
        viewerCount: 1,
      })),
      isOnline: mock(() => true),
      ...extras,
    },
    webGateway,
    stateSnapshot: mock(() => ({ turns: [], usage: [], commands: [] })),
    sock,
  };
}

test("owned legacy terminal-input is forwarded as a gateway event", () => {
  const d = deps(true);
  handleWebClientMessage(d as never, "a1", d.sock as never, encodeEnvelope(webClientEnvelope({ kind: "terminal-input", instanceId: "i1", terminalId: "t1", data: "ls\n" })));
  expect((d.gateway.sendEvent as ReturnType<typeof mock>).mock.calls[0]).toEqual(["i1", MSG.terminalInput, { terminalId: "t1", data: "ls\n" }]);
});

test("non-owned instance is dropped (no forward)", () => {
  const d = deps(false);
  handleWebClientMessage(d as never, "a1", d.sock as never, encodeEnvelope(webClientEnvelope({ kind: "terminal-input", instanceId: "i1", terminalId: "t1", data: "x" })));
  expect((d.gateway.sendEvent as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});

test("resize/close map to their gateway event types", () => {
  const d = deps(true);
  handleWebClientMessage(d as never, "a1", d.sock as never, encodeEnvelope(webClientEnvelope({ kind: "terminal-resize", instanceId: "i1", terminalId: "t1", cols: 90, rows: 20 })));
  handleWebClientMessage(d as never, "a1", d.sock as never, encodeEnvelope(webClientEnvelope({ kind: "terminal-close", instanceId: "i1", terminalId: "t1" })));
  const calls = (d.gateway.sendEvent as ReturnType<typeof mock>).mock.calls;
  expect(calls[0]).toEqual(["i1", MSG.terminalResize, { terminalId: "t1", cols: 90, rows: 20 }]);
  expect(calls[1]).toEqual(["i1", MSG.terminalClose, { terminalId: "t1" }]);
});

test("garbage upstream frame is ignored", () => {
  const d = deps(true);
  handleWebClientMessage(d as never, "a1", d.sock as never, "not json");
  expect((d.gateway.sendEvent as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});

test("terminal-open binds then sends terminal-opened with hub-stamped viewerId on the connector RPC", async () => {
  const d = deps(true);
  handleWebClientMessage(
    d as never,
    "a1",
    d.sock as never,
    encodeEnvelope(webClientEnvelope({
      kind: "terminal-open",
      requestId: "req-1",
      instanceId: "i1",
      sessionAlias: "demo",
      cols: 80,
      rows: 24,
    })),
  );
  await Bun.sleep(20);

  const rpc = (d.gateway.sendRequest as ReturnType<typeof mock>).mock.calls[0];
  expect(rpc?.[0]).toBe("i1");
  expect(rpc?.[1]).toBe(MSG.terminalOpen);
  expect(rpc?.[2]).toMatchObject({
    chatKey: "relay:a1",
    sessionAlias: "demo",
    cols: 80,
    rows: 24,
  });
  expect(typeof (rpc?.[2] as { viewerId: string }).viewerId).toBe("string");

  expect(d.webGateway.socketOwnsAttachment(d.sock as never, "att-1")).toBe(true);
  const decoded = decodeEnvelope(d.sock.sent[0]!);
  expect(decoded.ok && parseWebServerEvent(decoded.envelope)).toMatchObject({
    kind: "terminal-opened",
    requestId: "req-1",
    attachmentId: "att-1",
    terminalId: "t1",
  });
});

test("instance offline open returns terminal-request-failed with instance-offline", async () => {
  const d = deps(true, { isOnline: mock(() => false) });
  handleWebClientMessage(
    d as never,
    "a1",
    d.sock as never,
    encodeEnvelope(webClientEnvelope({
      kind: "terminal-open",
      requestId: "req-2",
      instanceId: "i1",
      sessionAlias: "demo",
      cols: 80,
      rows: 24,
    })),
  );
  await Bun.sleep(10);
  const decoded = decodeEnvelope(d.sock.sent[0]!);
  expect(decoded.ok && parseWebServerEvent(decoded.envelope)).toMatchObject({
    kind: "terminal-request-failed",
    requestId: "req-2",
    code: "instance-offline",
  });
  expect((d.gateway.sendRequest as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});

test("recoverable input requires socket-owned attachment and stamps viewerId", async () => {
  const d = deps(true);
  d.webGateway.bindAttachment({
    socket: d.sock as never,
    attachmentId: "att-9",
    terminalId: "t9",
    instanceId: "i1",
  });
  handleWebClientMessage(
    d as never,
    "a1",
    d.sock as never,
    encodeEnvelope(webClientEnvelope({
      kind: "terminal-input",
      instanceId: "i1",
      attachmentId: "att-9",
      generation: "g9",
      dataBase64: Buffer.from("x").toString("base64"),
    })),
  );
  await Bun.sleep(5);
  const call = (d.gateway.sendEvent as ReturnType<typeof mock>).mock.calls[0];
  expect(call?.[1]).toBe(MSG.terminalInput);
  expect(call?.[2]).toMatchObject({
    attachmentId: "att-9",
    generation: "g9",
  });
  expect(typeof (call?.[2] as { viewerId: string }).viewerId).toBe("string");
});

test("sendToAttachment drops stale viewer/attachment pairs; resource-exit fans out only bound sockets", () => {
  const gw = new WebGateway();
  const a = new FakeSocket();
  const b = new FakeSocket();
  const viewerA = gw.register("a1", a as never);
  gw.register("a1", b as never);
  gw.bindAttachment({ socket: a as never, attachmentId: "att-a", terminalId: "term", instanceId: "i1" });
  gw.bindAttachment({ socket: b as never, attachmentId: "att-b", terminalId: "term", instanceId: "i1" });

  expect(gw.sendToAttachment(viewerA, "att-a", {
    kind: "terminal-bytes",
    instanceId: "i1",
    attachmentId: "att-a",
    generation: "g",
    epoch: 1,
    sequence: 0,
    dataBase64: "YQ==",
  })).toBe(true);
  expect(gw.sendToAttachment("wrong-viewer", "att-a", {
    kind: "terminal-bytes",
    instanceId: "i1",
    attachmentId: "att-a",
    generation: "g",
    epoch: 1,
    sequence: 1,
    dataBase64: "YQ==",
  })).toBe(false);

  handleConnectorTerminalEvent(gw, "i1", MSG.terminalResourceExit, {
    terminalId: "term",
    generation: "g",
    reason: "exited",
  });
  expect(a.sent.some((s) => {
    const d = decodeEnvelope(s);
    return d.ok && parseWebServerEvent(d.envelope)?.kind === "terminal-exit";
  })).toBe(true);
  expect(b.sent.some((s) => {
    const d = decodeEnvelope(s);
    return d.ok && parseWebServerEvent(d.envelope)?.kind === "terminal-exit";
  })).toBe(true);
  expect(gw.getAttachmentBinding("att-a")).toBeUndefined();
  expect(gw.getAttachmentBinding("att-b")).toBeUndefined();
});

test("connector terminal viewer events are validated before hub fanout", () => {
  const gw = new WebGateway();
  const sock = new FakeSocket();
  const viewerId = gw.register("a1", sock as never);
  gw.bindAttachment({
    socket: sock as never,
    attachmentId: "att-a",
    terminalId: "term",
    instanceId: "i1",
  });

  // Oversized / malformed payload must be dropped at the trust boundary.
  const before = sock.sent.length;
  handleConnectorTerminalEvent(gw, "i1", MSG.terminalViewerEvent, {
    viewerId,
    attachmentId: "att-a",
    event: {
      kind: "terminal-bytes",
      generation: "g",
      epoch: 1,
      sequence: 0,
      dataBase64: "!!!not-base64!!!",
    },
  });
  expect(sock.sent.length).toBe(before);

  handleConnectorTerminalEvent(gw, "i1", MSG.terminalViewerEvent, {
    viewerId,
    attachmentId: "att-a",
    event: {
      kind: "terminal-bytes",
      generation: "g",
      epoch: 1,
      sequence: 0,
      dataBase64: Buffer.from("ok").toString("base64"),
    },
  });
  expect(sock.sent.length).toBeGreaterThan(before);
});

test("socket close clears attachments and notifies detach handler", () => {
  const detached: Array<{ attachmentId: string; viewerId: string }> = [];
  const gw = new WebGateway({
    onAttachmentDetached: (info) => detached.push(info),
  });
  const sock = new FakeSocket();
  const viewerId = gw.register("a1", sock as never);
  gw.bindAttachment({
    socket: sock as never,
    attachmentId: "att-z",
    terminalId: "tz",
    instanceId: "i1",
  });
  sock.close();
  expect(gw.getAttachmentBinding("att-z")).toBeUndefined();
  expect(detached).toEqual([{ attachmentId: "att-z", viewerId, instanceId: "i1" }]);
});

test("a subscribe frame filters ownership and installs the subscription", () => {
  const d = deps(true);
  handleWebClientMessage(d as never, "a1", d.sock as never, encodeEnvelope(webClientEnvelope({ kind: "subscribe", instanceIds: ["i1", "i2"] })));
  // snapshot send happens; ownership filter drops i2
  expect(d.sock.sent.length).toBe(1);
  const decoded = decodeEnvelope(d.sock.sent[0]!);
  expect(decoded.ok && parseWebServerEvent(decoded.envelope)).toMatchObject({
    kind: "state-snapshot",
    instanceId: "i1",
  });
});

void webEventEnvelope;
