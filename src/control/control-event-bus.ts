import type { AppLogger } from "../logging/app-logger";
import type { ToolUseEvent, PlanEntry } from "../channels/types";
import type { NativeHistoryMessage } from "../transport/native-session-history";

export interface ScheduledOrigin {
  taskId: string;
  executeAt: string;
}

export type ControlEvent =
  | { type: "turn-output"; chatKey: string; sessionAlias: string; chunk: string }
  // `prompt`/`scheduled` are populated only for turns started by a fired scheduled
  // task (relay channel), letting the hub persist the inbound prompt and the web badge it.
  | { type: "turn-started"; chatKey: string; sessionAlias: string; prompt?: string; scheduled?: ScheduledOrigin }
  | { type: "tool-event"; chatKey: string; sessionAlias: string; event: ToolUseEvent }
  | { type: "turn-thought"; chatKey: string; sessionAlias: string; chunk: string }
  | { type: "plan"; chatKey: string; sessionAlias: string; entries: PlanEntry[] }
  // Context-usage meter: `used` tokens in context, `size` total context window. Replace-latest.
  | { type: "turn-usage"; chatKey: string; sessionAlias: string; used: number; size: number }
  | { type: "turn-finished"; chatKey: string; sessionAlias: string; ok: boolean; errorMessage?: string; cancelled?: boolean }
  | { type: "sessions-changed" }
  | { type: "scheduled-changed"; chatKey: string }
  // Recovered prior conversation for a freshly-attached native session, so the hub can
  // seed it into history. `sessionAlias` is the display alias the web loads history by.
  | { type: "session-history"; chatKey: string; sessionAlias: string; messages: NativeHistoryMessage[] }
  | { type: "orchestration-changed" };

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
