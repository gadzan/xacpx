import type { ConversationTurnCorrelation } from "../control/conversation-control-dtos";
import type { LogicalSession } from "../state/types";
import type { ChatRequestMetadata } from "../weixin/agent/interface";

interface GroupExecutionRoute extends ConversationTurnCorrelation {
  sessionAlias: string;
  logicalSessionId: string;
  executionToken: string;
}

// Core-private, object-identity authority. Serialized/copied metadata or a
// caller-supplied groupExecutionToken cannot bypass the ordinary owner guard.
const routes = new WeakMap<ChatRequestMetadata, Readonly<GroupExecutionRoute>>();

export class GroupExecutionOutcomeUnknownError extends Error {
  constructor(cause: unknown) { super("Group transport terminal outcome is unknown", { cause }); }
}

export function bindGroupExecutionMetadata(metadata: ChatRequestMetadata, route: GroupExecutionRoute): () => void {
  routes.set(metadata, Object.freeze({ ...route }));
  return () => { routes.delete(metadata); };
}

export function matchesGroupExecutionMetadata(metadata: ChatRequestMetadata | undefined, session: LogicalSession | null | undefined): boolean {
  const route = metadata ? routes.get(metadata) : undefined;
  return !!route && !!session && session.owner?.kind === "group-member"
    && session.alias === route.sessionAlias && session.logical_session_id === route.logicalSessionId
    && session.owner.botId === route.botId && session.owner.conversationId === route.conversationId
    && session.owner.topicId === route.topicId && metadata?.groupExecutionToken === route.executionToken;
}
