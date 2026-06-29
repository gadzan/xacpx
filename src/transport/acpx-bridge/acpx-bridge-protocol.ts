import type { PlanEntry, ToolUseEvent } from "../../channels/types.js";
import type { AgentCommand, UsageBreakdown, UsageCost } from "../types";

export type BridgeMethod =
  | "ping"
  | "shutdown"
  | "updatePermissionPolicy"
  | "ensureSession"
  | "hasSession"
  | "tailSessionHistory"
  | "listAgentSessions"
  | "resumeAgentSession"
  | "prompt"
  | "setMode"
  | "setModel"
  | "getSessionModel"
  | "cancel"
  | "removeSession"
  | "deleteSession"
  | "freeWarmProcess"
  | "getAgentSessionId";

export interface BridgeRequest {
  id: string;
  method: BridgeMethod;
  params: Record<string, unknown>;
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
