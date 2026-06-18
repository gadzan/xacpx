import { expect, test } from "bun:test";

import { normalizeRelayUrl, parseRelayChannelConfig } from "../../../../packages/channel-relay/src/config";

// ── normalizeRelayUrl ──────────────────────────────────────────────────────────

test("normalizeRelayUrl: empty / whitespace-only → empty string", () => {
  expect(normalizeRelayUrl("")).toBe("");
  expect(normalizeRelayUrl("   ")).toBe("");
});

test("normalizeRelayUrl: ws:// passthrough", () => {
  expect(normalizeRelayUrl("ws://h:8788")).toBe("ws://h:8788");
});

test("normalizeRelayUrl: wss:// passthrough", () => {
  expect(normalizeRelayUrl("wss://relay.example.com")).toBe("wss://relay.example.com");
});

test("normalizeRelayUrl: http:// → ws://", () => {
  expect(normalizeRelayUrl("http://1.2.3.4:8788")).toBe("ws://1.2.3.4:8788");
});

test("normalizeRelayUrl: https:// → wss://", () => {
  expect(normalizeRelayUrl("https://relay.example.com")).toBe("wss://relay.example.com");
});

test("normalizeRelayUrl: bare domain → wss (no port)", () => {
  expect(normalizeRelayUrl("relay.example.com")).toBe("wss://relay.example.com");
});

test("normalizeRelayUrl: IPv4 literal → ws + default port 8788", () => {
  expect(normalizeRelayUrl("1.2.3.4")).toBe("ws://1.2.3.4:8788");
});

test("normalizeRelayUrl: IPv4 with explicit port → ws + that port", () => {
  expect(normalizeRelayUrl("1.2.3.4:8788")).toBe("ws://1.2.3.4:8788");
});

test("normalizeRelayUrl: localhost → ws + default port 8788", () => {
  expect(normalizeRelayUrl("localhost")).toBe("ws://localhost:8788");
});

test("normalizeRelayUrl: localhost with explicit port → ws + that port", () => {
  expect(normalizeRelayUrl("localhost:9000")).toBe("ws://localhost:9000");
});

test("normalizeRelayUrl: domain with explicit port → ws + that port", () => {
  expect(normalizeRelayUrl("relay.example.com:9000")).toBe("ws://relay.example.com:9000");
});

test("normalizeRelayUrl: bracketed IPv6 with port → ws + that port", () => {
  expect(normalizeRelayUrl("[::1]:8788")).toBe("ws://[::1]:8788");
});

test("normalizeRelayUrl: bracketed IPv6 without port → ws + default port 8788", () => {
  expect(normalizeRelayUrl("[::1]")).toBe("ws://[::1]:8788");
});

// ── parseRelayChannelConfig ───────────────────────────────────────────────────

test("parses url, pairingToken, and name", () => {
  expect(parseRelayChannelConfig({ url: "wss://hub.example.com:8788", pairingToken: "tok", name: "pc" })).toEqual({
    url: "wss://hub.example.com:8788",
    pairingToken: "tok",
    name: "pc",
  });
});

test("pairingToken and name are optional; url is required", () => {
  expect(parseRelayChannelConfig({ url: "ws://127.0.0.1:8788" })).toEqual({ url: "ws://127.0.0.1:8788" });
  expect(() => parseRelayChannelConfig({})).toThrow(/url/);
  expect(() => parseRelayChannelConfig(undefined)).toThrow(/url/);
});

test("parseRelayChannelConfig normalizes bare domain to wss://", () => {
  expect(parseRelayChannelConfig({ url: "relay.example.com" })).toEqual({ url: "wss://relay.example.com" });
});

test("parseRelayChannelConfig normalizes IPv4 to ws:// with default port", () => {
  expect(parseRelayChannelConfig({ url: "1.2.3.4" })).toEqual({ url: "ws://1.2.3.4:8788" });
});

test("parseRelayChannelConfig normalizes https:// to wss://", () => {
  expect(parseRelayChannelConfig({ url: "https://relay.example.com" })).toEqual({ url: "wss://relay.example.com" });
});
