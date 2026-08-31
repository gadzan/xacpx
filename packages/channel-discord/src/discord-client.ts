import type { DeliveryTarget, DiscordInboundMessage, OutboundBody } from "./types.js";

export interface DiscordBotIdentity {
  botUserId: string;
  botTag?: string;
}

export interface DiscordClientLike {
  /** Connect and log in. Resolves with the authenticated bot identity once the
   *  Gateway session is established; rejects when login fails (bad token,
   *  disallowed intents, connect error) or when the session came up without a
   *  bot user id. The long-lived connection stays open afterwards and is torn
   *  down via the abortSignal passed to start() or via destroy().
   *  Identity MUST come from this call: the self-message guard, the mention
   *  gate and the reply-to-bot check all key off botUserId, so an empty id
   *  would silently disable them. */
  start(input: { handlers: { onMessage(m: DiscordInboundMessage): void }; abortSignal: AbortSignal }): Promise<DiscordBotIdentity>;
  /** Diagnostic-only REST probe. Never used to derive startup identity. */
  probeBot(): Promise<DiscordBotIdentity>;
  sendMessage(target: DeliveryTarget, body: OutboundBody): Promise<{ messageId: string }>;
  editMessage(target: DeliveryTarget, messageId: string, body: OutboundBody): Promise<void>;
  deleteMessage(target: DeliveryTarget, messageId: string): Promise<void>;
  startTyping(channelId: string): Promise<() => void>;
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  destroy(): Promise<void>;
}

export interface CreateDiscordClientOptions {
  token: string;
  applicationId?: string;
  intentsMessageContent: boolean;
  intentsGuildMembers: boolean;
}

export function createDiscordClient(options: CreateDiscordClientOptions): DiscordClientLike {
  return new DiscordJsClient(options);
}

class DiscordJsClient implements DiscordClientLike {
  private client: unknown = null;
  private readonly options: CreateDiscordClientOptions;
  private readonly typingIntervals: Set<ReturnType<typeof setInterval>> = new Set();
  private abortCleanup: (() => void) | null = null;

  constructor(options: CreateDiscordClientOptions) {
    this.options = options;
  }

  async start(input: { handlers: { onMessage(m: DiscordInboundMessage): void }; abortSignal: AbortSignal }): Promise<DiscordBotIdentity> {
    const discord = await import("discord.js") as unknown as Record<string, unknown>;
    const Client = discord.Client as new (opts: unknown) => {
      on: (event: string, cb: (...args: unknown[]) => void) => void;
      once: (event: string, cb: (...args: unknown[]) => void) => void;
      login: (token: string) => Promise<string>;
      destroy: () => void;
      user: { id: string; tag: string } | null;
      channels: { fetch: (id: string) => Promise<unknown> };
      isReady: () => boolean;
    };
    const GatewayIntentBits = discord.GatewayIntentBits as Record<string, number>;
    const Partials = discord.Partials as Record<string, number>;
    const ChannelType = discord.ChannelType as Record<string, number>;

    let intents = 0;
    intents |= (GatewayIntentBits.Guilds ?? 0);
    intents |= (GatewayIntentBits.GuildMessages ?? 0);
    intents |= (GatewayIntentBits.DirectMessages ?? 0);
    intents |= (GatewayIntentBits.GuildMessageReactions ?? 0);
    intents |= (GatewayIntentBits.DirectMessageReactions ?? 0);
    if (this.options.intentsMessageContent) intents |= (GatewayIntentBits.MessageContent ?? 0);
    if (this.options.intentsGuildMembers) intents |= (GatewayIntentBits.GuildMembers ?? 0);

    const client = new Client({
      intents,
      partials: [Partials.Channel, Partials.Message],
      allowedMentions: { parse: [] },
    });
    this.client = client;

    client.on("messageCreate", (message: unknown) => {
      const inbound = mapDiscordMessage(message, ChannelType);
      if (inbound) input.handlers.onMessage(inbound);
    });

    if (input.abortSignal.aborted) {
      client.destroy();
      this.client = null;
      throw new Error("Discord client start aborted");
    }

    // Tear down the long-running Gateway session on abort. The listener stays
    // registered after start() resolves; destroy() removes it.
    const abortHandler = (): void => {
      client.destroy();
    };
    input.abortSignal.addEventListener("abort", abortHandler, { once: true });
    this.abortCleanup = () => input.abortSignal.removeEventListener("abort", abortHandler);

    // Resolve once the initial Gateway login reaches ready; propagate login
    // failures (bad token, disallowed intents, connect error) so the channel
    // can record the account startup failure (review #3).
    try {
      await client.login(this.options.token);
    } catch (error) {
      this.abortCleanup?.();
      this.abortCleanup = null;
      try {
        client.destroy();
      } catch {
        // ignore
      }
      throw error;
    }

    // The READY payload carries the authenticated application user. Fail
    // closed when it is missing: an empty botUserId would silently disable
    // the self-message guard and the mention / reply-to-bot gates, which is
    // how a self-loop reaches the agent.
    const user = client.user;
    if (!user?.id) {
      this.abortCleanup?.();
      this.abortCleanup = null;
      try {
        client.destroy();
      } catch {
        // ignore
      }
      throw new Error("Discord Gateway became ready without bot identity");
    }
    return { botUserId: user.id, ...(user.tag ? { botTag: user.tag } : {}) };
  }

  async probeBot(): Promise<{ botUserId: string; botTag?: string }> {
    const c = this.client as { user?: { id: string; tag: string } | null } | null;
    if (c?.user) return { botUserId: c.user.id, botTag: c.user.tag };
    try {
      const discord = await import("discord.js") as unknown as Record<string, unknown>;
      const REST = discord.REST as new (opts: unknown) => { setToken: (t: string) => unknown; get: (path: string) => Promise<unknown> };
      const rest = new REST({ version: "10" }).setToken(this.options.token) as { get: (path: string) => Promise<unknown> };
      const me = (await rest.get("/users/@me")) as { id: string; username?: string; discriminator?: string };
      const tag = me.username ? `${me.username}${me.discriminator && me.discriminator !== "0" ? `#${me.discriminator}` : ""}` : undefined;
      return { botUserId: me.id, ...(tag ? { botTag: tag } : {}) };
    } catch {
      return { botUserId: "" };
    }
  }

  async sendMessage(target: DeliveryTarget, body: OutboundBody): Promise<{ messageId: string }> {
    const client = this.client as {
      channels: { fetch: (id: string) => Promise<{ send: (opts: unknown) => Promise<{ id: string }> }> };
    } | null;
    if (!client) throw new Error("Discord client not started");
    const channel = await client.channels.fetch(target.channelId);
    const payload: Record<string, unknown> = {
      content: body.content ?? undefined,
      allowedMentions: body.allowedMentions ?? { parse: [] },
    };
    if (body.files && body.files.length > 0) {
      payload.files = body.files.map((f) => ({
        attachment: f.attachment,
        name: f.name,
        description: f.description,
      }));
    }
    const sent = await (channel as { send: (opts: unknown) => Promise<{ id: string }> }).send(payload);
    return { messageId: sent.id };
  }

  async editMessage(target: DeliveryTarget, messageId: string, body: OutboundBody): Promise<void> {
    const client = this.client as {
      channels: { fetch: (id: string) => Promise<{ messages: { fetch: (id: string) => Promise<{ edit: (opts: unknown) => Promise<unknown> }> } }> };
    } | null;
    if (!client) throw new Error("Discord client not started");
    const channel = await client.channels.fetch(target.channelId);
    const msg = await (channel as { messages: { fetch: (id: string) => Promise<{ edit: (opts: unknown) => Promise<unknown> }> } }).messages.fetch(messageId);
    await msg.edit({
      content: body.content ?? undefined,
      allowedMentions: body.allowedMentions ?? { parse: [] },
    });
  }

  async deleteMessage(target: DeliveryTarget, messageId: string): Promise<void> {
    const client = this.client as {
      channels: { fetch: (id: string) => Promise<{ messages: { fetch: (id: string) => Promise<{ delete: () => Promise<void> }> } }> };
    } | null;
    if (!client) throw new Error("Discord client not started");
    const channel = await client.channels.fetch(target.channelId);
    const msg = await (channel as { messages: { fetch: (id: string) => Promise<{ delete: () => Promise<void> }> } }).messages.fetch(messageId);
    await msg.delete();
  }

  async startTyping(channelId: string): Promise<() => void> {
    const client = this.client as {
      channels: { fetch: (id: string) => Promise<{ sendTyping: () => Promise<void> }> };
    } | null;
    if (!client) return () => {};
    try {
      const channel = await client.channels.fetch(channelId);
      await (channel as { sendTyping: () => Promise<void> }).sendTyping();
    } catch {
      return () => {};
    }
    const interval = setInterval(() => {
      void (async (): Promise<void> => {
        try {
          const ch = await client.channels.fetch(channelId);
          await (ch as { sendTyping: () => Promise<void> }).sendTyping();
        } catch {
          // ignore
        }
      })();
    }, 8000);
    this.typingIntervals.add(interval);
    return () => {
      clearInterval(interval);
      this.typingIntervals.delete(interval);
    };
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const client = this.client as {
      channels: { fetch: (id: string) => Promise<{ messages: { fetch: (id: string) => Promise<{ react: (emoji: string) => Promise<void> }> } }> };
    } | null;
    if (!client) return;
    try {
      const channel = await client.channels.fetch(channelId);
      const msg = await (channel as { messages: { fetch: (id: string) => Promise<{ react: (emoji: string) => Promise<void> }> } }).messages.fetch(messageId);
      await msg.react(emoji);
    } catch {
      // best effort
    }
  }

  async destroy(): Promise<void> {
    try {
      this.abortCleanup?.();
    } catch {
      // ignore
    }
    this.abortCleanup = null;
    const c = this.client as { destroy?: () => void } | null;
    try {
      c?.destroy?.();
    } catch {
      // ignore
    }
    this.client = null;
    for (const id of this.typingIntervals) clearInterval(id);
    this.typingIntervals.clear();
  }
}

function mapDiscordMessage(
  message: unknown,
  ChannelType: Record<string, number>,
): DiscordInboundMessage | null {
  const m = message as {
    id: string;
    channelId: string;
    guildId?: string | null;
    author?: { id: string; bot?: boolean };
    content?: string;
    cleanContent?: string;
    createdTimestamp?: number;
    mentions?: { users?: Map<string, unknown> | unknown[]; everyone?: boolean; repliedUser?: { id: string } | null };
    member?: { roles?: { cache?: Map<string, { id: string }> | unknown[] } & string[]; } | null;
    attachments?: Map<string, { url: string; name?: string; contentType?: string | null; size?: number }> | Array<{ url: string; name?: string; contentType?: string | null; size?: number }>;
    channel?: { type?: number; parentId?: string | null; isThread?: () => boolean };
    reference?: { messageId?: string | null };
  };
  if (!m?.id || !m.channelId || !m.author) return null;

  const attachments: DiscordInboundMessage["attachments"] = [];
  if (m.attachments) {
    const iter = m.attachments instanceof Map ? m.attachments.values() : m.attachments;
    for (const att of iter as Iterable<{ url: string; name?: string; contentType?: string | null; size?: number }>) {
      if (att?.url) attachments.push({ id: "", url: att.url, name: att.name, contentType: att.contentType ?? null, size: att.size });
    }
  }

  let isThread = false;
  let parentChannelId: string | null | undefined;
  if (m.channel) {
    const t = m.channel.type;
    if (t === ChannelType.PublicThread || t === ChannelType.PrivateThread || t === ChannelType.AnnouncementThread) {
      isThread = true;
      parentChannelId = m.channel.parentId ?? undefined;
    } else if (typeof m.channel.isThread === "function") {
      try {
        isThread = m.channel.isThread();
        if (isThread) parentChannelId = m.channel.parentId ?? undefined;
      } catch {
        // ignore
      }
    }
  }

  // Extract sender role ids (guild member roles)
  let senderRoleIds: string[] | undefined;
  const memberRoles = (m as { member?: unknown }).member as { roles?: unknown } | null | undefined;
  if (memberRoles?.roles) {
    const roles = memberRoles.roles as { cache?: Map<string, unknown> & { keys?: () => Iterable<string> } } & string[];
    if (roles.cache && typeof (roles.cache as Map<string, unknown>).keys === "function") {
      try {
        const keys = Array.from((roles.cache as Map<string, { id: string }>).keys());
        if (keys.length > 0) senderRoleIds = keys;
        else {
          // cache may hold objects keyed by id, try values
          const vals = Array.from((roles.cache as Map<string, { id: string }>).values()) as Array<{ id: string }>;
          const ids = vals.map((v) => v.id).filter(Boolean);
          if (ids.length > 0) senderRoleIds = ids;
        }
      } catch {
        // ignore
      }
    } else if (Array.isArray(roles)) {
      const ids = (roles as unknown[]).filter((r) => typeof r === "string") as string[];
      if (ids.length > 0) senderRoleIds = ids;
      else {
        const objIds = (roles as Array<{ id?: string }>).map((r) => r.id).filter((x): x is string => typeof x === "string");
        if (objIds.length > 0) senderRoleIds = objIds;
      }
    }
  }

  // Extract replied user (for precise reply-to-bot check, S9)
  let repliedUserId: string | null | undefined;
  const repliedUser = (m.mentions as { repliedUser?: { id: string } | null } | undefined)?.repliedUser;
  if (repliedUser?.id) repliedUserId = repliedUser.id;

  return {
    id: m.id,
    channelId: m.channelId,
    guildId: m.guildId ?? null,
    author: { id: m.author.id, bot: m.author.bot },
    content: m.content ?? "",
    cleanContent: m.cleanContent,
    createdTimestamp: m.createdTimestamp ?? Date.now(),
    mentions: m.mentions
      ? {
          users: m.mentions.users
            ? Array.from(m.mentions.users instanceof Map ? m.mentions.users.values() : (m.mentions.users as unknown[])).map((u) => {
                const uu = u as { id: string };
                return { id: uu.id };
              })
            : undefined,
          everyone: m.mentions.everyone,
          repliedUser: repliedUserId ? { id: repliedUserId } : null,
        }
      : undefined,
    ...(senderRoleIds ? { senderRoleIds } : {}),
    attachments: attachments.length > 0 ? attachments : undefined,
    isThread,
    parentChannelId: parentChannelId ?? null,
    referencedMessageId: m.reference?.messageId ?? null,
    repliedUserId: repliedUserId ?? null,
    raw: message,
  };
}
