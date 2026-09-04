import type { ClaudeSettingsPolicy } from "../../adapters/claude-settings-policy";
import type { NonInteractivePermissions, PermissionMode } from "../../config/types";
import type { AgentCommand, AgentSessionListResult, PromptMediaInput, SessionEffortState, ToolEventMode, UsageBreakdown, UsageCost } from "../../transport/types";
import type { PlanEntry, ToolUseEvent } from "../../channels/types.js";

/**
 * The single engine seam between BridgeServer and whatever executes sessions
 * (plan §7). Method shapes mirror the BridgeRuntime surface BridgeServer
 * already invokes, so CliEngine is pure delegation and RuntimeEngine can slot
 * in without touching the daemon-facing bridge contract.
 */
export interface BridgeEngine {
  readonly kind: "cli" | "runtime";
  hasSession(input: EngineSessionInput): Promise<{ exists: boolean }>;
  tailSessionHistory(input: EngineSessionInput & { lines: number }): Promise<{ text: string }>;
  listAgentSessions(input: EngineListInput): Promise<AgentSessionListResult | undefined>;
  ensureSession(input: EngineSessionInput, onProgress?: (progress: EnsureEngineSessionProgress) => void): Promise<Record<string, never>>;
  resumeAgentSession(input: EngineSessionInput & { agentSessionId: string }): Promise<Record<string, never>>;
  prompt(
    input: EnginePromptInput,
    onEvent?: (event: EnginePromptStreamEvent) => void,
  ): Promise<{ text: string }>;
  injectMessage(input: EngineInjectInput): Promise<SessionMessageReceiptLike>;
  setMode(input: EngineSessionInput & { modeId: string }): Promise<Record<string, never>>;
  setModel(input: EngineSessionInput & { modelId: string }): Promise<Record<string, never>>;
  getSessionModel(input: EngineSessionInput): Promise<{ current?: string; available: string[] }>;
  setSessionEffort(input: EngineSessionInput & { effort: string }): Promise<Record<string, never>>;
  getSessionEffort(input: EngineSessionInput): Promise<SessionEffortState>;
  cancel(input: EngineSessionInput): Promise<{ cancelled: boolean; message: string }>;
  removeSession(input: EngineSessionInput): Promise<Record<string, never>>;
  deleteSession(input: EngineSessionInput): Promise<Record<string, never>>;
  freeWarmProcess(input: EngineSessionInput): Promise<Record<string, never>>;
  isSessionWarm(input: EngineSessionInput): Promise<{ warm: boolean }>;
  getAgentSessionId(input: EngineSessionInput): Promise<{ agentSessionId: string | undefined }>;
  updatePermissionPolicy(policy: {
    permissionMode: PermissionMode;
    nonInteractivePermissions: NonInteractivePermissions;
    permissionPolicy?: string;
  }): Promise<Record<string, never>>;
  /** Transactional prepare: preflight idle workers + hold the admission lock (plan §32). */
  preparePolicyTransition?(): Promise<void>;
  /**
   * Transactional stage: validate, snapshot, mutate globals, fan out — but
   * HOLD the admission lock. The caller settles the downstream commit, then
   * finalizes (success) or rolls back (failure). Never releases the lock.
   */
  stagePolicyTransition?(policy: {
    permissionMode: PermissionMode;
    nonInteractivePermissions: NonInteractivePermissions;
    permissionPolicy?: string;
  }): Promise<void>;
  /** Transactional finalize: clear the staged snapshot and release the admission lock. */
  finalizePolicyTransition?(): void;
  /** Transactional commit: snapshot new policy after all engines prepared (plan §32). */
  commitPolicyTransition?(policy: {
    permissionMode: PermissionMode;
    nonInteractivePermissions: NonInteractivePermissions;
    permissionPolicy?: string;
  }): Promise<void>;
  /** Transactional rollback: abort the staged snapshot to all-old (or fail-closed latch) and release the lock. */
  rollbackPolicyTransition?(): Promise<void>;
  shutdown(): Promise<Record<string, never>>;
}

/** Session-scoped input shared by every engine method. */
export interface EngineSessionInput {
  agent: string;
  driver?: string;
  settingsPolicy?: ClaudeSettingsPolicy;
  agentCommand?: string;
  acpxAgent?: string;
  rawCommand?: string;
  agentArgv?: string[];
  cwd: string;
  name: string;
  sessionKey?: string;
  model?: string;
  effort?: string;
  mcpCoordinatorSession?: string;
  mcpSourceHandle?: string;
  /** Immutable logical-session id from the daemon; preferred affinity key. */
  logicalSessionId?: string;
  /** Daemon-declared persisted engine for this session (plan §48). */
  transportEngine?: "cli" | "runtime";
}

export interface EngineListInput {
  agent: string;
  driver?: string;
  settingsPolicy?: ClaudeSettingsPolicy;
  agentCommand?: string;
  acpxAgent?: string;
  rawCommand?: string;
  agentArgv?: string[];
  cwd: string;
  cursor?: string;
  filterCwd?: string;
}


export interface EnginePromptInput extends EngineSessionInput {
  text: string;
  replyMode?: "stream" | "final" | "verbose";
  toolEvents?: boolean;
  toolEventMode?: ToolEventMode;
  media?: PromptMediaInput;
}

export interface EngineInjectInput extends EngineSessionInput {
  text: string;
  mode: "auto" | "steer" | "queue" | "interrupt";
  messageId: string;
}

export type EnsureEngineSessionProgress =
  | "spawn"
  | "initializing"
  | "ready"
  | { kind: "note"; text: string };

export type EnginePromptStreamEvent =
  | { type: "prompt.segment"; text: string }
  | { type: "prompt.tool_event"; event: ToolUseEvent }
  | { type: "prompt.thought"; text: string }
  | { type: "prompt.plan"; entries: PlanEntry[] }
  | { type: "prompt.usage"; used: number; size: number; cost?: UsageCost; breakdown?: UsageBreakdown }
  | { type: "prompt.commands"; commands: AgentCommand[] };

export interface SessionMessageReceiptLike {
  status: "queued";
  modeUsed: "queue";
}
