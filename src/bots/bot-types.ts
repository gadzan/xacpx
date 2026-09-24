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

export function sessionMatchesExecution(
  session: { agent: string; workspace: string; model?: string; effort?: string },
  execution: BotProfileExecution,
): boolean {
  return session.agent === execution.agent
    && session.workspace === execution.workspace
    && (session.model ?? undefined) === (execution.model ?? undefined)
    && (session.effort ?? undefined) === (execution.effort ?? undefined);
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

/**
 * Group MemberTurn accepted snapshot (§9.2: the Topic owns the work target).
 * Agent identity and turn-boundary settings (agent/model/effort) come from
 * the accepted Bot profile; the workspace comes from the accepted Topic
 * ExecutionTarget — the Bot default workspace never leaks into group member
 * execution. Runtime resolution (`resolveGroupMemberExecution`) and the
 * accepted sticky-identity check (`assertGroupMemberStickyIdentity`) both
 * compare against the Topic target, so this is the only accepted-snapshot
 * constructor a group member turn may use.
 */
export function snapshotGroupMemberProfile(
  bot: BotProfile,
  topicTarget: { workspace: string },
  capturedAt: string,
): BotProfileSnapshot {
  const base = snapshotBotProfile(bot, capturedAt);
  return { ...base, execution: { ...base.execution, workspace: topicTarget.workspace } };
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
