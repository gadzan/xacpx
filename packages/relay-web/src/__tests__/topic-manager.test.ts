import { mount, flushPromises } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import TopicManager from "../components/TopicManager.vue";
import { i18n } from "../i18n";
import type { TopicImpactDto, TopicSummaryDto } from "@ganglion/xacpx-relay-protocol";

const topics: TopicSummaryDto[] = [
  { id: "t-default", conversationId: "c1", title: "Default", status: "active", createdAt: "now", updatedAt: "now", defaultDirect: true },
  { id: "t-extra", conversationId: "c1", title: "Extra", status: "active", createdAt: "now", updatedAt: "now" },
  { id: "t-old", conversationId: "c1", title: "Old notes", status: "archived", createdAt: "now", updatedAt: "now" },
];

function impact(partial: Partial<TopicImpactDto> = {}): TopicImpactDto {
  return {
    topic: topics[1]!,
    bindings: [],
    unsettledRunIds: [],
    indeterminateRunIds: [],
    worktreeRunIds: [],
    actions: { rename: true, archive: true, restore: false, teardown: true, clear: false },
    ...partial,
  };
}

function mountManager(overrides: Partial<{
  previewTopic: (topicId: string) => Promise<TopicImpactDto>;
  renameTopic: (topicId: string, title: string) => Promise<void>;
  archiveTopic: (topicId: string) => Promise<void>;
  restoreTopic: (topicId: string) => Promise<void>;
  teardownTopic: (topicId: string, requestId: string, releaseBindings: boolean) => Promise<void>;
  clearTopic: (topicId: string, requestId: string, releaseBindings: boolean) => Promise<void>;
}> = {}) {
  const previewTopic = overrides.previewTopic ?? vi.fn(async () => impact());
  const renameTopic = overrides.renameTopic ?? vi.fn(async () => {});
  const archiveTopic = overrides.archiveTopic ?? vi.fn(async () => {});
  const restoreTopic = overrides.restoreTopic ?? vi.fn(async () => {});
  const teardownTopic = overrides.teardownTopic ?? vi.fn(async () => {});
  const clearTopic = overrides.clearTopic ?? vi.fn(async () => {});
  const wrapper = mount(TopicManager, {
    props: {
      variant: "direct",
      topics,
      activeTopicId: "t-default",
      previewTopic,
      renameTopic,
      archiveTopic,
      restoreTopic,
      teardownTopic,
      clearTopic,
    },
    global: { plugins: [i18n] },
  });
  return { wrapper, previewTopic, renameTopic, archiveTopic, restoreTopic, teardownTopic, clearTopic };
}

describe("TopicManager", () => {
  it("searches the list and renames without offering delete on the default topic", async () => {
    const { wrapper, renameTopic } = mountManager();
    await wrapper.find("[data-test='topic-menu']").trigger("click");
    expect(wrapper.find("[data-test='topic-clear']").exists()).toBe(true);
    expect(wrapper.findAll("[data-test='topic-delete']")).toHaveLength(2);
    const search = wrapper.find("[data-test='topic-search']");
    await search.setValue("old");
    expect(wrapper.findAll("[data-test='topic-row']")).toHaveLength(1);
    await search.setValue("");
    const extra = wrapper.findAll("[data-test='topic-row']")[1]!;
    await extra.find("[data-test='topic-rename']").trigger("click");
    await extra.find("[data-test='topic-rename-input']").setValue("Renamed");
    await extra.find("form").trigger("submit");
    await flushPromises();
    expect(renameTopic).toHaveBeenCalledWith("t-extra", "Renamed");
  });

  it("blocks delete until external bindings are confirmed, and keeps the request id on retry", async () => {
    const teardownTopic = vi.fn()
      .mockRejectedValueOnce(new Error("session_release_failed"))
      .mockResolvedValueOnce(undefined);
    const { wrapper } = mountManager({
      teardownTopic,
      previewTopic: vi.fn(async () => impact({ bindings: [{ chatKey: "discord:default:bound" }] })),
    });
    await wrapper.find("[data-test='topic-menu']").trigger("click");
    const extra = wrapper.findAll("[data-test='topic-row']")[1]!;
    await extra.find("[data-test='topic-delete']").trigger("click");
    await flushPromises();
    const submit = wrapper.find("[data-test='topic-confirm-submit']");
    expect(submit.attributes("disabled")).toBeDefined();
    await wrapper.find("[data-test='topic-release-bindings']").setValue(true);
    await submit.trigger("click");
    await flushPromises();
    expect(teardownTopic).toHaveBeenCalledTimes(1);
    const requestId = teardownTopic.mock.calls[0]![1];
    expect(teardownTopic.mock.calls[0]![0]).toBe("t-extra");
    expect(teardownTopic.mock.calls[0]![2]).toBe(true);
    await wrapper.find("[data-test='topic-confirm-submit']").trigger("click");
    await flushPromises();
    expect(teardownTopic).toHaveBeenCalledTimes(2);
    expect(teardownTopic.mock.calls[1]![1]).toBe(requestId);
  });

  it("does not submit delete while a worktree is still attached", async () => {
    const teardownTopic = vi.fn(async () => {});
    const { wrapper } = mountManager({
      teardownTopic,
      previewTopic: vi.fn(async () => impact({ worktreeRunIds: ["run_1"] })),
    });
    await wrapper.find("[data-test='topic-menu']").trigger("click");
    await wrapper.findAll("[data-test='topic-row']")[1]!.find("[data-test='topic-delete']").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-test='topic-worktree-warning']").exists()).toBe(true);
    expect(wrapper.find("[data-test='topic-confirm-submit']").attributes("disabled")).toBeDefined();
    await wrapper.find("[data-test='topic-confirm-submit']").trigger("click");
    expect(teardownTopic).not.toHaveBeenCalled();
  });
});
