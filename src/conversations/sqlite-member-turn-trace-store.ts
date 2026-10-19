import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { ConversationError } from "./conversation-error";
import type { SqlDriver } from "./sql-driver";
import type {
  MemberTurnTraceBatchResult, MemberTurnTraceEvent, MemberTurnTraceIdentity, MemberTurnTraceInputEvent,
  MemberTurnTracePage, MemberTurnTracePageOptions, MemberTurnTraceQuery, MemberTurnTraceRecord,
  MemberTurnTraceRecordingState,
} from "./member-turn-trace";

const MAX_EVENT_BYTES = 128 * 1024;
const DEFAULT_PAGE_BYTES = 512 * 1024;
const MAX_PAGE_BYTES = 1024 * 1024;

interface TraceRow {
  member_turn_id: string; attempt: number; conversation_id: string; topic_id: string; run_id: string;
  bot_id: string; source_turn_id: string; recording_state: MemberTurnTraceRecordingState; last_seq: number;
  plan_json: string | null; completeness_reason: string | null; created_at: string; updated_at: string; finished_at: string | null;
}
interface EventRow { seq: number; kind: MemberTurnTraceInputEvent["kind"]; payload_json: string; created_at: string }

function error(code: string, message: string): never { throw new ConversationError(code, message); }
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function record(row: TraceRow): MemberTurnTraceRecord {
  return {
    identity: { conversationId: row.conversation_id, topicId: row.topic_id, runId: row.run_id, botId: row.bot_id,
      memberTurnId: row.member_turn_id, attempt: row.attempt, sourceTurnId: row.source_turn_id },
    recordingState: row.recording_state, lastSeq: row.last_seq, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.plan_json !== null ? { plan: JSON.parse(row.plan_json) } : {}),
    ...(row.completeness_reason !== null ? { completenessReason: row.completeness_reason } : {}),
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
  };
}

export class SqliteMemberTurnTraceStore {
  constructor(private readonly sql: SqlDriver) {
    sql.transaction(() => sql.exec(`
      CREATE TABLE IF NOT EXISTS member_turn_traces (
        member_turn_id TEXT NOT NULL, attempt INTEGER NOT NULL,
        conversation_id TEXT NOT NULL, topic_id TEXT NOT NULL, run_id TEXT NOT NULL,
        bot_id TEXT NOT NULL, source_turn_id TEXT NOT NULL, recording_state TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0, plan_json TEXT, completeness_reason TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT,
        PRIMARY KEY (member_turn_id, attempt)
      );
      CREATE INDEX IF NOT EXISTS idx_member_trace_scope ON member_turn_traces (conversation_id, topic_id, run_id);
      CREATE TABLE IF NOT EXISTS member_turn_trace_events (
        member_turn_id TEXT NOT NULL, attempt INTEGER NOT NULL, seq INTEGER NOT NULL,
        kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (member_turn_id, attempt, seq)
      );
      CREATE TABLE IF NOT EXISTS member_turn_trace_batches (
        member_turn_id TEXT NOT NULL, attempt INTEGER NOT NULL, batch_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL,
        recording_state TEXT NOT NULL, PRIMARY KEY (member_turn_id, attempt, batch_id)
      );
    `));
  }

  private row(query: MemberTurnTraceQuery): TraceRow | undefined {
    const row = this.sql.get<TraceRow>(`SELECT * FROM member_turn_traces
      WHERE conversation_id = ? AND topic_id = ? AND run_id = ? AND member_turn_id = ? AND attempt = ?`,
    [query.conversationId, query.topicId, query.runId, query.memberTurnId, query.attempt]);
    if (!row || (query.botId !== undefined && query.botId !== row.bot_id)
      || (query.sourceTurnId !== undefined && query.sourceTurnId !== row.source_turn_id)) return undefined;
    return row;
  }

  get(query: MemberTurnTraceQuery): MemberTurnTraceRecord | undefined {
    const row = this.row(query);
    return row ? record(row) : undefined;
  }

  listAttempts(query: Pick<MemberTurnTraceQuery, "conversationId" | "topicId" | "runId"> &
    Partial<Pick<MemberTurnTraceQuery, "memberTurnId" | "botId">>): MemberTurnTraceRecord[] {
    return this.sql.all<TraceRow>(`SELECT * FROM member_turn_traces
      WHERE conversation_id = ? AND topic_id = ? AND run_id = ?
      AND (? IS NULL OR member_turn_id = ?) AND (? IS NULL OR bot_id = ?)
      ORDER BY member_turn_id, attempt`, [query.conversationId, query.topicId, query.runId,
      query.memberTurnId ?? null, query.memberTurnId ?? null, query.botId ?? null, query.botId ?? null]).map(record);
  }

  appendBatch(identity: MemberTurnTraceIdentity, batchId: string,
    events: readonly MemberTurnTraceInputEvent[]): MemberTurnTraceBatchResult {
    if (!batchId || batchId.length > 200 || !Number.isSafeInteger(identity.attempt) || identity.attempt < 1
      || !identity.sourceTurnId || !identity.botId) error("trace_identity_invalid", "trace requires an exact physical member identity and batch ID");
    if (events.length > 512 || bytes(events) > MAX_PAGE_BYTES) error("trace_batch_too_large", "trace batch exceeds the durable writer bound");
    const fingerprint = createHash("sha256").update(JSON.stringify(events)).digest("hex");
    const payloads = events.map((event, index) => {
      if (typeof event.createdAt !== "string" || !event.createdAt || !event.payload) {
        error("trace_event_invalid", "trace event is invalid");
      }
      if (bytes(event) > MAX_EVENT_BYTES) {
        error("trace_event_too_large", "trace event exceeds the public event bound; recorder must mark the trace interrupted");
      }
      switch (event.kind) {
        case "text": case "reasoning":
          if (typeof event.payload.text !== "string") error("trace_event_invalid", "trace text must be a string");
          break;
        case "tool": {
          const step = event.payload.step;
          if (!step || typeof step !== "object" || typeof step.toolCallId !== "string" || !step.toolCallId
            || typeof step.toolName !== "string" || !step.toolName || typeof step.title !== "string"
            || typeof step.kind !== "string" || typeof step.status !== "string"
            || ("rawInput" in step) || ("rawOutput" in step)) {
            error("trace_event_invalid", "trace tool requires a public normalized step and no raw adapter internals");
          }
          break;
        }
        case "plan":
          if (!Array.isArray(event.payload.entries)
            || event.payload.entries.some((entry) => typeof entry?.content !== "string" || typeof entry?.status !== "string")) {
            error("trace_event_invalid", "trace plan requires public entries");
          }
          break;
        case "terminal":
          if (index !== events.length - 1 || typeof event.payload.ok !== "boolean"
            || (event.payload.cancelled !== undefined && typeof event.payload.cancelled !== "boolean")
            || (event.payload.errorMessage !== undefined && typeof event.payload.errorMessage !== "string")) {
            error("trace_terminal_invalid", "accepted terminal marker must be the final event");
          }
          break;
        default: error("trace_event_invalid", "unsupported trace event kind");
      }
      return JSON.stringify(event.payload);
    });
    return this.sql.transaction(() => {
      const existing = this.row(identity);
      const collision = this.sql.get("SELECT 1 FROM member_turn_traces WHERE member_turn_id = ? AND attempt = ?",
        [identity.memberTurnId, identity.attempt]);
      const prior = this.sql.get<{ fingerprint: string; first_seq: number; last_seq: number; recording_state: MemberTurnTraceRecordingState }>(
        "SELECT fingerprint, first_seq, last_seq, recording_state FROM member_turn_trace_batches WHERE member_turn_id = ? AND attempt = ? AND batch_id = ?",
        [identity.memberTurnId, identity.attempt, batchId]);
      if (prior && !existing) error("trace_identity_mismatch", "trace batch receipt has no matching durable trace header");
      if (prior) {
        if (prior.fingerprint !== fingerprint) error("trace_batch_conflict", "trace batch ID was reused with different events");
        return { reused: true, firstSeq: prior.first_seq, lastSeq: prior.last_seq, recordingState: prior.recording_state };
      }
      if (existing && existing.recording_state !== "recording") error("trace_not_recording", "closed trace cannot accept new events");
      const member = this.sql.get<{ state: string }>(`SELECT m.state FROM member_turns m JOIN runs r ON r.id = m.run_id
        WHERE m.id = ? AND m.attempt = ? AND m.source_turn_id = ? AND m.bot_id = ?
        AND m.conversation_id = ? AND m.topic_id = ? AND m.run_id = ?
        AND r.conversation_id = m.conversation_id AND r.topic_id = m.topic_id`,
      [identity.memberTurnId, identity.attempt, identity.sourceTurnId, identity.botId,
        identity.conversationId, identity.topicId, identity.runId]);
      if (!member || (!existing && member.state !== "running")) error("trace_identity_mismatch", "trace identity is not the durable physical member execution");
      const now = events[0]?.createdAt ?? new Date().toISOString();
      if (!existing) this.sql.run(`INSERT INTO member_turn_traces
        (member_turn_id, attempt, conversation_id, topic_id, run_id, bot_id, source_turn_id, recording_state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'recording', ?, ?)`,
      [identity.memberTurnId, identity.attempt, identity.conversationId, identity.topicId, identity.runId,
        identity.botId, identity.sourceTurnId, now, now]);
      const firstSeq = (existing?.last_seq ?? 0) + (events.length ? 1 : 0);
      let lastSeq = existing?.last_seq ?? 0;
      let plan = existing?.plan_json ?? null;
      for (let index = 0; index < events.length; index++) {
        const event = events[index]!;
        this.sql.run(`INSERT INTO member_turn_trace_events (member_turn_id, attempt, seq, kind, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`, [identity.memberTurnId, identity.attempt, ++lastSeq, event.kind, payloads[index]!, event.createdAt]);
        if (event.kind === "plan") plan = JSON.stringify(event.payload.entries);
      }
      const terminal = events.at(-1)?.kind === "terminal";
      const recordingState = terminal ? "complete" : "recording";
      const updatedAt = events.at(-1)?.createdAt ?? now;
      this.sql.run(`UPDATE member_turn_traces SET last_seq = ?, plan_json = ?, recording_state = ?, updated_at = ?, finished_at = ?
        WHERE member_turn_id = ? AND attempt = ?`, [lastSeq, plan, recordingState, updatedAt, terminal ? updatedAt : null,
        identity.memberTurnId, identity.attempt]);
      this.sql.run(`INSERT INTO member_turn_trace_batches
        (member_turn_id, attempt, batch_id, fingerprint, first_seq, last_seq, recording_state) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [identity.memberTurnId, identity.attempt, batchId, fingerprint, firstSeq, lastSeq, recordingState]);
      return { reused: false, firstSeq, lastSeq, recordingState };
    });
  }

  listEvents(query: MemberTurnTraceQuery, options: MemberTurnTracePageOptions = {}): MemberTurnTracePage | undefined {
    const afterSeq = options.afterSeq ?? 0;
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) error("trace_cursor_invalid", "trace cursor must be a nonnegative integer");
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 50)));
    const maxBytes = Math.min(MAX_PAGE_BYTES, Math.floor(options.maxBytes ?? DEFAULT_PAGE_BYTES));
    if (!Number.isFinite(limit) || !Number.isFinite(maxBytes) || maxBytes < 1) error("trace_page_invalid", "trace page bounds must be finite positive numbers");
    return this.sql.transaction(() => {
      const row = this.row(query);
      if (!row) return undefined;
      const page: MemberTurnTracePage = { ...record(row), events: [], nextSeq: afterSeq, hasMore: row.last_seq > afterSeq };
      let used = bytes(page);
      if (used > maxBytes) error("trace_page_too_small", "trace metadata exceeds requested page byte bound");
      const rows = this.sql.all<EventRow>(`SELECT seq, kind, payload_json, created_at FROM member_turn_trace_events
        WHERE member_turn_id = ? AND attempt = ? AND seq > ? ORDER BY seq LIMIT ?`,
      [query.memberTurnId, query.attempt, afterSeq, limit]);
      for (const event of rows) {
        const parsed = { seq: event.seq, kind: event.kind, payload: JSON.parse(event.payload_json), createdAt: event.created_at } as MemberTurnTraceEvent;
        // Incremental UTF-8 budget: appending one array element costs its JSON plus a comma separator.
        // A small allowance covers nextSeq/hasMore growth without reserializing the accumulated page per event.
        const delta = Buffer.byteLength(JSON.stringify(parsed), "utf8") + (page.events.length ? 1 : 0) + 16;
        if (used + delta > maxBytes) {
          if (!page.events.length) error("trace_page_too_small", "next trace event exceeds requested page byte bound");
          page.hasMore = row.last_seq > page.nextSeq;
          break;
        }
        used += delta;
        page.events.push(parsed);
        page.nextSeq = event.seq;
        page.hasMore = row.last_seq > event.seq;
      }
      return page;
    }, "deferred");
  }

  interrupt(identity: MemberTurnTraceIdentity, reason: string, now = new Date().toISOString()): boolean {
    return this.sql.transaction(() => {
      const row = this.row(identity);
      if (!row || row.recording_state !== "recording") return false;
      this.sql.run(`UPDATE member_turn_traces SET recording_state = 'interrupted', completeness_reason = ?, updated_at = ?, finished_at = ?
        WHERE member_turn_id = ? AND attempt = ?`, [reason, now, now, identity.memberTurnId, identity.attempt]);
      return true;
    });
  }

  activateConsumer(now = new Date().toISOString()): number {
    return this.sql.transaction(() => {
      const count = this.sql.get<{ count: number }>("SELECT COUNT(*) AS count FROM member_turn_traces WHERE recording_state = 'recording'")!.count;
      this.sql.run(`UPDATE member_turn_traces SET recording_state = 'interrupted', completeness_reason = 'consumer_restarted', updated_at = ?, finished_at = ?
        WHERE recording_state = 'recording'`, [now, now]);
      return count;
    });
  }

  deleteRows(conversationId: string, topicId?: string): void {
    const scope = "conversation_id = ?" + (topicId === undefined ? "" : " AND topic_id = ?");
    const params = topicId === undefined ? [conversationId] : [conversationId, topicId];
    for (const table of ["member_turn_trace_events", "member_turn_trace_batches"]) {
      this.sql.run(`DELETE FROM ${table} WHERE (member_turn_id, attempt) IN
        (SELECT member_turn_id, attempt FROM member_turn_traces WHERE ${scope})`, params);
    }
    this.sql.run(`DELETE FROM member_turn_traces WHERE ${scope}`, params);
  }
}
