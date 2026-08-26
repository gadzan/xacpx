import {
  encodeBridgePromptPlanEvent,
  encodeBridgePromptSegmentEvent,
  encodeBridgePromptThoughtEvent,
  encodeBridgePromptToolEvent,
  encodeBridgePromptUsageEvent,
  encodeBridgePromptCommandsEvent,
  encodeBridgeSessionNoteEvent,
  encodeBridgeSessionProgressEvent,
  type BridgeMethod,
  type BridgeOriginatedMethod,
  type BridgeOriginatedParams,
  type BridgeOriginatedResponse,
  type BridgeResponse,
  encodeBridgeOriginatedMessage,
} from "../transport/acpx-bridge/acpx-bridge-protocol";
import { isClaudeSettingsPolicy, type ClaudeSettingsPolicy } from "../adapters/claude-settings-policy";
import { PromptCommandError } from "../transport/prompt-output";
import { AcpxQueueOverflowError } from "../transport/acpx-queue-overflow";
import { MessageInjectionError } from "../transport/message-injection";
import type { PromptMedia, PromptMediaInput } from "../transport/types";
import { BridgeRequestScheduler, type BridgeRequestLane } from "./bridge-request-scheduler";
import { BridgeRuntime, CommandTimeoutError, EnsureSessionFailedError } from "./bridge-runtime";
import { CliEngine } from "./engine/cli/cli-engine";
import { EngineRouter, SessionEngineBinding, type BridgeEngine } from "./engine";

interface BridgeRequest {
  id: string;
  method: BridgeMethod;
  params: Record<string, unknown>;
}

class BridgeInvalidRequestError extends Error {}

const BRIDGE_METHODS = new Set<BridgeMethod>([
  "ping",
  "shutdown",
  "updatePermissionPolicy",
  "hasSession",
  "ensureSession",
  "tailSessionHistory",
  "listAgentSessions",
  "resumeAgentSession",
  "prompt",
  "injectMessage",
  "setMode",
  "setModel",
  "getSessionModel",
  "setSessionEffort",
  "getSessionEffort",
  "cancel",
  "removeSession",
  "deleteSession",
  "freeWarmProcess",
  "isSessionWarm",
  "getAgentSessionId",
]);

const SESSION_SCOPED_METHODS = new Set<BridgeMethod>([
  "hasSession",
  "ensureSession",
  "tailSessionHistory",
  "resumeAgentSession",
  "prompt",
  "injectMessage",
  "setMode",
  "setModel",
  "getSessionModel",
  "setSessionEffort",
  "getSessionEffort",
  "cancel",
  "removeSession",
  "deleteSession",
  "freeWarmProcess",
  "isSessionWarm",
  "getAgentSessionId",
]);

export class BridgeServer {
  private readonly scheduler = new BridgeRequestScheduler();
  private nextDaemonRpcId = 1;
  private daemonWriter?: (line: string) => void;
  private readonly pendingDaemonRequests = new Map<string, {
    resolve(value: unknown): void;
    reject(error: unknown): void;
    timer: ReturnType<typeof setTimeout>;
    cleanup(): void;
  }>();

  private readonly engines: BridgeEngine;

  constructor(runtime: BridgeRuntime | BridgeEngine, private readonly daemonRequestTimeoutMs = 10_000) {
    // Any engine-capable instance works: a raw BridgeRuntime (legacy tests,
    // bridge-main) is wrapped as CliEngine behind an EngineRouter so session
    // affinity routing exists from day one.
    this.engines = runtime instanceof EngineRouter
      ? runtime
      : new EngineRouter(new SessionEngineBinding(), new CliEngine(runtime as BridgeRuntime));
  }

  async handleLine(line: string, writeLine?: (line: string) => void): Promise<string | null> {
    if (writeLine) this.daemonWriter = writeLine;
    const daemonResponse = parseDaemonOriginatedResponse(line);
    if (daemonResponse) {
      this.settleDaemonResponse(daemonResponse);
      return null;
    }
    let requestId = extractRequestId(line);

    try {
      const request = parseBridgeRequest(line);
      requestId = request.id;

      const result = await this.dispatchRequest(request.id, request.method, request.params, writeLine);
      return `${JSON.stringify({
        id: request.id,
        ok: true,
        result,
      } satisfies BridgeResponse)}\n`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const ensureSessionFields = error instanceof EnsureSessionFailedError
        ? { kind: error.kind, ...(error.data ? { data: error.data } : {}) }
        : {};
      const promptDetails = error instanceof PromptCommandError
        ? { details: { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr } }
        : {};
      const timeoutDetails = error instanceof CommandTimeoutError
        ? {
            timeout: {
              timeoutMs: error.timeoutMs,
              command: error.command,
              ...(error.stage ? { stage: error.stage } : {}),
              ...(error.stdoutTail ? { stdoutTail: error.stdoutTail } : {}),
              ...(error.stderrTail ? { stderrTail: error.stderrTail } : {}),
            },
          }
        : {};
      const errorCode = error instanceof AcpxQueueOverflowError
        ? error.code
        : error instanceof MessageInjectionError
          ? error.code
        : error instanceof BridgeInvalidRequestError
          ? "BRIDGE_INVALID_REQUEST"
          : "BRIDGE_INTERNAL_ERROR";
      return `${JSON.stringify({
        id: requestId,
        ok: false,
        error: {
          code: errorCode,
          message,
          ...ensureSessionFields,
          ...promptDetails,
          ...timeoutDetails,
        },
      } satisfies BridgeResponse)}\n`;
    }
  }

  requestDaemon<TResult, TMethod extends BridgeOriginatedMethod = BridgeOriginatedMethod>(
    method: TMethod,
    params: BridgeOriginatedParams[TMethod],
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<TResult> {
    if (!this.daemonWriter) return Promise.reject(new Error("daemon bridge RPC channel is not connected"));
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new Error("bridge RPC canceled"));
    const rpcId = `bridge:${this.nextDaemonRpcId++}`;
    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingDaemonRequests.get(rpcId);
        if (!pending) return;
        this.pendingDaemonRequests.delete(rpcId);
        pending.cleanup();
        this.daemonWriter?.(encodeBridgeOriginatedMessage({ direction: "bridge-to-daemon", cancelRpcId: rpcId }));
        reject(new Error(`bridge-originated request "${method}" timed out`));
      }, options.timeoutMs ?? this.daemonRequestTimeoutMs);
      timer.unref?.();
      const abort = () => {
        const pending = this.pendingDaemonRequests.get(rpcId);
        if (!pending) return;
        this.pendingDaemonRequests.delete(rpcId);
        pending.cleanup();
        this.daemonWriter?.(encodeBridgeOriginatedMessage({ direction: "bridge-to-daemon", cancelRpcId: rpcId }));
        reject(options.signal?.reason ?? new Error("bridge RPC canceled"));
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      };
      this.pendingDaemonRequests.set(rpcId, { resolve, reject, timer, cleanup });
      try {
        this.daemonWriter!(encodeBridgeOriginatedMessage({
          direction: "bridge-to-daemon",
          rpcId,
          method,
          params: params as unknown as Record<string, unknown>,
        }));
      } catch (error) {
        this.pendingDaemonRequests.delete(rpcId);
        cleanup();
        reject(error);
      }
    });
  }

  handleDisconnect(error: Error = new Error("daemon bridge RPC channel disconnected")): void {
    const pending = [...this.pendingDaemonRequests.values()];
    this.pendingDaemonRequests.clear();
    this.daemonWriter = undefined;
    for (const item of pending) {
      item.cleanup();
      item.reject(error);
    }
  }

  private settleDaemonResponse(response: BridgeOriginatedResponse): void {
    const pending = this.pendingDaemonRequests.get(response.rpcId);
    if (!pending) return;
    this.pendingDaemonRequests.delete(response.rpcId);
    pending.cleanup();
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error.message));
  }

  private async dispatchRequest(
    requestId: string,
    method: BridgeMethod,
    params: Record<string, unknown>,
    writeLine?: (line: string) => void,
  ): Promise<unknown> {
    if (!SESSION_SCOPED_METHODS.has(method)) {
      return await this.dispatch(requestId, method, params, writeLine);
    }

    const sessionName = getSessionName(params);
    if (!sessionName) {
      return await this.dispatch(requestId, method, params, writeLine);
    }

    const sessionKey = getSessionScheduleKey(params);
    if (!sessionKey) {
      return await this.dispatch(requestId, method, params, writeLine);
    }

    const lane: BridgeRequestLane = method === "cancel" || method === "isSessionWarm"
      ? "control"
      : method === "injectMessage"
        ? "message"
        : "normal";
    return await this.scheduler.run(sessionKey, lane, () => this.dispatch(requestId, method, params, writeLine));
  }

  private async dispatch(
    requestId: string,
    method: BridgeMethod,
    params: Record<string, unknown>,
    writeLine?: (line: string) => void,
  ): Promise<unknown> {
    switch (method) {
      case "ping":
        return {};
      case "shutdown":
        return await this.engines.shutdown();
      case "updatePermissionPolicy":
        return await this.engines.updatePermissionPolicy({
          permissionMode: requirePermissionMode(params, "permissionMode"),
          nonInteractivePermissions: requireNonInteractivePermissions(params, "nonInteractivePermissions"),
          permissionPolicy: asOptionalString(params.permissionPolicy),
        });
      case "hasSession":
        return await this.engines.hasSession({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          ...agentLaunchSelection(params),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
        });
      case "tailSessionHistory":
        return await this.engines.tailSessionHistory({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          ...agentLaunchSelection(params),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
          lines: requirePositiveInt(params, "lines"),
        });
      case "listAgentSessions":
        return await this.engines.listAgentSessions({
          agent: requireString(params, "agent"),
          agentCommand: asOptionalString(params.agentCommand),
          ...agentLaunchSelection(params),
          driver: asOptionalString(params.driver),
          settingsPolicy: asOptionalClaudeSettingsPolicy(params.settingsPolicy),
          cwd: requireString(params, "cwd"),
          cursor: asOptionalString(params.cursor),
          filterCwd: asOptionalString(params.filterCwd),
        });
      case "ensureSession":
        return await this.engines.ensureSession({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          ...agentLaunchSelection(params),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
          sessionKey: asOptionalString(params.sessionKey),
          model: asOptionalString(params.model),
          mcpCoordinatorSession: asOptionalString(params.mcpCoordinatorSession),
          mcpSourceHandle: asOptionalString(params.mcpSourceHandle),
        }, (progress) => {
          if (typeof progress === "string") {
            writeLine?.(encodeBridgeSessionProgressEvent({
              id: requestId,
              event: "session.progress",
              stage: progress,
            }));
          } else if (progress.kind === "note") {
            writeLine?.(encodeBridgeSessionNoteEvent({
              id: requestId,
              event: "session.note",
              text: progress.text,
            }));
          }
        });
      case "prompt":
        const media = asOptionalPromptMediaInput(params.media);
        const resolvedToolEventMode = asOptionalToolEventMode(params.toolEventMode);
        return await this.engines.prompt({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          ...agentLaunchSelection(params),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
          sessionKey: asOptionalString(params.sessionKey),
          model: asOptionalString(params.model),
          effort: asOptionalString(params.effort),
          mcpCoordinatorSession: asOptionalString(params.mcpCoordinatorSession),
          mcpSourceHandle: asOptionalString(params.mcpSourceHandle),
          text: requirePromptText(params, media),
          replyMode: asOptionalReplyMode(params.replyMode),
          // Keep toolEvents for back-compat with older bridge clients that don't send toolEventMode.
          toolEvents: params.toolEvents === true,
          ...(resolvedToolEventMode ? { toolEventMode: resolvedToolEventMode } : {}),
          media,
        }, (event) => {
          if (event.type === "prompt.segment") {
            writeLine?.(encodeBridgePromptSegmentEvent({
              id: requestId,
              event: "prompt.segment",
              text: event.text,
            }));
          } else if (event.type === "prompt.tool_event") {
            writeLine?.(encodeBridgePromptToolEvent({
              id: requestId,
              event: "prompt.tool_event",
              toolEvent: event.event,
            }));
          } else if (event.type === "prompt.thought") {
            writeLine?.(encodeBridgePromptThoughtEvent({
              id: requestId,
              event: "prompt.thought",
              text: event.text,
            }));
          } else if (event.type === "prompt.plan") {
            writeLine?.(encodeBridgePromptPlanEvent({
              id: requestId,
              event: "prompt.plan",
              entries: event.entries,
            }));
          } else if (event.type === "prompt.usage") {
            writeLine?.(encodeBridgePromptUsageEvent({
              id: requestId,
              event: "prompt.usage",
              used: event.used,
              size: event.size,
              ...(event.cost ? { cost: event.cost } : {}),
              ...(event.breakdown ? { breakdown: event.breakdown } : {}),
            }));
          } else if (event.type === "prompt.commands") {
            writeLine?.(encodeBridgePromptCommandsEvent({
              id: requestId,
              event: "prompt.commands",
              commands: event.commands,
            }));
          }
        });
      case "injectMessage":
        return await this.engines.injectMessage({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          ...agentLaunchSelection(params),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
          sessionKey: asOptionalString(params.sessionKey),
          model: asOptionalString(params.model),
          effort: asOptionalString(params.effort),
          mcpCoordinatorSession: asOptionalString(params.mcpCoordinatorSession),
          mcpSourceHandle: asOptionalString(params.mcpSourceHandle),
          text: requireString(params, "text"),
          mode: requireMessageMode(params, "mode"),
          messageId: requireString(params, "messageId"),
        });
      case "resumeAgentSession":
        return await this.engines.resumeAgentSession({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          ...agentLaunchSelection(params),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
          agentSessionId: requireString(params, "agentSessionId"),
        });
      case "setMode":
        return await this.engines.setMode({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          ...agentLaunchSelection(params),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
          modeId: requireString(params, "modeId"),
        });
      case "setModel":
        return await this.engines.setModel({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          ...agentLaunchSelection(params),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
          modelId: requireString(params, "modelId"),
        });
      case "getSessionModel":
        return await this.engines.getSessionModel({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          ...agentLaunchSelection(params),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
        });
      case "setSessionEffort":
        return await this.engines.setSessionEffort({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          ...agentLaunchSelection(params),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
          effort: requireString(params, "effort"),
        });
      case "getSessionEffort":
        return await this.engines.getSessionEffort({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          ...agentLaunchSelection(params),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
        });
      case "cancel":
        return await this.engines.cancel({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          ...agentLaunchSelection(params),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
        });
      case "removeSession":
        return await this.engines.removeSession({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          ...agentLaunchSelection(params),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
        });
      case "deleteSession":
        return await this.engines.deleteSession({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          ...agentLaunchSelection(params),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
        });
      case "freeWarmProcess":
        return await this.engines.freeWarmProcess({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          ...agentLaunchSelection(params),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
        });
      case "isSessionWarm":
        return await this.engines.isSessionWarm({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          ...agentLaunchSelection(params),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
        });
      case "getAgentSessionId":
        return await this.engines.getAgentSessionId({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          ...agentLaunchSelection(params),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
        });
      default:
        throw new Error(`unsupported bridge method: ${method}`);
    }
  }
}

function parseDaemonOriginatedResponse(line: string): BridgeOriginatedResponse | null {
  let value: unknown;
  try { value = JSON.parse(line); }
  catch { return null; }
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (item.direction !== "daemon-to-bridge" || typeof item.rpcId !== "string" || typeof item.ok !== "boolean") return null;
  if (item.ok === true && "result" in item) return item as unknown as BridgeOriginatedResponse;
  if (item.ok === false && item.error && typeof item.error === "object"
    && typeof (item.error as Record<string, unknown>).message === "string") return item as unknown as BridgeOriginatedResponse;
  return null;
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

function parseBridgeRequest(line: string): BridgeRequest {
  let raw: unknown;

  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    throw new BridgeInvalidRequestError("request must be valid JSON");
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BridgeInvalidRequestError("request must be a JSON object");
  }

  const request = raw as Record<string, unknown>;
  const id = request.id;
  const method = request.method;
  const params = request.params;

  if (typeof id !== "string" || id.length === 0) {
    throw new BridgeInvalidRequestError("id must be a non-empty string");
  }
  if (typeof method !== "string" || method.length === 0) {
    throw new BridgeInvalidRequestError("method must be a non-empty string");
  }
  if (!BRIDGE_METHODS.has(method as BridgeMethod)) {
    throw new BridgeInvalidRequestError(`unsupported bridge method: ${method}`);
  }
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new BridgeInvalidRequestError("params must be an object");
  }

  return {
    id,
    method: method as BridgeMethod,
    params: params as Record<string, unknown>,
  };
}

function getSessionName(params: Record<string, unknown>): string | undefined {
  return asNonEmptyString(params.name);
}

function getSessionScheduleKey(params: Record<string, unknown>): string | undefined {
  const name = asNonEmptyString(params.name);
  const cwd = asNonEmptyString(params.cwd);
  const agentIdentity = asNonEmptyString(params.agentCommand) ?? asNonEmptyString(params.agent);
  if (!name || !cwd || !agentIdentity) {
    return undefined;
  }

  return JSON.stringify([agentIdentity, cwd, name]);
}


function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  return value;
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new BridgeInvalidRequestError(`${key} must be a non-empty string`);
  }

  return value;
}

function requirePositiveInt(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new BridgeInvalidRequestError(`${key} must be a positive integer`);
  }
  return value;
}

function requirePromptText(params: Record<string, unknown>, media?: PromptMediaInput): string {
  const value = params.text;
  if (typeof value !== "string") {
    throw new BridgeInvalidRequestError("text must be a non-empty string");
  }
  const hasMedia = Array.isArray(media) ? media.length > 0 : Boolean(media);
  if (value.length === 0 && !hasMedia) {
    throw new BridgeInvalidRequestError("text must be a non-empty string unless media is provided");
  }
  return value;
}

function requireMessageMode(
  params: Record<string, unknown>,
  key: string,
): "auto" | "steer" | "queue" | "interrupt" {
  const value = params[key];
  if (value === "auto" || value === "steer" || value === "queue" || value === "interrupt") {
    return value;
  }
  throw new BridgeInvalidRequestError(key + " must be auto, steer, queue, or interrupt");
}


function requirePermissionMode(params: Record<string, unknown>, key: string): "approve-all" | "approve-reads" | "deny-all" {
  const value = params[key];
  if (value === "approve-all" || value === "approve-reads" || value === "deny-all") {
    return value;
  }

  throw new BridgeInvalidRequestError(`${key} must be approve-all, approve-reads, or deny-all`);
}

function requireNonInteractivePermissions(params: Record<string, unknown>, key: string): "deny" | "fail" {
  const value = params[key];
  if (value === "deny" || value === "fail") {
    return value;
  }

  throw new BridgeInvalidRequestError(`${key} must be deny or fail`);
}
function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  return value;
}

function asOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string")) {
    return undefined;
  }
  return [...value] as string[];
}

/** Structured launch selection (acpxAgent/rawCommand/agentArgv) carried by new
 * clients; old clients omit it and keep the legacy `--agent agentCommand` path. */
function agentLaunchSelection(params: Record<string, unknown>) {
  return {
    acpxAgent: asOptionalString(params.acpxAgent),
    rawCommand: asOptionalString(params.rawCommand),
    agentArgv: asOptionalStringArray(params.agentArgv),
  };
}

function agentExecutionSettings(params: Record<string, unknown>) {
  return {
    driver: asOptionalString(params.driver),
    settingsPolicy: asOptionalClaudeSettingsPolicy(params.settingsPolicy),
  };
}

function asOptionalClaudeSettingsPolicy(
  value: unknown,
): ClaudeSettingsPolicy | undefined {
  if (value === undefined) return undefined;
  if (isClaudeSettingsPolicy(value)) return value;
  throw new BridgeInvalidRequestError(
    "settingsPolicy must be provider-only, isolated, or full-user",
  );
}

function asOptionalPromptMediaInput(value: unknown): PromptMediaInput | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(asPromptMedia);
  return asPromptMedia(value);
}

function asPromptMedia(value: unknown): PromptMedia {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeInvalidRequestError("media must be an object or array of objects when provided");
  }
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (type !== "image" && type !== "audio" && type !== "video" && type !== "file") {
    throw new BridgeInvalidRequestError("media.type must be image, audio, video, or file");
  }
  if (typeof record.filePath !== "string" || record.filePath.trim().length === 0) {
    throw new BridgeInvalidRequestError("media.filePath must be a non-empty string");
  }
  if (typeof record.mimeType !== "string" || record.mimeType.trim().length === 0) {
    throw new BridgeInvalidRequestError("media.mimeType must be a non-empty string");
  }
  return {
    type,
    filePath: record.filePath,
    mimeType: record.mimeType,
    ...(typeof record.fileName === "string" && record.fileName ? { fileName: record.fileName } : {}),
  };
}

// Inline union — this crosses the JSON protocol boundary, validated by VALID_REPLY_MODES set.
const VALID_REPLY_MODES = new Set<string>(["stream", "final", "verbose"]);
function asOptionalReplyMode(value: unknown): "stream" | "final" | "verbose" | undefined {
  if (typeof value !== "string" || !VALID_REPLY_MODES.has(value)) {
    return undefined;
  }
  return value as "stream" | "final" | "verbose";
}

const VALID_TOOL_EVENT_MODES = new Set<string>(["text", "structured", "both"]);
function asOptionalToolEventMode(value: unknown): "text" | "structured" | "both" | undefined {
  if (typeof value !== "string" || !VALID_TOOL_EVENT_MODES.has(value)) {
    return undefined;
  }
  return value as "text" | "structured" | "both";
}
