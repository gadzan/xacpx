/**
 * Strict ACP form-Elicitation normalizer and answer validator (M1).
 *
 * The ACP `elicitation/create` form payload carries a restricted flat JSON
 * Schema. Core is the only component that interprets it: channel plugins
 * receive the normalized `ChannelElicitationField[]` model, and every answer
 * is re-validated here before it can reach the agent. Anything this module
 * cannot render faithfully or validate deterministically cancels the request
 * — unsupported fields are never silently dropped.
 */

import {
  type ChannelElicitationField,
  type ChannelElicitationOption,
  type ChannelElicitationValue,
} from "./elicitation-types.js";

/** Resource bounds: the normalizer refuses anything it cannot bound. */
export const ELICITATION_SCHEMA_LIMITS = {
  maxFields: 20,
  maxFieldKeyLength: 128,
  maxFieldTitleLength: 256,
  maxFieldDescriptionLength: 1000,
  maxOptionsPerField: 100,
  maxOptionLabelLength: 256,
  maxOptionValueLength: 256,
  maxDefaultValueLength: 256,
  /**
   * Max chars of a string `format` value. ACP treats formats other than
   * `email | uri | date | date-time` as annotations the client must preserve,
   * so an arbitrary agent-controlled string reaches the renderer — which still
   * needs a bound like every other string field.
   */
  maxFormatLength: 64,
  /**
   * ACP uint32 ceiling. `minLength`/`maxLength` are declared uint32 and the
   * pinned SDK enforces `z.int().gte(0).max(4294967295)`, so a larger value is
   * rejected upstream of xacpx and must be rejected here too — otherwise core
   * publishes a constraint the ACP reader refuses.
   *
   * Deliberately NOT applied to `minItems`/`maxItems`, which ACP declares as
   * bare numbers on the uint64 side. Each ceiling is passed by the caller that
   * matches ACP's declaration, never inherited from a shared helper.
   */
  maxUint32: 0xffffffff,
  maxRequiredNames: 20,
  /**
   * Max characters of an agent-controlled string echoed into a diagnostic
   * reason. Property names and item types are agent-controlled and can be
   * arbitrarily long, and the reason reaches the logger verbatim.
   */
  maxDiagnosticKeyChars: 64,
  /**
   * Aggregate policy cap over every string in the normalized form.
   *
   * This is deliberately NOT sized to admit every individually-legal form.
   * The per-field limits compose multiplicatively: 20 fields × 100 titled
   * options × (256 value + 256 label + 1000 description) is ~3.3M chars, all
   * of it individually legal. Admitting that would defeat the purpose, so this
   * is an independent product policy — xacpx will not ask a human to fill in a
   * 3MB form on a chat channel.
   *
   * 256k is chosen so any realistic form (a handful of fields with ordinary
   * option lists) passes, while pathological aggregates cancel. Forms that
   * exceed it are cancelled with `resource_exceeded`, never truncated.
   */
  maxNormalizedFormChars: 256_000,
  /**
   * Aggregate cap over the ACCEPTED answer, enforced by core independently of
   * the schema. `maxLength` on a text field is agent-supplied and optional, so
   * without this a channel could return an arbitrarily large answer that core
   * would accept and then copy through daemon → bridge → worker → ACP.
   */
  maxAcceptedAnswerChars: 65_536,
  maxMessageLength: 8000,
  maxPatternLength: 512,
} as const;

export interface NormalizedElicitationForm {
  message: string;
  /**
   * Schema-level `title` / `description` from `requestedSchema`. ACP defines
   * them as part of the restricted schema, and plugins cannot see the raw ACP
   * object, so dropping them here would make them unrenderable downstream.
   */
  schemaTitle?: string;
  schemaDescription?: string;
  fields: ChannelElicitationField[];
}

export type ElicitationNormalizationResult =
  | { ok: true; form: NormalizedElicitationForm }
  | { ok: false; reason: string };

/** Stable failure categories for logging (never includes field content). */
export type ElicitationSchemaFailureCategory =
  | "malformed_request"
  | "unsupported_mode"
  | "malformed_schema"
  | "resource_exceeded";

function fail(
  category: ElicitationSchemaFailureCategory,
  detail: string,
): ElicitationNormalizationResult {
  return { ok: false, reason: `${category}: ${detail}` };
}

type Plain = Record<string, unknown>;

function asPlain(value: unknown): Plain | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Plain)
    : undefined;
}

/**
 * Bounded rendering of a field key for diagnostics. ACP property names are
 * agent-controlled and can be arbitrarily long (the protocol's message ceiling
 * is 64 MiB), so echoing one into a reason that reaches the logger would
 * produce an unbounded log line. Report a stable prefix plus the length.
 */
function boundedKeyLabel(key: string): string {
  const max = ELICITATION_SCHEMA_LIMITS.maxDiagnosticKeyChars;
  return key.length <= max ? key : `${key.slice(0, max)}...(${key.length} chars)`;
}

function readString(holder: Plain, key: string): string | undefined {
  const value = holder[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * An OPTIONAL bounded string. Absent/null means "not provided"; a present
 * empty string is LEGAL — the pinned ACP SDK models these as plain
 * `z.string()` with no `.min(1)`, so `title: ""`, `pattern: ""` and
 * `description: ""` are protocol-valid and must not be treated as malformed.
 * Presentation policy (hide an empty title) is the renderer's call, not
 * core's.
 */
function readOptionalBoundedString(
  holder: Plain,
  key: string,
  max: number,
): { ok: true; value?: string } | { ok: false } {
  const value = holder[key];
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "string" || value.length > max) return { ok: false };
  return { ok: true, value };
}

/**
 * OPTIONAL PRESENTATION METADATA with the ACP reader's salvage semantics.
 *
 * Distinct from `readOptionalBoundedString`, and the difference is deliberate:
 * the pinned `@agentclientprotocol/sdk` 1.4.0 declares every presentation
 * string (`requestedSchema.title`, `.description`, each property's `title` /
 * `description`, `default`, and an `EnumOption`'s optional `description`) as
 *
 *     defaultOnError(z.string().nullish(), () => undefined)
 *
 * and `defaultOnError` is `schema.catch(fallback)`. So a NON-STRING value is
 * normalised to absent before xacpx's normalizer ever sees it — verified
 * empirically against the installed package. Rejecting the whole form for a
 * malformed title would reject input the ACP reader layer has already salvaged,
 * which is the same failure mode as rounds 16/18.
 *
 * NOT a general relaxation, and deliberately not applied to `pattern`: the SDK
 * declares `pattern: z.string().nullish()` with no catch, so a malformed
 * pattern really does fail upstream and must keep failing here.
 *
 * A present, in-range string is still subject to xacpx's OWN length cap: salvage
 * applies to the value's TYPE, not to xacpx's resource policy.
 */
function readSalvagedMetadataString(
  holder: Plain,
  key: string,
  max: number,
): { ok: true; value?: string } | { ok: false } {
  const value = holder[key];
  // Only the type is salvaged. Absent stays absent; `null` is a valid "absent".
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "string") return { ok: true };
  if (value.length > max) return { ok: false };
  return { ok: true, value };
}

/**
 * A REQUIRED bounded string. Unlike the optional reader, ABSENCE is a failure
 * — used where ACP marks the member mandatory (EnumOption.title). A present
 * empty string is still legal: missing and empty are different things, and
 * conflating them rejects protocol-valid input.
 */
function readRequiredBoundedString(
  holder: Plain,
  key: string,
  max: number,
): { ok: true; value: string } | { ok: false } {
  const value = holder[key];
  if (typeof value !== "string" || value.length > max) return { ok: false };
  return { ok: true, value };
}

function readOptionalStringArray(
  holder: Plain,
  key: string,
  max: number,
  maxItemLength = ELICITATION_SCHEMA_LIMITS.maxOptionValueLength,
): { ok: true; value?: string[] } | { ok: false } {
  const value = holder[key];
  if (value === undefined || value === null) return { ok: true };
  if (!Array.isArray(value) || value.length > max) return { ok: false };
  for (const item of value) {
    // Count alone is not a bound: 100 unbounded option strings are still an
    // unbounded payload handed to the renderer and held in pending state.
    if (typeof item !== "string" || item.length > maxItemLength) return { ok: false };
  }
  return { ok: true, value: value as string[] };
}

/**
 * Multi-select `default` with the ACP reader's PER-ITEM salvage semantics.
 *
 * The pinned `@agentclientprotocol/sdk` 1.4.0 declares it as
 *
 *     default: defaultOnError(vecSkipError(z.string()).nullish(), () => undefined)
 *
 * and `vecSkipError` is
 *
 *     z.array(itemSchema.catch(skippedItem)).transform(items => items.filter(i => i !== skippedItem))
 *
 * — i.e. each element is salvaged independently. Verified empirically:
 * `["a", 7, "b"]` arrives as `["a", "b"]`, `[null, "a"]` as `["a"]`, a non-array
 * `7` as `undefined`, and `["a", "a"]` is preserved with duplicates (the reader
 * does NOT dedupe — xacpx's own dedupe is an additional local policy).
 *
 * So a single malformed element must not discard the whole hint, which is the
 * same reader-parity class as rounds 16/18/19. Order of operations matters:
 *   1. O(1) admission on the RAW array length before any allocation;
 *   2. per-item salvage of non-strings;
 *   3. xacpx's own policy — offered-option filter, dedupe, `minItems`/`maxItems`
 *      and the item length bound.
 *
 * Deliberately NOT used for `enum` / `required`: the SDK declares those as plain
 * `z.array(z.string())` with no salvage, and `enum: ["a", 7]` genuinely throws
 * upstream (verified). Those keep the strict reader.
 */
function readSalvagedStringArray(
  holder: Plain,
  key: string,
  max: number,
): { ok: true; value?: string[] } | { ok: false } {
  const value = holder[key];
  if (value === undefined || value === null) return { ok: true };
  // A non-array is salvaged to absent, exactly like `defaultOnError`'s catch.
  if (!Array.isArray(value)) return { ok: true };
  // Admission on the RAW length, before allocating the filtered copy.
  if (value.length > max) return { ok: false };
  const kept: string[] = [];
  for (const item of value) {
    // Per-item salvage: a non-string is skipped, not fatal.
    if (typeof item !== "string") continue;
    // A present-but-oversized string is still xacpx's own resource policy.
    if (item.length > ELICITATION_SCHEMA_LIMITS.maxOptionValueLength) return { ok: false };
    kept.push(item);
  }
  return { ok: true, value: kept };
}

/**
 * An optional non-negative integer, optionally bounded above.
 *
 * The optional `max` exists because ACP gives different integer members
 * DIFFERENT ranges and the choice is observable:
 *
 *   - `minLength` / `maxLength` are **uint32** — the pinned SDK validates
 *     `z.int().gte(0).max(4294967295)`, so `4294967296` is rejected upstream of
 *     xacpx and must be rejected here too. Accepting it would let core publish
 *     a constraint the ACP reader refuses.
 *   - `minItems` / `maxItems` are bare `z.number().nullish()` — NOT even
 *     integer-checked — so they must NOT borrow the uint32 ceiling.
 *
 * Callers pass the ceiling that matches ACP's declaration instead of inheriting
 * one from a shared helper, which is how the original bug happened: a single
 * "non-negative integer" check that was simultaneously too loose for uint32
 * fields and (if widened naively) too strict for the uint64 ones.
 */
function readOptionalPositiveInteger(
  holder: Plain,
  key: string,
  max?: number,
): { ok: true; value?: number } | { ok: false } {
  const value = holder[key];
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return { ok: false };
  if (max !== undefined && value > max) return { ok: false };
  return { ok: true, value };
}

function readOptionalBoolean(
  holder: Plain,
  key: string,
): { ok: true; value?: boolean } | { ok: false } {
  const value = holder[key];
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "boolean") return { ok: false };
  return { ok: true, value };
}

/**
 * Normalize one ACP form property into a channel field. Returns
 * `undefined` for unknown/unsupported shapes so the caller can cancel with
 * a reason instead of dropping the field.
 */
function normalizeField(
  key: string,
  property: Plain,
): { ok: true; field: ChannelElicitationField } | { ok: false; detail: string } {
  if (key.length > ELICITATION_SCHEMA_LIMITS.maxFieldKeyLength) {
    return { ok: false, detail: `field key too long: ${key.length}` };
  }
  const title = readSalvagedMetadataString(property, "title", ELICITATION_SCHEMA_LIMITS.maxFieldTitleLength);
  if (!title.ok) return { ok: false, detail: `field "${boundedKeyLabel(key)}" has an invalid title` };
  const description = readSalvagedMetadataString(
    property,
    "description",
    ELICITATION_SCHEMA_LIMITS.maxFieldDescriptionLength,
  );
  if (!description.ok) return { ok: false, detail: `field "${boundedKeyLabel(key)}" has an invalid description` };
  const fieldTitle = title.value ?? key;
  const common = {
    key,
    title: fieldTitle,
    ...(description.value !== undefined ? { description: description.value } : {}),
  };

  const rawType = property.type;
  if (typeof rawType !== "string") {
    return { ok: false, detail: `field "${boundedKeyLabel(key)}" has no type` };
  }

  switch (rawType) {
    case "string": {
      // ACP declares `minLength`/`maxLength` as uint32 and the pinned SDK
      // enforces `z.int().gte(0).max(4294967295)`. Passing the ceiling here
      // (and NOT for `minItems`/`maxItems`, which are uint64 / bare numbers in
      // ACP) is what keeps the bounds member-specific rather than inherited
      // from the shared helper.
      const minLength = readOptionalPositiveInteger(property, "minLength", ELICITATION_SCHEMA_LIMITS.maxUint32);
      if (!minLength.ok) return { ok: false, detail: `field "${boundedKeyLabel(key)}" has an invalid minLength` };
      const maxLength = readOptionalPositiveInteger(property, "maxLength", ELICITATION_SCHEMA_LIMITS.maxUint32);
      if (!maxLength.ok) return { ok: false, detail: `field "${boundedKeyLabel(key)}" has an invalid maxLength` };
      if (minLength.value !== undefined
        && maxLength.value !== undefined
        && minLength.value > maxLength.value) {
        return { ok: false, detail: `field "${boundedKeyLabel(key)}" has minLength > maxLength` };
      }
      const pattern = readOptionalBoundedString(property, "pattern", ELICITATION_SCHEMA_LIMITS.maxPatternLength);
      if (!pattern.ok) return { ok: false, detail: `field "${boundedKeyLabel(key)}" has an invalid pattern` };
      // ACP elicitation RFD: "Known formats include email, uri, date and
      // date-time. Other string format values are annotations. Implementations
      // MUST preserve unknown formats..." So an unknown format is NOT a reason
      // to reject the schema — rejecting here would cancel a form the agent
      // legitimately described. Only the four KNOWN formats are validated by
      // core; every other value is carried through unchanged for the renderer,
      // which is what "preserve" means.
      //
      // Still bounded: an unbounded agent-controlled string is a
      // resource-exhaustion vector even as an annotation, so the value must be a
      // string within the same limit the other string metadata uses.
      const formatClaim = property.format;
      if (formatClaim !== undefined && formatClaim !== null && typeof formatClaim !== "string") {
        return { ok: false, detail: `field "${boundedKeyLabel(key)}" format is not a string` };
      }
      const format: string | undefined = typeof formatClaim === "string"
        && formatClaim.length <= ELICITATION_SCHEMA_LIMITS.maxFormatLength
        ? formatClaim
        : undefined;
      if (formatClaim !== undefined && formatClaim !== null && format === undefined) {
        return { ok: false, detail: `field "${boundedKeyLabel(key)}" format exceeds ${ELICITATION_SCHEMA_LIMITS.maxFormatLength} chars` };
      }
      // `default` is an ANNOTATION (JSON Schema vocabulary + ACP pre-fill
      // hint), not a validity constraint: a value that cannot be safely
      // pre-filled is dropped, never turned into `malformed_schema`.
      //
      // PREFILL POLICY (core-safe, uniform across all field kinds): core only
      // hands a renderer a default it would itself ACCEPT as a submitted
      // answer, judged by the SAME rules the answer validator uses. A default
      // violating `minLength`/`maxLength`/`format` is therefore dropped rather
      // than passed through — otherwise the renderer would show a value core is
      // guaranteed to reject if the user submits it unmodified, which traps the
      // user.
      //
      // The length checks MUST use code-point length, not JS `.length`: the
      // answer validator uses `codePointLength`, so using `.length` here would
      // pre-fill `"😀"` for `{minLength: 2}` (2 UTF-16 units, 1 code point) and
      // drop a legal `"😀"` for `{maxLength: 1}`.
      //
      // `pattern` is deliberately NOT enforced here. Core never executes
      // agent-supplied regex anywhere (unbounded evaluation on agent-controlled
      // input is a resource-exhaustion vector, which is also why
      // `validateFieldValue` skips it), so a pattern-violating default is
      // neither rejected nor filtered — it is carried through for the agent's
      // own final validation.
      const defaultRaw = property.default;
      const defaultUsable = typeof defaultRaw === "string"
        && codePointLength(defaultRaw) <= ELICITATION_SCHEMA_LIMITS.maxDefaultValueLength
        && !(minLength.value !== undefined && codePointLength(defaultRaw) < minLength.value)
        && !(maxLength.value !== undefined && codePointLength(defaultRaw) > maxLength.value)
        && formatMatches(format, defaultRaw);
      const defaultValue = defaultUsable ? defaultRaw : undefined;

      const enumValues = readOptionalStringArray(property, "enum", ELICITATION_SCHEMA_LIMITS.maxOptionsPerField);
      if (!enumValues.ok) return { ok: false, detail: `field "${boundedKeyLabel(key)}" has an invalid enum` };
      if (enumValues.value !== undefined && Array.isArray(property.oneOf)) {
        return { ok: false, detail: `field "${boundedKeyLabel(key)}" mixes enum and oneOf` };
      }
      const titled = readTitledOptions(property.oneOf);
      if (!titled.ok) return { ok: false, detail: titled.detail ?? `field "${boundedKeyLabel(key)}" has an invalid oneOf` };
      const options = titled.options ?? enumValues.value?.map((value) => ({ value, label: value }));
      if (options && options.length > ELICITATION_SCHEMA_LIMITS.maxOptionsPerField) {
        return { ok: false, detail: `field "${boundedKeyLabel(key)}" exceeds ${ELICITATION_SCHEMA_LIMITS.maxOptionsPerField} options` };
      }
      if (options) {
        if (hasDuplicateOptions(options)) {
          return { ok: false, detail: `field "${boundedKeyLabel(key)}" has ambiguous option values` };
        }
        // `default` is an annotation, not a constraint. A default naming an
        // option the form does not offer cannot be pre-filled safely, so it is
        // dropped rather than rejecting the whole form.
        const safeDefault = typeof defaultValue === "string"
          && defaultValue.length <= ELICITATION_SCHEMA_LIMITS.maxDefaultValueLength
          && options.some((option) => option.value === defaultValue)
          ? defaultValue
          : undefined;
        return {
          ok: true,
          field: {
            ...common,
            kind: "single-select",
            required: false,
            options,
            ...(safeDefault !== undefined ? { defaultValue: safeDefault } : {}),
            // Carry the agent's own string constraints through instead of
            // silently dropping them: an enum does not imply the value is
            // unconstrained, and core must not accept an answer the agent's
            // schema would reject.
            ...(minLength.value !== undefined ? { minLength: minLength.value } : {}),
            ...(maxLength.value !== undefined ? { maxLength: maxLength.value } : {}),
            ...(format !== undefined ? { format } : {}),
            // Keep the agent's pattern as display metadata. Dropping it would
            // silently discard a constraint the agent stated, and a renderer
            // cannot recover it from the raw ACP object (it never sees one).
            ...(pattern.value !== undefined ? { pattern: pattern.value } : {}),
          },
        };
      }
      return {
        ok: true,
        field: {
          ...common,
          kind: "text",
          required: false,
          ...(minLength.value !== undefined ? { minLength: minLength.value } : {}),
          ...(maxLength.value !== undefined ? { maxLength: maxLength.value } : {}),
          ...(pattern.value !== undefined ? { pattern: pattern.value } : {}),
          ...(format !== undefined ? { format } : {}),
          ...(typeof defaultValue === "string" ? { defaultValue } : {}),
        },
      };
    }
    case "number":
    case "integer": {
      const isInteger = rawType === "integer";
      const minimum = readOptionalNumber(property, "minimum");
      if (!minimum.ok) return { ok: false, detail: `field "${boundedKeyLabel(key)}" has an invalid minimum` };
      const maximum = readOptionalNumber(property, "maximum");
      if (!maximum.ok) return { ok: false, detail: `field "${boundedKeyLabel(key)}" has an invalid maximum` };
      if (minimum.value !== undefined
        && maximum.value !== undefined
        && minimum.value > maximum.value) {
        return { ok: false, detail: `field "${boundedKeyLabel(key)}" has minimum > maximum` };
      }
      // `default` is an annotation: a value that is not a finite number of the
      // field's type, or that falls outside the field's own range, cannot be
      // pre-filled safely and is dropped instead of rejecting the form.
      const defaultRaw = property.default;
      const defaultValue = typeof defaultRaw === "number"
        && Number.isFinite(defaultRaw)
        && (!isInteger || Number.isInteger(defaultRaw))
        && !((minimum.value !== undefined && defaultRaw < minimum.value)
          || (maximum.value !== undefined && defaultRaw > maximum.value))
        ? defaultRaw
        : undefined;
      return {
        ok: true,
        field: {
          ...common,
          kind: "number",
          required: false,
          integer: isInteger,
          ...(minimum.value !== undefined ? { minimum: minimum.value } : {}),
          ...(maximum.value !== undefined ? { maximum: maximum.value } : {}),
          ...(defaultValue !== undefined ? { defaultValue } : {}),
        },
      };
    }
    case "boolean": {
      // `default` is an annotation: a non-boolean value is simply dropped.
      const defaultValue = readOptionalBoolean(property, "default");
      return {
        ok: true,
        field: {
          ...common,
          kind: "boolean",
          required: false,
          ...(defaultValue.ok && defaultValue.value !== undefined ? { defaultValue: defaultValue.value } : {}),
        },
      };
    }
    case "array": {
      const minItems = readOptionalPositiveInteger(property, "minItems");
      if (!minItems.ok) return { ok: false, detail: `field "${boundedKeyLabel(key)}" has an invalid minItems` };
      const maxItems = readOptionalPositiveInteger(property, "maxItems");
      if (!maxItems.ok) return { ok: false, detail: `field "${boundedKeyLabel(key)}" has an invalid maxItems` };
      if (minItems.value !== undefined
        && maxItems.value !== undefined
        && minItems.value > maxItems.value) {
        return { ok: false, detail: `field "${boundedKeyLabel(key)}" has minItems > maxItems` };
      }
      const items = asPlain(property.items);
      if (!items) return { ok: false, detail: `field "${boundedKeyLabel(key)}" has no items schema` };
      // ACP defines multi-select items as a tagged union with three members:
      //
      //   { type: "string", enum: [...] }        → untitled string multi-select
      //   { anyOf: [...] }          (NO type)    → titled multi-select
      //   { type: <anything else>, ... }         → unknown/future variant
      //
      // A present `type` makes it a TYPED variant: "string" requires `enum`,
      // and any other value is a future protocol variant that a client MUST
      // NOT render as a string multi-select. Only the typeless `{ anyOf }`
      // member is titled. Decoding `anyOf` whenever it happens to be present
      // would silently reinterpret a future variant as titled options.
      const rawItemType = items.type;
      const itemTypePresent = rawItemType !== undefined && rawItemType !== null;
      const hasEnum = items.enum !== undefined && items.enum !== null;
      const hasAnyOf = items.anyOf !== undefined && items.anyOf !== null;

      if (itemTypePresent) {
        // Typed variant: only "string" + enum is supported in v1.
        if (rawItemType !== "string") {
          return { ok: false, detail: `field "${boundedKeyLabel(key)}" has unsupported multi-select item type "${boundedKeyLabel(String(rawItemType))}"` };
        }
        if (!hasEnum) {
          return { ok: false, detail: `field "${boundedKeyLabel(key)}" string items have no enum` };
        }
        if (hasAnyOf) {
          return { ok: false, detail: `field "${boundedKeyLabel(key)}" items mix enum and anyOf` };
        }
      } else {
        // Typeless member: titled only.
        if (!hasAnyOf) {
          return { ok: false, detail: `field "${boundedKeyLabel(key)}" items have neither enum nor anyOf` };
        }
        if (hasEnum) {
          return { ok: false, detail: `field "${boundedKeyLabel(key)}" items mix enum and anyOf` };
        }
      }
      const enumItems = readOptionalStringArray(items, "enum", ELICITATION_SCHEMA_LIMITS.maxOptionsPerField);
      if (!enumItems.ok) return { ok: false, detail: `field "${boundedKeyLabel(key)}" has invalid item enum` };
      const titled = readTitledOptions(items.anyOf);
      if (!titled.ok) return { ok: false, detail: titled.detail ?? `field "${boundedKeyLabel(key)}" has invalid item anyOf` };
      const options = titled.options ?? enumItems.value?.map((value) => ({ value, label: value }));
      if (!options || options.length === 0) {
        return { ok: false, detail: `field "${boundedKeyLabel(key)}" multi-select has no options` };
      }
      if (options.length > ELICITATION_SCHEMA_LIMITS.maxOptionsPerField) {
        return { ok: false, detail: `field "${boundedKeyLabel(key)}" exceeds ${ELICITATION_SCHEMA_LIMITS.maxOptionsPerField} options` };
      }
      if (hasDuplicateOptions(options)) {
        return { ok: false, detail: `field "${boundedKeyLabel(key)}" has ambiguous option values` };
      }
      // `default` is an annotation. The ACP reader salvages the array PER ITEM
      // (`vecSkipError`), so a single malformed element skips rather than
      // discarding the hint. On top of that, xacpx's own policy applies:
      // duplicates and options the form does not offer cannot be pre-filled
      // safely, and `minItems`/`maxItems` must hold — otherwise
      // `{minItems: 2, default: ["a"]}` would pre-fill a value core is
      // guaranteed to reject when submitted unchanged.
      const defaultRaw = readSalvagedStringArray(
        property,
        "default",
        ELICITATION_SCHEMA_LIMITS.maxOptionsPerField,
      );
      const filtered = defaultRaw.ok && defaultRaw.value !== undefined
        ? defaultRaw.value.filter((value, index, all) =>
            all.indexOf(value) === index
            && options.some((option) => option.value === value))
        : undefined;
      const withinItems = filtered !== undefined
        && !(minItems.value !== undefined && filtered.length < minItems.value)
        && !(maxItems.value !== undefined && filtered.length > maxItems.value);
      const defaultValues = withinItems ? filtered : undefined;
      return {
        ok: true,
        field: {
          ...common,
          kind: "multi-select",
          required: false,
          options,
          ...(minItems.value !== undefined ? { minItems: minItems.value } : {}),
          ...(maxItems.value !== undefined ? { maxItems: maxItems.value } : {}),
          ...(defaultValues !== undefined && defaultValues.length > 0 ? { defaultValue: defaultValues } : {}),
        },
      };
    }
    default:
      return { ok: false, detail: `field "${boundedKeyLabel(key)}" has unsupported type "${boundedKeyLabel(rawType)}"` };
  }
}

function hasDuplicateValues(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function hasDuplicateOptions(options: readonly ChannelElicitationOption[]): boolean {
  const seen = new Set<string>();
  for (const option of options) {
    if (seen.has(option.value)) return true;
    seen.add(option.value);
  }
  return false;
}

/**
 * Parse ACP titled option lists (`oneOf` for single-select, `anyOf` for
 * multi-select items). Absent is fine; malformed is a rejection.
 *
 * ACP `EnumOption` requires BOTH `const` and `title`. An option missing its
 * title is malformed, not something core may paper over by reusing the value
 * as the label — the renderer would show the user a label the agent never
 * chose.
 */
function readTitledOptions(
  value: unknown,
): { ok: true; options?: ChannelElicitationOption[] } | { ok: false; detail: string } {
  if (value === undefined || value === null) return { ok: true };
  if (!Array.isArray(value)) return { ok: false, detail: "titled options must be an array" };
  // Length BEFORE mapping: `value.map(...)` on an unbounded array allocates a
  // full copy before the caller's `options.length > 100` check ever runs.
  if (value.length > ELICITATION_SCHEMA_LIMITS.maxOptionsPerField) {
    return { ok: false, detail: `titled options exceed ${ELICITATION_SCHEMA_LIMITS.maxOptionsPerField}` };
  }
  const options = value.map((entry) => {
    const option = asPlain(entry);
    if (!option) return undefined;
    const optionValue = readString(option, "const");
    // Same bound as untitled enum values: titled and untitled options must not
    // have different size ceilings for the same slot in the normalized form.
    if (optionValue === undefined || optionValue.length > ELICITATION_SCHEMA_LIMITS.maxOptionValueLength) return undefined;
    const label = readRequiredBoundedString(
      option,
      "title",
      ELICITATION_SCHEMA_LIMITS.maxOptionLabelLength,
    );
    const description = readSalvagedMetadataString(option, "description", ELICITATION_SCHEMA_LIMITS.maxFieldDescriptionLength);
    if (!label.ok || !description.ok) return undefined;
    return {
      value: optionValue,
      label: label.value,
      ...(description.value !== undefined ? { description: description.value } : {}),
    } satisfies ChannelElicitationOption;
  });
  if (options.some((option) => option === undefined)) {
    return { ok: false, detail: "malformed titled option" };
  }
  return { ok: true, options: options as ChannelElicitationOption[] };
}

function readOptionalNumber(
  holder: Plain,
  key: string,
): { ok: true; value?: number } | { ok: false } {
  const value = holder[key];
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false };
  return { ok: true, value };
}

/**
 * Normalize an ACP form-mode `elicitation/create` request.
 *
 * Rejects (⇒ `cancel`) any request that cannot be rendered faithfully:
 * non-form mode, non-object schema, nested objects, unknown property types,
 * duplicate required entries, required names that do not resolve to a property,
 * out-of-bounds resources, malformed defaults, and unsupported schemas for a
 * field's declared type.
 *
 * Deliberately NOT rejected: unknown ROOT keys. ACP `elicitation/create` is a
 * versioned protocol — an agent may send meta/extension keys that this version
 * does not understand, and refusing the whole form for that would break forward
 * compatibility the same way refusing an unknown `format` would. Unread keys
 * are ignored; the same reasoning applies to unknown keys inside each property.
 */
export function normalizeAcpElicitationForm(request: unknown): ElicitationNormalizationResult {
  const record = asPlain(request);
  if (!record) return fail("malformed_request", "request is not an object");
  const mode = record.mode;
  if (mode !== "form") {
    // Bound the echoed mode string: it is agent-controlled and reaches the
    // logger verbatim through the rejection reason.
    return fail("unsupported_mode", `mode "${typeof mode === "string" ? boundedKeyLabel(mode) : "unknown"}" is not form`);
  }
  const message = record.message;
  if (typeof message !== "string") return fail("malformed_request", "message is not a string");
  if (message.length > ELICITATION_SCHEMA_LIMITS.maxMessageLength) {
    return fail("resource_exceeded", `message exceeds ${ELICITATION_SCHEMA_LIMITS.maxMessageLength} chars`);
  }
  const schema = asPlain(record.requestedSchema);
  if (!schema) return fail("malformed_schema", "requestedSchema is not an object");
  // ACP "Restricted JSON Schema": senders MUST include `type: "object"` and
  // `properties`, but READERS "tolerate an omitted, null, or malformed `type`
  // by treating it as 'object', and tolerate omitted `properties` by treating it
  // as an empty map; `null` is not valid for `properties`". Reader tolerance
  // does not relax the sender requirement — core accepts what the RFD says to
  // accept and still rejects what it calls invalid.
  //
  // The `type` tolerance is TOTAL, and it must be: the pinned
  // `@agentclientprotocol/sdk` 1.4.0 declares this field as
  //
  //     type: defaultOnError(z.literal("object").optional().default("object"),
  //                          () => "object")
  //
  // and `defaultOnError` is `schema.catch(fallback)`. So EVERY value that fails
  // the `"object"` literal — `"array"`, `"string"`, `7`, an object — is salvaged
  // to `"object"` before xacpx sees it. Verified empirically against the
  // installed package: all five wrong shapes arrive as `"object"`.
  //
  // Round 17 distinguished "malformed" (tolerate) from "well-formed string
  // naming another type" (reject). That distinction does not exist: the RFD's
  // "malformed" has no such carve-out, and the SDK salvages either way.
  // Rejecting would reject forms the ACP reader layer already normalised, and
  // the test that pinned the rejection was cementing the deviation — the same
  // failure mode as round 16's unknown `format`.
  const schemaType = schema.type;
  if (schemaType !== undefined && schemaType !== null && schemaType !== "object") {
    // Tolerated, not rejected. Kept as an explicit branch rather than deleted so
    // the reader-tolerance rule stays visible at the site, and so a future ACP
    // revision that stops salvaging does not silently start rejecting: flip this
    // to `fail(...)` and the regressions below will catch it.
    void schemaType;
  }
  // ACP schema-level presentation metadata. Bounded like every other string,
  // and carried through because plugins never see the raw ACP object.
  const schemaTitle = readSalvagedMetadataString(
    schema,
    "title",
    ELICITATION_SCHEMA_LIMITS.maxFieldTitleLength,
  );
  if (!schemaTitle.ok) return fail("malformed_schema", "requestedSchema.title is invalid");
  const schemaDescription = readSalvagedMetadataString(
    schema,
    "description",
    ELICITATION_SCHEMA_LIMITS.maxFieldDescriptionLength,
  );
  if (!schemaDescription.ok) return fail("malformed_schema", "requestedSchema.description is invalid");
  const schemaMeta = {
    ...(schemaTitle.value !== undefined ? { schemaTitle: schemaTitle.value } : {}),
    ...(schemaDescription.value !== undefined ? { schemaDescription: schemaDescription.value } : {}),
  };
  const properties = schema.properties;
  // ACP reader tolerance: omitted `properties` is an empty map. `null` is NOT
  // valid for `properties` and is rejected with its own reason. Note this no
  // longer early-returns for the omitted case — the `required` consistency
  // check below still runs, so a `required` entry cannot survive against a form
  // that has no fields.
  if (properties === null) {
    return fail("malformed_schema", "requestedSchema.properties must not be null");
  }
  const propertiesRecord = properties === undefined ? {} : asPlain(properties);
  if (!propertiesRecord) return fail("malformed_schema", "requestedSchema.properties is not an object");
  // Bounded enumeration: collect keys and stop at maxFields + 1 instead of
  // materialising every entry first. A schema near the upstream 64 MiB message
  // ceiling must not force core to enumerate and allocate a collection that is
  // going to be rejected on count anyway.
  const propertyKeys: string[] = [];
  for (const key in propertiesRecord) {
    if (!Object.hasOwn(propertiesRecord, key)) continue;
    propertyKeys.push(key);
    if (propertyKeys.length > ELICITATION_SCHEMA_LIMITS.maxFields) {
      return fail("resource_exceeded", `form exceeds ${ELICITATION_SCHEMA_LIMITS.maxFields} fields`);
    }
  }
  const entries: Array<[string, unknown]> = propertyKeys.map((key) => [key, propertiesRecord[key]]);

  const required = schema.required;
  let requiredNames: string[] = [];
  if (required !== undefined && required !== null) {
    // Length BEFORE element type: `required.every(...)` on an unbounded array
    // is an unbounded scan even when every entry is a valid string.
    if (!Array.isArray(required)) {
      return fail("malformed_schema", "requestedSchema.required is not a string array");
    }
    if (required.length > ELICITATION_SCHEMA_LIMITS.maxRequiredNames) {
      return fail("resource_exceeded", `required exceeds ${ELICITATION_SCHEMA_LIMITS.maxRequiredNames} names`);
    }
    if (!required.every((name) => typeof name === "string")) {
      return fail("malformed_schema", "requestedSchema.required is not a string array");
    }
    if (hasDuplicateValues(required)) {
      return fail("malformed_schema", "requestedSchema.required repeats a name");
    }
    for (const name of required) {
      // Bound each name BEFORE the lookup: an unbounded name would be echoed
      // into the reason below and reach the logger verbatim.
      if (name.length > ELICITATION_SCHEMA_LIMITS.maxFieldKeyLength) {
        return fail("resource_exceeded", "required name exceeds the field key bound");
      }
      // Object.hasOwn, not `in`: `required: ["toString"]` must not pass merely
      // because Object.prototype has a toString. ACP property names are not
      // restricted away from JS special keys.
      if (!Object.hasOwn(propertiesRecord, name)) {
        return fail("malformed_schema", `required "${boundedKeyLabel(name)}" is not a form field`);
      }
    }
    requiredNames = required;
  }

  const requiredSet = new Set(requiredNames);
  const fields: ChannelElicitationField[] = [];
  for (const [key, rawProperty] of entries) {
    const property = asPlain(rawProperty);
    if (!property) return fail("malformed_schema", `field "${boundedKeyLabel(key)}" is not an object`);
    // Nested objects are outside the restricted flat form ACP supports;
    // "array" is handled below as multi-select.
    if (property.type === "object") {
      return fail("malformed_schema", `field "${boundedKeyLabel(key)}" is a nested object`);
    }
    if (property.properties !== undefined || property.requestedSchema !== undefined) {
      return fail("malformed_schema", `field "${boundedKeyLabel(key)}" declares nested schema members`);
    }
    const normalized = normalizeField(key, property);
    if (!normalized.ok) return fail("malformed_schema", normalized.detail);
    const requiredField = requiredSet.has(key);
    fields.push({ ...normalized.field, required: requiredField } as ChannelElicitationField);
  }
  // Last-resort total budget. Per-field limits bound one field; this bounds
  // the whole normalized form the renderer will hold and the daemon keeps in
  // pending state, so 20 maxed-out fields cannot still be unbounded.
  // Aggregate policy cap over EVERY string the normalized form carries —
  // including the schema-level metadata added in round 3. Omitting any member
  // would make the comment's "every string" claim false again.
  const metaChars = (schemaTitle.value?.length ?? 0) + (schemaDescription.value?.length ?? 0);
  const totalChars = message.length + metaChars
    + fields.reduce((sum, field) => sum + measureFieldChars(field), 0);
  if (totalChars > ELICITATION_SCHEMA_LIMITS.maxNormalizedFormChars) {
    return fail("resource_exceeded", `normalized form exceeds ${ELICITATION_SCHEMA_LIMITS.maxNormalizedFormChars} chars`);
  }
  return { ok: true, form: { message, ...schemaMeta, fields } };
}

/** Characters the normalized field will carry into the renderer. */
function measureFieldChars(field: ChannelElicitationField): number {
  // `format` MUST be counted: the aggregate budget's invariant is that it
  // covers EVERY string in the normalized form. An unknown format is now an
  // arbitrary agent-controlled annotation (ACP reader tolerance), so omitting
  // it would understate the form by up to `maxFields × maxFormatLength` = 1280
  // chars.
  //
  // HONEST SCOPE: at those limits the undercount can never trip the 256k cap, so
  // there is NO behavioral test that fails when this line is removed. The fix
  // restores the invariant the budget comment claims ("EVERY string"), and the
  // accompanying regression proves `format` REACHES the normalized field (which
  // is what makes it countable at all). Do not claim a mutation guard here.
  let chars = field.key.length + field.title.length + (field.description?.length ?? 0);
  if (field.kind === "text" || field.kind === "single-select") {
    chars += (field.format?.length ?? 0);
  }
  if (field.kind === "text") {
    chars += (field.defaultValue?.length ?? 0) + (field.pattern?.length ?? 0);
  } else if (field.kind === "single-select" || field.kind === "multi-select") {
    for (const option of field.options) {
      chars += option.value.length + option.label.length + (option.description?.length ?? 0);
    }
    if (field.kind === "single-select") {
      chars += (field.defaultValue?.length ?? 0) + (field.pattern?.length ?? 0);
    } else {
      for (const value of field.defaultValue ?? []) chars += value.length;
    }
  } else if (field.kind === "boolean") {
    chars += 1;
  }
  return chars;
}

export type ElicitationAnswerValidationResult =
  | { ok: true; content: Record<string, ChannelElicitationValue> }
  | { ok: false; reason: string };

/**
 * JSON Schema string length is measured in Unicode CODE POINTS, not JS UTF-16
 * code units. `"😀".length === 2` in JavaScript but is one character per the
 * spec, so `minLength: 2` must reject it and `maxLength: 1` must accept it.
 */
function codePointLength(value: string): number {
  let count = 0;
  for (const _char of value) count += 1;
  return count;
}

/**
 * JSON Schema `email` and `uri` format validation.
 *
 * The JSON Schema spec says format implementations SHOULD use a well-known
 * library or regexp rather than an ad-hoc approximation, and rounds 5-7 of
 * review showed exactly why: three hand-rolled attempts each fixed one
 * direction while breaking another (UTF-16 vs code points, WHATWG URL vs
 * RFC 3986, quoted local parts vs address literals).
 *
 * `ajv-formats` is the reference implementation for these formats and is
 * already in the tree via `@modelcontextprotocol/sdk`. Two documented
 * deviations from the strictest RFC reading, accepted deliberately:
 *
 *   - `email`: a quoted local part (`"a@b"@example.com`) and an RFC 5321
 *     address-literal domain (`user@[192.0.2.1]`) are rejected. Both are
 *     vanishingly rare in an interactive form, and the alternative was a
 *     fourth hand-rolled grammar.
 *   - `uri`: permissive on scheme (any RFC 3986 scheme), strict on
 *     percent-encoding and non-ASCII.
 */
import Ajv from "ajv";
import addFormats from "ajv-formats";

const formatValidator = ((): {
  email: (value: string) => boolean;
  uri: (value: string) => boolean;
} => {
  const ajv = new Ajv({ allErrors: false, strict: false });
  addFormats(ajv);
  const email = ajv.compile({ type: "string", format: "email" });
  const uri = ajv.compile({ type: "string", format: "uri" });
  return {
    email: (value: string) => email(value) === true,
    uri: (value: string) => uri(value) === true,
  };
})();

/**
 * Resolve a leap-second timestamp to the UTC date of its instant, or
 * `undefined` when it cannot be one.
 *
 * RFC 3339 fixes each leap second at 23:59:60 UTC and lets other offsets
 * express the same instant, so the local wall clock is converted to UTC
 * before the date lookup — `1990-12-31T15:59:60-08:00` is the same leap
 * second as `1990-12-31T23:59:60Z`, which is the RFC's own example.
 *
 * `offsetMinutes` is the signed UTC offset, already range-validated by the
 * caller (`HH <= 23`, `MM <= 59`) so this function never re-parses it.
 */
function toUtcLeapInstant(
  year: string,
  month: string,
  day: string,
  hours: number,
  minutes: number,
  offsetMinutes: number,
): string | undefined {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12) return undefined;
  if (d < 1 || d > daysInMonth(y, m)) return undefined;

  // UTC minute-of-day = local - offset. The instant must land exactly on the
  // UTC leap minute (23:59) for it to be a leap second.
  const utcMinuteOfDay = hours * 60 + minutes - offsetMinutes;
  const normalized = ((utcMinuteOfDay % (24 * 60)) + 24 * 60) % (24 * 60);
  if (normalized !== 23 * 60 + 59) return undefined;
  const dayShift = Math.floor(utcMinuteOfDay / (24 * 60));

  // Shift the calendar date by `dayShift` days using pure arithmetic.
  //
  // MUST NOT use `Date.UTC(y, m - 1, d + dayShift)`: for two-digit years
  // 0..99 that constructor applies the legacy 1900+ mapping, so year `72`
  // becomes 1972. A zero-padded RFC3339 date like `0072-06-30T23:59:60Z` then
  // lands on the real 1972-06-30 leap date and is wrongly accepted. Leap dates
  // only exist from 1972 onward, so a year below that is rejected outright.
  if (y < 1972) return undefined;

  // Days since a fixed epoch in the proleptic Gregorian calendar.
  const ordinal = daysFromCivil(y, m, d);
  const shifted = civilFromDays(ordinal + dayShift);
  return `${String(shifted[0]).padStart(4, "0")}-${String(shifted[1]).padStart(2, "0")}-${String(shifted[2]).padStart(2, "0")}`;
}

/** Proleptic Gregorian day number for a civil date (Howard Hinnant's algorithm). */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400; // [0, 399]
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1; // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; // [0, 146096]
  return era * 146097 + doe - 719468;
}

/** Inverse of `daysFromCivil`; returns `[year, month, day]`. */
function civilFromDays(z: number): [number, number, number] {
  const shifted = z + 719468;
  const era = Math.floor(shifted / 146097);
  const doe = shifted - era * 146097; // [0, 146096]
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365); // [0, 399]
  const yy = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)); // [0, 365]
  const mp = Math.floor((5 * doy + 2) / 153); // [0, 11]
  const dd = doy - Math.floor((153 * mp + 2) / 5) + 1; // [1, 31]
  const mm = mp + (mp < 10 ? 3 : -9); // [1, 12]
  const year = yy + (mm <= 2 ? 1 : 0);
  return [year, mm, dd];
}

/**
 * Would core accept `value` for this string `format`?
 *
 * EXPORTED because the renderers need the same answer for the same input. Both
 * gates use it to reject a form whose offered options cannot pass core's own
 * validation, so a hand-rolled approximation — earlier rounds shipped several,
 * and each was wrong somewhere: a shape-only date regex accepted "2026-99-99",
 * and a simplified email regex disagreed with ajv-formats on Unicode — would
 * re-open the dead-option hole through the side door.
 *
 * Deterministic and dependency-light: it is the SAME code core runs at submit
 * time, not a second implementation of it.
 */
export function satisfiesElicitationFormat(format: string | undefined, value: string): boolean {
  switch (format) {
    case "email": return isEmail(value);
    case "uri": return isUri(value);
    case "date": return isDate(value);
    case "date-time": return isDateTime(value);
    default:
      // An unknown format is not this package's to reject: the ACP RFD requires
      // clients preserve unknown formats for the renderer to interpret.
      return true;
  }
}

function isEmail(value: string): boolean {
  return formatValidator.email(value);
}

function isUri(value: string): boolean {
  return formatValidator.uri(value);
}

/**
 * Would core ACCEPT `value` as a submitted answer for a field carrying this
 * `format`? Used only by the pre-fill policy: a default core would reject is
 * dropped instead of shown to the user.
 */
function formatMatches(format: string | undefined, value: string): boolean {
  switch (format) {
    case "email": return isEmail(value);
    case "uri": return isUri(value);
    case "date": return isDate(value);
    case "date-time": return isDateTime(value);
    default: return true;
  }
}


/**
 * RFC3339 date-time. `T` and `Z` are case-insensitive per the ABNF
 * (`time-offset = "Z" / time-numoffset`, note in the spec), so both cases are
 * accepted. Seconds `60` is a leap second and is only valid when it is an
 * actual leap-second instant — 23:59:60 UTC on a known leap date — not for any
 * arbitrary minute.
 */
const RFC3339_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * Known leap-second dates per RFC 3339 Appendix D, through the last one
 * announced (2016-12-31). Append-only.
 *
 * The 1973-1979 leap seconds all fall on **December 31**, not June 30 —
 * getting that backwards accepts timestamps that never existed.
 */
const LEAP_SECOND_DATES: ReadonlySet<string> = new Set([
  "1972-06-30",
  "1972-12-31", "1973-12-31", "1974-12-31", "1975-12-31",
  "1976-12-31", "1977-12-31", "1978-12-31", "1979-12-31",
  "1981-06-30", "1982-06-30", "1983-06-30", "1985-06-30",
  "1987-12-31", "1989-12-31", "1990-12-31", "1992-06-30",
  "1993-06-30", "1994-06-30", "1995-12-31", "1997-06-30",
  "1998-12-31", "2005-12-31", "2008-12-31", "2012-06-30",
  "2015-06-30", "2016-12-31",
]);

const CALENDAR_DAYS: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return CALENDAR_DAYS[month - 1] ?? 0;
}

/**
 * Strict calendar check. `Date.parse` normalizes 2026-02-31 into 2026-03-03,
 * so it cannot be used to reject dates that do not exist — the day must be
 * range-checked against the actual month, including leap years.
 */
function isDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

/** Strict RFC3339 date-time: real calendar date, seconds and offset required. */
function isDateTime(value: string): boolean {
  const match = RFC3339_DATE_TIME.exec(value);
  if (!match) return false;
  const [, year, month, day, hoursRaw, minutesRaw, secondsRaw, , offset] = match;
  // The regex makes every group mandatory; narrow once so downstream calls are
  // type-safe without per-use guards.
  if (year === undefined || month === undefined || day === undefined
    || hoursRaw === undefined || minutesRaw === undefined || secondsRaw === undefined
    || offset === undefined) {
    return false;
  }
  if (!isDate(`${year}-${month}-${day}`)) return false;
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);
  const seconds = Number(secondsRaw);
  if (hours > 23 || minutes > 59) return false;

  // Offset range validation BEFORE the leap-second branch. RFC 3339's
  // `time-numoffset` uses `time-hour` 00-23 and `time-minute` 00-59, so
  // `+24:00` and `+23:60` are malformed regardless of the time they carry.
  // Validating after the branch let `1973-01-01T23:59:60+24:00` through: the
  // bogus offset shifted the instant onto 1972-12-31 23:59 UTC, which IS a
  // real leap-second date, and the early return skipped the range check.
  let offsetMinutes = 0;
  if (offset !== "Z" && offset !== "z") {
    const parsed = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
    if (!parsed) return false;
    const offsetHours = Number(parsed[2]);
    const offsetMins = Number(parsed[3]);
    if (offsetHours > 23 || offsetMins > 59) return false;
    offsetMinutes = (parsed[1] === "-" ? -1 : 1) * (offsetHours * 60 + offsetMins);
  }

  if (seconds === 60) {
    // A leap second is only valid at a real leap-second instant. RFC 3339
    // fixes the instant in UTC and lets other offsets express it, so the
    // local wall clock is normalised to UTC before the date check —
    // `1990-12-31T15:59:60-08:00` is the same leap second as
    // `1990-12-31T23:59:60Z`, so the local hour/minute must NOT be constrained
    // to 23:59 here.
    const utcInstant = toUtcLeapInstant(year, month, day, hours, minutes, offsetMinutes);
    if (utcInstant === undefined) return false;
    return LEAP_SECOND_DATES.has(utcInstant);
  } else if (seconds > 60) {
    return false;
  }
  return true;
}

/**
 * Validate an accepted answer against the normalized form.
 *
 * Deterministic core rules only. Agent-provided `pattern` metadata is
 * deliberately NOT executed here (unbounded JS regex evaluation is a
 * resource-exhaustion vector): the agent remains responsible for final
 * validation of its own pattern.
 */
export function validateElicitationAnswer(
  fields: readonly ChannelElicitationField[],
  content: Record<string, ChannelElicitationValue> | null | undefined,
): ElicitationAnswerValidationResult {
  const source = content ?? {};
  if (typeof source !== "object" || Array.isArray(source)) {
    return { ok: false, reason: "answer is not an object" };
  }
  const byKey = new Map(fields.map((field) => [field.key, field]));
  // A valid answer carries at most one key per schema field, so anything past
  // that is already invalid — enumerate with that bound instead of copying
  // every key of an arbitrarily large renderer record first.
  const maxAnswerKeys = fields.length;
  const answerKeys: string[] = [];
  for (const key in source) {
    if (!Object.hasOwn(source, key)) continue;
    answerKeys.push(key);
    if (answerKeys.length > maxAnswerKeys) {
      return { ok: false, reason: "unexpected answer key beyond the form field count" };
    }
  }
  for (const [index, key] of answerKeys.entries()) {
    // Object.keys/`for..in` with hasOwn already excludes inherited properties,
    // so an inherited `toString` never masquerades as a submitted answer.
    // Report position, not the key: a renderer that echoes answer keys into its
    // error text would otherwise make this a leak vector.
    if (!byKey.has(key)) {
      return { ok: false, reason: `unexpected answer key at index ${index}` };
    }
  }
  // Null-prototype output: `out["__proto__"] = value` on a plain object is a
  // prototype setter, not a data property, so a legal answer could silently
  // vanish. defineProperty on a null-prototype dictionary always creates an
  // own data property.
  const out: Record<string, ChannelElicitationValue> = Object.create(null);
  let totalChars = 0;
  for (const field of fields) {
    // Presence by own property, not by read: an optional `toString` field must
    // not see the inherited function and be treated as a submitted value.
    const present = Object.hasOwn(source, field.key);
    if (!present) {
      if (field.required) return { ok: false, reason: `missing required field "${field.key}"` };
      continue;
    }
    const rawValue = Object.getOwnPropertyDescriptor(source, field.key)!.value;

    // CANONICALISE ARRAYS ONCE, before any validation.
    //
    // A plain Array with index getters is enough to defeat validation→clone:
    // `every`, the Set, and the membership checks all read `arr[0]` and see a
    // legal option, then `[...validated.value]` reads it a fifth time and gets
    // whatever the getter returns then — an unvalidated value, or a multi-MB
    // string that also bypasses the answer cap. Same boundary class as the
    // round 3/5 decision-object findings, nested one level deeper.
    //
    // Each index is read exactly once into a core-owned plain array; the
    // renderer's array is never touched again.
    //
    // ORDER IS LOAD-BEARING, and round 9 got it wrong: canonicalising before
    // any length check deleted round 8's O(1) admission gate. A sparse
    // `new Array(100_000_000)` on a 3-option multi-select forced a 100M-entry
    // snapshot before the option-count check could reject it. So:
    //
    //   1. read `length` ONCE and reduce it to a canonical primitive;
    //   2. reject on a fixed core bound (`maxOptionsPerField`, and for a
    //      multi-select the field's own option count) BEFORE `new Array()`;
    //   3. only then canonicalise, bailing the moment the character budget is
    //      exceeded.
    let value: unknown = rawValue;
    if (Array.isArray(rawValue)) {
      // Step 1: canonicalise the length BEFORE any coercion uses it.
      //
      // Reading the property once is not the same as snapshotting its
      // semantics: `Array.isArray` accepts a Proxy, and a Proxy `get("length")`
      // trap can return an object whose `valueOf()` re-runs on every numeric
      // coercion. `length` therefore participates in `>` twice, in
      // `new Array(length)` and in the loop condition — four re-coercions.
      // Returning 1 for the admission checks and 1000 afterwards rebuilt the
      // exact traversal rounds 9 and 10 removed. Only a primitive number is
      // accepted, and only that primitive is used afterwards.
      const length = rawValue.length;
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
        return { ok: false, reason: "accepted answer exceeds the core size limit" };
      }
      // Step 2: admission on the canonical length alone. A longer array can
      // never be a legal multi-select answer, and no field kind accepts an
      // unbounded array, so this rejects without touching a single index.
      if (length > ELICITATION_SCHEMA_LIMITS.maxOptionsPerField) {
        return { ok: false, reason: "accepted answer exceeds the core size limit" };
      }
      if (field.kind === "multi-select" && length > field.options.length) {
        return { ok: false, reason: "accepted answer exceeds the core size limit" };
      }
      // Step 3: canonicalise within the admitted bound, one read per index.
      const snapshot: unknown[] = new Array(length);
      let snapshotChars = 0;
      for (let index = 0; index < length; index += 1) {
        const item = rawValue[index];
        snapshot[index] = item;
        snapshotChars += typeof item === "string" ? item.length : 1;
        if (snapshotChars > ELICITATION_SCHEMA_LIMITS.maxAcceptedAnswerChars) {
          return { ok: false, reason: "accepted answer exceeds the core size limit" };
        }
      }
      value = snapshot;
    }

    // CHEAP RAW PREFLIGHT, before any format/collection work.
    //
    // Order matters for the same reason the schema cap exists: the answer is
    // untrusted renderer output, so core must bound the WORK it does on it,
    // not just the data it finally accepts. Without this, a multi-megabyte
    // `email`/`uri` string reaches the Ajv format validator first — Ajv
    // documents ReDoS/unsafe-regex as a risk on untrusted input — and an
    // oversized multi-select array is fully traversed, hashed into a Set and
    // membership-checked before the size cap rejects it.
    totalChars += field.key.length + rawAnswerChars(field, value);
    if (totalChars > ELICITATION_SCHEMA_LIMITS.maxAcceptedAnswerChars) {
      return { ok: false, reason: "accepted answer exceeds the core size limit" };
    }

    const validated = validateFieldValue(field, value);
    if (!validated.ok) return { ok: false, reason: validated.reason };
    // The value here is already the core-owned snapshot, so spreading it is a
    // plain copy rather than a fresh read of the renderer's array.
    Object.defineProperty(out, field.key, {
      value: Array.isArray(validated.value) ? [...validated.value] : validated.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { ok: true, content: out };
}

/**
 * Bounded character estimate over an already length-admitted value.
 *
 * Arrays reach here only after the admission gate in
 * `validateElicitationAnswer` has rejected anything over `maxOptionsPerField`
 * (and, for a multi-select, over the field's own option count), so this loop
 * runs at most ~100 iterations. It exists as a second line of defence rather
 * than as the primary gate.
 */
function rawAnswerChars(field: ChannelElicitationField, value: unknown): number {
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return 1;
  if (!Array.isArray(value)) return 0;
  let chars = 0;
  for (const item of value) {
    if (typeof item === "string") chars += item.length;
    else chars += 1;
    if (chars > ELICITATION_SCHEMA_LIMITS.maxAcceptedAnswerChars) break;
  }
  return chars;
}

type FieldValueResult =
  | { ok: true; value: ChannelElicitationValue }
  | { ok: false; reason: string };

function validateFieldValue(
  field: ChannelElicitationField,
  value: unknown,
): FieldValueResult {
  switch (field.kind) {
    case "text": {
      if (typeof value !== "string") return { ok: false, reason: `field "${field.key}" must be a string` };
      if (field.minLength !== undefined && codePointLength(value) < field.minLength) {
        return { ok: false, reason: `field "${field.key}" is shorter than ${field.minLength}` };
      }
      if (field.maxLength !== undefined && codePointLength(value) > field.maxLength) {
        return { ok: false, reason: `field "${field.key}" exceeds ${field.maxLength} chars` };
      }
      if (field.format === "email" && !isEmail(value)) {
        return { ok: false, reason: `field "${field.key}" is not an email` };
      }
      if (field.format === "uri" && !isUri(value)) {
        return { ok: false, reason: `field "${field.key}" is not a uri` };
      }
      if (field.format === "date" && !isDate(value)) {
        return { ok: false, reason: `field "${field.key}" is not a date` };
      }
      if (field.format === "date-time" && !isDateTime(value)) {
        return { ok: false, reason: `field "${field.key}" is not a date-time` };
      }
      return { ok: true, value };
    }
    case "single-select": {
      if (typeof value !== "string") return { ok: false, reason: `field "${field.key}" must be a string` };
      if (!field.options.some((option) => option.value === value)) {
        return { ok: false, reason: `field "${field.key}" value is not an offered option` };
      }
      // The agent's own string constraints apply to the chosen option too.
      // `pattern` is deliberately NOT executed here (agent regex is a
      // resource-exhaustion vector) — every other constraint is deterministic.
      if (field.minLength !== undefined && codePointLength(value) < field.minLength) {
        return { ok: false, reason: `field "${field.key}" is shorter than ${field.minLength}` };
      }
      if (field.maxLength !== undefined && codePointLength(value) > field.maxLength) {
        return { ok: false, reason: `field "${field.key}" exceeds ${field.maxLength} chars` };
      }
      if (field.format === "email" && !isEmail(value)) {
        return { ok: false, reason: `field "${field.key}" is not an email` };
      }
      if (field.format === "uri" && !isUri(value)) {
        return { ok: false, reason: `field "${field.key}" is not a uri` };
      }
      if (field.format === "date" && !isDate(value)) {
        return { ok: false, reason: `field "${field.key}" is not a date` };
      }
      if (field.format === "date-time" && !isDateTime(value)) {
        return { ok: false, reason: `field "${field.key}" is not a date-time` };
      }
      return { ok: true, value };
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, reason: `field "${field.key}" must be a finite number` };
      }
      if (field.integer && !Number.isInteger(value)) {
        return { ok: false, reason: `field "${field.key}" must be an integer` };
      }
      if (field.minimum !== undefined && value < field.minimum) {
        return { ok: false, reason: `field "${field.key}" is below ${field.minimum}` };
      }
      if (field.maximum !== undefined && value > field.maximum) {
        return { ok: false, reason: `field "${field.key}" exceeds ${field.maximum}` };
      }
      return { ok: true, value };
    }
    case "boolean": {
      if (typeof value !== "boolean") return { ok: false, reason: `field "${field.key}" must be a boolean` };
      return { ok: true, value };
    }
    case "multi-select": {
      if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
        return { ok: false, reason: `field "${field.key}" must be a string array` };
      }
      if (hasDuplicateValues(value)) {
        return { ok: false, reason: `field "${field.key}" repeats values` };
      }
      for (const item of value) {
        if (!field.options.some((option) => option.value === item)) {
          // Never echo the rejected value: it is user input and may be
          // sensitive. The field key plus a stable code is enough to act on
          // and safe to log.
          return { ok: false, reason: `field "${field.key}" value is not an offered option` };
        }
      }
      if (field.minItems !== undefined && value.length < field.minItems) {
        return { ok: false, reason: `field "${field.key}" selects fewer than ${field.minItems}` };
      }
      if (field.maxItems !== undefined && value.length > field.maxItems) {
        return { ok: false, reason: `field "${field.key}" selects more than ${field.maxItems}` };
      }
      return { ok: true, value };
    }
  }
}

/** Low-sensitivity metadata the broker may log; never answers or fields. */
export function summarizeElicitationSchema(fields: readonly ChannelElicitationField[]): {
  fieldCount: number;
  kinds: string[];
} {
  const kinds = new Set<string>();
  for (const field of fields) kinds.add(field.kind);
  return { fieldCount: fields.length, kinds: [...kinds].sort() };
}
