import { homedir } from "node:os";
import { join } from "node:path";

import { coreHomeDir } from "../runtime/core-home";
import { coreEnv } from "../runtime/core-env";
import { loadConfig } from "../config/load-config";
import type { AppConfig } from "../config/types";
import { createDaemonController } from "../daemon/create-daemon-controller";
import { isProcessAlive, resolveDaemonPaths, resolveRuntimeDirFromConfigPath } from "../daemon/daemon-files";
import { resolveRuntimePaths, type RuntimePaths } from "../main";
import { StateStore, type StateLoadReport } from "../state/state-store";
import { checkAcpx } from "./checks/acpx-check";
import { checkBridge } from "./checks/bridge-check";
import { checkConfig } from "./checks/config-check";
import { checkDaemon } from "./checks/daemon-check";
import { checkLogs } from "./checks/logs-check";
import { checkOrchestrationHealth } from "./checks/orchestration-health";
import { checkOrchestrationSocket } from "./checks/orchestration-socket-check";
import { checkOrphans } from "./checks/orphan-check";
import { checkPlugins } from "./checks/plugin-check";
import { checkRuntime } from "./checks/runtime-check";
import { checkSmoke } from "./checks/smoke-check";
import { checkWechat } from "./checks/wechat-check";
import type {
  DoctorCheckResult,
  DoctorFix,
  DoctorFixOutcome,
  DoctorReport,
  DoctorRepairOutcome,
  DoctorRunOptions,
} from "./doctor-types";
import { renderDoctor } from "./render-doctor";

export interface DoctorRunResult {
  report: DoctorReport;
  output: string[];
  exitCode: number;
}

interface DoctorDeps {
  home?: string;
  resolveRuntimePaths?: () => RuntimePaths;
  loadConfig?: (configPath: string) => Promise<AppConfig>;
  checkConfig?: typeof checkConfig;
  checkRuntime?: typeof checkRuntime;
  checkDaemon?: typeof checkDaemon;
  checkOrphans?: typeof checkOrphans;
  checkLogs?: typeof checkLogs;
  checkWechat?: typeof checkWechat;
  checkAcpx?: typeof checkAcpx;
  checkBridge?: typeof checkBridge;
  checkPlugins?: typeof checkPlugins;
  checkOrchestrationHealth?: () => Promise<DoctorCheckResult>;
  checkOrchestrationSocket?: typeof checkOrchestrationSocket;
  checkSmoke?: (options: DoctorRunOptions) => Promise<DoctorCheckResult>;
  /**
   * Whether a daemon currently owns the runtime. Injected so the state-mutating
   * orchestration repair can be gated (withheld) without touching real
   * processes in tests.
   */
  isDaemonRunning?: () => Promise<boolean>;
  /**
   * Raw daemon status getter used by the DEFAULT liveness mapping. Injected so
   * the running/indeterminate -> "live" gating can be exercised without real
   * processes; ignored when {@link isDaemonRunning} is supplied directly.
   */
  getDaemonStatus?: () => Promise<{ state: string }>;
  renderDoctor?: typeof renderDoctor;
}

export async function runDoctor(options: DoctorRunOptions = {}, deps: DoctorDeps = {}): Promise<DoctorRunResult> {
  const home = deps.home ?? process.env.HOME ?? homedir();
  const runtimePaths = resolveDoctorRuntimePaths(home, deps.resolveRuntimePaths);
  const sharedLoadConfig = createSharedLoadConfig(runtimePaths, deps.loadConfig ?? loadConfig);

  // Each runner produces one check result; keeping the wiring in a single place
  // lets the repair pass re-invoke a check by id without duplicating dependency
  // setup. The array order is the rendered/report order.
  const runners: Array<{ id: string; run: () => Promise<DoctorCheckResult> }> = [
    {
      id: "config",
      run: () =>
        (deps.checkConfig ?? checkConfig)({
          loadConfig: sharedLoadConfig,
          resolveRuntimePaths: () => runtimePaths,
        }),
    },
    {
      id: "runtime",
      run: () =>
        (deps.checkRuntime ?? checkRuntime)({
          home,
          configPath: runtimePaths.configPath,
        }),
    },
    {
      id: "logs",
      run: () =>
        (deps.checkLogs ?? checkLogs)({
          home,
          configPath: runtimePaths.configPath,
        }),
    },
    {
      id: "daemon",
      run: () =>
        (deps.checkDaemon ?? checkDaemon)({
          home,
          configPath: runtimePaths.configPath,
        }),
    },
    {
      id: "orphans",
      run: () => (deps.checkOrphans ?? checkOrphans)({
        runtimeDir: resolveRuntimeDirFromConfigPath(runtimePaths.configPath),
      }),
    },
    {
      id: "wechat",
      run: () =>
        (deps.checkWechat ?? checkWechat)({
          verbose: options.verbose,
        }),
    },
    {
      id: "acpx",
      run: () =>
        (deps.checkAcpx ?? checkAcpx)({
          verbose: options.verbose,
          loadConfig: sharedLoadConfig,
          resolveRuntimePaths: () => runtimePaths,
        }),
    },
    {
      id: "bridge",
      run: () =>
        (deps.checkBridge ?? checkBridge)({
          verbose: options.verbose,
          loadConfig: sharedLoadConfig,
          resolveRuntimePaths: () => runtimePaths,
        }),
    },
    {
      id: "plugins",
      run: () =>
        (deps.checkPlugins ?? checkPlugins)({
          home,
          loadConfig: sharedLoadConfig,
          resolveRuntimePaths: () => runtimePaths,
        }),
    },
    {
      id: "orchestration",
      run: () =>
        (deps.checkOrchestrationHealth ?? (() => defaultCheckOrchestrationHealth({
          runtimePaths,
          loadConfig: sharedLoadConfig,
          isDaemonRunning:
            deps.isDaemonRunning ?? (() => defaultIsDaemonRunning(home, runtimePaths, deps.getDaemonStatus)),
        })))(),
    },
    {
      id: "orchestration-socket",
      run: () =>
        (deps.checkOrchestrationSocket ?? checkOrchestrationSocket)({
          home,
          configPath: runtimePaths.configPath,
        }),
    },
    {
      id: "smoke",
      run: () =>
        options.smoke === true
          ? (deps.checkSmoke ?? ((runOptions) => defaultCheckSmoke(runOptions, {
              resolveRuntimePaths: () => runtimePaths,
              loadConfig: sharedLoadConfig,
            })))(options)
          : Promise.resolve(createSmokeSkipResult("smoke probe not requested")),
    },
  ];

  const runnersById = new Map(runners.map((runner) => [runner.id, runner.run] as const));

  const checks: DoctorCheckResult[] = [];
  for (const runner of runners) {
    checks.push(await runner.run());
  }

  const report: DoctorReport = { checks };

  if (options.fix === true) {
    const { repairs, repairedCheckIds } = await applyRepairs(checks);
    report.repairs = repairs;

    for (const checkId of repairedCheckIds) {
      const index = checks.findIndex((check) => check.id === checkId);
      const rerun = runnersById.get(checkId);
      if (index === -1 || !rerun) {
        continue;
      }
      checks[index] = await rerun();
    }
  }

  const output = (deps.renderDoctor ?? renderDoctor)(report, options);

  return {
    report,
    output,
    exitCode: checks.some((check) => check.severity === "fail") ? 1 : 0,
  };
}

/**
 * Run the attached fixes for the read-only checks under --fix. Withheld fixes
 * are recorded as skipped (never run). A failing or throwing fix is normalised
 * into a "failed" outcome so a bad repair can never crash doctor. Returns the
 * collected outcomes plus the set of check ids that had at least one applied
 * fix (those, and only those, are re-run to reflect post-repair state).
 */
async function applyRepairs(
  checks: DoctorCheckResult[],
): Promise<{ repairs: DoctorRepairOutcome[]; repairedCheckIds: string[] }> {
  const repairs: DoctorRepairOutcome[] = [];
  const repairedCheckIds: string[] = [];

  for (const check of checks) {
    for (const fix of check.fixes ?? []) {
      if (fix.withheld !== undefined) {
        repairs.push({
          checkId: check.id,
          fixId: fix.id,
          title: fix.title,
          status: "skipped",
          message: fix.withheld,
        });
        continue;
      }

      let outcome: DoctorFixOutcome;
      try {
        outcome = await fix.run();
      } catch (error) {
        outcome = { ok: false, message: formatError(error) };
      }

      repairs.push({
        checkId: check.id,
        fixId: fix.id,
        title: fix.title,
        status: outcome.ok ? "applied" : "failed",
        message: outcome.message,
      });

      if (outcome.ok && !repairedCheckIds.includes(check.id)) {
        repairedCheckIds.push(check.id);
      }
    }
  }

  return { repairs, repairedCheckIds };
}

function resolveDoctorRuntimePaths(home: string, resolver?: () => RuntimePaths): RuntimePaths {
  if (resolver) {
    return resolver();
  }

  if (depsUseExplicitRuntimeOverrides()) {
    return resolveRuntimePaths();
  }

  return {
    configPath: join(coreHomeDir(home), "config.json"),
    statePath: join(coreHomeDir(home), "state.json"),
  };
}

function depsUseExplicitRuntimeOverrides(): boolean {
  return Boolean(coreEnv("CONFIG") || coreEnv("STATE"));
}

function createSharedLoadConfig(
  runtimePaths: RuntimePaths,
  loader: (configPath: string) => Promise<AppConfig>,
): (configPath: string) => Promise<AppConfig> {
  let pending: Promise<AppConfig> | undefined;

  return async (configPath: string) => {
    if (configPath !== runtimePaths.configPath) {
      return await loader(configPath);
    }

    pending ??= loader(configPath);
    return await pending;
  };
}

async function defaultCheckSmoke(options: DoctorRunOptions, deps: {
  resolveRuntimePaths: () => RuntimePaths;
  loadConfig: (configPath: string) => Promise<AppConfig>;
}): Promise<DoctorCheckResult> {
  return await checkSmoke(options, {
    resolveRuntimePaths: deps.resolveRuntimePaths,
    loadConfig: deps.loadConfig,
  });
}

function createSmokeSkipResult(summary: string): DoctorCheckResult {
  return {
    id: "smoke",
    label: "Smoke",
    severity: "skip",
    summary,
  };
}

async function defaultCheckOrchestrationHealth(deps: {
  runtimePaths: RuntimePaths;
  loadConfig: (configPath: string) => Promise<AppConfig>;
  isDaemonRunning: () => Promise<boolean>;
}): Promise<DoctorCheckResult> {
  let config: AppConfig;
  try {
    config = await deps.loadConfig(deps.runtimePaths.configPath);
  } catch (error) {
    return {
      id: "orchestration",
      label: "Orchestration",
      severity: "skip",
      summary: "orchestration check skipped because configuration could not be loaded",
      details: [`config path: ${deps.runtimePaths.configPath}`, `error: ${formatError(error)}`],
      suggestions: ["fix the Config check first, then run: xacpx doctor"],
    };
  }

  try {
    // inspect(), not load(): a diagnostic command must never quarantine/rename
    // state.json as a side effect. The inspection report is surfaced below so
    // damage the daemon WOULD repair at startup is visible, not masked.
    const store = new StateStore(deps.runtimePaths.statePath);
    const inspection = await store.inspect();
    const result = await checkOrchestrationHealth({
      loadState: async () => inspection.state,
      now: () => new Date(),
      heartbeatThresholdSeconds: config.orchestration.progressHeartbeatSeconds,
    });
    // Determine daemon liveness only when a fix would actually be offered (the
    // inspection found something to quarantine), to avoid a needless status read
    // on the healthy path.
    const daemonRunning = inspection.report ? await deps.isDaemonRunning() : false;
    return applyStateInspectionReport(
      result,
      inspection.report,
      deps.runtimePaths.statePath,
      daemonRunning,
      deps.isDaemonRunning,
    );
  } catch (error) {
    return {
      id: "orchestration",
      label: "Orchestration",
      severity: "fail",
      summary: "orchestration health check failed",
      details: [`state path: ${deps.runtimePaths.statePath}`, `error: ${formatError(error)}`],
    };
  }
}

/**
 * Merge a state.json inspection report into the orchestration check result.
 * Severity follows the doctor convention for degraded-but-working conditions
 * (daemon stopped / wechat logged out are "warn"): the daemon still boots —
 * it quarantines the listed records at startup — so this warns rather than
 * fails, and never downgrades an existing "fail".
 */
function applyStateInspectionReport(
  result: DoctorCheckResult,
  report: StateLoadReport | null,
  statePath: string,
  daemonRunning: boolean,
  isDaemonRunning: () => Promise<boolean>,
): DoctorCheckResult {
  if (!report) {
    return result;
  }

  const fileCorrupt = report.dropped.some((record) => record.section === "file");
  const details = [
    ...(result.details ?? []),
    `state path: ${statePath}`,
    ...report.dropped.map((record) =>
      record.section === "file"
        ? `state.json is unreadable: ${record.reason}`
        : `invalid state record ${record.section}["${record.key}"]: ${record.reason}`,
    ),
  ];

  return {
    ...result,
    severity: result.severity === "fail" ? "fail" : "warn",
    summary: fileCorrupt
      ? `state.json is unreadable and will be reset (renamed to state.json.corrupt-*) at next daemon startup; ${result.summary}`
      : `state.json has ${report.dropped.length} invalid record(s) that will be quarantined at next daemon startup; ${result.summary}`,
    details,
    suggestions: [
      ...(result.suggestions ?? []),
      fileCorrupt
        ? "back up the state file before the next daemon start if you want to attempt manual recovery"
        : "the daemon backs the original file up as state.json.quarantine-* before dropping these records",
    ],
    fixes: [createStateQuarantineFix(statePath, daemonRunning, isDaemonRunning)],
  };
}

/**
 * Quarantine repair for invalid/corrupt state.json. run() drives the documented
 * StateStore.load() path (drop bad records, back the original up as
 * .quarantine-* / rename a corrupt file to .corrupt-*). Gated: while the daemon
 * is running it owns state.json and performs this itself at the next start, so
 * the fix is withheld rather than racing it. The gate is re-verified inside
 * run() because a daemon may start between the read-only detection pass and
 * --fix applying the repair.
 */
function createStateQuarantineFix(
  statePath: string,
  daemonRunning: boolean,
  isDaemonRunning: () => Promise<boolean>,
): DoctorFix {
  return {
    id: "state.quarantine",
    title: "quarantine invalid state.json records",
    ...(daemonRunning ? { withheld: "stop the daemon first: xacpx stop" } : {}),
    run: async () => {
      if (await isDaemonRunning()) {
        return {
          ok: false,
          message: "a daemon started since detection; stop it first: xacpx stop",
        };
      }
      const store = new StateStore(statePath);
      await store.load();
      const report = store.lastLoadReport;
      if (!report) {
        return { ok: true, message: "state.json was already valid; nothing to quarantine" };
      }
      if (report.corruptPath) {
        return { ok: true, message: `state.json was unreadable; renamed to ${report.corruptPath} and reset` };
      }
      const backup = report.quarantinePath ? ` (original backed up to ${report.quarantinePath})` : "";
      return {
        ok: true,
        message: `quarantined ${report.dropped.length} invalid state.json record(s)${backup}`,
      };
    },
  };
}

async function defaultIsDaemonRunning(
  home: string,
  runtimePaths: RuntimePaths,
  getDaemonStatus: () => Promise<{ state: string }> = () => defaultGetDaemonStatus(home, runtimePaths),
): Promise<boolean> {
  try {
    const status = await getDaemonStatus();
    // Both "running" AND "indeterminate" mean a LIVE daemon pid:
    // getStatus() only reports "indeterminate" after confirming the process is
    // alive (status.json missing). The state-mutating quarantine must be gated
    // (withheld) in both cases, or --fix would rename/rewrite state.json out
    // from under a live daemon.
    return status.state === "running" || status.state === "indeterminate";
  } catch {
    // If we cannot determine daemon state, do NOT mutate: treat as running so
    // the state-mutating fix is withheld (fail-safe).
    return true;
  }
}

async function defaultGetDaemonStatus(home: string, runtimePaths: RuntimePaths): Promise<{ state: string }> {
  const paths = resolveDaemonPaths({
    home,
    runtimeDir: resolveRuntimeDirFromConfigPath(runtimePaths.configPath),
  });
  const controller = createDaemonController(paths, {
    processExecPath: process.execPath,
    cliEntryPath: process.argv[1] ?? "",
    cwd: process.cwd(),
    env: process.env,
    isProcessRunning: isProcessAlive,
  });
  return await controller.getStatus();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
