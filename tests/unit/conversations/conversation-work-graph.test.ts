import { expect, test } from "bun:test";
import {
  buildWaitingGraph,
  decideRunCompletion,
  deriveWorkId,
  projectWorkOutcome,
  waitingCyclePath,
} from "../../../src/conversations/conversation-work-graph";
import type { ConversationRun, MemberTurnRecord } from "../../../src/conversations/conversation-types";

const NOW = "2026-10-05T00:00:00.000Z";

interface TurnSpec {
  id: string;
  botId?: string;
  state?: MemberTurnRecord["state"];
  batch?: number;
  memberIndex?: number;
  handoffSourceTurnId?: string;
  followupSenderMemberTurnId?: string;
  sourceTurnId?: string;
  failureReason?: string;
  cancellationReason?: "human-cancelled";
}

function turn(spec: TurnSpec): MemberTurnRecord {
  return {
    id: spec.id,
    runId: "run",
    conversationId: "conversation",
    topicId: "topic",
    botId: spec.botId ?? "bot_a",
    batch: spec.batch ?? 1,
    memberIndex: spec.memberIndex ?? 0,
    attempt: 1,
    origin: spec.followupSenderMemberTurnId ? "followup" : spec.handoffSourceTurnId ? "handoff" : "human-explicit",
    state: spec.state ?? "completed",
    triggerMessageIds: [],
    createdAt: NOW,
    ...(spec.handoffSourceTurnId !== undefined ? { handoffSourceTurnId: spec.handoffSourceTurnId } : {}),
    ...(spec.followupSenderMemberTurnId !== undefined ? { followupSenderMemberTurnId: spec.followupSenderMemberTurnId } : {}),
    ...(spec.sourceTurnId !== undefined ? { sourceTurnId: spec.sourceTurnId } : {}),
    ...(spec.failureReason !== undefined ? { failureReason: spec.failureReason } : {}),
    ...(spec.cancellationReason !== undefined ? { cancellationReason: spec.cancellationReason } : {}),
  };
}

function runFixture(overrides: Partial<ConversationRun> = {}): ConversationRun {
  return {
    id: "run",
    conversationId: "conversation",
    topicId: "topic",
    requestMessageId: "request",
    requestId: "request",
    mode: "explicit",
    state: "running",
    generation: 1,
    maxMemberTurns: 8,
    consumedMemberTurns: 0,
    budgetEpoch: 0,
    failedBotIds: [],
    unavailableBotIds: [],
    profileRevision: 1,
    profileSnapshot: { revision: 1, capturedAt: NOW, presentation: { name: "A" }, behavior: {}, execution: {} },
    createdAt: NOW,
    ...overrides,
  };
}

function graph(turns: MemberTurnRecord[], run = runFixture(), allocationUsed = turns.length) {
  return buildWaitingGraph(run, turns, { allocationUsed, runCancelling: false, budgetExhausted: false });
}

const leader = turn({ id: "a", sourceTurnId: "source_a" });
const childB = turn({ id: "b", botId: "bot_b", memberIndex: 1, handoffSourceTurnId: "source_a", sourceTurnId: "source_b" });
const wakeA = turn({ id: "wake_a", memberIndex: 2, followupSenderMemberTurnId: "a", state: "queued" });

test("a wake continues its sender's work item and handoff children are own items", () => {
  const turns = [leader, childB, wakeA];
  const byId = new Map(turns.map((entry) => [entry.id, entry]));
  expect(deriveWorkId(leader, byId)).toBe("a");
  expect(deriveWorkId(wakeA, byId)).toBe("a");
  expect(deriveWorkId(childB, byId)).toBe("b");
  const built = graph(turns);
  expect(built.nodes.map((node) => node.workId).sort()).toEqual(["a", "b"]);
  expect(built.byWorkId.get("a")!.phase).toBe("deciding");
  expect(built.byWorkId.get("a")!.frontierMemberTurnId).toBe("wake_a");
  expect(built.byWorkId.get("b")!.parentWorkId).toBe("a");
  expect(() => deriveWorkId(turn({ id: "orphan", followupSenderMemberTurnId: "missing" }), new Map())).toThrow("lost its sender");
});

test("open work keeps the Run running with the matching §4.4 check", () => {
  const running = graph([turn({ id: "a", state: "running", sourceTurnId: "source_a" })]);
  expect(decideRunCompletion(running, "a")).toMatchObject({ kind: "open", checks: [1] });

  const waiting = graph([leader, turn({ id: "b", botId: "bot_b", memberIndex: 1, handoffSourceTurnId: "source_a",
    sourceTurnId: "source_b", state: "running" })]);
  expect(decideRunCompletion(waiting, "b")).toMatchObject({ kind: "open", checks: [1] });
  expect(waiting.waitingWorkIds).toEqual(["a"]);

  const deciding = graph([leader, childB, wakeA]);
  expect(decideRunCompletion(deciding, "wake_a")).toMatchObject({ kind: "open", checks: [1, 4] });

  // Owed but not materialized: a completed sender with a delivered child and
  // no wake row yet.
  const owed = graph([leader, childB]);
  expect(owed.wakeOwedWorkIds).toEqual(["a"]);
  expect(decideRunCompletion(owed, "b")).toMatchObject({ kind: "open", checks: [3] });
});

test("a completed wake that named the failed child makes the Run completed", () => {
  const failedB = turn({ ...{ id: "b", botId: "bot_b", memberIndex: 1, handoffSourceTurnId: "source_a", sourceTurnId: "source_b" },
    state: "failed", failureReason: "broken" });
  const settledWake = turn({ ...{ id: "wake_a", memberIndex: 2, followupSenderMemberTurnId: "a" }, state: "completed" });
  const built = graph([leader, failedB, settledWake]);
  expect(built.nodes.some((node) => node.unobservedFailure)).toBe(false);
  expect(decideRunCompletion(built, "wake_a")).toMatchObject({ kind: "terminal", state: "completed" });
});

test("a failed wake, a failed root, and a skipped wake holding a failure all fail the Run", () => {
  const settledB = turn({ ...{ id: "b", botId: "bot_b", memberIndex: 1, handoffSourceTurnId: "source_a", sourceTurnId: "source_b" } });
  const failedWake = turn({ ...{ id: "wake_a", memberIndex: 2, followupSenderMemberTurnId: "a" },
    state: "failed", failureReason: "wake crashed" });
  expect(decideRunCompletion(graph([leader, settledB, failedWake]), "wake_a"))
    .toMatchObject({ kind: "terminal", state: "failed", reason: "execution-failed" });

  const failedRoot = turn({ id: "b", botId: "bot_b", state: "failed", failureReason: "execution-failed" });
  expect(decideRunCompletion(graph([failedRoot]), "b"))
    .toMatchObject({ kind: "terminal", state: "failed", reason: "execution-failed" });

  const failedB = turn({ ...{ id: "b", botId: "bot_b", memberIndex: 1, handoffSourceTurnId: "source_a", sourceTurnId: "source_b" },
    state: "failed", failureReason: "broken" });
  const skipped = buildWaitingGraph(runFixture({ maxMemberTurns: 2 }), [leader, failedB], {
    allocationUsed: 2, runCancelling: false, budgetExhausted: false,
  });
  expect(skipped.byWorkId.get("a")!.wakeSuppressedByBudget).toBe(true);
  expect(decideRunCompletion(skipped, "b")).toMatchObject({ kind: "terminal", state: "failed" });
});

test("a capacity-skipped wake still lets completed work report completed", () => {
  const skipped = buildWaitingGraph(runFixture({ maxMemberTurns: 2 }), [leader, childB], {
    allocationUsed: 2, runCancelling: false, budgetExhausted: false,
  });
  expect(decideRunCompletion(skipped, "b")).toMatchObject({ kind: "terminal", state: "completed" });
});

test("a reserved returning wake is an owed report, so the Run never seals", () => {
  // Same full window as the legacy skip above, but this sender reserved its
  // wake when it dispatched (§6.2): the report is owed, not spare capacity.
  const owed = buildWaitingGraph(runFixture({ maxMemberTurns: 2 }), [leader, childB], {
    allocationUsed: 2, runCancelling: false, budgetExhausted: false,
    reservedWakeTurnIds: new Set(["a"]),
  });
  expect(owed.byWorkId.get("a")!.wakeSuppressedByBudget).toBe(false);
  expect(owed.wakeOwedWorkIds).toEqual(["a"]);
  expect(owed.closed).toBe(false);
  expect(decideRunCompletion(owed, "b")).toMatchObject({ kind: "open", reason: "wake-pending", checks: [3] });
});

test("unknown results seal the Run and budget failure outranks completed unless the human stopped it", () => {
  const unknown = turn({ id: "b", botId: "bot_b", state: "indeterminate" });
  expect(decideRunCompletion(graph([unknown]), "b")).toMatchObject({ kind: "terminal", state: "indeterminate" });

  const budget = buildWaitingGraph(runFixture(), [leader], {
    allocationUsed: 1, runCancelling: false, budgetExhausted: true,
  });
  expect(decideRunCompletion(budget, "a")).toMatchObject({ kind: "terminal", state: "failed", reason: "budget-exhausted" });

  const humanStop = buildWaitingGraph(runFixture({ state: "cancelled" }), [leader], {
    allocationUsed: 1, runCancelling: true, budgetExhausted: true, runCancellationReason: "human-cancelled",
  });
  expect(decideRunCompletion(humanStop, "a")).toMatchObject({ kind: "terminal", state: "cancelled" });
});

test("a cycle is only a target that still waits on the sender's own line", () => {
  const b = turn({ id: "b", botId: "bot_b", memberIndex: 1, handoffSourceTurnId: "source_a", sourceTurnId: "source_b" });
  const c = turn({ id: "c", botId: "bot_c", memberIndex: 2, handoffSourceTurnId: "source_b", sourceTurnId: "source_c" });

  // A is merely executing: it waits on nothing in B's line, so the leaf would
  // queue and drain. Shared-Bot re-engagement is legal (§4.5).
  const executing = graph([turn({ id: "a", state: "running", sourceTurnId: "source_a" }), b, c]);
  expect(waitingCyclePath(executing, "c", "bot_a")).toBeUndefined();
  expect(waitingCyclePath(executing, "c", "bot_b")).toBeUndefined();
  expect(waitingCyclePath(executing, "c", "bot_d")).toBeUndefined();

  // A's own undelivered child is B, the branch C sits on: C waiting on A would
  // make A wait on its own unfinished result.
  const waiting = graph([turn({ id: "a", sourceTurnId: "source_a" }), turn({ ...b, state: "running" }), c]);
  expect(waitingCyclePath(waiting, "c", "bot_a")).toEqual(["a", "b", "c"]);

  // A waits on a sibling branch instead: its result does not depend on C.
  const sibling = turn({ id: "b2", botId: "bot_b2", memberIndex: 3, handoffSourceTurnId: "source_a", sourceTurnId: "source_b2", state: "running" });
  const parallel = graph([turn({ id: "a", sourceTurnId: "source_a" }), b, c, sibling]);
  expect(waitingCyclePath(parallel, "c", "bot_a")).toBeUndefined();

  // A settled ancestor is legal re-engagement: nothing is owed anymore.
  const settledWake = turn({ ...{ id: "wake_a", memberIndex: 4, followupSenderMemberTurnId: "a" }, state: "completed" });
  const closed = graph([leader, settledWake, b, c]);
  expect(waitingCyclePath(closed, "c", "bot_a")).toBeUndefined();
  expect(projectWorkOutcome(closed)).not.toHaveProperty("nodes");
});
