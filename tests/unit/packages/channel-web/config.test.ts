import { describe, expect, test } from "bun:test";

import { isLoopbackHost, parseWebChannelConfig } from "../../../../packages/channel-web/src/config";
import { hostHeaderAllowed, jsonContentType, originAllowed, tokensMatch } from "../../../../packages/channel-web/src/security";

describe("web channel config", () => {
  test("defaults to the local address", () => {
    expect(parseWebChannelConfig({})).toEqual({ host: "127.0.0.1", port: 7138, terminal: { enabled: true } });
  });

  test("refuses a public address without a token", () => {
    expect(() => parseWebChannelConfig({ host: "0.0.0.0" })).toThrow(/token/);
  });

  test("accepts one reachable address with a token", () => {
    expect(parseWebChannelConfig({ host: "192.168.1.20", token: "secret" }).host).toBe("192.168.1.20");
  });

  test("refuses an address a browser cannot open", () => {
    expect(() => parseWebChannelConfig({ host: "0.0.0.0", token: "secret" })).toThrow(/address/);
  });

  test("leaves the terminal on unless it is turned off", () => {
    expect(parseWebChannelConfig({}).terminal.enabled).toBe(true);
    expect(parseWebChannelConfig({ terminal: { enabled: false } }).terminal.enabled).toBe(false);
  });

  test("refuses a random port", () => {
    expect(() => parseWebChannelConfig({ port: 0 })).toThrow(/port/);
  });

  test("recognizes loopback names", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("10.0.0.8")).toBe(false);
  });
});

describe("local request checks", () => {
  test("accepts the bound host and loopback aliases", () => {
    expect(hostHeaderAllowed("127.0.0.1:7138", "127.0.0.1", 7138)).toBe(true);
    expect(hostHeaderAllowed("localhost:7138", "127.0.0.1", 7138)).toBe(true);
    expect(hostHeaderAllowed("127.0.0.1", "127.0.0.1", 80)).toBe(true);
    expect(originAllowed("http://127.0.0.1", "127.0.0.1", 80)).toBe(true);
    expect(hostHeaderAllowed("evil.example:7138", "127.0.0.1", 7138)).toBe(false);
  });

  test("rejects a foreign page origin", () => {
    expect(originAllowed("http://127.0.0.1:7138", "127.0.0.1", 7138)).toBe(true);
    expect(originAllowed("https://evil.example", "127.0.0.1", 7138)).toBe(false);
    expect(originAllowed(undefined, "127.0.0.1", 7138)).toBe(true);
  });

  test("requires json for changes", () => {
    expect(jsonContentType("application/json; charset=utf-8")).toBe(true);
    expect(jsonContentType("text/plain")).toBe(false);
  });

  test("compares tokens without leaking length through the result", () => {
    expect(tokensMatch("secret", "secret")).toBe(true);
    expect(tokensMatch("secret", "other")).toBe(false);
    expect(tokensMatch("secret", "secret-longer")).toBe(false);
  });
});
