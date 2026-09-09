import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createXacpxRuntimeAdapter, type XacpxRuntimeAdapter, type XacpxRuntimeSessionHandle } from "../../../../../src/bridge/engine/runtime/runtime-adapter";

/**
 * PR A6 gate: acpx 0.15.1 default 64 MiB incoming ACP message ceiling.
 * The limit is read once at Runtime construction (warm owners retain their
 * startup setting); the agent → acpx direction is what is capped, not the
 * user prompt. Uses a dedicated huge-chunk mock agent so no giant prompt is
 * ever sent — only the inbound frame size varies.
 */
const HUGE_AGENT = resolve(import.meta.dir, "../../../../fixtures/mock-acp-huge-agent.mjs");
const MIB = 1024 * 1024;

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) {
    saved.set(key, process.env[key]);
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  // The huge agent reads its chunk size from its own environment at spawn.
  saved.set("HUGE_BYTES", process.env.HUGE_BYTES);
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function runHugeTurn(stateDir: string, chunkBytes: number, sessionKey: string) {
  process.env.HUGE_BYTES = String(chunkBytes);
  const adapter = createXacpxRuntimeAdapter({
    stateDir,
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    agentOverrides: { huge: [process.execPath, HUGE_AGENT] },
  });
  const handle = await adapter.ensure({ sessionKey, agent: "huge", cwd: stateDir });
  const turn = adapter.startTurn({ handle, text: "go" });
  await turn.promptStarted;
  for await (const _event of turn.events) {
    /* drain */
  }
  const result = await turn.result;
  await adapter.close(handle, { discardPersistentState: true }).catch(() => {});
  return result;
}

test("below the default 64 MiB cap a large inbound chunk completes", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "xacpx-limit-below-"));
  try {
    await withEnv({ ACPX_MAX_ACP_MESSAGE_BYTES: undefined }, async () => {
      const result = await runHugeTurn(stateDir, MIB, "below-cap");
      expect(result.status).toBe("completed");
    });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}, 60_000);

test("above the default cap the turn fails with an actionable overflow error", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "xacpx-limit-over-"));
  try {
    await withEnv({ ACPX_MAX_ACP_MESSAGE_BYTES: undefined }, async () => {
      const result = await runHugeTurn(stateDir, 64 * MIB + 1, "above-cap");
      expect(result.status).toBe("failed");
      const message = result.status === "failed" ? result.error.message : "";
      expect(message).toContain("ACPX_MAX_ACP_MESSAGE_BYTES");
      expect(message).toContain("67108864");
    });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}, 120_000);

test("raising the override fixes new runtimes; warm runtimes retain startup setting", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "xacpx-limit-warm-"));
  const savedLimit = process.env.ACPX_MAX_ACP_MESSAGE_BYTES;
  const savedHuge = process.env.HUGE_BYTES;
  const runTurn = async (adapter: XacpxRuntimeAdapter, handle: XacpxRuntimeSessionHandle) => {
    const turn = adapter.startTurn({ handle, text: "go" });
    await turn.promptStarted;
    for await (const _event of turn.events) {
      /* drain */
    }
    return turn.result;
  };
  const makeAdapter = () => createXacpxRuntimeAdapter({
    stateDir,
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    agentOverrides: { huge: [process.execPath, HUGE_AGENT] },
  });
  try {
    process.env.HUGE_BYTES = String(2 * MIB);
    // One adapter constructed under a 1 MiB ceiling fails a 2 MiB chunk...
    process.env.ACPX_MAX_ACP_MESSAGE_BYTES = String(MIB);
    const adapter = makeAdapter();
    const handle = await adapter.ensure({ sessionKey: "warm-same", agent: "huge", cwd: stateDir });
    expect((await runTurn(adapter, handle)).status).toBe("failed");
    // ...and STILL enforces 1 MiB after the process env moves to 8 MiB: the
    // warm runtime retains its construction-time setting. (On a session
    // reused after a limit failure the ceiling surfaces as a thrown
    // ACP_MESSAGE_TOO_LARGE rather than a failed result — either way the
    // raised env did not take effect. Re-ensure mirrors engine behavior and
    // returns the same warm handle.)
    process.env.ACPX_MAX_ACP_MESSAGE_BYTES = String(8 * MIB);
    const warmHandle = await adapter.ensure({ sessionKey: "warm-same", agent: "huge", cwd: stateDir });
    let retained = false;
    try {
      retained = (await runTurn(adapter, warmHandle)).status === "failed";
    } catch (error) {
      retained = (error as { detailCode?: unknown })?.detailCode === "ACP_MESSAGE_TOO_LARGE";
    }
    expect(retained).toBe(true);
    // A freshly constructed runtime picks the new ceiling up.
    const fresh = makeAdapter();
    const freshHandle = await fresh.ensure({ sessionKey: "warm-fresh", agent: "huge", cwd: stateDir });
    expect((await runTurn(fresh, freshHandle)).status).toBe("completed");
    await fresh.close(freshHandle, { discardPersistentState: true }).catch(() => {});
  } finally {
    if (savedLimit === undefined) delete process.env.ACPX_MAX_ACP_MESSAGE_BYTES;
    else process.env.ACPX_MAX_ACP_MESSAGE_BYTES = savedLimit;
    if (savedHuge === undefined) delete process.env.HUGE_BYTES;
    else process.env.HUGE_BYTES = savedHuge;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 180_000);

test("0 disables the incoming limit (isolated)", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "xacpx-limit-zero-"));
  try {
    await withEnv({ ACPX_MAX_ACP_MESSAGE_BYTES: "0" }, async () => {
      const result = await runHugeTurn(stateDir, 2 * MIB, "zero-cap");
      expect(result.status).toBe("completed");
    });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}, 60_000);
