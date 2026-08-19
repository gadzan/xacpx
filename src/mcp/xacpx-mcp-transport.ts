import { OrchestrationClient } from "../orchestration/orchestration-client";
import type { OrchestrationIpcEndpoint } from "../orchestration/orchestration-ipc";
import type { ScheduledCreateFromRouteInput } from "../scheduled/scheduled-route-create";
import type {
  ScheduledCancelFromRouteInput,
  ScheduledListFromRouteInput,
} from "../scheduled/scheduled-route-manage";
import type { ScheduledTaskRecord } from "../scheduled/scheduled-types";
import type {
  CoordinatorRequestHumanInputResult,
  CoordinatorTaskQuestionRef,
  OrchestrationTaskFilter,
  RequestDelegateRpcResult,
  WatchTaskResult,
} from "../orchestration/orchestration-service";
import type {
  OrchestrationGroupRecord,
  OrchestrationTaskRecord,
} from "../orchestration/orchestration-types";
import type {
  AgentEndpointView,
  AgentMessageMode,
  AgentMessageReceipt,
  AgentTargetSelector,
} from "../orchestration/agent-messaging-types";
export interface XacpxMcpDelegateRequest {
  coordinatorSession: string;
  sourceHandle?: string;
  targetAgent: string;
  task: string;
  workingDirectory?: string;
  role?: string;
  groupId?: string;
  parallel?: boolean;
}

export interface XacpxMcpTaskWatchArgs {
  coordinatorSession: string;
  taskId: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  afterSeq?: number;
  mode?: "next_event" | "until_attention_or_terminal";
  includeProgress?: boolean;
}

export interface XacpxMcpTaskIdArgs {
  coordinatorSession: string;
  taskId: string;
}

export interface XacpxMcpTaskListArgs extends Pick<
  OrchestrationTaskFilter,
  "status" | "stuck" | "sort" | "order"
> {
  coordinatorSession: string;
}

export interface XacpxMcpGroupNewArgs {
  coordinatorSession: string;
  title: string;
}

export interface XacpxMcpTaskQuestionRef extends CoordinatorTaskQuestionRef {}

export interface XacpxMcpWorkerRaiseQuestionArgs {
  sourceHandle: string;
  taskId: string;
  question: string;
  whyBlocked: string;
  whatIsNeeded: string;
}

export interface XacpxMcpCoordinatorAnswerQuestionArgs {
  coordinatorSession: string;
  taskId: string;
  questionId: string;
  answer: string;
}

export interface XacpxMcpCoordinatorRequestHumanInputArgs {
  coordinatorSession: string;
  taskQuestions: XacpxMcpTaskQuestionRef[];
  promptText: string;
  expectedActivePackageId?: string;
}

export interface XacpxMcpCoordinatorReviewContestedResultArgs {
  coordinatorSession: string;
  taskId: string;
  reviewId: string;
  decision: "accept" | "discard";
}

export interface XacpxMcpScheduledCreateArgs extends ScheduledCreateFromRouteInput {}
export interface XacpxMcpScheduledListArgs extends ScheduledListFromRouteInput {}
export interface XacpxMcpScheduledCancelArgs extends ScheduledCancelFromRouteInput {}

export interface XacpxMcpAgentListArgs {
  coordinatorSession: string;
  sourceHandle?: string;
}

export interface XacpxMcpAgentSendArgs extends XacpxMcpAgentListArgs {
  to?: string;
  selector?: AgentTargetSelector;
  message: string;
  mode?: AgentMessageMode;
  replyTo?: string;
}
export interface XacpxMcpTransport {
  delegateRequest: (input: XacpxMcpDelegateRequest) => Promise<RequestDelegateRpcResult>;
  createGroup: (input: XacpxMcpGroupNewArgs) => Promise<OrchestrationGroupRecord>;
  getTask: (input: XacpxMcpTaskIdArgs) => Promise<OrchestrationTaskRecord | null>;
  listTasks: (input: XacpxMcpTaskListArgs) => Promise<OrchestrationTaskRecord[]>;
  approveTask: (input: XacpxMcpTaskIdArgs) => Promise<OrchestrationTaskRecord>;
  cancelTask: (input: XacpxMcpTaskIdArgs) => Promise<OrchestrationTaskRecord>;
  watchTask: (input: XacpxMcpTaskWatchArgs) => Promise<WatchTaskResult>;
  workerRaiseQuestion: (
    input: XacpxMcpWorkerRaiseQuestionArgs,
  ) => Promise<{ taskId: string; questionId: string; status: "blocked" }>;
  coordinatorAnswerQuestion: (
    input: XacpxMcpCoordinatorAnswerQuestionArgs,
  ) => Promise<OrchestrationTaskRecord>;
  coordinatorRequestHumanInput: (
    input: XacpxMcpCoordinatorRequestHumanInputArgs,
  ) => Promise<CoordinatorRequestHumanInputResult>;
  coordinatorReviewContestedResult: (
    input: XacpxMcpCoordinatorReviewContestedResultArgs,
  ) => Promise<OrchestrationTaskRecord>;
  scheduledCreate: (input: XacpxMcpScheduledCreateArgs) => Promise<ScheduledTaskRecord>;
  scheduledList: (input: XacpxMcpScheduledListArgs) => Promise<ScheduledTaskRecord[]>;
  scheduledCancel: (input: XacpxMcpScheduledCancelArgs) => Promise<{ id: string; cancelled: boolean }>;
  listAgentEndpoints: (input: XacpxMcpAgentListArgs) => Promise<AgentEndpointView[]>;
  sendAgentMessage: (input: XacpxMcpAgentSendArgs) => Promise<AgentMessageReceipt>;
}

interface OrchestrationClientLike {
  registerExternalCoordinator?: OrchestrationClient["registerExternalCoordinator"];
  delegateRequest: OrchestrationClient["delegateRequest"];
  createGroup: OrchestrationClient["createGroup"];
  getTaskForCoordinator: OrchestrationClient["getTaskForCoordinator"];
  listTasks: OrchestrationClient["listTasks"];
  approveTask: OrchestrationClient["approveTask"];
  cancelTaskForCoordinator: OrchestrationClient["cancelTaskForCoordinator"];
  watchTask: OrchestrationClient["watchTask"];
  workerRaiseQuestion: OrchestrationClient["workerRaiseQuestion"];
  coordinatorAnswerQuestion: OrchestrationClient["coordinatorAnswerQuestion"];
  coordinatorRequestHumanInput: OrchestrationClient["coordinatorRequestHumanInput"];
  coordinatorReviewContestedResult: OrchestrationClient["coordinatorReviewContestedResult"];
  scheduledCreate?: OrchestrationClient["scheduledCreate"];
  scheduledList?: OrchestrationClient["scheduledList"];
  scheduledCancel?: OrchestrationClient["scheduledCancel"];
  agentList?: OrchestrationClient["agentList"];
  agentSend?: OrchestrationClient["agentSend"];
}

export function createOrchestrationTransport(
  endpoint: OrchestrationIpcEndpoint,
  deps: { client?: OrchestrationClientLike } = {},
): XacpxMcpTransport {
  const client = deps.client ?? new OrchestrationClient(endpoint);

  return {
    delegateRequest: async (input) =>
      // For coordinator-side tool calls, coordinatorSession is the actual
      // source identity. The CLI may also pass an explicit sourceHandle, but
      // falling back to coordinatorSession keeps the transport contract aligned
      // with the orchestration server's coordinator identity model.
      await client.delegateRequest({
        sourceHandle: input.sourceHandle ?? input.coordinatorSession,
        targetAgent: input.targetAgent,
        task: input.task,
        ...(input.workingDirectory !== undefined ? { cwd: input.workingDirectory } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
        ...(input.parallel !== undefined ? { parallel: input.parallel } : {}),
      }),
    createGroup: async (input) => await client.createGroup(input),
    getTask: async (input) => await client.getTaskForCoordinator(input),
    listTasks: async (input) =>
      await client.listTasks({
        coordinatorSession: input.coordinatorSession,
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.stuck !== undefined ? { stuck: input.stuck } : {}),
        ...(input.sort !== undefined ? { sort: input.sort } : {}),
        ...(input.order !== undefined ? { order: input.order } : {}),
      }),
    approveTask: async (input) => await client.approveTask(input),
    cancelTask: async (input) => await client.cancelTaskForCoordinator(input),
    watchTask: async (input) => await client.watchTask(input),
    workerRaiseQuestion: async (input) => {
      const sourceHandle = input.sourceHandle.trim();
      if (sourceHandle.length === 0) {
        throw new Error(
          "worker_raise_question requires a bound sourceHandle; start mcp-stdio with --source-handle or XACPX_SOURCE_HANDLE",
        );
      }
      return await client.workerRaiseQuestion({
        taskId: input.taskId,
        sourceHandle,
        question: input.question,
        whyBlocked: input.whyBlocked,
        whatIsNeeded: input.whatIsNeeded,
      });
    },
    coordinatorAnswerQuestion: async (input) => await client.coordinatorAnswerQuestion(input),
    coordinatorRequestHumanInput: async (input) => await client.coordinatorRequestHumanInput(input),
    coordinatorReviewContestedResult: async (input) => await client.coordinatorReviewContestedResult(input),
    scheduledCreate: async (input) => {
      if (!client.scheduledCreate) {
        throw new Error("orchestration client scheduledCreate is not configured");
      }
      return await client.scheduledCreate(input);
    },
    scheduledList: async (input) => {
      if (!client.scheduledList) {
        throw new Error("orchestration client scheduledList is not configured");
      }
      return await client.scheduledList(input);
    },
    scheduledCancel: async (input) => {
      if (!client.scheduledCancel) {
        throw new Error("orchestration client scheduledCancel is not configured");
      }
      return await client.scheduledCancel(input);
    },
    listAgentEndpoints: async (input) => {
      if (!client.agentList) {
        throw new Error("orchestration client agentList is not configured");
      }
      return await client.agentList(input);
    },
    sendAgentMessage: async (input) => {
      if (!client.agentSend) {
        throw new Error("orchestration client agentSend is not configured");
      }
      return await client.agentSend(input);
    },
  };
}

export function createMemoryTransport(
  delegateRequest: XacpxMcpTransport["delegateRequest"],
  overrides: Partial<Omit<XacpxMcpTransport, "delegateRequest">> = {},
): XacpxMcpTransport {
  const unimplemented = (name: string) => async () => {
    throw new Error(`memory transport ${name} is not implemented`);
  };

  return {
    delegateRequest: async (input) => await delegateRequest(input),
    createGroup: overrides.createGroup ?? (unimplemented("createGroup") as XacpxMcpTransport["createGroup"]),
    getTask: overrides.getTask ?? (unimplemented("getTask") as XacpxMcpTransport["getTask"]),
    listTasks: overrides.listTasks ?? (unimplemented("listTasks") as XacpxMcpTransport["listTasks"]),
    approveTask: overrides.approveTask ?? (unimplemented("approveTask") as XacpxMcpTransport["approveTask"]),
    cancelTask: overrides.cancelTask ?? (unimplemented("cancelTask") as XacpxMcpTransport["cancelTask"]),
    watchTask: overrides.watchTask ?? (unimplemented("watchTask") as XacpxMcpTransport["watchTask"]),
    workerRaiseQuestion:
      overrides.workerRaiseQuestion ?? (unimplemented("workerRaiseQuestion") as XacpxMcpTransport["workerRaiseQuestion"]),
    coordinatorAnswerQuestion:
      overrides.coordinatorAnswerQuestion
      ?? (unimplemented("coordinatorAnswerQuestion") as XacpxMcpTransport["coordinatorAnswerQuestion"]),
    coordinatorRequestHumanInput:
      overrides.coordinatorRequestHumanInput
      ?? (unimplemented("coordinatorRequestHumanInput") as XacpxMcpTransport["coordinatorRequestHumanInput"]),
    coordinatorReviewContestedResult:
      overrides.coordinatorReviewContestedResult
      ?? (unimplemented("coordinatorReviewContestedResult") as XacpxMcpTransport["coordinatorReviewContestedResult"]),
    scheduledCreate:
      overrides.scheduledCreate ?? (unimplemented("scheduledCreate") as XacpxMcpTransport["scheduledCreate"]),
    scheduledList:
      overrides.scheduledList ?? (unimplemented("scheduledList") as XacpxMcpTransport["scheduledList"]),
    scheduledCancel:
      overrides.scheduledCancel ?? (unimplemented("scheduledCancel") as XacpxMcpTransport["scheduledCancel"]),
    listAgentEndpoints:
      overrides.listAgentEndpoints
      ?? (unimplemented("listAgentEndpoints") as XacpxMcpTransport["listAgentEndpoints"]),
    sendAgentMessage:
      overrides.sendAgentMessage
      ?? (unimplemented("sendAgentMessage") as XacpxMcpTransport["sendAgentMessage"]),
  };
}
