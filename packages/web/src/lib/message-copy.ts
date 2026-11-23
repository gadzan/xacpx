import type { TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import { deriveTurnPresentation, finalReplyTextOf, type TurnPresentationPlan } from "./turn-presentation";

export interface ConversationMessageContent {
  content?: string;
  text?: string;
  createdAt: string | number;
}

export function messageCopyText(
  message: ConversationMessageContent,
  parts?: TurnPartDto[],
  presentation?: TurnPresentationPlan,
): string {
  if (parts?.length) return finalReplyTextOf(presentation ?? deriveTurnPresentation(parts));
  return message.content ?? message.text ?? "";
}
