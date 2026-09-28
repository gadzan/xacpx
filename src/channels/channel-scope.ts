import { isProductOwnedSessionAlias } from "../domain/ids.js";

const KNOWN_CHANNEL_IDS = new Set(["weixin"]);

export function registerKnownChannelId(channelId: string): void {
  const normalized = channelId.trim();
  if (!normalized || normalized.includes(":")) {
    throw new Error("channel id must be non-empty and must not contain ':'");
  }
  KNOWN_CHANNEL_IDS.add(normalized);
}

export function listKnownChannelIds(): string[] {
  return Array.from(KNOWN_CHANNEL_IDS);
}

/**
 * Which channel a chatKey belongs to.
 *
 * A Direct Conversation isolation key (`bot:<conversationId>:<topicId>`) does not
 * start with a channel id — `bot` is the product kind, not a channel. It resolves
 * to the relay channel, because a Direct Bot turn is reached through the relay
 * connector and its card-callback channel.
 *
 * The relay id is handled here as a PREFIX RULE rather than an entry in
 * `KNOWN_CHANNEL_IDS`: that set reports which channels are built in before
 * plugins load, and pre-registering relay there would claim the channel exists
 * without its plugin. The rule only affects routing, not the built-in report.
 *
 * Falling through to "weixin" would be a silent misroute: the request would reach
 * a channel that cannot render the interaction, and the broker would cancel with
 * "channel cannot render form elicitation" — a fail-closed result, but one that
 * looks like an unsupported channel rather than a routing bug.
 */
export function getChannelIdFromChatKey(chatKey: string): string {
  if (chatKey.startsWith("bot:")) return "relay";
  const first = chatKey.split(":", 1)[0];
  return first && KNOWN_CHANNEL_IDS.has(first) ? first : "weixin";
}

export function isLegacyWeixinChatKey(chatKey: string): boolean {
  return getChannelIdFromChatKey(chatKey) === "weixin" && !chatKey.startsWith("weixin:");
}

export function toInternalSessionAlias(channelId: string, displayAlias: string): string {
  const normalized = displayAlias.trim();
  if (normalized.length === 0) {
    throw new Error("display session alias must be non-empty");
  }
  if (normalized.startsWith(`${channelId}:`)) {
    return normalized;
  }
  return `${channelId}:${normalized}`;
}

export function toDisplaySessionAlias(internalAlias: string): string {
  const [first, ...rest] = internalAlias.split(":");
  if (first && KNOWN_CHANNEL_IDS.has(first) && rest.length > 0) {
    return rest.join(":");
  }
  return internalAlias;
}

export function isSessionAliasVisibleInChannel(alias: string, channelId: string): boolean {
  const [first] = alias.split(":", 1);
  if (first && KNOWN_CHANNEL_IDS.has(first)) {
    return first === channelId;
  }
  return channelId === "weixin";
}

export function resolveSessionAliasForInput(
  channelId: string,
  displayAlias: string,
  existingAliases: Iterable<string>,
): string {
  const normalized = displayAlias.trim();
  if (normalized.length === 0) {
    throw new Error("display session alias must be non-empty");
  }
  if (normalized.startsWith(`${channelId}:`)) {
    return normalized;
  }
  const scopedAlias = toInternalSessionAlias(channelId, normalized);
  for (const alias of existingAliases) {
    if (alias === scopedAlias) return scopedAlias;
  }
  // A Direct Conversation product alias is stored UNscoped, so the channel-
  // scoped form can never match and the fallback below must look for the bare
  // alias instead of returning a key no record has.
  //
  // This is not a convenience for one caller: the alias is how a Conversation
  // binding addresses its session, and the chatKey of that turn maps to the
  // relay channel. Scoping it produces `relay:brt_…`, and every prompt on the
  // turn then fails with `session "brt_…" does not exist` — the bot turn can
  // never run, so the elicitation path behind it is unreachable.
  if (isProductOwnedSessionAlias(normalized)) {
    for (const alias of existingAliases) {
      if (alias === normalized) return alias;
    }
    // No record yet: the bare alias is still the right key, because that is
    // where the record will be created.
    return normalized;
  }
  if (channelId === "weixin") {
    for (const alias of existingAliases) {
      if (alias === normalized) return alias;
    }
  }
  return scopedAlias;
}

/**
 * Internal alias for a display alias entered in `channelId`. The default
 * channel (weixin) stays unprefixed for backwards compatibility; every other
 * channel is namespaced as `channelId:alias`. Idempotent — an already-scoped
 * alias is not double-prefixed. This is the single home for the rule that
 * handlers must not re-implement inline.
 */
export function scopeDisplayAliasToInternal(channelId: string, displayAlias: string): string {
  const normalized = displayAlias.trim();
  if (normalized.length === 0) {
    throw new Error("display session alias must be non-empty");
  }
  if (channelId === "weixin") return normalized;
  // A Direct Conversation product alias (`brt_<bindingId>`) is ALREADY the internal
  // alias and must never be re-prefixed.
  //
  // It is not a channel-scoped display alias: the product mints it unscoped
  // (`ownedDirectSessionAlias`), and the session record is stored under exactly
  // that key. Scoping it with the chatKey's channel id — which for a Direct Bot
  // turn is `relay` — produces `relay:brt_…`, a key that no record ever had, so
  // every prompt on that turn fails with `session "brt_…" does not exist`.
  //
  // This is not a naming coincidence to be tidied later: the alias is a durable
  // join key between a Conversation binding and its session, and the product's
  // own naming is the only one that matches the stored record.
  if (isProductOwnedSessionAlias(normalized)) return normalized;
  return toInternalSessionAlias(channelId, normalized);
}

export function buildDefaultTransportSession(channelId: string, displayAlias: string): string {
  const normalized = displayAlias.trim();
  if (normalized.length === 0) {
    throw new Error("display session alias must be non-empty");
  }
  return channelId === "weixin" ? normalized : toInternalSessionAlias(channelId, normalized);
}
