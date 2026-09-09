import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { EngineSessionInput } from "../../../../../src/bridge/engine/bridge-engine";
import { createXacpxRuntimeAdapter } from "../../../../../src/bridge/engine/runtime/runtime-adapter";
import { RuntimeEngine } from "../../../../../src/bridge/engine/runtime-engine";

import { agentProcessEnvIdentityKey } from "../../../../../src/bridge/engine/runtime/runtime-worker-protocol";

/**
 * PR B1 gate: Runtime child env parity via acpx 0.15 agentProcessEnv.
 * The overlay is a construction-time snapshot for agent children only —
 * never persisted, never the worker's own env — and part of the immutable
 * construction identity.
 */
const MARKER_AGENT = resolve(import.meta.dir, "../../../../fixtures/mock-acp-marker-agent.mjs");
const MARKER_VAR = "XACPX_TEST_MARKER";

async function runMarkerTurn(
  stateDir: string,
  sessionKey: string,
  agentProcessEnv?: Record<string, string>,
): Promise<string> {
  const adapter = createXacpxRuntimeAdapter({
    stateDir,
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    agentOverrides: { marker: [process.execPath, MARKER_AGENT] },
    ...(agentProcessEnv ? { agentProcessEnv } : {}),
  });
  const handle = await adapter.ensure({ sessionKey, agent: "marker", cwd: stateDir });
  const turn = adapter.startTurn({ handle, text: "go" });
  await turn.promptStarted;
  let text = "";
  for await (const event of turn.events) {
    if (event.type === "text_delta" && event.stream !== "thought") text += event.text;
  }
  const result = await turn.result;
  expect(result.status).toBe("completed");
  await adapter.close(handle, { discardPersistentState: true }).catch(() => {});
  return text;
}

test("agentProcessEnvIdentityKey is order-stable and folds Windows case collisions", () => {
  const left = agentProcessEnvIdentityKey({ B: "2", A: "1" });
  const right = agentProcessEnvIdentityKey({ A: "1", B: "2" });
  expect(left).toBe(right);
  expect(agentProcessEnvIdentityKey(undefined)).toBeNull();
  expect(agentProcessEnvIdentityKey({ A: "1" })).not.toBe(agentProcessEnvIdentityKey({ A: "2" }));
  // Windows: PATH and Path are one variable upstream; identity must agree.
  const folded = agentProcessEnvIdentityKey({ PATH: "/a", Path: "/b" }, "win32");
  expect(folded).toBe(agentProcessEnvIdentityKey({ path: "/b" }, "win32"));
  // Insertion order decides the winner exactly like upstream assignSessionEnv
  // (delete-then-set in entry order): reversed duplicates build different
  // effective envs, so their identities must differ.
  expect(agentProcessEnvIdentityKey({ Path: "/a", PATH: "/b" }, "win32")).toBe(folded);
  expect(agentProcessEnvIdentityKey({ PATH: "/b", Path: "/a" }, "win32")).not.toBe(folded);
  // POSIX keeps case-distinct keys apart.
  expect(agentProcessEnvIdentityKey({ PATH: "/a", Path: "/b" }, "darwin")).not.toBe(
    agentProcessEnvIdentityKey({ path: "/b" }, "darwin"),
  );
});

test("cold first launch receives the child-only overlay", async () => {
  const saved = process.env[MARKER_VAR];
  delete process.env[MARKER_VAR];
  const stateDir = await mkdtemp(join(tmpdir(), "xacpx-agent-env-"));
  try {
    const value = `envval-${Date.now().toString(36)}`;
    const text = await runMarkerTurn(stateDir, "env-cold", { [MARKER_VAR]: value });
    expect(text).toContain(`marker=${value}`);
  } finally {
    if (saved !== undefined) process.env[MARKER_VAR] = saved;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 60_000);

test("mutating the caller map after construction does not change the snapshot", async () => {
  const saved = process.env[MARKER_VAR];
  delete process.env[MARKER_VAR];
  const stateDir = await mkdtemp(join(tmpdir(), "xacpx-agent-env-snap-"));
  try {
    const env: Record<string, string> = { [MARKER_VAR]: "original" };
    const adapter = createXacpxRuntimeAdapter({
      stateDir,
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
      agentOverrides: { marker: [process.execPath, MARKER_AGENT] },
      agentProcessEnv: env,
    });
    env[MARKER_VAR] = "mutated-after-construction";
    const handle = await adapter.ensure({ sessionKey: "env-snap", agent: "marker", cwd: stateDir });
    const turn = adapter.startTurn({ handle, text: "go" });
    await turn.promptStarted;
    let text = "";
    for await (const event of turn.events) {
      if (event.type === "text_delta" && event.stream !== "thought") text += event.text;
    }
    expect(text).toContain("marker=original");
    await adapter.close(handle, { discardPersistentState: true }).catch(() => {});
  } finally {
    if (saved !== undefined) process.env[MARKER_VAR] = saved;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 60_000);

test("overlay values never land in the persisted session record", async () => {
  const saved = process.env[MARKER_VAR];
  delete process.env[MARKER_VAR];
  const stateDir = await mkdtemp(join(tmpdir(), "xacpx-agent-env-rec-"));
  try {
    const value = `secret-${Date.now().toString(36)}`;
    const adapter = createXacpxRuntimeAdapter({
      stateDir,
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
      agentOverrides: { marker: [process.execPath, MARKER_AGENT] },
      agentProcessEnv: { [MARKER_VAR]: value },
    });
    const handle = await adapter.ensure({ sessionKey: "env-rec", agent: "marker", cwd: stateDir });
    const turn = adapter.startTurn({ handle, text: "go" });
    await turn.promptStarted;
    for await (const _event of turn.events) {
      /* drain */
    }
    expect((await turn.result).status).toBe("completed");
    // Keep the record on disk this time: the overlay must not be persisted
    // as session options/env. (The reply text itself echoes the marker into
    // the transcript history — that is agent output, not env persistence —
    // so transcript fields are excluded from the scan.)
    const safeId = encodeURIComponent(handle.acpxRecordId!);
    const recordFile = join(stateDir, "sessions", `${safeId}.json`);
    expect((await stat(recordFile)).isFile()).toBe(true);
    const { messages, event_log, ...rest } = JSON.parse(await readFile(recordFile, "utf8")) as Record<string, unknown>;
    expect(messages).toBeDefined();
    expect(JSON.stringify(rest)).not.toContain(value);
    await adapter.close(handle, { discardPersistentState: true }).catch(() => {});
  } finally {
    if (saved !== undefined) process.env[MARKER_VAR] = saved;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 60_000);

const engineSessionInput: EngineSessionInput = {
  agent: "codex",
  driver: "claude",
  cwd: "/repo",
  name: "env-demo",
  logicalSessionId: "logical-env-1",
};

/** Fake worker: records ensure params (generation + overlay) and speaks shutdown. */
async function writeEnvCaptureWorker(entry: string): Promise<void> {
  await writeFile(
    entry,
    [
      "const fs = require('node:fs');",
      "const captureFile = process.env.CAPTURE_FILE;",
      "let buffer = '';",
      "process.stdin.on('data', (d) => {",
      "  buffer += d.toString();",
      "  let idx;",
      "  while ((idx = buffer.indexOf('\\n')) >= 0) {",
      "    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);",
      "    if (!line.trim()) continue;",
      "    let msg; try { msg = JSON.parse(line); } catch { continue; }",
      "    if (msg.method === 'ensure') {",
      "      const params = msg.params ?? {};",
      "      fs.appendFileSync(captureFile, JSON.stringify({ generation: params.workerGeneration ?? null, agentProcessEnv: params.agentProcessEnv ?? null }) + '\\n');",
      "      process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true, sessionKey: params.sessionKey } }) + '\\n');",
      "    } else if (msg.method === 'shutdown') {",
      "      process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { quiesced: true } }) + '\\n');",
      "    } else {",
      "      process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
      "    }",
      "  }",
      "});",
      "process.stdin.on('end', () => process.exit(0));",
    ].join("\n"),
  );
}

test("engine sends the resolved overlay and recycles the worker when it changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-env-engine-"));
  try {
    const entry = join(dir, "worker.mjs");
    const capture = join(dir, "ensures.ndjson");
    await writeEnvCaptureWorker(entry);
    let seamEnv: Record<string, string> = { B1_TEST_VAR: "one" };
    const seenInputs: Array<{ driver?: string }> = [];
    const engine = new RuntimeEngine({
      workerEntryPath: entry,
      permissionMode: "approve-all",
      fenceDir: join(dir, "wf"),
      workerClientDeps: { spawnEnv: { CAPTURE_FILE: capture } },
      resolveSpawnEnvironment: (input) => {
        seenInputs.push({ driver: input.driver });
        return { ...seamEnv };
      },
    });
    await engine.ensureSession(engineSessionInput);
    seamEnv = { B1_TEST_VAR: "two" };
    await engine.ensureSession(engineSessionInput);
    await engine.shutdown().catch(() => {});
    // The seam observes engine input (driver) — same source as the CLI lane.
    expect(seenInputs.length).toBeGreaterThanOrEqual(2);
    expect(seenInputs[0]).toEqual({ driver: "claude" });
    const lines = (await readFile(capture, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBe(2);
    expect(lines[0].agentProcessEnv).toEqual({ B1_TEST_VAR: "one" });
    expect(lines[1].agentProcessEnv).toEqual({ B1_TEST_VAR: "two" });
    // A changed overlay is construction identity: the second ensure ran on a
    // recycled worker, never warm-reused with a stale env.
    expect(lines[0].generation).toBeTypeOf("string");
    expect(lines[1].generation).toBeTypeOf("string");
    expect(lines[1].generation).not.toBe(lines[0].generation);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

test("one ensure resolves the overlay once: recorded identity matches sent params", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-env-snapshot-"));
  try {
    const entry = join(dir, "worker.mjs");
    const capture = join(dir, "ensures.ndjson");
    await writeEnvCaptureWorker(entry);
    const A = { B1_TEST_VAR: "snap-a" };
    const B = { B1_TEST_VAR: "snap-b" };
    let calls = 0;
    const engine = new RuntimeEngine({
      workerEntryPath: entry,
      permissionMode: "approve-all",
      fenceDir: join(dir, "wf"),
      workerClientDeps: { spawnEnv: { CAPTURE_FILE: capture } },
      // Stateful resolver: a double resolution inside one ensure would
      // observe A then B and split identity from params.
      resolveSpawnEnvironment: () => {
        calls += 1;
        return calls === 1 ? { ...A } : { ...B };
      },
    });
    await engine.ensureSession(engineSessionInput);
    await engine.shutdown().catch(() => {});
    expect(calls).toBe(1);
    const lines = (await readFile(capture, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBe(1);
    expect(lines[0].agentProcessEnv).toEqual(A);
    const recorded = engine["lastConstructionIdentity"].get("logical-env-1");
    const expected = engine["constructionIdentityForInput"](engineSessionInput, A);
    expect(recorded).toBe(expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

test("throwing resolver rejects the op but leaks no business-op count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-env-resolver-throw-"));
  try {
    const entry = join(dir, "worker.mjs");
    const capture = join(dir, "ensures.ndjson");
    await writeEnvCaptureWorker(entry);
    const engine = new RuntimeEngine({
      workerEntryPath: entry,
      permissionMode: "approve-all",
      fenceDir: join(dir, "wf"),
      workerClientDeps: { spawnEnv: { CAPTURE_FILE: capture } },
      resolveSpawnEnvironment: () => {
        throw new Error("profile failure");
      },
    });
    // The op fails closed with the resolver's own error (no worker spawned)...
    await expect(engine.ensureSession(engineSessionInput)).rejects.toThrow("profile failure");
    // ...and leaves no phantom count behind: the permission plane must not
    // see a stuck RUNTIME_PERMISSION_BUSY afterwards.
    expect(engine["inFlightBusinessOps"].size).toBe(0);
    expect(engine["hasAnyBusinessOp"]()).toBe(false);
    const outcome = await engine.preparePolicyTransition().then(
      () => "prepared" as const,
      (error: unknown) => (typeof error === "object" && error !== null && "code" in error ? String(error.code) : "threw"),
    );
    expect(outcome).not.toBe("RUNTIME_PERMISSION_BUSY");
    await engine.shutdown().catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

test("engine narrows full resolver output to the intentional overlay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-env-narrow-"));
  try {
    const entry = join(dir, "worker.mjs");
    const capture = join(dir, "ensures.ndjson");
    await writeEnvCaptureWorker(entry);
    const engine = new RuntimeEngine({
      workerEntryPath: entry,
      permissionMode: "approve-all",
      fenceDir: join(dir, "wf"),
      workerClientDeps: { spawnEnv: { CAPTURE_FILE: capture } },
      // A resolver returning the whole parent plus one intentional key must
      // not re-elevate the parent above persisted session env: only the
      // delta crosses into agentProcessEnv.
      resolveSpawnEnvironment: () => ({ ...process.env, B1_NARROW_VAR: "one" }),
    });
    await engine.ensureSession({ ...engineSessionInput, name: "env-narrow", logicalSessionId: "logical-narrow-1" });
    await engine.shutdown().catch(() => {});
    const lines = (await readFile(capture, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBe(1);
    expect(lines[0].agentProcessEnv).toEqual({ B1_NARROW_VAR: "one" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

/** Fake worker: dumps its own HOST process env once, then speaks ensure/shutdown. */
async function writeHostEnvCaptureWorker(entry: string, capture: string): Promise<void> {
  await writeFile(
    entry,
    [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ ACPX_MAX_ACP_MESSAGE_BYTES: process.env.ACPX_MAX_ACP_MESSAGE_BYTES ?? null, ACPX_TERMINAL_MAX_OUTPUT_BYTES: process.env.ACPX_TERMINAL_MAX_OUTPUT_BYTES ?? null }));`,
      "let buffer = '';",
      "process.stdin.on('data', (d) => {",
      "  buffer += d.toString();",

      "  let idx;",
      "  while ((idx = buffer.indexOf('\\n')) >= 0) {",
      "    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);",
      "    if (!line.trim()) continue;",
      "    let msg; try { msg = JSON.parse(line); } catch { continue; }",
      "    if (msg.method === 'shutdown') {",
      "      process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { quiesced: true } }) + '\\n');",
      "    } else {",
      "      process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
      "    }",
      "  }",
      "});",
      "process.stdin.on('end', () => process.exit(0));",
    ].join("\n"),
  );
}

test("B5: host ceilings reach the worker HOST env; unset policy leaves it alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-host-env-"));
  try {
    const savedMax = process.env.ACPX_MAX_ACP_MESSAGE_BYTES;
    const savedTerm = process.env.ACPX_TERMINAL_MAX_OUTPUT_BYTES;
    delete process.env.ACPX_MAX_ACP_MESSAGE_BYTES;
    delete process.env.ACPX_TERMINAL_MAX_OUTPUT_BYTES;
    try {
      const entry = join(dir, "worker.mjs");
      const capture = join(dir, "host-env.json");
      await writeHostEnvCaptureWorker(entry, capture);
      const engine = new RuntimeEngine({
        workerEntryPath: entry,
        permissionMode: "approve-all",
        fenceDir: join(dir, "wf"),
        acpxMaxIncomingMessageBytes: 123456,
        acpxTerminalMaxOutputBytes: 789,
      });
      await engine.ensureSession(engineSessionInput);
      await engine.shutdown().catch(() => {});
      expect(JSON.parse(await readFile(capture, "utf8"))).toEqual({
        ACPX_MAX_ACP_MESSAGE_BYTES: "123456",
        ACPX_TERMINAL_MAX_OUTPUT_BYTES: "789",
      });
    } finally {
      if (savedMax !== undefined) process.env.ACPX_MAX_ACP_MESSAGE_BYTES = savedMax;
      if (savedTerm !== undefined) process.env.ACPX_TERMINAL_MAX_OUTPUT_BYTES = savedTerm;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

/** Raw-runtime turn against the marker agent with explicit persisted session env. */
async function runRawMarkerTurn(
  stateDir: string,
  sessionKey: string,
  agentProcessEnv: Record<string, string> | undefined,
  persistedEnv: Record<string, string> | undefined,
  requestId: string,
): Promise<string> {
  const adapter = createXacpxRuntimeAdapter({
    stateDir,
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    agentOverrides: { marker: [process.execPath, MARKER_AGENT] },
    ...(agentProcessEnv ? { agentProcessEnv } : {}),
  });
  const runtime = adapter.raw();
  const handle = await runtime.ensureSession({
    sessionKey,
    agent: "marker",
    mode: "persistent" as const,
    cwd: stateDir,
    ...(persistedEnv ? { sessionOptions: { env: persistedEnv } } : {}),
  });
  const turn = runtime.startTurn({ handle, text: "go", mode: "prompt" as const, requestId });
  await turn.promptStarted;
  let text = "";
  for await (const event of turn.events) {
    if (event.type === "text_delta") text += event.text;
  }
  const result = await turn.result;
  expect(result.status).toBe("completed");
  // No discard: the record (with its persisted env) must survive for reconnect.
  await runtime.close({ handle, reason: "test done" });
  return text;
}

async function withTestEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) {
    saved.set(key, process.env[key]);
    const value = vars[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("persisted session env beats parent; explicit overlay beats persisted env", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "xacpx-env-precedence-"));
  try {
    await withTestEnv({ MARKER_VAR: "XACPX_ENV_PRECEDENCE", XACPX_ENV_PRECEDENCE: "parent" }, async () => {
      // No overlay for the key: the agent must see the persisted record value.
      const first = await runRawMarkerTurn(
        stateDir, "prec-session", { UNRELATED: "1" }, { XACPX_ENV_PRECEDENCE: "session" }, "prec-1",
      );
      expect(first).toContain("marker=session");
      // Reconnect (same key, no sessionOptions): "session" can now only come
      // from the record — and the explicit overlay must win over it.
      const second = await runRawMarkerTurn(
        stateDir, "prec-session", { XACPX_ENV_PRECEDENCE: "runtime" }, undefined, "prec-2",
      );
      expect(second).toContain("marker=runtime");
    });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}, 120_000);

test("persisted empty string masks the parent even with an unrelated overlay", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "xacpx-env-mask-"));
  try {
    await withTestEnv({ MARKER_VAR: "SECRET", SECRET: "secret" }, async () => {
      const text = await runRawMarkerTurn(stateDir, "prec-mask", { UNRELATED: "1" }, { SECRET: "" }, "prec-mask-1");
      expect(text).toContain("marker=");
      expect(text).not.toContain("secret");
    });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}, 120_000);
