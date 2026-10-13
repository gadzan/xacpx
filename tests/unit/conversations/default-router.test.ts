import { expect, test } from "bun:test";

import { gateRoutingDecision } from "../../../src/conversations/conversation-router-gate";
import {
  isRouterCapabilityRestricted,
  MAX_ROUTER_ASSIGNMENTS_PER_DECISION,
  MAX_ROUTER_ASSIGNMENT_ID_LENGTH,
  MAX_ROUTER_TASK_LENGTH,
  parseRoutingDecision,
  type RoutingDecision,
  type RoutingInput,
  type RoutingMember,
} from "../../../src/conversations/conversation-router-types";
import {
  decideDefaultRouterAssignment,
  resolveDefaultRouterEntry,
  runDefaultRouterCli,
  type DefaultRouterCliIo,
  type DefaultRouterDecisionInput,
} from "../../../src/conversations/default-router";

function member(botId: string, enabled = true): RoutingMember {
  return { botId, name: botId, agent: "codex", workspace: "backend", enabled };
}

function decisionInput(overrides: Partial<DefaultRouterDecisionInput> = {}): DefaultRouterDecisionInput {
  return {
    request: "review the patch",
    requestMessageId: "cmsg_1",
    members: [member("bot_reviewer"), member("bot_tester", false)],
    completedAssignmentCount: 0,
    remainingBudget: 24,
    ...overrides,
  };
}

function expectDispatch(decision: RoutingDecision): Extract<RoutingDecision, { type: "dispatch" }> {
  if (decision.type !== "dispatch") {
    throw new Error(`expected a dispatch decision, got "${decision.type}"`);
  }
  return decision;
}

interface CliCapture {
  io: DefaultRouterCliIo;
  stdout: string[];
  stderr: string[];
}

function cliIo(argv: readonly string[], stdin = ""): CliCapture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      argv,
      readStdin: async () => stdin,
      writeStdout: async (text) => {
        stdout.push(text);
      },
      writeStderr: async (text) => {
        stderr.push(text);
      },
    },
    stdout,
    stderr,
  };
}

// ---------------------------------------------------------------------------
// decideDefaultRouterAssignment — every branch, in guard order
// ---------------------------------------------------------------------------

test("an empty run request asks a human instead of dispatching", () => {
  expect(decideDefaultRouterAssignment(decisionInput({ request: "  \n " }))).toEqual({
    type: "need-human",
    question: "The run request is empty.",
  });
});

test("a Group with no enabled member completes rather than dispatch to a disabled Bot", () => {
  // No budget either: the membership guard answers before the budget guard.
  expect(decideDefaultRouterAssignment(decisionInput({
    members: [member("bot_reviewer", false)],
    remainingBudget: 0,
  }))).toEqual({
    type: "complete",
    reason: "No enabled group members are available to assign.",
  });
});

test("an exhausted member turn budget completes the Run", () => {
  expect(decideDefaultRouterAssignment(decisionInput({ remainingBudget: 0 }))).toEqual({
    type: "complete",
    reason: "The member turn budget is exhausted.",
  });
});

test("a Run that already spent a round completes: one round per run", () => {
  expect(decideDefaultRouterAssignment(decisionInput({ completedAssignmentCount: 1 }))).toEqual({
    type: "complete",
    reason: "The default router assigns one round per run.",
  });
});

test("a lone enabled member dispatches as a single assignment", () => {
  expect(decideDefaultRouterAssignment(decisionInput({ members: [member("bot_reviewer")] }))).toEqual({
    type: "dispatch",
    mode: "single",
    assignments: [{
      id: "auto-0-bot_reviewer",
      botId: "bot_reviewer",
      task: "review the patch",
      triggerMessageIds: ["cmsg_1"],
    }],
  });
});

test("several enabled members fan out in parallel, one assignment each", () => {
  const decision = expectDispatch(decideDefaultRouterAssignment(decisionInput({
    members: [member("bot_reviewer"), member("bot_tester", false), member("bot_builder")],
  })));
  expect(decision.mode).toBe("parallel");
  expect(decision.assignments.map((assignment) => assignment.botId))
    .toEqual(["bot_reviewer", "bot_builder"]);
  expect(decision.assignments.map((assignment) => assignment.id))
    .toEqual(["auto-0-bot_reviewer", "auto-1-bot_builder"]);
});

test("the remaining budget clamps the batch to what the Run may still spend", () => {
  const members = Array.from({ length: 5 }, (_, index) => member(`bot_${index}`));
  const decision = expectDispatch(decideDefaultRouterAssignment(decisionInput({
    members,
    remainingBudget: 3,
  })));
  expect(decision.assignments).toHaveLength(3);
  expect(decision.assignments.map((assignment) => assignment.botId)).toEqual(["bot_0", "bot_1", "bot_2"]);
});

test("a Group larger than the per-decision cap is clamped to that cap", () => {
  const size = MAX_ROUTER_ASSIGNMENTS_PER_DECISION + 6;
  const members = Array.from({ length: size }, (_, index) => member(`bot_${index}`));
  const decision = expectDispatch(decideDefaultRouterAssignment(decisionInput({
    members,
    remainingBudget: size,
  })));
  expect(decision.assignments).toHaveLength(MAX_ROUTER_ASSIGNMENTS_PER_DECISION);
});

test("an assignment id that would overflow its bound falls back to the bare index", () => {
  const overflowBotId = "b".repeat(MAX_ROUTER_ASSIGNMENT_ID_LENGTH - 6);
  const overflow = expectDispatch(decideDefaultRouterAssignment(decisionInput({
    members: [member(overflowBotId)],
  })));
  expect(overflow.assignments[0]!.id).toBe("auto-0");

  // One character shorter still fits, so the fallback is the bound and not a haircut.
  const fittingBotId = "b".repeat(MAX_ROUTER_ASSIGNMENT_ID_LENGTH - 7);
  const fitting = expectDispatch(decideDefaultRouterAssignment(decisionInput({
    members: [member(fittingBotId)],
  })));
  expect(fitting.assignments[0]!.id).toBe(`auto-0-${fittingBotId}`);
});

test("the task is the trimmed request, truncated to the task bound", () => {
  const long = expectDispatch(decideDefaultRouterAssignment(decisionInput({
    request: `  ${"x".repeat(MAX_ROUTER_TASK_LENGTH + 500)}  `,
    members: [member("bot_reviewer")],
  })));
  expect(long.assignments[0]!.task).toHaveLength(MAX_ROUTER_TASK_LENGTH);

  const short = expectDispatch(decideDefaultRouterAssignment(decisionInput({
    request: "  review the patch  ",
    members: [member("bot_reviewer")],
  })));
  expect(short.assignments[0]!.task).toBe("review the patch");
});

test("an absent request message id anchors no trigger message", () => {
  const decision = expectDispatch(decideDefaultRouterAssignment(decisionInput({
    requestMessageId: "",
    members: [member("bot_reviewer")],
  })));
  expect(decision.assignments[0]!.triggerMessageIds).toEqual([]);
});

// ---------------------------------------------------------------------------
// resolveDefaultRouterEntry — the hermes-shim anchoring rule, mirrored
// ---------------------------------------------------------------------------

test("resolveDefaultRouterEntry anchors on the last /dist/ segment for bundled builds", () => {
  const cliUrl = process.platform === "win32"
    ? "file:///C:/opt/xacpx/dist/cli.js"
    : "file:///opt/xacpx/dist/cli.js";
  const bridgeUrl = process.platform === "win32"
    ? "file:///C:/opt/xacpx/dist/bridge/bridge-main.js"
    : "file:///opt/xacpx/dist/bridge/bridge-main.js";
  const expected = process.platform === "win32"
    ? "C:\\opt\\xacpx\\dist\\conversations\\default-router-main.js"
    : "/opt/xacpx/dist/conversations/default-router-main.js";
  expect(resolveDefaultRouterEntry(cliUrl)).toBe(expected);
  expect(resolveDefaultRouterEntry(bridgeUrl)).toBe(expected);
});

test("resolveDefaultRouterEntry resolves the sibling source in an unbundled dev run", () => {
  const moduleUrl = process.platform === "win32"
    ? "file:///C:/repo/src/conversations/default-router.ts"
    : "file:///repo/src/conversations/default-router.ts";
  const expected = process.platform === "win32"
    ? "C:\\repo\\src\\conversations\\default-router-main.ts"
    : "/repo/src/conversations/default-router-main.ts";
  expect(resolveDefaultRouterEntry(moduleUrl)).toBe(expected);

  // A dev checkout whose PATH contains /dist/ must still resolve the .ts sibling.
  const nestedUrl = process.platform === "win32"
    ? "file:///C:/home/u/dist/xacpx/src/conversations/default-router.ts"
    : "file:///home/u/dist/xacpx/src/conversations/default-router.ts";
  const nestedExpected = process.platform === "win32"
    ? "C:\\home\\u\\dist\\xacpx\\src\\conversations\\default-router-main.ts"
    : "/home/u/dist/xacpx/src/conversations/default-router-main.ts";
  expect(resolveDefaultRouterEntry(nestedUrl)).toBe(nestedExpected);
});

test("resolveDefaultRouterEntry falls back to the sibling build with no /dist/ anchor", () => {
  const moduleUrl = process.platform === "win32"
    ? "file:///C:/opt/xacpx/conversations/default-router.js"
    : "file:///opt/xacpx/conversations/default-router.js";
  const expected = process.platform === "win32"
    ? "C:\\opt\\xacpx\\conversations\\default-router-main.js"
    : "/opt/xacpx/conversations/default-router-main.js";
  expect(resolveDefaultRouterEntry(moduleUrl)).toBe(expected);
});

// ---------------------------------------------------------------------------
// runDefaultRouterCli — the external-process contract the daemon drives
// ---------------------------------------------------------------------------

test("--capabilities prints a report that proves every restriction", async () => {
  const capture = cliIo(["--capabilities"]);
  expect(await runDefaultRouterCli(capture.io)).toBe(0);
  const report: unknown = JSON.parse(capture.stdout.join(""));
  expect(isRouterCapabilityRestricted(report)).toBe(true);
  expect(capture.stderr).toEqual([]);
});

test("--decide maps a real RoutingInput to a decision the daemon's own gate accepts", async () => {
  const input = routingInput();
  const capture = cliIo(["--decide"], JSON.stringify(input));
  expect(await runDefaultRouterCli(capture.io)).toBe(0);
  const decision: unknown = JSON.parse(capture.stdout.join(""));
  expect(capture.stderr).toEqual([]);

  const parsed = parseRoutingDecision(decision);
  expect(parsed).toEqual({
    type: "dispatch",
    mode: "parallel",
    assignments: [
      { id: "auto-0-bot_reviewer", botId: "bot_reviewer", task: input.request, triggerMessageIds: ["cmsg_1"] },
      { id: "auto-1-bot_builder", botId: "bot_builder", task: input.request, triggerMessageIds: ["cmsg_1"] },
    ],
  });
  expect(gateRoutingDecision(decision, input)).toEqual({ kind: "decision", decision: parsed });
});

test("malformed stdin fails closed with no decision on stdout", async () => {
  const capture = cliIo(["--decide"], "{not json");
  expect(await runDefaultRouterCli(capture.io)).toBe(1);
  expect(capture.stdout).toEqual([]);
  expect(capture.stderr[0]).toStartWith("[xacpx-default-router] ");
});

test("JSON that is not a RoutingInput fails closed too", async () => {
  const capture = cliIo(["--decide"], JSON.stringify({ request: 42 }));
  expect(await runDefaultRouterCli(capture.io)).toBe(1);
  expect(capture.stdout).toEqual([]);
  expect(capture.stderr[0]).toStartWith("[xacpx-default-router] ");
});

test("an unknown, missing, or duplicated flag prints usage and exits 2", async () => {
  for (const argv of [[], ["--bogus"], ["--decide", "--capabilities"]]) {
    const capture = cliIo(argv);
    expect(await runDefaultRouterCli(capture.io)).toBe(2);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr.join("")).toContain("usage:");
  }
});

function routingInput(): RoutingInput {
  return {
    runId: "run_1",
    conversationId: "conversation_1",
    topicId: "topic_1",
    request: "Review the patch and report risks",
    requestMessageId: "cmsg_1",
    publicTranscript: [
      { id: "cmsg_1", seq: 2, role: "human", content: "Review the patch and report risks", runId: "run_1" },
      { id: "cmsg_0", seq: 1, role: "system", content: "topic opened" },
    ],
    memberMetadata: [
      { botId: "bot_reviewer", name: "Reviewer", agent: "codex", workspace: "backend", enabled: true },
      { botId: "bot_tester", name: "Tester", agent: "codex", workspace: "backend", enabled: false },
      { botId: "bot_builder", name: "Builder", agent: "codex", workspace: "backend", enabled: true },
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
    remainingBudget: 24,
    executionTarget: { workspace: "backend", isolation: "shared-single-writer" },
  };
}
