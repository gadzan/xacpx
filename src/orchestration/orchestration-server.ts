import { chmod, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";

import {
  encodeOrchestrationRpcResponse,
  type OrchestrationIpcEndpoint,
  type OrchestrationRpcHandlers,
  type OrchestrationRpcMethod,
  type OrchestrationRpcRequest,
} from "./orchestration-ipc";
import type {
  CancelTaskInput,
  CoordinatorTaskQuestionRef,
  OrchestrationTaskFilter,
  RecordWorkerReplyInput,
  RegisterExternalCoordinatorInput,
  RequestDelegateRpcInput,
  WatchTaskInput,
  WorkerRaiseQuestionInput,
} from "./orchestration-service";
import {
  MAX_TASK_WATCH_POLL_INTERVAL_MS,
  MAX_TASK_WATCH_TIMEOUT_MS,
} from "./task-watch-timeouts";
import { sameCoordinatorSession } from "./coordinator-identity";
import { canConnectToEndpoint } from "./endpoint-probe";
import type { ScheduledCreateFromRouteInput } from "../scheduled/scheduled-route-create";
import type {
  ScheduledCancelFromRouteInput,
  ScheduledListFromRouteInput,
} from "../scheduled/scheduled-route-manage";
import type { ScheduledTaskRecord } from "../scheduled/scheduled-types";
import type { AgentMessageRouter } from "./agent-message-router";
import type { AgentTargetSelector } from "./agent-messaging-types";
import { AgentMessagingError } from "./agent-messaging-error";
class OrchestrationInvalidRequestError extends Error {}

const ORCHESTRATION_RPC_METHODS = new Set<OrchestrationRpcMethod>([
  "agent.list",
  "agent.send",
  "coordinator.register_external",
  "delegate.request",
  "task.get",
  "task.list",
  "task.watch",
  "task.approve",
  "task.cancel",
  "worker.reply",
  "worker.raise_question",
  "coordinator.answer_question",
  "coordinator.retract_answer",
  "coordinator.request_human_input",
  "coordinator.review_contested_result",
  "scheduled.create",
  "scheduled.list",
  "scheduled.cancel",
  "group.new",
]);

interface OrchestrationServerDeps {
  createServer?: typeof createServer;
  removeFile?: (path: string) => Promise<void>;
  chmodFile?: (path: string, mode: number) => Promise<void>;
  /** Best-effort socket chmod failures are reported here instead of thrown. */
  onSocketHardenError?: (error: unknown) => void;
  createScheduledTaskFromRoute?: (input: ScheduledCreateFromRouteInput) => Promise<ScheduledTaskRecord>;
  listScheduledTasksFromRoute?: (input: ScheduledListFromRouteInput) => Promise<ScheduledTaskRecord[]>;
  cancelScheduledTaskFromRoute?: (input: ScheduledCancelFromRouteInput) => Promise<{ id: string; cancelled: boolean }>;
  agentMessaging?: Pick<AgentMessageRouter, "listReachable" | "send">;
}

export class OrchestrationServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private started = false;

  constructor(
    readonly endpoint: OrchestrationIpcEndpoint,
    private readonly handlers: OrchestrationRpcHandlers,
    private readonly deps: OrchestrationServerDeps = {},
  ) {}

  async start(): Promise<void> {
    await this.stop();

    if (this.endpoint.kind === "unix" && (await canConnectToEndpoint(this.endpoint.path))) {
      throw new Error(`orchestration endpoint is already in use: ${this.endpoint.path}`);
    }

    const factory = this.deps.createServer ?? createServer;
    this.server = factory((socket) => {
      this.sockets.add(socket);
      socket.setEncoding("utf8");
      let buffer = "";

      socket.on("data", (chunk: string | Buffer) => {
        buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line.length > 0) {
            void this.handleSocketLine(socket, line);
          }
          newlineIndex = buffer.indexOf("\n");
        }
      });

      socket.on("close", () => {
        this.sockets.delete(socket);
      });

      socket.on("error", () => {
        this.sockets.delete(socket);
      });
    });

    await this.listenWithUnixSocketRecovery();
    await this.hardenUnixSocketPermissions();
    this.started = true;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;

    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();

    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error && !isServerNotRunningError(error)) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }

    if (this.started) {
      this.started = false;
      await this.cleanupEndpoint();
    }
  }

  async handleLine(line: string): Promise<string> {
    let requestId = extractRequestId(line);
    let requestMethod: OrchestrationRpcMethod | undefined;

    try {
      const request = parseRequest(line);
      requestId = request.id;
      requestMethod = request.method;
      const result = await this.dispatch(request.method, request.params);
      return encodeOrchestrationRpcResponse({ id: request.id, ok: true, result });
    } catch (error) {
      return encodeOrchestrationRpcResponse({
        id: requestId,
        ok: false,
        error: {
          code:
            error instanceof OrchestrationInvalidRequestError
              ? "ORCHESTRATION_INVALID_REQUEST"
              : isAgentMessagingMethod(requestMethod) && error instanceof AgentMessagingError
                ? error.code
                : "ORCHESTRATION_INTERNAL_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async handleSocketLine(socket: Socket, line: string): Promise<void> {
    const response = await this.handleLine(line);
    if (!socket.destroyed) {
      socket.write(response);
    }
  }

  private async dispatch(method: OrchestrationRpcMethod, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "agent.list": {
        requireOnlyKeys(params, ["coordinatorSession", "sourceHandle"], "params");
        const sourceHandle = requireOptionalString(params, "sourceHandle");
        const binding = {
          coordinatorSession: requireString(params, "coordinatorSession"),
          ...(sourceHandle !== undefined ? { sourceHandle } : {}),
        };
        const agentMessaging = this.deps.agentMessaging;
        if (!agentMessaging) {
          throw new Error("agent messaging is not configured");
        }
        return await agentMessaging.listReachable(binding);
      }
      case "agent.send": {
        requireOnlyKeys(
          params,
          ["coordinatorSession", "sourceHandle", "to", "selector", "message", "mode", "replyTo", "completion"],
          "params",
        );
        const sourceHandle = requireOptionalString(params, "sourceHandle");
        const to = requireOptionalString(params, "to");
        const selectorRaw = requireOptionalObject(params, "selector");
        let selector: AgentTargetSelector | undefined;
        if (selectorRaw !== undefined) {
          requireOnlyKeys(selectorRaw, ["displayName", "workspace", "agent"], "selector");
          const displayName = requireOptionalString(selectorRaw, "displayName");
          const workspace = requireOptionalString(selectorRaw, "workspace");
          const agent = requireOptionalString(selectorRaw, "agent");
          selector = {
            ...(displayName !== undefined ? { displayName } : {}),
            ...(workspace !== undefined ? { workspace } : {}),
            ...(agent !== undefined ? { agent } : {}),
          };
        }
        if (to === undefined && selector === undefined) {
          throw new OrchestrationInvalidRequestError("agent.send requires to or selector");
        }
        if (to !== undefined && selector !== undefined) {
          throw new OrchestrationInvalidRequestError("agent.send requires to or selector, not both");
        }
        const mode = requireOptionalEnum(params, "mode", ["auto", "steer", "queue", "interrupt"]);
        const replyTo = requireOptionalString(params, "replyTo");
        const completion = requireOptionalEnum(params, "completion", ["none", "notify", "result"]);
        const binding = {
          coordinatorSession: requireString(params, "coordinatorSession"),
          ...(sourceHandle !== undefined ? { sourceHandle } : {}),
        };
        const input = {
          ...(to !== undefined ? { to } : {}),
          ...(selector !== undefined ? { selector } : {}),
          content: requireString(params, "message"),
          ...(mode !== undefined ? { mode } : {}),
          ...(replyTo !== undefined ? { replyTo } : {}),
          ...(completion !== undefined ? { completion } : {}),
        };
        const agentMessaging = this.deps.agentMessaging;
        if (!agentMessaging) {
          throw new Error("agent messaging is not configured");
        }
        return await agentMessaging.send(binding, input);
      }
      case "coordinator.register_external":
        return await this.handlers.registerExternalCoordinator(this.parseRegisterExternalCoordinatorInput(params));
      case "delegate.request":
        return await this.handlers.requestDelegate(this.parseRequestDelegateRpcInput(params));
      case "task.get":
        return await this.dispatchTaskGet(params);
      case "task.list":
        return await this.handlers.listTasks(this.parseTaskListFilter(params));
      case "task.watch":
        return await this.handlers.watchTask(this.parseWatchTaskInput(params));
      case "task.approve":
        requireOnlyKeys(params, ["taskId", "coordinatorSession"], "params");
        return await this.handlers.approveTask({
          taskId: requireString(params, "taskId"),
          coordinatorSession: requireString(params, "coordinatorSession"),
        });
      // Ownership is validated inside the service layer (requestTaskCancellation
      // checks coordinatorSession) rather than extracted here — the cancel input
      // shape carries its own identity, unlike task.get which uses a dedicated
      // coordinator-scoped wrapper.
      case "task.cancel":
        return await this.handlers.cancelTask(this.parseCancelTaskInput(params));
      case "worker.reply":
        await this.handlers.recordWorkerReply(this.parseRecordWorkerReplyInput(params));
        return { accepted: true };
      case "worker.raise_question":
        return await this.handlers.workerRaiseQuestion(this.parseWorkerRaiseQuestionInput(params));
      case "coordinator.answer_question":
        requireOnlyKeys(params, ["coordinatorSession", "taskId", "questionId", "answer"], "params");
        return await this.handlers.coordinatorAnswerQuestion({
          coordinatorSession: requireString(params, "coordinatorSession"),
          taskId: requireString(params, "taskId"),
          questionId: requireString(params, "questionId"),
          answer: requireString(params, "answer"),
        });
      case "coordinator.retract_answer":
        requireOnlyKeys(params, ["coordinatorSession", "taskId", "questionId"], "params");
        return await this.handlers.coordinatorRetractAnswer({
          coordinatorSession: requireString(params, "coordinatorSession"),
          taskId: requireString(params, "taskId"),
          questionId: requireString(params, "questionId"),
        });
      case "coordinator.request_human_input":
        {
          requireOnlyKeys(params, ["coordinatorSession", "taskQuestions", "promptText", "expectedActivePackageId"], "params");
          const expectedActivePackageId = requireOptionalString(params, "expectedActivePackageId");
        return await this.handlers.coordinatorRequestHumanInput({
          coordinatorSession: requireString(params, "coordinatorSession"),
          taskQuestions: requireTaskQuestions(params, "taskQuestions"),
          promptText: requireString(params, "promptText"),
          ...(expectedActivePackageId !== undefined ? { expectedActivePackageId } : {}),
        });
        }
      case "coordinator.review_contested_result":
        requireOnlyKeys(params, ["coordinatorSession", "taskId", "reviewId", "decision"], "params");
        return await this.handlers.coordinatorReviewContestedResult({
          coordinatorSession: requireString(params, "coordinatorSession"),
          taskId: requireString(params, "taskId"),
          reviewId: requireString(params, "reviewId"),
          decision: requireEnum(params, "decision", ["accept", "discard"]),
        });
      case "scheduled.create":
        return await this.dispatchScheduledCreate(params);
      case "scheduled.list":
        return await this.dispatchScheduledList(params);
      case "scheduled.cancel":
        return await this.dispatchScheduledCancel(params);
      case "group.new":
        requireOnlyKeys(params, ["coordinatorSession", "title"], "params");
        return await this.handlers.createGroup({
          coordinatorSession: requireString(params, "coordinatorSession"),
          title: requireString(params, "title"),
        });
      default:
        throw new OrchestrationInvalidRequestError(`unsupported orchestration method: ${method}`);
    }
  }


  private async dispatchScheduledCreate(params: Record<string, unknown>): Promise<ScheduledTaskRecord> {
    const input = this.parseScheduledCreateInput(params);
    const handler = this.deps.createScheduledTaskFromRoute ?? this.handlers.createScheduledTaskFromRoute;
    if (!handler) {
      throw new Error("scheduled task creation is not configured");
    }
    return await handler(input);
  }

  private parseScheduledCreateInput(params: Record<string, unknown>): ScheduledCreateFromRouteInput {
    requireOnlyKeys(params, ["coordinatorSession", "timeText", "message", "mode"], "params");
    const mode = requireOptionalEnum(params, "mode", ["temp", "bound"]);
    return {
      coordinatorSession: requireString(params, "coordinatorSession"),
      timeText: requireString(params, "timeText"),
      message: requireString(params, "message"),
      ...(mode !== undefined ? { mode } : {}),
    };
  }

  private async dispatchScheduledList(params: Record<string, unknown>): Promise<ScheduledTaskRecord[]> {
    requireOnlyKeys(params, ["coordinatorSession"], "params");
    const input: ScheduledListFromRouteInput = {
      coordinatorSession: requireString(params, "coordinatorSession"),
    };
    const handler = this.deps.listScheduledTasksFromRoute ?? this.handlers.listScheduledTasksFromRoute;
    if (!handler) {
      throw new Error("scheduled task listing is not configured");
    }
    return await handler(input);
  }

  private async dispatchScheduledCancel(params: Record<string, unknown>): Promise<{ id: string; cancelled: boolean }> {
    requireOnlyKeys(params, ["coordinatorSession", "id"], "params");
    const input: ScheduledCancelFromRouteInput = {
      coordinatorSession: requireString(params, "coordinatorSession"),
      id: requireString(params, "id"),
    };
    const handler = this.deps.cancelScheduledTaskFromRoute ?? this.handlers.cancelScheduledTaskFromRoute;
    if (!handler) {
      throw new Error("scheduled task cancellation is not configured");
    }
    return await handler(input);
  }

  private parseRegisterExternalCoordinatorInput(params: Record<string, unknown>): RegisterExternalCoordinatorInput {
    requireOnlyKeys(params, ["coordinatorSession", "workspace", "defaultTargetAgent"], "params");
    const workspace = requireOptionalString(params, "workspace");
    const defaultTargetAgent = requireOptionalString(params, "defaultTargetAgent");
    return {
      coordinatorSession: requireString(params, "coordinatorSession"),
      ...(workspace !== undefined ? { workspace } : {}),
      ...(defaultTargetAgent !== undefined ? { defaultTargetAgent } : {}),
    };
  }

  private async dispatchTaskGet(params: Record<string, unknown>) {
    requireOnlyKeys(params, ["taskId", "coordinatorSession"], "params");
    const taskId = requireString(params, "taskId");
    const coordinatorSession = requireString(params, "coordinatorSession");
    const task = await this.handlers.getTask(taskId);
    if (!task) {
      return null;
    }
    if (!sameCoordinatorSession(task.coordinatorSession, coordinatorSession)) {
      return null;
    }
    return task;
  }

  private parseRequestDelegateRpcInput(params: Record<string, unknown>): RequestDelegateRpcInput {
    requireOnlyKeys(params, ["sourceHandle", "targetAgent", "task", "cwd", "role", "groupId", "parallel"], "params");
    const cwd = requireOptionalString(params, "cwd");
    const role = requireOptionalString(params, "role");
    const groupId = requireOptionalString(params, "groupId");
    const parallel = requireOptionalBoolean(params, "parallel");
    return {
      sourceHandle: requireString(params, "sourceHandle"),
      targetAgent: requireString(params, "targetAgent"),
      task: requireString(params, "task"),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(groupId !== undefined ? { groupId } : {}),
      ...(parallel !== undefined ? { parallel } : {}),
    };
  }

  private parseTaskListFilter(params: Record<string, unknown>): OrchestrationTaskFilter {
    requireOnlyKeys(params, ["filter"], "params");
    const filter = requireOptionalObject(params, "filter");
    if (!filter) {
      throw new OrchestrationInvalidRequestError("filter must include coordinatorSession");
    }
    requireOnlyKeys(filter, ["coordinatorSession", "status", "stuck", "sort", "order"], "filter");
    const status = requireOptionalEnum(filter, "status", [
      "needs_confirmation",
      "running",
      "blocked",
      "waiting_for_human",
      "completed",
      "failed",
      "cancelled",
    ]);
    const stuck = requireOptionalBoolean(filter, "stuck");
    const sort = requireOptionalEnum(filter, "sort", ["updatedAt", "createdAt"]);
    const order = requireOptionalEnum(filter, "order", ["asc", "desc"]);
    return {
      coordinatorSession: requireString(filter, "coordinatorSession"),
      ...(status !== undefined ? { status } : {}),
      ...(stuck !== undefined ? { stuck } : {}),
      ...(sort !== undefined ? { sort } : {}),
      ...(order !== undefined ? { order } : {}),
    };
  }

  private parseCancelTaskInput(params: Record<string, unknown>): CancelTaskInput {
    requireOnlyKeys(params, ["taskId", "sourceHandle", "coordinatorSession"], "params");
    const sourceHandle = requireOptionalString(params, "sourceHandle");
    const coordinatorSession = requireOptionalString(params, "coordinatorSession");
    if (sourceHandle === undefined && coordinatorSession === undefined) {
      throw new OrchestrationInvalidRequestError("task.cancel requires sourceHandle or coordinatorSession");
    }
    return {
      taskId: requireString(params, "taskId"),
      ...(sourceHandle !== undefined ? { sourceHandle } : {}),
      ...(coordinatorSession !== undefined ? { coordinatorSession } : {}),
    };
  }

  private parseRecordWorkerReplyInput(params: Record<string, unknown>): RecordWorkerReplyInput {
    requireOnlyKeys(params, ["taskId", "sourceHandle", "status", "summary", "resultText"], "params");
    const status = requireOptionalEnum(params, "status", ["completed", "failed", "cancelled"]);
    const summary = requireOptionalString(params, "summary");
    const resultText = requireOptionalString(params, "resultText");
    return {
      taskId: requireString(params, "taskId"),
      sourceHandle: requireString(params, "sourceHandle"),
      ...(status !== undefined ? { status } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(resultText !== undefined ? { resultText } : {}),
    };
  }


  private parseWatchTaskInput(params: Record<string, unknown>): WatchTaskInput {
    requireOnlyKeys(params, ["coordinatorSession", "taskId", "afterSeq", "mode", "includeProgress", "timeoutMs", "pollIntervalMs"], "params");
    const afterSeq = requireOptionalIntegerInRange(params, "afterSeq", 0, Number.MAX_SAFE_INTEGER);
    const mode = requireOptionalEnum(params, "mode", ["next_event", "until_attention_or_terminal"]);
    const includeProgress = requireOptionalBoolean(params, "includeProgress");
    const timeoutMs = requireOptionalIntegerInRange(params, "timeoutMs", 0, MAX_TASK_WATCH_TIMEOUT_MS);
    const pollIntervalMs = requireOptionalIntegerInRange(params, "pollIntervalMs", 1, MAX_TASK_WATCH_POLL_INTERVAL_MS);
    return {
      coordinatorSession: requireString(params, "coordinatorSession"),
      taskId: requireString(params, "taskId"),
      ...(afterSeq !== undefined ? { afterSeq } : {}),
      ...(mode !== undefined ? { mode } : {}),
      ...(includeProgress !== undefined ? { includeProgress } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
    };
  }

  private parseWorkerRaiseQuestionInput(params: Record<string, unknown>): WorkerRaiseQuestionInput {
    requireOnlyKeys(params, ["taskId", "sourceHandle", "question", "whyBlocked", "whatIsNeeded"], "params");
    return {
      taskId: requireString(params, "taskId"),
      sourceHandle: requireString(params, "sourceHandle"),
      question: requireString(params, "question"),
      whyBlocked: requireString(params, "whyBlocked"),
      whatIsNeeded: requireString(params, "whatIsNeeded"),
    };
  }

  /**
   * The RPC surface has no authentication: anything that can connect can drive
   * agents. Trust therefore rests entirely on filesystem permissions — chmod
   * the unix socket to owner-only (0600) right after listen() creates it.
   * Windows named pipes are skipped: POSIX modes do not apply and the default
   * pipe DACL already restricts access to the creating user/session.
   */
  private async hardenUnixSocketPermissions(): Promise<void> {
    if (this.endpoint.kind !== "unix") {
      return;
    }

    const chmodFile = this.deps.chmodFile ?? chmod;
    try {
      await chmodFile(this.endpoint.path, 0o600);
    } catch (error) {
      // Best-effort: a failed chmod must not take the daemon down.
      this.deps.onSocketHardenError?.(error);
    }
  }

  private async cleanupEndpoint(): Promise<void> {
    if (this.endpoint.kind !== "unix") {
      return;
    }

    const removeFile = this.deps.removeFile ?? (async (path: string) => {
      await rm(path, { force: true });
    });
    await removeFile(this.endpoint.path);
  }

  private async listenWithUnixSocketRecovery(): Promise<void> {
    const server = this.server;
    if (!server) {
      throw new Error("orchestration server failed to initialize");
    }

    try {
      await listen(server, this.endpoint.path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (this.endpoint.kind !== "unix" || code !== "EADDRINUSE") {
        throw error;
      }

      const isLive = await canConnectToEndpoint(this.endpoint.path);
      if (isLive) {
        throw new Error(`orchestration endpoint is already in use: ${this.endpoint.path}`);
      }

      await this.cleanupEndpoint();
      await listen(server, this.endpoint.path);
    }
  }
}

function extractRequestId(line: string): string {
  try {
    const raw = JSON.parse(line) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return "unknown";
    }

    const id = (raw as Record<string, unknown>).id;
    return typeof id === "string" && id.length > 0 ? id : "unknown";
  } catch {
    return "unknown";
  }
}

function parseRequest(line: string): OrchestrationRpcRequest {
  let raw: unknown;

  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    throw new OrchestrationInvalidRequestError("request must be valid JSON");
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new OrchestrationInvalidRequestError("request must be a JSON object");
  }

  const request = raw as Record<string, unknown>;
  const { id, method, params } = request;

  if (typeof id !== "string" || id.length === 0) {
    throw new OrchestrationInvalidRequestError("id must be a non-empty string");
  }
  if (typeof method !== "string" || !ORCHESTRATION_RPC_METHODS.has(method as OrchestrationRpcMethod)) {
    throw new OrchestrationInvalidRequestError(`unsupported orchestration method: ${String(method)}`);
  }
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new OrchestrationInvalidRequestError("params must be an object");
  }

  return {
    id,
    method: method as OrchestrationRpcMethod,
    params: params as Record<string, unknown>,
  };
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new OrchestrationInvalidRequestError(`${key} must be a non-empty string`);
  }

  return value;
}

function requireOptionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new OrchestrationInvalidRequestError(`${key} must be a finite number when provided`);
  }
  return value;
}

function requireOptionalIntegerInRange(
  params: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = requireOptionalNumber(params, key);
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new OrchestrationInvalidRequestError(`${key} must be an integer between ${min} and ${max} when provided`);
  }
  return value;
}

function requireOptionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new OrchestrationInvalidRequestError(`${key} must be a non-empty string`);
  }
  return value;
}

function requireOptionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new OrchestrationInvalidRequestError(`${key} must be a boolean when provided`);
  }
  return value;
}

function requireOptionalEnum<const T extends readonly string[]>(
  params: Record<string, unknown>,
  key: string,
  allowed: T,
): T[number] | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new OrchestrationInvalidRequestError(
      `${key} must be one of: ${allowed.join(", ")}`,
    );
  }
  return value as T[number];
}

function requireEnum<const T extends readonly string[]>(
  params: Record<string, unknown>,
  key: string,
  allowed: T,
): T[number] {
  const value = params[key];
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new OrchestrationInvalidRequestError(`${key} must be one of: ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function requireOptionalObject(
  params: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OrchestrationInvalidRequestError(`${key} must be an object when provided`);
  }

  return value as Record<string, unknown>;
}

function requireOnlyKeys(params: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(params)) {
    if (!allowedSet.has(key)) {
      throw new OrchestrationInvalidRequestError(`${label}.${key} is not supported`);
    }
  }
}

function requireTaskQuestions(
  params: Record<string, unknown>,
  key: string,
): CoordinatorTaskQuestionRef[] {
  const value = params[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new OrchestrationInvalidRequestError(`${key} must be a non-empty array`);
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new OrchestrationInvalidRequestError(`${key}[${index}] must be an object`);
    }

    return {
      taskId: requireString(entry as Record<string, unknown>, "taskId"),
      questionId: requireString(entry as Record<string, unknown>, "questionId"),
    };
  });
}

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}

function isServerNotRunningError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ERR_SERVER_NOT_RUNNING";
}

function isAgentMessagingMethod(method: OrchestrationRpcMethod | undefined): boolean {
  return method === "agent.list" || method === "agent.send";
}
