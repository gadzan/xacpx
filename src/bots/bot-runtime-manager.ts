import { composeBotTurnPrompt } from "./bot-profile-prompt";
import { BotError } from "./bot-error";
import type { BotService } from "./bot-service";
import type { BotRuntimeBinding } from "./bot-types";
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
    return await this.stateMutex.run(async () => {
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
      if (existing && this.bindingSessionIsLive(existing)) {
        await this.alignSessionRuntime(existing, bot);
        return existing;
      }
      const bindingId = existing?.id ?? this.nextBindingId();
      const alias = `brt_${bindingId}`;
      const session = await this.sessions.createSession(alias, bot.agent, bot.workspace, {
        owner: { kind: "bot-direct", bindingId },
        ...(bot.model ? { model: bot.model } : {}),
        ...(bot.effort ? { effort: bot.effort } : {}),
      });
      const record = this.sessions.getLogicalSessionRecord(session.alias);
      if (!record) {
        throw new BotError("session_missing", `failed to persist owned session for bot "${bot.id}"`);
      }
      const binding: BotRuntimeBinding = {
        id: bindingId,
        scope: "bot-direct",
        conversationId: conversation.id,
        topicId,
        botId: bot.id,
        logicalSessionId: record.logical_session_id,
        sessionAlias: record.alias,
        createdAt: existing?.createdAt ?? timestamp,
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
    const byId = this.sessions.getLogicalSessionById(binding.logicalSessionId);
    const byAlias = this.sessions.getLogicalSessionRecord(binding.sessionAlias);
    const session = byId ?? byAlias;
    if (!session) {
      return false;
    }
    return session.owner?.kind === "bot-direct" && session.owner.bindingId === binding.id;
  }

  private async alignSessionRuntime(
    binding: BotRuntimeBinding,
    bot: { model?: string; effort?: string },
  ): Promise<void> {
    await this.sessions.setSessionModel(binding.sessionAlias, bot.model);
    await this.sessions.setSessionEffort(binding.sessionAlias, bot.effort);
  }

  private nextBindingId(): string {
    const id = this.createBindingId();
    return id.startsWith("bind_") ? id : createRuntimeBindingId(() => id);
  }
}
