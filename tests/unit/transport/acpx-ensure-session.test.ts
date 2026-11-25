import { expect, test } from "bun:test";

import {
  runEnsureSessionFlow,
  type EnsureCommandResult,
  type EnsureSessionFlowDeps,
  type EnsureSessionFlowPolicy,
} from "../../../src/transport/acpx-ensure-session";
import { CommandTimeoutError } from "../../../src/transport/command-timeouts";

const ok: EnsureCommandResult = { code: 0, stdout: "", stderr: "" };
const fail = (marker: string): EnsureCommandResult => ({ code: 1, stdout: "", stderr: marker });

function deps(overrides: Partial<EnsureSessionFlowDeps> = {}): EnsureSessionFlowDeps & { calls: string[] } {
  const calls: string[] = [];
  const named = <K extends "runEnsure" | "runShow" | "runCreate">(name: K, fn: EnsureSessionFlowDeps[K]) =>
    (async (...args: never[]) => {
      calls.push(name === "runEnsure" ? "ensure" : name === "runShow" ? "show" : "create");
      return (fn as (...a: never[]) => Promise<EnsureCommandResult>)(...args);
    }) as EnsureSessionFlowDeps[K];
  return {
    calls,
    migrateLegacyArgv: async () => { calls.push("migrate"); },
    runEnsure: async () => { calls.push("ensure"); return ok; },
    runShow: async () => { calls.push("show"); return fail("missing"); },
    runCreate: async () => { calls.push("create"); return ok; },
    repairSessionIndex: async () => { calls.push("repair"); return true; },
    ...Object.fromEntries(
      Object.entries(overrides).map(([key, fn]) =>
        key === "runEnsure" || key === "runShow" || key === "runCreate"
          ? [key, named(key, fn as never)]
          : [key, fn],
      ),
    ),
  } as EnsureSessionFlowDeps & { calls: string[] };
}

function cliPolicy(overrides: Partial<EnsureSessionFlowPolicy> = {}): EnsureSessionFlowPolicy {
  return {
    sessionName: "backend:demo",
    sessionInitTimeoutMs: 120_000,
    showTimeoutCapMs: 30_000,
    verboseFallback: false,
    epermRepair: false,
    tolerateEnsureFailure: true,
    tolerateShowFailure: true,
    mapTimeoutError: (error) => { throw error; },
    ...overrides,
  };
}

function bridgePolicy(overrides: Partial<EnsureSessionFlowPolicy> = {}): EnsureSessionFlowPolicy {
  return {
    sessionName: "backend:demo",
    sessionInitTimeoutMs: 120_000,
    verboseFallback: true,
    epermRepair: true,
    tolerateEnsureFailure: false,
    tolerateShowFailure: false,
    mapTimeoutError: () => { throw new Error("session initialization timed out after 120s"); },
    ...overrides,
  };
}

test("CLI tolerates thrown ensure/show failures and falls through to create", async () => {
  const d = deps({
    runEnsure: async () => { throw new Error("ensure failed"); },
    runShow: async () => { throw new Error("show failed"); },
  });
  const outcome = await runEnsureSessionFlow(d, cliPolicy());
  expect(outcome).toEqual({ ok: true });
  expect(d.calls).toEqual(["migrate", "ensure", "show", "create"]);
});

test("CLI returns the settled pair when creation fails", async () => {
  const d = deps({
    runEnsure: async () => fail("nope"),
    runCreate: async () => fail("boom"),
  });
  const outcome = await runEnsureSessionFlow(d, cliPolicy());
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("unreachable");
  expect(outcome.failure.created).toEqual(fail("boom"));
});

test("CLI passes the management cap (not the full budget) to the show probe", async () => {
  const seen: number[] = [];
  const d = deps({
    runEnsure: async () => fail("nope"),
    runShow: async (_tail, opts) => { seen.push(opts.timeoutMs); return fail("missing"); },
  });
  await runEnsureSessionFlow(d, cliPolicy());
  expect(seen).toHaveLength(1);
  expect(seen[0]).toBeLessThanOrEqual(30_000);
});

test("bridge retries ensure once without --verbose on unknown option", async () => {
  const seen: boolean[] = [];
  const states: Array<boolean | undefined> = [];
  const d = deps({
    runEnsure: async (_tail, opts) => {
      seen.push(opts.verbose);
      return seen.length === 1 ? fail("error: unknown option '--verbose'") : ok;
    },
  });
  const outcome = await runEnsureSessionFlow(d, bridgePolicy({
    isVerboseSupported: () => undefined,
    setVerboseSupported: (v) => { states.push(v); },
  }));
  expect(outcome).toEqual({ ok: true });
  expect(seen).toEqual([true, false]);
  expect(states).toEqual([false]);
});

test("bridge propagates show-probe failures instead of creating", async () => {
  const d = deps({
    runEnsure: async () => fail("nope"),
    runShow: async () => { throw new Error("show exploded"); },
  });
  await expect(runEnsureSessionFlow(d, bridgePolicy())).rejects.toThrow("show exploded");
  expect(d.calls).not.toContain("create");
});

test("bridge maps mid-flow timeouts to its session-init error", async () => {
  const d = deps({
    runEnsure: async () => { throw new CommandTimeoutError(1, "sessions ensure"); },
  });
  await expect(runEnsureSessionFlow(d, bridgePolicy())).rejects.toThrow(
    "session initialization timed out after 120s",
  );
});

test("bridge repairs an EPERM-torn index and re-probes before failing", async () => {
  const d = deps({
    runEnsure: async () => fail("nope"),
    runShow: async () => fail("missing"),
    runCreate: async () => fail("EPERM: operation not permitted"),
  });
  const outcome = await runEnsureSessionFlow(d, bridgePolicy());
  expect(outcome.ok).toBe(false);
  expect(d.calls).toEqual(["migrate", "ensure", "show", "create", "repair", "show"]);
});
