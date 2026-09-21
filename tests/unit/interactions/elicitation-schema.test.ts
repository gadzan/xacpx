import { describe, expect, test } from "bun:test";

import {
  ELICITATION_SCHEMA_LIMITS,
  normalizeAcpElicitationForm,
  summarizeElicitationSchema,
  validateElicitationAnswer,
} from "../../../src/interactions/elicitation-schema.js";
import type { ChannelElicitationField } from "../../../src/interactions/elicitation-types.js";

/** Build a valid form request with one field and override pieces of it. */
function formRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "acp-session",
    mode: "form",
    message: "Tell me about the task",
    requestedSchema: {
      type: "object",
      properties: {
        summary: { type: "string", title: "Summary" },
      },
      required: ["summary"],
    },
    ...overrides,
  };
}

function normalizeOk(request: unknown): ChannelElicitationField[] {
  const result = normalizeAcpElicitationForm(request);
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
  return result.form.fields;
}

describe("normalizeAcpElicitationForm supported shapes", () => {
  test("string field with bounds and format", () => {
    const fields = normalizeOk(formRequest({
      requestedSchema: {
        type: "object",
        properties: {
          name: { type: "string", title: "Name", minLength: 2, maxLength: 8, format: "email" },
        },
      },
    }));
    expect(fields).toEqual([{
      kind: "text",
      key: "name",
      title: "Name",
      required: false,
      minLength: 2,
      maxLength: 8,
      format: "email",
    }]);
  });

  test("pattern is preserved as display metadata only", () => {
    const fields = normalizeOk(formRequest({
      requestedSchema: {
        type: "object",
        properties: { code: { type: "string", pattern: `^(?:a+)+$` } },
      },
    }));
    expect(fields[0]).toMatchObject({ kind: "text", pattern: `^(?:a+)+$` });
  });

  test("string enum becomes single-select", () => {
    const fields = normalizeOk(formRequest({
      requestedSchema: {
        type: "object",
        properties: { color: { type: "string", enum: ["red", "blue"], default: "blue" } },
        required: ["color"],
      },
    }));
    expect(fields[0]).toMatchObject({
      kind: "single-select",
      required: true,
      options: [{ value: "red", label: "red" }, { value: "blue", label: "blue" }],
      defaultValue: "blue",
    });
  });

  test("oneOf titled options become single-select with labels and descriptions", () => {
    const fields = normalizeOk(formRequest({
      requestedSchema: {
        type: "object",
        properties: {
          size: {
            type: "string",
            oneOf: [
              { const: "s", title: "Small", description: "tiny" },
              { const: "l", title: "Large" },
            ],
          },
        },
      },
    }));
    expect(fields[0]).toMatchObject({
      kind: "single-select",
      options: [
        { value: "s", label: "Small", description: "tiny" },
        { value: "l", label: "Large" },
      ],
    });
  });

  test("number and integer fields carry bounds and integer flag", () => {
    const fields = normalizeOk(formRequest({
      requestedSchema: {
        type: "object",
        properties: {
          ratio: { type: "number", minimum: 0, maximum: 1 },
          count: { type: "integer", minimum: 1, default: 2 },
        },
      },
    }));
    expect(fields[0]).toMatchObject({ kind: "number", integer: false, minimum: 0, maximum: 1 });
    expect(fields[1]).toMatchObject({ kind: "number", integer: true, minimum: 1, defaultValue: 2 });
  });

  test("boolean field with default", () => {
    const fields = normalizeOk(formRequest({
      requestedSchema: { type: "object", properties: { confirm: { type: "boolean", default: false } } },
    }));
    expect(fields[0]).toMatchObject({ kind: "boolean", defaultValue: false });
  });

  test("multi-select from items.enum and items.anyOf with bounds", () => {
    const fromEnum = normalizeOk(formRequest({
      requestedSchema: {
        type: "object",
        properties: { tags: { type: "array", minItems: 1, maxItems: 2, items: { type: "string", enum: ["a", "b", "c"] } } },
      },
    }));
    expect(fromEnum[0]).toMatchObject({
      kind: "multi-select",
      minItems: 1,
      maxItems: 2,
      options: [
        { value: "a", label: "a" },
        { value: "b", label: "b" },
        { value: "c", label: "c" },
      ],
    });

    // ACP native titled multi-select: `items` is `{ anyOf: [...] }` with NO
    // `type` field (TitledMultiSelectItems). The non-standard
    // `{ type: "string", anyOf: [...] }` form is accepted too, but the real
    // agent shape must work.
    const titled = normalizeOk(formRequest({
      requestedSchema: {
        type: "object",
        properties: {
          picks: { type: "array", items: { anyOf: [{ const: "x", title: "Ex" }, { const: "y", title: "Why", description: "second" }] } },
        },
      },
    }));
    expect(titled[0]).toMatchObject({
      kind: "multi-select",
      options: [
        { value: "x", label: "Ex" },
        { value: "y", label: "Why", description: "second" },
      ],
    });
  });

  test("ACP native titled multi-select without a type field is accepted", () => {
    const fields = normalizeOk(formRequest({
      requestedSchema: {
        type: "object",
        properties: {
          picks: { type: "array", minItems: 1, items: { anyOf: [{ const: "a", title: "Ay" }] } },
        },
        required: ["picks"],
      },
    }));
    expect(fields[0]).toMatchObject({ kind: "multi-select", required: true, options: [{ value: "a", label: "Ay" }] });
  });

  test("string enum becomes single-select carrying its string constraints", () => {
    // Regression: the conversion used to drop minLength/maxLength/format, so
    // an enum value violating the agent's own schema was accepted.
    const fields = normalizeOk(formRequest({
      requestedSchema: {
        type: "object",
        properties: { color: { type: "string", enum: ["red", "blue"], minLength: 4 } },
        required: ["color"],
      },
    }));
    expect(fields[0]).toMatchObject({ kind: "single-select", minLength: 4 });
  });

  test("a single-select value violating minLength is rejected", () => {
    const field = normalizeOk(formRequest({
      requestedSchema: { type: "object", properties: { c: { type: "string", enum: ["red", "blue", "x"], minLength: 3 } } },
    }))[0];
    expect(validateElicitationAnswer([field], { c: "red" }).ok).toBe(true);
    expect(validateElicitationAnswer([field], { c: "blue" }).ok).toBe(true);
    // Offered but shorter than the agent's own minLength.
    expect(validateElicitationAnswer([field], { c: "x" }).ok).toBe(false);
  });

  test("a single-select value violating maxLength is rejected", () => {
    const field = normalizeOk(formRequest({
      requestedSchema: { type: "object", properties: { c: { type: "string", enum: ["abcde"], maxLength: 4 } } },
    }))[0];
    expect(validateElicitationAnswer([field], { c: "abcde" }).ok).toBe(false);
  });

  test("a single-select value violating format is rejected", () => {
    const field = normalizeOk(formRequest({
      requestedSchema: {
        type: "object",
        properties: { c: { type: "string", enum: ["a@b.co", "nope"], format: "email" } },
      },
    }))[0];
    expect(validateElicitationAnswer([field], { c: "a@b.co" }).ok).toBe(true);
    expect(validateElicitationAnswer([field], { c: "nope" }).ok).toBe(false);
  });

  test("a titled single-select keeps its constraints too", () => {
    const field = normalizeOk(formRequest({
      requestedSchema: {
        type: "object",
        properties: {
          c: { type: "string", oneOf: [{ const: "ab", title: "AB" }, { const: "abcd", title: "ABCD" }], minLength: 3 },
        },
      },
    }))[0];
    expect(validateElicitationAnswer([field], { c: "abcd" }).ok).toBe(true);
    expect(validateElicitationAnswer([field], { c: "ab" }).ok).toBe(false);
  });

  test("empty properties yields an empty form instead of failing", () => {
    const fields = normalizeOk(formRequest({ requestedSchema: { type: "object" } }));
    expect(fields).toEqual([]);
  });
});

describe("normalizeAcpElicitationForm rejections", () => {
  test("url mode is rejected", () => {
    const result = normalizeAcpElicitationForm(formRequest({ mode: "url", elicitationId: "e-1" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("unsupported_mode");
  });

  test("unknown custom mode is rejected", () => {
    const result = normalizeAcpElicitationForm(formRequest({ mode: "_my.mode" }));
    expect(result.ok).toBe(false);
  });

  test("nested object field is rejected, not dropped", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: {
        type: "object",
        properties: {
          nested: { type: "object", properties: { inner: { type: "string" } } },
          ok: { type: "string" },
        },
      },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("malformed_schema");
  });

  test("field declaring nested schema members is rejected", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { weird: { type: "string", properties: {} } } },
    }));
    expect(result.ok).toBe(false);
  });

  test("non-object root schema is rejected", () => {
    const result = normalizeAcpElicitationForm(formRequest({ requestedSchema: { type: "array" } }));
    expect(result.ok).toBe(false);
  });

  test("unsupported property type is rejected", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { nope: { type: "null" } } },
    }));
    expect(result.ok).toBe(false);
  });

  test("multi-select with non-string items is rejected", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { nums: { type: "array", items: { type: "number" } } } },
    }));
    expect(result.ok).toBe(false);
  });

  test("multi-select items mixing enum and anyOf are rejected", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: {
        type: "object",
        properties: {
          picks: {
            type: "array",
            items: { type: "string", enum: ["a"], anyOf: [{ const: "a", title: "Ay" }] },
          },
        },
      },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("mix enum and anyOf");
  });

  test("multi-select items with neither enum nor anyOf are rejected", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { picks: { type: "array", items: { type: "string" } } } },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("neither enum nor anyOf");
  });

  test("titled multi-select option values share the untitled length bound", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: {
        type: "object",
        properties: {
          picks: { type: "array", items: { anyOf: [{ const: "v".repeat(ELICITATION_SCHEMA_LIMITS.maxOptionValueLength + 1), title: "Big" }] } },
        },
      },
    }));
    expect(result.ok).toBe(false);
  });

  test("required name without a property is rejected", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { a: { type: "string" } }, required: ["ghost"] },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('required "ghost"');
  });

  test("duplicate required entries are rejected", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { a: { type: "string" } }, required: ["a", "a"] },
    }));
    expect(result.ok).toBe(false);
  });

  test("ambiguous enum duplicate values are rejected", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { a: { type: "string", enum: ["x", "x"] } } },
    }));
    expect(result.ok).toBe(false);
  });

  test("mixing enum and oneOf is rejected", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: {
        type: "object",
        properties: { a: { type: "string", enum: ["x"], oneOf: [{ const: "x", title: "X" }] } },
      },
    }));
    expect(result.ok).toBe(false);
  });

  test("default that is not an offered option is rejected", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { a: { type: "string", enum: ["x"], default: "y" } } },
    }));
    expect(result.ok).toBe(false);
  });

  test("out-of-range numeric default is rejected", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { a: { type: "integer", minimum: 1, default: 0 } } },
    }));
    expect(result.ok).toBe(false);
  });

  test("non-string default for a text field is rejected", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { a: { type: "string", default: 7 } } },
    }));
    expect(result.ok).toBe(false);
  });

  test("minLength greater than maxLength is rejected", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { a: { type: "string", minLength: 5, maxLength: 2 } } },
    }));
    expect(result.ok).toBe(false);
  });

  test("non-integer bounds are rejected", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { a: { type: "string", maxLength: 2.5 } } },
    }));
    expect(result.ok).toBe(false);
  });

  test("oversized schema is rejected on field count", () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < ELICITATION_SCHEMA_LIMITS.maxFields + 1; i += 1) {
      properties[`f${i}`] = { type: "string" };
    }
    const result = normalizeAcpElicitationForm(formRequest({ requestedSchema: { type: "object", properties } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("resource_exceeded");
  });

  test("oversized message is rejected", () => {
    const result = normalizeAcpElicitationForm(formRequest({ message: "x".repeat(ELICITATION_SCHEMA_LIMITS.maxMessageLength + 1) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("resource_exceeded");
  });

  test("oversized options list is rejected", () => {
    const enumValues = Array.from({ length: ELICITATION_SCHEMA_LIMITS.maxOptionsPerField + 1 }, (_, i) => `v${i}`);
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { a: { type: "string", enum: enumValues } } },
    }));
    expect(result.ok).toBe(false);
  });

  test("malformed request shapes are rejected, not crashed on", () => {
    expect(normalizeAcpElicitationForm(null).ok).toBe(false);
    expect(normalizeAcpElicitationForm("nope").ok).toBe(false);
    expect(normalizeAcpElicitationForm({ mode: "form", message: 5 }).ok).toBe(false);
    expect(normalizeAcpElicitationForm({ mode: "form", message: "m" }).ok).toBe(false);
  });
});

describe("normalizeAcpElicitationForm string resource bounds", () => {
  test("oversized enum value is rejected even with few options", () => {
    // Count bounds alone let one unbounded option string through into the
    // renderer and pending state.
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: {
        type: "object",
        properties: { a: { type: "string", enum: ["x".repeat(ELICITATION_SCHEMA_LIMITS.maxOptionValueLength + 1)] } },
      },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("malformed_schema");
  });

  test("oversized titled option value is rejected", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: {
        type: "object",
        properties: {
          a: { type: "string", oneOf: [{ const: "y".repeat(ELICITATION_SCHEMA_LIMITS.maxOptionValueLength + 1), title: "Big" }] },
        },
      },
    }));
    expect(result.ok).toBe(false);
  });

  test("oversized text default is rejected", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: {
        type: "object",
        properties: { a: { type: "string", default: "d".repeat(ELICITATION_SCHEMA_LIMITS.maxDefaultValueLength + 1) } },
      },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("default exceeds");
  });

  test("oversized multi-select default item is rejected", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: {
        type: "object",
        properties: {
          a: {
            type: "array",
            items: { type: "string", enum: ["a".repeat(ELICITATION_SCHEMA_LIMITS.maxOptionValueLength + 1)] },
          },
        },
      },
    }));
    expect(result.ok).toBe(false);
  });

  test("oversized required list is rejected before traversal", () => {
    // Fewer fields than names: the field-count check passes, so the required
    // bound is what must reject it.
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < ELICITATION_SCHEMA_LIMITS.maxFields; i += 1) {
      properties[`f${i}`] = { type: "string" };
    }
    const names = [
      ...Object.keys(properties),
      ...Array.from(
        { length: ELICITATION_SCHEMA_LIMITS.maxRequiredNames + 1 - Object.keys(properties).length },
        (_, i) => `ghost${i}`,
      ),
    ];
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties, required: names },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("required exceeds");
  });

  test("aggregate policy cap rejects a pathological form", () => {
    // Not a "just above worst case" bound: the per-field limits compose
    // multiplicatively (20 fields × 100 titled options × 1512 chars ≈ 3.3M),
    // all individually legal. The cap is an independent product policy — a
    // human cannot fill in a 3MB form on a chat channel.
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < ELICITATION_SCHEMA_LIMITS.maxFields; i += 1) {
      properties[`f${i}`] = {
        type: "string",
        oneOf: Array.from({ length: ELICITATION_SCHEMA_LIMITS.maxOptionsPerField }, (_, n) => ({
          const: `c${n}`,
          title: "t".repeat(ELICITATION_SCHEMA_LIMITS.maxOptionLabelLength),
          description: "d".repeat(ELICITATION_SCHEMA_LIMITS.maxFieldDescriptionLength),
        })),
      };
    }
    const result = normalizeAcpElicitationForm(formRequest({
      message: "m".repeat(ELICITATION_SCHEMA_LIMITS.maxMessageLength),
      requestedSchema: { type: "object", properties },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("normalized form exceeds");
  });

  test("a realistic multi-option form passes the aggregate cap", () => {
    // The cap must not reject ordinary forms: 5 fields × 10 titled options is
    // ~75k chars, comfortably inside 256k.
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 5; i += 1) {
      properties[`f${i}`] = {
        type: "string",
        oneOf: Array.from({ length: 10 }, (_, n) => ({
          const: `c${n}`,
          title: `Option ${n}`,
          description: "d".repeat(200),
        })),
      };
    }
    const result = normalizeAcpElicitationForm(formRequest({ requestedSchema: { type: "object", properties } }));
    expect(result.ok).toBe(true);
  });

  test("a form inside every per-field limit and the total budget still normalizes", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: {
        type: "object",
        properties: {
          a: { type: "string", title: "A", maxLength: 10 },
          b: { type: "string", enum: ["x", "y"], default: "y" },
          c: { type: "array", items: { type: "string", enum: ["p", "q"] } },
        },
        required: ["a", "b"],
      },
    }));
    expect(result.ok).toBe(true);
  });
});

describe("validateElicitationAnswer", () => {
  const text = normalizeOk(formRequest())[0];
  const single = normalizeOk(formRequest({
    requestedSchema: { type: "object", properties: { c: { type: "string", enum: ["red", "blue"] } }, required: ["c"] },
  }))[0];
  const number = normalizeOk(formRequest({
    requestedSchema: { type: "object", properties: { n: { type: "integer", minimum: 1, maximum: 3 } }, required: ["n"] },
  }))[0];
  const bool = normalizeOk(formRequest({
    requestedSchema: { type: "object", properties: { b: { type: "boolean" } }, required: ["b"] },
  }))[0];
  const multi = normalizeOk(formRequest({
    requestedSchema: {
      type: "object",
      properties: { m: { type: "array", minItems: 1, maxItems: 2, items: { type: "string", enum: ["a", "b", "c"] } } },
      required: ["m"],
    },
  }))[0];

  test("valid answers pass", () => {
    expect(validateElicitationAnswer([text], { summary: "ok" }).ok).toBe(true);
    expect(validateElicitationAnswer([single], { c: "red" }).ok).toBe(true);
    expect(validateElicitationAnswer([number], { n: 2 }).ok).toBe(true);
    expect(validateElicitationAnswer([bool], { b: false }).ok).toBe(true);
    expect(validateElicitationAnswer([multi], { m: ["a", "c"] }).ok).toBe(true);
  });

  test("missing required key is rejected", () => {
    const result = validateElicitationAnswer([text], {});
    expect(result).toMatchObject({ ok: false });
  });

  test("optional field may be omitted", () => {
    const optional = normalizeOk(formRequest({ requestedSchema: { type: "object", properties: { summary: { type: "string" } } } }))[0];
    expect(validateElicitationAnswer([optional], undefined).ok).toBe(true);
    expect(validateElicitationAnswer([optional], {}).ok).toBe(true);
  });

  test("extra key is rejected", () => {
    const result = validateElicitationAnswer([text], { summary: "ok", bonus: "x" });
    expect(result).toMatchObject({ ok: false });
  });

  test("wrong scalar type is rejected", () => {
    expect(validateElicitationAnswer([text], { summary: 5 }).ok).toBe(false);
    expect(validateElicitationAnswer([bool], { b: "true" }).ok).toBe(false);
    expect(validateElicitationAnswer([number], { n: "2" }).ok).toBe(false);
  });

  test("integer field rejects non-integers and out-of-range values", () => {
    expect(validateElicitationAnswer([number], { n: 2.5 }).ok).toBe(false);
    expect(validateElicitationAnswer([number], { n: 4 }).ok).toBe(false);
    expect(validateElicitationAnswer([number], { n: 0 }).ok).toBe(false);
  });

  test("number field accepts finite decimals", () => {
    const decimal = normalizeOk(formRequest({
      requestedSchema: { type: "object", properties: { r: { type: "number" } } },
    }))[0];
    expect(validateElicitationAnswer([decimal], { r: 0.25 }).ok).toBe(true);
    expect(validateElicitationAnswer([decimal], { r: Number.NaN }).ok).toBe(false);
  });

  test("enum violations are rejected", () => {
    expect(validateElicitationAnswer([single], { c: "green" }).ok).toBe(false);
  });

  test("multi-select violations are rejected", () => {
    expect(validateElicitationAnswer([multi], { m: ["z"] }).ok).toBe(false);
    expect(validateElicitationAnswer([multi], { m: ["a", "a", "b"] }).ok).toBe(false);
    expect(validateElicitationAnswer([multi], { m: ["a", "b", "c"] }).ok).toBe(false);
    expect(validateElicitationAnswer([multi], { m: [] }).ok).toBe(false);
  });

  test("string length bounds are enforced", () => {
    const bounded = normalizeOk(formRequest({
      requestedSchema: { type: "object", properties: { s: { type: "string", minLength: 3, maxLength: 4 } }, required: ["s"] },
    }))[0];
    expect(validateElicitationAnswer([bounded], { s: "ab" }).ok).toBe(false);
    expect(validateElicitationAnswer([bounded], { s: "abcde" }).ok).toBe(false);
    expect(validateElicitationAnswer([bounded], { s: "abcd" }).ok).toBe(true);
  });

  test("known safe formats are validated deterministically", () => {
    const email = normalizeOk(formRequest({
      requestedSchema: { type: "object", properties: { e: { type: "string", format: "email" } } },
    }))[0];
    const uri = normalizeOk(formRequest({
      requestedSchema: { type: "object", properties: { u: { type: "string", format: "uri" } } },
    }))[0];
    const date = normalizeOk(formRequest({
      requestedSchema: { type: "object", properties: { d: { type: "string", format: "date" } } },
    }))[0];
    const dateTime = normalizeOk(formRequest({
      requestedSchema: { type: "object", properties: { t: { type: "string", format: "date-time" } } },
    }))[0];
    expect(validateElicitationAnswer([email], { e: "a@b.co" }).ok).toBe(true);
    expect(validateElicitationAnswer([email], { e: "not-an-email" }).ok).toBe(false);
    expect(validateElicitationAnswer([uri], { u: "https://example.com/x" }).ok).toBe(true);
    expect(validateElicitationAnswer([uri], { u: "example.com" }).ok).toBe(false);
    expect(validateElicitationAnswer([date], { d: "2026-09-20" }).ok).toBe(true);
    expect(validateElicitationAnswer([date], { d: "20/09/2026" }).ok).toBe(false);
    expect(validateElicitationAnswer([dateTime], { t: "2026-09-20T10:00:00Z" }).ok).toBe(true);
    expect(validateElicitationAnswer([dateTime], { t: "not a timestamp" }).ok).toBe(false);
  });

  test("sentinel answer value round-trips and never appears in summaries", () => {
    const secret = "SENTINEL-ELICITATION-ANSWER-9f3c2a";
    const validated = validateElicitationAnswer([text], { summary: secret });
    expect(validated).toMatchObject({ ok: true });
    if (!validated.ok) return;
    expect(validated.content.summary).toBe(secret);
    const serialized = JSON.stringify(summarizeElicitationSchema([text]));
    expect(serialized).not.toContain(secret);
  });
});

describe("validateElicitationAnswer calendar and RFC3339 strictness", () => {
  function fieldOf(format: "date" | "date-time") {
    return normalizeOk(formRequest({
      requestedSchema: { type: "object", properties: { when: { type: "string", format } }, required: ["when"] },
    }))[0];
  }

  const date = fieldOf("date");
  const dateTime = fieldOf("date-time");

  test("valid dates and leap day pass", () => {
    expect(validateElicitationAnswer([date], { when: "2026-09-20" }).ok).toBe(true);
    expect(validateElicitationAnswer([date], { when: "2024-02-29" }).ok).toBe(true);
    expect(validateElicitationAnswer([date], { when: "2000-02-29" }).ok).toBe(true);
  });

  test("non-existent calendar dates are rejected", () => {
    // Date.parse normalizes these into the following month, so a lenient
    // check accepts them.
    expect(validateElicitationAnswer([date], { when: "2026-02-31" }).ok).toBe(false);
    expect(validateElicitationAnswer([date], { when: "2026-02-30" }).ok).toBe(false);
    expect(validateElicitationAnswer([date], { when: "2026-04-31" }).ok).toBe(false);
    expect(validateElicitationAnswer([date], { when: "2026-06-31" }).ok).toBe(false);
    expect(validateElicitationAnswer([date], { when: "2026-13-01" }).ok).toBe(false);
    expect(validateElicitationAnswer([date], { when: "2026-00-10" }).ok).toBe(false);
    expect(validateElicitationAnswer([date], { when: "2026-01-00" }).ok).toBe(false);
  });

  test("Feb 29 is rejected in non-leap years", () => {
    expect(validateElicitationAnswer([date], { when: "2026-02-29" }).ok).toBe(false);
    expect(validateElicitationAnswer([date], { when: "2100-02-29" }).ok).toBe(false);
  });

  test("malformed date shapes are rejected", () => {
    expect(validateElicitationAnswer([date], { when: "2026-9-20" }).ok).toBe(false);
    expect(validateElicitationAnswer([date], { when: "20/09/2026" }).ok).toBe(false);
    expect(validateElicitationAnswer([date], { when: "2026-09-20T00:00:00Z" }).ok).toBe(false);
  });

  test("full RFC3339 date-times pass", () => {
    expect(validateElicitationAnswer([dateTime], { when: "2026-09-20T10:00:00Z" }).ok).toBe(true);
    expect(validateElicitationAnswer([dateTime], { when: "2026-09-20T10:00:00.123Z" }).ok).toBe(true);
    expect(validateElicitationAnswer([dateTime], { when: "2026-09-20T10:00:00+08:00" }).ok).toBe(true);
    expect(validateElicitationAnswer([dateTime], { when: "2026-09-20T10:00:00-05:30" }).ok).toBe(true);
  });

  test("incomplete RFC3339 date-times are rejected", () => {
    // Missing seconds and missing timezone offset were both accepted before.
    expect(validateElicitationAnswer([dateTime], { when: "2026-09-20T10:00" }).ok).toBe(false);
    expect(validateElicitationAnswer([dateTime], { when: "2026-09-20T10:00:00" }).ok).toBe(false);
    expect(validateElicitationAnswer([dateTime], { when: "2026-09-20 10:00:00Z" }).ok).toBe(false);
  });

  test("out-of-range clock and offset components are rejected", () => {
    expect(validateElicitationAnswer([dateTime], { when: "2026-09-20T24:00:00Z" }).ok).toBe(false);
    expect(validateElicitationAnswer([dateTime], { when: "2026-09-20T10:60:00Z" }).ok).toBe(false);
    expect(validateElicitationAnswer([dateTime], { when: "2026-09-20T10:00:00+25:00" }).ok).toBe(false);
    expect(validateElicitationAnswer([dateTime], { when: "2026-09-20T10:00:00+08:75" }).ok).toBe(false);
  });

  test("a date-time with a non-existent calendar date is rejected", () => {
    expect(validateElicitationAnswer([dateTime], { when: "2026-02-31T10:00:00Z" }).ok).toBe(false);
    expect(validateElicitationAnswer([dateTime], { when: "2026-13-01T10:00:00Z" }).ok).toBe(false);
  });
});
