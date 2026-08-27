import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  RuntimeWorkerClient,
  WorkerBootstrapError,
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

    // Safe outcomes: killed, already-exited, skipped-replaced
    for (const safeOutcome of ["killed", "already-exited", "skipped-replaced"] as const) {
      const client = new RuntimeWorkerClient(entry, `session-safe-${safeOutcome}`, undefined, undefined, {
        platform: "win32",
        probeWindowsIdentity: async (pid) => ({
          status: "found",
          identity: { pid, creationDate: "2026-08-27T01:00:00.000Z" },
        }),
        terminateProcessTree: async () => ({ rootOutcome: safeOutcome, outcomes: [] }),
      });
      await client.request("ensure", {});
      await expect(client.terminate()).resolves.toBeUndefined();
      expect(client.lifecycle).toBe("stopped");
    }

    // Failure outcomes: access-denied, query-failed, kill-requested-unconfirmed
    for (const failOutcome of ["access-denied", "query-failed", "kill-requested-unconfirmed"] as const) {
      const client = new RuntimeWorkerClient(entry, `session-fail-${failOutcome}`, undefined, undefined, {
        platform: "win32",
        probeWindowsIdentity: async (pid) => ({
          status: "found",
          identity: { pid, creationDate: "2026-08-27T01:00:00.000Z" },
        }),
        terminateProcessTree: async () => ({ rootOutcome: failOutcome, outcomes: [] }),
      });
      await client.request("ensure", {});
      await expect(client.terminate()).rejects.toThrow(/process tree termination failed/);
      // Fails closed: lifecycle must NOT become stopped
      expect(client.lifecycle).not.toBe("stopped");
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

    // Lifecycle must be marked failed
    expect(worker.lifecycle).toBe("failed");

    // Respawn budget must be consumed
    expect(() => manager.ensureWorker("exit0-session")).toThrow(/crashed 1 times/);
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
