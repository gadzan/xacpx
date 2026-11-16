import {
  renderTopicForkHandoff,
  type RenderedTopicForkHandoff,
  type TopicForkHandoffMessage,
} from "../conversations/topic-fork-handoff";
import type { NativeHistoryMessage } from "../transport/native-session-history";
import type { SessionForkHandoff, SessionForkRecord } from "./session-fork-store";

export interface RenderSessionForkHandoffInput {
  sourceTitle: string;
  agent: string;
  history: readonly NativeHistoryMessage[];
  /** The source session's own fork provenance when forking a fork. */
  parentFork?: SessionForkRecord;
  parentHandoff?: SessionForkHandoff;
  budget?: number;
}

function rowsOf(
  history: readonly NativeHistoryMessage[],
  agent: string,
): TopicForkHandoffMessage[] {
  return history.map((message) => ({
    role: message.role === "user" ? "human" : "bot",
    ...(message.role === "agent" ? { senderBotId: agent } : {}),
    content: message.text,
  }));
}

/** A consumed parent handoff is already inside the child's recorded history —
 *  the injected block was sent as the first prompt. Only an unconsumed parent
 *  (or one the record did not retain) needs carrying as the parent block. */
function inheritedParent(
  history: readonly NativeHistoryMessage[],
  fork: SessionForkRecord,
  handoff: SessionForkHandoff | undefined,
): SessionForkHandoff | undefined {
  if (!handoff) return undefined;
  if (fork.status !== "consumed") return handoff;
  return history.some((message) => message.text.includes(handoff.text))
    ? undefined
    : handoff;
}

export function renderSessionForkHandoff(
  input: RenderSessionForkHandoffInput,
): RenderedTopicForkHandoff {
  const parent = input.parentFork
    ? inheritedParent(input.history, input.parentFork, input.parentHandoff)
    : undefined;
  return renderTopicForkHandoff({
    surface: "session",
    sourceTitle: input.sourceTitle,
    throughSeq: input.history.length,
    messages: rowsOf(input.history, input.agent),
    ...(parent
      ? {
          parentText: parent.text,
          parentMessageCount: parent.messageCount,
          parentOmittedMessages: parent.omittedMessages,
        }
      : {}),
    ...(input.budget !== undefined ? { budget: input.budget } : {}),
  });
}
