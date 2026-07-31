import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "bun:test";

import {
  hermesAcpShimCommand,
  isDefaultHermesCommand,
  isHermesShimCommand,
  quoteAgentCommandToken,
  resolveHermesAcpShimEntry,
  stripResumeCapability,
} from "../../../src/adapters/hermes-shim";

const INITIALIZE_RESPONSE = {
  jsonrpc: "2.0",
  id: 0,
  result: {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true },
      sessionCapabilities: { fork: {}, list: {}, resume: {} },
    },
    agentInfo: { name: "hermes-agent", version: "0.18.2" },
  },
};

test("stripResumeCapability removes only resume, keeping fork/list and loadSession", () => {
  const replaced = stripResumeCapability(JSON.stringify(INITIALIZE_RESPONSE));
  expect(replaced).not.toBeNull();
  const parsed = JSON.parse(replaced!) as typeof INITIALIZE_RESPONSE;
  expect(parsed.result.agentCapabilities.sessionCapabilities).toEqual({ fork: {}, list: {} });
  expect(parsed.result.agentCapabilities.loadSession).toBe(true);
  expect(parsed.result.agentInfo).toEqual({ name: "hermes-agent", version: "0.18.2" });
});

test("stripResumeCapability leaves every other frame alone", () => {
  expect(stripResumeCapability("not json")).toBeNull();
  expect(stripResumeCapability("42")).toBeNull();
  expect(stripResumeCapability(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {} }))).toBeNull();
  // initialize-shaped but without a resume capability: nothing to strip.
  expect(stripResumeCapability(JSON.stringify({
    jsonrpc: "2.0",
    id: 0,
    result: { agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } } },
  }))).toBeNull();
});

test("isDefaultHermesCommand matches only the template default", () => {
  expect(isDefaultHermesCommand("hermes acp")).toBe(true);
  expect(isDefaultHermesCommand("  hermes   acp ")).toBe(true);
  expect(isDefaultHermesCommand("/opt/hermes acp")).toBe(false);
  expect(isDefaultHermesCommand("hermes")).toBe(false);
});

test("isHermesShimCommand recognizes shim commands from any install path", () => {
  expect(isHermesShimCommand('"/usr/bin/node" "/a/dist/adapters/hermes-acp-shim.js" hermes acp')).toBe(true);
  expect(isHermesShimCommand("hermes acp")).toBe(false);
});

test("quoteAgentCommandToken survives acpx's quote-aware --agent splitter", () => {
  expect(quoteAgentCommandToken("/plain/path")).toBe('"/plain/path"');
  expect(quoteAgentCommandToken("/path with spaces/node")).toBe('"/path with spaces/node"');
  expect(quoteAgentCommandToken("C:\\Program Files\\node.exe")).toBe('"C:\\\\Program Files\\\\node.exe"');
});

test("resolveHermesAcpShimEntry anchors on the last /dist/ segment for bundled builds", () => {
  expect(resolveHermesAcpShimEntry("file:///opt/xacpx/dist/cli.js"))
    .toBe("/opt/xacpx/dist/adapters/hermes-acp-shim.js");
  expect(resolveHermesAcpShimEntry("file:///opt/xacpx/dist/bridge/bridge-main.js"))
    .toBe("/opt/xacpx/dist/adapters/hermes-acp-shim.js");
  // Unbundled dev run: the sibling .ts source next to the module.
  expect(resolveHermesAcpShimEntry("file:///repo/src/adapters/hermes-shim.ts"))
    .toBe("/repo/src/adapters/hermes-acp-shim.ts");
});

test("hermesAcpShimCommand quotes runner + entry and appends the hermes target", () => {
  expect(hermesAcpShimCommand("/usr/local/bin/node", "/opt/x acpx/dist/adapters/hermes-acp-shim.js"))
    .toBe('"/usr/local/bin/node" "/opt/x acpx/dist/adapters/hermes-acp-shim.js" hermes acp');
});

// End-to-end: run the real shim against a stub agent and confirm exactly one frame
// (the initialize response) is rewritten while everything else passes through.
const stubDir = mkdtempSync(join(tmpdir(), "hermes-shim-test-"));
afterAll(() => {
  rmSync(stubDir, { recursive: true, force: true });
});

test("shim strips resume from the initialize response and passes the rest through", async () => {
  const stubPath = join(stubDir, "stub-agent.js");
  writeFileSync(stubPath, `
    process.stdin.on("data", (chunk) => {
      if (chunk.toString("utf8").includes('"initialize"')) {
        process.stdout.write(${JSON.stringify(JSON.stringify(INITIALIZE_RESPONSE))} + "\\n");
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { note: "pass-through-你好" } }) + "\\n");
        process.exit(0);
      }
    });
  `);

  const shimEntry = fileURLToPath(new URL("../../../src/adapters/hermes-acp-shim.ts", import.meta.url));
  // process.execPath is bun under bun:test, which runs both the .ts shim and the .js stub.
  const child = spawn(process.execPath, [shimEntry, process.execPath, stubPath], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.stdin.write('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}\n');

  const stdout = await new Promise<string>((resolve, reject) => {
    let collected = "";
    child.stdout.on("data", (chunk: Buffer) => {
      collected += chunk.toString("utf8");
    });
    child.on("close", () => resolve(collected));
    child.on("error", reject);
  });

  const lines = stdout.trim().split("\n");
  expect(lines).toHaveLength(2);
  const initialize = JSON.parse(lines[0]!) as typeof INITIALIZE_RESPONSE;
  expect(initialize.result.agentCapabilities.sessionCapabilities).toEqual({ fork: {}, list: {} });
  expect(initialize.result.agentCapabilities.loadSession).toBe(true);
  const passthrough = JSON.parse(lines[1]!) as { params: { note: string } };
  expect(passthrough.params.note).toBe("pass-through-你好");
}, 15000);
