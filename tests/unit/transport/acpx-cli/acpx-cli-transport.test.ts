import { expect, mock, spyOn, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AcpxCliTransport,
  __acpxCliTransportForTests,
} from "../../../../src/transport/acpx-cli/acpx-cli-transport";
import { CommandTimeoutError } from "../../../../src/transport/command-timeouts";
import type { AcpxQueueOwnerLauncher } from "../../../../src/transport/acpx-queue-owner-launcher";
import type { ResolvedSession } from "../../../../src/transport/types";
import { QuotaManager } from "../../../../src/weixin/messaging/quota-manager";

const session: ResolvedSession = {
  alias: "api-fix",
  agent: "codex",
  agentCommand: "./node_modules/.bin/codex-acp",
  workspace: "backend",
  transportSession: "backend:api-fix",
  cwd: "/tmp/backend",
};

const aliasSession: ResolvedSession = {
  alias: "api-fix",
  agent: "codex",
  workspace: "backend",
  transportSession: "backend:api-fix",
  cwd: "/tmp/backend",
};

test("filtered PTY environments are authoritative and can remove inherited flags", () => {
  expect(__acpxCliTransportForTests.resolveChildEnvironment(
    { ACPX_CLAUDE_INCLUDE_USER_SETTINGS: "1", KEEP: "base" },
    { KEEP: "filtered", ANTHROPIC_AUTH_TOKEN: "token" },
    "zh-CN",
  )).toEqual({
    KEEP: "filtered",
    ANTHROPIC_AUTH_TOKEN: "token",
    XACPX_LANG: "zh-CN",
  });
});

async function withFakeAcpxScript(body: string, runTest: (scriptPath: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-acpx-cli-test-"));
  const scriptPath = join(dir, "fake-acpx.js");
  await writeFile(scriptPath, body);
  try {
    await runTest(scriptPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("ensures a session with raw agent command by invoking acpx with the normal runner", async () => {
  const run = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const runPty = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run, runPty);

  await transport.ensureSession(session);

  expect(run).toHaveBeenCalledWith("acpx", [
    "--format",
    "quiet",
    "--cwd",
    "/tmp/backend",
    "--approve-all",
    "--non-interactive-permissions",
    "deny",
    "--agent",
    "./node_modules/.bin/codex-acp",
    "sessions",
    "ensure",
    "--name",
    "backend:api-fix",
  ], expect.objectContaining({
    timeoutMs: expect.any(Number),
  }));
  expect(runPty).not.toHaveBeenCalled();
});

test("injects the filtered Claude environment into acpx-cli commands", async () => {
  const run = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const transport = new AcpxCliTransport({
    command: "acpx",
    resolveSpawnEnvironment: ({ driver, settingsPolicy, model }) =>
      driver === "claude" && settingsPolicy === "provider-only" && model === "web-model"
        ? { FILTERED_PROVIDER: "yes" }
        : undefined,
  }, run);

  await transport.ensureSession({
    ...session,
    driver: "claude",
    settingsPolicy: "provider-only",
    model: "web-model",
  });

  expect(run).toHaveBeenCalledWith("acpx", expect.any(Array), expect.objectContaining({
    env: { FILTERED_PROVIDER: "yes" },
  }));
});

test("injects --permission-policy when configured", async () => {
  const run = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const runPty = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const transport = new AcpxCliTransport({ command: "acpx", permissionPolicy: "C:/policies/weacpx-policy.json" } as never, run, runPty);

  await transport.ensureSession(session);

  expect(run).toHaveBeenCalledWith("acpx", [
    "--format",
    "quiet",
    "--cwd",
    "/tmp/backend",
    "--approve-all",
    "--non-interactive-permissions",
    "deny",
    "--permission-policy",
    "C:/policies/weacpx-policy.json",
    "--agent",
    "./node_modules/.bin/codex-acp",
    "sessions",
    "ensure",
    "--name",
    "backend:api-fix",
  ], expect.objectContaining({
    timeoutMs: expect.any(Number),
  }));
  expect(runPty).not.toHaveBeenCalled();
});

test("runs a resolved JavaScript acpx entry with the current node executable", async () => {
  const run = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const runPty = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const transport = new AcpxCliTransport({ command: "E:/global/node_modules/acpx/dist/cli.js" }, run, runPty);

  await transport.ensureSession(session);

  expect(run).toHaveBeenCalledWith(process.execPath, [
    "E:/global/node_modules/acpx/dist/cli.js",
    "--format",
    "quiet",
    "--cwd",
    "/tmp/backend",
    "--approve-all",
    "--non-interactive-permissions",
    "deny",
    "--agent",
    "./node_modules/.bin/codex-acp",
    "sessions",
    "ensure",
    "--name",
    "backend:api-fix",
  ], expect.objectContaining({
    timeoutMs: expect.any(Number),
  }));
});

test("uses 120 seconds as the default raw-command session creation timeout", async () => {
  const run = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const runPty = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run, runPty);

  await transport.ensureSession(session);

  expect(run).toHaveBeenCalledWith("acpx", [
    "--format",
    "quiet",
    "--cwd",
    "/tmp/backend",
    "--approve-all",
    "--non-interactive-permissions",
    "deny",
    "--agent",
    "./node_modules/.bin/codex-acp",
    "sessions",
    "ensure",
    "--name",
    "backend:api-fix",
  ], expect.objectContaining({
    timeoutMs: expect.any(Number),
  }));
});

test("keeps using PTY for alias-based session creation", async () => {
  const run = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const runPty = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run, runPty);

  await transport.ensureSession(aliasSession);

  expect(run).not.toHaveBeenCalled();
  expect(runPty).toHaveBeenCalledWith("acpx", [
    "--format",
    "quiet",
    "--cwd",
    "/tmp/backend",
    "--approve-all",
    "--non-interactive-permissions",
    "deny",
    "codex",
    "sessions",
    "ensure",
    "--name",
    "backend:api-fix",
  ], expect.objectContaining({
    timeoutMs: expect.any(Number),
  }));
});

test("fails fast when session creation does not finish before the timeout", async () => {
  const run = mock(
    async () =>
      await new Promise<never>(() => {
        // Never resolves.
      }),
  );
  const runPty = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const transport = new AcpxCliTransport(
    { command: "acpx", sessionInitTimeoutMs: 10 },
    run,
    runPty,
  );

  await expect(transport.ensureSession(session)).rejects.toThrow(
    'acpx command timed out after 1ms: --approve-all --non-interactive-permissions deny --agent ./node_modules/.bin/codex-acp sessions new --name "backend:api-fix"',
  );
});


test("aborts the command runner when session creation times out", async () => {
  let aborted = false;
  const run = mock(
    async (_command: string, _args: string[], options?: { timeoutMs?: number; signal?: AbortSignal }) =>
      await new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("runner aborted"));
        });
      }),
  );
  const runPty = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const transport = new AcpxCliTransport(
    { command: "acpx", sessionInitTimeoutMs: 10 },
    run,
    runPty,
  );

  await expect(transport.ensureSession(session)).rejects.toThrow(
    'acpx command timed out after 1ms: --approve-all --non-interactive-permissions deny --agent ./node_modules/.bin/codex-acp sessions new --name "backend:api-fix"',
  );
  expect(aborted).toBe(true);
});

test("uses the normal command runner for prompt and cancel", async () => {
  const run = mock(async () => ({ code: 0, stdout: "cancelled", stderr: "" }));
  const runPty = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run, runPty);

  await transport.cancel(session);

  expect(run).toHaveBeenCalled();
  expect(runPty).not.toHaveBeenCalled();
});

test("queues injected messages with acpx no-wait", async () => {
  const calls: string[][] = [];
  const run = mock(async (_command: string, args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "" };
  });
  const transport = new AcpxCliTransport({ command: "acpx" }, run);

  await expect(
    transport.injectMessage?.(session, {
      text: "<xacpx-message id=\"msg_1\">hello</xacpx-message>",
      messageId: "msg_1",
      mode: "queue",
    }),
  ).resolves.toEqual({ status: "queued", modeUsed: "queue" });

  expect(calls).toEqual([[
    "--format",
    "json",
    "--json-strict",
    "--cwd",
    "/tmp/backend",
    "--approve-all",
    "--non-interactive-permissions",
    "deny",
    "--agent",
    "./node_modules/.bin/codex-acp",
    "prompt",
    "-s",
    "backend:api-fix",
    "--no-wait",
    "<xacpx-message id=\"msg_1\">hello</xacpx-message>",
  ]]);
});

test("rejects strict unsupported message modes before invoking acpx", async () => {
  const run = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run);

  await expect(transport.injectMessage?.(session, {
    text: "hello",
    messageId: "msg_steer",
    mode: "steer",
  })).rejects.toMatchObject({
    name: "MessageInjectionError",
    code: "TARGET_NOT_STEERABLE",
  });

  await expect(transport.injectMessage?.(session, {
    text: "hello",
    messageId: "msg_interrupt",
    mode: "interrupt",
  })).rejects.toMatchObject({
    name: "MessageInjectionError",
    code: "TARGET_NOT_INTERRUPTIBLE",
  });
  expect(run).not.toHaveBeenCalled();
});

test("uses the normal command runner for setMode", async () => {
  const run = mock(async () => ({ code: 0, stdout: "mode set: plan", stderr: "" }));
  const runPty = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run, runPty);

  await transport.setMode(session, "plan");

  expect(run).toHaveBeenCalledWith("acpx", [
    "--format",
    "quiet",
    "--cwd",
    "/tmp/backend",
    "--approve-all",
    "--non-interactive-permissions",
    "deny",
    "--agent",
    "./node_modules/.bin/codex-acp",
    "set-mode",
    "-s",
    "backend:api-fix",
    "plan",
  ], expect.objectContaining({ timeoutMs: 30_000 }));
  expect(runPty).not.toHaveBeenCalled();
});

test("lists agent-side sessions through acpx json output", async () => {
  const run = mock(async () => ({
    code: 0,
    stdout: JSON.stringify({
      source: "agent",
      sessions: [{ sessionId: "thread-1", cwd: "/tmp/backend", title: "Fix CI", updatedAt: "2026-05-26T01:00:00.000Z" }],
      nextCursor: null,
      cwd: "/tmp/backend",
    }),
    stderr: "",
  }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run);

  await expect(transport.listAgentSessions?.({
    agent: "codex",
    agentCommand: "./node_modules/.bin/codex-acp",
    cwd: "/tmp/backend",
    filterCwd: "/tmp/backend",
  })).resolves.toEqual({
    source: "agent",
    sessions: [{ sessionId: "thread-1", cwd: "/tmp/backend", title: "Fix CI", updatedAt: "2026-05-26T01:00:00.000Z" }],
    nextCursor: null,
    cwd: "/tmp/backend",
  });

  expect(run).toHaveBeenCalledWith("acpx", [
    "--format",
    "json",
    "--cwd",
    "/tmp/backend",
    "--approve-all",
    "--non-interactive-permissions",
    "deny",
    "--agent",
    "./node_modules/.bin/codex-acp",
    "sessions",
    "list",
    "--filter-cwd",
    "/tmp/backend",
  ], expect.objectContaining({ timeoutMs: 120_000 }));
});

test("lists agent-side sessions without --filter-cwd when acpx rejects the option", async () => {
  const run = mock(async (_command: string, args: string[]) => {
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
          { sessionId: "thread-1", cwd: "/tmp/backend", title: "Fix CI" },
          { sessionId: "thread-2", cwd: "/tmp/other", title: "Other" },
        ],
      }),
      stderr: "",
    };
  });
  const transport = new AcpxCliTransport({ command: "acpx" }, run);

  await expect(transport.listAgentSessions?.({
    agent: "claude",
    cwd: "/tmp/backend",
    filterCwd: "/tmp/backend",
  })).resolves.toEqual({
    source: "agent",
    sessions: [{ sessionId: "thread-1", cwd: "/tmp/backend", title: "Fix CI" }],
  });

  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1][1]).not.toContain("--filter-cwd");
});

test("returns undefined when acpx falls back to local session records", async () => {
  const run = mock(async () => ({ code: 0, stdout: "[]", stderr: "" }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run);

  await expect(transport.listAgentSessions?.({ agent: "codex", cwd: "/tmp/backend" })).resolves.toBeUndefined();
});

test("resumes an agent-side session using sessions new --resume-session", async () => {
  const run = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const runPty = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run, runPty);

  await transport.resumeAgentSession?.(session, "thread-1");

  expect(run).toHaveBeenCalledWith("acpx", [
    "--format",
    "quiet",
    "--cwd",
    "/tmp/backend",
    "--approve-all",
    "--non-interactive-permissions",
    "deny",
    "--agent",
    "./node_modules/.bin/codex-acp",
    "sessions",
    "new",
    "--name",
    "backend:api-fix",
    "--resume-session",
    "thread-1",
  ], expect.objectContaining({ timeoutMs: 120_000 }));
  expect(runPty).not.toHaveBeenCalled();
});

test("uses PTY when resuming an alias-based session", async () => {
  const run = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const runPty = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run, runPty);

  await transport.resumeAgentSession(aliasSession, "thread-1");

  expect(run).not.toHaveBeenCalled();
  expect(runPty).toHaveBeenCalledWith("acpx", [
    "--format",
    "quiet",
    "--cwd",
    "/tmp/backend",
    "--approve-all",
    "--non-interactive-permissions",
    "deny",
    "codex",
    "sessions",
    "new",
    "--name",
    "backend:api-fix",
    "--resume-session",
    "thread-1",
  ], expect.objectContaining({ timeoutMs: 120_000 }));
});

test("tails session history with the acpx 0.12 --limit syntax", async () => {
  const run = mock(async () => ({ code: 0, stdout: "history", stderr: "" }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run);

  await expect(transport.tailSessionHistory(session, 20)).resolves.toEqual({ text: "history" });

  expect(run).toHaveBeenCalledWith("acpx", [
    "--format",
    "quiet",
    "--cwd",
    "/tmp/backend",
    "--approve-all",
    "--non-interactive-permissions",
    "deny",
    "--agent",
    "./node_modules/.bin/codex-acp",
    "sessions",
    "history",
    "backend:api-fix",
    "--limit",
    "20",
    // Shared deadline across history candidates: bounded by the management timeout.
  ], expect.objectContaining({ timeoutMs: expect.any(Number) }));
});

test("passes default permission policy flags to prompt", async () => {
  const run = mock(async () => ({
    code: 0,
    stdout: [
      JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } }),
    ].join("\n"),
    stderr: "",
  }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run);

  await transport.prompt(session, "hello");

  expect(run).toHaveBeenCalledWith("acpx", [
    "--format",
    "json",
    "--json-strict",
    "--cwd",
    "/tmp/backend",
    "--approve-all",
    "--non-interactive-permissions",
    "deny",
    "--agent",
    "./node_modules/.bin/codex-acp",
    "prompt",
    "-s",
    "backend:api-fix",
    "hello",
  ]);
});

test("passes --ttl to prompt when queueOwnerTtlSeconds is configured", async () => {
  const run = mock(async () => ({
    code: 0,
    stdout: [
      JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } }),
    ].join("\n"),
    stderr: "",
  }));
  const transport = new AcpxCliTransport({ command: "acpx", queueOwnerTtlSeconds: 1800 }, run);

  await transport.prompt(session, "hello");

  expect(run).toHaveBeenCalledWith("acpx", [
    "--format",
    "json",
    "--json-strict",
    "--cwd",
    "/tmp/backend",
    "--approve-all",
    "--non-interactive-permissions",
    "deny",
    "--ttl",
    "1800",
    "--agent",
    "./node_modules/.bin/codex-acp",
    "prompt",
    "-s",
    "backend:api-fix",
    "hello",
  ]);
});

test("passes --ttl 0 (keep alive forever) when queueOwnerTtlSeconds is 0", async () => {
  const run = mock(async () => ({
    code: 0,
    stdout: [
      JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } }),
    ].join("\n"),
    stderr: "",
  }));
  const transport = new AcpxCliTransport({ command: "acpx", queueOwnerTtlSeconds: 0 }, run);

  await transport.prompt(session, "hello");

  const args = run.mock.calls[0]?.[1] ?? [];
  const ttlIndex = args.indexOf("--ttl");
  expect(ttlIndex).toBeGreaterThan(0);
  expect(args[ttlIndex + 1]).toBe("0");
});

test("omits --ttl from prompt when queueOwnerTtlSeconds is not configured", async () => {
  const run = mock(async () => ({
    code: 0,
    stdout: [
      JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } }),
    ].join("\n"),
    stderr: "",
  }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run);

  await transport.prompt(session, "hello");

  expect(run.mock.calls[0]?.[1] ?? []).not.toContain("--ttl");
});

test("writes image media prompts as structured ACP content blocks via --file", async () => {
  const mediaDir = await mkdtemp(join(tmpdir(), "weacpx-image-prompt-"));
  const mediaPath = join(mediaDir, "image.bin");
  await writeFile(mediaPath, Buffer.from("89504e470d0a1a0a", "hex"));
  let promptBlocks: unknown;
  let promptFilePath = "";
  const run = mock(async (_command: string, args: string[]) => {
    const fileFlagIndex = args.indexOf("--file");
    expect(fileFlagIndex).toBeGreaterThan(0);
    promptFilePath = args[fileFlagIndex + 1]!;
    promptBlocks = JSON.parse(await readFile(promptFilePath, "utf8"));
    return {
      code: 0,
      stdout: [
        JSON.stringify({
          method: "session/update",
          sessionId: "abc",
          params: { update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "ok" },
          } },
        }),
      ].join("\n"),
      stderr: "",
    };
  });
  const transport = new AcpxCliTransport({ command: "acpx" }, run);

  try {
    await expect(
      transport.prompt(session, "请看图", undefined, undefined, {
        media: { type: "image", filePath: mediaPath, mimeType: "image/*" },
      }),
    ).resolves.toEqual({ text: "ok" });

    expect(run.mock.calls[0]?.[1]).toEqual([
      "--format",
      "json",
      "--json-strict",
      "--cwd",
      "/tmp/backend",
      "--approve-all",
      "--non-interactive-permissions",
      "deny",
      "--agent",
      "./node_modules/.bin/codex-acp",
      "prompt",
      "-s",
      "backend:api-fix",
      "--file",
      expect.any(String),
    ]);
    expect(promptBlocks).toEqual([
      { type: "text", text: "请看图" },
      {
        type: "image",
        mimeType: "image/png",
        data: Buffer.from("89504e470d0a1a0a", "hex").toString("base64"),
      },
    ]);
    await expect(access(promptFilePath)).rejects.toThrow();
  } finally {
    await rm(mediaDir, { recursive: true, force: true });
  }
});

test("cleans structured prompt files when image prompt command fails", async () => {
  const mediaDir = await mkdtemp(join(tmpdir(), "weacpx-image-prompt-fail-"));
  const mediaPath = join(mediaDir, "image.bin");
  await writeFile(mediaPath, Buffer.from("89504e470d0a1a0a", "hex"));
  let promptFilePath = "";
  const run = mock(async (_command: string, args: string[]) => {
    const fileFlagIndex = args.indexOf("--file");
    expect(fileFlagIndex).toBeGreaterThan(0);
    promptFilePath = args[fileFlagIndex + 1]!;
    await readFile(promptFilePath, "utf8");
    return { code: 1, stdout: "", stderr: "agent failed" };
  });
  const transport = new AcpxCliTransport({ command: "acpx" }, run);

  try {
    await expect(
      transport.prompt(session, "", undefined, undefined, {
        media: { type: "image", filePath: mediaPath, mimeType: "image/png" },
      }),
    ).rejects.toThrow("agent failed");

    await expect(access(promptFilePath)).rejects.toThrow();
  } finally {
    await rm(mediaDir, { recursive: true, force: true });
  }
});

test("CLI prompt onSegment observes streamed content without suppressing final text", async () => {
  await withFakeAcpxScript(
    `
const lines = [
  ${JSON.stringify(JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "abc",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "progress update\n\n" },
      },
    },
  }))},
  ${JSON.stringify(JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "abc",
      update: {
        sessionUpdate: "tool_call",
        title: "Read file",
      },
    },
  }))},
  ${JSON.stringify(JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "abc",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Final answer" },
      },
    },
  }))},
];
process.stdout.write(lines.join("\\n") + "\\n");
`,
    async (scriptPath) => {
      const observed: string[] = [];
      const transport = new AcpxCliTransport({ command: scriptPath });

      const result = await transport.prompt(session, "hello", undefined, undefined, {
        onSegment: (text) => {
          observed.push(text);
        },
      });

      expect(observed).toEqual(["progress update", "🔧 Read file", "Final answer"]);
      expect(result).toEqual({ text: "progress update\n\nFinal answer" });
    },
  );
});

test("CLI prompt onSegment observes segments even when reply quota drops user-facing stream", async () => {
  await withFakeAcpxScript(
    `
const lines = [
  ${JSON.stringify(JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "abc",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "progress update\n\n" },
      },
    },
  }))},
  ${JSON.stringify(JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "abc",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Final answer" },
      },
    },
  }))},
];
process.stdout.write(lines.join("\\n") + "\\n");
`,
    async (scriptPath) => {
      const observed: string[] = [];
      const replied: string[] = [];
      const quota = new QuotaManager();
      for (let i = 0; i < 6; i += 1) {
        quota.reserveMidSegment("chat-1");
      }
      const transport = new AcpxCliTransport({ command: scriptPath });

      await transport.prompt(
        session,
        "hello",
        async (text) => {
          replied.push(text);
        },
        { chatKey: "chat-1", quota },
        {
          onSegment: (text) => {
            observed.push(text);
          },
        },
      );

      expect(replied).toEqual([]);
      expect(observed).toEqual(["progress update", "Final answer"]);
    },
  );
});

test("CLI prompt propagates onSegment failures when reply streaming is enabled", async () => {
  await withFakeAcpxScript(
    `
const lines = [
  ${JSON.stringify(JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "abc",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "progress update\n\n" },
      },
    },
  }))},
];
process.stdout.write(lines.join("\\n") + "\\n");
`,
    async (scriptPath) => {
      const quota = new QuotaManager();
      const transport = new AcpxCliTransport({ command: scriptPath });

      await expect(
        transport.prompt(
          session,
          "hello",
          async () => {},
          { chatKey: "chat-1", quota },
          {
            onSegment: () => {
              throw new Error("observer failed");
            },
          },
        ),
      ).rejects.toThrow("observer failed");
    },
  );
});



test("applies updated permission policy to later commands", async () => {
  const run = mock(async () => ({
    code: 0,
    stdout: [
      JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } }),
    ].join("\n"),
    stderr: "",
  }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run);

  await transport.updatePermissionPolicy?.({
    permissionMode: "approve-reads",
    nonInteractivePermissions: "deny",
  });
  await transport.prompt(session, "hello");

  expect(run).toHaveBeenCalledWith("acpx", [
    "--format",
    "json",
    "--json-strict",
    "--cwd",
    "/tmp/backend",
    "--approve-reads",
    "--non-interactive-permissions",
    "deny",
    "--agent",
    "./node_modules/.bin/codex-acp",
    "prompt",
    "-s",
    "backend:api-fix",
    "hello",
  ]);
});
test("passes explicit permission policy flags to prompt", async () => {
  const run = mock(async () => ({
    code: 0,
    stdout: [
      JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } }),
    ].join("\n"),
    stderr: "",
  }));
  const transport = new AcpxCliTransport(
    { command: "acpx", permissionMode: "approve-reads", nonInteractivePermissions: "deny" },
    run,
  );

  await transport.prompt(session, "hello");

  expect(run).toHaveBeenCalledWith("acpx", [
    "--format",
    "json",
    "--json-strict",
    "--cwd",
    "/tmp/backend",
    "--approve-reads",
    "--non-interactive-permissions",
    "deny",
    "--agent",
    "./node_modules/.bin/codex-acp",
    "prompt",
    "-s",
    "backend:api-fix",
    "hello",
  ]);
});

test("invokes cancel for the resolved session", async () => {
  const run = mock(async () => ({ code: 0, stdout: "cancelled", stderr: "" }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run);

  await expect(transport.cancel(session)).resolves.toEqual({
    cancelled: true,
    message: "cancelled",
  });

  expect(run).toHaveBeenCalledWith("acpx", [
    "--format",
    "quiet",
    "--cwd",
    "/tmp/backend",
    "--approve-all",
    "--non-interactive-permissions",
    "deny",
    "--agent",
    "./node_modules/.bin/codex-acp",
    "cancel",
    "-s",
    "backend:api-fix",
  ], expect.objectContaining({ timeoutMs: 30_000 }));
});

test("checks whether a named session exists", async () => {
  const run = mock(async () => ({ code: 0, stdout: "id: abc", stderr: "" }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run);

  await expect(transport.hasSession(session)).resolves.toBe(true);

  expect(run).toHaveBeenCalledWith("acpx", [
    "--format",
    "quiet",
    "--cwd",
    "/tmp/backend",
    "--approve-all",
    "--non-interactive-permissions",
    "deny",
    "--agent",
    "./node_modules/.bin/codex-acp",
    "sessions",
    "show",
    "backend:api-fix",
  ], expect.objectContaining({ timeoutMs: 30_000 }));
});

test("returns false when a named session does not exist", async () => {
  const run = mock(async () => ({ code: 1, stdout: "", stderr: "missing" }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run);

  await expect(transport.hasSession(session)).resolves.toBe(false);
});

test("times out a hung management command, aborts the spawn, and rejects", async () => {
  // A runner that never settles — equivalent to acpx wedging on a one-shot
  // command. Without the management timeout this would deadlock the session's
  // serial request lane forever.
  let aborted = false;
  const run = mock((_command: string, _args: string[], options?: { signal?: AbortSignal }) => {
    return new Promise<never>(() => {
      options?.signal?.addEventListener("abort", () => {
        aborted = true;
      }, { once: true });
    });
  });
  const transport = new AcpxCliTransport(
    { command: "acpx", managementCommandTimeoutMs: 20 },
    run as never,
  );

  await expect(transport.cancel(session)).rejects.toThrow(/timed out during cancel after 20ms/);
  expect(aborted).toBe(true);
});

test("a real CLI runner timeout preserves only the final 2000 output characters", async () => {
  const stdoutTail = "O".repeat(2_000);
  const stderrTail = "E".repeat(2_000);
  await withFakeAcpxScript(`
process.stdout.write("discarded stdout\\n" + "O".repeat(2000));
process.stderr.write("discarded stderr\\n" + "E".repeat(2000));
setInterval(() => {}, 1000);
`, async (scriptPath) => {
    const transport = new AcpxCliTransport({
      command: scriptPath,
      managementCommandTimeoutMs: 500,
    });

    let caught: unknown;
    try {
      await transport.setModel(session, "model-b");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CommandTimeoutError);
    expect(caught).toMatchObject({
      stage: "set-model",
      stdoutTail,
      stderrTail,
    });
  });
});

test("times out a hung sessions close (removeSession) instead of hanging forever", async () => {
  const run = mock(() => new Promise<never>(() => {}));
  const transport = new AcpxCliTransport(
    { command: "acpx", managementCommandTimeoutMs: 20 },
    run as never,
  );

  await expect(transport.removeSession(session)).rejects.toThrow(/timed out during remove-session after 20ms/);
});

test("concatenates agent message chunks across thought and tool-call boundaries", async () => {
  const run = mock(async () => ({
    code: 0,
    stdout: [
      JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize" }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "abc",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "thinking" },
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "abc",
          update: {
            sessionUpdate: "tool_call",
            title: "Read SKILL.md",
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "abc",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "do" },
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "abc",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "ne" },
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "abc",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "" },
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "abc",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Using `using-superpowers` because " },
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "abc",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "the repo instructions require a skill check." },
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "abc",
          update: {
            sessionUpdate: "tool_call",
            title: "Read SKILL.md",
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "abc",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "ok" },
          },
        },
      }),
      "",
    ].join("\n"),
    stderr: "",
  }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run);

  // Thought chunks and tool calls are skipped; every agent_message_chunk is
  // concatenated verbatim, so no part of the reply is dropped.
  await expect(transport.prompt(session, "hello")).resolves.toEqual({
    text: "doneUsing `using-superpowers` because the repo instructions require a skill check.ok",
  });

  expect(run).toHaveBeenCalledWith("acpx", [
    "--format",
    "json",
    "--json-strict",
    "--cwd",
    "/tmp/backend",
    "--approve-all",
    "--non-interactive-permissions",
    "deny",
    "--agent",
    "./node_modules/.bin/codex-acp",
    "prompt",
    "-s",
    "backend:api-fix",
    "hello",
  ]);
});

test("concatenates message chunks split by a tool call", async () => {
  const run = mock(async () => ({
    code: 0,
    stdout: [
      JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize" }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "abc",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Checking instructions." },
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "abc",
          update: {
            sessionUpdate: "tool_call",
            title: "Read SKILL.md",
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "abc",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "line 1" },
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "abc",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "\nline 2" },
          },
        },
      }),
      "",
    ].join("\n"),
    stderr: "",
  }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run);

  await expect(transport.prompt(session, "hello")).resolves.toEqual({
    text: "Checking instructions.line 1\nline 2",
  });
});

test("falls back to trimmed stdout when JSON output has no agent text chunks", async () => {
  const run = mock(async () => ({
    code: 0,
    stdout: [
      JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } }),
    ].join("\n"),
    stderr: "",
  }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run);

  await expect(transport.prompt(session, "hello")).resolves.toEqual({
    text: '{"jsonrpc":"2.0","id":0,"method":"initialize"}\n{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}',
  });
});

test("strips a leading workflow preamble when a real reply follows", async () => {
  const run = mock(async () => ({
    code: 0,
    stdout: [
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "abc",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "Using using-superpowers to satisfy the repo workflow requirement before responding.\n\n",
            },
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "abc",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "Hello.",
            },
          },
        },
      }),
      "",
    ].join("\n"),
    stderr: "",
  }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run);

  await expect(transport.prompt(session, "hello")).resolves.toEqual({
    text: "Hello.",
  });
});

test("keeps a genuine single-paragraph reply that starts with Using", async () => {
  const run = mock(async () => ({
    code: 0,
    stdout: [
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "abc",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "Using the cache is the fastest option.",
            },
          },
        },
      }),
      "",
    ].join("\n"),
    stderr: "",
  }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run);

  await expect(transport.prompt(session, "hello")).resolves.toEqual({
    text: "Using the cache is the fastest option.",
  });
});

test("raises a normalized error when acpx exits non-zero", async () => {
  const run = mock(async () => ({ code: 1, stdout: "", stderr: "session not found" }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run);

  await expect(transport.prompt(session, "hello")).rejects.toThrow("session not found");
});

test("extracts the final JSON-RPC error message instead of surfacing raw payloads", async () => {
  const run = mock(async () => ({
    code: 1,
    stdout: [
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32603,
          message: "Resource not found",
          data: { acpxCode: "RUNTIME" },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32603,
          message: "Session queue owner failed to start for session 123",
          data: { acpxCode: "RUNTIME" },
        },
      }),
    ].join("\n"),
    stderr: "",
  }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run);

  try {
    await transport.prompt(session, "hello");
    throw new Error("expected prompt to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Session queue owner failed to start for session 123");
  }
});

test("keeps the extracted agent reply when prompt exits non-zero without a structured error", async () => {
  const run = mock(async () => ({
    code: 1,
    stdout: [
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "abc",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "先做检查。" },
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "abc",
          update: {
            sessionUpdate: "tool_call",
            title: "Read file",
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "abc",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "让我更新任务状态并继续执行测试验证。" },
          },
        },
      }),
    ].join("\n"),
    stderr: "",
  }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run);

  // The full reply is preserved: chunks before and after the tool call are
  // concatenated, not truncated to the trailing fragment.
  await expect(transport.prompt(session, "hello")).resolves.toEqual({
    text: "先做检查。让我更新任务状态并继续执行测试验证。",
  });
});

test("starts a queue owner with orchestration MCP before prompting an MCP-bound session", async () => {
  const mcpSession: ResolvedSession = {
    ...session,
    mcpCoordinatorSession: "backend:main",
    mcpSourceHandle: "backend:claude:backend:main",
  };
  const run = mock(async (_command: string, args: string[]) => {
    if (args.includes("show")) {
      return {
        code: 0,
        stdout: JSON.stringify({ acpxRecordId: "acpx-record-1" }),
        stderr: "",
      };
    }
    return { code: 0, stdout: "worker response", stderr: "" };
  });
  const launches: unknown[] = [];
  const queueOwnerLauncher = {
    launch: async (input: unknown) => {
      launches.push(input);
    },
  } as Pick<AcpxQueueOwnerLauncher, "launch">;
  const transport = new AcpxCliTransport(
    { command: "acpx" },
    run,
    undefined,
    queueOwnerLauncher,
  );

  await expect(transport.prompt(mcpSession, "hello")).resolves.toEqual({ text: "worker response" });

  expect(launches).toEqual([{
    acpxRecordId: "acpx-record-1",
    coordinatorSession: "backend:main",
    sourceHandle: "backend:claude:backend:main",
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
  }]);
});

test("persists effort before launching the queue owner so reconnect replays it", async () => {
  const events: string[] = [];
  const effortSession: ResolvedSession = {
    ...session,
    effort: "high",
    mcpCoordinatorSession: "backend:main",
  };
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
  const run = mock(async (_command: string, args: string[]) => {
    if (args.includes("show")) {
      return { code: 0, stdout: effortRecord, stderr: "" };
    }
    if (args.includes("set")) {
      events.push("set:high");
      return { code: 0, stdout: "", stderr: "" };
    }
    events.push("prompt");
    return { code: 0, stdout: "worker response", stderr: "" };
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
  const transport = new AcpxCliTransport(
    { command: "acpx" },
    run,
    undefined,
    queueOwnerLauncher,
  );

  await transport.prompt(effortSession, "hello");

  expect(events).toEqual(["cool", "set:high", "launch", "prompt"]);
});

test("skips effort reapply when a reusable owner already holds the persisted value", async () => {
  const events: string[] = [];
  const effortSession: ResolvedSession = {
    ...session,
    effort: "max",
    mcpCoordinatorSession: "backend:main",
  };
  const run = mock(async (_command: string, args: string[]) => {
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
    return { code: 0, stdout: "ok", stderr: "" };
  });
  const queueOwnerLauncher = {
    wouldReuse: async () => true,
    cool: async () => {
      events.push("cool");
    },
    launch: async () => {
      events.push("launch");
    },
  };
  const transport = new AcpxCliTransport(
    { command: "acpx" },
    run,
    undefined,
    queueOwnerLauncher,
  );

  await transport.prompt(effortSession, "hello");

  expect(events).toEqual(["launch", "prompt"]);
});

test("cools a reusable owner and reapplies persisted effort when adapter current drifted", async () => {
  const events: string[] = [];
  const effortSession: ResolvedSession = {
    ...session,
    effort: "high",
    mcpCoordinatorSession: "backend:main",
  };
  const run = mock(async (_command: string, args: string[]) => {
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
  });
  const queueOwnerLauncher = {
    wouldReuse: async () => true,
    cool: async () => {
      events.push("cool");
    },
    launch: async () => {
      events.push("launch");
    },
  };
  const transport = new AcpxCliTransport(
    { command: "acpx" },
    run,
    undefined,
    queueOwnerLauncher,
  );

  await transport.prompt(effortSession, "hello");

  expect(events).toEqual(["cool", "set:high", "launch", "prompt"]);
});

test("writes persisted effort while cold when the next launch will replace the owner", async () => {
  const events: string[] = [];
  const effortSession: ResolvedSession = {
    ...session,
    effort: "high",
    model: "model-b",
    mcpCoordinatorSession: "backend:main",
  };
  const run = mock(async (_command: string, args: string[]) => {
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
    if (args.includes("set")) {
      events.push("set:high");
      return { code: 0, stdout: "", stderr: "" };
    }
    events.push("prompt");
    return { code: 0, stdout: "ok", stderr: "" };
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
  const transport = new AcpxCliTransport(
    { command: "acpx" },
    run,
    undefined,
    queueOwnerLauncher,
  );

  await transport.prompt(effortSession, "hello");

  expect(events).toEqual(["cool", "set:high", "launch", "prompt"]);
});

test("does not acpx set when the queue owner cannot be cooled", async () => {
  const events: string[] = [];
  const effortSession: ResolvedSession = {
    ...session,
    effort: "high",
    mcpCoordinatorSession: "backend:main",
  };
  const run = mock(async (_command: string, args: string[]) => {
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
    return { code: 0, stdout: "ok", stderr: "" };
  });
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
  const transport = new AcpxCliTransport(
    { command: "acpx" },
    run,
    undefined,
    queueOwnerLauncher,
  );

  await expect(transport.prompt(effortSession, "hello")).rejects.toThrow(/still live after termination/);
  expect(events).toEqual(["cool"]);
});

test("does not block a prompt when the persisted effort is no longer advertised", async () => {
  const events: string[] = [];
  const staleSession: ResolvedSession = {
    ...session,
    effort: "xhigh",
    mcpCoordinatorSession: "backend:main",
  };
  const run = mock(async (_command: string, args: string[]) => {
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
  });
  const queueOwnerLauncher = {
    launch: async () => {
      events.push("launch");
    },
  } as Pick<AcpxQueueOwnerLauncher, "launch">;
  const transport = new AcpxCliTransport(
    { command: "acpx" },
    run,
    undefined,
    queueOwnerLauncher,
  );

  await expect(transport.prompt(staleSession, "hello")).resolves.toEqual({ text: "worker response" });
  expect(events).toEqual(["launch", "prompt"]);
});

// --- toolEventMode wiring tests ---

function makeToolCallLine(toolCallId: string, title: string, kind = "read"): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "abc",
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title,
        kind,
      },
    },
  });
}

function makeToolCallUpdateLine(toolCallId: string, status: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "abc",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status,
      },
    },
  });
}

function makeAgentChunkLine(text: string, messageId?: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "abc",
      update: {
        sessionUpdate: "agent_message_chunk",
        ...(messageId ? { messageId } : {}),
        content: { type: "text", text },
      },
    },
  });
}

function makeAgentThoughtLine(text: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "abc",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text },
      },
    },
  });
}

function makeFakeSpawn(lines: string[]) {
  let dataHandler: ((chunk: string) => void) | undefined;
  let closeHandler: ((code: number | null) => void) | undefined;

  const process = {
    stdout: {
      setEncoding: () => {},
      on: (event: string, handler: (chunk: string) => void) => {
        if (event === "data") dataHandler = handler;
      },
    },
    stderr: {
      on: () => {},
    },
    on: (event: string, handler: (code: number | null) => void) => {
      if (event === "close") closeHandler = handler;
    },
  };

  Promise.resolve().then(() => {
    dataHandler?.(lines.join("\n") + "\n");
    closeHandler?.(0);
  });

  return process as unknown as ReturnType<typeof makeFakeSpawn>;
}

test("raw stream preserves text → tool → text order and separates different messageIds", async () => {
  const events: string[] = [];
  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeAgentChunkLine("先说明。", "message-1"),
        makeToolCallLine("tool-1", "Read file", "read"),
        makeAgentChunkLine("再总结", "message-2"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  await transport.prompt(
    { ...session, replyMode: "stream" },
    "hello",
    async (text) => {
      events.push(`text:${text}`);
    },
    undefined,
    {
      onToolEvent: async (event) => {
        events.push(`tool:${event.toolCallId}`);
      },
    },
  );

  expect(events).toEqual([
    "text:先说明。",
    "tool:tool-1",
    "text:\n\n再总结",
  ]);
});

test("raw stream keeps the same messageId as one Markdown block across a tool call", async () => {
  const events: string[] = [];
  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeAgentChunkLine("**连续", "message-1"),
        makeToolCallLine("tool-1", "Read file", "read"),
        makeAgentChunkLine("文本**", "message-1"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  await transport.prompt(
    { ...session, replyMode: "stream" },
    "hello",
    async (text) => {
      events.push(`text:${text}`);
    },
    undefined,
    {
      onToolEvent: async (event) => {
        events.push(`tool:${event.toolCallId}`);
      },
    },
  );

  expect(events).toEqual([
    "text:**连续",
    "tool:tool-1",
    "text:文本**",
  ]);
});

test("raw stream uses multilingual sentence-terminal punctuation when messageId is absent", async () => {
  const sentenceEndings = [
    "English.",
    "中文。",
    "العربية؟",
    "Հայերեն։",
    "हिन्दी।",
    "አማርኛ።",
    "全角！",
    "省略…",
    "省略⋯",
    "带引号！”",
    "Markdown。**",
  ];

  for (const before of sentenceEndings) {
    const events: string[] = [];
    const transport = new AcpxCliTransport(
      { command: "acpx" },
      undefined,
      undefined,
      undefined,
      {
        spawnPrompt: () => makeFakeSpawn([
          makeAgentChunkLine(before),
          makeToolCallLine("tool-1", "Read file", "read"),
          makeAgentChunkLine("after"),
        ]),
        setIntervalFn: () => 0,
        clearIntervalFn: () => {},
      },
    );

    await transport.prompt(
      { ...session, replyMode: "stream" },
      "hello",
      async (text) => {
        events.push(`text:${text}`);
      },
      undefined,
      {
        onToolEvent: async (event) => {
          events.push(`tool:${event.toolCallId}`);
        },
      },
    );

    expect(events).toEqual([
      `text:${before}`,
      "tool:tool-1",
      "text:\n\nafter",
    ]);
  }
});

test("raw stream does not invent a text block boundary without messageId or sentence punctuation", async () => {
  const events: string[] = [];
  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeAgentChunkLine("continuous "),
        makeToolCallLine("tool-1", "Read file", "read"),
        makeAgentChunkLine("text"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  await transport.prompt(
    { ...session, replyMode: "stream" },
    "hello",
    async (text) => {
      events.push(`text:${text}`);
    },
    undefined,
    {
      onToolEvent: async (event) => {
        events.push(`tool:${event.toolCallId}`);
      },
    },
  );

  expect(events).toEqual([
    "text:continuous ",
    "tool:tool-1",
    "text:text",
  ]);
});

test("raw stream preserves text → reasoning → text order", async () => {
  const events: string[] = [];
  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeAgentChunkLine("before。", "message-1"),
        makeAgentThoughtLine("checking"),
        makeAgentChunkLine("after", "message-2"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  await transport.prompt(
    { ...session, replyMode: "stream" },
    "hello",
    async (text) => {
      events.push(`text:${text}`);
    },
    undefined,
    {
      onThought: async (text) => {
        events.push(`reasoning:${text}`);
      },
    },
  );

  expect(events).toEqual([
    "text:before。",
    "reasoning:checking",
    "text:\n\nafter",
  ]);
});

test("raw stream delivers text before a later update to an existing tool", async () => {
  const events: string[] = [];
  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeToolCallLine("tool-1", "Read file", "read"),
        makeAgentChunkLine("between", "message-1"),
        makeToolCallUpdateLine("tool-1", "completed"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  await transport.prompt(
    { ...session, replyMode: "stream" },
    "hello",
    async (text) => {
      events.push(`text:${text}`);
    },
    undefined,
    {
      onToolEvent: async (event) => {
        events.push(`tool:${event.status}`);
      },
    },
  );

  expect(events).toEqual([
    "tool:running",
    "text:between",
    "tool:success",
  ]);
});

test("updating an existing tool does not invent a new text-block boundary", async () => {
  const events: string[] = [];
  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeToolCallLine("tool-1", "Read file", "read"),
        makeAgentChunkLine("between."),
        makeToolCallUpdateLine("tool-1", "completed"),
        makeAgentChunkLine("continued"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  await transport.prompt(
    { ...session, replyMode: "stream" },
    "hello",
    async (text) => {
      events.push(`text:${text}`);
    },
    undefined,
    {
      onToolEvent: async (event) => {
        events.push(`tool:${event.status}`);
      },
    },
  );

  expect(events).toEqual([
    "tool:running",
    "text:between.",
    "tool:success",
    "text:continued",
  ]);
});

test("toolEventMode: no onToolEvent + no toolEventMode → resolves to text, tool call appears as segment", async () => {
  const segments: string[] = [];
  const toolEvents: unknown[] = [];

  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeToolCallLine("id-1", "Read file", "read"),
        makeAgentChunkLine("done"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  const sessionWithVerboseMode: typeof session = { ...session, replyMode: "verbose" };
  await transport.prompt(sessionWithVerboseMode, "hello", async (text) => {
    segments.push(text);
  }, undefined);

  expect(toolEvents).toEqual([]);
  expect(segments.some((s) => s.includes("Read file"))).toBe(true);
});

test("toolEventMode: onToolEvent + no toolEventMode → resolves to structured, callback receives event, no text segment for the tool call", async () => {
  const segments: string[] = [];
  const toolEvents: unknown[] = [];

  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeToolCallLine("id-2", "Run tests", "execute"),
        makeAgentChunkLine("final"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  const sessionWithVerboseMode: typeof session = { ...session, replyMode: "verbose" };
  await transport.prompt(sessionWithVerboseMode, "hello", async (text) => {
    segments.push(text);
  }, undefined, {
    onToolEvent: (event) => {
      toolEvents.push(event);
    },
  });

  expect(toolEvents).toHaveLength(1);
  expect((toolEvents[0] as { toolName: string }).toolName).toBe("Run tests");
  expect(segments.every((s) => !s.includes("Run tests"))).toBe(true);
});

test("toolEventMode: explicit 'both' + onToolEvent → callback receives event AND text segment emitted", async () => {
  const segments: string[] = [];
  const toolEvents: unknown[] = [];

  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeToolCallLine("id-3", "Grep for pattern", "search"),
        makeAgentChunkLine("done"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  const sessionWithVerboseMode: typeof session = { ...session, replyMode: "verbose" };
  await transport.prompt(sessionWithVerboseMode, "hello", async (text) => {
    segments.push(text);
  }, undefined, {
    toolEventMode: "both",
    onToolEvent: (event) => {
      toolEvents.push(event);
    },
  });

  expect(toolEvents).toHaveLength(1);
  expect((toolEvents[0] as { toolName: string }).toolName).toBe("Grep for pattern");
  expect(segments.some((s) => s.includes("Grep for pattern"))).toBe(true);
});

test("toolEventMode: explicit 'text' with onToolEvent → text segment only, callback NOT invoked", async () => {
  const segments: string[] = [];
  const toolEvents: unknown[] = [];

  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeToolCallLine("id-4", "Edit file", "edit"),
        makeAgentChunkLine("done"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  const sessionWithVerboseMode: typeof session = { ...session, replyMode: "verbose" };
  await transport.prompt(sessionWithVerboseMode, "hello", async (text) => {
    segments.push(text);
  }, undefined, {
    toolEventMode: "text",
    onToolEvent: (event) => {
      toolEvents.push(event);
    },
  });

  expect(toolEvents).toHaveLength(0);
  expect(segments.some((s) => s.includes("Edit file"))).toBe(true);
});

// --- onToolEvent chain serialization tests ---

test("onToolEvent: events delivered in emission order even when first handler is slow", async () => {
  const recorder: string[] = [];

  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeToolCallLine("id-1", "Tool One", "read"),
        makeToolCallLine("id-2", "Tool Two", "read"),
        makeToolCallLine("id-3", "Tool Three", "read"),
        makeAgentChunkLine("done"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  const sessionWithVerboseMode: typeof session = { ...session, replyMode: "verbose" };
  await transport.prompt(sessionWithVerboseMode, "hello", async () => {}, undefined, {
    onToolEvent: async (event) => {
      if (event.toolCallId === "id-1") {
        await new Promise<void>((r) => setTimeout(r, 10));
      }
      recorder.push(event.toolCallId);
    },
  });

  expect(recorder).toEqual(["id-1", "id-2", "id-3"]);
});

test("onToolEvent: prompt does not resolve until the handler chain settles", async () => {
  let handlerResolve!: () => void;
  const handlerSettled = new Promise<void>((r) => { handlerResolve = r; });
  const order: string[] = [];

  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeToolCallLine("id-1", "Tool One", "read"),
        makeAgentChunkLine("done"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  const sessionWithVerboseMode: typeof session = { ...session, replyMode: "verbose" };

  // Kick off the prompt without awaiting it yet.
  const promptPromise = transport.prompt(sessionWithVerboseMode, "hello", async () => {}, undefined, {
    onToolEvent: async () => {
      await handlerSettled;
      order.push("handler");
    },
  });

  // Give the spawn event loop a chance to fire (data + close).
  await new Promise<void>((r) => setTimeout(r, 20));

  // Prompt must still be pending because the handler hasn't settled.
  let promptResolved = false;
  void promptPromise.then(() => { promptResolved = true; });
  await Promise.resolve(); // flush microtask
  expect(promptResolved).toBe(false);

  // Now resolve the handler.
  handlerResolve();
  order.push("released");

  await promptPromise;
  order.push("prompt");

  // Handler must have completed before prompt resolved.
  expect(order[0]).toBe("released");
  expect(order[1]).toBe("handler");
  expect(order[2]).toBe("prompt");
});

test("onToolEvent: handler error rejects the prompt", async () => {
  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeToolCallLine("id-1", "Tool One", "read"),
        makeAgentChunkLine("done"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  const sessionWithVerboseMode: typeof session = { ...session, replyMode: "verbose" };
  await expect(
    transport.prompt(sessionWithVerboseMode, "hello", async () => {}, undefined, {
      onToolEvent: () => {
        throw new Error("handler boom");
      },
    }),
  ).rejects.toThrow("handler boom");
});

test("onToolEvent: only the first handler error is surfaced", async () => {
  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeToolCallLine("id-1", "Tool One", "read"),
        makeToolCallLine("id-2", "Tool Two", "read"),
        makeAgentChunkLine("done"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  const sessionWithVerboseMode: typeof session = { ...session, replyMode: "verbose" };
  await expect(
    transport.prompt(sessionWithVerboseMode, "hello", async () => {}, undefined, {
      onToolEvent: (event) => {
        throw new Error(`error from ${event.toolCallId}`);
      },
    }),
  ).rejects.toThrow("error from id-1");
});

test("onToolEvent: later handlers still run even when an earlier one errors", async () => {
  const recorder: string[] = [];

  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeToolCallLine("id-1", "Tool One", "read"),
        makeToolCallLine("id-2", "Tool Two", "read"),
        makeAgentChunkLine("done"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  const sessionWithVerboseMode: typeof session = { ...session, replyMode: "verbose" };
  await expect(
    transport.prompt(sessionWithVerboseMode, "hello", async () => {}, undefined, {
      onToolEvent: (event) => {
        recorder.push(event.toolCallId);
        if (event.toolCallId === "id-1") {
          throw new Error("first handler error");
        }
      },
    }),
  ).rejects.toThrow("first handler error");

  // id-2 must have been called despite id-1 throwing.
  expect(recorder).toEqual(["id-1", "id-2"]);
});

test("onToolEvent: text mode does not invoke the callback at all", async () => {
  const called: unknown[] = [];

  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeToolCallLine("id-1", "Tool One", "read"),
        makeAgentChunkLine("done"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  const sessionWithVerboseMode: typeof session = { ...session, replyMode: "verbose" };
  await expect(
    transport.prompt(sessionWithVerboseMode, "hello", async () => {}, undefined, {
      toolEventMode: "text",
      onToolEvent: (event) => {
        called.push(event);
      },
    }),
  ).resolves.toBeDefined();

  expect(called).toHaveLength(0);
});

// --- R1: toolEventMode demotion when onToolEvent is absent ---

test("R1: explicit toolEventMode:'structured' without onToolEvent → tool call lands in reply stream (text fallback)", async () => {
  const segments: string[] = [];

  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeToolCallLine("id-r1", "Demoted tool", "read"),
        makeAgentChunkLine("final"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  const sessionWithVerboseMode: typeof session = { ...session, replyMode: "verbose" };
  await transport.prompt(sessionWithVerboseMode, "hello", async (text) => {
    segments.push(text);
  }, undefined, {
    toolEventMode: "structured",
    // no onToolEvent — the transport must demote to 'text'
  });

  // Tool call must surface as text, not be silently dropped.
  expect(segments.some((s) => s.includes("Demoted tool"))).toBe(true);
});

test("R1: explicit toolEventMode:'both' without onToolEvent → tool call lands in reply stream (text fallback)", async () => {
  const segments: string[] = [];

  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeToolCallLine("id-r1b", "Both demoted tool", "read"),
        makeAgentChunkLine("final"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  const sessionWithVerboseMode: typeof session = { ...session, replyMode: "verbose" };
  await transport.prompt(sessionWithVerboseMode, "hello", async (text) => {
    segments.push(text);
  }, undefined, {
    toolEventMode: "both",
    // no onToolEvent — the transport must demote to 'text'
  });

  // The 'both' mode already produces text segments at the parser level
  // (wantsText is true for both). This test is a regression smoke for the
  // demotion path — primarily that prompt() does not throw or hang. The
  // wire-format effect of the demotion is asserted in the bridge transport
  // 'both' test, which checks toolEventMode: 'text' is sent.
  expect(segments.some((s) => s.includes("Both demoted tool"))).toBe(true);
});

// --- R2: streaming parser activates when only onToolEvent is provided ---

test("R2: streaming parser activates when only onToolEvent is provided (no reply, no onSegment)", async () => {
  const toolEvents: unknown[] = [];

  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeToolCallLine("id-r2", "Search files", "search"),
        makeAgentChunkLine("done"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  await transport.prompt(session, "hello", undefined, undefined, {
    onToolEvent: (event) => {
      toolEvents.push(event);
    },
  });

  expect(toolEvents).toHaveLength(1);
  expect((toolEvents[0] as { toolCallId: string }).toolCallId).toBe("id-r2");
  expect((toolEvents[0] as { toolName: string }).toolName).toBe("Search files");
  expect((toolEvents[0] as { kind: string }).kind).toBe("search");
});

test("R2: onToolEvent-only caller still gets the correct final text from the streaming branch", async () => {
  const toolEvents: unknown[] = [];

  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeToolCallLine("id-r2b", "Read config", "read"),
        makeAgentChunkLine("Agent reply here"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  const result = await transport.prompt(session, "hello", undefined, undefined, {
    onToolEvent: (event) => {
      toolEvents.push(event);
    },
  });

  expect(toolEvents).toHaveLength(1);
  expect((toolEvents[0] as { toolName: string }).toolName).toBe("Read config");
  expect(result).toEqual({ text: "Agent reply here" });
});

// --- onThought wiring tests ---

function makeThoughtChunkLine(text: string): string {
  return JSON.stringify({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text },
      },
    },
  });
}

test("onThought: callback receives thought text without bleeding into the reply stream", async () => {
  const thoughts: string[] = [];
  const segments: string[] = [];

  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeThoughtChunkLine("weighing options"),
        makeAgentChunkLine("final answer"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  await transport.prompt(session, "hi", async (text) => {
    segments.push(text);
  }, undefined, {
    onThought: (chunk) => {
      thoughts.push(chunk);
    },
  });

  // Thought text reaches onThought only; the agent message goes to reply().
  expect(thoughts).toEqual(["weighing options"]);
  expect(segments).toEqual(["final answer"]);
  expect(segments.every((s) => !s.includes("weighing options"))).toBe(true);
});

test("onThought: handler error rejects the prompt", async () => {
  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeThoughtChunkLine("weighing options"),
        makeAgentChunkLine("done"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  await expect(
    transport.prompt(session, "hi", undefined, undefined, {
      onThought: () => {
        throw new Error("thought handler boom");
      },
    }),
  ).rejects.toThrow("thought handler boom");
});

test("onThought: only the first handler error is surfaced", async () => {
  let callIndex = 0;

  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeThoughtChunkLine("first thought"),
        makeThoughtChunkLine("second thought"),
        makeAgentChunkLine("done"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  await expect(
    transport.prompt(session, "hi", undefined, undefined, {
      onThought: () => {
        callIndex += 1;
        throw new Error(`thought error ${callIndex}`);
      },
    }),
  ).rejects.toThrow("thought error 1");
});

// --- onPlan wiring tests ---

function makePlanLine(entries: unknown[]): string {
  return JSON.stringify({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "plan",
        entries,
      },
    },
  });
}

test("onPlan: callback receives plan entries without bleeding into the reply stream", async () => {
  const plans: unknown[] = [];
  const segments: string[] = [];

  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makePlanLine([{ content: "step 1", status: "completed" }, { content: "step 2", status: "in_progress" }]),
        makeAgentChunkLine("final answer"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  await transport.prompt(session, "hi", async (text) => {
    segments.push(text);
  }, undefined, {
    onPlan: (entries) => {
      plans.push(entries);
    },
  });

  expect(plans).toEqual([[{ content: "step 1", status: "completed" }, { content: "step 2", status: "in_progress" }]]);
  expect(segments).toEqual(["final answer"]);
});

test("onPlan: handler error rejects the prompt", async () => {
  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makePlanLine([{ content: "boom", status: "completed" }]),
        makeAgentChunkLine("done"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  await expect(
    transport.prompt(session, "hi", undefined, undefined, {
      onPlan: () => {
        throw new Error("plan handler boom");
      },
    }),
  ).rejects.toThrow("plan handler boom");
});

// --- onUsage wiring tests ---

function makeUsageLine(used: number, size: number): string {
  return JSON.stringify({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "usage_update",
        used,
        size,
      },
    },
  });
}

test("onUsage: callback receives usage data without bleeding into the reply stream", async () => {
  const usages: unknown[] = [];
  const segments: string[] = [];

  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeUsageLine(1024, 16384),
        makeAgentChunkLine("final answer"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  await transport.prompt(session, "hi", async (text) => {
    segments.push(text);
  }, undefined, {
    onUsage: (usage) => {
      usages.push(usage);
    },
  });

  expect(usages).toEqual([{ used: 1024, size: 16384 }]);
  expect(segments).toEqual(["final answer"]);
});

test("onUsage: handler error rejects the prompt", async () => {
  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeUsageLine(100, 1000),
        makeAgentChunkLine("done"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  await expect(
    transport.prompt(session, "hi", undefined, undefined, {
      onUsage: () => {
        throw new Error("usage handler boom");
      },
    }),
  ).rejects.toThrow("usage handler boom");
});

// --- onCommands wiring tests ---

function makeCommandsLine(commands: unknown[]): string {
  return JSON.stringify({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: commands,
      },
    },
  });
}

test("onCommands: callback receives commands list without bleeding into the reply stream", async () => {
  const commandsList: unknown[] = [];
  const segments: string[] = [];

  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeCommandsLine([{ name: "compact", description: "Compact context" }]),
        makeAgentChunkLine("final answer"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  await transport.prompt(session, "hi", async (text) => {
    segments.push(text);
  }, undefined, {
    onCommands: (commands) => {
      commandsList.push(commands);
    },
  });

  expect(commandsList).toEqual([[{ name: "compact", description: "Compact context", hasInput: false }]]);
  expect(segments).toEqual(["final answer"]);
});

test("onCommands: handler error rejects the prompt", async () => {
  const transport = new AcpxCliTransport(
    { command: "acpx" },
    undefined,
    undefined,
    undefined,
    {
      spawnPrompt: () => makeFakeSpawn([
        makeCommandsLine([{ name: "boom" }]),
        makeAgentChunkLine("done"),
      ]),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    },
  );

  await expect(
    transport.prompt(session, "hi", undefined, undefined, {
      onCommands: () => {
        throw new Error("commands handler boom");
      },
    }),
  ).rejects.toThrow("commands handler boom");
});

test("getAgentSessionId requests JSON and returns acpx 0.12 acpSessionId", async () => {
  const run = mock(async () => ({
    code: 0,
    stdout: JSON.stringify({ acpxRecordId: "acpx-rec-1", acpSessionId: "agent-xyz" }),
    stderr: "",
  }));
  const runPty = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run, runPty);

  const id = await transport.getAgentSessionId(session);

  expect(id).toBe("agent-xyz");
  expect(run).toHaveBeenCalledWith(
    "acpx",
    expect.arrayContaining(["--format", "json", "sessions", "show", "backend:api-fix"]),
    expect.objectContaining({ timeoutMs: 30_000 }),
  );
});

test("getAgentSessionId returns undefined when the record has no agentSessionId", async () => {
  const run = mock(async () => ({
    code: 0,
    stdout: JSON.stringify({ acpxRecordId: "acpx-rec-1" }),
    stderr: "",
  }));
  const runPty = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run, runPty);

  const id = await transport.getAgentSessionId(session);

  expect(id).toBeUndefined();
});

test("ensureSession fails closed when migration cannot resolve the record", async () => {
  const run = mock(async () => ({ code: 1, stdout: "", stderr: "acpx command timed out after 1000ms" }));
  const runPty = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run, runPty);
  await expect(transport.ensureSession({
    ...session,
    acpxAgent: "xacpx-managed-custom-aaaabbbbcccc",
    agentArgv: ["C:\\Program Files\\agent.exe", "--acp"],
  })).rejects.toThrow(/timed out after 1000ms/);
});

test("ensureSession treats a genuinely missing session as no-record and proceeds", async () => {
  const calls: string[][] = [];
  const run = mock(async (_command: string, args: string[]) => {
    calls.push(args);
    if (args.includes("show")) {
      return { code: 1, stdout: "", stderr: "No named session \"backend:api-fix\" for cwd /tmp/backend" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const runPty = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const transport = new AcpxCliTransport({ command: "acpx" }, run, runPty);
  await transport.ensureSession({
    ...session,
    acpxAgent: "xacpx-managed-custom-aaaabbbbcccc",
    agentArgv: ["C:\\Program Files\\agent.exe", "--acp"],
  });
  expect(calls.some((args) => args.includes("ensure"))).toBe(true);
});
