import type { ConversationMessage, GroupTurnRecord } from "./conversation-types";

export interface ConversationStore {
  appendMessage(message: ConversationMessage): Promise<void>;
  appendTurn(turn: GroupTurnRecord): Promise<void>;
  updateTurn(turnId: string, patch: Partial<GroupTurnRecord>): Promise<void>;

  listMessages(input: {
    conversationId: string;
    topicId: string;
    before?: string;
    limit: number;
  }): Promise<ConversationMessage[]>;

  getContextWindow(input: {
    conversationId: string;
    topicId: string;
    triggerMessageIds?: string[];
    budget: number;
  }): Promise<ConversationMessage[]>;

  deleteTopic(conversationId: string, topicId: string): Promise<void>;
  deleteConversation(conversationId: string): Promise<void>;
}
