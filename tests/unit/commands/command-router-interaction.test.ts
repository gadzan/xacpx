import { beforeEach, expect, mock, test } from "bun:test";
import { setLocale } from "../../../src/i18n";
import { CommandRouter } from "../../../src/commands/command-router";
import type { EnsureSessionProgress, ResolvedSession } from "../../../src/transport/types";
import type { SessionAgentCommandResolver } from "./command-router-test-support";
import {
  MemoryStateStore,
  SessionService,
  createLogger,
  createOrchestrationService,
  createConfig,
  createEmptyState,
  createTransport,
  getApproveTaskMock,
  getCancelMock,
  getCancelGroupMock,
  getCancelTaskMock,
  getListTasksMock,
  getGetGroupSummaryMock,
  getGetTaskMock,
  getCreateGroupMock,
  getListGroupSummariesMock,
  getMarkCoordinatorGroupsInjectedMock,
  getClaimActiveHumanReplyMock,
  getActiveHumanQuestionPackageMock,
  getRecordCoordinatorRouteContextMock,
  getListPendingCoordinatorResultsMock,
  getListPendingCoordinatorBlockersMock,
  getListContestedCoordinatorResultsMock,
  getMarkTaskInjectionAppliedMock,
  getMarkTaskInjectionFailedMock,
  getDirectCancelTaskMock,
  getPromptMock,
  getDeleteSessionMock,
  getRequestDelegateMock,
  getSetModeMock,
} from "./command-router-test-support";

beforeEach(() => {
  setLocale("zh");
});

test("emits perf marks for prompt transport lifecycle", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const marks: Array<{ event: string; context?: Record<string, unknown> }> = [];
  const perfSpan = {
    traceId: "trace-test",
    mark: (event: string, context?: Record<string, unknown>) => {
      marks.push({ event, context });
    },
    setOutcome: () => {},
  };
  transport.prompt = mock(async (_session, _text, _reply, _replyContext, options) => {
    await options?.onSegment?.("first streamed chunk");
    await options?.onSegment?.("second streamed chunk");
    return { text: "agent done" };
  });
  const router = new CommandRouter(sessions, transport);

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, perfSpan);
  await router.handle("wx:user", "hello", async () => {}, undefined, undefined, undefined, undefined, undefined, undefined, undefined, perfSpan);

  expect(marks.map((m) => m.event)).toContain("router.authorized");
  // No per-message config reload: out-of-band edits arrive via the config
  // watcher (main.ts), so the router must not read the store on this path.
  expect(marks.map((m) => m.event)).not.toContain("router.config_refreshed");
  expect(marks.map((m) => m.event)).toContain("session.ready");
  expect(marks.map((m) => m.event)).toContain("transport.prompt_dispatched");
  expect(marks.filter((m) => m.event === "transport.first_chunk")).toHaveLength(1);
  expect(marks.at(-1)).toEqual({ event: "transport.prompt_done", context: { localOutcome: "ok" } });
});

test("emits transport.prompt_done with error outcome", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const marks: Array<{ event: string; context?: Record<string, unknown> }> = [];
  const perfSpan = {
    traceId: "trace-test",
    mark: (event: string, context?: Record<string, unknown>) => {
      marks.push({ event, context });
    },
    setOutcome: () => {},
  };
  transport.prompt = mock(async () => {
    throw new Error("boom");
  });
  const router = new CommandRouter(sessions, transport);

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");
  await expect(router.handle("wx:user", "hello", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, perfSpan)).rejects.toThrow("boom");

  expect(marks.at(-1)).toEqual({ event: "transport.prompt_done", context: { localOutcome: "error" } });
});

test("routes plain text to the current session", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");
  const reply = await router.handle("wx:user", "check this stack trace");

  expect(reply.text).toContain("agent:api-fix:check this stack trace");
});

test("control-channel slash commands pass through to the agent (web is GUI-first)", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  // Session set-up uses no control metadata, so `/session new` is still handled by xacpx.
  await router.handle("relay:acct", "/session new web --agent codex --ws backend");

  // A relay-web user types an xacpx command; with channel="control" the router forwards
  // it verbatim to the agent instead of interpreting it (the web GUI owns these actions).
  const reply = await router.handle(
    "relay:acct", "/status", undefined, undefined, undefined, undefined,
    { channel: "control", chatType: "direct" },
  );

  expect(getPromptMock(transport).mock.calls.at(-1)?.[1]).toBe("/status");
  expect(reply.text).toContain("agent:web:/status"); // agent echoed it, not the xacpx status card
});

test("control-channel /clear still resets the session instead of passing through", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  await router.handle("relay:acct", "/session new web --agent codex --ws backend");
  const before = await sessions.getCurrentSession("relay:acct");
  const promptsBefore = getPromptMock(transport).mock.calls.length;

  // `/clear` is a session-reset alias. The web GUI has no other reset entry, so even on the
  // control channel it must be handled by xacpx (recreate the transport session) rather than
  // forwarded to the agent verbatim like other slash commands.
  const reply = await router.handle(
    "relay:acct", "/clear", undefined, undefined, undefined, undefined,
    { channel: "control", chatType: "direct" },
  );
  const after = await sessions.getCurrentSession("relay:acct");

  expect(getPromptMock(transport).mock.calls.length).toBe(promptsBefore); // never sent to the agent
  expect(after?.transportSession).not.toBe(before?.transportSession);
  expect(after?.transportSession.startsWith("backend:web:reset-")).toBe(true);
  expect(reply.text).not.toContain("agent:web:/clear");
});

test("control-channel /clear keeps a native session native end-to-end", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  // The fresh transport session created by the reset advertises a new agent rollout id;
  // the reset handler reads it back to keep the logical session native.
  (transport as { getAgentSessionId?: unknown }).getAgentSessionId = mock(async () => "ses_fresh");
  const router = new CommandRouter(sessions, transport);

  // Seed a native (agent-side) session bound to the chat — as if attached from a codex rollout.
  await sessions.attachNativeSession({
    alias: "resumed",
    agent: "codex",
    workspace: "backend",
    transportSession: "backend:resumed",
    agentSessionId: "ses_orig",
  });
  await sessions.useSession("relay:acct", "resumed");
  const before = await sessions.getCurrentSession("relay:acct");
  expect(before?.source).toBe("agent-side");

  await router.handle(
    "relay:acct", "/clear", undefined, undefined, undefined, undefined,
    { channel: "control", chatType: "direct" },
  );
  const after = await sessions.getCurrentSession("relay:acct");

  // Reset recreated the transport session but the logical session stays native, re-bound to
  // the fresh rollout id — so the dashboard's "native" badge survives /clear.
  expect(after?.source).toBe("agent-side");
  expect(after?.agentSessionId).toBe("ses_fresh");
  expect(after?.transportSession).not.toBe(before?.transportSession);
  expect(after?.transportSession.startsWith("backend:resumed:reset-")).toBe(true);
});

test("control-channel /clear does not stream chat-style progress pings (web is GUI-first)", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  // Session (re)creation emits a spawn progress event; the chat progress handler would
  // otherwise turn it into a "🚀 Starting…" ping streamed to the chat surface.
  transport.ensureSession = mock(async (_s: ResolvedSession, onProgress?: (p: EnsureSessionProgress) => void) => {
    onProgress?.("spawn");
  });
  const router = new CommandRouter(sessions, transport);
  await router.handle("relay:acct", "/session new web --agent codex --ws backend");

  const pings: string[] = [];
  const reply = async (text: string) => {
    pings.push(text);
  };
  const res = await router.handle(
    "relay:acct", "/clear", reply, undefined, undefined, undefined,
    { channel: "control", chatType: "direct" },
  );

  // No emoji progress dumped into the web chat pane — only the clean confirmation as the
  // turn result; the dashboard refreshes the row via the sessions-changed event.
  expect(pings).toEqual([]);
  expect(res.text).toContain("已重置");
});

test("non-control /clear still streams the chat progress pings", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  transport.ensureSession = mock(async (_s: ResolvedSession, onProgress?: (p: EnsureSessionProgress) => void) => {
    onProgress?.("spawn");
  });
  const router = new CommandRouter(sessions, transport);
  await router.handle("wx:user", "/session new web --agent codex --ws backend");

  const pings: string[] = [];
  const reply = async (text: string) => {
    pings.push(text);
  };
  await router.handle(
    "wx:user", "/clear", reply, undefined, undefined, undefined,
    { channel: "weixin", chatType: "direct" },
  );

  // Chat channels have no GUI, so they keep the live "🚀 Starting…" progress feedback.
  expect(pings.some((p) => p.includes("🚀"))).toBe(true);
});

test("non-control channels still handle xacpx slash commands", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  await router.handle("wx:user", "/session new web --agent codex --ws backend");
  const before = getPromptMock(transport).mock.calls.length;

  // `/status` from a chat channel (no GUI) is handled by xacpx, never sent to the agent.
  const reply = await router.handle(
    "wx:user", "/status", undefined, undefined, undefined, undefined,
    { channel: "weixin", chatType: "direct" },
  );

  expect(getPromptMock(transport).mock.calls.length).toBe(before);
  expect(reply.text).not.toContain("agent:web:/status");
});

test("binds the current coordinator session as MCP identity for plain prompts", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");
  await router.handle("wx:user", "can you delegate work?");

  const promptedSession = getPromptMock(transport).mock.calls.at(-1)?.[0];
  expect(promptedSession?.mcpCoordinatorSession).toBe("backend:api-fix");
  expect(promptedSession?.mcpSourceHandle).toBeUndefined();
});

test("records inbound chat metadata with coordinator route context for plain prompts", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService();
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:group", "/session new api-fix --agent codex --ws backend");
  await router.handle(
    "wx:group",
    "提醒我明天看 CI",
    undefined,
    undefined,
    undefined,
    undefined,
    {
      channel: "weixin",
      chatType: "group",
      groupId: "group-1",
      senderId: "user-1",
      senderName: "Alice",
      isOwner: false,
    },
  );

  expect(getRecordCoordinatorRouteContextMock(orchestration).mock.calls.at(-1)?.[0]).toEqual({
    coordinatorSession: "backend:api-fix",
    chatKey: "wx:group",
    sessionAlias: "api-fix",
    channel: "weixin",
    chatType: "group",
    groupId: "group-1",
    senderId: "user-1",
    senderName: "Alice",
    isOwner: false,
  });
});

test("injects pending delegate results into the next coordinator prompt and marks them consumed", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-completed-1",
        sourceHandle: "backend:worker:backend:coordinator",
        sourceKind: "worker",
        coordinatorSession: "backend:coordinator",
        workerSession: "backend:claude:backend:coordinator",
        workspace: "backend",
        targetAgent: "claude",
        task: "审查当前方案",
        status: "completed",
        summary: "done",
        resultText: "ok",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:05:00.000Z",
      },
      {
        taskId: "task-failed-1",
        sourceHandle: "backend:worker:backend:coordinator",
        sourceKind: "worker",
        coordinatorSession: "backend:coordinator",
        workerSession: "backend:codex:backend:coordinator",
        workspace: "backend",
        targetAgent: "codex",
        task: "继续处理后续任务",
        status: "failed",
        summary: "boom",
        resultText: "",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:06:00.000Z",
      },
      {
        taskId: "task-running-1",
        sourceHandle: "backend:worker:backend:coordinator",
        sourceKind: "worker",
        coordinatorSession: "backend:coordinator",
        workerSession: "backend:claude:backend:coordinator",
        workspace: "backend",
        targetAgent: "claude",
        task: "不应注入",
        status: "running",
        summary: "",
        resultText: "",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:07:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "继续");

  expect(getListPendingCoordinatorResultsMock(orchestration).mock.calls.at(-1)?.[0]).toBe("backend:coordinator");
  expect(getPromptMock(transport).mock.calls.at(-1)?.[1]).toContain("以下是自上次以来完成的委派任务结果");
  expect(getPromptMock(transport).mock.calls.at(-1)?.[1]).toContain("[delegate_result]");
  expect(getPromptMock(transport).mock.calls.at(-1)?.[1]).toContain("task-completed-1");
  expect(getPromptMock(transport).mock.calls.at(-1)?.[1]).toContain("task-failed-1");
  expect(getPromptMock(transport).mock.calls.at(-1)?.[1]).not.toContain("task-running-1");
  expect(getPromptMock(transport).mock.calls.at(-1)?.[1]).toContain("用户最新消息：");
  expect(getPromptMock(transport).mock.calls.at(-1)?.[1]).toContain("继续");
  expect(reply.text).toContain("agent:coordinator:以下是自上次以来完成的委派任务结果");
  expect(getMarkTaskInjectionAppliedMock(orchestration).mock.calls.at(-1)?.[0]).toEqual([
    "task-completed-1",
    "task-failed-1",
  ]);
});

test("does not mark injected when the coordinator prompt fails", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  (transport.prompt as ReturnType<typeof mock>).mockImplementationOnce(async () => {
    throw new Error("prompt failed");
  });
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-completed-1",
        sourceHandle: "backend:worker:backend:coordinator",
        sourceKind: "worker",
        coordinatorSession: "backend:coordinator",
        workerSession: "backend:claude:backend:coordinator",
        workspace: "backend",
        targetAgent: "claude",
        task: "审查当前方案",
        status: "completed",
        summary: "done",
        resultText: "ok",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:05:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");

  await expect(router.handle("wx:user", "继续")).rejects.toThrow("prompt failed");
  expect(getMarkTaskInjectionAppliedMock(orchestration).mock.calls).toHaveLength(0);
  expect(getMarkTaskInjectionFailedMock(orchestration).mock.calls.at(-1)).toEqual([
    ["task-completed-1"],
    "prompt failed",
  ]);
});

test("does not consume a human reply when prompt delivery fails", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  (transport.prompt as ReturnType<typeof mock>).mockImplementationOnce(async () => {
    throw new Error("prompt failed");
  });
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-1",
        sourceHandle: "backend:worker:backend:coordinator",
        sourceKind: "worker",
        coordinatorSession: "backend:coordinator",
        workerSession: "backend:claude:backend:coordinator",
        workspace: "backend",
        targetAgent: "claude",
        task: "审查数据库方案",
        status: "blocked",
        summary: "",
        resultText: "",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:05:00.000Z",
        openQuestion: {
          questionId: "question-1",
          question: "Should I keep SQLite?",
          whyBlocked: "schema choice changes follow-up steps",
          whatIsNeeded: "database decision",
          askedAt: "2026-04-13T10:05:00.000Z",
          status: "open",
        },
      },
    ],
    activeHumanPackage: {
      packageId: "package-1",
      promptText: "请确认数据库方案。",
      openTaskIds: ["task-1"],
      queuedCount: 0,
      awaitingReplyMessageId: "message-1",
    },
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  await expect(
    router.handle("wx:user", "继续 SQLite，不切 Postgres", undefined, "ctx-2", "acc-1"),
  ).rejects.toThrow("prompt failed");

  expect(getClaimActiveHumanReplyMock(orchestration).mock.calls).toHaveLength(0);
  await expect(orchestration.getActiveHumanQuestionPackage("backend:coordinator")).resolves.toMatchObject({
    packageId: "package-1",
    awaitingReplyMessageId: "message-1",
  });
});

test("injects completed delegation groups before standalone task results", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-group-1",
        sourceHandle: "backend:worker:backend:coordinator",
        sourceKind: "worker",
        coordinatorSession: "backend:coordinator",
        workerSession: "backend:claude:backend:coordinator",
        workspace: "backend",
        targetAgent: "claude",
        task: "审查当前方案",
        groupId: "group-review",
        status: "completed",
        summary: "done",
        resultText: "ok",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:05:00.000Z",
      },
      {
        taskId: "task-group-2",
        sourceHandle: "backend:worker:backend:coordinator",
        sourceKind: "worker",
        coordinatorSession: "backend:coordinator",
        workerSession: "backend:codex:backend:coordinator",
        workspace: "backend",
        targetAgent: "codex",
        task: "实现修复",
        groupId: "group-review",
        status: "failed",
        summary: "boom",
        resultText: "",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:06:00.000Z",
      },
      {
        taskId: "task-standalone-1",
        sourceHandle: "backend:worker:backend:coordinator",
        sourceKind: "worker",
        coordinatorSession: "backend:coordinator",
        workerSession: "backend:claude:backend:coordinator",
        workspace: "backend",
        targetAgent: "claude",
        task: "补充说明",
        status: "completed",
        summary: "done",
        resultText: "extra",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:07:00.000Z",
      },
    ],
    groups: [
      {
        groupId: "group-review",
        coordinatorSession: "backend:coordinator",
        title: "parallel review",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:06:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "继续");

  const promptText = getPromptMock(transport).mock.calls.at(-1)?.[1] ?? "";
  expect(promptText).toContain("[delegate_group_result]");
  expect(promptText).toContain("group_id: group-review");
  expect(promptText).toContain("parallel review");
  expect(promptText).toContain("task-standalone-1");
  expect(promptText.indexOf("[delegate_group_result]")).toBeLessThan(promptText.indexOf("[delegate_result]"));
  expect(getMarkCoordinatorGroupsInjectedMock(orchestration).mock.calls.at(-1)?.[0]).toEqual(["group-review"]);
  expect(getMarkTaskInjectionAppliedMock(orchestration).mock.calls.at(-1)?.[0]).toEqual([
    "task-group-1",
    "task-group-2",
    "task-standalone-1",
  ]);
  expect(reply.text).toContain("parallel review");
});

test("treats the next human message as an active package reply when awaitingReplyMessageId is present", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-1",
        sourceHandle: "backend:worker:backend:coordinator",
        sourceKind: "worker",
        coordinatorSession: "backend:coordinator",
        workerSession: "backend:claude:backend:coordinator",
        workspace: "backend",
        targetAgent: "claude",
        task: "审查数据库方案",
        status: "blocked",
        summary: "",
        resultText: "",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:05:00.000Z",
        openQuestion: {
          questionId: "question-1",
          question: "Should I keep SQLite?",
          whyBlocked: "schema choice changes follow-up steps",
          whatIsNeeded: "database decision",
          askedAt: "2026-04-13T10:05:00.000Z",
          status: "open",
        },
      },
    ],
    activeHumanPackage: {
      packageId: "package-1",
      promptText: "请确认数据库方案。",
      openTaskIds: ["task-1"],
      queuedCount: 2,
      awaitingReplyMessageId: "message-1",
      messages: [
        {
          messageId: "message-1",
          kind: "initial" as const,
          promptText: "请确认数据库方案。",
          createdAt: "2026-04-13T10:06:00.000Z",
          taskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
        },
      ],
    },
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "继续 SQLite，不切 Postgres", undefined, "ctx-2", "acc-1");

  const promptText = getPromptMock(transport).mock.calls.at(-1)?.[1] ?? "";
  expect(promptText).toContain("[delegate_question_package]");
  expect(promptText).toContain("当前存在一个等待 human 回复的问题包");
  expect(promptText).toContain("请确认数据库方案。");
  expect(promptText).toContain("用户最新消息：");
  expect(promptText).toContain("继续 SQLite，不切 Postgres");
  expect(reply.text).toContain("请确认数据库方案");
  expect(getRecordCoordinatorRouteContextMock(orchestration).mock.calls.at(-1)?.[0]).toEqual({
    coordinatorSession: "backend:coordinator",
    chatKey: "wx:user",
    sessionAlias: "coordinator",
    replyContextToken: "ctx-2",
    accountId: "acc-1",
  });
  expect(getClaimActiveHumanReplyMock(orchestration).mock.calls.at(-1)?.[0]).toEqual({
    coordinatorSession: "backend:coordinator",
    chatKey: "wx:user",
    packageId: "package-1",
    messageId: "message-1",
    accountId: "acc-1",
    replyContextToken: "ctx-2",
  });
  expect(getListPendingCoordinatorBlockersMock(orchestration).mock.calls.at(-1)?.[0]).toBe("backend:coordinator");
  expect(getListContestedCoordinatorResultsMock(orchestration).mock.calls.at(-1)?.[0]).toBe("backend:coordinator");
});

test("does not auto-claim human input when the active package has not been delivered yet", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-1",
        sourceHandle: "backend:worker:backend:coordinator",
        sourceKind: "worker",
        coordinatorSession: "backend:coordinator",
        workerSession: "backend:claude:backend:coordinator",
        workspace: "backend",
        targetAgent: "claude",
        task: "审查数据库方案",
        status: "blocked",
        summary: "",
        resultText: "",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:05:00.000Z",
        openQuestion: {
          questionId: "question-1",
          question: "Should I keep SQLite?",
          whyBlocked: "schema choice changes follow-up steps",
          whatIsNeeded: "database decision",
          askedAt: "2026-04-13T10:05:00.000Z",
          status: "open",
        },
      },
    ],
    activeHumanPackage: {
      packageId: "package-1",
      promptText: "请确认数据库方案。",
      openTaskIds: ["task-1"],
      queuedCount: 0,
    },
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  await router.handle("wx:user", "先解释一下当前状态", undefined, "ctx-2", "acc-1");

  const promptText = getPromptMock(transport).mock.calls.at(-1)?.[1] ?? "";
  expect(promptText).toContain("当前问题包尚未成功送达 human");
  expect(promptText).toContain("先按普通主线对话处理");
  expect(promptText).toContain("先解释一下当前状态");
  expect(getClaimActiveHumanReplyMock(orchestration).mock.calls).toHaveLength(0);
  expect(getActiveHumanQuestionPackageMock(orchestration).mock.calls.at(-1)?.[0]).toBe("backend:coordinator");
});

test("does not mislabel a previously delivered package as undelivered after reply claim", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-1",
        sourceHandle: "backend:worker:backend:coordinator",
        sourceKind: "worker",
        coordinatorSession: "backend:coordinator",
        workerSession: "backend:claude:backend:coordinator",
        workspace: "backend",
        targetAgent: "claude",
        task: "审查数据库方案",
        status: "blocked",
        summary: "",
        resultText: "",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:05:00.000Z",
        openQuestion: {
          questionId: "question-1",
          question: "Should I keep SQLite?",
          whyBlocked: "schema choice changes follow-up steps",
          whatIsNeeded: "database decision",
          askedAt: "2026-04-13T10:05:00.000Z",
          status: "open",
        },
      },
    ],
    activeHumanPackage: {
      packageId: "package-1",
      promptText: "请确认数据库方案。",
      openTaskIds: ["task-1"],
      queuedCount: 0,
      awaitingReplyMessageId: "message-1",
    },
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  await router.handle("wx:user", "继续 SQLite，不切 Postgres", undefined, "ctx-2", "acc-1");
  await router.handle("wx:user", "继续下一步", undefined, "ctx-3", "acc-1");

  const promptText = getPromptMock(transport).mock.calls.at(-1)?.[1] ?? "";
  expect(promptText).not.toContain("当前问题包尚未成功送达 human");
  expect(promptText).not.toContain("当前仍有一个 active human package 等待回复");
  expect(promptText).toContain("继续下一步");
});

test("fails closed before prompting when route context recording fails", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService();
  getRecordCoordinatorRouteContextMock(orchestration).mockImplementationOnce(async () => {
    throw new Error("route context failed");
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "先解释一下当前状态", undefined, "ctx-2", "acc-1");

  expect(reply.text).toContain("无法记录当前会话路由");
  expect(getPromptMock(transport).mock.calls).toHaveLength(0);
});

test("routes delegate requests through the current session coordinator context", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({ taskId: "task-1" });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const current = await sessions.getCurrentSession("wx:user");
  const reply = await router.handle("wx:user", "/delegate claude --role reviewer 审查当前方案", undefined, "ctx-123", "acc-1");

  expect(reply.text).toContain("task-1");
  expect(reply.text).toContain("backend:claude:reviewer:backend:coordinator");
  expect(getRequestDelegateMock(orchestration).mock.calls.at(-1)?.[0]).toEqual({
    sourceHandle: current?.transportSession,
    sourceKind: "coordinator",
    coordinatorSession: "backend:coordinator",
    workspace: "backend",
    targetAgent: "claude",
    role: "reviewer",
    task: "审查当前方案",
    chatKey: "wx:user",
    replyContextToken: "ctx-123",
    accountId: "acc-1",
  });
});

test("routes grouped delegate requests through the current coordinator session", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({ taskId: "task-group-1" });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const current = await sessions.getCurrentSession("wx:user");
  const reply = await router.handle("wx:user", "/dg claude --group group-review 审查当前方案", undefined, "ctx-123", "acc-1");

  expect(reply.text).toContain("task-group-1");
  expect(getRequestDelegateMock(orchestration).mock.calls.at(-1)?.[0]).toEqual({
    sourceHandle: current?.transportSession,
    sourceKind: "coordinator",
    coordinatorSession: "backend:coordinator",
    workspace: "backend",
    targetAgent: "claude",
    groupId: "group-review",
    task: "审查当前方案",
    chatKey: "wx:user",
    replyContextToken: "ctx-123",
    accountId: "acc-1",
  });
});

test("creates a group in the current coordinator session", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService();
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/group new parallel review");

  expect(getCreateGroupMock(orchestration).mock.calls.at(-1)?.[0]).toEqual({
    coordinatorSession: "backend:coordinator",
    title: "parallel review",
  });
  expect(reply.text).toContain("已创建任务组");
  expect(reply.text).toContain("parallel review");
});

test("lists groups for the current coordinator session", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    groups: [
      {
        groupId: "group-review",
        coordinatorSession: "backend:coordinator",
        title: "parallel review",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:05:00.000Z",
      },
      {
        groupId: "group-other",
        coordinatorSession: "backend:other",
        title: "other group",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:05:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/groups");

  expect(getListGroupSummariesMock(orchestration).mock.calls.at(-1)?.[0]).toEqual({
    coordinatorSession: "backend:coordinator",
  });
  expect(reply.text).toContain("group-review");
  expect(reply.text).toContain("总计 0");
  expect(reply.text).not.toContain("other group");
});

test("shows a single group summary for the current coordinator session", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-group-1",
        sourceHandle: "backend:coordinator",
        sourceKind: "coordinator",
        coordinatorSession: "backend:coordinator",
        workspace: "backend",
        targetAgent: "claude",
        task: "review api",
        groupId: "group-review",
        status: "completed",
        summary: "done",
        resultText: "ok",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:05:00.000Z",
      },
    ],
    groups: [
      {
        groupId: "group-review",
        coordinatorSession: "backend:coordinator",
        title: "parallel review",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:05:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/group group-review");

  expect(getGetGroupSummaryMock(orchestration).mock.calls.at(-1)?.[0]).toEqual({
    groupId: "group-review",
    coordinatorSession: "backend:coordinator",
  });
  expect(reply.text).toContain("任务组「group-review」");
  expect(reply.text).toContain("parallel review");
  expect(reply.text).toContain("总任务数：1");
  expect(reply.text).toContain("已完成：1");
  expect(reply.text).toContain("是否终态：是");
});

test("cancels a group in the current coordinator session", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-group-1",
        sourceHandle: "backend:coordinator",
        sourceKind: "coordinator",
        coordinatorSession: "backend:coordinator",
        workerSession: "worker-1",
        workspace: "backend",
        targetAgent: "claude",
        task: "review api",
        groupId: "group-review",
        status: "running",
        summary: "",
        resultText: "",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:05:00.000Z",
      },
      {
        taskId: "task-group-2",
        sourceHandle: "backend:coordinator",
        sourceKind: "coordinator",
        coordinatorSession: "backend:coordinator",
        workspace: "backend",
        targetAgent: "codex",
        task: "done already",
        groupId: "group-review",
        status: "completed",
        summary: "done",
        resultText: "ok",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:06:00.000Z",
      },
    ],
    groups: [
      {
        groupId: "group-review",
        coordinatorSession: "backend:coordinator",
        title: "parallel review",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:06:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/group cancel group-review");

  expect(getCancelGroupMock(orchestration).mock.calls.at(-1)?.[0]).toEqual({
    groupId: "group-review",
    coordinatorSession: "backend:coordinator",
  });
  expect(reply.text).toContain("任务组「group-review」已发起取消");
  expect(reply.text).toContain("已请求取消：1");
  expect(reply.text).toContain("已跳过终态任务：1");
});

test("rejects /group <id> for a group owned by a different coordinator", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    groups: [
      {
        groupId: "group-review",
        coordinatorSession: "backend:other-session",
        title: "owned by other",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:05:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/group group-review");

  expect(reply.text).toContain("没有找到对应任务组");
});

test("rejects /group cancel <id> for a group owned by a different coordinator", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    groups: [
      {
        groupId: "group-review",
        coordinatorSession: "backend:other-session",
        title: "owned by other",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:05:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/group cancel group-review");

  expect(reply.text).toContain("没有找到对应任务组");
});

test("suppresses streaming callbacks when reply mode is final", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config);
  const streamed: string[] = [];

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");
  await router.handle("wx:user", "/replymode final");
  await router.handle("wx:user", "check this stack trace", async (text) => {
    streamed.push(text);
  });

  expect(getPromptMock(transport).mock.calls.at(-1)?.[2]).toBeUndefined();
  expect(streamed).toEqual([]);
});

test("returns a corrective hint when no current session exists", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  const reply = await router.handle("wx:user", "check this stack trace");

  expect(reply.text).toContain("当前还没有选中的会话");
});

test("returns a clear unavailable message when orchestration is not configured", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/tasks");

  expect(reply.text).toContain("任务编排服务");
});

test("lists only tasks for the current coordinator session", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-1",
        sourceHandle: "backend:coordinator",
        sourceKind: "coordinator",
        coordinatorSession: "backend:coordinator",
        workerSession: "backend:claude:backend:coordinator",
        workspace: "backend",
        targetAgent: "claude",
        task: "审查当前方案",
        status: "running",
        summary: "",
        resultText: "",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:00:00.000Z",
      },
      {
        taskId: "task-2",
        sourceHandle: "other:coordinator",
        sourceKind: "coordinator",
        coordinatorSession: "other:coordinator",
        workerSession: "backend:codex:other:coordinator",
        workspace: "backend",
        targetAgent: "codex",
        task: "不要出现在当前列表",
        status: "running",
        summary: "",
        resultText: "",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:00:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/tasks");

  expect(getListTasksMock(orchestration).mock.calls.at(-1)?.[0]).toEqual({
    coordinatorSession: "backend:coordinator",
  });
  expect(reply.text).toContain("task-1");
  expect(reply.text).not.toContain("task-2");
});

test("shows concise reliability suffixes in the task list", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-retry-1",
        sourceHandle: "backend:coordinator",
        sourceKind: "coordinator",
        coordinatorSession: "backend:coordinator",
        workerSession: "backend:claude:backend:coordinator",
        workspace: "backend",
        targetAgent: "claude",
        task: "审查当前方案",
        status: "running",
        summary: "",
        resultText: "",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:00:00.000Z",
        noticePending: true,
        injectionPending: true,
        cancelRequestedAt: "2026-04-13T10:01:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/tasks");

  expect(reply.text).toContain("通知待重试");
  expect(reply.text).toContain("注入待重试");
  expect(reply.text).toContain("取消中");
});

test("shows needs_confirmation task summary to the coordinator even when created by a worker", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-worker-1",
        sourceHandle: "backend:claude:backend:coordinator",
        sourceKind: "worker",
        coordinatorSession: "backend:coordinator",
        workerSession: "backend:codex:reviewer:backend:coordinator",
        workspace: "backend",
        targetAgent: "codex",
        role: "reviewer",
        task: "继续处理后续任务",
        status: "needs_confirmation",
        summary: "",
        resultText: "",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:00:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/task task-worker-1");

  expect(reply.text).toContain("task-worker-1");
  expect(reply.text).toContain("needs_confirmation");
  expect(reply.text).toContain("来源：worker / backend:claude:backend:coordinator");
  expect(reply.text).toContain("角色：reviewer");
  expect(reply.text).toContain("目标 Agent：codex");
});

test("shows source metadata for needs_confirmation tasks in the coordinator task list", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-worker-2",
        sourceHandle: "backend:claude:backend:coordinator",
        sourceKind: "worker",
        coordinatorSession: "backend:coordinator",
        workerSession: "backend:codex:reviewer:backend:coordinator",
        workspace: "backend",
        targetAgent: "codex",
        role: "reviewer",
        task: "继续处理后续任务",
        status: "needs_confirmation",
        summary: "waiting for approval",
        resultText: "",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:00:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/tasks");

  expect(reply.text).toContain("task-worker-2");
  expect(reply.text).toContain("needs_confirmation");
  expect(reply.text).toContain("来源：worker / backend:claude:backend:coordinator");
  expect(reply.text).toContain("reviewer");
  expect(reply.text).toContain("waiting for approval");
});

test("approves a needs_confirmation task through the current coordinator session", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-approve-1",
        sourceHandle: "backend:worker:backend:coordinator",
        sourceKind: "worker",
        coordinatorSession: "backend:coordinator",
        workspace: "backend",
        targetAgent: "claude",
        task: "审查当前方案",
        status: "needs_confirmation",
        summary: "",
        resultText: "",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:00:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/task approve task-approve-1");

  expect(getApproveTaskMock(orchestration).mock.calls.at(-1)?.[0]).toEqual({
    taskId: "task-approve-1",
    coordinatorSession: "backend:coordinator",
  });
  expect(reply.text).toContain("已批准任务");
  expect(reply.text).toContain("task-approve-1");
  expect(reply.text).toContain("running");
});

test("returns a stable hint when approving a non-confirmation task", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-running-1",
        sourceHandle: "backend:coordinator",
        sourceKind: "coordinator",
        coordinatorSession: "backend:coordinator",
        workerSession: "backend:claude:backend:coordinator",
        workspace: "backend",
        targetAgent: "claude",
        task: "审查当前方案",
        status: "running",
        summary: "",
        resultText: "",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:00:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/task approve task-running-1");

  expect(getApproveTaskMock(orchestration).mock.calls).toHaveLength(0);
  expect(reply.text).toContain("不是待确认状态");
});

test("rejects a needs_confirmation task through the current coordinator session", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-reject-1",
        sourceHandle: "backend:worker:backend:coordinator",
        sourceKind: "worker",
        coordinatorSession: "backend:coordinator",
        workspace: "backend",
        targetAgent: "claude",
        task: "审查当前方案",
        status: "needs_confirmation",
        summary: "",
        resultText: "",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:00:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/task reject task-reject-1");

  expect(getDirectCancelTaskMock(orchestration).mock.calls.at(-1)?.[0]).toMatchObject({
    taskId: "task-reject-1",
    coordinatorSession: "backend:coordinator",
  });
  expect(reply.text).toContain("task-reject-1");
  expect(reply.text).toContain("已拒绝");
  expect(reply.text).toContain("cancelled");
});

test("returns a stable hint when rejecting a non-confirmation task", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-running-2",
        sourceHandle: "backend:coordinator",
        sourceKind: "coordinator",
        coordinatorSession: "backend:coordinator",
        workerSession: "backend:claude:backend:coordinator",
        workspace: "backend",
        targetAgent: "claude",
        task: "审查当前方案",
        status: "completed",
        summary: "done",
        resultText: "ok",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:05:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/task reject task-running-2");

  expect(getDirectCancelTaskMock(orchestration).mock.calls).toHaveLength(0);
  expect(reply.text).toContain("不是待确认状态");
});

test("shows a concise task summary for the current coordinator session", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-1",
        sourceHandle: "backend:coordinator",
        sourceKind: "coordinator",
        coordinatorSession: "backend:coordinator",
        workerSession: "backend:claude:backend:coordinator",
        workspace: "backend",
        targetAgent: "claude",
        task: "审查当前方案",
        status: "running",
        summary: "正在审查",
        resultText: "",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:00:00.000Z",
        cancelRequestedAt: "2026-04-13T10:01:00.000Z",
        cancelCompletedAt: "2026-04-13T10:02:00.000Z",
        lastCancelError: "cancel failed once",
        noticePending: true,
        noticeSentAt: "2026-04-13T10:03:00.000Z",
        lastNoticeError: "notice failed once",
        injectionPending: true,
        injectionAppliedAt: "2026-04-13T10:04:00.000Z",
        lastInjectionError: "prompt failed once",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/task task-1");

  expect(getGetTaskMock(orchestration).mock.calls.at(-1)?.[0]).toBe("task-1");
  expect(reply.text).toContain("task-1");
  expect(reply.text).toContain("running");
  expect(reply.text).toContain("正在审查");
  expect(reply.text).toContain("时间线：");
  expect(reply.text).toContain("cancel_requested");
  expect(reply.text).toContain("cancel_failed");
  expect(reply.text).toContain("notice_sent");
  expect(reply.text).toContain("notice_failed");
  expect(reply.text).toContain("injection_applied");
  expect(reply.text).toContain("injection_failed");
});

test("cancels a task for the current coordinator session", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-1",
        sourceHandle: "backend:coordinator",
        sourceKind: "coordinator",
        coordinatorSession: "backend:coordinator",
        workerSession: "backend:claude:backend:coordinator",
        workspace: "backend",
        targetAgent: "claude",
        task: "审查当前方案",
        status: "running",
        summary: "",
        resultText: "",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:00:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/task cancel task-1");

  expect(getCancelTaskMock(orchestration).mock.calls.at(-1)?.[0]).toEqual({
    taskId: "task-1",
    coordinatorSession: "backend:coordinator",
  });
  expect(reply.text).toContain("task-1");
  expect(reply.text).toContain("已请求取消");
});

test("allows the coordinator to cancel a worker-originated task in the same orchestration line", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-worker-cancel-1",
        sourceHandle: "backend:claude:backend:coordinator",
        sourceKind: "worker",
        coordinatorSession: "backend:coordinator",
        workspace: "backend",
        targetAgent: "codex",
        task: "继续处理后续任务",
        status: "needs_confirmation",
        summary: "",
        resultText: "",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:00:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/task cancel task-worker-cancel-1");

  expect(getCancelTaskMock(orchestration).mock.calls.at(-1)?.[0]).toEqual({
    taskId: "task-worker-cancel-1",
    coordinatorSession: "backend:coordinator",
  });
  expect(reply.text).toContain("task-worker-cancel-1");
  expect(reply.text).toContain("cancelled");
});

test("returns an accurate message when cancelling a completed task", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-completed-1",
        sourceHandle: "backend:coordinator",
        sourceKind: "coordinator",
        coordinatorSession: "backend:coordinator",
        workerSession: "backend:claude:backend:coordinator",
        workspace: "backend",
        targetAgent: "claude",
        task: "审查当前方案",
        status: "completed",
        summary: "done",
        resultText: "ok",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:05:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/task cancel task-completed-1");

  expect(reply.text).toContain("任务「task-completed-1」已结束");
  expect(reply.text).toContain("completed");
});

test("returns an accurate message when cancelling an already-cancelled task", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-cancelled-1",
        sourceHandle: "backend:coordinator",
        sourceKind: "coordinator",
        coordinatorSession: "backend:coordinator",
        workerSession: "backend:claude:backend:coordinator",
        workspace: "backend",
        targetAgent: "claude",
        task: "审查当前方案",
        status: "cancelled",
        summary: "",
        resultText: "",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:05:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/task cancel task-cancelled-1");

  expect(reply.text).toContain("任务「task-cancelled-1」已结束");
  expect(reply.text).toContain("cancelled");
});

test("refuses to cancel a task owned by a different coordinator session", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-1",
        sourceHandle: "other:worker",
        sourceKind: "worker",
        coordinatorSession: "backend:other",
        workerSession: "backend:claude:backend:coordinator",
        workspace: "backend",
        targetAgent: "claude",
        task: "审查当前方案",
        status: "running",
        summary: "",
        resultText: "",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:00:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/task cancel task-1");

  expect(reply.text).toContain("没有找到对应任务");
});

test("cancels the current session", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/cancel");

  expect(reply.text).toContain("cancelled");
});

test("retries cancel after recovering a missing transport session", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const resolveSessionAgentCommand = mock<SessionAgentCommandResolver>()
    .mockImplementationOnce(async () => undefined)
    .mockImplementationOnce(async () => "npx @zed-industries/codex-acp@^0.9.5");
  const cancelMock = getCancelMock(transport);
  cancelMock
    .mockImplementationOnce(async () => {
      throw new Error("No acpx session found");
    })
    .mockImplementationOnce(async () => ({
      cancelled: true,
      message: "cancelled after recovery",
    }));
  const router = new CommandRouter(sessions, transport, undefined, undefined, undefined, resolveSessionAgentCommand);

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");
  const current = await sessions.getCurrentSession("wx:user");
  const reply = await router.handle("wx:user", "/cancel");

  expect(reply.text).toContain("cancelled after recovery");
  expect(cancelMock.mock.calls).toHaveLength(2);
  expect(cancelMock.mock.calls.at(-1)?.[0]).toMatchObject({
    alias: "api-fix",
    transportSession: current?.transportSession,
    agentCommand: "npx @zed-industries/codex-acp@^0.9.5",
  });
});

test("treats stop as cancel", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/stop");

  expect(reply.text).toContain("cancelled");
});

test("resets the current session by recreating its transport session", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");
  const beforeReset = await sessions.getCurrentSession("wx:user");
  const reply = await router.handle("wx:user", "/session reset");
  const afterReset = await sessions.getCurrentSession("wx:user");

  expect(reply.text).toBe('会话「api-fix」已重置');
  expect(beforeReset).toMatchObject({
    alias: "api-fix",
  });
  expect(beforeReset?.transportSession).toMatch(/^backend:api-fix:reset-\d+$/);
  expect(afterReset).toMatchObject({
    alias: "api-fix",
    agent: "codex",
    workspace: "backend",
  });
  expect(afterReset?.transportSession).not.toBe(beforeReset?.transportSession);
  expect(afterReset?.transportSession).toMatch(/^backend:api-fix:reset-\d+$/);
  expect((transport.ensureSession as ReturnType<typeof mock>).mock.calls.at(-1)?.[0]).toMatchObject({
    alias: "api-fix",
    agent: "codex",
    workspace: "backend",
  });
  expect((transport.ensureSession as ReturnType<typeof mock>).mock.calls.at(-1)?.[0].transportSession).toBe(
    afterReset?.transportSession,
  );
});

test("removes a session and clears its chat context", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config);

  await router.handle("wx:user", "/session new main --agent codex --ws backend");
  await router.handle("wx:user", "/session new other --agent codex --ws backend");
  await router.handle("wx:user", "/use other");

  const reply = await router.handle("wx:user", "/session rm main");

  expect(reply.text).toContain("已删除会话「main」");
  const statusReply = await router.handle("wx:user", "/status");
  expect(statusReply.text).toContain("other");
});

test("removing the current session names the promoted previous session in the reply", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config);

  await router.handle("wx:user", "/session new main --agent codex --ws backend");
  await router.handle("wx:user", "/session new other --agent codex --ws backend");

  // current=other, previous=main → removing "other" promotes "main".
  const reply = await router.handle("wx:user", "/session rm other");

  expect(reply.text).toContain("已删除会话「other」");
  // The next plain message routes to the promoted session — the reply must say
  // so instead of claiming the chat context was cleared.
  expect(reply.text).toContain("已切换回上一个会话「main」");
  expect(reply.text).not.toContain("已自动清除");
  const statusReply = await router.handle("wx:user", "/status");
  expect(statusReply.text).toContain("main");
});

test("removing the current session without a previous one still reports a cleared context", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config);

  await router.handle("wx:user", "/session new main --agent codex --ws backend");
  const current = await sessions.getCurrentSession("wx:user");
  const reply = await router.handle("wx:user", "/session rm main");

  expect(reply.text).toContain("已删除会话「main」");
  expect(reply.text).toContain("已自动清除相关聊天上下文");
  expect(reply.text).not.toContain("已切换回上一个会话");
});

test("tears down the transport session when removing a logical session", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config);

  await router.handle("wx:user", "/session new main --agent codex --ws backend");
  const current = await sessions.getCurrentSession("wx:user");
  const reply = await router.handle("wx:user", "/session rm main");

  expect(reply.text).toContain("已删除会话「main」");
  const deleteMock = getDeleteSessionMock(transport);
  expect(deleteMock.mock.calls).toHaveLength(1);
  expect(deleteMock.mock.calls[0]?.[0]).toMatchObject({
    alias: "main",
    transportSession: current?.transportSession,
  });
  expect(reply.text).not.toContain("后端会话未能自动关闭");
});

test("still removes the logical session and warns when transport teardown fails", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  getDeleteSessionMock(transport).mockImplementationOnce(async () => {
    throw new Error("backend unreachable");
  });
  const router = new CommandRouter(sessions, transport, config);

  await router.handle("wx:user", "/session new main --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/session rm main");

  expect(reply.text).toContain("已删除会话「main」");
  expect(reply.text).toContain("后端会话未能自动关闭");
  expect(reply.text).toContain("backend unreachable");
  expect(await sessions.getSession("main")).toBeNull();
});

test("skips transport teardown when another logical session shares the same transport session", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config);

  await router.handle("wx:user", "/session attach main --agent codex --ws backend --name backend:shared");
  await router.handle("wx:user", "/session attach mirror --agent codex --ws backend --name backend:shared");

  const reply = await router.handle("wx:user", "/session rm main");

  expect(reply.text).toContain("已删除会话「main」");
  expect(reply.text).toContain("仍被其他 1 个会话引用，未关闭");
  expect(getDeleteSessionMock(transport).mock.calls).toHaveLength(0);
  expect(await sessions.getSession("mirror")).not.toBeNull();
});

test("still tears down transport after the last shared alias is removed", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config);

  await router.handle("wx:user", "/session attach main --agent codex --ws backend --name backend:shared");
  await router.handle("wx:user", "/session attach mirror --agent codex --ws backend --name backend:shared");
  await router.handle("wx:user", "/session rm main");
  const reply = await router.handle("wx:user", "/session rm mirror");

  expect(reply.text).toContain("已删除会话「mirror」");
  expect(reply.text).not.toContain("仍被其他");
  expect(getDeleteSessionMock(transport).mock.calls).toHaveLength(1);
  expect(getDeleteSessionMock(transport).mock.calls[0]?.[0]).toMatchObject({
    alias: "mirror",
    transportSession: "backend:shared",
  });
});

test("still removes the logical session and warns when orchestration purge fails", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService();
  orchestration.purgeSessionReferences.mockImplementationOnce(async () => {
    throw new Error("state store offline");
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new main --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/session rm main");

  expect(reply.text).toContain("已删除会话「main」");
  expect(reply.text).toContain("清理任务编排引用失败");
  expect(reply.text).toContain("state store offline");
  expect(await sessions.getSession("main")).toBeNull();
  expect(getDeleteSessionMock(transport).mock.calls).toHaveLength(1);
});

test("refuses to remove a session that has active orchestration tasks", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-running-1",
        sourceHandle: "backend:coordinator",
        sourceKind: "coordinator",
        coordinatorSession: "backend:main",
        workerSession: "backend:claude:backend:main",
        workspace: "backend",
        targetAgent: "claude",
        task: "active work",
        status: "running",
        summary: "",
        resultText: "",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:00:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new main --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/session rm main");

  expect(reply.text).toContain("未结束的任务");
  expect(await sessions.getSession("main")).not.toBeNull();
});

test("returns not-found message when removing a non-existent session", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config);

  const reply = await router.handle("wx:user", "/session rm nope");

  expect(reply.text).toContain("不存在");
});

test("refuses to remove a session that is a worker of a non-terminal task", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-worker-running",
        sourceHandle: "wx:user",
        sourceKind: "human",
        coordinatorSession: "backend:other",
        workerSession: "backend:main",
        workspace: "backend",
        targetAgent: "claude",
        task: "work",
        status: "running",
        summary: "",
        resultText: "",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:00:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new main --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/session rm main");

  expect(reply.text).toContain("未结束的任务");
  expect(await sessions.getSession("main")).not.toBeNull();
});

test("removes a session and purges orchestration references", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-done",
        sourceHandle: "wx:user",
        sourceKind: "human",
        coordinatorSession: "backend:main",
        workerSession: "backend:claude:backend:main",
        workspace: "backend",
        targetAgent: "claude",
        task: "review",
        status: "completed",
        summary: "done",
        resultText: "ok",
        createdAt: "2026-04-13T09:00:00.000Z",
        updatedAt: "2026-04-13T09:05:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new main --agent codex --ws backend");
  const current = await sessions.getCurrentSession("wx:user");
  const reply = await router.handle("wx:user", "/session rm main");

  expect(reply.text).toContain("已删除会话「main」");
  expect(orchestration.purgeSessionReferences.mock.calls.at(-1)?.[0]).toBe(current?.transportSession);
  expect(await orchestration.getTask("task-done")).toBeNull();
});

test("treats clear as a reset alias", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/clear");

  expect(reply.text).toBe('会话「api-fix」已重置');
});

test("returns a corrective hint when resetting without a current session", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  const reply = await router.handle("wx:user", "/session reset");

  expect(reply.text).toContain("当前还没有选中的会话");
});

test("routes prompts and cancel to the currently selected session after switching", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");
  await router.handle("wx:user", "/session new infra-fix --agent codex --ws backend");
  const apiFix = await sessions.getSession("api-fix");
  const infraFix = await sessions.getSession("infra-fix");
  await router.handle("wx:user", "/use api-fix");
  await router.handle("wx:user", "check logs");
  await router.handle("wx:user", "/use infra-fix");
  await router.handle("wx:user", "/cancel");

  expect(getPromptMock(transport).mock.calls.at(-1)?.[0]).toMatchObject({
    alias: "api-fix",
    transportSession: apiFix?.transportSession,
  });
  expect(getCancelMock(transport).mock.calls.at(-1)?.[0]).toMatchObject({
    alias: "infra-fix",
    transportSession: infraFix?.transportSession,
  });
});

test("cleans terminal tasks for the current coordinator session", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    tasks: [
      {
        taskId: "task-done-1",
        sourceHandle: "backend:coordinator",
        sourceKind: "coordinator",
        coordinatorSession: "backend:coordinator",
        workerSession: "backend:claude:backend:coordinator",
        workspace: "backend",
        targetAgent: "claude",
        task: "review",
        status: "completed",
        summary: "done",
        resultText: "ok",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:05:00.000Z",
      },
      {
        taskId: "task-active-1",
        sourceHandle: "backend:coordinator",
        sourceKind: "coordinator",
        coordinatorSession: "backend:coordinator",
        workerSession: "backend:claude:backend:coordinator",
        workspace: "backend",
        targetAgent: "claude",
        task: "deploy",
        status: "running",
        summary: "",
        resultText: "",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:07:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/tasks clean");

  expect(reply.text).toContain("已清理 1 个已结束的任务");

  const tasksReply = await router.handle("wx:user", "/tasks");
  expect(tasksReply.text).toContain("task-active-1");
  expect(tasksReply.text).not.toContain("task-done-1");
});

test("/group add delegates through requestDelegate with the bound groupId", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    taskId: "task-group-add-1",
    groups: [
      {
        groupId: "group-review",
        coordinatorSession: "backend:coordinator",
        title: "parallel review",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:05:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const current = await sessions.getCurrentSession("wx:user");
  const reply = await router.handle(
    "wx:user",
    "/group add group-review claude --role reviewer 审查当前方案",
    undefined,
    "ctx-123",
    "acc-1",
  );

  expect(reply.text).toContain("task-group-add-1");
  expect(getRequestDelegateMock(orchestration).mock.calls.at(-1)?.[0]).toEqual({
    sourceHandle: current?.transportSession,
    sourceKind: "coordinator",
    coordinatorSession: "backend:coordinator",
    workspace: "backend",
    targetAgent: "claude",
    role: "reviewer",
    groupId: "group-review",
    task: "审查当前方案",
    chatKey: "wx:user",
    replyContextToken: "ctx-123",
    accountId: "acc-1",
  });
});

test("/group add rejects when the group is owned by another coordinator", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService({
    groups: [
      {
        groupId: "group-review",
        coordinatorSession: "backend:other",
        title: "owned by other",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:05:00.000Z",
      },
    ],
  });
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:user", "/session new coordinator --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/group add group-review claude 审查当前方案");

  expect(reply.text).toContain("没有找到对应任务组");
  expect(getRequestDelegateMock(orchestration).mock.calls).toHaveLength(0);
});

test("/group add rejects when no current session is selected", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService();
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  const reply = await router.handle("wx:user", "/group add group-review claude 审查当前方案");

  expect(reply.text).toContain("当前还没有选中的会话");
  expect(getRequestDelegateMock(orchestration).mock.calls).toHaveLength(0);
});

test("ownerIds: a configured group sender may run privileged commands", async () => {
  const config = createConfig();
  config.channel.ownerIds = ["wx-op"];
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config);

  const reply = await router.handle(
    "wx:group",
    "/session new api-fix --agent codex --ws backend",
    undefined,
    undefined,
    undefined,
    undefined,
    { channel: "weixin", chatType: "group", groupId: "g-1", senderId: "wx-op" },
  );

  expect(reply.text).not.toContain("仅限群创建者");
  expect(reply.text).toContain("api-fix");
});

test("ownerIds: a group sender outside the list is still denied privileged commands", async () => {
  const config = createConfig();
  config.channel.ownerIds = ["wx-op"];
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config);

  const reply = await router.handle(
    "wx:group",
    "/session new api-fix --agent codex --ws backend",
    undefined,
    undefined,
    undefined,
    undefined,
    { channel: "weixin", chatType: "group", groupId: "g-1", senderId: "wx-stranger" },
  );

  expect(reply.text).toContain("仅限群创建者");
});

test("channel turn without chatType denies privileged commands and logs a contract violation", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const events: string[] = [];
  const router = new CommandRouter(sessions, transport, config, undefined, createLogger(events));

  const reply = await router.handle(
    "wx:somewhere",
    "/clear",
    undefined,
    undefined,
    undefined,
    undefined,
    { channel: "weixin", senderId: "wx-1" },
  );

  expect(reply.text).toContain("会话类型");
  expect(events.some((line) => line.includes("channel.chat_type_missing"))).toBe(true);
  expect(events.some((line) => line.includes("command.blocked"))).toBe(true);
});

test("ownerIds: effective isOwner is recorded on the coordinator route", async () => {
  const config = createConfig();
  config.channel.ownerIds = ["wx-op"];
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService();
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:group", "/session new api-fix --agent codex --ws backend");
  await router.handle(
    "wx:group",
    "提醒我明天看 CI",
    undefined,
    undefined,
    undefined,
    undefined,
    { channel: "weixin", chatType: "group", groupId: "g-1", senderId: "wx-op" },
  );

  expect(getRecordCoordinatorRouteContextMock(orchestration).mock.calls.at(-1)?.[0]).toMatchObject({
    chatKey: "wx:group",
    chatType: "group",
    senderId: "wx-op",
    isOwner: true,
  });
});

test("ownerIds: non-listed sender records an explicit isOwner=false on the route", async () => {
  const config = createConfig();
  config.channel.ownerIds = ["wx-op"];
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService();
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:group", "/session new api-fix --agent codex --ws backend");
  await router.handle(
    "wx:group",
    "你好",
    undefined,
    undefined,
    undefined,
    undefined,
    { channel: "weixin", chatType: "group", groupId: "g-1", senderId: "wx-other" },
  );

  expect(getRecordCoordinatorRouteContextMock(orchestration).mock.calls.at(-1)?.[0]).toMatchObject({
    senderId: "wx-other",
    isOwner: false,
  });
});

test("ownerIds: scheduled dispatch turns do not clobber the route isOwner", async () => {
  const config = createConfig();
  config.channel.ownerIds = ["wx-op"];
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const orchestration = createOrchestrationService();
  const router = new CommandRouter(sessions, transport, config, undefined, undefined, undefined, orchestration);

  await router.handle("wx:group", "/session new api-fix --agent codex --ws backend");
  // Internal scheduled dispatch: channel + scheduledSessionAlias, no senderId.
  await router.handle(
    "wx:group",
    "到点了，检查 CI",
    undefined,
    undefined,
    undefined,
    undefined,
    { channel: "weixin", scheduledSessionAlias: "api-fix" },
  );

  const recorded = getRecordCoordinatorRouteContextMock(orchestration).mock.calls.at(-1)?.[0];
  expect(recorded?.isOwner).toBeUndefined();
});

test("threads onPlan through the prompt path into transport.prompt options", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  let receivedOnPlan: ((entries: Array<{ content: string; status: string }>) => void | Promise<void>) | undefined;
  transport.prompt = mock(async (_session, _text, _reply, _replyContext, options) => {
    receivedOnPlan = options?.onPlan;
    return { text: "agent done" };
  });
  const router = new CommandRouter(sessions, transport);
  const myOnPlan = mock((_entries: Array<{ content: string; status: string }>) => {});

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");
  // handle(...) positional order: reply, replyContextToken, accountId, media,
  // metadata, abortSignal, onToolEvent, onThought, perfSpan, onPlan.
  await router.handle(
    "wx:user",
    "plan this out",
    undefined, // reply
    undefined, // replyContextToken
    undefined, // accountId
    undefined, // media
    undefined, // metadata
    undefined, // abortSignal
    undefined, // onToolEvent
    undefined, // onThought
    undefined, // perfSpan
    myOnPlan, // onPlan
  );

  // The exact callback reached transport.prompt's options object...
  expect(receivedOnPlan).toBe(myOnPlan);
  // ...and invoking it propagates the plan entries end-to-end.
  await receivedOnPlan?.([{ content: "step one", status: "in_progress" }]);
  expect(myOnPlan.mock.calls.at(-1)?.[0]).toEqual([{ content: "step one", status: "in_progress" }]);
});
