import { toRaw } from "vue";
import type { MessageRecordDto } from "@ganglion/xacpx-relay-protocol";

/** Stale-while-revalidate tail cache for session transcripts (spec #205).
 *
 *  Stores the last ≤10 persisted rows of a session in IndexedDB so
 *  `chat.select()` can seed the first screen while the authoritative history
 *  fetch is in flight. IndexedDB's quota (hundreds of MB) fits full structured
 *  rows — no per-entry byte budget or row degradation is needed (a 640KB tool
 *  turn overflowed the old localStorage budget and silently lost its cache).
 *  Validity comes from the [user, instanceId, alias] key plus three eviction
 *  layers: event-driven purge (remove/logout), reconciliation against live
 *  session lists, and LRU/TTL budget fallbacks. Every access is wrapped in
 *  try/catch — IndexedDB may be unavailable or blocked, and the cache must
 *  never become an error source. */

const DB_NAME = "xacpx.chat-tail";
// v2: the [lastAccess, bytes] "lru" index replaced the plain lastAccess index.
// v3: records carry the session incarnation (SessionDto.transportSession) plus
// an "identity" index — a same-alias recreation must not resurrect the deleted
// predecessor's tail.
const DB_VERSION = 3;
const STORE = "tails";

export const TAIL_ROWS = 10;
const GLOBAL_BUDGET_BYTES = 64 * 1024 * 1024;
// Aligned with the hub's historyRetentionDays default (30): rows older than the
// retention window are gone server-side anyway.
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ── Full-transcript retention (history-retirement, 2026-11) ─────────────────
// The hub no longer keeps a durable transcript, so relay-web IndexedDB is the
// durable client copy. Caps (per session, newest kept, oldest-first eviction):
export const TRANSCRIPT_MAX_ROWS = 1000;
export const TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024;

export interface TranscriptPage {
  /** Oldest-first. Newest `limit` rows of the cached transcript. */
  rows: MessageRecordDto[];
  /** More cached rows exist beyond this page (older, or newer than shown). */
  hasMore: boolean;
  /** Total cached rows for the session (before the page limit). */
  total: number;
  /** Cumulative rows evicted by caps for this session — drives the UI banner. */
  droppedTotal: number;
}

type TailRecord = {
  user: string;
  instanceId: string;
  alias: string;
  rows: MessageRecordDto[];
  lastAccess: number;
  bytes: number;
  /** Full cached transcript (newest TRANSCRIPT_MAX_ROWS); absent on pre-retirement records. */
  full?: MessageRecordDto[];
  /** Cumulative rows evicted by caps for this session. */
  droppedTotal?: number;
  /** Transport incarnation at write time; "" when unknown (matches anything).
   *  Always a string so the identity index covers every record. */
  incarnation: string;
};

/** Both sides known and different → the cached rows belong to a same-alias
 *  predecessor session. Unknown ("") on either side matches anything. */
const incarnationMismatch = (a: string, b: string): boolean => a !== "" && b !== "" && a !== b;

const keyOf = (user: string, instanceId: string, alias: string): [string, string, string] =>
  [user, instanceId, alias];

// Legacy localStorage entries (the pre-IndexedDB v1 cache) are swept once per
// page load — the cache is disposable, so old data is dropped, not migrated.
const LEGACY_PREFIXES = ["xacpx.chat.tail.", "xacpx.chat.tail-index."];
let sweptLegacy = false;
function sweepLegacyLocalStorage(): void {
  if (sweptLegacy) return;
  sweptLegacy = true;
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && LEGACY_PREFIXES.some((p) => key.startsWith(p))) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch { /* storage may be blocked */ }
}

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const opened = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("indexeddb-unavailable")); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // The cache is disposable: any schema change drops and recreates the
      // store, guaranteeing the current index layout regardless of prior version.
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      const store = db.createObjectStore(STORE, { keyPath: ["user", "instanceId", "alias"] });
      // Composite [lastAccess, bytes] index: a key-cursor walk yields both LRU
      // order and byte accounting without ever deserializing `rows`.
      store.createIndex("lru", ["lastAccess", "bytes"]);
      // Identity index: reconcile checks alias liveness AND incarnation match
      // via a key cursor — again without materializing any rows.
      store.createIndex("identity", ["user", "instanceId", "alias", "incarnation"]);
    };
    let blocked = false;
    req.onsuccess = () => {
      // A blocked open can still succeed later; the promise already rejected,
      // so close the orphan connection (a leak would block future upgrades).
      if (blocked) { req.result.close(); return; }
      sweepLegacyLocalStorage();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error ?? new Error("open-failed"));
    req.onblocked = () => { blocked = true; reject(new Error("open-blocked")); };
  });
  // A failed open must not be cached forever — a later call may succeed (e.g.
  // transient blocked state); the rejection itself is handled by each caller.
  dbPromise = opened;
  opened.catch(() => { if (dbPromise === opened) dbPromise = null; });
  return opened;
}

const asPromise = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("request-failed"));
  });

const txDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("tx-aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("tx-failed"));
  });

/** Test hook: drop the cached connection (and the legacy-sweep latch) so each
 *  test can start against a fresh fake IndexedDB factory. */
export async function resetTailCacheForTests(): Promise<void> {
  sweptLegacy = false;
  const p = dbPromise;
  dbPromise = null;
  if (p) { try { (await p).close(); } catch { /* already broken */ } }
}

/** Read the cached tail for a session, or null on miss/expiry/corruption or an
 *  incarnation mismatch (rows from a deleted same-alias predecessor). A hit
 *  refreshes the entry's lastAccess (LRU touch). */
export async function read(user: string, instanceId: string, alias: string, incarnation = ""): Promise<MessageRecordDto[] | null> {
  try {
    const db = await openDb();
    const key = keyOf(user, instanceId, alias);
    // Readonly get still serializes after any earlier overlapping readwrite tx
    // (IDB starts transactions in creation order), so a flush-write immediately
    // before a seed-read is always observed.
    const record = await asPromise<TailRecord | undefined>(
      db.transaction(STORE, "readonly").objectStore(STORE).get(key) as IDBRequest<TailRecord | undefined>,
    );
    const now = Date.now();
    const rows = record?.rows;
    // Expired, corrupted (non-array, empty, or non-object elements) or
    // predecessor-incarnation entries are dropped here — the cache must never
    // become an error source downstream.
    const valid = record !== undefined
      && now - record.lastAccess <= TTL_MS
      && !incarnationMismatch(typeof record.incarnation === "string" ? record.incarnation : "", incarnation)
      && Array.isArray(rows) && rows.length > 0
      && !rows.some((r) => typeof r !== "object" || r === null);
    if (!valid) {
      if (record) {
        try {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).delete(key);
          await txDone(tx);
        } catch { /* best-effort cleanup */ }
      }
      return null;
    }
    // LRU touch, as a read-modify-write INSIDE one readwrite transaction: a
    // touch that re-puts the snapshot read above would clobber a concurrent
    // writeTranscript that committed in between (the transcript write-back is
    // async, so a seed-read racing it is normal). Re-reading inside the tx makes
    // the touch a no-op on the data and only refresh lastAccess. Under real
    // quota pressure the put can fail; that must not nullify a hit whose rows are
    // already in hand.
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const fresh = await asPromise<TailRecord | undefined>(
        store.get(key) as IDBRequest<TailRecord | undefined>,
      );
      if (fresh) store.put({ ...fresh, lastAccess: now });
      await txDone(tx);
    } catch { /* touch is best-effort */ }
    return (rows as MessageRecordDto[]).slice(-TAIL_ROWS);
  } catch { return null; }
}

/** Strip a row to pure persisted DTO fields — client-only flags (`failed`,
 *  `status`) must not resurrect on a cache hit. */
function toCachedRow(row: MessageRecordDto): MessageRecordDto {
  const out: MessageRecordDto = {
    id: row.id,
    instanceId: row.instanceId,
    sessionAlias: row.sessionAlias,
    direction: row.direction,
    text: row.text,
    createdAt: row.createdAt,
  };
  if (row.queueItemId !== undefined) out.queueItemId = row.queueItemId;
  if (row.structured !== undefined) out.structured = row.structured;
  // The transcript is deeply reactive and only `structured` is markRaw'd, so
  // `attachments` arrives as a Vue Proxy — IDB's structured clone rejects
  // proxies (DataCloneError), silently killing every write for a session whose
  // tail holds an attachment row. toRaw yields the underlying plain tree.
  if (row.attachments !== undefined) out.attachments = toRaw(row.attachments);
  if (row.startedAt !== undefined) out.startedAt = row.startedAt;
  if (row.slotAfterId !== undefined) out.slotAfterId = row.slotAfterId;
  if (row.startedAfterSeq !== undefined) out.startedAfterSeq = row.startedAfterSeq;
  return out;
}

type LruEntry = { pk: [string, string, string]; lastAccess: number; bytes: number };
/** Walk the [lastAccess, bytes] index with a KEY cursor — LRU order + byte
 *  accounting without materializing a single `rows` payload. */
const lruEntries = (index: IDBIndex): Promise<LruEntry[]> =>
  new Promise((resolve, reject) => {
    const entries: LruEntry[] = [];
    const req = index.openKeyCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(entries); return; }
      const [lastAccess, bytes] = cursor.key as [number, number];
      entries.push({ pk: cursor.primaryKey as [string, string, string], lastAccess, bytes });
      cursor.continue();
    };
    req.onerror = () => reject(req.error ?? new Error("cursor-failed"));
  });

async function putAndEvict(db: IDBDatabase, record: TailRecord, now: number): Promise<void> {
  const tx = db.transaction(STORE, "readwrite");
  try {
    const store = tx.objectStore(STORE);
    // A write-back that doesn't know the incarnation yet ("" — e.g. the first
    // flush after a page refresh, racing loadSessions) must not downgrade the
    // entry's stored identity to the wildcard: preserve the previous tag.
    if (record.incarnation === "") {
      const prev = await asPromise<TailRecord | undefined>(
        store.get(keyOf(record.user, record.instanceId, record.alias)) as IDBRequest<TailRecord | undefined>,
      );
      if (typeof prev?.incarnation === "string" && prev.incarnation !== "") {
        record = { ...record, incarnation: prev.incarnation };
      }
    }
    store.put(record);
    // One ascending-lastAccess pass: drop expired entries, then LRU-evict others
    // while the total exceeds the budget (the fresh write is never a victim).
    const entries = await lruEntries(store.index("lru"));
    let total = entries.reduce((sum, e) => sum + (e.bytes || 0), 0);
    for (const e of entries) {
      if (e.pk[0] === record.user && e.pk[1] === record.instanceId && e.pk[2] === record.alias) continue;
      if (now - e.lastAccess > TTL_MS || total > GLOBAL_BUDGET_BYTES) {
        store.delete(e.pk);
        total -= e.bytes || 0;
      }
    }
    await txDone(tx);
  } catch (err) {
    // A quota failure on the put request aborts the tx, surfacing to the pending
    // cursor as AbortError — tx.error still holds the original QuotaExceededError
    // that write()'s fallback keys on.
    throw tx.error ?? err;
  }
}

/** Cache the tail of `rows` for a session: the last ≤TAIL_ROWS persisted rows
 *  (id !== undefined). Expired entries and LRU victims beyond the global
 *  budget are pruned in the same transaction. */
export async function write(user: string, instanceId: string, alias: string, rows: MessageRecordDto[], incarnation = ""): Promise<void> {
  try {
    // Snapshot synchronously — the caller's `rows` may mutate while IDB awaits.
    const tail = rows
      .filter((r) => typeof r.id === "number")
      .slice(-TAIL_ROWS)
      .map(toCachedRow)
      .map(stripOversizedPreviews);
    const key = keyOf(user, instanceId, alias);
    const db = await openDb();
    if (tail.length === 0) {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      await txDone(tx);
      return;
    }
    const now = Date.now();
    // Sum of per-row estimates (no full serialization — same estimator that
    // trims the transcript, so budget accounting matches eviction).
    const bytes = tail.reduce((sum, r) => sum + estimateRowBytes(r), 0);
    const record: TailRecord = { user, instanceId, alias, rows: tail, lastAccess: now, bytes, incarnation };
    try {
      await putAndEvict(db, record, now);
    } catch (err) {
      // Real quota exhausted below the 64MB logical budget (private browsing,
      // storage-pressured device): the cache is disposable, so drop everything
      // and retry the fresh write once — keeping the current session's tail is
      // the best possible outcome there.
      if ((err as DOMException | null)?.name !== "QuotaExceededError") throw err;
      const clearTx = db.transaction(STORE, "readwrite");
      clearTx.objectStore(STORE).clear();
      await txDone(clearTx);
      // The retry writes the caller's (possibly "") incarnation as-is: clear()
      // just wiped any previous tag, and the next reconcile adopts the live one.
      const retryTx = db.transaction(STORE, "readwrite");
      retryTx.objectStore(STORE).put(record);
      await txDone(retryTx);
    }
  } catch (err) {
    // The cache is an optimization, never an error source — but a swallowed
    // write failure freezes the entry at its last snapshot forever (a
    // DataCloneError on a reactive row did exactly that), so leave a trace.
    console.debug("[relay-web] tail-cache write failed", err);
  }
}

/** Merge `incoming` (the currently displayed window — usually NOT the full
 *  history) into `existing` by row id; incoming wins on conflict (it is the
 *  authoritative fresher copy). Both inputs are oldest-first. */
function unionById(existing: MessageRecordDto[], incoming: MessageRecordDto[]): MessageRecordDto[] {
  const byId = new Map<number, MessageRecordDto>();
  for (const r of existing) if (typeof r.id === "number") byId.set(r.id, r);
  for (const r of incoming) if (typeof r.id === "number") byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => (a.id as number) - (b.id as number));
}

const fullOf = (record: TailRecord | undefined): MessageRecordDto[] =>
  Array.isArray(record?.full) ? record.full as MessageRecordDto[] : (record?.rows ?? []);

/** Estimate a row's persisted weight in bytes without serializing it.
 *  JSON.stringify costs O(row) CPU AND allocates the full string; a session
 *  window merged from 50 rows can hold multi-hundred-KB previewUrl payloads, so a
 *  `while (JSON.stringify(kept))` halving loop serializes tens of MB per
 *  write-back and freezes the UI thread. Field-wise estimate: text/ids at
 *  face value, structured by its heavy parts, attachments by their persisted
 *  metadata + capped preview (oversized previewUrls are dropped at cache time).
 *  The estimate must track REAL persisted bytes: over-estimating by orders of
 *  magnitude does not "fail safe" — it evicts the user's real history. */
const ATTACHMENT_BYTES_CAP = 256 * 1024;
function estimateRowBytes(r: MessageRecordDto): number {
  let n = (r.text?.length ?? 0) * 2 + 64;
  n += (r.createdAt?.length ?? 0) * 2;
  const s = r.structured;
  if (s) {
    // Heavy parts only: tool steps (title/output/diff), reasoning, parts text.
    // Cheap scalars (ids, status, counts) are noise next to payload strings.
    const steps = s.toolSteps;
    if (steps) {
      for (const st of steps) {
        n += ((st.title?.length ?? 0) + (st.error?.length ?? 0)) * 2 + 64;
        const d = st.detail;
        if (d) {
          if (d.type === "text") n += ((d.text?.length ?? 0) + (d.output?.length ?? 0)) * 2;
          else if (d.type === "command") n += (d.output?.length ?? 0) * 2 + d.command.length * 2;
          else if (d.type === "search") n += (d.output?.length ?? 0) * 2 + d.query.length * 2;
          else if (d.type === "read") n += ((d.preview?.length ?? 0) + (d.path?.length ?? 0)) * 2;
          else if (d.type === "fields") for (const f of d.fields) n += (f.value?.length ?? 0) * 2;
          else if (d.type === "diff") n += ((d.oldText?.length ?? 0) + (d.newText?.length ?? 0)) * 2;
        }
      }
    }
    if (s.reasoning) n += s.reasoning.length * 2;
    if (s.parts) {
      for (const p of s.parts) {
        if (p.type === "text" || p.type === "reasoning") n += p.text.length * 2;
        // Tool parts duplicate toolSteps — counted above, skip.
      }
    }
    const am = s.agentMessage;
    if (am) n += ((am.content?.length ?? 0) + (am.messageId?.length ?? 0)) * 2 + 64;
  }
  if (r.attachments) {
    for (const a of r.attachments) {
      // A base64 previewUrl dominates the persisted bytes: cap per attachment
      // (at the relay's own 256KB preview admission bound, so everything the
      // hub legitimately holds also survives in cache) so one giant image
      // cannot starve an entire session. `size` is the ORIGINAL file size —
      // the file body is never cached, only metadata
      // (id/filename/mimeType/size/kind) — so it must not count toward the
      // byte budget: counting it over-estimates by orders of magnitude and
      // evicts the user's real history.
      const previewLen = a.previewUrl && a.previewUrl.startsWith("data:image/") ? Math.min(a.previewUrl.length, ATTACHMENT_BYTES_CAP) : 0;
      n += ((a.filename?.length ?? 0) + (a.mimeType?.length ?? 0)) * 2 + previewLen;
    }
  }
  return n;
}

/** Strip oversized attachment previewUrls before caching: a single huge data
 *  URL would eat the whole session byte budget on the next write-back. Metadata
 *  (filename/size/kind) stays; the stripped preview is metadata-only from then
 *  on — there is no hub re-hydration path for attachments (`ensureFullMessage`
 *  only hydrates compact structured tool cards), and after a hub restart the hub
 *  no longer holds the row at all. Same-boot hub rows still carry their preview,
 *  so `loadHistory`'s union restores it while the hub is alive. The cap matches
 *  the relay's preview admission bound, so legitimate rows are never stripped. */
export function stripOversizedPreviews(row: MessageRecordDto): MessageRecordDto {
  if (!row.attachments) return row;
  let changed = false;
  const attachments = row.attachments.map((a) => {
    const preview = (a as { previewUrl?: unknown }).previewUrl;
    if (typeof preview === "string" && preview.startsWith("data:image/") && preview.length > ATTACHMENT_BYTES_CAP) {
      changed = true;
      const copy = { ...a } as Record<string, unknown>;
      delete copy.previewUrl;
      return copy as unknown as typeof a;
    }
    return a;
  });
  return changed ? { ...row, attachments } : row;
}

/** Trim oldest-first to the per-session row + byte budgets. Returns the kept rows.
 *  Uses the field-wise estimator (no full serialization); one halving pass from
 *  the oldest end, so a pathological session costs O(n) estimates, not O(n·MB). */
function trimTranscript(rows: MessageRecordDto[]): { kept: MessageRecordDto[]; evicted: number } {
  let kept = rows.length > TRANSCRIPT_MAX_ROWS ? rows.slice(rows.length - TRANSCRIPT_MAX_ROWS) : rows;
  let evicted = rows.length - kept.length;
  // Byte budget: halve from the oldest end until it fits (log iterations on
  // cached per-row estimates — no JSON.stringify of the window at all).
  let sizes = kept.map(estimateRowBytes);
  let total = sizes.reduce((a, b) => a + b, 0);
  while (kept.length > 1 && total > TRANSCRIPT_MAX_BYTES) {
    const drop = Math.max(1, Math.floor(kept.length / 2));
    kept = kept.slice(drop);
    sizes = sizes.slice(drop);
    total = sizes.reduce((a, b) => a + b, 0);
    evicted += drop;
  }
  return { kept, evicted };
}

/**
 * Persist the currently displayed window into the full client transcript.
 *
 * Read-modify-write: `window` is only the loaded working set (newest ~50),
 * so it is UNIONED with the cached transcript by id instead of replacing it —
 * a blind replace would amputate everything the user has not scrolled to on
 * every flush. Rows without an id (optimistic / live-flushed) are skipped;
 * they enter the cache once the authoritative row lands. An empty window never
 * deletes (selection switches and empty sessions flush nothing); deletion is
 * explicit via drop()/dropAll().
 *
 * Returns this write's eviction count (`dropped`) for the cap banner.
 */
export async function writeTranscript(
  user: string,
  instanceId: string,
  alias: string,
  window: MessageRecordDto[],
  incarnation = "",
): Promise<{ stored: number; dropped: number }> {
  try {
    const incoming = window
      .filter((r) => typeof r.id === "number")
      .map(toCachedRow)
      .map(stripOversizedPreviews);
    if (incoming.length === 0) return { stored: 0, dropped: 0 };
    const db = await openDb();
    const key = keyOf(user, instanceId, alias);
    const prev = await asPromise<TailRecord | undefined>(
      db.transaction(STORE, "readonly").objectStore(STORE).get(key) as IDBRequest<TailRecord | undefined>,
    );
    // Incarnation mismatch (same-alias recreation) must not merge the
    // predecessor's transcript with the new session's rows — start over.
    const mismatch = prev !== undefined
      && incarnationMismatch(typeof prev.incarnation === "string" ? prev.incarnation : "", incarnation);
    const base = mismatch ? [] : fullOf(prev);
    const merged = unionById(base, incoming);
    const { kept, evicted } = trimTranscript(merged);
    const now = Date.now();
    // Persisted weight: sum of per-row estimates, re-checked on the KEPT
    // tail (not the pre-trim window) so lruEntries accounting matches.
    const bytes = kept.reduce((sum, r) => sum + estimateRowBytes(r), 0);
    const record: TailRecord = {
      user,
      instanceId,
      alias,
      rows: kept.slice(-TAIL_ROWS),
      lastAccess: now,
      bytes,
      full: kept,
      droppedTotal: (mismatch ? 0 : (prev?.droppedTotal ?? 0)) + evicted,
      incarnation: incarnation !== "" ? incarnation : (prev?.incarnation ?? ""),
    };
    await putAndEvict(db, record, now);
    return { stored: kept.length, dropped: evicted };
  } catch (err) {
    console.debug("[relay-web] tail-cache writeTranscript failed", err);
    return { stored: 0, dropped: 0 };
  }
}

/** Validate + resolve a record to its transcript, or null on miss/expiry/corruption. */
async function loadTranscript(
  db: IDBDatabase,
  key: [string, string, string],
  incarnation: string,
): Promise<{ record: TailRecord; full: MessageRecordDto[] } | null> {
  const record = await asPromise<TailRecord | undefined>(
    db.transaction(STORE, "readonly").objectStore(STORE).get(key) as IDBRequest<TailRecord | undefined>,
  );
  const now = Date.now();
  const full = fullOf(record);
  const valid = record !== undefined
    && now - record.lastAccess <= TTL_MS
    && !incarnationMismatch(typeof record.incarnation === "string" ? record.incarnation : "", incarnation)
    && full.length > 0
    && !full.some((r) => typeof r !== "object" || r === null);
  if (!valid) {
    if (record) {
      try {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(key);
        await txDone(tx);
      } catch { /* best-effort cleanup */ }
    }
    return null;
  }
  try {
    // Same read-modify-write touch as read(): re-read inside the write tx so a
    // concurrent writeTranscript is never rolled back to the snapshot above.
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const fresh = await asPromise<TailRecord | undefined>(
      store.get(key) as IDBRequest<TailRecord | undefined>,
    );
    if (fresh) store.put({ ...fresh, lastAccess: now });
    await txDone(tx);
  } catch { /* touch is best-effort */ }
  return { record, full };
}

export async function readTranscript(
  user: string,
  instanceId: string,
  alias: string,
  incarnation = "",
  limit = TRANSCRIPT_MAX_ROWS,
): Promise<TranscriptPage | null> {
  try {
    const db = await openDb();
    const loaded = await loadTranscript(db, keyOf(user, instanceId, alias), incarnation);
    if (!loaded) return null;
    const { record, full } = loaded;
    const rows = full.slice(-limit);
    return {
      rows,
      hasMore: full.length > rows.length,
      total: full.length,
      droppedTotal: record.droppedTotal ?? 0,
    };
  } catch { return null; }
}

export async function readOlder(
  user: string,
  instanceId: string,
  alias: string,
  beforeId: number,
  limit: number,
  incarnation = "",
): Promise<TranscriptPage | null> {
  try {
    const db = await openDb();
    const loaded = await loadTranscript(db, keyOf(user, instanceId, alias), incarnation);
    if (!loaded) return null;
    const { record, full } = loaded;
    const older = full.filter((r) => typeof r.id === "number" && (r.id as number) < beforeId);
    const rows = older.slice(-limit);
    return {
      rows,
      hasMore: older.length > rows.length,
      total: full.length,
      droppedTotal: record.droppedTotal ?? 0,
    };
  } catch { return null; }
}

export async function readRow(
  user: string,
  instanceId: string,
  alias: string,
  id: number,
  incarnation = "",
): Promise<MessageRecordDto | null> {
  try {
    const db = await openDb();
    const loaded = await loadTranscript(db, keyOf(user, instanceId, alias), incarnation);
    return loaded?.full.find((r) => r.id === id) ?? null;
  } catch { return null; }
}

/** Purge one session's cache — the remove hook (sleeping sessions KEEP their
 *  cache: they stay resumable and should still paint instantly). */
export async function drop(user: string, instanceId: string, alias: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(keyOf(user, instanceId, alias));
    await txDone(tx);
  } catch { /* best-effort */ }
}

/** Purge every cached transcript (plus legacy localStorage keys) — the logout hook. */
export async function dropAll(): Promise<void> {
  sweptLegacy = false;
  sweepLegacyLocalStorage();
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await txDone(tx);
  } catch { /* best-effort */ }
}

export type AliveSession = { alias: string; incarnation?: string };

/** Drop cached entries for an instance whose alias is not alive, or whose
 *  incarnation no longer matches the live session (same-alias recreation) —
 *  covers removals/recreations performed from other clients while the web was
 *  closed. Entries stored with an unknown ("") incarnation adopt the live one,
 *  so a later recreation is detectable even if the session is never revisited.
 *  Called as each instance's authoritative session list arrives. */
export async function reconcile(user: string, instanceId: string, aliveSessions: Iterable<AliveSession>): Promise<void> {
  try {
    const alive = new Map<string, string>();
    for (const s of aliveSessions) alive.set(s.alias, s.incarnation ?? "");
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    // [user, instanceId] prefix range over the identity index: an array upper
    // bound sorts after every string alias, so this spans exactly the
    // instance's entries. The KEY cursor exposes alias + stored incarnation
    // (index key) and the primary key — no row payloads are materialized.
    const range = IDBKeyRange.bound([user, instanceId], [user, instanceId, []], false, true);
    const adopt: Array<[IDBValidKey, string]> = [];
    await new Promise<void>((resolve, reject) => {
      const req = store.index("identity").openKeyCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(); return; }
        const [, , alias, stored] = cursor.key as [string, string, string, string];
        const live = alive.get(alias);
        if (live === undefined || incarnationMismatch(stored, live)) store.delete(cursor.primaryKey);
        else if (stored === "" && live !== "") adopt.push([cursor.primaryKey, live]);
        cursor.continue();
      };
      req.onerror = () => reject(req.error ?? new Error("cursor-failed"));
    });
    for (const [pk, live] of adopt) {
      const rec = await asPromise<TailRecord | undefined>(store.get(pk) as IDBRequest<TailRecord | undefined>);
      if (rec) store.put({ ...rec, incarnation: live });
    }
    await txDone(tx);
  } catch { /* best-effort */ }
}
