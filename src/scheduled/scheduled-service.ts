import { AsyncMutex } from "../orchestration/async-mutex";
import { sanitizeString } from "../util/sanitize.js";
import type { StateStore } from "../state/state-store";
import type { AppState } from "../state/types";
import type { ScheduledSessionMode, ScheduledTaskRecord } from "./scheduled-types";

export interface CreateScheduledTaskInput {
  chatKey: string;
  sessionAlias: string;
  executeAt: Date;
  message: string;
  sessionMode?: ScheduledSessionMode;
  agent?: string;
  workspace?: string;
  accountId?: string;
  replyContextToken?: string;
  sourceLabel?: string;
}

export interface ScheduledTaskServiceOptions {
  now?: () => Date;
  generateId?: () => string;
  // Must be the same mutex the SessionService/OrchestrationService share so
  // scheduled writes serialize with orchestration's load→save critical section.
  // Without it, a scheduled mutation can interleave between orchestration's
  // state clone and its save, and the (stale) clone overwrites the new task on
  // disk — silently losing a pending task across a daemon restart.
  stateMutex?: AsyncMutex;
}

export class ScheduledTaskService {
  private readonly now: () => Date;
  private readonly generateId: () => string;
  private readonly stateMutex: AsyncMutex;
  private readonly claimedInThisSession = new Set<string>();

  constructor(
    private readonly state: AppState,
    private readonly stateStore: Pick<StateStore, "save">,
    options?: ScheduledTaskServiceOptions,
  ) {
    this.now = options?.now ?? (() => new Date());
    this.generateId = options?.generateId ?? (() => Math.random().toString(36).slice(2, 6));
    this.stateMutex = options?.stateMutex ?? new AsyncMutex();
  }

  async createTask(input: CreateScheduledTaskInput): Promise<ScheduledTaskRecord> {
    return await this.mutate(async () => {
      const id = this.nextId();
      const task: ScheduledTaskRecord = {
        id,
        chat_key: input.chatKey,
        session_alias: input.sessionAlias,
        execute_at: input.executeAt.toISOString(),
        message: input.message,
        status: "pending",
        created_at: this.now().toISOString(),
        ...(input.sessionMode ? { session_mode: input.sessionMode } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.workspace ? { workspace: input.workspace } : {}),
        ...(input.accountId ? { account_id: input.accountId } : {}),
        ...(input.replyContextToken ? { reply_context_token: input.replyContextToken } : {}),
        ...(input.sourceLabel ? { source_label: input.sourceLabel } : {}),
      };
      this.state.scheduled_tasks[id] = task;
      await this.save();
      return task;
    });
  }

  // Chat-scoped view: tasks are private to their originating chat, so callers
  // acting on behalf of a chat (router commands, MCP route tools) must pass
  // that chat's key and only ever see/cancel their own tasks.
  listPending(chatKey: string): ScheduledTaskRecord[] {
    return this.listPendingAllChats().filter((task) => task.chat_key === chatKey);
  }

  // Chat-scoped view for the web panel: upcoming tasks (pending + in-flight
  // triggering) first, then the most recent terminal runs (executed/failed/missed/
  // cancelled) so a fired task leaves a visible record instead of silently vanishing.
  // Terminal rows are capped so the list can't grow without bound.
  listRecentForChat(chatKey: string, opts?: { terminalLimit?: number }): ScheduledTaskRecord[] {
    const terminalLimit = opts?.terminalLimit ?? 20;
    const mine = Object.values(this.state.scheduled_tasks).filter((task) => task.chat_key === chatKey);
    const upcoming = mine
      .filter((task) => task.status === "pending" || task.status === "triggering")
      .sort((left, right) => left.execute_at.localeCompare(right.execute_at));
    const settledAt = (task: ScheduledTaskRecord): string =>
      task.executed_at ?? task.failed_at ?? task.cancelled_at ?? task.missed_at ?? task.triggered_at ?? task.created_at;
    const terminal = mine
      .filter((task) => task.status === "executed" || task.status === "failed" || task.status === "missed" || task.status === "cancelled")
      .sort((left, right) => settledAt(right).localeCompare(settledAt(left)))
      .slice(0, terminalLimit);
    return [...upcoming, ...terminal];
  }

  // Unscoped view for operator/internal surfaces (local CLI, the scheduler's
  // own claiming loop). Never expose this to a chat- or route-driven caller.
  listPendingAllChats(): ScheduledTaskRecord[] {
    return Object.values(this.state.scheduled_tasks)
      .filter((task) => task.status === "pending")
      .sort((left, right) => left.execute_at.localeCompare(right.execute_at));
  }

  // A chatKey mismatch is reported exactly like an unknown id so another chat
  // cannot probe whether a given task id exists.
  async cancelPending(inputId: string, chatKey: string): Promise<boolean> {
    return await this.cancelPendingWhere(inputId, (task) => task.chat_key === chatKey);
  }

  // Unscoped cancel for the local operator CLI. Never expose to chat callers.
  async cancelPendingAnyChat(inputId: string): Promise<boolean> {
    return await this.cancelPendingWhere(inputId, () => true);
  }

  private async cancelPendingWhere(
    inputId: string,
    allowed: (task: ScheduledTaskRecord) => boolean,
  ): Promise<boolean> {
    return await this.mutate(async () => {
      const id = normalizeId(inputId);
      const task = this.state.scheduled_tasks[id];
      if (!task || task.status !== "pending" || !allowed(task)) return false;
      task.status = "cancelled";
      task.cancelled_at = this.now().toISOString();
      await this.save();
      return true;
    });
  }

  async markStartupMissed(): Promise<void> {
    await this.mutate(async () => {
      const nowMs = this.now().getTime();
      let changed = false;
      for (const task of Object.values(this.state.scheduled_tasks)) {
        if (task.status === "pending" && Date.parse(task.execute_at) < nowMs) {
          task.status = "missed";
          task.missed_at = this.now().toISOString();
          changed = true;
        }
        if (task.status === "triggering" && !this.claimedInThisSession.has(task.id)) {
          task.status = "failed";
          task.failed_at = this.now().toISOString();
          task.last_error = "process stopped while task was triggering";
          changed = true;
        }
      }
      if (changed) await this.save();
    });
  }

  async claimDueTasks(): Promise<ScheduledTaskRecord[]> {
    return await this.mutate(async () => {
      const nowMs = this.now().getTime();
      const due = this.listPendingAllChats().filter((task) => Date.parse(task.execute_at) <= nowMs);
      if (due.length === 0) return [];
      const at = this.now().toISOString();
      for (const task of due) {
        task.status = "triggering";
        task.triggered_at = at;
        this.claimedInThisSession.add(task.id);
      }
      try {
        await this.save();
      } catch (error) {
        // Roll back the claim: a task left "triggering" in memory drops out of
        // the pending list and would silently never fire until a daemon restart.
        // Restoring "pending" lets the next scheduler tick retry the claim.
        for (const task of due) {
          task.status = "pending";
          delete task.triggered_at;
          this.claimedInThisSession.delete(task.id);
        }
        throw error;
      }
      return due.map((task) => ({ ...task }));
    });
  }

  async markExecuted(id: string): Promise<void> {
    await this.mutate(async () => {
      const taskId = normalizeId(id);
      const task = this.state.scheduled_tasks[taskId];
      if (!task) return;
      task.status = "executed";
      task.executed_at = this.now().toISOString();
      // The lease is resolved; drop it so the in-session claim set stays bounded
      // by the number of currently in-flight tasks rather than growing forever.
      this.claimedInThisSession.delete(taskId);
      await this.save();
    });
  }

  async markFailed(id: string, error: unknown): Promise<void> {
    await this.mutate(async () => {
      const taskId = normalizeId(id);
      const task = this.state.scheduled_tasks[taskId];
      if (!task) return;
      task.status = "failed";
      task.failed_at = this.now().toISOString();
      task.last_error = error instanceof Error ? error.message : String(error);
      this.claimedInThisSession.delete(taskId);
      await this.save();
    });
  }

  private nextId(): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const id = sanitizeString(normalizeId(this.generateId()), {
        allow: /[0-9a-z]/,
        replacement: "",
      }).slice(0, 6);
      if (id.length >= 4 && !this.state.scheduled_tasks[id]) return id;
    }
    throw new Error("failed to generate unique scheduled task id");
  }

  private async mutate<T>(critical: () => Promise<T>): Promise<T> {
    return await this.stateMutex.run(critical);
  }

  private async save(): Promise<void> {
    await this.stateStore.save(this.state);
  }
}

export function normalizeId(input: string): string {
  return sanitizeString(input.trim(), {
    deny: /^#/,
    replacement: "",
    lowercase: true,
  });
}
