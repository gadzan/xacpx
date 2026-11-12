import { setActivePinia, createPinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type { TopicSummaryDto } from "@ganglion/xacpx-relay-protocol";

const mockRpc = vi.fn();
const mockApiGet = vi.fn();
vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(public code: string, public status: number) {
      super(code);
    }
  },
  api: {
    rpc: (instanceId: string, type: string, payload?: unknown) => mockRpc(instanceId, type, payload),
    get: (path: string) => mockApiGet(path),
  },
}));

import { useDirectBotsStore } from "../stores/direct-bots";
import { supportsDirectTopicFork } from "../stores/instances";
import ConversationTimeline from "../components/ConversationTimeline.vue";
import ForkTopicDialog, { type ForkTopicRequest } from "../components/ForkTopicDialog.vue";
import { i18n } from "../i18n";
import { RELAY_CAPABILITIES } from "@ganglion/xacpx-relay-protocol";

const NOW = "2026-11-12T00:00:00.000Z";
const CONVERSATION = "conversation_d";

function topic(id: string, title: string, patch: Partial<TopicSummaryDto> = {}): TopicSummaryDto {
  return { id, conversationId: CONVERSATION, title, status: "active", createdAt: NOW, updatedAt: NOW, ...patch };
}

const SOURCE = topic("topic_src", "Release");
const FORKED = topic("topic_dst", "Release fork", {
  forkedFrom: {
    requestId: "fork-1",
    sourceConversationId: CONVERSATION,
    sourceTopicId: "topic_src",
    sourceTitle: "Release",
    mode: "handoff",
    throughSeq: 4,
    rootTopicId: "topic_src",
    copiedMessages: 4,
    omittedMessages: 1,
    createdAt: NOW,
  },
});

function emptyHistory(topicId: string) {
  return {
    conversationId: CONVERSATION,
    topicId,
    messages: [],
    hasNext: false,
    hasMoreBefore: false,
    hasMoreAfter: false,
  };
}

describe("Direct Topic fork", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockRpc.mockReset();
    mockApiGet.mockReset();
    mockApiGet.mockRejectedValue(new Error("not configured"));
    localStorage.clear();
  });

  it("forks through the Direct RPC, upserts the Topic, and switches to it", async () => {
    const store = useDirectBotsStore();
    store.instanceId = "inst_1";
    store.activeConversationId = CONVERSATION;
    store.activeTopicId = "topic_src";
    store.topicsByConversation[`inst_1:${CONVERSATION}`] = [SOURCE];
    mockRpc.mockImplementation(async (_instance: string, type: string, payload: { topicId?: string }) => {
      if (type === "control.direct.topics.fork") return { topic: FORKED };
      if (type === "control.conversation.history") return emptyHistory(String(payload.topicId));
      throw new Error(`unexpected ${type}`);
    });
    const input = {
      conversationId: CONVERSATION,
      sourceTopicId: "topic_src",
      targetTopicId: "topic_dst",
      requestId: "fork-1",
      sourcePoint: { type: "latest_stable" as const },
    };

    await expect(store.forkDirectTopic("inst_1", input)).resolves.toEqual(FORKED);
    // The Direct RPC, never the Group one: the two capabilities are separate.
    expect(mockRpc).toHaveBeenCalledWith("inst_1", "control.direct.topics.fork", input);
    expect(store.topicsByConversation[`inst_1:${CONVERSATION}`]?.map((row) => row.id))
      .toEqual(["topic_src", "topic_dst"]);
    expect(store.activeTopicId).toBe("topic_dst");
    expect(store.currentTopic?.forkedFrom?.mode).toBe("handoff");
  });

  it("keeps the current Topic and rethrows when the Direct RPC fails", async () => {
    const store = useDirectBotsStore();
    store.instanceId = "inst_1";
    store.activeConversationId = CONVERSATION;
    store.activeTopicId = "topic_src";
    store.topicsByConversation[`inst_1:${CONVERSATION}`] = [SOURCE];
    mockRpc.mockResolvedValueOnce({ error: { code: "unsupported-rpc", message: "old core" } });

    await expect(store.forkDirectTopic("inst_1", {
      conversationId: CONVERSATION,
      sourceTopicId: "topic_src",
      targetTopicId: "topic_dst",
      requestId: "fork-1",
    })).rejects.toMatchObject({ code: "unsupported-rpc" });
    expect(store.activeTopicId).toBe("topic_src");
    expect(store.topicsByConversation[`inst_1:${CONVERSATION}`]?.map((row) => row.id)).toEqual(["topic_src"]);
  });

  it("gates the Direct fork entry on the Direct capability only", () => {
    expect(supportsDirectTopicFork({ capabilities: [RELAY_CAPABILITIES.directTopicForkV1] })).toBe(true);
    // A Group fork capability says nothing about Direct forks.
    expect(supportsDirectTopicFork({ capabilities: [RELAY_CAPABILITIES.groupTopicForkV1] })).toBe(false);
    expect(supportsDirectTopicFork({ capabilities: [] })).toBe(false);
    expect(supportsDirectTopicFork(null)).toBe(false);
  });

  it("hands the dialog a Direct fork callback and mints ids the store can replay", async () => {
    const fork = vi.fn<(request: ForkTopicRequest) => Promise<TopicSummaryDto>>().mockResolvedValue(FORKED);
    const wrapper = mount(ForkTopicDialog, {
      props: {
        sourceTopic: SOURCE,
        sourcePoint: { type: "latest_stable" },
        conversationId: CONVERSATION,
        fork,
      },
      global: { plugins: [i18n] },
    });
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    const request = fork.mock.calls[0]![0];
    expect(request.conversationId).toBe(CONVERSATION);
    expect(request.sourceTopicId).toBe("topic_src");
    expect(request.targetTopicId).toMatch(/^topic_[0-9a-f-]{36}$/);
    expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });

  it("shows the carried count, not the copied count, for a handoff banner", async () => {
    const wrapper = mount(ConversationTimeline, {
      props: {
        room: { conversationId: CONVERSATION, topicId: "topic_dst", participants: [] },
        timeline: {
          conversationId: CONVERSATION,
          topicId: "topic_dst",
          entries: [],
          hasMoreBefore: false,
          hasMoreAfter: false,
        },
        loading: false,
        loadingOlder: false,
        forkedFrom: FORKED.forkedFrom!,
        forkSourceAvailable: true,
      },
      global: { plugins: [i18n] },
    });
    expect(wrapper.find("[data-test='topic-fork-banner-count']").text())
      .toBe(i18n.global.t("group.topic.forkCarried", { count: 4 }));
    expect(wrapper.find("[data-test='topic-fork-banner-omitted']").text())
      .toBe(i18n.global.t("group.topic.forkOmitted", { count: 1 }));
    wrapper.unmount();
  });
});
