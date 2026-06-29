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

function createConfig(): AppConfig {
  return {
    transport: { type: "acpx-cli", command: "acpx", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
    logging: { level: "info", maxSizeBytes: 1024, maxFiles: 2, retentionDays: 1 },
    channel: { type: "weixin", replyMode: "stream" },
    channels: [{ id: "weixin", type: "weixin", enabled: true }],
    agents: { codex: { driver: "codex" }, claude: { driver: "claude" } },
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

test("a fresh session has no displayName", async () => {
  const service = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const session = await service.createSession("api-fix", "codex", "backend");
  expect(session.displayName).toBeUndefined();
});

test("setDisplayName sets the display label, leaving alias untouched", async () => {
  const service = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  await service.createSession("api-fix", "codex", "backend");
  await service.setDisplayName("api-fix", "  API hotfix  ");
  const resolved = await service.getSession("api-fix");
  expect(resolved?.alias).toBe("api-fix");
  expect(resolved?.displayName).toBe("API hotfix");
});

test("setDisplayName with an empty value clears the override", async () => {
  const service = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  await service.createSession("api-fix", "codex", "backend");
  await service.setDisplayName("api-fix", "API hotfix");
  await service.setDisplayName("api-fix", "   ");
  const resolved = await service.getSession("api-fix");
  expect(resolved?.displayName).toBeUndefined();
});

test("setDisplayName throws for an unknown session", async () => {
  const service = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  await expect(service.setDisplayName("missing", "x")).rejects.toThrow('session "missing" does not exist');
});
