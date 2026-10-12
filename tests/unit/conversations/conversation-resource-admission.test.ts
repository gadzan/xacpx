import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ResourceReservationTable,
  ResourceAdmissionError,
  canonicalizePhysicalPath,
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
  // Two owned worktrees may share a path prefix; the id keeps them distinct.
  expect(physicalResourceKey(worktree("a"))).not.toBe(physicalResourceKey(worktree("b")));
  // The cwd is part of the key, so the SAME id at a different path is a
  // different resource. The id alone must never decide identity: that is what
  // let a worktree-bound and a workspace-bound execution at one directory key
  // apart and run two writers on it.
  expect(physicalResourceKey(worktree("a"))).not.toBe(physicalResourceKey({ cwd: "/different", worktreeId: "a", isolation: "worktree-per-member" }));
  expect(physicalResourceKey(worktree("a"))).toBe(physicalResourceKey({ cwd: "/wt/a", worktreeId: "a", isolation: "worktree-per-member" }));
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

// --- Review round 2, P1-4: one physical directory must yield ONE key ----------

test("a symlinked workspace folds to the same physical key as its target", async () => {
  // Two configured workspaces reached through a symlink are ONE directory. If
  // they key differently, two writers are admitted to the same physical tree —
  // the exact failure cross-Run admission exists to prevent.
  const root = await mkdtemp(join(tmpdir(), "xacpx-alias-"));
  const target = join(root, "target");
  await mkdir(target, { recursive: true });
  const link = join(root, "link");
  await symlink(target, link, "dir").catch(() => {});
  // On a platform without symlink privileges the test cannot express the alias;
  // skip rather than pass vacuously.
  let linked = true;
  try {
    const viaLink = await stat(link);
    const viaTarget = await stat(target);
    linked = viaLink.ino === viaTarget.ino;
  } catch {
    linked = false;
  }
  if (linked) {
    expect(canonicalizePhysicalPath(link)).toBe(canonicalizePhysicalPath(target));
    expect(physicalResourceKey(shared(canonicalizePhysicalPath(link))))
      .toBe(physicalResourceKey(shared(canonicalizePhysicalPath(target))));
  }
  await rm(root, { recursive: true, force: true });
});

test("distinct directories still produce distinct physical keys", async () => {
  // The canonical rule must not over-fold: two genuinely different directories
  // must never collapse into one key, or unrelated Runs would serialize forever.
  const root = await mkdtemp(join(tmpdir(), "xacpx-distinct-"));
  const a = join(root, "a");
  const b = join(root, "b");
  await mkdir(a, { recursive: true });
  await mkdir(b, { recursive: true });
  expect(canonicalizePhysicalPath(a)).not.toBe(canonicalizePhysicalPath(b));
  expect(physicalResourceKey(shared(canonicalizePhysicalPath(a))))
    .not.toBe(physicalResourceKey(shared(canonicalizePhysicalPath(b))));
  await rm(root, { recursive: true, force: true });
});

test("Windows spellings of one directory fold together through the shared rule", () => {
  // The identity must use the SAME normalization the worktree manager verifies
  // worktrees with: extended-length `\\?\` prefixes, separator and case folding,
  // and trailing separators are all the same filesystem location. A second,
  // weaker rule here would let one directory read as two resources.
  if (process.platform !== "win32") return;
  const spellings = [
    "C:\\Users\\dev\\repo",
    "c:/users/dev/repo",
    "C:\\Users\\dev\\repo\\",
    "\\\\?\\C:\\Users\\dev\\repo",
  ];
  const keys = new Set(spellings.map((s) => canonicalizePhysicalPath(s)));
  expect(keys.size).toBe(1);
  expect(physicalResourceKey(shared(canonicalizePhysicalPath(spellings[0]!))))
    .toBe(physicalResourceKey(shared(canonicalizePhysicalPath(spellings[3]!))));
});

test("an empty or blank cwd is never a usable physical key", () => {
  // A reservation keyed on "" would collide every workspace into one resource.
  expect(canonicalizePhysicalPath("")).toBe("");
  expect(canonicalizePhysicalPath("   ")).toBe("");
});

// --- Review round 5: a worktree and a workspace at one path must collide -------

test("a worktree-bound and a workspace-bound identity at one path collide", async () => {
  // A managed worktree and a shared workspace can be configured to point at the
  // SAME physical directory. Keying them apart (worktree:<id> vs cwd:<path>)
  // would let two mutating Provider turns write that directory concurrently —
  // the exact failure cross-Run admission exists to prevent. The key is the
  // canonical cwd in both cases, with the worktree id refining it.
  const root = await mkdtemp(join(tmpdir(), "xacpx-r5-alias-"));
  const shared = join(root, "shared");
  await mkdir(shared, { recursive: true });
  const worktreeIdentity: PhysicalResourceIdentity = {
    cwd: shared,
    worktreeId: "wt-a",
    isolation: "worktree-per-member",
  };
  const workspaceIdentity: PhysicalResourceIdentity = {
    cwd: shared,
    isolation: "shared-single-writer",
  };
  expect(physicalResourceKey(worktreeIdentity)).toBe(physicalResourceKey(workspaceIdentity));
  // And the admission table therefore serializes them.
  const table = new ResourceReservationTable();
  table.add({
    key: physicalResourceKey(worktreeIdentity),
    runId: "run-a",
    memberTurnId: "m1",
    dispatchId: "d1",
    identity: worktreeIdentity,
    reader: false,
  });
  expect(canExecuteAlongside({ identity: workspaceIdentity, reader: false }, { identity: worktreeIdentity, reader: false })).toBe(false);
  expect(table.conflicts(workspaceIdentity, false)).toBeDefined();
  await rm(root, { recursive: true, force: true });
});

test("distinct worktrees still do not collide through the shared cwd key", async () => {
  // The worktree id is retained so two worktrees that merely share a path prefix
  // stay physically distinct — otherwise unrelated Runs would serialize forever.
  const a = worktree("wt-a");
  const b = worktree("wt-b");
  expect(physicalResourceKey(a)).not.toBe(physicalResourceKey(b));
  expect(canExecuteAlongside({ identity: a, reader: false }, { identity: b, reader: false })).toBe(true);
});

// --- Review round 6: the worktree identity branch must canonicalize too --------

test("the worktree branch of identity resolution folds through the one canonical rule", async () => {
  // Round-5 keyed both branches on the cwd, but only the workspace branch folded
  // it through canonicalizePhysicalPath; the worktree branch returned the raw
  // verified path. On Windows the same directory can surface as C:\Users\... via
  // one handle and c:\users\... via another, so the two spellings keyed apart
  // and two mutating Provider turns could reach one directory. The resolution
  // must fold the worktree path through the same rule — exactly one rule, never
  // one per branch — and an unfoldable path must fail closed.
  //
  // resolveSessionCwd returns r.worktreePath verbatim (no folding there), and
  // resolvePhysicalResourceIdentity is private, so this reaches it through the
  // same cast the cross-run suite already uses for dispatcher internals. The
  // stubbed manager returns an unfolded Windows spelling on every platform to
  // pin the wiring, not the platform's own case behaviour; the Windows-only
  // helper test above pins the spelling fold itself.
  const { ConversationDispatcher } = await import("../../../src/conversations/conversation-dispatcher");
  const unfolded = "C:\\Users\\Alice\\repo\\wt";
  const folded = canonicalizePhysicalPath(unfolded);
  expect(folded.length).toBeGreaterThan(0);
  const fakeWorktrees = { resolveSessionCwd: () => unfolded };
  const fakeRuntime = { groupTopicIsolation: () => "worktree-per-member" as const };
  const dispatcher = new ConversationDispatcher(
    {} as never, fakeRuntime as never, {} as never, {} as never, {},
  );
  (dispatcher as unknown as { worktrees: unknown }).worktrees = fakeWorktrees;
  const resolve = (
    dispatcher as unknown as {
      resolvePhysicalResourceIdentity: (
        work: { run: { conversationId: string; topicId: string } },
        session: { alias: string },
        ref: { worktreeId: string },
      ) => PhysicalResourceIdentity | undefined;
    }
  ).resolvePhysicalResourceIdentity.bind(dispatcher);
  const work = { run: { conversationId: "c", topicId: "t" } };
  const session = { alias: "s" };
  const identity = resolve(work, session, { worktreeId: "wt-a" })!;
  // The identity carries the folded cwd, with the worktree id retained...
  expect(identity.cwd).toBe(folded);
  expect(identity.worktreeId).toBe("wt-a");
  // ...so it collides with a workspace-bound identity at the same directory.
  expect(physicalResourceKey(identity)).toBe(physicalResourceKey({ cwd: folded, isolation: "shared-single-writer" }));
  // And a worktree path that cannot be canonicalized fails closed.
  (dispatcher as unknown as { worktrees: unknown }).worktrees = { resolveSessionCwd: () => { throw new Error("drift"); } };
  expect(resolve(work, session, { worktreeId: "wt-a" })).toBeUndefined();
});
