import { readFileSync } from "node:fs";

export interface XacpxPermissionPolicy {
  autoApprove?: string[];
  autoDeny?: string[];
  escalate?: string[];
  defaultAction?: "approve" | "deny" | "escalate";
}

const VALID_ACTIONS = new Set(["approve", "deny", "escalate"]);

function isNonEmptyStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return false;
  for (const v of value) {
    if (typeof v !== "string" || v.length === 0) return false;
  }
  return true;
}

export function parseXacpxPermissionPolicy(input: unknown): XacpxPermissionPolicy {
  if (input === undefined) return {};
  if (input === null) throw new Error("permission policy must be a JSON object (got null)");
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.length === 0) throw new Error("permission policy string must not be empty");
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(input);
        return parseXacpxPermissionPolicy(parsed);
      } catch (err) {
        throw new Error(`invalid permission policy JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // File path case: try to read file synchronously (fail closed if unreadable)
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const content = readFileSync(trimmed, "utf8");
      const parsed = JSON.parse(content);
      return parseXacpxPermissionPolicy(parsed);
    } catch (err) {
      throw new Error(`invalid permission policy file "${trimmed}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (Array.isArray(input)) throw new Error("permission policy must be a JSON object (got array)");
  if (typeof input !== "object") throw new Error("permission policy must be a JSON object");
  const rec = input as Record<string, unknown>;
  const out: XacpxPermissionPolicy = {};
  const allowedKeys = new Set(["autoApprove", "autoDeny", "escalate", "defaultAction"]);
  for (const key of Object.keys(rec)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`unknown permission policy field "${key}"`);
    }
  }
  if ("autoApprove" in rec) {
    if (!isNonEmptyStringArray(rec.autoApprove)) throw new Error("autoApprove must be string[] with non-empty strings");
    out.autoApprove = rec.autoApprove as string[];
  }
  if ("autoDeny" in rec) {
    if (!isNonEmptyStringArray(rec.autoDeny)) throw new Error("autoDeny must be string[] with non-empty strings");
    out.autoDeny = rec.autoDeny as string[];
  }
  if ("escalate" in rec) {
    if (!isNonEmptyStringArray(rec.escalate)) throw new Error("escalate must be string[] with non-empty strings");
    out.escalate = rec.escalate as string[];
  }
  if ("defaultAction" in rec) {
    const v = rec.defaultAction;
    if (typeof v !== "string" || !VALID_ACTIONS.has(v)) throw new Error(`invalid defaultAction "${String(v)}"`);
    out.defaultAction = v as XacpxPermissionPolicy["defaultAction"];
  }
  return out;
}

export function isEligibleForRuntime(
  policy: XacpxPermissionPolicy | undefined,
  nonInteractivePermissions: string | undefined,
  interactiveAvailable = false,
): boolean {
  if (nonInteractivePermissions === "fail") return false;
  if (!interactiveAvailable) {
    if (policy?.escalate && policy.escalate.length > 0) return false;
    if (policy?.defaultAction === "escalate") return false;
  }
  return true;
}
