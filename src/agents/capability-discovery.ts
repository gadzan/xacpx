import { createHash } from "node:crypto";

import {
  errorCapability,
  knownEfforts,
  needsSetupCapability,
  readyCapability,
  unsupportedCapability,
  type AgentCapabilityState,
  type CapabilityFetchSource,
  type EffortView,
} from "@ganglion/xacpx-relay-protocol";

import type { ClaudeSettingsPolicy } from "../adapters/claude-settings-policy";
import type { AgentCapabilityProbeRequest, AgentCapabilityProbeResult, ResolvedSession } from "../transport/types";

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

export interface CachedCapability {
  models: Array<{ modelId: string; name?: string }>;
  efforts: string[];
  effortKnown: boolean;
  fetchedAt: string;
}

export interface AgentCapabilityQuery {
  agent: string;
  workspace: string;
  botId?: string;
  probe?: boolean;
}

export interface AgentCapabilityDeps {
  now(): string;
  env?: NodeJS.ProcessEnv;
  resolve(agent: string, workspace: string): CapabilityContext | { error: string };
  getBot(id: string): { agent: string; workspace: string; model?: string; effort?: string } | undefined;
  listTargets(agent: string, workspace: string): CapabilityTarget[];
  readAdvertisement(session: ResolvedSession): Promise<CapabilityAdvertisement | undefined>;
  probe?(input: AgentCapabilityProbeRequest): Promise<AgentCapabilityProbeResult>;
}

interface CacheStore {
  get(key: string): CachedCapability | undefined;
  set(key: string, value: CachedCapability): void;
}

/**
 * Discovery order is fixed: owned runtime, cache, ordinary sessions in the
 * full server catalog, then an explicit probe. The returned state never
 * includes a session alias or a launch command.
 */
export class AgentCapabilityService {
  private readonly cache: CacheStore = new Map();
  private readonly inflight = new Map<string, Promise<AgentCapabilityProbeResult>>();

  constructor(private readonly deps: AgentCapabilityDeps) {}

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
    const fingerprint = capabilityCacheKey({
      agent: query.agent,
      cwd: resolved.cwd,
      launch: resolved.launch,
      auth: authFingerprint(this.deps.env ?? process.env),
    });
    const draftBase = {
      suggestions: resolved.suggestions,
      selectedModelId,
      selectedEffort,
    };

    if (query.botId) {
      const owned = await this.readOwned(query.agent, query.workspace, query.botId);
      if (owned && owned.models.length > 0) {
        const state = this.ready("runtime", owned, { ...draftBase, appliedModelId: owned.currentModelId });
        this.remember(fingerprint, owned, state.fetchedAt);
        return state;
      }
    }

    const cached = this.cache.get(fingerprint);
    if (cached && cached.models.length > 0) {
      return this.ready("cache", cached, draftBase, cached.fetchedAt);
    }

    const sibling = await this.readOrdinary(query.agent, query.workspace, resolved.launch);
    if (sibling && sibling.models.length > 0) {
      const state = this.ready("session", sibling, draftBase);
      this.remember(fingerprint, sibling, state.fetchedAt);
      return state;
    }

    if (!query.probe) {
      return needsSetupCapability(
        {
          code: "discovery-available",
          message: "no saved model list for this agent, workspace, and adapter",
        },
        "Fetch the model list. That starts a short adapter probe and removes it when finished.",
        { ...draftBase, fetchedAt: this.deps.now(), efforts: { status: "unavailable" } },
      );
    }
    if (!this.deps.probe) {
      return unsupportedCapability(
        { code: "probe-unavailable", message: "this process has no transport probe for adapter models" },
        "Start a normal session on this agent, or add modelCandidates as unverified suggestions.",
        { ...draftBase, fetchedAt: this.deps.now(), efforts: { status: "unavailable" } },
      );
    }

    let result: AgentCapabilityProbeResult;
    try {
      result = await this.probeShared(fingerprint, query.agent, resolved);
    } catch (error) {
      return errorCapability(
        { code: "transport", message: error instanceof Error ? error.message : String(error) },
        "Retry the model fetch. The probe does not keep a bot topic.",
        { fetchedAt: this.deps.now(), selectedModelId: draftBase.selectedModelId, selectedEffort: draftBase.selectedEffort },
      );
    }
    return this.finishProbe(fingerprint, result, draftBase);
  }

  private probeShared(fingerprint: string, agent: string, resolved: CapabilityContext): Promise<AgentCapabilityProbeResult> {
    const existing = this.inflight.get(fingerprint);
    if (existing) return existing;
    const probe = this.deps.probe;
    if (!probe) {
      return Promise.resolve({
        ok: false,
        failure: "unsupported",
        message: "this process has no transport probe for adapter models",
      });
    }
    const run = probe({
      agent,
      cwd: resolved.cwd,
      driver: resolved.driver,
      settingsPolicy: resolved.settingsPolicy,
      agentCommand: resolved.launch.agentCommand,
      acpxAgent: resolved.launch.acpxAgent,
      rawCommand: resolved.launch.rawCommand,
      agentArgv: resolved.launch.agentArgv,
    }).finally(() => {
      this.inflight.delete(fingerprint);
    });
    this.inflight.set(fingerprint, run);
    return run;
  }

  private finishProbe(
    fingerprint: string,
    result: AgentCapabilityProbeResult,
    draftBase: { suggestions: readonly string[]; selectedModelId?: string; selectedEffort?: string },
  ): AgentCapabilityState {
    const fetchedAt = this.deps.now();
    if (!result.ok) {
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
    const advertisement: CapabilityAdvertisement = {
      models: result.models,
      currentModelId: result.currentModelId,
      efforts: result.efforts,
      currentEffort: result.currentEffort,
      effortKnown: true,
    };
    const state = this.ready("probe", advertisement, draftBase, fetchedAt);
    this.remember(fingerprint, advertisement, fetchedAt);
    return state;
  }

  private ready(
    source: CapabilityFetchSource,
    advertisement: CapabilityAdvertisement | CachedCapability,
    draft: { suggestions: readonly string[]; selectedModelId?: string; selectedEffort?: string; appliedModelId?: string },
    fetchedAt = this.deps.now(),
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
    });
  }

  private remember(key: string, advertisement: CapabilityAdvertisement, fetchedAt: string): void {
    if (advertisement.models.length === 0) return;
    this.cache.set(key, {
      models: advertisement.models.map((model) => ({ modelId: model.modelId, ...(model.name ? { name: model.name } : {}) })),
      efforts: advertisement.effortKnown ? advertisement.efforts : [],
      effortKnown: advertisement.effortKnown,
      fetchedAt,
    });
  }

  private async readOwned(agent: string, workspace: string, botId: string): Promise<CapabilityAdvertisement | undefined> {
    const targets = this.deps.listTargets(agent, workspace)
      .filter((target) => target.productOwned && target.botId === botId)
      .sort((left, right) => (left.scope === "bot-direct" ? 0 : 1) - (right.scope === "bot-direct" ? 0 : 1));
    const ordered = targets;
    for (const target of ordered) {
      const advertisement = await this.deps.readAdvertisement(target.resolved);
      if (advertisement && advertisement.models.length > 0) return advertisement;
    }
    return undefined;
  }

  private async readOrdinary(
    agent: string,
    workspace: string,
    launch: CapabilityLaunch,
  ): Promise<CapabilityAdvertisement | undefined> {
    const expected = launchFingerprint(launch);
    for (const target of this.deps.listTargets(agent, workspace)) {
      if (target.productOwned || target.resolved.archived) continue;
      if (launchFingerprint(target.resolved) !== expected) continue;
      const advertisement = await this.deps.readAdvertisement(target.resolved);
      if (advertisement && advertisement.models.length > 0) return advertisement;
    }
    return undefined;
  }
}

export function launchFingerprint(spec: CapabilityLaunch): string {
  return createHash("sha256").update(JSON.stringify({
    agentCommand: spec.agentCommand ?? null,
    acpxAgent: spec.acpxAgent ?? null,
    rawCommand: spec.rawCommand ?? null,
    agentArgv: spec.agentArgv ?? null,
  })).digest("hex");
}

export function authFingerprint(env: NodeJS.ProcessEnv): string {
  const parts: string[] = [];
  for (const key of Object.keys(env).sort()) {
    if (!/(?:TOKEN|SECRET|API_KEY|_KEY|AUTH|CREDENTIAL)/i.test(key)) continue;
    const value = env[key];
    if (!value) continue;
    parts.push(`${key}=${createHash("sha256").update(value).digest("hex")}`);
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

export function capabilityCacheKey(input: {
  agent: string;
  cwd: string;
  launch: CapabilityLaunch;
  auth: string;
}): string {
  return createHash("sha256").update([
    input.agent,
    input.cwd,
    launchFingerprint(input.launch),
    input.auth,
  ].join("\0")).digest("hex");
}
