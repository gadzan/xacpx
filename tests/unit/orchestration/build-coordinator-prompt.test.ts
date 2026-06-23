import { expect, test, beforeEach } from "bun:test";
import { setLocale, t } from "../../../src/i18n";

import { buildCoordinatorPrompt, shouldBindHumanReply } from "../../../src/orchestration/build-coordinator-prompt";

beforeEach(() => {
  setLocale("zh");
});

test("renders follow-up context for a delivered active package with unresolved tasks", async () => {
  const result = await buildCoordinatorPrompt({
    orchestration: {
      listPendingCoordinatorResults: async () => [],
      getActiveHumanQuestionPackage: async () => ({
        packageId: "package-1",
        promptText: "请确认数据库方案。",
        deliveredAt: "2026-04-13T12:00:00.000Z",
        deliveredChatKey: "wx:user-1",
        openTaskIds: ["task-1"],
        openTaskQuestions: [
          {
            taskId: "task-1",
            questionId: "question-1",
            question: "Should I keep SQLite?",
            whyBlocked: "Need the database decision",
            whatIsNeeded: "A confirmed database choice",
          },
        ],
        queuedCount: 0,
      }),
    },
    coordinatorSession: "backend:main",
    userText: "继续",
  });

  expect(result.promptText).toContain(t().coordinatorPrompt.activePackageNotClosed);
  expect(result.promptText).toContain("unresolved_tasks:");
  expect(result.promptText).toContain("task_id: task-1");
  expect(result.promptText).toContain("question_id: question-1");
  expect(result.promptText).toContain(t().coordinatorPrompt.recentHumanPackageLabel);
  expect(result.promptText).toContain("请确认数据库方案。");
  expect(result.promptText).toContain(t().coordinatorPrompt.userMessageLabel + "\n继续");
  expect(result.taskIds).toEqual([]);
  expect(result.groupIds).toEqual([]);
  expect(result.claimHumanReply).toBeUndefined();
});

test("binds human reply against the delivered message snapshot instead of newly reopened tasks", async () => {
  const result = await buildCoordinatorPrompt({
    orchestration: {
      listPendingCoordinatorResults: async () => [],
      getActiveHumanQuestionPackage: async () => ({
        packageId: "package-1",
        promptText: "请确认数据库方案。",
        awaitingReplyMessageId: "message-1",
        deliveredAt: "2026-04-13T12:00:00.000Z",
        deliveredChatKey: "wx:user-1",
        openTaskIds: ["task-1", "task-2"],
        messageTaskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
        openTaskQuestions: [
          {
            taskId: "task-1",
            questionId: "question-1",
            question: "Should I keep SQLite?",
            whyBlocked: "Need the database decision",
            whatIsNeeded: "A confirmed database choice",
          },
          {
            taskId: "task-2",
            questionId: "question-2",
            question: "Should I allow writes?",
            whyBlocked: "Need the permission decision",
            whatIsNeeded: "A confirmed permission boundary",
          },
        ],
        queuedCount: 0,
      }),
    },
    coordinatorSession: "backend:main",
    chatKey: "wx:user-1",
    accountId: "acc-1",
    replyContextToken: "ctx-1",
    userText: "用 SQLite。",
  });

  expect(result.claimHumanReply).toEqual({
    coordinatorSession: "backend:main",
    chatKey: "wx:user-1",
    packageId: "package-1",
    messageId: "message-1",
    accountId: "acc-1",
    replyContextToken: "ctx-1",
  });
  expect(result.promptText).toContain("message_snapshot_tasks:");
  expect(result.promptText).toContain("task_id: task-1");
  expect(result.promptText).toContain("question_id: question-1");
  expect(result.promptText).toContain("reopened_tasks_outside_snapshot:");
  expect(result.promptText).toContain("task_id: task-2");
  expect(result.promptText).toContain("question_id: question-2");
});

test("does not auto-bind a human reply when the same chatKey arrives through a different account or reply context", async () => {
  const result = await buildCoordinatorPrompt({
    orchestration: {
      listPendingCoordinatorResults: async () => [],
      getActiveHumanQuestionPackage: async () => ({
        packageId: "package-1",
        promptText: "请确认数据库方案。",
        awaitingReplyMessageId: "message-1",
        deliveredAt: "2026-04-13T12:00:00.000Z",
        deliveredChatKey: "wx:user-1",
        deliveryAccountId: "acc-1",
        routeReplyContextToken: "ctx-1",
        openTaskIds: ["task-1"],
        messageTaskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
        openTaskQuestions: [
          {
            taskId: "task-1",
            questionId: "question-1",
            question: "Should I keep SQLite?",
            whyBlocked: "Need the database decision",
            whatIsNeeded: "A confirmed database choice",
          },
        ],
        queuedCount: 0,
      }),
    },
    coordinatorSession: "backend:main",
    chatKey: "wx:user-1",
    accountId: "acc-2",
    replyContextToken: "ctx-2",
    userText: "用 SQLite。",
  });

  expect(result.claimHumanReply).toBeUndefined();
  expect(result.promptText).toContain(t().coordinatorPrompt.activePackageAwaitingReply);
});

test("shows reopened tasks outside the awaited snapshot while a package reply is still pending", async () => {
  const result = await buildCoordinatorPrompt({
    orchestration: {
      listPendingCoordinatorResults: async () => [],
      getActiveHumanQuestionPackage: async () => ({
        packageId: "package-1",
        promptText: "请先确认数据库方案。",
        awaitingReplyMessageId: "message-1",
        deliveredAt: "2026-04-13T12:00:00.000Z",
        deliveredChatKey: "wx:other-user",
        openTaskIds: ["task-1", "task-2"],
        messageTaskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
        openTaskQuestions: [
          {
            taskId: "task-1",
            questionId: "question-1",
            question: "Should I keep SQLite?",
            whyBlocked: "Need the database decision",
            whatIsNeeded: "A confirmed database choice",
          },
          {
            taskId: "task-2",
            questionId: "question-2",
            question: "Should I allow writes?",
            whyBlocked: "Need the permission decision",
            whatIsNeeded: "A confirmed permission boundary",
          },
        ],
        queuedCount: 0,
      }),
    },
    coordinatorSession: "backend:main",
    chatKey: "wx:user-1",
    userText: "继续",
  });

  expect(result.claimHumanReply).toBeUndefined();
  expect(result.promptText).toContain(t().coordinatorPrompt.activePackageAwaitingReply);
  expect(result.promptText).toContain("reopened_tasks_outside_snapshot:");
  expect(result.promptText).toContain("task_id: task-2");
  expect(result.promptText).toContain("question_id: question-2");
});

test("shows reopened tasks outside the snapshot when the latest package message is undelivered", async () => {
  const result = await buildCoordinatorPrompt({
    orchestration: {
      listPendingCoordinatorResults: async () => [],
      getActiveHumanQuestionPackage: async () => ({
        packageId: "package-1",
        promptText: "请先确认数据库方案。",
        openTaskIds: ["task-1", "task-2"],
        messageTaskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
        openTaskQuestions: [
          {
            taskId: "task-1",
            questionId: "question-1",
            question: "Should I keep SQLite?",
            whyBlocked: "Need the database decision",
            whatIsNeeded: "A confirmed database choice",
          },
          {
            taskId: "task-2",
            questionId: "question-2",
            question: "Should I allow writes?",
            whyBlocked: "Need the permission decision",
            whatIsNeeded: "A confirmed permission boundary",
          },
        ],
        queuedCount: 0,
      }),
    },
    coordinatorSession: "backend:main",
    userText: "继续",
  });

  expect(result.promptText).toContain(t().coordinatorPrompt.packageNotDelivered);
  expect(result.promptText).toContain("reopened_tasks_outside_snapshot:");
  expect(result.promptText).toContain("task_id: task-2");
  expect(result.promptText).toContain("question_id: question-2");
});

test("does not inject unrelated blocked tasks into a turn that is bound to an awaited human reply", async () => {
  const result = await buildCoordinatorPrompt({
    orchestration: {
      listPendingCoordinatorResults: async () => [],
      listPendingCoordinatorBlockers: async () => [
        {
          taskId: "task-blocked-1",
          sourceHandle: "backend:main",
          sourceKind: "coordinator",
          coordinatorSession: "backend:main",
          workerSession: "worker:claude:1",
          workspace: "backend",
          targetAgent: "claude",
          task: "independent blocker",
          status: "blocked",
          summary: "",
          resultText: "",
          createdAt: "2026-04-13T10:00:00.000Z",
          updatedAt: "2026-04-13T10:00:00.000Z",
          openQuestion: {
            questionId: "question-blocked-1",
            question: "Should I enable writes?",
            whyBlocked: "Need a permission decision",
            whatIsNeeded: "A confirmed permission boundary",
            askedAt: "2026-04-13T10:00:00.000Z",
            status: "open",
          },
        },
      ],
      getActiveHumanQuestionPackage: async () => ({
        packageId: "package-1",
        promptText: "请确认数据库方案。",
        awaitingReplyMessageId: "message-1",
        deliveredAt: "2026-04-13T12:00:00.000Z",
        deliveredChatKey: "wx:user-1",
        deliveryAccountId: "acc-1",
        routeReplyContextToken: "ctx-1",
        openTaskIds: ["task-1"],
        messageTaskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
        openTaskQuestions: [
          {
            taskId: "task-1",
            questionId: "question-1",
            question: "Should I keep SQLite?",
            whyBlocked: "Need the database decision",
            whatIsNeeded: "A confirmed database choice",
          },
        ],
        queuedCount: 0,
      }),
    },
    coordinatorSession: "backend:main",
    chatKey: "wx:user-1",
    accountId: "acc-1",
    replyContextToken: "ctx-1",
    userText: "继续用 SQLite。",
  });

  expect(result.promptText).toContain(t().coordinatorPrompt.humanReplyBindingHeader);
  expect(result.promptText).not.toContain("[delegate_question_package]");
  expect(result.promptText).not.toContain("task_id: task-blocked-1");
  expect(result.promptText).not.toContain("question-blocked-1");
});

test("shouldBindHumanReply returns true when all conditions match", () => {
  expect(
    shouldBindHumanReply({
      chatKey: "wx:user-1",
      accountId: "acct-1",
      replyContextToken: "token-1",
      activePackage: {
        awaitingReplyMessageId: "msg-1",
        deliveredChatKey: "wx:user-1",
        deliveryAccountId: "acct-1",
        routeReplyContextToken: "token-1",
        messageTaskQuestions: [{ taskId: "t-1", questionId: "q-1" }],
      },
    }),
  ).toBe(true);
});

test("shouldBindHumanReply returns false when chatKey missing", () => {
  expect(
    shouldBindHumanReply({
      chatKey: undefined,
      activePackage: {
        awaitingReplyMessageId: "msg-1",
        deliveredChatKey: "wx:user-1",
        messageTaskQuestions: [{ taskId: "t-1", questionId: "q-1" }],
      },
    }),
  ).toBe(false);
});

test("shouldBindHumanReply returns false when deliveredChatKey mismatches", () => {
  expect(
    shouldBindHumanReply({
      chatKey: "wx:user-2",
      activePackage: {
        awaitingReplyMessageId: "msg-1",
        deliveredChatKey: "wx:user-1",
        messageTaskQuestions: [{ taskId: "t-1", questionId: "q-1" }],
      },
    }),
  ).toBe(false);
});

test("shouldBindHumanReply returns false when snapshot is empty", () => {
  expect(
    shouldBindHumanReply({
      chatKey: "wx:user-1",
      activePackage: {
        awaitingReplyMessageId: "msg-1",
        deliveredChatKey: "wx:user-1",
        messageTaskQuestions: [],
      },
    }),
  ).toBe(false);
});

test("shouldBindHumanReply returns false when deliveryAccountId mismatches", () => {
  expect(
    shouldBindHumanReply({
      chatKey: "wx:user-1",
      accountId: "acct-2",
      activePackage: {
        awaitingReplyMessageId: "msg-1",
        deliveredChatKey: "wx:user-1",
        deliveryAccountId: "acct-1",
        messageTaskQuestions: [{ taskId: "t-1", questionId: "q-1" }],
      },
    }),
  ).toBe(false);
});

test("byte-for-byte zh prompt for the active-package-not-closed follow-up path", async () => {
  setLocale("zh");
  const result = await buildCoordinatorPrompt({
    orchestration: {
      listPendingCoordinatorResults: async () => [],
      getActiveHumanQuestionPackage: async () => ({
        packageId: "package-1",
        promptText: "请确认数据库方案。",
        deliveredAt: "2026-04-13T12:00:00.000Z",
        deliveredChatKey: "wx:user-1",
        openTaskIds: ["task-1"],
        openTaskQuestions: [
          {
            taskId: "task-1",
            questionId: "question-1",
            question: "Should I keep SQLite?",
            whyBlocked: "Need the database decision",
            whatIsNeeded: "A confirmed database choice",
          },
        ],
        queuedCount: 0,
      }),
    },
    coordinatorSession: "backend:main",
    userText: "继续",
  });

  // Hardcoded Chinese expectation reconstructed independently from the original
  // prompt text — NOT read from t(). Mirrors the worker-prompts byte tests.
  const expected =
    "当前 active human package 仍未收口，请先继续 follow-up，不要新开问题包。\n\n" +
    "unresolved_tasks:\n" +
    "- task_id: task-1\n" +
    "  question_id: question-1\n" +
    "  question: Should I keep SQLite?\n" +
    "  why_blocked: Need the database decision\n" +
    "  what_is_needed: A confirmed database choice\n\n" +
    "最近一次发给 human 的问题包：\n" +
    "请确认数据库方案。\n\n" +
    "用户最新消息：\n" +
    "继续";

  expect(result.promptText).toBe(expected);
});

test("truncates prompt when sections exceed maxPromptLength", async () => {
  const largeResultText = "x".repeat(50_000);
  const result = await buildCoordinatorPrompt({
    orchestration: {
      listPendingCoordinatorResults: async () => [
        {
          taskId: "task-1",
          sourceHandle: "wx:user",
          sourceKind: "human",
          coordinatorSession: "backend:main",
          workspace: "backend",
          targetAgent: "claude",
          task: "do something",
          status: "completed",
          summary: "done",
          resultText: largeResultText,
          createdAt: "2026-04-13T00:00:00.000Z",
          updatedAt: "2026-04-13T00:00:00.000Z",
        },
      ],
    },
    coordinatorSession: "backend:main",
    userText: "继续",
    maxPromptLength: 1000,
  });

  expect(result.promptText.length).toBeLessThanOrEqual(1000);
  expect(result.promptText).toContain("...");
});

test("sends the user's message verbatim (no label) when there is no orchestration context", async () => {
  // Regression: an ordinary session (no pending results, blockers, or active package)
  // must NOT get every message prefixed with the "user's latest message" label — that
  // label only exists to separate the message from injected orchestration context.
  const result = await buildCoordinatorPrompt({
    orchestration: {
      listPendingCoordinatorResults: async () => [],
    },
    coordinatorSession: "backend:main",
    userText: "帮我看看这个函数",
  });

  expect(result.promptText).toBe("帮我看看这个函数");
  expect(result.promptText).not.toContain(t().coordinatorPrompt.userMessageLabel);
  expect(result.taskIds).toEqual([]);
  expect(result.groupIds).toEqual([]);
});

test("still labels the user's message when pending results precede it", async () => {
  const result = await buildCoordinatorPrompt({
    orchestration: {
      listPendingCoordinatorResults: async () => [
        {
          taskId: "task-1",
          status: "succeeded",
          summary: "done",
          resultText: "result body",
          createdAt: "2026-04-13T00:00:00.000Z",
          updatedAt: "2026-04-13T00:00:00.000Z",
        },
      ],
    },
    coordinatorSession: "backend:main",
    userText: "继续",
  });

  expect(result.promptText).toContain(t().coordinatorPrompt.userMessageLabel + "\n继续");
  expect(result.taskIds).toEqual(["task-1"]);
});
