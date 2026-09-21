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

function readOptionalPositiveInteger(
  holder: Plain,
  key: string,
): { ok: true; value?: number } | { ok: false } {
  const value = holder[key];
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return { ok: false };
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
  const title = readOptionalBoundedString(property, "title", ELICITATION_SCHEMA_LIMITS.maxFieldTitleLength);
  if (!title.ok) return { ok: false, detail: `field "${boundedKeyLabel(key)}" has an invalid title` };
  const description = readOptionalBoundedString(
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
      const minLength = readOptionalPositiveInteger(property, "minLength");
      if (!minLength.ok) return { ok: false, detail: `field "${boundedKeyLabel(key)}" has an invalid minLength` };
      const maxLength = readOptionalPositiveInteger(property, "maxLength");
      if (!maxLength.ok) return { ok: false, detail: `field "${boundedKeyLabel(key)}" has an invalid maxLength` };
      if (minLength.value !== undefined
        && maxLength.value !== undefined
        && minLength.value > maxLength.value) {
        return { ok: false, detail: `field "${boundedKeyLabel(key)}" has minLength > maxLength` };
      }
      const pattern = readOptionalBoundedString(property, "pattern", ELICITATION_SCHEMA_LIMITS.maxPatternLength);
      if (!pattern.ok) return { ok: false, detail: `field "${boundedKeyLabel(key)}" has an invalid pattern` };
      const format = property.format;
      if (format !== undefined && format !== null && format !== "email" && format !== "uri" && format !== "date" && format !== "date-time") {
        return { ok: false, detail: `field "${boundedKeyLabel(key)}" has an unsupported format` };
      }
      const defaultValue = property.default;
      if (defaultValue !== undefined && defaultValue !== null && typeof defaultValue !== "string") {
        return { ok: false, detail: `field "${boundedKeyLabel(key)}" default is not a string` };
      }
      if (typeof defaultValue === "string" && defaultValue.length > ELICITATION_SCHEMA_LIMITS.maxDefaultValueLength) {
        return { ok: false, detail: `field "${boundedKeyLabel(key)}" default exceeds ${ELICITATION_SCHEMA_LIMITS.maxDefaultValueLength} chars` };
      }

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
        if (defaultValue !== undefined && defaultValue !== null
          && !options.some((option) => option.value === defaultValue)) {
          return { ok: false, detail: `field "${boundedKeyLabel(key)}" default is not an offered option` };
        }
        return {
          ok: true,
          field: {
            ...common,
            kind: "single-select",
            required: false,
            options,
            ...(typeof defaultValue === "string" ? { defaultValue } : {}),
            // Carry the agent's own string constraints through instead of
            // silently dropping them: an enum does not imply the value is
            // unconstrained, and core must not accept an answer the agent's
            // schema would reject.
            ...(minLength.value !== undefined ? { minLength: minLength.value } : {}),
            ...(maxLength.value !== undefined ? { maxLength: maxLength.value } : {}),
            ...(format === "email" || format === "uri" || format === "date" || format === "date-time"
              ? { format }
              : {}),
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
          ...(format === "email" || format === "uri" || format === "date" || format === "date-time"
            ? { format }
            : {}),
          ...(typeof defaultValue === "string" ? { defaultValue } : {}),
        },
      };
    }
    case "number":
    case "integer": {
      const isInteger = rawType === "integer";
      const defaultValue = property.default;
      if (defaultValue !== undefined
        && defaultValue !== null
        && (typeof defaultValue !== "number"
          || !Number.isFinite(defaultValue)
          || (isInteger && !Number.isInteger(defaultValue)))) {
        return { ok: false, detail: `field "${boundedKeyLabel(key)}" default is not a valid ${rawType}` };
      }
      const minimum = readOptionalNumber(property, "minimum");
      if (!minimum.ok) return { ok: false, detail: `field "${boundedKeyLabel(key)}" has an invalid minimum` };
      const maximum = readOptionalNumber(property, "maximum");
      if (!maximum.ok) return { ok: false, detail: `field "${boundedKeyLabel(key)}" has an invalid maximum` };
      if (minimum.value !== undefined
        && maximum.value !== undefined
        && minimum.value > maximum.value) {
        return { ok: false, detail: `field "${boundedKeyLabel(key)}" has minimum > maximum` };
      }
      if (typeof defaultValue === "number"
        && ((minimum.value !== undefined && defaultValue < minimum.value)
          || (maximum.value !== undefined && defaultValue > maximum.value))) {
        return { ok: false, detail: `field "${boundedKeyLabel(key)}" default is out of range` };
      }
      return {
        ok: true,
        field: {
          ...common,
          kind: "number",
          required: false,
          integer: isInteger,
          ...(minimum.value !== undefined ? { minimum: minimum.value } : {}),
          ...(maximum.value !== undefined ? { maximum: maximum.value } : {}),
          ...(typeof defaultValue === "number" ? { defaultValue } : {}),
        },
      };
    }
    case "boolean": {
      const defaultValue = readOptionalBoolean(property, "default");
      if (!defaultValue.ok) return { ok: false, detail: `field "${boundedKeyLabel(key)}" default is not a boolean` };
      return {
        ok: true,
        field: {
          ...common,
          kind: "boolean",
          required: false,
          ...(defaultValue.value !== undefined ? { defaultValue: defaultValue.value } : {}),
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
      const defaultValue = readOptionalStringArray(
        property,
        "default",
        ELICITATION_SCHEMA_LIMITS.maxOptionsPerField,
      );
      if (!defaultValue.ok) return { ok: false, detail: `field "${boundedKeyLabel(key)}" has an invalid default` };
      if (defaultValue.value !== undefined) {
        if (hasDuplicateValues(defaultValue.value)) {
          return { ok: false, detail: `field "${boundedKeyLabel(key)}" default repeats values` };
        }
        if (!defaultValue.value.every((value) => options.some((option) => option.value === value))) {
          return { ok: false, detail: `field "${boundedKeyLabel(key)}" default is not an offered option` };
        }
      }
      return {
        ok: true,
        field: {
          ...common,
          kind: "multi-select",
          required: false,
          options,
          ...(minItems.value !== undefined ? { minItems: minItems.value } : {}),
          ...(maxItems.value !== undefined ? { maxItems: maxItems.value } : {}),
          ...(defaultValue.value !== undefined ? { defaultValue: defaultValue.value } : {}),
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
    const description = readOptionalBoundedString(option, "description", ELICITATION_SCHEMA_LIMITS.maxFieldDescriptionLength);
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
 * unknown root keys, duplicate required entries, required names that do not
 * resolve to a property, out-of-bounds resources, malformed defaults.
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
  if (schema.type !== undefined && schema.type !== "object") {
    return fail("malformed_schema", 'requestedSchema.type must be "object"');
  }
  // ACP schema-level presentation metadata. Bounded like every other string,
  // and carried through because plugins never see the raw ACP object.
  const schemaTitle = readOptionalBoundedString(
    schema,
    "title",
    ELICITATION_SCHEMA_LIMITS.maxFieldTitleLength,
  );
  if (!schemaTitle.ok) return fail("malformed_schema", "requestedSchema.title is invalid");
  const schemaDescription = readOptionalBoundedString(
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
  if (properties === undefined || properties === null) {
    return { ok: true, form: { message, ...schemaMeta, fields: [] } };
  }
  const propertiesRecord = asPlain(properties);
  if (!propertiesRecord) return fail("malformed_schema", "requestedSchema.properties is not an object");
  const entries = Object.entries(propertiesRecord);
  if (entries.length > ELICITATION_SCHEMA_LIMITS.maxFields) {
    return fail("resource_exceeded", `form exceeds ${ELICITATION_SCHEMA_LIMITS.maxFields} fields`);
  }

  const required = schema.required;
  let requiredNames: string[] = [];
  if (required !== undefined && required !== null) {
    if (!Array.isArray(required) || !required.every((name) => typeof name === "string")) {
      return fail("malformed_schema", "requestedSchema.required is not a string array");
    }
    // Bound the list BEFORE dedup/traversal: an unbounded array is an
    // unbounded scan even when every entry is valid.
    if (required.length > ELICITATION_SCHEMA_LIMITS.maxRequiredNames) {
      return fail("resource_exceeded", `required exceeds ${ELICITATION_SCHEMA_LIMITS.maxRequiredNames} names`);
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
  let chars = field.key.length + field.title.length + (field.description?.length ?? 0);
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
 */
function toUtcLeapInstant(
  year: string,
  month: string,
  day: string,
  hours: number,
  minutes: number,
  offset: string | undefined,
): string | undefined {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12) return undefined;
  if (d < 1 || d > daysInMonth(y, m)) return undefined;
  if (offset === undefined) return undefined;
  if (offset === "Z" || offset === "z") {
    // UTC: the local clock IS the UTC clock, so it must read 23:59:60.
    return hours === 23 && minutes === 59 ? `${year}-${month}-${day}` : undefined;
  }

  const parsed = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!parsed) return undefined;
  const sign = parsed[1] === "-" ? -1 : 1;
  const offsetMinutes = sign * (Number(parsed[2]) * 60 + Number(parsed[3]));

  // Convert local minute-of-day to UTC. The instant must land exactly on the
  // UTC leap minute (23:59) for it to be a leap second.
  const utcMinuteOfDay = ((hours * 60 + minutes - offsetMinutes) % (24 * 60) + 24 * 60) % (24 * 60);
  const dayShift = Math.floor((hours * 60 + minutes - offsetMinutes) / (24 * 60));
  if (utcMinuteOfDay !== 23 * 60 + 59) return undefined;

  const shifted = new Date(Date.UTC(y, m - 1, d + dayShift));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

function isEmail(value: string): boolean {
  return formatValidator.email(value);
}

function isUri(value: string): boolean {
  return formatValidator.uri(value);
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
  if (seconds === 60) {
    // A leap second is only valid at a real leap-second instant. RFC 3339
    // fixes the instant in UTC and lets other offsets express it, so the
    // local wall clock is normalised to UTC before the date check —
    // `1990-12-31T15:59:60-08:00` is the same leap second as
    // `1990-12-31T23:59:60Z`, so the local hour/minute must NOT be constrained
    // to 23:59 here.
    const utcInstant = toUtcLeapInstant(year, month, day, hours, minutes, offset);
    if (utcInstant === undefined) return false;
    return LEAP_SECOND_DATES.has(utcInstant);
  } else if (seconds > 60) {
    return false;
  }
  // Offset must be a real UTC offset: HH <= 23 and MM <= 59.
  if (offset !== "Z" && offset !== "z") {
    const parsed = /([+-])(\d{2}):(\d{2})$/.exec(offset);
    if (parsed && (Number(parsed[2]) > 23 || Number(parsed[3]) > 59)) return false;
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
  const answerKeys = Object.keys(source);
  for (const [index, key] of answerKeys.entries()) {
    // Object.keys already returns own enumerable keys only, so an inherited
    // `toString` never masquerades as a submitted answer. Report position, not
    // the key: a renderer that echoes answer keys into its error text would
    // otherwise make this a leak vector.
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
    const value = Object.getOwnPropertyDescriptor(source, field.key)!.value;

    // CHEAP RAW PREFLIGHT, before any format/collection work.
    //
    // Order matters for the same reason the schema cap exists: the answer is
    // untrusted renderer output, so core must bound the WORK it does on it,
    // not just the data it finally accepts. Without this, a multi-megabyte
    // `email`/`uri` string reaches the Ajv format validator first — Ajv
    // documents ReDoS/unsafe-regex as a risk when validating untrusted input
    // — and an oversized multi-select array is fully traversed, hashed into a
    // Set and membership-checked before the size cap rejects it.
    totalChars += field.key.length + rawAnswerChars(field, value);
    if (totalChars > ELICITATION_SCHEMA_LIMITS.maxAcceptedAnswerChars) {
      return { ok: false, reason: "accepted answer exceeds the core size limit" };
    }

    const validated = validateFieldValue(field, value);
    if (!validated.ok) return { ok: false, reason: validated.reason };
    // Clone arrays: the plugin still holds its own reference, and returning it
    // would let a post-validation mutation reach the agent as accepted content.
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
 * Bounded character estimate over the RAW submitted value, computed without
 * running any format or collection validation.
 *
 * Arrays are the interesting case: `options` is capped at 100 entries, so any
 * array longer than that cannot possibly be a legal multi-select answer. Using
 * the option count as the array-length bound therefore rejects an impossible
 * input with a single comparison instead of traversing it.
 */
function rawAnswerChars(field: ChannelElicitationField, value: unknown): number {
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return 1;
  if (!Array.isArray(value)) return 0;
  if (field.kind === "multi-select" && value.length > field.options.length) {
    // More selections than offered options can never validate; report the
    // whole remaining budget so the caller cancels immediately.
    return ELICITATION_SCHEMA_LIMITS.maxAcceptedAnswerChars + 1;
  }
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
