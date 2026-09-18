import { snapshotBotProfile, type BotProfile } from "../bots/bot-types";
import { BotError } from "../bots/bot-error";
import type { BotRuntimeManager } from "../bots/bot-runtime-manager";
import {
  classifyDirectBotBindingSessionLink,
  classifyDirectBotRuntimeBindingOwnership,
  classifyDirectBotSessionOwnership,
  type BotService,
  type DirectBotRuntimeBinding,
} from "../bots/bot-service";
import { planDirectConversation, presentDefaultDirectTopic, presentDirectConversation } from "./direct-conversation";
import { createDirectBindingId, createDirectTopicId, createTopicId } from "../domain/ids";
import { AsyncMutex } from "../orchestration/async-mutex";
import type { ReleaseOwnedSession } from "../sessions/owned-session-release";
import type { SessionService } from "../sessions/session-service";
import { replaceRuntimeState } from "../state/replace-runtime-state";
import type { StateStore } from "../state/state-store";
import type { AppState } from "../state/types";
import { ConversationError } from "./conversation-error";
import type { ConversationDispatcher } from "./conversation-dispatcher";
import { parseHumanIngress } from "./conversation-execution";
import {
  emitConversationProductEvent,
  type ConversationProductEventSink,
} from "./conversation-product-events";
import type { AcceptRequestResult, ConversationStore, ListMessagesQuery } from "./conversation-store";
import type {
  ConversationMessage,
  ConversationRecord,
  ConversationRun,
  ConversationTopic,
  HumanIngressContext,
  MemberTurnRecord,
} from "./conversation-types";

export interface ConversationRunServiceOptions {
  now?: () => Date;
  createTopicId?: () => string;
  stateMutex?: AsyncMutex;
  beforeAcceptPersist?: () => Promise<void>;
  beforeTeardownFinalize?: () => Promise<void>;
  afterTeardownMarkedDeleting?: () => Promise<void>;
  autoKick?: boolean;
  /** Verified physical+logical release. Required; never LogicalSession-only. */
  releaseOwnedSession: ReleaseOwnedSession;
  onProductEvent?: ConversationProductEventSink;
}

export interface ConversationHistoryPage {
  messages: ConversationMessage[];
  oldestSeq?: number;
  newestSeq?: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

type SessionWriter = Pick<StateStore, "save"> & { saveNow?: (state: AppState) => Promise<void> };

export class ConversationRunService {
  private readonly now: () => Date;
  private readonly createTopicIdFn: () => string;
  private readonly stateMutex: AsyncMutex;
  private readonly beforeAcceptPersist?: () => Promise<void>;
  private readonly beforeTeardownFinalize?: () => Promise<void>;
  private readonly afterTeardownMarkedDeleting?: () => Promise<void>;
  private readonly autoKick: boolean;
  /** `pending` until the first successful post-lock kick; `unavailable` is sticky
   *  fail-closed after that kick throws so accept cannot pile up unconsumed work. */
  private activation: "pending" | "activated" | "unavailable" = "pending";
  private readonly releaseOwnedSession: ReleaseOwnedSession;
  private readonly onProductEvent?: ConversationProductEventSink;
  private closed = false;

  constructor(
    private readonly store: ConversationStore,
    private readonly bots: BotService,
    private readonly runtime: BotRuntimeManager,
    private readonly dispatcher: ConversationDispatcher,
    private readonly sessions: Pick<SessionService, "getLogicalSessionRecord">,
    private readonly state: AppState,
    private readonly stateStore: SessionWriter,
    options: ConversationRunServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.createTopicIdFn = options.createTopicId ?? (() => createTopicId());
    this.stateMutex = options.stateMutex ?? new AsyncMutex();
    this.beforeAcceptPersist = options.beforeAcceptPersist;
    this.beforeTeardownFinalize = options.beforeTeardownFinalize;
    this.afterTeardownMarkedDeleting = options.afterTeardownMarkedDeleting;
    this.autoKick = options.autoKick ?? true;
    this.releaseOwnedSession = options.releaseOwnedSession;
    this.onProductEvent = options.onProductEvent;
    this.bots.setConversationWork(this.store);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new ConversationError("store_closed", "conversation store is closed");
    }
  }

  stop(): void {
    this.closed = true;
    this.dispatcher.stop();
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await this.dispatcher.shutdown();
    this.store.close();
  }

  /**
   * Start durable Conversation consume after this process holds the daemon
   * consumer lock. `buildApp` must not call this. Accept-time `autoKick`
   * stays inert until this kick succeeds. A failed first drain leaves the
   * consumer unavailable — not activated — so later accept cannot enqueue
   * work the dispatcher cannot move.
   */
  async activateAfterConsumerLock(): Promise<void> {
    this.assertOpen();
    try {
      await this.dispatcher.kick();
    } catch (error) {
      this.activation = "unavailable";
      throw error;
    }
    this.activation = "activated";
  }

  isConsumerActivated(): boolean {
    return this.activation === "activated";
  }

  private assertAccepting(): void {
    this.assertOpen();
    if (this.activation === "unavailable") {
      throw new ConversationError(
        "conversations_unavailable",
        "Conversation consumer failed to activate; new work is not accepted",
      );
    }
  }

  async acceptDirectPrompt(input: {
    botId: string;
    requestId: string;
    content: string;
    conversationId?: string;
    topicId?: string;
    humanIngress?: HumanIngressContext;
  }): Promise<AcceptRequestResult> {
    this.assertAccepting();
    const accepted = await this.bots.runLifecycle(input.botId, async () => {
      const bot = this.bots.getBot(input.botId);
      const timestamp = this.now().toISOString();
      const planned = this.planDirect(bot);
      const conversationId = input.conversationId ?? planned.conversation.id;
      if (conversationId !== planned.conversation.id) {
        throw new BotError("conversation_mismatch", "direct Bot conversation does not match this Bot");
      }
      const topicId = input.topicId ?? planned.topic.id;
      const existing = this.store.getAcceptedRequest(conversationId, topicId, input.requestId);
      if (existing) {
        return existing;
      }
      if (!bot.enabled) {
        throw new BotError("bot_disabled", `bot "${input.botId}" is disabled`);
      }
      if (topicId !== planned.topic.id) {
        const topic = this.state.conversation_topics[topicId];
        if (!topic || topic.conversationId !== conversationId) {
          throw new BotError("topic_not_found", `topic "${topicId}" does not belong to this Bot conversation`);
        }
      }
      if (this.store.isConversationDeleting(conversationId) || this.store.isTopicDeleting(topicId)) {
        throw new ConversationError("conversation_deleting", "conversation is deleting");
      }
      const snapshot = snapshotBotProfile(bot, timestamp);
      await this.beforeAcceptPersist?.();
      const humanIngress = parseHumanIngress(input.humanIngress);
      const created = this.store.acceptRequest({
        conversationId,
        topicId,
        requestId: input.requestId,
        botId: bot.id,
        content: input.content,
        profileSnapshot: snapshot,
        now: timestamp,
        ...(humanIngress
          ? { authorityEpoch: this.dispatcher.authorityEpoch, humanIngress }
          : {}),
      });
      return created;
    });
    if (!accepted.reused) {
      this.emitAcceptProjection(accepted);
    }
    if (this.autoKick && this.activation === "activated") {
      void this.dispatcher.kick();
    }
    return accepted;
  }

  async acceptConversationPrompt(input: {
    conversationId: string;
    topicId: string;
    requestId: string;
    text: string;
    targetBotId?: string;
    humanIngress?: HumanIngressContext;
  }): Promise<AcceptRequestResult> {
    this.assertOpen();
    const botId = this.resolveDirectBotId(input.conversationId);
    if (input.targetBotId && input.targetBotId !== botId) {
      throw new ConversationError(
        "conversation_target_mismatch",
        "Direct conversation target must match the owning Bot",
      );
    }
    return this.acceptDirectPrompt({
      botId,
      requestId: input.requestId,
      content: input.text,
      conversationId: input.conversationId,
      topicId: input.topicId,
      ...(input.humanIngress ? { humanIngress: input.humanIngress } : {}),
    });
  }

  getConversation(conversationId: string): ConversationRecord {
    this.assertOpen();
    return this.presentDirect(this.requireConversation(conversationId));
  }

  listConversations(filter?: { botId?: string }): ConversationRecord[] {
    this.assertOpen();
    const byId = new Map<string, ConversationRecord>();
    for (const conversation of Object.values(this.state.conversations)) {
      if (conversation.kind !== "bot") {
        continue;
      }
      if (filter?.botId && !conversation.botIds.includes(filter.botId)) {
        continue;
      }
      byId.set(conversation.id, conversation);
    }
    for (const bot of this.bots.listBots()) {
      if (filter?.botId && bot.id !== filter.botId) {
        continue;
      }
      const planned = this.planDirect(bot);
      if (!byId.has(planned.conversation.id)) {
        byId.set(planned.conversation.id, planned.conversation);
      }
    }
    return [...byId.values()]
      .map((conversation) => this.presentDirect(conversation))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  listTopics(conversationId: string): ConversationTopic[] {
    this.assertOpen();
    const conversation = this.requireConversation(conversationId);
    const topics = Object.values(this.state.conversation_topics)
      .filter((topic) => topic.conversationId === conversationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((topic) => this.presentDefaultTopic(topic, conversation));
    if (topics.length > 0) {
      return topics;
    }
    const botId = this.resolveDirectBotId(conversationId);
    const bot = this.bots.getBot(botId);
    return [this.planDirect(bot).topic];
  }

  defaultTopicId(conversationId: string): string | undefined {
    const conversation = this.requireConversation(conversationId);
    const botId = conversation.botIds[0];
    if (conversation.kind !== "bot" || !botId) {
      return undefined;
    }
    return createDirectTopicId(botId);
  }

  getRun(runId: string): { run: ConversationRun; memberTurns: MemberTurnRecord[] } {
    this.assertOpen();
    const run = this.store.getRun(runId);
    if (!run) {
      throw new ConversationError("run_not_found", `run "${runId}" does not exist`);
    }
    return { run, memberTurns: this.store.listMemberTurns(runId) };
  }

  listHistory(query: ListMessagesQuery): ConversationHistoryPage {
    this.assertOpen();
    this.requireConversation(query.conversationId);
    const topic = this.listTopics(query.conversationId).find((item) => item.id === query.topicId);
    if (!topic) {
      throw new BotError("topic_not_found", `topic "${query.topicId}" does not belong to this conversation`);
    }
    const messages = this.store.listMessages(query);
    const oldestSeq = messages[0]?.seq;
    const newestSeq = messages[messages.length - 1]?.seq;
    const hasMoreBefore = oldestSeq !== undefined
      && this.store.listMessages({
        conversationId: query.conversationId,
        topicId: query.topicId,
        beforeSeq: oldestSeq,
        limit: 1,
      }).length > 0;
    const hasMoreAfter = newestSeq !== undefined
      && this.store.listMessages({
        conversationId: query.conversationId,
        topicId: query.topicId,
        afterSeq: newestSeq,
        limit: 1,
      }).length > 0;
    return {
      messages,
      hasMoreBefore,
      hasMoreAfter,
      ...(oldestSeq !== undefined ? { oldestSeq } : {}),
      ...(newestSeq !== undefined ? { newestSeq } : {}),
    };
  }

  listTopicRuns(conversationId: string, topicId: string, options?: { limit?: number }): { runs: ConversationRun[]; activeRunId?: string } {
    this.assertOpen();
    this.requireConversation(conversationId);
    const limit = options?.limit ?? 50;
    const all = this.store.listRuns(conversationId, topicId);
    // Exactly one Run executes per Topic: a running/waiting-human Run owns the
    // Topic and later accepts stay queued in durable seq order. Select from the
    // full durable set so a bounded page cannot hide the true owner; the page
    // itself stays the newest slice for transport bounding.
    const executing = all.find((run) => run.state === "running" || run.state === "waiting-human");
    const nextQueued = all.find((run) => run.state === "queued");
    const active = executing ?? nextQueued;
    const runs = all.slice(-limit);
    const activeInPage = active && runs.some((run) => run.id === active.id) ? active : undefined;
    return { runs, ...(activeInPage ? { activeRunId: activeInPage.id } : {}) };
  }

  async createDirectTopic(botId: string, title: string): Promise<ConversationTopic> {
    this.assertOpen();
    const topic = await this.bots.runLifecycle(botId, async () => {
      const bot = this.bots.getBot(botId);
      const timestamp = this.now().toISOString();
      const planned = this.planDirect(bot);
      this.assertConversationNotDeleting(planned.conversation.id);
      return await this.stateMutex.run(async () => {
        this.assertConversationNotDeleting(planned.conversation.id);
        const created: ConversationTopic = {
          id: this.nextTopicId(),
          conversationId: planned.conversation.id,
          title: title.trim() || "Topic",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        const next = structuredClone(this.state);
        next.conversations[planned.conversation.id] = next.conversations[planned.conversation.id] ?? planned.conversation;
        next.conversation_topics[planned.topic.id] = next.conversation_topics[planned.topic.id] ?? planned.topic;
        next.conversation_topics[created.id] = created;
        await this.persist(next);
        return created;
      });
    });
    emitConversationProductEvent(this.onProductEvent, { type: "conversations-changed" });
    emitConversationProductEvent(this.onProductEvent, { type: "conversation-topic-changed", topic });
    return topic;
  }

  async createTopic(conversationId: string, title: string): Promise<ConversationTopic> {
    return this.createDirectTopic(this.resolveDirectBotId(conversationId), title);
  }

  async cancelRun(runId: string): Promise<void> {
    this.assertOpen();
    await this.dispatcher.cancelRun(runId);
  }

  async teardownDirectConversation(botId: string): Promise<void> {
    this.assertOpen();
    const bot = this.bots.getBot(botId);
    const timestamp = this.now().toISOString();
    const planned = this.planDirect(bot);
    const conversationId = planned.conversation.id;
    await this.bots.runLifecycle(botId, async () => {
      // Validate every ownership signal before making teardown externally visible.
      // A contradiction must leave the Conversation active and all physical state intact.
      this.ownedAliases(botId, conversationId);
      this.store.markConversationDeleting(conversationId, timestamp);
      await this.markAppStateDeleting(conversationId);
    });
    await this.afterTeardownMarkedDeleting?.();

    const runs = this.store.listRuns(conversationId);
    for (const run of runs) {
      if (run.state === "queued" || run.state === "running" || run.state === "waiting-human") {
        await this.dispatcher.cancelRun(run.id);
      }
    }
    this.store.recoverExpiredClaims(this.now().toISOString());
    const remaining = this.store.listRuns(conversationId);
    const indeterminate = remaining.filter((run) => run.state === "indeterminate");
    if (indeterminate.length > 0) {
      throw new ConversationError("conversation_indeterminate", "conversation has indeterminate work", {
        runIds: indeterminate.map((run) => run.id),
      });
    }

    for (const alias of this.ownedAliases(botId, conversationId)) {
      if (this.sessions.getLogicalSessionRecord(alias)) {
        await this.releaseAlias(alias);
      }
    }

    await this.bots.runLifecycle(botId, async () => {
      await this.beforeTeardownFinalize?.();
      for (const alias of this.ownedAliases(botId, conversationId)) {
        if (this.sessions.getLogicalSessionRecord(alias)) {
          await this.releaseAlias(alias);
        }
      }
      await this.stateMutex.run(async () => {
        const next = structuredClone(this.state);
        for (const [id, binding] of Object.entries(next.bot_runtime_bindings)) {
          if (
            binding.scope === "bot-direct"
            && binding.botId === botId
            && binding.conversationId === conversationId
          ) {
            delete next.bot_runtime_bindings[id];
          }
        }
        for (const [id, topic] of Object.entries(next.conversation_topics)) {
          if (topic.conversationId === conversationId) {
            delete next.conversation_topics[id];
          }
        }
        delete next.conversations[conversationId];
        await this.persist(next);
      });
      this.store.deleteConversationRows(conversationId);
    });
  }

  private emitAcceptProjection(accepted: AcceptRequestResult): void {
    emitConversationProductEvent(this.onProductEvent, { type: "conversations-changed" });
    emitConversationProductEvent(this.onProductEvent, { type: "conversation-message", message: accepted.message });
    emitConversationProductEvent(this.onProductEvent, { type: "conversation-run-changed", run: accepted.run });
  }

  private requireConversation(conversationId: string): ConversationRecord {
    const existing = this.state.conversations[conversationId];
    if (existing) {
      return existing;
    }
    for (const bot of this.bots.listBots()) {
      const planned = this.planDirect(bot);
      if (planned.conversation.id === conversationId) {
        return planned.conversation;
      }
    }
    throw new ConversationError("conversation_not_found", `conversation "${conversationId}" does not exist`);
  }

  private presentDirect(conversation: ConversationRecord): ConversationRecord {
    const botId = conversation.botIds[0];
    if (conversation.kind !== "bot" || !botId) {
      return conversation;
    }
    const bot = this.state.bots[botId];
    if (!bot) {
      return conversation;
    }
    return presentDirectConversation(conversation, bot);
  }

  private presentDefaultTopic(topic: ConversationTopic, conversation: ConversationRecord): ConversationTopic {
    const botId = conversation.botIds[0];
    if (conversation.kind !== "bot" || !botId) {
      return topic;
    }
    const bot = this.state.bots[botId];
    if (!bot) {
      return topic;
    }
    return presentDefaultDirectTopic(topic, bot);
  }

  private planDirect(bot: Pick<BotProfile, "id" | "name" | "createdAt" | "updatedAt">) {
    return planDirectConversation(this.state, {
      botId: bot.id,
      title: bot.name,
      createdAt: bot.createdAt,
      updatedAt: bot.updatedAt,
    });
  }

  private resolveDirectBotId(conversationId: string): string {
    const conversation = this.requireConversation(conversationId);
    const botId = conversation.botIds[0];
    if (conversation.kind !== "bot" || conversation.botIds.length !== 1 || !botId) {
      throw new ConversationError(
        "conversation_not_direct",
        "conversation is not a Direct Bot conversation",
      );
    }
    return botId;
  }

  private nextTopicId(): string {
    const id = this.createTopicIdFn();
    return id.startsWith("topic_") ? id : createTopicId(() => id);
  }

  private assertConversationNotDeleting(conversationId: string): void {
    if (
      this.store.isConversationDeleting(conversationId)
      || this.state.conversations[conversationId]?.lifecycle === "deleting"
    ) {
      throw new ConversationError("conversation_deleting", "conversation is deleting");
    }
  }

  private async markAppStateDeleting(conversationId: string): Promise<void> {
    await this.stateMutex.run(async () => {
      const conversation = this.state.conversations[conversationId];
      if (!conversation) {
        return;
      }
      const next = structuredClone(this.state);
      next.conversations[conversationId] = {
        ...conversation,
        lifecycle: "deleting",
        updatedAt: this.now().toISOString(),
      };
      for (const [id, topic] of Object.entries(next.conversation_topics)) {
        if (topic.conversationId === conversationId && topic.status === "active") {
          next.conversation_topics[id] = { ...topic, status: "deleting", updatedAt: this.now().toISOString() };
        }
      }
      await this.persist(next);
    });
  }

  private ownedAliases(botId: string, conversationId: string): string[] {
    const aliases = new Set<string>();
    const ownedBindingIds = new Set<string>([createDirectBindingId(botId)]);
    const ownedBindings: DirectBotRuntimeBinding[] = [];

    for (const binding of Object.values(this.state.bot_runtime_bindings)) {
      const ownership = classifyDirectBotRuntimeBindingOwnership(binding, botId, conversationId);
      if (ownership === "conflict") {
        throw new ConversationError(
          "runtime_ownership_conflict",
          "direct runtime binding ownership metadata is contradictory",
          { botId, binding },
        );
      }
      if (ownership === "owned" && binding.scope === "bot-direct") {
        ownedBindingIds.add(binding.id);
        ownedBindings.push(binding);
      }
    }

    // A binding is only destructive authority when alias and logical id resolve to
    // one exact owned session. Missing on both axes is a harmless stale binding that
    // final cleanup may remove; any partial/mismatched link fails closed.
    const allSessions = Object.values(this.state.sessions);
    for (const binding of ownedBindings) {
      const byAlias = this.state.sessions[binding.sessionAlias];
      const byIdMatches = allSessions.filter(
        (session) => session.logical_session_id === binding.logicalSessionId,
      );
      if (!byAlias && byIdMatches.length === 0) {
        continue;
      }
      if (
        !byAlias
        || byIdMatches.length !== 1
        || byIdMatches[0]?.alias !== byAlias.alias
        || classifyDirectBotBindingSessionLink(binding, byAlias, ownedBindingIds) !== "owned"
      ) {
        throw new ConversationError(
          "runtime_ownership_conflict",
          "direct runtime binding/session link is contradictory",
          { botId, binding, sessionAlias: byAlias?.alias },
        );
      }
      aliases.add(byAlias.alias);
    }

    // Binding-less PR2 owners are still recoverable, but every ownership signal
    // must agree with the same target Bot/conversation.
    for (const session of allSessions) {
      const ownership = classifyDirectBotSessionOwnership(
        session,
        botId,
        ownedBindingIds,
        conversationId,
      );
      if (ownership === "conflict") {
        throw new ConversationError(
          "runtime_ownership_conflict",
          "direct session ownership metadata is contradictory",
          { botId, alias: session.alias, owner: session.owner },
        );
      }
      if (ownership === "owned") {
        aliases.add(session.alias);
      }
    }
    return [...aliases];
  }

  private async releaseAlias(alias: string): Promise<void> {
    try {
      await this.releaseOwnedSession(alias);
    } catch (error) {
      if (error instanceof ConversationError && error.code === "session_release_failed") {
        throw error;
      }
      throw new ConversationError(
        "session_release_failed",
        error instanceof Error ? error.message : String(error),
        { alias },
      );
    }
  }

  private async persist(next: AppState): Promise<void> {
    if (typeof this.stateStore.saveNow === "function") {
      await this.stateStore.saveNow(next);
    } else {
      await this.stateStore.save(next);
    }
    replaceRuntimeState(this.state, next);
  }
}
