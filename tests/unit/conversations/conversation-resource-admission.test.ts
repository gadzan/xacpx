import { expect, test } from "bun:test";
import {
  ResourceReservationTable,
  ResourceAdmissionError,
  physicalResourceKey,
  canExecuteAlongside,
  type PhysicalResourceIdentity,
} from "../../../src/conversations/conversation-resource-admission";
import {
  resolveMaxConcurrentRunExecutions,
  hasGlobalCapacity,
  TopicFairnessRotator,
  DEFAULT_MAX_CONCURRENT_RUN_EXECUTIONS,
  MAX_CONCURRENT_RUN_EXECUTIONS_LIMIT,
} from "../../../src/conversations/conversation-admission-policy";

const shared = (cwd = "/repo/shared"): PhysicalResourceIdentity => ({ cwd, isolation: "shared-single-writer" });
const other = (cwd = "/repo/other"): PhysicalResourceIdentity => ({ cwd, isolation: "shared-single-writer" });
const worktree = (id: string): PhysicalResourceIdentity => ({ cwd: `/wt/${id}`, worktreeId: id, isolation: "worktree-per-member" });

test("physical resource keys distinguish worktree id from cwd", () => {
  // Two owned worktrees may share a path prefix; only the id proves they are
  // physically distinct.
  expect(physicalResourceKey(worktree("a"))).not.toBe(physicalResourceKey(worktree("b")));
  expect(physicalResourceKey(worktree("a"))).toBe(physicalResourceKey({ cwd: "/different", worktreeId: "a", isolation: "worktree-per-member" }));
  expect(physicalResourceKey(shared("/x"))).not.toBe(physicalResourceKey(shared("/y")));
});

test("shared directory serializes unless BOTH sides are proven readers", () => {
  // Unknown/mutating work never overlaps on a shared directory.
  expect(canExecuteAlongside({ identity: shared(), reader: false }, { identity: shared(), reader: true })).toBe(false);
  expect(canExecuteAlongside({ identity: shared(), reader: true }, { identity: shared(), reader: false })).toBe(false);
  expect(canExecuteAlongside({ identity: shared(), reader: false }, { identity: shared(), reader: false })).toBe(false);
  // Both proven readers may share.
  expect(canExecuteAlongside({ identity: shared(), reader: true }, { identity: shared(), reader: true })).toBe(true);
});

test("distinct verified worktrees always permit overlap regardless of effect", () => {
  expect(canExecuteAlongside({ identity: worktree("a"), reader: false }, { identity: worktree("b"), reader: false })).toBe(true);
  // The same worktree id still conflicts: identity, not the flag, decides.
  expect(canExecuteAlongside({ identity: worktree("a"), reader: false }, { identity: worktree("a"), reader: true })).toBe(false);
});

test("the reservation table reports the blocking incumbent and releases per dispatch", () => {
  const table = new ResourceReservationTable();
  table.add({ key: physicalResourceKey(shared()), runId: "run-a", memberTurnId: "m1", dispatchId: "d1", identity: shared(), reader: false });
  // A second writer on the same directory is blocked and can see who blocks it.
  const conflict = table.conflicts(shared(), false);
  expect(conflict?.runId).toBe("run-a");
  // A reader is also blocked by an incumbent writer.
  expect(table.conflicts(shared(), true)?.runId).toBe("run-a");
  // A different directory is unaffected — no head-of-line blocking.
  expect(table.conflicts(other(), false)).toBeUndefined();
  // Release frees the resource for the same Run's next turn.
  table.release("d1");
  expect(table.conflicts(shared(), false)).toBeUndefined();
  expect(table.size).toBe(0);
});

test("proven readers share a directory until a writer arrives", () => {
  const table = new ResourceReservationTable();
  table.add({ key: physicalResourceKey(shared()), runId: "run-a", memberTurnId: "m1", dispatchId: "d1", identity: shared(), reader: true });
  table.add({ key: physicalResourceKey(shared()), runId: "run-b", memberTurnId: "m2", dispatchId: "d2", identity: shared(), reader: true });
  expect(table.size).toBe(2);
  // The unproven third arrival is blocked by the incumbents.
  expect(table.conflicts(shared(), false)).toBeDefined();
});

test("releaseRun drops only that Run's reservations", () => {
  const table = new ResourceReservationTable();
  table.add({ key: physicalResourceKey(shared()), runId: "run-a", memberTurnId: "m1", dispatchId: "d1", identity: shared(), reader: false });
  table.add({ key: physicalResourceKey(other()), runId: "run-b", memberTurnId: "m2", dispatchId: "d2", identity: other(), reader: false });
  table.releaseRun("run-a");
  expect(table.size).toBe(1);
  expect(table.conflicts(shared(), false)).toBeUndefined();
  // The unrelated Run keeps its reservation.
  expect(table.conflicts(other(), false)?.runId).toBe("run-b");
});

test("re-adding the same dispatch replaces rather than duplicates its reservation", () => {
  const table = new ResourceReservationTable();
  const base = { runId: "run-a", memberTurnId: "m1", dispatchId: "d1" };
  table.add({ ...base, key: physicalResourceKey(shared()), identity: shared(), reader: false });
  // Same dispatch, now on a different directory: the old entry must be gone, so
  // the previous directory is free and only the new one is held.
  table.add({ ...base, key: physicalResourceKey(other()), identity: other(), reader: false });
  expect(table.size).toBe(1);
  expect(table.conflicts(shared(), false)).toBeUndefined();
  expect(table.conflicts(other(), false)?.dispatchId).toBe("d1");
});

test("ResourceAdmissionError carries a machine-readable denial", () => {
  const error = new ResourceAdmissionError("shared-writer-conflict", "resource busy");
  expect(error).toBeInstanceOf(ResourceAdmissionError);
  expect(error.denial).toBe("shared-writer-conflict");
  expect(error.code).toBe("resource_admission_denied");
  // The denial is machine-readable so a caller can classify without parsing text.
  expect(new ResourceAdmissionError("worktree-identity-unproven", "x").denial).toBe("worktree-identity-unproven");
});

test("global admission defaults to a finite ceiling and rejects nonsense", () => {
  expect(resolveMaxConcurrentRunExecutions()).toBe(DEFAULT_MAX_CONCURRENT_RUN_EXECUTIONS);
  expect(resolveMaxConcurrentRunExecutions({})).toBe(DEFAULT_MAX_CONCURRENT_RUN_EXECUTIONS);
  // Nothing may disable the ceiling by accident.
  for (const bad of [0, -1, 1.5, NaN, Infinity, MAX_CONCURRENT_RUN_EXECUTIONS_LIMIT + 1]) {
    expect(resolveMaxConcurrentRunExecutions({ maxConcurrentRunExecutions: bad })).toBe(DEFAULT_MAX_CONCURRENT_RUN_EXECUTIONS);
  }
  expect(resolveMaxConcurrentRunExecutions({ maxConcurrentRunExecutions: 3 })).toBe(3);
  expect(resolveMaxConcurrentRunExecutions({ maxConcurrentRunExecutions: MAX_CONCURRENT_RUN_EXECUTIONS_LIMIT })).toBe(MAX_CONCURRENT_RUN_EXECUTIONS_LIMIT);
});

test("global capacity is a strict upper bound", () => {
  expect(hasGlobalCapacity(0, 1)).toBe(true);
  expect(hasGlobalCapacity(1, 1)).toBe(false);
  expect(hasGlobalCapacity(7, 8)).toBe(true);
  expect(hasGlobalCapacity(8, 8)).toBe(false);
});

test("Topic fairness rotates the last-served Topic to the back", () => {
  const rotator = new TopicFairnessRotator();
  const topics = [{ topicId: "a" }, { topicId: "b" }, { topicId: "c" }];
  // First pass is insertion order — nothing has been served yet.
  expect(rotator.order(topics).map((t) => t.topicId)).toEqual(["a", "b", "c"]);
  rotator.served("a");
  // The Topic that just ran moves behind the others, so a high-traffic Topic
  // cannot take consecutive turns while another waits.
  expect(rotator.order(topics).map((t) => t.topicId)).toEqual(["b", "c", "a"]);
  rotator.served("b");
  expect(rotator.order(topics).map((t) => t.topicId)).toEqual(["c", "a", "b"]);
});

test("Topic fairness degrades safely with one Topic or an unknown last-served", () => {
  const rotator = new TopicFairnessRotator();
  expect(rotator.order([{ topicId: "only" }]).map((t) => t.topicId)).toEqual(["only"]);
  rotator.served("gone");
  const topics = [{ topicId: "a" }, { topicId: "b" }];
  expect(rotator.order(topics).map((t) => t.topicId)).toEqual(["a", "b"]);
});
