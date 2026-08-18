// src/orchestration/service/worker-session-manager.ts
// Worker-session naming, resolution, reservation and conflict assertions, plus the
// parallel-slot gate. Owns the three pending-* maps: they are the TOCTOU close for the
// window between the capacity-gate mutate and the persist mutate, so they must live in
// exactly one instance. The facade constructs one and injects it everywhere.
import { createHash } from "node:crypto";
import { basename, isAbsolute, normalize } from "node:path";

import type { AppState } from "../../state/types";
import { sanitizeString } from "../../util/sanitize.js";
import type {
  EnsureWorkerSessionRequest,
  OrchestrationServiceDeps,
  RequestDelegateInput,
} from "../orchestration-service";
import type { OrchestrationStateKernel } from "./orchestration-state-kernel";

export type WorkerSessionDeps = Pick<
  OrchestrationServiceDeps,
  | "now"
  | "createId"
  | "createAgentEndpointId"
  | "loadState"
  | "saveState"
  | "config"
  | "ensureWorkerSession"
  | "dispatchWorkerTask"
  | "closeWorkerSession"
  | "findReusableWorkerSession"
>;

export class WorkerSessionManager {
  private readonly pendingWorkerSessions = new Map<string, number>();
  private readonly pendingLogicalTransportSessions = new Map<string, number>();
  /**
   * Per-agent counter for parallel tasks that have passed the capacity gate
   * but have not yet been persisted as `running` in state (i.e., they are
   * between the gate mutate and the inner persist mutate). This closes the
   * TOCTOU window: a concurrent `reconcileParallelSlots` Phase 3 or a second
   * delegation can see these in-flight starts as occupied slots.
   */
  private readonly pendingParallelStarts = new Map<string, number>();

  constructor(
    private readonly deps: WorkerSessionDeps,
    private readonly kernel: OrchestrationStateKernel,
  ) {}

  /** Reads pendingWorkerSessions. Callers hold the state mutex. */
  hasPendingWorkerSession(session: string): boolean {
    return (this.pendingWorkerSessions.get(session) ?? 0) > 0;
  }

  /** Reads pendingLogicalTransportSessions. Callers hold the state mutex. */
  hasPendingLogicalTransportSession(session: string): boolean {
    return (this.pendingLogicalTransportSessions.get(session) ?? 0) > 0;
  }

  /** Increments pendingParallelStarts. Callers hold the state mutex. */
  claimParallelStart(targetAgent: string): void {
    this.pendingParallelStarts.set(
      targetAgent,
      (this.pendingParallelStarts.get(targetAgent) ?? 0) + 1,
    );
  }

  /** Decrements pendingParallelStarts; deletes the key at zero. Callers do NOT hold the mutex. */
  releaseParallelStart(targetAgent: string): void {
    const count = this.pendingParallelStarts.get(targetAgent) ?? 0;
    if (count <= 1) {
      this.pendingParallelStarts.delete(targetAgent);
    } else {
      this.pendingParallelStarts.set(targetAgent, count - 1);
    }
  }

  /**
   * Resolves the transport worker-session name for a delegation.
   *
   * For parallel delegations a fresh unique name is minted by appending a
   * `:p-<id>` suffix. That suffix is purely a naming convention for
   * human/log readability — it MUST NOT be treated as the source of truth
   * for ephemerality. `WorkerBindingRecord.ephemeral` is the authoritative
   * marker for whether a session is an ephemeral parallel slot; no code
   * should detect ephemerality by string-matching the session name.
   */
  async resolveWorkerSession(input: RequestDelegateInput): Promise<string> {
    const role = this.normalizeRole(input.role);

    const baseName = [input.workspace, input.cwd ? this.cwdWorkerSessionPart(input.cwd) : undefined, input.targetAgent, role, input.coordinatorSession]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
      .map((part) => part.trim())
      .join(":");

    if (input.parallel) {
      // Ephemeral parallel slot: never reuse, always a fresh unique session.
      // The `:p-` suffix is a readability convention only; see method doc.
      return `${baseName}:p-${this.deps.createId()}`;
    }

    const reusable = await this.deps.findReusableWorkerSession?.({
      sourceHandle: input.sourceHandle,
      sourceKind: input.sourceKind,
      coordinatorSession: input.coordinatorSession,
      workspace: input.workspace,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      targetAgent: input.targetAgent,
      role,
    });

    if (reusable && reusable.trim().length > 0) {
      return reusable.trim();
    }

    return baseName;
  }

  async reserveProposedWorkerSession(workerSession: string, excludingTaskId?: string): Promise<() => Promise<void>> {
    await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      this.assertWorkerSessionDoesNotConflictExternalCoordinator(state, workerSession);
      this.assertWorkerSessionAvailable(state, workerSession, excludingTaskId);
      this.pendingWorkerSessions.set(workerSession, (this.pendingWorkerSessions.get(workerSession) ?? 0) + 1);
    });

    let released = false;
    return async () => {
      if (released) {
        return;
      }
      released = true;
      await this.kernel.mutate(async () => {
        const count = this.pendingWorkerSessions.get(workerSession) ?? 0;
        if (count <= 1) {
          this.pendingWorkerSessions.delete(workerSession);
        } else {
          this.pendingWorkerSessions.set(workerSession, count - 1);
        }
      });
    };
  }

  async ensureReservedWorkerSession(request: EnsureWorkerSessionRequest): Promise<string> {
    const ensuredWorkerSession = await this.deps.ensureWorkerSession(request);
    if (ensuredWorkerSession !== request.workerSession) {
      throw new Error(
        `ensureWorkerSession returned "${ensuredWorkerSession}", expected "${request.workerSession}"`,
      );
    }
    return ensuredWorkerSession;
  }

  async reserveLogicalTransportSession(transportSession: string): Promise<() => Promise<void>> {
    await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      if (this.kernel.isExternalCoordinatorSession(state, transportSession)) {
        throw new Error(`transport session "${transportSession}" conflicts with an external coordinator`);
      }
      this.pendingLogicalTransportSessions.set(
        transportSession,
        (this.pendingLogicalTransportSessions.get(transportSession) ?? 0) + 1,
      );
    });

    let released = false;
    return async () => {
      if (released) {
        return;
      }
      released = true;
      await this.kernel.mutate(async () => {
        const count = this.pendingLogicalTransportSessions.get(transportSession) ?? 0;
        if (count <= 1) {
          this.pendingLogicalTransportSessions.delete(transportSession);
        } else {
          this.pendingLogicalTransportSessions.set(transportSession, count - 1);
        }
      });
    };
  }

  normalizeWorkingDirectory(cwd: string): string {
    const normalized = normalize(cwd.trim());
    if (normalized.length === 0 || normalized === ".") {
      throw new Error("workingDirectory must be a non-empty absolute path");
    }
    if (!isAbsolute(normalized)) {
      throw new Error("workingDirectory must be an absolute path");
    }
    return normalized;
  }

  workspaceLabelFromCwd(cwd: string): string {
    const base = basename(cwd).trim() || "cwd";
    return sanitizeString(base, {
      allow: /[a-zA-Z0-9._-]/,
      replacement: "_",
      fallback: "cwd",
    });
  }

  cwdWorkerSessionPart(cwd: string): string {
    const label = this.workspaceLabelFromCwd(cwd);
    const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
    return `${label}-${hash}`;
  }

  normalizeRole(role: string | undefined): string | undefined {
    const normalized = role?.trim();
    return normalized && normalized.length > 0 ? normalized : undefined;
  }

  assertWorkerSessionDoesNotConflictExternalCoordinator(state: AppState, workerSession: string): void {
    if (this.kernel.isExternalCoordinatorSession(state, workerSession)) {
      throw new Error(`worker session "${workerSession}" conflicts with an external coordinator`);
    }
  }

  assertWorkerSessionAvailable(
    state: AppState,
    workerSession: string,
    excludingTaskId?: string,
    options: { allowCurrentReservation?: boolean } = {},
  ): void {
    const pendingCount = this.pendingWorkerSessions.get(workerSession) ?? 0;
    const allowedPendingCount = options.allowCurrentReservation ? 1 : 0;
    if (pendingCount > allowedPendingCount) {
      throw new Error(`worker session "${workerSession}" is already in use`);
    }
    if (this.hasActiveTaskWorkerSession(state, workerSession, excludingTaskId)) {
      throw new Error(`worker session "${workerSession}" is already in use`);
    }
  }

  hasActiveTaskWorkerSession(state: AppState, workerSession: string, excludingTaskId?: string): boolean {
    return Object.values(state.orchestration.tasks).some(
      (task) =>
        task.taskId !== excludingTaskId &&
        task.workerSession === workerSession &&
        (!this.kernel.isTerminalStatus(task.status) || task.reviewPending !== undefined),
    );
  }

  /** Count parallel-slot tasks currently holding an acpx session for an agent. */
  countActiveParallelSlots(state: AppState, targetAgent: string): number {
    const persisted = Object.values(state.orchestration.tasks).filter(
      (task) =>
        task.ephemeralWorkerSession === true &&
        task.targetAgent === targetAgent &&
        // Only these three statuses hold a live acpx session. `needs_confirmation`
        // and `queued` parallel tasks hold no session yet — and counting `queued`
        // here would deadlock queue draining (a queued task would count against the
        // very cap that gates its own start). Terminal tasks have released theirs.
        // Do NOT simplify this to `!isTerminalStatus(...)`.
        (task.status === "running" ||
          task.status === "blocked" ||
          task.status === "waiting_for_human"),
    ).length;
    // Include tasks that have passed the capacity gate but are not yet persisted
    // as `running` (between gate-mutate and inner-persist-mutate). This closes
    // the TOCTOU window where a concurrent delegation could see stale state.
    const pending = this.pendingParallelStarts.get(targetAgent) ?? 0;
    return persisted + pending;
  }

  /**
   * Whether a new parallel task for this agent may start now, or must be queued.
   * The cap comes from the `orchestration.maxParallelTasksPerAgent` config key.
   */
  canStartParallelTask(state: AppState, targetAgent: string): boolean {
    const cap = this.deps.config.orchestration.maxParallelTasksPerAgent;
    return this.countActiveParallelSlots(state, targetAgent) < cap;
  }

  /**
   * Idempotent reconciliation for parallel slots:
   *  1. close acpx sessions of ephemeral parallel tasks that have terminated
   *     (terminal status, no pending review), and drop their worker bindings;
   *  2. drain `queued` parallel tasks into running, up to the per-agent cap.
   * Safe to call repeatedly; close failures are logged and never block draining.
   */
  async reconcileParallelSlots(): Promise<void> {
    // Phase 1: collect + mark sessions to close (mutex-guarded state change).
    const toClose = await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const collected: Array<{
        workerSession: string;
        coordinatorSession: string;
        workspace: string;
        cwd?: string;
        targetAgent: string;
        role?: string;
        guardAcpOutput?: boolean;
      }> = [];
      for (const task of Object.values(state.orchestration.tasks)) {
        if (
          task.ephemeralWorkerSession === true &&
          task.ephemeralWorkerSessionClosed !== true &&
          task.workerSession &&
          task.reviewPending === undefined &&
          this.kernel.isTerminalStatus(task.status)
        ) {
          // I-3: Only close (and delete the binding for) sessions that were actually
          // started — i.e., the worker binding exists in state. Queued tasks that were
          // cancelled before being drained never had an acpx session opened, so their
          // workerSession is an intended-but-never-reserved name with no binding entry.
          // Calling closeWorkerSession on those is wasted I/O and produces a misleading
          // log. Mark them closed anyway so Phase 1 does not re-check them on future
          // reconcile calls.
          task.ephemeralWorkerSessionClosed = true;
          const binding = state.orchestration.workerBindings[task.workerSession];
          if (binding !== undefined) {
            delete state.orchestration.workerBindings[task.workerSession];
            collected.push({
              workerSession: task.workerSession,
              coordinatorSession: task.coordinatorSession,
              workspace: task.workspace,
              ...(task.cwd ? { cwd: task.cwd } : {}),
              targetAgent: task.targetAgent,
              ...(task.role ? { role: task.role } : {}),
              guardAcpOutput: binding.guardAcpOutput,
            });
          }
        }
      }
      if (collected.length > 0) {
        await this.deps.saveState(state);
      }
      return collected;
    });

    // Phase 2: best-effort close (outside the mutex — it is network/process I/O).
    for (const req of toClose) {
      try {
        await this.deps.closeWorkerSession?.(req);
      } catch (error) {
        this.kernel.logEvent("orchestration.parallel.close_failed", "failed to close ephemeral worker session", {
          workerSession: req.workerSession,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Phase 3: drain queued parallel tasks, oldest first, up to capacity.
    for (;;) {
      const next = await this.kernel.mutate(async () => {
        const state = await this.deps.loadState();
        const queued = Object.values(state.orchestration.tasks)
          .filter((t) => t.status === "queued" && t.ephemeralWorkerSession === true)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        for (const task of queued) {
          if (!this.canStartParallelTask(state, task.targetAgent)) {
            continue; // this agent is full — try other agents' queued tasks
          }
          task.status = "running";
          task.updatedAt = this.deps.now().toISOString();
          // No reserveProposedWorkerSession here (unlike the normal delegate
          // paths): an ephemeral parallel session name is a globally-unique
          // `:p-<uuid>`, so there is no pre-existing claim or external-coordinator
          // collision to guard against.
          state.orchestration.workerBindings[task.workerSession!] = {
            sourceHandle: task.workerSession!,
            ...(this.deps.createAgentEndpointId
              ? { agentEndpointId: "endpoint_" + this.deps.createAgentEndpointId() }
              : {}),
            coordinatorSession: task.coordinatorSession,
            workspace: task.workspace,
            ...(task.cwd ? { cwd: task.cwd } : {}),
            targetAgent: task.targetAgent,
            ...(task.role ? { role: task.role } : {}),
            ephemeral: true,
            guardAcpOutput: true,
          };
          await this.deps.saveState(state);
          return { ...task };
        }
        return null;
      });
      if (!next) {
        break;
      }
      try {
        await this.ensureReservedWorkerSession({
          workerSession: next.workerSession!,
          sourceHandle: next.sourceHandle,
          sourceKind: next.sourceKind,
          coordinatorSession: next.coordinatorSession,
          workspace: next.workspace,
          ...(next.cwd ? { cwd: next.cwd } : {}),
          targetAgent: next.targetAgent,
          ...(next.role ? { role: next.role } : {}),
        });
        await this.deps.dispatchWorkerTask({
          taskId: next.taskId,
          workerSession: next.workerSession!,
          coordinatorSession: next.coordinatorSession,
          workspace: next.workspace,
          ...(next.cwd ? { cwd: next.cwd } : {}),
          targetAgent: next.targetAgent,
          ...(next.role ? { role: next.role } : {}),
          task: next.task,
        });
      } catch (error) {
        // Rollback: ensure/dispatch failed after the task was flipped to
        // `running` and persisted. Revert it to `queued` and drop its binding so
        // it does not permanently consume a slot with no worker. Break (do NOT
        // continue) — a re-queued task would be re-picked and loop forever within
        // this single reconcile call; the next reconcile trigger retries it.
        await this.kernel.mutate(async () => {
          const state = await this.deps.loadState();
          const task = state.orchestration.tasks[next.taskId];
          if (task && task.status === "running") {
            task.status = "queued";
            task.updatedAt = this.deps.now().toISOString();
            delete state.orchestration.workerBindings[next.workerSession!];
            // Audit-trail parity with the success path: record the running→queued
            // revert as a status_changed event, persisted in this same mutate.
            this.kernel.appendTaskEvent(task, task.updatedAt, "status_changed", {
              status: "queued",
              message: "Task re-queued after drain failure",
            });
            await this.deps.saveState(state);
          }
        });
        this.kernel.logEvent("orchestration.parallel.drain_failed", "failed to drain queued parallel task", {
          taskId: next.taskId,
          workerSession: next.workerSession,
          message: error instanceof Error ? error.message : String(error),
        });
        break;
      }
      // Dispatch succeeded — persist the queued→running status_changed event
      // (mirrors approveTask's queued/needs_confirmation→running transition).
      await this.kernel.mutate(async () => {
        const state = await this.deps.loadState();
        const task = state.orchestration.tasks[next.taskId];
        if (task && task.status === "running") {
          this.kernel.appendTaskEvent(task, task.updatedAt, "status_changed", {
            status: "running",
            message: "Task drained from parallel queue",
          });
          await this.deps.saveState(state);
        }
      });
      this.kernel.logEvent("orchestration.task.drained", "parallel task drained from queue", {
        taskId: next.taskId,
        targetAgent: next.targetAgent,
      });
    }
  }
}
