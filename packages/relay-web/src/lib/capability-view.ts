import type { AgentCapabilityState, EffortView } from "@ganglion/xacpx-relay-protocol";

/**
 * A failed effort refresh must not wipe a legal effort list the user already has.
 * A successful known list replaces it.
 */
export function mergeEffortRefresh(
  previous: AgentCapabilityState | undefined,
  next: AgentCapabilityState,
): { state: AgentCapabilityState; efforts: EffortView | undefined } {
  const previousEfforts = effortsOf(previous);
  if (next.status === "error") {
    return { state: next, efforts: previousEfforts?.status === "known" ? previousEfforts : undefined };
  }
  if (next.efforts.status === "unavailable" && previousEfforts?.status === "known") {
    return { state: next, efforts: previousEfforts };
  }
  return { state: next, efforts: "efforts" in next ? next.efforts : undefined };
}

function effortsOf(state: AgentCapabilityState | undefined): EffortView | undefined {
  if (!state || state.status === "error" || !("efforts" in state)) return undefined;
  return state.efforts;
}
