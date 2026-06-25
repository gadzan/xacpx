import { expect, test } from "bun:test";

import { listFirstNonEmptyPage } from "../../../../src/commands/handlers/native-session-handler";
import type { AgentSessionListQuery, AgentSessionListResult } from "../../../../src/transport/types";

const baseQuery: AgentSessionListQuery = { agent: "codex", cwd: "/repo", filterCwd: "/repo" };
const page = (ids: string[], nextCursor: string | null): AgentSessionListResult => ({
  source: "agent",
  nextCursor,
  sessions: ids.map((sessionId) => ({ sessionId, cwd: "/repo" })),
});

test("listFirstNonEmptyPage: skips fully-filtered empty pages until one has sessions", async () => {
  const pages = [page([], "c1"), page([], "c2"), page(["real"], null)];
  const cursors: (string | undefined)[] = [];
  const result = await listFirstNonEmptyPage(async (q) => {
    cursors.push(q.cursor);
    return pages.shift();
  }, baseQuery);

  expect(result?.sessions.map((s) => s.sessionId)).toEqual(["real"]);
  // first call has no cursor, then it advances using each page's nextCursor
  expect(cursors).toEqual([undefined, "c1", "c2"]);
});

test("listFirstNonEmptyPage: returns the first page unchanged when it already has sessions", async () => {
  let calls = 0;
  const result = await listFirstNonEmptyPage(async () => {
    calls++;
    return page(["a", "b"], "more");
  }, baseQuery);

  expect(calls).toBe(1);
  expect(result?.sessions).toHaveLength(2);
  expect(result?.nextCursor).toBe("more");
});

test("listFirstNonEmptyPage: stops at an empty page with no nextCursor (no infinite advance)", async () => {
  let calls = 0;
  const result = await listFirstNonEmptyPage(async () => {
    calls++;
    return page([], null);
  }, baseQuery);

  expect(calls).toBe(1);
  expect(result?.sessions).toHaveLength(0);
});

test("listFirstNonEmptyPage: is bounded — never advances past the cap", async () => {
  let calls = 0;
  // Always empty but always has a nextCursor → must stop at the bound, not loop forever.
  const result = await listFirstNonEmptyPage(async () => {
    calls++;
    return page([], `cursor-${calls}`);
  }, baseQuery);

  expect(result?.sessions).toHaveLength(0);
  expect(calls).toBeLessThanOrEqual(26); // 1 initial + MAX_EMPTY_PAGE_ADVANCE (25)
  expect(calls).toBeGreaterThan(1);
});

test("listFirstNonEmptyPage: propagates undefined (unsupported transport)", async () => {
  const result = await listFirstNonEmptyPage(async () => undefined, baseQuery);
  expect(result).toBeUndefined();
});
