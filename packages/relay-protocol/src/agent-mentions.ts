import type { AgentCommandDto } from "./dtos.js";

export interface AgentMention {
  range: [number, number];
  handle: string;
}
export const MAX_AGENT_MENTIONS = 16;
/** UTF-16 half-open ranges, with no overlapping identity annotations. */
export function validAgentMentions(
  text: string,
  value: unknown,
): value is AgentMention[] {
  if (!Array.isArray(value) || value.length > MAX_AGENT_MENTIONS) return false;
  let end = -1;
  for (const raw of value) {
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).some((key) => key !== "range" && key !== "handle")
    )
      return false;
    const { range, handle } = raw;
    if (
      !Array.isArray(range) ||
      range.length !== 2 ||
      !range.every(Number.isSafeInteger) ||
      range[0] < 0 ||
      range[0] >= range[1] ||
      range[1] > text.length ||
      range[0] < end ||
      typeof handle !== "string" ||
      !handle ||
      handle.length > 2048 ||
      handle.includes("\0")
    )
      return false;
    end = range[1];
  }
  return true;
}
export interface ConversationCompletionsRequest {
  conversationId: string;
  topicId: string;
  query?: string;
  cursor?: number;
}
export interface ConversationCompletions {
  version: 1;
  scope: { conversationId: string; topicId: string; botId: string };
  revision: string;
  commands: {
    status: "ready" | "loading" | "unavailable" | "error";
    items: Array<Pick<AgentCommandDto, "name" | "description" | "kind">>;
    reason?: string;
  };
  mentions: {
    status: "ready" | "loading" | "unavailable" | "error";
    items: Array<{
      handle: string;
      displayName: string;
      botId?: string;
      agent: string;
      workspace?: string;
    }>;
    nextCursor?: number;
    reason?: string;
  };
}
