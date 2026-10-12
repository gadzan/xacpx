import {
  validAgentMentions,
  type AgentMention,
} from "@ganglion/xacpx-relay-protocol";
import { ConversationError } from "./conversation-error";
export interface ResolvedDirectMention extends AgentMention {
  botId: string;
  agent: string;
  workspace: string;
  displayName: string;
}
export interface DirectInputMetadata {
  version: 1;
  mentions?: ResolvedDirectMention[];
  peer?: {
    messageId: string;
    sourceBotId: string;
    sourceConversationId: string;
    sourceTopicId: string;
    depth: number;
  };
}
export function parseDirectInputMetadata(
  text: string,
  value: unknown,
): DirectInputMetadata {
  const fail = (): never => {
    throw new ConversationError(
      "invalid-agent-mentions",
      "invalid durable Direct input metadata",
    );
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  const raw = value as DirectInputMetadata;
  if (
    raw.version !== 1 ||
    Object.keys(raw).some((k) => !["version", "mentions", "peer"].includes(k))
  )
    return fail();
  if (raw.mentions !== undefined) {
    if (
      !Array.isArray(raw.mentions) ||
      !validAgentMentions(
        text,
        raw.mentions.map((m) => ({ range: m?.range, handle: m?.handle })),
      )
    )
      return fail();
    for (const m of raw.mentions) {
      if (
        !m ||
        Object.keys(m).some(
          (k) =>
            ![
              "range",
              "handle",
              "botId",
              "agent",
              "workspace",
              "displayName",
            ].includes(k),
        ) ||
        ![m.botId, m.agent, m.workspace, m.displayName].every(
          (v) => typeof v === "string" && v.length > 0 && v.length <= 2048,
        )
      )
        return fail();
    }
  }
  if (raw.peer !== undefined) {
    const p = raw.peer;
    if (
      !p ||
      Object.keys(p).some(
        (k) =>
          ![
            "messageId",
            "sourceBotId",
            "sourceConversationId",
            "sourceTopicId",
            "depth",
          ].includes(k),
      ) ||
      ![
        p.messageId,
        p.sourceBotId,
        p.sourceConversationId,
        p.sourceTopicId,
      ].every(
        (v) => typeof v === "string" && v.length > 0 && v.length <= 2048,
      ) ||
      !Number.isInteger(p.depth) ||
      p.depth < 1 ||
      p.depth > 8
    )
      return fail();
  }
  return structuredClone(raw);
}
export function assertDirectReplay(
  message: { content: string; inputMetadata?: DirectInputMetadata },
  text: string,
  mentions?: AgentMention[],
): void {
  const prior =
    message.inputMetadata?.mentions?.map(({ range, handle }) => ({
      range,
      handle,
    })) ?? [];
  if (
    message.content !== text ||
    JSON.stringify(prior) !== JSON.stringify(mentions ?? [])
  ) {
    throw new ConversationError(
      "request_payload_conflict",
      "requestId already names another text/reference snapshot",
    );
  }
}
