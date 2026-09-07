import { reactive } from "vue";

/** Finished turns collapse their activity trace (reasoning / tool / subagent cards)
 *  into one header row; the user's expand toggles are remembered here, keyed by
 *  traceKey (`id:<n>` on persisted rows, `t:<startedAt>` on optimistic flush rows —
 *  both stable across hub history convergence, which REPLACES the message row and
 *  rebuilds the TurnParts component; component-local state would silently reset).
 *  Reactive so TurnParts computeds re-evaluate on toggle. Intentionally unbounded
 *  and session-scoped: entries are tiny strings and the set dies with the page. */
export const expandedTraces = reactive(new Set<string>());
