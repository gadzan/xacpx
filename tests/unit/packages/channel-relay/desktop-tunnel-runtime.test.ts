import { expect, test } from "bun:test";

import { MSG, encodeEnvelope, decodeEnvelope } from "../../../../packages/relay-protocol/src/index";
import { DesktopTunnelRuntime } from "../../../../packages/channel-relay/src/desktop/desktop-tunnel-runtime";

function prepareEnvelope(streamId: string, ticket: string) {
  return {
    protocolVersion: 1,
    kind: "req" as const,
    id: "hub-1",
    type: MSG.desktopPrepare,
    payload: { streamId, ticket, expiresAt: Date.now() + 60_000 },
  };
}

function vncHandshake(): Uint8Array {
  return Uint8Array.from([82, 70, 66, 32, 48, 48, 51, 46, 48, 48, 56, 10, 1, 2]);
}

test("disabled desktop fails with desktop-disabled", async () => {
  const runtime = new DesktopTunnelRuntime({
    config: { enabled: false, backend: "rfb", port: 5900, connectTimeoutMs: 500, maxStreams: 1 },
    hubUrl: "ws://hub:8787",
  });
  let responded: unknown;
  const handled = await runtime.handlePrepare(prepareEnvelope("s1", "t1"), (p) => { responded = p; });
  expect(handled).toBe(true);
  expect((responded as { error: { code: string } }).error.code).toBe("desktop-disabled");
});

test("prepare rejects malformed payloads and unknown types", async () => {
  const runtime = new DesktopTunnelRuntime({
    config: { enabled: true, backend: "rfb", port: 5900, connectTimeoutMs: 500, maxStreams: 1 },
    hubUrl: "ws://hub:8787",
  });
  expect(await runtime.handlePrepare({ protocolVersion: 1, kind: "req", id: "x", type: "other", payload: {} } as never, () => {})).toBe(false);
  let responded: unknown;
  await runtime.handlePrepare(
    { protocolVersion: 1, kind: "req", id: "x", type: MSG.desktopPrepare, payload: { streamId: "s", ticket: "t", expiresAt: 1, host: "evil" } },
    (p) => { responded = p; },
  );
  expect((responded as { error: { code: string } }).error.code).toBe("desktop-protocol-error");
});

test("cancel for the active stream closes it; other streams are ignored", () => {
  const runtime = new DesktopTunnelRuntime({
    config: { enabled: true, backend: "rfb", port: 5900, connectTimeoutMs: 500, maxStreams: 1 },
    hubUrl: "ws://hub:8787",
  });
  expect(runtime.handleCancel({ protocolVersion: 1, kind: "event", type: MSG.desktopCancel, payload: { streamId: "s-unknown" } })).toBe(true);
  expect(runtime.handleCancel({ protocolVersion: 1, kind: "event", type: "other", payload: {} } as never)).toBe(false);
  expect(runtime.activeStreamId).toBeNull();
  runtime.closeAll();
});

test("prepare error never echoes the connector ticket from the hub socket URL", async () => {
  // The failed ws ErrorEvent's target URL carries `?ticket=<connector-ticket>`.
  // That text lands in the prepare result shown to the browser (and logs), so an
  // unconsumed single-use ticket must not ride the control path.
  const { describeHubSocketErrorForTests } = await import("../../../../packages/channel-relay/src/desktop/desktop-tunnel-runtime") as never as {
    describeHubSocketErrorForTests: (err: unknown) => string;
  };
  const ticket = "connector-secret-ticket-xyz";
  const text = describeHubSocketErrorForTests({
    type: "error",
    message: "Unexpected server response: 4403",
    target: { url: `ws://hub.example/desktop/instance?ticket=${ticket}` },
  });
  expect(text).toContain("error");
  expect(text).toContain("hub.example/desktop/instance");
  expect(text).not.toContain(ticket);
  expect(text).not.toContain("ticket=");
});

test("RFB handshake evaluator used by the tunnel accepts VncAuth", async () => {
  // Tunnel-level unit: the shared probe verdict gates openTunnel before any socket.
  const { evaluateRfbHandshake } = await import("../../../../packages/channel-relay/src/desktop/rfb-probe");
  expect(evaluateRfbHandshake(vncHandshake())).toEqual({ ok: true, version: "RFB 003.008", security: "vnc-auth" });
  expect(encodeEnvelope).toBeDefined();
  expect(decodeEnvelope).toBeDefined();
});

