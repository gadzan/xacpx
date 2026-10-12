import { createHash } from "node:crypto";

import { BotError } from "./bot-error";
import type { BotProfile } from "./bot-types";

/**
 * Removal phase for one Bot. `previewed` does not block work. `deleting` and
 * `indeterminate` are barriers. `retired` is the tombstone, not an executable
 * profile. There is no separate "failed" phase: a failed cleanup stays
 * `deleting` and records the error on the lifecycle operation.
 */
export type BotRemovalPhase = "previewed" | "deleting" | "indeterminate" | "retired";

export type BotRemovalBarrierPhase = Exclude<BotRemovalPhase, "previewed">;

export interface BotTombstone {
  id: string;
  name: string;
  avatar?: string;
  role?: string;
  agent: string;
  workspace: string;
  retiredAt: string;
}

export interface BotRemovalRecord {
  botId: string;
  phase: BotRemovalPhase;
  operationId?: string;
  requestId?: string;
  previewRevision?: string;
  clearDirectHistory?: boolean;
  releaseDirectBindings?: boolean;
  tombstone?: BotTombstone;
  error?: { code: string; message: string };
  updatedAt: string;
}

export type BotRemovalCommand =
  | { type: "preview"; revision: string; at: string }
  | {
    type: "begin";
    operationId: string;
    requestId: string;
    revision: string;
    clearDirectHistory: boolean;
    releaseDirectBindings: boolean;
    at: string;
  }
  | { type: "fail"; error: { code: string; message: string }; at: string }
  | { type: "indeterminate"; error: { code: string; message: string }; at: string }
  | { type: "retire"; tombstone: BotTombstone; at: string };

export interface BotRemovalFacts {
  directTopicIds: string[];
  activeRunIds: string[];
  queuedRunIds: string[];
  indeterminateRunIds: string[];
  memberUnsettledRunIds: string[];
  groups: Array<{ conversationId: string; memberCount: number; botIds: string[] }>;
  memberRuntimeKeys: string[];
  worktreeKeys: string[];
  bindingKeys: string[];
  history: {
    directMessages: number;
    directRuns: number;
    groupMessages: number;
    groupRuns: number;
  };
}

export type GroupRemovalBlocker = "remove-member-first" | "group-needs-another-member";

export interface BotRemovalPreview {
  botId: string;
  name: string;
  phase: "active" | BotRemovalPhase;
  revision: string;
  directTopics: Array<{ id: string; title: string; status: string }>;
  runs: { active: string[]; queued: string[]; indeterminate: string[] };
  groups: Array<{
    conversationId: string;
    title: string;
    memberCount: number;
    blocker: GroupRemovalBlocker;
  }>;
  departedMemberRuntimes: Array<{
    conversationId: string;
    topicId: string;
    bindingId?: string;
    sessionAlias?: string;
  }>;
  worktrees: Array<{ runId: string; conversationId: string; topicId: string; state: string }>;
  externalBindings: Array<{ key: string; conversationId: string; topicId: string }>;
  history: BotRemovalFacts["history"];
  controllerResidue: { bindingIds: string[]; sessionAliases: string[] };
  memberUnsettledRunIds: string[];
  operation?: {
    id: string;
    requestId: string;
    phase: "running" | "failed" | "indeterminate" | "completed";
    error?: { code: string; message: string };
  };
}

const PHASES: readonly BotRemovalPhase[] = ["previewed", "deleting", "indeterminate", "retired"];

export function removalBlocksWork(phase: BotRemovalPhase): phase is BotRemovalBarrierPhase {
  return phase !== "previewed";
}

/** Two members cannot lose one. A larger group must be edited by the user first. */
export function groupRemovalBlocker(memberCount: number): GroupRemovalBlocker {
  return memberCount <= 2 ? "group-needs-another-member" : "remove-member-first";
}

const SETTLED_WORKTREE_STATES = new Set(["integrated", "cleaned"]);

export function worktreeBlocksRemoval(resourceState: string, disposition: string): boolean {
  if (disposition === "abandoned" || disposition === "integrated") {
    return false;
  }
  return !SETTLED_WORKTREE_STATES.has(resourceState);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

/** Stable preview token. Membership, runs, bindings, and history counts all move it. */
export function botRemovalRevision(facts: BotRemovalFacts): string {
  const canonical = {
    directTopicIds: sorted(facts.directTopicIds),
    activeRunIds: sorted(facts.activeRunIds),
    queuedRunIds: sorted(facts.queuedRunIds),
    indeterminateRunIds: sorted(facts.indeterminateRunIds),
    memberUnsettledRunIds: sorted(facts.memberUnsettledRunIds),
    groups: [...facts.groups]
      .map((group) => ({
        conversationId: group.conversationId,
        memberCount: group.memberCount,
        botIds: sorted(group.botIds),
      }))
      .sort((left, right) => left.conversationId.localeCompare(right.conversationId)),
    memberRuntimeKeys: sorted(facts.memberRuntimeKeys),
    worktreeKeys: sorted(facts.worktreeKeys),
    bindingKeys: sorted(facts.bindingKeys),
    history: facts.history,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32);
}

export function tombstoneFromProfile(bot: BotProfile, retiredAt: string): BotTombstone {
  return {
    id: bot.id,
    name: bot.name,
    ...(bot.avatar ? { avatar: bot.avatar } : {}),
    ...(bot.role ? { role: bot.role } : {}),
    agent: bot.agent,
    workspace: bot.workspace,
    retiredAt,
  };
}

/**
 * Legal removal transitions. Retire is only from `deleting`, after live work
 * is gone. `indeterminate` cannot retire in the same step.
 */
export function transitionBotRemoval(
  state: BotRemovalRecord | undefined,
  botId: string,
  command: BotRemovalCommand,
): BotRemovalRecord {
  switch (command.type) {
    case "preview": {
      if (state && removalBlocksWork(state.phase)) {
        return state;
      }
      return {
        botId,
        phase: "previewed",
        previewRevision: command.revision,
        updatedAt: command.at,
        ...(state?.operationId ? { operationId: state.operationId } : {}),
        ...(state?.requestId ? { requestId: state.requestId } : {}),
      };
    }
    case "begin": {
      if (state?.phase === "retired") {
        if (state.requestId === command.requestId) {
          return state;
        }
        throw new BotError("bot_retired", `bot "${botId}" is already removed`);
      }
      if (state && (state.phase === "deleting" || state.phase === "indeterminate")) {
        if (state.requestId && state.requestId !== command.requestId) {
          throw new BotError("removal_in_progress", `bot "${botId}" already has a removal in progress`, {
            requestId: state.requestId,
            operationId: state.operationId,
          });
        }
        return {
          ...state,
          phase: "deleting",
          operationId: command.operationId,
          requestId: command.requestId,
          previewRevision: state.previewRevision ?? command.revision,
          clearDirectHistory: state.clearDirectHistory ?? command.clearDirectHistory,
          releaseDirectBindings: state.releaseDirectBindings ?? command.releaseDirectBindings,
          error: undefined,
          updatedAt: command.at,
        };
      }
      return {
        botId,
        phase: "deleting",
        operationId: command.operationId,
        requestId: command.requestId,
        previewRevision: command.revision,
        clearDirectHistory: command.clearDirectHistory,
        releaseDirectBindings: command.releaseDirectBindings,
        updatedAt: command.at,
      };
    }
    case "fail": {
      if (!state || state.phase === "previewed") {
        throw new BotError("bot_not_removing", `bot "${botId}" is not being removed`);
      }
      if (state.phase === "retired" || state.phase === "indeterminate") {
        return state;
      }
      return { ...state, phase: "deleting", error: command.error, updatedAt: command.at };
    }
    case "indeterminate": {
      if (!state || state.phase === "previewed") {
        throw new BotError("bot_not_removing", `bot "${botId}" is not being removed`);
      }
      if (state.phase === "retired") {
        return state;
      }
      return { ...state, phase: "indeterminate", error: command.error, updatedAt: command.at };
    }
    case "retire": {
      if (state?.phase === "retired") {
        return state.tombstone ? state : { ...state, tombstone: command.tombstone, updatedAt: command.at };
      }
      if (state?.phase !== "deleting") {
        throw new BotError("bot_not_removing", `bot "${botId}" cannot retire from this phase`);
      }
      if (command.tombstone.id !== botId) {
        throw new BotError("bot_not_found", `tombstone does not match bot "${botId}"`);
      }
      return {
        ...state,
        phase: "retired",
        tombstone: command.tombstone,
        error: undefined,
        updatedAt: command.at,
      };
    }
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
}

function optionalText(value: unknown): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return value;
}

function parseTombstone(value: unknown, botId: string): BotTombstone | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.id !== botId || typeof record.name !== "string" || record.name.length === 0) {
    return undefined;
  }
  if (typeof record.agent !== "string" || typeof record.workspace !== "string" || typeof record.retiredAt !== "string") {
    return undefined;
  }
  const avatar = optionalText(record.avatar);
  const role = optionalText(record.role);
  if (avatar === null || role === null) {
    return undefined;
  }
  return {
    id: botId,
    name: record.name,
    ...(avatar ? { avatar } : {}),
    ...(role ? { role } : {}),
    agent: record.agent,
    workspace: record.workspace,
    retiredAt: record.retiredAt,
  };
}

/** Boundary parse for AppState. Retired without a tombstone is dropped. */
export function parseBotRemovalRecord(value: unknown, botId: string): BotRemovalRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.botId !== botId || typeof record.updatedAt !== "string") {
    return undefined;
  }
  if (typeof record.phase !== "string" || !PHASES.includes(record.phase as BotRemovalPhase)) {
    return undefined;
  }
  const phase = record.phase as BotRemovalPhase;
  const tombstone = record.tombstone === undefined ? undefined : parseTombstone(record.tombstone, botId);
  if (record.tombstone !== undefined && !tombstone) {
    return undefined;
  }
  if (phase === "retired" && !tombstone) {
    return undefined;
  }
  const textField = (key: string): string | undefined | null => {
    if (record[key] === undefined) {
      return undefined;
    }
    return typeof record[key] === "string" ? record[key] as string : null;
  };
  const operationId = textField("operationId");
  const requestId = textField("requestId");
  const previewRevision = textField("previewRevision");
  if (operationId === null || requestId === null || previewRevision === null) {
    return undefined;
  }
  if (record.clearDirectHistory !== undefined && typeof record.clearDirectHistory !== "boolean") {
    return undefined;
  }
  if (record.releaseDirectBindings !== undefined && typeof record.releaseDirectBindings !== "boolean") {
    return undefined;
  }
  let error: { code: string; message: string } | undefined;
  if (record.error !== undefined) {
    if (!record.error || typeof record.error !== "object") {
      return undefined;
    }
    const body = record.error as Record<string, unknown>;
    if (typeof body.code !== "string" || typeof body.message !== "string") {
      return undefined;
    }
    error = { code: body.code, message: body.message };
  }
  return {
    botId,
    phase,
    ...(operationId ? { operationId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(previewRevision ? { previewRevision } : {}),
    ...(typeof record.clearDirectHistory === "boolean" ? { clearDirectHistory: record.clearDirectHistory } : {}),
    ...(typeof record.releaseDirectBindings === "boolean" ? { releaseDirectBindings: record.releaseDirectBindings } : {}),
    ...(tombstone ? { tombstone } : {}),
    ...(error ? { error } : {}),
    updatedAt: record.updatedAt,
  };
}
