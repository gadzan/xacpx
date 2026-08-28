import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { TerminateProcessTreeResult, WindowsTokenProcess } from "../../../src/process/windows-process-tree";
import { queryWindowsProcessIdentity } from "../../../src/process/windows-process-tree";
import {
  OrphanRegistry,
  type LaunchIntentRecord,
  type OwnerRecord,
  type ResidualRecord,
} from "../../../src/transport/orphan-registry";
import { sweepWindowsOrphans } from "../../../src/transport/windows-orphan-reaper";

const TOKEN = "11111111-1111-4111-8111-111111111111";
const OLD_GENERATION = "22222222-2222-4222-8222-222222222222";
const CURRENT_GENERATION = "33333333-3333-4333-8333-333333333333";
const CREATION = "133801632000000000";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function registry(): Promise<OrphanRegistry> {
  const root = await mkdtemp(join(tmpdir(), "xacpx-orphan-reaper-"));
  roots.push(root);
  const value = new OrphanRegistry(root);
  await value.initialize();
  return value;
}

function owner(overrides: Partial<OwnerRecord> = {}): OwnerRecord {
  return {
    schemaVersion: 1,
    token: TOKEN,
    pid: 41,
    queueHash: "queue",
    acpxRecordId: "record",
    generationId: OLD_GENERATION,
    configRoot: "C:\\xacpx",
    startedAt: "2026-08-05T00:00:00.000Z",
    agentCommand: "npx -y codex-acp@1.2.3",
    fingerprint: {
      creationDate: CREATION,
      commandLine: `acpx __queue-owner --xacpx-owner-token ${TOKEN}`,
      executablePath: "C:\\node.exe",
    },
    killAttempts: 0,
    ...overrides,
  };
}

function tokenProcess(overrides: Partial<WindowsTokenProcess> = {}): WindowsTokenProcess {
  const fingerprint = owner().fingerprint!;
  return { pid: 41, ...fingerprint, ...overrides };
}

function verifiedDeps(batch: TerminateProcessTreeResult, overrides: Record<string, unknown> = {}) {
  return {
    snapshotToken: async () => [tokenProcess()],
    probeIdentity: async () => ({ status: "found" as const, identity: { pid: 41, creationDate: CREATION, executablePath: "c:\\NODE.exe" } }),
    terminateTree: async () => batch,
    ...overrides,
  };
}

describe("sweepWindowsOrphans owners", () => {
  test("periodic/startup sweep preserves owners from the current generation", async () => {
    const store = await registry();
    await store.writeOwner(owner({ generationId: CURRENT_GENERATION }));
    const terminate = async () => { throw new Error("must not terminate current owner"); };
    const result = await sweepWindowsOrphans(store, CURRENT_GENERATION, {
      ...verifiedDeps({ rootOutcome: "killed", outcomes: [] }),
      terminateTree: terminate,
    });
    expect(result.ownersRetained).toBe(1);
    expect(await store.readCategory("owners")).toHaveLength(1);
  });

  test("all explicit root terminal and retry outcomes converge by their declared groups", async () => {
    for (const rootOutcome of ["killed", "already-exited", "skipped-replaced"] as const) {
      const store = await registry();
      await store.writeOwner(owner());
      await sweepWindowsOrphans(store, CURRENT_GENERATION, verifiedDeps({
        rootOutcome,
        outcomes: [{ target: { pid: 41, creationDate: CREATION }, outcome: rootOutcome }],
      }));
      expect(await store.readCategory("owners")).toEqual([]);
    }
    for (const rootOutcome of ["kill-requested-unconfirmed", "access-denied"] as const) {
      const store = await registry();
      await store.writeOwner(owner());
      await sweepWindowsOrphans(store, CURRENT_GENERATION, verifiedDeps({
        rootOutcome,
        outcomes: [{ target: { pid: 41, creationDate: CREATION }, outcome: rootOutcome }],
      }));
      const owners = await store.readCategory("owners");
      expect((owners?.[0]?.record as OwnerRecord).killAttempts).toBe(1);
    }
  });

  test("batch query-failed retains owner, increments attempts, and creates no residual", async () => {
    const store = await registry();
    await store.writeOwner(owner());
    const result = await sweepWindowsOrphans(store, CURRENT_GENERATION, verifiedDeps({
      rootOutcome: "query-failed",
      outcomes: [
        { target: { pid: 41, creationDate: CREATION }, outcome: "query-failed" },
        { target: { pid: 42, creationDate: "133801632000000010" }, outcome: "query-failed", commandLine: "child", executablePath: "C:\\child.exe" },
      ],
    }));
    const owners = await store.readCategory("owners");
    expect((owners?.[0]?.record as OwnerRecord).killAttempts).toBe(1);
    expect(await store.readCategory("residuals")).toEqual([]);
    expect(result.ownersRetained).toBe(1);
  });

  test("terminal root migrates only complete explicit child outcomes to residuals", async () => {
    const store = await registry();
    await store.writeOwner(owner());
    const batch: TerminateProcessTreeResult = {
      rootOutcome: "killed",
      outcomes: [
        { target: { pid: 41, creationDate: CREATION }, outcome: "killed" },
        { target: { pid: 42, creationDate: "133801632000000010" }, outcome: "access-denied", commandLine: "child", executablePath: "C:\\child.exe" },
      ],
    };
    await sweepWindowsOrphans(store, CURRENT_GENERATION, verifiedDeps(batch, {
      // The migrated residual is reconciled in the same sweep: retain it
      // (access-denied) so the assertion observes the migration result.
      terminateTree: async (target) => target.pid === 41
        ? batch
        : { rootOutcome: "access-denied", outcomes: [] },
    }));
    expect(await store.readCategory("owners")).toEqual([]);
    const residuals = await store.readCategory("residuals");
    expect(residuals).toHaveLength(1);
    expect((residuals?.[0]?.record as ResidualRecord).killAttempts).toBe(1);
  });

  test("partial residual migration never deletes the owner evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "xacpx-orphan-reaper-fault-"));
    roots.push(root);
    let residualRenames = 0;
    const store = new OrphanRegistry(root, {
      onBoundary: (boundary, path) => {
        if (boundary === "before-rename" && path.includes("residuals")) {
          residualRenames += 1;
          if (residualRenames === 2) throw new Error("injected residual failure");
        }
      },
    });
    await store.initialize();
    await store.writeOwner(owner());
    const batch: TerminateProcessTreeResult = {
      rootOutcome: "killed",
      outcomes: [
        { target: { pid: 41, creationDate: CREATION }, outcome: "killed" },
        { target: { pid: 42, creationDate: "133801632000000010" }, outcome: "access-denied", commandLine: "child-1", executablePath: "C:\\child-1.exe" },
        { target: { pid: 43, creationDate: "133801632000000020" }, outcome: "query-failed", commandLine: "child-2", executablePath: "C:\\child-2.exe" },
      ],
    };
    const result = await sweepWindowsOrphans(store, CURRENT_GENERATION, verifiedDeps(batch, {
      terminateTree: async (target) => target.pid === 41
        ? batch
        : { rootOutcome: "access-denied", outcomes: [] },
    }));
    expect(result.degraded).toBe(true);
    expect(await store.readCategory("owners")).toHaveLength(1);
    expect(await store.readCategory("residuals")).toHaveLength(1);
  });

  test("unknown or incomplete child outcome retains owner and creates nothing", async () => {
    for (const outcome of ["future-state", "access-denied"] as const) {
      const store = await registry();
      await store.writeOwner(owner());
      const batch = {
        rootOutcome: "killed",
        outcomes: [
          { target: { pid: 41, creationDate: CREATION }, outcome: "killed" },
          { target: { pid: 42, creationDate: "133801632000000010" }, outcome,
            ...(outcome === "future-state" ? { commandLine: "child", executablePath: "C:\\child.exe" } : {}) },
        ],
      } as unknown as TerminateProcessTreeResult;
      await sweepWindowsOrphans(store, CURRENT_GENERATION, verifiedDeps(batch));
      expect(await store.readCategory("owners")).toHaveLength(1);
      expect(await store.readCategory("residuals")).toEqual([]);
    }
  });

  test("verification uncertainty and a surviving token descendant retain owner without killing", async () => {
    const store = await registry();
    await store.writeOwner(owner());
    let kills = 0;
    const unavailable = await sweepWindowsOrphans(store, CURRENT_GENERATION, {
      snapshotToken: async () => null,
      probeIdentity: async () => ({ status: "missing" }),
      terminateTree: async () => { kills += 1; throw new Error("must not kill"); },
    });
    expect(unavailable.degraded).toBe(true);
    expect(kills).toBe(0);

    const store2 = await registry();
    await store2.writeOwner(owner());
    await sweepWindowsOrphans(store2, CURRENT_GENERATION, {
      snapshotToken: async () => [tokenProcess({ pid: 99 })],
      probeIdentity: async () => ({ status: "missing" }),
      terminateTree: async () => { kills += 1; throw new Error("must not kill"); },
    });
    expect(await store2.readCategory("owners")).toHaveLength(1);
    expect(kills).toBe(0);
  });
});

describe("sweepWindowsOrphans residuals and intents", () => {
  test("root killed with unsafe descendants migrates them before deleting the root", async () => {
    // Review round 23 Blocking 1: deleting the residual root just because
    // rootOutcome is killed would orphan a still-alive unsafe descendant
    // with no durable ownership. It must be migrated like owner children.
    const store = await registry();
    await store.writeResidual(residual());
    await sweepWindowsOrphans(store, CURRENT_GENERATION, {
      terminateTree: async () => ({
        rootOutcome: "killed",
        outcomes: [
          { target: { pid: 42, creationDate: CREATION }, outcome: "killed" },
          { target: { pid: 43, creationDate: "133801632000000010" }, outcome: "access-denied", commandLine: "child", executablePath: "C:\\child.exe" },
        ],
      }),
    });
    expect(await store.readCategory("residuals")).toHaveLength(1);
    const records = await store.readCategory("residuals");
    expect((records?.[0]?.record as ResidualRecord).pid).toBe(43);
    expect((records?.[0]?.record as ResidualRecord).ownerToken).toBe(TOKEN);
  });

  test("root killed with all-safe descendants deletes the root residual", async () => {
    const store = await registry();
    await store.writeResidual(residual());
    await sweepWindowsOrphans(store, CURRENT_GENERATION, {
      terminateTree: async () => ({
        rootOutcome: "killed",
        outcomes: [
          { target: { pid: 42, creationDate: CREATION }, outcome: "killed" },
          { target: { pid: 43, creationDate: "133801632000000010" }, outcome: "already-exited", commandLine: "child", executablePath: "C:\\child.exe" },
        ],
      }),
    });
    expect(await store.readCategory("residuals")).toEqual([]);
  });

  test("already-exited or skipped-replaced root retains the subtree evidence", async () => {
    // The tree terminator returns BEFORE any descendant snapshot when the
    // root is gone/replaced, so descendants are unverified: deleting the only
    // durable record would lose their ownership (review round 23 Blocking 1).
    for (const rootOutcome of ["already-exited", "skipped-replaced"] as const) {
      const store = await registry();
      await store.writeResidual(residual());
      const result = await sweepWindowsOrphans(store, CURRENT_GENERATION, {
        terminateTree: async () => ({ rootOutcome, outcomes: [] }),
      });
      const records = await store.readCategory("residuals");
      expect(records).toHaveLength(1);
      expect((records?.[0]?.record as ResidualRecord).killAttempts).toBe(1);
      expect(result.residualsRetained).toBe(1);
      expect(result.degraded).toBe(true);
    }
  });

  test("residual query-failed retains, increments attempts, and reports degraded", async () => {
    const retryStore = await registry();
    await retryStore.writeResidual(residual());
    const result = await sweepWindowsOrphans(retryStore, CURRENT_GENERATION, { terminateTree: async () => ({ rootOutcome: "query-failed", outcomes: [] }) });
    const records = await retryStore.readCategory("residuals");
    expect((records?.[0]?.record as ResidualRecord).killAttempts).toBe(1);
    expect(result.degraded).toBe(true);
  });

  test("intent deletion requires all four conditions", async () => {
    const cases = [
      { name: "current", record: intent({ generationId: CURRENT_GENERATION }), snapshot: [] as WindowsTokenProcess[], probe: { status: "missing" as const }, deleted: false },
      { name: "token alive", record: intent(), snapshot: [tokenProcess()], probe: { status: "missing" as const }, deleted: false },
      { name: "snapshot unavailable", record: intent(), snapshot: null, probe: { status: "missing" as const }, deleted: false },
      { name: "launcher alive", record: intent(), snapshot: [] as WindowsTokenProcess[], probe: { status: "found" as const, identity: { pid: 50, creationDate: CREATION, executablePath: "C:\\bridge.exe" } }, deleted: false },
      { name: "launcher reused", record: intent(), snapshot: [] as WindowsTokenProcess[], probe: { status: "found" as const, identity: { pid: 50, creationDate: "133801632000000001", executablePath: "C:\\bridge.exe" } }, deleted: true },
      { name: "launcher gone", record: intent(), snapshot: [] as WindowsTokenProcess[], probe: { status: "missing" as const }, deleted: true },
    ];
    for (const item of cases) {
      const store = await registry();
      await store.writeIntent(item.record);
      await sweepWindowsOrphans(store, CURRENT_GENERATION, {
        now: () => Date.parse("2026-08-05T00:02:00.001Z"),
        snapshotToken: async () => item.snapshot,
        probeIdentity: async () => item.probe,
      });
      expect(await store.readCategory("intents"), item.name)[item.deleted ? "toEqual" : "toHaveLength"](item.deleted ? [] : 1);
    }
  });
});

function residual(overrides: Partial<ResidualRecord> = {}): ResidualRecord {
  return {
    kind: "residual",
    ownerToken: TOKEN,
    pid: 42,
    creationDate: "133801632000000010",
    commandLine: "child",
    executablePath: "C:\\child.exe",
    agentCommand: "npx -y codex-acp@1.2.3",
    generationId: OLD_GENERATION,
    killAttempts: 0,
    ...overrides,
  };
}

function intent(overrides: Partial<LaunchIntentRecord> = {}): LaunchIntentRecord {
  return {
    schemaVersion: 1,
    kind: "intent",
    token: TOKEN,
    launcherPid: 50,
    launcherCreationDate: CREATION,
    generationId: OLD_GENERATION,
    configRoot: "C:\\xacpx",
    queueHash: "queue",
    agentCommand: "npx -y codex-acp@1.2.3",
    createdAt: "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
}

const winTest = process.platform === "win32" ? test : test.skip;

// Review round 22 Blocking 3: a residual is an UNVERIFIED SUBTREE ROOT. The
// reaper must converge its descendants too (verified tree terminator), so the
// child spawned after spooling cannot outlive the recorded root.
winTest("real sweep: residual tree reaping physically removes the residual's descendants", async () => {
  const root = await mkdtemp(join(tmpdir(), "xacpx-orphan-reaper-win-"));
  roots.push(root);
  const store = new OrphanRegistry(root);
  await store.initialize();

  const fixture = join(root, "fixture.cjs");
  const childPidFile = join(root, "child.pid");
  await writeFile(fixture, [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid), 'utf8');`,
    "setInterval(() => {}, 1000);",
  ].join("\n"), "utf8");
  const rootProcess = spawn("node", [fixture], { stdio: "ignore" });

  let childPid = 0;
  for (let i = 0; i < 200 && !childPid; i += 1) {
    try {
      childPid = Number.parseInt(await readFile(childPidFile, "utf8"), 10);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  expect(childPid).toBeGreaterThan(0);

  const probe = await queryWindowsProcessIdentity(rootProcess.pid!);
  if (!probe) {
    rootProcess.kill();
    console.warn("skipping real residual sweep: process identity worker unavailable");
    return;
  }
  // Record ONLY the residual root; the child is the "spawned after spooling"
  // descendant that must still converge during reaping.
  await store.writeResidual({
    schemaVersion: 1,
    kind: "residual",
    ownerToken: TOKEN,
    pid: probe.pid,
    creationDate: probe.creationDate,
    commandLine: probe.executablePath,
    executablePath: probe.executablePath,
    agentCommand: "node",
    generationId: OLD_GENERATION,
    killAttempts: 0,
  });

  await sweepWindowsOrphans(store, CURRENT_GENERATION);

  expect(() => process.kill(rootProcess.pid!, 0)).toThrow();
  let childGone = false;
  for (let i = 0; i < 200 && !childGone; i += 1) {
    try { process.kill(childPid, 0); } catch { childGone = true; }
    if (!childGone) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(childGone).toBe(true);
  try { process.kill(rootProcess.pid!, "SIGKILL"); } catch {}
  try { process.kill(childPid, "SIGKILL"); } catch {}
}, 60_000);
