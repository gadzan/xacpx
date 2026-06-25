import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  createSubagentPredicate,
  filterSubagentSessions,
  resolveCodexHome,
  sessionMetaLineIsSubagent,
  type RolloutReader,
} from "../../../src/transport/codex-subagent-filter";
import type { AgentSessionListResult } from "../../../src/transport/types";

// --- sessionMetaLineIsSubagent --------------------------------------------------

const subagentLine = JSON.stringify({
  type: "session_meta",
  payload: {
    id: "019efcc9-4d20-74f1-a9e0-67f89ea2115f",
    forked_from_id: "019edfcb-4f91-7b12-9777-d945f287c341",
    source: { subagent: { thread_spawn: { parent_thread_id: "019edfcb-4f91-7b12-9777-d945f287c341", depth: 1, agent_nickname: "Bernoulli" } } },
  },
});

test("sessionMetaLineIsSubagent: true for a subagent source object", () => {
  expect(sessionMetaLineIsSubagent(subagentLine)).toBe(true);
});

test("sessionMetaLineIsSubagent: false for a real session (string source)", () => {
  expect(sessionMetaLineIsSubagent(JSON.stringify({ payload: { source: "unknown" } }))).toBe(false);
  expect(sessionMetaLineIsSubagent(JSON.stringify({ payload: { source: "vscode" } }))).toBe(false);
});

test("sessionMetaLineIsSubagent: false for missing source, non-subagent object, or array source", () => {
  expect(sessionMetaLineIsSubagent(JSON.stringify({ payload: {} }))).toBe(false);
  expect(sessionMetaLineIsSubagent(JSON.stringify({ payload: { source: { cli: {} } } }))).toBe(false);
  expect(sessionMetaLineIsSubagent(JSON.stringify({ payload: { source: ["subagent"] } }))).toBe(false);
});

test("sessionMetaLineIsSubagent: false (fail-open) for malformed/empty input", () => {
  expect(sessionMetaLineIsSubagent(undefined)).toBe(false);
  expect(sessionMetaLineIsSubagent("")).toBe(false);
  expect(sessionMetaLineIsSubagent("{not json")).toBe(false);
});

// --- resolveCodexHome -----------------------------------------------------------

test("resolveCodexHome: prefers $CODEX_HOME, falls back to ~/.codex", () => {
  expect(resolveCodexHome({ CODEX_HOME: "/custom/codex" } as NodeJS.ProcessEnv)).toBe("/custom/codex");
  expect(resolveCodexHome({} as NodeJS.ProcessEnv)).toBe(join(homedir(), ".codex"));
  expect(resolveCodexHome({ CODEX_HOME: "   " } as NodeJS.ProcessEnv)).toBe(join(homedir(), ".codex"));
});

// --- createSubagentPredicate (injected reader) ----------------------------------

function reader(map: Record<string, string>, opts: { listThrows?: boolean } = {}): RolloutReader & { listCalls: number } {
  let listCalls = 0;
  const self = {
    get listCalls() {
      return listCalls;
    },
    listRolloutPaths() {
      listCalls++;
      if (opts.listThrows) throw new Error("boom");
      // file names embed the session id, like Codex's rollout-<ts>-<id>.jsonl
      return Object.keys(map).map((id) => `/c/sessions/2026/06/25/rollout-2026-06-25T11-18-31-${id}.jsonl`);
    },
    readFirstLine(path: string) {
      const id = path.match(/rollout-.*-([0-9a-fA-F-]{36})\.jsonl$/)?.[1] ?? "";
      return map[id];
    },
  };
  return self as RolloutReader & { listCalls: number };
}

test("createSubagentPredicate: flags subagent ids, clears real ones, unknown is fail-open false", () => {
  const isSub = createSubagentPredicate(
    reader({
      "019efcc9-4d20-74f1-a9e0-67f89ea2115f": subagentLine,
      "019edfcb-4f91-7b12-9777-d945f287c341": JSON.stringify({ payload: { source: "unknown" } }),
    }),
  );
  expect(isSub("019efcc9-4d20-74f1-a9e0-67f89ea2115f")).toBe(true);
  expect(isSub("019edfcb-4f91-7b12-9777-d945f287c341")).toBe(false);
  expect(isSub("ffffffff-0000-0000-0000-000000000000")).toBe(false); // no rollout → keep
});

test("createSubagentPredicate: matches session ids case-insensitively", () => {
  const isSub = createSubagentPredicate(reader({ "019efcc9-4d20-74f1-a9e0-67f89ea2115f": subagentLine }));
  expect(isSub("019EFCC9-4D20-74F1-A9E0-67F89EA2115F")).toBe(true);
});

test("createSubagentPredicate: builds the index once and memoizes per id", () => {
  const r = reader({ "019efcc9-4d20-74f1-a9e0-67f89ea2115f": subagentLine });
  const isSub = createSubagentPredicate(r);
  isSub("019efcc9-4d20-74f1-a9e0-67f89ea2115f");
  isSub("019efcc9-4d20-74f1-a9e0-67f89ea2115f");
  isSub("other");
  expect(r.listCalls).toBe(1);
});

test("createSubagentPredicate: fail-open false when the reader throws", () => {
  const isSub = createSubagentPredicate(reader({}, { listThrows: true }));
  expect(isSub("019efcc9-4d20-74f1-a9e0-67f89ea2115f")).toBe(false);
});

// --- filterSubagentSessions (pure) ----------------------------------------------

const listResult = (ids: string[]): AgentSessionListResult => ({
  source: "agent",
  cursor: "c1",
  cwd: "/repo",
  sessions: ids.map((sessionId) => ({ sessionId, cwd: "/repo", title: "t" })),
});

test("filterSubagentSessions: drops flagged sessions, keeps the rest and other fields", () => {
  const subs = new Set(["sub1", "sub2"]);
  const out = filterSubagentSessions(listResult(["sub1", "real1", "sub2", "real2"]), (id) => subs.has(id));
  expect(out.sessions.map((s) => s.sessionId)).toEqual(["real1", "real2"]);
  expect(out.source).toBe("agent");
  expect(out.cursor).toBe("c1");
  expect(out.cwd).toBe("/repo");
});

test("filterSubagentSessions: keeps a session (fail-open) when the predicate throws", () => {
  const out = filterSubagentSessions(listResult(["a", "b"]), (id) => {
    if (id === "a") throw new Error("boom");
    return false;
  });
  expect(out.sessions.map((s) => s.sessionId)).toEqual(["a", "b"]);
});
