import { expect, test } from "bun:test";

import { boundRoutingInput } from "../../../src/conversations/conversation-router-budget";
import { gateRoutingDecision } from "../../../src/conversations/conversation-router-gate";
import { sampleMemberAvailability } from "../../../src/conversations/conversation-member-availability";
import type { MemberAvailabilityFact } from "../../../src/conversations/conversation-store";
import {
  MAX_ROUTER_AVAILABILITY_CHARACTERS,
  MAX_ROUTER_AVAILABILITY_MEMBERS,
  type MemberAvailability,
  type RoutingInput,
} from "../../../src/conversations/conversation-router-types";

const NOW = "2026-09-15T12:00:00.000Z";
const BOT_ID = "bot_reviewer";
const TESTER_ID = "bot_tester";

function baseInput(overrides: Partial<RoutingInput> = {}): RoutingInput {
  return {
    runId: "run_1",
    conversationId: "conversation_1",
    topicId: "topic_1",
    request: "ship",
    requestMessageId: "cmsg_1",
    publicTranscript: [],
    memberMetadata: [
      { botId: BOT_ID, name: "Reviewer", agent: "codex", workspace: "backend", enabled: true },
      { botId: TESTER_ID, name: "Tester", agent: "codex", workspace: "backend", enabled: false },
    ],
    runState: {
      runId: "run_1",
      conversationId: "conversation_1",
      topicId: "topic_1",
      mode: "automatic",
      generation: 1,
      maxMemberTurns: 24,
      consumedMemberTurns: 0,
      failedBotIds: [],
    },
    completedAssignments: [],
    completedAssignmentTotal: 0,
    assignmentSequence: 0,
    remainingBudget: 24,
    executionTarget: { workspace: "backend", isolation: "shared-single-writer" },
    ...overrides,
  };
}

function availability(botId: string, state: MemberAvailability["state"], overrides: Partial<MemberAvailability> = {}): MemberAvailability {
  return {
    botId,
    state,
    activeAssignments: state === "working" ? 1 : 0,
    pendingAssignments: 0,
    quarantinedForRun: false,
    sampledAt: NOW,
    ...overrides,
  };
}

test("availability is sampled from durable facts with an explicit state per member", () => {
  const turns: MemberAvailabilityFact[] = [
    // Executing work.
    { botId: "bot_worker", state: "running", runState: "running" },
    // Accepted but queued behind capacity.
    { botId: "bot_queued", state: "queued", runState: "running" },
    // Sender settled; the public handoff child is still open.
    { botId: "bot_lead", state: "completed", runState: "running" },
    { botId: "bot_child", state: "dispatched", runState: "running", handoffSenderBotId: "bot_lead" },
    // Latest work sits in a Run parked for the human.
    { botId: "bot_parked", state: "completed", runState: "waiting-human" },
    // Settled history alone is idle.
    { botId: "bot_idle", state: "completed", runState: "running" },
  ];
  const sampled = sampleMemberAvailability({
    members: [
      { botId: "bot_worker", enabled: true },
      { botId: "bot_queued", enabled: true },
      { botId: "bot_lead", enabled: true },
      { botId: "bot_child", enabled: true },
      { botId: "bot_parked", enabled: true },
      { botId: "bot_idle", enabled: true },
      { botId: "bot_disabled", enabled: false },
      { botId: "bot_quarantined", enabled: true },
    ],
    turns,
    quarantinedBotIds: ["bot_quarantined"],
    sampledAt: NOW,
  });
  expect(sampled).toEqual([
    { botId: "bot_worker", state: "working", activeAssignments: 1, pendingAssignments: 0, quarantinedForRun: false, sampledAt: NOW },
    { botId: "bot_queued", state: "working", activeAssignments: 0, pendingAssignments: 1, quarantinedForRun: false, sampledAt: NOW },
    { botId: "bot_lead", state: "waiting-children", activeAssignments: 0, pendingAssignments: 0, quarantinedForRun: false, sampledAt: NOW },
    { botId: "bot_child", state: "working", activeAssignments: 1, pendingAssignments: 0, quarantinedForRun: false, sampledAt: NOW },
    { botId: "bot_parked", state: "waiting-human", activeAssignments: 0, pendingAssignments: 0, quarantinedForRun: false, sampledAt: NOW },
    { botId: "bot_idle", state: "idle", activeAssignments: 0, pendingAssignments: 0, quarantinedForRun: false, sampledAt: NOW },
    { botId: "bot_disabled", state: "unavailable", activeAssignments: 0, pendingAssignments: 0, quarantinedForRun: false, sampledAt: NOW },
    { botId: "bot_quarantined", state: "unavailable", activeAssignments: 0, pendingAssignments: 0, quarantinedForRun: true, sampledAt: NOW },
  ]);
});

test("the availability section is member-capped and discloses the cut", () => {
  const rows = Array.from({ length: MAX_ROUTER_AVAILABILITY_MEMBERS + 7 }, (_, index) =>
    availability(`bot_${index}`, index === 0 ? "working" : "idle"));
  const bounded = boundRoutingInput(baseInput({ availability: rows }));
  expect(bounded.availability).toHaveLength(MAX_ROUTER_AVAILABILITY_MEMBERS);
  expect(bounded.availability?.map((row) => row.botId)).toEqual(rows.slice(0, MAX_ROUTER_AVAILABILITY_MEMBERS).map((row) => row.botId));
  expect(bounded.omittedAvailabilityCount).toBe(7);
  // Re-bounding the already-bounded snapshot is stable, not cumulative.
  const again = boundRoutingInput(bounded);
  expect(again.availability).toEqual(bounded.availability);
  expect(again.omittedAvailabilityCount).toBe(7);
});

test("the availability section is serialized-size capped and discloses the cut", () => {
  const rows = Array.from({ length: MAX_ROUTER_AVAILABILITY_MEMBERS }, (_, index) =>
    availability(`bot_${index}_${"x".repeat(220)}`, "idle"));
  const bounded = boundRoutingInput(baseInput({ availability: rows }));
  expect(bounded.availability!.length).toBeLessThan(MAX_ROUTER_AVAILABILITY_MEMBERS);
  expect(JSON.stringify(bounded.availability).length).toBeLessThanOrEqual(MAX_ROUTER_AVAILABILITY_CHARACTERS);
  expect(bounded.omittedAvailabilityCount).toBe(MAX_ROUTER_AVAILABILITY_MEMBERS - bounded.availability!.length);
  expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(MAX_ROUTER_AVAILABILITY_CHARACTERS + 10_000);
});

test("busy availability never blocks admission, and stale availability never relaxes a gate", () => {
  const dispatchTo = (botId: string) => ({
    type: "dispatch" as const,
    mode: "single" as const,
    assignments: [{ id: "a", botId, task: "review", triggerMessageIds: ["cmsg_1"] }],
  });
  const enabledMembers = [
    { botId: BOT_ID, name: "Reviewer", agent: "codex", workspace: "backend", enabled: true },
    { botId: TESTER_ID, name: "Tester", agent: "codex", workspace: "backend", enabled: true },
  ];
  // A busy member is still a legal target: the task queues, admission says yes.
  expect(gateRoutingDecision(dispatchTo(BOT_ID), baseInput({
    memberMetadata: enabledMembers,
    availability: [availability(BOT_ID, "working", { activeAssignments: 3 })],
  }))).toMatchObject({ kind: "decision" });
  // A stale snapshot claiming the member is unavailable cannot refuse it either.
  expect(gateRoutingDecision(dispatchTo(BOT_ID), baseInput({
    memberMetadata: enabledMembers,
    availability: [availability(BOT_ID, "unavailable")],
  }))).toMatchObject({ kind: "decision" });
  // A stale idle sample cannot make a disabled member executable.
  expect(gateRoutingDecision(dispatchTo(TESTER_ID), baseInput({
    availability: [availability(TESTER_ID, "idle")],
  }))).toEqual({ kind: "rejected", code: "router_member_unavailable", message: expect.any(String) });
  // A stale idle sample cannot conjure budget.
  expect(gateRoutingDecision(dispatchTo(BOT_ID), baseInput({
    memberMetadata: enabledMembers,
    remainingBudget: 0,
    availability: [availability(BOT_ID, "idle")],
  }))).toEqual({ kind: "rejected", code: "router_budget_exhausted", message: expect.any(String) });
});
