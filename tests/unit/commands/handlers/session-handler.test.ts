import { expect, test, beforeEach } from "bun:test";
import { handleCancel, handlePrompt, handlePromptWithSession, handleReplyModeShow, handleSessionAttach, handleSessionRemove, handleSessionUse, handleSessions } from "../../../../src/commands/handlers/session-handler";
import { setLocale, t } from "../../../../src/i18n";
import { AcpxQueueOverflowError } from "../../../../src/transport/acpx-queue-overflow";
import { renderTransportError, tryRecoverMissingSession, queueOverflowTipText } from "../../../../src/commands/handlers/session-recovery-handler";
import type { ResolvedSession } from "../../../../src/transport/types";
import type { SessionHandlerContext } from "../../../../src/commands/handlers/session-handler";
import type { SessionRecoveryOps } from "../../../../src/commands/router-types";
import type { AppConfig } from "../../../../src/config/types";

beforeEach(() => {
  setLocale("zh");
});

/**
 * Minimal fake SessionHandlerContext.
 *
 * Uses approach (ii): both resolver methods return null so handlePrompt hits the
 * `if (!session)` guard immediately, before any transport work. This lets us
 * assert the resolver-choice behavior in isolation without stubbing the full
 * transport stack.
 */
function makeContext(calls: string[]) {
  return {
    sessions: {
      getCurrentSession: async (_chatKey: string) => {
        calls.push("getCurrent");
        return null;
      },
      getResolvedSessionByInternalAlias: (alias: string) => {
        calls.push("getByInternal:" + alias);
        return null;
      },
    },
    // All other SessionHandlerContext fields that TypeScript requires but that
    // handlePrompt never touches before the !session early-return guard.
    transport: undefined as any,
    orchestration: undefined as any,
    config: undefined as any,
    configStore: undefined as any,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    replaceConfig: () => {},
    quota: undefined as any,
    lifecycle: undefined as any,
    interaction: undefined as any,
    recovery: undefined as any,
  } as any;
}

test("handlePrompt uses boundSessionAlias resolver when metadata provides it", async () => {
  const calls: string[] = [];
  const result = await handlePrompt(
    makeContext(calls),
    "weixin:a:u",
    "hi",
    undefined, // reply
    undefined, // replyContextToken
    undefined, // accountId
    undefined, // media
    undefined, // abortSignal
    undefined, // onToolEvent
    undefined, // onThought
    undefined, // perfSpan
    { boundSessionAlias: "backend" } as any,
  );

  expect(calls).toContain("getByInternal:backend");
  expect(calls).not.toContain("getCurrent");
  // Both resolvers return null so the guard fires and returns the no-session text.
  expect(result.text).toBeDefined();
});

test("handlePrompt falls back to getCurrentSession when no boundSessionAlias", async () => {
  const calls: string[] = [];
  await handlePrompt(makeContext(calls), "weixin:a:u", "hi");

  expect(calls).toContain("getCurrent");
  expect(calls.filter((c) => c.startsWith("getByInternal:"))).toHaveLength(0);
});

test("handlePrompt falls back to getCurrentSession when metadata has no boundSessionAlias", async () => {
  const calls: string[] = [];
  await handlePrompt(
    makeContext(calls),
    "weixin:a:u",
    "hi",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { channel: "weixin" } as any,
  );

  expect(calls).toContain("getCurrent");
  expect(calls.filter((c) => c.startsWith("getByInternal:"))).toHaveLength(0);
});

function makeArchivedRestoreContext(order: string[], transportExists: boolean) {
  const archivedSession = {
    alias: "relay:agent-claude",
    agent: "claude",
    workspace: "agent",
    transportSession: "agent:relay:agent-claude",
    archived: true,
  } as any;
  return {
    sessions: {
      getCurrentSession: async (_chatKey: string) => archivedSession,
      setArchived: async (alias: string, archived: boolean) => {
        order.push(`setArchived:${alias}:${archived}`);
      },
    },
    orchestration: undefined,
    config: undefined,
    logger: { info: async () => {}, warn: async () => {}, error: async () => {}, debug: async () => {} },
    lifecycle: {
      checkTransportSession: async () => { order.push("check"); return transportExists; },
      ensureTransportSession: async () => { order.push("ensure"); },
    },
    interaction: {
      promptTransportSession: async () => { order.push("prompt"); return { text: "ok" }; },
    },
    recovery: {},
  } as any;
}

test("re-prompting an archived session recreates the torn-down transport before prompting", async () => {
  // Archiving an unshared session closes its acpx session. Restore-on-message must
  // recreate it, else transport.prompt throws "No acpx session found" and the user
  // is wrongly told to re-run /session new (the reported bug).
  const order: string[] = [];
  const res = await handlePrompt(makeArchivedRestoreContext(order, /*transportExists*/ false), "relay:agent-claude:u", "hi");
  expect(res.text).toBe("ok");
  expect(order).toEqual([
    "setArchived:relay:agent-claude:false",
    "check",
    "ensure",
    "prompt",
  ]);
});

test("re-prompting an archived session whose transport survived (shared) does not re-create it", async () => {
  const order: string[] = [];
  const res = await handlePrompt(makeArchivedRestoreContext(order, /*transportExists*/ true), "relay:agent-claude:u", "hi");
  expect(res.text).toBe("ok");
  // checkTransportSession reports it still exists → no ensure, just prompt.
  expect(order).toEqual([
    "setArchived:relay:agent-claude:false",
    "check",
    "prompt",
  ]);
});

test("switching to a session with a stored background result appends it", async () => {
  const context = {
    sessions: {
      resolveFuzzyAlias: () => ({ kind: "match", alias: "backend" }),
      resolveAliasForChat: async (_chatKey: string, displayAlias: string) => displayAlias,
      getLogicalSessionRecord: () => null,
      useSession: async () => ({ alias: "backend", agent: "codex", workspace: "ws" }),
      peekCurrentSessionAlias: () => "backend",
      takeBackgroundResult: async () => ({ text: "build finished", status: "done", finished_at: "x" }),
    },
    activeTurns: { isActive: () => false },
    logger: { info: async () => {} },
  } as any;
  const res = await handleSessionUse(context, "weixin:a:u", "backend");
  expect(res.text).toContain("build finished");
});

test("switching to a still-running session appends a running hint", async () => {
  const context = {
    sessions: {
      resolveFuzzyAlias: () => ({ kind: "match", alias: "backend" }),
      resolveAliasForChat: async (_chatKey: string, displayAlias: string) => displayAlias,
      getLogicalSessionRecord: () => null,
      useSession: async () => ({ alias: "backend", agent: "codex", workspace: "ws" }),
      peekCurrentSessionAlias: () => "backend",
      takeBackgroundResult: async () => null,
    },
    activeTurns: { isActive: () => true },
    logger: { info: async () => {} },
  } as any;
  const res = await handleSessionUse(context, "weixin:a:u", "backend");
  expect(res.text).toContain(t().session.stillRunning("backend"));
});

test("handleCancel without an alias cancels the foreground session", async () => {
  const foreground = { alias: "frontend", transportSession: "ts-frontend" };
  const cancelled: any[] = [];
  const context = {
    sessions: {
      getCurrentSession: async (_chatKey: string) => foreground,
      getLogicalSessionRecord: () => null,
      // Resolver/getSession must NOT be consulted on the bare path.
      resolveFuzzyAlias: () => {
        throw new Error("should not resolve alias for bare /cancel");
      },
      getSession: async () => {
        throw new Error("should not fetch session for bare /cancel");
      },
    },
    interaction: {
      cancelTransportSession: async (session: any) => {
        cancelled.push(session);
        return { cancelled: true, message: "已取消" };
      },
    },
    recovery: {},
  } as any;

  const res = await handleCancel(context, "weixin:a:u");
  expect(cancelled).toEqual([foreground]);
  expect(res.text).toBe("已取消");
});

test("handleCancel with an alias cancels the named (background) session", async () => {
  const foreground = { alias: "frontend", transportSession: "ts-frontend" };
  const backend = { alias: "backend", transportSession: "ts-backend" };
  const cancelled: any[] = [];
  const context = {
    sessions: {
      getCurrentSession: async (_chatKey: string) => foreground,
      resolveFuzzyAlias: (_chatKey: string, fragment: string) => {
        expect(fragment).toBe("backend");
        return { kind: "match", alias: "backend" };
      },
      resolveAliasForChat: async (_chatKey: string, displayAlias: string) =>
        `weixin:${displayAlias}`,
      getSession: async (internalAlias: string) => {
        expect(internalAlias).toBe("weixin:backend");
        return backend;
      },
      getLogicalSessionRecord: () => null,
    },
    interaction: {
      cancelTransportSession: async (session: any) => {
        cancelled.push(session);
        return { cancelled: true, message: "已取消 backend" };
      },
    },
    recovery: {},
  } as any;

  const res = await handleCancel(context, "weixin:a:u", "backend");
  // The named (background) session was cancelled, NOT the foreground one.
  expect(cancelled).toEqual([backend]);
  expect(res.text).toBe("已取消 backend");
});

test("handleCancel with an unknown alias does not cancel anything", async () => {
  const cancelled: any[] = [];
  const context = {
    sessions: {
      getCurrentSession: async () => ({ alias: "frontend", transportSession: "ts-frontend" }),
      resolveFuzzyAlias: () => ({ kind: "none" }),
    },
    interaction: {
      cancelTransportSession: async (session: any) => {
        cancelled.push(session);
        return { cancelled: true, message: "已取消" };
      },
    },
    recovery: {},
  } as any;

  const res = await handleCancel(context, "weixin:a:u", "nope");
  expect(cancelled).toEqual([]);
  expect(res.text).toContain("nope");
});

test("handleCancel returns the same none message as /use and does not cancel when the alias resolves to none", async () => {
  // Mirrors handleSessionUse: resolveFuzzyAlias -> kind "none" short-circuits
  // with the shared "没有匹配...的会话" text before any transport interaction.
  const cancelled: any[] = [];
  const useNoneText = (await handleSessionUse(
    {
      sessions: { resolveFuzzyAlias: () => ({ kind: "none" }) },
    } as any,
    "weixin:a:u",
    "ghost",
  )).text;

  const context = {
    sessions: {
      // getSession/resolveAliasForChat must NOT be consulted on the none path.
      getCurrentSession: async () => {
        throw new Error("should not read foreground session on alias none path");
      },
      resolveFuzzyAlias: (_chatKey: string, fragment: string) => {
        expect(fragment).toBe("ghost");
        return { kind: "none" };
      },
      resolveAliasForChat: async () => {
        throw new Error("should not resolve alias for a none result");
      },
      getSession: async () => {
        throw new Error("should not fetch session for a none result");
      },
    },
    interaction: {
      cancelTransportSession: async (session: any) => {
        cancelled.push(session);
        return { cancelled: true, message: "已取消" };
      },
    },
    recovery: {},
  } as any;

  const res = await handleCancel(context, "weixin:a:u", "ghost");
  // Same user-facing none message as /use, and nothing was cancelled.
  expect(res.text).toBe(useNoneText);
  expect(res.text).toContain(t().session.noMatchingSession("ghost"));
  expect(cancelled).toEqual([]);
});

test("handleCancel returns the ambiguous message and does not cancel when the alias matches multiple sessions", async () => {
  // Mirrors handleSessionUse: resolveFuzzyAlias -> kind "ambiguous" short-circuits
  // with the shared "匹配到多个会话" text plus the candidate list, before any
  // transport interaction.
  const candidates = [
    { alias: "api-a", agent: "codex", workspace: "backend" },
    { alias: "api-b", agent: "codex", workspace: "backend" },
  ];
  const cancelled: any[] = [];
  const context = {
    sessions: {
      getCurrentSession: async () => {
        throw new Error("should not read foreground session on alias ambiguous path");
      },
      resolveFuzzyAlias: (_chatKey: string, fragment: string) => {
        expect(fragment).toBe("api");
        return { kind: "ambiguous", candidates };
      },
      resolveAliasForChat: async () => {
        throw new Error("should not resolve alias for an ambiguous result");
      },
      getSession: async () => {
        throw new Error("should not fetch session for an ambiguous result");
      },
    },
    interaction: {
      cancelTransportSession: async (session: any) => {
        cancelled.push(session);
        return { cancelled: true, message: "已取消" };
      },
    },
    recovery: {},
  } as any;

  const res = await handleCancel(context, "weixin:a:u", "api");
  expect(res.text).toContain(t().session.ambiguousSession("api"));
  // Candidate aliases are surfaced so the user can disambiguate.
  expect(res.text).toContain("api-a");
  expect(res.text).toContain("api-b");
  expect(cancelled).toEqual([]);
});

test("handleSessions marks session with unread background result with ● prefix", async () => {
  const context = {
    sessions: {
      listSessions: async (_chatKey: string) => [
        { alias: "backend", internalAlias: "weixin:backend", agent: "codex", workspace: "proj", isCurrent: false },
        { alias: "frontend", internalAlias: "weixin:frontend", agent: "claude", workspace: "ui", isCurrent: true },
      ],
      listInternalAliases: () => ["weixin:backend", "weixin:frontend"],
      listBackgroundResultAliases: (_chatKey: string) => ["weixin:backend"],
    },
  } as any;
  const res = await handleSessions(context, "weixin:a:u");
  expect(res.text).toContain("● backend");
  expect(res.text).not.toContain("● frontend");
});

test("handleReplyModeShow reports the per-channel default and resolves effective from it", async () => {
  const session = { alias: "weixin:backend", replyMode: undefined } as any;
  const context = {
    sessions: { getCurrentSession: async (_k: string) => session },
    config: {
      channel: { type: "weixin", replyMode: "verbose" },
      channels: [{ id: "weixin", type: "weixin", enabled: true, replyMode: "final" }],
    },
  } as any;

  const result = await handleReplyModeShow(context, "weixin:u");
  const s = t().session;
  expect(result.text).toContain(s.replyModeChannelDefault("final"));
  expect(result.text).toContain(s.replyModeEffective("final"));
  expect(result.text).toContain(s.replyModeGlobalDefault("verbose"));
});

test("handleReplyModeShow shows session override as effective over channel default", async () => {
  const session = { alias: "weixin:backend", replyMode: "stream" } as any;
  const context = {
    sessions: { getCurrentSession: async (_k: string) => session },
    config: {
      channel: { type: "weixin", replyMode: "verbose" },
      channels: [{ id: "weixin", type: "weixin", enabled: true, replyMode: "final" }],
    },
  } as any;

  const result = await handleReplyModeShow(context, "weixin:u");
  const s = t().session;
  expect(result.text).toContain(s.replyModeEffective("stream"));
});

test("handlePromptWithSession downgrades confirmed overflow to soft ready warning and logs warn", async () => {
  const warns: Array<{ event: string; ctx: unknown }> = [];
  const session = {
    alias: "review",
    internalAlias: "review",
    agent: "codex",
    workspace: "backend",
    transportSession: "sess-1",
    archived: false,
    replyMode: undefined,
  } as unknown as ResolvedSession;
  const error = new AcpxQueueOverflowError({
    cancelAttempted: true,
    cancelSucceeded: true,
    ownerTerminationAttempted: true,
    ownerTerminationSucceeded: true,
    diagnostic: "ok",
  });
  const tips: Array<{ chatKey: string; sessionAlias: string; confirmed: boolean; text: string }> = [];
  const context = {
    sessions: { setArchived: async () => {} },
    lifecycle: { checkTransportSession: async () => true, ensureTransportSession: async () => {} },
    interaction: {
      promptTransportSession: async () => { throw error; },
    },
    recovery: { tryRecoverMissingSession: (s: unknown, e: unknown) => tryRecoverMissingSession({} as unknown as SessionRecoveryOps, s as unknown as ResolvedSession, e), renderTransportError },
    onQueueOverflowTip: (info: { chatKey: string; sessionAlias: string; confirmed: boolean; text: string }) => { tips.push(info); },
    config: undefined as unknown as AppConfig,
    logger: {
      info: async () => {},
      warn: async (event: string, _msg: string, ctx: unknown) => { warns.push({ event, ctx }); },
      error: async () => {},
      debug: async () => {},
    },
    quota: undefined,
    orchestration: undefined,
  } as unknown as SessionHandlerContext;
  const result = await handlePromptWithSession(context, session, "weixin:a:u", "hi");
  expect(result.silent).toBe(true);
  expect(result.text).toBeUndefined();
  expect(tips).toEqual([{
    chatKey: "weixin:a:u",
    sessionAlias: "review",
    confirmed: true,
    text: queueOverflowTipText(true),
  }]);
  expect(tips[0]?.text).toBe("部分回复因过长已收束，可直接继续。");
  expect(warns.some((w) => w.event === "transport.queue_overflow_downgraded" && (w.ctx as unknown as { confirmed?: boolean })?.confirmed === true)).toBe(true);
});

test("handlePromptWithSession downgrades unconfirmed overflow to soft unconfirmed warning and logs unconfirmed", async () => {
  const warns: Array<{ event: string; ctx: unknown }> = [];
  const session = {
    alias: "review",
    internalAlias: "review",
    agent: "codex",
    workspace: "backend",
    transportSession: "sess-1",
    archived: false,
    replyMode: undefined,
  } as unknown as ResolvedSession;
  const error = new AcpxQueueOverflowError("cleanup failed");
  const tips: Array<{ confirmed: boolean; text: string }> = [];
  const context = {
    sessions: { setArchived: async () => {} },
    lifecycle: { checkTransportSession: async () => true, ensureTransportSession: async () => {} },
    interaction: {
      promptTransportSession: async () => { throw error; },
    },
    recovery: { tryRecoverMissingSession: (s: unknown, e: unknown) => tryRecoverMissingSession({} as unknown as SessionRecoveryOps, s as unknown as ResolvedSession, e), renderTransportError },
    onQueueOverflowTip: (info: { chatKey: string; sessionAlias: string; confirmed: boolean; text: string }) => { tips.push(info); },
    config: undefined as unknown as AppConfig,
    logger: {
      info: async () => {},
      warn: async (event: string, _msg: string, ctx: unknown) => { warns.push({ event, ctx }); },
      error: async () => {},
      debug: async () => {},
    },
    quota: undefined,
    orchestration: undefined,
  } as unknown as SessionHandlerContext;
  const result = await handlePromptWithSession(context, session, "weixin:a:u", "hi");
  expect(result.silent).toBe(true);
  expect(result.text).toBeUndefined();
  expect(tips).toEqual([{
    chatKey: "weixin:a:u",
    sessionAlias: "review",
    confirmed: false,
    text: queueOverflowTipText(false),
  }]);
  expect(tips[0]?.text).toBe("输出过长且清理未确认，请先发 /cancel 再继续。");
  expect(warns.some((w) => w.event === "transport.queue_overflow_unconfirmed" && (w.ctx as unknown as { confirmed?: boolean })?.confirmed === false)).toBe(true);
});

test("handlePromptWithSession does not downgrade raw buffer overflow without typed error", async () => {
  const session = {
    alias: "review",
    internalAlias: "review",
    agent: "codex",
    workspace: "backend",
    transportSession: "sess-1",
    archived: false,
    replyMode: undefined,
  } as unknown as ResolvedSession;
  const error = new Error("Message buffer exceeded 10485760 bytes");
  const context = {
    sessions: { setArchived: async () => {} },
    lifecycle: { checkTransportSession: async () => true, ensureTransportSession: async () => {} },
    interaction: {
      promptTransportSession: async () => { throw error; },
    },
    recovery: { tryRecoverMissingSession: (s: unknown, e: unknown) => tryRecoverMissingSession({} as unknown as SessionRecoveryOps, s as unknown as ResolvedSession, e), renderTransportError },
    config: undefined as unknown as AppConfig,
    logger: {
      info: async () => {},
      warn: async () => { throw new Error("should not warn for raw buffer"); },
      error: async () => {},
      debug: async () => {},
    },
    quota: undefined,
    orchestration: undefined,
  } as unknown as SessionHandlerContext;
  await expect(handlePromptWithSession(context, session, "weixin:a:u", "hi")).rejects.toThrow(error);
});

test("handlePromptWithSession does not retry overflow with diagnostic containing No acpx session found", async () => {
  const session = {
    alias: "review",
    internalAlias: "review",
    agent: "codex",
    workspace: "backend",
    transportSession: "sess-1",
    archived: false,
    replyMode: undefined,
    agentCommand: "old-command",
  } as unknown as ResolvedSession;
  const error = new AcpxQueueOverflowError({
    cancelAttempted: true,
    cancelSucceeded: false,
    ownerTerminationAttempted: true,
    ownerTerminationSucceeded: true,
    diagnostic: "cancel failed: No acpx session found for backend:api-fix",
  });
  let promptCalls = 0;
  let setAgentCommandCalls = 0;
  const context = {
    sessions: { setArchived: async () => {} },
    lifecycle: { checkTransportSession: async () => true, ensureTransportSession: async () => {} },
    interaction: {
      promptTransportSession: async () => {
        promptCalls += 1;
        throw error;
      },
    },
    recovery: {
      tryRecoverMissingSession: async (s: unknown, e: unknown) => {
        // This would normally recover if guard were missing: simulate different agent command
        const ops: SessionRecoveryOps = {
          resolveSessionAgentCommand: async () => "new-different-command",
          setSessionTransportAgentCommand: async () => { setAgentCommandCalls += 1; },
          getSession: async () => s as ResolvedSession,
        };
        return tryRecoverMissingSession(ops, s as ResolvedSession, e);
      },
      renderTransportError,
    },
    config: undefined as unknown as AppConfig,
    logger: {
      info: async () => {},
      warn: async () => {},
      error: async () => {},
      debug: async () => {},
    },
    quota: undefined,
    orchestration: undefined,
  } as unknown as SessionHandlerContext;
  const result = await handlePromptWithSession(context, session, "weixin:a:u", "hi");
  expect(promptCalls).toBe(1);
  expect(setAgentCommandCalls).toBe(0);
  expect(result.silent).toBe(true);
  expect(result.text).toBeUndefined();
});

test("handleSessionAttach refuses an existing alias without touching its row", async () => {
  const calls: string[] = [];
  const existing = { alias: "wx:a", agent: "codex", workspace: "backend" };
  const context = {
    sessions: {
      tryReserveSessionAliasOperation: (_alias: string) => {
        calls.push("reserve-alias");
        return () => {
          calls.push("release-alias");
        };
      },
      getResolvedSessionByInternalAlias: (alias: string) => {
        calls.push("getByInternal:" + alias);
        return existing;
      },
      attachSession: async () => {
        calls.push("attach");
        throw new Error("must not overwrite");
      },
    },
    lifecycle: {},
    logger: { info: async () => {}, warn: async () => {}, error: async () => {}, debug: async () => {} },
  } as unknown as SessionHandlerContext;
  const result = await handleSessionAttach(context, "weixin:a:u", "a", "codex", "backend", "backend:a");
  expect(result).toEqual({ text: t().session.sessionAlreadyExists("a", "codex", "backend") });
  expect(calls).not.toContain("attach");
});

test("handleSessionAttach drops its fresh row when post-persist setup fails", async () => {
  const calls: string[] = [];
  const context = {
    sessions: {
      tryReserveSessionAliasOperation: (_alias: string) => {
        return () => {};
      },
      getResolvedSessionByInternalAlias: (_alias: string) => null,
      attachSession: async () => {
        calls.push("attach");
        return { alias: "wx:a", agent: "codex", workspace: "backend", transportSession: "backend:a" };
      },
      removeSession: async (alias: string) => {
        calls.push("remove:" + alias);
        return { wasActive: false };
      },
      useSession: async () => {
        throw new Error("chat context store unavailable");
      },
    },
    lifecycle: {
      resolveAttachCandidate: () => ({
        transportSession: "backend:a",
        agentCommand: undefined,
        acpxAgent: undefined,
        agentArgv: undefined,
      }),
      reserveTransportSession: async () => async () => {},
      checkTransportSession: async () => true,
      markSessionReady: () => {},
    },
    logger: { info: async () => {}, warn: async () => {}, error: async () => {}, debug: async () => {} },
  } as unknown as SessionHandlerContext;
  await expect(
    handleSessionAttach(context, "weixin:a:u", "a", "codex", "backend", "backend:a"),
  ).rejects.toThrow("chat context store unavailable");
  expect(calls).toEqual(["attach", "remove:a"]);
});

test("handlePromptWithSession binds BOTH brokers on a Direct Bot turn and carries chatType", async () => {
  // The rebase conflict, pinned at the file where it happened.
  //
  // #361 teaches this seam to route a Direct Bot turn to the elicitation broker,
  // and #360 teaches it to propagate the channel's own `chatType` into the turn
  // context a form renderer gates on. Combining them produced a real conflict, and
  // the two things that must NOT happen are:
  //
  //   1. Drop the bot route  -> no interactionId, so the broker cancels before a
  //      renderer is contacted. The request never reaches a human.
  //   2. Drop `chatType`     -> an ordinary channel turn loses its own report of
  //      being `direct`, and a renderer must refuse a form it cannot prove is
  //      private.
  //
  // Both are asserted against the turn context that actually reaches the brokers,
  // so neither half can be dropped without a red test.
  const { setGlobalElicitationBroker, resetGlobalElicitationBrokerForTests } = await import("../../../../src/interactions/elicitation-interaction-broker.js");
  const { resetGlobalPermissionBrokerForTests, setGlobalPermissionBroker } = await import("../../../../src/permissions/permission-interaction-broker.js");
  resetGlobalPermissionBrokerForTests();
  resetGlobalElicitationBrokerForTests();

  const bound: Array<Record<string, unknown>> = [];
  const fakeBroker = {
    bindTurn: (ctx: Record<string, unknown>) => {
      bound.push(ctx);
      return () => {};
    },
  };
  // Install BOTH brokers the way the daemon does, so the seam's
  // `getGlobalElicitationBroker()` / `getGlobalPermissionBroker()` calls reach
  // real objects rather than null. Installing only one is what let the two
  // routes be collapsed invisibly: there was nothing to compare the addresses.
  setGlobalElicitationBroker(fakeBroker as never);
  setGlobalPermissionBroker(fakeBroker as never);

  const session = {
    alias: "review",
    agent: "codex",
    workspace: "backend",
    transportSession: "sess-1",
    archived: false,
    replyMode: "final" as const,
  } as unknown as ResolvedSession;

  const makeContext = () => ({
    sessions: {},
    lifecycle: { checkTransportSession: async () => true, ensureTransportSession: async () => {} },
    interaction: {
      promptTransportSession: async () => ({ text: "ok" }),
    },
    recovery: {},
    config: undefined as unknown as AppConfig,
    logger: { info: async () => {}, warn: async () => {}, error: async () => {}, debug: async () => {} },
    quota: undefined,
    orchestration: undefined,
  }) as unknown as SessionHandlerContext;

  await handlePromptWithSession(
    makeContext(), session, "bot:conv-1:topic-1", "hi",
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    // A hub-stamped Direct Bot turn: human origin, a trusted ingress address, and
    // the channel's own report that the destination is private.
    {
      channel: "relay",
      senderId: "relay:acct-42",
      origin: "human",
      permissionChatKey: "relay:acct-42",
      chatType: "direct",
    } as never,
  );

  // An interactionId WAS minted for the Direct Bot turn — the M3 fix.
  expect(bound.length).toBeGreaterThan(0);
  const turnContext = bound[0]!;
  expect(typeof turnContext.interactionId).toBe("string");
  expect((turnContext.interactionId as string).length).toBeGreaterThan(0);
  // #360's chatType propagation survived the rebase: the renderer can see that
  // this route is provably private.
  expect(turnContext.chatType).toBe("direct");
  // And the trusted identity is carried, so the broker can re-verify the
  // responder against the exact turn initiator.
  expect(turnContext.senderId).toBe("relay:acct-42");

  // The two brokers receive THEIR OWN addresses, not one collapsed route.
  //
  // This turn has both a `permissionChatKey` ("relay:acct-42") and a Direct Bot
  // product key ("bot:conv-1:topic-1"), so BOTH resolvers return a route. Binding
  // both brokers to whichever resolved first meant the permission broker was
  // registered on the elicitation route, i.e. a human permission request would be
  // delivered on the product isolation key rather than on the trusted ingress
  // address the daemon actually verified.
  //
  // Note the count: both brokers are installed here, so two binds are expected —
  // and they must NOT carry the same chatKey.
  expect(bound.length).toBe(2);
  const routeAddresses = bound.map((ctx) => ctx.chatKey);
  expect(new Set(routeAddresses).size).toBe(routeAddresses.length);
  expect(routeAddresses).toContain("relay:acct-42");
  expect(routeAddresses).toContain("bot:conv-1:topic-1");
  // One identity minted for the turn, shared: answering either kind resolves the
  // SAME turn, which is what keeps the two kinds from double-minting.
  expect(new Set(bound.map((ctx) => ctx.interactionId)).size).toBe(1);

  resetGlobalElicitationBrokerForTests();
  resetGlobalPermissionBrokerForTests();
});

test("both brokers keep their own route in the PRODUCTION shared registry", async () => {
  // The seam above uses a fake `bindTurn()` that just records the context, which
  // is why the round-4 fix passed a test and failed in production.
  //
  // `src/main.ts` wires the two brokers to ONE registry:
  //
  //     elicitationBroker = new ElicitationInteractionBroker({
  //       registry: permissionBroker.turnRegistry,
  //       ...
  //     })
  //
  // and `TurnInteractionRegistry.bindTurn()` throws on a second binding of the
  // same interactionId. So binding both kinds against one id silently lost the
  // SECOND bind (the catch swallowed it) and the registry kept only the
  // permission route. The elicitation broker then resolved `relay:<account>`,
  // `parseDirectConversationChatKey()` found no `bot:<conversation>:<topic>` in
  // it, the Direct Bot `conversation` correlation vanished, and the uncorrelated-
  // form gate scoped the form out of the very topic it belonged to. The whole
  // Direct Bot form path went dark with every check green.
  //
  // This test installs the REAL brokers on a REAL shared registry, exactly as
  // main.ts does, so the registry semantics are exercised rather than assumed.
  const { ElicitationInteractionBroker } = await import("../../../../src/interactions/elicitation-interaction-broker.js");
  const { PermissionInteractionBroker } = await import("../../../../src/permissions/permission-interaction-broker.js");
  const { createTurnInteractionRegistry } = await import("../../../../src/interactions/turn-interaction-registry.js");
  const {
    setGlobalElicitationBroker,
    resetGlobalElicitationBrokerForTests,
  } = await import("../../../../src/interactions/elicitation-interaction-broker.js");
  const {
    setGlobalPermissionBroker,
    resetGlobalPermissionBrokerForTests,
  } = await import("../../../../src/permissions/permission-interaction-broker.js");
  resetGlobalPermissionBrokerForTests();
  resetGlobalElicitationBrokerForTests();

  // The daemon's wiring: one registry, shared by both brokers.
  const registry = createTurnInteractionRegistry();
  const silentLogger = {
    info: async () => {},
    warn: async () => {},
    error: async () => {},
    debug: async () => {},
  };
  const permissionBroker = new PermissionInteractionBroker({
    registry,
    getChannelByChatKey: () => null,
    logger: silentLogger as never,
  });
  const elicitationBroker = new ElicitationInteractionBroker({
    registry,
    getChannelByChatKey: () => null,
    logger: silentLogger as never,
  });
  setGlobalPermissionBroker(permissionBroker);
  setGlobalElicitationBroker(elicitationBroker);

  const session = {
    alias: "review",
    agent: "codex",
    workspace: "backend",
    transportSession: "sess-1",
    archived: false,
    replyMode: "final" as const,
  } as unknown as ResolvedSession;

  let mintedInteractionId: unknown = "unset";
  let capturedDuringPrompt: Record<string, unknown> | undefined;
  const makeContext = () => ({
    sessions: {},
    lifecycle: { checkTransportSession: async () => true, ensureTransportSession: async () => {} },
    interaction: {
      promptTransportSession: async (...args: unknown[]) => {
        // `handlePromptWithSession` passes the turn interactionId as the
        // THIRTEENTH argument (index 12), so the minted id is observable without
        // adding a seam.
        mintedInteractionId = args[12];
        // Captured HERE, while the turn is running, because the handler disposes
        // its bindings when the prompt completes. Asserting on the registry
        // after `await handlePromptWithSession(...)` would observe an empty one
        // and pass with every binding lost.
        capturedDuringPrompt = {
          count: registry.boundTurnCount,
          turnId: mintedInteractionId,
          permission: registry.resolve(mintedInteractionId as string, "permission")?.chatKey,
          elicitation: registry.resolve(mintedInteractionId as string, "elicitation")?.chatKey,
        };
        return { text: "ok" };
      },
    },
    recovery: {},
    config: undefined as unknown as AppConfig,
    logger: { info: async () => {}, warn: async () => {}, error: async () => {}, debug: async () => {} },
    quota: undefined,
    orchestration: undefined,
  }) as unknown as SessionHandlerContext;

  await handlePromptWithSession(
    makeContext(), session, "bot:conv-1:topic-1", "hi",
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    // A Direct Bot turn that ALSO carries the trusted ingress address, so both
    // resolvers return a route — the shape that exposes the collision.
    {
      channel: "relay",
      senderId: "relay:acct-42",
      origin: "human",
      permissionChatKey: "relay:acct-42",
      chatType: "direct",
    } as never,
  );

  // Both kinds survived into the shared registry. This is the assertion that
  // fails if the second bind is ever swallowed again: `boundTurnCount` counts
  // every kind, so a lost elicitation bind leaves one.
  // Both kinds survived into the shared registry. This is the assertion that
  // fails if the second bind is ever swallowed again: `boundTurnCount` counts
  // every kind, so a lost elicitation bind leaves one, and each kind holds its
  // own address rather than a collapsed pick.
  expect(capturedDuringPrompt).toEqual({
    count: 2,
    turnId: mintedInteractionId,
    permission: "relay:acct-42",
    elicitation: "bot:conv-1:topic-1",
  });
  // And the turn's disposal is honest: everything it bound is gone afterwards.
  expect(registry.boundTurnCount).toBe(0);

  resetGlobalElicitationBrokerForTests();
  resetGlobalPermissionBrokerForTests();
});

test("handlePromptWithSession refuses a malformed bot isolation key", async () => {
  // `bot:garbage` parses to nothing, so no elicitation route can be built from
  // it: a prefix-only match could be satisfied by any turn in any topic.
  //
  // The turn carries NO trusted ingress address, which is the only case where the
  // elicitation route would have to come from the `bot:` key itself. Permission
  // refuses that key by policy, and the elicitation resolver refuses a malformed
  // one — so no route exists and no interactionId is minted. Fail closed.
  const { setGlobalElicitationBroker, resetGlobalElicitationBrokerForTests } = await import("../../../../src/interactions/elicitation-interaction-broker.js");
  const { resetGlobalPermissionBrokerForTests } = await import("../../../../src/permissions/permission-interaction-broker.js");
  resetGlobalPermissionBrokerForTests();
  resetGlobalElicitationBrokerForTests();
  setGlobalElicitationBroker({
    bindTurn: () => () => {},
  } as never);

  const session = {
    alias: "review",
    agent: "codex",
    workspace: "backend",
    transportSession: "sess-1",
    archived: false,
    replyMode: "final" as const,
  } as unknown as ResolvedSession;

  let minted: unknown = "unset";
  const context = {
    sessions: {},
    lifecycle: { checkTransportSession: async () => true, ensureTransportSession: async () => {} },
    interaction: {
      promptTransportSession: async (...args: unknown[]) => {
        minted = args[12];
        return { text: "ok" };
      },
    },
    recovery: {},
    config: undefined as unknown as AppConfig,
    logger: { info: async () => {}, warn: async () => {}, error: async () => {}, debug: async () => {} },
    quota: undefined,
    orchestration: undefined,
  } as unknown as SessionHandlerContext;

  await handlePromptWithSession(
    context, session, "bot:garbage", "hi",
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { channel: "relay", senderId: "relay:acct-42", origin: "human" } as never,
  );
  // No route from a malformed key, hence no interactionId. Fail closed.
  expect(minted).toBeUndefined();

  resetGlobalElicitationBrokerForTests();
});

test("handlePromptWithSession mints an interaction id only for explicit human origin", async () => {
  const { resetGlobalPermissionBrokerForTests } = await import("../../../../src/permissions/permission-interaction-broker.js");
  resetGlobalPermissionBrokerForTests();
  const session = {
    alias: "review",
    agent: "codex",
    workspace: "backend",
    transportSession: "sess-1",
    archived: false,
    replyMode: "final" as const,
  } as unknown as ResolvedSession;
  const makeMintContext = (seen: unknown[]) => ({
    sessions: {},
    lifecycle: { checkTransportSession: async () => true, ensureTransportSession: async () => {} },
    interaction: {
      promptTransportSession: async (...args: unknown[]) => {
        seen.push(args[12]);
        return { text: "ok" };
      },
    },
    recovery: {},
    config: undefined as unknown as AppConfig,
    logger: { info: async () => {}, warn: async () => {}, error: async () => {}, debug: async () => {} },
    quota: undefined,
    orchestration: undefined,
  }) as unknown as SessionHandlerContext;

  // Explicit non-human provenance (Control scheduled turn) mints nothing.
  const scheduledSeen: unknown[] = [];
  await handlePromptWithSession(
    makeMintContext(scheduledSeen), session, "discord:default:g:c1", "hi",
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { channel: "control", senderId: "scheduler", origin: "scheduled" } as never,
  );
  expect(scheduledSeen).toEqual([undefined]);

  // Legacy peer marker without explicit origin still stays non-interactive.
  const peerSeen: unknown[] = [];
  await handlePromptWithSession(
    makeMintContext(peerSeen), session, "discord:default:g:c1", "hi",
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { channel: "control", senderId: "agent-messaging", preserveCoordinatorRoute: true } as never,
  );
  expect(peerSeen).toEqual([undefined]);

  // Explicit human provenance mints an opaque id.
  const humanSeen: unknown[] = [];
  await handlePromptWithSession(
    makeMintContext(humanSeen), session, "discord:default:g:c1", "hi",
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { channel: "discord", senderId: "user-A", origin: "human" } as never,
  );
  expect(typeof humanSeen[0]).toBe("string");
  expect((humanSeen[0] as string).length).toBeGreaterThan(0);

  // Missing origin fails closed: never guess human, even for chat channels.
  const absentSeen: unknown[] = [];
  await handlePromptWithSession(
    makeMintContext(absentSeen), session, "discord:default:g:c1", "hi",
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { channel: "discord", senderId: "user-A" } as never,
  );
  expect(absentSeen).toEqual([undefined]);
});

function makeHiddenOwnedPromptContext(prompted: string[]) {
  const session = {
    alias: "brt_owned",
    agent: "codex",
    workspace: "backend",
    transportSession: "sess-1",
    archived: false,
    replyMode: "final" as const,
  } as unknown as ResolvedSession;
  const context = {
    sessions: {
      getLogicalSessionRecord: () => ({
        alias: "brt_owned",
        owner: { kind: "bot-direct", bindingId: "bind_x", botId: "bot_x" },
      }),
      getCurrentSession: async () => session,
    },
    lifecycle: { checkTransportSession: async () => true, ensureTransportSession: async () => {} },
    interaction: {
      promptTransportSession: async () => {
        prompted.push("prompted");
        return { text: "assistant-reply" };
      },
    },
    recovery: {},
    config: undefined as unknown as AppConfig,
    logger: { info: async () => {}, warn: async () => {}, error: async () => {}, debug: async () => {} },
  } as unknown as SessionHandlerContext;
  return { session, context };
}

test("handlePromptWithSession still prompts a product-owned session on a Direct Bot isolation key", async () => {
  // Production ConsoleAgent → CommandRouter reaches this seam with a live
  // SessionService (getLogicalSessionRecord sees bot-direct / group-member).
  // The ordinary-session fence must not swallow the turn: that returns
  // sessionHiddenOwned as the assistant reply and the agent never runs.
  const prompted: string[] = [];
  const { session, context } = makeHiddenOwnedPromptContext(prompted);
  const res = await handlePromptWithSession(context, session, "bot:conversation_1:topic_1", "hello");
  expect(prompted).toEqual(["prompted"]);
  expect(res.text).toBe("assistant-reply");
});

test("handlePrompt still prompts a product-owned session on a Direct Bot isolation key", async () => {
  const prompted: string[] = [];
  const { context } = makeHiddenOwnedPromptContext(prompted);
  const res = await handlePrompt(context, "bot:conversation_1:topic_1", "hello");
  expect(prompted).toEqual(["prompted"]);
  expect(res.text).toBe("assistant-reply");
});

test("handlePromptWithSession still refuses a product-owned session on an ordinary chat key", async () => {
  const prompted: string[] = [];
  const { session, context } = makeHiddenOwnedPromptContext(prompted);
  const res = await handlePromptWithSession(context, session, "weixin:a:u", "hello");
  expect(prompted).toEqual([]);
  expect(res.text).toBe(t().session.sessionHiddenOwned("brt_owned"));
});

test("handlePromptWithSession keeps the hidden-session fence on a malformed bot isolation key", async () => {
  const prompted: string[] = [];
  const { session, context } = makeHiddenOwnedPromptContext(prompted);
  const res = await handlePromptWithSession(context, session, "bot:garbage", "hello");
  expect(prompted).toEqual([]);
  expect(res.text).toBe(t().session.sessionHiddenOwned("brt_owned"));
});

test("handleSessionRemove refuses product-owned sessions without physical teardown", async () => {
  const removed: string[] = [];
  const context = {
    sessions: {
      resolveAliasForChat: async () => "brt_owned",
      getLogicalSessionRecord: () => ({
        alias: "brt_owned",
        owner: { kind: "bot-direct", bindingId: "bind_x", botId: "bot_x" },
      }),
      getSession: async () => ({ alias: "brt_owned", agent: "codex", workspace: "backend" }),
      tryReserveSessionAliasOperation: () => {
        throw new Error("must not claim a hidden session for ordinary remove");
      },
    },
    transport: {
      deleteSession: async () => {
        removed.push("delete");
      },
      releaseLogicalSession: async () => {
        removed.push("release");
      },
    },
  } as any;
  const res = await handleSessionRemove(context, "weixin:a:u", "brt_owned");
  expect(res.text).toBe(t().session.sessionHiddenOwned("brt_owned"));
  expect(removed).toEqual([]);
});
