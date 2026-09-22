/**
 * Runtime Worker entry point (plan §9.2): one process per Runtime-bound
 * session. Owns exactly one AcpRuntime + one persistent session handle; killed
 * by the host as the release primitive — so it must NEVER call runtime.close()
 * during ordinary shutdown (that would close the acpx record; plan §17).
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { raceWithTimeout } from "../../../util/async.js";
import { convergeOrphansBeforeExit, markRuntimeWorkerFence } from "./worker-eof";
import { createDispatchGate } from "./runtime-worker-gate";

import {
  createXacpxRuntimeAdapter,
  type XacpxRuntimeAdapter,
} from "./runtime-adapter";
import type {
  XacpxConfigSnapshot,
  XacpxRuntimeSessionHandle,
  XacpxTurnHandle,
} from "./runtime-contract";
import {
  agentProcessEnvIdentityKey,
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
  type RuntimeWorkerElicitationCancelParams,
  type RuntimeElicitationDecision,
  type RuntimeWorkerPromptResult,
} from "./runtime-worker-protocol";
import { mapRuntimeError } from "./runtime-contract";
import { parseSessionEffortRecord } from "../../../transport/session-effort";
import { parseXacpxPermissionPolicy } from "./runtime-permission-policy";
import { RuntimeAgentLeaseStore, createAgentLifecycleHooks } from "./runtime-agent-lease";
import { RuntimePermissionResolver, readToolInputFromReq, type RuntimePermissionConfig, type RuntimePermissionRequest } from "./runtime-permission-resolver";
import { ELICITATION_RPC_TIMEOUT_MS } from "../../../interactions/elicitation-interaction-broker.js";
import { bindElicitationAbort } from "./elicitation-abort-binding";

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
  pendingElicitations: Map<string, { resolve: (d: RuntimeElicitationDecision) => void; reject: (e: Error) => void; promptRequestId: string; workerGeneration: string; abort: AbortController }>;
  workerGeneration: string;
  activeInteractionId?: string;
  /**
   * User-facing Agent alias for the turn currently in flight, taken from the
   * prompt params. Distinct from `ensureParams.agent`, which is the transport
   * selector (possibly an internal overlay alias) used for worker
   * construction.
   */
  activeRequestingAgentName?: string;
  /** Single-flight first initialization: identical-identity concurrent ensures join this; it is cleared on settle. */
  ensureInFlight?: { identityKey: string; promise: Promise<void> };
  /**
   * A failed first initialization poisons the worker: the adapter/manager
   * that was created may have already retained a native ACP owner we cannot
   * prove dead, so a retry inside the same process risks a second live
   * owner. The Host must tear down this worker and respawn a fresh one.
   */
  initFailed?: true;
  /**
   * Direct-agent launch evidence (plan B2). Bound once at first
   * initialization to the owning worker generation; the fence stays the
   * crash-safe ownership source, this store is live admission evidence.
   */
  agentLeases?: RuntimeAgentLeaseStore;
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
    // B1: env is Runtime-construction identity (upstream snapshots at
    // createAcpRuntime). A warm worker silently keeping a stale env is
    // worse than a recycle — mismatch fails closed so the Host respawns.
    agentProcessEnvIdentityKey(p.agentProcessEnv),
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
    // Plan B2: direct-agent-root admission/observation at the real spawn
    // boundary. Bound once: one worker process is one worker generation.
    // ACP agent roots only — terminal/descendant cleanup stays with the
    // fence + worker-eof convergence + residual registry (see
    // runtime-agent-lease.ts for the non-goals).
    state.agentLeases ??= new RuntimeAgentLeaseStore(params.workerGeneration ?? state.workerGeneration);
    const agentLifecycle = createAgentLifecycleHooks({
      generation: () => state.workerGeneration,
      store: state.agentLeases,
    });
    state.adapter = createXacpxRuntimeAdapter({
      stateDir: params.stateDir,
      permissionMode: params.permissionMode,
      ...(params.nonInteractivePermissions ? { nonInteractivePermissions: params.nonInteractivePermissions } : {}),
      processLifecycle: agentLifecycle,
      ...(params.permissionPolicy !== undefined ? { permissionPolicy: params.permissionPolicy } : {}),
      ...(params.agentOverrides ? { agentOverrides: params.agentOverrides } : {}),
      // B1: child-only overlay, snapshotted by upstream at construction and
      // never persisted. Identity-bound above: a changed overlay recycles.
      ...(params.agentProcessEnv ? { agentProcessEnv: params.agentProcessEnv } : {}),
      // G9: advertise exactly what the daemon-capability plumbing allowed —
      // an empty list means the ACP agent never learns elicitation exists.
      ...(params.elicitationModes ? { elicitationModes: params.elicitationModes } : {}),
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
        // Interaction stays non-interactive without an exact-turn route.
        // Scheduled/peer/orchestration/internal prompts carry no interaction
        // id and must fail closed here, never generating a synthetic route.
        const activeInteractionId = state.activeInteractionId;
        if (!activeInteractionId) return { outcome: "reject_once" };
        // UUID: broker pending is daemon-global keyed by requestId, so the
        // id space must not collide under same-millisecond bursts.
        const requestId = randomUUID();
        // Dynamic-key reads need an index signature; the shape checks above
        // are the runtime validation for this acpx-owned payload.
        const asRecord = (value: unknown): Record<string, unknown> | undefined => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
          return value as Record<string, unknown>;
        };
        const rawValue = "raw" in req ? asRecord(req.raw) : undefined;
        const toolValue = rawValue?.toolCall ?? rawValue?.tool;
        const toolRecord = asRecord(toolValue);
        const readField = (holder: Record<string, unknown> | undefined, key: string): string | undefined => {
          if (!holder) return undefined;
          const value = holder[key];
          return typeof value === "string" && value.length > 0 ? value : undefined;
        };
        const toolCallId = readField(toolRecord, "toolCallId") ?? readField(toolRecord, "id") ?? requestId;
        const title = readField(rawValue, "title") ?? readField(toolRecord, "title");
        const inferredKind = "inferredKind" in req && typeof req.inferredKind === "string" && req.inferredKind ? req.inferredKind : undefined;
        const kind = inferredKind ?? readField(rawValue, "kind") ?? readField(toolRecord, "kind");
        // Real operation input via the shared extractor — never the whole ACP
        // envelope (which would summarize as `sessionId: ...` instead of the
        // command/path the user is actually approving).
        const rawInput = readToolInputFromReq(req as unknown as RuntimePermissionRequest);
        const availableOutcomes = (() => {
          const options = rawValue?.options;
          if (!Array.isArray(options)) return undefined;
          const kinds = new Set<string>();
          for (const option of options) {
            const record = asRecord(option);
            if (record && typeof record.kind === "string") kinds.add(record.kind);
          }
          const valid = ["allow_once", "allow_always", "reject_once", "reject_always", "cancel"].filter((k) => kinds.has(k));
          return valid.length > 0 ? valid as Array<"allow_once" | "allow_always" | "reject_once" | "reject_always" | "cancel"> : undefined;
        })();
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
          interactionId: activeInteractionId,
          ...(availableOutcomes ? { availableOutcomes } : {}),
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
          const decision = await raceWithTimeout(pending, 125_000, () => new Error("host permission timeout"));
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
  // M1: the adapter passes the exact upstream request plus its real JSON-RPC
  // id and abort signal. The worker forwards that identity verbatim to the
  // host; it never invents an id, drops the signal, or guesses a route.
  const onElicitation = async (
    req: unknown,
    context: { requestId: string | number | null; signal: AbortSignal },
  ): Promise<{ action: "accept"; content?: Record<string, string | number | boolean | string[]> | null } | { action: "decline" } | { action: "cancel" }> => {
    if (context.signal.aborted) throw new Error("elicitation cancelled");
    const elicitationRequestId = randomUUID();
    const payload: RuntimeWorkerElicitationRequestPayload = {
      logicalSessionId: state.ensureParams?.logicalSessionId ?? state.ensureParams?.sessionKey ?? "unknown",
      sessionKey: state.ensureParams?.sessionKey ?? "unknown",
      promptRequestId: requestId,
      elicitationRequestId,
      acpRequestId: context.requestId,
      request: req,
      // Exact-turn identity only when the owning prompt carried one. Never
      // synthesize a route: the daemon fails closed without it.
      ...(state.activeInteractionId ? { interactionId: state.activeInteractionId } : {}),
      // ACP User Interaction Requirements: the client MUST clearly identify
      // the Agent requesting information — in terms the USER recognises. The
      // turn's own alias is authoritative here, NOT `ensureParams.agent`,
      // which is the transport selector and may be an internal overlay alias
      // like `xacpx-managed-codex-9d1628a76ca9`.
      ...(state.activeRequestingAgentName ? { agentName: state.activeRequestingAgentName } : {}),
      workerGeneration: state.workerGeneration,
    };
    const { promise: pending, reject: rejectElicitation, resolve: resolveElicitation } =
      Promise.withResolvers<RuntimeElicitationDecision>();
    // Request-scoped cancellation: the upstream signal aborts when the
    // elicitation/create itself, its prompt turn, or the session goes away.
    // This second controller exists because the cancel FRAME must also reach
    // the daemon/bridge/broker chain — aborting only the local signal would
    // let the renderer keep collecting input until the 120s deadline while
    // the agent had already withdrawn the request.
    const requestCancel = new AbortController();
    const handlerSignal = AbortSignal.any([context.signal, requestCancel.signal]);
    state.pendingElicitations.set(elicitationRequestId, {
      resolve: resolveElicitation,
      reject: rejectElicitation,
      promptRequestId: requestId,
      workerGeneration: state.workerGeneration,
      abort: requestCancel,
    });
    // Listener lifecycle lives in a testable helper so the release path can be
    // verified directly instead of inferred from a passing E2E. Registered
    // here, released unconditionally in the `finally` below — the success path
    // must release it too, otherwise a long turn with several elicitations
    // accumulates listeners on the merged signal.
    const abort = bindElicitationAbort(handlerSignal, () => {
      state.pendingElicitations.delete(elicitationRequestId);
      rejectElicitation(new Error("elicitation cancelled"));
      // Tell the host to abort its outbound daemon/broker call. Without this
      // the renderer keeps collecting input until the 120s deadline even
      // though nobody will read the answer.
      process.stdout.write(encodeWorkerMessage({
        id: elicitationRequestId,
        event: "elicitation.cancel",
        payload: { promptRequestId: requestId, elicitationRequestId },
      } satisfies RuntimeWorkerEvent));
    });
    process.stdout.write(encodeWorkerMessage({ id: elicitationRequestId, event: "elicitation.request", payload } satisfies RuntimeWorkerEvent));
    // Watchdog handle kept so the SUCCESS path can clear it. Without this a
    // two-second elicitation still holds a 125s timer and an abort listener
    // for the rest of the turn — unref'd so it cannot block exit, but it is a
    // deterministic short-term leak on the happy path.
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      // Business deadline (120s) sits inside the daemon broker; this worker
      // watchdog (ELICITATION_RPC_TIMEOUT_MS) only protects against a wedged
      // host transport and fails closed exactly like the broker's cancel path.
      const decision = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(() => reject(new Error("host elicitation timeout")), ELICITATION_RPC_TIMEOUT_MS);
          watchdog.unref?.();
        }),
      ]);
      return decision;
    } finally {
      clearTimeout(watchdog);
      // Unconditional: the happy path must release the listener too, not only
      // the abort path. Idempotent, so it is safe when registration never
      // happened.
      abort.release();
      state.pendingElicitations.delete(elicitationRequestId);
    }
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
  const promptInteractionId = params.interactionId;
  if (promptInteractionId) state.activeInteractionId = promptInteractionId;
  // The user-facing Agent alias travels with the exact turn, so it is set and
  // cleared on the same lifecycle as the interaction id. A worker is reused
  // across sessions, so this must not be part of the construction identity.
  const promptRequestingAgentName = params.requestingAgentName;
  if (promptRequestingAgentName) state.activeRequestingAgentName = promptRequestingAgentName;
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
    if (promptInteractionId && state.activeInteractionId === promptInteractionId) {
      state.activeInteractionId = undefined;
    }
    if (promptRequestingAgentName && state.activeRequestingAgentName === promptRequestingAgentName) {
      state.activeRequestingAgentName = undefined;
    }
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
        // B3: the accepted snapshot is host-visible on the response. The
        // effort alias resolves through applySessionEffort and reports no
        // snapshot (its accepted state is read back via status, PR C).
        let snapshot: XacpxConfigSnapshot | undefined;
        if (key === "effort") {
          // Resolve the REAL advertised config id (CLI parity) instead of a hardcoded key
          await applySessionEffort(state.adapter, state.handle, value);
        } else {
          snapshot = await state.adapter.setConfigOption(state.handle, key, value);
        }
        respond({ id, ok: true, result: snapshot ? { snapshot } : {} });
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
        const entry = state.pendingElicitations.get(p.elicitationRequestId);
        if (!entry) {
          respond({ id, ok: true, result: {} });
          break;
        }
        // Identity + worker-generation fencing, mirroring
        // permission.decision: a stale or cross-talk response must never
        // resolve the live prompt's elicitation. Unknown
        // elicitationRequestId is benign (already settled).
        if (
          p.promptRequestId !== entry.promptRequestId ||
          entry.workerGeneration !== state.workerGeneration
        ) {
          entry.reject(new Error("stale elicitation decision"));
          state.pendingElicitations.delete(p.elicitationRequestId);
          respond({ id, ok: true, result: { stale: true } });
          break;
        }
        if (
          p.decision
          && (p.decision.action === "accept"
            || p.decision.action === "decline"
            || p.decision.action === "cancel")
        ) {
          entry.resolve(p.decision);
        } else {
          entry.reject(new Error("malformed decision"));
        }
        state.pendingElicitations.delete(p.elicitationRequestId);
        respond({ id, ok: true, result: {} });
        break;
      }
      case "elicitation.cancel": {
        // Request-scoped cancellation. The agent withdrew this single
        // elicitation/create (ACP `$/cancel_request`) while the prompt turn
        // continues. Aborting only the local pending promise is NOT enough:
        // the renderer is sitting in the daemon broker with a live 120s
        // deadline, so the abort has to propagate outbound — through
        // RuntimeEngine -> bridge -> daemon -> broker -> channel — which the
        // decision path already does when it settles cancel.
        const p = (request.params ?? {}) as RuntimeWorkerElicitationCancelParams;
        const entry = state.pendingElicitations.get(p.elicitationRequestId);
        if (!entry) {
          // Unknown id: already settled, or never dispatched. Benign; the
          // caller treats a miss as "nothing left to cancel".
          respond({ id, ok: true, result: { cancelled: false } });
          break;
        }
        const samePrompt = p.promptRequestId === entry.promptRequestId;
        const sameGeneration = entry.workerGeneration === state.workerGeneration;
        if (!samePrompt || !sameGeneration) {
          // Fenced exactly like a decision: cross-talk or a recycled worker
          // must never abort a live request it does not own.
          state.pendingElicitations.delete(p.elicitationRequestId);
          respond({ id, ok: true, result: { cancelled: false, stale: true } });
          break;
        }
        state.pendingElicitations.delete(p.elicitationRequestId);
        // Aborting the controller is what emits the `elicitation.cancel`
        // event: the handler-signal listener in `onElicitation` owns that
        // write, so there is exactly one place that tells the host.
        entry.abort.abort(new Error("elicitation cancelled by agent request"));
        respond({ id, ok: true, result: { cancelled: true } });
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
