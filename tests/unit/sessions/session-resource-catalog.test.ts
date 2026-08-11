import { beforeAll, expect, test } from "bun:test";

import type { AppConfig } from "../../../src/config/types";
import { createEmptyState } from "../../../src/state/types";
import type { AppState, LogicalSession } from "../../../src/state/types";
import type { StateStore } from "../../../src/state/state-store";
import { SessionService } from "../../../src/sessions/session-service";
import {
  CoreSessionResourceCatalog,
  type SessionResourceCatalog,
  type SessionResourceDescriptor,
  type SessionResourceLifecycleEvent,
} from "../../../src/sessions/session-resource-catalog";
import { registerKnownChannelId } from "../../../src/channels/channel-scope";
import type { AppLogger } from "../../../src/logging/app-logger";
import { setLocale } from "../../../src/i18n";

beforeAll(() => {
  setLocale("zh");
  registerKnownChannelId("relay");
});

function createConfig(): AppConfig {
  return {
    transport: { type: "acpx-cli", command: "acpx", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
    logging: { level: "info", maxSizeBytes: 1024, maxFiles: 2, retentionDays: 1 },
    channel: { type: "weixin", replyMode: "stream" },
    channels: [{ id: "weixin", type: "weixin", enabled: true }],
    agents: {
      codex: { driver: "codex" },
    },
    workspaces: {
      backend: { cwd: "/tmp/backend" },
      frontend: { cwd: "/tmp/frontend" },
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

  async saveNow(state: AppState): Promise<void> {
    this.savedStates.push(structuredClone(state));
  }
}

function seedSession(state: AppState, alias: string, overrides: Partial<LogicalSession> = {}): void {
  state.sessions[alias] = {
    alias,
    agent: "codex",
    workspace: "backend",
    transport_session: `backend:${alias}`,
    logical_session_id: `uuid-for-${alias}`,
    created_at: "2026-01-01T00:00:00.000Z",
    last_used_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

interface CapturedLog {
  event: string;
  message: string;
  context?: Record<string, unknown>;
}

function createCapturingLogger(): { logger: AppLogger; errors: CapturedLog[] } {
  const errors: CapturedLog[] = [];
  const logger: AppLogger = {
    debug: async () => {},
    info: async () => {},
    warn: async () => {},
    error: async (event, message, context) => {
      errors.push({ event, message, ...(context ? { context } : {}) });
    },
    cleanup: async () => {},
    flush: async () => {},
  };
  return { logger, errors };
}

function createCatalog(
  config: AppConfig,
  state: AppState,
  logger?: AppLogger,
): { catalog: CoreSessionResourceCatalog; sessions: SessionService } {
  const sessions = new SessionService(config, new MemoryStateStore(), state);
  const catalog = new CoreSessionResourceCatalog({
    sessions,
    config,
    logger: logger ?? createCapturingLogger().logger,
  });
  return { catalog, sessions };
}

// Task 5 only tests subscribe mechanics; the private emit hook is the seam Task 6
// wires to real archive/restore/remove transitions.
function emitForTest(catalog: SessionResourceCatalog, event: SessionResourceLifecycleEvent): void {
  (catalog as unknown as { emit(e: SessionResourceLifecycleEvent): void }).emit(event);
}

test("resolve returns the descriptor with internal/display alias and immutable id", async () => {
  const state = createEmptyState();
  seedSession(state, "relay:demo");
  const { catalog } = createCatalog(createConfig(), state);

  const descriptor = await catalog.resolve("relay:acc-1", "demo");

  expect(descriptor).toEqual({
    logicalSessionId: "uuid-for-relay:demo",
    channelId: "relay",
    internalAlias: "relay:demo",
    displayAlias: "demo",
    workspace: "backend",
    cwd: "/tmp/backend",
    archived: false,
  });
});

test("resolve also accepts the internal alias form", async () => {
  const state = createEmptyState();
  seedSession(state, "relay:demo");
  const { catalog } = createCatalog(createConfig(), state);

  const descriptor = await catalog.resolve("relay:acc-1", "relay:demo");

  expect(descriptor?.internalAlias).toBe("relay:demo");
  expect(descriptor?.displayAlias).toBe("demo");
});

test("resolve rejects aliases belonging to another channel", async () => {
  const state = createEmptyState();
  seedSession(state, "relay:demo");
  seedSession(state, "legacy-weixin");
  const { catalog } = createCatalog(createConfig(), state);

  // A relay caller cannot reach a legacy (unprefixed weixin) session…
  expect(await catalog.resolve("relay:acc-1", "legacy-weixin")).toBeNull();
  // …and a weixin caller cannot reach a relay session, even via the exact
  // internal alias (the legacy weixin fallback must not leak across channels).
  expect(await catalog.resolve("weixin:user-1", "relay:demo")).toBeNull();
});

test("resolve returns null for unknown or empty aliases", async () => {
  const state = createEmptyState();
  seedSession(state, "relay:demo");
  const { catalog } = createCatalog(createConfig(), state);

  expect(await catalog.resolve("relay:acc-1", "nope")).toBeNull();
  expect(await catalog.resolve("relay:acc-1", "   ")).toBeNull();
});

test("cwd is resolved authoritatively from the workspace config", async () => {
  const config = createConfig();
  const state = createEmptyState();
  seedSession(state, "relay:demo");
  const { catalog } = createCatalog(config, state);

  expect((await catalog.resolve("relay:acc-1", "demo"))?.cwd).toBe("/tmp/backend");

  // When the workspace config changes, the descriptor follows the config —
  // there is no caller-supplied cwd anywhere in the interface.
  config.workspaces["backend"]!.cwd = "/tmp/backend-v2";
  expect((await catalog.resolve("relay:acc-1", "demo"))?.cwd).toBe("/tmp/backend-v2");
});

test("sessions whose workspace is no longer registered are unresolvable and unlisted", async () => {
  const state = createEmptyState();
  seedSession(state, "relay:demo");
  seedSession(state, "relay:ghost", { workspace: "gone" });
  const { catalog } = createCatalog(createConfig(), state);

  expect(await catalog.resolve("relay:acc-1", "ghost")).toBeNull();
  const listed = await catalog.list("relay");
  expect(listed.map((item) => item.internalAlias)).toEqual(["relay:demo"]);
});

test("list returns active and archived sessions of the channel", async () => {
  const state = createEmptyState();
  seedSession(state, "relay:active");
  seedSession(state, "relay:sleeping", { archived: true, archived_at: "2026-01-02T00:00:00.000Z" });
  const { catalog } = createCatalog(createConfig(), state);

  const listed = await catalog.list("relay");
  const byAlias = new Map(listed.map((item) => [item.internalAlias, item]));

  expect(byAlias.get("relay:active")?.archived).toBe(false);
  expect(byAlias.get("relay:sleeping")?.archived).toBe(true);
  expect(byAlias.get("relay:sleeping")?.logicalSessionId).toBe("uuid-for-relay:sleeping");
  expect(byAlias.get("relay:sleeping")?.displayAlias).toBe("sleeping");
});

test("list filters sessions by channelId", async () => {
  const state = createEmptyState();
  seedSession(state, "relay:demo");
  seedSession(state, "legacy-weixin");
  const { catalog } = createCatalog(createConfig(), state);

  const relay = await catalog.list("relay");
  expect(relay.map((item) => item.internalAlias)).toEqual(["relay:demo"]);
  expect(relay[0]?.channelId).toBe("relay");

  const weixin = await catalog.list("weixin");
  expect(weixin.map((item) => item.internalAlias)).toEqual(["legacy-weixin"]);
  expect(weixin[0]?.channelId).toBe("weixin");
  expect(weixin[0]?.displayAlias).toBe("legacy-weixin");
});

test("subscribe delivers events to listeners; unsubscribe stops delivery", async () => {
  const state = createEmptyState();
  seedSession(state, "relay:demo");
  const { catalog } = createCatalog(createConfig(), state);

  const received: SessionResourceLifecycleEvent[] = [];
  const unsubscribe = catalog.subscribe((event) => {
    received.push(event);
  });

  const descriptor = (await catalog.resolve("relay:acc-1", "demo"))!;
  const event: SessionResourceLifecycleEvent = { type: "archived", session: descriptor };
  emitForTest(catalog, event);
  expect(received).toEqual([event]);

  unsubscribe();
  emitForTest(catalog, event);
  expect(received).toEqual([event]);
});

test("a throwing listener is logged and does not block other listeners", async () => {
  const state = createEmptyState();
  seedSession(state, "relay:demo");
  const { logger, errors } = createCapturingLogger();
  const { catalog } = createCatalog(createConfig(), state, logger);

  const received: SessionResourceLifecycleEvent[] = [];
  catalog.subscribe(() => {
    throw new Error("listener boom");
  });
  catalog.subscribe((event) => {
    received.push(event);
  });

  const descriptor = (await catalog.resolve("relay:acc-1", "demo"))!;
  const event: SessionResourceLifecycleEvent = { type: "removed", session: descriptor };
  emitForTest(catalog, event);

  // The throwing listener did not prevent delivery to the second listener…
  expect(received).toEqual([event]);
  // …and the failure was reported to the app log.
  expect(errors).toHaveLength(1);
  expect(errors[0]?.event).toBe("sessions.resource_catalog.listener_failed");
  expect(errors[0]?.context?.message).toBe("listener boom");
});

test("descriptor snapshots are not live views of the session record", async () => {
  const config = createConfig();
  const state = createEmptyState();
  seedSession(state, "relay:demo");
  const { catalog, sessions } = createCatalog(config, state);

  const before = (await catalog.resolve("relay:acc-1", "demo"))!;
  expect(before.archived).toBe(false);

  await sessions.setArchived("relay:demo", true);

  // The previously returned descriptor is unchanged; a fresh resolve reflects state.
  expect(before.archived).toBe(false);
  expect((await catalog.resolve("relay:acc-1", "demo"))?.archived).toBe(true);
});
