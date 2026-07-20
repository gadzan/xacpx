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
  type BridgeResponse,
} from "../transport/acpx-bridge/acpx-bridge-protocol";
import { PromptCommandError } from "../transport/prompt-output";
import type { PromptMedia, PromptMediaInput } from "../transport/types";
import { BridgeRequestScheduler, type BridgeRequestLane } from "./bridge-request-scheduler";
import { BridgeRuntime, CommandTimeoutError, EnsureSessionFailedError } from "./bridge-runtime";

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
  "setMode",
  "setModel",
  "getSessionModel",
  "cancel",
  "removeSession",
  "deleteSession",
  "freeWarmProcess",
  "getAgentSessionId",
]);

const SESSION_SCOPED_METHODS = new Set<BridgeMethod>([
  "hasSession",
  "ensureSession",
  "tailSessionHistory",
  "resumeAgentSession",
  "prompt",
  "setMode",
  "setModel",
  "getSessionModel",
  "cancel",
  "removeSession",
  "deleteSession",
  "freeWarmProcess",
  "getAgentSessionId",
]);

export class BridgeServer {
  private readonly scheduler = new BridgeRequestScheduler();

  constructor(private readonly runtime: BridgeRuntime) {}

  async handleLine(line: string, writeLine?: (line: string) => void): Promise<string> {
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
      return `${JSON.stringify({
        id: requestId,
        ok: false,
        error: {
          code: error instanceof BridgeInvalidRequestError ? "BRIDGE_INVALID_REQUEST" : "BRIDGE_INTERNAL_ERROR",
          message,
          ...ensureSessionFields,
          ...promptDetails,
          ...timeoutDetails,
        },
      } satisfies BridgeResponse)}\n`;
    }
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

    const lane: BridgeRequestLane = method === "cancel" ? "control" : "normal";
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
        return await this.runtime.shutdown();
      case "updatePermissionPolicy":
        return await this.runtime.updatePermissionPolicy({
          permissionMode: requirePermissionMode(params, "permissionMode"),
          nonInteractivePermissions: requireNonInteractivePermissions(params, "nonInteractivePermissions"),
          permissionPolicy: asOptionalString(params.permissionPolicy),
        });
      case "hasSession":
        return await this.runtime.hasSession({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
        });
      case "tailSessionHistory":
        return await this.runtime.tailSessionHistory({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
          lines: requirePositiveInt(params, "lines"),
        });
      case "listAgentSessions":
        return await this.runtime.listAgentSessions({
          agent: requireString(params, "agent"),
          agentCommand: asOptionalString(params.agentCommand),
          driver: asOptionalString(params.driver),
          settingsPolicy: asOptionalClaudeSettingsPolicy(params.settingsPolicy),
          cwd: requireString(params, "cwd"),
          cursor: asOptionalString(params.cursor),
          filterCwd: asOptionalString(params.filterCwd),
        });
      case "ensureSession":
        return await this.runtime.ensureSession({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
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
        return await this.runtime.prompt({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
          model: asOptionalString(params.model),
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
      case "resumeAgentSession":
        return await this.runtime.resumeAgentSession({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
          agentSessionId: requireString(params, "agentSessionId"),
        });
      case "setMode":
        return await this.runtime.setMode({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
          modeId: requireString(params, "modeId"),
        });
      case "setModel":
        return await this.runtime.setModel({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
          modelId: requireString(params, "modelId"),
        });
      case "getSessionModel":
        return await this.runtime.getSessionModel({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
        });
      case "cancel":
        return await this.runtime.cancel({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
        });
      case "removeSession":
        return await this.runtime.removeSession({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
        });
      case "deleteSession":
        return await this.runtime.deleteSession({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
        });
      case "freeWarmProcess":
        return await this.runtime.freeWarmProcess({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
        });
      case "getAgentSessionId":
        return await this.runtime.getAgentSessionId({
          agent: requireString(params, "agent"),
          ...agentExecutionSettings(params),
          agentCommand: asOptionalString(params.agentCommand),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
        });
      default:
        throw new Error(`unsupported bridge method: ${method}`);
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

function agentExecutionSettings(params: Record<string, unknown>) {
  return {
    driver: asOptionalString(params.driver),
    settingsPolicy: asOptionalClaudeSettingsPolicy(params.settingsPolicy),
  };
}

function asOptionalClaudeSettingsPolicy(
  value: unknown,
): "provider-only" | "isolated" | "full-user" | undefined {
  if (value === undefined) return undefined;
  if (value === "provider-only" || value === "isolated" || value === "full-user") return value;
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
