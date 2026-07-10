import { expect, test } from "bun:test";

import { NoticeDeliveryService } from "../../../../src/orchestration/service/notice-delivery-service";
import { OrchestrationStateKernel } from "../../../../src/orchestration/service/orchestration-state-kernel";
import type { OrchestrationTaskRecord } from "../../../../src/orchestration/orchestration-types";
import { createEmptyState } from "../../../../src/state/types";
import { makeGoldenHarness } from "../golden/golden-harness";

test("constructible with only its three ports and returns no pending notices when empty", async () => {
  const harness = makeGoldenHarness();
  const kernel = new OrchestrationStateKernel({});
  const notices = new NoticeDeliveryService(
    {
      now: harness.deps.now,
      loadState: harness.deps.loadState,
      saveState: harness.deps.saveState,
    },
    kernel,
  );

  const pending = await notices.listPendingTaskNotices();
  expect(pending).toEqual([]);
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
