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
import type { ChannelElicitationField, ChannelElicitationRequest, ChannelElicitationValue } from "xacpx/plugin-api";
import { t as getMessages } from "./i18n/index.js";
import { escapeDiscordLiteralText } from "./permission-ui.js";

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

/**
 * Hard ceiling for a field card's rendered text.
 *
 * A field page must stay a SINGLE message: the opening and review cards chunk
 * across messages, but a wizard step re-renders from several directions (an
 * interaction, a modal, a review->Edit jump) and a continuation set written by
 * one while another is in flight misaligns — leaving the previous answer visible
 * under the current one with no way to tell which one Submit sends. So the gate
 * refuses a field whose rendered text cannot fit, rather than chunking it.
 */
export const FIELD_CARD_TEXT_MAX = 1800;

/**
 * Bound on the "Answer saved" echo in a field card's own text.
 *
 * A field card repeats an answer the user already typed; it does not ask them to
 * read it as the question. The full value is always on the review page, which
 * chunks and is the surface ACP requires review before sending. Bounding the echo
 * is what lets a field page stay a single message after a 4000-character answer.
 */
export const FIELD_CARD_ANSWER_ECHO_MAX = 200;

/**
 * The worst "Answer saved" echo a field card can carry, as an answer VALUE.
 *
 * The gate must reserve space for the echo, not just the initial render: a user
 * returning to an answered field gets an extra line, and an initial body near the
 * limit would otherwise overflow on the SECOND render — after the answer had
 * already been given, when refusing is no longer possible. A field page cannot be
 * chunked, so that overflow is a throw in the builder and a field the user cannot
 * get back to.
 *
 * WHY THIS IS A BOUND AND NOT A SAMPLE. No "representative" value can be an upper
 * bound, because the echo is
 * `escape(truncate(displayValue(current), 200))` — cut to 200 RAW characters and
 * only THEN escaped. So a value that looks narrow can render wide, and a value
 * that looks wide can be cut down to almost nothing. Two concrete examples:
 *
 *   - number. `0` is one character; `-Number.MAX_VALUE` is 24. Reserving for the
 *     first underestimates by 23.
 *   - multi-select. With options A=x*100, B=y*100, C=*x100 and `maxItems: 2`,
 *     the "all options" sample is cut to `x...x, y` — it never reaches C at all,
 *     while the legal subset [B, C] renders ~298 escaped characters from 200 raw.
 *     A narrower ILLEGAL sample is the opposite of a bound.
 *
 * So each kind reserves the widest thing its own legal answers can produce, in
 * whichever of two ways is sound:
 *
 *   - where the space is small enough to know, the widest legal VALUE: `false`
 *     for a boolean, the widest finite double for a number (clamped to the
 *     schema's declared range).
 *   - where it is not — a text answer of any shape, or any subset of a
 *     multi-select — the widest thing a 200-raw-character string can render to,
 *     which is an upper bound for all of them by construction and cannot be
 *     beaten by choosing a cleverer answer.
 */
function boundedAnswerEcho(field: ChannelElicitationField): ChannelElicitationValue | undefined {
  switch (field.kind) {
    // The longer spelling. `false` renders one character wider than `true`, and
    // that is the whole space.
    case "boolean":
      return false;
    case "number":
      return widestNumberEcho(field);
    case "single-select":
      return widestRenderedOption(field);
    case "multi-select":
      // No subset can be enumerated in bounded time, and the joined sample is not
      // a bound for the reason above. The universal raw-expansion bound is one:
      // 200 raw characters of the character the escaper expands the most, which
      // is the widest ANY 200-raw-character string can render to, whatever its
      // shape. A legal answer can therefore never exceed it.
      return worstEchoText(field);
    default:
      // text, and every format variant of it (date/email/uri arrive as text).
      // Clamped to the field's own declared `maxLength` where there is one, so a
      // field that caps its answer at 10 characters does not have 200 reserved
      // against it. Without the clamp this over-refuses legal forms at the
      // boundary, which is the failure mode in the other direction.
      return worstEchoText(field);
  }
}

/**
 * 200 raw characters (or the field's own bound, whichever is smaller) of the
 * character the escaper expands the most.
 */
function worstEchoText(field: ChannelElicitationField): string {
  const declared = "maxLength" in field && typeof field.maxLength === "number" ? field.maxLength : undefined;
  const raw = Math.min(declared ?? FIELD_CARD_ANSWER_ECHO_MAX, FIELD_CARD_ANSWER_ECHO_MAX);
  return WIDEST_ESCAPE_CHARACTER.repeat(Math.max(0, raw));
}

/**
 * The number whose rendered form is the widest a legal answer can produce.
 *
 * `String()` of a finite double is at most 24 characters — `-Number.MAX_VALUE` —
 * and none of the characters it can emit (digits, `-`, `.`, `e`, `+`) are escaped
 * by `escapeDiscordLiteralText`, so the rendered width equals the character count.
 * That makes the bound exact rather than approximate: 24 characters is the
 * widest, and every other finite number renders at or under it.
 *
 * Clamped to the schema's declared bounds when it has them, so a
 * `maximum: 100` field does not carry 24 characters it can never reach.
 */
function widestNumberEcho(field: Extract<ChannelElicitationField, { kind: "number" }>): number {
  const widest = -Number.MAX_VALUE;
  if (field.minimum !== undefined && widest < field.minimum) return field.minimum;
  if (field.maximum !== undefined && widest > field.maximum) return field.maximum;
  return widest;
}

/** Cut a rendered string to `max`, appending an ellipsis when it is cut. */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}

/**
 * The character `escapeDiscordLiteralText` expands the most.
 *
 * Measured rather than hardcoded, so the echo tracks the escaper: if the escaping
 * ever changes, the worst case changes with it instead of quietly going optimistic.
 */
const WIDEST_ESCAPE_CHARACTER = ((): string => {
  // Every metacharacter Discord's literal escaper rewrites. `*` is the one that
  // becomes two characters; the others are included so a change to the escaper
  // cannot leave this constant stale.
  const candidates = [..."*_`~|\\<>()[]#+.!-"];
  let widest = candidates[0]!;
  for (const candidate of candidates) {
    if (escapeDiscordLiteralText(candidate).length > escapeDiscordLiteralText(widest).length) widest = candidate;
  }
  return widest;
})();

/**
 * The option whose DISPLAYED value renders widest, through the same truncate and
 * escape the echo applies.
 *
 * Using the longest RAW value was the optimistic half: a value full of escapable
 * characters renders wider than a longer one that happens to be plain, and the
 * echo is the rendered string.
 */
function widestRenderedOption(field: Extract<ChannelElicitationField, { kind: "single-select" }>): string {
  // Escaped width of the echo a value produces, exactly as the builder emits it:
  // cut to the bound in RAW characters first, then escaped.
  const width = (value: string): number =>
    escapeDiscordLiteralText(truncate(value, FIELD_CARD_ANSWER_ECHO_MAX)).length;
  let widest = field.options[0]?.value ?? "";
  let widestWidth = width(widest);
  for (const option of field.options.slice(1)) {
    const optionWidth = width(option.value);
    if (optionWidth > widestWidth) {
      widest = option.value;
      widestWidth = optionWidth;
    }
  }
  return widest;
}

/**
 * The complete static text of a field card, in render order.
 *
 * ONE definition, used by both the card builder and the renderability gate, so
 * the two cannot disagree about what a field page renders. When the gate kept
 * its own hand-copied subset (title + description + default), it under-measured:
 * the builder also emits the "Question N of M" label, the agent line, the hint,
 * and — once a value exists — the "Answer saved" line. A description the gate
 * sized at ~1750 escaped chars therefore rendered to ~1818, produced a second
 * chunk, and the field card kept only the first.
 *
 * Lives here rather than in elicitation-ui.ts because the GATE has to build the
 * same text in order to measure it, and ui.ts already imports this module — the
 * reverse edge would be a cycle. `escapeDiscordLiteralText` and `hintForField`
 * come along for the same reason, re-exported so existing import paths hold.
 *
 * `current` is the answer already collected, which only appears once the user has
 * answered. The gate passes `undefined`, because the initial render is the
 * baseline every branch has to fit.
 */
export function buildElicitationFieldLines(
  request: ChannelElicitationRequest,
  field: ChannelElicitationField,
  index: number,
  current: ChannelElicitationValue | undefined,
): string[] {
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
    //
    // BOUNDED, because this line REPEATS what the user typed rather than asking
    // them something: a 4000-character answer would make the field card several
    // messages, and a field page must stay one (see the chunk guard below). The
    // full answer is always visible on the review page, which chunks properly and
    // is the surface ACP requires the user to review before sending. So cutting
    // this echo loses nothing the user cannot see elsewhere.
    lines.push(`${messages.elicitationAnswerSaved} ${escapeDiscordLiteralText(truncate(displayValue(current), FIELD_CARD_ANSWER_ECHO_MAX))}`);
  }
  return lines;
}

/** A field default or answer rendered the way the card shows it. */
function displayValue(value: string | number | boolean | readonly string[]): string {
  return Array.isArray(value) ? value.join(", ") : String(value);
}

/** The hint line under a field's title, mirroring `hintForField` in elicitation-ui. */
function hintForField(field: ChannelElicitationField): string {
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

export type ElicitationUnsupportedReason =
  | "select-option-count"
  | "select-option-label-too-long"
  | "select-option-value-too-long"
  | "select-option-description-too-long"
  | "select-min-max-out-of-range"
  | "select-placeholder-too-long"
  | "field-label-too-long"
  | "field-description-too-long"
  | "field-text-too-long"
  | "route-not-private"
  | "text-min-beyond-capture"
  | "text-max-beyond-capture"
  | "text-max-unsatisfiable"
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
export function checkElicitationRenderability(
  fields: readonly ChannelElicitationField[],
  // REQUIRED, not optional.
  //
  // The field budget is measured over the text `buildElicitationFieldCard`
  // actually builds, and only the request carries what that depends on: the real
  // `agent.name`, the route that decides whether a form may be shown at all, and
  // the answer echo a returning user gets. A field-only caller gets a
  // `renderable: true` for a form the builder will throw on, which is the silent
  // under-check this gate exists to prevent — so the optional form was removed
  // rather than kept for compatibility.
  request: ChannelElicitationRequest,
): ElicitationRenderability {
  // PRIVACY: a form is private to its requester, and the destination has to prove
  // it. See the Discord channel's own gate for the full reasoning; the field-level
  // half still needs the request to know the route, because the agent's question
  // AND the user's answers both go into the chat.
  if (request.chatType !== "direct") {
    return {
      renderable: false,
      reason: "route-not-private",
      detail: `a form is only renderable on a private route; this turn reported ${request.chatType ?? "no chatType"}`,
    };
  }
  for (const field of fields) {
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
    // A FIELD PAGE IS ONE MESSAGE, and the escape can make it several.
    //
    // Checked for EVERY field kind, so it runs BEFORE the select branch's
    // `continue` rather than after it. A single-select with a 1000-char
    // description of `*` used to sail through this gate and then throw in the
    // builder when the user pressed Start, because the select branch was the one
    // that skipped the budget.
    //
    // The text is built through the SAME definition the builder uses, with the
    // SAME request — including the real `agent.name`, which a synthetic request
    // under-measured by exactly the agent-name length. That was the hole the
    // boundary regression missed by testing either side of it rather than on it.
    //
    // The answer echo is reserved at its maximum too: a user returning to an
    // answered field adds an "Answer saved" line, and an initial body near the
    // limit would otherwise overflow on the SECOND render, after the answer had
    // already been given.
    const fieldLines = buildElicitationFieldLines(
      request,
      field,
      fields.indexOf(field) + 1,
      boundedAnswerEcho(field),
    );
    if (fieldLines.join("\n\n").length > FIELD_CARD_TEXT_MAX) {
      return {
        renderable: false,
        reason: "field-text-too-long",
        detail: `field ${JSON.stringify(field.key)} renders to ${fieldLines.join("\n\n").length} escaped chars, limit ${FIELD_CARD_TEXT_MAX}`,
      };
    }
    // The remaining kind-specific checks below all describe TEXT-like fields; a
    // boolean has already passed the pattern and budget checks above, both of
    // which apply to every kind.
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
      // A multi-select's bounds are normalised EXACTLY as the component builder
      // normalises them, so the gate judges the domain the user is actually
      // given. Judging raw schema values here produced two opposite errors:
      //
      //   minValues > maxValues. `{ options: 2, minItems: 3 }` — the gate saw
      //   `max(3, 0) = 3`, allowed it, and the builder then emitted
      //   `minValues: 3, maxValues: 2`, a component Discord rejects outright.
      //   A false rejection. `{ options: 2, maxItems: 40 }` — the gate refused a
      //   form whose answer domain is at most the two values actually offered,
      //   because it compared the raw 40 against the platform's 25.
      //
      // An absent `maxItems` means "any number of the offered options", which IS
      // bounded — by how many options there are.
      if (field.kind === "multi-select") {
        const minValues = field.minItems ?? 0;
        const maxValues = Math.min(field.maxItems ?? field.options.length, field.options.length);
        // min > max is unsatisfiable: no selection can satisfy it.
        if (minValues > maxValues) {
          return {
            renderable: false,
            reason: "select-min-max-out-of-range",
            detail: `field ${JSON.stringify(field.key)} requires at least ${minValues} selections but only ${maxValues} are offered`,
          };
        }
        if (minValues > DISCORD_SELECT_MIN_MAX_VALUES_MAX || maxValues > DISCORD_SELECT_MIN_MAX_VALUES_MAX) {
          return {
            renderable: false,
            reason: "select-min-max-out-of-range",
            detail: `field ${JSON.stringify(field.key)} requires ${minValues}..${maxValues} selections, platform limit ${DISCORD_SELECT_MIN_MAX_VALUES_MAX}`,
          };
        }
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
      // A `maxLength` of 0 is legal for CORE and impossible for the PLATFORM.
      // Core's `readOptionalPositiveInteger` accepts 0 and its validator accepts
      // `""` as satisfying `maxLength: 0`, but Discord's Text Input `max_length`
      // is bounded to a minimum of 1 and `""` is a real answer ACP allows. So a
      // legal `{type: "string", maxLength: 0}` would build an invalid component.
      if (field.maxLength !== undefined && field.maxLength <= 0) {
        return {
          renderable: false,
          reason: "text-max-unsatisfiable",
          detail: `field ${JSON.stringify(field.key)} declares maxLength ${field.maxLength}, but the platform input requires at least 1`,
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
      // The schema's own item bounds, checked before the review is committed so
      // the user can correct a selection instead of seeing Accepted and then a
      // cancellation. An empty array is LEGAL — core accepts `[]` and only limits
      // the length when `minItems`/`maxItems` are declared.
      if (field.minItems !== undefined && value.length < field.minItems) {
        return { key: field.key, reason: `selects fewer than ${field.minItems}` };
      }
      if (field.maxItems !== undefined && value.length > field.maxItems) {
        return { key: field.key, reason: `selects more than ${field.maxItems}` };
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
