import type {
  MessageChannelRuntime,
  ChannelStartInput,
  CoordinatorMessageInput,
  OutboundQuota,
  OrchestrationDeliveryCallbacks,
  ConsumerLock,
  ConsumerLockOptions,
  ScheduledChannelMessageInput,
} from "./types.js";
import { t } from "../i18n/index.js";
import type { RuntimeMediaStore } from "./media-store.js";
import type { OrchestrationTaskRecord } from "../orchestration/orchestration-types.js";
import type { AppLogger } from "../logging/app-logger.js";
import type { ChatAgent } from "./types.js";
import {
  login as weixinLogin,
  logout as weixinLogout,
  isLoggedIn as weixinIsLoggedIn,
  start as weixinStart,
  listWeixinAccountIds,
  resolveWeixinAccount,
  sendMessageWeixin,
} from "../weixin/index.js";
import { getContextToken } from "../weixin/messaging/inbound.js";
import { deliverOrchestrationTaskNotice } from "../weixin/messaging/deliver-orchestration-task-notice.js";
import { deliverOrchestrationTaskProgress } from "../weixin/messaging/deliver-orchestration-task-progress.js";
import { deliverCoordinatorMessage } from "../weixin/messaging/deliver-coordinator-message.js";
import { executeScheduledTurn } from "../weixin/messaging/scheduled-turn.js";
import { createWeixinConsumerLock } from "../weixin/monitor/consumer-lock.js";

export class WeixinChannel implements MessageChannelRuntime {
  readonly id = "weixin";
  // WeChat renders markdown tables poorly; native session lists use cards here.
  readonly nativeSessionListFormat: "cards" | "table" = "cards";

  private agent: ChatAgent | null = null;
  private quota: OutboundQuota | null = null;
  private logger: AppLogger | null = null;
  private markDelivered: OrchestrationDeliveryCallbacks["markTaskNoticeDelivered"] | null = null;
  private markFailed: OrchestrationDeliveryCallbacks["markTaskNoticeFailed"] | null = null;
  private mediaStore: RuntimeMediaStore | null;
  private allowedMediaRoots: string[];

  constructor(mediaStore?: RuntimeMediaStore, allowedMediaRoots?: string[]) {
    this.mediaStore = mediaStore ?? null;
    this.allowedMediaRoots = allowedMediaRoots ?? [];
  }

  isLoggedIn(): boolean {
    return weixinIsLoggedIn();
  }

  async login(): Promise<string> {
    return weixinLogin();
  }

  logout(): void {
    weixinLogout();
  }

  /**
   * Non-destructive shutdown. The monitor loop is already stopped via the
   * abort signal passed to start(); this only drops runtime references and
   * MUST NOT touch the credential files on disk (a graceful daemon stop or
   * restart must not force a QR re-login). Destructive credential removal
   * happens only through logout() (the explicit `xacpx logout` CLI path).
   */
  stop(): void {
    this.agent = null;
    this.quota = null;
    this.logger = null;
    this.markDelivered = null;
    this.markFailed = null;
  }

  createConsumerLock(options?: ConsumerLockOptions): ConsumerLock {
    return createWeixinConsumerLock({
      ...(options?.lockFilePath ? { lockFilePath: options.lockFilePath } : {}),
      ...(options?.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
    });
  }

  configureOrchestration(callbacks: OrchestrationDeliveryCallbacks): void {
    this.markDelivered = callbacks.markTaskNoticeDelivered;
    this.markFailed = callbacks.markTaskNoticeFailed;
  }

  async start(input: ChannelStartInput): Promise<void> {
    this.agent = input.agent;
    this.quota = input.quota;
    this.logger = input.logger;

    if (!this.isLoggedIn()) {
      console.log(t().misc.weixinNoCredentials);
      await this.login();
    }

    const sessions = input.sessions;

    await weixinStart(input.agent, {
      ...(input.routeConversation ? { routeConversation: input.routeConversation } : {}),
      abortSignal: input.abortSignal,
      ...(this.mediaStore ? { mediaStore: this.mediaStore } : {}),
      ...(this.allowedMediaRoots.length > 0 ? { allowedMediaRoots: this.allowedMediaRoots } : {}),
      onInbound: (chatKey) => input.quota.onInbound(chatKey),
      reserveFinal: (chatKey) => input.quota.reserveFinal(chatKey),
      finalRemaining: (chatKey) => input.quota.finalRemaining(chatKey),
      hasPendingFinal: (chatKey) => input.quota.hasPendingFinal(chatKey),
      drainPendingFinal: (chatKey, available) =>
        input.quota.drainPendingFinalUpToBudget(chatKey, available),
      prependPendingFinal: (chatKey, chunks) =>
        input.quota.prependPendingFinal(chatKey, chunks),
      enqueuePendingFinal: (chatKey, chunks) =>
        input.quota.enqueuePendingFinal(chatKey, chunks),
      dropPendingFinal: (chatKey) => input.quota.clearPendingFinal(chatKey),
      ...(input.perfTracer ? { perfTracer: input.perfTracer } : {}),
      // Dispatch-time session binding: read the chat's current alias synchronously
      // and persist background turn results for later replay.
      ...(sessions
        ? {
            peekCurrentSessionAlias: (chatKey: string) =>
              sessions.peekCurrentSessionAlias(chatKey),
            setBackgroundResult: (chatKey, alias, result) =>
              sessions.setBackgroundResult(chatKey, alias, result),
          }
        : {}),
      ...(input.activeTurns ? { activeTurns: input.activeTurns } : {}),
    });
  }

  async notifyTaskCompletion(task: OrchestrationTaskRecord): Promise<void> {
    if (!this.quota || !this.logger) {
      throw new Error("WeixinChannel.start() must be called before orchestration delivery");
    }
    await deliverOrchestrationTaskNotice(task, {
      listAccountIds: () => listWeixinAccountIds(),
      resolveAccount: (accountId) => resolveWeixinAccount(accountId),
      getContextToken: (accountId, userId) => getContextToken(accountId, userId),
      markDelivered: this.markDelivered ?? (async () => {}),
      markFailed: this.markFailed ?? (async () => {}),
      reserveFinal: (chatKey) => this.quota!.reserveFinal(chatKey),
      logger: this.logger,
    });
  }

  async notifyTaskProgress(task: OrchestrationTaskRecord, text: string): Promise<void> {
    if (!this.quota || !this.logger) {
      throw new Error("WeixinChannel.start() must be called before orchestration delivery");
    }
    await deliverOrchestrationTaskProgress(task, text, {
      listAccountIds: () => listWeixinAccountIds(),
      resolveAccount: (accountId) => resolveWeixinAccount(accountId),
      getContextToken: (accountId, userId) => getContextToken(accountId, userId),
      reserveMidSegment: (chatKey) => this.quota!.reserveMidSegment(chatKey),
      logger: this.logger,
    });
  }

  async sendCoordinatorMessage(input: CoordinatorMessageInput): Promise<void> {
    if (!this.quota || !this.logger) {
      throw new Error("WeixinChannel.start() must be called before orchestration delivery");
    }
    await deliverCoordinatorMessage(input, {
      listAccountIds: () => listWeixinAccountIds(),
      resolveAccount: (accountId) => resolveWeixinAccount(accountId),
      getContextToken: (accountId, userId) => getContextToken(accountId, userId),
      sendMessage: sendMessageWeixin,
      reserveMidSegment: (chatKey) => this.quota!.reserveMidSegment(chatKey),
      logger: this.logger,
    });
  }

  async sendScheduledMessage(input: ScheduledChannelMessageInput): Promise<void> {
    if (!this.agent || !this.quota || !this.logger) {
      throw new Error("WeixinChannel.start() must be called before scheduled message delivery");
    }
    await executeScheduledTurn(input, {
      agent: this.agent,
      listAccountIds: () => listWeixinAccountIds(),
      resolveAccount: (accountId) => resolveWeixinAccount(accountId),
      getContextToken: (accountId, userId) => getContextToken(accountId, userId),
      reserveMidSegment: (chatKey) => this.quota!.reserveMidSegment(chatKey),
      reserveFinal: (chatKey) => this.quota!.reserveFinal(chatKey),
      finalRemaining: (chatKey) => this.quota!.finalRemaining(chatKey),
      enqueuePendingFinal: (chatKey, chunks) => this.quota!.enqueuePendingFinal(chatKey, chunks),
      sendMessage: sendMessageWeixin,
      logger: this.logger,
    });
  }
}
