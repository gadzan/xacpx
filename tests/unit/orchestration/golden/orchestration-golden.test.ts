// tests/unit/orchestration/golden/orchestration-golden.test.ts
// The equivalence oracle for the orchestration-service split. Each test drives one
// public entry point and snapshots (a) the resulting AppState, (b) the ORDERED log of
// outbound port calls, (c) every task's event sequence.
//
// DO NOT set GOLDEN_UPDATE=1 outside Tasks 2-6. A failing fixture after a refactor task
// means the refactor changed observable behaviour.
import { test } from "bun:test";

import { createConfig } from "../../commands/command-router-test-support";
import { OrchestrationService } from "../../../../src/orchestration/orchestration-service";
import { createEmptyState, type AppState } from "../../../../src/state/types";
import { expectMatchesFixture, makeGoldenHarness, type GoldenHarness } from "./golden-harness";

/**
 * requestDelegateFromRpc's coordinator (autoRun) path fires its worker dispatch via
 * `void this.runAutoRunRpcWorkerTask(...)` — NOT awaited (orchestration-service.ts:956-961).
 * ensureWorkerSession/dispatchWorkerTask therefore land some microtask ticks after
 * requestDelegateFromRpc's own promise resolves. The frozen regression oracle polls for
 * this exact reason (orchestration-service.test.ts, "attaches an rpc-delegated task to an
 * existing group..."). We must poll the same way before snapshotting, or the fixture would
 * be racy: sometimes it would catch the dispatch call, sometimes not.
 *
 * Precondition: this only works when the awaited port call is the LAST thing the detached
 * work does on its success path. The current caller waits for `dispatchWorkerTask`, and
 * `runAutoRunRpcWorkerTask` (orchestration-service.ts:976-1145) does nothing after
 * `await this.deps.dispatchWorkerTask(...)` on the non-throwing path — so once that call
 * lands, the detached work is finished and the snapshot is stable. A future scenario whose
 * mocked port throws (or that does further work after the awaited call) would need a
 * different wait, not this poll.
 */
async function waitForPortCall(harness: GoldenHarness, port: string): Promise<void> {
  const maxAttempts = 20;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (harness.calls.some((call) => call.port === port)) {
      return;
    }
    await Bun.sleep(0);
  }
  throw new Error(
    `waitForPortCall: timed out waiting for port "${port}" after ${maxAttempts} attempts`,
  );
}

/**
 * `requestTaskCancellation` (orchestration-service.ts:2678-2775) fires
 * `this.startWorkerCancellation(prepared.task)` as a bare, unawaited call (line 2753).
 * `startWorkerCancellation` (:4415-4460) spawns a detached `void (async () => {...})()`
 * that runs `loadState -> cancelWorkerTask -> completeTaskCancellation` (or
 * `failTaskCancellation` if `cancelWorkerTask` throws). That chain has no port of its
 * own to poll for — its terminal signal on the success path is the unconditional
 * `this.logEvent("orchestration.task.cancel_completed", ...)` that
 * `completeTaskCancellation` fires right after its `mutate()` resolves
 * (orchestration-service.ts:2844-2848), regardless of which branch inside that mutate
 * ran. Poll for that logged event the same way `waitForPortCall` polls for a port, so a
 * caller can deterministically drain the detached chain before snapshotting instead of
 * racing it.
 */
async function waitForLogEvent(harness: GoldenHarness, eventName: string): Promise<void> {
  const maxAttempts = 20;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (
      harness.calls.some(
        (call) =>
          call.port.startsWith("logger.") &&
          (call.request as { event?: unknown } | null)?.event === eventName,
      )
    ) {
      return;
    }
    await Bun.sleep(0);
  }
  throw new Error(
    `waitForLogEvent: timed out waiting for log event "${eventName}" after ${maxAttempts} attempts`,
  );
}

test("golden: requestDelegate (human path) creates a running task and dispatches", async () => {
  const harness = makeGoldenHarness({ ids: ["task-1"] });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "write the migration",
  });

  expectMatchesFixture("requestdelegate-human-path-creates-a-running", harness.snapshot());
});

test("golden: requestDelegate (human path) at parallel capacity queues instead of dispatching", async () => {
  // Pin the cap to 1 so the second parallel request is meaningfully forced to queue —
  // createConfig()'s default maxParallelTasksPerAgent is 3.
  const harness = makeGoldenHarness({
    ids: ["task-1", "task-1-slot", "task-2", "task-2-slot"],
    config: {
      ...createConfig(),
      orchestration: { ...createConfig().orchestration, maxParallelTasksPerAgent: 1 },
    },
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

  expectMatchesFixture("requestdelegate-human-path-at-parallel-capacity", harness.snapshot());
});

test("golden: requestDelegateFromRpc creates a task and returns its status", async () => {
  // requestDelegateFromRpc resolves `sourceHandle` against known coordinators/workers
  // (orchestration-service.ts:3241 resolveRpcSourceContext) — an empty state throws
  // `sourceHandle "backend:main" is not a registered coordinator or worker session`.
  // Seed a logical session whose transport_session is "backend:main" so it resolves to
  // sourceKind "coordinator" (autoRun path), matching the existing regression suite's
  // convention (orchestration-service.test.ts ~line 649).
  const harness = makeGoldenHarness({
    ids: ["task-1"],
    initialState: {
      ...createEmptyState(),
      sessions: {
        main: {
          alias: "main",
          agent: "codex",
          workspace: "backend",
          transport_session: "backend:main",
          created_at: "2026-04-13T10:00:00.000Z",
          last_used_at: "2026-04-13T10:00:00.000Z",
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const result = await service.requestDelegateFromRpc({
    sourceHandle: "backend:main",
    targetAgent: "claude",
    task: "run the audit",
  });
  await waitForPortCall(harness, "dispatchWorkerTask");

  expectMatchesFixture("requestdelegatefromrpc-creates-a-task-and-returns-rpc-result", result);
  expectMatchesFixture("requestdelegatefromrpc-creates-a-task-and-returns-rpc-state", harness.snapshot());
});

test("golden: approveTask starts a needs_confirmation task", async () => {
  // A `needs_confirmation` status out of requestDelegateFromRpc requires a worker-sourced
  // (not coordinator-sourced) request: autoRun is only true when sourceKind === "coordinator"
  // (orchestration-service.ts:787). sourceKind resolves to "worker" when sourceHandle matches
  // an existing workerBindings key (resolveRpcSourceContext, :3245-3253) — there is no
  // `requireConfirmation` input field. Seed a worker binding and enable
  // allowWorkerChainedRequests (createConfig()'s default is false), mirroring the frozen
  // regression test "approves a worker-chained needs_confirmation task by assigning a worker
  // session" (orchestration-service.test.ts ~line 6936).
  const harness = makeGoldenHarness({
    ids: ["task-1"],
    config: {
      ...createConfig(),
      orchestration: { ...createConfig().orchestration, allowWorkerChainedRequests: true },
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

  await service.requestDelegateFromRpc({
    sourceHandle: "backend:claude:backend:main",
    targetAgent: "codex",
    role: "reviewer",
    task: "dangerous thing",
  });
  await service.approveTask({ coordinatorSession: "backend:main", taskId: "task-1" });

  expectMatchesFixture("approvetask-starts-a-needs-confirmation-task", harness.snapshot());
});

test("golden: reconcileParallelSlots drains a queued task when a slot frees", async () => {
  const harness = makeGoldenHarness({
    ids: ["task-1", "task-1-slot", "task-2", "task-2-slot"],
    config: {
      ...createConfig(),
      orchestration: { ...createConfig().orchestration, maxParallelTasksPerAgent: 1 },
    },
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
  // workerSession exactly (RecordWorkerReplyInput.sourceHandle is non-optional and
  // asserted against, orchestration-service.ts:1247-1256). Read it back from state
  // rather than hardcoding the `:p-<id>` suffix the harness generated.
  const task1 = harness.getState().orchestration.tasks["task-1"]!;
  await service.recordWorkerReply({
    taskId: "task-1",
    sourceHandle: task1.workerSession!,
    summary: "done",
    resultText: "ok",
  });
  await service.reconcileParallelSlots();

  expectMatchesFixture("reconcileparallelslots-drains-a-queued-task-when", harness.snapshot());
});

test("golden: requestTaskCancellation drains its detached chain to a settled state", async () => {
  // Characterizes the real fire-and-forget behaviour (see the `waitForLogEvent` doc
  // comment above): `requestTaskCancellation` returns as soon as its own mutate
  // resolves, well before the detached chain it kicked off has run
  // `cancelWorkerTask -> completeTaskCancellation`. Drain that chain deterministically
  // before snapshotting so this fixture pins the settled end state the chain produces,
  // not an accident of how many microtask hops happened to elapse by the time this test
  // got around to snapshotting.
  const harness = makeGoldenHarness({ ids: ["task-1"] });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "cancel me",
  });
  await service.requestTaskCancellation({ coordinatorSession: "backend:main", taskId: "task-1" });
  await waitForLogEvent(harness, "orchestration.task.cancel_completed");

  expectMatchesFixture("requesttaskcancellation-drains-its-detached-chain", harness.snapshot());
});

/**
 * `requestTaskCancellation`'s `task.status === "running"` branch (orchestration-service.ts
 * :2711-2724, the first cancel request on a running task) writes exactly this onto the
 * task: `cancelRequestedAt` and `updatedAt` stamped to `now`, plus an appended
 * `cancel_requested` event — status itself stays `running`. Everything else is copied
 * from the task record `requestDelegate` (human path) would have produced.
 */
function seedRunningCancelRequestedState(): AppState {
  const now = "2026-04-13T10:00:00.000Z";
  return {
    ...createEmptyState(),
    orchestration: {
      ...createEmptyState().orchestration,
      tasks: {
        "task-1": {
          taskId: "task-1",
          sourceHandle: "wx:user-1",
          sourceKind: "human",
          coordinatorSession: "backend:main",
          workerSession: "backend:claude:backend:main",
          workspace: "backend",
          targetAgent: "claude",
          task: "cancel me",
          status: "running",
          summary: "",
          resultText: "",
          createdAt: now,
          updatedAt: now,
          cancelRequestedAt: now,
          eventSeq: 2,
          events: [
            { seq: 1, at: now, type: "created", status: "running", message: "Task created" },
            { seq: 2, at: now, type: "cancel_requested", status: "running", message: "Cancellation requested" },
          ],
        },
      },
    },
  };
}

// The two scenarios below seed the task directly in the state `requestTaskCancellation`
// would have left it in, instead of calling `requestTaskCancellation` first: that avoids
// spawning — and then racing — the detached cancellation chain described in the
// `waitForLogEvent` doc comment above, so these fixtures stay independent of microtask
// scheduling in that chain.
test("golden: completeTaskCancellation on a cancel-requested task", async () => {
  const harness = makeGoldenHarness({ initialState: seedRunningCancelRequestedState() });
  const service = new OrchestrationService(harness.deps);

  await service.completeTaskCancellation("task-1");

  expectMatchesFixture("completetaskcancellation-on-a-cancel-requested-task", harness.snapshot());
});

test("golden: failTaskCancellation on a cancel-requested task records the error and leaves the task running", async () => {
  const harness = makeGoldenHarness({ initialState: seedRunningCancelRequestedState() });
  const service = new OrchestrationService(harness.deps);

  await service.failTaskCancellation("task-1", "transport exploded");

  expectMatchesFixture("failtaskcancellation-on-a-cancel-requested-task", harness.snapshot());
});

test("golden: createGroup then cancelGroup cancels its tasks", async () => {
  // createGroup's real signature is `{ coordinatorSession, title }` — the groupId is
  // always server-generated via `deps.createId()` (orchestration-service.ts:400-414),
  // there is no caller-supplied groupId field. Seed the id pool so the generated group
  // id is the readable "g1", then thread the *returned* group.groupId into the
  // delegate/cancel calls instead of hardcoding a literal that createGroup would reject.
  const harness = makeGoldenHarness({ ids: ["g1", "task-1"] });
  const service = new OrchestrationService(harness.deps);

  const group = await service.createGroup({ coordinatorSession: "backend:main", title: "review" });
  await service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "in group",
    groupId: group.groupId,
  });
  const result = await service.cancelGroup({ coordinatorSession: "backend:main", groupId: group.groupId });

  // `cancelGroup` (orchestration-service.ts:486-527) awaits `requestTaskCancellation` for
  // each task, which — per the module doc comment above — returns as soon as its own
  // mutate resolves, well before the detached cancellation chain it fires actually
  // finishes. `cancelGroup` then rebuilds `summary` via `getGroupSummary` (a plain
  // `loadState`, no drain) and returns. So the returned `result.summary` genuinely shows
  // this task still `running` at the moment `cancelGroup` returns — that staleness is
  // real production behaviour of `cancelGroup` today, not something the orchestration
  // split introduces, and this fixture intentionally pins it as-is.
  expectMatchesFixture("creategroup-then-cancelgroup-cancels-its-tasks-cancel-group-result", result);

  // The state snapshot below is taken one statement later — drain the detached chain
  // first so it pins a settled state rather than an accident of how many microtask hops
  // happen to elapse between `cancelGroup` returning and this line running.
  await waitForLogEvent(harness, "orchestration.task.cancel_completed");
  expectMatchesFixture("creategroup-then-cancelgroup-cancels-its-tasks-cancel-group-state", harness.snapshot());
});

test("golden: listGroupSummaries reflects task status rollup", async () => {
  const harness = makeGoldenHarness({ ids: ["g1", "task-1"] });
  const service = new OrchestrationService(harness.deps);

  const group = await service.createGroup({ coordinatorSession: "backend:main", title: "review" });
  await service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "in group",
    groupId: group.groupId,
  });
  // recordWorkerReply requires the caller's sourceHandle to match the task's assigned
  // workerSession exactly (see the reconcileParallelSlots scenario above) — read it back
  // from state rather than hardcoding it.
  const task1 = harness.getState().orchestration.tasks["task-1"]!;
  await service.recordWorkerReply({
    taskId: "task-1",
    sourceHandle: task1.workerSession!,
    summary: "done",
    resultText: "ok",
  });

  // listGroupSummaries is async (orchestration-service.ts:451) — the brief's snippet
  // omitted the `await`, which would have snapshotted an unresolved Promise instead of
  // the summaries.
  expectMatchesFixture(
    "listgroupsummaries-reflects-task-status-rollup",
    await service.listGroupSummaries({ coordinatorSession: "backend:main" }),
  );
});
