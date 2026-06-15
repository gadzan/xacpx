import { beforeAll, expect, test } from "bun:test";

import type { AppConfig } from "../../../src/config/types";
import { createEmptyState } from "../../../src/state/types";
import type { AppState } from "../../../src/state/types";
import type { StateStore } from "../../../src/state/state-store";
import { SessionService } from "../../../src/sessions/session-service";
import { setLocale } from "../../../src/i18n";

beforeAll(() => {
  setLocale("zh");
});

function createConfig(agentModel?: string): AppConfig {
  return {
    transport: { type: "acpx-cli", command: "acpx", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
    logging: { level: "info", maxSizeBytes: 1024, maxFiles: 2, retentionDays: 1 },
    channel: { type: "weixin", replyMode: "stream" },
    channels: [{ id: "weixin", type: "weixin", enabled: true }],
    agents: {
      codex: agentModel ? { driver: "codex", model: agentModel } : { driver: "codex" },
      claude: { driver: "claude" },
    },
    workspaces: { backend: { cwd: "/tmp/backend" } },
    orchestration: {
      maxPendingAgentRequestsPerCoordinator: 3,
      allowWorkerChainedRequests: false,
      allowedAgentRequestTargets: [],
      allowedAgentRequestRoles: [],
    },
  };
}

class MemoryStateStore implements Pick<StateStore, "save"> {
  public savedStates: AppState[] = [];
  async save(state: AppState): Promise<void> {
    this.savedStates.push(structuredClone(state));
  }
}

test("a session without a model and an agent without a default resolves to no model", async () => {
  const service = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const session = await service.createSession("api-fix", "codex", "backend");
  expect(session.model).toBeUndefined();
});

test("the agent config model is the default when the session has no override", async () => {
  const service = new SessionService(createConfig("gpt-5.2[high]"), new MemoryStateStore(), createEmptyState());
  await service.createSession("api-fix", "codex", "backend");
  const resolved = await service.getSession("api-fix");
  expect(resolved?.model).toBe("gpt-5.2[high]");
});

test("a session-level model overrides the agent default", async () => {
  const service = new SessionService(createConfig("gpt-5.2[high]"), new MemoryStateStore(), createEmptyState());
  await service.createSession("api-fix", "codex", "backend");
  await service.setSessionModel("api-fix", "gpt-5.2[low]");
  const resolved = await service.getSession("api-fix");
  expect(resolved?.model).toBe("gpt-5.2[low]");
});

test("setSessionModel with an empty value clears the override and falls back to the agent default", async () => {
  const service = new SessionService(createConfig("gpt-5.2[high]"), new MemoryStateStore(), createEmptyState());
  await service.createSession("api-fix", "codex", "backend");
  await service.setSessionModel("api-fix", "gpt-5.2[low]");
  await service.setSessionModel("api-fix", "   ");
  const resolved = await service.getSession("api-fix");
  expect(resolved?.model).toBe("gpt-5.2[high]");
});

test("setCurrentSessionModel sets the model of the chat's current session", async () => {
  const service = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  await service.createSession("api-fix", "codex", "backend");
  await service.useSession("wx:alice", "api-fix");
  await service.setCurrentSessionModel("wx:alice", "claude-opus-4-8");
  const current = await service.getCurrentSession("wx:alice");
  expect(current?.model).toBe("claude-opus-4-8");
});

test("recreating an alias with the same agent carries the model over", async () => {
  const service = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  await service.createSession("api-fix", "codex", "backend");
  await service.setSessionModel("api-fix", "gpt-5.2[high]");
  // Recreate the same alias on the same agent (e.g. /session new again).
  await service.createSession("api-fix", "codex", "backend");
  const resolved = await service.getSession("api-fix");
  expect(resolved?.model).toBe("gpt-5.2[high]");
});
