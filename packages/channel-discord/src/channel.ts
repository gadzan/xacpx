import path from "node:path";
import { ActiveConsumerLockError, coreHomeDir, createConversationExecutor, resolveTurnLane, toDisplaySessionAlias } from "xacpx/plugin-api";
import type {
  ChannelStartInput,
  ConversationExecutor,
  CoordinatorMessageInput,
  CreateChannelDeps,
  ScheduledChannelMessageInput,
  MessageChannelRuntime,
  OrchestrationDeliveryCallbacks,
  ConsumerLock,
  ConsumerLockOptions,
  ConsumerLockMetadata,
  ToolUseEvent,
} from "xacpx/plugin-api";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type { DiscordChannelConfig, DiscordResolvedAccountConfig } from "./config.js";
import { parseDiscordChannelConfig } from "./config.js";
import type { DeliveryTarget, DiscordInboundMessage, DiscordRoute, OutboundBody } from "./types.js";
import type { DiscordBotIdentity, DiscordClientLike } from "./discord-client.js";
import { createDiscordClient } from "./discord-client.js";
import { MessageDedup, isMessageExpired } from "./message-dedup.js";
import {
  buildDiscordChatKey,
  buildDiscordQueueKey,
  buildDiscordRoute,
  evaluateDiscordAccessPolicy,
  isDiscordReplyToBot,
  parseDiscordChatKey,
  resolveChannelRequireMention,
  shouldHandleDiscordMessage,
  cleanDiscordMention,
} from "./inbound.js";
import { isLikelyAbortText } from "./abort-detect.js";
import { t as getMessages, setChannelLocale } from "./i18n/index.js";
import { RuntimeMediaStore, DEFAULT_IMAGE_MAX_BYTES, DEFAULT_ATTACHMENT_MAX_BYTES, DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE } from "./media-store.js";
import { resolveSafeOutboundMediaPath } from "./outbound-media-safety.js";
import { normalizeMediaArray, type ChannelMediaAttachment } from "./media-types.js";
import { downloadDiscordAttachment, extractDiscordAttachments, inferMediaKind } from "./media.js";
import { chunkDiscordText } from "./chunk.js";
import { renderDiscordMarkdown } from "./markdown.js";
import { createDiscordPreviewStream, type DiscordPreviewStream } from "./preview-stream.js";
import { sendWithThreadFallback } from "./outbound.js";
import { buildXacpxSlashCommands, registerDiscordCommands } from "./discord-commands.js";
type OrchestrationTaskRecord = Parameters<MessageChannelRuntime["notifyTaskCompletion"]>[0];

const ACCOUNT_IDENTIFY_STAGGER_MS = 5500;

interface DiscordChannelDeps extends CreateChannelDeps {
  createClient?: (account: DiscordResolvedAccountConfig) => DiscordClientLike;
  fetchImpl?: typeof fetch;
  /** Override the inter-account identify stagger (test hook). */
  identifyStaggerMs?: number;
}

interface AccountRuntime {
  account: DiscordResolvedAccountConfig;
  client: DiscordClientLike;
  botUserId: string;
  botTag?: string;
}

interface ActiveTask {
  accountId: string;
  channelId: string;
  guildId?: string;
  /**
   * Parent channel of a thread turn, taken from the inbound message. The
   * archived-thread fallback uses this instead of a REST lookup, so the parent
   * of a dead thread is known without asking Discord about it.
   */
  parentChannelId: string | null;
  messageId: string;
  senderId?: string;
  chatKind?: string;
  queueKey: string;
  boundAlias?: string;
  abortController: AbortController;
  /** Releases this turn's listener on the channel-level abort signal. Cleared in
   *  runTurn's finally so a long-lived daemon does not accumulate one listener
   *  per handled message. */
  rootAbortCleanup: (() => void) | null;
  suppressed: boolean;
  previewStream: DiscordPreviewStream | null;
  stopTyping: (() => void) | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultMimeForKind(kind: "image" | "file" | "audio" | "video"): string {
  if (kind === "image") return "image/png";
  if (kind === "audio") return "audio/ogg";
  if (kind === "video") return "video/mp4";
  return "application/octet-stream";
}

function appendSkippedAttachmentNotes(text: string, notes: string[]): string {
  if (notes.length === 0) return text;
  const suffix = notes.map((n) => `[${n}]`).join("\n");
  return text ? `${text}\n${suffix}` : suffix;
}

function resolveEffectiveReplyMode(
  configured: "static" | "streaming" | "auto",
): "static" | "streaming" {
  if (configured === "auto") return "streaming";
  return configured;
}

function formatScheduledFailureText(input: ScheduledChannelMessageInput, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return input.taskId
    ? getMessages().scheduledFailureWithId(input.taskId, message)
    : getMessages().scheduledFailure(message);
}

function buildDiscordCompletionNotice(displayAlias: string, status: "done" | "error"): string {
  return status === "done" ? getMessages().completionDone(displayAlias) : getMessages().completionError(displayAlias);
}

function parseChatKeyToTarget(chatKey: string): DeliveryTarget | null {
  const parsed = parseDiscordChatKey(chatKey);
  if (!parsed) return null;
  return { channelId: parsed.channelId, ...(parsed.guildId ? { guildId: parsed.guildId } : {}) };
}

export class DiscordChannel implements MessageChannelRuntime {
  readonly id = "discord";
  readonly nativeSessionListFormat: "cards" | "table" = "cards";

  private readonly accounts: Map<string, AccountRuntime> = new Map();
  private dedup: MessageDedup;
  private markDelivered: OrchestrationDeliveryCallbacks["markTaskNoticeDelivered"] | null = null;
  private markFailed: OrchestrationDeliveryCallbacks["markTaskNoticeFailed"] | null = null;
  private agent: ChannelStartInput["agent"] | null = null;
  private quota: ChannelStartInput["quota"] | null = null;
  private logger: ChannelStartInput["logger"] | null = null;
  private sessions: ChannelStartInput["sessions"] | null = null;
  private activeTurns: ChannelStartInput["activeTurns"] | null = null;
  private abortSignal: AbortSignal | null = null;
  private readonly executor: ConversationExecutor = createConversationExecutor();
  private readonly activeTasks: Map<string, ActiveTask[]> = new Map();
  private readonly config: DiscordChannelConfig;
  private readonly deps: DiscordChannelDeps;

  constructor(
    options: Record<string, unknown> | undefined,
    deps: DiscordChannelDeps = {},
  ) {
    this.config = parseDiscordChannelConfig(options);
    this.deps = deps;
    // Dedup defaults come from config top-level (first account's values are used for sizing;
    // per-account dedup is not needed — dedup is scoped by accountId anyway via tryRecord).
    this.dedup = new MessageDedup({ ttlMs: this.config.dedupTtlMs, maxEntries: this.config.dedupMaxEntries });
  }

  isLoggedIn(): boolean {
    return this.config.accounts.some((account) => account.enabled && account.configured);
  }

  async login(): Promise<string> {
    if (this.isLoggedIn()) return "discord credentials configured";
    throw new Error("Discord uses channel.options.token; configure it via xacpx channel add discord --token <bot-token>");
  }

  async logout(): Promise<void> {
    await this.abortAllActiveTasks();
    for (const runtime of this.accounts.values()) {
      try {
        await runtime.client.destroy();
      } catch {
        // ignore
      }
    }
    this.accounts.clear();
    this.dedup.dispose();
  }

  async stop(_reason?: string): Promise<void> {
    // Abort in-flight turns while the clients are still alive, so a preview
    // message can still be deleted; the turns themselves are not awaited.
    await this.abortAllActiveTasks();
    for (const runtime of this.accounts.values()) {
      try {
        await runtime.client.destroy();
      } catch {
        // ignore
      }
    }
    this.accounts.clear();
    this.dedup.dispose();
    this.agent = null;
    this.quota = null;
    this.logger = null;
    this.abortSignal = null;
  }

  createConsumerLock(options?: ConsumerLockOptions): ConsumerLock {
    // One lock file per enabled token (F6: a Discord token allows exactly one
    // Gateway session). Files are named by sha256(token) alone — accountId is
    // NOT part of the name, so re-homing a token under a different accountId
    // still contends, and two processes whose token sets intersect at all
    // cannot both start that shared token. A process holding N distinct tokens
    // acquires N locks and rolls them back if any one conflicts.
    //
    // Core's injected lockFilePath is config-scoped (it lives under the
    // XACPX_CONFIG runtime dir) and therefore cannot anchor a token-global
    // Discord Gateway lock: two config roots on one machine would each get
    // their own file and start the same token twice. The token namespace is
    // always the user-global core home, so only `onDiagnostic` is forwarded.
    const dir = join(discordCoreHomeDir(), "runtime");
    const lockPaths = [...new Set(
      this.config.accounts
        .filter((account) => account.enabled && account.configured)
        .map((account) => account.token),
    )]
      .map((token) => join(dir, `discord-consumer-${discordTokenLockFingerprint(token)}.lock.json`))
      .sort();
    return composeConsumerLocks(
      lockPaths.map((lockFilePath) => createDiscordConsumerLock({ onDiagnostic: options?.onDiagnostic, lockFilePath })),
    );
  }

  configureOrchestration(callbacks: OrchestrationDeliveryCallbacks): void {
    this.markDelivered = callbacks.markTaskNoticeDelivered;
    this.markFailed = callbacks.markTaskNoticeFailed;
  }

  async start(input: ChannelStartInput): Promise<void> {
    setChannelLocale(input.locale ?? "en");
    this.agent = input.agent;
    this.quota = input.quota;
    this.logger = input.logger;
    this.sessions = input.sessions ?? null;
    this.activeTurns = input.activeTurns ?? null;
    this.abortSignal = input.abortSignal;

    const eligible = this.config.accounts.filter((account) => account.enabled && account.configured);
    await input.logger.info("discord.start", "starting discord channel", {
      accountCount: eligible.length,
      accounts: eligible.map((a) => a.accountId),
    });

    // Stagger identify to avoid 5s window clash (D8). Each account's
    // initial Gateway login must succeed for that account to be considered
    // started. Failures are isolated per-account, but if every enabled
    // account fails we must reject so MessageChannelRegistry.startAll can
    // record the channel startup failure (review #3).
    let startedCount = 0;
    let lastError: unknown = null;
    const staggerMs = this.deps.identifyStaggerMs ?? ACCOUNT_IDENTIFY_STAGGER_MS;
    for (let i = 0; i < eligible.length; i++) {
      const account = eligible[i]!;
      if (i > 0) await sleep(staggerMs);
      if (input.abortSignal.aborted) break;
      try {
        await this.startAccount(account, input);
        startedCount++;
      } catch (error) {
        lastError = error;
        // startAccount already logged and cleaned up the runtime entry;
        // continue to next account so a single bad token does not block others.
      }
    }

    if (eligible.length > 0 && startedCount === 0 && !input.abortSignal.aborted) {
      const message = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
      await input.logger.error("discord.start.all_failed", "all discord accounts failed to start", {
        accountCount: eligible.length,
        message,
      });
      throw new Error(`all ${eligible.length} discord account(s) failed to start; last error: ${message}`);
    }

    // Keep alive until abort.
    if (eligible.length > 0) {
      await new Promise<void>((resolve) => {
        if (input.abortSignal.aborted) {
          resolve();
          return;
        }
        input.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  }

  private async startAccount(account: DiscordResolvedAccountConfig, input: ChannelStartInput): Promise<void> {
    const client = this.deps.createClient?.(account) ??
      createDiscordClient({
        token: account.token,
        applicationId: account.applicationId || undefined,
        intentsMessageContent: account.intents.messageContent,
        intentsGuildMembers: account.intents.guildMembers,
      });

    // Identity comes from the Gateway session itself. A REST probe can return
    // an empty botUserId while login still succeeds, and every guard keyed on
    // it (own-message drop, mention gate, reply-to-bot) fails open when it is
    // empty — so the runtime is registered only after start() resolves with a
    // non-empty id. Messages that arrive during login find no runtime yet and
    // are dropped by handleMessageEvent's fail-closed guard.
    let identity: DiscordBotIdentity;
    try {
      identity = await client.start({
        handlers: {
          onMessage: (msg) => {
            void this.handleMessageEvent(account.accountId, msg).catch(async (err) => {
              await input.logger.error("discord.message.handle_failed", "failed to handle discord message", {
                accountId: account.accountId,
                messageId: msg.id,
                message: err instanceof Error ? err.message : String(err),
              });
            });
          },
        },
        abortSignal: input.abortSignal,
      });
    } catch (error) {
      // Initial Gateway login failed — this account is not started. Propagate
      // so start() can decide whether all accounts failed (review #3).
      try {
        await client.destroy();
      } catch {}
      await input.logger.error("discord.client.start_failed", "discord client start failed", {
        accountId: account.accountId,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (!identity.botUserId) {
      try {
        await client.destroy();
      } catch {}
      await input.logger.error("discord.client.start_failed", "discord client started without bot identity", {
        accountId: account.accountId,
      });
      throw new Error(`discord account "${account.accountId}" became ready without a bot identity`);
    }

    const shouldRegisterAutocomplete = account.enableAutocomplete !== false;
    const effectiveAppId = account.applicationId || identity.botUserId;
    if (shouldRegisterAutocomplete && effectiveAppId) {
      const commands = buildXacpxSlashCommands();
      try {
        await registerDiscordCommands({
          token: account.token,
          applicationId: effectiveAppId,
          commands,
        });
        await input.logger.info("discord.commands.registered", "registered discord application commands (global)", {
          accountId: account.accountId,
          count: commands.length,
          applicationId: effectiveAppId,
        });
      } catch (error) {
        await input.logger.warn("discord.commands.register_failed", "failed to register discord application commands (global)", {
          accountId: account.accountId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      const guildIds = new Set<string>();
      for (const gid of Object.keys(account.guilds ?? {})) guildIds.add(gid);
      const anyClient = client as unknown as { guilds?: { cache?: Map<string, unknown> | { keys(): Iterable<string> } } };
      try {
        const cache = anyClient.guilds?.cache as unknown as Map<string, unknown> | undefined;
        if (cache && typeof (cache as Map<string, unknown>).keys === "function") {
          for (const gid of (cache as Map<string, unknown>).keys()) guildIds.add(gid as string);
        }
      } catch {}
      for (const guildId of guildIds) {
        try {
          await registerDiscordCommands({ token: account.token, applicationId: effectiveAppId, guildId, commands });
          await input.logger.info("discord.commands.registered_guild", "registered discord guild commands", { accountId: account.accountId, guildId });
        } catch (error) {
          await input.logger.warn("discord.commands.register_failed_guild", "failed to register guild commands", { accountId: account.accountId, guildId, message: error instanceof Error ? error.message : String(error) });
        }
      }
    } else if (shouldRegisterAutocomplete && !effectiveAppId) {
      await input.logger.warn("discord.commands.register_skipped", "autocomplete enabled but no applicationId or botUserId available", {
        accountId: account.accountId,
      });
    }

    this.accounts.set(account.accountId, {
      account,
      client,
      botUserId: identity.botUserId,
      ...(identity.botTag ? { botTag: identity.botTag } : {}),
    });
  }

  async notifyTaskCompletion(task: OrchestrationTaskRecord): Promise<void> {
    if (!task.chatKey || !task.chatKey.startsWith("discord:")) return;
    try {
      await this.sendRouteText(task.chatKey, task.resultText || task.summary || getMessages().taskCompleted);
      if (this.markDelivered) await this.markDelivered(task.taskId, task.accountId || this.config.defaultAccount);
    } catch (error) {
      if (this.markFailed) {
        await this.markFailed(task.taskId, error instanceof Error ? error.message : String(error));
        return;
      }
      throw error;
    }
  }

  async notifyTaskProgress(task: OrchestrationTaskRecord, text: string): Promise<void> {
    if (!task.chatKey || !task.chatKey.startsWith("discord:")) return;
    await this.sendRouteText(task.chatKey, text);
  }

  async sendCoordinatorMessage(input: CoordinatorMessageInput): Promise<void> {
    if (!input.chatKey.startsWith("discord:")) return;
    await this.sendRouteText(input.chatKey, input.text);
  }

  async sendScheduledMessage(input: ScheduledChannelMessageInput): Promise<void> {
    if (!this.agent || !this.logger) {
      throw new Error("DiscordChannel.start() must be called before scheduled message delivery");
    }
    if (!input.chatKey.startsWith("discord:")) {
      throw new Error(`cannot deliver Discord scheduled message to non-Discord chatKey: ${input.chatKey}`);
    }
    const route = parseDiscordChatKey(input.chatKey);
    if (!route) throw new Error(`cannot parse Discord chatKey: ${input.chatKey}`);
    if (input.accountId && input.accountId !== route.accountId) {
      throw new Error(`scheduled Discord accountId "${input.accountId}" does not match chatKey account "${route.accountId}"`);
    }
    const runtime = this.accounts.get(route.accountId);
    if (!runtime) {
      throw new Error(`discord account "${route.accountId}" is not started; check channel.options.accounts and enabled flags`);
    }

    const target: DeliveryTarget = { channelId: route.channelId, ...(route.guildId ? { guildId: route.guildId } : {}) };

    const deliverText = async (text: string | undefined): Promise<void> => {
      if (input.abortSignal?.aborted) return;
      const trimmed = text?.trim() ?? "";
      if (!trimmed) return;
      await this.sendRouteText(input.chatKey, trimmed);
    };

    await this.sendRouteText(input.chatKey, input.noticeText);

    const effectiveReplyMode = resolveEffectiveReplyMode(runtime.account.replyMode);
    // Scheduled turns have no direct chat type; auto resolves to streaming.
    // We reuse same streaming path as normal turns but without preview complexity if not needed.
    // For now, scheduled turns go through agent.chat with reply handler that sends chunked text.
    // Streaming preview for scheduled is not critical; we just deliver via agent chat.

    try {
      const response = await this.agent.chat({
        accountId: route.accountId,
        conversationId: input.chatKey,
        text: input.promptText,
        ...(input.replyContextToken ? { replyContextToken: input.replyContextToken } : {}),
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        metadata: { channel: "discord", scheduledSessionAlias: input.sessionAlias },
        reply: async (delta) => {
          if (input.abortSignal?.aborted) return;
          // Scheduled streaming: we could pipe through preview, but keep static for simplicity.
          // deltas are incremental; we ignore them and wait for final text to avoid double-send.
          // To keep behavior consistent, we just no-op here.
          void delta;
        },
      });

      if (input.abortSignal?.aborted) return;

      const media = normalizeMediaArray(response.media);
      if (media.length > 0) {
        await this.logger.error("discord.scheduled.media_unsupported", "scheduled discord media responses are not supported", {
          accountId: route.accountId,
          chatKey: input.chatKey,
          taskId: input.taskId,
          sessionAlias: input.sessionAlias,
          count: media.length,
        });
      }

      await deliverText(response.text);
    } catch (error) {
      try {
        await deliverText(formatScheduledFailureText(input, error));
      } catch {
        // best-effort
      }
      throw error;
    }
  }

  private async sendRouteText(chatKey: string, text: string): Promise<void> {
    const parsed = parseDiscordChatKey(chatKey);
    if (!parsed) throw new Error(`cannot deliver Discord message to non-Discord chatKey: ${chatKey}`);
    const runtime = this.accounts.get(parsed.accountId);
    if (!runtime) throw new Error(`discord account "${parsed.accountId}" is not started; check channel.options.accounts and enabled flags`);
    const target: DeliveryTarget = { channelId: parsed.channelId, ...(parsed.guildId ? { guildId: parsed.guildId } : {}) };
    const rendered = renderDiscordMarkdown(text, runtime.account.tableMode);
    const chunks = chunkDiscordText(rendered, { maxChars: 2000, maxLines: runtime.account.maxLinesPerMessage });
    const resolveParentTarget =
      parsed.kind === "thread" ? () => this.resolveThreadParentTarget(runtime, parsed.channelId) : undefined;
    for (const chunk of chunks) {
      await sendWithThreadFallback({
        client: runtime.client,
        target,
        resolveParentTarget,
        body: { content: chunk, allowedMentions: { parse: [] } },
        loggerWarn: (msg, fields) => {
          void this.logger?.warn(msg, String(fields?.from ?? msg), fields);
        },
      });
    }
  }

  /** Parent target for a thread turn: the parent the inbound message already
   *  named, and only if it did not, the REST lookup for the thread. */
  private async resolveFinalThreadParentTarget(
    runtime: AccountRuntime,
    active: ActiveTask,
    target: DeliveryTarget,
  ): Promise<DeliveryTarget | null> {
    if (active.parentChannelId) return { channelId: active.parentChannelId };
    return this.resolveThreadParentTarget(runtime, target.channelId);
  }

  private async resolveThreadParentTarget(runtime: AccountRuntime, threadId: string): Promise<DeliveryTarget | null> {
    try {
      const anyClient = runtime.client as unknown as { getParentChannelId?: (id: string) => Promise<string | null> };
      if (anyClient.getParentChannelId) {
        const parentId = await anyClient.getParentChannelId(threadId);
        if (parentId) return { channelId: parentId };
      }
      const anyRaw = runtime.client as unknown as { client?: { channels?: { fetch?: (id: string) => Promise<unknown> } } };
      const rawClient = (anyRaw as { client?: unknown }).client as { channels?: { fetch?: (id: string) => Promise<{ parentId?: string | null }> } } | undefined;
      if (rawClient?.channels?.fetch) {
        const ch = (await rawClient.channels.fetch(threadId)) as { parentId?: string | null };
        if (ch?.parentId) return { channelId: ch.parentId };
      }
    } catch {
      // ignore
    }
    return null;
  }

  private async handleMessageEvent(accountId: string, msg: DiscordInboundMessage): Promise<void> {
    const runtime = this.accounts.get(accountId);
    if (!runtime || !this.agent || !this.quota || !this.logger) {
      throw new Error("DiscordChannel.start() must initialize runtime before handling messages");
    }

    const messageId = msg.id;
    const channelId = msg.channelId;
    if (!messageId || !channelId) return;

    // Self check first, before dedup and the allowBots policy: Discord echoes
    // our own MESSAGE_CREATE back through the Gateway, and an allowBots (or
    // requireMention:false / DM) path would feed it straight back into the
    // agent, self-looping. Own messages are always dropped; allowBots only
    // governs messages from OTHER bots.
    if (runtime.botUserId && msg.author.id === runtime.botUserId) {
      await this.logger.debug("discord.message.self_ignored", "ignoring own discord message echo", { messageId, accountId });
      return;
    }

    if (!this.dedup.tryRecord(messageId, accountId)) {
      await this.logger.info("discord.message.duplicate", "skipping duplicate discord message", { messageId, accountId });
      return;
    }
    if (isMessageExpired(msg.createdTimestamp, runtime.account.inboundExpiryMs)) {
      await this.logger.info("discord.message.expired", "skipping expired discord message", { messageId, accountId });
      return;
    }

    // Bot check: ignore other bots unless allowBots.
    if (msg.author.bot && !runtime.account.allowBots) {
      await this.logger.info("discord.message.bot_ignored", "ignoring bot message", { messageId, accountId, authorId: msg.author.id });
      return;
    }

    const route = buildDiscordRoute({ accountId, message: msg });
    const policy = evaluateDiscordAccessPolicy({
      route,
      account: runtime.account,
      senderId: msg.author.id,
      senderRoleIds: msg.senderRoleIds,
    });
    if (!policy.allow) {
      await this.logger.info("discord.message.policy_denied", "discord message blocked by access policy", {
        accountId,
        messageId,
        channelId,
        guildId: msg.guildId,
        senderId: msg.author.id,
        reason: policy.reason,
      });
      return;
    }

    const chatKey = buildDiscordChatKey({ accountId, route });
    const queueKey = buildDiscordQueueKey(accountId, channelId, route.kind);

    // One mention decision per message. The abort fast path used to read
    // account.requireMention while this gate read the channel override, so a
    // channel that waived the mention still required "@bot stop" (and vice
    // versa). Both paths now share the computed value.
    const isDM = route.kind === "dm";
    const effectiveChannelIdForMention = msg.parentChannelId ?? channelId;
    const channelRequireMention = resolveChannelRequireMention(runtime.account, route.guildId, effectiveChannelIdForMention);
    const effectiveRequireMention = channelRequireMention ?? runtime.account.requireMention;

    // Abort fast path
    if (await this.tryHandleAbortTrigger({
      runtime,
      queueKey,
      accountId,
      channelId,
      messageId,
      msg,
      chatKey,
      isDM,
      requireMention: effectiveRequireMention,
    })) {
      return;
    }
    // Mention cleaning and gate
    const decision = shouldHandleDiscordMessage({
      message: msg,
      botUserId: runtime.botUserId,
      requireMention: effectiveRequireMention,
      accountRequireMention: runtime.account.requireMention,
      channelRequireMention,
      guildId: msg.guildId,
      isDM,
    });
    if (!decision.handle) {
      await this.logger.info("discord.message.no_mention", "skipping discord message without required mention", {
        accountId,
        messageId,
        channelId,
      });
      return;
    }

    // Outbound budget reset: fires once the message is accepted, before the
    // attachment fetch, so a slow download cannot delay the reset.
    this.quota.onInbound(chatKey);

    let requestText = decision.text;

    const { media, skipped } = await this.downloadInboundAttachments({
      runtime,
      accountId,
      chatKey,
      messageId,
      msg,
    });
    requestText = appendSkippedAttachmentNotes(requestText, skipped);

    // Allow empty text if there are attachments (media-only message)
    if (!requestText.trim() && media.length === 0) return;

    const isSlash = requestText.trim().startsWith("/");
    const boundAlias = isSlash ? undefined : (this.sessions?.peekCurrentSessionAlias(chatKey) ?? undefined);
    const lane = resolveTurnLane(requestText);

    const { active, abortController } = this.registerActiveTask({
      accountId,
      channelId,
      guildId: route.guildId,
      parentChannelId: msg.parentChannelId ?? null,
      messageId,
      senderId: msg.author.id,
      chatKind: route.kind,
      queueKey,
      boundAlias,
    });
    if (boundAlias) this.activeTurns?.markActive(chatKey, boundAlias);

    await this.executor.run(
      chatKey,
      lane,
      () =>
        this.runTurn({
          runtime,
          accountId,
          channelId,
          guildId: route.guildId,
          chatKey,
          queueKey,
          messageId,
          requestText,
          media,
          active,
          abortController,
          boundAlias,
          route,
        }),
      boundAlias,
    );
  }

  private async tryHandleAbortTrigger(input: {
    runtime: AccountRuntime;
    queueKey: string;
    accountId: string;
    channelId: string;
    messageId: string;
    msg: DiscordInboundMessage;
    chatKey: string;
    isDM: boolean;
    requireMention: boolean;
  }): Promise<boolean> {
    const { runtime, queueKey, accountId, channelId, messageId, msg, chatKey, isDM } = input;
    const rawText = (msg.content ?? "").trim();
    // Only consider abort if message is directly addressed (for guild with requireMention, it must mention bot)
    // For DM, any abort word counts.
    // For guild, check mention similar to normal handling: if requireMention true, abort must mention bot.
    if (!isDM && input.requireMention) {
      const mentionedViaUsers = msg.mentions?.users?.some((u) => u.id === runtime.botUserId) ?? false;
      const mentionsBot = mentionedViaUsers || msg.content.includes(`<@${runtime.botUserId}>`) || msg.content.includes(`<@!${runtime.botUserId}>`);
      const repliesToBot = isDiscordReplyToBot(msg, runtime.botUserId);
      const hasTag = rawText.includes(`<@${runtime.botUserId}>`) || rawText.includes(`<@!${runtime.botUserId}>`);
      if (!mentionsBot && !repliesToBot && !hasTag) return false;
    }
    const cleaned = cleanDiscordMention(rawText, runtime.botUserId).trim() || rawText.trim();
    if (!isLikelyAbortText(cleaned)) return false;

    const stack = this.activeTasks.get(queueKey);
    if (!stack || stack.length === 0) return false;

    const senderId = msg.author.id;
    // If requireMention and group, sender must be the same as task sender? Spec says abort fast path
    // should check sender owns live task. We implement: senderId must match active senderId if present.
    const owned = stack.filter((t) => !t.senderId || t.senderId === senderId);
    const activeTasks = owned.length > 0 ? owned : [];
    if (activeTasks.length === 0) return false;

    await this.handleAbortFastPath({ runtime, activeTasks, abortRequestMessageId: messageId, channelId, accountId, chatKey });
    return true;
  }

  private registerActiveTask(input: {
    accountId: string;
    channelId: string;
    guildId?: string;
    parentChannelId?: string | null;
    messageId: string;
    senderId?: string;
    chatKind?: string;
    queueKey: string;
    boundAlias?: string;
  }): { active: ActiveTask; abortController: AbortController } {
    const { accountId, channelId, guildId, parentChannelId, messageId, senderId, chatKind, queueKey, boundAlias } = input;
    const abortController = new AbortController();
    const active: ActiveTask = {
      accountId,
      channelId,
      guildId,
      parentChannelId: parentChannelId ?? null,
      messageId,
      senderId,
      chatKind,
      queueKey,
      boundAlias,
      abortController,
      rootAbortCleanup: null,
      suppressed: false,
      previewStream: null,
      stopTyping: null,
    };
    const stack = this.activeTasks.get(queueKey) ?? [];
    stack.push(active);
    this.activeTasks.set(queueKey, stack);

    // Bind the turn to the channel-level abort signal. Without this the claim
    // that "in-flight turns settle via abortSignal" was false: nothing ever
    // forwarded that signal, so xacpx stop/logout left the agent turn running
    // and it could still post its answer. Suppression is set alongside the
    // abort because an agent is free to ignore its signal.
    const rootSignal = this.abortSignal;
    if (rootSignal) {
      if (rootSignal.aborted) {
        active.suppressed = true;
        try {
          abortController.abort();
        } catch {
          // ignore
        }
      } else {
        const onRootAbort = (): void => {
          active.suppressed = true;
          try {
            abortController.abort();
          } catch {
            // ignore
          }
        };
        rootSignal.addEventListener("abort", onRootAbort, { once: true });
        active.rootAbortCleanup = () => rootSignal.removeEventListener("abort", onRootAbort);
      }
    }
    return { active, abortController };
  }

  /**
   * Suppress and abort every in-flight turn. Used by stop()/logout() before the
   * Gateway clients are destroyed, so a preview message can still be cleaned
   * up. The agent turn itself is never awaited — shutdown must not block on it
   * — and the suppressed flag keeps the abandoned turn from delivering output
   * afterwards.
   */
  private async abortAllActiveTasks(): Promise<void> {
    const tasks = [...this.activeTasks.values()].flat();
    for (const task of tasks) {
      task.suppressed = true;
      try {
        task.abortController.abort();
      } catch {
        // ignore
      }
    }
    for (const task of tasks) {
      try {
        task.rootAbortCleanup?.();
      } catch {
        // ignore
      }
      task.rootAbortCleanup = null;
      try {
        task.stopTyping?.();
      } catch {
        // ignore
      }
      task.stopTyping = null;
      const preview = task.previewStream;
      task.previewStream = null;
      if (preview) {
        try {
          await preview.cleanup();
        } catch {
          // Best effort: a dead Gateway must not block shutdown.
        }
      }
    }
    this.activeTasks.clear();
  }

  private async handleAbortFastPath(input: {
    runtime: AccountRuntime;
    activeTasks: ActiveTask[];
    abortRequestMessageId: string;
    channelId: string;
    accountId: string;
    chatKey: string;
  }): Promise<void> {
    const { runtime, activeTasks, abortRequestMessageId, channelId, accountId, chatKey } = input;
    for (const t of activeTasks) {
      t.suppressed = true;
      try {
        t.abortController.abort();
      } catch {
        // ignore
      }
    }
    const target: DeliveryTarget = { channelId, ...(activeTasks[0]?.guildId ? { guildId: activeTasks[0]!.guildId } : {}) };
    await this.logger!.info("discord.abort.triggered", "abort fast-path triggered for active task", {
      accountId,
      channelId,
      activeMessageId: activeTasks[activeTasks.length - 1]!.messageId,
      abortRequestMessageId,
      suppressedCount: activeTasks.length,
    });
    // Stop typing
    for (const t of activeTasks) {
      try {
        t.stopTyping?.();
      } catch {
        // ignore
      }
      t.stopTyping = null;
    }
    // Cleanup preview streams
    let previewCleaned = false;
    for (const t of activeTasks) {
      if (t.previewStream) {
        try {
          await t.previewStream.cleanup();
          previewCleaned = true;
        } catch (error) {
          await this.logger!.error("discord.abort.preview_cleanup_failed", "failed to cleanup preview on abort", {
            accountId,
            channelId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        t.previewStream = null;
      }
    }
    if (previewCleaned) {
      // Preview already covered visual feedback; no need for extra ack if we cleaned preview?
      // Still send ack to confirm.
    }
    try {
      const targetForAck: DeliveryTarget = target;
      await runtime.client.sendMessage(targetForAck, { content: getMessages().abortAck, allowedMentions: { parse: [] } });
      // Remove from queue mapping? The still-queued executor normal tasks will short-circuit via suppressed check.
    } catch (error) {
      await this.logger!.error("discord.abort.ack_failed", "failed to send abort acknowledgement", {
        accountId,
        channelId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    void abortRequestMessageId;
    void chatKey;
  }

  private async downloadInboundAttachments(input: {
    runtime: AccountRuntime;
    accountId: string;
    chatKey: string;
    messageId: string;
    msg: DiscordInboundMessage;
  }): Promise<{ media: ChannelMediaAttachment[]; skipped: string[] }> {
    const { runtime, accountId, chatKey, messageId, msg } = input;
    const attachments = extractDiscordAttachments(msg);
    if (attachments.length === 0) return { media: [], skipped: [] };
    const mediaStore = (this.deps as { mediaStore?: RuntimeMediaStore }).mediaStore ?? new RuntimeMediaStore({ rootDir: path.join(process.cwd(), ".xacpx-media") });
    const media: ChannelMediaAttachment[] = [];
    const skipped: string[] = [];
    const maxAttachments = runtime.account.media.maxAttachments ?? DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE;
    const maxBytes = runtime.account.media.maxBytes ?? 8 * 1024 * 1024; // config default 8MiB (conservative, F7)
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    for (const att of attachments.slice(0, maxAttachments)) {
      try {
        const downloaded = await downloadDiscordAttachment({ url: att.url, maxBytes, fetchImpl });
        const kind = inferMediaKind(downloaded.contentType ?? att.contentType ?? null, att.name ?? downloaded.fileName);
        const saved = await mediaStore.saveMediaBuffer({
          channelId: "discord",
          accountId,
          chatKey,
          messageId,
          fileName: downloaded.fileName ?? att.name,
          mimeType: downloaded.contentType ?? att.contentType ?? defaultMimeForKind(kind),
          kind,
          buffer: downloaded.buffer,
          maxBytes,
        });
        media.push(saved);
      } catch (error) {
        skipped.push(`Skipped attachment ${att.name ?? att.url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (attachments.length > maxAttachments) {
      skipped.push(`${attachments.length - maxAttachments} attachment(s) omitted: exceeds limit`);
    }
    return { media, skipped };
  }

  private async runTurn(input: {
    runtime: AccountRuntime;
    accountId: string;
    channelId: string;
    guildId?: string;
    chatKey: string;
    queueKey: string;
    messageId: string;
    requestText: string;
    media: ChannelMediaAttachment[];
    active: ActiveTask;
    abortController: AbortController;
    boundAlias?: string;
    route: DiscordRoute;
  }): Promise<void> {
    const { runtime, accountId, channelId, guildId, chatKey, queueKey, messageId, requestText, media, active, abortController, boundAlias } = input;
    let turnStatus: "done" | "error" | "skipped" = "skipped";
    const target: DeliveryTarget = { channelId, ...(guildId ? { guildId } : {}) };
    try {
      if (!this.agent) return;
      if (active.suppressed) return;

      // Typing indicator
      if (runtime.account.typingIndicator) {
        try {
          active.stopTyping = await runtime.client.startTyping(channelId);
        } catch {
          active.stopTyping = null;
        }
      }
      if (active.suppressed) return;

      // Ack reaction
      if (runtime.account.ackReaction) {
        void runtime.client.addReaction(channelId, messageId, runtime.account.ackReaction).catch(() => {});
      }

      const effectiveReplyMode = resolveEffectiveReplyMode(runtime.account.replyMode);
      if (effectiveReplyMode === "streaming") {
        active.previewStream = createDiscordPreviewStream({
          client: runtime.client,
          target,
          maxChars: 2000,
          throttleMs: runtime.account.previewThrottleMs,
          minInitialChars: 1,
          onWarn: (msg) => {
            void this.logger?.warn("discord.preview.warn", msg, { accountId, channelId });
          },
        });
      }
      if (active.suppressed) {
        if (active.previewStream) {
          try {
            await active.previewStream.cleanup();
          } catch {}
          active.previewStream = null;
        }
        return;
      }

      let accumulated = "";
      const toolRenderState = { emittedToolCallIds: new Set<string>() } as { emittedToolCallIds: Set<string> };
      const safeReply = async (delta: string): Promise<void> => {
        if (active.suppressed || !delta) return;
        const trimmed = delta.trimStart();
        const isProgress = /^[🚀🔧⏳ℹ️📦🔩🔄⚠️🧰]/.test(trimmed);
        if (accumulated.length > 0 && isProgress) {
          if (!accumulated.endsWith("\n")) accumulated += "\n";
        } else if (accumulated.length > 0 && trimmed.length > 0) {
          const lastLine = accumulated.split("\n").pop() ?? "";
          const lastWasTool = /^[📖🔍🔧✏️💭🧰⚠️]/.test(lastLine.trimStart());
          if (lastWasTool && !isProgress) {
            if (!accumulated.endsWith("\n\n") && !accumulated.endsWith("\n")) accumulated += "\n\n";
            else if (accumulated.endsWith("\n") && !accumulated.endsWith("\n\n")) accumulated += "\n";
          }
        }
        accumulated += delta;
        active.previewStream?.update(accumulated);
      };
      const onToolEvent = async (event: ToolUseEvent): Promise<void> => {
        if (active.suppressed) return;
        const toolName = event.toolName?.trim();
        if (!toolName) return;
        if (event.toolCallId && toolRenderState.emittedToolCallIds.has(event.toolCallId)) return;
        if (event.toolCallId) toolRenderState.emittedToolCallIds.add(event.toolCallId);
        const summary = event.summary && event.summary !== toolName ? event.summary : "";
        const display = summary ? `${toolName}: ${summary}` : toolName;
        const truncated = display.length > 60 ? `${display.slice(0, 57)}…` : display;
        const emojiMap: Record<string, string> = { read: "📖", search: "🔍", execute: "🔧", edit: "✏️", think: "💭", other: "🔧" };
        const emoji = emojiMap[event.kind] ?? "🔧";
        const line = `${emoji} ${truncated} (${event.status})`;
        // dedup identical consecutive truncated lines (e.g. repeated git log)
        const lines = accumulated.split("\n");
        const lastLine = lines[lines.length - 1] ?? "";
        if (lastLine === line) return;
        accumulated += (accumulated ? "\n" : "") + line;
        active.previewStream?.update(accumulated);
      };
      const onThought = async (chunk: string): Promise<void> => {
        if (active.suppressed || !chunk) return;
        accumulated += chunk;
        active.previewStream?.update(accumulated);
      };

      try {
        const response = await this.agent.chat({
          accountId,
          conversationId: chatKey,
          text: requestText,
          ...(media.length > 0 ? { media } : {}),
          replyContextToken: messageId,
          metadata: {
            channel: "discord",
            chatType: input.route.kind === "dm" ? "direct" : "group",
            senderId: active.senderId,
            groupId: guildId,
            ...(boundAlias ? { boundSessionAlias: boundAlias } : {}),
          },
          reply: safeReply,
          onToolEvent,
          onThought,
          abortSignal: abortController.signal,
        });
        if (active.suppressed) return;

        // Cleanup preview: delete preview message (content duplicated with final answer)
        if (active.previewStream) {
          try {
            await active.previewStream.cleanup();
          } catch (error) {
            await this.logger!.warn("discord.preview.cleanup_failed", "failed to cleanup preview stream", {
              accountId,
              channelId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
          active.previewStream = null;
        }

        const trimmedAcc = accumulated.trim();
        const trimmedResp = (response.text ?? "").trim();
        let finalText: string;
        if (!trimmedAcc) finalText = trimmedResp;
        else if (!trimmedResp) finalText = trimmedAcc;
        else if (trimmedAcc.includes(trimmedResp)) finalText = trimmedAcc;
        else finalText = `${trimmedAcc}\n\n${trimmedResp}`;
        if (!finalText) finalText = response.text ?? accumulated;
        await this.deliverFinalResponse({
          runtime,
          target,
          finalText,
          responseMedia: normalizeMediaArray(response.media),
          messageId,
          active,
        });
        turnStatus = "done";
      } catch (error) {
        if (active.previewStream) {
          try {
            await active.previewStream.cleanup();
          } catch {}
          active.previewStream = null;
        }
        turnStatus = "error";
        throw error;
      }
    } finally {
      try {
        active.rootAbortCleanup?.();
      } catch {
        // ignore
      }
      active.rootAbortCleanup = null;
      try {
        active.stopTyping?.();
      } catch {
        // ignore
      }
      active.stopTyping = null;
      if (active.previewStream) {
        try {
          await active.previewStream.cleanup();
        } catch {}
        active.previewStream = null;
      }
      if (boundAlias) {
        this.activeTurns?.markInactive(chatKey, boundAlias);
        // A suppressed turn was aborted (abort fast path, channel stop or
        // logout): its answer, and therefore its completion notice, is void.
        if (!active.suppressed && turnStatus !== "skipped" && this.sessions && this.sessions.peekCurrentSessionAlias(chatKey) !== boundAlias) {
          await this.sessions.setBackgroundResult(chatKey, boundAlias, {
            text: "",
            status: turnStatus,
            finished_at: new Date().toISOString(),
          });
          await this.sendBackgroundCompletionNotice({
            runtime,
            channelId,
            guildId,
            messageId,
            boundAlias,
            status: turnStatus,
            active,
          });
        }
      }
      const stack = this.activeTasks.get(queueKey);
      if (stack) {
        const idx = stack.indexOf(active);
        if (idx >= 0) stack.splice(idx, 1);
        if (stack.length === 0) this.activeTasks.delete(queueKey);
      }
    }
  }

  private async deliverFinalResponse(input: {
    runtime: AccountRuntime;
    target: DeliveryTarget;
    finalText: string;
    responseMedia: ChannelMediaAttachment[] | Array<{ filePath: string; mimeType?: string; kind?: string }>;
    messageId: string;
    active: ActiveTask;
  }): Promise<void> {
    const { runtime, target, finalText, responseMedia, active } = input;
    const trimmed = finalText.trim();
    const resolveParentTarget =
      active.chatKind === "thread"
        ? () => this.resolveFinalThreadParentTarget(runtime, active, target)
        : undefined;
    if (trimmed.length > 0) {
      const rendered = renderDiscordMarkdown(trimmed, runtime.account.tableMode);
      const chunks = chunkDiscordText(rendered, { maxChars: 2000, maxLines: runtime.account.maxLinesPerMessage });
      for (const chunk of chunks) {
        if (active.suppressed) return;
        await sendWithThreadFallback({
          client: runtime.client,
          target,
          resolveParentTarget,
          body: { content: chunk, allowedMentions: { parse: [] } },
          loggerWarn: (msg, fields) => {
            void this.logger?.warn(msg, String(fields?.from ?? msg), fields);
          },
        });
      }
    }
    for (const item of responseMedia) {
      if (active.suppressed) return;
      const filePath = (item as { filePath: string }).filePath;
      if (!filePath) continue;
      const allowedRoots = [this.deps.mediaStore?.rootDir, ...(this.deps.allowedMediaRoots ?? [])].filter((x): x is string => typeof x === "string");
      const safePath = await resolveSafeOutboundMediaPath(filePath, allowedRoots);
      if (!safePath) {
        await this.logger!.error("discord.media.rejected", "outbound media path rejected", { filePath, accountId: runtime.account.accountId });
        continue;
      }
      try {
        const buffer = await readFile(safePath);
        const name = (item as { fileName?: string }).fileName ?? path.basename(safePath);
        await sendWithThreadFallback({
          client: runtime.client,
          target,
          resolveParentTarget,
          body: {
            content: (item as { caption?: string }).caption ?? undefined,
            files: [{ attachment: buffer, name }],
            allowedMentions: { parse: [] },
          },
          loggerWarn: (msg, fields) => {
            void this.logger?.warn(msg, String(fields?.from ?? msg), fields);
          },
        });
      } catch (error) {
        await this.logger!.error("discord.media.send_failed", "failed to send discord media", {
          message: error instanceof Error ? error.message : String(error),
          accountId: runtime.account.accountId,
        });
      }
    }
  }

  private async sendBackgroundCompletionNotice(input: {
    runtime: AccountRuntime;
    channelId: string;
    guildId?: string;
    messageId: string;
    boundAlias: string;
    status: "done" | "error";
    active: ActiveTask;
  }): Promise<void> {
    const text = buildDiscordCompletionNotice(toDisplaySessionAlias(input.boundAlias), input.status);
    const target: DeliveryTarget = { channelId: input.channelId, ...(input.guildId ? { guildId: input.guildId } : {}) };
    const resolveParentTarget =
      input.active.chatKind === "thread"
        ? () => this.resolveFinalThreadParentTarget(input.runtime, input.active, target)
        : undefined;
    try {
      await sendWithThreadFallback({
        client: input.runtime.client,
        target,
        resolveParentTarget,
        body: { content: text, allowedMentions: { parse: [] } },
        loggerWarn: (msg, fields) => {
          void this.logger?.warn(msg, String(fields?.from ?? msg), fields);
        },
      });
    } catch (error) {
      await this.logger?.error("discord.bg_notice.failed", "failed to send background completion notice", {
        channelId: input.channelId,
        boundAlias: input.boundAlias,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// Minimal consumer lock for Discord: one Gateway session per token (F6).
// createConsumerLock() maps each distinct enabled token to its own lock file
// (named by sha256(token), never the token or accountId) and composes them.
// Each lock is lockId-gated and PID-reuse hardened, so a live holder is never
// mistaken for a stale one.
function discordTokenLockFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/**
 * The user-global core home, deliberately independent of `XACPX_CONFIG`. Same
 * resolution `src/config/config-path.ts` uses for its default config path, minus
 * that env override — a token fence must not move with the config it guards.
 */
function discordCoreHomeDir(): string {
  return coreHomeDir(process.env.HOME ?? homedir());
}

/**
 * Aggregate several single-file locks behind the ConsumerLock contract:
 * acquire runs them in order and releases every lock already held when one
 * conflicts (then rethrows), so a rejected start never leaves a partial token
 * set locked; release drops all held locks. With zero locks this is a no-op —
 * no enabled token means there is no Gateway session to guard.
 */
function composeConsumerLocks(locks: ConsumerLock[]): ConsumerLock {
  let held: ConsumerLock[] = [];
  return {
    async acquire(meta: ConsumerLockMetadata): Promise<void> {
      held = [];
      for (const lock of locks) {
        try {
          await lock.acquire(meta);
        } catch (error) {
          const acquired = held;
          held = [];
          for (const done of acquired) {
            try {
              await done.release();
            } catch {
              // Rollback must not mask the original conflict.
            }
          }
          throw error;
        }
        held.push(lock);
      }
    },
    async release(): Promise<void> {
      const acquired = held;
      held = [];
      let releaseError: unknown;
      for (const done of acquired) {
        try {
          await done.release();
        } catch (error) {
          releaseError ??= error;
        }
      }
      if (releaseError) throw releaseError;
    },
  };
}

function createDiscordConsumerLock(options: ConsumerLockOptions = {}): ConsumerLock {
  const lockFilePath = options.lockFilePath ?? join(discordCoreHomeDir(), "runtime", "discord-consumer.lock.json");
  const onDiagnostic = options.onDiagnostic;
  let lockId: string | undefined;

  const emit = async (event: string, context: Record<string, string | number | boolean | undefined>): Promise<void> => {
    if (onDiagnostic) await onDiagnostic(event, context);
  };

  return {
    async acquire(meta: ConsumerLockMetadata): Promise<void> {
      await mkdir(dirname(lockFilePath), { recursive: true, mode: 0o700 });
      const requested: ConsumerLockMetadata & { lockId: string } = {
        ...meta,
        lockId: lockId ?? randomUUID(),
      };
      lockId = requested.lockId;

      while (true) {
        try {
          const handle = await open(lockFilePath, "wx");
          try {
            await handle.writeFile(`${JSON.stringify(requested, null, 2)}\n`, "utf8");
          } finally {
            await handle.close();
          }
          await emit("lock_acquired", { lockFilePath, pid: meta.pid, mode: meta.mode });
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EEXIST") throw error;
          await emit("lock_exists", { lockFilePath, pid: meta.pid, mode: meta.mode });
          const existingLock = await readExistingLock(lockFilePath);
          if (existingLock.state === "absent") {
            // Its holder released between our EEXIST and our read. Retrying the
            // exclusive create is safe precisely because nothing was deleted.
            continue;
          }
          if (existingLock.state === "unreadable") {
            await emit("lock_invalid_conflict", {
              lockFilePath,
              reason: "existing_lock_metadata_unreadable",
            });
            throw new Error(
              `Discord consumer lock exists but its metadata is unreadable: ${lockFilePath}; `
              + "refusing to delete it, because its holder may still be writing it",
            );
          }
          const existing = existingLock.metadata;
          const same = await isSameProcess(existing);
          if (!same) {
            await rm(lockFilePath, { force: true });
            await emit("lock_stale_removed", {
              lockFilePath,
              stalePid: existing.pid,
              staleMode: existing.mode,
              reason: "owner_process_missing_or_identity_changed",
            });
            continue;
          }
          await emit("lock_active_conflict", {
            lockFilePath,
            activePid: existing.pid,
            activeMode: existing.mode,
            requestedPid: meta.pid,
            requestedMode: meta.mode,
          });
          throw new ActiveConsumerLockError(
            `Discord consumer lock held by pid ${existing.pid} (${existing.mode})`,
            lockFilePath,
            existing,
          );
        }
      }
    },
    async release(): Promise<void> {
      const metadata = await loadLockMetadata(lockFilePath);
      if (metadata && (metadata as unknown as { lockId?: string }).lockId === lockId) {
        await rm(lockFilePath, { force: true });
      } else if (!metadata) {
        // already gone
      } else if (!lockId) {
        // no lockId remembered — try to remove if we are the owner by pid
      }
      lockId = undefined;
      await emit("lock_released", { lockFilePath });
    },
  };
}

/** A holder creates the lock with "wx" and writes its JSON afterwards, so a
 *  competing reader can catch an empty or half-written file. Re-read briefly to
 *  absorb that publication window, then fail closed: a lock we cannot read is
 *  never deleted, because deleting it can steal a live holder's ownership. */
const UNREADABLE_LOCK_REREAD_ATTEMPTS = 5;
const UNREADABLE_LOCK_REREAD_DELAY_MS = 20;

type ExistingLock =
  | { state: "absent" }
  | { state: "unreadable" }
  | { state: "owned"; metadata: ConsumerLockMetadata };

async function readExistingLock(lockFilePath: string): Promise<ExistingLock> {
  for (let attempt = 1; attempt <= UNREADABLE_LOCK_REREAD_ATTEMPTS; attempt++) {
    if (!(await lockFileExists(lockFilePath))) return { state: "absent" };
    const metadata = await loadLockMetadata(lockFilePath);
    if (metadata) return { state: "owned", metadata };
    if (attempt < UNREADABLE_LOCK_REREAD_ATTEMPTS) await sleep(UNREADABLE_LOCK_REREAD_DELAY_MS);
  }
  return { state: "unreadable" };
}

async function lockFileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadLockMetadata(path: string): Promise<ConsumerLockMetadata | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as ConsumerLockMetadata;
    if (typeof parsed.pid !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function isSameProcess(metadata: ConsumerLockMetadata): Promise<boolean> {
  // Prefer start-time check to defeat PID reuse; fall back to kill(0) without ps.
  const probe = await probeProcessStartTime(metadata.pid);
  if (probe.found) {
    const metaStart = (metadata as ConsumerLockMetadata & { processStartedAtMs?: number }).processStartedAtMs;
    if (typeof metaStart === "number" && Number.isFinite(metaStart)) {
      return probe.startedAtMs === metaStart;
    }
    // No start time in existing lock -> conservatively treat as same (fail-closed).
    return true;
  }
  if (probe.unavailable) return true;
  return false;
}

async function probeProcessStartTime(pid: number): Promise<{ found: boolean; startedAtMs?: number; unavailable?: boolean }> {
  // POSIX ps path; on Windows fall back to kill(0)
  if (process.platform === "win32") {
    try {
      process.kill(pid, 0);
      return { found: true, unavailable: true };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return { found: false };
      return { found: true, unavailable: true };
    }
  }
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 5000 });
    const out = stdout.trim();
    if (!out) return { found: false };
    const ms = Date.parse(out);
    if (!Number.isFinite(ms)) return { found: true, unavailable: true };
    return { found: true, startedAtMs: ms };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 1 || code === "1") return { found: false };
    return { found: true, unavailable: true };
  }
}
