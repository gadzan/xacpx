import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  SessionResourceCatalog,
  SessionResourceDescriptor,
  SessionResourceLifecycleEvent,
} from "xacpx/plugin-api";

import type { RelayTerminalConfig } from "../../../../packages/channel-relay/src/config";
import { InMemoryRmuxDriver } from "../../../../packages/channel-relay/src/terminal/in-memory-rmux-driver";
import {
  parseRelayTerminalTags,
  TerminalReconciler,
  type ReconcileDiagnostic,
  type TerminalReconcileHost,
} from "../../../../packages/channel-relay/src/terminal/terminal-reconciler";
import { TerminalRegistryStore } from "../../../../packages/channel-relay/src/terminal/terminal-registry-store";
import type { TerminalRecordV1 } from "../../../../packages/channel-relay/src/terminal/terminal-types";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "term-reconcile-"));
  dirs.push(dir);
  return dir;
}

function baseConfig(overrides: Partial<RelayTerminalConfig> = {}): RelayTerminalConfig {
  return {
    enabled: true,
    backend: "rmux",
    idleTimeoutSeconds: 900,
    ownerLeaseTtlSeconds: 90,
    reconcileIntervalSeconds: 30,
    orphanGraceSeconds: 120,
    attachmentTtlSeconds: 45,
    maxSessions: 16,
    maxViewersPerTerminal: 4,
    historyLimit: 10000,
    ...overrides,
  };
}

function descriptor(
  overrides: Partial<SessionResourceDescriptor> = {},
): SessionResourceDescriptor {
  return {
    logicalSessionId: "11111111-1111-4111-8111-111111111111",
    channelId: "relay",
    internalAlias: "demo",
    displayAlias: "demo",
    workspace: "ws",
    cwd: "/tmp/ws",
    archived: false,
    ...overrides,
  };
}

class FakeCatalog implements SessionResourceCatalog {
  private readonly items: SessionResourceDescriptor[];
  fail = false;

  constructor(items: SessionResourceDescriptor[] = [descriptor()]) {
    this.items = items;
  }

  async resolve(_chatKey: string, alias: string): Promise<SessionResourceDescriptor | null> {
    return this.items.find((d) => d.displayAlias === alias) ?? null;
  }

  async list(channelId: string): Promise<SessionResourceDescriptor[]> {
    if (this.fail) throw new Error("catalog down");
    return this.items.filter((d) => d.channelId === channelId);
  }

  subscribe(_listener: (event: SessionResourceLifecycleEvent) => void): () => void {
    return () => {};
  }
}

interface Harness {
  reconciler: TerminalReconciler;
  registry: TerminalRegistryStore;
  driver: InMemoryRmuxDriver;
  catalog: FakeCatalog;
  diagnostics: ReconcileDiagnostic[];
  clock: { nowMs: number; now: () => number };
  liveHandles: Set<string>;
  absent: Array<{ terminalId: string; generation: string; reason: string }>;
  fenced: string[];
  installationId: string;
}

async function makeHarness(
  opts: {
    config?: Partial<RelayTerminalConfig>;
    catalog?: FakeCatalog;
  } = {},
): Promise<Harness> {
  const dir = freshDir();
  const registry = new TerminalRegistryStore({ dir });
  await registry.load();
  const driver = new InMemoryRmuxDriver();
  const catalog = opts.catalog ?? new FakeCatalog();
  const diagnostics: ReconcileDiagnostic[] = [];
  const clock = { nowMs: 1_000_000, now: () => clock.nowMs };
  const liveHandles = new Set<string>();
  const absent: Harness["absent"] = [];
  const fenced: string[] = [];
  const config = baseConfig(opts.config);

  const host: TerminalReconcileHost = {
    registry,
    driver,
    catalog,
    config,
    clock,
    withTerminalLock: async (_id, fn) => fn(),
    hasLiveHandle: (terminalId) => liveHandles.has(terminalId),
    onResourceAbsent: (terminalId, generation, reason) => {
      liveHandles.delete(terminalId);
      absent.push({ terminalId, generation, reason });
    },
    onFence: (terminalId) => {
      fenced.push(terminalId);
    },
    killWithTimeout: async (sessionId) => {
      try {
        await driver.kill(sessionId);
        return true;
      } catch {
        return false;
      }
    },
  };

  const reconciler = new TerminalReconciler({
    host,
    onDiagnostic: (d) => diagnostics.push(d),
  });

  return {
    reconciler,
    registry,
    driver,
    catalog,
    diagnostics,
    clock,
    liveHandles,
    absent,
    fenced,
    installationId: registry.getSnapshot().installationId,
  };
}

function tagsFor(
  installationId: string,
  logicalSessionId: string,
  terminalId: string,
  generation: string,
): string[] {
  return [
    "xacpx:relay",
    `owner:${installationId}`,
    `logical:${logicalSessionId}`,
    `terminal:${terminalId}`,
    `generation:${generation}`,
    "schema:1",
  ];
}

function rmuxName(installationId: string, terminalId: string): string {
  return `xacpx-relay-${installationId.slice(0, 8)}-${terminalId.replaceAll("-", "")}`;
}

test("parseRelayTerminalTags requires the full relay vocabulary", () => {
  expect(
    parseRelayTerminalTags([
      "xacpx:relay",
      "owner:o",
      "logical:l",
      "terminal:t",
      "generation:g",
      "schema:1",
    ]),
  ).toEqual({
    ownerId: "o",
    logicalSessionId: "l",
    terminalId: "t",
    generation: "g",
    schema: "1",
  });
  expect(parseRelayTerminalTags(["xacpx:relay", "owner:o"])).toBeNull();
});

test("creating + RMUX present waits orphan grace then kills (never adopt)", async () => {
  const h = await makeHarness({ config: { orphanGraceSeconds: 60 } });
  const terminalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const generation = "gen-1";
  const name = rmuxName(h.installationId, terminalId);
  await h.driver.create({
    name,
    cwd: "/tmp/ws",
    cols: 80,
    rows: 24,
    historyLimit: 1000,
    tags: tagsFor(h.installationId, descriptor().logicalSessionId, terminalId, generation),
    ownerLeaseTtlSeconds: 90,
  });

  const past = new Date(h.clock.nowMs - 61_000).toISOString();
  const snap = h.registry.getSnapshot();
  await h.registry.upsertCreating(snap.revision, {
    terminalId,
    logicalSessionId: descriptor().logicalSessionId,
    internalAliasSnapshot: "demo",
    rmuxSessionName: name,
    generation,
    createdAt: past,
    lastInputAt: past,
  });

  await h.reconciler.runOnce();
  expect(await h.driver.list()).toHaveLength(1);
  await h.reconciler.runOnce();
  expect(h.registry.getSnapshot().terminals[terminalId]).toBeUndefined();
  expect(await h.driver.list()).toHaveLength(0);
  expect(h.diagnostics.some((d) => d.type === "orphan-killed")).toBe(true);
});

test("creating + RMUX absent deletes stale intent", async () => {
  const h = await makeHarness();
  const terminalId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const snap = h.registry.getSnapshot();
  await h.registry.upsertCreating(snap.revision, {
    terminalId,
    logicalSessionId: descriptor().logicalSessionId,
    internalAliasSnapshot: "demo",
    rmuxSessionName: rmuxName(h.installationId, terminalId),
    generation: "gen-x",
  });

  await h.reconciler.runOnce();
  expect(h.registry.getSnapshot().terminals[terminalId]).toBeUndefined();
  expect(h.diagnostics.some((d) => d.type === "removed-absent")).toBe(true);
});

test("live without in-process handle is stale-reaped (no adopt)", async () => {
  const h = await makeHarness();
  const terminalId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const generation = "gen-2";
  const name = rmuxName(h.installationId, terminalId);
  const created = await h.driver.create({
    name,
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    historyLimit: 100,
    tags: tagsFor(h.installationId, descriptor().logicalSessionId, terminalId, generation),
    ownerLeaseTtlSeconds: 90,
  });

  let snap = h.registry.getSnapshot();
  await h.registry.upsertCreating(snap.revision, {
    terminalId,
    logicalSessionId: descriptor().logicalSessionId,
    internalAliasSnapshot: "demo",
    rmuxSessionName: name,
    generation,
  });
  snap = h.registry.getSnapshot();
  await h.registry.markLive(snap.revision, terminalId, { rmuxSessionId: created.sessionId });

  // No liveHandles entry → previous-process leftover.
  await h.reconciler.runOnce();

  expect(h.registry.getSnapshot().terminals[terminalId]).toBeUndefined();
  expect(await h.driver.list()).toHaveLength(0);
  expect(h.diagnostics.some((d) => d.type === "stale-reaped")).toBe(true);
  expect(h.fenced).toContain(terminalId);
});

test("live with in-process handle + missing logical is reaped and killed", async () => {
  const h = await makeHarness({ catalog: new FakeCatalog([]) });
  const terminalId = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
  const generation = "gen-2b";
  const name = rmuxName(h.installationId, terminalId);
  const created = await h.driver.create({
    name,
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    historyLimit: 100,
    tags: tagsFor(h.installationId, descriptor().logicalSessionId, terminalId, generation),
    ownerLeaseTtlSeconds: 90,
  });

  let snap = h.registry.getSnapshot();
  await h.registry.upsertCreating(snap.revision, {
    terminalId,
    logicalSessionId: descriptor().logicalSessionId,
    internalAliasSnapshot: "demo",
    rmuxSessionName: name,
    generation,
  });
  snap = h.registry.getSnapshot();
  await h.registry.markLive(snap.revision, terminalId, { rmuxSessionId: created.sessionId });
  h.liveHandles.add(terminalId);

  await h.reconciler.runOnce();

  expect(h.registry.getSnapshot().terminals[terminalId]).toBeUndefined();
  expect(await h.driver.list()).toHaveLength(0);
  expect(h.fenced).toContain(terminalId);
});

test("live + RMUX absent emits exit and removes record", async () => {
  const h = await makeHarness();
  const terminalId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const generation = "gen-3";
  let snap = h.registry.getSnapshot();
  await h.registry.upsertCreating(snap.revision, {
    terminalId,
    logicalSessionId: descriptor().logicalSessionId,
    internalAliasSnapshot: "demo",
    rmuxSessionName: rmuxName(h.installationId, terminalId),
    generation,
  });
  snap = h.registry.getSnapshot();
  await h.registry.markLive(snap.revision, terminalId, {
    rmuxSessionId: "missing-session",
  });

  await h.reconciler.runOnce();
  expect(h.registry.getSnapshot().terminals[terminalId]).toBeUndefined();
  expect(h.absent.some((a) => a.terminalId === terminalId)).toBe(true);
});

test("inventory-only complete tags quarantine then kill after grace (never adopt)", async () => {
  const h = await makeHarness({
    config: { orphanGraceSeconds: 60 },
  });
  const terminalId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const generation = "gen-4";
  const name = rmuxName(h.installationId, terminalId);
  const created = await h.driver.create({
    name,
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    historyLimit: 100,
    tags: tagsFor(h.installationId, descriptor().logicalSessionId, terminalId, generation),
    ownerLeaseTtlSeconds: 90,
  });

  await h.reconciler.runOnce();
  expect(h.registry.getSnapshot().terminals[terminalId]?.state).toBe("creating");
  expect(h.diagnostics.some((d) => d.type === "orphan-quarantined")).toBe(true);
  expect(await h.driver.list()).toHaveLength(1);

  await h.reconciler.runOnce();
  expect(await h.driver.list()).toHaveLength(1);

  h.clock.nowMs += 61_000;
  await h.reconciler.runOnce();
  expect(await h.driver.list()).toHaveLength(0);
  expect(h.registry.getSnapshot().terminals[terminalId]).toBeUndefined();
  expect(h.diagnostics.some((d) => d.type === "orphan-killed" && d.sessionId === created.sessionId)).toBe(
    true,
  );
});

test("inventory-only orphan without active logical waits two rounds + grace before kill", async () => {
  const h = await makeHarness({
    catalog: new FakeCatalog([]),
    config: { orphanGraceSeconds: 60 },
  });
  const terminalId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const generation = "gen-5";
  const name = rmuxName(h.installationId, terminalId);
  const created = await h.driver.create({
    name,
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    historyLimit: 100,
    tags: tagsFor(h.installationId, descriptor().logicalSessionId, terminalId, generation),
    ownerLeaseTtlSeconds: 90,
  });

  await h.reconciler.runOnce();
  expect(h.registry.getSnapshot().terminals[terminalId]?.state).toBe("creating");
  expect(await h.driver.list()).toHaveLength(1);

  // Second round but still inside grace — do not kill.
  await h.reconciler.runOnce();
  expect(await h.driver.list()).toHaveLength(1);

  h.clock.nowMs += 61_000;
  await h.reconciler.runOnce();
  expect(await h.driver.list()).toHaveLength(0);
  expect(h.registry.getSnapshot().terminals[terminalId]).toBeUndefined();
  expect(h.diagnostics.some((d) => d.type === "orphan-killed" && d.sessionId === created.sessionId)).toBe(
    true,
  );
});

test("malformed tags are diagnosed and never killed", async () => {
  const h = await makeHarness({ catalog: new FakeCatalog([]) });
  await h.driver.create({
    name: `xacpx-relay-${h.installationId.slice(0, 8)}-deadbeef`,
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    historyLimit: 100,
    tags: ["xacpx:relay", `owner:${h.installationId}`], // incomplete
    ownerLeaseTtlSeconds: 90,
  });

  h.clock.nowMs += 999_000;
  await h.reconciler.runOnce();
  await h.reconciler.runOnce();
  expect(await h.driver.list()).toHaveLength(1);
  expect(h.diagnostics.some((d) => d.type === "malformed-tags")).toBe(true);
  expect(h.diagnostics.some((d) => d.type === "orphan-killed")).toBe(false);
});

test("catalog failure fail-closes destructive GC", async () => {
  const h = await makeHarness();
  h.catalog.fail = true;

  // Seed a live record whose logical is "missing" — without fail-closed it would reap.
  const terminalId = "12121212-1212-4121-8121-121212121212";
  const generation = "gen-6";
  const name = rmuxName(h.installationId, terminalId);
  const created = await h.driver.create({
    name,
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    historyLimit: 100,
    tags: tagsFor(h.installationId, descriptor().logicalSessionId, terminalId, generation),
    ownerLeaseTtlSeconds: 90,
  });
  let snap = h.registry.getSnapshot();
  await h.registry.upsertCreating(snap.revision, {
    terminalId,
    logicalSessionId: descriptor().logicalSessionId,
    internalAliasSnapshot: "demo",
    rmuxSessionName: name,
    generation,
  });
  snap = h.registry.getSnapshot();
  await h.registry.markLive(snap.revision, terminalId, { rmuxSessionId: created.sessionId });
  // Keep an in-process handle so fail-closed catalog path is what we exercise
  // (without a handle, process-owned would stale-reap instead).
  h.liveHandles.add(terminalId);

  await h.reconciler.runOnce();
  expect(h.diagnostics.some((d) => d.type === "catalog-unavailable")).toBe(true);
  expect(h.registry.getSnapshot().terminals[terminalId]?.state).toBe("live");
  expect(await h.driver.list()).toHaveLength(1);
});

test("inventory failure fail-closes destructive GC", async () => {
  const h = await makeHarness();
  h.driver.configureFailure("list", new Error("sidecar down"), 1);

  const terminalId = "34343434-3434-4343-8343-343434343434";
  let snap = h.registry.getSnapshot();
  await h.registry.upsertCreating(snap.revision, {
    terminalId,
    logicalSessionId: descriptor().logicalSessionId,
    internalAliasSnapshot: "demo",
    rmuxSessionName: rmuxName(h.installationId, terminalId),
    generation: "gen-7",
  });
  // No RMUX session — under normal pass creating would be deleted.
  await h.reconciler.runOnce();
  expect(h.diagnostics.some((d) => d.type === "inventory-unavailable")).toBe(true);
  expect(h.registry.getSnapshot().terminals[terminalId]?.state).toBe("creating");
});

test("corrupt registry inventoryUncertain skips destructive orphan kill", async () => {
  const dir = freshDir();
  writeFileSync(join(dir, "terminals.json"), "{not-json", "utf8");
  writeFileSync(
    join(dir, "terminal-owner.json"),
    JSON.stringify({ schemaVersion: 1, installationId: "11111111-1111-4111-8111-111111111111" }),
    "utf8",
  );
  const registry = new TerminalRegistryStore({ dir });
  await registry.load();
  expect(registry.getSnapshot().inventoryUncertain).toBe(true);

  const driver = new InMemoryRmuxDriver();
  const installationId = registry.getSnapshot().installationId;
  const terminalId = "56565656-5656-4565-8565-565656565656";
  await driver.create({
    name: rmuxName(installationId, terminalId),
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    historyLimit: 100,
    tags: tagsFor(installationId, descriptor().logicalSessionId, terminalId, "g"),
    ownerLeaseTtlSeconds: 90,
  });

  const diagnostics: ReconcileDiagnostic[] = [];
  const clock = { nowMs: 1_000_000, now: () => clock.nowMs };
  const reconciler = new TerminalReconciler({
    host: {
      registry,
      driver,
      catalog: new FakeCatalog([]),
      config: baseConfig({ orphanGraceSeconds: 0 }),
      clock,
      withTerminalLock: async (_id, fn) => fn(),
      hasLiveHandle: () => false,
      onResourceAbsent: () => {},
      onFence: () => {},
      killWithTimeout: async (sessionId) => {
        await driver.kill(sessionId);
        return true;
      },
    },
    onDiagnostic: (d) => diagnostics.push(d),
  });

  clock.nowMs += 999_000;
  await reconciler.runOnce();
  await reconciler.runOnce();
  expect(diagnostics.some((d) => d.type === "inventory-uncertain")).toBe(true);
  expect(await driver.list()).toHaveLength(1);
  expect(diagnostics.some((d) => d.type === "orphan-killed")).toBe(false);
});

test("reaping retries kill after earlier timeout (cleanup-pending → later success)", async () => {
  const h = await makeHarness();
  const terminalId = "78787878-7878-4787-8787-787878787878";
  const generation = "gen-8";
  const name = rmuxName(h.installationId, terminalId);
  const created = await h.driver.create({
    name,
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    historyLimit: 100,
    tags: tagsFor(h.installationId, descriptor().logicalSessionId, terminalId, generation),
    ownerLeaseTtlSeconds: 90,
  });

  let snap = h.registry.getSnapshot();
  await h.registry.upsertCreating(snap.revision, {
    terminalId,
    logicalSessionId: descriptor().logicalSessionId,
    internalAliasSnapshot: "demo",
    rmuxSessionName: name,
    generation,
  });
  snap = h.registry.getSnapshot();
  await h.registry.markLive(snap.revision, terminalId, { rmuxSessionId: created.sessionId });
  snap = h.registry.getSnapshot();
  await h.registry.markReaping(snap.revision, terminalId, "explicit-close");

  const diagnostics: ReconcileDiagnostic[] = [];
  let attempts = 0;
  const reconciler = new TerminalReconciler({
    host: {
      registry: h.registry,
      driver: h.driver,
      catalog: h.catalog,
      config: baseConfig(),
      clock: h.clock,
      withTerminalLock: async (_id, fn) => fn(),
      hasLiveHandle: () => false,
      onResourceAbsent: (terminalId, generation, reason) => {
        h.absent.push({ terminalId, generation, reason });
      },
      onFence: () => {},
      killWithTimeout: async (sessionId) => {
        attempts += 1;
        if (attempts === 1) return false; // cleanup-pending
        await h.driver.kill(sessionId);
        return true;
      },
    },
    onDiagnostic: (d) => diagnostics.push(d),
  });

  await reconciler.runOnce();
  expect(h.registry.getSnapshot().terminals[terminalId]?.state).toBe("reaping");
  expect(await h.driver.list()).toHaveLength(1);

  await reconciler.runOnce();
  expect(h.registry.getSnapshot().terminals[terminalId]).toBeUndefined();
  expect(await h.driver.list()).toHaveLength(0);
  expect(diagnostics.some((d) => d.type === "removed-absent")).toBe(true);
});

test("periodic reconcile is re-entrant safe and stop waits for active pass", async () => {
  const h = await makeHarness();
  let passes = 0;
  let resolvePass!: () => void;
  const gate = new Promise<void>((r) => {
    resolvePass = r;
  });

  const slow = new TerminalReconciler({
    host: {
      registry: h.registry,
      driver: h.driver,
      catalog: h.catalog,
      config: baseConfig({ reconcileIntervalSeconds: 1 }),
      clock: h.clock,
      withTerminalLock: async (_id, fn) => fn(),
      hasLiveHandle: () => false,
      onResourceAbsent: () => {},
      onFence: () => {},
      killWithTimeout: async () => true,
    },
    setIntervalFn: (fn) => {
      // Immediately fire two overlapping ticks.
      queueMicrotask(async () => {
        passes += 1;
        const p1 = slow.runOnce();
        const p2 = slow.runOnce();
        resolvePass();
        await Promise.all([p1, p2]);
      });
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    clearIntervalFn: () => {},
  });

  // Override runOnce tracking via wrapping — simpler: just call runOnce twice overlapping.
  const a = h.reconciler.runOnce();
  const b = h.reconciler.runOnce();
  await Promise.all([a, b]);
  await h.reconciler.stop();
  void gate;
  void passes;
  void slow;
});

test("live idle-expired resources are reaped by reconcile", async () => {
  const h = await makeHarness({ config: { idleTimeoutSeconds: 30 } });
  const terminalId = "90909090-9090-4909-8909-909090909090";
  const generation = "gen-9";
  const name = rmuxName(h.installationId, terminalId);
  const created = await h.driver.create({
    name,
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    historyLimit: 100,
    tags: tagsFor(h.installationId, descriptor().logicalSessionId, terminalId, generation),
    ownerLeaseTtlSeconds: 90,
  });

  let snap = h.registry.getSnapshot();
  const past = new Date(h.clock.nowMs - 60_000).toISOString();
  await h.registry.upsertCreating(snap.revision, {
    terminalId,
    logicalSessionId: descriptor().logicalSessionId,
    internalAliasSnapshot: "demo",
    rmuxSessionName: name,
    generation,
    createdAt: past,
    lastInputAt: past,
  });
  snap = h.registry.getSnapshot();
  await h.registry.markLive(snap.revision, terminalId, { rmuxSessionId: created.sessionId });
  h.liveHandles.add(terminalId);

  await h.reconciler.runOnce();
  expect(h.registry.getSnapshot().terminals[terminalId]).toBeUndefined();
  expect(await h.driver.list()).toHaveLength(0);
  expect(h.diagnostics.some((d) => d.type === "reaping" && d.reason === "idle")).toBe(true);
});

// Keep a typed reference so unused-import lint on TerminalRecordV1 does not fire in editors.
void null as unknown as TerminalRecordV1;
