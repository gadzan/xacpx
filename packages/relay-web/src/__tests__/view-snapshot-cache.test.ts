import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import {
  captureWriteToken,
  dropAll,
  dropSession,
  peek,
  read,
  resetViewSnapshotCacheForTests,
  write,
} from "../lib/view-snapshot-cache";

beforeEach(async () => {
  await resetViewSnapshotCacheForTests();
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

describe("view-snapshot-cache", () => {
  it("updates the hot cache synchronously and survives a memory reset", async () => {
    const pending = write("alice", "session-model", "i1", "s1", {
      current: "gpt-5",
      available: ["gpt-5"],
    });
    expect(peek("alice", "session-model", "i1", "s1")).toEqual({
      current: "gpt-5",
      available: ["gpt-5"],
    });
    await pending;
    await resetViewSnapshotCacheForTests();
    expect(await read("alice", "session-model", "i1", "s1")).toEqual({
      current: "gpt-5",
      available: ["gpt-5"],
    });
  });

  it("isolates users and scopes", async () => {
    await write("alice", "scheduled-tasks", "i1", "s1", ["a"]);
    await write("alice", "scheduled-tasks", "i1", "s2", ["b"]);
    expect(await read("alice", "scheduled-tasks", "i1", "s1")).toEqual(["a"]);
    expect(await read("alice", "scheduled-tasks", "i1", "s2")).toEqual(["b"]);
    expect(await read("bob", "scheduled-tasks", "i1", "s1")).toBeNull();
  });

  it("drops only session-owned namespaces when a session is deleted", async () => {
    await write("alice", "session-effort", "i1", "s1", { current: "high" });
    await write("alice", "orchestration-tasks", "i1", "", ["shared"]);
    await dropSession("alice", "i1", "s1");
    expect(await read("alice", "session-effort", "i1", "s1")).toBeNull();
    expect(await read("alice", "orchestration-tasks", "i1", "")).toEqual(["shared"]);
  });

  it("rejects a stale session write captured before the session was dropped", async () => {
    const staleWrite = captureWriteToken("alice", "session-model", "i1", "s1");
    await dropSession("alice", "i1", "s1");

    await write(
      "alice",
      "session-model",
      "i1",
      "s1",
      { current: "deleted-session-model" },
      staleWrite,
    );

    expect(await read("alice", "session-model", "i1", "s1")).toBeNull();
  });

  it("dropAll clears memory and IndexedDB", async () => {
    await write("alice", "git-summary", "i1", "ws", { changedCount: 2 });
    await dropAll();
    expect(peek("alice", "git-summary", "i1", "ws")).toBeNull();
    expect(await read("alice", "git-summary", "i1", "ws")).toBeNull();
  });

  it("rejects a stale write captured before all snapshots were dropped", async () => {
    const staleWrite = captureWriteToken("alice", "orchestration-tasks", "i1", "");
    await dropAll();

    await write("alice", "orchestration-tasks", "i1", "", ["stale"], staleWrite);

    expect(await read("alice", "orchestration-tasks", "i1", "")).toBeNull();
  });

  it("never throws when IndexedDB is unavailable", async () => {
    await resetViewSnapshotCacheForTests();
    const original = globalThis.indexedDB;
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
    try {
      await expect(read("alice", "session-model", "i1", "s1")).resolves.toBeNull();
      await expect(write("alice", "session-model", "i1", "s1", { current: "x" })).resolves.toBeUndefined();
      expect(peek("alice", "session-model", "i1", "s1")).toEqual({ current: "x" });
    } finally {
      Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: original });
    }
  });
});
