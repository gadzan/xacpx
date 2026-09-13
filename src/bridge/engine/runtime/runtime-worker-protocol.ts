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
  | "permission.decision"
  | "elicitation.decision"
  | "elicitation.cancel"
  | "shutdown";
export interface RuntimeWorkerRequest {
  id: string;
  method: RuntimeWorkerRequestMethod;
  params?: unknown;
}

export interface RuntimeWorkerEnsureParams {
  logicalSessionId?: string;
  sessionKey: string;
  agent: string;
  cwd?: string;
  stateDir: string;
  permissionMode: XacpxPermissionMode;
  nonInteractivePermissions?: "deny" | "fail";
  permissionPolicy?: unknown;
  /** Narrow argv overrides for this worker only (plan §35). */
  agentOverrides?: Record<string, string | string[]>;
  /** Optional native session identifier to resume (plan §13). */
  resumeSessionId?: string;
  /** Optional initial model for sessionOptions (plan §9.1). */
  model?: string;
  /** Persisted reasoning-effort preference; reapplied on every worker respawn. */
  effort?: string;
  /** PR7: initial permission generation for new workers (live snapshot). */
  permissionGeneration?: number;
  /** PR8: MCP coordinator identity (immutable launch identity). */
  mcpCoordinatorSession?: string;
  mcpSourceHandle?: string;
  /**
   * Trusted child-only agent environment (plan B1, acpx 0.15 agentProcessEnv).
   * Snapshot at Runtime construction: never persisted to the session record,
   * part of the immutable construction identity — a change recycles the
   * worker. Intentional overlay only (no parent echoes); the worker uses it
   * as received.
   */
  agentProcessEnv?: Record<string, string>;
  /** Host-assigned worker generation identity. */
  workerGeneration?: string;
}

/**
 * Stable identity fragment for an agent env overlay. Key order never
 * distinguishes identical overlays. On Windows the comparison mirrors
 * upstream assignSessionEnv (live-checkpoint bundle): case-insensitive,
 * entries applied in insertion order with last-writer-wins, then serialized
 * sorted by folded key — so equal identity always means equal effective
 * child env.
 */
export function agentProcessEnvIdentityKey(
  env: Record<string, string> | undefined,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (env === undefined) return null;
  if (platform === "win32") {
    const folded = new Map<string, string>();
    for (const [key, value] of Object.entries(env)) folded.set(key.toUpperCase(), value);
    return JSON.stringify([...folded.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
  const entries = Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}
export interface RuntimeWorkerPromptParams {
  text: string;
  /** Binary prompt attachments (image/audio) forwarded to ACP content blocks. */
  attachments?: Array<{ mediaType: string; data: string }>;
  interactionId?: string;
}
export interface RuntimeWorkerPermissionUpdate {
  generation: number;
  permissionMode?: XacpxPermissionMode;
  nonInteractivePermissions?: "deny" | "fail";
  permissionPolicy?: unknown | null;
  /** When true, the permission policy is explicitly cleared (no policy). */
  clearPermissionPolicy?: boolean;
}

export interface RuntimeWorkerPermissionRequestPayload {
  logicalSessionId: string;
  sessionKey: string;
  requestId: string;
  toolCallId: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  policyGeneration: number;
  workerGeneration: string;
  interactionId?: string;
  availableOutcomes?: Array<"allow_once" | "allow_always" | "reject_once" | "reject_always" | "cancel">;
}

export interface RuntimeWorkerPermissionDecisionParams {
  requestId: string;
  toolCallId: string;
  policyGeneration: number;
  decision: { outcome: "allow_once" | "allow_always" | "reject_once" | "reject_always" | "cancel" };
}

export interface RuntimeWorkerElicitationRequestPayload {
  logicalSessionId: string;
  sessionKey: string;
  requestId: string;
  elicitationId: string;
  mode: "form" | "url";
  message: unknown;
  policyGeneration: number;
  workerGeneration: string;
}

export interface RuntimeWorkerElicitationDecisionParams {
  requestId: string;
  elicitationId: string;
  policyGeneration: number;
  decision: { action: "submit" | "cancel"; data?: unknown };
}

export type RuntimeWorkerEvent = {
  id: string;
  event: "text_delta" | "thought" | "tool" | "plan" | "usage" | "commands" | "permission.request" | "elicitation.request";
  payload: XacpxRuntimeEvent | RuntimeWorkerPermissionRequestPayload | RuntimeWorkerElicitationRequestPayload | unknown;
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
