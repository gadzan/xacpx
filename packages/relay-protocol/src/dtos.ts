/** Wire mirror of the core control session listing. */
export interface SessionDto {
  alias: string;
  agent: string;
  workspace: string;
  transportSession: string;
  running: boolean;
}

/** Wire DTO for a configured agent on an instance. */
export interface AgentDto {
  name: string;
  driver: string;
}

/** Wire DTO for a machine-available agent driver and its readiness. */
export interface AgentCatalogEntryDto {
  driver: string;
  configured: boolean;
  installed: "builtin" | "yes" | "unknown";
}

/** Wire DTO for a configured workspace on an instance. */
export interface WorkspaceDto {
  name: string;
  cwd: string;
  description?: string;
}

/** A single entry in a workspace directory listing (read-only file browser). */
export interface FsEntryDto {
  name: string;
  type: "dir" | "file";
  /** File size in bytes; omitted for directories. */
  size?: number;
}

/** A changed file in a workspace's git working tree. `status` is the porcelain XY
 *  code (e.g. " M", "A ", "??", "D "). */
export interface FsDiffFileDto {
  path: string;
  status: string;
}

// Keep in sync with ScheduledTaskStatus in src/scheduled/scheduled-types.ts
export type ScheduledTaskStatusDto =
  | "pending"
  | "triggering"
  | "executed"
  | "cancelled"
  | "missed"
  | "failed";

/** Wire DTO for a scheduled task; maps from core ScheduledTaskRecord. */
export interface ScheduledTaskDto {
  id: string;
  sessionAlias: string;
  executeAt: string;
  message: string;
  status: ScheduledTaskStatusDto;
  createdAt: string;
  /** Set once the task has fired successfully (status "executed"). */
  executedAt?: string;
  /** Set when a fire attempt failed (status "failed"). */
  failedAt?: string;
  /** Failure reason, present alongside `failedAt`. */
  lastError?: string;
}

/** Marks a turn (and its inbound prompt message) as originating from a fired
 *  scheduled task, so the web can badge it and link back to the schedule entry. */
export interface ScheduledOriginDto {
  taskId: string;
  executeAt: string;
}

// Keep in sync with OrchestrationTaskStatus in src/orchestration/orchestration-types.ts
export type OrchestrationTaskStatusDto =
  | "needs_confirmation"
  | "queued"
  | "running"
  | "blocked"
  | "waiting_for_human"
  | "completed"
  | "failed"
  | "cancelled";

/** Wire DTO for an orchestration task; projected from core OrchestrationTaskRecord. */
export interface OrchestrationTaskDto {
  taskId: string;
  status: OrchestrationTaskStatusDto;
  targetAgent: string;
  workspace: string;
  task: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export type ToolStepStatus = "running" | "success" | "error";
export type ToolStepKind = "read" | "search" | "execute" | "edit" | "think" | "other";

/** Friendly, presentation-ready detail for one tool call (no raw JSON crosses the wire). */
export type ToolDetailDto =
  | { type: "diff"; path: string; oldText: string; newText: string }
  | { type: "read"; path: string; lines?: string; preview?: string }
  | { type: "command"; command: string; output?: string; exitCode?: number }
  | { type: "search"; query: string; output?: string }
  | { type: "text"; text: string }
  | { type: "fields"; fields: Array<{ label: string; value: string }>; output?: string };

/** One collapsed tool-call step, normalized at the connector from a core ToolUseEvent. */
export interface ToolStepDto {
  toolCallId: string;
  toolName: string;
  kind: ToolStepKind;
  status: ToolStepStatus;
  title: string;
  durationMs?: number;
  detail?: ToolDetailDto;
  /** Failure message, present only when status === "error". */
  error?: string;
}

/** One entry in a turn's transcript, ordered as the agent produced it. Lets the web
 *  render text / reasoning / tool calls inline in arrival order instead of bucketing
 *  them into separate aggregated panels. */
export type TurnPartDto =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; step: ToolStepDto };

/** One entry in the agent's ACP plan (todo list). STRUCTURALLY IDENTICAL to core
 *  PlanEntry — the connector forwards plan events as pass-through, so any drift here
 *  silently breaks the wire. */
export interface PlanEntryDto {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: "high" | "medium" | "low";
}

/** Wire mirror of src/control ControlEvent (tool-event carries the NORMALIZED step). */
export type ControlEventDto =
  | { type: "turn-output"; chatKey: string; sessionAlias: string; chunk: string }
  // `prompt`/`scheduled` are set only for turns started by a fired scheduled task,
  // so the hub can persist the inbound prompt and the web can badge it.
  | { type: "turn-started"; chatKey: string; sessionAlias: string; prompt?: string; scheduled?: ScheduledOriginDto }
  | { type: "tool-event"; chatKey: string; sessionAlias: string; step: ToolStepDto }
  | { type: "turn-thought"; chatKey: string; sessionAlias: string; chunk: string }
  | { type: "plan"; chatKey: string; sessionAlias: string; entries: PlanEntryDto[] }
  // Context-usage meter: `used` tokens in context, `size` total context window. Replace-latest.
  | { type: "turn-usage"; chatKey: string; sessionAlias: string; used: number; size: number }
  | { type: "turn-finished"; chatKey: string; sessionAlias: string; ok: boolean; errorMessage?: string; cancelled?: boolean }
  | { type: "sessions-changed" }
  | { type: "scheduled-changed"; chatKey: string }
  // Recovered prior conversation for a freshly-attached native session; the hub seeds
  // these rows into the session's history so the dashboard isn't blank.
  | { type: "session-history"; chatKey: string; sessionAlias: string; messages: SessionHistoryRowDto[] }
  | { type: "orchestration-changed" };

/** One recovered history row (a persisted-shaped message) for a native-session seed. */
export interface SessionHistoryRowDto {
  direction: "in" | "out";
  text: string;
  structured?: { toolSteps?: ToolStepDto[]; reasoning?: string; parts?: TurnPartDto[] };
}
