import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { createXacpxRuntimeAdapter } from "../../../../../src/bridge/engine/runtime/runtime-adapter";
// Plan Task 1 / PR0 gate: prove the packaged acpx 0.13.1 Runtime public contract
// works end-to-end from xacpx — import → createRuntime → ensureSession →
// startTurn → completed result — against tests/fixtures/mock-acp-agent.mjs,
// with zero upstream modification. The session record must be visible through
// the same stateDir store the CLI uses (record compatibility, plan §12).
const MOCK_AGENT = resolve(import.meta.dir, "../../../../fixtures/mock-acp-agent.mjs");

const acpxAvailable = (() => {
  try {
    void resolve(import.meta.dir, "../../../../node_modules/acpx/dist/runtime.js");
    return true;
  } catch {
    return false;
  }
})();

test("runtime adapter drives a full turn through real acpx runtime + mock ACP agent", async () => {
  if (!acpxAvailable) {
    console.warn("acpx dist not installed; skipping live runtime probe");
    return;
  }
  const stateDir = await mkdtemp(join(tmpdir(), "xacpx-runtime-poc-"));
  try {
    const adapter = createXacpxRuntimeAdapter({
      stateDir,
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
      // Narrow per-worker registry (plan §35): exactly one argv override.
      agentOverrides: { mock: [process.execPath, MOCK_AGENT] },
    });
    const runtime = adapter.raw();
    // Public contract only: ensureSession → startTurn → result (plan §51 fingerprint).
    const handle = await runtime.ensureSession({
      sessionKey: "poc-session",
      agent: "mock",
      mode: "persistent",
      cwd: stateDir,
    });
    expect(handle.sessionKey).toBe("poc-session");
    expect(handle.acpxRecordId).toBeTypeOf("string");
    expect(handle.acpxRecordId!.length).toBeGreaterThan(0);

    const turn = runtime.startTurn({
      handle,
      text: "hello from xacpx",
      mode: "prompt",
      requestId: "poc-turn-1",
    });
    await turn.promptStarted;
    const events: Array<{ type: string }> = [];
    for await (const event of turn.events) {
      events.push({ type: event.type });
    }
    const result = await turn.result;
    expect(result.status).toBe("completed");

    // Record compatibility (plan §12): the persisted acpx session record exists
    // on disk under the SAME store layout the CLI reads.
    const entries = await readdir(stateDir);
    expect(entries.length).toBeGreaterThan(0);

    const status = await runtime.getStatus({ handle });
    expect(status.acpxRecordId).toBe(handle.acpxRecordId);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}, 30_000);

test("adapter-scoped ensure/startTurn/cancel surface through the narrow interface", async () => {
  if (!acpxAvailable) return;
  const stateDir = await mkdtemp(join(tmpdir(), "xacpx-runtime-poc2-"));
  try {
    const adapter = createXacpxRuntimeAdapter({
      stateDir,
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
    });
    expect(typeof adapter.ensure).toBe("function");
    expect(typeof adapter.startTurn).toBe("function");
    expect(typeof adapter.setMode).toBe("function");
    expect(typeof adapter.close).toBe("function");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
