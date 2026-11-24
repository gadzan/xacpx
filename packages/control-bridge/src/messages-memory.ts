import { randomInt } from "node:crypto";

import type { AttachmentMetadata, MessageDirection, MessageRecordDto, PeerMessageHistoryEntry } from "@ganglion/xacpx-relay-protocol";

export interface QueueCorrelation {
  instanceId: string;
  sessionAlias: string;
  queueItemId: string;
}

type StructuredTurn = NonNullable<MessageRecordDto["structured"]>;

/**
 * Ephemeral hub transcript (history-retirement, 2026-11).
 *
 * The hub no longer persists message CONTENT to SQLite — message rows live only
 * in this process's memory and die with it. The daemon's own transcript is the
 * source of truth; relay-web keeps the durable client-side copy in IndexedDB
 * (see `packages/relay-web/src/lib/session-tail-cache.ts`).
 *
 * Surface-compatible with `MessageStore` (see `MessageHistoryStore`): every
 * method keeps the same signature and observable semantics (message ids stay
 * numeric and increasing, cursor pagination and queue reconciliation behave the
 * same), so `server.ts` / `http/app.ts` need no logic changes — only the
 * backing store and its durability change.
 *
 * Cross-boot id uniqueness: ids start from a per-boot random base
 * (`floor(now/1000) * 2^22 + crypto-random 22 bits`) instead of 1, so rows
 * from a previous boot almost never share an id with rows from this boot
 * when the client merges its IndexedDB cache with a fresh boot's hub page
 * by id. Within a boot ids are strictly increasing; across boots they are
 * ordered by second (same-second boots differ only by the random offset).
 * "Almost" is deliberate: with ~10k ids per boot in a 4M-per-second space,
 * same-second (or clock-rollback) collisions are possible but negligible —
 * the old `Date.now()*1024` comment claiming they "can never collide" was
 * wrong (1024 ids/ms < 10k ids/boot, so the next boot's base landed inside
 * the previous boot's used range).
 *
 * Bounds (the hub is no longer an archive, only live + recovery working set):
 * - per session: newest SESSION_MAX_ROWS rows (oldest-first eviction);
 * - global: GLOBAL_MAX_ROWS rows across all sessions (oldest-first eviction).
 * Rows that only the hub ever saw (never broadcast/acked) are lost on restart —
 * accepted and documented: the daemon re-sends its mirror via
 * `instance.state.sync` on reconnect, and recovery receipts (SQLite, no message
 * content) still dedup redelivered `finishedOffline` entries.
 */
export const MEMORY_SESSION_MAX_ROWS = 500;
export const MEMORY_GLOBAL_MAX_ROWS = 10_000;

/** Id stride per wall-clock second: second * STRIDE dominates, so boots in
 *  different seconds are ordered with no overlap as long as a boot consumes
 *  fewer than STRIDE ids (global ring caps live rows at 10k; promotions add
 *  a bounded extra). Same-second boots (or a clock rollback) share the
 *  second and differ only by the random offset — collision then needs two
 *  10k-wide intervals to overlap in a 4M space (~0.5%), accepted as
 *  "almost never". `sec * STRIDE` is ~7.1e15, inside Number.MAX_SAFE_INTEGER. */
export const MEMORY_BOOT_ID_STRIDE = 2 ** 22;

interface MemoryRow {
  id: number;
  instanceId: string;
  sessionAlias: string;
  direction: MessageDirection;
  text: string;
  createdAt: string;
  structured?: string;
  attachments?: string;
  queueItemId?: string | null;
  queueFallback: boolean;
  originQueueItemId?: string | null;
  promptRequestId?: string | null;
  nodeId?: string | null;
  startedAt?: number | null;
  slotAfterId?: number | null;
  startedAfterSeq?: number | null;
}

export interface MemoryMessagePage {
  messages: MessageRecordDto[];
  hasMore: boolean;
}

const keyOf = (instanceId: string, sessionAlias: string): string => `${instanceId}\0${sessionAlias}`;

function toDto(r: MemoryRow): MessageRecordDto {
  return {
    id: r.id,
    instanceId: r.instanceId,
    sessionAlias: r.sessionAlias,
    direction: r.direction,
    text: r.text,
    createdAt: r.createdAt,
    ...(r.queueItemId ? { queueItemId: r.queueItemId } : {}),
    ...(r.nodeId ? { nodeId: r.nodeId } : {}),
    ...(typeof r.startedAt === "number" ? { startedAt: r.startedAt } : {}),
    ...(typeof r.slotAfterId === "number" ? { slotAfterId: r.slotAfterId } : {}),
    ...(typeof r.startedAfterSeq === "number" ? { startedAfterSeq: r.startedAfterSeq } : {}),
    ...(r.structured ? { structured: JSON.parse(r.structured) as StructuredTurn } : {}),
    ...(r.attachments ? { attachments: JSON.parse(r.attachments) as AttachmentMetadata[] } : {}),
  };
}

export class MemoryMessageStore {
  private readonly sessions = new Map<string, MemoryRow[]>();
  private totalRows = 0;
  private nextId: number;
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
    // Random per-boot id base: same-second restarts (and clock rollbacks)
    // no longer share a base, so a new boot's ids almost never collide with
    // the dead rows a client cache may still hold (see class doc). Uses the
    // injected clock (not Date.now) so tests can pin separate boots.
    this.nextId = Math.floor(this.now().getTime() / 1000) * MEMORY_BOOT_ID_STRIDE + randomInt(MEMORY_BOOT_ID_STRIDE);
  }

  private rowsFor(instanceId: string, sessionAlias: string): MemoryRow[] {
    let rows = this.sessions.get(keyOf(instanceId, sessionAlias));
    if (!rows) {
      rows = [];
      this.sessions.set(keyOf(instanceId, sessionAlias), rows);
    }
    return rows;
  }

  private takeId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  /** Append a row, then enforce the per-session ring and the global budget (both oldest-first). */
  private insert(row: Omit<MemoryRow, "id">): number {
    const id = this.takeId();
    const rows = this.rowsFor(row.instanceId, row.sessionAlias);
    rows.push({ ...row, id });
    this.totalRows += 1;
    if (rows.length > MEMORY_SESSION_MAX_ROWS) {
      const drop = rows.length - MEMORY_SESSION_MAX_ROWS;
      rows.splice(0, drop);
      this.totalRows -= drop;
    }
    this.enforceGlobalBudget();
    return id;
  }

  private enforceGlobalBudget(): void {
    if (this.totalRows <= MEMORY_GLOBAL_MAX_ROWS) return;
    // Oldest-first across sessions by row creation order (ids are boot-global increasing).
    const all: Array<{ k: string; row: MemoryRow }> = [];
    for (const [k, rows] of this.sessions) for (const row of rows) all.push({ k, row });
    all.sort((a, b) => a.row.id - b.row.id);
    const drop = this.totalRows - MEMORY_GLOBAL_MAX_ROWS;
    const victims = new Set(all.slice(0, drop).map((e) => e.row));
    for (const [k, rows] of this.sessions) {
      const kept = rows.filter((r) => !victims.has(r));
      if (kept.length !== rows.length) this.sessions.set(k, kept);
    }
    this.totalRows -= drop;
  }

  append(
    instanceId: string,
    sessionAlias: string,
    direction: MessageDirection,
    text: string,
    structured?: StructuredTurn,
    attachments?: AttachmentMetadata[],
    promptRequestId?: string,
    createdAt?: string,
    startedAt?: number,
    slotAfterId?: number,
    startedAfterSeq?: number,
  ): number {
    return this.insert({
      instanceId,
      sessionAlias,
      direction,
      text,
      createdAt: createdAt ?? this.now().toISOString(),
      structured: structured ? JSON.stringify(structured) : undefined,
      attachments: attachments && attachments.length > 0 ? JSON.stringify(attachments) : undefined,
      promptRequestId: promptRequestId ?? null,
      queueItemId: null,
      queueFallback: false,
      originQueueItemId: null,
      nodeId: null,
      startedAt: startedAt ?? null,
      slotAfterId: slotAfterId ?? null,
      startedAfterSeq: startedAfterSeq ?? null,
    });
  }

  updateAgentMessage(
    instanceId: string,
    sessionAlias: string,
    message: PeerMessageHistoryEntry,
  ): boolean {
    const direction = message.direction === "sent" ? "out" : "in";
    const rows = this.rowsFor(instanceId, sessionAlias);
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!;
      if (row.direction !== direction || !row.structured) continue;
      let parsed: StructuredTurn;
      try {
        parsed = JSON.parse(row.structured) as StructuredTurn;
      } catch {
        continue;
      }
      if (parsed.agentMessage?.messageId !== message.messageId) continue;
      parsed.agentMessage = message;
      row.structured = JSON.stringify(parsed);
      return true;
    }
    return false;
  }

  patchAgentMessageCompletionStatus(
    instanceId: string,
    sessionAlias: string,
    messageId: string,
    completionStatus: "completed" | "failed" | "cancelled",
  ): boolean {
    const rows = this.rowsFor(instanceId, sessionAlias);
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!;
      if (!row.structured) continue;
      let parsed: StructuredTurn;
      try {
        parsed = JSON.parse(row.structured) as StructuredTurn;
      } catch {
        return false;
      }
      if (parsed.agentMessage?.messageId !== messageId) continue;
      if (!parsed.agentMessage) return false;
      parsed.agentMessage = { ...parsed.agentMessage, completionStatus };
      row.structured = JSON.stringify(parsed);
      return true;
    }
    return false;
  }

  markQueued(rowId: number, correlation: QueueCorrelation): void {
    const rows = this.rowsFor(correlation.instanceId, correlation.sessionAlias);
    const target = rows.find((r) => r.id === rowId);
    if (target) {
      target.queueItemId = correlation.queueItemId;
      target.promptRequestId = null;
    }
    // Absorb a racing fallback row at the SAME position (mirrors the SQLite
    // UPDATE id = fallback.id): drop the fallback, move the real row into its slot.
    const fbIdx = rows.findIndex(
      (r) => r.queueItemId === correlation.queueItemId && r.queueFallback,
    );
    if (target && fbIdx >= 0 && rows[fbIdx]!.id !== target.id) {
      const [fb] = rows.splice(fbIdx, 1);
      // Net row count drops by exactly one here: the fallback row is gone
      // and the target row is only MOVED (spliced out below, re-inserted
      // after). No counter adjustment on the re-insert — crediting +1 there
      // would inflate totalRows and trigger the global budget early.
      this.totalRows -= 1;
      const at = rows.indexOf(target);
      rows.splice(at, 1);
      target.id = fb!.id;
      target.queueItemId = null;
      target.originQueueItemId = correlation.queueItemId;
      target.promptRequestId = null;
      // Re-insert at id order (fallback id <= every live id by construction).
      let insertAt = 0;
      while (insertAt < rows.length && rows[insertAt]!.id < target.id) insertAt++;
      rows.splice(insertAt, 0, target);
    }
  }

  promoteQueued(correlation: QueueCorrelation): boolean {
    const rows = this.rowsFor(correlation.instanceId, correlation.sessionAlias);
    const idx = rows.findIndex(
      (r) => r.queueItemId === correlation.queueItemId && !r.queueFallback,
    );
    if (idx < 0) return false;
    const [row] = rows.splice(idx, 1);
    row!.id = this.takeId();
    row!.queueItemId = null;
    row!.originQueueItemId = correlation.queueItemId;
    row!.promptRequestId = null;
    rows.push(row!);
    this.enforceGlobalBudget();
    return true;
  }

  queuedState(correlation: QueueCorrelation): "pending" | "fallback" | "executed" | "absent" {
    const rows = this.rowsFor(correlation.instanceId, correlation.sessionAlias);
    const live = rows.find((r) => r.queueItemId === correlation.queueItemId);
    if (live) return live.queueFallback ? "fallback" : "pending";
    return rows.some((r) => r.originQueueItemId === correlation.queueItemId) ? "executed" : "absent";
  }

  appendExecutedQueuedFallback(correlation: QueueCorrelation, text: string): number {
    return this.insert({
      instanceId: correlation.instanceId,
      sessionAlias: correlation.sessionAlias,
      direction: "in",
      text,
      createdAt: this.now().toISOString(),
      queueItemId: null,
      queueFallback: false,
      originQueueItemId: correlation.queueItemId,
      promptRequestId: null,
      nodeId: null,
      startedAt: null,
      slotAfterId: null,
      startedAfterSeq: null,
    });
  }

  finalizeQueuedFallback(correlation: QueueCorrelation): void {
    const rows = this.rowsFor(correlation.instanceId, correlation.sessionAlias);
    for (const row of rows) {
      if (row.queueItemId === correlation.queueItemId && row.queueFallback) {
        row.queueItemId = null;
        row.originQueueItemId = correlation.queueItemId;
      }
    }
  }

  hasScheduledInbound(instanceId: string, sessionAlias: string, taskId: string): boolean {
    return this.rowsFor(instanceId, sessionAlias).some((r) => {
      if (r.direction !== "in" || !r.structured) return false;
      const parsed = JSON.parse(r.structured) as { scheduled?: { taskId?: string } };
      return parsed.scheduled?.taskId === taskId;
    });
  }

  appendQueuedFallback(correlation: QueueCorrelation, text: string): number {
    return this.insert({
      instanceId: correlation.instanceId,
      sessionAlias: correlation.sessionAlias,
      direction: "in",
      text,
      createdAt: this.now().toISOString(),
      queueItemId: correlation.queueItemId,
      queueFallback: true,
      originQueueItemId: null,
      promptRequestId: null,
      nodeId: null,
      startedAt: null,
      slotAfterId: null,
      startedAfterSeq: null,
    });
  }

  findByPromptRequest(instanceId: string, sessionAlias: string, promptRequestId: string): number | undefined {
    return this.rowsFor(instanceId, sessionAlias).find(
      (r) =>
        r.promptRequestId === promptRequestId &&
        r.direction === "in" &&
        r.queueItemId == null &&
        r.originQueueItemId == null,
    )?.id;
  }

  attachNodeId(
    instanceId: string,
    sessionAlias: string,
    nodeId: string,
    correlation: { promptRequestId?: string; queueItemId?: string; peerMessageId?: string } = {},
  ): void {
    const rows = this.rowsFor(instanceId, sessionAlias);
    const lookup = (field: "originQueueItemId" | "queueItemId" | "promptRequestId", value: string): number | undefined => {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i]![field] === value) return rows[i]!.id;
      }
      return undefined;
    };
    const rowId =
      (correlation.queueItemId !== undefined
        ? lookup("originQueueItemId", correlation.queueItemId)
          ?? lookup("queueItemId", correlation.queueItemId)
        : undefined)
      ?? (correlation.promptRequestId !== undefined
        ? lookup("promptRequestId", correlation.promptRequestId)
          ?? this.findByPeerMessage(instanceId, sessionAlias, correlation.promptRequestId)
        : undefined)
      ?? (correlation.peerMessageId !== undefined
        ? this.findByPeerMessage(instanceId, sessionAlias, correlation.peerMessageId)
        : undefined);
    if (rowId !== undefined) {
      const row = rows.find((r) => r.id === rowId);
      if (row) {
        row.nodeId = nodeId;
        return;
      }
    }
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!;
      if (row.direction === "in" && (row.nodeId == null)) {
        row.nodeId = nodeId;
        return;
      }
    }
  }

  findByPeerMessage(instanceId: string, sessionAlias: string, messageId: string): number | undefined {
    const rows = this.rowsFor(instanceId, sessionAlias);
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!;
      if (row.direction !== "in" || !row.structured) continue;
      try {
        const parsed = JSON.parse(row.structured) as StructuredTurn;
        if (parsed.agentMessage?.messageId === messageId) return row.id;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  promoteQueuedRow(rowId: number, correlation: QueueCorrelation): boolean {
    const rows = this.rowsFor(correlation.instanceId, correlation.sessionAlias);
    const idx = rows.findIndex(
      (r) => r.id === rowId && r.instanceId === correlation.instanceId && r.sessionAlias === correlation.sessionAlias,
    );
    if (idx < 0) return false;
    const [row] = rows.splice(idx, 1);
    row!.id = this.takeId();
    row!.queueItemId = null;
    row!.originQueueItemId = correlation.queueItemId;
    row!.promptRequestId = null;
    rows.push(row!);
    this.enforceGlobalBudget();
    return true;
  }

  /**
   * Newest `limit` non-pending rows, oldest-first. NOTE: unlike the SQLite
   * store this implementation cannot enforce the account-ownership JOIN (no
   * instances table in memory) — callers must pass an already-authorized
   * account/instance pair, which `server.ts` and `http/app.ts` both do via
   * `getOwned` before reaching this store.
   */
  listBySession(
    _accountId: string,
    instanceId: string,
    sessionAlias: string,
    opts: { limit?: number; before?: number } = {},
  ): MemoryMessagePage {
    const limit = opts.limit ?? 100;
    const before = opts.before ?? null;
    const visible = this.rowsFor(instanceId, sessionAlias)
      .filter((r) => r.queueItemId == null && (before === null || r.id < before))
      .slice()
      .sort((a, b) => b.id - a.id);
    const hasMore = visible.length > limit;
    const page = hasMore ? visible.slice(0, limit) : visible;
    return { hasMore, messages: page.reverse().map(toDto) };
  }

  listPendingBySession(
    _accountId: string,
    instanceId: string,
    sessionAlias: string,
  ): Array<{ queueItemId: string; textPreview: string; enqueuedAt: string }> {
    return this.rowsFor(instanceId, sessionAlias)
      .filter((r) => r.queueItemId != null)
      .slice()
      .sort((a, b) => a.id - b.id)
      .map((r) => ({
        queueItemId: r.queueItemId!,
        textPreview: r.text.length > 120 ? r.text.slice(0, 120) : r.text,
        enqueuedAt: r.createdAt,
      }));
  }

  deletePendingByQueueItem(instanceId: string, sessionAlias: string, queueItemId: string): boolean {
    const rows = this.rowsFor(instanceId, sessionAlias);
    const before = rows.length;
    const kept = rows.filter((r) => r.queueItemId !== queueItemId);
    if (kept.length === before) return false;
    this.sessions.set(keyOf(instanceId, sessionAlias), kept);
    this.totalRows -= before - kept.length;
    return true;
  }

  getById(
    _accountId: string,
    instanceId: string,
    sessionAlias: string,
    id: number,
  ): MessageRecordDto | null {
    const row = this.rowsFor(instanceId, sessionAlias).find((r) => r.id === id);
    return row ? toDto(row) : null;
  }

  drop(instanceId: string, sessionAlias: string, id: number): boolean {
    const rows = this.rowsFor(instanceId, sessionAlias);
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) return false;
    rows.splice(index, 1);
    this.totalRows -= 1;
    return true;
  }

  lastId(instanceId: string, sessionAlias: string): number | undefined {
    const rows = this.rowsFor(instanceId, sessionAlias);
    return rows.length === 0 ? undefined : rows[rows.length - 1]!.id;
  }

  deleteBySession(instanceId: string, sessionAlias: string): number {
    const rows = this.rowsFor(instanceId, sessionAlias);
    this.sessions.set(keyOf(instanceId, sessionAlias), []);
    this.totalRows -= rows.length;
    return rows.length;
  }

  /** Drop every row of an instance (instance deletion). Returns rows dropped.
   *  Without this, deleted-instance rows stay reachable-counted against the
   *  global budget even though no session page can ever read them again. */
  deleteByInstance(instanceId: string): number {
    const prefix = `${instanceId}\0`;
    let deleted = 0;
    for (const [k, rows] of this.sessions) {
      if (k.startsWith(prefix)) {
        deleted += rows.length;
        this.sessions.delete(k);
      }
    }
    this.totalRows -= deleted;
    return deleted;
  }

  /** No time-based pruning needed (rings already bound size); enforces per-session caps. Returns rows dropped. */
  prune(opts: { maxAgeMs?: number; maxPerSession?: number }): number {
    let deleted = 0;
    if (opts.maxAgeMs !== undefined) {
      const cutoff = this.now().getTime() - opts.maxAgeMs;
      for (const [k, rows] of this.sessions) {
        const kept = rows.filter((r) => Date.parse(r.createdAt) >= cutoff);
        if (kept.length !== rows.length) {
          deleted += rows.length - kept.length;
          this.totalRows -= rows.length - kept.length;
          this.sessions.set(k, kept);
        }
      }
    }
    if (opts.maxPerSession !== undefined) {
      for (const [k, rows] of this.sessions) {
        if (rows.length > opts.maxPerSession) {
          const drop = rows.length - opts.maxPerSession;
          this.sessions.set(k, rows.slice(drop));
          this.totalRows -= drop;
          deleted += drop;
        }
      }
    }
    return deleted;
  }
}
