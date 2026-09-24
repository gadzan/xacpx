import { test, expect } from "bun:test";
import {
  DESKTOP_BUFFERED_HARD_CLOSE_BYTES,
  DESKTOP_BUFFERED_SOFT_PAUSE_BYTES,
  DESKTOP_HUB_REQUEST_TIMEOUT_MS,
  DESKTOP_RPC_TIMEOUT_MS,
  DESKTOP_TICKET_TTL_MS,
  DESKTOP_TCP_CHUNK_BYTES,
  DESKTOP_WS_MAX_PAYLOAD_BYTES,
  DESKTOP_MAX_STREAMS_PER_ACCOUNT,
  DESKTOP_MAX_STREAMS_PER_INSTANCE,
  MAX_DESKTOP_REQUEST_ID_LENGTH,
  MAX_DESKTOP_STREAM_ID_LENGTH,
  MAX_DESKTOP_TICKET_LENGTH,
  MAX_DESKTOP_WS_PATH_LENGTH,
  MSG,
  RELAY_CAPABILITIES,
  DESKTOP_ERROR_CODES,
  parseControlPayload,
  parseDesktopEventPayload,
  parseWebClientMessage,
  parseWebServerEvent,
  webClientEnvelope,
  webEventEnvelope,
  type DesktopCancelPayload,
  type DesktopErrorCode,
  type DesktopPreparePayload,
  type DesktopPrepareResult,
  type WebClientMessage,
  type WebServerEvent,
} from "../../../../packages/relay-protocol/src/index";

test("desktop MSG types live in the instance.desktop namespace", () => {
  expect(MSG.desktopPrepare).toBe("instance.desktop.prepare");
  expect(MSG.desktopCancel).toBe("instance.desktop.cancel");
  const values = Object.values(MSG);
  expect(new Set(values).size).toBe(values.length);
});

test("desktop capability constant matches the release-gate string", () => {
  expect(RELAY_CAPABILITIES.desktopRfbV1).toBe("desktop.rfb.v1");
});

test("stable desktop error codes are fixed", () => {
  const expected: DesktopErrorCode[] = [
    "desktop-disabled",
    "desktop-busy",
    "desktop-rfb-unavailable",
    "desktop-not-rfb",
    "desktop-auth-unsupported",
    "desktop-stream-timeout",
    "desktop-instance-offline",
    "desktop-protocol-error",
  ];
  expect([...DESKTOP_ERROR_CODES]).toEqual(expected);
});

test("desktop hard limits match the wire contract", () => {
  expect(MAX_DESKTOP_REQUEST_ID_LENGTH).toBe(128);
  expect(MAX_DESKTOP_STREAM_ID_LENGTH).toBe(128);
  expect(MAX_DESKTOP_TICKET_LENGTH).toBe(128);
  expect(MAX_DESKTOP_WS_PATH_LENGTH).toBe(512);
  expect(DESKTOP_TICKET_TTL_MS).toBe(60_000);
  expect(DESKTOP_HUB_REQUEST_TIMEOUT_MS).toBe(10_000);
  expect(DESKTOP_RPC_TIMEOUT_MS).toBe(15_000);
  expect(DESKTOP_RPC_TIMEOUT_MS).toBeGreaterThan(DESKTOP_HUB_REQUEST_TIMEOUT_MS);
  expect(DESKTOP_MAX_STREAMS_PER_INSTANCE).toBe(1);
  expect(DESKTOP_MAX_STREAMS_PER_ACCOUNT).toBe(8);
  expect(DESKTOP_WS_MAX_PAYLOAD_BYTES).toBe(1 * 1024 * 1024);
  expect(DESKTOP_TCP_CHUNK_BYTES).toBe(64 * 1024);
  expect(DESKTOP_BUFFERED_SOFT_PAUSE_BYTES).toBe(2 * 1024 * 1024);
  expect(DESKTOP_BUFFERED_HARD_CLOSE_BYTES).toBe(4 * 1024 * 1024);
  expect(DESKTOP_BUFFERED_HARD_CLOSE_BYTES).toBeGreaterThan(DESKTOP_BUFFERED_SOFT_PAUSE_BYTES);
});

test("prepare/result DTOs compile with the locked shapes (stream metadata only)", () => {
  const payload: DesktopPreparePayload = { streamId: "s1", ticket: "t-connector", expiresAt: 1_700_000_000_000 };
  const result: DesktopPrepareResult = { streamId: "s1", security: "vnc-auth" };
  const cancel: DesktopCancelPayload = { streamId: "s1" };
  expect(payload.streamId).toBe("s1");
  expect(result.security).toBe("vnc-auth");
  expect(cancel.streamId).toBe("s1");
  // Protocol carries stream metadata only: no host/port/target/framebuffer fields.
  expect("host" in payload).toBe(false);
  expect("port" in payload).toBe(false);
  expect("target" in payload).toBe(false);
  expect("dataBase64" in payload).toBe(false);
  expect("framebuffer" in payload).toBe(false);
});

test("parseControlPayload validates desktop prepare and rejects hub-chosen targets", () => {
  const good = parseControlPayload(MSG.desktopPrepare, {
    streamId: "s1",
    ticket: "t-connector",
    expiresAt: Date.now() + 60_000,
  });
  expect(good?.streamId).toBe("s1");
  // A hub-supplied host/port/target must fail closed: the connector only dials
  // its own frozen loopback config, so prepare can never become a TCP proxy.
  expect(parseControlPayload(MSG.desktopPrepare, { streamId: "s1", ticket: "t", expiresAt: 1, host: "10.0.0.1" })).toBeNull();
  expect(parseControlPayload(MSG.desktopPrepare, { streamId: "s1", ticket: "t", expiresAt: 1, port: 5901 })).toBeNull();
  expect(parseControlPayload(MSG.desktopPrepare, { streamId: "s1", ticket: "t", expiresAt: 1, target: "x" })).toBeNull();
  expect(parseControlPayload(MSG.desktopPrepare, { streamId: "", ticket: "t", expiresAt: 1 })).toBeNull();
  expect(parseControlPayload(MSG.desktopPrepare, { streamId: "s1", ticket: "", expiresAt: 1 })).toBeNull();
  expect(parseControlPayload(MSG.desktopPrepare, { streamId: "s1", ticket: "t", expiresAt: -1 })).toBeNull();
  expect(parseControlPayload(MSG.desktopPrepare, { streamId: "s1" })).toBeNull();
});

test("parseDesktopEventPayload validates desktop cancel", () => {
  expect(parseDesktopEventPayload(MSG.desktopCancel, { streamId: "s1" })?.streamId).toBe("s1");
  expect(parseDesktopEventPayload(MSG.desktopCancel, { streamId: "" })).toBeNull();
  expect(parseDesktopEventPayload(MSG.desktopCancel, {})).toBeNull();
});

test("parseWebClientMessage round-trips desktop open/close", () => {
  const msgs: WebClientMessage[] = [
    { kind: "desktop-open", requestId: "r1", instanceId: "i1" },
    { kind: "desktop-close", instanceId: "i1", streamId: "s1" },
  ];
  for (const m of msgs) expect(parseWebClientMessage(webClientEnvelope(m))).toEqual(m);
});

test("parseWebClientMessage rejects desktop forgeries and oversized ids", () => {
  // Browser must not stamp stream identity or the binary path: the hub mints both.
  expect(parseWebClientMessage(webClientEnvelope({
    kind: "desktop-open", requestId: "r1", instanceId: "i1", streamId: "s1",
  } as never))).toBeNull();
  expect(parseWebClientMessage(webClientEnvelope({
    kind: "desktop-open", requestId: "r1", instanceId: "i1", wsPath: "/desktop/observe?ticket=x",
  } as never))).toBeNull();
  expect(parseWebClientMessage(webClientEnvelope({
    kind: "desktop-open", requestId: "", instanceId: "i1",
  }))).toBeNull();
  expect(parseWebClientMessage(webClientEnvelope({
    kind: "desktop-open", requestId: "r1", instanceId: "",
  }))).toBeNull();
  expect(parseWebClientMessage(webClientEnvelope({
    kind: "desktop-open", requestId: "r".repeat(129), instanceId: "i1",
  }))).toBeNull();
  expect(parseWebClientMessage(webClientEnvelope({
    kind: "desktop-close", instanceId: "i1", streamId: "",
  }))).toBeNull();
  expect(parseWebClientMessage(webClientEnvelope({
    kind: "desktop-close", instanceId: "i1", streamId: "s".repeat(129),
  }))).toBeNull();
});

test("desktop server events round-trip", () => {
  const events: WebServerEvent[] = [
    {
      kind: "desktop-opened",
      requestId: "r1",
      instanceId: "i1",
      streamId: "s1",
      wsPath: "/desktop/observe?ticket=browser-ticket",
      expiresAt: 1_700_000_000_000,
      security: "vnc-auth",
    },
    {
      kind: "desktop-request-failed",
      requestId: "r1",
      instanceId: "i1",
      code: "desktop-busy",
      message: "another viewer is active",
    },
  ];
  for (const event of events) {
    expect(parseWebServerEvent(webEventEnvelope(event))).toEqual(event);
  }
});

test("desktop server events reject bad paths, tickets-in-disguise, and oversized fields", () => {
  const opened = {
    kind: "desktop-opened",
    requestId: "r1",
    instanceId: "i1",
    streamId: "s1",
    wsPath: "/desktop/observe?ticket=browser-ticket",
    expiresAt: 1_700_000_000_000,
    security: "vnc-auth",
  } as const;
  expect(parseWebServerEvent(webEventEnvelope({ ...opened, wsPath: "/ws" }))).toBeNull();
  expect(parseWebServerEvent(webEventEnvelope({ ...opened, wsPath: "" }))).toBeNull();
  expect(parseWebServerEvent(webEventEnvelope({ ...opened, security: "none" }))).toBeNull();
  expect(parseWebServerEvent(webEventEnvelope({ ...opened, streamId: "" }))).toBeNull();
  expect(parseWebServerEvent(webEventEnvelope({ ...opened, expiresAt: -1 }))).toBeNull();
  expect(parseWebServerEvent(webEventEnvelope({ ...opened, requestId: "r".repeat(129) }))).toBeNull();
  expect(parseWebServerEvent(webEventEnvelope({
    kind: "desktop-request-failed",
    requestId: "r1",
    instanceId: "i1",
    code: "desktop-busy",
    message: "x".repeat(513),
  }))).toBeNull();
  // Unknown desktop kinds fail closed.
  expect(parseWebServerEvent(webEventEnvelope({ kind: "desktop-bytes", instanceId: "i1" } as never))).toBeNull();
});
