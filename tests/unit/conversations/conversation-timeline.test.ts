import { expect, test } from "bun:test";
import { projectConversationTimeline } from "../../../src/conversations/conversation-timeline";
import type { ConversationMessage, ConversationRun, MemberTurnRecord } from "../../../src/conversations/conversation-types";

const NOW = "2026-11-07T00:00:00.000Z";
const CONVERSATION = "conversation_timeline";
const TOPIC = "topic_timeline";
const SNAPSHOT = {
  revision: 1,
  capturedAt: NOW,
  presentation: { name: "Bot" },
  behavior: {},
  execution: { agent: "codex", workspace: "backend" },
};

function message(seq: number, patch: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: `m${seq}`,
    conversationId: CONVERSATION,
    topicId: TOPIC,
    seq,
    role: "bot",
    content: `message ${seq}`,
    createdAt: NOW,
    ...patch,
  };
}

function run(id: string, patch: Partial<ConversationRun> = {}): ConversationRun {
  return {
    id,
    conversationId: CONVERSATION,
    topicId: TOPIC,
    requestMessageId: `req-${id}`,
    requestId: id,
    mode: "explicit",
    state: "running",
    shape: "fanout",
    generation: 1,
    maxMemberTurns: 8,
    consumedMemberTurns: 0,
    failedBotIds: [],
    unavailableBotIds: [],
    profileRevision: 1,
    profileSnapshot: SNAPSHOT,
    createdAt: NOW,
    controlRevision: 0,
    progressRevision: 0,
    budgetEpoch: 0,
    ...patch,
  };
}

function turn(runId: string, id: string, patch: Partial<MemberTurnRecord> = {}): MemberTurnRecord {
  return {
    id,
    runId,
    conversationId: CONVERSATION,
    topicId: TOPIC,
    botId: "bot_a",
    batch: 1,
    memberIndex: 0,
    attempt: 1,
    origin: "human-explicit",
    state: "running",
    triggerMessageIds: [],
    createdAt: NOW,
    ...patch,
  };
}

function project(input: Parameters<typeof projectConversationTimeline>[0]) {
  return projectConversationTimeline({
    conversationId: CONVERSATION,
    topicId: TOPIC,
    hasMoreBefore: false,
    hasMoreAfter: false,
    ...input,
  });
}

test("each message appears exactly once, ordered by seq, even with duplicate rows", () => {
  const timeline = project({
    // Out of order + an exact duplicate row: the projection owns the order.
    messages: [message(2), message(1), message(2)],
    runs: [],
    memberTurns: [],
  });
  expect(timeline.entries.map((entry) => entry.kind)).toEqual(["message", "message"]);
  expect(timeline.entries.map((entry) => entry.anchorSeq)).toEqual([1, 2]);
  expect(new Set(timeline.entries.map((entry) => entry.key)).size).toBe(2);
  expect(timeline.oldestSeq).toBe(1);
  expect(timeline.newestSeq).toBe(2);
});

test("a handoff is one normal message owned exactly by its sender, with no extra entry", () => {
  const live = run("run_handoff");
  const sender = turn(live.id, "turn_sender", { botId: "bot_lead" });
  const child = turn(live.id, "turn_child", { botId: "bot_b", memberIndex: 1, state: "queued" });
  const handoff = message(2, {
    role: "system",
    senderBotId: "bot_lead",
    runId: live.id,
    handoff: {
      senderMemberTurnId: sender.id,
      to: "bot_b",
      assignmentId: "assignment_1",
      memberTurnId: child.id,
      task: "check the lock",
    },
  });
  const timeline = project({
    messages: [message(1, { role: "human", content: "go", runId: live.id }), handoff],
    runs: [live],
    memberTurns: [sender, child],
  });

  const entries = timeline.entries.filter((entry) => entry.kind === "message");
  expect(entries).toHaveLength(2);
  const handoffEntry = entries.find((entry) => entry.kind === "message" && entry.message.id === handoff.id);
  expect(handoffEntry).toMatchObject({
    kind: "message",
    memberTurnId: sender.id,
    ownership: "exact",
    anchorSeq: 2,
  });
  // A handoff is rendered as one line: it never adds an activity row, and the
  // human request carries no ownership at all.
  expect(timeline.entries.filter((entry) => entry.kind === "activity").map((entry) => entry.key))
    .toEqual(["activity:turn_child"]);
  expect(entries.find((entry) => entry.kind === "message" && entry.message.role === "human")?.ownership)
    .toBeUndefined();
});

test("activity exists only for a MemberTurn that wrote no public message", () => {
  const live = run("run_activity");
  const spoke = turn(live.id, "turn_spoke", { botId: "bot_a" });
  const silent = turn(live.id, "turn_silent", { botId: "bot_b", memberIndex: 1 });
  const timeline = project({
    messages: [message(1, { runId: live.id, memberTurnId: spoke.id, senderBotId: "bot_a" })],
    runs: [live],
    memberTurns: [spoke, silent],
  });
  const activities = timeline.entries.filter((entry) => entry.kind === "activity");
  expect(activities.map((entry) => entry.kind === "activity" && entry.memberTurn.id)).toEqual([silent.id]);
  // The speaking turn is represented by its message, not by a second row.
  expect(timeline.entries.filter((entry) => entry.kind === "message")).toHaveLength(1);
});

test("future queued roundtable turns are counts only, and the active round reports spoken/pass", () => {
  const live = run("run_round", { shape: "roundtable", rounds: 1 });
  const spoke = turn(live.id, "turn_r1s0", {
    state: "completed",
    speechOutcome: "message",
    roundIndex: 1,
    speakerIndex: 0,
    memberIndex: 0,
  });
  const skipped = turn(live.id, "turn_r1s1", {
    botId: "bot_b",
    state: "completed",
    speechOutcome: "pass",
    roundIndex: 1,
    speakerIndex: 1,
    memberIndex: 1,
  });
  const speaking = turn(live.id, "turn_r1s2", {
    botId: "bot_c",
    state: "running",
    roundIndex: 1,
    speakerIndex: 2,
    memberIndex: 2,
  });
  const future = turn(live.id, "turn_r1s3", {
    botId: "bot_d",
    state: "queued",
    roundIndex: 1,
    speakerIndex: 3,
    memberIndex: 3,
  });
  const timeline = project({
    messages: [message(1, { runId: live.id, memberTurnId: spoke.id, senderBotId: "bot_a" })],
    runs: [live],
    memberTurns: [spoke, skipped, speaking, future],
  });

  const activities = timeline.entries.filter((entry) => entry.kind === "activity");
  // Only the running speaker gets a row; the queued future speaker is a count.
  expect(activities.map((entry) => entry.kind === "activity" && entry.memberTurn.id)).toEqual([speaking.id]);
  expect(timeline.activeRound).toMatchObject({
    runId: live.id,
    roundIndex: 1,
    rounds: 1,
    speakerCount: 4,
    spoken: 1,
    passed: 1,
    activeMemberTurnId: speaking.id,
    state: "running",
  });
});

test("a non-terminal Run is carried even when its request message is outside the page", () => {
  const offPage = run("run_offpage");
  const waiting = turn(offPage.id, "turn_waiting", { state: "running" });
  const timeline = project({
    // The page belongs to another Run entirely.
    messages: [message(9, { runId: "run_elsewhere" })],
    runs: [offPage],
    memberTurns: [waiting],
    // The request row exists outside the page; the anchor uses its real seq.
    messageSeqById: { [`req-${offPage.id}`]: 3 },
  });
  const activity = timeline.entries.find((entry) => entry.kind === "activity");
  expect(activity).toMatchObject({ kind: "activity", anchorSeq: 3, runId: offPage.id });
});

test("activity anchors on the newest trigger message before the request fallback", () => {
  const live = run("run_anchor");
  const triggered = turn(live.id, "turn_triggered", {
    state: "running",
    triggerMessageIds: ["trigger_a", "trigger_b"],
  });
  const timeline = project({
    messages: [],
    runs: [live],
    memberTurns: [triggered],
    messageSeqById: { "trigger_a": 4, "trigger_b": 6, [`req-${live.id}`]: 2 },
  });
  expect(timeline.entries.find((entry) => entry.kind === "activity")?.anchorSeq).toBe(6);
});

test("an unresolved owner is retained and labelled instead of dropped", () => {
  const live = run("run_unresolved", { shape: "roundtable", rounds: 1 });
  const first = turn(live.id, "turn_u1", { botId: "bot_a", memberIndex: 0, state: "running" });
  const second = turn(live.id, "turn_u2", { botId: "bot_a", memberIndex: 1, state: "running" });
  const ambiguous = message(1, { runId: live.id, senderBotId: "bot_a", content: "legacy reply" });
  const timeline = project({
    messages: [ambiguous],
    runs: [live],
    memberTurns: [first, second],
  });
  const entry = timeline.entries.find((entry) => entry.kind === "message");
  expect(entry).toMatchObject({ kind: "message", ownership: "unresolved", anchorSeq: 1 });
  if (entry?.kind === "message") expect(entry.memberTurnId).toBeUndefined();
  // The ambiguous row proves nothing, so both turns still show as activity.
  expect(timeline.entries.filter((entry) => entry.kind === "activity")).toHaveLength(2);
});

test("the only same-Run/same-Bot candidate is an inferred owner", () => {
  const live = run("run_inferred");
  const only = turn(live.id, "turn_only", { botId: "bot_a" });
  const timeline = project({
    messages: [message(1, { runId: live.id, senderBotId: "bot_a", content: "legacy reply" })],
    runs: [live],
    memberTurns: [only],
  });
  const entry = timeline.entries.find((entry) => entry.kind === "message");
  expect(entry).toMatchObject({ kind: "message", memberTurnId: only.id, ownership: "inferred" });
  expect(timeline.entries.some((entry) => entry.kind === "activity")).toBe(false);
});

test("legacy exact joins stay exact: unique sourceTurn match", () => {
  const live = run("run_source");
  const matched = turn(live.id, "turn_source", { sourceTurnId: "source_7" });
  const timeline = project({
    messages: [message(1, { runId: live.id, senderBotId: "bot_a", sourceTurn: { sessionAlias: "s", turnId: "source_7" } })],
    runs: [live],
    memberTurns: [matched],
  });
  expect(timeline.entries.find((entry) => entry.kind === "message"))
    .toMatchObject({ memberTurnId: matched.id, ownership: "exact" });
});

test("queued, all-pass and failed Runs synthesize notices without writing messages", () => {
  const queued = run("run_queued", { state: "queued" });
  const allPass = run("run_allpass", {
    shape: "roundtable",
    state: "completed",
    completionReason: "roundtable-no-speech",
  });
  const failed = run("run_failed", { state: "failed", completionReason: "member-failed" });
  const timeline = project({
    messages: [],
    runs: [queued, allPass, failed],
    memberTurns: [],
    messageSeqById: {
      [`req-${queued.id}`]: 1,
      [`req-${allPass.id}`]: 2,
      [`req-${failed.id}`]: 3,
    },
  });
  const notices = timeline.entries.filter((entry) => entry.kind === "notice");
  expect(notices.map((entry) => entry.kind === "notice" && entry.tone))
    .toEqual(["queued", "empty", "failed"]);
  expect(notices.map((entry) => entry.anchorSeq)).toEqual([1, 2, 3]);
  // Notices are synthesized: no message row exists for any of them.
  expect(timeline.entries.every((entry) => entry.kind === "notice")).toBe(true);
});

test("pagination facts pass through and the oldest/newest seqs come from the page", () => {
  const timeline = project({
    messages: [message(10), message(12)],
    runs: [],
    memberTurns: [],
    hasMoreBefore: true,
    hasMoreAfter: true,
  });
  expect(timeline).toMatchObject({
    oldestSeq: 10,
    newestSeq: 12,
    hasMoreBefore: true,
    hasMoreAfter: true,
  });
});

test("a live overlay only marks the activity; no live text enters the projection", () => {
  const live = run("run_live");
  const speaking = turn(live.id, "turn_live", { state: "running" });
  const timeline = project({
    messages: [],
    runs: [live],
    memberTurns: [speaking],
    liveTurnsByMember: { [speaking.id]: { text: "streaming words", streaming: true } },
  });
  const activity = timeline.entries.find((entry) => entry.kind === "activity");
  expect(activity).toMatchObject({ kind: "activity", live: true });
  expect(JSON.stringify(timeline)).not.toContain("streaming words");
});

test("two calls over the same rows are byte-identical, regardless of input order", () => {
  const live = run("run_stable", { shape: "roundtable" });
  const turns = [
    turn(live.id, "turn_a", { memberIndex: 0, state: "completed", speechOutcome: "message", roundIndex: 1, speakerIndex: 0 }),
    turn(live.id, "turn_b", { botId: "bot_b", memberIndex: 1, state: "running", roundIndex: 1, speakerIndex: 1 }),
  ];
  const messages = [
    message(2, { runId: live.id, memberTurnId: "turn_a", senderBotId: "bot_a" }),
    message(1, { role: "human", runId: live.id, content: "go" }),
  ];
  const first = JSON.stringify(project({ messages, runs: [live], memberTurns: turns }));
  const second = JSON.stringify(project({
    messages: [...messages].reverse(),
    runs: [live],
    memberTurns: [...turns].reverse(),
  }));
  expect(second).toBe(first);
});

test("a later roundtable speaker's activity sorts after the earlier speaker's message", () => {
  const live = run("run_order", { shape: "roundtable", rounds: 1 });
  const human = message(1, { role: "human", runId: live.id, content: "go" });
  const spoke = turn(live.id, "turn_first", {
    botId: "bot_a",
    memberIndex: 0,
    state: "completed",
    speechOutcome: "message",
    roundIndex: 1,
    speakerIndex: 0,
    // Every roundtable turn is triggered by the same human request.
    triggerMessageIds: [human.id],
  });
  const speaking = turn(live.id, "turn_second", {
    botId: "bot_b",
    memberIndex: 1,
    state: "running",
    roundIndex: 1,
    speakerIndex: 1,
    triggerMessageIds: [human.id],
  });
  const timeline = project({
    messages: [human, message(2, { runId: live.id, memberTurnId: spoke.id, senderBotId: "bot_a" })],
    runs: [live],
    memberTurns: [spoke, speaking],
    messageSeqById: { [human.id]: 1 },
  });

  expect(timeline.entries.map((entry) => entry.key)).toEqual([
    `message:${human.id}`,
    "message:m2",
    `activity:${speaking.id}`,
  ]);
  // Anchored at the earlier speech (seq 2), not at the shared request (seq 1).
  expect(timeline.entries[2]).toMatchObject({ kind: "activity", anchorSeq: 2 });
});

test("a pass turn with no message contributes no anchor", () => {
  const live = run("run_pass_anchor", { shape: "roundtable", rounds: 1 });
  const human = message(1, { role: "human", runId: live.id, content: "go" });
  const skipped = turn(live.id, "turn_pass", {
    botId: "bot_a",
    memberIndex: 0,
    state: "completed",
    speechOutcome: "pass",
    roundIndex: 1,
    speakerIndex: 0,
    triggerMessageIds: [human.id],
  });
  const speaking = turn(live.id, "turn_next", {
    botId: "bot_b",
    memberIndex: 1,
    state: "running",
    roundIndex: 1,
    speakerIndex: 1,
    triggerMessageIds: [human.id],
  });
  const timeline = project({
    messages: [human],
    runs: [live],
    memberTurns: [skipped, speaking],
    messageSeqById: { [human.id]: 1 },
  });

  // A pass writes no public message, so the next speaker keeps the request
  // anchor and the stale sequence is never invented.
  const activity = timeline.entries.find((entry) => entry.kind === "activity");
  expect(activity).toMatchObject({ anchorSeq: 1 });
  expect(timeline.entries.filter((entry) => entry.kind === "activity")).toHaveLength(1);
});

test("an activity with no earlier message falls back to the request seq", () => {
  const live = run("run_first_speaker", { shape: "roundtable", rounds: 1 });
  const human = message(1, { role: "human", runId: live.id, content: "go" });
  const first = turn(live.id, "turn_first_speaker", {
    botId: "bot_a",
    memberIndex: 0,
    state: "running",
    roundIndex: 1,
    speakerIndex: 0,
    triggerMessageIds: [human.id],
  });
  const timeline = project({
    messages: [human],
    runs: [live],
    memberTurns: [first],
    messageSeqById: { [human.id]: 1 },
  });
  expect(timeline.entries.find((entry) => entry.kind === "activity")).toMatchObject({ anchorSeq: 1 });
});
