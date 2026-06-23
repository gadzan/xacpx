import { expect, test, beforeEach } from "bun:test";
import { handleCancel, handlePrompt, handleReplyModeShow, handleSessionUse, handleSessions } from "../../../../src/commands/handlers/session-handler";
import { setLocale, t } from "../../../../src/i18n";

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
