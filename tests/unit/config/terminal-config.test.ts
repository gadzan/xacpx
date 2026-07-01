import { test, expect } from "bun:test";
import { parseConfig } from "../../../src/config/load-config";
import { terminalEnabled, terminalIdleTimeoutSeconds } from "../../../src/config/types";

const base = { transport: { permissionMode: "approve-all", nonInteractivePermissions: "deny" }, agents: {}, workspaces: {} };

test("terminal defaults to disabled when absent", () => {
  const cfg = parseConfig({ ...base });
  expect(cfg.terminal).toBeUndefined();
  expect(terminalEnabled(cfg)).toBe(false);
  expect(terminalIdleTimeoutSeconds(cfg)).toBe(900);
});

test("terminal.enabled parses true and custom idle timeout", () => {
  const cfg = parseConfig({ ...base, terminal: { enabled: true, idleTimeoutSeconds: 120 } });
  expect(cfg.terminal).toEqual({ enabled: true, idleTimeoutSeconds: 120 });
  expect(terminalEnabled(cfg)).toBe(true);
  expect(terminalIdleTimeoutSeconds(cfg)).toBe(120);
});

test("terminal.enabled false keeps helper false", () => {
  const cfg = parseConfig({ ...base, terminal: { enabled: false } });
  expect(terminalEnabled(cfg)).toBe(false);
  expect(terminalIdleTimeoutSeconds(cfg)).toBe(900);
});
