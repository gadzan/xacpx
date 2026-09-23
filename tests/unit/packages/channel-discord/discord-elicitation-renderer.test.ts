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
  deleted: string[];
  ephemerals: string[];
  modals: ShowModalInput[];
}

function makeFakeClient(): FakeDiscordClient {
  let onButton: ((i: DiscordButtonInteraction) => void) | null = null;
  let onSelect: ((i: DiscordSelectInteraction) => void) | null = null;
  let onModal: ((i: DiscordModalSubmitInteraction) => void) | null = null;
  const sent: Array<{ channelId: string; body: OutboundBody }> = [];
  const edited: Array<{ channelId: string; messageId: string; body: OutboundBody }> = [];
  const deleted: string[] = [];
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
    deleteMessage: async (_target, messageId) => {
      deleted.push(messageId);
    },
    startTyping: async () => () => {},
    addReaction: async () => {},
    destroy: async () => {},
    emitButton: (interaction) => onButton?.(interaction),
    emitSelect: (interaction) => onSelect?.(interaction),
    emitModal: (interaction) => onModal?.(interaction),
    sent,
    edited,
    deleted,
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

/**
 * A modal submit.
 *
 * The payload keys are POSITIONAL component ids (`f:<index>`), matching what the
 * channel builds: core allows a 128-character schema key and Discord caps
 * component ids at 100, so carrying the key would make some legal forms'
 * modals unopenable. `fieldIndex` names the single Text Input the modal holds.
 */
function modal(
  client: FakeDiscordClient,
  customId: string,
  fields: Record<string, string>,
  userId = "user-A",
  fieldIndex = 0,
): DiscordModalSubmitInteraction {
  const positional: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    // A caller passing an already-positional key is honoured verbatim.
    positional[key.startsWith("f:") ? key : `f:${fieldIndex}`] = value;
  }
  return {
    customId,
    userId,
    channelId: "c1",
    fields: positional,
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
        client.emitModal(modal(client, modalId, { [field.key]: answer }, "user-A", index));
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

test("a text field opens a modal whose input ids are positional, not keys or answers", async () => {
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
    // Positional, NOT the schema key: core allows a 128-char key and Discord
    // caps component ids at 100, so a legal long key made this modal unopenable.
    expect(m.components[0]!.component.customId).toBe("f:0");
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

test("a long schema key still opens a modal, because the id is positional", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    // Core allows a bounded 128-char JSON property name. Discord caps component
    // custom ids at 100, so a key-derived id made this legal form unrenderable.
    const longKey = `k${"x".repeat(120)}`;
    const { request: req } = request([
      { kind: "text", key: longKey, title: "Note", required: true },
    ]);
    await startWizard(client, channel, req, longKey);
    client.emitButton(click(client, idFor(client, "field", 0)));
    await new Promise((r) => setTimeout(r, 5));
    expect(client.modals).toHaveLength(1);
    expect(client.modals[0]!.components[0]!.component.customId).toBe("f:0");
    client.emitModal(modal(client, client.modals[0]!.customId, { [longKey]: "answer" }));
    await new Promise((r) => setTimeout(r, 5));
    const store = (channel as unknown as { pendingElicitations: Map<string, { values: Record<string, unknown> }> }).pendingElicitations;
    const entry = [...store.values()][0]!;
    expect(entry.values[longKey]).toBe("answer");
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
    client.emitModal(modal(client, m.customId, { note: "intruder value" }, "user-INTRUDER", 1));
    await new Promise((r) => setTimeout(r, 5));
    expect(entry.values.note).toBeUndefined();
    // And the legitimate initiator can still answer it.
    client.emitModal(modal(client, m.customId, { note: "legit" }, "user-A", 1));
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
    // A select option's label is NOT Markdown: Discord renders it literally, so
    // escaping it here would double the backslashes the user sees. The mention
    // defense is `allowedMentions` at send time, not label escaping — and the
    // option VALUE (what core validates) is never touched by either.
    expect(component!.options[0]!.label).toBe("@everyone **bold** <@123>");
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

test("every field card fits Discord's per-row button limit", async () => {
  // Structural and platform-facing: a mid-wizard text field needs Answer + Prev
  // + Next + Review + Decline + Cancel = 6 controls, which exceeds the 5 buttons
  // Discord allows per action row. Before the split the whole form's second
  // field was a message Discord rejects, so nothing could be answered at all.
  const token = "tok-per-row";
  const { buildElicitationFieldCard } = await import("../../../../packages/channel-discord/src/elicitation-ui");
  const cases = [
    request([{ kind: "text", key: "a", title: "A", required: true }, { kind: "text", key: "b", title: "B", required: true }]).request,
    request([{ kind: "text", key: "a", title: "A", required: true }, { kind: "number", key: "c", title: "C", required: true }]).request,
  ];
  for (const req of cases) {
    for (let index = 0; index < req.fields.length; index += 1) {
      const card = buildElicitationFieldCard(req, token, req.fields[index]!, index + 1, undefined);
      expect(card.components.length).toBeGreaterThan(0);
      for (const row of card.components) {
        expect(row.components.length).toBeGreaterThan(0);
        expect(row.components.length).toBeLessThanOrEqual(5);
      }
      // Answer control survives the split: the user can still open a modal.
      const ids = card.components.flatMap((row) => row.components.map((c) => c.customId));
      expect(ids.some((id) => id.endsWith(":field:" + index))).toBe(true);
      expect(ids.some((id) => id.endsWith(":decline"))).toBe(true);
      expect(ids.some((id) => id.endsWith(":cancel"))).toBe(true);
    }
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
    client.emitModal(modal(client, client.modals[1]!.customId, { b: "second" }, "user-A", 1));
    await wait();

    // Review -> Edit field 0 -> correct it -> review -> submit.
    client.emitButton(click(client, idFor(client, "review")));
    await wait();
    client.emitButton(click(client, idFor(client, "edit", 0)));
    await wait();
    client.emitButton(click(client, idFor(client, "field", 0)));
    await wait();
    client.emitModal(modal(client, client.modals[2]!.customId, { a: "corrected" }, "user-A", 0));
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

// --- Field keys that are JavaScript property names --------------------------
//
// core treats `__proto__`, `constructor` and `toString` as ordinary field keys
// and builds null-prototype output to defend against exactly this. If the
// renderer uses a plain object for its answer map, `constructor` reads back as
// an answer to a question nobody answered, and `__proto__` writes through to the
// dictionary's own prototype.

test("a field key named constructor is not mistaken for an answer", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request: req } = request([
      { kind: "text", key: "constructor", title: "Constructor", required: true },
    ]);
    const settled = channel.requestElicitation(req).then(
      (d) => d,
      (e: Error) => e,
    );
    await new Promise((r) => setTimeout(r, 5));
    // Opening card first; the review control only exists inside the wizard.
    client.emitButton(click(client, idFor(client, "start")));
    await new Promise((r) => setTimeout(r, 5));
    // Nothing has been answered yet, yet `values["constructor"]` on a plain
    // object is the Object constructor — truthy. The submit gate must still
    // block, and the store must not report the field complete.
    client.emitButton(click(client, idFor(client, "review")));
    await new Promise((r) => setTimeout(r, 5));
    client.emitButton(click(client, idFor(client, "submit")));
    await new Promise((r) => setTimeout(r, 5));
    const store = (channel as unknown as { pendingElicitations: Map<string, { values: Record<string, unknown> }> }).pendingElicitations;
    const entry = [...store.values()][0]!;
    expect(Object.hasOwn(entry.values, "constructor")).toBe(false);
    // Still live: the user has to actually answer it.
    client.emitButton(click(client, idFor(client, "edit", 0)));
    await new Promise((r) => setTimeout(r, 5));
    client.emitButton(click(client, idFor(client, "field", 0)));
    await new Promise((r) => setTimeout(r, 5));
    const m = client.modals[client.modals.length - 1]!;
    client.emitModal(modal(client, m.customId, { "f:0": "typed" }));
    await new Promise((r) => setTimeout(r, 5));
    expect(Object.hasOwn(entry.values, "constructor")).toBe(true);
    expect(entry.values.constructor).toBe("typed");
    client.emitButton(click(client, idFor(client, "review")));
    await new Promise((r) => setTimeout(r, 5));
    client.emitButton(click(client, idFor(client, "submit")));
    await new Promise((r) => setTimeout(r, 5));
    const decision = await settled;
    expect(decision).toEqual({
      action: "accept",
      responderId: "user-A",
      content: { constructor: "typed" },
    });
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("a field key named __proto__ becomes an own answer property", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request: req } = request([
      { kind: "text", key: "__proto__", title: "Proto", required: true },
    ]);
    const settled = channel.requestElicitation(req).then(
      (d) => d,
      (e: Error) => e,
    );
    await new Promise((r) => setTimeout(r, 5));
    client.emitButton(click(client, idFor(client, "start")));
    await new Promise((r) => setTimeout(r, 5));
    client.emitButton(click(client, idFor(client, "field", 0)));
    await new Promise((r) => setTimeout(r, 5));
    const m = client.modals[client.modals.length - 1]!;
    client.emitModal(modal(client, m.customId, { "f:0": "proto-answer" }));
    await new Promise((r) => setTimeout(r, 5));
    const store = (channel as unknown as { pendingElicitations: Map<string, { values: Record<string, unknown> }> }).pendingElicitations;
    const entry = [...store.values()][0]!;
    // An own property, not a prototype mutation of the answer map.
    expect(Object.hasOwn(entry.values, "__proto__")).toBe(true);
    expect(entry.values.__proto__).toBe("proto-answer");
    expect(Object.getPrototypeOf(entry.values)).toBe(null);
    client.emitButton(click(client, idFor(client, "review")));
    await new Promise((r) => setTimeout(r, 5));
    client.emitButton(click(client, idFor(client, "submit")));
    await new Promise((r) => setTimeout(r, 5));
    const decision = await settled as {
      action: string;
      responderId: string;
      content: Record<string, unknown> | null;
    };
    expect(decision.action).toBe("accept");
    expect(decision.responderId).toBe("user-A");
    expect(Object.hasOwn(decision.content!, "__proto__")).toBe(true);
    expect(decision.content!.__proto__).toBe("proto-answer");
    expect(Object.keys(decision.content!)).toEqual(["__proto__"]);
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("an answered optional field can be skipped back to omitted", async () => {
  // value -> omitted is part of ACP's review-and-modify. A cleared text field is
  // a real empty answer, not an omission, so there must be a distinct control.
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request: req } = request([
      { kind: "text", key: "a", title: "A", required: true },
      { kind: "text", key: "b", title: "B", required: false },
    ]);
    const settled = channel.requestElicitation(req).then(
      (d) => d,
      (e: Error) => e,
    );
    await new Promise((r) => setTimeout(r, 5));
    client.emitButton(click(client, idFor(client, "start")));
    await new Promise((r) => setTimeout(r, 5));
    // Answer both.
    client.emitButton(click(client, idFor(client, "field", 0)));
    await new Promise((r) => setTimeout(r, 5));
    client.emitModal(modal(client, client.modals[client.modals.length - 1]!.customId, { "a": "alpha" }, "user-A", 0));
    await new Promise((r) => setTimeout(r, 5));
    client.emitButton(click(client, idFor(client, "next", 1)));
    await new Promise((r) => setTimeout(r, 5));
    client.emitButton(click(client, idFor(client, "field", 1)));
    await new Promise((r) => setTimeout(r, 5));
    client.emitModal(modal(client, client.modals[client.modals.length - 1]!.customId, { "b": "beta" }, "user-A", 1));
    await new Promise((r) => setTimeout(r, 5));
    // We are on b's own card after the modal: Skip is here.
    const store = (channel as unknown as { pendingElicitations: Map<string, { values: Record<string, unknown>; skipped: Set<string> }> }).pendingElicitations;
    const entry = [...store.values()][0]!;
    expect(entry.values.b).toBe("beta");
    client.emitButton(click(client, idFor(client, "skip")));
    await new Promise((r) => setTimeout(r, 5));
    expect(Object.hasOwn(entry.values, "b")).toBe(false);
    expect(entry.skipped.has("b")).toBe(true);
    // Review and submit: only `a` is carried.
    client.emitButton(click(client, idFor(client, "review")));
    await new Promise((r) => setTimeout(r, 5));
    client.emitButton(click(client, idFor(client, "submit")));
    await new Promise((r) => setTimeout(r, 5));
    const decision = await settled;
    expect(decision).toEqual({
      action: "accept",
      responderId: "user-A",
      content: { a: "alpha" },
    });
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

// --- A review must show the WHOLE answer ------------------------------------
//
// core lets a text answer be 4000 characters and a Discord card holds 1800, so
// a real answer spans several messages. Rendering chunk[0] and dropping the rest
// hid most of what the user was approving while leaving Submit enabled.

test("a 4000-character answer is fully visible on the review before Submit", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const longAnswer = "A".repeat(4000);
    const { request: req } = request([
      { kind: "text", key: "body", title: "Body", required: true },
    ]);
    const settled = channel.requestElicitation(req).then(
      (d) => d,
      (e: Error) => e,
    );
    await new Promise((r) => setTimeout(r, 5));
    client.emitButton(click(client, idFor(client, "start")));
    await new Promise((r) => setTimeout(r, 5));
    client.emitButton(click(client, idFor(client, "field", 0)));
    await new Promise((r) => setTimeout(r, 5));
    client.emitModal(modal(client, client.modals[client.modals.length - 1]!.customId, { body: longAnswer }, "user-A", 0));
    await new Promise((r) => setTimeout(r, 5));
    // Review. The opener is one message; the review's first chunk edits it and
    // every further chunk goes to a continuation message.
    const sentBefore = client.sent.length;
    client.emitButton(click(client, idFor(client, "review")));
    await new Promise((r) => setTimeout(r, 10));

    // The user-visible review text = the edited card plus every continuation.
    const visible = [
      ...client.edited.map((entry) => entry.body.content ?? ""),
      ...client.sent.slice(sentBefore).map((entry) => entry.body.content ?? ""),
    ].join("");
    // The WHOLE answer is present. The earlier failure mode was exactly this
    // assertion at the 1800-char mark.
    expect(visible).toContain(longAnswer);
    expect(visible.split("A").length - 1).toBeGreaterThanOrEqual(4000);

    // And Submit still works.
    client.emitButton(click(client, idFor(client, "submit")));
    await new Promise((r) => setTimeout(r, 10));
    const decision = await settled;
    expect(decision).toEqual({
      action: "accept",
      responderId: "user-A",
      content: { body: longAnswer },
    });
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("review continuation messages are removed once the form is decided", async () => {
  // A continuation left behind shows a stale fragment of the review with no
  // controls, which reads as a broken form.
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const longAnswer = "B".repeat(4000);
    const { request: req } = request([
      { kind: "text", key: "body", title: "Body", required: true },
    ]);
    const settled = channel.requestElicitation(req).then(
      (d) => d,
      (e: Error) => e,
    );
    await new Promise((r) => setTimeout(r, 5));
    client.emitButton(click(client, idFor(client, "start")));
    await new Promise((r) => setTimeout(r, 5));
    client.emitButton(click(client, idFor(client, "field", 0)));
    await new Promise((r) => setTimeout(r, 5));
    client.emitModal(modal(client, client.modals[client.modals.length - 1]!.customId, { body: longAnswer }, "user-A", 0));
    await new Promise((r) => setTimeout(r, 5));
    const sentBefore = client.sent.length;
    client.emitButton(click(client, idFor(client, "review")));
    await new Promise((r) => setTimeout(r, 10));
    // Continuation messages exist while the review is up: the review needed
    // more than one 1800-char chunk, so the extras were sent as new messages.
    const continuationCount = client.sent.length - sentBefore;
    expect(continuationCount).toBeGreaterThan(0);
    client.emitButton(click(client, idFor(client, "submit")));
    await new Promise((r) => setTimeout(r, 10));
    expect(await settled).toMatchObject({ action: "accept" });
    // And they are gone after the decision.
    expect(client.deleted.length).toBeGreaterThanOrEqual(continuationCount);
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("shortening an answer deletes the review's tail continuations", async () => {
  // 4000 A -> review needs primary + 2 continuations. Editing to 2000 B needs
  // primary + 1. The extra continuation used to survive, so the user saw the
  // current review AND a fragment of the previous answer underneath it, with no
  // way to tell which one Submit sends.
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const longAnswer = "A".repeat(4000);
    const { request: req } = request([
      { kind: "text", key: "body", title: "Body", required: true },
    ]);
    channel.requestElicitation(req).catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    client.emitButton(click(client, idFor(client, "start")));
    await new Promise((r) => setTimeout(r, 5));
    client.emitButton(click(client, idFor(client, "field", 0)));
    await new Promise((r) => setTimeout(r, 5));
    client.emitModal(modal(client, client.modals[client.modals.length - 1]!.customId, { body: longAnswer }, "user-A", 0));
    await new Promise((r) => setTimeout(r, 5));

    // First review: create the continuations.
    const beforeFirstReview = client.sent.length;
    client.emitButton(click(client, idFor(client, "review")));
    await new Promise((r) => setTimeout(r, 15));
    const firstReviewContinuations = client.sent.length - beforeFirstReview;
    expect(firstReviewContinuations).toBeGreaterThan(1);
    // Everything from here on is the second pass: snapshot the transport right
    // after the first review settles so its edits are not counted twice.
    const sentBefore = client.sent.length;
    const editedBefore = client.edited.length;
    const deletedBefore = client.deleted.length;

    // Shorten the answer.
    const shortAnswer = "B".repeat(2000);
    client.emitButton(click(client, idFor(client, "edit", 0)));
    await new Promise((r) => setTimeout(r, 5));
    client.emitButton(click(client, idFor(client, "field", 0)));
    await new Promise((r) => setTimeout(r, 5));
    client.emitModal(modal(client, client.modals[client.modals.length - 1]!.customId, { body: shortAnswer }, "user-A", 0));
    await new Promise((r) => setTimeout(r, 5));

    // Second review.
    client.emitButton(click(client, idFor(client, "review")));
    await new Promise((r) => setTimeout(r, 15));

    // What the user sees is: the primary's latest content, and every live
    // continuation. Continuation edits land on existing messages, so the LAST
    // edit of each is its live content.
    const primary = client.edited[client.edited.length - 1]!;
    // Exclude the primary by messageId, not object identity: it was captured
    // after the slice below was built.
    const continuationEdits = client.edited
      .slice(editedBefore)
      .filter((entry) => entry.messageId !== primary.messageId);
    const liveContinuations = [
      ...client.sent.slice(sentBefore).map((entry) => entry.body.content ?? ""),
      // A continuation edited in place shows its latest edit.
      ...continuationEdits.map((entry) => entry.body.content ?? ""),
    ];
    const visible = [primary.body.content ?? "", ...liveContinuations].join("");

    // The new answer is fully present...
    expect(visible).toContain(shortAnswer);
    // ...and the OLD answer is nowhere. `not.toContain(longAnswer)` is the real
    // assertion: the string is 4000 chars of one letter, so any surviving
    // fragment large enough to show the user is caught by it.
    expect(visible).not.toContain(longAnswer);
    // A shorter but still multi-chunk fragment of the old answer would also be
    // wrong, so count runs of the old letter rather than occurrences of it.
    const oldRuns = visible.match(/A{100,}/g) ?? [];
    expect(oldRuns).toHaveLength(0);

    // Net channel state: the live continuation count SHRANK from 3 to 2. The
    // transient `edit` teardown deleted all three while the wizard was on a field
    // card, and the new review created two — the same end state an in-place trim
    // would reach, which is what matters: no message holding the old answer
    // stays live.
    const staleDeletes = client.deleted.length - deletedBefore;
    expect(staleDeletes).toBe(firstReviewContinuations);
    const newSends = client.sent.slice(sentBefore).length;
    expect(newSends).toBe(firstReviewContinuations - 1);
    expect(liveContinuations).toHaveLength(newSends);
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("a failed continuation send leaves the primary's Submit alone", async () => {
  // The primary carries Submit. If it is edited to the review while a
  // continuation send is still in flight and that send fails, the user could
  // approve content they never saw. Continuations are laid in first, so a failure
  // leaves the previous card up instead of an incomplete review.
  const client = makeFakeClient();
  let failSends = 0;
  const realSend = client.sendMessage.bind(client);
  (client as unknown as { sendMessage: unknown }).sendMessage = async (target: unknown, body: unknown) => {
    // Fail only the continuation sends (bodies WITHOUT components), so the
    // opening card still goes out.
    const hasComponents = Boolean((body as { components?: unknown }).components);
    if (!hasComponents) {
      failSends += 1;
      throw new Error("continuation send failed");
    }
    return realSend(target as never, body as never);
  };
  const { channel, abort } = await startChannel(client);
  try {
    const longAnswer = "A".repeat(4000);
    const { request: req } = request([
      { kind: "text", key: "body", title: "Body", required: true },
    ]);
    channel.requestElicitation(req).catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    client.emitButton(click(client, idFor(client, "start")));
    await new Promise((r) => setTimeout(r, 5));
    client.emitButton(click(client, idFor(client, "field", 0)));
    await new Promise((r) => setTimeout(r, 5));
    client.emitModal(modal(client, client.modals[client.modals.length - 1]!.customId, { body: longAnswer }, "user-A", 0));
    await new Promise((r) => setTimeout(r, 5));

    const editsBefore = client.edited.length;
    client.emitButton(click(client, idFor(client, "review")));
    await new Promise((r) => setTimeout(r, 15));

    // A continuation send was attempted and failed.
    expect(failSends).toBeGreaterThan(0);
    // The primary was NOT switched to the review. It WAS edited once, to the same
    // review content with Submit DISABLED — the gate that makes a partially
    // applied multi-message review unsubmittable. So the user sees either the
    // previous card or a review they cannot submit from, never a live Submit over
    // content that failed to lay in.
    const primaryEdits = client.edited.filter((entry) => entry.messageId === "m1");
    expect(primaryEdits.length).toBe(editsBefore + 1);
    const submitControl = (primaryEdits[primaryEdits.length - 1]!.body.components ?? [])
      .flatMap((row) => row.components)
      .find((component) => component.customId.endsWith(":submit"));
    expect(submitControl?.disabled).toBe(true);
    const store = (channel as unknown as {
      pendingElicitations: Map<string, { submitGateClosed: boolean }>;
    }).pendingElicitations;
    expect([...store.values()][0]!.submitGateClosed).toBe(true);
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("a failed stale-tail delete keeps the primary off the shorter review", async () => {
  // Reached through review PAGING, which is the real entry point for the
  // `slice(extras.length)` branch: page 0 is long (its answers fill several
  // chunks), page 1 is short, so moving to it shrinks the continuation set
  // without ever passing through a field card — the path that previously
  // bypassed every trim by discarding everything and rebuilding.
  const client = makeFakeClient();
  const failsOn = new Set<string>();
  const realDelete = client.deleteMessage.bind(client);
  (client as unknown as { deleteMessage: unknown }).deleteMessage =
    async (target: unknown, messageId: string) => {
      if (failsOn.has(messageId)) {
        const error = new Error("delete failed") as Error & { code?: string };
        error.code = "TRANSIENT";
        throw error;
      }
      return realDelete(target as never, messageId);
    };
  const { channel, abort } = await startChannel(client);
  try {
    const fields: ChannelElicitationRequest["fields"] = Array.from({ length: 8 }, (_, index) => ({
      kind: "text" as const,
      key: `f${index}`,
      title: `Field ${index}`,
      required: true,
    }));
    const { request: req } = request(fields);
    void channel.requestElicitation(req).catch(() => {});
    const wait = (): Promise<void> => new Promise((r) => setTimeout(r, 8));
    const deadline = Date.now() + 5_000;
    while (client.sent.length === 0 && Date.now() < deadline) await wait();
    client.emitButton(click(client, idFor(client, "start")));
    await wait();
    // Answer so that page 0 is LONG (5 chunks, 4 continuations) and page 1 is
    // MEDIUM (2 chunks, 1 continuation). Paging 0 -> 1 therefore shrinks 4 extras
    // to 1 and hits the `slice(extras.length)` tail-trim branch, which is the
    // only path where a partial failure leaves a MIXED review: the continuations
    // are edited in place while the primary is still the old card.
    // (Review pages are 2 fields wide: 5 button slots minus Submit/Decline/Cancel.)
    const lengths = [1800, 1800, 900, 900, 5, 5, 5, 5];
    for (let index = 0; index < 8; index += 1) {
      client.emitButton(click(client, idFor(client, "field", index)));
      await wait();
      const modalId = client.modals[client.modals.length - 1]!.customId;
      client.emitModal(modal(client, modalId, { [fields[index]!.key]: "L".repeat(lengths[index]!) }, "user-A", index));
      await wait();
      if (index < 7) {
        client.emitButton(click(client, idFor(client, "next", index + 1)));
        await wait();
      }
    }
    client.emitButton(click(client, idFor(client, "review")));
    await wait();

    const store = (channel as unknown as {
      pendingElicitations: Map<string, {
        continuationMessageIds: string[];
        submitGateClosed: boolean;
      }>;
    }).pendingElicitations;
    const liveEntry = [...store.values()][0]!;
    // The review opened on page 0 with its 4 continuations.
    expect(liveEntry.continuationMessageIds.length).toBe(4);

    // Move to page 1 — the only other non-zero page control on page 0's row.
    const rowIds = (): string[] => {
      const rows = client.edited[client.edited.length - 1]!.body.components ?? [];
      return rows.flatMap((r) => r.components.map((c) => c.customId));
    };
    const page1 = rowIds().find((id) => id.endsWith(":page:1"));
    expect(page1).toBeDefined();
    const primaryEditsBefore = client.edited.filter((entry) => entry.messageId === "m1").length;

    // The stale tail's deletes fail from here on.
    for (const id of liveEntry.continuationMessageIds) {
      failsOn.add(id);
    }

    client.emitButton(click(client, page1!));
    await wait();

    // THE MIXED-REVIEW GATE. The primary is disabled before any continuation is
    // touched, so whatever the failure left in the channel, the user cannot
    // submit from it.
    const gateEntry = [...store.values()][0]!;
    expect(gateEntry.submitGateClosed).toBe(true);
    // And the primary's last published controls have Submit disabled.
    const primaryEdits = client.edited.filter((entry) => entry.messageId === "m1");
    const lastPrimary = primaryEdits[primaryEdits.length - 1]!;
    const submitControl = (lastPrimary.body.components ?? [])
      .flatMap((row) => row.components)
      .find((component) => component.customId.endsWith(":submit"));
    expect(submitControl?.disabled).toBe(true);
    // The final (enabled) review was never published, so no primary edit carries
    // a live Submit over the inconsistent set.
    expect(primaryEdits.length).toBeGreaterThan(primaryEditsBefore);
    // The unremovable ids are still tracked so a retry can finish the job.
    expect(gateEntry.continuationMessageIds).toEqual(liveEntry.continuationMessageIds);
  } finally {
    failsOn.clear();
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("an Unknown Message delete is treated as a successful trim", async () => {
  // Discord 404s an id the platform already dropped. Counting that as a failure
  // would block the review forever on a message that is already gone.
  const client = makeFakeClient();
  const unknownOn = new Set<string>();
  const realDelete = client.deleteMessage.bind(client);
  (client as unknown as { deleteMessage: unknown }).deleteMessage =
    async (target: unknown, messageId: string) => {
      if (unknownOn.has(messageId)) {
        const error = new Error("Unknown Message") as Error & { code?: number };
        error.code = 10008;
        throw error;
      }
      return realDelete(target as never, messageId);
    };
  const { channel, abort } = await startChannel(client);
  try {
    const longAnswer = "C".repeat(4000);
    const { request: req } = request([
      { kind: "text", key: "body", title: "Body", required: true },
    ]);
    const settled = channel.requestElicitation(req).then((d) => d, (e: Error) => e);
    await new Promise((r) => setTimeout(r, 5));
    client.emitButton(click(client, idFor(client, "start")));
    await new Promise((r) => setTimeout(r, 5));
    client.emitButton(click(client, idFor(client, "field", 0)));
    await new Promise((r) => setTimeout(r, 5));
    client.emitModal(modal(client, client.modals[client.modals.length - 1]!.customId, { body: longAnswer }, "user-A", 0));
    await new Promise((r) => setTimeout(r, 5));
    client.emitButton(click(client, idFor(client, "review")));
    await new Promise((r) => setTimeout(r, 15));

    // Shorten so the tail must be trimmed, and make those deletes 404.
    const short = "D".repeat(1500);
    for (const id of client.sent.slice(1).map((_, index) => `m${index + 1}`)) unknownOn.add(id);
    client.emitButton(click(client, idFor(client, "edit", 0)));
    await new Promise((r) => setTimeout(r, 5));
    client.emitButton(click(client, idFor(client, "field", 0)));
    await new Promise((r) => setTimeout(r, 5));
    client.emitModal(modal(client, client.modals[client.modals.length - 1]!.customId, { body: short }, "user-A", 0));
    await new Promise((r) => setTimeout(r, 5));
    const editsBefore = client.edited.length;
    client.emitButton(click(client, idFor(client, "review")));
    await new Promise((r) => setTimeout(r, 15));

    // The review DID re-render: 404s are the outcome being asked for.
    expect(client.edited.length).toBeGreaterThan(editsBefore);
    client.emitButton(click(client, idFor(client, "submit")));
    await new Promise((r) => setTimeout(r, 10));
    expect(await settled).toMatchObject({ action: "accept", content: { body: short } });
  } finally {
    unknownOn.clear();
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("review -> Edit -> field card cannot be submitted when the continuation delete fails", async () => {
  // `edit` leaves the multi-chunk review for a field card, whose target has NO
  // continuations — so it takes the strict discard path. Gating on the TARGET
  // card's shape missed this entirely: the primary is still the old review with a
  // live Submit while its continuations are being deleted out from under it.
  const client = makeFakeClient();
  const failsOn = new Set<string>();
  const realDelete = client.deleteMessage.bind(client);
  (client as unknown as { deleteMessage: unknown }).deleteMessage =
    async (target: unknown, messageId: string) => {
      if (failsOn.has(messageId)) {
        const error = new Error("delete failed") as Error & { code?: string };
        error.code = "TRANSIENT";
        throw error;
      }
      return realDelete(target as never, messageId);
    };
  const { channel, abort } = await startChannel(client);
  try {
    const longAnswer = "A".repeat(4000);
    const { request: req } = request([
      { kind: "text", key: "body", title: "Body", required: true },
    ]);
    channel.requestElicitation(req).catch(() => {});
    const wait = (): Promise<void> => new Promise((r) => setTimeout(r, 8));
    await wait();
    client.emitButton(click(client, idFor(client, "start")));
    await wait();
    client.emitButton(click(client, idFor(client, "field", 0)));
    await wait();
    client.emitModal(modal(client, client.modals[client.modals.length - 1]!.customId, { body: longAnswer }, "user-A", 0));
    await wait();
    client.emitButton(click(client, idFor(client, "review")));
    await wait();

    const store = (channel as unknown as {
      pendingElicitations: Map<string, {
        continuationMessageIds: string[];
        submitGateClosed: boolean;
      }>;
    }).pendingElicitations;
    const entry = [...store.values()][0]!;
    expect(entry.continuationMessageIds.length).toBeGreaterThan(1);
    const openingIds = [...entry.continuationMessageIds];

    // Every delete fails from here, including the second one.
    for (const id of openingIds) failsOn.add(id);
    const primaryEditsBefore = client.edited.filter((e) => e.messageId === "m1").length;

    client.emitButton(click(client, idFor(client, "edit", 0)));
    await wait();

    const gateEntry = [...store.values()][0]!;
    // The gate closed because the CURRENT primary was a review whose text was
    // about to be deleted — even though the destination is a field card.
    expect(gateEntry.submitGateClosed).toBe(true);
    // The primary's last published Submit is disabled.
    const primaryEdits = client.edited.filter((e) => e.messageId === "m1");
    const lastPrimary = primaryEdits[primaryEdits.length - 1]!;
    const submitControl = (lastPrimary.body.components ?? [])
      .flatMap((row) => row.components)
      .find((component) => component.customId.endsWith(":submit"));
    expect(submitControl?.disabled).toBe(true);
    // A gate edit was published (the review with Submit disabled) in addition to
    // whatever else happened.
    expect(primaryEdits.length).toBeGreaterThan(primaryEditsBefore);
    // The unremovable ids are still tracked so a retry can finish the job.
    expect(gateEntry.continuationMessageIds).toEqual(openingIds);
  } finally {
    failsOn.clear();
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("review -> single-chunk page cannot be submitted when the delete fails", async () => {
  // The TARGET page fits in one message, so the old condition skipped the gate —
  // yet the transition deletes the current review's continuations.
  const client = makeFakeClient();
  const failsOn = new Set<string>();
  const realDelete = client.deleteMessage.bind(client);
  (client as unknown as { deleteMessage: unknown }).deleteMessage =
    async (target: unknown, messageId: string) => {
      if (failsOn.has(messageId)) {
        const error = new Error("delete failed") as Error & { code?: string };
        error.code = "TRANSIENT";
        throw error;
      }
      return realDelete(target as never, messageId);
    };
  const { channel, abort } = await startChannel(client);
  try {
    // 8 fields, paged 2 at a time; page 0 long, page 2 short.
    const fields: ChannelElicitationRequest["fields"] = Array.from({ length: 8 }, (_, index) => ({
      kind: "text" as const,
      key: `f${index}`,
      title: `Field ${index}`,
      required: true,
    }));
    const lengths = [1800, 1800, 5, 5, 5, 5, 5, 5];
    const { request: req } = request(fields);
    channel.requestElicitation(req).catch(() => {});
    const wait = (): Promise<void> => new Promise((r) => setTimeout(r, 8));
    await wait();
    client.emitButton(click(client, idFor(client, "start")));
    await wait();
    for (let index = 0; index < 8; index += 1) {
      client.emitButton(click(client, idFor(client, "field", index)));
      await wait();
      const modalId = client.modals[client.modals.length - 1]!.customId;
      client.emitModal(modal(client, modalId, { [fields[index]!.key]: "L".repeat(lengths[index]!) }, "user-A", index));
      await wait();
      if (index < 7) {
        client.emitButton(click(client, idFor(client, "next", index + 1)));
        await wait();
      }
    }
    client.emitButton(click(client, idFor(client, "review")));
    await wait();

    const store = (channel as unknown as {
      pendingElicitations: Map<string, {
        continuationMessageIds: string[];
        submitGateClosed: boolean;
      }>;
    }).pendingElicitations;
    const entry = [...store.values()][0]!;
    // Page 0's long review produced continuations.
    expect(entry.continuationMessageIds.length).toBeGreaterThan(1);
    const openingIds = [...entry.continuationMessageIds];
    for (const id of openingIds) failsOn.add(id);

    // Page 2's answers are tiny, so its review is a SINGLE chunk. It is not
    // directly reachable from page 0 (whose row is Prev->page3, Next->page1), so
    // step through page 1 first.
    const rowIds = (): string[] => (client.edited[client.edited.length - 1]!.body.components ?? [])
      .flatMap((row) => row.components)
      .map((component) => component.customId);
    const goTo = async (suffix: string): Promise<string> => {
      for (let step = 0; step < 8; step += 1) {
        const found = rowIds().find((id) => id.endsWith(`:page:${suffix}`));
        if (found) return found;
        const next = rowIds().find((id) => /:page:[0-9]+$/.test(id));
        if (!next) break;
        client.emitButton(click(client, next));
        await wait();
      }
      throw new Error(`no page:${suffix} control reachable`);
    };
    const page2 = await goTo("2");
    expect(page2).toBeDefined();

    client.emitButton(click(client, page2!));
    await wait();

    const gateEntry = [...store.values()][0]!;
    expect(gateEntry.submitGateClosed).toBe(true);
    const primaryEdits = client.edited.filter((e) => e.messageId === "m1");
    const submitControl = (primaryEdits[primaryEdits.length - 1]!.body.components ?? [])
      .flatMap((row) => row.components)
      .find((component) => component.customId.endsWith(":submit"));
    expect(submitControl?.disabled).toBe(true);
    expect(gateEntry.continuationMessageIds).toEqual(openingIds);
  } finally {
    failsOn.clear();
    abort.abort();
    await channel.stop().catch(() => {});
  }
});


test("a second transition is queued behind a running one, and cannot open the gate", async () => {
  // Two interactions for the SAME elicitation may overlap: `interactionCreate`
  // dispatches fire-and-forget and every transport call crosses an `await`. A
  // boolean `submitGateClosed` on shared entry state is not a lock — transition
  // A closes it and reopens it after ITS OWN continuation sync, so transition B,
  // still editing the review's continuations, is left with a live Submit over a
  // mixed review.
  //
  // The discriminator is ORDERING, not just final state: while transition A is
  // held mid-flight, transition B must not have published anything at all. Held
  // on transition A's FIRST continuation edit, so B is fired while A is genuinely
  // inside `syncElicitationContinuations`.
  const client = makeFakeClient();
  let release: (() => void) | null = null;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holdsLeft = 1;
  const realEdit = client.editMessage.bind(client);
  (client as unknown as { editMessage: unknown }).editMessage = async (
    target: unknown,
    messageId: string,
    body: unknown,
  ) => {
    if (messageId === "m2" && holdsLeft > 0) {
      holdsLeft -= 1;
      await held;
    }
    return realEdit(target as never, messageId, body as never);
  };
  const { channel, abort } = await startChannel(client);
  try {
    // 8 fields, 2 per review page. Page 0 is long, page 1 medium: both are
    // multi-chunk, so each transition edits existing continuations.
    const fields: ChannelElicitationRequest["fields"] = Array.from({ length: 8 }, (_, index) => ({
      kind: "text" as const,
      key: `f${index}`,
      title: `Field ${index}`,
      required: true,
    }));
    const lengths = [1800, 1800, 900, 900, 5, 5, 5, 5];
    const { request: req } = request(fields);
    channel.requestElicitation(req).catch(() => {});
    const wait = (): Promise<void> => new Promise((r) => setTimeout(r, 6));
    await wait();
    client.emitButton(click(client, idFor(client, "start")));
    await wait();
    for (let index = 0; index < 8; index += 1) {
      client.emitButton(click(client, idFor(client, "field", index)));
      await wait();
      const modalId = client.modals[client.modals.length - 1]!.customId;
      client.emitModal(modal(client, modalId, { [fields[index]!.key]: "L".repeat(lengths[index]!) }, "user-A", index));
      await wait();
      if (index < 7) {
        client.emitButton(click(client, idFor(client, "next", index + 1)));
        await wait();
      }
    }
    client.emitButton(click(client, idFor(client, "review")));
    await wait();

    const store = (channel as unknown as {
      pendingElicitations: Map<string, { submitGateClosed: boolean; reviewPage: number }>;
    }).pendingElicitations;
    expect([...store.values()][0]!.submitGateClosed).toBe(false);

    const rowIds = (): string[] => (client.edited[client.edited.length - 1]!.body.components ?? [])
      .flatMap((row) => row.components)
      .map((component) => component.customId);
    const page1 = rowIds().find((id) => id.endsWith(":page:1"))!;

    // Transition A: page 0 -> page 1. It reaches the held m2 edit inside its
    // continuation sync.
    client.emitButton(click(client, page1));
    await new Promise((r) => setTimeout(r, 25));

    const whileA = client.edited.length;
    const gateWhileA = [...store.values()][0]!.submitGateClosed;
    // A is inside its transaction: the gate is closed and its primary has been
    // published with Submit disabled.
    expect(gateWhileA).toBe(true);
    const submitWhileA = (client.edited[client.edited.length - 1]!.body.components ?? [])
      .flatMap((row) => row.components)
      .find((component) => component.customId.endsWith(":submit"));
    expect(submitWhileA?.disabled).toBe(true);

    // Transition B, fired while A is still held. Nothing new is published: B is
    // queued behind A rather than interleaving. This is the assertion that fails
    // without per-entry serialization.
    client.emitButton(click(client, page1));
    await new Promise((r) => setTimeout(r, 25));
    expect(client.edited.length).toBe(whileA);

    // A stale Submit while B is queued behind a running A: still refused.
    client.emitButton(click(client, idFor(client, "submit")));
    await new Promise((r) => setTimeout(r, 20));
    const storeDuring = [...store.values()][0]!;
    expect(storeDuring.submitGateClosed).toBe(true);

    // Let A finish. B then runs to completion in order.
    release!();
    await new Promise((r) => setTimeout(r, 120));
    await wait();

    // The final card is ONE generation: the published page indicator and the
    // tracked page agree, and the gate is open because the last transition
    // completed.
    const finalEntry = [...store.values()][0]!;
    expect(finalEntry.submitGateClosed).toBe(false);
    const lastPrimary = client.edited[client.edited.length - 1]!;
    const indicator = /\((\d)\/4\)/.exec(lastPrimary.body.content ?? "");
    expect(indicator).not.toBeNull();
    expect(finalEntry.reviewPage).toBe(Number(indicator![1]) - 1);
    // Submit on the settled card works.
    client.emitButton(click(client, idFor(client, "submit")));
    await new Promise((r) => setTimeout(r, 25));
  } finally {
    release?.();
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("an abort during a running transition leaves the card inert, never repainted", async () => {
  // A rerender can be parked on a continuation edit when the request is aborted.
  // The terminal render is queued behind it, so it publishes Cancelled and clears
  // the continuations AFTER the transition finishes. Without the guard the
  // transition would resume and repaint the Cancelled card back into an
  // interactive-looking review — re-displaying answers the terminal card had
  // just withdrawn.
  const client = makeFakeClient();
  let release: (() => void) | null = null;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holdsLeft = 1;
  const realEdit = client.editMessage.bind(client);
  (client as unknown as { editMessage: unknown }).editMessage = async (
    target: unknown,
    messageId: string,
    body: unknown,
  ) => {
    // Hold on the first continuation edit of the second transition, i.e. inside
    // `syncElicitationContinuations`.
    if (messageId === "m2" && holdsLeft > 0) {
      holdsLeft -= 1;
      await held;
    }
    return realEdit(target as never, messageId, body as never);
  };
  const { channel, abort } = await startChannel(client);
  try {
    const fields: ChannelElicitationRequest["fields"] = Array.from({ length: 8 }, (_, index) => ({
      kind: "text" as const,
      key: `f${index}`,
      title: `Field ${index}`,
      required: true,
    }));
    const lengths = [1800, 1800, 900, 900, 5, 5, 5, 5];
    const { request: req, abort: requestAbort } = request(fields);
    channel.requestElicitation(req).catch(() => {});
    const wait = (): Promise<void> => new Promise((r) => setTimeout(r, 6));
    await wait();
    client.emitButton(click(client, idFor(client, "start")));
    await wait();
    for (let index = 0; index < 8; index += 1) {
      client.emitButton(click(client, idFor(client, "field", index)));
      await wait();
      const modalId = client.modals[client.modals.length - 1]!.customId;
      client.emitModal(modal(client, modalId, { [fields[index]!.key]: "L".repeat(lengths[index]!) }, "user-A", index));
      await wait();
      if (index < 7) {
        client.emitButton(click(client, idFor(client, "next", index + 1)));
        await wait();
      }
    }
    // Open the long review first so its continuations exist.
    client.emitButton(click(client, idFor(client, "review")));
    await wait();

    const rowIds = (): string[] => (client.edited[client.edited.length - 1]!.body.components ?? [])
      .flatMap((row) => row.components)
      .map((component) => component.customId);
    const page1 = rowIds().find((id) => id.endsWith(":page:1"))!;

    // Start the transition; it parks on the held m2 edit.
    client.emitButton(click(client, page1));
    await new Promise((r) => setTimeout(r, 20));

    // Abort the request while the transition is in flight.
    const editsBeforeAbort = client.edited.length;
    requestAbort.abort();
    await new Promise((r) => setTimeout(r, 20));

    // Let the parked transition resume.
    release!();
    await new Promise((r) => setTimeout(r, 60));
    await wait();

    // The LAST primary edit must be the inert terminal card: content is the
    // cancelled text and the controls are stripped.
    const lastPrimary = client.edited[client.edited.length - 1]!;
    expect(lastPrimary.messageId).toBe("m1");
    expect(JSON.stringify(lastPrimary.body.content ?? "")).toContain("ancelled");
    expect(lastPrimary.body.components ?? []).toHaveLength(0);
    // No rerender edit landed after the terminal edit: the transition resumed
    // and repainted nothing.
    const editsAfterAbort = client.edited.filter((e) => e.messageId === "m1");
    expect(editsAfterAbort.length).toBe(editsBeforeAbort + 1);
    // Continuations were cleared.
    expect(client.deleted.length).toBeGreaterThan(0);
  } finally {
    release?.();
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("stop() drains a queued terminal render before the client is destroyed", async () => {
  // A terminal render enqueued but not yet run would lose the race against
  // `client.destroy()` in stop(), leaving the card interactive with no handler.
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  let destroyed = false;
  const realDestroy = client.destroy ? client.destroy.bind(client) : null;
  (client as unknown as { destroy: unknown }).destroy = async () => {
    destroyed = true;
    if (realDestroy) await realDestroy();
  };
  try {
    const { request: req } = request([
      { kind: "text", key: "body", title: "Body", required: true },
    ]);
    channel.requestElicitation(req).catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    const editsBefore = client.edited.length;

    await channel.stop();

    // The terminal card was published (and only then the client destroyed).
    expect(client.edited.length).toBe(editsBefore + 1);
    const last = client.edited[client.edited.length - 1]!;
    expect(last.body.components ?? []).toHaveLength(0);
    expect(destroyed).toBe(true);
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});
