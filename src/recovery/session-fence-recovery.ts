import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { coreHomeDir } from "../runtime/core-home";
import { coreEnv } from "../runtime/core-env";
import { resolveRuntimeDirFromConfigPath } from "../daemon/daemon-files";
import { SessionService } from "../sessions/session-service";
import { StateStore } from "../state/state-store";
import { physicalLifecycleKeyForResolvedSession } from "../bridge/engine/runtime/physical-session-identity";
import { probeWindowsProcessIdentity } from "../process/windows-process-tree";
import { OrphanRegistry } from "../transport/orphan-registry";
import { queryJobContainment, windowsJobNameForGeneration } from "../process/windows-job-query";
import { loadConfig } from "../config/load-config";
import { RuntimeWorkerFence, StaleFenceGenerationError } from "../bridge/engine/runtime/runtime-worker-fence";
import type { FenceLiveness, RuntimeWorkerFenceRecord } from "../bridge/engine/runtime/runtime-worker-fence";
import type { ResolvedSession } from "../transport/types";
import type { LogicalSession } from "../state/types";

export type SessionFenceRecoveryEligibility =
  | { kind: "recoverable-terminal-proof" }
  | { kind: "recoverable-contained-proof" }
  | { kind: "recoverable-legacy-orphan-risk" }
  | {
      kind: "refused";
      reason:
        | "deleting"
        | "generation-mismatch"
        | "fence-unreadable"
        | "worker-alive"
        | "worker-unknown"
        | "worker-unproven"
        | "residuals-pending"
        | "residuals-unreadable"
        | "fence-not-admitted"
        | "missing-expected-generation"
        | "missing-legacy-risk-acceptance"
        | "missing-containment-proof";
    };

export interface SessionFenceRecoveryTarget {
  alias: string;
  logicalSession: LogicalSession;
  resolved: ResolvedSession;
  fenceKey: string;
  fencePath: string;
  fenceDir: string;
  sharedAliases: string[];
  fenceRecord: RuntimeWorkerFenceRecord;
}

export interface SessionFenceProbeResult {
  worker: FenceLiveness;
  supervisor?: FenceLiveness;
  residualsRemaining: boolean | null;
  containment: SessionFenceContainment | null;
}

export type SessionFenceContainment = "active" | "empty" | "absent" | "unknown";

export interface SessionFenceRecoveryDecision {
  target: SessionFenceRecoveryTarget;
  eligibility: SessionFenceRecoveryEligibility;
}


function resolveFenceDirForOfflineRecovery(
  input: { fenceDir?: string; durableDir?: string },
  home: string,
): string {
  if (input.fenceDir) return input.fenceDir;
  if (input.durableDir) return join(input.durableDir, "worker-fences");
  const durableRoot = coreEnv("BRIDGE_RUNTIME_DURABLE_DIR") ?? join(coreHomeDir(home), "runtime");
  return coreEnv("BRIDGE_RUNTIME_FENCE_DIR") ?? join(durableRoot, "worker-fences");
}

/**
 * Offline session fence recovery target resolution. The runtime ownership
 * lock is the caller's responsibility: the caller must hold the lock while it
 * resolves the target, inspects/probes, and mutates. Inspect reads without a
 * lock and therefore only returns a point-in-time snapshot.
 */
export async function resolveSessionFenceRecoveryTarget(input: {
  configPath: string;
  statePath: string;
  alias: string;
  home?: string;
  fenceDir?: string;
  durableDir?: string;
}): Promise<
  | SessionFenceRecoveryTarget
  | { kind: "unknown-session"; alias: string }
  | { kind: "unresolvable-session"; alias: string; detail: string }
> {
  const home = input.home ?? homedir();
  const store = new StateStore(input.statePath);
  const inspected = await store.inspect();
  if (inspected.report?.dropped?.length) {
    return { kind: "unresolvable-session", alias: input.alias, detail: "state.json needs repair before recovery" };
  }
  const logicalRecord = inspected.state.sessions[input.alias];
  if (!logicalRecord) {
    return { kind: "unknown-session", alias: input.alias };
  }
  const config = await loadConfig(input.configPath);
  const service = new SessionService(
    config,
    { save: () => Promise.reject(new Error("session fence recovery never writes logical session state")) },
    inspected.state,
    { runtimeRoot: dirname(input.configPath) },
  );
  let resolved: ResolvedSession;
  try {
    const candidate = await service.getSession(input.alias);
    if (!candidate) throw new Error(`session "${input.alias}" is not resolvable`);
    resolved = candidate;
  } catch (error) {
    return {
      kind: "unresolvable-session",
      alias: input.alias,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const fenceDir = input.fenceDir ?? resolveFenceDirForOfflineRecovery({ fenceDir: input.fenceDir, durableDir: input.durableDir }, home);
  const fenceKey = physicalLifecycleKeyForResolvedSession(resolved);
  const fencePath = join(fenceDir, `${encodeURIComponent(fenceKey)}.json`);
  const sharedAliases = Object.values(inspected.state.sessions)
    .filter((candidate) => candidate.alias !== input.alias)
    .map((candidate) => {
      const other = service.getResolvedSessionByInternalAlias(candidate.alias);
      if (!other) return null;
      return physicalLifecycleKeyForResolvedSession(other) === fenceKey ? candidate.alias : null;
    })
    .filter((alias): alias is string => alias !== null)
    .sort();
  const fence = new RuntimeWorkerFence(fenceDir);
  const read = await fence.read(fenceKey);
  if (read.kind === "absent" || read.kind === "unreadable") {
    return {
      kind: "unresolvable-session",
      alias: input.alias,
      detail: read.kind === "absent" ? "no fence record" : `fence unreadable: ${read.reason}`,
    };
  }
  return {
    alias: logicalRecord.alias,
    logicalSession: logicalRecord,
    resolved,
    fenceKey,
    fencePath,
    fenceDir,
    sharedAliases,
    fenceRecord: read.record,
  };
}

export async function probeSessionFenceTarget(
  target: SessionFenceRecoveryTarget,
  configPath: string,
  probes: {
    probeWorker?: (record: RuntimeWorkerFenceRecord) => FenceLiveness | Promise<FenceLiveness>;
    residualsRemaining?: (generationId: string) => Promise<boolean>;
    probeContainment?: (record: RuntimeWorkerFenceRecord) => Promise<SessionFenceContainment>;
  } = {},
): Promise<SessionFenceProbeResult> {
  const record = target.fenceRecord;
  const probeWorker = probes.probeWorker ?? probeFencedWorkerDefault;
  const worker = await probeWorker(record);
  let residualsRemaining: boolean | null = null;
  let containment: SessionFenceContainment | null = null;
  // Any Job-bearing record needs both halves of the containment proof: the
  // supervisor's liveness and the Job itself.
  const jobEvidence = record.jobName !== undefined;
  const supervisor = jobEvidence ? await probeFencedSupervisorDefault(record) : undefined;
  if (jobEvidence) {
    try {
      containment = await (probes.probeContainment ?? probeJobContainmentDefault)(record);
    } catch {
      containment = "unknown";
    }
  }
  if (record.phase === "spooled" || record.phase === "admitted") {
    try {
      const remaining = probes.residualsRemaining
        ?? defaultResidualsRemainingForRecovery(configPath);
      residualsRemaining = await remaining(record.generation);
    } catch {
      residualsRemaining = null;
    }
  }
  return { worker, supervisor, residualsRemaining, containment };
}

function defaultResidualsRemainingForRecovery(
  configPath: string,
): (generationId: string) => Promise<boolean> {
  return async (generationId) => {
    const registry = new OrphanRegistry(resolveRuntimeDirFromConfigPath(configPath));
    const entries = await readdir(join(registry.root, "residuals"), { withFileTypes: true });
    if (entries.some((entry) => entry.name.endsWith(".json") && !entry.name.includes(".tmp-") && !entry.isFile())) {
      throw new Error("residual evidence is not a regular file");
    }
    const records = await registry.readCategory("residuals");
    if (!records) throw new Error("residual records are unreadable");
    return records.some(({ record }) => record.generationId === generationId);
  };
}

async function probeJobContainmentDefault(
  record: RuntimeWorkerFenceRecord,
): Promise<SessionFenceContainment> {
  if (!record.jobName) return "unknown";
  return await queryJobContainment(record.jobName);
}


async function probeFencedSupervisorDefault(record: RuntimeWorkerFenceRecord): Promise<FenceLiveness> {
  // No pid: under the supervisor GO gate this generation was never authorized
  // to create a Job, so nothing can still be waiting to create one.
  if (!record.supervisorPid) return "gone";
  try {
    const result = await probeWindowsProcessIdentity(record.supervisorPid);
    if (result.status !== "found") return result.status === "missing" ? "gone" : "unknown";
    // A pid recorded before its birth (the claim persists the pid; the birth
    // is verified before GO) may still be the process waiting for GO.
    if (!record.supervisorCreationDate) return "alive";
    return result.identity.creationDate === record.supervisorCreationDate ? "alive" : "gone";
  } catch {
    return "unknown";
  }
}

export function decideSessionFenceRecovery(input: {
  record: RuntimeWorkerFenceRecord;
  expectedGeneration?: string;
  acceptLegacyOrphanRisk?: boolean;
  probe: SessionFenceProbeResult;
}): SessionFenceRecoveryEligibility {
  if (!input.expectedGeneration || input.expectedGeneration.trim().length === 0) {
    return { kind: "refused", reason: "missing-expected-generation" };
  }
  if (input.record.phase === "deleting") {
    return { kind: "refused", reason: "deleting" };
  }
  if (input.record.generation !== input.expectedGeneration) {
    return { kind: "refused", reason: "generation-mismatch" };
  }
  const canonical = windowsJobNameForGeneration(input.record.generation);
  // A Job-bearing record's Job name must be the generation's canonical name:
  // an arbitrary name could point at someone else's containment.
  if (input.record.jobName !== undefined && input.record.jobName !== canonical) {
    return { kind: "refused", reason: "missing-containment-proof" };
  }
  // Spooled fences additionally prove their generation's residual namespace
  // is empty; the Job proof below still applies when the record carries one.
  if (input.record.phase === "spooled") {
    if (input.probe.residualsRemaining === null) return { kind: "refused", reason: "residuals-unreadable" };
    if (input.probe.residualsRemaining) return { kind: "refused", reason: "residuals-pending" };
  }
  // Job evidence: the supervisor must be provably gone and the Job empty or
  // absent. This covers every ownership phase — claiming (no supervisor was
  // ever authorized under the GO gate when no pid is recorded), owned (the
  // supervisor may hold the Job without a persisted birth), admitted, and the
  // terminal phases a crashed recovery can leave behind.
  if (input.record.jobName !== undefined) {
    if (input.probe.supervisor === "alive" || input.probe.containment === "active") {
      return { kind: "refused", reason: "worker-alive" };
    }
    if (input.probe.supervisor !== "gone") return { kind: "refused", reason: "missing-containment-proof" };
    if (input.probe.containment !== "empty" && input.probe.containment !== "absent") {
      return { kind: "refused", reason: "missing-containment-proof" };
    }
    // An admitted, attested fence additionally names a business-capable
    // worker; its birth must be proven gone too (the Job alone could be empty
    // while a pre-Job worker still lives only if attestation were wrong, so
    // keep the explicit worker proof for that phase).
    if (input.record.phase === "admitted" && input.record.jobAttested === true) {
      if (input.probe.worker === "alive") return { kind: "refused", reason: "worker-alive" };
      if (input.probe.worker !== "gone") return { kind: "refused", reason: "worker-unknown" };
    }
    // A claiming record's pid is the claimant host and an unauthorized owned
    // record's pid is its supervisor: the recorded pid must be gone as well.
    if (input.record.phase !== "admitted" && input.probe.worker !== "gone") {
      return { kind: "refused", reason: input.probe.worker === "alive" ? "worker-alive" : "worker-unknown" };
    }
    return { kind: "recoverable-contained-proof" };
  }
  if (input.record.phase === "discharged" || input.record.phase === "spooled") {
    if (input.probe.worker === "alive") return { kind: "refused", reason: "worker-alive" };
    if (input.probe.worker !== "gone") return { kind: "refused", reason: "worker-unknown" };
    return { kind: "recoverable-terminal-proof" };
  }
  if (input.record.phase !== "admitted") {
    return { kind: "refused", reason: "fence-not-admitted" };
  }
  if (input.probe.worker === "alive") return { kind: "refused", reason: "worker-alive" };
  if (input.probe.worker === "unknown") return { kind: "refused", reason: "worker-unknown" };
  if (!input.record.creationDate) return { kind: "refused", reason: "worker-unproven" };
  if (!input.acceptLegacyOrphanRisk) {
    return { kind: "refused", reason: "missing-legacy-risk-acceptance" };
  }
  if (input.probe.residualsRemaining === null) return { kind: "refused", reason: "residuals-unreadable" };
  if (input.probe.residualsRemaining) return { kind: "refused", reason: "residuals-pending" };
  return { kind: "recoverable-legacy-orphan-risk" };
}

export async function recoverSessionFence(input: {
  target: SessionFenceRecoveryTarget;
  configPath: string;
  expectedGeneration: string;
  acceptLegacyOrphanRisk?: boolean;
  probe?: SessionFenceProbeResult;
  probeWorker?: (record: RuntimeWorkerFenceRecord) => FenceLiveness | Promise<FenceLiveness>;
  residualsRemaining?: (generationId: string) => Promise<boolean>;
  probeContainment?: (record: RuntimeWorkerFenceRecord) => Promise<SessionFenceContainment>;
  now?: () => string;
}): Promise<SessionFenceRecoveryDecision & { backupPath?: string }> {
  const fence = new RuntimeWorkerFence(input.target.fenceDir);
  const current = await fence.read(input.target.fenceKey);
  if (current.kind !== "present") {
    return { target: input.target, eligibility: { kind: "refused", reason: "fence-unreadable" } };
  }
  if (current.record.generation !== input.expectedGeneration || current.record.generation !== input.target.fenceRecord.generation) {
    return { target: input.target, eligibility: { kind: "refused", reason: "generation-mismatch" } };
  }
  if (current.record.phase !== input.target.fenceRecord.phase) {
    return { target: input.target, eligibility: { kind: "refused", reason: current.record.phase === "deleting" ? "deleting" : "fence-not-admitted" } };
  }
  const probe = input.probe ?? await probeSessionFenceTarget(input.target, input.configPath, {
    ...(input.probeWorker ? { probeWorker: input.probeWorker } : {}),
    ...(input.residualsRemaining ? { residualsRemaining: input.residualsRemaining } : {}),
    ...(input.probeContainment ? { probeContainment: input.probeContainment } : {}),
  });
  const eligibility = decideSessionFenceRecovery({
    record: input.target.fenceRecord,
    expectedGeneration: input.expectedGeneration,
    acceptLegacyOrphanRisk: input.acceptLegacyOrphanRisk,
    probe,
  });
  if (eligibility.kind === "refused") {
    return { target: input.target, eligibility };
  }
  const attemptedAt = input.now?.() ?? new Date().toISOString();
  const backupPath = join(
    dirname(input.target.fencePath),
    `${basename(input.target.fencePath)}.bak-${attemptedAt.replace(/[^0-9a-zA-Z-]+/g, "-")}-${randomUUID()}`,
  );
  await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
  const original = await readFile(input.target.fencePath);
  const backup = await open(backupPath, "wx", 0o600);
  try {
    await backup.writeFile(original);
    await backup.sync();
  } finally {
    await backup.close();
  }
  const auditPath = `${backupPath}.audit.json`;
  const auditRecord = { attemptedAt, recovery: eligibility.kind, sessionAlias: input.target.alias, generation: input.expectedGeneration };
  await writeRecoveryAudit(auditPath, { ...auditRecord, outcome: "attempted" });
  try {
    await fence.compareAndSwap(
      input.target.fenceKey,
      { generation: input.expectedGeneration, from: [input.target.fenceRecord.phase] },
      { ...input.target.fenceRecord, phase: "discharged" },
    );
    await fence.retire(input.target.fenceKey, input.expectedGeneration, "discharged");
  } catch (error) {
    if (!(error instanceof StaleFenceGenerationError)) throw error;
    return { target: input.target, eligibility: { kind: "refused", reason: "generation-mismatch" }, backupPath };
  }
  const reread = await fence.read(input.target.fenceKey);
  if (reread.kind !== "absent") {
    throw new Error(`session fence recovery left evidence for "${input.target.fenceKey}" (${reread.kind})`);
  }
  await writeRecoveryAudit(auditPath, { ...auditRecord, outcome: "applied", recoveredAt: input.now?.() ?? new Date().toISOString() }, true);
  return { target: input.target, eligibility, backupPath };
}

async function writeRecoveryAudit(path: string, record: object, replace = false): Promise<void> {
  const destination = replace ? `${path}.tmp-${randomUUID()}` : path;
  const audit = await open(destination, "wx", 0o600);
  try {
    await audit.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await audit.sync();
  } finally {
    await audit.close();
  }
  if (replace) await rename(destination, path);
}

/**
 * Fenced pid liveness. With a birth the comparison proves replacement; without
 * one (pre-spawn claims, unauthorized owned records) only absence proves gone
 * and a found pid — even a reused one — still blocks recovery.
 */
async function probeFencedWorkerDefault(record: RuntimeWorkerFenceRecord): Promise<FenceLiveness> {
  if (!record.pid || record.pid <= 0) return "unknown";
  try {
    const res = await probeWindowsProcessIdentity(record.pid);
    if (res.status !== "found") return res.status === "missing" ? "gone" : "unknown";
    if (!record.creationDate) return "alive";
    return res.identity.creationDate === record.creationDate ? "alive" : "gone";
  } catch {
    return "unknown";
  }
}
