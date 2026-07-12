import path from "node:path";
import type { ControlServiceDeps } from "./control-service";
import type { ScheduledOrigin } from "./control-event-bus";
import type { PromptAttachmentRef } from "@ganglion/xacpx-relay-protocol";
import { toErrorMessage, buildControlMetadata } from "./turn-support";

export interface TurnRequest {
  chatKey: string;
  sessionAlias: string;
  text: string;
  senderId: string;
  isOwner?: boolean;
  accountId?: string;
  // Extra fields stamped onto turn-started for scheduled-origin turns. `queueItemId`
  // is set only for a drained queue head so the web can reconcile the badge.
  turnStarted?: { prompt?: string; scheduled?: ScheduledOrigin; queueItemId?: string };
  media?: PromptAttachmentRef[];
}

export interface TurnResult {
  ok: boolean;
  text?: string;
  errorMessage?: string;
  // Inputs for the post-turn `sessions-changed` detection (a transport session that moved
  // during the turn — archived-restore or `/clear`). The CALLER performs the getSession
  // compare, not run(), because it must happen AFTER the caller sets `draining`: that await
  // window has to stay guarded so an aborted turn with a queued item cannot let a fresh
  // prompt race in. Set only when the turn ran past useSession with a prior session captured.
  postTurnDetection?: { internalAlias: string; priorTransportSession: string };
}

// Runs the per-turn execution body: session bind, turn-started, media sandboxing,
// stream/batched paragraph reconstruction, the agent.chat drive with all event
// emissions, and turn-finished. It also captures the pre-turn session state and
// returns it (postTurnDetection) so the CALLER can detect a transport session that
// moved (archived-session restore or `/clear`) during the turn — run() does not do
// that compare itself, see TurnResult.postTurnDetection.
//
// Contract: run() signals turn failure by RESOLVING with { ok: false, errorMessage }
// (session-bind and agent-drive failures are caught internally), never by rejecting —
// so TurnQueue can settle/advance the queue in a plain finally without a catch.
//
// Holds no concurrency state of its own — the inFlight/queues/draining lifecycle
// lives in TurnQueue, which decides whether to call run() at all.
export class SessionTurnRunner {
  constructor(
    private readonly deps: Pick<ControlServiceDeps, "agent" | "sessions" | "events" | "uploadStore">,
  ) {}

  async run(req: TurnRequest, signal: AbortSignal): Promise<TurnResult> {
    // Sending to an archived session restores it (useSession clears `archived`), and
    // `/clear` (session.reset) recreates the transport session under the same alias — both
    // mutate the session row, but neither useSession nor the reset handler emits an event.
    // Capture the pre-turn state here so we can detect the transition afterwards and emit
    // `sessions-changed`, otherwise the dashboard keeps showing a stale archived badge /
    // transport+native binding on the row until the next unrelated refresh.
    let internalAlias: string | undefined;
    let wasArchived = false;
    let priorTransportSession: string | undefined;
    try {
      internalAlias = await this.deps.sessions.resolveAliasForChat(req.chatKey, req.sessionAlias);
      const prior = await this.deps.sessions.getSession(internalAlias);
      wasArchived = prior?.archived === true;
      priorTransportSession = prior?.transportSession;
    } catch {
      /* best-effort: a detection failure just means no badge refresh */
    }
    try {
      await this.deps.sessions.useSession(req.chatKey, req.sessionAlias);
    } catch (error) {
      // This turn never really started, but it still holds the concurrency slot in
      // ControlService. Just report the failure — the caller settles/advances the
      // queue around this call so a transient bind failure on a *drained* head does
      // not strand the items behind it.
      return { ok: false, errorMessage: toErrorMessage(error) };
    }
    if (wasArchived) {
      this.deps.events.emit({ type: "sessions-changed" });
    }
    this.deps.events.emit({
      type: "turn-started",
      chatKey: req.chatKey,
      sessionAlias: req.sessionAlias,
      ...(req.turnStarted?.prompt ? { prompt: req.turnStarted.prompt } : {}),
      ...(req.turnStarted?.scheduled ? { scheduled: req.turnStarted.scheduled } : {}),
      ...(req.turnStarted?.queueItemId ? { queueItemId: req.turnStarted.queueItemId } : {}),
    });
    // Stream-mode sessions (replyMode "stream") get raw token streaming: the transport
    // forwards chunks verbatim (paragraph breaks intact), so we concatenate as-is.
    // Batched sessions get pre-split, trimmed paragraph segments instead — there the
    // original "\n\n" is gone, and both turn-output consumers (web live view + hub
    // history buffer) simply concatenate, running paragraphs together on one line. For
    // those we re-insert the break between segments so live and history stay identical.
    const streamMode = await this.resolveStreamMode(req.chatKey, req.sessionAlias);
    let emittedChunk = false;
    const emitChunk = (chunk: string) => {
      if (!chunk) return;
      this.deps.events.emit({
        type: "turn-output",
        chatKey: req.chatKey,
        sessionAlias: req.sessionAlias,
        chunk: !streamMode && emittedChunk ? `\n\n${chunk}` : chunk,
      });
      emittedChunk = true;
    };
    // Defense-in-depth: the two-phase upload sandbox is meant to be the only source of
    // attachment bytes (the web flow echoes back the path control.upload returned, which
    // lives under the sandbox root). Drop any media ref whose resolved filePath escapes
    // that root so a caller cannot point the agent at an arbitrary absolute path. Only
    // touch the upload store when a turn actually carries media — a plain prompt turn
    // has no attachments and must not depend on the store being present.
    const incomingMedia = req.media ?? [];
    const sandboxedMedia = incomingMedia.length
      ? (() => {
          const uploadRoot = path.resolve(this.deps.uploadStore.root);
          const kept = incomingMedia.filter((ref) => {
            const resolved = path.resolve(ref.filePath);
            return resolved === uploadRoot || resolved.startsWith(uploadRoot + path.sep);
          });
          const dropped = incomingMedia.length - kept.length;
          if (dropped > 0) {
            console.warn(
              `[control] dropped ${dropped} media ref(s) with filePath outside the upload sandbox`,
            );
          }
          return kept;
        })()
      : incomingMedia;
    const chatMedia = sandboxedMedia.map((ref) => ({
      kind: ref.kind,
      filePath: ref.filePath,
      mimeType: ref.mimeType,
      ...(ref.fileName ? { fileName: ref.fileName } : {}),
      sizeBytes: ref.size,
      source: {
        channelId: "relay",
        accountId: req.accountId ?? "control",
        chatKey: req.chatKey,
        messageId: ref.id,
      },
    }));
    try {
      const response = await this.deps.agent.chat({
        accountId: req.accountId ?? "control",
        conversationId: req.chatKey,
        text: req.text,
        metadata: buildControlMetadata(req.senderId, req.isOwner),
        abortSignal: signal,
        ...(chatMedia.length > 0 ? { media: chatMedia } : {}),
        reply: async (chunk) => {
          emitChunk(chunk);
        },
        onToolEvent: (event) => {
          this.deps.events.emit({
            type: "tool-event",
            chatKey: req.chatKey,
            sessionAlias: req.sessionAlias,
            event,
          });
        },
        onThought: (chunk) => {
          this.deps.events.emit({
            type: "turn-thought",
            chatKey: req.chatKey,
            sessionAlias: req.sessionAlias,
            chunk,
          });
        },
        onPlan: (entries) => {
          this.deps.events.emit({
            type: "plan",
            chatKey: req.chatKey,
            sessionAlias: req.sessionAlias,
            entries,
          });
        },
        onUsage: (usage) => {
          this.deps.events.emit({
            type: "turn-usage",
            chatKey: req.chatKey,
            sessionAlias: req.sessionAlias,
            used: usage.used,
            size: usage.size,
            ...(usage.cost ? { cost: usage.cost } : {}),
            ...(usage.breakdown ? { breakdown: usage.breakdown } : {}),
          });
        },
        onCommands: (commands) => {
          this.deps.events.emit({
            type: "agent-commands",
            chatKey: req.chatKey,
            sessionAlias: req.sessionAlias,
            commands,
          });
        },
      });
      if (response.text) {
        emitChunk(response.text);
      }
      this.deps.events.emit({
        type: "turn-finished",
        chatKey: req.chatKey,
        sessionAlias: req.sessionAlias,
        ok: true,
      });
      return {
        ok: true,
        text: response.text,
        ...(internalAlias && priorTransportSession
          ? { postTurnDetection: { internalAlias, priorTransportSession } }
          : {}),
      };
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      this.deps.events.emit({
        type: "turn-finished",
        chatKey: req.chatKey,
        sessionAlias: req.sessionAlias,
        ok: false,
        errorMessage,
        ...(signal.aborted ? { cancelled: true } : {}),
      });
      return {
        ok: false,
        errorMessage,
        ...(internalAlias && priorTransportSession
          ? { postTurnDetection: { internalAlias, priorTransportSession } }
          : {}),
      };
    }
    // NB: no `finally` doing the post-turn `sessions-changed` getSession here — that compare
    // is deliberately the caller's job (see TurnResult.postTurnDetection), so it runs after
    // `draining` is set and the await window stays guarded.
  }

  /** Resolve a chat-scoped display alias to its ResolvedSession and read whether it is
   *  in stream reply mode. Best-effort: any resolution failure falls back to batched
   *  paragraph reconstruction (the pre-existing default). */
  private async resolveStreamMode(chatKey: string, sessionAlias: string): Promise<boolean> {
    try {
      const internalAlias = await this.deps.sessions.resolveAliasForChat(chatKey, sessionAlias);
      const resolved = await this.deps.sessions.getSession(internalAlias);
      return (resolved?.effectiveReplyMode ?? resolved?.replyMode) === "stream";
    } catch {
      return false;
    }
  }
}
