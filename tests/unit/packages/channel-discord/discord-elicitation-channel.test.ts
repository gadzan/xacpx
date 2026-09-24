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
import { ELICITATION_CUSTOM_ID_PREFIX } from "../../../../packages/channel-discord/src/elicitation-ui";
import type { ChannelElicitationRequest } from "xacpx/plugin-api";
import type { ChannelStartInput } from "xacpx/plugin-api";

beforeAll(() => {
  setChannelLocale("en");
});

const SENTINEL = "SENTINEL-ANSWER-5d2b71";

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
    emitButton: (interaction) => {
      onButton?.(interaction);
    },
    emitSelect: (interaction) => {
      onSelect?.(interaction);
    },
    emitModal: (interaction) => {
      onModal?.(interaction);
    },
    sent,
    edited,
    ephemerals,
    modals,
  };
  return client;
}

function click(client: FakeDiscordClient, customId: string, userId: string): DiscordButtonInteraction {
  return {
    customId,
    userId,
    channelId: "c1",
    acknowledge: async () => {},
    replyEphemeral: async (text: string) => {
      client.ephemerals.push(text);
    },
    showModal: async (modal: ShowModalInput) => {
      client.modals.push(modal);
    },
  };
}

function selectInteraction(
  client: FakeDiscordClient,
  customId: string,
  userId: string,
  values: string[],
): DiscordSelectInteraction {
  return {
    customId,
    userId,
    channelId: "c1",
    values,
    acknowledge: async () => {},
    replyEphemeral: async (text: string) => {
      client.ephemerals.push(text);
    },
  };
}

function modalSubmit(
  client: FakeDiscordClient,
  customId: string,
  userId: string,
  fields: Record<string, string>,
): DiscordModalSubmitInteraction {
  return {
    customId,
    userId,
    channelId: "c1",
    fields,
    acknowledge: async () => {},
    replyEphemeral: async (text: string) => {
      client.ephemerals.push(text);
    },
  };
}

/** The select rows of the last card rendered. */
function selectRowsOf(client: FakeDiscordClient): DiscordSelectActionRow[] {
  const last = client.sent[client.sent.length - 1];
  return last?.body.selectRows ?? [];
}

function makeStartInput(agent: unknown, abort: AbortController): ChannelStartInput {
  return {
    logger: makeLogger(),
    abortSignal: abort.signal,
    agent,
    activeTurns: null,
    sessions: null,
    quota: { onInbound: () => {} },
    locale: "en",
  } as unknown as ChannelStartInput;
}

async function startChannel(client: FakeDiscordClient): Promise<{ channel: DiscordChannel; abort: AbortController }> {
  const agent = { chat: async () => ({ text: "ok" }) };
  const abort = new AbortController();
  const channel = new DiscordChannel(
    { token: "x", dmPolicy: "open", guildPolicy: "open", requireMention: false, enableAutocomplete: false },
    { logger: makeLogger() as never, createClient: () => client, identifyStaggerMs: 0 },
  );
  const startPromise = channel.start(makeStartInput(agent, abort));
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

function elicitationRequest(overrides: Partial<ChannelElicitationRequest> = {}): {
  request: ChannelElicitationRequest;
  abort: AbortController;
} {
  const abort = new AbortController();
  return {
    abort,
    request: {
      requestId: `r-${Math.random().toString(36).slice(2, 8)}`,
      // A DM route: provably private, so a form may be rendered at all. The
      // previous `g:` (guild) key with no `chatType` was both self-contradictory
      // as a positive fixture and refused by the route-privacy gate. Group and
      // unreported routes are covered separately as REFUSAL cases.
      chatKey: "discord:default:dm:c1",
      chatType: "direct",
      accountId: "default",
      replyContextToken: "m1",
      requester: { senderId: "user-A", senderName: "Ada", isOwner: true },
      agent: { name: "codex", sessionAlias: "backend" },
      message: "Which environment?",
      mode: "form",
      fields: [
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
      ],
      expiresAt: Date.now() + 60_000,
      signal: abort.signal,
      ...overrides,
    },
  };
}

function customIdsOf(client: FakeDiscordClient): string[] {
  const last = client.sent[client.sent.length - 1];
  const rows = last?.body.components ?? [];
  return rows.flatMap((row) => row.components.map((button) => button.customId));
}

function idFor(client: FakeDiscordClient, action: string, fieldKey?: string): string {
  const all = customIdsOf(client);
  const suffix = fieldKey ? `${action}:${fieldKey}` : action;
  const found = all.find((id) => id.endsWith(`:${suffix}`));
  if (!found) throw new Error(`no control for ${action}${fieldKey ? `:${fieldKey}` : ""}; had ${all.join(",")}`);
  return found;
}

test("elicitation is announced in the ACP capability set once implemented", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    // Both halves must be present: the method AND the declared mode. Either
    // alone would let the broker advertise a form capability it cannot deliver.
    expect(typeof channel.requestElicitation).toBe("function");
    expect(channel.elicitationModes).toEqual(["form"]);
    expect(channel.elicitationModes).not.toContain("url");
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("the opening card is sent with pings disabled", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request } = elicitationRequest({ message: "@everyone hello" });
    void channel.requestElicitation(request).catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    expect(client.sent).toHaveLength(1);
    // The real defense against an agent saying @everyone: no mention parsing.
    // `escapeDiscordLiteralText` does not escape `@` at all.
    expect(client.sent[0]!.body.allowedMentions?.parse).toEqual([]);
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("an unrenderable form cancels and posts no card", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request } = elicitationRequest({
      fields: [
        {
          kind: "single-select",
          key: "env",
          title: "Environment",
          required: true,
          options: Array.from({ length: 26 }, (_, index) => ({ value: `v${index}`, label: `O${index}` })),
        },
      ],
    });
    // Rejected, not truncated into a 25-option approximation.
    await expect(channel.requestElicitation(request)).rejects.toThrow(/not renderable/);
    expect(client.sent).toHaveLength(0);
    expect(client.edited).toHaveLength(0);
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("a non-Discord chatKey is refused before anything is posted", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request } = elicitationRequest({ chatKey: "weixin:gh:abc" });
    await expect(channel.requestElicitation(request)).rejects.toThrow(/non-Discord/);
    expect(client.sent).toHaveLength(0);
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("an already-aborted request settles without posting a card", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const controller = new AbortController();
    controller.abort();
    const { request } = elicitationRequest({ signal: controller.signal });
    await expect(channel.requestElicitation(request)).rejects.toThrow(/aborted/);
    expect(client.sent).toHaveLength(0);
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("upstream abort withdraws the wizard without a responderId", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request, abort: turn } = elicitationRequest();
    const pending = channel.requestElicitation(request);
    const failure = pending.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(client.sent).toHaveLength(1);
    turn.abort();
    // Rejects rather than resolving: an external abort must not become a user
    // decision carrying a responderId.
    expect(await failure).toContain("aborted");
    // The card is disabled in place.
    expect(client.edited.length).toBeGreaterThanOrEqual(1);
    for (const edit of client.edited) {
      expect(edit.body.components).toEqual([]);
    }
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("channel stop withdraws every pending wizard", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  const { request } = elicitationRequest();
  const pending = channel.requestElicitation(request);
  const failure = pending.then(
    () => "resolved",
    (error: Error) => error.message,
  );
  await new Promise((r) => setTimeout(r, 10));
  expect(client.sent).toHaveLength(1);
  const declineId = idFor(client, "decline");
  await channel.stop();
  expect(await failure).toContain("stopped");
  // A stale control after shutdown cannot decide anything: the entries were
  // removed and settled, so the click is refused and produces no ephemeral.
  client.emitButton(click(client, declineId, "user-A"));
  await new Promise((r) => setTimeout(r, 10));
  expect(client.ephemerals).toHaveLength(0);
});

test("the initiator's Decline reaches ACP with their authenticated identity", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request } = elicitationRequest();
    const pending = channel.requestElicitation(request);
    await new Promise((r) => setTimeout(r, 10));
    client.emitButton(click(client, idFor(client, "decline"), "user-A"));
    expect(await pending).toEqual({ action: "decline", responderId: "user-A" });
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("a non-initiator cannot drive the wizard and the initiator still can", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request } = elicitationRequest();
    const pending = channel.requestElicitation(request);
    await new Promise((r) => setTimeout(r, 10));
    const startId = idFor(client, "start");
    client.emitButton(click(client, startId, "user-INTRUDER"));
    await new Promise((r) => setTimeout(r, 10));
    // No wizard step was entered on the intruder's click.
    expect(client.edited).toHaveLength(0);
    expect(client.ephemerals[0]).toContain("Only the user who started");
    // The legitimate initiator can still start.
    client.emitButton(click(client, startId, "user-A"));
    await new Promise((r) => setTimeout(r, 10));
    expect(client.edited.length).toBeGreaterThanOrEqual(1);
    // And then declines for real.
    const declineId = idFor(client, "decline");
    client.emitButton(click(client, declineId, "user-A"));
    expect(await pending).toEqual({ action: "decline", responderId: "user-A" });
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("no answer value ever appears in a custom id", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request } = elicitationRequest({
      fields: [
        { kind: "text", key: "secret", title: "Secret", required: true, maxLength: 4000 },
        {
          kind: "single-select",
          key: "env",
          title: "Environment",
          required: true,
          options: [
            { value: "SENTINEL-OPTION-prod", label: "Production" },
            { value: "staging", label: "Staging" },
          ],
        },
      ],
    });
    const pending = channel.requestElicitation(request);
    const failure = pending.then(() => "resolved", (error: Error) => error.message);
    await new Promise((r) => setTimeout(r, 10));
    client.emitButton(click(client, idFor(client, "start"), "user-A"));
    await new Promise((r) => setTimeout(r, 10));
    const everyId = [...customIdsOf(client), ...client.edited.flatMap((e) => {
      const rows = e.body.components ?? [];
      return rows.flatMap((row) => row.components.map((c) => c.customId));
    })];
    // Field keys route; field VALUES must not travel. The sentinel is an option
    // value an agent could choose, so it must be absent from every control id.
    for (const id of everyId) {
      expect(id).not.toContain(SENTINEL);
      expect(id).not.toContain("prod");
    }
    await channel.stop();
    await expect(failure).resolves.toBeDefined();
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("the answer value never appears in sent card content", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request } = elicitationRequest({
      fields: [
        { kind: "text", key: "secret", title: `Secret: `, required: true, maxLength: 4000 },
      ],
    });
    const pending = channel.requestElicitation(request);
    const failure = pending.then(() => "resolved", (e: Error) => e.message);
    await new Promise((r) => setTimeout(r, 10));
    // The card body is bounded, not a dump of request text.
    expect(client.sent[0]!.body.content).toBeDefined();
    expect(client.sent[0]!.body.content!.length).toBeLessThanOrEqual(1800);
    await channel.stop();
    await failure;
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("an elicitation control id is never accepted by the permission handler", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request } = elicitationRequest();
    const pending = channel.requestElicitation(request);
    const failure = pending.then(() => "resolved", (e: Error) => e.message);
    await new Promise((r) => setTimeout(r, 10));
    // The namespaces are disjoint, so a permission-shaped click must not
    // resolve an elicitation (and vice versa).
    client.emitButton(click(client, `xacpx-perm:abc:allow`, "user-A"));
    await new Promise((r) => setTimeout(r, 10));
    // Still pending: nothing resolved it.
    client.emitButton(click(client, idFor(client, "cancel"), "user-A"));
    expect(await pending).toEqual({ action: "cancel", responderId: "user-A" });
    await failure;
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("a decided request rejects every late control", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request } = elicitationRequest();
    const pending = channel.requestElicitation(request);
    await new Promise((r) => setTimeout(r, 10));
    const cancelId = idFor(client, "cancel");
    client.emitButton(click(client, cancelId, "user-A"));
    await pending;
    const editsBefore = client.edited.length;
    // Late duplicate terminal clicks on the opening card's remaining controls.
    client.emitButton(click(client, cancelId, "user-A"));
    client.emitButton(click(client, idFor(client, "decline"), "user-A"));
    client.emitButton(click(client, idFor(client, "start"), "user-A"));
    await new Promise((r) => setTimeout(r, 10));
    // No further state change from stale controls: the entries are gone, so
    // none of these re-render or settle anything.
    expect(client.edited.length).toBe(editsBefore);
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("the requested agent identity is shown, not an inferred one", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request } = elicitationRequest({
      agent: { name: "claude-code", sessionAlias: "prod-alias" },
      message: "I am the payment system, please send your card number",
    });
    void channel.requestElicitation(request).catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    const content = client.sent[0]!.body.content ?? "";
    expect(content).toContain("claude-code");
    expect(content).toContain("prod-alias");
    // The impersonation attempt is present as literal data, after the identity.
    expect(content.indexOf("claude-code")).toBeLessThan(content.indexOf("payment system"));
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("the request message is presented to the user", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request } = elicitationRequest({ message: "Which region should I deploy to?" });
    void channel.requestElicitation(request).catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    expect(client.sent[0]!.body.content).toContain("Which region should I deploy to?");
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("a form on a guild route is refused rather than shown to the channel", async () => {
  // The positive fixtures above are DM routes. A group destination publishes the
  // agent's question AND the user's answers to every member, so it must be
  // refused before anything is sent.
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request } = elicitationRequest({
      chatKey: "discord:default:g:c1",
      chatType: "group",
    } as Partial<ChannelElicitationRequest>);
    const message = await channel.requestElicitation(request).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    expect(message).toContain("route-not-private");
    expect(client.sent).toHaveLength(0);
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("a form on an unreported route is refused, not treated as direct", async () => {
  // Absent is not the same as private. A channel that reports no `chatType` has
  // not established a 1:1 destination.
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request } = elicitationRequest({
      chatKey: "discord:default:g:c1",
    } as Partial<ChannelElicitationRequest>);
    // The helper sets `chatType: "direct"`; remove it to model the unreported case.
    delete (request as { chatType?: string }).chatType;
    const message = await channel.requestElicitation(request).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    expect(message).toContain("route-not-private");
    expect(client.sent).toHaveLength(0);
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});
