import { expect, test } from "bun:test";

import { OrchestrationStateKernel } from "../../../../src/orchestration/service/orchestration-state-kernel";
import { QuestionFlowCore } from "../../../../src/orchestration/service/question-flow-core";
import { makeGoldenHarness } from "../golden/golden-harness";

test("buildReplacementOpenQuestion preserves the prior question text", async () => {
  const harness = makeGoldenHarness();
  const kernel = new OrchestrationStateKernel({});
  const core = new QuestionFlowCore(harness.deps, kernel);

  const task = {
    taskId: "t1",
    task: "original task text",
    openQuestion: {
      questionId: "q0",
      question: "which db?",
      whyBlocked: "ambiguous",
      whatIsNeeded: "a name",
      askedAt: "2026-04-13T10:00:00.000Z",
      status: "answered" as const,
    },
  } as unknown as Parameters<QuestionFlowCore["buildReplacementOpenQuestion"]>[0];

  const replacement = core.buildReplacementOpenQuestion(task, "q1", "2026-04-13T11:00:00.000Z");
  expect(replacement.questionId).toBe("q1");
  expect(replacement.question).toBe("which db?");
  expect(replacement.status).toBe("open");
});

test("normalizeFrozenDeliveryRoute keeps the reply pair only when it is complete", async () => {
  // Asserting only `normalize(normalize(x)) === normalize(x)` proves nothing: an
  // implementation that constantly returns `{}` is idempotent too, and would drop the
  // chatKey, the account and the reply token on every frozen route. Pin what the method
  // actually decides -- accountId and replyContextToken travel together or not at all.
  const harness = makeGoldenHarness();
  const kernel = new OrchestrationStateKernel({});
  const core = new QuestionFlowCore(harness.deps, kernel);

  const complete = core.normalizeFrozenDeliveryRoute({
    chatKey: "wx:room-1",
    accountId: "acct-1",
    replyContextToken: "tok",
  } as never);
  expect(complete).toEqual({ chatKey: "wx:room-1", accountId: "acct-1", replyContextToken: "tok" });

  // A half-populated reply pair is dropped entirely; the chatKey survives alone.
  const halfPair = core.normalizeFrozenDeliveryRoute({
    chatKey: "wx:room-1",
    accountId: "acct-1",
  } as never);
  expect(halfPair).toEqual({ chatKey: "wx:room-1" });

  expect(core.normalizeFrozenDeliveryRoute(complete as never)).toEqual(complete);
});
