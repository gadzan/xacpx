import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotService } from "../../../../src/bots/bot-service";
import { BotRuntimeManager } from "../../../../src/bots/bot-runtime-manager";
import { snapshotBotProfile } from "../../../../src/bots/bot-types";
import type { AppConfig } from "../../../../src/config/types";
import type { AcpxCommandMetadata } from "../../../../src/config/resolve-acpx-command";
import { ConversationDispatcher, type ConversationDispatcherHooks } from "../../../../src/conversations/conversation-dispatcher";
import { ConversationRunService } from "../../../../src/conversations/conversation-run-service";
import { ConversationRouterEngine } from "../../../../src/conversations/conversation-router-engine";
import { bindRouter } from "../../../../src/conversations/conversation-router-gate";
import type { ConversationRouter } from "../../../../src/conversations/conversation-router-types";
import { SqliteConversationStore } from "../../../../src/conversations/sqlite-conversation-store";
import type { AcceptMemberInput } from "../../../../src/conversations/conversation-store";
import type { ConversationTurnRunner, ConversationTurnRunInput, ConversationTurnRunResult, ConversationTurnCancelInput } from "../../../../src/conversations/conversation-turn-runner";
import { SessionService } from "../../../../src/sessions/session-service";
import { createStrictOwnedSessionRelease } from "../../../../src/sessions/owned-session-release";
import { createEmptyState, type AppState } from "../../../../src/state/types";
import { AsyncMutex } from "../../../../src/orchestration/async-mutex";
import { ConversationWorktreeManager, type WorktreeManagerHooks } from "../../../../src/conversations/conversation-worktree-manager";
import { WorktreeIntegrationService } from "../../../../src/conversations/worktree-integration-service";

export const NOW = "2026-10-07T00:00:00.000Z";
export const HUMAN = { chatKey: "relay:human", accountId: "human", senderId: "human", isOwner: true };
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
export async function until(check: () => boolean) {
  const end = Date.now() + 3500;
  while (!check()) {
    if (Date.now() > end) throw new Error("scheduler condition timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}
export class ControlledRunner implements ConversationTurnRunner {
  calls: ConversationTurnRunInput[] = [];
  active = 0;
  peak = 0;
  gates: ReturnType<typeof deferred<ConversationTurnRunResult>>[] = [];
  done: Promise<ConversationTurnRunResult>[] = [];
  run(input: ConversationTurnRunInput) {
    this.calls.push(input);
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    const gate = deferred<ConversationTurnRunResult>();
    this.gates.push(gate);
    const done = gate.promise.finally(() => { this.active--; });
    this.done.push(done);
    return done;
  }
  finish(index: number, result: ConversationTurnRunResult = { status: "completed", text: `result-${index}` }) {
    this.gates[index]!.resolve(result);
  }
  async cancel(input: ConversationTurnCancelInput) {
    const index = this.calls.findIndex((call) => call.promptRequestId === input.promptRequestId);
    if (index >= 0) { this.finish(index, { status: "cancelled" }); await this.done[index]; }
    return { outcome: "cancelled" as const };
  }
}
export async function harness(options: { path?: string; state?: AppState; hooks?: ConversationDispatcherHooks; router?: ConversationRouter; ownerId?: string; beforeAcceptPersist?: () => Promise<void>; transport?: Partial<AppConfig["transport"]>; acpxCommandMetadata?: AcpxCommandMetadata; workspaceCwd?: string; altWorkspaceCwd?: string; worktreeRoot?: string; worktreeHooks?: WorktreeManagerHooks; maxConcurrentRunExecutions?: number } = {}) {
  const path = options.path ?? join(mkdtempSync(join(tmpdir(), "xacpx-concurrency-")), "conversations.sqlite");
  const store = await SqliteConversationStore.open(path);
  const state = options.state ?? createEmptyState();
  const stateStore = { async save(_s: AppState) {}, async saveNow(_s: AppState) {} };
  // The config key is an alias: synthetic reader fixtures now materialize the
  // actual supported restricted launch instead of treating Codex's mode as proof.
  const config = {
    agents: { codex: { driver: "claude" } },
    // `alt` is a SECOND physical directory. Cross-Topic overlap tests need it:
    // with one workspace every Topic keys on the same resource, so a legitimate
    // concurrent Run is indistinguishable from a resource conflict and the
    // overlap assertion would pass vacuously.
    workspaces: {
      backend: { cwd: options.workspaceCwd ?? "/tmp/backend" },
      ...(options.altWorkspaceCwd !== undefined ? { alt: { cwd: options.altWorkspaceCwd } } : {}),
    },
    // Pin the validated enforcement contract independently of release defaults.
    transport: { type: "acpx-cli", adapterVersions: { claude: "0.78.0" }, ...options.transport },
  } as AppConfig;
  const stateMutex = new AsyncMutex();
  const sessions = new SessionService(config, stateStore, state, { stateMutex, acpxCommandMetadata: options.acpxCommandMetadata });
  const releaseOwnedSession = createStrictOwnedSessionRelease({ sessions, transport: { async deleteSession() {}, async releaseLogicalSession() {} } });
  let id = Object.keys(state.bots).length;
  const bots = new BotService(config, state, stateStore, { stateMutex, createId: () => `bot_limit_${++id}` });
  if (id === 0) {
    for (let n = 0; n < 4; n++) await bots.createBot({ name: `Member${n}`, agent: "codex", workspace: "backend" });
    // A member on the SECOND physical directory, so a Topic bound to `alt` can
    // bind a session and actually execute. Without it an `alt` Topic fails
    // session binding (the bot's workspace must match the Topic's), which looks
    // like a scheduler bug but is a fixture gap.
    if (options.altWorkspaceCwd !== undefined) {
      for (let n = 0; n < 4; n++) await bots.createBot({ name: `Alt${n}`, agent: "codex", workspace: "alt" });
    }
  }
  const runtime = new BotRuntimeManager(bots, sessions, state, stateStore, { stateMutex, releaseOwnedSession });
  const runner = new ControlledRunner();
  let clock = Date.parse(NOW);
  const now = () => new Date(clock++);
  const dispatcher = new ConversationDispatcher(store, runtime, runner, sessions, { now, hooks: options.hooks, ownerId: options.ownerId,
    ...(options.maxConcurrentRunExecutions !== undefined ? { maxConcurrentRunExecutions: options.maxConcurrentRunExecutions } : {}) });
  const worktrees = options.worktreeRoot ? new ConversationWorktreeManager(store.worktrees, options.worktreeRoot, config, options.worktreeHooks) : undefined;
  if (worktrees) { dispatcher.setWorktreeManager(worktrees); sessions.setConversationWorktreeResolver(s => worktrees.resolveSessionCwd(s)); }
  const integrations = worktrees ? new WorktreeIntegrationService(worktrees, store, state, runtime, releaseOwnedSession) : undefined;
  const routerEngine = options.router ? new ConversationRouterEngine(bindRouter(options.router), { store,
    readGroup: (id) => state.conversations[id], readTopic: (_id, tid) => state.conversation_topics[tid],
    readBot: (id) => bots.getBot(id), runLifecycleAll: (ids, fn) => bots.runLifecycleAll(ids, fn), now }) : undefined;
  const service = new ConversationRunService(store, bots, runtime, dispatcher, sessions, state, stateStore,
    { now, stateMutex, autoKick: false, releaseOwnedSession, routerEngine, beforeAcceptPersist: options.beforeAcceptPersist,
      worktrees, beforeWorktreeCleanup: integrations ? (c, t) => integrations.cleanupScope(c, t) : undefined });
  dispatcher.setAutomaticRoutingHandler((id) => service.trackAutomaticRouting(id));
  // Observable claim activity, so a test can wait for the scheduler to have
  // scanned instead of guessing a duration. Counts every claimNextDispatch call.
  const claimCounter = { attempts: 0 };
  const originalClaim = store.claimNextDispatch.bind(store);
  store.claimNextDispatch = (input) => { claimCounter.attempts += 1; return originalClaim(input); };
  const ids = Object.keys(state.bots);
  // `workspace` selects the physical directory this Topic's members materialize
  // against. Passing the harness's second workspace (`alt`) is the only way to
  // express "two Topics that may genuinely execute concurrently": with the
  // default every Topic keys on ONE resource, so a legitimate cross-Topic
  // overlap is indistinguishable from a resource conflict and the overlap
  // assertions would pass vacuously. The membership is restricted to bots whose
  // own workspace matches, because session binding requires the Bot's workspace
  // to equal the Topic's.
  async function group(limit?: number, workspace = "backend") {
    const members = Object.values(state.bots)
      .filter((bot) => bot.workspace === workspace)
      .map((bot) => bot.id);
    const g = await bots.createGroup({ title: "Limits", botIds: members });
    const topic = await service.createGroupTopic(
      g.id,
      "Topic",
      { workspace, isolation: "shared-single-writer" },
      { maxConcurrentMemberTurns: limit },
    );
    return { group: g, topic, members };
  }
  // `memberIds` defaults to the harness bots but MUST be the group's own
  // membership when the Topic is bound to a different workspace: a Bot's
  // workspace has to match the Topic's for session binding to succeed.
  function accept(conversationId: string, topicId: string, count = 3, proof = true, requestId = "request", extra?: Partial<AcceptMemberInput>, memberIds?: string[]) {
    const pool = memberIds ?? ids;
    const member = (botId: string): AcceptMemberInput => ({ botId, profileSnapshot: snapshotBotProfile(bots.getBot(botId), NOW),
      ...(proof ? { effect: "read-only", effectProvenance: "declared-enforced" } : {}), ...extra });
    const first = member(pool[0]!);
    return store.acceptRequest({ conversationId, topicId, requestId, botId: first.botId, profileSnapshot: first.profileSnapshot,
      primaryMember: first, members: pool.slice(1, count).map(member), content: "one frozen request", now: NOW,
      maxMemberTurns: 24, authorityEpoch: dispatcher.authorityEpoch, humanIngress: HUMAN });
  }
  return { path, config, store, state, stateStore, bots, runtime, sessions, runner, dispatcher, service, group, accept, ids, now, worktrees, integrations, jump: (ms: number) => { clock += ms; }, claimAttempts: () => claimCounter.attempts };
}
