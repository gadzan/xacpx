import {
  MSG,
  errorPayload,
  type CommandExecutePayload,
  type FsDiffPayload,
  type FsListPayload,
  type FsReadPayload,
  type FsSearchPayload,
  type SessionModelGetPayload,
  type SessionModelSetPayload,
  type OrchestrationCancelPayload,
  type OrchestrationGetPayload,
  type OrchestrationTaskDto,
  type PromptCancelPayload,
  type PromptPayload,
  type RelayEnvelope,
  type ScheduledCancelPayload,
  type ScheduledCreatePayload,
  type ScheduledListPayload,
  type ScheduledTaskDto,
  type AgentsCreatePayload,
  type AgentsRemovePayload,
  type SessionsCreatePayload,
  type SessionsListPayload,
  type SessionsRemovePayload,
  type WorkspacesCreatePayload,
  type WorkspacesRemovePayload,
} from "@ganglion/xacpx-relay-protocol";
import type { ControlService } from "xacpx/plugin-api";
import { toolUseEventToStepDto } from "./tool-presentation";

// Wire mappers live here (not in relay-protocol) so the protocol package stays
// free of xacpx imports. Field lists mirror the "Keep in sync" notes in dtos.ts.
export function scheduledTaskToDto(record: ReturnType<ControlService["listScheduledTasks"]>[number]): ScheduledTaskDto {
  return {
    id: record.id,
    sessionAlias: record.session_alias,
    executeAt: record.execute_at,
    message: record.message,
    status: record.status,
    createdAt: record.created_at,
  };
}

export function orchestrationTaskToDto(
  record: Awaited<ReturnType<ControlService["listOrchestrationTasks"]>>[number],
): OrchestrationTaskDto {
  return {
    taskId: record.taskId,
    status: record.status,
    targetAgent: record.targetAgent,
    workspace: record.workspace,
    task: record.task,
    summary: record.summary,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export type ControlBridge = (envelope: RelayEnvelope, respond: (payload: unknown) => void) => void;

export function createControlBridge(control: ControlService): ControlBridge {
  return (envelope, respond) => {
    void dispatchControlRequest(control, envelope)
      .then(respond)
      .catch((error: unknown) => {
        respond(errorPayload("internal", error instanceof Error ? error.message : String(error)));
      });
  };
}

async function dispatchControlRequest(control: ControlService, envelope: RelayEnvelope): Promise<unknown> {
  const payload = envelope.payload;
  switch (envelope.type) {
    case MSG.sessionsList: {
      const input = payload as SessionsListPayload;
      return { sessions: control.listSessions(input.chatKey) }; // ControlSessionInfo is field-identical to SessionDto
    }
    case MSG.sessionsCreate: {
      const input = payload as SessionsCreatePayload;
      return await control.createSession(input.chatKey, input.alias, input.agent, input.workspace);
    }
    case MSG.sessionsRemove: {
      const input = payload as SessionsRemovePayload;
      return await control.removeSession(input.chatKey, input.alias);
    }
    case MSG.agentsList:
      return { agents: control.listAgents() };
    case MSG.workspacesList:
      return { workspaces: control.listWorkspaces() };
    case MSG.workspacesCreate: {
      const input = payload as WorkspacesCreatePayload;
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
      if (!name || !cwd) return errorPayload("bad-request", "workspace name and cwd are required");
      return { workspace: await control.createWorkspace(name, cwd, input.description) };
    }
    case MSG.agentsCatalog:
      return { agents: control.listAgentCatalog() };
    case MSG.agentsCreate: {
      const input = payload as AgentsCreatePayload;
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const driver = typeof input.driver === "string" ? input.driver.trim() : "";
      if (!name || !driver) return errorPayload("bad-request", "agent name and driver are required");
      return { agent: await control.createAgent(name, driver) };
    }
    case MSG.agentsRemove: {
      const input = payload as AgentsRemovePayload;
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name) return errorPayload("bad-request", "agent name is required");
      await control.removeAgent(name);
      return { ok: true };
    }
    case MSG.workspacesRemove: {
      const input = payload as WorkspacesRemovePayload;
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name) return errorPayload("bad-request", "workspace name is required");
      await control.removeWorkspace(name);
      return { ok: true };
    }
    case MSG.prompt:
      return await control.prompt(payload as PromptPayload);
    case MSG.promptCancel: {
      const input = payload as PromptCancelPayload;
      return { cancelled: control.cancelTurn(input.chatKey, input.sessionAlias) };
    }
    case MSG.commandExecute: {
      const input = payload as CommandExecutePayload;
      return { output: await control.executeCommand(input) };
    }
    case MSG.scheduledList: {
      const input = payload as ScheduledListPayload;
      return { tasks: control.listScheduledTasks(input.chatKey).map(scheduledTaskToDto) };
    }
    case MSG.scheduledCreate: {
      const input = payload as ScheduledCreatePayload;
      const ms = Date.parse(input.executeAt);
      if (Number.isNaN(ms)) return errorPayload("bad-request", "executeAt is not a valid ISO timestamp");
      const task = await control.createScheduledTask({
        chatKey: input.chatKey,
        sessionAlias: input.sessionAlias,
        executeAt: new Date(ms),
        message: input.message,
      });
      return scheduledTaskToDto(task);
    }
    case MSG.scheduledCancel: {
      const input = payload as ScheduledCancelPayload;
      return { cancelled: await control.cancelScheduledTask(input.id, input.chatKey) };
    }
    case MSG.orchestrationList:
      return { tasks: (await control.listOrchestrationTasks()).map(orchestrationTaskToDto) };
    case MSG.orchestrationGet: {
      const input = payload as OrchestrationGetPayload;
      const task = await control.getOrchestrationTask(input.taskId);
      return { task: task ? orchestrationTaskToDto(task) : null };
    }
    case MSG.orchestrationCancel: {
      const input = payload as OrchestrationCancelPayload;
      return orchestrationTaskToDto(await control.cancelOrchestrationTask({ taskId: input.taskId }));
    }
    case MSG.fsList: {
      const input = payload as FsListPayload;
      if (!input.workspace) return errorPayload("bad-request", "workspace is required");
      return await control.listDirectory(input.workspace, input.path); // DirListing ≅ FsListResult
    }
    case MSG.fsRead: {
      const input = payload as FsReadPayload;
      if (!input.workspace || !input.path) return errorPayload("bad-request", "workspace and path are required");
      return await control.readWorkspaceFile(input.workspace, input.path); // FileContent ≅ FsReadResult
    }
    case MSG.fsDiff: {
      const input = payload as FsDiffPayload;
      if (!input.workspace) return errorPayload("bad-request", "workspace is required");
      return await control.workspaceGitDiff(input.workspace, input.path); // WorkspaceDiff ≅ FsDiffResult
    }
    case MSG.fsSearch: {
      const input = payload as FsSearchPayload;
      if (!input.workspace) return errorPayload("bad-request", "workspace is required");
      return await control.searchWorkspace(input.workspace, input.query ?? ""); // SearchResult ≅ FsSearchResult
    }
    case MSG.sessionModelGet: {
      const input = payload as SessionModelGetPayload;
      if (!input.sessionAlias) return errorPayload("bad-request", "sessionAlias is required");
      return await control.getSessionModel(input.chatKey, input.sessionAlias); // ≅ SessionModelResult
    }
    case MSG.sessionModelSet: {
      const input = payload as SessionModelSetPayload;
      if (!input.sessionAlias || !input.modelId) return errorPayload("bad-request", "sessionAlias and modelId are required");
      await control.setSessionModel(input.chatKey, input.sessionAlias, input.modelId);
      return { ok: true };
    }
    default:
      return errorPayload("unknown-type", `unsupported rpc type: ${envelope.type}`);
  }
}

export function subscribeControlEvents(
  control: ControlService,
  sendEvent: (type: string, payload: unknown) => void,
): () => void {
  return control.events.subscribe((event) => {
    if (event.type === "tool-event") {
      sendEvent(MSG.instanceEvent, {
        event: { type: "tool-event", chatKey: event.chatKey, sessionAlias: event.sessionAlias, step: toolUseEventToStepDto(event.event) },
      });
      return;
    }
    sendEvent(MSG.instanceEvent, { event });
  });
}
