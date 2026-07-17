import { resolveConfiguredAgentCommand } from "../config/resolve-agent-command";
import type { AppConfig } from "../config/types";
import type { OrchestrationState } from "../orchestration/orchestration-types";
import type { ResolvedSession } from "./types";
import type { ReapTarget } from "./queue-owner-reaper";

/**
 * Full reap-target set for a daemon: every known logical (user) session plus the
 * orchestration worker sessions. Both spawn warm acpx queue owners honoring `--ttl`,
 * so both must be swept at shutdown (so they don't linger) and at startup (so owners
 * orphaned by a previously crashed/force-killed daemon get cleaned up). Sessions whose
 * agent/workspace are de-registered are already filtered by listAllResolvedSessions and
 * workerBindingReapTargets respectively.
 */
export function collectReapTargets(
  sessions: { listAllResolvedSessions(): ResolvedSession[] },
  orchestration: OrchestrationState,
  config: AppConfig,
): ReapTarget[] {
  return [
    ...sessions.listAllResolvedSessions().map((session) => ({
      agent: session.agent,
      ...(session.agentCommand ? { agentCommand: session.agentCommand } : {}),
      cwd: session.cwd,
      transportSession: session.transportSession,
    })),
    ...workerBindingReapTargets(orchestration, config),
  ];
}

/**
 * Reap targets for orchestration worker sessions. These are acpx sessions xacpx
 * prompts (with the orchestration MCP), so they spawn queue owners that honor the
 * configured `--ttl` and would otherwise linger after daemon stop just like normal
 * prompt owners. Logical (user) sessions are covered separately via
 * SessionService.listAllResolvedSessions; coordinator sessions that are logical are
 * already in that set, and external coordinators have no xacpx-spawned owner.
 *
 * Resolution mirrors resolveWorkerRuntimeSession: agent command from config (or the
 * agent name for built-ins), cwd from the binding or its workspace. Bindings whose
 * agent/workspace are no longer registered are skipped (their owner, if any, just
 * expires on its own TTL).
 */
export function workerBindingReapTargets(
  orchestration: OrchestrationState,
  config: AppConfig,
): ReapTarget[] {
  const targets: ReapTarget[] = [];
  for (const [workerSession, binding] of Object.entries(orchestration.workerBindings)) {
    const agentConfig = config.agents[binding.targetAgent];
    if (!agentConfig) {
      continue;
    }
    const cwd = binding.cwd ?? config.workspaces[binding.workspace]?.cwd;
    if (!cwd) {
      continue;
    }
    const agentCommand = resolveConfiguredAgentCommand(agentConfig, config.transport);
    targets.push({
      agent: binding.targetAgent,
      ...(agentCommand ? { agentCommand } : {}),
      cwd,
      transportSession: workerSession,
    });
  }
  return targets;
}
