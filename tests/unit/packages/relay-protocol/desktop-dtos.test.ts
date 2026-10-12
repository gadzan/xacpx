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
  isDesktopSecurityKind,
  parseControlPayload,
  parseDesktopCredential,
  parseDesktopEventPayload,
  parseDesktopPrepareResult,
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

test("desktop capability constants match the release-gate strings", () => {
  expect(RELAY_CAPABILITIES.desktopRfbV1).toBe("desktop.rfb.v1");
  expect(RELAY_CAPABILITIES.desktopArdAuthV1).toBe("desktop.ard-auth.v1");
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
    "desktop-credentials-required",
    "desktop-credentials-rejected",
    "desktop-permission-denied",
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
    { kind: "desktop-close", instanceId: "i1", requestId: "r1" },
  ];
  for (const m of msgs) expect(parseWebClientMessage(webClientEnvelope(m))).toEqual(m);
});

test("desktop-close takes exactly one target: streamId XOR requestId", () => {
  // Both is ambiguous (which reservation should die?), neither is a no-op.
  expect(parseWebClientMessage(webClientEnvelope({
    kind: "desktop-close", instanceId: "i1", streamId: "s1", requestId: "r1",
  } as never))).toBeNull();
  expect(parseWebClientMessage(webClientEnvelope({
    kind: "desktop-close", instanceId: "i1",
  } as never))).toBeNull();
  // An oversized requestId cannot smuggle a second (long) reservation name.
  expect(parseWebClientMessage(webClientEnvelope({
    kind: "desktop-close", instanceId: "i1", requestId: "r".repeat(129),
  } as never))).toBeNull();
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

test("desktop server events reject unbounded instanceIds", () => {
  // parseWebServerEvent's outer gate already requires an instanceId string;
  // this pins the BOUNDED check on the failure event, so an oversized id cannot
  // ride through on a requestId match alone.
  const failed = {
    kind: "desktop-request-failed",
    requestId: "r1",
    instanceId: "i1",
    code: "desktop-busy",
    message: "another desktop viewer is active",
  };
  expect(parseWebServerEvent(webEventEnvelope(failed as never))).not.toBeNull();
  expect(parseWebServerEvent(webEventEnvelope({ ...failed, instanceId: "" } as never))).toBeNull();
  expect(parseWebServerEvent(webEventEnvelope({ ...failed, instanceId: "i".repeat(200) } as never))).toBeNull();
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

test("parseDesktopCredential caps each field at 63 UTF-8 bytes, not 63 characters", () => {
  expect(parseDesktopCredential({ kind: "ard", username: "dana", password: "密".repeat(21) }))
    .toEqual({ kind: "ard", username: "dana", password: "密".repeat(21) });
  expect(parseDesktopCredential({ kind: "ard", username: "dana", password: "密".repeat(22) })).toBeNull();
  expect(parseDesktopCredential({ kind: "ard", username: "a".repeat(63), password: "secret" }))
    .toEqual({ kind: "ard", username: "a".repeat(63), password: "secret" });
  expect(parseDesktopCredential({ kind: "ard", username: "a".repeat(64), password: "secret" })).toBeNull();
});

test("parseDesktopCredential refuses NUL, empty fields, unknown kinds, and extra keys", () => {
  expect(parseDesktopCredential({ kind: "ard", username: "da\0na", password: "secret" })).toBeNull();
  expect(parseDesktopCredential({ kind: "ard", username: "dana", password: "sec\0ret" })).toBeNull();
  expect(parseDesktopCredential({ kind: "ard", username: "", password: "secret" })).toBeNull();
  expect(parseDesktopCredential({ kind: "ard", username: "dana", password: "" })).toBeNull();
  expect(parseDesktopCredential({ kind: "vnc", username: "dana", password: "secret" })).toBeNull();
  expect(parseDesktopCredential({ kind: "ard", username: "dana", password: "secret", domain: "corp" })).toBeNull();
  expect(parseDesktopCredential(JSON.parse('{"kind":"ard","username":"dana","password":"secret","__proto__":{}}'))).toBeNull();
  expect(parseDesktopCredential(["ard", "dana", "secret"])).toBeNull();
  expect(parseDesktopCredential({ kind: "ard", username: 7, password: "secret" })).toBeNull();
});

test("parseDesktopCredential returns a fresh object, not the input", () => {
  const input = { kind: "ard", username: "dana", password: "secret" };
  const parsed = parseDesktopCredential(input);
  expect(parsed).toEqual({ kind: "ard", username: "dana", password: "secret" });
  input.password = "changed";
  expect(parsed?.password).toBe("secret");
});

test("desktop-open carries a parsed credential and refuses a top-level password", () => {
  expect(parseWebClientMessage(webClientEnvelope({
    kind: "desktop-open", requestId: "r1", instanceId: "i1",
    credential: { kind: "ard", username: "dana", password: "secret" },
  }))).toEqual({
    kind: "desktop-open", requestId: "r1", instanceId: "i1",
    credential: { kind: "ard", username: "dana", password: "secret" },
  });
  expect(parseWebClientMessage(webClientEnvelope({
    kind: "desktop-open", requestId: "r1", instanceId: "i1", password: "secret",
  } as never))).toBeNull();
  expect(parseWebClientMessage(webClientEnvelope({
    kind: "desktop-open", requestId: "r1", instanceId: "i1",
    credential: { kind: "ard", username: "dana", password: "secret", extra: 1 },
  } as never))).toBeNull();
  expect(parseWebClientMessage(webClientEnvelope({
    kind: "desktop-open", requestId: "r1", instanceId: "i1",
    credential: { kind: "ard", username: "dana", password: "密".repeat(22) },
  }))).toBeNull();
});

test("desktop prepare is a closed schema and rebuilds the credential", () => {
  expect(parseControlPayload(MSG.desktopPrepare, {
    streamId: "s1", ticket: "t", expiresAt: 5,
    credential: { kind: "ard", username: "dana", password: "secret" },
  })).toEqual({
    streamId: "s1", ticket: "t", expiresAt: 5,
    credential: { kind: "ard", username: "dana", password: "secret" },
  });
  expect(parseControlPayload(MSG.desktopPrepare, { streamId: "s1", ticket: "t", expiresAt: 5, note: "x" })).toBeNull();
  expect(parseControlPayload(MSG.desktopPrepare, {
    streamId: "s1", ticket: "t", expiresAt: 5,
    credential: { kind: "ard", username: "dana" },
  })).toBeNull();
  expect(parseControlPayload(MSG.desktopPrepare, {
    streamId: "s1", ticket: "t", expiresAt: 5, credential: null,
  })).toBeNull();
});

test("parseDesktopPrepareResult accepts both security kinds and nothing else", () => {
  expect(parseDesktopPrepareResult({ streamId: "s1", security: "ard" })).toEqual({ streamId: "s1", security: "ard" });
  expect(parseDesktopPrepareResult({ streamId: "s1", security: "vnc-auth" })).toEqual({ streamId: "s1", security: "vnc-auth" });
  expect(parseDesktopPrepareResult({ streamId: "s1", security: "none" })).toBeNull();
  expect(parseDesktopPrepareResult({ streamId: "s1", security: "toString" })).toBeNull();
  expect(parseDesktopPrepareResult({ streamId: "", security: "ard" })).toBeNull();
  expect(parseDesktopPrepareResult({ streamId: "s1", security: "ard", credential: {} })).toBeNull();
  expect(parseDesktopPrepareResult(null)).toBeNull();
});

test("isDesktopSecurityKind does not admit prototype keys", () => {
  expect(isDesktopSecurityKind("ard")).toBe(true);
  expect(isDesktopSecurityKind("vnc-auth")).toBe(true);
  expect(isDesktopSecurityKind("constructor")).toBe(false);
  expect(isDesktopSecurityKind(2)).toBe(false);
});

test("desktop-opened round-trips an ard stream", () => {
  const opened: WebServerEvent = {
    kind: "desktop-opened",
    requestId: "r1",
    instanceId: "i1",
    streamId: "s1",
    wsPath: "/desktop/observe?ticket=browser-ticket",
    expiresAt: 1_700_000_000_000,
    security: "ard",
  };
  expect(parseWebServerEvent(webEventEnvelope(opened))).toEqual(opened);
});
