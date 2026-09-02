import { parseXacpxPermissionPolicy, type XacpxPermissionPolicy } from "./runtime-permission-policy";

export interface RuntimePermissionRequest {
  sessionId: string;
  raw: unknown;
  inferredKind?: string;
}
export type RuntimePermissionDecision = { outcome: "allow_once" | "allow_always" | "reject_once" | "reject_always" | "cancel" };
export type EvaluatedPermissionDecision = { outcome: "allow_once" | "reject_once" | "needs_interaction" };

export interface RuntimePermissionConfig {
  generation: number;
  permissionMode: "approve-all" | "approve-reads" | "deny-all";
  nonInteractivePermissions: "deny" | "fail";
  permissionPolicy?: XacpxPermissionPolicy;
}

function normalizeMatcher(value: string): string {
  return value.trim().toLowerCase();
}

function readStringProperty(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  for (const key of keys) {
    const entry = rec[key];
    if (typeof entry === "string" && entry.trim().length > 0) return entry.trim();
  }
  return undefined;
}
function readToolNameFromReq(req: RuntimePermissionRequest): string | undefined {
  const raw = req.raw as unknown as Record<string, unknown>;
  const toolCall = (raw.toolCall ?? raw.tool ?? raw) as Record<string, unknown> | undefined;
  if (!toolCall || typeof toolCall !== "object") return undefined;
  const fromRawInput = readStringProperty(toolCall.rawInput, ["name", "tool", "toolName"]);
  if (fromRawInput) return fromRawInput;
  const head = typeof toolCall.title === "string" ? toolCall.title.trim().split(/[:\s]/, 1)[0]?.trim() : undefined;
  return head && head.length > 0 ? head : undefined;
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
  evaluate(
    config: RuntimePermissionConfig,
    req: RuntimePermissionRequest,
    options: { signal?: AbortSignal; interactiveAvailable?: boolean } = {},
  ): EvaluatedPermissionDecision {
    if (options.signal?.aborted) return { outcome: "reject_once" };
    try {
      const rawObj = req.raw && typeof req.raw === "object" ? (req.raw as Record<string, unknown>) : undefined;
      const tc = rawObj?.toolCall && typeof rawObj.toolCall === "object" ? (rawObj.toolCall as Record<string, unknown>) : undefined;
      const tool = rawObj?.tool && typeof rawObj.tool === "object" ? (rawObj.tool as Record<string, unknown>) : undefined;
      const input = tc?.input ?? tool?.input ?? rawObj?.input;
      if (input !== undefined) JSON.stringify(input);
    } catch {
      throw new Error("malformed raw input");
    }
    const policy = config.permissionPolicy;

    // 1. autoDeny (highest precedence)
    const denyRule = findPolicyRule(policy?.autoDeny, req);
    if (denyRule) return { outcome: "reject_once" };

    // 2. autoApprove
    const approveRule = findPolicyRule(policy?.autoApprove, req);
    if (approveRule) return { outcome: "allow_once" };

    // 3. escalate
    const escalateRule = findPolicyRule(policy?.escalate, req);
    if (escalateRule) {
      return options.interactiveAvailable ? { outcome: "needs_interaction" } : { outcome: "reject_once" };
    }

    // 4. defaultAction
    if (policy?.defaultAction) {
      if (policy.defaultAction === "approve") return { outcome: "allow_once" };
      if (policy.defaultAction === "deny") return { outcome: "reject_once" };
      if (policy.defaultAction === "escalate") {
        return options.interactiveAvailable ? { outcome: "needs_interaction" } : { outcome: "reject_once" };
      }
    }

    // 5. permissionMode
    if (config.permissionMode === "approve-all") return { outcome: "allow_once" };
    if (config.permissionMode === "deny-all") return { outcome: "reject_once" };
    if (config.permissionMode === "approve-reads") {
      if (inferIsReadOrSearch(req)) return { outcome: "allow_once" };
      return options.interactiveAvailable ? { outcome: "needs_interaction" } : { outcome: "reject_once" };
    }

    return { outcome: "reject_once" };
  }

  resolve(
    config: RuntimePermissionConfig,
    req: RuntimePermissionRequest,
    signal?: AbortSignal,
  ): RuntimePermissionDecision {
    const evaluated = this.evaluate(config, req, { signal, interactiveAvailable: false });
    return { outcome: evaluated.outcome === "allow_once" ? "allow_once" : "reject_once" };
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
