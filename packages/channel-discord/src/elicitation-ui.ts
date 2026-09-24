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
import {
  DISCORD_ACTION_ROW_BUTTON_MAX,
  DISCORD_SELECT_OPTION_DESCRIPTION_MAX,
  DISCORD_SELECT_OPTION_LABEL_MAX,
  DISCORD_SELECT_PLACEHOLDER_MAX,
  DISCORD_TEXT_CAPTURE_MAX,
} from "./elicitation-limits.js";
import {
  buildAnswerContent,
  markSkipped,
  nextUnresolvedKey,
  trySettle,
} from "./elicitation-state.js";
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
  | "skip"
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
  skip: "skip",
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
  if (action === "page" || action === "next" || action === "skip") {
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

/**
 * Custom id for a modal's Text Input, POSITIONAL for the same reason as
 * `elicitationCustomId`. Rendered as a bare index so the modal submit handler
 * can tell it apart from the wrapper id (`<prefix><token>:modal`) without
 * parsing the modal wrapper as a button custom id.
 */
export function elicitationFieldCustomId(fieldIndex: number): string {
  if (!Number.isInteger(fieldIndex) || fieldIndex < 0) {
    throw new Error("elicitation field custom id requires a non-negative field index");
  }
  return `f:${Math.min(fieldIndex, 999)}`;
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
    // POSITIONAL, like `field`/`edit`/`next`. `skip` used to carry no field
    // identity and resolved the field from the shared `entry.currentField`
    // cursor at handling time. Two stale Skip interactions delivered together
    // therefore skipped two DIFFERENT fields — the cursor advanced between them
    // — and if the second field already had an answer, `markSkipped` deleted it.
    // Being positional makes a Skip idempotent on the field it names: a duplicate
    // re-skips the same field, which is a no-op.
    case "skip":
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

/**
 * Parse a modal Text Input custom id back to its field position.
 *
 * Returns null for anything that is not exactly `f:<non-negative integer>`, so
 * a payload with an unrecognised component cannot be coerced into routing to
 * field 0 and overwrite the wrong answer.
 */
export function parseElicitationFieldCustomId(customId: string): number | null {
  const match = /^f:(\d+)$/.exec(customId);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) && index >= 0 ? index : null;
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
function actionRow(entries: Array<{ label: string; customId: string; style: ButtonStyle; disabled?: boolean }>): DiscordActionRow[] {
  if (entries.length === 0) return [];
  return [{
    type: 1,
    components: entries.map((entry) => button(entry.label, entry.customId, entry.style, entry.disabled ?? false)),
  }];
}

/**
 * Bound a rendered string, appending an ellipsis when it is cut.
 *
 * Used ONLY for text that carries no decision content the user must read in
 * full — a button label, a select placeholder. For anything the user must
 * actually see before deciding, `chunkCardText` is the right tool: truncation
 * there would silently hide what they are being asked.
 */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Hard ceiling per card. */
const MAX_CARD_CHARS = 1800;

/**
 * Split rendered text into card-sized chunks WITHOUT losing content.
 *
 * Every previous version called `truncate(...)` on the joined body and accepted
 * whatever survived. That is a correctness bug, not a cosmetic one: the agent's
 * `message` can be 8000 characters, and a review page's answer can be 4000, so
 * the part the user was supposed to be reading before deciding could simply be
 * gone while the Submit control stayed enabled. ACP requires the user to be able
 * to review what they are sending.
 *
 * Chunking preserves every character across several messages; the caller is
 * responsible for attaching controls to the LAST one (or the only one).
 */
export function chunkCardText(text: string, limit = MAX_CARD_CHARS): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  // Split on paragraph boundaries first, then hard-cut an over-long paragraph:
  // cutting mid-sentence at a character boundary is the last resort, and it
  // still loses nothing because the pieces are concatenated by the reader.
  const paragraphs = text.split("\n\n");
  let current = "";
  for (const paragraph of paragraphs) {
    if (paragraph.length > limit) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let offset = 0; offset < paragraph.length; offset += limit) {
        chunks.push(paragraph.slice(offset, offset + limit));
      }
      continue;
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    current = paragraph;
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Opening card: agent identity, the agent's own message, and the three
 * distinct ACP entry actions.
 *
 * `agent.name` is rendered from the CORRELATED agent identity, never inferred
 * from `message`: the request text is agent-controlled and could claim to be
 * from someone else.
 *
 * Returns `contents` — every chunk — rather than a single truncated string. The
 * agent's message is the question the user is answering; cutting it would change
 * what they were asked.
 */
export function buildElicitationOpening(request: ChannelElicitationRequest, token: string): {
  content: string;
  /** All chunks; the first is `content`, and each further one is sent after it. */
  contents: string[];
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
  const chunks = chunkCardText(lines.join("\n\n"));
  return { content: chunks[0]!, contents: chunks, components };
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
  // Two rows. A single row can only hold 5 buttons, and a mid-wizard text field
  // needs Answer + Prev + Next + Review + Decline + Cancel = 6, which Discord
  // rejects outright — a form whose second field can never be drawn at all.
  // Review/Decline/Cancel are terminal decisions and share one row; per-field
  // controls live on the other so a field never loses its Answer control to
  // navigation.
  const fieldControls: Array<{ label: string; customId: string; style: 1 | 2 | 3 | 4 }> = [];
  // Booleans are answerable in place (yes/no are their options), so only
  // text-like fields need an "Answer" button that opens a modal.
  if (!isSelect && !isBoolean) {
    fieldControls.push({ label: messages.elicitationEdit, customId: elicitationCustomId(token, "field", position), style: 3 });
  }
  // Skip is offered ONLY for optional fields, and it is the only way back to
  // "no answer". A text field cleared to "" is a real answer, not an omission,
  // so there must be a distinct control for the omission itself. A required
  // field may never be skipped — core would reject the submission.
  if (!field.required) {
    fieldControls.push({
      label: truncate(messages.elicitationSkip, 80),
      // The field's own position, not a bare action: see the codec. A Skip that
      // names its field is idempotent when Discord retries or a user double-taps.
      customId: elicitationCustomId(token, "skip", position),
      style: 2,
    });
  }
  // Per-field forward/back. Without these the only way to reach field N>0 is to
  // jump to the review page and use its Edit control — a detour that leaves a
  // mid-wizard user with no obvious way forward.
  if (position > 0) {
    fieldControls.push({ label: truncate(messages.elicitationPrevField, 80), customId: elicitationCustomId(token, "edit", position - 1), style: 2 });
  }
  if (position < totalFields - 1) {
    fieldControls.push({ label: truncate(messages.elicitationNextField, 80), customId: elicitationCustomId(token, "next", position + 1), style: 3 });
  }
  fieldControls.push({ label: messages.elicitationNext, customId: elicitationCustomId(token, "review"), style: 2 });
  const terminalControls: Array<{ label: string; customId: string; style: 1 | 2 | 3 | 4 }> = [
    { label: messages.elicitationDecline, customId: elicitationCustomId(token, "decline"), style: 2 },
    { label: messages.elicitationCancel, customId: elicitationCustomId(token, "cancel"), style: 1 },
  ];
  return {
    content: chunkCardText(lines.join("\n\n"))[0]!,
    components: [...actionRow(fieldControls), ...actionRow(terminalControls)],
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
          placeholder: truncate(field.title, DISCORD_SELECT_PLACEHOLDER_MAX),
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
  options: { submitDisabled?: boolean } = {},
): {
  content: string;
  /**
   * Every chunk of the review text, in order. A single legal answer is 4000
   * characters and a card holds 1800, so the review of a real form can span
   * several messages. Returning only `[0]` and dropping the rest is the earlier
   * bug: the user could not read what they were approving, while Submit stayed
   * enabled. The caller sends/edits the continuations and attaches the controls
   * to the FIRST chunk.
   */
  contents: string[];
  components: DiscordActionRow[];
} {
  const messages = getMessages();
  const lines = [`**${messages.elicitationReview}**`, messages.elicitationFromAgent(escapeDiscordLiteralText(request.agent.name))];
  for (const field of request.fields) {
    const present = Object.hasOwn(values, field.key);
    lines.push(
      `**${escapeDiscordLiteralText(field.title)}**\n${escapeDiscordLiteralText(
        present ? displayValue(values[field.key]!) : messages.elicitationNoAnswer,
      )}`,
    );
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
  const pageEnd = start + perPage;
  const pageFields = request.fields.slice(start, pageEnd);
  const controls: Array<{ label: string; customId: string; style: 1 | 2 | 3 | 4; disabled?: boolean }> = pageFields
    .map((field) => ({
      label: truncate(escapeDiscordLiteralText(`${messages.elicitationEdit}: ${field.title}`), 80),
      customId: elicitationCustomId(token, "edit", request.fields.indexOf(field)),
      style: 2 as const,
    }));
  controls.push({
    label: messages.elicitationSubmit,
    customId: elicitationCustomId(token, "submit"),
    style: 3,
    // A disabled Submit is the transactional gate for multi-message reviews.
    // Continuation edits happen in place, so a failure part-way through leaves
    // the channel holding a MIX of the old and new review. The old primary is
    // itself a review card and its Submit is live unless it is disabled first,
    // which would let the user approve content they were never shown intact.
    ...(options.submitDisabled ? { disabled: true } : {}),
  });
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
  // The TEXT pages with the controls, and over exactly the same field window:
  // rendering the whole form and then truncating to the card budget meant a long
  // form's later answers simply were not shown, while Submit stayed enabled —
  // the user could not review what they were sending, which is exactly what ACP
  // review-before-send forbids. The page indicator is carried in the paging
  // controls' labels, so the user always knows how many answers remain.
  const pagedLines = pageCount > 1
    ? [
        `${lines[0]!} (${clamped + 1}/${pageCount})`,
        lines[1]!,
        ...pageFields.map((field) => {
          const present = Object.hasOwn(values, field.key);
          return `**${escapeDiscordLiteralText(field.title)}**\n${escapeDiscordLiteralText(
            present ? displayValue(values[field.key]!) : messages.elicitationNoAnswer,
          )}`;
        }),
      ]
    : lines;
  const components = rows.flat();
  // Chunked, not truncated: a single legal answer can be 4000 characters, so a
  // 1800-char card would hide part of what the user is being asked to approve
  // while leaving Submit enabled. Every chunk is returned so the caller can
  // show all of them; `chunkCardText` splits without losing content.
  const contents = chunkCardText(pagedLines.join("\n\n"));
  return { content: contents[0]!, contents, components };
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
          placeholder: truncate(field.title, DISCORD_SELECT_PLACEHOLDER_MAX),
          ...(field.kind === "multi-select"
            ? {
                ...(field.minItems !== undefined ? { minValues: field.minItems } : {}),
                ...(field.maxItems !== undefined ? { maxValues: field.maxItems } : {}),
              }
            : {}),
          options: field.options.map((option) => ({
            // NOT escaped: a select option's label is not Markdown, so passing it
            // through the message-markdown escaper would DOUBLE the backslashes
            // Discord renders, and — worse — mean the length checked by the
            // renderability gate (on the raw string) no longer matches the length
            // actually sent. Discord does not interpret Markdown here, and
            // `allowedMentions: { parse: [] }` at send time already neutralises the
            // only injection class available in these surfaces.
            label: truncate(option.label, DISCORD_SELECT_OPTION_LABEL_MAX),
            // The value is the correlation identity core validates; it is not
            // rendered, but it must be exact so the answer maps back.
            value: option.value,
            ...(option.description !== undefined
              ? { description: truncate(option.description, DISCORD_SELECT_OPTION_DESCRIPTION_MAX) }
              : {}),
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
 * The modal's custom_id is the TOKEN only. Text Input custom_ids are
 * POSITIONAL (`f:<index>`), not the schema key: core guarantees a key is a
 * bounded JSON property name but nothing about its character make-up or
 * length, and Discord caps component `custom_id` at 100 characters. A legal
 * 101-character text key therefore produced a modal the platform rejects.
 * Positional ids are also shorter, which keeps the ids loggable.
 */
export function buildElicitationModal(
  token: string,
  field: ChannelElicitationField,
  current: ChannelElicitationValue | undefined,
  fieldIndex: number,
): ShowModalInput {
  const messages = getMessages();
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
          customId: elicitationFieldCustomId(fieldIndex),
          style: field.kind === "text" ? 2 : 1,
          label: field.title,
          required: field.required,
          ...(prefill ? { value: prefill } : {}),
          // The schema's own bounds, pushed into the control wherever the
          // platform can express them, so the widget enforces the same contract
          // core does instead of the user typing something it will reject. The
          // renderability gate has already refused any bound past the
          // platform's capacity, so this is an exact mapping, not a clamp.
          // Only `text` carries these — a number field is bounded numerically.
          ...(field.kind === "text" && field.minLength !== undefined ? { minLength: field.minLength } : {}),
          maxLength: Math.min(
            field.kind === "text" ? field.maxLength ?? DISCORD_TEXT_CAPTURE_MAX : DISCORD_TEXT_CAPTURE_MAX,
            DISCORD_TEXT_CAPTURE_MAX,
          ),
        },
      },
    ],
  };
}

/**
 * Convert a modal submit into the answer value the core validator expects.
 *
 * The conversion is type-directed and never coerces. Text is passed through
 * EXACTLY as typed — `raw.trim()` would make `"  foo  "` and `"foo"` the same
 * answer, while core's validator compares the raw string, so a trimmed value
 * either gets rejected as something the user never typed or is silently
 * rewritten. Only NUMBER parsing trims, because `Number(" 4 ")` is a numeric
 * spelling rather than the value itself.
 *
 * An empty string is a LEGAL ANSWER (`minLength: 0`) and is preserved. A
 * blank field is NOT recorded at all: "no answer" and "answered empty" are
 * different statements in ACP, and collapsing them would let a required field
 * pass on a form the user never filled in.
 */
export function parseModalAnswer(field: ChannelElicitationField, raw: string): ChannelElicitationValue | undefined {
  switch (field.kind) {
    case "number": {
      const trimmed = raw.trim();
      if (trimmed.length === 0) return undefined;
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
      const trimmed = raw.trim();
      if (/^(true|yes|y|1)$/i.test(trimmed)) return true;
      if (/^(false|no|n|0)$/i.test(trimmed)) return false;
      return undefined;
    }
    case "multi-select":
      return raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
    default:
      // Text: the exact string the user typed. `""` is a legal answer under
      // `minLength: 0`, so it is returned rather than dropped.
      return raw;
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
    case "skip": {
      // Explicit "leave this field unanswered", including clearing an answer the
      // user already gave: value -> omitted is part of review-and-modify, and
      // an empty string cannot stand in for it because an empty string is a real
      // answer.
      //
      // The field comes from the interaction's OWN position, never from
      // `entry.currentField`. That cursor is mutable and two Skip interactions
      // delivered together would otherwise skip two DIFFERENT fields — the
      // second reading a cursor the first had already advanced — and a field
      // that already had an answer would lose it. Naming the field makes a
      // duplicate Skip a no-op on the same field.
      const named = parsed.fieldIndex !== undefined ? entry.request.fields[parsed.fieldIndex] : undefined;
      if (!named) return { decided: false };
      if (named.required) {
        // A required field cannot be skipped; skipping it would send a form
        // core must reject.
        await input.interaction.replyEphemeral(messages.elicitationRequired);
        return { decided: false };
      }
      markSkipped(entry, named.key);
      // Park the wizard on the field the Skip named, so a stale interaction from
      // an older card still moves to the correct next question rather than
      // wherever the cursor happens to be.
      entry.currentField = named.key;
      const next = nextUnresolvedKey(entry);
      if (next) {
        entry.currentField = next;
        await input.interaction.acknowledge();
        return { decided: false, rerender: "field" };
      }
      entry.visitedReview = true;
      await input.interaction.acknowledge();
      return { decided: false, rerender: "review" };
    }
    case "submit": {
      // Refuse a submit while a multi-message review is mid-transaction. Discord
      // disables the control, but a stale interaction can still arrive (or the
      // gate flag can be set by a rerender that failed), and honouring one would
      // approve a mixed review. The state machine is the real gate; the disabled
      // button is only the visible half.
      if (entry.submitGateClosed) {
        await input.interaction.replyEphemeral(messages.elicitationReviewUpdating);
        return { decided: false };
      }
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
  const missing = entry.request.fields.filter((field) => field.required && !Object.hasOwn(entry.values, field.key));
  if (missing.length > 0) {
    // Stay on the review page and point at the first gap.
    await input.interaction.replyEphemeral(`${messages.elicitationRequired}: ${missing[0]!.title}`);
    return { decided: false };
  }
  if (!trySettle(entry)) {
    await input.interaction.replyEphemeral(messages.elicitationAlreadyResolved);
    return { decided: false };
  }
  // `null` is ACP's "accept with no answers" and is deliberately distinct from
  // an empty object. Built own-property-only on a null-prototype map: a spread
  // would also inherit `toString` and friends into the answer set, and core's
  // validator rejects keys it was not asked for.
  const content = buildAnswerContent(entry);
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

