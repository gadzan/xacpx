import type { Agent as ChatAgent } from "../weixin/agent/interface";
import type { SessionService } from "../sessions/session-service";
import type {
  AgentSession,
  ResolvedSession,
  SessionTransport,
} from "../transport/types";
import type { SessionMessageReceipt } from "../transport/message-injection";
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
import type {
  AgentMessageCompletion,
  AgentMessageMode,
} from "../orchestration/agent-messaging-types";
import {
  getChannelIdFromChatKey,
  isSessionAliasVisibleInChannel,
  scopeDisplayAliasToInternal,
  toDisplaySessionAlias,
  toInternalSessionAlias,
} from "../channels/channel-scope";
import { AgentMessagingError } from "../orchestration/agent-messaging-error";
import type { ControlEventBus } from "./control-event-bus";
import {
  readNativeSessionHistory,
  type NativeHistoryMessage,
} from "../transport/native-session-history";
import type { AgentCatalogEntry } from "../config/agent-catalog";
import {
  WorkspaceFs,
  browseDirectories as browseDirs,
  type BrowseDirsResult,
  type DirListing,
  type FileContent,
  type SearchOptions,
  type SearchResult,
  type WorkspaceDiff,
} from "./workspace-fs";
import {
  WorkspaceGit,
  type GitCheckoutOptions,
  type GitCommitResult,
  type GitPushOptions,
  type GitStatus,
  type GitWorktreeCreateOptions,
  type GitWorktreeCreateResult,
} from "./workspace-git";
import type {
  AgentEndpointView,
  AgentMessageTraceRecord,
} from "../orchestration/agent-messaging-types";
import type { PromptAttachmentRef } from "@ganglion/xacpx-relay-protocol";
import {
  buildControlMetadata,
  type TurnIdleTimeoutDetail,
  type PeerTurnOrigin,
} from "./turn-support";
import type { PeerInterruptEvent } from "./turn-queue";
import type { UploadStore } from "./upload-store.js";
import { SessionTurnRunner } from "./session-turn-runner";
import { TurnQueue } from "./turn-queue";
import {
  BRIDGE_REQUEST_TIMEOUT_GRACE_MS,
  DEFAULT_MANAGEMENT_COMMAND_TIMEOUT_MS,
  isCommandTimeoutError,
} from "../transport/command-timeouts";
import type { AppLogger } from "../logging/app-logger";

const MODEL_SET_SETTLE_BUDGET_MS =
  2 * (DEFAULT_MANAGEMENT_COMMAND_TIMEOUT_MS + BRIDGE_REQUEST_TIMEOUT_GRACE_MS);

function normalizeAdvertisedEffortCurrent(observed: {
  current?: string;
  available: string[];
}): string | undefined {
  if (observed.available.length === 0) return observed.current;
  return observed.current && observed.available.includes(observed.current)
    ? observed.current
    : undefined;
}

export interface ModelSetRequestOptions {
  /** Connector-side deadline derived from the Hub request lifetime. */
  deadlineAt?: number;
}

export interface ControlSessionInfo {
  alias: string;
  agent: string;
  /** The acpx driver backing `agent`, resolved from the agent's config at listing
   *  time. Lets the web render the brand icon without an agents-map lookup — which
   *  fails for sleeping sessions whose rows live outside the active session list.
   *  Optional: mirrors ResolvedSession.driver (custom agents always resolve one,
   *  but the type stays tolerant). */
  driver?: string;
  workspace: string;
  transportSession: string;
  running: boolean;
  archived: boolean;
  /** ISO timestamp when the session was archived. */
  archivedAt?: string;
  /** Whether the session's agent process is currently alive (next prompt responds
   *  without a cold start). Omitted when unknown — e.g. the transport can't observe
   *  liveness or the warmth tracker hasn't sampled this session yet. */
  warm?: boolean;
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
    | "listAllResolvedSessions"
    | "removeSession"
    | "useSession"
    | "resolveAliasForChat"
    | "getSession"
    | "getResolvedSessionByInternalAlias"
    | "setSessionModel"
    | "setSessionEffort"
    | "setDisplayName"
  >;
  // The active transport, for reading/switching a session's model and effort.
  // These controls are optional on the interface — absence is handled gracefully.
  transport: Pick<
    SessionTransport,
    "setModel" | "getSessionModel" | "setSessionEffort" | "getSessionEffort"
  >;
  // Full-lifecycle session creator (resolve → ensure acpx session → bind),
  // wired to CommandRouter.createSessionWithTransport in main.ts. Replaces the
  // logical-only sessions.createSession so control-created sessions are promptable.
  createSessionWithTransport: (
    internalAlias: string,
    agent: string,
    workspace: string,
    model?: string,
  ) => Promise<ResolvedSession>;
  // Full-lifecycle session teardown/archival, wired to CommandRouter in main.ts so the
  // web path shares the chat path's shared-transport guard + acpx teardown.
  removeSessionWithTransport: (
    internalAlias: string,
  ) => Promise<{ wasActive: boolean }>;
  archiveSessionWithTransport: (internalAlias: string) => Promise<void>;
  unarchiveSession: (internalAlias: string) => Promise<void>;
  // List the agent-native sessions for an agent + workspace (web native-attach picker).
  listNativeSessions: (
    agent: string,
    workspace: string,
  ) => Promise<AgentSession[]>;
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
  /** Warmth tracker view for the cold-session indicator; absent ⇒ `warm` omitted from listings. */
  sessionWarmth?: Pick<
    import("./session-warmth-tracker").SessionWarmthTracker,
    "isWarm" | "markWarm" | "markCold"
  >;
  scheduled: Pick<
    ScheduledTaskService,
    "listPending" | "listRecentForChat" | "createTask" | "cancelPending"
  >;
  orchestration: Pick<
    OrchestrationService,
    "listTasks" | "getTask" | "requestTaskCancellation"
  >;
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
    create(
      name: string,
      cwd: string,
      description?: string,
    ): Promise<ControlWorkspaceInfo>;
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
  // Test override for how long clearSession waits for an aborted turn to unwind before
  cancelDrainTimeoutMs?: number;
  // v0.3: forwarded to the TurnQueue — fires when a queued peer item carrying a
  // completion contract is removed before execution (cancel/clear/archive), so
  // the caller can resolve the source's contract with a terminal cancelled outcome.
  onQueuedPeerCancelled?: (detail: {
    chatKey: string;
    sessionAlias: string;
    peerOrigin: PeerTurnOrigin;
    promptRequestId?: string;
  }) => void;
  // v0.4: forwarded to the TurnQueue — structured peer-interrupt lifecycle
  // events (spec §17). main.ts wires this to the app logger.
  onPeerInterruptEvent?: (event: PeerInterruptEvent) => void;
  agentMessaging?: {
    deliverInbound(input: {
      sourceNodeId: string;
      sourceEndpointId: string;
      targetEndpointId: string;
      messageId: string;
      conversationId?: string;
      depth?: number;
      content: string;
      requestedMode: string;
      replyTo?: string;
      replyable: boolean;
    }): Promise<{
      messageId: string;
      status: "injected" | "queued" | "failed";
      modeUsed?: "steer" | "queue" | "interrupt" | "prompt";
      targetState?: "idle" | "running";
      errorCode?: string;
    }>;
    deliverInboundCompletion?(input: {
      requestMessageId: string;
      source: { nodeId: string; endpointId: string };
      target: { nodeId: string; endpointId: string };
      status: "completed" | "failed" | "cancelled";
      result?: string;
      error?: string;
      completedAt: number;
    }): Promise<{ ok: boolean; deduplicated?: boolean; error?: string }>;
    getPublishedEndpoints(): Promise<
      Array<{
        nodeId: string;
        endpointId: string;
        displayName?: string;
        agent: string;
        workspace?: string;
        state: "idle" | "running";
        capabilities: {
          receive: boolean;
          steer: boolean;
          queue: boolean;
          interrupt: boolean;
        };
        labels?: string[];
        updatedAt: number;
      }>
    >;
    resolveTargetByHandle?(handle: string): Promise<{
      handle: string;
      displayName?: string;
      agent: string;
      workspace?: string;
    } | null>;
    updateRemoteEndpoints?(
      nodeId: string,
      endpoints: AgentEndpointView[],
    ): void;
    syncRemoteDirectorySnapshot?(
      endpoints: Array<{
        nodeId: string;
        endpointId: string;
        displayName?: string;
        agent: string;
        workspace?: string;
        state: "idle" | "running";
        activity?: {
          status: "idle" | "working" | "waiting";
          summary?: string;
        };
        capabilities: {
          receive: boolean;
          steer: boolean;
          queue: boolean;
          interrupt: boolean;
          conversation?: boolean;
        };
        /** Remote-published presentation context, preserved verbatim. */
        endpointKind?: "logical" | "worker";
        channelId?: string;
      }>,
    ): void;
    getTraceRecords?(limit?: number): AgentMessageTraceRecord[];
  };
}

export interface ControlPromptInput {
  chatKey: string;
  sessionAlias: string;
  text: string;
  accountId?: string;
  senderId: string;
  isOwner?: boolean;
  media?: PromptAttachmentRef[];
  agentMentions?: Array<{ range: [number, number]; handle: string }>;
  /** Hub-issued pre-write correlation; threaded onto the queue item and the drained
   *  turn-started so the hub can tie a queued prompt back to its pre-written inbound
   *  row (see PromptPayload.promptRequestId). */
  promptRequestId?: string;
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
      () =>
        this.deps.workspaces.list().map((w) => ({ name: w.name, cwd: w.cwd })),
      {
        ...(deps.gitWorktreesRoot
          ? { managedWorktreesRoot: deps.gitWorktreesRoot }
          : {}),
      },
    );
    const resolveAgentTarget = deps.agentMessaging
      ? async (handle: string) => {
          if (deps.agentMessaging?.resolveTargetByHandle) {
            return await deps.agentMessaging.resolveTargetByHandle(handle);
          }
          if (deps.agentMessaging?.getPublishedEndpoints) {
            const endpoints = await deps.agentMessaging.getPublishedEndpoints();
            const match = endpoints.find(
              (e) => `agent:${e.nodeId}:${e.endpointId}` === handle,
            );
            if (match) {
              return {
                handle,
                displayName: match.displayName,
                agent: match.agent,
                workspace: match.workspace,
              };
            }
          }
          return null;
        }
      : undefined;
    this.runner = new SessionTurnRunner({
      agent: deps.agent,
      sessions: deps.sessions,
      events: deps.events,
      uploadStore: deps.uploadStore,
      ...(deps.sessionWarmth ? { sessionWarmth: deps.sessionWarmth } : {}),
      ...(deps.agentMessaging ? { agentMessaging: deps.agentMessaging } : {}),
      ...(resolveAgentTarget ? { resolveAgentTarget } : {}),
    });
    this.turnQueue = new TurnQueue({
      runTurn: (req, signal, onActivity) =>
        this.runner.run(req, signal, onActivity),
      ...(this.deps.turnIdleTimeoutMs
        ? { turnIdleTimeoutMs: this.deps.turnIdleTimeoutMs }
        : {}),
      ...(this.deps.onTurnIdleTimeout
        ? { onIdleTimeout: this.deps.onTurnIdleTimeout }
        : {}),
      ...(this.deps.cancelDrainTimeoutMs !== undefined
        ? { cancelDrainTimeoutMs: this.deps.cancelDrainTimeoutMs }
        : {}),
      ...(this.deps.onQueuedPeerCancelled
        ? { onQueuedPeerCancelled: this.deps.onQueuedPeerCancelled }
        : {}),
      ...(this.deps.onPeerInterruptEvent
        ? { onPeerInterruptEvent: this.deps.onPeerInterruptEvent }
        : {}),
      emitQueueUpdated: (chatKey, sessionAlias, items) =>
        this.deps.events.emit({
          type: "queue-updated",
          chatKey,
          sessionAlias,
          items,
        }),
      detectSessionsChanged: async (detection) => {
        try {
          const after = await this.deps.sessions.getSession(
            detection.internalAlias,
          );
          if (
            after &&
            after.transportSession !== detection.priorTransportSession
          ) {
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

  // Directory-only picker over the WHOLE instance host (not workspace-scoped) —
  // used by the relay-web "choose directory" dialog to pick a cwd for a new
  // workspace. Directory names only; capped at 1000; no file contents/metadata.
  browseDirectories(path?: string): Promise<BrowseDirsResult> {
    return browseDirs(path);
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

  private async withWorktreeRegistration<T>(
    workspaceName: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.worktreeRegistrationTails.get(workspaceName) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
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
    return this.mutateWorkspaceGit(() =>
      this.workspaceGit.stage(workspace, paths),
    );
  }

  gitUnstage(workspace: string, paths: string[]): Promise<void> {
    return this.mutateWorkspaceGit(() =>
      this.workspaceGit.unstage(workspace, paths),
    );
  }

  gitUntrack(workspace: string, paths: string[]): Promise<void> {
    return this.mutateWorkspaceGit(() =>
      this.workspaceGit.untrack(workspace, paths),
    );
  }

  gitDiscard(workspace: string, paths: string[]): Promise<void> {
    return this.mutateWorkspaceGit(() =>
      this.workspaceGit.discard(workspace, paths),
    );
  }

  gitCommit(workspace: string, message: string): Promise<GitCommitResult> {
    return this.mutateWorkspaceGit(() =>
      this.workspaceGit.commit(workspace, message),
    );
  }

  gitFetch(workspace: string, remote?: string): Promise<void> {
    return this.mutateWorkspaceGit(() =>
      this.workspaceGit.fetch(workspace, remote),
    );
  }

  gitPull(workspace: string): Promise<void> {
    return this.mutateWorkspaceGit(() => this.workspaceGit.pull(workspace));
  }

  gitPush(workspace: string, options?: GitPushOptions): Promise<void> {
    return this.mutateWorkspaceGit(() =>
      this.workspaceGit.push(workspace, options),
    );
  }

  gitCheckout(workspace: string, options: GitCheckoutOptions): Promise<void> {
    return this.mutateWorkspaceGit(() =>
      this.workspaceGit.checkout(workspace, options),
    );
  }

  async gitCreateWorktree(
    workspace: string,
    input: GitWorktreeCreateOptions & { workspaceName: string },
  ): Promise<{
    worktree: GitWorktreeCreateResult;
    workspace: ControlWorkspaceInfo;
  }> {
    const workspaceName = input.workspaceName.trim();
    if (!workspaceName) throw new Error("workspace-name-required");
    return this.mutateWorkspaceGit(() =>
      this.withWorktreeRegistration(workspaceName, async () => {
        if (
          this.deps.workspaces
            .list()
            .some((item) => item.name === workspaceName)
        ) {
          throw new Error("workspace-name-exists");
        }
        const worktree = await this.workspaceGit.createWorktree(
          workspace,
          input,
        );
        try {
          const registered = await this.deps.workspaces.create(
            workspaceName,
            worktree.path,
            `Git worktree for ${worktree.branch}`,
          );
          return { worktree, workspace: registered };
        } catch (registrationError) {
          try {
            await this.workspaceGit.removeManagedWorktree(
              workspace,
              worktree.path,
            );
          } catch (rollbackError) {
            throw new AggregateError(
              [registrationError, rollbackError],
              "workspace-registration-rollback-failed",
            );
          }
          throw registrationError;
        }
      }),
    );
  }

  searchWorkspace(
    workspace: string,
    opts: SearchOptions,
  ): Promise<SearchResult> {
    return this.workspaceFs.search(workspace, opts);
  }

  async fsCreate(
    workspace: string,
    path: string,
    kind: "file" | "dir",
  ): Promise<{ path: string }> {
    if (!this.deps.filesWriteEnabled()) throw new Error("files-write-disabled");
    return kind === "dir"
      ? this.workspaceFs.createDir(workspace, path)
      : this.workspaceFs.createFile(workspace, path);
  }

  async fsRename(
    workspace: string,
    path: string,
    newName: string,
  ): Promise<{ path: string }> {
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

  async fsDownload(
    workspace: string,
    path: string,
  ): Promise<{ path: string; base64: string; size: number; mimeType: string }> {
    return this.workspaceFs.readFileBytes(workspace, path); // read op — intentionally NOT gated
  }

  async uploadFile(input: {
    filename: string;
    content: string;
    mimeType: string;
  }): Promise<{
    id: string;
    path: string;
    filename: string;
    mimeType: string;
    size: number;
  }> {
    return this.deps.uploadStore.save(
      input.filename,
      input.content,
      input.mimeType,
    );
  }

  /** Read a session's current model and the agent-advertised available ids. */
  async getSessionModel(
    chatKey: string,
    alias: string,
  ): Promise<{ current?: string; available: string[] }> {
    const session = await this.resolveControlSession(chatKey, alias);
    if (!session) return { available: [] };
    if (!this.deps.transport.getSessionModel)
      return { current: session.model, available: [] };
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
    if (!setModel)
      throw new Error("the active transport does not support switching models");
    return await this.runSessionConfigSetExclusive(session.alias, async () => {
      if (
        typeof options.deadlineAt === "number" &&
        Number.isFinite(options.deadlineAt) &&
        (this.deps.now?.() ?? Date.now()) + MODEL_SET_SETTLE_BUDGET_MS >
          options.deadlineAt
      ) {
        throw new Error(
          "model switch deadline is too close to safely start the queued operation",
        );
      }
      try {
        await setModel(session, modelId);
      } catch (error) {
        // A process timeout is ambiguous: acpx may have applied the model before it
        // stopped responding. Read back the authoritative transport state so the
        // persisted logical session and relay-web's optimistic chip cannot diverge.
        if (
          !isCommandTimeoutError(error) ||
          !this.deps.transport.getSessionModel
        )
          throw error;
        let observed: { current?: string; available: string[] };
        try {
          observed = await this.deps.transport.getSessionModel(session);
        } catch {
          // Preserve the original timeout; reconciliation is best-effort diagnostics.
          throw error;
        }
        await this.deps.sessions.setSessionModel(
          session.alias,
          observed.current,
        );
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
        return {
          current: observed.current,
          applied: observed.current === modelId,
        };
      }
      await this.deps.sessions.setSessionModel(session.alias, modelId);
      return { current: modelId, applied: true };
    });
  }

  /** Read the reasoning-effort values advertised by the session's adapter. */
  async getSessionEffort(
    chatKey: string,
    alias: string,
  ): Promise<{ current?: string; available: string[] }> {
    const initialSession = await this.resolveControlSession(chatKey, alias);
    const getEffort = this.deps.transport.getSessionEffort?.bind(
      this.deps.transport,
    );
    if (!initialSession || !getEffort) return { available: [] };
    return await this.runSessionConfigSetExclusive(
      initialSession.alias,
      async () => {
        const session = await this.resolveControlSession(chatKey, alias);
        if (!session) return { available: [] };
        const observed = await getEffort(session);
        const observedCurrent = normalizeAdvertisedEffortCurrent(observed);
        let current =
          session.effort && observed.available.includes(session.effort)
            ? session.effort
            : observedCurrent;
        if (
          session.effort &&
          observed.available.length > 0 &&
          !observed.available.includes(session.effort)
        ) {
          await this.deps.sessions.setSessionEffort(
            session.alias,
            observedCurrent,
          );
          current = observedCurrent;
        }
        return {
          current,
          available: observed.available,
        };
      },
    );
  }

  /** Set the adapter-advertised reasoning effort for a session. */
  async setSessionEffort(
    chatKey: string,
    alias: string,
    effort: string,
  ): Promise<{ current?: string; applied: boolean }> {
    const session = await this.resolveControlSession(chatKey, alias);
    if (!session) throw new Error("session not found");
    const setEffort = this.deps.transport.setSessionEffort?.bind(
      this.deps.transport,
    );
    if (!setEffort)
      throw new Error(
        "the active transport does not support setting reasoning effort",
      );
    return await this.runSessionConfigSetExclusive(session.alias, async () => {
      try {
        await setEffort(session, effort);
      } catch (error) {
        const getEffort = this.deps.transport.getSessionEffort?.bind(
          this.deps.transport,
        );
        if (!isCommandTimeoutError(error) || !getEffort) throw error;
        let observed: { current?: string; available: string[] };
        try {
          observed = await getEffort(session);
        } catch {
          // Preserve the original timeout when authoritative reconciliation fails.
          throw error;
        }
        const observedCurrent = normalizeAdvertisedEffortCurrent(observed);
        await this.deps.sessions.setSessionEffort(
          session.alias,
          observedCurrent,
        );
        try {
          await this.deps.logger?.error(
            "control.session.effort.timeout_reconciled",
            "Effort switch timed out; adopted authoritative transport state",
            {
              sessionAlias: session.alias,
              requestedEffort: effort,
              observedEffort: observedCurrent ?? null,
              timeout: error instanceof Error ? error.message : String(error),
            },
          );
        } catch {
          // Logging is diagnostic only; reconciliation already succeeded.
        }
        return {
          current: observedCurrent,
          applied: observedCurrent === effort,
        };
      }
      await this.deps.sessions.setSessionEffort(session.alias, effort);
      return { current: effort, applied: true };
    });
  }

  /** Serialize adapter configuration mutations per logical session so stale operations cannot win last. */
  private async runSessionConfigSetExclusive<T>(
    sessionAlias: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.sessionConfigSetTails.get(sessionAlias) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
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
  async setSessionDisplayName(
    chatKey: string,
    alias: string,
    displayName: string,
  ): Promise<void> {
    const session = await this.resolveControlSession(chatKey, alias);
    if (!session) throw new Error("session not found");
    await this.deps.sessions.setDisplayName(session.alias, displayName);
    this.deps.events.emit({ type: "sessions-changed" });
  }

  /** Resolve a chat-scoped display alias to its ResolvedSession, or null. */
  private async resolveControlSession(
    chatKey: string,
    alias: string,
  ): Promise<ResolvedSession | null> {
    const internalAlias = await this.deps.sessions.resolveAliasForChat(
      chatKey,
      alias,
    );
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
      .filter((session) =>
        isSessionAliasVisibleInChannel(session.alias, channelId),
      )
      .map((session) => {
        const running = this.deps.activeTurns.isActiveAnywhere(session.alias);
        const warm = running ? true : this.deps.sessionWarmth?.isWarm(session);
        return {
          alias: toDisplaySessionAlias(session.alias),
          agent: session.agent,
          driver: session.driver,
          workspace: session.workspace,
          transportSession: session.transportSession,
          running,
          archived: session.archived === true,
          ...(session.archivedAt ? { archivedAt: session.archivedAt } : {}),
          ...(warm !== undefined ? { warm } : {}),
          ...(session.source === "agent-side" ? { native: true } : {}),
          ...(session.agentCommand
            ? { agentCommand: session.agentCommand }
            : {}),
          ...(session.displayName ? { displayName: session.displayName } : {}),
        };
      });
  }

  listSessionsPage(
    chatKey: string,
    offset = 0,
    limit = 20,
    includeArchived = false,
    filters?: { archivedOnly?: boolean; workspace?: string; agent?: string },
  ): { sessions: ControlSessionInfo[]; hasMore: boolean; nextOffset: number } {
    const archivedVisible = (session: ControlSessionInfo): boolean => {
      if (filters?.archivedOnly) return session.archived;
      return includeArchived || !session.archived;
    };
    // Filters use !== undefined (not truthiness) so "" matches sessions lacking the field.
    const all = this.listSessions(chatKey).filter((session) => {
      if (!archivedVisible(session)) return false;
      if (
        filters?.workspace !== undefined &&
        (session.workspace ?? "") !== filters.workspace
      )
        return false;
      if (
        filters?.agent !== undefined &&
        (session.agent ?? "") !== filters.agent
      )
        return false;
      return true;
    });
    if (filters?.archivedOnly) {
      all.sort((a, b) => {
        const aTime = a.archivedAt ? new Date(a.archivedAt).getTime() : 0;
        const bTime = b.archivedAt ? new Date(b.archivedAt).getTime() : 0;
        if (aTime !== bTime) {
          return bTime - aTime;
        }
        return 0;
      });
    }
    const safeOffset = Math.max(0, Math.floor(offset));
    const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    const sessions = all.slice(safeOffset, safeOffset + safeLimit);
    const nextOffset = safeOffset + sessions.length;
    return { sessions, hasMore: nextOffset < all.length, nextOffset };
  }

  /**
   * List the agent-native (acpx-owned) sessions for an agent + workspace, so the web
   * add-session dialog can offer "attach an existing native session". These are the
   * agent's own rollouts on disk (per-cwd), not chat-scoped — chatKey is accepted only
   * for call-shape symmetry with the other session control methods.
   */
  async listNativeSessions(
    _chatKey: string,
    agent: string,
    workspace: string,
  ): Promise<ControlNativeSessionInfo[]> {
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
    const internalAlias = await this.deps.sessions.resolveAliasForChat(
      chatKey,
      alias,
    );
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
      ? await this.deps.attachNativeSessionWithTransport(
          internalAlias,
          agent,
          workspace,
          agentSessionId,
        )
      : await this.deps.createSessionWithTransport(
          internalAlias,
          agent,
          workspace,
          model,
        );
    this.deps.events.emit({ type: "sessions-changed" });
    if (nativeHistory.length > 0) {
      // The emitted alias must match the ACTUALLY-created session (which may have
      // a `-2`/`-3` suffix derived from the original request when the desired alias
      // collided with an archived session). Using the user-supplied `alias` here
      // would drop the native history seed on a session that was never created.
      const historyAlias = toDisplaySessionAlias(session.alias);
      this.deps.events.emit({
        type: "session-history",
        chatKey,
        sessionAlias: historyAlias,
        messages: nativeHistory,
      });
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

  async removeSession(
    chatKey: string,
    alias: string,
  ): Promise<{ wasActive: boolean }> {
    const internalAlias = await this.deps.sessions.resolveAliasForChat(
      chatKey,
      alias,
    );
    // Drop queued prompts and abort a running turn BEFORE tearing down the transport:
    // a drained turn starting mid-removal (or turn events landing after it) would write
    // history rows for a session that no longer exists. NOTE clearSession is destructive
    // even when it reports `cleared: false` — it has already aborted the turn and dropped
    // the queue — so this is a retry-able failure, not a no-op.
    const { cleared } = await this.turnQueue.clearSession(
      chatKey,
      alias,
      internalAlias,
    );
    if (!cleared) {
      throw new Error(
        `session "${alias}" is still finishing a stopped turn; retry in a moment`,
      );
    }
    // clearSession armed a teardown guard (busy gate rejects new turns); release it once
    // transport removal settles, success or failure, so the key never wedges as busy.
    try {
      const result = await this.deps.removeSessionWithTransport(internalAlias);
      this.deps.events.emit({ type: "sessions-changed" });
      return result;
    } finally {
      this.turnQueue.finishClear(chatKey, alias, internalAlias);
    }
  }

  async archiveSession(chatKey: string, alias: string): Promise<void> {
    const internalAlias = await this.deps.sessions.resolveAliasForChat(
      chatKey,
      alias,
    );
    // Queued prompts must not drain onto the session the user just archived — a drained
    // turn would cold-start a fresh queue owner and effectively undo the archive.
    // clearSession is destructive even on `cleared: false` (turn aborted, queue dropped),
    const { cleared } = await this.turnQueue.clearSession(
      chatKey,
      alias,
      internalAlias,
    );
    if (!cleared) {
      throw new Error(
        `session "${alias}" is still finishing a stopped turn; retry in a moment`,
      );
    }
    try {
      const priorSession = await this.deps.sessions.getSession(internalAlias).catch(() => null);
      await this.deps.archiveSessionWithTransport(internalAlias);
      if (priorSession && this.deps.sessionWarmth) {
        this.deps.sessionWarmth.markCold(priorSession);
      }
      this.deps.events.emit({ type: "sessions-changed" });
    } finally {
      this.turnQueue.finishClear(chatKey, alias, internalAlias);
    }
  }

  async unarchiveSession(chatKey: string, alias: string): Promise<void> {
    const internalAlias = await this.deps.sessions.resolveAliasForChat(
      chatKey,
      alias,
    );
    await this.deps.unarchiveSession(internalAlias);
    this.deps.events.emit({ type: "sessions-changed" });
  }

  listAgents(): ControlAgentInfo[] {
    return this.deps.agents.list();
  }

  listWorkspaces(): ControlWorkspaceInfo[] {
    return this.deps.workspaces.list();
  }

  createWorkspace(
    name: string,
    cwd: string,
    description?: string,
  ): Promise<ControlWorkspaceInfo> {
    return this.deps.workspaces.create(name, cwd, description);
  }

  listAgentCatalog(): AgentCatalogEntry[] {
    return this.deps.agents.catalog();
  }

  createAgent(name: string, driver: string): Promise<ControlAgentInfo> {
    return this.deps.agents.create(name, driver);
  }

  async removeAgent(name: string): Promise<void> {
    if (
      this.deps.sessions.listAllResolvedSessions().some((s) => s.agent === name)
    ) {
      throw new Error(`agent "${name}" is in use by an existing session`);
    }
    await this.deps.agents.remove(name);
  }

  async removeWorkspace(name: string): Promise<void> {
    if (
      this.deps.sessions
        .listAllResolvedSessions()
        .some((s) => s.workspace === name)
    ) {
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

  async createScheduledTask(
    input: CreateScheduledTaskInput,
  ): Promise<ScheduledTaskRecord> {
    const task = await this.deps.scheduled.createTask(input);
    this.deps.events.emit({
      type: "scheduled-changed",
      chatKey: input.chatKey,
    });
    return task;
  }

  async cancelScheduledTask(id: string, chatKey: string): Promise<boolean> {
    const cancelled = await this.deps.scheduled.cancelPending(id, chatKey);
    if (cancelled) {
      this.deps.events.emit({ type: "scheduled-changed", chatKey });
    }
    return cancelled;
  }

  listOrchestrationTasks(
    filter?: OrchestrationTaskFilter,
  ): Promise<OrchestrationTaskRecord[]> {
    return this.deps.orchestration.listTasks(filter);
  }

  getOrchestrationTask(
    taskId: string,
  ): Promise<OrchestrationTaskRecord | null> {
    return this.deps.orchestration.getTask(taskId);
  }

  async cancelOrchestrationTask(
    input: CancelTaskInput,
  ): Promise<OrchestrationTaskRecord> {
    const task = await this.deps.orchestration.requestTaskCancellation(input);
    this.deps.events.emit({ type: "orchestration-changed" });
    return task;
  }

  async prompt(input: ControlPromptInput): Promise<ControlPromptResult> {
    const channelId = getChannelIdFromChatKey(input.chatKey);
    const internalAlias =
      this.deps.sessions.getResolvedSessionByInternalAlias?.(input.sessionAlias)?.alias ??
      this.deps.sessions.getResolvedSessionByInternalAlias?.(
        toInternalSessionAlias(channelId, input.sessionAlias),
      )?.alias ??
      scopeDisplayAliasToInternal(channelId, input.sessionAlias);

    const configTail =
      this.sessionConfigSetTails.get(internalAlias) ??
      this.sessionConfigSetTails.get(input.sessionAlias);
    if (configTail) {
      await configTail.catch(() => {});
    }

    return this.turnQueue.submit({
      chatKey: input.chatKey,
      sessionAlias: input.sessionAlias,
      concurrencyKey: internalAlias,
      text: input.text,
      senderId: input.senderId,
      queueable: true,
      ...(input.isOwner !== undefined ? { isOwner: input.isOwner } : {}),
      ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
      ...(input.media !== undefined ? { media: input.media } : {}),
      ...(input.agentMentions !== undefined
        ? { agentMentions: input.agentMentions }
        : {}),
      ...(input.promptRequestId !== undefined
        ? { promptRequestId: input.promptRequestId }
        : {}),
    });
  }

  /** Run a fired scheduled task as a real turn through the same machinery as a manual
   *  prompt — so it streams live and persists to history — while tagging turn-started
   *  with the prompt text + schedule origin so the hub records the inbound message and
   *  the web can badge it. Owner-authorized: the task was owner-gated at creation. */
  async runScheduledTurn(
    input: ControlScheduledTurnInput,
  ): Promise<ControlPromptResult> {
    const channelId = getChannelIdFromChatKey(input.chatKey);
    const internalAlias =
      this.deps.sessions.getResolvedSessionByInternalAlias?.(input.sessionAlias)?.alias ??
      this.deps.sessions.getResolvedSessionByInternalAlias?.(
        toInternalSessionAlias(channelId, input.sessionAlias),
      )?.alias ??
      scopeDisplayAliasToInternal(channelId, input.sessionAlias);
    return this.turnQueue.submit({
      chatKey: input.chatKey,
      sessionAlias: input.sessionAlias,
      concurrencyKey: internalAlias,
      text: input.promptText,
      senderId: "scheduler",
      isOwner: true,
      ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      turnStarted: {
        prompt: input.promptText,
        scheduled: { taskId: input.taskId, executeAt: input.executeAt },
      },
    });
  }

  queueLength(chatKey: string, sessionAlias: string): number {
    const channelId = getChannelIdFromChatKey(chatKey);
    const internalAlias =
      this.deps.sessions.getResolvedSessionByInternalAlias?.(sessionAlias)?.alias ??
      this.deps.sessions.getResolvedSessionByInternalAlias?.(
        toInternalSessionAlias(channelId, sessionAlias),
      )?.alias ??
      scopeDisplayAliasToInternal(channelId, sessionAlias);
    return this.turnQueue.queueLength(chatKey, sessionAlias, internalAlias);
  }
  isBusy(chatKey: string, sessionAlias: string): boolean {
    const channelId = getChannelIdFromChatKey(chatKey);
    const internalAlias =
      this.deps.sessions.getResolvedSessionByInternalAlias?.(sessionAlias)?.alias ??
      this.deps.sessions.getResolvedSessionByInternalAlias?.(
        toInternalSessionAlias(channelId, sessionAlias),
      )?.alias ??
      scopeDisplayAliasToInternal(channelId, sessionAlias);
    return this.turnQueue.isBusy(chatKey, sessionAlias, internalAlias);
  }

  isSessionBusy(internalAlias: string): boolean {
    return this.turnQueue.isBusy("", internalAlias, internalAlias);
  }
  cancelTurn(chatKey: string, sessionAlias: string): boolean {
    const channelId = getChannelIdFromChatKey(chatKey);
    const internalAlias =
      this.deps.sessions.getResolvedSessionByInternalAlias?.(sessionAlias)?.alias ??
      this.deps.sessions.getResolvedSessionByInternalAlias?.(
        toInternalSessionAlias(channelId, sessionAlias),
      )?.alias ??
      scopeDisplayAliasToInternal(channelId, sessionAlias);
    return this.turnQueue.cancelTurn(chatKey, sessionAlias, internalAlias);
  }

  async submitPeerTurn(input: {
    chatKey: string;
    sessionAlias: string;
    boundSessionAlias?: string;
    text: string;
    senderId: string;
    messageId: string;
    /** v0.4: "interrupt" routes through TurnQueue.submitPeerInterrupt (reserve →
     *  abort → true-settle → priority drain); every other mode keeps the
     *  non-cancelling peer path. */
    requestedMode?: AgentMessageMode;
    peerOrigin?: PeerTurnOrigin;
  }): Promise<{
    status: "injected" | "queued";
    modeUsed: "prompt" | "queue" | "interrupt";
    targetState?: "idle" | "running";
  }> {
    const channelId = getChannelIdFromChatKey(input.chatKey);
    const internalAlias =
      input.boundSessionAlias ??
      this.deps.sessions.getResolvedSessionByInternalAlias?.(input.sessionAlias)?.alias ??
      this.deps.sessions.getResolvedSessionByInternalAlias?.(
        toInternalSessionAlias(channelId, input.sessionAlias),
      )?.alias ??
      scopeDisplayAliasToInternal(channelId, input.sessionAlias);
    const session = await this.deps.sessions.getSession(internalAlias);
    if (!session || session.archived === true) {
      throw new AgentMessagingError(
        "TARGET_UNAVAILABLE",
        "The target Agent session is not currently available or is archived.",
      );
    }
    const peerParams = {
      chatKey: input.chatKey,
      sessionAlias: input.sessionAlias,
      boundSessionAlias: internalAlias,
      concurrencyKey: internalAlias,
      text: input.text,
      senderId: input.senderId,
      promptRequestId: input.messageId,
      isPeerMessage: true,
      allowRestoreArchived: false,
      preserveCoordinatorRoute: true,
      peerOrigin: input.peerOrigin,
    };
    if (input.requestedMode === "interrupt") {
      const admission = this.turnQueue.submitPeerInterrupt(peerParams);
      if (admission.status === "rejected") {
        this.throwPeerAdmissionError(admission.reason, "interrupt");
      }
      // Receipt mapping (spec §6.4): idle target → injected/prompt/idle with
      // zero cancellations; busy target → queued/interrupt/running (the
      // reservation is held and the predecessor cancel already signalled).
      return admission.status === "injected"
        ? { status: "injected", modeUsed: "prompt", targetState: "idle" }
        : { status: "queued", modeUsed: "interrupt", targetState: "running" };
    }
    const admission = this.turnQueue.submitPeerTurn(peerParams);
    if (admission.status === "rejected") {
      this.throwPeerAdmissionError(admission.reason, "peer");
    }
    return { status: admission.status, modeUsed: "queue" };
  }

  // Map TurnQueue admission rejections onto the existing typed wire errors.
  // In interrupt mode "queue-full" can only mean the one-pending-interrupt
  // slot rule (TurnQueue.submitPeerInterrupt never consults QUEUE_MAX_DEPTH),
  // so the detail names the real cause (spec §16).
  private throwPeerAdmissionError(reason: string, mode: "peer" | "interrupt"): never {
    if (reason === "queue-full") {
      throw new AgentMessagingError(
        "MESSAGE_QUEUE_FULL",
        mode === "interrupt"
          ? "The target Agent already has a pending peer interrupt; only one interrupt may be reserved at a time."
          : "The target Agent's message queue is full.",
      );
    }
    if (reason === "target-unavailable") {
      throw new AgentMessagingError(
        "TARGET_UNAVAILABLE",
        "The target Agent session is currently being removed or archived.",
      );
    }
    throw new AgentMessagingError(
      "DELIVERY_FAILED",
      `Peer turn admission rejected: ${reason}`,
    );
  }

  async submitCompletionTurn(input: {
    sourceAlias: string;
    completion: AgentMessageCompletion;
    requestMessageId: string;
  }): Promise<{ status: "injected" | "queued" } | { status: "rejected"; reason: string }> {
    const session = await this.deps.sessions.getSession(input.sourceAlias);
    if (!session || session.archived === true) {
      return { status: "rejected", reason: "target-unavailable" };
    }
    const internalAlias = session.alias;
    const admission = this.turnQueue.submitPeerTurn({
      chatKey: `relay:agent-message:${input.sourceAlias}`,
      sessionAlias: input.sourceAlias,
      boundSessionAlias: internalAlias,
      concurrencyKey: internalAlias,
      // The trusted completion envelope is NOT carried as prompt text — the
      // runner disarms all user text before composing its prompt, so a
      // pre-rendered trusted XML wrapper would be escaped into inert text.
      // Instead the structured completion rides the queue and the
      // SessionTurnRunner builds the server-owned envelope itself.
      text: "",
      senderId: "agent-messaging",
      promptRequestId: input.requestMessageId,
      isPeerMessage: true,
      allowRestoreArchived: false,
      preserveCoordinatorRoute: true,
      trustedPeerCompletion: input.completion,
    });
    return admission;
  }

  /** Remove a pending queued prompt (by id) before it drains. No-ops (returns
   *  `{ cancelled: false }`) when the queue or the id is absent/already drained —
   *  e.g. a race where the item drained into a running turn just before the cancel
   *  arrived. Does NOT touch a turn that is already running (use `cancelTurn`). */
  cancelQueuedItem(
    chatKey: string,
    sessionAlias: string,
    itemId: string,
  ): { cancelled: boolean } {
    const channelId = getChannelIdFromChatKey(chatKey);
    const internalAlias = scopeDisplayAliasToInternal(channelId, sessionAlias);
    return this.turnQueue.cancelQueuedItem(chatKey, sessionAlias, itemId, internalAlias);
  }

  async clearSession(
    chatKey: string,
    sessionAlias: string,
  ): Promise<{ cleared: boolean }> {
    const channelId = getChannelIdFromChatKey(chatKey);
    const internalAlias = scopeDisplayAliasToInternal(channelId, sessionAlias);
    return this.turnQueue.clearSession(chatKey, sessionAlias, internalAlias);
  }

  finishClear(chatKey: string, sessionAlias: string): void {
    const channelId = getChannelIdFromChatKey(chatKey);
    const internalAlias = scopeDisplayAliasToInternal(channelId, sessionAlias);
    this.turnQueue.finishClear(chatKey, sessionAlias, internalAlias);
  }

  async executeCommand(input: {
    chatKey: string;
    text: string;
    senderId: string;
    isOwner?: boolean;
    accountId?: string;
  }): Promise<string> {
    const chunks: string[] = [];
    const response = await this.deps.agent.chat({
      accountId: input.accountId ?? "control",
      conversationId: input.chatKey,
      text: input.text,
      metadata: buildControlMetadata(input.senderId, input.isOwner ?? true),
      reply: async (chunk) => {
        chunks.push(chunk);
      },
    });
    if (response.text) {
      chunks.push(response.text);
    }
    return chunks.join("\n");
  }
  async createTerminal(
    chatKey: string,
    sessionAlias: string,
    cols: number,
    rows: number,
  ): Promise<{ terminalId: string }> {
    if (!this.deps.terminalEnabled()) throw new Error("terminal-disabled");
    const session = await this.resolveControlSession(chatKey, sessionAlias);
    if (!session) throw new Error("session-not-found");
    return this.deps.terminal.create({ cwd: session.cwd, cols, rows });
  }

  attachTerminal(
    terminalId: string,
  ): import("./terminal-service").TerminalAttachResult {
    if (!this.deps.terminalEnabled()) throw new Error("terminal-disabled");
    return this.deps.terminal.attach(terminalId);
  }

  async deliverAgentMessage(input: {
    sourceNodeId: string;
    sourceEndpointId: string;
    targetEndpointId: string;
    messageId: string;
    content: string;
    requestedMode: string;
    replyTo?: string;
    replyable: boolean;
  }): Promise<{
    messageId: string;
    status: "injected" | "queued" | "failed";
    modeUsed?: "steer" | "queue" | "interrupt" | "prompt";
    targetState?: "idle" | "running";
    errorCode?: string;
  }> {
    if (!this.deps.agentMessaging) {
      throw new Error("Agent messaging is not configured on this daemon");
    }
    return await this.deps.agentMessaging.deliverInbound(input);
  }

  async deliverPeerCompletion(input: {
    requestMessageId: string;
    source: { nodeId: string; endpointId: string };
    target: { nodeId: string; endpointId: string };
    status: "completed" | "failed" | "cancelled";
    result?: string;
    error?: string;
    completedAt: number;
  }): Promise<{ ok: boolean; deduplicated?: boolean; error?: string }> {
    if (!this.deps.agentMessaging?.deliverInboundCompletion) {
      throw new Error("Agent messaging is not configured on this daemon");
    }
    return await this.deps.agentMessaging.deliverInboundCompletion(input);
  }

  async getPublishedAgentEndpoints(): Promise<
    Array<{
      nodeId: string;
      endpointId: string;
      displayName?: string;
      agent: string;
      state: "idle" | "running";
      capabilities: {
        receive: boolean;
        steer: boolean;
        queue: boolean;
        interrupt: boolean;
      };
      labels?: string[];
      updatedAt: number;
    }>
  > {
    if (!this.deps.agentMessaging) return [];
    return await this.deps.agentMessaging.getPublishedEndpoints();
  }

  updateRemoteAgentEndpoints(
    nodeId: string,
    endpoints: AgentEndpointView[],
  ): void {
    this.deps.agentMessaging?.updateRemoteEndpoints?.(nodeId, endpoints);
  }
  syncRemoteAgentDirectory(
    endpoints: Array<{
      nodeId: string;
      endpointId: string;
      displayName?: string;
      agent: string;
      workspace?: string;
      state: "idle" | "running";
      activity?: {
        status: "idle" | "working" | "waiting";
        summary?: string;
      };
      capabilities: {
        receive: boolean;
        steer: boolean;
        queue: boolean;
        interrupt: boolean;
        conversation?: boolean;
      };
      /** Remote-published presentation context, preserved verbatim. */
      endpointKind?: "logical" | "worker";
      channelId?: string;
    }>,
  ): void {
    this.deps.agentMessaging?.syncRemoteDirectorySnapshot?.(endpoints);
  }
  getAgentMessageTrace(limit?: number): AgentMessageTraceRecord[] {
    return this.deps.agentMessaging?.getTraceRecords?.(limit) ?? [];
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
