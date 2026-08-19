import path from "node:path";
import type { ControlServiceDeps } from "./control-service";
import type { ScheduledOrigin } from "./control-event-bus";
import type { PromptAttachmentRef } from "@ganglion/xacpx-relay-protocol";
import { toErrorMessage, buildControlMetadata, TURN_IDLE_TIMEOUT_REASON } from "./turn-support";

export interface TurnRequest {
  chatKey: string;
  sessionAlias: string;
  boundSessionAlias?: string;
  text: string;
  senderId: string;
  isOwner?: boolean;
  accountId?: string;
  // Extra fields stamped onto turn-started for scheduled-origin turns. `queueItemId`
  // is set only for a drained queue head so the web can reconcile the badge.
  turnStarted?: { prompt?: string; scheduled?: ScheduledOrigin; queueItemId?: string; promptRequestId?: string };
  media?: PromptAttachmentRef[];
  agentMentions?: Array<{ range: [number, number]; handle: string }>;
  allowRestoreArchived?: boolean;
  preserveCoordinatorRoute?: boolean;
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
export interface SessionTurnRunnerDeps
  extends Pick<
    ControlServiceDeps,
    "agent" | "sessions" | "events" | "uploadStore" | "sessionWarmth"
  > {
  resolveAgentTarget?: (handle: string) => Promise<{
    handle: string;
    displayName?: string;
    agent: string;
    workspace?: string;
  } | null>;
  agentMessaging?: Pick<
    NonNullable<ControlServiceDeps["agentMessaging"]>,
    "resolveTargetByHandle" | "getPublishedEndpoints"
  >;
}

export function disarmUserDirectiveTags(text: string): string {
  return text
    .replace(/<(\/?)xacpx-([^>]*)>/gi, "&lt;$1xacpx-$2&gt;")
    .replace(/<(\/?)xacpx-/gi, "&lt;$1xacpx-");
}

export function buildCollaborationDirective(
  targets: Array<{
    handle: string;
    displayName?: string;
    agent: string;
    workspace?: string;
  }>,
): string {
  const targetXmls = targets.map((target) => {
    const displayName = target.displayName || target.agent;
    const workspace = target.workspace || "";
    return [
      "  <target",
      `    handle="${escapeXmlAttribute(target.handle)}"`,
      `    display-name="${escapeXmlAttribute(displayName)}"`,
      `    agent="${escapeXmlAttribute(target.agent)}"`,
      `    workspace="${escapeXmlAttribute(workspace)}"`,
      "  />",
      "  <instruction>",
      `    The user explicitly directed to coordinate with @${escapeXmlAttribute(displayName)}.`,
      "    Use the `agent_send` tool targeting this handle or selector.",
      "  </instruction>",
    ].join("\n");
  });

  return [
    '<xacpx-collaboration-directive origin="xacpx-server">',
    ...targetXmls,
    "</xacpx-collaboration-directive>",
  ].join("\n");
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export class SessionTurnRunner {
  constructor(private readonly deps: SessionTurnRunnerDeps) {}

  private async resolveMentionTarget(handle: string): Promise<{
    handle: string;
    displayName?: string;
    agent: string;
    workspace?: string;
  } | null> {
    if (this.deps.resolveAgentTarget) {
      return await this.deps.resolveAgentTarget(handle);
    }
    if (this.deps.agentMessaging?.resolveTargetByHandle) {
      return await this.deps.agentMessaging.resolveTargetByHandle(handle);
    }
    if (this.deps.agentMessaging?.getPublishedEndpoints) {
      const endpoints = await this.deps.agentMessaging.getPublishedEndpoints();
      const match = endpoints.find(
        (e) => `agent:${e.nodeId}:${e.endpointId}` === handle,
      );
      if (match) {
        return {
          handle,
          displayName: match.displayName,
          agent: match.agent,
          workspace: match.workspace,
        };
      }
    }
    return null;
  }

  async run(req: TurnRequest, signal: AbortSignal, onActivity?: () => void): Promise<TurnResult> {
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
      internalAlias =
        req.boundSessionAlias ??
        (await this.deps.sessions.resolveAliasForChat(req.chatKey, req.sessionAlias));
      const prior = await this.deps.sessions.getSession(internalAlias);
      wasArchived = prior?.archived === true;
      priorTransportSession = prior?.transportSession;
    } catch {
      /* best-effort: a detection failure just means no badge refresh */
    }
    if (req.allowRestoreArchived === false && wasArchived) {
      return { ok: false, errorMessage: "session-archived" };
    }
    if (!req.boundSessionAlias) {
      try {
        await this.deps.sessions.useSession(req.chatKey, req.sessionAlias);
      } catch (error) {
        // This turn never really started, but it still holds the concurrency slot in
        // ControlService. Just report the failure — the caller settles/advances the
        // queue around this call so a transient bind failure on a *drained* head does
        // not strand the items behind it.
        return { ok: false, errorMessage: toErrorMessage(error) };
      }
    }
    if (wasArchived) {
      this.deps.events.emit({ type: "sessions-changed" });
    }
    if (internalAlias && this.deps.sessionWarmth) {
      // This prompt is about to spawn (or reuse) the warm queue owner — correct
      // the tracker now so the cold indicator clears without waiting for a poll.
      const bound = await this.deps.sessions.getSession(internalAlias).catch(() => null);
      if (bound) this.deps.sessionWarmth.markWarm(bound);
    }
    this.deps.events.emit({
      type: "turn-started",
      chatKey: req.chatKey,
      sessionAlias: req.sessionAlias,
      ...(req.turnStarted?.prompt ? { prompt: req.turnStarted.prompt } : {}),
      ...(req.turnStarted?.scheduled ? { scheduled: req.turnStarted.scheduled } : {}),
      ...(req.turnStarted?.queueItemId ? { queueItemId: req.turnStarted.queueItemId } : {}),
      ...(req.turnStarted?.promptRequestId ? { promptRequestId: req.turnStarted.promptRequestId } : {}),
    });
    // Stream-mode sessions (replyMode "stream") get raw token streaming: the transport
    // forwards chunks verbatim (paragraph breaks intact), so we concatenate as-is.
    // Batched sessions get pre-split, trimmed paragraph segments instead — there the
    // original "\n\n" is gone, and both turn-output consumers (web live view + hub
    // history buffer) simply concatenate, running paragraphs together on one line. For
    // those we re-insert the break between segments so live and history stay identical.
    const streamMode = await this.resolveStreamMode(req.chatKey, req.sessionAlias);
    let emittedChunk = false;
    // Accumulate the ACTUAL normalized chunks sent on the wire. A streaming adapter
    // often leaves `response.text` undefined (or partial), so the relay hub's
    // no-buffer fallback must not depend on it — turn-finished.text is this full
    // concatenation, exactly what a live-view consumer accumulated from turn-output.
    let finalText = "";
    const emitChunk = (chunk: string) => {
      if (!chunk) return;
      const output = !streamMode && emittedChunk ? `\n\n${chunk}` : chunk;
      finalText += output;
      this.deps.events.emit({
        type: "turn-output",
        chatKey: req.chatKey,
        sessionAlias: req.sessionAlias,
        chunk: output,
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
    const disarmedUserText = disarmUserDirectiveTags(req.text);
    let chatText = disarmedUserText;
    if (req.agentMentions && req.agentMentions.length > 0) {
      const resolvedTargets: Array<{
        handle: string;
        displayName?: string;
        agent: string;
        workspace?: string;
      }> = [];
      const seen = new Set<string>();
      for (const mention of req.agentMentions) {
        if (!mention.handle || seen.has(mention.handle)) continue;
        seen.add(mention.handle);
        try {
          const target = await this.resolveMentionTarget(mention.handle);
          if (target) {
            resolvedTargets.push(target);
          }
        } catch {
          // ignore lookup errors gracefully
        }
      }
      if (resolvedTargets.length > 0) {
        const directive = buildCollaborationDirective(resolvedTargets);
        chatText = disarmedUserText
          ? `${directive}\n\n<user-prompt>\n${disarmedUserText}\n</user-prompt>`
          : directive;
      }
    }
    try {
      const response = await this.deps.agent.chat({
        accountId: req.accountId ?? "control",
        conversationId: req.chatKey,
        text: chatText,
        metadata: buildControlMetadata(
          req.senderId,
          req.isOwner,
          req.boundSessionAlias,
          req.preserveCoordinatorRoute,
        ),
        abortSignal: signal,
        ...(chatMedia.length > 0 ? { media: chatMedia } : {}),
        reply: async (chunk) => {
          onActivity?.();
          emitChunk(chunk);
        },
        onToolEvent: (event) => {
          onActivity?.();
          this.deps.events.emit({
            type: "tool-event",
            chatKey: req.chatKey,
            sessionAlias: req.sessionAlias,
            event,
          });
        },
        onThought: (chunk) => {
          onActivity?.();
          this.deps.events.emit({
            type: "turn-thought",
            chatKey: req.chatKey,
            sessionAlias: req.sessionAlias,
            chunk,
          });
        },
        onPlan: (entries) => {
          onActivity?.();
          this.deps.events.emit({
            type: "plan",
            chatKey: req.chatKey,
            sessionAlias: req.sessionAlias,
            entries,
          });
        },
        onUsage: (usage) => {
          onActivity?.();
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
          onActivity?.();
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
        // Carry the accumulated reply text (all emitted chunks + the trailing
        // response.text) so a relay hub that missed the streamed chunks can still
        // persist the FULL answer — response.text alone is unreliable for streaming
        // adapters (often undefined or the last segment only).
        text: finalText,
      });
      return {
        ok: true,
        text: response.text,
        ...(internalAlias && priorTransportSession
          ? { postTurnDetection: { internalAlias, priorTransportSession } }
          : {}),
      };
    } catch (error) {
      // A watchdog inactivity-timeout abort (controller.abort(TURN_IDLE_TIMEOUT_REASON)) surfaces
      // as an error with a fixed timeout message and is NOT flagged `cancelled` — that keeps
      // it distinct from a user Stop (which aborts with no reason → cancelled:true).
      const timedOut = signal.reason === TURN_IDLE_TIMEOUT_REASON;
      const errorMessage = timedOut ? "Turn timed out due to inactivity" : toErrorMessage(error);
      this.deps.events.emit({
        type: "turn-finished",
        chatKey: req.chatKey,
        sessionAlias: req.sessionAlias,
        ok: false,
        errorMessage,
        ...(!timedOut && signal.aborted ? { cancelled: true } : {}),
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
