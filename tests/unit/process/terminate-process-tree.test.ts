import { describe, expect, test } from "bun:test";

import { terminateProcessTree } from "../../../src/process/terminate-process-tree";

function posixError(code: string): Error {
  const error = new Error(code) as Error & { code?: string };
  error.code = code;
  return error;
}

describe("terminateProcessTree POSIX fail-closed (round 29 Blocking 4)", () => {
  test("SIGTERM hitting an already-exited group (ESRCH) resolves", async () => {
    let kills = 0;
    await expect(terminateProcessTree(
      4242,
      { detachedProcessGroup: true },
      "darwin",
      undefined,
      () => { kills += 1; throw posixError("ESRCH"); },
      () => true,
    )).resolves.toBeUndefined();
    expect(kills).toBe(1);
  });

  test("SIGTERM failing with a non-ESRCH error REJECTS — ownership never reads discharged", async () => {
    let checks = 0;
    await expect(terminateProcessTree(
      4242,
      { detachedProcessGroup: true },
      "darwin",
      undefined,
      () => { throw posixError("EPERM"); },
      () => { checks += 1; return true; },
    )).rejects.toMatchObject({ code: "EPERM" });
    // The EPERM path probed the reaping window (group stayed alive) before
    // failing closed — the checks prove the window ran.
    expect(checks).toBeGreaterThan(0);
  });

  test("SIGKILL delivers but the group survives → REJECTS with a verified-discharge refusal", async () => {
    // Real platform-clock polling (2 × 5s windows) is the behavior under
    // test — a fake clock cannot stand in for the live wait loop.
    let killed = false;
    const signals: string[] = [];
    await expect(terminateProcessTree(
      4242,
      { detachedProcessGroup: true },
      "darwin",
      undefined,
      (_pid, signal) => {
        signals.push(signal);
        killed = signal === "SIGKILL";
      },
      () => true,
    )).rejects.toThrow(/did not terminate after SIGKILL/);
    expect(signals).toContain("SIGKILL");
  }, 20_000);
});
