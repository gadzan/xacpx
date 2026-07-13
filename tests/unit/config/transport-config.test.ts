import { expect, test } from "bun:test";
import { turnIdleTimeoutSeconds } from "../../../src/config/types";
import type { AppConfig } from "../../../src/config/types";

const base = { transport: { permissionMode: "approve-all", nonInteractivePermissions: "deny" } } as unknown as AppConfig;

test("turnIdleTimeoutSeconds defaults to 600 when unset", () => {
  expect(turnIdleTimeoutSeconds(base)).toBe(600);
});
test("turnIdleTimeoutSeconds returns the configured positive value", () => {
  const c = { transport: { ...base.transport, turnIdleTimeoutSeconds: 300 } } as unknown as AppConfig;
  expect(turnIdleTimeoutSeconds(c)).toBe(300);
});
test("turnIdleTimeoutSeconds treats 0 as disabled (returns 0, NOT the default)", () => {
  const c = { transport: { ...base.transport, turnIdleTimeoutSeconds: 0 } } as unknown as AppConfig;
  expect(turnIdleTimeoutSeconds(c)).toBe(0);
});
test("turnIdleTimeoutSeconds falls back to 600 for a negative value", () => {
  const c = { transport: { ...base.transport, turnIdleTimeoutSeconds: -5 } } as unknown as AppConfig;
  expect(turnIdleTimeoutSeconds(c)).toBe(600);
});
