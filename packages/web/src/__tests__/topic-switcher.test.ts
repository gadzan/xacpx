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
    abandonableRunIds: [],
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
  clearTopic: (topicId: string, requestId: string, releaseBindings: boolean) => Promise<void>;
  abandonUnknownRuns?: (runIds: string[]) => Promise<void>;
}> = {}) {
  const renameTopic = overrides.renameTopic ?? vi.fn(async () => {});
  const setTopicIsolation = overrides.setTopicIsolation ?? vi.fn(async () => {});
  const restoreTopic = overrides.restoreTopic ?? vi.fn(async () => {});
  const teardownTopic = overrides.teardownTopic ?? vi.fn(async () => {});
  const clearTopic = overrides.clearTopic ?? vi.fn(async () => {});
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
      clearTopic,
      setTopicIsolation,
      ...(overrides.abandonUnknownRuns ? { abandonUnknownRuns: overrides.abandonUnknownRuns } : {}),
    },
    global: { plugins: [i18n] },
  });
  return { wrapper, renameTopic, restoreTopic, teardownTopic, clearTopic, setTopicIsolation };
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

  it("routes the default topic's Clear through clearTopic and keeps the confirm in the owned layer", async () => {
    const clearTopic = vi.fn(async () => {});
    const teardownTopic = vi.fn(async () => {});
    const { wrapper } = mountSwitcher({ clearTopic, teardownTopic });
    const menu = await rowMenu(wrapper, 0);
    await menu.find("[data-test='menu-clear']").trigger("click");
    await flushPromises();
    const confirm = wrapper.find('[data-test="topic-confirm"]');
    expect(confirm.text()).toContain("Clear the default topic?");
    expect(confirm.element.parentElement?.getAttribute("data-dd-panel")).not.toBeNull();
    await wrapper.find('[data-test="topic-confirm-submit"]').trigger("click");
    await flushPromises();
    expect(clearTopic).toHaveBeenCalledWith("t-default", expect.any(String), false);
    expect(teardownTopic).not.toHaveBeenCalled();
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

  it("offers giving up sealed unknown work, then retries the same delete", async () => {
    const teardownTopic = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("topic has indeterminate work"), {
        code: "conversation_indeterminate",
      }))
      .mockResolvedValueOnce(undefined);
    const abandonUnknownRuns = vi.fn(async () => {});
    const { wrapper } = mountSwitcher({
      teardownTopic,
      abandonUnknownRuns,
      previewTopic: vi.fn(async () => impact({ indeterminateRunIds: ["run_1"], abandonableRunIds: ["run_1"] })),
    });
    const menu = await rowMenu(wrapper, 1);
    await menu.find("[data-test='menu-delete']").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-test='topic-abandon']").exists()).toBe(false);
    await wrapper.find("[data-test='topic-confirm-submit']").trigger("click");
    await flushPromises();
    const requestId = teardownTopic.mock.calls[0]![1];
    expect(wrapper.find("[data-test='topic-abandon']").exists()).toBe(true);
    await wrapper.find("[data-test='topic-abandon-submit']").trigger("click");
    await flushPromises();
    expect(abandonUnknownRuns).toHaveBeenCalledWith(["run_1"]);
    expect(teardownTopic).toHaveBeenCalledTimes(2);
    expect(teardownTopic.mock.calls[1]![1]).toBe(requestId);
    expect(wrapper.find("[data-test='topic-confirm']").exists()).toBe(false);
  });

  it("keeps the abandon door shut for a failure that is not unknown work", async () => {
    const abandonUnknownRuns = vi.fn(async () => {});
    const { wrapper } = mountSwitcher({
      teardownTopic: vi.fn(async () => {
        throw Object.assign(new Error("release failed"), { code: "session_release_failed" });
      }),
      abandonUnknownRuns,
      previewTopic: vi.fn(async () => impact({ indeterminateRunIds: ["run_1"], abandonableRunIds: ["run_1"] })),
    });
    const menu = await rowMenu(wrapper, 1);
    await menu.find("[data-test='menu-delete']").trigger("click");
    await flushPromises();
    await wrapper.find("[data-test='topic-confirm-submit']").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-test='topic-abandon']").exists()).toBe(false);
    expect(abandonUnknownRuns).not.toHaveBeenCalled();
  });

  it("offers a retry on a topic stuck in deleting", async () => {
    const stuck: TopicSummaryDto = {
      id: "t-stuck", conversationId: "c1", title: "Stuck", status: "deleting",
      createdAt: "now", updatedAt: "now",
    };
    const teardownTopic = vi.fn(async () => {});
    const { wrapper } = mountSwitcher({
      topics: [...topics, stuck],
      teardownTopic,
      previewTopic: vi.fn(async () => impact({ topic: stuck })),
    });
    const menu = await rowMenu(wrapper, 3);
    expect(menu.find("[data-test='menu-delete']").exists()).toBe(false);
    await menu.find("[data-test='menu-retry-delete']").trigger("click");
    await flushPromises();
    await wrapper.find("[data-test='topic-confirm-submit']").trigger("click");
    await flushPromises();
    expect(teardownTopic).toHaveBeenCalledWith("t-stuck", expect.any(String), false);
  });

  it("switches a topic's isolation from the row menu and keeps a failed choice open", async () => {
    const setTopicIsolation = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("topic \"t-group\" has unsettled runs"), {
        code: "conversation_not_settled",
      }))
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
    // The server sentence is English; the dialog speaks the active locale.
    expect(wrapper.text()).toContain(i18n.global.t("bot.topic.isolationErrors.unsettled"));

    await wrapper.find("[data-test='topic-isolation-worktree-per-member']").trigger("click");
    await flushPromises();
    expect(setTopicIsolation).toHaveBeenCalledTimes(2);
    expect(wrapper.find("[data-test='topic-isolation']").exists()).toBe(false);
  });

  it("names unintegrated worktrees instead of echoing the server sentence", async () => {
    const setTopicIsolation = vi.fn().mockRejectedValueOnce(Object.assign(
      new Error("topic \"t-group\" still has unintegrated worktrees"),
      { code: "worktree_runs_pending" },
    ));
    const groupTopics: TopicSummaryDto[] = [{
      id: "t-group", conversationId: "c1", title: "Round", status: "active", createdAt: "now", updatedAt: "now",
      executionTarget: { workspace: "repo", isolation: "worktree-per-member" },
    }];
    const { wrapper } = mountSwitcher({ topics: groupTopics, setTopicIsolation });
    const menu = await rowMenu(wrapper, 0);
    await menu.find("[data-test='menu-isolation']").trigger("click");
    await flushPromises();
    await wrapper.find("[data-test='topic-isolation-shared']").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-test='topic-isolation']").exists()).toBe(true);
    expect(wrapper.text()).toContain(i18n.global.t("bot.topic.isolationErrors.worktreeRunsPending"));
    expect(wrapper.text()).not.toContain("still has unintegrated worktrees");
  });

  it("offers no isolation entry when the surface has no execution target", async () => {
    const { wrapper } = mountSwitcher();
    const menu = await rowMenu(wrapper, 1);
    expect(menu.find("[data-test='menu-isolation']").exists()).toBe(false);
  });

  it("badges executing topics with a labelled spinner and skips the rest", async () => {
    const wrapper = mount(TopicSwitcher, {
      props: {
        topics,
        activeTopicId: "t-default",
        previewTopic: vi.fn(async () => impact()),
        renameTopic: vi.fn(async () => {}),
        archiveTopic: vi.fn(async () => {}),
        restoreTopic: vi.fn(async () => {}),
        teardownTopic: vi.fn(async () => {}),
        clearTopic: vi.fn(async () => {}),
        setTopicIsolation: vi.fn(async () => {}),
        executingTopicIds: ["t-extra"],
      },
      global: { plugins: [i18n] },
    });
    await wrapper.find("[data-test='group-topic-pill']").trigger("click");
    const rows = wrapper.findAll("[data-test='topic-row']");
    expect(rows).toHaveLength(3);
    const badges = wrapper.findAll("[data-test='topic-executing']");
    expect(badges).toHaveLength(1);
    expect(badges[0]!.attributes("aria-label")).toBe("Running");
    expect(rows[1]!.find("[data-test='topic-executing']").exists()).toBe(true);
    expect(rows[0]!.find("[data-test='topic-executing']").exists()).toBe(false);
    expect(rows[2]!.find("[data-test='topic-executing']").exists()).toBe(false);

    const bare = mount(TopicSwitcher, {
      props: {
        topics,
        activeTopicId: "t-default",
        previewTopic: vi.fn(async () => impact()),
        renameTopic: vi.fn(async () => {}),
        archiveTopic: vi.fn(async () => {}),
        restoreTopic: vi.fn(async () => {}),
        teardownTopic: vi.fn(async () => {}),
        clearTopic: vi.fn(async () => {}),
        setTopicIsolation: vi.fn(async () => {}),
      },
      global: { plugins: [i18n] },
    });
    await bare.find("[data-test='group-topic-pill']").trigger("click");
    expect(bare.findAll("[data-test='topic-executing']")).toHaveLength(0);
  });

  it("mirrors the badge on the pill only for the executing active topic", async () => {
    const wrapper = mount(TopicSwitcher, {
      props: {
        topics,
        activeTopicId: "t-extra",
        previewTopic: vi.fn(async () => impact()),
        renameTopic: vi.fn(async () => {}),
        archiveTopic: vi.fn(async () => {}),
        restoreTopic: vi.fn(async () => {}),
        teardownTopic: vi.fn(async () => {}),
        clearTopic: vi.fn(async () => {}),
        setTopicIsolation: vi.fn(async () => {}),
        executingTopicIds: ["t-extra"],
      },
      global: { plugins: [i18n] },
    });
    const pillBadge = wrapper.find("[data-test='topic-pill-executing']");
    expect(pillBadge.exists()).toBe(true);
    expect(pillBadge.attributes("aria-label")).toBe("Running");

    const other = mount(TopicSwitcher, {
      props: {
        topics,
        activeTopicId: "t-default",
        previewTopic: vi.fn(async () => impact()),
        renameTopic: vi.fn(async () => {}),
        archiveTopic: vi.fn(async () => {}),
        restoreTopic: vi.fn(async () => {}),
        teardownTopic: vi.fn(async () => {}),
        clearTopic: vi.fn(async () => {}),
        setTopicIsolation: vi.fn(async () => {}),
        executingTopicIds: ["t-extra"],
      },
      global: { plugins: [i18n] },
    });
    expect(other.find("[data-test='topic-pill-executing']").exists()).toBe(false);
  });

  it("re-probes executing topics when the panel opens", async () => {
    const refreshExecutingTopics = vi.fn(async () => {});
    const wrapper = mount(TopicSwitcher, {
      props: {
        topics,
        activeTopicId: "t-default",
        previewTopic: vi.fn(async () => impact()),
        renameTopic: vi.fn(async () => {}),
        archiveTopic: vi.fn(async () => {}),
        restoreTopic: vi.fn(async () => {}),
        teardownTopic: vi.fn(async () => {}),
        clearTopic: vi.fn(async () => {}),
        setTopicIsolation: vi.fn(async () => {}),
        refreshExecutingTopics,
      },
      global: { plugins: [i18n] },
    });
    expect(refreshExecutingTopics).toHaveBeenCalledTimes(0);
    await wrapper.find("[data-test='group-topic-pill']").trigger("click");
    await flushPromises();
    expect(refreshExecutingTopics).toHaveBeenCalledTimes(1);
  });
});

describe("TopicSwitcher (Group fork entry)", () => {
  function mountGroup(forkTopic?: (topic: TopicSummaryDto) => void) {
    return mount(TopicSwitcher, {
      props: {
        variant: "direct",
        topics,
        activeTopicId: "t-default",
        previewTopic: vi.fn(async () => impact()),
        renameTopic: vi.fn(async () => {}),
        archiveTopic: vi.fn(async () => {}),
        restoreTopic: vi.fn(async () => {}),
        teardownTopic: vi.fn(async () => {}),
        clearTopic: vi.fn(async () => {}),
        ...(forkTopic ? { forkTopic } : {}),
      },
      global: { plugins: [i18n] },
    });
  }

  it("offers Fork only when the capability entry is wired", async () => {
    const hidden = mountGroup();
    await hidden.find("[data-test='topic-menu']").trigger("click");
    await hidden.findAll("[data-test='topic-row']")[1]!.find("[data-test='topic-row-more']").trigger("click");
    expect(hidden.find("[data-test='menu-fork']").exists()).toBe(false);
    hidden.unmount();

    const forkTopic = vi.fn();
    const shown = mountGroup(forkTopic);
    await shown.find("[data-test='topic-menu']").trigger("click");
    await shown.findAll("[data-test='topic-row']")[1]!.find("[data-test='topic-row-more']").trigger("click");
    await shown.find("[data-test='menu-fork']").trigger("click");
    expect(forkTopic).toHaveBeenCalledWith(expect.objectContaining({ id: "t-extra" }));
    expect(shown.find("[data-test='topic-panel']").exists()).toBe(false);
    shown.unmount();
  });

  it("keeps delete and clear reachable from the row menu", async () => {
    const wrapper = mountGroup(vi.fn());
    await wrapper.find("[data-test='topic-menu']").trigger("click");
    await wrapper.findAll("[data-test='topic-row']")[1]!.find("[data-test='topic-row-more']").trigger("click");
    await wrapper.find("[data-test='menu-delete']").trigger("click");
    expect(wrapper.find("[data-test='topic-confirm']").exists()).toBe(true);
    wrapper.unmount();

    const cleared = mountGroup(vi.fn());
    await cleared.find("[data-test='topic-menu']").trigger("click");
    await cleared.findAll("[data-test='topic-row']")[0]!.find("[data-test='topic-row-more']").trigger("click");
    await cleared.find("[data-test='menu-clear']").trigger("click");
    expect(cleared.find("[data-test='topic-confirm']").exists()).toBe(true);
    cleared.unmount();
  });
});
