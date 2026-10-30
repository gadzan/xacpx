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

test("a waiting cycle names the open ancestor, and a settled ancestor is legal", () => {
  const running = turn({ id: "a", state: "running", sourceTurnId: "source_a" });
  const b = turn({ id: "b", botId: "bot_b", memberIndex: 1, handoffSourceTurnId: "source_a", sourceTurnId: "source_b" });
  const c = turn({ id: "c", botId: "bot_c", memberIndex: 2, handoffSourceTurnId: "source_b", sourceTurnId: "source_c" });
  const open = graph([running, b, c]);
  expect(waitingCyclePath(open, "c", "bot_a")).toEqual(["a", "b", "c"]);
  expect(waitingCyclePath(open, "c", "bot_b")).toEqual(["b", "c"]);
  expect(waitingCyclePath(open, "c", "bot_d")).toBeUndefined();
  // The same Bot is legal re-engagement once its work item is closed (its
  // wake has decided, so nothing is owed anymore).
  const settledWake = turn({ ...{ id: "wake_a", memberIndex: 2, followupSenderMemberTurnId: "a" }, state: "completed" });
  const closed = graph([leader, settledWake, b, c]);
  expect(waitingCyclePath(closed, "c", "bot_a")).toBeUndefined();
  expect(projectWorkOutcome(closed)).not.toHaveProperty("nodes");
});
