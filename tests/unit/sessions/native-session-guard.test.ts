import { expect, mock, test } from "bun:test";

import { isAcpOutputGuardArgv } from "../../../src/adapters/acp-output-guard";
import { deriveAgentAlias } from "../../../src/config/agent-launch";
import { resolveConfiguredAgentLaunch } from "../../../src/config/resolve-agent-command";
import type { AppConfig } from "../../../src/config/types";
import { ConversationError } from "../../../src/conversations/conversation-error";
import {
  assertNativeSessionAddressable,
  filterAddressableNativeSessions,
  inspectProductOwnedNativeSessions,
  nativeCatalogFromResolved,
  nativeCatalogIdentity,
  nativeCatalogIdentityForLaunch,
  sameNativeCatalog,
  type NativeCatalogIdentity,
} from "../../../src/sessions/native-session-guard";
import { SessionService } from "../../../src/sessions/session-service";
import type { StateStore } from "../../../src/state/state-store";
import { createBotDirectOwner, createEmptyState, type LogicalSession } from "../../../src/state/types";
import type { ResolvedSession } from "../../../src/transport/types";

function record(overrides: Partial<LogicalSession> & Pick<LogicalSession, "alias">): LogicalSession {
  return {
    agent: "codex",
    workspace: "backend",
    transport_session: `backend:${overrides.alias}`,
    logical_session_id: `id-${overrides.alias}`,
    created_at: "2026-09-16T12:00:00.000Z",
    last_used_at: "2026-09-16T12:00:00.000Z",
    ...overrides,
  };
}

const BACKEND = nativeCatalogIdentity({
  cwd: "/tmp/backend",
  selector: { kind: "bare-agent", agent: "codex" },
});

const FRONTEND = nativeCatalogIdentity({
  cwd: "/tmp/frontend",
  selector: { kind: "bare-agent", agent: "claude" },
});

function lookup(opts: {
  records: LogicalSession[];
  catalogs?: Record<string, NativeCatalogIdentity>;
  nativeIds?: Record<string, string | undefined>;
  getAgentSessionId?: (session: ResolvedSession) => Promise<string | undefined>;
  omitGetAgentSessionId?: boolean;
  unresolved?: string[];
}) {
  const unresolved = new Set(opts.unresolved ?? []);
  const getAgentSessionId = opts.omitGetAgentSessionId
    ? undefined
    : mock(opts.getAgentSessionId ?? (async (session: ResolvedSession) => opts.nativeIds?.[session.alias]));
  return {
    sessions: {
      listLogicalSessionRecords: () => opts.records,
      getResolvedSessionByInternalAlias: (alias: string) => {
        if (unresolved.has(alias)) return null;
        const found = opts.records.find((session) => session.alias === alias);
        if (!found) return null;
        const catalog = opts.catalogs?.[alias] ?? BACKEND;
        return {
          alias: found.alias,
          agent: found.agent,
          workspace: found.workspace,
          cwd: catalog.cwd,
          ...resolvedLaunchFromCatalog(catalog),
        } as ResolvedSession;
      },
    },
    transport: {
      ...(getAgentSessionId ? { getAgentSessionId } : {}),
    },
    getAgentSessionId,
  };
}

const OWNER = createBotDirectOwner({
  bindingId: "bind_1",
  botId: "bot_1",
  conversationId: "conversation_1",
  topicId: "topic_1",
});

function createConfig(): AppConfig {
  return {
    transport: { type: "acpx-cli", command: "acpx", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
    logging: {
      level: "info",
      maxSizeBytes: 1024,
      maxFiles: 2,
      retentionDays: 1,
      perf: { enabled: false, maxSizeBytes: 1024, maxFiles: 1, retentionDays: 1 },
    },
    channel: { type: "weixin", replyMode: "stream" },
    channels: [{ id: "weixin", type: "weixin", enabled: true }],
    plugins: [],
    agents: {
      custom: { driver: "custom", argv: ["/opt/agent", "--acp"] },
      claude: { driver: "claude", command: "claude.exe" },
    },
    workspaces: {
      backend: { cwd: "/repo" },
      win: { cwd: "C:\\repo" },
    },
    orchestration: {
      maxPendingAgentRequestsPerCoordinator: 3,
      allowWorkerChainedRequests: false,
      allowedAgentRequestTargets: [],
      allowedAgentRequestRoles: [],
      progressHeartbeatSeconds: 300,
      maxParallelTasksPerAgent: 3,
    },
  };
}

class MemoryStateStore implements Pick<StateStore, "save"> {
  async save(): Promise<void> {}
  async saveNow(): Promise<void> {}
}

function resolvedLaunchFromCatalog(catalog: NativeCatalogIdentity): Partial<ResolvedSession> {
  const selector = catalog.selector;
  if (selector.kind === "argv") {
    return { agentCommand: selector.identity, agentArgv: selector.identity.split(" ") };
  }
  if (selector.kind === "raw-command") {
    return { rawCommand: selector.command, agentCommand: selector.command };
  }
  if (selector.kind === "bare-agent") {
    return { acpxAgent: selector.agent };
  }
  return {};
}

test("sameNativeCatalog is cwd path-equivalence plus physical selector, not labels", () => {
  expect(sameNativeCatalog(BACKEND, nativeCatalogIdentity({
    cwd: "/tmp/./backend",
    selector: { kind: "bare-agent", agent: "codex" },
  }))).toBe(true);
  expect(sameNativeCatalog(BACKEND, nativeCatalogIdentity({
    cwd: "/tmp/backend",
    selector: { kind: "bare-agent", agent: "codex2" },
  }))).toBe(false);
  expect(sameNativeCatalog(BACKEND, FRONTEND)).toBe(false);
});

test("persisted product-owned native IDs are proven without reverse lookup", async () => {
  const ctx = lookup({
    records: [record({ alias: "brt_hidden", owner: OWNER, agent_session_id: "N1" })],
  });
  const inspected = await inspectProductOwnedNativeSessions(ctx, BACKEND);
  expect([...inspected.ownedIds]).toEqual(["N1"]);
  expect(inspected.unproven).toBe(false);
  expect(ctx.getAgentSessionId).toBeDefined();
  expect(ctx.getAgentSessionId?.mock.calls.length).toBe(0);

  const listed = await filterAddressableNativeSessions(ctx, BACKEND, [
    { sessionId: "N1" },
    { sessionId: "N2" },
  ]);
  expect(listed.map((session) => session.sessionId)).toEqual(["N2"]);

  await expect(assertNativeSessionAddressable(ctx, BACKEND, "N1"))
    .rejects.toMatchObject({ code: "hidden_session" });
  await expect(assertNativeSessionAddressable(ctx, BACKEND, "N2")).resolves.toBeUndefined();
});

test("missing persisted id reverse-looks up via getAgentSessionId", async () => {
  const ctx = lookup({
    records: [record({ alias: "brt_hidden", owner: OWNER })],
    nativeIds: { brt_hidden: "N1" },
  });
  const inspected = await inspectProductOwnedNativeSessions(ctx, BACKEND);
  expect([...inspected.ownedIds]).toEqual(["N1"]);
  expect(inspected.unproven).toBe(false);
  expect(ctx.getAgentSessionId?.mock.calls.length).toBe(1);

  await expect(assertNativeSessionAddressable(ctx, BACKEND, "N1"))
    .rejects.toBeInstanceOf(ConversationError);
  await expect(assertNativeSessionAddressable(ctx, BACKEND, "N2")).resolves.toBeUndefined();
});

test("unproven product-owned candidate fail-closes attach instead of guessing", async () => {
  const ctx = lookup({
    records: [record({ alias: "brt_hidden", owner: OWNER })],
    omitGetAgentSessionId: true,
  });
  const inspected = await inspectProductOwnedNativeSessions(ctx, BACKEND);
  expect(inspected.ownedIds.size).toBe(0);
  expect(inspected.unproven).toBe(true);
  await expect(assertNativeSessionAddressable(ctx, BACKEND, "N2"))
    .rejects.toMatchObject({ code: "hidden_session" });
  const listed = await filterAddressableNativeSessions(ctx, BACKEND, [{ sessionId: "N2" }]);
  expect(listed.map((session) => session.sessionId)).toEqual(["N2"]);
});

test("getAgentSessionId failure is unproven, not a free pass", async () => {
  const ctx = lookup({
    records: [record({ alias: "brt_hidden", owner: OWNER })],
    getAgentSessionId: async () => {
      throw new Error("show failed");
    },
  });
  await expect(assertNativeSessionAddressable(ctx, BACKEND, "N2"))
    .rejects.toMatchObject({ code: "hidden_session" });
});

test("unresolvable product-owned session fail-closes rather than assuming a different catalog", async () => {
  const ctx = lookup({
    records: [record({ alias: "brt_hidden", owner: OWNER, agent_session_id: "N1" })],
    unresolved: ["brt_hidden"],
  });
  const inspected = await inspectProductOwnedNativeSessions(ctx, BACKEND);
  expect(inspected.ownedIds.size).toBe(0);
  expect(inspected.unproven).toBe(true);
  await expect(assertNativeSessionAddressable(ctx, BACKEND, "N2"))
    .rejects.toMatchObject({ code: "hidden_session" });
});

test("ordinary sessions and other native catalogs do not occupy this catalog", async () => {
  const ctx = lookup({
    records: [
      record({ alias: "plain", agent_session_id: "N1" }),
      record({
        alias: "brt_other",
        agent: "claude",
        workspace: "frontend",
        owner: OWNER,
        agent_session_id: "N1",
      }),
    ],
    catalogs: {
      plain: BACKEND,
      brt_other: FRONTEND,
    },
  });
  const inspected = await inspectProductOwnedNativeSessions(ctx, BACKEND);
  expect(inspected.ownedIds.size).toBe(0);
  expect(inspected.unproven).toBe(false);
  await expect(assertNativeSessionAddressable(ctx, BACKEND, "N1")).resolves.toBeUndefined();
});

test("workspace labels that share cwd occupy the same native catalog", async () => {
  const ctx = lookup({
    records: [record({ alias: "brt_hidden", workspace: "backend", owner: OWNER, agent_session_id: "N1" })],
  });
  const viaAlias = nativeCatalogIdentity({
    cwd: "/tmp/backend",
    selector: { kind: "bare-agent", agent: "codex" },
  });
  const listed = await filterAddressableNativeSessions(ctx, viaAlias, [
    { sessionId: "N1" },
    { sessionId: "N2" },
  ]);
  expect(listed.map((session) => session.sessionId)).toEqual(["N2"]);
  await expect(assertNativeSessionAddressable(ctx, viaAlias, "N1"))
    .rejects.toMatchObject({ code: "hidden_session" });
  await expect(assertNativeSessionAddressable(ctx, viaAlias, "N2")).resolves.toBeUndefined();
});

test("agent aliases that share launch identity occupy the same native catalog", async () => {
  const ctx = lookup({
    records: [record({ alias: "brt_hidden", agent: "codex", owner: OWNER, agent_session_id: "N1" })],
  });
  const otherAlias = nativeCatalogIdentity({
    cwd: "/tmp/backend",
    selector: { kind: "bare-agent", agent: "codex" },
  });
  await expect(assertNativeSessionAddressable(ctx, otherAlias, "N1"))
    .rejects.toMatchObject({ code: "hidden_session" });
  const listed = await filterAddressableNativeSessions(ctx, otherAlias, [{ sessionId: "N1" }, { sessionId: "N2" }]);
  expect(listed.map((session) => session.sessionId)).toEqual(["N2"]);
});

test("a different cwd is a different native catalog even with the same agent label", async () => {
  const ctx = lookup({
    records: [record({ alias: "brt_hidden", owner: OWNER, agent_session_id: "N1" })],
  });
  const otherCwd = nativeCatalogIdentity({
    cwd: "/tmp/other",
    selector: { kind: "bare-agent", agent: "codex" },
  });
  const inspected = await inspectProductOwnedNativeSessions(ctx, otherCwd);
  expect(inspected.ownedIds.size).toBe(0);
  expect(inspected.unproven).toBe(false);
  await expect(assertNativeSessionAddressable(ctx, otherCwd, "N1")).resolves.toBeUndefined();
});

test("canonical native catalogs match guarded SessionService.resolveSession and unguarded configured launch", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  await sessions.createSession("brt_bot", "custom", "backend", { owner: OWNER });
  const created = sessions.getLogicalSessionRecord("brt_bot")!;
  const guarded = sessions.resolveSession(
    created.alias,
    created.agent,
    created.workspace,
    created.transport_session,
  );
  expect(isAcpOutputGuardArgv(guarded.agentArgv ?? [])).toBe(true);
  expect(guarded.agentArgv?.slice(3)).toEqual(["/opt/agent", "--acp"]);

  const unguarded = resolveConfiguredAgentLaunch(config.agents.custom!, config.transport);
  expect(unguarded.agentArgv).toEqual(["/opt/agent", "--acp"]);
  expect(unguarded.agentArgv).not.toEqual(guarded.agentArgv);

  expect(sameNativeCatalog(
    nativeCatalogFromResolved(guarded),
    nativeCatalogIdentityForLaunch({
      cwd: config.workspaces.backend.cwd,
      driver: "custom",
      ...unguarded,
    }),
  )).toBe(true);

  const other = resolveConfiguredAgentLaunch(
    { driver: "custom", argv: ["/opt/other", "--acp"] },
    config.transport,
  );
  expect(sameNativeCatalog(
    nativeCatalogFromResolved(guarded),
    nativeCatalogIdentityForLaunch({
      cwd: config.workspaces.backend.cwd,
      driver: "custom",
      ...other,
    }),
  )).toBe(false);
});

test("windows structured command unwraps ACP output-guard to the same native catalog", async () => {
  const agent = { driver: "claude" as const, command: "claude.exe" };
  const unguarded = resolveConfiguredAgentLaunch(agent, undefined, { platform: "win32" });
  const guardedLaunch = resolveConfiguredAgentLaunch(agent, undefined, {
    platform: "win32",
    guardAcpOutput: true,
  });
  expect(unguarded.agentArgv).toEqual(["claude.exe"]);
  expect(isAcpOutputGuardArgv(guardedLaunch.agentArgv ?? [])).toBe(true);
  expect(guardedLaunch.agentArgv?.slice(3)).toEqual(["claude.exe"]);

  const cwd = "C:\\repo";
  expect(sameNativeCatalog(
    nativeCatalogIdentityForLaunch({ cwd, driver: "claude", ...unguarded }),
    nativeCatalogIdentityForLaunch({ cwd, driver: "claude", ...guardedLaunch }),
  )).toBe(true);

  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState(), { platform: "win32" });
  await sessions.createSession("brt_bot", "claude", "win", { owner: OWNER });
  const created = sessions.getLogicalSessionRecord("brt_bot")!;
  const guardedSession = sessions.resolveSession(
    created.alias,
    created.agent,
    created.workspace,
    created.transport_session,
  );
  expect(isAcpOutputGuardArgv(guardedSession.agentArgv ?? [])).toBe(true);
  expect(sameNativeCatalog(
    nativeCatalogFromResolved(guardedSession),
    nativeCatalogIdentityForLaunch({ cwd, driver: "claude", ...unguarded }),
  )).toBe(true);
});

test("a guarded command string without argv is unproven instead of a different catalog", async () => {
  const records = [record({ alias: "brt_hidden", owner: OWNER, agent_session_id: "N1" })];
  const ctx = {
    sessions: {
      listLogicalSessionRecords: () => records,
      getResolvedSessionByInternalAlias: () => ({
        alias: "brt_hidden",
        agent: "custom",
        workspace: "backend",
        cwd: "/repo",
        driver: "custom",
        agentCommand: `${process.execPath} /opt/xacpx/dist/adapters/acp-output-guard-main.js -- /opt/agent --acp`,
        acpxAgent: "xacpx-managed-custom-deadbeef",
      } as ResolvedSession),
    },
    transport: {},
  };
  const picker = nativeCatalogIdentityForLaunch({
    cwd: "/repo",
    driver: "custom",
    agentArgv: ["/opt/agent", "--acp"],
  });
  const inspected = await inspectProductOwnedNativeSessions(ctx, picker);
  expect(inspected.ownedIds.size).toBe(0);
  expect(inspected.unproven).toBe(true);
  await expect(assertNativeSessionAddressable(ctx, picker, "N2"))
    .rejects.toMatchObject({ code: "hidden_session" });
});

test("same argv and cwd occupy one catalog even when driver labels differ", () => {
  const argv = ["/opt/agent", "--acp"] as const;
  const left = nativeCatalogIdentityForLaunch({
    cwd: "/repo",
    driver: "custom-a",
    agentArgv: argv,
    acpxAgent: deriveAgentAlias("custom-a", argv),
  });
  const right = nativeCatalogIdentityForLaunch({
    cwd: "/repo",
    driver: "custom-b",
    agentArgv: argv,
    acpxAgent: deriveAgentAlias("custom-b", argv),
  });
  expect(deriveAgentAlias("custom-a", argv)).not.toBe(deriveAgentAlias("custom-b", argv));
  expect(left.selector).toEqual({ kind: "argv", identity: "/opt/agent --acp" });
  expect(right.selector).toEqual({ kind: "argv", identity: "/opt/agent --acp" });
  expect(sameNativeCatalog(left, right)).toBe(true);

  const otherArgv = nativeCatalogIdentityForLaunch({
    cwd: "/repo",
    driver: "custom-a",
    agentArgv: ["/opt/other", "--acp"],
  });
  expect(sameNativeCatalog(left, otherArgv)).toBe(false);
});

test("same raw command and cwd occupy one catalog even when driver labels differ", () => {
  const left = nativeCatalogIdentityForLaunch({
    cwd: "/repo",
    driver: "custom-a",
    rawCommand: "/opt/agent --acp",
    agentCommand: "/opt/agent --acp",
    acpxAgent: "custom-a",
  });
  const right = nativeCatalogIdentityForLaunch({
    cwd: "/repo",
    driver: "custom-b",
    rawCommand: "/opt/agent --acp",
    agentCommand: "/opt/agent --acp",
    acpxAgent: "custom-b",
  });
  expect(left.selector).toEqual({ kind: "raw-command", command: "/opt/agent --acp" });
  expect(right.selector).toEqual({ kind: "raw-command", command: "/opt/agent --acp" });
  expect(sameNativeCatalog(left, right)).toBe(true);
});
