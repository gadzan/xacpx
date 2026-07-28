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
