import { expect, test } from "bun:test";
import { parseDiscordChannelConfig } from "../../../../packages/channel-discord/src/config";
import { buildDiscordChatKey, parseDiscordChatKey } from "../../../../packages/channel-discord/src/inbound";

// Review round 4 (High): the same token must never back two enabled accounts
// in ONE process. start() spawns one Gateway client per eligible account, so
// without config-level rejection, `{a: tok-X, b: tok-X}` opens two Gateway
// sessions for the same token (Discord allows exactly one) — and even if it
// deduped clients, two accounts with different access policies / requireMention
// over one client have no coherent semantics. Per-account base inheritance
// makes this trivially easy to hit, so both the explicit and inherited forms
// must be rejected. The error must not leak the token or a fingerprint.

test("duplicate explicit token across enabled accounts is rejected", () => {
  expect(() =>
    parseDiscordChannelConfig({ accounts: { a: { token: "tok-X" }, b: { token: "tok-X" } } }),
  ).toThrow(/duplicates the bot token/);
});

test("base-inherited token shared by two accounts is rejected", () => {
  expect(() =>
    parseDiscordChannelConfig({ token: "tok-X", accounts: { a: {}, b: {} } }),
  ).toThrow(/duplicates the bot token/);
});

test("duplicate token with one account disabled is allowed", () => {
  const cfg = parseDiscordChannelConfig({
    accounts: { a: { token: "tok-X" }, b: { token: "tok-X", enabled: false } },
  });
  expect(cfg.accounts.length).toBe(2);
});

test("distinct tokens are allowed", () => {
  const cfg = parseDiscordChannelConfig({
    accounts: { a: { token: "tok-X" }, b: { token: "tok-Y" } },
  });
  expect(cfg.accounts.length).toBe(2);
});

test("rejection message names account ids only, never the token", () => {
  let message = "";
  try {
    parseDiscordChannelConfig({ accounts: { a: { token: "super-secret-tok" }, b: { token: "super-secret-tok" } } });
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain("duplicates the bot token");
  expect(message).toContain("accounts.b");
  expect(message).toContain('"a"');
  expect(message).not.toContain("super-secret-tok");
});

// Round 6 M2: an account id is embedded in every chatKey
// ("discord:<accountId>:<kind>:<channelId>") and chatKeys are parsed back by
// splitting on ":". An id carrying the delimiter therefore round-trips into a
// different (accountId, kind, channelId) triple, so replies would be routed to
// the wrong account or chat type. Reject exactly what the grammar cannot
// express - the delimiter and the empty id - and nothing else.
test("account id containing the chatKey separator is rejected", () => {
  expect(() =>
    parseDiscordChannelConfig({ accounts: { "ops:east": { token: "tok-X" } } }),
  ).toThrow(/channel\.options\.accounts\.ops:east: account id must not contain ":"/);
});

test("empty account id is rejected", () => {
  expect(() =>
    parseDiscordChannelConfig({ accounts: { "": { token: "tok-X" } } }),
  ).toThrow(/account id must not be empty/);
});

test("defaultAccount used as the single-account id is checked too", () => {
  expect(() =>
    parseDiscordChannelConfig({ token: "tok-X", defaultAccount: "ops:east" }),
  ).toThrow(/channel\.options\.defaultAccount: account id must not contain ":"/);
});

test("separator-free ids survive and their chatKey round-trips", () => {
  const cfg = parseDiscordChannelConfig({ accounts: { "ops-east.work": { token: "tok-X" } } });
  expect(cfg.accounts[0]!.accountId).toBe("ops-east.work");
  const accountId = "ops-east.work";
  const chatKey = buildDiscordChatKey({ accountId, route: { accountId, kind: "guild", channelId: "c1" } });
  expect(chatKey).toBe("discord:ops-east.work:g:c1");
  expect(parseDiscordChatKey(chatKey)).toEqual({ accountId, kind: "guild", channelId: "c1", chatKey });
});
