import { mount, flushPromises } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import TopicSwitcher from "../components/TopicSwitcher.vue";
import { i18n } from "../i18n";
import type { TopicImpactDto, TopicSummaryDto } from "@ganglion/xacpx-relay-protocol";

// Bot-page (variant="direct") coverage for the shared topic switcher; the group chat
// paths are exercised through GroupPane in group-components.test.ts.
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

function mountSwitcher(overrides: Partial<{
  topics: TopicSummaryDto[];
  setTopicIsolation?: (topicId: string, isolation: string) => Promise<void>;
  previewTopic: (topicId: string) => Promise<TopicImpactDto>;
  renameTopic: (topicId: string, title: string) => Promise<void>;
  restoreTopic: (topicId: string) => Promise<void>;
  teardownTopic: (topicId: string, requestId: string, releaseBindings: boolean) => Promise<void>;
}> = {}) {
  const renameTopic = overrides.renameTopic ?? vi.fn(async () => {});
  const setTopicIsolation = overrides.setTopicIsolation ?? vi.fn(async () => {});
  const restoreTopic = overrides.restoreTopic ?? vi.fn(async () => {});
  const teardownTopic = overrides.teardownTopic ?? vi.fn(async () => {});
  const wrapper = mount(TopicSwitcher, {
    props: {
      variant: "direct",
      topics: overrides.topics ?? topics,
      activeTopicId: "t-default",
      previewTopic: overrides.previewTopic ?? vi.fn(async () => impact()),
      renameTopic,
      archiveTopic: vi.fn(async () => {}),
      restoreTopic,
      teardownTopic,
      clearTopic: vi.fn(async () => {}),
      setTopicIsolation,
    },
    global: { plugins: [i18n] },
  });
  return { wrapper, renameTopic, restoreTopic, teardownTopic, setTopicIsolation };
}

async function rowMenu(wrapper: ReturnType<typeof mountSwitcher>["wrapper"], index: number) {
  if (!wrapper.find("[data-test='topic-panel']").exists()) await wrapper.find("[data-test='topic-menu']").trigger("click");
  await wrapper.findAll("[data-test='topic-row']")[index]!.find("[data-test='topic-row-more']").trigger("click");
  return wrapper.find("[data-test='context-menu']");
}

describe("TopicSwitcher (Bot topics)", () => {
  it("offers clear (not delete) on the default topic, restore on archived ones, and renames via the row menu", async () => {
    const { wrapper, renameTopic, restoreTopic } = mountSwitcher();
    let menu = await rowMenu(wrapper, 0);
    expect(menu.find("[data-test='menu-clear']").exists()).toBe(true);
    expect(menu.find("[data-test='menu-delete']").exists()).toBe(false);
    menu = await rowMenu(wrapper, 2);
    await menu.find("[data-test='menu-restore']").trigger("click");
    await flushPromises();
    expect(restoreTopic).toHaveBeenCalledWith("t-old");
    menu = await rowMenu(wrapper, 1);
    await menu.find("[data-test='menu-rename']").trigger("click");
    await wrapper.find("[data-test='topic-rename-input']").setValue("Renamed");
    await wrapper.find("[data-test='topic-panel'] form").trigger("submit");
    await flushPromises();
    expect(renameTopic).toHaveBeenCalledWith("t-extra", "Renamed");
  });

  it("filters long topic lists through the panel search", async () => {
    const many = Array.from({ length: 9 }, (_, i): TopicSummaryDto => ({
      id: `t${i}`, conversationId: "c1", title: i === 4 ? "Release notes" : `Topic ${i}`, status: "active", createdAt: "now", updatedAt: "now",
    }));
    const { wrapper } = mountSwitcher({ topics: many });
    await wrapper.find("[data-test='topic-menu']").trigger("click");
    await wrapper.find("[data-test='dd-search']").setValue("release");
    expect(wrapper.findAll("[data-test='topic-row']")).toHaveLength(1);
  });

  it("blocks delete until external bindings are confirmed, and keeps the request id on retry", async () => {
    const teardownTopic = vi.fn()
      .mockRejectedValueOnce(new Error("session_release_failed"))
      .mockResolvedValueOnce(undefined);
    const { wrapper } = mountSwitcher({
      teardownTopic,
      previewTopic: vi.fn(async () => impact({ bindings: [{ chatKey: "discord:default:bound" }] })),
    });
    const menu = await rowMenu(wrapper, 1);
    await menu.find("[data-test='menu-delete']").trigger("click");
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
    const { wrapper } = mountSwitcher({
      teardownTopic,
      previewTopic: vi.fn(async () => impact({ worktreeRunIds: ["run_1"] })),
    });
    const menu = await rowMenu(wrapper, 1);
    await menu.find("[data-test='menu-delete']").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-test='topic-worktree-warning']").exists()).toBe(true);
    expect(wrapper.find("[data-test='topic-confirm-submit']").attributes("disabled")).toBeDefined();
    await wrapper.find("[data-test='topic-confirm-submit']").trigger("click");
    expect(teardownTopic).not.toHaveBeenCalled();
  });

  it("switches a topic's isolation from the row menu and keeps a failed choice open", async () => {
    const setTopicIsolation = vi.fn()
      .mockRejectedValueOnce(new Error("conversation_not_settled"))
      .mockResolvedValueOnce(undefined);
    const groupTopics: TopicSummaryDto[] = [{
      id: "t-group", conversationId: "c1", title: "Round", status: "active", createdAt: "now", updatedAt: "now",
      executionTarget: { workspace: "repo", isolation: "shared-single-writer" },
    }];
    const { wrapper } = mountSwitcher({ topics: groupTopics, setTopicIsolation });
    const menu = await rowMenu(wrapper, 0);
    await menu.find("[data-test='menu-isolation']").trigger("click");
    await flushPromises();
    const dialog = wrapper.find("[data-test='topic-isolation']");
    expect(dialog.exists()).toBe(true);
    expect(dialog.find("[data-test='topic-isolation-worktree-per-member']").attributes("aria-checked")).toBe("false");

    await dialog.find("[data-test='topic-isolation-worktree-per-member']").trigger("click");
    await flushPromises();
    // A rejected switch keeps the dialog open with the reason, like delete does.
    expect(setTopicIsolation).toHaveBeenCalledWith("t-group", "worktree-per-member");
    expect(wrapper.find("[data-test='topic-isolation']").exists()).toBe(true);
    expect(wrapper.text()).toContain("conversation_not_settled");

    await wrapper.find("[data-test='topic-isolation-worktree-per-member']").trigger("click");
    await flushPromises();
    expect(setTopicIsolation).toHaveBeenCalledTimes(2);
    expect(wrapper.find("[data-test='topic-isolation']").exists()).toBe(false);
  });

  it("offers no isolation entry when the surface has no execution target", async () => {
    const { wrapper } = mountSwitcher();
    const menu = await rowMenu(wrapper, 1);
    expect(menu.find("[data-test='menu-isolation']").exists()).toBe(false);
  });
});
