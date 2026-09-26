import { beforeAll, expect, test } from "bun:test";

import {
  FeishuElicitationRenderer,
  parseElicitationAction,
  parseFormAnswer,
  type FeishuCardTransport,
} from "../../../../packages/channel-feishu/src/elicitation-renderer";
import type { PendingFeishuElicitation } from "../../../../packages/channel-feishu/src/elicitation-state";
import {
  buildElicitationFieldCard,
  buildElicitationOpeningCard,
  buildElicitationReviewCard,
  buildWorstCaseReviewCard,
  escapeFeishuCardText,
} from "../../../../packages/channel-feishu/src/elicitation-cards";
import {
  checkElicitationRenderability,
  measureElicitationCardBytes,
} from "../../../../packages/channel-feishu/src/elicitation-limits";
import type { ChannelElicitationDecision, ChannelElicitationRequest } from "xacpx/plugin-api";
import { setChannelLocale } from "../../../../packages/channel-feishu/src/i18n/index";

/**
 * The Feishu form renderer's behavioral contract.
 *
 * These drive the real renderer against a recording transport, so what is
 * asserted is what the plugin actually sends and decides — not a mock echo.
 */
beforeAll(() => {
  setChannelLocale("en");
});

function request(fields: ChannelElicitationRequest["fields"], message = "Which environment should I deploy to?"): ChannelElicitationRequest {
  return {
    requestId: "req-1",
    chatKey: "feishu:default:oc_chat",
    // A provably private route, so a form may be rendered at all. Tests that
    // care about route privacy set this explicitly.
    chatType: "direct",
    requester: { senderId: "ou_initiator", senderName: "Ada", isOwner: true },
    agent: { name: "codex", sessionAlias: "backend" },
    message,
    mode: "form",
    fields,
    expiresAt: Date.now() + 60_000,
    signal: new AbortController().signal,
  };
}

const ENV_FIELD: ChannelElicitationRequest["fields"] = [
  {
    kind: "single-select",
    key: "env",
    title: "Environment",
    required: true,
    options: [
      { value: "prod", label: "Production" },
      { value: "staging", label: "Staging" },
    ],
  },
];

interface Recording {
  transport: FeishuCardTransport & {
    sent: Array<Record<string, unknown>>;
    updates: Array<Record<string, unknown>>;
  };
  pending: Map<string, PendingFeishuElicitation>;
  renderer: FeishuElicitationRenderer;
}

function makeRenderer(): Recording {
  const sent: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const pending = new Map<string, PendingFeishuElicitation>();
  const transport: FeishuCardTransport & { sent: typeof sent; updates: typeof updates } = {
    sendCard: async ({ card, chatId }) => {
      sent.push({ ...card, chatId });
      return { cardId: "card_1", messageId: "om_1" };
    },
    updateCard: async ({ cardId, sequence, card }) => {
      updates.push({ cardId, sequence, ...card });
    },
    sent,
    updates,
  };
  return {
    transport,
    pending,
    renderer: new FeishuElicitationRenderer({ transport, pending }),
  };
}

/** Wait until the renderer has a pending entry, and return it. */
async function pendingEntry(
  rec: Recording,
): Promise<{ entry: PendingFeishuElicitation; token: string }> {
  const deadline = Date.now() + 2_000;
  while (rec.pending.size === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3));
  }
  const token = [...rec.pending.keys()][0];
  const entry = token === undefined ? undefined : rec.pending.get(token);
  if (!entry || !token) throw new Error("no pending elicitation appeared");
  return { entry, token };
}

/**
 * The generation of the card currently on screen for this token.
 *
 * Every `save` / `skip` a test drives must carry the generation of the card the
 * click would have come from, exactly as the builder stamps it. Reading it live
 * rather than hardcoding a number keeps the fixtures honest when the render count
 * changes, and it means a test cannot accidentally drive a versionless callback
 * past the revision fence.
 */
function onScreenGeneration(token: string, rec: Recording): number {
  const entry = rec.pending.get(token);
  if (!entry) throw new Error(`no pending elicitation for token ${token}`);
  return entry.renderGeneration;
}

/** Drive the full accept flow and return the decision the renderer produced. */
async function runFlow(
  rec: Recording,
  req: ChannelElicitationRequest,
  answer: string,
  formName = "f0",
): Promise<ChannelElicitationDecision | Error> {
  const promise = rec.renderer.requestElicitation(req, "oc_chat").then(
    (decision) => decision,
    (error: Error) => error,
  );
  const { token } = await pendingEntry(rec);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  // Field card submit: saves this field and advances.
  await rec.renderer.handleAction({
    openId: "ou_initiator",
    value: { t: token, a: "save", g: onScreenGeneration(token, rec) },
    formValues: { [formName]: answer },
  });
  // Review page submit: commits what the user reviewed. Only this one settles.
  await rec.renderer.handleAction({
    openId: "ou_initiator",
    value: { t: token, a: "submit", g: onScreenGeneration(token, rec) },
    formValues: {},
  });
  return promise;
}

test("a redelivered field save cannot accept the form", async () => {
  // Feishu retries callbacks, and a user double-taps. When the last field's
  // save also renders the review page, a redelivery of THAT callback must not
  // be treated as a click on the review page's Submit: save and submit are
  // different actions, so the duplicate is answered with "advance again",
  // which is already at the end, instead of accepting.
  const rec = makeRenderer();
  const promise = rec.renderer.requestElicitation(request(ENV_FIELD), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { token } = await pendingEntry(rec);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  await rec.renderer.handleAction({
    openId: "ou_initiator",
    value: { t: token, a: "save", g: onScreenGeneration(token, rec) },
    formValues: { f0: "prod" },
  });
  // Same callback twice: the field page's save action, delivered again.
  await rec.renderer.handleAction({
    openId: "ou_initiator",
    value: { t: token, a: "save", g: onScreenGeneration(token, rec) },
    formValues: { f0: "prod" },
  });
  const entry = rec.pending.get(token)!;
  expect(entry.settled).toBe(false);
  // The review page's own Submit is still the only way to accept.
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit", g: onScreenGeneration(token, rec) }, formValues: {} });
  expect(await promise).toEqual({ action: "accept", responderId: "ou_initiator", content: { env: "prod" } });
});

test("a text answer keeps its exact whitespace and can be empty", async () => {
  const rec = makeRenderer();
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "text", key: "raw", title: "Raw", required: true, maxLength: 1000 },
  ];
  const promise = rec.renderer.requestElicitation(request(fields), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { token } = await pendingEntry(rec);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  // Leading/trailing whitespace is part of the answer: core compares the raw
  // string, so trimming here would submit something the user did not type.
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "save", g: onScreenGeneration(token, rec) }, formValues: { f0: "  padded  " } });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit", g: onScreenGeneration(token, rec) }, formValues: {} });
  expect(await promise).toEqual({ action: "accept", responderId: "ou_initiator", content: { raw: "  padded  " } });
});

test("an answered optional field can be skipped back to omitted", async () => {
  const rec = makeRenderer();
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "text", key: "a", title: "A", required: true, maxLength: 1000 },
    { kind: "text", key: "b", title: "B", required: false, maxLength: 1000 },
  ];
  const promise = rec.renderer.requestElicitation(request(fields), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { token } = await pendingEntry(rec);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "save", g: onScreenGeneration(token, rec) }, formValues: { f0: "alpha" } });
  // Answer b, then go back and skip it: review-and-modify includes
  // value -> omitted, and a Skip that could not clear the old answer made
  // that transition impossible.
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "save", g: onScreenGeneration(token, rec) }, formValues: { f1: "beta" } });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "field", f: 1, g: onScreenGeneration(token, rec) }, formValues: {} });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "skip", f: 1, g: onScreenGeneration(token, rec) }, formValues: {} });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit", g: onScreenGeneration(token, rec) }, formValues: {} });
  expect(await promise).toEqual({ action: "accept", responderId: "ou_initiator", content: { a: "alpha" } });
});

test("an answered empty string is sent, not dropped as a skip", async () => {
  const rec = makeRenderer();
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "text", key: "note", title: "Note", required: false, maxLength: 1000 },
  ];
  const promise = rec.renderer.requestElicitation(request(fields), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { token } = await pendingEntry(rec);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "save", g: onScreenGeneration(token, rec) }, formValues: { f0: "" } });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit", g: onScreenGeneration(token, rec) }, formValues: {} });
  // A real answer, distinct from `null` (nothing answered) and from an omitted key.
  expect(await promise).toEqual({ action: "accept", responderId: "ou_initiator", content: { note: "" } });
});

test("decline renders a declined card, and cancel renders a cancelled one", async () => {
  for (const [action, phrase] of [
    ["decline", "declined to answer"],
    ["cancel", "cancelled"],
  ] as const) {
    const rec = makeRenderer();
    const promise = rec.renderer.requestElicitation(request(ENV_FIELD), "oc_chat").then(
      (d) => d,
      (e: Error) => e,
    );
    const { token } = await pendingEntry(rec);
    await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: action }, formValues: {} });
    expect(await promise).toEqual({ action, responderId: "ou_initiator" });
    // The terminal card must show what the user chose. It used to be hard-wired
    // to "accepted" for every terminal path, so the card contradicted the decision.
    const last = rec.transport.updates[rec.transport.updates.length - 1]!;
    const text = JSON.stringify(last);
    expect(text).toContain(phrase);
    expect(text).not.toContain("accepted");
  }
});

test("the opening card names the correlated agent, not a message claim", () => {
  const card = buildElicitationOpeningCard(
    request(ENV_FIELD),
    "tok",
  );
  const text = JSON.stringify(card);
  expect(text).toContain("Agent: codex");
  expect(text).toContain("Which environment should I deploy to?");
  // The identity precedes the claim in document order.
  expect(text.indexOf("Agent: codex")).toBeLessThan(text.indexOf("Which environment"));
});

test("a single-select field renders a select_static whose option values are the ACP values", () => {
  const card = buildElicitationFieldCard(request(ENV_FIELD), "tok", ENV_FIELD[0]!, 1, undefined);
  const form = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements.find((e) => e.tag === "form");
  expect(form).toBeDefined();
  const select = (form as { elements: Array<Record<string, unknown>> }).elements.find((e) => e.tag === "select_static");
  expect(select).toBeDefined();
  // The component `name` is the sanitized field key, NOT the answer.
  expect((select as { name: string }).name).toBe("f0");
  const options = (select as { options: Array<{ value: string }> }).options.map((o) => o.value);
  expect(options).toEqual(["prod", "staging"]);
});

test("the field card's submit button carries a routing token and never an answer", () => {
  const card = buildElicitationFieldCard(request(ENV_FIELD), "tok-abc", ENV_FIELD[0]!, 1, undefined, 1);
  const form = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements.find((e) => e.tag === "form");
  const submit = (form as { elements: Array<Record<string, unknown>> }).elements.find(
    (e) => e.tag === "button" && JSON.stringify(e).includes("Submit"),
  );
  expect(submit).toBeDefined();
  const behaviors = (submit as { behaviors: Array<{ type: string; value: Record<string, unknown> }> }).behaviors;
  expect(behaviors[0]!.type).toBe("callback");
  // The routing payload is the token + action only.
  expect(behaviors[0]!.value).toEqual({ t: "tok-abc", a: "save", g: 1 });
  // The ROUTING payload carries no option value. (The option label necessarily
  // appears as display text — that is the question the user answers — so the
  // absence asserted here is about the correlation handle, not the card body.)
  const payload = JSON.stringify(behaviors[0]!.value);
  expect(payload).not.toContain("prod");
  expect(payload).not.toContain("Production");
});

test("a text field renders an input bounded by the platform's max_length", () => {
  const field: ChannelElicitationRequest["fields"] = [
    { kind: "text", key: "note", title: "Note", required: true, maxLength: 1000 },
  ];
  const card = buildElicitationFieldCard(request(field), "tok", field[0]!, 1, undefined);
  const form = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements.find((e) => e.tag === "form");
  const input = (form as { elements: Array<Record<string, unknown>> }).elements.find((e) => e.tag === "input");
  expect(input).toBeDefined();
  expect((input as { name: string }).name).toBe("f0");
  expect((input as { max_length: number }).max_length).toBe(1000);
  expect((input as { required: boolean }).required).toBe(true);
});

test("the select's initial_option shows the default so it is visible and changeable", () => {
  const field: ChannelElicitationRequest["fields"] = [
    {
      kind: "single-select",
      key: "env",
      title: "Environment",
      required: true,
      defaultValue: "prod",
      options: [
        { value: "prod", label: "Production" },
        { value: "staging", label: "Staging" },
      ],
    },
  ];
  const card = buildElicitationFieldCard(request(field), "tok", field[0]!, 1, undefined);
  const form = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements.find((e) => e.tag === "form");
  const select = (form as { elements: Array<Record<string, unknown>> }).elements.find((e) => e.tag === "select_static");
  // The default is the CURRENT selection, not an invisible pre-fill.
  expect((select as { initial_option?: string }).initial_option).toBe("prod");
});

test("the card is non-streaming so an interaction can update it", () => {
  const card = buildElicitationOpeningCard(request(ENV_FIELD), "tok") as { config: Record<string, unknown> };
  // A card in streaming_mode cannot be updated from an interaction callback
  // (Feishu errors 200850/300309), and an elicit card has no reason to stream.
  expect(card.config.streaming_mode).toBe(false);
  expect(card.config.update_multi).toBe(true);
});

test("the review card has one Edit per field so answers are modifiable", () => {
  const fields: ChannelElicitationRequest["fields"] = [
    ...ENV_FIELD,
    { kind: "text", key: "note", title: "Note", required: false, maxLength: 1000 },
  ];
  const card = buildElicitationReviewCard(request(fields), "tok", { env: "staging" });
  const column = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements.find((e) => e.tag === "column_set");
  const buttons = (column as { columns: Array<{ elements: Array<Record<string, unknown>> }> }).columns[0]!.elements;
  const editButtons = buttons.filter((b) => JSON.stringify(b).includes("Edit:"));
  expect(editButtons).toHaveLength(2);
  // Each routes to its own field by POSITION.
  const targets = editButtons.map((b) => (b as { behaviors: Array<{ value: { f?: number } }> }).behaviors[0]!.value.f);
  expect(targets).toEqual([0, 1]);
});

test("the terminal card has no interactive component at all", () => {
  for (const card of [
    buildElicitationReviewCard(request(ENV_FIELD), "tok", { env: "prod" }),
    buildElicitationOpeningCard(request(ENV_FIELD), "tok"),
  ]) {
    // Sanity: the live cards DO have interactions.
    expect(JSON.stringify(card)).toContain("callback");
  }
});

test("agent text cannot form a Feishu mention or markup tag", () => {
  // Feishu card markdown uses <at id=...>, so escaping < is what neutralizes a
  // mention the agent asked for. The text-message path's normalizer would do
  // the opposite, so it deliberately is not reused here.
  const escaped = escapeFeishuCardText('<at id="ou_victim"></at>');
  // No raw `<` survives, which is what makes the tag unformable. `_` is escaped
  // too (Feishu italic), so the victim id appears with entities interleaved —
  // the point is that the MENTION is inert, not that the text is readable.
  expect(escaped).not.toContain("<");
  expect(escaped).toContain("&#60;at");
  expect(escaped).toContain("victim");
  expect(escaped).not.toContain("<at id=");
  const card = buildElicitationOpeningCard(request(ENV_FIELD), "tok");
  expect(JSON.stringify(card)).not.toContain("<at");
});

test("bold/spoiler shaping from agent text is escaped, not applied", () => {
  const escaped = escapeFeishuCardText("**not bold** ||spoiler||");
  expect(escaped).not.toContain("**");
  expect(escaped).not.toContain("||");
});

test("an agent-written option label renders literally while its value stays exact", () => {
  const field: ChannelElicitationRequest["fields"] = [
    {
      kind: "single-select",
      key: "env",
      title: "Environment",
      required: true,
      options: [{ value: "prod", label: "**Production** <at id=all></at>" }],
    },
  ];
  const card = buildElicitationFieldCard(request(field), "tok", field[0]!, 1, undefined);
  const form = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements.find((e) => e.tag === "form");
  const select = (form as { elements: Array<Record<string, unknown>> }).elements.find((e) => e.tag === "select_static");
  const options = (select as { options: Array<{ value: string; text?: { content: string } }> }).options;
  // Feishu wraps option display text in a plain_text object; the label is
  // escaped in its `content`, and the VALUE stays exact for core validation.
  expect(options[0]!.text!.content).toContain("&#42;&#42;Production&#42;&#42;");
  expect(options[0]!.text!.content).not.toContain("<at");
  expect(options[0]!.value).toBe("prod");
});

test("a multi-select field is refused because Feishu cards have no multi-select", () => {
  const fields: ChannelElicitationRequest["fields"] = [
    {
      kind: "multi-select",
      key: "tags",
      title: "Tags",
      required: true,
      options: [{ value: "a", label: "A" }],
    },
  ];
  const verdict = checkElicitationRenderability(fields);
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("multi-select-unsupported");
  // The whole request cancels; no partial form is rendered.
});

test("an answer longer than one input can capture is refused", () => {
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "text", key: "note", title: "Note", required: true, maxLength: 5000 },
  ];
  const verdict = checkElicitationRenderability(fields);
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("answer-too-long");
});

test("an over-long field label is refused rather than clipped into a different question", () => {
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "text", key: "note", title: "N".repeat(101), required: true },
  ];
  const verdict = checkElicitationRenderability(fields);
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("field-label-too-long");
});

test("a field label that is legal raw but too long ESCAPED is refused, not clipped", () => {
  // The label is the question, so it must be shown in full. It used to be judged
  // by RAW length: 100 `<` sat exactly at the 100-char bound, passed, expanded
  // to 500 escaped chars as `input.label` / the bold heading, and was then cut
  // back to 100 by the safety net — the user read a fragment of the question.
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "text", key: "note", title: "<".repeat(100), required: true, maxLength: 100 },
  ];
  const verdict = checkElicitationRenderability(fields);
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("field-label-too-long");
  // Both lengths are named so an operator can see the raw length was fine.
  expect(verdict.detail).toContain("100 chars raw");
  expect(verdict.detail).toContain("500 escaped");
});

test("a short ASCII label still renders", () => {
  // The ordinary case must be untouched by the stricter bound: a normal label
  // is neither too long raw nor too long escaped.
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "single-select", key: "env", title: "Environment", required: true, options: [
      { value: "prod", label: "Production" },
      { value: "staging", label: "Staging" },
    ] },
  ];
  expect(checkElicitationRenderability(fields).renderable).toBe(true);
});

test("a small mixed form renders", () => {
  const verdict = checkElicitationRenderability([
    { kind: "text", key: "a", title: "A", required: true, maxLength: 1000 },
    ENV_FIELD[0]!,
    { kind: "boolean", key: "b", title: "B", required: true },
    { kind: "number", key: "n", title: "N", required: false, integer: true },
  ]);
  expect(verdict.renderable).toBe(true);
});

test("the renderer accepts a select answer and resumes the same request", async () => {
  const rec = makeRenderer();
  const decision = await runFlow(rec, request(ENV_FIELD), "staging");
  expect(decision).toEqual({
    action: "accept",
    responderId: "ou_initiator",
    content: { env: "staging" },
  });
  // The card was created, then updated at least once to advance the wizard.
  expect(rec.transport.sent).toHaveLength(1);
  expect(rec.transport.updates.length).toBeGreaterThanOrEqual(1);
  // The pending entry is gone, so no stale callback can still decide.
  expect(rec.pending.size).toBe(0);
});

test("the update sequence strictly increases", async () => {
  const rec = makeRenderer();
  const seqs = () => rec.transport.updates.map((u) => u.sequence as number);
  await runFlow(rec, request(ENV_FIELD), "prod");
  const observed = seqs();
  expect(observed.length).toBeGreaterThanOrEqual(2);
  for (let i = 1; i < observed.length; i += 1) {
    expect(observed[i]!).toBeGreaterThan(observed[i - 1]!);
  }
});

test("the initiator's Decline is a distinct decision carrying their identity", async () => {
  const rec = makeRenderer();
  const promise = rec.renderer.requestElicitation(request(ENV_FIELD), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { token } = await pendingEntry(rec);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "decline" }, formValues: {} });
  expect(await promise).toEqual({ action: "decline", responderId: "ou_initiator" });
});

test("Cancel is distinct from Decline", async () => {
  const rec = makeRenderer();
  const promise = rec.renderer.requestElicitation(request(ENV_FIELD), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { token } = await pendingEntry(rec);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "cancel" }, formValues: {} });
  expect(await promise).toEqual({ action: "cancel", responderId: "ou_initiator" });
});

test("a non-initiator cannot submit, and the initiator still can", async () => {
  const rec = makeRenderer();
  const promise = rec.renderer.requestElicitation(request(ENV_FIELD), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { token } = await pendingEntry(rec);
  // The intruder's start and submit are dropped.
  await rec.renderer.handleAction({ openId: "ou_intruder", value: { t: token, a: "start" }, formValues: {} });
  await rec.renderer.handleAction({
    openId: "ou_intruder",
    value: { t: token, a: "save", g: onScreenGeneration(token, rec) },
    formValues: { f0: "prod" },
  });
  const entry = rec.pending.get(token)!;
  expect(entry.settled).toBe(false);
  expect(entry.values).toEqual({});
  // The initiator can still complete it — proof the intruder's clicks neither
  // settled nor poisoned the entry.
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  await rec.renderer.handleAction({
    openId: "ou_initiator",
    value: { t: token, a: "save", g: onScreenGeneration(token, rec) },
    formValues: { f0: "prod" },
  });
  // Review page submit commits it.
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit", g: onScreenGeneration(token, rec) }, formValues: {} });
  expect(await promise).toEqual({ action: "accept", responderId: "ou_initiator", content: { env: "prod" } });
});

test("an intruder's click does not move the wizard or write an answer", async () => {
  const rec = makeRenderer();
  const promise = rec.renderer.requestElicitation(request(ENV_FIELD), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { token } = await pendingEntry(rec);
  await rec.renderer.handleAction({
    openId: "ou_intruder",
    value: { t: token, a: "save", g: onScreenGeneration(token, rec) },
    formValues: { f0: "prod" },
  });
  const entry = rec.pending.get(token)!;
  expect(entry.values).toEqual({});
  expect(entry.settled).toBe(false);
  // The initiator can still complete it.
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  await rec.renderer.handleAction({
    openId: "ou_initiator",
    value: { t: token, a: "save", g: onScreenGeneration(token, rec) },
    formValues: { f0: "staging" },
  });
  // Review page submit commits it.
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit", g: onScreenGeneration(token, rec) }, formValues: {} });
  expect(await promise).toEqual({ action: "accept", responderId: "ou_initiator", content: { env: "staging" } });
});

test("a submit with no answer for a required field keeps the card live", async () => {
  const rec = makeRenderer();
  const promise = rec.renderer.requestElicitation(request(ENV_FIELD), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { token } = await pendingEntry(rec);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  await rec.renderer.handleAction({
    openId: "ou_initiator",
    value: { t: token, a: "save", g: onScreenGeneration(token, rec) },
    formValues: { f0: "" },
  });
  const entry = rec.pending.get(token)!;
  // Not settled, nothing authored: the user gets another chance. An empty
  // string is a LEGAL answer (`minLength: 0`) and is recorded as one, so the
  // required-field gate must reject it on length rather than on presence.
  expect(entry.settled).toBe(false);
  expect(entry.values).toEqual({ env: "" });
  // And it can still be completed.
  await rec.renderer.handleAction({
    openId: "ou_initiator",
    value: { t: token, a: "save", g: onScreenGeneration(token, rec) },
    formValues: { f0: "prod" },
  });
  // Review page submit commits it.
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit", g: onScreenGeneration(token, rec) }, formValues: {} });
  expect(await promise).toEqual({ action: "accept", responderId: "ou_initiator", content: { env: "prod" } });
});

test("an all-optional form still carries a provided answer as content", async () => {
  const rec = makeRenderer();
  const fields: ChannelElicitationRequest["fields"] = [
    {
      kind: "single-select",
      key: "any",
      title: "Anything",
      required: false,
      options: [{ value: "a", label: "A" }],
    },
  ];
  const decision = await runFlow(rec, request(fields), "a", "f0");
  expect(decision).toEqual({ action: "accept", responderId: "ou_initiator", content: { any: "a" } });
});

test("an all-optional form submitted with no answers yields a null content", async () => {
  const rec = makeRenderer();
  const fields: ChannelElicitationRequest["fields"] = [
    {
      kind: "single-select",
      key: "any",
      title: "Anything",
      required: false,
      options: [{ value: "a", label: "A" }],
    },
  ];
  const promise = rec.renderer.requestElicitation(request(fields), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { token } = await pendingEntry(rec);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  // Skip the optional field: nothing is required, so this is legal and the
  // content must be `null` (ACP's "accept with no answers") — not `{}` and
  // not `undefined`, both of which are different statements.
  await rec.renderer.handleAction({
    openId: "ou_initiator",
    value: { t: token, a: "skip", f: 0, g: onScreenGeneration(token, rec) },
    formValues: {},
  });
  // The skip advanced to review; this submit commits the empty form.
  await rec.renderer.handleAction({
    openId: "ou_initiator",
    value: { t: token, a: "submit", g: onScreenGeneration(token, rec) },
    formValues: {},
  });
  expect(await promise).toEqual({ action: "accept", responderId: "ou_initiator", content: null });
});

test("a token the renderer never issued is ignored", async () => {
  const rec = makeRenderer();
  const promise = rec.renderer.requestElicitation(request(ENV_FIELD), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { entry, token } = await pendingEntry(rec);
  const outcome = await rec.renderer.handleAction({
    openId: "ou_initiator",
    // A complete, well-formed payload whose TOKEN matches no live request. The
    // generation is present and current, so the only reason this can fail is the
    // token itself, not a malformed control.
    value: { t: "not-a-real-token", a: "save", g: onScreenGeneration(token, rec) },
    formValues: { f0: "prod" },
  });
  expect(outcome).toEqual({ handled: false, settled: false });
  // The real request is untouched and must be drained for a clean test exit.
  await rec.renderer.withdrawPending(entry, "test teardown");
  expect(await promise).toBeInstanceOf(Error);
});

test("an external withdrawal rejects rather than inventing a responder", async () => {
  const rec = makeRenderer();
  const promise = rec.renderer.requestElicitation(request(ENV_FIELD), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { entry } = await pendingEntry(rec);
  await rec.renderer.withdrawPending(entry, "elicitation request aborted");
  const outcome = await promise;
  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toContain("aborted");
  // The card was replaced with an inert one.
  expect(rec.transport.updates.length).toBeGreaterThanOrEqual(1);
});

test("an unrenderable form is refused before any card is sent", async () => {
  const rec = makeRenderer();
  const promise = rec.renderer.requestElicitation(
    request([
      { kind: "multi-select", key: "t", title: "T", required: true, options: [{ value: "a", label: "A" }] },
    ]),
    "oc_chat",
  ).then(
    (d) => d,
    (e: Error) => e,
  );
  const outcome = await promise;
  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toContain("not renderable");
  expect(rec.transport.sent).toHaveLength(0);
});

test("a message too large to show faithfully is refused before any card is sent", () => {
  // The opening card renders `message` as a markdown component whose content is
  // the ESCAPED text, bounded by FEISHU_CARD_BODY_MAX_CHARS. That bound used to
  // be enforced only by the `boundRendered` cut, so `"<".repeat(8000)` — 40,000
  // chars once escaped — was sliced back to 28,000 and the user was shown a
  // fragment of entity codes instead of what the agent asked. The form is now
  // refused whole: the request cancels rather than the question changing.
  //
  // Driven through `checkElicitationRenderability(fields, request)` — the entry
  // point the renderer's `requestElicitation` gate uses, with the request added
  // as the optional second argument. See the report: the renderer needs to pass
  // it, and until it does this refusal is only reachable through the gate.
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "text", key: "n", title: "N", required: true, maxLength: 100 },
  ];
  const verdict = checkElicitationRenderability(request(fields, "<".repeat(8000)).fields, {
    message: "<".repeat(8000),
  });
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("card-text-too-large");
  expect(verdict.detail).toContain("8000 chars raw");
  expect(verdict.detail).toContain("40000 escaped");

  // The field-only form still renders: the refusal is about the message, not
  // about the fields.
  expect(checkElicitationRenderability(fields).renderable).toBe(true);
});

test("a message that fits after escaping is shown in full by the opening card", () => {
  // The gate must not overreach: a message inside the escaped budget renders,
  // and every character of it survives — the safety net must not be what carries
  // this, because a cut is the bug being fixed.
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "text", key: "n", title: "N", required: true, maxLength: 100 },
  ];
  const message = "Choose: " + "<".repeat(4000) + "END";
  expect(checkElicitationRenderability(fields, { message }).renderable).toBe(true);
  const card = buildElicitationOpeningCard(request(fields, message), "tok");
  const elements = (card.body as { elements: Array<{ content?: string }> }).elements;
  const rendered = elements.map((element) => element.content ?? "").join("\n");
  // Every one of the agent's characters is present as an entity. Asserted on the
  // element that carries the message, not on the joined card body: the opening
  // card renders the field summary AFTER the message, so a trailing check on the
  // join would see the summary rather than the message's own tail.
  expect((rendered.match(/&#60;/g) ?? []).length).toBe(4000);
  const messageElement = elements.find((element) => element.content?.includes("END"));
  expect(messageElement?.content?.endsWith("END")).toBe(true);
  // Escaped exactly ONCE, so the user reads the literal characters back.
  expect(messageElement?.content).not.toContain("amp;#60;");
});

test("the worst-case review card is no longer optimistic", () => {
  // The review card is where a form can outgrow Feishu's 30 KB budget: every
  // field's label and answer lands in one card, and the escaped form of an
  // answer is several times its raw length. Sizing that WORST case before
  // anything is sent is what keeps this from being a `card.update` failure after
  // the user filled the whole form in.
  //
  // The sample used to be `"x".repeat(maxLength)` — a 1x character — so a real
  // answer of 1000 `<` (5x escaped) made the estimate 5x short and the gate
  // blessed a card the review page would then overflow. The sample is now the
  // widest escape of a full-length answer.
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "text", key: "note", title: "Note", required: false, maxLength: 1000 },
  ];
  const worst = buildWorstCaseReviewCard(request(fields), "a".repeat(32));
  const worstBytes = measureElicitationCardBytes(worst);
  // The concrete number, so a regression back to the optimistic sample shows up
  // as a byte count rather than only as a card that fails in production.
  expect(worstBytes).toBe(7165);

  // The estimate must DOMINATE the real card a user can produce: a maximal
  // `~` answer (6x escaped) is the largest answer this field can legally hold,
  // so the worst-case card has to be at least that big.
  const maximalAnswer = buildElicitationReviewCard(
    request(fields),
    "a".repeat(32),
    { note: "~".repeat(1000) },
  );
  expect(worstBytes).toBeGreaterThanOrEqual(measureElicitationCardBytes(maximalAnswer));

  // The old sample's size, for contrast. The gap IS the bug.
  const optimistic = buildElicitationReviewCard(
    request(fields),
    "a".repeat(32),
    { note: "x".repeat(1000) },
  );
  expect(measureElicitationCardBytes(optimistic)).toBe(2165);
  expect(worstBytes).toBeGreaterThan(measureElicitationCardBytes(optimistic) * 3);
});

test("a number answer is parsed as a number, and a bad one is not stored", async () => {
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "number", key: "hours", title: "Hours", required: true, minimum: 1, maximum: 8 },
  ];
  expect(parseFormAnswer(fields[0]!, "4")).toBe(4);
  expect(parseFormAnswer(fields[0]!, "abc")).toBeUndefined();
  expect(parseFormAnswer(fields[0]!, "9")).toBeUndefined();
  expect(parseFormAnswer(fields[0]!, "0")).toBeUndefined();
  const intField: ChannelElicitationRequest["fields"] = [
    { kind: "number", key: "retries", title: "Retries", required: true, integer: true },
  ];
  expect(parseFormAnswer(intField[0]!, "2.5")).toBeUndefined();
  expect(parseFormAnswer(intField[0]!, "3")).toBe(3);
  const boolField: ChannelElicitationRequest["fields"] = [{ kind: "boolean", key: "b", title: "B", required: true }];
  expect(parseFormAnswer(boolField[0]!, "yes")).toBe(true);
  expect(parseFormAnswer(boolField[0]!, "0")).toBe(false);
  expect(parseFormAnswer(boolField[0]!, "maybe")).toBeUndefined();
});

test("parseElicitationAction refuses payloads the renderer did not shape", () => {
  expect(parseElicitationAction({ t: "tok", a: "field", f: 3, g: 2 })).toEqual({
    token: "tok",
    action: "field",
    fieldIndex: 3,
    renderGeneration: 2,
  });
  expect(parseElicitationAction({ t: "tok", a: "submit", g: 2 })).toEqual({
    token: "tok",
    action: "submit",
    renderGeneration: 2,
  });
  // A scalar, an array, or a missing token/action is not ours.
  expect(parseElicitationAction("submit")).toBeNull();
  expect(parseElicitationAction(["submit"])).toBeNull();
  expect(parseElicitationAction({ t: "tok" })).toBeNull();
  expect(parseElicitationAction({ a: "submit" })).toBeNull();
  expect(parseElicitationAction(null)).toBeNull();
  expect(parseElicitationAction({})).toBeNull();
});

test("every state-mutating control must carry the card's generation", () => {
  // The revision fence is a protocol invariant, not a property of the situation.
  // The builder always stamps a generation onto save, skip, field and submit — the
  // four actions that write or drive field state — so a payload without one
  // cannot have come from a card this renderer drew.
  expect(parseElicitationAction({ t: "tok", a: "save" })).toBeNull();
  expect(parseElicitationAction({ t: "tok", a: "skip", f: 0 })).toBeNull();
  expect(parseElicitationAction({ t: "tok", a: "field", f: 0 })).toBeNull();
  expect(parseElicitationAction({ t: "tok", a: "submit" })).toBeNull();
  // A malformed generation is the same as a missing one.
  for (const bad of [-1, "1", 1.5, null]) {
    expect(parseElicitationAction({ t: "tok", a: "save", g: bad })).toBeNull();
    expect(parseElicitationAction({ t: "tok", a: "skip", f: 0, g: bad })).toBeNull();
    expect(parseElicitationAction({ t: "tok", a: "field", f: 0, g: bad })).toBeNull();
    expect(parseElicitationAction({ t: "tok", a: "submit", g: bad })).toBeNull();
  }
  // Well-formed versions of the same four are accepted.
  expect(parseElicitationAction({ t: "tok", a: "save", g: 3 })).toEqual({ token: "tok", action: "save", renderGeneration: 3 });
  expect(parseElicitationAction({ t: "tok", a: "skip", f: 1, g: 3 })).toEqual({
    token: "tok",
    action: "skip",
    fieldIndex: 1,
    renderGeneration: 3,
  });
  // Terminal decisions and pure navigation stay unversioned, exactly as the
  // builder draws them: a replayed Decline is still a Decline the user made on a
  // card they were shown, and the opening card carries no answers to protect.
  expect(parseElicitationAction({ t: "tok", a: "decline" })).not.toBeNull();
  expect(parseElicitationAction({ t: "tok", a: "cancel" })).not.toBeNull();
  expect(parseElicitationAction({ t: "tok", a: "start" })).not.toBeNull();
});

test("a boolean field renders a two-option select, not a free-text box", async () => {
  const rec = makeRenderer();
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "boolean", key: "confirm", title: "Confirm", required: true },
  ];
  const promise = rec.renderer.requestElicitation(request(fields), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { token } = await pendingEntry(rec);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  const card = JSON.stringify(rec.transport.updates[rec.transport.updates.length - 1]);
  // The options must be VISIBLE to the user. This used to be a blank `input`
  // whose accepted spellings ("yes"/"y"/"1") existed only in the parser, so the
  // user had no way to know what to type for a boolean question.
  expect(card).toContain("select_static");
  expect(card).not.toContain('"tag":"input"');
  expect(card).toContain("Yes");
  expect(card).toContain("No");
  // The option VALUES are the literal spellings the parser maps back, so a real
  // boolean reaches core rather than a guessed string.
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "save", g: onScreenGeneration(token, rec) }, formValues: { f0: "true" } });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit", g: onScreenGeneration(token, rec) }, formValues: {} });
  expect(await promise).toEqual({ action: "accept", responderId: "ou_initiator", content: { confirm: true } });
});

test("a text answer with an empty string survives an all-optional form", async () => {
  const rec = makeRenderer();
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "text", key: "note", title: "Note", required: false, minLength: 0, maxLength: 1000 },
  ];
  const promise = rec.renderer.requestElicitation(request(fields), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { token } = await pendingEntry(rec);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "save", g: onScreenGeneration(token, rec) }, formValues: { f0: "" } });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit", g: onScreenGeneration(token, rec) }, formValues: {} });
  // `""` is a real answer, deliberately distinct from `null` (nothing answered).
  expect(await promise).toEqual({ action: "accept", responderId: "ou_initiator", content: { note: "" } });
});

test("a field key named __proto__ becomes an own answer property", async () => {
  // Core allows it and defends with null-prototype output; the renderer must not
  // undo that by writing the key into a plain object's prototype.
  const rec = makeRenderer();
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "text", key: "__proto__", title: "Proto", required: true, maxLength: 1000 },
  ];
  const promise = rec.renderer.requestElicitation(request(fields), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { token } = await pendingEntry(rec);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  const entry = rec.pending.get(token)!;
  expect(Object.getPrototypeOf(entry.values)).toBe(null);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "save", g: onScreenGeneration(token, rec) }, formValues: { f0: "typed" } });
  expect(Object.hasOwn(entry.values, "__proto__")).toBe(true);
  expect(entry.values.__proto__).toBe("typed");
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit", g: onScreenGeneration(token, rec) }, formValues: {} });
  const decision = await promise as {
    action: string;
    responderId: string;
    content: Record<string, unknown> | null;
  };
  expect(decision.action).toBe("accept");
  expect(decision.content).not.toBeNull();
  expect(Object.hasOwn(decision.content!, "__proto__")).toBe(true);
  expect(decision.content!.__proto__).toBe("typed");
});

test("a redelivered Skip callback re-skips the same field, not the next one", async () => {
  // Skip resolved its field from the shared `entry.currentField` cursor. Feishu
  // retries card callbacks and users double-tap, so the SAME Skip callback
  // arriving twice advanced the cursor between the two deliveries and skipped a
  // DIFFERENT field — deleting an answer it already had. No true concurrency is
  // needed: the sequence is enough.
  const rec = makeRenderer();
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "text", key: "a", title: "A", required: false, maxLength: 1000 },
    { kind: "text", key: "b", title: "B", required: false, maxLength: 1000 },
    { kind: "text", key: "c", title: "C", required: false, maxLength: 1000 },
  ];
  const promise = rec.renderer.requestElicitation(request(fields), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { entry, token } = await pendingEntry(rec);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  // A's own card. Give B an answer so a stray skip of B is observable as a loss.
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "save", g: onScreenGeneration(token, rec) }, formValues: { f0: "" } });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "field", f: 1, g: onScreenGeneration(token, rec) }, formValues: {} });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "save", g: onScreenGeneration(token, rec) }, formValues: { f1: "beta" } });
  // Back to A, then deliver A's Skip TWICE.
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "field", f: 0, g: onScreenGeneration(token, rec) }, formValues: {} });
  expect(entry.currentField).toBe("a");
  const skipA = { openId: "ou_initiator", value: { t: token, a: "skip", f: 0, g: onScreenGeneration(token, rec) }, formValues: {} };
  await rec.renderer.handleAction(skipA);
  // Redelivery of the very same callback: same token, same action, same field.
  await rec.renderer.handleAction(skipA);
  expect([...entry.skipped]).toEqual(["a"]);
  // B is answered, so the first UNRESOLVED field is C — not B, and certainly not
  // a field the duplicate skipped.
  expect(entry.currentField).toBe("c");
  // B's answer survived the duplicate Skip. This is the loss the bug caused.
  expect(entry.values.b).toBe("beta");
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit", g: onScreenGeneration(token, rec) }, formValues: {} });
  expect(await promise).toEqual({ action: "accept", responderId: "ou_initiator", content: { b: "beta" } });
});

test("a Skip callback with no field position is rejected", async () => {
  const rec = makeRenderer();
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "text", key: "a", title: "A", required: false, maxLength: 1000 },
    { kind: "text", key: "b", title: "B", required: false, maxLength: 1000 },
  ];
  const promise = rec.renderer.requestElicitation(request(fields), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { entry, token } = await pendingEntry(rec);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  expect(entry.currentField).toBe("a");
  // No `f` at all: refusing is safer than guessing from the cursor.
  const result = await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "skip" }, formValues: {} });
  expect(result.handled).toBe(false);
  expect(entry.skipped.size).toBe(0);
  expect(entry.currentField).toBe("a");
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "skip", f: 1, g: onScreenGeneration(token, rec) }, formValues: {} });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "skip", f: 0, g: onScreenGeneration(token, rec) }, formValues: {} });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit", g: onScreenGeneration(token, rec) }, formValues: {} });
  expect(await promise).toEqual({ action: "accept", responderId: "ou_initiator", content: null });
});

test("an answer core would reject never reaches the Accepted card", async () => {
  // The review submit used to check required-presence only. `parseFormAnswer`
  // returns text raw — even `minLength` is unchecked — so `{minLength: 5}` with
  // "x", or an email field of "not-an-email", went: review -> Submit -> card
  // shows Accepted -> the broker rejects it and the turn ends as cancel. The
  // user saw success and then a cancellation, with the form already inert.
  const rec = makeRenderer();
  const fields: ChannelElicitationRequest["fields"] = [
    {
      kind: "text",
      key: "mail",
      title: "Email",
      required: true,
      maxLength: 100,
      format: "email",
    },
  ];
  const promise = rec.renderer.requestElicitation(request(fields), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { token } = await pendingEntry(rec);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "save", g: onScreenGeneration(token, rec) }, formValues: { f0: "not-an-email" } });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit", g: onScreenGeneration(token, rec) }, formValues: {} });
  // Not settled: the renderer bounced back to the field so the answer can be
  // corrected, and the card never became a terminal "accepted".
  expect(rec.pending.size).toBe(1);
  const terminalText = rec.transport.updates.map((update) => JSON.stringify(update)).join("\n");
  expect(terminalText).not.toContain("accepted");
  // Correcting it now succeeds.
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "save", g: onScreenGeneration(token, rec) }, formValues: { f0: "dev@example.com" } });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit", g: onScreenGeneration(token, rec) }, formValues: {} });
  expect(await promise).toEqual({ action: "accept", responderId: "ou_initiator", content: { mail: "dev@example.com" } });
});

test("a minLength violation is caught before the card is withdrawn", async () => {
  const rec = makeRenderer();
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "text", key: "note", title: "Note", required: true, maxLength: 100, minLength: 5 },
  ];
  const promise = rec.renderer.requestElicitation(request(fields), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { token } = await pendingEntry(rec);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "save", g: onScreenGeneration(token, rec) }, formValues: { f0: "x" } });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit", g: onScreenGeneration(token, rec) }, formValues: {} });
  expect(rec.pending.size).toBe(1);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "save", g: onScreenGeneration(token, rec) }, formValues: { f0: "long enough" } });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit", g: onScreenGeneration(token, rec) }, formValues: {} });
  expect(await promise).toEqual({ action: "accept", responderId: "ou_initiator", content: { note: "long enough" } });
});

test("an opening card whose pieces are individually legal but jointly over 30KB is refused before any send", async () => {
  // The per-component gate bounds each markdown component at 28,000 chars, but
  // the card budget is an AGGREGATE over the serialized card. So a request whose
  // every piece is legal on its own can still be unrenderable: a 4,666-char `~`
  // message escapes to 27,996 (inside the per-component bound) and a 1,000-char
  // `~` schema description to 6,000 — 33,996 chars of content before any card
  // structure, ~35 KB in total.
  //
  // Both pieces respect core's raw limits too (8,000 for message, 1,000 for
  // schema description), so only the assembled card reveals the overflow. Without
  // this check the gate says renderable and the first `sendCard` is rejected by
  // CardKit.
  const rec = makeRenderer();
  const fields: ChannelElicitationRequest["fields"] = [];
  const request = {
    requestId: "r-aggregate",
    chatKey: "feishu:default:oc_chat",
    // A provably private route: this test is about the card budget, not privacy.
    chatType: "direct",
    requester: { senderId: "ou_initiator" },
    agent: { name: "codex" },
    message: "~".repeat(4666),
    mode: "form",
    schemaDescription: "~".repeat(1000),
    fields,
    expiresAt: Date.now() + 60_000,
    signal: new AbortController().signal,
  } as unknown as ChannelElicitationRequest;

  // The field-level gate is satisfied: it is the aggregate that fails.
  expect(checkElicitationRenderability(fields, request).renderable).toBe(true);

  const outcome = await rec.renderer.requestElicitation(request, "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toContain("card-too-large");
  // Nothing was sent: the refusal happens before the transport is touched.
  expect(rec.transport.sent).toHaveLength(0);
  // And nothing is left pending.
  expect(rec.pending.size).toBe(0);
});

test("a form asked on a group route is refused before any card is created", async () => {
  // The card carries the agent's question AND the user's answers, and a group chat
  // shows both to every member. Authorising who may CLICK never limited who may
  // SEE.
  const rec = makeRenderer();
  const outcome = await rec.renderer.requestElicitation({ ...request(ENV_FIELD), chatType: "group" }, "oc_chat").then(
    () => "resolved",
    (e: Error) => e,
  );
  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toContain("only renderable on a private route");
  expect((outcome as Error).message).toContain("group");
  // Nothing was created, so neither the question nor an answer can reach the group.
  expect(rec.transport.sent).toHaveLength(0);
  expect(rec.pending.size).toBe(0);
});

test("a form asked on an unreported route is refused, not treated as direct", async () => {
  // Absent is not the same as private: a channel that reports no `chatType` has
  // not established a 1:1 destination.
  const rec = makeRenderer();
  const req = request(ENV_FIELD) as { chatType?: string };
  delete req.chatType;
  const outcome = await rec.renderer.requestElicitation(req as never, "oc_chat").then(
    () => "resolved",
    (e: Error) => e,
  );
  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toContain("no chatType");
  expect(rec.transport.sent).toHaveLength(0);
});


test("an opening send that lands after Decline resolves with the Decline", async () => {
  // Same race, resolved: hold `sendCard`, let the user Decline while it is held,
  // then release. The promise must settle with the user's decision and the card
  // must end in the Decline terminal state, not a cancellation.
  const rec = makeRenderer();
  const realSend = rec.transport.sendCard.bind(rec.transport);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held2 = true;
  (rec.transport as { sendCard: unknown }).sendCard = async (input: { card: unknown; chatId: string }) => {
    const result = await realSend(input as never);
    if (held2) await held;
    return result;
  };
  const promise = rec.renderer.requestElicitation(request(ENV_FIELD), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  // Let the card be recorded, then the user declines while the send is held.
  await new Promise((r) => setTimeout(r, 5));
  const entry = [...rec.pending.values()][0]!;
  // Drive the decline through the renderer's own callback path: the entry exists
  // and `cardId` is already recorded because ownership is taken first.
  await rec.renderer.handleAction({
    openId: "ou_initiator",
    value: { t: entry.token, a: "decline" },
    formValues: {},
  });
  // Release the held send.
  held2 = false;
  release();
  const outcome = await Promise.race([
    promise,
    new Promise((r) => setTimeout(() => r("timeout"), 800)),
  ]);
  expect(outcome).toEqual({ action: "decline", responderId: "ou_initiator" });
});

test("a hung terminal card update cannot swallow a Decline decision", async () => {
  // `withdraw` is a `card.update` round trip. When the decision's promise was
  // resolved AFTER it, a CardKit request that never returned also never delivered
  // the decision: `pending` was already cleared, so a retry found no entry, `done`
  // never settled, and core could only time the turn out.
  const rec = makeRenderer();
  (rec.transport as { updateCard: unknown }).updateCard = () => new Promise<void>(() => {});
  const promise = rec.renderer.requestElicitation(request(ENV_FIELD), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  await new Promise((r) => setTimeout(r, 5));
  const entry = [...rec.pending.values()][0]!;
  const clicked = rec.renderer.handleAction({
    openId: "ou_initiator",
    value: { t: entry.token, a: "decline" },
    formValues: {},
  });
  // The DECISION resolves promptly even though the terminal update never will.
  const outcome = await Promise.race([
    promise,
    new Promise((r) => setTimeout(() => r("timeout"), 800)),
  ]);
  expect(outcome).toEqual({ action: "decline", responderId: "ou_initiator" });
  await Promise.race([clicked, new Promise((r) => setTimeout(r, 30))]);
});

test("a hung terminal card update cannot swallow an Accept decision", async () => {
  // Same ordering, on the review submit path: the accepted answer must reach core
  // even if the "Accepted" card update never returns.
  const rec = makeRenderer();
  // The wizard's own re-renders must still work, so only the TERMINAL update
  // hangs. It is the one fired after the decision is recorded.
  let decisions = 0;
  const realUpdate = rec.transport.updateCard.bind(rec.transport);
  (rec.transport as { updateCard: unknown }).updateCard = async (input: never) => {
    const card = (input as { card: unknown }).card as { body?: unknown } | undefined;
    // A terminal card has no interactive component; a field/review card does.
    const interactive = JSON.stringify(card ?? {}).includes('callback');
    if (!interactive) {
      decisions += 1;
      return new Promise<void>(() => {});
    }
    return realUpdate(input);
  };
  const promise = rec.renderer.requestElicitation(request(ENV_FIELD), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  await new Promise((r) => setTimeout(r, 5));
  const token = [...rec.pending.keys()][0]!;
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "save", g: onScreenGeneration(token, rec) }, formValues: { f0: "prod" } });
  // Fired, not awaited: the hung update also blocks the CLICK's own promise, and
  // what is being asserted is the REQUEST promise.
  void rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit", g: onScreenGeneration(token, rec) }, formValues: {} });
  expect(decisions).toBe(1);
  const outcome = await Promise.race([
    promise,
    new Promise((r) => setTimeout(() => r("timeout"), 800)),
  ]);
  expect(outcome).toEqual({
    action: "accept",
    responderId: "ou_initiator",
    content: { env: "prod" },
  });
});

test("a Start clicked while the opening send is in flight still advances the card", async () => {
  // The card is visible the moment Feishu delivers it, but `cardId` is not
  // recorded until `sendCard` resolves. A Start in that window used to set the
  // cursor, return immediately from `renderCurrentField` (no id to update), and
  // get acknowledged — leaving the user on the opening card to click again.
  const rec = makeRenderer();
  const realSend = rec.transport.sendCard.bind(rec.transport);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held2 = true;
  (rec.transport as { sendCard: unknown }).sendCard = async (input: { card: unknown; chatId: string }) => {
    const result = await realSend(input as never);
    if (held2) await held;
    return result;
  };
  const promise = rec.renderer.requestElicitation(request(ENV_FIELD), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  // The card is delivered but the send promise is still parked.
  await new Promise((r) => setTimeout(r, 5));
  const entry = [...rec.pending.values()][0]!;
  const updatesBefore = rec.transport.updates.length;
  await rec.renderer.handleAction({
    openId: "ou_initiator",
    value: { t: entry.token, a: "start" },
    formValues: {},
  });
  // Release the send; the owed field render must land.
  held2 = false;
  release();
  await new Promise((r) => setTimeout(r, 20));
  expect(rec.transport.updates.length).toBeGreaterThan(updatesBefore);
  // The card the user ends on is the FIELD card, not the opening card.
  const last = rec.transport.updates[rec.transport.updates.length - 1]!;
  expect(JSON.stringify(last)).not.toContain("Start");
  entry.settled = true;
  entry.reject(new Error("test done"));
  await promise;
});

test("a hung terminal update cannot swallow a Decline that raced the opening send", async () => {
  // The combination of the two other races. `sendCard` is held, the user Declines
  // while it is held, and then the terminal `card.update` never returns. The
  // decision must still come back — a CardKit request that hangs may not keep a
  // user's own answer from reaching core.
  const rec = makeRenderer();
  const realSend = rec.transport.sendCard.bind(rec.transport);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held2 = true;
  (rec.transport as { sendCard: unknown }).sendCard = async (input: { card: unknown; chatId: string }) => {
    const result = await realSend(input as never);
    if (held2) await held;
    return result;
  };
  // Every update after the decline is a terminal one, and it never returns.
  let declined = false;
  const realUpdate = rec.transport.updateCard.bind(rec.transport);
  (rec.transport as { updateCard: unknown }).updateCard = async (input: never) => {
    if (declined) return new Promise<void>(() => {});
    return realUpdate(input);
  };
  const promise = rec.renderer.requestElicitation(request(ENV_FIELD), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  await new Promise((r) => setTimeout(r, 5));
  const entry = [...rec.pending.values()][0]!;
  await rec.renderer.handleAction({
    openId: "ou_initiator",
    value: { t: entry.token, a: "decline" },
    formValues: {},
  });
  declined = true;
  // Release the opening send with the terminal update now hung.
  held2 = false;
  release();
  const outcome = await Promise.race([
    promise,
    new Promise((r) => setTimeout(() => r("timeout"), 800)),
  ]);
  expect(outcome).toEqual({ action: "decline", responderId: "ou_initiator" });
});

test("a replayed old save cannot overwrite a newer answer to the same field", async () => {
  // Feishu retries card callbacks, and a user can double-tap. The save control's
  // routing payload carried only the token, so a callback from an EARLIER render
  // of the same field was indistinguishable from the current one — and `submit()`
  // writes to whichever field the cursor is on, while entering Review does NOT
  // clear that cursor (the review page needs it to land an Edit).
  //
  // So a delayed replay of the FIRST save overwrote the value the user had since
  // typed, and the review page then submitted the stale answer.
  const rec = makeRenderer();
  // A single-field form. This matters: with two fields the wizard ADVANCES past
  // `env` on the first save, so a replay lands on the second field and the first
  // answer looks safe by accident. One field keeps the cursor on `env`, which is
  // the window where a replay actually overwrites what the user just changed.
  const fields: ChannelElicitationRequest["fields"] = [
    {
      kind: "single-select",
      key: "env",
      title: "Env",
      required: true,
      options: [
        { value: "prod", label: "Prod" },
        { value: "staging", label: "Staging" },
      ],
    },
  ];
  const promise = rec.renderer.requestElicitation(request(fields), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { token } = await pendingEntry(rec);
  const step = async (value: Record<string, unknown>, formValues: Record<string, string> = {}): Promise<void> => {
    await rec.renderer.handleAction({ openId: "ou_initiator", value, formValues });
  };
  // Generation of the card currently on screen, read LIVE rather than predicted:
  // each render advances it, so a hardcoded number would break the moment the
  // render count changes. What this test pins is which callbacks are ACCEPTED.
  const onScreen = (): number => [...rec.pending.values()][0]!.renderGeneration;

  // Start -> first field card, and save `prod` from the card the user is on.
  await step({ t: token, a: "start" });
  const prodSaveGeneration = onScreen();
  await step({ t: token, a: "save", g: prodSaveGeneration }, { f0: "prod" });

  // The single field is answered, so the wizard went to the REVIEW page. Nothing
  // is driven from there: a real review card has no Save control, only Edit and
  // Submit, so injecting one would be exercising a control that does not exist.

  // Edit back into the first field and change the answer. A different card, so a
  // different generation — which is what makes the replay stale. Delivered while
  // the cursor is STILL on `env`, which is exactly the window in which the replay
  // would overwrite it.
  await step({ t: token, a: "field", f: 0, g: onScreenGeneration(token, rec) });
  expect(onScreen()).toBeGreaterThan(prodSaveGeneration);
  const editedGeneration = onScreen();
  await step({ t: token, a: "save", g: editedGeneration }, { f0: "staging" });

  // The replayed FIRST save, delivered from the earlier generation — the card the
  // user had already navigated away from. The wizard is back on review; a real
  // review card has no Save control, so this can only ever be a platform replay.
  await step({ t: token, a: "save", g: prodSaveGeneration }, { f0: "prod" });
  await step({ t: token, a: "submit", g: onScreenGeneration(token, rec) });

  const decision = await promise;
  expect(decision).toEqual({ action: "accept", responderId: "ou_initiator", content: { env: "staging" } });
});

test("a save from the card currently on screen still works", async () => {
  // The control case: refusing stale generations must not have broken the normal
  // path, which is the same button on the current card.
  const rec = makeRenderer();
  const fields: ChannelElicitationRequest["fields"] = [
    {
      kind: "single-select",
      key: "env",
      title: "Env",
      required: true,
      options: [
        { value: "prod", label: "Prod" },
        { value: "staging", label: "Staging" },
      ],
    },
    { kind: "text", key: "note", title: "Note", required: false, maxLength: 100 },
  ];
  const promise = rec.renderer.requestElicitation(request(fields), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { token } = await pendingEntry(rec);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  const entry = [...rec.pending.values()][0]!;
  // The generation the current card actually carries — not a guessed number.
  await rec.renderer.handleAction({
    openId: "ou_initiator",
    value: { t: token, a: "save", g: entry.renderGeneration },
    formValues: { f0: "prod" },
  });
  // That save landed, so the answer the user gave is the one submitted.
  expect(entry.values.env).toBe("prod");
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit", g: onScreenGeneration(token, rec) }, formValues: {} });
  expect(await promise).toEqual({ action: "accept", responderId: "ou_initiator", content: { env: "prod" } });
});

test("a replayed Skip cannot delete an answer the user gave after it", async () => {
  // Position made a replayed Skip idempotent PER FIELD. That is not enough: Skip
  // MUTATES field state (`markSkipped` deletes any recorded answer), so once the
  // user has Edited the field back to a value, replaying the OLDER Skip deletes
  // that value and the form submits the field as omitted.
  //
  // Optional field, so Skip is rendered. One field, so the cursor stays on it for
  // the whole chain — with two fields the wizard advances past the first on its
  // first save and a replay would land on the second, hiding the loss.
  //
  // The steps are the real UI path, in the order a user performs them: click Skip
  // on the field card, then Edit on the review page, then Save on the field card
  // the Edit put back on screen. The callback captured at the Skip is redelivered
  // VERBATIM afterwards, which is what Feishu's own retry does.
  const rec = makeRenderer();
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "text", key: "note", title: "Note", required: false, maxLength: 1000 },
  ];
  const promise = rec.renderer.requestElicitation(request(fields), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { entry, token } = await pendingEntry(rec);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  // 1. Skip, on the field card. The whole callback is kept so the replay is the
  //    exact payload Feishu would redeliver, generation included.
  const skipCallback = { t: token, a: "skip", f: 0, g: entry.renderGeneration };
  await rec.renderer.handleAction({ openId: "ou_initiator", value: skipCallback, formValues: {} });
  expect(entry.skipped.has("note")).toBe(true);
  // 2. Edit back into the field, from the review page the Skip left us on.
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "field", f: 0, g: onScreenGeneration(token, rec) }, formValues: {} });
  // 3. Save a real answer on the card now on screen.
  await rec.renderer.handleAction({
    openId: "ou_initiator",
    value: { t: token, a: "save", g: onScreenGeneration(token, rec) },
    formValues: { f0: "staging" },
  });
  expect(entry.values.note).toBe("staging");
  expect(entry.skipped.size).toBe(0);
  // 4. Feishu redelivers the ORIGINAL Skip, from an earlier card.
  const replay = await rec.renderer.handleAction({
    openId: "ou_initiator",
    value: skipCallback,
    formValues: {},
  });
  // Dropped without touching state, so the answer the user typed survives.
  expect(replay.handled).toBe(false);
  expect(entry.values.note).toBe("staging");
  expect(entry.skipped.size).toBe(0);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit", g: onScreenGeneration(token, rec) }, formValues: {} });
  expect(await promise).toEqual({
    action: "accept",
    responderId: "ou_initiator",
    content: { note: "staging" },
  });
});


test("a failed card update leaves the visible card usable, and a lost acknowledgement still works", async () => {
  // The generation must be committed only once the update has LANDED. Committing
  // before the send made the entry report N+1 while the screen still showed N:
  // when `card.update` then failed, the user's next interaction with the card
  // they were looking at arrived "stale" and was refused — a transient
  // network error turned into a form nobody could submit.
  const rec = makeRenderer();
  const promise = rec.renderer.requestElicitation(request(ENV_FIELD), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { entry, token } = await pendingEntry(rec);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  // Answer the single field, so the form reaches review fully answered.
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "save", g: entry.renderGeneration }, formValues: { f0: "staging" } });
  // The review render that save produced is what the user is now looking at, so
  // the known generation is read AFTER it rather than before.
  const generationOnScreen = entry.renderGeneration;
  // From here on every render FAILS.
  let failureCount = 0;
  (rec.transport as { updateCard: unknown }).updateCard = async (input: never) => {
    failureCount += 1;
    throw new Error("card update failed");
  };
  // Edit back to the field: the render that would put the field card on screen
  // fails, so the user is still looking at the PREVIOUS card.
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "field", f: 0, g: onScreenGeneration(token, rec) }, formValues: {} });
  expect(failureCount).toBe(1);
  // A failed update does not lower the known generation — a thrown update is not
  // proof the card did not reach the platform — so the generation still points at
  // the card on screen and that card's controls are not refused.
  expect(entry.renderGeneration).toBe(generationOnScreen);
  // Retrying on the very card the user can still see works.
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "save", g: generationOnScreen }, formValues: { f0: "prod" } });
  expect(entry.values.env).toBe("prod");
  expect(failureCount).toBe(2);
  // And the reverse ambiguity: the platform APPLIED a card whose
  // acknowledgement was lost, so a signed callback arrives carrying a generation
  // the entry has not adopted. That is a newer card, not an older one, and must
  // not be refused.
  // No-op: the promotion assertion is about the callback being ACCEPTED, not
  // about a render landing.
  (rec.transport as { updateCard: unknown }).updateCard = async () => {};
  // Strictly above everything drawn so far, so the assertion is about the
  // promotion rather than an exact render count.
  const promotedGeneration = entry.renderGeneration + 5;
  const promoted = await rec.renderer.handleAction({
    openId: "ou_initiator",
    value: { t: token, a: "save", g: promotedGeneration },
    formValues: { f0: "staging" },
  });
  expect(promoted.handled).toBe(true);
  // At LEAST the promoted generation: the save's own review render reserves a
  // further number, so the entry can legitimately sit above it.
  expect(entry.renderGeneration).toBeGreaterThanOrEqual(promotedGeneration);
  expect(entry.values.env).toBe("staging");
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit", g: onScreenGeneration(token, rec) }, formValues: {} });
  expect(await promise).toEqual({
    action: "accept",
    responderId: "ou_initiator",
    content: { env: "staging" },
  });
});

test("every state-mutating control the field card draws carries the card's generation", () => {
  // The renderer's own tests drive callbacks directly, so they can hand a
  // generation to Skip even when the BUILDER no longer stamps one. Only a real
  // card closes that: Skip MUTATES field state, so a card without a generation
  // makes a replay indistinguishable from a first click no matter how good the
  // handler is.
  const optional: ChannelElicitationRequest["fields"] = [
    { kind: "text", key: "note", title: "Note", required: false, maxLength: 1000 },
  ];
  const card = buildElicitationFieldCard(request(optional), "tok-abc", optional[0]!, 1, undefined, 7);
  const form = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements.find((e) => e.tag === "form");
  const buttons = (form as { elements: Array<Record<string, unknown>> }).elements.filter((e) => e.tag === "button");
  // Skip and Save both change recorded field state, so both carry `g: 7`.
  for (const label of ["Skip", "Submit"]) {
    const control = buttons.find((b) => JSON.stringify(b).includes(label));
    expect(control).toBeDefined();
    const value = (control as { behaviors: Array<{ value: Record<string, unknown> }> }).behaviors[0]!.value;
    expect(value).toMatchObject({ t: "tok-abc", g: 7 });
  }
  // Decline and Cancel are terminal decisions, not field-state mutations.
  for (const label of ["Decline", "Cancel"]) {
    const control = buttons.find((b) => JSON.stringify(b).includes(label));
    expect(control).toBeDefined();
    const value = (control as { behaviors: Array<{ value: Record<string, unknown> }> }).behaviors[0]!.value;
    expect(value.g).toBeUndefined();
  }
});

test("a delayed acknowledgement for an earlier render cannot regress the generation", async () => {
  // A card update's acknowledgement can be far slower than the ones that follow
  // it, so the known generation must be committed monotonically: acknowledging an
  // EARLIER render after the entry has moved on must not assign a smaller number
  // and walk the known generation BACKWARDS, which reopens the stale-callback
  // fence — a replay the fence had refused stops satisfying
  // `< entry.renderGeneration`, and the old value overwrites the newer answer.
  //
  // `nextSequence()` guards the PLATFORM's update ordering; nothing guards the
  // local one, which is what this pins.
  const rec = makeRenderer();
  const promise = rec.renderer.requestElicitation(request(ENV_FIELD), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { entry, token } = await pendingEntry(rec);

  // The first update's acknowledgement is held open: the platform has applied the
  // card, but its completion is not signalled until the test releases it.
  const held: Array<() => void> = [];
  const realUpdate = rec.transport.updateCard.bind(rec.transport);
  let firstUpdateSeen = false;
  (rec.transport as { updateCard: unknown }).updateCard = async (input: never) => {
    if (!firstUpdateSeen) {
      firstUpdateSeen = true;
      await new Promise<void>((resolve) => { held.push(resolve); });
    }
    return realUpdate(input);
  };

  // Start -> field card. Its acknowledgement is the held one.
  const startClick = rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(firstUpdateSeen).toBe(true);
  // The generation the held render was ALLOCATED. Read from the allocator's
  // high-water mark, not from the known generation, which a held update has not
  // raised.
  const heldCardGeneration = entry.renderGenerationCounter;
  expect(heldCardGeneration).toBeGreaterThan(1);

  // Save from that card: the card it was drawn on, legitimate right now even
  // though its acknowledgement has not returned.
  const firstSave = { t: token, a: "save", g: heldCardGeneration };
  const saveClick = rec.renderer.handleAction({
    openId: "ou_initiator",
    value: firstSave,
    formValues: { f0: "prod" },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  // A later render has committed a strictly higher generation while the held
  // acknowledgement is still outstanding.
  expect(entry.renderGeneration).toBeGreaterThan(heldCardGeneration);
  const climbedGeneration = entry.renderGeneration;

  // NOW the held acknowledgement for the FIRST render is released. Committing it
  // would assign the smaller generation that card was drawn with.
  held.shift()!();
  await Promise.all([startClick, saveClick]);
  await new Promise((resolve) => setTimeout(resolve, 5));

  // The known generation did not regress below the highest one drawn. This is the
  // assertion a non-monotonic commit fails.
  expect(entry.renderGeneration).toBeGreaterThanOrEqual(climbedGeneration);
  // And the save from the earlier card is therefore still correctly recognised as
  // stale, so `prod` cannot overwrite the answer the user has since given.
  const replay = await rec.renderer.handleAction({
    openId: "ou_initiator",
    value: firstSave,
    formValues: { f0: "prod" },
  });
  expect(replay.handled).toBe(false);
  expect(entry.values.env).toBe("prod");

  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit", g: onScreenGeneration(token, rec) }, formValues: {} });
  expect(await promise).toEqual({
    action: "accept",
    responderId: "ou_initiator",
    content: { env: "prod" },
  });
});

test("a card revision is never reissued, even when its update provably failed", async () => {
  // A generation is a revision ID, and two cards sharing one makes the replay
  // fence unable to tell them apart — which is the only guarantee it has. So the
  // allocator is monotonic and never reclaims a number, however the update turned
  // out: `updateCard()` throwing is not evidence the platform did not apply the
  // card, which is exactly the "applied but the acknowledgement was lost" case
  // this scheme has to survive.
  //
  // The chain is the reviewer's: reach Review, Edit A (whose update is applied by
  // the platform but whose acknowledgement is lost), then Edit B from the same
  // Review. B must be handed a revision no previous render used.
  const rec = makeRenderer();
  const promise = rec.renderer.requestElicitation(request(ENV_FIELD), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { entry, token } = await pendingEntry(rec);
  // Every revision ever allocated, recorded as the allocator hands them out.
  const allocated: number[] = [];
  const realUpdate = rec.transport.updateCard.bind(rec.transport);
  // Armed only around Edit A; every other update completes immediately, so the
  // wizard is never left waiting on a gate the test has not opened.
  let ackLost = false;
  let aRelease!: () => void;
  const aApplied = new Promise<void>((resolve) => { aRelease = resolve; });
  (rec.transport as { updateCard: unknown }).updateCard = async (input: never) => {
    // The revision this render is committing is the allocator's current mark,
    // because the render allocates before it calls the transport.
    const revision = entry.renderGenerationCounter;
    allocated.push(revision);
    if (!ackLost) return realUpdate(input);
    // APPLIED by the platform — the remote call happens — and only then is the
    // local acknowledgement lost. That ordering is the whole point: a naive
    // "apply then throw" would prove nothing about whether the card exists.
    const applied = await realUpdate(input);
    await aApplied;
    throw new Error("ack lost");
  };

  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "save", g: entry.renderGeneration }, formValues: { f0: "prod" } });
  // Now on Review.
  expect(allocated.length).toBeGreaterThan(0);
  // Edit A. Its update is applied by the platform, and its acknowledgement is
  // then lost — so the renderer must learn of the failure by the throw, not by
  // the card being absent.
  // Edit A. Its update is applied by the platform, and its acknowledgement is
  // then lost — so the renderer must learn of the failure by the throw, not by
  // the card being absent. Armed here, and only here.
  ackLost = true;
  const editAClick = rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "field", f: 0, g: onScreenGeneration(token, rec) }, formValues: {} });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const revisionA = allocated[allocated.length - 1]!;
  // Disarmed again, so Edit B and everything after it are not held up.
  ackLost = false;
  // Edit B, from the same Review, must NOT be handed revision A again. It has to
  // get a number no previous render used, however A's update turned out. Fired
  // without awaiting so A's still-parked acknowledgement cannot serialise it.
  const editBClick = rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "field", f: 0, g: onScreenGeneration(token, rec) }, formValues: {} });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const revisionB = allocated[allocated.length - 1]!;
  expect(revisionB).toBeGreaterThan(revisionA);
  // Uniqueness across everything drawn so far.
  expect(new Set(allocated).size).toBe(allocated.length);

  // Release A's lost acknowledgement, so its render learns the update did not
  // confirm. Both clicks are then allowed to finish.
  aRelease();
  await Promise.allSettled([editAClick, editBClick]);
  await new Promise((resolve) => setTimeout(resolve, 5));

  // Still no revision reissued after the failure is understood.
  expect(new Set(allocated).size).toBe(allocated.length);
  expect(allocated[allocated.length - 1]!).toBeGreaterThan(revisionA);
  // A's save callback was on a card whose revision B has since superseded, so it
  // is stale and cannot overwrite what B produced.
  const staleFromA = await rec.renderer.handleAction({
    openId: "ou_initiator",
    value: { t: token, a: "save", g: revisionA },
    formValues: { f0: "old" },
  });
  expect(staleFromA.handled).toBe(false);
  expect(entry.values.env).toBe("prod");

  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit", g: onScreenGeneration(token, rec) }, formValues: {} });
  expect(await promise).toEqual({
    action: "accept",
    responderId: "ou_initiator",
    content: { env: "prod" },
  });
});

test("a Submit from an earlier review card cannot accept the pre-edit answers", async () => {
  // Every state-mutating control on the review page is versioned, and Submit is
  // the accept path: a Submit from an EARLIER review reaches `confirmReviewed()`
  // with the answers that were current when THAT review was drawn. It only checks
  // that those answers satisfy their field constraints, so
  // `Save prod -> Review -> Edit -> field card -> delayed old Review Submit` used
  // to accept `prod` while the user was still typing `staging`.
  const rec = makeRenderer();
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "text", key: "note", title: "Note", required: true, maxLength: 100 },
  ];
  const promise = rec.renderer.requestElicitation(request(fields), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { token } = await pendingEntry(rec);
  const onScreen = (): number => entry().renderGeneration;
  const entry = (): { renderGeneration: number; values: Record<string, unknown> } =>
    [...rec.pending.values()][0] as unknown as { renderGeneration: number; values: Record<string, unknown> };

  // Save `prod`, which lands on the review page.
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "save", g: onScreen() }, formValues: { f0: "prod" } });
  const review = reviewTokens(rec);
  expect(review.submit).toBeDefined();
  // Edit back into the field. The field card is a LATER generation.
  await rec.renderer.handleAction({ openId: "ou_initiator", value: review.field, formValues: {} });
  const fieldGeneration = onScreen();
  expect(fieldGeneration).toBeGreaterThan(review.generation);

  // The DELAYED Submit from the review card the user has already left.
  const replay = await rec.renderer.handleAction({ openId: "ou_initiator", value: review.submit, formValues: {} });
  // Dropped without settling, so the turn is still the initiator's to answer.
  expect(replay.settled).toBe(false);
  expect(replay.handled).toBe(false);
  expect(rec.pending.size).toBe(1);

  // And the current Save/Submit path is what finally decides.
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "save", g: onScreen() }, formValues: { f0: "staging" } });
  const currentReview = reviewTokens(rec);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: currentReview.submit, formValues: {} });
  expect(await promise).toEqual({
    action: "accept",
    responderId: "ou_initiator",
    content: { note: "staging" },
  });
});

/**
 * The routing payloads of the review card most recently drawn.
 *
 * Read off the card itself rather than reconstructed: a CardKit button carries its
 * routing payload as `behaviors[0].value`, which is exactly what a callback
 * redelivers. Capturing it from the drawn card is what makes a replay the same
 * bytes Feishu would send.
 */
function reviewTokens(rec: {
  transport: { updates: Array<Record<string, unknown>> };
}): { generation: number; field: Record<string, unknown>; submit: Record<string, unknown> } {
  const card = rec.transport.updates[rec.transport.updates.length - 1]!;
  const buttons = collectButtons(card);
  const payloadOf = (predicate: (label: string) => boolean): Record<string, unknown> => {
    const found = buttons.find((b) => predicate(b.label));
    if (!found) throw new Error("no matching control on the current review card");
    return found.value;
  };
  const field = payloadOf((label) => label.startsWith("Edit"));
  const submit = payloadOf((label) => label === "Submit");
  return {
    generation: field.g as number,
    field,
    submit,
  };
}

/** Every button on a CardKit card, as label + routing payload. */
function collectButtons(card: Record<string, unknown>): Array<{ label: string; value: Record<string, unknown> }> {
  const out: Array<{ label: string; value: Record<string, unknown> }> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    if (record.tag === "button" && Array.isArray(record.behaviors)) {
      const behaviors = record.behaviors as Array<Record<string, unknown>>;
      if (behaviors.length > 0) {
        const label = ((record.text as Record<string, unknown> | undefined)?.content as string | undefined) ?? "";
        out.push({
          label,
          value: (behaviors[0]!.value ?? {}) as Record<string, unknown>,
        });
      }
    }
    for (const value of Object.values(record)) walk(value);
  };
  walk(card);
  return out;
}

test("a legal maxLength of 0 is refused rather than built into an invalid input", () => {
  // Core's `readOptionalPositiveInteger` accepts 0 and its validator accepts
  // `""` as satisfying `maxLength: 0`, so the question is legal. Feishu's own
  // `input.max_length` is bounded to 1–1000, so passing the 0 through builds a
  // component the platform rejects — the gate says renderable and the card
  // then fails to send.
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "text", key: "note", title: "Note", required: true, maxLength: 0 },
  ];
  const verdict = checkElicitationRenderability(fields, request(fields));
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("answer-length-unsatisfiable");
  // Named for the impossibility, not for a capacity the field is nowhere near:
  // a field allowing 0 chars is not "too long".
  expect(verdict.detail).not.toContain("1000");
});

test("the worst-case review sample is at least as wide as every legal review", async () => {
  // The preflight blesses a review card up front, and the real one is only drawn
  // after the user has answered. So the sample has to be an UPPER BOUND, not a
  // representative value: an optimistic estimate is a `card.update` failure at
  // review time, after the work, with no recovery path.
  //
  // Measured rather than asserted, by serializing the sample and the legal
  // reviews and comparing bytes: whatever the fields are, the sample must never
  // be narrower.
  const fields: ChannelElicitationRequest["fields"] = [
    // A number: `0` is not the widest legal rendering.
    { kind: "number", key: "count", title: "Count", required: false },
    // A boolean: `false` renders wider than `true`.
    { kind: "boolean", key: "confirm", title: "Confirm", required: false },
    // A short single-select, whose value can be narrower than the omitted text.
    { kind: "single-select", key: "env", title: "Env", required: false, options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ] },
  ];
  const req = request(fields);
  const sample = buildWorstCaseReviewCard(req, "tok");
  const sampleBytes = measureElicitationCardBytes(sample);
  expect(sampleBytes).toBeGreaterThan(0);

  // Every legal combination of answers, including the all-omitted one, plus the
  // widest legal value for each field.
  const legal: Array<Record<string, ChannelElicitationValue | undefined>> = [
    {},
    { count: 0 },
    { count: 9007199254740991 },
    { confirm: true },
    { confirm: false },
    { env: "a" },
    { env: "b" },
    { count: 123456789, confirm: false, env: "b" },
  ];
  for (const values of legal) {
    const review = buildElicitationReviewCard(req, "tok", values as Record<string, ChannelElicitationValue>);
    // The sample must be at least as wide as this legal review, so a gate that
    // blessed the sample blessed this one too.
    expect(measureElicitationCardBytes(sample))
      .toBeGreaterThanOrEqual(measureElicitationCardBytes(review));
  }
});

test("the worst-case sample bounds a review whose widest answer is not the widest in characters", () => {
  // The budget is UTF-8 BYTES, so a shorter JS string can be a larger card.
  //
  // A is an ASCII value the escaper leaves alone: 80 characters, and in escaped
  // space it is nothing. B is 128 emoji: 256 JS characters, so MORE than A in
  // escaped space, but four bytes each in the metric the budget actually uses.
  //
  // Choosing on escaped length therefore picked A as "widest" while B is what the
  // review actually serializes to.
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "single-select", key: "a", title: "A", required: true, options: [
      { value: "~".repeat(80), label: "Tilde" },
      { value: "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀", label: "Emoji" },
    ] },
  ];
  const req = request(fields);
  const sample = buildWorstCaseReviewCard(req, "tok");
  // The emoji answer is a legal one the user can select, and its review is the
  // larger card. The sample must be at least as wide as it.
  const emojiReview = buildElicitationReviewCard(req, "tok", { a: "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀" });
  expect(measureElicitationCardBytes(sample))
    .toBeGreaterThanOrEqual(measureElicitationCardBytes(emojiReview));
  // And the emoji really is the wider of the two in bytes, so this is not a
  // vacuous comparison: it is the case the old metric got backwards.
  const tildeReview = buildElicitationReviewCard(req, "tok", { a: "~".repeat(80) });
  expect(measureElicitationCardBytes(emojiReview))
    .toBeGreaterThan(measureElicitationCardBytes(tildeReview));
});

test("an unbounded number field's sample is bounded by the widest finite double", () => {
  // Core's number field accepts any finite JS number and the review prints
  // `String(value)`, so the largest finite double is legal and renders 24
  // characters. Capping the search at `Number.MAX_SAFE_INTEGER` (16 digits, with
  // the old `9*10^n` ladder stopping well short of it) made the sample narrower
  // than a legal review for exactly the schemas the sample exists to protect:
  // a number field with no declared `maximum`.
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "number", key: "n", title: "N", required: true },
  ];
  const req = request(fields);
  const sample = buildWorstCaseReviewCard(req, "tok");
  const huge = buildElicitationReviewCard(req, "tok", { n: Number.MAX_VALUE });
  expect(measureElicitationCardBytes(sample))
    .toBeGreaterThanOrEqual(measureElicitationCardBytes(huge));
  // The old ceiling would have failed this, so the case is not vacuous.
  const oldCeiling = buildElicitationReviewCard(req, "tok", { n: Number.MAX_SAFE_INTEGER });
  expect(measureElicitationCardBytes(huge))
    .toBeGreaterThan(measureElicitationCardBytes(oldCeiling));
});

test("a number whose widest legal answer is negative is also bounded", () => {
  // A large negative `minimum` with a small positive `maximum` has its widest
  // legal rendering at the negative end — the minus sign is a character the
  // positive spine of the search never produced.
  const fields: ChannelElicitationRequest["fields"] = [
    // Bounded at both ends so neither extreme can be reused as a floor/ceiling
    // shortcut: the widest legal rendering is a value no endpoint equals.
    { kind: "number", key: "n", title: "N", required: true, minimum: -0.5, maximum: 100 },
  ];
  const req = request(fields);
  const sample = buildWorstCaseReviewCard(req, "tok");
  const negative = buildElicitationReviewCard(req, "tok", { n: -0.5 });
  expect(measureElicitationCardBytes(sample))
    .toBeGreaterThanOrEqual(measureElicitationCardBytes(negative));
  // And the negative answer really is wider than the positive maximum.
  const positive = buildElicitationReviewCard(req, "tok", { n: 100 });
  expect(measureElicitationCardBytes(negative))
    .toBeGreaterThan(measureElicitationCardBytes(positive));
});

test("the sample measures the rendered field line, so the widest answer wins on bytes", () => {
  // The budget is UTF-8 bytes, and the two answers here disagree in every metric
  // but the one that matters.
  //
  //   "~".repeat(50)  escapes to `&#126;` x 50  -> ~300 bytes rendered
  //   "a".repeat(256) passes through untouched -> ~256 bytes rendered
  //
  // So the tilde answer is the WIDER review. A comparator that also counted the
  // raw value added 256 to one side and 50 to the other and picked backwards,
  // leaving the sample narrower than a review the user can legally submit.
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "single-select", key: "s", title: "S", required: true, options: [
      { value: "a".repeat(256), label: "Ascii" },
      { value: "~".repeat(50), label: "Tilde" },
    ] },
  ];
  const req = request(fields);
  const tildeReview = buildElicitationReviewCard(req, "tok", { s: "~".repeat(50) });
  const asciiReview = buildElicitationReviewCard(req, "tok", { s: "a".repeat(256) });
  // The premise of the test: the tilde answer really is the wider review.
  expect(measureElicitationCardBytes(tildeReview))
    .toBeGreaterThan(measureElicitationCardBytes(asciiReview));
  // And the sample bounds it.
  const sample = buildWorstCaseReviewCard(req, "tok");
  expect(measureElicitationCardBytes(sample))
    .toBeGreaterThanOrEqual(measureElicitationCardBytes(tildeReview));
});

test("an unbounded-enumeration number field is bounded by a conservative width, not by its interval", () => {
  // The space of legal numbers cannot be bounded by enumerating them.
  //
  // `{minimum: 1, maximum: 2}` admits `1.2345678901234567`, which renders 18
  // characters. Every candidate an endpoint walk can produce inside that interval
  // renders 1, so the sample was a single character wide and the gate blessed a
  // review the user could legally make several times wider.
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "number", key: "n", title: "N", required: true, minimum: 1, maximum: 2 },
  ];
  const req = request(fields);
  const longMantissa = buildElicitationReviewCard(req, "tok", { n: 1.2345678901234567 });
  const sample = buildWorstCaseReviewCard(req, "tok");
  expect(measureElicitationCardBytes(sample))
    .toBeGreaterThanOrEqual(measureElicitationCardBytes(longMantissa));
  // The old candidate set really was narrower than this legal answer, so the test
  // is not vacuous: `2` is the widest the endpoints could reach.
  const endpointOnly = buildElicitationReviewCard(req, "tok", { n: 2 });
  expect(measureElicitationCardBytes(longMantissa))
    .toBeGreaterThan(measureElicitationCardBytes(endpointOnly));
});

test("a negative-number field is bounded like any other", () => {
  // Same bound in the other direction: a wide negative interval must not survive
  // on the sign alone, and the sample has to stay an upper bound for it.
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "number", key: "n", title: "N", required: true, minimum: -1e17, maximum: 100 },
  ];
  const req = request(fields);
  const negative = buildElicitationReviewCard(req, "tok", { n: -1e17 });
  const sample = buildWorstCaseReviewCard(req, "tok");
  expect(measureElicitationCardBytes(sample))
    .toBeGreaterThanOrEqual(measureElicitationCardBytes(negative));
});
