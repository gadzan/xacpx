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
  // Rows are untrusted text inside a fenced block: a bot echo, a quote, or a
  // user paste can carry the exact fence markers, which would nest a second
  // HISTORY block inside the row. Neutralize them in every row so the output
  // carries exactly the fences the renderer wrote.
  return history.map((message) => ({
    role: message.role === "user" ? "human" : "bot",
    ...(message.role === "agent" ? { senderBotId: agent } : {}),
    content: message.text.split("<<<HISTORY").join("[HISTORY").split(">>>END HISTORY").join("END HISTORY]"),
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
): NativeHistoryMessage[] {
  if (!parentText) return [...history];
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
  return cleaned;
}

/**
 * Whether the parent handoff must be carried as the parent block. The child's
 * recorded history may already hold it inline: the stripped first-prompt
 * prefix, or a bot row echoing or quoting it. Carrying it again would
 * duplicate the chain's oldest context, so the parent block is only added
 * when no cleaned row still contains it.
 */
export function renderSessionForkHandoff(
  input: RenderSessionForkHandoffInput,
): RenderedTopicForkHandoff {
  const cleaned = stripInjectedParent(input.history, input.parentHandoff?.text);
  const parentText = input.parentHandoff?.text;
  const parent =
    input.parentFork && input.parentHandoff && parentText
      ? cleaned.some((message) => message.text.includes(parentText))
        ? undefined
        : input.parentHandoff
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
