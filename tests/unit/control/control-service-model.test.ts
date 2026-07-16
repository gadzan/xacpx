import { expect, test } from "bun:test";
import { ControlService } from "../../../src/control/control-service";
import { CommandTimeoutError } from "../../../src/transport/command-timeouts";

const session = {
  alias: "internal-backend",
  agent: "codex",
  workspace: "w",
  transportSession: "t",
  cwd: "/c",
  model: "gpt-5.2[high]",
};

function makeDeps() {
  const calls: string[] = [];
  const logs: Array<{ event: string; message: string; context?: Record<string, unknown> }> = [];
  const deps = {
    sessions: {
      resolveAliasForChat: async (_chatKey: string, alias: string) => `internal-${alias}`,
      getSession: async (internalAlias: string) => (internalAlias === "internal-backend" ? session : null),
      setSessionModel: async (alias: string, id: string) => { calls.push(`persist:${alias}:${id}`); },
    },
    transport: {
      getSessionModel: async (s: typeof session) => ({ current: s.model, available: ["gpt-5.2[high]", "gpt-5.2[low]"] }),
      setModel: async (s: typeof session, id: string) => { calls.push(`transport:${s.alias}:${id}`); },
    },
    logger: {
      error: async (event: string, message: string, context?: Record<string, unknown>) => {
        logs.push({ event, message, context });
      },
    },
    events: { emit: () => {} },
  };
  return { deps, calls, logs };
}

test("getSessionModel returns current + available for a resolved session", async () => {
  const { deps } = makeDeps();
  const control = new ControlService(deps as never);
  const r = await control.getSessionModel("relay:acc", "backend");
  expect(r).toEqual({ current: "gpt-5.2[high]", available: ["gpt-5.2[high]", "gpt-5.2[low]"] });
});

test("getSessionModel returns an empty list when the session is not found", async () => {
  const { deps } = makeDeps();
  const control = new ControlService(deps as never);
  const r = await control.getSessionModel("relay:acc", "missing");
  expect(r).toEqual({ available: [] });
});

test("setSessionModel switches the transport model and persists by alias", async () => {
  const { deps, calls } = makeDeps();
  const control = new ControlService(deps as never);
  await expect(control.setSessionModel("relay:acc", "backend", "claude-opus-4-8")).resolves.toEqual({
    current: "claude-opus-4-8",
    applied: true,
  });
  expect(calls).toEqual(["transport:internal-backend:claude-opus-4-8", "persist:internal-backend:claude-opus-4-8"]);
});

test("setSessionModel reconciles a timed-out switch that acpx actually applied", async () => {
  const { deps, calls, logs } = makeDeps();
  deps.transport.setModel = async () => {
    calls.push("transport:internal-backend:claude-opus-4-8");
    throw new CommandTimeoutError(30_000, "acpx set model", { stage: "set-model" });
  };
  deps.transport.getSessionModel = async () => {
    calls.push("query:internal-backend");
    return { current: "claude-opus-4-8", available: ["claude-opus-4-8"] };
  };
  const control = new ControlService(deps as never);

  await expect(control.setSessionModel("relay:acc", "backend", "claude-opus-4-8")).resolves.toEqual({
    current: "claude-opus-4-8",
    applied: true,
  });
  expect(calls).toEqual([
    "transport:internal-backend:claude-opus-4-8",
    "query:internal-backend",
    "persist:internal-backend:claude-opus-4-8",
  ]);
  expect(logs).toEqual([{
    event: "control.session.model.timeout_reconciled",
    message: "Model switch timed out; adopted authoritative transport state",
    context: {
      sessionAlias: "internal-backend",
      requestedModel: "claude-opus-4-8",
      observedModel: "claude-opus-4-8",
      timeout: "acpx command timed out during set-model after 30s: acpx set model",
    },
  }]);
});

test("setSessionModel adopts the authoritative model when a timed-out switch produced a third value", async () => {
  const { deps, calls } = makeDeps();
  deps.transport.setModel = async () => {
    throw new CommandTimeoutError(30_000, "acpx set model", { stage: "set-model" });
  };
  deps.transport.getSessionModel = async () => ({
    current: "provider/fallback-model",
    available: ["gpt-5.2[high]", "claude-opus-4-8", "provider/fallback-model"],
  });
  const control = new ControlService(deps as never);

  await expect(control.setSessionModel("relay:acc", "backend", "claude-opus-4-8")).resolves.toEqual({
    current: "provider/fallback-model",
    applied: false,
  });
  expect(calls).toEqual(["persist:internal-backend:provider/fallback-model"]);
});

test("setSessionModel serializes timeout reconciliation with a newer switch for the same session", async () => {
  const { deps, calls } = makeDeps();
  let resolveObserved!: (value: { current?: string; available: string[] }) => void;
  let markQueryStarted!: () => void;
  const queryStarted = new Promise<void>((resolve) => { markQueryStarted = resolve; });
  deps.transport.setModel = async (s: typeof session, id: string) => {
    calls.push(`transport:${s.alias}:${id}`);
    if (id === "model-b") {
      throw new CommandTimeoutError(30_000, "acpx set model", { stage: "set-model" });
    }
  };
  deps.transport.getSessionModel = async () => {
    calls.push("query:internal-backend");
    markQueryStarted();
    return await new Promise((resolve) => { resolveObserved = resolve; });
  };
  const control = new ControlService(deps as never);

  const first = control.setSessionModel("relay:acc", "backend", "model-b");
  await queryStarted;
  const second = control.setSessionModel("relay:acc", "backend", "model-c");
  for (let i = 0; i < 10; i += 1) await Promise.resolve();

  expect(calls).toEqual([
    "transport:internal-backend:model-b",
    "query:internal-backend",
  ]);

  resolveObserved({ current: "model-b", available: ["model-b", "model-c"] });
  await expect(first).resolves.toEqual({ current: "model-b", applied: true });
  await expect(second).resolves.toEqual({ current: "model-c", applied: true });
  expect(calls).toEqual([
    "transport:internal-backend:model-b",
    "query:internal-backend",
    "persist:internal-backend:model-b",
    "transport:internal-backend:model-c",
    "persist:internal-backend:model-c",
  ]);
});

test("setSessionModel does not reconcile unrelated provider errors that merely mention a timeout", async () => {
  const { deps, calls, logs } = makeDeps();
  deps.transport.setModel = async () => {
    throw new Error("provider request timed out while validating credentials");
  };
  deps.transport.getSessionModel = async () => {
    calls.push("query");
    return { current: "provider/fallback-model", available: [] };
  };
  const control = new ControlService(deps as never);

  await expect(control.setSessionModel("relay:acc", "backend", "claude-opus-4-8")).rejects.toThrow(
    "provider request timed out",
  );
  expect(calls).toEqual([]);
  expect(logs).toEqual([]);
});

test("setSessionModel throws when the transport cannot switch models", async () => {
  const { deps } = makeDeps();
  (deps.transport as { setModel?: unknown }).setModel = undefined;
  const control = new ControlService(deps as never);
  await expect(control.setSessionModel("relay:acc", "backend", "x")).rejects.toThrow("does not support");
});

test("getSessionModel falls back to the resolved model when the transport can't query", async () => {
  const { deps } = makeDeps();
  (deps.transport as { getSessionModel?: unknown }).getSessionModel = undefined;
  const control = new ControlService(deps as never);
  const r = await control.getSessionModel("relay:acc", "backend");
  expect(r).toEqual({ current: "gpt-5.2[high]", available: [] });
});
