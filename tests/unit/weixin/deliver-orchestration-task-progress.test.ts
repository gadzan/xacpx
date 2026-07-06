import { expect, mock, test } from "bun:test";
import { deliverOrchestrationTaskProgress } from "../../../src/weixin/messaging/deliver-orchestration-task-progress";

function createLogger() {
  return {
    debug: mock(async () => {}),
    info: mock(async () => {}),
    error: mock(async () => {}),
  };
}

test("sends progress message through the task's account", async () => {
  const logger = createLogger();
  const sendMessage = mock(async () => {});

  await deliverOrchestrationTaskProgress(
    {
      taskId: "task-1",
      chatKey: "wx:user",
      replyContextToken: "ctx-1",
      accountId: "acc-1",
    } as never,
    "\u23f3 \u4efb\u52a1\u300ctask-1\u300d\uff08claude\uff09\uff1aanalyzing...",
    {
      listAccountIds: () => ["acc-1"],
      resolveAccount: (id: string) => ({ accountId: id, baseUrl: "https://example.com", token: "token-1" }),
      getContextToken: () => "ctx-1",
      sendMessage,
      logger: logger as never,
    },
  );

  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
    to: "wx:user",
    text: "\u23f3 \u4efb\u52a1\u300ctask-1\u300d\uff08claude\uff09\uff1aanalyzing...",
  });
});

test("skips delivery when chat context is incomplete", async () => {
  const logger = createLogger();
  const sendMessage = mock(async () => {});

  await deliverOrchestrationTaskProgress(
    {
      taskId: "task-2",
    } as never,
    "progress text",
    {
      listAccountIds: () => ["acc-1"],
      resolveAccount: (id: string) => ({ accountId: id, baseUrl: "https://example.com", token: "token-1" }),
      getContextToken: () => "ctx-1",
      sendMessage,
      logger: logger as never,
    },
  );

  expect(sendMessage).not.toHaveBeenCalled();
});

test("skips delivery when reserveMidSegment returns false and logs deferred event", async () => {
  const logger = createLogger();
  const sendMessage = mock(async () => {});

  await deliverOrchestrationTaskProgress(
    {
      taskId: "task-quota",
      chatKey: "wx:user",
      replyContextToken: "ctx-1",
      accountId: "acc-1",
    } as never,
    "progress",
    {
      listAccountIds: () => ["acc-1"],
      resolveAccount: (id: string) => ({ accountId: id, baseUrl: "https://example.com", token: "token-1" }),
      getContextToken: () => "ctx-1",
      sendMessage,
      reserveMidSegment: () => false,
      logger: logger as never,
    },
  );

  expect(sendMessage).not.toHaveBeenCalled();
  expect(logger.info).toHaveBeenCalledTimes(1);
  expect(logger.info.mock.calls[0]?.[0]).toBe("orchestration.progress.deferred");
  expect(logger.info.mock.calls[0]?.[2]).toMatchObject({
    taskId: "task-quota",
    chatKey: "wx:user",
    reason: "quota_exhausted",
  });
});

test("tries fallback accounts on failure", async () => {
  const logger = createLogger();
  const sendMessage = mock(async ({ opts }: { opts: { token?: string } }) => {
    if (opts.token === "token-fail") {
      throw new Error("send failed");
    }
  });

  await deliverOrchestrationTaskProgress(
    {
      taskId: "task-3",
      chatKey: "wx:user",
      replyContextToken: "ctx-1",
      accountId: "acc-fail",
    } as never,
    "progress text",
    {
      listAccountIds: () => ["acc-fail", "acc-ok"],
      resolveAccount: (id: string) => ({
        accountId: id,
        baseUrl: "https://example.com",
        token: id === "acc-fail" ? "token-fail" : "token-ok",
      }),
      getContextToken: () => "ctx-1",
      sendMessage,
      logger: logger as never,
    },
  );

  expect(sendMessage).toHaveBeenCalledTimes(2);
});
