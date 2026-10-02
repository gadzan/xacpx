import { beforeAll, expect, test } from "bun:test";

import {
  buildDefaultTransportSession,
  getChannelIdFromChatKey,
  isLegacyWeixinChatKey,
  isSessionAliasVisibleInChannel,
  registerKnownChannelId,
  resolveSessionAliasForInput,
  scopeDisplayAliasToInternal,
  toDisplaySessionAlias,
  toInternalSessionAlias,
} from "../../../src/channels/channel-scope";

// After Phase C2, feishu is plugin-provided. These tests cover scope helpers
// for known channel ids; register feishu as a known id so the existing
// expectations continue to model the post-plugin-registration runtime state.
beforeAll(() => {
  registerKnownChannelId("feishu");
});

test("a Direct Conversation isolation key resolves to the relay channel", () => {
  // `bot` is the product kind, not a channel id, so there is no prefix to match
  // against the known set. Falling through to the weixin default would send a
  // Direct Bot turn to a channel that cannot render an interaction, and the
  // broker would cancel with a message that looks like an unsupported channel.
  expect(getChannelIdFromChatKey("bot:conv_1:topic_1")).toBe("relay");
  // An unrelated key with the same first segment is NOT a bot key.
  expect(getChannelIdFromChatKey("botzone:default:chat")).toBe("weixin");
  // And the ordinary channels are unaffected.
  expect(getChannelIdFromChatKey("feishu:default:oc_chat")).toBe("feishu");
  expect(getChannelIdFromChatKey("weixin:default:wxid_alice")).toBe("weixin");
  expect(getChannelIdFromChatKey("wxid_alice")).toBe("weixin");
});

test("extracts channel id from prefixed chat keys and treats legacy keys as weixin", () => {
  expect(getChannelIdFromChatKey("feishu:default:oc_chat")).toBe("feishu");
  expect(getChannelIdFromChatKey("weixin:default:wxid_alice")).toBe("weixin");
  expect(getChannelIdFromChatKey("wxid_alice")).toBe("weixin");
  expect(isLegacyWeixinChatKey("wxid_alice")).toBe(true);
  expect(isLegacyWeixinChatKey("feishu:default:oc_chat")).toBe(false);
});

test("registered plugin channel ids are recognized as chat key prefixes", () => {
  registerKnownChannelId("custom-review-channel");

  expect(getChannelIdFromChatKey("custom-review-channel:default:chat")).toBe("custom-review-channel");
  expect(getChannelIdFromChatKey("unknown-review-channel:default:chat")).toBe("weixin");
});

test("converts internal and display aliases", () => {
  expect(toInternalSessionAlias("feishu", "backend:codex")).toBe("feishu:backend:codex");
  expect(toInternalSessionAlias("weixin", "backend:codex")).toBe("weixin:backend:codex");
  expect(toDisplaySessionAlias("feishu:backend:codex")).toBe("backend:codex");
  expect(toDisplaySessionAlias("weixin:backend:codex")).toBe("backend:codex");
  expect(toDisplaySessionAlias("backend:codex")).toBe("backend:codex");
});

test("filters aliases visible in each channel", () => {
  expect(isSessionAliasVisibleInChannel("backend:codex", "weixin")).toBe(true);
  expect(isSessionAliasVisibleInChannel("weixin:backend:codex", "weixin")).toBe(true);
  expect(isSessionAliasVisibleInChannel("feishu:backend:codex", "weixin")).toBe(false);
  expect(isSessionAliasVisibleInChannel("backend:codex", "feishu")).toBe(false);
  expect(isSessionAliasVisibleInChannel("feishu:backend:codex", "feishu")).toBe(true);
});

test("resolves input aliases with legacy weixin preference", () => {
  expect(resolveSessionAliasForInput("weixin", "backend:codex", ["backend:codex"])).toBe("backend:codex");
  expect(resolveSessionAliasForInput("weixin", "backend:codex", [])).toBe("weixin:backend:codex");
  expect(resolveSessionAliasForInput("weixin", "backend:codex", ["weixin:backend:codex"])).toBe("weixin:backend:codex");
  expect(resolveSessionAliasForInput("feishu", "backend:codex", ["backend:codex"])).toBe("feishu:backend:codex");
  expect(resolveSessionAliasForInput("feishu", "backend:codex", [])).toBe("feishu:backend:codex");
  expect(resolveSessionAliasForInput("feishu", "feishu:backend:codex", [])).toBe("feishu:backend:codex");
});

test("scopes a display alias to an internal alias, leaving the default weixin channel unprefixed", () => {
  expect(scopeDisplayAliasToInternal("weixin", "fix-ci")).toBe("fix-ci");
  expect(scopeDisplayAliasToInternal("feishu", "fix-ci")).toBe("feishu:fix-ci");
  // Idempotent: an already-scoped alias must not be double-prefixed.
  expect(scopeDisplayAliasToInternal("feishu", "feishu:fix-ci")).toBe("feishu:fix-ci");
  expect(() => scopeDisplayAliasToInternal("feishu", "   ")).toThrow();
});

test("builds default transport session names per channel", () => {
  expect(buildDefaultTransportSession("weixin", "backend:codex")).toBe("backend:codex");
  expect(buildDefaultTransportSession("feishu", "backend:codex")).toBe("feishu:backend:codex");
  expect(buildDefaultTransportSession("dingtalk", "backend:codex")).toBe("dingtalk:backend:codex");
});
