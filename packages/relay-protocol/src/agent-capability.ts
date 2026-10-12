/**
 * Wire state for `control.agents.capabilities.get`.
 *
 * `loading` is a client-only view. The server returns one settled state.
 * Ready always carries at least one adapter-verified model. Unsupported,
 * needs-setup, and error always carry a reason. A suggestion is never
 * retagged as an adapter result.
 */

export type CapabilityModelSource = "adapter" | "suggestion";

export interface CapabilityModel {
  /** Opaque adapter id. Callers pass it through unchanged. */
  modelId: string;
  name: string;
  source: CapabilityModelSource;
}

export interface CapabilityEffort {
  id: string;
  name: string;
  source: CapabilityModelSource;
}

export type CapabilityFetchSource = "runtime" | "cache" | "session" | "probe";

export type CapabilityReasonCode =
  | "adapter-cannot-enumerate"
  | "probe-unavailable"
  | "unauthenticated"
  | "discovery-available"
  | "timeout"
  | "transport"
  | "invalid-context"
  | "cleanup"
  | "stale-response";

export interface CapabilityReason {
  code: CapabilityReasonCode;
  message: string;
}

/**
 * How the selected id relates to the model the adapter is actually using.
 * `in-effect` is the only variant that claims the selected id took effect.
 */
export type SelectionEffect =
  | { kind: "default"; appliedModelId?: string }
  | { kind: "saved"; modelId: string; advertised: boolean; appliedModelId?: string }
  | { kind: "in-effect"; modelId: string }
  | { kind: "fell-back"; selectedModelId: string; appliedModelId: string };

export type EffortView =
  | { status: "known"; options: CapabilityEffort[]; current?: string }
  | { status: "unavailable" };

interface CapabilitySelection {
  selectedModelId?: string;
  selectedEffort?: string;
  effect: SelectionEffect;
}

export interface ReadyCapability extends CapabilitySelection {
  status: "ready";
  models: [CapabilityModel, ...CapabilityModel[]];
  suggestions: CapabilityModel[];
  efforts: EffortView;
  fetchedAt: string;
  source: CapabilityFetchSource;
  /** Set only when this result was read from the target's own runtime. */
  appliedModelId?: string;
}

export interface UnsupportedCapability extends CapabilitySelection {
  status: "unsupported";
  reason: CapabilityReason;
  recovery: string;
  fetchedAt: string;
  suggestions: CapabilityModel[];
  efforts: EffortView;
}

export interface NeedsSetupCapability extends CapabilitySelection {
  status: "needs-setup";
  reason: CapabilityReason;
  recovery: string;
  fetchedAt: string;
  suggestions: CapabilityModel[];
  efforts: EffortView;
}

export interface ErrorCapability {
  status: "error";
  reason: CapabilityReason;
  recovery: string;
  fetchedAt: string;
  selectedModelId?: string;
  selectedEffort?: string;
}

export type AgentCapabilityState =
  | ReadyCapability
  | UnsupportedCapability
  | NeedsSetupCapability
  | ErrorCapability;

const REASON_CODES = new Set<CapabilityReasonCode>([
  "adapter-cannot-enumerate",
  "probe-unavailable",
  "unauthenticated",
  "discovery-available",
  "timeout",
  "transport",
  "invalid-context",
  "cleanup",
  "stale-response",
]);

const FETCH_SOURCES = new Set<CapabilityFetchSource>(["runtime", "cache", "session", "probe"]);

export function classifySelection(input: {
  selectedModelId?: string;
  appliedModelId?: string;
  advertisedIds: readonly string[];
}): SelectionEffect {
  const selected = normalizeOptional(input.selectedModelId);
  const applied = normalizeOptional(input.appliedModelId);
  const advertised = new Set(input.advertisedIds);
  if (!selected || selected.toLowerCase() === "default") {
    return applied ? { kind: "default", appliedModelId: applied } : { kind: "default" };
  }
  if (applied && applied === selected) return { kind: "in-effect", modelId: selected };
  if (applied && !advertised.has(selected)) {
    return { kind: "fell-back", selectedModelId: selected, appliedModelId: applied };
  }
  return {
    kind: "saved",
    modelId: selected,
    advertised: advertised.has(selected),
    ...(applied ? { appliedModelId: applied } : {}),
  };
}

export function adapterModels(ids: readonly { modelId: string; name?: string }[]): CapabilityModel[] {
  const seen = new Set<string>();
  const models: CapabilityModel[] = [];
  for (const entry of ids) {
    const modelId = entry.modelId.trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    const name = entry.name?.trim();
    models.push({ modelId, name: name && name.length > 0 ? name : modelId, source: "adapter" });
  }
  return models;
}

export function suggestionModels(ids: readonly string[]): CapabilityModel[] {
  const seen = new Set<string>();
  const models: CapabilityModel[] = [];
  for (const raw of ids) {
    const modelId = raw.trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    models.push({ modelId, name: modelId, source: "suggestion" });
  }
  return models;
}

export function knownEfforts(ids: readonly string[], current?: string): EffortView {
  const seen = new Set<string>();
  const options: CapabilityEffort[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    options.push({ id, name: id, source: "adapter" });
  }
  const normalized = normalizeOptional(current);
  return {
    status: "known",
    options,
    ...(normalized && seen.has(normalized) ? { current: normalized } : {}),
  };
}

export interface CapabilityDraft {
  fetchedAt: string;
  suggestions?: readonly string[];
  selectedModelId?: string;
  selectedEffort?: string;
  appliedModelId?: string;
  efforts?: EffortView;
}

export function readyCapability(
  source: CapabilityFetchSource,
  models: readonly { modelId: string; name?: string }[],
  draft: CapabilityDraft,
): ReadyCapability {
  const adapter = adapterModels(models);
  const first = adapter[0];
  if (!first) throw new Error("ready capability requires at least one adapter model");
  const advertisedIds = adapter.map((model) => model.modelId);
  const appliedModelId = source === "runtime" ? normalizeOptional(draft.appliedModelId) : undefined;
  const selectedModelId = normalizeOptional(draft.selectedModelId);
  return {
    status: "ready",
    models: adapter as [CapabilityModel, ...CapabilityModel[]],
    suggestions: suggestionModels(draft.suggestions ?? []).filter((model) => !advertisedIds.includes(model.modelId)),
    efforts: draft.efforts ?? { status: "unavailable" },
    fetchedAt: draft.fetchedAt,
    source,
    ...(appliedModelId ? { appliedModelId } : {}),
    ...(selectedModelId ? { selectedModelId } : {}),
    ...(normalizeOptional(draft.selectedEffort) ? { selectedEffort: draft.selectedEffort!.trim() } : {}),
    effect: classifySelection({ selectedModelId, appliedModelId, advertisedIds }),
  };
}

export function unsupportedCapability(
  reason: CapabilityReason,
  recovery: string,
  draft: CapabilityDraft,
): UnsupportedCapability {
  return {
    status: "unsupported",
    ...closedFailure(reason, recovery, draft),
  };
}

export function needsSetupCapability(
  reason: CapabilityReason,
  recovery: string,
  draft: CapabilityDraft,
): NeedsSetupCapability {
  return {
    status: "needs-setup",
    ...closedFailure(reason, recovery, draft),
  };
}

export function errorCapability(reason: CapabilityReason, recovery: string, draft: Pick<CapabilityDraft, "fetchedAt" | "selectedModelId" | "selectedEffort">): ErrorCapability {
  assertReason(reason);
  if (!recovery.trim()) throw new Error("capability error requires a recovery hint");
  const selectedModelId = normalizeOptional(draft.selectedModelId);
  const selectedEffort = normalizeOptional(draft.selectedEffort);
  return {
    status: "error",
    reason,
    recovery,
    fetchedAt: draft.fetchedAt,
    ...(selectedModelId ? { selectedModelId } : {}),
    ...(selectedEffort ? { selectedEffort } : {}),
  };
}

const STALE_FETCHED_AT = "1970-01-01T00:00:00.000Z";

/** Boundary parse. An old or partial payload becomes `error` / `stale-response`, never an empty model list. */
export function parseAgentCapabilityState(value: unknown): AgentCapabilityState {
  if (!isRecord(value) || typeof value.status !== "string") return stale("capability response is missing a status");
  if (value.status === "ready") return parseReady(value);
  if (value.status === "unsupported" || value.status === "needs-setup") return parseClosed(value.status, value);
  if (value.status === "error") return parseError(value);
  return stale(`capability status "${value.status}" is not recognized`);
}

function parseReady(value: Record<string, unknown>): AgentCapabilityState {
  if (!isFetchSource(value.source) || typeof value.fetchedAt !== "string") return stale("ready capability is missing source or fetchedAt");
  if (!Array.isArray(value.models) || value.models.length === 0) return stale("ready capability has no adapter models");
  const models: Array<{ modelId: string; name?: string }> = [];
  for (const entry of value.models) {
    if (!isRecord(entry) || typeof entry.modelId !== "string" || entry.source !== "adapter") {
      return stale("ready capability contains a non-adapter model");
    }
    models.push({ modelId: entry.modelId, ...(typeof entry.name === "string" ? { name: entry.name } : {}) });
  }
  try {
    return readyCapability(value.source, models, {
      fetchedAt: value.fetchedAt,
      suggestions: stringIds(value.suggestions, "modelId"),
      selectedModelId: optionalString(value.selectedModelId),
      selectedEffort: optionalString(value.selectedEffort),
      appliedModelId: value.source === "runtime" ? optionalString(value.appliedModelId) : undefined,
      efforts: parseEfforts(value.efforts),
    });
  } catch {
    return stale("ready capability could not be constructed");
  }
}

function parseClosed(status: "unsupported" | "needs-setup", value: Record<string, unknown>): AgentCapabilityState {
  const reason = parseReason(value.reason);
  if (!reason || typeof value.recovery !== "string" || !value.recovery.trim() || typeof value.fetchedAt !== "string") {
    return stale(`${status} capability is missing a reason or recovery hint`);
  }
  const draft: CapabilityDraft = {
    fetchedAt: value.fetchedAt,
    suggestions: stringIds(value.suggestions, "modelId"),
    selectedModelId: optionalString(value.selectedModelId),
    selectedEffort: optionalString(value.selectedEffort),
    efforts: parseEfforts(value.efforts),
  };
  return status === "unsupported"
    ? unsupportedCapability(reason, value.recovery, draft)
    : needsSetupCapability(reason, value.recovery, draft);
}

function parseError(value: Record<string, unknown>): AgentCapabilityState {
  const reason = parseReason(value.reason);
  if (!reason || typeof value.recovery !== "string" || !value.recovery.trim()) {
    return stale("error capability is missing a reason or recovery hint");
  }
  return errorCapability(reason, value.recovery, {
    fetchedAt: typeof value.fetchedAt === "string" ? value.fetchedAt : STALE_FETCHED_AT,
    selectedModelId: optionalString(value.selectedModelId),
    selectedEffort: optionalString(value.selectedEffort),
  });
}

function stale(message: string): ErrorCapability {
  return errorCapability(
    { code: "stale-response", message },
    "Reconnect a current connector, or fetch the model list again.",
    { fetchedAt: STALE_FETCHED_AT },
  );
}

function closedFailure(reason: CapabilityReason, recovery: string, draft: CapabilityDraft): Omit<UnsupportedCapability, "status"> {
  assertReason(reason);
  if (!recovery.trim()) throw new Error("capability failure requires a recovery hint");
  const selectedModelId = normalizeOptional(draft.selectedModelId);
  const selectedEffort = normalizeOptional(draft.selectedEffort);
  const advertised: string[] = [];
  return {
    reason,
    recovery,
    fetchedAt: draft.fetchedAt,
    suggestions: suggestionModels(draft.suggestions ?? []),
    efforts: draft.efforts ?? { status: "unavailable" },
    ...(selectedModelId ? { selectedModelId } : {}),
    ...(selectedEffort ? { selectedEffort } : {}),
    effect: classifySelection({ selectedModelId, advertisedIds: advertised }),
  };
}

function assertReason(reason: CapabilityReason): void {
  if (!REASON_CODES.has(reason.code) || !reason.message.trim()) {
    throw new Error("capability reason requires a known code and a message");
  }
}

function parseReason(value: unknown): CapabilityReason | undefined {
  if (!isRecord(value) || typeof value.code !== "string" || typeof value.message !== "string") return undefined;
  if (!REASON_CODES.has(value.code as CapabilityReasonCode) || !value.message.trim()) return undefined;
  return { code: value.code as CapabilityReasonCode, message: value.message };
}

function parseEfforts(value: unknown): EffortView {
  if (!isRecord(value)) return { status: "unavailable" };
  if (value.status === "unavailable") return { status: "unavailable" };
  if (value.status !== "known" || !Array.isArray(value.options)) return { status: "unavailable" };
  const ids: string[] = [];
  for (const option of value.options) {
    if (!isRecord(option) || typeof option.id !== "string" || option.source !== "adapter") continue;
    ids.push(option.id);
  }
  return knownEfforts(ids, optionalString(value.current));
}

function stringIds(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => (isRecord(entry) && typeof entry[key] === "string" ? [entry[key]] : []));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isFetchSource(value: unknown): value is CapabilityFetchSource {
  return typeof value === "string" && FETCH_SOURCES.has(value as CapabilityFetchSource);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
