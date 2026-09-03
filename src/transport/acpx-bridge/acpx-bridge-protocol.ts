import type { PlanEntry, ToolUseEvent } from "../../channels/types.js";
import type { AgentCommand, UsageBreakdown, UsageCost } from "../types";
import type { AcpxCommandStage } from "../command-timeouts";
import { parseCanonicalFileTime } from "../../process/windows-process-identity";

export type BridgeMethod =
  | "ping"
  | "shutdown"
  | "updatePermissionPolicy"
  | "primeRuntimeQueues"
  | "ensureSession"
  | "hasSession"
  | "tailSessionHistory"
  | "listAgentSessions"
  | "resumeAgentSession"
  | "prompt"
  | "injectMessage"
  | "setMode"
  | "setModel"
  | "getSessionModel"
  | "setSessionEffort"
  | "getSessionEffort"
  | "cancel"
  | "removeSession"
  | "deleteSession"
  | "freeWarmProcess"
  | "isSessionWarm"
  | "getAgentSessionId";

export interface BridgeRequest {
  id: string;
  method: BridgeMethod;
  params: Record<string, unknown>;
}

export type BridgeOriginatedMethod =
  | "registerAdapterIntent"
  | "launcherSpawned"
  | "cancelAdapterIntent"
  | "launchSettled"
  | "resolveAdapterCommand"
  | "resolvePermissionRequest"
  | "resolveElicitationRequest";

export interface BridgeOriginatedRequest {
  direction: "bridge-to-daemon";
  rpcId: string;
  method: BridgeOriginatedMethod;
  params: Record<string, unknown>;
}

export type BridgeOriginatedResponse =
  | { direction: "daemon-to-bridge"; rpcId: string; ok: true; result: unknown }
  | { direction: "daemon-to-bridge"; rpcId: string; ok: false; error: { code: string; message: string } };

export interface BridgeOriginatedCancel {
  direction: "bridge-to-daemon";
  cancelRpcId: string;
}

export interface RegisterAdapterIntentParams {
  id: string;
  sessionKey: string;
  agentCommand: string;
  intentToken: string;
  launcherPid: number;
  launcherCreationDate: string;
}
export interface AdapterTokenParams { id: string; sessionKey: string; intentToken: string }
export interface LaunchSettledParams extends AdapterTokenParams {
  outcome: "owner-committed" | "launch-failed";
  ownerPid?: number;
  ownerAcpxRecordId?: string;
}
export interface ResolveAdapterCommandParams { id: string; sessionKey: string; agentCommand: string }
export interface ResolvePermissionRequestParams {
  logicalSessionId: string;
  sessionKey: string;
  requestId: string;
  toolCallId: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  policyGeneration: number;
  workerGeneration: string;
}
export interface ResolveElicitationRequestParams {
  logicalSessionId: string;
  sessionKey: string;
  requestId: string;
  elicitationId: string;
  mode: string;
  message: unknown;
  policyGeneration: number;
  workerGeneration: string;
}

export interface BridgeOriginatedParams {
  registerAdapterIntent: RegisterAdapterIntentParams;
  launcherSpawned: AdapterTokenParams;
  cancelAdapterIntent: AdapterTokenParams;
  launchSettled: LaunchSettledParams;
  resolveAdapterCommand: ResolveAdapterCommandParams;
  resolvePermissionRequest: ResolvePermissionRequestParams;
  resolveElicitationRequest: ResolveElicitationRequestParams;
}

const LAUNCH_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function decodeBridgeOriginatedRequest(value: unknown): BridgeOriginatedRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.direction !== "bridge-to-daemon" || typeof item.rpcId !== "string" || !item.rpcId
    || typeof item.method !== "string" || !item.params || typeof item.params !== "object" || Array.isArray(item.params)) return null;
  const params = item.params as Record<string, unknown>;
  switch (item.method as BridgeOriginatedMethod) {
    case "registerAdapterIntent":
      if (typeof params.id !== "string" || !params.id || typeof params.sessionKey !== "string" || !params.sessionKey) return null;
      if (typeof params.agentCommand !== "string" || !params.agentCommand || !validTokenParams(params)
        || !Number.isSafeInteger(params.launcherPid) || Number(params.launcherPid) <= 0
        || parseCanonicalFileTime(params.launcherCreationDate) === null) return null;
      break;
    case "launcherSpawned":
    case "cancelAdapterIntent":
      if (typeof params.id !== "string" || !params.id || typeof params.sessionKey !== "string" || !params.sessionKey) return null;
      if (!validTokenParams(params)) return null;
      break;
    case "launchSettled":
      if (typeof params.id !== "string" || !params.id || typeof params.sessionKey !== "string" || !params.sessionKey) return null;
      if (!validTokenParams(params) || (params.outcome !== "owner-committed" && params.outcome !== "launch-failed")) return null;
      if (params.outcome === "owner-committed"
        && (!Number.isSafeInteger(params.ownerPid) || Number(params.ownerPid) <= 0
          || typeof params.ownerAcpxRecordId !== "string" || !params.ownerAcpxRecordId)) return null;
      break;
    case "resolveAdapterCommand":
      if (typeof params.id !== "string" || !params.id || typeof params.sessionKey !== "string" || !params.sessionKey) return null;
      if (typeof params.agentCommand !== "string" || !params.agentCommand || "intentToken" in params) return null;
      break;
    case "resolvePermissionRequest":
      if (
        typeof params.logicalSessionId !== "string" || !params.logicalSessionId ||
        typeof params.sessionKey !== "string" || !params.sessionKey ||
        typeof params.requestId !== "string" || !params.requestId ||
        typeof params.toolCallId !== "string" || !params.toolCallId ||
        typeof params.policyGeneration !== "number" ||
        typeof params.workerGeneration !== "string" || !params.workerGeneration
      ) return null;
      break;
    case "resolveElicitationRequest":
      if (
        typeof params.logicalSessionId !== "string" || !params.logicalSessionId ||
        typeof params.sessionKey !== "string" || !params.sessionKey ||
        typeof params.requestId !== "string" || !params.requestId ||
        typeof params.elicitationId !== "string" || !params.elicitationId ||
        typeof params.mode !== "string" || !params.mode ||
        typeof params.policyGeneration !== "number" ||
        typeof params.workerGeneration !== "string" || !params.workerGeneration
      ) return null;
      break;
    default:
      return null;
  }
  return item as unknown as BridgeOriginatedRequest;
}

function validTokenParams(params: Record<string, unknown>): boolean {
  return typeof params.intentToken === "string" && LAUNCH_TOKEN.test(params.intentToken);
}

export function encodeBridgeOriginatedMessage(
  message: BridgeOriginatedRequest | BridgeOriginatedResponse | BridgeOriginatedCancel,
): string {
  return `${JSON.stringify(message)}\n`;
}

export type EnsureSessionProgressStage = "spawn" | "initializing" | "ready";
export type EnsureSessionProgress =
  | EnsureSessionProgressStage
  | { kind: "note"; text: string };
export type EnsureSessionErrorKind = "missing_optional_dep" | "generic";

export interface MissingOptionalDepErrorData {
  package: string;
  parentPackagePath: string | null;
}

export interface BridgeSuccessResponse<TResult = unknown> {
  id: string;
  ok: true;
  result: TResult;
}

export interface BridgeErrorResponse {
  id: string;
  ok: false;
  error: {
    code: string;
    message: string;
    kind?: EnsureSessionErrorKind;
    data?: MissingOptionalDepErrorData;
    details?: {
      exitCode?: number;
      stdout?: string;
      stderr?: string;
    };
    timeout?: {
      timeoutMs: number;
      command: string;
      stage?: AcpxCommandStage;
      stdoutTail?: string;
      stderrTail?: string;
    };
    queueOverflowCleanup?: {
      cancelAttempted?: boolean;
      cancelSucceeded?: boolean;
      ownerTerminationAttempted?: boolean;
      ownerTerminationSucceeded?: boolean;
      diagnostic?: string;
    };
  };
}

export interface BridgePromptSegmentEvent {
  id: string;
  event: "prompt.segment";
  text: string;
}

export interface BridgePromptToolEvent {
  id: string;
  event: "prompt.tool_event";
  toolEvent: ToolUseEvent;
}

export interface BridgePromptThoughtEvent {
  id: string;
  event: "prompt.thought";
  text: string;
}

export interface BridgePromptPlanEvent {
  id: string;
  event: "prompt.plan";
  entries: PlanEntry[];
}

export interface BridgePromptUsageEvent {
  id: string;
  event: "prompt.usage";
  used: number;
  size: number;
  cost?: UsageCost;
  breakdown?: UsageBreakdown;
}

export interface BridgePromptCommandsEvent {
  id: string;
  event: "prompt.commands";
  commands: AgentCommand[];
}

export interface BridgeSessionProgressEvent {
  id: string;
  event: "session.progress";
  stage: EnsureSessionProgressStage;
}

export interface BridgeSessionNoteEvent {
  id: string;
  event: "session.note";
  text: string;
}

export type BridgeMessage<TResult = unknown> =
  | BridgeSuccessResponse<TResult>
  | BridgeErrorResponse
  | BridgePromptSegmentEvent
  | BridgePromptToolEvent
  | BridgePromptThoughtEvent
  | BridgePromptPlanEvent
  | BridgePromptUsageEvent
  | BridgePromptCommandsEvent
  | BridgeSessionProgressEvent
  | BridgeSessionNoteEvent;
export type BridgeResponse<TResult = unknown> = BridgeSuccessResponse<TResult> | BridgeErrorResponse;

export function encodeBridgeRequest(request: BridgeRequest): string {
  return `${JSON.stringify(request)}\n`;
}

export function encodeBridgePromptSegmentEvent(event: BridgePromptSegmentEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function encodeBridgePromptToolEvent(event: BridgePromptToolEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function encodeBridgePromptThoughtEvent(event: BridgePromptThoughtEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function encodeBridgePromptPlanEvent(event: BridgePromptPlanEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function encodeBridgePromptUsageEvent(event: BridgePromptUsageEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function encodeBridgePromptCommandsEvent(event: BridgePromptCommandsEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function encodeBridgeSessionProgressEvent(event: BridgeSessionProgressEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function encodeBridgeSessionNoteEvent(event: BridgeSessionNoteEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export type { ToolEventMode } from "../tool-event-mode.js";
