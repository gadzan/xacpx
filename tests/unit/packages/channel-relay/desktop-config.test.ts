import { expect, test } from "bun:test";

import {
  parseRelayChannelConfig,
  parseRelayDesktopConfig,
} from "../../../../packages/channel-relay/src/config";

test("desktop defaults: disabled rfb on 5900", () => {
  const config = parseRelayChannelConfig({ url: "wss://hub.example.com" });
  expect(config.desktop).toEqual({
    enabled: false,
    backend: "rfb",
    port: 5900,
    connectTimeoutMs: 1500,
    maxStreams: 1,
  });
  expect(Object.isFrozen(config.desktop)).toBe(true);
  expect(Object.isFrozen(config)).toBe(true);
});

test("desktop accepts explicit port/timeout", () => {
  const config = parseRelayChannelConfig({
    url: "wss://hub.example.com",
    desktop: { enabled: true, port: 5901, connectTimeoutMs: 3000 },
  });
  expect(config.desktop.enabled).toBe(true);
  expect(config.desktop.backend).toBe("rfb");
  expect(config.desktop.port).toBe(5901);
  expect(config.desktop.connectTimeoutMs).toBe(3000);
  expect(config.desktop.maxStreams).toBe(1);
});

test("desktop rejects non-object, bad backend, and out-of-range values", () => {
  expect(() => parseRelayDesktopConfig("rfb")).toThrow(/must be an object/);
  expect(() => parseRelayDesktopConfig({ enabled: "yes" })).toThrow(/enabled/);
  expect(() => parseRelayDesktopConfig({ backend: "rdp" })).toThrow(/backend/);
  expect(() => parseRelayDesktopConfig({ port: 0 })).toThrow(/port/);
  expect(() => parseRelayDesktopConfig({ port: 65536 })).toThrow(/port/);
  expect(() => parseRelayDesktopConfig({ connectTimeoutMs: 100 })).toThrow(/connectTimeoutMs/);
  expect(() => parseRelayDesktopConfig({ connectTimeoutMs: 20000 })).toThrow(/connectTimeoutMs/);
  expect(() => parseRelayDesktopConfig({ maxStreams: 2 })).toThrow(/maxStreams/);
});

test("desktop target host is fixed loopback: host keys rejected", () => {
  for (const raw of [{ host: "10.0.0.5" }, { hostname: "vnc.internal" }, { target: "127.0.0.1:5900" }]) {
    expect(() => parseRelayDesktopConfig(raw)).toThrow(/127\.0\.0\.1/);
    expect(() => parseRelayChannelConfig({ url: "wss://h", desktop: raw })).toThrow(/127\.0\.0\.1/);
  }
});
