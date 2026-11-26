import { expect, test } from "bun:test";

import {
  runCancelSession,
  runGetSessionModel,
  runRemoveSession,
  runTailSessionHistory,
  type SessionCommandResult,
} from "../../../src/transport/acpx-session-commands";

const ok = (stdout = ""): SessionCommandResult => ({ code: 0, stdout, stderr: "" });
const fail = (marker: string): SessionCommandResult => ({ code: 1, stdout: "", stderr: marker });

const buildArgv = (tail: string[]) => ["acpx", ...tail];

test("remove swallows a missing session and throws anything else", async () => {
  const calls: string[][] = [];
  const execute = async (argv: string[]) => {
    calls.push(argv);
    return argv.join(" ").includes("missing") ? fail("no named session") : fail("EACCES");
  };
  await runRemoveSession({
    sessionName: "missing",
    timeoutMs: 1000,
    buildArgv,
    execute,
    control: false,
  });
  await expect(
    runRemoveSession({
      sessionName: "denied",
      timeoutMs: 1000,
      buildArgv,
      execute,
      control: false,
    }),
  ).rejects.toThrow("EACCES");
  // Plain (non-control) path issues the argv verbatim, no retry wrapper.
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(["acpx", "sessions", "close", "missing"]);
});

test("remove honors the control flag without changing the outcome", async () => {
  const seen: string[][] = [];
  await runRemoveSession({
    sessionName: "gone",
    timeoutMs: 1000,
    buildArgv,
    execute: async (argv) => {
      seen.push(argv);
      return fail("session not found");
    },
    control: true,
  });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toEqual(["acpx", "sessions", "close", "gone"]);
});

test("cancel returns the trimmed stdout as the message", async () => {
  const result = await runCancelSession({
    sessionName: "demo",
    timeoutMs: 1000,
    buildArgv,
    execute: async () => ok("cancelled ok\n"),
    control: false,
  });
  expect(result).toEqual({ cancelled: true, message: "cancelled ok" });
});

test("tail tries every candidate under one shared deadline then throws the last error", async () => {
  const timeouts: number[] = [];
  const calls: string[][] = [];
  await expect(
    runTailSessionHistory({
      sessionName: "demo",
      lines: 20,
      deadlineBudgetMs: 30_000,
      buildArgv,
      execute: async (argv, timeoutMs) => {
        calls.push(argv);
        timeouts.push(timeoutMs);
        // Blank failure: exercises the exit-code fallback in the final throw.
        return { code: 1, stdout: "", stderr: "" };
      },
    }),
  ).rejects.toThrow("command failed with exit code 1");
  expect(calls).toHaveLength(6);
  // Later candidates get a smaller remaining budget (shared deadline).
  expect(timeouts[5]).toBeLessThanOrEqual(timeouts[0]);
  expect(timeouts.every((t) => t >= 1)).toBe(true);
});

test("getSessionModel throws the normalized error and parses the catalog", async () => {
  await expect(
    runGetSessionModel({
      sessionName: "demo",
      timeoutMs: 1000,
      buildArgv,
      execute: async () => fail("boom"),
    }),
  ).rejects.toThrow("boom");
  const catalog = await runGetSessionModel({
    sessionName: "demo",
    timeoutMs: 1000,
    buildArgv,
    execute: async () =>
      ok('{"model":"gpt-5.2[high]","availableModels":["gpt-5.2[high]","gpt-5.1"]}'),
  });
  expect(catalog).toEqual({ current: "gpt-5.2[high]", available: ["gpt-5.2[high]", "gpt-5.1"] });
});
