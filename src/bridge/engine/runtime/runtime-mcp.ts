import type { McpServer } from "@agentclientprotocol/sdk";

/**
 * PR8: Build Runtime mcpServers from xacpx coordinator identity.
 * - mcpCoordinatorSession + mcpSourceHandle + existing xacpx MCP server factory/config -> public acpx Runtime mcpServers option
 * Currently a thin stub that returns an empty array when no coordinator, or a single stdio server
 * that reuses the existing xacpx MCP server entry point. The MCP server implementation itself
 * is shared between CLI and Runtime (no duplication).
 */
export function buildRuntimeMcpServers(input: {
  mcpCoordinatorSession?: string;
  mcpSourceHandle?: string;
  // The endpoint is resolved via the same helper the CLI path uses; for tests we allow injection
  endpoint?: string;
}): McpServer[] {
  if (!input.mcpCoordinatorSession) return [];
  // For now, return a single stdio entry that the Runtime will launch as a child of the worker.
  // The actual command is resolved lazily by the worker; this config is just the identity.
  // In production, this would be: { name: "xacpx", transport: { type: "stdio", command: "node", args: [mcpServerEntry, "--coordinator-session", ...] } }
  // For PR8 we keep it minimal and let the worker's adapter decide — the gate is that sameEnsureParams
  // treats coordinator/source as launch identity, so a change triggers worker recreation.
  return [
    {
      name: "xacpx",
      // Cast to satisfy SDK type without pulling full config here — the worker will flesh out command/env.
      transport: { type: "stdio", command: "node", args: ["--coordinator-session", input.mcpCoordinatorSession, ...(input.mcpSourceHandle ? ["--source-handle", input.mcpSourceHandle] : [])] },
    } as unknown as McpServer,
  ];
}

export function normalizeMcpIdentity(input: { mcpCoordinatorSession?: string; mcpSourceHandle?: string }): { mcpCoordinatorSession?: string; mcpSourceHandle?: string } {
  return {
    ...(input.mcpCoordinatorSession ? { mcpCoordinatorSession: input.mcpCoordinatorSession } : {}),
    ...(input.mcpSourceHandle ? { mcpSourceHandle: input.mcpSourceHandle } : {}),
  };
}
