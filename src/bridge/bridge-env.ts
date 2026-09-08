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
