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
        type: "acpx-bridge",
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
    { createBridgeTransport: async () => mockTransport },
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
          type: "acpx-bridge",
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
          type: "acpx-bridge",
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

test("startup fails closed when state has runtime sessions but config is runtime-ineligible", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-perm-startup-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");

  // Ineligible config at startup: nonInteractivePermissions = "fail"
  const rawConfig = JSON.stringify({
    transport: {
      type: "acpx-bridge",
      permissionMode: "approve-all",
      nonInteractivePermissions: "fail",
    },
    agents: { codex: { driver: "codex" } },
    workspaces: { backend: { cwd: "/tmp/backend" } },
  });
  await writeFile(configPath, rawConfig);

  // Persisted state with runtime engine binding
  const rawState = JSON.stringify(makeRuntimeSessionState());
  await writeFile(statePath, rawState);

  const mockTransport: SessionTransport = {
    prompt: mock(async () => ({ text: "ok", stopReason: "end_turn" })),
  };

  await expect(
    buildApp(
      { configPath, statePath },
      { createBridgeTransport: async () => mockTransport },
    ),
  ).rejects.toThrow(/persisted runtime bindings/);
  // Failed startup must not mutate the state file.
  expect(await readFile(statePath, "utf8")).toBe(rawState);
  await rm(dir, { recursive: true, force: true });
});

test("eligible permission update succeeds when runtime sessions exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-perm-eligible-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");

  await writeFile(
    configPath,
    JSON.stringify({
      transport: {
        type: "acpx-bridge",
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
    { createBridgeTransport: async () => mockTransport },
  );

  try {
    // Eligible update: autoDeny rule with nonInteractive = deny
    await writeFile(
      configPath,
      JSON.stringify({
        transport: {
          type: "acpx-bridge",
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
        type: "acpx-bridge",
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
    { createBridgeTransport: async () => mockTransport },
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
function makeWorkerBindingRuntimeState(now: string = new Date().toISOString()) {
  return {
    chat_contexts: {},
    sessions: {},
    tasks: {},
    orchestration: {
      groups: {},
      workerBindings: {
        "worker-1": {
          sourceHandle: "src-1",
          coordinatorSession: "coord-1",
          workspace: "backend",
          targetAgent: "codex",
          agentEndpointId: "endpoint_test_worker_1",
          logicalSessionId: "22222222-2222-4222-8222-222222222222",
          transportEngine: "runtime",
        },
      },
      externalCoordinators: {},
    },
  };
}

test("ineligible policy update is rejected when only a worker binding is runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-perm-binding-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");

  await writeFile(
    configPath,
    JSON.stringify({
      transport: {
        type: "acpx-bridge",
        permissionMode: "approve-all",
        nonInteractivePermissions: "deny",
      },
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    }),
  );
  await writeFile(statePath, JSON.stringify(makeWorkerBindingRuntimeState()));

  const mockTransport: SessionTransport = {
    prompt: mock(async () => ({ text: "ok", stopReason: "end_turn" })),
    updatePermissionPolicy: mock(async () => {}),
  };
  const app = await buildApp(
    { configPath, statePath },
    { createBridgeTransport: async () => mockTransport },
  );
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        transport: {
          type: "acpx-bridge",
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
  } finally {
    await app.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("startup fails closed when only a worker binding is runtime and config is ineligible", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-perm-binding-startup-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");

  await writeFile(
    configPath,
    JSON.stringify({
      transport: {
        type: "acpx-bridge",
        permissionMode: "approve-all",
        nonInteractivePermissions: "fail",
      },
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    }),
  );
  const rawState = JSON.stringify(makeWorkerBindingRuntimeState());
  await writeFile(statePath, rawState);

  await expect(
    buildApp(
      { configPath, statePath },
      {
        createBridgeTransport: async () => ({
          prompt: mock(async () => ({ text: "ok", stopReason: "end_turn" })),
        }),
      },
    ),
  ).rejects.toThrow(/persisted runtime bindings/);
  expect(await readFile(statePath, "utf8")).toBe(rawState);
  await rm(dir, { recursive: true, force: true });
});
test("hot reload rejects transport topology changes and keeps live config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-perm-topology-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");

  await writeFile(
    configPath,
    JSON.stringify({
      transport: {
        type: "acpx-bridge",
        permissionMode: "approve-all",
        nonInteractivePermissions: "deny",
      },
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    }),
  );
  const app = await buildApp(
    { configPath, statePath },
    {
      createBridgeTransport: async () => ({
        prompt: mock(async () => ({ text: "ok", stopReason: "end_turn" })),
        updatePermissionPolicy: mock(async () => {}),
      }),
    },
  );
  try {
    // Same permission tuple, but a different transport topology: must not
    // hot-apply (the live transport object cannot be rebuilt in place).
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
    let threw = false;
    try {
      await app.reloadRuntimeConfig?.();
    } catch (err) {
      threw = true;
      expect(String(err)).toContain("requires a daemon restart");
    }
    expect(threw).toBe(true);
    const routerContext = (app.router as unknown as { config: AppConfig }).config;
    expect(routerContext.transport.type).toBe("acpx-bridge");
  } finally {
    await app.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
