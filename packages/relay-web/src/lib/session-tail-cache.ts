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
const DB_VERSION = 1;
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
};

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
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: ["user", "instanceId", "alias"] });
        store.createIndex("lastAccess", "lastAccess");
      }
    };
    req.onsuccess = () => { sweepLegacyLocalStorage(); resolve(req.result); };
    req.onerror = () => reject(req.error ?? new Error("open-failed"));
    req.onblocked = () => reject(new Error("open-blocked"));
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

/** Read the cached tail for a session, or null on miss/expiry/corruption.
 *  A hit refreshes the entry's lastAccess (LRU touch). */
export async function read(user: string, instanceId: string, alias: string): Promise<MessageRecordDto[] | null> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const key = keyOf(user, instanceId, alias);
    const record = await asPromise<TailRecord | undefined>(store.get(key) as IDBRequest<TailRecord | undefined>);
    const now = Date.now();
    const rows = record?.rows;
    // Expired or corrupted entries (non-array, empty, or non-object elements) are
    // dropped here — the cache must never become an error source downstream.
    const valid = record !== undefined
      && now - record.lastAccess <= TTL_MS
      && Array.isArray(rows) && rows.length > 0
      && !rows.some((r) => typeof r !== "object" || r === null);
    if (!valid) {
      if (record) store.delete(key);
      await txDone(tx);
      return null;
    }
    store.put({ ...record, lastAccess: now });
    await txDone(tx);
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

/** Cache the tail of `rows` for a session: the last ≤30 persisted rows
 *  (id !== undefined). Expired entries and LRU victims beyond the global
 *  budget are pruned in the same transaction. */
export async function write(user: string, instanceId: string, alias: string, rows: MessageRecordDto[]): Promise<void> {
  try {
    // Snapshot synchronously — the caller's `rows` may mutate while IDB awaits.
    const tail = rows.filter((r) => typeof r.id === "number").slice(-TAIL_ROWS).map(toCachedRow);
    const key = keyOf(user, instanceId, alias);
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    if (tail.length === 0) {
      store.delete(key);
      await txDone(tx);
      return;
    }
    const now = Date.now();
    // Serialized length ≈ UTF-16 code units; ×2 approximates the storage bytes.
    const bytes = JSON.stringify(tail).length * 2;
    store.put({ user, instanceId, alias, rows: tail, lastAccess: now, bytes } satisfies TailRecord);
    // One ascending-lastAccess pass: drop expired entries, then LRU-evict others
    // while the total exceeds the budget (the fresh write is never a victim).
    const all = await asPromise(store.index("lastAccess").getAll() as IDBRequest<TailRecord[]>);
    let total = all.reduce((sum, r) => sum + (r.bytes || 0), 0);
    for (const r of all) {
      if (r.user === user && r.instanceId === instanceId && r.alias === alias) continue;
      if (now - r.lastAccess > TTL_MS || total > GLOBAL_BUDGET_BYTES) {
        store.delete(keyOf(r.user, r.instanceId, r.alias));
        total -= r.bytes || 0;
      }
    }
    await txDone(tx);
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

/** Drop cached entries for an instance whose alias is not in `aliveAliases` —
 *  covers sessions removed from other clients while the web was closed.
 *  Called as each instance's authoritative session list arrives. */
export async function reconcile(user: string, instanceId: string, aliveAliases: Iterable<string>): Promise<void> {
  try {
    const alive = new Set(aliveAliases);
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    // [user, instanceId] prefix range: an array upper bound sorts after every
    // string alias, so this spans exactly the instance's entries.
    const range = IDBKeyRange.bound([user, instanceId], [user, instanceId, []], false, true);
    const keys = await asPromise(store.getAllKeys(range));
    for (const k of keys) {
      const alias = (k as [string, string, string])[2];
      if (!alive.has(alias)) store.delete(k);
    }
    await txDone(tx);
  } catch { /* best-effort */ }
}
