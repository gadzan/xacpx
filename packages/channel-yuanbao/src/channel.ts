import { createConversationExecutor, resolveTurnLane, SubagentNoticeTracker } from "xacpx/plugin-api";
import { t, setChannelLocale } from "./i18n/index.js";
import type {
  ActiveTurnRegistry,
  ChannelStartInput,
  ConversationExecutor,
  CoordinatorMessageInput,
  MessageChannelRuntime,
  OrchestrationDeliveryCallbacks,
  ScheduledChannelMessageInput,
  SessionService,
} from "xacpx/plugin-api";
import { parseYuanbaoChannelConfig, type YuanbaoChannelConfig, type YuanbaoResolvedAccountConfig } from "./config.js";
import type { YuanbaoGateway, YuanbaoGatewayFactory, YuanbaoGatewayInboundMessage } from "./types.js";
import { buildYuanbaoChatKey, extractYuanbaoContent, parseYuanbaoChatKey } from "./inbound.js";
import { loadYuanbaoGatewayFromModule } from "./gateway-loader.js";
import { createBuiltinYuanbaoGateway } from "./builtin-gateway.js";
import { PLUGIN_VERSION } from "./command-sync.js";
import { normalizeMediaArray, type ChannelMediaAttachment } from "./media-types.js";
import { MessageDedup } from "./message-dedup.js";
import { ReplyQuoteCache } from "./reply-quote-cache.js";
import { buildYuanbaoCompletionNotice } from "./completion-notice.js";
import {
  createOutboundQueueSession,
  type OutboundQueueScheduler,
  type OutboundQueueStrategy,
} from "./outbound-queue.js";
import { chunkMarkdownAware } from "./markdown-chunker.js";
import { formatQuoteContext, isQuoteRepliedToBot, parseQuoteFromCloudCustomData } from "./quote.js";
import { GroupHistoryStore, formatGroupHistoryContext } from "./group-history.js";
import {
  defaultImageFileName,
  downloadInboundYuanbaoMedia,
} from "./inbound-media.js";
import { RuntimeMediaStore, DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE } from "./media-store.js";
import path from "node:path";

type OrchestrationTaskRecord = Parameters<MessageChannelRuntime["notifyTaskCompletion"]>[0];

const REPLY_HEARTBEAT_RUNNING = 1;
const REPLY_HEARTBEAT_FINISH = 2;
const REPLY_HEARTBEAT_INTERVAL_MS = 2_000;

function formatScheduledFailureText(input: ScheduledChannelMessageInput, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return input.taskId
    ? t().scheduledFailureWithId(input.taskId, message)
    : t().scheduledFailure(message);
}

export interface YuanbaoChannelDeps {
  createGateway?: YuanbaoGatewayFactory;
  /** Test hook: override the outbound queue's idle-timer scheduler. */
  outboundSchedule?: OutboundQueueScheduler;
  /** Where inbound media payloads are persisted so `agent.chat({ media })` can reach them. */
  mediaStore?: RuntimeMediaStore;
  /** Test hook: override the inbound media URL fetcher. */
  fetchInboundMedia?: typeof fetch;
}

export class YuanbaoChannel implements MessageChannelRuntime {
  readonly id = "yuanbao";
  private readonly config: YuanbaoChannelConfig;
  private gateway: YuanbaoGateway | null = null;
  private agent: ChannelStartInput["agent"] | null = null;
  private quota: ChannelStartInput["quota"] | null = null;
  private logger: ChannelStartInput["logger"] | null = null;
  private abortSignal: AbortSignal | null = null;
  private sessions: SessionService | null = null;
  private activeTurns: ActiveTurnRegistry | null = null;
  // Per-session concurrency lanes + a control lane that preempts a running
  // prompt so `/use` / `/ss` / `/cancel` / `/stop` switch the foreground
  // session in real time instead of queuing behind the in-flight turn.
  private readonly executor: ConversationExecutor = createConversationExecutor();
  private readonly dedup = new MessageDedup();
  private readonly replyQuoteSent = new ReplyQuoteCache();
  private readonly groupHistory: GroupHistoryStore;
  private markDelivered: OrchestrationDeliveryCallbacks["markTaskNoticeDelivered"] | null = null;
  private markFailed: OrchestrationDeliveryCallbacks["markTaskNoticeFailed"] | null = null;

  constructor(options: Record<string, unknown> | undefined, private readonly deps: YuanbaoChannelDeps = {}) {
    this.config = parseYuanbaoChannelConfig(options);
    const maxHistory = this.config.accounts.reduce((m, a) => Math.max(m, a.historyLimit), 0);
    this.groupHistory = new GroupHistoryStore({ perGroupLimit: maxHistory });
  }

  isLoggedIn(): boolean {
    return this.config.accounts.some((account) => account.enabled && account.configured);
  }

  async login(): Promise<string> {
    if (this.isLoggedIn()) return "yuanbao credentials configured";
    throw new Error("Yuanbao uses channel.options.appKey and channel.options.appSecret; configure them instead of QR login.");
  }

  logout(): void {
    this.gateway?.stop?.();
    this.gateway = null;
    this.abortSignal = null;
    this.dedup.dispose();
    this.replyQuoteSent.clear();
    this.groupHistory.clear();
  }

  private isAborted(): boolean {
    return Boolean(this.abortSignal?.aborted);
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
    this.abortSignal = input.abortSignal;
    this.sessions = input.sessions ?? null;
    this.activeTurns = input.activeTurns ?? null;
    this.gateway = await this.resolveGateway();
    const accounts = this.config.accounts.filter((account) => account.enabled && account.configured);
    await input.logger.info("yuanbao.start", "starting yuanbao channel", { accounts: accounts.map((account) => account.accountId).join(",") });

    const hints = input.commandHints ?? [];
    const commandSync = hints.length > 0
      ? {
          botVersion: input.coreVersion ?? "unknown",
          pluginVersion: PLUGIN_VERSION,
          commands: hints.map((h) => ({ name: h.name, description: h.description })),
        }
      : undefined;

    await this.gateway.start({
      accounts,
      abortSignal: input.abortSignal,
      logger: input.logger,
      onMessage: (message) => this.handleInboundMessage(message),
      ...(commandSync ? { commandSync } : {}),
    });
  }

  async notifyTaskCompletion(task: OrchestrationTaskRecord): Promise<void> {
    if (!task.chatKey) return;
    if (this.isAborted()) return;
    try {
      const delivered = await this.sendRouteText(task.chatKey, task.replyContextToken, task.resultText || task.summary || t().taskCompleted);
      if (this.markDelivered) await this.markDelivered(task.taskId, task.accountId || delivered.accountId);
    } catch (error) {
      if (this.markFailed) {
        await this.markFailed(task.taskId, error instanceof Error ? error.message : String(error));
        return;
      }
      throw error;
    }
  }

  async notifyTaskProgress(task: OrchestrationTaskRecord, text: string): Promise<void> {
    if (!task.chatKey) return;
    if (this.isAborted()) return;
    await this.sendRouteText(task.chatKey, task.replyContextToken, text);
  }

  async sendCoordinatorMessage(input: CoordinatorMessageInput): Promise<void> {
    if (this.isAborted()) return;
    await this.sendRouteText(input.chatKey, input.replyContextToken, input.text);
  }

  async sendScheduledMessage(input: ScheduledChannelMessageInput): Promise<void> {
    if (!this.agent || !this.gateway || !this.logger) {
      throw new Error("YuanbaoChannel.start() must be called before scheduled message delivery");
    }
    if (this.isAborted()) return;
    const route = parseYuanbaoChatKey(input.chatKey);
    if (!route) throw new Error(`cannot deliver Yuanbao scheduled message to non-Yuanbao chatKey: ${input.chatKey}`);
    const account = this.accountById(route.accountId);
    if (!account) throw new Error(`unknown Yuanbao account in chatKey: ${route.accountId}`);

    await this.sendTextChunks({
      account,
      chatType: route.chatType,
      target: route.target,
      text: input.noticeText,
      replyContextToken: input.replyContextToken,
      retryWithoutReplyContextOnError: true,
    });

    const queue = this.createTurnQueue({
      account,
      chatType: route.chatType,
      target: route.target,
      replyContextToken: input.replyContextToken,
      retryWithoutReplyContextOnError: true,
    });

    try {
      const response = await this.agent.chat({
        accountId: account.accountId,
        conversationId: input.chatKey,
        text: input.promptText,
        ...(input.replyContextToken ? { replyContextToken: input.replyContextToken } : {}),
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : this.abortSignal ? { abortSignal: this.abortSignal } : {}),
        metadata: { channel: "yuanbao", scheduledSessionAlias: input.sessionAlias },
        reply: async (text) => {
          if (this.isAborted() || input.abortSignal?.aborted) return;
          await queue.push(text);
        },
      });

      if (this.isAborted() || input.abortSignal?.aborted) {
        queue.abort();
        return;
      }
      if (response.text) await queue.push(response.text);
      await queue.flush();

      const media = normalizeMediaArray(response.media);
      if (media.length > 0) {
        await this.logger.error("yuanbao.scheduled.media_unsupported", "yuanbao scheduled outbound media is not supported by the current gateway adapter", {
          chatKey: input.chatKey,
          taskId: input.taskId,
          sessionAlias: input.sessionAlias,
          count: media.length,
        });
      }
    } catch (error) {
      queue.abort();
      await this.sendTextChunks({
        account,
        chatType: route.chatType,
        target: route.target,
        text: formatScheduledFailureText(input, error),
        replyContextToken: input.replyContextToken,
        retryWithoutReplyContextOnError: true,
      }).catch(() => {});
      throw error;
    }
  }

  private async resolveGateway(): Promise<YuanbaoGateway> {
    if (this.deps.createGateway) return this.deps.createGateway({ config: this.config });
    if (this.config.gatewayModule) return await loadYuanbaoGatewayFromModule(this.config.gatewayModule, this.config);
    return createBuiltinYuanbaoGateway();
  }

  private accountById(accountId: string): YuanbaoResolvedAccountConfig | undefined {
    return this.config.accounts.find((account) => account.accountId === accountId);
  }

  private async sendRouteText(chatKey: string, replyContextToken: string | undefined, text: string): Promise<{ accountId: string }> {
    if (!this.gateway) throw new Error("YuanbaoChannel.start() must be called before delivery");
    const route = parseYuanbaoChatKey(chatKey);
    if (!route) throw new Error(`cannot deliver Yuanbao message to non-Yuanbao chatKey: ${chatKey}`);
    const account = this.accountById(route.accountId);
    if (!account) throw new Error(`unknown Yuanbao account in chatKey: ${route.accountId}`);
    await this.sendTextChunks({
      account,
      chatType: route.chatType,
      target: route.target,
      text,
      replyContextToken,
    });
    return { accountId: route.accountId };
  }

  private splitText(account: YuanbaoResolvedAccountConfig, text: string): string[] {
    if (text.length <= account.maxChars) return [text];
    if (account.overflowPolicy === "stop") {
      throw new Error(`Yuanbao outbound text exceeds channel.options.maxChars (${account.maxChars})`);
    }
    return chunkMarkdownAware(text, account.maxChars);
  }

  private resolveReplyContextToken(input: {
    account: YuanbaoResolvedAccountConfig;
    routeKey: string;
    replyContextToken?: string;
  }): string | undefined {
    if (!input.replyContextToken || input.account.replyToMode === "off") return undefined;
    if (input.account.replyToMode === "all") return input.replyContextToken;
    const key = `${input.routeKey}:${input.replyContextToken}`;
    if (this.replyQuoteSent.has(key)) return undefined;
    this.replyQuoteSent.add(key);
    return input.replyContextToken;
  }

  /** Test/diagnostic helper. */
  getReplyQuoteCacheSizeForTests(): number {
    return this.replyQuoteSent.size();
  }

  private async sendTextChunks(input: {
    account: YuanbaoResolvedAccountConfig;
    chatType: "direct" | "group";
    target: string;
    text: string;
    replyContextToken?: string;
    /** Scheduled sends use a creation-time quote snapshot that may be stale; retry once without it. */
    retryWithoutReplyContextOnError?: boolean;
  }): Promise<void> {
    if (!this.gateway) throw new Error("YuanbaoChannel.start() must be called before delivery");
    const routeKey = buildYuanbaoChatKey(input.account.accountId, input.chatType, input.target);
    const chunks = this.splitText(input.account, input.text);
    for (const chunk of chunks) {
      if (this.isAborted()) return;
      const replyContextToken = this.resolveReplyContextToken({
        account: input.account,
        routeKey,
        replyContextToken: input.replyContextToken,
      });
      try {
        await this.gateway.sendText({
          account: input.account,
          chatType: input.chatType,
          target: input.target,
          text: chunk,
          replyContextToken,
        });
      } catch (error) {
        if (input.retryWithoutReplyContextOnError && replyContextToken) {
          await this.gateway.sendText({
            account: input.account,
            chatType: input.chatType,
            target: input.target,
            text: chunk,
          });
          continue;
        }
        throw error;
      }
    }
  }

  private createReplyHeartbeat(input: {
    account: YuanbaoResolvedAccountConfig;
    chatType: "direct" | "group";
    target: string;
    originalSenderAccount: string;
  }): { start: () => void; finish: () => void; stop: () => void } {
    let timer: ReturnType<typeof setInterval> | undefined;
    let started = false;
    const sendTime = Date.now();

    const send = (heartbeat: 1 | 2): void => {
      if (!this.gateway?.sendReplyHeartbeat) return;
      void this.gateway.sendReplyHeartbeat({
        account: input.account,
        chatType: input.chatType,
        target: input.target,
        originalSenderAccount: input.originalSenderAccount,
        heartbeat,
        sendTime,
      }).catch((error) => {
        void this.logger?.info("yuanbao.reply_heartbeat.failed", "failed to send yuanbao reply heartbeat", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };

    const stop = (): void => {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      started = false;
    };

    return {
      start: () => {
        if (started) return;
        started = true;
        send(REPLY_HEARTBEAT_RUNNING);
        timer = setInterval(() => send(REPLY_HEARTBEAT_RUNNING), REPLY_HEARTBEAT_INTERVAL_MS);
      },
      finish: () => {
        const wasStarted = started;
        stop();
        if (wasStarted) send(REPLY_HEARTBEAT_FINISH);
      },
      stop,
    };
  }

  private async handleInboundMessage(input: YuanbaoGatewayInboundMessage): Promise<void> {
    if (!this.agent || !this.quota || !this.logger || !this.gateway) {
      throw new Error("YuanbaoChannel.start() must initialize runtime before handling messages");
    }
    const account = this.accountById(input.accountId);
    if (!account || !account.enabled || !account.configured) return;
    const raw = input.raw;
    if (raw.callback_command && !raw.callback_command.endsWith("CallbackAfterSendMsg")) return;
    const fromAccount = raw.from_account?.trim();
    if (!fromAccount) return;
    if (input.isFromSelf || (account.botId && fromAccount === account.botId)) return;

    const target = input.chatType === "group" ? raw.group_code?.trim() : fromAccount;
    if (!target) return;

    const extracted = extractYuanbaoContent(raw.msg_body, account.botId);
    const quote = parseQuoteFromCloudCustomData(raw.cloud_custom_data);
    const replyToBot = isQuoteRepliedToBot(quote, account.botId);
    const isAtBot = (input.isAtBot ?? extracted.isAtBot) || replyToBot;
    const hasMedia = extracted.mediaCandidates.length > 0;
    if (!extracted.text.trim() && !hasMedia) return;
    const knownCommand = this.agent.isKnownCommand?.(extracted.text) ?? false;
    const addressed = isAtBot || knownCommand || input.chatType === "direct" || !account.requireMention;

    const chatKey = buildYuanbaoChatKey(account.accountId, input.chatType, target);
    const messageId = raw.msg_id || raw.msg_key || (raw.msg_seq !== undefined ? String(raw.msg_seq) : undefined);

    if (input.chatType === "group" && !addressed) {
      if (account.historyLimit > 0) {
        const ts = typeof raw.msg_time === "number" && raw.msg_time > 0
          ? raw.msg_time * 1000
          : Date.now();
        const entry: import("./group-history.js").GroupHistoryEntry = {
          senderId: fromAccount,
          text: extracted.text,
          timestamp: ts,
          ...(raw.sender_nickname ? { senderName: raw.sender_nickname } : {}),
          ...(messageId ? { messageId } : {}),
        };
        this.groupHistory.record(account.accountId, target, entry);
      }
      return;
    }

    if (messageId && !this.dedup.tryRecord(messageId, chatKey)) {
      await this.logger.info("yuanbao.message.duplicate", "skipping duplicate yuanbao message", { messageId, chatKey });
      return;
    }

    if (this.isAborted()) return;

    const history = input.chatType === "group" && account.historyLimit > 0
      ? this.groupHistory.consume(account.accountId, target)
      : [];

    const downloaded = await this.downloadInboundCandidates({
      account,
      chatKey,
      messageId: messageId ?? "",
      candidates: extracted.mediaCandidates,
    });
    const promptText = buildPromptText({
      history,
      quote,
      replyToBot,
      message: extracted.text,
      unavailable: downloaded.failed,
    });

    // Dispatch-time session binding. Capture the chat's current session the
    // moment the message arrives; the prompt runs against that session even if
    // the user switches away while it waits on its per-session lane. Slash
    // commands never bind — they act on whatever the chat resolves to when they
    // run, and switch/cancel commands take the control lane so they preempt a
    // running prompt for real-time switching.
    const isSlash = extracted.text.trim().startsWith("/");
    const boundAlias = isSlash ? undefined : (this.sessions?.peekCurrentSessionAlias(chatKey) ?? undefined);
    const sessionKey = boundAlias ?? "__chat__";
    const lane = resolveTurnLane(extracted.text);
    // Foreground predicate, evaluated at SEND time: a turn is foreground only
    // while its bound session is still the chat's current session. A turn that
    // gets switched away mid-flight stops delivering to the chat.
    const isForeground = boundAlias
      ? () => this.sessions?.peekCurrentSessionAlias(chatKey) === boundAlias
      : undefined;
    const inForeground = (): boolean => (isForeground ? isForeground() : true);

    if (boundAlias) this.activeTurns?.markActive(chatKey, boundAlias);

    try {
      await this.executor.run(chatKey, lane, async () => {
        if (!this.agent || !this.quota || !this.gateway || !this.logger) return;
        if (this.isAborted()) return;
        this.quota.onInbound(chatKey);
        const heartbeat = this.createReplyHeartbeat({
          account,
          chatType: input.chatType,
          target,
          originalSenderAccount: fromAccount,
        });
        const queue = this.createTurnQueue({
          account,
          chatType: input.chatType,
          target,
          replyContextToken: messageId,
        });
        try {
          heartbeat.start();
          const subagentNotices = new SubagentNoticeTracker();
          const response = await this.agent.chat({
            accountId: account.accountId,
            conversationId: chatKey,
            text: promptText,
            replyContextToken: messageId,
            ...(this.abortSignal ? { abortSignal: this.abortSignal } : {}),
            ...(downloaded.media.length > 0 ? { media: downloaded.media } : {}),
            metadata: {
              channel: "yuanbao",
              chatType: input.chatType,
              senderId: fromAccount,
              ...(raw.sender_nickname ? { senderName: raw.sender_nickname } : {}),
              ...(input.chatType === "group" ? { groupId: target } : {}),
              isOwner: Boolean(raw.bot_owner_id && raw.from_account === raw.bot_owner_id),
              ...(boundAlias ? { boundSessionAlias: boundAlias } : {}),
            },
            // Text-only degradation: no card, so a delegation surfaces as one
            // honest line. Ordinary tool calls stay hidden to avoid flooding
            // the chat; the tracker dedups start/terminal per toolCallId.
            onToolEvent: (event) => {
              if (this.isAborted() || !inForeground()) return;
              const line = subagentNotices.notice(event);
              if (line) void queue.push(line);
            },
            reply: async (text) => {
              if (this.isAborted()) return;
              // Backgrounded mid-stream output is dropped — the user switched
              // away, so it must not leak into whatever session now occupies
              // the chat. The final answer is stored for /use replay below.
              if (!inForeground()) return;
              await queue.push(text);
            },
          });

          if (this.isAborted()) {
            queue.abort();
            return;
          }

          const responseText = response.text ?? "";

          // A-semantics for a linear-text channel (the weixin model): if the
          // bound session is no longer the chat's foreground session, this turn
          // ran in the background. Store its final text so `/use <alias>`
          // replays it on switch-back, send a short completion ping, and never
          // push the answer into the now-foreground chat.
          if (boundAlias && this.sessions && !inForeground()) {
            queue.abort();
            await this.sessions.setBackgroundResult(chatKey, boundAlias, {
              text: responseText.trim(),
              status: "done",
              finished_at: new Date().toISOString(),
            });
            await this.sendBackgroundCompletionNotice({
              account,
              chatType: input.chatType,
              target,
              boundAlias,
              status: "done",
            });
            heartbeat.stop();
            return;
          }

          if (responseText) await queue.push(responseText);
          const flushed = await queue.flush();
          let sentContent = flushed.sentContent;

          if (!sentContent && account.fallbackReply.trim() && !this.isAborted()) {
            const fallbackQueue = this.createTurnQueue({
              account,
              chatType: input.chatType,
              target,
              replyContextToken: messageId,
              forceStrategy: "immediate",
            });
            try {
              await fallbackQueue.push(account.fallbackReply);
              const r = await fallbackQueue.flush();
              sentContent = r.sentContent;
            } catch (error) {
              await this.logger.error("yuanbao.fallback.failed", "failed to send yuanbao fallback reply", {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }

          const media = normalizeMediaArray(response.media);
          if (media.length > 0) {
            await this.logger.error("yuanbao.media.unsupported", "yuanbao outbound media is not supported by the current gateway adapter", { count: media.length });
          }

          if (sentContent) heartbeat.finish();
          else heartbeat.stop();
        } catch (error) {
          queue.abort();
          heartbeat.stop();
          // A shutdown abort surfaced as a thrown rejection is not a turn
          // failure: don't record a background error or ping the user, and
          // don't rethrow the abort noise. (Mirrors the post-await isAborted
          // check above; weixin guards the same case with isAbortError.)
          if (this.isAborted()) return;
          // A backgrounded turn that errored records its failure for switch-back
          // + pings instead of throwing into the void (no foreground chat is
          // listening for it anymore).
          if (boundAlias && this.sessions && !inForeground()) {
            const message = error instanceof Error ? error.message : String(error);
            await this.sessions.setBackgroundResult(chatKey, boundAlias, {
              text: t().executionError(message),
              status: "error",
              finished_at: new Date().toISOString(),
            });
            await this.sendBackgroundCompletionNotice({
              account,
              chatType: input.chatType,
              target,
              boundAlias,
              status: "error",
            }).catch(() => {});
            return;
          }
          throw error;
        }
      }, sessionKey);
    } finally {
      // Mirror the markActive above regardless of outcome.
      if (boundAlias) this.activeTurns?.markInactive(chatKey, boundAlias);
    }
  }

  private async sendBackgroundCompletionNotice(input: {
    account: YuanbaoResolvedAccountConfig;
    chatType: "direct" | "group";
    target: string;
    boundAlias: string;
    status: "done" | "error";
  }): Promise<void> {
    try {
      await this.sendTextChunks({
        account: input.account,
        chatType: input.chatType,
        target: input.target,
        text: buildYuanbaoCompletionNotice(input.boundAlias, input.status),
      });
    } catch (error) {
      await this.logger?.error("yuanbao.bg_notice.failed", "failed to send background completion notice", {
        target: input.target,
        boundAlias: input.boundAlias,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private createTurnQueue(input: {
    account: YuanbaoResolvedAccountConfig;
    chatType: "direct" | "group";
    target: string;
    replyContextToken?: string;
    forceStrategy?: OutboundQueueStrategy;
    /** Scheduled sends use a creation-time quote snapshot that may be stale; retry once without it. */
    retryWithoutReplyContextOnError?: boolean;
  }): ReturnType<typeof createOutboundQueueSession> {
    const account = input.account;
    const routeKey = buildYuanbaoChatKey(account.accountId, input.chatType, input.target);
    const strategy: OutboundQueueStrategy =
      input.forceStrategy
      ?? (account.disableBlockStreaming ? "merge-on-flush" : account.outboundQueueStrategy);
    return createOutboundQueueSession({
      strategy,
      minChars: account.minChars,
      maxChars: account.maxChars,
      idleMs: account.idleMs,
      isAborted: () => this.isAborted(),
      ...(this.deps.outboundSchedule ? { schedule: this.deps.outboundSchedule } : {}),
      chunkText: (text, maxChars) => {
        if (account.overflowPolicy === "stop" && text.length > maxChars) {
          throw new Error(`Yuanbao outbound text exceeds channel.options.maxChars (${maxChars})`);
        }
        return chunkMarkdownAware(text, maxChars);
      },
      sendText: async (text) => {
        if (!this.gateway) throw new Error("YuanbaoChannel.start() must be called before delivery");
        const replyContextToken = this.resolveReplyContextToken({
          account,
          routeKey,
          replyContextToken: input.replyContextToken,
        });
        try {
          await this.gateway.sendText({
            account,
            chatType: input.chatType,
            target: input.target,
            text,
            replyContextToken,
          });
        } catch (error) {
          if (input.retryWithoutReplyContextOnError && replyContextToken) {
            await this.gateway.sendText({
              account,
              chatType: input.chatType,
              target: input.target,
              text,
            });
            return;
          }
          throw error;
        }
      },
    });
  }

  private async downloadInboundCandidates(input: {
    account: YuanbaoResolvedAccountConfig;
    chatKey: string;
    messageId: string;
    candidates: import("./inbound.js").YuanbaoInboundMediaCandidate[];
  }): Promise<{ media: ChannelMediaAttachment[]; failed: string[] }> {
    const failed: string[] = [];
    if (input.candidates.length === 0) return { media: [], failed };
    const store = this.deps.mediaStore ?? new RuntimeMediaStore({ rootDir: path.join(process.cwd(), ".weacpx-media") });
    const maxBytes = Math.max(1, Math.floor(input.account.mediaMaxMb * 1024 * 1024));
    const fetchImpl = this.deps.fetchInboundMedia;
    const media: ChannelMediaAttachment[] = [];

    const slice = input.candidates.slice(0, DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE);
    for (const candidate of slice) {
      if (this.isAborted()) break;
      if (typeof candidate.sizeHint === "number" && candidate.sizeHint > maxBytes) {
        failed.push(`[attachment unavailable: ${candidate.kind} too large (${candidate.sizeHint} > ${maxBytes} bytes)]`);
        continue;
      }
      try {
        const downloaded = await downloadInboundYuanbaoMedia({
          url: candidate.url,
          maxBytes,
          ...(fetchImpl ? { fetch: fetchImpl } : {}),
          ...(this.abortSignal ? { signal: this.abortSignal } : {}),
        });
        const fileName = candidate.fileName
          ?? (candidate.kind === "image" ? defaultImageFileName(downloaded.contentType, candidate.url) : "attachment.bin");
        const saved = await store.saveMediaBuffer({
          channelId: "yuanbao",
          accountId: input.account.accountId,
          chatKey: input.chatKey,
          messageId: input.messageId || "unknown",
          fileName,
          mimeType: downloaded.contentType,
          kind: candidate.kind,
          buffer: downloaded.buffer,
          ...(candidate.sourceId ? { sourceResourceId: candidate.sourceId } : {}),
          maxBytes,
        });
        media.push(saved);
      } catch (error) {
        await this.logger?.info("yuanbao.inbound.media_failed", "failed to download inbound yuanbao media", {
          kind: candidate.kind,
          url: candidate.url,
          message: error instanceof Error ? error.message : String(error),
        });
        failed.push(`[attachment unavailable: ${candidate.kind}]`);
      }
    }
    for (let i = slice.length; i < input.candidates.length; i++) {
      failed.push(`[attachment unavailable: ${input.candidates[i]!.kind} exceeded per-message attachment cap]`);
    }
    return { media, failed };
  }
}

interface BuildPromptInput {
  history: import("./group-history.js").GroupHistoryEntry[];
  quote: import("./quote.js").YuanbaoQuoteInfo | undefined;
  replyToBot: boolean;
  message: string;
  /** Placeholders for media candidates whose download failed. */
  unavailable: string[];
}

function buildPromptText(input: BuildPromptInput): string {
  const parts: string[] = [];
  const history = formatGroupHistoryContext(input.history);
  if (history) parts.push(history);
  // Suppress the quote block when the quoted message is the bot's own reply
  // (chat-key conversation history already carries that turn), but keep it
  // when someone quotes a user message — that's new context for the agent.
  if (input.quote && !input.replyToBot) parts.push(formatQuoteContext(input.quote));
  const message = input.unavailable.length > 0
    ? [input.message, ...input.unavailable].filter((p) => p.length > 0).join("\n")
    : input.message;
  parts.push(message);
  return parts.join("\n\n");
}
