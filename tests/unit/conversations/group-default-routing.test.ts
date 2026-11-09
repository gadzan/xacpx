import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { BotRuntimeManager } from "../../../src/bots/bot-runtime-manager";
import { BotService } from "../../../src/bots/bot-service";
import type { AppConfig } from "../../../src/config/types";
import { ConversationDispatcher } from "../../../src/conversations/conversation-dispatcher";
import { ConversationRouterEngine } from "../../../src/conversations/conversation-router-engine";
import { bindRouter } from "../../../src/conversations/conversation-router-gate";
import { ConversationRunService } from "../../../src/conversations/conversation-run-service";
import type {
  ConversationTurnCancelInput,
  ConversationTurnCancelResult,
  ConversationTurnRunInput,
  ConversationTurnRunResult,
  ConversationTurnRunner,
} from "../../../src/conversations/conversation-turn-runner";
import {
  resolveGroupDefaultRouting,
  type ConversationRecord,
} from "../../../src/conversations/conversation-types";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { toGroupSummary } from "../../../src/control/conversation-control-dtos";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { createStrictOwnedSessionRelease } from "../../../src/sessions/owned-session-release";
import { parseState, type StateStore } from "../../../src/state/state-store";
import { createEmptyState, type AppState } from "../../../src/state/types";
import { snapshotGroupMemberProfile } from "../../../src/bots/bot-types";
import {
  type ConversationRouter,
  type RouterCapabilityRestriction,
  type RoutingDecision,
  type RoutingInput,
} from "../../../src/conversations/conversation-router-types";

const NOW = "2026-11-01T12:00:00.000Z";

const RESTRICTED: RouterCapabilityRestriction = {
  toolsDisabled: true,
  filesystemDisabled: true,
  terminalDisabled: true,
  permissionInteractionDisabled: true,
  messagingDisabled: true,
  orchestrationDisabled: true,
  structuredOutputOnly: true,
};

class MemoryStateStore implements Pick<StateStore, "save" | "saveNow"> {
  async save(): Promise<void> {}
  async saveNow(): Promise<void> {}
}

class RecordingRunner implements ConversationTurnRunner {
  async run(_input: ConversationTurnRunInput): Promise<ConversationTurnRunResult> {
    return { status: "completed", text: "done" };
  }
  async cancel(_input: ConversationTurnCancelInput): Promise<ConversationTurnCancelResult> {
    return { outcome: "cancelled" };
  }
}

const completeRouter: ConversationRouter = {
  capabilityRestriction: RESTRICTED,
  async decide(_input: RoutingInput): Promise<RoutingDecision> {
    return { type: "complete", reason: "test complete" };
  },
};

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

interface Harness {
  store: SqliteConversationStore;
  state: AppState;
  bots: BotService;
  service: ConversationRunService;
}

async function createHarness(options: { router?: ConversationRouter } = {}): Promise<Harness> {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-default-routing-")), "conversation.sqlite");
  const store = await SqliteConversationStore.open(path);
  const state = createEmptyState();
  const stateStore = new MemoryStateStore();
  const stateMutex = new AsyncMutex();
  const config = createConfig();
  const sessions = new SessionService(config, stateStore, state, { now: () => Date.parse(NOW), stateMutex });
  const physical = {
    async deleteSession(): Promise<void> {},
    async releaseLogicalSession(): Promise<void> {},
  };
  const releaseOwnedSession = createStrictOwnedSessionRelease({ sessions, transport: physical });
  let botCounter = 0;
  const bots = new BotService(config, state, stateStore, {
    now: () => new Date(NOW),
    createId: () => `bot_gen_${botCounter++}`,
    stateMutex,
  });
  const runtime = new BotRuntimeManager(bots, sessions, state, stateStore, {
    now: () => new Date(NOW),
    stateMutex,
    releaseOwnedSession,
  });
  const nowFn = () => new Date(Date.parse(NOW) + 1_000);
  const dispatcher = new ConversationDispatcher(store, runtime, new RecordingRunner(), sessions, {
    now: nowFn,
    ownerId: "dispatcher-a",
  });
  const routerEngine = options.router
    ? new ConversationRouterEngine(bindRouter(options.router), {
      store,
      readGroup: (conversationId) => state.conversations[conversationId],
      readTopic: (conversationId, topicId) => {
        const topic = state.conversation_topics[topicId];
        return topic?.conversationId === conversationId ? topic : undefined;
      },
      readBot: (botId) => bots.getBot(botId),
      runLifecycleAll: (botIds, critical) => bots.runLifecycleAll(botIds, critical),
      now: nowFn,
    })
    : undefined;
  const service = new ConversationRunService(store, bots, runtime, dispatcher, sessions, state, stateStore, {
    now: nowFn,
    stateMutex,
    autoKick: false,
    releaseOwnedSession,
    ...(routerEngine ? { routerEngine } : {}),
  });
  return { store, state, bots, service };
}

async function createGroup(
  harness: Harness,
  options: { lead: boolean; defaultRouting?: "lead" | "automatic" },
) {
  const lead = await harness.bots.createBot({ name: "Lead", agent: "codex", workspace: "backend" });
  const other = await harness.bots.createBot({ name: "Other", agent: "codex", workspace: "backend" });
  const group = await harness.bots.createGroup({
    title: "Team",
    botIds: [lead.id, other.id],
    ...(options.lead ? { leadBotId: lead.id } : {}),
    ...(options.defaultRouting ? { defaultRouting: options.defaultRouting } : {}),
  });
  const topic = await harness.service.createGroupTopic(group.id, "Sprint", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  return { lead, other, group, topic };
}

function inputFor(scope: { group: { id: string }; topic: { id: string } }, requestId: string) {
  return { conversationId: scope.group.id, topicId: scope.topic.id, requestId, text: "what is the plan" };
}

/** Durable proof of automatic use: a zero-member automatic Run, exactly what
 *  the old per-send switch committed. */
function seedAutomaticRun(harness: Harness, group: ConversationRecord, topicId: string, botId: string): void {
  harness.store.acceptRequest({
    conversationId: group.id,
    topicId,
    requestId: "req-seed-automatic",
    botId,
    content: "seed",
    mode: "automatic",
    members: [],
    profileSnapshot: snapshotGroupMemberProfile(harness.bots.getBot(botId), undefined, NOW),
    now: NOW,
  });
}

test("a new Group stores no setting and resolves its default to the Lead", async () => {
  const harness = await createHarness();
  const { lead, group, topic } = await createGroup(harness, { lead: true });

  expect(harness.state.conversations[group.id]).not.toHaveProperty("defaultRouting");
  expect(resolveGroupDefaultRouting(harness.state.conversations[group.id]!, {
    routerAvailable: true,
    hasAutomaticRuns: false,
  })).toBe("lead");
  const accepted = await harness.service.acceptGroupPrompt(inputFor({ group, topic }, "req-new-group"));
  expect(accepted.run.mode).toBe("explicit");
  expect(accepted.memberTurns.map((turn) => turn.botId)).toEqual([lead.id]);
  harness.store.close();
});

test("a Group set to automatic sends plain messages into an automatic Run", async () => {
  const harness = await createHarness({ router: completeRouter });
  const { group, topic } = await createGroup(harness, { lead: true, defaultRouting: "automatic" });

  const accepted = await harness.service.acceptGroupPrompt(inputFor({ group, topic }, "req-auto-default"));
  expect(accepted.run.mode).toBe("automatic");
  expect(accepted.memberTurns).toEqual([]);
  expect(harness.store.listMemberTurns(accepted.run.id)).toEqual([]);
  harness.store.close();
});

test("the setting is per Group: an automatic Group never changes a lead Group", async () => {
  const harness = await createHarness({ router: completeRouter });
  const leadGroup = await createGroup(harness, { lead: true });
  const autoGroup = await createGroup(harness, { lead: true, defaultRouting: "automatic" });
  await harness.bots.updateGroup(autoGroup.group.id, { defaultRouting: "automatic" });

  const autoAccepted = await harness.service.acceptGroupPrompt(inputFor({ group: autoGroup.group, topic: autoGroup.topic }, "req-sticky-auto"));
  const leadAccepted = await harness.service.acceptGroupPrompt(inputFor({ group: leadGroup.group, topic: leadGroup.topic }, "req-sticky-lead"));
  expect(autoAccepted.run.mode).toBe("automatic");
  expect(leadAccepted.run.mode).toBe("explicit");
  // Re-reading the Groups keeps the choice durable across writes.
  expect(harness.bots.getGroup(autoGroup.group.id).defaultRouting).toBe("automatic");
  expect(harness.bots.getGroup(leadGroup.group.id).defaultRouting).toBeUndefined();
  harness.store.close();
});

test("explicit member, everyone and roundtable targets ignore the automatic default", async () => {
  const harness = await createHarness({ router: completeRouter });
  const { lead, other, group, topic } = await createGroup(harness, { lead: true, defaultRouting: "automatic" });

  const member = await harness.service.acceptGroupPrompt({
    ...inputFor({ group, topic }, "req-explicit-member"),
    target: { mode: "members", botIds: [other.id] },
  });
  expect(member.run.mode).toBe("explicit");
  expect(member.memberTurns.map((turn) => turn.botId)).toEqual([other.id]);

  const everyone = await harness.service.acceptGroupPrompt({
    ...inputFor({ group, topic }, "req-explicit-everyone"),
    target: { mode: "everyone" },
  });
  expect(everyone.run.mode).toBe("explicit");
  expect(everyone.memberTurns.map((turn) => turn.botId)).toEqual([lead.id, other.id]);

  const roundtable = await harness.service.acceptGroupPrompt({
    ...inputFor({ group, topic }, "req-explicit-roundtable"),
    target: { mode: "roundtable", botIds: [lead.id, other.id] },
  });
  expect(roundtable.run.mode).toBe("explicit");
  expect(roundtable.run.shape).toBe("roundtable");
  expect(roundtable.memberTurns).toHaveLength(2);
  harness.store.close();
});

test("an old Group with durable automatic Runs keeps automatic behavior", async () => {
  const harness = await createHarness({ router: completeRouter });
  const { lead, group, topic } = await createGroup(harness, { lead: true });
  seedAutomaticRun(harness, harness.bots.getGroup(group.id), topic.id, lead.id);

  expect(resolveGroupDefaultRouting(harness.bots.getGroup(group.id), {
    routerAvailable: true,
    hasAutomaticRuns: true,
  })).toBe("automatic");
  const accepted = await harness.service.acceptGroupPrompt(inputFor({ group, topic }, "req-migrated-auto"));
  expect(accepted.run.mode).toBe("automatic");
  harness.store.close();
});

test("an old automatic Group keeps working as the Lead while the Router is off", async () => {
  const harness = await createHarness();
  const { lead, group, topic } = await createGroup(harness, { lead: true });
  seedAutomaticRun(harness, harness.bots.getGroup(group.id), topic.id, lead.id);

  // No router engine: the derivation must not turn old plain sends into
  // refusals; they keep the pre-setting Lead behavior.
  expect(resolveGroupDefaultRouting(harness.bots.getGroup(group.id), {
    routerAvailable: false,
    hasAutomaticRuns: true,
  })).toBe("lead");
  const accepted = await harness.service.acceptGroupPrompt(inputFor({ group, topic }, "req-migrated-no-router"));
  expect(accepted.run.mode).toBe("explicit");
  expect(accepted.memberTurns.map((turn) => turn.botId)).toEqual([lead.id]);
  harness.store.close();
});

test("an explicit automatic setting fails loudly when the Router is off", async () => {
  const harness = await createHarness();
  const { group, topic } = await createGroup(harness, { lead: true, defaultRouting: "automatic" });

  await expect(harness.service.acceptGroupPrompt(inputFor({ group, topic }, "req-auto-no-router")))
    .rejects.toMatchObject({ code: "automatic_unsupported" });
  expect(harness.store.listRuns(group.id, topic.id)).toHaveLength(0);
  harness.store.close();
});

test("an addressed channel prompt on an automatic Group still targets the Lead", async () => {
  const harness = await createHarness({ router: completeRouter });
  const { lead, group, topic } = await createGroup(harness, { lead: true, defaultRouting: "automatic" });

  const accepted = await harness.service.acceptGroupPrompt({
    ...inputFor({ group, topic }, "req-addressed"),
    externalAddress: { botId: lead.id, name: lead.name },
  });
  expect(accepted.run.mode).toBe("explicit");
  expect(accepted.memberTurns.map((turn) => turn.botId)).toEqual([lead.id]);
  harness.store.close();
});

test("an effect policy on an automatic Group is refused instead of auto-routing", async () => {
  const harness = await createHarness({ router: completeRouter });
  const { lead, group, topic } = await createGroup(harness, { lead: true, defaultRouting: "automatic" });

  await expect(harness.service.acceptGroupPrompt({
    ...inputFor({ group, topic }, "req-policy"),
    memberPolicies: [{ botId: lead.id, filesystem: "read-only" }],
  })).rejects.toMatchObject({ code: "invalid-effect-policy" });
  harness.store.close();
});

test("create and update persist the setting through the daemon state validation", async () => {
  const harness = await createHarness();
  const { group } = await createGroup(harness, { lead: true });
  const updated = await harness.bots.updateGroup(group.id, { defaultRouting: "automatic" });
  expect(updated.defaultRouting).toBe("automatic");

  const parsed = parseState(JSON.parse(JSON.stringify(harness.state)), "test-state.json");
  expect(parsed.conversations[group.id]?.defaultRouting).toBe("automatic");
  harness.store.close();
});

test("a Group DTO projects the resolved default and never invents automatic", () => {
  const group: ConversationRecord = {
    id: "conversation_x",
    kind: "group",
    title: "Team",
    botIds: ["bot_a", "bot_b"],
    createdAt: NOW,
    updatedAt: NOW,
  };
  expect(toGroupSummary(group, undefined, resolveGroupDefaultRouting(group, {
    routerAvailable: true,
    hasAutomaticRuns: true,
  })).defaultRouting).toBe("automatic");
  expect(toGroupSummary(group, undefined, resolveGroupDefaultRouting(group, {
    routerAvailable: false,
    hasAutomaticRuns: true,
  })).defaultRouting).toBe("lead");
  expect(toGroupSummary({ ...group, defaultRouting: "automatic" }, undefined,
    resolveGroupDefaultRouting({ ...group, defaultRouting: "automatic" }, {
      routerAvailable: false,
      hasAutomaticRuns: false,
    })).defaultRouting).toBe("automatic");
});
