import { composeBotTurnPrompt } from "./bot-profile-prompt";
import { BotError } from "./bot-error";
import type { BotService } from "./bot-service";
import type { BotProfile, BotRuntimeBinding } from "./bot-types";
import { ensureDirectConversation } from "../conversations/direct-conversation";
import { createRuntimeBindingId } from "../domain/ids";
import { AsyncMutex } from "../orchestration/async-mutex";
import type { SessionService } from "../sessions/session-service";
import type { StateStore } from "../state/state-store";
import type { AppState } from "../state/types";

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
  createBindingId?: () => string;
  createConversationId?: () => string;
  createTopicId?: () => string;
  stateMutex?: AsyncMutex;
}

interface DirectSessionPlan {
  bot: BotProfile;
  conversationId: string;
  topicId: string;
  existing?: BotRuntimeBinding;
}

export class BotRuntimeManager {
  private readonly now: () => Date;
  private readonly createBindingId: () => string;
  private readonly createConversationId?: () => string;
  private readonly createTopicId?: () => string;
  private readonly stateMutex: AsyncMutex;

  constructor(
    private readonly bots: BotService,
    private readonly sessions: Pick<
      SessionService,
      "createSession" | "getLogicalSessionRecord" | "getLogicalSessionById" | "setSessionModel" | "setSessionEffort"
    >,
    private readonly state: AppState,
    private readonly stateStore: Pick<StateStore, "save">,
    options?: BotRuntimeManagerOptions,
  ) {
    this.now = options?.now ?? (() => new Date());
    this.createBindingId = options?.createBindingId ?? (() => createRuntimeBindingId());
    this.createConversationId = options?.createConversationId;
    this.createTopicId = options?.createTopicId;
    this.stateMutex = options?.stateMutex ?? new AsyncMutex();
  }

  async getOrCreateDirectSession(input: {
    botId: string;
    conversationId?: string;
    topicId?: string;
  }): Promise<BotRuntimeBinding> {
    const plan = await this.stateMutex.run(async () => this.planDirectSession(input));
    if (plan.existing && this.bindingSessionIsLive(plan.existing)) {
      await this.alignSessionRuntime(plan.existing, plan.bot);
      return plan.existing;
    }
    const bindingId = plan.existing?.id ?? this.nextBindingId();
    const alias = `brt_${bindingId}`;
    const session = await this.sessions.createSession(alias, plan.bot.agent, plan.bot.workspace, {
      owner: { kind: "bot-direct", bindingId },
      ...(plan.bot.model ? { model: plan.bot.model } : {}),
      ...(plan.bot.effort ? { effort: plan.bot.effort } : {}),
    });
    return await this.stateMutex.run(async () => {
      const current = this.findDirectBinding(plan.conversationId, plan.topicId, plan.bot.id);
      if (current && this.bindingSessionIsLive(current)) {
        return current;
      }
      const record = this.sessions.getLogicalSessionRecord(session.alias)
        ?? (session.logicalSessionId ? this.sessions.getLogicalSessionById(session.logicalSessionId) : null);
      if (!record) {
        throw new BotError("session_missing", `failed to persist owned session for bot "${plan.bot.id}"`);
      }
      const timestamp = this.now().toISOString();
      const binding: BotRuntimeBinding = {
        id: bindingId,
        scope: "bot-direct",
        conversationId: plan.conversationId,
        topicId: plan.topicId,
        botId: plan.bot.id,
        logicalSessionId: record.logical_session_id,
        sessionAlias: record.alias,
        createdAt: current?.createdAt ?? plan.existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      this.state.bot_runtime_bindings[bindingId] = binding;
      await this.stateStore.save(this.state);
      return binding;
    });
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

  private planDirectSession(input: {
    botId: string;
    conversationId?: string;
    topicId?: string;
  }): DirectSessionPlan {
    const bot = this.bots.getBot(input.botId);
    if (!bot.enabled) {
      throw new BotError("bot_disabled", `bot "${input.botId}" is disabled`);
    }
    const timestamp = this.now().toISOString();
    const { conversation, topic } = ensureDirectConversation(this.state, {
      botId: bot.id,
      title: bot.name,
      now: timestamp,
      ...(this.createConversationId ? { createConversationId: this.createConversationId } : {}),
      ...(this.createTopicId ? { createTopicId: this.createTopicId } : {}),
    });
    if (input.conversationId && input.conversationId !== conversation.id) {
      throw new BotError("conversation_mismatch", "direct Bot conversation does not match this Bot");
    }
    if (input.topicId && input.topicId !== topic.id) {
      const requested = this.state.conversation_topics[input.topicId];
      if (!requested || requested.conversationId !== conversation.id) {
        throw new BotError("topic_not_found", `topic "${input.topicId}" does not belong to this Bot conversation`);
      }
    }
    const topicId = input.topicId && this.state.conversation_topics[input.topicId]?.conversationId === conversation.id
      ? input.topicId
      : topic.id;
    const existing = this.findDirectBinding(conversation.id, topicId, bot.id);
    return {
      bot,
      conversationId: conversation.id,
      topicId,
      ...(existing ? { existing } : {}),
    };
  }

  private findDirectBinding(conversationId: string, topicId: string, botId: string): BotRuntimeBinding | undefined {
    return Object.values(this.state.bot_runtime_bindings).find(
      (binding) =>
        binding.scope === "bot-direct"
        && binding.conversationId === conversationId
        && binding.topicId === topicId
        && binding.botId === botId,
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

  private nextBindingId(): string {
    const id = this.createBindingId();
    return id.startsWith("bind_") ? id : createRuntimeBindingId(() => id);
  }
}
