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
 * TEXT IS JUDGED BY ITS ESCAPED LENGTH. Agent text reaches a card through
 * `escapeFeishuCardText`, which expands a character up to 6x, so the raw
 * `.length` of the agent's text is not the size a component budget applies to.
 * Measuring raw length is what let a 100-char option label of all `<` pass the
 * 100-char bound and then get clipped: the user read a mangled fragment of the
 * agent's label. See `escapedLength`.
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
  | "pattern-unsupported"
  | "select-option-description-unsupported"
  | "card-text-too-large"
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
 *
 * WHY IT LIVES HERE rather than in elicitation-cards.ts: BOTH modules need it —
 * the card builders to escape, and this gate to MEASURE what they escaped — and
 * elicitation-cards.ts already imports this module's limits. Putting the
 * escaper here keeps the dependency a one-way edge (cards -> limits). Had it
 * stayed in cards.ts, limits would have had to import it back, and the resulting
 * cycle throws a TDZ `ReferenceError` on `MAX_CARD_CHARS` whenever the gate
 * module is reached first (which is every caller). `elicitation-cards.ts`
 * re-exports it so the historical import path still works.
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

/**
 * Length of `value` as the card platform will COUNT it: escaped.
 *
 * The single most load-bearing measurement in this module. Every Feishu
 * markdown / plain_text component receives agent text through
 * `escapeFeishuCardText` first, and that escaper expands a character up to 6x
 * (`~` and `|` become 6-char entities; `<`, `[`, `*`, `_`, `` ` `` and `#`
 * become 5-char ones). So the raw `.length` of agent text is NOT the size the
 * component budget applies to, and judging it by raw length was the BUG:
 * `"<".repeat(100)` measured 100, passed the 100-char option-label bound, then
 * expanded to 500 escaped chars and got clipped back to 100 by the safety net —
 * the user read a mangled fragment of the agent's label instead of the label.
 *
 * Measured through the real escaper rather than a hardcoded multiplier, so a
 * change to the escaper can never leave this gate quietly optimistic.
 */
export function escapedLength(value: string): number {
  return escapeFeishuCardText(value).length;
}

/**
 * Widest of the given strings in ESCAPED space.
 *
 * The budget a component is measured against is its escaped size, so "widest"
 * has to mean widest after escaping — see `escapedLength`.
 */
function longestEscaped(values: readonly string[]): number {
  return values.reduce((max, value) => Math.max(max, escapedLength(value)), 0);
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
 *
 * The optional `request` argument extends the gate to the OPENING card's
 * agent-authored text (`message`, `schemaTitle`, `schemaDescription`), which
 * lives on the request rather than on any field. It is optional so every
 * existing field-only caller keeps compiling and behaving exactly as before;
 * the one caller that has the whole request should pass it, because without it
 * a message too large to render faithfully was only caught by the
 * `boundRendered` BACKSTOP — the very truncation this gate exists to prevent.
 */
export function checkElicitationRenderability(
  fields: readonly ChannelElicitationField[],
  request?: ElicitationCardText,
): ElicitationRenderability {
  const fieldsVerdict = checkElicitationFieldsRenderability(fields);
  if (!fieldsVerdict.renderable) return fieldsVerdict;
  // The request's own text is checked LAST: a form that cannot be expressed at
  // all (multi-select, unbounded answer) is the decisive cause, and reporting
  // a long message first would hide it.
  if (request) return checkElicitationCardTextRenderability(request);
  return fieldsVerdict;
}

/** Field-level half of the gate. See `checkElicitationRenderability`. */
export function checkElicitationFieldsRenderability(
  fields: readonly ChannelElicitationField[],
): ElicitationRenderability {
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
    // An agent-supplied `pattern` is preserved by core as DISPLAY metadata and
    // never executed — unbounded agent regex is a resource-exhaustion vector.
    // That leaves the renderer holding a real schema constraint it can neither
    // show nor enforce, so the field is refused rather than rendered
    // unconstrained: the user would type "abc" against `^[A-Z]{3}$`, see the
    // form accepted, and the agent would get an answer its own schema rejects.
    //
    // Checked FIRST in the loop, before any kind-specific branch, because the
    // single-select branch below does not fall through — a select carrying a
    // pattern would otherwise be offered as a plain dropdown. Same contract as
    // Discord's gate, and the same reasoning as every other unexpressible
    // condition here: the platform cannot show what was asked, so it says so.
    if ("pattern" in field && field.pattern !== undefined) {
      return {
        renderable: false,
        reason: "pattern-unsupported",
        detail: `field ${JSON.stringify(field.key)} carries a pattern constraint, which this renderer can neither display nor enforce`,
      };
    }
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
      // Judged in ESCAPED space, which is the size `plainText` actually emits
      // and the size the 100-char component budget applies to. The raw length
      // is reported alongside it so an operator can see why a 90-char label was
      // refused: `"<".repeat(90)` is only 90 raw chars but 450 escaped ones.
      const widestLabel = longestEscaped(field.options.map((option) => option.label));
      if (widestLabel > FEISHU_TEXT_CONTENT_MAX) {
        const widestRaw = Math.max(...field.options.map((option) => option.label.length));
        return {
          renderable: false,
          reason: "select-option-label-too-long",
          detail: `field ${JSON.stringify(field.key)} option label is ${widestRaw} chars raw but ${widestLabel} escaped, limit ${FEISHU_TEXT_CONTENT_MAX} escaped`,
        };
      }
      // A `select_static` option carries ONLY `text` and `value`. The contract
      // preserves `description` on every option, and Discord puts it in the
      // select where the user can read it before choosing — Feishu's component
      // has no equivalent surface, so mapping only `{text, value}` silently
      // dropped it. Two options both labelled "Deploy" with different values
      // and different descriptions became two indistinguishable rows that
      // submit different answers, which is the user choosing something other
      // than what they read.
      //
      // Refused rather than dropped: a select whose options cannot be told apart
      // is not the question the agent asked.
      const described = field.options.find((option) => option.description !== undefined);
      if (described) {
        return {
          renderable: false,
          reason: "select-option-description-unsupported",
          detail: `field ${JSON.stringify(field.key)} option ${JSON.stringify(described.value)} carries a description, and a Feishu select_static option has no surface to show it`,
        };
      }
    }

    // A label IS the question (input.label). Feishu documents no cap, so the
    // documented placeholder cap is used as the bound: a label longer than the
    // placeholder may render differently from what was asked.
    //
    // Measured in ESCAPED space for the same reason the option label is: the
    // title becomes `input.label` AND the field card's bold heading, and both
    // render the escaped form. Judging the raw length let a 100-char title of
    // all `<` through, which then expanded to ~500 and was clipped — the user
    // saw part of the question the agent asked. Refusing is the honest answer.
    const escapedTitle = escapedLength(field.title);
    if (escapedTitle > FEISHU_TEXT_CONTENT_MAX) {
      return {
        renderable: false,
        reason: "field-label-too-long",
        detail: `field ${JSON.stringify(field.key)} label is ${field.title.length} chars raw but ${escapedTitle} escaped, limit ${FEISHU_TEXT_CONTENT_MAX} escaped`,
      };
    }
    if (escapedLength(field.description ?? "") > FEISHU_CARD_BODY_MAX_CHARS) {
      return {
        renderable: false,
        reason: "field-description-too-long",
        detail: `field ${JSON.stringify(field.key)} description is ${(field.description ?? "").length} chars raw but ${escapedLength(field.description ?? "")} escaped, limit ${FEISHU_CARD_BODY_MAX_CHARS} escaped`,
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
 * The request-scoped text the opening card renders.
 *
 * Declared as its own shape rather than a `Pick<ChannelElicitationRequest, …>`
 * so a caller may pass only the members it has: `message` is REQUIRED on a real
 * request, but `schemaTitle` / `schemaDescription` are optional there, and a
 * `Pick` would drag those requirements onto every caller of the gate.
 */
export interface ElicitationCardText {
  readonly message?: string;
  readonly schemaTitle?: string;
  readonly schemaDescription?: string;
}

/**
 * Would the OPENING card show the agent's own text faithfully?
 *
 * The opening card's message, schema title and schema description are each
 * rendered by `buildElicitationOpeningCard` as a markdown component whose
 * content is the ESCAPED agent text, bounded by `FEISHU_CARD_BODY_MAX_CHARS`.
 * Until this gate existed, that bound was enforced only by `boundRendered` —
 * the safety net that CUTS. So a `message` of `"<".repeat(8000)` expanded to
 * ~40,000 chars and was cut back to 28,000: the user was shown a fragment of
 * entity codes and none of the characters the agent actually sent. That is the
 * question being changed, which is the one thing a renderer may never do.
 *
 * A card that cannot show the message faithfully is REFUSED, so the request
 * cancels before a single card is sent.
 *
 * Checked after the field gate so a structural impossibility (multi-select,
 * unbounded answer) remains the reported cause when both apply.
 */
export function checkElicitationCardTextRenderability(
  request: ElicitationCardText,
): ElicitationRenderability {
  // Each piece of agent text becomes its OWN markdown component, so each is
  // measured against the per-component body budget on its own rather than
  // summed — the sum belongs to the serialized-card budget `fitsCardBudget`.
  const message = request.message;
  if (message) {
    const escaped = escapedLength(message);
    if (escaped > FEISHU_CARD_BODY_MAX_CHARS) {
      return {
        renderable: false,
        reason: "card-text-too-large",
        detail: `message is ${message.length} chars raw but ${escaped} escaped, limit ${FEISHU_CARD_BODY_MAX_CHARS} escaped per markdown component`,
      };
    }
  }
  // The schema title renders as `**…**`, the description as a bare line: same
  // component budget, same escape, so the same bound.
  for (const [name, value] of [
    ["schemaTitle", request.schemaTitle],
    ["schemaDescription", request.schemaDescription],
  ] as const) {
    if (!value) continue;
    const escaped = escapedLength(value);
    if (escaped > FEISHU_CARD_BODY_MAX_CHARS) {
      return {
        renderable: false,
        reason: "card-text-too-large",
        detail: `${name} is ${value.length} chars raw but ${escaped} escaped, limit ${FEISHU_CARD_BODY_MAX_CHARS} escaped per markdown component`,
      };
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
