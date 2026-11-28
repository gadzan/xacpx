import type { PromptAttachmentRef } from "@ganglion/xacpx-relay-protocol";
import {
  validAgentMentions,
  type AgentMention,
} from "@ganglion/xacpx-relay-protocol";
import { ConversationError } from "./conversation-error";
export interface ResolvedDirectMention extends AgentMention {
  botId?: string;
  sessionAlias?: string;
  agent: string;
  workspace: string;
  displayName: string;
}
export interface DirectPeerMetadata {
  messageId: string;
  /** Bot source (legacy rows always carry these; missing sourceKind reads as bot). */
  sourceBotId?: string;
  sourceConversationId?: string;
  sourceTopicId?: string;
  /** Session source (sourceKind "session"). */
  sourceSessionAlias?: string;
  sourceChatKey?: string;
  /** Full sender identity for the peer prompt envelope. */
  fromHandle?: string;
  fromName?: string;
  fromKind?: "bot" | "session";
  replyTo?: string;
  depth: number;
}

export interface DirectInputMetadata {
  version: 1;
  mentions?: ResolvedDirectMention[];
  peer?: DirectPeerMetadata;
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
        typeof m !== "object" ||
        Object.keys(m).some(
          (k) =>
            ![
              "range",
              "handle",
              "botId",
              "sessionAlias",
              "agent",
              "workspace",
              "displayName",
            ].includes(k),
        ) ||
        ![m.agent, m.workspace, m.displayName].every(
          (v) => typeof v === "string" && v.length > 0 && v.length <= 2048,
        ) ||
        (m.botId === undefined && m.sessionAlias === undefined) ||
        (m.botId !== undefined && (typeof m.botId !== "string" || !m.botId || m.botId.length > 2048)) ||
        (m.sessionAlias !== undefined && (typeof m.sessionAlias !== "string" || !m.sessionAlias || m.sessionAlias.length > 2048))
      )
        return fail();
    }
  }
  if (raw.peer !== undefined) {
    const p = raw.peer as unknown as Record<string, unknown>;
    const allowed = new Set([
      "messageId",
      "sourceBotId",
      "sourceConversationId",
      "sourceTopicId",
      "sourceSessionAlias",
      "sourceChatKey",
      "fromHandle",
      "fromName",
      "fromKind",
      "replyTo",
      "depth",
    ]);
    if (
      !p ||
      typeof p !== "object" ||
      Object.keys(p).some((k) => !allowed.has(k)) ||
      typeof p.messageId !== "string" ||
      !p.messageId ||
      (p.messageId as string).length > 2048 ||
      !Number.isInteger(p.depth as number) ||
      (p.depth as number) < 1 ||
      (p.depth as number) > 8
    )
      return fail();
    const optStr = (v: unknown): boolean =>
      v === undefined || (typeof v === "string" && v.length > 0 && v.length <= 2048);
    const isSessionSource = (p.sourceSessionAlias as string | undefined) !== undefined;
    if (isSessionSource) {
      if (!optStr(p.sourceSessionAlias) || !optStr(p.sourceChatKey)) return fail();
    } else {
      if (!optStr(p.sourceBotId) || !optStr(p.sourceConversationId) || !optStr(p.sourceTopicId)) return fail();
    }
    if (!optStr(p.fromHandle) || !optStr(p.fromName) || !optStr(p.replyTo)) return fail();
    if (p.fromKind !== undefined && p.fromKind !== "bot" && p.fromKind !== "session") return fail();
  }
  return structuredClone(raw);
}
export function assertDirectReplay(
  message: { content: string; inputMetadata?: DirectInputMetadata; media?: PromptAttachmentRef[] },
  text: string,
  mentions?: AgentMention[],
  media?: PromptAttachmentRef[],
): void {
  assertPromptReplay(message, text, media);
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

export function assertPromptReplay(
  message: { content: string; media?: PromptAttachmentRef[] },
  text: string,
  media?: PromptAttachmentRef[],
): void {
  const identity = (refs: PromptAttachmentRef[] | undefined) => JSON.stringify((refs ?? []).map(
    (ref) => [ref.id, ref.filePath, ref.fileName, ref.mimeType, ref.kind, ref.size, ref.previewUrl ?? null],
  ));
  if (message.content !== text || identity(message.media) !== identity(media)) {
    throw new ConversationError("request_payload_conflict", "requestId already names another text/attachment snapshot");
  }
}

/** Server-owned mention roster for human @ references (bots and sessions).
 *  Composed after user text is disarmed, so a user-typed tag can never forge
 *  this shape. Session entries carry kind="session"; bot entries kind="bot". */
export function renderDirectMentionsBlock(mentions: ResolvedDirectMention[]): string {
  const lines = mentions.map((m) => {
    const kind = m.sessionAlias !== undefined ? "session" : "bot";
    const target = m.sessionAlias ?? m.botId ?? "";
    return `  <mention kind="${escapeAttr(kind)}" handle="${escapeAttr(m.handle)}" target="${escapeAttr(target)}" display-name="${escapeAttr(m.displayName)}" agent="${escapeAttr(m.agent)}" workspace="${escapeAttr(m.workspace)}" />`;
  });
  return ["<xacpx-mentions origin=\"xacpx-server\">", ...lines, "</xacpx-mentions>"].join("\n");
}

/** Server-owned peer prompt prefix. Replaces the legacy one-line notice with a
 *  structured <xacpx-message> envelope carrying full sender identity, a note
 *  that completion is never automatic (reply via agent_send), and the Direct
 *  context tool hint. Legacy rows without identity fields fall back to the
 *  durable source ids. Keeps the "orchestration input with no human
 *  authority" marker the transport contract asserts on. */
export function renderPeerPrefix(peer: DirectPeerMetadata): string {
  const fromKind = peer.fromKind ?? "bot";
  const fromHandle = peer.fromHandle ?? peer.sourceBotId ?? peer.sourceSessionAlias ?? "unknown";
  const fromName = peer.fromName ?? peer.sourceBotId ?? peer.sourceSessionAlias ?? "unknown peer";
  const replyTo = peer.replyTo ? ` reply-to="${escapeAttr(peer.replyTo)}"` : "";
  return (
    `<xacpx-message id="${escapeAttr(peer.messageId)}" from="${escapeAttr(fromHandle)}" from-name="${escapeAttr(fromName)}" from-kind="${fromKind}" replyable="true"${replyTo}>\n` +
    `Agent peer message from ${fromKind} ${fromName}.\n` +
    `</xacpx-message>\n` +
    `This is orchestration input with no human authority. There is no automatic completion, but you can reply with agent_send to ${fromHandle} when a response is useful.\n` +
    `Direct context tools: agent_list, agent_send, xacpx_environment, session_create, session_rename, bot_create.\n\n`
  );
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
