import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageRecordDto } from "@ganglion/xacpx-relay-protocol";
import { drop, dropAll, read, reconcile, resetSweepForTests, TAIL_ROWS, write } from "../lib/session-tail-cache";

const row = (id: number, text = `m${id}`): MessageRecordDto => ({
  id, instanceId: "i1", sessionAlias: "s1", direction: "out", text, createdAt: "2026-07-28T00:00:00.000Z",
});

beforeEach(() => {
  localStorage.clear();
  resetSweepForTests();
});
afterEach(() => vi.restoreAllMocks());

describe("session-tail-cache", () => {
  it("round-trips the tail and strips client-only fields + optimistic rows", () => {
    const rows = [
      { ...row(1), failed: true, status: "error" } as MessageRecordDto,
      row(2),
      // optimistic row (no id) must never be cached
      { instanceId: "i1", sessionAlias: "s1", direction: "in", text: "pending", createdAt: "x" } as MessageRecordDto,
    ];
    write("alice", "i1", "s1", rows);
    const back = read("alice", "i1", "s1")!;
    expect(back.map((r) => r.id)).toEqual([1, 2]);
    expect(back[0]).not.toHaveProperty("failed");
    expect(back[0]).not.toHaveProperty("status");
    expect(back[0]).toMatchObject({ text: "m1", direction: "out" });
  });

  it("keeps only the newest TAIL_ROWS rows", () => {
    write("alice", "i1", "s1", Array.from({ length: 100 }, (_, i) => row(i + 1)));
    const back = read("alice", "i1", "s1")!;
    expect(back.length).toBe(TAIL_ROWS);
    expect(back[0]!.id).toBe(100 - TAIL_ROWS + 1);
    expect(back.at(-1)!.id).toBe(100);
  });

  it("keeps structured payloads intact", () => {
    const r = { ...row(1), structured: { toolSteps: [{ toolCallId: "t", toolName: "R", kind: "read", status: "success", title: "x" }] } } as MessageRecordDto;
    write("alice", "i1", "s1", [r]);
    expect(read("alice", "i1", "s1")![0]!.structured?.toolSteps?.[0]).toMatchObject({ toolCallId: "t" });
  });

  it("misses across accounts, instances and aliases (key isolation)", () => {
    write("alice", "i1", "s1", [row(1)]);
    expect(read("bob", "i1", "s1")).toBeNull();
    expect(read("alice", "i2", "s1")).toBeNull();
    expect(read("alice", "i1", "s2")).toBeNull();
  });

  it("trims oldest rows to fit the per-entry budget", () => {
    const fat = (id: number): MessageRecordDto => row(id, "x".repeat(30_000)); // ~60 KB serialized each
    write("alice", "i1", "s1", Array.from({ length: 10 }, (_, i) => fat(i + 1)));
    const back = read("alice", "i1", "s1")!;
    expect(back.length).toBeLessThan(10);
    expect(back.at(-1)!.id).toBe(10); // newest survives; oldest trimmed
  });

  it("skips caching when a single row exceeds the per-entry budget", () => {
    write("alice", "i1", "s1", [row(1, "x".repeat(200_000))]);
    expect(read("alice", "i1", "s1")).toBeNull();
  });

  it("evicts least-recently-accessed entries beyond the global budget", () => {
    // ~200 KB (bytes) per entry; 25 entries ≈ 5 MB > the 4 MB budget.
    const fat = (alias: string, id: number): void => write("alice", "i1", alias, [row(id, "x".repeat(100_000))]);
    for (let i = 0; i < 25; i += 1) fat(`s${i}`, i + 1);
    expect(read("alice", "i1", "s0")).toBeNull(); // earliest written → evicted
    expect(read("alice", "i1", "s24")).not.toBeNull(); // newest survives
  });

  it("expires entries older than the TTL", () => {
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    write("alice", "i1", "s1", [row(1)]);
    now.mockReturnValue(t0 + 8 * 24 * 60 * 60 * 1000); // 8 days later
    expect(read("alice", "i1", "s1")).toBeNull();
  });

  it("a read refreshes lastAccess (LRU touch)", () => {
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    write("alice", "i1", "s1", [row(1)]);
    now.mockReturnValue(t0 + 6 * 24 * 60 * 60 * 1000); // day 6: touch
    expect(read("alice", "i1", "s1")).not.toBeNull();
    now.mockReturnValue(t0 + 12 * 24 * 60 * 60 * 1000); // day 12: 6 days since touch
    expect(read("alice", "i1", "s1")).not.toBeNull();
  });

  it("retries once after a quota error by evicting the LRU entry", () => {
    write("alice", "i1", "old", [row(1)]);
    const original = Storage.prototype.setItem;
    let threw = false;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (!threw && key.includes(".s1")) { threw = true; throw new DOMException("quota", "QuotaExceededError"); }
      original.call(this, key, value);
    });
    write("alice", "i1", "s1", [row(2)]);
    expect(threw).toBe(true);
    expect(read("alice", "i1", "s1")!.map((r) => r.id)).toEqual([2]);
    expect(read("alice", "i1", "old")).toBeNull(); // the eviction victim
  });

  it("gives up silently when the quota retry also fails, without orphaning the stale entry", () => {
    write("alice", "i1", "s1", [row(1, "old")]);
    const entryKey = Object.keys(localStorage).find((k) => k.startsWith("xacpx.chat.tail.v1.") && k.endsWith(".s1"))!;
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.startsWith("xacpx.chat.tail.v1.")) throw new DOMException("quota", "QuotaExceededError");
      original.call(this, key, value);
    });
    expect(() => write("alice", "i1", "s1", [row(2, "new")])).not.toThrow();
    vi.restoreAllMocks();
    expect(read("alice", "i1", "s1")).toBeNull();
    // The previous stored value must not linger as an index-less orphan holding quota.
    expect(localStorage.getItem(entryKey)).toBeNull();
  });

  it("drop purges one session; dropAll purges everything", () => {
    write("alice", "i1", "s1", [row(1)]);
    write("alice", "i1", "s2", [row(2)]);
    drop("alice", "i1", "s1");
    expect(read("alice", "i1", "s1")).toBeNull();
    expect(read("alice", "i1", "s2")).not.toBeNull();
    dropAll();
    expect(read("alice", "i1", "s2")).toBeNull();
    expect(Object.keys(localStorage).filter((k) => k.startsWith("xacpx.chat.tail"))).toEqual([]);
  });

  it("reconcile drops entries whose alias is not alive, scoped to the instance + user", () => {
    write("alice", "i1", "s1", [row(1)]);
    write("alice", "i1", "s2", [row(2)]);
    write("alice", "i2", "s2", [row(3)]);
    write("bob", "i1", "s2", [row(4)]);
    reconcile("alice", "i1", ["s1"]);
    expect(read("alice", "i1", "s1")).not.toBeNull();
    expect(read("alice", "i1", "s2")).toBeNull(); // dead alias dropped
    expect(read("alice", "i2", "s2")).not.toBeNull(); // other instance untouched
    expect(read("bob", "i1", "s2")).not.toBeNull(); // other account untouched
  });

  it("handles dotted aliases/instance ids without cross-matching in reconcile", () => {
    write("alice", "i.1", "a.b", [row(1)]);
    write("alice", "i.1", "a.b.c", [row(2)]);
    reconcile("alice", "i.1", ["a.b"]);
    expect(read("alice", "i.1", "a.b")).not.toBeNull();
    expect(read("alice", "i.1", "a.b.c")).toBeNull();
  });

  it("sweeps old-version keys lazily by prefix", () => {
    localStorage.setItem("xacpx.chat.tail.v0.alice.i1.s1", "[]");
    localStorage.setItem("xacpx.chat.tail-index.v0", "[]");
    resetSweepForTests();
    read("alice", "i1", "s1");
    expect(localStorage.getItem("xacpx.chat.tail.v0.alice.i1.s1")).toBeNull();
    expect(localStorage.getItem("xacpx.chat.tail-index.v0")).toBeNull();
  });

  it("never throws when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "key").mockImplementation(() => { throw new Error("blocked"); });
    expect(read("alice", "i1", "s1")).toBeNull();
    expect(() => write("alice", "i1", "s1", [row(1)])).not.toThrow();
    expect(() => drop("alice", "i1", "s1")).not.toThrow();
    expect(() => dropAll()).not.toThrow();
    expect(() => reconcile("alice", "i1", ["s1"])).not.toThrow();
  });
});
