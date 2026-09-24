import { beforeAll, expect, test } from "bun:test";

import {
  checkElicitationCardTextRenderability,
  checkElicitationRenderability,
  escapedLength,
  FEISHU_CARD_BODY_MAX_CHARS,
  FEISHU_CARD_ELEMENTS_MAX,
  FEISHU_INPUT_MAX_LENGTH,
  FEISHU_SELECT_OPTION_MAX,
  FEISHU_TEXT_CONTENT_MAX,
  FEISHU_UNDOCUMENTED_LIMITS,
  fitsCardBudget,
  measureElicitationCardBytes,
} from "../../../../packages/channel-feishu/src/elicitation-limits";
import {
  buildElicitationOpeningCard,
  buildElicitationReviewCard,
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
  // Refused on the RAW side too: a label past the bound is refused whatever it
  // is made of, so a plain-ASCII over-long label still fails here.
  const verdict = checkElicitationRenderability([{
    ...SINGLE,
    options: [{ value: "v", label: "L".repeat(FEISHU_TEXT_CONTENT_MAX + 1) }],
  }]);
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("select-option-label-too-long");
  // The detail names both measurements, so a reader can see that the bound is
  // applied to the escaped form the component actually receives.
  expect(verdict.detail).toContain("101 chars raw");
  expect(verdict.detail).toContain("101 escaped");
});

test("an option label that is legal raw but too long ESCAPED is refused, not clipped", () => {
  // The BUG this closes: the gate used to judge the option label by RAW length.
  // 100 `<` is exactly at the 100-char bound, so it passed, then `plainText`
  // escaped it to 500 chars and `boundRendered` cut it back to 100 — the user
  // read a mangled fragment of entity codes instead of the agent's label.
  // The label is the question, so a label that cannot be shown in full refuses
  // the form.
  const verdict = checkElicitationRenderability([{
    ...SINGLE,
    options: [{ value: "v", label: "<".repeat(FEISHU_TEXT_CONTENT_MAX) }],
  }]);
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("select-option-label-too-long");
  // The detail states BOTH lengths, so an operator can see why a label that
  // measured exactly at the raw bound was still refused.
  expect(verdict.detail).toContain(`${FEISHU_TEXT_CONTENT_MAX} chars raw`);
  expect(verdict.detail).toContain("500 escaped");
  expect(verdict.detail).toContain("limit 100 escaped");
});

test("an option label at the escaped boundary still renders", () => {
  // The other half of the same bound: a label whose ESCAPED length is exactly
  // the budget must render, so the refusal is about the escaped size rather
  // than about containing an escapable character at all.
  expect(checkElicitationRenderability([{
    ...SINGLE,
    options: [{ value: "v", label: "<".repeat(FEISHU_TEXT_CONTENT_MAX / 5) }],
  }]).renderable).toBe(true);
  // A short ASCII label — the ordinary case — is untouched.
  expect(checkElicitationRenderability([SINGLE]).renderable).toBe(true);
});

test("a field title is judged by its ESCAPED length, because it becomes input.label", () => {
  // The field title is the question twice over: the field card's bold heading
  // AND the `input`'s `label`. Both render the ESCAPED form, so the bound is
  // applied there — 21 `<` is 21 raw chars but 105 escaped, past the 100 bound.
  const overEscaped = checkElicitationRenderability([
    { kind: "text", key: "note", title: "<".repeat(21), required: true, maxLength: 10 },
  ]);
  expect(overEscaped.renderable).toBe(false);
  expect(overEscaped.reason).toBe("field-label-too-long");
  expect(overEscaped.detail).toContain("21 chars raw");
  expect(overEscaped.detail).toContain("105 escaped");
  // The boundary itself renders: 20 `<` is exactly 100 escaped.
  expect(checkElicitationRenderability([
    { kind: "text", key: "note", title: "<".repeat(20), required: true, maxLength: 10 },
  ]).renderable).toBe(true);
  // And the raw side is still refused, exactly as before.
  expect(checkElicitationRenderability([
    { kind: "text", key: "note", title: "N".repeat(FEISHU_TEXT_CONTENT_MAX + 1), required: true, maxLength: 10 },
  ]).reason).toBe("field-label-too-long");
});

test("escapedLength measures what the component budget applies to", () => {
  // Pinned so the gate cannot silently revert to raw lengths: the measurement
  // itself is the contract.
  expect(escapedLength("Production")).toBe(10);
  expect(escapedLength("<")).toBe(5);
  // `~` and `|` are the widest expansions, at 6x.
  expect(escapedLength("~")).toBe(6);
  expect(escapedLength("|")).toBe(6);
  expect(escapedLength("<".repeat(100))).toBe(500);
  expect(escapedLength("~".repeat(1000))).toBe(6000);
});

test("an opening-card message too large to show faithfully is refused before anything is sent", () => {
  // The opening card renders `message` as a markdown component whose content is
  // the ESCAPED text, bounded by FEISHU_CARD_BODY_MAX_CHARS. That bound used to
  // be enforced only by `boundRendered` — the cut. 8000 `<` expand to 40,000
  // escaped chars and were cut back to 28,000, so the user saw a fragment of
  // entity codes and none of the characters the agent sent.
  const verdict = checkElicitationRenderability([], { message: "<".repeat(8000) });
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("card-text-too-large");
  expect(verdict.detail).toContain("8000 chars raw");
  expect(verdict.detail).toContain("40000 escaped");
  expect(verdict.detail).toContain(`limit ${FEISHU_CARD_BODY_MAX_CHARS} escaped`);

  // The same request text is refused whichever entry point is used, so the
  // renderer can call either.
  expect(checkElicitationCardTextRenderability({ message: "<".repeat(8000) }).renderable).toBe(false);

  // A message that FITS is accepted, so the refusal is about size, not about
  // the message existing.
  expect(checkElicitationCardTextRenderability({ message: "Which environment?" }).renderable).toBe(true);
  expect(checkElicitationCardTextRenderability({}).renderable).toBe(true);
});

test("a message that fits after escaping renders even when it is most of the raw budget", () => {
  // `"~"` expands 6x, so the largest raw message that still fits is the budget
  // divided by 6 — this pins that the bound is applied to the escaped form and
  // not to the raw one.
  const rawLimit = Math.floor(FEISHU_CARD_BODY_MAX_CHARS / 6);
  expect(checkElicitationCardTextRenderability({ message: "~".repeat(rawLimit) }).renderable).toBe(true);
  const overByOne = checkElicitationCardTextRenderability({ message: "~".repeat(rawLimit + 1) });
  expect(overByOne.renderable).toBe(false);
  expect(overByOne.reason).toBe("card-text-too-large");
  // A raw-length message of the same size in ASCII is fine: the difference IS
  // the escaping, which is what the bug was.
  expect(checkElicitationCardTextRenderability({ message: "a".repeat(rawLimit + 1) }).renderable).toBe(true);
});

test("schema title and description are gated too, not just the message", () => {
  // The opening card renders both as their own markdown components, so a title
  // the card cannot show faithfully refuses the form exactly as a message does.
  const title = checkElicitationCardTextRenderability({ schemaTitle: "<".repeat(8000) });
  expect(title.renderable).toBe(false);
  expect(title.reason).toBe("card-text-too-large");
  expect(title.detail).toContain("schemaTitle");
  const description = checkElicitationCardTextRenderability({ schemaDescription: "<".repeat(8000) });
  expect(description.renderable).toBe(false);
  expect(description.detail).toContain("schemaDescription");
});

test("the request-text gate runs after the field gate, so a structural refusal stays the reported cause", () => {
  // Ordering is deliberate: a multi-select is impossible on this platform
  // regardless of the message, and reporting the long message first would hide
  // the decisive cause from the log.
  const verdict = checkElicitationRenderability(
    [{ kind: "multi-select", key: "t", title: "T", required: true, options: [{ value: "a", label: "A" }] }],
    { message: "<".repeat(8000) },
  );
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("multi-select-unsupported");
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
  // The description is rendered escaped too, so the bound applies to the escaped
  // form; the detail reports both so the refusal is legible.
  expect(verdict.detail).toContain("28001 chars raw");
  expect(verdict.detail).toContain("28001 escaped");
  // A description that fits raw but not escaped is refused as well.
  const escapedOver = checkElicitationRenderability([{ ...TEXT, description: "~".repeat(4_667) }]);
  expect(escapedOver.renderable).toBe(false);
  expect(escapedOver.reason).toBe("field-description-too-long");
  expect(escapedOver.detail).toContain("28002 escaped");
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

test("the worst-case review card is sized for the WORST escape, not the friendliest one", () => {
  // The estimate used to be `"x".repeat(maxLength)` — a 1x character. A real
  // answer of 1000 `~` expands 6x, so the sample was 6x optimistic: the gate
  // blessed a card the review page would then overflow, and `card.update`
  // failed after the user had filled the whole form in. The sample is now built
  // from the highest-expansion character the escaper writes, measured through
  // the escaper itself.
  const fields: ChannelElicitationField[] = [
    { kind: "text", key: "a", title: "A", required: false, maxLength: 1000 },
  ];
  const request = {
    requestId: "r",
    chatKey: "cx",
    agent: { name: "codex" },
    fields,
    requester: { senderId: "ou" },
  } as never;
  const worst = buildWorstCaseReviewCard(request, "a".repeat(32));
  const worstBytes = measureElicitationCardBytes(worst);

  // The concrete number, so a regression back to the optimistic sample is
  // visible as a byte count rather than as a card that only fails in production.
  expect(worstBytes).toBe(7159);

  // THE invariant: the estimate must DOMINATE the real card a user can produce.
  // A maximal-expansion answer (`~` expands 6x) is the largest answer the field
  // can legally hold, so the worst-case card must be at least that big — the old
  // `"x"` sample was not, which is exactly the optimism being closed.
  const maximalAnswer = buildElicitationReviewCard(request, "a".repeat(32), { a: "~".repeat(1000) } as never);
  expect(measureElicitationCardBytes(worst)).toBeGreaterThanOrEqual(measureElicitationCardBytes(maximalAnswer));

  // And the payload itself, not just the card envelope: the sample's answer
  // must be the widest escape of a full-length answer, not a 1x character. Each
  // of the 1000 characters is present and escaped as a 6-char entity, so the
  // rendered answer is 6,000 chars — the largest a legal answer can be.
  const body = worst.body;
  const elements: unknown[] = typeof body === "object" && body !== null && "elements" in body
    ? (body.elements as unknown[])
    : [];
  const answerElement = elements.find(
    (element) =>
      typeof element === "object" && element !== null && "content" in element &&
      typeof (element as { content: unknown }).content === "string" &&
      (element as { content: string }).content.includes("&#126;"),
  ) as { content: string } | undefined;
  expect(answerElement?.content?.match(/&#126;/g)?.length).toBe(1000);
  expect(answerElement?.content?.length).toBeGreaterThanOrEqual(6_000);

  // The friendly sample the old code produced, for contrast: same card, 1x
  // escape. The gap IS the bug.
  const friendly = measureElicitationCardBytes(
    buildElicitationReviewCard(request, "a".repeat(32), { a: "x".repeat(1000) } as never),
  );
  expect(friendly).toBe(2159);
  expect(worstBytes).toBeGreaterThan(friendly * 3);
});

test("the worst-case select sample is the widest DISPLAYED VALUE, not the widest label", () => {
  // The review card renders `displayValue(value)`, so sizing by the longest
  // LABEL picks the wrong option: a label-heavy option with a short value
  // produced an estimate that had nothing to do with the review page. The label
  // is display text; the VALUE is what the review card shows.
  const fields: ChannelElicitationField[] = [{
    kind: "single-select",
    key: "s",
    title: "S",
    required: false,
    options: [
      { value: "prod", label: "A".repeat(90) },
      { value: "~".repeat(90), label: "b" },
    ],
  }];
  const request = {
    requestId: "r",
    chatKey: "cx",
    agent: { name: "codex" },
    fields,
    requester: { senderId: "ou" },
  } as never;
  const worst = measureElicitationCardBytes(buildWorstCaseReviewCard(request, "a".repeat(32)));
  const labelPicked = measureElicitationCardBytes(
    buildElicitationReviewCard(request, "a".repeat(32), { s: "prod" } as never),
  );
  // The value-driven sample is strictly larger than the label-driven one, which
  // is the whole point: the old choice under-reported the real card.
  expect(worst).toBe(1699);
  expect(worst).toBeGreaterThan(labelPicked);
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
