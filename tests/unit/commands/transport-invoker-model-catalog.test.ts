import { expect, test } from "bun:test";

import { TransportInvoker } from "../../../src/commands/transport-invoker";
import { createNoopAppLogger } from "../../../src/logging/app-logger";
import type { ResolvedSession, SessionTransport } from "../../../src/transport/types";

function makeInvoker(transport: SessionTransport): TransportInvoker {
  return new TransportInvoker({
    transport,
    logger: createNoopAppLogger(),
    sessions: {},
    resolveSessionAgentCommand: async () => undefined,
    autoInstall: async () => ({ ok: false, errors: [], logPath: "" }),
    discoverPaths: async () => [],
  } as never);
}

const session: ResolvedSession = {
  alias: "relay:demo",
  agent: "omp",
  driver: "omp",
  workspace: "repo",
  cwd: "/repo",
  transportSession: "repo:relay:demo",
  model: "provider/openai/gpt-5.2",
  agentCommand: "/usr/local/bin/omp acp",
  acpxAgent: "omp-overlay",
  rawCommand: "omp",
  agentArgv: ["acp", "--profile", "work"],
};

test("a refreshed model read probes the exact launch and never reads the native session", async () => {
  const probeRequests: unknown[] = [];
  let nativeReads = 0;
  const transport = {
    async getSessionModel() {
      nativeReads += 1;
      return { current: "stale", available: ["stale"] };
    },
    async probeAgentCapabilities(input: unknown) {
      probeRequests.push(input);
      return {
        ok: true,
        models: [
          { modelId: "provider/openai/gpt-5.2", name: "GPT-5.2" },
          { modelId: "provider/anthropic/claude", name: "Claude" },
        ],
        efforts: [],
      };
    },
  } as unknown as SessionTransport;
  const invoker = makeInvoker(transport);

  const result = await invoker.getModelTransportSession(session, { refresh: true });

  expect(result).toEqual({
    current: "provider/openai/gpt-5.2",
    available: ["provider/openai/gpt-5.2", "provider/anthropic/claude"],
  });
  expect(nativeReads).toBe(0);
  expect(probeRequests).toEqual([
    {
      agent: "omp",
      cwd: "/repo",
      driver: "omp",
      agentCommand: "/usr/local/bin/omp acp",
      acpxAgent: "omp-overlay",
      rawCommand: "omp",
      agentArgv: ["acp", "--profile", "work"],
    },
  ]);
});

test("a refreshed model read throws a diagnostic instead of falling back to the native read", async () => {
  const transport = {
    async getSessionModel() {
      return { current: "stale", available: ["stale"] };
    },
    async probeAgentCapabilities() {
      throw new Error("adapter auth expired");
    },
  } as unknown as SessionTransport;
  const invoker = makeInvoker(transport);

  await expect(
    invoker.getModelTransportSession(session, { refresh: true }),
  ).rejects.toThrow(
    'model catalog refresh failed for agent "omp" session "relay:demo": adapter auth expired',
  );
});

test("an unsuccessful refresh probe reports the failure kind, not a cached list", async () => {
  const transport = {
    async getSessionModel() {
      return { current: "stale", available: ["stale"] };
    },
    async probeAgentCapabilities() {
      return {
        ok: false,
        failure: "unauthenticated",
        message: "run omp login",
      };
    },
  } as unknown as SessionTransport;
  const invoker = makeInvoker(transport);

  await expect(
    invoker.getModelTransportSession(session, { refresh: true }),
  ).rejects.toThrow(
    'model catalog refresh failed for agent "omp" session "relay:demo": unauthenticated: run omp login',
  );
});

test("a normal model read still uses the native session and ignores the probe", async () => {
  let nativeReads = 0;
  let probes = 0;
  const transport = {
    async getSessionModel() {
      nativeReads += 1;
      return { current: "live", available: ["live", "other"] };
    },
    async probeAgentCapabilities() {
      probes += 1;
      return { ok: true, models: [], efforts: [] };
    },
  } as unknown as SessionTransport;
  const invoker = makeInvoker(transport);

  await expect(invoker.getModelTransportSession(session)).resolves.toEqual({
    current: "live",
    available: ["live", "other"],
  });
  expect(nativeReads).toBe(1);
  expect(probes).toBe(0);
});

test("an OMP session with an empty native catalog falls back to the cold probe", async () => {
  const probeRequests: unknown[] = [];
  const transport = {
    async getSessionModel() {
      return { current: undefined, available: [] };
    },
    async probeAgentCapabilities(input: unknown) {
      probeRequests.push(input);
      return {
        ok: true,
        models: [{ modelId: "provider/openai/gpt-5.2", name: "GPT-5.2" }],
        efforts: [],
      };
    },
  } as unknown as SessionTransport;
  const invoker = makeInvoker(transport);

  await expect(invoker.getModelTransportSession(session)).resolves.toEqual({
    current: "provider/openai/gpt-5.2",
    available: ["provider/openai/gpt-5.2"],
  });
  expect(probeRequests).toHaveLength(1);
});

test("a non-OMP session with an empty native catalog stays empty", async () => {
  let probes = 0;
  const transport = {
    async getSessionModel() {
      return { current: undefined, available: [] };
    },
    async probeAgentCapabilities() {
      probes += 1;
      return { ok: true, models: [], efforts: [] };
    },
  } as unknown as SessionTransport;
  const invoker = makeInvoker(transport);

  await expect(
    invoker.getModelTransportSession({ ...session, driver: "codex", agent: "codex" }),
  ).resolves.toEqual({ current: undefined, available: [] });
  expect(probes).toBe(0);
});
