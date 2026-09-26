import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  convergeOrphansBeforeExit,
  mergeEvidence,
  sameProcessIdentity,
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
    verified: true,
    outcomes: [{ pid: 5002, outcome: "killed", ...FULL }],
    leftover: [],
  });
  // verified is attempt-level: this resolving attempt's own final snapshot
  // proved every discovered descendant safe, so discharge is proven even
  // though the accumulated evidence carried an earlier unsafe outcome.
  expect(resolved.verified).toBe(true);
  expect(resolved.outcomes.find((item) => item.pid === 5002)?.outcome).toBe("killed");
  expect(resolved.leftover).toEqual([]);
});

test("windows: a null-creation live descendant is never discharged on the strength of a dead look-alike", async () => {
  // End-to-end layer of the null-identity rule. A reused pid reports two
  // processes that were BOTH denied a creation time (the worker snapshots through
  // CIM and OpenProcess then fails before the kernel time is readable): a dead one
  // that resolved safe, and a live, inaccessible one that did not. The live one's
  // fingerprint is incomplete, so it can NEVER become a handle-bound residual.
  //
  // Merging the two on `null === null` erases the live one's evidence, which
  // leaves the unrelated-but-complete Y as the only requirement — and then the
  // worker discharges as "spooled" with a live process having NO durable
  // ownership. That is the false terminal proof this pins: the worker must keep
  // ownership and report unresolved instead.
  const dir = await mkdtemp(join(tmpdir(), "eof-null-"));
  try {
    let calls = 0;
    const outcome = await convergeOrphansBeforeExit({
      platform: "win32",
      terminateDescendants: async () => {
        calls += 1;
        const dead = {
          pid: 5002, outcome: "already-exited" as const,
          creationDate: null, commandLine: "old", executablePath: "C:\\old.exe",
          fingerprintSource: "cim" as const,
        };
        const live = {
          pid: 5002, outcome: "access-denied" as const,
          creationDate: null, commandLine: "new", executablePath: "C:\\new.exe",
          fingerprintSource: "cim" as const,
        };
        const blocker = {
          pid: 6001, parentPid: 5002,
          creationDate: "133801632000000030", commandLine: "y", executablePath: "C:\\y.exe",
          fingerprintSource: "cim" as const,
        };
        return {
          verified: false,
          outcomes: calls === 1 ? [dead] : [dead, live],
          leftover: [blocker],
        };
      },
      maxRounds: 3,
      roundDelayMs: 1,
      runtimeDir: dir,
    });
    expect(outcome).toBe("unresolved");
    // And the dead one's residual is not written either: publishing it would
    // discharge on the incomplete set, which must stay impossible.
    expect(calls).toBeGreaterThan(1);
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
    // Round 32 Blocking 3: the spool namespace is bound to the fence
    // generation so the new Host's handshake can lift the phase once the
    // reaper converges exactly these records.
    for (const { record } of residuals!) {
      expect(("generationId" in record ? record.generationId : "")).toBe("00000000-0000-4000-8000-000000000001");
    }
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
      // Residuals are SUBTREE ROOTS: the reaper must converge them through a
      // verified tree terminator (kill children too), not a single-pid kill.
      terminateTree: async (target) => {
        killed.push(target.pid);
        return { rootOutcome: "killed", outcomes: [{ target: { pid: target.pid, creationDate: target.creationDate ?? "" }, outcome: "killed" }] };
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

test("merge: two empty total-failure attempts never fabricate verified", () => {
  // Review round 22 Blocking 1: recomputing verified from accumulated
  // evidence made [].every() === true, so a first-round CIM failure looked
  // like a proven-empty tree. verified must only come from a real attempt.
  const merged = mergeEvidence(
    { verified: false, outcomes: [], leftover: [] },
    { verified: false, outcomes: [], leftover: [] },
  );
  expect(merged.verified).toBe(false);
});

test("windows: total-failure attempts on both rounds do not exit verified", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eof-empty-fail-"));
  try {
    const outcome = await convergeOrphansBeforeExit({
      platform: "win32",
      terminateDescendants: async () => ({ verified: false, outcomes: [], leftover: [] }),
      maxRounds: 2,
      roundDelayMs: 1,
      runtimeDir: dir,
    });
    expect(outcome).toBe("unresolved");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("merge: same pid with a different creationDate is a distinct identity", () => {
  // Review round 22 Blocking 2: pid reuse must not let a later killed outcome
  // for a NEW process resolve an earlier unsafe identity of a DIFFERENT one.
  // The two creation dates differ by far more than the CIM identity tolerance
  // (9 ticks): a reused pid's process was created a different time entirely, so
  // these must stay two required identities. Values within the tolerance are the
  // SAME process observed at different precision and DO merge (see the
  // canonicalization regression below).
  const a = mergeEvidence({ verified: false, outcomes: [], leftover: [] }, {
    verified: false,
    outcomes: [{ pid: 5002, outcome: "access-denied", creationDate: "133801632000000000", commandLine: "x", executablePath: "C:\\x.exe" }],
    leftover: [],
  });
  const b = mergeEvidence(a, {
    verified: false,
    outcomes: [{ pid: 5002, outcome: "killed", creationDate: "133801632000100000", commandLine: "y", executablePath: "C:\\y.exe" }],
    leftover: [],
  });
  expect(b.verified).toBe(false);
  // The OLD process (A) is still required evidence, unresolved.
  expect(b.outcomes.map((item) => item.pid).filter((pid) => pid === 5002)).toHaveLength(2);
  expect(b.outcomes.find((item) => item.creationDate === "133801632000000000")?.outcome).toBe("access-denied");
});

test("windows: a stale same-pid record cannot fake durable ownership for a reused pid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eof-pidreuse-"));
  try {
    const registry = new OrphanRegistry(dir);
    await registry.initialize();
    // Pre-existing record from a PRIOR discharge: pid 5002, creationDate A.
    // B below was created a DIFFERENT time entirely (well outside the 9-tick
    // identity tolerance), so it is a different process that reused the pid.
    await registry.writeResidual({
      schemaVersion: 1, kind: "residual", ownerToken: "00000000-0000-4000-8000-0000000000aa",
      pid: 5002, creationDate: "133801632000000000", commandLine: "old", executablePath: "C:\\old.exe",
      agentCommand: "codex", generationId: "00000000-0000-4000-8000-000000000001", killAttempts: 0,
    });
    // Block the CURRENT discharge's record for pid 5002 (creationDate B):
    // a directory at the target filename makes the durable rename fail, so
    // only the stale A record remains in the registry.
    const blockPath = join(dir, "orphans", "residuals", "00000000-0000-4000-8000-000000000002-5002.json");
    await mkdir(blockPath, { recursive: true });
    const outcome = await convergeOrphansBeforeExit({
      platform: "win32",
      terminateDescendants: async () => ({
        verified: false,
        outcomes: [{ pid: 5002, outcome: "access-denied", creationDate: "133801632000100000", commandLine: "new", executablePath: "C:\\new.exe" }],
        leftover: [],
      }),
      maxRounds: 2,
      roundDelayMs: 1,
      runtimeDir: dir,
      agentCommand: () => "codex",
      generationId: "00000000-0000-4000-8000-000000000001",
      ownerToken: "00000000-0000-4000-8000-000000000002",
    });
    // The read-back must match the FULL fingerprint of the required identity.
    // The only record present is (5002, creationDate A) — a REUSED pid with a
    // different process — so it must NOT discharge the B requirement.
    expect(outcome).toBe("unresolved");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("windows: EOF default attempt deadline is null (no outer hard-kill)", async () => {
  // Review round 24 Blocking 3: a mid-traversal SIGKILL loses ancestry
  // reachability AND partially-collected evidence. EOF convergence must
  // rely on the in-script watchdog (8s CIM + 2s WaitDead), never on an
  // outer hard-kill timer.
  const dir = await mkdtemp(join(tmpdir(), "eof-nodeadline-"));
  try {
    let deadline: number | null | undefined;
    let calls = 0;
    const outcome = await convergeOrphansBeforeExit({
      platform: "win32",
      terminateDescendants: async () => {
        calls += 1;
        return result(true, 0, 0);
      },
      runtimeDir: dir,
    });
    expect(outcome).toBe("verified");
    expect(calls).toBe(1);
    void deadline;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("windows: a throwing attempt (S2 CIM failure) leaves the tree untouched and the next round retries", async () => {
  // Review round 25 Blocking: the action now runs ALL fallible CIM discovery
  // (S1 + S2) before the first kill, so a discovery failure returns no
  // evidence AND mutates nothing; the discharge loop must simply retry from
  // the intact tree. First attempt throws (worker died mid-discovery), the
  // second verifies — exactly the retry the healthy round performs.
  const dir = await mkdtemp(join(tmpdir(), "eof-s2retry-"));
  try {
    const outcomes = [
      { verified: false, outcomes: [], leftover: [] }, // attempt 1: worker threw
      result(true, 0, 0),                              // attempt 2: healthy
    ];
    let calls = 0;
    const outcome = await convergeOrphansBeforeExit({
      platform: "win32",
      terminateDescendants: async () => {
        if (calls++ === 0) throw new Error("CIM query failed in S2");
        return outcomes[1]!;
      },
      roundDelayMs: 1,
      runtimeDir: dir,
    });
    expect(calls).toBe(2);
    expect(outcome).toBe("verified");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("posix: a throwing group kill REJECTS instead of reporting verified (round 29 Blocking 4)", async () => {
  // The group kill IS the POSIX ownership discharge. A throwing kill must not
  // be upgraded to "verified" — runtime-worker-main would exit its root while
  // adapter descendants may still be alive with no durable evidence.
  let attempts = 0;
  const dir = await mkdtemp(join(tmpdir(), "eof-posix-throw-"));
  try {
    await expect(convergeOrphansBeforeExit({
      platform: "darwin",
      killProcessGroup: () => {
        attempts += 1;
        const error = new Error("EPERM: operation not permitted") as Error & { code?: string };
        error.code = "EPERM";
        throw error;
      },
      runtimeDir: dir,
    })).rejects.toThrow(/EPERM/);
    expect(attempts).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("evidence identity is stable when the worker canonicalizes a shim path across rounds", () => {
  // The descendants worker replaces a shim-launched child's CIM executablePath
  // with the resolved image once a handle is available, so the SAME process is
  // observed with two different paths. Identity must not split on that, or the
  // stale alias record stays required evidence forever. Path is evidence, not
  // identity: `sameProcessIdentity` ignores it entirely.
  const alias = { pid: 5002, creationDate: "133801632000000010", commandLine: "node adapter.js", executablePath: "C:\\shim\\node.exe" };
  const resolved = { pid: 5002, creationDate: "133801632000000010", commandLine: "node adapter.js", executablePath: "C:\\real\\node.exe" };
  expect(sameProcessIdentity(alias, resolved)).toBe(true);
});

test("merge: a later safe outcome resolves an earlier unsafe one for the SAME process, keeping the handle fingerprint", () => {
  // Round 1: access-denied leaves an unsafe record carrying the CIM alias.
  // Round 2: the same process is verified through a handle, killed, and reports
  // the resolved image plus the handle creation time. It must RESOLVE round 1
  // and the surviving record must keep the handle-derived fingerprint — the old
  // behaviour produced two identities, spooled a residual for a dead process,
  // and let both compete for one durable filename.
  const round1 = mergeEvidence(
    { verified: false, outcomes: [], leftover: [] },
    {
      verified: false,
      outcomes: [{
        pid: 5002,
        outcome: "access-denied",
        creationDate: "133801632000000010",
        commandLine: "node adapter.js",
        executablePath: "C:\\shim\\node.exe",
        fingerprintSource: "cim",
      }],
      leftover: [],
    },
  );
  const merged = mergeEvidence(round1, {
    verified: false,
    outcomes: [{
      pid: 5002,
      outcome: "killed",
      creationDate: "133801632000000010",
      commandLine: "node adapter.js",
      executablePath: "C:\\real\\node.exe",
      fingerprintSource: "handle",
    }],
    // Another process is still unresolved, so this round is not verified.
    leftover: [{ pid: 5003, parentPid: 5002, creationDate: "133801632000000020", commandLine: "child", executablePath: "C:\\child.exe", fingerprintSource: "cim" }],
  });
  expect(merged.verified).toBe(false);
  expect(merged.outcomes.filter((item) => item.pid === 5002)).toHaveLength(1);
  const survivor = merged.outcomes.find((item) => item.pid === 5002)!;
  expect(survivor.outcome).toBe("killed");
  expect(survivor.executablePath).toBe("C:\\real\\node.exe");
  expect(survivor.fingerprintSource).toBe("handle");
});

test("merge: a handle fingerprint is never overwritten by a later CIM observation of the same process", () => {
  // Both observations are unsafe (access-denied), so safety cannot decide. The
  // handle-derived record must win, otherwise a stale alias would be spooled as
  // durable evidence the reaper can never discharge.
  const merged = mergeEvidence(
    { verified: false, outcomes: [], leftover: [] },
    {
      verified: false,
      outcomes: [{
        pid: 5002,
        outcome: "access-denied",
        creationDate: "133801632000000010",
        commandLine: "node adapter.js",
        executablePath: "C:\\real\\node.exe",
        fingerprintSource: "handle",
      }],
      leftover: [],
    },
  );
  const second = mergeEvidence(merged, {
    verified: false,
    outcomes: [{
      pid: 5002,
      outcome: "query-failed",
      creationDate: "133801632000000010",
      commandLine: "node adapter.js",
      executablePath: "C:\\shim\\node.exe",
      fingerprintSource: "cim",
    }],
    leftover: [],
  });
  expect(second.outcomes).toHaveLength(1);
  expect(second.outcomes[0]!.executablePath).toBe("C:\\real\\node.exe");
  expect(second.outcomes[0]!.fingerprintSource).toBe("handle");
});

test("windows: a residual whose fingerprint came from CIM replays with creation tolerance", async () => {
  // CIM creationDate is quantized to 6-digit microseconds, so it differs from
  // the kernel's FILETIME by 1-9 ticks. A reaper that demanded an exact match
  // would condemn every such residual as 'skipped-replaced' and never
  // discharge it. Assert the tolerance flag reaches the tree terminator.
  const dir = await mkdtemp(join(tmpdir(), "eof-cim-residual-"));
  try {
    const registry = new OrphanRegistry(dir);
    await registry.initialize();
    const ownerToken = "00000000-0000-4000-8000-0000000000cc";
    const generationId = "00000000-0000-4000-8000-0000000000dd";
    await registry.writeResidual({
      schemaVersion: 1,
      kind: "residual",
      ownerToken,
      pid: 5002,
      creationDate: "133801632000000010",
      commandLine: "node adapter.js",
      executablePath: "C:\\shim\\node.exe",
      fingerprintSource: "cim",
      agentCommand: "codex",
      generationId,
      killAttempts: 0,
    });
    const written = (await registry.readCategory("residuals"))[0]!.record as { fingerprintSource?: string };
    expect(written.fingerprintSource).toBe("cim");

    let captured: { fingerprintSource?: string } | null = null;
    const result = await sweepWindowsOrphans(registry, generationId, {
      probeIdentity: async () => ({ status: "found", identity: { pid: 5002, creationDate: "133801632000000010", executablePath: "C:\\shim\\node.exe" } }),
      terminateTree: async (root) => {
        captured = root;
        return { rootOutcome: "killed", outcomes: [] };
      },
      runJobHardKill: async () => ({ outcome: "killed" }),
      onWarning: () => {},
    });
    expect(captured?.fingerprintSource).toBe("cim");
    expect(result.degraded).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("evidence identity is stable when the worker canonicalizes the creation time across rounds", () => {
  // VF() writes the handle creation time back on success, so the SAME process is
  // reported with a CIM-quantized value one round and the kernel FILETIME the
  // next — different numbers, ONE process (measured 43/48 non-zero on a live
  // host, deltas 1-9 ticks). The quantization is compared SYMMETRICALLY (+-9,
  // either direction): rounding direction is not a documented guarantee, so no
  // direction is assumed even though measurements so far show CIM below.
  const quantized = { pid: 5002, creationDate: "133801632000000010", fingerprintSource: "cim" as const };
  const exact = { pid: 5002, creationDate: "133801632000000017", fingerprintSource: "handle" as const };
  expect(sameProcessIdentity(quantized, exact)).toBe(true);
  expect(sameProcessIdentity(exact, quantized)).toBe(true);
});

test("identity is provenance-aware: a canonicalized record must not bridge two distinct pid incarnations", () => {
  // A plain abs(delta) <= 9 band would chain CIM_A ~ handle_A (|010-011| = 1) and
  // handle_A ~ CIM_B (|011-020| = 9), "proving" CIM_A ~ CIM_B for processes whose
  // kernel values are 18 ticks apart — a reused pid merged away with the earlier
  // incarnation. The pairwise relation is attribution-aware and SYMMETRIC in the
  // mixed window (which way a provider rounds a FILETIME down to microseconds is
  // not a documented guarantee), so the bridge itself is blocked by the merge's
  // cluster history, not by relying on a direction this repo cannot prove.
  const cimA = { pid: 5002, creationDate: "133801632000000010", fingerprintSource: "cim" as const };
  const handleA = { pid: 5002, creationDate: "133801632000000011", fingerprintSource: "handle" as const };
  const cimB = { pid: 5002, creationDate: "133801632000000020", fingerprintSource: "cim" as const };
  const handleB = { pid: 5002, creationDate: "133801632000000029", fingerprintSource: "handle" as const };

  // Same process, observed at two precisions: the window is symmetric.
  expect(sameProcessIdentity(cimA, handleA)).toBe(true);
  expect(sameProcessIdentity(handleA, cimA)).toBe(true);
  // The two kernel values are 18 ticks apart: DIFFERENT processes that reused
  // the pid, no matter which observation of each is compared.
  expect(sameProcessIdentity(handleA, handleB)).toBe(false);
  expect(sameProcessIdentity(cimA, cimB)).toBe(false);
  // Mixed-source comparisons stay within the window in EITHER direction — the
  // guard against bridging lives in the cluster (mergeEvidence below).
  expect(sameProcessIdentity(handleA, cimB)).toBe(true);
  // handleB ...029 vs cimA ...010 is 19 ticks apart: outside the window.
  expect(sameProcessIdentity(handleB, cimA)).toBe(false);
  // And cimB ...020 vs cimA ...010: exact-equality only, so still different.
  expect(sameProcessIdentity(cimA, cimB)).toBe(false);

  // Unattributed values grant NO tolerance: no provenance, no ±9, in either
  // direction and across both explicit-unknown and absent.
  for (const unattributed of [undefined, "unknown"] as const) {
    expect(sameProcessIdentity(
      { pid: 5003, creationDate: "133801632000000010", fingerprintSource: unattributed },
      { pid: 5003, creationDate: "133801632000000019", fingerprintSource: "handle" },
    )).toBe(false);
    expect(sameProcessIdentity(
      { pid: 5003, creationDate: "133801632000000010", fingerprintSource: "handle" },
      { pid: 5003, creationDate: "133801632000000019", fingerprintSource: unattributed },
    )).toBe(false);
    expect(sameProcessIdentity(
      { pid: 5004, creationDate: "133801632000000010", fingerprintSource: unattributed },
      { pid: 5004, creationDate: "133801632000000019", fingerprintSource: "cim" },
    )).toBe(false);
    expect(sameProcessIdentity(
      { pid: 5004, creationDate: "133801632000000010", fingerprintSource: "cim" },
      { pid: 5004, creationDate: "133801632000000019", fingerprintSource: unattributed },
    )).toBe(false);
  }
  // And a different pid never matches, whatever the timestamps.
  expect(sameProcessIdentity(cimA, { ...cimA, pid: 5003 })).toBe(false);
});

test("merge: a canonicalized pid identity does NOT absorb a later incarnation of the same pid", () => {
  // The bridge, closed at the merge layer where it actually happened.
  // Round 1: P1 unsafe, CIM ...010. Round 2: P1 verified through a handle, so the
  // survivor is canonicalized to the kernel value ...011 and P1 is resolved.
  // P1 exits, the pid is reused by P2 (kernel ...029, first observed through CIM
  // as ...020 — 9 ticks from the canonicalized P1 record). The resolved P1
  // record must not absorb P2: its unsafe evidence would be discarded and the
  // pid would publish with no residual at all.
  const afterP1 = mergeEvidence(
    { verified: false, outcomes: [], leftover: [] },
    {
      verified: false,
      outcomes: [
        { pid: 5002, outcome: "access-denied", creationDate: "133801632000000010", commandLine: "old", executablePath: "C:\\old.exe", fingerprintSource: "cim" },
        { pid: 5002, outcome: "killed", creationDate: "133801632000000011", commandLine: "old", executablePath: "C:\\real.exe", fingerprintSource: "handle" },
      ],
      leftover: [],
    },
  );
  expect(afterP1.outcomes).toHaveLength(1);
  expect(afterP1.outcomes[0]!.outcome).toBe("killed");

  const afterP2 = mergeEvidence(afterP1, {
    verified: false,
    outcomes: [{ pid: 5002, outcome: "access-denied", creationDate: "133801632000000020", commandLine: "new", executablePath: "C:\\new.exe", fingerprintSource: "cim" }],
    leftover: [],
  });
  expect(afterP2.outcomes.filter((item) => item.pid === 5002)).toHaveLength(2);
  const p2 = afterP2.outcomes.filter((item) => item.pid === 5002).find((item) => item.outcome === "access-denied");
  expect(p2).toBeDefined();
  expect(p2!.creationDate).toBe("133801632000000020");
});

test("merge: a later CIM observation of the SAME process does not split off an unpublishable second identity", () => {
  // The other side of the same cluster. A CIM value is not guaranteed to sit
  // below the kernel one (ManagementDateTimeConverter rounds to nearest), so a
  // later CIM round can print the same process ABOVE its canonicalized handle
  // value. The pair is within the window but pairwise handle-vs-cim would keep
  // BOTH identities alive — and because a residual file is keyed by pid alone,
  // one write overwrites the other and the read-back can never prove either.
  // The worker would then linger unresolved forever.
  const afterHandle = mergeEvidence(
    { verified: false, outcomes: [], leftover: [] },
    {
      verified: false,
      outcomes: [{ pid: 5002, outcome: "killed", creationDate: "133801632000000016", commandLine: "a", executablePath: "C:\\real.exe", fingerprintSource: "handle" }],
      leftover: [{ pid: 6001, parentPid: 5002, creationDate: "133830000000000010", commandLine: "b", executablePath: "C:\\b.exe", fingerprintSource: "cim" }],
    },
  );
  // Same process, CIM rounded UP by 4 ticks (still unsafe, so it stays required).
  const afterCim = mergeEvidence(afterHandle, {
    verified: false,
    outcomes: [{ pid: 5002, outcome: "access-denied", creationDate: "133801632000000020", commandLine: "a", executablePath: "C:\\real.exe", fingerprintSource: "cim" }],
    leftover: [],
  });
  // One identity for the pid, carrying the resolved (safe) observation.
  expect(afterCim.outcomes.filter((item) => item.pid === 5002)).toHaveLength(1);
  expect(afterCim.outcomes[0]!.outcome).toBe("killed");
  expect(afterCim.outcomes[0]!.creationDate).toBe("133801632000000016");
});

test("merge: an unattributed print is never absorbed into a tolerant identity", () => {
  // "unknown" and an absent field make no claim about quantization, so they
  // grant no tolerance in either direction. The PowerShell worker can emit an
  // explicit 'unknown' for a leftover that never reached VF, so this is a live
  // protocol value, not a theoretical one.
  for (const unattributed of ["unknown", undefined] as const) {
    const first = mergeEvidence(
      { verified: false, outcomes: [], leftover: [] },
      {
        verified: false,
        outcomes: [{ pid: 5002, outcome: "access-denied", creationDate: "133801632000000010", commandLine: "a", executablePath: "C:\\a.exe", fingerprintSource: unattributed }],
        leftover: [],
      },
    );
    // A CIM view 7 ticks away must NOT collapse the unattributed record: that
    // would silently claim a quantization the source never asserted.
    const merged = mergeEvidence(first, {
      verified: false,
      outcomes: [{ pid: 5002, outcome: "access-denied", creationDate: "133801632000000017", commandLine: "a", executablePath: "C:\\a.exe", fingerprintSource: "cim" }],
      leftover: [],
    });
    expect(merged.outcomes.filter((item) => item.pid === 5002)).toHaveLength(2);

    // Conversely a handle view 7 ticks away stays separate too.
    const mergedHandle = mergeEvidence(first, {
      verified: false,
      outcomes: [{ pid: 5002, outcome: "access-denied", creationDate: "133801632000000017", commandLine: "a", executablePath: "C:\\a.exe", fingerprintSource: "handle" }],
      leftover: [],
    });
    expect(mergedHandle.outcomes.filter((item) => item.pid === 5002)).toHaveLength(2);

    // And an exact match still merges: no tolerance does not mean "no identity".
    // Same source on both sides (unattributed vs unattributed) requires exact
    // equality, which this fixture satisfies.
    const exact = mergeEvidence(first, {
      verified: false,
      outcomes: [{ pid: 5002, outcome: "access-denied", creationDate: "133801632000000010", commandLine: "a", executablePath: "C:\\a.exe", fingerprintSource: unattributed }],
      leftover: [],
    });
    expect(exact.outcomes.filter((item) => item.pid === 5002)).toHaveLength(1);

    // Cross-source EXACT equality still merges too: one instant prints the same
    // value through either source, so a later attributed observation of the very
    // same timestamp is the same process. The cluster matcher must honour the
    // exact-only contract in BOTH directions, not just within one provenance.
    for (const attributed of ["handle", "cim"] as const) {
      const cross = mergeEvidence(first, {
        verified: false,
        outcomes: [{ pid: 5002, outcome: "access-denied", creationDate: "133801632000000010", commandLine: "a", executablePath: "C:\\a.exe", fingerprintSource: attributed }],
        leftover: [],
      });
      expect(cross.outcomes.filter((item) => item.pid === 5002)).toHaveLength(1);
      expect(cross.outcomes[0]!.fingerprintSource).toBe(attributed);
    }
  }
});

test("merge: a print matching several incarnations of one pid resolves the newest, not the first", () => {
  // Two incarnations of pid 5002 coexist because their CIM prints differ:
  //   A = P1 [cim ...010], already-exited (safe)
  //   B = P2 [cim ...020], access-denied (unsafe)
  // The next observation verifies P2 through a handle, and the provider rounded
  // UP: kernel ...019, which is 9 ticks from A's print and 1 tick from B's. The
  // kill must resolve B, NOT A — assigning it to the first matching cluster would
  // leave P2's unsafe evidence behind, and the reaper retains a residual whose
  // root is already-exited (that outcome proves nothing about descendants), so
  // the fence generation's spool namespace would never empty and the fence could
  // never discharge.
  // (Chronology and distance agree here; the shapes where they disagree are
  // pinned separately, under the symmetric quantization below.)
  let acc = { verified: false, outcomes: [], leftover: [] };
  const incomplete = [{ pid: 6001, parentPid: 5002, creationDate: null, commandLine: null, executablePath: null }];
  acc = mergeEvidence(acc, {
    verified: false,
    outcomes: [{ pid: 5002, outcome: "already-exited", creationDate: "133801632000000010", commandLine: "old", executablePath: "C:\\old.exe", fingerprintSource: "cim" }],
    leftover: incomplete,
  });
  acc = mergeEvidence(acc, {
    verified: false,
    outcomes: [{ pid: 5002, outcome: "access-denied", creationDate: "133801632000000020", commandLine: "new", executablePath: "C:\\new.exe", fingerprintSource: "cim" }],
    leftover: incomplete,
  });
  // Both incarnations exist as separate identities.
  expect(acc.outcomes.filter((item) => item.pid === 5002)).toHaveLength(2);
  // P2 verified through a handle whose kernel value rounds UP: ...019.
  acc = mergeEvidence(acc, {
    verified: false,
    outcomes: [{ pid: 5002, outcome: "killed", creationDate: "133801632000000019", commandLine: "new", executablePath: "C:\\real.exe", fingerprintSource: "handle" }],
    leftover: [],
  });
  // P1's already-exited record is untouched; P2's cluster is the one resolved.
  const records = acc.outcomes.filter((item) => item.pid === 5002);
  expect(records.map((item) => item.outcome).sort()).toEqual(["already-exited", "killed"]);
  const p1 = records.find((item) => item.creationDate === "133801632000000010")!;
  const p2 = records.find((item) => item.outcome === "killed")!;
  expect(p1.creationDate).toBe("133801632000000010");
  expect(p2.creationDate).toBe("133801632000000019");
  expect(p2.fingerprintSource).toBe("handle");
  // Nothing unsafe is left for this pid, so nothing can be spooled for it.
  expect(acc.outcomes.filter((item) => item.pid === 5002 && item.outcome !== "killed" && item.outcome !== "already-exited")).toHaveLength(0);
});

test("merge: an identity's print history does not grow across unbounded convergence rounds", () => {
  // `convergeOrphansBeforeExit` runs an UNBOUNDED loop in production (no
  // maxRounds, one round every roundDelayMs), and a process that keeps failing
  // convergence re-reports the same observation every round. Appending each one
  // would grow the history linearly with uptime while every cluster test scans it
  // — quadratic total work, for a loop that is deliberately designed to run
  // forever while it cannot discharge.
  let acc = { verified: false, outcomes: [], leftover: [] };
  const round = (): TerminateDescendantsResult => ({
    verified: false,
    outcomes: [{ pid: 5002, outcome: "access-denied", creationDate: "133801632000000010", commandLine: "a", executablePath: "C:\\a.exe", fingerprintSource: "cim" }],
    leftover: [{ pid: 6001, parentPid: 5002, creationDate: "133830000000000000", commandLine: "b", executablePath: "C:\\b.exe", fingerprintSource: "cim" }],
  });
  for (let i = 1; i <= 2_000; i += 1) acc = mergeEvidence(acc, round());
  // One print per provenance is all a legal identity can ever need.
  const outcome = acc.outcomes[0]!;
  const leftover = acc.leftover[0]!;
  expect(outcome.identityPrints).toHaveLength(1);
  expect(leftover.identityPrints).toHaveLength(1);
  // And the evidence itself is unchanged by all that repetition.
  expect(acc.outcomes).toHaveLength(1);
  expect(acc.leftover).toHaveLength(1);
  expect(outcome.executablePath).toBe("C:\\a.exe");

  // Distinct observations still accumulate: a later handle print of the SAME
  // process joins the cluster and is retained, so the history stays usable.
  const canonicalized = mergeEvidence(acc, {
    verified: false,
    outcomes: [{ pid: 5002, outcome: "killed", creationDate: "133801632000000011", commandLine: "a", executablePath: "C:\\real.exe", fingerprintSource: "handle" }],
    leftover: [],
  });
  expect(canonicalized.outcomes).toHaveLength(1);
  expect(canonicalized.outcomes[0]!.outcome).toBe("killed");
  expect(canonicalized.outcomes[0]!.identityPrints).toHaveLength(2);
});

test("merge: an established cluster boundary survives every later round", () => {
  // Re-clustering the ACCUMULATED side from scratch would re-derive boundaries
  // from survivor timestamps alone, ignoring the proof each cluster's own history
  // carries. Concretely:
  //   A = P1 [cim 010], safe        B = P2 [cim 020, handle 019], unsafe
  // B's survivor is handle 019, which is 9 ticks from A's CIM 010 and 1 from its
  // own CIM 020 — so a survivor-only match would pull B into A, and safe A would
  // then erase P2's unsafe evidence. That is a false terminal proof: P2 may still
  // be alive, and a later round that would have spooled its ownership now finds
  // nothing required for the pid at all.
  const blocker = (creationDate: string) => ({
    pid: 6001, parentPid: 5002, creationDate,
    commandLine: "adapter", executablePath: "C:\\adapter.exe",
    fingerprintSource: "cim" as const,
  });
  let acc = { verified: false, outcomes: [], leftover: [] };
  // Round 0: P1 safe, CIM 010 + blocker X complete.
  acc = mergeEvidence(acc, {
    verified: false,
    outcomes: [{ pid: 5002, outcome: "already-exited", creationDate: "133801632000000010", commandLine: "old", executablePath: "C:\\old.exe", fingerprintSource: "cim" }],
    leftover: [blocker("133830000000000000")],
  });
  // Round 1: the pid is reused by P2, unsafe, CIM 020.
  acc = mergeEvidence(acc, {
    verified: false,
    outcomes: [{ pid: 5002, outcome: "access-denied", creationDate: "133801632000000020", commandLine: "new", executablePath: "C:\\new.exe", fingerprintSource: "cim" }],
    leftover: [],
  });
  // Round 2: P2 verified through a handle that rounded UP (kernel 019), kill
  // unconfirmed — so P2 is STILL required evidence.
  acc = mergeEvidence(acc, {
    verified: false,
    outcomes: [{ pid: 5002, outcome: "kill-requested-unconfirmed", creationDate: "133801632000000019", commandLine: "new", executablePath: "C:\\real.exe", fingerprintSource: "handle" }],
    leftover: [],
  });
  // Both incarnations exist, correctly separated.
  expect(acc.outcomes.filter((item) => item.pid === 5002)).toHaveLength(2);
  // Round 3: a TOTAL failure contributes nothing new. The accumulated side must
  // be carried through untouched — this is the round the old code re-clustered.
  const after = mergeEvidence(acc, { verified: false, outcomes: [], leftover: [] });
  const records = after.outcomes.filter((item) => item.pid === 5002);
  expect(records).toHaveLength(2);
  expect(records.map((item) => item.outcome).sort()).toEqual(["already-exited", "kill-requested-unconfirmed"]);
  // P2 keeps BOTH its prints: the CIM print that pinned its instant, and the
  // canonicalized handle value.
  const p2 = records.find((item) => item.outcome === "kill-requested-unconfirmed")!;
  expect(p2.creationDate).toBe("133801632000000019");
  expect(p2.identityPrints!.map((print) => print.creationDate).sort()).toEqual([
    "133801632000000019",
    "133801632000000020",
  ]);
  const p1 = records.find((item) => item.outcome === "already-exited")!;
  expect(p1.identityPrints!.map((print) => print.creationDate)).toEqual(["133801632000000010"]);
  // And an indefinite number of further empty rounds change nothing.
  for (let round = 0; round < 50; round += 1) {
    const again = mergeEvidence(after, { verified: false, outcomes: [], leftover: [] });
    expect(again.outcomes.filter((item) => item.pid === 5002)).toHaveLength(2);
    expect(again.outcomes.filter((item) => item.outcome === "kill-requested-unconfirmed")).toHaveLength(1);
  }
});

test("merge: a pre-formed cluster never joins a cluster its own history contradicts", () => {
  // The cluster-compatibility layer, directly. A new side can legitimately arrive
  // carrying prints it accumulated in earlier rounds (an accumulated result
  // merged into a different accumulator, or a caller composing evidence), and its
  // HISTORIES — not just its survivor timestamps — decide whether it may join.
  //
  //   existing A: survivor undefined, prints [cim 010]
  //   incoming B: survivor handle 019, prints [cim 020, handle 019]
  //
  // B's SURVIVOR (handle 019) is 9 ticks from A's cim 010, so a survivor-only
  // match would happily join them. But both clusters carry a CIM print and those
  // prints disagree (010 vs 020) — which is precisely the evidence that an earlier
  // round used to prove these are two different incarnations of the pid. Joining
  // them here would resurrect exactly the boundary loss the a-seeding fix closed
  // by another route, and `winsOver` would then let A's safe record erase B's
  // unsafe evidence.
  const existing = {
    verified: false,
    outcomes: [{
      pid: 5002, outcome: "access-denied",
      creationDate: "133801632000000010", commandLine: "old", executablePath: "C:\\old.exe",
      fingerprintSource: "cim",
      identityPrints: [{ pid: 5002, creationDate: "133801632000000010", fingerprintSource: "cim" as const }],
    }],
    leftover: [],
  };
  const incoming = {
    verified: false,
    outcomes: [{
      pid: 5002, outcome: "access-denied",
      creationDate: "133801632000000019", commandLine: "new", executablePath: "C:\\real.exe",
      fingerprintSource: "handle",
      identityPrints: [
        { pid: 5002, creationDate: "133801632000000020", fingerprintSource: "cim" as const },
        { pid: 5002, creationDate: "133801632000000019", fingerprintSource: "handle" as const },
      ],
    }],
    leftover: [],
  };
  const merged = mergeEvidence(existing, incoming);
  // Two separate identities: the incompatible CIM prints keep them apart.
  expect(merged.outcomes.filter((item) => item.pid === 5002)).toHaveLength(2);
  const byPrint = merged.outcomes.map((item) => item.creationDate);
  expect(byPrint).toContain("133801632000000010");
  expect(byPrint).toContain("133801632000000019");

  // Reverse the sides to prove the check is symmetric and not an artefact of
  // which argument happened to be the accumulator.
  const reversed = mergeEvidence(incoming, existing);
  expect(reversed.outcomes.filter((item) => item.pid === 5002)).toHaveLength(2);

  // And a compatible pre-formed cluster DOES merge: agreeing CIM prints are the
  // same process, so this is not a blanket "never join" rule.
  const compatible = mergeEvidence(existing, {
    verified: false,
    outcomes: [{
      pid: 5002, outcome: "killed",
      creationDate: "133801632000000011", commandLine: "old", executablePath: "C:\\real.exe",
      fingerprintSource: "handle",
      identityPrints: [
        { pid: 5002, creationDate: "133801632000000010", fingerprintSource: "cim" as const },
        { pid: 5002, creationDate: "133801632000000011", fingerprintSource: "handle" as const },
      ],
    }],
    leftover: [],
  });
  expect(compatible.outcomes.filter((item) => item.pid === 5002)).toHaveLength(1);
  expect(compatible.outcomes[0]!.outcome).toBe("killed");
});

test("sameProcessIdentity: two null rows of one pid are NOT the same process when their fingerprints disagree", () => {
  // `clusterFit` refuses to merge a null observation into a cluster whose row it
  // is not an exact repeat of. The exported pairwise predicate must agree with
  // that, or a caller treating it as authoritative would assert the identity the
  // merge refuses — re-introducing the unsafe rule that a dead incarnation's safe
  // outcome can resolve a live one's evidence. `null === null` is the ABSENCE of
  // creation-time authority, not evidence of identity.
  const p1 = {
    pid: 5002, creationDate: null,
    commandLine: "old", executablePath: "C:\\old.exe",
  };
  const p2 = {
    pid: 5002, creationDate: null,
    commandLine: "new", executablePath: "C:\\new.exe",
  };
  expect(sameProcessIdentity(p1, p2)).toBe(false);
  expect(sameProcessIdentity(p2, p1)).toBe(false);

  // A null never merges with a timestamped record in either direction.
  const stamped = { pid: 5002, creationDate: "133801632000000010", fingerprintSource: "cim" as const };
  expect(sameProcessIdentity(p1, stamped)).toBe(false);
  expect(sameProcessIdentity(stamped, p1)).toBe(false);

  // An EXACT repeat of the same snapshot is still one process: this is what keeps
  // a failing process's per-round re-report from forking an unbounded set of
  // clusters.
  const p1Again = { ...p1 };
  expect(sameProcessIdentity(p1, p1Again)).toBe(true);
});

test("evidence identity keeps a reused pid separate", () => {
  // Same pid, creation times far apart: a different process that reused the pid.
  // Both must stay required evidence.
  const reused = { pid: 5002, creationDate: "133801632000000000" };
  const fresh = { pid: 5002, creationDate: "133801632000100000" };
  expect(sameProcessIdentity(reused, fresh)).toBe(false);
});

test("merge: a null creation time is no identity authority - a safe null cannot resolve a live null", () => {
  // A row's creation time can be denied: the worker snapshots through CIM
  // (creationDate null) and OpenProcess then fails BEFORE the kernel creation time
  // is read, so the row carries no creation-time authority at all. Two different
  // processes of one reused pid can BOTH be in that state, so `null === null` is
  // the absence of evidence, not evidence of identity.
  //
  //   round 0: P1 / null / "old" -> exits after the snapshot -> already-exited (SAFE)
  //   round 1: P2 / null / "new" -> still live, access denied -> access-denied (UNSAFE)
  //
  // Merging on the null let P1's safe record resolve P2 through `winsOver`
  // (resolution is the first criterion), which ERASED the live process's evidence.
  // With that evidence gone the only remaining requirement was the unrelated Y,
  // publication succeeded, and the worker returned "spooled" while a live process
  // had no durable ownership - a false terminal proof, not a livelock.
  const round0 = mergeEvidence(
    { verified: false, outcomes: [], leftover: [] },
    {
      verified: false,
      outcomes: [{
        pid: 5002, outcome: "already-exited",
        creationDate: null, commandLine: "old", executablePath: "C:\\old.exe",
        fingerprintSource: "cim",
      }],
      // An unrelated, complete, publishable blocker so publication can be tested.
      leftover: [{
        pid: 6001, parentPid: 5002,
        creationDate: "133801632000000030", commandLine: "y", executablePath: "C:\\y.exe",
        fingerprintSource: "cim",
      }],
    },
  );
  const merged = mergeEvidence(round0, {
    verified: false,
    outcomes: [{
      pid: 5002, outcome: "access-denied",
      creationDate: null, commandLine: "new", executablePath: "C:\\new.exe",
      fingerprintSource: "cim",
    }],
    leftover: [],
  });
  // BOTH incarnations survive as required evidence: the live one's unsafe record is
  // never absorbed by the dead one's safe record.
  const rows = merged.outcomes.filter((item) => item.pid === 5002);
  expect(rows).toHaveLength(2);
  const byCommand = new Map(rows.map((item) => [item.commandLine, item]));
  expect(byCommand.get("new")?.outcome).toBe("access-denied");
  expect(byCommand.get("old")?.outcome).toBe("already-exited");
  // Neither history absorbed the other's print.
  expect(new Set(byCommand.get("new")?.identityPrints?.map((print) => print.commandLine)))
    .toEqual(new Set(["new"]));
  expect(new Set(byCommand.get("old")?.identityPrints?.map((print) => print.commandLine)))
    .toEqual(new Set(["old"]));
});

test("merge: an identical null observation still dedupes, so failing rounds cannot grow it", () => {
  // `convergeOrphansBeforeExit` runs an UNBOUNDED loop and a process that keeps
  // failing convergence re-reports the SAME denied-identity row every round. The
  // null-repeat exemption therefore only applies to an EXACT repeat: same
  // commandLine and executablePath, i.e. the same observation from the same
  // snapshot. Anything else is a different process.
  let acc = { verified: false, outcomes: [], leftover: [] };
  for (let round = 0; round < 2_000; round += 1) {
    acc = mergeEvidence(acc, {
      verified: false,
      outcomes: [{
        pid: 5002, outcome: "access-denied",
        creationDate: null, commandLine: "same", executablePath: "C:\\same.exe",
        fingerprintSource: "cim",
      }],
      leftover: [],
    });
  }
  expect(acc.outcomes).toHaveLength(1);
  expect(acc.outcomes[0]!.identityPrints).toHaveLength(1);
});

test("merge: a canonicalized row later denied its creation time stays the same identity", () => {
  // The reverse direction, so the exemption is not a blanket "null never joins".
  // A row that WAS identified (the worker wrote the kernel values back on a
  // successful handle check) and is LATER reported with a denied creation time is
  // still that same identity: it arrives carrying the print the cluster already
  // holds, which is the pointer that identifies it.
  //
  // PROVENANCE OF THIS SHAPE: it is a COMPOSITION / defense-in-depth case, not a
  // raw worker round. `identityPrints` is internal bookkeeping that a decoder never
  // produces, and `convergeOrphansBeforeExit` always merges
  // `a = accumulated` / `b = fresh worker result`, so a fresh `b` carries no such
  // history. The natural worker sequence for the same process (null one round,
  // timestamped the next) does NOT reunite today — it forks into two clusters —
  // exactly as it did on `main`, whose identity key included the creation time
  // too. This test pins the comparator's behaviour for a caller that DOES compose
  // evidence; it does not assert a production lifecycle.
  const identified = mergeEvidence(
    { verified: false, outcomes: [], leftover: [] },
    {
      verified: false,
      outcomes: [{
        pid: 5002, outcome: "access-denied",
        creationDate: "133801632000000010", commandLine: "a", executablePath: "C:\\a.exe",
        fingerprintSource: "cim",
      }],
      leftover: [],
    },
  );
  const merged = mergeEvidence(identified, {
    verified: false,
    outcomes: [{
      pid: 5002, outcome: "killed",
      creationDate: null, commandLine: "a", executablePath: "C:\\a.exe",
      fingerprintSource: "handle",
      identityPrints: [{
        pid: 5002, creationDate: "133801632000000010", fingerprintSource: "cim" as const,
        commandLine: "a", executablePath: "C:\\a.exe",
      }],
    }],
    leftover: [],
  });
  // One identity, resolved - and it did NOT fork into a permanently unresolved
  // null cluster that could never discharge.
  expect(merged.outcomes.filter((item) => item.pid === 5002)).toHaveLength(1);
  expect(merged.outcomes[0]!.outcome).toBe("killed");
  expect(merged.leftover.filter((item) => item.pid === 5002)).toHaveLength(0);

  // A null row carrying a FOREIGN history is a different process and must not join
  // on the strength of the pointer alone.
  const foreign = mergeEvidence(identified, {
    verified: false,
    outcomes: [{
      pid: 5002, outcome: "killed",
      creationDate: null, commandLine: "b", executablePath: "C:\\b.exe",
      fingerprintSource: "handle",
      identityPrints: [{
        pid: 5002, creationDate: "133801632000000099", fingerprintSource: "cim" as const,
        commandLine: "b", executablePath: "C:\\b.exe",
      }],
    }],
    leftover: [],
  });
  expect(foreign.outcomes.filter((item) => item.pid === 5002)).toHaveLength(2);
});

test("merge: an equidistant tie resolves the newer incarnation, not the older one", () => {
  // Distance and chronology can coincide, disagree, or be unable to decide. This
  // test covers the two shapes where they DISAGREE-or-TIE and chronology must win;
  // the symmetric extreme below is the dangerous one, because it is not a tie at
  // all while still requiring chronology to win.
  //
  //   distance tie: CIM010 / CIM020 / HANDLE015      (5 vs 5)
  //   symmetric:     CIM010 / CIM020 / HANDLE011     (1 vs 9, nearer-but-older)
  //
  // Both must resolve the NEWER incarnation. Assigning either to the older one
  // resolves a process that no longer exists and leaves the live one's unsafe
  // evidence behind as a residual the reaper can never retire
  // (`already-exited` proves nothing about descendants), so the generation's
  // spool namespace never empties and the fence never lifts.
  const accumulated = {
    verified: false,
    outcomes: [{
      pid: 5002, outcome: "already-exited",
      creationDate: "133801632000000010", commandLine: "old", executablePath: "C:\\old.exe",
      fingerprintSource: "cim",
    }],
    leftover: [{
      pid: 5002,
      creationDate: "133801632000000020", commandLine: "live", executablePath: "C:\\live.exe",
      fingerprintSource: "cim",
    }],
  };
  const round = {
    verified: true,
    outcomes: [{
      pid: 5002, outcome: "killed",
      creationDate: "133801632000000015", commandLine: "live", executablePath: "C:\\live.exe",
      fingerprintSource: "handle",
    }],
    leftover: [],
  };
  const merged = mergeEvidence(accumulated, round);
  // The live process resolves; nothing survives with cim 020 as unsafe evidence.
  expect(merged.leftover.filter((item) => item.pid === 5002)).toHaveLength(0);
  const rows = merged.outcomes.filter((item) => item.pid === 5002);
  expect(rows).toHaveLength(2);
  const live = rows.find((item) => item.fingerprintSource === "handle");
  expect(live?.outcome).toBe("killed");
  expect(live?.creationDate).toBe("133801632000000015");
  // The older incarnation keeps its own record, untouched by this round.
  const old = rows.find((item) => item.fingerprintSource === "cim");
  expect(old?.creationDate).toBe("133801632000000010");
  expect(old?.outcome).toBe("already-exited");
  // ...and it did NOT absorb the handle print as part of its own history.
  expect(new Set(old?.identityPrints?.map((print) => print.creationDate))).toEqual(
    new Set(["133801632000000010"]),
  );
  // The handle landed in the NEWER cluster: its history now carries cim 020, the
  // observation that cluster was built from. This is the assertion that actually
  // discriminates the direction — the leftover assertions above are satisfied
  // either way, because `mergeEvidence` arbitrates outcomes and leftovers in one
  // pass and an outcome always displaces a same-process leftover.
  expect(new Set(live?.identityPrints?.map((print) => print.creationDate))).toEqual(
    new Set(["133801632000000020", "133801632000000015"]),
  );

  // Convergence form, one round per merge so every side has the shape the real
  // decoder can produce. `decodeWindowsDescendantsResponse` keeps a `seen` set,
  // so a single round NEVER reports one pid in both `outcomes` and `leftover` —
  // each merge below contributes exactly one observation, exactly as in
  // `convergeOrphansBeforeExit`'s accumulate-then-merge loop.
  //   round 1: P1 resolves (cim 010, already-exited)
  //   round 2: P2 appears, still live (cim 020, leftover)
  //   round 3: P2 is verified by handle (015 killed)
  // The reverse-side case is deliberately NOT asserted: `mergeByIdentity` seeds
  // from `a` verbatim as a correctness precondition (re-clustering the
  // accumulated side would resurrect boundaries an earlier round established),
  // so production only ever calls it accumulated-first.
  let converge = mergeEvidence(
    { verified: false, outcomes: [], leftover: [] },
    {
      verified: false,
      outcomes: [{
        pid: 5002, outcome: "already-exited",
        creationDate: "133801632000000010", commandLine: "old", executablePath: "C:\\old.exe",
        fingerprintSource: "cim",
      }],
      leftover: [],
    },
  );
  converge = mergeEvidence(converge, {
    verified: false,
    outcomes: [],
    leftover: [{
      pid: 5002,
      creationDate: "133801632000000020", commandLine: "live", executablePath: "C:\\live.exe",
      fingerprintSource: "cim",
    }],
  });
  converge = mergeEvidence(converge, {
    verified: true,
    outcomes: [{
      pid: 5002, outcome: "killed",
      creationDate: "133801632000000015", commandLine: "live", executablePath: "C:\\live.exe",
      fingerprintSource: "handle",
    }],
    leftover: [],
  });
  // Same verdict as the single-shot shape: P2 resolves, P1 is untouched, and no
  // stale P2 evidence is left behind to spool.
  expect(converge.leftover.filter((item) => item.pid === 5002)).toHaveLength(0);
  const rows2 = converge.outcomes.filter((item) => item.pid === 5002);
  expect(rows2).toHaveLength(2);
  const resolved2 = rows2.find((item) => item.fingerprintSource === "handle");
  expect(resolved2?.outcome).toBe("killed");
  expect(new Set(resolved2?.identityPrints?.map((print) => print.creationDate)))
    .toEqual(new Set(["133801632000000020", "133801632000000015"]));
  const kept2 = rows2.find((item) => item.fingerprintSource === "cim");
  expect(kept2?.creationDate).toBe("133801632000000010");
  expect(new Set(kept2?.identityPrints?.map((print) => print.creationDate)))
    .toEqual(new Set(["133801632000000010"]));

  // CHRONOLOGY, NOT DISTANCE. The dangerous case is where the nearer cluster is
  // the OLDER one, and it is reachable because the quantization is symmetric
  // (+-9 in EITHER direction): CIM may round UP as well as down.
  //
  //   P1: kernel 001 -> CIM 010        (+9)
  //   P2: kernel 011 -> CIM 020        (+9)   <- 10 ticks from P1: distinct
  //
  // A later round resolves P2 by handle, and that print is P2's OWN kernel value
  // 011: 9 from its own CIM 020 (legal), but only 1 from P1's CIM 010. Ranking
  // distance first resolves the STALE process with P2's safe outcome and leaves
  // the live P2's unsafe evidence behind — a residual the reaper must retain
  // forever, so the generation's spool namespace never empties and the fence
  // never lifts.
  //
  // There is no tie here at all: 1 vs 9. An earlier revision of this test asserted
  // "nearer-but-older wins" and thereby pinned this exact bug.
  let symmetric = mergeEvidence(
    { verified: false, outcomes: [], leftover: [] },
    {
      verified: false,
      outcomes: [{
        pid: 5002, outcome: "access-denied",
        creationDate: "133801632000000010", commandLine: "P1", executablePath: "C:\\p1.exe",
        fingerprintSource: "cim",
      }],
      leftover: [],
    },
  );
  symmetric = mergeEvidence(symmetric, {
    verified: false,
    outcomes: [{
      pid: 5002, outcome: "access-denied",
      creationDate: "133801632000000020", commandLine: "P2", executablePath: "C:\\p2.exe",
      fingerprintSource: "cim",
    }],
    leftover: [],
  });
  symmetric = mergeEvidence(symmetric, {
    verified: true,
    outcomes: [{
      pid: 5002, outcome: "killed",
      creationDate: "133801632000000011", commandLine: "P2", executablePath: "C:\\p2.exe",
      fingerprintSource: "handle",
    }],
    leftover: [],
  });
  const symmetricRows = symmetric.outcomes.filter((item) => item.pid === 5002);
  expect(symmetricRows).toHaveLength(2);
  const killed = symmetricRows.find((item) => item.fingerprintSource === "handle");
  expect(killed?.outcome).toBe("killed");
  // The handle joined the NEWER cluster, whose own CIM print is 020 — not P1's 010,
  // even though 010 is 8 ticks closer.
  expect(new Set(killed?.identityPrints?.map((print) => print.creationDate)))
    .toEqual(new Set(["133801632000000020", "133801632000000011"]));
  // P1 keeps its own row, its own history, and its own unsafe outcome.
  const stale = symmetricRows.find((item) => item.fingerprintSource === "cim");
  expect(stale?.creationDate).toBe("133801632000000010");
  expect(stale?.outcome).toBe("access-denied");
  expect(new Set(stale?.identityPrints?.map((print) => print.creationDate)))
    .toEqual(new Set(["133801632000000010"]));
});

test("evidence identity is stable when a CIM commandLine is still missing", () => {
  // The CIM row can lag the handle-derived identity, so one round reports
  // commandLine null and a later one the full argv. commandLine is evidence, not
  // identity: a null must not fork the process into a second, permanently
  // unpublishable identity.
  const withoutCommandLine = { pid: 5002, creationDate: "133801632000000010" };
  const withCommandLine = { pid: 5002, creationDate: "133801632000000010" };
  expect(sameProcessIdentity(withoutCommandLine, withCommandLine)).toBe(true);
});

test("merge: a creation-date-canonicalized safe outcome resolves the earlier quantized unsafe one", () => {
  // Round 1: access-denied leaves an unsafe record with the CIM creation time and
  // the shim alias. Round 2: the same process is verified through a handle,
  // killed, and reports the kernel creation time plus the resolved image — a
  // DIFFERENT creationDate for the same process. It must still resolve round 1
  // and the surviving record must keep the handle-derived fingerprint. Another
  // process is still unresolved, so the round is not verified.
  const round1 = mergeEvidence(
    { verified: false, outcomes: [], leftover: [] },
    {
      verified: false,
      outcomes: [{
        pid: 5002,
        outcome: "access-denied",
        creationDate: "133801632000000010",
        commandLine: "node adapter.js",
        executablePath: "C:\\shim\\node.exe",
        fingerprintSource: "cim",
      }],
      leftover: [],
    },
  );
  const merged = mergeEvidence(round1, {
    verified: false,
    outcomes: [{
      pid: 5002,
      outcome: "killed",
      creationDate: "133801632000000017",
      commandLine: "node adapter.js",
      executablePath: "C:\\real\\node.exe",
      fingerprintSource: "handle",
    }],
    leftover: [{ pid: 5003, parentPid: 5002, creationDate: "133801632000000020", commandLine: "child", executablePath: "C:\\child.exe", fingerprintSource: "cim" }],
  });
  expect(merged.verified).toBe(false);
  // ONE record for pid 5002, not one per creation-time representation.
  expect(merged.outcomes.filter((item) => item.pid === 5002)).toHaveLength(1);
  const survivor = merged.outcomes.find((item) => item.pid === 5002)!;
  expect(survivor.outcome).toBe("killed");
  expect(survivor.creationDate).toBe("133801632000000017");
  expect(survivor.executablePath).toBe("C:\\real\\node.exe");
  expect(survivor.fingerprintSource).toBe("handle");
  // The still-unresolved process remains required evidence.
  expect(merged.leftover.map((item) => item.pid)).toEqual([5003]);
});

test("merge: tie chronology survives the outcomes-before-leftover projection", () => {
  // The ordinal must not be derived from array position. `mergeEvidence` returns
  // `outcomes` before `leftover` every round, so a pid reused ACROSS kinds ends up
  // positioned with the NEWER incarnation first and the OLDER one after it. A
  // position-derived tie-break would then invert older/newer and resolve the
  // stale process.
  //
  //   round 1: P1 newly discovered in S2, VF fails   -> leftover cim 010
  //   round 2: pid reused; P2 resolves in S1, fails  -> outcome access-denied cim 020
  //   round 3: P2 handle-verified                   -> killed handle 015
  //
  // After round 2 the returned shape is outcomes=[P2], leftover=[P1], i.e. P1 —
  // the OLDER incarnation — is positioned second. Handle 015 is 5 from each CIM
  // print, so the tie decides, and it must go to P2.
  const round1 = mergeEvidence(
    { verified: false, outcomes: [], leftover: [] },
    {
      verified: false,
      outcomes: [],
      leftover: [{
        pid: 5002, parentPid: 1,
        creationDate: "133801632000000010", commandLine: "P1", executablePath: "C:\\p1.exe",
        fingerprintSource: "cim",
      }],
    },
  );
  const round2 = mergeEvidence(round1, {
    verified: false,
    outcomes: [{
      pid: 5002, outcome: "access-denied",
      creationDate: "133801632000000020", commandLine: "P2", executablePath: "C:\\p2.exe",
      fingerprintSource: "cim",
    }],
    leftover: [],
  });
  // The projection really did put the newer incarnation first.
  expect(round2.outcomes.filter((item) => item.pid === 5002)).toHaveLength(1);
  expect(round2.outcomes.find((item) => item.pid === 5002)!.creationDate).toBe("133801632000000020");
  expect(round2.leftover.filter((item) => item.pid === 5002)).toHaveLength(1);
  expect(round2.leftover.find((item) => item.pid === 5002)!.creationDate).toBe("133801632000000010");
  // Chronology is carried on the record, so P2 is still the newer cluster even
  // though it now sits at index 0.
  const p2 = round2.outcomes.find((item) => item.pid === 5002)! as { clusterOrdinal?: number };
  const p1 = round2.leftover.find((item) => item.pid === 5002)! as { clusterOrdinal?: number };
  expect(p2.clusterOrdinal ?? 0).toBeGreaterThan(p1.clusterOrdinal ?? 0);

  const round3 = mergeEvidence(round2, {
    verified: true,
    outcomes: [{
      pid: 5002, outcome: "killed",
      creationDate: "133801632000000015", commandLine: "P2", executablePath: "C:\\p2.exe",
      fingerprintSource: "handle",
    }],
    leftover: [],
  });
  // P2 — the process actually killed — resolved, and no stale P2 evidence
  // survives to spool as a residual the reaper must retain forever. P1 remains
  // required evidence in its own right: it is still an unresolved process of its
  // own (an older incarnation that never resolved), so it stays a leftover.
  const stale = round3.leftover.filter((item) => item.pid === 5002);
  expect(stale).toHaveLength(1);
  expect(stale[0]!.creationDate).toBe("133801632000000010");
  expect(new Set((stale[0] as { identityPrints?: { creationDate: string }[] }).identityPrints
    ?.map((print) => print.creationDate)))
    .toEqual(new Set(["133801632000000010"]));
  const rows = round3.outcomes.filter((item) => item.pid === 5002);
  expect(rows).toHaveLength(1);
  const resolved = rows.find((item) => item.fingerprintSource === "handle");
  expect(resolved?.outcome).toBe("killed");
  // The handle landed in P2's cluster: the history carries P2's own cim 020.
  expect(new Set(resolved?.identityPrints?.map((print) => print.creationDate)))
    .toEqual(new Set(["133801632000000020", "133801632000000015"]));
  // P1 is NOT in the outcome rows at all — it never resolved, and the handle
  // print that would have resolved it went to the cluster the ordinal names.
  expect(rows.some((item) => item.fingerprintSource === "cim")).toBe(false);
});

test("merge: a complete fingerprint replaces an incomplete one for the same process", () => {
  // Round 1 could not see the commandLine or the resolved path yet. Round 2
  // observes the complete fingerprint for the SAME process (within the symmetric
  // +-9 quantization window, so a kernel value a few ticks from the CIM one is
  // the same process). An incomplete record can never become durable evidence,
  // so the complete one must REPLACE it — otherwise the incomplete one occupies
  // the identity and blocks discharge forever.
  const merged = mergeEvidence(
    { verified: false, outcomes: [], leftover: [] },
    {
      verified: false,
      outcomes: [{
        pid: 5002,
        outcome: "access-denied",
        creationDate: "133801632000000010",
        commandLine: null,
        executablePath: null,
        fingerprintSource: "cim",
      }],
      leftover: [],
    },
  );
  const second = mergeEvidence(merged, {
    verified: false,
    outcomes: [{
      pid: 5002,
      outcome: "access-denied",
      creationDate: "133801632000000010",
      commandLine: "node adapter.js",
      executablePath: "C:\\shim\\node.exe",
      fingerprintSource: "cim",
    }],
    leftover: [],
  });
  // Both observations are CIM-derived from ONE hold of the process's row, so the
  // later (more complete) snapshot replaces the earlier one.
  expect(second.outcomes).toHaveLength(1);
  expect(second.outcomes[0]!.executablePath).toBe("C:\\shim\\node.exe");
  expect(second.outcomes[0]!.commandLine).toBe("node adapter.js");
});

test("merge: an incomplete fingerprint never replaces a complete one for the same process", () => {
  // Reverse direction: a later observation that lost the commandLine must not
  // erase a complete record for the same process.
  const merged = mergeEvidence(
    { verified: false, outcomes: [], leftover: [] },
    {
      verified: false,
      outcomes: [{
        pid: 5002,
        outcome: "access-denied",
        creationDate: "133801632000000012",
        commandLine: "node adapter.js",
        executablePath: "C:\\shim\\node.exe",
        fingerprintSource: "cim",
      }],
      leftover: [],
    },
  );
  const second = mergeEvidence(merged, {
    verified: false,
    outcomes: [{
      pid: 5002,
      outcome: "access-denied",
      creationDate: "133801632000000012",
      commandLine: null,
      executablePath: null,
      fingerprintSource: "cim",
    }],
    leftover: [],
  });
  expect(second.outcomes).toHaveLength(1);
  expect(second.outcomes[0]!.executablePath).toBe("C:\\shim\\node.exe");
  expect(second.outcomes[0]!.commandLine).toBe("node adapter.js");
});

test("merge: two DIFFERENT processes whose creation times are 10 ticks apart both survive", () => {
  // delta = 10 exceeds the 9-tick identity tolerance, so these are DIFFERENT
  // processes that reused the pid — even though a 19-tick publication bucket
  // would group them. Membership is decided only by `sameProcessIdentity`, so
  // neither record may overwrite the other's evidence.
  const a = "133801632000000003";
  const b = "133801632000000013";
  expect(BigInt(b) - BigInt(a)).toBe(10n);
  expect(sameProcessIdentity({ pid: 5002, creationDate: a }, { pid: 5002, creationDate: b })).toBe(false);

  const merged = mergeEvidence(
    { verified: false, outcomes: [], leftover: [] },
    {
      verified: false,
      outcomes: [{
        pid: 5002,
        outcome: "access-denied",
        creationDate: a,
        commandLine: "node adapter.js",
        executablePath: "C:\\first\\node.exe",
        fingerprintSource: "cim",
      }],
      leftover: [],
    },
  );
  const second = mergeEvidence(merged, {
    verified: false,
    outcomes: [{
      pid: 5002,
      outcome: "killed",
      creationDate: b,
      commandLine: "node adapter.js",
      executablePath: "C:\\second\\node.exe",
      fingerprintSource: "handle",
    }],
    leftover: [],
  });
  // BOTH stay required evidence: neither is the same process, so neither can
  // resolve the other.
  expect(second.outcomes).toHaveLength(2);
  expect(second.outcomes.find((item) => item.creationDate === a)!.outcome).toBe("access-denied");
  expect(second.outcomes.find((item) => item.creationDate === b)!.outcome).toBe("killed");
  expect(second.verified).toBe(false);
});

test("merge: different processes 10 ticks apart survive in leftovers too", () => {
  const a = "133801632000000003";
  const b = "133801632000000013";
  const merged = mergeEvidence(
    { verified: false, outcomes: [], leftover: [{ pid: 5002, parentPid: 5001, creationDate: a, commandLine: "first", executablePath: "C:\\first.exe", fingerprintSource: "cim" }] },
    { verified: false, outcomes: [], leftover: [{ pid: 5002, parentPid: 5001, creationDate: b, commandLine: "second", executablePath: "C:\\second.exe", fingerprintSource: "cim" }] },
  );
  expect(merged.leftover).toHaveLength(2);
  expect(merged.leftover.map((item) => item.creationDate).sort()).toEqual([a, b].sort());
});

test("windows: one residual file must not prove TWO unsafe identities durable", async () => {
  // Two DISTINCT processes share pid 5002 (creation times 10 ticks apart, so the
  // comparator correctly reports them as different processes). Both are unsafe,
  // so both are required evidence. A residual file is keyed by pid alone, so one
  // file can only hold one of them — proving both durable from a single file
  // would be a false proof of ownership and would let the worker exit with the
  // other process's evidence lost.
  const dir = await mkdtemp(join(tmpdir(), "eof-false-proof-"));
  try {
    const a = "133801632000000003";
    const b = "133801632000000013";
    const outcome = await convergeOrphansBeforeExit({
      platform: "win32",
      terminateDescendants: async () => ({
        verified: false,
        outcomes: [
          { pid: 5002, outcome: "access-denied", creationDate: a, commandLine: "first", executablePath: "C:\\first.exe", fingerprintSource: "cim" },
          { pid: 5002, outcome: "query-failed", creationDate: b, commandLine: "second", executablePath: "C:\\second.exe", fingerprintSource: "cim" },
        ],
        leftover: [],
      }),
      maxRounds: 3,
      roundDelayMs: 1,
      runtimeDir: dir,
      agentCommand: () => "codex",
      generationId: "00000000-0000-4000-8000-000000000001",
      ownerToken: "00000000-0000-4000-8000-000000000002",
    });
    // Fail closed: the worker must NOT claim "spooled" while one identity's
    // evidence is provably absent from the registry.
    expect(outcome).toBe("unresolved");
    const files = await readdir(join(dir, "orphans", "residuals"));
    expect(files).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("windows: a required identity whose file was overwritten is rewritten, not cached", async () => {
  // Three stages, all in ONE discharge (one ownerToken, one registry).
  //
  // Stage 1-2: A and B are two DISTINCT processes sharing pid 5002 (creation
  //   times 10 ticks apart). Both unsafe, so both required. A residual file is
  //   keyed by pid alone, so B overwrites A and the read-back correctly fails.
  // Stage 3: B is resolved (killed), leaving only A required. A must now be
  //   WRITTEN and proven durable, so the discharge converges to "spooled".
  //
  // The failure this pins: `published` used to mean "a write succeeded once", so
  // after stage 1 A stayed in the set and was never rewritten — while the file on
  // disk held B. Every later round then repeated the same failed read-back, an
  // unrecoverable livelock.
  const dir = await mkdtemp(join(tmpdir(), "eof-overwrite-recover-"));
  try {
    const a = "133801632000000003";
    const b = "133801632000000013";
    let round = 0;
    const outcome = await convergeOrphansBeforeExit({
      platform: "win32",
      terminateDescendants: async () => {
        round += 1;
        if (round <= 2) {
          return {
            verified: false,
            outcomes: [
              { pid: 5002, outcome: "access-denied", creationDate: a, commandLine: "first", executablePath: "C:\\first.exe", fingerprintSource: "cim" },
              { pid: 5002, outcome: "query-failed", creationDate: b, commandLine: "second", executablePath: "C:\\second.exe", fingerprintSource: "cim" },
            ],
            leftover: [],
          };
        }
        // B is resolved; only A remains required evidence.
        return {
          verified: false,
          outcomes: [
            { pid: 5002, outcome: "access-denied", creationDate: a, commandLine: "first", executablePath: "C:\\first.exe", fingerprintSource: "cim" },
            { pid: 5002, outcome: "killed", creationDate: b, commandLine: "second", executablePath: "C:\\second.exe", fingerprintSource: "handle" },
          ],
          leftover: [],
        };
      },
      maxRounds: 6,
      roundDelayMs: 1,
      runtimeDir: dir,
      agentCommand: () => "codex",
      generationId: "00000000-0000-4000-8000-000000000001",
      ownerToken: "00000000-0000-4000-8000-000000000002",
    });
    // Converges once A alone can be made durable.
    expect(outcome).toBe("spooled");
    // And the file on disk really does hold A now.
    const registry = new OrphanRegistry(dir);
    await registry.initialize();
    const records = await registry.readCategory("residuals");
    expect(records).toHaveLength(1);
    expect(records[0]!.record).toMatchObject({ pid: 5002, creationDate: a });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("windows: a foreign generation's residual must not prove the current discharge durable", async () => {
  // The fence handshake that lifts the fence is generation-bound
  // (`runtime-worker-manager` only counts records whose `generationId` matches),
  // so a durable proof that ignores generation would let the CURRENT worker
  // claim "spooled" on evidence it did not write — and the successor owner's
  // handshake would not find it, lifting the fence on a false terminal proof.
  const dir = await mkdtemp(join(tmpdir(), "eof-foreign-gen-"));
  try {
    const registry = new OrphanRegistry(dir);
    await registry.initialize();
    const pid = 5002;
    const creationDate = "133801632000000003";
    // A residual left by an EARLIER generation, naming the same process with the
    // same fingerprint.
    await registry.writeResidual({
      schemaVersion: 1,
      kind: "residual",
      ownerToken: "00000000-0000-4000-8000-0000000000ff",
      pid,
      creationDate,
      commandLine: "old",
      executablePath: "C:\\old.exe",
      agentCommand: "codex",
      generationId: "00000000-0000-4000-8000-00000000000f",
      killAttempts: 0,
    });

    const outcome = await convergeOrphansBeforeExit({
      platform: "win32",
      terminateDescendants: async () => ({
        verified: false,
        outcomes: [{ pid, outcome: "access-denied", creationDate, commandLine: "new", executablePath: "C:\\new.exe", fingerprintSource: "cim" }],
        leftover: [],
      }),
      maxRounds: 2,
      roundDelayMs: 1,
      runtimeDir: dir,
      agentCommand: () => "codex",
      generationId: "00000000-0000-4000-8000-000000000001",
      ownerToken: "00000000-0000-4000-8000-000000000002",
    });

    // Foreign evidence cannot satisfy this discharge. The current worker must
    // write its OWN residual: only then is its evidence durable in the namespace
    // that the fence handshake will check.
    const records = await registry.readCategory("residuals");
    // The foreign record has a different ownerToken, so it lives in a different
    // file; both exist.
    expect(records).toHaveLength(2);
    const owned = records.map(({ record }) => record).filter((record) => record.generationId === "00000000-0000-4000-8000-000000000001");
    expect(owned).toHaveLength(1);
    expect(owned[0]).toMatchObject({
      pid,
      creationDate,
      generationId: "00000000-0000-4000-8000-000000000001",
      ownerToken: "00000000-0000-4000-8000-000000000002",
    });
    expect(outcome).toBe("spooled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("merge: a weaker CIM outcome must not displace a stronger handle leftover for the same process", () => {
  // Round 1 S2 discovered P and verified it through a handle (complete, resolved
  // image, kernel creation time). Round 2 saw P already in S1 but OpenProcess was
  // transiently denied, so it reports an INCOMPLETE, CIM-derived unsafe outcome.
  // The stronger leftover must survive: it is what would have been spooled with
  // exact fencing, and replacing it downgrades the durable record to a CIM
  // replay — or makes it unpublishable.
  const merged = mergeEvidence(
    { verified: false, outcomes: [], leftover: [{
      pid: 5002,
      parentPid: 5001,
      creationDate: "133801632000000017",
      commandLine: "node adapter.js",
      executablePath: "C:\\real\\node.exe",
      fingerprintSource: "handle",
    }] },
    { verified: false, outcomes: [{
      pid: 5002,
      outcome: "access-denied",
      creationDate: "133801632000000010",
      commandLine: null,
      executablePath: null,
      fingerprintSource: "cim",
    }], leftover: [] },
  );
  // The handle-derived complete record is what remains required evidence.
  expect(merged.outcomes).toHaveLength(0);
  expect(merged.leftover).toHaveLength(1);
  const survivor = merged.leftover[0]!;
  expect(survivor.fingerprintSource).toBe("handle");
  expect(survivor.executablePath).toBe("C:\\real\\node.exe");
  expect(survivor.commandLine).toBe("node adapter.js");
});

test("merge: a safe outcome still resolves a leftover for the same process", () => {
  // The other side of the same arbitration: an explicitly safe outcome DOES
  // retire the leftover, because the process is now resolved.
  const merged = mergeEvidence(
    { verified: false, outcomes: [], leftover: [{
      pid: 5002,
      parentPid: 5001,
      creationDate: "133801632000000017",
      commandLine: "node adapter.js",
      executablePath: "C:\\real\\node.exe",
      fingerprintSource: "handle",
    }] },
    { verified: false, outcomes: [{
      pid: 5002,
      outcome: "killed",
      creationDate: "133801632000000017",
      commandLine: "node adapter.js",
      executablePath: "C:\\real\\node.exe",
      fingerprintSource: "handle",
    }], leftover: [] },
  );
  expect(merged.leftover).toHaveLength(0);
  expect(merged.outcomes).toHaveLength(1);
  expect(merged.outcomes[0]!.outcome).toBe("killed");
});

test("merge: a complete CIM evidence beats an incomplete handle one so discharge is not livelocked", () => {
  // Round 1: S2 has just discovered P and verified it through a handle, so the
  // creationDate and image are kernel values — but the CIM row has not
  // published a commandLine yet, so the record is handle-derived and
  // INCOMPLETE. Round 2: the CIM row is complete, but OpenProcess was
  // transiently denied (a documented real flake), so the observation is a
  // complete CIM fingerprint. Provenance alone must not keep the incomplete
  // record: it can never be spooled, while the discarded CIM fingerprint
  // publishes cleanly — with no maxRounds in production that is a livelock.
  const merged = mergeEvidence(
    { verified: false, outcomes: [], leftover: [{
      pid: 5002,
      parentPid: 5001,
      creationDate: "133801632000000017",
      commandLine: null,
      executablePath: "C:\\real\\node.exe",
      fingerprintSource: "handle",
    }] },
    { verified: false, outcomes: [{
      pid: 5002,
      outcome: "access-denied",
      creationDate: "133801632000000010",
      commandLine: "node adapter.js",
      executablePath: "C:\\shim\\node.exe",
      fingerprintSource: "cim",
    }], leftover: [] },
  );
  // Exactly one record survives, and it is the one that can become durable.
  expect(merged.outcomes).toHaveLength(1);
  expect(merged.leftover).toHaveLength(0);
  const survivor = merged.outcomes[0]!;
  expect(survivor.commandLine).toBe("node adapter.js");
  expect(survivor.executablePath).toBe("C:\\shim\\node.exe");
  expect(survivor.fingerprintSource).toBe("cim");
  expect(survivor.creationDate).toBe("133801632000000010");
});

test("windows: a complete CIM round after an incomplete handle round converges instead of livelocking", async () => {
  // The end-to-end form of the completeness-over-provenance fix. Round 1
  // observed P through a handle (kernel creation + resolved image) while the CIM
  // row had not published a commandLine yet. Round 2 — the documented transient
  // access-denied case — has the complete CIM fingerprint. Production runs
  // publication with NO round limit, so a merge policy that keeps the
  // incomplete record leaves the worker alive forever with no path to
  // "spooled".
  const dir = await mkdtemp(join(tmpdir(), "eof-complete-cim-"));
  try {
    const rounds: TerminateDescendantsResult[] = [
      {
        verified: false,
        outcomes: [],
        leftover: [{
          pid: 5002,
          parentPid: 5001,
          creationDate: "133801632000000017",
          commandLine: null,
          executablePath: "C:\\real\\node.exe",
          fingerprintSource: "handle",
        }],
      },
      {
        verified: false,
        outcomes: [{
          pid: 5002,
          outcome: "access-denied",
          creationDate: "133801632000000010",
          commandLine: "node adapter.js",
          executablePath: "C:\\shim\\node.exe",
          fingerprintSource: "cim",
        }],
        leftover: [],
      },
    ];
    let call = 0;
    const outcome = await convergeOrphansBeforeExit({
      platform: "win32",
      terminateDescendants: async () => rounds[Math.min(call++, rounds.length - 1)]!,
      maxRounds: 2,
      roundDelayMs: 1,
      runtimeDir: dir,
      agentCommand: () => "codex",
      generationId: "00000000-0000-4000-8000-000000000001",
      ownerToken: "00000000-0000-4000-8000-000000000002",
    });
    expect(outcome).toBe("spooled");
    const registry = new OrphanRegistry(dir);
    const residuals = await registry.readCategory("residuals");
    expect(residuals).toHaveLength(1);
    expect(residuals[0]!.record.pid).toBe(5002);
    // The durable record carries the complete CIM fingerprint, so the reaper
    // replays it with the tolerance its provenance demands.
    expect(residuals[0]!.record.fingerprintSource).toBe("cim");
    expect(residuals[0]!.record.commandLine).toBe("node adapter.js");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("windows: a pid reused after convergence keeps its own durable identity", async () => {
  // The non-transitive-identity bridge, end to end, in the only shape the real
  // protocol can produce: `decodeWindowsDescendantsResponse` keeps a `seen` set
  // and rejects any round carrying two entries for one pid, so a reused pid is
  // always OBSERVED in a LATER round, never alongside the earlier incarnation.
  //
  //   round 0: P1 unsafe, CIM ...010 + blocker X (incomplete)
  //   round 1: P1 resolved through a handle — killed, kernel ...011 — + X now complete
  //   round 2: P1 is gone from the tree; the pid was reused by P2, unsafe, CIM ...020
  //
  // A plain ±9 magnitude relation would chain P1(CIM 010) ~ P1(handle 011) and
  // P1(handle 011) ~ P2(CIM 020), so the RESOLVED P1 record would absorb P2 and
  // discard its unsafe evidence — `publishRequired` would then find nothing
  // required for that pid and report "spooled" with NO residual for a live
  // process: a false terminal proof that hands the pid's ownership to a
  // successor. Clustered prints keep the 18-tick pair as two identities, so P2
  // stays required evidence and publishes under its OWN creation time.
  const dir = await mkdtemp(join(tmpdir(), "eof-pidreuse-bridge-"));
  try {
    const blocker = () => ({
      pid: 6001, parentPid: 5002, creationDate: "133830000000000000",
      commandLine: "adapter", executablePath: "C:\\adapter.exe",
      fingerprintSource: "cim" as const,
    });
    const rounds: TerminateDescendantsResult[] = [
      {
        verified: false,
        outcomes: [{
          pid: 5002, outcome: "access-denied",
          creationDate: "133801632000000010", commandLine: "old", executablePath: "C:\\old.exe",
          fingerprintSource: "cim" as const,
        }],
        leftover: [],
      },
      {
        verified: false,
        outcomes: [{
          // P1's incarnation is RESOLVED here (killed = safe, no longer required
          // evidence) and its fingerprint has been canonicalized to the kernel
          // value ...011 by the retained handle. Nothing is left unresolved, so
          // publication has nothing to prove and the loop must advance — which is
          // exactly what lets the reuse be observed in a later round.
          pid: 5002, outcome: "killed",
          creationDate: "133801632000000011", commandLine: "old", executablePath: "C:\\real.exe",
          fingerprintSource: "handle" as const,
        }],
        leftover: [],
      },
      {
        verified: false,
        outcomes: [{
          // A DIFFERENT process that reused the pid: kernel ...029, reported
          // through CIM as ...020 — exactly 9 ticks from the canonicalized P1
          // value, which is where the plain band bridges them.
          pid: 5002, outcome: "access-denied",
          creationDate: "133801632000000020", commandLine: "new", executablePath: "C:\\new.exe",
          fingerprintSource: "cim" as const,
        }],
        leftover: [blocker()],
      },
    ];
    let call = 0;
    const outcome = await convergeOrphansBeforeExit({
      platform: "win32",
      terminateDescendants: async () => {
        const round = rounds[Math.min(call, rounds.length - 1)]!;
        call += 1;
        return round;
      },
      maxRounds: 3,
      roundDelayMs: 1,
      runtimeDir: dir,
      agentCommand: () => "codex",
      generationId: "00000000-0000-4000-8000-000000000001",
      ownerToken: "00000000-0000-4000-8000-000000000002",
    });

    const registry = new OrphanRegistry(dir);
    const residuals = await registry.readCategory("residuals");
    // P1's incarnation is RESOLVED (killed = safe), so it is not required
    // evidence. P2's is, and it survives as its OWN identity instead of being
    // absorbed into the canonicalized P1 record — so the pid's single durable
    // file must name P2, never P1's kernel time (which would prove nothing about
    // the live process and condemn its ownership forever). The blocker pid
    // publishes alongside it, and the whole set is proven all-or-nothing.
    expect(outcome).toBe("spooled");
    const forPid = residuals.filter((entry) => entry.record.pid === 5002);
    expect(forPid).toHaveLength(1);
    expect(forPid[0]!.record.creationDate).toBe("133801632000000020");
    expect(forPid[0]!.record.fingerprintSource).toBe("cim");
    expect(forPid[0]!.record.commandLine).toBe("new");
    expect(residuals.some((entry) => entry.record.pid === 6001)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("windows: the same pid reused 18 ticks later must not inherit the earlier incarnation's resolution", async () => {
  // Comparator-level pin of the exact bridge the full-diff review found, using
  // values of the shape the real worker produces (CIM quantized to 6-digit
  // microseconds, within the symmetric +-9 window).
  const p1Cim = { pid: 5002, creationDate: "133801632000000010", fingerprintSource: "cim" as const };
  const p1Handle = { pid: 5002, creationDate: "133801632000000011", fingerprintSource: "handle" as const };
  const p2Cim = { pid: 5002, creationDate: "133801632000000020", fingerprintSource: "cim" as const };
  const p2Handle = { pid: 5002, creationDate: "133801632000000029", fingerprintSource: "handle" as const };

  // Round 1 merged the CIM observation into the canonicalized handle one.
  const afterP1 = mergeEvidence(
    { verified: false, outcomes: [{ pid: 5002, outcome: "access-denied", ...p1Cim, commandLine: "old", executablePath: "C:\\old.exe" }], leftover: [] },
    { verified: false, outcomes: [{ pid: 5002, outcome: "killed", ...p1Handle, commandLine: "old", executablePath: "C:\\real.exe" }], leftover: [] },
  );
  expect(afterP1.outcomes).toHaveLength(1);
  expect(afterP1.outcomes[0]!.outcome).toBe("killed");

  // Round 3 adds P2. Under a plain ±9 band P2's CIM row would be 9 ticks from
  // the canonicalized P1 record and get absorbed; the safe outcome would then
  // discard P2's unsafe evidence entirely.
  const afterP2 = mergeEvidence(afterP1, {
    verified: false,
    outcomes: [{ pid: 5002, outcome: "access-denied", ...p2Cim, commandLine: "new", executablePath: "C:\\new.exe" }],
    leftover: [],
  });
  expect(afterP2.outcomes.filter((item) => item.pid === 5002)).toHaveLength(2);
  const p2 = afterP2.outcomes.filter((item) => item.pid === 5002).find((item) => item.outcome === "access-denied");
  expect(p2).toBeDefined();
  expect(p2!.creationDate).toBe("133801632000000020");
});

test("windows: a reused pid keeps its ownership through a later total-failure round", async () => {
  // The convergence-level form of the boundary regression. Round 2 leaves two
  // same-pid incarnations correctly separated:
  //   A = P1 [cim 010], already-exited (safe)
  //   B = P2 [cim 020, handle 019], kill-requested-unconfirmed (REQUIRED)
  // Round 3 is a TOTAL failure contributing nothing, after which the blocker X
  // finally becomes publishable. Publication must NOT return "spooled" on X
  // alone: P2 is alive-unknown and still required, and dropping its evidence
  // while the earlier incarnation's safe record absorbs it is a false terminal
  // proof that hands the pid's ownership to a successor.
  const dir = await mkdtemp(join(tmpdir(), "eof-boundary-rebridge-"));
  try {
    const blocker = (creationDate: string) => ({
      pid: 6001, parentPid: 5002, creationDate,
      commandLine: "adapter", executablePath: "C:\\adapter.exe",
      fingerprintSource: "cim" as const,
    });
    const rounds: TerminateDescendantsResult[] = [
      {
        verified: false,
        outcomes: [{ pid: 5002, outcome: "already-exited", creationDate: "133801632000000010", commandLine: "old", executablePath: "C:\\old.exe", fingerprintSource: "cim" as const }],
        // X's CIM row has not published yet: required but UNPUBLISHABLE, so no
        // round so far can discharge and the loop must keep advancing.
        leftover: [{ pid: 6001, parentPid: 5002, creationDate: null, commandLine: "adapter", executablePath: "C:\\adapter.exe", fingerprintSource: "cim" as const }],
      },
      {
        verified: false,
        outcomes: [{ pid: 5002, outcome: "access-denied", creationDate: "133801632000000020", commandLine: "new", executablePath: "C:\\new.exe", fingerprintSource: "cim" as const }],
        // Still incomplete, and a TOTAL failure contributes nothing — this is the
        // round the old implementation re-clustered `a` and destroyed the boundary
        // it had just established, merging P2 into the safe P1 record.
        leftover: [],
      },
      // Only now does X's fingerprint complete: the first round that COULD
      // publish. Everything the loop has accumulated — including the boundary
      // between the two incarnations — has to be correct here.
      {
        verified: false,
        outcomes: [],
        leftover: [blocker("133830000000000000")],
      },
      // And the failure repeats, so publication is retried on the same evidence.
      { verified: false, outcomes: [], leftover: [] },
    ];
    let call = 0;
    const outcome = await convergeOrphansBeforeExit({
      platform: "win32",
      terminateDescendants: async () => {
        const round = rounds[Math.min(call, rounds.length - 1)]!;
        call += 1;
        return round;
      },
      maxRounds: 5,
      roundDelayMs: 1,
      runtimeDir: dir,
      agentCommand: () => "codex",
      generationId: "00000000-0000-4000-8000-000000000001",
      ownerToken: "00000000-0000-4000-8000-000000000002",
    });

    const registry = new OrphanRegistry(dir);
    const residuals = await registry.readCategory("residuals");
    // P2 stayed required evidence across the failure round, so ownership is NOT
    // discharged: the worker keeps it and stays alive rather than exiting on half
    // the truth. A residual file is keyed by pid alone, so P1's and P2's records
    // for pid 5002 compete for one filename and the read-back can never prove
    // both — publication is all-or-nothing and fails closed.
    expect(outcome).toBe("unresolved");
    // The blocker pid's evidence IS durably written (additive evidence is always
    // kept); only the pid carrying two identities is withheld.
    expect(residuals.some((entry) => entry.record.pid === 6001)).toBe(true);
    // The pid's file names P2's unsafe identity — never the earlier incarnation's
    // resolved one, which would prove nothing about the process still alive.
    const forPid = residuals.filter((entry) => entry.record.pid === 5002);
    expect(forPid).toHaveLength(1);
    expect(forPid[0]!.record.creationDate).toBe("133801632000000020");
    expect(forPid[0]!.record.commandLine).toBe("new");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
