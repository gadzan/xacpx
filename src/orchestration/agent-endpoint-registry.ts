import type { AppState, LogicalSession } from "../state/types";
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
} from "./agent-messaging-types";
import type { WorkerBindingRecord } from "./orchestration-types";

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
      this.remoteEndpoints.set(nodeId, endpoints);
    }
  }

  syncRemoteDirectorySnapshot(
    endpoints: Array<{
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
          agent: ep.agent,
          state: ep.state,
          capabilities: ep.capabilities,
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
    const state = await this.deps.loadState();
    return this.listCandidates(state, "*")
      .filter((candidate) => candidate.endpoint.state !== "unreachable")
      .map((candidate) => ({
        nodeId: candidate.endpoint.address.nodeId,
        endpointId: candidate.endpoint.address.endpointId,
        agent: candidate.endpoint.agent,
        state: candidate.endpoint.state === "running" ? "running" : "idle",
        capabilities: candidate.endpoint.capabilities,
        ...(candidate.endpoint.displayName
          ? { displayName: candidate.endpoint.displayName }
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
          coordinatorSession,
          receive: false,
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
  private listCandidates(
    state: AppState,
    coordinatorSession: string,
  ): ResolvedAgentEndpoint[] {
    const candidates: ResolvedAgentEndpoint[] = [];
    const all = coordinatorSession === "*";
    if (all) {
      for (const logical of Object.values(state.sessions)) {
        candidates.push({
          endpoint: this.toLogicalEndpoint(logical),
          runtime: {
            kind: "logical",
            alias: logical.alias,
            transportSession: logical.transport_session,
          },
        });
      }
    } else {
      const logical = findLogicalSession(state, coordinatorSession);
      if (logical) {
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
      candidates.push({
        endpoint: {
          address: { nodeId: this.deps.nodeId, endpointId },
          handle: encodeAgentHandle({ nodeId: this.deps.nodeId, endpointId }),
          node: this.deps.nodeId,
          agent: worker.targetAgent,
          workspace: worker.workspace,
          state: hasRunningWorkerTask(state, workerSession)
            ? "running"
            : "idle",
          capabilities: queueOnlyCapabilities(),
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
    return {
      address,
      handle: encodeAgentHandle(address),
      node: this.deps.nodeId,
      agent: session.agent,
      workspace: session.workspace,
      ...(session.display_name ? { displayName: session.display_name } : {}),
      state: "idle",
      capabilities: queueOnlyCapabilities(),
    };
  }
}

function findLogicalSession(
  state: AppState,
  coordinatorSession: string,
): LogicalSession | undefined {
  return Object.values(state.sessions)
    .filter((session) =>
      sameCoordinatorSession(session.transport_session, coordinatorSession),
    )
    .sort((left, right) => left.alias.localeCompare(right.alias))[0];
}

function hasRunningWorkerTask(state: AppState, workerSession: string): boolean {
  return Object.values(state.orchestration.tasks).some(
    (task) => task.workerSession === workerSession && task.status === "running",
  );
}

function queueOnlyCapabilities(): AgentCapabilities {
  return {
    receive: true,
    steer: false,
    queue: true,
    interrupt: false,
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
