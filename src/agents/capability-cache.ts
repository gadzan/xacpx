import { MODEL_CATALOG_SOFT_TTL_MS, MODEL_CATALOG_STALE_RETENTION_MS, type CachedCapabilityV2, type CapabilityCacheStore } from "./capability-discovery";
import type { AppState } from "../state/types";

export interface StateCapabilityCache extends CapabilityCacheStore {
  /** Resolves once every commit started so far has settled. */
  settled(): Promise<void>;
}

/** V1 records live under bare hex keys; V2 entries always carry the `v2:` prefix. */
export function isLegacyCapabilityKey(key: string): boolean {
  return !key.startsWith("v2:");
}

/**
 * Adapter model lists live in the regenerable `capability_lists` section of
 * state.json, keyed by the capability fingerprint (agent + cwd + launch
 * identity + auth material). Reads are synchronous and side-effect free.
 *
 * Like `native_session_lists`, this section is live-only: it is written to
 * disk but never published through `replaceRuntimeState`, which copies
 * durable sections explicitly. A write therefore clones the live state,
 * mutates the clone, and hands it to the durable writer. The in-memory entry
 * stays the read source, so a failed write only costs a re-fetch after a
 * restart instead of breaking discovery.
 *
 * The persisted shape stays `{models, efforts, effort_known, fetched_at}`:
 * provenance (`source`) does not survive a restart, but freshness still does
 * because `softExpiresAt` is recomputed from `fetched_at`. V1 records are
 * never served as fresh (see {@link isLegacyCapabilityKey}); entries older
 * than the retention window are dropped on read and pruned on write.
 */
class CacheStore implements StateCapabilityCache {
  private readonly memory = new Map<string, CachedCapabilityV2>();
  private readonly commits = new Set<Promise<void>>();

  constructor(
    private readonly state: AppState,
    private readonly commit: (critical: () => Promise<void>) => Promise<void>,
    private readonly write: (next: AppState) => Promise<void>,
    private readonly nowMs: () => number = Date.now,
  ) {}

  settled(): Promise<void> {
    return Promise.all([...this.commits]).then(() => undefined);
  }

  get(key: string): CachedCapabilityV2 | undefined {
    return this.memory.get(key);
  }

  set(key: string, value: CachedCapabilityV2): void {
    this.memory.set(key, value);
  }

  load(key: string): CachedCapabilityV2 | undefined {
    const cached = this.memory.get(key);
    if (cached) return cached;
    if (isLegacyCapabilityKey(key)) return undefined;
    const record = this.state.capability_lists[key];
    if (!record) return undefined;
    const fetchedAtMs = Date.parse(record.fetched_at);
    if (!Number.isFinite(fetchedAtMs) || this.nowMs() - fetchedAtMs > MODEL_CATALOG_STALE_RETENTION_MS) {
      return undefined;
    }
    const entry: CachedCapabilityV2 = {
      schemaVersion: 2,
      models: record.models.map((model) => ({ modelId: model.model_id, ...(model.name ? { name: model.name } : {}) })),
      efforts: record.efforts,
      effortKnown: record.effort_known,
      fetchedAt: record.fetched_at,
      softExpiresAt: new Date(fetchedAtMs + MODEL_CATALOG_SOFT_TTL_MS).toISOString(),
      source: "probe",
    };
    this.memory.set(key, entry);
    return entry;
  }

  persist(key: string, value: CachedCapabilityV2): Promise<void> {
    this.memory.set(key, value);
    const run = this.commit(async () => {
      const next = structuredClone(this.state);
      // The live object never receives entries (this section is live-only), so
      // the durable snapshot accumulates them itself.
      for (const [fingerprint, entry] of this.memory) {
        next.capability_lists[fingerprint] = {
          models: entry.models.map((model) => ({ model_id: model.modelId, ...(model.name ? { name: model.name } : {}) })),
          efforts: entry.efforts,
          effort_known: entry.effortKnown,
          fetched_at: entry.fetchedAt,
        };
      }
      pruneExpiredCapabilityLists(next.capability_lists, this.nowMs());
      await this.write(next);
    });
    // Track before awaiting so settled() cannot observe an empty set for a
    // commit that has already started. The tracking branch swallows; the
    // returned promise still rejects so discovery can emit cache_write_failed.
    const done = run.then(
      () => undefined,
      () => undefined,
    );
    this.commits.add(done);
    void done.finally(() => this.commits.delete(done));
    return run;
  }
}

function pruneExpiredCapabilityLists(
  lists: AppState["capability_lists"],
  nowMs: number,
): void {
  for (const [key, record] of Object.entries(lists)) {
    const ageMs = nowMs - Date.parse(record.fetched_at);
    if (!Number.isFinite(ageMs) || ageMs > MODEL_CATALOG_STALE_RETENTION_MS) {
      delete lists[key];
    }
  }
}

/** Daemon wiring entry point: a state-backed {@link CapabilityCacheStore}. */
export function createStateCapabilityCache(
  state: AppState,
  commit: (critical: () => Promise<void>) => Promise<void>,
  write: (next: AppState) => Promise<void>,
  nowMs?: () => number,
): StateCapabilityCache {
  return new CacheStore(state, commit, write, nowMs);
}
