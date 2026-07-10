// tests/unit/orchestration/golden/golden-harness.test.ts
//
// The oracle's own oracle.
//
// The per-save digest in golden-harness.ts had five blind spots, found one per review round,
// all of them the same mistake: the digest projected. It recorded only `tasks`; then it
// dropped each task's `events` and let the map key overwrite a record's identity; then a
// `?? {}` fallback rendered a *missing* collection identically to an *empty* one; then the
// collection list was hand-written twice and could drift from what was emitted; then a
// `typeof x === "object"` guard admitted arrays, `Date`s and `Map`s, so `[]` and `{}` — which
// JSON distinguishes — digested alike.
//
// That last one arrived AFTER the first version of this file, and slipped past it: the
// non-record test only tried a string. A contract test is worth exactly the mutations it can
// survive, so each assertion below has been checked against the projection it exists to
// catch. Weaken one and it must go red. The events test earned its keep this way — asserting
// only on `event.message` passed against a digest that had thrown `seq`, `at`, `type` and
// `status` away.
//
// A sixth defect was not a projection but an atomicity bug, and belongs here for the same
// reason: a save that throws must add nothing to `calls` and must not advance `state`.
// Otherwise a fixture records a save that never landed, or `loadState` hands a service a
// state that was never persisted.
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
  //
  // Assert the events deep-equal, field for field. Comparing only `message` would let a
  // digest that projected `events.map(({ message }) => ({ message }))` pass a test named
  // "recorded in full" while `seq`, `at`, `type` and `status` all went missing.
  const expectedEvents = [
    { seq: 1, at: "2026-04-13T09:00:00.000Z", type: "created", status: "running", message: "first" },
    { seq: 2, at: "2026-04-13T09:30:00.000Z", type: "progress", status: "running", message: "second" },
  ];
  const state = createEmptyState();
  state.orchestration.tasks["t1"] = seedTask("t1", { eventSeq: 2, events: expectedEvents }) as never;

  const digest = await digestOf(state);

  const task = digest["tasks"]![0]!.value as { events: unknown[] };
  expect(task.events).toEqual(expectedEvents);
});

test("collection entries are sorted by key, so entry order is not the insertion order", async () => {
  const state = createEmptyState();
  state.orchestration.tasks["t-b"] = seedTask("t-b") as never;
  state.orchestration.tasks["t-a"] = seedTask("t-a") as never;

  const digest = await digestOf(state);

  expect(digest["tasks"]!.map((entry) => entry.key)).toEqual(["t-a", "t-b"]);
});

test.each([
  ["a string", "not a record"],
  // `typeof [] === "object"`, so a bare typeof check admits arrays — and `Object.keys` then
  // renders `["a"]` and `{"0": "a"}` into the same digest, empty `[]` and `{}` likewise,
  // while JSON keeps them apart.
  ["an empty array", []],
  ["a non-empty array", ["a"]],
  // `Date` and `Map` have no own enumerable keys, so they would digest as empty collections.
  ["a Date", new Date(0)],
  ["a Map", new Map([["k", "v"]])],
])("a collection that is %s fails loudly and does not commit the save", async (_label, value) => {
  // Silently skipping it, or rendering it as a keyed collection, would narrow the digest.
  // There is no `?? {}` and no `typeof` check that shrugs.
  const state = createEmptyState();
  state.orchestration.tasks["t1"] = seedTask("t1") as never;
  (state.orchestration as unknown as Record<string, unknown>)["externalCoordinators"] = value;

  const harness = makeGoldenHarness();
  const before = harness.getState();

  await expect(harness.deps.saveState(state)).rejects.toThrow(/is not a keyed record/);

  // A rejected save commits nothing: a service that catches the error and re-reads through
  // `loadState` must not observe a state that was never persisted.
  expect(harness.getState()).toEqual(before);
  expect(harness.calls.filter((call) => call.port === "saveState")).toEqual([]);
});

test("a save that fails outside the digest also commits nothing", async () => {
  // The digest guard is not the only thing that can throw. `cloneState` round-trips through
  // JSON, so a BigInt anywhere in AppState — or a cycle — rejects the save too. Cloning after
  // `record` left a `saveState` entry in `calls` for a save that never landed: `state` was
  // correct, the recorded call log was not, and only a fixture would have shown it.
  const state = createEmptyState();
  state.orchestration.tasks["t1"] = seedTask("t1") as never;
  (state as unknown as Record<string, unknown>)["nonOrchestrationProbe"] = 1n;

  const harness = makeGoldenHarness();
  const before = harness.getState();

  await expect(harness.deps.saveState(state)).rejects.toThrow(TypeError);

  expect(harness.getState()).toEqual(before);
  expect(harness.calls.filter((call) => call.port === "saveState")).toEqual([]);
});

test("an empty collection and an empty array do not digest alike", async () => {
  // The regression this pins: `externalCoordinators` written as `[]` before one save and
  // restored to `{}` before the next. Same final AppState, same port-call log, same save
  // count — and, under a `typeof` guard, the same digest on both saves.
  const asObject = createEmptyState();
  const asArray = createEmptyState();
  (asArray.orchestration as unknown as Record<string, unknown>)["externalCoordinators"] = [];

  const objectDigest = await digestOf(asObject);
  const arrayHarness = makeGoldenHarness();

  expect(objectDigest["externalCoordinators"]).toEqual([]);
  await expect(arrayHarness.deps.saveState(asArray)).rejects.toThrow(/is not a keyed record/);
});
