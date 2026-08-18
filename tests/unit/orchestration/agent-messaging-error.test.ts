import { expect, test } from "bun:test";

import { AgentMessagingError } from "../../../src/orchestration/agent-messaging-error";

test("AgentMessagingError preserves a stable delivery code", () => {
  const error = new AgentMessagingError(
    "TARGET_NOT_REACHABLE",
    "Target is not reachable from this sender.",
  );

  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe("AgentMessagingError");
  expect(error.code).toBe("TARGET_NOT_REACHABLE");
  expect(error.message).toBe("Target is not reachable from this sender.");
});
