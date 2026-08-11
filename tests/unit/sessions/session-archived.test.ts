import { beforeAll, expect, test } from "bun:test";

import type { AppConfig } from "../../../src/config/types";
import { createEmptyState } from "../../../src/state/types";
import type { AppState } from "../../../src/state/types";
import type { StateStore } from "../../../src/state/state-store";
import { SessionService } from "../../../src/sessions/session-service";
import type { SessionResourceLifecyclePublishInput } from "../../../src/sessions/session-resource-catalog";
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
  public saveNowCalls = 0;

  async save(state: AppState): Promise<void> {
    this.savedStates.push(structuredClone(state));
  }

  async saveNow(state: AppState): Promise<void> {
    this.saveNowCalls += 1;
    this.savedStates.push(structuredClone(state));
  }
}

function seedSession(state: AppState, alias: string, archived = false): void {
  state.sessions[alias] = {
    alias,
    agent: "codex",
    workspace: "backend",
    transport_session: `backend:${alias}`,
    logical_session_id: `uuid-for-${alias}`,
    created_at: "2026-01-01T00:00:00.000Z",
    last_used_at: "2026-01-01T00:00:00.000Z",
    ...(archived ? { archived: true, archived_at: "2026-01-01T00:00:00.000Z" } : {}),
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

function recordLifecycleEvents(service: SessionService): SessionResourceLifecyclePublishInput[] {
  const events: SessionResourceLifecyclePublishInput[] = [];
  service.setSessionResourceLifecyclePublisher((event) => {
    events.push(event);
  });
  return events;
}

test("archive publishes exactly one 'archived' lifecycle event", async () => {
  const state = createEmptyState();
  seedSession(state, "weixin:foo");
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, state, { now: () => 1_700_000_000_000 });
  const events = recordLifecycleEvents(service);

  await service.setArchived("weixin:foo", true);

  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe("archived");
  expect(events[0]?.record.alias).toBe("weixin:foo");
  expect(events[0]?.record.archived).toBe(true);
  expect(events[0]?.record.archived_at).toBe(new Date(1_700_000_000_000).toISOString());
  // The transition is durability-gated: it went through saveNow, not the debounced save.
  expect(store.saveNowCalls).toBe(1);
});

test("restore publishes exactly one 'restored' event and does not reincarnate the transport", async () => {
  registerKnownChannelId("weixin");
  const state = createEmptyState();
  seedSession(state, "weixin:foo");
  const service = new SessionService(createConfig(), new MemoryStateStore(), state);
  const events = recordLifecycleEvents(service);

  await service.setArchived("weixin:foo", true);
  const transportBefore = state.sessions["weixin:foo"]?.transport_session;

  // Explicit unarchive…
  await service.setArchived("weixin:foo", false);
  expect(events.map((event) => event.type)).toEqual(["archived", "restored"]);
  expect(events[1]?.record.archived).toBeUndefined();
  // …and automatic restore-on-use each publish exactly one event per logical
  // operation. Restore never allocates a fresh transport incarnation: the
  // session resumes under its existing transport binding (no terminal revival
  // happens at the core level either — consumers see only `restored`).
  await service.setArchived("weixin:foo", true);
  await service.useSession("weixin:acc:user", "weixin:foo");
  expect(events.map((event) => event.type)).toEqual(["archived", "restored", "archived", "restored"]);
  expect(state.sessions["weixin:foo"]?.transport_session).toBe(transportBefore);
});

test("useSession on an active session publishes no lifecycle event", async () => {
  registerKnownChannelId("weixin");
  const state = createEmptyState();
  seedSession(state, "weixin:foo");
  const service = new SessionService(createConfig(), new MemoryStateStore(), state);
  const events = recordLifecycleEvents(service);

  await service.useSession("weixin:acc:user", "weixin:foo");

  expect(events).toHaveLength(0);
  expect(state.chat_contexts["weixin:acc:user"]?.current_session).toBe("weixin:foo");
});

test("a no-op unarchive persists nothing and publishes nothing", async () => {
  const state = createEmptyState();
  seedSession(state, "weixin:foo");
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, state);
  const events = recordLifecycleEvents(service);

  await service.setArchived("weixin:foo", false);

  expect(events).toHaveLength(0);
  expect(store.saveNowCalls).toBe(0);
  expect(store.savedStates).toHaveLength(0);
});

test("failed saveNow on archive changes nothing: no state, no event", async () => {
  const state = createEmptyState();
  seedSession(state, "weixin:foo");
  const store = {
    save: async (_snapshot: AppState) => {},
    saveNow: async () => {
      throw new Error("disk full");
    },
  };
  const service = new SessionService(createConfig(), store, state);
  const events = recordLifecycleEvents(service);

  await expect(service.setArchived("weixin:foo", true)).rejects.toThrow("disk full");

  expect(state.sessions["weixin:foo"]?.archived).toBeUndefined();
  expect(state.sessions["weixin:foo"]?.archived_at).toBeUndefined();
  expect(events).toHaveLength(0);
});

test("failed saveNow on restore changes nothing: no state, no event", async () => {
  const state = createEmptyState();
  seedSession(state, "weixin:foo", true);
  let failOnce = true;
  const store = {
    save: async (_snapshot: AppState) => {},
    saveNow: async () => {
      if (failOnce) {
        failOnce = false;
        throw new Error("disk full");
      }
    },
  };
  const service = new SessionService(createConfig(), store, state);
  const events = recordLifecycleEvents(service);

  await expect(service.setArchived("weixin:foo", false)).rejects.toThrow("disk full");
  expect(state.sessions["weixin:foo"]?.archived).toBe(true);
  expect(events).toHaveLength(0);

  // Retrying after the disk recovers succeeds and publishes exactly once.
  await service.setArchived("weixin:foo", false);
  expect(state.sessions["weixin:foo"]?.archived).toBeUndefined();
  expect(events.map((event) => event.type)).toEqual(["restored"]);
});
