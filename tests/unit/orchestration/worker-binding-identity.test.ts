import { expect, test } from "bun:test";

import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import {
  persistWorkerBindingIdentity,
  releaseWorkerOwnerSessions,
  stageWorkerBindingIdentity,
  stageWorkerBindingLaunch,
} from "../../../src/orchestration/worker-launch";
import type { AppState } from "../../../src/state/types";
import { createEmptyState } from "../../../src/state/types";

function stateWithBinding(binding: Record<string, unknown>) {
  const state = createEmptyState();
  state.orchestration.workerBindings["worker-1"] = binding as never;
  return state;
}

const input = { workerSession: "worker-1", targetAgent: "codex", workspace: "backend" };

test("missing binding stages nothing and touches nothing", () => {
  const state = createEmptyState();
  let calls = 0;
  const out = stageWorkerBindingIdentity(state, input, () => {
    calls += 1;
    return "cli";
  });
  expect(out).toEqual({ changed: false });
  expect(calls).toBe(0);
  expect(state.orchestration.workerBindings["worker-1"]).toBeUndefined();
});

test("complete binding stages nothing", () => {
  const state = stateWithBinding({ logicalSessionId: "lid-1", transportEngine: "cli" });
  let calls = 0;
  const out = stageWorkerBindingIdentity(state, input, () => {
    calls += 1;
    return "runtime";
  });
  expect(out).toEqual({ changed: false });
  expect(calls).toBe(0);
});

test("incomplete binding stages onto a clone and leaves live state untouched", () => {
  const state = stateWithBinding({ sourceHandle: "src-1" });
  const before = structuredClone(state);
  const out = stageWorkerBindingIdentity(state, input, () => "runtime");
  expect(out.changed).toBe(true);
  if (!out.changed) return;
  // Live state byte-for-byte unchanged (G11: a later saveNow failure cannot
  // leave a half-persisted affinity behind).
  expect(state).toEqual(before);
  expect(state.orchestration.workerBindings["worker-1"]).toEqual({ sourceHandle: "src-1" });
  // Clone carries fresh LID + resolved engine.
  const staged = out.nextState.orchestration.workerBindings["worker-1"]!;
  expect(typeof staged.logicalSessionId).toBe("string");
  expect(staged.logicalSessionId).not.toBe("");
  expect(staged.transportEngine).toBe("runtime");
  expect(staged.sourceHandle).toBe("src-1");
  // Simulate a saveNow failure: live is untouched, so a retry must re-stage
  // (changed:true) with a fresh identity — never reuse a half-persisted one.
  // ensure/transport calls happen only after a successful saveNow+publish.
  const retry = stageWorkerBindingIdentity(state, input, () => "runtime");
  expect(retry.changed).toBe(true);
  if (!retry.changed) return;
  expect(retry.nextState.orchestration.workerBindings["worker-1"]!.logicalSessionId).not.toBe(
    staged.logicalSessionId,
  );
  expect(state.orchestration.workerBindings["worker-1"]).toEqual({ sourceHandle: "src-1" });
});

test("strict-ineligible engine throws before any mutation", () => {
  const state = stateWithBinding({ sourceHandle: "src-1" });
  const before = structuredClone(state);
  expect(() =>
    stageWorkerBindingIdentity(state, input, () => {
      throw new Error('transport.engine = "runtime" is not eligible');
    }),
  ).toThrow(/not eligible/);
  expect(state).toEqual(before);
});

test("partial binding keeps existing LID and only resolves engine", () => {
  const state = stateWithBinding({ logicalSessionId: "lid-kept" });
  const out = stageWorkerBindingIdentity(state, input, () => "cli");
  expect(out.changed).toBe(true);
  if (!out.changed) return;
  expect(out.nextState.orchestration.workerBindings["worker-1"]!.logicalSessionId).toBe("lid-kept");
  expect(out.nextState.orchestration.workerBindings["worker-1"]!.transportEngine).toBe("cli");
  expect(state.orchestration.workerBindings["worker-1"]).toEqual({ logicalSessionId: "lid-kept" });
});

test("concurrent persists keep both bindings in memory and on disk", async () => {
  const state = createEmptyState();
  state.orchestration.workerBindings["worker-a"] = { sourceHandle: "src-a" } as never;
  state.orchestration.workerBindings["worker-b"] = { sourceHandle: "src-b" } as never;
  const mutex = new AsyncMutex();
  const saved: AppState[] = [];
  const gate = Promise.withResolvers<void>();
  const firstSaveEntered = Promise.withResolvers<void>();
  let saveCalls = 0;
  const publish = (next: AppState) => {
    Object.assign(state, structuredClone(next));
  };
  const deps = {
    resolveEngine: () => "runtime" as const,
    saveNow: async (next: AppState) => {
      saveCalls += 1;
      if (saveCalls === 1) {
        firstSaveEntered.resolve();
        await gate.promise;
      }
      saved.push(structuredClone(next));
    },
    publish,
    runExclusive: <T>(critical: () => Promise<T>) => mutex.run(critical),
  };
  const inputA = { workerSession: "worker-a", targetAgent: "codex", workspace: "backend" };
  const inputB = { workerSession: "worker-b", targetAgent: "codex", workspace: "backend" };
  // Overlap the two initializations: A stages and blocks inside its gated
  // durable save while B starts from the same pre-publish live state.
  const pendingA = persistWorkerBindingIdentity(state, inputA, deps);
  await firstSaveEntered.promise;
  const pendingB = persistWorkerBindingIdentity(state, inputB, deps);
  // Flush microtasks so B runs as far as the mutex lets it (with the fix:
  // queued behind A; without it: staged stale and already saved).
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(saveCalls).toBe(1);
  gate.resolve();
  await Promise.all([pendingA, pendingB]);
  // Both durable identities survive in live memory...
  const liveA = state.orchestration.workerBindings["worker-a"]!;
  const liveB = state.orchestration.workerBindings["worker-b"]!;
  expect(liveA.logicalSessionId).toBeTruthy();
  expect(liveA.transportEngine).toBe("runtime");
  expect(liveB.logicalSessionId).toBeTruthy();
  expect(liveB.transportEngine).toBe("runtime");
  // ...and the final durable snapshot carries both (a stale whole-state
  // write would have resurrected one binding as incomplete).
  const finalSaved = saved[saved.length - 1]!;
  expect(finalSaved.orchestration.workerBindings["worker-a"]).toMatchObject({
    logicalSessionId: liveA.logicalSessionId,
    transportEngine: "runtime",
  });
  expect(finalSaved.orchestration.workerBindings["worker-b"]).toMatchObject({
    logicalSessionId: liveB.logicalSessionId,
    transportEngine: "runtime",
  });
});

test("ordinary state mutation committed during a gated persist is not clobbered", async () => {
  const state = createEmptyState();
  state.orchestration.workerBindings["worker-1"] = { sourceHandle: "src-1" } as never;
  const mutex = new AsyncMutex();
  const saved: AppState[] = [];
  const gate = Promise.withResolvers<void>();
  const saveEntered = Promise.withResolvers<void>();
  let saveCalls = 0;
  const saveNow = async (next: AppState) => {
    saveCalls += 1;
    if (saveCalls === 1) {
      saveEntered.resolve();
      await gate.promise;
    }
    saved.push(structuredClone(next));
  };
  const publish = (next: AppState) => {
    Object.assign(state, structuredClone(next));
  };
  const runExclusive = <T>(critical: () => Promise<T>) => mutex.run(critical);
  const pending = persistWorkerBindingIdentity(
    state,
    { workerSession: "worker-1", targetAgent: "codex", workspace: "backend" },
    { resolveEngine: () => "runtime" as const, saveNow, publish, runExclusive },
  );
  await saveEntered.promise;
  // An ordinary SessionService-style mutation commits through the same
  // mutex while the binding persist is still inside its durable save. It
  // queues behind the persist and stages from post-identity state.
  const ordinary = mutex.run(async () => {
    const next = structuredClone(state);
    next.sessions["user-1"] = { alias: "user-1" } as never;
    await saveNow(next);
    publish(next);
  });
  gate.resolve();
  await Promise.all([pending, ordinary]);
  // The binding publish stages from post-user-1 state; a stale whole-state
  // write would have wiped the session row.
  expect(state.sessions["user-1"]).toMatchObject({ alias: "user-1" });
  expect(state.orchestration.workerBindings["worker-1"]!.logicalSessionId).toBeTruthy();
  const finalSaved = saved[saved.length - 1]!;
  expect(finalSaved.sessions["user-1"]).toMatchObject({ alias: "user-1" });
  expect(finalSaved.orchestration.workerBindings["worker-1"]!.logicalSessionId).toBe(
    state.orchestration.workerBindings["worker-1"]!.logicalSessionId,
  );
});

test("pass-through exclusivity documents the lost-update it permits", async () => {
  const state = createEmptyState();
  state.orchestration.workerBindings["worker-a"] = { sourceHandle: "src-a" } as never;
  state.orchestration.workerBindings["worker-b"] = { sourceHandle: "src-b" } as never;
  const gate = Promise.withResolvers<void>();
  const firstSaveEntered = Promise.withResolvers<void>();
  let saveCalls = 0;
  // No mutex: the stale stage + whole-state publish path the shared
  // transaction replaced. This must lose one binding's identity.
  const deps = {
    resolveEngine: () => "runtime" as const,
    saveNow: async (_next: AppState) => {
      saveCalls += 1;
      if (saveCalls === 1) {
        firstSaveEntered.resolve();
        await gate.promise;
      }
    },
    publish: (next: AppState) => {
      Object.assign(state, structuredClone(next));
    },
    runExclusive: <T>(critical: () => Promise<T>) => critical(),
  };
  const pendingA = persistWorkerBindingIdentity(
    state,
    { workerSession: "worker-a", targetAgent: "codex", workspace: "backend" },
    deps,
  );
  await firstSaveEntered.promise;
  await persistWorkerBindingIdentity(
    state,
    { workerSession: "worker-b", targetAgent: "codex", workspace: "backend" },
    deps,
  );
  // B staged from the pre-A snapshot and already saved it: the race fired.
  expect(saveCalls).toBe(2);
  gate.resolve();
  await pendingA;
  // A publishes last from its stale pre-B snapshot: B is resurrected as
  // incomplete. Production must never take this path.
  expect(state.orchestration.workerBindings["worker-b"]!.logicalSessionId).toBeUndefined();
  expect(state.orchestration.workerBindings["worker-a"]!.logicalSessionId).toBeTruthy();
});

test("launch snapshot stages on first dispatch and is a no-op when unchanged", () => {
  const launch = { agentCommand: "npx codex@1", acpxAgent: "xacpx-managed-codex-aaa" };
  const state = stateWithBinding({ sourceHandle: "src-1" });
  const before = structuredClone(state);
  const out = stageWorkerBindingLaunch(state, { workerSession: "worker-1" }, launch);
  expect(out.changed).toBe(true);
  if (!out.changed) return;
  expect(state).toEqual(before);
  const staged = out.nextState.orchestration.workerBindings["worker-1"]!;
  expect(staged.launchAgentCommand).toBe("npx codex@1");
  expect(staged.launchAcpxAgent).toBe("xacpx-managed-codex-aaa");
  // Steady-state redispatch resolves the same launch: no save.
  const again = stageWorkerBindingLaunch(out.nextState, { workerSession: "worker-1" }, launch);
  expect(again).toEqual({ changed: false });
});

test("launch snapshot refresh clears keys the new launch no longer carries", () => {
  const state = stateWithBinding({
    sourceHandle: "src-1",
    launchAgentCommand: "npx codex@1",
    launchAcpxAgent: "xacpx-managed-codex-aaa",
  });
  const out = stageWorkerBindingLaunch(state, { workerSession: "worker-1" }, {});
  expect(out.changed).toBe(true);
  if (!out.changed) return;
  const staged = out.nextState.orchestration.workerBindings["worker-1"]!;
  expect(staged.launchAgentCommand).toBeUndefined();
  expect(staged.launchAcpxAgent).toBeUndefined();
  expect(staged.sourceHandle).toBe("src-1");
});

test("launch snapshot stages nothing for a missing binding", () => {
  const out = stageWorkerBindingLaunch(createEmptyState(), { workerSession: "worker-1" }, { agentCommand: "x" });
  expect(out).toEqual({ changed: false });
});

test("release converges the current session plus a differing snapshot identity", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const current = {
    alias: "wk",
    agent: "codex",
    agentCommand: "npx codex@new",
    acpxAgent: "xacpx-managed-codex-new",
    cwd: "/tmp/backend",
    workspace: "backend",
    transportSession: "wk",
  };
  await releaseWorkerOwnerSessions(
    async (session) => { calls.push({ ...session }); },
    current,
    { launchAgentCommand: "npx codex@old", launchAcpxAgent: "xacpx-managed-codex-old" },
  );
  expect(calls).toHaveLength(2);
  expect(calls[0]?.agentCommand).toBe("npx codex@new");
  expect(calls[0]?.acpxAgent).toBe("xacpx-managed-codex-new");
  // Historical: command-only so the transport passes it as `--agent`.
  expect(calls[1]).toMatchObject({
    agent: "codex",
    agentCommand: "npx codex@old",
    cwd: "/tmp/backend",
    transportSession: "wk",
  });
  expect(calls[1]?.acpxAgent).toBeUndefined();
  expect(calls[1]?.rawCommand).toBeUndefined();
});

test("release skips the historical step when the snapshot matches or is absent", async () => {
  const current = {
    alias: "wk",
    agent: "codex",
    agentCommand: "npx codex@new",
    cwd: "/tmp/backend",
    workspace: "backend",
    transportSession: "wk",
  };
  const calls: unknown[] = [];
  await releaseWorkerOwnerSessions(async (session) => { calls.push(session); }, current, { launchAgentCommand: "npx codex@new" });
  await releaseWorkerOwnerSessions(async (session) => { calls.push(session); }, current, undefined);
  await releaseWorkerOwnerSessions(async (session) => { calls.push(session); }, current, {});
  expect(calls).toHaveLength(3);
});

test("release fails closed when the current converge step throws", async () => {
  const current = {
    alias: "wk",
    agent: "codex",
    agentCommand: "npx codex@new",
    cwd: "/tmp/backend",
    workspace: "backend",
    transportSession: "wk",
  };
  let calls = 0;
  await expect(
    releaseWorkerOwnerSessions(
      async () => { calls += 1; throw new Error("transport down"); },
      current,
      { launchAgentCommand: "npx codex@old" },
    ),
  ).rejects.toThrow("transport down");
  expect(calls).toBe(1);
});
