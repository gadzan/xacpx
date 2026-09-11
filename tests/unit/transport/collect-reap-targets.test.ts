import { expect, test } from "bun:test";

import { collectReapTargets, workerBindingReapTargets } from "../../../src/transport/collect-reap-targets";
import { resolveConfiguredAgentLaunch } from "../../../src/config/resolve-agent-command";
import type { AppConfig } from "../../../src/config/types";
import { createEmptyState } from "../../../src/state/types";

function createConfig(): AppConfig {
  return {
    transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
    logging: { level: "info", maxSizeBytes: 1024, maxFiles: 2, retentionDays: 1 },
    channel: { type: "weixin", replyMode: "verbose" },
    channels: [{ id: "weixin", type: "weixin", enabled: true }],
    agents: {
      codex: { driver: "codex" },
      opencode: { driver: "opencode", command: "npx -y opencode-ai acp" },
    },
    workspaces: { backend: { cwd: "/tmp/backend" } },
    orchestration: {
      maxPendingAgentRequestsPerCoordinator: 3,
      allowWorkerChainedRequests: false,
      allowedAgentRequestTargets: [],
      allowedAgentRequestRoles: [],
    },
  };
}

test("builds reap targets from worker bindings, resolving cwd and agent command", () => {
  const state = createEmptyState();
  state.orchestration.workerBindings["backend:codex:wk"] = {
    sourceHandle: "h1",
    coordinatorSession: "backend:main",
    workspace: "backend",
    cwd: "/tmp/backend",
    targetAgent: "codex",
  };
  state.orchestration.workerBindings["backend:opencode:wk"] = {
    sourceHandle: "h2",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "opencode",
  };

  const targets = workerBindingReapTargets(state.orchestration, createConfig());

  expect(targets).toEqual([
    {
      agent: "codex",
      acpxAgent: "xacpx-managed-codex-1eddaa92b9a5",
      agentCommand: "npx -y --registry=https://registry.npmjs.org --@agentclientprotocol:registry=https://registry.npmjs.org @agentclientprotocol/codex-acp@1.10.0",
      cwd: "/tmp/backend",
      transportSession: "backend:codex:wk",
    },
    {
      agent: "opencode",
      acpxAgent: "opencode",
      agentCommand: "npx -y opencode-ai acp",
      rawCommand: "npx -y opencode-ai acp",
      cwd: "/tmp/backend",
      transportSession: "backend:opencode:wk",
    },
  ]);
});

test("falls back to workspace cwd when the binding has no explicit cwd", () => {
  const state = createEmptyState();
  state.orchestration.workerBindings["backend:codex:wk"] = {
    sourceHandle: "h1",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
  };

  const targets = workerBindingReapTargets(state.orchestration, createConfig());

  expect(targets).toEqual([
    {
      agent: "codex",
      acpxAgent: "xacpx-managed-codex-1eddaa92b9a5",
      agentCommand: "npx -y --registry=https://registry.npmjs.org --@agentclientprotocol:registry=https://registry.npmjs.org @agentclientprotocol/codex-acp@1.10.0",
      cwd: "/tmp/backend",
      transportSession: "backend:codex:wk",
    },
  ]);
});

test("reap resolution honors the persisted worker guard rollout while legacy bindings stay unguarded", () => {
  const state = createEmptyState();
  state.orchestration.workerBindings["legacy-worker"] = {
    sourceHandle: "legacy",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
  };
  state.orchestration.workerBindings["guarded-worker"] = {
    sourceHandle: "guarded",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
    guardAcpOutput: true,
  } as typeof state.orchestration.workerBindings[string];

  const config = createConfig();
  const guarded = resolveConfiguredAgentLaunch(config.agents.codex!, config.transport, { guardAcpOutput: true });
  const targets = workerBindingReapTargets(state.orchestration, config);

  expect(targets).toEqual([
    {
      agent: "codex",
      acpxAgent: "xacpx-managed-codex-1eddaa92b9a5",
      agentCommand: "npx -y --registry=https://registry.npmjs.org --@agentclientprotocol:registry=https://registry.npmjs.org @agentclientprotocol/codex-acp@1.10.0",
      cwd: "/tmp/backend",
      transportSession: "legacy-worker",
    },
    {
      agent: "codex",
      acpxAgent: guarded.acpxAgent,
      agentCommand: guarded.agentCommand,
      cwd: "/tmp/backend",
      transportSession: "guarded-worker",
    },
  ]);
});


test("collectReapTargets combines logical sessions and worker bindings", () => {
  const state = createEmptyState();
  state.orchestration.workerBindings["backend:codex:wk"] = {
    sourceHandle: "h1",
    coordinatorSession: "backend:main",
    workspace: "backend",
    cwd: "/tmp/backend",
    targetAgent: "codex",
  };

  const sessions = {
    listReapTargets: () => [
      { agent: "codex", cwd: "/tmp/a", transportSession: "wx:alice" },
      { agent: "opencode", agentCommand: "npx -y opencode-ai acp", cwd: "/tmp/b", transportSession: "wx:bob" },
    ],
  };

  const targets = collectReapTargets(sessions, state.orchestration, createConfig());

  expect(targets).toEqual([
    { agent: "codex", cwd: "/tmp/a", transportSession: "wx:alice" },
    { agent: "opencode", agentCommand: "npx -y opencode-ai acp", cwd: "/tmp/b", transportSession: "wx:bob" },
    {
      agent: "codex",
      acpxAgent: "xacpx-managed-codex-1eddaa92b9a5",
      agentCommand: "npx -y --registry=https://registry.npmjs.org --@agentclientprotocol:registry=https://registry.npmjs.org @agentclientprotocol/codex-acp@1.10.0",
      cwd: "/tmp/backend",
      transportSession: "backend:codex:wk",
    },
  ]);
});

test("skips bindings whose agent or workspace is no longer resolvable", () => {
  const state = createEmptyState();
  state.orchestration.workerBindings["gone-agent"] = {
    sourceHandle: "h1",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "ghost",
  };
  state.orchestration.workerBindings["gone-workspace"] = {
    sourceHandle: "h2",
    coordinatorSession: "backend:main",
    workspace: "ghost-workspace",
    targetAgent: "codex",
  };

  const targets = workerBindingReapTargets(state.orchestration, createConfig());

  expect(targets).toEqual([]);
});

test("worker binding reaps the snapshotted previous-pin identity alongside the current one", () => {
  // Crash + managed-pin upgrade: the binding's last dispatch ran codex 1.1.9
  // (f4349e35c3c8) while the current catalog resolves 1.10.0. Both the live
  // owner (old record) and any fresh owner (new record) must be found.
  const state = createEmptyState();
  state.orchestration.workerBindings["backend:codex:wk"] = {
    sourceHandle: "h1",
    coordinatorSession: "backend:main",
    workspace: "backend",
    cwd: "/tmp/backend",
    targetAgent: "codex",
    launchAgentCommand: "npx -y --registry=https://registry.npmjs.org --@agentclientprotocol:registry=https://registry.npmjs.org @agentclientprotocol/codex-acp@1.1.9",
    launchAcpxAgent: "xacpx-managed-codex-f4349e35c3c8",
  };

  const targets = workerBindingReapTargets(state.orchestration, createConfig());

  expect(targets).toEqual([
    {
      agent: "codex",
      acpxAgent: "xacpx-managed-codex-1eddaa92b9a5",
      agentCommand: "npx -y --registry=https://registry.npmjs.org --@agentclientprotocol:registry=https://registry.npmjs.org @agentclientprotocol/codex-acp@1.10.0",
      cwd: "/tmp/backend",
      transportSession: "backend:codex:wk",
    },
    {
      // Historical: command-only so the reaper passes it as `--agent` and
      // acpx matches the old record verbatim (no alias round trip).
      agent: "codex",
      agentCommand: "npx -y --registry=https://registry.npmjs.org --@agentclientprotocol:registry=https://registry.npmjs.org @agentclientprotocol/codex-acp@1.1.9",
      cwd: "/tmp/backend",
      transportSession: "backend:codex:wk",
    },
  ]);
});

test("worker binding without a snapshot reaps only the current resolution", () => {
  const state = createEmptyState();
  state.orchestration.workerBindings["backend:codex:wk"] = {
    sourceHandle: "h1",
    coordinatorSession: "backend:main",
    workspace: "backend",
    cwd: "/tmp/backend",
    targetAgent: "codex",
  };

  const targets = workerBindingReapTargets(state.orchestration, createConfig());

  expect(targets).toHaveLength(1);
  expect(targets[0]?.agentCommand).toContain("@agentclientprotocol/codex-acp@1.10.0");
});
