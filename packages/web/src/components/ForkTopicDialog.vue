<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ConversationRunDto, TopicSummaryDto } from "@ganglion/xacpx-relay-protocol";
import DialogShell from "./DialogShell.vue";
import UiButton from "./UiButton.vue";
import { navigateBack } from "../lib/mobile-back";
import { randomUuid } from "../lib/random-id";

/** The one fork call both panes share. The dialog owns the ids and the error
 *  mapping; the pane owns which store performs the RPC, so Group and Direct
 *  reuse this component instead of forking two dialogs. */
export interface ForkTopicRequest {
  conversationId: string;
  sourceTopicId: string;
  targetTopicId: string;
  requestId: string;
  sourcePoint: { type: "latest_stable" } | { type: "run"; runId: string } | { type: "message"; messageId: string };
  title?: string;
}

const props = defineProps<{
  sourceTopic: TopicSummaryDto;
  /** The boundary this open explicitly cuts at. */
  sourcePoint: { type: "latest_stable" } | { type: "run"; runId: string } | { type: "message"; messageId: string };
  /** Cache-resolved Run for the confirm label only; never sent as the point. */
  resolvedRun?: ConversationRunDto | null;
  conversationId: string;
  /** `handoff` tells the user the boundary arrives as one prompt block rather
   *  than as copied rows, so a Direct fork never promises a copied timeline. */
  mode?: "snapshot" | "handoff";
  fork: (input: ForkTopicRequest) => Promise<TopicSummaryDto>;
}>();

const emit = defineEmits<{
  close: [];
}>();

const { t } = useI18n();

const title = ref(`${props.sourceTopic.title} fork`);
const errorCode = ref<string | null>(null);
const creating = ref(false);
// Minted once per open: every retry of this dialog replays the same pair, so
// the core returns the already-committed Topic instead of a second one. The
// one exception is `topic_fork_history_missing`: the core fails closed rather
// than adopting a damaged target, so the next click must start over with a
// fresh pair or it would replay the same unrecoverable ids forever.
const targetTopicId = ref(`topic_${randomUuid()}`);
const requestId = ref(randomUuid());

const hint = computed(() =>
  props.mode === "handoff" ? t("group.topic.forkHintHandoff") : t("group.topic.forkHint"),
);

const forkPointLabel = computed(() => {
  if (props.sourcePoint.type === "message") {
    return t("group.topic.forkPointMessage");
  }
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
    case "topic_deleting":
    case "conversation_deleting":
    case "topic_resetting":
      return t("group.topic.forkErrors.tearingDown");
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
  if (!props.conversationId || creating.value) return;
  creating.value = true;
  errorCode.value = null;
  try {
    await props.fork({
      conversationId: props.conversationId,
      sourceTopicId: props.sourceTopic.id,
      targetTopicId: targetTopicId.value,
      requestId: requestId.value,
      sourcePoint: props.sourcePoint,
      title: title.value.trim() || undefined,
    });
    emit("close");
  } catch (err: unknown) {
    const code = typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "failed";
    if (code === "topic_fork_history_missing") {
      targetTopicId.value = `topic_${randomUuid()}`;
      requestId.value = randomUuid();
    }
    errorCode.value = code;
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <DialogShell
    panel-class="w-[calc(100vw-40px)] max-w-[380px] rounded-2xl p-4 lg:w-full"
    labelledby="fork-topic-title"
    test-id="fork-topic-dialog"
    level="top"
    @close="emit('close')"
  >
      <h3 id="fork-topic-title" class="mb-2 text-base font-semibold text-fg">{{ $t("group.topic.forkTitle") }}</h3>
      <p class="mb-3 text-sm text-fg-muted-overlay" data-test="fork-topic-hint">{{ hint }}</p>
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
          <UiButton variant="secondary" mobile-block @click="navigateBack">
            {{ $t("common.cancel") }}
          </UiButton>
          <UiButton
            type="submit"
            data-test="fork-topic-submit"
            mobile-block
            :disabled="creating || !title.trim()"
          >
            {{ creating ? $t("common.loading") : $t("group.topic.forkAction") }}
          </UiButton>
        </div>
      </form>
  </DialogShell>
</template>
