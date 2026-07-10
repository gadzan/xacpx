// src/orchestration/service/group-service.ts
// Group lifecycle: create groups, summarize them, list them, and cancel a whole group.
// One collaborator beyond the kernel: TaskCancellationService (one-way edge). Only
// `createGroup` opens `kernel.mutate`; `cancelGroup` opens none — it delegates each task
// cancellation to `requestTaskCancellation`, which opens its own. The kernel guard is
// non-reentrant, so wrapping `cancelGroup` in a mutate would throw on the first task.
import { sameCoordinatorSession } from "../coordinator-identity";
import type {
  OrchestrationGroupRecord,
  OrchestrationGroupSummary,
  OrchestrationTaskRecord,
} from "../orchestration-types";
import type {
  CancelGroupResult,
  OrchestrationGroupListFilter,
  OrchestrationServiceDeps,
} from "../orchestration-service";
import type { OrchestrationStateKernel } from "./orchestration-state-kernel";
import type { TaskCancellationService } from "./task-cancellation-service";

export type GroupDeps = Pick<
  OrchestrationServiceDeps,
  "now" | "createId" | "loadState" | "saveState" | "config"
>;

export class GroupService {
  constructor(
    private readonly deps: GroupDeps,
    private readonly kernel: OrchestrationStateKernel,
    private readonly cancellation: TaskCancellationService,
  ) {}

  async createGroup(input: {
    coordinatorSession: string;
    title: string;
  }): Promise<OrchestrationGroupRecord> {
    if (input.coordinatorSession.trim().length === 0) {
      throw new Error("coordinatorSession must be a non-empty string");
    }
    if (input.title.trim().length === 0) {
      throw new Error("title must be a non-empty string");
    }

    const group = await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const now = this.deps.now().toISOString();
      const groupId = this.deps.createId();
      const nextGroup: OrchestrationGroupRecord = {
        groupId,
        coordinatorSession: input.coordinatorSession,
        title: input.title.trim(),
        createdAt: now,
        updatedAt: now,
      };

      const groups = this.kernel.ensureGroups(state);
      groups[groupId] = nextGroup;
      await this.deps.saveState(state);

      return { ...nextGroup };
    });

    this.kernel.logEvent("orchestration.group.created", "group created", this.kernel.groupContext(group));

    return group;
  }

  async getGroupSummary(input: {
    groupId: string;
    coordinatorSession: string;
  }): Promise<OrchestrationGroupSummary | null> {
    const state = await this.deps.loadState();
    const group = this.kernel.ensureGroups(state)[input.groupId];
    if (!group || !sameCoordinatorSession(group.coordinatorSession, input.coordinatorSession)) {
      return null;
    }

    return this.buildGroupSummary(
      group,
      Object.values(state.orchestration.tasks).filter((task) => task.groupId === input.groupId),
    );
  }

  async listGroupSummaries(input: OrchestrationGroupListFilter): Promise<OrchestrationGroupSummary[]> {
    const state = await this.deps.loadState();
    const tasks = Object.values(state.orchestration.tasks);
    const threshold = this.deps.config.orchestration.progressHeartbeatSeconds;
    const now = this.deps.now().getTime();
    const sortField = input.sort ?? "updatedAt";
    const order = input.order ?? "desc";

    return Object.values(this.kernel.ensureGroups(state))
      .filter((group) => sameCoordinatorSession(group.coordinatorSession, input.coordinatorSession))
      .map((group) => ({
        group,
        summary: this.buildGroupSummary(group, tasks.filter((task) => task.groupId === group.groupId)),
      }))
      .filter(({ summary }) => {
        if (input.status === undefined) return true;
        if (input.status === "pending") return summary.pendingApprovalTasks > 0;
        if (input.status === "running") return summary.runningTasks > 0;
        return summary.terminal === true;
      })
      .filter(({ group }) => {
        if (input.stuck !== true) return true;
        if (group.injectionPending !== true) return false;
        const elapsed = (now - new Date(group.updatedAt).getTime()) / 1000;
        return elapsed >= threshold;
      })
      .sort((left, right) => {
        const leftValue = sortField === "createdAt" ? left.group.createdAt : left.group.updatedAt;
        const rightValue = sortField === "createdAt" ? right.group.createdAt : right.group.updatedAt;
        const compare = leftValue.localeCompare(rightValue);
        return order === "asc" ? compare : -compare;
      })
      .map(({ summary }) => summary);
  }

  async cancelGroup(input: {
    groupId: string;
    coordinatorSession: string;
  }): Promise<CancelGroupResult> {
    const summary = await this.getGroupSummary(input);
    if (!summary) {
      throw new Error(`group "${input.groupId}" does not exist`);
    }

    const cancelledTaskIds: string[] = [];
    const skippedTaskIds: string[] = [];

    for (const task of summary.tasks) {
      if (this.kernel.isTerminalStatus(task.status)) {
        skippedTaskIds.push(task.taskId);
        continue;
      }

      // Call the collaborator directly, never the facade's requestTaskCancellation
      // delegation. `requestTaskCancellation` fires a detached startWorkerCancellation
      // chain, and the `group.cancelled` log below is ordered against that chain's
      // saveState only by how many microtask hops separate them. The ordering is stable
      // by slack, not by a tick invariant: ONE extra hop anywhere in that resolution
      // chain reorders them and turns the `cancelGroup cancels its tasks` golden fixture
      // red — the frozen 185-test oracle stays green, so the fixture is the only witness.
      //
      // Going through the facade is one way to add that hop; an `await` added inside
      // `requestTaskCancellation` after the detached fire is another, and it flips the
      // same fixture without touching this file. Both were measured. So the constraint
      // is not "avoid facade indirection here" — it is that the whole chain from this
      // call site through `startWorkerCancellation` carries a hop budget of zero.
      // cancelGroup is the only one of the 30 fixtures that can see it.
      await this.cancellation.requestTaskCancellation({
        taskId: task.taskId,
        coordinatorSession: input.coordinatorSession,
      });
      cancelledTaskIds.push(task.taskId);
    }

    // Everything from here to the end runs synchronously against the detached chains
    // fired above. Adding an `await` — telemetry, an extra state read, anything — moves
    // the `group.cancelled` log past their saveState and flips the golden fixture.
    const refreshed = await this.getGroupSummary(input);
    if (!refreshed) {
      throw new Error(`group "${input.groupId}" does not exist`);
    }

    this.kernel.logEvent("orchestration.group.cancelled", "group cancelled", {
      ...this.kernel.groupContext(refreshed.group),
      cancelled_count: cancelledTaskIds.length,
      skipped_count: skippedTaskIds.length,
    });

    return {
      summary: refreshed,
      cancelledTaskIds,
      skippedTaskIds,
    };
  }

  private buildGroupSummary(
    group: OrchestrationGroupRecord,
    tasks: OrchestrationTaskRecord[],
  ): OrchestrationGroupSummary {
    const sortedTasks = tasks
      .slice()
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((task) => ({ ...task }));

    const pendingApprovalTasks = sortedTasks.filter(
      (task) => task.status === "needs_confirmation",
    ).length;
    const runningTasks = sortedTasks.filter((task) => task.status === "running").length;
    const completedTasks = sortedTasks.filter((task) => task.status === "completed").length;
    const failedTasks = sortedTasks.filter((task) => task.status === "failed").length;
    const cancelledTasks = sortedTasks.filter((task) => task.status === "cancelled").length;

    return {
      group: { ...group },
      tasks: sortedTasks,
      totalTasks: sortedTasks.length,
      pendingApprovalTasks,
      runningTasks,
      completedTasks,
      failedTasks,
      cancelledTasks,
      terminal:
        sortedTasks.length > 0 &&
        sortedTasks.every((task) => task.reviewPending === undefined) &&
        sortedTasks.every((task) => this.kernel.isTerminalStatus(task.status)),
    };
  }
}
