import {
  MSG,
  errorPayload,
  parseControlPayload,
  type AgentMessageDeliverPayload,
  type OrchestrationTaskDto,
  type RelayEnvelope,
  type ScheduledTaskDto,
  type SessionHistoryRowDto,
} from "@ganglion/xacpx-relay-protocol";
import type { ControlService } from "xacpx/plugin-api";
import { toolUseEventToStepDto } from "./tool-presentation";

// Wire mappers live here (not in relay-protocol) so the protocol package stays
// free of xacpx imports. Field lists mirror the "Keep in sync" notes in dtos.ts.
export function scheduledTaskToDto(
  record: ReturnType<ControlService["listScheduledTasks"]>[number],
): ScheduledTaskDto {
  return {
    id: record.id,
    sessionAlias: record.session_alias,
    executeAt: record.execute_at,
    message: record.message,
    status: record.status,
    createdAt: record.created_at,
    ...(record.executed_at ? { executedAt: record.executed_at } : {}),
    ...(record.failed_at ? { failedAt: record.failed_at } : {}),
    ...(record.last_error ? { lastError: record.last_error } : {}),
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

export type ControlBridge = (
  envelope: RelayEnvelope,
  respond: (payload: unknown) => void,
) => void;

/**
 * Default time bound for one control RPC dispatch. A hung `await control.*`
 * would otherwise leave the hub-side pending entry waiting out its full
 * request timeout (120s default) with no signal from the connector. The
 * timeout only bounds the RPC *response* — the underlying control operation
 * is not cancelled and keeps running.
 */
export const CONTROL_RPC_TIMEOUT_MS = 60_000;

// RPC types the connector must NOT bound, because a dispatch timeout here does
// not cancel the underlying control operation — it only stops waiting and
// returns a spurious error while the op keeps running. Bounding these below
// their real ceiling only preempts legitimate slow work:
//   - prompt: awaits the whole interactive turn (bounding = a turn watchdog,
//     policy-sensitive, out of scope).
//   - sessionsCreate / sessionsNativeList: wrap a core operation that already
//     carries its own timeout at the hub's 120s ceiling (agent cold start /
//     session-init defaults to 120s, native-history listing is core-bounded).
//     A 110s connector bound would fire ~10s early on a slow first-run cold
//     start, reporting failure while the session still gets created.
//   - commandExecute: runs a slash command / agent command that is prompt-like
//     in duration.
//   - sessionModelSet: a 30s set timeout can be followed by a 30s authoritative
//     status read (or two 45s bridge backstops). A 60s connector response timer
//     would race that reconciliation without cancelling the underlying work;
//     the Hub envelope budget instead prevents stale queued mutations from starting.
//   - sessionEffortSet: discovers the adapter's config id, then applies it; both
//     management commands have their own 30s subprocess timeout.
// For all of these the hub's own 120s request timeout is the real backstop.
const CONNECTOR_TIMEOUT_EXEMPT_TYPES: ReadonlySet<string> = new Set([
  MSG.prompt,
  MSG.sessionsCreate,
  MSG.sessionsNativeList,
  MSG.commandExecute,
  MSG.sessionModelSet,
  MSG.sessionEffortSet,
]);

export interface ControlBridgeOptions {
  timeoutMs?: number;
  /** Test seams for the dispatch timeout timer and request-deadline conversion. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (timer: unknown) => void;
  now?: () => number;
}

function controlRpcTimeoutMs(
  type: string,
  options: ControlBridgeOptions,
): number | undefined {
  if (CONNECTOR_TIMEOUT_EXEMPT_TYPES.has(type)) return undefined;
  return options.timeoutMs ?? CONTROL_RPC_TIMEOUT_MS;
}

function modelSetDeadlineAt(
  envelope: RelayEnvelope,
  now: () => number,
): number | undefined {
  if (envelope.type !== MSG.sessionModelSet) return undefined;
  const receivedAt = now();
  const absolute = envelope.requestDeadlineAt;
  const budget = envelope.requestBudgetMs;
  // The pair is intentional: the absolute cutoff preserves the Hub's response
  // reserve across delivery delay, while the relative budget caps clock skew.
  // A partial/legacy envelope cannot provide both guarantees, so fail closed.
  if (
    typeof absolute !== "number" ||
    !Number.isFinite(absolute) ||
    absolute <= 0 ||
    typeof budget !== "number" ||
    !Number.isFinite(budget) ||
    budget <= 0
  ) {
    return receivedAt;
  }
  return Math.min(absolute, receivedAt + budget);
}

export function createControlBridge(
  control: ControlService,
  options: ControlBridgeOptions = {},
): ControlBridge {
  const setTimeoutFn =
    options.setTimeoutFn ??
    ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimeoutFn =
    options.clearTimeoutFn ??
    ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const now = options.now ?? Date.now;
  return (envelope, respond) => {
    let settled = false;
    let timer: unknown;
    const respondOnce = (payload: unknown) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) {
        clearTimeoutFn(timer);
        timer = undefined;
      }
      respond(payload);
    };

    const timeoutMs = controlRpcTimeoutMs(envelope.type, options);
    if (timeoutMs !== undefined) {
      timer = setTimeoutFn(() => {
        respondOnce(
          errorPayload(
            "timeout",
            `rpc ${envelope.type} timed out after ${timeoutMs}ms in the connector`,
          ),
        );
      }, timeoutMs);
    }

    const deadlineAt = modelSetDeadlineAt(envelope, now);
    void dispatchControlRequest(control, envelope, deadlineAt)
      .then(respondOnce)
      .catch((error: unknown) => {
        respondOnce(
          errorPayload(
            "internal",
            error instanceof Error ? error.message : String(error),
          ),
        );
      });
  };
}

async function dispatchControlRequest(
  control: ControlService,
  envelope: RelayEnvelope,
  deadlineAt?: number,
): Promise<unknown> {
  const payload = envelope.payload;
  switch (envelope.type) {
    case MSG.sessionsList: {
      const input = parseControlPayload(MSG.sessionsList, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.sessionsList}: malformed payload`,
        );
      const hasFilters =
        input.includeArchived !== undefined ||
        input.archivedOnly !== undefined ||
        input.workspace !== undefined ||
        input.agent !== undefined;
      if (
        input.offset !== undefined ||
        input.limit !== undefined ||
        hasFilters
      ) {
        return control.listSessionsPage(
          input.chatKey,
          input.offset,
          input.limit,
          input.includeArchived,
          {
            archivedOnly: input.archivedOnly,
            workspace: input.workspace,
            agent: input.agent,
          },
        );
      }
      return { sessions: control.listSessions(input.chatKey) }; // ControlSessionInfo is field-identical to SessionDto
    }
    case MSG.sessionsCreate: {
      const input = parseControlPayload(MSG.sessionsCreate, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.sessionsCreate}: malformed payload`,
        );
      return await control.createSession(
        input.chatKey,
        input.alias,
        input.agent,
        input.workspace,
        input.agentSessionId,
        input.model,
      );
    }
    case MSG.sessionsNativeList: {
      const input = parseControlPayload(MSG.sessionsNativeList, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.sessionsNativeList}: malformed payload`,
        );
      return {
        sessions: await control.listNativeSessions(
          input.chatKey,
          input.agent,
          input.workspace,
        ),
      };
    }
    case MSG.sessionsRemove: {
      const input = parseControlPayload(MSG.sessionsRemove, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.sessionsRemove}: malformed payload`,
        );
      return await control.removeSession(input.chatKey, input.alias);
    }
    case MSG.sessionsArchive: {
      const input = parseControlPayload(MSG.sessionsArchive, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.sessionsArchive}: malformed payload`,
        );
      await control.archiveSession(input.chatKey, input.alias);
      return {};
    }
    case MSG.sessionsUnarchive: {
      const input = parseControlPayload(MSG.sessionsUnarchive, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.sessionsUnarchive}: malformed payload`,
        );
      await control.unarchiveSession(input.chatKey, input.alias);
      return {};
    }
    case MSG.sessionsRename: {
      const input = parseControlPayload(MSG.sessionsRename, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.sessionsRename}: malformed payload`,
        );
      if (!input.alias) return errorPayload("bad-request", "alias is required");
      await control.setSessionDisplayName(
        input.chatKey,
        input.alias,
        input.displayName ?? "",
      );
      return { ok: true };
    }
    case MSG.agentsList:
      return { agents: control.listAgents() };
    case MSG.workspacesList:
      return { workspaces: control.listWorkspaces() };
    case MSG.workspacesCreate: {
      const input = parseControlPayload(MSG.workspacesCreate, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.workspacesCreate}: malformed payload`,
        );
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
      if (!name || !cwd)
        return errorPayload(
          "bad-request",
          "workspace name and cwd are required",
        );
      return {
        workspace: await control.createWorkspace(name, cwd, input.description),
      };
    }
    case MSG.agentsCatalog:
      return { agents: control.listAgentCatalog() };
    case MSG.agentsCreate: {
      const input = parseControlPayload(MSG.agentsCreate, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.agentsCreate}: malformed payload`,
        );
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const driver =
        typeof input.driver === "string" ? input.driver.trim() : "";
      if (!name || !driver)
        return errorPayload(
          "bad-request",
          "agent name and driver are required",
        );
      return { agent: await control.createAgent(name, driver) };
    }
    case MSG.agentsRemove: {
      const input = parseControlPayload(MSG.agentsRemove, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.agentsRemove}: malformed payload`,
        );
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name) return errorPayload("bad-request", "agent name is required");
      await control.removeAgent(name);
      return { ok: true };
    }
    case MSG.workspacesRemove: {
      const input = parseControlPayload(MSG.workspacesRemove, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.workspacesRemove}: malformed payload`,
        );
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name)
        return errorPayload("bad-request", "workspace name is required");
      await control.removeWorkspace(name);
      return { ok: true };
    }
    case MSG.prompt: {
      const input = parseControlPayload(MSG.prompt, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.prompt}: malformed payload`,
        );
      return await control.prompt(input);
    }
    case MSG.promptCancel: {
      const input = parseControlPayload(MSG.promptCancel, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.promptCancel}: malformed payload`,
        );
      return {
        cancelled: control.cancelTurn(input.chatKey, input.sessionAlias),
      };
    }
    case MSG.queueCancel: {
      const input = parseControlPayload(MSG.queueCancel, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.queueCancel}: malformed payload`,
        );
      return control.cancelQueuedItem(
        input.chatKey,
        input.sessionAlias,
        input.itemId,
      );
    }
    case MSG.commandExecute: {
      const input = parseControlPayload(MSG.commandExecute, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.commandExecute}: malformed payload`,
        );
      return { output: await control.executeCommand(input) };
    }
    case MSG.scheduledList: {
      const input = parseControlPayload(MSG.scheduledList, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.scheduledList}: malformed payload`,
        );
      return {
        tasks: control
          .listScheduledTasks(input.chatKey)
          .map(scheduledTaskToDto),
      };
    }
    case MSG.scheduledCreate: {
      const input = parseControlPayload(MSG.scheduledCreate, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.scheduledCreate}: malformed payload`,
        );
      const ms = Date.parse(input.executeAt);
      if (Number.isNaN(ms))
        return errorPayload(
          "bad-request",
          "executeAt is not a valid ISO timestamp",
        );
      const task = await control.createScheduledTask({
        chatKey: input.chatKey,
        sessionAlias: input.sessionAlias,
        executeAt: new Date(ms),
        message: input.message,
      });
      return scheduledTaskToDto(task);
    }
    case MSG.scheduledCancel: {
      const input = parseControlPayload(MSG.scheduledCancel, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.scheduledCancel}: malformed payload`,
        );
      return {
        cancelled: await control.cancelScheduledTask(input.id, input.chatKey),
      };
    }
    case MSG.orchestrationList:
      return {
        tasks: (await control.listOrchestrationTasks()).map(
          orchestrationTaskToDto,
        ),
      };
    case MSG.orchestrationGet: {
      const input = parseControlPayload(MSG.orchestrationGet, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.orchestrationGet}: malformed payload`,
        );
      const task = await control.getOrchestrationTask(input.taskId);
      return { task: task ? orchestrationTaskToDto(task) : null };
    }
    case MSG.orchestrationCancel: {
      const input = parseControlPayload(MSG.orchestrationCancel, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.orchestrationCancel}: malformed payload`,
        );
      return orchestrationTaskToDto(
        await control.cancelOrchestrationTask({ taskId: input.taskId }),
      );
    }
    case MSG.fsList: {
      const input = parseControlPayload(MSG.fsList, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.fsList}: malformed payload`,
        );
      if (!input.workspace)
        return errorPayload("bad-request", "workspace is required");
      return await control.listDirectory(input.workspace, input.path); // DirListing ≅ FsListResult
    }
    case MSG.fsRead: {
      const input = parseControlPayload(MSG.fsRead, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.fsRead}: malformed payload`,
        );
      if (!input.workspace || !input.path)
        return errorPayload("bad-request", "workspace and path are required");
      return await control.readWorkspaceFile(input.workspace, input.path); // FileContent ≅ FsReadResult
    }
    case MSG.fsDiff: {
      const input = parseControlPayload(MSG.fsDiff, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.fsDiff}: malformed payload`,
        );
      if (!input.workspace)
        return errorPayload("bad-request", "workspace is required");
      return await control.workspaceGitDiff(input.workspace, input.path); // WorkspaceDiff ≅ FsDiffResult
    }
    case MSG.gitStatus: {
      const input = parseControlPayload(MSG.gitStatus, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.gitStatus}: malformed payload`,
        );
      return await control.workspaceGitStatus(input.workspace);
    }
    case MSG.gitStage: {
      const input = parseControlPayload(MSG.gitStage, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.gitStage}: malformed payload`,
        );
      await control.gitStage(input.workspace, input.paths);
      return { ok: true };
    }
    case MSG.gitUnstage: {
      const input = parseControlPayload(MSG.gitUnstage, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.gitUnstage}: malformed payload`,
        );
      await control.gitUnstage(input.workspace, input.paths);
      return { ok: true };
    }
    case MSG.gitUntrack: {
      const input = parseControlPayload(MSG.gitUntrack, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.gitUntrack}: malformed payload`,
        );
      await control.gitUntrack(input.workspace, input.paths);
      return { ok: true };
    }
    case MSG.gitDiscard: {
      const input = parseControlPayload(MSG.gitDiscard, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.gitDiscard}: malformed payload`,
        );
      await control.gitDiscard(input.workspace, input.paths);
      return { ok: true };
    }
    case MSG.gitCommit: {
      const input = parseControlPayload(MSG.gitCommit, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.gitCommit}: malformed payload`,
        );
      return await control.gitCommit(input.workspace, input.message);
    }
    case MSG.gitFetch: {
      const input = parseControlPayload(MSG.gitFetch, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.gitFetch}: malformed payload`,
        );
      await control.gitFetch(input.workspace, input.remote);
      return { ok: true };
    }
    case MSG.gitPull: {
      const input = parseControlPayload(MSG.gitPull, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.gitPull}: malformed payload`,
        );
      await control.gitPull(input.workspace);
      return { ok: true };
    }
    case MSG.gitPush: {
      const input = parseControlPayload(MSG.gitPush, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.gitPush}: malformed payload`,
        );
      await control.gitPush(input.workspace, {
        ...(input.setUpstream !== undefined
          ? { setUpstream: input.setUpstream }
          : {}),
        ...(input.remote !== undefined ? { remote: input.remote } : {}),
      });
      return { ok: true };
    }
    case MSG.gitCheckout: {
      const input = parseControlPayload(MSG.gitCheckout, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.gitCheckout}: malformed payload`,
        );
      await control.gitCheckout(input.workspace, {
        branch: input.branch,
        ...(input.create !== undefined ? { create: input.create } : {}),
        ...(input.startPoint !== undefined
          ? { startPoint: input.startPoint }
          : {}),
      });
      return { ok: true };
    }
    case MSG.gitWorktreeCreate: {
      const input = parseControlPayload(MSG.gitWorktreeCreate, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.gitWorktreeCreate}: malformed payload`,
        );
      return await control.gitCreateWorktree(input.workspace, {
        workspaceName: input.workspaceName,
        branch: input.branch,
        ...(input.createBranch !== undefined
          ? { createBranch: input.createBranch }
          : {}),
        ...(input.startPoint !== undefined
          ? { startPoint: input.startPoint }
          : {}),
      });
    }
    case MSG.fsSearch: {
      const input = parseControlPayload(MSG.fsSearch, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.fsSearch}: malformed payload`,
        );
      if (!input.workspace)
        return errorPayload("bad-request", "workspace is required");
      return await control.searchWorkspace(input.workspace, {
        query: input.query ?? "",
        mode: input.mode,
        matchCase: input.matchCase,
        wholeWord: input.wholeWord,
        regex: input.regex,
        include: input.include,
        exclude: input.exclude,
        path: input.path,
      }); // SearchResult ≅ FsSearchResult
    }
    case MSG.fsCreate: {
      const i = parseControlPayload(MSG.fsCreate, payload);
      if (!i)
        return errorPayload(
          "invalid-payload",
          `${MSG.fsCreate}: malformed payload`,
        );
      if (!i.workspace || !i.path)
        return errorPayload("bad-request", "workspace and path are required");
      if (i.kind !== "file" && i.kind !== "dir")
        return errorPayload("bad-request", "kind must be file or dir");
      return await control.fsCreate(i.workspace, i.path, i.kind);
    }
    case MSG.fsRename: {
      const i = parseControlPayload(MSG.fsRename, payload);
      if (!i)
        return errorPayload(
          "invalid-payload",
          `${MSG.fsRename}: malformed payload`,
        );
      if (!i.workspace || !i.path || !i.newName)
        return errorPayload(
          "bad-request",
          "workspace, path and newName are required",
        );
      return await control.fsRename(i.workspace, i.path, i.newName);
    }
    case MSG.fsDelete: {
      const i = parseControlPayload(MSG.fsDelete, payload);
      if (!i)
        return errorPayload(
          "invalid-payload",
          `${MSG.fsDelete}: malformed payload`,
        );
      if (!i.workspace || !i.path)
        return errorPayload("bad-request", "workspace and path are required");
      return await control.fsDelete(i.workspace, i.path);
    }
    case MSG.fsCopy: {
      const i = parseControlPayload(MSG.fsCopy, payload);
      if (!i)
        return errorPayload(
          "invalid-payload",
          `${MSG.fsCopy}: malformed payload`,
        );
      if (!i.workspace || !i.path)
        return errorPayload("bad-request", "workspace and path are required");
      return await control.fsCopy(i.workspace, i.path);
    }
    case MSG.fsDownload: {
      const i = parseControlPayload(MSG.fsDownload, payload);
      if (!i)
        return errorPayload(
          "invalid-payload",
          `${MSG.fsDownload}: malformed payload`,
        );
      if (!i.workspace || !i.path)
        return errorPayload("bad-request", "workspace and path are required");
      return await control.fsDownload(i.workspace, i.path);
    }
    case MSG.fsWrite: {
      const i = parseControlPayload(MSG.fsWrite, payload);
      if (!i)
        return errorPayload(
          "invalid-payload",
          `${MSG.fsWrite}: malformed payload`,
        );
      if (!i.workspace || !i.path)
        return errorPayload("bad-request", "workspace and path are required");
      if (typeof i.content !== "string")
        return errorPayload("bad-request", "content must be a string");
      if (
        !i.expected ||
        typeof i.expected.mtimeMs !== "number" ||
        typeof i.expected.size !== "number"
      ) {
        return errorPayload(
          "bad-request",
          "expected {mtimeMs,size} is required",
        );
      }
      return await control.fsWrite(i.workspace, i.path, i.content, i.expected);
    }
    case MSG.sessionModelGet: {
      const input = parseControlPayload(MSG.sessionModelGet, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.sessionModelGet}: malformed payload`,
        );
      if (!input.sessionAlias)
        return errorPayload("bad-request", "sessionAlias is required");
      return await control.getSessionModel(input.chatKey, input.sessionAlias); // ≅ SessionModelResult
    }
    case MSG.sessionModelSet: {
      const input = parseControlPayload(MSG.sessionModelSet, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.sessionModelSet}: malformed payload`,
        );
      if (!input.sessionAlias || !input.modelId)
        return errorPayload(
          "bad-request",
          "sessionAlias and modelId are required",
        );
      const result =
        deadlineAt === undefined
          ? await control.setSessionModel(
              input.chatKey,
              input.sessionAlias,
              input.modelId,
            )
          : await control.setSessionModel(
              input.chatKey,
              input.sessionAlias,
              input.modelId,
              { deadlineAt },
            );
      return { ok: result.applied, current: result.current ?? null };
    }
    case MSG.sessionEffortGet: {
      const input = parseControlPayload(MSG.sessionEffortGet, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.sessionEffortGet}: malformed payload`,
        );
      if (!input.sessionAlias)
        return errorPayload("bad-request", "sessionAlias is required");
      return await control.getSessionEffort(input.chatKey, input.sessionAlias);
    }
    case MSG.sessionEffortSet: {
      const input = parseControlPayload(MSG.sessionEffortSet, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.sessionEffortSet}: malformed payload`,
        );
      if (!input.sessionAlias || !input.effort)
        return errorPayload(
          "bad-request",
          "sessionAlias and effort are required",
        );
      const result = await control.setSessionEffort(
        input.chatKey,
        input.sessionAlias,
        input.effort,
      );
      return { ok: result.applied, current: result.current ?? null };
    }
    case MSG.terminalCreate: {
      const input = parseControlPayload(MSG.terminalCreate, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.terminalCreate}: malformed payload`,
        );
      if (!input.sessionAlias)
        return errorPayload("bad-request", "sessionAlias is required");
      return await control.createTerminal(
        input.chatKey,
        input.sessionAlias,
        input.cols ?? 80,
        input.rows ?? 24,
      );
    }
    case MSG.terminalAttach: {
      const input = parseControlPayload(MSG.terminalAttach, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.terminalAttach}: malformed payload`,
        );
      if (!input.terminalId)
        return errorPayload("bad-request", "terminalId is required");
      return control.attachTerminal(input.terminalId);
    }
    case MSG.agentMessageDeliver: {
      const input = payload as AgentMessageDeliverPayload | undefined;
      if (
        !input ||
        typeof input !== "object" ||
        !input.targetEndpointId ||
        !input.content
      ) {
        return errorPayload(
          "invalid-payload",
          `${MSG.agentMessageDeliver}: malformed payload`,
        );
      }
      if (
        "deliverAgentMessage" in control &&
        typeof (
          control as unknown as {
            deliverAgentMessage: (i: unknown) => Promise<unknown>;
          }
        ).deliverAgentMessage === "function"
      ) {
        return await (
          control as unknown as {
            deliverAgentMessage: (i: unknown) => Promise<unknown>;
          }
        ).deliverAgentMessage(input);
      }
      return errorPayload(
        "ROUTE_UNAVAILABLE",
        "Remote agent message delivery is not implemented in this connector runtime",
      );
    }
    case MSG.upload: {
      const input = parseControlPayload(MSG.upload, payload);
      if (!input)
        return errorPayload(
          "invalid-payload",
          `${MSG.upload}: malformed payload`,
        );
      if (!input.filename || !input.content || !input.mimeType) {
        return errorPayload(
          "bad-request",
          "filename, content and mimeType are required",
        );
      }
      return await control.uploadFile(input);
    }
    default:
      return errorPayload(
        "unknown-type",
        `unsupported rpc type: ${envelope.type}`,
      );
  }
}

// Map recovered native-session history (neutral core shape) to wire rows. User turns
// become plain `in` rows; agent turns carry the ordered transcript (text / reasoning /
// tool) plus the flat fallbacks, reusing the same tool-step presentation as live turns.
function historyMessagesToRows(
  messages: Extract<
    Parameters<Parameters<ControlService["events"]["subscribe"]>[0]>[0],
    { type: "session-history" }
  >["messages"],
): SessionHistoryRowDto[] {
  return messages.map((m) => {
    if (m.role === "user") return { direction: "in", text: m.text };
    const parts: NonNullable<SessionHistoryRowDto["structured"]>["parts"] = [];
    const toolSteps: NonNullable<
      SessionHistoryRowDto["structured"]
    >["toolSteps"] = [];
    const reasoningChunks: string[] = [];
    for (const p of m.parts ?? []) {
      if (p.kind === "text") parts!.push({ type: "text", text: p.text });
      // Skip blank reasoning parts so an imported native session never seeds an empty
      // reasoning block (same invariant the live-turn path enforces in relay/server.ts).
      else if (p.kind === "reasoning") {
        if (!p.text.trim()) continue;
        parts!.push({ type: "reasoning", text: p.text });
        reasoningChunks.push(p.text);
      } else if (p.kind === "tool") {
        const step = toolUseEventToStepDto(p.tool);
        parts!.push({ type: "tool", step });
        toolSteps!.push(step);
      }
    }
    const hasStructured =
      toolSteps!.length > 0 || reasoningChunks.length > 0 || parts!.length > 0;
    const structured = hasStructured
      ? {
          ...(toolSteps!.length ? { toolSteps } : {}),
          ...(reasoningChunks.length
            ? { reasoning: reasoningChunks.join("\n") }
            : {}),
          ...(parts!.length ? { parts } : {}),
        }
      : undefined;
    return {
      direction: "out" as const,
      text: m.text,
      ...(structured ? { structured } : {}),
    };
  });
}

/** Routes hub→connector downward terminal event frames to the ControlService. Fire-and-forget. */
export function dispatchControlEvent(
  control: ControlService,
  envelope: RelayEnvelope,
): void {
  const p = (envelope.payload ?? {}) as {
    terminalId?: string;
    data?: string;
    cols?: number;
    rows?: number;
  };
  if (!p.terminalId) return;
  switch (envelope.type) {
    case MSG.terminalInput:
      if (typeof p.data === "string")
        control.writeTerminal(p.terminalId, p.data);
      return;
    case MSG.terminalResize:
      if (typeof p.cols === "number" && typeof p.rows === "number")
        control.resizeTerminal(p.terminalId, p.cols, p.rows);
      return;
    case MSG.terminalClose:
      control.closeTerminal(p.terminalId);
      return;
    default:
      return;
  }
}

export function subscribeControlEvents(
  control: ControlService,
  sendEvent: (type: string, payload: unknown) => void,
): () => void {
  return control.events.subscribe((event) => {
    if (event.type === "tool-event") {
      sendEvent(MSG.instanceEvent, {
        event: {
          type: "tool-event",
          chatKey: event.chatKey,
          sessionAlias: event.sessionAlias,
          step: toolUseEventToStepDto(event.event),
        },
      });
      return;
    }
    if (event.type === "session-history") {
      sendEvent(MSG.instanceEvent, {
        event: {
          type: "session-history",
          chatKey: event.chatKey,
          sessionAlias: event.sessionAlias,
          messages: historyMessagesToRows(event.messages),
        },
      });
      return;
    }
    sendEvent(MSG.instanceEvent, { event });
  });
}
