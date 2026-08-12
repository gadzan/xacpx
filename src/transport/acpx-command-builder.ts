import type { NonInteractivePermissions, PermissionMode } from "../config/types";
import { permissionModeToFlag } from "./permission-mode-flag";

export const DEFAULT_PERMISSION_MODE: PermissionMode = "approve-all";
export const DEFAULT_NON_INTERACTIVE: NonInteractivePermissions = "deny";

export interface PermissionArgsInput {
  permissionMode: PermissionMode;
  nonInteractivePermissions: NonInteractivePermissions;
  permissionPolicy?: string;
}

export function buildPermissionArgs(input: PermissionArgsInput): string[] {
  const args = [permissionModeToFlag(input.permissionMode), "--non-interactive-permissions", input.nonInteractivePermissions];
  if (typeof input.permissionPolicy === "string" && input.permissionPolicy.trim().length > 0) {
    args.push("--permission-policy", input.permissionPolicy);
  }
  return args;
}

export function buildQueueOwnerTtlArgs(queueOwnerTtlSeconds: number | undefined): string[] {
  if (typeof queueOwnerTtlSeconds !== "number" || !Number.isFinite(queueOwnerTtlSeconds)) return [];
  return ["--ttl", String(queueOwnerTtlSeconds)];
}

export function buildModelArgs(model: string | undefined): string[] {
  const trimmed = model?.trim();
  return trimmed ? ["--model", trimmed] : [];
}

export interface SessionArgsInput {
  agent: string;
  agentCommand?: string;
  /**
   * Positional acpx agent: bare built-in driver or xacpx-managed overlay alias.
   * When set, the agent launches through acpx's native structured argv path.
   */
  acpxAgent?: string;
  /** Legacy raw override / historical session selector: `acpx --agent <rawCommand>`. */
  rawCommand?: string;
  cwd: string;
  model?: string;
  permission: PermissionArgsInput;
}

// Agent selection — the ONLY place the launch selector lives. All transports and
// management by-passes must route through this so they can never drift:
// 1. `rawCommand` → `--agent <rawCommand>` (legacy / historical selector).
// 2. `acpxAgent` → positional agent (overlay alias or bare driver).
// 3. legacy compat (old bridge clients): `agentCommand` → `--agent <cmd>`.
// 4. bare positional `agent`.
function appendAgentAndTail(
  prefix: string[],
  input: { agent: string; agentCommand?: string; acpxAgent?: string; rawCommand?: string },
  tail: string[],
): string[] {
  if (input.rawCommand) return [...prefix, "--agent", input.rawCommand, ...tail];
  if (input.acpxAgent) return [...prefix, input.acpxAgent, ...tail];
  if (input.agentCommand) return [...prefix, "--agent", input.agentCommand, ...tail];
  return [...prefix, input.agent, ...tail];
}

export function buildSessionArgs(
  input: SessionArgsInput,
  tail: string[],
  options: { verbose?: boolean; format?: "quiet" | "json" } = {},
): string[] {
  const prefix: string[] = [
    "--format", options.format ?? "quiet",
    "--cwd", input.cwd,
    ...buildPermissionArgs(input.permission),
    ...buildModelArgs(input.model),
  ];
  if (options.verbose) prefix.push("--verbose");
  return appendAgentAndTail(prefix, input, tail);
}

export function buildPromptArgs(
  input: SessionArgsInput & { queueOwnerTtlSeconds: number | undefined },
  tail: string[],
): string[] {
  const prefix = [
    "--format", "json", "--json-strict",
    "--cwd", input.cwd,
    ...buildPermissionArgs(input.permission),
    ...buildModelArgs(input.model),
    ...buildQueueOwnerTtlArgs(input.queueOwnerTtlSeconds),
  ];
  return appendAgentAndTail(prefix, input, tail);
}

export function buildAgentQueryArgs(
  input: {
    agent: string;
    agentCommand?: string;
    acpxAgent?: string;
    rawCommand?: string;
    cwd: string;
    permission: PermissionArgsInput;
  },
  format: "json" | "quiet",
  tail: string[],
): string[] {
  const prefix = ["--format", format, "--cwd", input.cwd, ...buildPermissionArgs(input.permission)];
  return appendAgentAndTail(prefix, input, tail);
}

export function isMissingAcpxSessionError(stderr: string, stdout: string): boolean {
  const combined = `${stderr}\n${stdout}`.toLowerCase();
  return (
    combined.includes("no named session") ||
    combined.includes("no cwd session") ||
    combined.includes("session not found") ||
    combined.includes("unknown session") ||
    combined.includes("no acpx session found")
  );
}

export function parseAcpxSessionRecordId(
  stdout: string,
): { acpxRecordId: string; agentSessionId?: string } | undefined {
  try {
    const parsed = JSON.parse(stdout) as {
      acpxRecordId?: unknown;
      id?: unknown;
      acpSessionId?: unknown;
      agentSessionId?: unknown;
    };
    const acpxRecordId = typeof parsed.acpxRecordId === "string"
      ? parsed.acpxRecordId
      : typeof parsed.id === "string" ? parsed.id : undefined;
    const providerSessionId = typeof parsed.agentSessionId === "string" && parsed.agentSessionId.length > 0
      ? parsed.agentSessionId
      : undefined;
    const acpSessionId = typeof parsed.acpSessionId === "string" && parsed.acpSessionId.length > 0
      ? parsed.acpSessionId
      : undefined;
    const agentSessionId = providerSessionId ?? acpSessionId;
    if (acpxRecordId && /^[\w.:-]+$/.test(acpxRecordId) && acpxRecordId.length >= 8) {
      return { acpxRecordId, agentSessionId };
    }
  } catch {
    const firstLine = stdout.trim().split(/\r?\n/, 1)[0];
    if (firstLine && /^[\w.:-]+$/.test(firstLine) && firstLine.length >= 8) {
      return { acpxRecordId: firstLine };
    }
  }
  return undefined;
}
