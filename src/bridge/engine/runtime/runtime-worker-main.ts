/**
 * Runtime Worker entry point (plan §9.2): one process per Runtime-bound
 * session. Owns exactly one AcpRuntime + one persistent session handle; killed
 * by the host as the release primitive — so it must NEVER call runtime.close()
 * during ordinary shutdown (that would close the acpx record; plan §17).
 */
import { createInterface } from "node:readline";

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

interface WorkerState {
  adapter?: XacpxRuntimeAdapter;
  handle?: XacpxRuntimeSessionHandle;
  ensureParams?: RuntimeWorkerEnsureParams;
  activeTurn?: XacpxTurnHandle;
  shuttingDown: boolean;
}

const state: WorkerState = { shuttingDown: false };

function respond(response: RuntimeWorkerResponse): void {
  process.stdout.write(encodeWorkerMessage(response));
}

function sameEnsureParams(a: RuntimeWorkerEnsureParams | undefined, b: RuntimeWorkerEnsureParams): boolean {
  if (!a) return false;
  return (
    a.sessionKey === b.sessionKey &&
    a.agent === b.agent &&
    a.cwd === b.cwd &&
    a.stateDir === b.stateDir &&
    a.permissionMode === b.permissionMode &&
    a.nonInteractivePermissions === b.nonInteractivePermissions &&
    a.resumeSessionId === b.resumeSessionId &&
    a.model === b.model &&
    JSON.stringify(a.permissionPolicy ?? null) === JSON.stringify(b.permissionPolicy ?? null) &&
    JSON.stringify(a.agentOverrides ?? null) === JSON.stringify(b.agentOverrides ?? null)
  );
}

async function ensure(params: RuntimeWorkerEnsureParams): Promise<{ sessionKey: string; acpxRecordId?: string; agentSessionId?: string }> {
  // Value comparison: each request's params are a fresh JSON.parse result, so
  // reference equality would rebuild the AcpRuntime on EVERY ensure (leaking
  // the previous one and defeating warm reuse).
  if (!state.adapter || !state.handle || !sameEnsureParams(state.ensureParams, params)) {
    state.adapter = createXacpxRuntimeAdapter({
      stateDir: params.stateDir,
      permissionMode: params.permissionMode,
      ...(params.nonInteractivePermissions ? { nonInteractivePermissions: params.nonInteractivePermissions } : {}),
      ...(params.permissionPolicy !== undefined ? { permissionPolicy: params.permissionPolicy } : {}),
      ...(params.agentOverrides ? { agentOverrides: params.agentOverrides } : {}),
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
  const turn = state.adapter.startTurn({ handle: state.handle, text: params.text });
  state.activeTurn = turn;
  try {
    await turn.promptStarted;
    let finalText = "";
    for await (const event of turn.events) {
      // Real-time push (plan §41): each runtime event goes out the moment it
      // arrives — the host forwards it to the bridge while the turn is live.
      const wireEvent = event.type === "tool_call" ? "tool" : event.type === "status" ? "usage" : event.type;
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
    state.shuttingDown = true;
    respond({ id, ok: true, result: {} });
    // Plan §16 / G10: Do NOT call process.exit(0) immediately!
    // On Windows, the tree terminator (terminateWindowsProcessTree) MUST find the root process
    // alive with verified creationDate in order to enumerate and kill child adapter descendants.
    // Quiesce and let the host terminate the process tree. Keep a fallback timer in case host hangs.
    const fallbackTimer = setTimeout(() => {
      process.exit(0);
    }, 10_000);
    fallbackTimer.unref?.();
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
        await state.adapter.setConfigOption(state.handle, key, value);
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
        // Snapshot update; generation ordering enforced by the host (plan §33).
        const update = (request.params ?? {}) as RuntimeWorkerPermissionUpdate;
        respond({ id, ok: true, result: { generation: update.generation, accepted: true } });
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
  void dispatch(parsed.message);
});
// stdin EOF means the host is gone (crash or deliberate kill path) — exit so no
// orphaned adapter children outlive an absent owner.
process.stdin.on("end", () => process.exit(0));
