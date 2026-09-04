import { beforeEach, expect, mock, test } from "bun:test";
import { handleSessionResetCommand } from "../../../../src/commands/handlers/session-reset-handler";
import type { CommandRouterContext, SessionResetOps } from "../../../../src/commands/router-types";
import type { ResolvedSession } from "../../../../src/transport/types";
import { setLocale, t } from "../../../../src/i18n";

beforeEach(() => {
  setLocale("zh");
});

function resolved(overrides: Partial<ResolvedSession> = {}): ResolvedSession {
  return {
    alias: "review",
    agent: "codex",
    workspace: "backend",
    transportSession: "backend:review",
    agentCommand: "codex",
    cwd: "/tmp/backend",
    ...overrides,
  };
}

function build(opts: {
  current: ResolvedSession | null;
  agentSessionId?: string;
  getAgentSessionIdThrows?: boolean;
  removeSessionThrows?: boolean;
  sharingCount?: number;
}) {
  const attachNativeSession = mock(async (_input: unknown) => resolved({
    alias: opts.current?.alias ?? "review",
    agent: opts.current?.agent ?? "codex",
    workspace: opts.current?.workspace ?? "backend",
    transportSession: "backend:review:reset-1700000000001",
    source: "agent-side",
  }));
  const attachSession = mock(async () => resolved({
    alias: opts.current?.alias ?? "review",
    agent: opts.current?.agent ?? "codex",
    workspace: opts.current?.workspace ?? "backend",
    transportSession: "backend:review:reset-1700000000001",
  }));
  const useSession = mock(async () => {});
  const countAliasesSharingTransport = mock(() => opts.sharingCount ?? 0);
  const rollbackSessionRecord = mock(async () => {});
  const updateNativeAgentSessionId = mock(async () => {});
  const getLogicalSessionRecord = mock((alias: string) => {
    if (!opts.current) return null;
    return {
      alias,
      agent: opts.current.agent,
      workspace: opts.current.workspace,
      transport_session: opts.current.transportSession,
      logical_session_id: "prev-id",
      transport_engine: "cli" as const,
      created_at: new Date().toISOString(),
      last_used_at: new Date().toISOString(),
      ...(opts.current.source === "agent-side" ? { source: "agent-side" as const, agent_session_id: opts.current.agentSessionId } : {}),
    };
  });
  const getAgentSessionId = mock(async (_s: ResolvedSession) => {
    if (opts.getAgentSessionIdThrows) throw new Error("show failed");
    return opts.agentSessionId;
  });
  const removeSession = mock(async (_s: ResolvedSession) => {
    if (opts.removeSessionThrows) throw new Error("close failed");
  });
  let aliasReserved = false;
  const tryReserveSessionAliasOperation = mock(() => {
    if (aliasReserved) return null;
    aliasReserved = true;
    return () => {
      aliasReserved = false;
    };
  });

  const context = {
    sessions: {
      getCurrentSession: mock(async () => opts.current),
      getLogicalSessionRecord,
      rollbackSessionRecord,
      updateNativeAgentSessionId,
      buildFreshTransportSession: mock(() => "backend:review:reset-1700000000001"),
      tryReserveSessionAliasOperation,
      attachNativeSession,
      attachSession,
      useSession,
      countAliasesSharingTransport,
    },
    transport: { getAgentSessionId, removeSession },
    logger: { info: mock(async () => {}), error: mock(async () => {}) },
  } as unknown as CommandRouterContext;

  const ops: SessionResetOps = {
    resolveSession: (alias, agent, workspace, transportSession) =>
      resolved({ alias, agent, workspace, transportSession }),
    ensureTransportSession: mock(async () => {}),
    checkTransportSession: mock(async () => true),
    reserveTransportSession: mock(async () => async () => {}),
    refreshSessionTransportAgentCommand: mock(async () => {}),
    now: () => 1_700_000_000_000,
  };

  return { context, ops, attachNativeSession, attachSession, removeSession, getAgentSessionId, countAliasesSharingTransport, rollbackSessionRecord, updateNativeAgentSessionId, useSession };
}

test("native session stays native and closes the previous native session", async () => {
  const previous = resolved({ source: "agent-side", agentSessionId: "old-native", transportSession: "backend:review" });
  const ctx = build({ current: previous, agentSessionId: "fresh-native-id" });

  const reply = await handleSessionResetCommand(ctx.context, ctx.ops, "wx:user");

  expect(ctx.attachNativeSession).toHaveBeenCalledTimes(1);
  expect(ctx.attachNativeSession.mock.calls[0][0]).toMatchObject({
    alias: "review",
    agent: "codex",
    workspace: "backend",
    transportSession: "backend:review:reset-1700000000001",
  });
  expect("agentSessionId" in ctx.attachNativeSession.mock.calls[0][0]).toBe(false);
  expect(ctx.updateNativeAgentSessionId).toHaveBeenCalledWith("review", "fresh-native-id", expect.any(String));
  expect(ctx.attachSession).not.toHaveBeenCalled();
  expect(ctx.removeSession).toHaveBeenCalledTimes(1);
  expect(ctx.removeSession.mock.calls[0][0]).toMatchObject({ transportSession: "backend:review" });
  expect(reply.text).toBe(t().misc.sessionResetSuccess("review"));
});

test("falls back to a xacpx session when the fresh agent id is unavailable", async () => {
  const previous = resolved({ source: "agent-side", agentSessionId: "old-native" });
  const ctx = build({ current: previous, agentSessionId: undefined });

  const reply = await handleSessionResetCommand(ctx.context, ctx.ops, "wx:user");

  expect(ctx.attachNativeSession).toHaveBeenCalledTimes(1);
  expect(ctx.updateNativeAgentSessionId).toHaveBeenCalledWith("review", undefined);
  expect(ctx.attachSession).not.toHaveBeenCalled();
  expect(ctx.removeSession).toHaveBeenCalledTimes(1);
  expect(ctx.removeSession.mock.calls[0][0]).toMatchObject({ transportSession: "backend:review" });
  expect(reply.text).toBe(t().misc.sessionResetSuccess("review"));
});

test("falls back when reading the fresh agent id throws", async () => {
  const previous = resolved({ source: "agent-side", agentSessionId: "old-native" });
  const ctx = build({ current: previous, getAgentSessionIdThrows: true });

  const reply = await handleSessionResetCommand(ctx.context, ctx.ops, "wx:user");

  expect(ctx.attachNativeSession).toHaveBeenCalledTimes(1);
  expect(ctx.updateNativeAgentSessionId).toHaveBeenCalledWith("review", undefined);
  expect(ctx.attachSession).not.toHaveBeenCalled();
  // Even on the fallback path, the old native session is still closed.
  expect(ctx.removeSession).toHaveBeenCalledTimes(1);
  expect(reply.text).toBe(t().misc.sessionResetSuccess("review"));
});

test("a non-native session resets to xacpx and closes the previous transport session", async () => {
  const previous = resolved({ source: "xacpx" });
  const ctx = build({ current: previous, agentSessionId: "fresh-native-id" });

  const reply = await handleSessionResetCommand(ctx.context, ctx.ops, "wx:user");

  expect(ctx.attachSession).toHaveBeenCalledTimes(1);
  expect(ctx.attachNativeSession).not.toHaveBeenCalled();
  expect(ctx.getAgentSessionId).not.toHaveBeenCalled();
  expect(ctx.removeSession).toHaveBeenCalledTimes(1);
  expect(ctx.removeSession.mock.calls[0][0]).toMatchObject({ transportSession: "backend:review" });
  expect(reply.text).toBe(t().misc.sessionResetSuccess("review"));
});

test("reset uses the shared fresh-incarnation allocator instead of the raw clock", async () => {
  const previous = resolved({ source: "xacpx", transportSession: "backend:review:reset-1700000000000" });
  const ctx = build({ current: previous });

  await handleSessionResetCommand(ctx.context, ctx.ops, "wx:user");

  expect(ctx.context.sessions.buildFreshTransportSession).toHaveBeenCalledWith("backend:review");
  expect(ctx.ops.ensureTransportSession).toHaveBeenCalledWith(
    expect.objectContaining({ transportSession: "backend:review:reset-1700000000001" }),
  );
});

test("concurrent resets claim the alias before creating a replacement transport", async () => {
  const previous = resolved({ source: "xacpx" });
  const ctx = build({ current: previous });
  let markEnsureStarted!: () => void;
  const ensureStarted = new Promise<void>((resolve) => {
    markEnsureStarted = resolve;
  });
  let releaseEnsure!: () => void;
  const ensureBlocked = new Promise<void>((resolve) => {
    releaseEnsure = resolve;
  });
  ctx.ops.ensureTransportSession.mockImplementationOnce(async () => {
    markEnsureStarted();
    await ensureBlocked;
  });

  const first = handleSessionResetCommand(ctx.context, ctx.ops, "wx:user");
  await ensureStarted;
  const second = await handleSessionResetCommand(ctx.context, ctx.ops, "wx:user");

  expect(second.text).toBe(t().misc.sessionResetFailed("review"));
  releaseEnsure();
  await first;
  expect(ctx.ops.ensureTransportSession).toHaveBeenCalledTimes(1);
});

test("does not close the previous transport for a non-native session another alias shares", async () => {
  const previous = resolved({ source: "xacpx" });
  const ctx = build({ current: previous, sharingCount: 1 });

  await handleSessionResetCommand(ctx.context, ctx.ops, "wx:user");

  expect(ctx.attachSession).toHaveBeenCalledTimes(1);
  expect(ctx.removeSession).not.toHaveBeenCalled();
});

test("does not close the previous transport when another alias still shares it", async () => {
  const previous = resolved({ source: "agent-side", agentSessionId: "old-native" });
  const ctx = build({ current: previous, agentSessionId: "fresh-native-id", sharingCount: 1 });

  await handleSessionResetCommand(ctx.context, ctx.ops, "wx:user");

  expect(ctx.attachNativeSession).toHaveBeenCalledTimes(1);
  expect(ctx.removeSession).not.toHaveBeenCalled();
});

test("still succeeds when closing the previous session throws", async () => {
  const previous = resolved({ source: "agent-side", agentSessionId: "old-native" });
  const ctx = build({ current: previous, agentSessionId: "fresh-native-id", removeSessionThrows: true });

  const reply = await handleSessionResetCommand(ctx.context, ctx.ops, "wx:user");

  expect(reply.text).toBe(t().misc.sessionResetSuccess("review"));
});

test("returns the no-current-session message when there is no current session", async () => {
  const ctx = build({ current: null });

  const reply = await handleSessionResetCommand(ctx.context, ctx.ops, "wx:user");

  expect(reply.text).toBe(t().misc.sessionResetNoCurrentSession);
  expect(ctx.attachSession).not.toHaveBeenCalled();
  expect(ctx.attachNativeSession).not.toHaveBeenCalled();
});
test("rolls back to previous snapshot when ensureTransportSession fails", async () => {
  const previous = resolved({ source: "xacpx", transportSession: "backend:review" });
  const ctx = build({ current: previous });
  ctx.ops.ensureTransportSession = mock(async () => {
    throw new Error("ensure failed");
  });
  await expect(handleSessionResetCommand(ctx.context, ctx.ops, "wx:user")).rejects.toThrow("ensure failed");

  expect(ctx.attachSession).toHaveBeenCalledTimes(1);
  expect(ctx.rollbackSessionRecord).toHaveBeenCalledTimes(1);
  expect(ctx.rollbackSessionRecord).toHaveBeenCalledWith("review", expect.objectContaining({
    alias: "review",
    logical_session_id: "prev-id",
  }));
  expect(ctx.useSession).not.toHaveBeenCalled();
  // Best-effort cleanup targets ONLY the fresh incarnation, never previous.
  expect(ctx.removeSession).toHaveBeenCalledTimes(1);
  expect(ctx.removeSession.mock.calls[0][0]).toMatchObject({
    transportSession: "backend:review:reset-1700000000001",
  });
});
test("fresh-incarnation cleanup failure never masks the reset rollback", async () => {
  const previous = resolved({ source: "xacpx", transportSession: "backend:review" });
  const ctx = build({ current: previous, removeSessionThrows: true });
  ctx.ops.ensureTransportSession = mock(async () => {
    throw new Error("ensure failed");
  });
  await expect(handleSessionResetCommand(ctx.context, ctx.ops, "wx:user")).rejects.toThrow("ensure failed");
  expect(ctx.rollbackSessionRecord).toHaveBeenCalledTimes(1);
  expect(ctx.removeSession).toHaveBeenCalledTimes(1);
 });
test("rolls back to previous snapshot when checkTransportSession returns false", async () => {
  const previous = resolved({ source: "xacpx", transportSession: "backend:review" });
  const ctx = build({ current: previous });
  ctx.ops.checkTransportSession = mock(async () => false);

  const reply = await handleSessionResetCommand(ctx.context, ctx.ops, "wx:user");

  expect(ctx.attachSession).toHaveBeenCalledTimes(1);
  expect(ctx.useSession).not.toHaveBeenCalled();
  expect(reply.text).toBe(t().misc.sessionResetFailed("review"));
  expect(ctx.removeSession).toHaveBeenCalledTimes(1);
  expect(ctx.removeSession.mock.calls[0][0]).toMatchObject({
    transportSession: "backend:review:reset-1700000000001",
  });
});
