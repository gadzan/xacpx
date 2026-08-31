import type { McpServer } from "@agentclientprotocol/sdk";
import { buildXacpxMcpServerSpec, resolveDefaultXacpxCommand } from "../../../transport/acpx-queue-owner-launcher";

export function buildRuntimeMcpServers(input: {
  mcpCoordinatorSession?: string;
  mcpSourceHandle?: string;
  xacpxCommand?: string;
  baseEnv?: NodeJS.ProcessEnv;
}): McpServer[] {
  if (!input.mcpCoordinatorSession) return [];
  const xacpxCommand = input.xacpxCommand ?? resolveDefaultXacpxCommand(input.baseEnv ?? process.env);
  const spec = buildXacpxMcpServerSpec({
    xacpxCommand,
    coordinatorSession: input.mcpCoordinatorSession,
    ...(input.mcpSourceHandle ? { sourceHandle: input.mcpSourceHandle } : {}),
  });
  return [{ name: spec.name, command: spec.command, args: spec.args, env: [] } satisfies McpServer];
}

export function normalizeMcpIdentity(input: { mcpCoordinatorSession?: string; mcpSourceHandle?: string }): { mcpCoordinatorSession?: string; mcpSourceHandle?: string } {
  return {
    ...(input.mcpCoordinatorSession ? { mcpCoordinatorSession: input.mcpCoordinatorSession } : {}),
    ...(input.mcpSourceHandle ? { mcpSourceHandle: input.mcpSourceHandle } : {}),
  };
}
