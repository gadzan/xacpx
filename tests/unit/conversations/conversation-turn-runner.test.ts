import { expect, test } from "bun:test";

import { ControlConversationTurnRunner } from "../../../src/conversations/conversation-turn-runner";
import { TurnQueue } from "../../../src/control/turn-queue";
import { ControlService } from "../../../src/control/control-service";
import { createControlEventBus } from "../../../src/control/control-event-bus";
import { directConversationChatKey } from "../../../src/domain/ids";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function fakeControl() {
  const hang = deferred();
  const aborted = new Set<string>();
  let promptImpl: (input: { promptRequestId?: string }) => Promise<{ ok: boolean; text?: string; errorMessage?: string }> = async () => (
    { ok: true, text: "done" }
  );
  return {
    hang,
    aborted,
    promptCalls: [] as Array<{ promptRequestId?: string }>,
    cancelLane: 0,
    cancelByRequest: [] as string[],
    queuedCancels: 0,
    setPrompt(impl: typeof promptImpl) {
      promptImpl = impl;
    },
    async prompt(input: { promptRequestId?: string; text: string }) {
      this.promptCalls.push({ promptRequestId: input.promptRequestId });
      return await promptImpl(input);
    },
    async promptImmediate(input: { promptRequestId?: string; text: string }) {
      return await this.prompt(input);
    },
    cancelTurn() {
      this.cancelLane += 1;
      return true;
    },
    cancelTurnForPromptRequest(_chat: string, _alias: string, promptRequestId: string) {
      this.cancelByRequest.push(promptRequestId);
      this.aborted.add(promptRequestId);
      this.hang.resolve();
      return true;
    },
    cancelQueuedItem() {
      this.queuedCancels += 1;
      return { cancelled: true };
    },
  };
}

const input = {
  conversationId: "conv",
  topicId: "topic",
  botId: "bot_reviewer",
  sessionAlias: "alias",
  logicalSessionId: "11111111-1111-4111-8111-111111111111",
  text: "hello",
  origin: "human" as const,
  promptRequestId: "sturn_1",
};

test("cancel after a proven completion reports completed, not cancelled", async () => {
  const control = fakeControl();
  const runner = new ControlConversationTurnRunner(control);
  const result = await runner.run(input);
  expect(result.status).toBe("completed");
  const cancel = await runner.cancel({
    conversationId: input.conversationId,
    topicId: input.topicId,
    sessionAlias: input.sessionAlias,
    promptRequestId: input.promptRequestId,
  });
  expect(cancel).toEqual({ outcome: "completed", text: "done" });
  expect(control.cancelLane).toBe(0);
  expect(control.cancelByRequest).toEqual([]);
});

test("in-flight cancel uses the request-id seam and waits for settlement", async () => {
  const control = fakeControl();
  control.setPrompt(async (promptInput) => {
    await control.hang.promise;
    if (control.aborted.has(promptInput.promptRequestId ?? "")) {
      return { ok: false, errorMessage: "cancelled by user" };
    }
    return { ok: true, text: "done" };
  });
  const runner = new ControlConversationTurnRunner(control);
  const running = runner.run(input);
  await Promise.resolve();
  const cancel = runner.cancel({
    conversationId: input.conversationId,
    topicId: input.topicId,
    sessionAlias: input.sessionAlias,
    promptRequestId: input.promptRequestId,
  });
  expect(await cancel).toEqual({ outcome: "cancelled" });
  expect(await running).toMatchObject({ status: "cancelled" });
  expect(control.cancelLane).toBe(0);
  expect(control.cancelByRequest).toEqual(["sturn_1"]);
});

test("settled execution cache keeps late cancel completed until TTL/max eviction", async () => {
  let now = 1_000;
  const control = fakeControl();
  const runner = new ControlConversationTurnRunner(control, {
    settledMax: 2,
    settledTtlMs: 1_000,
    now: () => now,
  });
  const first = { ...input, promptRequestId: "sturn_keep" };
  const second = { ...input, promptRequestId: "sturn_second" };
  const third = { ...input, promptRequestId: "sturn_third" };
  expect((await runner.run(first)).status).toBe("completed");
  expect(await runner.cancel({
    conversationId: first.conversationId,
    topicId: first.topicId,
    sessionAlias: first.sessionAlias,
    promptRequestId: first.promptRequestId,
  })).toEqual({ outcome: "completed", text: "done" });
  await runner.run(second);
  await runner.run(third);
  expect(await runner.cancel({
    conversationId: first.conversationId,
    topicId: first.topicId,
    sessionAlias: first.sessionAlias,
    promptRequestId: first.promptRequestId,
  })).toEqual({ outcome: "unknown" });
  expect(await runner.cancel({
    conversationId: third.conversationId,
    topicId: third.topicId,
    sessionAlias: third.sessionAlias,
    promptRequestId: third.promptRequestId,
  })).toEqual({ outcome: "completed", text: "done" });
  now += 2_000;
  expect(await runner.cancel({
    conversationId: third.conversationId,
    topicId: third.topicId,
    sessionAlias: third.sessionAlias,
    promptRequestId: third.promptRequestId,
  })).toEqual({ outcome: "unknown" });
});

test("Conversation promptImmediate never FIFO-enqueues on a busy session lane", async () => {
  const started: string[] = [];
  const origins: string[] = [];
  const pending: Array<(result: { ok: boolean }) => void> = [];
  const lane = "alias";
  const queue = new TurnQueue({
    runTurn: (req) => {
      started.push(req.text);
      origins.push(req.turnOrigin);
      return new Promise((resolve) => {
        pending.push(resolve);
      });
    },
    emitQueueUpdated: () => {},
    detectSessionsChanged: async () => {},
  });
  const occupancy = queue.submit({
    chatKey: "bot:conv:topic",
    sessionAlias: lane,
    concurrencyKey: lane,
    senderId: "user",
    text: "predecessor",
    turnOrigin: "human",
    queueable: true,
  });
  await Promise.resolve();
  expect(started).toEqual(["predecessor"]);
  expect(origins).toEqual(["human"]);
  expect(queue.queueLength("bot:conv:topic", lane, lane)).toBe(0);

  const control = {
    async promptImmediate(promptInput: {
      chatKey: string;
      sessionAlias: string;
      text: string;
      senderId: string;
      promptRequestId?: string;
    }) {
      return await queue.submit({
        chatKey: promptInput.chatKey,
        sessionAlias: promptInput.sessionAlias,
        concurrencyKey: lane,
        text: promptInput.text,
        senderId: promptInput.senderId,
        turnOrigin: "human" as const,
        queueable: false,
        ...(promptInput.promptRequestId !== undefined
          ? { promptRequestId: promptInput.promptRequestId }
          : {}),
      });
    },
    cancelTurnForPromptRequest() {
      return true;
    },
    cancelQueuedItem() {
      return { cancelled: true };
    },
  };
  const runner = new ControlConversationTurnRunner(control);
  const conversation = await runner.run({
    ...input,
    conversationId: "conv",
    topicId: "topic",
    sessionAlias: lane,
    text: "conversation-turn",
    origin: "human",
    promptRequestId: "sturn_conversation",
  });
  expect(conversation).toMatchObject({ status: "failed", error: "turn-already-running" });
  expect(queue.queueLength("bot:conv:topic", lane, lane)).toBe(0);
  expect(started).toEqual(["predecessor"]);
  pending.shift()?.({ ok: true });
  await occupancy;
  await Promise.resolve();
  expect(started).toEqual(["predecessor"]);
  expect(origins).toEqual(["human"]);
  expect(queue.queueLength("bot:conv:topic", lane, lane)).toBe(0);
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeControlWithConfigTail() {
  const configTail = deferred();
  let chatCount = 0;
  let configTailHeld = false;
  const events = createControlEventBus();
  const session = { alias: "alias", agent: "claude", workspace: "/ws" };
  const control = new ControlService({
    agent: {
      chat: async () => {
        chatCount += 1;
        return { text: "done" };
      },
    },
    sessions: {
      listAllResolvedSessions: () => [],
      createSession: async () => {
        throw new Error("unused");
      },
      removeSession: async () => ({ wasActive: false }),
      useSession: async () => session,
      resolveAliasForChat: async (_chatKey: string, alias: string) => alias,
      getSession: async (internalAlias: string) =>
        internalAlias === "alias" ? session : null,
      getResolvedSessionByInternalAlias: (alias: string) =>
        alias === "alias" ? session : undefined,
      setSessionModel: async () => {},
    },
    transport: {
      setModel: async () => {
        configTailHeld = true;
        await configTail.promise;
      },
    },
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: {} as never,
    orchestration: {} as never,
    events,
  } as never);
  return {
    control,
    configTail,
    chatCount: () => chatCount,
    isConfigTailHeld: () => configTailHeld,
  };
}

async function waitUntil(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil timed out");
    }
    await tick();
  }
}

test("cancel during config-tail wait never admits the Conversation turn", async () => {
  const { control, configTail, chatCount, isConfigTailHeld } = makeControlWithConfigTail();
  const chatKey = directConversationChatKey(input.conversationId, input.topicId);
  const modelSet = control.setSessionModel(chatKey, input.sessionAlias, "gpt-x");
  await waitUntil(isConfigTailHeld);
  const runner = new ControlConversationTurnRunner(control);
  const running = runner.run(input);
  await waitUntil(() => runner.hasTrackedExecution(input.promptRequestId));
  expect(control.inspectPromptRequest(chatKey, input.sessionAlias, input.promptRequestId)).toBe("absent");
  expect(control.isBusy(chatKey, input.sessionAlias)).toBe(false);
  expect(control.queueLength(chatKey, input.sessionAlias)).toBe(0);
  expect(chatCount()).toBe(0);

  const cancelling = runner.cancel({
    conversationId: input.conversationId,
    topicId: input.topicId,
    sessionAlias: input.sessionAlias,
    promptRequestId: input.promptRequestId,
  });
  configTail.resolve();
  await modelSet;
  expect(await running).toMatchObject({ status: "cancelled" });
  expect(await cancelling).toEqual({ outcome: "cancelled" });
  expect(chatCount()).toBe(0);
  expect(control.queueLength(chatKey, input.sessionAlias)).toBe(0);
  expect(control.isBusy(chatKey, input.sessionAlias)).toBe(false);
  expect(control.inspectPromptRequest(chatKey, input.sessionAlias, input.promptRequestId)).toBe("absent");
});

test("a non-cancelled config-tail wait still submits exactly once after the tail settles", async () => {
  const { control, configTail, chatCount, isConfigTailHeld } = makeControlWithConfigTail();
  const chatKey = directConversationChatKey(input.conversationId, input.topicId);
  const modelSet = control.setSessionModel(chatKey, input.sessionAlias, "gpt-x");
  await waitUntil(isConfigTailHeld);
  const runner = new ControlConversationTurnRunner(control);
  const running = runner.run(input);
  await waitUntil(() => runner.hasTrackedExecution(input.promptRequestId));
  expect(control.inspectPromptRequest(chatKey, input.sessionAlias, input.promptRequestId)).toBe("absent");
  expect(chatCount()).toBe(0);
  configTail.resolve();
  await modelSet;
  expect(await running).toMatchObject({ status: "completed", text: "done" });
  expect(chatCount()).toBe(1);
  expect(control.queueLength(chatKey, input.sessionAlias)).toBe(0);
});
