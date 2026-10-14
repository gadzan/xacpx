import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * xacpx-owned reader for acpx's persisted session records.
 *
 * acpx 0.19 ignores the legacy `sessions/index.json` (see acpx docs/sessions.md):
 * canonical discovery scans `sessions/*.json` and validates each record's shape
 * plus its filename identity. This module mirrors that contract defensively —
 * it never imports acpx internals, and any record that fails validation is
 * skipped so one corrupt file cannot hide the others.
 *
 * On-disk field names are snake_case (acpx `serializeSessionRecordForDisk`).
 * The in-memory acpx type is camelCase; do not mix the two.
 */

const SESSION_RECORD_SCHEMA = "acpx.session.v1";

/** Per-file bound so a user-writable directory cannot cause unbounded I/O.
 *  There is deliberately no file-count cap: acpx's own discovery walks every
 *  canonical record, and truncating the scan would silently make sessions past
 *  the cut unreachable for history and agent-command resolution. */
const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
const READ_BATCH_SIZE = 8;

export interface AcpxSessionRecord {
  acpxRecordId: string;
  acpSessionId: string;
  /** Provider-native session id, only when the adapter exposes one. */
  agentSessionId?: string;
  agentCommand: string;
  cwd: string;
  name?: string;
  closed: boolean;
  closedAt?: string;
  createdAt: string;
  lastUsedAt: string;
  /** Raw persisted conversation (SessionMessage[]); consumers map defensively. */
  messages: unknown;
  /** File the record was read from (basename). */
  file: string;
}

export interface ScanAcpxSessionRecordsOptions {
  sessionsDir: string;
  maxFileBytes?: number;
  /** Observability seam: skipped/unreadable candidates and bound violations. */
  onDiagnostic?: (diagnostic: string) => void;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** acpx encodes the record id into the filename; a mismatch means the file is
 *  not the canonical record for that id and MUST be ignored (same rule acpx
 *  applies in scanSessionRecords). */
export function acpxRecordFileNameMatches(file: string, acpxRecordId: string): boolean {
  return file === `${encodeURIComponent(acpxRecordId)}.json`;
}

/** Pure shape + identity validation of one record payload. Returns null for
 *  anything acpx itself would reject. */
export function parseAcpxSessionRecord(file: string, payload: unknown): AcpxSessionRecord | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (record.schema !== SESSION_RECORD_SCHEMA) {
    return null;
  }
  if (
    !isNonEmptyString(record.acpx_record_id) ||
    !isNonEmptyString(record.acp_session_id) ||
    !isNonEmptyString(record.agent_command) ||
    !isNonEmptyString(record.cwd) ||
    !isNonEmptyString(record.created_at) ||
    !isNonEmptyString(record.last_used_at)
  ) {
    return null;
  }
  if (typeof record.last_seq !== "number" || !Number.isInteger(record.last_seq) || record.last_seq < 0) {
    return null;
  }
  if (!Array.isArray(record.messages) || !isNonEmptyString(record.updated_at)) {
    return null;
  }
  if (!acpxRecordFileNameMatches(file, record.acpx_record_id)) {
    return null;
  }
  const name = record.name;
  if (name !== undefined && !isNonEmptyString(name)) {
    return null;
  }
  const closed = record.closed;
  if (closed !== undefined && typeof closed !== "boolean") {
    return null;
  }
  const closedAt = record.closed_at;
  if (closedAt !== undefined && !isNonEmptyString(closedAt)) {
    return null;
  }
  const agentSessionId = record.agent_session_id;
  if (agentSessionId !== undefined && !isNonEmptyString(agentSessionId)) {
    return null;
  }
  return {
    acpxRecordId: record.acpx_record_id,
    acpSessionId: record.acp_session_id,
    agentCommand: record.agent_command,
    cwd: record.cwd,
    name,
    closed: closed === true,
    closedAt,
    createdAt: record.created_at,
    lastUsedAt: record.last_used_at,
    agentSessionId,
    messages: record.messages,
    file,
  };
}

async function readRecordFile(
  sessionsDir: string,
  file: string,
  maxFileBytes: number,
  onDiagnostic: (diagnostic: string) => void,
): Promise<AcpxSessionRecord | null> {
  let payload: unknown;
  try {
    const stats = await stat(join(sessionsDir, file));
    if (!stats.isFile()) {
      return null;
    }
    if (stats.size > maxFileBytes) {
      onDiagnostic(`skipped oversized session record "${file}" (${stats.size} bytes)`);
      return null;
    }
    payload = JSON.parse(await readFile(join(sessionsDir, file), "utf8"));
  } catch (error) {
    // A corrupt or concurrently removed record must not hide other matches, but
    // it stays observable so an operator can tell drift from absence.
    onDiagnostic(
      `skipped unreadable session record "${file}": ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
  const record = parseAcpxSessionRecord(file, payload);
  if (!record) {
    onDiagnostic(`skipped invalid session record "${file}"`);
  }
  return record;
}

/** Scan the acpx sessions directory for canonical records. Read-path only:
 *  unreadable or invalid entries are skipped with a diagnostic, never thrown,
 *  so history/attach reads degrade instead of failing. */
export async function scanAcpxSessionRecords(
  options: ScanAcpxSessionRecordsOptions,
): Promise<AcpxSessionRecord[]> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const onDiagnostic = options.onDiagnostic ?? (() => {});

  let entries: string[];
  try {
    entries = (await readdir(options.sessionsDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "index.json")
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    // A missing directory is "no records"; any other failure (EACCES, EIO) is a
    // real I/O problem and MUST be observable so a caller never mistakes it for
    // "this session has no history".
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      onDiagnostic(
        `cannot read sessions directory "${options.sessionsDir}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return [];
  }

  const records: AcpxSessionRecord[] = [];
  for (let offset = 0; offset < entries.length; offset += READ_BATCH_SIZE) {
    const batch = await Promise.all(
      entries.slice(offset, offset + READ_BATCH_SIZE).map((file) =>
        readRecordFile(options.sessionsDir, file, maxFileBytes, onDiagnostic),
      ),
    );
    for (const record of batch) {
      if (record) {
        records.push(record);
      }
    }
  }
  return records;
}
