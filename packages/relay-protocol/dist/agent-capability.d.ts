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
export type CapabilityReasonCode = "adapter-cannot-enumerate" | "probe-unavailable" | "unauthenticated" | "discovery-available" | "timeout" | "transport" | "invalid-context" | "cleanup" | "stale-response";
export interface CapabilityReason {
    code: CapabilityReasonCode;
    message: string;
}
/**
 * How the selected id relates to the model the adapter is actually using.
 * `in-effect` is the only variant that claims the selected id took effect.
 */
export type SelectionEffect = {
    kind: "default";
    appliedModelId?: string;
} | {
    kind: "saved";
    modelId: string;
    advertised: boolean;
    appliedModelId?: string;
} | {
    kind: "in-effect";
    modelId: string;
} | {
    kind: "fell-back";
    selectedModelId: string;
    appliedModelId: string;
};
export type EffortView = {
    status: "known";
    options: CapabilityEffort[];
    current?: string;
    forModelId?: string;
} | {
    status: "unavailable";
};
interface CapabilitySelection {
    selectedModelId?: string;
    selectedEffort?: string;
    effect: SelectionEffect;
}
export type CapabilityFreshness = "fresh" | "stale";
export interface ReadyCapability extends CapabilitySelection {
    status: "ready";
    models: [CapabilityModel, ...CapabilityModel[]];
    suggestions: CapabilityModel[];
    efforts: EffortView;
    fetchedAt: string;
    source: CapabilityFetchSource;
    /**
     * Present only when the list is a preserved cache and the live re-verification
     * failed. The models stay usable; the reason explains why they are stale.
     */
    reason?: CapabilityReason;
    /** Set only when this result was read from the target's own runtime. */
    appliedModelId?: string;
    freshness?: CapabilityFreshness;
    refreshing?: boolean;
    lastVerifiedAt?: string;
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
/** The adapter answered but advertised no models. Never produced from a parse failure. */
export interface EmptyCapability {
    status: "empty";
    reason: CapabilityReason;
    recovery: string;
    fetchedAt: string;
    suggestions: CapabilityModel[];
    /** Always `unavailable`: with no models there is nothing to read efforts from. */
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
export type AgentCapabilityState = ReadyCapability | UnsupportedCapability | NeedsSetupCapability | EmptyCapability | ErrorCapability;
export declare function classifySelection(input: {
    selectedModelId?: string;
    appliedModelId?: string;
    advertisedIds: readonly string[];
}): SelectionEffect;
export declare function adapterModels(ids: readonly {
    modelId: string;
    name?: string;
}[]): CapabilityModel[];
export declare function suggestionModels(ids: readonly string[]): CapabilityModel[];
export declare function knownEfforts(ids: readonly string[], current?: string, forModelId?: string): EffortView;
export interface CapabilityDraft {
    fetchedAt: string;
    suggestions?: readonly string[];
    selectedModelId?: string;
    selectedEffort?: string;
    appliedModelId?: string;
    efforts?: EffortView;
    reason?: CapabilityReason;
    freshness?: CapabilityFreshness;
    refreshing?: boolean;
    lastVerifiedAt?: string;
}
export declare function readyCapability(source: CapabilityFetchSource, models: readonly {
    modelId: string;
    name?: string;
}[], draft: CapabilityDraft): ReadyCapability;
export declare function unsupportedCapability(reason: CapabilityReason, recovery: string, draft: CapabilityDraft): UnsupportedCapability;
export declare function needsSetupCapability(reason: CapabilityReason, recovery: string, draft: CapabilityDraft): NeedsSetupCapability;
export declare function emptyCapability(reason: CapabilityReason, recovery: string, draft: Pick<CapabilityDraft, "fetchedAt" | "suggestions">): EmptyCapability;
export declare function errorCapability(reason: CapabilityReason, recovery: string, draft: Pick<CapabilityDraft, "fetchedAt" | "selectedModelId" | "selectedEffort">): ErrorCapability;
/** Boundary parse. An old or partial payload becomes `error` / `stale-response`, never an empty model list. */
export declare function parseAgentCapabilityState(value: unknown): AgentCapabilityState;
export {};
