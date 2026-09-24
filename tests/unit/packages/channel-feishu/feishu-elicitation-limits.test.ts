import { beforeAll, expect, test } from "bun:test";

import {
  checkElicitationRenderability,
  FEISHU_CARD_ELEMENTS_MAX,
  FEISHU_INPUT_MAX_LENGTH,
  FEISHU_SELECT_OPTION_MAX,
  FEISHU_TEXT_CONTENT_MAX,
  FEISHU_UNDOCUMENTED_LIMITS,
  fitsCardBudget,
} from "../../../../packages/channel-feishu/src/elicitation-limits";
import {
  buildElicitationOpeningCard,
  buildWorstCaseReviewCard,
} from "../../../../packages/channel-feishu/src/elicitation-cards";
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

// A declared `maxLength` is REQUIRED to render: the gate refuses a text field
// without one, because the accepted answer domain is then unbounded and an input
// cannot express that. Core only validates the bound when it is present, so
// "absent" means larger than the platform's capacity, not "no limit".
const TEXT: ChannelElicitationField = { kind: "text", key: "note", title: "Note", required: true, maxLength: 1000 };

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

// --- Both sides of the capture capacity bound ------------------------------

test("a text minLength beyond one input's capacity is refused", () => {
  // The other half of the maxLength check that already existed: a field that
  // REQUIRES more characters than the input can hold is impossible, and
  // truncating it silently would produce an answer core must reject anyway.
  // `maxLength` is declared so the field reaches the min-bound check rather
  // than being refused earlier for having no bound at all.
  const verdict = checkElicitationRenderability([
    { kind: "text", key: "note", title: "Note", required: true, minLength: 1001, maxLength: 2000 },
  ]);
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("answer-too-long");
});

test("a text field with no maxLength is refused, not narrowed to a default", () => {
  // `maxLengthFor` used to default the widget to 1000, which silently redefined
  // the agent's question as "at most 1000 chars" while the schema's accepted
  // domain was unbounded. Core validates the bound only when present, so absent
  // strictly means LARGER than one input can capture.
  const verdict = checkElicitationRenderability([
    { kind: "text", key: "note", title: "Note", required: false },
  ]);
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("answer-unbounded");
  expect(verdict.detail).toContain("no maxLength");
  // A declared bound inside the platform capacity still renders.
  expect(checkElicitationRenderability([
    { kind: "text", key: "note", title: "Note", required: false, maxLength: 1000 },
  ]).renderable).toBe(true);
  // A declared bound past it is still the explicit-capacity refusal.
  expect(checkElicitationRenderability([
    { kind: "text", key: "note", title: "Note", required: false, maxLength: 1001 },
  ]).reason).toBe("answer-too-long");
});

test("an option core would reject is refused rather than offered", () => {
  const verdict = checkElicitationRenderability([
    {
      kind: "single-select",
      key: "env",
      title: "Pick",
      required: true,
      minLength: 2,
      options: [{ value: "a", label: "A" }, { value: "bb", label: "BB" }],
    },
  ]);
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("option-constraint-unsatisfiable");
});

test("a select whose options all satisfy the constraints is accepted", () => {
  const verdict = checkElicitationRenderability([
    {
      kind: "single-select",
      key: "env",
      title: "Pick",
      required: true,
      minLength: 2,
      options: [{ value: "bb", label: "BB" }],
    },
  ]);
  expect(verdict.renderable).toBe(true);
});

test("a boolean field is renderable, because it renders as a two-option select", () => {
  const verdict = checkElicitationRenderability([
    { kind: "boolean", key: "ok", title: "OK", required: true },
  ]);
  expect(verdict.renderable).toBe(true);
});

test("the card JSON budget is measured in serialized BYTES, not source chars", () => {
  // The declared 30 KB ceiling was never actually enforced against a built card,
  // so a form could pass the field-level gate and then have `card.update` fail
  // on the review page — after the user filled the whole form in. Both
  // directions are pinned here: an over-budget worst case is refused, and a
  // normal form is left alone.
  const big: ChannelElicitationField[] = Array.from({ length: 40 }, (_, index) => ({
    kind: "text",
    key: `k${String(index).padStart(2, "0")}`,
    title: `T${index}`,
    required: false,
    maxLength: FEISHU_INPUT_MAX_LENGTH,
  }));
  const worst = buildWorstCaseReviewCard(
    { requestId: "r", chatKey: "cx", agent: { name: "codex" }, fields: big, requester: { senderId: "ou" } } as never,
    "a".repeat(32),
  );
  const verdict = fitsCardBudget(worst);
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("card-too-large");
  expect(verdict.detail).toContain("limit 30720");

  const small = fitsCardBudget(
    buildWorstCaseReviewCard(
      {
        requestId: "r",
        chatKey: "cx",
        agent: { name: "codex" },
        fields: [{ kind: "text", key: "a", title: "A", required: false, maxLength: 100 }],
        requester: { senderId: "ou" },
      } as never,
      "a".repeat(32),
    ),
  );
  expect(small.renderable).toBe(true);
});

test("escaping a high-expansion question is bounded in escaped space", () => {
  // Truncating the RAW text and escaping afterwards destroyed the question: 100
  // legal `<` expand to 500 chars, and the old raw bound cut the result back down
  // so the user read a mangled fragment instead of the agent's text. The visible
  // entities must now all be present.
  const message = `Choose: ${"<".repeat(100)}END`;
  const card = buildElicitationOpeningCard(
    {
      requestId: "r",
      chatKey: "cx",
      agent: { name: "codex" },
      message,
      fields: [],
      requester: { senderId: "ou" },
    } as never,
    "a".repeat(32),
  );
  const elements = (card.body as { elements: Array<{ content?: string }> }).elements;
  const rendered = elements.map((element) => element.content ?? "").join("\n");
  // Every one of the 100 characters survived, and the tail is intact.
  expect((rendered.match(/&#60;/g) ?? []).length).toBe(100);
  // Checked on the element that carries the message, not the joined card body:
  // the opening card also renders an empty-trailing element set, so a
  // `endsWith` on the join would see a trailing newline instead of the message.
  expect(rendered.trimEnd().endsWith("END")).toBe(true);
  // And it is escaped exactly ONCE: a double escape renders the literal text
  // "amp;#60;" to the user.
  expect(rendered).not.toContain("amp;#60;");
});
