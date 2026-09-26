/**
 * Feishu form-Elicitation cards.
 *
 * Emits Card JSON 2.0 (`schema: "2.0"`) for CardKit, the same shape the repo's
 * streaming card already uses (see card/card-builder.ts), so a card entity is
 * created with `cardkit.v1.card.create` and later replaced with
 * `cardkit.v1.card.update`.
 *
 * THREE PLATFORM FACTS DRIVE THE DESIGN, all verified:
 *
 *   1. Answers only arrive name-keyed when the interactive component sits inside
 *      a `form` container — Feishu's callback docs show `Input_xxx: "1234"`
 *      inside `action.form_value`, keyed by the component's `name`. Outside a
 *      form, an input reports at `action.input_value` with no name. So every
 *      field card is a `form` with a submit button.
 *   2. A form's interactive components each need a globally unique, non-empty
 *      `name` (error 200530), and a form cannot nest. So one field per card:
 *      the field's key IS the name, namespaced and sanitized by
 *      `formComponentName`.
 *   3. `behaviors[].value` is developer-defined opaque data echoed verbatim at
 *      `action.value`, distinct from `form_value`. The routing token goes there
 *      and nowhere else; no answer ever does.
 *
 * `config.streaming_mode` is FALSE: a streaming card cannot be updated from an
 * interaction callback (errors 200850 / 300309), and an elicit card has no
 * reason to stream.
 *
 * RENDERING SAFETY. Agent-supplied text (message, titles, descriptions, option
 * labels) is escaped before it reaches a markdown component. This is not the
 * same as the text-message path: `normalizeFeishuOutboundMentionTags`
 * (send.ts:42-54) actively REWRITES at-tags into real mentions, so reusing it
 * here would fire a mention the agent asked for. Card markdown uses
 * `<at id=...>`, so `<` is HTML-entity-escaped and the tag can never form.
 */
import type {
  ChannelElicitationField,
  ChannelElicitationRequest,
  ChannelElicitationValue,
} from "xacpx/plugin-api";

import { t as getMessages } from "./i18n/index.js";
import {
  escapeFeishuCardText,
  escapedLength,
  FEISHU_CARD_BODY_MAX_CHARS,
  FEISHU_INPUT_MAX_LENGTH,
  FEISHU_INPUT_PLACEHOLDER_MAX,
  FEISHU_TEXT_CONTENT_MAX,
} from "./elicitation-limits.js";
import { createAnswerMap, formComponentName } from "./elicitation-state.js";

/**
 * Escape agent-controlled text for a Feishu card markdown component.
 *
 * The escaper itself now lives in `elicitation-limits.ts` — see the note there
 * for why — and is re-exported here so the historical import path
 * (`./elicitation-cards.js`) keeps working for callers and tests alike.
 */
export { escapeFeishuCardText };

/** Routing identity for a control. Values, never answers. */
export type ElicitationUiAction =
  | "start"
  | "field"
  | "review"
  | "save"
  | "submit"
  | "skip"
  | "decline"
  | "cancel";

const MAX_CARD_CHARS = FEISHU_CARD_BODY_MAX_CHARS;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Bound an ALREADY-ESCAPED string without escaping it again.
 *
 * Every caller of `markdown`/`plainText` has already escaped its text, so the
 * body-size bound must not re-escape: doing so would write `&amp;#60;` where the
 * platform expects `&#60;`, and the user would literally read "amp;#60;".
 *
 * Bound in escaped space (the size the platform counts) and cut on entity
 * boundaries so the tail is never a partial `&#6`.
 *
 * THIS IS THE BACKSTOP, NOT THE DEFENCE. The renderability gate
 * (`checkElicitationRenderability`, which measures escaped length) refuses a
 * form whose agent-controlled text cannot be shown FAITHFULLY, so for the
 * agent's question this cut should be unreachable. It stays for two cases the
 * gate cannot see: the plugin's own localized copy (whose size is fixed by the
 * locale catalog, not by an agent) and a card the gate has no field-level bound
 * for. If it ever fires on agent text, that is a gate bug to fix — not a
 * licence to keep silently reshaping the agent's question into a fragment.
 */
function boundRendered(rendered: string, max: number): string {
  if (rendered.length <= max) return rendered;
  let end = Math.max(0, max - 1);
  const lastAmp = rendered.lastIndexOf("&", end);
  const lastSemi = rendered.lastIndexOf(";", end);
  if (lastAmp > lastSemi) end = lastAmp;
  return `${rendered.slice(0, end)}…`;
}

function markdown(content: string, elementId?: string): Record<string, unknown> {
  return {
    tag: "markdown",
    ...(elementId ? { element_id: elementId } : {}),
    // `content` arrives ALREADY escaped from every caller, so it is bounded in
    // escaped space but never escaped again: see `boundRendered`.
    content: boundRendered(content, MAX_CARD_CHARS),
    text_align: "left",
    text_size: "normal_v2",
  };
}

/**
 * A Feishu `plain_text` component.
 *
 * Escapes by default: every caller of this helper passes either agent-controlled
 * text (titles, option labels, field titles) or a localized string that happens
 * to be safe. `literal: false` exists ONLY for the localized headers, where
 * escaping would corrupt the plugin's own copy.
 *
 * Feishu's `plain_text` renders `<`-based tags (mentions, links) even though it
 * is "plain" text, so agent-supplied `<at id=all></at>` in an option label would
 * otherwise ping everyone in the chat.
 */
function plainText(content: string, literal = false): Record<string, unknown> {
  // Escape FIRST, then bound the rendered form. The old order truncated the raw
  // text to 100 chars and escaped afterwards, so a 100-char option label of all
  // `<` expanded to ~500 chars and was then cut back to 100 — the user read a
  // mangled label instead of the agent's text.
  const rendered = literal ? content : escapeFeishuCardText(content);
  return { tag: "plain_text", content: boundRendered(rendered, FEISHU_TEXT_CONTENT_MAX) };
}

/**
 * The routing payload for a control.
 *
 * `t`/`a` are the correlation handle; `f` names the field by POSITION when the
 * control is about one; `g` is the CARD GENERATION the control was rendered on.
 *
 * The generation is what makes a stale callback harmless. Feishu retries card
 * callbacks and users double-tap, so a control from an EARLIER render can arrive
 * after later ones — and without a generation, "save field 3" from render 4 is
 * indistinguishable from the same control on render 7, so a replayed old value
 * overwrites the newer answer the user had since typed.
 *
 * Position rather than the schema key: core allows `env.prod`, `a/b`, a
 * 128-char key, and keys of only punctuation, so a key-derived id would either
 * be invalid or collide after sanitizing. Never carries a value, a default, or
 * any agent text.
 */
function routingValue(
  token: string,
  action: ElicitationUiAction,
  fieldIndex?: number,
  renderGeneration?: number,
): Record<string, unknown> {
  return {
    ...(fieldIndex !== undefined ? { f: fieldIndex } : {}),
    ...(renderGeneration !== undefined ? { g: renderGeneration } : {}),
    t: token,
    a: action,
  };
}

/**
 * A button.
 *
 * Escapes the label by default because labels carry agent data more often than
 * not: the review page's per-field Edit buttons interpolate `field.title`, which
 * is agent-controlled. `literal: true` is for the plugin's own copy (Start,
 * Submit, Decline, Cancel).
 */
function button(
  label: string,
  value: Record<string, unknown>,
  type: "default" | "primary" | "danger" = "default",
  literal = false,
): Record<string, unknown> {
  return {
    tag: "button",
    text: plainText(label, literal),
    type,
    behaviors: [{ type: "callback", value }],
  };
}

/**
 * A card with no interactive anything: the inert terminal state.
 *
 * Feishu has no "disable" flag that reliably kills an already-delivered card's
 * components, so withdrawal is a full replacement whose elements contain no
 * interactive component at all.
 */
function inertCard(title: string, lines: readonly string[]): Record<string, unknown> {
  return {
    schema: "2.0",
    config: { streaming_mode: false, update_multi: true },
    header: { title: plainText(title, true) },
    body: { elements: lines.map((line) => markdown(escapeFeishuCardText(line))) },
  };
}

/** Opening card: agent identity, the agent's message, and the three entry actions. */
export function buildElicitationOpeningCard(
  request: ChannelElicitationRequest,
  token: string,
): Record<string, unknown> {
  const messages = getMessages();
  const lines: string[] = [messages.elicitationFromAgent(escapeFeishuCardText(request.agent.name))];
  if (request.agent.sessionAlias) {
    lines.push(`_${escapeFeishuCardText(request.agent.sessionAlias)}_`);
  }
  if (request.message) lines.push(escapeFeishuCardText(request.message));
  if (request.schemaTitle) lines.push(`**${escapeFeishuCardText(request.schemaTitle)}**`);
  if (request.schemaDescription) lines.push(escapeFeishuCardText(request.schemaDescription));
  const summary = request.fields
    .map((field) => `- ${escapeFeishuCardText(field.title)}${field.required ? "" : ` (${messages.elicitationOptional})`}`)
    .join("\n");
  if (summary) lines.push(summary);
  return {
    schema: "2.0",
    config: { streaming_mode: false, update_multi: true },
    header: { title: plainText(messages.elicitationTitle, true) },
    body: {
      elements: [
        ...lines.map((line) => markdown(line)),
        {
          tag: "column_set",
          flex_mode: "flow",
          horizontal_spacing: "default",
          columns: [{
            tag: "column",
            elements: [
              button(messages.elicitationStart, routingValue(token, "start"), "primary", true),
              button(messages.elicitationDecline, routingValue(token, "decline"), "default", true),
              button(messages.elicitationCancel, routingValue(token, "cancel"), "default", true),
            ],
          }],
        },
      ],
    },
  };
}

/**
 * Field card: one question, as a `form` whose submit button carries the token.
 *
 * The component mapping, per field kind:
 *
 *   single-select — a `select_static` whose option values are the ACP option
 *                   values (the correlation identity core validates), with the
 *                   current or default answer as `initial_option`.
 *   text/number   — an `input`, `max_length` bounded by the platform's 1000.
 *
 * Boolean is rendered as a two-option `select_static` rather than a pair of
 * buttons: a boolean is a choice, and putting it in the same control as every
 * other field keeps the answer path uniform and the label out of the decision.
 */
export function buildElicitationFieldCard(
  request: ChannelElicitationRequest,
  token: string,
  field: ChannelElicitationField,
  index: number,
  current: ChannelElicitationValue | undefined,
  /**
   * The generation of the card render this control belongs on.
   *
   * Stamped into the save control's routing payload so a replayed callback from
   * an earlier render can be recognised and refused. `undefined` produces a card
   * without one, which is only correct for a card whose callbacks are never
   * replayed — the renderer always passes the entry's current generation.
   */
  renderGeneration?: number,
): Record<string, unknown> {
  const messages = getMessages();
  const name = formComponentName(field.key, request.fields);
  const lines: string[] = [
    `**${messages.elicitationFieldLabel(index, request.fields.length)}**`,
    messages.elicitationFromAgent(escapeFeishuCardText(request.agent.name)),
    `**${escapeFeishuCardText(field.title)}**`,
  ];
  if (field.description) lines.push(escapeFeishuCardText(field.description));
  if (field.defaultValue !== undefined && current === undefined) {
    lines.push(`_${escapeFeishuCardText(displayValue(field.defaultValue))}_`);
  }
  if (current !== undefined) {
    lines.push(`${messages.elicitationAnswerSaved} ${escapeFeishuCardText(displayValue(current))}`);
  }

  const formElements: Array<Record<string, unknown>> = [];
  if (field.kind === "single-select" || field.kind === "boolean") {
    // A boolean renders as a two-option select whose option VALUES are the
    // literal `true` / `false` strings the parser maps back. It used to share
    // the free-text `input`, so the user saw a blank box with no options and no
    // hint that "yes"/"y"/"1" were the accepted spellings — a contract only the
    // parser knew about.
    const options = field.kind === "boolean"
      ? [
          { text: plainText(messages.elicitationYes), value: "true" },
          { text: plainText(messages.elicitationNo), value: "false" },
        ]
      : field.options.map((option) => ({
          text: plainText(option.label),
          // The option VALUE, not the label: core validates the value, and the
          // label is agent-controlled display text that may be truncated.
          value: option.value,
        }));
    formElements.push({
      tag: "select_static",
      name,
      placeholder: plainText(field.title),
      ...(initialOptionFor(field, current) !== undefined
        ? { initial_option: initialOptionFor(field, current) }
        : {}),
      options,
    });
  } else {
    formElements.push({
      tag: "input",
      name,
      // Escaped like every other agent-controlled string. This label was the one
      // place that passed `field.title` through raw, and Feishu renders `<at>`
      // tags in plain_text — so an agent-written title could ping @everyone in
      // the form the user is filling in.
      label: { tag: "plain_text", content: escapeFeishuCardText(field.title) },
      label_position: "top",
      placeholder: plainText(field.title),
      required: field.required,
      max_length: maxLengthFor(field),
      ...(prefillFor(field, current) !== undefined ? { default_value: prefillFor(field, current) } : {}),
    });
  }

  return {
    schema: "2.0",
    config: { streaming_mode: false, update_multi: true },
    header: { title: plainText(messages.elicitationTitle, true) },
    body: {
      elements: [
        ...lines.map((line) => markdown(line)),
        {
          tag: "form",
          name: "elicit",
          elements: [
            ...formElements,
            // Skip is offered only for optional fields, and it is the honest way
            // past one: submitting with an empty value leaves the field
            // unanswered, which blocks the advance and makes an all-optional
            // form uncompletable.
            // The field's own position, not a bare action: see the handler. A
            // Skip that names its field is idempotent when Feishu retries the
            // callback or a user double-taps, instead of skipping whatever the
            // shared cursor has moved to.
            //
            // It also carries this card's GENERATION, for the same reason Save
            // does. Skip MUTATES field state — `markSkipped` deletes any answer
            // already recorded — so a replayed Skip is not merely idempotent per
            // field: after a later Edit restores a value, replaying the older
            // Skip deletes that value and submits the field as omitted. Position
            // alone cannot express "this is the card I am looking at".
            ...(!field.required
              ? [button(messages.elicitationSkip, routingValue(token, "skip", request.fields.indexOf(field), renderGeneration), "default", true)]
              : []),
            // "save" is deliberately NOT the review page's "submit": the two are
            // different acts, and reusing one action would let this button's
            // semantics depend on mutable renderer state. A retried or double
            // delivered callback could then reach the review page's commit
            // without the user ever confirming it.
            //
            // It also carries this card's GENERATION. Without one, "save this
            // field" was identified only by the token: a callback from an EARLIER
            // render of the same field was indistinguishable from the current
            // one, so a delayed replay wrote the old value over the newer answer
            // the user had since typed. `submit()` writes to whichever field the
            // cursor is on, and entering Review does not clear that cursor — so
            // `prod -> Review -> Edit -> staging -> Review -> replay(prod)`
            // submitted `prod`, the value the user had replaced.
            button(messages.elicitationSubmit, routingValue(token, "save", undefined, renderGeneration), "primary", true),
            button(messages.elicitationDecline, routingValue(token, "decline"), "default", true),
            button(messages.elicitationCancel, routingValue(token, "cancel"), "default", true),
          ],
        },
      ],
    },
  };
}

/**
 * Review card: every label with its current value, editable per field.
 *
 * `revision` is the generation this card is drawn at, stamped into every control
 * it carries — Edit, Submit, Decline and Cancel alike. It is REQUIRED for Edit
 * and Submit, which is what closes the last gap in the revision fence: a Submit
 * from an earlier Review card would otherwise reach `confirmReviewed()` and
 * accept the pre-edit answers. `Save prod -> Review(gR) -> Edit(gF) -> field card
 * -> delayed old Review Submit(gR)` used to accept `prod` while the user was
 * still typing `staging`.
 *
 * Decline and Cancel carry it too, for one invariant rather than two: a control
 * on a card is identified by that card, and an interaction from a superseded card
 * is dropped by identity. They remain unversioned in the HANDLER, because a
 * replayed Decline is still a Decline the user made on a card they were shown.
 */
export function buildElicitationReviewCard(
  request: ChannelElicitationRequest,
  token: string,
  values: Record<string, ChannelElicitationValue>,
  revision?: number,
): Record<string, unknown> {
  const messages = getMessages();
  const lines: string[] = [messages.elicitationFromAgent(escapeFeishuCardText(request.agent.name))];
  for (const field of request.fields) {
    const value = values[field.key];
    lines.push(`**${escapeFeishuCardText(field.title)}**\n${escapeFeishuCardText(value === undefined ? messages.elicitationNoAnswer : displayValue(value))}`);
  }
  // One Edit control per field, so the review page is navigable: the ACP
  // requirement is that answers can be MODIFIED, which needs a route back to
  // each of them.
  const editButtons = request.fields.slice(0, 40).map((field) =>
    button(`${messages.elicitationEdit}: ${field.title}`, routingValue(token, "field", request.fields.indexOf(field), revision)),
  );
  return {
    schema: "2.0",
    config: { streaming_mode: false, update_multi: true },
    header: { title: plainText(messages.elicitationReview, true) },
    body: {
      elements: [
        ...lines.map((line) => markdown(line)),
        {
          tag: "column_set",
          flex_mode: "flow",
          horizontal_spacing: "default",
          columns: [{
            tag: "column",
            elements: [
              ...editButtons,
              button(messages.elicitationSubmit, routingValue(token, "submit", undefined, revision), "primary", true),
              button(messages.elicitationDecline, routingValue(token, "decline", undefined, revision), "default", true),
              button(messages.elicitationCancel, routingValue(token, "cancel", undefined, revision), "default", true),
            ],
          }],
        },
      ],
    },
  };
}

/** The terminal card shown after a user decision or an external withdrawal. */
export function buildElicitationTerminalCard(
  kind: "accepted" | "declined" | "cancelled" | "expired",
): Record<string, unknown> {
  const messages = getMessages();
  const title = kind === "accepted"
    ? messages.elicitationAccepted
    : kind === "declined"
      ? messages.elicitationDeclined
      : kind === "expired"
        ? messages.elicitationExpired
        : messages.elicitationCancelled;
  return inertCard(title, [title]);
}

export function displayValue(value: ChannelElicitationValue | readonly string[]): string {
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

/**
 * Which option a select shows as current.
 *
 * The field's own default is shown as the CURRENT selection rather than applied
 * invisibly: a default the user cannot see is one they cannot change, which is
 * exactly the pre-fill the ACP contract forbids committing without review.
 */
function initialOptionFor(
  field: Extract<ChannelElicitationField, { kind: "single-select" } | { kind: "boolean" }>,
  current: ChannelElicitationValue | undefined,
): string | undefined {
  // A boolean's current answer is a real boolean; the option VALUE the select
  // carries is its string spelling.
  if (typeof current === "boolean") return String(current);
  if (typeof current === "string") return current;
  // A boolean field's default is likewise the string spelling.
  if (typeof field.defaultValue === "boolean") return String(field.defaultValue);
  return field.defaultValue;
}

/** The input's pre-filled content, from the current answer or the schema default. */
function prefillFor(
  field: ChannelElicitationField,
  current: ChannelElicitationValue | undefined,
): string | undefined {
  if (typeof current === "string") return current;
  if (current === undefined && typeof field.defaultValue === "string") return field.defaultValue;
  if (current === undefined && typeof field.defaultValue === "number") return String(field.defaultValue);
  if (current === undefined && typeof field.defaultValue === "boolean") return String(field.defaultValue);
  return undefined;
}

/**
 * The input's `max_length`, capped by the platform's own 1000.
 *
 * Only reached for a field the gate has already accepted, which now requires a
 * declared `maxLength` — so this is a genuine clamp of a DECLARED bound, not a
 * default invented for one that was absent. Core's answer validator remains
 * authoritative on what a submitted answer satisfies.
 */
function maxLengthFor(field: ChannelElicitationField): number {
  const desired = "maxLength" in field && typeof field.maxLength === "number" ? field.maxLength : undefined;
  return Math.min(desired ?? FEISHU_INPUT_MAX_LENGTH, FEISHU_INPUT_MAX_LENGTH);
}

/**
 * The review card this form will render once every answer is collected.
 *
 * Used by the renderability gate to size the WORST case the request can produce.
 * Scheduled answers are the largest agent-authored strings that can land in a
 * card, so any smaller sample would pass the budget check and then have
 * `card.update` fail on review — after the user has already filled the form in.
 *
 * The maximum is per-field and bounded by what the platform's own `input` can
 * hold (`maxLengthFor`), so the sample is the biggest the form can ever ask for
 * rather than an arbitrary number.
 *
 * WORST CASE MEANS WORST CASE IN ESCAPED SPACE. The sample used to be
 * `"x".repeat(maxLength)` — a 1x character, so a real answer of 1000 `<`
 * (which expands to 5x) made the estimate 5x optimistic and the review card
 * could still overflow the 30 KB budget the gate had just blessed. The sample
 * is now built from the character the ESCAPER expands most, measured through
 * `escapeFeishuCardText` itself rather than a hardcoded multiplier, so the
 * estimate can never drift optimistic as the escaper changes.
 *
 * A select's sample is likewise the option whose DISPLAYED VALUE renders widest,
 * not the one with the longest label: the review card renders
 * `displayValue(value)`, so a label-heavy option with a short value produced an
 * estimate that had nothing to do with what the review page would show.
 */
export function buildWorstCaseReviewCard(
  request: ChannelElicitationRequest,
  token: string,
  revision?: number,
): Record<string, unknown> {
  const values = createAnswerMap();
  // Maximized PER FIELD, because the review card's byte total is a sum of
  // per-field contributions plus fixed structure, and each field's line is
  // independent of the others — so maximizing each one independently maximizes
  // the whole. That includes the OMITTED state: an unanswered field renders the
  // "No answer" text, which for a short-answer field is WIDER than the answer.
  //
  // The previous version compared the omitted text against the answer and then
  // DELETED the field when omitted was wider. That is the same state in the
  // review renderer, but the comparison ran in ESCAPED CHARACTERS while the
  // budget is UTF-8 BYTES, so a field the escaper treats as narrow could still be
  // the widest state in bytes — and the sample shrank below a legal review.
  //
  // Comparing in bytes, through the same measurement on both sides, closes that
  // and keeps the sample an upper bound rather than a guess.
  const messages = getMessages();
  for (const field of request.fields) {
    const widest = widestLegalReviewValue(field, request);
    if (!field.required) {
      // Both states measured the SAME way — the line the review card actually
      // builds for this field, in the bytes it serializes to. A field whose
      // answers all render narrower than "No answer yet." is left OMITTED,
      // which is how the review renders exactly that state.
      const answeredBytes = Buffer.byteLength(
        `**${escapeFeishuCardText(field.title)}**\n${escapeFeishuCardText(displayValue(widest))}`,
        "utf8",
      );
      const omittedFieldBytes = Buffer.byteLength(
        `**${escapeFeishuCardText(field.title)}**\n${escapeFeishuCardText(messages.elicitationNoAnswer)}`,
        "utf8",
      );
      if (answeredBytes <= omittedFieldBytes) continue;
    }
    values[field.key] = widest;
  }
  return buildElicitationReviewCard(request, token, values as Record<string, ChannelElicitationValue>, revision);
}

/**
 * The widest VALUE a field can contribute to a review card, across every legal
 * state the wizard can be in when it renders one.
 *
 * UPPER BOUND, not a representative sample. The gate blesses a review card up
 * front, and the real card is only rendered after the user has answered — so if
 * this sample understates what a legal answer renders to, the 30 KB budget is a
 * lie and `card.update` fails permanently at review time, after the work.
 *
 * WIDEST IN BYTES, NOT IN ESCAPED CHARACTERS. The budget is
 * `Buffer.byteLength(JSON.stringify(card), "utf8")`, and the two metrics disagree:
 * `"~".repeat(80)` is an 80-char string that the escaper leaves alone, so 80
 * escaped chars, but 400-byte JSON after JSON-escaping and UTF-8. An emoji is 2
 * JS chars, 128 escaped chars, and 512 bytes. Choosing on escaped length
 * therefore picked the narrower sample, and the gate blessed a card the real
 * review then exceeded. Every comparison here is on what the card SERIALIZES to,
 * through the same functions the review card uses, so "widest" means widest
 * against the budget that is actually enforced.
 */
function widestLegalReviewValue(field: ChannelElicitationField, request: ChannelElicitationRequest): ChannelElicitationValue {
  if (field.kind === "boolean") {
    return widestOf(field, request, [true, false]);
  }
  if (field.kind === "number") {
    return widestNumberFor(field, request);
  }
  if (field.kind === "single-select" || field.kind === "multi-select") {
    const widest = widestOf(field, request, field.options.map((option) => option.value));
    return field.kind === "multi-select" ? [widest as string] : widest;
  }
  // text: the widest answer the platform's input can capture, built from the
  // highest-expansion legal character so the estimate is an upper bound.
  return highestExpansionFill(maxLengthFor(field));
}

/**
 * The candidate whose REVIEW LINES serialize widest in UTF-8.
 *
 * Measured by building the review text the review card would build for that
 * value and counting its bytes — not by guessing at a per-character width. This
 * is what makes the estimate honest: a number that is one character longer but
 * all ASCII, and an option value that is shorter in JS but twice its size in
 * UTF-8, are compared on the axis the budget actually uses.
 */
function widestOf(
  field: ChannelElicitationField,
  request: ChannelElicitationRequest,
  candidates: readonly ChannelElicitationValue[],
): ChannelElicitationValue {
  let widest = candidates[0]!;
  let widestBytes = reviewFieldBytes(request, field, widest);
  for (const candidate of candidates.slice(1)) {
    const bytes = reviewFieldBytes(request, field, candidate);
    if (bytes > widestBytes) {
      widest = candidate;
      widestBytes = bytes;
    }
  }
  return widest;
}

/** UTF-8 bytes this one field's line contributes to a review card. */
function reviewFieldBytes(
  request: ChannelElicitationRequest,
  field: ChannelElicitationField,
  value: ChannelElicitationValue,
): number {
  return Buffer.byteLength(JSON.stringify([request, field, value, escapeFeishuCardText(displayValue(value))]), "utf8");
}

/**
 * The number whose rendered form is the widest a legal answer can produce.
 *
 * Core's number field accepts any finite JS number, and the review prints
 * `String(value)` — so `1.7976931348623157e+308` is a legal answer and renders
 * 24 characters, four times the width of `9007199254740991`. Capping the search
 * at `Number.MAX_SAFE_INTEGER` (the old behaviour) therefore guaranteed the
 * sample was narrower than a legal review, for exactly the schemas the sample
 * exists to protect: a number field with no declared `maximum`.
 *
 * Searched BOTH WAYS, not just upward: a large negative `minimum` with a small
 * positive `maximum` has its widest legal answer at the negative end, and a
 * one-sided search missed it.
 */
function widestNumberFor(
  field: Extract<ChannelElicitationField, { kind: "number" }>,
  request: ChannelElicitationRequest,
): number {
  // Any finite number the schema permits is a legal answer. Bounded by the
  // schema's own declared bounds when it has them, and by the platform's 1000-char
  // input for a number field when it does not.
  //
  // The platform's own bound is not `Number.MAX_SAFE_INTEGER` but what the input
  // can HOLD: 1000 characters, which the decimal form of `Number.MAX_VALUE` is
  // far inside of, so the true ceiling is the largest finite double.
  const ceiling = field.maximum ?? Number.MAX_VALUE;
  const floor = field.minimum ?? -Number.MAX_VALUE;
  // Candidates that bracket the whole space: the extremes of the declared range,
  // the extremes of the double range, and the values in between that render with
  // the most characters (a long mantissa dominates any short one).
  const candidates: number[] = [0, floor, ceiling, Math.trunc(floor), Math.trunc(ceiling)];
  // Walk the mantissas, which is where length lives: the longest decimal
  // expansion of a finite double is 17 significant digits, so these are the
  // shapes a legal answer can take that render wider than the extremes.
  for (const magnitude of [Number.MAX_SAFE_INTEGER, 1e21, 1e17, 1e15, 1e12]) {
    for (const sign of [1, -1]) {
      const candidate = sign * magnitude;
      if (candidate >= floor && candidate <= ceiling) candidates.push(candidate);
    }
  }
  return widestOf(field, request, candidates) as number;
}

/**
 * A `length`-character string that is as LARGE AS ANY legal answer once escaped.
 *
 * The escaper maps every escapable character to a 5- or 6-char entity, so the
 * worst a `length`-char answer can do is `length * maxExpansion`. Rather than
 * hardcode that 6, the candidates are run through `escapeFeishuCardText` and the
 * widest is picked: if the escaper ever gains a longer entity, this stays honest
 * automatically.
 *
 * Chosen from the escapable characters deliberately — a character that is NOT
 * escaped expands 1x and would understate the worst case, which is the exact
 * optimism the old `"x".repeat(...)` sample had.
 */
function highestExpansionFill(length: number): string {
  if (length <= 0) return "";
  // Every character `escapeFeishuCardText` rewrites, plus the two position-only
  // ones (a leading `#` and a leading `>`), which only expand at a line start.
  const candidates = ["&", "<", ">", "[", "]", "*", "_", "`", "~", "|", "#"];
  let best = candidates[0]!;
  for (const candidate of candidates) {
    if (escapeFeishuCardText(candidate).length > escapeFeishuCardText(best).length) best = candidate;
  }
  return best.repeat(length);
}
