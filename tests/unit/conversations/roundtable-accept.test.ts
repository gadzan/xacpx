import { expect, test } from "bun:test";
import { ConversationError } from "../../../src/conversations/conversation-error";
import {
  MAX_ROUNDTABLE_MEMBER_TURNS,
  planRoundtable,
} from "../../../src/conversations/conversation-roundtable";
import { harness, HUMAN } from "./fixtures/concurrency-harness";
import { acceptRoundtable, openRoundtableStore } from "./fixtures/roundtable-harness";

test("planRoundtable expands round-major with continuous memberIndex", () => {
  const plan = planRoundtable({ botIds: ["bot_a", "bot_b", "bot_c"], rounds: 2 });
  expect(plan.rounds).toBe(2);
  expect(plan.turns.map((turn) => [turn.memberIndex, turn.roundIndex, turn.speakerIndex, turn.botId])).toEqual([
    [0, 1, 0, "bot_a"],
    [1, 1, 1, "bot_b"],
    [2, 1, 2, "bot_c"],
    [3, 2, 0, "bot_a"],
    [4, 2, 1, "bot_b"],
    [5, 2, 2, "bot_c"],
  ]);
  // Same Bot is allowed across rounds; the plan never repeats it in one round.
  expect(new Set(plan.turns.filter((turn) => turn.roundIndex === 1).map((turn) => turn.botId)).size).toBe(3);
});

test("planRoundtable fails closed on malformed selections and never truncates", () => {
  const cases = [
    () => planRoundtable({ botIds: ["bot_a"] }),
    () => planRoundtable({ botIds: ["bot_a", "bot_a"] }),
    () => planRoundtable({ botIds: ["bot_a", "bot_b"], rounds: 0 }),
    () => planRoundtable({ botIds: ["bot_a", "bot_b"], rounds: 1.5 }),
    () => planRoundtable({ botIds: ["bot_a", "bot_b"], rounds: 4 }),
    () => planRoundtable({ botIds: Array.from({ length: 13 }, (_, i) => `bot_${i}`), rounds: 2 }),
    () => planRoundtable({ botIds: ["bot_a", "bot_b"], rounds: 13 }),
  ];
  for (const plan of cases) {
    expect(plan).toThrow(ConversationError);
  }
  expect(() => planRoundtable({ botIds: Array.from({ length: 12 }, (_, i) => `bot_${i}`), rounds: 2 }))
    .not.toThrow();
  expect(MAX_ROUNDTABLE_MEMBER_TURNS).toBe(24);
});

test("planRoundtable moves a selected lead first and omits it when the selection excludes it", () => {
  const reordered = planRoundtable({ botIds: ["bot_b", "bot_a"], leadBotId: "bot_a" });
  expect(reordered.leadBotId).toBe("bot_a");
  expect(reordered.turns.map((turn) => turn.botId)).toEqual(["bot_a", "bot_b"]);

  const excluded = planRoundtable({ botIds: ["bot_b", "bot_c"], leadBotId: "bot_a" });
  expect(excluded.leadBotId).toBeUndefined();
  expect(excluded.turns.map((turn) => turn.botId)).toEqual(["bot_b", "bot_c"]);
});

test("a roundtable accept pre-generates every turn in one Run, batch 1", async () => {
  const h = await harness();
  try {
    const { group, topic, members } = await h.group();
    const accepted = await h.service.acceptGroupPrompt({
      conversationId: group.id,
      topicId: topic.id,
      requestId: "rt-accept",
      text: "Discuss the rollout",
      target: { mode: "roundtable", botIds: [members[0]!, members[1]!], rounds: 2 },
      humanIngress: HUMAN,
    });
    expect(h.store.listRuns(group.id, topic.id)).toHaveLength(1);
    expect(accepted.run).toMatchObject({
      shape: "roundtable",
      rounds: 2,
      mode: "explicit",
      maxMemberTurns: 4,
    });
    const turns = h.store.listMemberTurns(accepted.run.id);
    expect(turns.map((turn) => turn.memberIndex)).toEqual([0, 1, 2, 3]);
    expect(turns.map((turn) => turn.roundIndex)).toEqual([1, 1, 2, 2]);
    expect(turns.map((turn) => turn.speakerIndex)).toEqual([0, 1, 0, 1]);
    expect(turns.map((turn) => turn.botId)).toEqual([members[0], members[1], members[0], members[1]]);
    expect(turns.every((turn) => turn.batch === 1 && turn.origin === "roundtable" && turn.state === "queued")).toBe(true);
    expect(h.store.listDispatchesForRun(accepted.run.id)).toHaveLength(4);
    expect(h.store.getRun(accepted.run.id)?.leadBotId).toBeUndefined();
  } finally {
    h.store.close();
  }
});

test("a Group lead inside the selection opens the discussion", async () => {
  const h = await harness();
  try {
    const { group, members } = await h.group();
    const led = await h.bots.createGroup({ title: "Led", botIds: members, leadBotId: members[1] });
    const topic = await h.service.createGroupTopic(led.id, "Topic", { workspace: "backend", isolation: "shared-single-writer" });
    const accepted = await h.service.acceptGroupPrompt({
      conversationId: led.id,
      topicId: topic.id,
      requestId: "rt-led",
      text: "Discuss",
      target: { mode: "roundtable", botIds: [members[0]!, members[1]!] },
      humanIngress: HUMAN,
    });
    expect(accepted.run.leadBotId).toBe(members[1]);
    expect(h.store.listMemberTurns(accepted.run.id)[0]?.botId).toBe(members[1]);
  } finally {
    h.store.close();
  }
});

test("a selection that excludes the Group lead is accepted without a lead snapshot", async () => {
  const h = await harness();
  try {
    const { group, members } = await h.group();
    const led = await h.bots.createGroup({ title: "Led", botIds: members, leadBotId: members[0] });
    const topic = await h.service.createGroupTopic(led.id, "Topic", { workspace: "backend", isolation: "shared-single-writer" });
    const accepted = await h.service.acceptGroupPrompt({
      conversationId: led.id,
      topicId: topic.id,
      requestId: "rt-subset",
      text: "Discuss without the lead",
      target: { mode: "roundtable", botIds: [members[1]!, members[2]!] },
      humanIngress: HUMAN,
    });
    expect(accepted.run.shape).toBe("roundtable");
    expect(accepted.run.leadBotId).toBeUndefined();
    expect(h.store.listMemberTurns(accepted.run.id).map((turn) => turn.botId)).toEqual([members[1], members[2]]);
  } finally {
    h.store.close();
  }
});

test("the store rejects a roundtable budget that is not exactly the planned turns", async () => {
  const store = await openRoundtableStore();
  try {
    expect(() => acceptRoundtable(store, { botIds: ["bot_a", "bot_b"], rounds: 2, maxMemberTurns: 24 }))
      .toThrow(ConversationError);
    expect(() => acceptRoundtable(store, { botIds: ["bot_a", "bot_b"], rounds: 4 }))
      .toThrow(ConversationError);
    expect(store.listRuns("conversation_roundtable", "topic_roundtable")).toHaveLength(0);
  } finally {
    store.close();
  }
});
