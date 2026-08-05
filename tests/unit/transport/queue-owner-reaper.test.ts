import { expect, test } from "bun:test";

import {
  LegacyOwnerUnverifiableError,
  parseRecordId,
  reapQueueOwners,
  type ReapTarget,
} from "../../../src/transport/queue-owner-reaper";

const target = (transportSession: string, cwd = "/tmp/backend"): ReapTarget => ({
  agent: "codex",
  cwd,
  transportSession,
});

test("resolves the record id and terminates the owner for each target", async () => {
  const terminated: string[] = [];
  const result = await reapQueueOwners("acpx", [target("backend:api"), target("backend:docs")], {
    resolveRecordId: async (_cmd, t) => `record-${t.transportSession}`,
    terminate: async (recordId) => {
      terminated.push(recordId);
    },
  });

  expect(terminated.sort()).toEqual(["record-backend:api", "record-backend:docs"]);
  expect(result.terminated).toBe(2);
});

test("deduplicates targets that share a transport session", async () => {
  const resolved: string[] = [];
  await reapQueueOwners(
    "acpx",
    [target("backend:api"), target("backend:api"), target("backend:docs")],
    {
      resolveRecordId: async (_cmd, t) => {
        resolved.push(t.transportSession);
        return `record-${t.transportSession}`;
      },
      terminate: async () => {},
    },
  );

  expect(resolved.sort()).toEqual(["backend:api", "backend:docs"]);
});

test("reaps BOTH targets when session name is the same but cwd differs", async () => {
  const terminated: string[] = [];
  // Two logical sessions share the name "backend:main" but live in different workspaces.
  // They map to different acpx records and must both be reaped.
  const result = await reapQueueOwners(
    "acpx",
    [
      { agent: "codex", cwd: "/workspace/alpha", transportSession: "backend:main" },
      { agent: "codex", cwd: "/workspace/beta", transportSession: "backend:main" },
    ],
    {
      resolveRecordId: async (_cmd, t) => `record-${t.transportSession}-${t.cwd}`,
      terminate: async (recordId) => {
        terminated.push(recordId);
      },
    },
  );

  expect(terminated.sort()).toEqual([
    "record-backend:main-/workspace/alpha",
    "record-backend:main-/workspace/beta",
  ]);
  expect(result.terminated).toBe(2);
  expect(result.attempted).toBe(2);
});

test("reaps BOTH targets when session name is the same but agent differs", async () => {
  const terminated: string[] = [];
  const result = await reapQueueOwners(
    "acpx",
    [
      { agent: "codex", cwd: "/workspace/proj", transportSession: "main" },
      { agent: "opus", cwd: "/workspace/proj", transportSession: "main" },
    ],
    {
      resolveRecordId: async (_cmd, t) => `record-${t.transportSession}-${t.agent}`,
      terminate: async (recordId) => {
        terminated.push(recordId);
      },
    },
  );

  expect(terminated.sort()).toEqual(["record-main-codex", "record-main-opus"]);
  expect(result.terminated).toBe(2);
});

test("still deduplicates truly identical targets (same name + same cwd + same agent)", async () => {
  const resolved: string[] = [];
  await reapQueueOwners(
    "acpx",
    [
      { agent: "codex", cwd: "/workspace/alpha", transportSession: "backend:main" },
      { agent: "codex", cwd: "/workspace/alpha", transportSession: "backend:main" },
      { agent: "codex", cwd: "/workspace/beta", transportSession: "backend:main" },
    ],
    {
      resolveRecordId: async (_cmd, t) => {
        resolved.push(`${t.transportSession}|${t.cwd}`);
        return `record-${t.transportSession}-${t.cwd}`;
      },
      terminate: async () => {},
    },
  );

  // The alpha duplicate collapses; beta is distinct → 2 resolves total.
  expect(resolved.sort()).toEqual(["backend:main|/workspace/alpha", "backend:main|/workspace/beta"]);
});

test("skips targets whose record id resolves to null", async () => {
  const terminated: string[] = [];
  const result = await reapQueueOwners("acpx", [target("backend:api"), target("backend:docs")], {
    resolveRecordId: async (_cmd, t) => (t.transportSession === "backend:api" ? null : "record-docs"),
    terminate: async (recordId) => {
      terminated.push(recordId);
    },
  });

  expect(terminated).toEqual(["record-docs"]);
  expect(result.terminated).toBe(1);
});

test("swallows resolver and terminate errors so one bad session never blocks the rest", async () => {
  const terminated: string[] = [];
  const result = await reapQueueOwners(
    "acpx",
    [target("backend:resolve-fail"), target("backend:terminate-fail"), target("backend:ok")],
    {
      resolveRecordId: async (_cmd, t) => {
        if (t.transportSession === "backend:resolve-fail") throw new Error("show failed");
        return `record-${t.transportSession}`;
      },
      terminate: async (recordId) => {
        if (recordId === "record-backend:terminate-fail") throw new Error("kill failed");
        terminated.push(recordId);
      },
    },
  );

  expect(terminated).toEqual(["record-backend:ok"]);
  expect(result.terminated).toBe(1);
});

test("Windows default path preserves token-less legacy owners and reports degraded", async () => {
  const errors: unknown[] = [];
  const result = await reapQueueOwners("acpx", [target("backend:legacy")], {
    platform: "win32",
    resolveRecordId: async () => "legacy-record",
    onError: (_target, error) => errors.push(error),
  });

  expect(result.terminated).toBe(0);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(LegacyOwnerUnverifiableError);
});

test("parseRecordId reads a bare quiet id, a JSON record, or returns null", () => {
  // `acpx sessions show --format quiet` emits a bare record id line.
  expect(parseRecordId("a1b2c3d4-e5f6-7890-abcd-ef0123456789\n")).toBe(
    "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
  );
  // JSON record object: prefer acpxRecordId, else id.
  expect(parseRecordId(JSON.stringify({ acpxRecordId: "rec-12345678", id: "other" }))).toBe(
    "rec-12345678",
  );
  expect(parseRecordId(JSON.stringify({ id: "id-12345678" }))).toBe("id-12345678");
  // Unusable output → null (never terminate a guessed owner).
  expect(parseRecordId("")).toBeNull();
  expect(parseRecordId("not a record id with spaces")).toBeNull();
  expect(parseRecordId("short")).toBeNull();
  expect(parseRecordId(JSON.stringify({ unrelated: "value" }))).toBeNull();
});

test("returns within the timeout instead of hanging on a stuck resolver", async () => {
  const start = Date.now();
  const result = await reapQueueOwners("acpx", [target("backend:hang"), target("backend:ok")], {
    timeoutMs: 50,
    resolveRecordId: async (_cmd, t) => {
      if (t.transportSession === "backend:hang") {
        await new Promise(() => {}); // never resolves
      }
      return `record-${t.transportSession}`;
    },
    terminate: async () => {},
  });

  expect(Date.now() - start).toBeLessThan(2000);
  // The non-hanging target still gets reaped before the timeout fires.
  expect(result.terminated).toBe(1);
});
