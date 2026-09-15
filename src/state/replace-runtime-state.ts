import type { AppState } from "./types";

/** Publish a fully persisted snapshot without changing the live state identity. */
export function replaceRuntimeState(target: AppState, source: AppState): void {
  target.sessions = source.sessions;
  target.chat_contexts = source.chat_contexts;
  target.orchestration = source.orchestration;
  target.scheduled_tasks = source.scheduled_tasks;
  target.bots = source.bots;
  target.conversations = source.conversations;
  target.conversation_topics = source.conversation_topics;
  target.bot_runtime_bindings = source.bot_runtime_bindings;
}
