import { randomUUID } from "node:crypto";

import type {
  ChannelPermissionDecision,
  ChannelPermissionRequest,
  PermissionOutcome,
} from "xacpx/plugin-api";

import type { DiscordActionRow, DiscordButtonInteraction } from "./types.js";
import { t as getMessages } from "./i18n/index.js";

export interface PendingDiscordPermission {
  token: string;
  requestId: string;
  requesterId: string;
  allowed: PermissionOutcome[];
  target: { channelId: string; guildId?: string };
  accountId?: string;
  content?: string;
  messageId?: string;
  settled: boolean;
  /** Terminal UI state for a send that completes after settlement (send race). */
  terminalState?: "expired" | "cancelled";
  resolve: (decision: ChannelPermissionDecision) => void;
  reject: (error: Error) => void;
}

export const PERMISSION_CUSTOM_ID_PREFIX = "xacpx-perm:";

type PermissionAction = "allow" | "always" | "deny" | "deny_always" | "cancel";

const OUTCOME_BY_ACTION: Record<PermissionAction, PermissionOutcome> = {
  allow: "allow_once",
  always: "allow_always",
  deny: "reject_once",
  deny_always: "reject_always",
  cancel: "cancel",
};

const ACTION_BY_OUTCOME: Record<PermissionOutcome, PermissionAction> = {
  allow_once: "allow",
  allow_always: "always",
  reject_once: "deny",
  reject_always: "deny_always",
  cancel: "cancel",
};

export function createPermissionToken(): string {
  return randomUUID().replace(/-/g, "");
}

export function parsePermissionCustomId(customId: string): { token: string; action: PermissionAction } | null {
  if (!customId.startsWith(PERMISSION_CUSTOM_ID_PREFIX)) return null;
  const rest = customId.slice(PERMISSION_CUSTOM_ID_PREFIX.length);
  const sep = rest.lastIndexOf(":");
  if (sep <= 0 || sep === rest.length - 1) return null;
  const token = rest.slice(0, sep);
  const action = rest.slice(sep + 1);
  if (!token || !/^[0-9a-f]{16,64}$/i.test(token)) return null;
  if (
    action !== "allow" &&
    action !== "always" &&
    action !== "deny" &&
    action !== "deny_always" &&
    action !== "cancel"
  ) {
    return null;
  }
  return { token, action };
}

export function permissionCustomId(token: string, outcome: PermissionOutcome): string {
  return `${PERMISSION_CUSTOM_ID_PREFIX}${token}:${ACTION_BY_OUTCOME[outcome]}`;
}

export function outcomeForAction(action: PermissionAction): PermissionOutcome {
  return OUTCOME_BY_ACTION[action];
}

const MAX_CONTENT_CHARS = 1800;
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Escape untrusted request data for the approval message. Title/summary/kind
 * ultimately come from the ACP agent request: without escaping, spoiler
 * (`||`), code fences, masked links (`[text](url)`), headings, quotes, and
 * the whole `<...>` family (user/channel/role mentions, slash-command and
 * custom-emoji references, timestamps, guild navigation) could change what
 * the approver THINKS they are approving. The fixed heading stays Markdown;
 * every data line is literal. `:` is deliberately left alone (emoji syntax
 * needs word-char wrapping; over-escaping `key: value` summaries hurts
 * readability more than it protects).
 */
export function escapeDiscordLiteralText(value: string): string {
  return value.replace(/[<\\`*_~>|[\]()#]/g, (char) => `\\${char}`);
}

export function buildPermissionContent(request: ChannelPermissionRequest): string {
  const messages = getMessages();
  const lines = [`**${messages.permissionTitle}**`];
  if (request.title) lines.push(escapeDiscordLiteralText(truncate(request.title, 200)));
  if (request.kind) lines.push(`\`${escapeDiscordLiteralText(truncate(request.kind, 80))}\``);
  if (request.summary) lines.push(escapeDiscordLiteralText(truncate(request.summary, 800)));
  const body = lines.join("\n");
  return truncate(body, MAX_CONTENT_CHARS);
}

/**
 * Human localized label for a permission outcome, shared by buttons and
 * terminal state so the card never leaks protocol enums like `allow_once`.
 */
export function permissionOutcomeLabel(outcome: PermissionOutcome): string {
  const messages = getMessages();
  switch (outcome) {
    case "allow_once": return messages.permissionAllowOnce;
    case "allow_always": return messages.permissionAllowAlways;
    case "reject_once": return messages.permissionDeny;
    case "reject_always": return messages.permissionDenyAlways;
    case "cancel": return messages.permissionCancel;
  }
}

export function buildPermissionComponents(
  token: string,
  availableOutcomes: PermissionOutcome[],
): DiscordActionRow[] {
  const messages = getMessages();
  const styleByOutcome: Record<PermissionOutcome, 1 | 2 | 3 | 4> = {
    allow_once: 3,
    allow_always: 3,
    reject_once: 4,
    reject_always: 4,
    cancel: 2,
  };
  const order: PermissionOutcome[] = [
    "allow_once",
    "allow_always",
    "reject_once",
    "reject_always",
    "cancel",
  ];
  const buttons = order
    .filter((outcome) => availableOutcomes.includes(outcome))
    .slice(0, 5)
    .map((outcome) => ({
      type: 2 as const,
      style: styleByOutcome[outcome],
      label: truncate(permissionOutcomeLabel(outcome), 80),
      customId: permissionCustomId(token, outcome),
    }));
  if (buttons.length === 0) {
    buttons.push({
      type: 2 as const,
      style: 4,
      label: truncate(messages.permissionDeny, 80),
      customId: permissionCustomId(token, "reject_once"),
    });
  }
  return [{ type: 1, components: buttons }];
}

export function terminalPermissionText(outcome: PermissionOutcome | "expired" | "cancelled"): string {
  const messages = getMessages();
  if (outcome === "expired") return messages.permissionExpired;
  if (outcome === "cancelled") return messages.permissionCancelled;
  return messages.permissionResolved(permissionOutcomeLabel(outcome));
}

export async function handlePermissionButtonClick(input: {
  interaction: DiscordButtonInteraction;
  pending: Map<string, PendingDiscordPermission>;
  onResolved: (entry: PendingDiscordPermission, outcome: PermissionOutcome, responderId: string) => void;
  log?: (event: string, message: string, fields?: Record<string, string | number | boolean | undefined>) => void;
}): Promise<void> {
  const parsed = parsePermissionCustomId(input.interaction.customId);
  if (!parsed) return;
  const entry = input.pending.get(parsed.token);
  if (!entry || entry.settled) {
    await input.interaction.replyEphemeral(getMessages().permissionAlreadyResolved);
    return;
  }
  if (input.interaction.userId !== entry.requesterId) {
    input.log?.("discord.permission.unauthorized", "unauthorized permission click", {
      requestId: entry.requestId,
    });
    await input.interaction.replyEphemeral(getMessages().permissionUnauthorized);
    return;
  }
  const outcome = outcomeForAction(parsed.action);
  if (!entry.allowed.includes(outcome)) {
    await input.interaction.replyEphemeral(getMessages().permissionAlreadyResolved);
    return;
  }
  entry.settled = true;
  input.pending.delete(parsed.token);
  // Commit FIRST: the authenticated click is the decision evidence. The
  // Discord ACK is platform UX protocol (a network call that may hang) and
  // must never sit between validation and commit — otherwise the decision
  // lands in a "settled but undecided" limbo while the broker times out.
  input.onResolved(entry, outcome, input.interaction.userId);
  try {
    await input.interaction.acknowledge();
  } catch {
    // Best-effort: the decision is already committed above.
  }
}
