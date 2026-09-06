import { expect, test } from "bun:test";

import { OrchestrationStateKernel } from "../../../../src/orchestration/service/orchestration-state-kernel";
import { RpcDelegationService } from "../../../../src/orchestration/service/rpc-delegation-service";
import { WorkerSessionManager } from "../../../../src/orchestration/service/worker-session-manager";
import { createEmptyState } from "../../../../src/state/types";
import type { OrchestrationTaskRecord } from "../../../../src/orchestration/orchestration-types";
import type { StagedWorkerIdentity } from "../../../../src/orchestration/worker-launch";
import { makeGoldenHarness, type GoldenHarness, type GoldenHarnessOverrides } from "../golden/golden-harness";
// Construct the service from a bare object literal of exactly its NINE ports — never
// `harness.deps` wholesale — plus the kernel and the WorkerSessionManager. This is the
// isolation-testability deliverable of the split: the service must build without
// `ensureWorkerSession`, `cancelWorkerTask`, `wakeCoordinatorSession`
// or any of the other ports, and it must not silently reach for a dep outside its declared
// RpcDelegationDeps.
function makeService(initialState = createEmptyState(), harnessOverrides: GoldenHarnessOverrides = {}) {
  const harness = makeGoldenHarness({
    ids: ["task-1", "lid-1"],
    endpointIds: ["worker-endpoint-1"],
    initialState,
    ...harnessOverrides,
  });
  const kernel = new OrchestrationStateKernel({ logger: harness.deps.logger });
  const workerSessions = new WorkerSessionManager(harness.deps, kernel);
  const rpcDelegation = new RpcDelegationService(
    {
      now: harness.deps.now,
      createId: harness.deps.createId,
      createAgentEndpointId: harness.deps.createAgentEndpointId,
      loadState: harness.deps.loadState,
      saveState: harness.deps.saveState,
      config: harness.deps.config,
      dispatchWorkerTask: harness.deps.dispatchWorkerTask,
      resolveWorkerBindingEngine: harness.deps.resolveWorkerBindingEngine,
      releaseWorkerSession: harness.deps.releaseWorkerSession,
    },
    kernel,
    workerSessions,
  );
  return { harness, rpcDelegation, workerSessions };
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

test("constructible with only its nine ports and delegates a registered external coordinator's RPC", async () => {
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
  expect(
    harness.getState().orchestration.workerBindings[persisted.workerSession!]?.agentEndpointId,
  ).toBe("endpoint_worker-endpoint-1");
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

test("stale startup cleanup backs off while a new delegation holds the start reservation", async () => {
  // Reverse-direction lease regression: the stale detached cleanup owns
  // nothing (its reservation was released before the chain started) and
  // names a possibly-REUSED LID. A new delegation admitted after the stale
  // check but before a split claim would still be killed — so the claim
  // must land atomically with the checks. No public flow can stage this
  // window (a running task bars B; a removed task ends A's chain), hence
  // the direct-but-real entry below with B's reservation held by the same
  // manager instance the service admits through.
  const WORKER = "backend:claude:stale-cleanup";
  const initialState = createEmptyState();
  initialState.orchestration.workerBindings[WORKER] = {
    sourceHandle: WORKER,
    coordinatorSession: "coord-1",
    workspace: "backend",
    targetAgent: "claude",
    guardAcpOutput: true,
    logicalSessionId: "lid-stale",
    transportEngine: "cli",
  } as never;
  const { harness, rpcDelegation, workerSessions } = makeService(initialState);
  const staleTask = {
    taskId: "task-stale",
    workerSession: WORKER,
    coordinatorSession: "coord-1",
    workspace: "backend",
    targetAgent: "claude",
  } as never;
  const staleInput = {
    task: staleTask,
    previousBinding: undefined,
    stagedIdentity: { logicalSessionId: "lid-stale", transportEngine: "cli" },
  } as never;
  // No public flow can stage "stale cleanup in flight while B holds the
  // reservation" (a running task bars B; a removed task ends A's chain), so
  // the deterministic regression enters through the real private method with
  // B's reservation held by the same manager instance the service admits
  // through. Named const (not inline access): the shape is the service's
  // own private method, verified by the calls below.
  interface StaleCleanupSeam {
    cleanupAutoRunStartupBinding: (input: {
      task: OrchestrationTaskRecord;
      previousBinding: undefined;
      stagedIdentity: StagedWorkerIdentity;
    }) => Promise<boolean>;
  }
  const seam: StaleCleanupSeam = rpcDelegation as unknown as StaleCleanupSeam;
  const releasesFor = (lid: string): number =>
    harness.calls.filter((call) => {
      if (call.port !== "releaseWorkerSession") return false;
      const request = call.request;
      return (
        !!request &&
        typeof request === "object" &&
        "logicalSessionId" in request &&
        request.logicalSessionId === lid
      );
    }).length;

  // B reserves first: the stale cleanup must back off without touching the engine.
  const releaseReservation = await workerSessions.reserveProposedWorkerSession(WORKER);
  try {
    expect(await seam.cleanupAutoRunStartupBinding(staleInput)).toBe(false);
  } finally {
    await releaseReservation();
  }
  expect(releasesFor("lid-stale")).toBe(0);
  expect(harness.getState().orchestration.workerBindings[WORKER]).toMatchObject({
    logicalSessionId: "lid-stale",
  });

  // Uncontended, the same stale cleanup converges and deletes.
  expect(await seam.cleanupAutoRunStartupBinding(staleInput)).toBe(true);
  expect(releasesFor("lid-stale")).toBe(1);
  expect(harness.getState().orchestration.workerBindings[WORKER]).toBeUndefined();
});
