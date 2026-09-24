/**
 * Discord renderability gate: decide whether a core-normalized Elicitation form
 * can be represented FAITHFULLY on the Discord component platform, and reject
 * the ones that cannot before anything is posted.
 *
 * This is a RENDERER-capability decision, not schema normalization. Core has
 * already validated the schema against ACP; the question here is only whether
 * the values core handed over survive a round trip through Discord's
 * component API. When they cannot, the request cancels as unsupported rather
 * than being truncated, merged, or reshaped into a different schema — a form
 * the user sees must be the form the agent asked.
 *
 * Limits below are the ones this renderer actually exercises, sourced from the
 * installed Discord typings (`discord-api-types` v10 `message.d.ts`) and
 * `@discordjs/builders`, so they track the SDK version this package builds
 * against rather than a hand-copied table:
 *
 *   - string-select options: 1..25 (`APISelectMenuComponent.options` docblock:
 *     "Specified choices in a select menu; max 25"; builders enforce
 *     `lengthLessThanOrEqual(25)`).
 *   - select `min_values` / `max_values`: 0..25
 *     (`@discordjs/builders` validators).
 *   - select option label / value / description: 100 chars each
 *     (`APISelectMenuOption` docblocks).
 *   - text input label: 45 chars (`APITextInputComponent.label` docblock);
 *     text inputs may only appear inside a modal.
 *   - `custom_id`: 1..100 chars for every interactive component
 *     (Discord API docs; our custom ids are ~50, far inside it).
 *   - action row: at most 5 buttons (`APIButtonComponent` row layout
 *     documented as 1..5 per row); a message carries at most 5 rows.
 *
 * Row/button budgets are deliberately conservative: this renderer never
 * approaches them (one row of 3..4 buttons per card, one select at a time), so
 * a hard-coded cap of 5 is the documented platform maximum rather than a
 * measured requirement.
 */

import { satisfiesElicitationFormat } from "xacpx/plugin-api";
import type { ChannelElicitationField } from "xacpx/plugin-api";

/** Discard longer labels rather than rendering a control that violates the API. */
export const DISCORD_SELECT_OPTION_LABEL_MAX = 100;
export const DISCORD_SELECT_OPTION_VALUE_MAX = 100;
export const DISCORD_SELECT_OPTION_DESCRIPTION_MAX = 100;
export const DISCORD_TEXT_INPUT_LABEL_MAX = 45;
/** Maximum selectable options per single/multi select. */
export const DISCORD_SELECT_OPTION_COUNT_MAX = 25;
/** `min_values` / `max_values` accepted by the platform. */
export const DISCORD_SELECT_MIN_MAX_VALUES_MAX = 25;
/**
 * Text inputs per modal. Discord documents 1..5 modal components, so a wizard
 * that batches more than one text field per modal is unrenderable and must
 * cancel rather than silently dropping fields.
 */
export const DISCORD_MODAL_INPUT_MAX = 5;
/**
 * Buttons per action row (Discord documents 1..5 per row). Used to bound the
 * per-field Edit controls on the review page, which shares one row with
 * Submit / Decline / Cancel.
 */
export const DISCORD_ACTION_ROW_BUTTON_MAX = 5;
/**
 * A String Select's placeholder cap (Discord documents 150 characters, enforced
 * by `@discordjs/builders`). This renderer uses `field.title` as the
 * placeholder, so the title participates in this budget as well as the 45-char
 * Text Input label one.
 */
export const DISCORD_SELECT_PLACEHOLDER_MAX = 150;
/**
 * What a modal Text Input actually lets a user type: the platform's own
 * `max_length` ceiling. Core keeps `minLength`/`maxLength` on the field, so a
 * bound past this number is either impossible to satisfy or unsubmittable, and
 * the renderer must refuse rather than silently clamp.
 */
export const DISCORD_TEXT_CAPTURE_MAX = 4000;

export type ElicitationUnsupportedReason =
  | "select-option-count"
  | "select-option-label-too-long"
  | "select-option-value-too-long"
  | "select-option-description-too-long"
  | "select-min-max-out-of-range"
  | "select-placeholder-too-long"
  | "field-label-too-long"
  | "field-description-too-long"
  | "text-min-beyond-capture"
  | "text-max-beyond-capture"
  | "text-unbounded"
  | "pattern-unsupported"
  | "select-option-constraint-unsatisfiable"
  | "empty-select";

export interface ElicitationRenderability {
  renderable: boolean;
  reason?: ElicitationUnsupportedReason;
  /** Bounded diagnostic text for logs; never contains an answer. */
  detail?: string;
}

function longest(values: readonly string[]): number {
  return values.reduce((max, value) => Math.max(max, value.length), 0);
}

/**
 * Decide whether this exact normalized form survives Discord's component API.
 *
 * Ordering is deliberate: structural impossibilities (an option count the
 * platform cannot hold) are reported before cosmetic ones (a label that is
 * merely too long to show untruncated), so a log reader sees the decisive
 * cause first.
 */
export function checkElicitationRenderability(fields: readonly ChannelElicitationField[]): ElicitationRenderability {
  for (const field of fields) {
    if (field.kind === "boolean") continue;

    // An agent-supplied `pattern` is preserved by core as DISPLAY metadata and
    // deliberately never executed — unbounded agent regex is a resource
    // exhaustion vector. That decision leaves the renderer holding a real schema
    // constraint it can neither show nor enforce, so a field carrying one is
    // refused rather than rendered as an unconstrained input: the user would
    // otherwise type "abc" against `^[A-Z]{3}$`, see the form accepted, and the
    // agent would receive an answer its own schema rejects.
    //
    // Checked FIRST in the loop, before any kind-specific branch, because every
    // kind below `continue`s past it otherwise — a `single-select` carrying a
    // pattern would sail through this gate and be offered as a plain dropdown.
    // The honest reading of a constraint this renderer cannot express is to
    // decline the form, which is what every other unexpressible condition does.
    if ("pattern" in field && field.pattern !== undefined) {
      return {
        renderable: false,
        reason: "pattern-unsupported",
        detail: `field ${JSON.stringify(field.key)} carries a pattern constraint, which this renderer can neither display nor enforce`,
      };
    }
    if (field.kind === "single-select" || field.kind === "multi-select") {
      if (field.options.length === 0) {
        return {
          renderable: false,
          reason: "empty-select",
          detail: `field ${JSON.stringify(field.key)} has no options`,
        };
      }
      if (field.options.length > DISCORD_SELECT_OPTION_COUNT_MAX) {
        return {
          renderable: false,
          reason: "select-option-count",
          detail: `field ${JSON.stringify(field.key)} has ${field.options.length} options, limit ${DISCORD_SELECT_OPTION_COUNT_MAX}`,
        };
      }
      const longestLabel = longest(field.options.map((option) => option.label));
      if (longestLabel > DISCORD_SELECT_OPTION_LABEL_MAX) {
        return {
          renderable: false,
          reason: "select-option-label-too-long",
          detail: `field ${JSON.stringify(field.key)} option label is ${longestLabel} chars, limit ${DISCORD_SELECT_OPTION_LABEL_MAX}`,
        };
      }
      const worstValue = longest(field.options.map((option) => option.value));
      if (worstValue > DISCORD_SELECT_OPTION_VALUE_MAX) {
        return {
          renderable: false,
          reason: "select-option-value-too-long",
          detail: `field ${JSON.stringify(field.key)} option value is ${worstValue} chars, limit ${DISCORD_SELECT_OPTION_VALUE_MAX}`,
        };
      }
      const worstDescription = longest(field.options.map((option) => option.description ?? ""));
      if (worstDescription > DISCORD_SELECT_OPTION_DESCRIPTION_MAX) {
        return {
          renderable: false,
          reason: "select-option-description-too-long",
          detail: `field ${JSON.stringify(field.key)} option description is ${worstDescription} chars, limit ${DISCORD_SELECT_OPTION_DESCRIPTION_MAX}`,
        };
      }
      // The platform rejects a select whose min/max contract exceeds its option
      // budget outright; catching it here avoids a message that Discord itself
      // will refuse to accept.
      const bound = field.kind === "multi-select"
        ? Math.max(field.minItems ?? 0, field.maxItems ?? 0)
        : 0;
      if (bound > DISCORD_SELECT_MIN_MAX_VALUES_MAX) {
        return {
          renderable: false,
          reason: "select-min-max-out-of-range",
          detail: `field ${JSON.stringify(field.key)} requires min/max items ${bound}, limit ${DISCORD_SELECT_MIN_MAX_VALUES_MAX}`,
        };
      }
      // A String Select takes `field.title` as its PLACEHOLDER, capped at 150.
      // The label branch below is only reached by text/number fields (this one
      // `continue`s), which is why the title was never checked against it.
      if (field.title.length > DISCORD_SELECT_PLACEHOLDER_MAX) {
        return {
          renderable: false,
          reason: "select-placeholder-too-long",
          detail: `field ${JSON.stringify(field.key)} placeholder is ${field.title.length} chars, limit ${DISCORD_SELECT_PLACEHOLDER_MAX}`,
        };
      }
      // An option the validator is guaranteed to refuse is a dead choice: the
      // user sees it, picks it, reviews it, submits, and the broker cancels.
      // Refuse the form instead — filtering it silently would change the
      // question the agent asked.
      if (field.kind === "single-select") {
        const violating = field.options.find((option) =>
          optionViolatesFieldConstraints(field, option.value));
        if (violating) {
          return {
            renderable: false,
            reason: "select-option-constraint-unsatisfiable",
            detail: `field ${JSON.stringify(field.key)} offers an option that cannot satisfy its own constraints`,
          };
        }
      }
      continue;
    }

    // Text-like fields render through a modal whose label is capped at 45
    // characters. A longer label is not a rendering nicety to truncate: the
    // label IS the question, so a truncated question is a different question.
    if (field.title.length > DISCORD_TEXT_INPUT_LABEL_MAX) {
      return {
        renderable: false,
        reason: "field-label-too-long",
        detail: `field ${JSON.stringify(field.key)} label is ${field.title.length} chars, limit ${DISCORD_TEXT_INPUT_LABEL_MAX}`,
      };
    }
    if ((field.description ?? "").length > 1000) {
      return {
        renderable: false,
        reason: "field-description-too-long",
         detail: `field ${JSON.stringify(field.key)} description is ${(field.description ?? "").length} chars, limit 1000`,
      };
    }
    if (field.kind === "text") {
      // The capture capacity is fixed by the renderer (a modal Text Input's
      // `max_length`). Core's answer validator is authoritative on bounds, so
      // the renderer must NOT silently clamp them: a `minLength` above capacity
      // makes the field impossible, and a `maxLength` above it makes every
      // answer past capacity unsubmittable. Both are refusals, not truncations.
      const minLength = field.minLength ?? 0;
      if (minLength > DISCORD_TEXT_CAPTURE_MAX) {
        return {
          renderable: false,
          reason: "text-min-beyond-capture",
          detail: `field ${JSON.stringify(field.key)} requires at least ${minLength} chars but the platform input captures ${DISCORD_TEXT_CAPTURE_MAX}`,
        };
      }
      if (field.maxLength !== undefined && field.maxLength > DISCORD_TEXT_CAPTURE_MAX) {
        return {
          renderable: false,
          reason: "text-max-beyond-capture",
          detail: `field ${JSON.stringify(field.key)} allows ${field.maxLength} chars but the platform input captures ${DISCORD_TEXT_CAPTURE_MAX}`,
        };
      }
      // NO DECLARED BOUND is the same refusal, not a licence to invent one.
      //
      // `maxLength` is optional in the plugin contract and core only validates
      // it when present, so an absent bound means the accepted domain is
      // everything up to the aggregate answer policy — strictly larger than
      // this modal can capture. Defaulting the input to 4000 (as the modal does
      // when the field omits the bound) quietly narrows the agent's question to
      // what the widget happens to allow: the user can only ever submit the
      // renderer's choice of maximum, and a longer answer the agent would have
      // accepted is rejected by the platform before core ever sees it.
      //
      // Refusing the whole form is the honest outcome, exactly as the two
      // bounds above do: the platform cannot express what was asked, so it says
      // so instead of substituting a different question.
      if (field.maxLength === undefined) {
        return {
          renderable: false,
          reason: "text-unbounded",
          detail: `field ${JSON.stringify(field.key)} declares no maxLength, so its answers are not bounded to the ${DISCORD_TEXT_CAPTURE_MAX} chars a modal input can capture`,
        };
      }
    }
  }
  return { renderable: true };
}

/**
 * Would core accept this exact option as a submitted answer?
 *
 * Used to reject a form whose UI offers a value the validator is GUARANTEED to
 * refuse: core applies `minLength`/`maxLength`/`format` to the chosen option
 * value as well as to free text, so an enum `["a","bb"]` carrying
 * `minLength: 2` presents "a" in a dropdown, accepts the click, and only
 * rejects at the broker — after the user has already made the choice. The
 * alternative (silently filtering the option) would hide part of the agent's
 * question, so the honest answer is to not render the form at all.
 */
export function optionViolatesFieldConstraints(
  field: Extract<ChannelElicitationField, { kind: "single-select" }>,
  value: string,
): boolean {
  const length = codePointCount(value);
  if (field.minLength !== undefined && length < field.minLength) return true;
  if (field.maxLength !== undefined && length > field.maxLength) return true;
  // DELEGATED to core, deliberately. An earlier version of this check carried
  // its own shape-only regexes: a date regex that accepted "2026-99-99", and an
  // email regex that disagreed with ajv-formats. Both made a dead option look
  // live, which is the exact bug this function exists to prevent. One shared
  // predicate keeps the renderer's answer identical to the validator's.
  return !satisfiesElicitationFormat(field.format, value);
}

/**
 * The first answer core is guaranteed to reject, or null when every collected
 * answer satisfies its field.
 *
 * The renderer runs this BEFORE committing a review. Without it a user could
 * review, submit, watch the card turn "Accepted", and only then have the broker
 * cancel the turn — the card contradicts the protocol result, and the user is
 * never given the chance to fix what they typed. Core remains the authority;
 * this only moves its verdict to a moment when the form is still editable.
 *
 * Deliberately limited to what is DETERMINISTIC and renderer-known: the length
 * bounds and the ACP known formats, via the same shared predicate the option
 * check uses. Agent-supplied `pattern` is never executed here (see core's
 * `validateElicitationAnswer`), and number bounds are enforced by the widget at
 * input time, so both are left to core.
 */
export function findRejectedAnswer(
  fields: readonly ChannelElicitationField[],
  values: Readonly<Record<string, unknown>>,
): { key: string; reason: string } | null {
  for (const field of fields) {
    if (!Object.hasOwn(values, field.key)) {
      // Absent is a SKIP, which core accepts for an optional field. A required
      // gap is caught by the caller's own missing-field check.
      continue;
    }
    const value = values[field.key];
    if (field.kind === "text") {
      if (typeof value !== "string") continue;
      const chars = codePointCount(value);
      if (field.minLength !== undefined && chars < field.minLength) {
        return { key: field.key, reason: `shorter than ${field.minLength} characters` };
      }
      if (field.maxLength !== undefined && chars > field.maxLength) {
        return { key: field.key, reason: `longer than ${field.maxLength} characters` };
      }
      if (!satisfiesElicitationFormat(field.format, value)) {
        return { key: field.key, reason: `not a valid ${field.format ?? "string"}` };
      }
      continue;
    }
    // A select answer must be one the agent offered: the dead-choice case the
    // option gate already refuses at form level, restated for a value recorded
    // before the gate existed.
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

/**
 * Unicode code POINTS, matching core's answer validator ("😀".length === 2 in
 * JS but is one character per the JSON Schema spec).
 */
function codePointCount(value: string): number {
  return [...value].length;
}
