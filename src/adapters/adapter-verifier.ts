import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { terminateProcessTree } from "../process/terminate-process-tree";
import { MANAGED_ADAPTERS, type ManagedAdapterId } from "./adapter-catalog";

const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT = 64 * 1024;

interface VerifyOptions {
  timeoutMs?: number;
}

interface JsonRpcResponse {
  id?: unknown;
  result?: { protocolVersion?: unknown };
  error?: { message?: unknown; data?: unknown };
}

/** Runs a structured ACP initialize probe and tears down the process tree afterward. */
export async function verifyAcpInitialize(
  command: string,
  args: string[],
  options: VerifyOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const detached = process.platform !== "win32";
  const child = spawn(command, args, {
    detached,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let stdoutBuffer = "";
  let settled = false;
  let timer: NodeJS.Timeout | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };

      timer = setTimeout(() => {
        finish(new Error(`ACP initialize timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = appendLimited(stderr, chunk);
      });

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer = appendLimited(stdoutBuffer, chunk);
        for (;;) {
          const newline = stdoutBuffer.indexOf("\n");
          if (newline < 0) break;
          const line = stdoutBuffer.slice(0, newline).trim();
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (!line) continue;
          let response: JsonRpcResponse;
          try {
            response = JSON.parse(line) as JsonRpcResponse;
          } catch {
            continue;
          }
          if (response.id !== 0) continue;
          if (response.error) {
            const detail = typeof response.error.message === "string"
              ? response.error.message
              : "adapter returned an ACP initialize error";
            finish(new Error(detail));
            return;
          }
          if (response.result?.protocolVersion !== 1) {
            finish(new Error(`adapter returned unsupported ACP protocolVersion ${String(response.result?.protocolVersion)}`));
            return;
          }
          finish();
          return;
        }
      });

      child.once("error", (error) => finish(new Error(`failed to start adapter: ${error.message}`)));
      child.once("close", (code, signal) => {
        if (settled) return;
        const suffix = stderr.trim() ? `: ${stderr.trim()}` : "";
        finish(new Error(`adapter exited before ACP initialize completed (code=${String(code)}, signal=${String(signal)})${suffix}`));
      });

      child.stdin.on("error", (error) => finish(new Error(`failed to send ACP initialize: ${error.message}`)));
      // Keep stdin open until the response arrives. ACP adapters treat EOF as client
      // disconnect; ending immediately can race an async initialize and yield code 0
      // with no response (observed with codex-acp 1.x).
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
          },
          clientInfo: { name: "xacpx-adapter-check", version: "1" },
        },
      })}\n`);
    });
  } finally {
    if (timer) clearTimeout(timer);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    await terminateProcessTree(child.pid ?? 0, { detachedProcessGroup: detached });
  }
}

/** Downloads the exact package version through npm's exec cache, then probes ACP. */
export async function verifyAdapterVersion(id: ManagedAdapterId, version: string): Promise<void> {
  const adapter = MANAGED_ADAPTERS[id];
  const npm = resolveNpmCommand();
  await verifyAcpInitialize(npm.command, [
    ...npm.prefixArgs,
    "exec",
    "--yes",
    `--package=${adapter.packageName}@${version}`,
    "--",
    adapter.binName,
  ]);
}

function resolveNpmCommand(): { command: string; prefixArgs: string[] } {
  if (process.platform !== "win32") return { command: "npm", prefixArgs: [] };

  // Never route package specs through a command shell. Official Node installers
  // place npm-cli.js beside node.exe; npm-run scripts also expose its exact path.
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const npmCli = candidates.find((candidate): candidate is string =>
    typeof candidate === "string" && /npm-cli\.(?:c?js)$/i.test(candidate) && existsSync(candidate));
  if (!npmCli) {
    throw new Error("cannot locate npm-cli.js for shell-free adapter verification");
  }
  return { command: process.execPath, prefixArgs: [npmCli] };
}

function appendLimited(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= OUTPUT_LIMIT ? next : next.slice(next.length - OUTPUT_LIMIT);
}
