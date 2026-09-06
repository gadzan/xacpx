/**
 * Runtime Worker entry point (plan §9.2): one process per Runtime-bound
 * session. Owns exactly one AcpRuntime + one persistent session handle; killed
 * by the host as the release primitive — so it must NEVER call runtime.close()
 * during ordinary shutdown (that would close the acpx record; plan §17).
 */
import { createInterface } from "node:readline";
import { convergeOrphansBeforeExit, markRuntimeWorkerFence } from "./worker-eof";
import { createDispatchGate } from "./runtime-worker-gate";

import {
  createXacpxRuntimeAdapter,
  type XacpxRuntimeAdapter,
} from "./runtime-adapter";
import type {
  XacpxRuntimeSessionHandle,
  XacpxTurnHandle,
} from "./runtime-contract";
import {
  encodeWorkerMessage,
  parseWorkerLine,
  type RuntimeWorkerEvent,
  type RuntimeWorkerRequest,
  type RuntimeWorkerResponse,
  type RuntimeWorkerEnsureParams,
  type RuntimeWorkerPromptParams,
  type RuntimeWorkerPermissionUpdate,
  type RuntimeWorkerPermissionRequestPayload,
  type RuntimeWorkerElicitationRequestPayload,
  type RuntimeWorkerPermissionDecisionParams,
  type RuntimeWorkerElicitationDecisionParams,
  type RuntimeWorkerPromptResult,
} from "./runtime-worker-protocol";
import { mapRuntimeError } from "./runtime-contract";
import { parseSessionEffortRecord } from "../../../transport/session-effort";
import { parseXacpxPermissionPolicy } from "./runtime-permission-policy";
import { RuntimePermissionResolver, type RuntimePermissionConfig, type RuntimePermissionRequest } from "./runtime-permission-resolver";

class RuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

interface WorkerState {
  adapter?: XacpxRuntimeAdapter;
  handle?: XacpxRuntimeSessionHandle;
  ensureParams?: RuntimeWorkerEnsureParams;
  activeTurn?: XacpxTurnHandle;
  shuttingDown: boolean;
  permissionSnapshot?: RuntimePermissionConfig;
  permissionGeneration: number;
  pendingPermissions: Map<string, { resolve: (d: { outcome: string }) => void; reject: (e: Error) => void; generation: number; workerGeneration: string }>;
  pendingElicitations: Map<string, { resolve: (d: { action: string; data?: unknown }) => void; reject: (e: Error) => void; requestId: string; generation: number; workerGeneration: string }>;
  workerGeneration: string;
  /** Single-flight first initialization: identical-identity concurrent ensures join this; it is cleared on settle. */
  ensureInFlight?: { identityKey: string; promise: Promise<void> };
  /**
   * A failed first initialization poisons the worker: the adapter/manager
   * that was created may have already retained a native ACP owner we cannot
   * prove dead, so a retry inside the same process risks a second live
   * owner. The Host must tear down this worker and respawn a fresh one.
   */
  initFailed?: true;
}
const gate = createDispatchGate();
const initialWorkerGeneration =
  process.env.XACPX_WORKER_GENERATION ||
  process.env.XACPX_WORKER_FENCE_GENERATION ||
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const state: WorkerState = {
  shuttingDown: false,
  permissionGeneration: 0,
  pendingPermissions: new Map(),
  pendingElicitations: new Map(),
  workerGeneration: initialWorkerGeneration,
};
function respond(response: RuntimeWorkerResponse): void {
  process.stdout.write(encodeWorkerMessage(response));
}

/**
 * Runtime-construction identity (plan §3-R1). Mutable per-invocation
 * parameters are deliberately excluded:
 *   - `model` / `effort`: applied in place via setConfigOption.
 *   - `resumeSessionId`: a first-ensure INVOCATION parameter, not identity —
 *     resumeAgentSession(X) is always followed by prompt ensures without it.
 *     Including it here would rebuild the AcpRuntime inside one worker and
 *     create a second live ACP owner (violates single-owner, plan §3-R1).
 *   - `permissionMode` / `nonInteractivePermissions` / `permissionPolicy`: mutable snapshot (PR7 live update)
 */
function ensureIdentityKey(p: RuntimeWorkerEnsureParams): string {
  return JSON.stringify([
    p.sessionKey,
    p.agent,
    p.cwd ?? null,
    p.stateDir,
    p.agentOverrides ?? null,
    p.mcpCoordinatorSession ?? null,
    p.mcpSourceHandle ?? null,
  ]);
}

function sameEnsureParams(a: RuntimeWorkerEnsureParams | undefined, b: RuntimeWorkerEnsureParams): boolean {
  // Exported-name contract kept for the existing callsite's readability:
  // identical runtime-construction identity.
  return a !== undefined && ensureIdentityKey(a) === ensureIdentityKey(b);
}

/** Resolve the REAL advertised effort config id (CLI parity) and write the value. */
async function applySessionEffort(
  adapter: XacpxRuntimeAdapter,
  handle: XacpxRuntimeSessionHandle,
  effort: string,
): Promise<void> {
  const status = await adapter.getStatus(handle);
  const details = (status as { details?: { configOptions?: unknown } }).details;
  const parsed = parseSessionEffortRecord(JSON.stringify({ acpx: { config_options: details?.configOptions ?? [] } }));
  if (!parsed) throw new Error("the active agent does not advertise a reasoning-effort option");
  if (!parsed.available.includes(effort)) {
    throw new Error(`reasoning effort "${effort}" is not advertised by the active agent`);
  }
  await adapter.setConfigOption(handle, parsed.configId, effort);
}

async function ensure(params: RuntimeWorkerEnsureParams): Promise<{ sessionKey: string; acpxRecordId?: string; agentSessionId?: string }> {
  // Single-owner invariant (plan §3-R1): once an adapter exists in this
  // worker, it is NEVER replaced. The Worker process IS the AcpRuntime
  // lifecycle primitive (plan §9.2) — a genuine immutable-identity change
  // must fail closed so the Host tears down the whole worker and spawns a
  // fresh one, because the pinned acpx public Runtime has no dispose
  // primitive and a replacement here would leak the retained native ACP
  // owner (dual owner).
  if (state.initFailed) {
    throw new RuntimeError(
      "RUNTIME_WORKER_POISONED_INIT",
      `runtime worker for session "${params.sessionKey}" previously failed its first initialization; refusing an in-worker retry that could stack a second AcpRuntime/native owner — the Host recycles this worker and respawns a fresh one`,
    );
  }
  if (params.workerGeneration) state.workerGeneration = params.workerGeneration;
  const identityKey = ensureIdentityKey(params);
  if (state.ensureInFlight) {
    // First initialization is mid-flight: identical-identity callers JOIN it
    // (single-flight), anything else fails closed exactly like a completed
    // identity mismatch. Joining matters because handle/ensureParams are not
    // yet published — without this join, a concurrent identical ensure would
    // fall through and createXacpxRuntimeAdapter() a second time, leaking
    // the first AcpRuntime's retained native ACP owner.
    if (state.ensureInFlight.identityKey !== identityKey) {
      throw new RuntimeError(
        "RUNTIME_INIT_FAILED",
        `runtime worker for session "${params.sessionKey}" received ensure params that differ from its in-flight initialization identity; refusing in-worker AcpRuntime replacement — tear down this worker instead`,
      );
    }
    await state.ensureInFlight.promise;
  } else if (state.adapter && !sameEnsureParams(state.ensureParams, params)) {
    throw new RuntimeError(
      "RUNTIME_INIT_FAILED",
      `runtime worker for session "${params.sessionKey}" received ensure params that differ from its immutable launch identity ` +
        `(existing sessionKey=${state.ensureParams?.sessionKey}, agent=${state.ensureParams?.agent}, cwd=${state.ensureParams?.cwd}; ` +
        `got sessionKey=${params.sessionKey}, agent=${params.agent}, cwd=${params.cwd}); ` +
        `refusing in-worker AcpRuntime replacement — tear down this worker instead`,
    );
  } else if (!state.adapter || !state.handle) {
    // Cold first initialization. Registered BEFORE the first await so every
    // concurrent identical ensure joins instead of re-entering. First-ensure
    // resumeSessionId semantics are first-publisher-wins: the initializer
    // carries its own invocation params; joiners wait, then take the warm
    // path (their own mutable options below still apply).
    const initializer = { identityKey, promise: Promise.resolve() as Promise<void> };
    state.ensureInFlight = initializer;
    initializer.promise = initializeRuntime(params).finally(() => {
      if (state.ensureInFlight === initializer) state.ensureInFlight = undefined;
    });
    try {
      await initializer.promise;
    } catch (error) {
      // First initialization failure poisons the worker (WorkerState.initFailed):
      // the created adapter/manager may already retain a native ACP owner we
      // cannot prove dead, so no in-process retry is allowed. The distinct
      // stable code makes the Host terminate + release (fence lifecycle
      // protected) so the next request spawns a fresh worker instead of
      // warm-reusing a poisoned one. Original message is carried through.
      state.initFailed = true;
      const causeMessage = error instanceof Error ? error.message : String(error);
      throw new RuntimeError(
        "RUNTIME_WORKER_POISONED_INIT",
        `runtime initialization failed for session "${params.sessionKey}" and the worker is now poisoned (no in-process retry): ${causeMessage}`,
      );
    }
  }
  if (params.effort && state.handle) {
    // Mutable config on a warm Runtime: apply in place, never rebuild the
    // AcpRuntime (a second live owner inside one worker violates the
    // single-owner invariant, plan §3-R1).
    await applySessionEffort(state.adapter!, state.handle, params.effort);
  }
  const handle = state.handle!;
  return {
    sessionKey: handle.sessionKey,
    ...(handle.acpxRecordId ? { acpxRecordId: handle.acpxRecordId } : {}),
    ...(handle.agentSessionId ? { agentSessionId: handle.agentSessionId } : {}),
  };
}

/** One-shot AcpRuntime + session initialization for the cold ensure path. */
async function initializeRuntime(params: RuntimeWorkerEnsureParams): Promise<void> {
    const initialGen = typeof params.permissionGeneration === "number" ? params.permissionGeneration : 0;
    const { configFromRaw } = await import("./runtime-permission-resolver");
    const initialSnapshot = configFromRaw(initialGen, {
      permissionMode: params.permissionMode,
      nonInteractivePermissions: params.nonInteractivePermissions,
      permissionPolicy: params.permissionPolicy,
    });
    state.permissionSnapshot = initialSnapshot;
    state.permissionGeneration = initialGen;
    const resolver = new RuntimePermissionResolver();
    let mcpServers: import("./runtime-adapter").XacpxMcpServers | undefined;
    if (params.mcpCoordinatorSession) {
      const { buildRuntimeMcpServers } = await import("./runtime-mcp");
      const servers = buildRuntimeMcpServers({
        mcpCoordinatorSession: params.mcpCoordinatorSession,
        mcpSourceHandle: params.mcpSourceHandle,
      });
      if (servers.length > 0) mcpServers = servers as unknown as import("./runtime-adapter").XacpxMcpServers;
      else throw new RuntimeError("RUNTIME_INIT_FAILED", "MCP coordinator requires mcpServers but none were built");
    }
    state.adapter = createXacpxRuntimeAdapter({
      stateDir: params.stateDir,
      permissionMode: params.permissionMode,
      ...(params.nonInteractivePermissions ? { nonInteractivePermissions: params.nonInteractivePermissions } : {}),
      ...(params.permissionPolicy !== undefined ? { permissionPolicy: params.permissionPolicy } : {}),
      ...(params.agentOverrides ? { agentOverrides: params.agentOverrides } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      onPermissionRequest: async (req, ctx) => {
        const snap = state.permissionSnapshot;
        if (!snap) return { outcome: "reject_once" };
        let evaluated: { outcome: "allow_once" | "reject_once" | "needs_interaction" };
        try {
          evaluated = resolver.evaluate(snap, req as unknown as RuntimePermissionRequest, {
            signal: ctx.signal,
            interactiveAvailable: true,
          });
        } catch {
          return { outcome: "reject_once" };
        }
        if (evaluated.outcome === "allow_once") return { outcome: "allow_once" };
        if (evaluated.outcome === "reject_once") return { outcome: "reject_once" };
        if (ctx.signal.aborted) return { outcome: "reject_once" };
        const requestId = `perm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const toolCallId = (() => {
          const raw = (req as unknown as { raw?: unknown }).raw as { toolCall?: { id?: unknown; toolCallId?: unknown } } | undefined;
          const id = typeof raw?.toolCall?.toolCallId === "string" && raw.toolCall.toolCallId.length > 0
            ? raw.toolCall.toolCallId
            : typeof raw?.toolCall?.id === "string" && raw.toolCall.id.length > 0
              ? raw.toolCall.id
              : requestId;
          return id;
        })();
        const title = (() => {
          const raw = (req as unknown as { raw?: unknown }).raw as { toolCall?: { title?: unknown } } | undefined;
          const t = raw?.toolCall?.title;
          return typeof t === "string" ? t : undefined;
        })();
        const kind = (() => {
          const raw = (req as unknown as { raw?: unknown }).raw as { toolCall?: { kind?: unknown } } | undefined;
          const k = raw?.toolCall?.kind;
          return typeof k === "string" ? k : undefined;
        })();
        const rawInput = (req as unknown as { raw?: unknown }).raw;
        const payload: RuntimeWorkerPermissionRequestPayload = {
          logicalSessionId: state.ensureParams?.logicalSessionId ?? params.logicalSessionId ?? state.ensureParams?.sessionKey ?? params.sessionKey,
          sessionKey: state.ensureParams?.sessionKey ?? params.sessionKey,
          requestId,
          toolCallId,
          ...(title ? { title } : {}),
          ...(kind ? { kind } : {}),
          ...(rawInput !== undefined ? { rawInput } : {}),
          policyGeneration: state.permissionGeneration,
          workerGeneration: state.workerGeneration,
        };
        const pending = new Promise<{ outcome: string }>((resolve, reject) => {
          state.pendingPermissions.set(requestId, { resolve: resolve as (d: { outcome: string }) => void, reject, generation: state.permissionGeneration, workerGeneration: state.workerGeneration });
          const onAbort = () => {
            state.pendingPermissions.delete(requestId);
            ctx.signal.removeEventListener("abort", onAbort);
            reject(new Error("permission request aborted"));
          };
          if (ctx.signal.aborted) {
            onAbort();
            return;
          }
          ctx.signal.addEventListener("abort", onAbort, { once: true });
        });
        process.stdout.write(encodeWorkerMessage({ id: requestId, event: "permission.request", payload } satisfies RuntimeWorkerEvent));
        try {
          const decision = await Promise.race([
            pending,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("host permission timeout")), 9_000).unref?.()),
          ]);
          const outcome = decision.outcome;
          if (outcome !== "allow_once" && outcome !== "allow_always" && outcome !== "reject_once" && outcome !== "reject_always" && outcome !== "cancel") {
            return { outcome: "reject_once" };
          }
          return { outcome } as { outcome: "allow_once" | "allow_always" | "reject_once" | "reject_always" | "cancel" };
        } catch {
          return { outcome: "reject_once" };
        } finally {
          state.pendingPermissions.delete(requestId);
        }
      },
    });
    state.ensureParams = params;
    // Same persistent sessionKey reconnects to the existing record after a
    // worker respawn (plan §13).
    // NOTE: no effort here — invocation-specific mutable config (effort) is
    // applied exactly once by the ensure() common path, so the initializer's
    // own invocation does not apply it twice (upstream setters are not
    // guaranteed idempotent, and a second failing mutation after a
    // successful init would put the caller in an unexplainable state).
    state.handle = await state.adapter.ensure({
      sessionKey: params.sessionKey,
      agent: params.agent,
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.resumeSessionId ? { resumeSessionId: params.resumeSessionId } : {}),
      ...(params.model ? { sessionOptions: { model: params.model } } : {}),
    });
  }

async function runPrompt(requestId: string, params: RuntimeWorkerPromptParams): Promise<RuntimeWorkerPromptResult> {
  if (!state.adapter || !state.handle) {
    throw new Error("worker not ensured");
  }
  const onElicitation = async (req: unknown, signal: AbortSignal): Promise<unknown> => {
    if (signal.aborted) throw new Error("elicitation cancelled");
    const elicitationId = `elicit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const payload: RuntimeWorkerElicitationRequestPayload = {
      logicalSessionId: state.ensureParams?.logicalSessionId ?? state.ensureParams?.sessionKey ?? "unknown",
      sessionKey: state.ensureParams?.sessionKey ?? "unknown",
      requestId,
      elicitationId,
      mode: "form",
      message: req,
      policyGeneration: state.permissionGeneration,
      workerGeneration: state.workerGeneration,
    };
    const pending = new Promise<{ action: string; data?: unknown }>((resolve, reject) => {
      state.pendingElicitations.set(elicitationId, { resolve: resolve as (d: { action: string; data?: unknown }) => void, reject, requestId, generation: state.permissionGeneration, workerGeneration: state.workerGeneration });
      const onAbort = () => {
        state.pendingElicitations.delete(elicitationId);
        signal.removeEventListener("abort", onAbort);
        reject(new Error("elicitation cancelled"));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
    process.stdout.write(encodeWorkerMessage({ id: elicitationId, event: "elicitation.request", payload } satisfies RuntimeWorkerEvent));
    try {
      const decision = await Promise.race([
        pending,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("host elicitation timeout")), 30_000).unref?.()),
      ]);
      if (decision.action === "submit") return toUpstreamElicitationAccept(decision.data);
      throw new Error("elicitation cancelled");
    } finally {
      state.pendingElicitations.delete(elicitationId);
    }
  };
  /**
   * Explicit mapping from the xacpx elicitation decision to the pinned
   * acpx/upstream AcpElicitationResponse. submit carries opaque daemon form
   * data and MUST become { action: "accept", content } — never a cast
   * passthrough. Malformed content fails closed (cancel) rather than
   * sending the agent data it did not ask for.
   */
  function toUpstreamElicitationAccept(data: unknown): { action: "accept"; content: Record<string, string | number | boolean | string[]> | null } {
    if (data === undefined || data === null) return { action: "accept", content: null };
    if (typeof data !== "object" || Array.isArray(data)) throw new Error("elicitation cancelled");
    const content: Record<string, string | number | boolean | string[]> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        (Array.isArray(value) && value.every((item): item is string => typeof item === "string"))
      ) {
        content[key] = value;
      } else {
        throw new Error("elicitation cancelled");
      }
    }
    return { action: "accept", content };
  };
  const turn = state.adapter.startTurn({
    handle: state.handle,
    text: params.text,
    ...(params.attachments && params.attachments.length > 0 ? { attachments: params.attachments } : {}),
    onElicitation,
  });
  // Register BEFORE any await: the host's cancel RPC must reach the live
  // turn instead of reporting false-success on an empty activeTurn.
  state.activeTurn = turn;
  try {
    await turn.promptStarted;
    let finalText = "";
    for await (const event of turn.events) {
      // Real-time push (plan §41): each runtime event goes out the moment it
      // arrives — the host forwards it to the bridge while the turn is live.
      // Upstream surfaces plan as a tagged status event ("plan: ..." text).
      const wireEvent =
        event.type === "tool_call"
          ? "tool"
          : event.type === "status" && (event as { tag?: string }).tag === "plan"
            ? "plan"
            : event.type === "status"
              ? "usage"
              : event.type;
      process.stdout.write(
        encodeWorkerMessage({ id: requestId, event: wireEvent, payload: event } satisfies RuntimeWorkerEvent),
      );
      if (event.type === "text_delta" && event.stream !== "thought") finalText += event.text;
    }
    const result = await turn.result;
    return { result, finalText };
  } finally {
    // Identity cleanup: an older turn settling late must never clear a
    // newer turn registered after it.
    if (state.activeTurn === turn) state.activeTurn = undefined;
  }
}

async function dispatch(request: RuntimeWorkerRequest): Promise<void> {
  const { id, method } = request;
  if (method === "shutdown") {
    // I3/I4: quiesced ACK. Shutdown is a CONTROL request — it must NOT be
    // counted in the business gate's inFlight set. Close admission
    // synchronously, drain every already-admitted business dispatch, then
    // ACK. Host may only tree-terminate after this ACK.
    state.shuttingDown = true;
    await gate.close();
    respond({ id, ok: true, result: { quiesced: true } });
    return;
  }
  try {
    switch (method) {
      case "ensure": {
        const handle = await ensure((request.params ?? {}) as RuntimeWorkerEnsureParams);
        respond({ id, ok: true, result: { ready: true, ...handle } });
        break;
      }
      case "prompt": {
        const outcome = await runPrompt(id, (request.params ?? {}) as RuntimeWorkerPromptParams);
        respond({ id, ok: true, result: outcome });
        break;
      }
      case "setMode": {
        const { mode } = request.params as { mode: string };
        if (!state.adapter || !state.handle) throw new Error("worker not ensured");
        await state.adapter.setMode(state.handle, mode);
        respond({ id, ok: true, result: {} });
        break;
      }
      case "setConfigOption": {
        const { key, value } = request.params as { key: string; value: string };
        if (!state.adapter || !state.handle) throw new Error("worker not ensured");
        if (key === "effort") {
          // Resolve the REAL advertised config id (CLI parity) instead of a hardcoded key
          await applySessionEffort(state.adapter, state.handle, value);
        } else {
          await state.adapter.setConfigOption(state.handle, key, value);
        }
        respond({ id, ok: true, result: {} });
        break;
      }
      case "status": {
        if (!state.adapter || !state.handle) throw new Error("worker not ensured");
        respond({ id, ok: true, result: await state.adapter.getStatus(state.handle) });
        break;
      }
      case "cancel": {
        const turn = state.activeTurn;
        if (!turn) {
          respond({ id, ok: true, result: { cancelled: false } });
          break;
        }
        await turn.cancel();
        respond({ id, ok: true, result: { cancelled: true } });
        break;
      }
      case "close": {
        // Explicit close from hard-delete only (plan §19). Ordinary cooling is a
        // worker kill and never routes here.
        if (state.adapter && state.handle) {
          await state.adapter.close(state.handle, { discardPersistentState: true });
          state.handle = undefined;
        }
        respond({ id, ok: true, result: {} });
        break;
      }
      case "permission.update": {
        const update = (request.params ?? {}) as RuntimeWorkerPermissionUpdate;
        const gen = update.generation;
        if (typeof gen !== "number" || !Number.isInteger(gen) || gen <= state.permissionGeneration) {
          respond({ id, ok: false, error: { code: "RUNTIME_INIT_FAILED", message: `stale generation ${String(gen)} current ${state.permissionGeneration}` } });
          break;
        }
        let parsedPolicy: import("./runtime-permission-policy").XacpxPermissionPolicy | undefined;
        if (update.permissionPolicy !== undefined) {
          try {
            parsedPolicy = parseXacpxPermissionPolicy(update.permissionPolicy);
          } catch (err) {
            respond({ id, ok: false, error: { code: "RUNTIME_INIT_FAILED", message: err instanceof Error ? err.message : String(err) } });
            break;
          }
        }
        const isClear = (update as unknown as { clearPermissionPolicy?: boolean }).clearPermissionPolicy === true || update.permissionPolicy === null;
        const next: RuntimePermissionConfig = {
          generation: gen,
          permissionMode: (update.permissionMode as RuntimePermissionConfig["permissionMode"]) ?? state.permissionSnapshot?.permissionMode ?? "approve-all",
          nonInteractivePermissions: (update.nonInteractivePermissions as RuntimePermissionConfig["nonInteractivePermissions"]) ?? state.permissionSnapshot?.nonInteractivePermissions ?? "deny",
          ...(isClear ? {} : parsedPolicy ? { permissionPolicy: parsedPolicy } : update.permissionPolicy === undefined && state.permissionSnapshot?.permissionPolicy ? { permissionPolicy: state.permissionSnapshot.permissionPolicy } : {}),
        };
        state.permissionSnapshot = next;
        state.permissionGeneration = gen;
        // Stale pending permission requests from old generation must not override new policy → fail closed
        for (const [key, entry] of [...state.pendingPermissions.entries()]) {
          if (entry.generation !== gen) {
            entry.reject(new Error("stale generation"));
            state.pendingPermissions.delete(key);
          }
        }
        respond({ id, ok: true, result: { generation: gen, accepted: true } });
        break;
      }
      case "permission.decision": {
        const p = (request.params ?? {}) as RuntimeWorkerPermissionDecisionParams;
        const entry = state.pendingPermissions.get(p.requestId);
        if (!entry) {
          respond({ id, ok: true, result: {} });
          break;
        }
        // Generation fencing: stale response must not override new policy
        if (p.policyGeneration !== entry.generation || p.policyGeneration !== state.permissionGeneration) {
          entry.reject(new Error("stale generation"));
          state.pendingPermissions.delete(p.requestId);
          respond({ id, ok: true, result: { stale: true } });
          break;
        }
        if (p.decision && typeof p.decision.outcome === "string") {
          entry.resolve(p.decision as { outcome: string });
        } else {
          entry.reject(new Error("malformed decision"));
        }
        state.pendingPermissions.delete(p.requestId);
        respond({ id, ok: true, result: {} });
        break;
      }
      case "elicitation.decision": {
        const p = (request.params ?? {}) as RuntimeWorkerElicitationDecisionParams;
        const entry = state.pendingElicitations.get(p.elicitationId);
        if (!entry) {
          respond({ id, ok: true, result: {} });
          break;
        }
        // Generation + identity fencing, mirroring permission.decision: a
        // stale or cross-talk response must never resolve the live prompt's
        // elicitation. Unknown elicitationId is benign (already settled).
        if (
          p.requestId !== entry.requestId ||
          p.policyGeneration !== entry.generation ||
          p.policyGeneration !== state.permissionGeneration
        ) {
          entry.reject(new Error("stale generation"));
          state.pendingElicitations.delete(p.elicitationId);
          respond({ id, ok: true, result: { stale: true } });
          break;
        }
        if (p.decision && (p.decision.action === "submit" || p.decision.action === "cancel")) {
          entry.resolve({ action: p.decision.action, ...(p.decision.data !== undefined ? { data: p.decision.data } : {}) });
        } else {
          entry.reject(new Error("malformed decision"));
        }
        state.pendingElicitations.delete(p.elicitationId);
        respond({ id, ok: true, result: {} });
        break;
      }
      default:
        respond({ id, ok: false, error: { code: "RUNTIME_ENGINE_UNSUPPORTED", message: `unsupported worker method: ${method}` } });
    }
  } catch (error) {
    respond({ id, ok: false, error: mapRuntimeError(error) });
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const parsed = parseWorkerLine(line);
  if (!parsed || parsed.kind !== "request") return;
  // Shutdown is a CONTROL request — it owns quiescence. It must NOT be
  // counted in the business gate's inFlight set, otherwise gate.close()
  // would deadlock waiting for itself. Handle it outside admit/track.
  if (parsed.message.method === "shutdown") {
    void dispatch(parsed.message);
    return;
  }
  // Round 30 Blocking 4: once shutdown/EOF closed admission, a late RPC is
  // refused with the stable teardown code — it must never spawn or mutate
  // the owner tree behind a converging worker.
  if (!gate.admit()) {
    respond({ id: parsed.message.id, ok: false, error: { code: "RUNTIME_WORKER_TEARDOWN_PENDING", message: "runtime worker is shutting down; refusing new dispatch" } });
    return;
  }
  void gate.track(dispatch(parsed.message));
});
// discharges its orphan tree (plan §16 orphan convergence) BEFORE exiting —
// no live host or RuntimeWorkerClient is required at this point:
//   POSIX: the worker was spawned detached, so it is its own process-group
//     leader and acpx adapter descendants inherit the group; kill the group.
//   Windows: no parent-exit-kills-tree semantics exist; converge the verified
//     CIM descendant tree, and durably publish any unverified remainder as
//     residual records the daemon reaper reconciles later (worker-eof.ts).
// There is deliberately NO hard exit cap: the worker resolves only on a
// terminal discharge state (verified cleanup or all ownership durably
// published). While it lingers, it is still ALIVE — the descendant tree has
// its parent and is not orphaned — so exiting without discharge is never the
// lesser evil (plan §16 fail-closed).
// Round 30 Blocking 4: convergence starts ONLY after every in-flight
// dispatch settled. An ensure that is mid-flight when the host dies can
// still spawn the adapter AFTER a snapshot — a "verified empty" snapshot
// taken during that window would orphan the late child. Quiesce first; if
// an operation cannot settle, the worker stays alive and retrying.
process.stdin.on("end", () => {
  const attempt = (): void => {
    void (async () => {
      // Round 32 Blocking 2: gate.close() closes admission SYNCHRONOUSLY and
      // returns the quiescence promise. The durable "discharging" mark lands
      // BEFORE the wait — H2 arriving mid-quiescence sees discharging and
      // waits, never an "admitted" fence it might have killed against.
      const quiesced = gate.close();
      await markRuntimeWorkerFence("discharging");
      await quiesced;
      // Round 32 Blocking 3: spooled residuals are bound to this fence
      // generation, so the new Host's spool handshake can lift the phase
      // once the reaper converges the namespace.
      const outcome = await convergeOrphansBeforeExit({
        agentCommand: () => state.ensureParams?.agent,
        generationId: process.env.XACPX_WORKER_FENCE_GENERATION,
      });
      const terminal = outcome === "spooled" ? "spooled" : "discharged";
      // Round 32 High: the terminal mark is a DURABILITY requirement — a
      // failed write keeps the worker alive and retrying (the mark alone is
      // retried; convergence is never re-run) instead of exiting with a
      // "discharging" fence no later Host can lift.
      for (;;) {
        try {
          await markRuntimeWorkerFence(terminal);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
      process.exit(0);
    })().catch(() => setTimeout(attempt, 1_000));
  };
  attempt();
});
