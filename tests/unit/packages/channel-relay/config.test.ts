import { expect, test } from "bun:test";

import { normalizeRelayUrl, parseRelayChannelConfig } from "../../../../packages/channel-relay/src/config";

const DEFAULT_TERMINAL = {
  enabled: false,
  backend: "rmux" as const,
  idleTimeoutSeconds: 900,
  ownerLeaseTtlSeconds: 90,
  reconcileIntervalSeconds: 30,
  orphanGraceSeconds: 120,
  attachmentTtlSeconds: 45,
  maxSessions: 16,
  maxViewersPerTerminal: 4,
  historyLimit: 10000,
};

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

test("normalizeRelayUrl: IPv4 literal → ws + default port 8787", () => {
  expect(normalizeRelayUrl("1.2.3.4")).toBe("ws://1.2.3.4:8787");
});

test("normalizeRelayUrl: IPv4 with explicit port → ws + that port", () => {
  expect(normalizeRelayUrl("1.2.3.4:8788")).toBe("ws://1.2.3.4:8788");
});

test("normalizeRelayUrl: localhost → ws + default port 8787", () => {
  expect(normalizeRelayUrl("localhost")).toBe("ws://localhost:8787");
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

test("normalizeRelayUrl: bracketed IPv6 without port → ws + default port 8787", () => {
  expect(normalizeRelayUrl("[::1]")).toBe("ws://[::1]:8787");
});

// ── parseRelayChannelConfig ───────────────────────────────────────────────────

test("parses url, pairingToken, and name", () => {
  expect(parseRelayChannelConfig({ url: "wss://hub.example.com:8788", pairingToken: "tok", name: "pc" })).toEqual({
    url: "wss://hub.example.com:8788",
    pairingToken: "tok",
    name: "pc",
    terminal: DEFAULT_TERMINAL,
  });
});

test("pairingToken and name are optional; url is required", () => {
  expect(parseRelayChannelConfig({ url: "ws://127.0.0.1:8788" })).toEqual({
    url: "ws://127.0.0.1:8788",
    terminal: DEFAULT_TERMINAL,
  });
  expect(() => parseRelayChannelConfig({})).toThrow(/url/);
  expect(() => parseRelayChannelConfig(undefined)).toThrow(/url/);
});

test("parseRelayChannelConfig normalizes bare domain to wss://", () => {
  expect(parseRelayChannelConfig({ url: "relay.example.com" })).toEqual({
    url: "wss://relay.example.com",
    terminal: DEFAULT_TERMINAL,
  });
});

test("parseRelayChannelConfig normalizes IPv4 to ws:// with default port", () => {
  expect(parseRelayChannelConfig({ url: "1.2.3.4" })).toEqual({
    url: "ws://1.2.3.4:8787",
    terminal: DEFAULT_TERMINAL,
  });
});

test("parseRelayChannelConfig normalizes https:// to wss://", () => {
  expect(parseRelayChannelConfig({ url: "https://relay.example.com" })).toEqual({
    url: "wss://relay.example.com",
    terminal: DEFAULT_TERMINAL,
  });
});

test("terminal defaults: disabled rmux backend with spec §8.1 ranges", () => {
  const config = parseRelayChannelConfig({ url: "wss://hub.example.com" });
  expect(config.terminal).toEqual(DEFAULT_TERMINAL);
  expect(Object.isFrozen(config.terminal)).toBe(true);
  expect(Object.isFrozen(config)).toBe(true);
});

test("terminal accepts explicit overrides within range", () => {
  const config = parseRelayChannelConfig({
    url: "wss://hub.example.com",
    terminal: {
      enabled: true,
      backend: "rmux",
      bridgeCommand: "/usr/local/bin/xacpx-rmux-bridge",
      rmuxCommand: "/usr/local/bin/rmux",
      idleTimeoutSeconds: 120,
      ownerLeaseTtlSeconds: 60,
      reconcileIntervalSeconds: 10,
      orphanGraceSeconds: 90,
      attachmentTtlSeconds: 30,
      maxSessions: 8,
      maxViewersPerTerminal: 2,
      historyLimit: 1000,
    },
  });
  expect(config.terminal.enabled).toBe(true);
  expect(config.terminal.bridgeCommand).toBe("/usr/local/bin/xacpx-rmux-bridge");
  expect(config.terminal.rmuxCommand).toBe("/usr/local/bin/rmux");
  expect(config.terminal.idleTimeoutSeconds).toBe(120);
  expect(config.terminal.orphanGraceSeconds).toBe(90);
});

test("terminal rejects unknown backend and out-of-range values", () => {
  expect(() => parseRelayChannelConfig({
    url: "wss://h", terminal: { backend: "legacy-pty" },
  })).toThrow(/backend/);
  expect(() => parseRelayChannelConfig({
    url: "wss://h", terminal: { idleTimeoutSeconds: 0 },
  })).toThrow(/idleTimeoutSeconds/);
  expect(() => parseRelayChannelConfig({
    url: "wss://h", terminal: { ownerLeaseTtlSeconds: 10 },
  })).toThrow(/ownerLeaseTtlSeconds/);
  expect(() => parseRelayChannelConfig({
    url: "wss://h", terminal: { ownerLeaseTtlSeconds: 90, orphanGraceSeconds: 60 },
  })).toThrow(/orphanGraceSeconds/);
  expect(() => parseRelayChannelConfig({
    url: "wss://h", terminal: { maxSessions: 0 },
  })).toThrow(/maxSessions/);
});

test("terminal bridge/rmux commands must be non-empty absolute paths", () => {
  expect(() => parseRelayChannelConfig({
    url: "wss://h", terminal: { bridgeCommand: "rmux-bridge" },
  })).toThrow(/bridgeCommand/);
  expect(() => parseRelayChannelConfig({
    url: "wss://h", terminal: { rmuxCommand: "" },
  })).toThrow(/rmuxCommand/);
  expect(() => parseRelayChannelConfig({
    url: "wss://h", terminal: { rmuxCommand: "rmux --flag" },
  })).toThrow(/rmuxCommand/);
});
