import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { BotRuntimeManager } from "../bots/bot-runtime-manager";
import { BotService } from "../bots/bot-service";
import type { AppConfig } from "../config/types";
import { ConversationError } from "./conversation-error";
import type { ConversationExecutionPort } from "./conversation-execution-port";
import type { ConversationProductEventSink } from "./conversation-product-events";
import { resolveRuntimeDirFromConfigPath } from "../daemon/daemon-files";
import type { AsyncMutex } from "../orchestration/async-mutex";
import { createStrictOwnedSessionRelease, type ReleaseOwnedSession } from "../sessions/owned-session-release";
import type { SessionService } from "../sessions/session-service";
import type { StateStore } from "../state/state-store";
import type { AppState } from "../state/types";
import type { SessionTransport } from "../transport/types";
import { ConversationDispatcher, type LeaseScheduler } from "./conversation-dispatcher";
import { conversationExecutionOrigin } from "./conversation-execution";
import { bindRouter } from "./conversation-router-gate";
import { ConversationRouterEngine } from "./conversation-router-engine";
import { ConversationRunService } from "./conversation-run-service";
import { ControlConversationTurnRunner } from "./conversation-turn-runner";
import { SqliteConversationStore } from "./sqlite-conversation-store";
import { GroupHandoffService } from "./group-handoff";
import { ConversationBindingService } from "./conversation-bindings";
import { ConversationWorktreeManager } from "./conversation-worktree-manager";
import { WorktreeIntegrationService } from "./worktree-integration-service";

export function resolveConversationStorePath(configPath: string): string {
  return join(resolveRuntimeDirFromConfigPath(configPath), "conversations.sqlite");
}

export interface ConversationRuntime {
  worktrees: ConversationWorktreeManager;
  integrations: WorktreeIntegrationService;
  store: SqliteConversationStore;
  bots: BotService;
  botRuntime: BotRuntimeManager;
  dispatcher: ConversationDispatcher;
  runs: ConversationRunService;
  handoffs: GroupHandoffService;
  bindings: ConversationBindingService;
  authorityEpoch: string;
  kick(): Promise<void>;
  /**
   * Start durable consume after this process holds the daemon consumer lock.
   * `buildApp` constructs the runtime; it must not recover or drain work.
   */
  activateAfterConsumerLock(): Promise<void>;
  /** Fail-closed gate for all public Bot/Conversation Control mutations (and reads). */
  assertOpen(): void;
  /** Lease one public Bot/Conversation mutation until it returns. Shutdown waits. */
  withOperation<T>(fn: () => Promise<T>): Promise<T>;
  shutdown(): Promise<void>;
}

export interface CreateConversationRuntimeInput {
  config: Pick<AppConfig, "agents" | "workspaces"> & Partial<Pick<AppConfig, "channel" | "channels">>;
  state: AppState;
  stateStore: Pick<StateStore, "save"> & { saveNow?: (state: AppState) => Promise<void> };
  sessions: SessionService;
  /** Core-private Conversation execution port — never the public Control facade. */
  control: ConversationExecutionPort;
  sqlitePath: string;
  releaseOwnedSession: ReleaseOwnedSession;
  onProductEvent?: ConversationProductEventSink;
  /** First fatal lease or background scheduling error. `undefined` is a real value. */
  onSchedulingFailure?: (error: unknown) => void;
  authorityEpoch?: string;
  ownerId?: string;
  autoKick?: boolean;
  /**
   * PR8 stateless automatic Router. Only an implementation that proves its
   * capability restriction before execution is accepted; anything else
   * (including a permissive default) leaves automatic mode unsupported.
   */
  router?: unknown;
  /** Engine-enforced decision deadline; adapters cannot disable it. */
  routerDecisionTimeoutMs?: number;
  /**
   * Daemon-wide AppState COW mutex. Must be the same instance passed to
   * SessionService / Orchestration. Do not invent a Conversation-only mutex.
   */
  stateMutex?: AsyncMutex;
  now?: () => Date;
  leaseMs?: number;
  leaseScheduler?: LeaseScheduler;
  /** Test seam: throw once from inside a live lease renewal transaction. */
  beforeLeaseRenewal?: () => void;
  /** Test seam forwarded to ConversationRunService. Production leaves it unset. */
  beforeAcceptPersist?: () => Promise<void>;
  afterTeardownMarkedDeleting?: () => Promise<void>;
  beforeTeardownFinalize?: () => Promise<void>;
}

export async function createConversationRuntime(
  input: CreateConversationRuntimeInput,
): Promise<ConversationRuntime> {
  const store = await SqliteConversationStore.open(input.sqlitePath, {
    ...(input.beforeLeaseRenewal ? { beforeLeaseRenewal: input.beforeLeaseRenewal } : {}),
  });
  const shared = {
    ...(input.stateMutex ? { stateMutex: input.stateMutex } : {}),
    ...(input.now ? { now: input.now } : {}),
  };
  const worktrees = new ConversationWorktreeManager(store.worktrees, resolve(dirname(input.sqlitePath), "..", "worktrees", "conversations"), input.config);
  input.sessions.setConversationWorktreeResolver?.(session => worktrees.resolveSessionCwd(session));
  const bots = new BotService(input.config, input.state, input.stateStore, shared);
  const productSinkRef: ConversationProductEventSink | undefined = input.onProductEvent;
  const botRuntime = new BotRuntimeManager(bots, input.sessions, input.state, input.stateStore, {
    releaseOwnedSession: input.releaseOwnedSession,
    onRuntimeMaterialized: () => {
      // Actual binding/session publish is the ground truth for Bot
      // lifecycle: execution-start may never follow (cancel in the
      // materialize/start window), so converge Web clients immediately via
      // the catalog channel instead of waiting for member-turn-started.
      try {
        productSinkRef?.({ type: "bots-changed" });
      } catch {
        // Product projection must not affect dispatch fencing.
      }
    },
    ...shared,
  });
  const execution: ConversationExecutionPort = {
    promptImmediate: (promptInput) => input.control.promptImmediate(promptInput),
    cancelTurnForPromptRequest: (...args) => input.control.cancelTurnForPromptRequest(...args),
    inspectPromptRequest: (...args) => input.control.inspectPromptRequest(...args),
    cancelQueuedConversationItem: (...args) => input.control.cancelQueuedConversationItem(...args),
  };
  const runner = new ControlConversationTurnRunner(execution);
  let runsRef: ConversationRunService | undefined;
  bots.setReenabledHook(() => {
    // A Bot that flips back to enabled may have durable pending work that a
    // disabled-period drain released back to pending. Wake via the
    // activation-aware seam so an unavailable consumer (initial recovery
    // failure) stays parked instead of draining through a direct kick.
    runsRef?.wakePendingWork();
  });
  // PR8 automatic Router. Built ONLY from a capability-provable implementation
  // supplied by the wire-in: an absent router leaves `automatic` targets
  // unsupported (`automatic_unsupported`), which preserves PR7 behavior for
  // every deployment that has not opted in. `bindRouter` refuses any object
  // that cannot prove its restriction up front — never a permissive default.
  const router = bindRouter(input.router);
  const routerEngine = router
    ? new ConversationRouterEngine(router, {
      store,
      readGroup: (conversationId) => input.state.conversations[conversationId],
      readTopic: (conversationId, topicId) => {
        const topic = input.state.conversation_topics[topicId];
        return topic?.conversationId === conversationId ? topic : undefined;
      },
      readBot: (botId) => bots.getBot(botId),
      runLifecycleAll: (botIds, critical) => bots.runLifecycleAll(botIds, critical),
      now: input.now ?? (() => new Date()),
      decisionTimeoutMs: input.routerDecisionTimeoutMs,
    })
    : undefined;
  const dispatcher = new ConversationDispatcher(store, botRuntime, runner, input.sessions, {
    authorityEpoch: input.authorityEpoch ?? randomUUID(),
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    ...(input.onProductEvent ? { onProductEvent: input.onProductEvent } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.leaseMs !== undefined ? { leaseMs: input.leaseMs } : {}),
    ...(input.leaseScheduler ? { leaseScheduler: input.leaseScheduler } : {}),
  });
  dispatcher.setWorktreeManager(worktrees);
  // §14.3 late-result evidence: a provider settling after the cancel-settle
  // deadline sealed the Run must reach the store's indeterminate
  // reconciliation instead of being dropped. Wiring lives here (not in the
  // runner constructor) because the dispatcher owns the store.
  runner.setLateResultHandler((runInput, result) => {
    dispatcher.reconcileLateProviderResult(runInput, result);
  });
  const integrations = new WorktreeIntegrationService(worktrees, store, input.state, botRuntime, input.releaseOwnedSession);
  const runs = new ConversationRunService(
    store,
    bots,
    botRuntime,
    dispatcher,
    input.sessions,
    input.state,
    input.stateStore,
    {
      releaseOwnedSession: input.releaseOwnedSession,
      worktrees,
      beforeWorktreeCleanup: async (conversationId, topicId) => {
        await integrations.cleanupScope(conversationId, topicId);
      },
      autoKick: input.autoKick ?? true,
      ...(routerEngine ? { routerEngine } : {}),
      ...(input.onProductEvent ? { onProductEvent: input.onProductEvent } : {}),
      ...(input.onSchedulingFailure ? { onSchedulingFailure: input.onSchedulingFailure } : {}),
      ...(input.beforeAcceptPersist ? { beforeAcceptPersist: input.beforeAcceptPersist } : {}),
      ...(input.afterTeardownMarkedDeleting ? { afterTeardownMarkedDeleting: input.afterTeardownMarkedDeleting } : {}),
      ...(input.beforeTeardownFinalize ? { beforeTeardownFinalize: input.beforeTeardownFinalize } : {}),
      ...shared,
    },
  );
  runsRef = runs;
  const handoffs = new GroupHandoffService({ store, bots, state: input.state, now: input.now,
    onProductEvent: input.onProductEvent, wake: () => runs.wakePendingWork() });
  dispatcher.setHandoffService(handoffs);
  // PR8 automatic continuation: the dispatcher hands a settled automatic batch
  // back to the routing service, which owns the Router call and the durable
  // decision. Fire-and-forget from the dispatcher's perspective — routing never
  // blocks a dispatch settlement, and a duplicate kick is a no-op.
  dispatcher.setAutomaticRoutingHandler((runId) => {
    runs.trackAutomaticRouting(runId);
  });
  let lifecycle: "open" | "stopping" | "closed" = "open";
  let activeOps = 0;
  const idleWaiters: Array<() => void> = [];
  let shutdownWork: Promise<void> | undefined;
  const assertOpen = (): void => {
    if (lifecycle !== "open") {
      throw new ConversationError("runtime_closed", "conversation runtime is closed");
    }
  };
  const withOperation = async <T>(fn: () => Promise<T>): Promise<T> => {
    assertOpen();
    activeOps += 1;
    try {
      return await fn();
    } finally {
      activeOps -= 1;
      if (activeOps === 0 && idleWaiters.length > 0) {
        const waiters = idleWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
    }
  };
  const waitIdle = (): Promise<void> => {
    if (activeOps === 0) return Promise.resolve();
    return new Promise((resolve) => {
      idleWaiters.push(resolve);
    });
  };
  return {
    worktrees,
    integrations,
    store,
    bots,
    botRuntime,
    dispatcher,
    runs,
    handoffs,
    bindings: new ConversationBindingService(store, runs, bots, input.config),
    authorityEpoch: dispatcher.authorityEpoch,
    kick: () => dispatcher.kick(),
    activateAfterConsumerLock: () => runs.activateAfterConsumerLock(),
    assertOpen,
    withOperation,
    shutdown: () => {
      if (!shutdownWork) {
        shutdownWork = (async () => {
          if (lifecycle === "closed") {
            return;
          }
          lifecycle = "stopping";
          try {
            await waitIdle();
            bots.close();
            await runs.shutdown();
          } finally {
            // Entered operations and already-started executions retain their
            // capabilities until their drain; failed shutdown still revokes.
            handoffs.close();
            lifecycle = "closed";
          }
        })();
      }
      return shutdownWork;
    },
  };
}

export function createProductionOwnedSessionRelease(input: {
  sessions: SessionService;
  transport: Pick<SessionTransport, "releaseLogicalSession" | "deleteSession">;
}): ReleaseOwnedSession {
  return createStrictOwnedSessionRelease(input);
}
