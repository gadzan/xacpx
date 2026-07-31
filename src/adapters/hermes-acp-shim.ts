import { spawn } from "node:child_process";
import { stripResumeCapability } from "./hermes-shim";

// Stdio interposer between acpx and `hermes acp`: rewrites exactly one frame — the
// initialize response — to drop `sessionCapabilities.resume`, then degrades to raw
// byte passthrough. See hermes-shim.ts for why. Usage: hermes-acp-shim.js [command...]

const argv = process.argv.slice(2);
const command = argv.length > 0 ? argv : ["hermes", "acp"];

const child = spawn(command[0]!, command.slice(1), {
  stdio: ["pipe", "pipe", "inherit"],
  // .cmd/.bat launchers on Windows require a shell; harmless for real executables.
  shell: process.platform === "win32",
});

child.on("error", (error) => {
  process.stderr.write(`[hermes-acp-shim] failed to spawn "${command.join(" ")}": ${error.message}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

process.stdin.pipe(child.stdin!);

let patched = false;
let pending: Buffer = Buffer.alloc(0);
const NEWLINE = 0x0a;

child.stdout!.on("data", (chunk: Buffer) => {
  if (patched) {
    process.stdout.write(chunk);
    return;
  }
  pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
  let newlineIndex: number;
  while (!patched && (newlineIndex = pending.indexOf(NEWLINE)) !== -1) {
    const line = pending.subarray(0, newlineIndex + 1);
    pending = pending.subarray(newlineIndex + 1);
    const replaced = stripResumeCapability(line.toString("utf8"));
    if (replaced !== null) {
      patched = true;
      process.stdout.write(`${replaced}\n`);
    } else {
      // Not the frame we're after: forward the original bytes untouched.
      process.stdout.write(line);
    }
  }
  if (patched && pending.length > 0) {
    process.stdout.write(pending);
    pending = Buffer.alloc(0);
  }
});

child.stdout!.on("end", () => {
  if (pending.length > 0) {
    process.stdout.write(pending);
    pending = Buffer.alloc(0);
  }
});
