import type { ConversationRunDto, ConversationRunStateDto, TopicSummaryDto } from "@ganglion/xacpx-relay-protocol";

export function isActiveRunState(state: ConversationRunStateDto | undefined): boolean {
  return state === "queued" || state === "running" || state === "waiting-human" || state === "paused";
}

export function compareTopicsByCreatedAtDesc(a: TopicSummaryDto, b: TopicSummaryDto): number {
  const at = Date.parse(a.createdAt);
  const bt = Date.parse(b.createdAt);
  const aValid = Number.isFinite(at);
  const bValid = Number.isFinite(bt);
  if (aValid !== bValid) return aValid ? -1 : 1;
  if (!aValid) return a.id.localeCompare(b.id);
  return bt - at || a.id.localeCompare(b.id);
}

export function sortTopicsNewestFirst(topics: TopicSummaryDto[]): TopicSummaryDto[] {
  return [...topics].sort(compareTopicsByCreatedAtDesc);
}

export interface TopicActiveRun {
  topicId: string;
  runId: string;
  state?: ConversationRunStateDto;
}

export interface TopicRunsAuthority {
  runs?: ConversationRunDto[];
  activeRunId?: string;
  activeRun?: ConversationRunDto;
}

export type TopicActiveRunProbeResult =
  | { status: "complete"; activeByTopicId: Record<string, TopicActiveRun> }
  | { status: "timeout" };

export const EXECUTING_TOPIC_PROBE_TIMEOUT_MS = 2000;

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
