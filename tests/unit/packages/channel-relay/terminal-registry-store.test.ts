import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TerminalRegistryInventoryUncertainError,
  TerminalRegistryRevisionMismatchError,
  TerminalRegistryStore,
} from "../../../../packages/channel-relay/src/terminal/terminal-registry-store";
import type { TerminalRecordV1 } from "../../../../packages/channel-relay/src/terminal/terminal-types";

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "term-registry-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function baseRecordInput(overrides: Partial<Parameters<TerminalRegistryStore["upsertCreating"]>[1]> = {}) {
  return {
    terminalId: "term-1",
    logicalSessionId: "logical-1",
    internalAliasSnapshot: "alias-1",
    rmuxSessionName: "xacpx-relay-abc123-term1",
    generation: "gen-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Schema round-trip
// ---------------------------------------------------------------------------

test("schema round-trip: creating -> live -> reaping with reapReason and stable IDs", async () => {
  const dir = freshDir();
  const store = new TerminalRegistryStore({ dir });
  const loaded = await store.load();
  expect(loaded.revision).toBe(0);
  expect(Object.keys(loaded.terminals)).toHaveLength(0);

  const { revision: r1 } = await store.upsertCreating(loaded.revision, baseRecordInput());
  expect(r1).toBe(1);
  let snap = store.getSnapshot();
  expect(snap.terminals["term-1"]?.state).toBe("creating");
  expect(snap.terminals["term-1"]?.terminalId).toBe("term-1");

  const { revision: r2 } = await store.markLive(r1, "term-1", { rmuxSessionId: "rmux-sid-1" });
  expect(r2).toBe(2);
  snap = store.getSnapshot();
  expect(snap.terminals["term-1"]?.state).toBe("live");
  expect(snap.terminals["term-1"]?.rmuxSessionId).toBe("rmux-sid-1");

  const { revision: r3 } = await store.markReaping(r2, "term-1", "explicit-close");
  expect(r3).toBe(3);
  snap = store.getSnapshot();
  expect(snap.terminals["term-1"]?.state).toBe("reaping");
  expect(snap.terminals["term-1"]?.reapReason).toBe("explicit-close");

  const { revision: r4 } = await store.remove(r3, "term-1");
  expect(r4).toBe(4);
  snap = store.getSnapshot();
  expect(snap.terminals["term-1"]).toBeUndefined();

  // Re-load from disk and confirm the final state persisted, not just in-memory.
  const store2 = new TerminalRegistryStore({ dir });
  const loaded2 = await store2.load();
  expect(loaded2.revision).toBe(4);
  expect(Object.keys(loaded2.terminals)).toHaveLength(0);
  expect(loaded2.installationId).toBe(loaded.installationId);
});

test("checkpointLastInputAt updates lastInputAt without touching state", async () => {
  const dir = freshDir();
  const store = new TerminalRegistryStore({ dir });
  const loaded = await store.load();
  const { revision: r1 } = await store.upsertCreating(loaded.revision, baseRecordInput());
  const before = store.getSnapshot().terminals["term-1"]?.lastInputAt;

  const later = new Date(Date.now() + 60_000);
  const { revision: r2 } = await store.checkpointLastInputAt(r1, "term-1", later.toISOString());
  expect(r2).toBe(2);
  const rec = store.getSnapshot().terminals["term-1"];
  expect(rec?.lastInputAt).toBe(later.toISOString());
  expect(rec?.lastInputAt).not.toBe(before);
  expect(rec?.state).toBe("creating");
});

// ---------------------------------------------------------------------------
// Owner bootstrap
// ---------------------------------------------------------------------------

test("owner installationId is created once and is stable across reloads", async () => {
  const dir = freshDir();
  const store1 = new TerminalRegistryStore({ dir });
  const loaded1 = await store1.load();
  expect(typeof loaded1.installationId).toBe("string");
  expect(loaded1.installationId.length).toBeGreaterThan(0);

  const store2 = new TerminalRegistryStore({ dir });
  const loaded2 = await store2.load();
  expect(loaded2.installationId).toBe(loaded1.installationId);
});

test("concurrent startup races converge on a single installationId", async () => {
  const dir = freshDir();
  const stores = Array.from({ length: 5 }, () => new TerminalRegistryStore({ dir }));
  const results = await Promise.all(stores.map((s) => s.load()));
  const ids = new Set(results.map((r) => r.installationId));
  expect(ids.size).toBe(1);
});

test("owner missing but registry non-empty fails closed and does not mint a new owner", async () => {
  const dir = freshDir();
  // Seed a registry with an existing terminal but no owner file.
  writeFileSync(
    join(dir, "terminals.json"),
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      terminals: {
        "term-1": {
          terminalId: "term-1",
          logicalSessionId: "logical-1",
          internalAliasSnapshot: "alias-1",
          rmuxSessionName: "xacpx-relay-abc-term1",
          generation: "gen-1",
          state: "live",
          createdAt: new Date().toISOString(),
          lastInputAt: new Date().toISOString(),
        } satisfies TerminalRecordV1,
      },
    }),
    "utf8",
  );

  const store = new TerminalRegistryStore({ dir });
  await expect(store.load()).rejects.toThrow(TerminalRegistryInventoryUncertainError);

  // No owner file must have been created as a side effect of the failed load.
  expect(() => readFileSync(join(dir, "terminal-owner.json"), "utf8")).toThrow();
});

test("owner missing and registry absent creates a fresh owner (fresh install)", async () => {
  const dir = freshDir();
  const store = new TerminalRegistryStore({ dir });
  const loaded = await store.load();
  expect(loaded.inventoryUncertain).toBe(false);
  expect(Object.keys(loaded.terminals)).toHaveLength(0);
  const ownerRaw = readFileSync(join(dir, "terminal-owner.json"), "utf8");
  expect(JSON.parse(ownerRaw).installationId).toBe(loaded.installationId);
});

test("owner missing and registry present-but-empty creates a fresh owner", async () => {
  const dir = freshDir();
  writeFileSync(
    join(dir, "terminals.json"),
    JSON.stringify({ schemaVersion: 1, revision: 0, terminals: {} }),
    "utf8",
  );
  const store = new TerminalRegistryStore({ dir });
  const loaded = await store.load();
  expect(loaded.inventoryUncertain).toBe(false);
  expect(loaded.installationId.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Corruption handling
// ---------------------------------------------------------------------------

test("corrupt terminals.json is backed up and flips inventoryUncertain, without pretending to be an empty registry", async () => {
  const dir = freshDir();
  // Bootstrap a valid owner first so the failure mode under test is isolated
  // to registry corruption, not owner bootstrap.
  await new TerminalRegistryStore({ dir }).load();

  writeFileSync(join(dir, "terminals.json"), "{ not valid json !!", "utf8");

  const store = new TerminalRegistryStore({ dir });
  const loaded = await store.load();
  expect(loaded.inventoryUncertain).toBe(true);

  const files = readdirSync(dir);
  expect(files.some((f) => f.startsWith("terminals.json.corrupt-"))).toBe(true);
  // The corrupt original must still exist verbatim under the backup name — it is
  // evidence, not something to discard.
  const backupName = files.find((f) => f.startsWith("terminals.json.corrupt-"));
  expect(backupName).toBeDefined();
  expect(readFileSync(join(dir, backupName!), "utf8")).toBe("{ not valid json !!");
});

test("empty terminals.json file is treated as corruption, not an empty registry", async () => {
  const dir = freshDir();
  await new TerminalRegistryStore({ dir }).load();
  writeFileSync(join(dir, "terminals.json"), "", "utf8");

  const store = new TerminalRegistryStore({ dir });
  const loaded = await store.load();
  expect(loaded.inventoryUncertain).toBe(true);
  const files = readdirSync(dir);
  expect(files.some((f) => f.startsWith("terminals.json.corrupt-"))).toBe(true);
});

test("owner missing combined with a corrupt (empty) registry file also fails closed", async () => {
  const dir = freshDir();
  writeFileSync(join(dir, "terminals.json"), "", "utf8");
  const store = new TerminalRegistryStore({ dir });
  await expect(store.load()).rejects.toThrow(TerminalRegistryInventoryUncertainError);
  expect(() => readFileSync(join(dir, "terminal-owner.json"), "utf8")).toThrow();
});

test("best-effort corrupt backup rename failure still surfaces inventoryUncertain without throwing", async () => {
  const dir = freshDir();
  await new TerminalRegistryStore({ dir }).load();
  writeFileSync(join(dir, "terminals.json"), "not json", "utf8");

  const registryPath = join(dir, "terminals.json");
  const store = new TerminalRegistryStore({
    dir,
    deps: {
      rename: async (from: string, to: string) => {
        if (from === registryPath) throw new Error("simulated backup rename failure");
        const fsp = await import("node:fs/promises");
        await fsp.rename(from, to);
      },
    },
  });

  const loaded = await store.load();
  expect(loaded.inventoryUncertain).toBe(true);
  // Original corrupt file remains in place since the backup rename failed.
  expect(readFileSync(registryPath, "utf8")).toBe("not json");
});

// ---------------------------------------------------------------------------
// Write/flush/rename crash points
// ---------------------------------------------------------------------------

test("write failure during mutate leaves previous snapshot intact and rejects", async () => {
  const dir = freshDir();
  const store = new TerminalRegistryStore({
    dir,
    deps: { writeFile: async () => { throw new Error("disk full"); } },
  });
  const loaded = await store.load();
  await expect(store.upsertCreating(loaded.revision, baseRecordInput())).rejects.toThrow("disk full");
  const snap = store.getSnapshot();
  expect(snap.revision).toBe(0);
  expect(Object.keys(snap.terminals)).toHaveLength(0);
});

test("fsync failure during mutate leaves previous snapshot intact and rejects", async () => {
  const dir = freshDir();
  const store = new TerminalRegistryStore({
    dir,
    deps: { fsync: async () => { throw new Error("fsync failed"); } },
  });
  const loaded = await store.load();
  await expect(store.upsertCreating(loaded.revision, baseRecordInput())).rejects.toThrow("fsync failed");
  const snap = store.getSnapshot();
  expect(snap.revision).toBe(0);
});

test("rename failure during mutate leaves previous snapshot intact and rejects", async () => {
  const dir = freshDir();
  const store = new TerminalRegistryStore({
    dir,
    deps: { rename: async () => { throw new Error("rename failed"); } },
  });
  const loaded = await store.load();
  await expect(store.upsertCreating(loaded.revision, baseRecordInput())).rejects.toThrow("rename failed");
  const snap = store.getSnapshot();
  expect(snap.revision).toBe(0);
  expect(Object.keys(snap.terminals)).toHaveLength(0);

  // A subsequent mutation with the (unchanged) old revision must still succeed,
  // proving the failed attempt did not silently bump revision or corrupt state.
  const realDeps = await import("node:fs/promises");
  const store2 = new TerminalRegistryStore({ dir });
  const loaded2 = await store2.load();
  expect(loaded2.revision).toBe(0);
  const { revision } = await store2.upsertCreating(0, baseRecordInput());
  expect(revision).toBe(1);
  void realDeps;
});

test("a failed mutation does not leave a corrupted terminals.json for the next load", async () => {
  const dir = freshDir();
  let calls = 0;
  const store = new TerminalRegistryStore({
    dir,
    deps: {
      rename: async (from: string, to: string) => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        const fsp = await import("node:fs/promises");
        await fsp.rename(from, to);
      },
    },
  });
  const loaded = await store.load();
  await expect(store.upsertCreating(loaded.revision, baseRecordInput())).rejects.toThrow("boom");

  const store2 = new TerminalRegistryStore({ dir });
  const loaded2 = await store2.load();
  expect(loaded2.inventoryUncertain).toBe(false);
  expect(loaded2.revision).toBe(0);
});

// ---------------------------------------------------------------------------
// Concurrency & revision fencing
// ---------------------------------------------------------------------------

test("concurrent mutations serialize and revision increases monotonically by one", async () => {
  const dir = freshDir();
  const store = new TerminalRegistryStore({ dir });
  const loaded = await store.load();

  // Each caller races on the same expectedRevision; only callers that retry
  // with the freshest revision succeed serially. We simulate a well-behaved
  // caller pattern: read snapshot, then mutate with that revision, retrying on
  // mismatch — this proves serialization + monotonic revision under contention.
  async function upsertWithRetry(terminalId: string): Promise<void> {
    for (;;) {
      const rev = store.getSnapshot().revision;
      try {
        await store.upsertCreating(rev, baseRecordInput({ terminalId, rmuxSessionName: `xacpx-relay-abc-${terminalId}` }));
        return;
      } catch (err) {
        if (err instanceof TerminalRegistryRevisionMismatchError) continue;
        throw err;
      }
    }
  }

  await Promise.all(
    Array.from({ length: 10 }, (_, i) => upsertWithRetry(`term-${i}`)),
  );

  const snap = store.getSnapshot();
  expect(snap.revision).toBe(10 + loaded.revision);
  expect(Object.keys(snap.terminals)).toHaveLength(10);
});

test("mutate rejects on stale expectedRevision and leaves state unchanged", async () => {
  const dir = freshDir();
  const store = new TerminalRegistryStore({ dir });
  const loaded = await store.load();
  await store.upsertCreating(loaded.revision, baseRecordInput());

  await expect(store.upsertCreating(loaded.revision, baseRecordInput({ terminalId: "term-2" })))
    .rejects.toThrow(TerminalRegistryRevisionMismatchError);

  const snap = store.getSnapshot();
  expect(snap.revision).toBe(1);
  expect(Object.keys(snap.terminals)).toHaveLength(1);
});

test("mutate() gives a copy-on-write draft; mutating draft.terminals cannot corrupt the published snapshot", async () => {
  const dir = freshDir();
  const store = new TerminalRegistryStore({ dir });
  const loaded = await store.load();
  await store.upsertCreating(loaded.revision, baseRecordInput());
  const before = store.getSnapshot();

  await store.mutate(1, (draft) => {
    draft.terminals["term-1"] = { ...draft.terminals["term-1"]!, state: "live" };
  });

  // The snapshot object captured before the mutation must be unaffected.
  expect(before.terminals["term-1"]?.state).toBe("creating");
  expect(store.getSnapshot().terminals["term-1"]?.state).toBe("live");
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

test("owner and registry files are written with 0600 permissions", async () => {
  if (process.platform === "win32") return;
  const dir = freshDir();
  const store = new TerminalRegistryStore({ dir });
  const loaded = await store.load();
  await store.upsertCreating(loaded.revision, baseRecordInput());

  expect(statSync(join(dir, "terminal-owner.json")).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, "terminals.json")).mode & 0o777).toBe(0o600);
});

// ---------------------------------------------------------------------------
// API misuse guards
// ---------------------------------------------------------------------------

test("getSnapshot before load throws", () => {
  const dir = freshDir();
  const store = new TerminalRegistryStore({ dir });
  expect(() => store.getSnapshot()).toThrow();
});

test("markLive/markReaping/checkpointLastInputAt throw for unknown terminalId", async () => {
  const dir = freshDir();
  const store = new TerminalRegistryStore({ dir });
  const loaded = await store.load();
  await expect(store.markLive(loaded.revision, "missing")).rejects.toThrow();
  await expect(store.markReaping(loaded.revision, "missing", "idle")).rejects.toThrow();
  await expect(store.checkpointLastInputAt(loaded.revision, "missing")).rejects.toThrow();
});

test("remove is idempotent for an already-absent terminalId", async () => {
  const dir = freshDir();
  const store = new TerminalRegistryStore({ dir });
  const loaded = await store.load();
  const { revision } = await store.remove(loaded.revision, "never-existed");
  expect(revision).toBe(1);
});
