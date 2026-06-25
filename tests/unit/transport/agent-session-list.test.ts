import { expect, test } from "bun:test";

import {
  isAgentSessionListResult,
  parseAgentSessionListOutput,
  runAgentSessionList,
  type AgentSessionListCommandResult,
} from "../../../src/transport/agent-session-list";

const ok = (stdout: string): AgentSessionListCommandResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string, code = 1): AgentSessionListCommandResult => ({ code, stdout: "", stderr });

test("retries without --filter-cwd and filters locally when acpx rejects the option", async () => {
  const includeFilterCwdCalls: boolean[] = [];
  const result = await runAgentSessionList({
    filterCwd: "/repo",
    runList: async (includeFilterCwd) => {
      includeFilterCwdCalls.push(includeFilterCwd);
      if (includeFilterCwd) {
        return fail("error: unknown option '--filter-cwd'");
      }
      return ok(
        JSON.stringify({
          source: "agent",
          sessions: [
            { sessionId: "thread-1", cwd: "/repo" },
            { sessionId: "thread-2", cwd: "/other" },
          ],
        }),
      );
    },
    formatError: () => "should not be called",
  });

  expect(includeFilterCwdCalls).toEqual([true, false]);
  expect(result).toEqual({ source: "agent", sessions: [{ sessionId: "thread-1", cwd: "/repo" }] });
});

test("drops sessions flagged by isSubagentSession after parsing", async () => {
  const result = await runAgentSessionList({
    runList: async () =>
      ok(
        JSON.stringify({
          source: "agent",
          sessions: [
            { sessionId: "real", cwd: "/repo" },
            { sessionId: "sub", cwd: "/repo" },
          ],
        }),
      ),
    formatError: () => "should not be called",
    isSubagentSession: (id) => id === "sub",
  });

  expect(result).toEqual({ source: "agent", sessions: [{ sessionId: "real", cwd: "/repo" }] });
});

test("returns undefined when the agent does not advertise sessionCapabilities.list", async () => {
  const result = await runAgentSessionList({
    runList: async () => fail("Agent command does not advertise sessionCapabilities.list"),
    formatError: () => "should not be called",
  });

  expect(result).toBeUndefined();
});

test("throws the transport-formatted error on other non-zero failures", async () => {
  await expect(
    runAgentSessionList({
      runList: async () => fail("boom", 2),
      formatError: (r) => `formatted:${r.stderr}`,
    }),
  ).rejects.toThrow("formatted:boom");
});

test("throws a parse error when acpx emits non-JSON on success", async () => {
  await expect(
    runAgentSessionList({
      runList: async () => ok("not json"),
      formatError: () => "should not be called",
    }),
  ).rejects.toThrow("failed to parse acpx sessions list output");
});

test("does not filter locally when the first --filter-cwd call succeeds", async () => {
  const payload = {
    source: "agent",
    sessions: [
      { sessionId: "thread-1", cwd: "/repo" },
      { sessionId: "thread-2", cwd: "/other" },
    ],
  };
  const result = await runAgentSessionList({
    filterCwd: "/repo",
    runList: async () => ok(JSON.stringify(payload)),
    formatError: () => "should not be called",
  });

  // acpx already filtered server-side; the helper must not re-filter and drop rows.
  expect(result).toEqual(payload);
});

test("parseAgentSessionListOutput rejects payloads that are not agent-sourced", () => {
  expect(parseAgentSessionListOutput(JSON.stringify({ source: "local", sessions: [] }))).toBeUndefined();
});

test("isAgentSessionListResult requires a string sessionId on every entry", () => {
  expect(isAgentSessionListResult({ source: "agent", sessions: [{ sessionId: "a" }] })).toBe(true);
  expect(isAgentSessionListResult({ source: "agent", sessions: [{ cwd: "/x" }] })).toBe(false);
  expect(isAgentSessionListResult({ source: "agent", sessions: "nope" })).toBe(false);
  expect(isAgentSessionListResult(null)).toBe(false);
});
