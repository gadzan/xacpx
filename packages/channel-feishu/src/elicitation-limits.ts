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

import { satisfiesElicitationFormat } from "xacpx/plugin-api";
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
  | "answer-unbounded"
  | "card-too-large"
  | "empty-select"
  | "option-constraint-unsatisfiable"
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
 * Would this card fit inside Feishu's card JSON budget?
 *
 * A SEPARATE check from `checkElicitationRenderability` because it needs the
 * BUILT card, while the field-level gate runs before anything is sent. Calling
 * it on the assembled card is the only honest way to answer: the card's real size
 * is a property of the escaped text, the per-field chrome, and the routing
 * payloads together, none of which is visible from the schema alone.
 */
export function fitsCardBudget(card: unknown): ElicitationRenderability {
  const size = measureElicitationCardBytes(card);
  if (size <= FEISHU_CARD_JSON_MAX_BYTES) return { renderable: true };
  return {
    renderable: false,
    reason: "card-too-large",
    detail: `card is ${size} bytes serialized; limit ${FEISHU_CARD_JSON_MAX_BYTES}`,
  };
}

/**
 * Serialized size of a card, in bytes, exactly as Feishu will receive it.
 *
 * CardKit validates the JSON PAYLOAD of `card.data` (error 200860 "Card content
 * exceeds limit") at 30 KB, which is a byte count of the serialized string — not
 * a JS `.length` of the source text, and not a count of elements. Feishu also
 * receives UTF-8, so a multi-byte character costs 2-4 bytes against the budget.
 */
export function measureElicitationCardBytes(card: unknown): number {
  return Buffer.byteLength(JSON.stringify(card), "utf8");
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
    // NO DECLARED BOUND is the same refusal, not a licence to invent one.
    //
    // `maxLength` is optional in the plugin contract and core only validates it
    // when present, so an absent bound means the accepted domain is everything up
    // to the aggregate answer policy — strictly larger than one input can hold.
    // `maxLengthFor` used to default the widget to 1000, which quietly narrowed
    // the agent's question to the renderer's own choice: any longer answer the
    // agent would have accepted became unreachable before core ever saw it.
    if (field.kind === "text" && field.maxLength === undefined) {
      return {
        renderable: false,
        reason: "answer-unbounded",
        detail: `field ${JSON.stringify(field.key)} declares no maxLength, so its answers are not bounded to the ${FEISHU_INPUT_MAX_LENGTH} chars one input captures`,
      };
    }
    // The other side of the same capacity bound: a field that REQUIRES more
    // characters than the input can hold is impossible to satisfy, not merely
    // inconvenient.
    if (field.kind === "text" && field.minLength !== undefined && field.minLength > FEISHU_INPUT_MAX_LENGTH) {
      return {
        renderable: false,
        reason: "answer-too-long",
        detail: `field ${JSON.stringify(field.key)} requires at least ${field.minLength} chars; one input captures at most ${FEISHU_INPUT_MAX_LENGTH}`,
      };
    }
    // An option core is guaranteed to reject is a dead choice, exactly as on
    // Discord: the user sees it, picks it, reviews it, and only the broker
    // refuses. Refusing the form is more honest than hiding part of the
    // agent's question by filtering it out.
    if (field.kind === "single-select") {
      const violating = field.options.find((option) => optionViolatesFieldConstraints(field, option.value));
      if (violating) {
        return {
          renderable: false,
          reason: "option-constraint-unsatisfiable",
          detail: `field ${JSON.stringify(field.key)} offers an option that cannot satisfy its own constraints`,
        };
      }
    }
  }
  return { renderable: true };
}

/**
 * Would core accept this exact option as an answer for this field?
 *
 * false means the choice is dead on arrival: the user can select it, review it,
 * and submit, and only then does the broker refuse. A form containing one is
 * refused instead, because filtering the option silently would change the
 * question the agent asked.
 *
 * Conservative by construction: it runs at render time on agent-supplied data,
 * so a wrong `true` only ever lets a form through that core may still refuse.
 * Core remains the authority on what a submitted answer satisfies.
 */
export function optionViolatesFieldConstraints(
  field: Extract<ChannelElicitationField, { kind: "single-select" }>,
  value: string,
): boolean {
  // Code POINTS, matching core's validator: "😀".length is 2 in JS but one
  // character per the JSON Schema spec.
  const length = [...value].length;
  if (field.minLength !== undefined && length < field.minLength) return true;
  if (field.maxLength !== undefined && length > field.maxLength) return true;
  // DELEGATED to core. An earlier version carried its own shape-only regexes —
  // a date regex that accepted "2026-99-99" — which made a dead option look
  // live, exactly the bug this function exists to prevent.
  return !satisfiesElicitationFormat(field.format, value);
}

/**
 * The first collected answer core is guaranteed to reject, or null when every
 * answer satisfies its field.
 *
 * The review-page submit runs this BEFORE the card is withdrawn as "accepted".
 * Without it a user could review, submit, watch the card say Accepted, and only
 * then have the broker cancel the turn — the card contradicts the protocol
 * result, and nobody gets the chance to correct a typo. Core stays the
 * authority; this only asks its question while the form is still editable.
 *
 * Limited to what is deterministic and renderer-known, exactly like
 * `optionViolatesFieldConstraints`: the length bounds and the ACP known formats
 * through the shared predicate. Agent `pattern` is never executed (core refuses
 * it too — a resource-exhaustion vector), and a number's range is enforced by
 * the widget at input time.
 */
export function findRejectedAnswer(
  fields: readonly ChannelElicitationField[],
  values: Readonly<Record<string, unknown>>,
): { key: string; reason: string } | null {
  for (const field of fields) {
    if (!Object.hasOwn(values, field.key)) {
      // Absent is a SKIP, legal for an optional field; a required gap is the
      // caller's own missing-field check.
      continue;
    }
    const value = values[field.key];
    if (field.kind === "text") {
      if (typeof value !== "string") continue;
      const length = [...value].length;
      if (field.minLength !== undefined && length < field.minLength) {
        return { key: field.key, reason: `shorter than ${field.minLength} characters` };
      }
      if (field.maxLength !== undefined && length > field.maxLength) {
        return { key: field.key, reason: `longer than ${field.maxLength} characters` };
      }
      if (!satisfiesElicitationFormat(field.format, value)) {
        return { key: field.key, reason: `not a valid ${field.format ?? "string"}` };
      }
      continue;
    }
    if (field.kind === "single-select") {
      if (typeof value !== "string") continue;
      if (!field.options.some((option) => option.value === value)) {
        return { key: field.key, reason: "not an offered option" };
      }
      if (!satisfiesElicitationFormat(field.format, value)) {
        return { key: field.key, reason: `not a valid ${field.format ?? "string"}` };
      }
      continue;
    }
    if (field.kind === "multi-select") {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (typeof item !== "string" || !field.options.some((option) => option.value === item)) {
          return { key: field.key, reason: "not an offered option" };
        }
      }
      continue;
    }
  }
  return null;
}
