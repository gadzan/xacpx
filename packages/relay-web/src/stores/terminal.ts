import { defineStore } from "pinia";
import { ref } from "vue";
import type { WebServerEvent } from "@ganglion/xacpx-relay-protocol";
import {
  isRetryableTerminalError,
  nextTerminalRequestId,
  requestTerminal,
  sendWebClientMessage,
  setEventsReconnectHandler,
  TerminalRequestError,
} from "../api/events";
import {
  initialRecoveryState,
  reduceRecovery,
  type RecoveryState,
} from "../lib/terminal-recovery";

export type TerminalRole = "controller" | "spectator";

export interface TerminalAttachmentView {
  localKey: string;
  instanceId: string;
  sessionAlias: string;
  cols: number;
  rows: number;
  terminalId?: string;
  generation?: string;
  attachmentId?: string;
  role?: TerminalRole;
  viewerCount?: number;
  recovery: RecoveryState;
  /** True while this local tab wants a live attachment. */
  active: boolean;
  terminatePending: boolean;
  /** Set when terminate failed offline/timeout — UI may retry; tab stays. */
  terminateRetryable: boolean;
  lastErrorCode?: string;
  exitReason?: string;
  exitCode?: number;
}

type RebaseCb = (localKey: string, keyframe: Uint8Array, cols: number, rows: number) => void | Promise<void>;
type BytesCb = (localKey: string, data: Uint8Array) => void | Promise<void>;
type MetaCb = (localKey: string, view: TerminalAttachmentView) => void;
type AttachmentExitCb = (localKey: string, reason: string, code?: number) => void;

const HEARTBEAT_MS = 10_000;

export function terminalLocalKey(instanceId: string, sessionAlias: string): string {
  return `${instanceId}\0${sessionAlias}`;
}

function utf8ToCanonicalBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export const useTerminalStore = defineStore("terminal", () => {
  const attachments = ref(new Map<string, TerminalAttachmentView>());

  const rebaseCbs = new Set<RebaseCb>();
  const bytesCbs = new Set<BytesCb>();
  const metaCbs = new Set<MetaCb>();
  const attachmentExitCbs = new Set<AttachmentExitCb>();

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const resyncInFlight = new Set<string>();
  /** One extra stream-start while recover is still waiting (key-mash debounce). */
  const waitingStreamStartInFlight = new Set<string>();

  function ensureReconnectHook(): void {
    setEventsReconnectHandler(() => {
      void reopenActiveAttachments();
    });
  }

  function publishMeta(view: TerminalAttachmentView): void {
    for (const cb of metaCbs) cb(view.localKey, view);
  }

  function put(view: TerminalAttachmentView): void {
    const next = new Map(attachments.value);
    next.set(view.localKey, view);
    attachments.value = next;
    publishMeta(view);
  }

  function get(localKey: string): TerminalAttachmentView | undefined {
    return attachments.value.get(localKey);
  }

  function listActive(): TerminalAttachmentView[] {
    return [...attachments.value.values()].filter((a) => a.active);
  }

  function refreshHeartbeat(): void {
    const anyAttached = listActive().some((a) => !!a.attachmentId);
    if (anyAttached && !heartbeatTimer) {
      heartbeatTimer = setInterval(() => {
        for (const a of listActive()) {
          if (!a.attachmentId) continue;
          sendWebClientMessage({
            kind: "terminal-heartbeat",
            instanceId: a.instanceId,
            attachmentId: a.attachmentId,
          });
        }
      }, HEARTBEAT_MS);
    } else if (!anyAttached && heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  async function applyRecoveryAction(
    localKey: string,
    action: ReturnType<typeof reduceRecovery>["action"],
  ): Promise<void> {
    if (action.type === "apply-rebase") {
      try {
        await Promise.all([...rebaseCbs].map((cb) => cb(localKey, action.keyframe, action.cols, action.rows)));
      } catch {
        await requestResync(localKey, "adapter-rebase-failed");
      }
      return;
    }
    if (action.type === "write-bytes") {
      try {
        await Promise.all([...bytesCbs].map((cb) => cb(localKey, action.data)));
      } catch {
        await requestResync(localKey, "adapter-write-failed");
      }
      return;
    }
    if (action.type === "request-resync") {
      // Fire-and-forget: do not block event application on the 10s resync ack.
      void requestResync(localKey, action.reason);
    }
  }

  async function requestResync(localKey: string, _reason: string): Promise<void> {
    const view = get(localKey);
    if (!view?.attachmentId || !view.generation || !view.active) return;
    if (resyncInFlight.has(localKey)) return;
    resyncInFlight.add(localKey);
    try {
      // Ensure phase is resyncing even when called from adapter failure.
      if (view.recovery.phase !== "resyncing") {
        const stepped = reduceRecovery(view.recovery, { kind: "resync-started" });
        put({ ...view, recovery: stepped.state });
      }
      await requestTerminal(
        {
          kind: "terminal-resync",
          requestId: nextTerminalRequestId(),
          instanceId: view.instanceId,
          attachmentId: view.attachmentId,
          generation: view.generation,
        },
        { expect: "ack" },
      );
    } catch {
      // Keep resyncing; a later reconnect/openOrResume will recover.
    } finally {
      resyncInFlight.delete(localKey);
    }
  }

  /**
   * Open or resume the durable terminal for a local tab. Keys by local tab/session,
   * never treats terminalId as the browser identity.
   */
  async function openOrResume(
    localKey: string,
    opts: { instanceId: string; sessionAlias: string; cols: number; rows: number },
  ): Promise<TerminalAttachmentView> {
    ensureReconnectHook();
    const existing = get(localKey);
    if (existing?.attachmentId) {
      sendWebClientMessage({
        kind: "terminal-detach",
        instanceId: existing.instanceId,
        attachmentId: existing.attachmentId,
      });
    }
    let view: TerminalAttachmentView = existing ?? {
      localKey,
      instanceId: opts.instanceId,
      sessionAlias: opts.sessionAlias,
      cols: opts.cols,
      rows: opts.rows,
      recovery: initialRecoveryState(""),
      active: true,
      terminatePending: false,
      terminateRetryable: false,
    };
    view = {
      ...view,
      instanceId: opts.instanceId,
      sessionAlias: opts.sessionAlias,
      cols: opts.cols,
      rows: opts.rows,
      active: true,
      terminatePending: false,
      lastErrorCode: undefined,
      exitReason: undefined,
      exitCode: undefined,
      // Drop the old attachment id so input cannot target a detached binding.
      // Keep role until the new open settles — clearing it greys the keybar.
      attachmentId: undefined,
      recovery: initialRecoveryState(view.generation ?? ""),
    };
    waitingStreamStartInFlight.delete(localKey);
    put(view);

    try {
      const opened = await requestTerminal(
        {
          kind: "terminal-open",
          requestId: nextTerminalRequestId(),
          instanceId: opts.instanceId,
          sessionAlias: opts.sessionAlias,
          cols: opts.cols,
          rows: opts.rows,
        },
        { expect: "opened" },
      );
      view = {
        ...get(localKey)!,
        terminalId: opened.terminalId,
        generation: opened.generation,
        attachmentId: opened.attachmentId,
        role: opened.role,
        viewerCount: opened.viewerCount,
        recovery: initialRecoveryState(opened.generation),
        lastErrorCode: undefined,
      };
      put(view);
      // Spec §14.5: stream starts only after opened metadata is applied locally.
      sendWebClientMessage({
        kind: "terminal-stream-start",
        requestId: nextTerminalRequestId(),
        instanceId: opened.instanceId,
        attachmentId: opened.attachmentId,
      });
      refreshHeartbeat();
      return view;
    } catch (err) {
      const code = err instanceof TerminalRequestError ? err.code : "terminal-protocol-error";
      const failed = { ...get(localKey)!, lastErrorCode: code, attachmentId: undefined };
      put(failed);
      throw err;
    }
  }

  async function reopenActiveAttachments(): Promise<void> {
    const active = listActive().filter((a) => !a.terminatePending);
    await Promise.allSettled(
      active.map((a) =>
        openOrResume(a.localKey, {
          instanceId: a.instanceId,
          sessionAlias: a.sessionAlias,
          cols: a.cols,
          rows: a.rows,
        }),
      ),
    );
  }

  /** Best-effort detach; does not terminate the shared resource. */
  function detach(localKey: string): void {
    const view = get(localKey);
    if (!view) return;
    if (view.attachmentId) {
      sendWebClientMessage({
        kind: "terminal-detach",
        instanceId: view.instanceId,
        attachmentId: view.attachmentId,
      });
    }
    put({
      ...view,
      active: false,
      attachmentId: undefined,
      role: undefined,
    });
    waitingStreamStartInFlight.delete(localKey);
    refreshHeartbeat();
  }

  /**
   * Global terminate. Waits for ack. On offline/timeout keeps the tab and marks retryable.
   * Success codes: terminated | cleanup-pending.
   */
  async function terminate(localKey: string): Promise<{ status: "terminated" | "cleanup-pending" }> {
    const view = get(localKey);
    if (!view?.terminalId || !view.generation) {
      throw new TerminalRequestError("terminal-protocol-error", "missing terminal identity");
    }
    put({ ...view, terminatePending: true, terminateRetryable: false, lastErrorCode: undefined });
    try {
      const ack = await requestTerminal(
        {
          kind: "terminal-terminate",
          requestId: nextTerminalRequestId(),
          instanceId: view.instanceId,
          terminalId: view.terminalId,
          generation: view.generation,
        },
        { expect: "ack" },
      );
      const status = ack.code === "cleanup-pending" ? "cleanup-pending" : "terminated";
      const stepped = reduceRecovery(view.recovery, { kind: "exit" });
      put({
        ...get(localKey)!,
        active: false,
        attachmentId: undefined,
        terminatePending: false,
        terminateRetryable: false,
        recovery: stepped.state,
        exitReason: status,
      });
      waitingStreamStartInFlight.delete(localKey);
      refreshHeartbeat();
      for (const cb of attachmentExitCbs) cb(localKey, status);
      return { status };
    } catch (err) {
      const code = err instanceof TerminalRequestError ? err.code : "terminal-protocol-error";
      const retryable = isRetryableTerminalError(code);
      put({
        ...get(localKey)!,
        terminatePending: false,
        terminateRetryable: retryable,
        lastErrorCode: code,
      });
      throw err;
    }
  }

  function startOutputStream(view: TerminalAttachmentView): void {
    if (!view.attachmentId) return;
    sendWebClientMessage({
      kind: "terminal-stream-start",
      requestId: nextTerminalRequestId(),
      instanceId: view.instanceId,
      attachmentId: view.attachmentId,
    });
  }

  /** Re-issue stream-start if recover never left waiting. Open already sends one;
   *  take-control / first input retry when that frame was dropped. */
  function ensureOutputStreamIfWaiting(view: TerminalAttachmentView): void {
    if (view.recovery.phase !== "waiting" || !view.attachmentId) return;
    if (waitingStreamStartInFlight.has(view.localKey)) return;
    waitingStreamStartInFlight.add(view.localKey);
    startOutputStream(view);
  }

  /** RMUX path: controller-only input for a local tab attachment. */
  function sendInput(localKey: string, data: string): void {
    const view = get(localKey);
    if (!view?.attachmentId || !view.generation || view.role !== "controller") return;
    sendWebClientMessage({
      kind: "terminal-input",
      instanceId: view.instanceId,
      attachmentId: view.attachmentId,
      generation: view.generation,
      dataBase64: utf8ToCanonicalBase64(data),
    });
    // No local echo — characters appear only after recover is live. If it is
    // still waiting, restart the output stream so the PTY reply can rebase.
    ensureOutputStreamIfWaiting(view);
  }

  /** RMUX path: controller-only resize for a local tab attachment. */
  function sendResize(localKey: string, cols: number, rows: number): void {
    const view = get(localKey);
    if (!view?.attachmentId || !view.generation || view.role !== "controller") return;
    put({ ...view, cols, rows });
    sendWebClientMessage({
      kind: "terminal-resize",
      instanceId: view.instanceId,
      attachmentId: view.attachmentId,
      generation: view.generation,
      cols,
      rows,
    });
  }

  async function takeControl(localKey: string): Promise<TerminalAttachmentView> {
    const view = get(localKey);
    if (!view?.attachmentId || !view.generation) {
      throw new TerminalRequestError("terminal-attachment-not-found", "not attached");
    }
    const opened = await requestTerminal(
      {
        kind: "terminal-take-control",
        requestId: nextTerminalRequestId(),
        instanceId: view.instanceId,
        attachmentId: view.attachmentId,
        generation: view.generation,
      },
      { expect: "opened" },
    );
    const next = {
      ...get(localKey)!,
      terminalId: opened.terminalId,
      generation: opened.generation,
      attachmentId: opened.attachmentId,
      role: opened.role,
      viewerCount: opened.viewerCount,
    };
    put(next);
    // Open already sent stream-start; take-control does not. If recover never
    // went live (lost rebase-start), the keybar is clickable but the canvas
    // stays blank until a new recover produces a rebase.
    ensureOutputStreamIfWaiting(next);
    return next;
  }

  function onRebase(cb: RebaseCb): () => void {
    rebaseCbs.add(cb);
    return () => rebaseCbs.delete(cb);
  }
  function onBytes(cb: BytesCb): () => void {
    bytesCbs.add(cb);
    return () => bytesCbs.delete(cb);
  }
  function onMeta(cb: MetaCb): () => void {
    metaCbs.add(cb);
    return () => metaCbs.delete(cb);
  }
  function onAttachmentExit(cb: AttachmentExitCb): () => void {
    attachmentExitCbs.add(cb);
    return () => attachmentExitCbs.delete(cb);
  }

  function findByAttachmentId(attachmentId: string): TerminalAttachmentView | undefined {
    for (const v of attachments.value.values()) {
      if (v.attachmentId === attachmentId) return v;
    }
    return undefined;
  }

  function findByTerminalId(instanceId: string, terminalId: string): TerminalAttachmentView | undefined {
    for (const v of attachments.value.values()) {
      if (v.instanceId === instanceId && v.terminalId === terminalId) return v;
    }
    return undefined;
  }

  async function applyEvent(event: WebServerEvent): Promise<void> {
    if (event.kind === "terminal-role-changed") {
      const view = findByAttachmentId(event.attachmentId);
      if (!view) return;
      put({
        ...view,
        role: event.role,
        viewerCount: event.viewerCount,
        terminalId: event.terminalId,
      });
      return;
    }

    if (event.kind === "terminal-exit") {
      const view = findByTerminalId(event.instanceId, event.terminalId);
      if (!view) return;
      // Ignore exit for a superseded generation when possible.
      if (view.generation && event.generation && view.generation !== event.generation) return;
      const stepped = reduceRecovery(view.recovery, { kind: "exit" });
      put({
        ...view,
        active: false,
        attachmentId: undefined,
        recovery: stepped.state,
        exitReason: event.reason,
        exitCode: event.code,
        terminatePending: false,
      });
      waitingStreamStartInFlight.delete(view.localKey);
      refreshHeartbeat();
      for (const cb of attachmentExitCbs) cb(view.localKey, event.reason, event.code);
      return;
    }

    if (event.kind === "terminal-recovery-failed") {
      const view = findByAttachmentId(event.attachmentId);
      if (!view) return;
      if (view.generation && event.generation && view.generation !== event.generation) return;
      const stepped = reduceRecovery(view.recovery, { kind: "resync-started" });
      put({ ...view, lastErrorCode: event.code, recovery: stepped.state });
      // Fire-and-forget: do not block event application on the resync ack.
      void requestResync(view.localKey, event.code);
      return;
    }

    if (
      event.kind === "terminal-rebase-start"
      || event.kind === "terminal-rebase-chunk"
      || event.kind === "terminal-rebase-end"
      || event.kind === "terminal-bytes"
    ) {
      const view = findByAttachmentId(event.attachmentId);
      if (!view) return;
      const inbound =
        event.kind === "terminal-rebase-start"
          ? {
            kind: "rebase-start" as const,
            generation: event.generation,
            epoch: event.epoch,
            nextSequence: event.nextSequence,
            cols: event.cols,
            rows: event.rows,
            alternate: event.alternate,
            totalBytes: event.totalBytes,
            chunkCount: event.chunkCount,
          }
          : event.kind === "terminal-rebase-chunk"
            ? {
              kind: "rebase-chunk" as const,
              generation: event.generation,
              epoch: event.epoch,
              index: event.index,
              dataBase64: event.dataBase64,
            }
            : event.kind === "terminal-rebase-end"
              ? {
                kind: "rebase-end" as const,
                generation: event.generation,
                epoch: event.epoch,
              }
              : {
                kind: "bytes" as const,
                generation: event.generation,
                epoch: event.epoch,
                sequence: event.sequence,
                dataBase64: event.dataBase64,
              };
      const stepped = reduceRecovery(view.recovery, inbound);
      if (stepped.state.phase !== "waiting") {
        waitingStreamStartInFlight.delete(view.localKey);
      }
      put({ ...view, recovery: stepped.state });
      await applyRecoveryAction(view.localKey, stepped.action);
    }
  }

  return {
    attachments,
    get,
    terminalLocalKey,
    openOrResume,
    detach,
    terminate,
    takeControl,
    sendInput,
    sendResize,
    onRebase,
    onBytes,
    onMeta,
    onAttachmentExit,
    reopenActiveAttachments,
    applyEvent,
  };
});
