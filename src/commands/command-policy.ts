import type { ChannelConfig, ChannelRuntimeConfig } from "../config/types";
import type { ChatRequestMetadata } from "../weixin/agent/interface";
import type { ParsedCommand } from "./parse-command";
import { t } from "../i18n/index.js";

export type CommandAccessDecision = { allowed: true } | { allowed: false; reason: string };

export type ChannelOwnerConfig = {
  channel?: Pick<ChannelConfig, "type" | "ownerIds">;
  channels?: Array<Pick<ChannelRuntimeConfig, "id" | "type" | "ownerIds">>;
};

/**
 * Internal scheduled dispatch turns carry `channel` + `scheduledSession*` but
 * no chatType/senderId/isOwner. Their authorization happened at task creation
 * (owner-gated), so both the chatType fail-closed rule and the ownerIds seam
 * must leave them alone.
 */
function isInternalScheduledTurn(metadata: ChatRequestMetadata | undefined): boolean {
  return Boolean(metadata?.scheduledSessionAlias || metadata?.scheduledSessionDescriptor);
}

/**
 * Collects the configured `ownerIds` for a channel. The built-in `channel`
 * entry matches by type; runtime `channels[]` entries match by type or id
 * (route metadata carries the channel type, but ids are accepted so a custom
 * id like "feishu-main" still resolves).
 *
 * Returns `undefined` when NO matching entry declares `ownerIds` (not
 * configured), and an array — possibly empty — when at least one does. An
 * explicitly empty list is a revocation gesture and must stay distinguishable
 * from "not configured".
 */
export function resolveChannelOwnerIds(
  config: ChannelOwnerConfig | undefined,
  channel: string | undefined,
): string[] | undefined {
  if (!config || !channel) {
    return undefined;
  }
  let configured = false;
  const ids = new Set<string>();
  if (config.channel?.type === channel && config.channel.ownerIds) {
    configured = true;
    for (const id of config.channel.ownerIds) ids.add(id);
  }
  for (const entry of config.channels ?? []) {
    if ((entry.type === channel || entry.id === channel) && entry.ownerIds) {
      configured = true;
      for (const id of entry.ownerIds) ids.add(id);
    }
  }
  return configured ? [...ids] : undefined;
}

/**
 * Computes the effective owner flag for a channel turn:
 * `isOwner === true` (channel-asserted) OR the sender id appears in the
 * channel's configured `ownerIds`. When ownerIds is configured for the
 * channel (even as an empty list — an explicit revocation), the result is an
 * EXPLICIT boolean so a stale `isOwner` on a previously recorded coordinator
 * route can never linger. When ownerIds is not configured, or for internal
 * scheduled dispatch turns (which carry no sender identity to evaluate), the
 * metadata passes through unchanged.
 */
export function withEffectiveOwner(
  metadata: ChatRequestMetadata | undefined,
  config: ChannelOwnerConfig | undefined,
): ChatRequestMetadata | undefined {
  if (!metadata?.channel || isInternalScheduledTurn(metadata)) {
    return metadata;
  }
  const ownerIds = resolveChannelOwnerIds(config, metadata.channel);
  if (ownerIds === undefined) {
    return metadata;
  }
  const isOwner =
    metadata.isOwner === true ||
    (typeof metadata.senderId === "string" && ownerIds.includes(metadata.senderId));
  return { ...metadata, isOwner };
}

const GROUP_PUBLIC_COMMAND_KINDS = new Set<ParsedCommand["kind"]>([
  "help",
  "agents",
  "workspaces",
  "sessions",
  "session.tail",
  "status",
  "mode.show",
  "model.show",
  "replymode.show",
  "config.show",
  "permission.status",
  "permission.auto.status",
  "groups",
  "group.get",
  "tasks",
  "task.get",
  "later.help",
  "invalid",
  "prompt",
]);

export function authorizeCommandForChat(command: ParsedCommand, metadata?: ChatRequestMetadata): CommandAccessDecision {
  // Fail closed for real channel turns that violate the metadata contract:
  // a channel that identifies itself MUST report the chat type. Without it we
  // cannot tell group from direct, so privileged commands are denied. Two
  // kinds of internal callers keep the legacy allow-all behavior: turns with
  // no channel metadata at all (tests, internal dispatch) and internal
  // scheduled dispatch turns whose authorization happened at task creation.
  if (
    metadata?.channel &&
    !isInternalScheduledTurn(metadata) &&
    metadata.chatType !== "direct" &&
    metadata.chatType !== "group"
  ) {
    if (GROUP_PUBLIC_COMMAND_KINDS.has(command.kind)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: "chat-type-missing",
    };
  }

  if (metadata?.chatType !== "group") {
    return { allowed: true };
  }

  if (GROUP_PUBLIC_COMMAND_KINDS.has(command.kind)) {
    return { allowed: true };
  }

  if (metadata.isOwner) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: "group-owner-required",
  };
}

const COMMAND_KIND_TO_LABEL: Record<string, string> = {
  "session.reset": "/clear",
  "session.rm": "/session rm",
  "session.tail": "/session tail",
  "replymode.set": "/replymode",
  "replymode.reset": "/replymode reset",
  "mode.set": "/mode",
  "model.set": "/model",
  "permission.mode.set": "/permission",
  "permission.auto.set": "/permission auto",
  "config.set": "/config set",
  "agent.add": "/agent add",
  "agent.rm": "/agent rm",
  "workspace.new": "/workspace new",
  "workspace.rm": "/workspace rm",
  "delegate.request": "/delegate",
  "group.new": "/group new",
  "group.cancel": "/group cancel",
  "group.delegate": "/group",
  "tasks.clean": "/tasks clean",
  "task.approve": "/task approve",
  "task.reject": "/task reject",
  "task.cancel": "/task cancel",
  "session.use": "/use",
  "session.new": "/session new",
  "session.shortcut": "/session",
  "session.shortcut.new": "/session",
  "session.attach": "/session attach",
  "session.native.list": "/ssn",
  "session.native.select": "/ssn",
  "session.native.attach": "/ssn attach",
  "later.create": "/later",
  "later.list": "/later list",
  "later.cancel": "/later cancel",
};

export function renderCommandAccessDenied(command: ParsedCommand, reason?: string): string {
  if (reason === "chat-type-missing") {
    return [
      `⚠️ ${renderCommandLabel(command)}${t().misc.commandAccessDeniedChatTypeMissingSuffix}`,
      t().misc.commandAccessDeniedChatTypeMissingHint,
    ].join("\n");
  }
  return [
    `⚠️ ${renderCommandLabel(command)}${t().misc.commandAccessDeniedSuffix}`,
    t().misc.commandAccessDeniedHint,
  ].join("\n");
}

function renderCommandLabel(command: ParsedCommand): string {
  switch (command.kind) {
    case "prompt":
      return t().misc.commandLabelThisMessage;
    case "invalid":
      return command.recognizedCommand;
    default:
      return COMMAND_KIND_TO_LABEL[command.kind] ?? `/${command.kind.split(".")[0]}`;
  }
}
