import { getChannelIdFromChatKey } from "./channel-scope";
import type {
  ChannelStartInput,
  CoordinatorMessageInput,
  MessageChannelRuntime,
  OrchestrationDeliveryCallbacks,
  ScheduledChannelMessageInput,
} from "./types";
import type { OrchestrationTaskRecord } from "../orchestration/orchestration-types";

/**
 * What the daemon needs to know about form-Elicitation delivery once channel
 * startups have had their say.
 */
export interface ElicitationReadiness {
  /** Whether at least one form-capable channel is live. */
  formCapable: boolean;
  /** Ids of the live form-capable channels. */
  formChannelIds: string[];
  /** Ids of channels whose most recent start attempt failed. */
  failedChannelIds: string[];
}

export class MessageChannelRegistry {
  private readonly channels: Map<string, MessageChannelRuntime>;
  /**
   * Channels whose `start()` threw. Capability probes answer from live
   * readiness, so a channel that advertises form support and then fails to
   * bind is excluded until it starts successfully.
   */
  private readonly failedStartupChannels: Set<string> = new Set();
  private onElicitationReadiness: ((readiness: ElicitationReadiness) => void) | null = null;

  constructor(channels: MessageChannelRuntime[]) {
    this.channels = new Map(channels.map((channel) => [channel.id, channel]));
  }

  get size(): number {
    return this.channels.size;
  }

  /** Channel ids that failed their most recent `startAll()` attempt. */
  failedStartupChannelIds(): string[] {
    return [...this.failedStartupChannels];
  }

  /**
   * Ids of channels that can deliver a form Elicitation, considering live
   * readiness. Used by the startup gate to decide whether a failed channel
   * actually cost a capability or merely degraded one.
   */
  formElicitationChannelIds(): string[] {
    const ids: string[] = [];
    for (const [id, channel] of this.channels) {
      if (this.failedStartupChannels.has(id)) continue;
      if (typeof channel.requestElicitation !== "function") continue;
      if ((channel.elicitationModes ?? []).includes("form")) ids.push(id);
    }
    return ids;
  }

  /** Live form-capability read, honouring channels that failed to start. */
  elicitationFormCapable(): boolean {
    return this.hasElicitationFormCapability();
  }

  /**
   * Every registered channel, for a caller that needs to reason about the
   * declared-versus-live difference.
   */
  allChannels(): MessageChannelRuntime[] {
    return [...this.channels.values()];
  }

  /**
   * Ids of channels that DECLARE form support, regardless of whether they
   * started. The daemon's pre-start capability read is based on exactly this
   * set, which is what makes it the right baseline for detecting a capability
   * that went missing.
   */
  declaredElicitationFormChannelIds(): string[] {
    const ids: string[] = [];
    for (const [id, channel] of this.channels) {
      if (typeof channel.requestElicitation !== "function") continue;
      if ((channel.elicitationModes ?? []).includes("form")) ids.push(id);
    }
    return ids;
  }

  /**
   * Subscribe to form-capability changes.
   *
   * Fired from each channel's start outcome, because `startAll()` is not a
   * readiness barrier and the daemon's pre-start probe cannot know the answer.
   * The daemon uses this to correct what it told the bridge.
   */
  setElicitationReadinessListener(
    listener: (readiness: ElicitationReadiness) => void,
  ): void {
    this.onElicitationReadiness = listener;
  }

  configureOrchestration(callbacks: OrchestrationDeliveryCallbacks): void {
    for (const channel of this.channels.values()) {
      channel.configureOrchestration?.(callbacks);
    }
  }

  async startAll(input: ChannelStartInput): Promise<void> {
    const entries = [...this.channels.entries()];
    const outcomes = await Promise.allSettled(
      entries.map(async ([id, channel]) => {
        let failed = false;
        try {
          await channel.start(input);
        } catch (error) {
          failed = true;
          const message =
            error instanceof Error ? error.message : String(error);
          await input.logger.error(
            `channel.${id}.start_failed`,
            `channel ${id} failed to start: ${message}`,
            { channel: id },
          );
          throw error;
        } finally {
          // Record this channel's outcome AS IT HAPPENS. `allSettled` is not a
          // readiness barrier — a healthy channel's `start()` may stay pending
          // for the daemon's whole lifetime — so deferring this bookkeeping to
          // after the await meant a failure that happened early was not visible
          // until (possibly) never.
          if (failed) {
            this.failedStartupChannels.add(id);
          } else {
            this.failedStartupChannels.delete(id);
          }
          await this.settleElicitationReadiness();
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
   * Publish the current form-Elicitation capability to the daemon.
   *
   * Called from each channel's start (in `finally`, so a failure publishes
   * too). This exists because `startAll()` is NOT a readiness barrier: a healthy
   * channel's `start()` can stay pending for the whole daemon lifetime, so
   * anything computed once before or once after `allSettled` is computed from
   * incomplete information. The signal is emitted the moment an interaction
   * channel's fate is known, which is the only time it can be known.
   */
  private async settleElicitationReadiness(): Promise<void> {
    if (!this.onElicitationReadiness) return;
    try {
      this.onElicitationReadiness({
        formCapable: this.hasElicitationFormCapability(),
        formChannelIds: this.formElicitationChannelIds(),
        failedChannelIds: [...this.failedStartupChannels],
      });
    } catch {
      // A readiness listener must never take a channel's start down.
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
  /**
   * True permission-interaction capability: at least one registered runtime
   * actually implements `requestPermission()`. This is the single fact
   * source for `permissionInteractionCapable` everywhere (daemon startup
   * gate, watcher hot-apply, /config + /pm handlers, SessionService
   * affinity, bridge Runtime eligibility) — NOT mere registry presence.
   * Per-chat/per-account support is still decided per request by the broker
   * (unsupported channel → fail closed); this flag only means escalation MAY
   * be Runtime-routed somewhere.
   */
  hasPermissionInteractionCapability(): boolean {
    for (const channel of this.channels.values()) {
      if (typeof channel.requestPermission === "function") return true;
    }
    return false;
  }

  /**
   * True form-Elicitation capability: at least one registered runtime both
   * implements `requestElicitation()` AND declares the `form` mode AND actually
   * started. Deliberately independent of the permission probe (G9): a channel
   * may support approvals but cannot render a form Elicitation, and v1 forbids
   * inferring one from the other. Implementing the method without declaring a
   * mode is NOT support — the broker would accept the request and then fail
   * closed on the mode check, so advertising it would be a lie the agent pays
   * for.
   *
   * A channel that declares the mode and then fails to start is likewise NOT
   * support: this probe answers from live readiness precisely because the
   * daemon computes it once, before channels exist, and the bridge is told the
   * answer for the rest of the run.
   */
  hasElicitationFormCapability(): boolean {
    return this.supportedElicitationModes().includes("form");
  }

  /**
   * Modes this registry can truthfully advertise.
   *
   * M1's plugin contract is FORM ONLY, and that is a deliberate narrowing of
   * the ACP mode union rather than an oversight: `ChannelElicitationRequest`
   * carries form data only, there is no URL dispatch, and the RFD's URL-mode
   * rules (target-host display, consent before navigating, `elicitationId`,
   * `elicitation/complete`) are unimplemented. A channel declaring `"url"`
   * would therefore be reported as supporting a mode core cannot deliver —
   * a capability lie in the published plugin API.
   *
   * A mode counts only when a channel declares it AND implements
   * `requestElicitation()`. Without a form-capable channel the result is empty,
   * and the daemon advertises no ACP elicitation capability at all.
   *
   * When M2 adds URL rendering, this is the single place that widens.
   */
  supportedElicitationModes(): Array<"form"> {
    const modes: Array<"form"> = [];
    for (const channel of this.channels.values()) {
      if (typeof channel.requestElicitation !== "function") continue;
      // A channel that failed to start is not a delivery path, however its
      // declaration reads. Excluding it here keeps the advertised capability
      // truthful when the daemon's one-shot pre-start probe was too optimistic.
      if (this.failedStartupChannels.has(channel.id)) continue;
      for (const mode of channel.elicitationModes ?? []) {
        if (mode === "form" && !modes.includes(mode)) modes.push(mode);
      }
    }
    return modes;
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
