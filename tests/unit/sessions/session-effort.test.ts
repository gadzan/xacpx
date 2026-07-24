import { expect, test } from "bun:test";

import type { AppConfig } from "../../../src/config/types";
import { SessionService } from "../../../src/sessions/session-service";
import type { StateStore } from "../../../src/state/state-store";
import { createEmptyState, type AppState } from "../../../src/state/types";

const config: AppConfig = {
  transport: {
    type: "acpx-cli",
    command: "acpx",
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
  },
  logging: { level: "info", maxSizeBytes: 1024, maxFiles: 2, retentionDays: 1 },
  channel: { type: "weixin", replyMode: "stream" },
  channels: [{ id: "weixin", type: "weixin", enabled: true }],
  agents: {
    codex: { driver: "codex" },
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

class MemoryStateStore implements Pick<StateStore, "save"> {
  savedStates: AppState[] = [];

  async save(state: AppState): Promise<void> {
    this.savedStates.push(structuredClone(state));
  }
}

test("a selected effort persists across SessionService reconstruction", async () => {
  const store = new MemoryStateStore();
  const first = new SessionService(config, store, createEmptyState());
  await first.createSession("api-fix", "codex", "backend");
  await first.setSessionEffort("api-fix", "high");

  const restoredState = structuredClone(store.savedStates.at(-1)!);
  const restored = new SessionService(config, new MemoryStateStore(), restoredState);

  await expect(restored.getSession("api-fix")).resolves.toMatchObject({ effort: "high" });
});

test("session recreation carries effort only when the agent is unchanged", async () => {
  const service = new SessionService(config, new MemoryStateStore(), createEmptyState());
  await service.createSession("api-fix", "codex", "backend");
  await service.setSessionEffort("api-fix", "high");

  await service.createSession("api-fix", "codex", "backend");
  await expect(service.getSession("api-fix")).resolves.toMatchObject({ effort: "high" });

  await service.createSession("api-fix", "claude", "backend");
  expect((await service.getSession("api-fix"))?.effort).toBeUndefined();
});
