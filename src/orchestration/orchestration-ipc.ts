import { createHash } from "node:crypto";
import { join } from "node:path";

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
import type { AgentMessagingErrorCode } from "./agent-messaging-error";

export type OrchestrationRpcMethod =
  | "agent.list"
  | "agent.send"
  | "coordinator.register_external"
  | "delegate.request"
  | "task.get"
  | "task.list"
  | "task.watch"
  | "task.approve"
  | "task.cancel"
  | "worker.reply"
  | "worker.raise_question"
  | "coordinator.answer_question"
  | "coordinator.retract_answer"
  | "coordinator.request_human_input"
  | "coordinator.review_contested_result"
  | "scheduled.create"
  | "scheduled.list"
  | "scheduled.cancel"
  | "group.new";

export interface OrchestrationIpcEndpoint {
  kind: "unix" | "named-pipe";
  path: string;
}

export interface OrchestrationRpcRequest {
  id: string;
  method: OrchestrationRpcMethod;
  params: Record<string, unknown>;
}

export interface OrchestrationRpcSuccessResponse<Result = unknown> {
  id: string;
  ok: true;
  result: Result;
}

export type OrchestrationRpcErrorCode =
  | "ORCHESTRATION_INVALID_REQUEST"
  | "ORCHESTRATION_INTERNAL_ERROR"
  | AgentMessagingErrorCode;

export interface OrchestrationRpcErrorResponse {
  id: string;
  ok: false;
  error: {
    code: OrchestrationRpcErrorCode;
    message: string;
  };
}

export type OrchestrationRpcResponse<Result = unknown> =
  | OrchestrationRpcSuccessResponse<Result>
  | OrchestrationRpcErrorResponse;

export interface OrchestrationRpcHandlers {
  registerExternalCoordinator: (input: RegisterExternalCoordinatorInput) => Promise<ExternalCoordinatorRecord>;
  requestDelegate: (input: RequestDelegateRpcInput) => Promise<RequestDelegateRpcResult>;
  getTask: (taskId: string) => Promise<OrchestrationTaskRecord | null>;
  listTasks: (filter?: OrchestrationTaskFilter) => Promise<OrchestrationTaskRecord[]>;
  watchTask: (input: WatchTaskInput) => Promise<WatchTaskResult>;
  approveTask: (input: { taskId: string; coordinatorSession: string }) => Promise<OrchestrationTaskRecord>;
  cancelTask: (input: CancelTaskInput) => Promise<OrchestrationTaskRecord>;
  recordWorkerReply: (input: RecordWorkerReplyInput) => Promise<OrchestrationTaskRecord>;
  workerRaiseQuestion: (
    input: WorkerRaiseQuestionInput,
  ) => Promise<{ taskId: string; questionId: string; status: "blocked" }>;
  coordinatorAnswerQuestion: (input: {
    coordinatorSession: string;
    taskId: string;
    questionId: string;
    answer: string;
  }) => Promise<OrchestrationTaskRecord>;
  coordinatorRetractAnswer: (input: {
    coordinatorSession: string;
    taskId: string;
    questionId: string;
  }) => Promise<OrchestrationTaskRecord>;
  coordinatorRequestHumanInput: (input: {
    coordinatorSession: string;
    taskQuestions: CoordinatorTaskQuestionRef[];
    promptText: string;
    expectedActivePackageId?: string;
  }) => Promise<CoordinatorRequestHumanInputResult>;
  coordinatorReviewContestedResult: (input: {
    coordinatorSession: string;
    taskId: string;
    reviewId: string;
    decision: "accept" | "discard";
  }) => Promise<OrchestrationTaskRecord>;
  createGroup: (input: { coordinatorSession: string; title: string }) => Promise<OrchestrationGroupRecord>;
  createScheduledTaskFromRoute?: (input: ScheduledCreateFromRouteInput) => Promise<ScheduledTaskRecord>;
  listScheduledTasksFromRoute?: (input: ScheduledListFromRouteInput) => Promise<ScheduledTaskRecord[]>;
  cancelScheduledTaskFromRoute?: (input: ScheduledCancelFromRouteInput) => Promise<{ id: string; cancelled: boolean }>;
}

export function resolveOrchestrationEndpoint(
  runtimeDir: string,
  platform: NodeJS.Platform = process.platform,
): OrchestrationIpcEndpoint {
  if (platform === "win32") {
    const suffix = createHash("sha256").update(runtimeDir).digest("hex").slice(0, 12);
    return {
      kind: "named-pipe",
      path: `\\\\.\\pipe\\xacpx-orchestration-${suffix}`,
    };
  }

  return {
    kind: "unix",
    path: join(runtimeDir, "orchestration.sock"),
  };
}

export function createOrchestrationEndpoint(
  path: string,
  platform: NodeJS.Platform = process.platform,
): OrchestrationIpcEndpoint {
  return {
    kind: platform === "win32" || path.startsWith("\\\\.\\pipe\\") ? "named-pipe" : "unix",
    path,
  };
}

export function encodeOrchestrationRpcRequest(request: OrchestrationRpcRequest): string {
  return `${JSON.stringify(request)}\n`;
}

export function encodeOrchestrationRpcResponse(response: OrchestrationRpcResponse): string {
  return `${JSON.stringify(response)}\n`;
}
