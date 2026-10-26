import { mount, flushPromises } from "@vue/test-utils";
import { describe, expect, it, vi, beforeEach } from "vitest";
import BotRemovalDialog from "../components/BotRemovalDialog.vue";
import { i18n } from "../i18n";
import type { BotRemovalPreviewDto, LifecycleOperationDto } from "@ganglion/xacpx-relay-protocol";
import { dismissToast, useToasts } from "../lib/use-toasts";


function impact(patch: Partial<BotRemovalPreviewDto> = {}): BotRemovalPreviewDto {
  return {
    botId: "bot_a",
    name: "Reviewer",
    phase: "previewed",
    revision: "rev-1",
    directTopics: [{ id: "topic_1", title: "Default", status: "active" }],
    runs: { active: [], queued: [], indeterminate: [] },
    groups: [],
    departedMemberRuntimes: [],
    worktrees: [],
    externalBindings: [],
    history: { directMessages: 2, directRuns: 1, groupMessages: 4, groupRuns: 1 },
    controllerResidue: { bindingIds: [], sessionAliases: [] },
    memberUnsettledRunIds: [],
    ...patch,
  };
}

function operation(phase: LifecycleOperationDto["phase"], patch: Partial<LifecycleOperationDto> = {}): LifecycleOperationDto {
  return {
    id: "bot-remove:req-1",
    kind: "bot-remove",
    subjectId: "bot_a",
    requestId: "req-1",
    phase,
    updatedAt: "2026-10-09T00:00:00.000Z",
    ...patch,
  };
}

function mountDialog(previewValue: BotRemovalPreviewDto, removeImpl?: (input: {
  requestId: string;
  previewRevision: string;
  clearDirectHistory: boolean;
  releaseDirectBindings: boolean;
  deleteDedicatedWorkspace: boolean;
}) => Promise<LifecycleOperationDto>, supportsWorkspaceCleanup = false) {
  const preview = vi.fn(async () => previewValue);
  const remove = vi.fn(removeImpl ?? (async () => operation("completed", { clearDirectHistory: false })));
  const getOperation = vi.fn(async () => operation("failed", { error: { code: "session_release_failed", message: "release failed" }, requestId: "req-kept" }));
  const wrapper = mount(BotRemovalDialog, {
    props: {
      botName: "Reviewer",
      preview,
      remove,
      getOperation,
      supportsWorkspaceCleanup,
    },
    global: { plugins: [i18n] },
  });
  return { wrapper, preview, remove, getOperation };
}

describe("BotRemovalDialog", () => {
  beforeEach(() => {
    for (const toast of [...useToasts().value]) dismissToast(toast.id);
  });
  it("shows that group history stays and sends an explicit direct-history choice", async () => {
    const { wrapper, remove } = mountDialog(impact());
    await flushPromises();
    expect(wrapper.text()).toContain("Group transcripts and other bots stay");
    expect(wrapper.text()).not.toContain("erase all history");
    await wrapper.get("[data-test=removal-clear-direct]").setValue(true);
    await wrapper.get("[data-test=removal-confirm]").trigger("click");
    await flushPromises();
    expect(remove).toHaveBeenCalledTimes(1);
    const input = remove.mock.calls[0]![0];
    expect(input.previewRevision).toBe("rev-1");
    expect(input.clearDirectHistory).toBe(true);
    expect(input.requestId).toMatch(/.+/);
    expect(wrapper.text()).toContain("This bot was removed. Group history stays.");
  });

  it("blocks removal while the bot is still in a two-member group", async () => {
    const { wrapper, remove } = mountDialog(impact({
      groups: [{
        conversationId: "group_1",
        title: "Pair",
        memberCount: 2,
        blocker: "group-needs-another-member",
      }],
    }));
    await flushPromises();
    expect(wrapper.get("[data-test=removal-group]").text()).toContain("will not drop the other member");
    expect(wrapper.get("[data-test=removal-confirm]").attributes("disabled")).toBeDefined();
    await wrapper.get("[data-test=removal-confirm]").trigger("click");
    expect(remove).not.toHaveBeenCalled();
  });

  it("retries a cleanup that did not finish with the same request", async () => {
    const previewValue = impact({
      phase: "deleting",
      operation: {
        id: "bot-remove:req-kept",
        requestId: "req-kept",
        phase: "failed",
        error: { code: "session_release_failed", message: "release failed" },
      },
    });
    const { wrapper, remove, getOperation } = mountDialog(previewValue, async () => operation("completed", { requestId: "req-kept" }));
    await flushPromises();
    expect(getOperation).toHaveBeenCalledWith("bot-remove:req-kept");
    expect(wrapper.get("[data-test=removal-confirm]").text()).toContain("Retry cleanup");
    await wrapper.get("[data-test=removal-confirm]").trigger("click");
    await flushPromises();
    expect(remove.mock.calls[0]![0].requestId).toBe("req-kept");
    expect(wrapper.text()).toContain("Group history stays");
  });

  it("names a removed bot in the removal result", async () => {
    const { wrapper } = mountDialog(impact({ phase: "retired" }));
    await flushPromises();
    expect(wrapper.get("[data-test=removal-finished]").text()).toContain("Group history stays");
  });

  it("offers the dedicated workspace folder and sends the delete flag", async () => {
    const { wrapper, remove } = mountDialog(impact({
      dedicatedWorkspace: { name: "bots/reviewer", path: "/home/u/.xacpx/bots/reviewer", inUse: false },
    }), undefined, true);
    await flushPromises();
    expect(wrapper.get("[data-test=removal-workspace-path]").text()).toContain("/home/u/.xacpx/bots/reviewer");
    await wrapper.get("[data-test=removal-delete-workspace]").setValue(true);
    await wrapper.get("[data-test=removal-confirm]").trigger("click");
    await flushPromises();
    expect(remove.mock.calls[0]![0].deleteDedicatedWorkspace).toBe(true);
  });

  it("keeps the flag off when the instance cannot delete workspaces", async () => {
    const { wrapper, remove } = mountDialog(impact({
      dedicatedWorkspace: { name: "bots/reviewer", path: "/home/u/.xacpx/bots/reviewer", inUse: false },
    }));
    await flushPromises();
    expect(wrapper.find("[data-test=removal-delete-workspace]").exists()).toBe(false);
    await wrapper.get("[data-test=removal-confirm]").trigger("click");
    await flushPromises();
    expect(remove.mock.calls[0]![0].deleteDedicatedWorkspace).toBe(false);
  });

  it("explains that an in-use workspace is kept instead of offering to delete it", async () => {
    const { wrapper } = mountDialog(impact({
      dedicatedWorkspace: { name: "bots/reviewer", path: "/home/u/.xacpx/bots/reviewer", inUse: true },
    }), undefined, true);
    await flushPromises();
    expect(wrapper.find("[data-test=removal-delete-workspace]").exists()).toBe(false);
    expect(wrapper.get("[data-test=removal-workspace-in-use]").text()).toContain("still in use");
  });

  it("reports a workspace that was kept or could not be deleted", async () => {
    const { wrapper } = mountDialog(impact({
      dedicatedWorkspace: { name: "bots/reviewer", path: "/home/u/.xacpx/bots/reviewer", inUse: false },
    }), async () => operation("completed", {
      workspaceCleanup: { outcome: "kept", path: "/home/u/.xacpx/bots/reviewer", code: "workspace_in_use" },
    }), true);
    await flushPromises();
    await wrapper.get("[data-test=removal-confirm]").trigger("click");
    await flushPromises();
    const toasts = useToasts().value;
    expect(toasts[0]?.key).toBe("bot.removal.workspaceKept");
    expect(toasts[0]?.params?.path).toBe("/home/u/.xacpx/bots/reviewer");
  });

  it("stays silent when the workspace was deleted", async () => {
    const { wrapper } = mountDialog(impact({
      dedicatedWorkspace: { name: "bots/reviewer", path: "/home/u/.xacpx/bots/reviewer", inUse: false },
    }), async () => operation("completed", {
      workspaceCleanup: { outcome: "deleted", path: "/home/u/.xacpx/bots/reviewer" },
    }), true);
    await flushPromises();
    await wrapper.get("[data-test=removal-confirm]").trigger("click");
    await flushPromises();
    expect(useToasts().value.some((toast) => toast.key.startsWith("bot.removal.workspace"))).toBe(false);
  });
});
