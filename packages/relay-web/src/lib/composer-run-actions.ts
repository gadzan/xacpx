import { MSG, isErrorPayload, type ConversationHistoryResponseDto, type ConversationMessageDto, type ConversationRunDto } from "@ganglion/xacpx-relay-protocol";
import { api } from "../api/client";

export function mergeRecoveredDraft(current: string, recovered: string): string {
  if (!recovered.trim() || current === recovered) return current;
  return current.trim() ? `${current}\n\n${recovered}` : recovered;
}

export async function sourceRunPrompt(instanceId: string, run: ConversationRunDto, messages: readonly ConversationMessageDto[]): Promise<string | null> {
  const matches = (message: ConversationMessageDto) => message.id === run.requestMessageId
    && message.conversationId === run.conversationId && message.topicId === run.topicId && message.role === "human";
  const local = messages.find(matches);
  if (local) return local.content;
  if (!run.requestMessageId) return null;
  let beforeSeq: number | undefined;
  for (;;) {
    const result = await api.rpc<ConversationHistoryResponseDto>(instanceId, MSG.conversationHistory, {
      conversationId: run.conversationId, topicId: run.topicId, limit: 50,
      direction: "newest-first", ...(beforeSeq !== undefined ? { beforeSeq } : {}),
    });
    if (isErrorPayload(result)) return null;
    const found = result.messages.find(matches);
    if (found) return found.content;
    const oldest = result.oldestSeq ?? Math.min(...result.messages.map(message => message.seq));
    if (!result.hasMoreBefore || !Number.isFinite(oldest) || (beforeSeq !== undefined && oldest >= beforeSeq)) return null;
    beforeSeq = oldest;
  }
}
