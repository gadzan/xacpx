import type { AttachmentMetadata, MessageDirection, MessageRecordDto } from "@ganglion/xacpx-relay-protocol";

import type { SqlDriver } from "../db.js";

type StructuredTurn = NonNullable<MessageRecordDto["structured"]>;

interface MessageRow {
  id: number;
  instance_id: string;
  session_alias: string;
  direction: MessageDirection;
  text: string;
  created_at: string;
  structured: string | null;
  attachments: string | null;
  queue_item_id: string | null;
}

export interface MessagePage {
  messages: MessageRecordDto[];
  /** True when older rows exist beyond this page (drives "load older" on scroll-up). */
  hasMore: boolean;
}

export interface QueueCorrelation {
  instanceId: string;
  sessionAlias: string;
  queueItemId: string;
}

function toDto(r: MessageRow): MessageRecordDto {
  return {
    id: r.id,
    instanceId: r.instance_id,
    sessionAlias: r.session_alias,
    direction: r.direction,
    text: r.text,
    createdAt: r.created_at,
    ...(r.queue_item_id ? { queueItemId: r.queue_item_id } : {}),
    ...(r.structured ? { structured: JSON.parse(r.structured) as StructuredTurn } : {}),
    ...(r.attachments ? { attachments: JSON.parse(r.attachments) as AttachmentMetadata[] } : {}),
  };
}

export class MessageStore {
  constructor(private readonly db: SqlDriver, private readonly now: () => Date = () => new Date()) {}

  append(
    instanceId: string,
    sessionAlias: string,
    direction: MessageDirection,
    text: string,
    structured?: StructuredTurn,
    attachments?: AttachmentMetadata[],
    promptRequestId?: string,
  ): number {
    this.db.run(
      "INSERT INTO messages (instance_id, session_alias, direction, text, created_at, structured, attachments, prompt_request_id) VALUES (?,?,?,?,?,?,?,?)",
      [
        instanceId,
        sessionAlias,
        direction,
        text,
        this.now().toISOString(),
        structured ? JSON.stringify(structured) : null,
        attachments && attachments.length > 0 ? JSON.stringify(attachments) : null,
        promptRequestId ?? null,
      ],
    );
    return this.db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
  }

  /** Associate an already-persisted Web prompt with the connector's queue id. The
   *  whole reconcile (set the id, absorb a racing fallback row) runs in ONE
   *  transaction — a crash between the statements would leave a double row. The
   *  initial UPDATE also CONSUMES the pre-write correlation (`prompt_request_id`):
   *  once the queue association is established the correlation's job is done, and
   *  keeping it would let a stale/buggy event re-assign the row by promptRequestId. */
  markQueued(rowId: number, correlation: QueueCorrelation): void {
    this.db.transaction(() => {
      this.db.run(
        "UPDATE messages SET queue_item_id = ?, prompt_request_id = NULL WHERE id = ? AND instance_id = ? AND session_alias = ?",
        [correlation.queueItemId, rowId, correlation.instanceId, correlation.sessionAlias],
      );
      const fallback = this.db.get<{ id: number }>(
        "SELECT id FROM messages WHERE instance_id = ? AND session_alias = ? AND queue_item_id = ? AND queue_fallback = 1",
        [correlation.instanceId, correlation.sessionAlias, correlation.queueItemId],
      );
      if (!fallback) return;
      // The drain event arrived before the RPC response. Replace its lightweight row
      // at the SAME sequence id, preserving execution order even if the turn already
      // emitted and persisted its reply before this response arrived. Retain the
      // queue association for recovery dedup (see promoteQueued) and consume the
      // pre-write correlation (the queue association now owns the row).
      this.db.run("DELETE FROM messages WHERE id = ?", [fallback.id]);
      this.db.run(
        "UPDATE messages SET id = ?, queue_item_id = NULL, origin_queue_item_id = ?, prompt_request_id = NULL WHERE id = ?",
        [fallback.id, correlation.queueItemId, rowId],
      );
    });
  }

  /** Move a queued inbound row to the current end of the transcript when execution
   *  starts. Updating the integer key preserves the existing cursor contract. The
   *  queue association is RETAINED in `origin_queue_item_id` so a recovery sync that
   *  re-sees the same queueItemId can tell "already executed" from "never existed" —
   *  a text-based dedup cannot (the user may have sent the identical prompt twice).
   *  `prompt_request_id` is CONSUMED here (cleared): the pre-write correlation only
   *  matters until the queue association is established — leaving it would make every
   *  later sync re-find the row by promptRequestId and re-move it to the transcript
   *  tail, breaking message ids and history order. */
  promoteQueued(correlation: QueueCorrelation): boolean {
    const row = this.db.get<{ id: number }>(
      "SELECT id FROM messages WHERE instance_id = ? AND session_alias = ? AND queue_item_id = ? AND queue_fallback = 0",
      [correlation.instanceId, correlation.sessionAlias, correlation.queueItemId],
    );
    if (!row) return false;
    const nextId = this.db.get<{ id: number }>("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM messages")!.id;
    this.db.run(
      "UPDATE messages SET id = ?, queue_item_id = NULL, origin_queue_item_id = ?, prompt_request_id = NULL WHERE id = ?",
      [nextId, correlation.queueItemId, row.id],
    );
    return true;
  }

  /** How a queueItemId maps to persisted rows, for recovery reconciliation:
   *  - "pending": a REAL queued row (queue_fallback = 0) still carries the id →
   *    promoteQueued() moves the already-persisted prompt to its execution position;
   *  - "fallback": a recovery/race fallback row (queue_fallback = 1) carries the id →
   *    no live HTTP RPC will ever come to merge it, so finalize it as executed;
   *  - "executed": a row was promoted/finalized for this id earlier
   *    (`origin_queue_item_id`) → the prompt is already in history, do NOT append a
   *    duplicate (text matching cannot distinguish a redelivery from a user sending
   *    the identical prompt twice);
   *  - "absent": no row at all → appendExecutedQueuedFallback() is the only way to
   *    get the prompt into history. */
  queuedState(correlation: QueueCorrelation): "pending" | "fallback" | "executed" | "absent" {
    const pending = this.db.get<{ id: number; queue_fallback: number }>(
      "SELECT id, queue_fallback FROM messages WHERE instance_id = ? AND session_alias = ? AND queue_item_id = ?",
      [correlation.instanceId, correlation.sessionAlias, correlation.queueItemId],
    );
    if (pending) return pending.queue_fallback === 0 ? "pending" : "fallback";
    const executed = this.db.get<{ found: number }>(
      "SELECT 1 AS found FROM messages WHERE instance_id = ? AND session_alias = ? AND origin_queue_item_id = ?",
      [correlation.instanceId, correlation.sessionAlias, correlation.queueItemId],
    );
    return executed ? "executed" : "absent";
  }

  /** Persist the prompt as an ALREADY-EXECUTED queued row: `queue_item_id` stays NULL
   *  and the association is recorded in `origin_queue_item_id`. Used by the recovery
   *  path when a queueItemId has no persisted row at all — the original HTTP request
   *  died with the pre-restart hub, so a TEMPORARY fallback row (queue_fallback = 1,
   *  waiting for markQueued) would never be finalized and the UI would show a run
   *  prompt as queued forever. ONE statement: an append + UPDATE split would leave a
   *  bare prompt row if the process died between them, and the retry would duplicate. */
  appendExecutedQueuedFallback(correlation: QueueCorrelation, text: string): number {
    this.db.run(
      "INSERT INTO messages (instance_id, session_alias, direction, text, created_at, origin_queue_item_id) VALUES (?,?,?,?,?,?)",
      [correlation.instanceId, correlation.sessionAlias, "in", text, this.now().toISOString(), correlation.queueItemId],
    );
    return this.db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
  }

  /** Finalize a recovery-created fallback row (queue_fallback = 1) as executed: clear
   *  the queued marker and record the association. promoteQueued() deliberately only
   *  matches queue_fallback = 0, so a fallback row must take this path instead. */
  finalizeQueuedFallback(correlation: QueueCorrelation): void {
    this.db.run(
      "UPDATE messages SET queue_item_id = NULL, origin_queue_item_id = ? WHERE instance_id = ? AND session_alias = ? AND queue_item_id = ? AND queue_fallback = 1",
      [correlation.queueItemId, correlation.instanceId, correlation.sessionAlias, correlation.queueItemId],
    );
  }

  /** Whether an inbound row for a scheduled origin (matched by `structured.scheduled.taskId`,
   *  not by prompt text or trailing position) already exists — a later queued row can
   *  push a scheduled turn's prompt out of the trailing position, so text/trailing
   *  matching would wrongly re-insert it on recovery. */
  hasScheduledInbound(instanceId: string, sessionAlias: string, taskId: string): boolean {
    const rows = this.db.all<{ structured: string | null }>(
      "SELECT structured FROM messages WHERE instance_id = ? AND session_alias = ? AND direction = 'in' AND structured IS NOT NULL",
      [instanceId, sessionAlias],
    );
    return rows.some((r) => {
      const structured = JSON.parse(r.structured!) as { scheduled?: { taskId?: string } };
      return structured.scheduled?.taskId === taskId;
    });
  }

  appendQueuedFallback(correlation: QueueCorrelation, text: string): number {
    // ONE statement (append + queued marker together) — a split write would leave a
    // bare row if the process died in between, and the retry would duplicate.
    this.db.run(
      "INSERT INTO messages (instance_id, session_alias, direction, text, created_at, queue_item_id, queue_fallback) VALUES (?,?,?,?,?,?,1)",
      [correlation.instanceId, correlation.sessionAlias, "in", text, this.now().toISOString(), correlation.queueItemId],
    );
    return this.db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
  }

  /** The pre-written inbound row for a hub-issued prompt request (correlates a drained
   *  queue item back to the row even when the queued RPC response was lost). Scoped to
   *  the session AND to rows with no queue/origin association yet — an already-queued
   *  row belongs to a DIFFERENT queue item and must not be re-assigned by a stale
   *  promptRequestId. */
  findByPromptRequest(instanceId: string, sessionAlias: string, promptRequestId: string): number | undefined {
    const row = this.db.get<{ id: number }>(
      "SELECT id FROM messages WHERE instance_id = ? AND session_alias = ? AND prompt_request_id = ? AND direction = 'in' AND queue_item_id IS NULL AND origin_queue_item_id IS NULL",
      [instanceId, sessionAlias, promptRequestId],
    );
    return row?.id;
  }

  /** Promote a KNOWN inbound row (found via promptRequestId) to its execution position
   *  and record the executed queue association — the row was pre-written without a
   *  queue marker, so promoteQueued() could not find it. Session-scoped; returns
   *  whether the row was actually updated (the UPDATE moves the row to a new id, so
   *  the match is checked via changes(), not a re-query by the old id). */
  promoteQueuedRow(rowId: number, correlation: QueueCorrelation): boolean {
    const nextId = this.db.get<{ id: number }>("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM messages")!.id;
    this.db.run(
      "UPDATE messages SET id = ?, queue_item_id = NULL, origin_queue_item_id = ?, prompt_request_id = NULL WHERE id = ? AND instance_id = ? AND session_alias = ?",
      [nextId, correlation.queueItemId, rowId, correlation.instanceId, correlation.sessionAlias],
    );
    const changed = this.db.get<{ n: number }>("SELECT changes() AS n");
    return (changed?.n ?? 0) > 0;
  }

  /**
   * One page of a session's history, oldest-first, scoped to the owning account.
   * Without `before` returns the most recent `limit` rows; with `before` returns the
   * `limit` rows immediately OLDER than that message id (cursor pagination for
   * "load older" on scroll-up). `hasMore` reports whether further-back rows exist.
   */
  listBySession(
    accountId: string,
    instanceId: string,
    sessionAlias: string,
    opts: { limit?: number; before?: number } = {},
  ): MessagePage {
    const limit = opts.limit ?? 100;
    const before = opts.before ?? null;
    // Fetch one extra row to detect whether older history remains, then drop it.
    const rows = this.db.all<MessageRow>(
      `SELECT m.id, m.instance_id, m.session_alias, m.direction, m.text, m.created_at, m.structured, m.attachments, m.queue_item_id
       FROM messages m JOIN instances i ON i.id = m.instance_id
       WHERE i.account_id = ? AND m.instance_id = ? AND m.session_alias = ?
         AND (? IS NULL OR m.id < ?)
       ORDER BY m.id DESC LIMIT ?`,
      [accountId, instanceId, sessionAlias, before, before, limit + 1],
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      hasMore,
      messages: page.reverse().map(toDto),
    };
  }

  /** One persisted row, account-scoped. Used to hydrate compact list rows on expand. */
  getById(
    accountId: string,
    instanceId: string,
    sessionAlias: string,
    id: number,
  ): MessageRecordDto | null {
    const row = this.db.get<MessageRow>(
      `SELECT m.id, m.instance_id, m.session_alias, m.direction, m.text, m.created_at, m.structured, m.attachments, m.queue_item_id
       FROM messages m JOIN instances i ON i.id = m.instance_id
       WHERE i.account_id = ? AND m.instance_id = ? AND m.session_alias = ? AND m.id = ?`,
      [accountId, instanceId, sessionAlias, id],
    );
    return row ? toDto(row) : null;
  }

  /** Permanently removes the Hub-cached history for one logical session. */
  deleteBySession(instanceId: string, sessionAlias: string): number {
    const before = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM messages WHERE instance_id = ? AND session_alias = ?",
      [instanceId, sessionAlias],
    );
    this.db.run(
      "DELETE FROM messages WHERE instance_id = ? AND session_alias = ?",
      [instanceId, sessionAlias],
    );
    return before?.n ?? 0;
  }

  /** Deletes messages older than maxAgeMs and/or beyond the newest maxPerSession per (instance, session). Returns rows deleted. */
  prune(opts: { maxAgeMs?: number; maxPerSession?: number }): number {
    let deleted = 0;
    if (opts.maxAgeMs !== undefined) {
      const cutoff = new Date(this.now().getTime() - opts.maxAgeMs).toISOString();
      const before = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE created_at < ?", [cutoff]);
      this.db.run("DELETE FROM messages WHERE created_at < ?", [cutoff]);
      deleted += before?.n ?? 0;
    }
    if (opts.maxPerSession !== undefined) {
      const groups = this.db.all<{ instance_id: string; session_alias: string }>(
        "SELECT instance_id, session_alias FROM messages GROUP BY instance_id, session_alias HAVING COUNT(*) > ?",
        [opts.maxPerSession],
      );
      for (const g of groups) {
        const before = this.db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM messages WHERE instance_id = ? AND session_alias = ?",
          [g.instance_id, g.session_alias],
        );
        this.db.run(
          `DELETE FROM messages WHERE instance_id = ? AND session_alias = ? AND id NOT IN (
             SELECT id FROM messages WHERE instance_id = ? AND session_alias = ? ORDER BY id DESC LIMIT ?
           )`,
          [g.instance_id, g.session_alias, g.instance_id, g.session_alias, opts.maxPerSession],
        );
        deleted += Math.max(0, (before?.n ?? 0) - opts.maxPerSession);
      }
    }
    return deleted;
  }
}
