import { expect, test } from "bun:test";

import { NoticeDeliveryService } from "../../../../src/orchestration/service/notice-delivery-service";
import { OrchestrationStateKernel } from "../../../../src/orchestration/service/orchestration-state-kernel";
import type { OrchestrationTaskRecord } from "../../../../src/orchestration/orchestration-types";
import { createEmptyState } from "../../../../src/state/types";
import { makeGoldenHarness } from "../golden/golden-harness";

function seedTask(taskId: string, overrides: Partial<OrchestrationTaskRecord>): OrchestrationTaskRecord {
  return {
    taskId,
    sourceHandle: "worker:w1",
    sourceKind: "worker",
    coordinatorSession: "coord-1",
    workspace: "backend",
    targetAgent: "codex",
    task: "do the thing",
    status: "completed",
    summary: "",
    resultText: "",
    createdAt: "2026-04-13T09:00:00.000Z",
    updatedAt: "2026-04-13T09:00:00.000Z",
    ...overrides,
  };
}

test("constructible with only its three ports, and selects exactly the pending notices", async () => {
  // Asserting `[]` against an empty state proves nothing -- a method that constantly
  // returns `[]` passes. Seed one task with a pending notice and one without, so the
  // assertion pins the selection rather than the emptiness.
  const initialState = createEmptyState();
  initialState.orchestration.tasks["pending-1"] = seedTask("pending-1", { noticePending: true });
  initialState.orchestration.tasks["quiet-1"] = seedTask("quiet-1", {});

  const harness = makeGoldenHarness({ initialState });
  const kernel = new OrchestrationStateKernel({});
  // The point of the split: three ports, not sixteen.
  const notices = new NoticeDeliveryService(
    {
      now: harness.deps.now,
      loadState: harness.deps.loadState,
      saveState: harness.deps.saveState,
    },
    kernel,
  );

  const pending = await notices.listPendingTaskNotices();
  expect(pending.map((task) => task.taskId)).toEqual(["pending-1"]);
});

test("markTaskNoticeDelivered clears the pending flag and stamps the delivery account", async () => {
  const initialState = createEmptyState();
  const seededTask: OrchestrationTaskRecord = {
    taskId: "t1",
    sourceHandle: "worker:w1",
    sourceKind: "worker",
    coordinatorSession: "coord-1",
    workspace: "backend",
    targetAgent: "codex",
    task: "do the thing",
    status: "completed",
    summary: "",
    resultText: "",
    createdAt: "2026-04-13T09:00:00.000Z",
    updatedAt: "2026-04-13T09:00:00.000Z",
    noticePending: true,
  };
  initialState.orchestration.tasks[seededTask.taskId] = seededTask;

  const harness = makeGoldenHarness({ initialState });
  const kernel = new OrchestrationStateKernel({});
  const notices = new NoticeDeliveryService(
    {
      now: harness.deps.now,
      loadState: harness.deps.loadState,
      saveState: harness.deps.saveState,
    },
    kernel,
  );

  const result = await notices.markTaskNoticeDelivered("t1", "acct-99");
  expect(result.noticePending).toBe(false);
  expect(result.deliveryAccountId).toBe("acct-99");

  const persisted = harness.getState().orchestration.tasks["t1"];
  expect(persisted.noticePending).toBe(false);
  expect(persisted.deliveryAccountId).toBe("acct-99");
  expect(persisted.noticeSentAt).toBe("2026-04-13T10:00:00.000Z");
});
