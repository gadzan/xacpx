import { expect, test } from "bun:test";
import { parseDiscordChannelConfig } from "../../../../packages/channel-discord/src/config";

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
