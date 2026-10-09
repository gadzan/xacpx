import { ConversationError } from "./conversation-error";

/** One durable cleanup record. Bot removal and topic or group teardown share it. */
export type LifecycleOperationKind = "bot-remove" | "topic-teardown" | "topic-clear" | "group-teardown";

export type LifecycleOperationPhase = "running" | "failed" | "indeterminate" | "completed";

export interface LifecycleOperationError {
  code: string;
  message: string;
}

/** Flags frozen when a bot removal starts. A retry keeps these. */
export interface BotRemoveParams {
  clearDirectHistory: boolean;
  releaseDirectBindings: boolean;
}

export interface LifecycleOperation {
  id: string;
  kind: LifecycleOperationKind;
  subjectId: string;
  requestId: string;
  phase: LifecycleOperationPhase;
  error?: LifecycleOperationError;
  previewRevision?: string;
  params?: BotRemoveParams;
  updatedAt: string;
}

export type LifecycleCommand =
  | {
    type: "start";
    id: string;
    kind: LifecycleOperationKind;
    subjectId: string;
    requestId: string;
    previewRevision?: string;
    params?: BotRemoveParams;
    at: string;
  }
  | { type: "fail"; error: LifecycleOperationError; at: string }
  | { type: "indeterminate"; error: LifecycleOperationError; at: string }
  | { type: "complete"; at: string };

const KINDS: readonly LifecycleOperationKind[] = ["bot-remove", "topic-teardown", "topic-clear", "group-teardown"];
const PHASES: readonly LifecycleOperationPhase[] = ["running", "failed", "indeterminate", "completed"];

export function lifecycleOperationId(kind: LifecycleOperationKind, requestId: string): string {
  return `${kind}:${requestId}`;
}

function sameIdentity(state: LifecycleOperation, command: Extract<LifecycleCommand, { type: "start" }>): boolean {
  return state.id === command.id
    && state.kind === command.kind
    && state.subjectId === command.subjectId
    && state.requestId === command.requestId;
}

/**
 * Cleanup status. `completed` sticks. `indeterminate` stays until a later
 * start moves it back to `running`. Completing an indeterminate record is
 * refused so an unknown execution cannot look finished.
 */
export function transitionLifecycleOperation(
  state: LifecycleOperation | undefined,
  command: LifecycleCommand,
): LifecycleOperation {
  switch (command.type) {
    case "start": {
      if (state && !sameIdentity(state, command)) {
        throw new ConversationError("lifecycle_operation_conflict", "operation id is already used");
      }
      if (state?.phase === "completed" || state?.phase === "running") {
        return state;
      }
      return {
        id: command.id,
        kind: command.kind,
        subjectId: command.subjectId,
        requestId: command.requestId,
        phase: "running",
        ...(state?.previewRevision ?? command.previewRevision
          ? { previewRevision: state?.previewRevision ?? command.previewRevision }
          : {}),
        ...(state?.params ?? command.params ? { params: state?.params ?? command.params } : {}),
        updatedAt: command.at,
      };
    }
    case "fail": {
      if (!state) {
        throw new ConversationError("lifecycle_operation_not_found", "operation does not exist");
      }
      if (state.phase === "completed" || state.phase === "indeterminate") {
        return state;
      }
      return { ...state, phase: "failed", error: command.error, updatedAt: command.at };
    }
    case "indeterminate": {
      if (!state) {
        throw new ConversationError("lifecycle_operation_not_found", "operation does not exist");
      }
      if (state.phase === "completed") {
        return state;
      }
      return { ...state, phase: "indeterminate", error: command.error, updatedAt: command.at };
    }
    case "complete": {
      if (!state) {
        throw new ConversationError("lifecycle_operation_not_found", "operation does not exist");
      }
      if (state.phase === "indeterminate") {
        throw new ConversationError(
          "lifecycle_operation_indeterminate",
          "an indeterminate operation is not finished",
        );
      }
      return { ...state, phase: "completed", error: undefined, updatedAt: command.at };
    }
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
}

function isParams(value: unknown): value is BotRemoveParams {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.clearDirectHistory === "boolean"
    && typeof record.releaseDirectBindings === "boolean";
}

/** Parse a stored operation. A wrong shape is corrupt, not a default phase. */
export function parseLifecycleOperation(value: unknown): LifecycleOperation | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.subjectId !== "string" || typeof record.requestId !== "string") {
    return undefined;
  }
  if (typeof record.updatedAt !== "string") {
    return undefined;
  }
  if (typeof record.kind !== "string" || !KINDS.includes(record.kind as LifecycleOperationKind)) {
    return undefined;
  }
  if (typeof record.phase !== "string" || !PHASES.includes(record.phase as LifecycleOperationPhase)) {
    return undefined;
  }
  if (record.params !== undefined && !isParams(record.params)) {
    return undefined;
  }
  let error: LifecycleOperationError | undefined;
  if (record.error !== undefined) {
    if (!record.error || typeof record.error !== "object") {
      return undefined;
    }
    const body = record.error as Record<string, unknown>;
    if (typeof body.code !== "string" || typeof body.message !== "string") {
      return undefined;
    }
    error = { code: body.code, message: body.message };
  }
  if (record.previewRevision !== undefined && typeof record.previewRevision !== "string") {
    return undefined;
  }
  return {
    id: record.id,
    kind: record.kind as LifecycleOperationKind,
    subjectId: record.subjectId,
    requestId: record.requestId,
    phase: record.phase as LifecycleOperationPhase,
    ...(error ? { error } : {}),
    ...(typeof record.previewRevision === "string" ? { previewRevision: record.previewRevision } : {}),
    ...(record.params ? { params: record.params } : {}),
    updatedAt: record.updatedAt,
  };
}
