import { expect, test } from "bun:test";

import {
  RELAY_PROTOCOL_VERSION,
  decodeEnvelope,
  encodeEnvelope,
  type RelayEnvelope,
} from "../../../../packages/relay-protocol/src/envelope";

test("encode/decode roundtrips a request envelope", () => {
  const envelope: RelayEnvelope = {
    protocolVersion: RELAY_PROTOCOL_VERSION,
    kind: "req",
    id: "req-1",
    type: "instance.sessions.list",
    payload: { chatKey: "relay:acct-1" },
    requestDeadlineAt: 1_800_000_000_000,
    requestBudgetMs: 105_000,
  };

  const decoded = decodeEnvelope(encodeEnvelope(envelope));
  expect(decoded).toEqual({ ok: true, envelope });
});

test("encode/decode roundtrips a response envelope", () => {
  const envelope: RelayEnvelope = {
    protocolVersion: RELAY_PROTOCOL_VERSION,
    kind: "res",
    id: "res-1",
    type: "instance.sessions.list",
    payload: { sessions: ["a", "b"] },
  };

  const decoded = decodeEnvelope(encodeEnvelope(envelope));
  expect(decoded).toEqual({ ok: true, envelope });
});

test("decode rejects invalid JSON", () => {
  expect(decodeEnvelope("{nope")).toEqual({ ok: false, error: "invalid-json" });
});

test("decode rejects structurally invalid envelopes", () => {
  expect(decodeEnvelope(JSON.stringify({ protocolVersion: 1, kind: "req", type: "x" }))).toEqual({
    ok: false,
    error: "invalid-envelope",
  });
  expect(decodeEnvelope(JSON.stringify({ protocolVersion: 1, kind: "nope", id: "1", type: "x" }))).toEqual({
    ok: false,
    error: "invalid-envelope",
  });
  expect(decodeEnvelope(JSON.stringify({ protocolVersion: 1, kind: "event", type: "" }))).toEqual({
    ok: false,
    error: "invalid-envelope",
  });
  expect(decodeEnvelope(JSON.stringify({ protocolVersion: 1, kind: "req", id: "", type: "x" }))).toEqual({
    ok: false,
    error: "invalid-envelope",
  });
  expect(
    decodeEnvelope(JSON.stringify({ protocolVersion: 1.5, kind: "event", type: "control.sessions-changed" })),
  ).toEqual({
    ok: false,
    error: "invalid-envelope",
  });
  expect(decodeEnvelope(JSON.stringify({
    protocolVersion: 1,
    kind: "req",
    id: "1",
    type: "x",
    requestBudgetMs: 0,
  }))).toEqual({ ok: false, error: "invalid-envelope" });
});

test("decode reports version mismatch with detail", () => {
  const decoded = decodeEnvelope(
    JSON.stringify({ protocolVersion: 999, kind: "event", type: "control.sessions-changed" }),
  );
  expect(decoded.ok).toBe(false);
  if (!decoded.ok) {
    expect(decoded.error).toBe("version-mismatch");
    expect(decoded.detail).toContain("999");
  }
});

test("event envelopes do not require an id", () => {
  const decoded = decodeEnvelope(
    JSON.stringify({ protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: "control.sessions-changed" }),
  );
  expect(decoded.ok).toBe(true);
});
