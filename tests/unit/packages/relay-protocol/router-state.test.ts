// tests/unit/packages/relay-protocol/router-state.test.ts
import { expect, test } from "bun:test";
import {
  ROUTER_CONFIG_PATH,
  parseConversationRouterState,
  parseRouterAvailability,
} from "../../../../packages/relay-protocol/src/index";

const READY = { status: "ready", configPath: ROUTER_CONFIG_PATH };
const CONFIG = { enabled: true };

test("every availability shape pairs with a config into one state", () => {
  const availabilities = [
    { status: "ready", configPath: ROUTER_CONFIG_PATH },
    { status: "disabled-by-config", configPath: ROUTER_CONFIG_PATH, reason: { code: "disabled", message: "off" } },
    { status: "unsupported", configPath: ROUTER_CONFIG_PATH, reason: { code: "not-advertised", message: "no router" } },
    { status: "unsupported", configPath: ROUTER_CONFIG_PATH, reason: { code: "restriction-unproven", message: "no proof" } },
    { status: "failed", configPath: ROUTER_CONFIG_PATH, reason: { code: "command-missing", message: "nothing configured" } },
    { status: "failed", configPath: ROUTER_CONFIG_PATH, reason: { code: "auth-missing", message: "no token" } },
    { status: "failed", configPath: ROUTER_CONFIG_PATH, reason: { code: "probe-failed", message: "spawn failed" } },
    { status: "failed", configPath: ROUTER_CONFIG_PATH, reason: { code: "probe-timeout", message: "too slow" } },
    { status: "failed", configPath: ROUTER_CONFIG_PATH, reason: { code: "malformed-capabilities", message: "bad caps" } },
    { status: "failed", configPath: ROUTER_CONFIG_PATH, reason: { code: "read-failed", message: "unreadable" } },
  ];
  for (const availability of availabilities) {
    const state = parseConversationRouterState({ availability, config: CONFIG });
    expect(state.availability).toEqual(parseRouterAvailability(availability));
    expect(state.config).toEqual({ enabled: true });
  }
});

test("a full state carries the availability and the configured command and authEnv", () => {
  const availability = { status: "failed", configPath: ROUTER_CONFIG_PATH, reason: { code: "probe-failed", message: "spawn failed" } };
  const config = { enabled: true, command: "/usr/bin/router", authEnv: "ROUTER_TOKEN" };
  expect(parseConversationRouterState({ availability, config })).toEqual({ availability, config });
});

test("an unset command or authEnv stays absent, never empty", () => {
  const state = parseConversationRouterState({ availability: READY, config: CONFIG });
  expect(Object.keys(state.config)).toEqual(["enabled"]);
  expect("command" in state.config).toBe(false);
  expect("authEnv" in state.config).toBe(false);
  const partial = parseConversationRouterState({ availability: READY, config: { enabled: false, command: "/usr/bin/router" } });
  expect(Object.keys(partial.config)).toEqual(["enabled", "command"]);
  expect("authEnv" in partial.config).toBe(false);
  expect(partial.config).toEqual({ enabled: false, command: "/usr/bin/router" });
});

test("a malformed router state is rejected", () => {
  for (const bad of [
    null,
    "on",
    [],
    {},
    { availability: READY },
    { config: CONFIG },
    { availability: READY, config: { enabled: "true" } },
    { availability: READY, config: { enabled: null } },
    { availability: READY, config: {} },
    { availability: READY, config: { enabled: true, extra: 1 } },
    { availability: READY, config: { enabled: true, command: 5 } },
    { availability: READY, config: { enabled: true, authEnv: 5 } },
    { availability: READY, config: { enabled: true, command: null } },
    { availability: READY, config: { enabled: true, authEnv: null } },
    { availability: READY, config: CONFIG, extra: 1 },
  ]) {
    expect(() => parseConversationRouterState(bad)).toThrow();
  }
});

test("every availability parseRouterAvailability rejects is rejected inside the state", () => {
  for (const availability of [
    undefined,
    null,
    {},
    { status: "ready" },
    { configPath: ROUTER_CONFIG_PATH },
    { status: "ready", configPath: "conversations.router", reason: { code: "disabled", message: "ready has no reason" } },
    { status: "ready", configPath: ROUTER_CONFIG_PATH, extra: 1 },
    { status: "failed", configPath: ROUTER_CONFIG_PATH, reason: { code: "disabled", message: "wrong code for this status" } },
    { status: "disabled-by-config", configPath: ROUTER_CONFIG_PATH, reason: { code: "command-missing", message: "wrong code for this status" } },
    { status: "unsupported", configPath: ROUTER_CONFIG_PATH, reason: { code: "disabled", message: "wrong code for this status" } },
    { status: "failed", configPath: ROUTER_CONFIG_PATH, reason: { code: "probe-failed", message: "" } },
    { status: "failed", configPath: ROUTER_CONFIG_PATH, reason: { code: "probe-failed" } },
    { status: "failed", configPath: ROUTER_CONFIG_PATH, reason: { code: "probe-failed", message: "m", extra: 1 } },
    { status: "unknown", configPath: ROUTER_CONFIG_PATH, reason: { code: "probe-failed", message: "m" } },
  ]) {
    expect(() => parseRouterAvailability(availability)).toThrow();
    expect(() => parseConversationRouterState({ availability, config: CONFIG })).toThrow();
  }
});
