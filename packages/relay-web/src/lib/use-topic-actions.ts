import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { TopicImpactDto, TopicSummaryDto } from "@ganglion/xacpx-relay-protocol";

export type TopicIsolation = "shared" | "shared-single-writer" | "worktree-per-member";

export interface TopicActionHandlers {
  previewTopic: (topicId: string) => Promise<TopicImpactDto>;
  renameTopic: (topicId: string, title: string) => Promise<void>;
  archiveTopic: (topicId: string) => Promise<void>;
  restoreTopic: (topicId: string) => Promise<void>;
  teardownTopic: (topicId: string, requestId: string, releaseBindings: boolean) => Promise<void>;
  clearTopic: (topicId: string, requestId: string, releaseBindings: boolean) => Promise<void>;
  /** Absent on surfaces whose topics have no execution target (Direct). */
  setTopicIsolation?: (topicId: string, isolation: TopicIsolation) => Promise<void>;
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
  const isolationTopic = ref<TopicSummaryDto | null>(null);
  const isolationSaving = ref(false);

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

  async function run(action: () => Promise<void>): Promise<void> {
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
    await run(async () => {
      await handlers.renameTopic(topic.id, title);
      editingId.value = null;
    });
  }

  function archive(topic: TopicSummaryDto): Promise<void> {
    return run(() => handlers.archiveTopic(topic.id));
  }

  function restore(topic: TopicSummaryDto): Promise<void> {
    return run(() => handlers.restoreTopic(topic.id));
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

  function openIsolation(topic: TopicSummaryDto): void {
    actionError.value = null;
    isolationTopic.value = topic;
  }

  function closeIsolation(): void {
    if (isolationSaving.value) return;
    isolationTopic.value = null;
  }

  /** Refusals the switch can hit, so the dialog never shows a raw server sentence. */
  function isolationErrorText(error: unknown): string {
    const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code ?? "") : "";
    switch (code) {
      case "conversation_not_settled":
        return t("bot.topic.isolationErrors.unsettled");
      case "worktree_unprovisioned":
        return t("bot.topic.isolationErrors.worktreeUnprovisioned");
      case "worktree_runs_pending":
        return t("bot.topic.isolationErrors.worktreeRunsPending");
      case "invalid-isolation":
        return t("bot.topic.isolationErrors.invalidIsolation");
      case "topic_deleting":
      case "conversation_deleting":
        return t("bot.topic.isolationErrors.deleting");
      case "unknown-type":
        return t("bot.errors.connectorOutdated");
      default:
        return t("bot.topic.isolationErrors.failed", {
          msg: error instanceof Error ? error.message : String(error),
        });
    }
  }

  /** Applies the choice and closes only on success, like the delete/clear confirm. */
  async function chooseIsolation(isolation: TopicIsolation): Promise<void> {
    const topic = isolationTopic.value;
    if (isolationSaving.value) return;
    if (!topic || !handlers.setTopicIsolation || topic.executionTarget?.isolation === isolation) {
      isolationTopic.value = null;
      return;
    }
    isolationSaving.value = true;
    actionError.value = null;
    try {
      await handlers.setTopicIsolation(topic.id, isolation);
      isolationTopic.value = null;
    } catch (error: unknown) {
      actionError.value = isolationErrorText(error);
    } finally {
      isolationSaving.value = false;
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
    isolationTopic,
    isolationSaving,
    openIsolation,
    closeIsolation,
    chooseIsolation,
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
