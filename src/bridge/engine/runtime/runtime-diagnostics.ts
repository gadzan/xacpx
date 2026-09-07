/**
 * Engine-neutral diagnostics snapshot (PR9-D, spec 7-8).
 * No secrets: never includes API key, full env, policy secret, credential, or unrestricted rawInput.
 */

export interface SessionUsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  updatedAt?: string;
  source: "cli" | "runtime";
}

export interface RuntimeDiagnosticsSnapshot {
  logicalSessionId: string;
  engine: "cli" | "runtime";
  eligible: boolean;
  ineligibleReason?: string;
  worker?: {
    pid?: number;
    generation?: string;
    lifecycle?: string;
    warm: boolean;
  };
  queue: {
    depth: number;
    suspended: boolean;
  };
  permission: {
    generation: number;
    mode: string;
    interactiveAvailable: boolean;
  };
  mcp: {
    coordinatorSession?: string;
    sourceHandle?: string;
    staleAfterTurn?: boolean;
  };
  compatibility: {
    acpxVersion: string;
    runtimeImportOk: boolean;
    contractProbeOk: boolean;
  };
  lastErrorCode?: string;
}

export function createUsageSnapshot(
  usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; totalTokens?: number; costUsd?: number },
  source: "cli" | "runtime",
): SessionUsageSnapshot {
  // Rule: undefined stays undefined, never coerce to 0
  // Replace semantics: new snapshot replaces old, do not add
  return {
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
    ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
    ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
    updatedAt: new Date().toISOString(),
    source,
  };
}

export function mergeUsageSnapshots(
  prev: SessionUsageSnapshot | undefined,
  next: SessionUsageSnapshot,
): SessionUsageSnapshot {
  // Replace, not add; but keep previous if next is missing fields? No, replace entirely
  // However, if next has undefined for a field that prev had, we keep undefined (unknown) not prev's value
  // This ensures missing = unknown, not zero, and no double count
  return next;
}
