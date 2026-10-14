import type { AppState } from "../state/types";
import type { CapabilityCacheStore, CachedCapability } from "./capability-discovery";

/**
 * Adapter model lists live in the regenerable `capability_lists` section of
 * state.json, keyed by the capability fingerprint (agent + cwd + launch
 * identity + auth material). Reads are synchronous and side-effect free; the
 * write path follows the SessionService pattern (mutate → persist) so a
 * daemon restart still shows the list the operator already verified.
 *
 * A write failure is swallowed: a lost cache only costs one re-fetch, while a
 * failed discovery response would look like a broken feature.
 */
export class StateCapabilityCache implements CapabilityCacheStore {
  private readonly memory = new Map<string, CachedCapability>();

  constructor(
    private readonly state: AppState,
    private readonly write: (next: AppState) => Promise<void>,
  ) {}

  get(key: string): CachedCapability | undefined {
    return this.memory.get(key);
  }

  set(key: string, value: CachedCapability): void {
    this.memory.set(key, value);
  }

  load(key: string): CachedCapability | undefined {
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
    this.state.capability_lists[key] = {
      models: value.models.map((model) => ({ model_id: model.modelId, ...(model.name ? { name: model.name } : {}) })),
      efforts: value.efforts,
      effort_known: value.effortKnown,
      fetched_at: value.fetchedAt,
    };
    // Copy-on-write keeps a failed write from corrupting the live state object;
    // the same contract SessionService uses for every other mutation.
    void this.write(structuredClone(this.state)).catch(() => {});
  }
}
