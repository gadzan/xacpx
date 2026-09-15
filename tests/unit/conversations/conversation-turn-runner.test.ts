import { expect, test } from "bun:test";

import { ControlConversationTurnRunner } from "../../../src/conversations/conversation-turn-runner";

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
