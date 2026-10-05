import type { ConversationTurnCorrelation } from "../control/conversation-control-dtos.js";
import type { ChatRequest } from "../weixin/agent/interface.js";

/**
 * Core-private, object-identity provenance for Conversation turns crossing the
 * generic Agent.chat seam. It is intentionally absent from ChatRequest and
 * ChatRequestMetadata, so public Control/channel/plugin callers cannot mint it
 * by supplying a field or by reusing a `bot:<conversation>:<topic>` chat key.
 */
const trustedConversationRequests = new WeakMap<ChatRequest, ConversationTurnCorrelation>();

export function markTrustedConversationAgentRequest(
  request: ChatRequest,
  correlation: ConversationTurnCorrelation,
): void {
  trustedConversationRequests.set(request, correlation);
}

/** Consume once at ConsoleAgent; cloned/replayed requests fail closed. */
export function consumeTrustedConversationAgentRequest(
  request: ChatRequest,
): ConversationTurnCorrelation | undefined {
  const correlation = trustedConversationRequests.get(request);
  trustedConversationRequests.delete(request);
  return correlation;
}
