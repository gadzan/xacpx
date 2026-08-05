import type { AppState } from "./types";

/** Publish a fully persisted snapshot without changing the live state identity. */
export function replaceRuntimeState(target: AppState, source: AppState): void {
  target.sessions = source.sessions;
  target.chat_contexts = source.chat_contexts;
  target.orchestration = source.orchestration;
  target.scheduled_tasks = source.scheduled_tasks;
}
