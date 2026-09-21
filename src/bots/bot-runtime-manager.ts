import { BotError } from "./bot-error";
import { classifyDirectBotSessionOwnership, type BotService } from "./bot-service";
import type { BotProfile, BotProfileExecution, BotRuntimeBinding } from "./bot-types";
import { planDirectConversation } from "../conversations/direct-conversation";
import type { ConversationTopic } from "../conversations/conversation-types";
import {
  createDirectBindingId,
  createDirectConversationId,
  createDirectTopicId,
  createScopedDirectBindingId,
  ownedDirectSessionAlias,
} from "../domain/ids";
import { AsyncMutex } from "../orchestration/async-mutex";
import type { ReleaseOwnedSession } from "../sessions/owned-session-release";
import type { SessionService } from "../sessions/session-service";
import { replaceRuntimeState } from "../state/replace-runtime-state";
import type { StateStore } from "../state/state-store";
import { createBotDirectOwner, type AppState, type LogicalSession } from "../state/types";

export interface BotRuntimeManagerOptions {
  now?: () => Date;
  stateMutex?: AsyncMutex;
  afterDirectSnapshot?: (bot: BotProfile) => Promise<void>;
  /** Verified physical+logical release. Required; never LogicalSession-only. */
  releaseOwnedSession: ReleaseOwnedSession;
}

type SessionWriter = Pick<StateStore, "save"> & { saveNow?: (state: AppState) => Promise<void> };
type DirectBotRuntimeBinding = Extract<BotRuntimeBinding, { scope: "bot-direct" }>;

export class BotRuntimeManager {
  private readonly now: () => Date;
  private readonly stateMutex: AsyncMutex;
  private readonly afterDirectSnapshot?: (bot: BotProfile) => Promise<void>;
  private readonly releaseOwnedSession: ReleaseOwnedSession;

  constructor(
    private readonly bots: BotService,
    private readonly sessions: Pick<
      SessionService,
      "createSession" | "getLogicalSessionRecord" | "getLogicalSessionById" | "setSessionModel" | "setSessionEffort"
    >,
    private readonly state: AppState,
    private readonly stateStore: SessionWriter,
    options: BotRuntimeManagerOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.stateMutex = options.stateMutex ?? new AsyncMutex();
    this.afterDirectSnapshot = options.afterDirectSnapshot;
    this.releaseOwnedSession = options.releaseOwnedSession;
  }

  getBot(botId: string): BotProfile {
    return this.bots.getBot(botId);
  }

  async getOrCreateDirectSession(input: {
    botId: string;
    conversationId?: string;
    topicId?: string;
    execution?: BotProfileExecution;
    /** Runs inside the Bot lifecycle gate before any Session/AppState mutation. */
    assertStillDispatchable?: () => void;
  }): Promise<BotRuntimeBinding> {
    this.requireEnabledBot(input.botId);
    // Every caller enters the per-Bot gate and runs its own claim fence.
    // Do not coalesce onto another caller's authorization promise: a later
    // generation must re-check dispatch/owner/generation/lease and deleting.
    return await this.bots.runLifecycle(input.botId, () => this.materializeDirectSession(input));
  }

  private assertAcceptedStickyIdentity(bot: BotProfile, execution?: BotProfileExecution): void {
    if (!execution) {
      return;
    }
    if (bot.agent !== execution.agent || bot.workspace !== execution.workspace) {
      throw new BotError(
        "runtime_revision_mismatch",
        `bot "${bot.id}" sticky identity no longer matches the accepted execution`,
      );
    }
  }

  async releaseDirectBinding(bindingId: string): Promise<void> {
    const snapshot = this.state.bot_runtime_bindings[bindingId];
    if (!snapshot || snapshot.scope !== "bot-direct") {
      return;
    }
    await this.bots.runLifecycle(snapshot.botId, async () => {
      const live = this.state.bot_runtime_bindings[bindingId];
      if (
        !live
        || live.scope !== "bot-direct"
        || live.sessionAlias !== snapshot.sessionAlias
        || live.logicalSessionId !== snapshot.logicalSessionId
      ) {
        return;
      }
      const ownedSession = this.sessions.getLogicalSessionRecord(live.sessionAlias);
      if (ownedSession) {
        if (ownedSession.logical_session_id !== live.logicalSessionId) {
          throw this.ownershipConflict(live.botId, live.sessionAlias, live, ownedSession);
        }
        this.assertBindingOwnsSession(live, ownedSession);
        await this.releaseOwnedSession(live.sessionAlias);
      }
      const remaining = this.state.bot_runtime_bindings[bindingId];
      if (
        !remaining
        || remaining.sessionAlias !== live.sessionAlias
        || remaining.logicalSessionId !== live.logicalSessionId
      ) {
        return;
      }
      await this.stateMutex.run(async () => {
        const current = this.state.bot_runtime_bindings[bindingId];
        if (
          !current
          || current.sessionAlias !== live.sessionAlias
          || current.logicalSessionId !== live.logicalSessionId
        ) {
          return;
        }
        const next = structuredClone(this.state);
        delete next.bot_runtime_bindings[bindingId];
        if (typeof this.stateStore.saveNow === "function") {
          await this.stateStore.saveNow(next);
        } else {
          await this.stateStore.save(next);
        }
        replaceRuntimeState(this.state, next);
      });
    });
  }

  private async materializeDirectSession(input: {
    botId: string;
    conversationId?: string;
    topicId?: string;
    execution?: BotProfileExecution;
    assertStillDispatchable?: () => void;
  }): Promise<BotRuntimeBinding> {
    input.assertStillDispatchable?.();
    const bot = this.requireEnabledBot(input.botId);
    this.assertAcceptedStickyIdentity(bot, input.execution);
    const scope = this.resolveScope(bot.id, input);
    const scopedId = createScopedDirectBindingId(scope.conversationId, scope.topicId, bot.id);
    const existing = this.findScopedBinding(scope.conversationId, scope.topicId, bot.id);
    if (existing && this.bindingSessionIsLive(existing)) {
      await this.alignSessionRuntime(existing, input.execution ?? bot);
      return existing;
    }
    const adopted = this.findAdoptableLegacyBinding(bot.id, scope);
    if (adopted && this.bindingSessionIsLive(adopted)) {
      await this.alignSessionRuntime(adopted, input.execution ?? bot);
      await this.afterDirectSnapshot?.(bot);
      return await this.publishAdoptedBinding(bot, adopted, scopedId, scope);
    }
    await this.afterDirectSnapshot?.(bot);
    const session = await this.ensureOwnedSession(bot, scopedId, scope, input.execution);
    return await this.publishDirectRuntime(bot, session, scopedId, scope);
  }

  private requireEnabledBot(botId: string): BotProfile {
    const bot = this.bots.getBot(botId);
    if (!bot.enabled) {
      throw new BotError("bot_disabled", `bot "${botId}" is disabled`);
    }
    return bot;
  }

  private resolveScope(botId: string, input: { conversationId?: string; topicId?: string }): {
    conversationId: string;
    topicId: string;
    topic: ConversationTopic;
  } {
    const bot = this.bots.getBot(botId);
    const planned = planDirectConversation(this.state, {
      botId,
      title: bot.name,
      createdAt: bot.createdAt,
      updatedAt: bot.updatedAt,
    });
    if (input.conversationId && input.conversationId !== planned.conversation.id) {
      throw new BotError("conversation_mismatch", "direct Bot conversation does not match this Bot");
    }
    if (!input.topicId || input.topicId === planned.topic.id) {
      return {
        conversationId: planned.conversation.id,
        topicId: planned.topic.id,
        topic: planned.topic,
      };
    }
    const requested = this.state.conversation_topics[input.topicId];
    if (!requested || requested.conversationId !== planned.conversation.id) {
      throw new BotError("topic_not_found", `topic "${input.topicId}" does not belong to this Bot conversation`);
    }
    return {
      conversationId: planned.conversation.id,
      topicId: requested.id,
      topic: requested,
    };
  }

  private findAdoptableLegacyBinding(
    botId: string,
    scope: { conversationId: string; topicId: string },
  ): DirectBotRuntimeBinding | undefined {
    if (scope.conversationId !== createDirectConversationId(botId) || scope.topicId !== createDirectTopicId(botId)) {
      return undefined;
    }
    const legacyId = createDirectBindingId(botId);
    const binding = this.state.bot_runtime_bindings[legacyId];
    if (binding && binding.scope === "bot-direct" && binding.botId === botId) {
      return binding;
    }
    const owned = this.findOwnedSession(legacyId, botId, scope.conversationId);
    if (!owned) {
      return undefined;
    }
    return {
      id: legacyId,
      scope: "bot-direct",
      conversationId: scope.conversationId,
      topicId: scope.topicId,
      botId,
      logicalSessionId: owned.logical_session_id,
      sessionAlias: owned.alias,
      createdAt: owned.created_at,
      updatedAt: owned.last_used_at,
    };
  }

  private async ensureOwnedSession(
    bot: BotProfile,
    bindingId: string,
    scope: { conversationId: string; topicId: string },
    execution?: BotProfileExecution,
  ): Promise<LogicalSession> {
    const alias = ownedDirectSessionAlias(bindingId);
    const current = this.findOwnedSession(bindingId, bot.id, scope.conversationId);
    if (current) {
      return current;
    }
    const occupant = this.sessions.getLogicalSessionRecord(alias);
    if (occupant) {
      const ownership = classifyDirectBotSessionOwnership(
        occupant,
        bot.id,
        this.ownedBindingIdsFor(bot.id, bindingId),
        scope.conversationId,
      );
      if (
        ownership !== "owned"
        || occupant.owner?.kind !== "bot-direct"
        || occupant.owner.bindingId !== bindingId
      ) {
        throw this.ownershipConflict(bot.id, alias, { bindingId, conversationId: scope.conversationId }, occupant);
      }
    }
    const agent = execution?.agent ?? bot.agent;
    const workspace = execution?.workspace ?? bot.workspace;
    const model = execution?.model ?? bot.model;
    const effort = execution?.effort ?? bot.effort;
    if (!occupant) {
      await this.sessions.createSession(alias, agent, workspace, {
        owner: createBotDirectOwner({
          bindingId,
          botId: bot.id,
          conversationId: scope.conversationId,
          topicId: scope.topicId,
        }),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      });
    }
    const record = this.findOwnedSession(bindingId, bot.id, scope.conversationId);
    if (!record) {
      throw new BotError("session_missing", `failed to persist owned session for bot "${bot.id}"`);
    }
    return record;
  }

  private async publishAdoptedBinding(
    bot: BotProfile,
    legacy: DirectBotRuntimeBinding,
    scopedId: string,
    scope: { conversationId: string; topicId: string; topic: ConversationTopic },
  ): Promise<BotRuntimeBinding> {
    const session = this.sessions.getLogicalSessionById(legacy.logicalSessionId)
      ?? this.findOwnedSession(legacy.id, bot.id, scope.conversationId);
    if (!session) {
      throw new BotError("session_missing", `failed to adopt owned session for bot "${bot.id}"`);
    }
    return await this.stateMutex.run(async () => {
      const live = this.findScopedBinding(scope.conversationId, scope.topicId, bot.id);
      if (live && this.bindingSessionIsLive(live)) {
        return live;
      }
      const timestamp = this.now().toISOString();
      const { conversation } = planDirectConversation(this.state, {
        botId: bot.id,
        title: bot.name,
        createdAt: bot.createdAt,
        updatedAt: bot.updatedAt,
      });
      const binding: BotRuntimeBinding = {
        id: scopedId,
        scope: "bot-direct",
        conversationId: conversation.id,
        topicId: scope.topicId,
        botId: bot.id,
        logicalSessionId: session.logical_session_id,
        sessionAlias: session.alias,
        createdAt: legacy.createdAt,
        updatedAt: timestamp,
      };
      const next = structuredClone(this.state);
      next.conversations[conversation.id] = next.conversations[conversation.id] ?? conversation;
      next.conversation_topics[scope.topic.id] = next.conversation_topics[scope.topic.id] ?? scope.topic;
      if (legacy.id !== scopedId) {
        delete next.bot_runtime_bindings[legacy.id];
      }
      const owned = next.sessions[session.alias];
      if (owned) {
        this.assertBindingOwnsSession(legacy, owned);
      }
      if (owned?.owner?.kind === "bot-direct") {
        owned.owner = createBotDirectOwner({
          bindingId: scopedId,
          botId: bot.id,
          conversationId: conversation.id,
          topicId: scope.topicId,
        });
      }
      next.bot_runtime_bindings[scopedId] = binding;
      if (typeof this.stateStore.saveNow === "function") {
        await this.stateStore.saveNow(next);
      } else {
        await this.stateStore.save(next);
      }
      replaceRuntimeState(this.state, next);
      return this.state.bot_runtime_bindings[scopedId]!;
    });
  }

  private async publishDirectRuntime(
    bot: BotProfile,
    session: LogicalSession,
    bindingId: string,
    scope: { conversationId: string; topicId: string; topic: ConversationTopic },
  ): Promise<BotRuntimeBinding> {
    return await this.stateMutex.run(async () => {
      const live = this.findScopedBinding(scope.conversationId, scope.topicId, bot.id);
      if (live && this.bindingSessionIsLive(live)) {
        return live;
      }
      const timestamp = this.now().toISOString();
      const { conversation } = planDirectConversation(this.state, {
        botId: bot.id,
        title: bot.name,
        createdAt: bot.createdAt,
        updatedAt: bot.updatedAt,
      });
      if (scope.conversationId !== conversation.id) {
        throw new BotError("conversation_mismatch", "direct Bot conversation does not match this Bot");
      }
      const binding: BotRuntimeBinding = {
        id: bindingId,
        scope: "bot-direct",
        conversationId: conversation.id,
        topicId: scope.topicId,
        botId: bot.id,
        logicalSessionId: session.logical_session_id,
        sessionAlias: session.alias,
        createdAt: live?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      const next = structuredClone(this.state);
      next.conversations[conversation.id] = next.conversations[conversation.id] ?? conversation;
      next.conversation_topics[scope.topic.id] = next.conversation_topics[scope.topic.id] ?? scope.topic;
      next.bot_runtime_bindings[bindingId] = binding;
      if (typeof this.stateStore.saveNow === "function") {
        await this.stateStore.saveNow(next);
      } else {
        await this.stateStore.save(next);
      }
      replaceRuntimeState(this.state, next);
      return this.state.bot_runtime_bindings[bindingId]!;
    });
  }

  private findScopedBinding(conversationId: string, topicId: string, botId: string): BotRuntimeBinding | undefined {
    const scopedId = createScopedDirectBindingId(conversationId, topicId, botId);
    const scoped = this.state.bot_runtime_bindings[scopedId];
    if (scoped && scoped.scope === "bot-direct" && scoped.botId === botId && scoped.topicId === topicId) {
      return scoped;
    }
    return undefined;
  }

  private ownedBindingIdsFor(botId: string, includeId?: string): Set<string> {
    const ids = new Set<string>([createDirectBindingId(botId)]);
    if (includeId) {
      ids.add(includeId);
    }
    for (const binding of Object.values(this.state.bot_runtime_bindings)) {
      if (binding.scope === "bot-direct" && binding.botId === botId) {
        ids.add(binding.id);
      }
    }
    return ids;
  }

  private ownershipConflict(
    botId: string,
    alias: string,
    binding: Pick<DirectBotRuntimeBinding, "id" | "conversationId"> | { bindingId: string; conversationId: string },
    session: LogicalSession,
  ): BotError {
    return new BotError(
      "runtime_ownership_conflict",
      `direct runtime ownership for session "${alias}" is contradictory`,
      { botId, binding, owner: session.owner },
    );
  }

  private assertBindingOwnsSession(binding: DirectBotRuntimeBinding, session: LogicalSession): void {
    const ownership = classifyDirectBotSessionOwnership(
      session,
      binding.botId,
      this.ownedBindingIdsFor(binding.botId, binding.id),
      binding.conversationId,
    );
    if (
      ownership !== "owned"
      || session.alias !== binding.sessionAlias
      || session.logical_session_id !== binding.logicalSessionId
      || session.owner?.kind !== "bot-direct"
      || session.owner.bindingId !== binding.id
    ) {
      throw this.ownershipConflict(binding.botId, session.alias, binding, session);
    }
  }

  private findOwnedSession(bindingId: string, botId: string, conversationId: string): LogicalSession | undefined {
    for (const session of Object.values(this.state.sessions)) {
      if (session.owner?.kind !== "bot-direct" || session.owner.bindingId !== bindingId) {
        continue;
      }
      const ownership = classifyDirectBotSessionOwnership(
        session,
        botId,
        this.ownedBindingIdsFor(botId, bindingId),
        conversationId,
      );
      if (ownership === "conflict") {
        throw this.ownershipConflict(botId, session.alias, { bindingId, conversationId }, session);
      }
      if (ownership === "owned") {
        return session;
      }
    }
    return undefined;
  }

  private bindingSessionIsLive(binding: DirectBotRuntimeBinding): boolean {
    const session = this.sessions.getLogicalSessionById(binding.logicalSessionId);
    if (!session) {
      return false;
    }
    this.assertBindingOwnsSession(binding, session);
    return true;
  }

  private async alignSessionRuntime(
    binding: BotRuntimeBinding,
    bot: { model?: string; effort?: string },
  ): Promise<void> {
    const session = this.sessions.getLogicalSessionRecord(binding.sessionAlias)
      ?? this.sessions.getLogicalSessionById(binding.logicalSessionId);
    if (!session) {
      return;
    }
    if (session.model !== bot.model) {
      await this.sessions.setSessionModel(binding.sessionAlias, bot.model);
    }
    if (session.effort !== bot.effort) {
      await this.sessions.setSessionEffort(binding.sessionAlias, bot.effort);
    }
  }
}
