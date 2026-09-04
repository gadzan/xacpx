import { expect, test } from "bun:test";
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { RuntimeEngine, WorkerUnavailableError } from "../../../../../src/bridge/engine/runtime-engine";

const sessionInput = {
  agent: "codex",
  cwd: "/repo",
  name: "demo",
  logicalSessionId: "logical-engine-1",
};

async function withFakeWorker(entry: string): Promise<void> {
  await writeFile(
    entry,
    [
      "let buffer='';",
      "process.stdin.on('data', (d) => {",
      "  buffer += d.toString();",
      "  let idx;",
      "  while ((idx = buffer.indexOf('\\n')) >= 0) {",
      "    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);",
      "    if (!line) continue;",
      "    try { const msg = JSON.parse(line);",
      "      if (msg.method === 'prompt') {",
      // Streaming shape: event frame DURING the turn, then the settled response.
      "        process.stdout.write(JSON.stringify({ id: msg.id, event: 'text_delta', payload: { type: 'text_delta', text: 'hi' } }) + '\\n');",
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { result: { status: 'completed' }, finalText: 'hi' } }) + '\\n');",
      "      } else if (msg.method === 'ensure') {",
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true, sessionKey: msg.params.sessionKey, acpxRecordId: 'rec-test-1' } }) + '\\n');",
      "      } else {",
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
      "      }",
      "      if (msg.method === 'shutdown') process.exit(0);",
      "    } catch {}",
      "  }",
      "});",
    ].join("\n"),
  );
}

test("engine without a built worker entry fails closed with RUNTIME_ENGINE_UNSUPPORTED", async () => {
  const engine = new RuntimeEngine({
    workerEntryPath: "/nonexistent/worker.js",
    permissionMode: "approve-all",
  });
  await expect(engine.ensureSession(sessionInput)).rejects.toMatchObject({ code: "RUNTIME_ENGINE_UNSUPPORTED" });
});

test("freeWarmProcess on a cold session is a no-op success", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-engine-"));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    const stateDir = join(dir, "state", "sessions");
    await import("node:fs/promises").then(m=>m.mkdir(stateDir,{recursive:true}));
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all", stateDir, queueDir: join(dir, "queue"), fenceDir: join(dir, "fences") });
    await expect(engine.freeWarmProcess(sessionInput)).resolves.toEqual({});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("prompt runs through the worker and returns final text; warm flips after use", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-engine-"));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    const stateDir = join(dir, "state", "sessions");
    await import("node:fs/promises").then(m=>m.mkdir(stateDir,{recursive:true}));
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all", stateDir, queueDir: join(dir, "queue"), fenceDir: join(dir, "fences") });
    // Cold before first prompt
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(false);
    const reply = await engine.prompt({ ...sessionInput, text: "hello" }, () => {});
    expect(reply.text).toBe("hi");
    // Worker stays warm after the turn (normal TTL behavior)
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(true);
    await engine.shutdown();
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("removeSession soft-closes the warm worker and preserves history (close parity)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-engine-"));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    const stateDir = join(dir, "state", "sessions");
    await import("node:fs/promises").then(m=>m.mkdir(stateDir,{recursive:true}));
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all", stateDir, queueDir: join(dir, "queue"), fenceDir: join(dir, "fences") });
    await engine.prompt(sessionInput);
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(true);
    await expect(engine.removeSession(sessionInput)).resolves.toEqual({});
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(false);
    // Second soft close is idempotent.
    await expect(engine.removeSession(sessionInput)).resolves.toEqual({});
    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("injectMessage queue/auto is queued, steer/interrupt remain unsupported", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-engine-"));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    const stateDir = join(dir, "state", "sessions");
    await mkdir(stateDir, { recursive: true });
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all", stateDir, durableRootDir: join(dir, "durable") });
    const q = await engine.injectMessage({ ...sessionInput, text: "x", mode: "queue", messageId: "m1" });
    expect(q.status).toBe("queued");
    expect(q.modeUsed).toBe("queue");
    const a = await engine.injectMessage({ ...sessionInput, text: "x", mode: "auto", messageId: "m2" });
    expect(a.status).toBe("queued");
    expect(a.modeUsed).toBe("queue");
    for (const mode of ["steer", "interrupt"] as const) {
      await expect(engine.injectMessage({ ...sessionInput, text: "x", mode, messageId: "m3" })).rejects.toMatchObject({
        code: "RUNTIME_ENGINE_UNSUPPORTED",
      });
    }
    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
test("streaming timing regression: onSegment fires while prompt promise is still pending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-timing-"));
  try {
    const entry = join(dir, "delayed-worker.mjs");
    await writeFile(
      entry,
      [
        "let buffer='';",
        "process.stdin.on('data', (d) => {",
        "  buffer += d.toString();",
        "  let idx;",
        "  while ((idx = buffer.indexOf('\\n')) >= 0) {",
        "    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);",
        "    if (!line) continue;",
        "    try { const msg = JSON.parse(line);",
        "      if (msg.method === 'prompt') {",
        // Emit event immediately, but delay the final response by 40ms so the
        // caller can observe that onSegment runs WHILE prompt() is still unresolved.
        "        process.stdout.write(JSON.stringify({ id: msg.id, event: 'text_delta', payload: { type: 'text_delta', text: 'chunk-1' } }) + '\\n');",
        "        setTimeout(() => {",
        "          process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { result: { status: 'completed' }, finalText: 'chunk-1' } }) + '\\n');",
        "        }, 40);",
        "      } else if (msg.method === 'ensure') {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true, sessionKey: msg.params?.sessionKey, acpxRecordId: 'rec-1' } }) + '\\n');",
        "      } else {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
        "      }",
        "      if (msg.method === 'shutdown') process.exit(0);",
        "    } catch {}",
        "  }",
        "});",
      ].join("\n"),
    );
    const stateDir = join(dir, "state", "sessions");
    await import("node:fs/promises").then(m=>m.mkdir(stateDir,{recursive:true}));
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all", stateDir, queueDir: join(dir, "queue"), fenceDir: join(dir, "fences") });
    let promptPromiseSettled = false;
    let onSegmentRanWhilePending = false;

    const promptPromise = engine.prompt({ ...sessionInput, text: "stream-test" }, (event) => {
      if (event.type === "prompt.segment" && event.text === "chunk-1") {
        onSegmentRanWhilePending = !promptPromiseSettled;
      }
    });
    promptPromise.finally(() => {
      promptPromiseSettled = true;
    });

    const result = await promptPromise;
    expect(result.text).toBe("chunk-1");
    // IRON LAW: onSegment must have been called BEFORE the prompt promise settled!
    expect(onSegmentRanWhilePending).toBe(true);
    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
test("G9: usage events never fabricate 0 for unknown token fields (used-only, size-only, both, neither)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-usage-matrix-"));
  try {
    const entry = join(dir, "usage-worker.mjs");
    await writeFile(
      entry,
      [
        "let buffer='';",
        "process.stdin.on('data', (d) => {",
        "  buffer += d.toString();",
        "  let idx;",
        "  while ((idx = buffer.indexOf('\\n')) >= 0) {",
        "    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);",
        "    if (!line) continue;",
        "    try { const msg = JSON.parse(line);",
        "      if (msg.method === 'prompt') {",
        "        if (msg.params?.text === 'used-only') {",
        "          process.stdout.write(JSON.stringify({ id: msg.id, event: 'usage', payload: { type: 'status', text: 'u', used: 100 } }) + '\\n');",
        "        } else if (msg.params?.text === 'size-only') {",
        "          process.stdout.write(JSON.stringify({ id: msg.id, event: 'usage', payload: { type: 'status', text: 's', size: 200000 } }) + '\\n');",
        "        } else if (msg.params?.text === 'both') {",
        "          process.stdout.write(JSON.stringify({ id: msg.id, event: 'usage', payload: { type: 'status', text: 'b', used: 100, size: 200000 } }) + '\\n');",
        "        } else if (msg.params?.text === 'neither') {",
        "          process.stdout.write(JSON.stringify({ id: msg.id, event: 'usage', payload: { type: 'status', text: 'status msg' } }) + '\\n');",
        "        }",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { result: { status: 'completed' }, finalText: 'done' } }) + '\\n');",
        "      } else if (msg.method === 'ensure') {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true, sessionKey: msg.params?.sessionKey, acpxRecordId: 'rec-u' } }) + '\\n');",
        "      } else {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
        "      }",
        "      if (msg.method === 'shutdown') process.exit(0);",
        "    } catch {}",
        "  }",
        "});",
      ].join("\n"),
    );
    const stateDir = join(dir, "state", "sessions");
    await import("node:fs/promises").then(m=>m.mkdir(stateDir,{recursive:true}));
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all", stateDir, queueDir: join(dir, "queue"), fenceDir: join(dir, "fences") });

    // 1. used-only: must NOT fabricate size: 0
    const usedOnlyEvents: Array<{ type: string; used?: number; size?: number }> = [];
    await engine.prompt({ ...sessionInput, text: "used-only" }, (e) => {
      if (e.type === "prompt.usage") usedOnlyEvents.push(e);
    });
    expect(usedOnlyEvents.length).toBe(0);

    // 2. size-only: must NOT fabricate used: 0
    const sizeOnlyEvents: Array<{ type: string; used?: number; size?: number }> = [];
    await engine.prompt({ ...sessionInput, text: "size-only" }, (e) => {
      if (e.type === "prompt.usage") sizeOnlyEvents.push(e);
    });
    expect(sizeOnlyEvents.length).toBe(0);

    // 3. both: emits prompt.usage with real values
    const bothEvents: Array<{ type: string; used?: number; size?: number }> = [];
    await engine.prompt({ ...sessionInput, text: "both" }, (e) => {
      if (e.type === "prompt.usage") bothEvents.push(e);
    });
    expect(bothEvents.length).toBe(1);
    expect(bothEvents[0]!.used).toBe(100);
    expect(bothEvents[0]!.size).toBe(200000);

    // 4. neither: no prompt.usage event
    const neitherEvents: Array<{ type: string }> = [];
    await engine.prompt({ ...sessionInput, text: "neither" }, (e) => {
      if (e.type === "prompt.usage") neitherEvents.push(e);
    });
    expect(neitherEvents.length).toBe(0);

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("WorkerUnavailableError carries the unsupported code", () => {
  expect(new WorkerUnavailableError("nope").code).toBe("RUNTIME_ENGINE_UNSUPPORTED");
});
test("G8 structured launch: buildEnsureParams uses acpxAgent as registry alias for agentOverrides", async () => {
  const engine = new RuntimeEngine({ workerEntryPath: "/fake/worker.js", permissionMode: "approve-all" });
  const params = engine["buildEnsureParams"]({
    ...sessionInput,
    agent: "user-alias",
    acpxAgent: "codex",
    agentCommand: "npx @acpx/codex",
    agentArgv: ["node", "/path with spaces/agent.mjs", "--flag", ""],
  });

  // agent must resolve to runtimeAgentName (acpxAgent ?? agent)
  expect(params.agent).toBe("codex");
  // agentOverrides must be keyed by the EXACT same alias
  expect(params.agentOverrides).toEqual({
    codex: ["node", "/path with spaces/agent.mjs", "--flag", ""],
  });
});

test("resumeAgentSession passes resumeSessionId to worker ensure RPC", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-resume-"));
  try {
    let capturedResumeId: string | undefined;
    const entry = join(dir, "resume-worker.mjs");
    await writeFile(
      entry,
      [
        "let buffer='';",
        "let capturedResumeId=undefined;",
        "process.stdin.on('data', (d) => {",
        "  buffer += d.toString();",
        "  let idx;",
        "  while ((idx = buffer.indexOf('\\n')) >= 0) {",
        "    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);",
        "    if (!line) continue;",
        "    try { const msg = JSON.parse(line);",
        "      if (msg.method === 'ensure') {",
        "        capturedResumeId = msg.params?.resumeSessionId;",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true, sessionKey: msg.params?.sessionKey } }) + '\\n');",
        "      } else if (msg.method === 'status') {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { capturedResumeId } }) + '\\n');",
        "      } else {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
        "      }",
        "      if (msg.method === 'shutdown') process.exit(0);",
        "    } catch {}",
        "  }",
        "});",
      ].join("\n"),
    );

    const stateDir = join(dir, "state", "sessions");
    await import("node:fs/promises").then(m=>m.mkdir(stateDir,{recursive:true}));
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all", stateDir, queueDir: join(dir, "queue"), fenceDir: join(dir, "fences") });
    await engine.resumeAgentSession({ ...sessionInput, agentSessionId: "native-conv-123" });

    const client = engine["manager"]?.get(sessionInput.logicalSessionId);
    expect(client).toBeDefined();
    const status = await client!.request<{ capturedResumeId?: string }>("status");
    expect(status.capturedResumeId).toBe("native-conv-123");

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("native resume followed by normal prompt keeps ONE AcpRuntime owner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-resume-single-owner-"));
  const acpxHome = join(dir, "home");
  const sessionsDir = join(acpxHome, ".acpx", "sessions");
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sessionsDir, { recursive: true });

    const entry = join(dir, "resume-single-worker.mjs");
    await writeFile(
      entry,
      [
        "let buffer='';",
        "let adapterCreateCount = 0;",
        "let resumedIds = [];",
        "let lastImmutable = null;",
        "process.stdin.on('data', (d) => {",
        "  buffer += d.toString();",
        "  let idx;",
        "  while ((idx = buffer.indexOf('\\n')) >= 0) {",
        "    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);",
        "    if (!line) continue;",
        "    try { const msg = JSON.parse(line);",
        "      if (msg.method === 'ensure') {",
        "        const p = msg.params ?? {};",
        "        // Emulate the production sameEnsureParams immutable identity:",
        "        // sessionKey / agent / cwd / stateDir — NOT resumeSessionId / model / effort",
        "        const immutable = JSON.stringify([p.sessionKey, p.agent, p.cwd, p.stateDir]);",
        "        if (immutable !== lastImmutable) { adapterCreateCount++; lastImmutable = immutable; }",
        "        resumedIds.push(p.resumeSessionId ?? null);",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { sessionKey: p.sessionKey, resumeSessionId: p.resumeSessionId } }) + '\\n');",
        "      } else if (msg.method === 'prompt') {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { result: { status: 'completed' }, finalText: 'ok' } }) + '\\n');",
        "      } else if (msg.method === 'status') {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { adapterCreateCount, resumedIds } }) + '\\n');",
        "      } else {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
        "      }",
        "      if (msg.method === 'shutdown') process.exit(0);",
        "    } catch {}",
        "  }",
        "});",
      ].join("\n"),
    );

    const engine = new RuntimeEngine({ workerEntryPath: entry, stateDir: sessionsDir, permissionMode: "approve-all", durableRootDir: join(dir, "durable") });

    // 1. resume native session X
    await engine.resumeAgentSession({ ...sessionInput, agentSessionId: "native-session-X" });

    // 2. first normal prompt — MUST reuse the same adapter/owner (no second ACP runtime)
    await engine.prompt({ ...sessionInput, text: "hello after resume" });

    const client = engine["manager"]?.get(sessionInput.logicalSessionId);
    expect(client).toBeDefined();
    const status = await client!.request<{ adapterCreateCount: number; resumedIds: Array<string | null> }>("status");

    // Exactly ONE AcpRuntime was created for this worker (single-owner invariant)
    expect(status.adapterCreateCount).toBe(1);
    // First ensure carried the resume id; the follow-up prompt ensure did NOT
    expect(status.resumedIds).toEqual(["native-session-X", null]);

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hasSession and tailSessionHistory read state without heating a cold worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-has-tail-"));
  const sessionsDir = join(dir, ".acpx", "sessions");
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sessionsDir, { recursive: true });

    // Record on disk
    const recFile = join(sessionsDir, "rec-hist-1.json");
    await writeFile(
      recFile,
      JSON.stringify({ schema: "acpx.session.v1", acpx_record_id: "rec-hist-1", name: "hist-session", cwd: sessionInput.cwd }),
    );
    // Stream chunks (stream.1.ndjson is older rotated, stream.ndjson is active newest)
    const stream1 = join(sessionsDir, "rec-hist-1.stream.1.ndjson");
    const streamActive = join(sessionsDir, "rec-hist-1.stream.ndjson");
    await writeFile(stream1, '{"type":"text_delta","text":"line 1"}\n{"type":"text_delta","text":"line 2"}\n');
    await writeFile(streamActive, '{"type":"text_delta","text":"line 3"}\n{"type":"text_delta","text":"line 4"}\n');
    const engine = new RuntimeEngine({ workerEntryPath: "/nonexistent.js", stateDir: sessionsDir, permissionMode: "approve-all" });

    // hasSession returns true for existing on-disk record
    expect((await engine.hasSession({ ...sessionInput, name: "hist-session" })).exists).toBe(true);
    // hasSession returns false for nonexistent record
    expect((await engine.hasSession({ ...sessionInput, name: "nonexistent", logicalSessionId: "nonexistent-id" })).exists).toBe(false);

    // tailSessionHistory returns last 2 lines
    const tail = await engine.tailSessionHistory({ ...sessionInput, name: "hist-session", lines: 2 });
    expect(tail.text).toBe("line 3\nline 4");

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tool_call events map to typed ToolUseEvent and toolEventMode formats text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-tool-events-"));
  try {
    const entry = join(dir, "tool-worker.mjs");
    await writeFile(
      entry,
      [
        "let buffer='';",
        "process.stdin.on('data', (d) => {",
        "  buffer += d.toString();",
        "  let idx;",
        "  while ((idx = buffer.indexOf('\\n')) >= 0) {",
        "    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);",
        "    if (!line) continue;",
        "    try { const msg = JSON.parse(line);",
        "      if (msg.method === 'prompt') {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, event: 'tool', payload: { type: 'tool_call', text: 'Reading file', toolCallId: 'call-1', title: 'Read File', kind: 'read', status: 'completed' } }) + '\\n');",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { result: { status: 'completed' }, finalText: 'done' } }) + '\\n');",
        "      } else if (msg.method === 'ensure') {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true, sessionKey: msg.params?.sessionKey } }) + '\\n');",
        "      } else {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
        "      }",
        "      if (msg.method === 'shutdown') process.exit(0);",
        "    } catch {}",
        "  }",
        "});",
      ].join("\n"),
    );

    const stateDir = join(dir, "state", "sessions");
    await import("node:fs/promises").then(m=>m.mkdir(stateDir,{recursive:true}));
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all", stateDir, queueDir: join(dir, "queue"), fenceDir: join(dir, "fences") });
    const events: unknown[] = [];
    await engine.prompt(
      { ...sessionInput, text: "run-tool", toolEventMode: "both" },
      (e) => events.push(e),
    );

    const toolUseEvent = events.find((e: any) => e.type === "prompt.tool_event") as any;
    expect(toolUseEvent).toBeDefined();
    expect(toolUseEvent.event.toolCallId).toBe("call-1");
    expect(toolUseEvent.event.toolName).toBe("Read File");
    expect(toolUseEvent.event.kind).toBe("read");
    expect(toolUseEvent.event.status).toBe("success");

    const segmentEvent = events.find((e: any) => e.type === "prompt.segment") as any;
    expect(segmentEvent).toBeDefined();
    expect(segmentEvent.text).toContain("Read File");

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("initial session model is forwarded through buildEnsureParams to ensure options", async () => {
  const engine = new RuntimeEngine({ workerEntryPath: "/fake/worker.js", permissionMode: "approve-all" });
  const params = engine["buildEnsureParams"]({
    ...sessionInput,
    model: "gpt-5.5-preview",
  });
  expect(params.model).toBe("gpt-5.5-preview");
});

test("Runtime worker idle TTL timer automatically reaps inactive warm worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-ttl-"));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    // 50ms TTL for fast test
    const stateDir = join(dir, "state", "sessions");
    await import("node:fs/promises").then(m=>m.mkdir(stateDir,{recursive:true}));
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all", idleTtlMs: 50, stateDir, queueDir: join(dir, "queue"), fenceDir: join(dir, "fences") });

    await engine.ensureSession(sessionInput);
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(true);

    // Wait for idle TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(false);

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("terminal turn cancelled throws RUNTIME_TURN_CANCELLED and failed maps error code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-turn-err-"));
  try {
    const entry = join(dir, "err-worker.mjs");
    await writeFile(
      entry,
      [
        "let buffer='';",
        "process.stdin.on('data', (d) => {",
        "  buffer += d.toString();",
        "  let idx;",
        "  while ((idx = buffer.indexOf('\\n')) >= 0) {",
        "    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);",
        "    if (!line) continue;",
        "    try { const msg = JSON.parse(line);",
        "      if (msg.method === 'prompt') {",
        "        if (msg.params?.text === 'cancel') {",
        "          process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { result: { status: 'cancelled', stopReason: 'user requested cancel' }, finalText: '' } }) + '\\n');",
        "        } else if (msg.params?.text === 'fail') {",
        "          process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { result: { status: 'failed', error: { message: 'session missing', code: 'ACP_BACKEND_MISSING' } }, finalText: '' } }) + '\\n');",
        "        }",
        "      } else if (msg.method === 'ensure') {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true, sessionKey: msg.params?.sessionKey } }) + '\\n');",
        "      } else {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
        "      }",
        "      if (msg.method === 'shutdown') process.exit(0);",
        "    } catch {}",
        "  }",
        "});",
      ].join("\n"),
    );

    const stateDir = join(dir, "state", "sessions");
    await import("node:fs/promises").then(m=>m.mkdir(stateDir,{recursive:true}));
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all", stateDir, queueDir: join(dir, "queue"), fenceDir: join(dir, "fences") });

    // Cancelled turn throws RUNTIME_TURN_CANCELLED
    await expect(engine.prompt({ ...sessionInput, text: "cancel" })).rejects.toMatchObject({
      code: "RUNTIME_TURN_CANCELLED",
    });

    // Failed turn with ACP_BACKEND_MISSING maps to RUNTIME_SESSION_MISSING
    await expect(engine.prompt({ ...sessionInput, text: "fail" })).rejects.toMatchObject({
      code: "RUNTIME_SESSION_MISSING",
    });

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("G8 raw command launch: buildEnsureParams sets string override for explicit rawCommand", async () => {
  const engine = new RuntimeEngine({ workerEntryPath: "/fake/worker.js", permissionMode: "approve-all" });
  const params = engine["buildEnsureParams"]({
    ...sessionInput,
    agent: "user-alias",
    acpxAgent: "codex",
    agentCommand: "/custom/my-acp --arg 1",
    rawCommand: "/custom/my-acp --arg 1",
    agentArgv: undefined,
  });

  expect(params.agent).toBe("codex");
  expect(params.agentOverrides).toEqual({
    codex: "/custom/my-acp --arg 1",
  });
});

test("prompt lifecycle: prompt starts idle TTL timer and automatically reaps worker when idle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-prompt-ttl-"));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    const stateDir = join(dir, "state", "sessions");
    await import("node:fs/promises").then(m=>m.mkdir(stateDir,{recursive:true}));
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all", idleTtlMs: 60, stateDir, queueDir: join(dir, "queue"), fenceDir: join(dir, "fences") });

    const reply = await engine.prompt({ ...sessionInput, text: "hi" });
    expect(reply.text).toBe("hi");
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(true);

    // Wait for idle TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(false);

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prompt lifecycle: new prompt before idle TTL resets the timer and keeps worker warm", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-prompt-reset-"));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    const stateDir = join(dir, "state", "sessions");
    await import("node:fs/promises").then(m=>m.mkdir(stateDir,{recursive:true}));
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all", idleTtlMs: 80, stateDir, queueDir: join(dir, "queue"), fenceDir: join(dir, "fences") });

    await engine.prompt({ ...sessionInput, text: "hi 1" });
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(true);

    // Sleep less than TTL (40ms < 80ms)
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(true);

    // Second prompt resets timer
    await engine.prompt({ ...sessionInput, text: "hi 2" });

    // Sleep another 40ms: still warm because timer was reset
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(true);

    // Sleep beyond new TTL (80ms + 40ms = 120ms total from second prompt)
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(false);

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("toolEventMode structured emits structured event but skips text segment formatting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-structured-only-"));
  try {
    const entry = join(dir, "tool-worker.mjs");
    await writeFile(
      entry,
      [
        "let buffer='';",
        "process.stdin.on('data', (d) => {",
        "  buffer += d.toString();",
        "  let idx;",
        "  while ((idx = buffer.indexOf('\\n')) >= 0) {",
        "    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);",
        "    if (!line) continue;",
        "    try { const msg = JSON.parse(line);",
        "      if (msg.method === 'prompt') {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, event: 'tool', payload: { type: 'tool_call', text: 'Reading file', toolCallId: 'call-struct-1', title: 'Read File', kind: 'read', status: 'completed' } }) + '\\n');",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { result: { status: 'completed' }, finalText: 'done' } }) + '\\n');",
        "      } else if (msg.method === 'ensure') {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true, sessionKey: msg.params?.sessionKey } }) + '\\n');",
        "      } else {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
        "      }",
        "      if (msg.method === 'shutdown') process.exit(0);",
        "    } catch {}",
        "  }",
        "});",
      ].join("\n"),
    );

    const stateDir = join(dir, "state", "sessions");
    await import("node:fs/promises").then(m=>m.mkdir(stateDir,{recursive:true}));
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all", stateDir, queueDir: join(dir, "queue"), fenceDir: join(dir, "fences") });
    const events: unknown[] = [];
    await engine.prompt(
      { ...sessionInput, text: "run-tool", toolEventMode: "structured" },
      (e) => events.push(e),
    );

    const toolUseEvent = events.find((e: any) => e.type === "prompt.tool_event") as any;
    expect(toolUseEvent).toBeDefined();
    expect(toolUseEvent.event.toolCallId).toBe("call-struct-1");

    // Must NOT emit prompt.segment with tool text formatting
    const toolSegment = events.find((e: any) => e.type === "prompt.segment" && e.text.includes("Read File"));
    expect(toolSegment).toBeUndefined();

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tailSessionHistory parses real acpx 0.13.1 stream rotation and JSON-RPC message formats", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-acpx-history-"));
  const sessionsDir = join(dir, ".acpx", "sessions");
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sessionsDir, { recursive: true });

    // Main JSON record
    const recFile = join(sessionsDir, "rec-acpx-rot-1.json");
    await writeFile(
      recFile,
      JSON.stringify({
        schema: "acpx.session.v1",
        acpx_record_id: "rec-acpx-rot-1",
        name: "acpx-rot-session",
        cwd: sessionInput.cwd,
        messages: [],
      }),
    );

    // Stream rotation files:
    // .stream.2.ndjson (oldest rotated)
    const stream2 = join(sessionsDir, "rec-acpx-rot-1.stream.2.ndjson");
    await writeFile(
      stream2,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update: { type: "text_delta", text: "message from stream 2" } },
      }) + "\n",
    );

    // .stream.1.ndjson (newer rotated)
    const stream1 = join(sessionsDir, "rec-acpx-rot-1.stream.1.ndjson");
    await writeFile(
      stream1,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update: { content: [{ type: "text", text: "message from stream 1" }] } },
      }) + "\n",
    );

    // .stream.ndjson (active newest stream)
    const streamActive = join(sessionsDir, "rec-acpx-rot-1.stream.ndjson");
    await writeFile(
      streamActive,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update: { content: { type: "text", text: "message from active stream" } } },
      }) + "\n",
    );

    const engine = new RuntimeEngine({ workerEntryPath: "/fake/worker.js", stateDir: sessionsDir, permissionMode: "approve-all" });

    // tail 3 lines: must arrive in exact chronological order (stream 2 -> stream 1 -> active stream)
    const tail3 = await engine.tailSessionHistory({
      ...sessionInput,
      name: "acpx-rot-session",
      lines: 3,
    });
    expect(tail3.text).toBe("message from stream 2\nmessage from stream 1\nmessage from active stream");

    // tail 2 lines: last 2 lines
    const tail2 = await engine.tailSessionHistory({
      ...sessionInput,
      name: "acpx-rot-session",
      lines: 2,
    });
    expect(tail2.text).toBe("message from stream 1\nmessage from active stream");

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("freeWarmProcess while prompt is active marks coolPending and terminates only after prompt settles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-cool-pending-"));
  const releaseFile = join(dir, "release.marker");
  try {
    const entry = join(dir, "slow-turn-worker.mjs");
    await writeFile(
      entry,
      [
        "import fs from 'node:fs';",
        "let buffer='';",
        "process.stdin.on('data', (d) => {",
        "  buffer += d.toString();",
        "  let idx;",
        "  while ((idx = buffer.indexOf('\\n')) >= 0) {",
        "    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);",
        "    if (!line) continue;",
        "    try { const msg = JSON.parse(line);",
        "      if (msg.method === 'prompt') {",
        "        const checkRelease = () => {",
        `          if (fs.existsSync(${JSON.stringify(releaseFile)})) {`,
        "            process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { result: { status: 'completed' }, finalText: 'done' } }) + '\\n');",
        "          } else {",
        "            setTimeout(checkRelease, 20);",
        "          }",
        "        };",
        "        setTimeout(checkRelease, 20);",
        "      } else if (msg.method === 'ensure') {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true, sessionKey: msg.params?.sessionKey } }) + '\\n');",
        "      } else {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
        "      }",
        "      if (msg.method === 'shutdown') process.exit(0);",
        "    } catch {}",
        "  }",
        "});",
      ].join("\n"),
    );

    const stateDir = join(dir, "state", "sessions");
    await import("node:fs/promises").then(m=>m.mkdir(stateDir,{recursive:true}));
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all", stateDir, queueDir: join(dir, "queue"), fenceDir: join(dir, "fences") });

    // 1. Start long-running prompt
    let promptFinished = false;
    const promptPromise = engine.prompt({ ...sessionInput, text: "slow" }).then((res) => {
      promptFinished = true;
      return res;
    });

    // Wait 50ms to ensure prompt is actively inside worker
    await new Promise((r) => setTimeout(r, 50));
    expect(promptFinished).toBe(false);

    // 2. Call freeWarmProcess while prompt is in flight
    await engine.freeWarmProcess(sessionInput);

    // Worker MUST NOT be terminated yet; prompt is still active
    expect(promptFinished).toBe(false);
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(true);

    // 3. Write release marker file
    await writeFile(releaseFile, "go");

    // 4. Prompt settles cleanly
    const reply = await promptPromise;
    expect(reply.text).toBe("done");
    expect(promptFinished).toBe(true);

    // 5. Worker is now terminated and cooled down (coolPending processed in prompt.finally)
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(false);

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tailSessionHistory parses real acpx record.messages conversation turns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-acpx-conv-"));
  const sessionsDir = join(dir, ".acpx", "sessions");
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sessionsDir, { recursive: true });

    // Real acpx record.messages format with User and Agent turns
    const recFile = join(sessionsDir, "rec-conv-1.json");
    await writeFile(
      recFile,
      JSON.stringify({
        schema: "acpx.session.v1",
        acpx_record_id: "rec-conv-1",
        name: "conv-session",
        cwd: sessionInput.cwd,
        messages: [
          { User: { content: [{ Text: "what is the capital of France?" }] } },
          { Agent: { content: [{ Text: "The capital of France is Paris." }] } },
          { User: { content: [{ Text: "what is its population?" }] } },
          { Agent: { content: [{ Text: "Paris has about 2.1 million residents." }] } },
        ],
      }),
    );

    const engine = new RuntimeEngine({ workerEntryPath: "/fake/worker.js", stateDir: sessionsDir, permissionMode: "approve-all" });

    // Tail last 2 conversation turns
    const tail2 = await engine.tailSessionHistory({ ...sessionInput, name: "conv-session", lines: 2 });
    expect(tail2.text).toBe("what is its population?\nParis has about 2.1 million residents.");

    // Tail 1 conversation turn
    const tail1 = await engine.tailSessionHistory({ ...sessionInput, name: "conv-session", lines: 1 });
    expect(tail1.text).toBe("Paris has about 2.1 million residents.");

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("G4: hard delete on dead+failed unverified owner fails closed and does not touch files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-del-dead-failed-"));
  const sessionsDir = join(dir, ".acpx", "sessions");
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sessionsDir, { recursive: true });

    const recordFile = join(sessionsDir, "rec-dead-fail-1.json");
    await writeFile(
      recordFile,
      JSON.stringify({ schema: "acpx.session.v1", acpx_record_id: "rec-dead-fail-1", name: "dead-fail-session", cwd: sessionInput.cwd }),
    );

    const engine = new RuntimeEngine({
      workerEntryPath: entry,
      stateDir: sessionsDir,
      permissionMode: "approve-all",
      durableRootDir: join(dir, "durable"),
      // Crash cleanup always fails: old owner is retained in the manager.
      workerClientDeps: {
        terminateProcessTree: async () => {
          throw new Error("simulated unverified crash cleanup failure");
        },
      },
    });
    const client = engine["manager"]?.ensureWorker(sessionInput.logicalSessionId);
    await client!.request("ensure", {});

    // Simulate unexpected crash: kill the real worker process so alive=false,
    // then leave lifecycle=failed (ownership cleanup never proven).
    process.kill(client!.ref.pid, "SIGKILL");
    const deadline = Date.now() + 2_000;
    while (client!.alive && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    client!.lifecycle = "failed";

    // Hard delete MUST fail closed because ownership cleanup was never proven
    await expect(
      engine.deleteSession({ ...sessionInput, name: "dead-fail-session" }),
    ).rejects.toMatchObject({ code: "RUNTIME_WORKER_TEARDOWN_PENDING" });

    // Record file remains untouched on disk
    await access(recordFile);

    // The retained failed owner makes final shutdown best-effort (expected reject)
    await engine.shutdown().catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TTL success then engine.shutdown() is idempotent and succeeds (Windows regression)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-ttl-shutdown-"));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    let treeTermCalls = 0;
    const engine = new RuntimeEngine({
      workerEntryPath: entry,
      permissionMode: "approve-all",
      idleTtlMs: 50,
      durableRootDir: join(dir, "durable"),
      workerClientDeps: {
        platform: "win32",
        probeWindowsIdentity: async (pid) => ({ status: "found", identity: { pid, creationDate: "133500000000000000" } }),
        terminateProcessTree: async (target) => {
          treeTermCalls++;
          // First call kills the tree; any second call would see root already exited
          return { rootOutcome: treeTermCalls === 1 ? "killed" : "already-exited", outcomes: [] };
        },
      },
    });

    await engine.ensureSession(sessionInput);
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(true);

    // TTL expires and reaps the worker (verified tree cleanup)
    await new Promise((r) => setTimeout(r, 120));
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(false);

    // Second shutdown MUST be idempotent — never re-enter terminate on verified-stopped
    await expect(engine.shutdown()).resolves.toEqual({});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Host crash (SIGKILL) → worker EOF self-exit → adapter descendant also gone", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-host-crash-"));
  const pidFile = join(dir, "descendant.pid");
  let host: ReturnType<typeof spawn> | undefined;
  let adapterPid = 0;
  try {
    // Simulated "host" owns a Runtime Worker via stdio pipes (same wiring as
    // RuntimeWorkerClient.spawn). The worker spawns a stubborn adapter child.
    const workerEntry = join(dir, "worker.mjs");
    await writeFile(
      workerEntry,
      [
        "import { spawn } from 'node:child_process';",
        "import fs from 'node:fs';",
        "let buffer='';",
        "process.stdin.on('data', (d) => {",
        "  buffer += d.toString();",
        "  let idx;",
        "  while ((idx = buffer.indexOf('\\n')) >= 0) {",
        "    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);",
        "    if (!line) continue;",
        "    try { const msg = JSON.parse(line);",
        "      if (msg.method === 'ensure') {",
        "        const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });",
        `        fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid), 'utf8');`,
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true } }) + '\\n');",
        "      } else {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
        "      }",
        "    } catch {}",
        "  }",
        "});",
        // Production worker main contract (plan §16 orphan convergence):
        // stdin EOF => kill own process group (adapter descendants inherit it)
        // then self-exit. Mirrors runtime-worker-main.ts EOF handler.
        'process.stdin.on("end", () => {',
        '  if (process.platform !== "win32") {',
        '    try { process.kill(-process.pid, "SIGKILL"); } catch {}',
        '  }',
        '  process.exit(0);',
        '});',
      ].join("\n"),
    );
    // "Host" process: pipes its own stdin through to the worker (mirroring
    // RuntimeWorkerClient, which writes RPC frames into worker stdin).
    const hostScript = join(dir, "host.mjs");
    await writeFile(
      hostScript,
      [
        "import { spawn } from 'node:child_process';",
        `const worker = spawn(process.execPath, [${JSON.stringify(workerEntry)}], { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });`,
        "process.stdin.on('data', (d) => worker.stdin.write(d));",
      ].join("\n"),
    );

    host = spawn(process.execPath, [hostScript], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
    host.stderr!.on("data", () => {});
    // Trigger worker spawn of adapter via stdin frame
    host.stdin!.write(JSON.stringify({ id: "h1", method: "ensure" }) + "\n");

    // Wait for the descendant pid file
    for (let i = 0; i < 100 && !adapterPid; i++) {
      try {
        adapterPid = parseInt(await readFile(pidFile, "utf8"), 10);
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    expect(adapterPid).toBeGreaterThan(0);
    expect(() => process.kill(adapterPid, 0)).not.toThrow();

    // SIGKILL the host (simulating bridge crash): no graceful shutdown possible.
    host.kill("SIGKILL");
    // Confirm host is actually dead
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(host.pid!, 0);
        await new Promise((r) => setTimeout(r, 25));
      } catch {
        break;
      }
    }
    expect(() => process.kill(host.pid!, 0)).toThrow();

    // Worker must self-exit on stdin EOF. The adapter is a separate OS process
    // with stdio:'ignore' — worker EOF self-exit alone does NOT kill it, so the
    // production worker must kill its own process group on the way out. This
    // assertion drives that production fix (plan §16 orphan convergence).
    let stillRunning = true;
    for (let i = 0; i < 200 && stillRunning; i++) {
      try {
        process.kill(adapterPid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        stillRunning = false;
      }
    }
    expect(stillRunning).toBe(false);
  } finally {
    try { if (adapterPid) process.kill(adapterPid, "SIGKILL"); } catch {}
    try { if (host?.pid) process.kill(host.pid, "SIGKILL"); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildEnsureParams passes state ROOT (not sessions dir) to runtime store", async () => {
  const sessionsDir = join("/tmp/fake-home", ".acpx", "sessions");
  const engine = new RuntimeEngine({ workerEntryPath: "/fake/worker.js", stateDir: sessionsDir, permissionMode: "approve-all" });
  const params = engine["buildEnsureParams"]({ ...sessionInput });
  expect(params.stateDir).toBe(join("/tmp/fake-home", ".acpx"));
  // Sessions dir itself is unchanged for disk helpers
  expect(engine["sessionsDir"]()).toBe(sessionsDir);
});
