import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { BotRuntimeManager } from "../../../src/bots/bot-runtime-manager";
import { BotService } from "../../../src/bots/bot-service";
import type { AppConfig } from "../../../src/config/types";
import { ConversationDispatcher, type ConversationDispatcherHooks } from "../../../src/conversations/conversation-dispatcher";
import { ConversationRunService } from "../../../src/conversations/conversation-run-service";
import type {
  ConversationTurnCancelInput,
  ConversationTurnRunInput,
  ConversationTurnRunResult,
  ConversationTurnRunner,
} from "../../../src/conversations/conversation-turn-runner";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { createDirectConversationId } from "../../../src/domain/ids";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import type { StateStore } from "../../../src/state/state-store";
import { createEmptyState, type AppState } from "../../../src/state/types";

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
  public cancelResult: "cancelled" | "unknown" = "cancelled";
  private readonly cancelled = new Set<string>();
  private inFlight?: ConversationTurnRunInput;

  async run(input: ConversationTurnRunInput): Promise<ConversationTurnRunResult> {
    this.runs.push(input);
    this.inFlight = input;
    try {
      if (this.hang) {
        await this.hang.promise;
      }
      if (this.cancelled.has(input.promptRequestId)) {
        return { status: "cancelled" };
      }
      return this.result;
    } finally {
      if (this.inFlight === input) {
        this.inFlight = undefined;
      }
    }
  }

  async cancel(input: ConversationTurnCancelInput): Promise<"cancelled" | "unknown"> {
    this.cancelCalls.push(input);
    const target = this.inFlight?.promptRequestId ?? input.promptRequestId;
    if (target) {
      this.cancelled.add(target);
    }
    this.hang?.resolve();
    return this.cancelResult;
  }
}

async function createLifecycle(options: {
  runner?: FakeRunner;
  hooks?: ConversationDispatcherHooks;
  beforeAcceptPersist?: () => Promise<void>;
  failSessionRelease?: boolean | (() => boolean);
  beforeAcceptCommit?: () => void;
  ownerId?: string;
  autoKick?: boolean;
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
  const bots = new BotService(config, state, stateStore, {
    now: () => new Date(NOW),
    createId: () => BOT_ID,
    stateMutex,
  });
  const runtime = new BotRuntimeManager(bots, sessions, state, stateStore, {
    now: () => new Date(NOW),
    stateMutex,
  });
  const runner = options.runner ?? new FakeRunner();
  let clock = Date.parse(NOW);
  const nextNow = () => {
    clock += 1000;
    return new Date(clock);
  };
  const dispatcher = new ConversationDispatcher(store, runtime, runner, sessions, {
    now: nextNow,
    ownerId: options.ownerId ?? "dispatcher-a",
    hooks: options.hooks,
  });
  const service = new ConversationRunService(store, bots, runtime, dispatcher, sessions, state, stateStore, {
    now: nextNow,
    stateMutex,
    beforeAcceptPersist: options.beforeAcceptPersist,
    failSessionRelease: options.failSessionRelease,
    autoKick: options.autoKick ?? false,
  });
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend", instructions: "Focus on races." });
  return { path, store, state, sessions, bots, runtime, runner, dispatcher, service };
}

test("crash after request transaction and before dispatch resumes exactly once", async () => {
  const first = await createLifecycle();
  const accepted = await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-crash-before-dispatch",
    content: "hello",
  });
  expect(accepted.run.state).toBe("queued");
  expect(first.runner.runs).toHaveLength(0);
  first.store.close();

  const runner = new FakeRunner();
  const store = await SqliteConversationStore.open(first.path);
  const dispatcher = new ConversationDispatcher(store, first.runtime, runner, first.sessions, {
    now: () => new Date(NOW),
    ownerId: "dispatcher-b",
  });
  await dispatcher.kick();
  expect(runner.runs).toHaveLength(1);
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
    { now: () => new Date(NOW), ownerId: "dispatcher-b" },
  );
  await recovered.kick();
  expect(recoveredRunner.runs).toHaveLength(1);
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
    { now: () => new Date(NOW), ownerId: "dispatcher-b" },
  );
  await recovered.kick();
  expect(first.store.getRun(accepted.run.id)?.state).toBe("indeterminate");
  expect(first.store.getMemberTurn(accepted.memberTurn.id)?.state).toBe("indeterminate");
  expect(recoveredRunner.runs).toHaveLength(0);
  resume.resolve();
  runner.hang.resolve();
  await drain;
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
  expect(first.runner.runs).toHaveLength(2);
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
  expect(first.runner.runs).toHaveLength(1);
  expect(first.runner.runs[0]?.promptRequestId).toBe(
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
  await first.service.cancelRun(running.run.id);
  await drain;
  expect(first.store.getRun(running.run.id)?.state).toBe("cancelled");
  await first.dispatcher.kick();
  expect(first.store.getRun(other.run.id)?.state).toBe("completed");
  expect(runner.cancelCalls).toHaveLength(1);
  expect(runner.cancelCalls[0]?.sessionAlias).not.toBe("");
});

test("completion vs cancellation race never resurrects a cancelled Run", async () => {
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
  expect(first.store.getRun(accepted.run.id)?.state).toBe("cancelled");
  const messages = first.store.listMessages({
    conversationId: accepted.run.conversationId,
    topicId: accepted.run.topicId,
    limit: 10,
  });
  expect(messages.filter((message) => message.role === "bot")).toHaveLength(0);
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
  expect(first.runner.runs).toHaveLength(0);

  const recovered = new ConversationDispatcher(
    first.store,
    first.runtime,
    first.runner,
    first.sessions,
    { now: () => new Date(NOW), ownerId: "dispatcher-retry" },
  );
  await recovered.kick();
  expect(first.store.getRun(accepted.run.id)?.state).toBe("completed");
  expect(first.runner.runs).toHaveLength(1);
});

test("teardown release failure leaves recoverable ownership", async () => {
  let failRelease = true;
  const first = await createLifecycle({
    failSessionRelease: () => failRelease,
  });
  await first.service.acceptDirectPrompt({
    botId: BOT_ID,
    requestId: "req-teardown",
    content: "hello",
  });
  await first.dispatcher.kick();
  expect(Object.keys(first.state.bot_runtime_bindings).length).toBeGreaterThan(0);
  await expect(first.service.teardownDirectConversation(BOT_ID)).rejects.toMatchObject({
    code: "session_release_failed",
  });
  expect(Object.keys(first.state.bot_runtime_bindings).length).toBeGreaterThan(0);
  expect(first.store.isConversationDeleting(createDirectConversationId(BOT_ID))).toBe(true);
  failRelease = false;
  await first.service.teardownDirectConversation(BOT_ID);
  expect(first.state.bot_runtime_bindings).toEqual({});
  expect(first.state.conversations).toEqual({});
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
