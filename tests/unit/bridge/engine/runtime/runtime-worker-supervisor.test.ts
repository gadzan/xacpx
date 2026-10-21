import { describe, expect, test } from "bun:test";
import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeWorkerClient, WorkerBootstrapError } from "../../../../../src/bridge/engine/runtime/runtime-worker-client";
import { RuntimeWorkerManager } from "../../../../../src/bridge/engine/runtime/runtime-worker-manager";
import { RuntimeWorkerFence } from "../../../../../src/bridge/engine/runtime/runtime-worker-fence";
import { probeWindowsProcessIdentity, type WindowsProbeStatus } from "../../../../../src/process/windows-process-tree";
import { queryJobContainment } from "../../../../../src/process/windows-job-query";
import { spawnWindowsSupervisor, WINDOWS_SUPERVISOR_BOOT_PREFIX, WINDOWS_SUPERVISOR_HELLO_PREFIX } from "../../../../../src/process/windows-job-supervisor";

/** Stable numeric FILETIME-like birth per pid for fake supervisors. */
const birthFor = (pid: number): string => String(134368643730771264 + pid);

test("durable manager rejects synchronous ensureWorker before spawning or registering a worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "supervisor-sync-fence-"));
  let spawns = 0;
  try {
    const entry = join(dir, "worker.mjs");
    await writeFile(entry, "throw new Error('must never spawn');\n");
    const manager = new RuntimeWorkerManager({
      entryPath: entry,
      fenceDir: join(dir, "fences"),
      clientDeps: {
        windowsJobContainment: true,
        spawnSupervisorProcess: () => { spawns++; throw new Error("must never spawn"); },
      },
    });
    expect(() => manager.ensureWorker("sync-session")).toThrow(/acquire/);
    expect(spawns).toBe(0);
    expect(manager.get("sync-session")).toBeUndefined();
    expect(manager.isWarm("sync-session")).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= deadline) throw new Error("supervisor condition did not settle before deadline");
    const nextTurn = Promise.withResolvers<void>();
    setImmediate(nextTurn.resolve);
    await nextTurn.promise;
  }
}

function capturedSupervisor() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const go = Promise.withResolvers<void>();
  let business = "";
  let pending = "";
  stdin.on("data", (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line === "GO") go.resolve();
      else business += `${line}\n`;
    }
  });
  const kills: unknown[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 41001, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdin, stdout, stderr,
    kill(signal?: NodeJS.Signals | number) {
      kills.push(signal);
      if (child.exitCode === null && child.signalCode === null) {
        child.signalCode = "SIGKILL";
        queueMicrotask(() => { child.emit("exit", null, "SIGKILL"); stdout.end(); stderr.end(); });
      }
      return true;
    },
  });
  const boot = () => {
    stderr.write(WINDOWS_SUPERVISOR_BOOT_PREFIX + JSON.stringify({ supervisorPid: child.pid, creationDate: birthFor(child.pid) }) + "\n");
  };
  const hello = (jobName: string) => {
    stderr.write(WINDOWS_SUPERVISOR_HELLO_PREFIX + JSON.stringify({ workerPid: 41002, supervisorPid: child.pid, jobName, inJob: true }) + "\n");
  };
  return {
    child: child as unknown as ChildProcess, kills,
    business: () => business,
    go,
    boot,
    hello,
    /** Boot immediately; announce the worker only after the host's GO. */
    auto(jobName: string) {
      queueMicrotask(boot);
      void go.promise.then(() => hello(jobName));
    },
  };
}

for (const barrier of ["supervisor boot", "supervisor probe", "durable supervisor admission", "supervisor hello", "attestation", "durable worker admission"] as const) {
  test(`shutdown cancels pending ${barrier} without late business admission`, async () => {
    const fake = capturedSupervisor();
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let admitted = 0;
    const exitStates: string[] = [];
    const client = new RuntimeWorkerClient("unused.mjs", "cancel-admission", undefined, (worker) => { exitStates.push(worker.lifecycle); }, {
      platform: "win32",
      spawnSupervisorProcess: (request) => {
        if (barrier === "supervisor boot") entered.resolve();
        else queueMicrotask(() => fake.boot());
        if (barrier !== "supervisor hello") void fake.go.promise.then(() => fake.hello(request.jobName));
        return fake.child;
      },
      probeWindowsIdentity: async (pid) => {
        if (barrier === "supervisor probe" && pid === fake.child.pid) { entered.resolve(); await gate.promise; }
        return { status: "found", identity: { pid, creationDate: birthFor(pid) } };
      },
      onSupervisorBoot: async () => {
        if (barrier === "supervisor hello") entered.resolve();
        if (barrier === "durable supervisor admission") { entered.resolve(); await gate.promise; }
      },
      onIdentityVerified: async () => {
        if (barrier === "durable worker admission") { entered.resolve(); await gate.promise; }
        admitted++;
      },
      querySupervisorAttestation: async (_job, pids) => {
        if (barrier === "attestation") { entered.resolve(); await gate.promise; }
        return pids.map((pid) => ({ pid, inJob: true, verifiable: true, status: "found" as const, creationDate: birthFor(pid) }));
      },
      querySupervisorContainment: async () => "absent",
      supervisorTerminationTimeoutMs: 500,
      supervisorHelloTimeoutMs: 500,
      terminateProcessTree: async () => { throw new Error("historical tree termination must not run"); },
    });
    const result = client.request("ensure", {}).then(() => "resolved", () => "rejected");
    try {
      await entered.promise;
      await client.shutdown(50);
      expect(await result).toBe("rejected");
      expect(client.lifecycle).toBe("stopped");
      expect(client.isDeliberateShutdown).toBe(true);
      expect(exitStates).toEqual(["cooling"]);
      gate.resolve();
      // Drain the continuation that was already awaiting the durable barrier.
      const drained = Promise.withResolvers<void>();
      setImmediate(drained.resolve);
      await drained.promise;
      expect(client.isBootstrapVerified).toBe(false);
      expect(client.lifecycle).toBe("stopped");
      expect(fake.business()).toBe("");
      expect(admitted).toBe(barrier === "durable worker admission" ? 1 : 0);
      expect(fake.kills).toContain("SIGKILL");
    } finally { gate.resolve(); await client.terminate(); }
  }, 5_000);
}

test("pending admission shutdown stays failed until Job cleanup is verified", async () => {
  const fake = capturedSupervisor();
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let cleanupVerified = false;
  const client = new RuntimeWorkerClient("unused.mjs", "cleanup-pending", undefined, undefined, {
    platform: "win32",
    spawnSupervisorProcess: (request) => { fake.auto(request.jobName); return fake.child; },
    probeWindowsIdentity: async (pid) => {
      entered.resolve();
      await gate.promise;
      return { status: "found", identity: { pid, creationDate: birthFor(pid) } };
    },
    querySupervisorContainment: async () => {
      if (!cleanupVerified) throw new Error("Job query unavailable");
      return "empty";
    },
    supervisorTerminationTimeoutMs: 500,
  });
  const request = client.request("ensure", {}).then(() => "resolved", () => "rejected");
  try {
    await entered.promise;
    await expect(client.shutdown(50)).rejects.toThrow("Job query unavailable");
    expect(await request).toBe("rejected");
    expect(client.lifecycle).toBe("failed");
    expect(client.isBootstrapVerified).toBe(false);
    expect(fake.business()).toBe("");
    cleanupVerified = true;
    await client.terminate();
    expect(client.lifecycle).toBe("stopped");
  } finally { gate.resolve(); cleanupVerified = true; await client.terminate(); }
}, 5_000);

for (const failedPid of [41001, 41002]) {
  for (const status of ["missing", "unavailable"] as const) {
    test(`admission rejects ${status} readback for pid ${failedPid}`, async () => {
      const fake = capturedSupervisor();
      const exitStates: string[] = [];
      const client = new RuntimeWorkerClient("unused.mjs", "probe-failure", undefined, (worker) => { exitStates.push(worker.lifecycle); }, {
        platform: "win32",
        spawnSupervisorProcess: (request) => { fake.auto(request.jobName); return fake.child; },
        probeWindowsIdentity: async (pid) => ({ status: "found", identity: { pid, creationDate: birthFor(pid) } }),
        querySupervisorAttestation: async (_job, pids) => pids.map((pid) => pid !== failedPid
          ? { pid, inJob: true, verifiable: true, status: "found" as const, creationDate: birthFor(pid) }
          : { pid, inJob: false, verifiable: false, status, reason: "native readback failed" }),
        querySupervisorContainment: async () => "empty",
        supervisorTerminationTimeoutMs: 500,
      });
      try {
        const role = failedPid === fake.child.pid ? "supervisor" : "worker";
        await expect(client.request("ensure", {})).rejects.toThrow(
          `${role} admission attestation failed for pid ${failedPid} (status: ${status}, inJob: false, verifiable: false, native readback failed)`,
        );
        expect(client.lifecycle).toBe("failed");
        expect(client.isDeliberateShutdown).toBe(false);
        expect(exitStates).toEqual(["failed"]);
        expect(client.isBootstrapVerified).toBe(false);
        expect(fake.business()).toBe("");
      } finally { await client.terminate(); }
    }, 5_000);
  }
}

test("fatal hello cancels admission while the supervisor identity probe is pending", async () => {
  const fake = capturedSupervisor();
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const client = new RuntimeWorkerClient("unused.mjs", "fatal-hello", undefined, undefined, {
    platform: "win32",
    spawnSupervisorProcess: (request) => { fake.auto(request.jobName); return fake.child; },
    probeWindowsIdentity: async (pid) => {
      entered.resolve();
      await gate.promise;
      return { status: "found", identity: { pid, creationDate: birthFor(pid) } };
    },
    querySupervisorContainment: async () => "empty",
    supervisorTerminationTimeoutMs: 500,
  });
  const result = client.request("ensure", {}).then(() => null, (error: unknown) => error);
  try {
    await entered.promise;
    fake.child.stderr!.write("XACPX_JOB_FATAL rejected hello\n");
    expect(await result).toMatchObject({ message: "XACPX_JOB_FATAL rejected hello" });
    expect(client.lifecycle).toBe("failed");
    expect(client.isBootstrapVerified).toBe(false);
    expect(fake.kills).toEqual(["SIGKILL"]);
    expect(fake.business()).toBe("");
  } finally { gate.resolve(); await client.terminate(); }
}, 5_000);

test("manager pending-admission deliberate stops do not consume the crash budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "supervisor-deliberate-budget-"));
  let spawns = 0;
  const entry = join(dir, "worker.mjs");
  await writeFile(entry, "throw new Error('fake supervisor owns spawning');\n");
  const manager = new RuntimeWorkerManager({
    entryPath: entry,
    maxRestartsPerWindow: 1,
    clientDeps: {
      platform: "win32",
      spawnSupervisorProcess: () => {
        const fake = capturedSupervisor();
        spawns++;
        return fake.child;
      },
      probeWindowsIdentity: async (pid) => ({ status: "found", identity: { pid, creationDate: birthFor(pid) } }),
      querySupervisorContainment: async () => "empty",
      supervisorTerminationTimeoutMs: 500,
    },
  });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const worker = manager.ensureWorker("deliberate-session");
      await worker.shutdown(50);
      expect(worker.lifecycle).toBe("stopped");
      expect(worker.isBootstrapVerified).toBe(false);
    }
    expect(spawns).toBe(3);
  } finally { await manager.shutdownAll(50); await rm(dir, { recursive: true, force: true }); }
}, 5_000);

for (const replacedPid of [41001, 41002]) {
  test(`admission attestation rejects a replaced pid ${replacedPid}`, async () => {
    const fake = capturedSupervisor();
    let admissionCalls = 0;
    const client = new RuntimeWorkerClient("unused.mjs", "birth-race", undefined, undefined, {
      platform: "win32",
      spawnSupervisorProcess: (request) => { fake.auto(request.jobName); return fake.child; },
      probeWindowsIdentity: async (pid) => ({ status: "found", identity: { pid, creationDate: birthFor(pid) } }),
      // A replaced supervisor birth differs from the pre-hello sample; a
      // replaced worker pid never joined this supervisor's Job.
      querySupervisorAttestation: async (_job, pids) => pids.map((pid) => pid === replacedPid
        ? { pid, inJob: replacedPid !== 41002, verifiable: true, status: "found" as const, creationDate: "replacement" }
        : { pid, inJob: true, verifiable: true, status: "found" as const, creationDate: birthFor(pid) }),
      querySupervisorContainment: async () => "empty",
      onIdentityVerified: () => { admissionCalls++; },
      supervisorTerminationTimeoutMs: 500,
      terminateProcessTree: async () => { throw new Error("historical tree termination must not run"); },
    });
    try {
      const failure = replacedPid === fake.child.pid
        ? "worker or supervisor identity changed during Job attestation"
        : `worker admission attestation failed for pid ${replacedPid} (not in Job)`;
      await expect(client.request("ensure", {})).rejects.toThrow(failure);
      expect(admissionCalls).toBe(0);
      expect(client.ref.jobAttested).toBe(false);
      expect(fake.business()).toBe("");
      expect(fake.kills).toContain("SIGKILL");
    } finally { await client.terminate(); }
  }, 5_000);
}

test("attested cleanup kills the captured supervisor and waits for empty Job", async () => {
  const fake = capturedSupervisor();
  let containment: "active" | "empty" = "active";
  const queried = Promise.withResolvers<void>();
  let historicalKills = 0;
  const client = new RuntimeWorkerClient("unused.mjs", "dead-root", undefined, undefined, {
    platform: "win32",
    spawnSupervisorProcess: (request) => { fake.auto(request.jobName); return fake.child; },
    probeWindowsIdentity: async (pid) => ({ status: "found", identity: { pid, creationDate: birthFor(pid) } }),
    querySupervisorAttestation: async (_job, pids) => pids.map((pid) => ({ pid, inJob: true, verifiable: true, status: "found" as const, creationDate: birthFor(pid) })),
    querySupervisorContainment: async () => { queried.resolve(); return containment; },
    supervisorTerminationTimeoutMs: 2_000,
    terminateProcessTree: async () => { historicalKills++; throw new Error("historical tree termination must not run"); },
  });
  client.spawn();
  try {
    await eventually(async () => client.isBootstrapVerified, Boolean, 1_000);
    // Cleanup authority is the captured supervisor plus the named Job; the
    // worker root is never re-probed or killed through a historical pid.
    let settled = false;
    const termination = client.terminate().then(() => { settled = true; });
    await queried.promise;
    expect(settled).toBe(false);
    expect(historicalKills).toBe(0);
    expect(fake.kills).toEqual(["SIGKILL"]);
    containment = "empty";
    await termination;
    expect(client.lifecycle).toBe("stopped");
  } finally { containment = "empty"; await client.terminate(); }
}, 5_000);

test("Job creation is never authorized before the supervisor birth is durable", async () => {
  const fake = capturedSupervisor();
  let authorized = false;
  void fake.go.promise.then(() => { authorized = true; });
  const client = new RuntimeWorkerClient("unused.mjs", "boot-gate", undefined, undefined, {
    platform: "win32",
    spawnSupervisorProcess: (request) => { fake.auto(request.jobName); return fake.child; },
    probeWindowsIdentity: async (pid) => ({ status: "found", identity: { pid, creationDate: birthFor(pid) } }),
    onSupervisorBoot: async () => {
      // The supervisor must still be waiting for GO while the fence is written.
      expect(authorized).toBe(false);
      throw new Error("fence write failed");
    },
    querySupervisorContainment: async () => "absent",
    supervisorTerminationTimeoutMs: 500,
  });
  const error = await client.request("ensure", {}).then(() => null, (failure: unknown) => failure);
  expect(error).toMatchObject({ message: "fence write failed" });
  const settled = Promise.withResolvers<void>();
  setImmediate(settled.resolve);
  await settled.promise;
  expect(authorized).toBe(false);
  expect(fake.business()).toBe("");
  await client.terminate();
}, 5_000);

const WORKER = String.raw`
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:net';
if (process.argv[2] === 'grandchild') { createServer().listen(0, '127.0.0.1'); }
else if (process.argv[2] === 'child') {
  const grandchild = spawn(process.execPath, [process.argv[1], 'grandchild'], { stdio: 'ignore', windowsHide: true });
  process.send({ childPid: process.pid, grandchildPid: grandchild.pid });
  createServer().listen(0, '127.0.0.1');
} else {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const message = JSON.parse(line);
    let result = message.params;
    if (message.params?.descendants) {
      const child = spawn(process.execPath, [process.argv[1], 'child'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
      const descendants = Promise.withResolvers();
      child.once('message', descendants.resolve);
      child.once('error', descendants.reject);
      result = await descendants.promise;
    }
    if (message.method === 'shutdown') appendFileSync(process.env.SHUTDOWN_LOG, 'graceful\n');
    const written = Promise.withResolvers();
    process.stdout.write(JSON.stringify({ id: message.id, ok: true, result }) + '\n', error => error ? written.reject(error) : written.resolve());
    await written.promise;
    if (message.method === 'shutdown') process.exit(0);
  }
}
`;

type Identity = { pid: number; creationDate: string };
async function identity(pid: number): Promise<Identity> {
  const result = await probeWindowsProcessIdentity(pid);
  if (result.status !== "found") throw new Error(`could not capture owned process ${pid}: ${result.status}`);
  return result.identity;
}
async function waitUntilGone(owned: Identity): Promise<void> {
  let observed: WindowsProbeStatus | undefined;
  try {
    await eventually(async () => {
      observed = await probeWindowsProcessIdentity(owned.pid);
      return observed.status === "missing" || (observed.status === "found" && observed.identity.creationDate !== owned.creationDate);
    }, Boolean);
  } catch (error) {
    throw new Error(`owned process cleanup unconfirmed: expected=${JSON.stringify(owned)} observed=${JSON.stringify(observed)}`, { cause: error });
  }
}

// These tests deliberately exercise PowerShell/.NET and the real Windows kernel Job API.
describe.skipIf(process.platform !== "win32")("native Windows supervisor", () => {
  for (const scenario of ["graceful", "worker crash", "supervisor crash"] as const) {
    test(`${scenario}: manager fences both births and leaves no descendants`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "native-job-supervisor-"));
      const entry = join(dir, "worker.mjs");
      const shutdownLog = join(dir, "shutdown.log");
      const fenceDir = join(dir, "fences");
      const handles: ChildProcess[] = [];
      const owned: Identity[] = [];
      const jobs: string[] = [];
      await writeFile(entry, WORKER);
      const manager = new RuntimeWorkerManager({
        entryPath: entry, fenceDir, maxRestartsPerWindow: 5,
        clientDeps: {
          windowsJobContainment: true,
          probeWindowsIdentity: probeWindowsProcessIdentity,
          querySupervisorContainment: queryJobContainment,
          supervisorTerminationTimeoutMs: 20_000,
          spawnEnv: { SHUTDOWN_LOG: shutdownLog },
          spawnSupervisorProcess: (request, env) => {
            jobs.push(request.jobName);
            const child = spawnWindowsSupervisor(request, env);
            handles.push(child);
            return child;
          },
        },
      });
      let primaryError: unknown;
      try {
        const worker = await manager.acquire("native-session");
        const text = "你好 🌍 café — 𝄞\nsecond line";
        expect(await worker.request("ensure", { text })).toEqual({ text });
        expect(worker.ref.supervisorPid).not.toBe(worker.ref.pid);
        expect(worker.ref.jobAttested).toBe(true);
        const root = await identity(worker.ref.pid);
        const supervisor = await identity(worker.ref.supervisorPid!);
        owned.push(root, supervisor);
        expect(root.creationDate).toBe(worker.ref.creationDate);
        expect(supervisor.creationDate).toBe(worker.ref.supervisorCreationDate);
        const fence = await new RuntimeWorkerFence(fenceDir).read("native-session");
        expect(fence.kind).toBe("present");
        if (fence.kind !== "present") throw new Error("admitted ownership fence missing");
        expect(fence.record).toMatchObject({ pid: root.pid, creationDate: root.creationDate, supervisorPid: supervisor.pid, supervisorCreationDate: supervisor.creationDate, jobAttested: true, jobName: worker.ref.jobName, bootstrapVerified: true });
        const descendants = await worker.request<{ childPid: number; grandchildPid: number }>("ensure", { descendants: true });
        owned.push(await identity(descendants.childPid), await identity(descendants.grandchildPid));
        expect(await queryJobContainment(worker.ref.jobName!)).toBe("active");
        if (scenario === "graceful") {
          await worker.shutdown(5_000);
          expect(await readFile(shutdownLog, "utf8")).toBe("graceful\n");
        } else {
          if (scenario === "worker crash") {
            // Recheck the captured birth immediately before injecting the crash.
            expect(await identity(root.pid)).toEqual(root);
            process.kill(root.pid, "SIGKILL");
          } else {
            handles[0]!.kill("SIGKILL");
          }
          await eventually(async () => worker.lifecycle, (state) => state === "stopped", 30_000);
        }
        for (const processIdentity of owned) await waitUntilGone(processIdentity);
        await eventually(() => queryJobContainment(worker.ref.jobName!), (state) => state === "empty" || state === "absent");
        const replacement = await manager.acquire("native-session");
        expect(replacement.ref.generation).not.toBe(worker.ref.generation);
        expect(await replacement.request("ensure", { text })).toEqual({ text });
        owned.push(await identity(replacement.ref.pid), await identity(replacement.ref.supervisorPid!));
        await manager.shutdownAll(5_000);
        for (const processIdentity of owned) await waitUntilGone(processIdentity);
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        // Captured ChildProcess handles remain authoritative even if admission failed.
        for (const child of handles) { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
        try {
          await manager.shutdownAll(500);
          for (const job of jobs) await eventually(() => queryJobContainment(job), (state) => state === "empty" || state === "absent");
          for (const processIdentity of owned) await waitUntilGone(processIdentity);
        } catch (cleanupError) {
          if (primaryError === undefined) throw cleanupError;
          console.error("supervisor cleanup after primary failure:", cleanupError);
        } finally { await rm(dir, { recursive: true, force: true }); }
      }
    }, 180_000);
  }
});
