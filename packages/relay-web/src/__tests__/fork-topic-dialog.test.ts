import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationRunDto, TopicSummaryDto } from "@ganglion/xacpx-relay-protocol";
import ForkTopicDialog from "../components/ForkTopicDialog.vue";
import { i18n } from "../i18n";
import { useGroupsStore } from "../stores/groups";

const NOW = "2026-11-10T00:00:00.000Z";
const SOURCE: TopicSummaryDto = {
  id: "topic_source",
  conversationId: "conversation_g",
  title: "Release",
  status: "active",
  createdAt: NOW,
  updatedAt: NOW,
};

const RUN: ConversationRunDto = {
  id: "run_1",
  conversationId: "conversation_g",
  topicId: "topic_source",
  requestMessageId: "message_1",
  requestId: "request_1",
  mode: "explicit",
  state: "completed",
  profileRevision: 1,
  createdAt: NOW,
};

function mountDialog(input: {
  sourcePoint?: { type: "latest_stable" } | { type: "run"; runId: string };
  resolvedRun?: ConversationRunDto | null;
} = {}) {
  return mount(ForkTopicDialog, {
    props: {
      sourceTopic: SOURCE,
      sourcePoint: input.sourcePoint ?? { type: "latest_stable" },
      ...(input.resolvedRun !== undefined ? { resolvedRun: input.resolvedRun } : {}),
    },
    global: { plugins: [i18n] },
  });
}

describe("ForkTopicDialog", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("defaults the title, labels an unresolved point honestly, and forks once", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.activeConversationId = "conversation_g";
    const fork = vi.spyOn(store, "forkGroupTopic").mockResolvedValue({ ...SOURCE, id: "topic_dst" });
    const wrapper = mountDialog();
    expect((wrapper.find("[data-test='fork-topic-title']").element as HTMLInputElement).value).toBe("Release fork");
    expect(wrapper.find("[data-test='fork-topic-point']").text()).toContain("latest finished run");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(fork).toHaveBeenCalledTimes(1);
    const input = fork.mock.calls[0]![1];
    expect(input).toMatchObject({
      conversationId: "conversation_g",
      sourceTopicId: "topic_source",
      sourcePoint: { type: "latest_stable" },
      title: "Release fork",
    });
    expect(input.targetTopicId).toMatch(/^topic_/);
    expect(input.requestId).toBeTruthy();
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });

  it("names the run it cuts at and disables submit while pending", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.activeConversationId = "conversation_g";
    const { promise, resolve } = Promise.withResolvers<TopicSummaryDto>();
    const fork = vi.spyOn(store, "forkGroupTopic").mockReturnValue(promise);
    const wrapper = mountDialog({ sourcePoint: { type: "run", runId: RUN.id }, resolvedRun: RUN });
    expect(wrapper.find("[data-test='fork-topic-point']").text()).toContain(NOW);
    await wrapper.find("form").trigger("submit");
    expect(wrapper.find("[data-test='fork-topic-submit']").attributes("disabled")).toBeDefined();
    resolve({ ...SOURCE, id: "topic_dst" });
    await flushPromises();
    expect(fork).toHaveBeenCalledTimes(1);
  });

  it("maps a failure and reuses the same ids on retry", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.activeConversationId = "conversation_g";
    const fork = vi.spyOn(store, "forkGroupTopic")
      .mockRejectedValueOnce(Object.assign(new Error("empty"), { code: "topic_fork_empty" }))
      .mockResolvedValueOnce({ ...SOURCE, id: "topic_dst" });
    const wrapper = mountDialog();
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(wrapper.find("[data-test='fork-topic-error']").text()).toContain("no messages");
    expect(wrapper.emitted("close")).toBeUndefined();
    const first = fork.mock.calls[0]![1];
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    const second = fork.mock.calls[1]![1];
    expect(second.targetTopicId).toBe(first.targetTopicId);
    expect(second.requestId).toBe(first.requestId);
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });

  it("remints the ids after a missing-history failure so the next click starts over", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.activeConversationId = "conversation_g";
    const fork = vi.spyOn(store, "forkGroupTopic")
      .mockRejectedValueOnce(Object.assign(new Error("orphan"), { code: "topic_fork_history_missing" }))
      .mockResolvedValueOnce({ ...SOURCE, id: "topic_dst" });
    const wrapper = mountDialog();
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    // The core fails closed on orphan rows, so the dialog must not replay the
    // same pair: it names the start-over and mints fresh ids for the retry.
    expect(wrapper.find("[data-test='fork-topic-error']").text()).toBe(
      i18n.global.t("group.topic.forkErrors.historyMissing"),
    );
    expect(wrapper.emitted("close")).toBeUndefined();
    const first = fork.mock.calls[0]![1];
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    const second = fork.mock.calls[1]![1];
    expect(second.targetTopicId).not.toBe(first.targetTopicId);
    expect(second.requestId).not.toBe(first.requestId);
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });

  it("sits above the run-detail drawer and sheet layers", () => {
    const wrapper = mountDialog();
    expect(wrapper.element.className).toContain("z-[70]");
    wrapper.unmount();
  });

  it("names a teardown instead of the generic failure", async () => {
    const store = useGroupsStore();
    store.instanceId = "inst_1";
    store.activeConversationId = "conversation_g";
    for (const code of ["topic_deleting", "conversation_deleting", "topic_resetting"]) {
      vi.spyOn(store, "forkGroupTopic").mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      const wrapper = mountDialog();
      await wrapper.find("form").trigger("submit");
      await flushPromises();
      expect(wrapper.find("[data-test='fork-topic-error']").text()).toBe(
        i18n.global.t("group.topic.forkErrors.tearingDown"),
      );
      wrapper.unmount();
    }
  });
});
