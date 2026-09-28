import type {
  DeliveryTarget,
  DiscordButtonInteraction,
  DiscordInboundMessage,
  DiscordModalSubmitInteraction,
  DiscordSelectInteraction,
  OutboundBody,
  ShowModalInput,
} from "./types.js";

export interface DiscordBotIdentity {
  botUserId: string;
  botTag?: string;
}

export interface DiscordClientLike {
  /** Connect and log in. Resolves with the authenticated bot identity once the
   *  Gateway session is established; rejects when login fails (bad token,
   *  disallowed intents, connect error) so the channel can record the account
   *  startup failure instead of running headless. Button interactions are
   *  delivered to `onButton` when provided; slash commands continue to arrive
   *  as synthetic messages via `onMessage` so existing gates still apply.
   *  would silently disable them. */
  start(input: { handlers: { onMessage(m: DiscordInboundMessage): void; onSelect?(i: DiscordSelectInteraction): void; onButton?(i: DiscordButtonInteraction): void; onModalSubmit?(i: DiscordModalSubmitInteraction): void }; abortSignal: AbortSignal }): Promise<DiscordBotIdentity>;
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
  /**
   * Test seam: build the discord.js Client that `start()` attaches to. Omitting
   * it constructs the real one. The adapter dispatch under test lives in
   * `start()`, so an injected gateway is the only way to feed it a real-shaped
   * interaction without a live Gateway connection.
   */
  createGateway?: () => unknown;
}

export function createDiscordClient(options: CreateDiscordClientOptions): DiscordClientLike {
  return new DiscordJsClient(options);
}

/**
 * Exported for adapter-level tests that drive the interactionCreate dispatch
 * directly. Production code goes through `createDiscordClient`.
 */
export { DiscordJsClient };

class DiscordJsClient implements DiscordClientLike {
  private client: unknown = null;
  private readonly options: CreateDiscordClientOptions;
  private readonly typingIntervals: Set<ReturnType<typeof setInterval>> = new Set();
  private abortCleanup: (() => void) | null = null;

  constructor(options: CreateDiscordClientOptions) {
    this.options = options;
  }

  async start(input: { handlers: { onMessage(m: DiscordInboundMessage): void; onSelect?(i: DiscordSelectInteraction): void; onButton?(i: DiscordButtonInteraction): void; onModalSubmit?(i: DiscordModalSubmitInteraction): void }; abortSignal: AbortSignal }): Promise<DiscordBotIdentity> {
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

    const client = (this.options.createGateway
      ? this.options.createGateway()
      : new Client({
          intents,
          partials: [Partials.Channel, Partials.Message],
          allowedMentions: { parse: [] },
        })) as {
      on: (event: string, cb: (...args: unknown[]) => void) => void;
      once: (event: string, cb: (...args: unknown[]) => void) => void;
      login: (token: string) => Promise<string>;
      destroy: () => void;
      user: { id: string; tag: string } | null;
      channels: { fetch: (id: string) => Promise<unknown> };
      isReady: () => boolean;
    };
    this.client = client;

    client.on("messageCreate", (message: unknown) => {
      const inbound = mapDiscordMessage(message, ChannelType);
      if (inbound) input.handlers.onMessage(inbound);
    });

    client.on("interactionCreate", (interaction: unknown) => {
      const anyI = interaction as {
        isButton?: () => boolean;
        isChatInputCommand?: () => boolean;
        isStringSelectMenu?: () => boolean;
        isModalSubmit?: () => boolean;
        commandName?: string;
        customId?: string;
        values?: string[];
        fields?: {
          /**
           * discord.js exposes submitted modal inputs as a
           * `Collection<customId, component>`, which structurally is a
           * `Map`-like with `get`. The components this renderer OPENED the modal
           * with are Discordin's Label type (18) whose real input sits at
           * `component`, so a traversal of `components[].components[]` — the old
           * shape — finds nothing and drops every answer.
           */
          fields?: Map<string, { customId?: string; value?: string }> | Record<string, { customId?: string; value?: string }>;
          getTextInputValue?: (customId: string) => string;
        };
        options?: { data?: Array<{ name?: string; value?: unknown }> };
        channelId?: string;
        channel?: { id?: string };
        guildId?: string | null;
        user?: { id?: string };
        member?: { user?: { id?: string }; roles?: { cache?: Map<string, unknown> } };
        id?: string;
        replied?: boolean;
        deferred?: boolean;
        reply?: (opts: unknown) => Promise<void>;
        showModal?: (modal: unknown) => Promise<void>;
        deferUpdate?: () => Promise<void>;
      };
      if (typeof anyI?.isButton === "function" && anyI.isButton()) {
        const customId = typeof anyI.customId === "string" ? anyI.customId : "";
        // Both interaction namespaces are delivered; the channel routes on
        // prefix. Filtering to one here would silently drop the other family.
        if (!customId || (!customId.startsWith("xacpx-perm:") && !customId.startsWith("xacpx-elicit:"))) return;
        const ack = async (): Promise<void> => {
          try {
            if (!anyI.replied && !anyI.deferred && anyI.deferUpdate) await anyI.deferUpdate();
          } catch {}
        };
        const replyEphemeral = async (text: string): Promise<void> => {
          try {
            if (anyI.reply && !anyI.replied && !anyI.deferred) {
              await anyI.reply({ content: text, ephemeral: true, allowedMentions: { parse: [] } });
            }
          } catch {}
        };
        // A modal may only be shown inside an interaction response, so it is
        // exposed on the interaction itself. Discord shows it to the user who
        // acted; there is no recipient argument to get wrong.
        const showModal = async (modal: ShowModalInput): Promise<void> => {
          if (typeof anyI.showModal !== "function") {
            throw new Error("discord interaction cannot show a modal");
          }
          await anyI.showModal({
            title: modal.title,
            custom_id: modal.customId,
            components: modal.components.map((label) => ({
              type: 18,
              label: label.label,
              component: {
                type: 4,
                custom_id: label.component.customId,
                style: label.component.style,
                label: label.component.label,
                ...(label.component.minLength !== undefined ? { min_length: label.component.minLength } : {}),
                ...(label.component.maxLength !== undefined ? { max_length: label.component.maxLength } : {}),
                required: label.component.required ?? false,
                ...(label.component.value !== undefined ? { value: label.component.value } : {}),
                ...(label.component.placeholder !== undefined ? { placeholder: label.component.placeholder } : {}),
              },
            })),
          });
        };
        const channelId = anyI.channelId ?? anyI.channel?.id;
        const userId = anyI.user?.id ?? anyI.member?.user?.id;
        if (!channelId || !userId) return;
        const normalized: DiscordButtonInteraction = {
          customId,
          userId,
          channelId,
          ...(anyI.guildId ? { guildId: anyI.guildId } : {}),
          acknowledge: ack,
          replyEphemeral,
          showModal,
        };
        input.handlers.onButton?.(normalized);
        return;
      }
      // String Select: option VALUES, not labels. An option's label is
      // agent-controlled display text and may be truncated; the value is the
      // correlation identity core validates.
      if (typeof anyI?.isStringSelectMenu === "function" && anyI.isStringSelectMenu()) {
        const customId = typeof anyI.customId === "string" ? anyI.customId : "";
        if (!customId || !customId.startsWith("xacpx-elicit:")) return;
        const channelId = anyI.channelId ?? anyI.channel?.id;
        const userId = anyI.user?.id ?? anyI.member?.user?.id;
        if (!channelId || !userId) return;
        const values = Array.isArray(anyI.values) ? anyI.values.map((v) => String(v)) : [];
        const normalized: DiscordSelectInteraction = {
          customId,
          userId,
          channelId,
          ...(anyI.guildId ? { guildId: anyI.guildId } : {}),
          values,
          acknowledge: async () => {
            try {
              if (!anyI.replied && !anyI.deferred && anyI.deferUpdate) await anyI.deferUpdate();
            } catch {}
          },
          replyEphemeral: async (text: string) => {
            try {
              if (anyI.reply && !anyI.replied && !anyI.deferred) {
                await anyI.reply({ content: text, ephemeral: true, allowedMentions: { parse: [] } });
              }
            } catch {}
          },
        };
        input.handlers.onSelect?.(normalized);
        return;
      }
      // Modal submit: the field map is keyed by the Text Input custom_id, which
      // is POSITIONAL (`f:<index>`) rather than the schema key, so a legal long
      // key cannot exceed Discord's component id cap. Values live in the
      // payload, never in any id.
      if (typeof anyI?.isModalSubmit === "function" && anyI.isModalSubmit()) {
        const customId = typeof anyI.customId === "string" ? anyI.customId : "";
        if (!customId || !customId.startsWith("xacpx-elicit:")) return;
        const channelId = anyI.channelId ?? anyI.channel?.id;
        const userId = anyI.user?.id ?? anyI.member?.user?.id;
        if (!channelId || !userId) return;
        // discord.js delivers modal fields as a `Collection<customId, field>`
        // with `getTextInputValue(customId)`. The component tree we OPEN the
        // modal with is the Label type (18) whose child sits at
        // `component`, not `row.components` — so the old double loop found
        // nothing and every real modal submit arrived with an empty map,
        // silently discarding the user's answer.
        const fields: Record<string, string> = {};
        const submitted = anyI.fields;
        if (submitted && typeof submitted.fields === "object") {
          const entries = submitted.fields instanceof Map
            ? [...submitted.fields.entries()]
            : Object.entries(submitted.fields);
          for (const [key, component] of entries) {
            const value = typeof component?.value === "string"
              ? component.value
              : typeof submitted.getTextInputValue === "function"
                ? submitted.getTextInputValue(key)
                : undefined;
            if (typeof value === "string") fields[key] = value;
          }
        }
        const normalized: DiscordModalSubmitInteraction = {
          customId,
          userId,
          channelId,
          ...(anyI.guildId ? { guildId: anyI.guildId } : {}),
          fields,
          acknowledge: async () => {
            try {
              if (anyI.reply && !anyI.replied && !anyI.deferred) {
                await anyI.reply({ content: "OK", ephemeral: true, allowedMentions: { parse: [] } });
              }
            } catch {}
          },
          replyEphemeral: async (text: string) => {
            try {
              if (anyI.reply && !anyI.replied && !anyI.deferred) {
                await anyI.reply({ content: text, ephemeral: true, allowedMentions: { parse: [] } });
              }
            } catch {}
          },
        };
        input.handlers.onModalSubmit?.(normalized);
        return;
      }
      if (!anyI?.isChatInputCommand?.() || !anyI.commandName) return;
      const channelId = anyI.channelId ?? anyI.channel?.id;
      if (!channelId) return;
      const getOpt = (name: string): unknown => anyI.options?.data?.find((o) => o.name === name)?.value;
      let text: string;
      const cmd = anyI.commandName;
      if (cmd === "ss") {
        const agent = String(getOpt("agent") ?? "").trim();
        const workspace = String(getOpt("workspace") ?? "").trim();
        const isNew = Boolean(getOpt("new"));
        if (!agent) {
          text = "/ss";
        } else {
          text = isNew ? `/ss new ${agent}` : `/ss ${agent}`;
          if (workspace) text += ` --ws ${workspace}`;
        }
      } else if (cmd === "use") {
        const alias = String(getOpt("alias") ?? "").trim();
        text = alias ? `/use ${alias}` : "/use";
      } else if (cmd === "cancel") {
        const alias = String(getOpt("alias") ?? "").trim();
        text = alias ? `/cancel ${alias}` : "/cancel";
      } else {
        const rawValues = anyI.options?.data?.map((o) => String(o.value ?? "")).filter((s) => s.length > 0) ?? [];
        text = `/${cmd}${rawValues.length > 0 ? ` ${rawValues.join(" ")}` : ""}`.trim();
      }
      const botUserId = (client as unknown as { user?: { id?: string } | null })?.user?.id ?? "";
      const synthetic: DiscordInboundMessage = {
        id: anyI.id ?? `interaction-${Date.now()}`,
        channelId,
        guildId: anyI.guildId ?? null,
        author: { id: anyI.user?.id ?? anyI.member?.user?.id ?? "unknown", bot: false },
        content: botUserId ? `<@${botUserId}> ${text}` : text,
        cleanContent: text,
        createdTimestamp: Date.now(),
        mentions: botUserId ? { users: [{ id: botUserId }] } : { users: [] },
        attachments: [],
        senderRoleIds: anyI.member?.roles?.cache ? [...anyI.member.roles.cache.keys()] : undefined,
      };
      void (async () => {
        try {
          if (!anyI.replied && !anyI.deferred && anyI.reply) {
            await anyI.reply({ content: `⏳ Processing \`${text}\` …`, ephemeral: true, allowedMentions: { parse: [] } });
          }
        } catch {
          // ignore interaction ack failures
        }
        input.handlers.onMessage(synthetic);
      })();
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
      ...(body.components ? { components: body.components } : {}),
      // Selects may not share an action row with buttons, so they travel as
      // their own rows appended after the button rows.
      ...(body.selectRows ? { components: [...(body.components ?? []), ...body.selectRows] } : {}),
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
      ...(body.components ? { components: body.components } : {}),
      ...(body.selectRows
        ? { components: [...(body.components ?? []), ...body.selectRows] }
        : {}),
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
