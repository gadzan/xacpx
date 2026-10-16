import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { TopicImpactDto, TopicSummaryDto } from "@ganglion/xacpx-relay-protocol";

export interface TopicActionHandlers {
  previewTopic: (topicId: string) => Promise<TopicImpactDto>;
  renameTopic: (topicId: string, title: string) => Promise<void>;
  archiveTopic: (topicId: string) => Promise<void>;
  restoreTopic: (topicId: string) => Promise<void>;
  teardownTopic: (topicId: string, requestId: string, releaseBindings: boolean) => Promise<void>;
  clearTopic: (topicId: string, requestId: string, releaseBindings: boolean) => Promise<void>;
}

// Action state machine behind TopicSwitcher, the one topic surface shared by the group
// chat (GroupPane) and the Bot page (DirectBotPane): rename / archive / restore /
// delete / clear.
export function useTopicActions(handlers: TopicActionHandlers) {
  const { t } = useI18n();
  const editingId = ref<string | null>(null);
  const draftTitle = ref("");
  const actionError = ref<string | null>(null);
  const confirmKind = ref<"delete" | "clear" | null>(null);
  const confirmTopicId = ref<string | null>(null);
  const confirmRequestId = ref("");
  const confirmImpact = ref<TopicImpactDto | null>(null);
  const releaseBindings = ref(false);
  const confirming = ref(false);

  const confirmBlocked = computed(() => {
    const bindings = confirmImpact.value?.bindings.length ?? 0;
    const worktrees = confirmImpact.value?.worktreeRunIds.length ?? 0;
    return confirming.value || (bindings > 0 && !releaseBindings.value) || worktrees > 0;
  });

  function statusLabel(topic: TopicSummaryDto): string {
    if (topic.status === "archived") return t("bot.topic.archived");
    if (topic.status === "deleting") return t("bot.topic.deleting");
    return "";
  }

  async function run(_topicId: string, action: () => Promise<void>): Promise<void> {
    actionError.value = null;
    try {
      await action();
    } catch (error: unknown) {
      actionError.value = error instanceof Error ? error.message : String(error);
    }
  }

  function startRename(topic: TopicSummaryDto): void {
    editingId.value = topic.id;
    draftTitle.value = topic.title;
  }

  async function saveRename(topic: TopicSummaryDto): Promise<void> {
    const title = draftTitle.value.trim();
    if (!title || title === topic.title) {
      editingId.value = null;
      return;
    }
    await run(topic.id, async () => {
      await handlers.renameTopic(topic.id, title);
      editingId.value = null;
    });
  }

  function archive(topic: TopicSummaryDto): Promise<void> {
    return run(topic.id, () => handlers.archiveTopic(topic.id));
  }

  function restore(topic: TopicSummaryDto): Promise<void> {
    return run(topic.id, () => handlers.restoreTopic(topic.id));
  }

  async function openConfirm(kind: "delete" | "clear", topic: TopicSummaryDto): Promise<void> {
    confirmKind.value = kind;
    confirmTopicId.value = topic.id;
    confirmRequestId.value = crypto.randomUUID();
    releaseBindings.value = false;
    confirmImpact.value = null;
    actionError.value = null;
    try {
      confirmImpact.value = await handlers.previewTopic(topic.id);
    } catch (error: unknown) {
      actionError.value = error instanceof Error ? error.message : String(error);
    }
  }

  function closeConfirm(): void {
    if (confirming.value) return;
    confirmKind.value = null;
    confirmTopicId.value = null;
    confirmImpact.value = null;
  }

  async function submitConfirm(): Promise<void> {
    const topicId = confirmTopicId.value;
    const kind = confirmKind.value;
    if (!topicId || !kind) return;
    const bindings = confirmImpact.value?.bindings.length ?? 0;
    if (bindings > 0 && !releaseBindings.value) return;
    if ((confirmImpact.value?.worktreeRunIds.length ?? 0) > 0) return;
    confirming.value = true;
    actionError.value = null;
    try {
      if (kind === "delete") {
        await handlers.teardownTopic(topicId, confirmRequestId.value, releaseBindings.value);
      } else {
        await handlers.clearTopic(topicId, confirmRequestId.value, releaseBindings.value);
      }
      closeConfirm();
    } catch (error: unknown) {
      actionError.value = error instanceof Error ? error.message : String(error);
    } finally {
      confirming.value = false;
    }
  }

  return {
    editingId,
    draftTitle,
    actionError,
    confirmKind,
    confirmImpact,
    releaseBindings,
    confirming,
    confirmBlocked,
    statusLabel,
    startRename,
    saveRename,
    archive,
    restore,
    openConfirm,
    closeConfirm,
    submitConfirm,
  };
}
