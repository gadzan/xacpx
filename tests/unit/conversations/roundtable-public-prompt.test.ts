import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import type { AppConfig } from "../../../src/config/types";
import { ControlService, conversationKernel } from "../../../src/control/control-service";
import { sanitizePublicConversationPrompt } from "../../../src/control/public-control";
import { createControlEventBus } from "../../../src/control/control-event-bus";
import {
  createConversationRuntime,
  createProductionOwnedSessionRelease,
} from "../../../src/conversations/conversation-composition";
import { createDirectConversationId, createDirectTopicId } from "../../../src/domain/ids";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { createEmptyState } from "../../../src/state/types";

const NOW = "2026-11-06T00:00:00.000Z";

function config(): AppConfig {
  return {
    transport: { type: "acpx-cli", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
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

async function wire() {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-roundtable-public-"));
  const state = createEmptyState();
  const stateStore = { async save() {}, async saveNow() {} };
  const cfg = config();
  const stateMutex = new AsyncMutex();
  const sessions = new SessionService(cfg, stateStore, state, { now: () => Date.parse(NOW), stateMutex });
  const physical = { async deleteSession() {}, async releaseLogicalSession() {} };
  const control = new ControlService({
    agents: { resolveCapabilityContext: () => undefined },
    agent: { chat: async () => ({ text: "reply" }) },
    sessions,
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: {} as never,
    orchestration: {} as never,
    events: createControlEventBus(),
    workspaces: {
      list: () => [{ name: "backend", cwd: "/tmp/backend" }],
      create: async () => ({ name: "backend", cwd: "/tmp/backend" }),
      remove: async () => {},
    },
    uploadStore: { root: join(dir, "uploads"), save: async () => ({ id: "u", path: "/tmp/u", filename: "f", mimeType: "text/plain", size: 1 }) },
    transport: {},
    removeSessionWithTransport: async () => ({ wasActive: false }),
    archiveSessionWithTransport: async () => {},
    unarchiveSession: async () => {},
  } as never);
  const kernel = conversationKernel(control);
  const runtime = await createConversationRuntime({
    config: cfg,
    state,
    stateStore,
    sessions,
    control: kernel,
    sqlitePath: join(dir, "conversations.sqlite"),
    releaseOwnedSession: createProductionOwnedSessionRelease({ sessions, transport: physical }),
    onProductEvent: (event) => kernel.emitConversationProduct(event),
    autoKick: false,
    stateMutex,
    now: () => new Date(NOW),
  });
  kernel.bindConversationRuntime(runtime);
  return { control, kernel, runtime };
}

async function group(control: ControlService) {
  const lead = await control.createBot({ name: "Lead", agent: "codex", workspace: "backend" });
  const other = await control.createBot({ name: "Other", agent: "codex", workspace: "backend" });
  const created = await control.createGroup({ title: "Roundtable", botIds: [lead.id, other.id] });
  const topic = await control.createGroupTopic(created.id, "Topic", { workspace: "backend", isolation: "shared" });
  return { lead, other, group: created, topic };
}

test("the public sanitizer accepts and bounds a roundtable target", () => {
  const sanitized = sanitizePublicConversationPrompt({
    conversationId: "c", topicId: "t", requestId: "r", text: "discuss",
    target: { mode: "roundtable", botIds: ["a", "b"], rounds: 2 },
  });
  expect(sanitized.target).toEqual({ mode: "roundtable", botIds: ["a", "b"], rounds: 2 });

  for (const target of [
    { mode: "roundtable", botIds: ["a"], rounds: 1 },
    { mode: "roundtable", botIds: ["a", "a"], rounds: 1 },
    { mode: "roundtable", botIds: ["a", "b"], rounds: 4 },
    { mode: "roundtable", botIds: ["a", "b"], rounds: 0 },
    { mode: "roundtable", botIds: ["a", "b"], rounds: 1.5 },
    { mode: "roundtable", botIds: Array.from({ length: 13 }, (_, index) => `b${index}`), rounds: 2 },
    { mode: "members", botIds: ["a", "b"], rounds: 1 },
  ]) {
    expect(() => sanitizePublicConversationPrompt({
      conversationId: "c", topicId: "t", requestId: "r", text: "discuss", target: target as never,
    })).toThrow(expect.objectContaining({ code: "invalid-target" }));
  }
});

test("the public Control prompt path accepts a Group roundtable and plans every turn", async () => {
  const { control, runtime } = await wire();
  try {
    const { lead, other, group: created, topic } = await group(control);
    const accepted = await control.promptConversation({
      conversationId: created.id, topicId: topic.id, requestId: "rt-public", text: "discuss",
      target: { mode: "roundtable", botIds: [lead.id, other.id], rounds: 2 },
    });
    expect(accepted.run).toMatchObject({ shape: "roundtable", rounds: 2, maxMemberTurns: 4 });
    expect(accepted.memberTurns?.map((turn) => [turn.memberIndex, turn.roundIndex, turn.speakerIndex]))
      .toEqual([[0, 1, 0], [1, 1, 1], [2, 2, 0], [3, 2, 1]]);
  } finally {
    await runtime.shutdown();
  }
});

test("the policy ingress accepts the same roundtable target", async () => {
  const { control, kernel, runtime } = await wire();
  try {
    const { lead, other, group: created, topic } = await group(control);
    const accepted = await kernel.promptConversationWithPolicyFromHumanIngress({
      conversationId: created.id, topicId: topic.id, requestId: "rt-policy", text: "discuss",
      memberPolicies: [
        { botId: lead.id, filesystem: "read-write" },
        { botId: other.id, filesystem: "read-write" },
      ],
      target: { mode: "roundtable", botIds: [lead.id, other.id], rounds: 1 },
    }, { chatKey: "relay:acct", senderId: "owner", accountId: "acct", isOwner: true });
    expect(accepted.run.shape).toBe("roundtable");
    expect(accepted.memberTurns).toHaveLength(2);
  } finally {
    await runtime.shutdown();
  }
});
test("a Direct conversation rejects a roundtable target instead of executing the owner", async () => {
  const { control, runtime } = await wire();
  try {
    const bot = await control.createBot({ name: "Solo", agent: "codex", workspace: "backend" });
    const other = await control.createBot({ name: "Other", agent: "codex", workspace: "backend" });
    await expect(control.promptConversation({
      conversationId: createDirectConversationId(bot.id),
      topicId: createDirectTopicId(bot.id),
      requestId: "rt-direct",
      text: "discuss",
      target: { mode: "roundtable", botIds: [bot.id, other.id] },
    })).rejects.toMatchObject({ code: "conversation_target_mismatch" });
  } finally {
    await runtime.shutdown();
  }
});

test("a disabled roundtable member is refused instead of silently dropped", async () => {
  const { control, runtime } = await wire();
  try {
    const { lead, other, group: created, topic } = await group(control);
    await control.updateBot(other.id, { enabled: false });
    await expect(control.promptConversation({
      conversationId: created.id, topicId: topic.id, requestId: "rt-disabled", text: "discuss",
      target: { mode: "roundtable", botIds: [lead.id, other.id] },
    })).rejects.toMatchObject({ code: "bot_disabled" });
  } finally {
    await runtime.shutdown();
  }
});
