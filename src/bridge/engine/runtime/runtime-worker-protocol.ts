/**
 * Runtime Worker JSON-Lines protocol (plan §10). Deliberately tiny: it serves a
 * SINGLE session per worker and must not grow into the daemon↔bridge contract.
 */
import type { XacpxRuntimeEvent, XacpxTurnResult, RuntimeBridgeErrorCode, XacpxPermissionMode } from "./runtime-contract";

export type RuntimeWorkerRequestMethod =
  | "ensure"
  | "prompt"
  | "setMode"
  | "setConfigOption"
  | "status"
  | "cancel"
  | "close"
  | "permission.update"
  | "shutdown";

export interface RuntimeWorkerRequest {
  id: string;
  method: RuntimeWorkerRequestMethod;
  params?: unknown;
}

export interface RuntimeWorkerEnsureParams {
  sessionKey: string;
  agent: string;
  cwd?: string;
  stateDir: string;
  permissionMode: XacpxPermissionMode;
  nonInteractivePermissions?: "deny" | "fail";
  /** Declarative permission policy (plan §27/§32). */
  permissionPolicy?: unknown;
  /** Narrow argv overrides for this worker only (plan §35). */
  agentOverrides?: Record<string, string | string[]>;
}
export interface RuntimeWorkerPromptParams {
  text: string;
}

export interface RuntimeWorkerPermissionUpdate {
  generation: number;
  permissionMode?: XacpxPermissionMode;
  nonInteractivePermissions?: "deny" | "fail";
  permissionPolicy?: unknown;
}

export type RuntimeWorkerEvent = {
  id: string;
  event: "text_delta" | "thought" | "tool" | "plan" | "usage" | "commands" | "permission.request";
  payload: XacpxRuntimeEvent | unknown;
};

export interface RuntimeWorkerSuccess<T = unknown> {
  id: string;
  ok: true;
  result: T;
}

export interface RuntimeWorkerFailure {
  id: string;
  ok: false;
  error: { code: RuntimeBridgeErrorCode; message: string };
}

export type RuntimeWorkerResponse = RuntimeWorkerSuccess<unknown> | RuntimeWorkerFailure;

/** Turn-scoped result returned by the prompt method. Events stream as
 * RuntimeWorkerEvent frames DURING the turn; the response carries only the
 * settled outcome — never a batched replay. */
export interface RuntimeWorkerPromptResult {
  result: XacpxTurnResult;
  finalText: string;
}

export function encodeWorkerMessage(message: RuntimeWorkerRequest | RuntimeWorkerResponse | RuntimeWorkerEvent): string {
  return `${JSON.stringify(message)}\n`;
}

export type ParsedWorkerLine =
  | { kind: "request"; message: RuntimeWorkerRequest }
  | { kind: "response" | "event"; message: Record<string, unknown> };

/** Parses any worker-line shape: host→worker requests, worker→host responses/events. */
export function parseWorkerLine(line: string): ParsedWorkerLine | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  if (typeof record.method === "string") {
    return { kind: "request", message: { id: record.id, method: record.method as RuntimeWorkerRequestMethod, params: record.params } };
  }
  if ("ok" in record) return { kind: "response", message: record };
  if (typeof record.event === "string") return { kind: "event", message: record };
  return null;
}
