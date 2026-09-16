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
  /** Fail-closed gate for all public Bot/Conversation Control mutations (and reads). */
  assertOpen(): void;
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
  const dispatcher = new ConversationDispatcher(store, botRuntime, runner, input.sessions, {
    authorityEpoch: input.authorityEpoch ?? randomUUID(),
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    ...(input.onProductEvent ? { onProductEvent: input.onProductEvent } : {}),
  });
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
  const assertOpen = (): void => {
    if (lifecycle !== "open") {
      throw new ConversationError("runtime_closed", "conversation runtime is closed");
    }
  };
  return {
    store,
    bots,
    botRuntime,
    dispatcher,
    runs,
    authorityEpoch: dispatcher.authorityEpoch,
    kick: () => dispatcher.kick(),
    assertOpen,
    shutdown: async () => {
      if (lifecycle !== "open") {
        return;
      }
      lifecycle = "stopping";
      bots.close();
      await runs.shutdown();
      lifecycle = "closed";
    },
  };
}

export function createProductionOwnedSessionRelease(input: {
  sessions: SessionService;
  transport: Pick<SessionTransport, "releaseLogicalSession" | "deleteSession">;
}): ReleaseOwnedSession {
  return createStrictOwnedSessionRelease(input);
}
