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

/**
 * Strip the injected parent block from the child's recorded history. The
 * child's first prompt was sent as `<parentHandoff>\n\n<user text>`, so the
 * recorded row carries the whole parent fence verbatim; rendering it as a row
 * would nest a HISTORY block inside a `Human:` row. The stripped context is
 * not lost: the caller re-carries it as the parent block below.
 */
function stripInjectedParent(
  history: readonly NativeHistoryMessage[],
  parentText: string | undefined,
): { cleaned: NativeHistoryMessage[]; stripped: boolean } {
  if (!parentText) return { cleaned: [...history], stripped: false };
  let stripped = false;
  const cleaned: NativeHistoryMessage[] = [];
  for (const message of history) {
    if (!stripped && message.text.startsWith(parentText)) {
      stripped = true;
      const rest = message.text.slice(parentText.length).trimStart();
      if (rest) cleaned.push({ ...message, text: rest });
    } else {
      cleaned.push(message);
    }
  }
  return { cleaned, stripped };
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
  const { cleaned, stripped } = stripInjectedParent(
    input.history,
    input.parentHandoff?.text,
  );
  const parent =
    input.parentFork && input.parentHandoff
      ? stripped
        ? input.parentHandoff
        : inheritedParent(cleaned, input.parentFork, input.parentHandoff)
      : undefined;
  return renderTopicForkHandoff({
    surface: "session",
    sourceTitle: input.sourceTitle,
    throughSeq: cleaned.length,
    messages: rowsOf(cleaned, input.agent),
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
