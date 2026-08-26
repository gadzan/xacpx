import { expect, test } from "bun:test";

import { resolveTransportEngine } from "../../../src/sessions/transport-engine";

const baseConfig = { type: "acpx-bridge" as const };

test("persisted binding wins over config for existing sessions", () => {
  expect(resolveTransportEngine({ config: { ...baseConfig, engine: "cli" }, session: { transport_engine: "runtime" } })).toEqual({
    engine: "runtime",
  });
  expect(resolveTransportEngine({ config: { ...baseConfig, engine: "runtime" }, session: { transport_engine: "cli" } })).toEqual({
    engine: "cli",
  });
});

test("explicit transport.command forces cli and is reported", () => {
  const choice = resolveTransportEngine({ config: { ...baseConfig, command: "/opt/acpx/bin" } });
  expect(choice.engine).toBe("cli");
  expect(choice.reason).toBe("explicit-acpx-command");
});

test("strict runtime engine without runtime support throws instead of silently binding cli", () => {
  expect(() => resolveTransportEngine({ config: { ...baseConfig, engine: "runtime" } })).toThrow(
    /requires acpx Runtime worker support/,
  );
});

test("strict runtime engine binds runtime once runtimeAvailable is true", () => {
  expect(resolveTransportEngine({ config: { ...baseConfig, engine: "runtime" }, runtimeAvailable: true })).toEqual({
    engine: "runtime",
  });
});


test("auto mode stays on cli until the Runtime gates pass", () => {
  const choice = resolveTransportEngine({ config: { ...baseConfig, engine: "auto" } });
  expect(choice.engine).toBe("cli");
});

test("missing engine field defaults to cli (development-phase default)", () => {
  expect(resolveTransportEngine({ config: baseConfig })).toEqual({ engine: "cli" });
});
