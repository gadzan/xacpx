import type { AgentCapabilityState, EffortView } from "@ganglion/xacpx-relay-protocol";

function normalized(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * An effort list belongs to exactly one model. A `forModelId` that names a
 * different model hides the options; an untagged (legacy daemon) list stays
 * visible. An empty pick means the agent default, which matches only when the
 * scope names the model actually in effect.
 */
export function effortsForModel(
  state: AgentCapabilityState | undefined,
  modelId: string,
  appliedModelId?: string,
): EffortView | undefined {
  const efforts = effortsOf(state);
  if (efforts?.status !== "known") return undefined;
  if (!efforts.forModelId) return efforts;
  const picked = normalized(modelId);
  if (picked && efforts.forModelId === picked) return efforts;
  if (!picked && normalized(appliedModelId) === efforts.forModelId) return efforts;
  return undefined;
}

/**
 * Tag an untagged known list with the model in effect when it was read, so a
 * later model switch can hide it. A list the daemon already scoped keeps its
 * scope; a cold-probe list is never a known effort source.
 */
export function tagEffortScope(
  state: AgentCapabilityState,
  modelId: string | undefined,
): AgentCapabilityState {
  if (!("efforts" in state) || state.efforts.status !== "known") return state;
  // A cold probe never yields known efforts, scoped or not.
  if (state.status === "ready" && state.source === "probe") {
    return { ...state, efforts: { status: "unavailable" } };
  }
  if (state.efforts.forModelId) return state;
  const scope = normalized(modelId);
  if (!scope) return state;
  return { ...state, efforts: { ...state.efforts, forModelId: scope } };
}

/**
 * A failed effort refresh must not wipe a legal effort list the user already has.
 * A successful known list replaces it. A carried list never changes scope: when
 * the model moved on since the read, the carry is dropped instead of posing as
 * the new model's options. A cold probe never yields known efforts.
 */
export function mergeEffortRefresh(
  previous: AgentCapabilityState | undefined,
  next: AgentCapabilityState,
  currentModelId?: string,
): { state: AgentCapabilityState; efforts: EffortView | undefined } {
  const previousEfforts = effortsOf(previous);
  const current = normalized(currentModelId);
  // A scope never widens: a tagged list survives only when the model in
  // effect still names it. An empty pick with no applied model proves
  // nothing, so it drops a tagged carry instead of showing it.
  const fits = (efforts: EffortView): boolean =>
    efforts.status !== "known" || !efforts.forModelId || efforts.forModelId === current;
  if (next.status === "error") {
    const carried = previousEfforts?.status === "known" ? previousEfforts : undefined;
    return { state: next, efforts: carried && fits(carried) ? carried : undefined };
  }
  const tagged = tagEffortScope(next, currentModelId);
  const nextEfforts = effortsOf(tagged);
  // A known list scoped to another model stays truthful in the state, but it
  // is not this model's fallback: the picker hides it via effortsForModel.
  if (nextEfforts?.status === "known") {
    return { state: tagged, efforts: fits(nextEfforts) ? nextEfforts : undefined };
  }
  if (previousEfforts?.status === "known" && fits(previousEfforts)) {
    return { state: tagged, efforts: previousEfforts };
  }
  return { state: tagged, efforts: nextEfforts };
}

function effortsOf(state: AgentCapabilityState | undefined): EffortView | undefined {
  if (!state || state.status === "error" || !("efforts" in state)) return undefined;
  return state.efforts;
}
