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
}

/** Wire mirror of src/control ControlEvent (tool-event carries the NORMALIZED step). */
export type ControlEventDto =
  | { type: "turn-output"; chatKey: string; sessionAlias: string; chunk: string }
  | { type: "turn-started"; chatKey: string; sessionAlias: string }
  | { type: "tool-event"; chatKey: string; sessionAlias: string; step: ToolStepDto }
  | { type: "turn-thought"; chatKey: string; sessionAlias: string; chunk: string }
  | { type: "turn-finished"; chatKey: string; sessionAlias: string; ok: boolean; errorMessage?: string; cancelled?: boolean }
  | { type: "sessions-changed" }
  | { type: "scheduled-changed"; chatKey: string }
  | { type: "orchestration-changed" };
