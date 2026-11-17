import type { NonInteractivePermissions, PermissionMode } from "../config/types";

export function normalizeBridgePermissionMode(value: string | undefined): PermissionMode {
  return value === "approve-reads" || value === "deny-all" || value === "approve-all"
    ? value
    : "approve-all";
}

export function normalizeBridgeNonInteractivePermissions(
  value: string | undefined,
): NonInteractivePermissions {
  return value === "deny" || value === "fail" ? value : "deny";
}

export function normalizeBridgePermissionPolicy(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  return value;
}

export function normalizeBridgeSessionInitTimeoutMs(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function normalizeBridgeQueueOwnerTtlSeconds(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Bridge-side byte ceiling normalizer (plan B5). Daemon config is validated
 * at parse time, so this stays lenient like its siblings: absent or
 * malformed input means "follow upstream default", never a guess.
 */
export function normalizeBridgeByteLimit(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Bridge-side agent-child env list normalizer (acpx 0.21). Daemon config is
 * validated at parse time, so this stays lenient like its siblings: absent or
 * malformed input means "not configured" (upstream inherit-everything), never
 * a guess. An empty array is meaningful and passes through as set.
 */
export function normalizeBridgeAgentEnvList(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    return undefined;
  }
  return parsed as string[];
}
