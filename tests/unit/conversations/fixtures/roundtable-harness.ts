import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planRoundtable, type RoundtablePlan } from "../../../../src/conversations/conversation-roundtable";
import type { AcceptRequestResult, ClaimedWork } from "../../../../src/conversations/conversation-store";
import { SqliteConversationStore } from "../../../../src/conversations/sqlite-conversation-store";

export const RT_NOW = "2026-11-06T00:00:00.000Z";
export const RT_LEASE = "2026-11-06T01:00:00.000Z";
export const RT_CONVERSATION = "conversation_roundtable";
export const RT_TOPIC = "topic_roundtable";
export const RT_SNAPSHOT = {
  revision: 1,
  capturedAt: RT_NOW,
  presentation: { name: "Speaker" },
  behavior: {},
  execution: { agent: "codex", workspace: "backend" },
};
export const RT_OWNER = "owner";

export function roundtablePath(): string {
  return join(mkdtempSync(join(tmpdir(), "xacpx-roundtable-")), "conversations.sqlite");
}

export async function openRoundtableStore(path = ":memory:"): Promise<SqliteConversationStore> {
  return SqliteConversationStore.open(path, { followupRedispatch: true });
}

export interface AcceptRoundtableOptions {
  botIds?: string[];
  rounds?: number;
  leadBotId?: string;
  requestId?: string;
  conversationId?: string;
  topicId?: string;
  now?: string;
  plan?: RoundtablePlan;
  maxMemberTurns?: number;
}

/** Accept exactly what the run service would: one plan, one transaction. */
export function acceptRoundtable(
  store: SqliteConversationStore,
  options: AcceptRoundtableOptions = {},
): AcceptRequestResult {
  const plan = options.plan ?? planRoundtable({
    botIds: options.botIds ?? ["bot_a", "bot_b"],
    ...(options.rounds !== undefined ? { rounds: options.rounds } : {}),
    ...(options.leadBotId !== undefined ? { leadBotId: options.leadBotId } : {}),
  });
  const members = plan.turns.map((turn) => ({
    botId: turn.botId,
    profileSnapshot: RT_SNAPSHOT,
    roundIndex: turn.roundIndex,
    speakerIndex: turn.speakerIndex,
  }));
  const [primary, ...rest] = members;
  if (!primary) throw new Error("empty plan");
  return store.acceptRequest({
    conversationId: options.conversationId ?? RT_CONVERSATION,
    topicId: options.topicId ?? RT_TOPIC,
    requestId: options.requestId ?? `rt-${Math.random()}`,
    botId: primary.botId,
    content: "Discuss the rollout",
    profileSnapshot: primary.profileSnapshot,
    primaryMember: { roundIndex: primary.roundIndex, speakerIndex: primary.speakerIndex },
    members: rest,
    shape: "roundtable",
    rounds: plan.rounds,
    ...(plan.leadBotId !== undefined ? { leadBotId: plan.leadBotId } : {}),
    maxMemberTurns: options.maxMemberTurns ?? plan.turns.length,
    now: options.now ?? RT_NOW,
  });
}

export function claimNext(
  store: SqliteConversationStore,
  options: { runId?: string; now?: string; owner?: string } = {},
): ClaimedWork | undefined {
  return store.claimNextDispatch({
    owner: options.owner ?? RT_OWNER,
    now: options.now ?? RT_NOW,
    leaseExpiresAt: RT_LEASE,
    ...(options.runId !== undefined ? { runId: options.runId } : {}),
  });
}

/** Claim + start one expected turn, returning the started member row. */
export function startTurn(
  store: SqliteConversationStore,
  runId: string,
  expectedMemberTurnId: string,
  now = RT_NOW,
) {
  const claim = claimNext(store, { runId, now });
  if (!claim) throw new Error("no claimable dispatch");
  if (claim.memberTurn.id !== expectedMemberTurnId) {
    throw new Error(`claimed ${claim.memberTurn.id}, expected ${expectedMemberTurnId}`);
  }
  const sourceTurnId = `source_${claim.memberTurn.memberIndex}`;
  const started = store.markExecutionStarted({
    dispatchId: claim.dispatch.id,
    owner: RT_OWNER,
    generation: claim.dispatch.generation,
    runId,
    memberTurnId: claim.memberTurn.id,
    sessionAlias: "session",
    logicalSessionId: "logical",
    sourceTurnId,
    now,
  });
  return { started, sourceTurnId, claim };
}

export function completeTurn(
  store: SqliteConversationStore,
  runId: string,
  expectedMemberTurnId: string,
  options: { content?: string; pass?: boolean; now?: string; completionReason?: string } = {},
) {
  const live = store.getMemberTurn(expectedMemberTurnId);
  const { started, sourceTurnId } = live?.state === "running"
    ? { started: live, sourceTurnId: live.sourceTurnId! }
    : startTurn(store, runId, expectedMemberTurnId, options.now);
  return store.completeExecution({
    runId,
    memberTurnId: started.id,
    content: options.pass ? "(pass)" : options.content ?? `speech from ${started.botId}`,
    sourceTurn: { sessionAlias: "session", turnId: sourceTurnId },
    now: options.now ?? RT_NOW,
    ...(options.pass ? { speechOutcome: "pass" as const } : {}),
    ...(options.completionReason ? { completionReason: options.completionReason } : {}),
  });
}

export function failTurn(
  store: SqliteConversationStore,
  runId: string,
  expectedMemberTurnId: string,
  reason = "provider-failed",
  now = RT_NOW,
) {
  const { started, sourceTurnId } = startTurn(store, runId, expectedMemberTurnId, now);
  return store.failExecution({ runId, memberTurnId: started.id, sourceTurnId, reason, now });
}
