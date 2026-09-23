import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { BotRuntimeManager } from "../../../src/bots/bot-runtime-manager";
import { BotService } from "../../../src/bots/bot-service";
import type { BotProfile } from "../../../src/bots/bot-types";
import type { AppConfig } from "../../../src/config/types";
import { ControlService, conversationKernel } from "../../../src/control/control-service";
import { createControlEventBus } from "../../../src/control/control-event-bus";
import { ConversationError } from "../../../src/conversations/conversation-error";
import { ConversationDispatcher, type ConversationDispatcherHooks } from "../../../src/conversations/conversation-dispatcher";
import { ConversationRunService } from "../../../src/conversations/conversation-run-service";
import {
  canMintHumanPermissionInteraction,
} from "../../../src/conversations/conversation-execution";
import type {
  ConversationTurnCancelInput,
  ConversationTurnCancelResult,
  ConversationTurnRunInput,
  ConversationTurnRunResult,
  ConversationTurnRunner,
} from "../../../src/conversations/conversation-turn-runner";
import {
  ControlConversationTurnRunner,
  type ControlConversationTurnRunnerOptions,
} from "../../../src/conversations/conversation-turn-runner";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import {
  createDirectBindingId,
  createDirectConversationId,
  createDirectTopicId,
  createScopedDirectBindingId,
} from "../../../src/domain/ids";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { createStrictOwnedSessionRelease } from "../../../src/sessions/owned-session-release";
import { parseState, type StateStore } from "../../../src/state/state-store";
import { createEmptyState, type AppState } from "../../../src/state/types";
import type { ChatRequest, ChatResponse } from "../../../src/weixin/agent/interface";

const NOW = "2026-09-15T12:00:00.000Z";
const BOT_ID = "bot_reviewer";
const TESTER_ID = "bot_tester";

function seedTesterBot(state: AppState): void {
  state.bots[TESTER_ID] = {
    id: TESTER_ID,
    name: "Tester",
    agent: "codex",
    workspace: "backend",
    enabled: true,
    profileRevision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const HUMAN_INGRESS = {
  chatKey: "relay:acct",
  senderId: "acct",
  accountId: "acct",
  isOwner: true as const,
};

class MemoryStateStore implements Pick<StateStore, "save" | "saveNow"> {
  public saved: AppState[] = [];
  async save(state: AppState): Promise<void> {
    this.saved.push(structuredClone(state));
  }
  async saveNow(state: AppState): Promise<void> {
    this.saved.push(structuredClone(state));
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitUntil(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function createConfig(): AppConfig {
  return {
    transport: { type: "acpx-cli", command: "acpx", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
    logging: { level: "info", maxSizeBytes: 1024, maxFiles: 2, retentionDays: 1, perf: { enabled: false } },
    channel: { type: "weixin", replyMode: "stream" },
    channels: [{ id: "weixin", type: "weixin", enabled: true }],
    plugins: [],
    agents: { codex: { driver: "codex" }, claude: { driver: "claude" } },
    workspaces: { backend: { cwd: "/tmp/backend" }, frontend: { cwd: "/tmp/frontend" } },
    orchestration: {
      maxPendingAgentRequestsPerCoordinator: 3,
      allowWorkerChainedRequests: false,
      allowedAgentRequestTargets: [],
      allowedAgentRequestRoles: [],
      progressHeartbeatSeconds: 30,
      maxParallelTasksPerAgent: 1,
    },
  };
}

class FakeRunner implements ConversationTurnRunner {
  public runs: ConversationTurnRunInput[] = [];
  public cancelCalls: ConversationTurnCancelInput[] = [];
  public hang?: ReturnType<typeof deferred>;
  public result: ConversationTurnRunResult = { status: "completed", text: "done" };
  public cancelResult: ConversationTurnCancelResult = { outcome: "cancelled" };
  private readonly cancelled = new Set<string>();
  private readonly results = new Map<string, ConversationTurnRunResult>();
  private inFlight?: ConversationTurnRunInput;
  private runDone?: Promise<void>;

  async run(input: ConversationTurnRunInput): Promise<ConversationTurnRunResult> {
    this.runs.push(input);
    this.inFlight = input;
    let settleRun!: () => void;
    this.runDone = new Promise<void>((resolve) => {
      settleRun = resolve;
    });
    try {
      if (this.hang) {
        await this.hang.promise;
      }
      const result = this.cancelled.has(input.promptRequestId)
        ? { status: "cancelled" as const }
        : this.result;
      this.results.set(input.promptRequestId, result);
      return result;
    } finally {
      if (this.inFlight === input) {
        this.inFlight = undefined;
      }
      settleRun();
    }
  }

  async cancel(input: ConversationTurnCancelInput): Promise<ConversationTurnCancelResult> {
    this.cancelCalls.push(input);
    const running = this.inFlight;
    if (running) {
      this.cancelled.add(running.promptRequestId);
      this.hang?.resolve();
      await this.runDone;
    }
    const settled = this.results.get(input.promptRequestId);
    if (settled) {
      if (settled.status === "completed") {
        return { outcome: "completed", text: settled.text };
      }
      if (settled.status === "failed") {
        return { outcome: "failed", error: settled.error };
      }
      if (settled.unknown) {
        return { outcome: "unknown" };
      }
      return { outcome: "cancelled" };
    }
    return this.cancelResult;
  }
}

async function createLifecycle(options: {
  runner?: ConversationTurnRunner;
  hooks?: ConversationDispatcherHooks;
  beforeAcceptPersist?: () => Promise<void>;
  beforeTeardownFinalize?: () => Promise<void>;
  afterTeardownMarkedDeleting?: () => Promise<void>;
  afterDirectSnapshot?: (bot: BotProfile) => Promise<void>;
  beforeAcceptCommit?: () => void;
  ownerId?: string;
  autoKick?: boolean;
  leaseMs?: number;
  controlChat?: (request: ChatRequest) => Promise<ChatResponse>;
  runnerOptions?: ControlConversationTurnRunnerOptions;
} = {}) {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-life-")), "conversation.sqlite");
  const store = await SqliteConversationStore.open(path, {
    beforeAcceptCommit: options.beforeAcceptCommit,
  });
  const state = createEmptyState();
  const stateStore = new MemoryStateStore();
  const stateMutex = new AsyncMutex();
  const config = createConfig();
  const sessions = new SessionService(config, stateStore, state, { now: () => Date.parse(NOW), stateMutex });
  const physical = {
    fail: false,
    deleteCalls: 0,
    releaseCalls: 0,
    async deleteSession() {
      this.deleteCalls += 1;
      if (this.fail) {
        throw new Error("injected physical teardown failure");
      }
    },
    async releaseLogicalSession() {
      this.releaseCalls += 1;
      if (this.fail) {
        throw new Error("injected physical teardown failure");
      }
    },
  };
  const releaseOwnedSession = createStrictOwnedSessionRelease({ sessions, transport: physical });
  const bots = new BotService(config, state, stateStore, {
    now: () => new Date(NOW),
    createId: () => BOT_ID,
    stateMutex,
  });
  const runtime = new BotRuntimeManager(bots, sessions, state, stateStore, {
    now: () => new Date(NOW),
    stateMutex,
    afterDirectSnapshot: options.afterDirectSnapshot,
    releaseOwnedSession,
  });
  const events = createControlEventBus();
  const runner = options.controlChat
    ? new ControlConversationTurnRunner(conversationKernel(new ControlService({
      agent: { chat: options.controlChat },
      sessions,
      activeTurns: { isActiveAnywhere: () => false },
      scheduled: {} as never,
      orchestration: {} as never,
      events,
    } as never)), options.runnerOptions)
    : options.runner ?? new FakeRunner();
  let clock = Date.parse(NOW);
  const nowFn = () => {
    clock += 1;
    return new Date(clock);
  };
  const jump = (ms: number) => {
    clock += ms;
  };
  const dispatcherHolder: { current?: ConversationDispatcher } = {};
  bots.setReenabledHook(() => {
    void dispatcherHolder.current?.kick().catch(() => {});
  });
  const dispatcher = new ConversationDispatcher(store, runtime, runner, sessions, {
    now: nowFn,
    ownerId: options.ownerId ?? "dispatcher-a",
    hooks: options.hooks,
    ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
  });
  dispatcherHolder.current = dispatcher;
  const service = new ConversationRunService(store, bots, runtime, dispatcher, sessions, state, stateStore, {
    now: nowFn,
    stateMutex,
    beforeAcceptPersist: options.beforeAcceptPersist,
    beforeTeardownFinalize: options.beforeTeardownFinalize,
    afterTeardownMarkedDeleting: options.afterTeardownMarkedDeleting,
    autoKick: options.autoKick ?? false,
    releaseOwnedSession,
  });
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend", instructions: "Focus on races." });
  return { path, store, state, sessions, bots, runtime, runner, dispatcher, service, nowFn, jump, physical };
}

function fakeRunner(runner: ConversationTurnRunner): FakeRunner {
  if (!(runner instanceof FakeRunner)) {
    throw new Error("expected FakeRunner");
  }
  return runner;
}

test("crash after request transaction and before dispatch resumes exactly once", async () => {
  const first = await createLifecycle();
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-crash-before-dispatch",
    content: "hello",
  });
  expect(accepted.run.state).toBe("queued");
  expect(fakeRunner(first.runner).runs).toHaveLength(0);
  first.store.close();

  const runner = new FakeRunner();
  const store = await SqliteConversationStore.open(first.path);
  const dispatcher = new ConversationDispatcher(store, first.runtime, runner, first.sessions, {
    now: () => new Date(NOW),
    ownerId: "dispatcher-b",
  });
  await dispatcher.kick();
  expect(runner.runs).toHaveLength(1);
  expect(runner.runs[0]?.executionOrigin).toBe("orchestration");
  expect(canMintHumanPermissionInteraction(runner.runs[0]?.executionOrigin)).toBe(false);
  expect(store.getRun(accepted.run.id)?.state).toBe("completed");
  expect(store.listMessages({
    conversationId: accepted.run.conversationId,
    topicId: accepted.run.topicId,
    limit: 10,
  }).map((message) => message.role)).toEqual(["human", "bot"]);
  store.close();
});

test("crash after dispatch claim and before execution start redispatches once", async () => {
  const claimed = deferred();
  const resume = deferred();
  const runner = new FakeRunner();
  const first = await createLifecycle({
    runner,
    ownerId: "dispatcher-a",
    hooks: {
      afterClaim: async () => {
        claimed.resolve();
        await resume.promise;
      },
    },
  });
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-claim-crash",
    content: "hello",
  });
  const drain = first.dispatcher.kick();
  await claimed.promise;
  expect(first.store.getDispatchForRun(accepted.run.id)?.state).toBe("claimed");
  expect(first.store.getMemberTurn(accepted.memberTurn.id)?.startedAt).toBeUndefined();
  expect(runner.runs).toHaveLength(0);

  const recoveredRunner = new FakeRunner();
  const recovered = new ConversationDispatcher(
    first.store,
    first.runtime,
    recoveredRunner,
    first.sessions,
    { now: first.nowFn, ownerId: "dispatcher-b" },
  );
  first.jump(60_000);
  await recovered.kick();
  expect(recoveredRunner.runs).toHaveLength(1);
  expect(recoveredRunner.runs[0]?.executionOrigin).toBe("orchestration");
  expect(first.store.getRun(accepted.run.id)?.state).toBe("completed");
  resume.resolve();
  await drain;
});

test("crash after execution start and before result persistence is indeterminate, never a blind duplicate", async () => {
  const started = deferred();
  const resume = deferred();
  const runner = new FakeRunner();
  runner.hang = deferred();
  const first = await createLifecycle({
    runner,
    ownerId: "dispatcher-a",
    hooks: {
      afterExecutionStart: async () => {
        started.resolve();
        await resume.promise;
      },
    },
  });
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-started-crash",
    content: "hello",
  });
  const drain = first.dispatcher.kick();
  await started.promise;
  expect(first.store.getMemberTurn(accepted.memberTurn.id)?.state).toBe("running");
  expect(first.store.getMemberTurn(accepted.memberTurn.id)?.sourceTurnId).toBeDefined();

  const recoveredRunner = new FakeRunner();
  const recovered = new ConversationDispatcher(
    first.store,
    first.runtime,
    recoveredRunner,
    first.sessions,
    { now: first.nowFn, ownerId: "dispatcher-b" },
  );
  first.jump(60_000);
  await recovered.kick();
  expect(first.store.getRun(accepted.run.id)?.state).toBe("indeterminate");
  expect(first.store.getMemberTurn(accepted.memberTurn.id)?.state).toBe("indeterminate");
  expect(recoveredRunner.runs).toHaveLength(0);
  resume.resolve();
  runner.hang.resolve();
  await drain;
  expect(runner.runs).toHaveLength(0);
});

test("result persisted then client reconnects replays history by seq exactly once", async () => {
  const first = await createLifecycle();
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-replay",
    content: "hello",
  });
  await first.dispatcher.kick();
  const page1 = first.store.listMessages({
    conversationId: accepted.run.conversationId,
    topicId: accepted.run.topicId,
    afterSeq: 0,
    limit: 10,
  });
  expect(page1.map((message) => message.seq)).toEqual([1, 2]);
  const page2 = first.store.listMessages({
    conversationId: accepted.run.conversationId,
    topicId: accepted.run.topicId,
    afterSeq: 2,
    limit: 10,
  });
  expect(page2).toEqual([]);
});

test("second Topic uses a separate runtime binding and session", async () => {
  const first = await createLifecycle();
  const extra = await first.service.createDirectTopic(BOT_ID, "Second");
  const defaultAccepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-default",
    content: "default",
  });
  const extraAccepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-extra",
    content: "extra",
    topicId: extra.id,
  });
  await first.dispatcher.kick();
  const defaultBinding = Object.values(first.state.bot_runtime_bindings).find((binding) => binding.topicId === defaultAccepted.run.topicId);
  const extraBinding = Object.values(first.state.bot_runtime_bindings).find((binding) => binding.topicId === extra.id);
  expect(defaultBinding?.sessionAlias).toBeDefined();
  expect(extraBinding?.sessionAlias).toBeDefined();
  expect(extraBinding?.sessionAlias).not.toBe(defaultBinding?.sessionAlias);
  expect(extraAccepted.run.topicId).toBe(extra.id);
  expect(fakeRunner(first.runner).runs).toHaveLength(2);
});

test("cancel queued Run never starts execution", async () => {
  const first = await createLifecycle();
  const firstRun = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-active",
    content: "running",
  });
  const queued = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-queued",
    content: "later",
  });
  expect(queued.run.state).toBe("queued");
  await first.service.cancelRun(queued.run.id);
  expect(first.store.getRun(queued.run.id)?.state).toBe("cancelled");
  await first.dispatcher.kick();
  expect(fakeRunner(first.runner).runs).toHaveLength(1);
  expect(fakeRunner(first.runner).runs[0]?.promptRequestId).toBe(
    first.store.listMemberTurns(firstRun.run.id)[0]?.sourceTurnId,
  );
  expect(first.store.getRun(queued.run.id)?.state).toBe("cancelled");
});

test("cancel running Run uses the exact session and does not touch another Topic", async () => {
  const runner = new FakeRunner();
  runner.hang = deferred();
  const started = deferred();
  let targetRunId = "";
  const first = await createLifecycle({
    runner,
    hooks: {
      afterExecutionStart: async (turn) => {
        if (turn.runId === targetRunId) {
          started.resolve();
        }
      },
    },
  });
  const extra = await first.service.createDirectTopic(BOT_ID, "Second");
  const running = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-running",
    content: "go",
  });
  targetRunId = running.run.id;
  const other = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-other-topic",
    content: "other",
    topicId: extra.id,
  });
  const drain = first.dispatcher.kick();
  await started.promise;
  await waitUntil(() => runner.runs.length === 1);
  await first.service.cancelRun(running.run.id);
  await drain;
  expect(first.store.getRun(running.run.id)?.state).toBe("cancelled");
  await first.dispatcher.kick();
  expect(first.store.getRun(other.run.id)?.state).toBe("completed");
  expect(runner.cancelCalls).toHaveLength(1);
  expect(runner.cancelCalls[0]?.sessionAlias).not.toBe("");
});

test("completion vs cancellation race persists the proven completion, not a false cancelled", async () => {
  const beforePersist = deferred();
  const resume = deferred();
  const runner = new FakeRunner();
  const first = await createLifecycle({
    runner,
    hooks: {
      beforeResultPersist: async () => {
        beforePersist.resolve();
        await resume.promise;
      },
    },
  });
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-race-cancel",
    content: "go",
  });
  const drain = first.dispatcher.kick();
  await beforePersist.promise;
  await first.service.cancelRun(accepted.run.id);
  resume.resolve();
  await drain;
  expect(first.store.getRun(accepted.run.id)?.state).toBe("completed");
  const messages = first.store.listMessages({
    conversationId: accepted.run.conversationId,
    topicId: accepted.run.topicId,
    limit: 10,
  });
  expect(messages.filter((message) => message.role === "bot").map((message) => message.content)).toEqual(["done"]);
});

test("runtime creation failure after accept leaves durable pending work", async () => {
  const first = await createLifecycle({
    hooks: { failRuntimeMaterialize: true },
  });
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-runtime-fail",
    content: "hello",
  });
  await first.dispatcher.kick();
  expect(first.store.getRun(accepted.run.id)?.state).toBe("queued");
  expect(first.store.getDispatchForRun(accepted.run.id)?.state).toBe("pending");
  expect(fakeRunner(first.runner).runs).toHaveLength(0);

  const recovered = new ConversationDispatcher(
    first.store,
    first.runtime,
    first.runner,
    first.sessions,
    { now: first.nowFn, ownerId: "dispatcher-retry" },
  );
  await recovered.kick();
  expect(first.store.getRun(accepted.run.id)?.state).toBe("completed");
  expect(fakeRunner(first.runner).runs).toHaveLength(1);
  expect(fakeRunner(first.runner).runs[0]?.executionOrigin).toBe("orchestration");
});

test("teardown release failure leaves recoverable ownership", async () => {
  const first = await createLifecycle();
  await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-teardown",
    content: "hello",
  });
  await first.dispatcher.kick();
  expect(Object.keys(first.state.bot_runtime_bindings).length).toBeGreaterThan(0);
  const owned = Object.values(first.state.sessions).filter((session) => session.owner?.kind === "bot-direct");
  expect(owned.length).toBeGreaterThan(0);
  first.physical.fail = true;
  await expect(first.service.teardownDirectConversation(BOT_ID)).rejects.toMatchObject({
    code: "session_release_failed",
  });
  expect(first.physical.deleteCalls + first.physical.releaseCalls).toBeGreaterThan(0);
  expect(Object.keys(first.state.bot_runtime_bindings).length).toBeGreaterThan(0);
  expect(Object.values(first.state.sessions).some((session) => session.owner?.kind === "bot-direct")).toBe(true);
  expect(first.store.isConversationDeleting(createDirectConversationId(BOT_ID))).toBe(true);
  first.physical.fail = false;
  await first.service.teardownDirectConversation(BOT_ID);
  expect(first.state.bot_runtime_bindings).toEqual({});
  expect(first.state.conversations).toEqual({});
  expect(Object.values(first.state.sessions).some((session) => session.owner?.kind === "bot-direct")).toBe(false);
  await first.bots.deleteBot(BOT_ID);
  expect(first.state.bots[BOT_ID]).toBeUndefined();
});

test("Bot profile edit racing Run acceptance captures one coherent revision", async () => {
  const entered = deferred();
  const resume = deferred();
  const first = await createLifecycle({
    beforeAcceptPersist: async () => {
      entered.resolve();
      await resume.promise;
    },
  });
  const accept = first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-profile-race",
    content: "hello",
  });
  await entered.promise;
  const update = first.bots.updateBot(BOT_ID, { instructions: "Be terse.", name: "Critic" });
  resume.resolve();
  const [acceptedResult, updateResult] = await Promise.all([accept, update]);
  const snapshot = acceptedResult.run.profileSnapshot;
  expect(snapshot.revision === 1 || snapshot.revision === 2).toBe(true);
  if (snapshot.revision === 1) {
    expect(snapshot.presentation.name).toBe("Reviewer");
    expect(snapshot.behavior.instructions).toBe("Focus on races.");
  } else {
    expect(snapshot.presentation.name).toBe("Critic");
    expect(snapshot.behavior.instructions).toBe("Be terse.");
  }
  expect(updateResult.profileRevision).toBe(2);
  expect(updateResult.name).toBe("Critic");
  expect(updateResult.instructions).toBe("Be terse.");
});

test("one active Run per Topic queues the next request durably", async () => {
  const hang = deferred();
  const started = deferred();
  const runner = new FakeRunner();
  runner.hang = hang;
  const first = await createLifecycle({
    runner,
    hooks: {
      afterExecutionStart: async () => {
        started.resolve();
      },
    },
  });
  const a = await first.service.acceptDirectPrompt({ botId: BOT_ID, requestId: "req-a", content: "a" });
  const b = await first.service.acceptDirectPrompt({ botId: BOT_ID, requestId: "req-b", content: "b" });
  const drain = first.dispatcher.kick();
  await started.promise;
  expect(first.store.getRun(a.run.id)?.state).toBe("running");
  expect(first.store.getRun(b.run.id)?.state).toBe("queued");
  expect(first.store.getDispatchForRun(b.run.id)?.state).toBe("pending");
  hang.resolve();
  await drain;
  expect(first.store.getRun(a.run.id)?.state).toBe("completed");
  expect(first.store.getRun(b.run.id)?.state).toBe("completed");
  expect(runner.runs).toHaveLength(2);
});

test("cancel between materialize and execution-start still converges Bot lifecycle via bots-changed", async () => {
  const paused = deferred();
  const resume = deferred();
  const first = await createLifecycle({
    hooks: {
      beforeExecutionStart: async () => {
        paused.resolve();
        await resume.promise;
      },
    },
  });
  // Attach a product listener by re-emitting through the dispatcher's sink:
  // the composition wires onRuntimeMaterialized -> bots-changed; here we
  // assert the same ordering directly on the runtime hook path.
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-materialize-cancel",
    content: "hello",
  });
  const draining = first.dispatcher.kick();
  await paused.promise;
  // Binding/session are durably published at this point even though
  // execution-start has not run.
  const bindings = Object.values(first.state.bot_runtime_bindings);
  expect(bindings).toHaveLength(1);
  expect(first.bots.hasRuntime(BOT_ID)).toBe(true);
  // Cancel before execution-start: no member-turn-started will ever fire.
  await first.service.cancelRun(accepted.run.id);
  resume.resolve();
  await draining;
  expect(first.store.getRun(accepted.run.id)?.state).toBe("cancelled");
  expect(first.bots.hasRuntime(BOT_ID)).toBe(true);
});

test("stale worker cannot cross the execution-start fence after a lease reclaim", async () => {
  const aPaused = deferred();
  const aResume = deferred();
  const bHang = deferred();
  const runnerA = new FakeRunner();
  const first = await createLifecycle({
    runner: runnerA,
    ownerId: "dispatcher-a",
    leaseMs: 5_000,
    hooks: {
      beforeExecutionStart: async () => {
        aPaused.resolve();
        await aResume.promise;
      },
    },
  });
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-fence",
    content: "hello",
  });
  const drainA = first.dispatcher.kick();
  await aPaused.promise;
  expect(runnerA.runs).toHaveLength(0);
  expect(first.store.getMemberTurn(accepted.memberTurn.id)?.startedAt).toBeUndefined();

  const runnerB = new FakeRunner();
  runnerB.hang = bHang;
  const dispatcherB = new ConversationDispatcher(first.store, first.runtime, runnerB, first.sessions, {
    now: first.nowFn,
    ownerId: "dispatcher-b",
    leaseMs: 5_000,
  });
  first.jump(10_000);
  const drainB = dispatcherB.kick();
  await waitUntil(() => runnerB.runs.length === 1);
  expect(first.store.getMemberTurn(accepted.memberTurn.id)?.state).toBe("running");
  aResume.resolve();
  await drainA;
  expect(runnerA.runs).toHaveLength(0);
  expect(first.store.listMemberTurns(accepted.run.id).filter((turn) => turn.startedAt)).toHaveLength(1);
  bHang.resolve();
  await drainB;
  expect(first.store.getRun(accepted.run.id)?.state).toBe("completed");
  expect(runnerB.runs).toHaveLength(1);
});

test("model and effort edits between accept and dispatch execute the accepted snapshot", async () => {
  const first = await createLifecycle();
  await first.bots.updateBot(BOT_ID, { model: "gpt-snapshot", effort: "low" });
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-model",
    content: "hello",
  });
  expect(accepted.run.profileSnapshot.execution.model).toBe("gpt-snapshot");
  expect(accepted.run.profileSnapshot.execution.effort).toBe("low");
  await first.bots.updateBot(BOT_ID, { model: "gpt-live", effort: "high" });
  await first.dispatcher.kick();
  expect(first.store.getRun(accepted.run.id)?.state).toBe("completed");
  expect(fakeRunner(first.runner).runs).toHaveLength(1);
  const session = first.sessions.getLogicalSessionRecord(fakeRunner(first.runner).runs[0]!.sessionAlias);
  expect(session?.model).toBe("gpt-snapshot");
  expect(session?.effort).toBe("low");
});

test("agent/workspace drift on an existing session fails runtime_revision_mismatch before the model", async () => {
  const first = await createLifecycle();
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-identity",
    content: "hello",
  });
  await first.bots.updateBot(BOT_ID, { agent: "claude", workspace: "frontend" });
  await first.runtime.getOrCreateDirectSession({ botId: BOT_ID });
  await first.dispatcher.kick();
  expect(first.store.getRun(accepted.run.id)?.state).toBe("failed");
  expect(first.store.getRun(accepted.run.id)?.completionReason).toBe("runtime_revision_mismatch");
  expect(fakeRunner(first.runner).runs).toHaveLength(0);
});

test("teardown keeps the deleting barrier until AppState finalization finishes", async () => {
  const entered = deferred();
  const resume = deferred();
  const first = await createLifecycle({
    beforeTeardownFinalize: async () => {
      entered.resolve();
      await resume.promise;
    },
  });
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-teardown-race",
    content: "hello",
  });
  await first.dispatcher.kick();
  const conversationId = accepted.run.conversationId;
  const teardown = first.service.teardownDirectConversation(BOT_ID);
  await entered.promise;
  expect(first.store.isConversationDeleting(conversationId)).toBe(true);
  expect(() => first.store.acceptRequest({
    conversationId,
    topicId: accepted.run.topicId,
    requestId: "req-orphan",
    botId: BOT_ID,
    content: "late",
    profileSnapshot: accepted.run.profileSnapshot,
    now: new Date().toISOString(),
  })).toThrow(/deleting/);
  expect(first.store.getRunByRequestId(conversationId, accepted.run.topicId, "req-orphan")).toBeUndefined();
  resume.resolve();
  await teardown;
  expect(first.store.isConversationDeleting(conversationId)).toBe(false);
  expect(first.store.listRuns(conversationId)).toEqual([]);
  expect(first.state.conversations[conversationId]).toBeUndefined();
  expect(first.state.bot_runtime_bindings).toEqual({});
});

test("accepted Run without a runtime fails closed when Bot agent/workspace changes before dispatch", async () => {
  const first = await createLifecycle();
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-identity-pre-runtime",
    content: "hello",
  });
  expect(Object.keys(first.state.sessions)).toHaveLength(0);
  await first.bots.updateBot(BOT_ID, { agent: "claude", workspace: "frontend" });
  await first.dispatcher.kick();
  const bot = first.bots.getBot(BOT_ID);
  expect(bot.agent).toBe("claude");
  expect(bot.workspace).toBe("frontend");
  expect(first.store.getRun(accepted.run.id)?.state).toBe("failed");
  expect(first.store.getRun(accepted.run.id)?.completionReason).toBe("runtime_revision_mismatch");
  expect(fakeRunner(first.runner).runs).toHaveLength(0);
  const owned = Object.values(first.state.sessions).filter((session) => session.owner?.kind === "bot-direct");
  expect(owned).toHaveLength(0);
  expect(Object.keys(first.state.bot_runtime_bindings)).toHaveLength(0);
});

test("identity check inside the lifecycle gate wins over an outer stale pass", async () => {
  const paused = deferred();
  const resume = deferred();
  const first = await createLifecycle({
    hooks: {
      afterAcceptedIdentityCheck: async () => {
        paused.resolve();
        await resume.promise;
      },
    },
  });
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-identity-gate",
    content: "hello",
  });
  const drain = first.dispatcher.kick();
  await paused.promise;
  await first.bots.updateBot(BOT_ID, { agent: "claude", workspace: "frontend" });
  resume.resolve();
  await drain;
  expect(first.store.getRun(accepted.run.id)?.state).toBe("failed");
  expect(first.store.getRun(accepted.run.id)?.completionReason).toBe("runtime_revision_mismatch");
  expect(first.store.getDispatchForRun(accepted.run.id)?.state).toBe("completed");
  expect(fakeRunner(first.runner).runs).toHaveLength(0);
  expect(Object.values(first.state.sessions).filter((session) => session.owner?.kind === "bot-direct")).toHaveLength(0);
  expect(Object.keys(first.state.bot_runtime_bindings)).toHaveLength(0);
  expect(first.bots.getBot(BOT_ID).agent).toBe("claude");
  expect(first.bots.getBot(BOT_ID).workspace).toBe("frontend");
});

test("retrying an accepted request after disable reuses the durable Run", async () => {
  const first = await createLifecycle();
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-disable-retry",
    content: "hello",
  });
  await first.bots.updateBot(BOT_ID, { enabled: false });
  const retry = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-disable-retry",
    content: "hello again",
  });
  expect(retry.reused).toBe(true);
  expect(retry.run.id).toBe(accepted.run.id);
  expect(retry.message.id).toBe(accepted.message.id);
  expect(retry.dispatch.id).toBe(accepted.dispatch.id);
  await expect(first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-disable-new",
    content: "fresh",
  })).rejects.toMatchObject({ code: "bot_disabled" });
});

test("disable before materialize parks the Run pending; re-enable resumes it exactly once", async () => {
  const first = await createLifecycle();
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-disable-resume",
    content: "hello",
  });
  expect(first.store.getRun(accepted.run.id)?.state).toBe("queued");
  // Disable before any materialization: the next drain parks the claim back
  // to pending instead of executing.
  await first.bots.updateBot(BOT_ID, { enabled: false });
  await first.dispatcher.kick();
  expect(first.store.getRun(accepted.run.id)?.state).toBe("queued");
  expect(fakeRunner(first.runner).runs).toHaveLength(0);
  // Re-enable must wake the dispatcher via the hook: the same durable Run
  // resumes without a second prompt, and executes exactly once. No manual
  // kick: the updateBot(false->true) transition fires it.
  await first.bots.updateBot(BOT_ID, { enabled: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(fakeRunner(first.runner).runs).toHaveLength(1);
  expect(first.store.getRun(accepted.run.id)?.state).toBe("completed");
  expect(fakeRunner(first.runner).runs.filter((r) => r.runId === accepted.run.id)).toHaveLength(1);
});

test("retrying an accepted extra-Topic request after deleting reuses the durable Run", async () => {
  const first = await createLifecycle();
  const extra = await first.service.createDirectTopic(BOT_ID, "Second");
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-deleting-retry",
    content: "hello",
    topicId: extra.id,
  });
  first.store.markConversationDeleting(accepted.run.conversationId, new Date().toISOString());
  first.store.markTopicDeleting(extra.id, accepted.run.conversationId, new Date().toISOString());
  const retry = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-deleting-retry",
    content: "hello again",
    topicId: extra.id,
  });
  expect(retry.reused).toBe(true);
  expect(retry.run.id).toBe(accepted.run.id);
  expect(retry.message.id).toBe(accepted.message.id);
  expect(retry.dispatch.id).toBe(accepted.dispatch.id);
  await expect(first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-deleting-new",
    content: "fresh",
    topicId: extra.id,
  })).rejects.toMatchObject({ code: "conversation_deleting" });
});

test("teardown releases PR2 bindingId-only owned sessions so deleteBot can proceed", async () => {
  const first = await createLifecycle();
  const bindingId = createDirectBindingId(BOT_ID);
  const alias = `brt_${bindingId}`;
  await first.sessions.createSession(alias, "codex", "backend", {
    owner: { kind: "bot-direct", bindingId },
  });
  expect(first.state.sessions[alias]?.owner).toEqual({ kind: "bot-direct", bindingId });
  expect(first.state.bot_runtime_bindings).toEqual({});
  await expect(first.bots.deleteBot(BOT_ID)).rejects.toMatchObject({ code: "bot_in_use" });

  await first.service.teardownDirectConversation(BOT_ID);

  expect(first.state.sessions[alias]).toBeUndefined();
  await first.bots.deleteBot(BOT_ID);
  expect(first.state.bots[BOT_ID]).toBeUndefined();
});

test("teardown never treats a binding alias as authority to delete an ordinary session", async () => {
  const first = await createLifecycle();
  const conversationId = createDirectConversationId(BOT_ID);
  const topicId = createDirectTopicId(BOT_ID);
  const bindingId = createScopedDirectBindingId(conversationId, topicId, BOT_ID);
  const alias = "ordinary-user-session";
  await first.sessions.createSession(alias, "codex", "backend");
  first.state.bot_runtime_bindings[bindingId] = {
    id: bindingId,
    scope: "bot-direct",
    conversationId,
    topicId,
    botId: BOT_ID,
    logicalSessionId: first.state.sessions[alias]!.logical_session_id,
    sessionAlias: alias,
    createdAt: NOW,
    updatedAt: NOW,
  };

  await expect(first.service.teardownDirectConversation(BOT_ID)).rejects.toMatchObject({
    code: "runtime_ownership_conflict",
  });

  expect(first.state.sessions[alias]?.owner).toBeUndefined();
  expect(first.state.bot_runtime_bindings[bindingId]).toBeDefined();
  expect(first.store.isConversationDeleting(conversationId)).toBe(false);
  expect(first.physical.deleteCalls).toBe(0);
  expect(first.physical.releaseCalls).toBe(0);
});

test("teardown fails before deleting when explicit Bot ownership conflicts with target metadata", async () => {
  const first = await createLifecycle();
  const bindingId = createDirectBindingId(BOT_ID);
  const conversationId = createDirectConversationId(BOT_ID);
  const alias = `brt_${bindingId}`;
  await first.sessions.createSession(alias, "codex", "backend", {
    owner: {
      kind: "bot-direct",
      bindingId,
      botId: "bot_other",
      conversationId,
    },
  });
  first.state.bot_runtime_bindings[bindingId] = {
    id: bindingId,
    scope: "bot-direct",
    conversationId,
    topicId: "topic_other",
    botId: "bot_other",
    logicalSessionId: first.state.sessions[alias]!.logical_session_id,
    sessionAlias: alias,
    createdAt: NOW,
    updatedAt: NOW,
  };

  await expect(first.service.teardownDirectConversation(BOT_ID)).rejects.toMatchObject({
    code: "runtime_ownership_conflict",
  });

  expect(first.state.sessions[alias]?.owner).toMatchObject({ botId: "bot_other", bindingId });
  expect(first.state.bot_runtime_bindings[bindingId]).toBeDefined();
  expect(first.store.isConversationDeleting(conversationId)).toBe(false);
  expect(first.physical.deleteCalls).toBe(0);
  expect(first.physical.releaseCalls).toBe(0);
});

test("teardown fails closed when PR2 bindingId and conversationId disagree", async () => {
  const first = await createLifecycle();
  const conversationId = createDirectConversationId(BOT_ID);
  const bindingId = createDirectBindingId("bot_other");
  const alias = `brt_${bindingId}`;
  await first.sessions.createSession(alias, "codex", "backend", {
    owner: { kind: "bot-direct", bindingId, conversationId },
  });

  await expect(first.service.teardownDirectConversation(BOT_ID)).rejects.toMatchObject({
    code: "runtime_ownership_conflict",
  });

  expect(first.state.sessions[alias]?.owner).toEqual({ kind: "bot-direct", bindingId, conversationId });
  expect(first.store.isConversationDeleting(conversationId)).toBe(false);
  expect(first.physical.deleteCalls).toBe(0);
  expect(first.physical.releaseCalls).toBe(0);
});

test("deleteBot fails closed on accepted durable work before runtime materialization", async () => {
  const first = await createLifecycle();
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-delete-pre-runtime",
    content: "hello",
  });
  expect(Object.keys(first.state.sessions)).toHaveLength(0);
  await expect(first.bots.deleteBot(BOT_ID)).rejects.toMatchObject({ code: "bot_in_use" });
  expect(first.state.bots[BOT_ID]).toBeDefined();
  expect(first.store.getRun(accepted.run.id)?.id).toBe(accepted.run.id);
  expect(first.store.listMemberTurns(accepted.run.id)[0]?.botId).toBe(BOT_ID);
  expect(first.store.getDispatchForRun(accepted.run.id)?.state).toBe("pending");
  expect(first.store.hasDurableBotWork(BOT_ID)).toBe(true);
});

test("reopened SQLite and parsed AppState still fail-close deleteBot on accepted work", async () => {
  const first = await createLifecycle();
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-delete-restart",
    content: "hello",
  });
  first.store.close();
  const parsed = parseState(JSON.parse(JSON.stringify(first.state)), "state.json");
  const store = await SqliteConversationStore.open(first.path);
  const recoveredBots = new BotService(createConfig(), parsed, new MemoryStateStore(), {
    now: () => new Date(NOW),
    createId: () => BOT_ID,
  });
  recoveredBots.setConversationWork(store);
  await expect(recoveredBots.deleteBot(BOT_ID)).rejects.toMatchObject({ code: "bot_in_use" });
  expect(parsed.bots[BOT_ID]).toBeDefined();
  expect(store.getRun(accepted.run.id)?.id).toBe(accepted.run.id);
  expect(store.listMemberTurns(accepted.run.id)[0]?.botId).toBe(BOT_ID);
  expect(store.getDispatchForRun(accepted.run.id)?.runId).toBe(accepted.run.id);
  expect(store.hasDurableBotWork(BOT_ID)).toBe(true);
  store.close();
});

test("stale worker cannot release a newer pre-start claim after lease reclaim", async () => {
  const aPaused = deferred();
  const aResume = deferred();
  const bPaused = deferred();
  const bResume = deferred();
  const runnerA = new FakeRunner();
  const first = await createLifecycle({
    runner: runnerA,
    ownerId: "dispatcher-a",
    leaseMs: 5_000,
    hooks: {
      beforeRuntimeMaterialize: async () => {
        aPaused.resolve();
        await aResume.promise;
      },
      failRuntimeMaterialize: true,
    },
  });
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-prestart-fence",
    content: "hello",
  });
  const drainA = first.dispatcher.kick();
  await aPaused.promise;
  expect(first.store.getDispatchForRun(accepted.run.id)?.generation).toBe(1);
  expect(first.store.getDispatchForRun(accepted.run.id)?.owner).toBe("dispatcher-a");

  const runnerB = new FakeRunner();
  const dispatcherB = new ConversationDispatcher(first.store, first.runtime, runnerB, first.sessions, {
    now: first.nowFn,
    ownerId: "dispatcher-b",
    leaseMs: 5_000,
    hooks: {
      beforeExecutionStart: async () => {
        bPaused.resolve();
        await bResume.promise;
      },
    },
  });
  first.jump(10_000);
  const drainB = dispatcherB.kick();
  await bPaused.promise;
  const live = first.store.getDispatchForRun(accepted.run.id);
  expect(live?.state).toBe("claimed");
  expect(live?.owner).toBe("dispatcher-b");
  expect(live?.generation).toBe(2);
  expect(first.store.getMemberTurn(accepted.memberTurn.id)?.startedAt).toBeUndefined();
  aResume.resolve();
  await drainA;
  const afterStale = first.store.getDispatchForRun(accepted.run.id);
  expect(afterStale?.state).toBe("claimed");
  expect(afterStale?.owner).toBe("dispatcher-b");
  expect(afterStale?.generation).toBe(2);
  expect(runnerA.runs).toHaveLength(0);
  expect(runnerB.runs).toHaveLength(0);
  bResume.resolve();
  await drainB;
  expect(first.store.getRun(accepted.run.id)?.state).toBe("completed");
  expect(runnerB.runs).toHaveLength(1);
  expect(runnerA.runs).toHaveLength(0);
});

test("cancel between durable start and runner registration never starts Control", async () => {
  const started = deferred();
  const resume = deferred();
  const control = {
    promptCalls: 0,
    async promptImmediate() {
      this.promptCalls += 1;
      return { ok: true, text: "done" };
    },
    cancelTurnForPromptRequest() {
      return true;
    },
    cancelQueuedConversationItem() {
      return { cancelled: true };
    },
  };
  const runner = new ControlConversationTurnRunner(control);
  const first = await createLifecycle({
    runner,
    hooks: {
      afterExecutionStart: async () => {
        started.resolve();
        await resume.promise;
      },
    },
  });
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-handoff-cancel",
    content: "hello",
  });
  const drain = first.dispatcher.kick();
  await started.promise;
  expect(first.store.getMemberTurn(accepted.memberTurn.id)?.state).toBe("running");
  expect(control.promptCalls).toBe(0);
  await first.service.cancelRun(accepted.run.id);
  resume.resolve();
  await drain;
  expect(control.promptCalls).toBe(0);
  expect(first.store.getRun(accepted.run.id)?.state).not.toBe("running");
  expect(first.store.getRun(accepted.run.id)?.state).not.toBe("queued");
});

test("public prompt without trusted ingress is orchestration even on the same daemon", async () => {
  const captured: ChatRequest[] = [];
  const first = await createLifecycle({
    controlChat: async (request) => {
      captured.push(request);
      return { text: "done" };
    },
  });
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-public-orchestration",
    content: "hello",
  });
  await first.dispatcher.kick();
  expect(first.store.getRun(accepted.run.id)?.state).toBe("completed");
  expect(first.store.getMemberTurn(accepted.memberTurn.id)?.origin).toBe("recovery");
  expect(captured[0]?.metadata?.origin).toBe("orchestration");
  expect(canMintHumanPermissionInteraction(captured[0]?.metadata?.origin)).toBe(false);
});

test("fresh same-daemon Conversation dispatch stays human and can mint permission", async () => {
  const captured: ChatRequest[] = [];
  const first = await createLifecycle({
    controlChat: async (request) => {
      captured.push(request);
      return { text: "done" };
    },
  });
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-fresh-human",
    content: "hello",
    humanIngress: HUMAN_INGRESS,
  });
  await first.dispatcher.kick();
  expect(first.store.getRun(accepted.run.id)?.state).toBe("completed");
  expect(first.store.getMemberTurn(accepted.memberTurn.id)?.origin).toBe("human");
  expect(captured[0]?.metadata?.origin).toBe("human");
  expect(captured[0]?.metadata?.permissionChatKey).toBe(HUMAN_INGRESS.chatKey);
  expect(captured[0]?.metadata?.senderId).toBe(HUMAN_INGRESS.senderId);
  expect(captured[0]?.conversationId.startsWith("bot:")).toBe(true);
  expect(canMintHumanPermissionInteraction(captured[0]?.metadata?.origin)).toBe(true);
});

test("startup redispatch after accept-before-claim is orchestration and cannot mint", async () => {
  const captured: ChatRequest[] = [];
  const first = await createLifecycle();
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-startup-recovery",
    content: "hello",
    humanIngress: HUMAN_INGRESS,
  });
  expect(accepted.dispatch.generation).toBe(1);
  expect(accepted.dispatch.humanIngress).toEqual(HUMAN_INGRESS);
  const restart = new ConversationDispatcher(
    first.store,
    first.runtime,
    new ControlConversationTurnRunner(conversationKernel(new ControlService({
      agent: {
        chat: async (request: ChatRequest) => {
          captured.push(request);
          return { text: "done" };
        },
      },
      sessions: first.sessions,
      activeTurns: { isActiveAnywhere: () => false },
      scheduled: {} as never,
      orchestration: {} as never,
      events: createControlEventBus(),
    } as never))),
    first.sessions,
    { now: first.nowFn, ownerId: "dispatcher-restart" },
  );
  await restart.kick();
  expect(first.store.getRun(accepted.run.id)?.state).toBe("completed");
  expect(first.store.getMemberTurn(accepted.memberTurn.id)?.origin).toBe("recovery");
  expect(first.store.getDispatchForRun(accepted.run.id)?.humanIngress).toBeUndefined();
  expect(captured[0]?.metadata?.origin).toBe("orchestration");
  expect(canMintHumanPermissionInteraction(captured[0]?.metadata?.origin)).toBe(false);
});

test("lease-expired pre-start redispatch is orchestration even on the same daemon", async () => {
  const captured: ChatRequest[] = [];
  const paused = deferred();
  const resume = deferred();
  const first = await createLifecycle({
    leaseMs: 5_000,
    controlChat: async (request) => {
      captured.push(request);
      return { text: "done" };
    },
    hooks: {
      beforeRuntimeMaterialize: async () => {
        paused.resolve();
        await resume.promise;
      },
    },
  });
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-lease-recovery",
    content: "hello",
    humanIngress: HUMAN_INGRESS,
  });
  const drain = first.dispatcher.kick();
  await paused.promise;
  first.jump(10_000);
  resume.resolve();
  await drain;
  const recovered = new ConversationDispatcher(
    first.store,
    first.runtime,
    first.runner,
    first.sessions,
    {
      now: first.nowFn,
      ownerId: "dispatcher-lease",
      authorityEpoch: first.dispatcher.authorityEpoch,
    },
  );
  await recovered.kick();
  expect(first.store.getMemberTurn(accepted.memberTurn.id)?.origin).toBe("recovery");
  expect(captured[0]?.metadata?.origin).toBe("orchestration");
  expect(canMintHumanPermissionInteraction(captured[0]?.metadata?.origin)).toBe(false);
});

test("pre-start retry after internal failure is orchestration", async () => {
  const first = await createLifecycle({
    hooks: { failRuntimeMaterialize: true },
  });
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-prestart-retry-origin",
    content: "hello",
  });
  await first.dispatcher.kick();
  expect(first.store.getDispatchForRun(accepted.run.id)?.authorityEpoch).toBeUndefined();
  expect(first.store.getMemberTurn(accepted.memberTurn.id)?.origin).toBe("recovery");
  const retry = new ConversationDispatcher(
    first.store,
    first.runtime,
    first.runner,
    first.sessions,
    {
      now: first.nowFn,
      ownerId: "dispatcher-retry-origin",
      authorityEpoch: first.dispatcher.authorityEpoch,
    },
  );
  await retry.kick();
  expect(fakeRunner(first.runner).runs[0]?.executionOrigin).toBe("orchestration");
  expect(canMintHumanPermissionInteraction(fakeRunner(first.runner).runs[0]?.executionOrigin)).toBe(false);
});

test("wedged provider cancel returns, marks indeterminate, and cannot resurrect", async () => {
  const hang = deferred<ChatResponse>();
  let sourceTurnId = "";
  const started = deferred();
  const first = await createLifecycle({
    controlChat: async () => await hang.promise,
    runnerOptions: { cancelSettleTimeoutMs: 30 },
    hooks: {
      afterExecutionStart: async (turn) => {
        sourceTurnId = turn.sourceTurnId ?? "";
        started.resolve();
      },
    },
  });
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-wedge-cancel",
    content: "hello",
  });
  const drain = first.dispatcher.kick();
  await started.promise;
  const runner = first.runner as ControlConversationTurnRunner;
  await waitUntil(() => runner.hasTrackedExecution(sourceTurnId));
  const cancelStarted = Date.now();
  await first.service.cancelRun(accepted.run.id);
  expect(Date.now() - cancelStarted).toBeLessThan(1_000);
  await drain;
  expect(first.store.getRun(accepted.run.id)?.state).toBe("indeterminate");
  expect(first.store.getMemberTurn(accepted.memberTurn.id)?.state).toBe("indeterminate");
  hang.resolve({ text: "late-completion" });
  await tick();
  await tick();
  expect(first.store.getRun(accepted.run.id)?.state).toBe("indeterminate");
  expect(first.store.listMessages({
    conversationId: accepted.run.conversationId,
    topicId: accepted.run.topicId,
    limit: 10,
  }).filter((message) => message.role === "bot")).toEqual([]);
  await expect(first.service.teardownDirectConversation(BOT_ID)).rejects.toMatchObject({
    code: "conversation_indeterminate",
  });
});

test("createDirectTopic during teardown drain fails conversation_deleting", async () => {
  const hang = deferred();
  const runner = new FakeRunner();
  runner.hang = hang;
  const marked = deferred();
  const resumeDrain = deferred();
  const first = await createLifecycle({
    runner,
    afterTeardownMarkedDeleting: async () => {
      marked.resolve();
      await resumeDrain.promise;
    },
  });
  await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-topic-teardown",
    content: "hello",
  });
  const drain = first.dispatcher.kick();
  await waitUntil(() => runner.runs.length === 1);
  const teardown = first.service.teardownDirectConversation(BOT_ID);
  await marked.promise;
  await expect(first.service.createDirectTopic(BOT_ID, "During teardown")).rejects.toMatchObject({
    code: "conversation_deleting",
  });
  resumeDrain.resolve();
  await Promise.all([drain, teardown]);
  expect(Object.values(first.state.conversation_topics).some((topic) => topic.title === "During teardown")).toBe(false);
});

test("Conversation prompt uses the accepted snapshot, not a later live profile", async () => {
  const first = await createLifecycle();
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-snapshot-prompt",
    content: "check it",
    humanIngress: HUMAN_INGRESS,
  });
  await first.bots.updateBot(BOT_ID, { instructions: "Be terse." });
  await first.dispatcher.kick();
  expect(first.store.getRun(accepted.run.id)?.state).toBe("completed");
  const sent = fakeRunner(first.runner).runs[0]?.text ?? "";
  expect(fakeRunner(first.runner).runs[0]?.executionOrigin).toBe("human");
  expect(canMintHumanPermissionInteraction(fakeRunner(first.runner).runs[0]?.executionOrigin)).toBe(true);
  expect(sent).toContain("Focus on races.");
  expect(sent.includes("Be terse.")).toBe(false);
  expect(sent.includes("Role:")).toBe(false);
});

test("Conversation prompt leaves a whole-input runtime command unmodified", async () => {
  const first = await createLifecycle();
  await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-status-cmd",
    content: "/status",
    humanIngress: HUMAN_INGRESS,
  });
  await first.dispatcher.kick();
  expect(fakeRunner(first.runner).runs[0]?.text).toBe("/status");
  expect(fakeRunner(first.runner).runs[0]?.executionOrigin).toBe("human");
});

test("a wakeup during a transient pre-start failure still drains the other Topic", async () => {
  const paused = deferred();
  const resumeA = deferred();
  const first = await createLifecycle({
    hooks: {
      beforeRuntimeMaterialize: async (work) => {
        if (work.run.requestId === "req-wakeup-a") {
          paused.resolve();
          await resumeA.promise;
          throw new Error("transient materialize failure");
        }
      },
    },
  });
  const extra = await first.service.createDirectTopic(BOT_ID, "Second");
  const runA = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-wakeup-a",
    content: "alpha",
  });
  const drain = first.dispatcher.kick();
  await paused.promise;
  const runB = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-wakeup-b",
    content: "beta",
    topicId: extra.id,
  });
  await first.dispatcher.kick();
  resumeA.resolve();
  await drain;
  expect(first.store.getRun(runA.run.id)?.state).toBe("queued");
  expect(first.store.getDispatchForRun(runA.run.id)?.state).toBe("pending");
  expect(first.store.getRun(runB.run.id)?.state).toBe("completed");
  expect(fakeRunner(first.runner).runs).toHaveLength(1);
  expect(fakeRunner(first.runner).runs[0]?.text).toContain("beta");
});

test("a same-Topic wakeup after a one-shot materialize failure still drains A then B", async () => {
  const paused = deferred();
  const resumeA = deferred();
  let aFailures = 0;
  const first = await createLifecycle({
    hooks: {
      beforeRuntimeMaterialize: async (work) => {
        if (work.run.requestId !== "req-same-topic-a") {
          return;
        }
        if (aFailures === 0) {
          paused.resolve();
          await resumeA.promise;
          aFailures += 1;
          throw new Error("transient materialize failure");
        }
      },
    },
  });
  const runA = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-same-topic-a",
    content: "alpha",
  });
  const drain = first.dispatcher.kick();
  await paused.promise;
  const runB = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-same-topic-b",
    content: "beta",
  });
  await first.dispatcher.kick();
  resumeA.resolve();
  await drain;
  expect(aFailures).toBe(1);
  expect(first.store.getRun(runA.run.id)?.state).toBe("completed");
  expect(first.store.getRun(runB.run.id)?.state).toBe("completed");
  expect(fakeRunner(first.runner).runs.map((run) => run.text)).toEqual([
    expect.stringContaining("alpha"),
    expect.stringContaining("beta"),
  ]);
});

test("a persistent pre-start failure does not hot-loop without a new wake", async () => {
  let attempts = 0;
  const first = await createLifecycle({
    hooks: {
      failRuntimeMaterialize: () => {
        attempts += 1;
        return true;
      },
    },
  });
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-poison",
    content: "hello",
  });
  await first.dispatcher.kick();
  expect(attempts).toBe(1);
  expect(first.store.getRun(accepted.run.id)?.state).toBe("queued");
  expect(first.store.getDispatchForRun(accepted.run.id)?.state).toBe("pending");
  expect(fakeRunner(first.runner).runs).toHaveLength(0);
});

test("a gen-2 claimant cannot skip its deleting fence by joining gen-1 materialization", async () => {
  const aInsideGate = deferred();
  const aResume = deferred();
  const bAboutToMaterialize = deferred();
  const bAllowMaterialize = deferred();
  const deletingMarked = deferred();
  const fenceCalls: Array<{ generation: number; owner: string; code?: string }> = [];
  const started: Array<{ generation: number; owner: string }> = [];
  const runnerA = new FakeRunner();
  const first = await createLifecycle({
    runner: runnerA,
    ownerId: "dispatcher-a",
    leaseMs: 5_000,
    afterDirectSnapshot: async () => {
      if (fenceCalls.length === 1) {
        aInsideGate.resolve();
        await aResume.promise;
      }
    },
    afterTeardownMarkedDeleting: async () => {
      deletingMarked.resolve();
    },
  });
  const originalFence = first.store.assertLiveDispatchForMaterialize.bind(first.store);
  first.store.assertLiveDispatchForMaterialize = (input) => {
    try {
      originalFence(input);
      fenceCalls.push({ generation: input.generation, owner: input.owner });
    } catch (error) {
      const code = error instanceof ConversationError ? error.code : "unknown";
      fenceCalls.push({ generation: input.generation, owner: input.owner, code });
      throw error;
    }
  };
  const originalStart = first.store.markExecutionStarted.bind(first.store);
  first.store.markExecutionStarted = (input) => {
    const member = originalStart(input);
    started.push({ generation: input.generation, owner: input.owner });
    return member;
  };
  let materializeCalls = 0;
  const originalMaterialize = first.runtime.getOrCreateDirectSession.bind(first.runtime);
  first.runtime.getOrCreateDirectSession = async (input) => {
    materializeCalls += 1;
    return await originalMaterialize(input);
  };

  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-join-inflight-fence",
    content: "hello",
  });
  const drainA = first.dispatcher.kick();
  await aInsideGate.promise;
  expect(first.store.getDispatchForRun(accepted.run.id)).toMatchObject({
    generation: 1,
    owner: "dispatcher-a",
    state: "claimed",
  });
  expect(fenceCalls).toEqual([{ generation: 1, owner: "dispatcher-a" }]);
  expect(materializeCalls).toBe(1);

  const runnerB = new FakeRunner();
  const dispatcherB = new ConversationDispatcher(first.store, first.runtime, runnerB, first.sessions, {
    now: first.nowFn,
    ownerId: "dispatcher-b",
    leaseMs: 5_000,
    hooks: {
      afterAcceptedIdentityCheck: async () => {
        bAboutToMaterialize.resolve();
        await bAllowMaterialize.promise;
      },
    },
  });
  first.jump(10_000);
  const drainB = dispatcherB.kick();
  await bAboutToMaterialize.promise;
  expect(first.store.getDispatchForRun(accepted.run.id)).toMatchObject({
    generation: 2,
    owner: "dispatcher-b",
    state: "claimed",
  });
  expect(first.store.getMemberTurn(accepted.memberTurn.id)?.startedAt).toBeUndefined();

  const teardown = first.service.teardownDirectConversation(BOT_ID);
  await tick();
  bAllowMaterialize.resolve();
  await waitUntil(() => materializeCalls === 2);
  expect(fenceCalls).toEqual([{ generation: 1, owner: "dispatcher-a" }]);
  aResume.resolve();
  await deletingMarked.promise;
  await expect(teardown).resolves.toBeUndefined();
  await drainA;
  await drainB;

  expect(fenceCalls).toContainEqual({
    generation: 2,
    owner: "dispatcher-b",
    code: "conversation_deleting",
  });
  expect(started).toEqual([]);
  expect(first.store.getMemberTurn(accepted.memberTurn.id)?.startedAt).toBeUndefined();
  expect(runnerA.runs).toHaveLength(0);
  expect(runnerB.runs).toHaveLength(0);
  expect(first.store.listRuns(createDirectConversationId(BOT_ID))).toEqual([]);
  expect(first.state.sessions).toEqual({});
  expect(first.state.bot_runtime_bindings).toEqual({});
  expect(first.state.conversations).toEqual({});
  expect(first.state.conversation_topics).toEqual({});
});

test("a worker paused before materialize cannot resurrect runtime after teardown", async () => {
  const paused = deferred();
  const resume = deferred();
  const first = await createLifecycle({
    hooks: {
      beforeRuntimeMaterialize: async () => {
        paused.resolve();
        await resume.promise;
      },
    },
  });
  await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-resurrect",
    content: "hello",
  });
  const drain = first.dispatcher.kick();
  await paused.promise;
  await first.service.teardownDirectConversation(BOT_ID);
  expect(first.store.listRuns(createDirectConversationId(BOT_ID))).toEqual([]);
  expect(first.state.sessions).toEqual({});
  expect(first.state.bot_runtime_bindings).toEqual({});
  expect(first.state.conversations).toEqual({});
  expect(first.state.conversation_topics).toEqual({});
  resume.resolve();
  await drain;
  expect(first.store.listRuns(createDirectConversationId(BOT_ID))).toEqual([]);
  expect(first.state.sessions).toEqual({});
  expect(first.state.bot_runtime_bindings).toEqual({});
  expect(first.state.conversations).toEqual({});
  expect(first.state.conversation_topics).toEqual({});
  expect(fakeRunner(first.runner).runs).toHaveLength(0);
});

test("materialize high -> bot edit to default -> accept run A (snapshot effort=undefined) -> bot edit back to high -> dispatch A releases old high runtime and executes with default effort", async () => {
  const first = await createLifecycle();

  // 1. Update bot to effort: "high"
  await first.bots.updateBot(BOT_ID, { effort: "high" });

  // 2. Materialize high runtime
  const initialBinding = await first.runtime.getOrCreateDirectSession({ botId: BOT_ID });
  const initialSession = first.sessions.getLogicalSessionById(initialBinding.logicalSessionId);
  expect(initialSession?.effort).toBe("high");

  // 3. Edit Bot: effort = Default (cleared)
  await first.bots.updateBot(BOT_ID, { effort: null });
  expect(first.bots.getBot(BOT_ID).effort).toBeUndefined();

  // 4. Accept Run A with Bot effort = Default -> snapshot execution.effort is undefined
  const acceptedA = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req_run_a",
    content: "Run A",
  });
  expect(acceptedA.run.profileSnapshot.execution.effort).toBeUndefined();

  // 5. Edit Bot back to "high" BEFORE Run A is dispatched
  await first.bots.updateBot(BOT_ID, { effort: "high" });
  expect(first.bots.getBot(BOT_ID).effort).toBe("high");

  // 6. Dispatch Run A: must tear down old high runtime because accepted snapshot effort is undefined (Default)
  await first.dispatcher.kick();

  // Verify: old high session was physically deleted/released
  expect(first.physical.deleteCalls).toBeGreaterThanOrEqual(1);
  // Binding was recreated/rebound, session effort is undefined (clean Default)
  const activeBinding = Object.values(first.state.bot_runtime_bindings).find(
    (b) => b.botId === BOT_ID && b.scope === "bot-direct",
  );
  expect(activeBinding).toBeDefined();
  expect(activeBinding!.logicalSessionId).not.toBe(initialBinding.logicalSessionId);
  const activeSession = first.sessions.getLogicalSessionById(activeBinding!.logicalSessionId);
  expect(activeSession?.effort).toBeUndefined();

  // Run A completed successfully
  expect(fakeRunner(first.runner).runs).toHaveLength(1);
  expect(first.store.getRun(acceptedA.run.id)?.state).toBe("completed");
});

test("group topic lifecycle validates target, archives, and rejects direct paths", async () => {
  const first = await createLifecycle();
  const bots = first.bots;
  const reviewer = Object.values(first.state.bots)[0]!;
  seedTesterBot(first.state);
  const group = await bots.createGroup({ title: "Release Team", botIds: [reviewer.id, TESTER_ID], leadBotId: reviewer.id });
  // Unknown workspace and isolation fail closed.
  await expect(
    first.service.createGroupTopic(group.id, "Bad ws", { workspace: "nope", isolation: "shared" }),
  ).rejects.toMatchObject({ code: "workspace_not_registered" });
  await expect(
    first.service.createGroupTopic(group.id, "Bad iso", { workspace: "backend", isolation: "mesh" as never }),
  ).rejects.toMatchObject({ code: "invalid-isolation" });
  // Direct conversation id is rejected on the group path.
  const directConv = (await import("../../../src/domain/ids")).createDirectConversationId(reviewer.id);
  await expect(
    first.service.createGroupTopic(directConv, "Wrong kind", { workspace: "backend", isolation: "shared" }),
  ).rejects.toMatchObject({ code: "conversation_not_group" });
  const topic = await first.service.createGroupTopic(group.id, "Sprint 1", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  expect(topic.conversationId).toBe(group.id);
  expect(topic.executionTarget).toEqual({ workspace: "backend", isolation: "shared-single-writer" });
  expect(first.state.conversation_topics[topic.id]?.executionTarget?.isolation).toBe("shared-single-writer");
  const listed = first.service.listTopics(group.id);
  expect(listed.some((t) => t.id === topic.id)).toBe(true);
  const archived = await first.service.archiveGroupTopic(group.id, topic.id);
  expect(archived.status).toBe("archived");
  // Archiving twice is idempotent.
  const again = await first.service.archiveGroupTopic(group.id, topic.id);
  expect(again.status).toBe("archived");
});

test("group topic teardown releases member bindings and rows, retryable on release failure", async () => {
  const first = await createLifecycle();
  const bots = first.bots;
  const reviewer = Object.values(first.state.bots)[0]!;
  seedTesterBot(first.state);
  const group = await bots.createGroup({ title: "Release Team", botIds: [reviewer.id, TESTER_ID] });
  const topic = await first.service.createGroupTopic(group.id, "Sprint 1", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  const memberA = await first.runtime.getOrCreateGroupMemberSession({
    botId: reviewer.id, conversationId: group.id, topicId: topic.id,
  });
  const memberB = await first.runtime.getOrCreateGroupMemberSession({
    botId: TESTER_ID, conversationId: group.id, topicId: topic.id,
  });
  // Injected release failure leaves everything in place for retry.
  first.physical.fail = true;
  await expect(first.service.teardownGroupTopic(group.id, topic.id)).rejects.toMatchObject({
    code: "session_release_failed",
  });
  expect(first.state.conversation_topics[topic.id]).toBeDefined();
  expect(first.state.bot_runtime_bindings[memberA.id]).toBeDefined();
  first.physical.fail = false;
  await first.service.teardownGroupTopic(group.id, topic.id);
  expect(first.state.conversation_topics[topic.id]).toBeUndefined();
  expect(first.state.bot_runtime_bindings[memberA.id]).toBeUndefined();
  expect(first.state.bot_runtime_bindings[memberB.id]).toBeUndefined();
  expect(first.sessions.getLogicalSessionRecord(memberA.sessionAlias) ?? undefined).toBeUndefined();
  expect(first.sessions.getLogicalSessionRecord(memberB.sessionAlias) ?? undefined).toBeUndefined();
  // Group record itself survives topic teardown.
  expect(first.state.conversations[group.id]?.kind).toBe("group");
});

test("deleteGroup fails closed while topics, bindings, or durable rows exist", async () => {
  const first = await createLifecycle();
  const bots = first.bots;
  const reviewer = Object.values(first.state.bots)[0]!;
  seedTesterBot(first.state);
  const group = await bots.createGroup({ title: "Release Team", botIds: [reviewer.id, TESTER_ID] });
  const topic = await first.service.createGroupTopic(group.id, "Sprint 1", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  // Bare metadata delete is refused while a Topic exists.
  await expect(bots.deleteGroup(group.id)).rejects.toMatchObject({ code: "group_has_topics" });
  expect(first.state.conversations[group.id]).toBeDefined();
  // A stale binding with no Topic still blocks: seed crash residue directly.
  await first.service.teardownGroupTopic(group.id, topic.id);
  const { createScopedGroupMemberBindingId: scopedId } =
    await import("../../../src/domain/ids");
  const staleId = scopedId(group.id, topic.id, reviewer.id);
  first.state.bot_runtime_bindings[staleId] = {
    id: staleId,
    scope: "group-member",
    conversationId: group.id,
    topicId: topic.id,
    botId: reviewer.id,
    logicalSessionId: "00000000-0000-4000-8000-000000000000",
    sessionAlias: "brt_group_stale",
    createdAt: NOW,
    updatedAt: NOW,
  };
  await expect(bots.deleteGroup(group.id)).rejects.toMatchObject({ code: "group_has_runtime" });
  // Full verified teardown then deletes cleanly.
  await first.service.teardownGroupConversation(group.id);
  expect(first.state.conversations[group.id]).toBeUndefined();
});

test("group member session runs on the Topic workspace, not the Bot default", async () => {
  const first = await createLifecycle();
  const bots = first.bots;
  const reviewer = Object.values(first.state.bots)[0]!;
  seedTesterBot(first.state);
  const group = await bots.createGroup({ title: "Release Team", botIds: [reviewer.id, TESTER_ID] });
  const topic = await first.service.createGroupTopic(group.id, "Frontend work", {
    workspace: "frontend",
    isolation: "shared-single-writer",
  });
  // Reviewer default is backend; the Topic owns frontend.
  expect(reviewer.workspace).toBe("backend");
  const member = await first.runtime.getOrCreateGroupMemberSession({
    botId: reviewer.id, conversationId: group.id, topicId: topic.id,
  });
  const session = first.sessions.getLogicalSessionRecord(member.sessionAlias);
  expect(session?.workspace).toBe("frontend");
  expect(member.scope).toBe("group-member");
});

test("group topic teardown releases a binding-less crash-window member session", async () => {
  const first = await createLifecycle();
  const bots = first.bots;
  const reviewer = Object.values(first.state.bots)[0]!;
  seedTesterBot(first.state);
  const group = await bots.createGroup({ title: "Release Team", botIds: [reviewer.id, TESTER_ID] });
  const topic = await first.service.createGroupTopic(group.id, "Sprint 1", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  // Crash between session persist and binding publish: a legal
  // group-member owner session with no binding row.
  const { createScopedGroupMemberBindingId, ownedGroupMemberSessionAlias } =
    await import("../../../src/domain/ids");
  const bindingId = createScopedGroupMemberBindingId(group.id, topic.id, reviewer.id);
  const alias = ownedGroupMemberSessionAlias(bindingId);
  await first.sessions.createSession(alias, "codex", "backend", {
    owner: {
      kind: "group-member",
      bindingId,
      botId: reviewer.id,
      conversationId: group.id,
      topicId: topic.id,
    },
  });
  expect(first.state.bot_runtime_bindings[bindingId]).toBeUndefined();
  await first.service.teardownGroupTopic(group.id, topic.id);
  expect(first.sessions.getLogicalSessionRecord(alias) ?? undefined).toBeUndefined();
  expect(first.state.conversation_topics[topic.id]).toBeUndefined();
});

test("group topic teardown fails closed when alias and logical id disagree", async () => {
  const first = await createLifecycle();
  const bots = first.bots;
  const reviewer = Object.values(first.state.bots)[0]!;
  seedTesterBot(first.state);
  const group = await bots.createGroup({ title: "Release Team", botIds: [reviewer.id, TESTER_ID] });
  const topic = await first.service.createGroupTopic(group.id, "Sprint 1", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  const member = await first.runtime.getOrCreateGroupMemberSession({
    botId: reviewer.id, conversationId: group.id, topicId: topic.id,
  });
  // Corrupt the link: point the binding at a different logical id while the
  // alias still resolves. Teardown must fail closed with everything intact.
  const live = first.state.sessions[member.sessionAlias]!;
  const otherAlias = `${member.sessionAlias}-other`;
  await first.sessions.createSession(otherAlias, "codex", "backend");
  const other = first.state.sessions[otherAlias]!;
  first.state.bot_runtime_bindings[member.id] = {
    ...member,
    logicalSessionId: other.logical_session_id,
  };
  await expect(first.service.teardownGroupTopic(group.id, topic.id)).rejects.toMatchObject({
    code: "runtime_ownership_conflict",
  });
  expect(first.state.conversation_topics[topic.id]).toBeDefined();
  expect(first.state.bot_runtime_bindings[member.id]).toBeDefined();
  expect(first.state.sessions[member.sessionAlias]).toBeDefined();
});

test("group delete marks the barrier first: concurrent topic create fails closed", async () => {
  let releaseBarrier!: () => void;
  const barrierGate = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  const first = await createLifecycle({
    afterTeardownMarkedDeleting: () => barrierGate,
  });
  const bots = first.bots;
  const reviewer = Object.values(first.state.bots)[0]!;
  seedTesterBot(first.state);
  const group = await bots.createGroup({ title: "Release Team", botIds: [reviewer.id, TESTER_ID] });
  const topicA = await first.service.createGroupTopic(group.id, "Sprint 1", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  // Start the group delete; it pauses right after the barrier is set.
  const deleteCall = first.service.teardownGroupConversation(group.id);
  await new Promise((resolve) => setTimeout(resolve, 10));
  // A Topic create racing the delete now fails closed on the barrier.
  await expect(
    first.service.createGroupTopic(group.id, "Sprint B", {
      workspace: "backend",
      isolation: "shared",
    }),
  ).rejects.toMatchObject({ code: "conversation_deleting" });
  // Member materialize past the barrier fails closed too.
  await expect(
    first.runtime.getOrCreateGroupMemberSession({
      botId: reviewer.id, conversationId: group.id, topicId: topicA.id,
    }),
  ).rejects.toMatchObject({ code: "conversation_deleting" });
  releaseBarrier();
  await deleteCall;
  expect(first.state.conversations[group.id]).toBeUndefined();
});

test("group delete keeps the record when store row cleanup throws, retryable", async () => {
  const first = await createLifecycle();
  const bots = first.bots;
  const reviewer = Object.values(first.state.bots)[0]!;
  seedTesterBot(first.state);
  const group = await bots.createGroup({ title: "Release Team", botIds: [reviewer.id, TESTER_ID] });
  const topic = await first.service.createGroupTopic(group.id, "Sprint 1", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  // Poison deleteConversationRows once: the Group record + barrier must survive.
  const realDelete = first.store.deleteConversationRows.bind(first.store);
  let calls = 0;
  first.store.deleteConversationRows = (conversationId: string) => {
    calls += 1;
    if (calls === 1) {
      throw new Error("injected rows cleanup failure");
    }
    return realDelete(conversationId);
  };
  await expect(first.service.teardownGroupConversation(group.id)).rejects.toThrow(
    "injected rows cleanup failure",
  );
  // Record intact, barrier intact, topic already torn down.
  expect(first.state.conversations[group.id]).toBeDefined();
  expect(first.store.isConversationDeleting(group.id)).toBe(true);
  expect(first.state.conversations[group.id]?.lifecycle).toBe("deleting");
  expect(first.state.conversation_topics[topic.id]).toBeUndefined();
  // Retry succeeds end to end.
  await first.service.teardownGroupConversation(group.id);
  expect(first.state.conversations[group.id]).toBeUndefined();
  expect(first.store.hasDurableGroupWork(group.id)).toBe(false);
});

test("group topic teardown linearizes with a late member materializer instead of deadlocking", async () => {
  const first = await createLifecycle();
  seedTesterBot(first.state);
  const group = await first.bots.createGroup({ title: "Team", botIds: [BOT_ID, TESTER_ID] });
  const topic = await first.service.createGroupTopic(group.id, "Sprint", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  // Materialize one member so the binding exists.
  const binding = await first.runtime.getOrCreateGroupMemberSession({
    botId: BOT_ID, conversationId: group.id, topicId: topic.id,
  });
  expect(binding.sessionAlias).toBeDefined();
  // Start a second materializer for the other member, then tear down the
  // topic concurrently: the gate-held barrier must linearize, not deadlock.
  const late = first.runtime.getOrCreateGroupMemberSession({
    botId: TESTER_ID, conversationId: group.id, topicId: topic.id,
  });
  const teardown = first.service.teardownGroupTopic(group.id, topic.id);
  const settled = await Promise.race([
    Promise.allSettled([late, teardown]).then(() => "settled"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 4000)),
  ]);
  expect(settled).toBe("settled");
  const [lateOutcome] = await Promise.allSettled([late]);
  // Either the late materializer won the gate first (then teardown swept its
  // session) or it queued behind the barrier (then it failed closed). In both
  // cases teardown completes and no member session survives.
  await teardown;
  expect(first.state.conversation_topics[topic.id]).toBeUndefined();
  const survivors = Object.values(first.state.sessions).filter(
    (session) => session.owner?.kind === "group-member",
  );
  expect(survivors).toEqual([]);
  if (lateOutcome.status === "rejected") {
    expect(lateOutcome.reason).toBeInstanceOf(Error);
  }
  first.store.close();
});

test("topic teardown never releases another topic's session via a partial legacy owner", async () => {
  const first = await createLifecycle();
  seedTesterBot(first.state);
  const group = await first.bots.createGroup({ title: "Team", botIds: [BOT_ID, TESTER_ID] });
  const topicA = await first.service.createGroupTopic(group.id, "A", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  const topicB = await first.service.createGroupTopic(group.id, "B", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  // Topic B: live binding + session whose owner is a partial legacy shape
  // ({ kind, bindingId } only, no scope fields).
  const bindingB = await first.runtime.getOrCreateGroupMemberSession({
    botId: BOT_ID, conversationId: group.id, topicId: topicB.id,
  });
  const sessionB = first.state.sessions[bindingB.sessionAlias]!;
  sessionB.owner = { kind: "group-member", bindingId: bindingB.id };
  // Teardown A must leave B's session and binding untouched.
  await first.service.teardownGroupTopic(group.id, topicA.id);
  expect(first.state.conversation_topics[topicA.id]).toBeUndefined();
  expect(first.state.sessions[bindingB.sessionAlias]).toBeDefined();
  expect(first.state.bot_runtime_bindings[bindingB.id]).toBeDefined();
  first.store.close();
});

test("multi-member accept persists one run with N turns and N dispatches across reopen", async () => {
  const first = await createLifecycle();
  seedTesterBot(first.state);
  const group = await first.bots.createGroup({ title: "Team", botIds: [BOT_ID, TESTER_ID] });
  const topic = await first.service.createGroupTopic(group.id, "Sprint", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  const botA = first.bots.getBot(BOT_ID);
  const botB = first.bots.getBot(TESTER_ID);
  const { snapshotBotProfile } = await import("../../../src/bots/bot-types");
  const accepted = first.store.acceptRequest({
    conversationId: group.id,
    topicId: topic.id,
    requestId: "req-multi",
    botId: botA.id,
    content: "review it",
    profileSnapshot: snapshotBotProfile(botA, NOW),
    mode: "automatic",
    members: [{
      botId: botB.id,
      profileSnapshot: snapshotBotProfile(botB, NOW),
      assignmentId: "assign_b",
      task: "Write tests",
      expectedOutput: "passing suite",
      dependsOn: ["assign_a"],
    }],
    now: NOW,
  });
  expect(accepted.memberTurns).toHaveLength(2);
  expect(accepted.dispatches).toHaveLength(2);
  expect(accepted.run.mode).toBe("automatic");
  // Reopen the same SQLite file: everything round-trips.
  first.store.close();
  const reopened = await SqliteConversationStore.open(first.path);
  const run = reopened.getRun(accepted.run.id);
  expect(run?.mode).toBe("automatic");
  const turns = reopened.listMemberTurns(accepted.run.id);
  expect(turns).toHaveLength(2);
  const dispatches = reopened.listDispatchesForRun(accepted.run.id);
  expect(dispatches).toHaveLength(2);
  const turnB = turns.find((turn) => turn.botId === botB.id)!;
  expect(turnB.assignmentId).toBe("assign_b");
  expect(turnB.task).toBe("Write tests");
  expect(turnB.expectedOutput).toBe("passing suite");
  expect(turnB.dependsOn).toEqual(["assign_a"]);
  expect(reopened.getDispatchForMemberTurn(turnB.id)?.runId).toBe(accepted.run.id);
  reopened.close();
});

test("binding-less group session pins agent identity across updateBot and recovery", async () => {
  const first = await createLifecycle();
  seedTesterBot(first.state);
  const group = await first.bots.createGroup({ title: "Team", botIds: [BOT_ID, TESTER_ID] });
  const topic = await first.service.createGroupTopic(group.id, "Sprint", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  // Crash window: session persisted, binding never published. Simulate by
  // materializing then dropping the binding row only.
  const binding = await first.runtime.getOrCreateGroupMemberSession({
    botId: BOT_ID, conversationId: group.id, topicId: topic.id,
  });
  const alias = binding.sessionAlias;
  const saved = first.state.bot_runtime_bindings[binding.id];
  delete first.state.bot_runtime_bindings[binding.id];
  expect(first.state.sessions[alias]).toBeDefined();
  // Agent change must now fail closed: the binding-less session still locks identity.
  await expect(first.bots.updateBot(BOT_ID, { agent: "claude" })).rejects.toMatchObject({
    code: "runtime_identity_locked",
  });
  // And recovery with a mismatched execution fails instead of adopting stale context.
  await expect(first.runtime.getOrCreateGroupMemberSession({
    botId: BOT_ID,
    conversationId: group.id,
    topicId: topic.id,
    execution: { agent: "claude", workspace: "backend" },
  })).rejects.toMatchObject({ code: "runtime_revision_mismatch" });
  expect(saved).toBeDefined();
  first.store.close();
});

test("group member materialize without an execution target fails closed", async () => {
  const first = await createLifecycle();
  seedTesterBot(first.state);
  const group = await first.bots.createGroup({ title: "Team", botIds: [BOT_ID, TESTER_ID] });
  const topicId = "topic_no_target_1";
  first.state.conversation_topics[topicId] = {
    id: topicId,
    conversationId: group.id,
    title: "Legacy",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
  await expect(first.runtime.getOrCreateGroupMemberSession({
    botId: BOT_ID, conversationId: group.id, topicId,
  })).rejects.toMatchObject({ code: "execution_target_missing" });
  first.store.close();
});

test("second member dispatches against its own execution snapshot, not the first member's", async () => {
  const first = await createLifecycle();
  seedTesterBot(first.state);
  const group = await first.bots.createGroup({ title: "Team", botIds: [BOT_ID, TESTER_ID] });
  const topic = await first.service.createGroupTopic(group.id, "Sprint", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  // Reviewer runs codex/backend; Tester runs claude/frontend: disjoint axes so
  // a snapshot mix-up fails loudly instead of passing by coincidence.
  await first.bots.updateBot(TESTER_ID, { agent: "claude", workspace: "frontend" });
  const botA = first.bots.getBot(BOT_ID);
  const botB = first.bots.getBot(TESTER_ID);
  const { snapshotBotProfile } = await import("../../../src/bots/bot-types");
  const accepted = first.store.acceptRequest({
    conversationId: group.id,
    topicId: topic.id,
    requestId: "req-snap",
    botId: botA.id,
    content: "review it",
    profileSnapshot: snapshotBotProfile(botA, NOW),
    members: [{
      botId: botB.id,
      profileSnapshot: snapshotBotProfile(botB, NOW),
      assignmentId: "assign_b",
      task: "Write tests",
    }],
    now: NOW,
  });
  const turnB = accepted.memberTurns.find((turn) => turn.botId === botB.id)!;
  expect(turnB.profileSnapshot?.execution).toMatchObject({ agent: "claude", workspace: "frontend" });
  // Claim order is seq-stable: claim A first, then B must still be claimable
  // (Run stays non-terminal with a runnable sibling) and carry B's snapshot.
  const claimA = first.store.claimNextDispatch({
    now: NOW, owner: "dispatcher-a", leaseExpiresAt: "2026-09-15T12:05:00.000Z", authorityEpoch: "epoch-a",
  });
  expect(claimA?.memberTurn.botId).toBe(botA.id);
  expect(claimA?.memberSnapshot.execution).toMatchObject({ agent: "codex", workspace: "backend" });
  const claimB = first.store.claimNextDispatch({
    now: NOW, owner: "dispatcher-a", leaseExpiresAt: "2026-09-15T12:05:00.000Z", authorityEpoch: "epoch-a",
  });
  expect(claimB?.memberTurn.botId).toBe(botB.id);
  expect(claimB?.memberSnapshot.execution).toMatchObject({ agent: "claude", workspace: "frontend" });
  expect(claimB?.run.state).not.toBe("completed");
  first.store.close();
});

test("explicit run aggregates: first completion leaves the run non-terminal until all members finish", async () => {
  const first = await createLifecycle();
  seedTesterBot(first.state);
  const group = await first.bots.createGroup({ title: "Team", botIds: [BOT_ID, TESTER_ID] });
  const topic = await first.service.createGroupTopic(group.id, "Sprint", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  const botA = first.bots.getBot(BOT_ID);
  const botB = first.bots.getBot(TESTER_ID);
  const { snapshotBotProfile } = await import("../../../src/bots/bot-types");
  const accepted = first.store.acceptRequest({
    conversationId: group.id,
    topicId: topic.id,
    requestId: "req-agg",
    botId: botA.id,
    content: "ship it",
    profileSnapshot: snapshotBotProfile(botA, NOW),
    members: [{ botId: botB.id, profileSnapshot: snapshotBotProfile(botB, NOW) }],
    now: NOW,
  });
  expect(accepted.run.maxMemberTurns).toBe(2);
  // Complete A's turn (claim -> start -> complete through the store).
  const claimA = first.store.claimNextDispatch({
    now: NOW, owner: "dispatcher-a", leaseExpiresAt: "2026-09-15T12:05:00.000Z", authorityEpoch: "epoch-a",
  })!;
  const startedA = first.store.markExecutionStarted({
    dispatchId: claimA.dispatch.id, owner: "dispatcher-a", generation: 1,
    runId: accepted.run.id, memberTurnId: claimA.memberTurn.id,
    sessionAlias: "sess_a", logicalSessionId: "lsess_a", sourceTurnId: "sturn_a", now: NOW,
  });
  expect(startedA.state).toBe("running");
  const afterA = first.store.completeExecution({
    runId: accepted.run.id, memberTurnId: claimA.memberTurn.id, botId: botA.id,
    content: "done a", sourceTurn: { sessionAlias: "sess_a", turnId: "sturn_a" }, now: NOW,
  });
  // Run must NOT be terminal: B is still queued and claimable.
  expect(afterA.run.state).not.toBe("completed");
  expect(afterA.run.consumedMemberTurns).toBe(1);
  const claimB = first.store.claimNextDispatch({
    now: NOW, owner: "dispatcher-a", leaseExpiresAt: "2026-09-15T12:05:00.000Z", authorityEpoch: "epoch-a",
  });
  expect(claimB?.memberTurn.botId).toBe(botB.id);
  const startedB = first.store.markExecutionStarted({
    dispatchId: claimB.dispatch.id, owner: "dispatcher-a", generation: 1,
    runId: accepted.run.id, memberTurnId: claimB.memberTurn.id,
    sessionAlias: "sess_b", logicalSessionId: "lsess_b", sourceTurnId: "sturn_b", now: NOW,
  });
  expect(startedB.state).toBe("running");
  const afterB = first.store.completeExecution({
    runId: accepted.run.id, memberTurnId: claimB.memberTurn.id, botId: botB.id,
    content: "done b", sourceTurn: { sessionAlias: "sess_b", turnId: "sturn_b" }, now: NOW,
  });
  expect(afterB.run.state).toBe("completed");
  expect(afterB.run.completionReason).toBe("members-completed");
  expect(afterB.run.consumedMemberTurns).toBe(2);
  first.store.close();
});

test("failed member accumulates failedBotIds; run fails only after the batch settles", async () => {
  const first = await createLifecycle();
  seedTesterBot(first.state);
  const group = await first.bots.createGroup({ title: "Team", botIds: [BOT_ID, TESTER_ID] });
  const topic = await first.service.createGroupTopic(group.id, "Sprint", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  const botA = first.bots.getBot(BOT_ID);
  const botB = first.bots.getBot(TESTER_ID);
  const { snapshotBotProfile } = await import("../../../src/bots/bot-types");
  const accepted = first.store.acceptRequest({
    conversationId: group.id,
    topicId: topic.id,
    requestId: "req-fail",
    botId: botA.id,
    content: "go",
    profileSnapshot: snapshotBotProfile(botA, NOW),
    members: [{ botId: botB.id, profileSnapshot: snapshotBotProfile(botB, NOW) }],
    now: NOW,
  });
  const failed = first.store.failExecution({
    runId: accepted.run.id, memberTurnId: accepted.memberTurns[0]!.id, now: NOW, reason: "boom",
  });
  expect(failed.state).not.toBe("failed");
  expect(failed.failedBotIds).toContain(botA.id);
  const afterB = first.store.completeExecution({
    runId: accepted.run.id, memberTurnId: accepted.memberTurns[1]!.id, botId: botB.id,
    content: "done b", sourceTurn: { sessionAlias: "sess_b", turnId: "sturn_b" }, now: NOW,
  });
  expect(afterB.run.state).toBe("failed");
  expect(afterB.run.failedBotIds).toContain(botA.id);
  first.store.close();
});

test("failed+failed accumulates both bots; failed+indeterminate yields indeterminate", async () => {
  const { snapshotBotProfile } = await import("../../../src/bots/bot-types");
  const setup = async (requestId: string) => {
    const first = await createLifecycle();
    seedTesterBot(first.state);
    const group = await first.bots.createGroup({ title: "Team", botIds: [BOT_ID, TESTER_ID] });
    const topic = await first.service.createGroupTopic(group.id, "Sprint", {
      workspace: "backend",
      isolation: "shared-single-writer",
    });
    const botA = first.bots.getBot(BOT_ID);
    const botB = first.bots.getBot(TESTER_ID);
    const accepted = first.store.acceptRequest({
      conversationId: group.id,
      topicId: topic.id,
      requestId,
      botId: botA.id,
      content: "go",
      profileSnapshot: snapshotBotProfile(botA, NOW),
      members: [{ botId: botB.id, profileSnapshot: snapshotBotProfile(botB, NOW) }],
      now: NOW,
    });
    return { first, botA, botB, accepted };
  };
  {
    const { first, botA, botB, accepted } = await setup("req-fail-fail");
    first.store.failExecution({
      runId: accepted.run.id, memberTurnId: accepted.memberTurns[0]!.id, now: NOW, reason: "boom-a",
    });
    const done = first.store.failExecution({
      runId: accepted.run.id, memberTurnId: accepted.memberTurns[1]!.id, now: NOW, reason: "boom-b",
    });
    expect(done.state).toBe("failed");
    expect(done.completionReason).toBe("execution-failed");
    expect(done.failedBotIds).toContain(botA.id);
    expect(done.failedBotIds).toContain(botB.id);
    first.store.close();
  }
  {
    const { first, botA, accepted } = await setup("req-fail-ind");
    first.store.failExecution({
      runId: accepted.run.id, memberTurnId: accepted.memberTurns[0]!.id, now: NOW, reason: "boom",
    });
    const done = first.store.failExecution({
      runId: accepted.run.id, memberTurnId: accepted.memberTurns[1]!.id, now: NOW,
      reason: "started_result_unknown", terminalState: "indeterminate",
    });
    // Indeterminate (unproven side effects) outranks failed regardless of order.
    expect(done.state).toBe("indeterminate");
    expect(done.completionReason).toBe("started_result_unknown");
    expect(done.failedBotIds).toContain(botA.id);
    first.store.close();
  }
});

test("failed+cancelled aggregates to failed with a derived reason, not the last event's", async () => {
  const first = await createLifecycle();
  seedTesterBot(first.state);
  const group = await first.bots.createGroup({ title: "Team", botIds: [BOT_ID, TESTER_ID] });
  const topic = await first.service.createGroupTopic(group.id, "Sprint", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  const botA = first.bots.getBot(BOT_ID);
  const botB = first.bots.getBot(TESTER_ID);
  const { snapshotBotProfile } = await import("../../../src/bots/bot-types");
  const accepted = first.store.acceptRequest({
    conversationId: group.id,
    topicId: topic.id,
    requestId: "req-fail-cancel",
    botId: botA.id,
    content: "go",
    profileSnapshot: snapshotBotProfile(botA, NOW),
    members: [{ botId: botB.id, profileSnapshot: snapshotBotProfile(botB, NOW) }],
    now: NOW,
  });
  first.store.failExecution({
    runId: accepted.run.id, memberTurnId: accepted.memberTurns[0]!.id, now: NOW, reason: "boom",
  });
  const done = first.store.failExecution({
    runId: accepted.run.id, memberTurnId: accepted.memberTurns[1]!.id, now: NOW,
    reason: "cancelled", terminalState: "cancelled",
  });
  expect(done.state).toBe("failed");
  expect(done.completionReason).toBe("execution-failed");
  first.store.close();
});

test("replayed member completion is idempotent: no second message, no double progress", async () => {
  const first = await createLifecycle();
  seedTesterBot(first.state);
  const group = await first.bots.createGroup({ title: "Team", botIds: [BOT_ID, TESTER_ID] });
  const topic = await first.service.createGroupTopic(group.id, "Sprint", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  const botA = first.bots.getBot(BOT_ID);
  const botB = first.bots.getBot(TESTER_ID);
  const { snapshotBotProfile } = await import("../../../src/bots/bot-types");
  const accepted = first.store.acceptRequest({
    conversationId: group.id,
    topicId: topic.id,
    requestId: "req-replay",
    botId: botA.id,
    content: "go",
    profileSnapshot: snapshotBotProfile(botA, NOW),
    members: [{ botId: botB.id, profileSnapshot: snapshotBotProfile(botB, NOW) }],
    now: NOW,
  });
  const once = first.store.completeExecution({
    runId: accepted.run.id, memberTurnId: accepted.memberTurns[0]!.id, botId: botA.id,
    content: "done a", sourceTurn: { sessionAlias: "sess_a", turnId: "sturn_a" }, now: NOW,
  });
  expect(once.memberTurn.state).toBe("completed");
  const botMessages = () => first.store.listMessages({
    conversationId: group.id, topicId: topic.id, limit: 10,
  }).filter((message) => message.role === "bot");
  expect(botMessages()).toHaveLength(1);
  expect(first.store.getRun(accepted.run.id)?.consumedMemberTurns).toBe(1);
  // Late provider settlement redelivers A's completion: must be a no-op.
  const replay = first.store.completeExecution({
    runId: accepted.run.id, memberTurnId: accepted.memberTurns[0]!.id, botId: botA.id,
    content: "done a again", sourceTurn: { sessionAlias: "sess_a", turnId: "sturn_a" }, now: NOW,
  });
  expect(replay.memberTurn.state).toBe("completed");
  expect(replay.assistantMessage).toBeUndefined();
  expect(botMessages()).toHaveLength(1);
  expect(first.store.getRun(accepted.run.id)?.consumedMemberTurns).toBe(1);
  expect(first.store.getRun(accepted.run.id)?.state).not.toBe("completed");
  // Replayed member failure is equally a no-op.
  const refail = first.store.failExecution({
    runId: accepted.run.id, memberTurnId: accepted.memberTurns[0]!.id, now: NOW, reason: "boom",
  });
  expect(first.store.getRun(accepted.run.id)?.consumedMemberTurns).toBe(1);
  expect(refail.failedBotIds).not.toContain(botA.id);
  first.store.close();
});

test("automatic run stays routing-eligible after the batch settles completed", async () => {
  const first = await createLifecycle();
  seedTesterBot(first.state);
  const group = await first.bots.createGroup({ title: "Team", botIds: [BOT_ID, TESTER_ID] });
  const topic = await first.service.createGroupTopic(group.id, "Sprint", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  const botA = first.bots.getBot(BOT_ID);
  const botB = first.bots.getBot(TESTER_ID);
  const { snapshotBotProfile } = await import("../../../src/bots/bot-types");
  const accepted = first.store.acceptRequest({
    conversationId: group.id,
    topicId: topic.id,
    requestId: "req-auto-batch",
    botId: botA.id,
    content: "ship it",
    profileSnapshot: snapshotBotProfile(botA, NOW),
    mode: "automatic",
    members: [{ botId: botB.id, profileSnapshot: snapshotBotProfile(botB, NOW) }],
    now: NOW,
  });
  for (const turn of accepted.memberTurns) {
    first.store.completeExecution({
      runId: accepted.run.id, memberTurnId: turn.id, botId: turn.botId,
      content: `done ${turn.botId}`, sourceTurn: { sessionAlias: `sess_${turn.botId}` }, now: NOW,
    });
  }
  const settled = first.store.getRun(accepted.run.id)!;
  // Batch done, but the automatic Run must NOT terminal: PR8 Router reads
  // durable MemberTurns and decides dispatch / need-human / complete.
  expect(settled.state).toBe("running");
  expect(settled.finishedAt).toBeUndefined();
  expect(settled.consumedMemberTurns).toBe(2);
  expect(first.store.listMemberTurns(accepted.run.id).every((turn) => turn.state === "completed")).toBe(true);
  first.store.close();
});

test("dispatch migration crash before commit keeps the old table intact", async () => {
  const { join } = await import("node:path");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { createSqlDriver } = await import("../../../src/conversations/sql-driver");
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-mig-")), "conversation.sqlite");
  // Build a legacy-shaped database by hand: UNIQUE(run_id) + no new columns.
  const raw = await createSqlDriver(path);
  raw.exec("DROP TABLE IF EXISTS pending_dispatches");
  raw.exec(`CREATE TABLE pending_dispatches (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, member_turn_id TEXT NOT NULL,
    generation INTEGER NOT NULL, state TEXT NOT NULL, owner TEXT, lease_expires_at TEXT,
    authority_epoch TEXT, human_ingress TEXT, created_at TEXT NOT NULL, claimed_at TEXT, completed_at TEXT)`);
  raw.exec(`INSERT INTO pending_dispatches (id, run_id, member_turn_id, generation, state, created_at)
    VALUES ('pdsp_1', 'run_1', 'mturn_1', 1, 'pending', '${NOW}')`);
  raw.close();
  // Open with a fault that throws inside the migration transaction: the open
  // itself must throw, and the old table must be fully intact on reopen.
  await expect(SqliteConversationStore.open(path, {
    beforeDispatchMigrationCommit: () => {
      throw new Error("injected migration crash");
    },
  })).rejects.toThrow("injected migration crash");
  const reopened = await SqliteConversationStore.open(path);
  expect(reopened.getDispatchForRun("run_1")?.id).toBe("pdsp_1");
  reopened.close();
});

test("group topic with a non-empty cwd fails closed instead of persisting a silent no-op", async () => {
  const first = await createLifecycle();
  seedTesterBot(first.state);
  const group = await first.bots.createGroup({ title: "Team", botIds: [BOT_ID, TESTER_ID] });
  await expect(first.service.createGroupTopic(group.id, "Subdir", {
    workspace: "backend", cwd: "/tmp/backend/subdir", isolation: "shared-single-writer",
  })).rejects.toMatchObject({ code: "cwd_unsupported" });
  expect(Object.values(first.state.conversation_topics)).toHaveLength(0);
  first.store.close();
});


test("cancel targets the actually-started member, not members[0]", async () => {
  const first = await createLifecycle();
  seedTesterBot(first.state);
  const group = await first.bots.createGroup({ title: "Team", botIds: [BOT_ID, TESTER_ID] });
  const topic = await first.service.createGroupTopic(group.id, "Sprint", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  const botA = first.bots.getBot(BOT_ID);
  const botB = first.bots.getBot(TESTER_ID);
  const { snapshotBotProfile } = await import("../../../src/bots/bot-types");
  const accepted = first.store.acceptRequest({
    conversationId: group.id,
    topicId: topic.id,
    requestId: "req-cancel-second",
    botId: botA.id,
    content: "go",
    profileSnapshot: snapshotBotProfile(botA, NOW),
    members: [{ botId: botB.id, profileSnapshot: snapshotBotProfile(botB, NOW) }],
    now: NOW,
  });
  // Start exactly one member (whichever the claim serves); the other stays
  // queued. Cancel must settle the queued sibling and report the started
  // member as active — never members[0] by position.
  const claim = first.store.claimNextDispatch({
    now: NOW, owner: "dispatcher-a", leaseExpiresAt: "2026-09-15T12:05:00.000Z", authorityEpoch: "epoch-a",
  })!;
  const startedId = claim.memberTurn.id;
  const queuedId = accepted.memberTurns.find((t) => t.id !== startedId)!.id;
  const started = first.store.markExecutionStarted({
    dispatchId: claim.dispatch.id, owner: "dispatcher-a", generation: claim.dispatch.generation,
    runId: accepted.run.id, memberTurnId: startedId,
    sessionAlias: "sess_x", logicalSessionId: "lsess_x", sourceTurnId: "sturn_x", now: NOW,
  });
  expect(started.state).toBe("running");
  const outcome = first.store.cancelRun(accepted.run.id, NOW, "cancelled");
  expect(outcome.executionStarted).toBe(true);
  expect(outcome.activeMembers.map((m) => m.id)).toEqual([startedId]);
  expect(outcome.memberTurn.id).toBe(startedId);
  expect(first.store.getMemberTurn(queuedId)?.state).toBe("cancelled");
  expect(first.store.getRun(accepted.run.id)?.state).not.toBe("cancelled");
  first.store.close();
});

test("recovery of one sibling never resets a running run to queued", async () => {
  const first = await createLifecycle();
  seedTesterBot(first.state);
  const group = await first.bots.createGroup({ title: "Team", botIds: [BOT_ID, TESTER_ID] });
  const topic = await first.service.createGroupTopic(group.id, "Sprint", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  const botA = first.bots.getBot(BOT_ID);
  const botB = first.bots.getBot(TESTER_ID);
  const { snapshotBotProfile } = await import("../../../src/bots/bot-types");
  const accepted = first.store.acceptRequest({
    conversationId: group.id,
    topicId: topic.id,
    requestId: "req-rec-guard",
    botId: botA.id,
    content: "go",
    profileSnapshot: snapshotBotProfile(botA, NOW),
    members: [{ botId: botB.id, profileSnapshot: snapshotBotProfile(botB, NOW) }],
    now: NOW,
  });
  // A starts; B claims but never starts, then B's lease expires.
  const claimA = first.store.claimNextDispatch({
    now: NOW, owner: "dispatcher-a", leaseExpiresAt: "2026-09-15T12:05:00.000Z", authorityEpoch: "epoch-a",
  })!;
  first.store.markExecutionStarted({
    dispatchId: claimA.dispatch.id, owner: "dispatcher-a", generation: 1,
    runId: accepted.run.id, memberTurnId: claimA.memberTurn.id,
    sessionAlias: "sess_a", logicalSessionId: "lsess_a", sourceTurnId: "sturn_a", now: NOW,
  });
  const claimB = first.store.claimNextDispatch({
    now: NOW, owner: "dispatcher-a", leaseExpiresAt: "2026-09-15T12:05:00.000Z", authorityEpoch: "epoch-a",
  })!;
  expect(claimB.memberTurn.botId).toBe(botB.id);
  const recovered = first.store.recoverExpiredClaims("2026-09-15T12:06:00.000Z");
  expect(recovered.find((r) => r.memberTurn.botId === botB.id)?.outcome).toBe("requeued");
  // The Run stays running with started_at intact: A still executes.
  const run = first.store.getRun(accepted.run.id)!;
  expect(run.state).toBe("running");
  expect(run.startedAt).toBeDefined();
  // A queued next Run on the same topic must NOT become claimable: the
  // next claim serves B's requeued dispatch (same running Run), and the Run
  // after stays blocked while A executes.
  const botA2 = first.bots.getBot(BOT_ID);
  first.store.acceptRequest({
    conversationId: group.id,
    topicId: topic.id,
    requestId: "req-next",
    botId: botA2.id,
    content: "next",
    profileSnapshot: snapshotBotProfile(botA2, NOW),
    now: NOW,
  });
  const reclaimed = first.store.claimNextDispatch({
    now: "2026-09-15T12:06:00.000Z", owner: "dispatcher-a",
    leaseExpiresAt: "2026-09-15T12:07:00.000Z", authorityEpoch: "epoch-a",
  });
  expect(reclaimed?.run.id).toBe(accepted.run.id);
  expect(reclaimed?.memberTurn.botId).toBe(botB.id);
  expect(first.store.claimNextDispatch({
    now: "2026-09-15T12:06:00.000Z", owner: "dispatcher-a",
    leaseExpiresAt: "2026-09-15T12:07:00.000Z", authorityEpoch: "epoch-a",
  })).toBeUndefined();
  first.store.close();
});

test("unknown settlement and lease recovery converge on the same indeterminate state", async () => {
  const { snapshotBotProfile } = await import("../../../src/bots/bot-types");
  const setup = async (requestId: string, mode: "explicit" | "automatic") => {
    const first = await createLifecycle();
    seedTesterBot(first.state);
    const group = await first.bots.createGroup({ title: "Team", botIds: [BOT_ID, TESTER_ID] });
    const topic = await first.service.createGroupTopic(group.id, "Sprint", {
      workspace: "backend",
      isolation: "shared-single-writer",
    });
    const botA = first.bots.getBot(BOT_ID);
    const botB = first.bots.getBot(TESTER_ID);
    const accepted = first.store.acceptRequest({
      conversationId: group.id,
      topicId: topic.id,
      requestId,
      botId: botA.id,
      content: "go",
      profileSnapshot: snapshotBotProfile(botA, NOW),
      mode,
      members: [{ botId: botB.id, profileSnapshot: snapshotBotProfile(botB, NOW) }],
      now: NOW,
    });
    return { first, botA, botB, accepted };
  };
  // Path 1: runner-settled unknown via completeCancel(..., true).
  {
    const { first, accepted } = await setup("req-ind-1", "automatic");
    const run = first.store.completeCancel(accepted.run.id, accepted.memberTurns[0]!.id, NOW, true);
    expect(run.state).toBe("indeterminate");
    expect(run.completionReason).toBe("started_result_unknown");
    expect(first.store.getMemberTurn(accepted.memberTurns[1]!.id)?.state).toBe("indeterminate");
    expect(first.store.claimNextDispatch({
      now: NOW, owner: "dispatcher-a", leaseExpiresAt: "2026-09-15T12:05:00.000Z", authorityEpoch: "epoch-a",
    })).toBeUndefined();
    first.store.close();
  }
  // Path 2: lease recovery of a started claim.
  {
    const { first, accepted } = await setup("req-ind-2", "automatic");
    const claim = first.store.claimNextDispatch({
      now: NOW, owner: "dispatcher-a", leaseExpiresAt: "2026-09-15T12:05:00.000Z", authorityEpoch: "epoch-a",
    })!;
    first.store.markExecutionStarted({
      dispatchId: claim.dispatch.id, owner: "dispatcher-a", generation: 1,
      runId: accepted.run.id, memberTurnId: claim.memberTurn.id,
      sessionAlias: "sess", logicalSessionId: "lsess", sourceTurnId: "sturn", now: NOW,
    });
    const recovered = first.store.recoverExpiredClaims("2026-09-15T12:06:00.000Z");
    expect(recovered[0]?.outcome).toBe("indeterminate");
    const run = first.store.getRun(accepted.run.id)!;
    expect(run.state).toBe("indeterminate");
    expect(run.completionReason).toBe("started_result_unknown");
    expect(first.store.getMemberTurn(accepted.memberTurns[1]!.id)?.state).toBe("indeterminate");
    expect(first.store.claimNextDispatch({
      now: "2026-09-15T12:06:00.000Z", owner: "dispatcher-a",
      leaseExpiresAt: "2026-09-15T12:07:00.000Z", authorityEpoch: "epoch-a",
    })).toBeUndefined();
    first.store.close();
  }
});

test("teardown fails closed while a multi-member run still has live work", async () => {
  const first = await createLifecycle();
  seedTesterBot(first.state);
  const group = await first.bots.createGroup({ title: "Team", botIds: [BOT_ID, TESTER_ID] });
  const topic = await first.service.createGroupTopic(group.id, "Sprint", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  const botA = first.bots.getBot(BOT_ID);
  const botB = first.bots.getBot(TESTER_ID);
  const { snapshotBotProfile } = await import("../../../src/bots/bot-types");
  // Automatic run: cancel settles B but leaves the run running for the Router,
  // so teardown must refuse to release runtime underneath it.
  const accepted = first.store.acceptRequest({
    conversationId: group.id,
    topicId: topic.id,
    requestId: "req-td-auto",
    botId: botA.id,
    content: "go",
    profileSnapshot: snapshotBotProfile(botA, NOW),
    mode: "automatic",
    members: [{ botId: botB.id, profileSnapshot: snapshotBotProfile(botB, NOW) }],
    now: NOW,
  });
  const claim = first.store.claimNextDispatch({
    now: NOW, owner: "dispatcher-a", leaseExpiresAt: "2026-09-15T12:05:00.000Z", authorityEpoch: "epoch-a",
  })!;
  first.store.markExecutionStarted({
    dispatchId: claim.dispatch.id, owner: "dispatcher-a", generation: claim.dispatch.generation,
    runId: accepted.run.id, memberTurnId: claim.memberTurn.id,
    sessionAlias: "sess_x", logicalSessionId: "lsess_x", sourceTurnId: "sturn_x", now: NOW,
  });
  const member = await first.runtime.getOrCreateGroupMemberSession({
    botId: claim.memberTurn.botId, conversationId: group.id, topicId: topic.id,
  });
  // Whole-run cancel force-terminals even automatic Runs, so teardown settles
  // the run first and then releases runtime: nothing stranded, nothing live.
  // (Teardown deletes topic rows, so assert settlement via pre-delete state:
  // capture the cancel outcome directly first.)
  const cancelOutcome = first.store.cancelRun(accepted.run.id, NOW, "cancelled");
  expect(cancelOutcome.executionStarted).toBe(true);
  await first.service.teardownGroupTopic(group.id, topic.id);
  expect(first.store.listRuns(group.id, topic.id)).toHaveLength(0);
  expect(first.state.conversation_topics[topic.id]).toBeUndefined();
  expect(first.state.bot_runtime_bindings[member.id]).toBeUndefined();
  expect(first.sessions.getLogicalSessionRecord(member.sessionAlias) ?? undefined).toBeUndefined();
  first.store.close();
});

test("teardown still refuses while a run is genuinely routable", async () => {
  const first = await createLifecycle();
  seedTesterBot(first.state);
  const group = await first.bots.createGroup({ title: "Team", botIds: [BOT_ID, TESTER_ID] });
  const topic = await first.service.createGroupTopic(group.id, "Sprint", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  const botA = first.bots.getBot(BOT_ID);
  const botB = first.bots.getBot(TESTER_ID);
  const { snapshotBotProfile } = await import("../../../src/bots/bot-types");
  // Automatic run whose batch settled completed WITHOUT a cancel: the Run
  // stays running for the Router, so teardown must refuse to release runtime.
  const accepted = first.store.acceptRequest({
    conversationId: group.id,
    topicId: topic.id,
    requestId: "req-td-routable",
    botId: botA.id,
    content: "go",
    profileSnapshot: snapshotBotProfile(botA, NOW),
    mode: "automatic",
    members: [{ botId: botB.id, profileSnapshot: snapshotBotProfile(botB, NOW) }],
    now: NOW,
  });
  for (const turn of accepted.memberTurns) {
    first.store.completeExecution({
      runId: accepted.run.id, memberTurnId: turn.id, botId: turn.botId,
      content: `done ${turn.botId}`, sourceTurn: { sessionAlias: `sess_${turn.botId}` }, now: NOW,
    });
  }
  expect(first.store.getRun(accepted.run.id)?.state).toBe("running");
  const member = await first.runtime.getOrCreateGroupMemberSession({
    botId: botA.id, conversationId: group.id, topicId: topic.id,
  });
  // Cancel wins over router-pending: teardown settles the routable run
  // (forced terminal) and releases everything.
  await first.service.teardownGroupTopic(group.id, topic.id);
  expect(first.store.listRuns(group.id, topic.id)).toHaveLength(0);
  expect(first.state.conversation_topics[topic.id]).toBeUndefined();
  expect(first.state.bot_runtime_bindings[member.id]).toBeUndefined();
  first.store.close();
});

test("teardown aborts when physical cancel throws, keeping barrier and runtime", async () => {
  const first = await createLifecycle({
    hooks: { failRuntimeMaterialize: true },
  });
  seedTesterBot(first.state);
  const group = await first.bots.createGroup({ title: "Team", botIds: [BOT_ID, TESTER_ID] });
  const topic = await first.service.createGroupTopic(group.id, "Sprint", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  const botA = first.bots.getBot(BOT_ID);
  const botB = first.bots.getBot(TESTER_ID);
  const { snapshotBotProfile } = await import("../../../src/bots/bot-types");
  const accepted = first.store.acceptRequest({
    conversationId: group.id,
    topicId: topic.id,
    requestId: "req-td-throw",
    botId: botA.id,
    content: "go",
    profileSnapshot: snapshotBotProfile(botA, NOW),
    members: [{ botId: botB.id, profileSnapshot: snapshotBotProfile(botB, NOW) }],
    now: NOW,
  });
  const claim = first.store.claimNextDispatch({
    now: NOW, owner: "dispatcher-a", leaseExpiresAt: "2026-09-15T12:05:00.000Z", authorityEpoch: "epoch-a",
  })!;
  first.store.markExecutionStarted({
    dispatchId: claim.dispatch.id, owner: "dispatcher-a", generation: claim.dispatch.generation,
    runId: accepted.run.id, memberTurnId: claim.memberTurn.id,
    sessionAlias: "sess_x", logicalSessionId: "lsess_x", sourceTurnId: "sturn_x", now: NOW,
  });
  const member = await first.runtime.getOrCreateGroupMemberSession({
    botId: claim.memberTurn.botId, conversationId: group.id, topicId: topic.id,
  });
  // Physical cancel throws mid-loop: teardown propagates, barrier stays,
  // runtime stays live for retry.
  const disp = first.dispatcher as unknown as {
    runner: { cancel: (input: never) => Promise<never> };
  };
  disp.runner.cancel = ((_input: never) => {
    throw new Error("injected cancel transport failure");
  }) as never;
  await expect(first.service.teardownGroupTopic(group.id, topic.id)).rejects.toThrow(
    "injected cancel transport failure",
  );
  expect(first.state.conversation_topics[topic.id]).toBeDefined();
  expect(first.state.bot_runtime_bindings[member.id]).toBeDefined();
  expect(first.sessions.getLogicalSessionRecord(member.sessionAlias)).toBeDefined();
  first.store.close();
});

test("dispatcher cancelRun cancels every started member exactly", async () => {
  const hangA = deferred();
  const hangB = deferred();
  const hangs = [hangA, hangB];
  let hangIdx = 0;
  const runner = new FakeRunner();
  const first = await createLifecycle({
    runner,
    hooks: {
      beforeExecutionStart: async () => {
        // Park each member's execution so both stay started while we cancel.
        const gate = hangs[hangIdx++] ?? deferred();
        await gate.promise;
      },
    },
  });
  seedTesterBot(first.state);
  const group = await first.bots.createGroup({ title: "Team", botIds: [BOT_ID, TESTER_ID] });
  const topic = await first.service.createGroupTopic(group.id, "Sprint", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  const botA = first.bots.getBot(BOT_ID);
  const botB = first.bots.getBot(TESTER_ID);
  const { snapshotBotProfile } = await import("../../../src/bots/bot-types");
  first.store.acceptRequest({
    conversationId: group.id,
    topicId: topic.id,
    requestId: "req-dcancel",
    botId: botA.id,
    content: "go",
    profileSnapshot: snapshotBotProfile(botA, NOW),
    members: [{ botId: botB.id, profileSnapshot: snapshotBotProfile(botB, NOW) }],
    now: NOW,
  });
  // NOTE: dispatcher executes direct sessions; member bindings materialize on
  // demand. Kick twice concurrently is serial; instead drive claims manually
  // and cancel through the dispatcher with both started.
  const claimA = first.store.claimNextDispatch({
    now: NOW, owner: "dispatcher-a", leaseExpiresAt: "2026-09-15T12:05:00.000Z", authorityEpoch: "epoch-a",
  })!;
  first.store.markExecutionStarted({
    dispatchId: claimA.dispatch.id, owner: "dispatcher-a", generation: 1,
    runId: claimA.run.id, memberTurnId: claimA.memberTurn.id,
    sessionAlias: "sess_a", logicalSessionId: "lsess_a", sourceTurnId: "sturn_a", now: NOW,
  });
  const claimB = first.store.claimNextDispatch({
    now: NOW, owner: "dispatcher-a", leaseExpiresAt: "2026-09-15T12:05:00.000Z", authorityEpoch: "epoch-a",
  })!;
  first.store.markExecutionStarted({
    dispatchId: claimB.dispatch.id, owner: "dispatcher-a", generation: 1,
    runId: claimB.run.id, memberTurnId: claimB.memberTurn.id,
    sessionAlias: "sess_b", logicalSessionId: "lsess_b", sourceTurnId: "sturn_b", now: NOW,
  });
  await first.dispatcher.cancelRun(claimA.run.id);
  const aliases = runner.cancelCalls.map((c) => c.promptRequestId).sort();
  expect(aliases).toEqual(["sturn_a", "sturn_b"]);
  const states = first.store.listMemberTurns(claimA.run.id).map((t) => t.state).sort();
  expect(states).toEqual(["cancelled", "cancelled"]);
  expect(first.store.getRun(claimA.run.id)?.state).toBe("cancelled");
  hangA.resolve();
  hangB.resolve();
  first.store.close();
});

test("unknown on first active member never skips the second physical cancel", async () => {
  const first = await createLifecycle();
  seedTesterBot(first.state);
  const group = await first.bots.createGroup({ title: "Team", botIds: [BOT_ID, TESTER_ID] });
  const topic = await first.service.createGroupTopic(group.id, "Sprint", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  const botA = first.bots.getBot(BOT_ID);
  const botB = first.bots.getBot(TESTER_ID);
  const { snapshotBotProfile } = await import("../../../src/bots/bot-types");
  first.store.acceptRequest({
    conversationId: group.id,
    topicId: topic.id,
    requestId: "req-cancel-unknown",
    botId: botA.id,
    content: "go",
    profileSnapshot: snapshotBotProfile(botA, NOW),
    members: [{ botId: botB.id, profileSnapshot: snapshotBotProfile(botB, NOW) }],
    now: NOW,
  });
  const claimA = first.store.claimNextDispatch({
    now: NOW, owner: "dispatcher-a", leaseExpiresAt: "2026-09-15T12:05:00.000Z", authorityEpoch: "epoch-a",
  })!;
  first.store.markExecutionStarted({
    dispatchId: claimA.dispatch.id, owner: "dispatcher-a", generation: 1,
    runId: claimA.run.id, memberTurnId: claimA.memberTurn.id,
    sessionAlias: "sess_a", logicalSessionId: "lsess_a", sourceTurnId: "sturn_a", now: NOW,
  });
  const claimB = first.store.claimNextDispatch({
    now: NOW, owner: "dispatcher-a", leaseExpiresAt: "2026-09-15T12:05:00.000Z", authorityEpoch: "epoch-a",
  })!;
  first.store.markExecutionStarted({
    dispatchId: claimB.dispatch.id, owner: "dispatcher-a", generation: 1,
    runId: claimB.run.id, memberTurnId: claimB.memberTurn.id,
    sessionAlias: "sess_b", logicalSessionId: "lsess_b", sourceTurnId: "sturn_b", now: NOW,
  });
  // A's physical cancel reports unknown; B's reports cancelled. Both exact
  // promptRequestIds must reach the runner even though A's persistence seals
  // the Run indeterminate before B's outcome is recorded.
  const calls: string[] = [];
  const disp = first.dispatcher as unknown as {
    runner: { cancel: (input: { promptRequestId: string }) => Promise<{ outcome: "cancelled" | "unknown" }> };
  };
  const origCancel = disp.runner.cancel.bind(disp.runner);
  disp.runner.cancel = (async (input: { promptRequestId: string }) => {
    calls.push(input.promptRequestId);
    if (input.promptRequestId === "sturn_a") {
      return { outcome: "unknown" };
    }
    return origCancel(input);
  });
  await first.dispatcher.cancelRun(claimA.run.id);
  expect(calls.sort()).toEqual(["sturn_a", "sturn_b"]);
  expect(first.store.getRun(claimA.run.id)?.state).toBe("indeterminate");
  first.store.close();
});

test("automatic cancel that races a member completion still terminals the run", async () => {
  for (const outcome of ["completed", "failed"] as const) {
    const first = await createLifecycle();
    seedTesterBot(first.state);
    const group = await first.bots.createGroup({ title: "Team", botIds: [BOT_ID, TESTER_ID] });
    const topic = await first.service.createGroupTopic(group.id, "Sprint", {
      workspace: "backend",
      isolation: "shared-single-writer",
    });
    const botA = first.bots.getBot(BOT_ID);
    const botB = first.bots.getBot(TESTER_ID);
    const { snapshotBotProfile } = await import("../../../src/bots/bot-types");
    const accepted = first.store.acceptRequest({
      conversationId: group.id,
      topicId: topic.id,
      requestId: `req-cancel-race-${outcome}`,
      botId: botA.id,
      content: "go",
      profileSnapshot: snapshotBotProfile(botA, NOW),
      mode: "automatic",
      members: [{ botId: botB.id, profileSnapshot: snapshotBotProfile(botB, NOW) }],
      now: NOW,
    });
    const claim = first.store.claimNextDispatch({
      now: NOW, owner: "dispatcher-a", leaseExpiresAt: "2026-09-15T12:05:00.000Z", authorityEpoch: "epoch-a",
    })!;
    first.store.markExecutionStarted({
      dispatchId: claim.dispatch.id, owner: "dispatcher-a", generation: claim.dispatch.generation,
      runId: accepted.run.id, memberTurnId: claim.memberTurn.id,
      sessionAlias: "sess_x", logicalSessionId: "lsess_x", sourceTurnId: "sturn_x", now: NOW,
    });
    // Whole-run cancel settles the queued sibling, then the active member's
    // physical cancel reports a proven outcome (race: work already done).
    const cancelOutcome = first.store.cancelRun(accepted.run.id, NOW, "cancelled");
    expect(cancelOutcome.executionStarted).toBe(true);
    if (outcome === "completed") {
      first.store.completeExecution({
        runId: accepted.run.id, memberTurnId: claim.memberTurn.id, botId: claim.memberTurn.botId,
        content: "late done", sourceTurn: { sessionAlias: "sess_x", turnId: "sturn_x" }, now: NOW,
        forceRunTerminalOnSettle: true,
      });
    } else {
      first.store.failExecution({
        runId: accepted.run.id, memberTurnId: claim.memberTurn.id, now: NOW,
        reason: "late failure", forceRunTerminalOnSettle: true,
      });
    }
    const run = first.store.getRun(accepted.run.id)!;
    expect(["completed", "failed"]).toContain(run.state);
    expect(run.finishedAt).toBeDefined();
    // No new dispatch may escape after cancel.
    expect(first.store.claimNextDispatch({
      now: NOW, owner: "dispatcher-a", leaseExpiresAt: "2026-09-15T12:05:00.000Z", authorityEpoch: "epoch-a",
    })).toBeUndefined();
    first.store.close();
  }
});

test("worktree-per-member topics fail closed at member materialization", async () => {
  const first = await createLifecycle();
  seedTesterBot(first.state);
  const group = await first.bots.createGroup({ title: "Team", botIds: [BOT_ID, TESTER_ID] });
  const topic = await first.service.createGroupTopic(group.id, "WT", {
    workspace: "backend",
    isolation: "worktree-per-member",
  });
  expect(topic.executionTarget?.isolation).toBe("worktree-per-member");
  await expect(first.runtime.getOrCreateGroupMemberSession({
    botId: BOT_ID, conversationId: group.id, topicId: topic.id,
  })).rejects.toMatchObject({ code: "worktree_unprovisioned" });
  first.store.close();
});

test("maxMemberTurns below the accepted member count rejects before any row", async () => {
  const first = await createLifecycle();
  seedTesterBot(first.state);
  const group = await first.bots.createGroup({ title: "Team", botIds: [BOT_ID, TESTER_ID] });
  const topic = await first.service.createGroupTopic(group.id, "Sprint", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  const botA = first.bots.getBot(BOT_ID);
  const botB = first.bots.getBot(TESTER_ID);
  const { snapshotBotProfile } = await import("../../../src/bots/bot-types");
  expect(() => first.store.acceptRequest({
    conversationId: group.id,
    topicId: topic.id,
    requestId: "req-budget",
    botId: botA.id,
    content: "go",
    profileSnapshot: snapshotBotProfile(botA, NOW),
    maxMemberTurns: 1,
    members: [{ botId: botB.id, profileSnapshot: snapshotBotProfile(botB, NOW) }],
    now: NOW,
  })).toThrow(/maxMemberTurns/);
  expect(first.store.getRunByRequestId(group.id, topic.id, "req-budget")).toBeUndefined();
  expect(first.store.listMessages({ conversationId: group.id, topicId: topic.id, limit: 10 })).toHaveLength(0);
  first.store.close();
});
