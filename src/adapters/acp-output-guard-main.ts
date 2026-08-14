import { once } from "node:events";
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";

import {
  AcpOutputGuardError,
  MAX_RAW_ACP_LINE_BYTES,
  guardAcpStdoutLine,
} from "./acp-output-guard";

// Stdio interposer between acpx and a real ACP agent. Usage:
// acp-output-guard-main.js -- <agent command> [args...]

const separator = process.argv.indexOf("--");
const commandArgv = separator === -1 ? process.argv.slice(2) : process.argv.slice(separator + 1);
if (commandArgv.length === 0) {
  process.stderr.write("[xacpx-acp-output-guard] missing agent command after --\n");
  process.exit(1);
}

const child = spawn(commandArgv[0]!, commandArgv.slice(1), {
  stdio: ["pipe", "pipe", "pipe"],
  // .cmd/.bat launchers on Windows require a shell; harmless for real executables.
  shell: process.platform === "win32",
});

let stopping = false;
let finalized = false;
let pendingParts: Buffer[] = [];
let pendingBytes = 0;
let outputChain = Promise.resolve();

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
  await once(process.stdout, "drain");
}

function enqueueLine(line: Buffer): void {
  if (stopping) return;
  let safeLines: string[];
  try {
    safeLines = guardAcpStdoutLine(line.toString("utf8"));
  } catch (error) {
    failClosed(error);
    return;
  }
  for (const safeLine of safeLines) {
    outputChain = outputChain.then(() => writeLine(safeLine));
  }
}

function resetPending(): void {
  pendingParts = [];
  pendingBytes = 0;
}

function appendPending(part: Buffer): void {
  if (part.length === 0) return;
  pendingParts.push(part);
  pendingBytes += part.length;
  if (pendingBytes > MAX_RAW_ACP_LINE_BYTES) {
    failClosed(new AcpOutputGuardError(
      `raw ACP stdout line exceeded ${MAX_RAW_ACP_LINE_BYTES} bytes`,
    ));
  }
}

function consumeStdoutChunk(chunk: Buffer): void {
  let offset = 0;
  while (!stopping && offset <= chunk.length) {
    const newline = chunk.indexOf(0x0a, offset);
    const end = newline === -1 ? chunk.length : newline;
    appendPending(chunk.subarray(offset, end));
    if (stopping) return;
    if (newline === -1) return;

    enqueueLine(Buffer.concat(pendingParts, pendingBytes));
    resetPending();
    offset = newline + 1;
  }
}

async function finalize(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
  if (finalized) return;
  finalized = true;
  if (!stopping && pendingBytes > 0) {
    enqueueLine(Buffer.concat(pendingParts, pendingBytes));
    resetPending();
  }
  try {
    await outputChain;
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

child.stderr?.on("data", (chunk: Buffer | string) => {
  writeStderr(chunk);
});
child.stdout?.on("data", (chunk: Buffer | string) => {
  consumeStdoutChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
});
child.stdout?.on("end", () => {
  if (!stopping && pendingBytes > 0) {
    enqueueLine(Buffer.concat(pendingParts, pendingBytes));
    resetPending();
  }
});
