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
  XacpxPermissionMode,
  XacpxNonInteractivePermissions,
  XacpxRuntimeEvent,
  XacpxRuntimeSessionHandle,
  XacpxTurnHandle,
  XacpxTurnResult,
} from "./runtime-contract";

export type XacpxMcpServers = AcpRuntimeOptions["mcpServers"];
export type XacpxPermissionRequest = AcpPermissionRequest;
export type XacpxPermissionDecision = AcpPermissionDecision;

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
  onPermissionRequest?: (req: import("acpx/runtime").AcpPermissionRequest, ctx: { signal: AbortSignal }) => Promise<import("acpx/runtime").AcpPermissionDecision | undefined>;
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
}

export interface XacpxRuntimeAdapter {
  ensure(input: XacpxEnsureInput): Promise<XacpxRuntimeSessionHandle>;
  startTurn(input: XacpxStartTurnInput): XacpxTurnHandle;
  setMode(handle: XacpxRuntimeSessionHandle, mode: string): Promise<void>;
  setConfigOption(handle: XacpxRuntimeSessionHandle, key: string, value: string): Promise<void>;
  getStatus(handle: XacpxRuntimeSessionHandle): Promise<unknown>;
  cancel(handle: XacpxRuntimeSessionHandle): Promise<void>;
  close(handle: XacpxRuntimeSessionHandle, options?: { discardPersistentState?: boolean }): Promise<void>;
  /** Raw access for the contract probe / advanced callers inside the worker. */
  raw(): AcpRuntime;
}

export function createXacpxRuntimeAdapter(options: CreateXacpxRuntimeAdapterOptions): XacpxRuntimeAdapter {
  const runtime = createAcpRuntime({
    cwd: process.cwd(),
    sessionStore: createRuntimeStore({ stateDir: options.stateDir }),
    agentRegistry: createAgentRegistry(
      options.agentOverrides ? { overrides: options.agentOverrides } : undefined,
    ),
    permissionMode: options.permissionMode,
    ...(options.nonInteractivePermissions ? { nonInteractivePermissions: options.nonInteractivePermissions } : {}),
    ...(options.permissionPolicy !== undefined ? { permissionPolicy: options.permissionPolicy as never } : {}),
    ...(options.onPermissionRequest ? { onPermissionRequest: options.onPermissionRequest } : {}),
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
    startTurn({ handle, text, attachments }) {
      const turn = runtime.startTurn({
        handle: toHandle(handle),
        text,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        mode: "prompt",
        requestId: `xacpx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
      await runtime.setConfigOption({ handle: toHandle(handle), key, value });
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

async function* mapEvents(events: AsyncIterable<AcpRuntimeEvent>): AsyncIterable<XacpxRuntimeEvent> {
  for await (const event of events) {
    if (event.type === "text_delta") {
      yield { type: "text_delta", text: event.text, ...(event.stream ? { stream: event.stream } : {}) };
    } else if (event.type === "status") {
      yield {
        type: "status",
        text: event.text,
        ...(event.tag ? { tag: event.tag } : {}),
        ...(event.used !== undefined ? { used: event.used } : {}),
        ...(event.size !== undefined ? { size: event.size } : {}),
        ...(event.cost ? { cost: event.cost } : {}),
        ...(event.breakdown ? { breakdown: event.breakdown } : {}),
        ...(event.availableCommands ? { availableCommands: event.availableCommands } : {}),
      };
    } else if (event.type === "tool_call") {
      yield {
        type: "tool_call",
        text: event.text,
        ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
        ...(event.status ? { status: event.status } : {}),
        ...(event.title ? { title: event.title } : {}),
        ...(event.kind ? { kind: event.kind } : {}),
        ...(event.locations !== undefined ? { locations: event.locations } : {}),
        ...(event.rawInput !== undefined ? { rawInput: event.rawInput } : {}),
        ...(event.rawOutput !== undefined ? { rawOutput: event.rawOutput } : {}),
        ...(event.content !== undefined ? { content: event.content } : {}),
      };
    }
    // "done"/"error" only surface via runTurn(); startTurn uses .result instead.
  }
}

async function mapResult(result: Promise<{
  status: "completed" | "cancelled" | "failed";
  stopReason?: string;
  error?: { message: string; code?: string; detailCode?: string; retryable?: boolean };
}>): Promise<XacpxTurnResult> {
  const settled = await result;
  if (settled.status === "failed") {
    return { status: "failed", error: settled.error ?? { message: "runtime turn failed" } };
  }
  return settled.status === "cancelled"
    ? { status: "cancelled", ...(settled.stopReason ? { stopReason: settled.stopReason } : {}) }
    : { status: "completed", ...(settled.stopReason ? { stopReason: settled.stopReason } : {}) };
}
