import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RuntimeWorkerFence,
  dischargeRuntimeWorkerFence,
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

test("discharge phase table: admitted + alive root past the wait window falls back to the gated kill", async () => {
  // Host died, worker never got EOF quiescence done in time (hung): the
  // fallback kill runs, and its verified result is durably marked discharged.
  let marked: RuntimeWorkerFenceRecord | undefined;
  const outcome = await dischargeRuntimeWorkerFence(
    record({ pid: 4242, phase: "admitted", creationDate: "133800000000000000", bootstrapVerified: true }),
    {
      platform: "win32",
      terminateDescendants: async (parentPid, expectedCreationDate) => {
        expect(parentPid).toBe(4242);
        expect(expectedCreationDate).toBe("133800000000000000");
        return { verified: true, outcomes: [], leftover: [] };
      },
      readBack: async () => ({ kind: "present", record: record({ pid: 4242, phase: "admitted", creationDate: "133800000000000000", bootstrapVerified: true }) }),
      waitMs: async () => {},
      now: (() => {
        let tick = 0;
        return () => tick++ * 100_000;
      })(),
      selfDischargeWaitMs: 90_000,
      markDischarged: async (current) => {
        marked = current;
      },
    },
  );
  expect(outcome).toBe("discharged");
  expect(marked?.phase).toBe("discharged");
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

test("fence discharge (POSIX): live orphan group is killed and discharge verified", async () => {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-posix-"));
  const stubborn = await spawnStubborn();
  try {
    const outcome = await dischargeRuntimeWorkerFence(record({ pid: stubborn.pid! }));
    expect(outcome).toBe("discharged");
    await exited(stubborn);
    expect(stubborn.exitCode === null ? stubborn.signalCode : stubborn.exitCode).not.toBeNull();
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

test("fence discharge (POSIX): EPERM group kill refuses — never a silent discharge", async () => {
  const outcome = await dischargeRuntimeWorkerFence(record(), {
    platform: "darwin",
    probeProcessGroup: () => "alive",
    killGroup: () => {
      const error = new Error("operation not permitted") as Error & { code?: string };
      error.code = "EPERM";
      throw error;
    },
    waitMs: async () => {},
    now: () => 0,
  });
  expect(outcome).toBe("refused");
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
  let kills = 0;
  const gone = await dischargeRuntimeWorkerFence(record(), {
    platform: "darwin",
    probeProcessGroup: () => "gone",
    killGroup: () => {
      kills += 1;
    },
  });
  expect(gone).toBe("discharged");
  expect(kills).toBe(0);
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

test("fence discharge (Windows): verified record converges THROUGH the in-transaction parent gate (round 30 Blocking 3)", async () => {
  let seenPid = 0;
  let seenFingerprint = "";
  const outcome = await dischargeRuntimeWorkerFence(
    record({ pid: 4242, creationDate: "133800000000000000", bootstrapVerified: true }),
    {
      platform: "win32",
      terminateDescendants: async (parentPid, expectedCreationDate) => {
        seenPid = parentPid;
        seenFingerprint = expectedCreationDate;
        return { verified: true, outcomes: [], leftover: [] };
      },
    },
  );
  expect(outcome).toBe("discharged");
  expect(seenPid).toBe(4242);
  // The expected parent fingerprint MUST ride into the kill transaction —
  // a probe result is a momentary observation, not an identity capability.
  expect(seenFingerprint).toBe("133800000000000000");
});

test("fence discharge (Windows): gate failure (dead/replaced root) refuses — no bare-pid kill", async () => {
  let calls = 0;
  const outcome = await dischargeRuntimeWorkerFence(
    record({ pid: 4242, creationDate: "133800000000000000", bootstrapVerified: true }),
    {
      platform: "win32",
      terminateDescendants: async () => {
        calls += 1;
        // Simulates the in-transaction gate observing dead/replaced parent.
        return { verified: false, outcomes: [], leftover: [] };
      },
    },
  );
  expect(outcome).toBe("refused");
  expect(calls).toBe(1);
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

test("host restart: undischarged fence over a live orphan is discharged BEFORE the second owner spawns", async () => {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-restart-"));
  const fenceDir = join(dir, "worker-fences");
  // "Previous host": a stubborn orphan process group (simulated worker+adapter tree)
  // plus its durable fence record — the state a crashed host leaves behind.
  const orphan = await spawnStubborn();
  const fence = new RuntimeWorkerFence(fenceDir);
  await fence.write(record({ pid: orphan.pid!, bootstrapVerified: true }));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    // "New host": a fresh manager (no in-memory state) over the same fence dir.
    const manager = new RuntimeWorkerManager({ entryPath: entry, fenceDir });
    const worker = await manager.acquire(KEY);
    // The orphan was physically converged by the discharge, and the new owner
    // is fenced under its OWN pid.
    await exited(orphan);
    expect(orphan.exitCode === null ? orphan.signalCode : orphan.exitCode).not.toBeNull();
    const refenced = await fence.read(KEY);
    expect(refenced.kind).toBe("present");
    if (refenced.kind === "present") {
      expect(refenced.record.pid).toBe(worker.ref.pid);
      expect(worker.ref.pid).not.toBe(orphan.pid);
    }
    // Verified release removes the fence.
    worker.lifecycle = "stopped";
    await manager.release(KEY, worker);
    expect((await fence.read(KEY)).kind).toBe("absent");
    await manager.shutdownAll().catch(() => {});
  } finally {
    orphan.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

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
        terminateDescendantsOf: async () => ({ verified: false, outcomes: [], leftover: [] }),
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

test("production integration: the DISK fence reads admitted+verified BEFORE ensure enters the worker (round 31 Blocking 1)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-b1-"));
  const fenceDir = join(dir, "worker-fences");
  const ensureMarker = join(dir, "ensure.entered");
  try {
    // The fake worker drops a marker the moment the ensure RPC arrives.
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
        "      if (msg.method === 'ensure' && process.env.XACPX_ENSURE_MARKER) fs.writeFileSync(process.env.XACPX_ENSURE_MARKER, 'entered');",
        "      process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true } }) + '\\n');",
        "      if (msg.method === 'shutdown') process.exit(0);",
        "    } catch {}",
        "  }",
        "});",
      ].join("\n"),
    );
    // argv won't carry through spawn ([entryPath] only) — set the marker path
    // via the spawn env we control through clientDeps.spawnEnv.
    const manager = new RuntimeWorkerManager({
      entryPath: entry,
      fenceDir,
      clientDeps: {
        platform: "win32",
        probeWindowsIdentity: async (pid) => ({
          status: "found",
          identity: { pid, creationDate: "133800000000000099", executablePath: "C:\\w.exe" },
        }),
        spawnEnv: { XACPX_ENSURE_MARKER: ensureMarker },
      },
    });
    // The fake worker reads process.argv[2] — undefined; patch env instead:
    const worker = await manager.acquire(KEY);
    await worker.request("ensure", {});
    // The fence ON DISK must be phase=admitted with the captured identity by
    // the time ensure could enter — the admission barrier orders it so.
    const fence = new RuntimeWorkerFence(fenceDir);
    const read = await fence.read(KEY);
    expect(read.kind).toBe("present");
    if (read.kind === "present") {
      expect(read.record.phase).toBe("admitted");
      expect(read.record.bootstrapVerified).toBe(true);
      expect(read.record.creationDate).toBe("133800000000000099");
      expect(read.record.pid).toBe(worker.ref.pid);
      expect(read.record.generation).toBe(worker.ref.generation);
    }
    await manager.shutdownAll().catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

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
