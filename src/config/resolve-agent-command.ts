import { resolveLocalAgentCommand } from "./local-agent-bin";

export function resolveAgentCommand(
  driver: string,
  command: string | undefined,
): string | undefined {
  if (!command) {
    return undefined;
  }

  if (driver === "codex" && isLegacyCodexCommand(command)) {
    return undefined;
  }

  return command;
}

/**
 * Agent command for the RUNTIME spawn/reap paths. An explicit per-agent `command`
 * always wins; otherwise, when `preferLocal` (default true), prefer a locally-installed
 * native CLI over acpx's npx fallback; otherwise undefined (acpx resolves the driver).
 *
 * Use this — not bare resolveAgentCommand — wherever an agentCommand is built to spawn
 * OR reap a queue owner, so both resolve identically (a mismatch would orphan the owner).
 * It is deliberately NOT used on the config-persistence paths (load/ensure-config), so a
 * machine-specific local binary is never baked into the shareable config file.
 */
export function resolveRuntimeAgentCommand(
  driver: string,
  command: string | undefined,
  preferLocal = true,
): string | undefined {
  const explicit = resolveAgentCommand(driver, command);
  if (explicit) {
    return explicit;
  }
  return preferLocal ? resolveLocalAgentCommand(driver) : undefined;
}

export function isLegacyCodexCommand(command: string): boolean {
  const normalized = command.trim().replaceAll("\\", "/").toLowerCase();

  return (
    normalized === "./node_modules/.bin/codex-acp" ||
    normalized === "./node_modules/.bin/codex-acp.exe" ||
    normalized.endsWith("/node_modules/.bin/codex-acp") ||
    normalized.endsWith("/node_modules/.bin/codex-acp.exe") ||
    normalized.includes("/@zed-industries/codex-acp/bin/codex-acp.js") ||
    normalized.includes("@zed-industries/codex-acp/bin/codex-acp.js")
  );
}
