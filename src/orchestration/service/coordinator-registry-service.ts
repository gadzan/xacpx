// src/orchestration/service/coordinator-registry-service.ts
// External-coordinator registration and coordinator route-context recording. The first
// service that takes a collaborator: registerExternalCoordinator consults the shared
// WorkerSessionManager's in-memory pending maps, so the facade must inject the same
// instance it already constructed rather than build a second one.
import { stableCoordinatorSession } from "../coordinator-identity";
import type {
  ExternalCoordinatorRecord,
  OrchestrationCoordinatorRouteContextRecord,
} from "../orchestration-types";
import type {
  OrchestrationServiceDeps,
  RegisterExternalCoordinatorInput,
} from "../orchestration-service";
import type { OrchestrationStateKernel } from "./orchestration-state-kernel";
import type { WorkerSessionManager } from "./worker-session-manager";

export type CoordinatorRegistryDeps = Pick<
  OrchestrationServiceDeps,
  "now" | "loadState" | "saveState" | "config"
>;

export class CoordinatorRegistryService {
  constructor(
    private readonly deps: CoordinatorRegistryDeps,
    private readonly kernel: OrchestrationStateKernel,
    private readonly workerSessions: WorkerSessionManager,
  ) {}

  async registerExternalCoordinator(input: RegisterExternalCoordinatorInput): Promise<ExternalCoordinatorRecord> {
    const coordinatorSession = input.coordinatorSession.trim();
    const workspace = input.workspace?.trim();
    const defaultTargetAgent = input.defaultTargetAgent?.trim();

    if (!coordinatorSession) {
      throw new Error("coordinatorSession must be a non-empty string");
    }
    if (workspace && !this.deps.config.workspaces[workspace]) {
      throw new Error(`workspace "${workspace}" is not configured`);
    }

    return await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const externalCoordinators = this.kernel.ensureExternalCoordinators(state);
      const existing = externalCoordinators[coordinatorSession];
      if (this.workerSessions.hasPendingWorkerSession(coordinatorSession)) {
        throw new Error(`coordinatorSession "${coordinatorSession}" conflicts with an existing worker session`);
      }
      if (state.orchestration.workerBindings[coordinatorSession]) {
        throw new Error(`coordinatorSession "${coordinatorSession}" conflicts with an existing worker session`);
      }
      if (this.workerSessions.hasActiveTaskWorkerSession(state, coordinatorSession)) {
        throw new Error(`coordinatorSession "${coordinatorSession}" conflicts with an existing worker session`);
      }
      if (this.workerSessions.hasPendingLogicalTransportSession(coordinatorSession)) {
        throw new Error(`coordinatorSession "${coordinatorSession}" conflicts with an existing logical session`);
      }
      if (Object.values(state.sessions).some((session) => session.transport_session === coordinatorSession)) {
        throw new Error(`coordinatorSession "${coordinatorSession}" conflicts with an existing logical session`);
      }
      if (existing?.workspace && workspace && existing.workspace !== workspace) {
        throw new Error(
          `coordinatorSession "${coordinatorSession}" is already bound to workspace "${existing.workspace}"; use a new coordinator session for workspace "${workspace}"`,
        );
      }
      const now = this.deps.now().toISOString();
      const effectiveDefaultTargetAgent = defaultTargetAgent || existing?.defaultTargetAgent;
      const record: ExternalCoordinatorRecord = {
        coordinatorSession,
        ...(workspace ? { workspace } : existing?.workspace ? { workspace: existing.workspace } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(effectiveDefaultTargetAgent ? { defaultTargetAgent: effectiveDefaultTargetAgent } : {}),
      };

      externalCoordinators[coordinatorSession] = record;
      await this.deps.saveState(state);
      return { ...record };
    });
  }

  async recordCoordinatorRouteContext(input: {
    coordinatorSession: string;
    chatKey: string;
    sessionAlias?: string;
    accountId?: string;
    replyContextToken?: string;
    channel?: string;
    chatType?: "direct" | "group";
    senderId?: string;
    senderName?: string;
    groupId?: string;
    isOwner?: boolean;
  }): Promise<OrchestrationCoordinatorRouteContextRecord> {
    if (input.coordinatorSession.trim().length === 0) {
      throw new Error("coordinatorSession must be a non-empty string");
    }
    if (input.chatKey.trim().length === 0) {
      throw new Error("chatKey must be a non-empty string");
    }

    return await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const now = this.deps.now().toISOString();
      // Key the route by the stable identity so a route recorded before `/clear`
      // is still found when the coordinator resumes under its rotated transport.
      const routeKey = stableCoordinatorSession(input.coordinatorSession);
      const existing = this.kernel.ensureCoordinatorRoutes(state)[routeKey];
      const sameChat = existing?.chatKey === input.chatKey;
      const hasAccountId = input.accountId !== undefined;
      const hasReplyContextToken = input.replyContextToken !== undefined;
      const hasCompleteReplyRoute = hasAccountId && hasReplyContextToken;
      const shouldPreserveExistingReplyRoute =
        !hasAccountId &&
        !hasReplyContextToken &&
        sameChat;
      const replyRoute =
        hasCompleteReplyRoute
          ? {
              accountId: input.accountId,
              replyContextToken: input.replyContextToken,
            }
          : shouldPreserveExistingReplyRoute && existing?.accountId && existing?.replyContextToken
            ? {
                accountId: existing.accountId,
                replyContextToken: existing.replyContextToken,
              }
            : undefined;
      const route: OrchestrationCoordinatorRouteContextRecord = {
        coordinatorSession: routeKey,
        chatKey: input.chatKey,
        ...(input.sessionAlias ? { sessionAlias: input.sessionAlias } : {}),
        ...(replyRoute ? replyRoute : {}),
        ...buildCoordinatorRouteChatMetadata(input, sameChat ? existing : undefined),
        updatedAt: now,
      };
      this.kernel.ensureCoordinatorRoutes(state)[routeKey] = route;
      await this.deps.saveState(state);
      return { ...route };
    });
  }
}

function buildCoordinatorRouteChatMetadata(
  input: {
    channel?: string;
    chatType?: "direct" | "group";
    senderId?: string;
    senderName?: string;
    groupId?: string;
    isOwner?: boolean;
  },
  existing?: OrchestrationCoordinatorRouteContextRecord,
): Pick<
  OrchestrationCoordinatorRouteContextRecord,
  "channel" | "chatType" | "senderId" | "senderName" | "groupId" | "isOwner"
> {
  const channel = input.channel ?? existing?.channel;
  const chatType = input.chatType ?? existing?.chatType;
  const senderId = input.senderId ?? existing?.senderId;
  const senderName = input.senderName ?? existing?.senderName;
  const groupId = input.groupId ?? existing?.groupId;
  const isOwner = input.isOwner ?? existing?.isOwner;
  return {
    ...(channel !== undefined ? { channel } : {}),
    ...(chatType !== undefined ? { chatType } : {}),
    ...(senderId !== undefined ? { senderId } : {}),
    ...(senderName !== undefined ? { senderName } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
    ...(isOwner !== undefined ? { isOwner } : {}),
  };
}
