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
  findRejectedAnswer,
  buildElicitationFieldLines,
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
 * Build a custom id from token + revision + routing identity only. Deliberately
 * has no slot for a field value: a `custom_id` is echoed in every interaction
 * payload, so encoding an answer there would leak it into Discord's own logs.
 *
 * `fieldIndex` is a POSITION, never the schema key. Core guarantees a key is a
 * bounded JSON property name and nothing more — `env.prod`, `a/b` and keys past
 * any character budget are all legal. Carrying the key meant truncating and
 * stripping it, then matching the stripped form back against the original, which
 * silently lost the field. An index is always expressible, and the pending state
 * maps it back to the exact field.
 *
 * `revision` is the card REVISION this control was drawn on. Discord serialises
 * UI renders but not the answer state they write, so a select or modal answer
 * that arrives after the wizard has moved on would otherwise record a value the
 * user is no longer looking at — `prod -> Review -> Edit -> staging -> Review ->
 * delayed old select(prod)` left memory holding prod while the review card on
 * screen showed staging, and the next Submit sent what the user never saw.
 * Encoding the revision makes every control a statement about the card it came
 * from, which is the only way the write can be validated.
 */
export function elicitationCustomId(
  token: string,
  action: ElicitationUiAction,
  fieldIndex?: number,
  revision?: number,
): string {
  const revisionSegment = revision === undefined ? "" : `:${revision}`;
  if (action === "page" || action === "next" || action === "skip") {
    if (fieldIndex === undefined || !Number.isInteger(fieldIndex) || fieldIndex < 0) {
      throw new Error(`elicitation custom id action "${action}" requires a page index`);
    }
    return `${ELICITATION_CUSTOM_ID_PREFIX}${token}:${ACTION_SEGMENTS[action]}:${fieldIndex}${revisionSegment}`;
  }
  if (action !== "field" && action !== "edit") {
    if (fieldIndex !== undefined) throw new Error(`elicitation custom id must not carry a field for action "${action}"`);
    return `${ELICITATION_CUSTOM_ID_PREFIX}${token}:${ACTION_SEGMENTS[action]}${revisionSegment}`;
  }
  if (fieldIndex === undefined || !Number.isInteger(fieldIndex) || fieldIndex < 0) {
    throw new Error(`elicitation custom id action "${action}" requires a field index`);
  }
  // Bounded so a pathological field count cannot overflow the id; Discord caps
  // custom ids at 100 chars and this stays far inside it.
  const boundedIndex = Math.min(fieldIndex, 999).toString();
  return `${ELICITATION_CUSTOM_ID_PREFIX}${token}:${ACTION_SEGMENTS[action]}:${boundedIndex}${revisionSegment}`;
}

/** Custom id for the modal wrapper itself; the field identity rides inside. */
export function elicitationModalCustomId(token: string, revision?: number): string {
  return `${ELICITATION_CUSTOM_ID_PREFIX}${token}:${ELICITATION_MODAL_ACTION}${revision === undefined ? "" : `:${revision}`}`;
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
): { token: string; action: ElicitationUiAction; fieldIndex?: number; revision?: number } | null {
  if (!customId.startsWith(ELICITATION_CUSTOM_ID_PREFIX)) return null;
  const rest = customId.slice(ELICITATION_CUSTOM_ID_PREFIX.length);
  // Layout is `<token>:<action>[:<fieldIndex>][:revision]`. The token is a fixed
  // 32-char hex slug, so it is read FIRST rather than by "split on the last
  // colon" (the permission shape): token length is known, and the action/field
  // segments are then unambiguous. Splitting on the last colon would leak a field
  // identity into the token slot and silently mis-route the callback.
  const tokenPattern = /^[0-9a-f]{32}/;
  const match = tokenPattern.exec(rest);
  if (!match) return null;
  const token = match[0];
  const tail = rest.slice(token.length);
  if (!tail.startsWith(":")) return null;
  const segments = tail.slice(1).split(":");
  const action = segments[0];
  let fieldIndex: number | undefined;
  let revision: number | undefined;
  // HELPERS
  const readRevision = (slot: number): boolean => {
    const raw = segments[slot];
    if (raw === undefined) return true;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) return false;
    revision = value;
    return true;
  };
  switch (action) {
    case "start":
    case "review":
    case "submit":
    case "decline":
    case "cancel":
      // One or two segments: the action alone, plus an optional revision.
      if (segments.length !== 1 && segments.length !== 2) return null;
      if (!readRevision(1)) return null;
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
      // Two or three: field/page index, plus an optional revision.
      if (segments.length !== 2 && segments.length !== 3) return null;
      fieldIndex = Number(segments[1]);
      if (!Number.isInteger(fieldIndex) || fieldIndex < 0) return null;
      if (!readRevision(2)) return null;
      // MANDATORY for these. Every one of them either opens a route the user
      // must be able to see (`field` opens a modal) or writes answer state
      // (`skip` deletes an answer), and none of them is a decision the user
      // repeats intentionally. An id without a revision therefore came from
      // something that is not a card this renderer published — it has no card to
      // belong to — and it is refused rather than granted the current revision
      // at handling time, which is what let a stale Skip delete a fresh answer.
      //
      // The terminal outcomes above deliberately stay OPTIONAL: a replayed
      // Decline or Cancel is still a decline the user made on a card they saw,
      // and the answer must not be invented for them.
      if (segments.length === 2) return null;
      break;
    default:
      return null;
  }
  return {
    token,
    action: action as ElicitationUiAction,
    ...(fieldIndex !== undefined ? { fieldIndex } : {}),
    ...(revision !== undefined ? { revision } : {}),
  };
}

/**
 * Parse the modal wrapper custom id back to its token and revision.
 *
 * The layout is `<prefix><token>:modal[:revision]`. The field identity does NOT
 * ride here — it comes from the Text Input ids in the submit payload — so this
 * only recovers the correlation handle and the revision the modal was opened
 * from, which the handler uses to reject a modal submitted after the card moved
 * on.
 */
export function parseElicitationModalCustomId(
  customId: string,
): { token: string; revision?: number } | null {
  if (!customId.startsWith(ELICITATION_CUSTOM_ID_PREFIX)) return null;
  const rest = customId.slice(ELICITATION_CUSTOM_ID_PREFIX.length);
  const tokenPattern = /^[0-9a-f]{32}:modal/;
  const match = tokenPattern.exec(rest);
  if (!match) return null;
  const token = match[0].slice(0, 32);
  const rest_ = rest.slice(match[0].length);
  if (rest_ === "") return { token };
  if (!rest_.startsWith(":")) return null;
  const raw = rest_.slice(1);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return null;
  return { token, revision: value };
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
 * Where a Discord message may be cut without losing content.
 *
 * Two kinds of boundary must never be crossed, and a raw
 * `paragraph.slice(offset, offset + limit)` crosses both:
 *
 *   - inside an ESCAPE ATOM. `escapeDiscordLiteralText` writes `\` before every
 *     Markdown metacharacter, so `>` becomes `\>`. Cutting between those two
 *     characters leaves the next message starting with a BARE `>`, which Discord
 *     renders as a blockquote — the escape was spent and the structure the
 *     escaper removed is back. The same applies to `\*`, `\_`, `\``, `\~`, `\#`.
 *   - inside a surrogate pair. JS slices by UTF-16 code unit, so a cut between
 *     the halves of an emoji emits one unpaired surrogate per message and the
 *     character is unrecoverable on both sides.
 *
 * Backing up to a boundary is safe in both directions and never changes what the
 * reader sees, because the pieces are concatenated by the reader.
 */
function safeCutEnd(text: string, offset: number, limit: number): number {
  let end = Math.min(offset + limit, text.length);
  // The cut landed between a `\` and the metacharacter it introduces: pull the
  // whole escape atom into this chunk, so the next message never opens with a
  // bare metacharacter. `intro === end - 1` means the `\` is the last character
  // that would be kept, and its partner would start the next chunk.
  const intro = text.lastIndexOf("\\", end - 1);
  if (intro !== -1 && intro >= offset && intro === end - 1) {
    end = intro;
  }
  // Back up over a high surrogate whose low half would be split off.
  while (end > offset) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    else break;
  }
  return end;
}

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
 *
 * A cut moves BACKWARD to a boundary that keeps both the escape atoms and the
 * surrogate pairs whole, so a chunk boundary can never reactivate escaped Markdown
 * (`>` in particular renders as a blockquote) or split a character.
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
      for (let offset = 0; offset < paragraph.length;) {
        const end = safeCutEnd(paragraph, offset, limit);
        // A pathological run of escape introducers could make the safe cut
        // empty; advance by one so the loop always terminates.
        chunks.push(paragraph.slice(offset, Math.max(end, offset + 1)));
        offset = Math.max(end, offset + 1);
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
export function buildElicitationOpening(
  request: ChannelElicitationRequest,
  token: string,
  revision?: number,
): {
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
    { label: messages.elicitationStart, customId: elicitationCustomId(token, "start", undefined, revision), style: 3 },
    { label: messages.elicitationDecline, customId: elicitationCustomId(token, "decline", undefined, revision), style: 2 },
    { label: messages.elicitationCancel, customId: elicitationCustomId(token, "cancel", undefined, revision), style: 1 },
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
  revision?: number,
): {
  content: string;
  /**
   * Every chunk of the field text, in order — the same shape as the opening and
   * review cards.
   *
   * Taking only `[0]` was the bug: the renderability gate measures a description
   * by RAW length (core allows 1000), but escaping expands Markdown metacharacters
   * up to 2x, so a 1000-char description of `*` chars becomes ~2000 escaped chars.
   * Added to the title, agent identity and hint, that is several chunks, and every
   * one past the first was silently discarded — the question the user was
   * answering was cut off while the controls stayed enabled.
   */
  contents: string[];
  components: DiscordActionRow[];
  selectRows: DiscordSelectActionRow[];
  modalAction: boolean;
} {
  const messages = getMessages();
  const lines = buildElicitationFieldLines(request, field, index, current);
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
    fieldControls.push({ label: messages.elicitationEdit, customId: elicitationCustomId(token, "field", position, revision), style: 3 });
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
      customId: elicitationCustomId(token, "skip", position, revision),
      style: 2,
    });
  }
  // Per-field forward/back. Without these the only way to reach field N>0 is to
  // jump to the review page and use its Edit control — a detour that leaves a
  // mid-wizard user with no obvious way forward.
  if (position > 0) {
    fieldControls.push({ label: truncate(messages.elicitationPrevField, 80), customId: elicitationCustomId(token, "edit", position - 1, revision), style: 2 });
  }
  if (position < totalFields - 1) {
    fieldControls.push({ label: truncate(messages.elicitationNextField, 80), customId: elicitationCustomId(token, "next", position + 1, revision), style: 3 });
  }
  fieldControls.push({ label: messages.elicitationNext, customId: elicitationCustomId(token, "review", undefined, revision), style: 2 });
  const terminalControls: Array<{ label: string; customId: string; style: 1 | 2 | 3 | 4 }> = [
    { label: messages.elicitationDecline, customId: elicitationCustomId(token, "decline", undefined, revision), style: 2 },
    { label: messages.elicitationCancel, customId: elicitationCustomId(token, "cancel", undefined, revision), style: 1 },
  ];
  const chunked = chunkCardText(lines.join("\n\n"));
  // A field card is ONE message, and it must stay that way.
  //
  // Returning every chunk here would hand the channel a Wizard step whose text
  // spans several messages, and that is where this gets unsound: a field card is
  // re-rendered from an interaction, from a modal, and from a review->Edit jump,
  // and a continuation set written by one of those while another is still in
  // flight ends up misaligned — the review edits continuation 0, leaves 1 holding
  // the PREVIOUS answer, and creates a new message instead of reusing it. The
  // user is then shown both answers with no way to tell which one Submit sends.
  //
  // So the renderability gate is what keeps a field page renderable: it builds
  // this exact text through `buildElicitationFieldLines` — the SAME definition —
  // and refuses a form whose field text cannot fit one message. If the builder and
  // the gate ever disagree again, that is a bug in one of them, and it must be
  // loud: throwing surfaces it instead of quietly cutting the question the user is
  // answering, which is the failure this whole budget exists to prevent.
  if (chunked.length > 1) {
    throw new Error(
      `elicitation field card for ${JSON.stringify(field.key)} needs ${chunked.length} messages; the renderability gate should have refused it`,
    );
  }
  return {
    content: chunked[0]!,
    contents: chunked,
    components: [...actionRow(fieldControls), ...actionRow(terminalControls)],
    selectRows: isSelect
      ? buildElicitationSelectRows(token, field, current, position, revision)
      : isBoolean
        ? buildElicitationBooleanRows(token, field, current, position, revision)
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
  revision?: number,
): DiscordSelectActionRow[] {
  const messages = getMessages();
  const selected = typeof current === "boolean" ? String(current) : undefined;
  return [
    {
      type: 1,
      components: [
        {
          type: 3 as const,
          customId: elicitationCustomId(token, "field", fieldIndex, revision),
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
  options: { submitDisabled?: boolean; revision?: number } = {},
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
      customId: elicitationCustomId(token, "edit", request.fields.indexOf(field), options.revision),
      style: 2 as const,
    }));
  controls.push({
    label: messages.elicitationSubmit,
    customId: elicitationCustomId(token, "submit", undefined, options.revision),
    style: 3,
    // A disabled Submit is the transactional gate for multi-message reviews.
    // Continuation edits happen in place, so a failure part-way through leaves
    // the channel holding a MIX of the old and new review. The old primary is
    // itself a review card and its Submit is live unless it is disabled first,
    // which would let the user approve content they were never shown intact.
    ...(options.submitDisabled ? { disabled: true } : {}),
  });
  controls.push({ label: messages.elicitationDecline, customId: elicitationCustomId(token, "decline", undefined, options.revision), style: 2 });
  controls.push({ label: messages.elicitationCancel, customId: elicitationCustomId(token, "cancel", undefined, options.revision), style: 1 });
  const rows = [actionRow(controls)];
  // Paging lives on its own row so it never costs a field slot.
  if (hasPaging) {
    const prevPage = (clamped - 1 + pageCount) % pageCount;
    const nextPage = (clamped + 1) % pageCount;
    rows.push(actionRow([
      { label: truncate(`${messages.elicitationPagePrev} ${prevPage + 1}/${pageCount}`, 80), customId: elicitationCustomId(token, "page", prevPage, options.revision), style: 2 },
      { label: truncate(`${messages.elicitationPageNext} ${nextPage + 1}/${pageCount}`, 80), customId: elicitationCustomId(token, "page", nextPage, options.revision), style: 2 },
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
  revision?: number,
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
          customId: elicitationCustomId(token, "field", fieldIndex, revision),
          placeholder: truncate(field.title, DISCORD_SELECT_PLACEHOLDER_MAX),
          ...(field.kind === "multi-select"
            ? {
                // Discord's String Select DEFAULTS to 1/1 when a bound is
                // omitted, so leaving them out silently redefines the schema:
                // a multi-select with no bounds became "pick exactly one", and
                // `{ minItems: 2 }` with no `maxItems` became a component
                // demanding at least 2 while allowing at most 1 — self-
                // contradictory, and rejected by the platform.
                //
                // Both bounds are therefore stated EXPLICITLY, normalised to the
                // domain core will actually accept:
                //
                //   minValues = minItems ?? 0 — core accepts an empty selection
                //                         unless the schema says otherwise;
                //   maxValues = maxItems ?? option count — the schema's real
                //                         upper bound is "any number of the
                //                         offered options", which is bounded
                //                         by how many there are (Discord caps a
                //                         select at 25 options, and the
                //                         renderability gate already limits the
                //                         count far below that).
                //
                // The platform allows at most 25, so a schema whose bound or
                // option set exceeds it cannot be expressed and is refused by
                // the gate rather than clamped here.
                minValues: field.minItems ?? 0,
                maxValues: Math.min(
                  field.maxItems ?? field.options.length,
                  field.options.length,
                ),
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
 * Whether the platform input must be non-empty to be submittable.
 *
 * Derived from `minLength` and from NOTHING ELSE.
 *
 * The schema's property-`required` says the KEY must be present, and `""` is a
 * present value — core's validator accepts it. Discord's `required` is stronger:
 * an empty submit is refused outright. So the two bits answer different
 * questions, and copying the schema one across turns a legal answer into an
 * unsendable form.
 *
 * `maxLength > 0` proves nothing either: `{maxLength: 10}` admits `""` and also
 * admits ten characters, so it cannot decide whether the empty form must be
 * offered. Only `minLength` can:
 *
 *   - `minLength >= 1` — no empty answer satisfies the schema, so the widget is
 *     allowed to require one.
 *   - `minLength: 0`  — the schema EXPLICITLY permits `""`, so it must not.
 *   - no `minLength`  — the schema is silent on the empty value, and the absence
 *     of a minimum is not a maximum. The widget must not invent one, and it does
 *     not need to: presence of the key is guaranteed by the wizard's own
 *     missing-field check on submit, which is exactly the rule core applies.
 */
function fieldRequiresNonEmptyInput(field: ChannelElicitationField): boolean {
  if (field.kind === "text" && field.minLength !== undefined) return field.minLength >= 1;
  return false;
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
  revision?: number,
): ShowModalInput {
  const messages = getMessages();
  const prefill = typeof current === "string" ? current : typeof field.defaultValue === "string" ? field.defaultValue : "";
  return {
    title: truncate(messages.elicitationTitle, 45),
    customId: elicitationModalCustomId(token, revision),
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
          // The PLATFORM's required, which is not the schema's.
          //
          // A JSON Schema `required` property means the key must be PRESENT, and
          // `""` is a present value — core's own validator accepts it for
          // `maxLength: 0`. Discord's `required` is stronger: it forbids
          // submitting the modal with the input empty at all. Copying the schema
          // bit straight across therefore makes a legal form impossible, because
          // the only answer the schema allows is one the widget refuses to send.
          //
          // So the input is required when the schema genuinely demands a
          // non-empty value (`minLength >= 1`), and NOT required when the schema
          // accepts the empty string. Presence of the key is enforced by the
          // submit gate's missing-field check, which is the same rule core
          // applies; emptiness is the widget's business, and here the two
          // disagree in the direction that would block a legal answer.
          required: fieldRequiresNonEmptyInput(field),
          ...(prefill ? { value: prefill } : {}),
          // The schema's own bounds, pushed into the control wherever the
          // platform can express them, so the widget enforces the same contract
          // core does instead of the user typing something it will reject. The
          // renderability gate has already refused any bound past the
          // platform's capacity, so this is an exact mapping, not a clamp.
          // Only `text` carries these — a number field is bounded numerically.
          ...(field.kind === "text" && field.minLength !== undefined ? { minLength: field.minLength } : {}),
          // The gate also refuses a text field that declares NO `maxLength`, so
          // reaching this line with `undefined` is impossible for a renderable
          // form. The fallback exists only so the type is total; it is never the
          // value a user is actually given.
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
  /**
   * The revision this interaction claimed before calling here, if it claimed one.
   *
   * A navigation handler retires its own number before it awaits its ACK, so this
   * is how `submitAnswers` can tell a claim that is SOUND (the click being
   * handled right now, whose claim is its own) from one that is NOT (a click
   * delivered while another handler's ACK is in flight). Without the distinction
   * either every Submit is rejected or none is.
   */
  claim?: number;
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
  // CARD REVISION FENCE.
  //
  // An interaction that names an OLDER revision came from a card the wizard has
  // already replaced. Honouring it would let a stale navigation land the user
  // somewhere other than where they clicked — and for `submit`, accept a form
  // whose answers have since been edited.
  //
  // The render queue serialises the TRANSITIONS, not the interactions that
  // trigger them: two clicks can be handled concurrently and the second one's
  // rerender only starts after the first's has finished. So the interaction that
  // raced ahead is still holding a control from the previous card.
  //
  // Against `renderRevision` — the card that is actually on screen — and NOT
  // against `claimedRevision`. The handler that owns a claim has already advanced
  // it before calling here, so comparing against the spent number would reject the
  // interaction that produced the claim: a Start click on the opening card would
  // be judged stale by its own claim and dropped, leaving the form unstartable.
  //
  // The claim's real work is done elsewhere: every state-WRITING path (select,
  // modal submit) compares against `claimedRevision`, which is what stops a
  // write from arriving during the Edit's ACK. A navigation interaction cannot
  // write anything, so this comparison is sound.
  //
  // A TERMINAL intent is exempt entirely. Decline and Cancel are the user's own
  // decision about the request as a whole, not a statement about the wizard's
  // position: a user who pressed Decline on the review card meant it even if a
  // later rerender has since changed what they were looking at. Fencing them made
  // the explicit decision vanish — the request stayed live with no visible way to
  // end it, which is precisely the wedge the timeout exists to prevent.
  //
  // The parser already treats these two as optional-revision for exactly this
  // reason; the exemption is what makes that true in the handler as well. It is
  // still an AUTHENTICATED click by the initiator, and `trySettle` still guarantees
  // only one decision is ever produced, so this widens nothing an intruder can use
  // and prevents no duplicate resolution.
  const isTerminalIntent = parsed.action === "decline" || parsed.action === "cancel";
  if (!isTerminalIntent && parsed.revision !== undefined && parsed.revision < entry.renderRevision) {
    input.log?.("discord.elicitation.stale_interaction", "dropped an interaction from an earlier card revision", {
      requestId: entry.requestId,
      interactionRevision: parsed.revision,
      currentRevision: entry.renderRevision,
      action: parsed.action,
    });
    await input.interaction.acknowledge();
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
      return submitAnswers(entry, input, parsed.revision);
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
  /** The revision the Submit control named. */
  revision?: number,
): Promise<ElicitationClickOutcome> {
  const messages = getMessages();
  // CLAIMED, NOT PUBLISHED. This is the one path where a stale interaction is
  // catastrophic, because a Submit settles the turn instead of asking a question.
  //
  // Compare against `claimedRevision` — what the app has spent — rather than
  // `renderRevision` — what is on screen. The ACK of an Edit, review-page change
  // or any navigation can still be in flight while the user's Submit from the
  // previous card lands: the card on screen still names that revision, so a
  // comparison against the published number would accept a form whose answers
  // changed while the user was reading it.
  //
  // Skipped only when this handler itself made the claim (a self-claim means no
  // other interaction has happened, and re-checking against it would reject the
  // very click the user just made).
  if (revision !== undefined && revision !== input.claim && revision < entry.claimedRevision) {
    input.log?.("discord.elicitation.stale_submit", "dropped a Submit from a superseded card", {
      requestId: entry.requestId,
      interactionRevision: revision,
      claimedRevision: entry.claimedRevision,
    });
    await input.interaction.replyEphemeral(messages.elicitationReviewUpdating);
    return { decided: false };
  }
  const missing = entry.request.fields.filter((field) => field.required && !Object.hasOwn(entry.values, field.key));
  if (missing.length > 0) {
    // Stay on the review page and point at the first gap.
    await input.interaction.replyEphemeral(`${messages.elicitationRequired}: ${missing[0]!.title}`);
    return { decided: false };
  }
  // Check what the user is about to send against the field's own constraints
  // BEFORE the card can turn "Accepted". Core re-validates regardless, but
  // without this the user saw a successful card and then a cancelled turn for a
  // typo the renderer could have caught while the form was still editable.
  const rejected = findRejectedAnswer(entry.request.fields, entry.values);
  if (rejected) {
    // Back to the offending field so the answer can be corrected.
    const index = entry.request.fields.findIndex((field) => field.key === rejected.key);
    entry.currentField = entry.request.fields[index]?.key ?? entry.currentField;
    await input.interaction.replyEphemeral(
      `${entry.request.fields[index]?.title ?? rejected.key}: ${rejected.reason}`,
    );
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

