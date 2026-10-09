<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { BotRemovalPreviewDto, LifecycleOperationDto } from "@ganglion/xacpx-relay-protocol";

const props = defineProps<{
  botName: string;
  preview: () => Promise<BotRemovalPreviewDto>;
  remove: (input: {
    requestId: string;
    previewRevision: string;
    clearDirectHistory: boolean;
    releaseDirectBindings: boolean;
  }) => Promise<LifecycleOperationDto>;
  getOperation: (id: string) => Promise<LifecycleOperationDto>;
}>();

const emit = defineEmits<{
  close: [];
  removed: [];
}>();

const { t } = useI18n();
const impact = ref<BotRemovalPreviewDto | null>(null);
const operation = ref<LifecycleOperationDto | null>(null);
const requestId = ref(crypto.randomUUID());
const clearDirectHistory = ref(false);
const releaseDirectBindings = ref(false);
const loading = ref(true);
const pending = ref(false);
const errorText = ref("");

const blocked = computed(() => {
  const current = impact.value;
  if (!current) return true;
  return current.groups.length > 0
    || current.worktrees.length > 0
    || current.memberUnsettledRunIds.length > 0
    || current.controllerResidue.bindingIds.length > 0
    || current.controllerResidue.sessionAliases.length > 0;
});

const needsRetry = computed(() => {
  const phase = operation.value?.phase ?? impact.value?.operation?.phase;
  return phase === "failed" || phase === "indeterminate" || phase === "running";
});

const finished = computed(() => operation.value?.phase === "completed" || impact.value?.phase === "retired");

onMounted(() => {
  void loadPreview();
});

async function loadPreview(): Promise<void> {
  loading.value = true;
  errorText.value = "";
  try {
    const next = await props.preview();
    impact.value = next;
    if (next.operation) {
      requestId.value = next.operation.requestId;
      operation.value = await props.getOperation(next.operation.id);
    }
    if (next.phase === "retired") {
      emit("removed");
    }
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}

async function confirmRemove(): Promise<void> {
  const current = impact.value;
  if (!current || blocked.value || pending.value || finished.value) return;
  pending.value = true;
  errorText.value = "";
  try {
    const result = await props.remove({
      requestId: requestId.value,
      previewRevision: current.revision,
      clearDirectHistory: clearDirectHistory.value,
      releaseDirectBindings: releaseDirectBindings.value,
    });
    operation.value = result;
    if (result.phase === "completed") {
      emit("removed");
      return;
    }
    if (result.phase === "indeterminate") {
      errorText.value = t("bot.removal.indeterminate");
    } else if (result.error) {
      errorText.value = t("bot.removal.failed", { code: result.error.code });
    }
    impact.value = await props.preview();
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    errorText.value = code === "conversation_indeterminate"
      ? t("bot.removal.indeterminate")
      : code
        ? t("bot.removal.failed", { code })
        : error instanceof Error ? error.message : String(error);
    try {
      impact.value = await props.preview();
    } catch {
      // The removal error above is the one the user can act on.
    }
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" @click.self="emit('close')">
    <div role="dialog" aria-modal="true" class="flex max-h-[90vh] w-full max-w-lg flex-col rounded-xl border border-border bg-surface text-fg shadow-2xl">
      <header class="border-b border-border px-5 py-3.5">
        <h2 class="text-base font-semibold">{{ t("bot.removal.title", { name: botName }) }}</h2>
      </header>
      <div class="flex-1 space-y-3 overflow-y-auto px-5 py-4 text-sm">
        <p>{{ t("bot.removal.body") }}</p>
        <p v-if="loading" data-test="removal-loading">{{ t("bot.removal.loading") }}</p>
        <p v-if="errorText" data-test="removal-error" class="text-danger">{{ errorText }}</p>
        <p v-if="finished" data-test="removal-finished">{{ t("bot.removal.removedBanner") }}</p>
        <ul v-if="impact" class="space-y-2 text-xs leading-relaxed">
          <li v-for="group in impact.groups" :key="group.conversationId" data-test="removal-group">
            {{ group.blocker === "group-needs-another-member"
              ? t("bot.removal.groupPair", { title: group.title })
              : t("bot.removal.groupMany", { title: group.title }) }}
          </li>
          <li v-if="impact.worktrees.length" data-test="removal-worktree">{{ t("bot.removal.worktree") }}</li>
          <li v-if="impact.memberUnsettledRunIds.length" data-test="removal-member-work">{{ t("bot.removal.memberWork") }}</li>
          <li v-if="impact.controllerResidue.bindingIds.length || impact.controllerResidue.sessionAliases.length" data-test="removal-controller">
            {{ t("bot.removal.controller") }}
          </li>
          <li v-if="impact.runs.indeterminate.length || impact.operation?.phase === 'indeterminate'" data-test="removal-indeterminate">
            {{ t("bot.removal.indeterminate") }}
          </li>
          <li data-test="removal-history">
            {{ t("bot.removal.directHistoryHint") }}
          </li>
        </ul>
        <label v-if="impact && !finished" class="flex items-start gap-2 text-xs">
          <input v-model="clearDirectHistory" data-test="removal-clear-direct" type="checkbox" :disabled="pending || needsRetry" />
          <span>{{ t("bot.removal.directHistory") }}</span>
        </label>
        <label v-if="impact && impact.externalBindings.length && !finished" class="flex items-start gap-2 text-xs">
          <input v-model="releaseDirectBindings" data-test="removal-release-bindings" type="checkbox" :disabled="pending" />
          <span>{{ t("bot.removal.bindings") }}</span>
        </label>
      </div>
      <footer class="flex justify-end gap-2 border-t border-border px-5 py-3">
        <button type="button" class="rounded-lg px-3 py-1.5 text-sm" @click="emit('close')">{{ t("bot.removal.close") }}</button>
        <button
          v-if="!finished"
          type="button"
          data-test="removal-confirm"
          class="rounded-lg bg-danger px-3 py-1.5 text-sm text-white disabled:opacity-40"
          :disabled="loading || pending || blocked || (impact?.externalBindings.length ? !releaseDirectBindings : false)"
          @click="confirmRemove"
        >
          {{ needsRetry ? t("bot.removal.retry") : t("bot.removal.confirm") }}
        </button>
      </footer>
    </div>
  </div>
</template>
