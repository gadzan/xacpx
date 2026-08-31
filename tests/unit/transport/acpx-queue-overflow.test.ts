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

test("recognizes exact ACPX_QUEUE_MESSAGE_OVERFLOW code", () => {
  expect(isAcpxQueueMessageOverflow({ code: ACPX_QUEUE_MESSAGE_OVERFLOW_CODE, message: "" })).toBe(true);
  expect(isAcpxQueueMessageOverflow(Object.assign(new Error("boom"), { code: ACPX_QUEUE_MESSAGE_OVERFLOW_CODE }))).toBe(true);
});

test("does not match overflow substrings with extra prefix/suffix", () => {
  expect(isAcpxQueueMessageOverflow(new Error("QUEUE_MESSAGE_OVERFLOWED"))).toBe(false);
  expect(isAcpxQueueMessageOverflow(new Error("NOT_QUEUE_MESSAGE_OVERFLOW_RETRY"))).toBe(false);
  expect(isAcpxQueueMessageOverflow(new Error("SOME_QUEUE_EVENT_TOO_LARGE_BACKOFF"))).toBe(false);
  expect(isAcpxQueueMessageOverflow(new Error("NOT_ACPX_QUEUE_MESSAGE_OVERFLOW_RETRY"))).toBe(false);
  expect(isAcpxQueueMessageOverflow({ message: "QUEUE_MESSAGE_OVERFLOW_EXTRA", code: "" })).toBe(false);
});

test("still matches buffer overflow with surrounding text", () => {
  expect(isAcpxQueueMessageOverflow(new Error("prefix Message buffer exceeded 10485760 bytes suffix"))).toBe(true);
  expect(isAcpxQueueMessageOverflow({ stderr: "Message buffer exceeded 2048 bytes", stdout: "", message: "" })).toBe(true);
});
