import type { Stats } from "node:fs";
import { lstat, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { isWorkspaceRemovalRefused } from "../config/workspace-removal";
import type { AppState } from "../state/types";
import type { DedicatedWorkspaceMarker } from "./bot-types";

/** Every durable reference that can keep a dedicated workspace directory alive. */
export interface DedicatedWorkspaceReferences {
  readonly bots: readonly string[];
  readonly sessions: readonly string[];
  readonly topics: readonly string[];
  readonly scheduledTasks: readonly string[];
  readonly worktrees: readonly string[];
}

export type DedicatedWorkspacePathFault =
  | "root_symlink"
  | "symlink"
  | "not_canonical"
  | "outside_root"
  | "name_mismatch"
  | "not_a_directory";

export type DedicatedWorkspaceCleanupBlocker =
  | { readonly kind: "cwd_mismatch"; readonly registeredCwd: string }
  | { readonly kind: "in_use"; readonly references: DedicatedWorkspaceReferences }
  | { readonly kind: "unsafe_path"; readonly fault: DedicatedWorkspacePathFault };

export interface DedicatedWorkspaceCleanupPlan {
  readonly marker: DedicatedWorkspaceMarker;
  /** Absolute directory the marker claims. */
  readonly path: string;
  /** Null when the directory may be unregistered and deleted. */
  readonly blocker: DedicatedWorkspaceCleanupBlocker | null;
}

export type DedicatedWorkspaceCleanupCode =
  | "cwd_mismatch"
  | "workspace_in_use"
  | "root_symlink"
  | "symlink"
  | "not_canonical"
  | "outside_root"
  | "name_mismatch"
  | "not_a_directory"
  | "no_marker"
  | "cleanup_failed";

export const DEDICATED_WORKSPACE_CLEANUP_CODES: readonly DedicatedWorkspaceCleanupCode[] = [
  "cwd_mismatch",
  "workspace_in_use",
  "root_symlink",
  "symlink",
  "not_canonical",
  "outside_root",
  "name_mismatch",
  "not_a_directory",
  "no_marker",
  "cleanup_failed",
];

export type DedicatedWorkspaceCleanupOutcome =
  | { readonly outcome: "deleted"; readonly path: string }
  | { readonly outcome: "kept"; readonly path: string; readonly code: DedicatedWorkspaceCleanupCode }
  | { readonly outcome: "failed"; readonly path: string; readonly code: DedicatedWorkspaceCleanupCode };

export interface RegisteredWorkspace {
  readonly name: string;
  readonly cwd: string;
}

export type DedicatedWorkspaceCleanupInput = {
  /** Marker the Bot profile carried. */
  readonly marker: DedicatedWorkspaceMarker | undefined;
  /** The Bot's workspace name, read before the profile is retired. */
  readonly workspace: string;
  readonly workspaces: readonly RegisteredWorkspace[];
  readonly botsHomeRoot: string;
  readonly references: DedicatedWorkspaceReferences;
};

export type DedicatedWorkspaceReferenceSources = Pick<
  AppState,
  "bots" | "sessions" | "conversation_topics" | "scheduled_tasks" | "orchestration"
>;

export type WorkspaceRegistry = {
  list(): readonly RegisteredWorkspace[];
  remove(name: string, expectedCwd?: string): Promise<void>;
  transaction?<T>(fn: (workspaces: Pick<WorkspaceRegistry, "list" | "remove">) => Promise<T>): Promise<T>;
};

export type DedicatedWorkspaceCleanupDeps = {
  readonly workspaces: WorkspaceRegistry;
  readonly botsHomeRoot: string;
  /** Live references, re-read at execution time so a preview is never reused. */
  readonly references: () => DedicatedWorkspaceReferences;
};

/**
 * Read-only half, shared by preview and remove. Returns null when the Bot
 * carries no marker or no longer points at the workspace the marker names.
 */
export async function evaluateDedicatedWorkspaceCleanup(
  input: DedicatedWorkspaceCleanupInput,
): Promise<DedicatedWorkspaceCleanupPlan | null> {
  const marker = input.marker;
  if (marker === undefined || input.workspace !== marker.name) {
    return null;
  }
  const path = resolve(marker.cwd);
  const blocker = await firstBlocker(input, marker, path);
  return blocker === undefined ? { marker, path, blocker: null } : { marker, path, blocker };
}

/**
 * Executing half. Re-evaluates inside the registry transaction, unregisters
 * the entry, then removes the directory. Returns null when there is nothing
 * to clean. A failure never escapes: the caller reports the outcome and the
 * Bot removal stays completed.
 */
export async function cleanupDedicatedWorkspace(input: {
  readonly marker: DedicatedWorkspaceMarker;
  readonly workspace: string;
  readonly deps: DedicatedWorkspaceCleanupDeps;
}): Promise<DedicatedWorkspaceCleanupOutcome | null> {
  const plan = await evaluateDedicatedWorkspaceCleanup({
    marker: input.marker,
    workspace: input.workspace,
    workspaces: input.deps.workspaces.list(),
    botsHomeRoot: input.deps.botsHomeRoot,
    references: input.deps.references(),
  });
  if (plan === null) {
    return null;
  }
  if (plan.blocker !== null) {
    return { outcome: "kept", path: plan.path, code: blockerCode(plan.blocker) };
  }
  const execute = async (workspaces: Pick<WorkspaceRegistry, "list" | "remove">) => {
    const live = await evaluateDedicatedWorkspaceCleanup({
      marker: input.marker,
      workspace: input.workspace,
      workspaces: workspaces.list(),
      botsHomeRoot: input.deps.botsHomeRoot,
      references: input.deps.references(),
    });
    if (live === null) {
      return { outcome: "kept", path: plan.path, code: "no_marker" } as const;
    }
    if (live.blocker !== null) {
      return { outcome: "kept", path: plan.path, code: blockerCode(live.blocker) } as const;
    }
    await workspaces.remove(input.marker.name, input.marker.cwd);
    await removeDirectory(input.marker.cwd);
    return { outcome: "deleted", path: plan.path } as const;
  };
  try {
    return input.deps.workspaces.transaction
      ? await input.deps.workspaces.transaction(execute)
      : await execute(input.deps.workspaces);
  } catch (error) {
    return { outcome: "failed", path: plan.path, code: failureCode(error) };
  }
}

/** Names every durable reference that still points at `name`, minus the Bot being removed. */
export function gatherDedicatedWorkspaceReferences(
  sources: DedicatedWorkspaceReferenceSources,
  worktrees: readonly { readonly workspace: string; readonly runId: string }[],
  name: string,
  excludeBotId: string,
): DedicatedWorkspaceReferences {
  return {
    bots: keys(sources.bots, ([id, bot]) => id !== excludeBotId && bot.workspace === name),
    sessions: [
      ...keys(sources.sessions, ([, session]) => session.workspace === name),
      ...keys(sources.orchestration.workerBindings, ([, binding]) => binding.workspace === name),
    ],
    topics: Object.values(sources.conversation_topics)
      .filter((topic) => topic.executionTarget?.workspace === name)
      .map((topic) => topic.id),
    scheduledTasks: keys(sources.scheduled_tasks, ([, task]) => task.workspace === name),
    worktrees: worktrees.filter((run) => run.workspace === name).map((run) => run.runId),
  };
}

async function firstBlocker(
  input: DedicatedWorkspaceCleanupInput,
  marker: DedicatedWorkspaceMarker,
  path: string,
): Promise<DedicatedWorkspaceCleanupBlocker | undefined> {
  const registered = input.workspaces.find((workspace) => workspace.name === marker.name);
  if (registered === undefined || registered.cwd !== marker.cwd) {
    return { kind: "cwd_mismatch", registeredCwd: registered?.cwd ?? "" };
  }
  if (hasReferences(input.references)) {
    return { kind: "in_use", references: input.references };
  }
  const fault = await pathFault(input.botsHomeRoot, path, marker.name);
  return fault === null ? undefined : { kind: "unsafe_path", fault };
}

function hasReferences(references: DedicatedWorkspaceReferences): boolean {
  return references.bots.length > 0
    || references.sessions.length > 0
    || references.topics.length > 0
    || references.scheduledTasks.length > 0
    || references.worktrees.length > 0;
}

function blockerCode(blocker: DedicatedWorkspaceCleanupBlocker): DedicatedWorkspaceCleanupCode {
  switch (blocker.kind) {
    case "cwd_mismatch":
      return "cwd_mismatch";
    case "in_use":
      return "workspace_in_use";
    case "unsafe_path":
      return blocker.fault;
  }
}

function failureCode(error: unknown): DedicatedWorkspaceCleanupCode {
  if (isWorkspaceRemovalRefused(error)) {
    return error.reason === "in_use" ? "workspace_in_use" : "cwd_mismatch";
  }
  return "cleanup_failed";
}

async function removeDirectory(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true });
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * The directory must be the daemon's own slot directly under the bots root,
 * reached through no symlink. A directory that is already gone is safe: the
 * registry entry still exists and `rm` reports ENOENT as success, so a retry
 * after a crash converges.
 */
async function pathFault(
  botsHomeRoot: string,
  path: string,
  name: string,
): Promise<DedicatedWorkspacePathFault | null> {
  const root = resolve(botsHomeRoot);
  const rootStats = await lstat(root).catch(() => null);
  if (rootStats === null || !rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    return "root_symlink";
  }
  if (basename(path) !== name) {
    return "name_mismatch";
  }
  const realRoot = await realpath(root);
  if (dirname(path) !== root && dirname(path) !== realRoot) {
    return "outside_root";
  }
  const dirStats = await lstatDirectory(path);
  if (dirStats === "unreadable") {
    return "not_a_directory";
  }
  if (dirStats === null) {
    return null;
  }
  if (dirStats.isSymbolicLink()) {
    return "symlink";
  }
  if (!dirStats.isDirectory()) {
    return "not_a_directory";
  }
  if (await realpath(path) !== join(realRoot, name)) {
    return "not_canonical";
  }
  return null;
}

async function lstatDirectory(path: string): Promise<Stats | null | "unreadable"> {
  try {
    return await lstat(path);
  } catch (error) {
    return isEnoent(error) ? null : "unreadable";
  }
}

function keys<T>(source: Record<string, T>, keep: (entry: [string, T]) => boolean): string[] {
  return Object.entries(source).filter(keep).map(([key]) => key);
}
