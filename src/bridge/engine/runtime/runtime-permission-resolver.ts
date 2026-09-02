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

function normalizeMatcher(value: string): string {
  return value.trim().toLowerCase();
}

function readToolNameFromReq(req: RuntimePermissionRequest): string | undefined {
  const raw = req.raw as unknown as Record<string, unknown>;
  const toolCall = (raw.toolCall ?? raw.tool ?? raw) as Record<string, unknown> | undefined;
  if (!toolCall || typeof toolCall !== "object") return undefined;
  const nameKeys = ["name", "tool", "toolName"] as const;
  for (const k of nameKeys) {
    const v = toolCall[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  if (typeof toolCall.title === "string" && toolCall.title.trim().length > 0) {
    const head = toolCall.title.split(/[:\s]/, 1)[0]?.trim();
    if (head) return head;
  }
  return undefined;
}

function readTitleFromReq(req: RuntimePermissionRequest): string | undefined {
  const raw = req.raw as unknown as Record<string, unknown>;
  const toolCall = (raw.toolCall ?? raw.tool ?? raw) as Record<string, unknown> | undefined;
  if (toolCall && typeof toolCall === "object" && typeof toolCall.title === "string" && toolCall.title.trim().length > 0) {
    return toolCall.title.trim();
  }
  return undefined;
}

function readRawKindFromReq(req: RuntimePermissionRequest): string | undefined {
  const raw = req.raw as unknown as Record<string, unknown>;
  const toolCall = (raw.toolCall ?? raw.tool ?? raw) as Record<string, unknown> | undefined;
  if (toolCall && typeof toolCall === "object" && typeof toolCall.kind === "string" && toolCall.kind.trim().length > 0) {
    return toolCall.kind.trim();
  }
  return undefined;
}

function inferToolKindForReq(req: RuntimePermissionRequest): string | undefined {
  if (req.inferredKind && typeof req.inferredKind === "string" && req.inferredKind.trim().length > 0) {
    return normalizeMatcher(req.inferredKind);
  }
  const title = readTitleFromReq(req);
  if (title) {
    const head = title.split(":", 1)[0]?.trim().toLowerCase();
    if (head) {
      if (head.includes("read") || head.includes("search")) return head.includes("search") ? "search" : "read";
      if (head.includes("think")) return "think";
      return head;
    }
  }
  return undefined;
}

function permissionMatchTokens(req: RuntimePermissionRequest): string[] {
  const tokens = new Set<string>();
  const kind = inferToolKindForReq(req);
  const rawKind = readRawKindFromReq(req);
  const title = readTitleFromReq(req);
  const toolName = readToolNameFromReq(req);
  for (const value of [kind, rawKind, title, toolName] as (string | undefined)[]) {
    if (typeof value === "string" && value.trim().length > 0) tokens.add(normalizeMatcher(value));
  }
  if (title) {
    const head = title.split(/[:\s]/, 1)[0]?.trim();
    if (head) tokens.add(normalizeMatcher(head));
  }
  return [...tokens];
}

function findPolicyRule(rules: string[] | undefined, req: RuntimePermissionRequest): string | undefined {
  if (!rules || rules.length === 0) return undefined;
  const tokens = permissionMatchTokens(req);
  for (const rule of rules) {
    const normalized = normalizeMatcher(rule);
    if (normalized === "*" || tokens.includes(normalized)) return rule;
  }
  return undefined;
}

function inferIsReadOrSearch(req: RuntimePermissionRequest): boolean {
  const k = inferToolKindForReq(req);
  return k === "read" || k === "search";
}

export class RuntimePermissionResolver {
  resolve(
    config: RuntimePermissionConfig,
    req: RuntimePermissionRequest,
    signal?: AbortSignal,
  ): RuntimePermissionDecision {
    if (signal?.aborted) return { outcome: "reject_once" };
    // Fail-closed on malformed raw that cannot be serialized (circular/BigInt etc.) — even approve-all must reject
    try {
      const rawAny: any = req.raw;
      const input = rawAny?.toolCall?.input ?? rawAny?.tool?.input ?? rawAny?.input;
      if (input !== undefined) JSON.stringify(input);
    } catch {
      throw new Error("malformed raw input");
    }
    const policy = config.permissionPolicy;

    const denyRule = findPolicyRule(policy?.autoDeny, req);
    if (denyRule) return { outcome: "reject_once" };
    const approveRule = findPolicyRule(policy?.autoApprove, req);
    if (approveRule) return { outcome: "allow_once" };
    const escalateRule = findPolicyRule(policy?.escalate, req);
    if (escalateRule) return { outcome: "reject_once" };
    if (policy?.defaultAction) {
      if (policy.defaultAction === "approve") return { outcome: "allow_once" };
      if (policy.defaultAction === "deny") return { outcome: "reject_once" };
      if (policy.defaultAction === "escalate") return { outcome: "reject_once" };
    }

    if (config.permissionMode === "approve-all") return { outcome: "allow_once" };
    if (config.permissionMode === "deny-all") return { outcome: "reject_once" };
    if (config.permissionMode === "approve-reads") {
      if (inferIsReadOrSearch(req)) return { outcome: "allow_once" };
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
