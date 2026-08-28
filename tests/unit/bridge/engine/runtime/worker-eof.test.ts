import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  convergeOrphansBeforeExit,
  mergeEvidence,
} from "../../../../../src/bridge/engine/runtime/worker-eof";
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

const unpublishable = (): TerminateDescendantsResult => ({
  verified: false,
  outcomes: [{ pid: 5002, outcome: "access-denied", creationDate: null, commandLine: null, executablePath: null }],
  leftover: [],
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

test("merge: a total failure on a retry can never erase earlier evidence", () => {
  const captured = result(false, 1, 1);
  // Review round 21: the second attempt used to OVERWRITE the first result,
  // so a CIM failure on the retry discarded complete, publishable identities.
  const merged = mergeEvidence(captured, { verified: false, outcomes: [], leftover: [] });
  expect(merged.verified).toBe(false);
  expect(merged.outcomes.map((item) => item.pid).sort((a, b) => a - b)).toEqual([5000, 5001, 5002]);
  expect(merged.leftover.map((item) => item.pid)).toEqual([6001]);
});

test("merge: a later safe outcome resolves an earlier unsafe identity", () => {
  const first = mergeEvidence({ verified: false, outcomes: [], leftover: [] }, result(false, 1, 0));
  const resolved = mergeEvidence(first, {
    verified: false,
    outcomes: [{ pid: 5002, outcome: "killed", ...FULL }],
    leftover: [],
  });
  expect(resolved.verified).toBe(true);
  expect(resolved.outcomes.find((item) => item.pid === 5002)?.outcome).toBe("killed");
  expect(resolved.leftover).toEqual([]);
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
      result(false, 1, 0),
      result(true, 0, 0),
    ];
    let calls = 0;
    const outcome = await convergeOrphansBeforeExit({
      platform: "win32",
      terminateDescendants: async () => outcomes[Math.min(calls++, outcomes.length - 1)]!,
      roundDelayMs: 1,
      runtimeDir: dir,
    });
    // Publication only happens after the bounded convergence rounds — a
    // verified retry leaves nothing spooled and no registry on disk.
    expect(calls).toBe(2);
    expect(outcome).toBe("verified");
    expect(await readdir(dir)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("windows: first-attempt evidence survives a total retry failure and is spooled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eof-monotonic-"));
  try {
    const outcomes: TerminateDescendantsResult[] = [
      result(false, 1, 1),
      { verified: false, outcomes: [], leftover: [] },
    ];
    let calls = 0;
    const outcome = await convergeOrphansBeforeExit({
      platform: "win32",
      terminateDescendants: async () => outcomes[Math.min(calls++, outcomes.length - 1)]!,
      roundDelayMs: 1,
      runtimeDir: dir,
      agentCommand: () => "codex",
      generationId: "00000000-0000-4000-8000-000000000001",
      ownerToken: "00000000-0000-4000-8000-000000000002",
    });
    // The unverified first attempt is merged (never overwritten); after the
    // second attempt fails totally, the merged evidence is still published.
    expect(calls).toBe(2);
    expect(outcome).toBe("spooled");
    const registry = new OrphanRegistry(dir);
    const residuals = await registry.readCategory("residuals");
    expect(residuals).toHaveLength(2);
    for (const { record } of residuals!) {
      expect(decodeResidualRecord(record)).not.toBeNull();
    }
    const pids = new Set(residuals!.map(({ record }) => ("pid" in record ? record.pid : 0)));
    expect(pids).toEqual(new Set([5002, 6001]));
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
      roundDelayMs: 1,
      runtimeDir: dir,
      agentCommand: () => "codex",
      generationId: "00000000-0000-4000-8000-000000000001",
      ownerToken: "00000000-0000-4000-8000-000000000002",
    });
    expect(outcome).toBe("spooled");

    const registry = new OrphanRegistry(dir);
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

test("windows: partial publication is unresolved, never spooled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eof-partial-"));
  try {
    // Descendant 5002: unsafe WITH a complete fingerprint (publishable).
    // Descendant 6001: leftover WITHOUT a complete fingerprint (unpublishable —
    // a handle-bound record cannot be built from fabricated identity).
    const outcome = await convergeOrphansBeforeExit({
      platform: "win32",
      terminateDescendants: async () => ({
        verified: false,
        outcomes: [{ pid: 5002, outcome: "access-denied" as const, ...FULL }],
        leftover: [{ pid: 6001, parentPid: 5002, creationDate: null, commandLine: null, executablePath: null }],
      }),
      maxRounds: 2,
      roundDelayMs: 1,
      runtimeDir: dir,
      agentCommand: () => "codex",
      generationId: "00000000-0000-4000-8000-000000000001",
      ownerToken: "00000000-0000-4000-8000-000000000002",
    });
    // 5002's record WAS durably written, but 6001's could not be — discharge
    // is all-or-nothing, so the verdict must be unresolved, never "spooled".
    expect(outcome).toBe("unresolved");
    const registry = new OrphanRegistry(dir);
    const residuals = await registry.readCategory("residuals");
    expect(residuals).toHaveLength(1);
    expect(residuals![0]!.record.kind).toBe("residual");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("windows: unverified descendants without a complete fingerprint cannot spool identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eof-nofp-"));
  try {
    const outcome = await convergeOrphansBeforeExit({
      platform: "win32",
      terminateDescendants: unpublishable,
      maxRounds: 2,
      roundDelayMs: 1,
      runtimeDir: dir,
    });
    expect(outcome).toBe("unresolved");
    // No record can ever be built, so nothing is published.
    const registry = new OrphanRegistry(dir);
    // Nothing publishable: the registry stays empty of records.
    expect(await registry.readCategory("residuals")).toEqual([]);
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
      maxRounds: 2,
      roundDelayMs: 1,
      runtimeDir: blocker,
    });
    expect(outcome).toBe("unresolved");
  } finally {
    await rm(blocker, { force: true });
  }
});

test("windows: production default never exits with ownership undischarged", async () => {
  // No maxRounds: the worker lingers (re-attempting convergence and
  // publication) instead of resolving "unresolved" — exit is structurally
  // gated on verified cleanup or fully published ownership. The race bounds
  // the assertion in real time because the promise under test never resolves.
  const dir = await mkdtemp(join(tmpdir(), "eof-linger-"));
  try {
    const race = await Promise.race([
      convergeOrphansBeforeExit({
        platform: "win32",
        terminateDescendants: unpublishable,
        roundDelayMs: 1,
        runtimeDir: dir,
      }).then(() => "resolved" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    expect(race).toBe("pending");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
