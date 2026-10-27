import { copyBotAvatar, type BotAvatarConfig } from "@ganglion/xacpx-relay-protocol";

export type BotRuntimeScope = "bot-direct" | "group-member" | "group-controller";

export interface BotProfilePresentation {
  name: string;
  avatar?: BotAvatarConfig;
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

/**
 * Marks a Bot whose default workspace was auto-allocated by the daemon
 * under `~/.xacpx/bots/`. Absent when the caller chose a registered
 * workspace: only the daemon knows that a directory exists because of the
 * Bot, so only the daemon may claim ownership of it.
 */
export interface DedicatedWorkspaceMarker {
  /** Registered workspace name the Bot points at. */
  name: string;
  /** Absolute path of the directory the daemon created. */
  cwd: string;
  /** ISO timestamp of the allocation. */
  createdAt: string;
}

/** Runtime narrowing for a persisted marker: all three fields must be
 *  non-empty strings, so a record that lost one is rejected rather than
 *  silently dropping a directory on disk. */
export function isDedicatedWorkspaceMarker(value: unknown): value is DedicatedWorkspaceMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const marker = value as Record<string, unknown>;
  return isNonEmptyString(marker.name)
    && isNonEmptyString(marker.cwd)
    && isNonEmptyString(marker.createdAt);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export interface BotProfile {
  id: string;
  name: string;
  avatar?: BotAvatarConfig;
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
  /** Present only for a daemon-allocated dedicated workspace. */
  dedicatedWorkspace?: DedicatedWorkspaceMarker;
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
      ...(bot.avatar ? { avatar: copyBotAvatar(bot.avatar) } : {}),
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
 * Group MemberTurn accepted snapshot.
 *
 * A `shared` Group owns one work target per Topic: agent identity and
 * turn-boundary settings (agent/model/effort) come from the accepted Bot
 * profile, and the workspace comes from the accepted Topic ExecutionTarget —
 * the Bot default workspace never leaks into member execution there.
 *
 * A `per-member` Group has no group workspace at all: `topicTarget` is absent
 * and the member snapshot keeps the Bot's own workspace, exactly like a Direct
 * session. Runtime resolution (`resolveGroupMemberExecution`) and the accepted
 * sticky-identity check (`assertGroupMemberStickyIdentity`) both branch on the
 * same two cases, so this is the only accepted-snapshot constructor a group
 * member turn may use.
 */
export function snapshotGroupMemberProfile(
  bot: BotProfile,
  topicTarget: { workspace: string } | undefined,
  capturedAt: string,
): BotProfileSnapshot {
  const base = snapshotBotProfile(bot, capturedAt);
  return topicTarget ? { ...base, execution: { ...base.execution, workspace: topicTarget.workspace } } : base;
}

interface BotRuntimeBindingBase {
  id: string;
  conversationId: string;
  topicId: string;
  logicalSessionId: string;
  sessionAlias: string;
  createdAt: string;
  updatedAt: string;
  /** Topic context generation at publish. Absent matches generation 1. */
  contextGeneration?: number;
}

export type BotRuntimeBinding =
  | (BotRuntimeBindingBase & { scope: "bot-direct"; botId: string })
  | (BotRuntimeBindingBase & { scope: "group-member"; botId: string })
  | (BotRuntimeBindingBase & { scope: "group-controller" });
