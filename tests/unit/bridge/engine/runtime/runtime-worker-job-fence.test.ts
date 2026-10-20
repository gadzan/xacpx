import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RuntimeWorkerFence, dischargeRuntimeWorkerFence, StaleFenceGenerationError, type RuntimeWorkerFenceRecord } from "../../../../../src/bridge/engine/runtime/runtime-worker-fence";
import { windowsJobNameForGeneration } from "../../../../../src/process/windows-job-query";

function record(phase: RuntimeWorkerFenceRecord["phase"] = "admitted"): RuntimeWorkerFenceRecord {
  const generation = randomUUID();
  return { kind: "runtime-worker-owner", logicalSessionId: "job-session", generation, pid: 1234, creationDate: "134368643730771264", bootstrapVerified: true, phase, startedAt: new Date().toISOString(), agent: "runtime-worker", jobName: windowsJobNameForGeneration(generation)!, jobAttested: true, supervisorPid: 4321, supervisorCreationDate: "134368643730771200" };
}

test("attested discharge requires gone worker and supervisor plus empty or absent generation Job", async () => {
  for (const phase of ["admitted", "discharging", "spooled", "discharged"] as const) {
    for (const worker of ["alive", "unknown", "gone"] as const) {
      for (const supervisor of ["alive", "unknown", "gone"] as const) {
        for (const containment of ["active", "unknown", "empty", "absent"] as const) {
          const current = record(phase);
          let marked = false;
          const outcome = await dischargeRuntimeWorkerFence(current, {
            platform: "win32", selfDischargeWaitMs: 0,
            probeWorker: async () => worker,
            probeSupervisor: async () => supervisor,
            probeJobContainment: async () => containment,
            markDischarged: async (next, from) => {
              expect(next.generation).toBe(current.generation);
              expect(from).toEqual([phase]);
              marked = true;
            },
          });
          const dischargeable = worker === "gone" && supervisor === "gone" && (containment === "empty" || containment === "absent");
          expect(outcome).toBe(dischargeable ? "discharged" : "refused");
          expect(marked).toBe(dischargeable);
        }
      }
    }
  }
});

test("a supervisor that may still create its Job keeps the pre-admission fence", async () => {
  const current = { ...record("claiming"), bootstrapVerified: false, jobAttested: false };
  expect(await dischargeRuntimeWorkerFence(current, {
    platform: "win32", selfDischargeWaitMs: 0,
    probeClaimant: async () => "gone", probeSupervisor: async () => "unknown",
    probeJobContainment: async () => "absent",
  })).toBe("refused");
});

test("a live supervisor that has not created its Job yet keeps the fence", async () => {
  // GO-gate crash window: the supervisor process exists, it was persisted
  // without a birth, and its Job may appear at any moment. Job "absent" is
  // NOT proof while that process lives.
  const current = { ...record("claiming"), bootstrapVerified: false, jobAttested: false, supervisorPid: 7777, supervisorCreationDate: undefined };
  for (const supervisor of ["alive", "unknown"] as const) {
    expect(await dischargeRuntimeWorkerFence(current, {
      platform: "win32", selfDischargeWaitMs: 0,
      probeClaimant: async () => "gone", probeSupervisor: async () => supervisor,
      probeJobContainment: async () => "absent",
      markDischarged: async () => { throw new Error("must not discharge while the supervisor may act"); },
    })).toBe("refused");
  }
});

test("a claim with no supervisor pid cannot have been authorized to create its Job", async () => {
  const current = {
    ...record("claiming"), bootstrapVerified: false, jobAttested: false,
    pid: 4242, supervisorPid: undefined, supervisorCreationDate: undefined,
  };
  let marked = 0;
  // No injected supervisor probe: the default must treat "no pid" as gone,
  // because the GO gate forbids Job creation before the host records one.
  expect(await dischargeRuntimeWorkerFence(current, {
    platform: "win32", selfDischargeWaitMs: 0,
    probeClaimant: async () => "gone",
    probeJobContainment: async () => "absent",
    markDischarged: async () => { marked++; },
  })).toBe("discharged");
  expect(marked).toBe(1);
  expect(await dischargeRuntimeWorkerFence(current, {
    platform: "win32", selfDischargeWaitMs: 0,
    probeClaimant: async () => "gone",
    probeJobContainment: async () => "active",
  })).toBe("refused");
});

test("owned and discharged fences without a supervisor birth stay recoverable", async () => {
  for (const phase of ["owned", "discharged"] as const) {
    const current = { ...record(phase), bootstrapVerified: false, jobAttested: false, supervisorPid: 7777, supervisorCreationDate: undefined };
    let marked = 0;
    expect(await dischargeRuntimeWorkerFence(current, {
      platform: "win32", selfDischargeWaitMs: 0,
      probeSupervisor: async () => "gone", probeJobContainment: async () => "absent",
      markDischarged: async () => { marked++; },
    })).toBe("discharged");
    expect(marked).toBe(1);
    expect(await dischargeRuntimeWorkerFence(current, {
      platform: "win32", selfDischargeWaitMs: 0,
      probeSupervisor: async () => "alive", probeJobContainment: async () => "absent",
    })).toBe("refused");
  }
});

test("live attested worker cannot release its fence even if Job lookup reports absent", async () => {
  expect(await dischargeRuntimeWorkerFence(record(), {
    platform: "win32", selfDischargeWaitMs: 0,
    probeWorker: async () => "alive", probeSupervisor: async () => "gone", probeJobContainment: async () => "absent",
  })).toBe("refused");
});

test("phase guarded retirement and worker marks preserve deletion and terminal evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "job-fence-guards-"));
  try {
    const fence = new RuntimeWorkerFence(dir);
    const current = record("deleting");
    await fence.write(current);
    await expect(fence.retire(current.logicalSessionId, current.generation, "discharged")).rejects.toBeInstanceOf(StaleFenceGenerationError);
    expect(await fence.markPhase(current.logicalSessionId, current.generation, "discharged")).toBe("stale");
    expect(await fence.read(current.logicalSessionId)).toEqual({ kind: "present", record: current });
    const terminal = { ...current, phase: "discharged" as const };
    await fence.write(terminal);
    expect(await fence.markPhase(current.logicalSessionId, current.generation, "discharging")).toBe("updated");
    expect(await fence.read(current.logicalSessionId)).toEqual({ kind: "present", record: terminal });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
