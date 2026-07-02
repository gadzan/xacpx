import path from "node:path";
import { randomUUID } from "node:crypto";

import type { Agent as ChatAgent, ChatRequestMetadata } from "../weixin/agent/interface";
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
import type { ControlEventBus, ScheduledOrigin } from "./control-event-bus";
import { readNativeSessionHistory, type NativeHistoryMessage } from "../transport/native-session-history";
import type { AgentCatalogEntry } from "../config/agent-catalog";
import { WorkspaceFs, type DirListing, type FileContent, type SearchOptions, type SearchResult, type WorkspaceDiff } from "./workspace-fs";
import type { PromptAttachmentRef } from "@ganglion/xacpx-relay-protocol";
import type { UploadStore } from "./upload-store.js";

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
  agent: Pick<ChatAgent, "chat">;
  sessions: Pick<
    SessionService,
    "listAllResolvedSessions" | "removeSession" | "useSession" | "resolveAliasForChat" | "getSession" | "setSessionModel" | "setDisplayName"
  >;
  // The active transport, for reading/switching a session's model. setModel/
  // getSessionModel are optional on the interface — absence is handled gracefully.
  transport: Pick<SessionTransport, "setModel" | "getSessionModel">;
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

/** A prompt held in the per-session server-side queue while a turn is in flight.
 *  Runs through the same `executeTurn` machinery as a manual prompt once drained. */
export interface QueuedPrompt {
  id: string;
  text: string;
  enqueuedAt: string;
  senderId: string;
  isOwner?: boolean;
  accountId?: string;
  media?: PromptAttachmentRef[];
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
  constructor(private readonly deps: ControlServiceDeps) {}

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
  async setSessionModel(chatKey: string, alias: string, modelId: string): Promise<void> {
    const session = await this.resolveControlSession(chatKey, alias);
    if (!session) throw new Error("session not found");
    if (!this.deps.transport.setModel) throw new Error("the active transport does not support switching models");
    await this.deps.transport.setModel(session, modelId);
    await this.deps.sessions.setSessionModel(session.alias, modelId);
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

  // Each in-flight turn carries its AbortController plus a `settled` promise that
  // resolves once the turn has fully unwound (transport cancelled, inFlight cleared).
  private readonly inFlight = new Map<string, { controller: AbortController; settled: Promise<void> }>();

  // Per-session FIFO queue of prompts that arrived while a turn was already running.
  // Only interactive prompt() enqueues (see `queueable` on executeTurn); scheduled
  // turns keep rejecting immediately. Drained by Task 2's turn-finish hand-off.
  private readonly queues = new Map<string, QueuedPrompt[]>();

  // Set synchronously during a turn-finish drain hand-off: the finished turn has cleared
  // its inFlight entry but the drained head has not yet re-registered its own. The enqueue
  // gate treats `draining.has(key)` as busy so nothing starts a parallel turn in that
  // window. The drained turn clears it right after it re-registers inFlight.
  private readonly draining = new Set<string>();

  private emitQueueUpdated(chatKey: string, sessionAlias: string): void {
    const items = (this.queues.get(turnKey(chatKey, sessionAlias)) ?? []).map((q) => ({
      id: q.id,
      textPreview: q.text.length > QUEUE_PREVIEW_MAX ? q.text.slice(0, QUEUE_PREVIEW_MAX) : q.text,
      enqueuedAt: q.enqueuedAt,
    }));
    this.deps.events.emit({ type: "queue-updated", chatKey, sessionAlias, items });
  }

  async prompt(input: ControlPromptInput): Promise<ControlPromptResult> {
    return this.executeTurn({
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
    return this.executeTurn({
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

  private async executeTurn(params: {
    chatKey: string;
    sessionAlias: string;
    text: string;
    senderId: string;
    isOwner?: boolean;
    accountId?: string;
    // External abort (e.g. the scheduler's per-dispatch timeout) linked to this turn.
    abortSignal?: AbortSignal;
    // Extra fields stamped onto turn-started for scheduled-origin turns. `queueItemId`
    // is set only for a drained queue head (Task 2) so the web can reconcile the badge.
    turnStarted?: { prompt?: string; scheduled?: ScheduledOrigin; queueItemId?: string };
    media?: PromptAttachmentRef[];
    // Only interactive prompt() sets this. When true and a turn is already running,
    // the prompt is appended to the per-session queue instead of being rejected.
    // runScheduledTurn omits it, so scheduled turns keep the immediate-or-reject
    // behavior.
    queueable?: boolean;
    // Set only by the turn-finish drain hand-off. A drained head turn bypasses the busy
    // gate (it is what the finished turn intentionally started next), re-registers its own
    // inFlight, and clears the `draining` guard — all synchronously at its top.
    drained?: boolean;
  }): Promise<ControlPromptResult> {
    const key = turnKey(params.chatKey, params.sessionAlias);
    // A drained head turn (params.drained) is the turn the just-finished turn intentionally
    // started next; it must bypass this gate (it re-registers its own inFlight and clears
    // the `draining` guard synchronously at its top). Every other caller treats a live turn
    // OR an in-progress drain hand-off as busy.
    if (!params.drained) {
      const existing = this.inFlight.get(key);
      // Busy when a live un-cancelled turn holds the slot, OR a drain hand-off is mid-flight
      // (inFlight momentarily cleared but the drained head not yet re-registered).
      const busy =
        this.draining.has(key) || (existing !== undefined && !existing.controller.signal.aborted);
      if (busy) {
        if (params.queueable) {
          const id = randomUUID();
          const item: QueuedPrompt = {
            id,
            text: params.text,
            enqueuedAt: new Date().toISOString(),
            senderId: params.senderId,
            ...(params.isOwner !== undefined ? { isOwner: params.isOwner } : {}),
            ...(params.accountId !== undefined ? { accountId: params.accountId } : {}),
            ...(params.media !== undefined ? { media: params.media } : {}),
          };
          const q = this.queues.get(key) ?? [];
          q.push(item);
          this.queues.set(key, q);
          this.emitQueueUpdated(params.chatKey, params.sessionAlias);
          return { ok: true, queued: true, queueItemId: id };
        }
        // Not queueable (e.g. a scheduled turn) — reject right away.
        return { ok: false, errorMessage: "turn-already-running" };
      }
      if (existing) {
        // existing is present but its controller is aborted (a Stop is unwinding it) and no
        // drain is in progress. Cancelling the transport and draining the agent takes time,
        // during which the turn stays registered. Wait (bounded) for it to clear so the
        // user's immediate follow-up starts a fresh turn instead of hitting
        // "turn-already-running"; a wedged turn still falls through to the rejection below.
        await raceWithTimeout(existing.settled, CANCEL_DRAIN_TIMEOUT_MS);
        if (this.inFlight.has(key)) {
          return { ok: false, errorMessage: "turn-already-running" };
        }
      }
    }
    const controller = new AbortController();
    // Link an external abort (scheduler dispatch timeout) to this turn so a wedged
    // scheduled prompt is cancelled cooperatively, just like a user Stop.
    if (params.abortSignal) {
      if (params.abortSignal.aborted) controller.abort();
      else params.abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    this.inFlight.set(key, { controller, settled });
    // A drained head turn has now re-registered its own inFlight synchronously (no await
    // since the finished turn's finally). Clear the hand-off guard: the slot is genuinely
    // held again, so the temporary `draining` busy marker is no longer needed.
    if (params.drained) {
      this.draining.delete(key);
    }
    // Sending to an archived session restores it (useSession clears `archived`), and
    // `/clear` (session.reset) recreates the transport session under the same alias — both
    // mutate the session row, but neither useSession nor the reset handler emits an event.
    // Capture the pre-turn state here so we can detect the transition afterwards and emit
    // `sessions-changed`, otherwise the dashboard keeps showing a stale archived badge /
    // transport+native binding on the row until the next unrelated refresh.
    let internalAlias: string | undefined;
    let wasArchived = false;
    let priorTransportSession: string | undefined;
    try {
      internalAlias = await this.deps.sessions.resolveAliasForChat(params.chatKey, params.sessionAlias);
      const prior = await this.deps.sessions.getSession(internalAlias);
      wasArchived = prior?.archived === true;
      priorTransportSession = prior?.transportSession;
    } catch {
      /* best-effort: a detection failure just means no badge refresh */
    }
    try {
      await this.deps.sessions.useSession(params.chatKey, params.sessionAlias);
    } catch (error) {
      // This turn never really started, but it still holds the slot. Settle it and advance the
      // queue so a transient bind failure on a *drained* head does not strand the items behind
      // it (which would otherwise only run when a future unrelated prompt arrives, reordering
      // FIFO). advanceQueue releases inFlight itself when the queue is empty and hands the slot
      // to the next drained turn otherwise — so we must NOT delete inFlight here (no
      // double-release, no double-drain).
      resolveSettled();
      this.advanceQueue(key, params.chatKey, params.sessionAlias);
      return { ok: false, errorMessage: toErrorMessage(error) };
    }
    if (wasArchived) {
      this.deps.events.emit({ type: "sessions-changed" });
    }
    this.deps.events.emit({
      type: "turn-started",
      chatKey: params.chatKey,
      sessionAlias: params.sessionAlias,
      ...(params.turnStarted?.prompt ? { prompt: params.turnStarted.prompt } : {}),
      ...(params.turnStarted?.scheduled ? { scheduled: params.turnStarted.scheduled } : {}),
      ...(params.turnStarted?.queueItemId ? { queueItemId: params.turnStarted.queueItemId } : {}),
    });
    // Stream-mode sessions (replyMode "stream") get raw token streaming: the transport
    // forwards chunks verbatim (paragraph breaks intact), so we concatenate as-is.
    // Batched sessions get pre-split, trimmed paragraph segments instead — there the
    // original "\n\n" is gone, and both turn-output consumers (web live view + hub
    // history buffer) simply concatenate, running paragraphs together on one line. For
    // those we re-insert the break between segments so live and history stay identical.
    let streamMode = false;
    try {
      const resolved = await this.resolveControlSession(params.chatKey, params.sessionAlias);
      streamMode = (resolved?.effectiveReplyMode ?? resolved?.replyMode) === "stream";
    } catch {
      // Best-effort: fall back to batched paragraph reconstruction.
    }
    let emittedChunk = false;
    const emitChunk = (chunk: string) => {
      if (!chunk) return;
      this.deps.events.emit({
        type: "turn-output",
        chatKey: params.chatKey,
        sessionAlias: params.sessionAlias,
        chunk: !streamMode && emittedChunk ? `\n\n${chunk}` : chunk,
      });
      emittedChunk = true;
    };
    // Defense-in-depth: the two-phase upload sandbox is meant to be the only source of
    // attachment bytes (the web flow echoes back the path control.upload returned, which
    // lives under the sandbox root). Drop any media ref whose resolved filePath escapes
    // that root so a caller cannot point the agent at an arbitrary absolute path. Only
    // touch the upload store when a turn actually carries media — a plain prompt turn
    // has no attachments and must not depend on the store being present.
    const incomingMedia = params.media ?? [];
    const sandboxedMedia = incomingMedia.length
      ? (() => {
          const uploadRoot = path.resolve(this.deps.uploadStore.root);
          const kept = incomingMedia.filter((ref) => {
            const resolved = path.resolve(ref.filePath);
            return resolved === uploadRoot || resolved.startsWith(uploadRoot + path.sep);
          });
          const dropped = incomingMedia.length - kept.length;
          if (dropped > 0) {
            console.warn(
              `[control] dropped ${dropped} media ref(s) with filePath outside the upload sandbox`,
            );
          }
          return kept;
        })()
      : incomingMedia;
    const chatMedia = sandboxedMedia.map((ref) => ({
      kind: ref.kind,
      filePath: ref.filePath,
      mimeType: ref.mimeType,
      ...(ref.fileName ? { fileName: ref.fileName } : {}),
      sizeBytes: ref.size,
      source: {
        channelId: "relay",
        accountId: params.accountId ?? "control",
        chatKey: params.chatKey,
        messageId: ref.id,
      },
    }));
    try {
      const response = await this.deps.agent.chat({
        accountId: params.accountId ?? "control",
        conversationId: params.chatKey,
        text: params.text,
        metadata: buildControlMetadata(params.senderId, params.isOwner),
        abortSignal: controller.signal,
        ...(chatMedia.length > 0 ? { media: chatMedia } : {}),
        reply: async (chunk) => {
          emitChunk(chunk);
        },
        onToolEvent: (event) => {
          this.deps.events.emit({
            type: "tool-event",
            chatKey: params.chatKey,
            sessionAlias: params.sessionAlias,
            event,
          });
        },
        onThought: (chunk) => {
          this.deps.events.emit({
            type: "turn-thought",
            chatKey: params.chatKey,
            sessionAlias: params.sessionAlias,
            chunk,
          });
        },
        onPlan: (entries) => {
          this.deps.events.emit({
            type: "plan",
            chatKey: params.chatKey,
            sessionAlias: params.sessionAlias,
            entries,
          });
        },
        onUsage: (usage) => {
          this.deps.events.emit({
            type: "turn-usage",
            chatKey: params.chatKey,
            sessionAlias: params.sessionAlias,
            used: usage.used,
            size: usage.size,
            ...(usage.cost ? { cost: usage.cost } : {}),
            ...(usage.breakdown ? { breakdown: usage.breakdown } : {}),
          });
        },
        onCommands: (commands) => {
          this.deps.events.emit({
            type: "agent-commands",
            chatKey: params.chatKey,
            sessionAlias: params.sessionAlias,
            commands,
          });
        },
      });
      if (response.text) {
        emitChunk(response.text);
      }
      this.deps.events.emit({
        type: "turn-finished",
        chatKey: params.chatKey,
        sessionAlias: params.sessionAlias,
        ok: true,
      });
      return { ok: true, text: response.text };
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      this.deps.events.emit({
        type: "turn-finished",
        chatKey: params.chatKey,
        sessionAlias: params.sessionAlias,
        ok: false,
        errorMessage,
        ...(controller.signal.aborted ? { cancelled: true } : {}),
      });
      return { ok: false, errorMessage };
    } finally {
      // If a queued head is waiting, mark `draining` synchronously NOW — before the awaited
      // sessions-changed detection below and before the slot is handed off — so nothing starts
      // a parallel turn during the release→drain window, even for an *aborted* turn whose
      // lingering inFlight entry no longer reads as busy. advanceQueue re-adds it harmlessly;
      // the drained turn clears it once it re-registers its own inFlight. When the queue is
      // empty, this turn's still-present inFlight entry is itself the busy marker across the
      // await (a normally-finished turn's controller is not aborted), so no drain is possible
      // and none is needed.
      if ((this.queues.get(key)?.length ?? 0) > 0) {
        this.draining.add(key);
      }
      // `/clear` (session.reset) recreated the transport session during the turn (and may
      // have re-bound a fresh native agentSessionId). Emit `sessions-changed` so the
      // dashboard refreshes the row; best-effort, and only when the binding actually moved.
      // Kept inline (NOT inside advanceQueue): it is async/awaited and specific to THIS
      // just-completed turn. inFlight is still held here, so it stays busy across the await.
      if (internalAlias && priorTransportSession) {
        try {
          const after = await this.deps.sessions.getSession(internalAlias);
          if (after && after.transportSession !== priorTransportSession) {
            this.deps.events.emit({ type: "sessions-changed" });
          }
        } catch {
          /* best-effort: no refresh on detection failure */
        }
      }
      resolveSettled();
      // Single decision point (shared with the useSession-failure path): start the next queued
      // head as the drained turn while holding the slot, or release inFlight if empty.
      this.advanceQueue(key, params.chatKey, params.sessionAlias);
    }
  }

  // Advances the per-session FIFO queue after a turn ends. If a head exists, starts it as the
  // next (drained) turn while holding the busy slot via `draining`; otherwise releases the
  // inFlight slot. Must be called exactly once per ended turn. Fully synchronous: `draining` is
  // added BEFORE the fire-and-forget drained `executeTurn`, whose `inFlight.set` runs
  // synchronously before its first await — so there is no window in which an incoming prompt
  // could observe a not-busy session between the ended turn and the drained turn.
  private advanceQueue(key: string, chatKey: string, sessionAlias: string): void {
    const q = this.queues.get(key);
    const next = q?.shift();
    if (q && q.length === 0) this.queues.delete(key);
    if (next) {
      this.draining.add(key);
      // The head was already popped above; emit the shorter snapshot.
      this.emitQueueUpdated(chatKey, sessionAlias);
      // Fire-and-forget: the drained turn drives its own settled lifecycle. It bypasses the
      // busy gate (drained: true), re-registers inFlight and clears `draining` at its top — all
      // synchronously before the first await — so there is no parallel-turn window. Pass
      // queueItemId ONLY, never prompt: the hub already persisted the inbound at enqueue, so
      // re-emitting prompt would double-persist and duplicate the bubble.
      void this.executeTurn({
        chatKey,
        sessionAlias,
        text: next.text,
        senderId: next.senderId,
        queueable: true,
        drained: true,
        ...(next.isOwner !== undefined ? { isOwner: next.isOwner } : {}),
        ...(next.accountId !== undefined ? { accountId: next.accountId } : {}),
        ...(next.media !== undefined ? { media: next.media } : {}),
        turnStarted: { queueItemId: next.id },
      });
    } else {
      // The queue emptied during the drain hand-off (e.g. a cancel removed the only queued
      // item while the finally's post-turn `await getSession` was in flight, after the finally
      // set `draining`). No drained turn is coming to clear the guard, so clear it here too —
      // otherwise `draining` leaks and every future prompt enqueues forever (permanent wedge).
      this.draining.delete(key);
      this.inFlight.delete(key);
    }
  }

  cancelTurn(chatKey: string, sessionAlias: string): boolean {
    const entry = this.inFlight.get(turnKey(chatKey, sessionAlias));
    if (!entry) {
      return false;
    }
    entry.controller.abort();
    return true;
  }

  /** Remove a pending queued prompt (by id) before it drains. No-ops (returns
   *  `{ cancelled: false }`) when the queue or the id is absent/already drained —
   *  e.g. a race where the item drained into a running turn just before the cancel
   *  arrived. Does NOT touch a turn that is already running (use `cancelTurn`). */
  cancelQueuedItem(chatKey: string, sessionAlias: string, itemId: string): { cancelled: boolean } {
    const key = turnKey(chatKey, sessionAlias);
    const q = this.queues.get(key);
    if (!q) return { cancelled: false };
    const i = q.findIndex((x) => x.id === itemId);
    if (i < 0) return { cancelled: false };
    q.splice(i, 1);
    if (q.length === 0) this.queues.delete(key);
    this.emitQueueUpdated(chatKey, sessionAlias);
    return { cancelled: true };
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

// Upper bound on how long a follow-up prompt waits for a just-cancelled turn to
// finish tearing down before giving up and reporting the session still busy.
const CANCEL_DRAIN_TIMEOUT_MS = 5000;

// Server-side truncation for a queued item's textPreview on the queue-updated wire
// event, so a very long queued prompt doesn't bloat the snapshot payload.
const QUEUE_PREVIEW_MAX = 120;

// Resolve when `promise` settles or `ms` elapses, whichever comes first. The timer
// is cleared on the winning path so a fast drain doesn't keep the event loop alive.
async function raceWithTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function turnKey(chatKey: string, sessionAlias: string): string {
  return `${chatKey} ${sessionAlias}`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildControlMetadata(senderId: string, isOwner: boolean | undefined): ChatRequestMetadata {
  return {
    channel: "control",
    chatType: "direct",
    senderId,
    ...(isOwner === undefined ? {} : { isOwner }),
  };
}
