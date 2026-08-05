import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { createAdapterReleaseId } from "../../../src/adapters/adapter-catalog";

import {
  resolveAgentCommand,
  resolveConfiguredAgentCommand,
  resolveRuntimeAgentCommand,
} from "../../../src/config/resolve-agent-command";

test("drops the legacy codex shim command so acpx can use the built-in codex alias", () => {
  expect(resolveAgentCommand("codex", "./node_modules/.bin/codex-acp")).toBeUndefined();
});

test("drops the windows codex executable shim command", () => {
  expect(resolveAgentCommand("codex", ".\\node_modules\\.bin\\codex-acp.exe")).toBeUndefined();
});

test("drops a legacy absolute codex node script command", () => {
  expect(
    resolveAgentCommand(
      "codex",
      "node E:/projects/weacpx/node_modules/@zed-industries/codex-acp/bin/codex-acp.js",
    ),
  ).toBeUndefined();
});

test("keeps unrelated commands unchanged", () => {
  expect(resolveAgentCommand("claude", "custom-agent")).toBe("custom-agent");
});

test("runtime resolution pins managed adapters while preserving explicit commands", () => {
  expect(resolveRuntimeAgentCommand("codex", undefined, true)).toBe(
    "npx -y --registry=https://registry.npmjs.org --@agentclientprotocol:registry=https://registry.npmjs.org @agentclientprotocol/codex-acp@1.1.4",
  );
  expect(resolveRuntimeAgentCommand("claude", undefined, true, { claude: "0.58.1" })).toBe(
    "npx -y --registry=https://registry.npmjs.org --@agentclientprotocol:registry=https://registry.npmjs.org @agentclientprotocol/claude-agent-acp@0.58.1",
  );
  expect(resolveRuntimeAgentCommand("codex", "my-codex-adapter", true, { codex: "1.0.0" })).toBe(
    "my-codex-adapter",
  );
});

test("config-shaped runtime resolution keeps agent and transport policy together", () => {
  expect(resolveConfiguredAgentCommand(
    { driver: "claude" },
    {
      preferLocalAgents: false,
      adapterVersions: { claude: "0.58.1" },
      adapterRegistry: "https://npm.corp.example/repository/npm/",
    },
  )).toBe("npx -y --registry=https://npm.corp.example/repository/npm --@agentclientprotocol:registry=https://npm.corp.example/repository/npm @agentclientprotocol/claude-agent-acp@0.58.1");
});

// The 0.19.2 template persisted `command: "hermes acp"`; dropping it here migrates
// those configs onto the runtime shim without hand-editing.
test("drops the default hermes template command", () => {
  expect(resolveAgentCommand("hermes", "hermes acp")).toBeUndefined();
  expect(resolveAgentCommand("hermes", "  hermes   acp ")).toBeUndefined();
});

test("keeps a custom hermes command (shim bypass escape hatch)", () => {
  expect(resolveAgentCommand("hermes", "/opt/hermes/bin/hermes acp")).toBe("/opt/hermes/bin/hermes acp");
});

test("runtime resolution supplies the shim command for hermes", () => {
  const resolved = resolveRuntimeAgentCommand("hermes", undefined, false);
  expect(resolved).toContain("hermes-acp-shim.");
  expect(resolved!.endsWith(" hermes acp")).toBe(true);
  // The 0.19.2 default command resolves to the shim too.
  expect(resolveRuntimeAgentCommand("hermes", "hermes acp", false)).toBe(resolved!);
  // A custom command still wins.
  expect(resolveRuntimeAgentCommand("hermes", "my-hermes --acp", false)).toBe("my-hermes --acp");
});

test("runtime resolution uses a statically valid active release and falls back on pointer corruption", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "adapter-runtime-resolution-"));
  try {
    const releaseId = createAdapterReleaseId("1.1.4", "https://registry.npmjs.org", "99999999-0000-4000-8000-000000000000");
    const release = join(runtimeRoot, "adapters", "codex", "releases", releaseId);
    const entry = join(release, "node_modules", "@agentclientprotocol", "codex-acp", "bin", "codex-acp.js");
    const node = join(runtimeRoot, "runtime", "node");
    await mkdir(dirname(entry), { recursive: true });
    await mkdir(dirname(node), { recursive: true });
    await writeFile(entry, "export {};\n");
    await writeFile(node, "#!/bin/sh\n");
    await chmod(node, 0o755);
    await writeFile(join(release, "installed.json"), JSON.stringify({
      schemaVersion: 1, id: "codex", packageName: "@agentclientprotocol/codex-acp", version: "1.1.4",
      releaseId, registry: "https://registry.npmjs.org", nodeExecutable: node,
      entryRelPath: relative(release, entry), installedAt: "2026-08-05T00:00:00.000Z",
    }));
    const pointerPath = join(runtimeRoot, "adapters", "codex", "active.json");
    await writeFile(pointerPath, JSON.stringify({ version: "1.1.4", releaseId, activatedAt: "now" }));
    expect(resolveRuntimeAgentCommand("codex", undefined, true, undefined, undefined, runtimeRoot)).toContain(entry);
    await writeFile(pointerPath, "not-json");
    expect(resolveRuntimeAgentCommand("codex", undefined, true, undefined, undefined, runtimeRoot)).toContain("npx -y");
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
