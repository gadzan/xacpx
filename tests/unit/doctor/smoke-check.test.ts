import { expect, test } from "bun:test";

import { checkSmoke } from "../../../src/doctor/checks/smoke-check";
import type { AppConfig } from "../../../src/config/types";
import type { ResolvedSession, SessionTransport } from "../../../src/transport/types";

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    transport: {
      type: "acpx-cli",
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
      ...(overrides.transport ?? {}),
    },
    logging: {
      level: "info",
      maxSizeBytes: 1,
      maxFiles: 1,
      retentionDays: 1,
      ...(overrides.logging ?? {}),
    },
    channel: {
      type: "weixin",
      replyMode: "stream",
      ...(overrides.channel ?? {}),
    },
    channels: overrides.channels ?? [{ id: "weixin", type: "weixin", enabled: true }],
    agents: overrides.agents ?? {
      codex: { driver: "codex" },
      claude: { driver: "claude" },
    },
    workspaces: overrides.workspaces ?? {
      backend: { cwd: "/repo/backend" },
      frontend: { cwd: "/repo/frontend" },
    },
    orchestration: overrides.orchestration ?? {
      maxPendingAgentRequestsPerCoordinator: 3,
      allowWorkerChainedRequests: false,
      allowedAgentRequestTargets: [],
      allowedAgentRequestRoles: [],
    },
  };
}

function createRecordingTransport(replyText = "ok"): SessionTransport & { session?: ResolvedSession; promptText?: string } {
  return {
    session: undefined,
    promptText: undefined,
    async ensureSession(session) {
      this.session = session;
    },
    async prompt(session, text) {
      this.session = session;
      this.promptText = text;
      return { text: replyText };
    },
    async setMode() {},
    async cancel() {
      return { cancelled: true, message: "cancelled" };
    },
    async hasSession() {
      return false;
    },
  };
}

test("smoke check uses explicit --agent and --workspace selection", async () => {
  const transport = createRecordingTransport();

  const result = await checkSmoke(
    { smoke: true, agent: "claude", workspace: "frontend", verbose: true },
    {
      now: () => new Date("2026-04-07T12:34:56.000Z"),
      loadConfig: async () => createConfig(),
      createTransport: async () => transport,
    },
  );

  expect(result.severity).toBe("pass");
  expect(transport.session).toMatchObject({
    alias: "xacpx-doctor",
    agent: "claude",
    workspace: "frontend",
    cwd: "/repo/frontend",
    transportSession: "xacpx-doctor-1775565296000",
  });
  expect(result.details ?? []).toContain("agent: claude (explicit --agent)");
  expect(result.details ?? []).toContain("workspace: frontend (explicit --workspace)");
});

test("smoke check uses the selected agent's configured default model", async () => {
  const transport = createRecordingTransport();

  const result = await checkSmoke(
    { smoke: true, agent: "claude", workspace: "frontend", verbose: true },
    {
      loadConfig: async () => createConfig({
        agents: {
          codex: { driver: "codex" },
          claude: { driver: "claude", model: "provider/default-model" },
        },
      }),
      createTransport: async () => transport,
    },
  );

  expect(result.severity).toBe("pass");
  expect(transport.session?.model).toBe("provider/default-model");
  expect(result.details ?? []).toContain("model: provider/default-model (agent default)");
});

test("smoke check carries the Claude settings policy to the real transport seam", async () => {
  const transport = createRecordingTransport();
  await checkSmoke(
    { smoke: true, agent: "claude" },
    {
      loadConfig: async () => createConfig({
        agents: {
          claude: { driver: "claude", settingsPolicy: "isolated" },
        },
      }),
      createTransport: async () => transport,
    },
  );

  expect(transport.session).toEqual(expect.objectContaining({
    driver: "claude",
    settingsPolicy: "isolated",
  }));
});

test("smoke check fails when explicit agent or workspace is missing", async () => {
  const missingAgent = await checkSmoke(
    { smoke: true, agent: "missing" },
    {
      loadConfig: async () => createConfig(),
      createTransport: async () => createRecordingTransport(),
    },
  );
  const missingWorkspace = await checkSmoke(
    { smoke: true, workspace: "missing" },
    {
      loadConfig: async () => createConfig(),
      createTransport: async () => createRecordingTransport(),
    },
  );

  expect(missingAgent.severity).toBe("fail");
  expect(missingAgent.summary).toContain("agent");
  expect(missingWorkspace.severity).toBe("fail");
  expect(missingWorkspace.summary).toContain("workspace");
});

test("smoke check skips when no default candidates are available", async () => {
  const result = await checkSmoke(
    { smoke: true },
    {
      loadConfig: async () =>
        createConfig({
          agents: {},
          workspaces: {},
        }),
      createTransport: async () => createRecordingTransport(),
    },
  );

  expect(["skip", "warn"]).toContain(result.severity);
  expect(result.summary).toContain("agent");
  expect(result.summary).toContain("workspace");
});

test("smoke check uses first configured agent and workspace in declaration order by default", async () => {
  const transport = createRecordingTransport();

  const result = await checkSmoke(
    { smoke: true, verbose: true },
    {
      loadConfig: async () =>
        createConfig({
          agents: {
            zebra: { driver: "zebra" },
            alpha: { driver: "alpha" },
          },
          workspaces: {
            zeta: { cwd: "/repo/zeta" },
            alpha: { cwd: "/repo/alpha" },
          },
        }),
      createTransport: async () => transport,
    },
  );

  expect(result.severity).toBe("pass");
  expect(transport.session).toMatchObject({
    agent: "zebra",
    workspace: "zeta",
    cwd: "/repo/zeta",
  });
  expect(result.details ?? []).toContain("agent: zebra (default first configured agent)");
  expect(result.details ?? []).toContain("workspace: zeta (default first configured workspace)");
});

test("smoke check mixes one explicit selection with one default selection", async () => {
  const transport = createRecordingTransport();

  const result = await checkSmoke(
    { smoke: true, workspace: "frontend", verbose: true },
    {
      loadConfig: async () => createConfig(),
      createTransport: async () => transport,
    },
  );

  expect(result.severity).toBe("pass");
  expect(transport.session).toMatchObject({
    agent: "codex",
    workspace: "frontend",
    cwd: "/repo/frontend",
  });
  expect(result.details ?? []).toContain("agent: codex (default first configured agent)");
  expect(result.details ?? []).toContain("workspace: frontend (explicit --workspace)");
});

test("smoke check passes when prompt succeeds with non-empty text", async () => {
  const transport = createRecordingTransport("ok");

  const result = await checkSmoke(
    { smoke: true },
    {
      loadConfig: async () => createConfig(),
      createTransport: async () => transport,
    },
  );

  expect(result.severity).toBe("pass");
  expect(result.summary).toContain("reply received");
  expect(transport.promptText).toBeDefined();
});

test("smoke check warns when prompt succeeds with a non-ideal reply", async () => {
  const result = await checkSmoke(
    { smoke: true, verbose: true },
    {
      loadConfig: async () => createConfig(),
      createTransport: async () => createRecordingTransport("something else"),
    },
  );

  expect(result.severity).toBe("warn");
  expect(result.summary).toContain("non-ideal");
  expect(result.details ?? []).toContain('reply: "something else"');
});


test("smoke check passes the real bridge entry path when using acpx-bridge transport", async () => {
  let spawnOptions: Record<string, unknown> | undefined;

  const result = await checkSmoke(
    { smoke: true },
    {
      loadConfig: async () =>
        createConfig({
          transport: {
            type: "acpx-bridge",
            permissionMode: "approve-all",
            nonInteractivePermissions: "deny",
          },
        }),
      resolveAcpxCommandMetadata: () => ({
        command: "/resolved/acpx",
        source: "bundled",
        explanation: "bundled acpx found",
      }),
      resolveBridgeEntryPath: () => "/resolved/bridge-main.ts",
      spawnAcpxBridgeClient: async (options) => {
        spawnOptions = options as Record<string, unknown>;
        return {
          request: async (method) => {
            if (method === "ensureSession") return undefined as never;
            if (method === "prompt") return { text: "ok" } as never;
            throw new Error(`unexpected method: ${method}`);
          },
          waitUntilReady: async () => {},
          dispose: async () => {},
          handleLine() {},
          handleExit() {},
        } as any;
      },
    },
  );

  expect(result.severity).toBe("pass");
  expect(spawnOptions).toMatchObject({
    acpxCommand: "/resolved/acpx",
    bridgeEntryPath: "/resolved/bridge-main.ts",
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
  });
});

test("smoke check fails when transport ensureSession or prompt fails", async () => {
  const result = await checkSmoke(
    { smoke: true },
    {
      loadConfig: async () => createConfig(),
      createTransport: async () => ({
        async ensureSession() {
          throw new Error("ensure exploded");
        },
        async prompt() {
          throw new Error("prompt exploded");
        },
        async setMode() {},
        async cancel() {
          return { cancelled: true, message: "cancelled" };
        },
        async hasSession() {
          return false;
        },
      }),
    },
  );

  expect(result.severity).toBe("fail");
  expect(result.details?.join("\n") ?? "").toContain("ensure exploded");
});
