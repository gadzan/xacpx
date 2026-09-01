import { parseXacpxPermissionPolicy, type XacpxPermissionPolicy } from "./runtime-permission-policy";

export interface RuntimePermissionRequest {
  sessionId: string;
  raw: unknown;
  inferredKind?: string;
}
export type RuntimePermissionDecision = { outcome: "allow_once" | "allow_always" | "reject_once" | "reject_always" | "cancel" };

export interface RuntimePermissionConfig {
  generation: number;
  permissionMode: "approve-all" | "approve-reads" | "deny-all";
  nonInteractivePermissions: "deny" | "fail";
  permissionPolicy?: XacpxPermissionPolicy;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function globToRegExp(pattern: string): RegExp {
  // Convert a simple glob ( *, ?, ** ) to RegExp; ** matches any depth, * matches not slash, ? matches single
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
        // Consume following slash if any for **/
        if (pattern[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += ".";
    } else {
      re += escapeRegExp(c);
    }
  }
  return new RegExp(`^${re}$`);
}
function matchesRule(text: string, pattern: string): boolean {
  if (pattern === "*") return true;
  try {
    const re = globToRegExp(pattern);
    if (re.test(text)) return true;
  } catch {}
  if (text === pattern) return true;
  // For tool name matching: pattern "read" should match text "read {}" (tool name + args) but not "bread"
  const toolName = text.split(" ")[0] ?? "";
  if (toolName === pattern) return true;
  return false;
}

function requestTextForMatching(req: RuntimePermissionRequest): string {
  // req.raw is RequestPermissionRequest from ACP SDK: contains toolCall and options
  const raw = req.raw as unknown as Record<string, unknown>;
  // Try common fields: toolCall, tool, method, name
  const toolCall = raw.toolCall ?? raw.tool ?? raw;
  if (toolCall && typeof toolCall === "object") {
    const tc = toolCall as Record<string, unknown>;
    const name = typeof tc.name === "string" ? tc.name : typeof tc.tool === "string" ? tc.tool : "";
    const input = tc.input ? JSON.stringify(tc.input) : "";
    return `${name} ${input}`.trim();
  }
  return JSON.stringify(raw);
}

function inferIsReadOrSearch(req: RuntimePermissionRequest): boolean {
  const k = req.inferredKind;
  if (k === "read" || k === "search") return true;
  return false;
}

export class RuntimePermissionResolver {
  resolve(
    config: RuntimePermissionConfig,
    req: RuntimePermissionRequest,
    signal?: AbortSignal,
  ): RuntimePermissionDecision {
    if (signal?.aborted) return { outcome: "reject_once" };
    const policy = config.permissionPolicy;
    const text = requestTextForMatching(req);

    // 1. autoDeny beats autoApprove
    if (policy?.autoDeny) {
      for (const pat of policy.autoDeny) {
        if (matchesRule(text, pat) || matchesRule(req.inferredKind ?? "", pat)) {
          return { outcome: "reject_once" };
        }
      }
    }
    if (policy?.autoApprove) {
      for (const pat of policy.autoApprove) {
        if (matchesRule(text, pat) || matchesRule(req.inferredKind ?? "", pat)) {
          return { outcome: "allow_once" };
        }
      }
    }
    if (policy?.escalate) {
      for (const pat of policy.escalate) {
        if (matchesRule(text, pat) || matchesRule(req.inferredKind ?? "", pat)) {
          // Escalate requires interactive host — in Runtime we fail closed to reject
          return { outcome: "reject_once" };
        }
      }
    }
    if (policy?.defaultAction) {
      if (policy.defaultAction === "approve") return { outcome: "allow_once" };
      if (policy.defaultAction === "deny") return { outcome: "reject_once" };
      if (policy.defaultAction === "escalate") return { outcome: "reject_once" };
    }

    // Fallback to permissionMode
    if (config.permissionMode === "approve-all") return { outcome: "allow_once" };
    if (config.permissionMode === "deny-all") return { outcome: "reject_once" };
    if (config.permissionMode === "approve-reads") {
      if (inferIsReadOrSearch(req)) return { outcome: "allow_once" };
      // Non-read/search: interactive if supported, otherwise nonInteractivePermissions
      // For now, nonInteractivePermissions is deny or fail (fail is ineligible, so Runtime wouldn't be used)
      // So we map to reject
      if (config.nonInteractivePermissions === "deny") return { outcome: "reject_once" };
      return { outcome: "reject_once" };
    }
    return { outcome: "reject_once" };
  }

  safeResolve(config: RuntimePermissionConfig, req: RuntimePermissionRequest, signal?: AbortSignal): RuntimePermissionDecision {
    try {
      return this.resolve(config, req, signal);
    } catch {
      return { outcome: "reject_once" };
    }
  }
}

export function configFromRaw(generation: number, raw: { permissionMode: string; nonInteractivePermissions?: string; permissionPolicy?: unknown }): RuntimePermissionConfig {
  let policy: XacpxPermissionPolicy | undefined;
  if (raw.permissionPolicy !== undefined) {
    policy = parseXacpxPermissionPolicy(raw.permissionPolicy);
  }
  const mode = (raw.permissionMode === "approve-all" || raw.permissionMode === "approve-reads" || raw.permissionMode === "deny-all") ? raw.permissionMode : "deny-all";
  const nonInt = raw.nonInteractivePermissions === "fail" ? "fail" : "deny";
  return { generation, permissionMode: mode as RuntimePermissionConfig["permissionMode"], nonInteractivePermissions: nonInt as RuntimePermissionConfig["nonInteractivePermissions"], ...(policy ? { permissionPolicy: policy } : {}) };
}
