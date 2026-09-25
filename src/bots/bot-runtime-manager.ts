import { BotError } from "./bot-error";
import {
  classifyDirectBotBindingSessionLink,
  classifyDirectBotRuntimeBindingOwnership,
  classifyDirectBotSessionOwnership,
  classifyGroupMemberBindingOwnership,
  classifyGroupMemberBindingSessionLink,
  classifyGroupMemberSessionOwnership,
  type BotService,
  type DirectBotRuntimeBinding,
  type GroupMemberRuntimeBinding,
} from "./bot-service";
import { sessionMatchesExecution, type BotProfile, type BotProfileExecution, type BotRuntimeBinding } from "./bot-types";
import { planDirectConversation } from "../conversations/direct-conversation";
import type { ConversationTopic } from "../conversations/conversation-types";
import {
  createDirectBindingId,
  createDirectConversationId,
  createDirectTopicId,
  createScopedDirectBindingId,
  createScopedGroupMemberBindingId,
  ownedDirectSessionAlias,
  ownedGroupMemberSessionAlias,
} from "../domain/ids";
import { AsyncMutex } from "../orchestration/async-mutex";
import type { ReleaseOwnedSession } from "../sessions/owned-session-release";
import type { SessionService } from "../sessions/session-service";
import { replaceRuntimeState } from "../state/replace-runtime-state";
import type { StateStore } from "../state/state-store";
import { createBotDirectOwner, createGroupMemberOwner, type AppState, type LogicalSession } from "../state/types";

export interface BotRuntimeManagerOptions {
  now?: () => Date;
  stateMutex?: AsyncMutex;
  afterDirectSnapshot?: (bot: BotProfile) => Promise<void>;
  /** Verified physical+logical release. Required; never LogicalSession-only. */
  releaseOwnedSession: ReleaseOwnedSession;
  /** Fired after a direct binding is durably published (fresh or adopted).
   *  Composition routes this to a bots-changed product event so Web clients
   *  converge Bot lifecycle even when execution-start never follows (e.g.
   *  cancel in the materialize/start window). Must never throw: product
   *  projection must not affect dispatch fencing. */
  onRuntimeMaterialized?: (botId: string) => void;
}

type SessionWriter = Pick<StateStore, "save"> & { saveNow?: (state: AppState) => Promise<void> };

export class BotRuntimeManager {
  private readonly now: () => Date;
  private readonly stateMutex: AsyncMutex;
  private readonly afterDirectSnapshot?: (bot: BotProfile) => Promise<void>;
  private readonly releaseOwnedSession: ReleaseOwnedSession;
  private readonly onRuntimeMaterialized?: (botId: string) => void;

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
    this.onRuntimeMaterialized = options.onRuntimeMaterialized;
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

  /**
   * PR6 Group member binding. Mirrors the direct path but scopes to an
   * explicit Group Conversation/Topic and a member Bot: the Conversation must
   * be kind=group, the Bot must belong to its membership, and the Topic must
   * belong to the Conversation. The member Bot must be enabled. No Router or
   * controller session is created here — PR7 routing calls this per selected
   * member.
   *
   * Effective execution is Bot agent/model/effort + Topic workspace/cwd: the
   * Topic owns the work target (§9.2), so a Topic on `frontend` runs the
   * member session there even when the Bot default is `backend`. Sticky
   * identity is agent + resolved workspace. An explicit per-member
   * `execution` override wins entirely (PR7+ explicit target path).
   */
  async getOrCreateGroupMemberSession(input: {
    botId: string;
    conversationId: string;
    topicId: string;
    execution?: BotProfileExecution;
    assertStillDispatchable?: () => void;
  }): Promise<BotRuntimeBinding> {
    this.requireEnabledBot(input.botId);
    return await this.bots.runLifecycle(input.botId, () => this.materializeGroupMemberSession(input));
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
    this.assertBindingIdentity(snapshot);
    await this.bots.runLifecycle(snapshot.botId, async () => {
      await this.releaseDirectBindingInternal(snapshot, bindingId);
    });
  }

  private async releaseDirectBindingInternal(snapshot: DirectBotRuntimeBinding, bindingId: string): Promise<void> {
    const live = this.state.bot_runtime_bindings[bindingId];
    if (!live || live.scope !== "bot-direct") {
      return;
    }
    this.assertBindingIdentity(live);
    if (
      live.botId !== snapshot.botId
      || live.conversationId !== snapshot.conversationId
      || live.topicId !== snapshot.topicId
      || live.sessionAlias !== snapshot.sessionAlias
      || live.logicalSessionId !== snapshot.logicalSessionId
    ) {
      throw this.bindingConflict(live.botId, live);
    }
    const byAlias = this.sessions.getLogicalSessionRecord(live.sessionAlias);
    const byId = this.sessions.getLogicalSessionById(live.logicalSessionId);
    if (byAlias || byId) {
      if (
        !byAlias
        || !byId
        || byAlias.logical_session_id !== byId.logical_session_id
        || byAlias.alias !== byId.alias
      ) {
        throw this.bindingConflict(live.botId, live);
      }
      this.assertBindingOwnsSession(live, byAlias);
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
  }

  private async releaseGroupMemberBindingInternal(
    snapshot: GroupMemberRuntimeBinding,
    bindingId: string,
  ): Promise<void> {
    const live = this.state.bot_runtime_bindings[bindingId];
    if (!live || live.scope !== "group-member") {
      return;
    }
    this.assertGroupMemberBindingIdentity(live);
    if (
      live.botId !== snapshot.botId
      || live.conversationId !== snapshot.conversationId
      || live.topicId !== snapshot.topicId
      || live.sessionAlias !== snapshot.sessionAlias
      || live.logicalSessionId !== snapshot.logicalSessionId
    ) {
      throw this.groupMemberBindingConflict(live.botId, live);
    }
    const { byAlias, byIdMatches } = this.resolveGroupMemberBindingSession(live);
    if (byAlias || byIdMatches.length > 0) {
      if (
        !byAlias
        || byIdMatches.length !== 1
        || byIdMatches[0]?.alias !== byAlias.alias
      ) {
        throw this.groupMemberBindingConflict(live.botId, live);
      }
      this.assertGroupMemberBindingOwnsSession(live, byAlias);
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
      const session = this.sessions.getLogicalSessionRecord(existing.sessionAlias)
        ?? this.sessions.getLogicalSessionById(existing.logicalSessionId);
      const target = input.execution ?? bot;
      const targetEffort = target.effort;
      if (session && session.effort && !targetEffort) {
        await this.releaseDirectBindingInternal(existing, existing.id);
      } else {
        await this.alignSessionRuntime(existing, input.execution ?? bot);
        return existing;
      }
    }
    const adopted = this.findAdoptableLegacyBinding(bot.id, scope);
    if (adopted && this.bindingSessionIsLive(adopted)) {
      const session = this.sessions.getLogicalSessionById(adopted.logicalSessionId)
        ?? this.findOwnedSession(adopted.id, bot.id, scope.conversationId);
      const target = input.execution ?? bot;
      const targetEffort = target.effort;
      if (session && session.effort && !targetEffort) {
        await this.releaseDirectBindingInternal(adopted, adopted.id);
      } else {
        await this.alignSessionRuntime(adopted, input.execution ?? bot);
        await this.afterDirectSnapshot?.(bot);
        return await this.publishAdoptedBinding(bot, adopted, scopedId, scope);
      }
    }
    await this.afterDirectSnapshot?.(bot);
    const session = await this.ensureOwnedSession(bot, scopedId, scope, input.execution);
    return await this.publishDirectRuntime(bot, session, scopedId, scope);
  }

  private async materializeGroupMemberSession(input: {
    botId: string;
    conversationId: string;
    topicId: string;
    execution?: BotProfileExecution;
    assertStillDispatchable?: () => void;
  }): Promise<BotRuntimeBinding> {
    input.assertStillDispatchable?.();
    const bot = this.requireEnabledBot(input.botId);
    const scope = this.resolveGroupMemberScope(bot.id, input.conversationId, input.topicId);
    const effective = this.resolveGroupMemberExecution(bot, scope.topic, input.execution);
    this.assertGroupMemberStickyIdentity(bot, scope.topic, input.execution);
    const scopedId = createScopedGroupMemberBindingId(scope.conversationId, scope.topicId, bot.id);
    const existing = this.findScopedGroupMemberBinding(scope.conversationId, scope.topicId, bot.id);
    if (existing && !this.groupMemberBindingHasAnySession(existing)) {
      // Fully-missing stale binding (crash between session release and
      // binding-row delete): skip reuse AND the liveness conflict — publish
      // repairs the row below after ensure mints the new owned session.
    } else if (existing && this.groupMemberBindingSessionIsLive(existing)) {
      // Reuse crosses the same commit-time fence as fresh publish: the
      // barrier may have landed after scope resolution (topic deleting, group
      // deleting, bot removed/disabled). Returning a stale binding past the
      // barrier would hand dispatch a session teardown is about to release.
      await this.assertGroupMemberReuseDispatchable(bot, scope);
      const session = this.sessions.getLogicalSessionRecord(existing.sessionAlias)
        ?? this.sessions.getLogicalSessionById(existing.logicalSessionId);
      if (session && session.effort && !effective.effort) {
        // Turn-boundary recreate mirrors direct: clearing effort from a set
        // value to default must not silently keep the old effort runtime.
        await this.releaseGroupMemberBindingInternal(existing, existing.id);
      } else {
        await this.alignGroupMemberSessionRuntime(existing, effective);
        return existing;
      }
    }
    const session = await this.ensureGroupMemberOwnedSession(bot, scopedId, scope, effective);
    return await this.publishGroupMemberRuntime(bot, session, scopedId, scope);
  }

  /**
   * Effective execution for one member turn: the Bot contributes agent identity
   * and turn-boundary settings (model/effort); the Topic contributes the work
   * target (workspace/cwd). An explicit per-member execution override
   * replaces the whole combination (PR7+ explicit targets carry their own).
   */
  private resolveGroupMemberExecution(
    bot: BotProfile,
    topic: ConversationTopic,
    execution?: BotProfileExecution,
  ): BotProfileExecution {
    if (execution) {
      return execution;
    }
    // Group Topics must carry an explicit ExecutionTarget: a missing target
    // is unknown policy (legacy/damaged/migration gap), never the Bot
    // default. Failing closed here avoids silently running member work in
    // the wrong workspace. Direct Topics keep resolving from the Bot.
    const target = topic.executionTarget;
    if (!target) {
      throw new BotError("execution_target_missing", `topic "${topic.id}" has no execution target`);
    }
    return {
      agent: bot.agent,
      workspace: target.workspace,
      ...(bot.model ? { model: bot.model } : {}),
      ...(bot.effort ? { effort: bot.effort } : {}),
    };
  }

  /**
   * Sticky identity for group members is agent + resolved workspace — the
   * axes the session actually runs on. Unlike direct sessions (where the Bot
   * profile owns both), a Topic workspace override must not read as drift:
   * only an agent change, or a workspace change against the *resolved*
   * target, fails closed. cwd has no Bot-level counterpart (cwd_unsupported)
   * and no session axis yet; it rides the ExecutionTarget as metadata until
   * transport launch honors it, so it never triggers mismatch here.
   */
  private assertGroupMemberStickyIdentity(
    bot: BotProfile,
    topic: ConversationTopic,
    execution?: BotProfileExecution,
  ): void {
    if (!execution) {
      return;
    }
    const target = topic.executionTarget;
    if (!target) {
      throw new BotError("execution_target_missing", `topic "${topic.id}" has no execution target`);
    }
    if (bot.agent !== execution.agent || target.workspace !== execution.workspace) {
      throw new BotError(
        "runtime_revision_mismatch",
        `bot "${bot.id}" group execution no longer matches the accepted target`,
      );
    }
  }

  private resolveGroupMemberScope(
    botId: string,
    conversationId: string,
    topicId: string,
  ): { conversationId: string; topicId: string; topic: ConversationTopic } {
    const conversation = this.state.conversations[conversationId];
    if (!conversation || conversation.kind !== "group") {
      throw new BotError("conversation_not_group", `conversation "${conversationId}" is not a Group`);
    }
    if (!conversation.botIds.includes(botId)) {
      throw new BotError("group_member_not_member", `bot "${botId}" is not a member of group "${conversationId}"`);
    }
    const topic = this.state.conversation_topics[topicId];
    if (!topic || topic.conversationId !== conversationId) {
      throw new BotError("topic_not_found", `topic "${topicId}" does not belong to group "${conversationId}"`);
    }
    // Fail closed while teardown is in flight: a Group delete marks the
    // Conversation lifecycle deleting and flips active Topics to deleting
    // before releasing anything. Materializing a member session past that
    // point would mint runtime the teardown just decided to release. Codes
    // match the run-service deleting barriers (callers match on .code).
    if (conversation.lifecycle === "deleting") {
      throw new BotError("conversation_deleting", `group "${conversationId}" is deleting`);
    }
    if (topic.status !== "active") {
      throw new BotError("topic_deleting", `topic "${topicId}" is deleting`);
    }
    const target = topic.executionTarget;
    if (target) {
      this.bots.assertWorkspaceRegistered(target.workspace);
      // worktree-per-member persists as a value but has no provisioning
      // lifecycle yet (PR10): executing it in the shared workspace root
      // would be a silent isolation downgrade. Fail closed at the
      // materialization boundary, not at topic creation.
      if (target.isolation === "worktree-per-member") {
        throw new BotError("worktree_unprovisioned", `topic "${topicId}" requires worktree-per-member provisioning`);
      }
      // A persisted non-empty cwd the launcher does not honor would silently
      // execute in the workspace root (legacy/damaged row reloaded after the
      // create-time cwd_unsupported gate). Fail closed like Bot cwd.
      if (target.cwd !== undefined && target.cwd.trim() !== "") {
        throw new BotError("cwd_unsupported", `topic "${topicId}" has an unsupported execution cwd`);
      }
    }
    return { conversationId, topicId, topic };
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
    if (binding) {
      if (binding.scope !== "bot-direct") {
        throw this.bindingConflict(botId, binding);
      }
      if (
        classifyDirectBotRuntimeBindingOwnership(binding, botId, scope.conversationId) !== "owned"
      ) {
        throw this.bindingConflict(botId, binding);
      }
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
      const owner = current.owner;
      if (
        owner?.kind !== "bot-direct"
        || (owner.topicId !== undefined && owner.topicId !== scope.topicId)
      ) {
        throw this.ownershipConflict(
          bot.id,
          current.alias,
          { bindingId, conversationId: scope.conversationId },
          current,
        );
      }
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
        || (occupant.owner.topicId !== undefined && occupant.owner.topicId !== scope.topicId)
      ) {
        throw this.ownershipConflict(bot.id, alias, { bindingId, conversationId: scope.conversationId }, occupant);
      }
    }
    const target = execution ?? bot;
    const agent = target.agent;
    const workspace = target.workspace;
    const model = target.model;
    const effort = target.effort;
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
  private async ensureGroupMemberOwnedSession(
    bot: BotProfile,
    bindingId: string,
    scope: { conversationId: string; topicId: string },
    execution?: BotProfileExecution,
  ): Promise<LogicalSession> {
    const alias = ownedGroupMemberSessionAlias(bindingId);
    const expected = execution ?? bot;
    const current = this.findOwnedGroupMemberSession(bindingId, bot.id, scope.conversationId, scope.topicId);
    if (current) {
      // Binding-less recovery must not resurrect an old-Agent session under a
      // changed identity: agent/workspace/model/effort all gate reuse, the
      // same axes the dispatcher checks post-materialize. A mismatch fails
      // closed instead of silently adopting stale Agent context.
      if (!sessionMatchesExecution(current, expected)) {
        throw new BotError(
          "runtime_revision_mismatch",
          `bot "${bot.id}" group execution no longer matches the persisted session`,
        );
      }
      return current;
    }
    const occupant = this.sessions.getLogicalSessionRecord(alias);
    if (occupant) {
      const ownership = classifyGroupMemberSessionOwnership(
        occupant,
        bot.id,
        bindingId,
        scope.conversationId,
        scope.topicId,
      );
      if (ownership !== "owned" || occupant.owner?.bindingId !== bindingId) {
        throw this.groupMemberOwnershipConflict(bot.id, alias, bindingId, scope.conversationId, occupant);
      }
    }
    const target = execution ?? bot;
    if (!occupant) {
      await this.sessions.createSession(alias, target.agent, target.workspace, {
        owner: createGroupMemberOwner({
          bindingId,
          botId: bot.id,
          conversationId: scope.conversationId,
          topicId: scope.topicId,
        }),
        ...(target.model ? { model: target.model } : {}),
        ...(target.effort ? { effort: target.effort } : {}),
      });
    }
    const record = this.findOwnedGroupMemberSession(bindingId, bot.id, scope.conversationId, scope.topicId);
    if (!record) {
      throw new BotError("session_missing", `failed to persist owned session for bot "${bot.id}"`);
    }
    if (!sessionMatchesExecution(record, expected)) {
      throw new BotError(
        "runtime_revision_mismatch",
        `bot "${bot.id}" group execution no longer matches the persisted session`,
      );
    }
    return record;
  }

  private async publishGroupMemberRuntime(
    bot: BotProfile,
    session: LogicalSession,
    bindingId: string,
    scope: { conversationId: string; topicId: string; topic: ConversationTopic },
  ): Promise<BotRuntimeBinding> {
    return await this.stateMutex.run(async () => {
      // Commit-time revalidation: scope resolution ran before async session
      // work, so a Group delete may have landed in between (barrier set,
      // binding-less session swept, Group record removed). Re-read every
      // authority inside this critical section: a missing/deleting
      // Conversation or non-active Topic, a removed or disabled Bot, a
      // session that no longer resolves, or an owner link that no longer
      // matches all fail closed instead of resurrecting runtime metadata.
      const liveConversation = this.state.conversations[scope.conversationId];
      if (!liveConversation || liveConversation.kind !== "group") {
        throw new BotError("conversation_not_group", `conversation "${scope.conversationId}" is not a Group`);
      }
      if (!liveConversation.botIds.includes(bot.id)) {
        throw new BotError(
          "group_member_not_member",
          `bot "${bot.id}" is not a member of group "${scope.conversationId}"`,
        );
      }
      if (liveConversation.lifecycle === "deleting") {
        throw new BotError("conversation_deleting", `group "${scope.conversationId}" is deleting`);
      }
      const liveTopic = this.state.conversation_topics[scope.topicId];
      if (!liveTopic || liveTopic.conversationId !== scope.conversationId) {
        throw new BotError("topic_not_found", `topic "${scope.topicId}" does not belong to group "${scope.conversationId}"`);
      }
      if (liveTopic.status !== "active") {
        throw new BotError("topic_deleting", `topic "${scope.topicId}" is deleting`);
      }
      let liveBot: BotProfile;
      try {
        liveBot = this.bots.getBot(bot.id);
      } catch {
        throw new BotError("bot_not_found", `bot "${bot.id}" does not exist`);
      }
      if (!liveBot.enabled) {
        throw new BotError("bot_disabled", `bot "${bot.id}" is disabled`);
      }
      const current = this.sessions.getLogicalSessionRecord(session.alias)
        ?? this.sessions.getLogicalSessionById(session.logical_session_id);
      if (!current) {
        throw new BotError("session_missing", `owned session for bot "${bot.id}" no longer exists`);
      }
      if (
        current.alias !== session.alias
        || current.logical_session_id !== session.logical_session_id
      ) {
        throw this.groupMemberOwnershipConflict(bot.id, current.alias, bindingId, scope.conversationId, current);
      }
      this.assertGroupMemberBindingOwnsSession(
        {
          id: bindingId,
          scope: "group-member",
          conversationId: scope.conversationId,
          topicId: scope.topicId,
          botId: bot.id,
          logicalSessionId: current.logical_session_id,
          sessionAlias: current.alias,
          createdAt: current.created_at,
          updatedAt: current.last_used_at,
        },
        current,
      );
      const live = this.findScopedGroupMemberBinding(scope.conversationId, scope.topicId, bot.id);
      if (live) {
        // Re-check the OLD axes inside this critical section (not the
        // helper, which reads current state): the repair candidate (current)
        // is the newly-created session, so a helper call here would see the
        // NEW row on the alias axis and misread a fully-missing old binding
        // as a mismatch. Missing-both on the old axes + exact new-candidate
        // ownership below = safe repair; anything else defers to the
        // unified liveness rule.
        const oldByAlias = this.sessions.getLogicalSessionRecord(live.sessionAlias);
        const oldByIdMatches = Object.values(this.state.sessions).filter(
          (session) => session.logical_session_id === live.logicalSessionId,
        );
        const repairingFullyMissingOldSession = (
          (!oldByAlias || oldByAlias.alias === current.alias)
          && (oldByIdMatches.length === 0
            || (oldByIdMatches.length === 1 && oldByIdMatches[0]?.alias === current.alias))
          && current.alias === session.alias
          && current.logical_session_id === session.logical_session_id
        );
        if (repairingFullyMissingOldSession) {
          const owner = current.owner;
          if (
            owner?.kind !== "group-member"
            || owner.bindingId !== bindingId
            || owner.botId !== bot.id
            || owner.conversationId !== scope.conversationId
            || owner.topicId !== scope.topicId
          ) {
            throw this.groupMemberOwnershipConflict(bot.id, current.alias, bindingId, scope.conversationId, current);
          }
          // Safe stale-binding repair (mirrors direct): the old logical id
          // resolves nowhere, while this exact alias is the newly-created
          // owned candidate for the same deterministic binding. Fall
          // through and overwrite the stale row below, preserving createdAt.
        } else if (this.groupMemberBindingSessionIsLive(live, { allowFullyMissing: true })) {
          return live;
        } else {
          throw this.groupMemberBindingConflict(bot.id, live);
        }
      }
      const timestamp = this.now().toISOString();
      const binding: BotRuntimeBinding = {
        id: bindingId,
        scope: "group-member",
        conversationId: scope.conversationId,
        topicId: scope.topicId,
        botId: bot.id,
        logicalSessionId: current.logical_session_id,
        sessionAlias: current.alias,
        createdAt: live?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      const next = structuredClone(this.state);
      next.bot_runtime_bindings[bindingId] = binding;
      if (typeof this.stateStore.saveNow === "function") {
        await this.stateStore.saveNow(next);
      } else {
        await this.stateStore.save(next);
      }
      replaceRuntimeState(this.state, next);
      const published = this.state.bot_runtime_bindings[bindingId]!;
      try {
        this.onRuntimeMaterialized?.(bot.id);
      } catch {
        // Product projection must not affect dispatch fencing.
      }
      return published;
    });
  }

  /**
   * Reuse-path commit fence: mirrors the publish critical-section checks
   * without the session/body work. Runs on the shared mutex so the read is
   * linearizable against a concurrent teardown finalization; the barrier set
   * just before this read still fails closed here.
   */
  private async assertGroupMemberReuseDispatchable(
    bot: BotProfile,
    scope: { conversationId: string; topicId: string },
  ): Promise<void> {
    await this.stateMutex.run(async () => {
      const liveConversation = this.state.conversations[scope.conversationId];
      if (!liveConversation || liveConversation.kind !== "group") {
        throw new BotError("conversation_not_group", `conversation "${scope.conversationId}" is not a Group`);
      }
      if (!liveConversation.botIds.includes(bot.id)) {
        throw new BotError(
          "group_member_not_member",
          `bot "${bot.id}" is not a member of group "${scope.conversationId}"`,
        );
      }
      if (liveConversation.lifecycle === "deleting") {
        throw new BotError("conversation_deleting", `group "${scope.conversationId}" is deleting`);
      }
      const liveTopic = this.state.conversation_topics[scope.topicId];
      if (!liveTopic || liveTopic.conversationId !== scope.conversationId) {
        throw new BotError("topic_not_found", `topic "${scope.topicId}" does not belong to group "${scope.conversationId}"`);
      }
      if (liveTopic.status !== "active") {
        throw new BotError("topic_deleting", `topic "${scope.topicId}" is deleting`);
      }
      let liveBot: BotProfile;
      try {
        liveBot = this.bots.getBot(bot.id);
      } catch {
        throw new BotError("bot_not_found", `bot "${bot.id}" does not exist`);
      }
      if (!liveBot.enabled) {
        throw new BotError("bot_disabled", `bot "${bot.id}" is disabled`);
      }
    });
  }

  private findScopedGroupMemberBinding(
    conversationId: string,
    topicId: string,
    botId: string,
  ): GroupMemberRuntimeBinding | undefined {
    const scopedId = createScopedGroupMemberBindingId(conversationId, topicId, botId);
    const scoped = this.state.bot_runtime_bindings[scopedId];
    if (!scoped) {
      return undefined;
    }
    if (scoped.scope !== "group-member") {
      throw this.groupMemberBindingConflict(botId, scoped);
    }
    if (classifyGroupMemberBindingOwnership(scoped, botId, conversationId, topicId) !== "owned") {
      throw this.groupMemberBindingConflict(botId, scoped);
    }
    return scoped;
  }

  private findOwnedGroupMemberSession(
    bindingId: string,
    botId: string,
    conversationId: string,
    topicId: string,
  ): LogicalSession | undefined {
    let owned: LogicalSession | undefined;
    for (const session of Object.values(this.state.sessions)) {
      if (session.owner?.kind !== "group-member" || session.owner.bindingId !== bindingId) {
        continue;
      }
      const ownership = classifyGroupMemberSessionOwnership(
        session,
        botId,
        bindingId,
        conversationId,
        topicId,
      );
      if (ownership === "conflict") {
        throw this.groupMemberOwnershipConflict(botId, session.alias, bindingId, conversationId, session);
      }
      if (ownership === "owned") {
        if (owned) {
          throw this.groupMemberOwnershipConflict(botId, session.alias, bindingId, conversationId, session);
        }
        owned = session;
      }
    }
    if (!owned) {
      return undefined;
    }
    // The owned hit must also be the unique logical-id holder: a shadow
    // session sharing the id is ambiguity, not a first-match win.
    const idHolders = Object.values(this.state.sessions).filter(
      (session) => session.logical_session_id === owned.logical_session_id,
    );
    if (idHolders.length !== 1 || idHolders[0]?.alias !== owned.alias) {
      throw this.groupMemberOwnershipConflict(botId, owned.alias, bindingId, conversationId, owned);
    }
    return owned;
  }

  /**
   * Unified binding/session resolver: the single cardinality rule for
   * reuse, publish, effort-clear release, and teardown. The logical-id axis
   * is fully scanned (never first-match): missing on both axes is
   * stale/absent, exactly one same-alias match with an owned link is live,
   * and anything else (single-axis presence, alias/id disagreement, or a
   * duplicated logical id) is a conflict with zero release and zero
   * binding mutation.
   */
  private resolveGroupMemberBindingSession(
    binding: GroupMemberRuntimeBinding,
  ): { byAlias?: LogicalSession; byIdMatches: LogicalSession[] } {
    const byAlias = this.sessions.getLogicalSessionRecord(binding.sessionAlias);
    const byIdMatches = Object.values(this.state.sessions).filter(
      (session) => session.logical_session_id === binding.logicalSessionId,
    );
    return { ...(byAlias ? { byAlias } : {}), byIdMatches };
  }

  private groupMemberBindingHasAnySession(binding: GroupMemberRuntimeBinding): boolean {
    return this.sessions.getLogicalSessionRecord(binding.sessionAlias) !== null
      || this.sessions.getLogicalSessionById(binding.logicalSessionId) !== null;
  }

  private groupMemberBindingSessionIsLive(
    binding: GroupMemberRuntimeBinding,
    options?: { allowFullyMissing?: boolean },
  ): boolean {
    this.assertGroupMemberBindingIdentity(binding);
    const { byAlias, byIdMatches } = this.resolveGroupMemberBindingSession(binding);
    if (!byAlias && byIdMatches.length === 0) {
      // Missing on both axes: stale in the reuse path (conflict — the
      // caller cannot know whether a repair candidate exists yet), but a
      // legal repair shape in publishGroupMemberRuntime, which has already
      // verified the newly-created owned candidate for the same binding.
      if (options?.allowFullyMissing === true) {
        return false;
      }
      throw this.groupMemberBindingConflict(binding.botId, binding);
    }
    if (
      !byAlias
      || byIdMatches.length !== 1
      || byIdMatches[0]?.alias !== byAlias.alias
    ) {
      throw this.groupMemberBindingConflict(binding.botId, binding);
    }
    this.assertGroupMemberBindingOwnsSession(binding, byAlias);
    return true;
  }
  private async alignGroupMemberSessionRuntime(
    binding: GroupMemberRuntimeBinding,
    bot: { model?: string; effort?: string },
  ): Promise<void> {
    const session = this.sessions.getLogicalSessionRecord(binding.sessionAlias);
    if (!session) {
      return;
    }
    this.assertGroupMemberBindingOwnsSession(binding, session);
    if (session.model !== bot.model) {
      await this.sessions.setSessionModel(binding.sessionAlias, bot.model);
    }
    if (session.effort !== bot.effort) {
      await this.sessions.setSessionEffort(binding.sessionAlias, bot.effort);
    }
  }

  private assertGroupMemberBindingIdentity(binding: GroupMemberRuntimeBinding): void {
    if (
      classifyGroupMemberBindingOwnership(
        binding,
        binding.botId,
        binding.conversationId,
        binding.topicId,
      ) !== "owned"
    ) {
      throw this.groupMemberBindingConflict(binding.botId, binding);
    }
  }

  private assertGroupMemberBindingOwnsSession(binding: GroupMemberRuntimeBinding, session: LogicalSession): void {
    this.assertGroupMemberBindingIdentity(binding);
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
      throw this.groupMemberOwnershipConflict(binding.botId, session.alias, binding.id, binding.conversationId, session);
    }
  }

  private groupMemberBindingConflict(botId: string, binding: BotRuntimeBinding): BotError {
    return new BotError(
      "runtime_ownership_conflict",
      "group member runtime binding ownership metadata is contradictory",
      { botId, binding },
    );
  }

  private groupMemberOwnershipConflict(
    botId: string,
    alias: string,
    bindingId: string,
    conversationId: string,
    session: LogicalSession,
  ): BotError {
    return new BotError(
      "runtime_ownership_conflict",
      `group member runtime ownership for session "${alias}" is contradictory`,
      { botId, binding: { bindingId, conversationId }, owner: session.owner },
    );
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
      const published = this.state.bot_runtime_bindings[scopedId]!;
      try {
        this.onRuntimeMaterialized?.(bot.id);
      } catch {
        // Product projection must not affect dispatch fencing.
      }
      return published;
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
      if (live) {
        const oldById = this.sessions.getLogicalSessionById(live.logicalSessionId);
        const currentAlias = this.sessions.getLogicalSessionRecord(live.sessionAlias);
        const repairingFullyMissingOldSession = (
          !oldById
          && currentAlias?.logical_session_id === session.logical_session_id
          && currentAlias.alias === session.alias
        );
        if (repairingFullyMissingOldSession) {
          const owner = session.owner;
          const ownership = classifyDirectBotSessionOwnership(
            session,
            bot.id,
            this.ownedBindingIdsFor(bot.id, bindingId),
            scope.conversationId,
          );
          if (
            ownership !== "owned"
            || owner?.kind !== "bot-direct"
            || owner.bindingId !== bindingId
            || (owner.topicId !== undefined && owner.topicId !== scope.topicId)
          ) {
            throw this.ownershipConflict(
              bot.id,
              session.alias,
              { bindingId, conversationId: scope.conversationId },
              session,
            );
          }
          // Safe stale-binding repair: the old logical id no longer resolves
          // anywhere, while this exact alias is now the newly-created owned
          // candidate for the same deterministic binding.
        } else if (this.bindingSessionIsLive(live)) {
          return live;
        }
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
      const published = this.state.bot_runtime_bindings[bindingId]!;
      try {
        this.onRuntimeMaterialized?.(bot.id);
      } catch {
        // Product projection must not affect dispatch fencing.
      }
      return published;
    });
  }

  private findScopedBinding(conversationId: string, topicId: string, botId: string): DirectBotRuntimeBinding | undefined {
    const scopedId = createScopedDirectBindingId(conversationId, topicId, botId);
    const scoped = this.state.bot_runtime_bindings[scopedId];
    if (!scoped) {
      return undefined;
    }
    if (
      scoped.scope !== "bot-direct"
      || scoped.topicId !== topicId
      || classifyDirectBotRuntimeBindingOwnership(scoped, botId, conversationId) !== "owned"
    ) {
      throw this.bindingConflict(botId, scoped);
    }
    return scoped;
  }

  private ownedBindingIdsFor(botId: string, includeId?: string): Set<string> {
    const ids = new Set<string>([createDirectBindingId(botId)]);
    if (includeId) {
      ids.add(includeId);
    }
    const conversationId = createDirectConversationId(botId);
    for (const binding of Object.values(this.state.bot_runtime_bindings)) {
      const ownership = classifyDirectBotRuntimeBindingOwnership(binding, botId, conversationId);
      if (ownership === "conflict") {
        throw this.bindingConflict(botId, binding);
      }
      if (ownership === "owned") {
        ids.add(binding.id);
      }
    }
    return ids;
  }

  private bindingConflict(botId: string, binding: BotRuntimeBinding): BotError {
    return new BotError(
      "runtime_ownership_conflict",
      "direct runtime binding ownership metadata is contradictory",
      { botId, binding },
    );
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

  private assertBindingIdentity(binding: DirectBotRuntimeBinding): void {
    if (
      classifyDirectBotRuntimeBindingOwnership(
        binding,
        binding.botId,
        createDirectConversationId(binding.botId),
      ) !== "owned"
    ) {
      throw this.bindingConflict(binding.botId, binding);
    }
  }

  private assertBindingOwnsSession(binding: DirectBotRuntimeBinding, session: LogicalSession): void {
    this.assertBindingIdentity(binding);
    if (
      classifyDirectBotBindingSessionLink(
        binding,
        session,
        this.ownedBindingIdsFor(binding.botId, binding.id),
      ) !== "owned"
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
    this.assertBindingIdentity(binding);
    const byId = this.sessions.getLogicalSessionById(binding.logicalSessionId);
    const byAlias = this.sessions.getLogicalSessionRecord(binding.sessionAlias);
    if (!byId && !byAlias) {
      return false;
    }
    if (
      !byId
      || !byAlias
      || byId.logical_session_id !== byAlias.logical_session_id
      || byId.alias !== byAlias.alias
    ) {
      throw this.bindingConflict(binding.botId, binding);
    }
    this.assertBindingOwnsSession(binding, byAlias);
    return true;
  }

  private async alignSessionRuntime(
    binding: DirectBotRuntimeBinding,
    bot: { model?: string; effort?: string },
  ): Promise<void> {
    const session = this.sessions.getLogicalSessionRecord(binding.sessionAlias);
    if (!session) {
      return;
    }
    this.assertBindingOwnsSession(binding, session);
    if (session.model !== bot.model) {
      await this.sessions.setSessionModel(binding.sessionAlias, bot.model);
    }
    if (session.effort !== bot.effort) {
      await this.sessions.setSessionEffort(binding.sessionAlias, bot.effort);
    }
  }
}
