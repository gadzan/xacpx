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

test("strict runtime engine with explicit transport.command throws a diagnostic error", () => {
  expect(() =>
    resolveTransportEngine({ config: { ...baseConfig, command: "/opt/acpx/bin", engine: "runtime" } }),
  ).toThrow(/transport\.engine = "runtime" conflicts with explicit transport\.command/);
});

test("strict runtime engine without command binds runtime", () => {
  expect(resolveTransportEngine({ config: { ...baseConfig, engine: "runtime" } })).toEqual({ engine: "runtime" });
});

test("auto mode stays on cli until the Runtime gates pass", () => {
  const choice = resolveTransportEngine({ config: { ...baseConfig, engine: "auto" } });
  expect(choice.engine).toBe("cli");
});

test("missing engine field defaults to cli (development-phase default)", () => {
  expect(resolveTransportEngine({ config: baseConfig })).toEqual({ engine: "cli" });
});
