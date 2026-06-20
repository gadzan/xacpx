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
import { WorkspaceFs, type DirListing, type FileContent, type SearchResult, type WorkspaceDiff } from "./workspace-fs";

export interface ControlSessionInfo {
  alias: string;
  agent: string;
  workspace: string;
  transportSession: string;
  running: boolean;
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
    "listAllResolvedSessions" | "removeSession" | "useSession" | "resolveAliasForChat" | "getSession" | "setSessionModel"
  >;
  // The active transport, for reading/switching a session's model. setModel/
  // getSessionModel are optional on the interface — absence is handled gracefully.
  transport: Pick<SessionTransport, "setModel" | "getSessionModel">;
  // Full-lifecycle session creator (resolve → ensure acpx session → bind),
  // wired to CommandRouter.createSessionWithTransport in main.ts. Replaces the
  // logical-only sessions.createSession so control-created sessions are promptable.
  createSessionWithTransport: (internalAlias: string, agent: string, workspace: string, model?: string) => Promise<ResolvedSession>;
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
}

export interface ControlPromptInput {
  chatKey: string;
  sessionAlias: string;
  text: string;
  accountId?: string;
  senderId: string;
  isOwner?: boolean;
}

export interface ControlPromptResult {
  ok: boolean;
  text?: string;
  errorMessage?: string;
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

  searchWorkspace(workspace: string, query: string): Promise<SearchResult> {
    return this.workspaceFs.search(workspace, query);
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
    };
  }

  async removeSession(chatKey: string, alias: string): Promise<{ wasActive: boolean }> {
    const internalAlias = await this.deps.sessions.resolveAliasForChat(chatKey, alias);
    const result = await this.deps.sessions.removeSession(internalAlias);
    this.deps.events.emit({ type: "sessions-changed" });
    return result;
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

  async prompt(input: ControlPromptInput): Promise<ControlPromptResult> {
    return this.executeTurn({
      chatKey: input.chatKey,
      sessionAlias: input.sessionAlias,
      text: input.text,
      senderId: input.senderId,
      ...(input.isOwner !== undefined ? { isOwner: input.isOwner } : {}),
      ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
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
    // Extra fields stamped onto turn-started for scheduled-origin turns.
    turnStarted?: { prompt?: string; scheduled?: ScheduledOrigin };
  }): Promise<ControlPromptResult> {
    const key = turnKey(params.chatKey, params.sessionAlias);
    const existing = this.inFlight.get(key);
    if (existing) {
      // A live, un-cancelled turn really is busy — reject right away.
      if (!existing.controller.signal.aborted) {
        return { ok: false, errorMessage: "turn-already-running" };
      }
      // A Stop is already unwinding this turn. Cancelling the transport and draining
      // the agent takes time, during which the turn stays registered. Wait (bounded)
      // for it to clear so the user's immediate follow-up starts a fresh turn instead
      // of hitting "turn-already-running"; a wedged turn still falls through to the
      // rejection below once the window elapses.
      await raceWithTimeout(existing.settled, CANCEL_DRAIN_TIMEOUT_MS);
      if (this.inFlight.has(key)) {
        return { ok: false, errorMessage: "turn-already-running" };
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
    try {
      await this.deps.sessions.useSession(params.chatKey, params.sessionAlias);
    } catch (error) {
      this.inFlight.delete(key);
      resolveSettled();
      return { ok: false, errorMessage: toErrorMessage(error) };
    }
    this.deps.events.emit({
      type: "turn-started",
      chatKey: params.chatKey,
      sessionAlias: params.sessionAlias,
      ...(params.turnStarted?.prompt ? { prompt: params.turnStarted.prompt } : {}),
      ...(params.turnStarted?.scheduled ? { scheduled: params.turnStarted.scheduled } : {}),
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
    try {
      const response = await this.deps.agent.chat({
        accountId: params.accountId ?? "control",
        conversationId: params.chatKey,
        text: params.text,
        metadata: buildControlMetadata(params.senderId, params.isOwner),
        abortSignal: controller.signal,
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
      this.inFlight.delete(key);
      resolveSettled();
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
}

// Upper bound on how long a follow-up prompt waits for a just-cancelled turn to
// finish tearing down before giving up and reporting the session still busy.
const CANCEL_DRAIN_TIMEOUT_MS = 5000;

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
