import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { renderAgentArgvIdentity } from "../config/agent-launch";
import { isRecord } from "../config/load-config";
import { retryTransientWriteErrors, withPrivateFileLock } from "../util/private-file";

export type SessionArgvMigrationStatus = "noop" | "backfilled" | "rejected" | "invalid";

export interface SessionArgvMigrationEvaluation {
  status: SessionArgvMigrationStatus;
  /** The record to persist when backfilled; the original record otherwise. */
  record: Record<string, unknown>;
  detail?: string;
}

export interface SessionArgvMigrationTarget {
  agentCommand: string;
  agentArgv: string[];
}

/**
 * Platform-neutral pure decision for backfilling `agent_argv` into a parsed acpx
 * session record. acpx 0.13 launches a resumed session from the RECORD's argv on
 * Windows, so a legacy record (raw `--agent` era: `agent_command` present,
 * `agent_argv` missing) cannot be resumed there until the exact argv is stored.
 *
 * - `agent_argv` already equal to the target → no-op.
 * - `agent_argv` present but different → rejected (never overwrite).
 * - missing and `agent_command` equals the canonical identity of the target argv
 *   → backfilled (identity-proven same launch).
 * - anything else → rejected with a detail explaining why.
 */
export function evaluateSessionArgvMigration(
  record: unknown,
  target: SessionArgvMigrationTarget,
): SessionArgvMigrationEvaluation {
  if (!isRecord(record) || Array.isArray(record)) {
    return { status: "invalid", record: {}, detail: "session record is not an object" };
  }
  if (typeof record.acpx_record_id !== "string") {
    return { status: "invalid", record, detail: "session record is missing acpx_record_id" };
  }
  if (typeof record.agent_command !== "string") {
    return { status: "invalid", record, detail: "session record is missing agent_command" };
  }
  if (record.agent_argv !== undefined) {
    if (
      Array.isArray(record.agent_argv) &&
      record.agent_argv.length === target.agentArgv.length &&
      record.agent_argv.every((entry, index) => entry === target.agentArgv[index])
    ) {
      return { status: "noop", record };
    }
    return { status: "rejected", record, detail: "session record has a different agent_argv" };
  }
  if (record.agent_command !== target.agentCommand) {
    return {
      status: "rejected",
      record,
      detail: `session record agent_command does not match the target launch identity (${record.agent_command})`,
    };
  }
  return {
    status: "backfilled",
    record: { ...record, agent_argv: [...target.agentArgv] },
  };
}

export interface MigrateSessionArgvFileDeps {
  /** acpx sessions dir; defaults to `<home>/.acpx/sessions`. */
  sessionsDir?: string;
  readFileFn?: typeof readFile;
  lockFn?: <T>(
    path: string,
    fn: (writeLocked: (content: string) => Promise<void>) => Promise<T>,
  ) => Promise<T>;
  writeAtomicFn?: (path: string, content: string) => Promise<void>;
  /** Runs once a backfill is decided, before the record is written — callers
   * terminate the warm queue owner here so it cannot rewrite the record mid-migration. */
  beforeWrite?: (acpxRecordId: string) => Promise<void>;
  platform?: NodeJS.Platform;
  delay?: (ms: number) => Promise<void>;
}

export interface MigrateSessionArgvFileResult {
  status: SessionArgvMigrationStatus;
  acpxRecordId: string;
  detail?: string;
}

/**
 * I/O seam over evaluateSessionArgvMigration: reads the record file, decides,
 * and atomically backfills under a proper-lockfile when proven safe. On any
 * failure the original record file is preserved. Fail-closed: `rejected` and
 * `invalid` outcomes surface the record id and a reason, never credentials.
 */
export async function migrateSessionArgvFile(
  acpxRecordId: string,
  target: SessionArgvMigrationTarget,
  deps: MigrateSessionArgvFileDeps = {},
): Promise<MigrateSessionArgvFileResult> {
  const sessionsDir = deps.sessionsDir ?? join(homedir(), ".acpx", "sessions");
  const filePath = join(sessionsDir, `${encodeURIComponent(acpxRecordId)}.json`);
  const readFileFn = deps.readFileFn ?? readFile;
  const lockFn = deps.lockFn ?? withPrivateFileLock;
  const platform = deps.platform ?? process.platform;

  let raw: string;
  try {
    raw = await readFileFn(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return { status: "invalid", acpxRecordId, detail: "session record file not found" };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { status: "invalid", acpxRecordId, detail: "session record file is not valid JSON" };
  }
  if (
    !isRecord(parsed) ||
    Array.isArray(parsed) ||
    typeof parsed.acpx_record_id !== "string" ||
    parsed.acpx_record_id !== acpxRecordId
  ) {
    return {
      status: "invalid",
      acpxRecordId,
      detail: `session record file does not match record id ${acpxRecordId}`,
    };
  }

  const evaluation = evaluateSessionArgvMigration(parsed, target);
  if (evaluation.status === "invalid") {
    return { status: "invalid", acpxRecordId, detail: evaluation.detail };
  }
  if (evaluation.status !== "backfilled") {
    return { status: evaluation.status, acpxRecordId, detail: evaluation.detail };
  }

  await deps.beforeWrite?.(acpxRecordId);

  await lockFn(filePath, async (writeLocked) => {
    // Re-check under the lock: another writer may have migrated meanwhile.
    const current = JSON.parse(await readFileFn(filePath, "utf8")) as unknown;
    const recheck = evaluateSessionArgvMigration(current, target);
    if (recheck.status === "noop") {
      return; // migrated concurrently; nothing to write
    }
    if (recheck.status !== "backfilled") {
      throw new Error(
        `acpx session record ${acpxRecordId} changed during migration; refusing to overwrite`,
      );
    }
    const serialized = `${JSON.stringify(recheck.record, null, 2)}\n`;
    await retryTransientWriteErrors(
      () => (deps.writeAtomicFn ? deps.writeAtomicFn(filePath, serialized) : writeLocked(serialized)),
      { platform, delay: deps.delay },
    );
  });

  // Post-write verification: the record must round-trip with the same fields and
  // the exact target argv.
  const after = JSON.parse(await readFileFn(filePath, "utf8")) as unknown;
  const verified = evaluateSessionArgvMigration(after, target);
  if (verified.status !== "noop" && verified.status !== "backfilled") {
    throw new Error(`acpx session record ${acpxRecordId} failed post-write verification`);
  }

  return { status: "backfilled", acpxRecordId };
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** acpx record id → on-disk file name (encodeURIComponent, like acpx itself). */
export function acpxSessionRecordFilePath(sessionsDir: string, acpxRecordId: string): string {
  return join(sessionsDir, `${encodeURIComponent(acpxRecordId)}.json`);
}
