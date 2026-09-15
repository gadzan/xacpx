export type BotRuntimeScope = "bot-direct" | "group-member" | "group-controller";

export interface BotProfile {
  id: string;
  name: string;
  avatar?: string;
  /** Human-facing role/summary. Does not change model behavior by itself. */
  role?: string;
  /** Model-facing behavior and responsibility guidance. */
  instructions?: string;
  /** Key in config.agents. */
  agent: string;
  workspace: string;
  cwd?: string;
  model?: string;
  effort?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
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
