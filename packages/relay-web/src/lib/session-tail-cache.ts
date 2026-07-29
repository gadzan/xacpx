import type { MessageRecordDto } from "@ganglion/xacpx-relay-protocol";

/** Stale-while-revalidate tail cache for session transcripts (spec #205).
 *
 *  Stores the last ≤30 persisted rows of a session in IndexedDB so
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

export const TAIL_ROWS = 30;
const GLOBAL_BUDGET_BYTES = 64 * 1024 * 1024;
// Aligned with the hub's historyRetentionDays default (30): rows older than the
// retention window are gone server-side anyway.
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

type TailRecord = {
  user: string;
  instanceId: string;
  alias: string;
  rows: MessageRecordDto[];
  lastAccess: number;
  bytes: number;
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
    // LRU touch in its own transaction: under real quota pressure the put can
    // fail, and that must not nullify a hit whose rows are already in hand.
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ ...record, lastAccess: now });
      await txDone(tx);
    } catch { /* touch is best-effort */ }
    return rows as MessageRecordDto[];
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
  if (row.attachments !== undefined) out.attachments = row.attachments;
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

/** Cache the tail of `rows` for a session: the last ≤30 persisted rows
 *  (id !== undefined). Expired entries and LRU victims beyond the global
 *  budget are pruned in the same transaction. */
export async function write(user: string, instanceId: string, alias: string, rows: MessageRecordDto[], incarnation = ""): Promise<void> {
  try {
    // Snapshot synchronously — the caller's `rows` may mutate while IDB awaits.
    const tail = rows.filter((r) => typeof r.id === "number").slice(-TAIL_ROWS).map(toCachedRow);
    const key = keyOf(user, instanceId, alias);
    const db = await openDb();
    if (tail.length === 0) {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      await txDone(tx);
      return;
    }
    const now = Date.now();
    // Serialized length ≈ UTF-16 code units; ×2 approximates the storage bytes.
    const bytes = JSON.stringify(tail).length * 2;
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
  } catch { /* cache is an optimization, never an error source */ }
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
