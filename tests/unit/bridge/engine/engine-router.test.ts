import { expect, test } from "bun:test";

import {
  EngineMismatchError,
  EngineRouter,
  EngineUnsupportedError,
} from "../../../../src/bridge/engine/engine-router";
import { SessionEngineBinding } from "../../../../src/bridge/engine/session-engine-binding";
import type { BridgeEngine, EngineSessionInput } from "../../../../src/bridge/engine/bridge-engine";

const sessionInput: EngineSessionInput = {
  agent: "codex",
  cwd: "/repo",
  name: "demo",
};

function stubEngine(kind: "cli" | "runtime", log: string[]): BridgeEngine {
  return {
    kind,
    async hasSession(input) {
      log.push(`${kind}:hasSession:${input.name}`);
      return { exists: false };
    },
    async tailSessionHistory() {
      throw new Error("not implemented");
    },
    async listAgentSessions() {
      return undefined;
    },
    async ensureSession() {
      throw new Error("not implemented");
    },
    async resumeAgentSession() {
      throw new Error("not implemented");
    },
    async prompt() {
      throw new Error("not implemented");
    },
    async injectMessage() {
      throw new Error("not implemented");
    },
    async setMode() {
      throw new Error("not implemented");
    },
    async setModel() {
      throw new Error("not implemented");
    },
    async getSessionModel() {
      throw new Error("not implemented");
    },
    async setSessionEffort() {
      throw new Error("not implemented");
    },
    async getSessionEffort() {
      throw new Error("not implemented");
    },
    async cancel() {
      throw new Error("not implemented");
    },
    async removeSession() {
      throw new Error("not implemented");
    },
    async deleteSession() {
      throw new Error("not implemented");
    },
    async isSessionWarm(input) {
      log.push(`${kind}:isSessionWarm:${input.name}`);
      return { warm: false };
    },
    async getAgentSessionId() {
      throw new Error("not implemented");
    },
    async updatePermissionPolicy() {
      log.push(`${kind}:updatePermissionPolicy`);
      return {};
    },
    async shutdown() {
      log.push(`${kind}:shutdown`);
      return {};
    },
  };
}

test("session-scoped calls route to cli by default and cache affinity per session key", async () => {
  const log: string[] = [];
  const router = new EngineRouter(new SessionEngineBinding(), stubEngine("cli", log));
  await router.hasSession({ ...sessionInput, sessionKey: "s1" });
  await router.hasSession({ ...sessionInput, sessionKey: "s1" });
  expect(log).toEqual(["cli:hasSession:demo", "cli:hasSession:demo"]);
});


test("runtime-bound session routes to the runtime engine stub", async () => {
  const log: string[] = [];
  const binding = new SessionEngineBinding();
  binding.setBinding("rt", "runtime");
  const runtime = stubEngine("runtime", log);
  let warmCalls = 0;
  runtime.isSessionWarm = async (input) => {
    log.push(`runtime:isSessionWarm:${input.name}`);
    warmCalls += 1;
    return { warm: true };
  };
  const router = new EngineRouter(binding, stubEngine("cli", log), runtime);
  const result = await router.isSessionWarm({ ...sessionInput, sessionKey: "rt" });
  expect(result).toEqual({ warm: true });
  expect(log).toEqual(["runtime:isSessionWarm:demo"]);
});

test("runtime-bound session without a runtime engine fails closed with RUNTIME_ENGINE_UNSUPPORTED", async () => {
  const binding = new SessionEngineBinding();
  binding.setBinding("rt2", "runtime");
  const router = new EngineRouter(binding, stubEngine("cli", []));
  let caught: unknown;
  try {
    router.isSessionWarm({ ...sessionInput, sessionKey: "rt2" });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(EngineUnsupportedError);
  expect((caught as EngineUnsupportedError).code).toBe("RUNTIME_ENGINE_UNSUPPORTED");
});

test("declared engine conflicting with cached binding is rejected, never silently re-routed", async () => {
  const binding = new SessionEngineBinding();
  const cli = stubEngine("cli", []);
  const runtime = stubEngine("runtime", []);
  const router = new EngineRouter(binding, cli, runtime);
  // Read-only preflight never binds: a transient attach LID must not pin affinity.
  await router.hasSession({ ...sessionInput, sessionKey: "s9" });
  expect(binding.hasExplicit("s9")).toBe(false);
  // First state-changing touch with no declared engine binds cli...
  await router.isSessionWarm({ ...sessionInput, sessionKey: "s9" });
  expect(binding.hasExplicit("s9")).toBe(true);
  // ...and a Wave-B declared mismatch is rejected once the binding exists.
  let caught: unknown;
  try {
    router.isSessionWarm({ ...sessionInput, sessionKey: "s9", transportEngine: "runtime" } as never);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(EngineMismatchError);
});

test("listAgentSessions is agent-level discovery and always served by cli", async () => {
  const log: string[] = [];
  const binding = new SessionEngineBinding();
  const router = new EngineRouter(binding, stubEngine("cli", log), stubEngine("runtime", log));
  await router.listAgentSessions({
    agent: "codex",
    cwd: "/repo",
    filterCwd: "/repo",
  });
  expect(log).toEqual([]);
});

test("updatePermissionPolicy fans out to the cli engine", async () => {
  const log: string[] = [];
  const binding = new SessionEngineBinding();
  const router = new EngineRouter(binding, stubEngine("cli", log));
  await router.updatePermissionPolicy({
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
  });
  expect(log).toEqual(["cli:updatePermissionPolicy"]);
});

test("shutdown attempts both engines and propagates errors when any engine fails", async () => {
  const log: string[] = [];
  const cli = stubEngine("cli", log);
  const runtime = stubEngine("runtime", log);
  runtime.shutdown = async () => {
    log.push("runtime:shutdown-fail");
    throw new Error("worker tree cleanup error (simulated)");
  };
  const router = new EngineRouter(new SessionEngineBinding(), cli, runtime);

  // Router shutdown must attempt CLI cleanup even when Runtime fails, and then propagate the error
  await expect(router.shutdown()).rejects.toThrow(/engine shutdown failed.*worker tree cleanup error/);

  expect(log).toContain("cli:shutdown");
  expect(log).toContain("runtime:shutdown-fail");
});

test("successful hard delete evicts the cached affinity; preflight mismatch on a bound key still rejects", async () => {
  const log: string[] = [];
  const binding = new SessionEngineBinding();
  const cli = stubEngine("cli", log);
  const runtime = stubEngine("runtime", log);
  cli.deleteSession = async () => {
    log.push("cli:deleteSession");
    return {};
  };
  const router = new EngineRouter(binding, cli, runtime);
  // Authoritative delete binds first (via routing), then evicts on success.
  await router.deleteSession({ ...sessionInput, sessionKey: "gone" });
  expect(binding.hasExplicit("gone")).toBe(false);
  expect(log).toEqual(["cli:deleteSession"]);
  // A bound key keeps mismatch protection on every path, including preflight.
  binding.setBinding("kept", "cli");
  let caught: unknown;
  try {
    await router.hasSession({ ...sessionInput, sessionKey: "kept", transportEngine: "runtime" } as never);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(EngineMismatchError);
});

test("releaseLogicalSession evicts affinity only on success", async () => {
  const binding = new SessionEngineBinding();
  const cli = stubEngine("cli", []);
  const runtime = stubEngine("runtime", []);
  const router = new EngineRouter(binding, cli, runtime);
  // Retired LIDs never run again (/clear retire, non-last shared remove):
  // success drops the entry so repeated resets stop growing the map.
  binding.setBinding("old-lid", "cli");
  await router.releaseLogicalSession({ ...sessionInput, sessionKey: "x", logicalSessionId: "old-lid" });
  expect(binding.hasExplicit("old-lid")).toBe(false);
  // Failure keeps the entry so the retry still routes to the same engine.
  binding.setBinding("old-lid-2", "cli");
  cli.releaseLogicalSession = async () => {
    throw new Error("release boom");
  };
  await expect(
    router.releaseLogicalSession({ ...sessionInput, sessionKey: "y", logicalSessionId: "old-lid-2" }),
  ).rejects.toThrow("release boom");
  expect(binding.hasExplicit("old-lid-2")).toBe(true);
});
function sessionKeyInput(key: string): EngineSessionInput {
  return { ...sessionInput, sessionKey: key };
}
