import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

import {
  emptyCapability,
  errorCapability,
  knownEfforts,
  needsSetupCapability,
  readyCapability,
  unsupportedCapability,
  type AgentCapabilityState,
  type CapabilityFetchSource,
  type CapabilityFreshness,
  type EffortView,
} from "@ganglion/xacpx-relay-protocol";
import type { ClaudeSettingsPolicy } from "../adapters/claude-settings-policy";
import {
  launchFingerprint,
  normalizeProbeSettingsPolicy,
  resolveModelProbeLaunch,
  type ModelProbeLaunch,
} from "../config/resolve-agent-command";
import type { AgentCapabilityProbeRequest, AgentCapabilityProbeResult, ResolvedSession } from "../transport/types";

export { launchFingerprint };

/** Fresh window for a verified model directory (design section 7.1). */
export const MODEL_CATALOG_SOFT_TTL_MS = 15 * 60 * 1000;
/** Stale entries older than this are dropped, never shown (design section 7.1). */
export const MODEL_CATALOG_STALE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Failed probes suppress only in-memory background retries for this long. */
export const MODEL_CATALOG_NEGATIVE_TTL_MS = 30 * 1000;
/** Cache-key namespace: V1 records (bare hex keys) are never addressed by V2. */
export const CAPABILITY_CACHE_KEY_PREFIX = "v2:";
export const CAPABILITY_FINGERPRINT_VERSION = 2;

export interface CapabilityLaunch {
  agentCommand?: string;
  acpxAgent?: string;
  rawCommand?: string;
  agentArgv?: readonly string[];
}

export interface CapabilityContext {
  cwd: string;
  driver: string;
  settingsPolicy?: ClaudeSettingsPolicy;
  launch: CapabilityLaunch;
  suggestions: readonly string[];
  configuredModel?: string;
  /** Wired later from config; absent until then (argv digest still rotates). */
  adapterVersion?: string;
  adapterRegistryDigest?: string;
  configRevision?: string;
}

export interface CapabilityTarget {
  productOwned: boolean;
  botId?: string;
  /** Present for product-owned sessions so direct runtimes win over group members. */
  scope?: "bot-direct" | "group-member" | "group-controller";
  resolved: ResolvedSession;
}

export interface CapabilityAdvertisement {
  models: Array<{ modelId: string; name?: string }>;
  currentModelId?: string;
  efforts: string[];
  currentEffort?: string;
  effortKnown: boolean;
}

export interface CapabilityFingerprintV2 {
  schemaVersion: 2;
  agent: string;
  driver: string;
  canonicalCwd: string;
  settingsPolicy: string;
  launchDigest: string;
  resolvedAgentCommandDigest: string;
  adapterVersion?: string;
  adapterRegistryDigest?: string;
  configRevision: string;
  authRevision: string;
}

export interface CachedCapabilityV2 {
  schemaVersion: 2;
  models: Array<{ modelId: string; name?: string }>;
  efforts: string[];
  effortKnown: boolean;
  fetchedAt: string;
  softExpiresAt: string;
  source: "probe" | "runtime" | "session";
  adapterVersion?: string;
}

/**
 * Durable overlay for {@link CachedCapabilityV2}. Production wires a StateStore
 * section so a daemon restart still shows the model list; tests keep the
 * in-memory default.
 */
export interface CapabilityCacheStore extends CacheStore {
  /** Read the persisted entry before the in-memory map. */
  load?(key: string): CachedCapabilityV2 | undefined;
  /** Persist a freshly verified list; failures must not break discovery. */
  persist?(key: string, value: CachedCapabilityV2): Promise<void> | void;
}

export interface AgentCapabilityQuery {
  agent: string;
  workspace: string;
  botId?: string;
  probe?: boolean;
}

export type ModelDiscoveryEventType =
  | "agent.model_discovery.cache_hit"
  | "agent.model_discovery.cache_stale"
  | "agent.model_discovery.probe_started"
  | "agent.model_discovery.probe_succeeded"
  | "agent.model_discovery.probe_empty"
  | "agent.model_discovery.probe_unsupported"
  | "agent.model_discovery.probe_failed"
  | "agent.model_discovery.cache_invalidated"
  | "agent.model_discovery.cache_write_failed";

/** Observability envelope (design section 13): safe fields only, never secrets. */
export interface ModelDiscoveryEvent {
  type: ModelDiscoveryEventType;
  agent: string;
  driver?: string;
  source?: CapabilityFetchSource;
  outcome?: string;
  durationMs?: number;
  modelCount?: number;
  cacheAgeMs?: number;
  fingerprintPrefix: string;
  background?: boolean;
}

export interface CapabilityChangeNotice {
  agent: string;
  workspace: string;
  fingerprintPrefix: string;
}

export interface AgentCapabilityDeps {
  now(): string;
  env?: NodeJS.ProcessEnv;
  resolve(agent: string, workspace: string): CapabilityContext | { error: string };
  getBot(id: string): { agent: string; workspace: string; model?: string; effort?: string } | undefined;
  listTargets(agent: string, workspace: string): CapabilityTarget[];
  readAdvertisement(session: ResolvedSession): Promise<CapabilityAdvertisement | undefined>;
  probe?(input: AgentCapabilityProbeRequest): Promise<AgentCapabilityProbeResult>;
  emit?(event: ModelDiscoveryEvent): void;
  log?(message: string): void;
}

interface CacheStore {
  get(key: string): CachedCapabilityV2 | undefined;
  set(key: string, value: CachedCapabilityV2): void;
}

/**
 * Discovery order is fixed: owned runtime, fresh cache, compatible ordinary
 * sessions in the full server catalog, stale cache plus a background
 * single-flight refresh, then an explicit probe. The returned state never
 * includes a session alias or a launch command.
 */
export class AgentCapabilityService {
  private readonly cache: CapabilityCacheStore;
  private readonly inflight = new Map<string, Promise<AgentCapabilityProbeResult>>();
  private readonly generations = new Map<string, number>();
  private readonly negative = new Map<string, { failedAtMs: number; failure: string }>();
  private readonly freshnessCeilings = new Map<string, number>();
  private readonly changeListeners = new Set<(notice: CapabilityChangeNotice) => void>();

  constructor(
    private readonly deps: AgentCapabilityDeps,
    cache?: CapabilityCacheStore,
  ) {
    this.cache = cache ?? new Map();
  }

  /** Subscribe to background-refresh completions (instance-scoped). */
  onCapabilitiesChanged(listener: (notice: CapabilityChangeNotice) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /** Fence a fingerprint after a config or auth change: old flights cannot write. */
  invalidateCapability(agent: string, workspace: string): boolean {
    const resolved = this.deps.resolve(agent, workspace);
    if ("error" in resolved) return false;
    const launch = resolveModelProbeLaunch(agent, resolved, { env: this.deps.env ?? process.env });
    const key = fingerprintV2Key(fingerprintOf(agent, resolved, launch));
    this.generations.set(key, this.generationOf(key) + 1);
    this.freshnessCeilings.set(key, this.nowMs());
    this.negative.delete(key);
    this.emit({
      type: "agent.model_discovery.cache_invalidated",
      agent,
      driver: resolved.driver,
      fingerprintPrefix: fingerprintV2Prefix(key),
    });
    return true;
  }

  /** Read-through cache: memory first, then the durable overlay. */
  private cached(key: string): CachedCapabilityV2 | undefined {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const stored = this.cache.load?.(key);
    if (!stored) return undefined;
    this.cache.set(key, stored);
    return stored;
  }

  private readCache(key: string): CachedCapabilityV2 | undefined {
    const entry = this.cached(key);
    if (!entry || !this.isRetained(entry, this.nowMs())) return undefined;
    return entry;
  }

  async get(query: AgentCapabilityQuery): Promise<AgentCapabilityState> {
    const resolved = this.deps.resolve(query.agent, query.workspace);
    if ("error" in resolved) {
      return errorCapability(
        { code: "invalid-context", message: resolved.error },
        "Choose a configured agent and workspace.",
        { fetchedAt: this.deps.now() },
      );
    }
    const bot = query.botId ? this.deps.getBot(query.botId) : undefined;
    if (query.botId && !bot) {
      return errorCapability(
        { code: "invalid-context", message: "that bot does not exist" },
        "Refresh the bot list and try again.",
        { fetchedAt: this.deps.now() },
      );
    }
    if (bot && (bot.agent !== query.agent || bot.workspace !== query.workspace)) {
      return errorCapability(
        { code: "invalid-context", message: "the bot does not use that agent and workspace" },
        "Open the bot's own agent and workspace.",
        { fetchedAt: this.deps.now() },
      );
    }
    const selectedModelId = bot?.model ?? resolved.configuredModel;
    const selectedEffort = bot?.effort;
    const launch = resolveModelProbeLaunch(query.agent, resolved, { env: this.deps.env ?? process.env });
    const fingerprint = fingerprintOf(query.agent, resolved, launch);
    const key = fingerprintV2Key(fingerprint);
    const prefix = fingerprintV2Prefix(key);
    const draftBase = {
      suggestions: resolved.suggestions,
      selectedModelId,
      selectedEffort,
    };

    // An explicit fetch must re-verify, so the runtime, cache, and
    // sibling-session shortcuts only serve passive reads.
    if (query.probe) {
      return this.probeExplicit(query.agent, resolved, launch, key, prefix, draftBase);
    }

    if (query.botId) {
      const owned = await this.readOwned(query.agent, query.workspace, query.botId, resolved);
      if (owned && owned.models.length > 0) {
        const state = this.ready("runtime", owned, { ...draftBase, appliedModelId: owned.currentModelId });
        await this.remember(key, owned, "runtime", state.fetchedAt, {
          agent: query.agent,
          driver: resolved.driver,
          fingerprintPrefix: prefix,
        });
        return state;
      }
    }

    const nowMs = this.nowMs();
    const entry = this.readCache(key);
    if (entry && entry.models.length > 0 && this.isFresh(entry, nowMs, key)) {
      this.emit({
        type: "agent.model_discovery.cache_hit",
        agent: query.agent,
        driver: resolved.driver,
        source: "cache",
        cacheAgeMs: nowMs - Date.parse(entry.fetchedAt),
        fingerprintPrefix: prefix,
      });
      return this.ready("cache", entry, draftBase, entry.fetchedAt, {
        freshness: "fresh",
        lastVerifiedAt: entry.fetchedAt,
      });
    }

    const sibling = await this.readOrdinary(query.agent, query.workspace, resolved);
    if (sibling && sibling.models.length > 0) {
      const state = this.ready("session", sibling, draftBase);
      await this.remember(key, sibling, "session", state.fetchedAt, {
        agent: query.agent,
        driver: resolved.driver,
        fingerprintPrefix: prefix,
      });
      return state;
    }

    if (entry && entry.models.length > 0) {
      this.emit({
        type: "agent.model_discovery.cache_stale",
        agent: query.agent,
        driver: resolved.driver,
        source: "cache",
        cacheAgeMs: nowMs - Date.parse(entry.fetchedAt),
        fingerprintPrefix: prefix,
      });
      const refreshing = this.refreshInBackground(query.agent, query.workspace, resolved, launch, key, prefix);
      return this.ready("cache", entry, draftBase, entry.fetchedAt, {
        freshness: "stale",
        ...(refreshing ? { refreshing: true as const } : {}),
        lastVerifiedAt: entry.fetchedAt,
      });
    }

    return needsSetupCapability(
      {
        code: "discovery-available",
        message: "no saved model list for this agent, workspace, and adapter",
      },
      "Fetch the model list. That starts a short adapter probe and removes it when finished.",
      { ...draftBase, fetchedAt: this.deps.now(), efforts: { status: "unavailable" } },
    );
  }

  private async probeExplicit(
    agent: string,
    resolved: CapabilityContext,
    launch: ModelProbeLaunch,
    key: string,
    prefix: string,
    draftBase: { suggestions: readonly string[]; selectedModelId?: string; selectedEffort?: string },
  ): Promise<AgentCapabilityState> {
    const fetchedAt = this.deps.now();
    if (!launch.ok) {
      this.emit({
        type: "agent.model_discovery.probe_unsupported",
        agent,
        driver: resolved.driver,
        outcome: "probe-unavailable",
        fingerprintPrefix: prefix,
      });
      return unsupportedCapability(
        { code: "probe-unavailable", message: launch.message },
        "Start a normal session on this agent, or add modelCandidates as unverified suggestions.",
        { ...draftBase, fetchedAt, efforts: { status: "unavailable" } },
      );
    }
    if (!this.deps.probe) {
      this.emit({
        type: "agent.model_discovery.probe_unsupported",
        agent,
        driver: resolved.driver,
        outcome: "probe-unavailable",
        fingerprintPrefix: prefix,
      });
      return unsupportedCapability(
        { code: "probe-unavailable", message: "this process has no transport probe for adapter models" },
        "Start a normal session on this agent, or add modelCandidates as unverified suggestions.",
        { ...draftBase, fetchedAt, efforts: { status: "unavailable" } },
      );
    }

    // Same generation as any concurrent background flight: one probe serves all
    // waiters (design section 5.2). Only invalidateCapability() moves the
    // generation, fencing the old flight out of the cache and the event bus.
    const generation = this.generationOf(key);
    this.emit({
      type: "agent.model_discovery.probe_started",
      agent,
      driver: resolved.driver,
      fingerprintPrefix: prefix,
    });
    const startedAt = this.nowMs();
    let result: AgentCapabilityProbeResult;
    try {
      result = await this.probeShared(key, generation, agent, resolved, launch);
    } catch (error) {
      this.noteFailure(key, "transport");
      this.emit({
        type: "agent.model_discovery.probe_failed",
        agent,
        driver: resolved.driver,
        outcome: "transport",
        durationMs: this.nowMs() - startedAt,
        fingerprintPrefix: prefix,
      });
      return errorCapability(
        { code: "transport", message: error instanceof Error ? error.message : String(error) },
        "Retry the model fetch. The probe does not keep a bot topic.",
        { fetchedAt: this.deps.now(), selectedModelId: draftBase.selectedModelId, selectedEffort: draftBase.selectedEffort },
      );
    }
    return this.finishProbe({
      key,
      generation,
      result,
      draftBase,
      prefix,
      agent,
      driver: resolved.driver,
      fetchedAt,
      durationMs: this.nowMs() - startedAt,
      background: false,
    });
  }

  private probeShared(
    key: string,
    generation: number,
    agent: string,
    resolved: CapabilityContext,
    launch: Extract<ModelProbeLaunch, { ok: true }>,
  ): Promise<AgentCapabilityProbeResult> {
    const flightKey = `${key}:${generation}`;
    const existing = this.inflight.get(flightKey);
    if (existing) return existing;
    const probe = this.deps.probe;
    if (!probe) {
      return Promise.resolve({
        ok: false,
        failure: "unsupported",
        message: "this process has no transport probe for adapter models",
      });
    }
    // The spawn overlay resolves here, at probe time: passive fingerprinting
    // deliberately skips it because profile resolution can touch disk.
    const withEnv = resolveModelProbeLaunch(agent, resolved, {
      env: this.deps.env ?? process.env,
      includeEnv: true,
    });
    const request: AgentCapabilityProbeRequest = {
      agent,
      cwd: launch.cwd,
      driver: resolved.driver,
      ...(resolved.settingsPolicy ? { settingsPolicy: resolved.settingsPolicy } : {}),
      ...(resolved.launch.agentCommand ? { agentCommand: resolved.launch.agentCommand } : {}),
      ...(resolved.launch.acpxAgent ? { acpxAgent: resolved.launch.acpxAgent } : {}),
      ...(resolved.launch.rawCommand ? { rawCommand: resolved.launch.rawCommand } : {}),
      // argv and identity always travel as a pair from the same resolution.
      agentArgv: withEnv.ok ? withEnv.agentCommand : launch.agentCommand,
      ...(withEnv.ok && withEnv.agentProcessEnv ? { agentProcessEnv: withEnv.agentProcessEnv } : {}),
      identity: withEnv.ok ? withEnv.identity : launch.identity,
    };
    let tracked: Promise<AgentCapabilityProbeResult>;
    tracked = probe(request).finally(() => {
      if (this.inflight.get(flightKey) === tracked) this.inflight.delete(flightKey);
    });
    this.inflight.set(flightKey, tracked);
    return tracked;
  }

  private async finishProbe(input: {
    key: string;
    generation: number;
    result: AgentCapabilityProbeResult;
    draftBase: { suggestions: readonly string[]; selectedModelId?: string; selectedEffort?: string };
    prefix: string;
    agent: string;
    driver: string;
    fetchedAt: string;
    durationMs: number;
    background: boolean;
  }): Promise<AgentCapabilityState> {
    const { key, generation, result, draftBase, prefix, agent, driver, fetchedAt, durationMs, background } = input;
    if (!result.ok) {
      this.noteFailure(key, result.failure);
      this.emitFailure(result.failure, { agent, driver, prefix, durationMs, background });
      // A failed refresh must not wipe a previously saved list: the user keeps
      // the models and the picker states the live verification problem. The
      // cache is reported with its own fetchedAt, never as a fresh probe.
      const preserved = this.readCache(key);
      if (preserved && preserved.models.length > 0) {
        const state = this.ready("cache", preserved, draftBase, preserved.fetchedAt);
        return this.withProbeFailure(
          state,
          result,
          this.isFresh(preserved, this.nowMs(), key) ? "fresh" : "stale",
          preserved.fetchedAt,
        );
      }
      if (result.failure === "unauthenticated") {
        return needsSetupCapability(
          { code: "unauthenticated", message: result.message },
          "Sign in to the adapter on this machine, then fetch the model list again.",
          { ...draftBase, fetchedAt, efforts: { status: "unavailable" } },
        );
      }
      if (result.failure === "unsupported") {
        return unsupportedCapability(
          { code: "adapter-cannot-enumerate", message: result.message },
          "Use the default model or type a custom id. Configured modelCandidates stay suggestions.",
          { ...draftBase, fetchedAt, efforts: { status: "unavailable" } },
        );
      }
      return errorCapability(
        { code: result.failure === "timeout" ? "timeout" : result.failure === "cleanup" ? "cleanup" : "transport", message: result.message },
        "Retry the model fetch. A failed probe does not leave a visible bot topic.",
        { fetchedAt, selectedModelId: draftBase.selectedModelId, selectedEffort: draftBase.selectedEffort },
      );
    }
    if (result.models.length === 0) {
      this.emit({
        type: "agent.model_discovery.probe_empty",
        agent,
        driver,
        modelCount: 0,
        durationMs,
        fingerprintPrefix: prefix,
        ...(background ? { background: true as const } : {}),
      });
      // An explicit empty is reported, never cached: the next passive read
      // asks for a fetch instead of replaying an unverifiable void.
      return emptyCapability(
        { code: "discovery-available", message: "the adapter answered but advertised no models" },
        "Use the default model or type a custom id. Configured modelCandidates stay suggestions.",
        { fetchedAt, suggestions: draftBase.suggestions },
      );
    }
    const advertisement: CapabilityAdvertisement = {
      models: result.models,
      currentModelId: result.currentModelId,
      efforts: result.effortKnown === true ? result.efforts : [],
      currentEffort: result.effortKnown === true ? result.currentEffort : undefined,
      effortKnown: result.effortKnown === true,
    };
    const state = this.ready("probe", advertisement, draftBase, fetchedAt);
    if (generation !== this.generationOf(key)) {
      this.log(`capability ${prefix} discarded a stale generation probe result`);
      return state;
    }
    await this.remember(key, advertisement, "probe", fetchedAt, { agent, driver, fingerprintPrefix: prefix });
    this.emit({
      type: "agent.model_discovery.probe_succeeded",
      agent,
      driver,
      source: "probe",
      modelCount: result.models.length,
      durationMs,
      fingerprintPrefix: prefix,
      ...(background ? { background: true as const } : {}),
    });
    return state;
  }

  /** Attach the live failure to a still-usable cached list without hiding it. */
  private withProbeFailure(
    state: AgentCapabilityState,
    result: AgentCapabilityProbeResult,
    freshness: CapabilityFreshness,
    lastVerifiedAt: string,
  ): AgentCapabilityState {
    if (state.status !== "ready" || result.ok) return state;
    return {
      ...state,
      freshness,
      lastVerifiedAt,
      reason: {
        code: result.failure === "unauthenticated"
          ? "unauthenticated"
          : result.failure === "unsupported"
            ? "adapter-cannot-enumerate"
            : result.failure === "timeout"
              ? "timeout"
              : result.failure === "cleanup"
                ? "cleanup"
                : "transport",
        message: result.message,
      },
    };
  }

  private refreshInBackground(
    agent: string,
    workspace: string,
    resolved: CapabilityContext,
    launch: ModelProbeLaunch,
    key: string,
    prefix: string,
  ): boolean {
    if (!launch.ok || !this.deps.probe) return false;
    const generation = this.generationOf(key);
    if (this.inflight.has(`${key}:${generation}`)) return true;
    if (this.isNegativeFresh(key)) return false;
    this.emit({
      type: "agent.model_discovery.probe_started",
      agent,
      driver: resolved.driver,
      background: true,
      fingerprintPrefix: prefix,
    });
    const startedAt = this.nowMs();
    const run = (async () => {
      let result: AgentCapabilityProbeResult;
      try {
        result = await this.probeShared(key, generation, agent, resolved, launch);
      } catch {
        this.noteFailure(key, "transport");
        this.emit({
          type: "agent.model_discovery.probe_failed",
          agent,
          driver: resolved.driver,
          outcome: "transport",
          durationMs: this.nowMs() - startedAt,
          background: true,
          fingerprintPrefix: prefix,
        });
        return;
      }
      const durationMs = this.nowMs() - startedAt;
      if (!result.ok) {
        // Last-good stays: a failed background refresh never clears the cache.
        this.noteFailure(key, result.failure);
        this.emitFailure(result.failure, { agent, driver: resolved.driver, prefix, durationMs, background: true });
        return;
      }
      if (result.models.length === 0) {
        this.emit({
          type: "agent.model_discovery.probe_empty",
          agent,
          driver: resolved.driver,
          modelCount: 0,
          durationMs,
          background: true,
          fingerprintPrefix: prefix,
        });
        return;
      }
      if (generation !== this.generationOf(key)) {
        this.log(`capability ${prefix} discarded a stale background generation`);
        return;
      }
      const advertisement: CapabilityAdvertisement = {
        models: result.models,
        currentModelId: result.currentModelId,
        efforts: result.effortKnown === true ? result.efforts : [],
        currentEffort: result.effortKnown === true ? result.currentEffort : undefined,
        effortKnown: result.effortKnown === true,
      };
      await this.remember(key, advertisement, "probe", this.deps.now(), {
        agent,
        driver: resolved.driver,
        fingerprintPrefix: prefix,
      });
      this.emit({
        type: "agent.model_discovery.probe_succeeded",
        agent,
        driver: resolved.driver,
        source: "probe",
        modelCount: result.models.length,
        durationMs,
        background: true,
        fingerprintPrefix: prefix,
      });
      for (const listener of this.changeListeners) {
        try {
          listener({ agent, workspace, fingerprintPrefix: prefix });
        } catch {
          // A listener must never break the refresh.
        }
      }
    })();
    void run.catch(() => {
      // Every path above already settles; this only guards against defects.
    });
    return true;
  }

  private ready(
    source: CapabilityFetchSource,
    advertisement: CapabilityAdvertisement | CachedCapabilityV2,
    draft: { suggestions: readonly string[]; selectedModelId?: string; selectedEffort?: string; appliedModelId?: string },
    fetchedAt = this.deps.now(),
    extra?: { freshness?: CapabilityFreshness; refreshing?: boolean; lastVerifiedAt?: string },
  ): AgentCapabilityState {
    const effortKnown = "effortKnown" in advertisement ? advertisement.effortKnown : false;
    const efforts: EffortView = effortKnown
      ? knownEfforts(advertisement.efforts, "currentEffort" in advertisement ? advertisement.currentEffort : undefined)
      : { status: "unavailable" };
    return readyCapability(source, advertisement.models, {
      fetchedAt,
      suggestions: draft.suggestions,
      selectedModelId: draft.selectedModelId,
      selectedEffort: draft.selectedEffort,
      appliedModelId: source === "runtime" ? draft.appliedModelId : undefined,
      efforts,
      ...(extra?.freshness ? { freshness: extra.freshness } : {}),
      ...(extra?.refreshing !== undefined ? { refreshing: extra.refreshing } : {}),
      ...(extra?.lastVerifiedAt ? { lastVerifiedAt: extra.lastVerifiedAt } : {}),
    });
  }

  private async remember(
    key: string,
    advertisement: CapabilityAdvertisement,
    source: "probe" | "runtime" | "session",
    fetchedAt: string,
    notice: { agent: string; driver: string; fingerprintPrefix: string },
  ): Promise<void> {
    if (advertisement.models.length === 0) return;
    const fetchedAtMs = Date.parse(fetchedAt);
    const entry: CachedCapabilityV2 = {
      schemaVersion: 2,
      models: advertisement.models.map((model) => ({ modelId: model.modelId, ...(model.name ? { name: model.name } : {}) })),
      efforts: advertisement.effortKnown ? advertisement.efforts : [],
      effortKnown: advertisement.effortKnown,
      fetchedAt,
      softExpiresAt: new Date((Number.isFinite(fetchedAtMs) ? fetchedAtMs : 0) + MODEL_CATALOG_SOFT_TTL_MS).toISOString(),
      source,
    };
    this.cache.set(key, entry);
    try {
      await this.cache.persist?.(key, entry);
    } catch (error) {
      this.emit({
        type: "agent.model_discovery.cache_write_failed",
        agent: notice.agent,
        driver: notice.driver,
        outcome: error instanceof Error ? error.message : String(error),
        fingerprintPrefix: notice.fingerprintPrefix,
      });
      this.log(`capability ${notice.fingerprintPrefix} cache_write_failed`);
    }
  }

  private async readOwned(
    agent: string,
    workspace: string,
    botId: string,
    resolved: CapabilityContext,
  ): Promise<CapabilityAdvertisement | undefined> {
    const targets = this.deps.listTargets(agent, workspace)
      .filter((target) => target.productOwned && target.botId === botId)
      .sort((left, right) => (left.scope === "bot-direct" ? 0 : 1) - (right.scope === "bot-direct" ? 0 : 1));
    const ordered = targets;
    for (const target of ordered) {
      if (!matchesLaunchIdentity(resolved, target.resolved)) continue;
      const advertisement = await this.deps.readAdvertisement(target.resolved);
      if (advertisement && advertisement.models.length > 0) return advertisement;
    }
    return undefined;
  }

  private async readOrdinary(
    agent: string,
    workspace: string,
    resolved: CapabilityContext,
  ): Promise<CapabilityAdvertisement | undefined> {
    for (const target of this.deps.listTargets(agent, workspace)) {
      if (target.productOwned || target.resolved.archived) continue;
      if (!matchesLaunchIdentity(resolved, target.resolved)) continue;
      const advertisement = await this.deps.readAdvertisement(target.resolved);
      if (advertisement && advertisement.models.length > 0) return advertisement;
    }
    return undefined;
  }

  private generationOf(key: string): number {
    return this.generations.get(key) ?? 0;
  }

  private nowMs(): number {
    return Date.parse(this.deps.now());
  }

  private isFresh(entry: CachedCapabilityV2, nowMs: number, key: string): boolean {
    const softMs = Date.parse(entry.softExpiresAt);
    if (!Number.isFinite(softMs) || softMs <= nowMs) return false;
    const ceiling = this.freshnessCeilings.get(key);
    if (ceiling === undefined) return true;
    const fetchedMs = Date.parse(entry.fetchedAt);
    return Number.isFinite(fetchedMs) && fetchedMs > ceiling;
  }

  private isRetained(entry: CachedCapabilityV2, nowMs: number): boolean {
    const ageMs = nowMs - Date.parse(entry.fetchedAt);
    return Number.isFinite(ageMs) && ageMs <= MODEL_CATALOG_STALE_RETENTION_MS;
  }

  private noteFailure(key: string, failure: string): void {
    this.negative.set(key, { failedAtMs: this.nowMs(), failure });
  }

  private isNegativeFresh(key: string): boolean {
    const entry = this.negative.get(key);
    if (!entry) return false;
    if (this.nowMs() - entry.failedAtMs >= MODEL_CATALOG_NEGATIVE_TTL_MS) {
      this.negative.delete(key);
      return false;
    }
    return true;
  }

  private emitFailure(
    failure: "unauthenticated" | "timeout" | "transport" | "unsupported" | "cleanup",
    notice: { agent: string; driver: string; prefix: string; durationMs: number; background: boolean },
  ): void {
    this.emit({
      type: failure === "unsupported"
        ? "agent.model_discovery.probe_unsupported"
        : "agent.model_discovery.probe_failed",
      agent: notice.agent,
      driver: notice.driver,
      outcome: failure,
      durationMs: notice.durationMs,
      fingerprintPrefix: notice.prefix,
      ...(notice.background ? { background: true as const } : {}),
    });
  }

  private emit(event: ModelDiscoveryEvent): void {
    try {
      this.deps.emit?.(event);
    } catch {
      // Observability must never break discovery.
    }
  }

  private log(message: string): void {
    try {
      this.deps.log?.(message);
    } catch {
      // Logging must never break discovery.
    }
  }
}

/** Same-identity check for session advertisements: driver, settings policy, and launch. */
function matchesLaunchIdentity(
  expected: CapabilityContext,
  actual: Pick<ResolvedSession, "driver" | "settingsPolicy" | "agentCommand" | "acpxAgent" | "rawCommand" | "agentArgv">,
): boolean {
  if ((actual.driver ?? "") !== (expected.driver ?? "")) return false;
  if (
    normalizeProbeSettingsPolicy(actual.driver ?? expected.driver, actual.settingsPolicy) !==
    normalizeProbeSettingsPolicy(expected.driver, expected.settingsPolicy)
  ) {
    return false;
  }
  return launchFingerprint(actual) === launchFingerprint(expected.launch);
}

export function canonicalizeCapabilityCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

function fingerprintOf(agent: string, resolved: CapabilityContext, launch: ModelProbeLaunch): CapabilityFingerprintV2 {
  return {
    schemaVersion: CAPABILITY_FINGERPRINT_VERSION,
    agent,
    driver: resolved.driver,
    canonicalCwd: canonicalizeCapabilityCwd(resolved.cwd),
    settingsPolicy: launch.identity.settingsPolicy,
    launchDigest: launch.identity.launchDigest,
    resolvedAgentCommandDigest: launch.identity.resolvedAgentCommandDigest,
    ...(launch.identity.adapterVersion !== undefined ? { adapterVersion: launch.identity.adapterVersion } : {}),
    ...(launch.identity.adapterRegistryDigest !== undefined
      ? { adapterRegistryDigest: launch.identity.adapterRegistryDigest }
      : {}),
    configRevision: launch.identity.configRevision,
    authRevision: launch.identity.authRevision,
  };
}

export function fingerprintV2Key(fingerprint: CapabilityFingerprintV2): string {
  const stable = JSON.stringify({
    schemaVersion: fingerprint.schemaVersion,
    agent: fingerprint.agent,
    driver: fingerprint.driver,
    canonicalCwd: fingerprint.canonicalCwd,
    settingsPolicy: fingerprint.settingsPolicy,
    launchDigest: fingerprint.launchDigest,
    resolvedAgentCommandDigest: fingerprint.resolvedAgentCommandDigest,
    ...(fingerprint.adapterVersion !== undefined ? { adapterVersion: fingerprint.adapterVersion } : {}),
    ...(fingerprint.adapterRegistryDigest !== undefined ? { adapterRegistryDigest: fingerprint.adapterRegistryDigest } : {}),
    configRevision: fingerprint.configRevision,
    authRevision: fingerprint.authRevision,
  });
  return `${CAPABILITY_CACHE_KEY_PREFIX}${createHash("sha256").update(stable).digest("hex")}`;
}

/** Digest prefix for logs and events. The full key never leaves the cache. */
export function fingerprintV2Prefix(key: string): string {
  const hex = key.startsWith(CAPABILITY_CACHE_KEY_PREFIX) ? key.slice(CAPABILITY_CACHE_KEY_PREFIX.length) : key;
  return hex.slice(0, 8);
}
