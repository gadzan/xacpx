import type { ConversationRunDto, ConversationRunStateDto, TopicSummaryDto } from "@ganglion/xacpx-relay-protocol";

/** The authoritative runs.list active-owner states (queued / running /
 *  waiting-human / paused). A paused Run still owns its Topic and its queued
 *  work, exactly like a running one. Single source: stores must not re-derive
 *  this predicate locally. */
export function isActiveRunState(state: ConversationRunStateDto | undefined): boolean {
  return state === "queued" || state === "running" || state === "waiting-human" || state === "paused";
}

/** Display comparator for Topics: createdAt descending (newest on top).
 *
 *  Fail-closed policy for an unparseable/missing createdAt: it must never win
 *  the top slot on corrupt data, so it sorts strictly below every valid row
 *  (treated as oldest). Ties break by id so the order is deterministic for
 *  equal timestamps. */
export function compareTopicsByCreatedAtDesc(a: TopicSummaryDto, b: TopicSummaryDto): number {
  const at = Date.parse(a.createdAt);
  const bt = Date.parse(b.createdAt);
  const aValid = Number.isFinite(at);
  const bValid = Number.isFinite(bt);
  if (aValid !== bValid) return aValid ? -1 : 1;
  if (!aValid) return a.id.localeCompare(b.id);
  return bt - at || a.id.localeCompare(b.id);
}

/** Newest-first copy; never mutates the caller's array (the raw Topic cache
 *  keeps the server's order, this is the presentation order). */
export function sortTopicsNewestFirst(topics: TopicSummaryDto[]): TopicSummaryDto[] {
  return [...topics].sort(compareTopicsByCreatedAtDesc);
}

/** Minimal projection of the authoritative active owner for one Topic:
 *  identity and state only — no timestamps or message heuristics. */
export interface TopicActiveRun {
  topicId: string;
  runId: string;
  state?: ConversationRunStateDto;
}

/** The part of a `control.runs.list` result that proves (or disproves) an
 *  executing owner for the Topic it was issued against. */
export interface TopicRunsAuthority {
  runs?: ConversationRunDto[];
  activeRunId?: string;
  activeRun?: ConversationRunDto;
}

export type TopicActiveRunProbeResult =
  | { status: "complete"; activeByTopicId: Record<string, TopicActiveRun> }
  | { status: "timeout" };

export const EXECUTING_TOPIC_PROBE_TIMEOUT_MS = 2000;

/** Ask the authoritative `runs.list` owner which Topics are executing.
 *
 *  One probe per Topic fires in parallel; a Topic counts as executing only
 *  when runs.list elects it an active owner (`activeRunId`, optionally proven
 *  against `isActiveRunState` when the row is present). The batch is raced
 *  against a deadline: any timeout — or any probe failure — means the map is
 *  not proven complete, and the caller must degrade to its plain default
 *  selection instead of trusting a partial answer. */
export async function probeExecutingTopics(
  topics: TopicSummaryDto[],
  listTopicRuns: (topicId: string) => Promise<TopicRunsAuthority>,
  timeoutMs: number = EXECUTING_TOPIC_PROBE_TIMEOUT_MS,
): Promise<TopicActiveRunProbeResult> {
  if (topics.length === 0) return { status: "complete", activeByTopicId: {} };
  const deadline = Promise.withResolvers<true>();
  const timer = setTimeout(() => deadline.resolve(true), timeoutMs);
  const timedOut = deadline.promise;
  try {
    const settled = await Promise.race([
      Promise.all(topics.map(async (topic) => {
        const listed = await listTopicRuns(topic.id);
        if (!listed.activeRunId) return [topic.id, null] as const;
        const row = listed.activeRun ?? listed.runs?.find((run) => run.id === listed.activeRunId);
        if (row?.state !== undefined && !isActiveRunState(row.state)) return [topic.id, null] as const;
        return [topic.id, { topicId: topic.id, runId: listed.activeRunId, ...(row?.state !== undefined ? { state: row.state } : {}) }] as const;
      })),
      timedOut,
    ]);
    if (settled === true) return { status: "timeout" };
    const activeByTopicId: Record<string, TopicActiveRun> = {};
    for (const [topicId, active] of settled) {
      if (active) activeByTopicId[topicId] = active;
    }
    return { status: "complete", activeByTopicId };
  } finally {
    clearTimeout(timer);
  }
}
