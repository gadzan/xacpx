import { spawn } from "node:child_process";

import { buildTestPlan } from "./run-tests-lib.mjs";

const root = process.argv[2] ?? "tests/unit";

// Per-step wall-clock cap. A single hung test file (e.g. a leaked socket/handle
// that never lets the process exit) otherwise wedges the whole run until the CI
// job timeout — burning ~30min and hiding which file is at fault. Fail the step
// here instead, naming the command, so CI fails fast and points at the culprit.
// Declared before the first runOne() call below (const is not hoisted).
// tests/compat spawns real acpx processes with a mock ACP agent (ensure, prompt,
// cancel, close per transport); the full file legitimately runs past the unit
// budget, so it gets its own larger cap.
const STEP_TIMEOUT_MS = Number(
  process.env.RUN_TESTS_STEP_TIMEOUT_MS ?? (root === "tests/compat" ? 600_000 : 180_000),
);

const protocolBuildCode = await runOne("bun", ["run", "build:relay-protocol"]);
if (protocolBuildCode !== 0) {
  process.exit(protocolBuildCode ?? 1);
}

const buildCode = await runOne("bun", [
  "build",
  "./src/plugin-api.ts",
  "--outdir",
  "./dist",
  "--target",
  "node",
  "--external",
  "node-pty",
]);
if (buildCode !== 0) {
  process.exit(buildCode ?? 1);
}

const runtimeWorkerBuildCode = await runOne("bun", [
  "build",
  "./src/bridge/engine/runtime/runtime-worker-main.ts",
  "./src/bridge/bridge-main.ts",
  "--outdir",
  "./dist",
  "--target",
  "node",
  "--external",
  "node-pty",
  "--external",
  "fs-ext",
  "--external",
  "write-file-atomic",
  "--external",
  "acpx",
]);
if (runtimeWorkerBuildCode !== 0) {
  process.exit(runtimeWorkerBuildCode ?? 1);
}


const plan = buildTestPlan(root);

for (const step of plan) {
  const code = await runOne(step.command, step.args);
  if (code !== 0) {
    process.exit(code ?? 1);
  }
}

if (root === "tests/unit") {
  const webCode = await runOne("bun", ["run", "test:web"]);
  if (webCode !== 0) process.exit(webCode ?? 1);
}

async function runOne(command, args) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...(process.platform === "win32" ? { shell: true } : {}),
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`\n[run-tests] TIMEOUT after ${STEP_TIMEOUT_MS / 1000}s — killing: ${command} ${args.join(" ")}`);
      child.kill("SIGTERM");
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 5_000).unref?.();
    }, STEP_TIMEOUT_MS);
    timer.unref?.();

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      // Our own timeout kill → report as a failure (don't re-raise it as the
      // parent's signal, which would mask it as a clean/odd exit).
      if (timedOut) {
        resolve(1);
        return;
      }
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}
