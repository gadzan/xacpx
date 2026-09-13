import { beforeAll, expect, test } from "bun:test";

import { DiscordChannel } from "../../../../packages/channel-discord/src/channel";
import type { DiscordClientLike } from "../../../../packages/channel-discord/src/discord-client";
import type {
  DiscordButtonInteraction,
  OutboundBody,
} from "../../../../packages/channel-discord/src/types";
import { setChannelLocale } from "../../../../packages/channel-discord/src/i18n";
import { parsePermissionCustomId } from "../../../../packages/channel-discord/src/permission-ui";
import type { ChannelStartInput } from "xacpx/plugin-api";
import type { ChannelPermissionRequest } from "xacpx/plugin-api";

beforeAll(() => {
  setChannelLocale("en");
});

function makeLogger() {
  return {
    info: async () => {},
    warn: async () => {},
    error: async () => {},
    debug: async () => {},
  };
}

interface FakeDiscordClient extends DiscordClientLike {
  emitButton: (interaction: DiscordButtonInteraction) => void;
  sent: Array<{ channelId: string; body: OutboundBody }>;
  edited: Array<{ channelId: string; messageId: string; body: OutboundBody }>;
  ephemerals: string[];
}

function makeFakeClient(): FakeDiscordClient {
  let onButton: ((i: DiscordButtonInteraction) => void) | null = null;
  const sent: Array<{ channelId: string; body: OutboundBody }> = [];
  const edited: Array<{ channelId: string; messageId: string; body: OutboundBody }> = [];
  const ephemerals: string[] = [];
  const client: FakeDiscordClient = {
    start: async (input) => {
      onButton = input.handlers.onButton ?? null;
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
    sent,
    edited,
    ephemerals,
  };
  return client;
}

function buttonInteraction(
  client: FakeDiscordClient,
  customId: string,
  userId: string,
): DiscordButtonInteraction {
  return {
    customId,
    userId,
    channelId: "c1",
    acknowledge: async () => {},
    replyEphemeral: async (text: string) => {
      client.ephemerals.push(text);
    },
  };
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
    // enableAutocomplete:false keeps start() off the real Discord REST API;
    // the fake client has no network and command registration is irrelevant
    // to permission UI.
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

function permissionRequest(overrides: Partial<ChannelPermissionRequest> = {}): {
  request: ChannelPermissionRequest;
  abort: AbortController;
} {
  const abort = new AbortController();
  return {
    abort,
    request: {
      requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
      chatKey: "discord:default:g:c1",
      accountId: "default",
      replyContextToken: "msg-1",
      requester: { senderId: "user-A", senderName: "Ada", isOwner: true },
      toolCallId: "tool-1",
      title: "Run shell command",
      kind: "execute",
      summary: "npm run test",
      availableOutcomes: ["allow_once", "allow_always", "reject_once", "reject_always"],
      expiresAt: Date.now() + 5000,
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

test("initiator allow_once resolves and strips buttons", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request } = permissionRequest();
    const pending = channel.requestPermission(request);
    await new Promise((r) => setTimeout(r, 10));
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]!.body.components).toBeDefined();
    const allowId = customIdsOf(client).find((id) => id.endsWith(":allow"))!;
    expect(allowId).toBeTruthy();
    client.emitButton(buttonInteraction(client, allowId, "user-A"));
    const decision = await pending;
    // The decision carries the clicker identity so the core broker can
    // re-verify initiator-only approval (I3) instead of trusting the plugin.
    expect(decision).toEqual({ outcome: "allow_once", responderId: "user-A" });
    expect(client.edited).toHaveLength(1);
    expect(client.edited[0]!.body.components).toBeUndefined();
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("initiator deny resolves reject_once", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request } = permissionRequest();
    const pending = channel.requestPermission(request);
    await new Promise((r) => setTimeout(r, 10));
    const denyId = customIdsOf(client).find((id) => id.endsWith(":deny"))!;
    client.emitButton(buttonInteraction(client, denyId, "user-A"));
    const decision = await pending;
    expect(decision.outcome).toBe("reject_once");
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("non-initiator click is rejected ephemerally and the initiator can still decide", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request } = permissionRequest();
    const pending = channel.requestPermission(request);
    await new Promise((r) => setTimeout(r, 10));
    const allowId = customIdsOf(client).find((id) => id.endsWith(":allow"))!;
    client.emitButton(buttonInteraction(client, allowId, "user-INTRUDER"));
    await new Promise((r) => setTimeout(r, 10));
    expect(client.ephemerals.join("\n")).toContain("Only the user who started");
    client.emitButton(buttonInteraction(client, allowId, "user-A"));
    const decision = await pending;
    expect(decision.outcome).toBe("allow_once");
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("duplicate clicks: first decision wins, second gets already-resolved", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request } = permissionRequest();
    const pending = channel.requestPermission(request);
    await new Promise((r) => setTimeout(r, 10));
    const allowId = customIdsOf(client).find((id) => id.endsWith(":allow"))!;
    const denyId = customIdsOf(client).find((id) => id.endsWith(":deny"))!;
    client.emitButton(buttonInteraction(client, allowId, "user-A"));
    const decision = await pending;
    expect(decision.outcome).toBe("allow_once");
    client.emitButton(buttonInteraction(client, denyId, "user-A"));
    await new Promise((r) => setTimeout(r, 10));
    expect(client.ephemerals.join("\n")).toContain("already resolved");
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("forged token is ignored and the real request still resolves", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request } = permissionRequest();
    const pending = channel.requestPermission(request);
    await new Promise((r) => setTimeout(r, 10));
    client.emitButton(buttonInteraction(client, "xacpx-perm:deadbeefdeadbeef:allow", "user-A"));
    await new Promise((r) => setTimeout(r, 10));
    expect(client.ephemerals.join("\n")).toContain("already resolved");
    const allowId = customIdsOf(client).find((id) => id.endsWith(":allow"))!;
    client.emitButton(buttonInteraction(client, allowId, "user-A"));
    const decision = await pending;
    expect(decision.outcome).toBe("allow_once");
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("forged disallowed action cannot escalate to allow_always", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request } = permissionRequest({ availableOutcomes: ["allow_once", "reject_once"] });
    const pending = channel.requestPermission(request);
    await new Promise((r) => setTimeout(r, 10));
    const ids = customIdsOf(client);
    expect(ids.some((id) => id.endsWith(":always"))).toBe(false);
    const realAllow = ids.find((id) => id.endsWith(":allow"))!;
    const parsed = parsePermissionCustomId(realAllow)!;
    client.emitButton(buttonInteraction(client, `xacpx-perm:${parsed.token}:always`, "user-A"));
    await new Promise((r) => setTimeout(r, 10));
    client.emitButton(buttonInteraction(client, realAllow, "user-A"));
    const decision = await pending;
    expect(decision.outcome).toBe("allow_once");
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("abort before click rejects and marks the message cancelled", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request, abort: reqAbort } = permissionRequest();
    const pending = channel.requestPermission(request);
    await new Promise((r) => setTimeout(r, 10));
    reqAbort.abort();
    await expect(pending).rejects.toThrow();
    expect(client.edited.length).toBeGreaterThan(0);
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("expiry rejects (broker fails closed) and a late click is inert", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request } = permissionRequest({ expiresAt: Date.now() + 40 });
    const pending = channel.requestPermission(request);
    // Only a real user click may resolve a decision; expiry rejects and the
    // broker maps it to reject_once.
    await expect(pending).rejects.toThrow(/expired/);
    const allowId = customIdsOf(client).find((id) => id.endsWith(":allow"));
    if (allowId) {
      client.emitButton(buttonInteraction(client, allowId, "user-A"));
      await new Promise((r) => setTimeout(r, 10));
      expect(client.ephemerals.join("\n")).toContain("already resolved");
    }
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("channel stop invalidates the pending request", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  const { request } = permissionRequest({ expiresAt: Date.now() + 10_000 });
  const pending = channel.requestPermission(request);
  await new Promise((r) => setTimeout(r, 10));
  await channel.stop();
  await expect(pending).rejects.toThrow(/stopped/);
  abort.abort();
});

test("UI edit failure does not change the committed decision", async () => {
  const client = makeFakeClient();
  client.editMessage = async () => {
    throw new Error("edit down");
  };
  const { channel, abort } = await startChannel(client);
  try {
    const { request } = permissionRequest();
    const pending = channel.requestPermission(request);
    await new Promise((r) => setTimeout(r, 10));
    const allowId = customIdsOf(client).find((id) => id.endsWith(":allow"))!;
    client.emitButton(buttonInteraction(client, allowId, "user-A"));
    const decision = await pending;
    expect(decision.outcome).toBe("allow_once");
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});

test("only ACP-offered outcomes are rendered as buttons", async () => {
  const client = makeFakeClient();
  const { channel, abort } = await startChannel(client);
  try {
    const { request } = permissionRequest({ availableOutcomes: ["allow_once", "reject_once"] });
    const pending = channel.requestPermission(request);
    await new Promise((r) => setTimeout(r, 10));
    const ids = customIdsOf(client);
    expect(ids).toHaveLength(2);
    const denyId = ids.find((id) => id.endsWith(":deny"))!;
    client.emitButton(buttonInteraction(client, denyId, "user-A"));
    const decision = await pending;
  } finally {
    abort.abort();
    await channel.stop().catch(() => {});
  }
});
