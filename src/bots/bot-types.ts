export type BotRuntimeScope = "bot-direct" | "group-member" | "group-controller";

export interface BotProfilePresentation {
  name: string;
  avatar?: string;
  role?: string;
}

export interface BotProfileBehavior {
  instructions?: string;
}

export interface BotProfileExecution {
  agent: string;
  workspace: string;
  model?: string;
  effort?: string;
}

/** Durable linearization of the Bot fields a Run was accepted against. */
export interface BotProfileSnapshot {
  revision: number;
  capturedAt: string;
  presentation: BotProfilePresentation;
  behavior: BotProfileBehavior;
  execution: BotProfileExecution;
}

export interface BotProfile {
  id: string;
  name: string;
  avatar?: string;
  role?: string;
  instructions?: string;
  agent: string;
  workspace: string;
  cwd?: string;
  model?: string;
  effort?: string;
  enabled: boolean;
  /** Monotonic Bot-config generation. Missing on PR2 records; parse defaults to 1. */
  profileRevision: number;
  createdAt: string;
  updatedAt: string;
}

export function snapshotBotProfile(bot: BotProfile, capturedAt: string): BotProfileSnapshot {
  return {
    revision: bot.profileRevision,
    capturedAt,
    presentation: {
      name: bot.name,
      ...(bot.avatar ? { avatar: bot.avatar } : {}),
      ...(bot.role ? { role: bot.role } : {}),
    },
    behavior: {
      ...(bot.instructions ? { instructions: bot.instructions } : {}),
    },
    execution: {
      agent: bot.agent,
      workspace: bot.workspace,
      ...(bot.model ? { model: bot.model } : {}),
      ...(bot.effort ? { effort: bot.effort } : {}),
    },
  };
}

interface BotRuntimeBindingBase {
  id: string;
  conversationId: string;
  topicId: string;
  logicalSessionId: string;
  sessionAlias: string;
  createdAt: string;
  updatedAt: string;
}

export type BotRuntimeBinding =
  | (BotRuntimeBindingBase & { scope: "bot-direct"; botId: string })
  | (BotRuntimeBindingBase & { scope: "group-member"; botId: string })
  | (BotRuntimeBindingBase & { scope: "group-controller" });
