import { expect, test } from "bun:test";

import { gateRoutingDecision } from "../../../src/conversations/conversation-router-gate";
import {
  isRouterCapabilityRestricted,
  MAX_ROUTER_ASSIGNMENTS_PER_DECISION,
  MAX_ROUTER_ASSIGNMENT_ID_LENGTH,
  MAX_ROUTER_REASON_LENGTH,
  MAX_ROUTER_TASK_LENGTH,
  parseRoutingDecision,
  type RoutingDecision,
  type RoutingInput,
  type RoutingMember,
} from "../../../src/conversations/conversation-router-types";
import {
  decideDefaultRouterAssignment,
  decideJevRouterAssignment,
  readJevRouterEnv,
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

// ---------------------------------------------------------------------------
// decideJevRouterAssignment — the Jev policy: one pick, bounded fallbacks
// ---------------------------------------------------------------------------

const JEV_ENV = {
  endpoint: "https://api.typesafe.ai/v1/systemone",
  apiKey: "sk-test-not-a-real-key",
  model: "jev-1.13.0",
};

interface AskCall {
  message: string;
  question: string;
  choices: Array<{ key: string; description: string }>;
  endpoint: string;
  apiKey: string;
  proxyUrl?: string;
  model: string;
}

/** A fake ask seam that records the call and answers with `answer`. */
function fakeAsk(answer: { ok: true; choice: string; confidence: number } | { ok: false; code: string }): {
  ask: Parameters<typeof decideJevRouterAssignment>[1];
  calls: AskCall[];
} {
  const calls: AskCall[] = [];
  const ask = (async (input: AskCall) => {
    calls.push(input);
    return answer.ok
      ? { ok: true, choice: answer.choice, confidence: answer.confidence, latencyMs: 5 }
      : { ok: false, code: answer.code, message: `failed: ${answer.code}` };
  }) as unknown as Parameters<typeof decideJevRouterAssignment>[1];
  return { ask, calls };
}

function jevInput(overrides: Partial<DefaultRouterDecisionInput> = {}): Parameters<typeof decideJevRouterAssignment>[0] {
  return { ...decisionInput(overrides), jev: JEV_ENV };
}

test("a confident pick dispatches to that member only, with the reason", async () => {
  const { ask, calls } = fakeAsk({ ok: true, choice: "bot_reviewer", confidence: 0.82 });
  const decision = await decideJevRouterAssignment(jevInput(), ask);
  const dispatch = expectDispatch(decision);
  expect(dispatch.mode).toBe("single");
  expect(dispatch.assignments).toHaveLength(1);
  expect(dispatch.assignments[0]?.botId).toBe("bot_reviewer");
  expect(dispatch.assignments[0]?.task).toBe("review the patch");
  expect(dispatch.assignments[0]?.triggerMessageIds).toEqual(["cmsg_1"]);
  expect(dispatch.reason).toContain("bot_reviewer");
  expect(dispatch.reason).toContain("0.82");
  // Disabled members are never offered as choices.
  expect(calls[0]?.choices.map((c) => c.key)).toEqual(["bot_reviewer"]);
  expect(calls[0]?.choices[0]?.description).toBe("bot_reviewer");
  expect(calls[0]?.question).toBe("Which bot should handle this message?");
  expect(calls[0]?.apiKey).toBe(JEV_ENV.apiKey);
});

test("the member's role is the criteria description when it has one", async () => {
  const { ask, calls } = fakeAsk({ ok: true, choice: "bot_reviewer", confidence: 0.9 });
  await decideJevRouterAssignment(jevInput({
    members: [
      { botId: "bot_reviewer", name: "Reviewer", role: "reviews PRs", agent: "codex", workspace: "backend", enabled: true },
    ],
  }), ask);
  expect(calls[0]?.choices[0]?.description).toBe("reviews PRs");
});

test("a bounded transcript block is folded into the state message", async () => {
  const { ask, calls } = fakeAsk({ ok: true, choice: "bot_reviewer", confidence: 0.9 });
  await decideJevRouterAssignment(jevInput({
    publicTranscript: [
      { id: "m1", seq: 9, role: "bot", senderBotId: "bot_reviewer", content: "earlier finding", runId: "run_1" },
      { id: "m0", seq: 1, role: "human", content: "first question" },
    ],
  }), ask);
  expect(calls[0]?.message).toContain("review the patch");
  expect(calls[0]?.message).toContain("Recent context:");
  expect(calls[0]?.message).toContain("bot_reviewer: earlier finding");
});

test("confidence below the floor falls back to the group lead", async () => {
  const { ask } = fakeAsk({ ok: true, choice: "bot_reviewer", confidence: 0.31 });
  const decision = expectDispatch(await decideJevRouterAssignment(jevInput({
    members: [member("bot_reviewer"), member("bot_lead")],
    leadBotId: "bot_lead",
  }), ask));
  expect(decision.assignments[0]?.botId).toBe("bot_lead");
  expect(decision.reason).toContain("low confidence");
  expect(decision.reason).toContain("group lead");
});

test("an unknown pick falls back to the group lead", async () => {
  const { ask } = fakeAsk({ ok: true, choice: "bot_ghost", confidence: 0.99 });
  const decision = expectDispatch(await decideJevRouterAssignment(jevInput({
    members: [member("bot_reviewer"), member("bot_lead")],
    leadBotId: "bot_lead",
  }), ask));
  expect(decision.assignments[0]?.botId).toBe("bot_lead");
  expect(decision.reason).toContain("bot_ghost");
});

test("a Jev failure falls back to the group lead and names the cause", async () => {
  const { ask } = fakeAsk({ ok: false, code: "region-blocked" });
  const decision = expectDispatch(await decideJevRouterAssignment(jevInput({
    members: [member("bot_reviewer"), member("bot_lead")],
    leadBotId: "bot_lead",
  }), ask));
  expect(decision.assignments[0]?.botId).toBe("bot_lead");
  expect(decision.reason).toContain("region-blocked");
});

test("a throwing ask falls back instead of failing the run", async () => {
  const ask = (async () => {
    throw new Error("socket hang up");
  }) as unknown as Parameters<typeof decideJevRouterAssignment>[1];
  const decision = expectDispatch(await decideJevRouterAssignment(jevInput({
    members: [member("bot_reviewer"), member("bot_lead")],
    leadBotId: "bot_lead",
  }), ask));
  expect(decision.assignments[0]?.botId).toBe("bot_lead");
  expect(decision.reason).toContain("socket hang up");
});

test("a throwing ask never leaks proxy credentials or the key into the reason", async () => {
  const proxyUrl = "http://proxyuser:s3cretpass@127.0.0.1:7890";
  const ask = (async () => {
    throw new Error(`tunnel via ${proxyUrl} failed (Bearer ${JEV_ENV.apiKey})`);
  }) as unknown as Parameters<typeof decideJevRouterAssignment>[1];
  const decision = expectDispatch(await decideJevRouterAssignment({
    ...jevInput({ members: [member("bot_reviewer"), member("bot_lead")], leadBotId: "bot_lead" }),
    jev: { ...JEV_ENV, proxyUrl },
  }, ask));
  expect(decision.assignments[0]?.botId).toBe("bot_lead");
  expect(decision.reason).toContain("http://***@127.0.0.1:7890");
  expect(decision.reason).not.toContain("s3cretpass");
  expect(decision.reason).not.toContain("proxyuser");
  expect(decision.reason).not.toContain(JEV_ENV.apiKey);
});

test("with no lead configured the first enabled member is the fallback", async () => {
  const { ask } = fakeAsk({ ok: true, choice: "bot_ghost", confidence: 0.99 });
  const decision = expectDispatch(await decideJevRouterAssignment(jevInput({
    members: [member("bot_first"), member("bot_second")],
  }), ask));
  expect(decision.assignments[0]?.botId).toBe("bot_first");
  expect(decision.reason).toContain("no group lead");
});

test("a lead that is not an enabled member is never the fallback", async () => {
  const { ask } = fakeAsk({ ok: true, choice: "bot_ghost", confidence: 0.99 });
  const decision = expectDispatch(await decideJevRouterAssignment(jevInput({
    members: [member("bot_first"), member("bot_disabled_lead", false)],
    leadBotId: "bot_disabled_lead",
  }), ask));
  expect(decision.assignments[0]?.botId).toBe("bot_first");
});

test("the Jev policy keeps the fan-out's guard order", async () => {
  const { ask, calls } = fakeAsk({ ok: true, choice: "bot_reviewer", confidence: 0.9 });
  expect(await decideJevRouterAssignment(jevInput({ request: "   " }), ask)).toMatchObject({
    type: "need-human",
  });
  expect(await decideJevRouterAssignment(jevInput({
    members: [member("bot_reviewer", false)],
  }), ask)).toMatchObject({ type: "complete" });
  expect(await decideJevRouterAssignment(jevInput({ remainingBudget: 0 }), ask)).toMatchObject({
    type: "complete",
  });
  expect(await decideJevRouterAssignment(jevInput({ completedAssignmentCount: 1 }), ask)).toMatchObject({
    type: "complete",
  });
  // No guard reached the model.
  expect(calls).toHaveLength(0);
});

test("the decision reason is bounded and parses through the router gate", async () => {
  const { ask } = fakeAsk({ ok: true, choice: "bot_reviewer", confidence: 0.9 });
  const decision = await decideJevRouterAssignment(jevInput(), ask);
  const dispatch = expectDispatch(decision);
  expect((dispatch.reason ?? "").length).toBeLessThanOrEqual(MAX_ROUTER_REASON_LENGTH);
  // The gate accepts the reason field: strict parsing rejects unknown fields.
  expect(() => parseRoutingDecision(dispatch)).not.toThrow();
});

test("a Jev decision survives the engine's domain gate", async () => {
  const { ask } = fakeAsk({ ok: true, choice: "bot_reviewer", confidence: 0.9 });
  const decision = await decideJevRouterAssignment(jevInput(), ask);
  const gate = gateRoutingDecision(decision, routingInput());
  expect(gate.kind).toBe("decision");
});

test("readJevRouterEnv reads the daemon's environment and defaults the endpoint", () => {
  expect(readJevRouterEnv({
    XACPX_JEV_API_KEY: "sk-live",
    XACPX_JEV_PROXY: "http://127.0.0.1:8080",
  })).toEqual({
    endpoint: "https://api.typesafe.ai/v1/systemone",
    apiKey: "sk-live",
    proxyUrl: "http://127.0.0.1:8080",
    model: "jev-1.13.0",
  });
  expect(readJevRouterEnv({})).toBeUndefined();
  expect(readJevRouterEnv({ XACPX_JEV_API_KEY: "  " })).toBeUndefined();
});

test("--decide runs the Jev policy when the env carries a key", async () => {
  const { ask, calls } = fakeAsk({ ok: true, choice: "bot_builder", confidence: 0.77 });
  // The CLI uses the real ask seam; drive it through the environment by pointing
  // the endpoint at a loopback server instead.
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(JSON.stringify({
      answers: { bot: { type: "choice", choice: "bot_builder", confidence: 0.77 } },
    }), { headers: { "content-type": "application/json" } }),
  });
  try {
    const capture = cliIo(["--decide"], JSON.stringify(routingInput()));
    capture.io.env = {
      XACPX_JEV_API_KEY: "sk-loopback",
      XACPX_JEV_ENDPOINT: `http://127.0.0.1:${server.port}/v1/systemone`,
      XACPX_JEV_MODEL: "jev-1.13.0",
    };
    const code = await runDefaultRouterCli(capture.io);
    expect(code).toBe(0);
    const decision = JSON.parse(capture.stdout.join("")) as RoutingDecision;
    expect(decision).toMatchObject({
      type: "dispatch",
      mode: "single",
      reason: expect.stringContaining("bot_builder"),
    });
    expect(ask).toBeDefined();
    expect(calls).toHaveLength(0);
  } finally {
    server.stop(true);
  }
});

test("confidence exactly at the 0.6 floor dispatches to the pick", async () => {
  const { ask } = fakeAsk({ ok: true, choice: "bot_reviewer", confidence: 0.6 });
  const decision = expectDispatch(await decideJevRouterAssignment(jevInput({
    members: [member("bot_reviewer"), member("bot_lead")],
    leadBotId: "bot_lead",
  }), ask));
  expect(decision.assignments[0]?.botId).toBe("bot_reviewer");
  expect(decision.reason).toContain("0.60");
});

test("confidence 0.59 (just under the floor) falls back to the lead", async () => {
  const { ask } = fakeAsk({ ok: true, choice: "bot_reviewer", confidence: 0.59 });
  const decision = expectDispatch(await decideJevRouterAssignment(jevInput({
    members: [member("bot_reviewer"), member("bot_lead")],
    leadBotId: "bot_lead",
  }), ask));
  expect(decision.assignments[0]?.botId).toBe("bot_lead");
  expect(decision.reason).toContain("low confidence 0.59");
});

test("a pick with no confidence in the answer falls back to the lead", async () => {
  // askJevChoice maps a missing confidence to 0 (see jev-client tests).
  const { ask } = fakeAsk({ ok: true, choice: "bot_reviewer", confidence: 0 });
  const decision = expectDispatch(await decideJevRouterAssignment(jevInput({
    members: [member("bot_reviewer"), member("bot_lead")],
    leadBotId: "bot_lead",
  }), ask));
  expect(decision.assignments[0]?.botId).toBe("bot_lead");
  expect(decision.reason).toContain("low confidence");
});

test("a disabled group lead falls back to the first enabled member with an accurate reason", async () => {
  const { ask } = fakeAsk({ ok: false, code: "network" });
  const decision = expectDispatch(await decideJevRouterAssignment(jevInput({
    members: [member("bot_lead", false), member("bot_first"), member("bot_second")],
    leadBotId: "bot_lead",
  }), ask));
  expect(decision.assignments[0]?.botId).toBe("bot_first");
  expect(decision.reason).toContain("the group lead is not enabled");
  expect(decision.reason).not.toContain("no group lead is configured");
});
