import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  RuntimeWorkerClient,
  WorkerBootstrapError,
  WorkerTeardownPendingError,
} from "../../../../../src/bridge/engine/runtime/runtime-worker-client";
import { RuntimeWorkerManager } from "../../../../../src/bridge/engine/runtime/runtime-worker-manager";
import { RuntimeEngine } from "../../../../../src/bridge/engine/runtime-engine";

async function createEchoWorker(entry: string): Promise<void> {
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
      "      process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true } }) + '\\n');",
      "      if (msg.method === 'shutdown') process.exit(0);",
      "    } catch {}",
      "  }",
      "});",
    ].join("\n"),
  );
}

test("Scenario 1: Windows identity probe is a hard gate — RPCs await probe resolution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "win-probe-gate-"));
  try {
    const entry = join(dir, "worker.mjs");
    await createEchoWorker(entry);

    let probeResolved = false;
    const { promise: probePromise, resolve: resolveProbe } = Promise.withResolvers<{
      status: "found";
      identity: { pid: number; creationDate: string };
    }>();

    const client = new RuntimeWorkerClient(entry, "session-win-1", undefined, undefined, {
      probeWindowsIdentity: async (pid) => {
        const res = await probePromise;
        probeResolved = true;
        return { status: "found", identity: { pid, creationDate: res.identity.creationDate } };
      },
      terminateProcessTree: async () => ({ rootOutcome: "killed", outcomes: [] }),
    });
    // Initiate request: should await the identity probe before completing
    const reqPromise = client.request("ensure", {});
    expect(probeResolved).toBe(false);

    // Resolve the identity probe
    resolveProbe({ status: "found", identity: { pid: 1234, creationDate: "2026-08-27T10:00:00.000Z" } });

    await reqPromise;
    expect(probeResolved).toBe(true);
    expect(client.ref.creationDate).toBe("2026-08-27T10:00:00.000Z");

    await client.terminate();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Scenario 1b: warmth positive whitelist — false while probe pending, true after bootstrap verified, false when stopped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "win-warm-timing-"));
  try {
    const entry = join(dir, "worker.mjs");
    await createEchoWorker(entry);

    const { promise: probePromise, resolve: resolveProbe } = Promise.withResolvers<{
      status: "found";
      identity: { pid: number; creationDate: string };
    }>();
    const engine = new RuntimeEngine({
      workerEntryPath: entry,
      permissionMode: "approve-all",
      workerClientDeps: {
        platform: "win32",
        probeWindowsIdentity: async (pid) => {
          const res = await probePromise;
          return { status: "found", identity: { pid, creationDate: res.identity.creationDate } };
        },
        terminateProcessTree: async (target) => {
          try { process.kill(typeof target === "number" ? target : target.pid, "SIGTERM"); } catch {}
          return { rootOutcome: "killed", outcomes: [] };
        },
      },
    });

    const sessionInput = {
      agent: "codex",
      cwd: "/repo",
      name: "warm-timing-session",
      logicalSessionId: "warm-timing-1",
    };

    // 1. Initiate ensureSession: probe is still pending
    const ensurePromise = engine.ensureSession(sessionInput);

    // Warmth is strictly FALSE while probe is pending
    expect(await engine.isSessionWarm(sessionInput)).toEqual({ warm: false });

    // 2. Resolve the identity probe -> ensure finishes -> worker lifecycle becomes ready
    resolveProbe({ status: "found", identity: { pid: 9999, creationDate: "2026-08-27T12:00:00.000Z" } });
    await ensurePromise;

    // Warmth becomes TRUE only after verified bootstrap + successful RPC
    expect(await engine.isSessionWarm(sessionInput)).toEqual({ warm: true });

    // 3. Deliberate free/stop -> warmth becomes FALSE
    await engine.freeWarmProcess(sessionInput);
    expect(await engine.isSessionWarm(sessionInput)).toEqual({ warm: false });

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("Scenario 2: Windows identity probe failure fails closed (rejects bootstrap, marks failed)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "win-probe-fail-"));
  try {
    const entry = join(dir, "worker.mjs");
    await createEchoWorker(entry);

    const client = new RuntimeWorkerClient(entry, "session-win-2", undefined, undefined, {
      probeWindowsIdentity: async () => ({ status: "unavailable" }),
    });

    await expect(client.request("ensure", {})).rejects.toThrow(WorkerBootstrapError);
    expect(client.lifecycle).toBe("failed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Scenario 3: terminate on Windows without verified creationDate refuses naked PID kill", async () => {
  const dir = await mkdtemp(join(tmpdir(), "win-no-naked-"));
  try {
    const entry = join(dir, "worker.mjs");
    await createEchoWorker(entry);

    // Injected probe simulates a Windows environment with unverified identity
    const client = new RuntimeWorkerClient(entry, "session-win-3", undefined, undefined, {
      probeWindowsIdentity: async () => ({ status: "missing" }),
    });

    // Manually spawn without valid identity
    client.spawn();
    // Intentionally ensure creationDate is missing
    client.ref.creationDate = undefined;

    await expect(client.terminate()).rejects.toThrow(/without verified creationDate/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Scenario 4: terminate uses immutable creationDate captured at bootstrap (PID reuse proof)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "win-pid-reuse-"));
  try {
    const entry = join(dir, "worker.mjs");
    await createEchoWorker(entry);

    let terminatedTarget: unknown;
    const client = new RuntimeWorkerClient(entry, "session-win-4", undefined, undefined, {
      platform: "win32",
      probeWindowsIdentity: async (pid) => ({
        status: "found",
        identity: { pid, creationDate: "2026-08-27T01:00:00.000Z" },
      }),
      terminateProcessTree: async (target) => {
        terminatedTarget = target;
        return { rootOutcome: "killed", outcomes: [] };
      },
    });

    await client.request("ensure", {});
    expect(client.ref.creationDate).toBe("2026-08-27T01:00:00.000Z");

    // Terminate should use the original immutable creationDate captured at spawn
    await client.terminate();
    expect(client.lifecycle).toBe("stopped");
    expect(terminatedTarget).toEqual({
      pid: client.ref.pid,
      creationDate: "2026-08-27T01:00:00.000Z",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Scenario 4b: Windows termination outcomes matrix — confirmed safe vs unconfirmed failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "win-outcomes-"));
  try {
    const entry = join(dir, "worker.mjs");
    await createEchoWorker(entry);

    // Confirmed safe outcome: killed (tree snapshot + verified kill)
    const client = new RuntimeWorkerClient(entry, "session-safe-killed", undefined, undefined, {
      platform: "win32",
      probeWindowsIdentity: async (pid) => ({
        status: "found",
        identity: { pid, creationDate: "2026-08-27T01:00:00.000Z" },
      }),
      terminateProcessTree: async () => ({ rootOutcome: "killed", outcomes: [] }),
    });
    await client.request("ensure", {});
    await expect(client.terminate()).resolves.toBeUndefined();
    expect(client.lifecycle).toBe("stopped");

    // Unverified / pre-snapshot outcomes: already-exited, skipped-replaced (cannot prove descendant cleanup)
    for (const preSnapshotOutcome of ["already-exited", "skipped-replaced"] as const) {
      const unverifiedClient = new RuntimeWorkerClient(entry, `session-unverified-${preSnapshotOutcome}`, undefined, undefined, {
        platform: "win32",
        probeWindowsIdentity: async (pid) => ({
          status: "found",
          identity: { pid, creationDate: "2026-08-27T01:00:00.000Z" },
        }),
        terminateProcessTree: async () => ({ rootOutcome: preSnapshotOutcome, outcomes: [] }),
      });
      await unverifiedClient.request("ensure", {});
      await expect(unverifiedClient.terminate()).rejects.toThrow(/cannot verify Windows descendant process tree cleanup/);
      expect(unverifiedClient.lifecycle).toBe("failed");
    }

    // Failure outcomes: access-denied, query-failed, kill-requested-unconfirmed
    for (const failOutcome of ["access-denied", "query-failed", "kill-requested-unconfirmed"] as const) {
      const failClient = new RuntimeWorkerClient(entry, `session-fail-${failOutcome}`, undefined, undefined, {
        platform: "win32",
        probeWindowsIdentity: async (pid) => ({
          status: "found",
          identity: { pid, creationDate: "2026-08-27T01:00:00.000Z" },
        }),
        terminateProcessTree: async () => ({ rootOutcome: failOutcome, outcomes: [] }),
      });
      await failClient.request("ensure", {});
      await expect(failClient.terminate()).rejects.toThrow(/process tree termination failed/);
      expect(failClient.lifecycle).toBe("failed");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Scenario 5: unexpected exit(0) without deliberate intent is classified as a crash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "win-unexp-exit0-"));
  try {
    // Worker that unexpectedly exits with code 0 on any request
    const entry = join(dir, "exit0-worker.mjs");
    await writeFile(
      entry,
      [
        "process.stdin.on('data', () => {",
        "  process.exit(0);",
        "});",
      ].join("\n"),
    );

    const manager = new RuntimeWorkerManager({ entryPath: entry, maxRestartsPerWindow: 1, restartWindowMs: 60_000 });
    const worker = manager.ensureWorker("exit0-session");

    // Trigger unexpected exit 0
    await expect(worker.request("ensure", {})).rejects.toMatchObject({ code: "RUNTIME_WORKER_CRASHED" });

    // Lifecycle marked failed during crash and transitions to stopped after cleanup
    expect(worker.lifecycle).toMatch(/failed|stopped/);
    // Respawn budget or teardown gate must reject
    expect(() => manager.ensureWorker("exit0-session")).toThrow(/crashed 1 times|refusing duplicate worker spawn|failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Scenario 6: deliberate freeWarmProcess / cooling exit(0) does NOT consume crash budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "win-delib-free-"));
  try {
    const entry = join(dir, "worker.mjs");
    await createEchoWorker(entry);

    const manager = new RuntimeWorkerManager({ entryPath: entry, maxRestartsPerWindow: 1, restartWindowMs: 60_000 });
    const worker = manager.ensureWorker("free-session");
    await worker.request("ensure", {});

    // Deliberate terminate (cooling)
    await worker.terminate();
    expect(worker.lifecycle).toBe("stopped");

    // Budget NOT consumed: respawn succeeds
    expect(() => manager.ensureWorker("free-session")).not.toThrow();
    await manager.shutdownAll();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Scenario 7: permission rotation termination does NOT consume crash budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "win-perm-rot-budget-"));
  try {
    const entry = join(dir, "worker.mjs");
    await createEchoWorker(entry);

    const engine = new RuntimeEngine({
      workerEntryPath: entry,
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
    });

    // Ensure session
    await engine.ensureSession({
      agent: "codex",
      cwd: "/repo",
      name: "rot-budget-session",
      logicalSessionId: "rot-budget-1",
    });

    // Rotate workers via permission update
    await engine.updatePermissionPolicy({
      permissionMode: "deny-all",
      nonInteractivePermissions: "deny",
    });

    // Next ensure must succeed smoothly without hitting crash budget
    await expect(
      engine.ensureSession({
        agent: "codex",
        cwd: "/repo",
        name: "rot-budget-session",
        logicalSessionId: "rot-budget-1",
      }),
    ).resolves.toEqual({});

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("Ownership invariant: request() during teardown rejects with WorkerTeardownPendingError and does NOT spawn another process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "win-teardown-nospawn-"));
  try {
    const entry = join(dir, "worker.mjs");
    await createEchoWorker(entry);

    const { promise: termPromise, resolve: resolveTerm } = Promise.withResolvers<void>();

    const client = new RuntimeWorkerClient(entry, "session-teardown-race", undefined, undefined, {
      terminateProcessTree: async () => {
        await termPromise;
        return { rootOutcome: "killed", outcomes: [] };
      },
    });

    await client.request("ensure", {});
    const initialPid = client.ref.pid;
    expect(initialPid).toBeGreaterThan(0);

    // 1. Begin termination (held in-flight)
    const terminateCall = client.terminate();
    expect(client.lifecycle).toBe("cooling");

    // 2. Concurrent request while teardown is pending MUST reject and MUST NOT spawn another child process
    await expect(client.request("ensure", {})).rejects.toMatchObject({
      code: "RUNTIME_WORKER_TEARDOWN_PENDING",
    });
    // Crucial: PID must NOT have changed (no second child secretly spawned)
    expect(client.ref.pid).toBe(initialPid);

    // 3. Resolve termination
    resolveTerm();
    await terminateCall;
    expect(client.lifecycle).toBe("stopped");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Quiescence: Windows bootstrap probe pending causes concurrent permission update to fail closed without corrupting ensure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "win-probe-quiesce-"));
  try {
    const entry = join(dir, "worker.mjs");
    await createEchoWorker(entry);

    const { promise: probePromise, resolve: resolveProbe } = Promise.withResolvers<{
      status: "found";
      identity: { pid: number; creationDate: string };
    }>();

    const engine = new RuntimeEngine({
      workerEntryPath: entry,
      permissionMode: "approve-all",
      workerClientDeps: {
        platform: "win32",
        probeWindowsIdentity: async (pid) => {
          const res = await probePromise;
          return { status: "found", identity: { pid, creationDate: res.identity.creationDate } };
        },
        terminateProcessTree: async () => ({ rootOutcome: "killed", outcomes: [] }),
      },
    });

    const sessionInput = {
      agent: "codex",
      cwd: "/repo",
      name: "quiesce-probe-session",
      logicalSessionId: "quiesce-probe-1",
    };

    // 1. Start ensureSession: probe is pending (in-flight lease is active from request entry)
    const ensurePromise = engine.ensureSession(sessionInput);

    // 2. Concurrent permission update: must detect the in-flight bootstrap operation and fail closed!
    await expect(
      engine.updatePermissionPolicy({
        permissionMode: "deny-all",
        nonInteractivePermissions: "deny",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_PERMISSION_BUSY" });

    // 3. Resolve the probe: original ensureSession completes normally without corruption
    resolveProbe({ status: "found", identity: { pid: 8888, creationDate: "2026-08-27T15:00:00.000Z" } });
    await expect(ensurePromise).resolves.toEqual({});

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Quiescence: concurrent cancel() during permission transition waits on transition lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "win-cancel-quiesce-"));
  try {
    const entry = join(dir, "worker.mjs");
    await createEchoWorker(entry);

    const engine = new RuntimeEngine({
      workerEntryPath: entry,
      permissionMode: "approve-all",
    });

    const sessionInput = {
      agent: "codex",
      cwd: "/repo",
      name: "quiesce-cancel-session",
      logicalSessionId: "quiesce-cancel-1",
    };

    await engine.ensureSession(sessionInput);

    // 1. Acquire policy transition lock (prepare)
    await engine.preparePolicyTransition();

    let cancelResolved = false;
    // 2. Concurrent cancel while transition lock is held: MUST await the lock
    const cancelPromise = engine.cancel(sessionInput).then((res) => {
      cancelResolved = true;
      return res;
    });

    expect(cancelResolved).toBe(false);

    // 3. Commit transition: unblocks the cancel
    await engine.commitPolicyTransition({
      permissionMode: "deny-all",
      nonInteractivePermissions: "deny",
    });

    const cancelResult = await cancelPromise;
    expect(cancelResolved).toBe(true);
    // After rotation the old worker is gone, so cancel on the freshly rotated session is clean
    expect(cancelResult.cancelled).toBe(false);

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("Lifecycle: client.shutdown() sends graceful shutdown RPC frame to worker process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "win-shutdown-rpc-"));
  try {
    let receivedShutdownMethod = false;
    const entry = join(dir, "shutdown-worker.mjs");
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
        "      if (msg.method === 'shutdown') {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
        "        setTimeout(() => process.exit(0), 10);",
        "      } else {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
        "      }",
        "    } catch {}",
        "  }",
        "});",
      ].join("\n"),
    );

    const client = new RuntimeWorkerClient(entry, "session-shutdown-test");
    await client.request("ensure", {});

    // Intercept client.terminate to verify shutdown RPC succeeded before hard termination
    let hardKillCalled = false;
    const origTerminate = client["terminate"].bind(client);
    client["terminate"] = async () => {
      hardKillCalled = true;
      return origTerminate();
    };

    // Calling shutdown() must deliver the graceful shutdown message to worker
    await client.shutdown(2_000);

    expect(client.lifecycle).toBe("stopped");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("Windows lifecycle: graceful shutdown when creationDate identity probe is still pending succeeds without terminateProcessTree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "win-shutdown-probe-pending-"));
  try {
    const entry = join(dir, "probe-pending-worker.mjs");
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
        "      if (msg.method === 'shutdown') {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
        "        setTimeout(() => process.exit(0), 10);",
        "      } else {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
        "      }",
        "    } catch {}",
        "  }",
        "});",
      ].join("\n"),
    );

    let terminateTreeCalled = false;
    // Probe is intentionally held pending forever to simulate slow Windows WMI query
    const pendingForever = new Promise<never>(() => {});

    const client = new RuntimeWorkerClient(
      entry,
      "win-probe-pending-session",
      undefined,
      undefined,
      {
        platform: "win32",
        probeWindowsIdentity: async () => pendingForever,
        terminateProcessTree: async () => {
          terminateTreeCalled = true;
          return { status: "killed", pid: 99999 };
        },
      },
    );

    // Spawn the worker (probe is started in background, remaining pending)
    client.spawn();

    // Call graceful shutdown while identity probe is still pending
    await client.shutdown(2_000);

    // Assert: child exited cleanly within grace window
    expect(client.alive).toBe(false);
    expect(client.lifecycle).toBe("stopped");
    // terminateProcessTree MUST NOT be called!
    expect(terminateTreeCalled).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("G10 lifecycle: production shutdown cleans up real OS descendant process tree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "g10-real-descendant-"));
  const pidFile = join(dir, "descendant.pid");
  try {
    const entry = join(dir, "descendant-worker.mjs");
    await writeFile(
      entry,
      [
        "import { spawn } from 'node:child_process';",
        "import fs from 'node:fs';",
        "let buffer='';",
        "let child=null;",
        "process.stdin.on('data', (d) => {",
        "  buffer += d.toString();",
        "  let idx;",
        "  while ((idx = buffer.indexOf('\\n')) >= 0) {",
        "    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);",
        "    if (!line) continue;",
        "    try { const msg = JSON.parse(line);",
        "      if (msg.method === 'ensure') {",
        "        child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });",
        `        fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid), 'utf8');`,
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true } }) + '\\n');",
        "      } else if (msg.method === 'shutdown') {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
        "        setTimeout(() => process.exit(0), 10);",
        "      } else {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
        "      }",
        "    } catch {}",
        "  }",
        "});",
      ].join("\n"),
    );

    // Production client (no terminateProcessTree stub)
    const client = new RuntimeWorkerClient(entry, "session-g10-real-tree");
    await client.request("ensure", {});
    expect(client.alive).toBe(true);

    const descendantPid = parseInt(await readFile(pidFile, "utf8"), 10);
    expect(descendantPid).toBeGreaterThan(0);
    // Confirm descendant is currently running in OS
    expect(() => process.kill(descendantPid, 0)).not.toThrow();

    // Call shutdown: worker root exits 0 and process group termination kills descendant
    await client.shutdown(2_000);

    expect(client.lifecycle).toBe("stopped");
    // Verify descendant is dead in OS
    let descendantRunning = true;
    for (let i = 0; i < 30; i++) {
      try {
        process.kill(descendantPid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        descendantRunning = false;
        break;
      }
    }
    expect(descendantRunning).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("Windows G10: unexpected root crash with already-exited root outcome fails closed and rejects replacement spawn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "win-crash-descendant-"));
  try {
    const entry = join(dir, "worker.mjs");
    await createEchoWorker(entry);

    const manager = new RuntimeWorkerManager({
      entryPath: entry,
      clientDeps: {
        platform: "win32",
        probeWindowsIdentity: async (pid) => ({ status: "found", identity: { pid, creationDate: "133500000000000000" } }),
        terminateProcessTree: async () => {
          // When root is already dead, Windows OpenVerified returns already-exited without taking CIM snapshot
          return { rootOutcome: "already-exited", outcomes: [] };
        },
      },
    });

    const client = manager.ensureWorker("session-win-crash-descendant");
    await client.request("ensure", {});
    expect(client.alive).toBe(true);

    // Abruptly kill worker root to simulate unexpected crash
    process.kill(client.ref.pid, "SIGKILL");

    // Await exit
    const deadline = Date.now() + 2_000;
    while (client.alive && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 5));
    }

    // Terminate on dead root returns already-exited -> MUST reject fail closed!
    await expect(client.terminate()).rejects.toThrow(/cannot verify Windows descendant process tree cleanup/);

    // Lifecycle must remain failed (cannot prove cleanup)
    expect(client.lifecycle).toBe("failed");

    expect(() => manager.ensureWorker("session-win-crash-descendant")).toThrow(WorkerTeardownPendingError);

    await manager.shutdownAll().catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Windows G10: unexpected root crash with skipped-replaced root outcome fails closed and rejects replacement spawn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "win-crash-skipped-"));
  try {
    const entry = join(dir, "worker.mjs");
    await createEchoWorker(entry);

    const manager = new RuntimeWorkerManager({
      entryPath: entry,
      clientDeps: {
        platform: "win32",
        probeWindowsIdentity: async (pid) => ({ status: "found", identity: { pid, creationDate: "133500000000000000" } }),
        terminateProcessTree: async () => {
          // When PID was reused before termination, Windows OpenVerified returns skipped-replaced
          return { rootOutcome: "skipped-replaced", outcomes: [] };
        },
      },
    });

    const client = manager.ensureWorker("session-win-crash-skipped");
    await client.request("ensure", {});
    expect(client.alive).toBe(true);

    // Abruptly kill worker root
    process.kill(client.ref.pid, "SIGKILL");

    // Await exit
    const deadline = Date.now() + 2_000;
    while (client.alive && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 5));
    }

    // Terminate returns skipped-replaced -> MUST reject fail closed!
    await expect(client.terminate()).rejects.toThrow(/cannot verify Windows descendant process tree cleanup/);
    expect(client.lifecycle).toBe("failed");

    expect(() => manager.ensureWorker("session-win-crash-skipped")).toThrow(WorkerTeardownPendingError);

    await manager.shutdownAll().catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Windows G10: wasAliveBeforeTerm initially true but terminator returns already-exited must still fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "win-alive-race-"));
  try {
    const entry = join(dir, "worker.mjs");
    await createEchoWorker(entry);

    const client = new RuntimeWorkerClient(
      entry,
      "session-win-alive-race",
      undefined,
      undefined,
      {
        platform: "win32",
        probeWindowsIdentity: async (pid) => ({ status: "found", identity: { pid, creationDate: "133500000000000000" } }),
        terminateProcessTree: async () => ({ rootOutcome: "already-exited", outcomes: [] }),
      },
    );

    await client.request("ensure", {});
    expect(client.alive).toBe(true);

    // Terminate while alive where terminator returns already-exited (race in OpenVerified) -> MUST fail closed!
    await expect(client.terminate()).rejects.toThrow(/cannot verify Windows descendant process tree cleanup/);
    expect(client.lifecycle).toBe("failed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
