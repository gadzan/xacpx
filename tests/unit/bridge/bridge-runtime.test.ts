import { expect, spyOn, test } from "bun:test";

import {
  BridgeRuntime,
  CommandTimeoutError,
  runStreamingPrompt,
  selectLatestAcpxSessionIndexTmp,
  spawnCapture,
  tryRepairAcpxSessionIndex,
  type CommandRunnerOptions,
} from "../../../src/bridge/bridge-runtime";
import { AcpxQueueOwnerLauncher } from "../../../src/transport/acpx-queue-owner-launcher";

test("injects the filtered Claude environment into bridge acpx commands", async () => {
  const observed: Array<NodeJS.ProcessEnv | undefined> = [];
  const runtime = new BridgeRuntime(
    "acpx",
    async (_command, _args, options) => {
      observed.push(options?.env);
      return { code: 0, stdout: "", stderr: "" };
    },
    undefined,
    {
      resolveSpawnEnvironment: ({ driver, settingsPolicy, model }) =>
        driver === "claude" && settingsPolicy === "provider-only" && model === "web-model"
          ? { FILTERED_PROVIDER: "yes" }
          : undefined,
    },
  );

  await runtime.ensureSession({
    agent: "claude-provider",
    driver: "claude",
    settingsPolicy: "provider-only",
    model: "web-model",
    cwd: "/repo",
    name: "demo",
  });

  expect(observed).toEqual([{ FILTERED_PROVIDER: "yes" }]);
});

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

test("runStreamingPrompt preserves text → tool → text order in raw bridge events", async () => {
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
      rawStream: true,
      toolEventMode: "structured",
    },
  );

  const lines = [
    {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "message-1",
          content: { type: "text", text: "before。" },
        },
      },
    },
    {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          kind: "read",
          title: "Read File",
        },
      },
    },
    {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "message-2",
          content: { type: "text", text: "after" },
        },
      },
    },
    {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
        },
      },
    },
  ];
  dataHandler?.(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  closeHandler?.(0);

  await resultPromise;
  expect(events).toEqual([
    { type: "prompt.segment", text: "before。" },
    expect.objectContaining({
      type: "prompt.tool_event",
      event: expect.objectContaining({ toolCallId: "tool-1" }),
    }),
    { type: "prompt.segment", text: "\n\nafter" },
    expect.objectContaining({
      type: "prompt.tool_event",
      event: expect.objectContaining({ toolCallId: "tool-1", status: "success" }),
    }),
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

test("selectLatestAcpxSessionIndexTmp accepts UUID temp files and mixes legacy/current formats", () => {
  expect(selectLatestAcpxSessionIndexTmp([
    "index.json.1.100.550e8400-e29b-41d4-a716-446655440000.tmp",
    "index.json.2.250.tmp",
    "index.json.3.249.550e8400-e29b-41d4-a716-446655440001.tmp",
    "index.json.4.250.9d2d9c9a-1f2e-4a3b-8c5d-0f6e7a8b9c0d.tmp",
  ])).toBe("index.json.2.250.tmp");
});

test("selectLatestAcpxSessionIndexTmp ignores extra hierarchy levels and wrong suffixes", () => {
  expect(selectLatestAcpxSessionIndexTmp([
    "index.json.1.100.abc.def.tmp",
    "index.json.2.200.tmp.bak",
    "index.json.3.300.550e8400-e29b-41d4-a716-446655440000.json",
    "index.json.4.400.tmp",
  ])).toBe("index.json.4.400.tmp");
});

test("tryRepairAcpxSessionIndex copies latest tmp over index on windows", async () => {
  const calls: Array<{ from: string; to: string }> = [];
  await expect(tryRepairAcpxSessionIndex({
    platform: "win32",
    home: "C:\\Users\\alice",
    readdirFn: async () => [
      "index.json",
      "index.json.10.111.550e8400-e29b-41d4-a716-446655440000.tmp",
      "index.json.11.222.550e8400-e29b-41d4-a716-446655440001.tmp",
      "random.txt",
    ],
    copyFileFn: async (from, to) => {
      calls.push({ from, to });
    },
  })).resolves.toBe(true);

  expect(calls).toEqual([
    {
      from: "C:\\Users\\alice\\.acpx\\sessions\\index.json.11.222.550e8400-e29b-41d4-a716-446655440001.tmp",
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
  stdout?: string;
  stderr?: string;
}

function makeFakeSpawnChild(options: FakeSpawnChildOptions) {
  return {
    pid: options.pid,
    stdout: {
      setEncoding: () => {},
      on: (event: string, handler: (chunk: string) => void) => {
        if (event === "data" && options.stdout) handler(options.stdout);
      },
    },
    stderr: {
      setEncoding: () => {},
      on: (event: string, handler: (chunk: string) => void) => {
        if (event === "data" && options.stderr) handler(options.stderr);
      },
    },
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

test("ensureSession fails closed when sessions show succeeds with a corrupt record", async () => {
  const calls: string[][] = [];
  const runtime = new BridgeRuntime(
    "acpx",
    async (_command, args) => {
      calls.push(args);
      if (args.includes("show")) {
        return { code: 0, stdout: "{truncated", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  );

  await expect(runtime.ensureSession({
    agent: "custom",
    acpxAgent: "xacpx-managed-custom-aaaabbbbcccc",
    agentCommand: "/opt/custom --acp",
    agentArgv: ["/opt/custom", "--acp"],
    cwd: "/repo",
    name: "demo",
  })).rejects.toThrow(/record|parse|malformed|corrupt/i);

  expect(calls.some((args) => args.includes("ensure") || args.includes("new"))).toBe(false);
});

test("prompt is unbounded while management commands get the management timeout", async () => {
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

  // Long agent turns are legitimate: no total-duration timeout on prompt.
  await runtime.prompt({ agent: "codex", cwd: "/repo", name: "demo", text: "hello" });
  // One-shot management commands must be bounded so a hung acpx can't wedge
  // the session's serial bridge lane forever.
  await runtime.hasSession({ agent: "codex", cwd: "/repo", name: "demo" });

  expect(timeouts).toEqual([undefined, 30_000]);
});

test("management commands honor a configured managementCommandTimeoutMs", async () => {
  const timeouts: Array<number | undefined> = [];
  const runtime = new BridgeRuntime(
    "acpx",
    async (_command, _args, options?: CommandRunnerOptions) => {
      timeouts.push(options?.timeoutMs);
      return { code: 0, stdout: "", stderr: "" };
    },
    undefined,
    { managementCommandTimeoutMs: 5_000 },
  );

  await runtime.hasSession({ agent: "codex", cwd: "/repo", name: "demo" });
  await runtime.cancel({ agent: "codex", cwd: "/repo", name: "demo" });
  await runtime.setMode({ agent: "codex", cwd: "/repo", name: "demo", modeId: "plan" });
  await runtime.removeSession({ agent: "codex", cwd: "/repo", name: "demo" });

  expect(timeouts).toEqual([5_000, 5_000, 5_000, 5_000]);
});

test("a hung management command kills the spawned tree and rejects with CommandTimeoutError", async () => {
  // The fake child never emits "close" — equivalent to acpx wedging on
  // `sessions show`. The management timeout must kill it and reject so the
  // session's serial bridge lane unblocks.
  const killed: number[] = [];
  const spawnFn = (() => makeFakeSpawnChild({ pid: 777 })) as never;
  const runtime = new BridgeRuntime(
    "acpx",
    (command, args, options?: CommandRunnerOptions) =>
      spawnCapture(command, args, {
        ...options,
        spawnFn,
        killProcessTreeFn: async (pid: number) => {
          killed.push(pid);
        },
      }),
    undefined,
    { managementCommandTimeoutMs: 50 },
  );

  let caught: unknown;
  try {
    await runtime.hasSession({ agent: "codex", cwd: "/repo", name: "demo" });
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(CommandTimeoutError);
  expect(killed).toEqual([777]);
});

test("a set-model timeout identifies its stage and preserves captured output tails", async () => {
  const stdoutTail = "O".repeat(2_000);
  const stderrTail = "E".repeat(2_000);
  const spawnFn = (() => makeFakeSpawnChild({
    pid: 778,
    stdout: `discarded stdout\n${stdoutTail}\n`,
    stderr: `discarded stderr\n${stderrTail}\n`,
  })) as never;
  const runtime = new BridgeRuntime(
    "acpx",
    (command, args, options?: CommandRunnerOptions) => spawnCapture(command, args, {
      ...options,
      spawnFn,
      killProcessTreeFn: async () => {},
    }),
    undefined,
    { managementCommandTimeoutMs: 20 },
  );

  let caught: unknown;
  try {
    await runtime.setModel({ agent: "codex", cwd: "/repo", name: "demo", modelId: "gpt-5.2[high]" });
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(CommandTimeoutError);
  expect((caught as Error).message).toContain("during set-model");
  expect(caught).toMatchObject({ stdoutTail, stderrTail });
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

test("prompt stops the queue owner after an ACP queue overflow and never retries", async () => {
  const calls: string[][] = [];
  const cleanup: string[] = [];
  const run = async (_command: string, args: string[]) => {
    calls.push(args);
    if (args.includes("show")) {
      return { code: 0, stdout: JSON.stringify({ acpxRecordId: "acpx-record-overflow" }), stderr: "" };
    }
    if (args.includes("cancel")) {
      cleanup.push("cancel");
      return { code: 0, stdout: "cancelled", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "Message buffer exceeded 10485760 bytes" };
  };
  const runtime = new BridgeRuntime(
    "acpx",
    run,
    undefined,
    {
      terminateQueueOwner: async (recordId: string) => {
        cleanup.push(`terminate:${recordId}`);
      },
    },
  );

  await expect(runtime.prompt({
    agent: "codex",
    cwd: "/repo",
    name: "worker",
    text: "run the task",
  })).rejects.toMatchObject({
    code: "ACPX_QUEUE_MESSAGE_OVERFLOW",
  });

  expect(calls.filter((args) => args.includes("prompt"))).toHaveLength(1);
  expect(cleanup).toEqual(["cancel", "terminate:acpx-record-overflow"]);
});

test("prompt keeps the overflow as the primary error when owner cleanup fails", async () => {
  const calls: string[][] = [];
  const run = async (_command: string, args: string[]) => {
    calls.push(args);
    if (args.includes("show")) {
      return { code: 0, stdout: JSON.stringify({ acpxRecordId: "acpx-record-overflow" }), stderr: "" };
    }
    if (args.includes("cancel")) {
      return { code: 1, stdout: "", stderr: "cancel unavailable" };
    }
    return { code: 1, stdout: "", stderr: "QUEUE_EVENT_TOO_LARGE" };
  };
  const runtime = new BridgeRuntime(
    "acpx",
    run,
    undefined,
    {
      terminateQueueOwner: async () => {
        throw new Error("owner cleanup unavailable");
      },
    },
  );

  let caught: unknown;
  try {
    await runtime.prompt({
      agent: "codex",
      cwd: "/repo",
      name: "worker",
      text: "run the task",
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code: "ACPX_QUEUE_MESSAGE_OVERFLOW" });
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toContain("owner cleanup unavailable");
  expect((caught as Error).message).toContain("not retried automatically");

  expect(calls.filter((args) => args.includes("prompt"))).toHaveLength(1);
});

test("prompt still attempts cancel when the queue owner record cannot be read", async () => {
  const calls: string[][] = [];
  let terminated = false;
  const run = async (_command: string, args: string[]) => {
    calls.push(args);
    if (args.includes("show")) {
      return { code: 1, stdout: "", stderr: "session index unavailable" };
    }
    if (args.includes("cancel")) {
      return { code: 0, stdout: "cancelled", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "Message buffer exceeded 10485760 bytes" };
  };
  const runtime = new BridgeRuntime(
    "acpx",
    run,
    undefined,
    { terminateQueueOwner: async () => { terminated = true; } },
  );

  let caught: unknown;
  try {
    await runtime.prompt({ agent: "codex", cwd: "/repo", name: "worker", text: "run the task" });
  } catch (error) {
    caught = error;
  }

  expect(calls.filter((args) => args.includes("prompt"))).toHaveLength(1);
  expect(calls.filter((args) => args.includes("cancel"))).toHaveLength(1);
  expect(terminated).toBe(false);
  expect(caught).toMatchObject({ code: "ACPX_QUEUE_MESSAGE_OVERFLOW" });
  expect((caught as Error).message).toContain("cancelled");
  expect((caught as Error).message).not.toContain("queue was stopped");
});

test("prompt does not terminate the owner for an unrelated provider error", async () => {
  const calls: string[][] = [];
  let terminated = false;
  const run = async (_command: string, args: string[]) => {
    calls.push(args);
    return { code: 1, stdout: "", stderr: "provider failed" };
  };
  const runtime = new BridgeRuntime(
    "acpx",
    run,
    undefined,
    {
      terminateQueueOwner: async () => {
        terminated = true;
      },
    },
  );

  await expect(runtime.prompt({
    agent: "codex",
    cwd: "/repo",
    name: "worker",
    text: "run the task",
  })).rejects.toThrow("provider failed");

  expect(terminated).toBe(false);
  expect(calls.some((args) => args.includes("show"))).toBe(false);
});

test("prompt replaces a bridge queue owner when the resolved model changes", async () => {
  const payloads: Array<{ sessionOptions?: { model?: string } }> = [];
  let alive = false;
  let terminateCount = 0;
  const queueOwnerLauncher = new AcpxQueueOwnerLauncher({
    acpxCommand: "acpx",
    spawnOwner: async (_command, _args, options) => {
      alive = true;
      payloads.push(JSON.parse(options.env.ACPX_QUEUE_OWNER_PAYLOAD));
      return 100 + payloads.length;
    },
    terminateOwner: async () => {
      terminateCount += 1;
      alive = false;
    },
    isOwnerAlive: async () => alive,
  });
  const run = async (_command: string, args: string[]) => {
    if (args.includes("show")) {
      return { code: 0, stdout: JSON.stringify({ acpxRecordId: "acpx-record-1" }), stderr: "" };
    }
    return { code: 0, stdout: "worker response", stderr: "" };
  };
  const runtime = new BridgeRuntime("acpx", run, undefined, {}, undefined, undefined, queueOwnerLauncher);
  const baseInput = {
    agent: "codex",
    cwd: "/repo",
    name: "worker",
    text: "hello",
    mcpCoordinatorSession: "backend:main",
  };

  await runtime.prompt({ ...baseInput, model: " model-a " });
  await runtime.prompt({ ...baseInput, model: "model-b" });

  expect(terminateCount).toBe(2);
  expect(payloads.map((payload) => payload.sessionOptions?.model)).toEqual(["model-a", "model-b"]);
});

test("a model change cools the owner and reapplies persisted effort before replacing it", async () => {
  const events: string[] = [];
  const payloads: Array<{ sessionOptions?: { model?: string } }> = [];
  let alive = false;
  const queueOwnerLauncher = new AcpxQueueOwnerLauncher({
    acpxCommand: "acpx",
    spawnOwner: async (_command, _args, options) => {
      alive = true;
      events.push("spawn");
      payloads.push(JSON.parse(options.env.ACPX_QUEUE_OWNER_PAYLOAD));
      return 100 + payloads.length;
    },
    terminateOwner: async () => {
      events.push("replace");
      alive = false;
    },
    isOwnerAlive: async () => alive,
  });
  const run = async (_command: string, args: string[]) => {
    if (args.includes("show")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          acpxRecordId: "acpx-record-1",
          acpx: {
            config_options: [{
              id: "reasoning_effort",
              category: "thought_level",
              currentValue: "medium",
              options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
            }],
          },
        }),
        stderr: "",
      };
    }
    if (args.includes("set")) {
      events.push("set:high");
      return { code: 0, stdout: "", stderr: "" };
    }
    events.push("prompt");
    return { code: 0, stdout: "worker response", stderr: "" };
  };
  const runtime = new BridgeRuntime("acpx", run, undefined, {}, undefined, undefined, queueOwnerLauncher);
  const baseInput = {
    agent: "codex",
    cwd: "/repo",
    name: "worker",
    text: "hello",
    effort: "high",
    mcpCoordinatorSession: "backend:main",
  };

  await runtime.prompt({ ...baseInput, model: "model-a" });
  await runtime.prompt({ ...baseInput, model: "model-b" });

  expect(events).toEqual([
    "replace", "set:high", "replace", "spawn", "prompt",
    "replace", "set:high", "replace", "spawn", "prompt",
  ]);
  expect(payloads.map((payload) => payload.sessionOptions?.model)).toEqual(["model-a", "model-b"]);
});

test("prompt persists effort before launching the queue owner so reconnect replays it", async () => {
  const events: string[] = [];
  const effortRecord = JSON.stringify({
    acpxRecordId: "acpx-record-1",
    acpx: {
      config_options: [{
        id: "reasoning_effort",
        category: "thought_level",
        currentValue: "medium",
        options: [{ value: "medium" }, { value: "high" }],
      }],
    },
  });
  const queueOwnerLauncher = {
    wouldReuse: async () => false,
    cool: async () => {
      events.push("cool");
    },
    launch: async () => {
      events.push("launch");
    },
  };
  const run = async (_command: string, args: string[]) => {
    if (args.includes("show")) {
      return { code: 0, stdout: effortRecord, stderr: "" };
    }
    if (args.includes("set")) {
      events.push("set:high");
      return { code: 0, stdout: "", stderr: "" };
    }
    events.push("prompt");
    return { code: 0, stdout: "worker response", stderr: "" };
  };
  const runtime = new BridgeRuntime("acpx", run, undefined, {}, undefined, undefined, queueOwnerLauncher);

  await runtime.prompt({
    agent: "codex",
    cwd: "/repo",
    name: "worker",
    text: "hello",
    effort: "high",
    mcpCoordinatorSession: "backend:main",
  });

  expect(events).toEqual(["cool", "set:high", "launch", "prompt"]);
});

test("prompt skips effort reapply when a reusable owner already holds the persisted value", async () => {
  const events: string[] = [];
  const queueOwnerLauncher = {
    wouldReuse: async () => true,
    cool: async () => {
      events.push("cool");
    },
    launch: async () => {
      events.push("launch");
    },
  };
  const run = async (_command: string, args: string[]) => {
    if (args.includes("set")) events.push("set");
    if (args.includes("show")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          acpxRecordId: "acpx-record-1",
          acpx: {
            config_options: [{
              id: "reasoning_effort",
              category: "thought_level",
              currentValue: "max",
              options: [{ value: "medium" }, { value: "max" }],
            }],
          },
        }),
        stderr: "",
      };
    }
    events.push(args.includes("prompt") ? "prompt" : "other");
    return { code: 0, stdout: "worker response", stderr: "" };
  };
  const runtime = new BridgeRuntime("acpx", run, undefined, {}, undefined, undefined, queueOwnerLauncher);

  await runtime.prompt({
    agent: "codex",
    cwd: "/repo",
    name: "worker",
    text: "hello",
    effort: "max",
    mcpCoordinatorSession: "backend:main",
  });

  expect(events).toEqual(["launch", "prompt"]);
});

test("prompt cools a reusable owner and reapplies persisted effort when adapter current drifted", async () => {
  const events: string[] = [];
  const queueOwnerLauncher = {
    wouldReuse: async () => true,
    cool: async () => {
      events.push("cool");
    },
    launch: async () => {
      events.push("launch");
    },
  };
  const run = async (_command: string, args: string[]) => {
    if (args.includes("show")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          acpxRecordId: "acpx-record-1",
          acpx: {
            config_options: [{
              id: "reasoning_effort",
              category: "thought_level",
              currentValue: "medium",
              options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
            }],
          },
        }),
        stderr: "",
      };
    }
    if (args.includes("set")) {
      events.push("set:high");
      return { code: 0, stdout: "", stderr: "" };
    }
    events.push("prompt");
    return { code: 0, stdout: "worker response", stderr: "" };
  };
  const runtime = new BridgeRuntime("acpx", run, undefined, {}, undefined, undefined, queueOwnerLauncher);

  await runtime.prompt({
    agent: "codex",
    cwd: "/repo",
    name: "worker",
    text: "hello",
    effort: "high",
    mcpCoordinatorSession: "backend:main",
  });

  expect(events).toEqual(["cool", "set:high", "launch", "prompt"]);
});

test("prompt does not acpx set when the queue owner cannot be cooled", async () => {
  const events: string[] = [];
  const queueOwnerLauncher = {
    wouldReuse: async () => true,
    cool: async () => {
      events.push("cool");
      throw new Error(
        "queue owner for session acpx-record-1 is still live after termination; " +
          "refusing to apply session effort while the owner may still be running",
      );
    },
    launch: async () => {
      events.push("launch");
    },
  };
  const run = async (_command: string, args: string[]) => {
    if (args.includes("show")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          acpxRecordId: "acpx-record-1",
          acpx: {
            config_options: [{
              id: "reasoning_effort",
              category: "thought_level",
              currentValue: "medium",
              options: [{ value: "medium" }, { value: "high" }],
            }],
          },
        }),
        stderr: "",
      };
    }
    if (args.includes("set")) events.push("set");
    events.push(args.includes("prompt") ? "prompt" : "other");
    return { code: 0, stdout: "worker response", stderr: "" };
  };
  const runtime = new BridgeRuntime("acpx", run, undefined, {}, undefined, undefined, queueOwnerLauncher);

  await expect(runtime.prompt({
    agent: "codex",
    cwd: "/repo",
    name: "worker",
    text: "hello",
    effort: "high",
    mcpCoordinatorSession: "backend:main",
  })).rejects.toThrow(/still live after termination/);
  expect(events).toEqual(["cool"]);
});

test("prompt continues when the persisted effort is no longer advertised", async () => {
  const events: string[] = [];
  const queueOwnerLauncher = {
    launch: async () => {
      events.push("launch");
    },
  } as Pick<AcpxQueueOwnerLauncher, "launch">;
  const run = async (_command: string, args: string[]) => {
    if (args.includes("show")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          acpxRecordId: "acpx-record-1",
          acpx: {
            config_options: [{
              id: "reasoning_effort",
              category: "thought_level",
              currentValue: "high",
              options: [{ value: "medium" }, { value: "high" }],
            }],
          },
        }),
        stderr: "",
      };
    }
    if (args.includes("set")) events.push("set");
    else events.push("prompt");
    return { code: 0, stdout: "worker response", stderr: "" };
  };
  const runtime = new BridgeRuntime("acpx", run, undefined, {}, undefined, undefined, queueOwnerLauncher);

  await expect(runtime.prompt({
    agent: "codex",
    cwd: "/repo",
    name: "worker",
    text: "hello",
    effort: "xhigh",
    mcpCoordinatorSession: "backend:main",
  })).resolves.toEqual({ text: "worker response" });
  expect(events).toEqual(["launch", "prompt"]);
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

test("ensureSession retries without --model when the agent does not advertise the requested model", async () => {
  const calls: string[][] = [];
  const modelRejection = {
    code: 1,
    stdout: "",
    stderr:
      '[acpx] initialized protocol version 1\nCannot apply --model "gpt-5.5/high": the ACP agent did not advertise that model. Available models: gpt-5.5[high].',
  };
  // First attempt carries --model and is rejected at every step; the model-less retry
  // succeeds at the `ensure` step.
  const runner = async (_command: string, args: string[]) => {
    calls.push(args);
    if (args.includes("--model")) return modelRejection;
    return { code: 0, stdout: "ok", stderr: "" };
  };
  const runtime = new BridgeRuntime("acpx", runner, runner);
  const notes: string[] = [];
  await expect(
    runtime.ensureSession(
      { agent: "codex", cwd: "/repo", name: "demo", model: "gpt-5.5/high" },
      (progress) => {
        if (typeof progress === "object" && progress.kind === "note") notes.push(progress.text);
      },
    ),
  ).resolves.toEqual({});

  // The first attempt actually tried the requested model...
  expect(calls.some((a) => a.includes("--model"))).toBe(true);
  // ...and a later attempt dropped it to fall back to the agent default.
  expect(calls.some((a) => a.includes("ensure") && !a.includes("--model"))).toBe(true);
  // The fallback is surfaced to the user with the offending model id.
  expect(notes.join(" ")).toContain("gpt-5.5/high");
});

test("ensureSession does not retry for failures unrelated to the model", async () => {
  let attempts = 0;
  const runner = async () => {
    attempts += 1;
    return { code: 1, stdout: "", stderr: "unrelated boom" };
  };
  const runtime = new BridgeRuntime("acpx", runner, runner);
  await expect(
    runtime.ensureSession({ agent: "codex", cwd: "/repo", name: "demo", model: "gpt-5.5[high]" }),
  ).rejects.toThrow("unrelated boom");
  // ensure + show + new from a single attempt — no second (model-less) attempt.
  expect(attempts).toBe(3);
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

test("getAgentSessionId requests JSON and returns acpx 0.12 acpSessionId", async () => {
  const calls: string[][] = [];
  const run = async (_command: string, args: string[]) => {
    calls.push(args);
    return {
      code: 0,
      stdout: JSON.stringify({ acpxRecordId: "acpx-rec-1", acpSessionId: "agent-xyz" }),
      stderr: "",
    };
  };
  const runtime = new BridgeRuntime("acpx", run);

  const result = await runtime.getAgentSessionId({
    agent: "codex",
    agentCommand: "codex",
    cwd: "/tmp/backend",
    name: "backend:review",
  });

  expect(result).toEqual({ agentSessionId: "agent-xyz" });
  expect(calls[0]).toEqual(expect.arrayContaining(["--format", "json", "sessions", "show", "backend:review"]));
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
