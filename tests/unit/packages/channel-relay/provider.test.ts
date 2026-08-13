import { expect, test } from "bun:test";

import { relayCliProvider } from "../../../../packages/channel-relay/src/relay-provider";

test("parseAddArgs accepts --url/--token/--name and rejects unknown flags", () => {
  const parsed = relayCliProvider.parseAddArgs(["--url", "wss://h:8788", "--token", "tok", "--name", "pc"]);
  expect(parsed).toEqual({ ok: true, input: { url: "wss://h:8788", token: "tok", name: "pc" } });
  expect(relayCliProvider.parseAddArgs(["--bogus", "x"]).ok).toBe(false);
  expect(relayCliProvider.parseAddArgs(["--url"]).ok).toBe(false);
});

test("buildDefaultConfig/validateConfig enforce url and required token", () => {
  const config = relayCliProvider.buildDefaultConfig({ url: "ws://h:8788", token: "tok", name: "pc" });
  expect(config).toEqual({
    id: "relay", type: "relay", enabled: true,
    options: { url: "ws://h:8788", pairingToken: "tok", name: "pc" },
  });
  expect(relayCliProvider.validateConfig(config)).toEqual([]);
  expect(relayCliProvider.validateConfig(relayCliProvider.buildDefaultConfig({ token: "tok" }))).toContainEqual(
    expect.objectContaining({ kind: "missing-required-field", flag: "--url" }),
  );
  expect(relayCliProvider.validateConfig(relayCliProvider.buildDefaultConfig({ url: "ws://h", }))).toContainEqual(
    expect.objectContaining({ kind: "missing-required-field", flag: "--token" }),
  );
  // https:// is now normalized to wss:// — no longer invalid
  expect(relayCliProvider.validateConfig(relayCliProvider.buildDefaultConfig({ url: "https://h", token: "t" }))).toEqual([]);
});

test("buildDefaultConfig normalizes bare domain to wss://", () => {
  const config = relayCliProvider.buildDefaultConfig({ url: "relay.example.com", token: "t" });
  expect(config.options?.url).toBe("wss://relay.example.com");
  expect(relayCliProvider.validateConfig(config)).toEqual([]);
});

test("buildDefaultConfig normalizes IPv4 to ws:// with default port 8787 (merged gateway)", () => {
  const config = relayCliProvider.buildDefaultConfig({ url: "1.2.3.4", token: "t" });
  expect(config.options?.url).toBe("ws://1.2.3.4:8787");
  expect(relayCliProvider.validateConfig(config)).toEqual([]);
});

test("validateConfig accepts a config built from a bare domain (no ws:// issue)", () => {
  // Simulate a hand-edited config.json with a bare domain
  const config = {
    id: "relay", type: "relay", enabled: true,
    options: { url: "relay.example.com", pairingToken: "tok" },
  };
  expect(relayCliProvider.validateConfig(config)).toEqual([]);
});

test("renderSummary masks the pairing token", () => {
  const config = relayCliProvider.buildDefaultConfig({ url: "ws://h:8788", token: "very-secret-token" });
  const summary = relayCliProvider.renderSummary(config).join("\n");
  expect(summary).toContain("ws://h:8788");
  expect(summary).not.toContain("very-secret-token");
});

test("buildDefaultConfig does not enable terminal by default", () => {
  const config = relayCliProvider.buildDefaultConfig({ url: "ws://h:8788", token: "tok" });
  expect(config.options?.terminal).toBeUndefined();
});

test("renderSummary shows terminal backend/enabled/TTL/quota without command paths", () => {
  const config = {
    id: "relay",
    type: "relay",
    enabled: true,
    options: {
      url: "wss://hub.example.com",
      pairingToken: "secret-token",
      terminal: {
        enabled: true,
        backend: "rmux",
        bridgeCommand: "/secret/path/bridge",
        idleTimeoutSeconds: 900,
        ownerLeaseTtlSeconds: 90,
        maxSessions: 16,
        maxViewersPerTerminal: 4,
      },
    },
  };
  const summary = relayCliProvider.renderSummary(config).join("\n");
  expect(summary).toContain("terminal: enabled");
  expect(summary).toContain("backend=rmux");
  expect(summary).toContain("idle=900s");
  expect(summary).toContain("lease=90s");
  expect(summary).toContain("maxSessions=16");
  expect(summary).toContain("maxViewers=4");
  expect(summary).not.toContain("/secret/path/bridge");
  expect(summary).not.toContain("secret-token");
});

test("validateConfig rejects invalid terminal options", () => {
  const issues = relayCliProvider.validateConfig({
    id: "relay",
    type: "relay",
    enabled: true,
    options: {
      url: "wss://hub.example.com",
      pairingToken: "tok",
      terminal: { backend: "pty", ownerLeaseTtlSeconds: 90, orphanGraceSeconds: 30 },
    },
  });
  expect(issues.some((i) => i.kind === "invalid-config")).toBe(true);
});
