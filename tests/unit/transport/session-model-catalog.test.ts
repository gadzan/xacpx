import { expect, test } from "bun:test";

import {
  probeSessionModelCatalog,
  readSessionModelCatalog,
  sessionLaunchProbeRequest,
} from "../../../src/transport/session-model-catalog";
import type { ResolvedSession } from "../../../src/transport/types";

const session: ResolvedSession = {
  alias: "relay:demo",
  agent: "omp",
  driver: "omp",
  workspace: "repo",
  cwd: "/repo",
  transportSession: "repo:relay:demo",
  model: "provider/openai/gpt-5.2",
  settingsPolicy: "isolated",
  agentCommand: "/usr/local/bin/omp acp",
  acpxAgent: "omp-overlay",
  rawCommand: "omp",
  agentArgv: ["acp", "--profile", "work"],
};

test("the probe request carries the exact launch identity without the target model or alias", () => {
  const request = sessionLaunchProbeRequest(session);
  expect(request).toEqual({
    agent: "omp",
    cwd: "/repo",
    driver: "omp",
    settingsPolicy: "isolated",
    agentCommand: "/usr/local/bin/omp acp",
    acpxAgent: "omp-overlay",
    rawCommand: "omp",
    agentArgv: ["acp", "--profile", "work"],
  });
  expect(JSON.stringify(request)).not.toContain("gpt-5.2");
  expect(JSON.stringify(request)).not.toContain("relay:demo");
});

test("a probe failure throws a diagnostic naming the session and the cause", async () => {
  await expect(
    probeSessionModelCatalog(async () => {
      throw new Error("adapter offline");
    }, session),
  ).rejects.toThrow(
    'model catalog refresh failed for agent "omp" session "relay:demo": adapter offline',
  );
});

test("an unsuccessful probe reports its failure kind instead of a list", async () => {
  await expect(
    probeSessionModelCatalog(async () => ({
      ok: false,
      failure: "unauthenticated",
      message: "run omp login",
    }), session),
  ).rejects.toThrow(
    'model catalog refresh failed for agent "omp" session "relay:demo": unauthenticated: run omp login',
  );
});

test("a native read failure that is not a restore failure is rethrown unchanged", async () => {
  let probes = 0;
  await expect(
    readSessionModelCatalog({
      session,
      read: async () => {
        throw new Error("acpx binary crashed");
      },
      probe: async () => {
        probes += 1;
        return { ok: true, models: [], efforts: [] };
      },
    }),
  ).rejects.toThrow("acpx binary crashed");
  expect(probes).toBe(0);
});

test("a native restore failure falls back to the exact-launch probe", async () => {
  const result = await readSessionModelCatalog({
    session,
    read: async () => {
      throw new Error("Could not restore model provider/openai/gpt-5.2");
    },
    probe: async () => ({
      ok: true,
      models: [{ modelId: "provider/openai/gpt-5.2", name: "GPT-5.2" }],
      efforts: [],
    }),
  });
  expect(result).toEqual({
    current: "provider/openai/gpt-5.2",
    available: ["provider/openai/gpt-5.2"],
  });
});

test("a failing fallback reports the original native failure, not the probe failure", async () => {
  await expect(
    readSessionModelCatalog({
      session,
      read: async () => {
        throw new Error("Could not restore model provider/openai/gpt-5.2");
      },
      probe: async () => {
        throw new Error("probe boom");
      },
    }),
  ).rejects.toThrow("Could not restore model provider/openai/gpt-5.2");
});

test("a transport without a native read reports the resolved model with no catalog", async () => {
  await expect(readSessionModelCatalog({ session })).resolves.toEqual({
    current: "provider/openai/gpt-5.2",
    available: [],
  });
});

test("a refresh skips the native read entirely", async () => {
  let nativeReads = 0;
  const result = await readSessionModelCatalog({
    session,
    refresh: true,
    read: async () => {
      nativeReads += 1;
      return { current: "stale", available: ["stale"] };
    },
    probe: async () => ({
      ok: true,
      models: [{ modelId: "provider/openai/gpt-5.2", name: "GPT-5.2" }],
      efforts: [],
    }),
  });
  expect(nativeReads).toBe(0);
  expect(result).toEqual({
    current: "provider/openai/gpt-5.2",
    available: ["provider/openai/gpt-5.2"],
  });
});

test("a refresh without a probe fails loudly instead of reading the native session", async () => {
  let nativeReads = 0;
  await expect(
    readSessionModelCatalog({
      session,
      refresh: true,
      read: async () => {
        nativeReads += 1;
        return { current: "stale", available: ["stale"] };
      },
    }),
  ).rejects.toThrow(
    "model catalog refresh requires a transport that can probe agent capabilities",
  );
  expect(nativeReads).toBe(0);
});

test("an empty native catalog falls back to the cold probe when asked", async () => {
  const result = await readSessionModelCatalog({
    session,
    coldFallbackWhenEmpty: true,
    read: async () => ({ current: undefined, available: [] }),
    probe: async () => ({
      ok: true,
      models: [{ modelId: "provider/openai/gpt-5.2", name: "GPT-5.2" }],
      efforts: [],
    }),
  });
  expect(result).toEqual({
    current: "provider/openai/gpt-5.2",
    available: ["provider/openai/gpt-5.2"],
  });
});

test("a failing cold fallback keeps the empty native catalog instead of failing", async () => {
  const result = await readSessionModelCatalog({
    session,
    coldFallbackWhenEmpty: true,
    read: async () => ({ current: undefined, available: [] }),
    probe: async () => {
      throw new Error("probe boom");
    },
  });
  expect(result).toEqual({ current: undefined, available: [] });
});

test("without the cold fallback flag an empty native catalog stays empty", async () => {
  let probes = 0;
  const result = await readSessionModelCatalog({
    session,
    read: async () => ({ current: undefined, available: [] }),
    probe: async () => {
      probes += 1;
      return { ok: true, models: [], efforts: [] };
    },
  });
  expect(result).toEqual({ current: undefined, available: [] });
  expect(probes).toBe(0);
});
