import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { StateStore, STATE_FILE_VERSION } from "../../../src/state/state-store";

const FIXED_NOW = new Date("2026-06-11T01:02:03.456Z");
const FIXED_TS = "2026-06-11T01-02-03-456Z";

function goodSession(alias: string) {
  return {
    alias,
    agent: "codex",
    workspace: "backend",
    transport_session: `backend:${alias}`,
    logical_session_id: "44444444-4444-4444-8444-444444444444",
    created_at: "2026-06-10T10:00:00.000Z",
    last_used_at: "2026-06-10T10:00:00.000Z",
  };
}

function goodScheduledTask(id: string) {
  return {
    id,
    chat_key: "weixin:user-1",
    session_alias: "api-fix",
    execute_at: "2026-06-10T13:30:00.000Z",
    message: "check CI",
    status: "pending",
    created_at: "2026-06-10T10:00:00.000Z",
  };
}

function goodOrchestrationTask(taskId: string) {
  return {
    taskId,
    sourceHandle: "backend:main",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
    task: "review",
    status: "running",
    summary: "",
    resultText: "",
    createdAt: "2026-06-10T10:00:00.000Z",
    updatedAt: "2026-06-10T10:00:00.000Z",
  };
}

async function withStateDir(
  run: (dir: string, path: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-quarantine-"));
  try {
    await run(dir, join(dir, "state.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("one bad session record is skipped, reported, and the original file is quarantined", async () => {
  await withStateDir(async (dir, path) => {
    const raw = JSON.stringify({
      sessions: {
        good: goodSession("good"),
        bad: { alias: "bad", agent: 42 },
      },
      chat_contexts: {},
    });
    await Bun.write(path, raw);

    const store = new StateStore(path, { now: () => FIXED_NOW });
    const state = await store.load();

    expect(state.sessions.good).toBeDefined();
    expect(state.sessions.bad).toBeUndefined();

    const report = store.lastLoadReport;
    expect(report).not.toBeNull();
    expect(report?.dropped).toEqual([
      { section: "sessions", key: "bad", reason: expect.stringContaining("malformed") },
    ]);

    const quarantinePath = `${path}.quarantine-${FIXED_TS}`;
    expect(report?.quarantinePath).toBe(quarantinePath);
    expect(await readFile(quarantinePath, "utf8")).toBe(raw);
  });
});

test("bad records in each major section are skipped and reported while the rest loads", async () => {
  await withStateDir(async (dir, path) => {
    await Bun.write(
      path,
      JSON.stringify({
        sessions: { good: goodSession("good") },
        chat_contexts: {
          "wx:good": { current_session: "good" },
          "wx:bad": { current_session: 42 },
        },
        scheduled_tasks: {
          ok: goodScheduledTask("ok"),
          broken: { id: "broken", status: "unknown" },
        },
        orchestration: {
          tasks: {
            "task-good": goodOrchestrationTask("task-good"),
            "task-bad": { taskId: "task-bad", status: "not-a-status" },
          },
          workerBindings: {},
          groups: {},
          coordinatorRoutes: {
            "backend:main": {
              coordinatorSession: "backend:main",
              chatKey: "wx:user",
              updatedAt: "2026-06-10T10:00:00.000Z",
            },
            "backend:bad": { coordinatorSession: "backend:bad" },
          },
        },
      }),
    );

    const store = new StateStore(path, { now: () => FIXED_NOW });
    const state = await store.load();

    expect(state.sessions.good).toBeDefined();
    expect(state.chat_contexts["wx:good"]).toBeDefined();
    expect(state.chat_contexts["wx:bad"]).toBeUndefined();
    expect(state.scheduled_tasks.ok).toBeDefined();
    expect(state.scheduled_tasks.broken).toBeUndefined();
    expect(state.orchestration.tasks["task-good"]).toBeDefined();
    expect(state.orchestration.tasks["task-bad"]).toBeUndefined();
    expect(state.orchestration.coordinatorRoutes["backend:main"]).toBeDefined();
    expect(state.orchestration.coordinatorRoutes["backend:bad"]).toBeUndefined();

    const sections = (store.lastLoadReport?.dropped ?? []).map((entry) => `${entry.section}:${entry.key}`);
    expect(sections).toContain("chat_contexts:wx:bad");
    expect(sections).toContain("scheduled_tasks:broken");
    expect(sections).toContain("orchestration.tasks:task-bad");
    expect(sections).toContain("orchestration.coordinatorRoutes:backend:bad");
    expect(sections).toHaveLength(4);
  });
});

test("external coordinator identity collision is repaired by dropping the coordinator record", async () => {
  await withStateDir(async (dir, path) => {
    await Bun.write(
      path,
      JSON.stringify({
        sessions: {
          main: {
            ...goodSession("main"),
            transport_session: "codex:backend",
          },
        },
        chat_contexts: {},
        orchestration: {
          tasks: {},
          workerBindings: {},
          groups: {},
          externalCoordinators: {
            "codex:backend": {
              coordinatorSession: "codex:backend",
              workspace: "backend",
              createdAt: "2026-06-10T10:00:00.000Z",
              updatedAt: "2026-06-10T10:00:00.000Z",
            },
          },
        },
      }),
    );

    const store = new StateStore(path, { now: () => FIXED_NOW });
    const state = await store.load();

    expect(state.sessions.main).toBeDefined();
    expect(state.orchestration.externalCoordinators["codex:backend"]).toBeUndefined();
    expect(store.lastLoadReport?.dropped).toEqual([
      {
        section: "orchestration.externalCoordinators",
        key: "codex:backend",
        reason: expect.stringContaining("conflicts with a logical session"),
      },
    ]);
  });
});

test("whole-file invalid JSON is renamed to .corrupt-* and load returns empty state", async () => {
  await withStateDir(async (dir, path) => {
    await Bun.write(path, "{not-json");

    const store = new StateStore(path, { now: () => FIXED_NOW });
    const state = await store.load();

    expect(state.sessions).toEqual({});
    expect(state.chat_contexts).toEqual({});

    const corruptPath = `${path}.corrupt-${FIXED_TS}`;
    const report = store.lastLoadReport;
    expect(report?.corruptPath).toBe(corruptPath);
    expect(report?.dropped).toEqual([
      { section: "file", key: path, reason: expect.stringContaining("invalid JSON") },
    ]);
    expect(await readFile(corruptPath, "utf8")).toBe("{not-json");
    // original removed so the next save does not fight the corrupt bytes
    const files = await readdir(dir);
    expect(files).not.toContain("state.json");
  });
});

test("non-object top-level JSON is treated as a corrupt file", async () => {
  await withStateDir(async (dir, path) => {
    await Bun.write(path, JSON.stringify([1, 2, 3]));

    const store = new StateStore(path, { now: () => FIXED_NOW });
    const state = await store.load();

    expect(state.sessions).toEqual({});
    expect(store.lastLoadReport?.corruptPath).toBe(`${path}.corrupt-${FIXED_TS}`);
  });
});

test("a wrong-typed section degrades to empty and is reported while the rest loads", async () => {
  await withStateDir(async (dir, path) => {
    await Bun.write(
      path,
      JSON.stringify({
        sessions: 42,
        chat_contexts: { "wx:user": { current_session: "api-fix" } },
      }),
    );

    const store = new StateStore(path, { now: () => FIXED_NOW });
    const state = await store.load();

    expect(state.sessions).toEqual({});
    expect(state.chat_contexts["wx:user"]).toBeDefined();
    expect(store.lastLoadReport?.dropped).toEqual([
      { section: "sessions", key: "", reason: expect.stringContaining("not an object") },
    ]);
  });
});

test("save writes the state file version and old files without version load with no report", async () => {
  await withStateDir(async (dir, path) => {
    // old file without version: loads clean, no report
    await Bun.write(
      path,
      JSON.stringify({ sessions: { good: goodSession("good") }, chat_contexts: {} }),
    );
    const store = new StateStore(path, { now: () => FIXED_NOW });
    const loaded = await store.load();
    expect(store.lastLoadReport).toBeNull();

    // save writes version; reload stays clean and equal
    await store.save(loaded);
    const raw = JSON.parse(await readFile(path, "utf8")) as { version?: number };
    expect(raw.version).toBe(STATE_FILE_VERSION);

    const reloaded = await store.load();
    expect(store.lastLoadReport).toBeNull();
    expect(reloaded).toEqual(loaded);
  });
});

test("a failing quarantine backup still returns the cleaned state", async () => {
  await withStateDir(async (dir, path) => {
    await Bun.write(
      path,
      JSON.stringify({
        sessions: { good: goodSession("good"), bad: { alias: "bad" } },
        chat_contexts: {},
      }),
    );

    const store = new StateStore(path, {
      now: () => FIXED_NOW,
      writeBackup: async () => {
        throw new Error("disk full");
      },
    });
    const state = await store.load();

    expect(state.sessions.good).toBeDefined();
    expect(state.sessions.bad).toBeUndefined();
    const report = store.lastLoadReport;
    expect(report?.quarantinePath).toBeUndefined();
    expect(report?.backupError).toContain("disk full");
    expect(report?.dropped).toHaveLength(1);
  });
});

test("inspect() reports dropped records without writing quarantine files", async () => {
  await withStateDir(async (dir, path) => {
    const raw = JSON.stringify({
      sessions: { good: goodSession("good"), bad: { alias: "bad" } },
      chat_contexts: {},
    });
    await Bun.write(path, raw);

    const store = new StateStore(path, { now: () => FIXED_NOW });
    const inspection = await store.inspect();

    expect(inspection.state.sessions.good).toBeDefined();
    expect(inspection.state.sessions.bad).toBeUndefined();
    expect(inspection.report?.dropped).toEqual([
      { section: "sessions", key: "bad", reason: "malformed session record" },
    ]);
    // side-effect-free: no quarantine file, original untouched
    expect(await readdir(dir)).toEqual(["state.json"]);
    expect(await readFile(path, "utf8")).toBe(raw);
  });
});

test("inspect() reports whole-file corruption without renaming the file", async () => {
  await withStateDir(async (dir, path) => {
    await Bun.write(path, "{not-json");

    const store = new StateStore(path, { now: () => FIXED_NOW });
    const inspection = await store.inspect();

    expect(inspection.state.sessions).toEqual({});
    expect(inspection.report?.dropped).toEqual([
      { section: "file", key: path, reason: expect.stringContaining("invalid JSON") },
    ]);
    expect(await readdir(dir)).toEqual(["state.json"]);
    expect(await readFile(path, "utf8")).toBe("{not-json");
  });
});

test("inspect() of a fully valid file returns a null report", async () => {
  await withStateDir(async (dir, path) => {
    await Bun.write(
      path,
      JSON.stringify({ sessions: { good: goodSession("good") }, chat_contexts: {} }),
    );

    const store = new StateStore(path, { now: () => FIXED_NOW });
    const inspection = await store.inspect();

    expect(inspection.state.sessions.good).toBeDefined();
    expect(inspection.report).toBeNull();
  });
});

test("quarantine backup never overwrites an existing file (wx + suffix retry)", async () => {
  await withStateDir(async (dir, path) => {
    const raw = JSON.stringify({
      sessions: { good: goodSession("good"), bad: { alias: "bad" } },
      chat_contexts: {},
    });
    await Bun.write(path, raw);
    const occupiedPath = `${path}.quarantine-${FIXED_TS}`;
    await Bun.write(occupiedPath, "sentinel");

    const store = new StateStore(path, { now: () => FIXED_NOW });
    const state = await store.load();

    expect(state.sessions.good).toBeDefined();
    // existing backup untouched; the new one lands on a suffixed name
    expect(await readFile(occupiedPath, "utf8")).toBe("sentinel");
    expect(store.lastLoadReport?.quarantinePath).toBe(`${occupiedPath}-1`);
    expect(await readFile(`${occupiedPath}-1`, "utf8")).toBe(raw);
  });
});

test("a fully valid state file produces no report and no quarantine files", async () => {
  await withStateDir(async (dir, path) => {
    await Bun.write(
      path,
      JSON.stringify({
        sessions: { good: goodSession("good") },
        chat_contexts: { "wx:user": { current_session: "good" } },
        scheduled_tasks: { ok: goodScheduledTask("ok") },
        orchestration: {
          tasks: { "task-1": goodOrchestrationTask("task-1") },
          workerBindings: {},
          groups: {},
        },
      }),
    );

    const store = new StateStore(path, { now: () => FIXED_NOW });
    const state = await store.load();

    expect(state.sessions.good).toBeDefined();
    expect(store.lastLoadReport).toBeNull();
    const files = await readdir(dir);
    expect(files).toEqual(["state.json"]);
  });
});

test("a legacy session missing logical_session_id is migrated, not quarantined", async () => {
  await withStateDir(async (dir, path) => {
    const { logical_session_id: _omit, ...legacy } = goodSession("legacy");
    await Bun.write(
      path,
      JSON.stringify({ sessions: { legacy }, chat_contexts: {} }),
    );

    const store = new StateStore(path, { now: () => FIXED_NOW });
    const state = await store.load();

    const migratedId = state.sessions.legacy?.logical_session_id;
    expect(migratedId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    // the load report keeps "migrated" distinct from "dropped corrupt record"
    const report = store.lastLoadReport;
    expect(report?.dropped).toEqual([]);
    expect(report?.migrated).toEqual([
      { section: "sessions", key: "legacy", reason: expect.stringContaining("logical_session_id") },
    ]);
    // nothing was dropped, so there is nothing to quarantine: the only write is
    // the durable in-place migration of state.json itself
    expect(report?.quarantinePath).toBeUndefined();
    expect(await readdir(dir)).toEqual(["state.json"]);
    const onDisk = JSON.parse(await readFile(path, "utf8")) as {
      sessions: Record<string, { logical_session_id?: string }>;
    };
    expect(onDisk.sessions.legacy?.logical_session_id).toBe(migratedId);
  });
});

test("quarantine and migration combine: original backed up once, cleaned state persisted with new ids", async () => {
  await withStateDir(async (dir, path) => {
    const { logical_session_id: _omit, ...legacy } = goodSession("legacy");
    const raw = JSON.stringify({
      sessions: {
        good: goodSession("good"),
        legacy,
        bad: { alias: "bad", agent: 42 },
      },
      chat_contexts: {},
    });
    await Bun.write(path, raw);

    const store = new StateStore(path, { now: () => FIXED_NOW });
    const state = await store.load();

    expect(state.sessions.good?.logical_session_id).toBe("44444444-4444-4444-8444-444444444444");
    const migratedId = state.sessions.legacy?.logical_session_id;
    expect(migratedId).toBeDefined();
    expect(state.sessions.bad).toBeUndefined();

    const report = store.lastLoadReport;
    expect(report?.dropped).toEqual([
      { section: "sessions", key: "bad", reason: expect.stringContaining("malformed") },
    ]);
    expect(report?.migrated).toEqual([
      { section: "sessions", key: "legacy", reason: expect.stringContaining("logical_session_id") },
    ]);

    // the original bytes (including the dropped record) are preserved exactly once
    const quarantinePath = `${path}.quarantine-${FIXED_TS}`;
    expect(report?.quarantinePath).toBe(quarantinePath);
    expect(await readFile(quarantinePath, "utf8")).toBe(raw);

    // and the live file is the cleaned state with the durable migrated id
    const onDisk = JSON.parse(await readFile(path, "utf8")) as {
      sessions: Record<string, { logical_session_id?: string }>;
    };
    expect(onDisk.sessions.bad).toBeUndefined();
    expect(onDisk.sessions.legacy?.logical_session_id).toBe(migratedId);
  });
});
