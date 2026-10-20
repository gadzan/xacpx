import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionFenceCliArgs, runSessionFenceCli } from "../../../src/recovery/session-fence-cli";
import { createRuntimeConsumerLock } from "../../../src/daemon/runtime-consumer-lock";
import { resolveRuntimeConsumerLockPath, resolveRuntimeDirFromConfigPath } from "../../../src/daemon/daemon-files";
import { RuntimeWorkerFence } from "../../../src/bridge/engine/runtime/runtime-worker-fence";
import type { RuntimeWorkerFenceRecord } from "../../../src/bridge/engine/runtime/runtime-worker-fence";
import { physicalFenceKeyForSession } from "../../../src/bridge/engine/runtime/physical-session-identity";
import * as windowsProcesses from "../../../src/process/windows-process-tree";

test("session CLI accepts inspect and generation-guarded recovery", () => {
  expect(parseSessionFenceCliArgs(["inspect", "backend"])).toEqual({ inspect: "backend" });
  expect(parseSessionFenceCliArgs(["recover", "backend", "--expected-generation", "gen", "--accept-legacy-orphan-risk"])).toEqual({ recover: "backend", expectedGeneration: "gen", acceptLegacyOrphanRisk: true });
});

test("session CLI rejects duplicate actions, duplicate flags, missing values and action-like aliases", () => {
  for (const args of [
    [], ["inspect"], ["recover", "backend"], ["inspect", "inspect"], ["inspect", "recover"],
    ["inspect", "backend", "inspect", "other"], ["recover", "backend", "--expected-generation", "gen", "recover", "other"],
    ["recover", "backend", "--expected-generation", "gen", "--expected-generation", "other"],
    ["recover", "backend", "--expected-generation", "--accept-legacy-orphan-risk"],
    ["recover", "backend", "--expected-generation", "gen", "--accept-legacy-orphan-risk", "--accept-legacy-orphan-risk"],
    ["inspect", "backend", "--fence-dir", "--durable-dir", "other"],
    ["inspect", "backend", "--fence-dir", "one", "--fence-dir", "two"],
    ["inspect", "backend", "--expected-generation", "gen"], ["inspect", "backend", "--accept-legacy-orphan-risk"],
    ["inspect", "backend", "--unknown"],
  ]) expect(parseSessionFenceCliArgs(args)).toBeNull();
});

test("recover refuses an active runtime through the real Windows IPC guard before reading state", async () => {
  if (process.platform !== "win32") return;
  const home = await mkdtemp(join(tmpdir(), "session-recovery-lock-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const configPath = join(home, ".xacpx", "config.json");
  const statePath = join(home, ".xacpx", "state.json");
  const oldConfig = process.env.XACPX_CONFIG;
  const oldState = process.env.XACPX_STATE;
  process.env.XACPX_CONFIG = configPath;
  process.env.XACPX_STATE = statePath;
  const held = createRuntimeConsumerLock({ lockFilePath: resolveRuntimeConsumerLockPath(resolveRuntimeDirFromConfigPath(configPath)) });
  try {
    await held.acquire({ pid: process.pid, mode: "foreground", startedAt: new Date().toISOString(), configPath, statePath });
    const output: string[] = [];
    const code = await runSessionFenceCli(["recover", "backend", "--expected-generation", "gen"], { print: (line) => output.push(line), stderr: (line) => output.push(line) });
    expect(code).toBe(1);
    expect(output.length).toBeGreaterThan(0);
  } finally {
    await held.release();
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldConfig === undefined) delete process.env.XACPX_CONFIG;
    else process.env.XACPX_CONFIG = oldConfig;
    if (oldState === undefined) delete process.env.XACPX_STATE;
    else process.env.XACPX_STATE = oldState;
    await rm(home, { recursive: true, force: true });
  }
});

test("recover CLI reports a CAS race as refusal, preserves the attempted backup and releases its lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-recovery-cli-cas-"));
  const configPath = join(root, "config.json");
  const statePath = join(root, "state.json");
  const oldConfig = process.env.XACPX_CONFIG;
  const oldState = process.env.XACPX_STATE;
  process.env.XACPX_CONFIG = configPath;
  process.env.XACPX_STATE = statePath;
  const realCompareAndSwap = RuntimeWorkerFence.prototype.compareAndSwap;
  const cas = spyOn(RuntimeWorkerFence.prototype, "compareAndSwap");
  const probe = spyOn(windowsProcesses, "probeWindowsProcessIdentity").mockResolvedValue({ status: "missing" });
  const held = createRuntimeConsumerLock({ lockFilePath: resolveRuntimeConsumerLockPath(resolveRuntimeDirFromConfigPath(configPath)) });
  try {
    const cwd = join(root, "workspace");
    const fenceDir = join(root, "fences");
    await writeFile(configPath, JSON.stringify({ transport: {}, agents: { fixture: { driver: "fixture", argv: ["fixture-agent"] } }, workspaces: { backend: { cwd } } }));
    await writeFile(statePath, JSON.stringify({ sessions: { backend: { alias: "backend", agent: "fixture", workspace: "backend", transport_session: "shared-physical-session", logical_session_id: "11111111-1111-4111-8111-111111111111", transport_engine: "runtime", created_at: "2026-10-19T00:00:00.000Z", last_used_at: "2026-10-19T00:00:00.000Z" } } }));
    const key = physicalFenceKeyForSession({ agent: "fixture", cwd, name: "shared-physical-session", agentCommand: "fixture-agent" });
    const snapshot: RuntimeWorkerFenceRecord = { kind: "runtime-worker-owner", logicalSessionId: key, generation: "ad82e355-391a-4a4a-a704-f317f587ce0f", pid: 1234, creationDate: "133800000000000000", bootstrapVerified: true, phase: "discharged", startedAt: "2026-10-19T00:00:00.000Z", agent: "runtime-worker" };
    const successor = { ...snapshot, generation: "successor" };
    const fence = new RuntimeWorkerFence(fenceDir);
    await fence.write(snapshot);
    cas.mockImplementation(async (fenceKey, expected, replacement) => {
      await fence.write(successor);
      return realCompareAndSwap.call(fence, fenceKey, expected, replacement);
    });
    const output: string[] = [];
    const code = await runSessionFenceCli(["recover", "backend", "--expected-generation", snapshot.generation, "--fence-dir", fenceDir], { print: (line) => output.push(line) });
    expect(code).toBe(1);
    expect(output[0]).toBe("recovery refused: generation-mismatch");
    expect(output.some((line) => line.startsWith("recovery applied:"))).toBe(false);
    const backupLine = output.find((line) => line.startsWith("fence backup: "));
    if (!backupLine) throw new Error("expected CLI to report preserved backup");
    const backupPath = backupLine.slice("fence backup: ".length);
    expect(JSON.parse(await readFile(backupPath, "utf8"))).toEqual(snapshot);
    expect(JSON.parse(await readFile(`${backupPath}.audit.json`, "utf8")).outcome).toBe("attempted");
    expect(await fence.read(key)).toEqual({ kind: "present", record: successor });
    await held.acquire({ pid: process.pid, mode: "foreground", startedAt: new Date().toISOString(), configPath, statePath });
  } finally {
    await held.release();
    probe.mockRestore();
    cas.mockRestore();
    if (oldConfig === undefined) delete process.env.XACPX_CONFIG;
    else process.env.XACPX_CONFIG = oldConfig;
    if (oldState === undefined) delete process.env.XACPX_STATE;
    else process.env.XACPX_STATE = oldState;
    await rm(root, { recursive: true, force: true });
  }
});

test("recover refuses on non-Windows with a platform message instead of probing", async () => {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await runSessionFenceCli(["recover", "backend", "--expected-generation", "gen"], {
    print: (line) => { lines.push(line); },
    stderr: (text) => { errors.push(text); },
    platform: "linux",
  });
  expect(code).toBe(1);
  expect(errors.join("")).toContain("requires Windows");
  expect(lines).toEqual([]);
});
