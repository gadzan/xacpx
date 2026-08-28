import { expect, test, describe } from "bun:test";
import {
  buildDiscordChatKey,
  parseDiscordChatKey,
  buildDiscordQueueKey,
  evaluateDiscordAccessPolicy,
  shouldHandleDiscordMessage,
  cleanDiscordMention,
  resolveChannelRequireMention,
} from "../../../../packages/channel-discord/src/inbound";
import type { DiscordInboundMessage, DiscordRoute } from "../../../../packages/channel-discord/src/types";
import type { DiscordResolvedAccountConfig } from "../../../../packages/channel-discord/src/config";

function baseAccount(overrides: Partial<DiscordResolvedAccountConfig> = {}): DiscordResolvedAccountConfig {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    token: "tok",
    applicationId: "",
    replyMode: "auto",
    tableMode: "code",
    maxLinesPerMessage: 17,
    previewThrottleMs: 1200,
    minInitialChars: 200,
    typingIndicator: true,
    ackReaction: null,
    requireMention: true,
    dmPolicy: "allowlist",
    guildPolicy: "allowlist",
    allowFrom: ["u1", "u2"],
    guilds: {},
    allowBots: false,
    dedupTtlMs: 86400000,
    dedupMaxEntries: 10000,
    inboundExpiryMs: 300000,
    intents: { messageContent: true, guildMembers: false },
    media: { maxBytes: 8 * 1024 * 1024, maxAttachments: 10 },
    ...overrides,
  };
}

function dmRoute(channelId = "c1"): DiscordRoute {
  return { accountId: "default", kind: "dm", channelId };
}
function guildRoute(guildId = "g1", channelId = "c1"): DiscordRoute {
  return { accountId: "default", kind: "guild", channelId, guildId };
}
function threadRoute(guildId = "g1", threadId = "t1"): DiscordRoute {
  return { accountId: "default", kind: "thread", channelId: threadId, guildId };
}

function msg(overrides: Partial<DiscordInboundMessage> = {}): DiscordInboundMessage {
  return {
    id: "m1",
    channelId: "c1",
    guildId: null,
    author: { id: "u1", bot: false },
    content: "hello",
    createdTimestamp: Date.now(),
    ...overrides,
  };
}

describe("build/parse chatKey round-trip", () => {
  test("dm/g/thread keys round-trip and non-discord prefix returns null", () => {
    const dm = buildDiscordChatKey({ accountId: "a1", route: { accountId: "a1", kind: "dm", channelId: "u1" } });
    expect(dm).toBe("discord:a1:dm:u1");
    expect(parseDiscordChatKey(dm)!.kind).toBe("dm");

    const g = buildDiscordChatKey({ accountId: "a1", route: { accountId: "a1", kind: "guild", channelId: "c1", guildId: "g1" } });
    expect(g).toBe("discord:a1:g:c1");
    expect(parseDiscordChatKey(g)!.kind).toBe("guild");

    const t = buildDiscordChatKey({ accountId: "a1", route: { accountId: "a1", kind: "thread", channelId: "t1" } });
    expect(t).toBe("discord:a1:t:t1");
    expect(parseDiscordChatKey(t)!.kind).toBe("thread");

    expect(parseDiscordChatKey("feishu:oc_xxx")).toBeNull();
    expect(parseDiscordChatKey("discord:bad")).toBeNull();
  });

  test("queue key is stable", () => {
    expect(buildDiscordQueueKey("a1", "c1", "guild")).toBe("a1:guild:c1");
    expect(buildDiscordQueueKey("a1", "c1", "dm")).toBe("a1:dm:c1");
  });
});

describe("evaluateDiscordAccessPolicy matrix", () => {
  test("dm allowlist", () => {
    const acc = baseAccount({ dmPolicy: "allowlist", guildPolicy: "disabled", allowFrom: ["u1"] });
    expect(evaluateDiscordAccessPolicy({ route: dmRoute(), account: acc, senderId: "u1" }).allow).toBe(true);
    expect(evaluateDiscordAccessPolicy({ route: dmRoute(), account: acc, senderId: "u9" }).allow).toBe(false);
    expect(evaluateDiscordAccessPolicy({ route: dmRoute(), account: acc }).allow).toBe(false);
  });

  test("dm open and disabled", () => {
    expect(evaluateDiscordAccessPolicy({ route: dmRoute(), account: baseAccount({ dmPolicy: "open" }), senderId: "any" }).allow).toBe(true);
    const disabled = evaluateDiscordAccessPolicy({ route: dmRoute(), account: baseAccount({ dmPolicy: "disabled" }), senderId: "u1" });
    expect(disabled.allow).toBe(false);
    if (!disabled.allow) expect(disabled.reason).toBe("dm_disabled");
  });

  test("guild allowlist via global allowFrom", () => {
    const acc = baseAccount({ dmPolicy: "disabled", guildPolicy: "allowlist", allowFrom: ["u1"] });
    expect(evaluateDiscordAccessPolicy({ route: guildRoute(), account: acc, senderId: "u1" }).allow).toBe(true);
    expect(evaluateDiscordAccessPolicy({ route: guildRoute(), account: acc, senderId: "u9" }).allow).toBe(false);
  });

  test("guild-specific users/roles overrides global", () => {
    const acc = baseAccount({
      guildPolicy: "allowlist",
      allowFrom: ["other"],
      guilds: {
        g1: { users: ["u1"], roles: ["r1"], channels: { c1: { requireMention: false } } },
      },
    });
    // user match
    expect(evaluateDiscordAccessPolicy({ route: guildRoute("g1", "c1"), account: acc, senderId: "u1", senderRoleIds: [] }).allow).toBe(true);
    // role match
    expect(evaluateDiscordAccessPolicy({ route: guildRoute("g1", "c1"), account: acc, senderId: "u9", senderRoleIds: ["r1"] }).allow).toBe(true);
    // neither matches
    expect(evaluateDiscordAccessPolicy({ route: guildRoute("g1", "c1"), account: acc, senderId: "u9", senderRoleIds: ["r9"] }).allow).toBe(false);
    // hasGuildSpecific true should bypass global allowFrom; u9 with no guild match still false
    expect(evaluateDiscordAccessPolicy({ route: guildRoute("g1", "c1"), account: acc, senderId: "other", senderRoleIds: [] }).allow).toBe(false);
  });

  test("guild disabled blocks", () => {
    const d = evaluateDiscordAccessPolicy({ route: guildRoute(), account: baseAccount({ guildPolicy: "disabled" }), senderId: "u1" });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("guild_disabled");
  });

  test("guild open without allowlist", () => {
    expect(evaluateDiscordAccessPolicy({ route: guildRoute(), account: baseAccount({ guildPolicy: "open" }), senderId: "u9" }).allow).toBe(true);
  });

  test("thread uses same guild policy as parent guild", () => {
    const acc = baseAccount({ guildPolicy: "allowlist", allowFrom: ["u1"], guilds: { g1: { users: ["u1"] } } });
    expect(evaluateDiscordAccessPolicy({ route: threadRoute("g1"), account: acc, senderId: "u1" }).allow).toBe(true);
    expect(evaluateDiscordAccessPolicy({ route: threadRoute("g1"), account: acc, senderId: "u9" }).allow).toBe(false);
  });
});

describe("shouldHandleDiscordMessage mention gate", () => {
  test("DM always handles", () => {
    const m = msg({ guildId: null, content: "hi bot" });
    expect(shouldHandleDiscordMessage({ message: m, botUserId: "bot", requireMention: true, accountRequireMention: true, isDM: true }).handle).toBe(true);
  });

  test("guild requireMention true requires @bot or reply-to-bot", () => {
    const base = { guildId: "g1" as string | null, content: "hello" } as Partial<DiscordInboundMessage>;
    expect(
      shouldHandleDiscordMessage({ message: msg(base), botUserId: "bot", requireMention: true, accountRequireMention: true, isDM: false }).handle,
    ).toBe(false);

    expect(
      shouldHandleDiscordMessage({
        message: msg({ ...base, mentions: { users: [{ id: "bot" }] } }),
        botUserId: "bot",
        requireMention: true,
        accountRequireMention: true,
        isDM: false,
      }).handle,
    ).toBe(true);

    expect(
      shouldHandleDiscordMessage({
        message: msg({ ...base, repliedUserId: "bot", referencedMessageId: "m0" }),
        botUserId: "bot",
        requireMention: true,
        accountRequireMention: true,
        isDM: false,
      }).handle,
    ).toBe(true);

    // reply to someone else should not count
    expect(
      shouldHandleDiscordMessage({
        message: msg({ ...base, repliedUserId: "other", referencedMessageId: "m0" }),
        botUserId: "bot",
        requireMention: true,
        accountRequireMention: true,
        isDM: false,
      }).handle,
    ).toBe(false);

    // fallback tag in content counts when mentions not populated
    expect(
      shouldHandleDiscordMessage({
        message: msg({ ...base, content: "<@bot> hello" }),
        botUserId: "bot",
        requireMention: true,
        accountRequireMention: true,
        isDM: false,
      }).handle,
    ).toBe(true);
  });

  test("guild requireMention false handles without mention", () => {
    expect(
      shouldHandleDiscordMessage({ message: msg({ guildId: "g1", content: "hi" }), botUserId: "bot", requireMention: false, accountRequireMention: false, channelRequireMention: false, isDM: false }).handle,
    ).toBe(true);
  });

  test("channel-level requireMention overrides account", () => {
    // account true but channel false
    expect(
      shouldHandleDiscordMessage({ message: msg({ guildId: "g1", content: "hi" }), botUserId: "bot", requireMention: false, accountRequireMention: true, channelRequireMention: false, isDM: false }).handle,
    ).toBe(true);
  });
});

describe("cleanDiscordMention and resolveChannelRequireMention", () => {
  test("clean strips bot mention tags and collapses whitespace", () => {
    expect(cleanDiscordMention("<@bot> hello  <@!bot>  world ", "bot")).toBe("hello world");
    expect(cleanDiscordMention("  hello   world  ", "bot")).toBe("hello world");
  });

  test("resolveChannelRequireMention respects per-channel override and parent fallback is handled by caller", () => {
    const acc = baseAccount({ guilds: { g1: { channels: { c1: { requireMention: false } } } } });
    expect(resolveChannelRequireMention(acc, "g1", "c1")).toBe(false);
    expect(resolveChannelRequireMention(acc, "g1", "c2")).toBeUndefined();
    expect(resolveChannelRequireMention(acc, undefined, "c1")).toBeUndefined();
  });
});
