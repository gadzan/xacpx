import { createPinia, setActivePinia } from "pinia";
import { beforeEach, expect, test, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import type { MessageRecordDto } from "@ganglion/xacpx-relay-protocol";
import { read, resetTailCacheForTests, write } from "../lib/session-tail-cache";

const getMock = vi.fn();
const rpc = vi.fn();
const post = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(public code: string, public status: number) {
      super(code);
    }
  },
  api: {
    get: (path: string) => getMock(path),
    rpc: (instanceId: string, type: string, payload?: unknown) => rpc(instanceId, type, payload),
    post: (path: string, body?: unknown) => post(path, body),
  },
}));

import { useAuthStore } from "../stores/auth";
import { useChatStore } from "../stores/chat";
import { useInstancesStore } from "../stores/instances";

const row = (id: number, text = `m${id}`): MessageRecordDto => ({
  id, instanceId: "i1", sessionAlias: "s1", direction: "out", text, createdAt: "2026-07-28T00:00:00.000Z",
});

/** The cache write-back is fire-and-forget; poll until the entry appears. */
async function readEventually(user: string, instanceId: string, alias: string): Promise<MessageRecordDto[] | null> {
  for (let i = 0; i < 100; i += 1) {
    const rows = await read(user, instanceId, alias);
    if (rows) return rows;
    await new Promise((r) => setTimeout(r, 5));
  }
  return null;
}

/** Purges are fire-and-forget too; poll until the entry is gone. */
async function goneEventually(user: string, instanceId: string, alias: string): Promise<boolean> {
  for (let i = 0; i < 100; i += 1) {
    if ((await read(user, instanceId, alias)) === null) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

beforeEach(async () => {
  setActivePinia(createPinia());
  await resetTailCacheForTests();
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  localStorage.clear();
  getMock.mockReset();
  rpc.mockReset();
  post.mockClear();
  useAuthStore().account = { username: "alice" };
});

test("select() seeds the transcript from the cached tail before any fetch (no skeleton)", async () => {
  await write("alice", "i1", "s1", [row(1), row(2)]);
  const chat = useChatStore();
  chat.select("i1", "s1");
  await vi.waitFor(() => expect(chat.messages.map((m) => m.id)).toEqual([1, 2]));
  expect(chat.loadingHistory).toBe(false);
});

test("select() leaves the transcript empty on cache miss or when logged out", async () => {
  const chat = useChatStore();
  chat.select("i1", "s1");
  await new Promise((r) => setTimeout(r, 20));
  expect(chat.messages).toEqual([]);
  await write("alice", "i1", "s2", [row(1)]);
  useAuthStore().account = null;
  chat.select("i1", "s2");
  await new Promise((r) => setTimeout(r, 20));
  expect(chat.messages).toEqual([]);
});

test("authoritative loadHistory replaces the seeded tail and writes back on the next switch", async () => {
  await write("alice", "i1", "s1", [row(1, "stale")]);
  const chat = useChatStore();
  chat.select("i1", "s1");
  await vi.waitFor(() => expect(chat.messages.map((m) => m.id)).toEqual([1]));

  const fresh = Array.from({ length: 50 }, (_, i) => row(i + 1, `fresh${i + 1}`));
  getMock.mockResolvedValue({ messages: fresh, hasMore: false });
  await chat.loadHistory();
  expect(chat.messages.length).toBe(50); // full replace, stale row converged

  // The write-back is debounced; switching sessions flushes it for the outgoing session.
  chat.select("i1", "other");
  const cached = (await readEventually("alice", "i1", "s1"))!;
  expect(cached.length).toBe(30); // tail only
  expect(cached.at(-1)).toMatchObject({ id: 50, text: "fresh50" });
});

test("optimistic rows (no id) are never written to the cache", async () => {
  const chat = useChatStore();
  chat.select("i1", "s1");
  getMock.mockResolvedValue({ messages: [row(1)], hasMore: false });
  await chat.loadHistory();
  // A streamed turn flushes an optimistic out-row without an id.
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-output", chatKey: "c", sessionAlias: "s1", chunk: "live" } });
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "c", sessionAlias: "s1", ok: true } });
  chat.select("i1", "other"); // flush pending write-back
  expect((await readEventually("alice", "i1", "s1"))!.map((r) => r.id)).toEqual([1]);
});

test("loadHistory failure keeps showing the cached tail", async () => {
  await write("alice", "i1", "s1", [row(1), row(2)]);
  const chat = useChatStore();
  chat.select("i1", "s1");
  await vi.waitFor(() => expect(chat.messages.map((m) => m.id)).toEqual([1, 2]));
  getMock.mockRejectedValue(new Error("network"));
  await expect(chat.loadHistory()).rejects.toThrow();
  expect(chat.messages.map((m) => m.id)).toEqual([1, 2]);
});

test("removeSession purges the cache; archiveSession (sleep) keeps it", async () => {
  await write("alice", "i1", "s1", [row(1)]);
  await write("alice", "i1", "s2", [row(2)]);
  rpc.mockImplementation(async (_id: string, type: string) => {
    if (type === "control.sessions.list") {
      return { sessions: [
        { alias: "s1", agent: "a", workspace: "w", transportSession: "t", running: false, archived: true },
      ] };
    }
    return { agents: [], sessions: [] };
  });
  const instances = useInstancesStore();
  // Sleeping a session must NOT drop its cache — waking it should paint instantly.
  await instances.archiveSession("i1", "s1");
  await new Promise((r) => setTimeout(r, 20));
  expect(await read("alice", "i1", "s1")).not.toBeNull();
  await instances.removeSession("i1", "s2");
  expect(await goneEventually("alice", "i1", "s2")).toBe(true);
});

test("loadSessions reconciles the cache against alive aliases, keeping sleeping sessions", async () => {
  await write("alice", "i1", "alive", [row(1)]);
  await write("alice", "i1", "sleeping", [row(2)]);
  await write("alice", "i1", "gone", [row(3)]);
  rpc.mockImplementation(async (_id: string, type: string) => {
    if (type === "control.sessions.list") {
      return { sessions: [
        { alias: "alive", agent: "a", workspace: "w", transportSession: "t", running: false, archived: false },
        { alias: "sleeping", agent: "a", workspace: "w", transportSession: "t", running: false, archived: true },
      ] };
    }
    return { agents: [] };
  });
  await useInstancesStore().loadSessions("i1");
  expect(await goneEventually("alice", "i1", "gone")).toBe(true); // removed elsewhere → dropped
  expect(await read("alice", "i1", "alive")).not.toBeNull();
  expect(await read("alice", "i1", "sleeping")).not.toBeNull(); // slept elsewhere → kept
});

test("logout drops every cached transcript (all users) plus legacy localStorage keys", async () => {
  await write("alice", "i1", "s1", [row(1)]);
  await write("bob", "i2", "s9", [row(2)]);
  localStorage.setItem("xacpx.chat.tail.v1.alice.i1.s1", "[]");
  await useAuthStore().logout();
  expect(await read("alice", "i1", "s1")).toBeNull();
  expect(await read("bob", "i2", "s9")).toBeNull();
  expect(localStorage.getItem("xacpx.chat.tail.v1.alice.i1.s1")).toBeNull();
});

test("reselecting a session mid-prompt still fetches history over a cache seed (#199)", async () => {
  const chat = useChatStore();
  chat.select("i1", "s1");
  getMock.mockResolvedValue({ messages: [row(1)], hasMore: false });
  await chat.loadHistory();
  // The prompt RPC stays pending for the whole turn (non-queued prompt).
  rpc.mockReturnValue(new Promise(() => {}));
  void chat.send("hello");
  chat.select("i1", "other"); // switch away (flushes s1's tail into the cache)
  await readEventually("alice", "i1", "s1"); // write-back is async — wait for it
  chat.select("i1", "s1"); // reselect: transcript is seeded from the cache
  await vi.waitFor(() => expect(chat.messages.map((m) => m.id)).toEqual([1]));
  // The pending-prompt guard must treat the cache-seeded transcript as empty and
  // fetch anyway — otherwise the just-sent (already persisted) prompt row stays
  // invisible until the RPC settles.
  getMock.mockResolvedValue({ messages: [row(1), row(2, "hello")], hasMore: false });
  await chat.loadHistory();
  expect(chat.messages.map((m) => m.id)).toEqual([1, 2]);
  chat.clearSelection(); // flush the pending write-back so no timer leaks into later tests
});

test("an optimistic send clears the seeded state so a mid-prompt reload defers again", async () => {
  await write("alice", "i1", "s1", [row(1)]);
  const chat = useChatStore();
  chat.select("i1", "s1");
  await vi.waitFor(() => expect(chat.messages.map((m) => m.id)).toEqual([1])); // seeded
  rpc.mockReturnValue(new Promise(() => {}));
  void chat.send("hello"); // pushes an optimistic row → transcript no longer seed-only
  getMock.mockResolvedValue({ messages: [row(1), row(2, "hello")], hasMore: false });
  await chat.loadHistory();
  // Guard defers: the optimistic row (id undefined until the RPC settles) is
  // protected. Asserting on ids distinguishes defer ([1, undefined]) from a
  // full-page replace ([1, 2]) — texts would be identical either way.
  expect(chat.messages.map((m) => m.id)).toEqual([1, undefined]);
});

test("write-back fires on the debounce timer without a session switch", async () => {
  // Fake only the debounce's timer — fake-indexeddb's scheduling must stay real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const chat = useChatStore();
    chat.select("i1", "s1");
    getMock.mockResolvedValue({ messages: [row(1)], hasMore: false });
    await chat.loadHistory();
    expect(await read("alice", "i1", "s1")).toBeNull(); // still debounced
    vi.advanceTimersByTime(500);
  } finally {
    vi.useRealTimers();
  }
  expect((await readEventually("alice", "i1", "s1"))!.map((r) => r.id)).toEqual([1]);
});

test("pagehide flushes a pending write-back", async () => {
  const chat = useChatStore();
  chat.select("i1", "s1");
  getMock.mockResolvedValue({ messages: [row(1)], hasMore: false });
  await chat.loadHistory();
  window.dispatchEvent(new Event("pagehide"));
  expect((await readEventually("alice", "i1", "s1"))!.map((r) => r.id)).toEqual([1]);
});

test("removing cancels a pending write-back so it cannot resurrect the purged entry", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const chat = useChatStore();
    chat.select("i1", "s1");
    getMock.mockResolvedValue({ messages: [row(1)], hasMore: false });
    await chat.loadHistory(); // schedules the debounced write-back
    rpc.mockResolvedValue({ sessions: [], agents: [] });
    await useInstancesStore().removeSession("i1", "s1"); // purge + cancel
    vi.advanceTimersByTime(500); // the cancelled timer must not fire
  } finally {
    vi.useRealTimers();
  }
  await new Promise((r) => setTimeout(r, 20));
  expect(await read("alice", "i1", "s1")).toBeNull();
});
