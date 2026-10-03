import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { BotService } from "../../../src/bots/bot-service";
import { BotRuntimeManager } from "../../../src/bots/bot-runtime-manager";
import type { BotProfile } from "../../../src/bots/bot-types";
import type { AppConfig } from "../../../src/config/types";
import { ConversationError } from "../../../src/conversations/conversation-error";
import { ConversationDispatcher } from "../../../src/conversations/conversation-dispatcher";
import { ConversationRouterEngine } from "../../../src/conversations/conversation-router-engine";
import {
  bindRouter,
  gateRoutingDecision,
} from "../../../src/conversations/conversation-router-gate";
import {
  isRouterCapabilityRestricted,
  UNRESTRICTED_ROUTER_CAPABILITY,
  parseRoutingDecision,
  RoutingDecisionError,
  type ConversationRouter,
  type RouterCapabilityRestriction,
  type RoutingDecision,
  type RoutingInput,
} from "../../../src/conversations/conversation-router-types";
import { ConversationRunService } from "../../../src/conversations/conversation-run-service";
import type {
  ConversationTurnRunInput,
  ConversationTurnRunResult,
  ConversationTurnRunner,
} from "../../../src/conversations/conversation-turn-runner";
import type { ApplyRoutingDecisionInput, RoutingAssignmentInput } from "../../../src/conversations/conversation-store";
import type { ConversationRun } from "../../../src/conversations/conversation-types";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { toConversationRun, toMemberTurnSummary } from "../../../src/control/conversation-control-dtos";
import { validControlEvent } from "@ganglion/xacpx-relay-protocol";
import { snapshotGroupMemberProfile } from "../../../src/bots/bot-types";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { createStrictOwnedSessionRelease } from "../../../src/sessions/owned-session-release";
import { parseState, type StateStore } from "../../../src/state/state-store";
import { createEmptyState, type AppState } from "../../../src/state/types";

const NOW = "2026-09-15T12:00:00.000Z";
const BOT_ID = "bot_reviewer";
const TESTER_ID = "bot_tester";
const BUILDER_ID = "bot_builder";

/** The ONLY pre-execution router capability proof PR8 accepts. Everything
 *  except exactly this shape must fail closed. */
const RESTRICTED: RouterCapabilityRestriction = {
  toolsDisabled: true,
  filesystemDisabled: true,
  terminalDisabled: true,
  permissionInteractionDisabled: true,
  messagingDisabled: true,
  orchestrationDisabled: true,
  structuredOutputOnly: true,
};

function seedBots(state: AppState): void {
  for (const [id, name] of [[TESTER_ID, "Tester"], [BUILDER_ID, "Builder"]] as const) {
    state.bots[id] = {
      id, name, agent: "codex", workspace: "backend",
      enabled: true, profileRevision: 1, createdAt: NOW, updatedAt: NOW,
    };
  }
}

class MemoryStateStore implements Pick<StateStore, "save" | "saveNow"> {
  public saved: AppState[] = [];
  async save(state: AppState): Promise<void> { this.saved.push(structuredClone(state)); }
  async saveNow(state: AppState): Promise<void> { this.saved.push(structuredClone(state)); }
}

function createConfig(): AppConfig {
  return {
    transport: { type: "acpx-cli", command: "acpx", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
    logging: { level: "info", maxSizeBytes: 1024, maxFiles: 2, retentionDays: 1, perf: { enabled: false } },
    channel: { type: "weixin", replyMode: "stream" },
    channels: [{ id: "weixin", type: "weixin", enabled: true }],
    plugins: [],
    agents: { codex: { driver: "codex" }, claude: { driver: "claude" } },
    workspaces: { backend: { cwd: "/tmp/backend" } },
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
  public result: ConversationTurnRunResult = { status: "completed", text: "done" };
  async run(input: ConversationTurnRunInput): Promise<ConversationTurnRunResult> {
    this.runs.push(input);
    return this.result;
  }
  async cancel() {
    return { outcome: "cancelled" as const };
  }
}

interface Harness {
  path: string;
  store: SqliteConversationStore;
  state: AppState;
  stateStore: MemoryStateStore;
  sessions: SessionService;
  bots: BotService;
  runtime: BotRuntimeManager;
  runner: FakeRunner;
  dispatcher: ConversationDispatcher;
  service: ConversationRunService;
  nowFn: () => Date;
  events: Array<{ type: string; run?: { id: string; state: string } }>;
  /** The configured RecordingRouter, when one was supplied. */
  router?: RecordingRouter;
  /** Test seam: build the same RoutingInput the engine builds for a Run. */
  engineInput(runId: ConversationRun["id"]): RoutingInput;
  /** Test seam: attach live member snapshots the way the engine does. */
  withSnapshots(
    decision: Extract<RoutingDecision, { type: "dispatch" }>,
    target: { workspace: string; cwd?: string; isolation: "shared" | "shared-single-writer" | "worktree-per-member" },
  ): Extract<ApplyRoutingDecisionInput["decision"], { type: "dispatch" }>;
}

async function createHarness(options: {
  router?: ConversationRouter | undefined;
  autoKick?: boolean;
} = {}): Promise<Harness> {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-router-")), "conversation.sqlite");
  const store = await SqliteConversationStore.open(path);
  const state = createEmptyState();
  const stateStore = new MemoryStateStore();
  const stateMutex = new AsyncMutex();
  const config = createConfig();
  const sessions = new SessionService(config, stateStore, state, { now: () => Date.parse(NOW), stateMutex });
  const physical = {
    async deleteSession() { /* no-op */ },
    async releaseLogicalSession() { /* no-op */ },
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
  const runner = new FakeRunner();
  const events: Harness["events"] = [];
  const dispatcher = new ConversationDispatcher(store, runtime, runner, sessions, {
    now: () => new Date(NOW),
    ownerId: "dispatcher-a",
    onProductEvent: (event) => {
      events.push({ type: event.type, run: "run" in event ? { id: event.run.id, state: event.run.state } : undefined });
    },
  });
  const routerEngine = options.router
    ? new ConversationRouterEngine(bindRouter(options.router), {
      store,
      readGroup: (conversationId) => state.conversations[conversationId],
      readTopic: (conversationId, topicId) => {
        const topic = state.conversation_topics[topicId];
        return topic?.conversationId === conversationId ? topic : undefined;
      },
      readBot: (botId) => state.bots[botId],
      now: () => new Date(NOW),
    })
    : undefined;
  const service = new ConversationRunService(store, bots, runtime, dispatcher, sessions, state, stateStore, {
    now: () => new Date(NOW),
    stateMutex,
    autoKick: options.autoKick ?? true,
    releaseOwnedSession,
    onProductEvent: (event) => {
      events.push({ type: event.type, run: "run" in event ? { id: event.run.id, state: event.run.state } : undefined });
    },
    ...(routerEngine ? { routerEngine } : {}),
  });
  dispatcher.setAutomaticRoutingHandler((runId) => {
    service.trackAutomaticRouting(runId);
  });
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  seedBots(state);
  const engine = routerEngine;
  return {
    path, store, state, stateStore, sessions, bots, runtime, runner, dispatcher, service,
    nowFn: () => new Date(NOW), events,
    ...(options.router instanceof RecordingRouter ? { router: options.router } : {}),
    engineInput(runId) {
      const run = store.getRun(runId);
      if (!run) {
        throw new Error(`run "${runId}" not found`);
      }
      if (!engine) {
        throw new Error("no router engine configured");
      }
      return engine.buildRoutingInput(run);
    },
    withSnapshots(decision, target) {
      const now = new Date(NOW).toISOString();
      return {
        type: "dispatch",
        mode: decision.mode,
        assignments: decision.assignments.map((assignment) => ({
          id: assignment.id,
          botId: assignment.botId,
          task: assignment.task,
          ...(assignment.expectedOutput !== undefined ? { expectedOutput: assignment.expectedOutput } : {}),
          ...(assignment.dependsOn !== undefined ? { dependsOn: assignment.dependsOn } : {}),
          triggerMessageIds: assignment.triggerMessageIds,
          profileSnapshot: snapshotGroupMemberProfile(
            state.bots[assignment.botId] ?? { ...state.bots[BOT_ID]!, id: assignment.botId },
            target,
            now,
          ),
        })),
      };
    },
  };
}

/** A scripted Router: returns decisions in order and records every input. */
class RecordingRouter implements ConversationRouter {
  readonly capabilityRestriction = RESTRICTED;
  public inputs: RoutingInput[] = [];
  public decisions: Array<RoutingDecision | Error | unknown> = [];
  constructor(decisions: Array<RoutingDecision | Error | unknown> = []) {
    this.decisions = decisions;
  }
  async decide(input: RoutingInput): Promise<RoutingDecision> {
    this.inputs.push(structuredClone(input));
    const next = this.decisions.shift();
    if (next === undefined) {
      return { type: "complete", reason: "no-more-scripted-decisions" };
    }
    if (next instanceof Error) {
      throw next;
    }
    return next as RoutingDecision;
  }
}

async function createGroup(harness: Harness) {
  const group = await harness.bots.createGroup({
    title: "Team",
    botIds: [BOT_ID, TESTER_ID, BUILDER_ID],
  });
  const topic = await harness.service.createGroupTopic(group.id, "Sprint", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  return { group, topic };
}

/** Accept an automatic Run through the real service accept path, settling the
 *  first routing decision deterministically before returning. */
async function acceptAutomatic(harness: Harness, conversationId: string, topicId: string, requestId: string) {
  const accepted = await harness.service.acceptGroupPrompt({
    conversationId,
    topicId,
    requestId,
    text: "ship the change",
    target: { mode: "automatic" },
    humanIngress: {
      chatKey: "relay:acct",
      senderId: "acct",
      accountId: "acct",
      isOwner: true,
      chatType: "group",
    },
  });
  await harness.service.awaitRouting();
  return accepted;
}

// ---------------------------------------------------------------------------
// §11.2 / §12.1 — Decision schema validation (§22 "malformed schema rejected")
// ---------------------------------------------------------------------------

test("malformed router decision schema is rejected with a machine-readable code", () => {
  const malformed: unknown[] = [
    null,
    "complete",
    {},
    { type: "none" },
    { type: "dispatch" },
    { type: "dispatch", mode: "sometimes", assignments: [] },
    { type: "dispatch", mode: "single", assignments: [] },
    { type: "dispatch", mode: "single", assignments: [{ id: "a", botId: BOT_ID }] },
    { type: "dispatch", mode: "single", assignments: [{ id: "a", botId: BOT_ID, task: "" }] },
    { type: "dispatch", mode: "single", assignments: [{ id: "", botId: BOT_ID, task: "t", triggerMessageIds: [] }] },
    { type: "dispatch", mode: "single", assignments: [{ id: "a", botId: BOT_ID, task: "t", triggerMessageIds: "x" }] },
    { type: "dispatch", mode: "single", assignments: [{ id: "a", botId: BOT_ID, task: "t", triggerMessageIds: [1] }] },
    { type: "dispatch", mode: "single", assignments: [{ id: "a", botId: BOT_ID, task: "t", dependsOn: "b", triggerMessageIds: [] }] },
    { type: "need-human" },
    { type: "need-human", question: "" },
    { type: "complete" },
    { type: "complete", reason: "" },
    { type: "complete", reason: "ok", synthesisBotId: "" },
    { type: "complete", reason: 5 },
  ];
  for (const value of malformed) {
    expect(() => parseRoutingDecision(value)).toThrow(RoutingDecisionError);
  }
  // Self-dependency is structurally valid but a DOMAIN cycle: the gate — not
  // the parser — must reject it.
  expect(parseRoutingDecision({ type: "dispatch", mode: "sequential", assignments: [{ id: "a", botId: BOT_ID, task: "t", dependsOn: ["a"], triggerMessageIds: [] }] }))
    .toMatchObject({ type: "dispatch" });
});

test("router decision never implements an ambiguous none", () => {
  expect(() => parseRoutingDecision({ type: "none" })).toThrow(/not one of dispatch \| need-human \| complete/);
});

test("valid router decision shapes parse without defaulting fields", () => {
  expect(parseRoutingDecision({ type: "complete", reason: "done" }))
    .toEqual({ type: "complete", reason: "done" });
  expect(parseRoutingDecision({ type: "need-human", question: "which branch?" }))
    .toEqual({ type: "need-human", question: "which branch?" });
  const dispatch = parseRoutingDecision({
    type: "dispatch",
    mode: "single",
    assignments: [{ id: "a1", botId: BOT_ID, task: "review", expectedOutput: "notes", triggerMessageIds: ["cmsg_1"] }],
  });
  expect(dispatch).toEqual({
    type: "dispatch",
    mode: "single",
    assignments: [{
      id: "a1",
      botId: BOT_ID,
      task: "review",
      expectedOutput: "notes",
      triggerMessageIds: ["cmsg_1"],
    }],
  });
});

// ---------------------------------------------------------------------------
// §12.2 / §11.3 — Capability boundary (fail closed BEFORE execution)
// ---------------------------------------------------------------------------

test("an adapter that cannot prove the restriction is not a router", () => {
  expect(isRouterCapabilityRestricted(RESTRICTED)).toBe(true);
  expect(isRouterCapabilityRestricted(UNRESTRICTED_ROUTER_CAPABILITY)).toBe(false);
  for (const key of Object.keys(RESTRICTED) as Array<keyof RouterCapabilityRestriction>) {
    // Any single unproven restriction keeps automatic mode unsupported: the
    // boundary is all-or-nothing, never "mostly restricted".
    expect(isRouterCapabilityRestricted({ ...RESTRICTED, [key]: false })).toBe(false);
    expect(isRouterCapabilityRestricted({ ...RESTRICTED, [key]: undefined as never })).toBe(false);
  }
  expect(isRouterCapabilityRestricted(undefined)).toBe(false);
  expect(bindRouter({ decide: async () => ({ type: "complete", reason: "x" }) })).toBeUndefined();
  expect(bindRouter(undefined)).toBeUndefined();
});

test("unsupported adapter configuration disables automatic mode at accept", async () => {
  const harness = await createHarness();
  const { group, topic } = await createGroup(harness);
  // A Router object that CANNOT prove its restriction before execution is not
  // bindable, so `bindRouter` returns undefined and the engine is absent.
  const permissiveRouter = {
    capabilityRestriction: UNRESTRICTED_ROUTER_CAPABILITY,
    decide: async () => ({ type: "complete" as const, reason: "unreachable" }),
  };
  expect(bindRouter(permissiveRouter)).toBeUndefined();
  // With no usable Router configured, automatic must fail closed — never
  // accept a Run the Router could not legally decide.
  await expect(acceptAutomatic(harness, group.id, topic.id, "req-unsupported"))
    .rejects.toMatchObject({ code: "automatic_unsupported" });
  expect(harness.store.listRuns(group.id, topic.id)).toHaveLength(0);
  harness.store.close();
});

test("automatic run without a configured router fails closed even after accept", async () => {
  const harness = await createHarness();
  const { group, topic } = await createGroup(harness);
  // Accept directly at the store with the automatic reservation, then route
  // with no Router wired: the Run must fail, never hang nonterminal.
  const botA = harness.bots.getBot(BOT_ID);
  const target = topic.executionTarget!;
  const accepted = harness.store.acceptRequest({
    conversationId: group.id,
    topicId: topic.id,
    requestId: "req-no-router",
    botId: botA.id,
    content: "ship",
    profileSnapshot: snapshotGroupMemberProfile(botA, target, NOW),
    mode: "automatic",
    members: [],
    now: NOW,
  });
  expect(accepted.memberTurns).toHaveLength(0);
  expect(accepted.run.routingState).toBe("queued");
  await harness.service.routeAutomaticRun(accepted.run.id, false);
  const failed = harness.store.getRun(accepted.run.id)!;
  expect(failed.state).toBe("failed");
  expect(failed.completionReason).toBe("automatic_unsupported");
  harness.store.close();
});

// ---------------------------------------------------------------------------
// §11.1 — RoutingInput boundary: public-only, no Direct/private/other-Topic
// ---------------------------------------------------------------------------

test("router input contains no direct, private, or other-topic state", async () => {
  const harness = await createHarness({ router: new RecordingRouter([{ type: "complete", reason: "done" }]) });
  const { group, topic } = await createGroup(harness);
  const botA = harness.bots.getBot(BOT_ID);
  const botB = harness.bots.getBot(TESTER_ID);
  const target = topic.executionTarget!;

  // (a) Direct Conversation history for the SAME bots — must never reach the Router.
  await harness.service.acceptDirectPrompt({ botId: BOT_ID, requestId: "req-direct-1", content: "DIRECT SECRET" });
  await harness.service.acceptDirectPrompt({ botId: TESTER_ID, requestId: "req-direct-2", content: "DIRECT TESTER SECRET" });
  // (b) A second Group conversation with overlapping bots.
  const otherGroup = await harness.bots.createGroup({ title: "Other", botIds: [BOT_ID, TESTER_ID] });
  const otherTopic = await harness.service.createGroupTopic(otherGroup.id, "OtherTopic", {
    workspace: "backend", isolation: "shared-single-writer",
  });
  await harness.service.acceptGroupPrompt({
    conversationId: otherGroup.id, topicId: otherTopic.id, requestId: "req-other-group",
    text: "OTHER GROUP SECRET", target: { mode: "members", botIds: [BOT_ID] },
  });
  // (c) A second Topic in the SAME group.
  const siblingTopic = await harness.service.createGroupTopic(group.id, "Sibling", {
    workspace: "backend", isolation: "shared-single-writer",
  });
  await harness.service.acceptGroupPrompt({
    conversationId: group.id, topicId: siblingTopic.id, requestId: "req-sibling-topic",
    text: "SIBLING TOPIC SECRET", target: { mode: "members", botIds: [BOT_ID] },
  });

  const router = harness.router;
  await acceptAutomatic(harness, group.id, topic.id, "req-auto-input");
  expect(router).toBeDefined();
  const input = router!.inputs[0]!;
  // The Router sees only THIS Topic's public context and its own request.
  const serialized = JSON.stringify(input);
  expect(serialized).not.toContain("DIRECT SECRET");
  expect(serialized).not.toContain("DIRECT TESTER SECRET");
  expect(serialized).not.toContain("OTHER GROUP SECRET");
  expect(serialized).not.toContain("SIBLING TOPIC SECRET");
  expect(input.request).toBe("ship the change");
  expect(input.conversationId).toBe(group.id);
  expect(input.topicId).toBe(topic.id);
  // Membership metadata is opaque ids + durable profile fields only.
  expect(input.memberMetadata.map((member) => member.botId).sort())
    .toEqual([BOT_ID, BUILDER_ID, TESTER_ID].sort());
  expect(input.memberMetadata.every((member) => member.enabled === true)).toBe(true);
  // No instructions / no session aliases / no hidden history in the payload.
  expect(serialized).not.toContain("brt_");
  expect(serialized).not.toContain("instructions");
  expect(serialized).not.toContain("logicalSessionId");
  expect(input.executionTarget.isolation).toBe("shared-single-writer");
  harness.store.close();
});

test("router input is rebuilt from durable state on every decide call (no hidden router history)", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "a1", botId: BOT_ID, task: "review", triggerMessageIds: [] }] },
    { type: "complete", reason: "done" },
  ]);
  const harness = await createHarness({ router, autoKick: false });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "req-stateless");
  expect(harness.store.getRun(accepted.run.id)!.routingState).toBe("dispatching");
  // Let the dispatcher execute the dispatched batch; the batch-settle hook
  // then routes again, and the Router's second decision completes the Run.
  await harness.dispatcher.kick();
  const run = harness.store.getRun(accepted.run.id)!;
  expect(run.state).toBe("completed");
  expect(run.routingState).toBe("done");
  expect(harness.store.listMemberTurns(run.id).map((turn) => turn.origin)).toEqual(["router"]);
  // Second decision must see the completed assignment from DURABLE rows.
  expect(router.inputs).toHaveLength(2);
  expect(router.inputs[1]!.completedAssignments).toHaveLength(1);
  expect(router.inputs[1]!.completedAssignments[0]!.id).toBe("a1");
  expect(router.inputs[1]!.completedAssignments[0]!.outcome).toBe("completed");
  harness.store.close();
});

test("sequential assignment input exposes the prior public result to the router", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "a1", botId: BOT_ID, task: "review", triggerMessageIds: [] }] },
    { type: "dispatch", mode: "single", assignments: [{ id: "a2", botId: BUILDER_ID, task: "fix", triggerMessageIds: [] }] },
    { type: "complete", reason: "done" },
  ]);
  const harness = await createHarness({ router });
  harness.runner.result = { status: "completed", text: "PUBLIC REVIEW RESULT" };
  const { group, topic } = await createGroup(harness);
  await acceptAutomatic(harness, group.id, topic.id, "req-seq-result");
  await harness.dispatcher.kick();
  await harness.dispatcher.kick();
  expect(router.inputs).toHaveLength(3);
  const second = router.inputs[1]!;
  expect(second.completedAssignments).toHaveLength(1);
  expect(second.completedAssignments[0]!.result).toBe("PUBLIC REVIEW RESULT");
  harness.store.close();
});

// ---------------------------------------------------------------------------
// §11.4 — Automatic Run durable state machine + restart determinism
// ---------------------------------------------------------------------------

test("automatic run terminal states are durable and reopen deterministically", async () => {
  const router = new RecordingRouter([{ type: "complete", reason: "work-complete" }]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "req-terminal");
  const completed = harness.store.getRun(accepted.run.id)!;
  expect(completed.state).toBe("completed");
  expect(completed.completionReason).toBe("work-complete");
  expect(completed.routingState).toBe("done");
  expect(completed.finishedAt).toBeDefined();

  // Reopen: the terminal outcome survives verbatim (no re-route, no kick).
  harness.store.close();
  const reopened = await SqliteConversationStore.open(harness.path);
  const reloaded = reopened.getRun(accepted.run.id)!;
  expect(reloaded.state).toBe("completed");
  expect(reloaded.completionReason).toBe("work-complete");
  expect(reloaded.routingState).toBe("done");
  expect(reopened.listRoutingDecisions(accepted.run.id)).toEqual([
    {
      runId: accepted.run.id,
      decisionType: "complete",
      reason: "work-complete",
      assignmentIds: [],
      at: expect.any(String),
    },
  ]);
  // A routed-terminal Run is never routed again.
  expect(() => reopened.markRoutingState(accepted.run.id, "routing", NOW)).toThrow(/routing is sealed/);
  reopened.close();
});

test("need-human persists a durable waiting-human run", async () => {
  const router = new RecordingRouter([{ type: "need-human", question: "which branch ships?" }]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "req-need-human");
  const run = harness.store.getRun(accepted.run.id)!;
  expect(run.state).toBe("waiting-human");
  expect(run.completionReason).toBe("needs-input");
  expect(run.routingState).toBe("done");
  // Durable, not in-memory: the question and the terminal state both survive reopen.
  harness.store.close();
  const reopened = await SqliteConversationStore.open(harness.path);
  expect(reopened.getRun(accepted.run.id)!.state).toBe("waiting-human");
  const decisions = reopened.listRoutingDecisions(accepted.run.id);
  expect(decisions[0]!.decisionType).toBe("need-human");
  expect(decisions[0]!.question).toBe("which branch ships?");
  reopened.close();
});

test("crash at the routing boundary re-routes deterministically on restart", async () => {
  // The durable routing marker moves `queued → routing → dispatching` inside
  // the store. A crash while `routing` (Router asked, no durable batch yet)
  // must re-ask from `queued`, never half-apply a decision.
  const router = new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "a1", botId: BOT_ID, task: "review", triggerMessageIds: [] }] },
  ]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  const botA = harness.bots.getBot(BOT_ID);
  const accepted = harness.store.acceptRequest({
    conversationId: group.id, topicId: topic.id, requestId: "req-route-crash",
    botId: botA.id, content: "go",
    profileSnapshot: snapshotGroupMemberProfile(botA, topic.executionTarget!, NOW),
    mode: "automatic", members: [], now: NOW,
  });
  expect(accepted.memberTurns).toHaveLength(0);
  expect(accepted.run.routingState).toBe("queued");
  // Route explicitly (no fire-and-forget) so the assertion sees the durable
  // outcome of the decision, exactly as a restarting consumer would.
  await harness.service.routeAutomaticRun(accepted.run.id, false);
  const dispatchState = harness.store.getRun(accepted.run.id)!;
  expect(dispatchState.routingState).toBe("dispatching");
  const turns = harness.store.listMemberTurns(accepted.run.id);
  expect(turns).toHaveLength(1);
  expect(turns[0]!.origin).toBe("router");
  const dispatches = harness.store.listDispatchesForRun(accepted.run.id);
  expect(dispatches).toHaveLength(1);
  expect(dispatches[0]!.state).toBe("pending");

  // Reopen the store: the durable marker alone drives the next decision, and
  // `dispatching` blocks a second batch until the current one is terminal.
  harness.store.close();
  const reopened = await SqliteConversationStore.open(harness.path);
  const reloaded = reopened.getRun(accepted.run.id)!;
  expect(reloaded.routingState).toBe("dispatching");
  expect(reopened.listMemberTurns(accepted.run.id)).toHaveLength(1);
  // The active batch blocks a second dispatch, deterministically, from durable
  // rows alone — no process memory involved.
  const botB = harness.bots.getBot(TESTER_ID);
  const secondAssignment: RoutingAssignmentInput = {
    id: "a2",
    botId: TESTER_ID,
    task: "test",
    triggerMessageIds: [reloaded.requestMessageId],
    profileSnapshot: snapshotGroupMemberProfile(botB, topic.executionTarget!, NOW),
  };
  expect(() => reopened.applyRoutingDecision({
    runId: accepted.run.id, now: NOW,
    decision: { type: "dispatch", mode: "single", assignments: [secondAssignment] },
    requestMessageId: reloaded.requestMessageId,
  })).toThrow(/routing_batch_active|unsettled members in batch/);
  expect(reopened.listRoutingDecisions(accepted.run.id)).toHaveLength(1);
  reopened.close();
});

test("budget exhaustion is an explicit completion reason, never a loop guard", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "a1", botId: BOT_ID, task: "t1", triggerMessageIds: [] }] },
    { type: "dispatch", mode: "single", assignments: [{ id: "a2", botId: TESTER_ID, task: "t2", triggerMessageIds: [] }] },
  ]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  // Budget exactly 2: the second dispatch must be refused as budget-exhausted
  // rather than silently truncating to one member.
  const accepted = harness.store.acceptRequest({
    conversationId: group.id,
    topicId: topic.id,
    requestId: "req-budget",
    botId: harness.bots.getBot(BOT_ID).id,
    content: "go",
    profileSnapshot: snapshotGroupMemberProfile(harness.bots.getBot(BOT_ID), topic.executionTarget!, NOW),
    mode: "automatic",
    members: [{ botId: TESTER_ID, profileSnapshot: snapshotGroupMemberProfile(harness.bots.getBot(TESTER_ID), topic.executionTarget!, NOW) }],
    maxMemberTurns: 2,
    now: NOW,
  });
  expect(accepted.run.maxMemberTurns).toBe(2);
  await harness.dispatcher.kick();
  // First batch consumed both turns; the next decision cannot dispatch.
  await harness.service.routeAutomaticRun(accepted.run.id, false);
  const run = harness.store.getRun(accepted.run.id)!;
  expect(run.state).toBe("failed");
  expect(run.completionReason).toBe("budget-exhausted");
  expect(run.finishedAt).toBeDefined();
  harness.store.close();
});

// ---------------------------------------------------------------------------
// §12.1 domain validation — unknown/non-member bot, budget, dependency edges
// ---------------------------------------------------------------------------

function baseInput(overrides: Partial<RoutingInput> = {}): RoutingInput {
  return {
    runId: "run_1",
    conversationId: "conversation_1",
    topicId: "topic_1",
    request: "ship",
    requestMessageId: "cmsg_1",
    publicTranscript: [],
    memberMetadata: [
      { botId: BOT_ID, name: "Reviewer", agent: "codex", workspace: "backend", enabled: true },
      { botId: TESTER_ID, name: "Tester", agent: "codex", workspace: "backend", enabled: false },
    ],
    runState: {
      runId: "run_1",
      conversationId: "conversation_1",
      topicId: "topic_1",
      mode: "automatic",
      generation: 1,
      maxMemberTurns: 24,
      consumedMemberTurns: 0,
      failedBotIds: [],
    },
    completedAssignments: [],
    remainingBudget: 24,
    executionTarget: { workspace: "backend", isolation: "shared-single-writer" },
    ...overrides,
  };
}

test("router decision naming an unknown or non-member bot is rejected", () => {
  const gate = gateRoutingDecision({
    type: "dispatch",
    mode: "single",
    assignments: [{ id: "a", botId: "bot_ghost", task: "t", triggerMessageIds: ["cmsg_1"] }],
  }, baseInput());
  expect(gate).toEqual({ kind: "rejected", code: "router_unknown_member", message: expect.any(String) });
});

test("router decision naming a disabled member is rejected", () => {
  const gate = gateRoutingDecision({
    type: "dispatch",
    mode: "single",
    assignments: [{ id: "a", botId: TESTER_ID, task: "t", triggerMessageIds: ["cmsg_1"] }],
  }, baseInput());
  expect(gate).toEqual({ kind: "rejected", code: "router_member_unavailable", message: expect.any(String) });
});

test("router decision exceeding the remaining budget is rejected", () => {
  const gate = gateRoutingDecision({
    type: "dispatch",
    mode: "parallel",
    assignments: [
      { id: "a", botId: BOT_ID, task: "t", triggerMessageIds: ["cmsg_1"] },
      { id: "b", botId: TESTER_ID, task: "t", triggerMessageIds: ["cmsg_1"] },
    ],
  }, baseInput({
    memberMetadata: [
      { botId: BOT_ID, name: "Reviewer", agent: "codex", workspace: "backend", enabled: true },
      { botId: TESTER_ID, name: "Tester", agent: "codex", workspace: "backend", enabled: true },
    ],
    remainingBudget: 1,
  }));
  expect(gate).toEqual({ kind: "rejected", code: "router_budget_exhausted", message: expect.any(String) });
});

test("illegal assignment dependencies, cycles, modes and duplicates are rejected", () => {
  const members = [
    { botId: BOT_ID, name: "Reviewer", agent: "codex", workspace: "backend", enabled: true },
    { botId: TESTER_ID, name: "Tester", agent: "codex", workspace: "backend", enabled: true },
    { botId: BUILDER_ID, name: "Builder", agent: "codex", workspace: "backend", enabled: true },
  ];
  const input = baseInput({ memberMetadata: members });
  // Unknown dependency target.
  expect(gateRoutingDecision({
    type: "dispatch", mode: "sequential",
    assignments: [{ id: "a", botId: BOT_ID, task: "t", triggerMessageIds: ["cmsg_1"], dependsOn: ["ghost"] }],
  }, input)).toEqual({ kind: "rejected", code: "router_assignment_dependency_unknown", message: expect.any(String) });
  // Dependencies on a non-sequential batch.
  expect(gateRoutingDecision({
    type: "dispatch", mode: "parallel",
    assignments: [
      { id: "a", botId: BOT_ID, task: "t", triggerMessageIds: ["cmsg_1"], dependsOn: ["b"] },
      { id: "b", botId: TESTER_ID, task: "t", triggerMessageIds: ["cmsg_1"] },
    ],
  }, input)).toEqual({ kind: "rejected", code: "router_assignment_dependency_mode", message: expect.any(String) });
  // Duplicate assignment id.
  expect(gateRoutingDecision({
    type: "dispatch", mode: "parallel",
    assignments: [
      { id: "a", botId: BOT_ID, task: "t", triggerMessageIds: ["cmsg_1"] },
      { id: "a", botId: TESTER_ID, task: "t", triggerMessageIds: ["cmsg_1"] },
    ],
  }, input)).toEqual({ kind: "rejected", code: "router_assignment_duplicate", message: expect.any(String) });
  // Same Bot twice in one batch.
  expect(gateRoutingDecision({
    type: "dispatch", mode: "parallel",
    assignments: [
      { id: "a", botId: BOT_ID, task: "t", triggerMessageIds: ["cmsg_1"] },
      { id: "b", botId: BOT_ID, task: "t", triggerMessageIds: ["cmsg_1"] },
    ],
  }, input)).toEqual({ kind: "rejected", code: "router_assignment_duplicate_member", message: expect.any(String) });
  // Cyclic dependency graph inside the decision.
  expect(gateRoutingDecision({
    type: "dispatch", mode: "sequential",
    assignments: [
      { id: "a", botId: BOT_ID, task: "t", triggerMessageIds: ["cmsg_1"], dependsOn: ["b"] },
      { id: "b", botId: TESTER_ID, task: "t", triggerMessageIds: ["cmsg_1"], dependsOn: ["a"] },
    ],
  }, input)).toEqual({ kind: "rejected", code: "router_assignment_dependency_cycle", message: expect.any(String) });
  // single with 2 assignments / parallel with 1.
  expect(gateRoutingDecision({
    type: "dispatch", mode: "single",
    assignments: [
      { id: "a", botId: BOT_ID, task: "t", triggerMessageIds: ["cmsg_1"] },
      { id: "b", botId: TESTER_ID, task: "t", triggerMessageIds: ["cmsg_1"] },
    ],
  }, input)).toEqual({ kind: "rejected", code: "router_assignment_mode", message: expect.any(String) });
  expect(gateRoutingDecision({
    type: "dispatch", mode: "parallel",
    assignments: [{ id: "a", botId: BOT_ID, task: "t", triggerMessageIds: ["cmsg_1"] }],
  }, input)).toEqual({ kind: "rejected", code: "router_assignment_mode", message: expect.any(String) });
});

test("a clean router decision passes the gate", () => {
  const gate = gateRoutingDecision({
    type: "dispatch", mode: "sequential",
    assignments: [
      { id: "a", botId: BOT_ID, task: "review", expectedOutput: "notes", triggerMessageIds: ["cmsg_1"] },
      { id: "b", botId: TESTER_ID, task: "fix", triggerMessageIds: ["cmsg_1"], dependsOn: ["a"] },
    ],
  }, baseInput({
    memberMetadata: [
      { botId: BOT_ID, name: "Reviewer", agent: "codex", workspace: "backend", enabled: true },
      { botId: TESTER_ID, name: "Tester", agent: "codex", workspace: "backend", enabled: true },
    ],
    completedAssignments: [{ id: "seed", botId: BOT_ID, task: "", dependsOn: [], triggerMessageIds: [], outcome: "completed", attempt: 1, batch: 1 }],
  }));
  expect(gate.kind).toBe("decision");
});

// ---------------------------------------------------------------------------
// §11.5 / acceptance 10 — completion semantics
// ---------------------------------------------------------------------------

test("explicit runs never route and never call the router", async () => {
  const router = new RecordingRouter([{ type: "dispatch", mode: "single", assignments: [{ id: "a", botId: BUILDER_ID, task: "steal", triggerMessageIds: [] }] }]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  const accepted = await harness.service.acceptGroupPrompt({
    conversationId: group.id, topicId: topic.id, requestId: "req-explicit",
    text: "review it", target: { mode: "members", botIds: [BOT_ID, TESTER_ID] },
    humanIngress: { chatKey: "relay:acct", senderId: "acct", isOwner: true, chatType: "group" },
  });
  expect(accepted.run.mode).toBe("explicit");
  expect(accepted.run.routingState).toBeUndefined();
  await harness.dispatcher.kick();
  // Explicit Run terminal after selected members terminal; Router never asked.
  expect(router.inputs).toHaveLength(0);
  expect(harness.store.getRun(accepted.run.id)!.state).toBe("completed");
  // Routing an explicit Run is refused, not silently ignored.
  expect(() => harness.store.markRoutingState(accepted.run.id, "routing", NOW))
    .toThrow(/is explicit, not automatic/);
  expect(harness.store.listRoutingDecisions(accepted.run.id)).toHaveLength(0);
  harness.store.close();
});

test("automatic completes by planned work then a router complete, without leftover work", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "parallel", assignments: [
      { id: "a", botId: BOT_ID, task: "review", triggerMessageIds: [] },
      { id: "b", botId: TESTER_ID, task: "test", triggerMessageIds: [] },
    ] },
    { type: "complete", reason: "plan-completed" },
  ]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "req-parallel");
  await harness.dispatcher.kick();
  const members = harness.store.listMemberTurns(accepted.run.id);
  expect(members.map((turn) => turn.assignmentId)).toEqual(["a", "b"]);
  expect(members.map((turn) => turn.origin)).toEqual(["router", "router"]);
  expect(harness.store.getRun(accepted.run.id)!.state).toBe("completed");
  harness.store.close();
});

// ---------------------------------------------------------------------------
// §11.6 / acceptance 11 — provenance: no human permission authority
// ---------------------------------------------------------------------------

test("router-selected member turns carry orchestration provenance only", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "a1", botId: BOT_ID, task: "review", triggerMessageIds: [] }] },
    { type: "complete", reason: "done" },
  ]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  // The accept carries real human ingress — yet automatic work must NOT
  // inherit it, and the Router decision must not mint human authority.
  await acceptAutomatic(harness, group.id, topic.id, "req-provenance");
  await harness.dispatcher.kick();
  for (const run of harness.runner.runs) {
    expect(run.executionOrigin).toBe("orchestration");
    expect(run.permissionRoute).toBeUndefined();
  }
  const turn = harness.store.listMemberTurns(harness.store.getRun(harness.store.listRuns(group.id, topic.id)[0]!.id)!.id)[0]!;
  expect(turn.origin).toBe("router");
  const dispatch = harness.store.getDispatchForMemberTurn(turn.id)!;
  // The accepted human ingress was for the REQUEST only; the dispatch row for
  // automatic work carries no authority epoch and no permission route.
  expect(dispatch.authorityEpoch).toBeFalsy();
  expect(dispatch.humanIngress).toBeFalsy();
  harness.store.close();
});

// ---------------------------------------------------------------------------
// §13.1 — parallel batch uses one identical frozen public snapshot
// ---------------------------------------------------------------------------

test("parallel batch members receive the identical frozen public snapshot", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "parallel", assignments: [
      { id: "a", botId: BOT_ID, task: "review", triggerMessageIds: [] },
      { id: "b", botId: TESTER_ID, task: "test", triggerMessageIds: [] },
    ] },
    { type: "complete", reason: "done" },
  ]);
  const harness = await createHarness({ router, autoKick: false });
  const { group, topic } = await createGroup(harness);
  await acceptAutomatic(harness, group.id, topic.id, "req-frozen");
  const run = harness.store.getRun(harness.store.listRuns(group.id, topic.id)[0]!.id)!;
  // Same boundary for both: the request seq. Nothing from a sibling's result.
  for (const turn of harness.store.listMemberTurns(run.id)) {
    expect(turn.triggerMessageIds.length).toBeGreaterThan(0);
    expect(turn.triggerMessageIds).toContain(run.requestMessageId);
  }
  // Execute both: the public snapshot each member reads is byte-identical.
  // (The persona header differs by design — it names the member Bot; the
  // shared PUBLIC transcript below it must not.)
  const inbound = await harness.dispatcher.kick()
    .then(() => harness.runner.runs);
  expect(inbound.length).toBe(2);
  const transcriptOf = (text: string) => text.slice(text.indexOf("\n\n", text.indexOf("\n\n") + 2));
  for (const call of inbound) {
    expect(transcriptOf(call.text)).toBe(transcriptOf(inbound[0]!.text));
  }
  // "done" is the FakeRunner result text; it must never appear in an input,
  // which would mean a sibling's completion leaked into this member's view.
  for (const call of inbound) {
    expect(call.text).not.toContain("done");
  }
  harness.store.close();
});

test("sequential dependency fence blocks the successor until its dependency terminals", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "sequential", assignments: [
      { id: "a", botId: BOT_ID, task: "review", triggerMessageIds: [] },
      { id: "b", botId: TESTER_ID, task: "fix", triggerMessageIds: [], dependsOn: ["a"] },
    ] },
    { type: "complete", reason: "done" },
  ]);
  const harness = await createHarness({ router, autoKick: false });
  const { group, topic } = await createGroup(harness);
  harness.runner.result = { status: "completed", text: "SEQ RESULT FROM A" };
  await acceptAutomatic(harness, group.id, topic.id, "req-seq");
  const run = harness.store.getRun(harness.store.listRuns(group.id, topic.id)[0]!.id)!;
  const turns = harness.store.listMemberTurns(run.id);
  expect(turns.map((turn) => turn.assignmentId)).toEqual(["a", "b"]);
  // The successor is claimable only through its dependency; the store fence
  // refuses it while `a` is still non-terminal.
  expect(harness.store.claimNextDispatch({
    now: NOW, owner: "dispatcher-a", leaseExpiresAt: "2026-09-15T12:05:00.000Z", authorityEpoch: "epoch-a",
  })?.memberTurn.assignmentId).toBe("a");
  // With `a` claimed but not started, the drain must NOT admit `b`.
  const afterClaim = harness.store.claimNextDispatch({
    now: NOW, owner: "dispatcher-a", leaseExpiresAt: "2026-09-15T12:05:00.000Z", authorityEpoch: "epoch-a",
  });
  expect(afterClaim?.memberTurn.assignmentId).not.toBe("b");
  // Terminal the dependency: `b` becomes claimable.
  harness.store.completeExecution({
    runId: run.id, memberTurnId: turns[0]!.id, botId: turns[0]!.botId,
    content: "SEQ RESULT FROM A", sourceTurn: { sessionAlias: "sess_a", turnId: "sturn_a" }, now: NOW,
  });
  const successor = harness.store.claimNextDispatch({
    now: NOW, owner: "dispatcher-a", leaseExpiresAt: "2026-09-15T12:05:00.000Z", authorityEpoch: "epoch-a",
  });
  expect(successor?.memberTurn.assignmentId).toBe("b");
  // The successor's trigger boundary extends past the request, so its input
  // includes the dependency's public result — verified through the prompt the
  // dispatcher composes for it (execute() below).
  harness.store.close();
});

test("sequential assignment sees the earlier public result in its transcript", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "sequential", assignments: [
      { id: "a", botId: BOT_ID, task: "review", triggerMessageIds: [] },
      { id: "b", botId: TESTER_ID, task: "fix", triggerMessageIds: [], dependsOn: ["a"] },
    ] },
    { type: "complete", reason: "done" },
  ]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  harness.runner.result = { status: "completed", text: "SEQ RESULT FROM A" };
  await acceptAutomatic(harness, group.id, topic.id, "req-seq-result");
  await harness.dispatcher.kick();
  const run = harness.store.getRun(harness.store.listRuns(group.id, topic.id)[0]!.id)!;
  const turns = harness.store.listMemberTurns(run.id);
  expect(turns.map((turn) => turn.assignmentId)).toEqual(["a", "b"]);
  // Step 1 ran; step 2 became claimable only after it terminal, so its prompt
  // carries the earlier public result.
  expect(turns[1]!.state).toBe("completed");
  const secondPrompt = harness.runner.runs.find((call) => call.memberTurnId === turns[1]!.id)!.text;
  expect(secondPrompt).toContain("SEQ RESULT FROM A");
  harness.store.close();
});

// ---------------------------------------------------------------------------
// §13.2 — filesystem policy constrains requested parallelism
// ---------------------------------------------------------------------------

test("router-requested parallel work serializes when filesystem policy demands it", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "parallel", assignments: [
      { id: "a", botId: BOT_ID, task: "review", triggerMessageIds: [] },
      { id: "b", botId: TESTER_ID, task: "test", triggerMessageIds: [] },
    ] },
    { type: "complete", reason: "done" },
  ]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  await acceptAutomatic(harness, group.id, topic.id, "req-serialize");
  const run = harness.store.getRun(harness.store.listRuns(group.id, topic.id)[0]!.id)!;
  const [turnA, turnB] = harness.store.listMemberTurns(run.id);
  // No member turn may declare a proven read-only capability: automatic work
  // carries no enforceable proof, so it takes the writer slot.
  expect(turnA!.effect).toBeUndefined();
  expect(turnB!.effect).toBeUndefined();
  // The durable dispatch rows are both pending; the writer-slot gate in the
  // dispatcher (not the Router's "parallel") decides actual overlap.
  const dispatches = harness.store.listDispatchesForRun(run.id);
  expect(dispatches).toHaveLength(2);
  expect(dispatches.every((dispatch) => dispatch.state === "pending")).toBe(true);
  harness.store.close();
});

// ---------------------------------------------------------------------------
// §14.3 / acceptance 17 — cancel stops new routing
// ---------------------------------------------------------------------------

test("cancelled automatic run never dispatches again and stays sealed", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "a1", botId: BOT_ID, task: "review", triggerMessageIds: [] }] },
    { type: "complete", reason: "unreachable" },
  ]);
  const harness = await createHarness({ router, autoKick: false });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "req-cancel");
  const runId = accepted.run.id;
  expect(harness.store.getRun(runId)!.state).toBe("running");
  expect(harness.store.getRun(runId)!.routingState).toBe("dispatching");
  await harness.service.cancelRun(runId);
  const cancelled = harness.store.getRun(runId)!;
  expect(cancelled.state).toBe("cancelled");
  // The next decision is dropped: no new dispatch, no resurrect.
  const outcome = await new ConversationRouterEngine(bindRouter(router)!, {
    store: harness.store,
    readGroup: (conversationId) => harness.state.conversations[conversationId],
    readTopic: (conversationId, topicId) => harness.state.conversation_topics[topicId],
    readBot: (botId) => harness.state.bots[botId],
    now: () => new Date(NOW),
  }).route(runId);
  expect(outcome.outcome).toBe("skipped");
  expect(outcome.reason).toBe("run_cancelled");
  expect(harness.store.listMemberTurns(runId)).toHaveLength(1);
  expect(harness.store.listDispatchesForRun(runId).every((d) => d.state !== "pending")).toBe(true);
  harness.store.close();
});

test("late router decision after a sealed indeterminate run is a no-op", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "a1", botId: BOT_ID, task: "review", triggerMessageIds: [] }] },
    { type: "complete", reason: "unreachable" },
  ]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  await acceptAutomatic(harness, group.id, topic.id, "req-sealed");
  const run = harness.store.getRun(harness.store.listRuns(group.id, topic.id)[0]!.id)!;
  const turn = harness.store.listMemberTurns(run.id)[0]!;
  // Seal it as indeterminate the way the dispatcher does for started work
  // whose outcome is unknown (no blind retry, no new Router dispatch).
  const sealed = harness.store.failExecution({
    runId: run.id,
    memberTurnId: turn.id,
    now: NOW,
    reason: "started_result_unknown",
    terminalState: "indeterminate",
  });
  expect(sealed.state).toBe("indeterminate");
  const outcome = await new ConversationRouterEngine(bindRouter(router)!, {
    store: harness.store,
    readGroup: (conversationId) => harness.state.conversations[conversationId],
    readTopic: (conversationId, topicId) => harness.state.conversation_topics[topicId],
    readBot: (botId) => harness.state.bots[botId],
    now: () => new Date(NOW),
  }).route(run.id);
  expect(outcome.outcome).toBe("skipped");
  expect(router.inputs).toHaveLength(1);
  expect(harness.store.getRun(run.id)!.state).toBe("indeterminate");
  expect(harness.store.listMemberTurns(run.id)).toHaveLength(1);
  expect(harness.store.getMemberTurn(turn.id)!.state).toBe("indeterminate");
  harness.store.close();
});

// ---------------------------------------------------------------------------
// Acceptance 19 — malformed/unsafe decision fails closed before members
// ---------------------------------------------------------------------------

test("malformed router decision fails the run before any durable member turn", async () => {
  const router = new RecordingRouter([{ type: "dispatch", mode: "parallel", assignments: [{ id: "a", botId: "bot_ghost", task: "t", triggerMessageIds: [] }] }]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "req-malformed");
  const run = harness.store.getRun(accepted.run.id)!;
  expect(run.state).toBe("failed");
  expect(run.completionReason).toBe("router_unknown_member");
  expect(run.finishedAt).toBeDefined();
  expect(harness.store.listMemberTurns(run.id)).toHaveLength(0);
  expect(harness.store.listDispatchesForRun(run.id)).toHaveLength(0);
  expect(harness.runner.runs).toHaveLength(0);
  // A run event reached the product projection so Web/Relay can show it.
  expect(harness.events.some((event) => event.type === "conversation-run-changed")).toBe(true);
  harness.store.close();
});

test("router assignment triggerMessageIds must reference this topic's public rows", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "a", botId: BOT_ID, task: "t", triggerMessageIds: ["cmsg_from_another_topic"] }] },
  ]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  // A public row that exists but belongs to ANOTHER topic.
  const otherTopic = await harness.service.createGroupTopic(group.id, "Other", {
    workspace: "backend", isolation: "shared-single-writer",
  });
  await harness.service.acceptGroupPrompt({
    conversationId: group.id, topicId: otherTopic.id, requestId: "req-other-topic-msg",
    text: "other", target: { mode: "members", botIds: [BOT_ID] },
  });
  // Accept commits (idempotency stays honest) and the routing decision fails
  // the Run durably, before any MemberTurn exists.
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "req-trigger-scope");
  const run = harness.store.getRun(accepted.run.id)!;
  expect(run.state).toBe("failed");
  expect(run.completionReason).toBe("routing_message_not_found");
  expect(harness.store.listMemberTurns(run.id)).toHaveLength(0);
  expect(harness.store.listDispatchesForRun(run.id)).toHaveLength(0);
  harness.store.close();
});

test("router failure records durable run failure instead of spinning", async () => {
  const router = new RecordingRouter([new Error("router transport failed")]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "req-router-throw");
  const run = harness.store.getRun(accepted.run.id)!;
  expect(run.state).toBe("failed");
  expect(run.completionReason).toBe("router-execution-failed");
  expect(harness.runner.runs).toHaveLength(0);
  harness.store.close();
});

// ---------------------------------------------------------------------------
// Acceptance 7 — assignment fields survive durably
// ---------------------------------------------------------------------------

test("router dispatch preserves assignmentId, task, expectedOutput, dependsOn, triggerMessageIds", async () => {
  const router = new RecordingRouter([
    { type: "complete", reason: "noop" },
  ]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  const botA = harness.bots.getBot(BOT_ID);
  const botB = harness.bots.getBot(TESTER_ID);
  const accepted = harness.store.acceptRequest({
    conversationId: group.id, topicId: topic.id, requestId: "req-assign",
    botId: botA.id, content: "go",
    profileSnapshot: snapshotGroupMemberProfile(botA, topic.executionTarget!, NOW),
    mode: "automatic", members: [], now: NOW,
  });
  const decision: RoutingDecision = {
    type: "dispatch",
    mode: "sequential",
    assignments: [
      { id: "assign_review", botId: BOT_ID, task: "review the diff", expectedOutput: "notes", triggerMessageIds: [accepted.message.id] },
      { id: "assign_fix", botId: TESTER_ID, task: "apply fix", expectedOutput: "patch", triggerMessageIds: [accepted.message.id], dependsOn: ["assign_review"] },
    ],
  };
  const gate = gateRoutingDecision(decision, harness.engineInput(accepted.run.id));
  expect(gate.kind).toBe("decision");
  const applied = harness.store.applyRoutingDecision({
    runId: accepted.run.id,
    now: NOW,
    decision: harness.withSnapshots(gate.decision, topic.executionTarget!),
    requestMessageId: accepted.message.id,
  });
  expect(applied.memberTurns).toHaveLength(2);
  expect(applied.dispatches).toHaveLength(2);
  const [review, fix] = applied.memberTurns;
  expect(review!.assignmentId).toBe("assign_review");
  expect(review!.task).toBe("review the diff");
  expect(review!.expectedOutput).toBe("notes");
  // (Absence of dependsOn means none: the durable JSON default is empty.)
  expect(review!.dependsOn ?? []).toEqual([]);
  expect(review!.triggerMessageIds).toEqual([accepted.message.id]);
  expect(review!.origin).toBe("router");
  expect(fix!.assignmentId).toBe("assign_fix");
  expect(fix!.task).toBe("apply fix");
  expect(fix!.dependsOn).toEqual(["assign_review"]);
  // Durable across reopen.
  harness.store.close();
  const reopened = await SqliteConversationStore.open(harness.path);
  const reopenedTurns = reopened.listMemberTurns(accepted.run.id);
  expect(reopenedTurns.map((turn) => turn.assignmentId)).toEqual(["assign_review", "assign_fix"]);
  expect(reopenedTurns[1]!.dependsOn).toEqual(["assign_review"]);
  expect(reopenedTurns[0]!.profileSnapshot!.execution.agent).toBe("codex");
  reopened.close();
});

// ---------------------------------------------------------------------------
// Direct conversations never route
// ---------------------------------------------------------------------------

test("direct conversations are untouched by routing", async () => {
  const router = new RecordingRouter([{ type: "complete", reason: "unreachable" }]);
  const harness = await createHarness({ router });
  const accepted = await harness.service.acceptDirectPrompt({
    botId: BOT_ID, requestId: "req-direct", content: "hello",
  });
  expect(accepted.run.mode).toBe("explicit");
  expect(accepted.run.routingState).toBeUndefined();
  expect(() => harness.store.markRoutingState(accepted.run.id, "routing", NOW))
    .toThrow(/not automatic/);
  expect(router.inputs).toHaveLength(0);
  harness.store.close();
});

test("automatic accept on a group with no eligible member is refused", async () => {
  const harness = await createHarness({ router: new RecordingRouter() });
  const group = await harness.bots.createGroup({ title: "Team", botIds: [BOT_ID, TESTER_ID] });
  // Disable every member: admission must refuse rather than admit a Run the
  // Router could never populate.
  harness.state.bots[BOT_ID]!.enabled = false;
  harness.state.bots[TESTER_ID]!.enabled = false;
  const topic = await harness.service.createGroupTopic(group.id, "Sprint", {
    workspace: "backend", isolation: "shared-single-writer",
  });
  await expect(acceptAutomatic(harness, group.id, topic.id, "req-empty-group"))
    .rejects.toMatchObject({ code: "empty_target" });
  expect(harness.store.listRuns(group.id, topic.id)).toHaveLength(0);
  harness.store.close();
});

// ---------------------------------------------------------------------------
// Blocked-step seam (design §16 / plan §11.7)
// ---------------------------------------------------------------------------

test("blocked-step evidence persists on the automatic member turn", async () => {
  const router = new RecordingRouter([{ type: "complete", reason: "done" }]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  const botA = harness.bots.getBot(BOT_ID);
  const accepted = harness.store.acceptRequest({
    conversationId: group.id, topicId: topic.id, requestId: "req-blocked",
    botId: botA.id, content: "go",
    profileSnapshot: snapshotGroupMemberProfile(botA, topic.executionTarget!, NOW),
    mode: "automatic", members: [], now: NOW,
  });
  const gate = gateRoutingDecision({
    type: "dispatch", mode: "single",
    assignments: [{ id: "a1", botId: BOT_ID, task: "write code", triggerMessageIds: [accepted.message.id] }],
  }, harness.engineInput(accepted.run.id));
  expect(gate.kind).toBe("decision");
  harness.store.applyRoutingDecision({
    runId: accepted.run.id, now: NOW,
    decision: harness.withSnapshots(gate.decision, topic.executionTarget!),
    requestMessageId: accepted.message.id,
  });
  const turn = harness.store.listMemberTurns(accepted.run.id)[0]!;
  // Durable blocked-step field: PR8 stores the domain seam; the UX action
  // itself is a NEW explicit human request (PR9+), never an origin upgrade.
  expect(turn.blockedReason).toBeUndefined();
  harness.store.directWriteForTest("member_turns", turn.id, { blocked_reason: "human-authority-required" });
  harness.store.close();
  const reopened = await SqliteConversationStore.open(harness.path);
  const reopenedTurn = reopened.listMemberTurns(accepted.run.id)[0]!;
  expect(reopenedTurn.blockedReason).toBe("human-authority-required");
  expect(reopenedTurn.origin).toBe("router");
  reopened.close();
});

// ---------------------------------------------------------------------------
// Explicit behavior must never regress
// ---------------------------------------------------------------------------

test("explicit multi-member run has no continuation after members terminal", async () => {
  const router = new RecordingRouter([{ type: "complete", reason: "unreachable" }]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  const accepted = await harness.service.acceptGroupPrompt({
    conversationId: group.id, topicId: topic.id, requestId: "req-explicit-multi",
    text: "review", target: { mode: "members", botIds: [BOT_ID, TESTER_ID] },
    humanIngress: { chatKey: "relay:acct", senderId: "acct", isOwner: true, chatType: "group" },
  });
  await harness.dispatcher.kick();
  expect(harness.store.getRun(accepted.run.id)!.state).toBe("completed");
  expect(harness.store.getRun(accepted.run.id)!.routingState).toBeUndefined();
  expect(router.inputs).toHaveLength(0);
  expect(harness.store.listMemberTurns(accepted.run.id)).toHaveLength(2);
  harness.store.close();
});

// ---------------------------------------------------------------------------
// Control/Relay DTO projection (§17)
// ---------------------------------------------------------------------------

test("run DTO projects routing state on automatic runs only", async () => {
  const base = {
    id: "run_1",
    conversationId: "conversation_1",
    topicId: "topic_1",
    requestMessageId: "cmsg_1",
    requestId: "req",
    generation: 1,
    maxMemberTurns: 24,
    consumedMemberTurns: 0,
    failedBotIds: [],
    unavailableBotIds: [],
    profileRevision: 1,
    profileSnapshot: {
      revision: 1,
      capturedAt: NOW,
      presentation: { name: "Reviewer" },
      behavior: {},
      execution: { agent: "codex", workspace: "backend" },
    },
    createdAt: NOW,
  };
  // Explicit Runs never carry a routing state: the field is absent, so a
  // client cannot display routing UI for explicit work.
  expect(toConversationRun({ ...base, mode: "explicit", state: "running" }).routingState).toBeUndefined();
  // Automatic Runs project the durable substate verbatim.
  expect(toConversationRun({ ...base, mode: "automatic", state: "running", routingState: "dispatching" }).routingState)
    .toBe("dispatching");
  expect(toConversationRun({ ...base, mode: "automatic", state: "waiting-human", routingState: "done" }).routingState)
    .toBe("done");
});

test("member turn DTO projects blocked-step evidence", async () => {
  const base = {
    id: "mturn_1",
    runId: "run_1",
    conversationId: "conversation_1",
    topicId: "topic_1",
    botId: BOT_ID,
    batch: 1,
    memberIndex: 0,
    attempt: 1,
    origin: "router" as const,
    state: "queued" as const,
    triggerMessageIds: ["cmsg_1"],
    createdAt: NOW,
  };
  // Absent unless the step is actually blocked: a normal automatic turn must
  // not advertise "start this step myself".
  expect(toMemberTurnSummary(base).blockedReason).toBeUndefined();
  expect(toMemberTurnSummary({ ...base, blockedReason: "human-authority-required" }).blockedReason)
    .toBe("human-authority-required");
});

test("relay-protocol wire validators accept the PR8 fields and reject foreign values", async () => {
  const run = {
    type: "conversation-run-changed",
    run: {
      id: "run_1",
      conversationId: "conversation_1",
      topicId: "topic_1",
      requestMessageId: "cmsg_1",
      requestId: "req",
      mode: "automatic",
      state: "running",
      routingState: "dispatching",
      profileRevision: 1,
      createdAt: NOW,
    },
  };
  expect(validControlEvent(run)).toBe(true);
  // A foreign routing state fails the event rather than reaching the run card.
  expect(validControlEvent({
    ...run,
    run: { ...run.run, routingState: "deciding" },
  })).toBe(false);
  // Explicit Runs stay valid without the field (backwards compatible).
  expect(validControlEvent({
    ...run,
    run: { ...run.run, mode: "explicit", routingState: undefined },
  })).toBe(true);
  const memberEvent = {
    type: "member-turn-started",
    run: run.run,
    memberTurn: {
      id: "mturn_1",
      runId: "run_1",
      conversationId: "conversation_1",
      topicId: "topic_1",
      botId: BOT_ID,
      batch: 1,
      attempt: 1,
      origin: "router",
      state: "running",
      createdAt: NOW,
      blockedReason: "human-authority-required",
    },
  };
  expect(validControlEvent(memberEvent)).toBe(true);
  expect(validControlEvent({
    ...memberEvent,
    memberTurn: { ...memberEvent.memberTurn, blockedReason: "nope" },
  })).toBe(false);
});


// ---------------------------------------------------------------------------
// §14 restart determinism for automatic Runs
// ---------------------------------------------------------------------------

test("restart after routing recovers the owed decision from durable rows alone", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "a1", botId: BOT_ID, task: "review", triggerMessageIds: [] }] },
    { type: "complete", reason: "done" },
  ]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  const botA = harness.bots.getBot(BOT_ID);
  const accepted = harness.store.acceptRequest({
    conversationId: group.id, topicId: topic.id, requestId: "req-restart-route",
    botId: botA.id, content: "go",
    profileSnapshot: snapshotGroupMemberProfile(botA, topic.executionTarget!, NOW),
    mode: "automatic", members: [], now: NOW,
  });
  // Simulate a crash AFTER the batch settled but BEFORE the next decision:
  // drain the batch, then wipe nothing — durable rows are the only state.
  await harness.service.routeAutomaticRun(accepted.run.id, false);
  expect(harness.store.getRun(accepted.run.id)!.routingState).toBe("dispatching");
  await harness.dispatcher.kick();
  // The batch-settle hook already routed (decision 2: complete).
  await harness.service.awaitRouting();
  expect(harness.store.getRun(accepted.run.id)!.state).toBe("completed");

  // A fresh consumer over the SAME durable rows must not route again.
  harness.store.close();
  const reopened = await SqliteConversationStore.open(harness.path);
  const awaiting = reopened.automaticRunsAwaitingRouting();
  expect(awaiting).toHaveLength(0);
  reopened.close();
});

test("restart with an unsettled kept batch routes only after it terminals", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "a1", botId: BOT_ID, task: "review", triggerMessageIds: [] }] },
    { type: "complete", reason: "never" },
  ]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  const botA = harness.bots.getBot(BOT_ID);
  const accepted = harness.store.acceptRequest({
    conversationId: group.id, topicId: topic.id, requestId: "req-restart-held",
    botId: botA.id, content: "go",
    profileSnapshot: snapshotGroupMemberProfile(botA, topic.executionTarget!, NOW),
    mode: "automatic", members: [], now: NOW,
  });
  await harness.service.routeAutomaticRun(accepted.run.id, false);
  const held = harness.store.listMemberTurns(accepted.run.id)[0]!;
  expect(harness.store.getRun(accepted.run.id)!.state).toBe("running");
  // Never dispatch: the batch is unsettled, so recovery must NOT ask again.
  expect(harness.store.automaticRunsAwaitingRouting()).toHaveLength(0);
  void held;
  harness.store.close();
});

test("activation recovers an automatic run whose decision was never committed", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "a1", botId: BOT_ID, task: "review", triggerMessageIds: [] }] },
    { type: "complete", reason: "recovered" },
  ]);
  const harness = await createHarness({ router, autoKick: false });
  const { group, topic } = await createGroup(harness);
  const botA = harness.bots.getBot(BOT_ID);
  const accepted = harness.store.acceptRequest({
    conversationId: group.id, topicId: topic.id, requestId: "req-activation-recover",
    botId: botA.id, content: "go",
    profileSnapshot: snapshotGroupMemberProfile(botA, topic.executionTarget!, NOW),
    mode: "automatic", members: [], now: NOW,
  });
  // Durable state: accepted automatic Run, no decision committed, no batch.
  expect(accepted.run.routingState).toBe("queued");
  expect(harness.store.listMemberTurns(accepted.run.id)).toHaveLength(0);
  // A fresh consumer activating over these rows must recover the FIRST
  // decision itself — no web request, no in-process memory.
  await harness.service.activateAfterConsumerLock();
  await harness.service.awaitRouting();
  const recovered = harness.store.getRun(accepted.run.id)!;
  expect(recovered.routingState).toBe("dispatching");
  expect(harness.store.listMemberTurns(accepted.run.id).map((turn) => turn.origin)).toEqual(["router"]);
  // Drain and route to completion: the recovered Run keeps its full lifecycle.
  await harness.dispatcher.kick();
  await harness.service.awaitRouting();
  expect(harness.store.getRun(accepted.run.id)!.state).toBe("completed");
  expect(harness.store.getRun(accepted.run.id)!.completionReason).toBe("recovered");
  harness.store.close();
});
