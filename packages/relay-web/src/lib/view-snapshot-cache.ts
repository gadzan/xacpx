import { toRaw } from "vue";

/** Disposable stale-while-revalidate snapshots for lightweight session views.
 *
 * The in-memory layer makes same-page switches synchronous. IndexedDB restores
 * the same snapshots after a reload. Callers always revalidate against the
 * backend; this module is only an early paint and never an authority. */

const DB_NAME = "xacpx.view-snapshots";
const DB_VERSION = 1;
const STORE = "snapshots";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type SnapshotNamespace =
  | "session-model"
  | "session-effort"
  | "scheduled-tasks"
  | "orchestration-tasks"
  | "git-summary"
  | "workspace-view";

type SnapshotRecord = {
  user: string;
  namespace: SnapshotNamespace;
  instanceId: string;
  scope: string;
  value: unknown;
  updatedAt: number;
};

type SnapshotKey = [string, SnapshotNamespace, string, string];
const keyOf = (
  user: string,
  namespace: SnapshotNamespace,
  instanceId: string,
  scope: string,
): SnapshotKey => [user, namespace, instanceId, scope];
const memoryKey = (...key: SnapshotKey): string => JSON.stringify(key);
const memory = new Map<string, { value: unknown; updatedAt: number }>();
let globalGeneration = 0;
const keyGenerations = new Map<string, number>();

export type SnapshotWriteToken = {
  cacheKey: string;
  globalGeneration: number;
  keyGeneration: number;
};

export function captureWriteToken(
  user: string,
  namespace: SnapshotNamespace,
  instanceId: string,
  scope = "",
): SnapshotWriteToken {
  const cacheKey = memoryKey(...keyOf(user, namespace, instanceId, scope));
  return {
    cacheKey,
    globalGeneration,
    keyGeneration: keyGenerations.get(cacheKey) ?? 0,
  };
}

function acceptsWrite(token: SnapshotWriteToken): boolean {
  return token.globalGeneration === globalGeneration
    && token.keyGeneration === (keyGenerations.get(token.cacheKey) ?? 0);
}

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const opened = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexeddb-unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      db.createObjectStore(STORE, { keyPath: ["user", "namespace", "instanceId", "scope"] });
    };
    let blocked = false;
    req.onsuccess = () => {
      if (blocked) {
        req.result.close();
        return;
      }
      resolve(req.result);
    };
    req.onerror = () => reject(req.error ?? new Error("open-failed"));
    req.onblocked = () => {
      blocked = true;
      reject(new Error("open-blocked"));
    };
  });
  dbPromise = opened;
  opened.catch(() => {
    if (dbPromise === opened) dbPromise = null;
  });
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

function cloneForCache<T>(value: T): T {
  return JSON.parse(JSON.stringify(toRaw(value))) as T;
}

/** Synchronous same-page lookup. */
export function peek<T>(
  user: string,
  namespace: SnapshotNamespace,
  instanceId: string,
  scope = "",
): T | null {
  const key = keyOf(user, namespace, instanceId, scope);
  const cached = memory.get(memoryKey(...key));
  if (!cached) return null;
  if (Date.now() - cached.updatedAt > TTL_MS) {
    memory.delete(memoryKey(...key));
    return null;
  }
  return cached.value as T;
}

/** Memory-first IndexedDB lookup. */
export async function read<T>(
  user: string,
  namespace: SnapshotNamespace,
  instanceId: string,
  scope = "",
): Promise<T | null> {
  const hot = peek<T>(user, namespace, instanceId, scope);
  if (hot !== null) return hot;
  const token = captureWriteToken(user, namespace, instanceId, scope);
  try {
    const key = keyOf(user, namespace, instanceId, scope);
    const db = await openDb();
    const record = await asPromise<SnapshotRecord | undefined>(
      db.transaction(STORE, "readonly").objectStore(STORE).get(key) as IDBRequest<SnapshotRecord | undefined>,
    );
    // A logout or session deletion may finish while IndexedDB is reading. Never
    // return or reheat a snapshot captured before that invalidation boundary.
    if (!acceptsWrite(token)) return null;
    if (!record || Date.now() - record.updatedAt > TTL_MS) {
      if (record) {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(key);
        await txDone(tx);
      }
      return null;
    }
    memory.set(memoryKey(...key), { value: record.value, updatedAt: record.updatedAt });
    return record.value as T;
  } catch {
    return null;
  }
}

/** Update memory immediately, then persist best-effort. */
export async function write<T>(
  user: string,
  namespace: SnapshotNamespace,
  instanceId: string,
  scope: string,
  value: T,
  token = captureWriteToken(user, namespace, instanceId, scope),
): Promise<void> {
  try {
    const key = keyOf(user, namespace, instanceId, scope);
    const cacheKey = memoryKey(...key);
    if (token.cacheKey !== cacheKey || !acceptsWrite(token)) return;
    const snapshot = cloneForCache(value);
    const updatedAt = Date.now();
    memory.set(cacheKey, { value: snapshot, updatedAt });
    if (typeof indexedDB === "undefined") return;
    const db = await openDb();
    if (!acceptsWrite(token)) return;
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ user, namespace, instanceId, scope, value: snapshot, updatedAt });
    await txDone(tx);
  } catch (err) {
    console.debug("[relay-web] view-snapshot write failed", err);
  }
}

const SESSION_NAMESPACES: SnapshotNamespace[] = [
  "session-model",
  "session-effort",
  "scheduled-tasks",
];

/** Remove snapshots whose identity belongs to a deleted session. */
export async function dropSession(user: string, instanceId: string, alias: string): Promise<void> {
  for (const namespace of SESSION_NAMESPACES) {
    const cacheKey = memoryKey(...keyOf(user, namespace, instanceId, alias));
    keyGenerations.set(cacheKey, (keyGenerations.get(cacheKey) ?? 0) + 1);
    memory.delete(cacheKey);
  }
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const namespace of SESSION_NAMESPACES) {
      store.delete(keyOf(user, namespace, instanceId, alias));
    }
    await txDone(tx);
  } catch { /* best-effort */ }
}

/** Shared-machine logout hygiene. */
export async function dropAll(): Promise<void> {
  globalGeneration += 1;
  memory.clear();
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await txDone(tx);
  } catch { /* best-effort */ }
}

export async function resetViewSnapshotCacheForTests(): Promise<void> {
  memory.clear();
  globalGeneration = 0;
  keyGenerations.clear();
  const pending = dbPromise;
  dbPromise = null;
  if (pending) {
    try { (await pending).close(); } catch { /* already broken */ }
  }
}
