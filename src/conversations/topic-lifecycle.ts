import { ConversationError } from "./conversation-error";

/** Durable topic phase. `deleting` is a barrier, not a reversible status. */
export type TopicPhase = "active" | "archived" | "deleting";

export type TopicRole = "default-direct" | "extra-direct" | "group";

/**
 * One topic's lifecycle. `contextGeneration` starts at 1. Clearing the
 * default topic bumps it. The id does not change, so a new binding must
 * carry the new generation or it would resume the retired context.
 */
export interface TopicLifecycle {
  phase: TopicPhase;
  role: TopicRole;
  title: string;
  contextGeneration: number;
}

export type TopicCommand =
  | { type: "rename"; title: string }
  | { type: "archive" }
  | { type: "restore" }
  | { type: "begin-teardown" }
  | { type: "begin-clear" }
  | { type: "finish-clear" };

export const TOPIC_TITLE_MAX = 200;

export function topicContextGeneration(topic: { contextGeneration?: number }): number {
  return topic.contextGeneration ?? 1;
}

export function topicLifecycleFrom(
  topic: { status: TopicPhase; title: string; contextGeneration?: number },
  role: TopicRole,
): TopicLifecycle {
  return {
    phase: topic.status,
    role,
    title: topic.title,
    contextGeneration: topicContextGeneration(topic),
  };
}

function trimmedTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) {
    throw new ConversationError("topic_title_required", "topic title is required");
  }
  if (trimmed.length > TOPIC_TITLE_MAX) {
    throw new ConversationError("topic_title_invalid", "topic title is too long");
  }
  return trimmed;
}

/**
 * Legal topic transitions. Callers still have to prove runs, bindings, and
 * worktrees before they apply a command that destroys context.
 */
export function transitionTopic(state: TopicLifecycle, command: TopicCommand): TopicLifecycle {
  switch (command.type) {
    case "rename": {
      if (state.phase === "deleting") {
        throw new ConversationError("topic_deleting", "topic is deleting");
      }
      return { ...state, title: trimmedTitle(command.title) };
    }
    case "archive": {
      if (state.phase === "archived") {
        return state;
      }
      if (state.phase !== "active") {
        throw new ConversationError("topic_deleting", "topic is deleting");
      }
      return { ...state, phase: "archived" };
    }
    case "restore": {
      if (state.phase === "active") {
        return state;
      }
      if (state.phase !== "archived") {
        throw new ConversationError("topic_deleting", "topic is deleting");
      }
      return { ...state, phase: "active" };
    }
    case "begin-teardown": {
      if (state.role === "default-direct") {
        throw new ConversationError(
          "topic_clear_required",
          "the default topic stays; clear its context instead of deleting it",
        );
      }
      if (state.phase === "deleting") {
        return state;
      }
      return { ...state, phase: "deleting" };
    }
    case "begin-clear": {
      if (state.role !== "default-direct") {
        throw new ConversationError("topic_not_default", "only the default topic can be cleared");
      }
      if (state.phase === "deleting") {
        throw new ConversationError("topic_deleting", "topic is deleting");
      }
      return state;
    }
    case "finish-clear": {
      if (state.role !== "default-direct") {
        throw new ConversationError("topic_not_default", "only the default topic can be cleared");
      }
      if (state.phase === "deleting") {
        throw new ConversationError("topic_deleting", "topic is deleting");
      }
      return { ...state, contextGeneration: state.contextGeneration + 1 };
    }
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
}
