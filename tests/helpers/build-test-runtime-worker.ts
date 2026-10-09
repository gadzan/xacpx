/**
 * Builds the real Runtime Worker for tests into a repository-local artifact
 * directory, then proves the built bundle can actually resolve its external
 * dependencies.
 *
 * Why the bundle must live inside the repository: `Bun.build(..., { external:
 * ["acpx", ...] })` keeps `import ... from "acpx/runtime"` as a live ESM import.
 * Node resolves that from the bundle's own location, walking up to the nearest
 * `node_modules`. The OS temp directory has no such ancestor, so a worker built
 * there dies at import time with exit code 1 and no stderr — which surfaces in
 * CI as `runtime worker crashed unexpectedly (code 1)`. Building inside the
 * repository's package scope makes resolution deterministic on every host.
 *
 * The ESM preflight below turns that silent crash into an actionable diagnosis.
 * The probe is a real module sitting in the same directory as the bundle, so its
 * own static `import "acpx/runtime"` exercises exactly the resolution the worker
 * depends on. It runs under real Node with a deliberately unrelated cwd, so a
 * pass proves resolution comes from the bundle's location rather than from
 * whatever directory the test happened to run in.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_ENTRY = "runtime-worker-main.js";
const WORKER_EXTERNALS = ["acpx", "node-pty", "fs-ext", "write-file-atomic"] as const;

/** Repository root, derived from this file rather than the process cwd. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Root for all test-built worker bundles; see `.gitignore`. */
const ARTIFACT_ROOT = join(REPO_ROOT, ".test-artifacts");

export interface TestRuntimeWorker {
  /** Absolute path of the built worker entry to hand to RuntimeWorkerManager. */
  readonly entryPath: string;
  /** The unique artifact directory created for this build. */
  readonly artifactDir: string;
  /**
   * Removes only this build's artifact directory. Never touches `dist/`,
   * `node_modules/`, member worktrees, or another build's directory.
   */
  release(): Promise<void>;
}

/** Distinguishes the failure stages so a red test says which one broke. */
export type RuntimeWorkerBuildStage =
  | "bundle-build"
  | "artifact-missing"
  | "esm-resolve"
  | "esm-import"
  | "esm-export"
  | "preflight-spawn";

export class RuntimeWorkerBuildError extends Error {
  constructor(readonly stage: RuntimeWorkerBuildStage, message: string, options?: { cause?: unknown }) {
    super(`runtime test worker ${stage} failed: ${message}`, options);
    this.name = "RuntimeWorkerBuildError";
  }
}

/**
 * Builds the real Runtime Worker into a fresh repository-local directory and
 * verifies the result can resolve and load its external dependencies.
 */
export async function buildTestRuntimeWorker(): Promise<TestRuntimeWorker> {
  // Each build gets its own directory, so concurrent tests never share or
  // overwrite an entry, and a single release() cannot delete a sibling's work.
  await mkdir(ARTIFACT_ROOT, { recursive: true });
  const artifactDir = await mkdtemp(join(ARTIFACT_ROOT, "runtime-worker-"));
  const entryPath = join(artifactDir, WORKER_ENTRY);

  try {
    const built = await Bun.build({
      entrypoints: [join(REPO_ROOT, "src/bridge/engine/runtime/runtime-worker-main.ts")],
      outdir: artifactDir,
      target: "node",
      external: [...WORKER_EXTERNALS],
    });
    if (!built.success) {
      throw new RuntimeWorkerBuildError("bundle-build", built.logs.map(l => String(l)).join("\n"));
    }
    if (!existsSync(entryPath)) {
      throw new RuntimeWorkerBuildError("artifact-missing", `expected worker entry at ${entryPath}`);
    }

    await assertExternalsResolveFrom(artifactDir);
  } catch (error) {
    // A failed build must not leave its directory behind; the caller gets the
    // original failure, and later runs start from a clean root.
    await rm(artifactDir, { recursive: true, force: true });
    throw error;
  }

  return {
    entryPath,
    artifactDir,
    async release() {
      // Scoped to this build's directory only: never a recursive wipe of the
      // shared artifact root, so a concurrent build is never collateral damage.
      await rm(artifactDir, { recursive: true, force: true });
    },
  };
}

/**
 * The probe's static import is the resolution under test: it sits beside the
 * bundle, so Node must find `acpx/runtime` the same way the worker does.
 */
const PREFLIGHT_SOURCE = [
  `import { createAcpRuntime } from "acpx/runtime";`,
  `console.log(JSON.stringify({`,
  `  outcome: typeof createAcpRuntime === "function" ? "ok" : "export-missing",`,
  `  resolved: import.meta.resolve("acpx/runtime"),`,
  `  node: process.version,`,
  `  bundleDir: import.meta.dirname,`,
  `}));`,
  ``,
].join("\n");

/**
 * Outcome of one preflight probe run.
 *
 * `spawnFailed` reports that the probe process could not be started or timed
 * out, as distinct from the process running and reporting a load failure. The
 * caller wraps the former in the declared `preflight-spawn` stage so a missing
 * runtime is never reported as a module-resolution problem.
 *
 * `cause` carries the original thrown object, not a string copy: Node's spawn
 * errors expose `code`/`errno` (ENOENT, EACCES, EPERM) that a stringified
 * message drops, and those fields are what distinguishes "runtime not
 * installed" from "runtime exists but is not executable".
 */
export interface EsmPreflightOutcome {
  ok: boolean;
  detail: string;
  spawnFailed?: { cause: unknown };
}

/**
 * Runs one ESM probe module and reports how its imports resolved. Exported so a
 * regression test can prove the preflight rejects an unresolvable dependency
 * instead of always reporting success.
 *
 * `runtime` defaults to `process.execPath`; overriding it lets a test simulate
 * an unspawnable runtime without touching the real one.
 *
 * Bounded by a hard deadline: an unresponsive probe must fail the build with a
 * named stage rather than hang the whole test file.
 */
export async function runEsmPreflight(probePath: string, options: { runtime?: string; deadlineMs?: number } = {}): Promise<EsmPreflightOutcome> {
  const { runtime = process.execPath, deadlineMs = 30_000 } = options;
  const { promise, resolve } = Promise.withResolvers<EsmPreflightOutcome>();
  let stdout = "", stderr = "";
  let settled = false;
  let timer: NodeJS.Timeout | undefined;

  const child = spawn(runtime, [probePath], {
    // cwd is deliberately outside the repository: resolution must come from
    // the probe's own location, not from the process working directory.
    cwd: tmpdir(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: process.env,
  });

  const settle = (outcome: EsmPreflightOutcome) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(outcome);
  };
  timer = setTimeout(() => {
    // Kill first: an unresponsive probe must not outlive the preflight.
    child.kill("SIGKILL");
    settle({ ok: false, detail: `${stderr}\n[preflight timed out after ${deadlineMs}ms]`.trim(), spawnFailed: { cause: `timed out after ${deadlineMs}ms` } });
  }, deadlineMs);
  timer.unref?.();

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.once("error", error => {
    // Spawn itself failed (e.g. execPath missing/not executable). The original
    // object is forwarded intact so the caller's error keeps code/errno, and is
    // reported distinctly so it is never blamed on module resolution.
    settle({ ok: false, detail: error instanceof Error ? error.message : String(error), spawnFailed: { cause: error } });
  });
  child.once("close", code => settle({ ok: code === 0, detail: (code === 0 ? stdout : stderr).trim() || stdout.trim() }));

  return promise;
}

/** Classifies a failed preflight into the stage that actually broke. */
export function classifyPreflightFailure(detail: string): RuntimeWorkerBuildStage {
  return /Cannot find package|ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED/i.test(detail)
    ? "esm-resolve"
    : "esm-import";
}

/**
 * Proves a module sitting in `bundleDir` resolves `acpx/runtime`.
 *
 * The probe runs under `process.execPath` — the exact runtime that
 * RuntimeWorkerClient uses to spawn the worker — so it checks the resolution
 * the worker will actually perform.
 *
 * Exported so a regression test can assert the caller's error contract (stage
 * and preserved cause) without rebuilding the worker bundle.
 *
 * `runtime` defaults to `process.execPath`; a test may override it to simulate
 * an unspawnable runtime while keeping the real probe source.
 */
export async function assertExternalsResolveFrom(bundleDir: string, runtime?: string): Promise<void> {
  const probe = join(bundleDir, "esm-preflight.mjs");
  await writeFile(probe, PREFLIGHT_SOURCE, "utf8");

  const preflight = await runEsmPreflight(probe, runtime ? { runtime } : {});
  if (preflight.spawnFailed) {
    // The probe process never ran (or never answered). This is an environment
    // problem, not a module-resolution one, so it gets its own stage. The
    // original throwable is forwarded as-is — wrapping it in a fresh Error
    // would flatten code/errno/stack into a bare message.
    throw new RuntimeWorkerBuildError(
      "preflight-spawn",
      `${process.execPath} (${process.version}) could not run the preflight probe in ${bundleDir}: ${preflight.detail}`,
      { cause: preflight.spawnFailed.cause },
    );
  }
  if (!preflight.ok) {
    // A failed static import names the specifier it could not resolve, which is
    // exactly the CI symptom this preflight exists to explain.
    throw new RuntimeWorkerBuildError(
      classifyPreflightFailure(preflight.detail),
      `${process.execPath} (${process.version}) could not load acpx/runtime from ${bundleDir}: ${preflight.detail}`,
    );
  }

  let parsed: { outcome?: string; resolved?: string } = {};
  try { parsed = JSON.parse(preflight.detail.split("\n").at(-1) ?? "{}"); }
  catch { throw new RuntimeWorkerBuildError("preflight-spawn", `unreadable preflight output: ${preflight.detail}`); }
  if (parsed.outcome !== "ok") {
    throw new RuntimeWorkerBuildError("esm-export", `acpx/runtime did not export createAcpRuntime (resolved ${parsed.resolved ?? "unknown"})`);
  }
}

/** Test-only constant so specs can assert the ignore rule covers the root. */
export const TEST_ARTIFACT_ROOT = ARTIFACT_ROOT;
