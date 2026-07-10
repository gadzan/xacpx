import { expect, test } from "bun:test";

import { OrchestrationStateKernel } from "../../../../src/orchestration/service/orchestration-state-kernel";
import { RpcDelegationService } from "../../../../src/orchestration/service/rpc-delegation-service";
import { WorkerSessionManager } from "../../../../src/orchestration/service/worker-session-manager";
import { createEmptyState } from "../../../../src/state/types";
import { makeGoldenHarness, type GoldenHarness } from "../golden/golden-harness";

// Construct the service from a bare object literal of exactly its SIX ports — never
// `harness.deps` wholesale — plus the kernel and the WorkerSessionManager. This is the
// isolation-testability deliverable of the split: the service must build without
// `ensureWorkerSession`, `cancelWorkerTask`, `closeWorkerSession`, `wakeCoordinatorSession`
// or any of the other ports, and it must not silently reach for a dep outside its declared
// RpcDelegationDeps.
function makeService(initialState = createEmptyState()) {
  const harness = makeGoldenHarness({ ids: ["task-1"], initialState });
  const kernel = new OrchestrationStateKernel({ logger: harness.deps.logger });
  const workerSessions = new WorkerSessionManager(harness.deps, kernel);
  const rpcDelegation = new RpcDelegationService(
    {
      now: harness.deps.now,
      createId: harness.deps.createId,
      loadState: harness.deps.loadState,
      saveState: harness.deps.saveState,
      config: harness.deps.config,
      dispatchWorkerTask: harness.deps.dispatchWorkerTask,
    },
    kernel,
    workerSessions,
  );
  return { harness, rpcDelegation };
}

// The detached `runAutoRunRpcWorkerTask` chain is still running when
// `requestDelegateFromRpc` resolves; drain it by polling for its terminal port call,
// mirroring the golden suite's `waitForPortCall`.
async function waitForPortCall(harness: GoldenHarness, port: string, afterIndex: number): Promise<void> {
  const maxAttempts = 20;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (harness.calls.slice(afterIndex).some((call) => call.port === port)) {
      return;
    }
    await Bun.sleep(0);
  }
  throw new Error(
    `waitForPortCall: timed out waiting for port "${port}" after ${maxAttempts} attempts (since index ${afterIndex})`,
  );
}

function seedExternalCoordinatorState() {
  const now = "2026-04-13T10:00:00.000Z";
  const state = createEmptyState();
  state.orchestration.externalCoordinators["ext:coord-1"] = {
    coordinatorSession: "coord-1",
    workspace: "backend",
    createdAt: now,
    updatedAt: now,
  };
  return state;
}

test("constructible with only its six ports and delegates a registered external coordinator's RPC", async () => {
  const { harness, rpcDelegation } = makeService(seedExternalCoordinatorState());

  const callsBefore = harness.calls.length;
  const result = await rpcDelegation.requestDelegateFromRpc({
    sourceHandle: "ext:coord-1",
    targetAgent: "claude",
    task: "run the audit",
  });
  // Coordinator-sourced RPC is autoRun: the task is persisted `running` and the detached
  // startup chain dispatches the worker turn. Drain that chain before finishing.
  await waitForPortCall(harness, "dispatchWorkerTask", callsBefore);

  expect(result.taskId).toBe("task-1");
  expect(result.status).toBe("running");
  const persisted = harness.getState().orchestration.tasks["task-1"];
  expect(persisted.status).toBe("running");
});

test("validateRpcRequest rejects a request with a blank task", async () => {
  const { rpcDelegation } = makeService(seedExternalCoordinatorState());

  // sourceHandle and targetAgent are non-blank, so this fails the `task` guard
  // specifically — not an earlier one in validateRpcRequest.
  await expect(
    rpcDelegation.requestDelegateFromRpc({
      sourceHandle: "ext:coord-1",
      targetAgent: "claude",
      task: "   ",
    }),
  ).rejects.toThrow("task must be a non-empty string");
});
