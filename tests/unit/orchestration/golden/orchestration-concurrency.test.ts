// tests/unit/orchestration/golden/orchestration-concurrency.test.ts
// Pins the concurrency behaviour of OrchestrationService. The 185-test oracle drives the
// service sequentially, so none of this is covered there — yet Task 8 (mutex extraction)
// and Task 9 (pending-* map relocation) are exactly the changes that can break it.
//
// Technique: deps.loadState / deps.saveState are the only yield points inside a critical
// section (`mutate()`, backed by `AsyncMutex.run` in src/orchestration/async-mutex.ts —
// a promise-chain mutex, not a real lock). Gating them on a deferred promise turns a race
// into a deterministic interleaving.
//
// Deviation from the task-6 brief's example code for test 1 (recorded here, not silently
// "fixed prettier"): direct measurement showed a SINGLE, uncontested, non-parallel
// requestDelegate call already performs TWO loadState calls before its ONE saveState call.
// `reserveProposedWorkerSession`'s own mutate() (orchestration-service.ts:3107-3113) loads
// state but never saves it — it only touches the in-memory `pendingWorkerSessions` map —
// and the later persist-mutate (:644-707) does the real load+save. So even a single,
// fully-serialized delegation's trace already reads "load load save"; two SEQUENTIAL
// (fully-awaited, non-overlapping) delegations produce "load load save load load save",
// which trivially contains "load load save" twice. The brief's proposed
// `expect(trace.join(" ")).not.toContain("load load save")` is therefore a false-positive
// detector: it would fail on provably-correct, non-overlapping behaviour, because
// substring matching on the merged trace cannot distinguish "one delegation's own two
// mutate() sections" from "two delegations' critical sections unsafely overlapping".
// Test 1 below instead asserts directly on what mutual exclusion actually guarantees:
// while delegation A's first mutate() is gated open (holding the mutex), delegation B's
// own mutate() must not have run its loadState yet, no matter how many event-loop turns
// elapse waiting for it to.
import { expect, test } from "bun:test";

import { createConfig } from "../../commands/command-router-test-support";
import { OrchestrationService } from "../../../../src/orchestration/orchestration-service";
import { createEmptyState } from "../../../../src/state/types";
import { makeGoldenHarness } from "./golden-harness";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const cappedConfig = {
  ...createConfig(),
  orchestration: { ...createConfig().orchestration, maxParallelTasksPerAgent: 1 },
};

test("concurrency: the state mutex serializes two overlapping delegations", async () => {
  // Different targetAgent (claude vs codex) so the two delegations resolve to different
  // worker-session names and don't collide on assertWorkerSessionAvailable — that
  // collision is a separate, already-characterized business rule (see the golden human
  // path fixtures) and is not what this test pins.
  const harness = makeGoldenHarness({ ids: ["task-1", "task-2"] });
  let firstLoadGated = false;
  let loadCountWhileGated = 0;
  const gate = deferred<void>();

  const baseLoad = harness.deps.loadState;
  harness.deps.loadState = async () => {
    loadCountWhileGated += 1;
    if (!firstLoadGated) {
      firstLoadGated = true;
      await gate.promise;
    }
    return await baseLoad();
  };

  const service = new OrchestrationService(harness.deps);
  const a = service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "first",
  });
  const b = service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
    task: "second",
  });

  // Churn the event loop well past the point where B would have reached its own
  // reserveProposedWorkerSession mutate() call if nothing were blocking it (measured:
  // 2-3 ticks is enough; 20 leaves a wide margin with no timing-dependent false pass).
  // A's first mutate() is gated open the whole time, holding the mutex — if the mutex
  // were lost, B's loadState would fire during this window and the count below would be 2.
  for (let i = 0; i < 20; i += 1) {
    await Bun.sleep(0);
  }
  expect(loadCountWhileGated).toBe(1);

  gate.resolve();
  await Promise.all([a, b]);

  const state = harness.getState();
  expect(state.orchestration.tasks["task-1"]?.status).toBe("running");
  expect(state.orchestration.tasks["task-2"]?.status).toBe("running");
});

test("concurrency: two parallel delegations at cap 1 dispatch exactly one and queue the other", async () => {
  // The parallel gate reads capacity in one mutate() and persists `running` in another.
  // pendingParallelStarts (orchestration-service.ts:330-337) exists to close that window.
  // Drive both delegations concurrently and assert exactly one dispatches while the other
  // queues — not sequentially, like the existing golden "at parallel capacity" fixture.
  const harness = makeGoldenHarness({
    ids: ["task-1", "task-1-slot", "task-2", "task-2-slot"],
    config: cappedConfig,
  });
  const service = new OrchestrationService(harness.deps);

  await Promise.all([
    service.requestDelegate({
      sourceHandle: "wx:user-1",
      sourceKind: "human",
      coordinatorSession: "backend:main",
      workspace: "backend",
      targetAgent: "claude",
      task: "first",
      parallel: true,
    }),
    service.requestDelegate({
      sourceHandle: "wx:user-1",
      sourceKind: "human",
      coordinatorSession: "backend:main",
      workspace: "backend",
      targetAgent: "claude",
      task: "second",
      parallel: true,
    }),
  ]);

  const state = harness.getState();
  const statuses = Object.values(state.orchestration.tasks).map((t) => t.status).sort();
  const dispatches = harness.calls.filter((c) => c.port === "dispatchWorkerTask").length;

  // Whatever the real capacity is, dispatch count must equal the number of running tasks,
  // and both tasks must exist (one running, one queued) — never both running, never both
  // queued.
  expect(statuses).toEqual(["queued", "running"]);
  expect(dispatches).toBe(statuses.filter((s) => s === "running").length);
});

test("concurrency: two parallel needs_confirmation tasks approved at cap 1 dispatch exactly one", async () => {
  // approveTask's parallel gate reads capacity in one mutate() and persists `running` in a
  // later one, exactly like the two delegation paths — but unlike them it never called
  // claimParallelStart. countActiveParallelSlots counts tasks persisted as running/blocked/
  // waiting_for_human, PLUS pendingParallelStarts. Between the gate mutate's exit and the
  // persist mutate, an approving task belongs to neither set, so a second concurrent
  // approve saw a free slot that was already spoken for and both dispatched.
  //
  // Worker-sourced parallel tasks are the only ones that reach here: rpc-delegation-service
  // gates only `input.parallel && autoRun`, and autoRun is false for worker-sourced requests
  // (hence `needs_confirmation`), so their gate is deferred to approveTask.
  const harness = makeGoldenHarness({
    ids: ["task-1", "task-1-slot", "task-2", "task-2-slot"],
    config: {
      ...cappedConfig,
      orchestration: { ...cappedConfig.orchestration, allowWorkerChainedRequests: true },
    },
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        workerBindings: {
          "backend:claude:backend:main": {
            sourceHandle: "backend:claude:backend:main",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  for (const task of ["first", "second"]) {
    await service.requestDelegateFromRpc({
      sourceHandle: "backend:claude:backend:main",
      targetAgent: "codex",
      role: "reviewer",
      task,
      parallel: true,
    });
  }
  expect(
    Object.values(harness.getState().orchestration.tasks).map((t) => t.status).sort(),
  ).toEqual(["needs_confirmation", "needs_confirmation"]);

  // Approve both concurrently. Sequentially this already works: the first is persisted
  // `running` before the second's gate reads capacity.
  const results = await Promise.allSettled([
    service.approveTask({ coordinatorSession: "backend:main", taskId: "task-1" }),
    service.approveTask({ coordinatorSession: "backend:main", taskId: "task-2" }),
  ]);

  const state = harness.getState();
  const running = Object.values(state.orchestration.tasks).filter((t) => t.status === "running");
  const dispatches = harness.calls.filter((call) => call.port === "dispatchWorkerTask").length;

  expect(running.length).toBeLessThanOrEqual(cappedConfig.orchestration.maxParallelTasksPerAgent);
  expect(dispatches).toBe(running.length);
  // The loser must be parked, not lost: `queued` (gate saw the slot taken) is the intended
  // outcome. A rejection would also cap the agent, but it would drop the task, so assert on
  // the status rather than merely on the dispatch count.
  expect(Object.values(state.orchestration.tasks).map((t) => t.status).sort()).toEqual([
    "queued",
    "running",
  ]);
  expect(results.every((r) => r.status === "fulfilled")).toBe(true);
});

/** Two worker-chained parallel tasks, both `needs_confirmation`, ready to approve. */
async function makeTwoPendingParallelApprovals(maxParallelTasksPerAgent = 1) {
  const empty = createEmptyState();
  const harness = makeGoldenHarness({
    ids: ["task-1", "task-1-slot", "task-2", "task-2-slot"],
    config: {
      ...cappedConfig,
      orchestration: {
        ...cappedConfig.orchestration,
        allowWorkerChainedRequests: true,
        maxParallelTasksPerAgent,
      },
    },
    initialState: {
      ...empty,
      orchestration: {
        ...empty.orchestration,
        workerBindings: {
          "backend:claude:backend:main": {
            sourceHandle: "backend:claude:backend:main",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);
  for (const task of ["first", "second"]) {
    await service.requestDelegateFromRpc({
      sourceHandle: "backend:claude:backend:main",
      targetAgent: "codex",
      role: "reviewer",
      task,
      parallel: true,
    });
  }
  return { harness, service };
}

test("approveTask releases its parallel slot when the worker-session reservation fails", async () => {
  // `reserveProposedWorkerSession` runs after the gate has claimed the slot and outside the
  // try/catch that guards the rest. A leak here is silent and permanent: the agent's
  // capacity shrinks by one for the lifetime of the process, and nothing in state shows it.
  //
  // Make the reservation throw by parking a running task on task-1's ephemeral worker-session
  // name. It belongs to a DIFFERENT agent, so it does not consume codex's parallel capacity —
  // countActiveParallelSlots keys on targetAgent + ephemeralWorkerSession, while
  // hasActiveTaskWorkerSession keys on the session name alone. Injected after both tasks
  // exist: requestDelegateFromRpc reserves the proposed session at creation time, so seeding
  // this into the harness's initial state would make task creation throw instead.
  const { harness, service } = await makeTwoPendingParallelApprovals();
  const state = harness.getState();
  const task1WorkerSession = state.orchestration.tasks["task-1"]!.workerSession!;
  state.orchestration.tasks["blocker"] = {
    taskId: "blocker",
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workerSession: task1WorkerSession,
    workspace: "backend",
    targetAgent: "claude",
    task: "holds the session name",
    status: "running",
    summary: "",
    resultText: "",
    createdAt: "2026-04-13T10:00:00.000Z",
    updatedAt: "2026-04-13T10:00:00.000Z",
    eventSeq: 0,
    events: [],
  } as never;
  await harness.deps.saveState(state);

  await expect(
    service.approveTask({ coordinatorSession: "backend:main", taskId: "task-1" }),
  ).rejects.toThrow(/already in use/);

  // The slot task-1 claimed must be back. If it leaked, task-2's gate reads capacity as
  // full and parks it as `queued` instead of running it.
  const approved = await service.approveTask({ coordinatorSession: "backend:main", taskId: "task-2" });
  expect(approved.status).toBe("running");
});

test("approveTask releases its parallel slot after a successful approve", async () => {
  // The success path must release too, once the task is persisted as `running` and
  // countActiveParallelSlots counts it for real. Holding the pending claim as well would
  // double-count the task and shrink the agent's capacity by one, permanently.
  //
  // Cap 2, not 1: at cap 1 the leak is invisible, because the first task's `running` status
  // already fills the cap and the second is correctly queued either way. The bug only shows
  // where a second slot should still be free.
  const { harness, service } = await makeTwoPendingParallelApprovals(2);

  const first = await service.approveTask({ coordinatorSession: "backend:main", taskId: "task-1" });
  expect(first.status).toBe("running");

  const second = await service.approveTask({ coordinatorSession: "backend:main", taskId: "task-2" });
  expect(second.status).toBe("running");

  const dispatches = harness.calls.filter((call) => call.port === "dispatchWorkerTask").length;
  expect(dispatches).toBe(2);
});

test("approveTask releases its parallel slot when the dispatch fails and rolls back", async () => {
  // The last exit path, and the one that pins WHERE the success-path release sits. Moving
  // that release to after `dispatchWorkerTask` is a legal, type-checking edit that keeps
  // every other test in this file green and the frozen 185-test oracle green — and leaks a
  // slot on every failed dispatch, because the rollback restores `needs_confirmation`
  // (the task stops counting) while the pending claim is never given back.
  const { harness, service } = await makeTwoPendingParallelApprovals();
  const baseDispatch = harness.deps.dispatchWorkerTask;
  let dispatches = 0;
  harness.deps.dispatchWorkerTask = async (request) => {
    dispatches += 1;
    if (dispatches === 1) throw new Error("acpx refused the prompt");
    await baseDispatch(request);
  };

  await expect(
    service.approveTask({ coordinatorSession: "backend:main", taskId: "task-1" }),
  ).rejects.toThrow(/acpx refused the prompt/);
  // The rollback put task-1 back where it started, so the cap is free again.
  expect(harness.getState().orchestration.tasks["task-1"]!.status).toBe("needs_confirmation");

  const approved = await service.approveTask({ coordinatorSession: "backend:main", taskId: "task-2" });
  expect(approved.status).toBe("running");
});

test("approveTask releases its parallel slot when ensureWorkerSession fails", async () => {
  const { harness, service } = await makeTwoPendingParallelApprovals();
  const baseEnsure = harness.deps.ensureWorkerSession;
  let ensureCalls = 0;
  harness.deps.ensureWorkerSession = async (request) => {
    ensureCalls += 1;
    if (ensureCalls === 1) throw new Error("acpx refused the session");
    return await baseEnsure(request);
  };

  await expect(
    service.approveTask({ coordinatorSession: "backend:main", taskId: "task-1" }),
  ).rejects.toThrow(/acpx refused the session/);

  const approved = await service.approveTask({ coordinatorSession: "backend:main", taskId: "task-2" });
  expect(approved.status).toBe("running");
});

test("concurrency: reconcileParallelSlots racing a delegation never over-dispatches", async () => {
  const harness = makeGoldenHarness({
    ids: ["task-1", "task-1-slot", "task-2", "task-2-slot", "task-3", "task-3-slot"],
    config: cappedConfig,
  });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "first",
    parallel: true,
  });
  await service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "second",
    parallel: true,
  });
  // recordWorkerReply requires the caller's sourceHandle to match the task's assigned
  // workerSession exactly — read it back from state rather than hardcoding the `:p-<id>`
  // suffix the harness generated.
  const task1 = harness.getState().orchestration.tasks["task-1"]!;
  await service.recordWorkerReply({
    taskId: "task-1",
    sourceHandle: task1.workerSession!,
    summary: "done",
    resultText: "ok",
  });

  await Promise.all([
    service.reconcileParallelSlots(),
    service.requestDelegate({
      sourceHandle: "wx:user-1",
      sourceKind: "human",
      coordinatorSession: "backend:main",
      workspace: "backend",
      targetAgent: "claude",
      task: "third",
      parallel: true,
    }),
  ]);

  const state = harness.getState();
  const tasks = Object.values(state.orchestration.tasks);
  const running = tasks.filter((t) => t.status === "running");
  const dispatches = harness.calls.filter((c) => c.port === "dispatchWorkerTask").length;

  // Each running task was dispatched exactly once; a lost pendingParallelStarts shows up
  // as more dispatches than non-queued tasks, or as two tasks running at capacity 1.
  expect(dispatches).toBe(tasks.filter((t) => t.status !== "queued").length);
  expect(running.length).toBeLessThanOrEqual(harness.deps.config.orchestration.maxParallelTasksPerAgent);
});

test("concurrency: pendingLogicalTransportSessions is shared across its two access points", async () => {
  // Guards pendingLogicalTransportSessions (orchestration-service.ts:328). Written by
  // reserveLogicalTransportSession (:3137-3147, called by command-router.ts:558/753 when
  // a logical session is created) and read by registerExternalCoordinator's guard at
  // :368-370, which throws when the count is nonzero. A facade that split this map
  // across two manager instances would leave registerExternalCoordinator reading a
  // stale zero count from its own (empty) copy — the reservation this test holds open
  // would become invisible to it, and the coordinator would register successfully onto
  // a transport session another in-flight caller is still claiming.
  //
  // The existing golden coverage for this exact error message
  // (orchestration-service.test.ts:2561, :2629, "conflicts with an existing logical
  // session") never calls reserveLogicalTransportSession — it exercises the guard three
  // lines below (:371-373), which reads *persisted* `state.sessions[].transport_session`
  // collisions instead. That guard cannot detect a split of the in-memory map, because
  // it never reads it. This test reserves via the same public method the real
  // session-creation path uses and deliberately never releases it, so only the
  // pendingLogicalTransportSessions guard can be responsible for the throw: none of the
  // earlier guards in registerExternalCoordinator (pendingWorkerSessions, workerBindings,
  // hasActiveTaskWorkerSession — all read different, untouched state) can fire here.
  const harness = makeGoldenHarness({ ids: [] });
  const service = new OrchestrationService(harness.deps);
  const transportSession = "backend:pending-transport";

  await service.reserveLogicalTransportSession(transportSession);
  // Deliberately not calling the returned release function: the reservation must still
  // be live when registerExternalCoordinator's guard runs below.

  await expect(
    service.registerExternalCoordinator({ coordinatorSession: transportSession, workspace: "backend" }),
  ).rejects.toThrow(/existing logical session/);
});

test("concurrency: pendingWorkerSessions is shared across its two access points", async () => {
  // Guards pendingWorkerSessions (orchestration-service.ts:327). Written by
  // reserveProposedWorkerSession (:3102-3108) and read by assertWorkerSessionAvailable
  // (:3479-3493) — called both from inside reserveProposedWorkerSession's own mutate
  // (self-check, :3106) and from the persist mutate at :682. A facade that split this
  // map across two manager instances would let a second delegation's
  // assertWorkerSessionAvailable read a stale zero count for a worker session the first
  // delegation already holds, and it would go on to reserve — and later dispatch a task
  // onto — the SAME acpx worker session as the first.
  //
  // Two non-parallel delegations with the same targetAgent/workspace/coordinatorSession
  // resolve to the same deterministic worker-session name (resolveWorkerSession,
  // :3071-3099, which keys only on those fields plus role/cwd — never sourceHandle or
  // task text). Concurrency test "two parallel delegations..." and the mutex test above
  // deliberately avoid this collision (different targetAgent per delegation); this test
  // deliberately forces it.
  //
  // Verified by direct trace of the source: a fully SEQUENTIAL pair (fully await
  // delegation A, then start delegation B) also throws "worker session ... is already
  // in use" — but from the OTHER guard. By the time B's reserveProposedWorkerSession
  // runs, A has already called its release closure (requestDelegateForHuman :707, after
  // its persist mutate resolved) and pendingWorkerSessions is back to 0; B's throw then
  // comes from hasActiveTaskWorkerSession reading A's now-persisted task record
  // (:3490), not from the map. That sequential case does not exercise the map at all
  // and cannot detect a split. To exercise the map specifically, B's
  // reserveProposedWorkerSession must run while A's reservation is held but before A
  // has released it.
  //
  // Deviation from the "gate deps.loadState" suggestion (recorded here, as test 1 does
  // for its own deviation): gating loadState cannot create that window. AsyncMutex
  // (async-mutex.ts) is a strict FIFO queue keyed on the SYNCHRONOUS call time of
  // run(), not on when work inside an already-queued critical section resolves.
  // reserveProposedWorkerSession's mutate() (called at :626) and the persist mutate's
  // mutate() (called at :639) are two separate queue entries. Gating loadState *inside*
  // the persist critical section only delays a slot that may already be queued ahead of
  // B — it does not stop delegation A's control flow from reaching and registering that
  // mutate() call in the first place, so B could end up queued behind it and only run
  // once A's release has already happened, reproducing the vacuous sequential case
  // above instead of the map race. The one point strictly BETWEEN
  // reserveProposedWorkerSession's mutate() call and the persist mutate's mutate() call,
  // in source order, is `ensureWorkerSession` (called at :629) — gating that reliably
  // stalls delegation A right after it holds the pendingWorkerSessions reservation and
  // before it has even attempted to queue its persist mutate(), guaranteeing delegation
  // B's mutate() call is both registered and run first — deterministically, not by
  // tick-counting.
  const harness = makeGoldenHarness({ ids: ["task-1", "task-2"] });
  const gate = deferred<void>();
  const aReachedEnsure = deferred<void>();

  const baseEnsure = harness.deps.ensureWorkerSession;
  let ensureCallCount = 0;
  harness.deps.ensureWorkerSession = async (request) => {
    ensureCallCount += 1;
    if (ensureCallCount === 1) {
      // This must be delegation A: under correct code B is rejected inside
      // reserveProposedWorkerSession and never reaches ensureWorkerSession at all.
      aReachedEnsure.resolve();
      await gate.promise;
    }
    // Deliberately not gating any call beyond the first. If a broken map split ever
    // lets a second delegation reach this point, gating it too would hang both
    // delegations on the same never-yet-resolved `gate` (B waiting here, the test
    // waiting on B, and nothing left to call `gate.resolve()`) — turning a bug this
    // test is supposed to catch into a suite-wide timeout instead of a clean,
    // reported assertion failure. Letting a stray second call through keeps the
    // failure mode legible.
    return await baseEnsure(request);
  };

  const service = new OrchestrationService(harness.deps);
  const a = service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "first",
  });

  // Wait for delegation A to reach the ensureWorkerSession gate. At this point its
  // reserveProposedWorkerSession mutate() has completed (pendingWorkerSessions holds
  // A's reservation) and its persist mutate() has not yet been called, so it cannot be
  // queued ahead of B in the state mutex.
  await aReachedEnsure.promise;

  const b = service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "second",
  });

  await expect(b).rejects.toThrow(/worker session .* already in use/);

  gate.resolve();
  const resultA = await a;
  expect(resultA.status).toBe("running");
});
