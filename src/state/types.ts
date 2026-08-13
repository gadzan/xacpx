import { createEmptyOrchestrationState, type OrchestrationState } from "../orchestration/orchestration-types";
import type { ScheduledTaskRecord } from "../scheduled/scheduled-types";

export type LogicalSessionSource = "xacpx" | "agent-side";

export interface NativeSessionCacheEntry {
  session_id: string;
  cwd?: string;
  title?: string | null;
  updated_at?: string;
}

export interface NativeSessionListCacheRecord {
  created_at: string;
  agent: string;
  workspace?: string;
  cwd: string;
  sessions: NativeSessionCacheEntry[];
  next_cursor?: string | null;
}

export interface LogicalSession {
  alias: string;
  agent: string;
  workspace: string;
  transport_session: string;
  /**
   * Immutable identity of this logical session (UUIDv4), assigned once at
   * create/attach time. Never changes across rename, display-name, agent,
   * workspace, or transport-binding updates; never reused after the alias is
   * deleted. Legacy records missing the field are migrated once at load time
   * and persisted before startup proceeds.
   */
  logical_session_id: string;
  source?: LogicalSessionSource;
  agent_session_id?: string;
  agent_session_title?: string;
  agent_session_updated_at?: string;
  attached_at?: string;
  transport_agent_command?: string;
  /** Positional acpx agent recorded at launch: overlay alias for structured
   * launches. Derived managed values are recomputed on restart from the current
   * pin; only truly custom launches keep their recorded alias/argv. */
  transport_acpx_agent?: string;
  transport_agent_argv?: string[];
  mode_id?: string;
  /** Per-session LLM model override (e.g. `gpt-5.2[high]`); falls back to the agent config default. */
  model?: string;
  /** Per-session reasoning-effort preference advertised by the active ACP adapter. */
  effort?: string;
  /** Per-session cosmetic display label shown in the relay-web dashboard only.
   *  Never affects identity (`alias`), `/use`, or the transport session. Cleared → UI shows alias. */
  display_name?: string;
  reply_mode?: "stream" | "final" | "verbose";
  /** True when the user archived this session: process closed, row greyed + sunk.
   *  Cleared on the next useSession (restore-on-message). */
  archived?: boolean;
  archived_at?: string;
  created_at: string;
  last_used_at: string;
}

export interface BackgroundResult {
  text: string;
  status: "done" | "error";
  finished_at: string;
}

export interface ChatContextState {
  current_session: string;
  previous_session?: string;
  background_results?: Record<string, BackgroundResult>;
}

export interface AppState {
  sessions: Record<string, LogicalSession>;
  chat_contexts: Record<string, ChatContextState>;
  native_session_lists: Record<string, NativeSessionListCacheRecord>;
  orchestration: OrchestrationState;
  scheduled_tasks: Record<string, ScheduledTaskRecord>;
}

export function createEmptyState(): AppState {
  return {
    sessions: {},
    chat_contexts: {},
    native_session_lists: {},
    orchestration: createEmptyOrchestrationState(),
    scheduled_tasks: {},
  };
}
