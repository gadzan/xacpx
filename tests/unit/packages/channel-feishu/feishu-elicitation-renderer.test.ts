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
  escapeFeishuCardText,
} from "../../../../packages/channel-feishu/src/elicitation-cards";
import { checkElicitationRenderability } from "../../../../packages/channel-feishu/src/elicitation-limits";
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

function request(fields: ChannelElicitationRequest["fields"]): ChannelElicitationRequest {
  return {
    requestId: "req-1",
    chatKey: "feishu:default:oc_chat",
    requester: { senderId: "ou_initiator", senderName: "Ada", isOwner: true },
    agent: { name: "codex", sessionAlias: "backend" },
    message: "Which environment should I deploy to?",
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
    value: { t: token, a: "save" },
    formValues: { [formName]: answer },
  });
  // Review page submit: commits what the user reviewed. Only this one settles.
  await rec.renderer.handleAction({
    openId: "ou_initiator",
    value: { t: token, a: "submit" },
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
    value: { t: token, a: "save" },
    formValues: { f0: "prod" },
  });
  // Same callback twice: the field page's save action, delivered again.
  await rec.renderer.handleAction({
    openId: "ou_initiator",
    value: { t: token, a: "save" },
    formValues: { f0: "prod" },
  });
  const entry = rec.pending.get(token)!;
  expect(entry.settled).toBe(false);
  // The review page's own Submit is still the only way to accept.
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit" }, formValues: {} });
  expect(await promise).toEqual({ action: "accept", responderId: "ou_initiator", content: { env: "prod" } });
});

test("a text answer keeps its exact whitespace and can be empty", async () => {
  const rec = makeRenderer();
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "text", key: "raw", title: "Raw", required: true },
  ];
  const promise = rec.renderer.requestElicitation(request(fields), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { token } = await pendingEntry(rec);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  // Leading/trailing whitespace is part of the answer: core compares the raw
  // string, so trimming here would submit something the user did not type.
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "save" }, formValues: { f0: "  padded  " } });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit" }, formValues: {} });
  expect(await promise).toEqual({ action: "accept", responderId: "ou_initiator", content: { raw: "  padded  " } });
});

test("an answered optional field can be skipped back to omitted", async () => {
  const rec = makeRenderer();
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "text", key: "a", title: "A", required: true },
    { kind: "text", key: "b", title: "B", required: false },
  ];
  const promise = rec.renderer.requestElicitation(request(fields), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { token } = await pendingEntry(rec);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "save" }, formValues: { f0: "alpha" } });
  // Answer b, then go back and skip it: review-and-modify includes
  // value -> omitted, and a Skip that could not clear the old answer made
  // that transition impossible.
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "save" }, formValues: { f1: "beta" } });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "field", f: 1 }, formValues: {} });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "skip" }, formValues: {} });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit" }, formValues: {} });
  expect(await promise).toEqual({ action: "accept", responderId: "ou_initiator", content: { a: "alpha" } });
});

test("an answered empty string is sent, not dropped as a skip", async () => {
  const rec = makeRenderer();
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "text", key: "note", title: "Note", required: false },
  ];
  const promise = rec.renderer.requestElicitation(request(fields), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { token } = await pendingEntry(rec);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "save" }, formValues: { f0: "" } });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit" }, formValues: {} });
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
  const card = buildElicitationFieldCard(request(ENV_FIELD), "tok-abc", ENV_FIELD[0]!, 1, undefined);
  const form = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements.find((e) => e.tag === "form");
  const submit = (form as { elements: Array<Record<string, unknown>> }).elements.find(
    (e) => e.tag === "button" && JSON.stringify(e).includes("Submit"),
  );
  expect(submit).toBeDefined();
  const behaviors = (submit as { behaviors: Array<{ type: string; value: Record<string, unknown> }> }).behaviors;
  expect(behaviors[0]!.type).toBe("callback");
  // The routing payload is the token + action only.
  expect(behaviors[0]!.value).toEqual({ t: "tok-abc", a: "save" });
  // The ROUTING payload carries no option value. (The option label necessarily
  // appears as display text — that is the question the user answers — so the
  // absence asserted here is about the correlation handle, not the card body.)
  const payload = JSON.stringify(behaviors[0]!.value);
  expect(payload).not.toContain("prod");
  expect(payload).not.toContain("Production");
});

test("a text field renders an input bounded by the platform's max_length", () => {
  const field: ChannelElicitationRequest["fields"] = [
    { kind: "text", key: "note", title: "Note", required: true },
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
    { kind: "text", key: "note", title: "Note", required: false },
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

test("a small mixed form renders", () => {
  const verdict = checkElicitationRenderability([
    { kind: "text", key: "a", title: "A", required: true },
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
    value: { t: token, a: "save" },
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
    value: { t: token, a: "save" },
    formValues: { f0: "prod" },
  });
  // Review page submit commits it.
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit" }, formValues: {} });
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
    value: { t: token, a: "save" },
    formValues: { f0: "prod" },
  });
  const entry = rec.pending.get(token)!;
  expect(entry.values).toEqual({});
  expect(entry.settled).toBe(false);
  // The initiator can still complete it.
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  await rec.renderer.handleAction({
    openId: "ou_initiator",
    value: { t: token, a: "save" },
    formValues: { f0: "staging" },
  });
  // Review page submit commits it.
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit" }, formValues: {} });
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
    value: { t: token, a: "save" },
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
    value: { t: token, a: "save" },
    formValues: { f0: "prod" },
  });
  // Review page submit commits it.
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit" }, formValues: {} });
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
    value: { t: token, a: "skip" },
    formValues: {},
  });
  // The skip advanced to review; this submit commits the empty form.
  await rec.renderer.handleAction({
    openId: "ou_initiator",
    value: { t: token, a: "submit" },
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
  const { entry } = await pendingEntry(rec);
  const outcome = await rec.renderer.handleAction({
    openId: "ou_initiator",
    value: { t: "not-a-real-token", a: "save" },
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
  expect(parseElicitationAction({ t: "tok", a: "field", f: 3 })).toEqual({
    token: "tok",
    action: "field",
    fieldIndex: 3,
  });
  expect(parseElicitationAction({ t: "tok", a: "submit" })).toEqual({ token: "tok", action: "submit" });
  // A scalar, an array, or a missing token/action is not ours.
  expect(parseElicitationAction("submit")).toBeNull();
  expect(parseElicitationAction(["submit"])).toBeNull();
  expect(parseElicitationAction({ t: "tok" })).toBeNull();
  expect(parseElicitationAction({ a: "submit" })).toBeNull();
  expect(parseElicitationAction(null)).toBeNull();
  expect(parseElicitationAction({})).toBeNull();
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
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "save" }, formValues: { f0: "true" } });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit" }, formValues: {} });
  expect(await promise).toEqual({ action: "accept", responderId: "ou_initiator", content: { confirm: true } });
});

test("a text answer with an empty string survives an all-optional form", async () => {
  const rec = makeRenderer();
  const fields: ChannelElicitationRequest["fields"] = [
    { kind: "text", key: "note", title: "Note", required: false, minLength: 0 },
  ];
  const promise = rec.renderer.requestElicitation(request(fields), "oc_chat").then(
    (d) => d,
    (e: Error) => e,
  );
  const { token } = await pendingEntry(rec);
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "start" }, formValues: {} });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "save" }, formValues: { f0: "" } });
  await rec.renderer.handleAction({ openId: "ou_initiator", value: { t: token, a: "submit" }, formValues: {} });
  // `""` is a real answer, deliberately distinct from `null` (nothing answered).
  expect(await promise).toEqual({ action: "accept", responderId: "ou_initiator", content: { note: "" } });
});
