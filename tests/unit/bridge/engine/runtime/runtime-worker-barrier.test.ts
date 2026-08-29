import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RuntimeWorkerClient, WorkerBootstrapError } from "../../../../../src/bridge/engine/runtime/runtime-worker-client";
import type { RuntimeWorkerClientDeps } from "../../../../../src/bridge/engine/runtime/runtime-worker-client";

const FAKE_WORKER = [
  "let buffer='';",
  "let seen = 0;",
  "process.stdin.on('data', (d) => {",
  "  buffer += d.toString();",
  "  let idx;",
  "  while ((idx = buffer.indexOf('\\n')) >= 0) {",
  "    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);",
  "    if (!line) continue;",
  "    try { const msg = JSON.parse(line);",
  "      if (msg.method === 'ensure') seen += 1;",
  "      process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true, seen } }) + '\\n');",
  "      if (msg.method === 'shutdown') process.exit(0);",
  "    } catch {}",
  "  }",
  "});",
].join("\n");

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("durable admission barrier: ensure is BLOCKED until the verified fence write resolves (round 30 Blocking 2)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-barrier-block-"));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await writeFile(entry, FAKE_WORKER);
    const barrier = deferred();
    const deps: RuntimeWorkerClientDeps = {
      platform: "win32",
      probeWindowsIdentity: async (pid) => ({
        status: "found",
        identity: { pid, creationDate: "133800000000000000", executablePath: "C:\\w.exe" },
      }),
      onIdentityVerified: () => barrier.promise,
    };
    const client = new RuntimeWorkerClient(entry, "barrier-1", undefined, undefined, deps);
    client.spawn();
    try {
      // Probe resolves fast; the (fake) durable fence write is still pending.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(client.ref.creationDate).toBe("133800000000000000");
      expect(client.isBootstrapVerified).toBe(false);

      const ensure = client.request<{ seen: number }>("ensure", {});
      const race = await Promise.race([
        ensure.then(() => "entered" as const),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 300)),
      ]);
      // The business RPC must NOT reach the worker while the fence write is
      // in flight — an adapter spawned in that window would outlive a host
      // crash with a fence that reads "never verified".
      expect(race).toBe("blocked");

      barrier.resolve();
      const result = await ensure;
      expect(result.seen).toBe(1);
      expect(client.isBootstrapVerified).toBe(true);
    } finally {
      await client.shutdown().catch(() => {});
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("durable admission barrier: a failing fence write rejects bootstrap, kills the worker, no RPC entered (round 30 Blocking 2)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-barrier-fail-"));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await writeFile(entry, FAKE_WORKER);
    const barrier = deferred();
    const deps: RuntimeWorkerClientDeps = {
      platform: "win32",
      probeWindowsIdentity: async (pid) => ({
        status: "found",
        identity: { pid, creationDate: "133800000000000000", executablePath: "C:\\w.exe" },
      }),
      onIdentityVerified: () => barrier.promise,
    };
    const client = new RuntimeWorkerClient(entry, "barrier-2", undefined, undefined, deps);
    client.spawn();
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      barrier.reject(new Error("fence disk full"));
      const error = await client.request("ensure", {}).catch((e) => e);
      expect(error).toBeInstanceOf(WorkerBootstrapError);
      expect(error.message).toContain("fence disk full");
      // Fail closed: no business RPC entered a worker whose ownership fence
      // could not be made durable, and the worker is terminated.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(client.alive).toBe(false);
      expect(client.lifecycle).toBe("failed");
    } finally {
      await client.shutdown().catch(() => {});
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
