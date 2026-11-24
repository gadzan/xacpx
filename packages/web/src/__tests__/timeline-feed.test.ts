import { flushPromises } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";
import type {
  ConversationTimelineDto,
  ConversationTimelineEntryDto,
} from "@ganglion/xacpx-relay-protocol";

const mockRpc = vi.fn();
vi.mock("../api/client", () => ({
  api: { rpc: (instanceId: string, type: string, payload?: unknown) => mockRpc(instanceId, type, payload) },
}));

import { useConversationTimelineFeed } from "../lib/use-timeline-feed";

function messageEntry(seq: number, id = `m${seq}`): ConversationTimelineEntryDto {
  return {
    kind: "message",
    key: `message:${id}`,
    anchorSeq: seq,
    message: {
      id,
      conversationId: "c1",
      topicId: "t1",
      seq,
      role: "human",
      content: `note ${seq}`,
      createdAt: "now",
    },
  };
}

function page(
  entries: ConversationTimelineEntryDto[],
  overrides: Partial<ConversationTimelineDto> = {},
): ConversationTimelineDto {
  return {
    conversationId: "c1",
    topicId: "t1",
    entries,
    oldestSeq: entries[0]?.anchorSeq,
    newestSeq: entries[entries.length - 1]?.anchorSeq,
    hasMoreBefore: false,
    hasMoreAfter: false,
    ...overrides,
  };
}

/** Run the feed's watchers inside a scope so each test tears down cleanly. */
function mountFeed(overrides: {
  enabled?: boolean;
  conversationId?: string;
  reloadKey?: string;
} = {}) {
  const scope = effectScope();
  const instanceId = ref<string | null>("i1");
  const conversationId = ref<string | null>(overrides.conversationId ?? "c1");
  const topicId = ref<string | null>("t1");
  const enabled = ref(overrides.enabled ?? true);
  const reloadKey = ref(overrides.reloadKey ?? "0");
  const feed = scope.run(() => useConversationTimelineFeed({
    instanceId,
    conversationId,
    topicId,
    enabled,
    reloadKey,
  }))!;
  return { scope, feed, instanceId, conversationId, topicId, enabled, reloadKey };
}

describe("useConversationTimelineFeed", () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it("loads the newest page on mount and exposes the merged timeline", async () => {
    mockRpc.mockResolvedValueOnce(page([
      messageEntry(1),
      messageEntry(2),
    ], { activeRound: { runId: "r1", roundIndex: 1, rounds: 1, speakerCount: 2, spoken: 1, passed: 0, state: "running" } }));
    const { scope, feed } = mountFeed();
    await nextTick();
    await vi.waitFor(() => expect(feed.loaded.value).toBe(true));
    expect(mockRpc).toHaveBeenCalledWith("i1", "control.conversation.timeline", {
      conversationId: "c1",
      topicId: "t1",
      limit: 50,
    });
    expect(feed.entries.value.map((entry) => entry.key)).toEqual(["message:m1", "message:m2"]);
    expect(feed.timeline.value?.activeRound?.runId).toBe("r1");
    expect(feed.hasMoreBefore.value).toBe(false);
    scope.stop();
  });

  it("pages older history with beforeSeq and keeps the newest activeRound", async () => {
    mockRpc.mockResolvedValueOnce(page([messageEntry(10), messageEntry(11)], {
      hasMoreBefore: true,
      activeRound: { runId: "r1", roundIndex: 1, rounds: 1, speakerCount: 2, spoken: 0, passed: 0, state: "running" },
    }));
    const { scope, feed } = mountFeed();
    await nextTick();
    await vi.waitFor(() => expect(feed.loaded.value).toBe(true));

    mockRpc.mockResolvedValueOnce(page([messageEntry(1), messageEntry(2), messageEntry(10)], {
      hasMoreBefore: false,
      // An older page's round is not the live round: it must not replace it.
      activeRound: { runId: "old", roundIndex: 1, rounds: 1, speakerCount: 2, spoken: 2, passed: 0, state: "completed" },
    }));
    await feed.loadOlder();

    expect(mockRpc).toHaveBeenLastCalledWith("i1", "control.conversation.timeline", {
      conversationId: "c1",
      topicId: "t1",
      limit: 50,
      beforeSeq: 10,
    });
    expect(feed.entries.value.map((entry) => entry.anchorSeq)).toEqual([1, 2, 10, 11]);
    expect(feed.hasMoreBefore.value).toBe(false);
    expect(feed.activeRound.value?.runId).toBe("r1");
    scope.stop();
  });

  it("replaces the refetched window but keeps already-loaded older history", async () => {
    mockRpc.mockResolvedValueOnce(page([messageEntry(10), messageEntry(11)], { hasMoreBefore: true }));
    const { scope, feed } = mountFeed();
    await nextTick();
    await vi.waitFor(() => expect(feed.loaded.value).toBe(true));
    mockRpc.mockResolvedValueOnce(page([messageEntry(1), messageEntry(2), messageEntry(10)]));
    await feed.loadOlder();
    expect(feed.entries.value.map((entry) => entry.anchorSeq)).toEqual([1, 2, 10, 11]);

    // A newer page starts at 10: rows below it are the loaded history and stay;
    // the covered window is replaced so a changed row cannot linger stale.
    mockRpc.mockResolvedValueOnce(page([
      messageEntry(10, "m10-edited"),
      messageEntry(12),
    ], { oldestSeq: 10 }));
    await feed.refresh();
    expect(feed.entries.value.map((entry) => entry.key)).toEqual([
      "message:m1",
      "message:m2",
      "message:m10-edited",
      "message:m12",
    ]);
    scope.stop();
  });

  it("coalesces overlapping refreshes into one queued follow-up", async () => {
    const gates: Array<ReturnType<typeof Promise.withResolvers<ConversationTimelineDto>>> = [];
    mockRpc.mockImplementation(() => {
      const gate = Promise.withResolvers<ConversationTimelineDto>();
      gates.push(gate);
      return gate.promise;
    });
    const { scope, feed, reloadKey } = mountFeed();
    await nextTick();
    expect(gates).toHaveLength(1);

    // Two live-state ticks while the first fetch is still open: one follow-up,
    // never two concurrent requests.
    reloadKey.value = "1";
    await nextTick();
    reloadKey.value = "2";
    await nextTick();
    expect(gates).toHaveLength(1);

    gates[0]!.resolve(page([messageEntry(1)]));
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates[1]!.resolve(page([messageEntry(1), messageEntry(2)]));
    await vi.waitFor(() => expect(feed.entries.value).toHaveLength(2));
    expect(mockRpc).toHaveBeenCalledTimes(2);
    scope.stop();
  });

  it("drops a response from the room it has already left", async () => {
    const stale = Promise.withResolvers<ConversationTimelineDto>();
    const fresh = Promise.withResolvers<ConversationTimelineDto>();
    mockRpc.mockImplementationOnce(() => stale.promise);
    mockRpc.mockImplementationOnce(() => fresh.promise);
    const { scope, feed, conversationId } = mountFeed();
    await nextTick();
    expect(mockRpc).toHaveBeenCalledTimes(1);

    // Leave the room while its first page is still in flight: the switch
    // invalidates that request and queues the new room's fetch behind it.
    conversationId.value = "c2";
    await nextTick();
    expect(mockRpc).toHaveBeenCalledTimes(1);

    stale.resolve(page([messageEntry(1), messageEntry(2)]));
    await flushPromises();
    // The stale rows never land, and the queued refresh asks the new room.
    expect(feed.entries.value).toEqual([]);
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc).toHaveBeenLastCalledWith("i1", "control.conversation.timeline", {
      conversationId: "c2",
      topicId: "t1",
      limit: 50,
    });

    fresh.resolve(page([messageEntry(20)], { conversationId: "c2" }));
    await vi.waitFor(() => expect(feed.loaded.value).toBe(true));
    expect(feed.entries.value.map((entry) => entry.anchorSeq)).toEqual([20]);
    scope.stop();
  });

  it("never fetches while the capability gate is closed", async () => {
    const { scope, feed, enabled } = mountFeed({ enabled: false });
    await nextTick();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(feed.timeline.value).toBeNull();

    mockRpc.mockResolvedValueOnce(page([messageEntry(1)]));
    enabled.value = true;
    await nextTick();
    await vi.waitFor(() => expect(feed.entries.value).toHaveLength(1));
    expect(mockRpc).toHaveBeenCalledTimes(1);
    scope.stop();
  });
});
