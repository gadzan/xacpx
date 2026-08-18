import { expect, test } from "bun:test";

import {
  MessageInjectionError,
  isMessageInjectionErrorCode,
} from "../../../src/transport/message-injection";

test("message injection errors retain their stable transport code", () => {
  const error = new MessageInjectionError(
    "TARGET_NOT_STEERABLE",
    "The target does not support same-turn steering.",
  );

  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe("MessageInjectionError");
  expect(error.code).toBe("TARGET_NOT_STEERABLE");
  expect(error.message).toBe("The target does not support same-turn steering.");
});

test("recognizes only transport-level message injection error codes", () => {
  expect(isMessageInjectionErrorCode("TARGET_NOT_INTERRUPTIBLE")).toBe(true);
  expect(isMessageInjectionErrorCode("DELIVERY_TIMEOUT")).toBe(true);
  expect(isMessageInjectionErrorCode("BRIDGE_INTERNAL_ERROR")).toBe(false);
  expect(isMessageInjectionErrorCode(undefined)).toBe(false);
});
