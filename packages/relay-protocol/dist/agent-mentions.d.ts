import type { AgentCommandDto } from "./dtos.js";
export interface AgentMention {
    range: [number, number];
    handle: string;
}
export declare const MAX_AGENT_MENTIONS = 16;
/** UTF-16 half-open ranges, with no overlapping identity annotations. */
export declare function validAgentMentions(text: string, value: unknown): value is AgentMention[];
export interface ConversationCompletionsRequest {
    conversationId: string;
    topicId: string;
    query?: string;
    cursor?: number;
}
export interface ConversationCompletions {
    version: 1;
    scope: {
        conversationId: string;
        topicId: string;
        botId: string;
    };
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
