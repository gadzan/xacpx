import type { AppConfig } from "../config/types";
import type { OrchestrationState } from "../orchestration/orchestration-types";
import { resolveWorkerAgentLaunch } from "../orchestration/worker-launch";
import type { ReapTarget } from "./queue-owner-reaper";

/**
 * Full reap-target set for a daemon: every known logical (user) session plus the
 * orchestration worker sessions. Both spawn warm acpx queue owners honoring `--ttl`,
 * so both must be swept at shutdown (so they don't linger) and at startup (so owners
 * orphaned by a previously crashed/force-killed daemon get cleaned up). Sessions whose
 * agent/workspace are de-registered are already filtered by listReapTargets and
 * workerBindingReapTargets respectively.
 *
 * Logical targets come from SessionService.listReapTargets (NOT
 * listAllResolvedSessions): besides the current resolution each session also
 * contributes its persisted historical launch identity, so an owner spawned
 * under a previous managed pin is still found after a crash + upgrade.
 */
export function collectReapTargets(
  sessions: { listReapTargets(): ReapTarget[] },
  orchestration: OrchestrationState,
  config: AppConfig,
): ReapTarget[] {
  return [
    ...sessions.listReapTargets(),
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
 * Resolution mirrors resolveWorkerRuntimeSession: agent launch spec from config (or the
 * bare driver for built-ins), cwd from the binding or its workspace. Bindings whose
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
    const launch = resolveWorkerAgentLaunch(agentConfig, config.transport, binding);
    targets.push({
      agent: binding.targetAgent,
      ...(launch.agentCommand ? { agentCommand: launch.agentCommand } : {}),
      ...(launch.acpxAgent ? { acpxAgent: launch.acpxAgent } : {}),
      ...(launch.rawCommand ? { rawCommand: launch.rawCommand } : {}),
      cwd,
      transportSession: workerSession,
    });
    // Historical identity from the last dispatch's launch snapshot (same
    // pin-upgrade orphan case as logical sessions): command-only `--agent`
    // so acpx matches the old record verbatim with no alias round trip.
    // Bindings predating the snapshot (or bare-driver launches) carry no
    // snapshot and fall back to the current resolution above.
    const historicalCommand = binding.launchAgentCommand ?? binding.launchRawCommand;
    if (
      historicalCommand &&
      historicalCommand !== launch.agentCommand &&
      historicalCommand !== launch.rawCommand
    ) {
      targets.push({
        agent: binding.targetAgent,
        agentCommand: historicalCommand,
        cwd,
        transportSession: workerSession,
      });
    }
  }
  return targets;
}
