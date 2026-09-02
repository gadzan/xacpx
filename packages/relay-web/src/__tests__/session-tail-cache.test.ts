import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import type { MessageRecordDto } from "@ganglion/xacpx-relay-protocol";
import { drop, dropAll, read, reconcile, resetTailCacheForTests, TAIL_ROWS, write } from "../lib/session-tail-cache";

const row = (id: number, text = `m${id}`): MessageRecordDto => ({
  id, instanceId: "i1", sessionAlias: "s1", direction: "out", text, createdAt: "2026-07-28T00:00:00.000Z",
});

const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await resetTailCacheForTests();
  // Fresh factory per test — no cross-test IndexedDB state.
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe("session-tail-cache", () => {
  it("round-trips the tail and strips client-only fields + optimistic rows", async () => {
    const rows = [
      { ...row(1), failed: true, status: "error" } as MessageRecordDto,
      row(2),
      // optimistic row (no id) must never be cached
      { instanceId: "i1", sessionAlias: "s1", direction: "in", text: "pending", createdAt: "x" } as MessageRecordDto,
    ];
    await write("alice", "i1", "s1", rows);
    const back = (await read("alice", "i1", "s1"))!;
    expect(back.map((r) => r.id)).toEqual([1, 2]);
    expect(back[0]).not.toHaveProperty("failed");
    expect(back[0]).not.toHaveProperty("status");
    expect(back[0]).toMatchObject({ text: "m1", direction: "out" });
  });

  it("keeps only the newest TAIL_ROWS rows", async () => {
    await write("alice", "i1", "s1", Array.from({ length: 100 }, (_, i) => row(i + 1)));
    const back = (await read("alice", "i1", "s1"))!;
    expect(back.length).toBe(TAIL_ROWS);
    expect(back[0]!.id).toBe(100 - TAIL_ROWS + 1);
    expect(back.at(-1)!.id).toBe(100);
  });

  it("keeps structured payloads intact", async () => {
    const r = { ...row(1), structured: { toolSteps: [{ toolCallId: "t", toolName: "R", kind: "read", status: "success", title: "x" }] } } as MessageRecordDto;
    await write("alice", "i1", "s1", [r]);
    expect((await read("alice", "i1", "s1"))![0]!.structured?.toolSteps?.[0]).toMatchObject({ toolCallId: "t" });
  });

  it("round-trips startedAt so a cache seed can keep HUD elapsed after reload", async () => {
    await write("alice", "i1", "s1", [{ ...row(1), startedAt: 1_700_000_000_000 }]);
    expect((await read("alice", "i1", "s1"))![0]!.startedAt).toBe(1_700_000_000_000);
  });

  it("round-trips slotAfterId so a cache seed can keep the live-slot anchor", async () => {
    await write("alice", "i1", "s1", [{ ...row(1), slotAfterId: 7, startedAfterSeq: 3 }]);
    const cached = (await read("alice", "i1", "s1"))![0]!;
    expect(cached.slotAfterId).toBe(7);
    expect(cached.startedAfterSeq).toBe(3);
  });

  it("misses across accounts, instances and aliases (key isolation)", async () => {
    await write("alice", "i1", "s1", [row(1)]);
    expect(await read("bob", "i1", "s1")).toBeNull();
    expect(await read("alice", "i2", "s1")).toBeNull();
    expect(await read("alice", "i1", "s2")).toBeNull();
  });

  it("caches oversized rows whole — no per-entry budget (regression: 640KB tool turns lost their cache)", async () => {
    const fat = (id: number): MessageRecordDto => row(id, "x".repeat(400_000)); // ~800KB per row
    await write("alice", "i1", "s1", Array.from({ length: 5 }, (_, i) => fat(i + 1)));
    const back = (await read("alice", "i1", "s1"))!;
    expect(back.length).toBe(5);
    expect(back[0]!.text.length).toBe(400_000);
  });

  it("evicts least-recently-accessed entries beyond the global budget", async () => {
    // ~32MB (bytes estimate) per entry; 3 entries ≈ 96MB > the 64MB budget.
    const fat = (alias: string, id: number): Promise<void> =>
      write("alice", "i1", alias, [row(id, "x".repeat(16_000_000))]);
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(t0);
    await fat("s0", 1);
    now.mockReturnValue(t0 + 1000);
    await fat("s1", 2);
    now.mockReturnValue(t0 + 2000);
    await fat("s2", 3);
    expect(await read("alice", "i1", "s0")).toBeNull(); // least recent → evicted
    expect(await read("alice", "i1", "s2")).not.toBeNull(); // newest survives
  });

  it("expires entries older than the TTL", async () => {
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    await write("alice", "i1", "s1", [row(1)]);
    now.mockReturnValue(t0 + 31 * DAY);
    expect(await read("alice", "i1", "s1")).toBeNull();
  });

  it("a read refreshes lastAccess (LRU touch)", async () => {
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    await write("alice", "i1", "s1", [row(1)]);
    now.mockReturnValue(t0 + 20 * DAY); // day 20: touch
    expect(await read("alice", "i1", "s1")).not.toBeNull();
    now.mockReturnValue(t0 + 45 * DAY); // day 45: 25 days since touch
    expect(await read("alice", "i1", "s1")).not.toBeNull();
  });

  it("drops a corrupted entry (non-object elements) instead of returning it", async () => {
    await write("alice", "i1", "s1", [row(1)]);
    // Corrupt the stored record through a second raw connection.
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("xacpx.chat-tail");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction("tails", "readwrite");
        tx.objectStore("tails").put({ user: "alice", instanceId: "i1", alias: "s1", rows: [null], lastAccess: Date.now(), bytes: 8 });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
    expect(await read("alice", "i1", "s1")).toBeNull();
    expect(await read("alice", "i1", "s1")).toBeNull(); // stays gone (entry deleted)
  });

  it("drop purges one session; dropAll purges everything", async () => {
    await write("alice", "i1", "s1", [row(1)]);
    await write("alice", "i1", "s2", [row(2)]);
    await drop("alice", "i1", "s1");
    expect(await read("alice", "i1", "s1")).toBeNull();
    expect(await read("alice", "i1", "s2")).not.toBeNull();
    await dropAll();
    expect(await read("alice", "i1", "s2")).toBeNull();
  });

  it("dropAll also clears legacy localStorage entries", async () => {
    localStorage.setItem("xacpx.chat.tail.v1.alice.i1.s1", "[]");
    localStorage.setItem("xacpx.chat.tail-index.v1", "[]");
    await dropAll();
    expect(localStorage.getItem("xacpx.chat.tail.v1.alice.i1.s1")).toBeNull();
    expect(localStorage.getItem("xacpx.chat.tail-index.v1")).toBeNull();
  });

  it("reconcile drops entries whose alias is not alive, scoped to the instance + user", async () => {
    await write("alice", "i1", "s1", [row(1)]);
    await write("alice", "i1", "s2", [row(2)]);
    await write("alice", "i2", "s2", [row(3)]);
    await write("bob", "i1", "s2", [row(4)]);
    await reconcile("alice", "i1", [{ alias: "s1" }]);
    expect(await read("alice", "i1", "s1")).not.toBeNull();
    expect(await read("alice", "i1", "s2")).toBeNull(); // dead alias dropped
    expect(await read("alice", "i2", "s2")).not.toBeNull(); // other instance untouched
    expect(await read("bob", "i1", "s2")).not.toBeNull(); // other account untouched
  });

  it("handles dotted aliases/instance ids without cross-matching in reconcile", async () => {
    await write("alice", "i.1", "a.b", [row(1)]);
    await write("alice", "i.1", "a.b.c", [row(2)]);
    await reconcile("alice", "i.1", [{ alias: "a.b" }]);
    expect(await read("alice", "i.1", "a.b")).not.toBeNull();
    expect(await read("alice", "i.1", "a.b.c")).toBeNull();
  });

  it("read misses (and deletes) when the stored incarnation mismatches", async () => {
    await write("alice", "i1", "s1", [row(1)], "inc-A");
    expect(await read("alice", "i1", "s1", "inc-B")).toBeNull();
    // Entry was deleted — even a wildcard read stays a miss now.
    expect(await read("alice", "i1", "s1")).toBeNull();
  });

  it("treats an unknown incarnation (\"\") as a wildcard in both directions", async () => {
    await write("alice", "i1", "s1", [row(1)], "inc-A");
    expect(await read("alice", "i1", "s1", "")).not.toBeNull(); // reader doesn't know yet
    await write("alice", "i1", "s2", [row(2)]); // writer didn't know
    expect(await read("alice", "i1", "s2", "inc-B")).not.toBeNull();
    expect(await read("alice", "i1", "s1", "inc-A")).not.toBeNull(); // exact match hits
  });

  it("reconcile drops an alive alias whose incarnation changed (same-alias recreation)", async () => {
    await write("alice", "i1", "s1", [row(1)], "inc-old");
    await write("alice", "i1", "s2", [row(2)], "inc-keep");
    await write("alice", "i1", "s3", [row(3)]); // stored incarnation unknown
    await reconcile("alice", "i1", [
      { alias: "s1", incarnation: "inc-new" },
      { alias: "s2", incarnation: "inc-keep" },
      { alias: "s3", incarnation: "inc-x" },
    ]);
    expect(await read("alice", "i1", "s1")).toBeNull(); // recreated → old tail dropped
    expect(await read("alice", "i1", "s2")).not.toBeNull(); // same incarnation kept
    expect(await read("alice", "i1", "s3")).not.toBeNull(); // unknown stored → kept
  });

  it("a wildcard (\"\") write preserves the entry's previously stored incarnation", async () => {
    await write("alice", "i1", "s1", [row(1)], "inc-A");
    // e.g. the first flush after a page refresh, before loadSessions lands.
    await write("alice", "i1", "s1", [row(2)], "");
    expect((await read("alice", "i1", "s1", "inc-A"))!.map((r) => r.id)).toEqual([2]); // fresh rows, old tag
    expect(await read("alice", "i1", "s1", "inc-B")).toBeNull(); // tag not downgraded to wildcard
  });

  it("reconcile stamps the live incarnation onto stored-\"\" entries (adoption)", async () => {
    await write("alice", "i1", "s1", [row(1)]);
    await reconcile("alice", "i1", [{ alias: "s1", incarnation: "inc-A" }]);
    expect(await read("alice", "i1", "s1", "inc-A")).not.toBeNull();
    expect(await read("alice", "i1", "s1", "inc-B")).toBeNull(); // adopted → recreation now detectable
  });

  it("sweeps legacy localStorage keys once on first use", async () => {
    localStorage.setItem("xacpx.chat.tail.v1.alice.i1.s1", "[]");
    localStorage.setItem("xacpx.chat.tail-index.v1", "[]");
    localStorage.setItem("xacpx.unrelated", "keep");
    await read("alice", "i1", "s1");
    expect(localStorage.getItem("xacpx.chat.tail.v1.alice.i1.s1")).toBeNull();
    expect(localStorage.getItem("xacpx.chat.tail-index.v1")).toBeNull();
    expect(localStorage.getItem("xacpx.unrelated")).toBe("keep");
  });

  it("never throws when IndexedDB is unavailable", async () => {
    await resetTailCacheForTests();
    vi.stubGlobal("indexedDB", undefined);
    try {
      expect(await read("alice", "i1", "s1")).toBeNull();
      await expect(write("alice", "i1", "s1", [row(1)])).resolves.toBeUndefined();
      await expect(drop("alice", "i1", "s1")).resolves.toBeUndefined();
      await expect(dropAll()).resolves.toBeUndefined();
      await expect(reconcile("alice", "i1", [{ alias: "s1" }])).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
