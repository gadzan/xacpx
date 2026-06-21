import { expect, test } from "bun:test";

import {
  BridgeRuntime,
  CommandTimeoutError,
  runStreamingPrompt,
  selectLatestAcpxSessionIndexTmp,
  spawnCapture,
  tryRepairAcpxSessionIndex,
  type CommandRunnerOptions,
} from "../../../src/bridge/bridge-runtime";
import type { AcpxQueueOwnerLauncher } from "../../../src/transport/acpx-queue-owner-launcher";

test("rawStream flushes partial paragraphs verbatim on the tight cadence", async () => {
  const segments: string[] = [];
  let currentTime = 0;
  let intervalCallback: (() => void) | undefined;
  let dataHandler: ((chunk: string | Buffer) => void) | undefined;
  let closeHandler: ((code: number | null) => void) | undefined;

  const resultPromise = runStreamingPrompt(
    "acpx",
    ["prompt"],
    async (event) => { if (event.type === "prompt.segment") segments.push(event.text); },
    {
      spawnPrompt: () =>
        ({
          stdout: { setEncoding: () => {}, on: (e: string, h: (chunk: string | Buffer) => void) => { if (e === "data") dataHandler = h; } },
          stderr: { on: () => {} },
          on: (e: string, h: (code: number | null) => void) => { if (e === "close") closeHandler = h; },
        }) as never,
      setIntervalFn: (callback) => { intervalCallback = callback; return 1; },
      clearIntervalFn: () => {},
      now: () => currentTime,
      rawStream: true, // raw mode: default 200ms wait, no \n\n requirement, no trim
    },
  );

  // A mid-paragraph chunk with NO blank line — batched mode would withhold it; raw mode
  // flushes it verbatim once the (short) wait elapses.
  dataHandler?.(`${JSON.stringify({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Half a sentence " } } } })}\n`);
  currentTime = 250;
  intervalCallback?.();
  closeHandler?.(0);
  await resultPromise;
  expect(segments).toEqual(["Half a sentence "]); // verbatim, trailing space kept
});

test("flushes buffered prompt text after timeout when no paragraph boundary arrives", async () => {
  const segments: string[] = [];
  let currentTime = 0;
  let intervalCallback: (() => void) | undefined;
  let dataHandler: ((chunk: string | Buffer) => void) | undefined;
  let closeHandler: ((code: number | null) => void) | undefined;

  const resultPromise = runStreamingPrompt(
    "acpx",
    ["prompt"],
    async (event) => {
      if (event.type === "prompt.segment") {
        segments.push(event.text);
      }
    },
    {
      spawnPrompt: () =>
        ({
          stdout: {
            setEncoding: () => {},
            on: (event: "data", handler: (chunk: string | Buffer) => void) => {
              if (event === "data") {
                dataHandler = handler;
              }
            },
          },
          stderr: {
            on: () => {},
          },
          on: (event: "close" | "error", handler: (code: number | null) => void) => {
            if (event === "close") {
              closeHandler = handler;
            }
          },
        }) as unknown as {
          stdout: { setEncoding: (encoding: string) => void; on: (event: "data", handler: (chunk: string | Buffer) => void) => void };
          stderr: { on: (event: "data" | "error", handler: (chunk: string | Buffer) => void) => void };
          on: (event: "close" | "error", handler: (code: number | null) => void) => void;
        },
      setIntervalFn: (callback) => {
        intervalCallback = callback;
        return 1;
      },
      clearIntervalFn: () => {},
      maxSegmentWaitMs: 1_000,
      flushCheckIntervalMs: 100,
      now: () => currentTime,
    },
  );

  dataHandler?.(
    `${JSON.stringify({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "still thinking" },
        },
      },
    })}\n`,
  );

  currentTime = 1_500;
  intervalCallback?.();

  closeHandler?.(0);
  await expect(resultPromise).resolves.toEqual({
    code: 0,
    stdout: expect.stringContaining("still thinking"),
    stderr: "",
  });
  expect(segments).toEqual(["still thinking"]);
});

test("runStreamingPrompt folds tool calls into segments when toolEventMode is 'text'", async () => {
  const segments: string[] = [];
  let dataHandler: ((chunk: string | Buffer) => void) | undefined;
  let closeHandler: ((code: number | null) => void) | undefined;

  const resultPromise = runStreamingPrompt(
    "acpx",
    ["prompt"],
    (event) => {
      if (event.type === "prompt.segment") segments.push(event.text);
    },
    {
      spawnPrompt: () =>
        ({
          stdout: {
            setEncoding: () => {},
            on: (event: "data", handler: (chunk: string | Buffer) => void) => {
              if (event === "data") dataHandler = handler;
            },
          },
          stderr: { on: () => {} },
          on: (event: "close" | "error", handler: (code: number | null) => void) => {
            if (event === "close") closeHandler = handler;
          },
        }) as never,
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
      formatToolCalls: true,
      toolEventMode: "text",
    },
  );

  dataHandler?.(`${JSON.stringify({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        kind: "read",
        title: "Read File",
        rawInput: { path: "foo.ts" },
        status: "completed",
      },
    },
  })}\n`);
  closeHandler?.(0);

  await resultPromise;
  expect(segments).toHaveLength(1);
  expect(segments[0]).toContain("Read File");
  expect(segments[0]).toContain("foo.ts");
});

test("runStreamingPrompt emits structured tool events when toolEventMode is 'structured'", async () => {
  const events: unknown[] = [];
  let dataHandler: ((chunk: string | Buffer) => void) | undefined;
  let closeHandler: ((code: number | null) => void) | undefined;

  const resultPromise = runStreamingPrompt(
    "acpx",
    ["prompt"],
    (event) => events.push(event),
    {
      spawnPrompt: () =>
        ({
          stdout: {
            setEncoding: () => {},
            on: (event: "data", handler: (chunk: string | Buffer) => void) => {
              if (event === "data") dataHandler = handler;
            },
          },
          stderr: { on: () => {} },
          on: (event: "close" | "error", handler: (code: number | null) => void) => {
            if (event === "close") closeHandler = handler;
          },
        }) as never,
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
      formatToolCalls: true,
      toolEventMode: "structured",
    },
  );

  dataHandler?.(`${JSON.stringify({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        kind: "execute",
        title: "Bash",
        rawInput: { command: "npm", args: ["test"] },
        status: "pending",
      },
    },
  })}\n`);
  closeHandler?.(0);

  await resultPromise;
  expect(events).toEqual([
    {
      type: "prompt.tool_event",
      event: {
        toolCallId: "t1",
        toolName: "Bash",
        kind: "execute",
        summary: "npm test",
        rawInput: { command: "npm", args: ["test"] },
        status: "running",
      },
    },
  ]);
});

test("selectLatestAcpxSessionIndexTmp ignores malformed files and picks latest timestamp", () => {
  expect(selectLatestAcpxSessionIndexTmp([
    "index.json",
    "index.json.12.bad.tmp",
    "index.json.1.100.tmp",
    "index.json.3.250.tmp",
    "index.json.2.250.tmp",
    "index.json.9.249.tmp",
  ])).toBe("index.json.3.250.tmp");
});

test("tryRepairAcpxSessionIndex copies latest tmp over index on windows", async () => {
  const calls: Array<{ from: string; to: string }> = [];
  await expect(tryRepairAcpxSessionIndex({
    platform: "win32",
    home: "C:\\Users\\alice",
    readdirFn: async () => [
      "index.json",
      "index.json.10.111.tmp",
      "index.json.11.222.tmp",
      "random.txt",
    ],
    copyFileFn: async (from, to) => {
      calls.push({ from, to });
    },
  })).resolves.toBe(true);

  expect(calls).toEqual([
    {
      from: "C:\\Users\\alice\\.acpx\\sessions\\index.json.11.222.tmp",
      to: "C:\\Users\\alice\\.acpx\\sessions\\index.json",
    },
  ]);
});

test("ensureSession retries after EPERM repair succeeds", async () => {
  const runResults = [
    { code: 1, stdout: "", stderr: "ensure failed" },
    { code: 1, stdout: "", stderr: "show failed" },
    { code: 0, stdout: "session exists now", stderr: "" },
  ];
  let repairCalls = 0;
  const runtime = new BridgeRuntime(
    "acpx",
    async () => runResults.shift() ?? { code: 0, stdout: "", stderr: "" },
    async () => ({ code: 1, stdout: "", stderr: "EPERM: rename index.json.tmp failed" }),
    {},
    undefined,
    async () => {
      repairCalls += 1;
      return true;
    },
  );

  await expect(runtime.ensureSession({
    agent: "codex",
    cwd: "/repo",
    name: "demo",
  })).resolves.toEqual({});
  expect(repairCalls).toBe(1);
});

// ── session init timeout tests ───────────────────────────────────────────────

interface FakeSpawnChildOptions {
  pid: number;
  /** When set, fire the close handler with this exit code on the next tick. */
  closeWithCode?: number;
}

function makeFakeSpawnChild(options: FakeSpawnChildOptions) {
  return {
    pid: options.pid,
    stdout: { setEncoding: () => {}, on: () => {} },
    stderr: { setEncoding: () => {}, on: () => {} },
    on: (event: string, handler: (code: number | null) => void) => {
      if (event === "close" && options.closeWithCode !== undefined) {
        setTimeout(() => handler(options.closeWithCode!), 0);
      }
    },
  };
}

function makeTimeoutTestRuntime(childOptions: FakeSpawnChildOptions, sessionInitTimeoutMs: number) {
  const killed: number[] = [];
  const spawnFn = (() => makeFakeSpawnChild(childOptions)) as never;
  const killProcessTreeFn = async (pid: number) => {
    killed.push(pid);
  };
  const runtime = new BridgeRuntime(
    "acpx",
    (command, args, options?: CommandRunnerOptions) =>
      spawnCapture(command, args, { ...options, spawnFn, killProcessTreeFn }),
    (command, args, cwd, options?: CommandRunnerOptions) =>
      spawnCapture(command, args, { ...options, cwd, spawnFn, killProcessTreeFn }),
    { sessionInitTimeoutMs },
  );
  return { runtime, killed };
}

test("ensureSession kills the hung acpx spawn and rejects once the session init timeout expires", async () => {
  // The fake child never emits "close" — equivalent to acpx hanging on agent init.
  const { runtime, killed } = makeTimeoutTestRuntime({ pid: 4242 }, 50);

  let caught: unknown;
  try {
    await runtime.ensureSession({ agent: "codex", cwd: "/repo", name: "demo" });
  } catch (error) {
    caught = error;
  }

  expect((caught as Error).message).toBe("session initialization timed out after 0.05s");
  expect((caught as { kind?: string }).kind).toBe("generic");
  expect(killed).toEqual([4242]);
});

test("ensureSession completes within the session init timeout and never fires the kill timer", async () => {
  const { runtime, killed } = makeTimeoutTestRuntime({ pid: 1111, closeWithCode: 0 }, 30);

  await expect(runtime.ensureSession({ agent: "codex", cwd: "/repo", name: "demo" })).resolves.toEqual({});

  // If the timer were left dangling it would fire here and kill pid 1111.
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(killed).toEqual([]);
});

test("ensureSession defaults the session init timeout to 120s and threads it into ensure and create spawns", async () => {
  const ensureTimeouts: Array<number | undefined> = [];
  const createTimeouts: Array<number | undefined> = [];
  const defaultedRuntime = new BridgeRuntime(
    "acpx",
    async (_command, args, options?: CommandRunnerOptions) => {
      if (args.includes("ensure")) ensureTimeouts.push(options?.timeoutMs);
      return { code: args.includes("ensure") ? 0 : 1, stdout: "", stderr: "" };
    },
    undefined,
    { now: () => 0 },
  );
  await defaultedRuntime.ensureSession({ agent: "codex", cwd: "/repo", name: "demo" });
  expect(ensureTimeouts).toEqual([120_000]);

  const configuredRuntime = new BridgeRuntime(
    "acpx",
    async (_command, args, options?: CommandRunnerOptions) => {
      if (args.includes("ensure")) ensureTimeouts.push(options?.timeoutMs);
      return { code: 1, stdout: "", stderr: "boom" };
    },
    async (_command, _args, _cwd, options?: CommandRunnerOptions) => {
      createTimeouts.push(options?.timeoutMs);
      return { code: 0, stdout: "", stderr: "" };
    },
    { sessionInitTimeoutMs: 45_000, now: () => 0 },
  );
  await configuredRuntime.ensureSession({ agent: "codex", cwd: "/repo", name: "demo" });
  expect(ensureTimeouts).toEqual([120_000, 45_000]);
  expect(createTimeouts).toEqual([45_000]);
});

test("ensureSession shares one deadline: later steps only get the remaining budget", async () => {
  let clock = 0;
  const captured: Array<{ step: string; timeoutMs: number | undefined }> = [];
  const runtime = new BridgeRuntime(
    "acpx",
    async (_command, args, options?: CommandRunnerOptions) => {
      if (args.includes("ensure")) {
        captured.push({ step: "ensure", timeoutMs: options?.timeoutMs });
        clock += 80_000;
        return { code: 1, stdout: "", stderr: "ensure failed" };
      }
      captured.push({ step: "show", timeoutMs: options?.timeoutMs });
      clock += 15_000;
      return { code: 1, stdout: "", stderr: "show failed" };
    },
    async (_command, _args, _cwd, options?: CommandRunnerOptions) => {
      captured.push({ step: "new", timeoutMs: options?.timeoutMs });
      return { code: 0, stdout: "", stderr: "" };
    },
    { sessionInitTimeoutMs: 100_000, now: () => clock },
  );

  await runtime.ensureSession({ agent: "codex", cwd: "/repo", name: "demo" });

  expect(captured).toEqual([
    { step: "ensure", timeoutMs: 100_000 },
    { step: "show", timeoutMs: 20_000 },
    { step: "new", timeoutMs: 5_000 },
  ]);
});

test("ensureSession floors the per-step timeout at 1ms once the deadline is spent", async () => {
  let clock = 0;
  const captured: Array<number | undefined> = [];
  const runtime = new BridgeRuntime(
    "acpx",
    async (_command, args, options?: CommandRunnerOptions) => {
      captured.push(options?.timeoutMs);
      if (args.includes("ensure")) clock += 150_000; // burns past the whole budget
      return { code: 1, stdout: "", stderr: "failed" };
    },
    async (_command, _args, _cwd, options?: CommandRunnerOptions) => {
      captured.push(options?.timeoutMs);
      return { code: 0, stdout: "", stderr: "" };
    },
    { sessionInitTimeoutMs: 100_000, now: () => clock },
  );

  await runtime.ensureSession({ agent: "codex", cwd: "/repo", name: "demo" });

  expect(captured).toEqual([100_000, 1, 1]);
});

test("ensureSession verbose-fallback retry draws from the same shared deadline", async () => {
  let clock = 0;
  const ensureTimeouts: Array<number | undefined> = [];
  const runtime = new BridgeRuntime(
    "acpx",
    async (_command, args, options?: CommandRunnerOptions) => {
      ensureTimeouts.push(options?.timeoutMs);
      clock += 30_000;
      if (args.includes("--verbose")) {
        return { code: 1, stdout: "", stderr: "error: unknown option '--verbose'" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    undefined,
    { sessionInitTimeoutMs: 100_000, now: () => clock },
  );

  await runtime.ensureSession({ agent: "codex", cwd: "/repo", name: "demo" });

  expect(ensureTimeouts).toEqual([100_000, 70_000]);
});

test("ensureSession surfaces the configured total when a later step times out", async () => {
  let clock = 0;
  const runtime = new BridgeRuntime(
    "acpx",
    async (_command, args) => {
      if (args.includes("ensure")) {
        clock += 90_000;
        return { code: 1, stdout: "", stderr: "ensure failed" };
      }
      // Show probe hangs until its (remaining) slice expires.
      clock += 10_000;
      throw new CommandTimeoutError(10_000, "acpx sessions show demo");
    },
    undefined,
    { sessionInitTimeoutMs: 100_000, now: () => clock },
  );

  let caught: unknown;
  try {
    await runtime.ensureSession({ agent: "codex", cwd: "/repo", name: "demo" });
  } catch (error) {
    caught = error;
  }

  expect((caught as Error).name).toBe("EnsureSessionFailedError");
  expect((caught as Error).message).toBe("session initialization timed out after 100s");
});

test("prompt and other session commands are not subject to the session init timeout", async () => {
  const timeouts: Array<number | undefined> = [];
  const runtime = new BridgeRuntime(
    "acpx",
    async (_command, _args, options?: CommandRunnerOptions) => {
      timeouts.push(options?.timeoutMs);
      return { code: 0, stdout: "agent reply", stderr: "" };
    },
    undefined,
    { sessionInitTimeoutMs: 50 },
  );

  await runtime.prompt({ agent: "codex", cwd: "/repo", name: "demo", text: "hello" });
  await runtime.hasSession({ agent: "codex", cwd: "/repo", name: "demo" });

  expect(timeouts).toEqual([undefined, undefined]);
});

test("prompt starts queue owner with orchestration MCP identity", async () => {
  const launches: unknown[] = [];
  const queueOwnerLauncher = {
    launch: async (input: unknown) => {
      launches.push(input);
    },
  } as Pick<AcpxQueueOwnerLauncher, "launch">;
  const run = async (_command: string, args: string[]) => {
    if (args.includes("show")) {
      return { code: 0, stdout: JSON.stringify({ acpxRecordId: "acpx-record-1" }), stderr: "" };
    }
    return { code: 0, stdout: "worker response", stderr: "" };
  };
  const runtime = new BridgeRuntime("acpx", run, undefined, {}, undefined, undefined, queueOwnerLauncher);

  await expect(runtime.prompt({
    agent: "codex",
    cwd: "/repo",
    name: "worker",
    text: "hello",
    mcpCoordinatorSession: "backend:main",
    mcpSourceHandle: "backend:claude:backend:main",
  })).resolves.toEqual({ text: "worker response" });

  expect(launches).toEqual([{
    acpxRecordId: "acpx-record-1",
    coordinatorSession: "backend:main",
    sourceHandle: "backend:claude:backend:main",
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
  }]);
});

test("prompt forwards --ttl when queueOwnerTtlSeconds is configured", async () => {
  const calls: string[][] = [];
  const run = async (_command: string, args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: "worker response", stderr: "" };
  };
  const runtime = new BridgeRuntime("acpx", run, undefined, { queueOwnerTtlSeconds: 1800 });

  await runtime.prompt({ agent: "codex", cwd: "/repo", name: "worker", text: "hello" });

  expect(calls).toHaveLength(1);
  const ttlIndex = calls[0]!.indexOf("--ttl");
  expect(ttlIndex).toBeGreaterThan(0);
  expect(calls[0]![ttlIndex + 1]).toBe("1800");
});

test("prompt omits --ttl when queueOwnerTtlSeconds is not configured", async () => {
  const calls: string[][] = [];
  const run = async (_command: string, args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: "worker response", stderr: "" };
  };
  const runtime = new BridgeRuntime("acpx", run, undefined, {});

  await runtime.prompt({ agent: "codex", cwd: "/repo", name: "worker", text: "hello" });

  expect(calls).toHaveLength(1);
  expect(calls[0]).not.toContain("--ttl");
});

test("ensureSession forwards --permission-policy when configured", async () => {
  const calls: string[][] = [];
  const run = async (_command: string, args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "" };
  };
  const runtime = new BridgeRuntime(
    "acpx",
    run,
    async () => ({ code: 0, stdout: "", stderr: "" }),
    { permissionPolicy: "C:/policies/weacpx-policy.json" } as never,
  );

  await runtime.ensureSession({ agent: "codex", cwd: "/repo", name: "demo" });

  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("--approve-all");
  expect(calls[0]).toContain("--non-interactive-permissions");
  expect(calls[0]).toContain("deny");
  expect(calls[0]).toContain("--permission-policy");
  expect(calls[0]).toContain("C:/policies/weacpx-policy.json");
});

test("ensureSession emits spawn/initializing/ready when EPERM repair succeeds", async () => {
  const stages: EnsureSessionProgressStage[] = [];
  const runResults = [
    { code: 1, stdout: "", stderr: "ensure failed" },
    { code: 1, stdout: "", stderr: "show failed" },
    { code: 0, stdout: "session exists now", stderr: "" },
  ];
  const runtime = new BridgeRuntime(
    "acpx",
    async () => runResults.shift() ?? { code: 0, stdout: "", stderr: "" },
    async () => ({ code: 1, stdout: "", stderr: "EPERM: rename index.json.tmp failed" }),
    {},
    undefined,
    async () => true,
  );

  await runtime.ensureSession(
    { agent: "codex", cwd: "/repo", name: "demo" },
    (stage) => stages.push(stage),
  );
  expect(stages).toEqual(["spawn", "initializing", "ready"]);
});

import type { EnsureSessionProgressStage } from "../../../src/transport/acpx-bridge/acpx-bridge-protocol";

test("ensureSession emits spawn/initializing/ready progress on success", async () => {
  const stages: EnsureSessionProgressStage[] = [];
  const run = async () => ({ code: 0, stdout: "", stderr: "" });
  const runCreate = async () => ({ code: 0, stdout: "", stderr: "" });
  const runtime = new BridgeRuntime("acpx", run, runCreate);
  await runtime.ensureSession({
    agent: "codex",
    cwd: "/tmp",
    name: "x",
  }, (stage) => stages.push(stage));
  // "ensure" path returns early -> at least spawn and ready emitted
  expect(stages[0]).toBe("spawn");
  expect(stages.at(-1)).toBe("ready");
});

test("ensureSession throws MissingOptionalDepErrorInfo when stderr matches", async () => {
  const run = async () => ({ code: 1, stdout: "", stderr: "" });
  const runCreate = async () => ({
    code: 1,
    stdout: "",
    stderr: `It seems that your package manager failed to install the right version of the opencode CLI for your platform. You can try manually installing "opencode-windows-x64" package`,
  });
  const runtime = new BridgeRuntime("acpx", run, runCreate);
  let caught: unknown;
  try {
    await runtime.ensureSession({ agent: "opencode", cwd: "/tmp", name: "x" });
  } catch (err) {
    caught = err;
  }
  expect((caught as { kind?: string }).kind).toBe("missing_optional_dep");
  expect((caught as { data?: { package?: string } }).data?.package).toBe("opencode-windows-x64");
});

test("ensureSession falls back to generic kind when stderr does not match", async () => {
  const run = async () => ({ code: 1, stdout: "", stderr: "" });
  const runCreate = async () => ({ code: 1, stdout: "", stderr: "unrelated boom" });
  const runtime = new BridgeRuntime("acpx", run, runCreate);
  let caught: unknown;
  try {
    await runtime.ensureSession({ agent: "opencode", cwd: "/tmp", name: "x" });
  } catch (err) {
    caught = err;
  }
  expect((caught as { kind?: string }).kind).toBe("generic");
});

// ── toolEventMode wiring tests ───────────────────────────────────────────────

function makeSpawnPrompt(dataHandler: { current?: (chunk: string) => void }, closeHandler: { current?: (code: number | null) => void }) {
  return () => ({
    stdout: {
      setEncoding: () => {},
      on: (_event: "data", handler: (chunk: string | Buffer) => void) => {
        dataHandler.current = handler as (chunk: string) => void;
      },
    },
    stderr: { on: () => {} },
    on: (event: "close" | "error", handler: (code: number | null) => void) => {
      if (event === "close") closeHandler.current = handler;
    },
  }) as never;
}

const toolCallChunk = JSON.stringify({
  method: "session/update",
  params: {
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tc-1",
      kind: "read",
      title: "Read File",
      rawInput: { path: "src/foo.ts" },
      status: "completed",
    },
  },
}) + "\n";

test("bridge runtime emits prompt.tool_event when toolEventMode is 'structured'", async () => {
  const events: unknown[] = [];
  const dataRef: { current?: (chunk: string) => void } = {};
  const closeRef: { current?: (code: number | null) => void } = {};

  const resultPromise = runStreamingPrompt(
    "acpx",
    ["prompt"],
    (event) => events.push(event),
    {
      spawnPrompt: makeSpawnPrompt(dataRef, closeRef),
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
      formatToolCalls: true,
      toolEventMode: "structured",
    },
  );

  dataRef.current?.(toolCallChunk);
  closeRef.current?.(0);
  await resultPromise;

  // structured: only tool events, no text segment for the tool call
  expect(events.filter((e) => (e as { type: string }).type === "prompt.tool_event")).toHaveLength(1);
  expect(events.filter((e) => (e as { type: string }).type === "prompt.segment")).toHaveLength(0);
});

test("bridge runtime emits only text segments when toolEventMode is undefined (Phase 0 invariant)", async () => {
  const events: unknown[] = [];
  const dataRef: { current?: (chunk: string) => void } = {};
  const closeRef: { current?: (code: number | null) => void } = {};

  const resultPromise = runStreamingPrompt(
    "acpx",
    ["prompt"],
    (event) => events.push(event),
    {
      spawnPrompt: makeSpawnPrompt(dataRef, closeRef),
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
      formatToolCalls: true,
      // toolEventMode omitted AND toolEvents omitted → defaults to "text"
    },
  );

  dataRef.current?.(toolCallChunk);
  closeRef.current?.(0);
  await resultPromise;

  // text mode: tool call folded into a text segment, no structured event
  expect(events.filter((e) => (e as { type: string }).type === "prompt.tool_event")).toHaveLength(0);
  const segments = events.filter((e) => (e as { type: string }).type === "prompt.segment");
  expect(segments).toHaveLength(1);
  expect((segments[0] as { text: string }).text).toContain("Read File");
});

test("bridge runtime emits both text segment and tool event when toolEventMode is 'both'", async () => {
  const events: unknown[] = [];
  const dataRef: { current?: (chunk: string) => void } = {};
  const closeRef: { current?: (code: number | null) => void } = {};

  const resultPromise = runStreamingPrompt(
    "acpx",
    ["prompt"],
    (event) => events.push(event),
    {
      spawnPrompt: makeSpawnPrompt(dataRef, closeRef),
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
      formatToolCalls: true,
      toolEventMode: "both",
    },
  );

  dataRef.current?.(toolCallChunk);
  closeRef.current?.(0);
  await resultPromise;

  expect(events.filter((e) => (e as { type: string }).type === "prompt.tool_event")).toHaveLength(1);
  expect(events.filter((e) => (e as { type: string }).type === "prompt.segment")).toHaveLength(1);
});

test("bridge runtime legacy toolEvents:true maps to toolEventMode 'structured'", async () => {
  // Verify BridgeRuntime.prompt() resolves toolEventMode from the legacy toolEvents flag.
  let capturedToolEventMode: string | undefined;

  const stubPromptRunner = async (
    _cmd: string,
    _args: string[],
    _onEvent: unknown,
    opts: { toolEventMode?: string },
  ) => {
    capturedToolEventMode = opts.toolEventMode;
    return { code: 0, stdout: "", stderr: "" };
  };

  const runtime = new BridgeRuntime(
    "acpx",
    async () => ({ code: 0, stdout: "", stderr: "" }),
    undefined,
    {},
    stubPromptRunner as never,
  );

  await runtime.prompt({
    agent: "codex",
    cwd: "/repo",
    name: "s1",
    text: "hello",
    toolEvents: true, // legacy flag — should map to "structured"
  }, () => {});

  expect(capturedToolEventMode).toBe("structured");
});

test("bridge runtime omitting toolEvents and toolEventMode defaults to 'text' mode", async () => {
  let capturedToolEventMode: string | undefined;

  const stubPromptRunner = async (
    _cmd: string,
    _args: string[],
    _onEvent: unknown,
    opts: { toolEventMode?: string },
  ) => {
    capturedToolEventMode = opts.toolEventMode;
    return { code: 0, stdout: "", stderr: "" };
  };

  const runtime = new BridgeRuntime(
    "acpx",
    async () => ({ code: 0, stdout: "", stderr: "" }),
    undefined,
    {},
    stubPromptRunner as never,
  );

  await runtime.prompt({
    agent: "codex",
    cwd: "/repo",
    name: "s1",
    text: "hello",
    // toolEvents and toolEventMode both absent
  }, () => {});

  expect(capturedToolEventMode).toBe("text");
});


test("bridge runtime lists and resumes native sessions", async () => {
  const calls: string[][] = [];
  const createCalls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const runtime = new BridgeRuntime(
    "acpx",
    async (_command, args) => {
      calls.push(args);
      if (args.includes("list")) {
        return {
          code: 0,
          stdout: JSON.stringify({
            source: "agent",
            sessions: [{ sessionId: "thread-1", cwd: "/repo", title: "Fix CI" }],
            nextCursor: null,
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    async (command, args, cwd) => {
      createCalls.push({ command, args, cwd });
      return { code: 0, stdout: "", stderr: "" };
    },
  );

  await expect(runtime.listAgentSessions({
    agent: "codex",
    cwd: "/repo",
    filterCwd: "/repo",
  })).resolves.toEqual({
    source: "agent",
    sessions: [{ sessionId: "thread-1", cwd: "/repo", title: "Fix CI" }],
    nextCursor: null,
  });

  await expect(runtime.resumeAgentSession({
    agent: "codex",
    cwd: "/repo",
    name: "project:codex",
    agentSessionId: "thread-1",
  })).resolves.toEqual({});

  expect(calls).toEqual([
    [
      "--format", "json", "--cwd", "/repo", "--approve-all", "--non-interactive-permissions", "deny",
      "codex", "sessions", "list", "--filter-cwd", "/repo",
    ],
  ]);
  expect(createCalls).toEqual([
    {
      command: "acpx",
      args: [
        "--format", "quiet", "--cwd", "/repo", "--approve-all", "--non-interactive-permissions", "deny",
        "codex", "sessions", "new", "--name", "project:codex", "--resume-session", "thread-1",
      ],
      cwd: "/repo",
    },
  ]);
});

test("bridge runtime retries native session listing without --filter-cwd when unsupported", async () => {
  const calls: string[][] = [];
  const runtime = new BridgeRuntime("acpx", async (_command, args) => {
    calls.push(args);
    if (args.includes("--filter-cwd")) {
      return {
        code: 1,
        stdout: "",
        stderr: "error: unknown option '--filter-cwd'",
      };
    }
    return {
      code: 0,
      stdout: JSON.stringify({
        source: "agent",
        sessions: [
          { sessionId: "thread-1", cwd: "/repo", title: "Fix CI" },
          { sessionId: "thread-2", cwd: "/other", title: "Other" },
        ],
      }),
      stderr: "",
    };
  });

  await expect(runtime.listAgentSessions({
    agent: "claude",
    cwd: "/repo",
    filterCwd: "/repo",
  })).resolves.toEqual({
    source: "agent",
    sessions: [{ sessionId: "thread-1", cwd: "/repo", title: "Fix CI" }],
  });

  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain("--filter-cwd");
  expect(calls[1]).not.toContain("--filter-cwd");
});

test("getAgentSessionId returns the agentSessionId from sessions show", async () => {
  const run = async (_command: string, _args: string[]) => ({
    code: 0,
    stdout: JSON.stringify({ acpxRecordId: "acpx-rec-1", agentSessionId: "agent-xyz" }),
    stderr: "",
  });
  const runtime = new BridgeRuntime("acpx", run);

  const result = await runtime.getAgentSessionId({
    agent: "codex",
    agentCommand: "codex",
    cwd: "/tmp/backend",
    name: "backend:review",
  });

  expect(result).toEqual({ agentSessionId: "agent-xyz" });
});

test("getAgentSessionId returns undefined agentSessionId when absent", async () => {
  const run = async (_command: string, _args: string[]) => ({
    code: 0,
    stdout: JSON.stringify({ acpxRecordId: "acpx-rec-1" }),
    stderr: "",
  });
  const runtime = new BridgeRuntime("acpx", run);

  const result = await runtime.getAgentSessionId({
    agent: "codex",
    cwd: "/tmp/backend",
    name: "backend:review",
  });

  expect(result).toEqual({ agentSessionId: undefined });
});
