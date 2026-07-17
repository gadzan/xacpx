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
    "npx -y @agentclientprotocol/codex-acp@1.1.4",
  );
  expect(resolveRuntimeAgentCommand("claude", undefined, true, { claude: "0.58.1" })).toBe(
    "npx -y @agentclientprotocol/claude-agent-acp@0.58.1",
  );
  expect(resolveRuntimeAgentCommand("codex", "my-codex-adapter", true, { codex: "1.0.0" })).toBe(
    "my-codex-adapter",
  );
});

test("config-shaped runtime resolution keeps agent and transport policy together", () => {
  expect(resolveConfiguredAgentCommand(
    { driver: "claude" },
    { preferLocalAgents: false, adapterVersions: { claude: "0.58.1" } },
  )).toBe("npx -y @agentclientprotocol/claude-agent-acp@0.58.1");
});
