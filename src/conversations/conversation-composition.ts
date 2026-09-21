import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { BotRuntimeManager } from "../bots/bot-runtime-manager";
import { BotService } from "../bots/bot-service";
import type { AppConfig } from "../config/types";
import { ConversationError } from "./conversation-error";
import type { ConversationExecutionPort } from "./conversation-execution-port";
import { resolveRuntimeDirFromConfigPath } from "../daemon/daemon-files";
import type { AsyncMutex } from "../orchestration/async-mutex";
import { createStrictOwnedSessionRelease, type ReleaseOwnedSession } from "../sessions/owned-session-release";
import type { SessionService } from "../sessions/session-service";
import type { StateStore } from "../state/state-store";
import type { AppState } from "../state/types";
import type { SessionTransport } from "../transport/types";
import { ConversationDispatcher } from "./conversation-dispatcher";
import type { ConversationProductEventSink } from "./conversation-product-events";
import { ConversationRunService } from "./conversation-run-service";
import { ControlConversationTurnRunner } from "./conversation-turn-runner";
import { SqliteConversationStore } from "./sqlite-conversation-store";

export function resolveConversationStorePath(configPath: string): string {
  return join(resolveRuntimeDirFromConfigPath(configPath), "conversations.sqlite");
}

export interface ConversationRuntime {
  store: SqliteConversationStore;
  bots: BotService;
  botRuntime: BotRuntimeManager;
  dispatcher: ConversationDispatcher;
  runs: ConversationRunService;
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
  config: Pick<AppConfig, "agents" | "workspaces">;
  state: AppState;
  stateStore: Pick<StateStore, "save"> & { saveNow?: (state: AppState) => Promise<void> };
  sessions: SessionService;
  /** Core-private Conversation execution port — never the public Control facade. */
  control: ConversationExecutionPort;
  sqlitePath: string;
  releaseOwnedSession: ReleaseOwnedSession;
  onProductEvent?: ConversationProductEventSink;
  authorityEpoch?: string;
  ownerId?: string;
  autoKick?: boolean;
  /**
   * Daemon-wide AppState COW mutex. Must be the same instance passed to
   * SessionService / Orchestration. Do not invent a Conversation-only mutex.
   */
  stateMutex?: AsyncMutex;
  now?: () => Date;
}

export async function createConversationRuntime(
  input: CreateConversationRuntimeInput,
): Promise<ConversationRuntime> {
  const store = await SqliteConversationStore.open(input.sqlitePath);
  const shared = {
    ...(input.stateMutex ? { stateMutex: input.stateMutex } : {}),
    ...(input.now ? { now: input.now } : {}),
  };
  const bots = new BotService(input.config, input.state, input.stateStore, shared);
  const botRuntime = new BotRuntimeManager(bots, input.sessions, input.state, input.stateStore, {
    releaseOwnedSession: input.releaseOwnedSession,
    ...shared,
  });
  const execution: ConversationExecutionPort = {
    promptImmediate: (promptInput) => input.control.promptImmediate(promptInput),
    cancelTurnForPromptRequest: (...args) => input.control.cancelTurnForPromptRequest(...args),
    inspectPromptRequest: (...args) => input.control.inspectPromptRequest(...args),
    cancelQueuedConversationItem: (...args) => input.control.cancelQueuedConversationItem(...args),
  };
  const runner = new ControlConversationTurnRunner(execution);
  let dispatcherRef: ConversationDispatcher | undefined;
  bots.setReenabledHook(() => {
    // A Bot that flips back to enabled may have durable pending work that a
    // disabled-period drain released back to pending: wake the dispatcher so
    // the accepted Run resumes without requiring a second prompt.
    void dispatcherRef?.kick().catch(() => {});
  });
  const dispatcher = new ConversationDispatcher(store, botRuntime, runner, input.sessions, {
    authorityEpoch: input.authorityEpoch ?? randomUUID(),
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    ...(input.onProductEvent ? { onProductEvent: input.onProductEvent } : {}),
  });
  dispatcherRef = dispatcher;
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
      autoKick: input.autoKick ?? true,
      ...(input.onProductEvent ? { onProductEvent: input.onProductEvent } : {}),
      ...shared,
    },
  );
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
    store,
    bots,
    botRuntime,
    dispatcher,
    runs,
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
          await waitIdle();
          bots.close();
          await runs.shutdown();
          lifecycle = "closed";
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
