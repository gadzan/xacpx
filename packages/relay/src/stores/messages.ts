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
}

export interface MessagePage {
  messages: MessageRecordDto[];
  /** True when older rows exist beyond this page (drives "load older" on scroll-up). */
  hasMore: boolean;
}

export class MessageStore {
  /** Queue starts can race the HTTP response that supplies the queue id. A fallback
   *  row keeps non-Web queue origins visible; the original persisted row replaces it
   *  if the matching HTTP response arrives afterwards. */
  private readonly startedQueueFallbacks = new Map<string, number | null>();

  constructor(private readonly db: SqlDriver, private readonly now: () => Date = () => new Date()) {}

  private queueKey(instanceId: string, sessionAlias: string, queueItemId: string): string {
    return `${instanceId}\0${sessionAlias}\0${queueItemId}`;
  }

  append(
    instanceId: string,
    sessionAlias: string,
    direction: MessageDirection,
    text: string,
    structured?: StructuredTurn,
    attachments?: AttachmentMetadata[],
  ): number {
    this.db.run(
      "INSERT INTO messages (instance_id, session_alias, direction, text, created_at, structured, attachments) VALUES (?,?,?,?,?,?,?)",
      [
        instanceId,
        sessionAlias,
        direction,
        text,
        this.now().toISOString(),
        structured ? JSON.stringify(structured) : null,
        attachments && attachments.length > 0 ? JSON.stringify(attachments) : null,
      ],
    );
    return this.db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
  }

  /** Associate an already-persisted Web prompt with the connector's queue id. */
  markQueued(rowId: number, instanceId: string, sessionAlias: string, queueItemId: string): void {
    this.db.run(
      "UPDATE messages SET queue_item_id = ? WHERE id = ? AND instance_id = ? AND session_alias = ?",
      [queueItemId, rowId, instanceId, sessionAlias],
    );
    const k = this.queueKey(instanceId, sessionAlias, queueItemId);
    if (!this.startedQueueFallbacks.has(k)) return;
    const fallbackId = this.startedQueueFallbacks.get(k);
    if (fallbackId !== null && fallbackId !== undefined) {
      this.db.run("DELETE FROM messages WHERE id = ?", [fallbackId]);
    }
    this.promoteQueued(instanceId, sessionAlias, queueItemId);
  }

  /** Move a queued inbound row to the current end of the transcript when execution
   *  starts. Updating the integer key preserves the existing cursor contract. */
  promoteQueued(instanceId: string, sessionAlias: string, queueItemId: string): boolean {
    const row = this.db.get<{ id: number }>(
      "SELECT id FROM messages WHERE instance_id = ? AND session_alias = ? AND queue_item_id = ?",
      [instanceId, sessionAlias, queueItemId],
    );
    const k = this.queueKey(instanceId, sessionAlias, queueItemId);
    if (!row) {
      this.startedQueueFallbacks.set(k, null);
      return false;
    }
    const nextId = this.db.get<{ id: number }>("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM messages")!.id;
    this.db.run("UPDATE messages SET id = ?, queue_item_id = NULL WHERE id = ?", [nextId, row.id]);
    this.startedQueueFallbacks.delete(k);
    return true;
  }

  recordQueuedFallback(instanceId: string, sessionAlias: string, queueItemId: string, rowId: number): void {
    const k = this.queueKey(instanceId, sessionAlias, queueItemId);
    if (this.startedQueueFallbacks.has(k)) this.startedQueueFallbacks.set(k, rowId);
  }

  forgetQueuedFallback(instanceId: string, sessionAlias: string, queueItemId: string): void {
    this.startedQueueFallbacks.delete(this.queueKey(instanceId, sessionAlias, queueItemId));
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
      `SELECT m.id, m.instance_id, m.session_alias, m.direction, m.text, m.created_at, m.structured, m.attachments
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
      messages: page.reverse().map((r) => ({
        id: r.id,
        instanceId: r.instance_id,
        sessionAlias: r.session_alias,
        direction: r.direction,
        text: r.text,
        createdAt: r.created_at,
        ...(r.structured ? { structured: JSON.parse(r.structured) as StructuredTurn } : {}),
        ...(r.attachments ? { attachments: JSON.parse(r.attachments) as AttachmentMetadata[] } : {}),
      })),
    };
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
