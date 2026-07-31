import { expect, test } from "bun:test";

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
    "npx -y --registry=https://registry.npmjs.org/ --@agentclientprotocol:registry=https://registry.npmjs.org/ @agentclientprotocol/codex-acp@1.1.4",
  );
  expect(resolveRuntimeAgentCommand("claude", undefined, true, { claude: "0.58.1" })).toBe(
    "npx -y --registry=https://registry.npmjs.org/ --@agentclientprotocol:registry=https://registry.npmjs.org/ @agentclientprotocol/claude-agent-acp@0.58.1",
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
  )).toBe("npx -y --registry=https://npm.corp.example/repository/npm/ --@agentclientprotocol:registry=https://npm.corp.example/repository/npm/ @agentclientprotocol/claude-agent-acp@0.58.1");
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
