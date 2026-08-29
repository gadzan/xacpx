import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RuntimeWorkerFence,
  dischargeRuntimeWorkerFence,
  recoverDeadWorkerSubtree,
  type RuntimeWorkerFenceRecord,
} from "../../../../../src/bridge/engine/runtime/runtime-worker-fence";
import { RuntimeWorkerManager } from "../../../../../src/bridge/engine/runtime/runtime-worker-manager";

const KEY = "session-A";

function record(overrides: Partial<RuntimeWorkerFenceRecord> = {}): RuntimeWorkerFenceRecord {
  return {
    kind: "runtime-worker-owner",
    logicalSessionId: KEY,
    generation: "gen-1",
    pid: 4242,
    creationDate: null,
    bootstrapVerified: false,
    phase: "owned",
    startedAt: new Date().toISOString(),
    agent: "runtime-worker",
    ...overrides,
  };
}

/** Spawns a detached long-lived process that is its own group leader (POSIX).
 *  The 150ms settle is a real OS-process start wait — no fake timer can stand in. */
async function spawnStubborn(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: process.platform !== "win32",
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  return child;
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
}

test("fence store: atomic write/read roundtrip and remove", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-store-"));
  try {
    const fence = new RuntimeWorkerFence(dir);
    expect(await fence.read(KEY)).toEqual({ kind: "absent" });
    await fence.write(record({ pid: 777 }));
    const read = await fence.read(KEY);
    expect(read.kind).toBe("present");
    if (read.kind === "present") {
      expect(read.record.pid).toBe(777);
      expect(read.record.kind).toBe("runtime-worker-owner");
      expect(read.record.phase).toBe("owned");
    }
    await fence.remove(KEY);
    expect(await fence.read(KEY)).toEqual({ kind: "absent" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fence retire: unlink failure persists the discharged phase, never bricks (round 31 High)", async () => {
  if (process.platform === "win32") return; // POSIX read-only dir semantics
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-retire-"));
  try {
    const fence = new RuntimeWorkerFence(dir);
    await fence.write(record({ phase: "admitted", creationDate: "133800000000000000", bootstrapVerified: true }));
    // Read-only directory: BOTH unlink and the durable rewrite fail —
    // retire must THROW (fail closed), never silently swallow.
    await chmod(dir, 0o555);
    await expect(fence.retire(KEY)).rejects.toThrow();
    await chmod(dir, 0o755);
    // The record survived untouched (still admitted) — and retiring over it
    // now succeeds cleanly.
    expect((await fence.read(KEY)).kind).toBe("present");
    await fence.retire(KEY);
    expect(await fence.read(KEY)).toEqual({ kind: "absent" });
  } finally {
    await chmod(dir, 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("discharge phase table: discharged terminal proof discharges (round 31 Blocking 3 case A)", async () => {
  // The old worker finished EOF convergence and marked the fence BEFORE
  // exiting — the new Host trusts the durable verdict; no kill, no brick.
  let killed = 0;
  const outcome = await dischargeRuntimeWorkerFence(
    record({ pid: 4242, phase: "discharged", creationDate: "133800000000000000", bootstrapVerified: true }),
    {
      platform: "win32",
      terminateDescendants: async () => {
        killed += 1;
        return { verified: true, outcomes: [], leftover: [] };
      },
    },
  );
  expect(outcome).toBe("discharged");
  expect(killed).toBe(0);
});

test("discharge phase table: spooled refuses until the reaper converges residuals", async () => {
  let killed = 0;
  const outcome = await dischargeRuntimeWorkerFence(
    record({ pid: 4242, phase: "spooled", creationDate: "133800000000000000", bootstrapVerified: true }),
    {
      platform: "win32",
      terminateDescendants: async () => {
        killed += 1;
        return { verified: true, outcomes: [], leftover: [] };
      },
    },
  );
  expect(outcome).toBe("refused");
  expect(killed).toBe(0);
});

test("discharge phase table: discharging waits for the worker's own terminal verdict (round 31 Blocking 2)", async () => {
  // H1 crashed while an ensure was in flight; the worker marked "discharging"
  // and H2 must WAIT — the gated kill must not fire while the fence can still
  // reach a terminal phase.
  const reads = ["discharging", "discharging", "discharged"];
  let readCalls = 0;
  let killed = 0;
  const outcome = await dischargeRuntimeWorkerFence(
    record({ pid: 4242, phase: "discharging", creationDate: "133800000000000000", bootstrapVerified: true }),
    {
      platform: "win32",
      terminateDescendants: async () => {
        killed += 1;
        return { verified: true, outcomes: [], leftover: [] };
      },
      readBack: async () => {
        const phase = reads[Math.min(readCalls, reads.length - 1)]!;
        readCalls += 1;
        return { kind: "present", record: record({ pid: 4242, phase, creationDate: "133800000000000000", bootstrapVerified: true }) };
      },
      waitMs: async () => {},
      now: (() => {
        let tick = 0;
        return () => tick++ * 400;
      })(),
      selfDischargeWaitMs: 90_000,
    },
  );
  expect(outcome).toBe("discharged");
  expect(killed).toBe(0);
});

test("discharge phase table: discharging that never settles refuses — no kill against an undecided owner", async () => {
  let killed = 0;
  const outcome = await dischargeRuntimeWorkerFence(
    record({ pid: 4242, phase: "discharging", creationDate: "133800000000000000", bootstrapVerified: true }),
    {
      platform: "win32",
      terminateDescendants: async () => {
        killed += 1;
        return { verified: true, outcomes: [], leftover: [] };
      },
      readBack: async () => ({ kind: "present", record: record({ pid: 4242, phase: "discharging", creationDate: "133800000000000000", bootstrapVerified: true }) }),
      waitMs: async () => {},
      now: (() => {
        let tick = 0;
        return () => tick++ * 60_000;
      })(),
      selfDischargeWaitMs: 90_000,
    },
  );
  expect(outcome).toBe("refused");
  expect(killed).toBe(0);
});

test("discharge phase table: admitted + live root past the wait window REFUSES — H2 never kills an un-quiesced worker (round 32 Blocking 2)", async () => {
  // Parent-identity stability is NOT descendant-set quiescence: an ensure
  // blocked before its child spawn could still release after H2's snapshot.
  // The ONLY safe answer for a live root without a terminal phase is refuse.
  let killed = 0;
  const outcome = await dischargeRuntimeWorkerFence(
    record({ pid: 4242, phase: "admitted", creationDate: "133800000000000000", bootstrapVerified: true }),
    {
      platform: "win32",
      terminateDescendants: async () => {
        killed += 1;
        return { verified: true, outcomes: [], leftover: [] };
      },
      readBack: async () => ({ kind: "present", record: record({ pid: 4242, phase: "admitted", creationDate: "133800000000000000", bootstrapVerified: true }) }),
      waitMs: async () => {},
      now: (() => {
        let tick = 0;
        return () => tick++ * 100_000;
      })(),
      selfDischargeWaitMs: 90_000,
    },
  );
  expect(outcome).toBe("refused");
  expect(killed).toBe(0);
});

test("dead-root orphan recovery: gate pass converges the subtree and lifts the fence (round 32 Blocking 1)", async () => {
  // The worker SIGKILLed without EOF: the spawner is provably gone, so the
  // recovery kill IS safe. Verified result → durable discharged phase.
  let seenPid = 0;
  let seenDate = "";
  let marked: RuntimeWorkerFenceRecord | undefined;
  const outcome = await recoverDeadWorkerSubtree(
    record({ pid: 4242, phase: "admitted", creationDate: "133800000000000000", bootstrapVerified: true }),
    {
      platform: "win32",
      terminateDescendants: async (parentPid, expectedCreationDate) => {
        seenPid = parentPid;
        seenDate = expectedCreationDate;
        return { verified: true, outcomes: [], leftover: [] };
      },
      markDischarged: async (current) => {
        marked = current;
      },
    },
  );
  expect(outcome).toBe("discharged");
  expect(seenPid).toBe(4242);
  expect(seenDate).toBe("133800000000000000");
  expect(marked?.phase).toBe("discharged");
});

test("dead-root orphan recovery: gate failure refuses and never marks", async () => {
  let marked: RuntimeWorkerFenceRecord | undefined;
  const outcome = await recoverDeadWorkerSubtree(
    record({ pid: 4242, phase: "admitted", creationDate: "133800000000000000", bootstrapVerified: true }),
    {
      platform: "win32",
      terminateDescendants: async () => ({ verified: false, outcomes: [], leftover: [] }),
      markDischarged: async (current) => {
        marked = current;
      },
    },
  );
  expect(outcome).toBe("refused");
  expect(marked).toBeUndefined();
});

test("spool handshake: pending residuals refuse; an emptied namespace lifts the fence (round 32 Blocking 3)", async () => {
  let pending = true;
  let marked: RuntimeWorkerFenceRecord | undefined;
  const refused = await dischargeRuntimeWorkerFence(
    record({ pid: 4242, phase: "spooled", creationDate: "133800000000000000", bootstrapVerified: true, generation: "gen-spool" }),
    { platform: "win32", spooledResidualsRemaining: async () => pending },
  );
  expect(refused).toBe("refused");
  pending = false;
  const lifted = await dischargeRuntimeWorkerFence(
    record({ pid: 4242, phase: "spooled", creationDate: "133800000000000000", bootstrapVerified: true, generation: "gen-spool" }),
    {
      platform: "win32",
      spooledResidualsRemaining: async () => pending,
      markDischarged: async (current) => {
        marked = current;
      },
    },
  );
  expect(lifted).toBe("discharged");
  expect(marked?.generation).toBe("gen-spool");
});

test("fence store: corrupt JSON is UNREADABLE, never absent (round 30 Blocking 1)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-corrupt-"));
  try {
    const fence = new RuntimeWorkerFence(dir);
    await fence.write(record());
    const path = join(dir, `${encodeURIComponent(KEY)}.json`);
    await writeFile(path, "{ this is not json");
    const read = await fence.read(KEY);
    expect(read.kind).toBe("unreadable");
    if (read.kind === "unreadable") expect(read.reason).toContain("corrupt");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fence store: foreign schema / key mismatch is UNREADABLE (round 30 Blocking 1)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-schema-"));
  try {
    const fence = new RuntimeWorkerFence(dir);
    const path = join(dir, `${encodeURIComponent(KEY)}.json`);
    await writeFile(path, JSON.stringify({ kind: "something-else", pid: 1 }));
    expect((await fence.read(KEY)).kind).toBe("unreadable");
    await writeFile(path, JSON.stringify({ ...record(), logicalSessionId: "OTHER" }));
    expect((await fence.read(KEY)).kind).toBe("unreadable");
    await writeFile(path, JSON.stringify({ ...record(), pid: -5 }));
    expect((await fence.read(KEY)).kind).toBe("unreadable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fence store: unreadable I/O (EACCES) is UNREADABLE, never absent (round 30 Blocking 1)", async () => {
  if (process.platform === "win32") return; // POSIX permission model only
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-eacces-"));
  try {
    const fence = new RuntimeWorkerFence(dir);
    await fence.write(record());
    await chmod(join(dir, `${encodeURIComponent(KEY)}.json`), 0o000);
    const read = await fence.read(KEY);
    // Running as root would bypass the mode bits — only assert when it bit.
    if (read.kind === "unreadable") expect(read.reason).toBeTruthy();
    else expect(process.getuid?.()).toBe(0);
  } finally {
    await chmod(join(dir, `${encodeURIComponent(KEY)}.json`), 0o644).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("manager acquire: corrupt fence refuses the spawn with zero workers (round 30 Blocking 1)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-corrupt-mgr-"));
  const fenceDir = join(dir, "worker-fences");
  try {
    const entry = join(dir, "fake-worker.mjs");
    await writeFile(entry, "process.stdin.on('data', () => {});");
    const fence = new RuntimeWorkerFence(fenceDir);
    await fence.write(record({ pid: 999 }));
    await writeFile(join(fenceDir, `${encodeURIComponent(KEY)}.json`), "CORRUPT-{");
    const manager = new RuntimeWorkerManager({ entryPath: entry, fenceDir });
    await expect(manager.acquire(KEY)).rejects.toThrow(/UNREADABLE/);
    expect(manager.get(KEY)).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("fence discharge (POSIX): live group is NEVER killed externally — wait window then refuse (round 32 Blocking 4)", async () => {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-posix-"));
  const stubborn = await spawnStubborn();
  try {
    // A bare historical PGID is not a kill authority (pid/PGID reuse): H2
    // only waits for the worker's own exit, then refuses. The unrelated-looking
    // group MUST survive the discharge attempt untouched.
    const outcome = await dischargeRuntimeWorkerFence(record({ pid: stubborn.pid! }), {
      selfDischargeWaitMs: 400,
      waitMs: async () => {},
      now: (() => {
        let tick = 0;
        return () => tick++ * 500;
      })(),
    });
    expect(outcome).toBe("refused");
    expect(() => process.kill(stubborn.pid!, 0)).not.toThrow();
  } finally {
    stubborn.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("fence discharge (POSIX): a live group that EXITS during the wait discharges without a kill", async () => {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-posix-self-"));
  const stubborn = await spawnStubborn();
  try {
    // The old worker is the quiescence authority: it exits on its own (EOF
    // convergence) and H2 observes gone — the self-discharge handoff.
    setTimeout(() => stubborn.kill("SIGKILL"), 150);
    const outcome = await dischargeRuntimeWorkerFence(record({ pid: stubborn.pid! }), {
      selfDischargeWaitMs: 30_000,
    });
    expect(outcome).toBe("discharged");
    await exited(stubborn);
  } finally {
    stubborn.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("fence discharge (POSIX): dead group discharges without a kill", async () => {
  const outcome = await dischargeRuntimeWorkerFence(record(), {
    platform: "darwin",
    isProcessGroupAlive: () => false,
  });
  expect(outcome).toBe("discharged");
});

test("fence discharge (POSIX): unknown liveness refuses immediately — no kill on unverifiable evidence", async () => {
  let kills = 0;
  const outcome = await dischargeRuntimeWorkerFence(record(), {
    platform: "darwin",
    probeProcessGroup: () => "unknown",
    killGroup: () => {
      kills += 1;
    },
    selfDischargeWaitMs: 0,
  });
  expect(outcome).toBe("refused");
  expect(kills).toBe(0);
});

test("fence discharge (POSIX): EPERM on the liveness probe is UNKNOWN — refused, never discharged (round 31 Blocking 4)", async () => {
  // signal 0 failing with EPERM means "cannot verify", which is neither
  // alive nor gone: discharging here would upgrade unreadable ownership
  // evidence into a second-owner spawn.
  let kills = 0;
  const outcome = await dischargeRuntimeWorkerFence(record(), {
    platform: "darwin",
    probeProcessGroup: () => "unknown",
    killGroup: () => {
      kills += 1;
    },
  });
  expect(outcome).toBe("refused");
  expect(kills).toBe(0);
});

test("fence discharge (POSIX): ESRCH is the ONLY proof of a gone group", async () => {
  const gone = await dischargeRuntimeWorkerFence(record(), {
    platform: "darwin",
    probeProcessGroup: () => "gone",
  });
  expect(gone).toBe("discharged");
});

test("fence discharge (Windows): never-verified worker could not have adapters — discharged", async () => {
  // Round 30 Blocking 2 makes this a hard invariant: the durable admission
  // barrier means a never-verified fence cannot have entered a business RPC.
  let terminated = 0;
  const outcome = await dischargeRuntimeWorkerFence(record({ bootstrapVerified: false, creationDate: null }), {
    platform: "win32",
    terminateDescendants: async () => {
      terminated += 1;
      return { verified: true, outcomes: [], leftover: [] };
    },
  });
  expect(outcome).toBe("discharged");
  expect(terminated).toBe(0);
});

async function withFakeWorker(entry: string): Promise<void> {
  await writeFile(
    entry,
    [
      "let buffer='';",
      "process.stdin.on('data', (d) => {",
      "  buffer += d.toString();",
      "  let idx;",
      "  while ((idx = buffer.indexOf('\\n')) >= 0) {",
      "    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);",
      "    if (!line) continue;",
      "    try { const msg = JSON.parse(line);",
      "      process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
      "      if (msg.method === 'shutdown') process.exit(0);",
      "    } catch {}",
      "  }",
      "});",
    ].join("\n"),
  );
}

test("host restart: a LIVE orphan group is never killed by H2 — refuse first, recover after self-exit (round 32 Blocking 2/4)", async () => {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-restart-"));
  const fenceDir = join(dir, "worker-fences");
  const orphan = await spawnStubborn();
  const fence = new RuntimeWorkerFence(fenceDir);
  await fence.write(record({ pid: orphan.pid!, bootstrapVerified: true }));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    const manager = new RuntimeWorkerManager({ entryPath: entry, fenceDir, clientDeps: { selfDischargeWaitMs: 600 } });
    // While the old worker's group is ALIVE, H2 refuses — a bare PGID is not
    // a kill authority, and the old worker owns quiescence.
    await expect(manager.acquire(KEY)).rejects.toThrow(/durable ownership fence/);
    expect(() => process.kill(orphan.pid!, 0)).not.toThrow();
    expect(manager.get(KEY)).toBeUndefined();
    // The worker's own exit (the real EOF self-discharge analogue) is what
    // releases the session — then the very next acquire spawns a NEW owner
    // under a FRESH fence.
    orphan.kill("SIGKILL");
    await exited(orphan);
    const worker = await manager.acquire(KEY);
    expect(worker.ref.pid).not.toBe(orphan.pid);
    const refenced = await fence.read(KEY);
    expect(refenced.kind).toBe("present");
    if (refenced.kind === "present") expect(refenced.record.pid).toBe(worker.ref.pid);
    worker.lifecycle = "stopped";
    await manager.release(KEY, worker);
    expect((await fence.read(KEY)).kind).toBe("absent");
    await manager.shutdownAll().catch(() => {});
  } finally {
    orphan.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("host restart: an undischargeable Windows fence refuses the second owner spawn (fail closed)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-refuse-"));
  const fenceDir = join(dir, "worker-fences");
  const fence = new RuntimeWorkerFence(fenceDir);
  // In-transaction gate observes a replaced/dead parent → unverified → refused.
  await fence.write(record({ pid: 4242, creationDate: "133800000000000000", bootstrapVerified: true }));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    const manager = new RuntimeWorkerManager({
      entryPath: entry,
      fenceDir,
      clientDeps: {
        platform: "win32",
        selfDischargeWaitMs: 300,
        terminateDescendantsOf: async (_pid, options) => {
          // The recovery path must pass the parent fingerprint AND the
          // dead-parent recovery flag — the birth-order cutoff contract.
          expect(options.expectedParentCreationDate).toBe("133800000000000000");
          expect(options.recoverDeadParent).toBe(true);
          return { verified: false, outcomes: [], leftover: [] };
        },
      },
    });
    await expect(manager.acquire(KEY)).rejects.toThrow(/durable ownership fence/);
    expect(manager.get(KEY)).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("unfenceable spawn fails closed: fence write failure kills the fresh worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-fail-"));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    // A FILE where the fence directory must be: mkdir/write fails.
    const fenceBlocker = join(dir, "not-a-dir");
    await writeFile(fenceBlocker, "blocked");
    const manager = new RuntimeWorkerManager({ entryPath: entry, fenceDir: join(fenceBlocker, "worker-fences") });
    await expect(manager.acquire(KEY)).rejects.toThrow(/durable ownership fence/);
    expect(manager.get(KEY)).toBeUndefined();
    await manager.shutdownAll().catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("production integration: the WORKER sees the DISK fence admitted at its OWN ensure entry (round 31 Blocking 1)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-b1-"));
  const fenceDir = join(dir, "worker-fences");
  try {
    // The fake worker READS THE FENCE FILE ITSELF at the ensure entry point
    // and reports what was on disk at that exact moment — the ordering proof
    // lives at the boundary, not in a post-hoc test-side read.
    const entry = join(dir, "fake-worker.mjs");
    await writeFile(
      entry,
      [
        "const fs = require('node:fs');",
        "let buffer='';",
        "process.stdin.on('data', (d) => {",
        "  buffer += d.toString();",
        "  let idx;",
        "  while ((idx = buffer.indexOf('\\n')) >= 0) {",
        "    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);",
        "    if (!line) continue;",
        "    try { const msg = JSON.parse(line);",
        "      if (msg.method === 'ensure') {",
        "        let fencePhase = null;",
        "        let fenceBootstrap = null;",
        "        let fenceCreation = null;",
        "        try {",
        "          const rec = JSON.parse(fs.readFileSync(process.env.XACPX_WORKER_FENCE, 'utf8'));",
        "          fencePhase = rec.phase;",
        "          fenceBootstrap = rec.bootstrapVerified;",
        "          fenceCreation = rec.creationDate;",
        "        } catch {}",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true, fencePhase, fenceBootstrap, fenceCreation } }) + '\\n');",
        "      } else {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true } }) + '\\n');",
        "      }",
        "      if (msg.method === 'shutdown') process.exit(0);",
        "    } catch {}",
        "  }",
        "});",
      ].join("\n"),
    );
    const manager = new RuntimeWorkerManager({
      entryPath: entry,
      fenceDir,
      clientDeps: {
        platform: "win32",
        probeWindowsIdentity: async (pid) => ({
          status: "found",
          identity: { pid, creationDate: "133800000000000099", executablePath: "C:\\w.exe" },
        }),
      },
    });
    const worker = await manager.acquire(KEY);
    const result = await worker.request<{ ready: boolean; fencePhase: string | null; fenceBootstrap: boolean | null; fenceCreation: string | null }>(
      "ensure",
      {},
    );
    // What the WORKER observed on disk at the ensure boundary:
    expect(result.fencePhase).toBe("admitted");
    expect(result.fenceBootstrap).toBe(true);
    expect(result.fenceCreation).toBe("133800000000000099");
    // And the disk still agrees afterwards.
    const read = await new RuntimeWorkerFence(fenceDir).read(KEY);
    expect(read.kind).toBe("present");
    if (read.kind === "present") {
      expect(read.record.phase).toBe("admitted");
      expect(read.record.creationDate).toBe("133800000000000099");
      expect(read.record.pid).toBe(worker.ref.pid);
      expect(read.record.generation).toBe(worker.ref.generation);
    }
    await manager.shutdownAll().catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

test("worker phase marking: generation-bound — a stale worker can never touch a newer owner's fence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-mark-"));
  try {
    const fence = new RuntimeWorkerFence(dir);
    await fence.write(record({ pid: 500, phase: "admitted", creationDate: "133800000000000000", bootstrapVerified: true, generation: "gen-NEW" }));
    const path = join(dir, `${encodeURIComponent(KEY)}.json`);
    // Stale generation: no overwrite.
    process.env.XACPX_WORKER_FENCE = path;
    process.env.XACPX_WORKER_FENCE_GENERATION = "gen-OLD";
    const { markRuntimeWorkerFence } = await import("../../../../../src/bridge/engine/runtime/worker-eof");
    await markRuntimeWorkerFence("discharged");
    expect(((await fence.read(KEY)) as { kind: "present"; record: RuntimeWorkerFenceRecord }).record.phase).toBe("admitted");
    // Matching generation: phase updates.
    process.env.XACPX_WORKER_FENCE_GENERATION = "gen-NEW";
    await markRuntimeWorkerFence("discharged");
    const read = await fence.read(KEY);
    expect(read.kind).toBe("present");
    if (read.kind === "present") expect(read.record.phase).toBe("discharged");
    delete process.env.XACPX_WORKER_FENCE;
    delete process.env.XACPX_WORKER_FENCE_GENERATION;
  } finally {
    delete process.env.XACPX_WORKER_FENCE;
    delete process.env.XACPX_WORKER_FENCE_GENERATION;
    await rm(dir, { recursive: true, force: true });
  }
});

test("cross-host handoff E2E (POSIX): EOF marks discharging, worker exits, fence retires, respawn allowed", async () => {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-handoff-"));
  const fenceDir = join(dir, "worker-fences");
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    const manager = new RuntimeWorkerManager({ entryPath: entry, fenceDir });
    const worker = await manager.acquire(KEY);
    await worker.request("ensure", {});
    expect(worker.ref.pid).toBeGreaterThan(0);
    // Host "dies": stdin EOF → the worker quiesces, marks the fence, converges.
    worker["child"]?.stdin?.end();
    const exitDeadline = Date.now() + 15_000;
    while (worker.alive && Date.now() < exitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(worker.alive).toBe(false);
    // The crash-cleanup path converges ownership: the fence ends up retired
    // (or at minimum durably discharged) — either way a NEW owner is provably
    // safe, and the very next acquire spawns it.
    const fence = new RuntimeWorkerFence(fenceDir);
    let read = await fence.read(KEY);
    if (read.kind === "present" && read.record.phase === "discharged") {
      await fence.retire(KEY);
      read = await fence.read(KEY);
    }
    expect(read.kind).toBe("absent");
    const worker2 = await manager.acquire(KEY);
    expect(worker2.ref.pid).not.toBe(worker.ref.pid);
    await manager.shutdownAll().catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("fence write chain: a slow initial write can never rename after the admitted upgrade (round 31 Blocking 1)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-chain-"));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await writeFile(entry, "process.stdin.on('data', () => {});");
    const manager = new RuntimeWorkerManager({ entryPath: entry, fenceDir: join(dir, "wf") });
    // Drive the serializer directly: schedule an initial write whose rename
    // lands LAST, then an admitted upgrade — the chain must order them.
    const fence = new RuntimeWorkerFence(join(dir, "wf"));
    let releaseInitial!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseInitial = resolve;
    });
    const order: string[] = [];
    const initial = manager["enqueueFenceWrite"](KEY, async () => {
      await gate;
      await fence.write(record({ pid: 1, phase: "owned" }));
      order.push("owned");
    });
    const upgrade = manager["enqueueFenceWrite"](KEY, async () => {
      await fence.write(record({ pid: 2, phase: "admitted", bootstrapVerified: true }));
      order.push("admitted");
    });
    releaseInitial();
    await Promise.all([initial, upgrade]);
    // The DISK record is the admitted one — the late owned write lost the race
    // by construction, not by luck.
    const read = await fence.read(KEY);
    expect(read.kind).toBe("present");
    if (read.kind === "present") expect(read.record.phase).toBe("admitted");
    expect(order).toEqual(["owned", "admitted"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("REAL Windows regression: killed worker's stubborn adapter is recovered, fence retired, then W2 spawns", async () => {
  if (process.platform !== "win32") return;
  // Review round 32 Blocking 1 acceptance, on real processes:
  //   fenced W → W spawns stubborn A → kill W ITSELF (no EOF handler runs)
  //   → simulate Host restart (fresh manager) → A physically converges
  //   → ownership evidence retired → ONLY THEN W2 may spawn.
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-b1win-"));
  const fenceDir = join(dir, "worker-fences");
  const childPidFile = join(dir, "adapter.pid");
  const worker = spawn(
    process.execPath,
    [
      "-e",
      "const {spawn}=require('node:child_process');const fs=require('node:fs');" +
        "const a=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
        "fs.writeFileSync(process.argv[1],String(a.pid));setInterval(()=>{},1000)",
      childPidFile,
    ],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  let adapterPid = 0;
  try {
    await new Promise((resolve) => setTimeout(resolve, 400));
    adapterPid = Number.parseInt(await readFile(childPidFile, "utf8"), 10);
    expect(adapterPid).toBeGreaterThan(0);

    // The manager durable-fences W after bootstrap (admitted fingerprint).
    const entry = join(dir, "fake-worker.mjs");
    await writeFile(entry, "process.stdin.on('data', () => {});");
    const manager = new RuntimeWorkerManager({
      entryPath: worker.spawnargs?.[1] ? entry : entry, // entry path unused for fence setup below
      fenceDir,
      clientDeps: {
        platform: "win32",
        probeWindowsIdentity: async () => {
          // The EXTERNAL process W stands in for the spawned worker: expose
          // its verified identity to the fence machinery.
          return { status: "found", identity: { pid: worker.pid!, creationDate: "133800000000000000", executablePath: "C:\\w.exe" } };
        },
        terminateProcessTree: async () => {
          throw new Error("host crash cleanup never completes (simulated)");
        },
      },
    });
    void manager;

    const fence = new RuntimeWorkerFence(fenceDir);
    await fence.write(
      record({
        pid: worker.pid!,
        creationDate: "133800000000000000",
        bootstrapVerified: true,
        phase: "admitted",
        generation: "gen-b1win",
      }),
    );

    // Worker W itself is SIGKILLed: no EOF handler can run. Adapter A survives.
    worker.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(() => process.kill(adapterPid, 0)).not.toThrow();

    // Host restart: a fresh manager discharges the stale fence. The
    // dead-root recovery kills A (birth-order cutoff makes the dead parent's
    // edge unambiguous), verifies, retires the fence.
    const manager2 = new RuntimeWorkerManager({
      entryPath: entry,
      fenceDir,
      clientDeps: { platform: "win32" },
    });
    const w2 = await manager2.acquire(KEY);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(() => process.kill(adapterPid, 0)).toThrow();
    const read = await fence.read(KEY);
    expect(read.kind).toBe("present");
    if (read.kind === "present") {
      expect(read.record.phase).toBe("admitted");
      expect(read.record.pid).toBe(w2.ref.pid);
    }
    w2.lifecycle = "stopped";
    await manager2.release(KEY, w2);
    expect((await fence.read(KEY)).kind).toBe("absent");
  } finally {
    try { worker.kill("SIGKILL"); } catch {}
    try { if (adapterPid) process.kill(adapterPid, "SIGKILL"); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("spool handshake full chain: registry residuals keep the fence; reaper cleanup lifts it (round 32 Blocking 3)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-spool-"));
  const fenceDir = join(dir, "worker-fences");
  const runtimeDir = join(dir, "runtime");
  try {
    const fence = new RuntimeWorkerFence(fenceDir);
    await fence.write(record({ pid: 4242, phase: "spooled", creationDate: "133800000000000000", bootstrapVerified: true, generation: "44444444-4444-4444-8444-444444444444" }));
    // The worker spooled residuals bound to THIS fence generation.
    const { OrphanRegistry } = await import("../../../../../src/transport/orphan-registry");
    const registry = new OrphanRegistry(runtimeDir);
    await registry.initialize();
    const residual = (pid: number) => ({
      kind: "residual" as const,
      ownerToken: "11111111-1111-4111-8111-111111111111",
      pid,
      creationDate: "133801632000000010",
      commandLine: "adapter",
      executablePath: "C:\\adapter.exe",
      agentCommand: "runtime-worker-orphan",
      generationId: "44444444-4444-4444-8444-444444444444",
      killAttempts: 0,
    });
    await registry.writeResidual(residual(501));
    await registry.writeResidual(residual(502));

    const remaining = async (): Promise<boolean> => {
      const records = await registry.readCategory("residuals");
      return records === null || records.some(({ record }) => record.generationId === "44444444-4444-4444-8444-444444444444");
    };
    const entry = join(dir, "fake-worker.mjs");
    await writeFile(entry, "process.stdin.on('data', () => {});");
    const manager = new RuntimeWorkerManager({
      entryPath: entry,
      fenceDir,
      clientDeps: { platform: "win32", spooledResidualsRemaining: remaining },
    });

    // Residuals pending: the session stays fenced.
    await expect(manager.acquire(KEY)).rejects.toThrow(/durable ownership fence/);
    expect(manager.get(KEY)).toBeUndefined();

    // The daemon reaper converges BOTH residuals (terminal cleanup simulated
    // by the registry reflecting post-sweep state).
    await registry.deleteResidual(`${"11111111-1111-4111-8111-111111111111"}-501.json`);
    await registry.deleteResidual(`${"11111111-1111-4111-8111-111111111111"}-502.json`);

    // The handshake lifts the phase to discharged and retires: respawn works.
    const w2 = await manager.acquire(KEY);
    expect(w2.ref.pid).toBeGreaterThan(0);
    // The lifted fence was retired and the NEW owner already re-fenced under
    // its own generation.
    const refenced = await fence.read(KEY);
    expect(refenced.kind).toBe("present");
    if (refenced.kind === "present") {
      expect(refenced.record.phase).toBe("owned");
      expect(refenced.record.pid).toBe(w2.ref.pid);
    }
    w2.lifecycle = "stopped";
    await manager.release(KEY, w2);
    expect((await fence.read(KEY)).kind).toBe("absent");
    await manager.shutdownAll().catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
