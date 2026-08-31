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
  type RuntimeWorkerPromptResult,
} from "./runtime-worker-protocol";
import { mapRuntimeError } from "./runtime-contract";
import { parseSessionEffortRecord } from "../../../transport/session-effort";
import { parseXacpxPermissionPolicy } from "./runtime-permission-policy";
import { RuntimePermissionResolver, type RuntimePermissionConfig } from "./runtime-permission-resolver";

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
}
const gate = createDispatchGate();
const state: WorkerState = { shuttingDown: false, permissionGeneration: 0 };

function respond(response: RuntimeWorkerResponse): void {
  process.stdout.write(encodeWorkerMessage(response));
}

function sameEnsureParams(a: RuntimeWorkerEnsureParams | undefined, b: RuntimeWorkerEnsureParams): boolean {
  if (!a) return false;
  // Runtime-construction identity ONLY. Mutable per-invocation parameters are
  // deliberately excluded:
  //   - `model` / `effort`: applied in place via setConfigOption.
  //   - `resumeSessionId`: a first-ensure INVOCATION parameter, not identity —
  //     resumeAgentSession(X) is always followed by prompt ensures without it.
  //     Including it here would rebuild the AcpRuntime inside one worker and
  //     create a second live ACP owner (violates single-owner, plan §3-R1).
  //   - `permissionMode` / `nonInteractivePermissions` / `permissionPolicy`: mutable snapshot (PR7 live update)
  return (
    a.sessionKey === b.sessionKey &&
    a.agent === b.agent &&
    a.cwd === b.cwd &&
    a.stateDir === b.stateDir &&
    JSON.stringify(a.agentOverrides ?? null) === JSON.stringify(b.agentOverrides ?? null) &&
    (a.mcpCoordinatorSession ?? null) === (b.mcpCoordinatorSession ?? null) &&
    (a.mcpSourceHandle ?? null) === (b.mcpSourceHandle ?? null)
  );
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
  // Single-owner invariant (plan §3-R1): once an adapter exists in this worker,
  // it is NEVER replaced. The Worker process IS the AcpRuntime lifecycle
  // primitive (plan §9.2) — a genuine immutable-identity change must fail
  // closed so the Host tears down the whole worker and spawns a fresh one,
  // because the pinned acpx public Runtime has no dispose primitive and a
  // replacement here would leak the retained native ACP owner (dual owner).
  if (state.adapter && !sameEnsureParams(state.ensureParams, params)) {
    throw new RuntimeError(
      "RUNTIME_INIT_FAILED",
      `runtime worker for session "${params.sessionKey}" received ensure params that differ from its immutable launch identity ` +
        `(existing sessionKey=${state.ensureParams?.sessionKey}, agent=${state.ensureParams?.agent}, cwd=${state.ensureParams?.cwd}; ` +
        `got sessionKey=${params.sessionKey}, agent=${params.agent}, cwd=${params.cwd}); ` +
        `refusing in-worker AcpRuntime replacement — tear down this worker instead`,
    );
  }
  if (!state.adapter || !state.handle) {
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
    let mcpServers: import("acpx/runtime").AcpRuntimeOptions["mcpServers"] | undefined;
    if (params.mcpCoordinatorSession) {
      try {
        const { buildRuntimeMcpServers } = await import("./runtime-mcp");
        const servers = buildRuntimeMcpServers({
          mcpCoordinatorSession: params.mcpCoordinatorSession,
          mcpSourceHandle: params.mcpSourceHandle,
        });
        if (servers.length > 0) mcpServers = servers as unknown as import("acpx/runtime").AcpRuntimeOptions["mcpServers"];
      } catch {}
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
        try {
          return resolver.safeResolve(snap, req, ctx.signal);
        } catch {
          return { outcome: "reject_once" };
        }
      },
    });
    state.ensureParams = params;
    // Same persistent sessionKey reconnects to the existing record after a
    // worker respawn (plan §13).
    state.handle = await state.adapter.ensure({
      sessionKey: params.sessionKey,
      agent: params.agent,
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.resumeSessionId ? { resumeSessionId: params.resumeSessionId } : {}),
      ...(params.model ? { sessionOptions: { model: params.model } } : {}),
    });
    if (params.effort) {
      await applySessionEffort(state.adapter, state.handle!, params.effort);
    }
  } else if (params.effort && state.handle) {
    // Mutable config on a warm Runtime: apply in place, never rebuild the
    // AcpRuntime (a second live owner inside one worker violates the
    // single-owner invariant, plan §3-R1).
    await applySessionEffort(state.adapter, state.handle, params.effort);
  }
  const handle = state.handle!;
  return {
    sessionKey: handle.sessionKey,
    ...(handle.acpxRecordId ? { acpxRecordId: handle.acpxRecordId } : {}),
    ...(handle.agentSessionId ? { agentSessionId: handle.agentSessionId } : {}),
  };
}

async function runPrompt(requestId: string, params: RuntimeWorkerPromptParams): Promise<RuntimeWorkerPromptResult> {
  if (!state.adapter || !state.handle) {
    throw new Error("worker not ensured");
  }
  const turn = state.adapter.startTurn({
    handle: state.handle,
    text: params.text,
    ...(params.attachments && params.attachments.length > 0 ? { attachments: params.attachments } : {}),
  });
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
    state.activeTurn = undefined;
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
        if (state.activeTurn) {
          await state.activeTurn.cancel();
        }
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
        respond({ id, ok: true, result: { generation: gen, accepted: true } });
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
