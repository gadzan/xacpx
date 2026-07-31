import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { isInitializeResponse, stripResumeCapability } from "./hermes-shim";

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
  // 128+n mirrors the shell convention so acpx diagnostics see the real cause
  // instead of a flattened exit 1.
  process.exitCode = signal ? 128 + (osConstants.signals[signal] ?? 0) : (code ?? 0);
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

const interceptStdout = (chunk: Buffer): void => {
  pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
  let newlineIndex: number;
  while (!patched && (newlineIndex = pending.indexOf(NEWLINE)) !== -1) {
    const line = pending.subarray(0, newlineIndex + 1);
    pending = pending.subarray(newlineIndex + 1);
    const text = line.toString("utf8");
    const replaced = stripResumeCapability(text);
    if (replaced !== null) {
      patched = true;
      process.stdout.write(`${replaced}\n`);
    } else {
      // Not the frame we're after: forward the original bytes untouched. Still
      // latch on the initialize response (the only frame with agentCapabilities)
      // so a post-fix hermes without `resume` doesn't get line-parsed forever.
      process.stdout.write(line);
      if (isInitializeResponse(text)) patched = true;
    }
  }
  if (patched) {
    if (pending.length > 0) {
      process.stdout.write(pending);
      pending = Buffer.alloc(0);
    }
    // Raw passthrough from here on; pipe() provides backpressure for free.
    // end:false — process.stdout must never be end()ed.
    child.stdout!.off("data", interceptStdout);
    child.stdout!.pipe(process.stdout, { end: false });
  }
};

child.stdout!.on("data", interceptStdout);

child.stdout!.on("end", () => {
  if (pending.length > 0) {
    process.stdout.write(pending);
    pending = Buffer.alloc(0);
  }
});
