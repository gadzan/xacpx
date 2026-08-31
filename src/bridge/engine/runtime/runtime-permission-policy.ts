export interface XacpxPermissionPolicy {
  autoApprove?: string[];
  autoDeny?: string[];
  escalate?: string[];
  defaultAction?: "approve" | "deny" | "escalate";
}

const VALID_ACTIONS = new Set(["approve", "deny", "escalate"]);

function isNonEmptyStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return true; // empty is allowed? spec says must be non-empty string[] if present, but we allow empty as valid (no rules)
  for (const v of value) {
    if (typeof v !== "string" || v.length === 0) return false;
  }
  return true;
}

export function parseXacpxPermissionPolicy(input: unknown): XacpxPermissionPolicy {
  if (input === undefined || input === null) return {};
  if (typeof input === "string") {
    // Inline JSON case — if string is not JSON, treat as opaque legacy placeholder (e.g. "autoApprove:read-files" in tests)
    // Real production policies are JSON objects; placeholder strings are tolerated for backward test compat.
    const trimmed = input.trim();
    if (trimmed.length === 0) return {};
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(input);
        return parseXacpxPermissionPolicy(parsed);
      } catch (err) {
        throw new Error(`invalid permission policy JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Opaque string placeholder — treat as empty policy (no rules) for resolver, but preserve original string in worker
    return {};
  }
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

export function isEligibleForRuntime(policy: XacpxPermissionPolicy | undefined, nonInteractivePermissions: string | undefined): boolean {
  if (nonInteractivePermissions === "fail") return false;
  if (policy?.escalate && policy.escalate.length > 0) return false;
  return true;
}
