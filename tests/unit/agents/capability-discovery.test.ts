import { expect, test } from "bun:test";

import { snapshotBotProfile, type BotProfile } from "../../../src/bots/bot-types";
import {
  AgentCapabilityService,
  fingerprintV2Key,
  launchFingerprint,
  MODEL_CATALOG_SOFT_TTL_MS,
  type AgentCapabilityDeps,
  type CachedCapabilityV2,
  type CapabilityAdvertisement,
  type CapabilityCacheStore,
  type CapabilityTarget,
  type ModelDiscoveryEvent,
} from "../../../src/agents/capability-discovery";
import type { AgentCapabilityProbeResult, ResolvedSession } from "../../../src/transport/types";

const NOW = "2026-10-09T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const CODEC_ARGV = ["npx", "codex@1"];

function session(
  alias: string,
  launch: { agentCommand?: string; acpxAgent?: string; agentArgv?: string[] } = {},
): ResolvedSession {
  return {
    alias,
    agent: "codex",
    driver: "codex",
    workspace: "backend",
    cwd: "/repo",
    transportSession: alias,
    acpxAgent: "codex",
    ...launch,
  };
}

function advertisement(models: string[], extra: Partial<CapabilityAdvertisement> = {}): CapabilityAdvertisement {
  return {
    models: models.map((modelId) => ({ modelId, name: modelId })),
    efforts: ["low", "high"],
    effortKnown: true,
    ...extra,
  };
}

function structuredLaunch(argv: string[] = CODEC_ARGV) {
  return {
    acpxAgent: "codex",
    agentCommand: argv.join(" "),
    agentArgv: [...argv],
  };
}

function deps(partial: Partial<AgentCapabilityDeps> & Pick<AgentCapabilityDeps, "listTargets">): AgentCapabilityDeps {
  return {
    now: () => NOW,
    env: {},
    resolve: () => ({
      cwd: "/repo",
      driver: "codex",
      launch: structuredLaunch(),
      suggestions: ["custom-suggestion"],
    }),
    getBot: () => undefined,
    readAdvertisement: async () => undefined,
    ...partial,
  };
}

/** In-memory CapabilityCacheStore over a Map, standing in for the StateStore. */
function store(persisted: Map<string, CachedCapabilityV2>): CapabilityCacheStore {
  return {
    get: (key) => persisted.get(key),
    set: (key, value) => { persisted.set(key, value); },
    load: (key) => persisted.get(key),
    persist: (key, value) => { persisted.set(key, value); },
  };
}

function v2entry(models: string[], fetchedAt: string, source: "probe" | "runtime" | "session" = "probe"): CachedCapabilityV2 {
  return {
    schemaVersion: 2,
    models: models.map((modelId) => ({ modelId })),
    efforts: [],
    effortKnown: false,
    fetchedAt,
    softExpiresAt: new Date(Date.parse(fetchedAt) + MODEL_CATALOG_SOFT_TTL_MS).toISOString(),
    source,
  };
}

function clock(initialMs = NOW_MS) {
  let at = initialMs;
  return {
    now: () => new Date(at).toISOString(),
    advance: (ms: number) => { at += ms; },
  };
}
function deferredProbe() {
  const seen: unknown[] = [];
  const calls: Array<(result: AgentCapabilityProbeResult) => void> = [];
  const probe = (input: unknown) => {
    seen.push(input);
    const { promise, resolve } = Promise.withResolvers<AgentCapabilityProbeResult>();
    calls.push(resolve);
    return promise;
  };
  return { probe, seen, calls };
}

function seedStore(models: string[], fetchedAt: string): { persisted: Map<string, CachedCapabilityV2>; cache: CapabilityCacheStore } {
  const persisted = new Map<string, CachedCapabilityV2>();
  const cache: CapabilityCacheStore = {
    get: (key) => persisted.get(key),
    set: (key, value) => { persisted.set(key, value); },
    load: (key) => {
      if (!persisted.has(key)) persisted.set(key, v2entry(models, fetchedAt));
      return persisted.get(key);
    },
  };
  return { persisted, cache };
}

test("an owned runtime advertisement is returned without its hidden alias", async () => {
  const hidden = "brt_secret_alias";
  const targets: CapabilityTarget[] = [{
    productOwned: true,
    botId: "bot-1",
    scope: "bot-direct",
    resolved: session(hidden, { agentCommand: "npx codex@1", agentArgv: CODEC_ARGV }),
  }];
  let reads = 0;
  const service = new AgentCapabilityService(deps({
    listTargets: () => targets,
    getBot: () => ({ agent: "codex", workspace: "backend", model: "gpt-advertised" }),
    readAdvertisement: async (resolved) => {
      reads += 1;
      expect(resolved.alias).toBe(hidden);
      return advertisement(["gpt-advertised"], { currentModelId: "gpt-advertised" });
    },
  }));
  const state = await service.get({ agent: "codex", workspace: "backend", botId: "bot-1" });
  expect(reads).toBe(1);
  expect(state.status).toBe("ready");
  if (state.status !== "ready") return;
  expect(state.source).toBe("runtime");
  expect(state.models.map((model) => model.modelId)).toEqual(["gpt-advertised"]);
  expect(state.effect).toEqual({ kind: "in-effect", modelId: "gpt-advertised" });
  expect(JSON.stringify(state)).not.toContain(hidden);
  expect(JSON.stringify(state)).not.toContain("npx codex@1");
});

test("a sibling session is found from the full catalog and a different adapter pin is skipped", async () => {
  const reads: string[] = [];
  const service = new AgentCapabilityService(deps({
    listTargets: () => [
      { productOwned: false, resolved: session("old", { agentCommand: "npx codex@old", agentArgv: ["npx", "codex@old"] }) },
      { productOwned: false, resolved: session("new", { agentCommand: "npx codex@new", agentArgv: ["npx", "codex@new"] }) },
      { productOwned: true, botId: "other", scope: "bot-direct", resolved: session("brt_other", { agentCommand: "npx codex@new", agentArgv: ["npx", "codex@new"] }) },
    ],
    resolve: () => ({
      cwd: "/repo",
      driver: "codex",
      launch: { agentCommand: "npx codex@new", acpxAgent: "codex", agentArgv: ["npx", "codex@new"] },
      suggestions: [],
    }),
    readAdvertisement: async (resolved) => {
      reads.push(resolved.alias);
      return advertisement(["gpt-from-session"]);
    },
  }));
  const state = await service.get({ agent: "codex", workspace: "backend" });
  expect(reads).toEqual(["new"]);
  expect(state.status).toBe("ready");
  if (state.status !== "ready") return;
  expect(state.source).toBe("session");
  expect(state.appliedModelId).toBeUndefined();
  expect(JSON.stringify(state)).not.toContain("brt_other");
});

test("no advertisement asks for a fetch instead of returning an empty model list", async () => {
  const service = new AgentCapabilityService(deps({ listTargets: () => [] }));
  const state = await service.get({ agent: "codex", workspace: "backend" });
  expect(state.status).toBe("needs-setup");
  if (state.status !== "needs-setup") return;
  expect(state.reason.code).toBe("discovery-available");
  expect(state.suggestions.map((model) => model.source)).toEqual(["suggestion"]);
  expect("models" in state).toBe(false);
});

test("a probe that cannot enumerate stays unsupported and does not invent models", async () => {
  let probes = 0;
  const service = new AgentCapabilityService(deps({
    listTargets: () => [],
    probe: async () => {
      probes += 1;
      return { ok: false, failure: "unsupported", message: "the adapter started but did not advertise any models" };
    },
  }));
  const state = await service.get({ agent: "codex", workspace: "backend", probe: true });
  expect(probes).toBe(1);
  expect(state.status).toBe("unsupported");
  if (state.status !== "unsupported") return;
  expect(state.reason.code).toBe("adapter-cannot-enumerate");
  expect(state.suggestions[0]?.modelId).toBe("custom-suggestion");
});

test("an unauthenticated probe is needs-setup and a later read uses the cache after a successful probe", async () => {
  const calls: AgentCapabilityProbeResult[] = [];
  let probes = 0;
  const service = new AgentCapabilityService(deps({
    listTargets: () => [],
    probe: async () => {
      probes += 1;
      const result: AgentCapabilityProbeResult = probes === 1
        ? { ok: false, failure: "unauthenticated", message: "login required" }
        : { ok: true, models: [{ modelId: "gpt-probed", name: "GPT Probed" }], efforts: ["high"], currentEffort: "high" };
      calls.push(result);
      return result;
    },
  }));
  const denied = await service.get({ agent: "codex", workspace: "backend", probe: true });
  expect(denied.status).toBe("needs-setup");
  if (denied.status === "needs-setup") expect(denied.reason.code).toBe("unauthenticated");
  const probed = await service.get({ agent: "codex", workspace: "backend", probe: true });
  expect(probed.status).toBe("ready");
  if (probed.status === "ready") {
    expect(probed.source).toBe("probe");
    expect(probed.models[0]?.modelId).toBe("gpt-probed");
    expect(probed.models[0]?.name).toBe("GPT Probed");
  }
  const cached = await service.get({ agent: "codex", workspace: "backend" });
  expect(cached.status).toBe("ready");
  if (cached.status === "ready") expect(cached.source).toBe("cache");
  expect(probes).toBe(2);
});

test("concurrent probes for one adapter share a single transport call", async () => {
  let probes = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const service = new AgentCapabilityService(deps({
    listTargets: () => [],
    probe: async () => {
      probes += 1;
      await gate;
      return { ok: true, models: [{ modelId: "gpt-shared", name: "gpt-shared" }], efforts: [] };
    },
  }));
  const first = service.get({ agent: "codex", workspace: "backend", probe: true });
  const second = service.get({ agent: "codex", workspace: "backend", probe: true });
  release();
  const [left, right] = await Promise.all([first, second]);
  expect(probes).toBe(1);
  expect(left.status).toBe("ready");
  expect(right.status).toBe("ready");
});

test("an explicit probe re-verifies even when the bot's own runtime advertises models", async () => {
  let probes = 0;
  const service = new AgentCapabilityService(deps({
    listTargets: () => [{
      productOwned: true,
      botId: "bot-1",
      scope: "bot-direct",
      resolved: session("brt_hidden", { agentCommand: "npx codex@1", agentArgv: CODEC_ARGV }),
    }],
    getBot: () => ({ agent: "codex", workspace: "backend", model: "gpt-stale" }),
    readAdvertisement: async () => advertisement(["gpt-stale"]),
    probe: async () => {
      probes += 1;
      return { ok: true, models: [{ modelId: "gpt-fresh", name: "GPT Fresh" }], efforts: [] };
    },
  }));
  const state = await service.get({ agent: "codex", workspace: "backend", botId: "bot-1", probe: true });
  expect(probes).toBe(1);
  expect(state.status).toBe("ready");
  if (state.status !== "ready") return;
  expect(state.source).toBe("probe");
  expect(state.models.map((model) => model.modelId)).toEqual(["gpt-fresh"]);
});

test("a passive read still prefers the bot's own runtime without probing", async () => {
  let probes = 0;
  const service = new AgentCapabilityService(deps({
    listTargets: () => [{
      productOwned: true,
      botId: "bot-1",
      scope: "bot-direct",
      resolved: session("brt_hidden", { agentCommand: "npx codex@1", agentArgv: CODEC_ARGV }),
    }],
    getBot: () => ({ agent: "codex", workspace: "backend", model: "gpt-live" }),
    readAdvertisement: async () => advertisement(["gpt-live"], { currentModelId: "gpt-live" }),
    probe: async () => {
      probes += 1;
      return { ok: true, models: [{ modelId: "gpt-fresh" }], efforts: [] };
    },
  }));
  const state = await service.get({ agent: "codex", workspace: "backend", botId: "bot-1" });
  expect(probes).toBe(0);
  expect(state.status).toBe("ready");
  if (state.status !== "ready") return;
  expect(state.source).toBe("runtime");
  expect(state.effect).toEqual({ kind: "in-effect", modelId: "gpt-live" });
});

test("an explicit model the runtime did not keep is reported as a fallback", async () => {
  const service = new AgentCapabilityService(deps({
    listTargets: () => [{
      productOwned: true,
      botId: "bot-1",
      scope: "bot-direct",
      resolved: session("brt_hidden", { agentCommand: "npx codex@1", agentArgv: CODEC_ARGV }),
    }],
    getBot: () => ({ agent: "codex", workspace: "backend", model: "not-advertised" }),
    resolve: () => ({
      cwd: "/repo",
      driver: "codex",
      launch: structuredLaunch(),
      suggestions: [],
    }),
    readAdvertisement: async () => advertisement(["gpt-real"], { currentModelId: "gpt-real" }),
  }));
  const state = await service.get({ agent: "codex", workspace: "backend", botId: "bot-1" });
  expect(state.status).toBe("ready");
  if (state.status !== "ready") return;
  expect(state.effect).toEqual({
    kind: "fell-back",
    selectedModelId: "not-advertised",
    appliedModelId: "gpt-real",
  });
});

test("a missing transport probe is unsupported rather than an empty ready list", async () => {
  const service = new AgentCapabilityService(deps({ listTargets: () => [] }));
  const state = await service.get({ agent: "codex", workspace: "backend", probe: true });
  expect(state.status).toBe("unsupported");
  if (state.status !== "unsupported") return;
  expect(state.reason.code).toBe("probe-unavailable");
});

test("fingerprint v2 rotates the key per identity field", () => {
  expect(launchFingerprint({ agentCommand: "npx codex@1" })).not.toBe(launchFingerprint({ agentCommand: "npx codex@2" }));
  const base = {
    schemaVersion: 2 as const,
    agent: "codex",
    driver: "codex",
    canonicalCwd: "/repo",
    settingsPolicy: "none",
    launchDigest: "launch",
    resolvedAgentCommandDigest: "resolved",
    configRevision: "unversioned",
    authRevision: "auth",
  };
  const key = fingerprintV2Key(base);
  expect(key.startsWith("v2:")).toBe(true);
  const rotate = (patch: Partial<typeof base>) => fingerprintV2Key({ ...base, ...patch });
  expect(rotate({ driver: "claude" })).not.toBe(key);
  expect(rotate({ canonicalCwd: "/other" })).not.toBe(key);
  expect(rotate({ settingsPolicy: "isolated" })).not.toBe(key);
  expect(rotate({ launchDigest: "other" })).not.toBe(key);
  expect(rotate({ resolvedAgentCommandDigest: "other" })).not.toBe(key);
  expect(rotate({ authRevision: "other" })).not.toBe(key);
  expect(rotate({ configRevision: "other" })).not.toBe(key);
  expect(rotate({ adapterVersion: "1.0.0" })).not.toBe(key);
  expect(fingerprintV2Key(base)).toBe(key);
});

test("a persisted list is served after the cache object is replaced", async () => {
  const persisted = new Map<string, CachedCapabilityV2>();
  const first = new AgentCapabilityService(deps({
    listTargets: () => [],
    probe: async () => ({ ok: true, models: [{ modelId: "gpt-persisted", name: "GPT Persisted" }], efforts: ["high"], currentEffort: "high" }),
  }), store(persisted));
  const probed = await first.get({ agent: "codex", workspace: "backend", probe: true });
  expect(probed.status).toBe("ready");
  if (probed.status === "ready") expect(probed.source).toBe("probe");
  expect([...persisted.keys()].length).toBe(1);
  expect([...persisted.keys()][0]?.startsWith("v2:")).toBe(true);

  // A new service instance (daemon restart) must read the durable entry.
  const second = new AgentCapabilityService(deps({ listTargets: () => [] }), store(persisted));
  const state = await second.get({ agent: "codex", workspace: "backend" });
  expect(state.status).toBe("ready");
  if (state.status !== "ready") return;
  expect(state.source).toBe("cache");
  expect(state.models.map((model) => model.modelId)).toEqual(["gpt-persisted"]);
  expect(state.fetchedAt).toBe(NOW);
  expect(state.freshness).toBe("fresh");
});

test("an explicit probe refreshes instead of replaying a saved list", async () => {
  const persisted = new Map<string, CachedCapabilityV2>();
  let probes = 0;
  const service = new AgentCapabilityService(deps({
    listTargets: () => [],
    probe: async () => {
      probes += 1;
      return { ok: true, models: [{ modelId: probes === 1 ? "gpt-old" : "gpt-new" }], efforts: [] };
    },
  }), store(persisted));
  await service.get({ agent: "codex", workspace: "backend", probe: true });
  const refreshed = await service.get({ agent: "codex", workspace: "backend", probe: true });
  expect(probes).toBe(2);
  expect(refreshed.status).toBe("ready");
  if (refreshed.status !== "ready") return;
  expect(refreshed.models.map((model) => model.modelId)).toEqual(["gpt-new"]);
});

test("a failed refresh keeps the saved list and reports the live failure", async () => {
  const persisted = new Map<string, CachedCapabilityV2>();
  let probes = 0;
  const service = new AgentCapabilityService(deps({
    listTargets: () => [],
    probe: async () => {
      probes += 1;
      return probes === 1
        ? { ok: true, models: [{ modelId: "gpt-saved" }], efforts: [] }
        : { ok: false, failure: "unauthenticated", message: "the adapter requires authentication before it can list models" };
    },
  }), store(persisted));
  await service.get({ agent: "codex", workspace: "backend", probe: true });
  const denied = await service.get({ agent: "codex", workspace: "backend", probe: true });
  expect(probes).toBe(2);
  // The list survives, but the state must not claim it was just verified.
  expect(denied.status).toBe("ready");
  if (denied.status !== "ready") return;
  expect(denied.source).toBe("cache");
  expect(denied.models.map((model) => model.modelId)).toEqual(["gpt-saved"]);
  expect(denied.reason?.code).toBe("unauthenticated");
  expect(denied.freshness).toBe("fresh");
});

test("a failed first fetch with no saved list stays needs-setup", async () => {
  const service = new AgentCapabilityService(deps({
    listTargets: () => [],
    probe: async () => ({ ok: false, failure: "unauthenticated", message: "login required" }),
  }), store(new Map()));
  const state = await service.get({ agent: "codex", workspace: "backend", probe: true });
  expect(state.status).toBe("needs-setup");
  if (state.status === "needs-setup") expect(state.reason.code).toBe("unauthenticated");
});

test("a persisted list is not reused for a different adapter pin", async () => {
  const persisted = new Map<string, CachedCapabilityV2>();
  const first = new AgentCapabilityService(deps({
    listTargets: () => [],
    resolve: () => ({ cwd: "/repo", driver: "codex", launch: structuredLaunch(["npx", "codex@1"]), suggestions: [] }),
    probe: async () => ({ ok: true, models: [{ modelId: "gpt-old-pin" }], efforts: [] }),
  }), store(persisted));
  await first.get({ agent: "codex", workspace: "backend", probe: true });

  const second = new AgentCapabilityService(deps({
    listTargets: () => [],
    resolve: () => ({ cwd: "/repo", driver: "codex", launch: structuredLaunch(["npx", "codex@2"]), suggestions: [] }),
    probe: async () => ({ ok: true, models: [{ modelId: "gpt-new-pin" }], efforts: [] }),
  }), store(persisted));
  const state = await second.get({ agent: "codex", workspace: "backend", probe: true });
  expect(state.status).toBe("ready");
  if (state.status !== "ready") return;
  expect(state.models.map((model) => model.modelId)).toEqual(["gpt-new-pin"]);
});

test("an accepted bot profile snapshot keeps the model from accept time", () => {
  const bot: BotProfile = {
    id: "bot-1",
    name: "Reviewer",
    agent: "codex",
    workspace: "backend",
    model: "gpt-then",
    effort: "high",
    enabled: true,
    profileRevision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const snapshot = snapshotBotProfile(bot, NOW);
  bot.model = "gpt-later";
  bot.effort = "low";
  expect(snapshot.execution.model).toBe("gpt-then");
  expect(snapshot.execution.effort).toBe("high");
});

test("a fresh cache beats a live session without reading it", async () => {
  const { cache } = seedStore(["gpt-cached"], NOW);
  const events: ModelDiscoveryEvent[] = [];
  let reads = 0;
  const service = new AgentCapabilityService(deps({
    listTargets: () => [
      { productOwned: false, resolved: session("live", { agentCommand: "npx codex@1", agentArgv: CODEC_ARGV }) },
    ],
    readAdvertisement: async () => {
      reads += 1;
      return advertisement(["gpt-live"]);
    },
    emit: (event) => { events.push(event); },
  }), cache);
  const state = await service.get({ agent: "codex", workspace: "backend" });
  expect(reads).toBe(0);
  expect(state.status).toBe("ready");
  if (state.status !== "ready") return;
  expect(state.source).toBe("cache");
  expect(state.models.map((model) => model.modelId)).toEqual(["gpt-cached"]);
  expect(state.freshness).toBe("fresh");
  expect(events.filter((event) => event.type === "agent.model_discovery.cache_hit")).toHaveLength(1);
});

test("a stale cache loses to a compatible session and refreshes from it", async () => {
  const staleAt = new Date(NOW_MS - 16 * 60 * 1000).toISOString();
  const { persisted, cache } = seedStore(["gpt-stale"], staleAt);
  const events: ModelDiscoveryEvent[] = [];
  let probes = 0;
  const service = new AgentCapabilityService(deps({
    listTargets: () => [
      { productOwned: false, resolved: session("live", { agentCommand: "npx codex@1", agentArgv: CODEC_ARGV }) },
    ],
    readAdvertisement: async () => advertisement(["gpt-live"]),
    probe: async () => {
      probes += 1;
      return { ok: true, models: [{ modelId: "gpt-probe" }], efforts: [] };
    },
    emit: (event) => { events.push(event); },
  }), cache);
  const state = await service.get({ agent: "codex", workspace: "backend" });
  expect(state.status).toBe("ready");
  if (state.status !== "ready") return;
  expect(state.source).toBe("session");
  expect(state.models.map((model) => model.modelId)).toEqual(["gpt-live"]);
  expect(probes).toBe(0);
  // The session wins before the stale branch, so no stale event and no probe.
  expect(events.some((event) => event.type === "agent.model_discovery.cache_stale")).toBe(false);
  expect(events.some((event) => event.type === "agent.model_discovery.probe_started")).toBe(false);
  const stored = [...persisted.values()].at(-1);
  expect(stored?.models.map((model) => model.modelId)).toEqual(["gpt-live"]);
  expect(stored?.source).toBe("session");
});

test("a stale cache returns stale plus a background refresh", async () => {
  const staleAt = new Date(NOW_MS - 16 * 60 * 1000).toISOString();
  const { persisted, cache } = seedStore(["gpt-stale"], staleAt);
  const events: ModelDiscoveryEvent[] = [];
  const noticed = Promise.withResolvers<{ agent: string; workspace: string }>();
  const service = new AgentCapabilityService(deps({
    listTargets: () => [],
    probe: async () => ({ ok: true, models: [{ modelId: "gpt-bg", name: "GPT BG" }], efforts: [] }),
    emit: (event) => { events.push(event); },
  }), cache);
  service.onCapabilitiesChanged((notice) => {
    noticed.resolve({ agent: notice.agent, workspace: notice.workspace });
  });
  const state = await service.get({ agent: "codex", workspace: "backend" });
  expect(state.status).toBe("ready");
  if (state.status !== "ready") return;
  expect(state.source).toBe("cache");
  expect(state.models.map((model) => model.modelId)).toEqual(["gpt-stale"]);
  expect(state.freshness).toBe("stale");
  expect(state.refreshing).toBe(true);
  expect(state.lastVerifiedAt).toBe(staleAt);
  const notice = await noticed.promise;
  expect(notice).toMatchObject({ agent: "codex", workspace: "backend" });
  const stored = [...persisted.values()].at(-1);
  expect(stored?.models.map((model) => model.modelId)).toEqual(["gpt-bg"]);
  expect(events.some((event) => event.type === "agent.model_discovery.probe_started" && event.background === true)).toBe(true);
  expect(events.some((event) => event.type === "agent.model_discovery.probe_succeeded" && event.modelCount === 1)).toBe(true);
});

test("a stale entry past retention is needs-setup", async () => {
  const ancient = new Date(NOW_MS - 31 * 24 * 60 * 60 * 1000).toISOString();
  const { cache } = seedStore(["gpt-ancient"], ancient);
  let probes = 0;
  const service = new AgentCapabilityService(deps({
    listTargets: () => [],
    probe: async () => {
      probes += 1;
      return { ok: true, models: [{ modelId: "gpt-probe" }], efforts: [] };
    },
  }), cache);
  const state = await service.get({ agent: "codex", workspace: "backend" });
  expect(state.status).toBe("needs-setup");
  expect(probes).toBe(0);
});

test("a failed background refresh keeps last-good and suppresses retries for 30s", async () => {
  const staleAt = new Date(NOW_MS - 16 * 60 * 1000).toISOString();
  const { cache } = seedStore(["gpt-good"], staleAt);
  const failed = Promise.withResolvers<void>();
  const clk = clock();
  let probes = 0;
  const service = new AgentCapabilityService(deps({
    now: clk.now,
    listTargets: () => [],
    probe: async () => {
      probes += 1;
      return { ok: false, failure: "transport", message: "boom" };
    },
    emit: (event) => {
      if (event.type === "agent.model_discovery.probe_failed") failed.resolve();
    },
  }), cache);
  const first = await service.get({ agent: "codex", workspace: "backend" });
  expect(first.status).toBe("ready");
  await failed.promise;
  expect(probes).toBe(1);
  const second = await service.get({ agent: "codex", workspace: "backend" });
  expect(second.status).toBe("ready");
  if (second.status !== "ready") return;
  expect(second.refreshing).toBeUndefined();
  expect(probes).toBe(1);
  clk.advance(31 * 1000);
  await service.get({ agent: "codex", workspace: "backend" });
  expect(probes).toBe(2);
});

test("an invalidated generation never writes or publishes", async () => {
  const staleAt = new Date(NOW_MS - 20 * 60 * 1000).toISOString();
  const { persisted, cache } = seedStore(["gpt-old"], staleAt);
  const noticed = Promise.withResolvers<void>();
  const discarded = Promise.withResolvers<void>();
  const gate = deferredProbe();
  const service = new AgentCapabilityService(deps({
    listTargets: () => [],
    probe: gate.probe as AgentCapabilityDeps["probe"],
    log: (message) => {
      if (message.includes("discarded")) discarded.resolve();
    },
  }), cache);
  service.onCapabilitiesChanged(() => { noticed.resolve(); });
  const first = await service.get({ agent: "codex", workspace: "backend" });
  expect(first.status).toBe("ready");
  expect(gate.calls).toHaveLength(1);
  expect(service.invalidateCapability("codex", "backend")).toBe(true);
  gate.calls[0]?.({ ok: true, models: [{ modelId: "gpt-new", name: "GPT New" }], efforts: [] });
  await discarded.promise;
  expect([...persisted.values()].at(-1)?.models.map((model) => model.modelId)).toEqual(["gpt-old"]);
  // The old flight's cleanup must not steal the new generation's flight.
  await service.get({ agent: "codex", workspace: "backend" });
  expect(gate.calls).toHaveLength(2);
  gate.calls[1]?.({ ok: true, models: [{ modelId: "gpt-new", name: "GPT New" }], efforts: [] });
  await noticed.promise;
  expect([...persisted.values()].at(-1)?.models.map((model) => model.modelId)).toEqual(["gpt-new"]);
});

test("a cold probe result leaves efforts unavailable unless verified", async () => {
  const results: AgentCapabilityProbeResult[] = [
    { ok: true, models: [{ modelId: "gpt-a", name: "GPT A" }], efforts: [] },
    { ok: true, models: [{ modelId: "gpt-b", name: "GPT B" }], efforts: ["high"], currentEffort: "high", effortKnown: true },
  ];
  let calls = 0;
  const service = new AgentCapabilityService(deps({
    listTargets: () => [],
    probe: async () => results[calls++]!,
  }));
  const unknown = await service.get({ agent: "codex", workspace: "backend", probe: true });
  expect(unknown.status).toBe("ready");
  if (unknown.status !== "ready") return;
  expect(unknown.efforts).toEqual({ status: "unavailable" });
  const known = await service.get({ agent: "codex", workspace: "backend", probe: true });
  expect(known.status).toBe("ready");
  if (known.status !== "ready") return;
  expect(known.efforts.status).toBe("known");
});

test("an explicit empty stays empty and is never cached", async () => {
  const persisted = new Map<string, CachedCapabilityV2>();
  const events: ModelDiscoveryEvent[] = [];
  const service = new AgentCapabilityService(deps({
    listTargets: () => [],
    probe: async () => ({ ok: true, models: [], efforts: [] }),
    emit: (event) => { events.push(event); },
  }), store(persisted));
  const empty = await service.get({ agent: "codex", workspace: "backend", probe: true });
  expect(empty.status).toBe("empty");
  if (empty.status !== "empty") return;
  expect(empty.reason.code).toBe("discovery-available");
  expect(persisted.size).toBe(0);
  expect(events.some((event) => event.type === "agent.model_discovery.probe_empty")).toBe(true);
  const passive = await service.get({ agent: "codex", workspace: "backend" });
  expect(passive.status).toBe("needs-setup");
});

test("an unprovable launch stays probe-unavailable without calling transport", async () => {
  const events: ModelDiscoveryEvent[] = [];
  let probes = 0;
  const service = new AgentCapabilityService(deps({
    listTargets: () => [],
    resolve: () => ({ cwd: "/repo", driver: "codex", launch: { acpxAgent: "codex" }, suggestions: [] }),
    probe: async () => {
      probes += 1;
      return { ok: true, models: [{ modelId: "gpt-guessed" }], efforts: [] };
    },
    emit: (event) => { events.push(event); },
  }));
  const state = await service.get({ agent: "codex", workspace: "backend", probe: true });
  expect(probes).toBe(0);
  expect(state.status).toBe("unsupported");
  if (state.status !== "unsupported") return;
  expect(state.reason.code).toBe("probe-unavailable");
  expect(events.some((event) => event.type === "agent.model_discovery.probe_unsupported" && event.outcome === "probe-unavailable")).toBe(true);
});

test("the probe request carries argv, identity, and no secrets", async () => {
  const seen: unknown[] = [];
  const service = new AgentCapabilityService(deps({
    env: { OPENAI_API_KEY: "sekret-value", UNRELATED: "plain" },
    listTargets: () => [],
    probe: async (input) => {
      seen.push(input);
      return { ok: true, models: [{ modelId: "gpt-x" }], efforts: [] };
    },
  }));
  await service.get({ agent: "codex", workspace: "backend", probe: true });
  expect(seen).toHaveLength(1);
  const request = seen[0] as Record<string, unknown>;
  expect(request["agentArgv"]).toEqual(CODEC_ARGV);
  const identity = request["identity"] as Record<string, unknown>;
  expect(identity["launchDigest"]).toBe(launchFingerprint({ acpxAgent: "codex", agentCommand: CODEC_ARGV.join(" "), agentArgv: CODEC_ARGV }));
  expect(typeof identity["resolvedAgentCommandDigest"]).toBe("string");
  expect(identity["agentProcessEnv"]).toBeUndefined();
  expect(JSON.stringify(seen)).not.toContain("sekret-value");
});

test("an owned runtime wins over a fresh cache", async () => {
  const { cache } = seedStore(["gpt-cached"], NOW);
  const service = new AgentCapabilityService(deps({
    listTargets: () => [{
      productOwned: true,
      botId: "bot-1",
      scope: "bot-direct",
      resolved: session("brt_hidden", { agentCommand: "npx codex@1", agentArgv: CODEC_ARGV }),
    }],
    getBot: () => ({ agent: "codex", workspace: "backend", model: "gpt-live" }),
    readAdvertisement: async () => advertisement(["gpt-live"], { currentModelId: "gpt-live" }),
  }), cache);
  const state = await service.get({ agent: "codex", workspace: "backend", botId: "bot-1" });
  expect(state.status).toBe("ready");
  if (state.status !== "ready") return;
  expect(state.source).toBe("runtime");
  expect(state.models.map((model) => model.modelId)).toEqual(["gpt-live"]);
});

test("observability covers an explicit success and a failed write", async () => {
  const events: ModelDiscoveryEvent[] = [];
  const logs: string[] = [];
  const persisted = new Map<string, CachedCapabilityV2>();
  const service = new AgentCapabilityService(deps({
    listTargets: () => [],
    probe: async () => ({ ok: true, models: [{ modelId: "gpt-a" }, { modelId: "gpt-b" }], efforts: [] }),
    emit: (event) => { events.push(event); },
    log: (message) => { logs.push(message); },
  }), {
    get: (key) => persisted.get(key),
    set: (key, value) => { persisted.set(key, value); },
    load: (key) => persisted.get(key),
    persist: () => { throw new Error("disk full"); },
  });
  const state = await service.get({ agent: "codex", workspace: "backend", probe: true });
  expect(state.status).toBe("ready");
  const types = events.map((event) => event.type);
  expect(types).toContain("agent.model_discovery.probe_started");
  const succeeded = events.find((event) => event.type === "agent.model_discovery.probe_succeeded");
  expect(succeeded?.modelCount).toBe(2);
  expect(typeof succeeded?.durationMs).toBe("number");
  expect(succeeded?.fingerprintPrefix).toMatch(/^[0-9a-f]{8}$/);
  const writeFailed = events.find((event) => event.type === "agent.model_discovery.cache_write_failed");
  expect(writeFailed?.fingerprintPrefix).toBe(succeeded?.fingerprintPrefix);
  expect(logs.some((message) => message.includes(succeeded?.fingerprintPrefix ?? "missing"))).toBe(true);
  expect(logs.some((message) => message.includes("npx"))).toBe(false);
});
