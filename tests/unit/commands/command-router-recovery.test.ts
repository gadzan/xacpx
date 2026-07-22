import { expect, mock, test, beforeEach } from "bun:test";
import { CommandRouter } from "../../../src/commands/command-router";
import { PromptCommandError } from "../../../src/transport/prompt-output";
import {
  MemoryStateStore,
  SessionService,
  SessionAgentCommandResolver,
  createConfig,
  createEmptyState,
  createLogger,
  createTransport,
  getPromptMock,
} from "./command-router-test-support";
import { setLocale, t } from "../../../src/i18n";

beforeEach(() => {
  setLocale("zh");
});

test("renders a recovery hint when the current acpx session is missing", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  getPromptMock(transport).mockImplementationOnce(async () => {
    throw new Error(
      "No acpx session found (searched up to /tmp/backend).\nCreate one: acpx codex sessions new --name backend:api-fix",
    );
  });
  const router = new CommandRouter(sessions, transport);

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");
  const reply = await router.handle("wx:user", "hello");

  expect(reply.text).toContain(t().recovery.sessionUnavailable("api-fix"));
  expect(reply.text).toContain(t().recovery.sessionUnavailableRenewHint("api-fix", "codex", "backend"));
  expect(reply.text).not.toContain("No acpx session found");
  expect(reply.text).not.toContain("/tmp/backend");
  expect(reply.text).not.toContain("backend:api-fix");
});

test("recovers a missing session once after resolving transport agent command", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  getPromptMock(transport)
    .mockImplementationOnce(async () => {
      throw new Error(
        "No acpx session found (searched up to /tmp/backend).\nCreate one: acpx codex sessions new --name backend:api-fix",
      );
    })
    .mockImplementationOnce(async (session: ResolvedSession, text: string) => ({
      text: `agent:${session.agentCommand}:${text}`,
    }));
  const resolveSessionAgentCommand = mock<SessionAgentCommandResolver>()
    .mockImplementationOnce(async () => undefined)
    .mockImplementationOnce(async () => "npx @zed-industries/codex-acp@^0.9.5");
  const router = new CommandRouter(sessions, transport, undefined, undefined, undefined, resolveSessionAgentCommand);

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");
  const current = await sessions.getCurrentSession("wx:user");
  const reply = await router.handle("wx:user", "hello");

  expect(reply.text).toContain("npx @zed-industries/codex-acp@^0.9.5");
  expect(getPromptMock(transport).mock.calls).toHaveLength(2);
  expect(getPromptMock(transport).mock.calls.at(-1)?.[0]).toMatchObject({
    alias: "api-fix",
    transportSession: current?.transportSession,
    agentCommand: "npx @zed-industries/codex-acp@^0.9.5",
  });
});

test("renders a generic failure hint when prompt stops after partial output", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  getPromptMock(transport).mockImplementationOnce(async () => {
    throw new Error("未收到最终回复。最后一条输出：让我更新任务状态并继续执行测试验证。");
  });
  const router = new CommandRouter(sessions, transport);

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");
  const reply = await router.handle("wx:user", "hello");

  expect(reply.text).toContain(t().recovery.sessionInterrupted("api-fix"));
  expect(reply.text).toContain(t().recovery.sessionInterruptedHint);
  expect(reply.text).toContain("未收到最终回复");
});

test("rethrows unrelated transport failures instead of masking them as partial output", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  getPromptMock(transport).mockImplementationOnce(async () => {
    throw new Error("spawn acpx ENOENT");
  });
  const router = new CommandRouter(sessions, transport);

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");

  await expect(router.handle("wx:user", "hello")).rejects.toThrow("spawn acpx ENOENT");
});

test("renders an attach-first hint when session creation times out", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  (transport.ensureSession as ReturnType<typeof mock>).mockImplementationOnce(async () => {
    throw new Error('acpx command timed out after 120000ms: codex sessions new --name "backend:api-fix"');
  });
  const router = new CommandRouter(sessions, transport);

  const reply = await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");

  expect(reply.text).toContain(t().recovery.sessionCreationFailed);
  expect(reply.text).toContain("acpx command timed out after 120000ms");
  expect(reply.text).toContain(t().recovery.sessionCreationAttachHint("api-fix", "codex", "backend"));
});

test("renders verification failure with explicit reason before the attach hint", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  (transport.hasSession as ReturnType<typeof mock>).mockImplementationOnce(async () => false);
  const router = new CommandRouter(sessions, transport);

  const reply = await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");

  expect(reply.text).toContain(t().recovery.sessionCreationFailed);
  expect(reply.text).toContain(t().recovery.sessionCreationError(t().recovery.sessionCreationVerificationDetail));
  expect(reply.text).toContain(t().recovery.sessionCreationAttachHint("api-fix", "codex", "backend"));
});

test("logs parsed commands and transport timing summaries", async () => {
  const events: string[] = [];
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, createConfig(), undefined, createLogger(events));

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");

  expect(events.some((entry) => entry.includes("DEBUG command.parsed"))).toBe(true);
  expect(events.some((entry) => entry.includes("INFO transport.ensure_session"))).toBe(true);
  expect(events.some((entry) => entry.includes("INFO command.completed"))).toBe(true);
});

test("logs prompt diagnostics when transport fails with captured output", async () => {
  const events: string[] = [];
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  getPromptMock(transport).mockImplementationOnce(async () => {
    throw new PromptCommandError("command failed with exit code 5", {
      code: 5,
      stdout: [
        JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize" }),
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "hello" },
            },
          },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { stopReason: "end_turn" },
        }),
      ].join("\n"),
      stderr: "fatal",
    });
  });
  const router = new CommandRouter(sessions, transport, createConfig(), undefined, createLogger(events));

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");
  await expect(router.handle("wx:user", "hello")).rejects.toThrow("command failed with exit code 5");

  expect(events.some((entry) => entry.includes("ERROR transport.prompt.failed"))).toBe(true);
  expect(events.some((entry) => entry.includes('"exitCode":5'))).toBe(true);
  expect(events.some((entry) => entry.includes('"stdoutPreview":"{\\"jsonrpc\\":\\"2.0\\",\\"id\\":0,\\"method\\":\\"initialize\\"}'))).toBe(true);
  expect(events.some((entry) => entry.includes('"stdoutLength":'))).toBe(true);
  expect(events.some((entry) => entry.includes('"stdoutLineCount":3'))).toBe(true);
  expect(events.some((entry) => entry.includes('"stdoutAgentMessageChunkCount":1'))).toBe(true);
  expect(events.some((entry) => entry.includes('"stdoutStopReason":"end_turn"'))).toBe(true);
  expect(events.some((entry) => entry.includes('"stdoutMethods":"initialize,session/update"'))).toBe(true);
  expect(events.some((entry) => entry.includes('"stderrPreview":"fatal"'))).toBe(true);
  expect(events.some((entry) => entry.includes('"stderrTailPreview":"fatal"'))).toBe(true);
  expect(events.some((entry) => entry.includes('"stderrLength":5'))).toBe(true);
});
