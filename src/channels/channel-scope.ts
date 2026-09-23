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
  return channelId === "weixin" ? normalized : toInternalSessionAlias(channelId, normalized);
}

export function buildDefaultTransportSession(channelId: string, displayAlias: string): string {
  const normalized = displayAlias.trim();
  if (normalized.length === 0) {
    throw new Error("display session alias must be non-empty");
  }
  return channelId === "weixin" ? normalized : toInternalSessionAlias(channelId, normalized);
}
