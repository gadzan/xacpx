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
    // `type` field (TitledMultiSelectItems). A present `type` would make it a
    // TYPED variant, and only "string" + `enum` is supported in v1 — see the
    // forward-compatibility tests below.
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
    if (!result.ok) expect(result.reason).toContain("string items have no enum");
  });

  test("typeless items with neither enum nor anyOf are rejected", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { picks: { type: "array", items: {} } } },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("neither enum nor anyOf");
  });

  test("a future multi-select item type with anyOf is not rendered as titled", () => {
    // ACP: a present `type` makes it a TYPED variant. Anything other than
    // "string" is a future protocol variant a client MUST NOT render as a
    // string multi-select — only the typeless `{ anyOf }` member is titled.
    for (const type of ["_future", "future", "object", "number"]) {
      const result = normalizeAcpElicitationForm(formRequest({
        requestedSchema: {
          type: "object",
          properties: { picks: { type: "array", items: { type, anyOf: [{ const: "x", title: "Ex" }] } } },
        },
      }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("unsupported multi-select item type");
    }
  });

  test('a non-standard "string + anyOf" without enum is rejected', () => {
    // Round 2 had accidentally blessed this shape. Per ACP, the typed string
    // variant REQUIRES `enum`; `anyOf` belongs to the typeless titled member.
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: {
        type: "object",
        properties: { picks: { type: "array", items: { type: "string", anyOf: [{ const: "x", title: "Ex" }] } } },
      },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("string items have no enum");
  });

  test("a typed string variant mixing enum and anyOf is rejected", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: {
        type: "object",
        properties: {
          picks: { type: "array", items: { type: "string", enum: ["a"], anyOf: [{ const: "a", title: "Ay" }] } },
        },
      },
    }));
    expect(result.ok).toBe(false);
  });

  test("a typeless member mixing enum and anyOf is rejected", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: {
        type: "object",
        properties: { picks: { type: "array", items: { enum: ["a"], anyOf: [{ const: "a", title: "Ay" }] } } },
      },
    }));
    expect(result.ok).toBe(false);
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

  test("a default that is not an offered option is dropped, not rejected", () => {
    // Per JSON Schema vocabulary and ACP's pre-fill semantics, `default` is an
    // ANNOTATION. A value naming an option the form does not offer cannot be
    // pre-filled safely, so it is dropped and the form still renders — the
    // human's answer is what gets validated, not the agent's hint.
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { a: { type: "string", oneOf: [{ const: "x", title: "X" }], default: "y" } } },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.fields[0]).toMatchObject({ kind: "single-select" });
    expect("defaultValue" in (result.form.fields[0] as object)).toBe(false);
  });

  test("an out-of-range numeric default is dropped, not rejected", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { a: { type: "integer", minimum: 1, default: 0 } } },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The bound itself stays — only the unusable pre-fill hint is gone.
    expect(result.form.fields[0]).toMatchObject({ kind: "number", minimum: 1 });
    expect("defaultValue" in (result.form.fields[0] as object)).toBe(false);
  });

  test("a non-string default for a text field is dropped, not rejected", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { a: { type: "string", default: 7 } } },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("defaultValue" in (result.form.fields[0] as object)).toBe(false);
  });

  test("a default the field's own constraints would reject is never pre-filled", () => {
    // Pre-fill policy: core hands a renderer only a default it would itself
    // ACCEPT as a submitted answer. Showing `{minLength:3, default:"x"}` would
    // trap the user — submit unchanged and core rejects. Same for maxLength and
    // a format the value does not satisfy.
    const short = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { a: { type: "string", minLength: 3, default: "x" } } },
    }));
    expect(short.ok).toBe(true);
    if (short.ok) expect("defaultValue" in (short.form.fields[0] as object)).toBe(false);

    const long = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { a: { type: "string", maxLength: 2, default: "xyz" } } },
    }));
    expect(long.ok).toBe(true);
    if (long.ok) expect("defaultValue" in (long.form.fields[0] as object)).toBe(false);

    const notEmail = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { a: { type: "string", format: "email", default: "not-an-email" } } },
    }));
    expect(notEmail.ok).toBe(true);
    if (notEmail.ok) expect("defaultValue" in (notEmail.form.fields[0] as object)).toBe(false);

    // ...and an in-bounds, format-satisfying default still pre-fills, so the
    // policy removes traps rather than all pre-fill.
    const good = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { a: { type: "string", format: "email", default: "a@b.co" } } },
    }));
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.form.fields[0]).toMatchObject({ defaultValue: "a@b.co" });
  });

  test("a legal default is still carried through", () => {
    // Dropping must not become dropping-everything: a usable pre-fill hint is
    // what a renderer needs to pre-populate the control.
    const text = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { a: { type: "string", default: "seed" } } },
    }));
    expect(text.ok).toBe(true);
    if (text.ok) expect(text.form.fields[0]).toMatchObject({ defaultValue: "seed" });

    const number = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { a: { type: "integer", minimum: 1, maximum: 5, default: 3 } } },
    }));
    expect(number.ok).toBe(true);
    if (number.ok) expect(number.form.fields[0]).toMatchObject({ defaultValue: 3 });

    const flag = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { a: { type: "boolean", default: true } } },
    }));
    expect(flag.ok).toBe(true);
    if (flag.ok) expect(flag.form.fields[0]).toMatchObject({ defaultValue: true });

    const multi = normalizeAcpElicitationForm(formRequest({
      requestedSchema: {
        type: "object",
        properties: {
          a: { type: "array", items: { type: "string", enum: ["x", "y", "z"] }, default: ["x", "y"] },
        },
      },
    }));
    expect(multi.ok).toBe(true);
    if (multi.ok) expect(multi.form.fields[0]).toMatchObject({ defaultValue: ["x", "y"] });
  });

  test("a multi-select default keeps only its legal, deduplicated subset", () => {
    // Duplicates and non-offered entries in the pre-fill hint both prevent
    // safe pre-filling, so they are filtered out rather than rejecting the
    // whole form.
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: {
        type: "object",
        properties: {
          a: { type: "array", items: { type: "string", enum: ["x", "y"] }, default: ["x", "x", "nope"] },
        },
      },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.fields[0]).toMatchObject({ defaultValue: ["x"] });
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

  test("an oversized text default is dropped, not rejected", () => {
    // Annotations must not be able to fail a form: a pre-fill hint longer than
    // the size limit simply cannot be pre-filled, so it is discarded and the
    // field renders empty. The FORM, not the hint, is what must validate.
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: {
        type: "object",
        properties: { a: { type: "string", default: "d".repeat(ELICITATION_SCHEMA_LIMITS.maxDefaultValueLength + 1) } },
      },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("defaultValue" in (result.form.fields[0] as object)).toBe(false);
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

  test("schema metadata counts toward the aggregate cap", () => {
    // Regression: round 3 added schemaTitle/schemaDescription and single-select
    // pattern without adding them to the total, so the "every string" claim in
    // the cap's comment was false again.
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < ELICITATION_SCHEMA_LIMITS.maxFields; i += 1) {
      properties[`f${i}`] = {
        type: "string",
        oneOf: Array.from({ length: ELICITATION_SCHEMA_LIMITS.maxOptionsPerField }, (_, n) => ({
          const: `c${n}`,
          title: "t".repeat(ELICITATION_SCHEMA_LIMITS.maxOptionLabelLength),
          description: "d".repeat(ELICITATION_SCHEMA_LIMITS.maxFieldDescriptionLength),
        })),
        pattern: "p".repeat(ELICITATION_SCHEMA_LIMITS.maxPatternLength),
      };
    }
    // Without metadata this is already over the cap; adding maxed-out
    // schemaTitle/schemaDescription must still be rejected, not silently
    // absorbed by an undercounted total.
    const base = normalizeAcpElicitationForm(formRequest({ requestedSchema: { type: "object", properties } }));
    expect(base.ok).toBe(false);

    const withMeta = normalizeAcpElicitationForm(formRequest({
      requestedSchema: {
        type: "object",
        title: "t".repeat(ELICITATION_SCHEMA_LIMITS.maxFieldTitleLength),
        description: "d".repeat(ELICITATION_SCHEMA_LIMITS.maxFieldDescriptionLength),
        properties,
      },
    }));
    expect(withMeta.ok).toBe(false);
  });

  test("a near-threshold legal form with metadata still passes", () => {
    // The cap must not over-reject once metadata is counted.
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: {
        type: "object",
        title: "Deploy",
        description: "Pick options",
        properties: {
          a: { type: "string", title: "A", maxLength: 10 },
          b: { type: "string", enum: ["x", "y"], default: "y" },
        },
      },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.schemaTitle).toBe("Deploy");
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

describe("normalizeAcpElicitationForm prototype-key safety", () => {
  test('required: ["toString"] without a real property is rejected', () => {
    // `"toString" in propertiesRecord` is true via Object.prototype, so an `in`
    // check would let a required name that no field defines pass.
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { real: { type: "string" } }, required: ["toString"] },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('required "toString" is not a form field');
  });

  test('required: ["constructor"] and ["__proto__"] are rejected the same way', () => {
    for (const name of ["constructor", "__proto__"]) {
      const result = normalizeAcpElicitationForm(formRequest({
        requestedSchema: { type: "object", properties: { real: { type: "string" } }, required: [name] },
      }));
      expect(result.ok).toBe(false);
    }
  });

  test("a real own property named toString is a legal field", () => {
    const fields = normalizeOk(formRequest({
      requestedSchema: {
        type: "object",
        properties: { toString: { type: "string", title: "Name" } },
        required: ["toString"],
      },
    }));
    expect(fields[0]).toMatchObject({ key: "toString", kind: "text", required: true });
  });
});

describe("validateElicitationAnswer prototype-key safety", () => {
  const toStringField = normalizeOk(formRequest({
    requestedSchema: {
      type: "object",
      properties: { toString: { type: "string" } },
      required: ["toString"],
    },
  }))[0];
  const optionalToString = normalizeOk(formRequest({
    requestedSchema: { type: "object", properties: { toString: { type: "string" } } },
  }))[0];
  // NOTE: an object LITERAL `{ __proto__: ... }` and `JSON.stringify` of one
  // both treat the key as a prototype setter and drop it, but `JSON.parse`
  // DOES create a real own property. Build with defineProperty so the key is
  // an own data property either way.
  const protoRequest = formRequest({
    requestedSchema: { type: "object", properties: {}, required: ["__proto__"] },
  }) as { requestedSchema: { properties: Record<string, unknown> } };
  Object.defineProperty(protoRequest.requestedSchema.properties, "__proto__", {
    value: { type: "string" },
    enumerable: true,
    writable: true,
    configurable: true,
  });
  const protoField = normalizeOk(protoRequest)[0];

  test("an optional toString field is not satisfied by the inherited function", () => {
    // Reading `source.toString` would return Object.prototype's function, which
    // looks like a submitted non-string value instead of an omitted answer.
    const result = validateElicitationAnswer([optionalToString], {});
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(Object.keys(result.content)).toEqual([]);
  });

  test("a required toString field still requires a real answer", () => {
    expect(validateElicitationAnswer([toStringField], {}).ok).toBe(false);
    expect(validateElicitationAnswer([toStringField], { toString: "Ada" }).ok).toBe(true);
  });

  test("a __proto__ answer survives as an own data property", () => {
    // `out["__proto__"] = value` on a plain object is a prototype setter, so a
    // legal answer would silently vanish.
    const result = validateElicitationAnswer([protoField], JSON.parse('{"__proto__":"Ada"}'));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.content.__proto__).toBe("Ada");
    expect(Object.keys(result.content)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(result.content)).toBeNull();
  });

  test("a constructor answer survives the same way", () => {
    const field = normalizeOk(formRequest({
      requestedSchema: { type: "object", properties: { constructor: { type: "string" } }, required: ["constructor"] },
    }))[0];
    const result = validateElicitationAnswer([field], { constructor: "Ada" });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.content.constructor).toBe("Ada");
  });
});

describe("normalizeAcpElicitationForm presentation metadata", () => {
  test("schema-level title and description are carried through", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: {
        type: "object",
        title: "Deploy settings",
        description: "Choose how to ship",
        properties: { env: { type: "string" } },
      },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.schemaTitle).toBe("Deploy settings");
    expect(result.form.schemaDescription).toBe("Choose how to ship");
  });

  test("oversized schema-level title is rejected, not truncated", () => {
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: {
        type: "object",
        title: "t".repeat(ELICITATION_SCHEMA_LIMITS.maxFieldTitleLength + 1),
        properties: { env: { type: "string" } },
      },
    }));
    expect(result.ok).toBe(false);
  });

  test("single-select keeps the agent pattern as display metadata", () => {
    const fields = normalizeOk(formRequest({
      requestedSchema: {
        type: "object",
        properties: { code: { type: "string", enum: ["a1", "b2"], pattern: "^[a-z][0-9]$" } },
      },
    }));
    expect(fields[0]).toMatchObject({ kind: "single-select", pattern: "^[a-z][0-9]$" });
  });

  test("a titled option missing its title is rejected, not auto-labeled", () => {
    // ACP EnumOption requires const AND title. Reusing the value as the label
    // would show the user a label the agent never chose.
    const oneOf = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { c: { type: "string", oneOf: [{ const: "x" }] } } },
    }));
    expect(oneOf.ok).toBe(false);

    const anyOf = normalizeAcpElicitationForm(formRequest({
      requestedSchema: {
        type: "object",
        properties: { m: { type: "array", items: { anyOf: [{ const: "x" }] } } },
      },
    }));
    expect(anyOf.ok).toBe(false);
  });

  test("a present-but-EMPTY titled option title is legal, not malformed", () => {
    // The pinned SDK models EnumOption.title as a plain z.string() with no
    // .min(1), so `title: ""` is protocol-valid. Missing fails closed; empty
    // must not be conflated with missing.
    const fields = normalizeOk(formRequest({
      requestedSchema: {
        type: "object",
        properties: { c: { type: "string", oneOf: [{ const: "x", title: "" }] } },
      },
    }));
    expect(fields[0]).toMatchObject({ kind: "single-select", options: [{ value: "x", label: "" }] });
  });

  test("empty pattern, field title and description are legal", () => {
    const fields = normalizeOk(formRequest({
      requestedSchema: {
        type: "object",
        title: "",
        description: "",
        properties: { c: { type: "string", title: "", description: "", pattern: "" } },
      },
    }));
    expect(fields[0]).toMatchObject({ kind: "text", title: "", pattern: "" });
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", title: "", properties: { c: { type: "string" } } },
    }));
    expect(result.ok).toBe(true);
  });
});

describe("normalizeAcpElicitationForm diagnostic bounds", () => {
  test("malformed schemas produce bounded diagnostics, never raw agent strings", () => {
    // Property names, types and modes are agent-controlled and can be
    // arbitrarily long; the rejection reason reaches the logger verbatim.
    const longKey = "k".repeat(ELICITATION_SCHEMA_LIMITS.maxFieldKeyLength + 500);
    const cases: unknown[] = [
      // Long key with a non-object property: this path fires BEFORE the
      // key-length guard inside normalizeField.
      { type: "object", properties: { [longKey]: "not-an-object" } },
      // Long unknown type.
      { type: "object", properties: { a: { type: "t".repeat(ELICITATION_SCHEMA_LIMITS.maxDiagnosticKeyChars + 500) } } },
      // Long unknown required name.
      { type: "object", properties: { a: { type: "string" } }, required: [longKey] },
    ];
    for (const requestedSchema of cases) {
      const result = normalizeAcpElicitationForm(formRequest({ requestedSchema }));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason.length).toBeLessThan(400);
      expect(result.reason).not.toContain("k".repeat(200));
    }
  });

  test("a long unknown mode is bounded too", () => {
    const result = normalizeAcpElicitationForm(formRequest({ mode: "m".repeat(5000) }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.length).toBeLessThan(400);
  });

  test("required names are bounded before lookup", () => {
    const longName = "n".repeat(ELICITATION_SCHEMA_LIMITS.maxFieldKeyLength + 100);
    const result = normalizeAcpElicitationForm(formRequest({
      requestedSchema: { type: "object", properties: { a: { type: "string" } }, required: [longName] },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("resource_exceeded");
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

  test("text length bounds count Unicode code points, not UTF-16 units", () => {
    // JSON Schema's string data model is code points; `"😀".length === 2` in JS.
    const bounded = normalizeOk(formRequest({
      requestedSchema: { type: "object", properties: { s: { type: "string", minLength: 2, maxLength: 2 } }, required: ["s"] },
    }))[0];
    // One astral character is ONE code point: minLength 2 must reject it.
    expect(validateElicitationAnswer([bounded], { s: "😀" }).ok).toBe(false);
    // Two code points is legal even though it is 4 UTF-16 units.
    expect(validateElicitationAnswer([bounded], { s: "😀😀" }).ok).toBe(true);
  });

  test("maxLength 1 accepts a single astral character", () => {
    const bounded = normalizeOk(formRequest({
      requestedSchema: { type: "object", properties: { s: { type: "string", maxLength: 1 } }, required: ["s"] },
    }))[0];
    expect(validateElicitationAnswer([bounded], { s: "😀" }).ok).toBe(true);
  });

  test("single-select length bounds count code points too", () => {
    const field = normalizeOk(formRequest({
      requestedSchema: {
        type: "object",
        properties: { c: { type: "string", enum: ["😀", "ab"], minLength: 2 } },
        required: ["c"],
      },
    }))[0];
    expect(validateElicitationAnswer([field], { c: "😀" }).ok).toBe(false);
    expect(validateElicitationAnswer([field], { c: "ab" }).ok).toBe(true);
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

  test("an oversized free-text answer is rejected even with no maxLength", () => {
    // Regression: `maxLength` is optional and agent-supplied, so it was the
    // only bound on accepted content. A channel returning an unbounded answer
    // would have been accepted and copied daemon → bridge → worker → ACP.
    const optional = normalizeOk(formRequest({
      requestedSchema: { type: "object", properties: { summary: { type: "string" } } },
    }))[0];
    const huge = "x".repeat(ELICITATION_SCHEMA_LIMITS.maxAcceptedAnswerChars + 1);
    const result = validateElicitationAnswer([optional], { summary: huge });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.reason).toContain("core size limit");
  });

  test("an oversized AND format-invalid uri is rejected by the size preflight", async () => {
    // Ordering proof, not just a false result: the input is BOTH oversized and
    // format-invalid (`%zz` is malformed percent-encoding). With the correct
    // order the size preflight rejects first and the reason is the size limit;
    // with the preflight moved back after validateFieldValue, Ajv would reject
    // first and the reason would be "is not a uri". Verified by mutation.
    const uriField = normalizeOk(formRequest({
      requestedSchema: { type: "object", properties: { u: { type: "string", format: "uri" } }, required: ["u"] },
    }))[0];
    const huge = `https://example.com/${"a".repeat(ELICITATION_SCHEMA_LIMITS.maxAcceptedAnswerChars + 1)}%zz`;
    const result = validateElicitationAnswer([uriField], { u: huge });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.reason).toContain("core size limit");
    expect(result.reason).not.toContain("is not a uri");
  });

  test("a proxied array cannot bypass the length admission with a valueOf trap", () => {
    // Regression: reading `length` once is not the same as snapshotting its
    // semantics. `Array.isArray` accepts a Proxy, and a Proxy `get("length")`
    // trap can return an object whose `valueOf()` re-runs on every numeric
    // coercion — `length` is coerced by the two `>` checks, by `new Array()`
    // and by the loop condition. Returning 1 for admission and 1000 afterwards
    // rebuilt exactly the traversal rounds 9 and 10 removed.
    const multi = normalizeOk(formRequest({
      requestedSchema: {
        type: "object",
        properties: { tags: { type: "array", items: { type: "string", enum: ["a", "b", "c"] } } },
        required: ["tags"],
      },
    }))[0];

    let valueOfCalls = 0;
    let indexReads = 0;
    const target: string[] = new Array(100_000_000);
    const hostile = new Proxy(target, {
      get(trapTarget, prop, receiver) {
        if (prop === "length") {
          // Small while the admission checks run, enormous afterwards.
          return {
            valueOf() {
              valueOfCalls += 1;
              return valueOfCalls <= 2 ? 1 : 100_000_000;
            },
          };
        }
        if (typeof prop === "string" && /^\d+$/.test(prop)) indexReads += 1;
        return Reflect.get(trapTarget, prop, receiver);
      },
    });

    const result = validateElicitationAnswer([multi], { tags: hostile });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.reason).toContain("core size limit");
    // The proof that matters: the length was reduced to a primitive before any
    // coercion, so the trap's changing value never reached the admission
    // checks, the allocation, or the loop.
    expect(valueOfCalls).toBe(0);
    expect(indexReads).toBe(0);
  });

  test("a non-integer or negative length is rejected without coercion", () => {
    const multi = normalizeOk(formRequest({
      requestedSchema: {
        type: "object",
        properties: { tags: { type: "array", items: { type: "string", enum: ["a", "b", "c"] } } },
        required: ["tags"],
      },
    }))[0];

    let valueOfCalls = 0;
    const fractional = new Proxy(["a"] as unknown[], {
      get(trapTarget, prop, receiver) {
        if (prop === "length") {
          return {
            valueOf() {
              valueOfCalls += 1;
              return 1.5;
            },
          };
        }
        return Reflect.get(trapTarget, prop, receiver);
      },
    });

    const fractionalResult = validateElicitationAnswer([multi], { tags: fractional });
    expect(fractionalResult).toMatchObject({ ok: false });
    expect(valueOfCalls).toBe(0);

    const negative = new Proxy(["a"] as unknown[], {
      get(trapTarget, prop, receiver) {
        if (prop === "length") {
          return {
            valueOf() {
              return -1;
            },
          };
        }
        return Reflect.get(trapTarget, prop, receiver);
      },
    });
    expect(validateElicitationAnswer([multi], { tags: negative })).toMatchObject({ ok: false });
  });

  test("a sparse oversized array is rejected on length alone, with zero index reads", () => {
    // Regression: round 9's canonicalisation ran before any length check, which
    // deleted round 8's O(1) admission gate. A sparse `new Array(N)` forced a
    // full N-entry snapshot before the option-count check could reject it —
    // no getters or Proxy needed, just a big `length`.
    const multi = normalizeOk(formRequest({
      requestedSchema: {
        type: "object",
        properties: { tags: { type: "array", items: { type: "string", enum: ["a", "b", "c"] } } },
        required: ["tags"],
      },
    }))[0];

    let indexReads = 0;
    const sparse: string[] = new Array(10_000);
    Object.defineProperty(sparse, "0", {
      enumerable: true,
      configurable: true,
      get() {
        indexReads += 1;
        return "a";
      },
    });

    const result = validateElicitationAnswer([multi], { tags: sparse });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.reason).toContain("core size limit");
    // The proof that matters: the length guard fired BEFORE any traversal.
    expect(indexReads).toBe(0);
  });

  test("an oversized array on a non-multi-select field is rejected on length alone", () => {
    // Same gate protects text/boolean/number fields: an array submitted there is
    // always wrong, so the type check must not have to traverse it first.
    const text = normalizeOk(formRequest({
      requestedSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
    }))[0];

    let indexReads = 0;
    const sparse: string[] = new Array(5_000);
    Object.defineProperty(sparse, "0", {
      enumerable: true,
      configurable: true,
      get() {
        indexReads += 1;
        return "a";
      },
    });

    const result = validateElicitationAnswer([text], { note: sparse });
    expect(result).toMatchObject({ ok: false });
    expect(indexReads).toBe(0);
  });

  test("an in-bounds array is still canonicalised with one read per index", () => {
    // The admission gate must not over-reject: a legal multi-select still works.
    const multi = normalizeOk(formRequest({
      requestedSchema: {
        type: "object",
        properties: { tags: { type: "array", items: { type: "string", enum: ["a", "b", "c"] } } },
        required: ["tags"],
      },
    }))[0];
    expect(validateElicitationAnswer([multi], { tags: ["a", "b"] }).ok).toBe(true);
  });

  test("an oversized multi-select array is rejected without traversal", () => {
    // `options` is capped at 100 entries, so any longer array cannot possibly be
    // legal. The preflight uses that bound to reject with one comparison
    // instead of running `every`, a Set, and per-item membership first.
    const multi = normalizeOk(formRequest({
      requestedSchema: {
        type: "object",
        properties: { tags: { type: "array", items: { type: "string", enum: ["a", "b", "c"] } } },
        required: ["tags"],
      },
    }))[0];
    const impossible = Array.from({ length: 10_000 }, () => "a");
    const result = validateElicitationAnswer([multi], { tags: impossible });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.reason).toContain("core size limit");
  });

  test("an accessor array cannot substitute an unvalidated value at clone time", () => {
    // Regression: validation and the final clone both read the renderer's
    // array, so index getters could return a legal option during `every`/Set/
    // membership and something else during `[...validated.value]` — an
    // unvalidated value, or a multi-MB string that also bypasses the size cap.
    const multi = normalizeOk(formRequest({
      requestedSchema: {
        type: "object",
        properties: { tags: { type: "array", items: { type: "string", enum: ["a", "b"] } } },
        required: ["tags"],
      },
    }))[0];

    let reads = 0;
    const accessor: string[] = ["a"];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        // Valid for the validation reads, unvalidated for any later read.
        return reads <= 4 ? "a" : "not-offered";
      },
    });

    const result = validateElicitationAnswer([multi], { tags: accessor });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    // The accepted content is the SNAPSHOT taken during canonicalisation, not a
    // later getter read.
    expect(result.content.tags).toEqual(["a"]);
    expect(result.content.tags).not.toContain("not-offered");
  });

  test("an accessor array cannot bypass the answer cap at clone time", () => {
    const multi = normalizeOk(formRequest({
      requestedSchema: {
        type: "object",
        properties: { tags: { type: "array", items: { type: "string", enum: ["a"] } } },
        required: ["tags"],
      },
    }))[0];

    let reads = 0;
    const accessor: string[] = ["a"];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        // Small during canonicalisation/validation, enormous afterwards.
        return reads <= 4 ? "a" : "x".repeat(ELICITATION_SCHEMA_LIMITS.maxAcceptedAnswerChars + 1);
      },
    });

    const result = validateElicitationAnswer([multi], { tags: accessor });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const tags = result.content.tags;
    expect(Array.isArray(tags) ? tags[0] : undefined).toBe("a");
  });

  test("a multi-select array within the option count still validates normally", () => {
    const multi = normalizeOk(formRequest({
      requestedSchema: {
        type: "object",
        properties: { tags: { type: "array", items: { type: "string", enum: ["a", "b", "c"] } } },
        required: ["tags"],
      },
    }))[0];
    expect(validateElicitationAnswer([multi], { tags: ["a", "b"] }).ok).toBe(true);
    expect(validateElicitationAnswer([multi], { tags: ["z"] }).ok).toBe(false);
    expect(validateElicitationAnswer([multi], { tags: ["a", "a"] }).ok).toBe(false);
  });
});

describe("validateElicitationAnswer email format", () => {
  const email = normalizeOk(formRequest({
    requestedSchema: { type: "object", properties: { e: { type: "string", format: "email" } }, required: ["e"] },
  }))[0];

  test("plain ASCII mailboxes are accepted", () => {
    for (const value of [
      "a@b.co",
      "user.name+tag@example.com",
      "x_y-z@sub.domain.example.org",
    ]) {
      expect(validateElicitationAnswer([email], { e: value }).ok).toBe(true);
    }
  });

  test("non-ASCII is rejected (that is idn-email, not email)", () => {
    // JSON Schema's `email` is 7-bit ASCII per RFC 5321; internationalized
    // addresses belong to the separate `idn-email` format.
    expect(validateElicitationAnswer([email], { e: "é@example.com" }).ok).toBe(false);
    expect(validateElicitationAnswer([email], { e: "用户@例え.テスト" }).ok).toBe(false);
  });

  test("invalid dot-atom local parts are rejected", () => {
    for (const value of [
      "a..b@example.com",
      ".leading@example.com",
      "trailing.@example.com",
    ]) {
      expect(validateElicitationAnswer([email], { e: value }).ok).toBe(false);
    }
  });

  test("malformed domains are rejected", () => {
    for (const value of [
      "a@b..c",
      "a@-b.co",
      "a@b.c-",
      "a@",
      "@b.co",
      "a@b@c.co",
      "a@.b.co",
    ]) {
      expect(validateElicitationAnswer([email], { e: value }).ok).toBe(false);
    }
  });

  test("a quoted local part is rejected by the reference validator", () => {
    // Documented deviation: ajv-formats rejects the RFC 5321 quoted-string
    // local part. Accepted deliberately — see the note on formatValidator in
    // elicitation-schema.ts. A form asking a human to type
    // `"a@b"@example.com` is not a real product case, and the alternative was
    // a fourth hand-rolled grammar.
    expect(validateElicitationAnswer([email], { e: '"a@b"@example.com' }).ok).toBe(false);
  });

  test("an address-literal domain is rejected by the reference validator", () => {
    // Same documented deviation as above.
    expect(validateElicitationAnswer([email], { e: "user@[192.0.2.1]" }).ok).toBe(false);
  });

  test("a single-label domain is rejected by the reference validator", () => {
    // Documented deviation: `a@b` is a legal RFC 5321 dot-atom domain but the
    // reference validator requires at least one dot in the domain.
    expect(validateElicitationAnswer([email], { e: "a@b" }).ok).toBe(false);
  });

  test("an over-long local part is not length-bounded by the reference validator", () => {
    // Documented deviation: ajv-formats checks structure but not the RFC 5321
    // 64-octet local-part limit. The overall accepted-answer size cap still
    // bounds how much text can reach the agent.
    expect(validateElicitationAnswer([email], { e: `${"x".repeat(65)}@example.com` }).ok).toBe(true);
  });
});

describe("validateElicitationAnswer uri format", () => {
  const uri = normalizeOk(formRequest({
    requestedSchema: { type: "object", properties: { u: { type: "string", format: "uri" } }, required: ["u"] },
  }))[0];

  test("well-formed URIs are accepted", () => {
    for (const value of [
      "https://example.com",
      "https://example.com/",
      "https://example.com/path/to/x?q=1&r=2#frag",
      "http://user:pass@example.com:8080/p",
      "urn:isbn:0451450523",
      "mailto:someone@example.com",
      "https://example.com/a%20b",
      // IPv6 literal with port, and RFC 3986 IPvFuture.
      "https://[2001:db8::1]:8443/x",
      "https://[v1.foo]/x",
      // Empty reg-name is legal: file:///tmp/x has an empty authority.
      "file:///tmp/x",
    ]) {
      expect(validateElicitationAnswer([uri], { u: value }).ok).toBe(true);
    }
  });

  test("malformed percent-encoding is rejected", () => {
    // `new URL()` normalizes these instead of rejecting them, which is why the
    // WHATWG parser was not usable for a spec-referencing format.
    for (const value of [
      "https://example.com/%zz",
      "https://example.com/%2",
      "https://example.com/%",
      // The fragment must be percent-encoding-checked too.
      "https://example.com/#%zz",
    ]) {
      expect(validateElicitationAnswer([uri], { u: value }).ok).toBe(false);
    }
  });

  test("IRIs are rejected (that is the separate iri format)", () => {
    for (const value of [
      "https://例え.テスト",
      "https://example.com/日本語",
    ]) {
      expect(validateElicitationAnswer([uri], { u: value }).ok).toBe(false);
    }
  });

  test("structurally invalid URIs are rejected", () => {
    for (const value of [
      "example.com",          // no scheme
      "https://exa mple.com", // space in host
      "1https://example.com", // scheme must start with a letter
      "https://[not-ip]/x",   // malformed IP-literal
      "https://[:::]/x",      // not a valid IPv6 address
    ]) {
      expect(validateElicitationAnswer([uri], { u: value }).ok).toBe(false);
    }
  });

  test("an empty authority is accepted for schemes that allow it", () => {
    // Documented: `https://` is accepted by the reference validator even though
    // RFC 3986 requires a non-empty authority for hierarchical schemes.
    expect(validateElicitationAnswer([uri], { u: "https://" }).ok).toBe(true);
  });

  test("a non-numeric port is accepted by the reference validator", () => {
    // Documented deviation: the reference validator does not enforce the
    // `port = *DIGIT` production.
    expect(validateElicitationAnswer([uri], { u: "https://example.com:port/x" }).ok).toBe(true);
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

  test("lowercase t and z separators are accepted", () => {
    // RFC3339's ABNF notes that "T" and "Z" are case-insensitive.
    expect(validateElicitationAnswer([dateTime], { when: "2026-09-20t10:00:00z" }).ok).toBe(true);
    expect(validateElicitationAnswer([dateTime], { when: "2026-09-20t10:00:00Z" }).ok).toBe(true);
    expect(validateElicitationAnswer([dateTime], { when: "2026-09-20T10:00:00z" }).ok).toBe(true);
  });

  test("a real leap second is accepted", () => {
    // 2016-12-31T23:59:60Z was an actual leap-second instant.
    expect(validateElicitationAnswer([dateTime], { when: "2016-12-31T23:59:60Z" }).ok).toBe(true);
  });

  test("a leap second on a June date that never had one is rejected", () => {
    // Regression: the table wrongly listed 1973-06-30 .. 1979-06-30. RFC 3339
    // Appendix D puts those leap seconds on December 31, so accepting
    // 1973-06-30T23:59:60Z would validate a timestamp that never existed.
    for (const bogus of ["1973-06-30", "1974-06-30", "1975-06-30", "1976-06-30", "1977-06-30", "1978-06-30", "1979-06-30"]) {
      expect(validateElicitationAnswer([dateTime], { when: `${bogus}T23:59:60Z` }).ok).toBe(false);
    }
  });

  test("the matching December leap seconds are accepted", () => {
    for (const real of ["1972-12-31", "1973-12-31", "1974-12-31", "1979-12-31"]) {
      expect(validateElicitationAnswer([dateTime], { when: `${real}T23:59:60Z` }).ok).toBe(true);
    }
    // 1972-06-30 IS a real June leap second (the first one).
    expect(validateElicitationAnswer([dateTime], { when: "1972-06-30T23:59:60Z" }).ok).toBe(true);
  });

  test("a non-UTC offset may express the same leap second (RFC's own example)", () => {
    // RFC 3339 §5.7 gives exactly this example: 1990-12-31T15:59:60-08:00 is
    // the same instant as 1990-12-31T23:59:60Z.
    expect(validateElicitationAnswer([dateTime], { when: "1990-12-31T15:59:60-08:00" }).ok).toBe(true);
    expect(validateElicitationAnswer([dateTime], { when: "1990-12-31T23:59:60Z" }).ok).toBe(true);
  });

  test("an offset that does not land on the leap minute is rejected", () => {
    // 1990-12-31T15:59:60+08:00 is UTC 07:59:60, not the leap instant.
    expect(validateElicitationAnswer([dateTime], { when: "1990-12-31T15:59:60+08:00" }).ok).toBe(false);
    // An offset that lands on the leap minute from a DIFFERENT local date is
    // still the same real leap second, so it is valid.
    expect(validateElicitationAnswer([dateTime], { when: "1991-01-01T07:59:60+08:00" }).ok).toBe(true);
    // ...but an offset landing on a non-leap date's 23:59 UTC is not.
    expect(validateElicitationAnswer([dateTime], { when: "1990-12-30T15:59:60-08:00" }).ok).toBe(false);
  });

  test("a leap second at an arbitrary minute is rejected", () => {
    // Regression: the old check only enforced seconds <= 60, so
    // 2026-09-20T12:34:60Z passed. :60 is only valid at the leap minute.
    expect(validateElicitationAnswer([dateTime], { when: "2026-09-20T12:34:60Z" }).ok).toBe(false);
    expect(validateElicitationAnswer([dateTime], { when: "2026-09-20T23:59:60Z" }).ok).toBe(false);
  });

  test("an out-of-range offset is rejected even on a leap second", () => {
    // Regression: the leap-second branch returned before the offset range
    // check, so `+24:00` shifted the instant onto a real leap date and passed.
    // RFC 3339's time-numoffset uses time-hour 00-23 / time-minute 00-59.
    expect(validateElicitationAnswer([dateTime], { when: "1973-01-01T23:59:60+24:00" }).ok).toBe(false);
    expect(validateElicitationAnswer([dateTime], { when: "1973-01-01T23:59:60+23:60" }).ok).toBe(false);
    expect(validateElicitationAnswer([dateTime], { when: "1973-01-01T23:59:60-24:00" }).ok).toBe(false);
  });

  test("a leap second with an in-range offset still resolves", () => {
    // The fix must not over-correct: a legal offset expressing the real instant
    // keeps working.
    expect(validateElicitationAnswer([dateTime], { when: "1990-12-31T15:59:60-08:00" }).ok).toBe(true);
    expect(validateElicitationAnswer([dateTime], { when: "1991-01-01T07:59:60+08:00" }).ok).toBe(true);
  });

  test("a two-digit year cannot borrow a real leap date", () => {
    // Regression: `toUtcLeapInstant` used `Date.UTC(y, m-1, d)`, and that
    // constructor maps years 0..99 to 1900+. So `0072-06-30T23:59:60Z` was
    // evaluated as 1972-06-30 — a real leap date — and passed. No leap second
    // exists below 1972, and a zero-padded year must be read literally.
    expect(validateElicitationAnswer([dateTime], { when: "0072-06-30T23:59:60Z" }).ok).toBe(false);
    expect(validateElicitationAnswer([dateTime], { when: "0072-12-31T23:59:60Z" }).ok).toBe(false);
    // Year 1971 is a real calendar year one step before the first leap second.
    expect(validateElicitationAnswer([dateTime], { when: "1971-12-31T23:59:60Z" }).ok).toBe(false);
    // ...and the real 1972 leap date still validates, proving the guard did not
    // simply reject everything old.
    expect(validateElicitationAnswer([dateTime], { when: "1972-06-30T23:59:60Z" }).ok).toBe(true);
  });

  test("a two-digit year cannot borrow a leap date through an offset", () => {
    // Same trap via the offset path: the local wall clock of year 0072 shifts
    // onto 1971-12-31/1972-01-01 UTC. Both are non-leap instants for year 72,
    // but the legacy mapping made the shifted date 1972's.
    expect(validateElicitationAnswer([dateTime], { when: "0073-01-01T07:59:60+08:00" }).ok).toBe(false);
    expect(validateElicitationAnswer([dateTime], { when: "0072-12-31T15:59:60-08:00" }).ok).toBe(false);
  });

  test("a leap second still resolves when the offset crosses a month boundary", () => {
    // Guards the pure-arithmetic date shift: 1990-12-31 15:59:60 -08:00 is
    // 1990-12-31 23:59:60 UTC, and shifting beyond +23:59 must not desynchronise
    // the calendar.
    expect(validateElicitationAnswer([dateTime], { when: "1991-01-01T00:59:60+01:00" }).ok).toBe(true);
    expect(validateElicitationAnswer([dateTime], { when: "1990-12-31T14:59:60-09:00" }).ok).toBe(true);
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
