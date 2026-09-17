import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import type {
  ChannelPermissionDecision,
  ChannelPermissionRequest,
  MessageChannelRuntime,
} from "../../../src/channels/types";
import type { AppConfig } from "../../../src/config/types";
import { ControlService, conversationKernel } from "../../../src/control/control-service";
import { createControlEventBus } from "../../../src/control/control-event-bus";
import {
  createConversationRuntime,
  createProductionOwnedSessionRelease,
} from "../../../src/conversations/conversation-composition";
import { createDirectConversationId, createDirectTopicId } from "../../../src/domain/ids";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import {
  PermissionInteractionBroker,
  setGlobalPermissionBroker,
} from "../../../src/permissions/permission-interaction-broker";
import { resolvePermissionTurnRoute } from "../../../src/permissions/permission-turn-route";
import { SessionService } from "../../../src/sessions/session-service";
import { createEmptyState, type AppState } from "../../../src/state/types";
import type { ChatRequest } from "../../../src/weixin/agent/interface";

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
    agents: { codex: { driver: "codex" } },
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

function fakeChannel(
  behavior: (request: ChannelPermissionRequest) => Promise<ChannelPermissionDecision>,
  seen: ChannelPermissionRequest[],
): MessageChannelRuntime {
  return {
    id: "relay",
    isLoggedIn: () => true,
    login: async () => "ok",
    logout: async () => {},
    start: async () => {},
    notifyTaskCompletion: async () => {},
    notifyTaskProgress: async () => {},
    sendCoordinatorMessage: async () => {},
    requestPermission: async (request) => {
      seen.push(request);
      return behavior(request);
    },
  };
}

async function boot(input: {
  sqlitePath: string;
  state: AppState;
  stateStore: MemoryStateStore;
  chat: (request: ChatRequest) => Promise<{ text: string }>;
}) {
  const config = createConfig();
  const stateMutex = new AsyncMutex();
  const sessions = new SessionService(config, input.stateStore, input.state, { stateMutex });
  const control = new ControlService({
    agent: { chat: input.chat },
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
    uploadStore: { save: async () => ({ id: "u", path: "/tmp/u", filename: "f", mimeType: "text/plain", size: 1 }) },
  } as never);
  const kernel = conversationKernel(control);
  const runtime = await createConversationRuntime({
    config,
    state: input.state,
    stateStore: input.stateStore,
    sessions,
    control: kernel,
    sqlitePath: input.sqlitePath,
    releaseOwnedSession: createProductionOwnedSessionRelease({
      sessions,
      transport: { async deleteSession() {}, async releaseLogicalSession() {} },
    }),
    autoKick: false,
    stateMutex,
  });
  kernel.bindConversationRuntime(runtime);
  return { control, runtime, kernel };
}

const HUMAN = {
  chatKey: "relay:acct",
  senderId: "acct",
  accountId: "acct",
  senderName: "Ada",
  isOwner: true as const,
};

test("authenticated human Direct Bot permission routes to the original channel and sender", async () => {
  const seen: ChannelPermissionRequest[] = [];
  const broker = new PermissionInteractionBroker({
    getChannelByChatKey: (chatKey) => {
      if (chatKey !== "relay:acct") return null;
      return fakeChannel(async (request) => ({
        outcome: "allow_once",
        responderId: request.requester.senderId,
      }), seen);
    },
  });
  setGlobalPermissionBroker(broker);
  try {
    const dir = mkdtempSync(join(tmpdir(), "xacpx-perm-"));
    const { control, runtime, kernel } = await boot({
      sqlitePath: join(dir, "conversations.sqlite"),
      state: createEmptyState(),
      stateStore: new MemoryStateStore(),
      chat: async (request) => {
        const route = resolvePermissionTurnRoute({
          isolationChatKey: request.conversationId,
          origin: request.metadata?.origin,
          metadata: request.metadata,
          accountId: request.accountId,
        });
        if (!route) {
          return { text: "no-permission-ui" };
        }
        const interactionId = PermissionInteractionBroker.createInteractionId();
        const dispose = broker.bindTurn({ interactionId, ...route });
        try {
          expect(request.conversationId.startsWith("bot:")).toBe(true);
          expect(request.metadata?.permissionChatKey).toBe("relay:acct");
          expect(request.metadata?.senderId).toBe("acct");
          const decision = await broker.requestPermission({
            requestId: "perm-1",
            toolCallId: "tool-1",
            title: "Run shell",
            kind: "execute",
            policyGeneration: 0,
            workerGeneration: "w1",
            interactionId,
            availableOutcomes: ["allow_once", "reject_once"],
          });
          return { text: `decision:${decision.outcome}` };
        } finally {
          dispose();
        }
      },
    });
    const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
    const accepted = await kernel.promptConversationFromHumanIngress({
      conversationId: createDirectConversationId(bot.id),
      topicId: createDirectTopicId(bot.id),
      requestId: "req-human",
      text: "hello",
    }, HUMAN);
    await runtime.dispatcher.kick();
    expect(control.getRun(accepted.run.id).memberTurns[0]?.origin).toBe("human");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.chatKey).toBe("relay:acct");
    expect(seen[0]?.requester.senderId).toBe("acct");
    await runtime.shutdown();
  } finally {
    setGlobalPermissionBroker(null);
  }
});

test("public Conversation accept without human ingress has no permission UI", async () => {
  const seen: ChannelPermissionRequest[] = [];
  const broker = new PermissionInteractionBroker({
    getChannelByChatKey: () => fakeChannel(async (request) => ({
      outcome: "allow_once",
      responderId: request.requester.senderId,
    }), seen),
  });
  setGlobalPermissionBroker(broker);
  try {
    let minted = false;
    const dir = mkdtempSync(join(tmpdir(), "xacpx-perm-"));
    const { control, runtime } = await boot({
      sqlitePath: join(dir, "conversations.sqlite"),
      state: createEmptyState(),
      stateStore: new MemoryStateStore(),
      chat: async (request) => {
        const route = resolvePermissionTurnRoute({
          isolationChatKey: request.conversationId,
          origin: request.metadata?.origin,
          metadata: request.metadata,
          accountId: request.accountId,
        });
        minted = route !== undefined;
        return { text: "done" };
      },
    });
    const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
    const accepted = await control.promptConversation({
      conversationId: createDirectConversationId(bot.id),
      topicId: createDirectTopicId(bot.id),
      requestId: "req-auto",
      text: "hello",
      ...({ humanIngress: HUMAN } as object),
    });
    await runtime.dispatcher.kick();
    expect(control.getRun(accepted.run.id).memberTurns[0]?.origin).toBe("recovery");
    expect(minted).toBe(false);
    expect(seen).toHaveLength(0);
    await runtime.shutdown();
  } finally {
    setGlobalPermissionBroker(null);
  }
});

test("restart recovery discards saved human ingress and cannot mint permission", async () => {
  const seen: ChannelPermissionRequest[] = [];
  const broker = new PermissionInteractionBroker({
    getChannelByChatKey: (chatKey) => {
      if (chatKey !== "relay:acct") return null;
      return fakeChannel(async (request) => ({
        outcome: "allow_once",
        responderId: request.requester.senderId,
      }), seen);
    },
  });
  setGlobalPermissionBroker(broker);
  try {
    const dir = mkdtempSync(join(tmpdir(), "xacpx-perm-"));
    const sqlitePath = join(dir, "conversations.sqlite");
    const stateStore = new MemoryStateStore();
    const first = await boot({
      sqlitePath,
      state: createEmptyState(),
      stateStore,
      chat: async () => ({ text: "should-not-run" }),
    });
    const bot = await first.control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
    const accepted = await first.kernel.promptConversationFromHumanIngress({
      conversationId: createDirectConversationId(bot.id),
      topicId: createDirectTopicId(bot.id),
      requestId: "req-stale",
      text: "hello",
    }, HUMAN);
    expect(first.runtime.store.getDispatchForRun(accepted.run.id)?.humanIngress?.senderId).toBe("acct");
    await first.runtime.shutdown();

    let minted = false;
    const restarted = await boot({
      sqlitePath,
      state: structuredClone(stateStore.saved.at(-1)!),
      stateStore: new MemoryStateStore(),
      chat: async (request) => {
        const route = resolvePermissionTurnRoute({
          isolationChatKey: request.conversationId,
          origin: request.metadata?.origin,
          metadata: request.metadata,
          accountId: request.accountId,
        });
        minted = route !== undefined;
        return { text: "recovered" };
      },
    });
    await restarted.runtime.dispatcher.kick();
    expect(restarted.control.getRun(accepted.run.id).memberTurns[0]?.origin).toBe("recovery");
    expect(minted).toBe(false);
    expect(seen).toHaveLength(0);
    await restarted.runtime.shutdown();
  } finally {
    setGlobalPermissionBroker(null);
  }
});
