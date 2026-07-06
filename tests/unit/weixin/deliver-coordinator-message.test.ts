import { expect, mock, test } from "bun:test";

import { deliverCoordinatorMessage } from "../../../src/weixin/messaging/deliver-coordinator-message";
import { QuotaDeferredError, isQuotaDeferredError } from "../../../src/weixin/messaging/quota-errors";

function createLogger() {
  return {
    debug: mock(async () => {}),
    info: mock(async () => {}),
    error: mock(async () => {}),
  };
}

test("uses only the recorded route account when accountId is present", async () => {
  const logger = createLogger();
  const sendMessage = mock(async () => ({ messageId: "msg-1" }));

  await deliverCoordinatorMessage(
    {
      coordinatorSession: "backend:main",
      chatKey: "wx:user",
      accountId: "acc-origin",
      replyContextToken: "ctx-origin",
      text: "请确认数据库方案。",
    },
    {
      listAccountIds: () => ["acc-origin", "acc-fallback"],
      resolveAccount: (accountId) => ({
        accountId,
        baseUrl: "https://example.com",
        token: accountId === "acc-origin" ? "token-origin" : "token-fallback",
      }),
      getContextToken: (accountId) => (accountId === "acc-fallback" ? "ctx-fallback" : undefined),
      sendMessage,
      logger: logger as never,
    },
  );

  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
    to: "wx:user",
    text: "请确认数据库方案。",
    opts: {
      token: "token-origin",
      contextToken: "ctx-origin",
    },
  });
});

test("throws QuotaDeferredError (not generic Error) when reserveMidSegment returns false", async () => {
  // P0-4: callers (wakeCoordinator) need to distinguish quota-deferred from
  // a real send failure so they don't markFailed an injection that should
  // simply retry next wake.
  const logger = createLogger();
  const sendMessage = mock(async () => ({ messageId: "msg-1" }));

  let captured: unknown;
  try {
    await deliverCoordinatorMessage(
      {
        coordinatorSession: "backend:main",
        chatKey: "wx:user",
        accountId: "acc-origin",
        replyContextToken: "ctx-origin",
        text: "hi",
      },
      {
        listAccountIds: () => ["acc-origin"],
        resolveAccount: (accountId) => ({
          accountId,
          baseUrl: "https://example.com",
          token: "token-origin",
        }),
        getContextToken: () => "ctx-origin",
        sendMessage,
        reserveMidSegment: () => false,
        logger: logger as never,
      },
    );
  } catch (error) {
    captured = error;
  }

  expect(captured).toBeInstanceOf(QuotaDeferredError);
  expect(isQuotaDeferredError(captured)).toBe(true);
  expect((captured as QuotaDeferredError).chatKey).toBe("wx:user");
  expect(sendMessage).not.toHaveBeenCalled();
  const deferredCall = logger.info.mock.calls.find(
    (call) => call[0] === "orchestration.coordinator_message.deferred",
  );
  expect(deferredCall).toBeDefined();
});

test("uses the persisted replyContextToken when accountId is absent but exactly one account is configured", async () => {
  const logger = createLogger();
  const sendMessage = mock(async () => ({ messageId: "msg-1" }));

  await deliverCoordinatorMessage(
    {
      coordinatorSession: "backend:main",
      chatKey: "wx:user",
      replyContextToken: "ctx-saved",
      text: "请确认数据库方案。",
    },
    {
      listAccountIds: () => ["acc-only"],
      resolveAccount: (accountId) => ({
        accountId,
        baseUrl: "https://example.com",
        token: "token-only",
      }),
      getContextToken: () => undefined,
      sendMessage,
      logger: logger as never,
    },
  );

  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
    to: "wx:user",
    text: "请确认数据库方案。",
    opts: {
      token: "token-only",
      contextToken: "ctx-saved",
    },
  });
});
