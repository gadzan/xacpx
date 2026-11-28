import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import type { AppConfig } from "../../../src/config/types";
import { ControlService, conversationKernel } from "../../../src/control/control-service";
import { createControlEventBus } from "../../../src/control/control-event-bus";
import {
  createConversationRuntime,
  createProductionOwnedSessionRelease,
} from "../../../src/conversations/conversation-composition";
import {
  createDirectConversationId,
  createDirectTopicId,
} from "../../../src/domain/ids";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { createEmptyState, type AppState, type LogicalSession } from "../../../src/state/types";
import type { Agent } from "../../../src/weixin/agent/interface";
import { registerKnownChannelId } from "../../../src/channels/channel-scope";

// Mirror the daemon, where the relay plugin registers its channel id on load.
registerKnownChannelId("relay");

class MemoryStateStore {
  public saved: AppState[] = [];
  async save(state: AppState): Promise<void> {
    this.saved.push(structuredClone(state));
  }
  async saveNow(state: AppState): Promise<void> {
    this.saved.push(structuredClone(state));
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

async function compose() {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-completions-"));
  const state = createEmptyState();
  const stateStore = new MemoryStateStore();
  const config = createConfig();
  const stateMutex = new AsyncMutex();
  const sessions = new SessionService(config, stateStore, state, { stateMutex });
  const events = createControlEventBus();
  const control = new ControlService({
    agent: { chat: async () => ({ text: "ok" }) } as Agent,
    sessions,
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: {} as never,
    orchestration: {} as never,
    events,
    agents: { resolveCapabilityContext: () => undefined } as never,
    transport: {} as never,
    workspaces: {
      list: () => [{ name: "backend", cwd: "/tmp/backend" }],
      create: async () => ({ name: "backend", cwd: "/tmp/backend" }),
      remove: async () => {},
    },
    uploadStore: { save: async () => ({ id: "u", path: "/tmp/u", filename: "f", mimeType: "text/plain", size: 1 }) },
  } as never);
  const kernel = conversationKernel(control);
  const runtime = await createConversationRuntime({
    config,
    state,
    stateStore,
    sessions,
    control: kernel,
    sqlitePath: join(dir, "conversations.sqlite"),
    releaseOwnedSession: createProductionOwnedSessionRelease({
      sessions,
      transport: { async deleteSession() {}, async releaseLogicalSession() {} },
    }),
    onProductEvent: (event) => kernel.emitConversationProduct(event),
    autoKick: false,
    stateMutex,
  });
  kernel.bindConversationRuntime(runtime);
  return { state, control, runtime };
}

function fakeSession(alias: string, extra?: Partial<LogicalSession>): LogicalSession {
  return {
    alias,
    agent: "codex",
    workspace: "/tmp/work",
    transport_session: `backend:${alias}`,
    logical_session_id: `ls-${alias}`,
    created_at: "2026-08-18T00:00:00.000Z",
    last_used_at: "2026-08-18T00:00:00.000Z",
    ...extra,
  } as unknown as LogicalSession;
}

test("Direct mentions include other enabled bots and visible sessions with targetKind isolation", async () => {
  const current = await compose();
  try {
    const a = await current.control.createBot({ name: "A", agent: "codex", workspace: "backend" });
    const b = await current.control.createBot({ name: "B", agent: "codex", workspace: "backend" });
    await current.control.createBot({ name: "Sleeping", agent: "codex", workspace: "backend", enabled: false });
    current.state.sessions["work"] = fakeSession("work", { display_name: "Work" });
    current.state.sessions["relay:backend-fix"] = fakeSession("relay:backend-fix");
    current.state.sessions["old"] = fakeSession("old", { archived: true });
    current.state.sessions["brt_hidden"] = fakeSession("brt_hidden");

    const scope = {
      conversationId: createDirectConversationId(a.id),
      topicId: createDirectTopicId(a.id),
    };
    // A query answers from the registry without awaiting command discovery.
    const result = await current.control.getConversationCompletions({ ...scope, query: "" });
    expect(result.mentions.status).toBe("ready");
    expect(result.mentions.items).toHaveLength(3);

    const [botItem, sessionItem, relaySessionItem] = result.mentions.items;
    expect(botItem).toMatchObject({
      handle: current.runtime.directMessaging.registry.handle(b.id),
      displayName: "B",
      botId: b.id,
      agent: "codex",
      workspace: "backend",
      targetKind: "bot",
    });
    expect(botItem).not.toHaveProperty("sessionAlias");

    expect(sessionItem).toMatchObject({
      handle: "work",
      displayName: "Work",
      agent: "codex",
      workspace: "/tmp/work",
      targetKind: "session",
      sessionAlias: "work",
    });
    expect(sessionItem).not.toHaveProperty("botId");

    // Relay-scoped sessions surface the display alias; the handle stays internal.
    expect(relaySessionItem).toMatchObject({
      handle: "relay:backend-fix",
      displayName: "backend-fix",
      targetKind: "session",
      sessionAlias: "backend-fix",
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("brt_");
    expect(serialized).not.toContain("brt_hidden");
    expect(serialized).not.toContain("Sleeping");
  } finally {
    await current.runtime.shutdown();
  }
});

test("Group conversation completions stay rejected (member-only path unchanged)", async () => {
  const current = await compose();
  try {
    const a = await current.control.createBot({ name: "A", agent: "codex", workspace: "backend" });
    const b = await current.control.createBot({ name: "B", agent: "codex", workspace: "backend" });
    const group = await current.control.createGroup({ title: "G", botIds: [a.id, b.id] });
    const topic = await current.control.createGroupTopic(group.id, "T", {
      workspace: "backend",
      isolation: "shared",
    });
    await expect(
      current.control.getConversationCompletions({
        conversationId: group.id,
        topicId: topic.id,
      }),
    ).rejects.toMatchObject({ code: "topic_not_found" });
  } finally {
    await current.runtime.shutdown();
  }
});
