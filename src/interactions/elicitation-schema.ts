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
  maxMessageLength: 8000,
  maxPatternLength: 512,
} as const;

export type NormalizedElicitationForm = {
  message: string;
  fields: ChannelElicitationField[];
};

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

function readString(holder: Plain, key: string): string | undefined {
  const value = holder[key];
  return typeof value === "string" ? value : undefined;
}

function readOptionalNonEmptyString(
  holder: Plain,
  key: string,
  max: number,
): { ok: true; value?: string } | { ok: false } {
  const value = holder[key];
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "string" || value.length > max) return { ok: false };
  // Only genuinely empty text is rejected; a whitespace-only title is a
  // display concern, not a protocol violation.
  if (value.length === 0) return { ok: false };
  return { ok: true, value };
}

function readOptionalStringArray(
  holder: Plain,
  key: string,
  max: number,
): { ok: true; value?: string[] } | { ok: false } {
  const value = holder[key];
  if (value === undefined || value === null) return { ok: true };
  if (!Array.isArray(value) || value.length > max) return { ok: false };
  if (!value.every((item) => typeof item === "string")) return { ok: false };
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
  const title = readOptionalNonEmptyString(property, "title", ELICITATION_SCHEMA_LIMITS.maxFieldTitleLength);
  if (!title.ok) return { ok: false, detail: `field "${key}" has an invalid title` };
  const description = readOptionalNonEmptyString(
    property,
    "description",
    ELICITATION_SCHEMA_LIMITS.maxFieldDescriptionLength,
  );
  if (!description.ok) return { ok: false, detail: `field "${key}" has an invalid description` };
  const fieldTitle = title.value ?? key;
  const common = {
    key,
    title: fieldTitle,
    ...(description.value !== undefined ? { description: description.value } : {}),
  };

  const rawType = property.type;
  if (typeof rawType !== "string") {
    return { ok: false, detail: `field "${key}" has no type` };
  }

  switch (rawType) {
    case "string": {
      const minLength = readOptionalPositiveInteger(property, "minLength");
      if (!minLength.ok) return { ok: false, detail: `field "${key}" has an invalid minLength` };
      const maxLength = readOptionalPositiveInteger(property, "maxLength");
      if (!maxLength.ok) return { ok: false, detail: `field "${key}" has an invalid maxLength` };
      if (minLength.value !== undefined
        && maxLength.value !== undefined
        && minLength.value > maxLength.value) {
        return { ok: false, detail: `field "${key}" has minLength > maxLength` };
      }
      const pattern = readOptionalNonEmptyString(property, "pattern", ELICITATION_SCHEMA_LIMITS.maxPatternLength);
      if (!pattern.ok) return { ok: false, detail: `field "${key}" has an invalid pattern` };
      const format = property.format;
      if (format !== undefined && format !== null && format !== "email" && format !== "uri" && format !== "date" && format !== "date-time") {
        return { ok: false, detail: `field "${key}" has an unsupported format` };
      }
      const defaultValue = property.default;
      if (defaultValue !== undefined && defaultValue !== null && typeof defaultValue !== "string") {
        return { ok: false, detail: `field "${key}" default is not a string` };
      }

      const enumValues = readOptionalStringArray(property, "enum", ELICITATION_SCHEMA_LIMITS.maxOptionsPerField);
      if (!enumValues.ok) return { ok: false, detail: `field "${key}" has an invalid enum` };
      if (enumValues.value !== undefined && Array.isArray(property.oneOf)) {
        return { ok: false, detail: `field "${key}" mixes enum and oneOf` };
      }
      const titled = readTitledOptions(property.oneOf);
      if (!titled.ok) return { ok: false, detail: titled.detail ?? `field "${key}" has an invalid oneOf` };
      const options = titled.options ?? enumValues.value?.map((value) => ({ value, label: value }));
      if (options && options.length > ELICITATION_SCHEMA_LIMITS.maxOptionsPerField) {
        return { ok: false, detail: `field "${key}" exceeds ${ELICITATION_SCHEMA_LIMITS.maxOptionsPerField} options` };
      }
      if (options) {
        if (hasDuplicateOptions(options)) {
          return { ok: false, detail: `field "${key}" has ambiguous option values` };
        }
        if (defaultValue !== undefined && defaultValue !== null
          && !options.some((option) => option.value === defaultValue)) {
          return { ok: false, detail: `field "${key}" default is not an offered option` };
        }
        return {
          ok: true,
          field: {
            ...common,
            kind: "single-select",
            required: false,
            options,
            ...(typeof defaultValue === "string" ? { defaultValue } : {}),
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
        return { ok: false, detail: `field "${key}" default is not a valid ${rawType}` };
      }
      const minimum = readOptionalNumber(property, "minimum");
      if (!minimum.ok) return { ok: false, detail: `field "${key}" has an invalid minimum` };
      const maximum = readOptionalNumber(property, "maximum");
      if (!maximum.ok) return { ok: false, detail: `field "${key}" has an invalid maximum` };
      if (minimum.value !== undefined
        && maximum.value !== undefined
        && minimum.value > maximum.value) {
        return { ok: false, detail: `field "${key}" has minimum > maximum` };
      }
      if (typeof defaultValue === "number"
        && ((minimum.value !== undefined && defaultValue < minimum.value)
          || (maximum.value !== undefined && defaultValue > maximum.value))) {
        return { ok: false, detail: `field "${key}" default is out of range` };
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
      if (!defaultValue.ok) return { ok: false, detail: `field "${key}" default is not a boolean` };
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
      if (!minItems.ok) return { ok: false, detail: `field "${key}" has an invalid minItems` };
      const maxItems = readOptionalPositiveInteger(property, "maxItems");
      if (!maxItems.ok) return { ok: false, detail: `field "${key}" has an invalid maxItems` };
      if (minItems.value !== undefined
        && maxItems.value !== undefined
        && minItems.value > maxItems.value) {
        return { ok: false, detail: `field "${key}" has minItems > maxItems` };
      }
      const items = asPlain(property.items);
      if (!items) return { ok: false, detail: `field "${key}" has no items schema` };
      if (typeof items.type !== "string") {
        return { ok: false, detail: `field "${key}" items have no type` };
      }
      if (items.type !== "string") {
        return { ok: false, detail: `field "${key}" is not a string multi-select` };
      }
      const enumItems = readOptionalStringArray(items, "enum", ELICITATION_SCHEMA_LIMITS.maxOptionsPerField);
      if (!enumItems.ok) return { ok: false, detail: `field "${key}" has invalid item enum` };
      const titled = readTitledOptions(items.anyOf);
      if (!titled.ok) return { ok: false, detail: titled.detail ?? `field "${key}" has invalid item anyOf` };
      const options = titled.options ?? enumItems.value?.map((value) => ({ value, label: value }));
      if (!options || options.length === 0) {
        return { ok: false, detail: `field "${key}" multi-select has no options` };
      }
      if (options.length > ELICITATION_SCHEMA_LIMITS.maxOptionsPerField) {
        return { ok: false, detail: `field "${key}" exceeds ${ELICITATION_SCHEMA_LIMITS.maxOptionsPerField} options` };
      }
      if (hasDuplicateOptions(options)) {
        return { ok: false, detail: `field "${key}" has ambiguous option values` };
      }
      const defaultValue = readOptionalStringArray(
        property,
        "default",
        ELICITATION_SCHEMA_LIMITS.maxOptionsPerField,
      );
      if (!defaultValue.ok) return { ok: false, detail: `field "${key}" has an invalid default` };
      if (defaultValue.value !== undefined) {
        if (hasDuplicateValues(defaultValue.value)) {
          return { ok: false, detail: `field "${key}" default repeats values` };
        }
        if (!defaultValue.value.every((value) => options.some((option) => option.value === value))) {
          return { ok: false, detail: `field "${key}" default is not an offered option` };
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
      return { ok: false, detail: `field "${key}" has unsupported type "${rawType}"` };
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
    if (optionValue === undefined || optionValue.length > ELICITATION_SCHEMA_LIMITS.maxFieldKeyLength) return undefined;
    const label = readOptionalNonEmptyString(option, "title", ELICITATION_SCHEMA_LIMITS.maxOptionLabelLength);
    const description = readOptionalNonEmptyString(option, "description", ELICITATION_SCHEMA_LIMITS.maxFieldDescriptionLength);
    if (!label.ok || !description.ok) return undefined;
    return {
      value: optionValue,
      label: label.value ?? optionValue,
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
    return fail("unsupported_mode", `mode "${typeof mode === "string" ? mode : "unknown"}" is not form`);
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
  const properties = schema.properties;
  if (properties === undefined || properties === null) {
    return { ok: true, form: { message, fields: [] } };
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
    if (hasDuplicateValues(required)) {
      return fail("malformed_schema", "requestedSchema.required repeats a name");
    }
    for (const name of required) {
      // A required name that is not a real property cannot be answered.
      if (!(name in propertiesRecord)) {
        return fail("malformed_schema", `required "${name}" is not a form field`);
      }
    }
    requiredNames = required;
  }

  const requiredSet = new Set(requiredNames);
  const fields: ChannelElicitationField[] = [];
  for (const [key, rawProperty] of entries) {
    const property = asPlain(rawProperty);
    if (!property) return fail("malformed_schema", `field "${key}" is not an object`);
    // Nested objects are outside the restricted flat form ACP supports;
    // "array" is handled below as multi-select.
    if (property.type === "object") {
      return fail("malformed_schema", `field "${key}" is a nested object`);
    }
    if (property.properties !== undefined || property.requestedSchema !== undefined) {
      return fail("malformed_schema", `field "${key}" declares nested schema members`);
    }
    const normalized = normalizeField(key, property);
    if (!normalized.ok) return fail("malformed_schema", normalized.detail);
    const requiredField = requiredSet.has(key);
    fields.push({ ...normalized.field, required: requiredField } as ChannelElicitationField);
  }
  return { ok: true, form: { message, fields } };
}

export type ElicitationAnswerValidationResult =
  | { ok: true; content: Record<string, ChannelElicitationValue> }
  | { ok: false; reason: string };

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol.length > 1;
  } catch {
    return false;
  }
}

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function isDateTime(value: string): boolean {
  return !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value);
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
  for (const key of Object.keys(source)) {
    if (!byKey.has(key)) return { ok: false, reason: `unexpected answer key "${key}"` };
  }
  const out: Record<string, ChannelElicitationValue> = {};
  for (const field of fields) {
    const value = source[field.key];
    if (value === undefined) {
      if (field.required) return { ok: false, reason: `missing required field "${field.key}"` };
      continue;
    }
    const validated = validateFieldValue(field, value);
    if (!validated.ok) return { ok: false, reason: validated.reason };
    out[field.key] = validated.value;
  }
  return { ok: true, content: out };
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
      if (field.minLength !== undefined && value.length < field.minLength) {
        return { ok: false, reason: `field "${field.key}" is shorter than ${field.minLength}` };
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) {
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
          return { ok: false, reason: `field "${field.key}" value "${item}" is not an offered option` };
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
