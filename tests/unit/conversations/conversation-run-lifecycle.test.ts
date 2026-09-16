import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { BotRuntimeManager } from "../../../src/bots/bot-runtime-manager";
import { BotService } from "../../../src/bots/bot-service";
import type { AppConfig } from "../../../src/config/types";
import { ControlService } from "../../../src/control/control-service";
import { createControlEventBus } from "../../../src/control/control-event-bus";
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
import { createDirectConversationId } from "../../../src/domain/ids";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { createStrictOwnedSessionRelease } from "../../../src/sessions/owned-session-release";
import { parseState, type StateStore } from "../../../src/state/state-store";
import { createEmptyState, type AppState } from "../../../src/state/types";
import type { ChatRequest, ChatResponse } from "../../../src/weixin/agent/interface";

const NOW = "2026-09-15T12:00:00.000Z";
const BOT_ID = "bot_reviewer";

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
    releaseOwnedSession,
  });
  const events = createControlEventBus();
  const runner = options.controlChat
    ? new ControlConversationTurnRunner(new ControlService({
      agent: { chat: options.controlChat },
      sessions,
      activeTurns: { isActiveAnywhere: () => false },
      scheduled: {} as never,
      orchestration: {} as never,
      events,
    } as never), options.runnerOptions)
    : options.runner ?? new FakeRunner();
  let clock = Date.parse(NOW);
  const nowFn = () => {
    clock += 1;
    return new Date(clock);
  };
  const jump = (ms: number) => {
    clock += ms;
  };
  const dispatcher = new ConversationDispatcher(store, runtime, runner, sessions, {
    now: nowFn,
    ownerId: options.ownerId ?? "dispatcher-a",
    hooks: options.hooks,
    ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
  });
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
    cancelQueuedItem() {
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
  });
  await first.dispatcher.kick();
  expect(first.store.getRun(accepted.run.id)?.state).toBe("completed");
  expect(first.store.getMemberTurn(accepted.memberTurn.id)?.origin).toBe("human");
  expect(captured[0]?.metadata?.origin).toBe("human");
  expect(canMintHumanPermissionInteraction(captured[0]?.metadata?.origin)).toBe(true);
});

test("startup redispatch after accept-before-claim is orchestration and cannot mint", async () => {
  const captured: ChatRequest[] = [];
  const first = await createLifecycle();
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-startup-recovery",
    content: "hello",
  });
  expect(accepted.dispatch.generation).toBe(1);
  const restart = new ConversationDispatcher(
    first.store,
    first.runtime,
    new ControlConversationTurnRunner(new ControlService({
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
    } as never)),
    first.sessions,
    { now: first.nowFn, ownerId: "dispatcher-restart" },
  );
  await restart.kick();
  expect(first.store.getRun(accepted.run.id)?.state).toBe("completed");
  expect(first.store.getMemberTurn(accepted.memberTurn.id)?.origin).toBe("recovery");
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
