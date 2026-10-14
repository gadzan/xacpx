import { expect, test } from "bun:test";

import { runAcpxControlCommand, type AcpxCommandOutcome } from "../../../src/transport/acpx-owner-control-retry";

const OWNER_SHUTDOWN_STDERR =
  "error: [acpx] error: RUNTIME QUEUE_OWNER_CLOSED Queue owner is shutting down";

test("retries while the queue owner is shutting down and returns the eventual outcome", async () => {
  const outcomes: AcpxCommandOutcome[] = [
    { code: 1, stdout: "", stderr: OWNER_SHUTDOWN_STDERR },
    { code: 1, stdout: "", stderr: OWNER_SHUTDOWN_STDERR },
    { code: 0, stdout: "nothing to cancel\n", stderr: "" },
  ];
  let calls = 0;

  const result = await runAcpxControlCommand(async () => outcomes[calls++]!);

  expect(calls).toBe(3);
  expect(result).toEqual({ code: 0, stdout: "nothing to cancel\n", stderr: "" });
});

test("does not retry a successful command even when stderr mentions the shutdown race", async () => {
  let calls = 0;
  const result = await runAcpxControlCommand(async () => {
    calls += 1;
    return { code: 0, stdout: "ok", stderr: OWNER_SHUTDOWN_STDERR };
  });

  expect(calls).toBe(1);
  expect(result.code).toBe(0);
});

test("does not retry an unrelated failure", async () => {
  let calls = 0;
  const result = await runAcpxControlCommand(async () => {
    calls += 1;
    return { code: 1, stdout: "", stderr: "error: [acpx] error: RUNTIME SESSION_NOT_FOUND" };
  });

  expect(calls).toBe(1);
  expect(result.code).toBe(1);
});

test("gives up after the bounded retry schedule and returns the last failure", async () => {
  let calls = 0;
  const result = await runAcpxControlCommand(async () => {
    calls += 1;
    return { code: 1, stdout: "", stderr: OWNER_SHUTDOWN_STDERR };
  });

  expect(calls).toBe(6); // first attempt plus five retries
  expect(result.code).toBe(1);
}, 30_000);
