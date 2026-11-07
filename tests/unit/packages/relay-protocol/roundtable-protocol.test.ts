import { expect, test } from "bun:test";
import {
  isRunsDetailsBatchResult,
  MSG,
  parseControlPayload,
  RELAY_CAPABILITIES,
} from "../../../../packages/relay-protocol/src/index";

const prompt = { conversationId: "c", topicId: "t", requestId: "r", text: "discuss" };

function promptWith(target: unknown) {
  return parseControlPayload(MSG.conversationPrompt, { ...prompt, target });
}

test("roundtable targets are accepted with the planned bounds", () => {
  expect(promptWith({ mode: "roundtable", botIds: ["a", "b"] })).not.toBeNull();
  expect(promptWith({ mode: "roundtable", botIds: ["a", "b"], rounds: 3 })).not.toBeNull();
  expect(promptWith({ mode: "roundtable", botIds: Array.from({ length: 8 }, (_, i) => `b${i}`), rounds: 3 }))
    .not.toBeNull();
  expect(promptWith({ mode: "roundtable", botIds: Array.from({ length: 24 }, (_, i) => `b${i}`) }))
    .not.toBeNull();
});

test("roundtable targets reject malformed selections and over-limit plans", () => {
  for (const target of [
    { mode: "roundtable", botIds: ["a"] },
    { mode: "roundtable", botIds: ["a", "a"] },
    { mode: "roundtable", botIds: ["a", "b"], rounds: 0 },
    { mode: "roundtable", botIds: ["a", "b"], rounds: 1.5 },
    { mode: "roundtable", botIds: ["a", "b"], rounds: 4 },
    { mode: "roundtable", botIds: Array.from({ length: 9 }, (_, i) => `b${i}`), rounds: 3 },
    { mode: "roundtable", botIds: Array.from({ length: 25 }, (_, i) => `b${i}`) },
    { mode: "roundtable", botIds: ["a", "b"], botId: "a" },
    { mode: "roundtable" },
    { mode: "automatic", botIds: ["a", "b"] },
    { mode: "roundtable", botIds: ["a", "b"], rounds: "2" },
  ]) {
    expect(promptWith(target)).toBeNull();
  }
});
test("legacy targets stay valid and mixed-shape members still work", () => {
  expect(promptWith(undefined)).not.toBeNull();
  expect(promptWith({ botId: "a" })).not.toBeNull();
  expect(promptWith({ mode: "members", botIds: ["a", "b"] })).not.toBeNull();
  expect(promptWith({ mode: "everyone" })).not.toBeNull();
  expect(promptWith({ mode: "automatic" })).not.toBeNull();
  expect(promptWith({ mode: "members", botIds: ["a"], rounds: 1 })).toBeNull();
  expect(promptWith({ mode: "everyone", rounds: 1 })).toBeNull();
});

test("roundtable and timeline capabilities share stable, additive wire names", () => {
  expect(RELAY_CAPABILITIES.roundtableV1).toBe("conversations.roundtable.v1");
  // P1a adds the timeline capability next to roundtable; neither renames the
  // other, and an old hub/clients ignore the unknown string.
  expect(RELAY_CAPABILITIES.conversationTimelineV1).toBe("conversations.timeline.v1");
});

const legacyRun = {
  id: "r", conversationId: "c", topicId: "t", requestMessageId: "m", requestId: "q",
  mode: "explicit", state: "running", profileRevision: 1, createdAt: "now", memberTurns: [],
};
const legacyMember = {
  id: "member", runId: "r", conversationId: "c", topicId: "t", botId: "b",
  batch: 1, attempt: 1, origin: "human", state: "running", createdAt: "now",
};

test("old Run/MemberTurn DTOs remain readable and roundtable fields validate", () => {
  expect(isRunsDetailsBatchResult({ runs: [legacyRun] })).toBe(true);
  expect(isRunsDetailsBatchResult({ runs: [{ ...legacyRun, shape: "single" }] })).toBe(true);
  expect(isRunsDetailsBatchResult({
    runs: [{
      ...legacyRun, shape: "roundtable", rounds: 2, leadBotId: "b",
      memberTurns: [{
        ...legacyMember, origin: "roundtable", roundIndex: 1, speakerIndex: 0, speechOutcome: "pass",
      }],
    }],
  })).toBe(true);
  expect(isRunsDetailsBatchResult({ runs: [{ ...legacyRun, shape: "fanout" }] })).toBe(true);
  for (const patch of [
    { shape: "discussion" },
    { rounds: 0 },
    { leadBotId: 3 },
  ]) {
    expect(isRunsDetailsBatchResult({ runs: [{ ...legacyRun, ...patch }] })).toBe(false);
  }
  for (const patch of [
    { origin: "roundtablex" },
    { roundIndex: 0 },
    { speakerIndex: -1 },
    { speechOutcome: "skip" },
  ]) {
    expect(isRunsDetailsBatchResult({ runs: [{ ...legacyRun, memberTurns: [{ ...legacyMember, ...patch }] }] }))
      .toBe(false);
  }
});


test("history batch accepts the optional roundtableV1 compat flag", () => {
  const base = { conversationId: "c", topicId: "t", runIds: ["r"] };
  expect(parseControlPayload(MSG.runsDetailsBatch, base)).not.toBeNull();
  expect(parseControlPayload(MSG.runsDetailsBatch, { ...base, roundtableV1: true })).not.toBeNull();
  expect(parseControlPayload(MSG.runsDetailsBatch, { ...base, roundtableV1: false })).not.toBeNull();
  expect(parseControlPayload(MSG.runsDetailsBatch, { ...base, roundtableV1: "yes" })).toBeNull();
  expect(parseControlPayload(MSG.runsDetailsBatch, { ...base, roundtable: true })).toBeNull();
});