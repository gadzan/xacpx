<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ConversationRunDto, TopicSummaryDto } from "@ganglion/xacpx-relay-protocol";
import { useModalA11y } from "../lib/use-modal-a11y";
import { navigateBack } from "../lib/mobile-back";
import { useGroupsStore } from "../stores/groups";

const props = defineProps<{
  sourceTopic: TopicSummaryDto;
  /** The boundary this open explicitly cuts at. */
  sourcePoint: { type: "latest_stable" } | { type: "run"; runId: string };
  /** Cache-resolved Run for the confirm label only; never sent as the point. */
  resolvedRun?: ConversationRunDto | null;
}>();

const emit = defineEmits<{
  close: [];
}>();

const groupsStore = useGroupsStore();
const { t } = useI18n();

const dialogEl = ref<HTMLElement | null>(null);
useModalA11y(dialogEl, () => emit("close"));

const title = ref(`${props.sourceTopic.title} fork`);
const creating = ref(false);
const errorCode = ref<string | null>(null);
// Minted once per open: every retry of this dialog replays the same pair, so
// the core returns the already-committed Topic instead of a second one.
const targetTopicId = `topic_${crypto.randomUUID()}`;
const requestId = crypto.randomUUID();

const forkPointLabel = computed(() => {
  if (props.sourcePoint.type === "run") {
    return props.resolvedRun?.createdAt
      ? t("group.topic.forkPointRunAt", { time: props.resolvedRun.createdAt })
      : t("group.topic.forkPointRun");
  }
  return props.resolvedRun?.createdAt
    ? t("group.topic.forkPointLatestAt", { time: props.resolvedRun.createdAt })
    : t("group.topic.forkPointLatest");
});

function errorMessage(code: string): string {
  switch (code) {
    case "topic_fork_empty":
      return t("group.topic.forkErrors.empty");
    case "topic_fork_source_unsettled":
      return t("group.topic.forkErrors.unsettled");
    case "topic_fork_source_changed":
      return t("group.topic.forkErrors.changed");
    case "topic_fork_history_missing":
      return t("group.topic.forkErrors.historyMissing");
    case "topic_exists":
      return t("group.topic.forkErrors.exists");
    case "topic_not_found":
      return t("group.topic.forkErrors.notFound");
    case "conversation_not_group":
      return t("group.topic.forkErrors.notGroup");
    case "unknown-type":
    case "unsupported-rpc":
      return t("bot.errors.connectorOutdated");
    default:
      return t("group.topic.forkErrors.failed");
  }
}

async function handleFork(): Promise<void> {
  const instanceId = groupsStore.instanceId;
  if (!instanceId || !groupsStore.activeConversationId || creating.value) return;
  creating.value = true;
  errorCode.value = null;
  try {
    await groupsStore.forkGroupTopic(instanceId, {
      conversationId: groupsStore.activeConversationId,
      sourceTopicId: props.sourceTopic.id,
      targetTopicId,
      requestId,
      sourcePoint: props.sourcePoint,
      title: title.value.trim() || undefined,
    });
    emit("close");
  } catch (err: unknown) {
    errorCode.value = typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "failed";
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4 backdrop-blur-sm"
       @click.self="navigateBack">
    <div ref="dialogEl" role="dialog" aria-modal="true" aria-labelledby="fork-topic-title" tabindex="-1" data-test="fork-topic-dialog" class="w-[calc(100vw-40px)] max-w-[380px] rounded-2xl bg-glass-strong p-4 shadow-glass-float backdrop-blur-glass backdrop-saturate-glass lg:w-full">
      <h3 id="fork-topic-title" class="mb-2 text-base font-semibold text-fg">{{ $t("group.topic.forkTitle") }}</h3>
      <p class="mb-3 text-sm text-fg-muted-overlay">{{ $t("group.topic.forkHint") }}</p>
      <form @submit.prevent="handleFork">
        <input
          v-model="title"
          type="text"
          required
          maxlength="60"
          :placeholder="$t('bot.topic.titlePlaceholder')"
          data-test="fork-topic-title"
          class="mb-3 w-full rounded-lg bg-surface-2 px-3 py-1.5 text-sm outline-none"
        />
        <p data-test="fork-topic-point" class="mb-4 rounded-lg bg-surface-2 px-3 py-2 text-xs leading-relaxed text-fg-muted">
          {{ forkPointLabel }}
        </p>
        <p v-if="errorCode" data-test="fork-topic-error" class="mb-3 text-xs text-danger-overlay">
          {{ errorMessage(errorCode) }}
        </p>
        <div class="flex gap-2 lg:items-center lg:justify-end">
          <button
            type="button"
            class="h-11 flex-1 rounded-btn border border-hairline bg-raised px-3 text-ui font-medium text-fg hover:bg-fill-hover lg:h-8 lg:flex-none"
            @click="navigateBack"
          >
            {{ $t("common.cancel") }}
          </button>
          <button
            type="submit"
            data-test="fork-topic-submit"
            :disabled="creating || !title.trim()"
            class="h-11 flex-1 rounded-btn bg-accent px-3 text-ui font-semibold text-on-accent hover:opacity-90 disabled:opacity-50 lg:h-8 lg:flex-none"
          >
            {{ creating ? $t("common.loading") : $t("group.topic.forkAction") }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
