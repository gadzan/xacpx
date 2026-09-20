/**
 * Runtime boundary for AcpRuntime/session-store access (plan §11, G13): this
 * module owns every acpx/runtime import for the Runtime ENGINE — everything
 * above it consumes the xacpx-owned types from runtime-contract.ts, and
 * upstream patch-level changes to the Runtime/session store are absorbed
 * here alone.
 *
 * One deliberate legacy exception (G13 lint allowlist): src/transport/
 * agent-registry.ts lazily requires "acpx/runtime" for createAgentRegistry
 * (install-hint flows only). It is a second public-boundary consumer until
 * Wave B folds it into this adapter — upstream breakage there is NOT
 * absorbed by this file.
 */
import {
  createAcpRuntime,
  createAgentRegistry,
  createRuntimeStore,
  type AcpRuntime,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpPermissionRequest,
  type AcpPermissionDecision,
} from "acpx/runtime";

import type {
  XacpxConfigSnapshot,
  XacpxPlanEntry,
  XacpxPermissionMode,
  XacpxNonInteractivePermissions,
  XacpxRuntimeEvent,
  XacpxRuntimeSessionHandle,
  XacpxTurnHandle,
  XacpxTurnResult,
} from "./runtime-contract";
import {
  normalizeRuntimeToolCallEvent,
  type RuntimeToolCallSnapshot,
} from "./runtime-tool-call-merge";
import {
  createTranscriptTextBoundaryState,
  markTranscriptActivity,
  normalizeTranscriptTextChunk,
} from "../../../transport/transcript-text-boundary.js";

export type XacpxMcpServers = AcpRuntimeOptions["mcpServers"];
export type XacpxPermissionRequest = AcpPermissionRequest;
export type XacpxPermissionDecision = AcpPermissionDecision;

/**
 * ACP elicitation mode as advertised by upstream. The adapter forwards only
 * what the daemon truthfully supports; upstream builds client capabilities
 * from this list (empty ⇒ no `elicitation` capability advertised).
 */
export type XacpxElicitationMode = "form" | "url";

/**
 * Upstream JSON-RPC id of the outer `elicitation/create` request, preserved
 * exactly (string | number | null per ACP JsonRpcId) — never stringified and
 * never regenerated.
 */
export type XacpxElicitationRequestId = string | number | null;

/** Exact upstream context handed to the elicitation handler. */
export interface XacpxElicitationContext {
  requestId: XacpxElicitationRequestId;
  /** Aborts with the elicitation request itself or its owning prompt turn. */
  signal: AbortSignal;
}

/** Raw ACP form-mode `CreateElicitationRequest` — normalized above the adapter. */
export type XacpxElicitationRequest = unknown;

/**
 * xacpx-owned elicitation decision. Mirrors the three ACP actions exactly:
 * `decline` is a user choice, `cancel` is everything else (timeout, abort,
 * unsupported surface, malformed schema, plugin failure).
 */
export type XacpxElicitationResponse =
  | {
      action: "accept";
      content?: Record<string, string | number | boolean | string[]> | null;
    }
  | { action: "decline" }
  | { action: "cancel" };

export interface XacpxElicitationHandler {
  (
    request: XacpxElicitationRequest,
    context: XacpxElicitationContext,
  ): Promise<XacpxElicitationResponse>;
}

export interface CreateXacpxRuntimeAdapterOptions {
  /** acpx session store directory — must match xacpx's CLI acpx stateDir. */
  stateDir: string;
  permissionMode: XacpxPermissionMode;
  nonInteractivePermissions?: XacpxNonInteractivePermissions;
  permissionPolicy?: unknown;
  /**
   * Narrow per-worker registry (plan §35): exact argv overrides for the agents
   * this worker launches, instead of syncing the whole xacpx agent config.
   */
  agentOverrides?: Record<string, string | string[]>;
  /**
   * Trusted child-only agent environment (plan B1, acpx 0.15 agentProcessEnv).
   * Snapshotted by upstream at construction; applies to probes, first launch
   * and reconnects alike. Never persisted to the session record, never touches
   * the worker's own process.env. Auth precedence stays upstream-owned: xacpx
   * never passes authCredentials, so protected auth always wins over this.
   */
  agentProcessEnv?: Record<string, string>;
  /**
   * Agent-root lifecycle observer (plan B2, acpx 0.15 processLifecycle).
   * Awaited admission boundary: rejecting onBeforeSpawn/onSpawned aborts
   * startup (upstream terminates a spawned-but-rejected child itself).
   * Covers ACP agent roots only — never terminal/descendant cleanup.
   */
  processLifecycle?: AcpRuntimeOptions["processLifecycle"];
  onPermissionRequest?: (req: import("acpx/runtime").AcpPermissionRequest, ctx: { signal: AbortSignal }) => Promise<import("acpx/runtime").AcpPermissionDecision | undefined>;
  /**
   * ACP elicitation modes to advertise to the agent. Empty/undefined means
   * NO elicitation capability at all — upstream then answers every
   * `elicitation/create` as unsupported instead of routing to a
   * `cancel`-only pipeline. Callers pass only what the daemon truthfully
   * supports (M1: `form`, and only when a real form-capable channel exists).
   */
  elicitationModes?: readonly XacpxElicitationMode[];
  mcpServers?: import("acpx/runtime").AcpRuntimeOptions["mcpServers"];
}

export interface XacpxEnsureInput {
  sessionKey: string;
  agent: string;
  cwd?: string;
  resumeSessionId?: string;
  sessionOptions?: {
    model?: string;
  };
}
export interface XacpxTurnAttachment {
  mediaType: string;
  data: string;
}
export interface XacpxStartTurnInput {
  handle: XacpxRuntimeSessionHandle;
  text: string;
  attachments?: XacpxTurnAttachment[];
  /**
   * Elicitation handler for this turn. Wrapping is explicit (below): the
   * upstream handler receives the real ACP request plus its exact
   * requestId/signal, and the xacpx response maps explicitly onto the ACP
   * action — never an unchecked cast in either direction.
   */
  onElicitation?: XacpxElicitationHandler;
}

export interface XacpxRuntimeAdapter {
  ensure(input: XacpxEnsureInput): Promise<XacpxRuntimeSessionHandle>;
  startTurn(input: XacpxStartTurnInput): XacpxTurnHandle;
  setMode(handle: XacpxRuntimeSessionHandle, mode: string): Promise<void>;
  /**
   * Applies a config option and returns the agent-accepted snapshot (plan
   * B3). `undefined` when upstream resolves void (no accepted state to
   * report). Never expose the SDK response type above this boundary.
   */
  setConfigOption(handle: XacpxRuntimeSessionHandle, key: string, value: string): Promise<XacpxConfigSnapshot | undefined>;
  getStatus(handle: XacpxRuntimeSessionHandle): Promise<unknown>;
  cancel(handle: XacpxRuntimeSessionHandle): Promise<void>;
  close(handle: XacpxRuntimeSessionHandle, options?: { discardPersistentState?: boolean }): Promise<void>;
  /** Raw access for the contract probe / advanced callers inside the worker. */
  raw(): AcpRuntime;
}

/**
 * Preserve the upstream JSON-RPC id exactly. ACP JsonRpcId is
 * string | number | null; anything else at runtime is coerced to null
 * (an id-less correlation is safer than a fabricated one) and stays visible
 * downstream instead of being silently replaced.
 */
function toXacpxRequestId(requestId: unknown): XacpxElicitationRequestId {
  if (typeof requestId === "string") return requestId;
  if (typeof requestId === "number" && Number.isFinite(requestId)) return requestId;
  if (requestId === null) return null;
  return null;
}

/** Map the xacpx decision onto the pinned ACP response shape. */
function toUpstreamElicitationResponse(
  response: XacpxElicitationResponse,
): import("acpx/runtime").AcpElicitationResponse {
  switch (response.action) {
    case "accept":
      return {
        action: "accept",
        ...(response.content === undefined ? {} : { content: response.content }),
      };
    case "decline":
      return { action: "decline" };
    default:
      return { action: "cancel" };
  }
}

export function createXacpxRuntimeAdapter(options: CreateXacpxRuntimeAdapterOptions): XacpxRuntimeAdapter {
  const runtime = createAcpRuntime({
    cwd: process.cwd(),
    // B2: direct-agent-root admission/observation. Terminal/descendant
    // cleanup stays with the worker fence + orphan convergence.
    ...(options.processLifecycle ? { processLifecycle: options.processLifecycle } : {}),
    sessionStore: createRuntimeStore({ stateDir: options.stateDir }),
    agentRegistry: createAgentRegistry(
      options.agentOverrides ? { overrides: options.agentOverrides } : undefined,
    ),
    permissionMode: options.permissionMode,
    // B1: child-only overlay for every agent child this Runtime owns.
    ...(options.agentProcessEnv ? { agentProcessEnv: options.agentProcessEnv } : {}),
    // Truthful capability only: the daemon decides which ACP elicitation
    // modes xacpx can actually render. Empty ⇒ no capability is advertised
    // and upstream refuses elicitation locally instead of routing to a
    // pipeline that can only cancel.
    elicitationModes: [...(options.elicitationModes ?? [])],
    ...(options.nonInteractivePermissions ? { nonInteractivePermissions: options.nonInteractivePermissions } : {}),
    ...(options.onPermissionRequest
      ? { onPermissionRequest: options.onPermissionRequest }
      : (options.permissionPolicy !== undefined ? { permissionPolicy: options.permissionPolicy as never } : {})),
    ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
  });

  function toHandle(handle: XacpxRuntimeSessionHandle): AcpRuntimeHandle {
    return handle as unknown as AcpRuntimeHandle;
  }

  return {
    async ensure(input) {
      const handle = await runtime.ensureSession({
        sessionKey: input.sessionKey,
        agent: input.agent,
        mode: "persistent",
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
        ...(input.sessionOptions ? { sessionOptions: input.sessionOptions } : {}),
      });
      return handle as unknown as XacpxRuntimeSessionHandle;
    },
    startTurn({ handle, text, attachments, onElicitation }) {
      const turn = runtime.startTurn({
        handle: toHandle(handle),
        text,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        mode: "prompt",
        requestId: `xacpx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        // Explicit adapter boundary: upstream ACP handler ← xacpx handler.
        // Upstream owns the real JSON-RPC id (`context.requestId`) and the
        // merged abort signal (`context.signal`); xacpx only maps the
        // incoming request identity and the outgoing action. No
        // `as unknown as AcpElicitationHandler` cast, so neither side can
        // silently drift in shape.
        ...(onElicitation
          ? {
              onElicitation: async (
                req: import("acpx/runtime").AcpElicitationRequest,
                context: { requestId: import("acpx/runtime").AcpElicitationContext["requestId"]; signal: AbortSignal },
              ): Promise<import("acpx/runtime").AcpElicitationResponse> => {
                const response = await onElicitation(req, {
                  requestId: toXacpxRequestId(context.requestId),
                  signal: context.signal,
                });
                return toUpstreamElicitationResponse(response);
              },
            }
          : {}),
      });
      return {
        requestId: turn.requestId,
        promptStarted: turn.promptStarted,
        events: mapEvents(turn.events),
        result: mapResult(turn.result),
        cancel: (inputArgs?: { reason?: string }) => turn.cancel(inputArgs),
      };
    },
    async setMode(handle, mode) {
      await runtime.setMode({ handle: toHandle(handle), mode });
    },
    async setConfigOption(handle, key, value) {
      const response = await runtime.setConfigOption({ handle: toHandle(handle), key, value });
      return toConfigSnapshot(response);
    },
    async getStatus(handle) {
      return await runtime.getStatus({ handle: toHandle(handle) });
    },
    async cancel(handle) {
      await runtime.cancel({ handle: toHandle(handle), reason: "xacpx cancel" });
    },
    async close(handle: XacpxRuntimeSessionHandle, closeOptions?: { discardPersistentState?: boolean }) {
      await runtime.close({
        handle: toHandle(handle),
        reason: "xacpx close",
        ...(closeOptions?.discardPersistentState ? { discardPersistentState: true } : {}),
      });
    },
    raw() {
      return runtime;
    },
  };
}

/**
 * Narrow the upstream accepted-config response to the xacpx-owned snapshot
 * (plan B3). `void` stays `undefined` — no accepted state was reported.
 * Only stable id/currentValue cross the boundary; sibling-option changes the
 * agent made alongside are visible as entries, never as SDK objects.
 */
export function toConfigSnapshot(response: unknown): XacpxConfigSnapshot | undefined {
  if (!response || typeof response !== "object" || !("configOptions" in response)) return undefined;
  const rawOptions = response.configOptions;
  if (!Array.isArray(rawOptions)) return undefined;
  return {
    options: rawOptions.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || !("id" in entry)) return [];
      const id = entry.id;
      if (typeof id !== "string") return [];
      const current = "currentValue" in entry ? entry.currentValue : undefined;
      if (typeof current === "string") return [{ id, currentValue: current }];
      if (typeof current === "boolean") return [{ id, currentValue: String(current) }];
      return [{ id }];
    }),
  };
}

function normalizeTextDeltaMeta(
  meta: unknown,
): { origin?: string; kind?: string; source?: string } | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const raw = meta as Record<string, unknown>;
  const result: { origin?: string; kind?: string; source?: string } = {};
  if (typeof raw.origin === "string" && raw.origin.length > 0) result.origin = raw.origin;
  if (typeof raw.kind === "string" && raw.kind.length > 0) result.kind = raw.kind;
  if (typeof raw.source === "string" && raw.source.length > 0) result.source = raw.source;
  return Object.keys(result).length > 0 ? result : undefined;
}

export async function* mapEvents(events: AsyncIterable<AcpRuntimeEvent>): AsyncIterable<XacpxRuntimeEvent> {
  const toolCalls = new Map<string, RuntimeToolCallSnapshot>();
  const textBoundary = createTranscriptTextBoundaryState();

  for await (const event of events) {
    if (event.type === "text_delta") {
      const isThought = event.stream === "thought";
      if (isThought) {
        markTranscriptActivity(textBoundary);
        const meta = normalizeTextDeltaMeta(event.meta);
        yield {
          type: "text_delta",
          text: event.text,
          stream: "thought",
          ...(event.tag ? { tag: event.tag } : {}),
          ...(event.messageId ? { messageId: event.messageId } : {}),
          ...(meta ? { meta } : {}),
        };
      } else {
        const text = normalizeTranscriptTextChunk(textBoundary, {
          text: event.text,
          messageId: event.messageId,
        });
        const meta = normalizeTextDeltaMeta(event.meta);
        yield {
          type: "text_delta",
          text,
          ...(event.stream ? { stream: event.stream } : {}),
          ...(event.tag ? { tag: event.tag } : {}),
          ...(event.messageId ? { messageId: event.messageId } : {}),
          ...(meta ? { meta } : {}),
        };
      }
    } else if (event.type === "status") {
      // Structured plan entries ride on status events (acpx 0.16.0+);
      // absent on older versions — normalize present-only, never fabricate.
      const planEntries = normalizeAdapterPlanEntries(
        (event as { entries?: unknown }).entries,
      );
      yield {
        type: "status",
        text: event.text,
        ...(event.tag ? { tag: event.tag } : {}),
        ...(event.used !== undefined ? { used: event.used } : {}),
        ...(event.size !== undefined ? { size: event.size } : {}),
        ...(event.cost ? { cost: event.cost } : {}),
        ...(event.breakdown ? { breakdown: event.breakdown } : {}),
        ...(event.availableCommands ? { availableCommands: event.availableCommands } : {}),
        ...(planEntries !== undefined ? { entries: planEntries } : {}),
      };
    } else if (event.type === "tool_call") {
      const isInitialToolEvent = typeof event.toolCallId === "string"
        ? !toolCalls.has(event.toolCallId)
        : event.tag !== "tool_call_update";
      if (isInitialToolEvent) {
        markTranscriptActivity(textBoundary);
      }
      yield normalizeRuntimeToolCallEvent(toolCalls, {
        type: "tool_call",
        text: event.text,
        ...(event.tag ? { tag: event.tag } : {}),
        ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
        ...(event.status ? { status: event.status } : {}),
        ...(event.title ? { title: event.title } : {}),
        ...(event.kind ? { kind: event.kind } : {}),
        ...(event.locations !== undefined ? { locations: event.locations } : {}),
        ...(event.rawInput !== undefined ? { rawInput: event.rawInput } : {}),
        ...(event.rawOutput !== undefined ? { rawOutput: event.rawOutput } : {}),
        ...(event.content !== undefined ? { content: event.content } : {}),
      });
    }
    // "done"/"error" only surface via runTurn(); startTurn uses .result instead.
  }
}

const ADAPTER_PLAN_STATUSES = new Set(["pending", "in_progress", "completed"]);
const ADAPTER_PLAN_PRIORITIES = new Set(["high", "medium", "low"]);

/**
 * Normalize upstream plan entries defensively (boundary rule: this module
 * absorbs upstream shape drift). Returns undefined when upstream sent no
 * list at all — so "absent" stays distinguishable from "explicitly empty"
 * (the agent cleared its plan). A non-empty list with zero usable entries
 * is also absence, never an empty replacement: mapping garbage to a clear
 * would wipe a previously displayed valid plan. Malformed entries are
 * skipped, never fabricated.
 */
function normalizeAdapterPlanEntries(value: unknown): XacpxPlanEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return [];
  const entries: XacpxPlanEntry[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content.trim() : "";
    const status = typeof record.status === "string" ? record.status.trim() : "";
    if (!content || !ADAPTER_PLAN_STATUSES.has(status)) continue;
    const priority = typeof record.priority === "string" ? record.priority.trim() : "";
    entries.push({
      content,
      status: status as XacpxPlanEntry["status"],
      ...(ADAPTER_PLAN_PRIORITIES.has(priority)
        ? { priority: priority as XacpxPlanEntry["priority"] }
        : {}),
    });
  }
  return entries.length > 0 ? entries : undefined;
}

export async function mapResult(result: Promise<{
  status: "completed" | "cancelled" | "failed";
  stopReason?: string;
  _meta?: Record<string, unknown> | null;
  error?: { message: string; code?: string; detailCode?: string; retryable?: boolean };
}>): Promise<XacpxTurnResult> {
  const settled = await result;
  if (settled.status === "failed") {
    return { status: "failed", error: settled.error ?? { message: "runtime turn failed" } };
  }
  // Lossless opaque pass-through (plan B4): upstream `_meta` becomes narrow
  // `meta`. Failed turns never carry meta, even if a producer attached one.
  const meta = settled._meta === undefined ? undefined : settled._meta;
  return settled.status === "cancelled"
    ? { status: "cancelled", ...(settled.stopReason ? { stopReason: settled.stopReason } : {}), ...(meta !== undefined ? { meta } : {}) }
    : { status: "completed", ...(settled.stopReason ? { stopReason: settled.stopReason } : {}), ...(meta !== undefined ? { meta } : {}) };
}
