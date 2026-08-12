import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  diagnoseRelayTerminal,
  redactPathForDoctor,
} from "../../../../packages/channel-relay/src/terminal/terminal-diagnostics";
import { InMemoryRmuxDriver } from "../../../../packages/channel-relay/src/terminal/in-memory-rmux-driver";
import { TerminalRegistryStore } from "../../../../packages/channel-relay/src/terminal/terminal-registry-store";
import { relayCliProvider } from "../../../../packages/channel-relay/src/relay-provider";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

test("diagnose skips when terminal is disabled", async () => {
  const findings = await diagnoseRelayTerminal({ options: {} });
  expect(findings).toEqual([
    expect.objectContaining({ level: "skip", code: "terminal-disabled" }),
  ]);
});

test("diagnose reports healthy empty registry with fake sidecar warn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "term-diag-"));
  dirs.push(dir);
  const findings = await diagnoseRelayTerminal({
    options: { terminal: { enabled: true } },
    registryDir: dir,
    createDriver: () => new InMemoryRmuxDriver(),
  });
  expect(findings.some((f) => f.code === "terminal-sidecar-unpacked")).toBe(true);
  expect(findings.every((f) => f.level !== "error")).toBe(true);
  const text = JSON.stringify(findings);
  expect(text).not.toContain("credential");
  expect(text).not.toMatch(/\/Users\//);
});

test("diagnose warns on cleanup-pending reaping records and keeps owner identity advice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "term-diag-reap-"));
  dirs.push(dir);
  const registry = new TerminalRegistryStore({ dir });
  await registry.load();
  const snap = registry.getSnapshot();
  await registry.upsertCreating({
    terminalId: "11111111-1111-4111-8111-111111111111",
    logicalSessionId: "22222222-2222-4222-8222-222222222222",
    internalAliasSnapshot: "demo",
    rmuxSessionName: `xacpx-relay-${snap.installationId}-11111111-1111-4111-8111-111111111111`,
    generation: "33333333-3333-4333-8333-333333333333",
    createdAt: new Date().toISOString(),
    lastInputAt: new Date().toISOString(),
  });
  const after = registry.getSnapshot();
  await registry.markReaping("11111111-1111-4111-8111-111111111111", "disabled");

  const findings = await diagnoseRelayTerminal({
    options: { terminal: { enabled: true } },
    registryDir: dir,
    createDriver: () => new InMemoryRmuxDriver(),
  });
  const pending = findings.find((f) => f.code === "terminal-cleanup-pending");
  expect(pending?.level).toBe("warn");
  expect(pending?.suggestion ?? "").toMatch(/registry\/owner|lease/i);
});

test("diagnose fails when configured bridgeCommand path is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "term-diag-miss-"));
  dirs.push(dir);
  const findings = await diagnoseRelayTerminal({
    options: {
      terminal: {
        enabled: true,
        bridgeCommand: "/definitely/missing/xacpx-rmux-bridge",
      },
    },
    registryDir: dir,
    createDriver: () => new InMemoryRmuxDriver(),
  });
  expect(findings.some((f) => f.code === "terminal-artifact-missing" && f.level === "error")).toBe(true);
  expect(JSON.stringify(findings)).not.toContain("/definitely/missing/xacpx-rmux-bridge");
});

test("redactPathForDoctor never echoes HOME prefix", () => {
  const home = process.env.HOME ?? "/tmp";
  expect(redactPathForDoctor(join(home, ".xacpx", "relay"))).toBe("~/.xacpx/relay");
});

test("relayCliProvider.diagnose is wired and skips by default", async () => {
  const config = relayCliProvider.buildDefaultConfig({ url: "ws://h:1", token: "t" });
  const findings = await relayCliProvider.diagnose!(config);
  expect(findings[0]?.code).toBe("terminal-disabled");
});

test("diagnose rejects invalid terminal config", async () => {
  const findings = await diagnoseRelayTerminal({
    options: { terminal: { enabled: true, backend: "pty" } },
  });
  expect(findings[0]).toMatchObject({ level: "error", code: "terminal-config-invalid" });
});
