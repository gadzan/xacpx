import { describe, expect, it, vi } from "vitest";
import type { ConversationRunDto, TopicSummaryDto } from "@ganglion/xacpx-relay-protocol";
import {
  compareTopicsByCreatedAtDesc,
  probeExecutingTopics,
  type TopicRunsAuthority,
} from "../lib/topic-order";

function topic(id: string, createdAt: string): TopicSummaryDto {
  return { id, conversationId: "c1", title: id, status: "active", createdAt, updatedAt: createdAt };
}

function run(id: string, topicId: string): ConversationRunDto {
  return { id, conversationId: "c1", topicId, requestMessageId: "m", requestId: "r", mode: "explicit", state: "running", profileRevision: 1, createdAt: "now" };
}

describe("compareTopicsByCreatedAtDesc", () => {
  it("orders newest first and breaks ties deterministically by id", () => {
    const sorted = [topic("b", "2026-02-01T00:00:00.000Z"), topic("a", "2026-02-01T00:00:00.000Z"), topic("c", "2026-01-01T00:00:00.000Z")]
      .sort(compareTopicsByCreatedAtDesc);
    expect(sorted.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("sinks an unparseable createdAt below every valid row instead of throwing or promoting it", () => {
    const sorted = [topic("bad", "not-a-date"), topic("new", "2026-05-01T00:00:00.000Z"), topic("old", "2026-01-01T00:00:00.000Z")]
      .sort(compareTopicsByCreatedAtDesc);
    expect(sorted.map((t) => t.id)).toEqual(["new", "old", "bad"]);
  });
});

describe("probeExecutingTopics", () => {
  it("reports every Topic runs.list elects an active owner for", async () => {
    const result = await probeExecutingTopics(
      [topic("t1", "2026-01-01T00:00:00.000Z"), topic("t2", "2026-02-01T00:00:00.000Z")],
      (topicId) => Promise.resolve(topicId === "t1" ? { runs: [], activeRunId: "run_1", activeRun: run("run_1", "t1") } : { runs: [] }),
    );
    expect(result).toEqual({ status: "complete", activeByTopicId: { t1: { topicId: "t1", runId: "run_1", state: "running" } } });
  });

  it("reports a timeout when a probe outlives the deadline, so the caller can degrade", async () => {
    vi.useFakeTimers();
    try {
      const never = Promise.withResolvers<TopicRunsAuthority>();
      const pending = probeExecutingTopics(
        [topic("t1", "2026-01-01T00:00:00.000Z")],
        () => never.promise, // never settles: the deadline must win
        25,
      );
      await vi.advanceTimersByTimeAsync(25);
      await expect(pending).resolves.toEqual({ status: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never lets a probe rejection escape as an executing verdict", async () => {
    await expect(
      probeExecutingTopics(
        [topic("t1", "2026-01-01T00:00:00.000Z")],
        () => Promise.reject(new Error("authority down")),
      ),
    ).rejects.toThrow("authority down");
  });
});
