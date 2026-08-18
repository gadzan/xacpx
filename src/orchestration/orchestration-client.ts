import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

import {
  encodeOrchestrationRpcRequest,
  type OrchestrationIpcEndpoint,
  type OrchestrationRpcErrorCode,
  type OrchestrationRpcMethod,
  type OrchestrationRpcResponse,
} from "./orchestration-ipc";
import type {
  CancelTaskInput,
  CoordinatorRequestHumanInputResult,
  CoordinatorTaskQuestionRef,
  OrchestrationTaskFilter,
  RecordWorkerReplyInput,
  RegisterExternalCoordinatorInput,
  RequestDelegateRpcInput,
  RequestDelegateRpcResult,
  WatchTaskInput,
  WatchTaskResult,
  WorkerRaiseQuestionInput,
} from "./orchestration-service";
import type {
  ExternalCoordinatorRecord,
  OrchestrationGroupRecord,
  OrchestrationTaskRecord,
} from "./orchestration-types";
import type { ScheduledCreateFromRouteInput } from "../scheduled/scheduled-route-create";
import type {
  ScheduledCancelFromRouteInput,
  ScheduledListFromRouteInput,
} from "../scheduled/scheduled-route-manage";
import type { ScheduledTaskRecord } from "../scheduled/scheduled-types";
import {
  DEFAULT_TASK_WATCH_TIMEOUT_MS,
  MAX_TASK_WATCH_TIMEOUT_MS,
  TASK_WATCH_RPC_TIMEOUT_PADDING_MS,
} from "./task-watch-timeouts";
import type {
  AgentEndpointView,
  AgentMessageMode,
  AgentMessageReceipt,
  AgentSenderBinding,
} from "./agent-messaging-types";

export type CoordinatorTaskListFilter = Pick<OrchestrationTaskFilter, "status" | "stuck" | "sort" | "order"> & {
  coordinatorSession: string;
};

export interface AgentSendRpcInput extends AgentSenderBinding {
  to: string;
  message: string;
  mode?: AgentMessageMode;
  replyTo?: string;
}

interface OrchestrationClientDeps {
  createId?: () => string;
  timeoutMs?: number;
}

export class OrchestrationClientError extends Error {
  override readonly name = "OrchestrationClientError";

  constructor(
    readonly code: OrchestrationRpcErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class OrchestrationClient {
  private readonly createId: () => string;
  private readonly timeoutMs: number;

  constructor(
    private readonly endpoint: OrchestrationIpcEndpoint,
    deps: OrchestrationClientDeps = {},
  ) {
    this.createId = deps.createId ?? (() => randomUUID());
    this.timeoutMs = deps.timeoutMs ?? 30_000;
  }

  async registerExternalCoordinator(input: RegisterExternalCoordinatorInput): Promise<ExternalCoordinatorRecord> {
    return await this.request<ExternalCoordinatorRecord>("coordinator.register_external", input);
  }

  async delegateRequest(input: RequestDelegateRpcInput): Promise<RequestDelegateRpcResult> {
    return await this.request<RequestDelegateRpcResult>("delegate.request", input);
  }

  async getTaskForCoordinator(input: {
    coordinatorSession: string;
    taskId: string;
  }): Promise<OrchestrationTaskRecord | null> {
    return await this.request<OrchestrationTaskRecord | null>(
      "task.get",
      input,
    );
  }

  async listTasks(filter: CoordinatorTaskListFilter): Promise<OrchestrationTaskRecord[]> {
    return await this.request<OrchestrationTaskRecord[]>("task.list", { filter });
  }

  async watchTask(input: WatchTaskInput): Promise<WatchTaskResult> {
    return await this.request<WatchTaskResult>("task.watch", input, getWatchRequestTimeoutMs(input.timeoutMs, this.timeoutMs));
  }

  async approveTask(input: {
    coordinatorSession: string;
    taskId: string;
  }): Promise<OrchestrationTaskRecord> {
    return await this.request<OrchestrationTaskRecord>(
      "task.approve",
      input,
    );
  }

  async cancelTask(input: CancelTaskInput): Promise<OrchestrationTaskRecord> {
    return await this.request<OrchestrationTaskRecord>("task.cancel", input);
  }

  async cancelTaskForCoordinator(input: {
    coordinatorSession: string;
    taskId: string;
  }): Promise<OrchestrationTaskRecord> {
    return await this.request<OrchestrationTaskRecord>(
      "task.cancel",
      input,
    );
  }

  async workerReply(input: RecordWorkerReplyInput): Promise<{ accepted: true }> {
    return await this.request<{ accepted: true }>("worker.reply", input);
  }

  async workerRaiseQuestion(
    input: WorkerRaiseQuestionInput,
  ): Promise<{ taskId: string; questionId: string; status: "blocked" }> {
    return await this.request<{ taskId: string; questionId: string; status: "blocked" }>(
      "worker.raise_question",
      input,
    );
  }

  async coordinatorAnswerQuestion(input: {
    coordinatorSession: string;
    taskId: string;
    questionId: string;
    answer: string;
  }): Promise<OrchestrationTaskRecord> {
    return await this.request<OrchestrationTaskRecord>(
      "coordinator.answer_question",
      input,
    );
  }

  async coordinatorRetractAnswer(input: {
    coordinatorSession: string;
    taskId: string;
    questionId: string;
  }): Promise<OrchestrationTaskRecord> {
    return await this.request<OrchestrationTaskRecord>(
      "coordinator.retract_answer",
      input,
    );
  }

  async coordinatorRequestHumanInput(input: {
    coordinatorSession: string;
    taskQuestions: CoordinatorTaskQuestionRef[];
    promptText: string;
    expectedActivePackageId?: string;
  }): Promise<CoordinatorRequestHumanInputResult> {
    return await this.request<CoordinatorRequestHumanInputResult>(
      "coordinator.request_human_input",
      input,
    );
  }

  async coordinatorReviewContestedResult(input: {
    coordinatorSession: string;
    taskId: string;
    reviewId: string;
    decision: "accept" | "discard";
  }): Promise<OrchestrationTaskRecord> {
    return await this.request<OrchestrationTaskRecord>(
      "coordinator.review_contested_result",
      input,
    );
  }

  async createGroup(input: { coordinatorSession: string; title: string }): Promise<OrchestrationGroupRecord> {
    return await this.request<OrchestrationGroupRecord>("group.new", input);
  }

  async scheduledCreate(input: ScheduledCreateFromRouteInput): Promise<ScheduledTaskRecord> {
    return await this.request<ScheduledTaskRecord>("scheduled.create", input);
  }

  async scheduledList(input: ScheduledListFromRouteInput): Promise<ScheduledTaskRecord[]> {
    return await this.request<ScheduledTaskRecord[]>("scheduled.list", input);
  }

  async scheduledCancel(input: ScheduledCancelFromRouteInput): Promise<{ id: string; cancelled: boolean }> {
    return await this.request<{ id: string; cancelled: boolean }>("scheduled.cancel", input);
  }

  async agentList(input: AgentSenderBinding): Promise<AgentEndpointView[]> {
    return await this.request<AgentEndpointView[]>("agent.list", input);
  }

  async agentSend(input: AgentSendRpcInput): Promise<AgentMessageReceipt> {
    return await this.request<AgentMessageReceipt>("agent.send", input);
  }

  async request<Result>(method: OrchestrationRpcMethod, params: unknown, timeoutMs = this.timeoutMs): Promise<Result> {
    const id = this.createId();

    return await new Promise<Result>((resolve, reject) => {
      const socket = createConnection(this.endpoint.path);
      let buffer = "";
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const fail = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        socket.destroy();
        reject(error);
      };

      timer = setTimeout(() => {
        fail(new Error(`orchestration RPC timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);

      socket.setEncoding("utf8");
      socket.once("error", fail);
      socket.once("connect", () => {
        socket.write(
          encodeOrchestrationRpcRequest({
            id,
            method,
            params: params as Record<string, unknown>,
          }),
        );
      });
      socket.on("data", (chunk: string | Buffer) => {
        buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0 || settled) {
          return;
        }

        const line = buffer.slice(0, newlineIndex);
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        socket.end();

        try {
          const response = JSON.parse(line) as OrchestrationRpcResponse<Result>;
          if (response.id !== id) {
            reject(new Error(`orchestration response id mismatch: expected ${id}, received ${response.id}`));
            return;
          }
          if (!response.ok) {
            reject(new OrchestrationClientError(response.error.code, response.error.message));
            return;
          }
          resolve(response.result);
        } catch (error) {
          reject(error);
        }
      });
      socket.once("end", () => {
        if (!settled) {
          fail(new Error("orchestration server closed without a response"));
        }
      });
    });
  }
}

export function getWatchRequestTimeoutMs(watchTimeoutMs: number | undefined, defaultTimeoutMs: number): number {
  const requestedWatchTimeoutMs =
    watchTimeoutMs === undefined ? undefined : Number.isFinite(watchTimeoutMs) ? watchTimeoutMs : 0;
  const boundedWatchTimeoutMs = Math.min(
    Math.max(Math.floor(requestedWatchTimeoutMs ?? DEFAULT_TASK_WATCH_TIMEOUT_MS), 0),
    MAX_TASK_WATCH_TIMEOUT_MS,
  );
  return Math.max(defaultTimeoutMs, boundedWatchTimeoutMs + TASK_WATCH_RPC_TIMEOUT_PADDING_MS);
}
