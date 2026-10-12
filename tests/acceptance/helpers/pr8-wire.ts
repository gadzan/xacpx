import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppConfig } from "../../../src/config/types";
import { ControlService, conversationKernel } from "../../../src/control/control-service";
import { createControlEventBus } from "../../../src/control/control-event-bus";
import {
  createConversationRuntime,
  createProductionOwnedSessionRelease,
} from "../../../src/conversations/conversation-composition";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
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

export function createPr8Config(workspaceCwd: string): AppConfig {
  return {
    transport: { type: "acpx-cli", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
    logging: { level: "info", maxSizeBytes: 1024, maxFiles: 2, retentionDays: 1, perf: { enabled: false } },
    channel: { type: "weixin", replyMode: "stream" },
    channels: [{ id: "weixin", type: "weixin", enabled: true }],
    plugins: [],
    agents: { codex: { driver: "codex" }, claude: { driver: "claude" } },
    workspaces: { backend: { cwd: workspaceCwd } },
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

export async function wirePr8Acceptance(options?: {
  chat?: (request: ChatRequest) => Promise<{ text: string }>;
}) {
  const home = mkdtempSync(join(tmpdir(), "xacpx-pr8-home-"));
  const workspace = join(home, "workspace");
  mkdirSync(workspace, { recursive: true });
  const sqlitePath = join(home, "conversations.sqlite");
  const state = createEmptyState();
  const stateStore = new MemoryStateStore();
  const config = createPr8Config(workspace);
  const stateMutex = new AsyncMutex();
  const sessions = new SessionService(config, stateStore, state, {
    now: () => Date.now(),
    stateMutex,
  });
  const physical = {
    async deleteSession() {},
    async releaseLogicalSession() {},
  };
  const events = createControlEventBus();
  const control = new ControlService({
    agent: {
      chat: async (request: ChatRequest) => {
        if (options?.chat) return await options.chat(request);
        return { text: "mock-assistant" };
      },
    },
    sessions,
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: {} as never,
    orchestration: {} as never,
    events,
    workspaces: {
      list: () => [{ name: "backend", cwd: workspace }],
      create: async () => ({ name: "backend", cwd: workspace }),
      remove: async () => {},
    },
    uploadStore: { save: async () => ({ id: "u", path: "/tmp/u", filename: "f", mimeType: "text/plain", size: 1 }) },
    transport: {
      setModel: async () => {},
      getSessionModel: async () => ({ available: ["gpt"] }),
      setSessionEffort: async () => {},
      getSessionEffort: async () => ({ available: ["high"] }),
    },
    removeSessionWithTransport: async (internalAlias: string) => {
      await sessions.removeSession(internalAlias);
      return { wasActive: false };
    },
    archiveSessionWithTransport: async (internalAlias: string) => {
      await sessions.setArchived(internalAlias, true);
    },
    unarchiveSession: async (internalAlias: string) => {
      await sessions.setArchived(internalAlias, false);
    },
  } as never);
  const kernel = conversationKernel(control);
  const runtime = await createConversationRuntime({
    config,
    state,
    stateStore,
    sessions,
    control: kernel,
    sqlitePath,
    releaseOwnedSession: createProductionOwnedSessionRelease({ sessions, transport: physical }),
    onProductEvent: (event) => kernel.emitConversationProduct(event),
    autoKick: true,
    stateMutex,
  });
  kernel.bindConversationRuntime(runtime);
  await runtime.activateAfterConsumerLock();
  return { home, workspace, sqlitePath, control, runtime, events, kernel };
}
