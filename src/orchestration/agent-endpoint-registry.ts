import type { AppState, LogicalSession } from "../state/types";
import { getChannelIdFromChatKey, toDisplaySessionAlias } from "../channels/channel-scope";
import {
  sameCoordinatorSession,
  stableCoordinatorSession,
} from "./coordinator-identity";
import { AgentMessagingError } from "./agent-messaging-error";
import { decodeAgentHandle, encodeAgentHandle } from "./agent-handle";
import type {
  AgentAddress,
  AgentCapabilities,
  AgentEndpointView,
  AgentSenderBinding,
  AgentTargetSelector,
} from "./agent-messaging-types";
import {
  isAttentionRequiredTask,
  type WorkerBindingRecord,
} from "./orchestration-types";
import type { AgentActivityView } from "./agent-messaging-types";

type EndpointRuntime =
  | {
      kind: "logical";
      alias: string;
      transportSession: string;
    }
  | {
      kind: "worker";
      workerSession: string;
      binding: WorkerBindingRecord;
    }
  | {
      kind: "remote";
    };
export interface ResolvedAgentIdentity {
  address: AgentAddress;
  coordinatorSession: string;
  receive: boolean;
  /** Runtime kind of the sender — completion requests are logical-sender-only. */
  senderKind: "logical" | "worker" | "external";
  sessionAlias?: string;
  displayName?: string;
  agent?: string;
  workspace?: string;
}

export interface ResolvedAgentEndpoint {
  endpoint: AgentEndpointView;
  runtime: EndpointRuntime;
}

export class AgentEndpointRegistry {
  private readonly remoteEndpoints = new Map<string, AgentEndpointView[]>();

  constructor(
    private readonly deps: {
      nodeId: string;
      loadState: () => Promise<AppState>;
      isSessionActive?: (internalAlias: string) => boolean;
    },
  ) {}
  updateRemoteEndpoints(nodeId: string, endpoints: AgentEndpointView[]): void {
    if (nodeId === "*") {
      this.remoteEndpoints.clear();
      return;
    }
    if (endpoints.length === 0) {
      this.remoteEndpoints.delete(nodeId);
    } else {
      this.remoteEndpoints.set(
        nodeId,
        endpoints.map((ep) => ({
          ...ep,
          capabilities: {
            ...ep.capabilities,
            conversation: ep.capabilities.conversation ?? false,
            completion: ep.capabilities.completion ?? false,
          },
        })),
      );
    }
  }

  syncRemoteDirectorySnapshot(
    endpoints: Array<{
      nodeId: string;
      endpointId: string;
      displayName?: string;
      sessionAlias?: string;
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
        completion?: boolean;
      };
      /** Remote-published presentation context, preserved verbatim — never synthesized. */
      endpointKind?: "logical" | "worker";
      channelId?: string;
    }>,
  ): void {
    const byNode = new Map<string, AgentEndpointView[]>();
    for (const ep of endpoints) {
      if (ep.nodeId !== this.deps.nodeId) {
        const list = byNode.get(ep.nodeId) ?? [];
        list.push({
          address: { nodeId: ep.nodeId, endpointId: ep.endpointId },
          handle: encodeAgentHandle({
            nodeId: ep.nodeId,
            endpointId: ep.endpointId,
          }),
          node: ep.displayName ?? ep.nodeId,
          displayName: ep.displayName,
          sessionAlias: ep.sessionAlias,
          agent: ep.agent,
          workspace: ep.workspace,
          state: ep.state,
          activity: ep.activity ?? {
            status: ep.state === "running" ? "working" : "idle",
          },
          capabilities: {
            ...ep.capabilities,
            conversation: ep.capabilities.conversation ?? false,
            completion: ep.capabilities.completion ?? false,
          },
          // Preserve remote context fields exactly as published (absent stays absent).
          ...(ep.endpointKind ? { endpointKind: ep.endpointKind } : {}),
          ...(ep.channelId ? { channelId: ep.channelId } : {}),
        });
        byNode.set(ep.nodeId, list);
      }
    }
    this.remoteEndpoints.clear();
    for (const [nodeId, list] of byNode) {
      this.remoteEndpoints.set(nodeId, list);
    }
  }

  async getPublishedEndpoints(): Promise<
    Array<{
      nodeId: string;
      endpointId: string;
      displayName?: string;
      sessionAlias?: string;
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
      labels?: string[];
      /** Endpoint context for presentation ranking (see PublishedAgentEndpointDto). */
      endpointKind?: "logical" | "worker";
      /** Source channel namespace owning the endpoint when known. */
      channelId?: string;
      updatedAt: number;
    }>
  > {
    const state = await this.deps.loadState();
    return this.listCandidates(state, "*")
      .filter((candidate) => candidate.endpoint.state !== "unreachable")
      .map((candidate) => ({
        nodeId: candidate.endpoint.address.nodeId,
        endpointId: candidate.endpoint.address.endpointId,
        agent: candidate.endpoint.agent,
        workspace: candidate.endpoint.workspace,
        state: candidate.endpoint.state === "running" ? "running" : "idle",
        activity: candidate.endpoint.activity,
        capabilities: candidate.endpoint.capabilities,
        ...(candidate.endpoint.displayName
          ? { displayName: candidate.endpoint.displayName }
          : {}),
        ...(candidate.endpoint.sessionAlias
          ? { sessionAlias: candidate.endpoint.sessionAlias }
          : {}),
        ...(candidate.endpoint.endpointKind
          ? { endpointKind: candidate.endpoint.endpointKind }
          : {}),
        ...(candidate.endpoint.channelId
          ? { channelId: candidate.endpoint.channelId }
          : {}),
        updatedAt: Date.now(),
      }));
  }
  async resolveSender(
    binding: AgentSenderBinding,
  ): Promise<ResolvedAgentIdentity> {
    const state = await this.deps.loadState();
    const coordinatorSession = stableCoordinatorSession(
      binding.coordinatorSession,
    );
    const sourceHandle = binding.sourceHandle?.trim();

    if (sourceHandle) {
      const worker = state.orchestration.workerBindings[sourceHandle];
      if (worker) {
        if (
          !sameCoordinatorSession(worker.coordinatorSession, coordinatorSession)
        ) {
          throw notReachable();
        }
        const endpointId = requireEndpointId(worker.agentEndpointId);
        return {
          address: { nodeId: this.deps.nodeId, endpointId },
          coordinatorSession,
          receive: true,
          senderKind: "worker",
          sessionAlias: sourceHandle,
          displayName: worker.role || worker.targetAgent,
          agent: worker.targetAgent,
          workspace: worker.workspace,
        };
      }
      const external =
        state.orchestration.externalCoordinators[coordinatorSession];
      if (external && sourceHandle === coordinatorSession) {
        return {
          address: {
            nodeId: this.deps.nodeId,
            endpointId: requireEndpointId(external.agentEndpointId),
          },
          receive: false,
          senderKind: "external",
          coordinatorSession,
          sessionAlias: coordinatorSession,
        };
      }

      throw new AgentMessagingError(
        "DELIVERY_DENIED",
        "The sender source handle is unknown or no longer active.",
      );
    }

    const logical = findLogicalSession(state, coordinatorSession);
    if (logical) {
      return {
        address: {
          nodeId: this.deps.nodeId,
          endpointId: logical.logical_session_id,
        },
        coordinatorSession,
        receive: true,
        senderKind: "logical",
        sessionAlias: logical.alias,
        displayName: logical.display_name || logical.alias,
        agent: logical.agent,
        workspace: logical.workspace,
      };
    }

    const external =
      state.orchestration.externalCoordinators[coordinatorSession];
    if (external) {
      return {
        address: {
          nodeId: this.deps.nodeId,
          endpointId: requireEndpointId(external.agentEndpointId),
        },
        coordinatorSession,
        receive: false,
        senderKind: "external",
        sessionAlias: coordinatorSession,
      };
    }

    throw new AgentMessagingError(
      "DELIVERY_DENIED",
      "The current MCP binding is not an authorized Agent Messaging sender.",
    );
  }

  async listReachable(
    binding: AgentSenderBinding,
  ): Promise<AgentEndpointView[]> {
    const sender = await this.resolveSender(binding);
    const state = await this.deps.loadState();
    const locals = this.listCandidates(state, sender.coordinatorSession)
      .filter(
        (candidate) => !sameAddress(candidate.endpoint.address, sender.address),
      )
      .map((candidate) => candidate.endpoint);
    const remotes: AgentEndpointView[] = [];
    for (const [nodeId, list] of this.remoteEndpoints) {
      if (nodeId !== this.deps.nodeId) {
        remotes.push(...list);
      }
    }
    return [...locals, ...remotes];
  }

  async resolveTarget(
    sender: ResolvedAgentIdentity,
    handle: string,
  ): Promise<ResolvedAgentEndpoint> {
    const address = decodeAgentHandle(handle);
    if (!address) {
      throw notReachable();
    }
    if (sameAddress(address, sender.address)) {
      throw new AgentMessagingError(
        "SELF_MESSAGE_NOT_ALLOWED",
        "Sending a peer message to the current Agent endpoint is not allowed.",
      );
    }

    if (address.nodeId !== this.deps.nodeId) {
      const remoteList = this.remoteEndpoints.get(address.nodeId);
      if (!remoteList) {
        throw new AgentMessagingError(
          "ROUTE_UNAVAILABLE",
          "The target belongs to another messaging node and no remote route is configured.",
        );
      }
      const match = remoteList.find(
        (e) => e.address.endpointId === address.endpointId,
      );
      if (match) {
        return {
          endpoint: match,
          runtime: { kind: "remote" as const },
        };
      }
      throw notReachable();
    }

    const state = await this.deps.loadState();
    const target = this.listCandidates(state, sender.coordinatorSession).find(
      (candidate) => sameAddress(candidate.endpoint.address, address),
    );
    if (!target) {
      throw notReachable();
    }
    return target;
  }
  async resolveTargetByHandle(
    handle: string,
  ): Promise<AgentEndpointView | null> {
    const address = decodeAgentHandle(handle);
    if (!address) {
      return null;
    }

    if (address.nodeId !== this.deps.nodeId) {
      const remoteList = this.remoteEndpoints.get(address.nodeId);
      if (!remoteList) {
        return null;
      }
      const match = remoteList.find(
        (e) => e.address.endpointId === address.endpointId,
      );
      return match ?? null;
    }

    const state = await this.deps.loadState();
    const target = this.listCandidates(state, "*").find((candidate) =>
      sameAddress(candidate.endpoint.address, address),
    );
    return target?.endpoint ?? null;
  }
  async resolveSelector(
    sender: AgentSenderBinding | ResolvedAgentIdentity,
    selector: AgentTargetSelector,
  ): Promise<ResolvedAgentEndpoint> {
    const senderIdentity =
      "address" in sender ? sender : await this.resolveSender(sender);

    const state = await this.deps.loadState();
    const localCandidates = this.listCandidates(
      state,
      senderIdentity.coordinatorSession,
    ).filter(
      (candidate) =>
        !sameAddress(candidate.endpoint.address, senderIdentity.address),
    );

    const remoteCandidates: ResolvedAgentEndpoint[] = [];
    for (const [nodeId, list] of this.remoteEndpoints) {
      if (nodeId !== this.deps.nodeId) {
        for (const endpoint of list) {
          remoteCandidates.push({
            endpoint,
            runtime: { kind: "remote" as const },
          });
        }
      }
    }

    const candidates = [...localCandidates, ...remoteCandidates];

    const displayNameFilter = selector.displayName?.trim().toLowerCase();
    const workspaceFilter = selector.workspace?.trim().toLowerCase();
    const agentFilter = selector.agent?.trim().toLowerCase();

    if (!displayNameFilter && !workspaceFilter && !agentFilter) {
      throw new AgentMessagingError(
        "TARGET_NOT_FOUND",
        "Target selector must specify at least one criterion (displayName, workspace, or agent).",
      );
    }
    const matches = candidates.filter((candidate) => {
      if (displayNameFilter) {
        const candDisplayName = candidate.endpoint.displayName
          ?.trim()
          .toLowerCase();
        const candAlias =
          candidate.endpoint.sessionAlias?.trim().toLowerCase() ??
          (candidate.runtime.kind === "logical"
            ? candidate.runtime.alias?.trim().toLowerCase()
            : undefined);
        if (
          candDisplayName !== displayNameFilter &&
          candAlias !== displayNameFilter
        ) {
          return false;
        }
      }
      if (workspaceFilter) {
        const candWorkspace = candidate.endpoint.workspace
          ?.trim()
          .toLowerCase();
        if (candWorkspace !== workspaceFilter) {
          return false;
        }
      }
      if (agentFilter) {
        const candAgent = candidate.endpoint.agent?.trim().toLowerCase();
        if (candAgent !== agentFilter) {
          return false;
        }
      }
      return true;
    });

    if (matches.length === 0) {
      throw new AgentMessagingError(
        "TARGET_NOT_FOUND",
        `No reachable agent matched the provided selector: ${JSON.stringify(selector)}.`,
      );
    }

    if (matches.length === 1) {
      return matches[0]!;
    }

    const candidateList = matches
      .map(
        (m) =>
          `${m.endpoint.displayName ?? m.endpoint.agent} (${m.endpoint.handle})`,
      )
      .join(", ");
    throw new AgentMessagingError(
      "TARGET_AMBIGUOUS",
      `Target selector matched ${matches.length} candidate endpoints: ${candidateList}. Please use a more specific selector or exact handle.`,
    );
  }

  async resolveLocalTargetByEndpointId(
    endpointId: string,
  ): Promise<ResolvedAgentEndpoint> {
    const state = await this.deps.loadState();
    const match = this.listCandidates(state, "*").find(
      (c) => c.endpoint.address.endpointId === endpointId,
    );
    if (!match) {
      throw new AgentMessagingError(
        "TARGET_NOT_FOUND",
        `Target endpoint ${endpointId} not found on local node.`,
      );
    }
    return match;
  }

  async findLocalSessionByEndpointId(
    endpointId: string,
  ): Promise<{ alias: string; archived: boolean; isLogical: boolean } | null> {
    const state = await this.deps.loadState();
    for (const session of Object.values(state.sessions)) {
      if (session.logical_session_id === endpointId) {
        return {
          alias: session.alias,
          archived: session.archived === true,
          isLogical: true,
        };
      }
    }
    for (const [workerSession, worker] of Object.entries(
      state.orchestration.workerBindings,
    )) {
      if (worker.agentEndpointId === endpointId) {
        return {
          alias: workerSession,
          archived: false,
          isLogical: false,
        };
      }
    }
    return null;
  }

  private listCandidates(
    state: AppState,
    coordinatorSession: string,
  ): ResolvedAgentEndpoint[] {
    const candidates: ResolvedAgentEndpoint[] = [];
    const all = coordinatorSession === "*";
    const isExternal = Boolean(
      !all && state.orchestration.externalCoordinators[coordinatorSession],
    );

    if (all || !isExternal) {
      for (const logical of Object.values(state.sessions)) {
        if (logical.archived === true) {
          continue;
        }
        candidates.push({
          endpoint: this.toLogicalEndpoint(logical),
          runtime: {
            kind: "logical",
            alias: logical.alias,
            transportSession: logical.transport_session,
          },
        });
      }
    }
    for (const [workerSession, worker] of Object.entries(
      state.orchestration.workerBindings,
    )) {
      if (
        !all &&
        !sameCoordinatorSession(worker.coordinatorSession, coordinatorSession)
      ) {
        continue;
      }
      const endpointId = worker.agentEndpointId;
      if (!endpointId) {
        continue;
      }
      const { state: workerState, activity } = deriveWorkerActivity(
        state,
        workerSession,
        worker.role,
      );
      const displayName = worker.role || worker.targetAgent;
      candidates.push({
        endpoint: {
          address: { nodeId: this.deps.nodeId, endpointId },
          handle: encodeAgentHandle({ nodeId: this.deps.nodeId, endpointId }),
          node: this.deps.nodeId,
          agent: worker.targetAgent,
          workspace: worker.workspace,
          displayName,
          state: workerState,
          activity,
          capabilities: queueOnlyCapabilities({ completion: false }),
          // Worker endpoints are channel-agnostic orchestration runtimes: no
          // authoritative channel fact exists, so channelId stays absent.
          endpointKind: "worker",
        },
        runtime: {
          kind: "worker",
          workerSession,
          binding: worker,
        },
      });
    }

    return candidates.sort((left, right) =>
      left.endpoint.handle.localeCompare(right.endpoint.handle),
    );
  }

  private toLogicalEndpoint(session: LogicalSession): AgentEndpointView {
    const address = {
      nodeId: this.deps.nodeId,
      endpointId: session.logical_session_id,
    };
    const sessionAlias = toDisplaySessionAlias(session.alias);
    const displayName = session.display_name || sessionAlias;
    const isRunning = this.deps.isSessionActive?.(session.alias) ?? false;
    return {
      address,
      handle: encodeAgentHandle(address),
      node: this.deps.nodeId,
      agent: session.agent,
      workspace: session.workspace,
      displayName,
      sessionAlias,
      state: isRunning ? "running" : "idle",
      activity: {
        status: isRunning ? "working" : "idle",
      },
      capabilities: queueOnlyCapabilities({ completion: true }),
      endpointKind: "logical",
      // Channel ownership is derived from the internal alias namespace (the
      // authoritative channel-scoping record) via the single-home helper in
      // channel-scope — same derivation as session-resource-catalog and
      // session-service. Never parse the display alias.
      channelId: getChannelIdFromChatKey(session.alias),
    };
  }
}

function deriveWorkerActivity(
  state: AppState,
  workerSession: string,
  role?: string,
): { state: "idle" | "running"; activity: AgentActivityView } {
  const activeTask = Object.values(state.orchestration.tasks).find(
    (task) =>
      task.workerSession === workerSession &&
      (task.status === "running" || isAttentionRequiredTask(task)),
  );
  if (!activeTask) {
    return {
      state: "idle",
      activity: {
        status: "idle",
        summary: role ? `Idle (${role})` : "Idle",
      },
    };
  }
  if (activeTask.status === "running") {
    const summary = sanitizePublishedActivity(activeTask.summary);
    return {
      state: "running",
      activity: {
        status: "working",
        ...(summary ? { summary } : {}),
      },
    };
  }
  return {
    state: "idle",
    activity: {
      status: "waiting",
      summary:
        activeTask.status === "needs_confirmation"
          ? "Waiting for confirmation"
          : "Waiting for question response",
    },
  };
}

function sanitizePublishedActivity(
  summary: string | undefined,
): string | undefined {
  if (!summary) return undefined;
  const cleaned = summary.replace(/[\r\n\t]+/g, " ").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > 80 ? cleaned.slice(0, 77) + "..." : cleaned;
}

function findLogicalSession(
  state: AppState,
  coordinatorSession: string,
): LogicalSession | undefined {
  return Object.values(state.sessions)
    .filter(
      (session) =>
        session.archived !== true &&
        sameCoordinatorSession(session.transport_session, coordinatorSession),
    )
    .sort((left, right) => left.alias.localeCompare(right.alias))[0];
}

function queueOnlyCapabilities(options?: { completion?: boolean }): AgentCapabilities {
  return {
    receive: true,
    steer: false,
    queue: true,
    interrupt: false,
    conversation: true,
    // v0.3: completion signals require the canonical TurnQueue/SessionTurnRunner
    // path (PeerTurnOrigin → turn-finished). Only logical sessions run on that
    // path — worker runtimes inject via transport.injectMessage and can never
    // produce a correlated terminal event, so they must not advertise completion.
    completion: options?.completion ?? false,
  };
}

function requireEndpointId(endpointId: string | undefined): string {
  if (!endpointId) {
    throw new AgentMessagingError(
      "TARGET_UNAVAILABLE",
      "The Agent endpoint is missing its persisted messaging identity.",
    );
  }
  return endpointId;
}

function sameAddress(left: AgentAddress, right: AgentAddress): boolean {
  return left.nodeId === right.nodeId && left.endpointId === right.endpointId;
}

function notReachable(): AgentMessagingError {
  return new AgentMessagingError(
    "TARGET_NOT_REACHABLE",
    "The target is not reachable from the current Agent Messaging scope.",
  );
}
