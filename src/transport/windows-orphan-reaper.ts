import {
  probeWindowsProcessIdentity,
  snapshotWindowsProcessesByToken,
  terminateWindowsProcessTree,
  terminateWindowsResidual,
  type KillOutcome,
  type ProcessTreeOutcome,
  type WindowsProcessWorkerOptions,
  type WindowsTokenProcess,
} from "../process/windows-process-tree";
import {
  OrphanRegistry,
  type LaunchIntentRecord,
  type OwnerRecord,
  type ResidualRecord,
} from "./orphan-registry";

const TERMINAL = new Set<KillOutcome>(["killed", "already-exited", "skipped-replaced"]);
const RESIDUAL = new Set<KillOutcome>(["kill-requested-unconfirmed", "access-denied", "query-failed"]);
const ROOT_RETRY = new Set<KillOutcome>(["kill-requested-unconfirmed", "access-denied"]);

export interface WindowsOrphanSweepResult {
  ownersDeleted: number;
  ownersRetained: number;
  residualsDeleted: number;
  residualsRetained: number;
  intentsDeleted: number;
  intentsRetained: number;
  degraded: boolean;
}

export interface WindowsOrphanReaperDeps extends WindowsProcessWorkerOptions {
  now?: () => number;
  snapshotToken?: typeof snapshotWindowsProcessesByToken;
  probeIdentity?: typeof probeWindowsProcessIdentity;
  terminateTree?: typeof terminateWindowsProcessTree;
  terminateResidual?: typeof terminateWindowsResidual;
  onWarning?: (message: string, error?: unknown) => void;
}

/**
 * Reconcile durable Windows ownership evidence. Every automatic kill is gated by
 * independently captured identity, and every uncertain read retains its record.
 */
export async function sweepWindowsOrphans(
  registry: OrphanRegistry,
  currentGenerationId: string,
  deps: WindowsOrphanReaperDeps = {},
): Promise<WindowsOrphanSweepResult> {
  const result: WindowsOrphanSweepResult = {
    ownersDeleted: 0,
    ownersRetained: 0,
    residualsDeleted: 0,
    residualsRetained: 0,
    intentsDeleted: 0,
    intentsRetained: 0,
    degraded: false,
  };
  const generation = await registry.readGeneration();
  if (generation?.generationId === currentGenerationId && generation.terminating) {
    return result;
  }
  const intents = await registry.readCategory("intents");
  if (!intents) return unreadable(result, deps, "intent registry is unreadable");
  for (const { record } of intents) {
    try { await reconcileIntent(registry, record as LaunchIntentRecord, currentGenerationId, result, deps); }
    catch (error) { retainDegraded(result, deps, "intent reconciliation failed", error); }
  }

  const owners = await registry.readCategory("owners");
  if (!owners) return unreadable(result, deps, "owner registry is unreadable");
  for (const { filename, record } of owners) {
    try { await reconcileOwner(registry, filename, record as OwnerRecord, result, deps); }
    catch (error) { retainDegraded(result, deps, "owner reconciliation failed", error); }
  }

  const residuals = await registry.readCategory("residuals");
  if (!residuals) return unreadable(result, deps, "residual registry is unreadable");
  for (const { filename, record } of residuals) {
    try { await reconcileResidual(registry, filename, record as ResidualRecord, result, deps); }
    catch (error) { retainDegraded(result, deps, "residual reconciliation failed", error); }
  }
  return result;
}

async function reconcileIntent(
  registry: OrphanRegistry,
  intent: LaunchIntentRecord,
  currentGenerationId: string,
  result: WindowsOrphanSweepResult,
  deps: WindowsOrphanReaperDeps,
): Promise<void> {
  const oldEnough = (deps.now?.() ?? Date.now()) - Date.parse(intent.createdAt) > 60_000;
  if (!oldEnough || intent.generationId === currentGenerationId) {
    result.intentsRetained += 1;
    return;
  }
  const snapshot = await snapshotToken(intent.token, deps);
  if (snapshot === null) {
    retainDegraded(result, deps, "token snapshot unavailable while reconciling intent");
    result.intentsRetained += 1;
    return;
  }
  if (snapshot.length > 0) {
    result.intentsRetained += 1;
    return;
  }
  const launcher = await probeIdentity(intent.launcherPid, deps);
  if (launcher.status === "unavailable") {
    retainDegraded(result, deps, "launcher identity unavailable while reconciling intent");
    result.intentsRetained += 1;
    return;
  }
  if (launcher.status === "found" && launcher.identity.creationDate === intent.launcherCreationDate) {
    result.intentsRetained += 1;
    return;
  }
  await registry.deleteIntent(intent.token);
  result.intentsDeleted += 1;
}

async function reconcileOwner(
  registry: OrphanRegistry,
  filename: string,
  owner: OwnerRecord,
  result: WindowsOrphanSweepResult,
  deps: WindowsOrphanReaperDeps,
): Promise<void> {
  if (!owner.fingerprint) {
    result.ownersRetained += 1;
    retainDegraded(result, deps, "owner has no killable fingerprint");
    return;
  }
  const snapshot = await snapshotToken(owner.token, deps);
  if (snapshot === null) {
    result.ownersRetained += 1;
    retainDegraded(result, deps, "token snapshot unavailable while reconciling owner");
    return;
  }
  const tokenOwner = snapshot.find((process) => process.pid === owner.pid);
  const identity = await probeIdentity(owner.pid, deps);
  if (identity.status === "unavailable") {
    result.ownersRetained += 1;
    retainDegraded(result, deps, "owner identity unavailable");
    return;
  }
  if (identity.status === "missing" || (identity.status === "found" && !sameOwnerIdentity(owner, identity.identity))) {
    // A complete token snapshot must also be empty: otherwise a descendant still
    // carries the only durable ownership token and deleting the record would lose it.
    if (snapshot.length > 0) {
      result.ownersRetained += 1;
      return;
    }
    await registry.deleteOwner(filename);
    result.ownersDeleted += 1;
    return;
  }
  if (!tokenOwner || !sameTokenFingerprint(owner, tokenOwner)) {
    result.ownersRetained += 1;
    return;
  }

  const terminateTree = deps.terminateTree ?? terminateWindowsProcessTree;
  const batch = await terminateTree({
    pid: owner.pid,
    creationDate: owner.fingerprint.creationDate,
    commandLine: owner.fingerprint.commandLine,
    executablePath: owner.fingerprint.executablePath,
  }, workerOptions(deps));
  if (!isKnownOutcome(batch.rootOutcome) || batch.outcomes.some((entry) => !isKnownOutcome(entry.outcome))) {
    result.ownersRetained += 1;
    return;
  }
  if (batch.rootOutcome === "query-failed") {
    await registry.writeOwner({ ...owner, killAttempts: owner.killAttempts + 1 });
    result.ownersRetained += 1;
    return;
  }
  if (!TERMINAL.has(batch.rootOutcome) && !ROOT_RETRY.has(batch.rootOutcome)) {
    result.ownersRetained += 1;
    return;
  }
  const residuals = buildResiduals(owner, batch.outcomes);
  if (residuals === null) {
    await registry.writeOwner({ ...owner, killAttempts: owner.killAttempts + 1 });
    result.ownersRetained += 1;
    return;
  }
  if (TERMINAL.has(batch.rootOutcome)) {
    await registry.migrateOwnerToResiduals(filename, residuals);
    result.ownersDeleted += 1;
    return;
  }
  for (const residual of residuals) await registry.writeResidual(residual);
  await registry.writeOwner({ ...owner, killAttempts: owner.killAttempts + 1 });
  result.ownersRetained += 1;
}

function buildResiduals(owner: OwnerRecord, outcomes: ProcessTreeOutcome[]): ResidualRecord[] | null {
  const residuals: ResidualRecord[] = [];
  for (const entry of outcomes) {
    if (entry.target.pid === owner.pid || TERMINAL.has(entry.outcome)) continue;
    if (!RESIDUAL.has(entry.outcome) || !entry.target.creationDate || !entry.commandLine || !entry.executablePath) return null;
    residuals.push({
      kind: "residual",
      ownerToken: owner.token,
      pid: entry.target.pid,
      creationDate: entry.target.creationDate,
      commandLine: entry.commandLine,
      executablePath: entry.executablePath,
      agentCommand: owner.agentCommand,
      generationId: owner.generationId,
      killAttempts: 0,
    });
  }
  return residuals;
}

async function reconcileResidual(
  registry: OrphanRegistry,
  filename: string,
  residual: ResidualRecord,
  result: WindowsOrphanSweepResult,
  deps: WindowsOrphanReaperDeps,
): Promise<void> {
  const terminate = deps.terminateResidual ?? terminateWindowsResidual;
  const outcome = await terminate({
    pid: residual.pid,
    creationDate: residual.creationDate,
    commandLine: residual.commandLine,
    executablePath: residual.executablePath,
  }, workerOptions(deps));
  if (TERMINAL.has(outcome)) {
    await registry.deleteResidual(filename);
    result.residualsDeleted += 1;
    return;
  }
  await registry.writeResidual({ ...residual, killAttempts: residual.killAttempts + 1 });
  result.residualsRetained += 1;
  if (!isKnownOutcome(outcome) || outcome === "query-failed" || outcome === "access-denied") {
    retainDegraded(result, deps, "residual identity or termination unavailable");
  }
}

function sameOwnerIdentity(owner: OwnerRecord, identity: { creationDate: string; executablePath: string }): boolean {
  return owner.fingerprint !== null
    && identity.creationDate === owner.fingerprint.creationDate
    && identity.executablePath.toLocaleLowerCase("en-US") === owner.fingerprint.executablePath.toLocaleLowerCase("en-US");
}

function sameTokenFingerprint(owner: OwnerRecord, process: WindowsTokenProcess): boolean {
  return owner.fingerprint !== null
    && process.commandLine === owner.fingerprint.commandLine;
}

function isKnownOutcome(value: unknown): value is KillOutcome {
  return typeof value === "string" && (TERMINAL.has(value as KillOutcome)
    || RESIDUAL.has(value as KillOutcome));
}

function workerOptions(deps: WindowsOrphanReaperDeps): WindowsProcessWorkerOptions {
  return { ...(deps.workerDeadlineMs === undefined ? {} : { workerDeadlineMs: deps.workerDeadlineMs }),
    ...(deps.runWorker === undefined ? {} : { runWorker: deps.runWorker }) };
}

async function snapshotToken(token: string, deps: WindowsOrphanReaperDeps): Promise<WindowsTokenProcess[] | null> {
  return await (deps.snapshotToken ?? snapshotWindowsProcessesByToken)(token, workerOptions(deps));
}

async function probeIdentity(pid: number, deps: WindowsOrphanReaperDeps) {
  return await (deps.probeIdentity ?? probeWindowsProcessIdentity)(pid, workerOptions(deps));
}

function retainDegraded(result: WindowsOrphanSweepResult, deps: WindowsOrphanReaperDeps, message: string, error?: unknown): void {
  result.degraded = true;
  deps.onWarning?.(message, error);
}

function unreadable(result: WindowsOrphanSweepResult, deps: WindowsOrphanReaperDeps, message: string): WindowsOrphanSweepResult {
  retainDegraded(result, deps, message);
  return result;
}
