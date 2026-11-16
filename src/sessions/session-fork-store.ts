import { randomUUID } from "node:crypto";

import { createSqlDriver, type SqlDriver } from "../conversations/sql-driver";

export type SessionForkStrategy = "pending" | "native" | "portable";
export type SessionForkStatus = "pending" | "ready" | "consumed";

/** Where a portable fork cuts the source session's recorded history: the latest
 *  settled head, or one recorded prompt turn (a "node") and everything up to its
 *  reply. */
export type SessionForkSourcePoint =
  | { type: "latest_stable" }
  | { type: "node"; nodeId: string };

/** One recorded prompt turn of a logical session. The core mints `nodeId` when
 *  the turn starts and records the digest of the exact prompt text it hands the
 *  agent, so a fork can locate that turn in the acpx record later without
 *  guessing at provider-managed message ids. */
export interface SessionForkTurnNode {
  nodeId: string;
  sessionId: string;
  /** 0-based order among this session's recorded prompt turns. */
  sequence: number;
  promptDigest: string;
  createdAt: string;
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
  /** The chat scope that requested the fork, so a replay from another scope cannot claim it. */
  chatKey: string;
  sourcePoint: SessionForkSourcePoint;
  /** Digest of the rendered prefix at resolve time, so a replay cannot hand off
   *  history the source record no longer holds. Node forks only. */
  sourceAnchor?: string;
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
      | "session-fork-native-unavailable"
      | "session-fork-node-unavailable"
      | "session-fork-node-ambiguous"
      | "session-fork-source-changed",
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
  chat_key: string | null;
  source_point: string;
  source_anchor: string | null;
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

interface TurnNodeRow {
  node_id: string;
  session_id: string;
  sequence: number;
  prompt_digest: string;
  created_at: string;
}

/** A turn node older than this can no longer be forked: the acpx record keeps a
 *  bounded window, so the prefix it describes is gone. 30 days matches the
 *  longest practical pause between a session's turns and a fork of it. */
const TURN_NODE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session_forks (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  source_session_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL UNIQUE,
  source_alias TEXT,
  target_alias TEXT,
  chat_key TEXT,
  source_point TEXT NOT NULL,
  source_anchor TEXT,
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
CREATE TABLE IF NOT EXISTS session_turn_nodes (
  node_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  prompt_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS session_forks_source ON session_forks(source_session_id);
CREATE INDEX IF NOT EXISTS session_turn_nodes_session ON session_turn_nodes(session_id, sequence);
CREATE INDEX IF NOT EXISTS session_turn_nodes_created ON session_turn_nodes(created_at);
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
  if (parsed && typeof parsed === "object" && "type" in parsed) {
    if (parsed.type === "latest_stable") return { type: "latest_stable" };
    if (
      parsed.type === "node"
      && "nodeId" in parsed
      && typeof parsed.nodeId === "string"
      && parsed.nodeId.length > 0
    ) {
      return { type: "node", nodeId: parsed.nodeId };
    }
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
    chatKey: row.chat_key ?? "",
    sourcePoint: parseSourcePoint(row.source_point),
    ...(row.source_anchor ? { sourceAnchor: row.source_anchor } : {}),
    strategy: row.strategy,
    ...(row.resolution ? { resolution: parseResolution(row.resolution) } : {}),
    status: row.status,
    createdAt: row.created_at,
    ...(row.consumed_at ? { consumedAt: row.consumed_at } : {}),
  };
}

function toTurnNode(row: TurnNodeRow): SessionForkTurnNode {
  return {
    nodeId: row.node_id,
    sessionId: row.session_id,
    sequence: row.sequence,
    promptDigest: row.prompt_digest,
    createdAt: row.created_at,
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
    if (!names.has("chat_key")) {
      this.sql.run("ALTER TABLE session_forks ADD COLUMN chat_key TEXT");
    }
    // node-fork records carry the rendered prefix digest; pre-PR2 databases
    // gain the column with NULLs (their `latest_stable` records never set it).
    if (!names.has("source_anchor")) {
      this.sql.run("ALTER TABLE session_forks ADD COLUMN source_anchor TEXT");
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
    chatKey: string;
    sourceSessionId: string;
    targetSessionId: string;
    sourceAlias: string;
    targetAlias: string;
    createdAt: string;
    sourcePoint?: SessionForkSourcePoint;
    sourceAnchor?: string;
  }): SessionForkRecord {
    const record: SessionForkRecord = {
      id: `fork_${randomUUID()}`,
      requestId: input.requestId,
      chatKey: input.chatKey,
      sourceSessionId: input.sourceSessionId,
      targetSessionId: input.targetSessionId,
      sourceAlias: input.sourceAlias,
      targetAlias: input.targetAlias,
      sourcePoint: input.sourcePoint ?? { type: "latest_stable" },
      ...(input.sourceAnchor ? { sourceAnchor: input.sourceAnchor } : {}),
      strategy: "pending",
      status: "pending",
      createdAt: input.createdAt,
    };
    this.sql.run(
      `INSERT INTO session_forks
        (id, request_id, chat_key, source_session_id, target_session_id, source_alias, target_alias, source_point, source_anchor, strategy, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.requestId,
        record.chatKey,
        record.sourceSessionId,
        record.targetSessionId,
        record.sourceAlias,
        record.targetAlias,
        JSON.stringify(record.sourcePoint),
        record.sourceAnchor ?? null,
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

  /**
   * Record one prompt turn so a later node fork can find it in the acpx record.
   * `sequence` is allocated here, inside the insert, so two turns committed
   * back to back can never share one. Old rows are swept on every write: a
   * turn node is worthless once the acpx record window has moved past it, and
   * a row per turn must not accumulate forever.
   */
  recordTurnNode(input: {
    nodeId: string;
    sessionId: string;
    promptDigest: string;
    createdAt: string;
  }): SessionForkTurnNode {
    const assigned = this.sql.transaction(() => {
      const row = this.sql.get<{ next: number | null }>(
        "SELECT MAX(sequence) + 1 AS next FROM session_turn_nodes WHERE session_id = ?",
        [input.sessionId],
      );
      const sequence = row?.next ?? 0;
      this.sql.run(
        `INSERT INTO session_turn_nodes
          (node_id, session_id, sequence, prompt_digest, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [input.nodeId, input.sessionId, sequence, input.promptDigest, input.createdAt],
      );
      this.sql.run("DELETE FROM session_turn_nodes WHERE created_at < ?", [
        new Date(Date.parse(input.createdAt) - TURN_NODE_RETENTION_MS).toISOString(),
      ]);
      return sequence;
    }, "immediate");
    return {
      nodeId: input.nodeId,
      sessionId: input.sessionId,
      sequence: assigned,
      promptDigest: input.promptDigest,
      createdAt: input.createdAt,
    };
  }

  getTurnNode(sessionId: string, nodeId: string): SessionForkTurnNode | undefined {
    const row = this.sql.get<TurnNodeRow>(
      "SELECT * FROM session_turn_nodes WHERE session_id = ? AND node_id = ?",
      [sessionId, nodeId],
    );
    return row ? toTurnNode(row) : undefined;
  }

  /** Every recorded turn of a session, oldest first. A node fork aligns its
   *  target against this chain. */
  listTurnNodes(sessionId: string): SessionForkTurnNode[] {
    return this.sql
      .all<TurnNodeRow>(
        "SELECT * FROM session_turn_nodes WHERE session_id = ? ORDER BY sequence ASC",
        [sessionId],
      )
      .map(toTurnNode);
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
