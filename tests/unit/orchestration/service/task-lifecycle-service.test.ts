import { expect, test } from "bun:test";

import { OrchestrationStateKernel } from "../../../../src/orchestration/service/orchestration-state-kernel";
import { TaskLifecycleService } from "../../../../src/orchestration/service/task-lifecycle-service";
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
    status: "running",
    summary: "",
    resultText: "",
    createdAt: "2026-04-13T09:00:00.000Z",
    updatedAt: "2026-04-13T09:00:00.000Z",
    ...overrides,
  };
}

test("constructible with only its five ports, and its filter actually selects", async () => {
  // Asserting `[]` against an empty state proves nothing -- a method that constantly
  // returns `[]` passes. Seed two tasks under different coordinators so the assertion
  // pins matchesFilter's selection rather than the emptiness.
  const initialState = createEmptyState();
  initialState.orchestration.tasks["mine-1"] = seedTask("mine-1", { coordinatorSession: "coord-1" });
  initialState.orchestration.tasks["theirs-1"] = seedTask("theirs-1", { coordinatorSession: "coord-2" });

  const harness = makeGoldenHarness({ initialState });
  const kernel = new OrchestrationStateKernel({});
  // The point of the split: five ports, not sixteen.
  const lifecycle = new TaskLifecycleService(
    {
      now: harness.deps.now,
      createId: harness.deps.createId,
      loadState: harness.deps.loadState,
      saveState: harness.deps.saveState,
      config: harness.deps.config,
    },
    kernel,
  );

  expect((await lifecycle.listTasks()).map((task) => task.taskId).sort()).toEqual(["mine-1", "theirs-1"]);
  expect((await lifecycle.listTasks({ coordinatorSession: "coord-1" })).map((task) => task.taskId)).toEqual(["mine-1"]);
});

test("recordTaskProgress stamps the summary and appends a progress event", async () => {
  const initialState = createEmptyState();
  const seededTask: OrchestrationTaskRecord = {
    taskId: "t1",
    sourceHandle: "worker:w1",
    sourceKind: "worker",
    coordinatorSession: "coord-1",
    workspace: "backend",
    targetAgent: "codex",
    task: "do the thing",
    status: "running",
    summary: "",
    resultText: "",
    createdAt: "2026-04-13T09:00:00.000Z",
    updatedAt: "2026-04-13T09:00:00.000Z",
  };
  initialState.orchestration.tasks[seededTask.taskId] = seededTask;

  const harness = makeGoldenHarness({ initialState });
  const kernel = new OrchestrationStateKernel({});
  const lifecycle = new TaskLifecycleService(
    {
      now: harness.deps.now,
      createId: harness.deps.createId,
      loadState: harness.deps.loadState,
      saveState: harness.deps.saveState,
      config: harness.deps.config,
    },
    kernel,
  );

  const result = await lifecycle.recordTaskProgress("t1", "halfway there");
  expect(result.lastProgressSummary).toBe("halfway there");
  expect(result.lastProgressAt).toBe("2026-04-13T10:00:00.000Z");

  const persisted = harness.getState().orchestration.tasks["t1"];
  expect(persisted.lastProgressSummary).toBe("halfway there");
  expect(persisted.updatedAt).toBe("2026-04-13T10:00:00.000Z");
  const progressEvents = (persisted.events ?? []).filter((event) => event.type === "progress");
  expect(progressEvents.length).toBe(1);
  expect(progressEvents[0]!.summary).toBe("halfway there");
});
