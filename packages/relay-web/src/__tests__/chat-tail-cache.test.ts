import { createPinia, setActivePinia } from "pinia";
import { beforeEach, expect, test, vi } from "vitest";
import type { MessageRecordDto } from "@ganglion/xacpx-relay-protocol";
import { read, resetSweepForTests, write } from "../lib/session-tail-cache";

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

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  resetSweepForTests();
  getMock.mockReset();
  rpc.mockReset();
  post.mockClear();
  useAuthStore().account = { username: "alice" };
});

test("select() seeds the transcript synchronously from the cached tail (no skeleton)", () => {
  write("alice", "i1", "s1", [row(1), row(2)]);
  const chat = useChatStore();
  chat.select("i1", "s1");
  // Synchronous — no network round-trip involved.
  expect(chat.messages.map((m) => m.id)).toEqual([1, 2]);
  expect(chat.loadingHistory).toBe(false);
});

test("select() leaves the transcript empty on cache miss or when logged out", () => {
  const chat = useChatStore();
  chat.select("i1", "s1");
  expect(chat.messages).toEqual([]);
  write("alice", "i1", "s2", [row(1)]);
  useAuthStore().account = null;
  chat.select("i1", "s2");
  expect(chat.messages).toEqual([]);
});

test("authoritative loadHistory replaces the seeded tail and writes back on the next switch", async () => {
  write("alice", "i1", "s1", [row(1, "stale")]);
  const chat = useChatStore();
  chat.select("i1", "s1");
  expect(chat.messages.map((m) => m.id)).toEqual([1]);

  const fresh = Array.from({ length: 50 }, (_, i) => row(i + 1, `fresh${i + 1}`));
  getMock.mockResolvedValue({ messages: fresh, hasMore: false });
  await chat.loadHistory();
  expect(chat.messages.length).toBe(50); // full replace, stale row converged

  // The write-back is debounced; switching sessions flushes it for the outgoing session.
  chat.select("i1", "other");
  const cached = read("alice", "i1", "s1")!;
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
  expect(read("alice", "i1", "s1")!.map((r) => r.id)).toEqual([1]);
});

test("loadHistory failure keeps showing the cached tail", async () => {
  write("alice", "i1", "s1", [row(1), row(2)]);
  const chat = useChatStore();
  chat.select("i1", "s1");
  getMock.mockRejectedValue(new Error("network"));
  await expect(chat.loadHistory()).rejects.toThrow();
  expect(chat.messages.map((m) => m.id)).toEqual([1, 2]);
});

test("archiveSession and removeSession purge the session's cache", async () => {
  write("alice", "i1", "s1", [row(1)]);
  write("alice", "i1", "s2", [row(2)]);
  rpc.mockResolvedValue({ sessions: [], agents: [] });
  const instances = useInstancesStore();
  await instances.archiveSession("i1", "s1");
  expect(read("alice", "i1", "s1")).toBeNull();
  await instances.removeSession("i1", "s2");
  expect(read("alice", "i1", "s2")).toBeNull();
});

test("loadSessions reconciles the cache against alive unarchived aliases", async () => {
  write("alice", "i1", "alive", [row(1)]);
  write("alice", "i1", "archived", [row(2)]);
  write("alice", "i1", "gone", [row(3)]);
  rpc.mockImplementation(async (_id: string, type: string) => {
    if (type === "control.sessions.list") {
      return { sessions: [
        { alias: "alive", agent: "a", workspace: "w", transportSession: "t", running: false, archived: false },
        { alias: "archived", agent: "a", workspace: "w", transportSession: "t", running: false, archived: true },
      ] };
    }
    return { agents: [] };
  });
  await useInstancesStore().loadSessions("i1");
  expect(read("alice", "i1", "alive")).not.toBeNull();
  expect(read("alice", "i1", "archived")).toBeNull(); // archived elsewhere → dropped
  expect(read("alice", "i1", "gone")).toBeNull(); // removed elsewhere → dropped
});

test("logout drops every cached transcript", async () => {
  write("alice", "i1", "s1", [row(1)]);
  write("bob", "i2", "s9", [row(2)]);
  await useAuthStore().logout();
  expect(Object.keys(localStorage).filter((k) => k.startsWith("xacpx.chat.tail"))).toEqual([]);
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
  chat.select("i1", "s1"); // reselect: transcript is seeded from the cache
  expect(chat.messages.map((m) => m.id)).toEqual([1]);
  // The pending-prompt guard must treat the cache-seeded transcript as empty and
  // fetch anyway — otherwise the just-sent (already persisted) prompt row stays
  // invisible until the RPC settles.
  getMock.mockResolvedValue({ messages: [row(1), row(2, "hello")], hasMore: false });
  await chat.loadHistory();
  expect(chat.messages.map((m) => m.id)).toEqual([1, 2]);
  chat.clearSelection(); // flush the pending write-back so no timer leaks into later tests
});

test("an optimistic send clears the seeded state so a mid-prompt reload defers again", async () => {
  write("alice", "i1", "s1", [row(1)]);
  const chat = useChatStore();
  chat.select("i1", "s1"); // seeded
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
  vi.useFakeTimers();
  try {
    const chat = useChatStore();
    chat.select("i1", "s1");
    getMock.mockResolvedValue({ messages: [row(1)], hasMore: false });
    await chat.loadHistory();
    expect(read("alice", "i1", "s1")).toBeNull(); // still debounced
    vi.advanceTimersByTime(500);
    expect(read("alice", "i1", "s1")!.map((r) => r.id)).toEqual([1]);
  } finally {
    vi.useRealTimers();
  }
});

test("pagehide flushes a pending write-back", async () => {
  const chat = useChatStore();
  chat.select("i1", "s1");
  getMock.mockResolvedValue({ messages: [row(1)], hasMore: false });
  await chat.loadHistory();
  window.dispatchEvent(new Event("pagehide"));
  expect(read("alice", "i1", "s1")!.map((r) => r.id)).toEqual([1]);
});

test("archiving cancels a pending write-back so it cannot resurrect the purged entry", async () => {
  vi.useFakeTimers();
  try {
    const chat = useChatStore();
    chat.select("i1", "s1");
    getMock.mockResolvedValue({ messages: [row(1)], hasMore: false });
    await chat.loadHistory(); // schedules the debounced write-back
    rpc.mockResolvedValue({ sessions: [], agents: [] });
    await useInstancesStore().archiveSession("i1", "s1"); // purge + cancel
    vi.advanceTimersByTime(500); // the cancelled timer must not fire
    expect(read("alice", "i1", "s1")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
