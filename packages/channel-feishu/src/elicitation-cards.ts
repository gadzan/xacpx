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
  FEISHU_CARD_BODY_MAX_CHARS,
  FEISHU_INPUT_PLACEHOLDER_MAX,
  FEISHU_TEXT_CONTENT_MAX,
} from "./elicitation-limits.js";
import { formComponentName } from "./elicitation-state.js";

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
 * Escape agent-controlled text for a Feishu card markdown component.
 *
 * `&#60;` (`<`) is the load-bearing escape: it prevents `<at id=...>`,
 * `<link ...>`, `<a href=...>` and every other Feishu markup tag from forming.
 *
 * Feishu card markdown additionally supports: `**bold**` / `__bold__`,
 * `*italic*`, `~~strikethrough~~`, `` `code` ``, `> quote`, `#` headings,
 * `---` dividers, `|` pipe tables and `[text](url)` links. Every one of those
 * characters is escaped so agent text cannot reshape the card — a heading that
 * hides the question, a table that buries it, or bold that makes a line look
 * like a header the platform wrote.
 *
 * Feishu's own escaping guidance is HTML-entity form (`&#number;`), which a
 * markdown component renders back as the literal character. Ordering matters:
 * `&` is escaped first so the entities written for other characters are not
 * themselves re-escaped.
 */
export function escapeFeishuCardText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&#60;")
    .replace(/>/g, "&#62;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/\*/g, "&#42;")
    .replace(/_/g, "&#95;")
    .replace(/`/g, "&#96;")
    .replace(/~/g, "&#126;")
    .replace(/\|/g, "&#124;")
    .replace(/^#/gm, "&#35;")
    .replace(/^>/gm, "&#62;");
}

function markdown(content: string, elementId?: string): Record<string, unknown> {
  return {
    tag: "markdown",
    ...(elementId ? { element_id: elementId } : {}),
    content: truncate(content, MAX_CARD_CHARS),
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
  return { tag: "plain_text", content: truncate(literal ? content : escapeFeishuCardText(content), 100) };
}

/**
 * The routing payload for a control.
 *
 * Deliberately small: the card is capped at 30 KB and `value` has no field cap
 * of its own, so a short opaque handle is both sufficient and safe. It carries
 * the token and the action, plus the field's POSITION when the control names
 * one — never a value, a default, or any agent text. Position rather than the
 * schema key: core allows `env.prod` and a 128-char key, and the component
 * `name` derived from it must be card-unique and platform-safe.
 */
function routingValue(token: string, action: ElicitationUiAction, fieldIndex?: number): Record<string, unknown> {
  return {
    ...(fieldIndex !== undefined ? { f: fieldIndex } : {}),
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
    text: plainText(truncate(label, FEISHU_TEXT_CONTENT_MAX), literal),
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
    header: { title: plainText(truncate(title, FEISHU_TEXT_CONTENT_MAX), true) },
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
    header: { title: plainText(truncate(messages.elicitationTitle, FEISHU_TEXT_CONTENT_MAX), true) },
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
          { text: plainText(truncate(messages.elicitationYes, FEISHU_TEXT_CONTENT_MAX)), value: "true" },
          { text: plainText(truncate(messages.elicitationNo, FEISHU_TEXT_CONTENT_MAX)), value: "false" },
        ]
      : field.options.map((option) => ({
          text: plainText(truncate(option.label, FEISHU_TEXT_CONTENT_MAX)),
          // The option VALUE, not the label: core validates the value, and the
          // label is agent-controlled display text that may be truncated.
          value: option.value,
        }));
    formElements.push({
      tag: "select_static",
      name,
      placeholder: plainText(truncate(field.title, FEISHU_INPUT_PLACEHOLDER_MAX)),
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
      label: { tag: "plain_text", content: escapeFeishuCardText(truncate(field.title, FEISHU_TEXT_CONTENT_MAX)) },
      label_position: "top",
      placeholder: plainText(truncate(field.title, FEISHU_INPUT_PLACEHOLDER_MAX)),
      required: field.required,
      max_length: maxLengthFor(field),
      ...(prefillFor(field, current) !== undefined ? { default_value: prefillFor(field, current) } : {}),
    });
  }

  return {
    schema: "2.0",
    config: { streaming_mode: false, update_multi: true },
    header: { title: plainText(truncate(messages.elicitationTitle, FEISHU_TEXT_CONTENT_MAX), true) },
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
            ...(!field.required ? [button(messages.elicitationSkip, routingValue(token, "skip"), "default", true)] : []),
            // "save" is deliberately NOT the review page's "submit": the two are
            // different acts, and reusing one action would let this button's
            // semantics depend on mutable renderer state. A retried or double
            // delivered callback could then reach the review page's commit
            // without the user ever confirming it.
            button(messages.elicitationSubmit, routingValue(token, "save"), "primary", true),
            button(messages.elicitationDecline, routingValue(token, "decline"), "default", true),
            button(messages.elicitationCancel, routingValue(token, "cancel"), "default", true),
          ],
        },
      ],
    },
  };
}

/** Review card: every label with its current value, editable per field. */
export function buildElicitationReviewCard(
  request: ChannelElicitationRequest,
  token: string,
  values: Record<string, ChannelElicitationValue>,
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
    button(`${messages.elicitationEdit}: ${field.title}`, routingValue(token, "field", request.fields.indexOf(field))),
  );
  return {
    schema: "2.0",
    config: { streaming_mode: false, update_multi: true },
    header: { title: plainText(truncate(messages.elicitationReview, FEISHU_TEXT_CONTENT_MAX), true) },
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
              button(messages.elicitationSubmit, routingValue(token, "submit"), "primary", true),
              button(messages.elicitationDecline, routingValue(token, "decline"), "default", true),
              button(messages.elicitationCancel, routingValue(token, "cancel"), "default", true),
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
 * Core's answer validator remains authoritative; this only keeps the platform
 * from rejecting a bound it does not accept.
 */
function maxLengthFor(field: ChannelElicitationField): number {
  const desired = "maxLength" in field && typeof field.maxLength === "number" ? field.maxLength : undefined;
  return Math.min(desired ?? 1000, 1000);
}
