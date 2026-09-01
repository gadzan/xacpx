import { expect, test } from "bun:test";

import type { Agent, ChatResponse } from "../../../src/weixin/agent/interface";
import { executeChatTurn } from "../../../src/weixin/messaging/execute-chat-turn";

test("returns final text when the agent never uses reply", async () => {
  const agent: Agent = {
    async chat(): Promise<ChatResponse> {
      return { text: "final reply" };
    },
  };

  const segments: string[] = [];
  const result = await executeChatTurn({
    agent,
    request: {
      accountId: "acc-1",
      conversationId: "user-1",
      text: "hello",
    },
    onReplySegment: async (text) => {
      segments.push(text);
      return true;
    },
  });

  expect(segments).toEqual([]);
  expect(result).toEqual({
    text: "final reply",
    media: undefined,
    usedReply: false,
  });
});

test("returns final text alongside used reply so caller can route it through the final-message path", async () => {
  // Streaming handlers (e.g. verbose prompt) return reply()-streamed mid segments PLUS a
  // final response.text that includes overflow_summary + the agent's final message. Caller
  // (handle-weixin-message-turn) must reserveFinal + sendMessage that text, not feed it
  // back through onReplySegment which is gated by mid quota.
  const agent: Agent = {
    async chat(request): Promise<ChatResponse> {
      await request.reply?.("streamed reply");
      return { text: "final reply" };
    },
  };

  const segments: string[] = [];
  const result = await executeChatTurn({
    agent,
    request: {
      accountId: "acc-1",
      conversationId: "user-1",
      text: "hello",
    },
    onReplySegment: async (text) => {
      segments.push(text);
      return true;
    },
  });

  expect(segments).toEqual(["streamed reply"]);
  expect(result).toEqual({
    text: "final reply",
    media: undefined,
    usedReply: true,
  });
});

test("drops final text when the handler returns undefined (streaming prompt pattern)", async () => {
  const agent: Agent = {
    async chat(request): Promise<ChatResponse> {
      await request.reply?.("chunk 1");
      await request.reply?.("chunk 2");
      return { text: undefined };
    },
  };

  const segments: string[] = [];
  const result = await executeChatTurn({
    agent,
    request: {
      accountId: "acc-1",
      conversationId: "user-1",
      text: "hello",
    },
    onReplySegment: async (text) => {
      segments.push(text);
      return true;
    },
  });

  expect(segments).toEqual(["chunk 1", "chunk 2"]);
  expect(result.text).toBeUndefined();
  expect(result.usedReply).toBe(true);
});

test("does not suppress final text when reply callback declines to deliver a segment", async () => {
  const agent: Agent = {
    async chat(request): Promise<ChatResponse> {
      await request.reply?.("   ");
      return { text: "final reply" };
    },
  };

  const result = await executeChatTurn({
    agent,
    request: {
      accountId: "acc-1",
      conversationId: "user-1",
      text: "hello",
    },
    onReplySegment: async () => false,
  });

  expect(result).toEqual({
    text: "final reply",
    media: undefined,
    usedReply: false,
  });
});

test("a silent overflow response produces no final text for channel delivery", async () => {
  const agent: Agent = {
    async chat(): Promise<ChatResponse> {
      return { silent: true, text: "Reply was truncated for size — you can continue." };
    },
  };

  const segments: string[] = [];
  const result = await executeChatTurn({
    agent,
    request: {
      accountId: "acc-1",
      conversationId: "user-1",
      text: "hello",
    },
    onReplySegment: async (text) => {
      segments.push(text);
      return true;
    },
  });

  expect(segments).toEqual([]);
  expect(result.text).toBeUndefined();
  expect(result.usedReply).toBe(false);
});

test("keeps media delivery even when reply streaming already happened", async () => {
  const agent: Agent = {
    async chat(request): Promise<ChatResponse> {
      await request.reply?.("streamed reply");
      return {
        text: "caption",
        media: {
          type: "image",
          url: "/tmp/out.png",
        },
      };
    },
  };

  const result = await executeChatTurn({
    agent,
    request: {
      accountId: "acc-1",
      conversationId: "user-1",
      text: "hello",
    },
    onReplySegment: async () => true,
  });

  expect(result).toEqual({
    text: "caption",
    media: {
      type: "image",
      url: "/tmp/out.png",
    },
    usedReply: true,
  });
});
