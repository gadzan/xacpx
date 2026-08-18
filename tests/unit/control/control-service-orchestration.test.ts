import { expect, test } from "bun:test";

import { ControlService } from "../../../src/control/control-service";
import {
  createControlEventBus,
  type ControlEvent,
} from "../../../src/control/control-event-bus";
import type { OrchestrationTaskRecord } from "../../../src/orchestration/orchestration-types";

const task = {
  taskId: "task-1",
  sourceHandle: "h1",
  sourceKind: "human",
  coordinatorSession: "coord",
  workspace: "/ws/backend",
  targetAgent: "claude",
  task: "do the thing",
  status: "running",
  summary: "",
  resultText: "",
  createdAt: "2026-06-13T10:00:00.000Z",
  updatedAt: "2026-06-13T10:05:00.000Z",
} as OrchestrationTaskRecord;

function makeControl() {
  const events = createControlEventBus();
  const seen: ControlEvent[] = [];
  events.subscribe((event) => seen.push(event));
  const control = new ControlService({
    agent: { chat: async () => ({ text: "" }) },
    sessions: {} as never,
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: {} as never,
    orchestration: {
      listTasks: async () => [task],
      getTask: async (taskId: string) => (taskId === "task-1" ? task : null),
      requestTaskCancellation: async () => ({ ...task, status: "cancelled" }),
    },
    events,
  } as never);
  return { control, seen };
}

test("lists and fetches orchestration tasks", async () => {
  const { control } = makeControl();
  expect(await control.listOrchestrationTasks()).toEqual([task]);
  expect(await control.getOrchestrationTask("task-1")).toEqual(task);
  expect(await control.getOrchestrationTask("nope")).toBeNull();
});

test("cancelOrchestrationTask delegates and emits orchestration-changed", async () => {
  const { control, seen } = makeControl();
  const cancelled = await control.cancelOrchestrationTask({ taskId: "task-1" });
  expect(cancelled.status).toBe("cancelled");
  expect(seen).toContainEqual({ type: "orchestration-changed" });
});
