import type { MessageRecordDto } from "@ganglion/xacpx-relay-protocol";

/** Stale-while-revalidate tail cache for session transcripts (spec #205).
 *
 *  Stores the last ≤30 persisted rows of a session in localStorage so
 *  `chat.select()` can seed the first screen synchronously while the
 *  authoritative history fetch is in flight. Validity comes from the key
 *  (schema version + username + instance + alias) plus three eviction layers:
 *  event-driven purge (archive/remove/logout), reconciliation against live
 *  session lists, and LRU/TTL budget fallbacks. Every storage access is
 *  wrapped in try/catch — storage may be blocked, and the cache must never
 *  become an error source. */

const VERSION = "v1";
// Any-version prefixes, used by dropAll() and the lazy old-version sweep.
const BASE_ENTRY_PREFIX = "xacpx.chat.tail.";
const BASE_INDEX_PREFIX = "xacpx.chat.tail-index.";
const ENTRY_PREFIX = `${BASE_ENTRY_PREFIX}${VERSION}.`;
const INDEX_KEY = `${BASE_INDEX_PREFIX}${VERSION}`;

export const TAIL_ROWS = 30;
const ENTRY_BUDGET_BYTES = 256 * 1024;
const GLOBAL_BUDGET_BYTES = 4 * 1024 * 1024;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

type IndexRecord = { key: string; lastAccess: number; bytes: number };

// Key segments must never contain "." so reconcile() can prefix-match
// (user, instanceId) unambiguously even when aliases contain dots.
const esc = (s: string): string => encodeURIComponent(s).replace(/\./g, "%2E");
const entryKey = (user: string, instanceId: string, alias: string): string =>
  `${ENTRY_PREFIX}${esc(user)}.${esc(instanceId)}.${esc(alias)}`;

function loadIndex(): IndexRecord[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((r): r is IndexRecord =>
      typeof r === "object" && r !== null &&
      typeof (r as IndexRecord).key === "string" &&
      typeof (r as IndexRecord).lastAccess === "number" &&
      typeof (r as IndexRecord).bytes === "number");
  } catch { return []; }
}

function saveIndex(index: IndexRecord[]): void {
  try {
    if (index.length === 0) localStorage.removeItem(INDEX_KEY);
    else localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch { /* storage may be blocked */ }
}

function removeEntry(index: IndexRecord[], key: string): IndexRecord[] {
  try { localStorage.removeItem(key); } catch { /* storage may be blocked */ }
  return index.filter((r) => r.key !== key);
}

/** Drop entries whose lastAccess is older than the TTL. Runs lazily on read/write
 *  so idle entries for instances the user never expands again still die. */
function pruneExpired(index: IndexRecord[], now: number): IndexRecord[] {
  let next = index;
  for (const r of index) {
    if (now - r.lastAccess > TTL_MS) next = removeEntry(next, r.key);
  }
  return next;
}

// Old-version keys (e.g. a future v2 rollout leaving v1 behind, or vice versa on
// rollback) are swept once per page load — cheap, and keeps quota for live data.
let sweptOldVersions = false;
function sweepOldVersions(): void {
  if (sweptOldVersions) return;
  sweptOldVersions = true;
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key) continue;
      const oldEntry = key.startsWith(BASE_ENTRY_PREFIX) && !key.startsWith(ENTRY_PREFIX);
      const oldIndex = key.startsWith(BASE_INDEX_PREFIX) && key !== INDEX_KEY;
      if (oldEntry || oldIndex) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch { /* storage may be blocked */ }
}

/** Test hook: reset the once-per-load sweep latch. */
export function resetSweepForTests(): void { sweptOldVersions = false; }

/** Synchronously read the cached tail for a session, or null on miss/expiry.
 *  A hit refreshes the entry's lastAccess (LRU touch). */
export function read(user: string, instanceId: string, alias: string): MessageRecordDto[] | null {
  sweepOldVersions();
  try {
    const key = entryKey(user, instanceId, alias);
    const now = Date.now();
    let index = pruneExpired(loadIndex(), now);
    const record = index.find((r) => r.key === key);
    if (!record) {
      // No index record — remove any orphaned entry so it can't linger untracked.
      index = removeEntry(index, key);
      saveIndex(index);
      return null;
    }
    const raw = localStorage.getItem(key);
    if (!raw) {
      saveIndex(index.filter((r) => r.key !== key));
      return null;
    }
    const rows = JSON.parse(raw) as unknown;
    if (!Array.isArray(rows) || rows.length === 0) {
      saveIndex(removeEntry(index, key));
      return null;
    }
    record.lastAccess = now;
    saveIndex(index);
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

/** Cache the tail of `rows` for a session. Keeps the last ≤30 persisted rows
 *  (id !== undefined), trims oldest rows to fit the per-entry budget, evicts
 *  LRU entries beyond the global budget, and retries once on quota errors. */
export function write(user: string, instanceId: string, alias: string, rows: MessageRecordDto[]): void {
  sweepOldVersions();
  try {
    const key = entryKey(user, instanceId, alias);
    const now = Date.now();
    let index = pruneExpired(loadIndex(), now);

    let tail = rows.filter((r) => typeof r.id === "number").slice(-TAIL_ROWS).map(toCachedRow);
    if (tail.length === 0) {
      saveIndex(removeEntry(index, key));
      return;
    }
    let serialized = JSON.stringify(tail);
    // Serialized length ≈ UTF-16 code units; ×2 approximates the storage bytes.
    while (serialized.length * 2 > ENTRY_BUDGET_BYTES && tail.length > 1) {
      tail = tail.slice(1);
      serialized = JSON.stringify(tail);
    }
    if (serialized.length * 2 > ENTRY_BUDGET_BYTES) {
      // A single row exceeding the budget: skip caching this session.
      saveIndex(removeEntry(index, key));
      return;
    }
    const bytes = serialized.length * 2;

    // Evict least-recently-accessed OTHER entries until the new entry fits the
    // global budget (the fresh write is never a victim of its own eviction).
    const evictLru = (): boolean => {
      const victims = index.filter((r) => r.key !== key).sort((a, b) => a.lastAccess - b.lastAccess);
      if (victims.length === 0) return false;
      index = removeEntry(index, victims[0].key);
      return true;
    };
    const totalOthers = (): number => index.filter((r) => r.key !== key).reduce((sum, r) => sum + r.bytes, 0);
    while (totalOthers() + bytes > GLOBAL_BUDGET_BYTES) {
      if (!evictLru()) break;
    }

    const store = (): void => localStorage.setItem(key, serialized);
    try {
      store();
    } catch {
      // Quota exceeded: evict the LRU entry and retry once, then give up.
      if (!evictLru()) { saveIndex(index.filter((r) => r.key !== key)); return; }
      try { store(); } catch {
        saveIndex(index.filter((r) => r.key !== key));
        return;
      }
    }
    const existing = index.find((r) => r.key === key);
    if (existing) { existing.lastAccess = now; existing.bytes = bytes; }
    else index.push({ key, lastAccess: now, bytes });
    saveIndex(index);
  } catch { /* cache is an optimization, never an error source */ }
}

/** Purge one session's cache — archive/remove hooks. */
export function drop(user: string, instanceId: string, alias: string): void {
  try {
    const key = entryKey(user, instanceId, alias);
    saveIndex(removeEntry(loadIndex(), key));
  } catch { /* storage may be blocked */ }
}

/** Purge every cached transcript (any schema version) — the logout hook. */
export function dropAll(): void {
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key.startsWith(BASE_ENTRY_PREFIX) || key.startsWith(BASE_INDEX_PREFIX)) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch { /* storage may be blocked */ }
}

/** Drop cached entries for an instance whose alias is not in `aliveAliases` —
 *  covers sessions archived/removed from other clients while the web was closed.
 *  Called as each instance's authoritative session list arrives. */
export function reconcile(user: string, instanceId: string, aliveAliases: Iterable<string>): void {
  try {
    const prefix = `${ENTRY_PREFIX}${esc(user)}.${esc(instanceId)}.`;
    const alive = new Set<string>();
    for (const alias of aliveAliases) alive.add(`${prefix}${esc(alias)}`);
    let index = loadIndex();
    for (const r of [...index]) {
      if (r.key.startsWith(prefix) && !alive.has(r.key)) index = removeEntry(index, r.key);
    }
    saveIndex(index);
  } catch { /* storage may be blocked */ }
}
