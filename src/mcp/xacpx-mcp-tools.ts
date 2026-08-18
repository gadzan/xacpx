import type { CallToolResult, ToolExecution } from "@modelcontextprotocol/sdk/types.js";
import type { XacpxMcpTransport } from "./xacpx-mcp-transport";
import {
  DEFAULT_TASK_WATCH_POLL_INTERVAL_MS,
  DEFAULT_TASK_WATCH_TIMEOUT_MS,
  MAX_TASK_WATCH_POLL_INTERVAL_MS,
  MAX_TASK_WATCH_TIMEOUT_MS,
} from "../orchestration/task-watch-timeouts";
import { isQuotaDeferredError } from "../weixin/messaging/quota-errors";
import type { AgentMessagingErrorCode } from "../orchestration/agent-messaging-error";
import { z } from "zod";

const taskStatusSchema = z.enum([
  "needs_confirmation",
  "running",
  "blocked",
  "waiting_for_human",
  "completed",
  "failed",
  "cancelled",
]);
const sortSchema = z.enum(["updatedAt", "createdAt"]);
const orderSchema = z.enum(["asc", "desc"]);
const contestedDecisionSchema = z.enum(["accept", "discard"]);
const taskWatchModeSchema = z.enum(["next_event", "until_attention_or_terminal"]);
const scheduledModeSchema = z.enum(["temp", "bound"]);
const agentMessagingErrorCodes = new Set<AgentMessagingErrorCode>([
  "TARGET_NOT_REACHABLE",
  "TARGET_UNAVAILABLE",
  "ROUTE_UNAVAILABLE",
  "TARGET_NOT_RUNNING",
  "TARGET_NOT_STEERABLE",
  "TARGET_NOT_INTERRUPTIBLE",
  "MESSAGE_TOO_LARGE",
  "MESSAGE_QUEUE_FULL",
  "MESSAGE_RATE_LIMITED",
  "SELF_MESSAGE_NOT_ALLOWED",
  "DELIVERY_RACE",
  "DELIVERY_TIMEOUT",
  "DELIVERY_FAILED",
  "DELIVERY_DENIED",
]);
const taskQuestionSchema = z
  .object({
    taskId: z.string().min(1),
    questionId: z.string().min(1),
  })
  .strict();

export interface XacpxMcpToolDefinition<Args> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Args>;
  execution?: ToolExecution;
  handler: (args: Args) => Promise<XacpxMcpToolResult>;
}

export type XacpxMcpToolResult = CallToolResult;

export function buildXacpxMcpToolRegistry(input: {
  transport: XacpxMcpTransport;
  coordinatorSession: string;
  sourceHandle?: string;
  // External coordinators (Claude Code / Codex / OpenCode connecting via mcp-stdio)
  // cannot route through human-input packages — orchestration-service throws
  // "human input routing is not configured for external coordinator" for
  // coordinator_request_human_input. We filter that tool out of the registry
  // instead of advertising calls that would always fail.
  isExternalCoordinator?: boolean;
  // Hidden, route-scoped tools for the current xacpx conversation session.
  // Queue owners opt in with --internal-session-tools; external mcp-stdio
  // clients and worker-bound tools must not see these tools.
  internalSessionTools?: boolean;
  availableAgents?: string[];
}): XacpxMcpToolDefinition<unknown>[] {
  const { transport, coordinatorSession, sourceHandle, isExternalCoordinator, internalSessionTools, availableAgents } = input;

  const tools: XacpxMcpToolDefinition<unknown>[] = [
    {
      name: "delegate_request",
      description: `Delegate a subtask to another agent under the current coordinator. Pass an absolute workingDirectory for the worker. Supports MCP Tasks when the client requests task execution: the tool can return a native task handle immediately, then clients can use tasks/get, tasks/result, tasks/list, and tasks/cancel.${availableAgents && availableAgents.length > 0 ? ` Available agents: ${availableAgents.join(", ")}.` : ""}`,
      execution: { taskSupport: "optional" },
      inputSchema: z
        .object({
          targetAgent: z.string().min(1),
          task: z.string().min(1),
          workingDirectory: z.string().min(1).optional(),
          role: z.string().min(1).optional(),
          groupId: z.string().min(1).optional(),
          parallel: z
            .boolean()
            .describe(
              "Set to true to run this task in its own ephemeral session, concurrently with other in-flight tasks for the same agent.",
            )
            .optional(),
        })
        .strict(),
      handler: async (args) =>
        await asToolResult(async () => {
          const input = args as {
            targetAgent: string;
            task: string;
            workingDirectory?: string;
            role?: string;
            groupId?: string;
            parallel?: boolean;
          };
          const result = await transport.delegateRequest({
            coordinatorSession,
            ...(sourceHandle ? { sourceHandle } : {}),
            ...input,
          });
          return createSuccessResult(renderDelegateSuccess(result), result);
        }),
    },
    {
      name: "delegate_batch",
      description: `Delegate several subtasks at once. Pass a "tasks" array; when it holds 2+ tasks they are bound to one auto-created group, so their results are reported back to you together when the whole batch finishes — one handoff instead of one interruption per task. Use this whenever you have multiple parallel delegations. Returns one result per task in input order; a task that fails to start carries an "error" field and does not abort the rest. Legacy-style only: it does not support MCP task execution — use delegate_request for a single native task handle.`,
      inputSchema: z
        .object({
          title: z.string().min(1).optional(),
          tasks: z
            .array(
              z
                .object({
                  targetAgent: z.string().min(1),
                  task: z.string().min(1),
                  workingDirectory: z.string().min(1).optional(),
                  role: z.string().min(1).optional(),
                  parallel: z
                    .boolean()
                    .describe(
                      "Set to true to run this task in its own ephemeral session, concurrently with other in-flight tasks for the same agent.",
                    )
                    .optional(),
                })
                .strict(),
            )
            .min(1),
        })
        .strict(),
      handler: async (args) =>
        await asToolResult(async () => {
          const { title, tasks } = args as {
            title?: string;
            tasks: Array<{ targetAgent: string; task: string; workingDirectory?: string; role?: string; parallel?: boolean }>;
          };
          // If every subsequent delegateRequest fails, the group is created but stays
          // empty — which is harmless: an empty group has no terminal members so it
          // never triggers coordinator injection.
          const groupId =
            tasks.length >= 2
              ? (
                  await transport.createGroup({
                    coordinatorSession,
                    title: title ?? `Batch delegation (${tasks.length} tasks)`,
                  })
                ).groupId
              : undefined;
          const results: Array<{ index: number; taskId?: string; status?: string; error?: string }> = [];
          for (const [index, entry] of tasks.entries()) {
            try {
              const result = await transport.delegateRequest({
                coordinatorSession,
                ...(sourceHandle ? { sourceHandle } : {}),
                targetAgent: entry.targetAgent,
                task: entry.task,
                ...(entry.workingDirectory ? { workingDirectory: entry.workingDirectory } : {}),
                ...(entry.role ? { role: entry.role } : {}),
                ...(groupId ? { groupId } : {}),
                ...(entry.parallel !== undefined ? { parallel: entry.parallel } : {}),
              });
              results.push({ index, taskId: result.taskId, status: result.status });
            } catch (error) {
              results.push({ index, error: formatToolError(error) });
            }
          }
          return createSuccessResult(renderDelegateBatchSuccess(groupId, results), { ...(groupId ? { groupId } : {}), tasks: results });
        }),
    },
    {
      name: "task_get",
      description: "Fetch a single task under the current coordinator: its summary, latest progress, and — once terminal — the worker's final result. Prefer task_watch to follow a task; its terminal result already carries the output, so a follow-up task_get is unnecessary. Reach for task_get to recover a task you lost track of, to inspect one that requires attention, or to re-read the original delegated prompt. The full prompt is included only for needs_confirmation tasks unless you pass includePrompt:true.",
      inputSchema: z
        .object({
          taskId: z.string().min(1),
          includePrompt: z.boolean().optional(),
        })
        .strict(),
      handler: async (args) =>
        await asToolResult(async () => {
          const { taskId, includePrompt } = args as { taskId: string; includePrompt?: boolean };
          const task = await transport.getTask({ coordinatorSession, taskId });
          return createSuccessResult(
            task ? renderTaskSummary(task, { includePrompt: includePrompt ?? false }) : "Task not found.",
            { task },
          );
        }),
    },
    {
      name: "task_list",
      description: "List tasks under the current coordinator. Use to recover taskIds for in-flight delegations or to survey what is still running / blocked.",
      inputSchema: z
        .object({
          status: taskStatusSchema.optional(),
          stuck: z.boolean().optional(),
          sort: sortSchema.optional(),
          order: orderSchema.optional(),
        })
        .strict(),
      handler: async (args) =>
        await asToolResult(async () => {
          const { status, stuck, sort, order } = args as {
            status?:
              | "needs_confirmation"
              | "running"
              | "blocked"
              | "waiting_for_human"
              | "completed"
              | "failed"
              | "cancelled";
            stuck?: boolean;
            sort?: "updatedAt" | "createdAt";
            order?: "asc" | "desc";
          };
          const tasks = await transport.listTasks({
            coordinatorSession,
            ...(status !== undefined ? { status } : {}),
            ...(stuck !== undefined ? { stuck } : {}),
            ...(sort !== undefined ? { sort } : {}),
            ...(order !== undefined ? { order } : {}),
          });
          return createSuccessResult(renderTaskList(tasks), { tasks });
        }),
    },
    {
      name: "task_approve",
      description: "Approve a task that delegate_request returned as needs_confirmation, once the user has authorized it. The task then starts running.",
      inputSchema: z
        .object({
          taskId: z.string().min(1),
        })
        .strict(),
      handler: async (args) =>
        await asToolResult(async () => {
          const task = await transport.approveTask({
            coordinatorSession,
            taskId: (args as { taskId: string }).taskId,
          });
          return createSuccessResult(renderTaskApprovalSuccess(task), task);
        }),
    },
    {
      name: "task_cancel",
      description: "Cancel a task under the current coordinator. Works in any non-terminal state: a running delegation is aborted, and a task still waiting for approval (needs_confirmation) is rejected. The task transitions to a terminal state shortly after.",
      inputSchema: z
        .object({
          taskId: z.string().min(1),
        })
        .strict(),
      handler: async (args) =>
        await asToolResult(async () => {
          const task = await transport.cancelTask({
            coordinatorSession,
            taskId: (args as { taskId: string }).taskId,
          });
          return createSuccessResult(renderTaskCancelRequest(task), task);
        }),
    },
    {
      name: "task_watch",
      description: `Long-poll a task for the next event, attention-required state, or terminal state. For MCP-task-capable clients, request task execution for this tool to create a background watcher: the call returns a native task handle immediately, and tasks/result returns when the watch condition is met. The native watcher is single-shot: it runs one watch cycle then terminates, so to keep watching start another task_watch with afterSeq set to the returned nextAfterSeq. Defaults: timeout ${DEFAULT_TASK_WATCH_TIMEOUT_MS} ms, poll interval ${DEFAULT_TASK_WATCH_POLL_INTERVAL_MS} ms. Maximums: timeout ${MAX_TASK_WATCH_TIMEOUT_MS} ms, poll interval ${MAX_TASK_WATCH_POLL_INTERVAL_MS} ms.`,
      execution: { taskSupport: "optional" },
      inputSchema: z
        .object({
          taskId: z.string().min(1),
          afterSeq: z.number().int().min(0).optional(),
          mode: taskWatchModeSchema.optional(),
          includeProgress: z.boolean().optional(),
          timeoutMs: z.number().int().min(0).max(MAX_TASK_WATCH_TIMEOUT_MS).optional(),
          pollIntervalMs: z.number().int().min(1).max(MAX_TASK_WATCH_POLL_INTERVAL_MS).optional(),
        })
        .strict(),
      handler: async (args) =>
        await asToolResult(async () => {
          const result = await transport.watchTask({
            coordinatorSession,
            ...(args as {
              taskId: string;
              afterSeq?: number;
              mode?: "next_event" | "until_attention_or_terminal";
              includeProgress?: boolean;
              timeoutMs?: number;
              pollIntervalMs?: number;
            }),
          });
          return createSuccessResult(renderTaskWatchResult(result), result);
        }),
    },
    {
      name: "worker_raise_question",
      description: "Raise a blocker question for the current bound worker session. Worker-side only: call this from inside a delegated task when you are blocked and need the coordinator's input.",
      inputSchema: z
        .object({
          taskId: z.string().min(1),
          question: z.string().min(1),
          whyBlocked: z.string().min(1),
          whatIsNeeded: z.string().min(1),
        })
        .strict(),
      handler: async (args) =>
        await asToolResult(async () => {
          if (!sourceHandle || sourceHandle.trim().length === 0) {
            throw new Error(
              "worker_raise_question requires a bound sourceHandle; start mcp-stdio with --source-handle or XACPX_SOURCE_HANDLE",
            );
          }
          const result = await transport.workerRaiseQuestion({
            sourceHandle,
            ...(args as {
              taskId: string;
              question: string;
              whyBlocked: string;
              whatIsNeeded: string;
            }),
          });
          return createSuccessResult(renderWorkerRaiseQuestionSuccess(result), result);
        }),
    },
    {
      name: "coordinator_answer_question",
      description: "Answer a blocked worker question under the current coordinator. Use when task_get shows a pending question.",
      inputSchema: z
        .object({
          taskId: z.string().min(1),
          questionId: z.string().min(1),
          answer: z.string().min(1),
        })
        .strict(),
      handler: async (args) =>
        await asToolResult(async () => {
          const task = await transport.coordinatorAnswerQuestion({
            coordinatorSession,
            ...(args as { taskId: string; questionId: string; answer: string }),
          });
          return createSuccessResult(renderCoordinatorAnswerQuestionSuccess(task), task);
        }),
    },
    {
      name: "coordinator_request_human_input",
      description: "Create or queue a human question package for blocked tasks under the current coordinator. Use when answering a worker question requires real human input rather than your own judgement.",
      inputSchema: z
        .object({
          taskQuestions: z.array(taskQuestionSchema).min(1),
          promptText: z.string().min(1),
          expectedActivePackageId: z.string().min(1).optional(),
        })
        .strict(),
      handler: async (args) =>
        await asToolResult(async () => {
          const result = await transport.coordinatorRequestHumanInput({
            coordinatorSession,
            ...(args as {
              taskQuestions: Array<{ taskId: string; questionId: string }>;
              promptText: string;
              expectedActivePackageId?: string;
            }),
          });
          return createSuccessResult(renderCoordinatorRequestHumanInputSuccess(result), result);
        }),
    },
    {
      name: "coordinator_review_contested_result",
      description: "Review a contested result under the current coordinator. Use when a worker's result has been challenged and the coordinator must decide accept or discard.",
      inputSchema: z
        .object({
          taskId: z.string().min(1),
          reviewId: z.string().min(1),
          decision: contestedDecisionSchema,
        })
        .strict(),
      handler: async (args) =>
        await asToolResult(async () => {
          const { decision, ...rest } = args as {
            taskId: string;
            reviewId: string;
            decision: "accept" | "discard";
          };
          const task = await transport.coordinatorReviewContestedResult({
            coordinatorSession,
            decision,
            ...rest,
          });
          return createSuccessResult(renderCoordinatorReviewContestedResultSuccess(task, decision), task);
        }),
    },
  ];

  tools.push(
    {
      name: "agent_list",
      description:
        "List peer agent sessions that the current xacpx-managed agent is authorized to message. Endpoints may be local or remote; only reachable and discoverable endpoints are returned. Use the returned opaque handle as agent_send.to and do not parse it.",
      inputSchema: z.object({}).strict(),
      handler: async () =>
        await asToolResult(async () => {
          const agents = await transport.listAgentEndpoints({
            coordinatorSession,
            ...(sourceHandle ? { sourceHandle } : {}),
          });
          const text = agents.length === 0
            ? "No authorized peer agent sessions are currently reachable."
            : [
                "Authorized peer agent sessions:",
                ...agents.map(
                  (agent) =>
                    `- ${agent.handle}: ${agent.agent} (${agent.state}; receive=${agent.capabilities.receive}, steer=${agent.capabilities.steer}, queue=${agent.capabilities.queue}, interrupt=${agent.capabilities.interrupt})`,
                ),
              ].join("\n");
          return createSuccessResult(text, { agents });
        }),
    },
    {
      name: "agent_send",
      description:
        "Send a one-way peer message to another authorized agent session. The target may be local or remote. This call returns only after the target runtime accepts injection or queue delivery and never waits for the target model to reply. Use mode=auto unless same-turn steering or interrupt semantics are explicitly required.",
      inputSchema: z
        .object({
          to: z.string().min(1),
          message: z.string().min(1),
          mode: z.enum(["auto", "steer", "queue", "interrupt"]).optional(),
          replyTo: z.string().min(1).optional(),
        })
        .strict(),
      handler: async (args) =>
        await asToolResult(async () => {
          const input = args as {
            to: string;
            message: string;
            mode?: "auto" | "steer" | "queue" | "interrupt";
            replyTo?: string;
          };
          const receipt = await transport.sendAgentMessage({
            coordinatorSession,
            ...(sourceHandle ? { sourceHandle } : {}),
            ...input,
          });
          return createSuccessResult(
            `Peer message ${receipt.messageId} accepted with status=${receipt.status}${receipt.modeUsed ? ` via ${receipt.modeUsed}` : ""}.`,
            receipt,
          );
        }),
    },
  );

  if (internalSessionTools && !isExternalCoordinator && !sourceHandle) {
    tools.push({
      name: "scheduled_create",
      description:
        "Schedule a one-shot task to run a natural-language message at a future time, using the recorded chat route. By default — and like /later — the task runs in a FRESH TEMPORARY session (it snapshots the current agent and workspace but starts with brand-new history and is destroyed after running, so it does not pollute this conversation); the reply is still pushed back to this chat. Provide only timeText and message and OMIT mode to get this default. Routing, session, and account are resolved by xacpx.",
      inputSchema: z
        .object({
          timeText: z
            .string()
            .min(1)
            .describe("Time expression, e.g. 'in 2h', '30\u5206\u949f\u540e', 'tomorrow 09:00', or '\u5468\u4e94 09:00'."),
          message: z.string().min(1).describe("Natural-language message to run at the scheduled time."),
          mode: scheduledModeSchema
            .describe(
              "Optional; leave UNSET for the default temporary session (recommended). Set 'bound' ONLY when the user explicitly asks for the task to run inside this conversation's current session and share its context. 'temp' forces the temporary session.",
            )
            .optional(),
        })
        .strict(),
      handler: async (args) =>
        await asToolResult(async () => {
          const input = args as { timeText: string; message: string; mode?: "temp" | "bound" };
          const task = await transport.scheduledCreate({
            coordinatorSession,
            timeText: input.timeText,
            message: input.message,
            ...(input.mode ? { mode: input.mode } : {}),
          });
          return createSuccessResult(
            `Scheduled task #${task.id} created for ${task.execute_at}.`,
            {
              id: task.id,
              status: task.status,
              executeAt: task.execute_at,
              sessionAlias: task.session_alias,
              sessionMode: task.session_mode ?? "bound",
            },
          );
        }),
    });
    tools.push({
      name: "scheduled_list",
      description:
        "List pending one-shot scheduled tasks created in the current chat. Use to recover task ids before cancelling, or to see what is scheduled. Owner-only in group chats. Routing and account are resolved from the current session; pass no other arguments.",
      inputSchema: z.object({}).strict(),
      handler: async () =>
        await asToolResult(async () => {
          const tasks = await transport.scheduledList({ coordinatorSession });
          return createSuccessResult(renderScheduledList(tasks), {
            tasks: tasks.map((task) => ({
              id: task.id,
              executeAt: task.execute_at,
              message: task.message,
              sessionAlias: task.session_alias,
              sessionMode: task.session_mode ?? "bound",
              chatKey: task.chat_key,
            })),
          });
        }),
    });
    tools.push({
      name: "scheduled_cancel",
      description:
        "Cancel a pending scheduled task by id (only tasks created in the current chat). Owner-only in group chats. Returns whether a pending task with that id was found and cancelled. Routing is resolved from the current session.",
      inputSchema: z
        .object({
          id: z.string().min(1).describe("The scheduled task id, e.g. 'k8f2' (a leading # is allowed)."),
        })
        .strict(),
      handler: async (args) =>
        await asToolResult(async () => {
          const { id } = args as { id: string };
          const result = await transport.scheduledCancel({ coordinatorSession, id });
          return createSuccessResult(renderScheduledCancel(result), { id: result.id, cancelled: result.cancelled });
        }),
    });
  }

  if (isExternalCoordinator) {
    const externalCoordinatorIncompatibleTools = new Set([
      "coordinator_request_human_input",
    ]);
    return tools.filter((tool) => !externalCoordinatorIncompatibleTools.has(tool.name));
  }
  return tools;
}

async function asToolResult(
  action: () => Promise<XacpxMcpToolResult>,
): Promise<XacpxMcpToolResult> {
  try {
    return await action();
  } catch (error) {
    // Quota deferral is NOT a tool failure: the outbound budget is exhausted
    // and the action has already been recorded as pending; it will replay on
    // the next inbound that resets the quota window. Returning isError:true
    // would tempt the coordinator LLM to retry or abort, breaking the
    // active-package invariant. Surface a soft success with a structured
    // status so callers (and prompt templates) can branch on it explicitly.
    if (isQuotaDeferredError(error)) {
      // chatKey is an internal weixin routing identifier and intentionally
      // excluded from the MCP response: external coordinators (Codex, Claude
      // Code, etc.) have no use for it and surfacing it leaks delivery-layer
      // wiring.
      return {
        content: [
          {
            type: "text",
            text:
              "Outbound budget exhausted; the action has been recorded as pending and will retry automatically after the next user inbound resets the quota window. No further action required.",
          },
        ],
        structuredContent: { status: "deferred_quota" },
        isError: false,
      };
    }
    const messagingError = getAgentMessagingError(error);
    if (messagingError) {
      return {
        content: [{ type: "text", text: messagingError.message }],
        structuredContent: { error: messagingError },
        isError: true,
      };
    }
    return createErrorResult(formatToolError(error));
  }
}

function getAgentMessagingError(
  error: unknown,
): { code: AgentMessagingErrorCode; message: string } | null {
  if (!(error instanceof Error) || !("code" in error)) {
    return null;
  }
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code !== "string" || !agentMessagingErrorCodes.has(code as AgentMessagingErrorCode)) {
    return null;
  }
  return { code: code as AgentMessagingErrorCode, message: error.message };
}


function renderTaskWatchResult(result: {
  status: "event" | "attention_required" | "terminal" | "timeout" | "not_found";
  task:
    | {
        taskId: string;
        status: string;
        resultText?: string;
        summary?: string;
        openQuestion?: { question: string };
      }
    | null;
  events: Array<{ seq: number; type: string; at: string; summary?: string; message?: string; status?: string }>;
  nextAfterSeq: number;
  historyTruncated?: boolean;
}): string {
  if (result.status === "not_found" || !result.task) {
    return "Task not found.";
  }
  const header = [
    `Task ${result.task.taskId} watch ${result.status.replace("_", " ")}; current state is ${result.task.status}.`,
    `- nextAfterSeq: ${result.nextAfterSeq}`,
    result.historyTruncated ? "- historyTruncated: true" : "",
  ].filter((line) => line.length > 0);
  const events = result.events.length > 0
    ? [
        "- Events:",
        ...result.events.map((event) => {
          const detail = event.summary ?? event.message ?? event.status ?? "";
          return `  - #${event.seq} ${event.type} at ${event.at}${detail ? `: ${detail}` : ""}`;
        }),
      ]
    : ["- Events: none"];
  // The watch payload already carries the full record, so surface the result on a
  // terminal stop (and the open question on an attention stop) right here — the
  // coordinator no longer needs a follow-up task_get. Only emit on the matching
  // status so mid-flight (event / timeout) cycles stay light.
  const detail: string[] = [];
  if (result.status === "terminal") {
    const resultText = result.task.resultText?.trim() ?? "";
    const summary = result.task.summary?.trim() ?? "";
    if (resultText.length > 0) detail.push(`- Result: ${resultText}`);
    else if (summary.length > 0) detail.push(`- Summary: ${summary}`);
  } else if (result.status === "attention_required" && result.task.openQuestion) {
    detail.push(`- Open question: ${result.task.openQuestion.question}`);
  }
  const next = result.status === "terminal"
    ? "Next: summarize this result for the user."
    : result.status === "attention_required"
      ? "Next: resolve the pending question / contested review with the recommended action tool (coordinator_answer_question or coordinator_review_contested_result); call task_get only if you need more detail."
      : `Next: call task_watch again with afterSeq=${result.nextAfterSeq} to keep watching, preferably as an MCP task if your client supports background task execution.`;
  return [...header, ...events, ...detail, next].join("\n");
}

function createSuccessResult(
  text: string,
  structuredContent?: object,
): XacpxMcpToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent ? { structuredContent: structuredContent as Record<string, unknown> } : {}),
  };
}

function createErrorResult(message: string): XacpxMcpToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function renderDelegateSuccess(result: { taskId: string; status: string }): string {
  const next =
    result.status === "needs_confirmation"
      ? `Next: this delegation requires user approval. Tell the user, then call task_approve or task_cancel based on their response.`
      : result.status === "queued"
        ? `Next: task "${result.taskId}" is queued (agent at parallel capacity). It will start automatically when a slot frees. Call task_watch to long-poll until it runs and then finishes — the terminal watch carries the result. Use task_list only to resurvey in-flight tasks.`
        : `Next: task "${result.taskId}" is running. Return this taskId to the user, then call task_watch to long-poll until it finishes — the terminal watch carries the worker's result, so no follow-up task_get is needed. Use task_list only to resurvey in-flight tasks.`;
  return [`Delegation task "${result.taskId}" created.`, `- Status: ${result.status}`, next].join("\n");
}

function renderDelegateBatchSuccess(
  groupId: string | undefined,
  results: Array<{ index: number; taskId?: string; status?: string; error?: string }>,
): string {
  const lines = results.map((entry) =>
    entry.error
      ? `  - #${entry.index}: failed to start — ${entry.error}`
      : `  - #${entry.index}: task "${entry.taskId}" (${entry.status})`,
  );
  const started = results.filter((entry) => entry.taskId).length;
  const header = groupId
    ? `Batch delegation created group "${groupId}" with ${started}/${results.length} tasks started.`
    : `Delegation: ${started}/${results.length} task started.`;
  const next =
    started > 0
      ? "Next: track the started tasks with task_get/task_list, or task_watch to long-poll. The group reports all results back together once every task is terminal."
      : "Next: every task failed to start — fix the errors above and retry.";
  return [header, "- Tasks:", ...lines, next].join("\n");
}

function renderTaskList(tasks: Array<{ taskId: string; status: string; targetAgent: string; workerSession?: string; role?: string; groupId?: string; summary: string; noticePending?: boolean; injectionPending?: boolean; cancelRequestedAt?: string | undefined; cancelCompletedAt?: string | undefined }>): string {
  if (tasks.length === 0) {
    return "There are no tasks under the current coordinator.";
  }
  return ["Tasks for the current coordinator:", ...tasks.map((task) => renderTaskListItem(task))].join("\n");
}

function renderScheduledList(
  tasks: Array<{
    id: string;
    execute_at: string;
    message: string;
    session_alias: string;
    session_mode?: string;
    chat_key: string;
  }>,
): string {
  if (tasks.length === 0) {
    return "There are no pending scheduled tasks.";
  }
  return [
    "Pending scheduled tasks:",
    ...tasks.map(
      (task) =>
        `- #${task.id} at ${task.execute_at} [${task.session_mode ?? "bound"}] -> ${task.session_alias}: ${task.message}`,
    ),
  ].join("\n");
}

function renderScheduledCancel(result: { id: string; cancelled: boolean }): string {
  return result.cancelled
    ? `Scheduled task #${result.id} cancelled.`
    : `No pending scheduled task #${result.id} found.`;
}

function renderTaskListItem(task: {
  taskId: string;
  status: string;
  targetAgent: string;
  workerSession?: string;
  role?: string;
  groupId?: string;
  summary: string;
  noticePending?: boolean;
  injectionPending?: boolean;
  cancelRequestedAt?: string | undefined;
  cancelCompletedAt?: string | undefined;
}): string {
  const role = task.role ? ` / ${task.role}` : "";
  const group = task.groupId ? `; group: ${task.groupId}` : "";
  const summary = task.summary.trim().length > 0 ? `: ${task.summary}` : "";
  const source = task.status === "needs_confirmation" ? `; source: ${task.targetAgent}${task.role ? ` / ${task.role}` : ""}` : "";
  const reliability = [
    task.noticePending ? "notice pending retry" : "",
    task.injectionPending ? "injection pending retry" : "",
    task.cancelRequestedAt && !task.cancelCompletedAt && task.status === "running" ? "cancelling" : "",
  ]
    .filter(Boolean)
    .map((item) => `; ${item}`)
    .join("");
  return `- ${task.taskId} [${task.status}] ${task.targetAgent}${role} -> ${task.workerSession ?? "unassigned"}${group}${source}${summary}${reliability}`;
}

function renderTaskSummary(task: {
  taskId: string;
  status: string;
  coordinatorSession: string;
  workerSession?: string;
  targetAgent: string;
  role?: string;
  groupId?: string;
  sourceKind: string;
  sourceHandle: string;
  task: string;
  summary: string;
  resultText: string;
  createdAt: string;
  updatedAt: string;
  lastProgressAt?: string;
  lastProgressSummary?: string;
  cancelRequestedAt?: string;
  cancelCompletedAt?: string;
  lastCancelError?: string;
  noticeSentAt?: string;
  deliveryAccountId?: string;
  lastNoticeError?: string;
  injectionAppliedAt?: string;
  lastInjectionError?: string;
  noticePending?: boolean;
  injectionPending?: boolean;
}, options: { includePrompt?: boolean } = {}): string {
  const header = [
    `Task "${task.taskId}"`,
    `- Status: ${task.status}`,
    `- Coordinator session: ${task.coordinatorSession}`,
    `- Worker session: ${task.workerSession ?? "unassigned"}`,
    `- Target agent: ${task.targetAgent}`,
  ];
  if (task.role) header.push(`- Role: ${task.role}`);
  if (task.groupId) header.push(`- Group: ${task.groupId}`);
  if (task.status === "needs_confirmation") {
    header.push(`- Source: ${task.sourceKind} / ${task.sourceHandle}${task.role ? ` / ${task.role}` : ""}`);
  }
  // The coordinator authored this prompt via delegate_request, so echoing it on
  // every snapshot just burns context. Keep it for needs_confirmation (where the
  // approver must see what will run) and behind the explicit includePrompt opt-in.
  if (task.status === "needs_confirmation" || options.includePrompt) {
    header.push(`- Task: ${task.task}`);
  }
  if (task.summary.trim().length > 0) header.push(`- Summary: ${task.summary}`);
  if (task.lastProgressSummary) header.push(`- Latest progress: ${task.lastProgressSummary}`);
  if (task.resultText.trim().length > 0) header.push(`- Result: ${task.resultText}`);
  const events: Array<{ at: string; event: string; detail?: string }> = [];
  events.push({ at: task.createdAt, event: "created" });
  if (task.workerSession && task.status !== "needs_confirmation") {
    events.push({ at: task.createdAt, event: "dispatched", detail: task.workerSession });
  }
  if (task.lastProgressAt) events.push({ at: task.lastProgressAt, event: "last progress" });
  if (task.cancelRequestedAt) events.push({ at: task.cancelRequestedAt, event: "cancel requested" });
  if (task.cancelCompletedAt) events.push({ at: task.cancelCompletedAt, event: "cancel completed" });
  if (task.lastCancelError) events.push({ at: task.updatedAt, event: "cancel failed", detail: task.lastCancelError });
  if (task.status === "completed") events.push({ at: task.updatedAt, event: "completed" });
  if (task.status === "failed") events.push({ at: task.updatedAt, event: "failed" });
  if (task.noticeSentAt) events.push({ at: task.noticeSentAt, event: "notice sent", detail: task.deliveryAccountId });
  if (task.lastNoticeError) events.push({ at: task.updatedAt, event: "notice failed", detail: task.lastNoticeError });
  if (task.injectionAppliedAt) events.push({ at: task.injectionAppliedAt, event: "injection applied" });
  if (task.lastInjectionError) events.push({ at: task.updatedAt, event: "injection failed", detail: task.lastInjectionError });
  events.sort((a, b) => a.at.localeCompare(b.at));
  const timeline = events.length > 0
    ? ["- Timeline:", ...events.map((e) => `  - [${e.at}] ${e.event}${e.detail ? `: ${e.detail}` : ""}`)]
    : [];
  const isTerminal = task.status === "completed" || task.status === "failed" || task.status === "cancelled";
  const next = isTerminal ? ["Next: summarize this result for the user."] : [];
  return [...header, ...timeline, ...next].join("\n");
}

function renderTaskCancelRequest(task: { taskId: string; status: string }): string {
  if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
    return [`Task "${task.taskId}" has already finished.`, `- Current status: ${task.status}`].join("\n");
  }
  return [`Cancellation requested for task "${task.taskId}".`, `- Current status: ${task.status}`].join("\n");
}

function renderTaskApprovalSuccess(task: { taskId: string; status: string }): string {
  return [
    `Task "${task.taskId}" approved.`,
    `- Current status: ${task.status}`,
    `Next: call task_watch to long-poll until the worker finishes — the terminal watch returns the result directly, so no follow-up task_get is needed. Use task_list only to resurvey in-flight tasks.`,
  ].join("\n");
}

function renderWorkerRaiseQuestionSuccess(task: { taskId: string; questionId: string }): string {
  return [`Blocker question submitted for task "${task.taskId}".`, `- questionId: ${task.questionId}`].join("\n");
}

function renderCoordinatorAnswerQuestionSuccess(task: { taskId: string; status: string }): string {
  return [`Answered the blocker question for task "${task.taskId}".`, `- Current status: ${task.status}`].join("\n");
}

function renderCoordinatorRequestHumanInputSuccess(result: { packageId?: string; queuedTaskIds: string[] }): string {
  return result.packageId
    ? [`Created human question package "${result.packageId}".`, `- Queued tasks: ${result.queuedTaskIds.length}`].join("\n")
    : [`Queued the question in the current human question queue.`, `- Queued tasks: ${result.queuedTaskIds.length}`].join("\n");
}

function renderCoordinatorReviewContestedResultSuccess(task: { taskId: string; status: string }, decision: "accept" | "discard"): string {
  const actionText = decision === "accept" ? "Accepted" : "Discarded";
  return [`${actionText} contested result for task "${task.taskId}".`, `- Current status: ${task.status}`].join("\n");
}

function formatToolError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  const isConnectionError =
    code === "ECONNREFUSED"
    || code === "ENOENT"
    || code === "ECONNRESET"
    || code === "EPIPE"
    || /server closed without a response|socket hang up/i.test(message);
  if (isConnectionError) {
    return `Failed to connect to the orchestration daemon: ${message}`;
  }
  return message;
}
