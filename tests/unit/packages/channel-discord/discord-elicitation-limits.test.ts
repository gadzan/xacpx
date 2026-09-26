import { expect, test } from "bun:test";

import {
  checkElicitationRenderability,
  DISCORD_SELECT_OPTION_COUNT_MAX,
  DISCORD_TEXT_INPUT_LABEL_MAX,
  buildElicitationFieldLines,
  escapeDiscordLiteralText,
  FIELD_CARD_ANSWER_ECHO_MAX,
} from "../../../../packages/channel-discord/src/elicitation-limits";
import type { ChannelElicitationField, ChannelElicitationRequest } from "xacpx/plugin-api";
import { escapeDiscordLiteralText } from "../../../../packages/channel-discord/src/permission-ui";

/** A request the gate can measure the field cards against. */
function requestFor(fields: readonly ChannelElicitationField[]): ChannelElicitationRequest {
  return {
    requestId: "r",
    chatKey: "discord:default:dm:c1",
    chatType: "direct",
    requester: { senderId: "user-A" },
    agent: { name: "codex" },
    message: "m",
    mode: "form",
    fields,
    expiresAt: Date.now() + 60_000,
    signal: new AbortController().signal,
  };
}

function text(key: string, title = "What is the target?"): ChannelElicitationField {
  // A declared `maxLength`: the renderability gate refuses a text field that
  // omits it, because an unbounded answer domain cannot be expressed by a
  // modal input. Core treats the bound as optional and only validates it when
  // present, so "absent" means "larger than the widget" — not "no limit".
  return { kind: "text", key, title, required: true, maxLength: 4000 };
}

function single(key: string, count: number): ChannelElicitationField {
  return {
    kind: "single-select",
    key,
    title: "Pick one",
    required: true,
    options: Array.from({ length: count }, (_, index) => ({
      value: `v${index}`,
      label: `Option ${index}`,
    })),
  };
}

test("a small mixed form renders", () => {
  const verdict = checkElicitationRenderability([
    text("target"),
    { kind: "boolean", key: "confirm", title: "Confirm?", required: true },
    single("env", 3),
    {
      kind: "multi-select",
      key: "tags",
      title: "Tags",
      required: false,
      minItems: 1,
      maxItems: 3,
      options: [
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
      ],
    },
    { kind: "number", key: "count", title: "How many?", required: false },
    { kind: "integer", key: "retries", title: "Retries", required: false },
    { kind: "date", key: "when", title: "When", required: false },
    { kind: "date-time", key: "exact", title: "Exact time", required: false },
    { kind: "email", key: "mail", title: "Email", required: false },
    { kind: "uri", key: "site", title: "Site", required: false },
  ], requestFor([
    text("target"),
    { kind: "boolean", key: "confirm", title: "Confirm?", required: true },
    single("env", 3),
    {
      kind: "multi-select",
      key: "tags",
      title: "Tags",
      required: false,
      minItems: 1,
      maxItems: 3,
      options: [
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
      ],
    },
    { kind: "number", key: "count", title: "How many?", required: false },
    { kind: "integer", key: "retries", title: "Retries", required: false },
    { kind: "date", key: "when", title: "When", required: false },
    { kind: "date-time", key: "exact", title: "Exact time", required: false },
    { kind: "email", key: "mail", title: "Email", required: false },
    { kind: "uri", key: "site", title: "Site", required: false },
  ]));
  expect(verdict.renderable).toBe(true);
  expect(verdict.reason).toBeUndefined();
});

test("a select over the platform option limit is rejected, not truncated", () => {
  const verdict = checkElicitationRenderability([single("env", DISCORD_SELECT_OPTION_COUNT_MAX + 1)], requestFor([single("env", DISCORD_SELECT_OPTION_COUNT_MAX + 1)]));
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("select-option-count");
  // The detail carries the decisive cause and no answer text.
  expect(verdict.detail).toContain("26");
  expect(verdict.detail).toContain('"env"');
});

test("a select at exactly the platform option limit still renders", () => {
  expect(checkElicitationRenderability([single("env", DISCORD_SELECT_OPTION_COUNT_MAX)], requestFor([single("env", DISCORD_SELECT_OPTION_COUNT_MAX)])).renderable).toBe(true);
});

test("an option label over 100 chars is rejected as a different option, not a clipped one", () => {
  const verdict = checkElicitationRenderability([single("env", 1)], requestFor([single("env", 1)]));
  const longer: ChannelElicitationField = {
    kind: "single-select",
    key: "env",
    title: "Pick one",
    required: true,
    options: [{ value: "x", label: "L".repeat(101) }],
  };
  expect(verdict.renderable).toBe(true);
  expect(checkElicitationRenderability([longer], requestFor([longer])).renderable).toBe(false);
  expect(checkElicitationRenderability([longer], requestFor([longer])).reason).toBe("select-option-label-too-long");
});

test("an option value over 100 chars is rejected", () => {
  const verdict = checkElicitationRenderability([
    {
      kind: "single-select",
      key: "env",
      title: "Pick one",
      required: true,
      options: [{ value: "v".repeat(101), label: "V" }],
    },
  ], requestFor([
    {
      kind: "single-select",
      key: "env",
      title: "Pick one",
      required: true,
      options: [{ value: "v".repeat(101), label: "V" }],
    },
  ]));
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("select-option-value-too-long");
});

test("an option description over 100 chars is rejected", () => {
  const verdict = checkElicitationRenderability([
    single("env", 1),
  ], requestFor([
    single("env", 1),
  ]));
  expect(verdict.renderable).toBe(true);
  const withDescription = checkElicitationRenderability([
    {
      kind: "single-select",
      key: "env",
      title: "Pick one",
      required: true,
      options: [{ value: "v", label: "V", description: "d".repeat(101) }],
    },
  ], requestFor([
    {
      kind: "single-select",
      key: "env",
      title: "Pick one",
      required: true,
      options: [{ value: "v", label: "V", description: "d".repeat(101) }],
    },
  ]));
  expect(withDescription.renderable).toBe(false);
  expect(withDescription.reason).toBe("select-option-description-too-long");
});

test("a modal label over 45 chars is rejected: a clipped label is a different question", () => {
  const verdict = checkElicitationRenderability([text("target", "W".repeat(DISCORD_TEXT_INPUT_LABEL_MAX + 1))], requestFor([text("target", "W".repeat(DISCORD_TEXT_INPUT_LABEL_MAX + 1))]));
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("field-label-too-long");
  expect(verdict.detail).toContain("46");
});

test("a modal label at exactly 45 chars still renders", () => {
  expect(checkElicitationRenderability([text("target", "W".repeat(DISCORD_TEXT_INPUT_LABEL_MAX))], requestFor([text("target", "W".repeat(DISCORD_TEXT_INPUT_LABEL_MAX))])).renderable).toBe(true);
});

test("a multi-select whose min/max demand exceeds the platform is rejected", () => {
  const verdict = checkElicitationRenderability([
    {
      kind: "multi-select",
      key: "tags",
      title: "Tags",
      required: true,
      minItems: 30,
      maxItems: 40,
      options: Array.from({ length: 25 }, (_, index) => ({ value: `v${index}`, label: `O${index}` })),
    },
  ], requestFor([
    {
      kind: "multi-select",
      key: "tags",
      title: "Tags",
      required: true,
      minItems: 30,
      maxItems: 40,
      options: Array.from({ length: 25 }, (_, index) => ({ value: `v${index}`, label: `O${index}` })),
    },
  ]));
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("select-min-max-out-of-range");
});

test("a select with zero options is rejected before it becomes an empty Discord select", () => {
  const verdict = checkElicitationRenderability([
    { kind: "single-select", key: "env", title: "Pick one", required: true, options: [] },
  ], requestFor([
    { kind: "single-select", key: "env", title: "Pick one", required: true, options: [] },
  ]));
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("empty-select");
});

// --- Platform capacity vs the schema's own constraints ---------------------
//
// Core keeps minLength/maxLength on the field, so the renderer must NOT clamp
// them: a bound past what the user can actually type makes the field either
// impossible or unsubmittable, and silently narrowing it changes the question.

test("a text minLength beyond the input's capacity is refused, not clamped", () => {
  const verdict = checkElicitationRenderability([
    { kind: "text", key: "note", title: "Note", required: true, minLength: 4001, maxLength: 5000 },
  ], requestFor([
    { kind: "text", key: "note", title: "Note", required: true, minLength: 4001, maxLength: 5000 },
  ]));
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("text-min-beyond-capture");
});

test("a text maxLength beyond the input's capacity is refused, not narrowed", () => {
  const verdict = checkElicitationRenderability([
    { kind: "text", key: "note", title: "Note", required: true, maxLength: 5000 },
  ], requestFor([
    { kind: "text", key: "note", title: "Note", required: true, maxLength: 5000 },
  ]));
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("text-max-beyond-capture");
});

test("a text maxLength inside the capacity is accepted and pushed to the input", () => {
  expect(checkElicitationRenderability([
    { kind: "text", key: "note", title: "Note", required: true, minLength: 1, maxLength: 1000 },
  ], requestFor([
    { kind: "text", key: "note", title: "Note", required: true, minLength: 1, maxLength: 1000 },
  ])).renderable).toBe(true);
});

test("a select title beyond the placeholder cap is refused", () => {
  // A String Select takes field.title as its placeholder, capped at 150. The
  // label check (45) is for modal Text Inputs and skips select kinds, so this
  // title was previously never checked at all.
  const verdict = checkElicitationRenderability([
    { kind: "single-select", key: "env", title: "X".repeat(151), required: true, options: [{ value: "a", label: "A" }] },
  ], requestFor([
    { kind: "single-select", key: "env", title: "X".repeat(151), required: true, options: [{ value: "a", label: "A" }] },
  ]));
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("select-placeholder-too-long");
});

test("an option core would reject is refused rather than offered", () => {
  // core applies the field's string constraints to the CHOSEN option too, so
  // this enum presents a choice that can only fail after the user makes it.
  const verdict = checkElicitationRenderability([
    {
      kind: "single-select",
      key: "env",
      title: "Pick",
      required: true,
      minLength: 2,
      options: [{ value: "a", label: "A" }, { value: "bb", label: "BB" }],
    },
  ], requestFor([
    {
      kind: "single-select",
      key: "env",
      title: "Pick",
      required: true,
      minLength: 2,
      options: [{ value: "a", label: "A" }, { value: "bb", label: "BB" }],
    },
  ]));
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("select-option-constraint-unsatisfiable");
});

test("a select whose options all satisfy the constraints is accepted", () => {
  const verdict = checkElicitationRenderability([
    {
      kind: "single-select",
      key: "env",
      title: "Pick",
      required: true,
      minLength: 2,
      options: [{ value: "bb", label: "BB" }, { value: "cc", label: "CC" }],
    },
  ], requestFor([
    {
      kind: "single-select",
      key: "env",
      title: "Pick",
      required: true,
      minLength: 2,
      options: [{ value: "bb", label: "BB" }, { value: "cc", label: "CC" }],
    },
  ]));
  expect(verdict.renderable).toBe(true);
});

test("a text field with no maxLength is refused, not narrowed to the widget's default", () => {
  // The modal used to substitute 4000 when the field omitted `maxLength`, so the
  // renderer silently redefined the agent's question as "at most 4000 chars"
  // while the schema's actual accepted domain was unbounded. Core validates the
  // bound only when it is present, so absent strictly means LARGER than 4000 —
  // an answer the agent would accept became unreachable on the platform.
  const verdict = checkElicitationRenderability([
    { kind: "text", key: "note", title: "Note", required: false },
  ], requestFor([
    { kind: "text", key: "note", title: "Note", required: false },
  ]));
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("text-unbounded");
  expect(verdict.detail).toContain("no maxLength");
  // A declared bound inside the platform capacity still renders.
  expect(checkElicitationRenderability([
    { kind: "text", key: "note", title: "Note", required: false, maxLength: 4000 },
  ], requestFor([
    { kind: "text", key: "note", title: "Note", required: false, maxLength: 4000 },
  ])).renderable).toBe(true);
  // A declared bound past it is still the explicit-capacity refusal.
  expect(checkElicitationRenderability([
    { kind: "text", key: "note", title: "Note", required: false, maxLength: 4001 },
  ], requestFor([
    { kind: "text", key: "note", title: "Note", required: false, maxLength: 4001 },
  ])).reason).toBe("text-max-beyond-capture");
});

test("a field carrying an agent pattern is refused, not rendered unconstrained", () => {
  // Core preserves `pattern` as DISPLAY metadata and never executes it. Rendered
  // as a plain input, the user types "abc" against `^[A-Z]{3}$`, the form is
  // accepted, and the agent receives an answer its own schema rejects.
  for (const fields of [
    [{ kind: "text" as const, key: "code", title: "Code", required: true, maxLength: 4000, pattern: "^[A-Z]{3}$" }],
    [{
      kind: "single-select" as const,
      key: "env",
      title: "Env",
      required: true,
      pattern: "^[a-z]+$",
      options: [{ value: "prod", label: "Prod" }],
    }],
  ]) {
    const verdict = checkElicitationRenderability(fields, requestFor(fields));
    expect(verdict.renderable).toBe(false);
    expect(verdict.reason).toBe("pattern-unsupported");
  }
  expect(checkElicitationRenderability([text("target")], requestFor([text("target")])).renderable).toBe(true);
  expect(checkElicitationRenderability([single("env", 3)], requestFor([single("env", 3)])).renderable).toBe(true);
});

test("a multi-select the platform cannot express is refused, not clamped", () => {
  // Two opposite errors, both from the gate judging raw schema values the builder
  // normalises away.
  //
  //   1. minValues > maxValues. `{ options: 2, minItems: 3 }` — the gate used to
  //      see `max(3, 0) = 3`, allow it, and the builder emitted
  //      `minValues: 3, maxValues: 2`, a component Discord rejects outright.
  //   2. A false rejection. `{ options: 2, maxItems: 40 }` — the answer domain is
  //      at most the two values offered, but the gate refused it for exceeding the
  //      platform's 25.
  const options = [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
  ];
  // Unsatisfiable: three selections required from two options.
  const unsatisfiable = checkElicitationRenderability([
    { kind: "multi-select", key: "k", title: "K", required: true, minItems: 3, options },
  ], requestFor([
    { kind: "multi-select", key: "k", title: "K", required: true, minItems: 3, options },
  ]));
  expect(unsatisfiable.renderable).toBe(false);
  expect(unsatisfiable.reason).toBe("select-min-max-out-of-range");
  expect(unsatisfiable.detail).toContain("2 are offered");

  // Bounded by what is offered, so it is fine despite `maxItems: 40`.
  expect(checkElicitationRenderability([
    { kind: "multi-select", key: "k", title: "K", required: true, maxItems: 40, options },
  ], requestFor([
    { kind: "multi-select", key: "k", title: "K", required: true, maxItems: 40, options },
  ])).renderable).toBe(true);

  // A genuinely over-capacity schema is still refused.
  expect(checkElicitationRenderability([
    { kind: "multi-select", key: "k", title: "K", required: true, minItems: 30, options },
  ], requestFor([
    { kind: "multi-select", key: "k", title: "K", required: true, minItems: 30, options },
  ])).reason).toBe("select-min-max-out-of-range");
});

test("the field budget covers every field kind, not just text", () => {
  // A single-select branch used to `continue` before the budget ran, so a select
  // with a 1000-char description of `*` escaped to ~2000 chars, passed the gate,
  // and then threw in the builder when the user pressed Start.
  const options = [{ value: "prod", label: "Production" }];
  const fields = [
    { kind: "single-select" as const, key: "env", title: "Environment", required: true, description: "*".repeat(1000), options },
    { kind: "boolean" as const, key: "ok", title: "OK", required: true, description: "*".repeat(1000) },
  ];
  for (const field of fields) {
    const verdict = checkElicitationRenderability([field], requestFor([field]));
    expect(verdict.renderable).toBe(false);
    expect(verdict.reason).toBe("field-text-too-long");
  }
});

test("the field budget reserves room for the answer echo", async () => {
  // The gate only measured the initial render. A user returning to an ANSWERED
  // field adds an "Answer saved" line, so an initial body near the limit would
  // overflow on the second render — after the answer had already been given, when
  // refusing is no longer possible.
  //
  // Core caps a description at 1000 raw chars, so use an expanding description to
  // reach the same boundary: every `*` doubles, so 950 of them is ~1900 escaped.
  const withEcho = [{
    kind: "text" as const,
    key: "note",
    title: "Note",
    required: true,
    maxLength: 1000,
    description: "*".repeat(950),
  }];
  const verdict = checkElicitationRenderability(withEcho, requestFor(withEcho));
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("field-text-too-long");

  // The same field, sized for BOTH the initial body and the reserved echo. Named
  // for what it fits, and re-interpreted below against the ESCAPED worst case —
  // an answer of 200 Markdown metacharacters renders an echo double the width of
  // 200 "x"s, and a field page cannot be chunked, so the reserve has to cover the
  // echo a user can actually produce.
  const roomForEcho = [{
    kind: "text" as const,
    key: "note",
    title: "Note",
    required: true,
    maxLength: 1000,
    description: "*".repeat(750),
  }];
  // Confirm the reserve is real: building the card with a maximum answer would
  // overflow, which is exactly the second render this protects.
  const overflow = buildElicitationFieldLines(
    requestFor(withEcho),
    withEcho[0]!,
    1,
    "x".repeat(FIELD_CARD_ANSWER_ECHO_MAX),
  ).join("\n\n");
  expect(overflow.length).toBeGreaterThan(1800);
  // The accepted field stays inside the limit WITH its echo, which is why it is
  // allowed: initial body + reserved echo <= budget.
  const fits = buildElicitationFieldLines(
    requestFor(roomForEcho),
    roomForEcho[0]!,
    1,
    "x".repeat(FIELD_CARD_ANSWER_ECHO_MAX),
  ).join("\n\n");
  expect(fits.length).toBeLessThanOrEqual(1800);
  // THE ECHO IS AN ESCAPED-SPACE BOUND.
  //
  // An "x" sample is 200 characters and stays 200 once escaped, so it only proves
  // the reserve for an answer made of characters the escaper leaves alone. A legal
  // answer of Markdown metacharacters is cut to 200 RAW characters and then
  // escaped, which doubles it — and that is the answer a user can actually give.
  const worstCaseEcho = "*".repeat(FIELD_CARD_ANSWER_ECHO_MAX);
  const withWorstEcho = buildElicitationFieldLines(
    requestFor(roomForEcho),
    roomForEcho[0]!,
    1,
    worstCaseEcho,
  ).join("\n\n");
  // So the field above must be REFUSED: its second render overflows, and a field
  // page cannot be chunked — `buildElicitationFieldCard` throws rather than split
  // it, which is how a gate-passing form became a field the user could not return
  // to after answering.
  expect(checkElicitationRenderability(roomForEcho, requestFor(roomForEcho)).renderable).toBe(false);
  expect(withWorstEcho.length).toBeGreaterThan(1800);
  // And the smaller description that survives the worst-case echo is the one the
  // gate is supposed to accept, which proves the refusal above is the reserve's
  // doing and not a blanket tightening.
  const roomForWorstEcho = [{
    kind: "text" as const,
    key: "note",
    title: "Note",
    required: true,
    maxLength: 1000,
    description: "*".repeat(640),
  }];
  expect(checkElicitationRenderability(roomForWorstEcho, requestFor(roomForWorstEcho)).renderable).toBe(true);
  const worstFits = buildElicitationFieldLines(
    requestFor(roomForWorstEcho),
    roomForWorstEcho[0]!,
    1,
    worstCaseEcho,
  ).join("\n\n");
  expect(worstFits.length).toBeLessThanOrEqual(1800);
});
test("a number field's reserved echo is the widest legal number, not zero", () => {
  // `0` is one character; `-Number.MAX_VALUE` renders 24. Reserving for the
  // first underestimates by 23 characters, and that is enough to cross the
  // 1800-char budget for a number field carrying an expanding description.
  //
  // The consequence is the same shape as the text echo: the gate accepts, the
  // user answers, and the second field-card render overflows — with no way to
  // refuse it any more, because `buildElicitationFieldCard` throws rather than
  // chunking a field page.
  const fields: ChannelElicitationRequest["fields"] = [{
    kind: "number",
    key: "n",
    title: "N",
    required: true,
    // Chosen so the widest-number echo is what crosses the budget. Measured
    // rather than derived, so a wording change does not silently invalidate it.
    description: "*".repeat(855),
  }];
  // The premise: reserving for zero would have passed this field. Built by hand
  // here, because that is exactly what the old gate did.
  const request = requestFor(fields);
  const withZero = buildElicitationFieldLines(request, fields[0]!, 1, 0).join("\n\n").length;
  const withWorst = buildElicitationFieldLines(request, fields[0]!, 1, -Number.MAX_VALUE).join("\n\n").length;
  expect(withZero).toBeLessThanOrEqual(1800);
  // And the widest legal number really does cross it.
  expect(withWorst).toBeGreaterThan(1800);

  // The gate must have reserved the wider one, so it refuses.
  const verdict = checkElicitationRenderability(fields, request);
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("field-text-too-long");
});

test("a number field bounded by a small maximum does not carry a 24-char echo", () => {
  // The other direction: the bound is clamped to the schema's own range, so a
  // `maximum: 100` field does not have 24 characters reserved against it that it
  // can never reach. Reserving the widest finite double unconditionally would
  // over-refuse legal forms, which is the opposite failure.
  const fields: ChannelElicitationRequest["fields"] = [{
    kind: "number",
    key: "n",
    title: "N",
    required: true,
    maximum: 100,
    description: "*".repeat(840),
  }];
  const request = requestFor(fields);
  const withMax = buildElicitationFieldLines(request, fields[0]!, 1, 100).join("\n\n").length;
  // With the clamp, the reserved echo is `100` (3 chars), so a field sized for
  // that stays inside the budget.
  expect(withMax).toBeLessThanOrEqual(1800);
  expect(checkElicitationRenderability(fields, request).renderable).toBe(true);
});
test("a multi-select's reserved echo bounds a legal subset, not the all-options sample", () => {
  // The echo is `escape(truncate(displayValue(answer), 200))` — cut to 200 RAW
  // characters and only THEN escaped. That ordering is what makes the
  // "all options" sample not a bound:
  //
  //   A = "x".repeat(100), B = "y".repeat(100), C = "*".repeat(100), maxItems 2
  //
  // The all-options sample is "A, B, C", cut to 200 raw characters of mostly-x —
  // it never reaches C, so its expanded width is ~200. The legal subset [B, C] is
  // cut to y's then stars, which expand, giving ~298. The sample is narrower than
  // a REAL answer, and it is not even a legal answer itself (maxItems is 2).
  //
  // Same consequence as the text echo: gate accepts, user answers, second render
  // overflows, field unreachable.
  const a = "x".repeat(100);
  const b = "y".repeat(100);
  const c = "*".repeat(100);
  const fields: ChannelElicitationRequest["fields"] = [{
    kind: "multi-select",
    key: "picks",
    title: "Picks",
    required: true,
    maxItems: 2,
    // Sized so the old all-options sample landed just under the budget while the
    // legal [B, C] subset lands well over it.
    description: "*".repeat(755),
    options: [
      { value: a, label: "A" },
      { value: b, label: "B" },
      { value: c, label: "C" },
    ],
  }];
  const request = requestFor(fields);
  // The premise: the legal subset really is wider than the sample, at this
  // description size. The sample lands just UNDER the budget and the legal
  // answer well over it, which is the case the old gate got backwards.
  const subsetEcho = buildElicitationFieldLines(request, fields[0]!, 1, [b, c]).join("\n\n").length;
  const allOptionsEcho = buildElicitationFieldLines(request, fields[0]!, 1, [a, b, c]).join("\n\n").length;
  expect(subsetEcho).toBeGreaterThan(allOptionsEcho);
  expect(allOptionsEcho).toBeLessThanOrEqual(1800);
  expect(subsetEcho).toBeGreaterThan(1800);

  // The gate must have reserved for the wider one, so it refuses.
  const verdict = checkElicitationRenderability(fields, request);
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("field-text-too-long");
});

test("a text field's reserved echo does not exceed its own declared maxLength", () => {
  // The bound is clamped to the field's own cap, so a `maxLength: 10` field is not
  // forced to carry 200 characters. Over-refusing legal boundary forms is the
  // failure in the other direction, and the clamp is what keeps the bound tight
  // rather than merely large.
  const fields: ChannelElicitationRequest["fields"] = [{
    kind: "text",
    key: "small",
    title: "Small",
    required: true,
    maxLength: 10,
    description: "*".repeat(840),
  }];
  const request = requestFor(fields);
  const withClamp = buildElicitationFieldLines(request, fields[0]!, 1, "*".repeat(10)).join("\n\n").length;
  expect(withClamp).toBeLessThanOrEqual(1800);
  // A 200-char echo would push the same field over, which is what the clamp
  // avoids: the reserved width is the field's own, not the universal bound.
  const withFull = buildElicitationFieldLines(request, fields[0]!, 1, "*".repeat(200)).join("\n\n").length;
  expect(withFull).toBeGreaterThan(1800);
  // So the gate accepts it, and correctly: the user cannot produce the wider echo.
  expect(checkElicitationRenderability(fields, request).renderable).toBe(true);
});
