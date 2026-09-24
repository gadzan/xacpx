import { snapshotBotProfile, type BotProfile } from "../bots/bot-types";
import { BotError } from "../bots/bot-error";
import type { BotRuntimeManager } from "../bots/bot-runtime-manager";
import {
  classifyDirectBotBindingSessionLink,
  classifyDirectBotRuntimeBindingOwnership,
  classifyDirectBotSessionOwnership,
  classifyGroupMemberBindingOwnership,
  classifyGroupMemberBindingSessionLink,
  type BotService,
  type DirectBotRuntimeBinding,
  type GroupMemberRuntimeBinding,
} from "../bots/bot-service";
import { planDirectConversation, presentDefaultDirectTopic, presentDirectConversation } from "./direct-conversation";
import { createDirectBindingId, createDirectTopicId, createScopedGroupMemberBindingId, createTopicId } from "../domain/ids";
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
  ExecutionTarget,
  HumanIngressContext,
  MemberTurnRecord,
  WorkspaceIsolationPolicy,
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
      await this.recoverRootlessGroupMemberSessions();
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

  /** Wake pending durable work (e.g. after a Bot re-enables). Activation-
   *  aware: when the consumer never activated (initial recovery failure),
   *  Conversation work must stay parked — a Bot lifecycle event must not
   *  bypass the fail-closed unavailable gate via a direct dispatcher kick. */
  wakePendingWork(): void {
    if (this.activation !== "activated" || this.closed) return;
    void this.dispatcher.kick().catch(() => {});
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
    const conversation = this.requireConversation(conversationId);
    if (conversation.kind !== "bot") {
      throw new ConversationError(
        "conversation_not_direct",
        `conversation "${conversationId}" is not a Direct Bot conversation`,
      );
    }
    return this.presentDirect(conversation);
  }

  listConversations(filter?: { botId?: string }): ConversationRecord[] {
    this.assertOpen();
    // Direct-only by design: Group Conversations are invisible to the PR5
    // direct list (and its Web consumer). PR7 adds a separate group listing;
    // never merge kinds here — a group row would break the direct presenter
    // below, which assumes exactly one Bot.
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
    // Group Conversations have no synthetic default Topic: an empty group
    // lists zero topics until createGroupTopic persists one. Only direct
    // Conversations synthesize their deterministic default.
    if (conversation.kind !== "bot") {
      return [];
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

  listTopicRuns(conversationId: string, topicId: string, options?: { limit?: number }): { runs: ConversationRun[]; activeRunId?: string; activeRun?: ConversationRun } {
    this.assertOpen();
    this.requireConversation(conversationId);
    const limit = options?.limit ?? 50;
    const all = this.store.listRuns(conversationId, topicId);
    // Exactly one Run executes per Topic: a running/waiting-human Run owns the
    // Topic and later accepts stay queued in durable seq order. Select from the
    // full durable set: paging bounds the `runs` transport payload, never the
    // active identity. The owner is always returned (even outside the page) so
    // refresh/reconnect recovery cannot lose the executing or next-up Run.
    const executing = all.find((run) => run.state === "running" || run.state === "waiting-human");
    const nextQueued = all.find((run) => run.state === "queued");
    const active = executing ?? nextQueued;
    const runs = all.slice(-limit);
    return { runs, ...(active ? { activeRunId: active.id, activeRun: active } : {}) };
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
  /**
   * PR6 Group Topic lifecycle. Creates a Topic under a group Conversation
   * with an explicit ExecutionTarget. The workspace must be registered; the
   * isolation policy is validated against the known enum. worktree-per-member
   * persists as a value but has no provisioning yet (PR10): callers must not
   * assume an isolated tree exists. Direct Conversations keep resolving
   * execution from the owning Bot profile and never take this path.
   */
  async createGroupTopic(
    conversationId: string,
    title: string,
    target: { workspace: string; cwd?: string; isolation: WorkspaceIsolationPolicy },
  ): Promise<ConversationTopic> {
    this.assertOpen();
    const conversation = this.requireConversation(conversationId);
    if (conversation.kind !== "group") {
      throw new ConversationError("conversation_not_group", `conversation "${conversationId}" is not a Group`);
    }
    this.assertConversationNotDeleting(conversationId);
    const executionTarget = this.requireExecutionTarget(target);
    const timestamp = this.now().toISOString();
    const created = await this.stateMutex.run(async () => {
      this.assertConversationNotDeleting(conversationId);
      const topic: ConversationTopic = {
        id: this.nextTopicId(),
        conversationId,
        title: title.trim() || "Topic",
        status: "active",
        executionTarget,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const next = structuredClone(this.state);
      next.conversation_topics[topic.id] = topic;
      await this.persist(next);
      return topic;
    });
    emitConversationProductEvent(this.onProductEvent, { type: "conversations-changed" });
    emitConversationProductEvent(this.onProductEvent, { type: "conversation-topic-changed", topic: created });
    return created;
  }

  async archiveGroupTopic(conversationId: string, topicId: string): Promise<ConversationTopic> {
    this.assertOpen();
    const archived = await this.stateMutex.run(async () => {
      const topic = this.requireGroupTopic(conversationId, topicId);
      if (topic.status !== "active") {
        return topic;
      }
      const next = structuredClone(this.state);
      next.conversation_topics[topicId] = {
        ...topic,
        status: "archived",
        updatedAt: this.now().toISOString(),
      };
      await this.persist(next);
      return next.conversation_topics[topicId]!;
    });
    emitConversationProductEvent(this.onProductEvent, { type: "conversations-changed" });
    emitConversationProductEvent(this.onProductEvent, { type: "conversation-topic-changed", topic: archived });
    return archived;
  }

  private requireGroupTopic(conversationId: string, topicId: string): ConversationTopic {
    const conversation = this.requireConversation(conversationId);
    if (conversation.kind !== "group") {
      throw new ConversationError("conversation_not_group", `conversation "${conversationId}" is not a Group`);
    }
    const topic = this.state.conversation_topics[topicId];
    if (!topic || topic.conversationId !== conversationId) {
      throw new BotError("topic_not_found", `topic "${topicId}" does not belong to this Group`);
    }
    return topic;
  }
  private requireExecutionTarget(target: {
    workspace: string;
    cwd?: string;
    isolation: WorkspaceIsolationPolicy;
  }): ExecutionTarget {
    if (!target || typeof target.workspace !== "string" || !target.workspace) {
      throw new BotError("workspace_not_registered", "group Topic workspace must be a registered workspace");
    }
    this.bots.assertWorkspaceRegistered(target.workspace);
    if (target.isolation !== "shared"
      && target.isolation !== "shared-single-writer"
      && target.isolation !== "worktree-per-member") {
      throw new ConversationError("invalid-isolation", `unknown isolation policy "${target.isolation}"`);
    }
    // Topic cwd is not honored by member session materialization yet (the
    // resolved session cwd still comes from the workspace config). Persisting
    // a non-empty cwd would be a silent no-op: the Topic would look scoped to
    // /repo/subdir while execution runs in the workspace root. Fail closed
    // like Bot cwd until transport launch honors it.
    if (target.cwd !== undefined && target.cwd.trim() !== "") {
      throw new BotError("cwd_unsupported", "group Topic cwd is not supported until runtime launch honors it");
    }
    return {
      workspace: target.workspace,
      isolation: target.isolation,
    };
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
  /**
   * PR6 Group delete (§9.1 + §9.7): mark the Group deleting first (new Topics
   * and new Group work fail closed from there), teardown every remaining
   * Topic through the verified path, delete residual Conversation-store rows,
   * then remove the Group metadata record itself last. A Topic teardown that
   * throws (indeterminate work, release failure, ownership conflict) aborts
   * the delete with the Group row and the deleting barrier intact for retry.
   * `BotService.deleteGroup` is a separate fail-closed metadata-only API that
   * refuses while Topics/bindings/durable rows exist; this verified teardown
   * is the only path that removes the record after teardown, never
   * `BotService.deleteGroup`.
   */
  async teardownGroupConversation(conversationId: string): Promise<void> {
    this.assertOpen();
    const conversation = this.requireConversation(conversationId);
    if (conversation.kind !== "group") {
      throw new ConversationError("conversation_not_group", `conversation "${conversationId}" is not a Group`);
    }
    // Barrier first: once the Group is marked deleting, createGroupTopic and
    // any new Group work fail closed, so no Topic created concurrently can
    // outlive this teardown and become an orphan. Mirrors
    // teardownDirectConversation (SQLite barrier authoritative for
    // accept/dispatch; AppState lifecycle flag is bounded metadata).
    const timestamp = this.now().toISOString();
    this.store.markConversationDeleting(conversationId, timestamp);
    await this.markAppStateDeleting(conversationId);
    await this.afterTeardownMarkedDeleting?.();
    // Re-enumerate Topics after the barrier: a Topic created just before the
    // barrier landed is still torn down here instead of orphaned.
    const topics = Object.values(this.state.conversation_topics)
      .filter((topic) => topic.conversationId === conversationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const topic of topics) {
      await this.teardownGroupTopic(conversationId, topic.id);
    }
    // Ghost-topic durable work: runs whose Topic metadata is already gone
    // (missing-Topic rows) never entered teardownGroupTopic above. Cancel
    // every non-terminal run and reconcile to terminal before deleting rows —
    // deleting live work with the cleanup root would strand it with no
    // cancel/reconcile entrypoint.
    const ghostRuns = this.store.listRuns(conversationId)
      .filter((run) => run.state === "queued" || run.state === "running" || run.state === "waiting-human");
    for (const run of ghostRuns) {
      await this.dispatcher.cancelRun(run.id);
    }
    this.store.recoverExpiredClaims(this.now().toISOString());
    const unsettled = this.store.listRuns(conversationId)
      .filter((run) => run.state === "queued" || run.state === "running" || run.state === "waiting-human");
    if (unsettled.length > 0) {
      throw new ConversationError("conversation_not_settled", "group has unsettled runs", {
        runIds: unsettled.map((run) => run.id),
      });
    }
    const ghostIndeterminate = this.store.listRuns(conversationId)
      .filter((run) => run.state === "indeterminate");
    if (ghostIndeterminate.length > 0) {
      throw new ConversationError("conversation_indeterminate", "group has indeterminate work", {
        runIds: ghostIndeterminate.map((run) => run.id),
      });
    }
    // Store rows BEFORE the Group record: if deleteConversationRows throws
    // (or the process crashes between the two steps), the Group row and the
    // deleting barrier are still present, so teardown is retryable and the
    // fail-closed BotService.deleteGroup guard still sees the durable rows.
    // Deleting the record first would strand rows no guard can see.
    this.store.deleteConversationRows(conversationId);
    // Final residue fence: no group-member binding or owned session may
    // survive the Group record. Ghost-topic bindings/sessions (Topic row
    // already gone) and binding-less crash-window owners are all covered —
    // either verified-released here or fail closed with barrier intact.
    await this.releaseGroupResidue(conversationId);
    await this.stateMutex.run(async () => {
      await this.beforeTeardownFinalize?.();
      this.assertNoGroupResidue(conversationId);
      const next = structuredClone(this.state);
      delete next.conversations[conversationId];
      await this.persist(next);
    });
  }

  /**
   * Release every group-member runtime residue for a Group whose Topics are
   * all gone: live bindings (alias+id verified), exact binding-less owners,
   * and legacy partial owners resolvable through a same-group binding.
   * Rootless orphans (missing Topic row, kept by load reconcile with their
   * ownership intact) sweep here too: their owner triple still names this
   * Group, so they release by alias instead of stranding. Contradictory or
   * unresolvable residue fails closed for retry.
   */
  private async releaseGroupResidue(conversationId: string): Promise<void> {
    const bindings = Object.values(this.state.bot_runtime_bindings).filter(
      (binding): binding is GroupMemberRuntimeBinding => binding.scope === "group-member"
        && binding.conversationId === conversationId,
    );
    for (const binding of bindings) {
      const ownership = classifyGroupMemberBindingOwnership(
        binding,
        binding.botId,
        binding.conversationId,
        binding.topicId,
      );
      if (ownership !== "owned") {
        throw new ConversationError(
          "runtime_ownership_conflict",
          "group member binding ownership metadata is contradictory",
          { binding },
        );
      }
      const session = this.sessions.getLogicalSessionRecord(binding.sessionAlias);
      if (session) {
        if (
          classifyGroupMemberBindingSessionLink(
            binding,
            session,
            binding.id,
            binding.botId,
            binding.conversationId,
            binding.topicId,
          ) !== "owned"
        ) {
          throw new ConversationError(
            "runtime_ownership_conflict",
            "group member binding/session link is contradictory",
            { binding, sessionAlias: session.alias },
          );
        }
        await this.releaseAlias(session.alias);
      }
      // Drop the stale binding row itself once its session is gone (or was
      // already gone): same rule as topic-level finalization, where a
      // binding missing on both alias+id axes is harmless residue removed
      // at finalize time rather than a blocker.
      const remaining = this.state.bot_runtime_bindings[binding.id];
      if (remaining) {
        await this.stateMutex.run(async () => {
          const current = this.state.bot_runtime_bindings[binding.id];
          if (!current) {
            return;
          }
          const next = structuredClone(this.state);
          delete next.bot_runtime_bindings[binding.id];
          await this.persist(next);
        });
      }
    }
    // Re-read: releaseAlias mutates live state.
    for (const session of Object.values(this.state.sessions)) {
      const owner = session.owner;
      if (owner?.kind !== "group-member") {
        continue;
      }
      const inGroup = owner.conversationId === conversationId
        || (owner.conversationId === undefined
          && owner.bindingId !== undefined
          && this.state.bot_runtime_bindings[owner.bindingId]?.conversationId === conversationId);
      if (!inGroup) {
        continue;
      }
      // Exact binding-less crash-window owner: bindingId must be the
      // canonical id for its triple (destructive authority, same rule as
      // groupMemberAliases). Anything else fails closed. The Topic row may
      // be gone (rootless orphan kept by load reconcile): the triple still
      // names this Group, so release by alias — no Topic-row gate here,
      // only ownership proof.
      if (
        owner.botId === undefined
        || owner.conversationId === undefined
        || owner.topicId === undefined
        || owner.bindingId !== createScopedGroupMemberBindingId(owner.conversationId, owner.topicId, owner.botId)
      ) {
        throw new ConversationError(
          "runtime_ownership_conflict",
          "group member session ownership metadata is contradictory",
          { alias: session.alias, owner: session.owner },
        );
      }
      await this.releaseAlias(session.alias);
    }
  }

  private assertNoGroupResidue(conversationId: string): void {
    const bindings = Object.values(this.state.bot_runtime_bindings).filter(
      (binding) => binding.scope === "group-member" && binding.conversationId === conversationId,
    );
    if (bindings.length > 0) {
      throw new ConversationError(
        "group_has_runtime",
        `group "${conversationId}" still has runtime bindings`,
        { bindingIds: bindings.map((binding) => binding.id) },
      );
    }
    const sessions = Object.values(this.state.sessions).filter((session) => {
      const owner = session.owner;
      if (owner?.kind !== "group-member") {
        return false;
      }
      if (owner.conversationId !== undefined) {
        return owner.conversationId === conversationId;
      }
      const bound = owner.bindingId !== undefined
        ? this.state.bot_runtime_bindings[owner.bindingId]
        : undefined;
      return bound !== undefined && bound.conversationId === conversationId;
    });
    if (sessions.length > 0) {
      throw new ConversationError(
        "group_has_runtime",
        `group "${conversationId}" still has member sessions`,
        { sessionAliases: sessions.map((session) => session.alias) },
      );
    }
  }
  /**
   * PR6 Group Topic teardown (§9.7): mark deleting → stop/settle active Runs
   * → release all member runtimes → remove bindings → remove
   * Conversation-store rows → remove Topic metadata. Failure at any step
   * leaves the deleting barrier in place so teardown is retryable. No Router
   * or controller session exists in PR6; only group-member bindings are
   * released. A contradictory binding/session link fails closed and leaves
   * everything in place for retry.
   */
  async teardownGroupTopic(conversationId: string, topicId: string): Promise<void> {
    this.assertOpen();
    this.requireGroupTopic(conversationId, topicId);
    const timestamp = this.now().toISOString();
    // Linearize against member materialization: hold every involved Bot
    // lifecycle gate WHILE setting the deleting barrier, so no materializer
    // can be inside session work when the barrier lands. A materializer that
    // already holds its gate runs first and its session is swept below; one
    // that arrives later queues behind the barrier section and then fails
    // closed on the deleting check. Gates are per-Bot and never hold the
    // shared daemon mutex, so session work inside cannot deadlock.
    const preBotIds = this.groupTopicMemberBotIds(conversationId, topicId);
    await this.bots.runLifecycleAll(preBotIds, async () => {
      this.groupMemberAliases(conversationId, topicId);
      this.store.markTopicDeleting(topicId, conversationId, timestamp);
      await this.stateMutex.run(async () => {
        const topic = this.state.conversation_topics[topicId];
        if (topic && topic.conversationId === conversationId && topic.status === "active") {
          const next = structuredClone(this.state);
          next.conversation_topics[topicId] = { ...topic, status: "deleting", updatedAt: timestamp };
          await this.persist(next);
        }
      });
    });
    await this.afterTeardownMarkedDeleting?.();
    const runs = this.store.listRuns(conversationId, topicId);
    for (const run of runs) {
      if (run.state === "queued" || run.state === "running" || run.state === "waiting-human") {
        await this.dispatcher.cancelRun(run.id);
      }
    }
    this.store.recoverExpiredClaims(this.now().toISOString());
    const remaining = this.store.listRuns(conversationId, topicId);
    const blocking = remaining.filter(
      (run) => run.state === "queued" || run.state === "running" || run.state === "waiting-human",
    );
    if (blocking.length > 0) {
      // Any non-terminal survivor (e.g. an automatic Run awaiting routing
      // after cancel, or a still-running member) fails closed: releasing
      // member sessions while a Run can still execute would strand or
      // orphan live runtime ownership.
      throw new ConversationError("conversation_not_settled", "topic has unsettled runs", {
        runIds: blocking.map((run) => run.id),
      });
    }
    const indeterminate = remaining.filter((run) => run.state === "indeterminate");
    if (indeterminate.length > 0) {
      throw new ConversationError("conversation_indeterminate", "topic has indeterminate work", {
        runIds: indeterminate.map((run) => run.id),
      });
    }
    // Physical/session release runs OUTSIDE the shared daemon mutex: the
    // production release path re-enters it (SessionService.removeSession),
    // and the mutex is non-reentrant. The barrier section above already
    // drained in-flight materializers, so no new owned session can appear
    // here; a survivor is a late write from before the drain (release it
    // now) or contradictory metadata (throws, barrier stays for retry).
    for (const alias of this.groupMemberAliases(conversationId, topicId)) {
      if (this.sessions.getLogicalSessionRecord(alias)) {
        await this.releaseAlias(alias);
      }
    }
    await this.beforeTeardownFinalize?.();
    for (const alias of this.groupMemberAliases(conversationId, topicId)) {
      if (this.sessions.getLogicalSessionRecord(alias)) {
        await this.releaseAlias(alias);
      }
    }
    // Final metadata deletion holds every member gate (recomputed now, so a
    // membership edit or late materializer that landed after the barrier is
    // covered) and re-sweeps ownership inside the gate before deleting
    // metadata: a late session that appeared after the earlier sweeps is
    // released here, not orphaned. The section performs session release
    // OUTSIDE the shared mutex (non-reentrant production path); only the
    // final metadata write holds it.
    await this.bots.runLifecycleAll(
      this.groupTopicMemberBotIds(conversationId, topicId),
      async () => {
        for (const alias of this.groupMemberAliases(conversationId, topicId)) {
          if (this.sessions.getLogicalSessionRecord(alias)) {
            await this.releaseAlias(alias);
          }
        }
        await this.stateMutex.run(async () => {
          const next = structuredClone(this.state);
          for (const [id, binding] of Object.entries(next.bot_runtime_bindings)) {
            if (
              binding.scope === "group-member"
              && binding.conversationId === conversationId
              && binding.topicId === topicId
            ) {
              delete next.bot_runtime_bindings[id];
            }
          }
          this.store.deleteTopicRows(conversationId, topicId);
          delete next.conversation_topics[topicId];
          await this.persist(next);
        });
      },
    );
    // No per-topic tombstone exists: broadcast the coarse refetch so every
    // Relay/plugin consumer drops its stale Topic snapshot. Only after the
    // final gate succeeds — a throw above leaves metadata intact for retry.
    emitConversationProductEvent(this.onProductEvent, { type: "conversations-changed" });
  }

  /**
   * Every Bot whose lifecycle gate can mint a session for this Topic: bound
   * members, crash-window session owners, and the full group membership as a
   * backstop for members with no runtime yet.
   */
  private groupTopicMemberBotIds(conversationId: string, topicId: string): string[] {
    return [...new Set([
      ...Object.values(this.state.bot_runtime_bindings)
        .filter((binding): binding is GroupMemberRuntimeBinding => binding.scope === "group-member"
          && binding.conversationId === conversationId
          && binding.topicId === topicId)
        .map((binding) => binding.botId),
      ...Object.values(this.state.sessions)
        .filter((session) => session.owner?.kind === "group-member"
          && (session.owner.conversationId === undefined || session.owner.conversationId === conversationId)
          && (session.owner.topicId === undefined || session.owner.topicId === topicId)
          && session.owner.botId !== undefined)
        .map((session) => session.owner!.botId!),
      ...(this.state.conversations[conversationId]?.botIds ?? []),
    ])];
  }
  /**
   * Owned member aliases for one Group Topic. Mirrors direct `ownedAliases`:
   * pass 1 walks bindings with an alias+id cross-check (missing on both axes
   * is a harmless stale binding removed by finalization; a partial or
   * mismatched link fails closed), and pass 2 walks every session so a
   * binding-less crash-window owner (session persisted, binding never
   * published) is still released. Any contradiction throws and leaves all
   * physical state intact for retry.
   *
   * Destructive authority is deliberately narrow: a legacy owner that omits
   * scope fields ({ kind, bindingId } only) is NEVER sufficient to release.
   * Group has no safe default scope to guess, so a binding-less session must
   * carry complete botId/conversationId/topicId AND its bindingId must equal
   * the canonical id for that triple. When a binding row exists for the
   * owner's bindingId, that binding must classify as owned for the TARGET
   * triple — a foreign binding (another Group/Topic) is skipped, a conflict
   * fails closed. Otherwise Topic A could release Topic B's session through
   * a partial legacy owner while pass 1 correctly ignores B's binding.
   */
  private groupMemberAliases(conversationId: string, topicId: string): string[] {
    const aliases = new Set<string>();
    const allSessions = Object.values(this.state.sessions);
    for (const binding of Object.values(this.state.bot_runtime_bindings)) {
      if (
        binding.scope !== "group-member"
        || binding.conversationId !== conversationId
        || binding.topicId !== topicId
      ) {
        continue;
      }
      const ownership = classifyGroupMemberBindingOwnership(
        binding,
        binding.botId,
        conversationId,
        topicId,
      );
      if (ownership === "conflict") {
        throw new ConversationError(
          "runtime_ownership_conflict",
          "group member binding ownership metadata is contradictory",
          { binding },
        );
      }
      if (ownership !== "owned") {
        continue;
      }
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
        || classifyGroupMemberBindingSessionLink(
          binding,
          byAlias,
          binding.id,
          binding.botId,
          conversationId,
          topicId,
        ) !== "owned"
      ) {
        throw new ConversationError(
          "runtime_ownership_conflict",
          "group member binding/session link is contradictory",
          { binding, sessionAlias: byAlias?.alias },
        );
      }
      aliases.add(byAlias.alias);
    }
    for (const session of allSessions) {
      const owner = session.owner;
      if (owner?.kind !== "group-member") {
        continue;
      }
      const bound = this.state.bot_runtime_bindings[owner.bindingId];
      if (bound) {
        // A live binding row pins the true triple. Classify it against THIS
        // teardown target: foreign means another Topic's session — skip.
        // Conflict means contradictory metadata — fail closed for retry.
        // A non-group-member row under the same id is foreign by definition.
        if (bound.scope !== "group-member") {
          continue;
        }
        const targetOwnership = classifyGroupMemberBindingOwnership(bound, bound.botId, conversationId, topicId);
        if (targetOwnership !== "owned") {
          if (targetOwnership === "conflict") {
            throw new ConversationError(
              "runtime_ownership_conflict",
              "group member session binding metadata is contradictory",
              { alias: session.alias, owner: session.owner },
            );
          }
          continue;
        }
        // The binding belongs to this triple: the session must link to it
        // exactly, with complete scope fields — no legacy guessing.
        if (
          owner.botId === undefined
          || owner.conversationId === undefined
          || owner.topicId === undefined
          || classifyGroupMemberBindingSessionLink(
            bound,
            session,
            bound.id,
            bound.botId,
            conversationId,
            topicId,
          ) !== "owned"
        ) {
          throw new ConversationError(
            "runtime_ownership_conflict",
            "group member session ownership metadata is contradictory",
            { alias: session.alias, owner: session.owner },
          );
        }
        aliases.add(session.alias);
        continue;
      }
      // A partial legacy owner ({ kind, bindingId } only) can never prove
      // which triple it belongs to, so it is skipped here — never released.
      if (
        owner.botId === undefined
        || owner.conversationId === undefined
        || owner.topicId === undefined
        || owner.conversationId !== conversationId
        || owner.topicId !== topicId
      ) {
        continue;
      }
      if (owner.bindingId !== createScopedGroupMemberBindingId(conversationId, topicId, owner.botId)) {
        throw new ConversationError(
          "runtime_ownership_conflict",
          "group member session ownership metadata is contradictory",
          { alias: session.alias, owner: session.owner },
        );
      }
      aliases.add(session.alias);
    }
    return [...aliases];
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

  /**
   * Activation orphan sweep: release rootless group-member sessions whose
   * Conversation/Topic root is gone (load reconcile kept them with exact
   * canonical ownership as the physical cleanup handle). Runs inside
   * activateAfterConsumerLock BEFORE the first dispatcher kick, while the
   * daemon holds the consumer lock: no dispatcher can claim work for these
   * sessions, and no materializer can publish a binding for them (any live
   * Group with the same id would have been quarantined too — and a live
   * Group makes the owner non-rootless, so it is skipped here).
   *
   * Destructive authority is the load-time canonical rule: kind +
   * botId + conversationId + topicId + canonical bindingId, with the triple
   * still rootless at sweep time (re-checked inside the Bot lifecycle gate,
   * so a concurrently recreated Group/Topic or repaired binding wins and
   * the session is left alone). The Bot gate serializes against a racing
   * materializer for the same Bot: either it publishes first (owner becomes
   * non-rootless or the alias disappears → skip) or the sweep releases
   * first (its later publish fence fails closed on the missing session).
   * Non-canonical rootless owners were already demoted to plain sessions at
   * load and never appear here. A release failure fails activation (consumer
   * stays unavailable) — never a silent skip.
   */
  private async recoverRootlessGroupMemberSessions(): Promise<void> {
    const candidates = Object.values(this.state.sessions).filter((session) => {
      const owner = session.owner;
      if (owner?.kind !== "group-member" || owner.botId === undefined) {
        return false;
      }
      const conversationId = owner.conversationId;
      const topicId = owner.topicId;
      if (conversationId === undefined || topicId === undefined) {
        return false;
      }
      if (owner.bindingId !== createScopedGroupMemberBindingId(conversationId, topicId, owner.botId)) {
        return false;
      }
      const conversation = this.state.conversations[conversationId];
      const topic = this.state.conversation_topics[topicId];
      return !conversation || !topic || topic.conversationId !== conversationId;
    });
    for (const session of candidates) {
      const owner = session.owner;
      if (owner?.kind !== "group-member") {
        continue;
      }
      const botId = owner.botId;
      const conversationId = owner.conversationId;
      const topicId = owner.topicId;
      if (botId === undefined || conversationId === undefined || topicId === undefined) {
        continue;
      }
      const canonicalBindingId = createScopedGroupMemberBindingId(conversationId, topicId, botId);
      await this.bots.runLifecycle(botId, async () => {
        const live = this.sessions.getLogicalSessionRecord(session.alias);
        if (!live || live.owner?.kind !== "group-member" || live.owner.botId !== botId) {
          return;
        }
        // Re-check rootlessness inside the gate: a concurrently recreated
        // Group/Topic (or repaired binding) restores the cleanup root, and
        // the ordinary teardown paths own it from there — never release
        // under a live root.
        const liveConversation = this.state.conversations[conversationId];
        const liveTopic = this.state.conversation_topics[topicId];
        if (liveConversation && liveTopic && liveTopic.conversationId === conversationId) {
          return;
        }
        if (
          live.owner?.conversationId !== conversationId
          || live.owner?.topicId !== topicId
          || live.owner?.bindingId !== canonicalBindingId
        ) {
          return;
        }
        await this.releaseAlias(session.alias);
      });
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
