import { expect, test } from "bun:test";

import { snapshotBotProfile, type BotProfile } from "../../../src/bots/bot-types";
import {
  AgentCapabilityService,
  authFingerprint,
  launchFingerprint,
  type AgentCapabilityDeps,
  type CapabilityAdvertisement,
  type CapabilityTarget,
} from "../../../src/agents/capability-discovery";
import type { AgentCapabilityProbeResult, ResolvedSession } from "../../../src/transport/types";

const NOW = "2026-10-09T00:00:00.000Z";

function session(alias: string, launch: { agentCommand?: string; acpxAgent?: string } = {}): ResolvedSession {
  return {
    alias,
    agent: "codex",
    workspace: "backend",
    cwd: "/repo",
    transportSession: alias,
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

function deps(partial: Partial<AgentCapabilityDeps> & Pick<AgentCapabilityDeps, "listTargets">): AgentCapabilityDeps {
  return {
    now: () => NOW,
    env: {},
    resolve: () => ({
      cwd: "/repo",
      driver: "codex",
      launch: { acpxAgent: "codex" },
      suggestions: ["custom-suggestion"],
    }),
    getBot: () => undefined,
    readAdvertisement: async () => undefined,
    ...partial,
  };
}

test("an owned runtime advertisement is returned without its hidden alias", async () => {
  const hidden = "brt_secret_alias";
  const targets: CapabilityTarget[] = [{
    productOwned: true,
    botId: "bot-1",
    scope: "bot-direct",
    resolved: session(hidden, { agentCommand: "npx codex@1" }),
  }];
  let reads = 0;
  const service = new AgentCapabilityService(deps({
    listTargets: () => targets,
    getBot: () => ({ agent: "codex", workspace: "backend", model: "gpt-advertised" }),
    resolve: () => ({
      cwd: "/repo",
      driver: "codex",
      launch: { agentCommand: "npx codex@1" },
      suggestions: ["custom-suggestion"],
    }),
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
      { productOwned: false, resolved: session("old", { agentCommand: "npx codex@old" }) },
      { productOwned: false, resolved: session("new", { agentCommand: "npx codex@new" }) },
      { productOwned: true, botId: "other", scope: "bot-direct", resolved: session("brt_other", { agentCommand: "npx codex@new" }) },
    ],
    resolve: () => ({
      cwd: "/repo",
      driver: "codex",
      launch: { agentCommand: "npx codex@new" },
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

test("an explicit model the runtime did not keep is reported as a fallback", async () => {
  const service = new AgentCapabilityService(deps({
    listTargets: () => [{
      productOwned: true,
      botId: "bot-1",
      scope: "bot-direct",
      resolved: session("brt_hidden", { agentCommand: "npx codex@1" }),
    }],
    getBot: () => ({ agent: "codex", workspace: "backend", model: "not-advertised" }),
    resolve: () => ({
      cwd: "/repo",
      driver: "codex",
      launch: { agentCommand: "npx codex@1" },
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

test("adapter pin and auth material change the cache key", () => {
  expect(launchFingerprint({ agentCommand: "npx codex@1" })).not.toBe(launchFingerprint({ agentCommand: "npx codex@2" }));
  expect(authFingerprint({ OPENAI_API_KEY: "one" })).not.toBe(authFingerprint({ OPENAI_API_KEY: "two" }));
  expect(authFingerprint({ OPENAI_API_KEY: "one" })).not.toContain("one");
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
