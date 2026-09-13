import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { createXacpxRuntimeAdapter, mapEvents } from "../../../../../src/bridge/engine/runtime/runtime-adapter";
// Plan Task 1 / PR0 gate: prove the packaged acpx 0.15.1 Runtime public contract
// works end-to-end from xacpx — import → createRuntime → ensureSession →
// startTurn → completed result — against tests/fixtures/mock-acp-agent.mjs,
// with zero upstream modification. The session record must be visible through
// the same stateDir store the CLI uses (record compatibility, plan §12).
const MOCK_AGENT = resolve(import.meta.dir, "../../../../fixtures/mock-acp-agent.mjs");

test("runtime adapter drives a full turn through real acpx runtime + mock ACP agent", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "xacpx-runtime-poc-"));
  try {
    const adapter = createXacpxRuntimeAdapter({
      stateDir,
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
      // Narrow per-worker registry (plan §35): exact argv override with spaced args.
      agentOverrides: { mock: [process.execPath, MOCK_AGENT, "--custom-arg with spaces", "quoted=value"] },
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
    const events: Array<{ type: string; text?: string }> = [];
    for await (const event of turn.events) {
      events.push({ type: event.type, ...(event.type === "text_delta" ? { text: event.text } : {}) });
    }
    const result = await turn.result;
    expect(result.status).toBe("completed");
    // Mock agent echoes argv=<JSON> — verify exact argv boundaries survived un-split.
    const textDelta = events.find((e) => e.type === "text_delta")?.text ?? "";
    expect(textDelta).toContain("--custom-arg with spaces");
    expect(textDelta).toContain("quoted=value");

    // Record compatibility (plan §12): the persisted acpx session record exists
    // on disk at <stateDir>/sessions/<recordId>.json — the SAME layout the CLI
    // reads. Also assert the nested sessions/sessions path does NOT exist
    // (regression: stateDir must be the state ROOT, not the sessions dir).
    const safeId = encodeURIComponent(handle.acpxRecordId!);
    const recordFile = join(stateDir, "sessions", `${safeId}.json`);
    const recordStat = await stat(recordFile);
    expect(recordStat.isFile()).toBe(true);
    const nestedSessions = join(stateDir, "sessions", "sessions");
    await expect(stat(nestedSessions)).rejects.toThrow();

    const status = await runtime.getStatus({ handle });
    expect(status.acpxRecordId).toBe(handle.acpxRecordId);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}, 30_000);

test("adapter-scoped ensure/startTurn/cancel surface through the narrow interface", () => {
  const adapter = createXacpxRuntimeAdapter({
    stateDir: join(tmpdir(), "unused-poc2"),
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
  });
  expect(typeof adapter.ensure).toBe("function");
  expect(typeof adapter.startTurn).toBe("function");
  expect(typeof adapter.setMode).toBe("function");
  expect(typeof adapter.close).toBe("function");
});

test("adapter setConfigOption returns the agent-accepted snapshot (B3)", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "xacpx-adapter-cfg-"));
  try {
    const adapter = createXacpxRuntimeAdapter({
      stateDir,
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
      agentOverrides: { mock: [process.execPath, MOCK_AGENT] },
    });
    const handle = await adapter.ensure({ sessionKey: "cfg-session", agent: "mock", cwd: stateDir });
    // The mock agent accepts with an empty option list — the narrow snapshot
    // still comes back instead of void.
    const snapshot = await adapter.setConfigOption(handle, "model", "mock-model");
    expect(snapshot).toEqual({ options: [] });
    await adapter.close(handle, { discardPersistentState: true });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}, 30_000);

test("adapter processLifecycle observes the direct-agent launch (B2)", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "xacpx-adapter-lease-"));
  try {
    const seen: Array<{ hook: string; launchId: string; scope: string; pid?: number }> = [];
    const adapter = createXacpxRuntimeAdapter({
      stateDir,
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
      agentOverrides: { mock: [process.execPath, MOCK_AGENT] },
      processLifecycle: {
        onBeforeSpawn: (launch) => {
          seen.push({ hook: "beforeSpawn", launchId: launch.launchId, scope: launch.scope.kind });
        },
        onSpawned: (started) => {
          seen.push({ hook: "spawned", launchId: started.launchId, scope: started.scope.kind, pid: started.pid });
        },
      },
    });
    const handle = await adapter.ensure({ sessionKey: "lease-session", agent: "mock", cwd: stateDir });
    const turn = adapter.startTurn({ handle, text: "hello lease" });
    await turn.promptStarted;
    for await (const _event of turn.events) {
      /* drain */
    }
    expect((await turn.result).status).toBe("completed");
    // The Runtime spawn is admitted and observed with a real child pid —
    // no inference from records or snapshots.
    const before = seen.find((s) => s.hook === "beforeSpawn");
    const spawned = seen.find((s) => s.hook === "spawned");
    expect(before?.scope).toBe("runtime-session");
    expect(spawned?.launchId).toBe(before?.launchId);
    expect(spawned?.pid).toBeGreaterThan(0);
    await adapter.close(handle, { discardPersistentState: true });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}, 30_000);

test("mapEvents passes normalized plan entries through, preserving explicit empty", async () => {
  async function* upstream(): AsyncIterable<never> {
    yield {
      type: "status",
      text: "plan: first",
      tag: "plan",
      entries: [
        { content: "first", status: "in_progress", priority: "high" },
        { content: "  ", status: "pending" },
        { content: "bad-status", status: "bogus" },
        "nope",
      ],
    } as never;
    yield { type: "status", text: "plan updated", tag: "plan", entries: [] } as never;
    yield { type: "status", text: "plan: legacy", tag: "plan" } as never;
    yield {
      type: "status",
      text: "plan: junk",
      tag: "plan",
      entries: [{ content: "junk", status: "bogus" }],
    } as never;
  }
  const events = [];
  for await (const event of mapEvents(upstream())) events.push(event);
  expect(events[0]).toEqual({
    type: "status",
    text: "plan: first",
    tag: "plan",
    entries: [{ content: "first", status: "in_progress", priority: "high" }],
  });
  expect(events[1]).toEqual({ type: "status", text: "plan updated", tag: "plan", entries: [] });
  // No list upstream → no entries key downstream (text-only legacy plan).
  expect(events[2]).toEqual({ type: "status", text: "plan: legacy", tag: "plan" });
  // Non-empty but wholly unusable → absence, never a clearing replacement.
  expect(events[3]).toEqual({ type: "status", text: "plan: junk", tag: "plan" });
});
