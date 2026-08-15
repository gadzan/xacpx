import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";

import {
  AcpOutputGuardError,
  MAX_RAW_ACP_LINE_BYTES,
  buildAcpAgentSpawnSpec,
  guardAcpStdoutLine,
  pumpAcpStdout,
} from "./acp-output-guard";

// Stdio interposer between acpx and a real ACP agent. Usage:
// acp-output-guard-main.js -- <agent command> [args...]

const separator = process.argv.indexOf("--");
const commandArgv = separator === -1 ? process.argv.slice(2) : process.argv.slice(separator + 1);
if (commandArgv.length === 0) {
  process.stderr.write("[xacpx-acp-output-guard] missing agent command after --\n");
  process.exit(1);
}

const spawnSpec = buildAcpAgentSpawnSpec(commandArgv);
const child = spawn(spawnSpec.command, spawnSpec.args, {
  stdio: ["pipe", "pipe", "pipe"],
  shell: spawnSpec.shell,
  windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments,
});

let stopping = false;
let finalized = false;

function writeStderr(chunk: Buffer | string): void {
  process.stderr.write(chunk);
}

function failClosed(error: unknown): void {
  if (stopping) return;
  stopping = true;
  const message = error instanceof AcpOutputGuardError
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
  writeStderr(`[xacpx-acp-output-guard] ${message}\n`);
  try {
    child.stdin?.destroy();
    child.kill("SIGTERM");
  } catch {
    // The child may have exited between the guard failure and termination.
  }
  const forceKill = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Best effort only; the close handler still owns the final exit status.
    }
  }, 5_000);
  forceKill.unref?.();
}

async function writeLine(line: string): Promise<void> {
  if (process.stdout.write(`${line}\n`)) return;
  await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
}

async function forwardLine(line: Buffer): Promise<void> {
  if (stopping) return;
  const safeLines = guardAcpStdoutLine(line.toString("utf8"));
  for (const safeLine of safeLines) {
    await writeLine(safeLine);
  }
}

const stdoutPump = pumpAcpStdout(child.stdout, forwardLine, MAX_RAW_ACP_LINE_BYTES).catch((error) => {
  failClosed(error);
});

async function finalize(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
  if (finalized) return;
  finalized = true;
  try {
    await stdoutPump;
  } catch (error) {
    failClosed(error);
  }
  if (stopping) {
    process.exitCode = 1;
  } else {
    process.exitCode = signal ? 128 + (osConstants.signals[signal] ?? 0) : (code ?? 0);
  }
}

child.on("error", (error) => {
  failClosed(new Error(`failed to spawn agent: ${error.message}`));
});

child.on("close", (code, signal) => {
  void finalize(code, signal);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      // The child may have already exited.
    }
  });
}

child.stdin?.on("error", () => {
  // The agent can close stdin while the parent is still piping a prompt.
});
process.stdin.pipe(child.stdin!);
child.stderr?.pipe(process.stderr);
