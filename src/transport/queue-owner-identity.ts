import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { promisify } from "node:util";

/**
 * Birth-identity proof for an acpx queue-owner lease (`~/.acpx/queues/<hash>.lock`).
 *
 * acpx 0.19.x leases carry a `processIdentity` (birth identity of the owner
 * process) and may carry a `retirement` receipt; 0.16 leases carry only
 * pid/sessionId/generation. A PID alone is not proof of ownership: the PID may
 * have been reused by an unrelated process, and the lock may belong to a
 * successor owner. This module decides whether a lease can be terminated (and
 * its lock unlinked) without touching a process or lock xacpx cannot prove it
 * owns.
 *
 * Identity formats mirror acpx `src/process-identity.ts`:
 *  - `posix-lstart`: canonical UTC ISO string built from `ps lstart` fields.
 *  - `linux-proc`: /proc scope (bootId, pid/time namespace) plus startTicks.
 *  - `windows-creation`: not verifiable here; Windows stays fail-closed.
 */

const CANONICAL_POSIX_LSTART = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/;
const LSTART_OUTPUT = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/;
const POSIX_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const NAMESPACE_LINK = /^(?:pid|time):\[[1-9]\d*\]$/;

const execFileAsync = promisify(execFile);

export interface QueueOwnerProcessIdentity {
  kind: string;
  value?: string;
  bootId?: string;
  pidNamespace?: string;
  timeNamespace?: string;
  startTicks?: string;
}

export interface QueueOwnerLock {
  pid: number;
  sessionId: string;
  ownerGeneration?: number;
  processIdentity?: QueueOwnerProcessIdentity;
  retirement?: unknown;
}

export type QueueOwnerLockProof =
  /** The live process at the lock's pid is provably this session's owner. */
  | { kind: "current-owner" }
  /** The lock's owner process is provably gone; the lease is stale. */
  | { kind: "stale-owner" }
  /** Ownership cannot be proven. Callers MUST NOT kill or unlink. */
  | { kind: "unverifiable"; reason: string };

export interface ProveQueueOwnerLockDeps {
  /** Runs `ps -p <pid> -o lstart=`; null means "no such process". */
  runPs?: (pid: number) => Promise<string | null>;
  /** Reads a /proc file; null on ENOENT. Throws on other errors. */
  readProcFile?: (path: string) => Promise<string | null>;
  /** Reads a /proc symlink target; null on ENOENT. */
  readProcLink?: (path: string) => Promise<string | null>;
}

export function parseQueueOwnerLock(raw: unknown): QueueOwnerLock | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) {
    return null;
  }
  if (typeof record.sessionId !== "string" || record.sessionId.length === 0) {
    return null;
  }
  if (
    record.ownerGeneration !== undefined &&
    (typeof record.ownerGeneration !== "number" || !Number.isInteger(record.ownerGeneration))
  ) {
    return null;
  }
  let processIdentity: QueueOwnerProcessIdentity | undefined;
  if (record.processIdentity !== undefined) {
    if (!record.processIdentity || typeof record.processIdentity !== "object") {
      return null;
    }
    const identity = record.processIdentity as Record<string, unknown>;
    if (typeof identity.kind !== "string") {
      return null;
    }
    processIdentity = {
      kind: identity.kind,
      ...(typeof identity.value === "string" ? { value: identity.value } : {}),
      ...(typeof identity.bootId === "string" ? { bootId: identity.bootId } : {}),
      ...(typeof identity.pidNamespace === "string" ? { pidNamespace: identity.pidNamespace } : {}),
      ...(typeof identity.timeNamespace === "string" ? { timeNamespace: identity.timeNamespace } : {}),
      ...(typeof identity.startTicks === "string" ? { startTicks: identity.startTicks } : {}),
    };
  }
  return {
    pid: record.pid,
    sessionId: record.sessionId,
    ...(record.ownerGeneration !== undefined ? { ownerGeneration: record.ownerGeneration } : {}),
    ...(processIdentity ? { processIdentity } : {}),
    ...(record.retirement != null ? { retirement: record.retirement } : {}),
  };
}

/** True when two parsed locks describe the same lease (heartbeat-exempt). */
export function sameQueueOwnerLock(left: QueueOwnerLock, right: QueueOwnerLock): boolean {
  return (
    left.pid === right.pid &&
    left.sessionId === right.sessionId &&
    left.ownerGeneration === right.ownerGeneration &&
    JSON.stringify(left.processIdentity) === JSON.stringify(right.processIdentity)
  );
}

/** Mirrors acpx `posixBirth`: parse `ps lstart` fields as UTC wall time. */
export function posixLstartToUtc(output: string): string | undefined {
  const match = LSTART_OUTPUT.exec(output.trim());
  if (!match) {
    return undefined;
  }
  const [, month, day, hour, minute, second, year] = match;
  const monthIndex = POSIX_MONTHS.indexOf(month!);
  if (monthIndex < 0) {
    return undefined;
  }
  const value = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${day!.padStart(2, "0")}T${hour}:${minute}:${second}.000Z`;
  return CANONICAL_POSIX_LSTART.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
}

export async function proveQueueOwnerLock(
  lock: QueueOwnerLock,
  sessionId: string,
  deps: ProveQueueOwnerLockDeps = {},
): Promise<QueueOwnerLockProof> {
  if (lock.sessionId !== sessionId) {
    return { kind: "unverifiable", reason: "lease names a different session" };
  }
  if (lock.retirement != null) {
    return { kind: "unverifiable", reason: "owner is retiring under acpx custody" };
  }
  const identity = lock.processIdentity;
  if (!identity) {
    // 0.16-era lease: no birth identity to prove ownership with.
    return { kind: "unverifiable", reason: "lease carries no birth identity" };
  }
  if (identity.kind === "posix-lstart") {
    return await provePosixLstart(lock.pid, identity.value, deps);
  }
  if (identity.kind === "linux-proc") {
    return await proveLinuxProc(lock.pid, identity, deps);
  }
  return { kind: "unverifiable", reason: `unsupported birth identity kind "${identity.kind}"` };
}

async function provePosixLstart(
  pid: number,
  value: string | undefined,
  deps: ProveQueueOwnerLockDeps,
): Promise<QueueOwnerLockProof> {
  if (typeof value !== "string" || !CANONICAL_POSIX_LSTART.test(value)) {
    return { kind: "unverifiable", reason: "malformed posix-lstart identity" };
  }
  const observed = await runPs(pid, deps);
  if (observed === null) {
    return { kind: "stale-owner" };
  }
  if (observed === undefined) {
    return { kind: "unverifiable", reason: "process start time could not be read" };
  }
  const observedUtc = posixLstartToUtc(observed);
  if (!observedUtc) {
    return { kind: "unverifiable", reason: "unparseable ps lstart output" };
  }
  return observedUtc === value
    ? { kind: "current-owner" }
    : { kind: "unverifiable", reason: "pid was reused by a different process" };
}

async function proveLinuxProc(
  pid: number,
  identity: QueueOwnerProcessIdentity,
  deps: ProveQueueOwnerLockDeps,
): Promise<QueueOwnerLockProof> {
  const readProcFile = deps.readProcFile ?? defaultReadProcFile;
  const readProcLink = deps.readProcLink ?? defaultReadProcLink;

  let stat: string | null;
  try {
    stat = await readProcFile(`/proc/${pid}/stat`);
  } catch {
    return { kind: "unverifiable", reason: "cannot read /proc stat for owner pid" };
  }
  if (stat === null) {
    return { kind: "stale-owner" };
  }
  const startTicks = linuxStartTicks(stat);
  if (!startTicks) {
    return { kind: "unverifiable", reason: "cannot parse /proc stat start time" };
  }

  let bootId: string | null;
  try {
    bootId = await readProcFile("/proc/sys/kernel/random/boot_id");
  } catch {
    return { kind: "unverifiable", reason: "cannot read boot id" };
  }
  if (typeof identity.bootId !== "string" || !bootId || bootId.trim() !== identity.bootId) {
    // A different boot means the lock predates this boot; its pid is meaningless.
    return { kind: "stale-owner" };
  }

  for (const [ns, expected] of [
    ["pid", identity.pidNamespace],
    ["time", identity.timeNamespace],
  ] as const) {
    let observed: string | null;
    try {
      observed = await readProcLink(`/proc/${pid}/ns/${ns}`);
    } catch {
      return { kind: "unverifiable", reason: `cannot read /proc ${ns} namespace` };
    }
    if (typeof expected !== "string" || !(expected === "unsupported" || NAMESPACE_LINK.test(expected))) {
      return { kind: "unverifiable", reason: "malformed namespace scope in lease" };
    }
    if (observed === null) {
      // Kernels without the namespace report ENOENT; acpx records "unsupported".
      if (expected !== "unsupported") {
        return { kind: "unverifiable", reason: `owner ${ns} namespace is gone` };
      }
      continue;
    }
    if (observed !== expected) {
      return { kind: "unverifiable", reason: `owner ${ns} namespace differs` };
    }
  }

  return startTicks === identity.startTicks
    ? { kind: "current-owner" }
    : { kind: "unverifiable", reason: "pid was reused by a different process" };
}

function linuxStartTicks(stat: string): string | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) {
    return undefined;
  }
  const fields = stat.slice(close + 2).trim().split(/\s+/u);
  const startTicks = fields[19];
  return typeof startTicks === "string" && /^(?:0|[1-9]\d*)$/.test(startTicks) ? startTicks : undefined;
}

/** null = no such process; undefined = probe unavailable. */
async function runPs(pid: number, deps: ProveQueueOwnerLockDeps): Promise<string | null | undefined> {
  if (deps.runPs) {
    return await deps.runPs(pid);
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
      env: { ...process.env, LC_ALL: "C" },
      timeout: 5_000,
      maxBuffer: 4_096,
    });
    return stdout;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === 1 || code === "1") {
      return null;
    }
    return undefined;
  }
}

async function defaultReadProcFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function defaultReadProcLink(path: string): Promise<string | null> {
  try {
    return await readlink(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
