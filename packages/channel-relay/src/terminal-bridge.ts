// Hub ↔ connector terminal request/event routing onto RelayTerminalRuntime.
// Keeps channel.ts free of per-MSG payload mapping details.
import {
  MSG,
  MAX_TERMINAL_INPUT_BYTES,
  errorPayload,
  parseCanonicalBase64,
  type RelayEnvelope,
  type TerminalDetachPayload,
  type TerminalHeartbeatPayload,
  type TerminalInputPayload,
  type TerminalOpenPayload,
  type TerminalResyncPayload,
  type TerminalResizePayload,
  type TerminalResourceExitPayload,
  type TerminalStreamStartPayload,
  type TerminalTakeControlPayload,
  type TerminalTerminatePayload,
  type TerminalViewerEventInner,
  type TerminalViewerEventPayload,
} from "@ganglion/xacpx-relay-protocol";

import {
  TerminalRuntimeError,
  type DefaultRelayTerminalRuntime,
  type TerminalViewerEvent,
} from "./terminal/terminal-runtime.js";

export type TerminalSendEvent = (type: string, payload: unknown) => void;

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
): (event: TerminalViewerEvent) => void {
  const exited = new Set<string>();
  return (event) => {
    if (event.type === "exit") {
      const key = `${event.terminalId}:${event.generation}`;
      if (exited.has(key)) return;
      exited.add(key);
      const payload: TerminalResourceExitPayload = {
        terminalId: event.terminalId,
        generation: event.generation,
        reason: event.reason,
        ...(event.code !== undefined ? { code: event.code } : {}),
      };
      sendEvent(MSG.terminalResourceExit, payload);
      return;
    }

    const meta = runtime.peekAttachment(event.attachmentId);
    if (!meta) return;
    const inner = toViewerInner(event);
    if (!inner) return;
    const payload: TerminalViewerEventPayload = {
      viewerId: meta.viewerId,
      attachmentId: event.attachmentId,
      event: inner,
    };
    sendEvent(MSG.terminalViewerEvent, payload);
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
        kind: "terminal-request-failed",
        code: "terminal-recovery-too-large",
        message: "attachment outbound queue overflow",
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

/** Handle a terminal req/res envelope. Returns true if consumed. */
export async function handleTerminalRequest(
  runtime: DefaultRelayTerminalRuntime,
  envelope: RelayEnvelope,
  respond: (payload: unknown) => void,
): Promise<boolean> {
  if (!isTerminalRequestType(envelope.type)) return false;
  try {
    switch (envelope.type) {
      case MSG.terminalOpen: {
        const p = envelope.payload as TerminalOpenPayload;
        const result = await runtime.openOrResume({
          chatKey: p.chatKey,
          sessionAlias: p.sessionAlias,
          viewerId: p.viewerId,
          cols: p.cols,
          rows: p.rows,
        });
        respond(result);
        return true;
      }
      case MSG.terminalTakeControl: {
        const p = envelope.payload as TerminalTakeControlPayload;
        respond(await runtime.takeControl(p.attachmentId, p.generation));
        return true;
      }
      case MSG.terminalResync: {
        const p = envelope.payload as TerminalResyncPayload;
        await runtime.resync(p.attachmentId, p.generation);
        respond({ ok: true });
        return true;
      }
      case MSG.terminalTerminate: {
        const p = envelope.payload as TerminalTerminatePayload;
        respond(
          await runtime.terminate({
            terminalId: p.terminalId,
            generation: p.generation,
            reason: "explicit-close",
          }),
        );
        return true;
      }
      default:
        return false;
    }
  } catch (err) {
    respond(runtimeErrorPayload(err));
    return true;
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
        const p = envelope.payload as TerminalStreamStartPayload;
        await runtime.startRecovery(p.attachmentId);
        return true;
      }
      case MSG.terminalInput: {
        const p = envelope.payload as TerminalInputPayload;
        const bytes = parseCanonicalBase64(p.dataBase64, MAX_TERMINAL_INPUT_BYTES);
        if (!bytes) return true;
        await runtime.input(p.attachmentId, p.generation, bytes);
        return true;
      }
      case MSG.terminalResize: {
        const p = envelope.payload as TerminalResizePayload;
        await runtime.resize(p.attachmentId, p.generation, p.cols, p.rows);
        return true;
      }
      case MSG.terminalHeartbeat: {
        const p = envelope.payload as TerminalHeartbeatPayload;
        runtime.heartbeat(p.attachmentId);
        return true;
      }
      case MSG.terminalDetach: {
        const p = envelope.payload as TerminalDetachPayload;
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
