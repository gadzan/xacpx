import type { AppState } from "../state/types";
import type { CapabilityCacheStore, CachedCapability } from "./capability-discovery";

export interface StateCapabilityCache extends CapabilityCacheStore {
  /** Resolves once every commit started so far has settled. */
  settled(): Promise<void>;
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
 */
class CacheStore implements StateCapabilityCache {
  private readonly memory = new Map<string, CachedCapability>();
  private readonly commits = new Set<Promise<void>>();

  constructor(
    private readonly state: AppState,
    private readonly commit: (critical: () => Promise<void>) => Promise<void>,
    private readonly write: (next: AppState) => Promise<void>,
  ) {}

  settled(): Promise<void> {
    return Promise.all([...this.commits]).then(() => undefined);
  }

  get(key: string): CachedCapability | undefined {
    return this.memory.get(key);
  }

  set(key: string, value: CachedCapability): void {
    this.memory.set(key, value);
  }

  load(key: string): CachedCapability | undefined {
    const cached = this.memory.get(key);
    if (cached) return cached;
    const record = this.state.capability_lists[key];
    if (!record) return undefined;
    return {
      models: record.models.map((model) => ({ modelId: model.model_id, ...(model.name ? { name: model.name } : {}) })),
      efforts: record.efforts,
      effortKnown: record.effort_known,
      fetchedAt: record.fetched_at,
    };
  }

  persist(key: string, value: CachedCapability): void {
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
      await this.write(next);
    });
    // Track before awaiting so settled() cannot observe an empty set for a
    // commit that has already started.
    const done = run.catch(() => {});
    this.commits.add(done);
    void done.finally(() => this.commits.delete(done));
  }
}

/** Daemon wiring entry point: a state-backed {@link CapabilityCacheStore}. */
export function createStateCapabilityCache(
  state: AppState,
  commit: (critical: () => Promise<void>) => Promise<void>,
  write: (next: AppState) => Promise<void>,
): StateCapabilityCache {
  return new CacheStore(state, commit, write);
}
