import { createHash } from "node:crypto";
import { AsyncMutex } from "../orchestration/async-mutex";
import { normalizeChannelType } from "../channels/channel-type";
import { sanitizePublicConversationPrompt } from "../control/public-control";
import type { ConversationTarget } from "../control/conversation-control-dtos";
import type { BotService } from "../bots/bot-service";
import type { ChatRequest } from "../weixin/agent/interface";
import { ConversationError } from "./conversation-error";
import type { ConversationRunService } from "./conversation-run-service";
import type { SqliteConversationStore, ExternalStopReceipt } from "./sqlite-conversation-store";
import type { AcceptRequestResult } from "./conversation-store";
import { withEffectiveOwner, type ChannelOwnerConfig } from "../commands/command-policy";

export interface ConversationBinding {
  chatKey: string;
  conversationId: string;
  topicId?: string;
}

export interface ConversationRouteSnapshot {
  chatKey: string;
  binding?: Required<ConversationBinding> & { revision: string };
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() && value.length <= 2048;
}

function hasMedia(media: ChatRequest["media"]): boolean {
  return Array.isArray(media) ? media.length > 0 : Boolean(media);
}

function validateChatKey(chatKey: unknown): asserts chatKey is string {
  // Binding a product isolation key would turn a provider prompt into ingress.
  const separator = typeof chatKey === "string" ? chatKey.indexOf(":") : -1;
  let validType = false;
  if (separator > 0) {
    const type = (chatKey as string).slice(0, separator);
    try { validType = normalizeChannelType(type) === type; } catch { /* invalid namespace */ }
  }
  if (!nonempty(chatKey) || !validType || !/^[^\s]+$/.test(chatKey.slice(separator + 1))
    || /^(bot|control|relay|group-execution):/.test(chatKey)) {
    throw new ConversationError("binding_invalid", "binding requires a namespaced external channel chat key");
  }
}

export class ConversationBindingService {
  private readonly gates = new Map<string, { mutex: AsyncMutex; users: number }>();
  constructor(private readonly store: SqliteConversationStore,
    private readonly runs: ConversationRunService, private readonly bots: BotService,
    private readonly ownerConfig?: ChannelOwnerConfig) {}

  list(): Array<Required<ConversationBinding>> { return this.store.listConversationBindings(); }

  private async withRoute<T>(chatKey: string, operation: () => Promise<T>): Promise<T> {
    let gate = this.gates.get(chatKey);
    if (!gate) { gate = { mutex: new AsyncMutex(), users: 0 }; this.gates.set(chatKey, gate); }
    gate.users++;
    try { return await gate.mutex.run(operation); }
    finally { if (--gate.users === 0) this.gates.delete(chatKey); }
  }

  /** Cheap dispatch selection, before any ordinary Session lifecycle begins. */
  hasRoute(channelId: string, request: ChatRequest): boolean {
    return this.selectRoute(channelId, request) !== undefined;
  }

  selectRoute(channelId: string, request: ChatRequest): ConversationRouteSnapshot | undefined {
    const binding = this.store.getConversationBinding(request.conversationId);
    const key = this.sourceKey(channelId, request);
    if (!binding && !(key !== undefined && (this.store.hasExternalRequest(key) || this.store.hasExternalStopRequest(key)))) return undefined;
    return { chatKey: request.conversationId, ...(binding ? { binding: { ...binding } } : {}) };
  }

  receiptKind(channelId: string, request: ChatRequest): "prompt" | "stop" | undefined {
    const key = this.sourceKey(channelId, request);
    if (!key) return undefined;
    const prompt = this.store.hasExternalRequest(key);
    const stop = this.store.hasExternalStopRequest(key);
    if (prompt && stop) throw new ConversationError("external_request_conflict", "platform message has conflicting receipt kinds");
    return prompt ? "prompt" : stop ? "stop" : undefined;
  }

  private sourceKey(channelId: string, request: ChatRequest): string | undefined {
    const metadata = request.metadata;
    if (metadata?.channel !== channelId || !request.conversationId.startsWith(`${channelId}:`)
      || !nonempty(request.accountId) || !nonempty(metadata.channelMessageId)) return undefined;
    return createHash("sha256").update(JSON.stringify(
      [channelId, request.accountId, request.conversationId, metadata.channelMessageId])).digest("hex");
  }

  stopTargets(channelId: string, request: ChatRequest): string[] {
    const metadata = request.metadata;
    if (metadata?.origin !== "human" || metadata.authenticatedHuman !== true || !nonempty(metadata.senderId)
      || !this.sourceKey(channelId, request)) {
      throw new ConversationError("external_human_required", "Conversation Stop requires authenticated channel identity");
    }
    const binding = this.store.getConversationBinding(request.conversationId);
    return this.store.listLiveExternalRequests().filter(({ accepted, ingress }) => {
      if (!ingress && binding?.conversationId === accepted.run.conversationId && binding.topicId === accepted.run.topicId) {
        throw new ConversationError("external_stop_unavailable", "legacy Run lost its durable Stop owner; refusing to infer one");
      }
      return ingress?.chatKey === request.conversationId && ingress.senderId === metadata.senderId
        && ingress.accountId === request.accountId;
    }).map(({ accepted }) => accepted.run.id);
  }

  async stopSelected(channelId: string, request: ChatRequest, selected: string[]): Promise<void> {
    // Receipt ownership is immutable; revalidate it without the bind/accept
    // mutex. An acceptance waiting on a Bot gate must not hold durable Stop.
    // The Run service owns cancellation fences; pending acceptance is fenced
    // separately by its human signal, regardless of this target set's size.
    if (request.abortSignal?.aborted) throw new ConversationError("external_request_aborted", "channel closed before Stop");
    const live = new Set(this.stopTargets(channelId, request));
    await Promise.all(selected.filter((id) => live.has(id)).map((id) => this.runs.cancelRun(id)));
  }

  acceptStop(channelId: string, request: ChatRequest): ExternalStopReceipt {
    const metadata = request.metadata;
    this.assertSupportedIngress(channelId, request);
    const key = this.sourceKey(channelId, request);
    if (metadata?.origin !== "human" || metadata.authenticatedHuman !== true || !nonempty(metadata.senderId) || !key) {
      throw new ConversationError("external_human_required", "Conversation Stop requires authenticated channel identity");
    }
    if (request.abortSignal?.aborted) throw new ConversationError("external_request_aborted", "channel closed before Stop");
    if (hasMedia(request.media) || metadata.hadInboundMedia) throw new ConversationError("external_media_unsupported", "bound Conversation requests currently accept text only");
    const fingerprint = createHash("sha256").update(JSON.stringify([metadata.senderId, request.text])).digest("hex");
    return this.store.acceptExternalStop({ key, fingerprint, chatKey: request.conversationId, accountId: request.accountId, senderId: metadata.senderId },
      () => this.stopTargets(channelId, request));
  }

  async bind(input: ConversationBinding): Promise<Required<ConversationBinding>> {
    validateChatKey(input?.chatKey);
    if (!nonempty(input.conversationId) || (input.topicId !== undefined && !nonempty(input.topicId))) {
      throw new ConversationError("binding_invalid", "binding requires valid Conversation and Topic ids");
    }
    input = { chatKey: input.chatKey, conversationId: input.conversationId,
      ...(input.topicId !== undefined ? { topicId: input.topicId } : {}) };
    return this.withRoute(input.chatKey, async () => {
      const group = this.runs.listGroups().find((item) => item.id === input.conversationId);
      const botIds = group?.botIds ?? this.runs.getConversation(input.conversationId).botIds;
      return this.bots.runLifecycleAll(botIds, async () => {
        const topics = this.runs.listTopics(input.conversationId);
        const topicId = input.topicId ?? this.runs.defaultTopicId(input.conversationId);
        const topic = topics.find((item) => item.id === topicId);
        if (!topic || topic.status !== "active" || this.store.isConversationDeleting(input.conversationId)
          || this.store.isTopicDeleting(topic.id)) {
          throw new ConversationError("binding_topic_invalid", "binding requires an active Topic; Group bindings must select one explicitly");
        }
        const binding = { chatKey: input.chatKey, conversationId: input.conversationId, topicId: topic.id };
        this.store.setConversationBinding(binding);
        return binding;
      });
    });
  }

  async unbind(chatKey: string): Promise<void> {
    validateChatKey(chatKey);
    await this.withRoute(chatKey, async () => this.store.removeConversationBinding(chatKey));
  }

  /** Called by a selected Conversation Agent, never the ordinary Session Agent. */
  async accept(channelId: string, request: ChatRequest, shutdownSignal?: AbortSignal,
    selected?: ConversationRouteSnapshot): Promise<AcceptRequestResult | undefined> {
    return this.withRoute(request.conversationId, async () => {
      const binding = this.store.getConversationBinding(request.conversationId);
      const metadata = request.metadata;
      this.assertSupportedIngress(channelId, request);
      if (selected && selected.chatKey !== request.conversationId) {
        throw new ConversationError("binding_changed", "selected external route changed");
      }
      // Nonhuman events cannot enter target parsing or create human authority.
      // A bound chat must not silently execute them through the Session lane.
      if (metadata?.origin !== "human" || metadata.authenticatedHuman !== true) {
        if (binding) throw new ConversationError("external_human_required", "bound Conversation input requires authenticated human origin");
        return undefined;
      }
      if (metadata.channel !== channelId || !request.conversationId.startsWith(`${channelId}:`)
        || !nonempty(metadata.senderId) || !nonempty(request.accountId) || !nonempty(metadata.channelMessageId)) {
        if (binding) throw new ConversationError("external_ingress_invalid", "bound input requires channel, sender, account and stable platform message identity");
        return undefined;
      }
      if (hasMedia(request.media) || metadata.hadInboundMedia) throw new ConversationError("external_media_unsupported", "bound Conversation requests currently accept text only");
      const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
      const explicitTarget = sanitizePublicConversationPrompt({ conversationId: "", topicId: "", requestId: "",
        text: request.text, ...(metadata.conversationTarget !== undefined ? { target: metadata.conversationTarget } : {}) }).target;
      const externalRequest = {
        key: this.sourceKey(channelId, request)!,
        fingerprint: hash([metadata.senderId, request.text, explicitTarget ?? null, hasMedia(request.media) ? request.media : null]),
      };
      const replay = this.store.getExternalRequest(externalRequest);
      if (replay) return replay;
      if (selected && (!selected.binding || !binding
        || selected.binding.conversationId !== binding.conversationId || selected.binding.topicId !== binding.topicId
        || selected.binding.revision !== binding.revision)) {
        throw new ConversationError("binding_changed", "selected Conversation binding was replaced or removed");
      }
      if (!binding) return undefined;
      const ingressSignal = request.humanStopSignal
        ? AbortSignal.any([request.humanStopSignal, ...(request.abortSignal ? [request.abortSignal] : [])]) : request.abortSignal;
      if (ingressSignal?.aborted) throw new ConversationError("external_request_aborted", "channel request was stopped before acceptance");
      const topics = this.runs.listTopics(binding.conversationId);
      const topic = topics.find((item) => item.id === binding.topicId);
      if (!topic || topic.status !== "active") throw new ConversationError("binding_topic_invalid", "bound Topic is no longer active");
      const group = this.runs.listGroups().find((item) => item.id === binding.conversationId);
      let text = request.text;
      let target: ConversationTarget | undefined = explicitTarget;
      let externalAddress: { botId: string; name: string } | undefined;
      if (!target && group) {
        const mention = /^@(?:\{([^}\r\n]+)\}|([^\s{}]+))(?:\s+|$)/.exec(text);
        if (mention) {
          const name = mention[1] ?? mention[2]!;
          const matches = group.botIds.filter((id) => this.bots.getBot(id).name === name);
          if (matches.length !== 1) throw new ConversationError("external_target_ambiguous", "address must match exactly one current Group member");
          target = { botId: matches[0]! };
          externalAddress = { botId: matches[0]!, name };
          text = text.slice(mention[0].length);
        } else {
          if (text.startsWith("@")) throw new ConversationError("external_target_invalid", "malformed member address");
          if (!group.leadBotId) throw new ConversationError("external_target_required", "Group requires a target or lead Bot");
          target = { botId: group.leadBotId };
        }
      }
      const input = sanitizePublicConversationPrompt({ ...binding, requestId: `external:${externalRequest.key}`, text, ...(target ? { target } : {}) });
      let cancellation: Promise<void> | undefined;
      const stop = () => {
        if (shutdownSignal?.aborted) return;
        // The receipt is published with the Run, so this listener never stops
        // an unrelated public request with a colliding request id.
        try {
          const accepted = this.store.getExternalRequest(externalRequest);
          if (accepted) cancellation = this.runs.cancelRun(accepted.run.id);
        } catch (error) { cancellation = Promise.reject(error); }
        cancellation?.catch(() => {});
      };
      request.humanStopSignal?.addEventListener("abort", stop, { once: true });
      try {
        const owner = withEffectiveOwner(metadata, this.ownerConfig)!;
        return await this.runs.acceptConversationPrompt({ ...input, externalRequest,
          ...(externalAddress ? { externalAddress } : {}),
          ...(ingressSignal ? { channelAbortSignal: ingressSignal } : {}), humanIngress: {
            chatKey: request.conversationId, senderId: metadata.senderId, accountId: request.accountId,
            ...(metadata.senderName ? { senderName: metadata.senderName } : {}),
            ...(owner.isOwner !== undefined ? { isOwner: owner.isOwner } : {}),
            ...(metadata.chatType ? { chatType: metadata.chatType } : {}),
        } });
      } finally {
        request.humanStopSignal?.removeEventListener("abort", stop);
        // Keep the acceptance operation lease until an entered cancellation
        // settles; shutdown must not close SQLite beneath its durable write.
        await cancellation;
      }
    });
  }

  private assertSupportedIngress(channelId: string, request: ChatRequest): void {
    if (channelId === "weixin" && (request.metadata?.chatType === "group" || request.metadata?.groupId)) {
      throw new ConversationError("external_group_unsupported", "Weixin Group Conversation delivery is not supported");
    }
  }
}
