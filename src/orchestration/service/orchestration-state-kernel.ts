// The bottom layer of the orchestration split: the single state mutex and the state-shape,
// event-append, and logging primitives that every service above needs. Holds no domain
// policy — only the operations that were shared by three or more responsibility clusters
// in the original 4539-line class.
import { AsyncLocalStorage } from "node:async_hooks";

import type { AppLogger } from "../../logging/app-logger";
import type { AppState } from "../../state/types";
import { AsyncMutex } from "../async-mutex";
import { sameCoordinatorSession, stableCoordinatorSession } from "../coordinator-identity";
import type {
  ExternalCoordinatorRecord,
  OrchestrationCoordinatorQuestionStateRecord,
  OrchestrationCoordinatorRouteContextRecord,
  OrchestrationGroupRecord,
  OrchestrationHumanQuestionPackageRecord,
  OrchestrationTaskEventType,
  OrchestrationTaskRecord,
  OrchestrationTaskStatus,
} from "../orchestration-types";

export const MAX_TASK_EVENTS_PER_TASK = 200;

export interface KernelDeps {
  logger?: AppLogger;
}

export class OrchestrationStateKernel {
  /** Token of the enclosing critical section, propagated through the async context. A per-call
   *  token (not a bare `true`) lets `mutate` tell a genuinely re-entrant caller — still inside
   *  the section that is running right now — apart from a chain that merely INHERITED a section's
   *  context but outlives it. A bare boolean also can't distinguish a concurrent queued caller,
   *  which is why this was never a plain field. */
  private readonly held = new AsyncLocalStorage<object>();
  /** Token of the critical section whose `critical()` body is executing at this instant, or
   *  undefined when none. The mutex serialises sections, so at most one is ever live. */
  private runningToken: object | undefined;
  private readonly stateMutex: AsyncMutex;

  constructor(
    private readonly deps: KernelDeps,
    stateMutex?: AsyncMutex,
  ) {
    this.stateMutex = stateMutex ?? new AsyncMutex();
  }

  /** AsyncMutex is strict-FIFO and non-reentrant: an AWAITED nested run() awaits a tail promise
   *  that only resolves after the outer section returns → deadlock. Throw for that case only.
   *  A detached chain that inherited a section's token but reaches mutate() AFTER that section
   *  has returned (`enclosing !== runningToken`) is not re-entrant — it queues on the now-free
   *  mutex and runs. */
  async mutate<T>(critical: () => Promise<T>): Promise<T> {
    const enclosing = this.held.getStore();
    if (enclosing !== undefined && enclosing === this.runningToken) {
      throw new Error(
        "orchestration: nested mutate() detected — this would deadlock the state mutex. " +
          "Call the collaborator outside the critical section.",
      );
    }
    const token = {};
    return await this.stateMutex.run(async () => {
      const previous = this.runningToken; // always undefined (mutex serialises); restored defensively
      this.runningToken = token;
      try {
        return await this.held.run(token, critical);
      } finally {
        this.runningToken = previous;
      }
    });
  }

  normalizeGroupId(groupId: string | undefined): string | undefined {
    const normalized = groupId?.trim();
    return normalized && normalized.length > 0 ? normalized : undefined;
  }

  isTerminalStatus(status: OrchestrationTaskStatus): boolean {
    return status === "completed" || status === "failed" || status === "cancelled";
  }

  assertGroupOwnership(
    group: OrchestrationGroupRecord | undefined,
    groupId: string,
    coordinatorSession: string,
  ): void {
    if (!group) {
      throw new Error(`group "${groupId}" does not exist`);
    }
    if (!sameCoordinatorSession(group.coordinatorSession, coordinatorSession)) {
      throw new Error(
        `group "${groupId}" belongs to coordinator "${group.coordinatorSession}", not "${coordinatorSession}"`,
      );
    }
  }

  ensureHumanQuestionPackages(state: AppState): Record<string, OrchestrationHumanQuestionPackageRecord> {
    if (!("humanQuestionPackages" in state.orchestration) || !state.orchestration.humanQuestionPackages) {
      (
        state.orchestration as AppState["orchestration"] & {
          humanQuestionPackages: Record<string, OrchestrationHumanQuestionPackageRecord>;
        }
      ).humanQuestionPackages = {};
    }
    return state.orchestration.humanQuestionPackages;
  }

  ensureCoordinatorQuestionState(
    state: AppState,
    coordinatorSession: string,
  ): OrchestrationCoordinatorQuestionStateRecord {
    // Key the question-state map by the stable identity so a coordinator that
    // delegated before `/clear` and asks/answers after it lands in the same slot.
    const key = stableCoordinatorSession(coordinatorSession);
    if (!("coordinatorQuestionState" in state.orchestration) || !state.orchestration.coordinatorQuestionState) {
      (
        state.orchestration as AppState["orchestration"] & {
          coordinatorQuestionState: Record<string, OrchestrationCoordinatorQuestionStateRecord>;
        }
      ).coordinatorQuestionState = {};
    }

    state.orchestration.coordinatorQuestionState[key] ??= {
      queuedQuestions: [],
    };

    return state.orchestration.coordinatorQuestionState[key]!;
  }

  ensureCoordinatorRoutes(state: AppState): Record<string, OrchestrationCoordinatorRouteContextRecord> {
    if (!("coordinatorRoutes" in state.orchestration) || !state.orchestration.coordinatorRoutes) {
      (
        state.orchestration as AppState["orchestration"] & {
          coordinatorRoutes: Record<string, OrchestrationCoordinatorRouteContextRecord>;
        }
      ).coordinatorRoutes = {};
    }
    return state.orchestration.coordinatorRoutes;
  }

  isExternalCoordinatorSession(state: AppState, coordinatorSession: string): boolean {
    return this.ensureExternalCoordinators(state)[coordinatorSession] !== undefined;
  }

  ensureExternalCoordinators(state: AppState): Record<string, ExternalCoordinatorRecord> {
    if (!("externalCoordinators" in state.orchestration) || !state.orchestration.externalCoordinators) {
      (
        state.orchestration as AppState["orchestration"] & {
          externalCoordinators: Record<string, ExternalCoordinatorRecord>;
        }
      ).externalCoordinators = {};
    }
    return state.orchestration.externalCoordinators;
  }

  ensureGroups(state: AppState): Record<string, OrchestrationGroupRecord> {
    if (!("groups" in state.orchestration) || !state.orchestration.groups) {
      (state.orchestration as AppState["orchestration"] & { groups: Record<string, OrchestrationGroupRecord> }).groups =
        {};
    }
    return state.orchestration.groups;
  }

  bumpGroupUpdated(state: AppState, groupId: string | undefined, now: string): void {
    if (!groupId) {
      return;
    }
    const group = this.ensureGroups(state)[groupId];
    if (group) {
      group.updatedAt = now;
    }
  }

  logEvent(event: string, message: string, context: Record<string, unknown>): void {
    const logger = this.deps.logger;
    if (!logger) return;
    const cleaned: Record<string, string | number | boolean | null | undefined> = {};
    for (const [key, value] of Object.entries(context)) {
      if (value === undefined) continue;
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        value === null
      ) {
        cleaned[key] = value;
      } else {
        cleaned[key] = String(value);
      }
    }
    void logger.info(event, message, cleaned);
  }

  taskContext(task: OrchestrationTaskRecord): Record<string, unknown> {
    const context: Record<string, unknown> = {
      task_id: task.taskId,
      coordinator_session: task.coordinatorSession,
      target_agent: task.targetAgent,
      status: task.status,
    };
    if (task.groupId !== undefined) {
      context.group_id = task.groupId;
    }
    if (task.workerSession !== undefined) {
      context.worker_session = task.workerSession;
    }
    return context;
  }

  groupContext(group: OrchestrationGroupRecord): Record<string, unknown> {
    return {
      group_id: group.groupId,
      coordinator_session: group.coordinatorSession,
      title: group.title,
    };
  }

  appendTaskEvent(
    task: OrchestrationTaskRecord,
    at: string,
    type: OrchestrationTaskEventType,
    details: {
      status?: OrchestrationTaskStatus;
      summary?: string;
      message?: string;
    } = {},
  ): void {
    const nextSeq = (task.eventSeq ?? 0) + 1;
    task.eventSeq = nextSeq;
    const events = task.events ?? [];
    events.push({
      seq: nextSeq,
      at,
      type,
      ...(details.status ? { status: details.status } : {}),
      ...(details.summary ? { summary: details.summary } : {}),
      ...(details.message ? { message: details.message } : {}),
    });
    task.events = events.slice(-MAX_TASK_EVENTS_PER_TASK);
  }
}
