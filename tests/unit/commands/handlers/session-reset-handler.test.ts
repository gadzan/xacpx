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
  const attachNativeSession = mock(async (_input: unknown) => resolved());
  const attachSession = mock(async () => resolved());
  const useSession = mock(async () => {});
  const countAliasesSharingTransport = mock(() => opts.sharingCount ?? 0);
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

  return { context, ops, attachNativeSession, attachSession, removeSession, getAgentSessionId, countAliasesSharingTransport };
}

test("native session stays native and closes the previous native session", async () => {
  const previous = resolved({ source: "agent-side", agentSessionId: "old-native", transportSession: "backend:review" });
  const ctx = build({ current: previous, agentSessionId: "fresh-native-id" });

  const reply = await handleSessionResetCommand(ctx.context, ctx.ops, "wx:user");

  expect(ctx.attachNativeSession).toHaveBeenCalledTimes(1);
  expect(ctx.attachNativeSession.mock.calls[0][0]).toMatchObject({ agentSessionId: "fresh-native-id" });
  expect(ctx.attachSession).not.toHaveBeenCalled();
  expect(ctx.removeSession).toHaveBeenCalledTimes(1);
  expect(ctx.removeSession.mock.calls[0][0]).toMatchObject({ transportSession: "backend:review" });
  expect(reply.text).toBe(t().misc.sessionResetSuccess("review"));
});

test("falls back to a xacpx session when the fresh agent id is unavailable", async () => {
  const previous = resolved({ source: "agent-side", agentSessionId: "old-native" });
  const ctx = build({ current: previous, agentSessionId: undefined });

  const reply = await handleSessionResetCommand(ctx.context, ctx.ops, "wx:user");

  expect(ctx.attachSession).toHaveBeenCalledTimes(1);
  expect(ctx.attachNativeSession).not.toHaveBeenCalled();
  expect(ctx.removeSession).toHaveBeenCalledTimes(1);
  expect(ctx.removeSession.mock.calls[0][0]).toMatchObject({ transportSession: "backend:review" });
  expect(reply.text).toBe(t().misc.sessionResetSuccess("review"));
});

test("falls back when reading the fresh agent id throws", async () => {
  const previous = resolved({ source: "agent-side", agentSessionId: "old-native" });
  const ctx = build({ current: previous, getAgentSessionIdThrows: true });

  const reply = await handleSessionResetCommand(ctx.context, ctx.ops, "wx:user");

  expect(ctx.attachSession).toHaveBeenCalledTimes(1);
  expect(ctx.attachNativeSession).not.toHaveBeenCalled();
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
