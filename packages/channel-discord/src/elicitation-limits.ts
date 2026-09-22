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

export type ElicitationUnsupportedReason =
  | "select-option-count"
  | "select-option-label-too-long"
  | "select-option-value-too-long"
  | "select-option-description-too-long"
  | "select-min-max-out-of-range"
  | "field-label-too-long"
  | "field-description-too-long"
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
  }
  return { renderable: true };
}
