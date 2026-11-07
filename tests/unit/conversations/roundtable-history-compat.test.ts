import { expect, test } from "bun:test";
import { toRunDetail, toLegacyRunHistoryDetail, type ConversationRunDetailDto } from "../../../src/control/conversation-control-dtos";
import { isRunsDetailsBatchResult } from "../../../packages/relay-protocol/src/index";
import { acceptRoundtable, openRoundtableStore } from "./fixtures/roundtable-harness";

/** Mirror ControlService's history projection: the full profile snapshot is
 *  reduced to the history-safe presentation fields. */
function historyDetail(detail: ConversationRunDetailDto) {
  const { profileSnapshot, ...rest } = detail;
  return {
    ...rest,
    ...(profileSnapshot ? {
      profileSnapshot: {
        revision: profileSnapshot.revision,
        capturedAt: profileSnapshot.capturedAt,
        presentation: profileSnapshot.presentation,
      },
    } : {}),
  };
}

// The pre-roundtable history validator: exact key allowlists and the old
// origin vocabulary. A legacy projection must satisfy it unchanged.
const LEGACY_RUN_KEYS = [
  "id", "conversationId", "topicId", "requestMessageId", "requestId", "mode", "state", "completionReason",
  "profileRevision", "activeBatch", "maxMemberTurns", "budgetEpoch", "consumedMemberTurns", "failedBotIds",
  "unavailableBotIds", "quarantinedBotIds", "routingState", "routingReason", "waitingQuestion", "createdAt",
  "startedAt", "finishedAt", "abandonedAt", "controlRevision", "progressRevision", "pauseReason",
  "pauseRequestedAt", "pausedAt", "memberTurns", "profileSnapshot", "worktree",
] as const;
const LEGACY_MEMBER_KEYS = [
  "id", "runId", "conversationId", "topicId", "botId", "batch", "memberIndex", "attempt", "origin", "state",
  "effect", "effectProvenance", "promptRequestId", "createdAt", "startedAt", "finishedAt", "assignmentId",
  "task", "expectedOutput", "dependsOn", "failureReason", "blockedReason", "cancellationReason",
  "followupSenderMemberTurnId",
] as const;
const LEGACY_ORIGINS = ["human-explicit", "human", "router", "handoff", "followup", "retry", "recovery"] as const;

function legacyAccepts(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const batch = value as { runs?: unknown };
  if (!Array.isArray(batch.runs)) return false;
  return batch.runs.every((run) => {
    if (typeof run !== "object" || run === null) return false;
    const record = run as Record<string, unknown>;
    if (Object.keys(record).some((key) => !(LEGACY_RUN_KEYS as readonly string[]).includes(key))) return false;
    if (!Array.isArray(record.memberTurns)) return false;
    return record.memberTurns.every((member) => {
      if (typeof member !== "object" || member === null) return false;
      const turn = member as Record<string, unknown>;
      return Object.keys(turn).every((key) => (LEGACY_MEMBER_KEYS as readonly string[]).includes(key))
        && typeof turn.origin === "string" && (LEGACY_ORIGINS as readonly string[]).includes(turn.origin);
    });
  });
}

test("legacy history projection drops roundtable fields and keeps the old origin vocabulary", async () => {
  const store = await openRoundtableStore();
  try {
    const accepted = acceptRoundtable(store, { botIds: ["bot_a", "bot_b"], rounds: 2 });
    const run = store.getRun(accepted.run.id)!;
    const detail = historyDetail(toRunDetail(run, store.listMemberTurns(run.id)));
    const legacy = toLegacyRunHistoryDetail(detail);
    expect(legacy.runs === undefined).toBe(true);
    expect(legacy.shape).toBeUndefined();
    expect(legacy.rounds).toBeUndefined();
    expect(legacy.leadBotId).toBeUndefined();
    expect(legacy.memberTurns.every((turn) => turn.roundIndex === undefined
      && turn.speakerIndex === undefined && turn.speechOutcome === undefined)).toBe(true);
    expect(legacy.memberTurns.every((turn) => turn.origin === "human-explicit")).toBe(true);

    expect(legacyAccepts({ runs: [legacy] })).toBe(true);
    expect(isRunsDetailsBatchResult({ runs: [legacy] })).toBe(true);
    // The new validator accepts the full projection too.
    expect(isRunsDetailsBatchResult({ runs: [detail] })).toBe(true);
    // The old validator rejects the unprojected new fields, proving the gate
    // is what makes old clients keep working.
    expect(legacyAccepts({ runs: [detail] })).toBe(false);
  } finally {
    store.close();
  }
});

test("legacy history projection leaves a non-roundtable turn origin untouched", async () => {
  const store = await openRoundtableStore();
  try {
    const accepted = store.acceptRequest({
      conversationId: "conversation_roundtable",
      topicId: "topic_roundtable",
      requestId: "fanout-history",
      botId: "bot_a",
      content: "fanout",
      profileSnapshot: {
        revision: 1,
        capturedAt: "2026-11-06T00:00:00.000Z",
        presentation: { name: "A" },
        behavior: {},
        execution: { agent: "codex", workspace: "backend" },
      },
      shape: "fanout",
      now: "2026-11-06T00:00:00.000Z",
    });
    const run = store.getRun(accepted.run.id)!;
    const legacy = toLegacyRunHistoryDetail(historyDetail(toRunDetail(run, store.listMemberTurns(run.id))));
    expect(legacy.memberTurns[0]?.origin).toBe("followup");
    expect(legacy.shape).toBeUndefined();
    expect(isRunsDetailsBatchResult({ runs: [legacy] })).toBe(true);
  } finally {
    store.close();
  }
});
