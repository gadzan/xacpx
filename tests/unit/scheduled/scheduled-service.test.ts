import { expect, test } from "bun:test";

import { ScheduledTaskService } from "../../../src/scheduled/scheduled-service";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { createEmptyState, type AppState } from "../../../src/state/types";

class MemoryStore {
  saves = 0;
  async save(_state: AppState): Promise<void> { this.saves += 1; }
}

test("creates task with collision-checked lowercase id", async () => {
  const state = createEmptyState();
  state.scheduled_tasks.abcd = {
    id: "abcd",
    chat_key: "weixin:user-1",
    session_alias: "alias",
    execute_at: "2026-05-23T10:00:00.000Z",
    message: "old",
    status: "pending",
    created_at: "2026-05-23T09:00:00.000Z",
  };
  const store = new MemoryStore();
  const service = new ScheduledTaskService(state, store, {
    now: () => new Date("2026-05-23T09:00:00.000Z"),
    generateId: (() => {
      const ids = ["abcd", "ef12"];
      return () => ids.shift() ?? "zz99";
    })(),
  });

  const task = await service.createTask({
    chatKey: "weixin:user-1",
    sessionAlias: "internal-alias",
    executeAt: new Date("2026-05-23T10:00:00.000Z"),
    message: "检查 CI",
    accountId: "wx-1",
    replyContextToken: "ctx-1",
  });

  expect(task.id).toBe("ef12");
  expect(state.scheduled_tasks.ef12?.session_alias).toBe("internal-alias");
  expect(store.saves).toBe(1);
});

test("listRecentForChat returns upcoming first then recent terminal runs, scoped + capped", async () => {
  const state = createEmptyState();
  // Two upcoming (out of order), three terminal at different settle times, one other chat.
  state.scheduled_tasks.up2 = { id: "up2", chat_key: "relay:a", session_alias: "s", execute_at: "2026-05-23T12:00:00.000Z", message: "later", status: "pending", created_at: "2026-05-23T09:00:00.000Z" };
  state.scheduled_tasks.up1 = { id: "up1", chat_key: "relay:a", session_alias: "s", execute_at: "2026-05-23T10:00:00.000Z", message: "soon", status: "pending", created_at: "2026-05-23T09:00:00.000Z" };
  state.scheduled_tasks.doneOld = { id: "doneold", chat_key: "relay:a", session_alias: "s", execute_at: "2026-05-23T08:00:00.000Z", message: "ran early", status: "executed", created_at: "2026-05-23T07:00:00.000Z", executed_at: "2026-05-23T08:00:01.000Z" };
  state.scheduled_tasks.failNew = { id: "failnew", chat_key: "relay:a", session_alias: "s", execute_at: "2026-05-23T09:00:00.000Z", message: "broke", status: "failed", created_at: "2026-05-23T07:00:00.000Z", failed_at: "2026-05-23T09:00:02.000Z", last_error: "boom" };
  state.scheduled_tasks.mine = { id: "mine", chat_key: "relay:b", session_alias: "s", execute_at: "2026-05-23T10:00:00.000Z", message: "other chat", status: "pending", created_at: "2026-05-23T09:00:00.000Z" };

  const service = new ScheduledTaskService(state, new MemoryStore());
  const ids = service.listRecentForChat("relay:a").map((t) => t.id);
  // Upcoming sorted by execute_at asc, then terminal sorted by settle time desc.
  expect(ids).toEqual(["up1", "up2", "failnew", "doneold"]);

  // terminalLimit caps the terminal tail (upcoming are always kept).
  const capped = service.listRecentForChat("relay:a", { terminalLimit: 1 }).map((t) => t.id);
  expect(capped).toEqual(["up1", "up2", "failnew"]);
});

test("lists pending tasks ordered by execute_at, scoped to the caller chat, and cancels by #id case-insensitively", async () => {
  const state = createEmptyState();
  state.scheduled_tasks.bbbb = {
    id: "bbbb", chat_key: "c", session_alias: "s", execute_at: "2026-05-23T12:00:00.000Z", message: "later", status: "pending", created_at: "2026-05-23T09:00:00.000Z",
  };
  state.scheduled_tasks.aaaa = {
    id: "aaaa", chat_key: "c", session_alias: "s", execute_at: "2026-05-23T10:00:00.000Z", message: "soon", status: "pending", created_at: "2026-05-23T09:00:00.000Z",
  };
  state.scheduled_tasks.dddd = {
    id: "dddd", chat_key: "other", session_alias: "s", execute_at: "2026-05-23T11:00:00.000Z", message: "theirs", status: "pending", created_at: "2026-05-23T09:00:00.000Z",
  };
  const store = new MemoryStore();
  const service = new ScheduledTaskService(state, store);

  expect(service.listPending("c").map((task) => task.id)).toEqual(["aaaa", "bbbb"]);
  expect(service.listPending("other").map((task) => task.id)).toEqual(["dddd"]);
  expect(await service.cancelPending("#AAAA", "c")).toBe(true);
  expect(state.scheduled_tasks.aaaa?.status).toBe("cancelled");
});

test("cancelPending from another chat behaves like not-found and leaves the task pending", async () => {
  const state = createEmptyState();
  state.scheduled_tasks.aaaa = {
    id: "aaaa", chat_key: "chat-a", session_alias: "s", execute_at: "2026-05-23T10:00:00.000Z", message: "secret", status: "pending", created_at: "2026-05-23T09:00:00.000Z",
  };
  const store = new MemoryStore();
  const service = new ScheduledTaskService(state, store);

  expect(await service.cancelPending("aaaa", "chat-b")).toBe(false);
  expect(state.scheduled_tasks.aaaa?.status).toBe("pending");
  expect(store.saves).toBe(0);
});

test("listPendingAllChats / cancelPendingAnyChat operate across chats (operator surface)", async () => {
  const state = createEmptyState();
  state.scheduled_tasks.aaaa = {
    id: "aaaa", chat_key: "chat-a", session_alias: "s", execute_at: "2026-05-23T10:00:00.000Z", message: "a", status: "pending", created_at: "2026-05-23T09:00:00.000Z",
  };
  state.scheduled_tasks.bbbb = {
    id: "bbbb", chat_key: "chat-b", session_alias: "s", execute_at: "2026-05-23T12:00:00.000Z", message: "b", status: "pending", created_at: "2026-05-23T09:00:00.000Z",
  };
  const service = new ScheduledTaskService(state, new MemoryStore());

  expect(service.listPendingAllChats().map((task) => task.id)).toEqual(["aaaa", "bbbb"]);
  expect(await service.cancelPendingAnyChat("#BBBB")).toBe(true);
  expect(state.scheduled_tasks.bbbb?.status).toBe("cancelled");
});

test("claims due tasks and marks old pending tasks missed", async () => {
  const state = createEmptyState();
  state.scheduled_tasks.due1 = {
    id: "due1", chat_key: "c", session_alias: "s", execute_at: "2026-05-23T09:59:00.000Z", message: "due", status: "pending", created_at: "2026-05-23T09:00:00.000Z",
  };
  state.scheduled_tasks.future = {
    id: "future", chat_key: "c", session_alias: "s", execute_at: "2026-05-23T10:01:00.000Z", message: "future", status: "pending", created_at: "2026-05-23T09:00:00.000Z",
  };
  const service = new ScheduledTaskService(state, new MemoryStore(), { now: () => new Date("2026-05-23T10:00:00.000Z") });

  expect((await service.claimDueTasks()).map((task) => task.id)).toEqual(["due1"]);
  expect(state.scheduled_tasks.due1?.status).toBe("triggering");
  expect(state.scheduled_tasks.future?.status).toBe("pending");

  await service.markStartupMissed();
  expect(state.scheduled_tasks.due1?.status).toBe("triggering");
});

test("rolls back the in-memory claim when save fails so the next tick can retry", async () => {
  const state = createEmptyState();
  state.scheduled_tasks.due1 = {
    id: "due1", chat_key: "c", session_alias: "s", execute_at: "2026-05-23T09:59:00.000Z", message: "due", status: "pending", created_at: "2026-05-23T09:00:00.000Z",
  };
  let failNextSave = true;
  const store = {
    save: async (_s: AppState): Promise<void> => {
      if (failNextSave) {
        failNextSave = false;
        throw new Error("disk full");
      }
    },
  };
  const service = new ScheduledTaskService(state, store, { now: () => new Date("2026-05-23T10:00:00.000Z") });

  await expect(service.claimDueTasks()).rejects.toThrow("disk full");
  // Without rollback the task stays "triggering" in memory, disappears from
  // listPending, and silently never fires until a daemon restart.
  expect(state.scheduled_tasks.due1?.status).toBe("pending");
  expect(state.scheduled_tasks.due1?.triggered_at).toBeUndefined();
  expect(service.listPendingAllChats().map((task) => task.id)).toEqual(["due1"]);

  // The next tick retries and claims the task normally.
  expect((await service.claimDueTasks()).map((task) => task.id)).toEqual(["due1"]);
  expect(state.scheduled_tasks.due1?.status).toBe("triggering");
});

test("scheduled writes serialize with the shared state mutex so an interleaved clone-save cannot drop a task", async () => {
  const mutex = new AsyncMutex();
  const state = createEmptyState();
  const persistedTaskKeys: string[][] = [];
  const store = {
    save: async (s: AppState): Promise<void> => {
      persistedTaskKeys.push(Object.keys(s.scheduled_tasks));
    },
  };

  // Orchestration-style critical section (mirrors main.ts loadState/saveState
  // under the shared stateMutex): acquire the lock, snapshot the state, hold it
  // while "working", then persist the snapshot. Started first so it owns the lock.
  const orchestration = mutex.run(async () => {
    const clone = JSON.parse(JSON.stringify(state)) as AppState;
    await new Promise((resolve) => setTimeout(resolve, 25));
    await store.save(clone);
  });

  // A scheduled create issued while the orchestration section still holds the lock.
  const service = new ScheduledTaskService(state, store, {
    stateMutex: mutex,
    generateId: () => "abcd",
  });
  const create = service.createTask({
    chatKey: "weixin:user-1",
    sessionAlias: "internal-alias",
    executeAt: new Date(Date.now() + 60_000),
    message: "检查 CI",
  });

  await Promise.all([orchestration, create]);

  // In-memory state has the task.
  expect(state.scheduled_tasks.abcd).toBeDefined();
  // Serialization forces the create's save AFTER the orchestration snapshot save:
  // the orchestration save persisted no tasks, then the create persisted the task
  // last — so the on-disk state ends with the task present. Without the shared
  // mutex the create would interleave and the stale clone save would land last
  // (persisting []), silently dropping the task.
  expect(persistedTaskKeys).toEqual([[], ["abcd"]]);
});

test("creates a temp task that stores session_mode + agent/workspace snapshot", async () => {
  const state = createEmptyState();
  const service = new ScheduledTaskService(state, new MemoryStore(), {
    now: () => new Date("2026-05-24T09:00:00.000Z"),
    generateId: () => "tmp1",
  });

  const task = await service.createTask({
    chatKey: "weixin:user-1",
    sessionAlias: "backend:codex",
    executeAt: new Date("2026-05-24T10:00:00.000Z"),
    message: "检查 CI",
    sessionMode: "temp",
    agent: "codex",
    workspace: "backend",
  });

  expect(task.session_mode).toBe("temp");
  expect(task.agent).toBe("codex");
  expect(task.workspace).toBe("backend");
  expect(task.session_alias).toBe("backend:codex");
});

test("creates a bound task without agent/workspace snapshot", async () => {
  const state = createEmptyState();
  const service = new ScheduledTaskService(state, new MemoryStore(), {
    now: () => new Date("2026-05-24T09:00:00.000Z"),
    generateId: () => "bnd1",
  });

  const task = await service.createTask({
    chatKey: "weixin:user-1",
    sessionAlias: "backend:codex",
    executeAt: new Date("2026-05-24T10:00:00.000Z"),
    message: "检查 CI",
    sessionMode: "bound",
  });

  expect(task.session_mode).toBe("bound");
  expect(task.agent).toBeUndefined();
  expect(task.workspace).toBeUndefined();
});

test("creates a task without sessionMode, leaving mode/agent/workspace undefined (legacy default)", async () => {
  const state = createEmptyState();
  const service = new ScheduledTaskService(state, new MemoryStore(), {
    now: () => new Date("2026-05-24T09:00:00.000Z"),
    generateId: () => "leg1",
  });

  const task = await service.createTask({
    chatKey: "weixin:user-1",
    sessionAlias: "backend:codex",
    executeAt: new Date("2026-05-24T10:00:00.000Z"),
    message: "检查 CI",
  });

  expect(task.session_mode).toBeUndefined();
  expect(task.agent).toBeUndefined();
  expect(task.workspace).toBeUndefined();
});
