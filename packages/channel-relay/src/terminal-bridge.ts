// Hub ↔ connector terminal request/event routing onto RelayTerminalRuntime.
// Keeps channel.ts free of per-MSG payload mapping details.
import {
  MSG,
  MAX_TERMINAL_INPUT_BYTES,
  errorPayload,
  parseCanonicalBase64,
  parseControlPayload,
  parseTerminalEventPayload,
  type RelayEnvelope,
  type TerminalResourceExitPayload,
  type TerminalViewerEventInner,
  type TerminalViewerEventPayload,
} from "@ganglion/xacpx-relay-protocol";

import {
  TerminalRuntimeError,
  toTerminalOpenWireResult,
  type DefaultRelayTerminalRuntime,
  type TerminalViewerEvent,
} from "./terminal/terminal-runtime.js";

export type TerminalSendEvent = (
  type: string,
  payload: unknown,
  onFlush?: (error?: Error) => void,
) => void;

const TERMINAL_REQ_TYPES = new Set<string>([
  MSG.terminalOpen,
  MSG.terminalTakeControl,
  MSG.terminalResync,
  MSG.terminalTerminate,
]);

const TERMINAL_EVENT_TYPES = new Set<string>([
  MSG.terminalStreamStart,
  MSG.terminalInput,
  MSG.terminalResize,
  MSG.terminalHeartbeat,
  MSG.terminalDetach,
]);

export function isTerminalRequestType(type: string): boolean {
  return TERMINAL_REQ_TYPES.has(type);
}

export function isTerminalEventType(type: string): boolean {
  return TERMINAL_EVENT_TYPES.has(type);
}

export function createTerminalViewerPublisher(
  runtime: DefaultRelayTerminalRuntime,
  sendEvent: TerminalSendEvent,
): (
  event: TerminalViewerEvent,
  onFlush?: (error?: Error) => void,
) => void {
  const exited = new Set<string>();
  return (event, onFlush) => {
    if (event.type === "exit") {
      const key = `${event.terminalId}:${event.generation}`;
      if (exited.has(key)) {
        onFlush?.();
        return;
      }
      exited.add(key);
      const payload: TerminalResourceExitPayload = {
        terminalId: event.terminalId,
        generation: event.generation,
        reason: event.reason,
        ...(event.code !== undefined ? { code: event.code } : {}),
      };
      sendEvent(MSG.terminalResourceExit, payload, onFlush);
      return;
    }

    const meta = runtime.peekAttachment(event.attachmentId);
    if (!meta) {
      onFlush?.(new Error("attachment-gone"));
      return;
    }
    const inner = toViewerInner(event);
    if (!inner) {
      onFlush?.();
      return;
    }
    const payload: TerminalViewerEventPayload = {
      viewerId: meta.viewerId,
      attachmentId: event.attachmentId,
      event: inner,
    };
    sendEvent(MSG.terminalViewerEvent, payload, onFlush);
  };
}

function toViewerInner(event: TerminalViewerEvent): TerminalViewerEventInner | null {
  switch (event.type) {
    case "rebase-start":
      return {
        kind: "terminal-rebase-start",
        generation: event.generation,
        epoch: event.epoch,
        nextSequence: event.nextSequence,
        cols: event.cols,
        rows: event.rows,
        alternate: event.alternate,
        totalBytes: event.totalBytes,
        chunkCount: event.chunkCount,
      };
    case "rebase-chunk":
      return {
        kind: "terminal-rebase-chunk",
        generation: event.generation,
        epoch: event.epoch,
        index: event.index,
        dataBase64: event.dataBase64,
      };
    case "rebase-end":
      return {
        kind: "terminal-rebase-end",
        generation: event.generation,
        epoch: event.epoch,
      };
    case "bytes":
      return {
        kind: "terminal-bytes",
        generation: event.generation,
        epoch: event.epoch,
        sequence: event.sequence,
        dataBase64: event.dataBase64,
      };
    case "role-changed":
      return {
        kind: "terminal-role-changed",
        terminalId: event.terminalId,
        role: event.role,
        viewerCount: event.viewerCount,
      };
    case "queue-overflow":
      return {
        kind: "terminal-recovery-failed",
        generation: event.generation,
        code: "terminal-recovery-too-large",
        message: "attachment outbound queue overflow",
      };
    case "recovery-failed":
      return {
        kind: "terminal-recovery-failed",
        generation: event.generation,
        code: event.code,
        message: event.message,
      };
    default:
      return null;
  }
}

function runtimeErrorPayload(err: unknown): ReturnType<typeof errorPayload> {
  if (err instanceof TerminalRuntimeError) {
    return errorPayload(err.code, err.message);
  }
  return errorPayload(
    "terminal-rmux-unavailable",
    err instanceof Error ? err.message : String(err),
  );
}

/**
 * Hub publishes both absolute and relative cutoffs so delivery delay cannot
 * eat the response reserve. Missing/partial deadlines are treated as absent
 * (unit tests / legacy envelopes) rather than fail-closed-to-now.
 */
export function terminalRequestDeadlineAt(
  envelope: Pick<RelayEnvelope, "requestDeadlineAt" | "requestBudgetMs">,
  now: () => number = Date.now,
): number | undefined {
  const absolute = envelope.requestDeadlineAt;
  const budget = envelope.requestBudgetMs;
  if (
    typeof absolute !== "number" || !Number.isFinite(absolute) || absolute <= 0
    || typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0
  ) {
    return undefined;
  }
  const receivedAt = now();
  return Math.min(absolute, receivedAt + budget);
}

/** Handle a terminal req/res envelope. Returns true if consumed. */
export async function handleTerminalRequest(
  runtime: DefaultRelayTerminalRuntime,
  envelope: RelayEnvelope,
  respond: (payload: unknown) => void,
  options?: {
    now?: () => number;
    setTimeoutFn?: (fn: () => void, ms: number) => unknown;
    clearTimeoutFn?: (timer: unknown) => void;
  },
): Promise<boolean> {
  if (!isTerminalRequestType(envelope.type)) return false;

  const now = options?.now ?? Date.now;
  const setTimeoutFn = options?.setTimeoutFn
    ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimeoutFn = options?.clearTimeoutFn
    ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));

  let settled = false;
  let timedOut = false;
  let timer: unknown;
  const respondOnce = (payload: unknown) => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) {
      clearTimeoutFn(timer);
      timer = undefined;
    }
    respond(payload);
  };

  const deadlineAt = terminalRequestDeadlineAt(envelope, now);
  if (deadlineAt !== undefined) {
    const remaining = deadlineAt - now();
    if (remaining <= 0) {
      respondOnce(errorPayload("timeout", `rpc ${envelope.type} missed request deadline`));
      return true;
    }
    timer = setTimeoutFn(() => {
      timedOut = true;
      respondOnce(errorPayload("timeout", `rpc ${envelope.type} exceeded request deadline`));
    }, remaining);
  }

  try {
    switch (envelope.type) {
      case MSG.terminalOpen: {
        const p = parseControlPayload(MSG.terminalOpen, envelope.payload);
        if (!p) {
          respondOnce(errorPayload("invalid-payload", `${MSG.terminalOpen}: malformed payload`));
          return true;
        }
        const result = await runtime.openOrResume({
          chatKey: p.chatKey,
          sessionAlias: p.sessionAlias,
          viewerId: p.viewerId,
          cols: p.cols,
          rows: p.rows,
        });
        // Once the request deadline has fired, this browser no longer owns an
        // unpublished open. Compensation may detach/clean it up, but it must
        // not mutate shared terminal state (notably geometry) after timeout.
        if (timedOut) {
          void runtime.compensateTimedOutOpen(result).catch(() => {});
          return true;
        }
        // Commit phase: once openOrResume succeeds in time, disarm the request
        // timer so the connector does not declare a timeout mid-resize after
        // committing to the attachment and authoritative geometry convergence.
        if (timer !== undefined) {
          clearTimeoutFn(timer);
          timer = undefined;
        }
        // A create already passes the requested geometry into driver.create().
        // A resume used to ignore it completely and relied on a later browser
        // fire-and-forget resize, so a stale 80x24 pane could survive a refresh
        // indefinitely. The controller open is authoritative: converge the
        // durable pane before acknowledging terminal-open. Spectators never
        // resize the shared pane.
        if (result.openKind === "resumed" && result.role === "controller") {
          try {
            await runtime.resize(result.attachmentId, result.generation, p.cols, p.rows);
          } catch (err) {
            // The Hub has not seen this attachment yet. Roll it back so a
            // failed authoritative resize cannot leave a phantom viewer bound
            // to a terminal-open request that returns an error.
            runtime.detach(result.attachmentId);
            throw err;
          }
        }
        respondOnce(toTerminalOpenWireResult(result));
        return true;
      }
      case MSG.terminalTakeControl: {
        const p = parseControlPayload(MSG.terminalTakeControl, envelope.payload);
        if (!p) {
          respondOnce(errorPayload("invalid-payload", `${MSG.terminalTakeControl}: malformed payload`));
          return true;
        }
        const result = await runtime.takeControl(p.attachmentId, p.generation);
        if (timedOut) return true;
        respondOnce(result);
        return true;
      }
      case MSG.terminalResync: {
        const p = parseControlPayload(MSG.terminalResync, envelope.payload);
        if (!p) {
          respondOnce(errorPayload("invalid-payload", `${MSG.terminalResync}: malformed payload`));
          return true;
        }
        await runtime.resync(p.attachmentId, p.generation);
        if (timedOut) return true;
        respondOnce({ ok: true });
        return true;
      }
      case MSG.terminalTerminate: {
        const p = parseControlPayload(MSG.terminalTerminate, envelope.payload);
        if (!p) {
          respondOnce(errorPayload("invalid-payload", `${MSG.terminalTerminate}: malformed payload`));
          return true;
        }
        const result = await runtime.terminate({
          terminalId: p.terminalId,
          generation: p.generation,
          reason: "explicit-close",
        });
        // Late terminate after Hub timeout is still useful cleanup; respond if
        // the Hub is still waiting, otherwise leave the side effect alone.
        if (timedOut) return true;
        respondOnce(result);
        return true;
      }
      default:
        return false;
    }
  } catch (err) {
    if (!timedOut && !settled) respondOnce(runtimeErrorPayload(err));
    return true;
  } finally {
    if (timer !== undefined) {
      clearTimeoutFn(timer);
      timer = undefined;
    }
  }
}

/** Handle a terminal fire-and-forget event. Returns true if consumed. */
export async function handleTerminalEvent(
  runtime: DefaultRelayTerminalRuntime,
  envelope: RelayEnvelope,
): Promise<boolean> {
  if (!isTerminalEventType(envelope.type)) return false;
  try {
    switch (envelope.type) {
      case MSG.terminalStreamStart: {
        const p = parseTerminalEventPayload(MSG.terminalStreamStart, envelope.payload);
        if (!p) return true;
        await runtime.startRecovery(p.attachmentId);
        return true;
      }
      case MSG.terminalInput: {
        const p = parseTerminalEventPayload(MSG.terminalInput, envelope.payload);
        if (!p) return true;
        const bytes = parseCanonicalBase64(p.dataBase64, MAX_TERMINAL_INPUT_BYTES);
        if (!bytes) return true;
        await runtime.input(p.attachmentId, p.generation, bytes);
        return true;
      }
      case MSG.terminalResize: {
        const p = parseTerminalEventPayload(MSG.terminalResize, envelope.payload);
        if (!p) return true;
        await runtime.resize(p.attachmentId, p.generation, p.cols, p.rows);
        return true;
      }
      case MSG.terminalHeartbeat: {
        const p = parseTerminalEventPayload(MSG.terminalHeartbeat, envelope.payload);
        if (!p) return true;
        runtime.heartbeat(p.attachmentId);
        return true;
      }
      case MSG.terminalDetach: {
        const p = parseTerminalEventPayload(MSG.terminalDetach, envelope.payload);
        if (!p) return true;
        runtime.detach(p.attachmentId);
        return true;
      }
      default:
        return false;
    }
  } catch {
    // Events are fire-and-forget; runtime fences/errors are observable via
    // resource-exit / viewer-event frames, not RPC responses.
    return true;
  }
}