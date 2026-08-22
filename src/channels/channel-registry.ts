import { getChannelIdFromChatKey } from "./channel-scope";
import type {
  ChannelStartInput,
  CoordinatorMessageInput,
  MessageChannelRuntime,
  OrchestrationDeliveryCallbacks,
  ScheduledChannelMessageInput,
} from "./types";
import type { OrchestrationTaskRecord } from "../orchestration/orchestration-types";

export class MessageChannelRegistry {
  private readonly channels: Map<string, MessageChannelRuntime>;

  constructor(channels: MessageChannelRuntime[]) {
    this.channels = new Map(channels.map((channel) => [channel.id, channel]));
  }

  get size(): number {
    return this.channels.size;
  }

  configureOrchestration(callbacks: OrchestrationDeliveryCallbacks): void {
    for (const channel of this.channels.values()) {
      channel.configureOrchestration?.(callbacks);
    }
  }

  async startAll(input: ChannelStartInput): Promise<void> {
    const outcomes = await Promise.allSettled(
      [...this.channels.values()].map(async (channel) => {
        try {
          await channel.start(input);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          await input.logger.error(
            `channel.${channel.id}.start_failed`,
            `channel ${channel.id} failed to start: ${message}`,
            { channel: channel.id },
          );
          throw error;
        }
      }),
    );
    const failed = outcomes.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (failed.length === this.channels.size) {
      throw new Error("all channels failed to start");
    }
  }

  /**
   * Shutdown path (signal handlers, startup-error cleanup). Prefers the
   * non-destructive `stop()` and falls back to `logout()` only for channels
   * that predate `stop()` (published plugins whose logout is a benign client
   * stop). Never an intentional credential wipe — that is `xacpx logout`.
   *
   * Like startAll, channels are isolated from each other: one throwing
   * channel must not skip teardown of the rest. The first error is rethrown
   * afterwards so the run-console cleanup sequence still records it.
   *
   * @param reason - The reason for stopping (defaults to "shutdown")
   */
  async stopAll(
    reason: "shutdown" | "disabled" | "removed" | "logout" = "shutdown",
  ): Promise<void> {
    let firstError: unknown;
    for (const channel of this.channels.values()) {
      try {
        if (channel.stop) {
          await channel.stop(reason);
        } else {
          await channel.logout();
        }
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  getByChatKey(chatKey: string): MessageChannelRuntime | null {
    return this.channels.get(getChannelIdFromChatKey(chatKey)) ?? null;
  }

  async notifyTaskCompletion(task: OrchestrationTaskRecord): Promise<void> {
    if (!task.chatKey) return;
    await this.requireByChatKey(task.chatKey).notifyTaskCompletion(task);
  }

  async notifyTaskProgress(
    task: OrchestrationTaskRecord,
    text: string,
  ): Promise<void> {
    if (!task.chatKey) return;
    await this.requireByChatKey(task.chatKey).notifyTaskProgress(task, text);
  }

  async sendCoordinatorMessage(input: CoordinatorMessageInput): Promise<void> {
    await this.requireByChatKey(input.chatKey).sendCoordinatorMessage(input);
  }

  supportsScheduledMessages(chatKey: string): boolean {
    const [candidateChannelId] = chatKey.split(":", 1);
    if (
      chatKey.includes(":") &&
      candidateChannelId &&
      !this.channels.has(candidateChannelId)
    ) {
      return false;
    }
    const channel = this.getByChatKey(chatKey);
    return !!channel?.sendScheduledMessage;
  }

  async sendScheduledMessage(
    input: ScheduledChannelMessageInput,
  ): Promise<void> {
    const channel = this.requireByChatKey(input.chatKey);
    if (!channel.sendScheduledMessage) {
      throw new Error(
        `channel '${channel.id}' does not support scheduled messages`,
      );
    }
    await channel.sendScheduledMessage(input);
  }

  nativeSessionListFormat(chatKey: string): "cards" | "table" {
    return this.getByChatKey(chatKey)?.nativeSessionListFormat ?? "table";
  }

  /** Delegate to the first registered channel that implements the relay agent
   *  messaging route. Without a relay-capable channel the router stays
   *  ROUTE_UNAVAILABLE. */
  async sendAgentMessageRoute(payload: {
    sourceNodeId: string;
    sourceEndpointId: string;
    targetNodeId: string;
    targetEndpointId: string;
    messageId: string;
    content: string;
    requestedMode: string;
    replyTo?: string;
  }): Promise<{
    messageId: string;
    status: "injected" | "queued" | "failed";
    modeUsed?: "steer" | "queue" | "interrupt" | "prompt";
    targetState?: "idle" | "running";
    errorCode?: string;
    deduplicated?: boolean;
  }> {
    for (const channel of this.channels.values()) {
      if (typeof channel.sendAgentMessageRoute === "function") {
        return await channel.sendAgentMessageRoute(payload);
      }
    }
    throw new Error(
      "no registered channel implements the agent messaging relay route",
    );
  }

  /** Delegate to the first registered channel that implements the relay agent
   *  messaging completion route. Without a relay-capable channel the router stays
   *  ROUTE_UNAVAILABLE. */
  async sendAgentMessageCompletion(payload: {
    requestMessageId: string;
    source: { nodeId: string; endpointId: string };
    target: { nodeId: string; endpointId: string };
    status: "completed" | "failed" | "cancelled";
    result?: string;
    error?: string;
    completedAt: number;
  }): Promise<{
    ok: boolean;
    deduplicated?: boolean;
    error?: string;
  }> {
    for (const channel of this.channels.values()) {
      if (typeof channel.sendAgentMessageCompletion === "function") {
        return await channel.sendAgentMessageCompletion(payload);
      }
    }
    throw new Error(
      "no registered channel implements the agent messaging relay completion route",
    );
  }

  /** Publish the full local agent endpoint directory to the relay hub (debounced
   *  by the channel; no delta protocol). No-op when no channel implements it. */
  syncAgentEndpoints(endpoints: unknown[]): void {
    for (const channel of this.channels.values()) {
      if (typeof channel.syncAgentEndpoints === "function") {
        channel.syncAgentEndpoints(endpoints);
        return;
      }
    }
  }

  createConsumerLocks(): Array<{
    channel: MessageChannelRuntime;
    create: NonNullable<MessageChannelRuntime["createConsumerLock"]>;
  }> {
    const result: Array<{
      channel: MessageChannelRuntime;
      create: NonNullable<MessageChannelRuntime["createConsumerLock"]>;
    }> = [];
    for (const channel of this.channels.values()) {
      if (channel.createConsumerLock) {
        result.push({
          channel,
          create: channel.createConsumerLock.bind(channel),
        });
      }
    }
    return result;
  }

  private requireByChatKey(chatKey: string): MessageChannelRuntime {
    const channel = this.getByChatKey(chatKey);
    if (!channel) {
      throw new Error(`no message channel registered for chatKey: ${chatKey}`);
    }
    return channel;
  }
}
