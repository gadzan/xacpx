import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeWorkerFence } from "../../../src/bridge/engine/runtime/runtime-worker-fence";
import type { RuntimeWorkerFenceRecord } from "../../../src/bridge/engine/runtime/runtime-worker-fence";
import { decideSessionFenceRecovery, probeSessionFenceTarget, recoverSessionFence, resolveSessionFenceRecoveryTarget } from "../../../src/recovery/session-fence-recovery";
import type { SessionFenceRecoveryTarget } from "../../../src/recovery/session-fence-recovery";
import { windowsJobNameForGeneration } from "../../../src/process/windows-job-query";
import { physicalFenceKeyForSession } from "../../../src/bridge/engine/runtime/physical-session-identity";

const GENERATION = "ad82e355-391a-4a4a-a704-f317f587ce0f";
function record(overrides: Partial<RuntimeWorkerFenceRecord> = {}): RuntimeWorkerFenceRecord {
  return { kind: "runtime-worker-owner", logicalSessionId: "physical-key", generation: GENERATION, pid: 1234, creationDate: "133800000000000000", bootstrapVerified: true, phase: "admitted", startedAt: "2026-10-19T00:00:00.000Z", agent: "runtime-worker", ...overrides };
}
function target(dir: string, fenceRecord: RuntimeWorkerFenceRecord): SessionFenceRecoveryTarget {
  return { alias: "backend", logicalSession: {} as SessionFenceRecoveryTarget["logicalSession"], resolved: {} as SessionFenceRecoveryTarget["resolved"], fenceKey: fenceRecord.logicalSessionId, fenceDir: dir, fencePath: join(dir, `${encodeURIComponent(fenceRecord.logicalSessionId)}.json`), sharedAliases: [], fenceRecord };
}

test("legacy recovery requires explicit risk and rejects live or unknown worker", () => {
  const base = { record: record(), expectedGeneration: GENERATION, probe: { worker: "gone" as const, residualsRemaining: false, containment: null } };
  expect(decideSessionFenceRecovery(base)).toEqual({ kind: "refused", reason: "missing-legacy-risk-acceptance" });
  expect(decideSessionFenceRecovery({ ...base, acceptLegacyOrphanRisk: true }).kind).toBe("recoverable-legacy-orphan-risk");
  for (const worker of ["alive", "unknown"] as const) {
    expect(decideSessionFenceRecovery({ ...base, acceptLegacyOrphanRisk: true, probe: { ...base.probe, worker } }).kind).toBe("refused");
  }
});

test("legacy terminal recovery requires a gone worker before backing up or mutating", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-recovery-terminal-"));
  try {
    for (const phase of ["discharged", "spooled"] as const) {
      const snapshot = record({ phase });
      const selected = target(dir, snapshot);
      await new RuntimeWorkerFence(dir).write(snapshot);
      const before = await readFile(selected.fencePath);
      for (const worker of ["alive", "unknown"] as const) {
        const result = await recoverSessionFence({ target: selected, configPath: join(dir, "config.json"), expectedGeneration: GENERATION, acceptLegacyOrphanRisk: true, probe: { worker, residualsRemaining: false, containment: null } });
        expect(result.eligibility).toEqual({ kind: "refused", reason: worker === "alive" ? "worker-alive" : "worker-unknown" });
        expect(await readFile(selected.fencePath)).toEqual(before);
        expect((await readdir(dir)).filter((name) => name.includes(".bak-"))).toEqual([]);
      }
      const result = await recoverSessionFence({ target: selected, configPath: join(dir, "config.json"), expectedGeneration: GENERATION, probe: { worker: "gone", residualsRemaining: false, containment: null } });
      expect(result.eligibility).toEqual({ kind: "recoverable-terminal-proof" });
      expect(await new RuntimeWorkerFence(dir).read(snapshot.logicalSessionId)).toEqual({ kind: "absent" });
      await rm(result.backupPath!);
      await rm(`${result.backupPath}.audit.json`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("attested containment requires canonical name, empty Job and gone supervisor even for terminal fences", () => {
  for (const phase of ["admitted", "discharged", "spooled"] as const) {
    const input = { record: record({ phase, jobName: windowsJobNameForGeneration(GENERATION)!, jobAttested: true }), expectedGeneration: GENERATION, probe: { worker: "gone" as const, supervisor: "gone" as const, residualsRemaining: false, containment: "empty" as const } };
    expect(decideSessionFenceRecovery(input).kind).toMatch(/^recoverable-/);
    for (const containment of ["active", "unknown"] as const) expect(decideSessionFenceRecovery({ ...input, probe: { ...input.probe, containment } }).kind).toBe("refused");
    expect(decideSessionFenceRecovery({ ...input, probe: { ...input.probe, supervisor: "alive" } }).kind).toBe("refused");
    expect(decideSessionFenceRecovery({ ...input, record: { ...input.record, jobName: "wrong-job" } }).kind).toBe("refused");
  }
});

test("crashed pre-spawn claim is recoverable from canonical Job containment only", () => {
  const jobName = windowsJobNameForGeneration(GENERATION)!;
  // Claims are written before the supervisor exists: no supervisor birth and
  // no worker creation date. Gating them on either made the fence permanent.
  const claim = record({ phase: "claiming", jobName, jobAttested: false, creationDate: null, pid: 4242 });
  const input = { record: claim, expectedGeneration: GENERATION, probe: { worker: "gone" as const, residualsRemaining: null, containment: "absent" as const } };
  expect(decideSessionFenceRecovery(input)).toEqual({ kind: "recoverable-contained-proof" });
  expect(decideSessionFenceRecovery({ ...input, probe: { ...input.probe, containment: "empty" } }).kind).toBe("recoverable-contained-proof");
  for (const containment of ["active", "unknown"] as const) expect(decideSessionFenceRecovery({ ...input, probe: { ...input.probe, containment } }).kind).toBe("refused");
  for (const worker of ["alive", "unknown"] as const) expect(decideSessionFenceRecovery({ ...input, probe: { ...input.probe, worker } }).kind).toBe("refused");
  expect(decideSessionFenceRecovery({ ...input, record: { ...claim, jobName: "wrong-job" } }).kind).toBe("refused");
  // A claim without a Job name has no containment proof: it stays automatic-only.
  expect(decideSessionFenceRecovery({ ...input, record: { ...claim, jobName: undefined } })).toEqual({ kind: "refused", reason: "fence-not-admitted" });
});

test("stale generation and same-generation phase transition never mutate fence or create backup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-recovery-stale-"));
  try {
    const fence = new RuntimeWorkerFence(dir);
    const snapshot = record();
    for (const newer of [record({ generation: "successor" }), record({ phase: "spooled" }), record({ phase: "deleting" })]) {
      await fence.write(newer);
      const before = await readFile(target(dir, snapshot).fencePath);
      const result = await recoverSessionFence({ target: target(dir, snapshot), configPath: join(dir, "config.json"), expectedGeneration: GENERATION, acceptLegacyOrphanRisk: true, probe: { worker: "gone", residualsRemaining: false, containment: null } });
      expect(result.eligibility.kind).toBe("refused");
      expect(await readFile(target(dir, snapshot).fencePath)).toEqual(before);
      expect((await readdir(dir)).filter((name) => name.includes(".bak-"))).toEqual([]);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("successful recovery preserves exact backup bytes with separate valid audit JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-recovery-backup-"));
  try {
    const snapshot = record({ phase: "discharged" });
    const selected = target(dir, snapshot);
    const original = `  ${JSON.stringify(snapshot)}\n\n`;
    await writeFile(selected.fencePath, original);
    const result = await recoverSessionFence({ target: selected, configPath: join(dir, "config.json"), expectedGeneration: GENERATION, probe: { worker: "gone", residualsRemaining: null, containment: null }, now: () => "2026-10-20T00:00:00.000Z" });
    expect(result.eligibility.kind).toBe("recoverable-terminal-proof");
    expect(await readFile(result.backupPath!, "utf8")).toBe(original);
    expect(JSON.parse(await readFile(`${result.backupPath}.audit.json`, "utf8"))).toEqual({ attemptedAt: "2026-10-20T00:00:00.000Z", recoveredAt: "2026-10-20T00:00:00.000Z", outcome: "applied", recovery: "recoverable-terminal-proof", sessionAlias: "backend", generation: GENERATION });
    expect(await new RuntimeWorkerFence(dir).read(snapshot.logicalSessionId)).toEqual({ kind: "absent" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("malformed and unreadable residual evidence refuses spooled recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-recovery-residuals-"));
  try {
    const configPath = join(root, "config.json");
    const selected = target(root, record({ phase: "spooled" }));
    const residualDir = join(root, "runtime", "orphans", "residuals");
    await mkdir(residualDir, { recursive: true });
    for (const bytes of ["{broken", JSON.stringify({ generationId: GENERATION })]) {
      await writeFile(join(residualDir, "bad.json"), bytes);
      const probe = await probeSessionFenceTarget(selected, configPath, { probeWorker: () => "gone" });
      expect(decideSessionFenceRecovery({ record: selected.fenceRecord, expectedGeneration: GENERATION, probe })).toEqual({ kind: "refused", reason: "residuals-unreadable" });
    }
    await rm(join(residualDir, "bad.json"));
    await mkdir(join(residualDir, "bad.json"));
    expect((await probeSessionFenceTarget(selected, configPath, { probeWorker: () => "gone" })).residualsRemaining).toBeNull();
    await rm(residualDir, { recursive: true });
    const probe = await probeSessionFenceTarget(selected, configPath, { probeWorker: () => "gone" });
    expect(probe.residualsRemaining).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("inspect and recovery resolve aliases to the shared runtime physical fence using normalized config", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-recovery-alias-"));
  try {
    const configPath = join(root, "config.json");
    const statePath = join(root, "state.json");
    const cwd = join(root, "workspace");
    const fenceDir = join(root, "fences");
    await writeFile(configPath, JSON.stringify({ transport: {}, agents: { fixture: { driver: "fixture", argv: ["fixture-agent"] } }, workspaces: { backend: { cwd } } }));
    const sessions = Object.fromEntries(["backend", "backend-mirror"].map((alias, index) => [alias, { alias, agent: "fixture", workspace: "backend", transport_session: "shared-physical-session", logical_session_id: index === 0 ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222", transport_engine: "runtime", created_at: "2026-10-19T00:00:00.000Z", last_used_at: "2026-10-19T00:00:00.000Z" }]));
    await writeFile(statePath, JSON.stringify({ sessions }));
    const key = physicalFenceKeyForSession({ agent: "fixture", cwd, name: "shared-physical-session", agentCommand: "fixture-agent" });
    await new RuntimeWorkerFence(fenceDir).write(record({ logicalSessionId: key, phase: "discharged" }));
    const first = await resolveSessionFenceRecoveryTarget({ configPath, statePath, fenceDir, alias: "backend" });
    const mirror = await resolveSessionFenceRecoveryTarget({ configPath, statePath, fenceDir, alias: "backend-mirror" });
    if ("kind" in first || "kind" in mirror) throw new Error("expected both aliases to resolve");
    expect(first.fenceKey).toBe(key);
    expect(first.sharedAliases).toEqual(["backend-mirror"]);
    expect(mirror.fencePath).toBe(first.fencePath);
    expect(mirror.sharedAliases).toEqual(["backend"]);
    expect((await recoverSessionFence({ target: mirror, configPath, expectedGeneration: GENERATION, probe: { worker: "gone", residualsRemaining: null, containment: null } })).eligibility.kind).toBe("recoverable-terminal-proof");
    expect(await new RuntimeWorkerFence(fenceDir).read(key)).toEqual({ kind: "absent" });
    expect(JSON.parse(await readFile(statePath, "utf8")).sessions).toEqual(sessions);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("backup creation failure leaves the recoverable fence unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-recovery-backup-fail-"));
  const realOpen = fs.open;
  const open = spyOn(fs, "open");
  try {
    const snapshot = record({ phase: "discharged" });
    await new RuntimeWorkerFence(root).write(snapshot);
    const selected = target(root, snapshot);
    const before = await readFile(selected.fencePath);
    open.mockImplementation((...args) => {
      if (String(args[0]).includes(".bak-")) return Promise.reject(new Error("backup creation denied"));
      return realOpen(...args);
    });
    await expect(recoverSessionFence({ target: selected, configPath: join(root, "config.json"), expectedGeneration: GENERATION, probe: { worker: "gone", residualsRemaining: null, containment: null } })).rejects.toThrow("backup creation denied");
    expect(await readFile(selected.fencePath)).toEqual(before);
    expect((await readdir(root)).filter((name) => name.includes(".bak-"))).toEqual([]);
  } finally {
    open.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("backup sync failure preserves ownership and never writes a recovery audit", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-recovery-backup-sync-"));
  const realOpen = fs.open;
  const open = spyOn(fs, "open");
  let restoreSync: (() => void) | undefined;
  try {
    const snapshot = record({ phase: "discharged" });
    const selected = target(root, snapshot);
    await new RuntimeWorkerFence(root).write(snapshot);
    const before = await readFile(selected.fencePath);
    open.mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]).includes(".bak-")) {
        const sync = spyOn(handle, "sync").mockRejectedValue(new Error("backup sync failed"));
        restoreSync = () => sync.mockRestore();
      }
      return handle;
    });
    await expect(recoverSessionFence({ target: selected, configPath: join(root, "config.json"), expectedGeneration: GENERATION, probe: { worker: "gone", residualsRemaining: null, containment: null } })).rejects.toThrow("backup sync failed");
    expect(await readFile(selected.fencePath)).toEqual(before);
    const backups = (await readdir(root)).filter((name) => name.includes(".bak-"));
    expect(backups).toHaveLength(1);
    expect(backups[0]!.endsWith(".audit.json")).toBe(false);
    expect(await new RuntimeWorkerFence(root).read(snapshot.logicalSessionId)).toEqual({ kind: "present", record: snapshot });
  } finally {
    restoreSync?.();
    open.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("audit creation failure preserves the fence and its durable backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-recovery-audit-fail-"));
  const realOpen = fs.open;
  const open = spyOn(fs, "open");
  try {
    const snapshot = record({ phase: "discharged" });
    const selected = target(root, snapshot);
    await new RuntimeWorkerFence(root).write(snapshot);
    const before = await readFile(selected.fencePath);
    open.mockImplementation((...args) => {
      if (String(args[0]).endsWith(".audit.json")) return Promise.reject(new Error("audit creation denied"));
      return realOpen(...args);
    });
    await expect(recoverSessionFence({ target: selected, configPath: join(root, "config.json"), expectedGeneration: GENERATION, probe: { worker: "gone", residualsRemaining: null, containment: null } })).rejects.toThrow("audit creation denied");
    expect(await readFile(selected.fencePath)).toEqual(before);
    const backups = (await readdir(root)).filter((name) => name.includes(".bak-"));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(root, backups[0]!))).toEqual(before);
  } finally {
    open.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("CAS races refuse recovery after preserving a backup and an attempted audit", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-recovery-cas-race-"));
  const realCompareAndSwap = RuntimeWorkerFence.prototype.compareAndSwap;
  const cas = spyOn(RuntimeWorkerFence.prototype, "compareAndSwap");
  try {
    const fence = new RuntimeWorkerFence(root);
    const snapshot = record();
    const selected = target(root, snapshot);
    for (const successor of [record({ generation: "successor" }), record({ phase: "spooled" }), record({ phase: "deleting" })]) {
      await fence.write(snapshot);
      const before = await readFile(selected.fencePath);
      cas.mockImplementation(async function (key, expected, replacement) {
        const backups = (await readdir(root)).filter((name) => name.includes(".bak-") && !name.endsWith(".audit.json"));
        expect(backups).toHaveLength(1);
        const backupPath = join(root, backups[0]!);
        expect(await readFile(backupPath)).toEqual(before);
        expect(JSON.parse(await readFile(`${backupPath}.audit.json`, "utf8"))).toEqual({ attemptedAt: "2026-10-20T00:00:00.000Z", outcome: "attempted", recovery: "recoverable-legacy-orphan-risk", sessionAlias: "backend", generation: GENERATION });
        await fence.write(successor);
        return realCompareAndSwap.call(fence, key, expected, replacement);
      });
      const result = await recoverSessionFence({ target: selected, configPath: join(root, "config.json"), expectedGeneration: GENERATION, acceptLegacyOrphanRisk: true, probe: { worker: "gone", residualsRemaining: false, containment: null }, now: () => "2026-10-20T00:00:00.000Z" });
      expect(result.eligibility).toEqual({ kind: "refused", reason: "generation-mismatch" });
      expect(await fence.read(selected.fenceKey)).toEqual({ kind: "present", record: successor });
      expect(JSON.parse(await readFile(`${result.backupPath}.audit.json`, "utf8")).outcome).toBe("attempted");
      await rm(result.backupPath!);
      await rm(`${result.backupPath}.audit.json`);
    }
  } finally {
    cas.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("a successor before retire remains fenced with only an attempted recovery audit", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-recovery-retire-race-"));
  const realRetire = RuntimeWorkerFence.prototype.retire;
  const retire = spyOn(RuntimeWorkerFence.prototype, "retire");
  try {
    const fence = new RuntimeWorkerFence(root);
    const snapshot = record();
    const successor = record({ generation: "successor" });
    await fence.write(snapshot);
    retire.mockImplementation(async (key, generation, phase) => {
      await fence.write(successor);
      return realRetire.call(fence, key, generation, phase);
    });
    const result = await recoverSessionFence({ target: target(root, snapshot), configPath: join(root, "config.json"), expectedGeneration: GENERATION, acceptLegacyOrphanRisk: true, probe: { worker: "gone", residualsRemaining: false, containment: null } });
    expect(result.eligibility).toEqual({ kind: "refused", reason: "generation-mismatch" });
    expect(await fence.read(snapshot.logicalSessionId)).toEqual({ kind: "present", record: successor });
    expect(JSON.parse(await readFile(result.backupPath!, "utf8"))).toEqual(snapshot);
    expect(JSON.parse(await readFile(`${result.backupPath}.audit.json`, "utf8")).outcome).toBe("attempted");
  } finally {
    retire.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
