import type { Agent as ChatAgent } from "../weixin/agent/interface";
import type { SessionService } from "../sessions/session-service";
import type { AgentSession, ResolvedSession, SessionTransport } from "../transport/types";
import type { ActiveTurnRegistry } from "../sessions/active-turn-registry";
import type {
  CreateScheduledTaskInput,
  ScheduledTaskService,
} from "../scheduled/scheduled-service";
import type { ScheduledTaskRecord } from "../scheduled/scheduled-types";
import type {
  CancelTaskInput,
  OrchestrationService,
  OrchestrationTaskFilter,
} from "../orchestration/orchestration-service";
import type { OrchestrationTaskRecord } from "../orchestration/orchestration-types";
import {
  getChannelIdFromChatKey,
  isSessionAliasVisibleInChannel,
  toDisplaySessionAlias,
} from "../channels/channel-scope";
import type { ControlEventBus } from "./control-event-bus";
import { readNativeSessionHistory, type NativeHistoryMessage } from "../transport/native-session-history";
import type { AgentCatalogEntry } from "../config/agent-catalog";
import { WorkspaceFs, type DirListing, type FileContent, type SearchOptions, type SearchResult, type WorkspaceDiff } from "./workspace-fs";
import {
  WorkspaceGit,
  type GitCheckoutOptions,
  type GitCommitResult,
  type GitPushOptions,
  type GitStatus,
  type GitWorktreeCreateOptions,
  type GitWorktreeCreateResult,
} from "./workspace-git";
import type { PromptAttachmentRef } from "@ganglion/xacpx-relay-protocol";
import type { UploadStore } from "./upload-store.js";
import { SessionTurnRunner } from "./session-turn-runner";
import { TurnQueue } from "./turn-queue";
import { buildControlMetadata, type TurnIdleTimeoutDetail } from "./turn-support";
import {
  BRIDGE_REQUEST_TIMEOUT_GRACE_MS,
  DEFAULT_MANAGEMENT_COMMAND_TIMEOUT_MS,
  isCommandTimeoutError,
} from "../transport/command-timeouts";
import type { AppLogger } from "../logging/app-logger";

const MODEL_SET_SETTLE_BUDGET_MS = 2 * (
  DEFAULT_MANAGEMENT_COMMAND_TIMEOUT_MS + BRIDGE_REQUEST_TIMEOUT_GRACE_MS
);

export interface ModelSetRequestOptions {
  /** Connector-side deadline derived from the Hub request lifetime. */
  deadlineAt?: number;
}

export interface ControlSessionInfo {
  alias: string;
  agent: string;
  workspace: string;
  transportSession: string;
  running: boolean;
  archived: boolean;
  /** True when this logical session was attached to an existing agent-side (native) rollout
   *  rather than freshly created. Mirrors LogicalSession.source === "agent-side"; omitted for
   *  fresh xacpx sessions so the wire stays minimal. */
  native?: boolean;
  /** The agent adapter command this session runs (acpx-recorded, or the agent's resolved
   *  default). Surfaced so the web can avoid seeding a new session's model picker from a
   *  session on a different adapter version (whose advertised model ids may be in an
   *  incompatible format). Omitted when unknown. */
  agentCommand?: string;
  /** Cosmetic relay-web display label; omitted when unset so the wire stays minimal. */
  displayName?: string;
}

export interface ControlAgentInfo {
  name: string;
  driver: string;
}

/** An agent-native (acpx-owned) session available to attach as a new logical session. */
export interface ControlNativeSessionInfo {
  sessionId: string;
  title?: string | null;
  updatedAt?: string;
  cwd?: string;
}

export interface ControlWorkspaceInfo {
  name: string;
  cwd: string;
  description?: string;
}

export interface ControlServiceDeps {
  logger?: Pick<AppLogger, "error">;
  /** Test seam for queue-deadline decisions. */
  now?: () => number;
  agent: Pick<ChatAgent, "chat">;
  sessions: Pick<
    SessionService,
    "listAllResolvedSessions" | "removeSession" | "useSession" | "resolveAliasForChat" | "getSession" | "setSessionModel" | "setDisplayName"
  >;
  // The active transport, for reading/switching a session's model and effort.
  // These controls are optional on the interface — absence is handled gracefully.
  transport: Pick<SessionTransport, "setModel" | "getSessionModel" | "setSessionEffort" | "getSessionEffort">;
  // Full-lifecycle session creator (resolve → ensure acpx session → bind),
  // wired to CommandRouter.createSessionWithTransport in main.ts. Replaces the
  // logical-only sessions.createSession so control-created sessions are promptable.
  createSessionWithTransport: (internalAlias: string, agent: string, workspace: string, model?: string) => Promise<ResolvedSession>;
  // Full-lifecycle session teardown/archival, wired to CommandRouter in main.ts so the
  // web path shares the chat path's shared-transport guard + acpx teardown.
  removeSessionWithTransport: (internalAlias: string) => Promise<{ wasActive: boolean }>;
  archiveSessionWithTransport: (internalAlias: string) => Promise<void>;
  unarchiveSession: (internalAlias: string) => Promise<void>;
  // List the agent-native sessions for an agent + workspace (web native-attach picker).
  listNativeSessions: (agent: string, workspace: string) => Promise<AgentSession[]>;
  // Bind a new logical session to an EXISTING agent-native session (resume), the web
  // counterpart of `/ssn` → select. Wired to CommandRouter.attachNativeSessionWithTransport.
  attachNativeSessionWithTransport: (
    internalAlias: string,
    agent: string,
    workspace: string,
    agentSessionId: string,
    nativeMeta?: { title?: string | null; updatedAt?: string },
  ) => Promise<ResolvedSession>;
  activeTurns: Pick<ActiveTurnRegistry, "isActiveAnywhere">;
  scheduled: Pick<ScheduledTaskService, "listPending" | "listRecentForChat" | "createTask" | "cancelPending">;
  orchestration: Pick<OrchestrationService, "listTasks" | "getTask" | "requestTaskCancellation">;
  events: ControlEventBus;
  // Read-only config views + a persisting workspace creator. Supplied by main.ts
  // where the live AppConfig and ConfigStore are in scope; created workspaces are
  // written back into the live config so SessionService validation sees them.
  agents: {
    list(): ControlAgentInfo[];
    catalog(): AgentCatalogEntry[];
    create(name: string, driver: string): Promise<ControlAgentInfo>;
    remove(name: string): Promise<void>;
  };
  workspaces: {
    list(): ControlWorkspaceInfo[];
    create(name: string, cwd: string, description?: string): Promise<ControlWorkspaceInfo>;
    remove(name: string): Promise<void>;
  };
  uploadStore: UploadStore;
  // Interactive terminal PTY manager (web terminal). Optional gate read from live config.
  terminal: import("./terminal-service").TerminalService;
  terminalEnabled: () => boolean;
  filesWriteEnabled: () => boolean;
  /** Test/embedding override; production defaults to ~/.xacpx/worktrees. */
  gitWorktreesRoot?: string;
  // Inactivity watchdog threshold in ms for in-flight turns; absent ⇒ disabled. Wired in
  // main.ts from transport.turnIdleTimeoutSeconds. Optional so existing tests need no change.
  turnIdleTimeoutMs?: () => number;
  // Observability hook fired when the inactivity watchdog reclaims a wedged turn, carrying the
  // concrete threshold. main.ts wires this to the app logger. Optional ⇒ no logging.
  onTurnIdleTimeout?: (detail: TurnIdleTimeoutDetail) => void;
}

export interface ControlPromptInput {
  chatKey: string;
  sessionAlias: string;
  text: string;
  accountId?: string;
  senderId: string;
  isOwner?: boolean;
  media?: PromptAttachmentRef[];
}

export interface ControlPromptResult {
  ok: boolean;
  text?: string;
  errorMessage?: string;
  /** True when this prompt did not run immediately and was instead appended to the
   *  per-session server-side queue (a turn was already in flight). */
  queued?: boolean;
  /** Id of the queued item, present only when `queued` is true. Used to cancel it via
   *  `cancelQueuedItem` before it drains. */
  queueItemId?: string;
}

/** A turn started by a fired scheduled task. Runs through the same agent + turn-event
 *  machinery as a normal prompt, so it streams live and persists to history — but it
 *  also carries the prompt text + schedule origin in turn-started, so the hub can
 *  persist the inbound message and the web can badge the run. */
export interface ControlScheduledTurnInput {
  chatKey: string;
  sessionAlias: string;
  promptText: string;
  taskId: string;
  executeAt: string;
  accountId?: string;
  abortSignal?: AbortSignal;
}

export interface ControlExecuteCommandInput {
  chatKey: string;
  text: string;
  accountId?: string;
  senderId: string;
  isOwner?: boolean;
}

// Thin structured facade over core services for non-text consumers (the relay
// connector first). Holds no state of its own beyond in-flight turn tracking.
export class ControlService {
  private readonly runner: SessionTurnRunner;
  private readonly turnQueue: TurnQueue;
  private readonly workspaceGit: WorkspaceGit;
  private readonly sessionConfigSetTails = new Map<string, Promise<void>>();
  private readonly worktreeRegistrationTails = new Map<string, Promise<void>>();

  constructor(private readonly deps: ControlServiceDeps) {
    this.workspaceGit = new WorkspaceGit(
      () => this.deps.workspaces.list().map((w) => ({ name: w.name, cwd: w.cwd })),
      { ...(deps.gitWorktreesRoot ? { managedWorktreesRoot: deps.gitWorktreesRoot } : {}) },
    );
    this.runner = new SessionTurnRunner(deps);
    this.turnQueue = new TurnQueue({
      runTurn: (req, signal, onActivity) => this.runner.run(req, signal, onActivity),
      ...(this.deps.turnIdleTimeoutMs ? { turnIdleTimeoutMs: this.deps.turnIdleTimeoutMs } : {}),
      ...(this.deps.onTurnIdleTimeout ? { onIdleTimeout: this.deps.onTurnIdleTimeout } : {}),
      emitQueueUpdated: (chatKey, sessionAlias, items) =>
        this.deps.events.emit({ type: "queue-updated", chatKey, sessionAlias, items }),
      detectSessionsChanged: async (detection) => {
        try {
          const after = await this.deps.sessions.getSession(detection.internalAlias);
          if (after && after.transportSession !== detection.priorTransportSession) {
            this.deps.events.emit({ type: "sessions-changed" });
          }
        } catch {
          /* best-effort: no refresh on detection failure */
        }
      },
    });
  }

  // Read-only workspace file browser, scoped to configured workspace roots. Lazily
  // reads the live workspace list so newly-created workspaces are immediately browsable.
  private readonly workspaceFs = new WorkspaceFs(() =>
    this.deps.workspaces.list().map((w) => ({ name: w.name, cwd: w.cwd })),
  );
  listDirectory(workspace: string, path?: string): Promise<DirListing> {
    return this.workspaceFs.listDirectory(workspace, path);
  }

  readWorkspaceFile(workspace: string, path: string): Promise<FileContent> {
    return this.workspaceFs.readFile(workspace, path);
  }

  workspaceGitDiff(workspace: string, path?: string): Promise<WorkspaceDiff> {
    return this.workspaceFs.gitDiff(workspace, path);
  }

  workspaceGitStatus(workspace: string): Promise<GitStatus> {
    return this.workspaceGit.status(workspace);
  }

  private async mutateWorkspaceGit<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.deps.filesWriteEnabled()) throw new Error("files-write-disabled");
    return operation();
  }

  private async withWorktreeRegistration<T>(workspaceName: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.worktreeRegistrationTails.get(workspaceName) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => current);
    this.worktreeRegistrationTails.set(workspaceName, tail);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.worktreeRegistrationTails.get(workspaceName) === tail) {
        this.worktreeRegistrationTails.delete(workspaceName);
      }
    }
  }

  gitStage(workspace: string, paths: string[]): Promise<void> {
    return this.mutateWorkspaceGit(() => this.workspaceGit.stage(workspace, paths));
  }

  gitUnstage(workspace: string, paths: string[]): Promise<void> {
    return this.mutateWorkspaceGit(() => this.workspaceGit.unstage(workspace, paths));
  }

  gitCommit(workspace: string, message: string): Promise<GitCommitResult> {
    return this.mutateWorkspaceGit(() => this.workspaceGit.commit(workspace, message));
  }

  gitFetch(workspace: string, remote?: string): Promise<void> {
    return this.mutateWorkspaceGit(() => this.workspaceGit.fetch(workspace, remote));
  }

  gitPull(workspace: string): Promise<void> {
    return this.mutateWorkspaceGit(() => this.workspaceGit.pull(workspace));
  }

  gitPush(workspace: string, options?: GitPushOptions): Promise<void> {
    return this.mutateWorkspaceGit(() => this.workspaceGit.push(workspace, options));
  }

  gitCheckout(workspace: string, options: GitCheckoutOptions): Promise<void> {
    return this.mutateWorkspaceGit(() => this.workspaceGit.checkout(workspace, options));
  }

  async gitCreateWorktree(
    workspace: string,
    input: GitWorktreeCreateOptions & { workspaceName: string },
  ): Promise<{ worktree: GitWorktreeCreateResult; workspace: ControlWorkspaceInfo }> {
    const workspaceName = input.workspaceName.trim();
    if (!workspaceName) throw new Error("workspace-name-required");
    return this.mutateWorkspaceGit(() => this.withWorktreeRegistration(workspaceName, async () => {
      if (this.deps.workspaces.list().some((item) => item.name === workspaceName)) {
        throw new Error("workspace-name-exists");
      }
      const worktree = await this.workspaceGit.createWorktree(workspace, input);
      try {
        const registered = await this.deps.workspaces.create(
          workspaceName,
          worktree.path,
          `Git worktree for ${worktree.branch}`,
        );
        return { worktree, workspace: registered };
      } catch (registrationError) {
        try {
          await this.workspaceGit.removeManagedWorktree(workspace, worktree.path);
        } catch (rollbackError) {
          throw new AggregateError(
            [registrationError, rollbackError],
            "workspace-registration-rollback-failed",
          );
        }
        throw registrationError;
      }
    }));
  }

  searchWorkspace(workspace: string, opts: SearchOptions): Promise<SearchResult> {
    return this.workspaceFs.search(workspace, opts);
  }

  async fsCreate(workspace: string, path: string, kind: "file" | "dir"): Promise<{ path: string }> {
    if (!this.deps.filesWriteEnabled()) throw new Error("files-write-disabled");
    return kind === "dir" ? this.workspaceFs.createDir(workspace, path) : this.workspaceFs.createFile(workspace, path);
  }

  async fsRename(workspace: string, path: string, newName: string): Promise<{ path: string }> {
    if (!this.deps.filesWriteEnabled()) throw new Error("files-write-disabled");
    return this.workspaceFs.rename(workspace, path, newName);
  }

  async fsDelete(workspace: string, path: string): Promise<{ path: string }> {
    if (!this.deps.filesWriteEnabled()) throw new Error("files-write-disabled");
    return this.workspaceFs.remove(workspace, path);
  }

  async fsCopy(workspace: string, path: string): Promise<{ path: string }> {
    if (!this.deps.filesWriteEnabled()) throw new Error("files-write-disabled");
    return this.workspaceFs.duplicate(workspace, path);
  }

  async fsWrite(
    workspace: string,
    path: string,
    content: string,
    expected: { mtimeMs: number; size: number },
  ): Promise<{ path: string; mtimeMs: number; size: number }> {
    if (!this.deps.filesWriteEnabled()) throw new Error("files-write-disabled");
    return this.workspaceFs.writeFile(workspace, path, content, expected);
  }

  async fsDownload(workspace: string, path: string): Promise<{ path: string; base64: string; size: number; mimeType: string }> {
    return this.workspaceFs.readFileBytes(workspace, path); // read op — intentionally NOT gated
  }

  async uploadFile(input: { filename: string; content: string; mimeType: string }): Promise<{ id: string; path: string; filename: string; mimeType: string; size: number }> {
    return this.deps.uploadStore.save(input.filename, input.content, input.mimeType);
  }

  /** Read a session's current model and the agent-advertised available ids. */
  async getSessionModel(chatKey: string, alias: string): Promise<{ current?: string; available: string[] }> {
    const session = await this.resolveControlSession(chatKey, alias);
    if (!session) return { available: [] };
    if (!this.deps.transport.getSessionModel) return { current: session.model, available: [] };
    return await this.deps.transport.getSessionModel(session);
  }

  /** Switch a session's model (acpx validates the id) and persist the override. */
  async setSessionModel(
    chatKey: string,
    alias: string,
    modelId: string,
    options: ModelSetRequestOptions = {},
  ): Promise<{ current?: string; applied: boolean }> {
    const session = await this.resolveControlSession(chatKey, alias);
    if (!session) throw new Error("session not found");
    const setModel = this.deps.transport.setModel?.bind(this.deps.transport);
    if (!setModel) throw new Error("the active transport does not support switching models");
    return await this.runSessionConfigSetExclusive(session.alias, async () => {
      if (
        typeof options.deadlineAt === "number"
        && Number.isFinite(options.deadlineAt)
        && (this.deps.now?.() ?? Date.now()) + MODEL_SET_SETTLE_BUDGET_MS > options.deadlineAt
      ) {
        throw new Error("model switch deadline is too close to safely start the queued operation");
      }
      try {
        await setModel(session, modelId);
      } catch (error) {
        // A process timeout is ambiguous: acpx may have applied the model before it
        // stopped responding. Read back the authoritative transport state so the
        // persisted logical session and relay-web's optimistic chip cannot diverge.
        if (!isCommandTimeoutError(error) || !this.deps.transport.getSessionModel) throw error;
        let observed: { current?: string; available: string[] };
        try {
          observed = await this.deps.transport.getSessionModel(session);
        } catch {
          // Preserve the original timeout; reconciliation is best-effort diagnostics.
          throw error;
        }
        await this.deps.sessions.setSessionModel(session.alias, observed.current);
        try {
          await this.deps.logger?.error(
            "control.session.model.timeout_reconciled",
            "Model switch timed out; adopted authoritative transport state",
            {
              sessionAlias: session.alias,
              requestedModel: modelId,
              observedModel: observed.current ?? null,
              timeout: error instanceof Error ? error.message : String(error),
            },
          );
        } catch {
          // Logging is diagnostic only; reconciliation already succeeded.
        }
        return { current: observed.current, applied: observed.current === modelId };
      }
      await this.deps.sessions.setSessionModel(session.alias, modelId);
      return { current: modelId, applied: true };
    });
  }

  /** Read the reasoning-effort values advertised by the session's adapter. */
  async getSessionEffort(chatKey: string, alias: string): Promise<{ current?: string; available: string[] }> {
    const session = await this.resolveControlSession(chatKey, alias);
    if (!session || !this.deps.transport.getSessionEffort) return { available: [] };
    return await this.deps.transport.getSessionEffort(session);
  }

  /** Set the adapter-advertised reasoning effort for a session. */
  async setSessionEffort(
    chatKey: string,
    alias: string,
    effort: string,
  ): Promise<{ current?: string; applied: boolean }> {
    const session = await this.resolveControlSession(chatKey, alias);
    if (!session) throw new Error("session not found");
    const setEffort = this.deps.transport.setSessionEffort?.bind(this.deps.transport);
    if (!setEffort) throw new Error("the active transport does not support setting reasoning effort");
    return await this.runSessionConfigSetExclusive(session.alias, async () => {
      try {
        await setEffort(session, effort);
      } catch (error) {
        const getEffort = this.deps.transport.getSessionEffort?.bind(this.deps.transport);
        if (!isCommandTimeoutError(error) || !getEffort) throw error;
        let observed: { current?: string; available: string[] };
        try {
          observed = await getEffort(session);
        } catch {
          // Preserve the original timeout when authoritative reconciliation fails.
          throw error;
        }
        try {
          await this.deps.logger?.error(
            "control.session.effort.timeout_reconciled",
            "Effort switch timed out; adopted authoritative transport state",
            {
              sessionAlias: session.alias,
              requestedEffort: effort,
              observedEffort: observed.current ?? null,
              timeout: error instanceof Error ? error.message : String(error),
            },
          );
        } catch {
          // Logging is diagnostic only; reconciliation already succeeded.
        }
        return { current: observed.current, applied: observed.current === effort };
      }
      return { current: effort, applied: true };
    });
  }

  /** Serialize adapter configuration mutations per logical session so stale operations cannot win last. */
  private async runSessionConfigSetExclusive<T>(sessionAlias: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionConfigSetTails.get(sessionAlias) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    this.sessionConfigSetTails.set(sessionAlias, tail);

    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionConfigSetTails.get(sessionAlias) === tail) {
        this.sessionConfigSetTails.delete(sessionAlias);
      }
    }
  }

  /** Set (or clear) a session's relay-web display label and persist it. */
  async setSessionDisplayName(chatKey: string, alias: string, displayName: string): Promise<void> {
    const session = await this.resolveControlSession(chatKey, alias);
    if (!session) throw new Error("session not found");
    await this.deps.sessions.setDisplayName(session.alias, displayName);
  }

  /** Resolve a chat-scoped display alias to its ResolvedSession, or null. */
  private async resolveControlSession(chatKey: string, alias: string): Promise<ResolvedSession | null> {
    const internalAlias = await this.deps.sessions.resolveAliasForChat(chatKey, alias);
    return await this.deps.sessions.getSession(internalAlias);
  }

  get events(): ControlEventBus {
    return this.deps.events;
  }

  // Sessions are keyed by a channel-scoped internal alias (e.g. `relay:demo`).
  // The relay's chatKey is `relay:<accountId>`, so create/list/remove all scope
  // to that channel — otherwise a session created here is invisible to a prompt,
  // which resolves the same alias scoped. Aliases cross the wire in display form.
  listSessions(chatKey: string): ControlSessionInfo[] {
    const channelId = getChannelIdFromChatKey(chatKey);
    return this.deps.sessions
      .listAllResolvedSessions()
      .filter((session) => isSessionAliasVisibleInChannel(session.alias, channelId))
      .map((session) => ({
        alias: toDisplaySessionAlias(session.alias),
        agent: session.agent,
        workspace: session.workspace,
        transportSession: session.transportSession,
        running: this.deps.activeTurns.isActiveAnywhere(session.alias),
        archived: session.archived === true,
        ...(session.source === "agent-side" ? { native: true } : {}),
        ...(session.agentCommand ? { agentCommand: session.agentCommand } : {}),
        ...(session.displayName ? { displayName: session.displayName } : {}),
      }));
  }

  /**
   * List the agent-native (acpx-owned) sessions for an agent + workspace, so the web
   * add-session dialog can offer "attach an existing native session". These are the
   * agent's own rollouts on disk (per-cwd), not chat-scoped — chatKey is accepted only
   * for call-shape symmetry with the other session control methods.
   */
  async listNativeSessions(_chatKey: string, agent: string, workspace: string): Promise<ControlNativeSessionInfo[]> {
    const sessions = await this.deps.listNativeSessions(agent, workspace);
    return sessions.map((s) => ({
      sessionId: s.sessionId,
      title: s.title ?? null,
      ...(s.updatedAt !== undefined ? { updatedAt: s.updatedAt } : {}),
      ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
    }));
  }

  async createSession(
    chatKey: string,
    alias: string,
    agent: string,
    workspace: string,
    agentSessionId?: string,
    model?: string,
  ): Promise<ControlSessionInfo> {
    const internalAlias = await this.deps.sessions.resolveAliasForChat(chatKey, alias);
    // When an agentSessionId is supplied the user picked an existing native session to
    // resume; otherwise create a fresh transport session (the default `/session new`).
    // Native attach: recover the agent-side rollout's prior conversation from acpx's own
    // persisted record and seed it into history, so the dashboard isn't blank. This MUST
    // happen BEFORE the attach — acpx's resume reuses the source record and overwrites its
    // conversation with an empty one, so reading afterwards finds nothing. Best-effort: a
    // read failure (no record, shape drift) must never fail the attach itself.
    let nativeHistory: NativeHistoryMessage[] = [];
    if (agentSessionId) {
      try {
        nativeHistory = await readNativeSessionHistory({ agentSessionId });
      } catch {
        /* best-effort history seed */
      }
    }
    // `model` only applies to a fresh transport session; a native attach resumes the
    // agent-side rollout under its own recorded model and ignores the override.
    const session = agentSessionId
      ? await this.deps.attachNativeSessionWithTransport(internalAlias, agent, workspace, agentSessionId)
      : await this.deps.createSessionWithTransport(internalAlias, agent, workspace, model);
    this.deps.events.emit({ type: "sessions-changed" });
    if (nativeHistory.length > 0) {
      this.deps.events.emit({ type: "session-history", chatKey, sessionAlias: alias, messages: nativeHistory });
    }
    return {
      alias: toDisplaySessionAlias(session.alias),
      agent: session.agent,
      workspace: session.workspace,
      transportSession: session.transportSession,
      running: false,
      archived: false,
    };
  }

  async removeSession(chatKey: string, alias: string): Promise<{ wasActive: boolean }> {
    const internalAlias = await this.deps.sessions.resolveAliasForChat(chatKey, alias);
    const result = await this.deps.removeSessionWithTransport(internalAlias);
    this.deps.events.emit({ type: "sessions-changed" });
    return result;
  }

  async archiveSession(chatKey: string, alias: string): Promise<void> {
    const internalAlias = await this.deps.sessions.resolveAliasForChat(chatKey, alias);
    await this.deps.archiveSessionWithTransport(internalAlias);
    this.deps.events.emit({ type: "sessions-changed" });
  }

  async unarchiveSession(chatKey: string, alias: string): Promise<void> {
    const internalAlias = await this.deps.sessions.resolveAliasForChat(chatKey, alias);
    await this.deps.unarchiveSession(internalAlias);
    this.deps.events.emit({ type: "sessions-changed" });
  }

  listAgents(): ControlAgentInfo[] {
    return this.deps.agents.list();
  }

  listWorkspaces(): ControlWorkspaceInfo[] {
    return this.deps.workspaces.list();
  }

  createWorkspace(name: string, cwd: string, description?: string): Promise<ControlWorkspaceInfo> {
    return this.deps.workspaces.create(name, cwd, description);
  }

  listAgentCatalog(): AgentCatalogEntry[] {
    return this.deps.agents.catalog();
  }

  createAgent(name: string, driver: string): Promise<ControlAgentInfo> {
    return this.deps.agents.create(name, driver);
  }

  async removeAgent(name: string): Promise<void> {
    if (this.deps.sessions.listAllResolvedSessions().some((s) => s.agent === name)) {
      throw new Error(`agent "${name}" is in use by an existing session`);
    }
    await this.deps.agents.remove(name);
  }

  async removeWorkspace(name: string): Promise<void> {
    if (this.deps.sessions.listAllResolvedSessions().some((s) => s.workspace === name)) {
      throw new Error(`workspace "${name}" is in use by an existing session`);
    }
    await this.deps.workspaces.remove(name);
  }

  // The web panel shows upcoming AND recently-fired tasks (with their Done/Failed
  // status), so a triggered task leaves a record instead of vanishing. Text channels
  // (`/later list`) keep using listPending via the command handler.
  listScheduledTasks(chatKey: string): ScheduledTaskRecord[] {
    return this.deps.scheduled.listRecentForChat(chatKey);
  }

  async createScheduledTask(input: CreateScheduledTaskInput): Promise<ScheduledTaskRecord> {
    const task = await this.deps.scheduled.createTask(input);
    this.deps.events.emit({ type: "scheduled-changed", chatKey: input.chatKey });
    return task;
  }

  async cancelScheduledTask(id: string, chatKey: string): Promise<boolean> {
    const cancelled = await this.deps.scheduled.cancelPending(id, chatKey);
    if (cancelled) {
      this.deps.events.emit({ type: "scheduled-changed", chatKey });
    }
    return cancelled;
  }

  listOrchestrationTasks(filter?: OrchestrationTaskFilter): Promise<OrchestrationTaskRecord[]> {
    return this.deps.orchestration.listTasks(filter);
  }

  getOrchestrationTask(taskId: string): Promise<OrchestrationTaskRecord | null> {
    return this.deps.orchestration.getTask(taskId);
  }

  async cancelOrchestrationTask(input: CancelTaskInput): Promise<OrchestrationTaskRecord> {
    const task = await this.deps.orchestration.requestTaskCancellation(input);
    this.deps.events.emit({ type: "orchestration-changed" });
    return task;
  }

  async prompt(input: ControlPromptInput): Promise<ControlPromptResult> {
    return this.turnQueue.submit({
      chatKey: input.chatKey,
      sessionAlias: input.sessionAlias,
      text: input.text,
      senderId: input.senderId,
      queueable: true,
      ...(input.isOwner !== undefined ? { isOwner: input.isOwner } : {}),
      ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
      ...(input.media !== undefined ? { media: input.media } : {}),
    });
  }

  /** Run a fired scheduled task as a real turn through the same machinery as a manual
   *  prompt — so it streams live and persists to history — while tagging turn-started
   *  with the prompt text + schedule origin so the hub records the inbound message and
   *  the web can badge it. Owner-authorized: the task was owner-gated at creation. */
  async runScheduledTurn(input: ControlScheduledTurnInput): Promise<ControlPromptResult> {
    return this.turnQueue.submit({
      chatKey: input.chatKey,
      sessionAlias: input.sessionAlias,
      text: input.promptText,
      senderId: "scheduler",
      isOwner: true,
      ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      turnStarted: { prompt: input.promptText, scheduled: { taskId: input.taskId, executeAt: input.executeAt } },
    });
  }

  cancelTurn(chatKey: string, sessionAlias: string): boolean {
    return this.turnQueue.cancelTurn(chatKey, sessionAlias);
  }

  /** Remove a pending queued prompt (by id) before it drains. No-ops (returns
   *  `{ cancelled: false }`) when the queue or the id is absent/already drained —
   *  e.g. a race where the item drained into a running turn just before the cancel
   *  arrived. Does NOT touch a turn that is already running (use `cancelTurn`). */
  cancelQueuedItem(chatKey: string, sessionAlias: string, itemId: string): { cancelled: boolean } {
    return this.turnQueue.cancelQueuedItem(chatKey, sessionAlias, itemId);
  }

  async executeCommand(input: ControlExecuteCommandInput): Promise<string> {
    const chunks: string[] = [];
    const response = await this.deps.agent.chat({
      accountId: input.accountId ?? "control",
      conversationId: input.chatKey,
      text: input.text,
      metadata: buildControlMetadata(input.senderId, input.isOwner),
      reply: async (chunk) => {
        chunks.push(chunk);
      },
    });
    if (response.text) {
      chunks.push(response.text);
    }
    return chunks.join("\n");
  }

  /** Open an interactive terminal in the session's workspace cwd. Rejected when terminal is disabled. */
  async createTerminal(chatKey: string, sessionAlias: string, cols: number, rows: number): Promise<{ terminalId: string }> {
    if (!this.deps.terminalEnabled()) throw new Error("terminal-disabled");
    const session = await this.resolveControlSession(chatKey, sessionAlias);
    if (!session) throw new Error("session-not-found");
    return this.deps.terminal.create({ cwd: session.cwd, cols, rows });
  }

  attachTerminal(terminalId: string): import("./terminal-service").TerminalAttachResult {
    if (!this.deps.terminalEnabled()) throw new Error("terminal-disabled");
    return this.deps.terminal.attach(terminalId);
  }

  writeTerminal(terminalId: string, data: string): void {
    this.deps.terminal.write(terminalId, data);
  }

  resizeTerminal(terminalId: string, cols: number, rows: number): void {
    this.deps.terminal.resize(terminalId, cols, rows);
  }

  closeTerminal(terminalId: string): void {
    this.deps.terminal.close(terminalId);
  }
}
