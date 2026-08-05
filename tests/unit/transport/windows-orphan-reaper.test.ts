import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { TerminateProcessTreeResult, WindowsTokenProcess } from "../../../src/process/windows-process-tree";
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

function verifiedDeps(batch: TerminateProcessTreeResult) {
  return {
    snapshotToken: async () => [tokenProcess()],
    probeIdentity: async () => ({ status: "found" as const, identity: { pid: 41, creationDate: CREATION, executablePath: "c:\\NODE.exe" } }),
    terminateTree: async () => batch,
    terminateResidual: async () => "access-denied" as const,
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
    await sweepWindowsOrphans(store, CURRENT_GENERATION, verifiedDeps({
      rootOutcome: "killed",
      outcomes: [
        { target: { pid: 41, creationDate: CREATION }, outcome: "killed" },
        { target: { pid: 42, creationDate: "133801632000000010" }, outcome: "access-denied", commandLine: "child", executablePath: "C:\\child.exe" },
      ],
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
    const result = await sweepWindowsOrphans(store, CURRENT_GENERATION, verifiedDeps(batch));
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
  test("residual terminal outcome deletes; uncertainty increments and reports degraded", async () => {
    const terminalStore = await registry();
    await terminalStore.writeResidual(residual());
    await sweepWindowsOrphans(terminalStore, CURRENT_GENERATION, { terminateResidual: async () => "skipped-replaced" });
    expect(await terminalStore.readCategory("residuals")).toEqual([]);

    const retryStore = await registry();
    await retryStore.writeResidual(residual());
    const result = await sweepWindowsOrphans(retryStore, CURRENT_GENERATION, { terminateResidual: async () => "query-failed" });
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
