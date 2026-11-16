import { homedir } from "node:os";

import { resolveRuntimeDirFromConfigPath, resolveRuntimeConsumerLockPath } from "../daemon/daemon-files";
import { createRuntimeConsumerLock } from "../daemon/runtime-consumer-lock";
import { setLocale, resolveLocale, t } from "../i18n";
import { resolveRuntimePaths } from "../main";
import {
  probeSessionFenceTarget,
  recoverSessionFence,
  resolveFenceDirForOfflineRecovery,
  resolveSessionFenceRecoveryTarget,
  sweepSessionFences,
} from "./session-fence-recovery";
import type { SessionFenceRecoveryEligibility, SessionFenceRecoveryTarget } from "./session-fence-recovery";

export interface SessionFenceCliArgs {
  inspect?: string;
  recover?: string;
  /** Sweep every durable fence instead of one alias. */
  all?: boolean;
  /** Report the sweep's decisions without touching any fence. */
  dryRun?: boolean;
  expectedGeneration?: string;
  acceptLegacyOrphanRisk?: boolean;
  fenceDir?: string;
  durableDir?: string;
}

const USAGE_LINES = [
  "Usage: xacpx session inspect <alias>",
  "Usage: xacpx session recover <alias> --expected-generation <generation> [--accept-legacy-orphan-risk]",
  "Usage: xacpx session recover --all [--dry-run] [--accept-legacy-orphan-risk]",
];

export function parseSessionFenceCliArgs(args: string[]): SessionFenceCliArgs | null {
  const action = args[0];
  const target = args[1];
  if (action !== "inspect" && action !== "recover") return null;
  const sweep = action === "recover" && target === "--all";
  if (!sweep && (!target || target.startsWith("--") || target === "inspect" || target === "recover")) return null;
  const parsed: SessionFenceCliArgs = sweep ? { all: true } : { [action]: target };
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index++) {
    const flag = args[index]!;
    if (seen.has(flag)) return null;
    seen.add(flag);
    if (flag === "--accept-legacy-orphan-risk") {
      if (action !== "recover") return null;
      parsed.acceptLegacyOrphanRisk = true;
      continue;
    }
    if (flag === "--dry-run") {
      // A dry run only means something for the sweep; an alias recovery is
      // already a single, deliberate, confirmed action.
      if (!sweep) return null;
      parsed.dryRun = true;
      continue;
    }
    if (flag !== "--expected-generation" && flag !== "--fence-dir" && flag !== "--durable-dir") return null;
    const value = args[++index];
    if (!value || !value.trim() || value.startsWith("--") || value === "inspect" || value === "recover") return null;
    if (flag === "--expected-generation") {
      if (action !== "recover" || sweep) return null;
      parsed.expectedGeneration = value;
    } else if (flag === "--fence-dir") {
      parsed.fenceDir = value;
    } else {
      parsed.durableDir = value;
    }
  }
  if (action === "recover" && !sweep && !parsed.expectedGeneration) return null;
  return parsed;
}

function eligibilityLine(eligibility: SessionFenceRecoveryEligibility): string {
  if (eligibility.kind === "refused") return `refused: ${eligibility.reason}`;
  return eligibility.kind;
}

function renderTarget(target: SessionFenceRecoveryTarget): string[] {
  const record = target.fenceRecord;
  return [
    `alias: ${target.alias}`,
    `logical_session_id: ${target.logicalSession.logical_session_id}`,
    `physical fence key: ${target.fenceKey}`,
    `fence path: ${target.fencePath}`,
    `transport engine: ${target.resolved.transportEngine ?? "(unresolved)"}`,
    `shared aliases: ${target.sharedAliases.length > 0 ? target.sharedAliases.join(", ") : "(none)"}`,
    `generation: ${record.generation}`,
    `phase: ${record.phase}`,
    `worker pid: ${record.pid ?? "?"} creationDate: ${record.creationDate ?? "?"}`,
    `job attestation: ${record.jobName ?? "(none)"} attested=${record.jobAttested === true}`,
    `supervisor pid: ${record.supervisorPid ?? "(none)"}`,
  ];
}

export async function runSessionFenceCli(args: string[], deps: {
  print: (line: string) => void;
  stderr?: (text: string) => void;
  platform?: NodeJS.Platform;
}): Promise<number> {
  const parsed = parseSessionFenceCliArgs(args);
  if (!parsed) {
    for (const line of USAGE_LINES) deps.print(line);
    return 1;
  }
  setLocale(resolveLocale({ configLanguage: process.env.XACPX_LANG }));
  const paths = resolveRuntimePaths();
  const configPath = paths.configPath;
  const statePath = paths.statePath;

  if (parsed.inspect) {
    const target = await resolveSessionFenceRecoveryTarget({
      configPath,
      statePath,
      alias: parsed.inspect,
      fenceDir: parsed.fenceDir,
      durableDir: parsed.durableDir,
    });
    if ("kind" in target) {
      if (target.kind === "unresolvable-session") {
        deps.print(`unresolvable session "${target.alias}": ${target.detail}`);
      } else {
        deps.print(`unknown session "${target.alias}"`);
      }
      return 1;
    }
    for (const line of renderTarget(target)) deps.print(line);
    const probe = await probeSessionFenceTarget(target, configPath);
    deps.print(`worker liveness: ${probe.worker}`);
    if (probe.containment !== null) {
      deps.print(`job containment: ${probe.containment}`);
    }
    if (probe.residualsRemaining !== null) {
      deps.print(`spooled residuals pending: ${probe.residualsRemaining}`);
    }
    return 0;
  }
  if ((deps.platform ?? process.platform) !== "win32") {
    // The recovery proof set (Job containment, supervisor birth, Windows
    // process identity) has no POSIX equivalent here; POSIX runtimes discharge
    // their own fences through the process-group gate. Refuse rather than run
    // probes that can only answer "unknown".
    (deps.stderr ?? deps.print)(t().cli.recoverWindowsOnly);
    return 1;
  }

  const recoverInput = parsed.recover ?? "";
  const lockPath = resolveRuntimeConsumerLockPath(resolveRuntimeDirFromConfigPath(configPath));
  // A dry run mutates nothing, so it must not require stopping a live daemon:
  // its whole point is answering "what would a sweep do" without downtime. The
  // report is a point-in-time snapshot, which the caller is told.
  const lock = createRuntimeConsumerLock({ lockFilePath: lockPath });
  const lockHeld = parsed.dryRun !== true;
  if (lockHeld) {
    try {
      await lock.acquire({
        pid: process.pid,
        mode: "foreground",
        startedAt: new Date().toISOString(),
        configPath,
        statePath,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      deps.stderr?.(`${t().cli.recoverLockBusy}${detail ? ` (${detail})` : ""}\n`);
      deps.print(t().cli.recoverLockBusyHint);
      return 1;
    }
  }
  try {
    if (parsed.all) {
      const fenceDir = parsed.fenceDir ?? resolveFenceDirForOfflineRecovery(
        parsed.durableDir === undefined ? {} : { durableDir: parsed.durableDir },
        homedir(),
      );
      const entries = await sweepSessionFences({
        configPath,
        fenceDir,
        acceptLegacyOrphanRisk: parsed.acceptLegacyOrphanRisk === true,
        ...(parsed.dryRun === true ? { dryRun: true } : {}),
      });
      for (const entry of entries) {
        deps.print([
          `fence: ${entry.fenceKey}`,
          `phase: ${entry.phase ?? "(unreadable)"}`,
          ...(entry.pid === undefined ? [] : [`pid: ${entry.pid}`]),
          `-> ${eligibilityLine(entry.eligibility)}`,
          ...(entry.backupPath === undefined ? [] : [`backup: ${entry.backupPath}`]),
        ].join("  "));
      }
      const recovered = entries.filter((entry) => entry.eligibility.kind !== "refused").length;
      deps.print(
        `swept ${entries.length} fence(s): ${recovered} ` +
          `${parsed.dryRun === true ? "recoverable (dry run, nothing written)" : "recovered"}, ` +
          `${entries.length - recovered} refused`,
      );
      return 0;
    }
    const target = await resolveSessionFenceRecoveryTarget({
      configPath,
      statePath,
      alias: recoverInput,
      fenceDir: parsed.fenceDir,
      durableDir: parsed.durableDir,
    });
    if ("kind" in target) {
      if (target.kind === "unresolvable-session") {
        deps.print(`unresolvable session "${target.alias}": ${target.detail}`);
      } else {
        deps.print(`unknown session "${target.alias}"`);
      }
      return 1;
    }
    const recoveryTarget = target;
    const decision = await recoverSessionFence({
      target: recoveryTarget,
      configPath,
      expectedGeneration: parsed.expectedGeneration!,
      acceptLegacyOrphanRisk: parsed.acceptLegacyOrphanRisk,
    });
    if (decision.eligibility.kind === "refused") {
      deps.print(`recovery refused: ${decision.eligibility.reason}`);
      for (const line of renderTarget(decision.target)) deps.print(line);
      if (decision.backupPath) deps.print(`fence backup: ${decision.backupPath}`);
      return 1;
    }
    deps.print(`recovery applied: ${eligibilityLine(decision.eligibility)}`);
    if (decision.backupPath) deps.print(`fence backup: ${decision.backupPath}`);
    return 0;
  } finally {
    if (lockHeld) await lock.release();
  }
}
