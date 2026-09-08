import { expect, test } from "bun:test";

import {
  RuntimeAgentLeaseStore,
  createAgentLifecycleHooks,
  hashAgentArgv,
  type AgentLaunchInfo,
} from "../../../../../src/bridge/engine/runtime/runtime-agent-lease";

/**
 * Plan B2 gate: direct-agent launch lease at the real spawn boundary.
 * Awaited admission (beforeSpawn/spawned) fails closed; failure/exit hooks
 * are best-effort and never fabricate evidence.
 */
const GEN = "worker-gen-1";

function launch(overrides: Partial<AgentLaunchInfo> = {}): AgentLaunchInfo {
  return {
    launchId: "launch-1",
    scope: { kind: "runtime-session", sessionKey: "sess-a" },
    command: "codex",
    args: ["--acp"],
    cwd: "/repo",
    ...overrides,
  };
}

test("beforeSpawn persists a pending lease without raw argv or paths", async () => {
  const store = new RuntimeAgentLeaseStore(GEN);
  const persisted: unknown[] = [];
  const hooks = createAgentLifecycleHooks({ generation: () => GEN, store, persist: (r) => { persisted.push(r); } });
  await hooks.onBeforeSpawn!(launch());
  const record = store.get("launch-1");
  expect(record?.phase).toBe("pending");
  expect(record?.scope).toBe("runtime-session");
  expect(record?.sessionKey).toBe("sess-a");
  expect(record?.argvHash).toBe(hashAgentArgv("codex", ["--acp"]));
  expect(JSON.stringify(record)).not.toContain("--acp");
  expect(JSON.stringify(record)).not.toContain("/repo");
  expect(persisted.length).toBe(1);
});

test("probe scope records the agent, never a session", async () => {
  const store = new RuntimeAgentLeaseStore(GEN);
  const hooks = createAgentLifecycleHooks({ generation: () => GEN, store });
  await hooks.onBeforeSpawn!(launch({ launchId: "probe-1", scope: { kind: "runtime-probe", agent: "codex" } }));
  const record = store.get("probe-1");
  expect(record?.scope).toBe("runtime-probe");
  expect(record?.agent).toBe("codex");
  expect(record?.sessionKey).toBeUndefined();
});

test("persist rejection fails admission closed", async () => {
  const store = new RuntimeAgentLeaseStore(GEN);
  const hooks = createAgentLifecycleHooks({
    generation: () => GEN,
    store,
    persist: () => {
      throw new Error("durable write failed");
    },
  });
  await expect(hooks.onBeforeSpawn!(launch())).rejects.toThrow("durable write failed");
  await expect(
    hooks.onSpawned!({ ...launch(), pid: 4242, startedAt: "2026-09-08T00:00:00.000Z" }),
  ).rejects.toThrow("durable write failed");
});

test("admission timeout fails closed instead of hanging startup", async () => {
  const store = new RuntimeAgentLeaseStore(GEN);
  const hooks = createAgentLifecycleHooks({
    generation: () => GEN,
    store,
    persist: () => new Promise<void>(() => {}),
    admissionTimeoutMs: 20,
  });
  await expect(hooks.onBeforeSpawn!(launch())).rejects.toThrow("timed out");
});

test("spawned CAS: exit during admission wins over the late running write", async () => {
  const store = new RuntimeAgentLeaseStore(GEN);
  store.markPending(GEN, launch());
  expect(
    store.markExited(GEN, {
      ...launch(),
      pid: 111,
      startedAt: "2026-09-08T00:00:00.000Z",
      exitCode: 1,
      signal: null,
      exitedAt: "2026-09-08T00:00:01.000Z",
    }),
  ).toBe(true);
  // Late running write must not cover the exit.
  expect(store.markRunning(GEN, { ...launch(), pid: 111, startedAt: "2026-09-08T00:00:00.000Z" })).toBe(false);
  expect(store.get("launch-1")?.phase).toBe("exited");
});

test("unknown launchIds fabricate nothing (terminal children have no lease)", async () => {
  const store = new RuntimeAgentLeaseStore(GEN);
  const hooks = createAgentLifecycleHooks({ generation: () => GEN, store });
  // A TerminalManager child exit arrives without any admitted launch.
  await hooks.onExit!({
    launchId: "terminal-not-an-agent",
    scope: { kind: "client" },
    command: "sh",
    args: [],
    cwd: "/repo",
    pid: 99999,
    startedAt: "2026-09-08T00:00:00.000Z",
    exitCode: 0,
    signal: null,
    exitedAt: "2026-09-08T00:00:01.000Z",
  });
  await hooks.onSpawnFailed!({ ...launch({ launchId: "also-unknown" }), failedAt: "2026-09-08T00:00:01.000Z" });
  expect(store.list()).toEqual([]);
});

test("stale generations cannot write a successor lease", () => {
  const store = new RuntimeAgentLeaseStore(GEN);
  expect(() => store.markPending("worker-gen-2", launch())).toThrow("stale worker generation");
  store.markPending(GEN, launch());
  expect(() => store.markRunning("worker-gen-2", { ...launch(), pid: 1, startedAt: "x" })).toThrow(
    "stale worker generation",
  );
  expect(store.get("launch-1")?.phase).toBe("pending");
});

test("best-effort hooks never reject the observed outcome", async () => {
  const store = new RuntimeAgentLeaseStore(GEN);
  const hooks = createAgentLifecycleHooks({
    generation: () => GEN,
    store,
    persist: () => {
      throw new Error("durable write failed");
    },
  });
  // Known records so the terminal marks land and persist throws: both hooks
  // must still settle (admission already happened — nothing to fail closed).
  store.markPending(GEN, launch());
  store.markPending(GEN, launch({ launchId: "l2" }));
  await hooks.onExit!({
    ...launch(),
    pid: 1,
    startedAt: "x",
    exitCode: 0,
    signal: null,
    exitedAt: "y",
  });
  await hooks.onSpawnFailed!({ ...launch({ launchId: "l2" }), failedAt: "y" });
  expect(store.get("launch-1")?.phase).toBe("exited");
  expect(store.get("l2")?.phase).toBe("spawn-failed");
});
