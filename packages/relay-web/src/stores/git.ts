import { defineStore } from "pinia";
import { ref } from "vue";
import {
  MSG,
  isErrorPayload,
  type GitCheckoutPayload,
  type GitCommitResult,
  type GitFetchPayload,
  type GitPushPayload,
  type GitStatusResult,
  type GitWorktreeCreatePayload,
  type GitWorktreeCreateResult,
} from "@ganglion/xacpx-relay-protocol";
import { api } from "../api/client";

export type GitOperationKind =
  | "stage"
  | "unstage"
  | "commit"
  | "fetch"
  | "pull"
  | "push"
  | "checkout"
  | "worktree-create";

export interface GitOperation {
  kind: GitOperationKind;
  startedAt: number;
}

export interface GitOperationResult {
  kind: GitOperationKind;
  ok: boolean;
  message?: string;
  finishedAt: number;
}

function unwrap<T>(result: T | { error: { code: string; message: string } }): T {
  if (isErrorPayload(result)) throw new Error(result.error.message || result.error.code);
  return result;
}

export const useGitStore = defineStore("git", () => {
  const status = ref<GitStatusResult | null>(null);
  const operation = ref<GitOperation | null>(null);
  const lastResult = ref<GitOperationResult | null>(null);
  const error = ref("");
  let loadSequence = 0;
  let operationSequence = 0;
  let activeContext: string | null = null;

  const contextKey = (instanceId: string, workspace: string) => `${instanceId}\0${workspace}`;

  async function requestStatus(instanceId: string, workspace: string): Promise<GitStatusResult | null> {
    const context = contextKey(instanceId, workspace);
    const sequence = ++loadSequence;
    try {
      const next = unwrap(await api.rpc<GitStatusResult>(instanceId, MSG.gitStatus, { workspace }));
      if (sequence === loadSequence && context === activeContext) {
        status.value = next;
        error.value = "";
      }
      return next;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "git-status-failed";
      if (sequence === loadSequence && context === activeContext) {
        status.value = null;
        error.value = message;
      }
      return null;
    }
  }

  async function load(instanceId: string, workspace: string): Promise<GitStatusResult | null> {
    activeContext = contextKey(instanceId, workspace);
    return requestStatus(instanceId, workspace);
  }

  async function runGitOperation<T>(
    kind: GitOperationKind,
    instanceId: string,
    workspace: string,
    type: string,
    payload: unknown,
  ): Promise<T> {
    if (operation.value) throw new Error("git-operation-in-progress");
    const context = contextKey(instanceId, workspace);
    if (activeContext === null) activeContext = context;
    const sequence = ++operationSequence;
    operation.value = { kind, startedAt: Date.now() };
    error.value = "";
    try {
      const result = unwrap(await api.rpc<T>(instanceId, type, payload));
      if (activeContext === context) await requestStatus(instanceId, workspace);
      if (sequence === operationSequence && activeContext === context) {
        lastResult.value = { kind, ok: true, finishedAt: Date.now() };
      }
      return result;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : `${kind}-failed`;
      if (sequence === operationSequence && activeContext === context) {
        error.value = message;
        lastResult.value = { kind, ok: false, message, finishedAt: Date.now() };
      }
      throw cause;
    } finally {
      if (sequence === operationSequence) operation.value = null;
    }
  }

  function stage(instanceId: string, workspace: string, paths: string[]): Promise<{ ok: true }> {
    return runGitOperation("stage", instanceId, workspace, MSG.gitStage, { workspace, paths });
  }

  function unstage(instanceId: string, workspace: string, paths: string[]): Promise<{ ok: true }> {
    return runGitOperation("unstage", instanceId, workspace, MSG.gitUnstage, { workspace, paths });
  }

  function commit(instanceId: string, workspace: string, message: string): Promise<GitCommitResult> {
    return runGitOperation("commit", instanceId, workspace, MSG.gitCommit, { workspace, message });
  }

  function fetch(instanceId: string, workspace: string, options: Omit<GitFetchPayload, "workspace"> = {}): Promise<{ ok: true }> {
    return runGitOperation("fetch", instanceId, workspace, MSG.gitFetch, { workspace, ...options });
  }

  function pull(instanceId: string, workspace: string): Promise<{ ok: true }> {
    return runGitOperation("pull", instanceId, workspace, MSG.gitPull, { workspace });
  }

  function push(instanceId: string, workspace: string, options: Omit<GitPushPayload, "workspace"> = {}): Promise<{ ok: true }> {
    return runGitOperation("push", instanceId, workspace, MSG.gitPush, { workspace, ...options });
  }

  function checkout(instanceId: string, workspace: string, options: Omit<GitCheckoutPayload, "workspace">): Promise<{ ok: true }> {
    return runGitOperation("checkout", instanceId, workspace, MSG.gitCheckout, { workspace, ...options });
  }

  function createWorktree(
    instanceId: string,
    workspace: string,
    options: Omit<GitWorktreeCreatePayload, "workspace">,
  ): Promise<GitWorktreeCreateResult> {
    return runGitOperation("worktree-create", instanceId, workspace, MSG.gitWorktreeCreate, { workspace, ...options });
  }

  function reset(): void {
    loadSequence += 1;
    operationSequence += 1;
    activeContext = null;
    status.value = null;
    operation.value = null;
    lastResult.value = null;
    error.value = "";
  }

  return {
    status,
    operation,
    lastResult,
    error,
    load,
    stage,
    unstage,
    commit,
    fetch,
    pull,
    push,
    checkout,
    createWorktree,
    reset,
  };
});
