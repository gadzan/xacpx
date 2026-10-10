/**
 * Bounded global admission for cross-Run execution (PR C).
 *
 * Per-Topic capacity already exists durably: `claimNextDispatch` counts a
 * Topic's `claimed` dispatches against `maxConcurrentMemberTurns`. That bounds
 * a single Topic, but with several Topics executing concurrently nothing bounds
 * the process total, so a busy host could start an unbounded number of Provider
 * turns at once.
 *
 * This module adds the missing global ceiling. It reuses the durable Topic
 * limits rather than inventing a parallel knob, and defaults to a finite value
 * so existing deployments gain a bound without any configuration change.
 *
 * It is admission control, not a work queue: a Run that exceeds the ceiling is
 * simply not started this pass and stays `pending` for a later pass. Nothing
 * durable is rewritten, so a crash mid-wait loses no state.
 */

/** Default global ceiling on concurrently executing member turns. */
export const DEFAULT_MAX_CONCURRENT_RUN_EXECUTIONS = 8;

/** Upper bound accepted from configuration, so a typo cannot disable the ceiling. */
export const MAX_CONCURRENT_RUN_EXECUTIONS_LIMIT = 64;

export interface GlobalAdmissionConfig {
  /** Configured ceiling. Undefined or invalid falls back to the default. */
  readonly maxConcurrentRunExecutions?: number;
}

/**
 * Effective global ceiling.
 *
 * Accepts only a positive integer within the limit; anything else (0, a
 * fraction, a negative, NaN, Infinity) falls back to the default rather than
 * being silently coerced to 0 or treated as unlimited.
 */
export function resolveMaxConcurrentRunExecutions(config?: GlobalAdmissionConfig): number {
  const configured = config?.maxConcurrentRunExecutions;
  if (configured === undefined) return DEFAULT_MAX_CONCURRENT_RUN_EXECUTIONS;
  if (!Number.isInteger(configured) || configured < 1 || configured > MAX_CONCURRENT_RUN_EXECUTIONS_LIMIT) {
    return DEFAULT_MAX_CONCURRENT_RUN_EXECUTIONS;
  }
  return configured;
}

/**
 * Whether one more execution may start, given how many are already running.
 *
 * Counts only physically executing turns. Writer-slot holds are capacity
 * reservations inside their own Topic's durable limit and are deliberately
 * excluded here: they hold no Provider turn, so counting them would let a
 * Topic park claims and starve the global ceiling without doing work.
 */
export function hasGlobalCapacity(activeExecutions: number, ceiling: number): boolean {
  return activeExecutions < ceiling;
}

/**
 * Round-robin fairness over Topics (PR C).
 *
 * Scheduling is fair at Topic granularity: a Topic that keeps receiving new
 * work must not starve the others. Each drain pass rotates the Topic scan
 * origin by one, so a Topic that just ran moves to the back of the queue and
 * every other ready Topic gets a turn before it can run again.
 *
 * Deterministic and testable: no randomness, no wall-clock weighting, and the
 * rotation is derived purely from the set of Topics that had work in the
 * previous pass.
 */
export class TopicFairnessRotator {
  private lastServed: string | undefined;

  /**
   * Order `candidates` for this pass. Topics are returned in a stable order
   * with the last-served Topic placed after every other candidate, so a
   * high-traffic Topic cannot monopolize consecutive passes.
   */
  order<T extends { topicId: string }>(candidates: readonly T[]): T[] {
    if (candidates.length < 2 || this.lastServed === undefined) {
      return [...candidates];
    }
    const pivot = candidates.findIndex((candidate) => candidate.topicId === this.lastServed);
    if (pivot < 0) {
      return [...candidates];
    }
    return [...candidates.slice(pivot + 1), ...candidates.slice(0, pivot + 1)];
  }

  /** Record the Topic that just received capacity, for the next rotation. */
  served(topicId: string): void {
    this.lastServed = topicId;
  }
}
