import path from "node:path";
import { createConversationExecutor, resolveTurnLane, toDisplaySessionAlias } from "xacpx/plugin-api";
import type {
  ChannelStartInput,
  ConversationExecutor,
  SessionService,
  ActiveTurnRegistry,
  CoordinatorMessageInput,
  CreateChannelDeps,
  ScheduledChannelMessageInput,
  MessageChannelRuntime,
  OrchestrationDeliveryCallbacks,
} from "xacpx/plugin-api";
import type { FeishuChannelConfig, FeishuResolvedAccountConfig } from "./config.js";
import { parseFeishuChannelConfig } from "./config.js";
import type { FeishuMessageEvent, FeishuResourceDescriptor } from "./types.js";
import { createFeishuLarkClient, type FeishuLarkClient } from "./lark-client.js";
import { MessageDedup } from "./message-dedup.js";
import { buildFeishuQueueKey, clearFeishuQueueForAccount } from "./chat-queue.js";
import { buildFeishuCompletionNotice } from "./completion-notice.js";
import { buildFeishuConversationId, buildFeishuRouteMetadata, evaluateFeishuAccessPolicy, parseFeishuConversationId, shouldHandleFeishuMessage } from "./inbound.js";
import { isMessageExpired } from "./message-dedup.js";
import { sendTextFeishu, sendMediaFeishu } from "./send.js";
import { addTypingIndicator, removeTypingIndicator, type FeishuReactionClient, type TypingIndicatorState } from "./typing.js";
import { extractRawTextFromFeishuEvent, isLikelyAbortText } from "./abort-detect.js";
import { clearMessageUnavailableForAccount, isMessageUnavailable, markIfUnavailableError } from "./message-unavailable.js";
import { PermissionNotifier, extractPermissionError, formatPermissionNotice } from "./permission-error.js";
import { t as getMessages, setChannelLocale } from "./i18n/index.js";
import { StreamingCardController, type StreamingCardClient } from "./card/streaming-card-controller.js";
import { RuntimeMediaStore, DEFAULT_ATTACHMENT_MAX_BYTES, DEFAULT_IMAGE_MAX_BYTES, DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE } from "./media-store.js";
import { resolveSafeOutboundMediaPath } from "./outbound-media-safety.js";
import { normalizeMediaArray, type ChannelMediaAttachment } from "./media-types.js";
import { convertFeishuMessageContent } from "./content-converters.js";
import { downloadFeishuMessageResource } from "./media.js";

type OrchestrationTaskRecord = Parameters<MessageChannelRuntime["notifyTaskCompletion"]>[0];

interface FeishuChannelDeps extends CreateChannelDeps {
  createClient?: (account: FeishuResolvedAccountConfig) => FeishuLarkClient;
}

interface AccountRuntime {
  account: FeishuResolvedAccountConfig;
  client: FeishuLarkClient;
  botOpenId?: string;
}

interface ActiveTask {
  accountId: string;
  chatId: string;
  messageId: string;
  // Open ID of the user who triggered this turn. Used to authorize abort —
  // only the originator (or, in DMs, the only conversation participant) may
  // stop a turn, preventing one user in a shared group from cancelling
  // another's running task.
  senderOpenId: string | undefined;
  chatType: string | undefined;
  // INTERNAL session alias this turn was dispatch-bound to (undefined for slash
  // commands or when the sessions service is unavailable). Lets a later
  // `/cancel <alias>` target this in-flight turn and lets completion tracking
  // attribute the turn to its session.
  boundAlias: string | undefined;
  typingState: TypingIndicatorState;
  abortController: AbortController;
  suppressed: boolean;
  cardController: StreamingCardController | null;
}

export class FeishuChannel implements MessageChannelRuntime {
  readonly id = "feishu";
  private readonly accounts: Map<string, AccountRuntime> = new Map();
  private dedup: MessageDedup;
  private markDelivered: OrchestrationDeliveryCallbacks["markTaskNoticeDelivered"] | null = null;
  private markFailed: OrchestrationDeliveryCallbacks["markTaskNoticeFailed"] | null = null;
  private agent: ChannelStartInput["agent"] | null = null;
  private quota: ChannelStartInput["quota"] | null = null;
  private logger: ChannelStartInput["logger"] | null = null;
  private sessions: SessionService | null = null;
  private activeTurns: ActiveTurnRegistry | null = null;
  private readonly executor: ConversationExecutor = createConversationExecutor();
  // Stack per chat: when a second turn races into the queue before the first
  // body runs, both are tracked so an inbound stop message can suppress all
  // pending entries. Push on registration, splice on cleanup.
  private readonly activeTasks: Map<string, ActiveTask[]> = new Map();
  private readonly permissionNotifier: PermissionNotifier;

  private readonly config: FeishuChannelConfig;

  constructor(
    options: Record<string, unknown> | undefined,
    private readonly deps: FeishuChannelDeps = {},
  ) {
    this.config = parseFeishuChannelConfig(options);
    this.dedup = new MessageDedup({ ttlMs: this.config.dedupTtlMs, maxEntries: this.config.dedupMaxEntries });
    this.permissionNotifier = new PermissionNotifier(this.config.tuning.permissionNotifyCooldownMs);
  }

  isLoggedIn(): boolean {
    return this.config.accounts.some((account) => account.enabled && account.configured);
  }

  async login(): Promise<string> {
    if (this.isLoggedIn()) return "feishu credentials configured";
    throw new Error("Feishu uses channel.options.appId and channel.options.appSecret; configure them instead of QR login.");
  }

  logout(): void {
    for (const [accountId, runtime] of this.accounts) {
      runtime.client.stop();
      clearMessageUnavailableForAccount(accountId);
      clearFeishuQueueForAccount(accountId);
    }
    this.accounts.clear();
    this.permissionNotifier.reset();
    this.dedup.dispose();
  }

  configureOrchestration(callbacks: OrchestrationDeliveryCallbacks): void {
    this.markDelivered = callbacks.markTaskNoticeDelivered;
    this.markFailed = callbacks.markTaskNoticeFailed;
  }

  async start(input: ChannelStartInput): Promise<void> {
    // Pin the channel's locale from the daemon-provided value before producing
    // any output. The plugin bundle's getLocale() can't see the daemon's
    // setLocale(), so input.locale is the only instance-independent source.
    setChannelLocale(input.locale ?? "en");
    this.agent = input.agent;
    this.quota = input.quota;
    this.logger = input.logger;
    this.sessions = input.sessions ?? null;
    this.activeTurns = input.activeTurns ?? null;

    const eligible = this.config.accounts.filter((account) => account.enabled && account.configured);
    await input.logger.info("feishu.start", "starting feishu channel", {
      accountCount: eligible.length,
      accounts: eligible.map((account) => account.accountId),
    });

    const startups = eligible.map(async (account) => {
      const client = this.deps.createClient?.(account) ?? createFeishuLarkClient({
        appId: account.appId,
        appSecret: account.appSecret,
        domain: account.domain,
      });
      const probe = await client.probeBot().catch((error) => {
        void input.logger.error("feishu.probe_failed", "failed to probe feishu bot identity", {
          accountId: account.accountId,
          message: error instanceof Error ? error.message : String(error),
        });
        return {} as { botOpenId?: string; botName?: string };
      });
      const runtime: AccountRuntime = { account, client, ...(probe.botOpenId ? { botOpenId: probe.botOpenId } : {}) };
      this.accounts.set(account.accountId, runtime);
      await client.startWS({
        handlers: {
          "im.message.receive_v1": (data) => this.handleMessageEvent(account.accountId, data),
        },
        abortSignal: input.abortSignal,
      });
    });

    await Promise.all(startups);
  }

  async notifyTaskCompletion(task: OrchestrationTaskRecord): Promise<void> {
    if (!task.chatKey) return;
    try {
      await this.sendRouteText(task.chatKey, task.replyContextToken, task.resultText || task.summary || getMessages().taskCompleted);
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
    if (!task.chatKey) return;
    await this.sendRouteText(task.chatKey, task.replyContextToken, text);
  }

  async sendCoordinatorMessage(input: CoordinatorMessageInput): Promise<void> {
    await this.sendRouteText(input.chatKey, input.replyContextToken, input.text);
  }

  async sendScheduledMessage(input: ScheduledChannelMessageInput): Promise<void> {
    if (!this.agent || !this.logger) {
      throw new Error("FeishuChannel.start() must be called before scheduled message delivery");
    }
    const route = parseFeishuConversationId(input.chatKey);
    if (!route) throw new Error(`cannot deliver Feishu scheduled message to non-Feishu chatKey: ${input.chatKey}`);
    if (input.accountId && input.accountId !== route.accountId) {
      throw new Error(`scheduled Feishu accountId "${input.accountId}" does not match chatKey account "${route.accountId}"`);
    }
    const runtime = this.accounts.get(route.accountId);
    if (!runtime) {
      throw new Error(`feishu account "${route.accountId}" is not started; check channel.options.accounts and enabled flags`);
    }

    const deliverText = async (text: string | undefined): Promise<void> => {
      if (input.abortSignal?.aborted) return;
      const trimmed = text?.trim() ?? "";
      if (trimmed.length === 0) return;
      await this.sendRouteText(input.chatKey, input.replyContextToken, trimmed);
    };

    // The trigger notice stays a plain-text message so the user always sees the
    // task fired, even when the agent turn renders into an interactive card.
    await this.sendRouteText(input.chatKey, input.replyContextToken, input.noticeText);

    // Mirror normal-message rendering: drive a streaming card when the account
    // is in streaming mode. Scheduled turns carry no chatType, so "auto" resolves
    // to streaming; static accounts (and card seed failures) fall back to plain text.
    const effectiveReplyMode = resolveEffectiveReplyMode(runtime.account.replyMode, undefined);
    const cardController = effectiveReplyMode === "streaming"
      ? await this.trySeedStreamingCard({
          runtime,
          accountId: route.accountId,
          chatId: route.chatId,
          ...(input.replyContextToken ? { replyToMessageId: input.replyContextToken } : {}),
        })
      : null;

    const deliverReply = async (text: string): Promise<void> => {
      if (input.abortSignal?.aborted) return;
      if (cardController) {
        cardController.appendStream(text);
        return;
      }
      await deliverText(text);
    };

    try {
      const response = await this.agent.chat({
        accountId: route.accountId,
        conversationId: input.chatKey,
        text: input.promptText,
        ...(input.replyContextToken ? { replyContextToken: input.replyContextToken } : {}),
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        metadata: { channel: "feishu", scheduledSessionAlias: input.sessionAlias },
        reply: deliverReply,
        ...(cardController ? {
          onToolEvent: (event) => {
            if (input.abortSignal?.aborted) return;
            cardController.recordToolEvent(event);
          },
          onThought: (chunk) => {
            if (input.abortSignal?.aborted) return;
            cardController.appendReasoning(chunk);
          },
          onPlan: (entries) => {
            if (input.abortSignal?.aborted) return;
            cardController.recordPlan(entries);
          },
          onUsage: (usage) => {
            if (input.abortSignal?.aborted) return;
            cardController.recordUsage(usage);
          },
        } : {}),
      });

      if (input.abortSignal?.aborted) {
        if (cardController && !cardController.isTerminated()) {
          await cardController.abort(getMessages().abortAck).catch(() => {});
        }
        return;
      }

      const media = normalizeMediaArray(response.media);
      if (media.length > 0) {
        await this.logger.error("feishu.scheduled.media_unsupported", "scheduled feishu media responses are not supported", {
          accountId: route.accountId,
          chatKey: input.chatKey,
          taskId: input.taskId,
          sessionAlias: input.sessionAlias,
          count: media.length,
        });
      }

      if (cardController) {
        const responseText = response.text?.trim() ?? "";
        await cardController.complete(responseText.length > 0 ? response.text : undefined);
        // If the card subsystem degraded mid-turn, deliver the answer as plain text.
        if (cardController.isDegraded() && responseText.length > 0) {
          await deliverText(response.text);
        }
      } else {
        await deliverText(response.text);
      }
    } catch (error) {
      if (cardController && !cardController.isTerminated()) {
        await cardController.fail(error instanceof Error ? error.message : String(error)).catch(() => {});
      } else {
        try {
          await deliverText(formatScheduledFailureText(input, error));
        } catch {
          // Best-effort failure notice only; preserve the agent error for scheduler handling.
        }
      }
      throw error;
    }
  }

  private async sendRouteText(chatKey: string, replyContextToken: string | undefined, text: string): Promise<void> {
    const route = parseFeishuConversationId(chatKey);
    if (!route) throw new Error(`cannot deliver Feishu message to non-Feishu chatKey: ${chatKey}`);
    const runtime = this.accounts.get(route.accountId);
    if (!runtime) throw new Error(`feishu account "${route.accountId}" is not started; check channel.options.accounts and enabled flags`);
    const replyTarget = replyContextToken && !isMessageUnavailable(replyContextToken, route.accountId) ? replyContextToken : undefined;
    try {
      await sendTextFeishu({ client: runtime.client.sdk, to: route.chatId, text, replyToMessageId: replyTarget });
    } catch (error) {
      if (replyTarget && markIfUnavailableError(replyTarget, error, route.accountId)) {
        await sendTextFeishu({ client: runtime.client.sdk, to: route.chatId, text });
        return;
      }
      if (await this.maybeNotifyPermissionError({ runtime, chatId: route.chatId, error })) return;
      throw error;
    }
  }

  private async handleMessageEvent(accountId: string, data: unknown): Promise<void> {
    const runtime = this.accounts.get(accountId);
    if (!runtime || !this.agent || !this.quota || !this.logger) {
      throw new Error("FeishuChannel.start() must initialize runtime before handling messages");
    }
    const event = data as FeishuMessageEvent;
    const messageId = event.message?.message_id;
    const chatId = event.message?.chat_id;
    if (!messageId || !chatId) return;

    if (!this.dedup.tryRecord(messageId, accountId)) {
      await this.logger.info("feishu.message.duplicate", "skipping duplicate feishu message", { messageId, accountId });
      return;
    }
    if (isMessageExpired(event.message.create_time)) {
      await this.logger.info("feishu.message.expired", "skipping expired feishu message", { messageId, accountId });
      return;
    }

    const policy = evaluateFeishuAccessPolicy({ event, account: runtime.account });
    if (!policy.allow) {
      await this.logger.info("feishu.message.policy_denied", "feishu message blocked by access policy", {
        accountId,
        messageId,
        chatId,
        chatType: event.message.chat_type,
        senderOpenId: event.sender?.sender_id?.open_id,
        reason: policy.reason,
      });
      return;
    }

    const threadId = event.message.thread_id || event.message.root_id || undefined;
    const chatKey = buildFeishuConversationId(accountId, chatId, threadId);
    const queueKey = buildFeishuQueueKey(accountId, chatId, threadId);

    if (await this.tryHandleAbortTrigger({ event, runtime, queueKey, accountId, chatId, messageId })) {
      return;
    }

    const converted = await convertFeishuMessageContent({
      messageType: event.message.message_type,
      content: event.message.content,
      messageId,
      mentions: event.message.mentions,
      botOpenId: runtime.botOpenId,
      stripBotMentions: runtime.account.requireMention,
    });
    const decision = shouldHandleFeishuMessage({
      event,
      botOpenId: runtime.botOpenId,
      requireMention: runtime.account.requireMention,
      parsedText: converted.text,
      allowMediaOnly: converted.resources.length > 0,
    });
    if (!decision.handle) return;

    this.quota.onInbound(chatKey);

    const { media, skipped } = await this.downloadInboundAttachments({
      runtime,
      accountId,
      chatKey,
      messageId,
      resources: converted.resources,
      initialSkipped: converted.skippedNotes,
    });
    const requestText = appendSkippedAttachmentNotes(decision.text, skipped);

    // Dispatch-time session binding. Capture the chat's current session the
    // moment the message arrives; the prompt then runs against that session even
    // if the user switches away while it waits on its per-session lane. Slash
    // commands never bind — they act on whatever the chat resolves to when they
    // run (and switch/cancel commands take the control lane so they preempt a
    // running prompt for real-time switching).
    const isSlash = requestText.trim().startsWith("/");
    const boundAlias = isSlash ? undefined : (this.sessions?.peekCurrentSessionAlias(chatKey) ?? undefined);
    const lane = resolveTurnLane(requestText);

    const { active, abortController } = this.registerActiveTask({
      accountId,
      chatId,
      messageId,
      queueKey,
      senderOpenId: event.sender?.sender_id?.open_id,
      chatType: event.message.chat_type,
      boundAlias,
    });

    if (boundAlias) this.activeTurns?.markActive(chatKey, boundAlias);

    await this.executor.run(
      chatKey,
      lane,
      () => this.runTurn({
        runtime,
        accountId,
        chatId,
        chatType: event.message.chat_type,
        chatKey,
        queueKey,
        messageId,
        requestText,
        media,
        active,
        abortController,
        boundAlias,
      }),
      boundAlias,
    );
  }

  /**
   * Detect a stop-word inbound and short-circuit to the abort fast-path.
   * Returns true if the message was handled as an abort (caller should
   * stop processing), false if the message should continue down the
   * normal handling path.
   *
   * Authorization:
   * - In a group with `requireMention`, the abort word must be addressed
   *   to the bot. Without this, anyone in the group can drop "stop" and
   *   cancel another user's turn.
   * - The sender must own at least one live task in this chat/thread —
   *   you can only stop your own work.
   */
  private async tryHandleAbortTrigger(input: {
    event: FeishuMessageEvent;
    runtime: AccountRuntime;
    queueKey: string;
    accountId: string;
    chatId: string;
    messageId: string;
  }): Promise<boolean> {
    const { event, runtime, queueKey, accountId, chatId, messageId } = input;
    const rawText = extractRawTextFromFeishuEvent(event);
    if (!rawText || !isLikelyAbortText(rawText)) return false;

    const isGroup = event.message.chat_type === "group";
    if (isGroup && runtime.account.requireMention) {
      const mentioned = event.message.mentions?.some(
        (m) => runtime.botOpenId !== undefined && m.id.open_id === runtime.botOpenId,
      );
      if (!mentioned) return false;
    }

    const senderOpenId = event.sender?.sender_id?.open_id;
    const stack = this.activeTasks.get(queueKey);
    const liveTasks = stack?.filter((t) => !t.suppressed) ?? [];
    // Only the task's originator may stop it. In DMs there's only one
    // participant; in groups this prevents cross-user cancellation. If
    // senderOpenId is missing on either side, refuse rather than allow.
    const owned = liveTasks.filter(
      (t) => senderOpenId !== undefined && t.senderOpenId === senderOpenId,
    );
    if (owned.length > 0) {
      await this.handleAbortFastPath({
        runtime,
        activeTasks: owned,
        abortRequestMessageId: messageId,
        chatId,
        accountId,
      });
      return true;
    }
    if (liveTasks.length > 0) {
      // Stop arrived from a different user — log and fall through so the
      // message is handled as a normal turn (agent decides what it means).
      await this.logger!.info(
        "feishu.abort.unauthorized",
        "abort trigger from non-owner; falling through",
        { accountId, chatId, messageId, senderOpenId, activeCount: liveTasks.length },
      );
      return false;
    }
    await this.logger!.info(
      "feishu.abort.no_active",
      "abort trigger received but no active task",
      { accountId, chatId, messageId },
    );
    return false;
  }

  /**
   * Pre-register the active task BEFORE the chat-queue body runs so an
   * abort message arriving while the turn is queued can still find it and
   * mark it suppressed.
   */
  private registerActiveTask(input: {
    accountId: string;
    chatId: string;
    messageId: string;
    queueKey: string;
    senderOpenId: string | undefined;
    chatType: string | undefined;
    boundAlias: string | undefined;
  }): { active: ActiveTask; abortController: AbortController } {
    const { accountId, chatId, messageId, queueKey, senderOpenId, chatType, boundAlias } = input;
    const abortController = new AbortController();
    const active: ActiveTask = {
      accountId,
      chatId,
      messageId,
      senderOpenId,
      chatType,
      boundAlias,
      typingState: { messageId, reactionId: null },
      abortController,
      suppressed: false,
      cardController: null,
    };
    const stack = this.activeTasks.get(queueKey) ?? [];
    stack.push(active);
    this.activeTasks.set(queueKey, stack);
    return { active, abortController };
  }

  private async sendBackgroundCompletionNotice(input: {
    runtime: AccountRuntime;
    chatId: string;
    messageId: string;
    boundAlias: string;
    status: "done" | "error";
  }): Promise<void> {
    const text = buildFeishuCompletionNotice(toDisplaySessionAlias(input.boundAlias), input.status);
    try {
      await this.sendReplyWithGuard({
        runtime: input.runtime,
        chatId: input.chatId,
        replyToMessageId: input.messageId,
        text,
      });
    } catch (error) {
      await this.logger?.error("feishu.bg_notice.failed", "failed to send background completion notice", {
        chatId: input.chatId,
        boundAlias: input.boundAlias,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async runTurn(input: {
    runtime: AccountRuntime;
    accountId: string;
    chatId: string;
    chatType: string | undefined;
    chatKey: string;
    queueKey: string;
    messageId: string;
    requestText: string;
    media: ChannelMediaAttachment[];
    active: ActiveTask;
    abortController: AbortController;
    boundAlias: string | undefined;
  }): Promise<void> {
    const { runtime, accountId, chatId, chatType, chatKey, queueKey, messageId, requestText, media, active, abortController, boundAlias } = input;
    // "skipped" is the initial state: a turn that early-returns (no agent, or
    // suppressed/aborted before it produced output) NEVER ran, so it must not
    // be recorded as a completion. Only a real outcome flips this to done/error.
    let turnStatus: "done" | "error" | "skipped" = "skipped";
    try {
      if (!this.agent) return;
      if (active.suppressed) return;
      active.typingState = await addTypingIndicator({
        client: runtime.client.sdk as unknown as FeishuReactionClient,
        messageId,
        accountId,
      });
      if (active.suppressed) return;

      // Try to set up streaming card if the account opted in. Any failure
      // (permission, SDK missing CardKit, network) falls back to static.
      const effectiveReplyMode = resolveEffectiveReplyMode(runtime.account.replyMode, chatType);
      if (effectiveReplyMode === "streaming") {
        active.cardController = await this.trySeedStreamingCard({ runtime, accountId, chatId, replyToMessageId: messageId });
      }
      // Abort can race the card seed: handleAbortFastPath may have flipped
      // suppressed while we were awaiting card.create / message.reply. In
      // that case the fast-path delivered a plain-text ack but had no card
      // to drive — so we must terminate the freshly-seeded card here, and
      // skip agent.chat entirely (its signal is already aborted).
      if (active.suppressed) {
        if (active.cardController && !active.cardController.isTerminated()) {
          try {
            await active.cardController.abort(getMessages().abortAck);
          } catch (error) {
            await this.logger!.error("feishu.abort.card_update_failed", "failed to render aborted card after seed-race", {
              accountId,
              chatId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return;
      }

      const safeReply = async (text: string): Promise<void> => {
        if (active.suppressed) return;
        if (active.cardController) {
          active.cardController.appendStream(text);
          return;
        }
        await this.sendReplyWithGuard({ runtime, chatId, replyToMessageId: messageId, text });
      };

      try {
        const response = await this.agent.chat({
          accountId,
          conversationId: chatKey,
          text: requestText,
          ...(media.length > 0 ? { media } : {}),
          replyContextToken: messageId,
          metadata: {
            ...buildFeishuRouteMetadata({ chatType, senderOpenId: active.senderOpenId, chatId }),
            ...(boundAlias ? { boundSessionAlias: boundAlias } : {}),
          },
          reply: safeReply,
          // Only consume the structured tool-event side-channel when we actually
          // have a card to render into. Without this gate, static-mode turns would
          // silently drop tool events because the transport's parser would route
          // them to `onToolEvent` instead of folding them into the text reply
          // stream — and our `cardController?.recordToolEvent` becomes a no-op when
          // the controller is null.
          ...(active.cardController ? {
            onToolEvent: (event) => {
              if (active.suppressed) return;
              active.cardController?.recordToolEvent(event);
            },
            onThought: (chunk) => {
              if (active.suppressed) return;
              active.cardController?.appendReasoning(chunk);
            },
            onPlan: (entries) => {
              if (active.suppressed) return;
              active.cardController?.recordPlan(entries);
            },
            onUsage: (usage) => {
              if (active.suppressed) return;
              active.cardController?.recordUsage(usage);
            },
          } : {}),
          abortSignal: abortController.signal,
        });
        if (active.suppressed) return;
        await this.deliverResponse({ runtime, accountId, chatId, messageId, active, response });
        turnStatus = "done";
      } catch (error) {
        if (active.cardController && !active.cardController.isTerminated()) {
          await active.cardController.fail(error instanceof Error ? error.message : String(error));
        }
        turnStatus = "error";
        throw error;
      }
    } finally {
      if (boundAlias) {
        // markInactive always mirrors the markActive in handleMessageEvent,
        // regardless of outcome (including skipped turns).
        this.activeTurns?.markInactive(chatKey, boundAlias);
        // B-semantics completion awareness: if this turn produced a real
        // outcome (done/error) AND its session is no longer the chat's
        // foreground session, its streaming card already ran to completion in
        // the timeline. Record a completion SIGNAL (empty text — switch-back
        // does NOT replay) so /sessions shows ●, and send a short ping into the
        // chat (chatId, replying to the original message). The Feishu chat is
        // fixed — session switching is logical within it — so chatId is exactly
        // where the user now is. A "skipped" turn never ran, so it records nothing.
        if (turnStatus !== "skipped" && this.sessions && this.sessions.peekCurrentSessionAlias(chatKey) !== boundAlias) {
          await this.sessions.setBackgroundResult(chatKey, boundAlias, {
            text: "",
            status: turnStatus,
            finished_at: new Date().toISOString(),
          });
          await this.sendBackgroundCompletionNotice({ runtime, chatId, messageId, boundAlias, status: turnStatus });
        }
      }
      const stack = this.activeTasks.get(queueKey);
      if (stack) {
        const i = stack.indexOf(active);
        if (i >= 0) stack.splice(i, 1);
        if (stack.length === 0) this.activeTasks.delete(queueKey);
      }
      await removeTypingIndicator({
        client: runtime.client.sdk as unknown as FeishuReactionClient,
        state: active.typingState,
        accountId,
      });
    }
  }

  private async trySeedStreamingCard(input: {
    runtime: AccountRuntime;
    accountId: string;
    chatId: string;
    replyToMessageId?: string;
  }): Promise<StreamingCardController | null> {
    const { runtime, accountId, chatId } = input;
    try {
      const controller = new StreamingCardController({
        client: runtime.client.sdk as unknown as StreamingCardClient,
        accountId,
        flushIntervalMs: this.config.tuning.cardFlushIntervalMs,
        failureThreshold: this.config.tuning.cardFailureThreshold,
        cardBodyMaxChars: this.config.tuning.cardBodyMaxChars,
        imageResolveTimeoutMs: this.config.tuning.imageResolveTimeoutMs,
        imageMaxBytes: this.config.tuning.imageMaxBytes,
        imageCacheCap: this.config.tuning.imageCacheCap,
        onCardDegraded: ({ buffer, consecutiveFailures }) => {
          void this.logger?.error(
            "feishu.card.degraded",
            "streaming card updates failing; will deliver answer via plain reply",
            { accountId, chatId, consecutiveFailures, bufferChars: buffer.length },
          );
        },
      });
      await controller.seed({ to: chatId, ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}) });
      return controller;
    } catch (error) {
      const permErr = extractPermissionError(error);
      await this.logger!.info("feishu.streaming.fallback", "streaming card seed failed; falling back to static", {
        accountId,
        chatId,
        reason: permErr ? "permission" : "seed_error",
        message: error instanceof Error ? error.message : String(error),
      });
      if (permErr) await this.maybeNotifyPermissionError({ runtime, chatId, error });
      return null;
    }
  }

  private async deliverResponse(input: {
    runtime: AccountRuntime;
    accountId: string;
    chatId: string;
    messageId: string;
    active: ActiveTask;
    response: Awaited<ReturnType<NonNullable<FeishuChannel["agent"]>["chat"]>>;
  }): Promise<void> {
    const { runtime, accountId, chatId, messageId, active, response } = input;
    const responseText = response.text?.trim() ?? "";
    if (active.cardController) {
      // Always terminate the card — even if the agent returned no text,
      // otherwise the user sees "Processing..." forever.
      await active.cardController.complete(responseText.length > 0 ? response.text : undefined);
      // If the card subsystem gave up (N consecutive update failures),
      // deliver the answer as a plain reply so the user still sees it.
      if (active.cardController.isDegraded() && responseText.length > 0) {
        await this.sendReplyWithGuard({ runtime, chatId, replyToMessageId: messageId, text: response.text! });
      }
    } else if (responseText.length > 0) {
      await this.sendReplyWithGuard({ runtime, chatId, replyToMessageId: messageId, text: response.text! });
    }
    for (const item of normalizeMediaArray(response.media)) {
      if (active.suppressed) return;
      const safePath = await resolveSafeOutboundMediaPath(
        item.filePath,
        [this.deps.mediaStore?.rootDir, ...(this.deps.allowedMediaRoots ?? [])].filter((x): x is string => typeof x === "string"),
      );
      if (!safePath) {
        await this.logger!.error("feishu.media.rejected", "outbound media path rejected", { filePath: item.filePath, accountId });
        continue;
      }
      try {
        const mediaReplyTarget = isMessageUnavailable(messageId, accountId) ? undefined : messageId;
        await sendMediaFeishu({
          client: runtime.client.sdk as never,
          to: chatId,
          media: { ...item, filePath: safePath },
          ...(mediaReplyTarget ? { replyToMessageId: mediaReplyTarget } : {}),
        });
      } catch (error) {
        markIfUnavailableError(messageId, error, accountId);
        if (await this.maybeNotifyPermissionError({ runtime, chatId, error })) continue;
        await this.logger!.error("feishu.media.send_failed", "failed to send feishu media", {
          message: error instanceof Error ? error.message : String(error),
          accountId,
        });
      }
    }
  }

  private async downloadInboundAttachments(input: {
    runtime: AccountRuntime;
    accountId: string;
    chatKey: string;
    messageId: string;
    resources: FeishuResourceDescriptor[];
    initialSkipped: string[];
  }): Promise<{ media: ChannelMediaAttachment[]; skipped: string[] }> {
    const { runtime, accountId, chatKey, messageId, resources, initialSkipped } = input;
    const mediaStore = this.deps.mediaStore ?? new RuntimeMediaStore({ rootDir: path.join(process.cwd(), ".weacpx-media") });
    const media: ChannelMediaAttachment[] = [];
    const skipped = [...initialSkipped];
    for (const resource of resources.slice(0, DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE)) {
      try {
        const downloaded = await downloadFeishuMessageResource({
          client: runtime.client.sdk as never,
          messageId,
          fileKey: resource.fileKey,
          resourceType: resource.kind === "image" ? "image" : "file",
          maxBytes: resource.kind === "image" ? DEFAULT_IMAGE_MAX_BYTES : DEFAULT_ATTACHMENT_MAX_BYTES,
        });
        media.push(
          await mediaStore.saveMediaBuffer({
            channelId: "feishu",
            accountId,
            chatKey,
            messageId,
            fileName: downloaded.fileName ?? resource.fileName,
            mimeType: downloaded.contentType ?? defaultMimeForKind(resource.kind),
            kind: resource.kind,
            buffer: downloaded.buffer,
            sourceResourceId: resource.fileKey,
            maxBytes: resource.kind === "image" ? DEFAULT_IMAGE_MAX_BYTES : DEFAULT_ATTACHMENT_MAX_BYTES,
          }),
        );
      } catch (error) {
        skipped.push(`Skipped ${resource.kind} ${resource.fileKey}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { media, skipped };
  }

  private async handleAbortFastPath(input: {
    runtime: AccountRuntime;
    activeTasks: ActiveTask[];
    abortRequestMessageId: string;
    chatId: string;
    accountId: string;
  }): Promise<void> {
    const { runtime, activeTasks, abortRequestMessageId, chatId, accountId } = input;
    // Suppress and signal every pending entry — user said "stop", they mean
    // everything pending for them. The most-recent entry decides whether the
    // ack lands as a card update vs plain reply.
    for (const t of activeTasks) {
      t.suppressed = true;
      try {
        t.abortController.abort();
      } catch {
        // AbortController.abort() never throws in practice; defensive
      }
    }
    const target = activeTasks[activeTasks.length - 1]!;
    await this.logger!.info("feishu.abort.triggered", "abort fast-path triggered for active task", {
      accountId,
      chatId,
      activeMessageId: target.messageId,
      abortRequestMessageId,
      suppressedCount: activeTasks.length,
      mode: target.cardController ? "streaming" : "static",
    });
    // Clear typing indicators for all suppressed turns.
    await Promise.all(activeTasks.map((t) => removeTypingIndicator({
      client: runtime.client.sdk as unknown as FeishuReactionClient,
      state: t.typingState,
      accountId,
    })));
    // Drive every live card to the aborted state. If we only drove the most
    // recent one, older queued cards that were already seeded would stay
    // showing "Processing..." forever (suppressed → agent body short-circuits
    // before reaching complete()).
    const cardTasks = activeTasks.filter(
      (t) => t.cardController && !t.cardController.isTerminated(),
    );
    let cardAcked = false;
    for (const t of cardTasks) {
      try {
        await t.cardController!.abort(getMessages().abortAck);
        cardAcked = true;
      } catch (error) {
        await this.logger!.error("feishu.abort.card_update_failed", "failed to render aborted card", {
          accountId,
          chatId,
          activeMessageId: t.messageId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (cardAcked) return;
    try {
      await this.sendReplyWithGuard({
        runtime,
        chatId,
        replyToMessageId: abortRequestMessageId,
        text: getMessages().abortAck,
      });
    } catch (error) {
      await this.logger!.error("feishu.abort.ack_failed", "failed to send abort acknowledgement", {
        accountId,
        chatId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async sendReplyWithGuard(input: {
    runtime: AccountRuntime;
    chatId: string;
    replyToMessageId: string;
    text: string;
  }): Promise<void> {
    const { runtime, chatId, replyToMessageId, text } = input;
    const accountId = runtime.account.accountId;
    const replyTarget = isMessageUnavailable(replyToMessageId, accountId) ? undefined : replyToMessageId;
    try {
      await sendTextFeishu({
        client: runtime.client.sdk,
        to: chatId,
        text,
        ...(replyTarget ? { replyToMessageId: replyTarget } : {}),
      });
    } catch (error) {
      if (replyTarget && markIfUnavailableError(replyToMessageId, error, accountId)) {
        await sendTextFeishu({ client: runtime.client.sdk, to: chatId, text });
        return;
      }
      if (await this.maybeNotifyPermissionError({ runtime, chatId, error })) return;
      throw error;
    }
  }

  private async maybeNotifyPermissionError(input: {
    runtime: AccountRuntime;
    chatId: string;
    error: unknown;
  }): Promise<boolean> {
    const permErr = extractPermissionError(input.error);
    if (!permErr) return false;
    const cooldownKey = `${input.runtime.account.accountId}:${input.chatId}:${permErr.code}`;
    if (!this.permissionNotifier.tryReserve(cooldownKey)) {
      await this.logger?.info("feishu.permission.suppressed", "permission notification suppressed by cooldown", {
        accountId: input.runtime.account.accountId,
        chatId: input.chatId,
        code: permErr.code,
      });
      return true;
    }
    await this.logger?.info("feishu.permission.notify", "surfacing feishu permission error to user", {
      accountId: input.runtime.account.accountId,
      chatId: input.chatId,
      code: permErr.code,
      grantUrl: permErr.grantUrl,
    });
    try {
      await sendTextFeishu({
        client: input.runtime.client.sdk,
        to: input.chatId,
        text: formatPermissionNotice(permErr),
      });
      this.permissionNotifier.commit(cooldownKey);
    } catch (notifyError) {
      // Don't burn the cooldown on a failed delivery — the user got nothing.
      this.permissionNotifier.rollback(cooldownKey);
      await this.logger?.error("feishu.permission.notify_failed", "failed to deliver permission notification", {
        accountId: input.runtime.account.accountId,
        chatId: input.chatId,
        message: notifyError instanceof Error ? notifyError.message : String(notifyError),
      });
    }
    return true;
  }
}


function formatScheduledFailureText(input: ScheduledChannelMessageInput, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return input.taskId
    ? getMessages().scheduledFailureWithId(String(input.taskId), message)
    : getMessages().scheduledFailure(message);
}

function defaultMimeForKind(kind: "image" | "file" | "audio" | "video"): string {
  if (kind === "image") return "image/*";
  if (kind === "audio") return "audio/opus";
  if (kind === "video") return "video/mp4";
  return "application/octet-stream";
}

function appendSkippedAttachmentNotes(text: string, notes: string[]): string {
  if (notes.length === 0) return text;
  return [text, "", "Attachment notes:", ...notes.map((note) => `- ${note}`)].filter(Boolean).join("\n");
}

/**
 * `auto` resolves to streaming for direct chats and static for groups, since
 * cards in group chats are visually heavier and the multi-message static path
 * is fine when group members aren't watching a single conversation.
 */
function resolveEffectiveReplyMode(
  configured: "static" | "streaming" | "auto",
  chatType: string | undefined,
): "static" | "streaming" {
  if (configured !== "auto") return configured;
  return chatType === "group" ? "static" : "streaming";
}
