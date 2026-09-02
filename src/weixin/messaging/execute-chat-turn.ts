import type { Agent, ChatRequest, ChatResponse } from "../agent/interface.js";

export interface ExecuteChatTurnParams {
  agent: Agent;
  request: Omit<ChatRequest, "reply">;
  onReplySegment?: (text: string) => Promise<boolean | void>;
}

export interface ExecutedChatTurn {
  text?: string;
  media?: ChatResponse["media"];
  usedReply: boolean;
}

export async function executeChatTurn(params: ExecuteChatTurnParams): Promise<ExecutedChatTurn> {
  let usedReply = false;

  const response = await params.agent.chat({
    ...params.request,
    reply: async (text: string) => {
      const delivered = await params.onReplySegment?.(text);
      if (delivered !== false) {
        usedReply = true;
      }
    },
  });

  // response.text — when present alongside reply() usage — is the final message
  // (e.g. transport's `overflow_summary + agent_message` for streaming prompts,
  // or a "ready" summary after progress reply()s). Return it as turn.text so the
  // caller routes it through the final-message path (reserveFinal + sendMessage),
  // not back through onReplySegment which is gated by mid quota.
  // Streaming handlers that would otherwise duplicate content must return text: undefined.
  // Silent overflow tips must not become a channel bubble even if text is present.
  return {
    text: response.silent ? undefined : response.text,
    media: response.media,
    usedReply,
  };
}
