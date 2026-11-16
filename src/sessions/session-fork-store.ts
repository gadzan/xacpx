import { randomUUID } from "node:crypto";

import { createSqlDriver, type SqlDriver } from "../conversations/sql-driver";

export type SessionForkStrategy = "pending" | "native" | "portable";
export type SessionForkStatus = "pending" | "ready" | "consumed";

export interface SessionForkSourcePoint {
  type: "latest_stable";
}

export interface SessionForkResolution {
  strategy: "portable";
  reason: "native-fork-unavailable";
}

export interface SessionForkRecord {
  id: string;
  requestId: string;
  sourceSessionId: string;
  targetSessionId: string;
  /** Requested source alias in display form, for replay comparison after suffixing. */
  sourceAlias: string;
  /** Requested target alias in display form, for replay comparison after suffixing. */
  targetAlias: string;
  sourcePoint: SessionForkSourcePoint;
  strategy: SessionForkStrategy;
  resolution?: SessionForkResolution;
  status: SessionForkStatus;
  createdAt: string;
  consumedAt?: string;
}

export interface SessionForkHandoff {
  text: string;
  messageCount: number;
  omittedMessages: number;
}

export interface ResolveSessionForkStrategyInput {
  /** PR2's native `session/fork` capability. It stays false until that resolver lands. */
  nativeSessionFork: boolean;
}

/**
 * Fork records are strategy-agnostic. PR1 ships the portable strategy only; a
 * later native `session/fork` resolves here without changing the record shape.
 */
export function resolveSessionForkStrategy(
  input: ResolveSessionForkStrategyInput,
): "native" | "portable" {
  return input.nativeSessionFork ? "native" : "portable";
}

export class SessionForkError extends Error {
  constructor(
    readonly code:
      | "session-fork-unavailable"
      | "session-fork-unstable"
      | "session-fork-empty-history"
      | "session-fork-target-exists"
      | "session-fork-request-mismatch"
      | "session-fork-native-unavailable",
    message: string,
  ) {
    super(message);
  }
}

interface ForkRow {
  id: string;
  request_id: string;
  source_session_id: string;
  target_session_id: string;
  source_alias: string | null;
  target_alias: string | null;
  source_point: string;
  strategy: SessionForkStrategy;
  resolution: string | null;
  status: SessionForkStatus;
  created_at: string;
  consumed_at: string | null;
}

interface HandoffRow {
  text: string;
  message_count: number;
  omitted_messages: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session_forks (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  source_session_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL UNIQUE,
  source_alias TEXT,
  target_alias TEXT,
  source_point TEXT NOT NULL,
  strategy TEXT NOT NULL,
  resolution TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE TABLE IF NOT EXISTS session_fork_handoffs (
  fork_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  omitted_messages INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS session_forks_source ON session_forks(source_session_id);
`;

function parseResolution(raw: string | null): SessionForkResolution | undefined {
  if (!raw) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (
    parsed
    && typeof parsed === "object"
    && "strategy" in parsed
    && parsed.strategy === "portable"
    && "reason" in parsed
    && parsed.reason === "native-fork-unavailable"
  ) {
    return { strategy: "portable", reason: "native-fork-unavailable" };
  }
  throw new Error("session fork record holds an unknown resolution");
}

function parseSourcePoint(raw: string): SessionForkSourcePoint {
  const parsed: unknown = JSON.parse(raw);
  if (parsed && typeof parsed === "object" && "type" in parsed && parsed.type === "latest_stable") {
    return { type: "latest_stable" };
  }
  throw new Error("session fork record holds an unknown source point");
}

function toRecord(row: ForkRow): SessionForkRecord {
  return {
    id: row.id,
    requestId: row.request_id,
    sourceSessionId: row.source_session_id,
    targetSessionId: row.target_session_id,
    sourceAlias: row.source_alias ?? "",
    targetAlias: row.target_alias ?? "",
    sourcePoint: parseSourcePoint(row.source_point),
    strategy: row.strategy,
    ...(row.resolution ? { resolution: parseResolution(row.resolution) } : {}),
    status: row.status,
    createdAt: row.created_at,
    ...(row.consumed_at ? { consumedAt: row.consumed_at } : {}),
  };
}

/**
 * Durable fork provenance and the one-time handoff text. The text lives in its
 * own table so a 12k prompt block never enters state.json's whole-file saves.
 */
export class SessionForkStore {
  private constructor(private readonly sql: SqlDriver) {
    this.sql.exec(SCHEMA);
    // Databases created before the requested-alias columns existed gain them
    // here; fresh databases already carry them from SCHEMA.
    const columns = this.sql.all<{ name: string }>("PRAGMA table_info(session_forks)");
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("source_alias")) {
      this.sql.run("ALTER TABLE session_forks ADD COLUMN source_alias TEXT");
    }
    if (!names.has("target_alias")) {
      this.sql.run("ALTER TABLE session_forks ADD COLUMN target_alias TEXT");
    }
  }

  static async open(path: string): Promise<SessionForkStore> {
    return new SessionForkStore(await createSqlDriver(path));
  }

  static async openInMemory(): Promise<SessionForkStore> {
    return await SessionForkStore.open(":memory:");
  }

  createPending(input: {
    requestId: string;
    sourceSessionId: string;
    targetSessionId: string;
    sourceAlias: string;
    targetAlias: string;
    createdAt: string;
    sourcePoint?: SessionForkSourcePoint;
  }): SessionForkRecord {
    const record: SessionForkRecord = {
      id: `fork_${randomUUID()}`,
      requestId: input.requestId,
      sourceSessionId: input.sourceSessionId,
      targetSessionId: input.targetSessionId,
      sourceAlias: input.sourceAlias,
      targetAlias: input.targetAlias,
      sourcePoint: input.sourcePoint ?? { type: "latest_stable" },
      strategy: "pending",
      status: "pending",
      createdAt: input.createdAt,
    };
    this.sql.run(
      `INSERT INTO session_forks
        (id, request_id, source_session_id, target_session_id, source_alias, target_alias, source_point, strategy, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.requestId,
        record.sourceSessionId,
        record.targetSessionId,
        record.sourceAlias,
        record.targetAlias,
        JSON.stringify(record.sourcePoint),
        record.strategy,
        record.status,
        record.createdAt,
      ],
    );
    return record;
  }

  getByRequestId(requestId: string): SessionForkRecord | undefined {
    const row = this.sql.get<ForkRow>(
      "SELECT * FROM session_forks WHERE request_id = ?",
      [requestId],
    );
    return row ? toRecord(row) : undefined;
  }

  getByTargetSessionId(targetSessionId: string): SessionForkRecord | undefined {
    const row = this.sql.get<ForkRow>(
      "SELECT * FROM session_forks WHERE target_session_id = ?",
      [targetSessionId],
    );
    return row ? toRecord(row) : undefined;
  }

  /** The fork that created this session, for a fork-of-fork parent lookup. */
  getByForkSourceSessionId(sourceSessionId: string): SessionForkRecord | undefined {
    const row = this.sql.get<ForkRow>(
      "SELECT * FROM session_forks WHERE target_session_id = ?",
      [sourceSessionId],
    );
    return row ? toRecord(row) : undefined;
  }

  getHandoff(forkId: string): SessionForkHandoff | undefined {
    const row = this.sql.get<HandoffRow>(
      "SELECT text, message_count, omitted_messages FROM session_fork_handoffs WHERE fork_id = ?",
      [forkId],
    );
    return row
      ? {
          text: row.text,
          messageCount: row.message_count,
          omittedMessages: row.omitted_messages,
        }
      : undefined;
  }

  /** pending -> portable, storing the rendered handoff in the same transaction. */
  resolvePortable(input: {
    forkId: string;
    handoff: SessionForkHandoff;
    createdAt: string;
  }): SessionForkRecord {
    return this.sql.transaction(() => {
      const row = this.sql.get<ForkRow>(
        "SELECT * FROM session_forks WHERE id = ?",
        [input.forkId],
      );
      if (!row) throw new Error(`session fork ${input.forkId} is missing`);
      if (row.status !== "pending" || row.strategy !== "pending") {
        throw new Error(`session fork ${input.forkId} is not pending`);
      }
      const resolution: SessionForkResolution = {
        strategy: "portable",
        reason: "native-fork-unavailable",
      };
      this.sql.run(
        "UPDATE session_forks SET strategy = 'portable', resolution = ?, status = 'ready' WHERE id = ?",
        [JSON.stringify(resolution), input.forkId],
      );
      this.sql.run(
        `INSERT INTO session_fork_handoffs
          (fork_id, text, message_count, omitted_messages, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          input.forkId,
          input.handoff.text,
          input.handoff.messageCount,
          input.handoff.omittedMessages,
          input.createdAt,
        ],
      );
      const updated = this.sql.get<ForkRow>(
        "SELECT * FROM session_forks WHERE id = ?",
        [input.forkId],
      );
      if (!updated) throw new Error(`session fork ${input.forkId} disappeared`);
      return toRecord(updated);
    }, "immediate");
  }

  /**
   * The provider-boundary take. Selection and the consumed marker commit in one
   * transaction, so a failed provider call can never make the next retry replay
   * the handoff.
   */
  takeHandoff(
    targetSessionId: string,
    consumedAt: string,
  ): { forkId: string; text: string } | undefined {
    return this.sql.transaction(() => {
      const row = this.sql.get<ForkRow>(
        "SELECT * FROM session_forks WHERE target_session_id = ? AND status = 'ready'",
        [targetSessionId],
      );
      if (!row) return undefined;
      const handoff = this.sql.get<HandoffRow>(
        "SELECT text, message_count, omitted_messages FROM session_fork_handoffs WHERE fork_id = ?",
        [row.id],
      );
      if (!handoff) return undefined;
      this.sql.run(
        "UPDATE session_forks SET status = 'consumed', consumed_at = ? WHERE id = ?",
        [consumedAt, row.id],
      );
      return { forkId: row.id, text: handoff.text };
    }, "immediate");
  }

  /** Delete a fork record and its handoff text. Used to clean up a pending row
   *  when the fork never completed, so a retry with the same request id can
   *  converge instead of wedging on an orphan row. Completed (ready/consumed)
   *  records are retained as idempotency and audit provenance even after their
   *  target session is deleted: one small row per user-initiated fork, the
   *  same cardinality as the sessions they describe, so the table cannot grow
   *  without bound on its own. */
  deleteForkById(forkId: string): void {
    this.sql.transaction(() => {
      this.sql.run("DELETE FROM session_fork_handoffs WHERE fork_id = ?", [forkId]);
      this.sql.run("DELETE FROM session_forks WHERE id = ?", [forkId]);
    }, "immediate");
  }

  close(): void {
    this.sql.close();
  }
}
