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

test("normalizeFrozenDeliveryRoute is idempotent", async () => {
  const harness = makeGoldenHarness();
  const kernel = new OrchestrationStateKernel({});
  const core = new QuestionFlowCore(harness.deps, kernel);

  const route = { chatKey: "wx:room-1", accountId: "acct-1", replyContextToken: "tok" };
  const once = core.normalizeFrozenDeliveryRoute(route as never);
  const twice = core.normalizeFrozenDeliveryRoute(once as never);
  expect(twice).toEqual(once);
});
