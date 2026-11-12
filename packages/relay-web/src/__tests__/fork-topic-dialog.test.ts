import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationRunDto, TopicSummaryDto } from "@ganglion/xacpx-relay-protocol";
import ForkTopicDialog, { type ForkTopicRequest } from "../components/ForkTopicDialog.vue";
import { i18n } from "../i18n";

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

/**
 * The dialog performs no RPC itself: it owns the ids, the labels and the error
 * mapping and calls the `fork` prop its pane supplies. Group and Direct share
 * this exact component, so these tests assert the callback contract only.
 */
function mountDialog(input: {
  sourcePoint?: { type: "latest_stable" } | { type: "run"; runId: string };
  resolvedRun?: ConversationRunDto | null;
  mode?: "snapshot" | "handoff";
} = {}) {
  const fork = vi.fn<(request: ForkTopicRequest) => Promise<TopicSummaryDto>>()
    .mockResolvedValue({ ...SOURCE, id: "topic_dst" });
  const wrapper = mount(ForkTopicDialog, {
    props: {
      sourceTopic: SOURCE,
      sourcePoint: input.sourcePoint ?? { type: "latest_stable" },
      conversationId: "conversation_g",
      fork,
      ...(input.resolvedRun !== undefined ? { resolvedRun: input.resolvedRun } : {}),
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
    },
    global: { plugins: [i18n] },
  });
  return { wrapper, fork };
}

describe("ForkTopicDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults the title, labels an unresolved point honestly, and forks once", async () => {
    const { wrapper, fork } = mountDialog();
    expect((wrapper.find("[data-test='fork-topic-title']").element as HTMLInputElement).value).toBe("Release fork");
    expect(wrapper.find("[data-test='fork-topic-point']").text()).toContain("latest finished run");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(fork).toHaveBeenCalledTimes(1);
    const input = fork.mock.calls[0]![0];
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
    const { promise, resolve } = Promise.withResolvers<TopicSummaryDto>();
    const fork = vi.fn<(request: ForkTopicRequest) => Promise<TopicSummaryDto>>().mockReturnValue(promise);
    const wrapper = mount(ForkTopicDialog, {
      props: {
        sourceTopic: SOURCE,
        sourcePoint: { type: "run", runId: RUN.id },
        resolvedRun: RUN,
        conversationId: "conversation_g",
        fork,
      },
      global: { plugins: [i18n] },
    });
    expect(wrapper.find("[data-test='fork-topic-point']").text()).toContain(NOW);
    await wrapper.find("form").trigger("submit");
    expect(wrapper.find("[data-test='fork-topic-submit']").attributes("disabled")).toBeDefined();
    resolve({ ...SOURCE, id: "topic_dst" });
    await flushPromises();
    expect(fork).toHaveBeenCalledTimes(1);
  });

  it("maps a failure and reuses the same ids on retry", async () => {
    const fork = vi.fn<(request: ForkTopicRequest) => Promise<TopicSummaryDto>>()
      .mockRejectedValueOnce(Object.assign(new Error("empty"), { code: "topic_fork_empty" }))
      .mockResolvedValueOnce({ ...SOURCE, id: "topic_dst" });
    const wrapper = mount(ForkTopicDialog, {
      props: { sourceTopic: SOURCE, sourcePoint: { type: "latest_stable" }, conversationId: "conversation_g", fork },
      global: { plugins: [i18n] },
    });
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(wrapper.find("[data-test='fork-topic-error']").text()).toContain("no messages");
    expect(wrapper.emitted("close")).toBeUndefined();
    const first = fork.mock.calls[0]![0];
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    const second = fork.mock.calls[1]![0];
    expect(second.targetTopicId).toBe(first.targetTopicId);
    expect(second.requestId).toBe(first.requestId);
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });

  it("remints the ids after a missing-history failure so the next click starts over", async () => {
    const fork = vi.fn<(request: ForkTopicRequest) => Promise<TopicSummaryDto>>()
      .mockRejectedValueOnce(Object.assign(new Error("orphan"), { code: "topic_fork_history_missing" }))
      .mockResolvedValueOnce({ ...SOURCE, id: "topic_dst" });
    const wrapper = mount(ForkTopicDialog, {
      props: { sourceTopic: SOURCE, sourcePoint: { type: "latest_stable" }, conversationId: "conversation_g", fork },
      global: { plugins: [i18n] },
    });
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    // The core fails closed on orphan rows, so the dialog must not replay the
    // same pair: it names the start-over and mints fresh ids for the retry.
    expect(wrapper.find("[data-test='fork-topic-error']").text()).toBe(
      i18n.global.t("group.topic.forkErrors.historyMissing"),
    );
    expect(wrapper.emitted("close")).toBeUndefined();
    const first = fork.mock.calls[0]![0];
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    const second = fork.mock.calls[1]![0];
    expect(second.targetTopicId).not.toBe(first.targetTopicId);
    expect(second.requestId).not.toBe(first.requestId);
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });

  it("sits above the run-detail drawer and sheet layers", () => {
    const { wrapper } = mountDialog();
    expect(wrapper.element.className).toContain("z-[70]");
    wrapper.unmount();
  });

  it("names a teardown instead of the generic failure", async () => {
    for (const code of ["topic_deleting", "conversation_deleting", "topic_resetting"]) {
      const fork = vi.fn<(request: ForkTopicRequest) => Promise<TopicSummaryDto>>()
        .mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      const wrapper = mount(ForkTopicDialog, {
        props: { sourceTopic: SOURCE, sourcePoint: { type: "latest_stable" }, conversationId: "conversation_g", fork },
        global: { plugins: [i18n] },
      });
      await wrapper.find("form").trigger("submit");
      await flushPromises();
      expect(wrapper.find("[data-test='fork-topic-error']").text()).toBe(
        i18n.global.t("group.topic.forkErrors.tearingDown"),
      );
      wrapper.unmount();
    }
  });
});

describe("ForkTopicDialog copy", () => {
  it("promises copied rows by default and a one-time block for a handoff", () => {
    const snapshot = mountDialog();
    expect(snapshot.wrapper.find("[data-test='fork-topic-hint']").text()).toContain("Copies this topic's public messages");
    const handoff = mountDialog({ mode: "handoff" });
    const hint = handoff.wrapper.find("[data-test='fork-topic-hint']").text();
    expect(hint).toContain("one block of background context on its first prompt");
    // A Direct fork copies no rows, so the snapshot promise must never render there.
    expect(hint).not.toContain("Copies this topic's public messages");
  });
});
