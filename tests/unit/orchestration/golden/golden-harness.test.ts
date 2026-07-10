// tests/unit/orchestration/golden/golden-harness.test.ts
//
// The oracle's own oracle.
//
// The per-save digest in golden-harness.ts had four blind spots, found one per review
// round, all of them the same mistake: the digest projected. It recorded only `tasks`; then
// it dropped each task's `events` and let the map key overwrite a record's identity; then a
// `?? {}` fallback rendered a *missing* collection identically to an *empty* one; then the
// collection list was hand-written twice and could drift from what was emitted.
//
// Each was demonstrated with a throwaway mutation and fixed. Those mutations proved the fix
// once, on the day. They do not survive into next year, when someone refactors this harness
// and reintroduces a projection because it looked redundant.
//
// So: pin the digest's contract directly. These tests drive `deps.saveState` and read
// `harness.calls`; they never go through OrchestrationService. If one of them fails, the
// oracle has gone blind — the thirty golden fixtures may still pass while no longer proving
// what they claim to prove.
import { expect, test } from "bun:test";

import type { AppState } from "../../../../src/state/types";
import { createEmptyState } from "../../../../src/state/types";
import { makeGoldenHarness } from "./golden-harness";

interface SaveDigest {
  [collection: string]: Array<{ key: string; value: unknown }>;
}

/** Drive one save and return the recorded digest. */
async function digestOf(state: AppState): Promise<SaveDigest> {
  const harness = makeGoldenHarness();
  await harness.deps.saveState(state);
  const saves = harness.calls.filter((call) => call.port === "saveState");
  expect(saves.length).toBe(1);
  return saves[0]!.request as SaveDigest;
}

function seedTask(taskId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

test("every runtime collection is recorded, including one the type does not declare", async () => {
  // The digest is generated from the state's own keys. A collection added to
  // OrchestrationState must enter the digest with no edit here, or it goes unrecorded while
  // CI stays green. Two hand-written lists -- a constant and an object literal -- could
  // drift from each other; there is now one source of truth, and this test is what says so.
  const state = createEmptyState();
  (state.orchestration as unknown as Record<string, unknown>)["scheduledBatches"] = {
    "batch-1": { id: "batch-1" },
  };

  const digest = await digestOf(state);

  expect(Object.keys(digest).sort()).toEqual([
    "coordinatorQuestionState",
    "coordinatorRoutes",
    "externalCoordinators",
    "groups",
    "humanQuestionPackages",
    "scheduledBatches",
    "tasks",
    "workerBindings",
  ]);
  expect(digest["scheduledBatches"]).toEqual([{ key: "batch-1", value: { id: "batch-1" } }]);
});

test("a missing collection is distinguishable from an empty one", async () => {
  // A `?? {}` fallback rendered both as `[]`. A change that deleted a collection before one
  // save and restored it as `{}` before the next was then invisible: same digest, same final
  // AppState, same port-call log -- but a crash between the two saves recovers differently.
  const empty = createEmptyState();
  const missing = createEmptyState();
  delete (missing.orchestration as unknown as Record<string, unknown>)["externalCoordinators"];

  const emptyDigest = await digestOf(empty);
  const missingDigest = await digestOf(missing);

  expect(emptyDigest["externalCoordinators"]).toEqual([]);
  expect(missingDigest).not.toHaveProperty("externalCoordinators");
  expect(missingDigest).not.toEqual(emptyDigest);
});

test("a record's own identity survives the map key that stores it", async () => {
  // `{ ...record, key }` would stamp the map key over the record's own identity field, so an
  // intermediate save holding `tasks["t1"].taskId === "t2"` would look correct. `{ key, value }`
  // keeps both, and the disagreement is observable.
  const state = createEmptyState();
  state.orchestration.tasks["t1"] = seedTask("t2") as never; // deliberately inconsistent

  const digest = await digestOf(state);

  expect(digest["tasks"]).toHaveLength(1);
  expect(digest["tasks"]![0]!.key).toBe("t1");
  expect((digest["tasks"]![0]!.value as { taskId: string }).taskId).toBe("t2");
});

test("task events are recorded in full, not summarised by eventSeq", async () => {
  // `eventSeq` counts appends; it does not describe them. Dropping `events` from the digest
  // hid a change that wrote an event's message early and corrected it before the next save.
  const state = createEmptyState();
  state.orchestration.tasks["t1"] = seedTask("t1", {
    eventSeq: 2,
    events: [
      { seq: 1, at: "2026-04-13T09:00:00.000Z", type: "created", status: "running", message: "first" },
      { seq: 2, at: "2026-04-13T09:30:00.000Z", type: "progress", status: "running", message: "second" },
    ],
  }) as never;

  const digest = await digestOf(state);

  const task = digest["tasks"]![0]!.value as { events: Array<{ message: string }> };
  expect(task.events.map((event) => event.message)).toEqual(["first", "second"]);
});

test("collection entries are sorted by key, so entry order is not the insertion order", async () => {
  const state = createEmptyState();
  state.orchestration.tasks["t-b"] = seedTask("t-b") as never;
  state.orchestration.tasks["t-a"] = seedTask("t-a") as never;

  const digest = await digestOf(state);

  expect(digest["tasks"]!.map((entry) => entry.key)).toEqual(["t-a", "t-b"]);
});

test("a collection that is not a keyed record fails loudly", async () => {
  // Silently skipping it would narrow the digest. There is no `?? {}`, and no `typeof` check
  // that shrugs.
  const state = createEmptyState();
  (state.orchestration as unknown as Record<string, unknown>)["tasks"] = "not a record";

  const harness = makeGoldenHarness();
  await expect(harness.deps.saveState(state)).rejects.toThrow(/is not a record/);
});
