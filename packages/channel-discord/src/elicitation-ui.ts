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

import type {
  DiscordActionRow,
  DiscordButtonComponent,
  DiscordSelectActionRow,
  ShowModalInput,
} from "./types.js";
import { t as getMessages } from "./i18n/index.js";
import { escapeDiscordLiteralText } from "./permission-ui.js";
import { DISCORD_ACTION_ROW_BUTTON_MAX } from "./elicitation-limits.js";
import { trySettle } from "./elicitation-state.js";
import type { PendingDiscordElicitation } from "./elicitation-state.js";

export const ELICITATION_CUSTOM_ID_PREFIX = "xacpx-elicit:";

/** Routing identity for a control. Values, never answers. */
export type ElicitationUiAction =
  | "start"
  | "field"
  | "next"
  | "review"
  | "edit"
  | "page"
  | "submit"
  | "decline"
  | "cancel";

const ACTION_SEGMENTS: Record<ElicitationUiAction, string> = {
  start: "start",
  field: "field",
  next: "next",
  review: "review",
  edit: "edit",
  page: "page",
  submit: "submit",
  decline: "decline",
  cancel: "cancel",
};

/**
 * The modal's own custom id uses a `modal` action segment. It is deliberately
 * NOT part of `ElicitationUiAction` (the button/select action union): a modal
 * submit carries no decision and routes through its own handler, so treating it
 * as a button action would let a modal fall into the wizard state machine.
 */
const ELICITATION_MODAL_ACTION = "modal";

export function createElicitationToken(): string {
  return randomUUID().replace(/-/g, "");
}

/**
 * Build a custom id from token + routing identity only. Deliberately has no
 * slot for a field value: a `custom_id` is echoed in every interaction payload,
 * so encoding an answer there would leak it into Discord's own logs.
 *
 * `fieldIndex` is a POSITION, never the schema key. Core guarantees a key is a
 * bounded JSON property name and nothing more — `env.prod`, `a/b` and keys past
 * any character budget are all legal. Carrying the key meant truncating and
 * stripping it, then matching the stripped form back against the original, which
 * silently lost the field. An index is always expressible, and the pending state
 * maps it back to the exact field.
 */
export function elicitationCustomId(token: string, action: ElicitationUiAction, fieldIndex?: number): string {
  if (action === "page" || action === "next") {
    if (fieldIndex === undefined || !Number.isInteger(fieldIndex) || fieldIndex < 0) {
      throw new Error(`elicitation custom id action "${action}" requires a page index`);
    }
    return `${ELICITATION_CUSTOM_ID_PREFIX}${token}:${ACTION_SEGMENTS[action]}:${fieldIndex}`;
  }
  if (action !== "field" && action !== "edit") {
    if (fieldIndex !== undefined) throw new Error(`elicitation custom id must not carry a field for action "${action}"`);
    return `${ELICITATION_CUSTOM_ID_PREFIX}${token}:${ACTION_SEGMENTS[action]}`;
  }
  if (fieldIndex === undefined || !Number.isInteger(fieldIndex) || fieldIndex < 0) {
    throw new Error(`elicitation custom id action "${action}" requires a field index`);
  }
  // Bounded so a pathological field count cannot overflow the id; Discord caps
  // custom ids at 100 chars and this stays far inside it.
  const boundedIndex = Math.min(fieldIndex, 999).toString();
  return `${ELICITATION_CUSTOM_ID_PREFIX}${token}:${ACTION_SEGMENTS[action]}:${boundedIndex}`;
}

/** Custom id for the modal wrapper itself; the field identity rides inside. */
export function elicitationModalCustomId(token: string): string {
  return `${ELICITATION_CUSTOM_ID_PREFIX}${token}:${ELICITATION_MODAL_ACTION}`;
}

export function parseElicitationCustomId(
  customId: string,
): { token: string; action: ElicitationUiAction; fieldIndex?: number } | null {
  if (!customId.startsWith(ELICITATION_CUSTOM_ID_PREFIX)) return null;
  const rest = customId.slice(ELICITATION_CUSTOM_ID_PREFIX.length);
  // Layout is `<token>:<action>[:<fieldIndex>]`. The token is a fixed 32-char hex
  // slug, so it is read FIRST rather than by "split on the last colon" (the
  // permission shape): token length is known, and the action/field segments are
  // then unambiguous. Splitting on the last colon would leak a field identity
  // into the token slot and silently mis-route the callback.
  const tokenPattern = /^[0-9a-f]{32}/;
  const match = tokenPattern.exec(rest);
  if (!match) return null;
  const token = match[0];
  const tail = rest.slice(token.length);
  if (!tail.startsWith(":")) return null;
  const segments = tail.slice(1).split(":");
  const action = segments[0];
  let fieldIndex: number | undefined;
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
    case "page":
    case "next":
      if (segments.length !== 2) return null;
      fieldIndex = Number(segments[1]);
      if (!Number.isInteger(fieldIndex) || fieldIndex < 0) return null;
      break;
    default:
      return null;
  }
  return { token, action: action as ElicitationUiAction, ...(fieldIndex !== undefined ? { fieldIndex } : {}) };
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

/**
 * Field card: one question, with its own decline/cancel escape hatches.
 *
 * `selectRows` returns the String Select for a select-kind field (Discord
 * forbids a select sharing an action row with a button, so buttons and selects
 * travel as separate rows). `modalAction` asks the channel to open a modal for
 * a text-like field; the card itself carries an "Answer" button, because a
 * modal can only be opened from an interaction.
 */
export function buildElicitationFieldCard(
  request: ChannelElicitationRequest,
  token: string,
  field: ChannelElicitationField,
  index: number,
  current: ChannelElicitationValue | undefined,
): {
  content: string;
  components: DiscordActionRow[];
  selectRows: DiscordSelectActionRow[];
  modalAction: boolean;
} {
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
  if (current !== undefined) {
    // Show what is already collected so a user returning to a field can see
    // their current answer instead of re-entering blindly.
    lines.push(`${messages.elicitationAnswerSaved} ${escapeDiscordLiteralText(displayValue(current))}`);
  }
  const isSelect = field.kind === "single-select" || field.kind === "multi-select";
  const isBoolean = field.kind === "boolean";
  const totalFields = request.fields.length;
  // Derived from the passed-in 1-based `index`, NOT `indexOf(field)`: the latter
  // fails when a caller passes a field from a different array instance (a mapped
  // or copied form), yielding -1 and silently dropping every position-dependent
  // control — including the forward navigation a multi-field form needs.
  const position = Math.min(Math.max(0, index - 1), Math.max(0, totalFields - 1));
  const controls: Array<{ label: string; customId: string; style: 1 | 2 | 3 | 4 }> = [];
  // Booleans are answerable in place (yes/no are their options), so only
  // text-like fields need an "Answer" button that opens a modal.
  if (!isSelect && !isBoolean) {
    controls.push({ label: messages.elicitationEdit, customId: elicitationCustomId(token, "field", position), style: 3 });
  }
  // Per-field forward/back. Without these the only way to reach field N>0 is to
  // jump to the review page and use its Edit control — a detour that leaves a
  // mid-wizard user with no obvious way forward.
  if (position > 0) {
    controls.push({ label: truncate(messages.elicitationPrevField, 80), customId: elicitationCustomId(token, "edit", position - 1), style: 2 });
  }
  if (position < totalFields - 1) {
    controls.push({ label: truncate(messages.elicitationNextField, 80), customId: elicitationCustomId(token, "next", position + 1), style: 3 });
  }
  controls.push({ label: messages.elicitationNext, customId: elicitationCustomId(token, "review"), style: 2 });
  controls.push({ label: messages.elicitationDecline, customId: elicitationCustomId(token, "decline"), style: 2 });
  controls.push({ label: messages.elicitationCancel, customId: elicitationCustomId(token, "cancel"), style: 1 });
  return {
    content: truncate(lines.join("\n\n"), MAX_CARD_CHARS),
    components: actionRow(controls),
    selectRows: isSelect
      ? buildElicitationSelectRows(token, field, current, position)
      : isBoolean
        ? buildElicitationBooleanRows(token, field, current, position)
        : [],
    modalAction: !isSelect && !isBoolean,
  };
}

/**
 * Booleans become a two-option String Select rather than a pair of buttons, so
 * `true` and `false` are selected with the same control the user already uses
 * for the next field, and a boolean answer never depends on a button label.
 */
export function buildElicitationBooleanRows(
  token: string,
  field: Extract<ChannelElicitationField, { kind: "boolean" }>,
  current: ChannelElicitationValue | undefined,
  /** 0-based position, used as the control's routing identity (never the key). */
  fieldIndex: number,
): DiscordSelectActionRow[] {
  const messages = getMessages();
  const selected = typeof current === "boolean" ? String(current) : undefined;
  return [
    {
      type: 1,
      components: [
        {
          type: 3 as const,
          customId: elicitationCustomId(token, "field", fieldIndex),
          placeholder: escapeDiscordLiteralText(field.title),
          options: [
            { label: messages.elicitationYes, value: "true", ...(selected === "true" ? { default: true } : {}) },
            { label: messages.elicitationNo, value: "false", ...(selected === "false" ? { default: true } : {}) },
          ],
        },
      ],
    },
  ];
}

/**
 * Review card: every label and its current value, with Edit / Submit / Decline / Cancel.
 *
 * Every field gets an Edit control, but an action row holds 5 buttons and
 * Submit/Decline/Cancel take three. Rather than dropping the fields past the
 * budget — which left field 3+ with no way in at all, and a required field there
 * made Submit unsatisfiable — the row carries a Prev/Next pair and the page
 * advances by index.
 */
export function buildElicitationReviewCard(
  request: ChannelElicitationRequest,
  token: string,
  values: Record<string, ChannelElicitationValue>,
  page = 0,
): { content: string; components: DiscordActionRow[] } {
  const messages = getMessages();
  const lines = [`**${messages.elicitationReview}**`, messages.elicitationFromAgent(escapeDiscordLiteralText(request.agent.name))];
  for (const field of request.fields) {
    const value = values[field.key];
    lines.push(`**${escapeDiscordLiteralText(field.title)}**\n${escapeDiscordLiteralText(value === undefined ? messages.elicitationNoAnswer : displayValue(value))}`);
  }
  // Budget: the row holds 5 buttons. Submit/Decline/Cancel always take 3, and
  // paging takes 2 when needed, so the Edit controls get whatever is left.
  // Getting this wrong is not cosmetic: an over-full row is rejected by Discord,
  // and under-budgeting silently drops fields the user then cannot reach.
  const total = request.fields.length;
  const terminals = 3;
  // Paging costs 2 slots, so a paged page shows (5 - 3 - 2) = 0 fields. That is
  // wrong: a row cannot hold a page control AND any field. Rather than emit an
  // over-full row Discord would reject, a form wider than what fits uses a
  // SECOND row for the paging controls, which the component API allows (up to
  // 5 rows per message) — so all 5 slots stay available for fields.
  const perPage = DISCORD_ACTION_ROW_BUTTON_MAX - terminals;
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const hasPaging = pageCount > 1;
  const clamped = Math.min(Math.max(0, page), pageCount - 1);
  const start = clamped * perPage;
  const controls: Array<{ label: string; customId: string; style: 1 | 2 | 3 | 4 }> = request.fields
    .slice(start, start + perPage)
    .map((field) => ({
      label: truncate(escapeDiscordLiteralText(`${messages.elicitationEdit}: ${field.title}`), 80),
      customId: elicitationCustomId(token, "edit", request.fields.indexOf(field)),
      style: 2 as const,
    }));
  controls.push({ label: messages.elicitationSubmit, customId: elicitationCustomId(token, "submit"), style: 3 });
  controls.push({ label: messages.elicitationDecline, customId: elicitationCustomId(token, "decline"), style: 2 });
  controls.push({ label: messages.elicitationCancel, customId: elicitationCustomId(token, "cancel"), style: 1 });
  const rows = [actionRow(controls)];
  // Paging lives on its own row so it never costs a field slot.
  if (hasPaging) {
    const prevPage = (clamped - 1 + pageCount) % pageCount;
    const nextPage = (clamped + 1) % pageCount;
    rows.push(actionRow([
      { label: truncate(`${messages.elicitationPagePrev} ${prevPage + 1}/${pageCount}`, 80), customId: `${ELICITATION_CUSTOM_ID_PREFIX}${token}:page:${prevPage}`, style: 2 },
      { label: truncate(`${messages.elicitationPageNext} ${nextPage + 1}/${pageCount}`, 80), customId: `${ELICITATION_CUSTOM_ID_PREFIX}${token}:page:${nextPage}`, style: 2 },
    ]));
  }
  const components = rows.flat();
  return { content: truncate(lines.join("\n\n"), MAX_CARD_CHARS), components };
}

export function hintForField(field: ChannelElicitationField): string {
  const messages = getMessages();
  // The plugin-facing contract has exactly five kinds: text, boolean, number,
  // single-select, multi-select. A date/email/uri ACP field arrives as `text`
  // with the format constraint on its schema, and core validates the answer.
  switch (field.kind) {
    case "single-select":
    case "multi-select":
      return messages.elicitationFieldHint;
    case "number":
      return messages.elicitationNumberHint;
    case "boolean":
      return messages.elicitationFieldHint;
    default:
      return messages.elicitationTextHint;
  }
}

/** Render a collected value as literal text for a card. */
export function displayValue(value: ChannelElicitationValue | readonly string[]): string {
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

/**
 * Build the String Select for a select-kind field.
 *
 * `min_values`/`max_values` come from the field, so multi-select enforces
 * min/max at the platform level (which the renderability gate already checked
 * is representable). Options keep their label and description verbatim: the
 * option list is the question, so trimming it would change the answer set.
 */
export function buildElicitationSelectRows(
  token: string,
  field: Extract<ChannelElicitationField, { kind: "single-select" } | { kind: "multi-select" }>,
  current: ChannelElicitationValue | undefined,
  /** 0-based position, used as the control's routing identity (never the key). */
  fieldIndex: number,
): DiscordSelectActionRow[] {
  const selected = current === undefined
    ? []
    : Array.isArray(current)
      ? current.map(String)
      : [String(current)];
  // A schema default is shown as the CURRENT selection, not as an invisible
  // pre-fill: the ACP contract requires the user be able to review and modify,
  // and a default they cannot see is one they cannot change.
  const shown = selected.length > 0
    ? selected
    : field.defaultValue === undefined
      ? []
      : Array.isArray(field.defaultValue)
        ? [...field.defaultValue]
        : [String(field.defaultValue)];
  return [
    {
      type: 1,
      components: [
        {
          type: 3 as const,
          customId: elicitationCustomId(token, "field", fieldIndex),
          placeholder: escapeDiscordLiteralText(field.title),
          ...(field.kind === "multi-select"
            ? {
                ...(field.minItems !== undefined ? { minValues: field.minItems } : {}),
                ...(field.maxItems !== undefined ? { maxValues: field.maxItems } : {}),
              }
            : {}),
          options: field.options.map((option) => ({
            label: escapeDiscordLiteralText(option.label),
            // The value is the correlation identity core validates; it is not
            // rendered, but it must be exact so the answer maps back.
            value: option.value,
            ...(option.description !== undefined ? { description: escapeDiscordLiteralText(option.description) } : {}),
            ...(shown.includes(option.value) ? { default: true } : {}),
          })),
        },
      ],
    },
  ];
}

/**
 * Build the modal for a text-like field.
 *
 * The modal's custom_id is the TOKEN only; each Text Input's custom_id is the
 * FIELD KEY. No answer travels in either, which is what makes a modal payload
 * safe to log: the answer is in the payload body, not in any identifier.
 */
export function buildElicitationModal(
  token: string,
  field: ChannelElicitationField,
  current: ChannelElicitationValue | undefined,
): ShowModalInput {
  const messages = getMessages();
  const kind = field.kind;
  const prefill = typeof current === "string" ? current : typeof field.defaultValue === "string" ? field.defaultValue : "";
  return {
    title: truncate(messages.elicitationTitle, 45),
    customId: elicitationModalCustomId(token),
    components: [
      {
        // 45 characters is the platform's label cap, already enforced by the
        // renderability gate, so no truncation is needed here.
        label: field.title,
        component: {
          type: 4 as const,
          customId: field.key,
          style: field.kind === "text" ? 2 : 1,
          label: field.title,
          required: field.required,
          ...(prefill ? { value: prefill } : {}),
          // The platform's own upper bound. Core-side string bounds (`minLength`
          // / `maxLength`) exist only on the ACP schema and are NOT part of the
          // plugin contract, so the renderer does not forward them; core
          // remains authoritative on answer validation.
          maxLength: 4000,
        },
      },
    ],
  };
}

/**
 * Convert a modal submit into the answer value the core validator expects.
 *
 * The conversion is type-directed and never coerces: a numeric field with
 * non-numeric input produces NO answer (leaving the field unanswered) rather
 * than `NaN`, because `NaN` would serialize into a JSON-RPC response as
 * `null` and look like a valid answer to a consumer that does not re-check.
 * Core's answer validator remains authoritative either way.
 */
export function parseModalAnswer(field: ChannelElicitationField, raw: string): ChannelElicitationValue | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  switch (field.kind) {
    case "number": {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) return undefined;
      // `integer` is the field's own flag: the plugin contract has no separate
      // integer kind, so a fractional answer to an integer field is rejected
      // rather than silently rounded.
      if (field.integer && !Number.isInteger(parsed)) return undefined;
      // The field's own bounds are enforced here as well as by core, so an
      // out-of-range value is rejected before the user is asked to submit.
      if (field.minimum !== undefined && parsed < field.minimum) return undefined;
      if (field.maximum !== undefined && parsed > field.maximum) return undefined;
      return parsed;
    }
    case "boolean": {
      if (/^(true|yes|y|1)$/i.test(trimmed)) return true;
      if (/^(false|no|n|0)$/i.test(trimmed)) return false;
      return undefined;
    }
    case "multi-select":
      return trimmed.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
    default:
      return trimmed;
  }
}

/**
 * Parse a modal submit's custom id.
 *
 * Separate from `parseElicitationCustomId` because a modal id legitimately
 * resolves to no button action: it must not be coerced into one. A modal whose
 * id does not match exactly is dropped rather than guessed at.
 */
export function parseElicitationModalCustomId(customId: string): { token: string } | null {
  if (!customId.startsWith(ELICITATION_CUSTOM_ID_PREFIX)) return null;
  const rest = customId.slice(ELICITATION_CUSTOM_ID_PREFIX.length);
  const match = /^([0-9a-f]{32}):modal$/.exec(rest);
  if (!match) return null;
  return { token: match[1]! };
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
      enterWizard(entry);
      // A zero-field form has nothing to ask, but it is NOT a dead end: M1 keeps
      // `accept` + `content: null` precisely for this, so Start goes straight to
      // the review page where Submit is the only way to accept. Returning
      // without a rerender left the user with Decline/Cancel and no way to
      // confirm, which turned a legal form into a timeout.
      if (entry.currentField === undefined) {
        entry.visitedReview = true;
        await input.interaction.acknowledge();
        return { decided: false, rerender: "review" };
      }
      await input.interaction.acknowledge();
      return { decided: false, rerender: "field" };
    }
    case "field":
    case "edit": {
      // Route to the requested field by POSITION. Answers are not carried here
      // (there is no slot for one).
      if (parsed.fieldIndex !== undefined && entry.request.fields[parsed.fieldIndex]) {
        entry.currentField = entry.request.fields[parsed.fieldIndex]!.key;
      } else if (!entry.currentField) {
        entry.currentField = entry.request.fields[0]?.key;
      }
      await input.interaction.acknowledge();
      return { decided: false, rerender: "field" };
    }
    case "next": {
      // Advance to the named field. This is NAVIGATION, not answering: only
      // `field` opens a modal, and conflating the two meant a forward control
      // silently opened a modal instead of moving the wizard on.
      if (parsed.fieldIndex !== undefined && entry.request.fields[parsed.fieldIndex]) {
        entry.currentField = entry.request.fields[parsed.fieldIndex]!.key;
      }
      await input.interaction.acknowledge();
      return { decided: false, rerender: "field" };
    }
    case "page": {
      // Review paging. Positional, like field routing.
      await input.interaction.acknowledge();
      return { decided: false, rerender: "review" };
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

