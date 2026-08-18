import { expect, test } from "bun:test";

import { HumanDelegationService } from "../../../../src/orchestration/service/human-delegation-service";
import { OrchestrationStateKernel } from "../../../../src/orchestration/service/orchestration-state-kernel";
import { RpcDelegationService } from "../../../../src/orchestration/service/rpc-delegation-service";
import { WorkerSessionManager } from "../../../../src/orchestration/service/worker-session-manager";
import { createEmptyState } from "../../../../src/state/types";
import { makeGoldenHarness } from "../golden/golden-harness";

// Construct the service from a bare object literal of exactly its FIVE ports — never
// `harness.deps` wholesale — plus the kernel, the WorkerSessionManager, and an
// RpcDelegationService. This is the isolation-testability deliverable of the split: the
// service must build without `config`, `ensureWorkerSession`, `wakeCoordinatorSession`,
// `logger` or any of the other ports, and it must not silently reach for a dep outside its
// declared HumanDelegationDeps.
function makeService(ids: string[] = ["task-1"], initialState = createEmptyState()) {
  const harness = makeGoldenHarness({ ids, endpointIds: ["worker-endpoint-1"], initialState });
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
    },
    kernel,
    workerSessions,
  );
  const humanDelegation = new HumanDelegationService(
    {
      now: harness.deps.now,
      createId: harness.deps.createId,
      createAgentEndpointId: harness.deps.createAgentEndpointId,
      loadState: harness.deps.loadState,
      saveState: harness.deps.saveState,
      dispatchWorkerTask: harness.deps.dispatchWorkerTask,
    },
    kernel,
    workerSessions,
    rpcDelegation,
  );
  return { harness, humanDelegation };
}

test("constructible with only its six ports and delegates a human request", async () => {
  const { harness, humanDelegation } = makeService();

  const callsBefore = harness.calls.length;
  const result = await humanDelegation.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "write the migration",
  });

  expect(result.taskId).toBe("task-1");
  expect(result.status).toBe("running");
  const persisted = harness.getState().orchestration.tasks["task-1"];
  expect(persisted.status).toBe("running");
  expect(
    harness.getState().orchestration.workerBindings[persisted.workerSession!]?.agentEndpointId,
  ).toBe("endpoint_worker-endpoint-1");
  // The human path dispatches the worker turn synchronously before resolving.
  expect(
    harness.calls.slice(callsBefore).some((call) => call.port === "dispatchWorkerTask"),
  ).toBe(true);
});

test("dispatcher routes RequestDelegateInput and RequestDelegateRpcInput to different paths", async () => {
  // Human input (has `sourceKind`) → requestDelegateForHuman. No source-registration
  // lookup is performed, so an unregistered sourceHandle succeeds.
  const human = makeService(["task-1"]);
  const humanResult = await human.humanDelegation.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "write the migration",
  });
  expect(humanResult.taskId).toBe("task-1");

  // RPC input (no `sourceKind`) → rpcDelegation.requestDelegateFromRpc, which resolves the
  // sourceHandle against registered coordinators/workers and rejects an unregistered one.
  // This is an observable only the RPC path produces — the human path never runs it.
  const rpc = makeService(["task-1"]);
  await expect(
    rpc.humanDelegation.requestDelegate({
      sourceHandle: "wx:user-1",
      targetAgent: "claude",
      task: "write the migration",
    }),
  ).rejects.toThrow('is not a registered coordinator or worker session');
});
