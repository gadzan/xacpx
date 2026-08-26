import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcpxCliTransport } from "../../src/transport/acpx-cli/acpx-cli-transport";
import { resolveAcpxCommand } from "../../src/config/resolve-acpx-command";
import { deriveAgentAlias, renderAgentArgvIdentity } from "../../src/config/agent-launch";
import { wrapAcpOutputGuardArgv } from "../../src/adapters/acp-output-guard";
import type { ResolvedSession } from "../../src/transport/types";

const ACPX = resolveAcpxCommand({ configuredCommand: undefined });

test("official acpx 0.13 queue stays healthy behind the xacpx ACP output guard", async () => {
  const home = await mkdtemp(join(tmpdir(), "xacpx-guard-acpx-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "xacpx-guard-acpx-workspace-"));
  const agentDir = await mkdtemp(join(tmpdir(), "xacpx-guard-agent-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  let transport: AcpxCliTransport | undefined;
  let spec: ResolvedSession | undefined;
  try {
    process.env.HOME = home;
    if (process.platform === "win32") process.env.USERPROFILE = home;

    const agentPath = join(agentDir, "oversized-agent.js");
    await writeFile(agentPath, `
      const readline = require("node:readline");
      const write = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      const update = (sessionId, value) => write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });
      const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      rl.on("line", (line) => {
        const request = JSON.parse(line);
        if (request.method === "initialize") {
          write({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { new: {}, load: {}, resume: {}, close: {}, cancel: {} } } } });
        } else if (request.method === "session/new") {
          write({ jsonrpc: "2.0", id: request.id, result: { sessionId: "guarded-session-1" } });
        } else if (request.method === "session/load" || request.method === "session/resume") {
          write({ jsonrpc: "2.0", id: request.id, result: { sessionId: request.params.sessionId } });
        } else if (request.method === "session/prompt") {
          const prompt = JSON.stringify(request.params.prompt);
          if (prompt.includes("big")) {
            update(request.params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed", kind: "execute", title: "cat", rawOutput: { stdout: "o".repeat(20 * 1024 * 1024) } });
            update(request.params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x".repeat(12 * 1024 * 1024) } });
          }
          update(request.params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
          write({ jsonrpc: "2.0", id: request.id, result: { sessionId: request.params.sessionId, stopReason: "end_turn" } });
        } else if (request.method === "session/cancel") {
          write({ jsonrpc: "2.0", id: request.id, result: { cancelled: true } });
        } else if (request.method === "session/close") {
          write({ jsonrpc: "2.0", id: request.id, result: {} });
        }
      });
    `);

    const realArgv = [process.execPath, agentPath];
    const guardedArgv = wrapAcpOutputGuardArgv(realArgv);
    const alias = deriveAgentAlias("guarded", guardedArgv);
    await mkdir(join(home, ".acpx"), { recursive: true });
    await writeFile(join(home, ".acpx", "config.json"), `${JSON.stringify({ agents: { [alias]: { argv: guardedArgv } } }, null, 2)}\n`);
    spec = {
      alias: "guarded-demo",
      agent: "guarded",
      driver: "guarded",
      acpxAgent: alias,
      agentCommand: renderAgentArgvIdentity(guardedArgv),
      agentArgv: guardedArgv,
      workspace: "test",
      transportSession: "guarded-demo",
      cwd: workspace,
    };

    const acpxPackage = JSON.parse(await readFile(join(process.cwd(), "node_modules", "acpx", "package.json"))) as { version?: string };
    expect(acpxPackage.version?.startsWith("0.13.")).toBe(true);
    transport = new AcpxCliTransport({
      command: ACPX,
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
      queueOwnerTtlSeconds: 5,
      sessionInitTimeoutMs: 60_000,
    });
    await transport.ensureSession(spec);
    const first = await transport.prompt(spec, "big");
    expect(first.text.length).toBe(12 * 1024 * 1024 + 4);
    expect(first.text.endsWith("done")).toBe(true);
    const second = await transport.prompt(spec, "second");
    expect(second.text).toBe("done");
    await transport.removeSession?.(spec);
  } finally {
    await transport?.dispose?.();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    // Keep cleanup best-effort: acpx's close path has already stopped the owner
    // when the lifecycle reached ensure successfully.
    await Promise.all([
      rm(home, { recursive: true, force: true }).catch(() => {}),
      rm(workspace, { recursive: true, force: true }).catch(() => {}),
      rm(agentDir, { recursive: true, force: true }).catch(() => {}),
    ]);
  }
}, { timeout: 180_000 });
