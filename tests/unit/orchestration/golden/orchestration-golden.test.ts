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
import { createEmptyState } from "../../../../src/state/types";
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
