import { beforeAll, expect, test } from "bun:test";

import type { AppConfig } from "../../../src/config/types";
import { createEmptyState } from "../../../src/state/types";
import type { AppState } from "../../../src/state/types";
import type { StateStore } from "../../../src/state/state-store";
import { SessionService } from "../../../src/sessions/session-service";
import { registerKnownChannelId } from "../../../src/channels/channel-scope";
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
    agents: {
      codex: { driver: "codex" },
      claude: { driver: "claude" },
    },
    workspaces: {
      backend: {
        cwd: "/tmp/backend",
      },
    },
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

function seedSession(state: AppState, alias: string): void {
  state.sessions[alias] = {
    alias,
    agent: "codex",
    workspace: "backend",
    transport_session: `backend:${alias}`,
    created_at: "2026-01-01T00:00:00.000Z",
    last_used_at: "2026-01-01T00:00:00.000Z",
  };
}

test("setArchived(true) sets archived + archived_at; setArchived(false) clears both", async () => {
  const state = createEmptyState();
  seedSession(state, "weixin:foo");
  const service = new SessionService(createConfig(), new MemoryStateStore(), state, { now: () => 1_700_000_000_000 });

  await service.setArchived("weixin:foo", true);
  expect(state.sessions["weixin:foo"]?.archived).toBe(true);
  expect(typeof state.sessions["weixin:foo"]?.archived_at).toBe("string");

  await service.setArchived("weixin:foo", false);
  expect(state.sessions["weixin:foo"]?.archived).toBeUndefined();
  expect(state.sessions["weixin:foo"]?.archived_at).toBeUndefined();
});

test("useSession restores an archived session (clears archived)", async () => {
  registerKnownChannelId("weixin");
  const state = createEmptyState();
  seedSession(state, "weixin:foo");
  const service = new SessionService(createConfig(), new MemoryStateStore(), state);

  await service.setArchived("weixin:foo", true);
  expect(state.sessions["weixin:foo"]?.archived).toBe(true);

  await service.useSession("weixin:acc:user", "weixin:foo");

  expect(state.sessions["weixin:foo"]?.archived).toBeUndefined();
  expect(state.sessions["weixin:foo"]?.archived_at).toBeUndefined();
});
