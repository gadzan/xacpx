import { beforeAll, expect, test } from "bun:test";

import {
  checkElicitationRenderability,
  FEISHU_CARD_ELEMENTS_MAX,
  FEISHU_INPUT_MAX_LENGTH,
  FEISHU_SELECT_OPTION_MAX,
  FEISHU_TEXT_CONTENT_MAX,
  FEISHU_UNDOCUMENTED_LIMITS,
} from "../../../../packages/channel-feishu/src/elicitation-limits";
import type { ChannelElicitationField } from "xacpx/plugin-api";
import { formComponentName, cardElementId } from "../../../../packages/channel-feishu/src/elicitation-state";
import { setChannelLocale } from "../../../../packages/channel-feishu/src/i18n/index";

/**
 * The Feishu renderability gate.
 *
 * Same contract as Discord's: a form the platform cannot express faithfully is
 * refused whole, never reshaped into a different question.
 */
beforeAll(() => {
  setChannelLocale("en");
});

const TEXT: ChannelElicitationField = { kind: "text", key: "note", title: "Note", required: true };

const SINGLE: ChannelElicitationField = {
  kind: "single-select",
  key: "env",
  title: "Environment",
  required: true,
  options: [
    { value: "prod", label: "Production" },
    { value: "staging", label: "Staging" },
  ],
};

test("a small mixed form of supported kinds renders", () => {
  expect(checkElicitationRenderability([TEXT, SINGLE, { kind: "boolean", key: "b", title: "B", required: true }])
    .renderable).toBe(true);
});

test("multi-select is refused: Feishu cards have no multi-select component", () => {
  const verdict = checkElicitationRenderability([
    { kind: "multi-select", key: "t", title: "T", required: true, options: [{ value: "a", label: "A" }] },
  ]);
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("multi-select-unsupported");
  // The decisive cause is named, and the field key is in the detail.
  expect(verdict.detail).toContain("multi-select");
  expect(verdict.detail).toContain('"t"');
});

test("a multi-select is refused even when its options would fit", () => {
  // The refusal is structural, not about size: two options are trivially
  // renderable on any platform that HAS a multi-select. Feishu does not.
  const verdict = checkElicitationRenderability([
    {
      kind: "multi-select",
      key: "t",
      title: "T",
      required: true,
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    },
  ]);
  expect(verdict.renderable).toBe(false);
});

test("more select options than the renderer budget allows is refused, not truncated", () => {
  const verdict = checkElicitationRenderability([{
    ...SINGLE,
    options: Array.from({ length: FEISHU_SELECT_OPTION_MAX + 1 }, (_, i) => ({ value: `v${i}`, label: `O${i}` })),
  }]);
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("select-option-count");
  // The number is the actual count, not the limit, so the log names the cause.
  expect(verdict.detail).toContain(String(FEISHU_SELECT_OPTION_MAX + 1));
});

test("the option limit boundary itself still renders", () => {
  const verdict = checkElicitationRenderability([{
    ...SINGLE,
    options: Array.from({ length: FEISHU_SELECT_OPTION_MAX }, (_, i) => ({ value: `v${i}`, label: `O${i}` })),
  }]);
  expect(verdict.renderable).toBe(true);
});

test("an over-long option label is refused rather than clipped", () => {
  const verdict = checkElicitationRenderability([{
    ...SINGLE,
    options: [{ value: "v", label: "L".repeat(FEISHU_TEXT_CONTENT_MAX + 1) }],
  }]);
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("select-option-label-too-long");
});

test("an empty select is refused before it becomes an empty Feishu select", () => {
  const verdict = checkElicitationRenderability([{ ...SINGLE, options: [] }]);
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("empty-select");
});

test("an answer longer than one input can capture is refused", () => {
  // Cliff at FEISHU_INPUT_MAX_LENGTH + 1: at exactly the cap it still renders.
  expect(checkElicitationRenderability([{ ...TEXT, maxLength: FEISHU_INPUT_MAX_LENGTH }]).renderable).toBe(true);
  const verdict = checkElicitationRenderability([{ ...TEXT, maxLength: FEISHU_INPUT_MAX_LENGTH + 1 }]);
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("answer-too-long");
});

test("a description that cannot fit the card body is refused", () => {
  const verdict = checkElicitationRenderability([{ ...TEXT, description: "d".repeat(28_001) }]);
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("field-description-too-long");
});

test("the element ceiling is a real documented Feishu number, not a policy guess", () => {
  // Feishu rejects >200 components with error 300305.
  expect(FEISHU_CARD_ELEMENTS_MAX).toBe(200);
});

test("undocumented limits are disclosed rather than invented", () => {
  // The gate must say which numbers are Feishu's and which are the renderer's
  // own policy, so a future platform change is auditable.
  const joined = FEISHU_UNDOCUMENTED_LIMITS.join(" ");
  expect(joined).toContain("select_static");
  expect(joined).toContain("button count");
  expect(joined).toContain("behaviors");
});

test("formComponentName is positional, so a hostile key cannot break it", () => {
  // Feishu requires a non-empty, card-unique name per interactive component in a
  // form. A schema key is not a safe source — `env.prod`, `a/b`, a key of only
  // punctuation and a 128-char key are all legal JSON property names — so the
  // name is derived from POSITION instead.
  const fields: ChannelElicitationField[] = [
    { kind: "text", key: "env", title: "Env", required: true },
    { kind: "text", key: "a/b", title: "Slash", required: true },
    { kind: "text", key: "---", title: "Punct", required: true },
    { kind: "text", key: "k".repeat(128), title: "Long", required: true },
  ];
  expect(formComponentName("env", fields)).toBe("f0");
  expect(formComponentName("a/b", fields)).toBe("f1");
  expect(formComponentName("---", fields)).toBe("f2");
  expect(formComponentName("k".repeat(128), fields)).toBe("f3");
  // Unique per field, which is what the platform rule demands.
  const names = fields.map((f) => formComponentName(f.key, fields));
  expect(new Set(names).size).toBe(fields.length);
  // A key that is not in the request yields nothing rather than a guessed name.
  expect(formComponentName("absent", fields)).toBeNull();
});

test("cardElementId satisfies Feishu's element_id charset", () => {
  expect(cardElementId("abc")).toBe("abc");
  // Must start with a letter and stay within 20 chars.
  expect(cardElementId("9lives")).toBe("el9lives");
  expect(cardElementId("x".repeat(30)).length).toBeLessThanOrEqual(20);
});
