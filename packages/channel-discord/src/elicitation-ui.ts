/**
 * Discord form-Elicitation UI: opaque correlation handles, card content and
 * button rows, and the click handler that drives the wizard.
 *
 * Split from `elicitation-state.ts` for the same reason permission is: this
 * file holds everything that touches Discord's component API, so the rendering
 * rules (literal escaping, platform limits, initiator-only auth) are auditable
 * in one place.
 *
 * Security model, in order of importance:
 *
 *   1. Answers never appear here. The only per-request data in a `custom_id` is
 *      an opaque token plus a routing identity, so nothing agent-controlled or
 *      answer-bearing is exposed through interaction payloads.
 *   2. Agent-controlled strings are LITERAL. `message`, titles, descriptions,
 *      option labels and defaults come from the ACP agent and are escaped with
 *      the same helper the permission card uses, so they cannot mention, spoiler,
 *      mask a link, or reshape the card the user is answering.
 *   3. A custom-id token is NOT authorization. Every click re-checks the
 *      platform-authenticated user id against the stored initiator.
 */
import { randomUUID } from "node:crypto";

import type {
  ChannelElicitationDecision,
  ChannelElicitationField,
  ChannelElicitationRequest,
  ChannelElicitationValue,
} from "xacpx/plugin-api";

import type { DiscordActionRow, DiscordButtonComponent } from "./types.js";
import { t as getMessages } from "./i18n/index.js";
import { escapeDiscordLiteralText } from "./permission-ui.js";
import { trySettle } from "./elicitation-state.js";

export const ELICITATION_CUSTOM_ID_PREFIX = "xacpx-elicit:";

/** Routing identity for a control. Values, never answers. */
export type ElicitationUiAction =
  | "start"
  | "field"
  | "review"
  | "edit"
  | "submit"
  | "decline"
  | "cancel";

const ACTION_SEGMENTS: Record<ElicitationUiAction, string> = {
  start: "start",
  field: "field",
  review: "review",
  edit: "edit",
  submit: "submit",
  decline: "decline",
  cancel: "cancel",
};

export function createElicitationToken(): string {
  return randomUUID().replace(/-/g, "");
}

/**
 * Build a custom id from token + routing identity only. Deliberately has no
 * slot for a field value: a `custom_id` is echoed in every interaction payload,
 * so encoding an answer there would leak it into Discord's own logs.
 */
export function elicitationCustomId(token: string, action: ElicitationUiAction, fieldKey?: string): string {
  if (action !== "field" && action !== "edit") {
    if (fieldKey !== undefined) throw new Error(`elicitation custom id must not carry a field for action "${action}"`);
    return `${ELICITATION_CUSTOM_ID_PREFIX}${token}:${ACTION_SEGMENTS[action]}`;
  }
  if (fieldKey === undefined || fieldKey.length === 0) {
    throw new Error(`elicitation custom id action "${action}" requires a field key`);
  }
  // Field keys are core-chosen identifiers (bounded, URI-safe), not answers;
  // they are still length-capped so a pathological key cannot overflow the id.
  const boundedKey = fieldKey.slice(0, 48).replace(/[^A-Za-z0-9_-]/g, "");
  return `${ELICITATION_CUSTOM_ID_PREFIX}${token}:${ACTION_SEGMENTS[action]}:${boundedKey}`;
}

export function parseElicitationCustomId(
  customId: string,
): { token: string; action: ElicitationUiAction; fieldKey?: string } | null {
  if (!customId.startsWith(ELICITATION_CUSTOM_ID_PREFIX)) return null;
  const rest = customId.slice(ELICITATION_CUSTOM_ID_PREFIX.length);
  // Layout is `<token>:<action>[:<field>]`. The token is a fixed 32-char hex
  // slug, so it is read FIRST rather than by "split on the last colon" (the
  // permission shape): token length is known, and the action/field segments are
  // then unambiguous. Splitting on the last colon would leak a field key into
  // the token position and silently mis-route the callback.
  const tokenPattern = /^[0-9a-f]{32}/;
  const match = tokenPattern.exec(rest);
  if (!match) return null;
  const token = match[0];
  const tail = rest.slice(token.length);
  if (!tail.startsWith(":")) return null;
  const segments = tail.slice(1).split(":");
  const action = segments[0];
  let fieldKey: string | undefined;
  switch (action) {
    case "start":
    case "review":
    case "submit":
    case "decline":
    case "cancel":
      if (segments.length !== 1) return null;
      break;
    case "field":
    case "edit":
      if (segments.length !== 2) return null;
      fieldKey = segments[1];
      if (!fieldKey || !/^[A-Za-z0-9_-]{1,48}$/.test(fieldKey)) return null;
      break;
    default:
      return null;
  }
  return { token, action: action as ElicitationUiAction, ...(fieldKey ? { fieldKey } : {}) };
}

type ButtonStyle = 1 | 2 | 3 | 4;

function button(label: string, customId: string, style: ButtonStyle, disabled = false): DiscordButtonComponent {
  return {
    type: 2,
    style,
    label: truncate(label, 80),
    customId,
    ...(disabled ? { disabled: true } : {}),
  };
}

/** Rows for a card that can still be acted on. Never exceeds one row of controls. */
function actionRow(entries: Array<{ label: string; customId: string; style: ButtonStyle }>): DiscordActionRow[] {
  if (entries.length === 0) return [];
  return [{ type: 1, components: entries.map((entry) => button(entry.label, entry.customId, entry.style)) }];
}

const MAX_CARD_CHARS = 1800;

/**
 * Bound a rendered string, appending an ellipsis when it is cut.
 *
 * Truncation is a DISPLAY bound for content blocks the user reads; it is never
 * applied to anything that carries meaning the user must decide on (a button
 * label already bounded at 80, or a select option's identity). Content that
 * cannot be shown faithfully makes the whole request unrenderable via
 * `checkElicitationRenderability()` instead.
 */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Opening card: agent identity, the agent's own message, and the three
 * distinct ACP entry actions.
 *
 * `agent.name` is rendered from the CORRELATED agent identity, never inferred
 * from `message`: the request text is agent-controlled and could claim to be
 * from someone else.
 */
export function buildElicitationOpening(request: ChannelElicitationRequest, token: string): {
  content: string;
  components: DiscordActionRow[];
} {
  const messages = getMessages();
  const lines = [`**${messages.elicitationTitle}**`, messages.elicitationFromAgent(escapeDiscordLiteralText(request.agent.name))];
  if (request.agent.sessionAlias) {
    lines.push(`_${escapeDiscordLiteralText(request.agent.sessionAlias)}_`);
  }
  if (request.message) lines.push(escapeDiscordLiteralText(request.message));
  if (request.schemaTitle) lines.push(`**${escapeDiscordLiteralText(request.schemaTitle)}**`);
  if (request.schemaDescription) lines.push(escapeDiscordLiteralText(request.schemaDescription));
  const summary = request.fields
    .map((field) => `- ${escapeDiscordLiteralText(field.title)}${field.required ? "" : ` (${messages.elicitationOptional})`}`)
    .join("\n");
  if (summary) lines.push(summary);
  const components = actionRow([
    { label: messages.elicitationStart, customId: elicitationCustomId(token, "start"), style: 3 },
    { label: messages.elicitationDecline, customId: elicitationCustomId(token, "decline"), style: 2 },
    { label: messages.elicitationCancel, customId: elicitationCustomId(token, "cancel"), style: 1 },
  ]);
  return { content: truncate(lines.join("\n\n"), MAX_CARD_CHARS), components };
}

/** Field card: one question, with its own decline/cancel escape hatches. */
export function buildElicitationFieldCard(
  request: ChannelElicitationRequest,
  token: string,
  field: ChannelElicitationField,
  index: number,
  current: ChannelElicitationValue | undefined,
): { content: string; components: DiscordActionRow[] } {
  const messages = getMessages();
  const lines = [
    `**${messages.elicitationFieldLabel(index, request.fields.length)}**`,
    messages.elicitationFromAgent(escapeDiscordLiteralText(request.agent.name)),
    `**${escapeDiscordLiteralText(field.title)}**`,
  ];
  if (field.description) lines.push(escapeDiscordLiteralText(field.description));
  lines.push(escapeDiscordLiteralText(hintForField(field)));
  if (field.defaultValue !== undefined && current === undefined) {
    lines.push(escapeDiscordLiteralText(`_${displayValue(field.defaultValue)}_`));
  }
  const components = actionRow([
    { label: messages.elicitationDecline, customId: elicitationCustomId(token, "decline"), style: 2 },
    { label: messages.elicitationCancel, customId: elicitationCustomId(token, "cancel"), style: 1 },
  ]);
  return { content: truncate(lines.join("\n\n"), MAX_CARD_CHARS), components };
}

/** Review card: every label and its current value, with Edit / Submit / Decline / Cancel. */
export function buildElicitationReviewCard(
  request: ChannelElicitationRequest,
  token: string,
  values: Record<string, ChannelElicitationValue>,
): { content: string; components: DiscordActionRow[] } {
  const messages = getMessages();
  const lines = [`**${messages.elicitationReview}**`, messages.elicitationFromAgent(escapeDiscordLiteralText(request.agent.name))];
  for (const field of request.fields) {
    const value = values[field.key];
    lines.push(`**${escapeDiscordLiteralText(field.title)}**\n${escapeDiscordLiteralText(value === undefined ? messages.elicitationNoAnswer : displayValue(value))}`);
  }
  const components = actionRow([
    { label: messages.elicitationEdit, customId: elicitationCustomId(token, "review"), style: 2 },
    { label: messages.elicitationSubmit, customId: elicitationCustomId(token, "submit"), style: 3 },
    { label: messages.elicitationDecline, customId: elicitationCustomId(token, "decline"), style: 2 },
    { label: messages.elicitationCancel, customId: elicitationCustomId(token, "cancel"), style: 1 },
  ]);
  return { content: truncate(lines.join("\n\n"), MAX_CARD_CHARS), components };
}

export function hintForField(field: ChannelElicitationField): string {
  const messages = getMessages();
  const base = messages.elicitationFieldHint;
  switch (field.kind) {
    case "single-select":
    case "multi-select":
      return base;
    case "number":
    case "integer":
      return messages.elicitationNumberHint;
    case "date":
      return messages.elicitationDateHint;
    case "date-time":
      return messages.elicitationDateHint;
    case "email":
      return messages.elicitationEmailHint;
    case "uri":
      return messages.elicitationUriHint;
    default:
      return messages.elicitationTextHint;
  }
}

/** Render a collected value as literal text for a card. */
export function displayValue(value: ChannelElicitationValue): string {
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

/**
 * Authorization for a single interaction, independent of the action taken.
 *
 * Returns null when the caller may act. Otherwise returns the bounded reason,
 * which the caller must surface ephemerally and then DROP without mutating
 * pending state or settling anything.
 *
 * The check is on the PLATFORM-AUTHENTICATED interaction user id, never on the
 * custom-id token: possession of a custom id is not evidence of identity (ids
 * are visible in payloads, and a leaked id in a forwarded screenshot must not
 * let a third party answer on the initiator's behalf).
 */
export function authorizeElicitationClick(
  entry: PendingDiscordElicitation,
  interactionUserId: string,
): null | "settled" | "not-initiator" {
  if (entry.settled) return "settled";
  if (interactionUserId !== entry.requesterId) return "not-initiator";
  return null;
}

export interface ElicitationClickOutcome {
  /** Whether a terminal ACP decision was produced by this click. */
  decided: boolean;
  decision?: ChannelElicitationDecision;
  /** Set when the card must be re-rendered after this click. */
  rerender?: "field" | "review" | "opening";
}

export interface ElicitationClickInput {
  interaction: {
    customId: string;
    userId: string;
    acknowledge(): Promise<void>;
    replyEphemeral(text: string): Promise<void>;
  };
  pending: Map<string, PendingDiscordElicitation>;
  /** Resolve/reject the request promise, matching the permission pattern. */
  onSettled: (entry: PendingDiscordElicitation, decision: ChannelElicitationDecision) => void;
  log?: (event: string, message: string, fields?: Record<string, string | number | boolean | undefined>) => void;
}

/**
 * Handle one button interaction against the pending map.
 *
 * The ordering here is the same invariant the permission handler enforces and
 * for the same reason: authenticate, commit, then acknowledge. The Discord ACK
 * is a network call that may hang; if it sat between validation and commit a
 * legal click could leave the request in a "settled but undecided" limbo while
 * the core broker's deadline expired.
 */
export async function handleElicitationClick(input: ElicitationClickInput): Promise<ElicitationClickOutcome> {
  const messages = getMessages();
  const parsed = parseElicitationCustomId(input.interaction.customId);
  if (!parsed) return { decided: false };
  const entry = input.pending.get(parsed.token);
  if (!entry) return { decided: false };

  const denial = authorizeElicitationClick(entry, input.interaction.userId);
  if (denial === "settled") {
    await input.interaction.replyEphemeral(messages.elicitationAlreadyResolved);
    return { decided: false };
  }
  if (denial === "not-initiator") {
    input.log?.("discord.elicitation.unauthorized", "unauthorized elicitation control", {
      requestId: entry.requestId,
    });
    await input.interaction.replyEphemeral(messages.elicitationUnauthorized);
    // Drop WITHOUT settling: the initiator must still be able to answer.
    return { decided: false };
  }

  switch (parsed.action) {
    case "decline":
    case "cancel": {
      if (!trySettle(entry)) {
        await input.interaction.replyEphemeral(messages.elicitationAlreadyResolved);
        return { decided: false };
      }
      const decision: ChannelElicitationDecision = {
        action: parsed.action,
        responderId: input.interaction.userId,
      };
      input.pending.delete(parsed.token);
      input.onSettled(entry, decision);
      await input.interaction.acknowledge();
      return { decided: true, decision };
    }
    case "start": {
      if (!enterWizard(entry)) {
        // No fields to ask about: nothing to render beyond the opening card.
        await input.interaction.acknowledge();
        return { decided: false };
      }
      await input.interaction.acknowledge();
      return { decided: false, rerender: "field" };
    }
    case "field":
    case "edit": {
      // Route to the requested field. Answers are not carried here (there is
      // no slot for one), so the caller supplies the collected value.
      if (parsed.fieldKey && entry.request.fields.some((field) => field.key === parsed.fieldKey)) {
        entry.currentField = parsed.fieldKey;
      } else if (!entry.currentField) {
        entry.currentField = entry.request.fields[0]?.key;
      }
      await input.interaction.acknowledge();
      return { decided: false, rerender: "field" };
    }
    case "review": {
      await input.interaction.acknowledge();
      return { decided: false, rerender: "review" };
    }
    case "submit": {
      return submitAnswers(entry, input);
    }
    default:
      return { decided: false };
  }
}

/** Advance the wizard to its first question. Returns false for a fieldless form. */
function enterWizard(entry: PendingDiscordElicitation): boolean {
  if (entry.request.fields.length === 0) return false;
  entry.currentField = entry.request.fields[0]?.key;
  return true;
}

/**
 * Commit a reviewed form as an ACP accept.
 *
 * This is the ONLY path to `accept`, and it is deliberately gated behind the
 * review card: the ACP contract requires the user to be able to review and
 * modify answers before they are sent, so a submit control that committed an
 * uneditable pre-filled value would not be compliant.
 *
 * A required field with no collected value cancels the whole submission rather
 * than sending a partial answer — core validates too, but failing here keeps
 * the wizard open instead of burning the turn on a rejected payload.
 */
async function submitAnswers(
  entry: PendingDiscordElicitation,
  input: ElicitationClickInput,
): Promise<ElicitationClickOutcome> {
  const messages = getMessages();
  const missing = entry.request.fields.filter((field) => field.required && entry.values[field.key] === undefined);
  if (missing.length > 0) {
    // Stay on the review page and point at the first gap.
    await input.interaction.replyEphemeral(`${messages.elicitationRequired}: ${missing[0]!.title}`);
    return { decided: false };
  }
  if (!trySettle(entry)) {
    await input.interaction.replyEphemeral(messages.elicitationAlreadyResolved);
    return { decided: false };
  }
  // `null` is a valid ACP accept for an all-optional form and tells core the
  // channel deliberately submitted nothing; an empty object is not the same
  // statement, so the distinction is preserved rather than normalized here.
  const content: Record<string, ChannelElicitationValue> | null =
    Object.keys(entry.values).length === 0
      ? null
      : { ...entry.values };
  const decision: ChannelElicitationDecision = {
    action: "accept",
    responderId: input.interaction.userId,
    content,
  };
  input.pending.delete(entry.token);
  input.onSettled(entry, decision);
  await input.interaction.acknowledge();
  return { decided: true, decision };
}

