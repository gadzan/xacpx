import { expect, test, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CommandRouter } from "../../../src/commands/command-router";
import { listAgentTemplates } from "../../../src/config/agent-templates";
import { normalizeWorkspacePath } from "../../../src/commands/workspace-path";
import { setLocale, t } from "../../../src/i18n";
import {
  MemoryConfigStore,
  MemoryStateStore,
  SessionService,
  createConfig,
  createEmptyState,
  createTransport,
  getUpdatePermissionPolicyMock,
} from "./command-router-test-support";

beforeEach(() => {
  setLocale("zh");
});

test("returns help text", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  const reply = await router.handle("wx:user", "/help");

  expect(reply.text).toContain("常用入口：");
  expect(reply.text).toContain("/ssn <agent>");
  expect(reply.text).toContain("顶级命令：");
  expect(reply.text).toContain("- session -");
  expect(reply.text).toContain("- native -");
  expect(reply.text).toContain("/help <topic>");
});

test("returns topic help for session aliases", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  const byAlias = await router.handle("wx:user", "/help ss");
  const byTopic = await router.handle("wx:user", "/help session");

  expect(byAlias.text).toBe(byTopic.text);
  expect(byAlias.text).toContain("帮助主题：session");
  expect(byAlias.text).toContain("/ss <agent> (-d <path> | --ws <name>)");
});

test("returns topic help for permission aliases", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  const reply = await router.handle("wx:user", "/help pm");

  expect(reply.text).toContain("帮助主题：permission");
  expect(reply.text).toContain("/pm set <allow|read|deny>");
});

test("returns topic help for native session aliases", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  const byAlias = await router.handle("wx:user", "/help ssn");
  const byTopic = await router.handle("wx:user", "/help native");

  expect(byAlias.text).toBe(byTopic.text);
  expect(byAlias.text).toContain("帮助主题：native");
  expect(byAlias.text).toContain("/ssn <agent> --ws <workspace>");
  expect(byAlias.text).toContain("docs/native-sessions.md");
});

test("returns topic help for orchestration aliases", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  const byAlias = await router.handle("wx:user", "/help delegate");
  const byShortAlias = await router.handle("wx:user", "/help dg");
  const byTaskAlias = await router.handle("wx:user", "/help task");
  const byGroupAlias = await router.handle("wx:user", "/help group");
  const byGroupsAlias = await router.handle("wx:user", "/help groups");
  const byTopic = await router.handle("wx:user", "/help orchestration");

  expect(byAlias.text).toBe(byTopic.text);
  expect(byShortAlias.text).toBe(byTopic.text);
  expect(byTaskAlias.text).toBe(byTopic.text);
  expect(byGroupAlias.text).toBe(byTopic.text);
  expect(byGroupsAlias.text).toBe(byTopic.text);
  expect(byTopic.text).toContain("帮助主题：orchestration");
  expect(byTopic.text).toContain("别名：delegate、dg、task、tasks、group、groups");
  expect(byTopic.text).toContain("/delegate <agent> <task>");
  expect(byTopic.text).toContain("/group new <title>");
  expect(byTopic.text).toContain("/group add <groupId> <agent> <task>");
  expect(byTopic.text).toContain("/group cancel <groupId>");
  expect(byTopic.text).toContain("/dg claude 审查当前方案的 3 个最高风险点");
  expect(byTopic.text).toContain("/task approve <id>");
});

test("returns a hint for unknown help topics", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport);

  const reply = await router.handle("wx:user", "/help missing");

  expect(reply.text).toContain("未知帮助主题：missing");
  expect(reply.text).toContain("可用主题：");
  expect(reply.text).toContain("- session");
  expect(reply.text).toContain("- orchestration");
});

test("renders the current permission mode", async () => {
  const config = createConfig();
  config.transport.permissionMode = "approve-reads";
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const reply = await router.handle("wx:user", "/pm");

  expect(reply.text).toBe([t().permission.statusTitleCurrent, "- mode: approve-reads", "- auto: deny"].join("\n"));
});

test("renders the current non-interactive policy", async () => {
  const config = createConfig();
  config.transport.nonInteractivePermissions = "deny";
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const reply = await router.handle("wx:user", "/pm auto");

  expect(reply.text).toBe([t().permission.statusTitleAutoStatus, "- mode: approve-all", "- auto: deny"].join("\n"));
});

test("updates the permission mode", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const reply = await router.handle("wx:user", "/pm set read");

  expect(reply.text).toBe([t().permission.statusTitleModeUpdated, "- mode: approve-reads", "- auto: deny"].join("\n"));
  expect(config.transport.permissionMode).toBe("approve-reads");
});

test("updates the non-interactive permission policy", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const reply = await router.handle("wx:user", "/pm auto deny");

  expect(reply.text).toBe([t().permission.statusTitleAutoUpdated, "- mode: approve-all", "- auto: deny"].join("\n"));
  expect(config.transport.nonInteractivePermissions).toBe("deny");
});

test("refuses permission writes when writable config is unavailable", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config);

  const modeReply = await router.handle("wx:user", "/pm set deny");
  const autoReply = await router.handle("wx:user", "/pm auto deny");

  expect(modeReply.text).toBe(t().permission.noWritableConfig);
  expect(autoReply.text).toBe(t().permission.noWritableConfig);
});

test("shows supported config paths", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const reply = await router.handle("wx:user", "/config");

  expect(reply.text).toContain(t().config.showSupportedHeader);
  expect(reply.text).toContain("- transport.permissionMode");
  expect(reply.text).toContain("- transport.permissionPolicy");
  expect(reply.text).toContain("- agents.<name>.driver");
  expect(reply.text).toContain("- workspaces.<name>.description");
});

test("updates a fixed config path through /config set", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const reply = await router.handle("wx:user", "/config set logging.level debug");

  expect(reply.text).toBe(t().config.updated("logging.level", "debug"));
  expect(config.logging.level).toBe("debug");
});

test("updates an existing dynamic config path through /config set", async () => {
  const config = createConfig();
  config.workspaces.backend.description = "old";
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const reply = await router.handle("wx:user", '/config set workspaces.backend.description "backend repo"');

  expect(reply.text).toBe(t().config.updated("workspaces.backend.description", "backend repo"));
  expect(config.workspaces.backend.description).toBe("backend repo");
});

test("rejects unsupported config paths", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const reply = await router.handle("wx:user", "/config set transport.missing value");

  expect(reply.text).toBe(t().config.pathNotSupported("transport.missing"));
});

test("rejects config set when the target dynamic entry does not exist", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const agentReply = await router.handle("wx:user", "/config set agents.claude.driver claude");
  const workspaceReply = await router.handle("wx:user", "/config set workspaces.frontend.cwd /tmp/frontend");

  expect(agentReply.text).toBe(t().config.agentNotFound("claude"));
  expect(workspaceReply.text).toBe(t().config.workspaceNotFound("frontend"));
});

test("rejects config set with invalid typed values", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const modeReply = await router.handle("wx:user", "/config set wechat.replyMode maybe");
  const numberReply = await router.handle("wx:user", "/config set logging.maxFiles 0");

  expect(modeReply.text).toBe(t().config.wechatReplyModeInvalid);
  expect(numberReply.text).toBe(t().config.mustBePositiveNumber("logging.maxFiles"));
});

test("updates channel reply mode through /config set", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const response = await router.handle("wx:user", "/config set channel.replyMode final");

  expect(response.text).toBe(t().config.updated("channel.replyMode", "final"));
  expect(config.channel.replyMode).toBe("final");
});

test("rejects channel type updates through /config set", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const response = await router.handle("wx:user", "/config set channel.type weixin");

  expect(response.text).toBe(t().config.channelTypeDisabled);
  expect(config.channel.type).toBe("weixin");
});

test("does not report success for ineffective channel type changes", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const response = await router.handle("wx:user", "/config set channel.type feishu");

  expect(response.text).toBe(t().config.channelTypeDisabled);
  expect(config.channel.type).toBe("weixin");
  expect(config.channels).toEqual([{ id: "weixin", type: "weixin", enabled: true }]);
});

test("maps legacy wechat reply mode config command to channel reply mode", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const response = await router.handle("wx:user", "/config set wechat.replyMode stream");

  expect(response.text).toBe(t().config.updated("wechat.replyMode", t().config.wechatReplyModeMapped("stream")));
  expect(config.channel.replyMode).toBe("stream");
});

test("shows channel config paths and legacy compatibility paths", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const response = await router.handle("wx:user", "/config");

  expect(response.text).toContain("- channel.replyMode");
  expect(response.text).toContain(t().config.showLegacyHeader);
  expect(response.text).toContain(`- ${t().config.legacyWechatReplyMode}`);
  expect(response.text).toContain(`- ${t().config.legacyChannelType}`);
  expect(response.text).toContain(`- ${t().config.legacyChannels}`);
});

test("refuses config writes when writable config is unavailable", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config);

  const reply = await router.handle("wx:user", "/config set logging.level debug");

  expect(reply.text).toBe(t().config.noWritableConfig);
});

test("renders agents in Chinese", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, createConfig());

  const reply = await router.handle("wx:user", "/agents");

  expect(reply.text).toBe(["已注册的 Agent：", "- codex"].join("\n"));
});

test("adds a claude agent from the built-in template and reflects it in /agents", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const addReply = await router.handle("wx:user", "/agent add claude");
  const listReply = await router.handle("wx:user", "/agents");

  expect(addReply.text).toBe(t().agent.saved("claude"));
  expect(config.agents.claude).toEqual({ driver: "claude" });
  expect(listReply.text).toBe(["已注册的 Agent：", "- codex", "- claude"].join("\n"));
});

test("adds a codex agent from the built-in template", async () => {
  const config = createConfig();
  delete config.agents.codex;
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const reply = await router.handle("wx:user", "/agent add codex");

  expect(reply.text).toBe(t().agent.saved("codex"));
  expect(config.agents.codex).toEqual({
    driver: "codex",
  });
});

test("adds an acpx built-in agent from the built-in template", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const reply = await router.handle("wx:user", "/agent add kimi");

  expect(reply.text).toBe(t().agent.saved("kimi"));
  expect(config.agents.kimi).toEqual({
    driver: "kimi",
  });
});

test("/agent add is idempotent and refuses to overwrite a different existing config", async () => {
  const config = createConfig();
  config.agents.qwen = { driver: "qwen", command: "custom-qwen" };
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const existingReply = await router.handle("wx:user", "/agent add codex");
  const customReply = await router.handle("wx:user", "/agent add qwen");

  expect(existingReply.text).toBe(t().agent.alreadyExists("codex"));
  expect(customReply.text).toBe(t().agent.alreadyExistsDifferent("qwen"));
  expect(config.agents.qwen).toEqual({ driver: "qwen", command: "custom-qwen" });
});

test("returns a hint for unknown agent templates", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const reply = await router.handle("wx:user", "/agent add unknown");

  expect(reply.text).toBe(t().agent.unsupportedTemplate(listAgentTemplates().join("、")));
});

test("removes an agent and reflects it in /agents", async () => {
  const config = createConfig();
  config.agents.claude = { driver: "claude" };
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const removeReply = await router.handle("wx:user", "/agent rm claude");
  const listReply = await router.handle("wx:user", "/agents");

  expect(removeReply.text).toBe(t().agent.removed("claude"));
  expect(config.agents).toEqual({
    codex: { driver: "codex" },
  });
  expect(listReply.text).toBe(["已注册的 Agent：", "- codex"].join("\n"));
});

test("returns a hint when removing an unknown agent", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const reply = await router.handle("wx:user", "/agent rm missing");

  expect(reply.text).toBe(t().agent.notFound);
});

test("renders workspaces in Chinese", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, createConfig());

  const reply = await router.handle("wx:user", "/workspaces");

  expect(reply.text).toBe(["已注册的工作区：", "- backend: /tmp/backend"].join("\n"));
});

test("lists workspaces for bare workspace commands and aliases", async () => {
  const sessions = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, createConfig());

  const bareReply = await router.handle("wx:user", "/workspace");
  const aliasReply = await router.handle("wx:user", "/ws");

  expect(bareReply.text).toBe(["已注册的工作区：", "- backend: /tmp/backend"].join("\n"));
  expect(aliasReply.text).toBe(["已注册的工作区：", "- backend: /tmp/backend"].join("\n"));
});

test("creates a workspace via command and lists it immediately", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-workspace-"));
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const createReply = await router.handle("wx:user", `/workspace new frontend --cwd "${dir}"`);
  const listReply = await router.handle("wx:user", "/workspaces");

  expect(createReply.text).toBe(t().workspace.saved("frontend"));
  expect(listReply.text).toBe(
    ["已注册的工作区：", "- backend: /tmp/backend", `- frontend: ${normalizeWorkspacePath(dir)}`].join("\n"),
  );

  await rm(dir, { recursive: true, force: true });
});

test("creates a workspace via the short alias and cwd flag", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-workspace-"));
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const reply = await router.handle("wx:user", `/ws new frontend -d "${dir}"`);

  expect(reply.text).toBe(t().workspace.saved("frontend"));
  expect(config.workspaces.frontend).toEqual({ cwd: normalizeWorkspacePath(dir) });

  await rm(dir, { recursive: true, force: true });
});

test("/ws new stores a ~ cwd verbatim (expansion happens at config load, not at write)", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const reply = await router.handle("wx:user", '/ws new notes -d "~"');

  expect(reply.text).toBe(t().workspace.saved("notes"));
  // The configured value keeps the user's literal `~` so the file stays portable.
  expect(config.workspaces.notes).toEqual({ cwd: "~" });
});

test("/ws new sanitizes a name with spaces and reports the rewrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-workspace-"));
  try {
    const config = createConfig();
    const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
    const transport = createTransport();
    const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

    const reply = await router.handle("wx:user", `/ws new "My Repo" -d "${dir}"`);

    expect(reply.text).toBe(
      t().workspace.nameSanitized("My Repo", "My-Repo") + "\n" + t().workspace.saved("My-Repo"),
    );
    expect(config.workspaces["My-Repo"]).toEqual({ cwd: normalizeWorkspacePath(dir) });
    expect(config.workspaces["My Repo"]).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/ws new rejects a name with no letters or digits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-workspace-"));
  try {
    const config = createConfig();
    const before = structuredClone(config.workspaces);
    const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
    const transport = createTransport();
    const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

    const reply = await router.handle("wx:user", `/ws new "!!!" -d "${dir}"`);

    expect(reply.text).toBe(t().workspace.nameUnderivable("!!!"));
    expect(config.workspaces).toEqual(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/ws new --raw keeps a name with spaces", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-workspace-"));
  try {
    const config = createConfig();
    const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
    const transport = createTransport();
    const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

    const reply = await router.handle("wx:user", `/ws new "My Repo" -d "${dir}" --raw`);

    expect(reply.text).toBe(t().workspace.saved("My Repo"));
    expect(config.workspaces["My Repo"]).toEqual({ cwd: normalizeWorkspacePath(dir) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects creating a workspace when cwd does not exist", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const reply = await router.handle("wx:user", '/ws new missing -d "E:\\definitely-missing\\repo"');

  expect(reply.text).toBe(t().workspace.pathNotFound("E:\\definitely-missing\\repo"));
  expect(config.workspaces.missing).toBeUndefined();
});

test("removes a workspace via command", async () => {
  const config = createConfig();
  config.workspaces.frontend = { cwd: "/tmp/frontend" };
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const reply = await router.handle("wx:user", "/workspace rm frontend");

  expect(reply.text).toBe(t().workspace.removed("frontend"));
  expect(config.workspaces).toEqual({
    backend: { cwd: "/tmp/backend" },
  });
});


test("updates the live transport policy after /pm auto", async () => {
  const config = createConfig();
  const transport = createTransport();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  await router.handle("wx:user", "/pm auto deny");

  expect(getUpdatePermissionPolicyMock(transport)).toHaveBeenCalledWith(expect.objectContaining({
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
  }));
});

test("updates the live transport policy after /config set transport.permissionMode", async () => {
  const config = createConfig();
  const transport = createTransport();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  await router.handle("wx:user", "/config set transport.permissionMode approve-reads");

  expect(getUpdatePermissionPolicyMock(transport)).toHaveBeenCalledWith(expect.objectContaining({
    permissionMode: "approve-reads",
    nonInteractivePermissions: "deny",
  }));
});

test("updates the live transport policy after /config set transport.permissionPolicy", async () => {
  const config = createConfig();
  const transport = createTransport();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  await router.handle("wx:user", "/config set transport.permissionPolicy C:/policies/weacpx-policy.json");

  expect(getUpdatePermissionPolicyMock(transport)).toHaveBeenCalledWith(expect.objectContaining({
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    permissionPolicy: "C:/policies/weacpx-policy.json",
  }));
});


test("updates the live transport policy after /pm set", async () => {
  const config = createConfig();
  const transport = createTransport();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  await router.handle("wx:user", "/pm set read");

  expect(getUpdatePermissionPolicyMock(transport)).toHaveBeenCalledWith(expect.objectContaining({
    permissionMode: "approve-reads",
    nonInteractivePermissions: "deny",
  }));
});

test("blocks mutating commands from non-owner group members", async () => {
  const config = createConfig();
  const transport = createTransport();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const reply = await router.handle(
    "yuanbao:default:group:g1",
    "/pm set read",
    undefined,
    undefined,
    "default",
    undefined,
    { channel: "yuanbao", chatType: "group", senderId: "u1", groupId: "g1", isOwner: false },
  );

  expect(reply.text).toContain("仅限群创建者/频道 owner 使用");
  expect(getUpdatePermissionPolicyMock(transport)).not.toHaveBeenCalled();
});

test("allows mutating commands from group owner", async () => {
  const config = createConfig();
  const transport = createTransport();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  await router.handle(
    "yuanbao:default:group:g1",
    "/pm set read",
    undefined,
    undefined,
    "default",
    undefined,
    { channel: "yuanbao", chatType: "group", senderId: "u1", groupId: "g1", isOwner: true },
  );

  expect(getUpdatePermissionPolicyMock(transport)).toHaveBeenCalledWith(expect.objectContaining({
    permissionMode: "approve-reads",
    nonInteractivePermissions: "deny",
  }));
});

test("updates the live transport policy after /config set transport.nonInteractivePermissions", async () => {
  const config = createConfig();
  const transport = createTransport();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  await router.handle("wx:user", "/config set transport.nonInteractivePermissions deny");

  expect(getUpdatePermissionPolicyMock(transport)).toHaveBeenCalledWith(expect.objectContaining({
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
  }));
});

test("rolls back /pm auto config when live transport update fails", async () => {
  const config = createConfig();
  const transport = createTransport();
  getUpdatePermissionPolicyMock(transport).mockImplementation(async () => {
    throw new Error("bridge write failed");
  });
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  await expect(router.handle("wx:user", "/pm auto deny")).rejects.toThrow("bridge write failed");

  expect(config.transport).toMatchObject({
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
  });
});

test("rolls back /config set transport.permissionMode when live transport update fails", async () => {
  const config = createConfig();
  const transport = createTransport();
  getUpdatePermissionPolicyMock(transport).mockImplementation(async () => {
    throw new Error("bridge write failed");
  });
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  await expect(router.handle("wx:user", "/config set transport.permissionMode approve-reads")).rejects.toThrow("bridge write failed");

  expect(config.transport).toMatchObject({
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
  });
});

test("sets language to a valid locale via /config set language", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const reply = await router.handle("wx:user", "/config set language zh");

  expect(reply.text).toBe(t().config.updated("language", "zh"));
  expect(config.language).toBe("zh");
});

test("rejects an unsupported locale via /config set language", async () => {
  const config = createConfig();
  const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const transport = createTransport();
  const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

  const reply = await router.handle("wx:user", "/config set language fr");

  expect(reply.text).toBe(t().config.languageInvalid);
  expect(config.language).toBeUndefined();
});

test("/config set rejects prototype-polluting agent/workspace names without polluting Object.prototype", async () => {
  for (const path of [
    "agents.__proto__.driver",
    "agents.constructor.driver",
    "workspaces.__proto__.cwd",
    "workspaces.prototype.cwd",
  ]) {
    const config = createConfig();
    const sessions = new SessionService(config, new MemoryStateStore(), createEmptyState());
    const transport = createTransport();
    const router = new CommandRouter(sessions, transport, config, new MemoryConfigStore(config));

    const reply = await router.handle("wx:user", `/config set ${path} EVIL`);

    // Rejected with an error, never "Config updated".
    expect(reply.text).not.toBe(t().config.updated(path, "EVIL"));
    expect(reply.text).toBe(t().config.pathNotSupported(path));
  }

  // The live daemon's Object.prototype must remain clean.
  expect(({} as Record<string, unknown>).driver).toBeUndefined();
  expect(({} as Record<string, unknown>).cwd).toBeUndefined();
});
