/**
 * Feishu renderability gate: decide whether a core-normalized Elicitation form
 * can be represented FAITHFULLY on Feishu cards, and reject the ones that
 * cannot before anything is sent.
 *
 * Like Discord's gate (packages/channel-discord/src/elicitation-limits.ts), this
 * is a RENDERER-capability decision rather than schema normalization: core has
 * already validated the schema against ACP. When Feishu cannot express a form,
 * the request cancels instead of being silently reshaped into a different
 * question.
 *
 * Every limit below is sourced. Where Feishu documents none, the module says so
 * and picks a conservative bound derived from a documented one, rather than
 * inventing a number.
 *
 * Documented limits (sources cited inline at each constant):
 *
 *   - Card JSON: 30 KB, enforced (cardkit v1 card create/update error 200860
 *     "Card content exceeds limit"). The `card.data` field itself validates at
 *     1–1,000,000 chars — that is NOT the usable budget.
 *   - 200 elements/components per card, nested ones included (error 300305).
 *   - Container nesting depth: 5 levels.
 *   - `element_id`: max 20 chars, letters/numbers/underscore, must start with a
 *     letter, globally unique per card (error 300301).
 *   - `input.max_length` (answer length): 1–1000, default 1000.
 *   - `input.placeholder.content`: 100 chars.
 *   - `overflow` option `text.content`: 100 chars.
 *   - Card title: 4 lines; subtitle: 1 line (excess truncated with "...").
 *
 * NOT DOCUMENTED by Feishu (handled conservatively, see unknownLimits below):
 * per-card button count, select option count, `input.label` length,
 * `behaviors[].value` size, card title char count, markdown component length.
 */

import type { ChannelElicitationField } from "xacpx/plugin-api";

/** Card JSON ceiling, enforced by cardkit 200860. */
export const FEISHU_CARD_JSON_MAX_BYTES = 30 * 1024;
/**
 * The repo's own per-body budget, already used by the streaming card path.
 * Deliberately below the platform ceiling so the JSON envelope still fits.
 */
export const FEISHU_CARD_BODY_MAX_CHARS = 28_000;
/** Elements/components per card, nested included (error 300305). */
export const FEISHU_CARD_ELEMENTS_MAX = 200;
/** Container nesting depth (form/column-set docs). */
export const FEISHU_CARD_NESTING_MAX = 5;
/** `element_id` length + charset (error 300301). */
export const FEISHU_ELEMENT_ID_MAX = 20;
/** `input.max_length` range. An answer longer than this cannot be captured. */
export const FEISHU_INPUT_MAX_LENGTH = 1000;
/** `input.placeholder.content` cap. */
export const FEISHU_INPUT_PLACEHOLDER_MAX = 100;
/** `overflow` option `text.content` cap; also the conservative label bound. */
export const FEISHU_TEXT_CONTENT_MAX = 100;

/**
 * Feishu cards have NO multi-select component.
 *
 * Verified against the installed SDK's own component union:
 * node_modules/@larksuiteoapi/node-sdk/types/index.d.ts — the select tag union
 * is exactly `'select_static' | 'select_person'` (single-select dropdown and a
 * person picker). The `multi_select` usages elsewhere in that file are Bitable
 * table field types, unrelated to cards.
 *
 * So a `multi-select` field cannot be answered as an array on this platform and
 * the whole request cancels. That is the honest answer: a form the user sees
 * must be the form the agent asked.
 */
export const FEISHU_MULTI_SELECT_SUPPORTED = false;

/**
 * Select options are capped by our own element budget rather than a documented
 * Feishu limit (none exists: neither the component doc, the SDK types, nor the
 * constraints overview state one).
 *
 * 40 is chosen so a worst-case card — one option per button for a single-select
 * laid out as buttons, plus the form chrome — stays far inside the 200-element
 * ceiling. It is a renderer policy, not a platform constant, and is documented
 * as such so a future platform change is easy to apply.
 */
export const FEISHU_SELECT_OPTION_MAX = 40;

/**
 * Buttons per card, likewise a policy bound: Feishu documents none, and the
 * only documented ceiling is the 200-element one.
 */
export const FEISHU_BUTTONS_PER_CARD_MAX = 40;

export type ElicitationUnsupportedReason =
  | "multi-select-unsupported"
  | "select-option-count"
  | "select-option-label-too-long"
  | "field-label-too-long"
  | "field-description-too-long"
  | "answer-too-long"
  | "empty-select"
  | "too-many-fields";

export interface ElicitationRenderability {
  renderable: boolean;
  reason?: ElicitationUnsupportedReason;
  /** Bounded diagnostic text for logs; never contains an answer. */
  detail?: string;
}

/**
 * Limits Feishu does not document. Recorded so the conservative values above
 * are auditable and a future reader knows which numbers are policy.
 */
export const FEISHU_UNDOCUMENTED_LIMITS: readonly string[] = [
  "per-card button count (Feishu documents none; capped by the 200-element ceiling)",
  "select_static option count (no documented cap; `select_person` with an empty/invalid options array silently falls back to all chat members, so options are always supplied explicitly)",
  "input.label length (no cap; placeholder is capped at 100, labels truncated to the same bound)",
  "behaviors[].value size (no field cap; the 30 KB card budget binds, so the routing token stays a short opaque id)",
  "card title char count (only line counts documented: 4 title / 1 subtitle)",
  "markdown component content length (no per-component cap; the 28,000-char body budget from the repo's streaming card is used)",
];

function longest(values: readonly string[]): number {
  return values.reduce((max, value) => Math.max(max, value.length), 0);
}

/**
 * Decide whether this exact normalized form survives Feishu's card API.
 *
 * Ordering is deliberate: structural impossibilities (a field kind the platform
 * cannot express) are reported before cosmetic ones, so a log reader sees the
 * decisive cause first.
 */
export function checkElicitationRenderability(fields: readonly ChannelElicitationField[]): ElicitationRenderability {
  // A form is one card per field, so the field count is bounded by how many
  // cards a single elicitation can traverse. This is a policy bound, not a
  // platform one: Feishu documents no interaction-count limit.
  if (fields.length > FEISHU_SELECT_OPTION_MAX) {
    return {
      renderable: false,
      reason: "too-many-fields",
      detail: `${fields.length} fields exceeds the renderer's ${FEISHU_SELECT_OPTION_MAX}-field budget`,
    };
  }
  for (const field of fields) {
    // The decisive structural gap: no array-answer control exists.
    if (field.kind === "multi-select" && !FEISHU_MULTI_SELECT_SUPPORTED) {
      return {
        renderable: false,
        reason: "multi-select-unsupported",
        detail: `field ${JSON.stringify(field.key)} is multi-select; Feishu cards have no multi-select component`,
      };
    }

    if (field.kind === "single-select") {
      if (field.options.length === 0) {
        return {
          renderable: false,
          reason: "empty-select",
          detail: `field ${JSON.stringify(field.key)} has no options`,
        };
      }
      if (field.options.length > FEISHU_SELECT_OPTION_MAX) {
        return {
          renderable: false,
          reason: "select-option-count",
          detail: `field ${JSON.stringify(field.key)} has ${field.options.length} options, renderer budget ${FEISHU_SELECT_OPTION_MAX}`,
        };
      }
      const worstLabel = longest(field.options.map((option) => option.label));
      if (worstLabel > FEISHU_TEXT_CONTENT_MAX) {
        return {
          renderable: false,
          reason: "select-option-label-too-long",
          detail: `field ${JSON.stringify(field.key)} option label is ${worstLabel} chars, limit ${FEISHU_TEXT_CONTENT_MAX}`,
        };
      }
    }

    // A label IS the question (input.label). Feishu documents no cap, so the
    // documented placeholder cap is used as the bound: a label longer than the
    // placeholder may render differently from what was asked.
    if (field.title.length > FEISHU_TEXT_CONTENT_MAX) {
      return {
        renderable: false,
        reason: "field-label-too-long",
        detail: `field ${JSON.stringify(field.key)} label is ${field.title.length} chars, limit ${FEISHU_TEXT_CONTENT_MAX}`,
      };
    }
    if ((field.description ?? "").length > FEISHU_CARD_BODY_MAX_CHARS) {
      return {
        renderable: false,
        reason: "field-description-too-long",
        detail: `field ${JSON.stringify(field.key)} description is ${(field.description ?? "").length} chars, limit ${FEISHU_CARD_BODY_MAX_CHARS}`,
      };
    }
    // An answer the platform cannot capture would be silently truncated into a
    // different answer, so it is refused rather than clipped.
    if (field.kind === "text" && field.maxLength !== undefined && field.maxLength > FEISHU_INPUT_MAX_LENGTH) {
      return {
        renderable: false,
        reason: "answer-too-long",
        detail: `field ${JSON.stringify(field.key)} allows ${field.maxLength} chars; one input captures at most ${FEISHU_INPUT_MAX_LENGTH}`,
      };
    }
  }
  return { renderable: true };
}
