import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { BotRuntimeManager } from "../../../src/bots/bot-runtime-manager";
import { BotService } from "../../../src/bots/bot-service";
import type { AppConfig } from "../../../src/config/types";
import { sanitizePublicConversationPrompt } from "../../../src/control/public-control";
import { ConversationDispatcher } from "../../../src/conversations/conversation-dispatcher";
import { ConversationRunService } from "../../../src/conversations/conversation-run-service";
import type {
  ConversationTurnCancelInput,
  ConversationTurnCancelResult,
  ConversationTurnRunInput,
  ConversationTurnRunResult,
  ConversationTurnRunner,
} from "../../../src/conversations/conversation-turn-runner";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { createStrictOwnedSessionRelease } from "../../../src/sessions/owned-session-release";
import type { StateStore } from "../../../src/state/state-store";
import { createEmptyState, type AppState } from "../../../src/state/types";

const NOW = "2026-10-01T12:00:00.000Z";

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

async function createHarness(): Promise<Harness> {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-lead-")), "conversation.sqlite");
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
  let clock = Date.parse(NOW);
  const nowFn = () => {
    clock += 1;
    return new Date(clock);
  };
  const dispatcher = new ConversationDispatcher(store, runtime, new RecordingRunner(), sessions, {
    now: nowFn,
    ownerId: "dispatcher-a",
  });
  const service = new ConversationRunService(store, bots, runtime, dispatcher, sessions, state, stateStore, {
    now: nowFn,
    stateMutex,
    autoKick: false,
    releaseOwnedSession,
  });
  return { store, state, bots, service };
}

/** A Group with two enabled members and the first as lead, plus its default Topic. */
async function createGroup(harness: Harness, options: { lead: boolean }) {
  const lead = await harness.bots.createBot({ name: "Lead", agent: "codex", workspace: "backend" });
  const other = await harness.bots.createBot({ name: "Other", agent: "codex", workspace: "backend" });
  const group = await harness.bots.createGroup({
    title: "Team",
    botIds: [lead.id, other.id],
    ...(options.lead ? { leadBotId: lead.id } : {}),
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

test("plain Group prompt resolves to the lead Bot as exactly one MemberTurn", async () => {
  const harness = await createHarness();
  const { lead, group, topic } = await createGroup(harness, { lead: true });

  const accepted = await harness.service.acceptGroupPrompt(inputFor({ group, topic }, "req-lead-default"));

  expect(accepted.memberTurns.map((turn) => turn.botId)).toEqual([lead.id]);
  expect(harness.store.listMemberTurns(accepted.run.id).map((turn) => turn.botId)).toEqual([lead.id]);
  harness.store.close();
});

test("explicit botId routes to that Bot and never also to the lead", async () => {
  const harness = await createHarness();
  const { lead, other, group, topic } = await createGroup(harness, { lead: true });

  const accepted = await harness.service.acceptGroupPrompt({
    ...inputFor({ group, topic }, "req-explicit-other"),
    target: { botId: other.id },
  });

  expect(accepted.memberTurns.map((turn) => turn.botId)).toEqual([other.id]);
  expect(accepted.memberTurns.some((turn) => turn.botId === lead.id)).toBe(false);
  harness.store.close();
});

test("everyone target still expands to every enabled member", async () => {
  const harness = await createHarness();
  const { lead, other, group, topic } = await createGroup(harness, { lead: true });

  const accepted = await harness.service.acceptGroupPrompt({
    ...inputFor({ group, topic }, "req-everyone"),
    target: { mode: "everyone" },
  });

  expect(accepted.memberTurns.map((turn) => turn.botId)).toEqual([lead.id, other.id]);
  harness.store.close();
});

test("a Group with no lead still refuses a plain prompt with target_required", async () => {
  const harness = await createHarness();
  const { group, topic } = await createGroup(harness, { lead: false });

  await expect(harness.service.acceptGroupPrompt(inputFor({ group, topic }, "req-no-lead")))
    .rejects.toMatchObject({ code: "target_required" });
  expect(harness.store.listRuns(group.id, topic.id)).toHaveLength(0);
  harness.store.close();
});

test("a disabled lead is refused instead of being substituted or skipped", async () => {
  const harness = await createHarness();
  const { lead, group, topic } = await createGroup(harness, { lead: true });
  await harness.bots.updateBot(lead.id, { enabled: false });

  await expect(harness.service.acceptGroupPrompt(inputFor({ group, topic }, "req-disabled-lead")))
    .rejects.toMatchObject({ code: "bot_disabled" });
  // Nothing durable: no Run and no MemberTurn for the refused request, and the
  // enabled sibling was never picked in the lead's place.
  expect(harness.store.getRunByRequestId(group.id, topic.id, "req-disabled-lead")).toBeUndefined();
  expect(harness.store.listRuns(group.id, topic.id)).toHaveLength(0);
  harness.store.close();
});

test("a lead that is no longer a member is refused instead of falling back to a member", async () => {
  const harness = await createHarness();
  const { lead, group, topic } = await createGroup(harness, { lead: true });
  // Storage-level stale lead: the row names a lead the membership no longer
  // holds. BotService refuses to create this, so reproduce it directly.
  harness.state.conversations[group.id]!.botIds = [group.botIds[1]!];

  await expect(harness.service.acceptGroupPrompt(inputFor({ group, topic }, "req-stale-lead")))
    .rejects.toMatchObject({ code: "group_member_not_member" });
  expect(harness.store.listRuns(group.id, topic.id)).toHaveLength(0);
  expect(harness.state.conversations[group.id]!.leadBotId).toBe(lead.id);
  harness.store.close();
});

test("Control passes an absent target through and still rejects a mixed target", () => {
  const absent = sanitizePublicConversationPrompt({
    conversationId: "conversation_x",
    topicId: "topic_x",
    requestId: "req-sanitize",
    text: "hello",
  });
  expect(absent.target).toBeUndefined();
  expect(() => sanitizePublicConversationPrompt({
    conversationId: "conversation_x",
    topicId: "topic_x",
    requestId: "req-sanitize-mixed",
    text: "hello",
    target: { botId: "bot_x", mode: "automatic" } as never,
  })).toThrow(expect.objectContaining({ code: "invalid-target" }));
});
