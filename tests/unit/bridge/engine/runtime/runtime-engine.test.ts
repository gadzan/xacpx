import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
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
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all" });
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
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all" });
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

test("removeSession is unsupported until close-parity is proven", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-engine-"));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all" });
    await expect(engine.removeSession(sessionInput)).rejects.toThrow(/close-parity/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("injectMessage is rejected for every mode until the durable queue lands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-engine-"));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all" });
    for (const mode of ["queue", "steer", "auto", "interrupt"] as const) {
      await expect(engine.injectMessage({ ...sessionInput, text: "x", mode, messageId: "m1" })).rejects.toMatchObject({
        code: "RUNTIME_ENGINE_UNSUPPORTED",
      });
    }
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
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all" });
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
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all" });

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

    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all" });
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
    // Stream chunks
    const stream0 = join(sessionsDir, "rec-hist-1.stream.0.ndjson");
    const stream1 = join(sessionsDir, "rec-hist-1.stream.1.ndjson");
    await writeFile(stream0, '{"type":"text_delta","text":"line 1"}\n{"type":"text_delta","text":"line 2"}\n');
    await writeFile(stream1, '{"type":"text_delta","text":"line 3"}\n{"type":"text_delta","text":"line 4"}\n');

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

    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all" });
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
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all", idleTtlMs: 50 });

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

    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all" });

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
