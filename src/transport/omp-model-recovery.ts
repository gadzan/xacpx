import { spawn, type ChildProcess } from "node:child_process";

import { resolveSpawnCommand } from "../process/spawn-command";
import { isRecord } from "./tool-summary";

// Restores a natively persisted OMP model after a resume that failed with
// `Could not restore model <provider/id>`. Verified against omp v18.10.4:
//
// 1. Relaunch `omp --resume <nativeId> --model <provider/id> --mode rpc
//    --no-ui --no-title --no-lsp` in the session cwd. The explicit --model
//    avoids the restore error but is NOT persisted by OMP on its own.
// 2. Over the newline-delimited JSON RPC: get_state (pins
//    sessionId/sessionFile/model), switch_session with the state's own
//    sessionPath/provider/modelId (OMP appends a model_change entry and keeps
//    the same session id/file), then get_state again to verify.
// 3. End stdin and terminate the helper process. No prompt is ever sent and
//    the session JSONL is never touched — the only stateful mutation is the
//    switch_session RPC.

const RESTORE_MODEL_PATTERN = /Could not restore model ([^\s"'`]+)/i;
// A plausible provider/model id: one or more `/`-separated non-empty segments
// (magpie/group/auto-deepseek-v4-1-flash has two; some agents advertise
// single-segment ids), optionally with a bracketed effort suffix
// (`gpt-5.2[high]`). Template placeholders (`${vr[0]}`) from crash excerpts
// never fit.
const RESTORE_MODEL_ID = /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~:-]+)*(?:\[[^\]]+\])?$/;
 const RESTORE_MODEL_USING_NOTICE = /\bUsing\b/i;
const MODEL_ID_TRAILING_PUNCTUATION = /[.,;:!?]+$/;
// get_state carries the whole session context (systemPrompt, tool schemas),
// so the frame bound is generous; it still exists to stop an unbounded
// stream from eating memory.
const MAX_RPC_LINE_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_CHARS = 32_768;
const DEFAULT_STOP_BUDGET_MS = 5_000;
const BEFORE_ID = "xacpx-recovery-state-before";
const SWITCH_ID = "xacpx-recovery-switch";
const AFTER_ID = "xacpx-recovery-state-after";

export class OmpModelRecoveryError extends Error {
  readonly nativeModelSaved: boolean;
  readonly requestedModelId: string;
  constructor(message: string, requestedModelId: string, nativeModelSaved: boolean) {
    super(message);
    this.name = "OmpModelRecoveryError";
    this.requestedModelId = requestedModelId;
    this.nativeModelSaved = nativeModelSaved;
  }
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function restoreSearchText(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  const parts: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) parts.push(value);
  };
  if (error instanceof Error) {
    push(error.message);
    let cause: unknown = error.cause;
    for (let depth = 0; depth < 3; depth += 1) {
      if (typeof cause === "string") {
        parts.push(cause);
        break;
      }
      if (cause instanceof Error) {
        push(cause.message);
        cause = cause.cause;
        continue;
      }
      break;
    }
    // acpx/PromptCommandError keep the native stderr beside a generic message.
    if ("stderr" in error) push(error.stderr);
    if ("stdout" in error) push(error.stdout);
  } else if (isRecord(error)) {
    for (const key of ["message", "stderr", "stdout", "error"]) push(error[key]);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

 // Narrow match of the exact OMP resume failure `Could not restore model
 // <id>`, optionally wrapped (Error cause chain, or acpx-style result objects
 // carrying message/stderr/stdout). Anything else — including other model
 // errors like "Model not found" or "did not advertise that model" — returns
 // undefined. Frontend mirrors must copy RESTORE_MODEL_PATTERN exactly.
 //
 // When the payload mixes sources (omp prints source-code excerpts on stdout
 // plus the real error on stderr), the pattern can hit template literals like
 // `${vr[0]}` inside the excerpt. The real failure is always the LAST printed
 // line, so scan from the end and take the last non-placeholder-looking match.
 //
 // OMP's non-fatal fallback notice (`Could not restore model X. Using Y`)
 // means the switch SUCCEEDED with a substitute model — that candidate must
 // not trigger a repair. The exclusion is per-candidate (does this match's
 // own line continue with "Using …"), never whole-text: an unrelated excerpt
 // line elsewhere in the payload must not suppress a real failure on the LAST
 // line.
 export function modelRestoreFailure(error: unknown): { modelId: string } | undefined {
   const text = restoreSearchText(error);
   if (!text) return undefined;
   const matches = [...text.matchAll(new RegExp(RESTORE_MODEL_PATTERN.source, "gi"))];
   for (let index = matches.length - 1; index >= 0; index -= 1) {
     const match = matches[index]!;
     const modelId = match[1]!.replace(MODEL_ID_TRAILING_PUNCTUATION, "");
     if (modelId.includes("${") || !RESTORE_MODEL_ID.test(modelId)) continue;
     // Same-line fallback check: only "Using …" following THIS match on its
     // own line suppresses it.
     const lineEnd = text.indexOf("\n", match.index ?? 0);
     const line = text.slice(match.index ?? 0, lineEnd === -1 ? undefined : lineEnd);
     if (RESTORE_MODEL_USING_NOTICE.test(line.slice(match[0].length))) continue;
     return { modelId };
   }
   return undefined;
 }

export interface RecoverOmpSessionModelInput {
  // OMP executable plus already-extracted profile/config flags (no `acp`
  // subcommand — resolve via resolveOmpRecoveryLaunch before calling).
  command: string;
  args?: string[];
  cwd: string;
  agentSessionId: string;
  modelId: string;
  env?: NodeJS.ProcessEnv;
  // Whole-helper bound: one deadline covers the ready frame, both get_state
  // reads, the switch, and process termination.
  timeoutMs: number;
  // Cleanup budget per stop step (stdin EOF, SIGTERM, SIGKILL). Defaults to
  // 5s per step; the cleanup budget is separate from `timeoutMs` so a spent
  // RPC deadline cannot leave the helper process alive.
  stopTimeoutMs?: number;
}

interface OmpRecoveryState {
  sessionId: string;
  sessionFile: string;
  provider: string;
  id: string;
  messageCount: number | undefined;
}

export async function recoverOmpSessionModel(input: RecoverOmpSessionModelInput): Promise<void> {
  const requestedModelId = typeof input.modelId === "string" ? input.modelId : "";
  const slash = requestedModelId.indexOf("/");
  if (
    !input.command || !input.cwd || !input.agentSessionId ||
    slash <= 0 || slash === requestedModelId.length - 1
  ) {
    throw new OmpModelRecoveryError(
      "omp model recovery received an invalid request (command, cwd, agentSessionId, and provider/modelId are required)",
      requestedModelId,
      false,
    );
  }
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new OmpModelRecoveryError("omp model recovery received an invalid timeoutMs", requestedModelId, false);
  }
  const deadline = Date.now() + input.timeoutMs;
  const spec = resolveSpawnCommand(input.command, [
    ...(input.args ?? []),
    "--resume", input.agentSessionId,
    "--model", requestedModelId,
    "--mode", "rpc",
    "--no-ui", "--no-title", "--no-lsp",
  ]);
  let child: ChildProcess;
  try {
    child = spawn(spec.command, spec.args, {
      cwd: input.cwd,
      env: input.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
  } catch (error) {
    throw new OmpModelRecoveryError(
      `omp model recovery failed to spawn: ${error instanceof Error ? error.message : String(error)}`,
      requestedModelId,
      false,
    );
  }
  const stdin = child.stdin;
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdin || !stdout || !stderr) {
    throw new OmpModelRecoveryError("omp model recovery lost its stdio pipes", requestedModelId, false);
  }

  let stderrTail = "";
  let stdoutBuffer = "";
  const lineQueue: string[] = [];
  const lineNotify: Array<() => void> = [];
  let oversizedFrame: string | undefined;
  let spawnError: unknown;
  let closedCode: number | null | undefined;
  // switchAttempted: the switch frame was sent, so the native model MAY
  // already be persisted (OMP can append the model_change and only then fail
  // the switch). switchDelivered: OMP acknowledged the switch, so it IS
  // saved. Only a pre-commit cancellation clears switchAttempted.
  let switchAttempted = false;
  let switchDelivered = false;

  const failure = (message: string): OmpModelRecoveryError => new OmpModelRecoveryError(
    switchAttempted && !switchDelivered
      ? `${message} (switch_session may already have been saved; re-read the native session before retrying)`
      : message,
    requestedModelId,
    switchDelivered,
  );
  const wakeLineWaiters = (): void => {
    for (const notify of lineNotify.splice(0)) notify();
  };
  stderr.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    stderrTail = `${stderrTail}${text}`.slice(-MAX_STDERR_CHARS);
  });
  // A child that exits mid-write makes `stdin` emit EPIPE; without a listener
  // that becomes an uncaught 'error' event instead of the write rejection the
  // recovery path reports.
  stdin.on("error", () => {});
  stdout.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    stdoutBuffer += text;
    let newline = stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_RPC_LINE_BYTES) {
        oversizedFrame = `omp model recovery received an oversized RPC frame (${Buffer.byteLength(line)} bytes)`;
      } else if (line.length > 0) {
        lineQueue.push(line);
      }
      wakeLineWaiters();
      newline = stdoutBuffer.indexOf("\n");
    }
    if (Buffer.byteLength(stdoutBuffer) > MAX_RPC_LINE_BYTES) {
      oversizedFrame = `omp model recovery received an oversized RPC frame (${Buffer.byteLength(stdoutBuffer)} bytes)`;
      wakeLineWaiters();
    }
  });
  child.on("error", (error) => {
    spawnError = error;
    wakeLineWaiters();
  });
  child.on("close", (code) => {
    closedCode = code;
    wakeLineWaiters();
  });

  // Wait for the owned child's `close` event within a budget. The child is
  // OUR OWN handle, so `child.kill` is the platform-safe termination path
  // (Node maps it to TerminateProcess on Windows).
  const waitForClose = async (budgetMs: number): Promise<boolean> => {
    if (closedCode !== undefined) return true;
    return await new Promise<boolean>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const onClose = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      timer = setTimeout(() => {
        child.off("close", onClose);
        resolve(false);
      }, budgetMs);
      child.once("close", onClose);
      // `close` may already have fired before this listener was attached.
      if (closedCode !== undefined) onClose();
    });
  };
  // Graceful stop: close stdin (OMP exits on stdin EOF), then SIGTERM, then
  // SIGKILL — each step waiting for a verified `close`. A process that still
  // has not exited is reported, never swallowed: the caller cannot release
  // its recovery gate while this helper is still alive.
  const stopBudgetMs = input.stopTimeoutMs ?? DEFAULT_STOP_BUDGET_MS;
  const stopChild = async (): Promise<string | undefined> => {
    if (closedCode !== undefined) return undefined;
    try {
      stdin.end();
    } catch {
      // The process may already be gone; the kill steps below still verify.
    }
    if (await waitForClose(stopBudgetMs)) return undefined;
    try {
      child.kill("SIGTERM");
    } catch {
      // Already exited between the close check and the signal.
    }
    if (await waitForClose(stopBudgetMs)) return undefined;
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited between the close check and the signal.
    }
    // `close` only fires once the stdio pipes are released too, so drop them
    // after the final kill — a grandchild holding the pipe must not keep this
    // helper "alive" in this process.
    stdout.destroy();
    stderr.destroy();
    if (await waitForClose(stopBudgetMs)) return undefined;
    return `omp model recovery helper process (pid ${child.pid ?? 0}) did not exit after SIGKILL`;
  };
  const nextLine = async (): Promise<string> => {
    for (;;) {
      if (oversizedFrame) throw failure(oversizedFrame);
      const line = lineQueue.shift();
      if (line !== undefined) return line;
      if (spawnError) {
        throw failure(`omp model recovery process failed to spawn: ${spawnError instanceof Error ? spawnError.message : String(spawnError)}`);
      }
      if (closedCode !== undefined) {
        const tail = stderrTail.trim();
        throw failure(
          tail
            ? `omp model recovery process exited early (code ${closedCode ?? "unknown"}): ${tail.slice(-500)}`
            : `omp model recovery process exited early (code ${closedCode ?? "unknown"})`,
        );
      }
      const waitMs = Math.max(deadline - Date.now(), 1);
      let timer: NodeJS.Timeout | undefined;
      const woken = await new Promise<boolean>((resolve) => {
        const notify = (): void => {
          clearTimeout(timer);
          resolve(true);
        };
        timer = setTimeout(() => {
          const index = lineNotify.indexOf(notify);
          if (index !== -1) lineNotify.splice(index, 1);
          resolve(false);
        }, waitMs);
        lineNotify.push(notify);
      });
      if (!woken) throw failure(`omp model recovery timed out after ${input.timeoutMs}ms`);
    }
  };
  const readResponse = async (id: string): Promise<Record<string, unknown>> => {
    for (;;) {
      const line = await nextLine();
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        throw failure("omp model recovery received a malformed RPC frame");
      }
      if (!isRecord(frame) || frame.type !== "response" || frame.id !== id) continue;
      return frame;
    }
  };
  const writeFrame = async (payload: Record<string, unknown>): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    }).catch((error: unknown) => {
      throw failure(`omp model recovery failed to write ${String(payload.type)}: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const readState = (response: Record<string, unknown>, stage: string): OmpRecoveryState => {
    const data = isRecord(response.data) ? response.data : response;
    const sessionId = stringField(data, "sessionId");
    const sessionFile = stringField(data, "sessionFile");
    const model = isRecord(data.model) ? data.model : undefined;
    const provider = model ? stringField(model, "provider") : undefined;
    const id = model ? stringField(model, "id") : undefined;
    const messageCount = typeof data.messageCount === "number" ? data.messageCount : undefined;
    if (!sessionId || !sessionFile || !provider || !id) {
      throw failure(`omp model recovery received a malformed get_state ${stage} (missing sessionId/sessionFile/model)`);
    }
    return { sessionId, sessionFile, provider, id, messageCount };
  };

  try {
    for (;;) {
      const line = await nextLine();
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        throw failure("omp model recovery received a malformed RPC frame before ready");
      }
      if (isRecord(frame) && frame.type === "ready") break;
    }
    await writeFrame({ id: BEFORE_ID, type: "get_state" });
    const before = readState(await readResponse(BEFORE_ID), "before switch");
    if (before.sessionId !== input.agentSessionId) {
      throw failure(`omp model recovery resumed a different native session (expected ${input.agentSessionId}, got ${before.sessionId})`);
    }
    if (`${before.provider}/${before.id}` !== requestedModelId) {
      throw failure(`omp model recovery native model mismatch (expected ${requestedModelId}, native reports ${before.provider}/${before.id})`);
    }
    switchAttempted = true;
    await writeFrame({
      id: SWITCH_ID,
      type: "switch_session",
      sessionPath: before.sessionFile,
      provider: before.provider,
      modelId: before.id,
    });
    const switchResponse = await readResponse(SWITCH_ID);
    if (switchResponse.success !== true || (isRecord(switchResponse.data) && switchResponse.data.cancelled === true)) {
      const cancelled = isRecord(switchResponse.data) && switchResponse.data.cancelled === true;
      const detail = typeof switchResponse.error === "string"
        ? switchResponse.error
        : cancelled
          ? "switch_session was cancelled by OMP and the model was not applied"
          : "switch_session failed";
      // A cancelled switch is rejected BEFORE the model change is applied, so
      // nothing can have been persisted. A plain failure is NOT that proof:
      // OMP can append the model_change and only then fail the switch, so the
      // native state stays UNKNOWN and switchAttempted must stay true.
      if (cancelled) switchAttempted = false;
      throw failure(`omp model recovery switch_session failed: ${detail}`);
    }
    switchDelivered = true;
    await writeFrame({ id: AFTER_ID, type: "get_state" });
    const after = readState(await readResponse(AFTER_ID), "after switch");
    if (after.sessionId !== input.agentSessionId || after.sessionFile !== before.sessionFile) {
      throw failure(
        `omp model recovery switched to an unexpected native session (expected ${input.agentSessionId} at ${before.sessionFile}, got ${after.sessionId} at ${after.sessionFile})`,
      );
    }
    if (`${after.provider}/${after.id}` !== requestedModelId) {
      throw failure(`omp model recovery model changed after switch (expected ${requestedModelId}, native reports ${after.provider}/${after.id})`);
    }
    // A prompt committed during the switch window would add at least a user and
    // an assistant message (delta >= 2); the switch's own model_change entry may
    // shift the count by one. Older runtimes omit messageCount — only an
    // observed larger delta fails.
    if (before.messageCount !== undefined && after.messageCount !== undefined
      && after.messageCount - before.messageCount >= 2) {
      throw failure(
        `omp model recovery observed new messages during the switch (messageCount ${before.messageCount} -> ${after.messageCount}); refusing to report a clean restore`,
      );
    }
  } catch (error) {
    const stopFailure = await stopChild();
    const base = error instanceof OmpModelRecoveryError
      ? error
      : failure(error instanceof Error ? error.message : String(error));
    if (stopFailure) {
      throw new OmpModelRecoveryError(`${base.message}; ${stopFailure}`, base.requestedModelId, base.nativeModelSaved);
    }
    throw base;
  }
  // The switch is committed: stop the helper and report a surviving process
  // instead of pretending the recovery fully succeeded.
  const stopFailure = await stopChild();
  if (stopFailure) {
    throw new OmpModelRecoveryError(stopFailure, requestedModelId, switchDelivered);
  }
}
