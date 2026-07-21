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
  cwd: string;
  model?: string;
  permission: PermissionArgsInput;
}

// Agent selection: `--agent <cmd>` when an explicit adapter command is set, else the
// bare agent name — appended after the flag prefix, before the operation tail. Shared by
// all three arg builders so the branch lives in exactly one place.
function appendAgentAndTail(
  prefix: string[],
  input: { agent: string; agentCommand?: string },
  tail: string[],
): string[] {
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
  input: { agent: string; agentCommand?: string; cwd: string; permission: PermissionArgsInput },
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
