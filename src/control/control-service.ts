import type { Agent as ChatAgent, ChatRequestMetadata } from "../weixin/agent/interface";
import type { SessionService } from "../sessions/session-service";
import type { ResolvedSession } from "../transport/types";
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
import type { AgentCatalogEntry } from "../config/agent-catalog";
import { WorkspaceFs, type DirListing, type FileContent, type WorkspaceDiff } from "./workspace-fs";

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

export interface ControlWorkspaceInfo {
  name: string;
  cwd: string;
  description?: string;
}

export interface ControlServiceDeps {
  agent: Pick<ChatAgent, "chat">;
  sessions: Pick<
    SessionService,
    "listAllResolvedSessions" | "removeSession" | "useSession" | "resolveAliasForChat"
  >;
  // Full-lifecycle session creator (resolve → ensure acpx session → bind),
  // wired to CommandRouter.createSessionWithTransport in main.ts. Replaces the
  // logical-only sessions.createSession so control-created sessions are promptable.
  createSessionWithTransport: (internalAlias: string, agent: string, workspace: string) => Promise<ResolvedSession>;
  activeTurns: Pick<ActiveTurnRegistry, "isActiveAnywhere">;
  scheduled: Pick<ScheduledTaskService, "listPending" | "createTask" | "cancelPending">;
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

  async createSession(chatKey: string, alias: string, agent: string, workspace: string): Promise<ControlSessionInfo> {
    const internalAlias = await this.deps.sessions.resolveAliasForChat(chatKey, alias);
    const session = await this.deps.createSessionWithTransport(internalAlias, agent, workspace);
    this.deps.events.emit({ type: "sessions-changed" });
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

  listScheduledTasks(chatKey: string): ScheduledTaskRecord[] {
    return this.deps.scheduled.listPending(chatKey);
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

  private readonly inFlight = new Map<string, AbortController>();

  async prompt(input: ControlPromptInput): Promise<ControlPromptResult> {
    const key = turnKey(input.chatKey, input.sessionAlias);
    if (this.inFlight.has(key)) {
      return { ok: false, errorMessage: "turn-already-running" };
    }
    const controller = new AbortController();
    this.inFlight.set(key, controller);
    try {
      await this.deps.sessions.useSession(input.chatKey, input.sessionAlias);
    } catch (error) {
      this.inFlight.delete(key);
      return { ok: false, errorMessage: toErrorMessage(error) };
    }
    this.deps.events.emit({
      type: "turn-started",
      chatKey: input.chatKey,
      sessionAlias: input.sessionAlias,
    });
    const emitChunk = (chunk: string) => {
      this.deps.events.emit({
        type: "turn-output",
        chatKey: input.chatKey,
        sessionAlias: input.sessionAlias,
        chunk,
      });
    };
    try {
      const response = await this.deps.agent.chat({
        accountId: input.accountId ?? "control",
        conversationId: input.chatKey,
        text: input.text,
        metadata: buildControlMetadata(input.senderId, input.isOwner),
        abortSignal: controller.signal,
        reply: async (chunk) => {
          emitChunk(chunk);
        },
        onToolEvent: (event) => {
          this.deps.events.emit({
            type: "tool-event",
            chatKey: input.chatKey,
            sessionAlias: input.sessionAlias,
            event,
          });
        },
        onThought: (chunk) => {
          this.deps.events.emit({
            type: "turn-thought",
            chatKey: input.chatKey,
            sessionAlias: input.sessionAlias,
            chunk,
          });
        },
      });
      if (response.text) {
        emitChunk(response.text);
      }
      this.deps.events.emit({
        type: "turn-finished",
        chatKey: input.chatKey,
        sessionAlias: input.sessionAlias,
        ok: true,
      });
      return { ok: true, text: response.text };
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      this.deps.events.emit({
        type: "turn-finished",
        chatKey: input.chatKey,
        sessionAlias: input.sessionAlias,
        ok: false,
        errorMessage,
        ...(controller.signal.aborted ? { cancelled: true } : {}),
      });
      return { ok: false, errorMessage };
    } finally {
      this.inFlight.delete(key);
    }
  }

  cancelTurn(chatKey: string, sessionAlias: string): boolean {
    const controller = this.inFlight.get(turnKey(chatKey, sessionAlias));
    if (!controller) {
      return false;
    }
    controller.abort();
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
