import { beforeAll, expect, test } from "bun:test";

import { DiscordChannel } from "../../../../packages/channel-discord/src/channel";
import type { DiscordClientLike } from "../../../../packages/channel-discord/src/discord-client";
import type {
  DiscordButtonInteraction,
  DiscordModalSubmitInteraction,
  DiscordSelectActionRow,
  DiscordSelectInteraction,
  OutboundBody,
  ShowModalInput,
} from "../../../../packages/channel-discord/src/types";
import { setChannelLocale } from "../../../../packages/channel-discord/src/i18n";
import type { ChannelElicitationRequest } from "xacpx/plugin-api";
import type { ChannelStartInput } from "xacpx/plugin-api";

/**
 * Discord form renderer coverage: every field kind reaches the platform
 * control that can actually express it, and each answer path produces a value
 * core can validate.
 *
 * These drive the REAL channel handlers (select/modal interaction routing,
 * answer recording, submit gating) with only Discord's transport faked.
 */
beforeAll(() => {
  setChannelLocale("en");
});

function makeLogger() {
  return { info: async () => {}, warn: async () => {}, error: async () => {}, debug: async () => {} };
}

interface FakeDiscordClient extends DiscordClientLike {
  emitButton: (interaction: DiscordButtonInteraction) => void;
  emitSelect: (interaction: DiscordSelectInteraction) => void;
  emitModal: (interaction: DiscordModalSubmitInteraction) => void;
  sent: Array<{ channelId: string; body: OutboundBody }>;
  edited: Array<{ channelId: string; messageId: string; body: OutboundBody }>;
  ephemerals: string[];
  modals: ShowModalInput[];
}

function makeFakeClient(): FakeDiscordClient {
  let onButton: ((i: DiscordButtonInteraction) => void) | null = null;
  let onSelect: ((i: DiscordSelectInteraction) => void) | null = null;
  let onModal: ((i: DiscordModalSubmitInteraction) => void) | null = null;
  const sent: Array<{ channelId: string; body: OutboundBody }> = [];
  const edited: Array<{ channelId: string; messageId: string; body: OutboundBody }> = [];
  const ephemerals: string[] = [];
  const modals: ShowModalInput[] = [];
  const client: FakeDiscordClient = {
    start: async (input) => {
      onButton = input.handlers.onButton ?? null;
      onSelect = input.handlers.onSelect ?? null;
      onModal = input.handlers.onModalSubmit ?? null;
      return { botUserId: "bot1", botTag: "Bot#0001" };
    },
    probeBot: async () => ({ botUserId: "bot1", botTag: "Bot#0001" }),
    sendMessage: async (target, body) => {
      sent.push({ channelId: target.channelId, body });
      return { messageId: `m${sent.length}` };
    },
    editMessage: async (target, messageId, body) => {
      edited.push({ channelId: target.channelId, messageId, body });
    },
    deleteMessage: async () => {},
    startTyping: async () => () => {},
    addReaction: async () => {},
    destroy: async () => {},
    emitButton: (interaction) => onButton?.(interaction),
    emitSelect: (interaction) => onSelect?.(interaction),
    emitModal: (interaction) => onModal?.(interaction),
    sent,
    edited,
    ephemerals,
    modals,
  };
  return client;
}

function click(client: FakeDiscordClient, customId: string, userId = "user-A"): DiscordButtonInteraction {
  return {
    customId,
    userId,
    channelId: "c1",
    acknowledge: async () => {},
    replyEphemeral: async (t: string) => client.ephemerals.push(t),
    showModal: async (m: ShowModalInput) => client.modals.push(m),
  };
}

function select(client: FakeDiscordClient, customId: string, values: string[], userId = "user-A"): DiscordSelectInteraction {
  return {
    customId,
    userId,
    channelId: "c1",
    values,
    acknowledge: async () => {},
    replyEphemeral: async (t: string) => client.ephemerals.push(t),
  };
}

function modal(client: FakeDiscordClient, customId: string, fields: Record<string, string>, userId = "user-A"): DiscordModalSubmitInteraction {
  return {
    customId,
    userId,
    channelId: "c1",
    fields,
    acknowledge: async () => {},
    replyEphemeral: async (t: string) => client.ephemerals.push(t),
  };
}

/**
 * Find a control's custom id by action and optional field PAGE/INDEX.
 *
 * `fieldIndex` is a number, matching the codec: routing is positional, never by
 * schema key.
 */
function idFor(client: FakeDiscordClient, action: string, fieldIndex?: number): string {
  const suffix = fieldIndex !== undefined ? `${action}:${fieldIndex}` : action;
  const rows = client.edited.length > 0
    ? (client.edited[client.edited.length - 1]!.body.components ?? [])
    : (client.sent[client.sent.length - 1]?.body.components ?? []);
  const ids = rows.flatMap((r) => r.components.map((c) => c.customId));
  const found = ids.find((id) => id.endsWith(`:${suffix}`));
  if (!found) throw new Error(`no control "${suffix}" in ${ids.join(",")}`);
  return found;
}

function selectCustomIdOf(client: FakeDiscordClient, fieldKey: string): string {
  const rows: DiscordSelectActionRow[] = client.edited.length > 0
    ? (client.edited[client.edited.length - 1]!.body.selectRows ?? [])
    : (client.sent[client.sent.length - 1]?.body.selectRows ?? []);
  const selectRow = rows[0];
  if (!selectRow) throw new Error("no select row rendered on the current card");
  return selectRow.components[0]!.customId;
}

async function startChannel(client: FakeDiscordClient): Promise<{ channel: DiscordChannel; abort: AbortController }> {
  const abort = new AbortController();
  const channel = new DiscordChannel(
    { token: "x", dmPolicy: "open", guildPolicy: "open", requireMention: false, enableAutocomplete: false },
    { logger: makeLogger() as never, createClient: () => client, identifyStaggerMs: 0 },
  );
  const startPromise = channel.start({
    logger: makeLogger(),
    abortSignal: abort.signal,
    agent: { chat: async () => ({ text: "ok" }) },
    activeTurns: null,
    sessions: null,
    quota: { onInbound: () => {} },
    locale: "en",
  } as unknown as ChannelStartInput);
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await channel.sendCoordinatorMessage({ chatKey: "discord:default:g:__probe__", text: "" });
      break;
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("not started"))) throw error;
    }
    if (Date.now() > deadline) throw new Error("channel did not start in time");
    await new Promise((r) => setTimeout(r, 2));
  }
  void startPromise.catch(() => {});
  return { channel, abort };
}

function request(fields: ChannelElicitationRequest["fields"]): {
  request: ChannelElicitationRequest;
  abort: AbortController;
} {
  const abort = new AbortController();
  return {
    abort,
    request: {
      requestId: "rr-1",
      chatKey: "discord:default:g:c1",
      requester: { senderId: "user-A", senderName: "Ada", isOwner: true },
      agent: { name: "codex" },
      message: "Fill this in",
      mode: "form",
      fields,
      expiresAt: Date.now() + 60_000,
      signal: abort.signal,
    },
  };
}

async function startWizard(
  client: FakeDiscordClient,
  channel: DiscordChannel,
  req: ChannelElicitationRequest,
  fieldKey: string,
): Promise<{ settled: Promise<ChannelElicitationDecision | Error> }> {
  const pending = channel.requestElicitation(req);
  // Observe the rejection so an un-settled wizard at teardown is not an
  // unhandled error, and expose it so a test can assert the decision.
  const settled = pending.then(
    (decision) => decision,
    (error: Error) => error,
  );
  const deadline = Date.now() + 5_000;
  while (client.sent.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 3));
  client.emitButton(click(client, idFor(client, "start")));
  await new Promise((r) => setTimeout(r, 5));
  // If the form has more than one field, navigate to the field under test.
  if (req.fields[0]?.key !== fieldKey) {
    const index = req.fields.findIndex((f) => f.key === fieldKey);
    for (let i = 0; i < index; i += 1) {
      // Routed by POSITION, matching the codec.
      client.emitButton(click(client, idFor(client, "edit", i)));
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  return { settled };
}

/**
 * Drive a full wizard: answer every field through its natural control, then
 * review and submit. Returns the decision (or the teardown error).
 *
 * Field order comes from the request, so a field is only ever reached from a
 * control that names its position — which is what the review-card paging exists
 * to guarantee for forms wider than one action row.
 */
async function driveToSubmit(
  client: FakeDiscordClient,
  channel: DiscordChannel,
  req: ChannelElicitationRequest,
  answers: Record<string, string>,
): Promise<ChannelElicitationDecision | Error> {
  const settled = channel.requestElicitation(req).then(
    (decision) => decision,
    (error: Error) => error,
  );
  const wait = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
  const deadline = Date.now() + 5_000;
  while (client.sent.length === 0 && Date.now() < deadline) await wait();
  client.emitButton(click(client, idFor(client, "start")));
  await wait();

  if (req.fields.length === 0) {
    // Zero-field form: Start goes straight to review, so Submit is next.
    client.emitButton(click(client, idFor(client, "submit")));
    return settled;
  }

  for (let index = 0; index < req.fields.length; index += 1) {
    const field = req.fields[index]!;
    const answer = answers[field.key];
    // The card in front of us is field `index`'s: the opening click landed on 0
    // and each iteration advanced with the previous field's forward control.
    if (answer !== undefined) {
      if (field.kind === "single-select" || field.kind === "multi-select" || field.kind === "boolean") {
        client.emitSelect(select(client, selectCustomIdOf(client, field.key), [answer]));
      } else {
        // Answer opens the modal for THIS field.
        client.emitButton(click(client, idFor(client, "field", index)));
        await wait();
        const modalId = client.modals[client.modals.length - 1]!.customId;
        client.emitModal(modal(client, modalId, { [field.key]: answer }));
      }
      await wait();
    }
    // Advance to the next field using this card's forward control. The last
    // field has none — its Next goes to review.
    if (index < req.fields.length - 1) {
      client.emitButton(click(client, idFor(client, "next", index + 1)));
      await wait();
    }
  }
  // To review, then submit.
  client.emitButton(click(client, idFor(client, "review")));
  await wait();
  client.emitButton(click(client, idFor(client, "submit")));
  return settled;
}

test("a single-select field renders a String Select with its options and selects the value", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request: req } = request([
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
    ]);
    const { settled } = await startWizard(client, channel, req, "env");
    const rows = client.edited[client.edited.length - 1]!.body.selectRows ?? [];
    expect(rows).toHaveLength(1);
    const [component] = rows[0]!.components;
    expect(component!.type).toBe(3);
    // Options are the question: both are present, neither truncated away.
    expect(component!.options.map((o) => o.value)).toEqual(["prod", "staging"]);
    expect(component!.options.map((o) => o.label)).toEqual(["Production", "Staging"]);

    // The user picks the option VALUE, and that is what the core receives.
    client.emitSelect(select(client, component!.customId, ["staging"]));
    await new Promise((r) => setTimeout(r, 5));

    // Review, then Submit: the only path to accept.
    client.emitButton(click(client, idFor(client, "review")));
    await new Promise((r) => setTimeout(r, 5));
    client.emitButton(click(client, idFor(client, "submit")));
    await new Promise((r) => setTimeout(r, 5));
    // The pending entry is gone once the decision commits, so no stale select
    // can still write into it.
    const store = (channel as unknown as { pendingElicitations: Map<string, unknown> }).pendingElicitations;
    expect([...store.values()][0]).toBeUndefined();
    // The decision carries the answer core will validate.
    expect(await settled).toEqual({ action: "accept", responderId: "user-A", content: { env: "staging" } });
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("a multi-select renders min/max selection bounds and collects an array", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request: req } = request([
      {
        kind: "multi-select",
        key: "tags",
        title: "Tags",
        required: true,
        minItems: 1,
        maxItems: 2,
        options: [
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
          { value: "g", label: "Gamma" },
        ],
      },
    ]);
    await startWizard(client, channel, req, "tags");
    const rows = client.edited[client.edited.length - 1]!.body.selectRows ?? [];
    const [component] = rows[0]!.components;
    expect(component!.minValues).toBe(1);
    expect(component!.maxValues).toBe(2);
    client.emitSelect(select(client, component!.customId, ["a", "b"]));
    await new Promise((r) => setTimeout(r, 5));
    const store = (channel as unknown as { pendingElicitations: Map<string, { values: Record<string, unknown> }> }).pendingElicitations;
    const entry = [...store.values()][0]!;
    // A multi-select answer is an array, not a joined string.
    expect(entry.values.tags).toEqual(["a", "b"]);
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("a boolean renders Yes/No as select options and produces a boolean", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request: req } = request([
      { kind: "boolean", key: "confirm", title: "Confirm?", required: true },
    ]);
    await startWizard(client, channel, req, "confirm");
    const rows = client.edited[client.edited.length - 1]!.body.selectRows ?? [];
    const [component] = rows[0]!.components;
    expect(component!.options.map((o) => o.value)).toEqual(["true", "false"]);
    client.emitSelect(select(client, component!.customId, ["true"]));
    await new Promise((r) => setTimeout(r, 5));
    const store = (channel as unknown as { pendingElicitations: Map<string, { values: Record<string, unknown> }> }).pendingElicitations;
    const entry = [...store.values()][0]!;
    // A real boolean, not the string "true".
    expect(entry.values.confirm).toBe(true);
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("a text field opens a modal whose input ids are keys, not answers", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request: req } = request([
      { kind: "text", key: "note", title: "Note", required: true },
    ]);
    await startWizard(client, channel, req, "note");
    const answerId = idFor(client, "field", 0);
    client.emitButton(click(client, answerId));
    await new Promise((r) => setTimeout(r, 5));
    expect(client.modals).toHaveLength(1);
    const m = client.modals[0]!;
    // The modal id is the token namespace; the field identity is the input id.
    expect(m.customId.startsWith("xacpx-elicit:")).toBe(true);
    expect(m.components[0]!.component.customId).toBe("note");
    // The platform's own upper bound, since the plugin contract carries no
    // core-side string bound to forward (core validates the answer itself).
    expect(m.components[0]!.component.maxLength).toBe(4000);

    // Submitting the modal records the typed answer.
    client.emitModal(modal(client, m.customId, { note: "ship it" }));
    await new Promise((r) => setTimeout(r, 5));
    const store = (channel as unknown as { pendingElicitations: Map<string, { values: Record<string, unknown> }> }).pendingElicitations;
    const entry = [...store.values()][0]!;
    expect(entry.values.note).toBe("ship it");
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("a non-numeric answer for a number field leaves it unanswered instead of storing NaN", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request: req } = request([
      { kind: "number", key: "hours", title: "Hours", required: true },
    ]);
    await startWizard(client, channel, req, "hours");
    const answerId = idFor(client, "field", 0);
    client.emitButton(click(client, answerId));
    await new Promise((r) => setTimeout(r, 5));
    const m = client.modals[0]!;
    client.emitModal(modal(client, m.customId, { hours: "not a number" }));
    await new Promise((r) => setTimeout(r, 5));
    const store = (channel as unknown as { pendingElicitations: Map<string, { values: Record<string, unknown> }> }).pendingElicitations;
    const entry = [...store.values()][0]!;
    // No answer stored, so the submit gate still blocks: it is better to prompt
    // again than to send NaN (which serializes as null and looks like a value).
    expect(entry.values.hours).toBeUndefined();
    // A valid number is stored as a NUMBER.
    client.emitModal(modal(client, m.customId, { hours: "3" }));
    await new Promise((r) => setTimeout(r, 5));
    expect(entry.values.hours).toBe(3);
    // An integer field rejects a fraction rather than rounding it.
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("an integer field rejects a fractional answer instead of rounding it", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request: req } = request([
      { kind: "number", key: "retries", title: "Retries", required: true, integer: true },
    ]);
    await startWizard(client, channel, req, "retries");
    client.emitButton(click(client, idFor(client, "field", 0)));
    await new Promise((r) => setTimeout(r, 5));
    const m = client.modals[0]!;
    client.emitModal(modal(client, m.customId, { retries: "2.5" }));
    await new Promise((r) => setTimeout(r, 5));
    const store = (channel as unknown as { pendingElicitations: Map<string, { values: Record<string, unknown> }> }).pendingElicitations;
    const entry = [...store.values()][0]!;
    expect(entry.values.retries).toBeUndefined();
    client.emitModal(modal(client, m.customId, { retries: "4" }));
    await new Promise((r) => setTimeout(r, 5));
    expect(entry.values.retries).toBe(4);
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("a field's own numeric bounds are enforced before submit", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request: req } = request([
      { kind: "number", key: "hours", title: "Hours", required: true, minimum: 1, maximum: 8 },
    ]);
    await startWizard(client, channel, req, "hours");
    client.emitButton(click(client, idFor(client, "field", 0)));
    await new Promise((r) => setTimeout(r, 5));
    const m = client.modals[0]!;
    const store = (channel as unknown as { pendingElicitations: Map<string, { values: Record<string, unknown> }> }).pendingElicitations;
    const entry = [...store.values()][0]!;
    client.emitModal(modal(client, m.customId, { hours: "0" }));
    await new Promise((r) => setTimeout(r, 5));
    expect(entry.values.hours).toBeUndefined();
    client.emitModal(modal(client, m.customId, { hours: "9" }));
    await new Promise((r) => setTimeout(r, 5));
    expect(entry.values.hours).toBeUndefined();
    client.emitModal(modal(client, m.customId, { hours: "4" }));
    await new Promise((r) => setTimeout(r, 5));
    expect(entry.values.hours).toBe(4);
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("date/email/uri fields arrive as text and pass through for core to validate", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    // The plugin contract has exactly five kinds. ACP date/email/uri fields
    // reach the renderer as `text` with the format constraint on the ACP schema,
    // which core validates — so the renderer must NOT reject a value it does
    // not recognize the shape of.
    const { request: req } = request([
      { kind: "text", key: "mail", title: "Email", required: true },
    ]);
    await startWizard(client, channel, req, "mail");
    client.emitButton(click(client, idFor(client, "field", 0)));
    await new Promise((r) => setTimeout(r, 5));
    const m = client.modals[0]!;
    // The renderer does not pre-validate the format: core is authoritative, so
    // a deliberately malformed value is recorded as-is and core rejects it.
    client.emitModal(modal(client, m.customId, { mail: "not-an-email" }));
    await new Promise((r) => setTimeout(r, 5));
    const store = (channel as unknown as { pendingElicitations: Map<string, { values: Record<string, unknown> }> }).pendingElicitations;
    const entry = [...store.values()][0]!;
    expect(entry.values.mail).toBe("not-an-email");
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("an intruder's select or modal cannot write an answer", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request: req } = request([
      {
        kind: "single-select",
        key: "env",
        title: "Environment",
        required: true,
        options: [{ value: "prod", label: "Production" }],
      },
      { kind: "text", key: "note", title: "Note", required: true },
    ]);
    await startWizard(client, channel, req, "env");
    const rows = client.edited[client.edited.length - 1]!.body.selectRows ?? [];
    const envSelectId = rows[0]!.components[0]!.customId;

    client.emitSelect(select(client, envSelectId, ["prod"], "user-INTRUDER"));
    await new Promise((r) => setTimeout(r, 5));
    const store = (channel as unknown as { pendingElicitations: Map<string, { values: Record<string, unknown> }> }).pendingElicitations;
    const entry = [...store.values()][0]!;
    expect(entry.values.env).toBeUndefined();
    expect(client.ephemerals[0]).toContain("Only the user who started");

    // Same refusal on the modal path: the review page has a per-field Edit for
    // the text field, so navigate there, then open its modal with the field
    // card's Answer control.
    client.emitButton(click(client, idFor(client, "review")));
    await new Promise((r) => setTimeout(r, 5));
    client.emitButton(click(client, idFor(client, "edit", 1)));
    await new Promise((r) => setTimeout(r, 5));
    client.emitButton(click(client, idFor(client, "field", 1)));
    await new Promise((r) => setTimeout(r, 5));
    const m = client.modals[0]!;
    client.emitModal(modal(client, m.customId, { note: "intruder value" }, "user-INTRUDER"));
    await new Promise((r) => setTimeout(r, 5));
    expect(entry.values.note).toBeUndefined();
    // And the legitimate initiator can still answer it.
    client.emitModal(modal(client, m.customId, { note: "legit" }));
    await new Promise((r) => setTimeout(r, 5));
    expect(entry.values.note).toBe("legit");
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("an empty select is not recorded as an answer", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request: req } = request([
      {
        kind: "multi-select",
        key: "tags",
        title: "Tags",
        required: false,
        options: [{ value: "a", label: "Alpha" }],
      },
    ]);
    await startWizard(client, channel, req, "tags");
    const rows = client.edited[client.edited.length - 1]!.body.selectRows ?? [];
    client.emitSelect(select(client, rows[0]!.components[0]!.customId, []));
    await new Promise((r) => setTimeout(r, 5));
    const store = (channel as unknown as { pendingElicitations: Map<string, { values: Record<string, unknown> }> }).pendingElicitations;
    const entry = [...store.values()][0]!;
    expect(entry.values.tags).toBeUndefined();
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("a pre-set default appears selected in the select render", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request: req } = request([
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
    ]);
    await startWizard(client, channel, req, "env");
    const rows = client.edited[client.edited.length - 1]!.body.selectRows ?? [];
    const options = rows[0]!.components[0]!.options;
    // The default is VISIBLE and changeable, not silently applied.
    expect(options.find((o) => o.value === "prod")!.default).toBe(true);
    expect(options.find((o) => o.value === "staging")!.default).toBeUndefined();
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("an agent-controlled option label renders literally in the select", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request: req } = request([
      {
        kind: "single-select",
        key: "env",
        title: "Environment",
        required: true,
        options: [{ value: "prod", label: "@everyone **bold** <@123>" }],
      },
    ]);
    await startWizard(client, channel, req, "env");
    const rows = client.edited[client.edited.length - 1]!.body.selectRows ?? [];
    const [component] = rows[0]!.components;
    // Markup that could reshape the option is escaped; `@` is NOT in the
    // escaper's class, so the actual mention defense is `allowedMentions`
    // (asserted below) — the same combination permission cards rely on.
    expect(component!.options[0]!.label).toContain("\\*\\*bold\\*\\*");
    expect(component!.options[0]!.value).toBe("prod");
    expect(client.edited[client.edited.length - 1]!.body.allowedMentions?.parse).toEqual([]);
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

// --- The three flows called out as previously unproven ---------------------
//
// Before the fix the advertised `form` capability could not complete these:
// optional fields were unreachable, field 3+ had no control at all, and a
// zero-field form could not be accepted at all.

test("a required + optional form reaches BOTH fields before submitting", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request: req } = request([
      { kind: "text", key: "a", title: "A", required: true },
      { kind: "text", key: "b", title: "B", required: false },
    ]);
    const decision = await driveToSubmit(client, channel, req, { a: "alpha", b: "beta" });
    expect(decision).toEqual({
      action: "accept",
      responderId: "user-A",
      content: { a: "alpha", b: "beta" },
    });
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("a 3+ field form is completable: the third field is reachable and answerable", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    // The third field is REQUIRED, so a wizard that cannot reach it can never
    // submit: this is the shape that was previously a dead end.
    const { request: req } = request([
      { kind: "text", key: "f1", title: "F1", required: true },
      { kind: "number", key: "f2", title: "F2", required: true },
      { kind: "single-select", key: "f3", title: "F3", required: true, options: [{ value: "c", label: "C" }] },
    ]);
    const decision = await driveToSubmit(client, channel, req, { f1: "one", f2: "2", f3: "c" });
    expect(decision).toEqual({
      action: "accept",
      responderId: "user-A",
      content: { f1: "one", f2: 2, f3: "c" },
    });
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("an all-optional form submitted empty accepts with null content", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request: req } = request([
      { kind: "single-select", key: "opt1", title: "Opt 1", required: false, options: [{ value: "x", label: "X" }] },
      { kind: "text", key: "opt2", title: "Opt 2", required: false },
    ]);
    const decision = await driveToSubmit(client, channel, req, {});
    // `null` is ACP's "accept with no answers"; `{}` is a different statement.
    expect(decision).toEqual({ action: "accept", responderId: "user-A", content: null });
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("a zero-field form accepts through the review page", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request: req } = request([]);
    const decision = await driveToSubmit(client, channel, req, {});
    expect(decision).toEqual({ action: "accept", responderId: "user-A", content: null });
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("edit after review corrects a field and the correction reaches the decision", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request: req } = request([
      { kind: "text", key: "a", title: "A", required: true },
      { kind: "text", key: "b", title: "B", required: true },
    ]);
    const settled = channel.requestElicitation(req).then(
      (d) => d,
      (e: Error) => e,
    );
    const wait = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
    const deadline = Date.now() + 5_000;
    while (client.sent.length === 0 && Date.now() < deadline) await wait();

    client.emitButton(click(client, idFor(client, "start")));
    await wait();
    client.emitButton(click(client, idFor(client, "field", 0)));
    await wait();
    client.emitModal(modal(client, client.modals[0]!.customId, { a: "first" }));
    await wait();
    client.emitButton(click(client, idFor(client, "next", 1)));
    await wait();
    // Field 1's card: its Answer control opens the modal for b.
    client.emitButton(click(client, idFor(client, "field", 1)));
    await wait();
    client.emitModal(modal(client, client.modals[1]!.customId, { b: "second" }));
    await wait();

    // Review -> Edit field 0 -> correct it -> review -> submit.
    client.emitButton(click(client, idFor(client, "review")));
    await wait();
    client.emitButton(click(client, idFor(client, "edit", 0)));
    await wait();
    client.emitButton(click(client, idFor(client, "field", 0)));
    await wait();
    client.emitModal(modal(client, client.modals[2]!.customId, { a: "corrected" }));
    await wait();
    client.emitButton(click(client, idFor(client, "review")));
    await wait();
    client.emitButton(click(client, idFor(client, "submit")));
    expect(await settled).toEqual({
      action: "accept",
      responderId: "user-A",
      content: { a: "corrected", b: "second" },
    });
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("a 6-field review paginates and every field stays reachable", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const fields = Array.from(
      { length: 6 },
      (_, i) => ({ kind: "text" as const, key: `k${i}`, title: `K${i}`, required: true }),
    );
    const { request: req } = request(fields);
    const settled = channel.requestElicitation(req).then(
      (d) => d,
      (e: Error) => e,
    );
    const wait = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
    const deadline = Date.now() + 5_000;
    while (client.sent.length === 0 && Date.now() < deadline) await wait();

    client.emitButton(click(client, idFor(client, "start")));
    await wait();
    client.emitButton(click(client, idFor(client, "review")));
    await wait();

    const rowIds = (): string[] => {
      const rows = client.edited[client.edited.length - 1]!.body.components ?? [];
      return rows.flatMap((r) => r.components.map((c) => c.customId));
    };
    // Page 0 shows fewer than all fields, and the rest are reachable by paging.
    expect(rowIds().filter((id) => /:edit:[0-9]+$/.test(id)).length).toBeLessThan(6);
    expect(rowIds().some((id) => /:page:/.test(id))).toBe(true);

    let sawLast = false;
    for (let step = 0; step < 6 && !sawLast; step += 1) {
      const ids = rowIds();
      if (ids.some((id) => id.endsWith(":edit:5"))) {
        sawLast = true;
        break;
      }
      const next = ids.find((id) => /:page:[0-9]+$/.test(id) && !id.endsWith(":page:0"));
      if (!next) break;
      client.emitButton(click(client, next));
      await wait();
    }
    expect(sawLast).toBe(true);

    await channel.stop();
    await settled;
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});
