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
  constructor(private readonly db: SqlDriver, private readonly now: () => Date = () => new Date()) {}

  append(
    instanceId: string,
    sessionAlias: string,
    direction: MessageDirection,
    text: string,
    structured?: StructuredTurn,
    attachments?: AttachmentMetadata[],
  ): void {
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
