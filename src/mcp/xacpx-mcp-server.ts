import { stdin, stdout } from "node:process";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetTaskPayloadRequestSchema,
  ListToolsRequestSchema,
  McpError,
  RELATED_TASK_META_KEY,
  type CallToolResult,
  type CreateTaskResult,
  type Root,
  type Task,
  type Result,
} from "@modelcontextprotocol/sdk/types.js";
import type { CreateTaskOptions, TaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodError } from "zod";

import { readVersion } from "../version.js";
import { coreEnv } from "../runtime/core-env";
import type { OrchestrationIpcEndpoint } from "../orchestration/orchestration-ipc";
import type { OrchestrationTaskRecord } from "../orchestration/orchestration-types";
import { resolveDefaultOrchestrationEndpoint } from "./resolve-endpoint";
import { canConnectToEndpoint } from "../orchestration/endpoint-probe";
import { buildXacpxMcpToolRegistry } from "./xacpx-mcp-tools";
import { createOrchestrationTransport, type XacpxMcpTransport } from "./xacpx-mcp-transport";

const TASK_OPTIONS_CACHE_LIMIT = 1_000;
const TASKS_LIST_PAGE_SIZE = 100;

// Upper bound on native task_watch watchers retained in memory. Watchers are
// one-shot and normally evicted as soon as their result is consumed; this cap
// is the backstop for clients that create watchers and never fetch results.
export const WATCH_TASKS_CACHE_LIMIT = 256;

interface WatchMcpTaskRecord {
  task: Task;
  result?: Result;
}

export interface XacpxMcpServerOptions {
  transport?: XacpxMcpTransport;
  coordinatorSession?: string;
  sourceHandle?: string;
  isExternalCoordinator?: boolean;
  internalSessionTools?: boolean;
  resolveIdentity?: (context: XacpxMcpIdentityResolutionContext) => Promise<XacpxMcpIdentity>;
  availableAgents?: string[];
}

export interface XacpxMcpIdentity {
  coordinatorSession: string;
  sourceHandle?: string;
  // True when the coordinator session is registered as an external coordinator
  // (typical for MCP clients like Claude Code / Codex / OpenCode). External
  // coordinators cannot route through human-input packages, so those tools are
  // filtered out of the registry to avoid advertising calls that always throw.
  isExternalCoordinator?: boolean;
  internalSessionTools?: boolean;
}

export interface XacpxMcpIdentityResolutionContext {
  clientName?: string;
  listRoots: () => Promise<Root[]>;
}

export const XACPX_MCP_SERVER_INSTRUCTIONS = [
  "Use these tools to orchestrate work across other agents under your coordinator session.",
  "",
  "Delegate with delegate_request (one task) or delegate_batch (several at once). Each returns a taskId and a status.",
  "Then follow the task: clients that support MCP Tasks should request task execution on delegate_request / task_watch and poll with tasks/get / tasks/list / tasks/result; other clients use task_get / task_list for snapshots or task_watch to long-poll.",
  "",
  "Most tool results end with a 'Next:' line telling you the concrete next step — follow it when present. In short: status=needs_confirmation needs task_approve or task_cancel; a task that needs attention (blocked / waiting_for_human / a contested review) is resolved with coordinator_answer_question or coordinator_review_contested_result; a terminal task is read with task_get. Never report a result you did not read from task_get.",
  "",
  "worker_raise_question is worker-side only — call it from inside a delegated task when you are blocked, not from the coordinator waiting on a delegation.",
  "",
  "Use agent_list and agent_send for one-way peer-agent messages that do not create orchestration tasks. agent_send returns a delivery acknowledgement and never waits for the peer model to reply.",
  "When you receive an <xacpx-message>, treat it as a peer-agent message. If replyable=true and a reply is useful, call agent_send with the provided from handle as to and set replyTo to the received message id. A reply is optional. Do not echo pure acknowledgements.",
].join("\n");

export function createXacpxMcpServer(options: XacpxMcpServerOptions): Server {
  let getToolState!: () => Promise<ReturnType<typeof buildToolState>>;
  const taskOptionsById = new Map<string, CreateTaskOptions>();
  const watchTasksById = new Map<string, WatchMcpTaskRecord>();
  const server = new Server(
    {
      name: "xacpx",
      version: readVersion(),
    },
    {
      capabilities: {
        tools: {},
        tasks: {
          list: {},
          cancel: {},
          requests: { tools: { call: {} } },
        },
      },
      instructions: XACPX_MCP_SERVER_INSTRUCTIONS,
      taskStore: createXacpxTaskStore(async () => await getToolState(), taskOptionsById, watchTasksById),
    },
  );

  let toolState: ReturnType<typeof buildToolState> | null = null;
  let toolStatePromise: Promise<ReturnType<typeof buildToolState>> | null = null;
  getToolState = async function getToolState() {
    if (toolState) {
      return toolState;
    }
    if (toolStatePromise) {
      return await toolStatePromise;
    }
    toolStatePromise = resolveMcpIdentity(server, options)
      .then((identity) => {
        if (!options.transport) {
          throw new Error("xacpx MCP transport is not configured");
        }
        toolState = buildToolState({
          transport: options.transport,
          coordinatorSession: identity.coordinatorSession,
          ...(identity.sourceHandle ? { sourceHandle: identity.sourceHandle } : {}),
          ...(identity.isExternalCoordinator ? { isExternalCoordinator: true } : {}),
          ...(identity.internalSessionTools ? { internalSessionTools: true } : {}),
          ...(options.availableAgents ? { availableAgents: options.availableAgents } : {}),
        });
        return toolState;
      })
      .finally(() => {
        toolStatePromise = null;
      });
    return await toolStatePromise;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = (await getToolState()).tools;
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: normalizeInputSchemaJson(zodToJsonSchema(tool.inputSchema)),
        ...(tool.execution ? { execution: tool.execution } : {}),
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult | CreateTaskResult> => {
    const toolMap = (await getToolState()).toolMap;
    const tool = toolMap.get(request.params.name);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }

    const parsed = tool.inputSchema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      throw new McpError(ErrorCode.InvalidParams, formatZodError(parsed.error));
    }

    if (request.params.task) {
      if (tool.name !== "delegate_request" && tool.name !== "task_watch") {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Tool ${tool.name} does not support MCP task execution`,
        );
      }
      if (tool.name === "delegate_request") {
        return await createDelegationMcpTask({
          state: await getToolState(),
          args: parsed.data,
          taskParams: request.params.task,
          taskOptionsById,
        });
      }
      return await createWatchMcpTask({
        state: await getToolState(),
        args: parsed.data,
        taskParams: request.params.task,
        taskOptionsById,
        watchTasksById,
      });
    }

    return await tool.handler(parsed.data);
  });

  // The SDK's default tasks/result handler waits until a task is terminal.
  // xacpx also uses input_required for external approval/blocker workflows,
  // where the coordinator must call another tool before the task can continue.
  // Return an actionable package immediately for input_required so task-aware
  // clients do not deadlock waiting for a result that depends on their action.
  server.setRequestHandler(GetTaskPayloadRequestSchema, async (request): Promise<Result> => {
    const watchTask = watchTasksById.get(request.params.taskId);
    if (watchTask) {
      if (!watchTask.result) {
        throw new McpError(ErrorCode.InvalidRequest, `Task ${request.params.taskId} is still ${watchTask.task.status}`);
      }
      // A watcher is one-shot: its result has now been delivered, so drop the
      // entry. Without this, watchTasksById grows for the lifetime of the
      // MCP server process.
      watchTasksById.delete(request.params.taskId);
      return watchTask.result;
    }
    const state = await getToolState();
    const task = await state.transport.getTask({
      coordinatorSession: state.coordinatorSession,
      taskId: request.params.taskId,
    });
    if (!task) {
      throw new McpError(ErrorCode.InvalidParams, `Task not found: ${request.params.taskId}`);
    }
    return withRelatedTaskMeta(renderNativeTaskPayloadResult(task), task.taskId);
  });

  return server;
}

function buildToolState(options: {
  transport: XacpxMcpTransport;
  coordinatorSession: string;
  sourceHandle?: string;
  isExternalCoordinator?: boolean;
  internalSessionTools?: boolean;
  availableAgents?: string[];
}) {
  const tools = buildXacpxMcpToolRegistry(options);
  return {
    tools,
    toolMap: new Map(tools.map((tool) => [tool.name, tool])),
    transport: options.transport,
    coordinatorSession: options.coordinatorSession,
    sourceHandle: options.sourceHandle,
  };
}

async function createDelegationMcpTask(input: {
  state: ReturnType<typeof buildToolState>;
  args: unknown;
  taskParams: CreateTaskOptions;
  taskOptionsById: Map<string, CreateTaskOptions>;
}): Promise<CreateTaskResult> {
  const delegateTool = input.state.toolMap.get("delegate_request");
  if (!delegateTool) {
    throw new McpError(ErrorCode.MethodNotFound, "delegate_request is not registered");
  }

  const result = await delegateTool.handler(input.args);
  if (result.isError) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      result.content.map((item) => item.type === "text" ? item.text : "").filter(Boolean).join("\n") || "Delegation failed",
    );
  }

  const structured = result.structuredContent as { taskId?: unknown } | undefined;
  const taskId = typeof structured?.taskId === "string" ? structured.taskId : undefined;
  if (!taskId) {
    throw new McpError(ErrorCode.InternalError, "delegate_request did not return a taskId");
  }
  rememberTaskOptions(input.taskOptionsById, taskId, input.taskParams);

  const task = await input.state.transport.getTask({
    coordinatorSession: input.state.coordinatorSession,
    taskId,
  });

  if (!task) {
    throw new McpError(
      ErrorCode.InternalError,
      `delegate_request created task "${taskId}" but it was not readable from orchestration state`,
    );
  }

  return {
    task: toMcpTask(task, input.taskParams),
  };
}

async function createWatchMcpTask(input: {
  state: ReturnType<typeof buildToolState>;
  args: unknown;
  taskParams: CreateTaskOptions;
  taskOptionsById: Map<string, CreateTaskOptions>;
  watchTasksById: Map<string, WatchMcpTaskRecord>;
}): Promise<CreateTaskResult> {
  const taskId = (input.args as { taskId?: unknown }).taskId;
  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new McpError(ErrorCode.InvalidParams, "task_watch requires taskId");
  }
  const baseTask = await input.state.transport.getTask({
    coordinatorSession: input.state.coordinatorSession,
    taskId,
  });
  if (!baseTask) {
    throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
  }
  const now = new Date().toISOString();
  const watchTaskId = `watch:${taskId}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  rememberTaskOptions(input.taskOptionsById, watchTaskId, input.taskParams);
  const watchTask = toMcpTask({
    taskId: watchTaskId,
    status: "running",
    summary: `Watching task ${taskId}`,
    createdAt: now,
    updatedAt: now,
  }, input.taskParams);
  registerWatchTask(input.watchTasksById, watchTaskId, { task: watchTask });
  void runWatchMcpTask({
    state: input.state,
    args: input.args,
    watchTaskId,
    taskOptions: input.taskParams,
    watchTasksById: input.watchTasksById,
  });
  return {
    task: watchTask,
  };
}

async function runWatchMcpTask(input: {
  state: ReturnType<typeof buildToolState>;
  args: unknown;
  watchTaskId: string;
  taskOptions: CreateTaskOptions;
  watchTasksById: Map<string, WatchMcpTaskRecord>;
}): Promise<void> {
  const args = input.args as {
    taskId: string;
    afterSeq?: number;
    mode?: "next_event" | "until_attention_or_terminal";
    includeProgress?: boolean;
    timeoutMs?: number;
    pollIntervalMs?: number;
  };
  try {
    const result = await input.state.transport.watchTask({
      coordinatorSession: input.state.coordinatorSession,
      ...args,
    });
    // If the cap evicted this watcher while watchTask() was in flight, its
    // result is already unreachable — do not resurrect it past the cap.
    if (!input.watchTasksById.has(input.watchTaskId)) return;
    const now = new Date().toISOString();
    const mcpStatus = result.status === "attention_required"
      ? "input_required"
      : result.status === "not_found"
        ? "failed"
        : "completed";
    input.watchTasksById.set(input.watchTaskId, {
      task: {
        taskId: input.watchTaskId,
        status: mcpStatus,
        ttl: input.taskOptions.ttl ?? null,
        createdAt: input.watchTasksById.get(input.watchTaskId)?.task.createdAt ?? now,
        lastUpdatedAt: now,
        ...(input.taskOptions.pollInterval !== undefined ? { pollInterval: input.taskOptions.pollInterval } : {}),
        statusMessage: renderWatchTaskStatusMessage(result),
      },
      result: withRelatedTaskMeta(renderWatchMcpTaskResult(result, input.watchTaskId), result.task?.taskId ?? input.watchTaskId),
    });
  } catch (error) {
    // Same eviction guard as the success path: a watcher dropped by the cap
    // must not reappear once its watch settles.
    if (!input.watchTasksById.has(input.watchTaskId)) return;
    const now = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    input.watchTasksById.set(input.watchTaskId, {
      task: {
        taskId: input.watchTaskId,
        status: "failed",
        ttl: input.taskOptions.ttl ?? null,
        createdAt: input.watchTasksById.get(input.watchTaskId)?.task.createdAt ?? now,
        lastUpdatedAt: now,
        statusMessage: message,
      },
      result: {
        content: [{ type: "text", text: `Task watch "${input.watchTaskId}" failed: ${message}` }],
        structuredContent: { watchTaskId: input.watchTaskId, error: message },
        isError: true,
      } as CallToolResult,
    });
  }
}

function renderWatchTaskStatusMessage(result: {
  status: string;
  task: { taskId: string; status: string } | null;
  events?: Array<{ seq: number }>;
}): string {
  if (!result.task) return `Watch finished: ${result.status}`;
  return `Watch finished for ${result.task.taskId}: ${result.status}; task status ${result.task.status}; events ${result.events?.length ?? 0}`;
}

function renderWatchMcpTaskResult(result: {
  status: "event" | "attention_required" | "terminal" | "timeout" | "not_found";
  task: OrchestrationTaskRecord | null;
  events: Array<{ seq: number; type: string; at: string; summary?: string; message?: string; status?: string }>;
  nextAfterSeq: number;
  historyTruncated?: boolean;
}, watchTaskId: string): Result {
  if (result.status === "not_found" || !result.task) {
    return {
      content: [{ type: "text", text: `Task watch "${watchTaskId}" finished: watched task not found.` }],
      structuredContent: { watchTaskId, ...result },
      isError: true,
    } as CallToolResult;
  }
  const header = [
    `Task watch "${watchTaskId}" finished with ${result.status.replace("_", " ")}.`,
    `Watched task ${result.task.taskId} is ${result.task.status}.`,
    `nextAfterSeq: ${result.nextAfterSeq}`,
    result.historyTruncated ? "historyTruncated: true" : "",
  ].filter((line) => line.length > 0);
  const events = result.events.length > 0
    ? [
        "Events:",
        ...result.events.map((event) => {
          const detail = event.summary ?? event.message ?? event.status ?? "";
          return `- #${event.seq} ${event.type} at ${event.at}${detail ? `: ${detail}` : ""}`;
        }),
      ]
    : ["Events: none"];
  // Surface the result on a terminal stop (and the open question on an attention
  // stop) directly from the watched record, so the coordinator does not have to
  // follow up with a separate task_get.
  const detail: string[] = [];
  if (result.status === "terminal") {
    const resultText = result.task.resultText.trim();
    const summary = result.task.summary.trim();
    if (resultText.length > 0) detail.push(`Result: ${resultText}`);
    else if (summary.length > 0) detail.push(`Summary: ${summary}`);
  } else if (result.status === "attention_required" && result.task.openQuestion) {
    detail.push(`Open question: ${result.task.openQuestion.question}`);
  }
  const next = result.status === "terminal"
    ? "Next: summarize this result for the user."
    : result.status === "attention_required"
      ? "Next: resolve the pending question / contested review with the recommended action tool (coordinator_answer_question or coordinator_review_contested_result)."
      : `Next: call task_watch again with afterSeq=${result.nextAfterSeq} to keep watching.`;
  return {
    content: [{ type: "text", text: [...header, ...events, ...detail, next].join("\n") }],
    structuredContent: { watchTaskId, ...result },
  } as CallToolResult;
}

function createXacpxTaskStore(
  resolveState: () => Promise<ReturnType<typeof buildToolState>>,
  taskOptionsById: Map<string, CreateTaskOptions>,
  watchTasksById: Map<string, WatchMcpTaskRecord>,
): TaskStore {
  return {
    createTask: async () => {
      throw new Error("xacpx native MCP tasks are created by delegate_request");
    },
    getTask: async (taskId) => {
      const watchTask = watchTasksById.get(taskId);
      if (watchTask) return watchTask.task;
      // A watch:* id with no registry entry was already consumed or evicted
      // (watchers are one-shot). It is not an orchestration task, so the
      // transport lookup below returns null and the SDK surfaces a clean
      // not-found — expected behaviour, not an error.
      const state = await resolveState();
      const task = await state.transport.getTask({ coordinatorSession: state.coordinatorSession, taskId });
      return task ? toMcpTask(task, taskOptionsById.get(taskId)) : null;
    },
    storeTaskResult: async () => {
      throw new Error("xacpx native MCP task results are stored by orchestration");
    },
    getTaskResult: async (taskId) => {
      const watchTask = watchTasksById.get(taskId);
      if (watchTask) {
        if (!watchTask.result) {
          throw new Error(`Task ${taskId} is still ${watchTask.task.status}`);
        }
        // One-shot watcher: drop it once its result has been delivered.
        watchTasksById.delete(taskId);
        return watchTask.result;
      }
      const state = await resolveState();
      const task = await state.transport.getTask({ coordinatorSession: state.coordinatorSession, taskId });
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }
      return renderNativeTaskPayloadResult(task);
    },
    updateTaskStatus: async (taskId, status, statusMessage) => {
      const state = await resolveState();
      if (status === "cancelled") {
        await state.transport.cancelTask({ coordinatorSession: state.coordinatorSession, taskId });
        return;
      }
      throw new Error(`xacpx MCP task status is read-only (${status}${statusMessage ? `: ${statusMessage}` : ""})`);
    },
    listTasks: async (cursor) => {
      const state = await resolveState();
      const tasks = await state.transport.listTasks({
        coordinatorSession: state.coordinatorSession,
        sort: "updatedAt",
        order: "desc",
      });
      const watchTasks = Array.from(watchTasksById.values()).map((record) => record.task);
      pruneTaskOptions(taskOptionsById, new Set([...tasks.map((task) => task.taskId), ...watchTasks.map((task) => task.taskId)]));
      const offset = parseTaskListCursor(cursor);
      const allTasks = [
        ...watchTasks,
        ...tasks.map((task) => toMcpTask(task, taskOptionsById.get(task.taskId))),
      ].sort((a, b) => b.lastUpdatedAt.localeCompare(a.lastUpdatedAt));
      const page = allTasks.slice(offset, offset + TASKS_LIST_PAGE_SIZE);
      const nextOffset = offset + page.length;
      return {
        tasks: page,
        ...(nextOffset < allTasks.length ? { nextCursor: String(nextOffset) } : {}),
      };
    },
  };
}

function rememberTaskOptions(
  taskOptionsById: Map<string, CreateTaskOptions>,
  taskId: string,
  options: CreateTaskOptions,
): void {
  taskOptionsById.set(taskId, normalizeCreateTaskOptions(options));
  while (taskOptionsById.size > TASK_OPTIONS_CACHE_LIMIT) {
    const oldestKey = taskOptionsById.keys().next().value;
    if (oldestKey === undefined) break;
    taskOptionsById.delete(oldestKey);
  }
}

function registerWatchTask(
  watchTasksById: Map<string, WatchMcpTaskRecord>,
  watchTaskId: string,
  record: WatchMcpTaskRecord,
): void {
  watchTasksById.set(watchTaskId, record);
  // Evict the oldest watchers (insertion order) so an abandoned-watcher client
  // cannot grow the registry without bound.
  while (watchTasksById.size > WATCH_TASKS_CACHE_LIMIT) {
    const oldestKey = watchTasksById.keys().next().value;
    if (oldestKey === undefined || oldestKey === watchTaskId) break;
    watchTasksById.delete(oldestKey);
  }
}

function pruneTaskOptions(taskOptionsById: Map<string, CreateTaskOptions>, taskIds: Set<string>): void {
  for (const taskId of taskOptionsById.keys()) {
    if (!taskIds.has(taskId)) {
      taskOptionsById.delete(taskId);
    }
  }
}

function parseTaskListCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const offset = Number(cursor);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid tasks/list cursor: ${cursor}`);
  }
  return offset;
}

function renderNativeTaskPayloadResult(task: OrchestrationTaskRecord): Result {
  if (toMcpTaskStatus(task) === "input_required") {
    return renderInputRequiredTaskResult(task);
  }
  if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
    return renderNativeTaskResult(task);
  }
  throw new McpError(
    ErrorCode.InvalidRequest,
    `Task ${task.taskId} is still ${task.status}; use tasks/get until it is terminal or input_required`,
  );
}

function withRelatedTaskMeta(result: Result, taskId: string): Result {
  return {
    ...result,
    _meta: {
      ...result._meta,
      [RELATED_TASK_META_KEY]: { taskId },
    },
  };
}

function renderNativeTaskResult(task: OrchestrationTaskRecord): Result {
  const isError = task.status === "failed" || task.status === "cancelled";
  const text = [
    `Task "${task.taskId}" finished with status ${task.status}.`,
    task.resultText.trim().length > 0 ? task.resultText : task.summary,
  ].filter((line) => line.trim().length > 0).join("\n");
  return {
    content: [{ type: "text", text }],
    structuredContent: { task },
    ...(isError ? { isError: true } : {}),
  } as CallToolResult;
}

function renderInputRequiredTaskResult(task: OrchestrationTaskRecord): Result {
  const actions = inputRequiredActions(task);
  const text = [
    `Task "${task.taskId}" requires input before it can continue.`,
    task.summary.trim().length > 0 ? task.summary : "",
    task.openQuestion ? `Open question: ${task.openQuestion.question}` : "",
    `Next: call task_get("${task.taskId}") to inspect details, then ${actions.join(" or ")}.`,
  ].filter((line) => line.trim().length > 0).join("\n");
  return {
    content: [{ type: "text", text }],
    structuredContent: {
      task,
      nextAction: {
        kind: "input_required",
        taskId: task.taskId,
        recommendedTools: actions,
      },
    },
  } as CallToolResult;
}

function inputRequiredActions(task: OrchestrationTaskRecord): string[] {
  const actions: string[] = [];
  if (task.status === "needs_confirmation") {
    actions.push("task_approve", "task_cancel");
  }
  if (task.status === "blocked" || task.status === "waiting_for_human" || task.openQuestion) {
    actions.push("coordinator_answer_question");
  }
  if (task.reviewPending) {
    actions.push("coordinator_review_contested_result");
  }
  return actions.length > 0 ? actions : ["task_get"];
}

function toMcpTask(
  task: Pick<OrchestrationTaskRecord, "taskId" | "status" | "createdAt" | "updatedAt" | "summary"> & Partial<Pick<OrchestrationTaskRecord, "lastProgressAt" | "lastProgressSummary" | "reviewPending">>,
  options: CreateTaskOptions = {},
): Task {
  const statusMessage = mcpTaskStatusMessage(task);
  return {
    taskId: task.taskId,
    status: toMcpTaskStatus(task),
    ttl: options.ttl ?? null,
    createdAt: task.createdAt,
    lastUpdatedAt: task.updatedAt,
    ...(options.pollInterval !== undefined ? { pollInterval: options.pollInterval } : {}),
    ...(statusMessage ? { statusMessage } : {}),
  };
}

function mcpTaskStatusMessage(
  task: Pick<OrchestrationTaskRecord, "summary"> & Partial<Pick<OrchestrationTaskRecord, "lastProgressAt" | "lastProgressSummary">>,
): string | undefined {
  const lines = [
    task.summary.trim().length > 0 ? task.summary : "",
    task.lastProgressSummary ? `Latest progress: ${task.lastProgressSummary}` : "",
    task.lastProgressAt ? `Last progress at: ${task.lastProgressAt}` : "",
  ].filter((line) => line.trim().length > 0);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function toMcpTaskStatus(
  task: Pick<OrchestrationTaskRecord, "status"> & Partial<Pick<OrchestrationTaskRecord, "reviewPending">>,
): Task["status"] {
  if (task.reviewPending !== undefined) return "input_required";
  if (task.status === "completed") return "completed";
  if (task.status === "failed") return "failed";
  if (task.status === "cancelled") return "cancelled";
  if (
    task.status === "needs_confirmation"
    || task.status === "blocked"
    || task.status === "waiting_for_human"
  ) {
    return "input_required";
  }
  return "working";
}

function normalizeCreateTaskOptions(options: CreateTaskOptions): CreateTaskOptions {
  return {
    ttl: options.ttl ?? null,
    ...(options.pollInterval !== undefined ? { pollInterval: options.pollInterval } : {}),
  };
}

async function resolveMcpIdentity(server: Server, options: XacpxMcpServerOptions): Promise<XacpxMcpIdentity> {
  if (options.resolveIdentity) {
    return await options.resolveIdentity({
      clientName: server.getClientVersion()?.name,
      listRoots: async () => (await server.listRoots()).roots,
    });
  }
  if (options.coordinatorSession) {
    return {
      coordinatorSession: options.coordinatorSession,
      ...(options.sourceHandle ? { sourceHandle: options.sourceHandle } : {}),
      ...(options.isExternalCoordinator ? { isExternalCoordinator: true } : {}),
      ...(options.internalSessionTools ? { internalSessionTools: true } : {}),
    };
  }
  throw new McpError(
    ErrorCode.InvalidRequest,
    "xacpx MCP identity is not configured; run through `xacpx mcp-stdio` or provide --coordinator-session",
  );
}

interface McpShutdownEventSource {
  on(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
  off(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
}

type McpShutdownSignalSource = Pick<NodeJS.Process, "on" | "off">;

type McpIntervalHandle = ReturnType<typeof setInterval>;

export interface McpStdioShutdownHookOptions {
  stdin: McpShutdownEventSource;
  stdout: McpShutdownEventSource;
  shutdown: () => void | Promise<void>;
  platform?: NodeJS.Platform;
  parentPid?: number;
  parentCheckIntervalMs?: number;
  signalSource?: McpShutdownSignalSource;
  isProcessRunning?: (pid: number) => boolean;
  /**
   * Liveness probe for the orchestration daemon this bridge proxies to. Returns
   * false ONLY when the endpoint definitively has no listener (ECONNREFUSED /
   * ENOENT); a successful connect or any ambiguous error returns true. The bridge
   * is useless once the daemon is gone, so a sustained run of false results means
   * it should exit. Targets the daemon directly — unlike the parent-pid poll,
   * which on Windows watches the cmd/.cmd shim wrapper (alive as long as the
   * bridge itself), so it can never fire there.
   */
  probeEndpoint?: () => Promise<boolean>;
  endpointCheckIntervalMs?: number;
  /** Consecutive no-listener probes required before shutting down. Conservative
   * debounce against transient blips: a live daemon resets the counter. */
  endpointFailureThreshold?: number;
  setIntervalFn?: (callback: () => void, ms: number) => McpIntervalHandle;
  clearIntervalFn?: (handle: McpIntervalHandle) => void;
  onDiagnostic?: (event: string, context?: Record<string, unknown>) => void;
}

export function installMcpStdioShutdownHooks(options: McpStdioShutdownHookOptions): () => void {
  const platform = options.platform ?? process.platform;
  const signalSource = options.signalSource ?? process;
  const isProcessRunning = options.isProcessRunning ?? defaultIsProcessRunning;
  const setIntervalFn = options.setIntervalFn ?? ((callback, ms) => setInterval(callback, ms));
  const clearIntervalFn = options.clearIntervalFn ?? ((handle) => clearInterval(handle));
  const parentPid = options.parentPid ?? process.ppid;
  const parentCheckIntervalMs = options.parentCheckIntervalMs ?? parseIntervalMs(coreEnv("MCP_PARENT_CHECK_INTERVAL_MS"), 5_000);
  const endpointCheckIntervalMs = options.endpointCheckIntervalMs ?? parseIntervalMs(coreEnv("MCP_ENDPOINT_CHECK_INTERVAL_MS"), 10_000);
  const endpointFailureThreshold = options.endpointFailureThreshold ?? 3;

  let disposed = false;
  let triggered = false;
  const triggerShutdown = (reason: string, context?: Record<string, unknown>) => {
    if (disposed || triggered) return;
    // Mark triggered (not disposed) before dispatching so concurrent events
    // (stdin.close + stdout.error in the same tick, redundant signal handlers)
    // don't each re-enter and produce duplicate diagnostics. runXacpxMcpServer
    // protects shutdown() itself via shuttingDown; this flag owns the
    // diagnostic stream only and leaves the cleanup function free to release
    // listeners and the parent timer.
    triggered = true;
    options.onDiagnostic?.("mcp.stdio.shutdown", { reason, ...(context ?? {}) });
    void options.shutdown();
  };
  const onStreamEnd = () => triggerShutdown("stdin.end");
  const onStreamClose = () => triggerShutdown("stdin.close");
  const onStdinError = (error: unknown) => triggerShutdown("stdin.error", errorContext(error));
  const onStdoutError = (error: unknown) => triggerShutdown("stdout.error", errorContext(error));
  const onSignal = (signal: NodeJS.Signals) => triggerShutdown("signal", { signal });

  options.stdin.on("end", onStreamEnd);
  options.stdin.on("close", onStreamClose);
  options.stdin.on("error", onStdinError);
  options.stdout.on("error", onStdoutError);

  const signals: NodeJS.Signals[] = platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  const signalListeners = signals.map((signal) => ({ signal, listener: () => onSignal(signal) }));
  for (const { signal, listener } of signalListeners) {
    signalSource.on(signal, listener);
  }

  let parentTimer: McpIntervalHandle | undefined;
  if (parentPid > 1 && parentCheckIntervalMs > 0) {
    parentTimer = setIntervalFn(() => {
      if (!isProcessRunning(parentPid)) {
        triggerShutdown("parent_dead", { parentPid });
      }
    }, parentCheckIntervalMs);
    parentTimer.unref?.();
  }

  let endpointTimer: McpIntervalHandle | undefined;
  const probeEndpoint = options.probeEndpoint;
  if (probeEndpoint && endpointCheckIntervalMs > 0 && endpointFailureThreshold > 0) {
    let consecutiveDead = 0;
    let probing = false;
    const runEndpointCheck = async (): Promise<void> => {
      // Skip while shutting down, or if a prior probe is still in flight (a slow
      // connect must not let checks pile up or fire concurrently).
      if (disposed || triggered || probing) return;
      probing = true;
      try {
        if (await probeEndpoint()) {
          consecutiveDead = 0;
          return;
        }
        consecutiveDead += 1;
        if (consecutiveDead >= endpointFailureThreshold) {
          triggerShutdown("daemon_endpoint_dead", { consecutiveFailures: consecutiveDead });
        }
      } catch {
        // Probe threw unexpectedly: treat as inconclusive (neither a live daemon
        // nor a definitive no-listener), so it can never by itself cause a
        // shutdown. The counter is left unchanged.
      } finally {
        probing = false;
      }
    };
    endpointTimer = setIntervalFn(runEndpointCheck, endpointCheckIntervalMs);
    endpointTimer.unref?.();
  }

  return () => {
    if (disposed) return;
    disposed = true;
    options.stdin.off("end", onStreamEnd);
    options.stdin.off("close", onStreamClose);
    options.stdin.off("error", onStdinError);
    options.stdout.off("error", onStdoutError);
    for (const { signal, listener } of signalListeners) {
      signalSource.off(signal, listener);
    }
    if (parentTimer) {
      clearIntervalFn(parentTimer);
    }
    if (endpointTimer) {
      clearIntervalFn(endpointTimer);
    }
  };
}

function parseIntervalMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function errorContext(error: unknown): Record<string, unknown> {
  const record = error as { code?: unknown; message?: unknown } | undefined;
  return {
    ...(typeof record?.code === "string" ? { code: record.code } : {}),
    ...(typeof record?.message === "string" ? { message: record.message } : {}),
  };
}

function defaultIsProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code;
    return code !== "ESRCH";
  }
}

export async function runXacpxMcpServer(options: {
  endpoint?: OrchestrationIpcEndpoint;
  transport?: XacpxMcpTransport;
  coordinatorSession?: string;
  sourceHandle?: string;
  internalSessionTools?: boolean;
  resolveIdentity?: XacpxMcpServerOptions["resolveIdentity"];
  availableAgents?: string[];
  onDiagnostic?: (event: string, context?: Record<string, unknown>) => void;
}): Promise<void> {
  const endpoint = options.endpoint ?? resolveDefaultOrchestrationEndpoint(process.env, process.platform);
  const transport = options.transport ?? createOrchestrationTransport(endpoint);
  const server = createXacpxMcpServer({
    transport,
    ...(options.coordinatorSession ? { coordinatorSession: options.coordinatorSession } : {}),
    ...(options.sourceHandle ? { sourceHandle: options.sourceHandle } : {}),
    ...(options.internalSessionTools ? { internalSessionTools: true } : {}),
    ...(options.resolveIdentity ? { resolveIdentity: options.resolveIdentity } : {}),
    ...(options.availableAgents ? { availableAgents: options.availableAgents } : {}),
  });
  const stdio = new StdioServerTransport(stdin, stdout);

  let cleanupShutdownHooks: (() => void) | undefined;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    cleanupShutdownHooks?.();
    options.onDiagnostic?.("mcp.stdio.stopping");
    // Force-exit fallback: if server.close() / stdio.close() hangs (e.g. an
    // orphaned RPC waiting on a wedged daemon), bail after 3s so the parent
    // process never sees a lingering child.
    const forceExit = setTimeout(() => process.exit(0), 3000);
    forceExit.unref();
    try {
      await server.close();
      await stdio.close();
    } catch {
      // ignore errors during shutdown
    }
    clearTimeout(forceExit);
    options.onDiagnostic?.("mcp.stdio.stopped");
    process.exit(0);
  };

  options.onDiagnostic?.("mcp.stdio.start", { parentPid: process.ppid, platform: process.platform });
  cleanupShutdownHooks = installMcpStdioShutdownHooks({
    stdin,
    stdout,
    shutdown,
    probeEndpoint: () => canConnectToEndpoint(endpoint.path, 4_000),
    onDiagnostic: options.onDiagnostic,
  });

  await server.connect(stdio);
}

function normalizeInputSchemaJson(schema: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...schema };
  delete normalized.$schema;
  return normalized;
}

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "arguments";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
