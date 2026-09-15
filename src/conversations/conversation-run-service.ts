import { snapshotBotProfile } from "../bots/bot-types";
import { BotError } from "../bots/bot-error";
import type { BotRuntimeManager } from "../bots/bot-runtime-manager";
import type { BotService } from "../bots/bot-service";
import { planDirectConversation } from "./direct-conversation";
import { createTopicId } from "../domain/ids";
import { AsyncMutex } from "../orchestration/async-mutex";
import type { SessionService } from "../sessions/session-service";
import { replaceRuntimeState } from "../state/replace-runtime-state";
import type { StateStore } from "../state/state-store";
import type { AppState } from "../state/types";
import { ConversationError } from "./conversation-error";
import type { ConversationDispatcher } from "./conversation-dispatcher";
import type { AcceptRequestResult, ConversationStore } from "./conversation-store";
import type { ConversationTopic } from "./conversation-types";

export interface ConversationRunServiceOptions {
  now?: () => Date;
  createTopicId?: () => string;
  stateMutex?: AsyncMutex;
  beforeAcceptPersist?: () => Promise<void>;
  beforeTeardownFinalize?: () => Promise<void>;
  failSessionRelease?: boolean | (() => boolean);
  autoKick?: boolean;
}

type SessionWriter = Pick<StateStore, "save"> & { saveNow?: (state: AppState) => Promise<void> };

export class ConversationRunService {
  private readonly now: () => Date;
  private readonly createTopicIdFn: () => string;
  private readonly stateMutex: AsyncMutex;
  private readonly beforeAcceptPersist?: () => Promise<void>;
  private readonly beforeTeardownFinalize?: () => Promise<void>;
  private readonly failSessionRelease?: boolean | (() => boolean);
  private readonly autoKick: boolean;

  constructor(
    private readonly store: ConversationStore,
    private readonly bots: BotService,
    private readonly runtime: BotRuntimeManager,
    private readonly dispatcher: ConversationDispatcher,
    private readonly sessions: Pick<SessionService, "removeSession" | "getLogicalSessionRecord">,
    private readonly state: AppState,
    private readonly stateStore: SessionWriter,
    options?: ConversationRunServiceOptions,
  ) {
    this.now = options?.now ?? (() => new Date());
    this.createTopicIdFn = options?.createTopicId ?? (() => createTopicId());
    this.stateMutex = options?.stateMutex ?? new AsyncMutex();
    this.beforeAcceptPersist = options?.beforeAcceptPersist;
    this.beforeTeardownFinalize = options?.beforeTeardownFinalize;
    this.failSessionRelease = options?.failSessionRelease;
    this.autoKick = options?.autoKick ?? true;
  }

  async acceptDirectPrompt(input: {
    botId: string;
    requestId: string;
    content: string;
    conversationId?: string;
    topicId?: string;
  }): Promise<AcceptRequestResult> {
    const accepted = await this.bots.runLifecycle(input.botId, async () => {
      const bot = this.bots.getBot(input.botId);
      if (!bot.enabled) {
        throw new BotError("bot_disabled", `bot "${input.botId}" is disabled`);
      }
      const timestamp = this.now().toISOString();
      const planned = planDirectConversation(this.state, {
        botId: bot.id,
        title: bot.name,
        now: timestamp,
      });
      const conversationId = input.conversationId ?? planned.conversation.id;
      if (conversationId !== planned.conversation.id) {
        throw new BotError("conversation_mismatch", "direct Bot conversation does not match this Bot");
      }
      const topicId = input.topicId ?? planned.topic.id;
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
      return this.store.acceptRequest({
        conversationId,
        topicId,
        requestId: input.requestId,
        botId: bot.id,
        content: input.content,
        profileSnapshot: snapshot,
        now: timestamp,
      });
    });
    if (this.autoKick) {
      void this.dispatcher.kick();
    }
    return accepted;
  }

  async createDirectTopic(botId: string, title: string): Promise<ConversationTopic> {
    return await this.stateMutex.run(async () => {
      const bot = this.bots.getBot(botId);
      const timestamp = this.now().toISOString();
      const planned = planDirectConversation(this.state, { botId, title: bot.name, now: timestamp });
      const topic: ConversationTopic = {
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
      next.conversation_topics[topic.id] = topic;
      await this.persist(next);
      return topic;
    });
  }

  async cancelRun(runId: string): Promise<void> {
    await this.dispatcher.cancelRun(runId);
  }

  async teardownDirectConversation(botId: string): Promise<void> {
    const bot = this.bots.getBot(botId);
    const timestamp = this.now().toISOString();
    const planned = planDirectConversation(this.state, { botId: bot.id, title: bot.name, now: timestamp });
    const conversationId = planned.conversation.id;
    await this.bots.runLifecycle(botId, async () => {
      this.store.markConversationDeleting(conversationId, timestamp);
      await this.markAppStateDeleting(conversationId);
    });

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

    const bindings = Object.values(this.state.bot_runtime_bindings).filter(
      (binding) => binding.scope === "bot-direct" && binding.conversationId === conversationId,
    );
    if (this.shouldFailRelease()) {
      throw new ConversationError("session_release_failed", "injected session release failure", {
        conversationId,
        bindingIds: bindings.map((binding) => binding.id),
      });
    }
    for (const binding of bindings) {
      const session = this.sessions.getLogicalSessionRecord(binding.sessionAlias);
      if (session) {
        await this.sessions.removeSession(binding.sessionAlias);
      }
    }

    await this.bots.runLifecycle(botId, async () => {
      await this.beforeTeardownFinalize?.();
      for (const binding of Object.values(this.state.bot_runtime_bindings)) {
        if (binding.scope === "bot-direct" && binding.conversationId === conversationId) {
          const session = this.sessions.getLogicalSessionRecord(binding.sessionAlias);
          if (session) {
            await this.sessions.removeSession(binding.sessionAlias);
          }
        }
      }
      const leftoverAliases = Object.values(this.state.sessions)
        .filter((session) => (
          session.owner?.kind === "bot-direct"
          && (session.owner.botId === botId || session.owner.conversationId === conversationId)
        ))
        .map((session) => session.alias);
      for (const alias of leftoverAliases) {
        await this.sessions.removeSession(alias);
      }
      await this.stateMutex.run(async () => {
        const next = structuredClone(this.state);
        for (const [id, binding] of Object.entries(next.bot_runtime_bindings)) {
          if (binding.conversationId === conversationId) {
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

  private nextTopicId(): string {
    const id = this.createTopicIdFn();
    return id.startsWith("topic_") ? id : createTopicId(() => id);
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

  private shouldFailRelease(): boolean {
    const fail = this.failSessionRelease;
    if (!fail) {
      return false;
    }
    return typeof fail === "function" ? fail() : fail;
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
