import type { PeerTurnOrigin } from "./turn-support";
import type { AppLogger } from "../logging/app-logger";
import type { ToolUseEvent, PlanEntry } from "../channels/types";
import type { AgentCommand, UsageBreakdown, UsageCost } from "../transport/types";
import type { NativeHistoryMessage } from "../transport/native-session-history";
import type { PeerMessageHistoryEntry } from "../orchestration/agent-messaging-types";

export interface ScheduledOrigin {
  taskId: string;
  executeAt: string;
}

/** A single pending item in the per-session server-side prompt queue, as surfaced on
 *  the wire by `queue-updated`. `textPreview` is truncated server-side (~120 chars). */
export interface QueuedItemInfo {
  id: string;
  textPreview: string;
  enqueuedAt: string;
  /** v0.4: present ONLY for a reserved-but-not-started peer interrupt
   *  (snapshot-first item). Additive and backward compatible. */
  kind?: "interrupt";
}

export type ControlEvent =
  | { type: "turn-output"; chatKey: string; sessionAlias: string; chunk: string }
  // `prompt`/`scheduled` are populated only for turns started by a fired scheduled
  // task (relay channel), or a turn drained from the queue, letting the hub persist
  // the inbound prompt and the web badge it. A drained turn carries `queueItemId` so
  // the web can move its original optimistic bubble to the actual execution point.
  | { type: "turn-started"; chatKey: string; sessionAlias: string; prompt?: string; scheduled?: ScheduledOrigin; queueItemId?: string; promptRequestId?: string; peerOrigin?: PeerTurnOrigin }
  // Full ordered snapshot (replace-latest) of the pending prompt queue for a session,
  // emitted on every enqueue/drain/cancel.
  | { type: "queue-updated"; chatKey: string; sessionAlias: string; items: QueuedItemInfo[] }
  | { type: "tool-event"; chatKey: string; sessionAlias: string; event: ToolUseEvent }
  | { type: "turn-thought"; chatKey: string; sessionAlias: string; chunk: string }
  | { type: "plan"; chatKey: string; sessionAlias: string; entries: PlanEntry[] }
  // Context-usage meter: `used` tokens in context, `size` total context window. Replace-latest.
  | { type: "turn-usage"; chatKey: string; sessionAlias: string; used: number; size: number; cost?: UsageCost; breakdown?: UsageBreakdown }
  // Agent-advertised slash commands (e.g. /compact). Session-scoped, replace-latest.
  | { type: "agent-commands"; chatKey: string; sessionAlias: string; commands: AgentCommand[] }
  // `text` carries the final reply text on success so a relay hub that lost the turn's
  // streamed chunks (e.g. hub restart mid-turn) can still persist the answer. Omitted on
  // failure paths (`errorMessage` already covers them).
  | { type: "turn-finished"; chatKey: string; sessionAlias: string; ok: boolean; errorMessage?: string; cancelled?: boolean; text?: string; peerOrigin?: PeerTurnOrigin }
  | { type: "sessions-changed" }
  // The set of configured workspaces changed (e.g. a separate `xacpx workspace add`
  // CLI process edited config.json, or a `/config` mutation). Carries no payload;
  // structured consumers re-fetch the workspace list.
  | { type: "workspaces-changed" }
  | { type: "scheduled-changed"; chatKey: string }
  // Recovered prior conversation for a freshly-attached native session, so the hub can
  // seed it into history. `sessionAlias` is the display alias the web loads history by.
  | { type: "session-history"; chatKey: string; sessionAlias: string; messages: NativeHistoryMessage[] }
  // Interactive terminal byte stream (web terminal). Emitted directly by
  // TerminalService — NOT an agent-turn callback, so it does not traverse
  // command-router/handlers. `seq` is a per-terminal monotonic counter for v2 replay.
  | { type: "terminal-output"; terminalId: string; seq: number; data: string }
  | { type: "terminal-exit"; terminalId: string; code: number }
  | { type: "orchestration-changed" }
  | { type: "agent-message"; chatKey?: string; sessionAlias: string; message: PeerMessageHistoryEntry }
  // v0.3: completion-status PATCH for an already-persisted sender card. Carries
  // only the correlation id and the new terminal status — never a rebuilt
  // PeerMessageHistoryEntry — so the durable row's content/peer/mode survive
  // daemon restarts and outbound-cache eviction.
  | { type: "agent-message-completion"; sessionAlias: string; messageId: string; completionStatus: "completed" | "failed" | "cancelled" };

export type ControlEventListener = (event: ControlEvent) => void;

export interface ControlEventBus {
  subscribe(listener: ControlEventListener): () => void;
  emit(event: ControlEvent): void;
}

export function createControlEventBus(logger?: AppLogger): ControlEventBus {
  const listeners = new Set<ControlEventListener>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(event) {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (error) {
          void logger?.error("control.event_listener_failed", "control event listener threw", {
            eventType: event.type,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
  };
}
