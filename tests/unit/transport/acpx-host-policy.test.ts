import { expect, test } from "bun:test";

import {
  queueOwnerBaseEnvOption,
  resolveAcpxHostPolicyEnv,
} from "../../../src/transport/acpx-host-policy";

/** Plan B5: unified host ceilings. Unset follows upstream defaults. */
test("empty policy resolves to no env (upstream defaults)", () => {
  expect(resolveAcpxHostPolicyEnv({})).toEqual({});
  expect(resolveAcpxHostPolicyEnv({ acpxMaxIncomingMessageBytes: null, acpxTerminalMaxOutputBytes: null })).toEqual(
    {},
  );
});

test("set ceilings resolve to the acpx host variables", () => {
  expect(
    resolveAcpxHostPolicyEnv({ acpxMaxIncomingMessageBytes: 8 * 1024 * 1024, acpxTerminalMaxOutputBytes: 0 }),
  ).toEqual({
    ACPX_MAX_ACP_MESSAGE_BYTES: String(8 * 1024 * 1024),
    ACPX_TERMINAL_MAX_OUTPUT_BYTES: "0",
  });
});

test("invalid ceilings throw fail-closed (never silently widen)", () => {
  expect(() => resolveAcpxHostPolicyEnv({ acpxMaxIncomingMessageBytes: -1 })).toThrow();
  expect(() => resolveAcpxHostPolicyEnv({ acpxMaxIncomingMessageBytes: 1.5 })).toThrow();
  expect(() => resolveAcpxHostPolicyEnv({ acpxTerminalMaxOutputBytes: Number.NaN })).toThrow();
  expect(() =>
    resolveAcpxHostPolicyEnv({ acpxMaxIncomingMessageBytes: "big" as unknown as number }),
  ).toThrow();
});

test("queueOwnerBaseEnvOption keeps the launcher default when unset", () => {
  expect(queueOwnerBaseEnvOption({})).toEqual({});
});

test("queueOwnerBaseEnvOption layers policy over the given base", () => {
  const out = queueOwnerBaseEnvOption(
    { acpxMaxIncomingMessageBytes: 1024 },
    { PATH: "/bin", ACPX_MAX_ACP_MESSAGE_BYTES: "1" },
  );
  expect(out).toEqual({ baseEnv: { PATH: "/bin", ACPX_MAX_ACP_MESSAGE_BYTES: "1024" } });
});

test("host policy never uses the agent-child overlay name", () => {
  // Regression guard for the B1/B5 boundary: these are HOST process values
  // (embedding client / TerminalManager), not agentProcessEnv children.
  const out = queueOwnerBaseEnvOption({ acpxMaxIncomingMessageBytes: 1024 }, {});
  expect("agentProcessEnv" in out).toBe(false);
  expect(JSON.stringify(resolveAcpxHostPolicyEnv({ acpxMaxIncomingMessageBytes: 1024 }))).not.toContain(
    "agentProcessEnv",
  );
});
