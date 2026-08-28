import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { convergeOrphansBeforeExit } from "../../../../../src/bridge/engine/runtime/worker-eof";
import { type TerminateDescendantsResult } from "../../../../../src/process/windows-process-tree";
import {
  OrphanRegistry,
  decodeResidualRecord,
} from "../../../../../src/transport/orphan-registry";
import { sweepWindowsOrphans } from "../../../../../src/transport/windows-orphan-reaper";

const FULL = { creationDate: "133830000000000000", commandLine: "node adapter.js", executablePath: "C:\\adapter.exe" } as const;

const result = (verified: boolean, unsafe: number, leftover: number): TerminateDescendantsResult => ({
  verified,
  outcomes: Array.from({ length: 3 - unsafe }, (_, i) => ({
    pid: 5000 + i,
    outcome: "killed",
    ...FULL,
  })).concat(unsafe
    ? [{ pid: 5002, outcome: "access-denied" as const, ...FULL }]
    : []),
  leftover: leftover
    ? [{ pid: 6001, parentPid: 5002, ...FULL }]
    : [],
});

test("posix: kills own process group and reports verified without spooling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eof-posix-"));
  try {
    let groupsKilled = 0;
    const outcome = await convergeOrphansBeforeExit({
      platform: "darwin",
      killProcessGroup: () => {
        groupsKilled += 1;
      },
      runtimeDir: dir,
    });
    expect(outcome).toBe("verified");
    expect(groupsKilled).toBe(1);
    expect(await readdir(dir)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("windows: verified convergence exits without spooling residuals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eof-verified-"));
  try {
    let calls = 0;
    const outcome = await convergeOrphansBeforeExit({
      platform: "win32",
      terminateDescendants: async () => {
        calls += 1;
        return result(true, 0, 0);
      },
      runtimeDir: dir,
    });
    expect(calls).toBe(1);
    expect(outcome).toBe("verified");
    expect(await readdir(dir)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("windows: transient unverified result retries once and then verifies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eof-retry-"));
  try {
    const outcomes: TerminateDescendantsResult[] = [
      result(false, 0, 0),
      result(true, 0, 0),
    ];
    let calls = 0;
    const outcome = await convergeOrphansBeforeExit({
      platform: "win32",
      terminateDescendants: async () => outcomes[Math.min(calls++, outcomes.length - 1)]!,
      delayBeforeRetryMs: 0,
      runtimeDir: dir,
    });
    expect(calls).toBe(2);
    expect(outcome).toBe("verified");
    expect(await readdir(dir)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("windows: persistent failure spools residual records the daemon reaper reconciles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eof-spool-"));
  try {
    const outcome = await convergeOrphansBeforeExit({
      platform: "win32",
      terminateDescendants: async () => result(false, 1, 1),
      delayBeforeRetryMs: 0,
      runtimeDir: dir,
      agentCommand: () => "codex",
      generationId: "00000000-0000-4000-8000-000000000001",
      ownerToken: "00000000-0000-4000-8000-000000000002",
    });
    expect(outcome).toBe("spooled");

    const registry = new OrphanRegistry(dir);
    const residuals = await registry.readCategory("residuals");
    expect(residuals).toHaveLength(2);
    for (const { record } of residuals!) {
      expect(decodeResidualRecord(record)).not.toBeNull();
    }
    const pids = new Set(residuals!.map(({ record }) => (record as { pid: number }).pid));
    expect(pids).toEqual(new Set([5002, 6001]));

    // The written records must be consumable by the real reaper: an injected
    // sweep kills by the recorded identity and retires the records.
    const killed: number[] = [];
    const sweep = await sweepWindowsOrphans(registry, "00000000-0000-4000-8000-000000000009", {
      terminateResidual: async (target) => {
        killed.push(target.pid);
        return "killed";
      },
    });
    expect(killed.sort((a, b) => a - b)).toEqual([5002, 6001]);
    expect(sweep.residualsDeleted).toBe(2);
    expect(sweep.residualsRetained).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("windows: unverified descendants without a complete fingerprint cannot spool identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eof-nofp-"));
  try {
    const outcome = await convergeOrphansBeforeExit({
      platform: "win32",
      // access-denied descendant whose CIM fingerprint is incomplete — a
      // handle-bound kill cannot be gated on fabricated identity, so no
      // record may be written.
      terminateDescendants: async () => ({
        verified: false,
        outcomes: [{ pid: 5002, outcome: "access-denied", creationDate: null, commandLine: null, executablePath: null }],
        leftover: [],
      }),
      delayBeforeRetryMs: 0,
      runtimeDir: dir,
    });
    expect(outcome).toBe("unresolved");
    expect(await readdir(join(dir, "orphans", "residuals"))).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("windows: spool failure reports unresolved instead of faking success", async () => {
  const blocker = join(await mkdtemp(join(tmpdir(), "eof-block-")), "occupied");
  await writeFile(blocker, "not a directory", "utf8");
  try {
    const outcome = await convergeOrphansBeforeExit({
      platform: "win32",
      terminateDescendants: async () => result(false, 1, 0),
      delayBeforeRetryMs: 0,
      runtimeDir: blocker,
    });
    expect(outcome).toBe("unresolved");
  } finally {
    await rm(blocker, { force: true });
  }
});
