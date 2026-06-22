import { spawn } from "node:child_process";

import { buildTestPlan } from "./run-tests-lib.mjs";

const root = process.argv[2] ?? "tests/unit";

// Per-step wall-clock cap. A single hung test file (e.g. a leaked socket/handle
// that never lets the process exit) otherwise wedges the whole run until the CI
// job timeout — burning ~30min and hiding which file is at fault. Fail the step
// here instead, naming the command, so CI fails fast and points at the culprit.
// Declared before the first runOne() call below (const is not hoisted).
const STEP_TIMEOUT_MS = Number(process.env.RUN_TESTS_STEP_TIMEOUT_MS ?? 180_000);

// Channel-package tests import `packages/*/src`, which value-import the bare
// specifier "weacpx/plugin-api". That resolves via the workspace-root exports
// map to `dist/plugin-api.js`, so the bundle MUST exist before any test runs —
// otherwise the import fails with "Cannot find module 'weacpx/plugin-api'".
// (`build:plugin-api` is emitDeclarationOnly and only produces the .d.ts; the
// runnable .js comes from this bun build.) Build it once up front so every test
// entry point — npm test, test:unit, test:smoke, CI publish gates — is
// self-sufficient and order-independent.
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

// relay/channel-relay tests import "@ganglion/xacpx-relay-protocol", which the
// workspace link resolves to packages/relay-protocol/dist — build it up front
// for the same order-independence reason as plugin-api above. Use the full
// build:relay-protocol script (NOT a bare `bun build`): bun build emits only
// index.js, so type-only exports (interfaces like PromptAttachmentRef vanish in
// JS) are invisible to tsc and the typecheck step fails with "no exported
// member". The script's `tsc -p` emits the .d.ts the typecheck needs.
const protocolBuildCode = await runOne("bun", ["run", "build:relay-protocol"]);
if (protocolBuildCode !== 0) {
  process.exit(protocolBuildCode ?? 1);
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
