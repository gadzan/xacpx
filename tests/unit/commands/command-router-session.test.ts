import { beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { CommandRouter } from "../../../src/commands/command-router";
import { getChannelIdFromChatKey, registerKnownChannelId } from "../../../src/channels/channel-scope";
import { QuotaManager } from "../../../src/weixin/messaging/quota-manager";
import { setLocale, t } from "../../../src/i18n";
import { wrapAcpOutputGuardArgv } from "../../../src/adapters/acp-output-guard";

beforeAll(() => {
  registerKnownChannelId("feishu");
  registerKnownChannelId("yuanbao");
});

beforeEach(() => {
  setLocale("zh");
});
import { normalizeWorkspacePath } from "../../../src/commands/workspace-path";
import { MissingOptionalDepError, AutoInstallFailedError } from "../../../src/recovery/errors";
import {
  MemoryConfigStore,
  MemoryStateStore,
  SessionService,
  SessionAgentCommandResolver,
  createConfig,
  createEmptyState,
  createTransport,
  getPromptMock,
  getSetModeMock,
} from "./command-router-test-support";

function buildRouter(options?: { nativeSessionListFormat?: (chatKey: string) => "cards" | "table" }) {
  const config = createConfig();
  config.agents.opencode = { driver: "opencode" };
  config.workspaces.weacpx = { cwd: "/tmp/weacpx" };
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  // Mirror the production registry: the built-in weixin channel declares "cards";
  // every other channel defaults to "table". Tests can override per channel.
  const resolveNativeSessionListFormat =
    options?.nativeSessionListFormat ??
    ((chatKey: string): "cards" | "table" => (getChannelIdFromChatKey(chatKey) === "weixin" ? "cards" : "table"));
  const router = new CommandRouter(
    sessions,
    transport,
    config,
    new MemoryConfigStore(config),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    resolveNativeSessionListFormat,
  );
  // Default test-friendly path discovery: just echo the seed (avoid spawning real npm/pnpm/yarn).
  router.__setDiscoverPathsForTest(async (_pkg, seed) => (seed ? [{ path: seed, manager: "npm" as const }] : []));
  return { router, transport, sessions, config };
}

test("creates and selects a new session", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  const reply = await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");

  expect(reply.text).toBe(t().session.sessionCreated("api-fix"));
});

test("stores recovered transport agent command after session creation", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const resolveSessionAgentCommand: SessionAgentCommandResolver = async () => "npx @zed-industries/codex-acp@^0.9.5";
  const router = new CommandRouter(sessions, transport, undefined, undefined, undefined, resolveSessionAgentCommand);

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");
  const session = await sessions.getCurrentSession("wx:user");

  expect(session).toMatchObject({
    alias: "api-fix",
    transportSession: expect.stringMatching(/^backend:api-fix:reset-\d+$/),
    agentCommand: "npx @zed-industries/codex-acp@^0.9.5",
  });
});

test("a plain chat prompt un-archives the resolved session (restore-on-message)", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");
  const internalAlias = sessions.peekCurrentSessionAlias("wx:user")!;
  await sessions.setArchived(internalAlias, true);
  expect(sessions.getResolvedSessionByInternalAlias(internalAlias)?.archived).toBe(true);

  await router.handle("wx:user", "hello there", async () => {});

  expect(sessions.getResolvedSessionByInternalAlias(internalAlias)?.archived).toBe(false);
  // The prompt still ran after the un-archive.
  expect(getPromptMock(transport).mock.calls.length).toBeGreaterThan(0);
});

test("rejects session creation when acpx reports success but the named session is still missing", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  (transport.hasSession as ReturnType<typeof mock>).mockImplementationOnce(async () => false);
  const router = new CommandRouter(sessions, transport);

  const reply = await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");

  expect(reply.text).toContain(t().recovery.sessionCreationFailed);
  expect(reply.text).toContain(t().recovery.sessionCreationError(t().recovery.sessionCreationVerificationDetail));
  expect(reply.text).toContain(t().recovery.sessionCreationAttachHint("api-fix", "codex", "backend"));
  expect(await sessions.listSessions("wx:user")).toEqual([]);
  await expect(sessions.getCurrentSession("wx:user")).resolves.toBeNull();
});

test("createSessionWithTransport resolves, ensures the transport session, and binds the logical session", async () => {
  const { router, transport, sessions, config } = buildRouter();
  config.workspaces.home = { cwd: "/tmp/home" };
  const ensured: string[] = [];
  (transport.ensureSession as ReturnType<typeof mock>).mockImplementation(
    async (s: { transportSession: string }) => {
      ensured.push(s.transportSession);
    },
  );
  (transport.hasSession as ReturnType<typeof mock>).mockImplementation(async () => true);

  const resolved = await router.createSessionWithTransport("relay:demo", "codex", "home");

  expect(resolved.transportSession).toMatch(/^home:relay:demo:reset-\d+$/);
  expect(ensured).toEqual([resolved.transportSession]);
  expect(await sessions.getSession("relay:demo")).toBeTruthy();
});

test("createSessionWithTransport persists the exact structured launch across config changes", async () => {
  const config = createConfig();
  config.agents.custom = { driver: "custom", argv: ["/opt/agent-a", "--acp", ""] };
  config.workspaces.home = { cwd: "/tmp/home" };
  const state = createEmptyState();
  const sessions = new SessionService(config, new MemoryStateStore(), state);
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  await router.createSessionWithTransport("relay:demo", "custom", "home");

  const guardedArgv = wrapAcpOutputGuardArgv(["/opt/agent-a", "--acp", ""]);
  expect(state.sessions["relay:demo"]?.transport_acpx_agent).toMatch(/^xacpx-managed-custom-/);
  expect(state.sessions["relay:demo"]?.transport_agent_argv).toEqual(guardedArgv);

  config.agents.custom = { driver: "custom", argv: ["/opt/agent-b", "--acp"] };
  const reloaded = new SessionService(config, new MemoryStateStore(), state);
  expect((await reloaded.getSession("relay:demo"))?.agentArgv).toEqual(guardedArgv);
});

test("chat session creation persists the exact structured launch across config changes", async () => {
  const config = createConfig();
  config.agents.custom = { driver: "custom", argv: ["/opt/chat-agent-a", "--acp"] };
  const state = createEmptyState();
  const sessions = new SessionService(config, new MemoryStateStore(), state);
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  await router.handle("wx:user", "/session new sticky --agent custom --ws backend");

  const guardedArgv = wrapAcpOutputGuardArgv(["/opt/chat-agent-a", "--acp"]);
  expect(state.sessions.sticky?.transport_acpx_agent).toMatch(/^xacpx-managed-custom-/);
  expect(state.sessions.sticky?.transport_agent_argv).toEqual(guardedArgv);

  config.agents.custom = { driver: "custom", argv: ["/opt/chat-agent-b", "--acp"] };
  const reloaded = new SessionService(config, new MemoryStateStore(), state);
  expect((await reloaded.getSession("sticky"))?.agentArgv).toEqual(guardedArgv);
});

test("chat attach and reset persist the structured launch they actually use", async () => {
  const config = createConfig();
  config.agents.custom = { driver: "custom", argv: ["/opt/attached-agent", "--acp", ""] };
  const state = createEmptyState();
  const sessions = new SessionService(config, new MemoryStateStore(), state);
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  await router.handle(
    "wx:user",
    "/session attach sticky --agent custom --ws backend --name existing-sticky",
  );
  expect(state.sessions.sticky?.transport_acpx_agent).toMatch(/^xacpx-managed-custom-/);
  const guardedArgv = wrapAcpOutputGuardArgv(["/opt/attached-agent", "--acp", ""]);
  expect(state.sessions.sticky?.transport_agent_argv).toEqual(guardedArgv);

  const reset = await router.handle("wx:user", "/session reset");
  expect(reset.text).toBe(t().misc.sessionResetSuccess("sticky"));
  expect(state.sessions.sticky?.transport_acpx_agent).toMatch(/^xacpx-managed-custom-/);
  expect(state.sessions.sticky?.transport_agent_argv).toEqual(guardedArgv);
});

test("createSessionWithTransport applies a model override to the session and persists it", async () => {
  const { router, transport, sessions, config } = buildRouter();
  config.workspaces.home = { cwd: "/tmp/home" };
  const ensuredModels: Array<string | undefined> = [];
  (transport.ensureSession as ReturnType<typeof mock>).mockImplementation(
    async (s: { model?: string }) => {
      // The model must be on the ResolvedSession BEFORE ensure, so acpx creates under it.
      ensuredModels.push(s.model);
    },
  );
  (transport.hasSession as ReturnType<typeof mock>).mockImplementation(async () => true);

  await router.createSessionWithTransport("relay:demo", "codex", "home", "gpt-5.2[high]");

  expect(ensuredModels).toEqual(["gpt-5.2[high]"]);
  const persisted = await sessions.getSession("relay:demo");
  expect(persisted?.model).toBe("gpt-5.2[high]");
});

test("createSessionWithTransport auto-derives a free alias when the desired alias collides", async () => {
  const { router, transport, sessions, config } = buildRouter();
  config.workspaces.home = { cwd: "/tmp/home" };
  await sessions.attachSession("relay:demo", "codex", "home", "home:relay:demo");

  // A colliding alias should NOT fail — the backend derives `relay:demo-2`.
  const result = await router.createSessionWithTransport("relay:demo", "codex", "home");
  expect(result.alias).toBe("relay:demo-2");
  // The new session must be distinct from the original.
  expect(await sessions.getSession("relay:demo-2")).toBeDefined();
  // The original session must be untouched.
  expect(await sessions.getSession("relay:demo")).toMatchObject({ agent: "codex", workspace: "home" });
});

test("concurrent same-alias creates claim the logical alias before transport side effects", async () => {
  const { router, transport, config } = buildRouter();
  config.workspaces.home = { cwd: "/tmp/home" };
  let releaseEnsure!: () => void;
  const ensureBlocked = new Promise<void>((resolve) => {
    releaseEnsure = resolve;
  });
  let ensureStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    ensureStarted = resolve;
  });
  (transport.ensureSession as ReturnType<typeof mock>).mockImplementationOnce(async () => {
    ensureStarted();
    await ensureBlocked;
  });

  const first = router.createSessionWithTransport("relay:demo", "codex", "home");
  await started;
  const second = router.createSessionWithTransport("relay:demo", "codex", "home");

  // With authoritative identity persisted before transport (R1), the second
  // concurrent create sees the first's alias already claimed and derives a
  // free alias (relay:demo-2) instead of racing the transport. Both succeed
  // but with distinct logical identities — no dual-owner for same alias.
  await expect(second).resolves.toBeTruthy();
  const secondSession = await second;
  expect(secondSession.alias).toBe("relay:demo-2");
  releaseEnsure();
  await expect(first).resolves.toBeTruthy();
  expect((transport.ensureSession as ReturnType<typeof mock>).mock.calls).toHaveLength(2);
});

test("deleting then recreating the same alias does not resume residual transport history", async () => {
  const { router, transport, config } = buildRouter();
  config.workspaces.home = { cwd: "/tmp/home" };
  const transportHistory = new Map<string, string[]>();
  let resumedHistory: string[] = [];

  (transport.ensureSession as ReturnType<typeof mock>).mockImplementation(
    async (session: { transportSession: string }) => {
      const existing = transportHistory.get(session.transportSession);
      resumedHistory = existing ? [...existing] : [];
      if (!existing) transportHistory.set(session.transportSession, []);
    },
  );
  (transport.hasSession as ReturnType<typeof mock>).mockImplementation(async () => true);
  // Real transports intentionally treat an unresolvable acpx record as an idempotent
  // delete success. Model that residual-record case: the logical delete succeeds, but
  // the old named transport history remains on disk.
  (transport.deleteSession as ReturnType<typeof mock>).mockImplementation(async () => {});

  const first = await router.createSessionWithTransport("relay:demo", "codex", "home");
  transportHistory.set(first.transportSession, ["old conversation"]);
  await router.archiveSessionWithTransport("relay:demo");
  await router.removeSessionWithTransport("relay:demo");

  const recreated = await router.createSessionWithTransport("relay:demo", "codex", "home");

  expect(recreated.transportSession).not.toBe(first.transportSession);
  expect(resumedHistory).toEqual([]);
});

test("slash-command delete then same-alias new does not resume residual transport history", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);
  const transportHistory = new Map<string, string[]>();
  let resumedHistory: string[] = [];
  (transport.ensureSession as ReturnType<typeof mock>).mockImplementation(
    async (session: { transportSession: string }) => {
      const existing = transportHistory.get(session.transportSession);
      resumedHistory = existing ? [...existing] : [];
      if (!existing) transportHistory.set(session.transportSession, []);
    },
  );

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");
  const first = sessions.getResolvedSessionByInternalAlias("api-fix")!;
  transportHistory.set(first.transportSession, ["old conversation"]);
  await router.handle("wx:user", "/session rm api-fix");
  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");
  const recreated = sessions.getResolvedSessionByInternalAlias("api-fix")!;

  expect(recreated.transportSession).not.toBe(first.transportSession);
  expect(resumedHistory).toEqual([]);
});

test("an attach cannot rebind an alias while reset is replacing its transport", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);
  await router.handle("wx:user", "/session new main --agent codex --ws backend");
  let markResetStarted!: () => void;
  const resetStarted = new Promise<void>((resolve) => {
    markResetStarted = resolve;
  });
  let releaseReset!: () => void;
  const resetBlocked = new Promise<void>((resolve) => {
    releaseReset = resolve;
  });
  (transport.ensureSession as ReturnType<typeof mock>).mockImplementationOnce(async () => {
    markResetStarted();
    await resetBlocked;
  });

  const reset = router.handle("wx:user", "/session reset");
  await resetStarted;
  const attach = await router.handle(
    "wx:user",
    "/session attach main --agent codex --ws backend --name existing-review",
  );
  releaseReset();
  await reset;

  expect(attach.text).not.toContain(t().session.sessionAttached("main"));
  expect((await sessions.getSession("main"))?.transportSession).not.toBe("existing-review");
});

test("a remove cannot delete an alias while reset is replacing its transport", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);
  await router.handle("wx:user", "/session new main --agent codex --ws backend");
  let markResetStarted!: () => void;
  const resetStarted = new Promise<void>((resolve) => {
    markResetStarted = resolve;
  });
  let releaseReset!: () => void;
  const resetBlocked = new Promise<void>((resolve) => {
    releaseReset = resolve;
  });
  (transport.ensureSession as ReturnType<typeof mock>).mockImplementationOnce(async () => {
    markResetStarted();
    await resetBlocked;
  });

  const reset = router.handle("wx:user", "/session reset");
  await resetStarted;
  const remove = await router.handle("wx:user", "/session rm main");
  releaseReset();
  await reset;

  expect(remove.text).not.toContain(t().session.sessionRemoved("main"));
  expect(await sessions.getSession("main")).not.toBeNull();
});

test("/session new auto-derives a free alias when the desired alias already exists", async () => {
  const config = createConfig();
  config.agents.opencode = { driver: "opencode" };
  config.workspaces.frontend = { cwd: "/tmp/frontend" };
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config);

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");

  // A colliding alias should auto-derive `api-fix-2` and succeed.
  const reply = await router.handle("wx:user", "/session new api-fix --agent opencode --ws frontend");

  expect(reply.text).toBe(
    [t().session.sessionAliasCollided("api-fix", "api-fix-2"), t().session.sessionCreated("api-fix-2")].join("\n"),
  );
  // The new session is switched to.
  await expect(sessions.getCurrentSession("wx:user")).resolves.toMatchObject({
    alias: "api-fix-2",
    agent: "opencode",
    workspace: "frontend",
  });
  // The original session is untouched.
  expect(await sessions.getSession("api-fix")).toMatchObject({ agent: "codex", workspace: "backend" });
});

test("/session attach refuses an existing alias instead of orphaning its LID", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  await router.handle("wx:user", "/session new review --agent codex --ws backend");
  const before = await sessions.getSession("review");
  const reply = await router.handle(
    "wx:user",
    "/session attach review --agent codex --ws backend --name existing-review",
  );

  // Overwriting the row would orphan the old Runtime LID (worker/fence/queue)
  // with no handle left to converge it: refuse, keep the old binding intact.
  expect(reply.text).toBe(t().session.sessionAlreadyExists("review", "codex", "backend"));
  await expect(sessions.getSession("review")).resolves.toMatchObject({
    alias: "review",
    transportSession: before?.transportSession,
    logicalSessionId: before?.logicalSessionId,
  });
});

test("attaches and selects an existing session without creating it through transport", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  const reply = await router.handle(
    "wx:user",
    "/session attach review --agent codex --ws backend --name existing-review",
  );

  expect(reply.text).toBe(t().session.sessionAttached("review"));
  expect((transport.ensureSession as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  await expect(sessions.getCurrentSession("wx:user")).resolves.toMatchObject({
    alias: "review",
    transportSession: "existing-review",
  });
});

test("emits session.ready when attaching an existing session", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);
  const marks: string[] = [];
  const perfSpan = {
    traceId: "trace-attach",
    mark: (event: string) => marks.push(event),
    setOutcome: () => {},
  };

  await router.handle(
    "wx:user",
    "/session attach review --agent codex --ws backend --name existing-review",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    perfSpan,
  );

  expect(marks).toContain("session.ready");
});

test("rejects attaching a session name that does not exist in acpx", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  (transport.hasSession as ReturnType<typeof mock>).mockImplementationOnce(async () => false);
  const router = new CommandRouter(sessions, transport);

  const reply = await router.handle(
    "wx:user",
    "/session attach review --agent codex --ws backend --name missing-review",
  );

  expect(reply.text).toContain(t().session.sessionAttachNotFound("review", "codex", "backend"));
  expect(await sessions.listSessions("wx:user")).toEqual([]);
  await expect(sessions.getCurrentSession("wx:user")).resolves.toBeNull();
});

test("attach hint quotes a workspace name containing a space", async () => {
  const config = createConfig();
  config.workspaces["My Repo"] = { cwd: "/tmp/My Repo" };
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  (transport.hasSession as ReturnType<typeof mock>).mockImplementationOnce(async () => false);
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const reply = await router.handle(
    "wx:user",
    '/session attach review --agent codex --ws "My Repo" --name missing-review',
  );

  expect(reply.text).toContain(t().session.sessionAttachNotFound("review", "codex", '"My Repo"'));
});

test("renders status for the current session", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/status");

  const s = t().session;
  expect(reply.text).toBe(
    [s.statusHeader, s.statusNameLabel("api-fix"), s.statusAgentLabel("codex"), s.statusWorkspaceLabel("backend")].join("\n"),
  );
});

test("rejects /session tail when no session is selected", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  const reply = await router.handle("wx:user", "/session tail");

  expect(reply.text).toBe(t().session.noCurrent);
});

test("proxies /session tail [N] to the transport for the current session", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const tailSessionHistory = mock(async (_session: unknown, lines: number) => ({ text: `history:${lines}` }));
  (transport as unknown as { tailSessionHistory: unknown }).tailSessionHistory = tailSessionHistory;
  const router = new CommandRouter(sessions, transport);

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");
  const defaultReply = await router.handle("wx:user", "/session tail");
  const limitedReply = await router.handle("wx:user", "/session tail 10");

  expect(defaultReply.text).toBe("history:50");
  expect(limitedReply.text).toBe("history:10");
  expect(tailSessionHistory).toHaveBeenCalledWith(
    expect.objectContaining({ alias: "api-fix", transportSession: expect.stringMatching(/^backend:api-fix:reset-\d+$/) }),
    50,
  );
  expect(tailSessionHistory).toHaveBeenCalledWith(
    expect.objectContaining({ alias: "api-fix", transportSession: expect.stringMatching(/^backend:api-fix:reset-\d+$/) }),
    10,
  );
});

test("renders sessions list in Chinese", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, createConfig());

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");
  const reply = await router.handle("wx:user", "/sessions");

  const s = t().session;
  expect(reply.text).toBe([s.sessionListHeader, `${s.sessionListItem("api-fix", "codex", "backend")} ${s.currentLabel}`].join("\n"));
});

test("lists sessions for bare session commands and aliases", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, createConfig());

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");
  const bareReply = await router.handle("wx:user", "/session");
  const aliasReply = await router.handle("wx:user", "/ss");

  const s2 = t().session;
  const expectedList = [s2.sessionListHeader, `${s2.sessionListItem("api-fix", "codex", "backend")} ${s2.currentLabel}`].join("\n");
  expect(bareReply.text).toBe(expectedList);
  expect(aliasReply.text).toBe(expectedList);
});

test("session help mentions /ssn native sessions", async () => {
  const { router } = buildRouter();

  const reply = await router.handle("wx:user", "/help session");

  expect(reply.text).toContain("/ssn");
  expect(reply.text).toContain(t().session.sessionHelpCmdSsnDesc);
});

test("ssn help alias renders native session guidance", async () => {
  const { router } = buildRouter();

  const reply = await router.handle("wx:user", "/help ssn");

  expect(reply.text).toContain(t().help.topicHeader("native"));
  expect(reply.text).toContain("/ssn");
  expect(reply.text).toContain(t().session.nativeHelpCmdSsnDesc);
  expect(reply.text).toContain("docs/native-sessions.md");
});

test("creates a session via the short alias and agent flag", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  const reply = await router.handle("wx:user", "/ss new api-fix -a codex --ws backend");

  expect(reply.text).toBe(t().session.sessionCreated("api-fix"));
});



test("does not create a workspace from the shortcut command when the agent is invalid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-shortcut-"));
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));
  const workspaceName = basename(dir);

  const reply = await router.handle("wx:user", `/ss missing-agent -d "${dir}"`);

  expect(reply.text).toContain(t().shortcut.agentNotRegistered("missing-agent", t().shortcut.agentNotRegisteredAvailable("codex")));
  expect(config.workspaces[workspaceName]).toBeUndefined();
  expect(await sessions.listSessions("wx:user")).toEqual([]);

  await rm(dir, { recursive: true, force: true });
});

test("creates a workspace and session from the shortcut command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-shortcut-"));
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));
  const workspaceName = basename(dir);

  const reply = await router.handle("wx:user", `/ss codex -d "${dir}"`);

  expect(reply.text).toContain(t().shortcut.createdHeader(`${workspaceName}:codex`));
  expect(reply.text).toContain(t().shortcut.createdNewWorkspace(workspaceName, normalizeWorkspacePath(dir)));
  expect(reply.text).toContain(t().shortcut.createdNewSession(`${workspaceName}:codex`));
  expect(await sessions.getCurrentSession("wx:user")).toMatchObject({
    alias: `${workspaceName}:codex`,
    workspace: workspaceName,
    transportSession: expect.stringMatching(new RegExp(`^${workspaceName}:codex:reset-\\d+$`)),
    cwd: normalizeWorkspacePath(dir),
  });

  await rm(dir, { recursive: true, force: true });
});

test("shortcut auto-registers a workspace with a sanitized name when cwd has spaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "weacpx-shortcut-"));
  const dir = join(root, "My Project");
  await mkdir(dir);
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const reply = await router.handle("wx:user", `/ss codex -d "${dir}"`);

  expect(reply.text).toContain(t().shortcut.createdNewWorkspace("My-Project", normalizeWorkspacePath(dir)));
  expect(config.workspaces["My-Project"]).toEqual({ cwd: normalizeWorkspacePath(dir) });
  expect(config.workspaces["My Project"]).toBeUndefined();

  await rm(root, { recursive: true, force: true });
});

test("shortcut creation still selects the session when agent command refresh fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-shortcut-"));
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(
    sessions,
    transport,
    config,
    new MemoryConfigStore(config),
    undefined,
    async () => {
      throw new Error("index read failed");
    },
  );
  const workspaceName = basename(dir);

  const reply = await router.handle("wx:user", `/ss codex -d "${dir}"`);

  expect(reply.text).toContain(t().shortcut.createdHeader(`${workspaceName}:codex`));
  expect(await sessions.getCurrentSession("wx:user")).toMatchObject({
    alias: `${workspaceName}:codex`,
    workspace: workspaceName,
  });

  await rm(dir, { recursive: true, force: true });
});

test("reuses an existing workspace and session from the workspace shortcut command", async () => {
  const config = createConfig();
  config.workspaces.weacpx = { cwd: "/tmp/weacpx" };
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const reply = await router.handle("wx:user", "/ss codex --ws weacpx");

  expect(reply.text).toContain(t().shortcut.createdHeader("weacpx:codex"));
  expect(reply.text).toContain(t().shortcut.createdReusedWorkspace("weacpx"));
  expect(reply.text).toContain(t().shortcut.createdNewSession("weacpx:codex"));
  expect(await sessions.getCurrentSession("wx:user")).toMatchObject({
    alias: "weacpx:codex",
    workspace: "weacpx",
    transportSession: expect.stringMatching(/^weacpx:codex:reset-\d+$/),
  });
});

test("handle() never reloads config from the store; watcher-style in-place refresh is honored", async () => {
  // Out-of-band config edits (CLI `xacpx workspace add`, manual file edits) are
  // picked up by the config watcher in main.ts, which refreshes the SAME shared
  // AppConfig object in place. The router must not read the config store on the
  // per-message hot path — that was a full disk read + parse + config rebuild
  // on EVERY inbound message.
  const runtimeConfig = createConfig();
  const persistedConfig = createConfig();
  persistedConfig.workspaces.agent = { cwd: "E:/agent" };
  const configStore = new MemoryConfigStore(persistedConfig);
  const loadSpy = mock(configStore.load.bind(configStore));
  configStore.load = loadSpy as never;
  const sessions = new SessionService(runtimeConfig, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, runtimeConfig, configStore);

  // The store knows workspace "agent" but the runtime config does not yet:
  // the router must NOT consult the store mid-message, so the shortcut fails.
  const before = await router.handle("wx:user", "/ss codex --ws agent");
  expect(loadSpy).not.toHaveBeenCalled();
  expect(before.text).toContain(
    t().shortcut.workspaceNotRegistered("agent", t().shortcut.workspaceAvailable("backend")),
  );

  // Simulate the watcher's reloadRuntimeConfig: refresh the shared object in place.
  Object.assign(runtimeConfig, { workspaces: { ...persistedConfig.workspaces } });

  const reply = await router.handle("wx:user", "/ss codex --ws agent");
  expect(reply.text).toContain(t().shortcut.createdHeader("agent:codex"));
  expect(loadSpy).not.toHaveBeenCalled();
  expect(await sessions.getCurrentSession("wx:user")).toMatchObject({
    alias: "agent:codex",
    workspace: "agent",
    cwd: "E:/agent",
  });
});

test("rejects the workspace shortcut command when the workspace is missing", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const reply = await router.handle("wx:user", "/ss codex --ws missing");

  expect(reply.text).toContain(t().shortcut.workspaceNotRegistered("missing", t().shortcut.workspaceAvailable("backend")));
  expect(await sessions.listSessions("wx:user")).toEqual([]);
});

test("reuses the derived workspace and session from the shortcut command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-shortcut-"));
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));
  const workspaceName = basename(dir);

  await router.handle("wx:user", `/ss codex -d "${dir}"`);
  const reply = await router.handle("wx:user", `/ss codex -d "${dir}"`);

  expect(reply.text).toBe(
    [t().shortcut.reuseHeader(`${workspaceName}:codex`), t().shortcut.reuseWorkspace(workspaceName), t().shortcut.reuseSession(`${workspaceName}:codex`)].join("\n"),
  );
  expect((transport.ensureSession as ReturnType<typeof mock>).mock.calls).toHaveLength(1);

  await rm(dir, { recursive: true, force: true });
});

test("creates uniquely named sessions for the explicit workspace shortcut create command", async () => {
  const config = createConfig();
  config.workspaces.weacpx = { cwd: "/tmp/weacpx" };
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  await router.handle("wx:user", "/ss new codex --ws weacpx");
  const reply = await router.handle("wx:user", "/ss new codex --ws weacpx");

  expect(reply.text).toContain(t().shortcut.createdHeader("weacpx:codex-2"));
  expect(await sessions.getCurrentSession("wx:user")).toMatchObject({
    alias: "weacpx:codex-2",
    transportSession: expect.stringMatching(/^weacpx:codex-2:reset-\d+$/),
  });
});

test("auto-renames the derived workspace when the basename already exists for another path", async () => {
  const parent = await mkdtemp(join(tmpdir(), "weacpx-shortcut-parent-"));
  const firstDir = join(parent, "weacpx");
  const secondRoot = await mkdtemp(join(tmpdir(), "weacpx-shortcut-other-"));
  const secondDir = join(secondRoot, "weacpx");
  await mkdir(firstDir);
  await mkdir(secondDir);

  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  await router.handle("wx:user", `/ss codex -d "${firstDir}"`);
  const reply = await router.handle("wx:user", `/ss codex -d "${secondDir}"`);

  expect(reply.text).toContain(t().shortcut.createdNewWorkspace("weacpx-2", normalizeWorkspacePath(secondDir)));
  expect(config.workspaces["weacpx-2"]).toEqual({ cwd: normalizeWorkspacePath(secondDir) });

  await rm(parent, { recursive: true, force: true });
  await rm(secondRoot, { recursive: true, force: true });
});

test("creates uniquely named sessions for the explicit shortcut create command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-shortcut-"));
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));
  const workspaceName = basename(dir);

  await router.handle("wx:user", `/ss new codex -d "${dir}"`);
  const reply = await router.handle("wx:user", `/ss new codex -d "${dir}"`);

  expect(reply.text).toContain(t().shortcut.createdHeader(`${workspaceName}:codex-2`));
  expect(await sessions.getCurrentSession("wx:user")).toMatchObject({
    alias: `${workspaceName}:codex-2`,
    transportSession: expect.stringMatching(new RegExp(`^${workspaceName}:codex-2:reset-\\d+$`)),
  });

  await rm(dir, { recursive: true, force: true });
});

test("keeps the shortcut-created workspace but avoids a ghost session when transport creation fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-shortcut-"));
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  (transport.ensureSession as ReturnType<typeof mock>).mockImplementationOnce(async () => {
    throw new Error("boom");
  });
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));
  const workspaceName = basename(dir);

  const reply = await router.handle("wx:user", `/ss codex -d "${dir}"`);

  expect(reply.text).toContain(t().shortcut.creationFailed(`${workspaceName}:codex`));
  expect(reply.text).toContain(t().shortcut.creationFailedNewWorkspace(workspaceName, normalizeWorkspacePath(dir)));
  expect(config.workspaces[workspaceName]).toEqual({ cwd: normalizeWorkspacePath(dir) });
  expect(await sessions.listSessions("wx:user")).toEqual([]);
  await expect(sessions.getCurrentSession("wx:user")).resolves.toBeNull();

  await rm(dir, { recursive: true, force: true });
});

test("shows the saved mode for the current session", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");
  await router.handle("wx:user", "/mode plan");

  const reply = await router.handle("wx:user", "/mode");

  expect(reply.text).toContain("plan");
});

test("sets the mode on the current session", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");

  const reply = await router.handle("wx:user", "/mode plan");

  expect(reply.text).toContain("plan");
  expect(getSetModeMock(transport)).toHaveBeenCalledWith(
    expect.objectContaining({ alias: "api-fix", transportSession: expect.stringMatching(/^backend:api-fix:reset-\d+$/) }),
    "plan",
  );
});

test("rejects mode commands when no session is selected", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  const reply = await router.handle("wx:user", "/mode");

  expect(reply.text).toContain("/session new");
  expect(reply.text).toContain("/use");
});

test("shows the effective reply mode for the current session", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");

  const reply = await router.handle("wx:user", "/replymode");

  const s3 = t().session;
  expect(reply.text).toContain(s3.replyModeGlobalDefault("stream"));
  expect(reply.text).toContain(s3.replyModeSessionOverride(s3.modeNotSet));
  expect(reply.text).toContain(s3.replyModeEffective("stream"));
});

test("sets and resets the current session reply mode override", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  await router.handle("wx:user", "/session new api-fix --agent codex --ws backend");

  const setReply = await router.handle("wx:user", "/replymode final");
  const showReply = await router.handle("wx:user", "/replymode");
  const resetReply = await router.handle("wx:user", "/replymode reset");

  const s4 = t().session;
  expect(setReply.text).toContain("final");
  expect(showReply.text).toContain(s4.replyModeSessionOverride("final"));
  expect(showReply.text).toContain(s4.replyModeEffective("final"));
  expect(resetReply.text).toContain(s4.replyModeReset("stream"));
});

// ── Task 8: ensureTransportSession reply + auto-install recovery ──────────────

test("ensureTransportSession retries once after auto-install succeeds", async () => {
  const { router, transport } = buildRouter();

  let calls = 0;
  (transport.ensureSession as ReturnType<typeof mock>).mockImplementation(async () => {
    calls += 1;
    if (calls === 1) {
      throw new MissingOptionalDepError({
        package: "opencode-windows-x64",
        parentPackagePath: null,
        rawMessage: "boom",
      });
    }
  });

  const replies: string[] = [];
  const reply = async (t: string) => {
    replies.push(t);
  };

  router.__setAutoInstallForTest(async (_pkg, _parent, opts) => {
    const verified = opts?.verify ? await opts.verify() : true;
    return { ok: verified, errors: [], logPath: "/log" };
  });

  const response = await router.handle("chat1", "/ss opencode --ws weacpx", reply);
  expect(response.text).toBeDefined();
  expect(calls).toBe(2);
  expect(replies.some((r) => r.includes(t().router.depMissing("opencode-windows-x64")))).toBe(true);
  expect(replies.some((r) => r.includes(t().router.depInstallVerifying))).toBe(true);
});

test("renders AutoInstallFailedError when auto-install fails", async () => {
  const { router, transport } = buildRouter();

  (transport.ensureSession as ReturnType<typeof mock>).mockImplementation(async () => {
    throw new MissingOptionalDepError({
      package: "opencode-windows-x64",
      parentPackagePath: "/some/path",
      rawMessage: "boom",
    });
  });
  router.__setAutoInstallForTest(async () => ({
    ok: false,
    errors: [
      { scope: "precise" as const, stderrTail: "npm ERR! 403", code: 1, reason: "exit" as const },
      { scope: "global" as const, stderrTail: "npm ERR! EACCES", code: 1, reason: "exit" as const },
    ],
    logPath: "/log/path",
  }));

  const replies: string[] = [];
  const response = await router.handle("chat1", "/ss opencode --ws weacpx", async (t) => {
    replies.push(t);
  });
  const full = (response.text ?? "") + replies.join("\n");
  expect(full).toContain("opencode-windows-x64");
  expect(full).toContain("npm install -g opencode-windows-x64");
  expect(full).toContain("/log/path");
  expect(full).toContain("安装错误（精确 / /some/path）");
  expect(full).toContain("安装错误（全局）");
});

test("retry's ensureSession error does not trigger second recovery loop", async () => {
  const { router, transport } = buildRouter();

  let calls = 0;
  (transport.ensureSession as ReturnType<typeof mock>).mockImplementation(async () => {
    calls += 1;
    throw new MissingOptionalDepError({ package: "p", parentPackagePath: null, rawMessage: "x" });
  });
  const autoInstall = mock(async (_pkg: string, _paths: string[], opts?: { verify?: () => Promise<boolean> }) => {
    const verified = opts?.verify ? await opts.verify() : true;
    return { ok: verified, errors: [], logPath: "/log" };
  });
  router.__setAutoInstallForTest(autoInstall);

  await router.handle("chat1", "/ss opencode --ws weacpx", async () => {});
  expect(calls).toBe(2); // original + one verify — no third
  expect(autoInstall.mock.calls).toHaveLength(1);
});

test("renders verify-failed step when auto-install succeeds but session still misses the dep", async () => {
  const { router, transport } = buildRouter();

  (transport.ensureSession as ReturnType<typeof mock>).mockImplementation(async () => {
    throw new MissingOptionalDepError({
      package: "opencode-windows-x64",
      parentPackagePath: "/p",
      rawMessage: "boom",
    });
  });
  router.__setAutoInstallForTest(async (_pkg, _parent, opts) => {
    // Simulate: precise install exit=0 but verify() fails, then global exit=0 and verify() also fails
    const firstVerified = opts?.verify ? await opts.verify() : true;
    if (firstVerified) return { ok: true, errors: [], logPath: "/log/path" };
    return {
      ok: false,
      errors: [
        { scope: "precise" as const, stderrTail: "", code: 0, reason: "verify-failed" as const },
        { scope: "global" as const, stderrTail: "", code: 0, reason: "verify-failed" as const },
      ],
      logPath: "/log/path",
    };
  });

  const replies: string[] = [];
  const response = await router.handle("chat1", "/ss opencode --ws weacpx", async (t) => {
    replies.push(t);
  });
  const full = (response.text ?? "") + replies.join("\n");
  expect(full).toContain("自动安装已执行但未能修复");
  expect(full).toContain("安装已执行但验证失败（精确 / /p）");
  expect(full).toContain("安装已执行但验证失败（全局）");
  expect(full).toContain("npm install -g opencode-windows-x64");
  expect(full).toContain("/log/path");
});

test("retry progress handler uses a fresh elapsed timer", async () => {
  const { router, transport } = buildRouter();

  let call = 0;
  const progressCalls: Array<{ call: number; stage: string }> = [];
  (transport.ensureSession as ReturnType<typeof mock>).mockImplementation(
    async (_s: unknown, onProgress: ((stage: string) => void) | undefined) => {
      call += 1;
      const myCall = call;
      onProgress?.("spawn");
      progressCalls.push({ call: myCall, stage: "spawn" });
      if (myCall === 1) {
        throw new MissingOptionalDepError({
          package: "p",
          parentPackagePath: null,
          rawMessage: "boom",
        });
      }
    },
  );
  router.__setAutoInstallForTest(async (_pkg, _parent, opts) => {
    const verified = opts?.verify ? await opts.verify() : true;
    return { ok: verified, errors: [], logPath: "/log" };
  });

  const replies: string[] = [];
  await router.handle("chat1", "/ss opencode --ws weacpx", async (t) => {
    replies.push(t);
  });

  // Two separate "正在启动" messages — one per progress handler (initial + verify)
  expect(replies.filter((r) => r.includes("正在启动")).length).toBe(2);
});

test("discoverPaths result is passed to autoInstall and labels render per-path", async () => {
  const { router, transport } = buildRouter();

  (transport.ensureSession as ReturnType<typeof mock>).mockImplementation(async () => {
    throw new MissingOptionalDepError({
      package: "opencode-windows-x64",
      parentPackagePath: "/seed/opencode",
      rawMessage: "boom",
    });
  });

  router.__setDiscoverPathsForTest(async () => ["/bun/opencode", "/npm/opencode"]);

  const autoInstall = mock(async (_pkg: string, paths: string[]) => ({
    ok: false,
    errors: [
      { scope: "precise" as const, stderrTail: "E1", code: 1, reason: "exit" as const, path: paths[0] },
      { scope: "precise" as const, stderrTail: "E2", code: 1, reason: "exit" as const, path: paths[1] },
      { scope: "global" as const, stderrTail: "E3", code: 1, reason: "exit" as const },
    ],
    logPath: "/log/path",
  }));
  router.__setAutoInstallForTest(autoInstall);

  const replies: string[] = [];
  const response = await router.handle("chat1", "/ss opencode --ws weacpx", async (t) => {
    replies.push(t);
  });

  expect(autoInstall.mock.calls[0][1]).toEqual(["/bun/opencode", "/npm/opencode"]);
  const full = (response.text ?? "") + replies.join("\n");
  expect(full).toContain("安装错误（精确 / /bun/opencode）");
  expect(full).toContain("安装错误（精确 / /npm/opencode）");
  expect(full).toContain("安装错误（全局）");
});

test("progress events reach reply channel with debounce", async () => {
  const { router, transport } = buildRouter();

  (transport.ensureSession as ReturnType<typeof mock>).mockImplementation(async (_s: unknown, onProgress: ((stage: string) => void) | undefined) => {
    onProgress?.("spawn");
    // Without sleeping — initializing within debounce window should be suppressed
    onProgress?.("initializing");
    onProgress?.("ready");
  });

  const replies: string[] = [];
  await router.handle("chat1", "/ss opencode --ws weacpx", async (t) => {
    replies.push(t);
  });

  const spawnMsgs = replies.filter((m) => m.includes("正在启动"));
  const initMsgs = replies.filter((m) => m.includes("初始化中"));
  expect(spawnMsgs).toHaveLength(1);
  expect(initMsgs).toHaveLength(0); // debounced
});

test("reply reaches ensureTransportSession via /session new", async () => {
  const { router, transport } = buildRouter();

  (transport.ensureSession as ReturnType<typeof mock>).mockImplementation(async (_s: unknown, onProgress: ((stage: string) => void) | undefined) => {
    onProgress?.("spawn");
  });

  const replies: string[] = [];
  await router.handle("chat1", "/session new demo --agent opencode --ws weacpx", async (t) => {
    replies.push(t);
  });

  expect(replies.some((m) => m.includes("正在启动"))).toBe(true);
});

test("reply reaches ensureTransportSession via /session reset", async () => {
  const { router, transport } = buildRouter();

  await router.handle("chat1", "/ss opencode --ws weacpx", async () => {});

  (transport.ensureSession as ReturnType<typeof mock>).mockImplementation(async (_s: unknown, onProgress: ((stage: string) => void) | undefined) => {
    onProgress?.("spawn");
  });

  const replies: string[] = [];
  await router.handle("chat1", "/session reset", async (t) => {
    replies.push(t);
  });

  expect(replies.some((m) => m.includes("正在启动"))).toBe(true);
});

test("weixin prompts pass reply quota context to the transport", async () => {
  const { sessions, transport } = buildRouter();
  const router = new CommandRouter(sessions, transport, undefined, undefined, undefined, undefined, undefined, new QuotaManager());

  await router.handle("weixin:default:wxid_alice", "/session new demo --agent codex --ws backend");
  await router.handle("weixin:default:wxid_alice", "hello", async () => {});

  expect(getPromptMock(transport).mock.calls.at(-1)?.[3]).toMatchObject({
    chatKey: "weixin:default:wxid_alice",
  });
});

test.each([
  ["feishu:default:oc_chat", "feishu"],
  ["yuanbao:default:group:group_001", "yuanbao"],
])("non-weixin prompts do not pass reply quota context (%s)", async (chatKey) => {
  const { sessions, transport } = buildRouter();
  const router = new CommandRouter(sessions, transport, undefined, undefined, undefined, undefined, undefined, new QuotaManager());

  await router.handle(chatKey, "/session new demo --agent codex --ws backend");
  await router.handle(chatKey, "hello", async () => {});

  expect(getPromptMock(transport).mock.calls.at(-1)?.[3]).toBeUndefined();
});

test("feishu session shortcut creates scoped internal alias but displays plain alias", async () => {
  const config = createConfig();
  config.agents.codex = { driver: "codex" };
  config.workspaces.backend = { cwd: "/tmp/backend" };
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const response = await router.handle("feishu:default:oc_chat", "/ss codex --ws backend");

  expect(response.text).toContain(t().shortcut.createdHeader("backend:codex"));
  expect(await sessions.getSession("feishu:backend:codex")).not.toBeNull();
  expect(await sessions.getSession("backend:codex")).toBeNull();
});

test("weixin session shortcut reuses legacy alias when present", async () => {
  const config = createConfig();
  config.agents.codex = { driver: "codex" };
  config.workspaces.backend = { cwd: "/tmp/backend" };
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));
  await sessions.attachSession("backend:codex", "codex", "backend", "backend:codex");

  const response = await router.handle("weixin:default:wxid_alice", "/ss codex --ws backend");

  expect(response.text).toContain(t().shortcut.reuseHeader("backend:codex"));
  expect(await sessions.getSession("weixin:backend:codex")).toBeNull();
});

test("/session use resolves display alias inside current channel", async () => {
  const config = createConfig();
  config.agents.codex = { driver: "codex" };
  config.workspaces.backend = { cwd: "/tmp/backend" };
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));
  await sessions.attachSession("feishu:backend:codex", "codex", "backend", "feishu:backend:codex");

  const response = await router.handle("feishu:default:oc_chat", "/use backend:codex");

  expect(response.text).toContain(t().session.switched("backend:codex", "codex", "backend"));
  const current = await sessions.getCurrentSession("feishu:default:oc_chat");
  expect(current?.alias).toBe("feishu:backend:codex");
});


test("/ss keeps reusing existing logical sessions without listing native sessions", async () => {
  const { router, transport, config } = buildRouter();
  config.workspaces.project = { cwd: "/tmp/project" };

  await router.handle("wx:user", "/ss codex --ws project");
  const reply = await router.handle("wx:user", "/ss codex --ws project");

  expect(reply.text).toContain(t().shortcut.reuseHeader("project:codex"));
  expect((transport.listAgentSessions as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
});

test("/ssn lists native sessions from the current session context", async () => {
  const { router, transport, config } = buildRouter();
  config.workspaces.project = { cwd: "/tmp/project" };
  (transport.listAgentSessions as ReturnType<typeof mock>).mockResolvedValueOnce({
    source: "agent",
    sessions: [
      {
        sessionId: "61456d60-b7e1-47e6-8641-72bbe8e552e7",
        cwd: "/tmp/project",
        title: "Fix CI",
        updatedAt: "2026-05-26T01:00:00.000Z",
      },
    ],
    nextCursor: null,
  });

  await router.handle("wx:user", "/ss codex --ws project");
  const reply = await router.handle("wx:user", "/ssn");

  expect(reply.text).toContain(t().nativeSession.cardHeader("Codex", "project"));
  expect(reply.text).toContain("【1】 Fix CI");
  expect(reply.text).toContain(t().nativeSession.cardTimeLabel("2026-05-26 01:00"));
  expect(reply.text).toContain(t().nativeSession.cardIdLabel("…e8e552e7"));
  expect(reply.text).toContain(t().nativeSession.cardActionAttach);
  expect(reply.text).toContain(t().nativeSession.cardActionAlias);
  expect(reply.text).not.toContain(`| ${t().nativeSession.tableColNum} | ${t().nativeSession.tableColTitle} |`);
  expect(reply.text).not.toContain("61456d60-b7e1-47e6-8641-72bbe8e552e7");
  expect(transport.listAgentSessions).toHaveBeenCalledWith({
    agent: "codex",
    acpxAgent: "xacpx-managed-codex-f4349e35c3c8",
    agentCommand: "npx -y --registry=https://registry.npmjs.org --@agentclientprotocol:registry=https://registry.npmjs.org @agentclientprotocol/codex-acp@1.1.9",
    driver: "codex",
    cwd: "/tmp/project",
    filterCwd: "/tmp/project",
  });
});

test("/ssn renders long WeChat native session lists as cards with id tails", async () => {
  const { router, transport, config } = buildRouter();
  config.workspaces.project = { cwd: "/tmp/project" };
  (transport.listAgentSessions as ReturnType<typeof mock>).mockResolvedValueOnce({
    source: "agent",
    sessions: Array.from({ length: 7 }, (_, index) => ({
      sessionId: `61456d60-b7e1-47e6-8641-00000000000${index + 1}`,
      cwd: "/tmp/project",
      title: `修复一个很长的微信表格分页标题 ${index + 1}`,
      updatedAt: "2026-05-26T01:00:00.000Z",
    })),
    nextCursor: null,
  });

  const reply = await router.handle("wx:user", "/ssn codex --ws project");

  expect(reply.text).not.toContain(`| ${t().nativeSession.tableColNum} | ${t().nativeSession.tableColTitle} |`);
  expect(reply.text).toContain("【1】 修复一个很长的微信表格分页标题 1");
  expect(reply.text).toContain("【7】 修复一个很长的微信表格分页标题 7");
  expect(reply.text).toContain(t().nativeSession.cardIdLabel("…00000001"));
  expect(reply.text).toContain(t().nativeSession.cardIdLabel("…00000007"));
});

test("/ssn keeps one table header for long Feishu native session lists", async () => {
  const { router, transport, config } = buildRouter();
  config.workspaces.project = { cwd: "/tmp/project" };
  (transport.listAgentSessions as ReturnType<typeof mock>).mockResolvedValueOnce({
    source: "agent",
    sessions: Array.from({ length: 7 }, (_, index) => ({
      sessionId: `thread-${index + 1}`,
      cwd: "/tmp/project",
      title: `修复一个很长的飞书表格分页标题 ${index + 1}`,
      updatedAt: "2026-05-26T01:00:00.000Z",
    })),
    nextCursor: null,
  });

  const reply = await router.handle("feishu:default:oc_chat", "/ssn codex --ws project");

  const tableHeaderRegex = new RegExp(`\\| ${t().nativeSession.tableColNum} \\| ${t().nativeSession.tableColTitle} \\| ${t().nativeSession.tableColUpdatedAt} \\| ${t().nativeSession.tableColId} \\|`, "g");
  expect(reply.text?.match(tableHeaderRegex)).toHaveLength(1);
  expect(reply.text).toContain("| 7 | 修复一个很长的飞书表格分页标题 7 |");
});

test("/ssn renders cards for a non-weixin channel that declares the cards format", async () => {
  const { router, transport, config } = buildRouter({ nativeSessionListFormat: () => "cards" });
  config.workspaces.project = { cwd: "/tmp/project" };
  (transport.listAgentSessions as ReturnType<typeof mock>).mockResolvedValueOnce({
    source: "agent",
    sessions: [
      { sessionId: "thread-1", cwd: "/tmp/project", title: "Fix CI", updatedAt: "2026-05-26T01:00:00.000Z" },
      { sessionId: "thread-2", cwd: "/tmp/project", title: "Add tests", updatedAt: "2026-05-26T02:00:00.000Z" },
    ],
    nextCursor: null,
  });

  const reply = await router.handle("feishu:default:oc_chat", "/ssn codex --ws project");

  expect(reply.text).not.toContain(`| ${t().nativeSession.tableColNum} | ${t().nativeSession.tableColTitle} |`);
  expect(reply.text).toContain("【1】 Fix CI");
  expect(reply.text).toContain("【2】 Add tests");
});

test("/ssn preserves transport method this binding when listing native sessions", async () => {
  const config = createConfig();
  config.workspaces.project = { cwd: "/tmp/project" };
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = {
    ...createTransport(),
    client: {
      calls: [] as unknown[],
    },
    async listAgentSessions(query: unknown) {
      this.client.calls.push(query);
      return {
        source: "agent" as const,
        sessions: [{ sessionId: "thread-1", cwd: "/tmp/project", title: "Fix CI" }],
      };
    },
  };
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const reply = await router.handle("wx:user", "/ssn codex --ws project");

  expect(reply.text).toContain(t().nativeSession.attachedAndSwitched("Codex", "codex-thread-1"));
  expect(transport.client.calls).toEqual([
    {
      agent: "codex",
      acpxAgent: "xacpx-managed-codex-f4349e35c3c8",
      agentCommand: "npx -y --registry=https://registry.npmjs.org --@agentclientprotocol:registry=https://registry.npmjs.org @agentclientprotocol/codex-acp@1.1.9",
      driver: "codex",
      cwd: "/tmp/project",
      filterCwd: "/tmp/project",
    },
  ]);
});

test("/ssn explicit target auto-attaches a single native session", async () => {
  const { router, transport, config, sessions } = buildRouter();
  config.workspaces.project = { cwd: "/tmp/project" };
  (transport.listAgentSessions as ReturnType<typeof mock>).mockResolvedValueOnce({
    source: "agent",
    sessions: [{ sessionId: "61456d60-b7e1-47e6-8641-72bbe8e552e7", cwd: "/tmp/project", title: "Fix CI" }],
  });

  const reply = await router.handle("wx:user", "/ssn codex --ws project");

  expect(reply.text).toContain(t().nativeSession.attachedAndSwitched("Codex", "codex-e8e552e7"));
  expect(transport.resumeAgentSession).toHaveBeenCalledWith(
    expect.objectContaining({ alias: "codex-e8e552e7", transportSession: "codex-e8e552e7" }),
    "61456d60-b7e1-47e6-8641-72bbe8e552e7",
  );
  await expect(sessions.getCurrentSession("wx:user")).resolves.toMatchObject({
    alias: "codex-e8e552e7",
    source: "agent-side",
    agentSessionId: "61456d60-b7e1-47e6-8641-72bbe8e552e7",
  });
  const attached = await sessions.getCurrentSession("wx:user");
  expect(attached?.agentArgv?.[1]).toContain("acp-output-guard-main.");
});

test("/ssn avoids clobbering an existing transport session owned by another alias", async () => {
  const { router, transport, config, sessions } = buildRouter();
  config.workspaces.project = { cwd: "/tmp/project" };

  await router.handle("wx:user", "/session new codex-e8e552e7 --agent codex --ws project");
  (transport.listAgentSessions as ReturnType<typeof mock>).mockResolvedValueOnce({
    source: "agent",
    sessions: [{ sessionId: "61456d60-b7e1-47e6-8641-72bbe8e552e7", cwd: "/tmp/project", title: "Fix CI" }],
  });

  const reply = await router.handle("wx:user", "/ssn codex --ws project");

  expect(reply.text).toContain(t().nativeSession.attachedAndSwitched("Codex", "codex-e8e552e7-2"));
  expect(transport.resumeAgentSession).toHaveBeenCalledWith(
    expect.objectContaining({ alias: "codex-e8e552e7-2", transportSession: "codex-e8e552e7-2" }),
    "61456d60-b7e1-47e6-8641-72bbe8e552e7",
  );
  await expect(sessions.getCurrentSession("wx:user")).resolves.toMatchObject({
    alias: "codex-e8e552e7-2",
    source: "agent-side",
    agentSessionId: "61456d60-b7e1-47e6-8641-72bbe8e552e7",
  });
});

test("/ssn with only an agent lists a single candidate instead of auto-attaching", async () => {
  const { router, transport, config } = buildRouter();
  config.workspaces.project = { cwd: "/tmp/project" };
  await router.handle("wx:user", "/ss codex --ws project");
  (transport.listAgentSessions as ReturnType<typeof mock>).mockResolvedValueOnce({
    source: "agent",
    sessions: [{ sessionId: "thread-1", cwd: "/tmp/project", title: "Fix CI" }],
  });

  const reply = await router.handle("wx:user", "/ssn codex");

  expect(reply.text).toContain("【1】 Fix CI");
  expect(transport.resumeAgentSession).not.toHaveBeenCalled();
});

test("/ssn attach by raw session id uses the requested alias", async () => {
  const { router, transport, config, sessions } = buildRouter();
  config.workspaces.project = { cwd: "/tmp/project" };
  await router.handle("wx:user", "/ss codex --ws project");

  const reply = await router.handle("wx:user", "/ssn attach thread-raw -a fix-ci");

  expect(reply.text).toContain(t().nativeSession.attachedAndSwitched("Codex", "fix-ci"));
  expect(transport.resumeAgentSession).toHaveBeenCalledWith(
    expect.objectContaining({ alias: "fix-ci", transportSession: "fix-ci" }),
    "thread-raw",
  );
  await expect(sessions.getCurrentSession("wx:user")).resolves.toMatchObject({
    alias: "fix-ci",
    source: "agent-side",
    agentSessionId: "thread-raw",
  });
});

test("/ssn caches multiple candidates and /ssn 1 attaches the cached item", async () => {
  const { router, transport, config, sessions } = buildRouter();
  config.workspaces.project = { cwd: "/tmp/project" };
  (transport.listAgentSessions as ReturnType<typeof mock>).mockResolvedValueOnce({
    source: "agent",
    sessions: [
      { sessionId: "thread-1", cwd: "/tmp/project", title: "Fix CI" },
      { sessionId: "thread-2", cwd: "/tmp/project", title: "Refactor" },
    ],
  });

  const listReply = await router.handle("wx:user", "/ssn codex --ws project");
  const attachReply = await router.handle("wx:user", "/ssn 2");

  expect(listReply.text).toContain("【1】 Fix CI");
  expect(listReply.text).toContain("【2】 Refactor");
  expect(attachReply.text).toContain(t().nativeSession.attachedAndSwitched("Codex", "codex-thread-2"));
  expect(transport.resumeAgentSession).toHaveBeenCalledWith(expect.any(Object), "thread-2");
  await expect(sessions.getCurrentSession("wx:user")).resolves.toMatchObject({ agentSessionId: "thread-2" });
});

test("/ssn 1 -a sets the alias when attaching a cached candidate", async () => {
  const { router, transport, config, sessions } = buildRouter();
  config.workspaces.project = { cwd: "/tmp/project" };
  (transport.listAgentSessions as ReturnType<typeof mock>).mockResolvedValueOnce({
    source: "agent",
    sessions: [
      { sessionId: "thread-1", cwd: "/tmp/project", title: "Fix CI" },
      { sessionId: "thread-2", cwd: "/tmp/project", title: "Refactor" },
    ],
  });

  await router.handle("wx:user", "/ssn codex --ws project");
  const reply = await router.handle("wx:user", "/ssn 2 -a fix-ci");

  expect(reply.text).toContain(t().nativeSession.attachedAndSwitched("Codex", "fix-ci"));
  expect(transport.resumeAgentSession).toHaveBeenCalledWith(
    expect.objectContaining({ alias: "fix-ci", transportSession: "fix-ci" }),
    "thread-2",
  );
  await expect(sessions.getCurrentSession("wx:user")).resolves.toMatchObject({
    alias: "fix-ci",
    agentSessionId: "thread-2",
  });
});

test("/ssn renders a context-preserving next page command for explicit workspace lists", async () => {
  const { router, transport, config } = buildRouter();
  config.workspaces.project = { cwd: "/tmp/project" };
  (transport.listAgentSessions as ReturnType<typeof mock>).mockResolvedValueOnce({
    source: "agent",
    sessions: [
      { sessionId: "thread-1", cwd: "/tmp/project", title: "Fix CI" },
      { sessionId: "thread-2", cwd: "/tmp/project", title: "Refactor" },
    ],
    nextCursor: "cursor-2",
  });

  const reply = await router.handle("wx:user", "/ssn codex --ws project");

  expect(reply.text).toContain("更多：/ssn codex --ws project --cursor cursor-2");
});

test("/ssn renders a direct cwd next page command for explicit cwd lists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-native-page-"));
  const { router, transport } = buildRouter();
  (transport.listAgentSessions as ReturnType<typeof mock>).mockResolvedValueOnce({
    source: "agent",
    sessions: [
      { sessionId: "thread-1", cwd: dir, title: "Fix CI" },
      { sessionId: "thread-2", cwd: dir, title: "Refactor" },
    ],
    nextCursor: "cursor-2",
  });

  try {
    const reply = await router.handle("wx:user", `/ssn codex -d ${dir}`);

    expect(reply.text).toContain(`更多：/ssn codex -d ${normalizeWorkspacePath(dir)} --cursor cursor-2`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/ssn --all preserves all scope in next page commands", async () => {
  const { router, transport, config } = buildRouter();
  config.workspaces.project = { cwd: "/tmp/project" };
  (transport.listAgentSessions as ReturnType<typeof mock>).mockResolvedValueOnce({
    source: "agent",
    sessions: [
      { sessionId: "thread-1", cwd: "/tmp/project", title: "Fix CI" },
      { sessionId: "thread-2", cwd: "/tmp/other", title: "Other" },
    ],
    nextCursor: "cursor-2",
  });

  const reply = await router.handle("wx:user", "/ssn codex --ws project --all");

  expect(reply.text).toContain("更多：/ssn codex --ws project --all --cursor cursor-2");
  expect(transport.listAgentSessions).toHaveBeenCalledWith({
    agent: "codex",
    acpxAgent: "xacpx-managed-codex-f4349e35c3c8",
    agentCommand: "npx -y --registry=https://registry.npmjs.org --@agentclientprotocol:registry=https://registry.npmjs.org @agentclientprotocol/codex-acp@1.1.9",
    driver: "codex",
    cwd: "/tmp/project",
  });
});

test("/ssn --all cached selection resumes using the selected candidate cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-native-all-"));
  const { router, transport, config } = buildRouter();
  config.workspaces.project = { cwd: "/tmp/project" };
  (transport.listAgentSessions as ReturnType<typeof mock>).mockResolvedValueOnce({
    source: "agent",
    sessions: [
      { sessionId: "thread-1", cwd: "/tmp/project", title: "Fix CI" },
      { sessionId: "thread-2", cwd: dir, title: "Other repo" },
    ],
  });

  try {
    await router.handle("wx:user", "/ssn codex --ws project --all");
    const reply = await router.handle("wx:user", "/ssn 2");

    expect(reply.text).toContain(t().nativeSession.attachedAndSwitched("Codex", "codex-thread-2"));
    expect(transport.resumeAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: normalizeWorkspacePath(dir) }),
      "thread-2",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/ssn 1 switches to an already attached native session", async () => {
  const { router, transport, config } = buildRouter();
  config.workspaces.project = { cwd: "/tmp/project" };
  (transport.listAgentSessions as ReturnType<typeof mock>).mockResolvedValueOnce({
    source: "agent",
    sessions: [{ sessionId: "thread-1", cwd: "/tmp/project", title: "Fix CI" }],
  });

  await router.handle("wx:user", "/ssn codex --ws project");
  (transport.listAgentSessions as ReturnType<typeof mock>).mockResolvedValueOnce({
    source: "agent",
    sessions: [{ sessionId: "thread-1", cwd: "/tmp/project", title: "Fix CI" }],
  });
  await router.handle("wx:user", "/ssn");
  const reply = await router.handle("wx:user", "/ssn 1");

  expect(reply.text).toContain(t().nativeSession.alreadySwitched("Codex", "codex-thread-1"));
  expect((transport.resumeAgentSession as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
});

test("/ssn 1 switch response renders display alias for scoped channels", async () => {
  const { router, transport, config } = buildRouter();
  config.workspaces.project = { cwd: "/tmp/project" };
  (transport.listAgentSessions as ReturnType<typeof mock>).mockResolvedValueOnce({
    source: "agent",
    sessions: [{ sessionId: "thread-1", cwd: "/tmp/project", title: "Fix CI" }],
  });

  await router.handle("feishu:default:oc_chat", "/ssn codex --ws project");
  (transport.listAgentSessions as ReturnType<typeof mock>).mockResolvedValueOnce({
    source: "agent",
    sessions: [{ sessionId: "thread-1", cwd: "/tmp/project", title: "Fix CI" }],
  });
  await router.handle("feishu:default:oc_chat", "/ssn");
  const reply = await router.handle("feishu:default:oc_chat", "/ssn 1");

  expect(reply.text).toContain(t().nativeSession.alreadySwitched("Codex", "codex-thread-1"));
  expect(reply.text).not.toContain("feishu:codex-thread-1");
  expect((transport.resumeAgentSession as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
});


test("/ssn reports unsupported native listing when transport returns undefined", async () => {
  const { router, transport, config } = buildRouter();
  config.workspaces.project = { cwd: "/tmp/project" };
  (transport.listAgentSessions as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);

  const reply = await router.handle("wx:user", "/ssn codex --ws project");

  expect(reply.text).toContain(t().nativeSession.transportNotSupported);

});

test("/ssn renders friendly messages for native list and resume failures", async () => {
  const { router, transport, config } = buildRouter();
  config.workspaces.project = { cwd: "/tmp/project" };
  (transport.listAgentSessions as ReturnType<typeof mock>).mockRejectedValueOnce(new Error("list unsupported"));

  const listReply = await router.handle("wx:user", "/ssn codex --ws project");

  expect(listReply.text).toContain(t().nativeSession.listError("Codex", "list unsupported"));
  expect(listReply.text).toContain(t().nativeSession.listErrorHint);

  (transport.listAgentSessions as ReturnType<typeof mock>).mockResolvedValueOnce({
    source: "agent",
    sessions: [{ sessionId: "thread-1", cwd: "/tmp/project", title: "Fix CI" }],
  });
  (transport.resumeAgentSession as ReturnType<typeof mock>).mockRejectedValueOnce(new Error("resume unsupported"));

  const resumeReply = await router.handle("wx:user", "/ssn codex --ws project");

  expect(resumeReply.text).toContain(t().nativeSession.resumeError("Codex", "resume unsupported"));
  expect(resumeReply.text).toContain(t().nativeSession.resumeErrorHint);
});

test("/ssn clears stale cached native sessions after an empty list response", async () => {
  const { router, transport, config } = buildRouter();
  config.workspaces.project = { cwd: "/tmp/project" };
  (transport.listAgentSessions as ReturnType<typeof mock>).mockResolvedValueOnce({
    source: "agent",
    sessions: [
      { sessionId: "thread-1", cwd: "/tmp/project", title: "Fix CI" },
      { sessionId: "thread-2", cwd: "/tmp/project", title: "Refactor" },
    ],
  });
  (transport.listAgentSessions as ReturnType<typeof mock>).mockResolvedValueOnce({
    source: "agent",
    sessions: [],
  });

  const firstReply = await router.handle("wx:user", "/ssn codex --ws project");
  const emptyReply = await router.handle("wx:user", "/ssn codex --ws project");
  const selectReply = await router.handle("wx:user", "/ssn 1");

  expect(firstReply.text).toContain("【1】 Fix CI");
  expect(emptyReply.text).toContain(t().nativeSession.noSessionsFound("Codex", "project"));
  expect(selectReply.text).toContain(t().nativeSession.noCachedList);
  expect(transport.resumeAgentSession).not.toHaveBeenCalled();
});

function buildSwitchRouter() {
  const config = createConfig();
  config.agents.claude = config.agents.claude ?? { driver: "claude" };
  config.workspaces.frontend = { cwd: "/tmp/frontend" };
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));
  return { router, sessions };
}

test("/use <fragment>: unique match switches and echoes identity", async () => {
  const { router, sessions } = buildSwitchRouter();
  await sessions.createSession("api-review", "codex", "backend");
  await sessions.createSession("frontend-fix", "claude", "frontend");
  await sessions.useSession("wx:user", "api-review");

  const res = await router.handle("wx:user", "/use front");

  expect(res.text).toContain(t().session.switchedWithPrev("frontend-fix", "claude", "frontend", "api-review"));
});

test("/use <fragment>: ambiguous lists candidates without switching", async () => {
  const { router, sessions } = buildSwitchRouter();
  await sessions.createSession("api-review", "codex", "backend");
  await sessions.createSession("api-smoke", "claude", "backend");
  await sessions.useSession("wx:user", "api-review");

  const res = await router.handle("wx:user", "/use api");

  expect(res.text).toContain(t().session.ambiguousSession("api"));
  expect(res.text).toContain("api-review");
  expect(res.text).toContain("api-smoke");
  // current session unchanged
  expect((await sessions.getCurrentSession("wx:user"))?.alias).toBe("api-review");
});

test("/use <fragment>: no match guides to /sessions", async () => {
  const { router, sessions } = buildSwitchRouter();
  await sessions.createSession("api-review", "codex", "backend");
  await sessions.useSession("wx:user", "api-review");

  const res = await router.handle("wx:user", "/use zzz");

  expect(res.text).toContain(t().session.noMatchingSession("zzz"));
});

test("/use -: switches back to previous with identity echo", async () => {
  const { router, sessions } = buildSwitchRouter();
  await sessions.createSession("api-review", "codex", "backend");
  await sessions.createSession("frontend-fix", "claude", "frontend");
  await sessions.useSession("wx:user", "api-review");
  await sessions.useSession("wx:user", "frontend-fix");

  const res = await router.handle("wx:user", "/use -");

  expect(res.text).toContain(t().session.switched("api-review", "codex", "backend"));
  expect((await sessions.getCurrentSession("wx:user"))?.alias).toBe("api-review");
});

test("/use -: friendly message when there is no previous", async () => {
  const { router, sessions } = buildSwitchRouter();
  await sessions.createSession("api-review", "codex", "backend");
  await sessions.useSession("wx:nobody", "api-review");

  const res = await router.handle("wx:nobody", "/use -");

  expect(res.text).toContain(t().session.noPreviousSession);
});

// --- native-session control surface (web add-session "attach native session") ---

test("listNativeSessionsForControl queries the transport filtered to the workspace cwd", async () => {
  const { router, transport } = buildRouter();
  (transport.listAgentSessions as ReturnType<typeof mock>).mockImplementationOnce(async () => ({
    source: "agent" as const,
    sessions: [{ sessionId: "ses_1", title: "Old work", updatedAt: "2026-06-10T00:00:00Z", cwd: "/tmp/backend" }],
  }));

  const result = await router.listNativeSessionsForControl("codex", "backend");

  expect(result).toEqual([{ sessionId: "ses_1", title: "Old work", updatedAt: "2026-06-10T00:00:00Z", cwd: "/tmp/backend" }]);
  const query = (transport.listAgentSessions as ReturnType<typeof mock>).mock.calls.at(-1)?.[0];
  expect(query).toMatchObject({ agent: "codex", cwd: "/tmp/backend", filterCwd: "/tmp/backend" });
});

test("listNativeSessionsForControl rejects an unknown agent or workspace", async () => {
  const { router } = buildRouter();
  await expect(router.listNativeSessionsForControl("nope", "backend")).rejects.toThrow(/unknown agent/);
});

test("attachNativeSessionWithTransport resumes the agent session and records a native binding", async () => {
  const { router, transport, sessions } = buildRouter();

  const session = await router.attachNativeSessionWithTransport(
    "relay:resumed", "codex", "backend", "ses_42",
    { title: "Resumed", updatedAt: "2026-06-12T00:00:00Z" },
  );

  expect(session.alias).toBe("relay:resumed");
  // Resumed via the native --resume-session path, never a fresh ensureSession.
  expect((transport.resumeAgentSession as ReturnType<typeof mock>).mock.calls.at(-1)?.[1]).toBe("ses_42");
  expect((transport.ensureSession as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  // Persisted as an agent-side (native) session carrying the agent_session_id.
  const stored = await sessions.getSession("relay:resumed");
  expect(stored?.source).toBe("agent-side");
  expect(stored?.agentSessionId).toBe("ses_42");
  expect(session.agentArgv?.[1]).toContain("acp-output-guard-main.");
  expect(stored?.agentArgv).toEqual(session.agentArgv);
});

test("attachNativeSessionWithTransport auto-derives a free alias when the desired alias collides", async () => {
  const { router } = buildRouter();
  await router.attachNativeSessionWithTransport("relay:dup", "codex", "backend", "ses_1");
  // A colliding alias should NOT fail — the backend derives `relay:dup-2`.
  const result = await router.attachNativeSessionWithTransport("relay:dup", "codex", "backend", "ses_2");
  expect(result.alias).toBe("relay:dup-2");
});

test("failed create converges the provisional physical session before dropping the row", async () => {
  const { router, transport, sessions } = buildRouter();
  const order: string[] = [];
  (transport.ensureSession as ReturnType<typeof mock>).mockImplementationOnce(async () => {
    throw new Error("bridge ensure boom");
  });
  (transport.deleteSession as ReturnType<typeof mock>).mockImplementation(async () => {
    order.push("delete");
  });
  const origRemove = sessions.removeSession.bind(sessions);
  sessions.removeSession = (async (alias: string) => {
    order.push("remove");
    return origRemove(alias);
  }) as typeof sessions.removeSession;
  await expect(router.handle("wx:user", "/session new provisional --agent codex --ws backend")).rejects.toThrow(
    /bridge ensure boom/,
  );
  // Physical cleanup verified first, logical row dropped after.
  expect(order).toEqual(["delete", "remove"]);
  expect(sessions.getResolvedSessionByInternalAlias("provisional")).toBeNull();
});

test("failed create keeps the row when provisional cleanup cannot be verified", async () => {
  const { router, transport, sessions } = buildRouter();
  (transport.ensureSession as ReturnType<typeof mock>).mockImplementationOnce(async () => {
    throw new Error("bridge ensure boom");
  });
  (transport.deleteSession as ReturnType<typeof mock>).mockImplementationOnce(async () => {
    throw new Error("cleanup delete boom");
  });

  await expect(router.handle("wx:user", "/session new provisional --agent codex --ws backend")).rejects.toThrow(
    /kept for retry\/delete/,
  );
  expect(sessions.getResolvedSessionByInternalAlias("provisional")).not.toBeNull();
});

test("control create keeps the row when provisional cleanup cannot be verified", async () => {
  const { router, transport, sessions, config } = buildRouter();
  config.workspaces.home = { cwd: "/tmp/home" };
  (transport.ensureSession as ReturnType<typeof mock>).mockImplementationOnce(async () => {
    throw new Error("bridge ensure boom");
  });
  (transport.deleteSession as ReturnType<typeof mock>).mockImplementationOnce(async () => {
    throw new Error("cleanup delete boom");
  });

  await expect(router.createSessionWithTransport("relay:demo", "codex", "home")).rejects.toThrow(
    /kept for retry\/delete/,
  );
  expect(await sessions.getSession("relay:demo")).not.toBeNull();
});

test("failed native attach converges softly and never hard-deletes the upstream thread", async () => {
  const { router, transport, sessions } = buildRouter();
  (transport.resumeAgentSession as ReturnType<typeof mock>).mockImplementationOnce(async () => {
    throw new Error("bridge resume boom");
  });

  await expect(
    router.attachNativeSessionWithTransport("relay:doomed", "codex", "backend", "ses_99"),
  ).rejects.toThrow("bridge resume boom");
  // Logical row dropped after convergence, upstream thread untouched.
  expect(await sessions.getSession("relay:doomed")).toBeNull();
  expect((transport.deleteSession as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  expect((transport.removeSession as ReturnType<typeof mock>).mock.calls.length).toBe(1);
});

test("workspace rm refuses while persisted sessions still use it", async () => {
  const { router, sessions } = buildRouter();
  await router.handle("wx:user", "/session new guarded --agent codex --ws backend");
  expect(await sessions.getSession("guarded")).not.toBeNull();

  const reply = await router.handle("wx:user", "/workspace rm backend");
  expect(reply.text).toContain("仍被");
  expect(reply.text).toContain("guarded");
  // Guarded: config untouched.
  await router.handle("wx:user", "/session rm guarded");
  const freed = await router.handle("wx:user", "/workspace rm backend");
  expect(freed.text).not.toContain("仍被");
});

test("agent rm refuses while persisted sessions still use it", async () => {
  const { router, sessions } = buildRouter();
  await router.handle("wx:user", "/session new guarded --agent codex --ws backend");
  expect(await sessions.getSession("guarded")).not.toBeNull();

  const reply = await router.handle("wx:user", "/agent rm codex");
  expect(reply.text).toContain("仍被");
  expect(reply.text).toContain("guarded");
  await router.handle("wx:user", "/session rm guarded");
  const freed = await router.handle("wx:user", "/agent rm codex");
  expect(freed.text).not.toContain("仍被");
});

test("attach preflight inherits the physical group's CLI engine instead of config runtime", async () => {
  const { router, transport, sessions, config } = buildRouter();
  await router.handle("wx:user", "/session new seed --agent codex --ws backend");
  const seed = await sessions.getSession("seed");
  expect(seed?.transportEngine).toBe("cli");
  // Flip the default AFTER the physical session exists: attaching a second
  // alias must inherit the group's CLI engine — including for the
  // preflight existence check, which routes by engine.
  config.transport.engine = "runtime";
  const reply = await router.handle(
    "wx:user",
    `/session attach clone --agent codex --ws backend --name ${seed!.transportSession}`,
  );
  expect(reply.text).toBe(t().session.sessionAttached("clone"));
  const hasSessionMock = transport.hasSession as ReturnType<typeof mock>;
  const attachCheck = hasSessionMock.mock.calls[hasSessionMock.mock.calls.length - 1]?.[0] as {
    transportEngine?: string;
  };
  expect(attachCheck.transportEngine).toBe("cli");
  expect((await sessions.getSession("clone"))?.transportEngine).toBe("cli");
});
