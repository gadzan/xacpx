import { expect, test } from "bun:test";
import type { AcpRuntimeSessionModels } from "acpx/runtime";
import {
  ACPX_MODEL_INSPECT_TIMEOUT_MS,
  inspectAcpxModels,
  type AcpxModelInspectFn,
} from "../../../src/transport/acpx-model-inspector";

const INPUT = { agentCommand: ["mock-agent", "--acp"], cwd: "/tmp/probe-cwd" };

function stub(result: AcpRuntimeSessionModels | undefined): { fn: AcpxModelInspectFn; seen: Array<Record<string, unknown>> } {
  const seen: Array<Record<string, unknown>> = [];
  return {
    seen,
    fn: async (options) => {
      seen.push({ ...options });
      return result;
    },
  };
}

test("maps undefined to unsupported", async () => {
  const { fn } = stub(undefined);
  const result = await inspectAcpxModels(INPUT, { inspectAgentModels: fn });
  expect(result).toEqual({
    ok: false,
    failure: "unsupported",
    message: "the adapter started but did not advertise any models",
  });
});

test("maps an explicit empty directory to ok:true with no models", async () => {
  const { fn } = stub({ availableModelIds: [], availableModels: [] });
  const result = await inspectAcpxModels(INPUT, { inspectAgentModels: fn });
  expect(result).toEqual({ ok: true, models: [], efforts: [] });
});

test("maps a non-empty directory to ready models with effort unknown", async () => {
  const { fn } = stub({
    currentModelId: "opus",
    availableModelIds: ["opus", "sonnet"],
    availableModels: [
      { modelId: "opus", name: "Opus" },
      { modelId: "  sonnet  ", name: "  " },
    ],
  });
  const result = await inspectAcpxModels(INPUT, { inspectAgentModels: fn });
  expect(result).toEqual({
    ok: true,
    models: [
      { modelId: "opus", name: "Opus" },
      { modelId: "sonnet", name: "sonnet" },
    ],
    currentModelId: "opus",
    efforts: [],
  });
});

test("falls back to model ids when display names are absent", async () => {
  const { fn } = stub({ availableModelIds: ["a"], currentModelId: " " });
  const result = await inspectAcpxModels(INPUT, { inspectAgentModels: fn });
  expect(result).toEqual({ ok: true, models: [{ modelId: "a", name: "a" }], efforts: [] });
});

test("treats an all-unparseable advertisement as transport, not empty", async () => {
  const { fn } = stub({
    availableModelIds: ["a"],
    availableModels: [{ modelId: "  ", name: "" }],
  });
  const result = await inspectAcpxModels(INPUT, { inspectAgentModels: fn });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.failure).toBe("transport");
});

test("maps a spawn failure to transport", async () => {
  const fn: AcpxModelInspectFn = async () => {
    throw new Error("spawn mock-agent ENOENT");
  };
  const result = await inspectAcpxModels(INPUT, { inspectAgentModels: fn });
  expect(result).toEqual({ ok: false, failure: "transport", message: "spawn mock-agent ENOENT" });
});

test("maps authentication failures to unauthenticated", async () => {
  const fn: AcpxModelInspectFn = async () => {
    throw new Error("AUTH_REQUIRED: login required");
  };
  const result = await inspectAcpxModels(INPUT, { inspectAgentModels: fn });
  expect(result).toEqual({
    ok: false,
    failure: "unauthenticated",
    message: "the adapter requires authentication before it can list models",
  });
});

test("maps deadline expiry to timeout and defaults the budget to 75s", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const timeout = new Error("deadline");
  timeout.name = "TimeoutError";
  const fn: AcpxModelInspectFn = async (options) => {
    seen.push({ ...options });
    throw timeout;
  };
  const result = await inspectAcpxModels(INPUT, { inspectAgentModels: fn });
  expect(result).toEqual({
    ok: false,
    failure: "timeout",
    message: "the model inspection timed out before the adapter advertised models",
  });
  expect(seen[0]?.["timeoutMs"]).toBe(75_000);
  expect(seen[0]?.["timeoutMs"]).toBe(ACPX_MODEL_INSPECT_TIMEOUT_MS);
});

test("passes the caller signal and env through, mapping caller abort to a typed failure", async () => {
  const controller = new AbortController();
  controller.abort();
  let observed: Record<string, unknown> = {};
  const fn: AcpxModelInspectFn = async (options) => {
    observed = { ...options };
    options.signal?.throwIfAborted();
    return undefined;
  };
  const result = await inspectAcpxModels(
    { ...INPUT, agentProcessEnv: { TOKEN: "x" }, signal: controller.signal, timeoutMs: 1_000 },
    { inspectAgentModels: fn },
  );
  expect(observed["signal"]).toBe(controller.signal);
  expect(observed["agentProcessEnv"]).toEqual({ TOKEN: "x" });
  expect(observed["timeoutMs"]).toBe(1_000);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.failure).toBe("transport");
    expect(result.message).toMatch(/abort/i);
  }
});

test("logs carry the digest prefix only, never argv or env", async () => {
  const lines: string[] = [];
  const { fn } = stub(undefined);
  await inspectAcpxModels(
    { agentCommand: ["secret-agent", "--token", "hunter2"], cwd: "/tmp/probe-cwd", agentProcessEnv: { KEY: "hunter2" } },
    { inspectAgentModels: fn, log: (line) => lines.push(line) },
  );
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^acpx-model-inspector [0-9a-f]{8} unsupported$/);
  expect(lines[0]).not.toContain("secret-agent");
  expect(lines[0]).not.toContain("hunter2");
});
