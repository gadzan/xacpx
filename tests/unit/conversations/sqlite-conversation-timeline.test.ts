import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqlDriver } from "../../../src/conversations/sql-driver";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { harness } from "./fixtures/concurrency-harness";
import {
  acceptRoundtable,
  completeTurn,
  openRoundtableStore,
  RT_CONVERSATION,
  RT_NOW,
  RT_TOPIC,
  roundtablePath,
  startTurn,
} from "./fixtures/roundtable-harness";

const NOW = "2026-11-07T00:00:00.000Z";
const LEASE = "2026-11-07T01:00:00.000Z";
const SNAPSHOT = {
  revision: 1,
  capturedAt: NOW,
  presentation: { name: "Member" },
  behavior: {},
  execution: { agent: "codex", workspace: "backend" },
};

function messagesOf(store: SqliteConversationStore, conversationId = RT_CONVERSATION, topicId = RT_TOPIC) {
  return store.listMessages({ conversationId, topicId, limit: 200 });
}

test("every bot/handoff insert point writes member_turn_id; a human request stays NULL", async () => {
  const fileStore = await openRoundtableStore(
    join(mkdtempSync(join(tmpdir(), "xacpx-timeline-")), "conversations.sqlite"),
  );
  try {
    const accepted = acceptRoundtable(fileStore, { botIds: ["bot_a", "bot_b"] });
    expect(fileStore.getMessage(accepted.message.id)?.memberTurnId).toBeUndefined();

    const members = fileStore.listMemberTurns(accepted.run.id);
    const first = members[0]!;
    const second = members[1]!;

    // group_say: the public message is attributed to its sender turn.
    const { started, sourceTurnId } = startTurn(fileStore, accepted.run.id, first.id);
    const said = fileStore.appendGroupSay({
      senderMemberTurnId: started.id,
      sourceTurnId,
      invocationId: "say-1",
      text: "draft speech",
      now: RT_NOW,
    });
    expect(said.message.memberTurnId).toBe(started.id);

    // normal reply: the identical final text adopts the group_say row, whose
    // durable attribution is already exact.
    const replied = completeTurn(fileStore, accepted.run.id, first.id, { content: "draft speech" });
    expect(replied.assistantMessage?.id).toBe(said.message.id);
    expect(replied.assistantMessage?.memberTurnId).toBe(first.id);

    // pass writes no message at all.
    completeTurn(fileStore, accepted.run.id, second.id, { pass: true });

    const human = messagesOf(fileStore).filter((message) => message.role === "human");
    expect(human).toHaveLength(1);
    expect(human[0]?.memberTurnId).toBeUndefined();
    expect(messagesOf(fileStore).filter((message) => message.role === "bot").map((message) => message.memberTurnId))
      .toEqual([first.id]);
  } finally {
    fileStore.close();
  }
});

test("handoff, cancel settlement and late-result messages are all attributed to their own turn", async () => {
  const store = await openRoundtableStore(roundtablePath());
  try {
    // Group fanout: a running leader dispatches one public handoff.
    const accepted = store.acceptRequest({
      conversationId: "conversation_group",
      topicId: "topic_group",
      botId: "bot_a",
      requestId: "timeline-handoff",
      content: "human request",
      profileSnapshot: SNAPSHOT,
      maxMemberTurns: 6,
      now: NOW,
    });
    const claim = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })!;
    const leader = store.markExecutionStarted({
      dispatchId: claim.dispatch.id,
      owner: "owner",
      generation: claim.dispatch.generation,
      runId: accepted.run.id,
      memberTurnId: claim.memberTurn.id,
      sessionAlias: "session_a",
      logicalSessionId: "logical_a",
      sourceTurnId: "source_a",
      now: NOW,
    });
    const handoff = store.acceptPublicHandoff({
      senderMemberTurnId: leader.id,
      sourceTurnId: "source_a",
      dispatchId: claim.dispatch.id,
      owner: "owner",
      generation: claim.dispatch.generation,
      invocationId: "handoff-1",
      args: { to: "bot_b", task: "check the lock" },
      profileSnapshot: SNAPSHOT,
      now: NOW,
    });
    expect(handoff.message.handoff?.senderMemberTurnId).toBe(leader.id);
    expect(handoff.message.memberTurnId).toBe(leader.id);

    // Cancel settlement: a member that finished under durable cancel intent.
    const cancelled = store.acceptRequest({
      conversationId: "conversation_cancel",
      topicId: "topic_cancel",
      botId: "bot_a",
      requestId: "timeline-cancel",
      content: "human request",
      profileSnapshot: SNAPSHOT,
      maxMemberTurns: 2,
      now: NOW,
    });
    const cancelClaim = store.claimNextDispatch({
      owner: "owner",
      runId: cancelled.run.id,
      now: NOW,
      leaseExpiresAt: LEASE,
    })!;
    const settling = store.markExecutionStarted({
      dispatchId: cancelClaim.dispatch.id,
      owner: "owner",
      generation: cancelClaim.dispatch.generation,
      runId: cancelled.run.id,
      memberTurnId: cancelClaim.memberTurn.id,
      sessionAlias: "session_b",
      logicalSessionId: "logical_b",
      sourceTurnId: "source_b",
      now: NOW,
    });
    store.cancelRun(cancelled.run.id, NOW, "human-cancelled");
    const settled = store.settleCancelBatch({
      runId: cancelled.run.id,
      now: NOW,
      outcomes: [{
        memberTurnId: settling.id,
        outcome: "completed",
        content: "settled while cancelling",
        sourceTurn: { sessionAlias: "session_b", turnId: "source_b" },
      }],
    });
    expect(settled.settled[0]?.message?.memberTurnId).toBe(settling.id);

    // Late result: an indeterminate seal reclassified by a proven result.
    const late = store.acceptRequest({
      conversationId: "conversation_late",
      topicId: "topic_late",
      botId: "bot_a",
      requestId: "timeline-late",
      content: "human request",
      profileSnapshot: SNAPSHOT,
      maxMemberTurns: 2,
      now: NOW,
    });
    const lateClaim = store.claimNextDispatch({
      owner: "owner",
      runId: late.run.id,
      now: NOW,
      leaseExpiresAt: LEASE,
    })!;
    const sealedMember = store.markExecutionStarted({
      dispatchId: lateClaim.dispatch.id,
      owner: "owner",
      generation: lateClaim.dispatch.generation,
      runId: late.run.id,
      memberTurnId: lateClaim.memberTurn.id,
      sessionAlias: "session_c",
      logicalSessionId: "logical_c",
      sourceTurnId: "source_c",
      now: NOW,
    });
    store.cancelRun(late.run.id, NOW, "human-cancelled");
    const sealed = store.settleCancelBatch({
      runId: late.run.id,
      now: NOW,
      outcomes: [{ memberTurnId: sealedMember.id, outcome: "unknown" }],
    });
    expect(sealed.run.state).toBe("indeterminate");
    const reconciled = store.reconcileLateResult({
      runId: late.run.id,
      memberTurnId: sealedMember.id,
      outcome: "completed",
      content: "late proof",
      sourceTurn: { sessionAlias: "session_c", turnId: "source_c" },
      now: NOW,
    });
    expect(reconciled.reconciled).toBe(true);
    expect(reconciled.message?.memberTurnId).toBe(sealedMember.id);
  } finally {
    store.close();
  }
});

test("the upgrade backfill writes only provable legs; ambiguity stays NULL", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-timeline-backfill-")), "conversations.sqlite");
  const store = await SqliteConversationStore.open(path);
  let runId: string;
  let leaderId: string;
  let childIds: string[];
  let handoffMessageId: string;
  let sayMessageId: string;
  try {
    const accepted = store.acceptRequest({
      conversationId: "conversation_group",
      topicId: "topic_group",
      botId: "bot_a",
      requestId: "backfill",
      content: "human request",
      profileSnapshot: SNAPSHOT,
      maxMemberTurns: 6,
      now: NOW,
    });
    runId = accepted.run.id;
    const claim = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })!;
    const leader = store.markExecutionStarted({
      dispatchId: claim.dispatch.id,
      owner: "owner",
      generation: claim.dispatch.generation,
      runId,
      memberTurnId: claim.memberTurn.id,
      sessionAlias: "session_a",
      logicalSessionId: "logical_a",
      sourceTurnId: "source_lead",
      now: NOW,
    });
    leaderId = leader.id;
    sayMessageId = store.appendGroupSay({
      senderMemberTurnId: leader.id,
      sourceTurnId: "source_lead",
      invocationId: "say-backfill",
      text: "public draft",
      now: NOW,
    }).message.id;
    handoffMessageId = store.acceptPublicHandoff({
      senderMemberTurnId: leader.id,
      sourceTurnId: "source_lead",
      dispatchId: claim.dispatch.id,
      owner: "owner",
      generation: claim.dispatch.generation,
      invocationId: "handoff-backfill",
      args: { to: "bot_b", task: "check the lock" },
      profileSnapshot: SNAPSHOT,
      now: NOW,
    }).message.id;
    store.acceptPublicHandoff({
      senderMemberTurnId: leader.id,
      sourceTurnId: "source_lead",
      dispatchId: claim.dispatch.id,
      owner: "owner",
      generation: claim.dispatch.generation,
      invocationId: "handoff-backfill-2",
      args: { to: "bot_c", task: "check the token" },
      profileSnapshot: SNAPSHOT,
      now: NOW,
    });
    childIds = store.listMemberTurns(runId)
      .filter((turn) => turn.id !== leader.id)
      .map((turn) => turn.id);
    expect(childIds).toHaveLength(2);
    store.completeExecution({
      runId,
      memberTurnId: leader.id,
      content: "leader reply",
      sourceTurn: { sessionAlias: "session_a", turnId: "source_lead" },
      now: NOW,
    });
    // Two turns sharing one source turn id make that join ambiguous.
    store.directWriteForTest("member_turns", childIds[0]!, { source_turn_id: "dup" });
    store.directWriteForTest("member_turns", childIds[1]!, { source_turn_id: "dup" });
  } finally {
    store.close();
  }

  // Simulate a pre-P1a database: no column, no index, and a legacy row that
  // only a source-turn join could attribute.
  const raw = await createSqlDriver(path);
  try {
    raw.exec("DROP INDEX IF EXISTS idx_messages_member_turn");
    raw.exec("ALTER TABLE messages DROP COLUMN member_turn_id");
    const max = raw.get<{ seq: number }>(
      "SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE conversation_id = ? AND topic_id = ?",
      ["conversation_group", "topic_group"],
    )!;
    raw.run(
      `INSERT INTO messages (id, conversation_id, topic_id, seq, role, sender_bot_id, content, run_id, source_turn_json, created_at)
       VALUES (?, ?, ?, ?, 'bot', ?, ?, ?, ?, ?)`,
      ["message_ambiguous", "conversation_group", "topic_group", Number(max.seq) + 1, "bot_a",
        "ambiguous legacy", runId!, JSON.stringify({ sessionAlias: "s", turnId: "dup" }), NOW],
    );
  } finally {
    raw.close();
  }

  const upgraded = await SqliteConversationStore.open(path);
  try {
    const byId = new Map(messagesOf(upgraded, "conversation_group", "topic_group").map((message) => [message.id, message]));
    const human = [...byId.values()].find((message) => message.role === "human");
    expect(human?.memberTurnId).toBeUndefined();
    // Unique source-turn match.
    expect([...byId.values()].find((message) => message.content === "leader reply")?.memberTurnId).toBe(leaderId);
    // Handoff envelope.
    expect(byId.get(handoffMessageId)?.memberTurnId).toBe(leaderId);
    // group_say marker.
    expect(byId.get(sayMessageId)?.memberTurnId).toBe(leaderId);
    // Two candidates: retained but unowned.
    expect(byId.get("message_ambiguous")?.memberTurnId).toBeUndefined();
  } finally {
    upgraded.close();
  }
});

test("the timeline read batches Runs and member turns instead of per-Run queries", async () => {
  const h = await harness();
  try {
    const { group, topic } = await h.group();
    const accepted = h.accept(group.id, topic.id, 2, true, "timeline-request");
    const claim = h.store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })!;
    const started = h.store.markExecutionStarted({
      dispatchId: claim.dispatch.id,
      owner: "owner",
      generation: claim.dispatch.generation,
      runId: accepted.run.id,
      memberTurnId: claim.memberTurn.id,
      sessionAlias: "session",
      logicalSessionId: "logical",
      sourceTurnId: "source",
      now: NOW,
    });
    const reply = h.store.completeExecution({
      runId: accepted.run.id,
      memberTurnId: started.id,
      content: "hello from the first member",
      sourceTurn: { sessionAlias: "session", turnId: "source" },
      now: NOW,
    }).assistantMessage!;

    // N+1 guard: the timeline must never fall back to one read per Run.
    const original = h.store.listMemberTurns.bind(h.store);
    let perRunReads = 0;
    h.store.listMemberTurns = (runId: string) => {
      perRunReads += 1;
      return original(runId);
    };

    const timeline = h.service.listTimeline({
      conversationId: group.id,
      topicId: topic.id,
      limit: 50,
    });
    expect(perRunReads).toBe(0);
    expect(timeline.entries.some(
      (entry) => entry.kind === "message" && entry.message.id === reply.id && entry.ownership === "exact",
    )).toBe(true);
    // The Run is still running, so its second member is an activity row and
    // no RoundStrip appears for a fanout Run.
    expect(timeline.entries.some((entry) => entry.kind === "activity")).toBe(true);
    expect(timeline.activeRound).toBeUndefined();

    // Non-terminal Runs are carried even when their request message is out of
    // the page window (here: only messages after the human request).
    const liveOnly = h.service.listTimeline({
      conversationId: group.id,
      topicId: topic.id,
      afterSeq: reply.seq - 1,
      limit: 10,
    });
    expect(liveOnly.entries.some((entry) => entry.kind === "message" && entry.message.id === reply.id)).toBe(true);
    expect(liveOnly.entries.some((entry) => entry.kind === "activity")).toBe(true);
    expect(liveOnly.hasMoreBefore).toBe(true);
  } finally {
    h.store.close();
  }
});
