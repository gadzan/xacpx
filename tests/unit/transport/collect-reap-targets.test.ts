import { expect, test } from "bun:test";

import { collectReapTargets, workerBindingReapTargets } from "../../../src/transport/collect-reap-targets";
import type { AppConfig } from "../../../src/config/types";
import type { ResolvedSession } from "../../../src/transport/types";
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
      agentCommand: "npx -y --registry=https://registry.npmjs.org/ --@agentclientprotocol:registry=https://registry.npmjs.org/ @agentclientprotocol/codex-acp@1.1.4",
      cwd: "/tmp/backend",
      transportSession: "backend:codex:wk",
    },
    {
      agent: "opencode",
      agentCommand: "npx -y opencode-ai acp",
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
      agentCommand: "npx -y --registry=https://registry.npmjs.org/ --@agentclientprotocol:registry=https://registry.npmjs.org/ @agentclientprotocol/codex-acp@1.1.4",
      cwd: "/tmp/backend",
      transportSession: "backend:codex:wk",
    },
  ]);
});

function resolvedSession(over: Partial<ResolvedSession> & Pick<ResolvedSession, "agent" | "cwd" | "transportSession">): ResolvedSession {
  return {
    alias: over.transportSession,
    workspace: "backend",
    ...over,
  } as ResolvedSession;
}

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
    listAllResolvedSessions: (): ResolvedSession[] => [
      resolvedSession({ agent: "codex", cwd: "/tmp/a", transportSession: "wx:alice" }),
      resolvedSession({
        agent: "opencode",
        agentCommand: "npx -y opencode-ai acp",
        cwd: "/tmp/b",
        transportSession: "wx:bob",
      }),
    ],
  };

  const targets = collectReapTargets(sessions, state.orchestration, createConfig());

  expect(targets).toEqual([
    { agent: "codex", cwd: "/tmp/a", transportSession: "wx:alice" },
    { agent: "opencode", agentCommand: "npx -y opencode-ai acp", cwd: "/tmp/b", transportSession: "wx:bob" },
    {
      agent: "codex",
      agentCommand: "npx -y --registry=https://registry.npmjs.org/ --@agentclientprotocol:registry=https://registry.npmjs.org/ @agentclientprotocol/codex-acp@1.1.4",
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
