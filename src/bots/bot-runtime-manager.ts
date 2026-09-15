import { composeBotTurnPrompt } from "./bot-profile-prompt";
import { BotError } from "./bot-error";
import type { BotService } from "./bot-service";
import type { BotProfile, BotRuntimeBinding } from "./bot-types";
import { planDirectConversation } from "../conversations/direct-conversation";
import { createDirectBindingId } from "../domain/ids";
import { AsyncMutex } from "../orchestration/async-mutex";
import type { SessionService } from "../sessions/session-service";
import { replaceRuntimeState } from "../state/replace-runtime-state";
import type { StateStore } from "../state/state-store";
import type { AppState, LogicalSession } from "../state/types";

export interface DirectBotTurnInput {
  botId: string;
  conversationId: string;
  topicId: string;
  text: string;
}

export interface BotTurnRunner {
  run(input: {
    sessionAlias: string;
    text: string;
    origin: "human";
  }): Promise<unknown>;
}

export interface BotRuntimeManagerOptions {
  now?: () => Date;
  stateMutex?: AsyncMutex;
}

type SessionWriter = Pick<StateStore, "save"> & { saveNow?: (state: AppState) => Promise<void> };

export class BotRuntimeManager {
  private readonly now: () => Date;
  private readonly stateMutex: AsyncMutex;
  private readonly inflight = new Map<string, Promise<BotRuntimeBinding>>();

  constructor(
    private readonly bots: BotService,
    private readonly sessions: Pick<
      SessionService,
      "createSession" | "getLogicalSessionRecord" | "getLogicalSessionById" | "setSessionModel" | "setSessionEffort"
    >,
    private readonly state: AppState,
    private readonly stateStore: SessionWriter,
    options?: BotRuntimeManagerOptions,
  ) {
    this.now = options?.now ?? (() => new Date());
    this.stateMutex = options?.stateMutex ?? new AsyncMutex();
  }

  async getOrCreateDirectSession(input: {
    botId: string;
    conversationId?: string;
    topicId?: string;
  }): Promise<BotRuntimeBinding> {
    const key = `bot-direct:${input.botId}`;
    const running = this.inflight.get(key);
    if (running) {
      return await running;
    }
    const pending = this.materializeDirectSession(input).finally(() => {
      if (this.inflight.get(key) === pending) {
        this.inflight.delete(key);
      }
    });
    this.inflight.set(key, pending);
    return await pending;
  }

  async promptDirect(input: DirectBotTurnInput, runner: BotTurnRunner): Promise<unknown> {
    const binding = await this.getOrCreateDirectSession({
      botId: input.botId,
      conversationId: input.conversationId,
      topicId: input.topicId,
    });
    const bot = this.bots.getBot(input.botId);
    const text = composeBotTurnPrompt(bot, input.text);
    return await runner.run({
      sessionAlias: binding.sessionAlias,
      text,
      origin: "human",
    });
  }

  private async materializeDirectSession(input: {
    botId: string;
    conversationId?: string;
    topicId?: string;
  }): Promise<BotRuntimeBinding> {
    const bot = this.requireEnabledBot(input.botId);
    this.assertRequestedIds(bot.id, input);
    const bindingId = createDirectBindingId(bot.id);
    const existing = this.findDirectBinding(bot.id);
    if (existing && this.bindingSessionIsLive(existing)) {
      await this.alignSessionRuntime(existing, bot);
      return existing;
    }
    const session = await this.ensureOwnedSession(bot, bindingId);
    return await this.publishDirectRuntime(bot, session, bindingId, input);
  }

  private requireEnabledBot(botId: string): BotProfile {
    const bot = this.bots.getBot(botId);
    if (!bot.enabled) {
      throw new BotError("bot_disabled", `bot "${botId}" is disabled`);
    }
    return bot;
  }

  private assertRequestedIds(botId: string, input: { conversationId?: string; topicId?: string }): void {
    const planned = planDirectConversation(this.state, {
      botId,
      title: this.bots.getBot(botId).name,
      now: this.now().toISOString(),
    });
    if (input.conversationId && input.conversationId !== planned.conversation.id) {
      throw new BotError("conversation_mismatch", "direct Bot conversation does not match this Bot");
    }
    if (input.topicId && input.topicId !== planned.topic.id) {
      const requested = this.state.conversation_topics[input.topicId];
      if (!requested || requested.conversationId !== planned.conversation.id) {
        throw new BotError("topic_not_found", `topic "${input.topicId}" does not belong to this Bot conversation`);
      }
    }
  }

  private async ensureOwnedSession(bot: BotProfile, bindingId: string): Promise<LogicalSession> {
    const alias = `brt_${bindingId}`;
    const current = this.findOwnedSession(bindingId);
    if (current) {
      return current;
    }
    const occupant = this.sessions.getLogicalSessionRecord(alias);
    if (occupant && (occupant.owner?.kind !== "bot-direct" || occupant.owner.bindingId !== bindingId)) {
      throw new BotError("session_alias_conflict", `hidden session alias "${alias}" is already taken`);
    }
    if (!occupant) {
      await this.sessions.createSession(alias, bot.agent, bot.workspace, {
        owner: { kind: "bot-direct", bindingId },
        ...(bot.model ? { model: bot.model } : {}),
        ...(bot.effort ? { effort: bot.effort } : {}),
      });
    }
    const record = this.findOwnedSession(bindingId);
    if (!record) {
      throw new BotError("session_missing", `failed to persist owned session for bot "${bot.id}"`);
    }
    return record;
  }

  private async publishDirectRuntime(
    bot: BotProfile,
    session: LogicalSession,
    bindingId: string,
    input: { conversationId?: string; topicId?: string },
  ): Promise<BotRuntimeBinding> {
    return await this.stateMutex.run(async () => {
      const live = this.findDirectBinding(bot.id);
      if (live && this.bindingSessionIsLive(live)) {
        return live;
      }
      const timestamp = this.now().toISOString();
      const { conversation, topic } = planDirectConversation(this.state, {
        botId: bot.id,
        title: bot.name,
        now: timestamp,
      });
      if (input.conversationId && input.conversationId !== conversation.id) {
        throw new BotError("conversation_mismatch", "direct Bot conversation does not match this Bot");
      }
      const topicId = input.topicId && this.state.conversation_topics[input.topicId]?.conversationId === conversation.id
        ? input.topicId
        : topic.id;
      const binding: BotRuntimeBinding = {
        id: bindingId,
        scope: "bot-direct",
        conversationId: conversation.id,
        topicId,
        botId: bot.id,
        logicalSessionId: session.logical_session_id,
        sessionAlias: session.alias,
        createdAt: live?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      const next = structuredClone(this.state);
      next.conversations[conversation.id] = conversation;
      next.conversation_topics[topic.id] = next.conversation_topics[topic.id] ?? topic;
      if (topicId !== topic.id) {
        const requested = this.state.conversation_topics[topicId];
        if (requested) {
          next.conversation_topics[topicId] = requested;
        }
      }
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

  private findDirectBinding(botId: string): BotRuntimeBinding | undefined {
    return Object.values(this.state.bot_runtime_bindings).find(
      (binding) => binding.scope === "bot-direct" && binding.botId === botId,
    );
  }

  private findOwnedSession(bindingId: string): LogicalSession | undefined {
    return Object.values(this.state.sessions).find(
      (session) => session.owner?.kind === "bot-direct" && session.owner.bindingId === bindingId,
    );
  }

  private bindingSessionIsLive(binding: BotRuntimeBinding): boolean {
    const session = this.sessions.getLogicalSessionById(binding.logicalSessionId);
    if (!session) {
      return false;
    }
    return session.alias === binding.sessionAlias
      && session.owner?.kind === "bot-direct"
      && session.owner.bindingId === binding.id;
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
