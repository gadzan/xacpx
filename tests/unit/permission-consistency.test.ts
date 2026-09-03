import { expect, mock, test, beforeEach, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildApp as buildAppRaw, type AppRuntime, type RuntimePaths } from "../../src/main";
import { setLocale } from "../../src/i18n";
import type { SessionTransport, PermissionPolicy } from "../../src/transport/types";
import type { AppConfig } from "../../src/config/types";
import { handleConfigSet } from "../../src/commands/handlers/config-handler";
import { handlePermissionAutoSet } from "../../src/commands/handlers/permission-handler";

beforeEach(() => { setLocale("zh"); });
afterAll(() => { setLocale("en"); });

interface TestBuildAppDeps {
  createCliTransport?: (command: string) => SessionTransport;
  createBridgeTransport?: () => Promise<SessionTransport>;
}

const buildApp = (paths: RuntimePaths, deps: TestBuildAppDeps = {}): Promise<AppRuntime> =>
  buildAppRaw(paths, {
    stateSaveDebounceMs: 0,
    provisionAgentOverlays: async () => ({ outcomes: {}, raced: false }),
    ...deps,
  });

function makeRuntimeSessionState(now: string = new Date().toISOString()) {
  return {
    chat_contexts: {},
    sessions: {
      "backend-codex": {
        alias: "backend-codex",
        agent: "codex",
        workspace: "backend",
        transport_session: "ts-1",
        transport_engine: "runtime",
        logical_session_id: "11111111-1111-4111-8111-111111111111",
        source: "xacpx",
        created_at: now,
        last_used_at: now,
      },
    },
    tasks: {},
    orchestration: {
      groups: {},
      tasks: {},
      workers: {},
      workerBindings: {},
      externalCoordinators: {},
    },
  };
}

test("external edit to config.json propagates permission policy update to transport and updates live config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-perm-watcher-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");

  await writeFile(
    configPath,
    JSON.stringify({
      transport: {
        type: "acpx-cli",
        command: "acpx",
        permissionMode: "approve-all",
        nonInteractivePermissions: "deny",
      },
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    }),
  );

  const policyUpdates: PermissionPolicy[] = [];
  const mockTransport: SessionTransport = {
    prompt: mock(async () => ({ text: "ok", stopReason: "end_turn" })),
    updatePermissionPolicy: mock(async (policy: PermissionPolicy) => {
      policyUpdates.push(policy);
    }),
  };

  const app = await buildApp(
    { configPath, statePath },
    { createCliTransport: () => mockTransport },
  );

  try {
    expect(policyUpdates.length).toBe(0);

    // Update config on disk
    await writeFile(
      configPath,
      JSON.stringify({
        transport: {
          type: "acpx-cli",
          command: "acpx",
          permissionMode: "approve-reads",
          nonInteractivePermissions: "deny",
          permissionPolicy: JSON.stringify({ autoDeny: ["delete_file"] }),
        },
        agents: { codex: { driver: "codex" } },
        workspaces: { backend: { cwd: "/tmp/backend" } },
      }),
    );

    // Trigger reload
    const updatedConfig = await app.reloadRuntimeConfig?.();
    expect(updatedConfig?.transport.permissionMode).toBe("approve-reads");
    expect(updatedConfig?.transport.permissionPolicy).toBe(
      JSON.stringify({ autoDeny: ["delete_file"] }),
    );

    expect(policyUpdates.length).toBe(1);
    expect(policyUpdates[0]).toEqual({
      permissionMode: "approve-reads",
      nonInteractivePermissions: "deny",
      permissionPolicy: JSON.stringify({ autoDeny: ["delete_file"] }),
    });
  } finally {
    await app.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ineligible policy update is rejected when active runtime sessions exist, preserving live config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-perm-reject-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");

  await writeFile(
    configPath,
    JSON.stringify({
      transport: {
        type: "acpx-cli",
        command: "acpx",
        permissionMode: "approve-all",
        nonInteractivePermissions: "deny",
      },
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    }),
  );

  // State with a persisted session bound to the runtime engine
  await writeFile(statePath, JSON.stringify(makeRuntimeSessionState()));

  const policyUpdates: PermissionPolicy[] = [];
  const mockTransport: SessionTransport = {
    prompt: mock(async () => ({ text: "ok", stopReason: "end_turn" })),
    updatePermissionPolicy: mock(async (policy: PermissionPolicy) => {
      policyUpdates.push(policy);
    }),
  };

  const loggedErrors: Array<{ event: string; message: string }> = [];
  const app = await buildApp(
    { configPath, statePath },
    { createCliTransport: () => mockTransport },
  );

  // Spy on logger
  const origError = app.logger.error.bind(app.logger);
  app.logger.error = async (event, message, context) => {
    loggedErrors.push({ event, message });
    return origError(event, message, context);
  };

  try {
    // Attempt 1: nonInteractivePermissions = "fail" (ineligible for Runtime)
    await writeFile(
      configPath,
      JSON.stringify({
        transport: {
          type: "acpx-cli",
          command: "acpx",
          permissionMode: "approve-all",
          nonInteractivePermissions: "fail",
        },
        agents: { codex: { driver: "codex" } },
        workspaces: { backend: { cwd: "/tmp/backend" } },
      }),
    );

    let threw = false;
    try {
      await app.reloadRuntimeConfig?.();
    } catch (err) {
      threw = true;
      expect(String(err)).toContain("runtime-ineligible policy");
    }
    expect(threw).toBe(true);
    expect(policyUpdates.length).toBe(0);

    // Verify config in memory is still the old live config
    const routerContext = (app.router as unknown as { config: AppConfig }).config;
    expect(routerContext.transport.nonInteractivePermissions).toBe("deny");

    // Verify config.reload_failed was logged
    expect(loggedErrors.some((e) => e.event === "config.reload_failed")).toBe(true);

    // Attempt 2: escalate policy without interactive availability (ineligible for Runtime)
    await writeFile(
      configPath,
      JSON.stringify({
        transport: {
          type: "acpx-cli",
          command: "acpx",
          permissionMode: "approve-all",
          nonInteractivePermissions: "deny",
          permissionPolicy: JSON.stringify({ escalate: ["run_command"] }),
        },
        agents: { codex: { driver: "codex" } },
        workspaces: { backend: { cwd: "/tmp/backend" } },
      }),
    );

    let threwEscalate = false;
    try {
      await app.reloadRuntimeConfig?.();
    } catch (err) {
      threwEscalate = true;
      expect(String(err)).toContain("runtime-ineligible policy");
    }
    expect(threwEscalate).toBe(true);
    expect(policyUpdates.length).toBe(0);
  } finally {
    await app.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("startup check logs loud health error when state has runtime sessions but config is runtime-ineligible", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-perm-startup-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");

  // Ineligible config at startup: nonInteractivePermissions = "fail"
  await writeFile(
    configPath,
    JSON.stringify({
      transport: {
        type: "acpx-cli",
        command: "acpx",
        permissionMode: "approve-all",
        nonInteractivePermissions: "fail",
      },
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    }),
  );

  // Persisted state with runtime engine binding
  await writeFile(statePath, JSON.stringify(makeRuntimeSessionState()));

  const mockTransport: SessionTransport = {
    prompt: mock(async () => ({ text: "ok", stopReason: "end_turn" })),
  };

  const app = await buildApp(
    { configPath, statePath },
    { createCliTransport: () => mockTransport },
  );

  try {
    // Read app.log to verify loud health error was logged during startup
    const appLogPath = join(dir, "runtime", "app.log");
    const appLogContent = await readFile(appLogPath, "utf8");
    expect(appLogContent).toContain("health.runtime_ineligible_with_bindings");
  } finally {
    await app.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("eligible permission update succeeds when runtime sessions exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-perm-eligible-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");

  await writeFile(
    configPath,
    JSON.stringify({
      transport: {
        type: "acpx-cli",
        command: "acpx",
        permissionMode: "approve-all",
        nonInteractivePermissions: "deny",
      },
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    }),
  );

  await writeFile(statePath, JSON.stringify(makeRuntimeSessionState()));

  const policyUpdates: PermissionPolicy[] = [];
  const mockTransport: SessionTransport = {
    prompt: mock(async () => ({ text: "ok", stopReason: "end_turn" })),
    updatePermissionPolicy: mock(async (policy: PermissionPolicy) => {
      policyUpdates.push(policy);
    }),
  };

  const app = await buildApp(
    { configPath, statePath },
    { createCliTransport: () => mockTransport },
  );

  try {
    // Eligible update: autoDeny rule with nonInteractive = deny
    await writeFile(
      configPath,
      JSON.stringify({
        transport: {
          type: "acpx-cli",
          command: "acpx",
          permissionMode: "approve-reads",
          nonInteractivePermissions: "deny",
          permissionPolicy: JSON.stringify({ autoDeny: ["danger_tool"] }),
        },
        agents: { codex: { driver: "codex" } },
        workspaces: { backend: { cwd: "/tmp/backend" } },
      }),
    );

    const updated = await app.reloadRuntimeConfig?.();
    expect(updated?.transport.permissionMode).toBe("approve-reads");
    expect(policyUpdates.length).toBe(1);
    expect(policyUpdates[0]?.permissionMode).toBe("approve-reads");
    expect(policyUpdates[0]?.permissionPolicy).toBe(JSON.stringify({ autoDeny: ["danger_tool"] }));
  } finally {
    await app.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("permission diffing does not trigger transport update when permission tuple is unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-perm-noop-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");

  await writeFile(
    configPath,
    JSON.stringify({
      language: "en",
      transport: {
        type: "acpx-cli",
        command: "acpx",
        permissionMode: "approve-all",
        nonInteractivePermissions: "deny",
      },
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    }),
  );

  const policyUpdates: PermissionPolicy[] = [];
  const mockTransport: SessionTransport = {
    prompt: mock(async () => ({ text: "ok", stopReason: "end_turn" })),
    updatePermissionPolicy: mock(async (policy: PermissionPolicy) => {
      policyUpdates.push(policy);
    }),
  };

  const app = await buildApp(
    { configPath, statePath },
    { createCliTransport: () => mockTransport },
  );

  try {
    // Only language changed, permission tuple is identical
    await writeFile(
      configPath,
      JSON.stringify({
        language: "zh",
        transport: {
          type: "acpx-cli",
          command: "acpx",
          permissionMode: "approve-all",
          nonInteractivePermissions: "deny",
        },
        agents: { codex: { driver: "codex" } },
        workspaces: { backend: { cwd: "/tmp/backend" } },
      }),
    );

    const updated = await app.reloadRuntimeConfig?.();
    expect(updated?.language).toBe("zh");
    expect(policyUpdates.length).toBe(0);
  } finally {
    await app.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("/config set rejects ineligible nonInteractivePermissions when runtime sessions exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-perm-cmd-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");

  await writeFile(
    configPath,
    JSON.stringify({
      transport: {
        type: "acpx-cli",
        command: "acpx",
        permissionMode: "approve-all",
        nonInteractivePermissions: "deny",
      },
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    }),
  );

  await writeFile(statePath, JSON.stringify(makeRuntimeSessionState()));

  const mockTransport: SessionTransport = {
    prompt: mock(async () => ({ text: "ok", stopReason: "end_turn" })),
    updatePermissionPolicy: mock(async () => {}),
  };

  const app = await buildApp(
    { configPath, statePath },
    { createCliTransport: () => mockTransport },
  );

  try {
    const handlerContext = {
      sessions: app.sessions,
      transport: app.transport,
      config: (app.router as unknown as { config: AppConfig }).config,
      configStore: app.configStore,
      logger: app.logger,
      replaceConfig: (updated: AppConfig) => {
        Object.assign((app.router as unknown as { config: AppConfig }).config, updated);
      },
    };

    // /config set transport.nonInteractivePermissions fail -> rejected
    let threwConfigSet = false;
    try {
      await handleConfigSet(handlerContext, "transport.nonInteractivePermissions", "fail");
    } catch (err) {
      threwConfigSet = true;
      expect(String(err)).toContain("runtime-ineligible policy");
    }
    expect(threwConfigSet).toBe(true);

    // /pm auto fail -> rejected
    let threwPmAuto = false;
    try {
      await handlePermissionAutoSet(handlerContext, "fail");
    } catch (err) {
      threwPmAuto = true;
      expect(String(err)).toContain("runtime-ineligible policy");
    }
    expect(threwPmAuto).toBe(true);
  } finally {
    await app.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
