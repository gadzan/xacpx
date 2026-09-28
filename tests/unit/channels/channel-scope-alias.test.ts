import { expect, test } from "bun:test";

import {
  getChannelIdFromChatKey,
  resolveSessionAliasForInput,
  scopeDisplayAliasToInternal,
} from "../../../src/channels/channel-scope";
import {
  isProductOwnedSessionAlias,
  ownedDirectSessionAlias,
} from "../../../src/domain/ids";

/**
 * The Direct Conversation session alias must survive channel scoping.
 *
 * A `bot:<conversationId>:<topicId>` chatKey routes to the relay channel, so
 * every alias-scoping helper is handed channel id `relay`. The product mints its
 * session alias UNscoped (`ownedDirectSessionAlias` → `brt_<bindingId>`) and
 * stores the record under exactly that key.
 *
 * The bug this pins: both helpers then produced `relay:brt_<bindingId>`, a key no
 * record ever had, so every Direct Bot prompt failed with
 * `session "brt_…" does not exist` and the bot turn could never run.
 *
 * It surfaced only after #360's `bot:` routing rule landed — before that, the
 * same chatKey mapped to `weixin`, whose branch leaves aliases unprefixed, which
 * is why this was never wrong on `main`.
 */

const ALIAS = ownedDirectSessionAlias("bind_abc123");

test("a bot: chatKey routes to the relay channel (the rule that exposed the bug)", () => {
  expect(getChannelIdFromChatKey("bot:conv_1:topic_1")).toBe("relay");
});

test("SKIPPED predicate drift", () => {
  expect(isProductOwnedSessionAlias(ALIAS)).toBe(true);
  // Not a product alias: an ordinary display alias, or a bare prefix.
  expect(isProductOwnedSessionAlias("backend")).toBe(false);
  expect(isProductOwnedSessionAlias("brt_")).toBe(false);
  expect(isProductOwnedSessionAlias("relay:brt_x")).toBe(false);
});

test("scopeDisplayAliasToInternal never prefixes a product alias", () => {
  // Under the relay channel — the shape a Direct Bot turn actually produces.
  expect(scopeDisplayAliasToInternal("relay", ALIAS)).toBe(ALIAS);
  // And under every other channel: the alias is not channel-scoped at all.
  expect(scopeDisplayAliasToInternal("weixin", ALIAS)).toBe(ALIAS);
  expect(scopeDisplayAliasToInternal("discord", ALIAS)).toBe(ALIAS);
  // Ordinary aliases are still scoped, so the rule did not over-apply.
  expect(scopeDisplayAliasToInternal("relay", "backend")).toBe("relay:backend");
});

test("resolveSessionAliasForInput resolves a product alias to the stored record", () => {
  // The exact production case: the record exists under the bare alias, and the
  // chatKey's channel says `relay`. Resolving must find it.
  expect(resolveSessionAliasForInput("relay", ALIAS, [ALIAS])).toBe(ALIAS);

  // A scoped form in the display position is still an alias that starts with the
  // channel id, and it must not be double-prefixed.
  expect(resolveSessionAliasForInput("relay", "relay:backend", ["relay:backend"]))
    .toBe("relay:backend");
});

test("resolveSessionAliasForInput falls back to the bare alias before any record exists", () => {
  // The session is created on first prompt, so the resolver is asked before the
  // record is stored. Returning the scoped form here would make the create path
  // and the lookup path disagree about where the record will live.
  expect(resolveSessionAliasForInput("relay", ALIAS, [])).toBe(ALIAS);
  expect(resolveSessionAliasForInput("relay", ALIAS, ["relay:other"])).toBe(ALIAS);
});

test("resolveSessionAliasForInput still scopes an ordinary alias on a non-default channel", () => {
  // The product-alias rule is narrow. Without this, the fix would silently
  // unscoping every alias and break the channel isolation the prefix exists for.
  expect(resolveSessionAliasForInput("relay", "backend", [])).toBe("relay:backend");
  expect(resolveSessionAliasForInput("relay", "backend", ["relay:backend"]))
    .toBe("relay:backend");
  expect(resolveSessionAliasForInput("discord", "backend", ["discord:backend"]))
    .toBe("discord:backend");
});

test("the weixin channel keeps its unprefixed legacy shape", () => {
  // With a record present, the bare alias resolves — that is the legacy shape.
  expect(resolveSessionAliasForInput("weixin", "backend", ["backend"])).toBe("backend");
  // With no record, the resolver returns the channel's default form. For weixin
  // that is the display alias UNPREFIXED — the resolver's own default rule, which
  // is why the earlier scoping never broke a bot turn whose session did not yet
  // exist: the fix only had to cover the case where the record IS there (or is
  // about to be created) under the unscoped key.
  expect(resolveSessionAliasForInput("weixin", "backend", [])).toBe("weixin:backend");
  // `scopeDisplayAliasToInternal` guarantees the weixin shape unconditionally.
  expect(scopeDisplayAliasToInternal("weixin", "backend")).toBe("backend");
});
