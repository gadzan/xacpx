import { expect, test } from "bun:test";
import { ControlService } from "../../../src/control/control-service";

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
    events: { emit: () => {} },
  };
  return { deps, calls };
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
  await control.setSessionModel("relay:acc", "backend", "claude-opus-4-8");
  expect(calls).toEqual(["transport:internal-backend:claude-opus-4-8", "persist:internal-backend:claude-opus-4-8"]);
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
