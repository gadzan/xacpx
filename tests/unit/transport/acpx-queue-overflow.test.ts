import { expect, test } from "bun:test";

import { PromptCommandError } from "../../../src/transport/prompt-output";
import {
  ACPX_QUEUE_MESSAGE_OVERFLOW_CODE,
  AcpxQueueOverflowError,
  isAcpxQueueMessageOverflow,
} from "../../../src/transport/acpx-queue-overflow";

test("recognizes the acpx queue client buffer overflow in prompt diagnostics", () => {
  expect(isAcpxQueueMessageOverflow(new PromptCommandError("prompt failed", {
    code: 1,
    stdout: "",
    stderr: "Message buffer exceeded 10485760 bytes",
  }))).toBe(true);
});

test("recognizes the typed queue guard error without depending on its byte budget", () => {
  expect(isAcpxQueueMessageOverflow({
    message: "QUEUE_EVENT_TOO_LARGE: session/update",
    stdout: "",
    stderr: "",
  })).toBe(true);
});

test("does not classify unrelated prompt failures as queue overflows", () => {
  expect(isAcpxQueueMessageOverflow(new PromptCommandError("provider failed", {
    code: 1,
    stdout: "",
    stderr: "provider failed",
  }))).toBe(false);
});

test("exposes a stable user-facing overflow code and message", () => {
  const error = new AcpxQueueOverflowError();

  expect(error.code).toBe(ACPX_QUEUE_MESSAGE_OVERFLOW_CODE);
  expect(error.message).toContain("oversized ACP event");
  expect(error.message).toContain("not retried automatically");
});
