import { expect, test } from "bun:test";
import { ConversationBindingService } from "../../../src/conversations/conversation-bindings";
import { ConversationIngressRejection } from "../../../src/conversations/conversation-ingress-rejection";
import type { ChatRequest } from "../../../src/weixin/agent/interface";

function harness(options: { leadBotId?: string } = {}) {
  const accepted: Array<{ text: string; target?: unknown }> = [];
  const group = { id: "conversation_g", title: "Bound", botIds: ["bot_a", "bot_b"], leadBotId: options.leadBotId, workspaceMode: "per-member" };
  const store = {
    getConversationBinding: () => ({ chatKey: "discord:default:g:channel", conversationId: group.id, topicId: "topic_1" }),
    getExternalRequest: () => undefined,
    getExternalRejection: () => undefined,
    hasExternalRequest: () => false,
    hasExternalStopRequest: () => false,
  };
  const runs = {
    listTopics: () => [{ id: "topic_1", conversationId: group.id, status: "active" }],
    listGroups: () => [group],
    acceptConversationPrompt: async (input: { text: string; target?: unknown }) => {
      accepted.push({ text: input.text, target: input.target });
      return { run: { id: "run_1" }, reused: false };
    },
  };
  const bots = { getBot: (id: string) => ({ id, name: id === "bot_a" ? "Reviewer" : "Builder" }) };
  const service = new ConversationBindingService(store as never, runs as never, bots as never);
  return { service, accepted };
}

function request(text: string, id = "m1"): ChatRequest {
  return {
    accountId: "default",
    conversationId: "discord:default:g:channel",
    text,
    metadata: {
      channel: "discord",
      channelMessageId: id,
      origin: "human",
      authenticatedHuman: true,
      senderId: "human",
      chatType: "group",
    },
  };
}

test("a plain channel message carries no target, so the accept path derives the Lead in-gate", async () => {
  const { service, accepted } = harness({ leadBotId: "bot_a" });
  await service.accept("discord", request("plain group message"));
  expect(accepted).toHaveLength(1);
  // Materializing the Lead here would run a Lead that a retarget replaced
  // between this read and the accept gates.
  expect(accepted[0]!.target).toBeUndefined();
  expect(accepted[0]!.text).toBe("plain group message");
});

test("a member mention still becomes an explicit target and strips the address", async () => {
  const { service, accepted } = harness({ leadBotId: "bot_a" });
  await service.accept("discord", request("@Builder review the fix"));
  expect(accepted[0]!.target).toEqual({ botId: "bot_b" });
  expect(accepted[0]!.text).toBe("review the fix");
});
