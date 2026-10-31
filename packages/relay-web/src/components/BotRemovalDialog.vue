<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { BotRemovalPreviewDto, LifecycleOperationDto } from "@ganglion/xacpx-relay-protocol";
import { pushToast } from "../lib/use-toasts";

const props = defineProps<{
  botName: string;
  preview: () => Promise<BotRemovalPreviewDto>;
  remove: (input: {
    requestId: string;
    previewRevision: string;
    clearDirectHistory: boolean;
    releaseDirectBindings: boolean;
    deleteDedicatedWorkspace: boolean;
  }) => Promise<LifecycleOperationDto>;
  getOperation: (id: string) => Promise<LifecycleOperationDto>;
  /** The instance's core deletes a dedicated workspace on request. */
  supportsWorkspaceCleanup?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  removed: [];
}>();

const { t } = useI18n();
const impact = ref<BotRemovalPreviewDto | null>(null);
const operation = ref<LifecycleOperationDto | null>(null);
const requestId = ref<string>(crypto.randomUUID());
const clearDirectHistory = ref(false);
const releaseDirectBindings = ref(false);
const deleteDedicatedWorkspace = ref(false);
const loading = ref(true);
const pending = ref(false);
const errorText = ref("");

/** The Bot has a daemon-allocated workspace the user may delete with it. */
const dedicatedWorkspace = computed(() => impact.value?.dedicatedWorkspace ?? null);

/** A workspace something else still uses cannot be deleted, so the option
 *  stays hidden rather than offering a choice the core would refuse. */
const canDeleteWorkspace = computed(() =>
  props.supportsWorkspaceCleanup === true
  && dedicatedWorkspace.value !== null
  && dedicatedWorkspace.value.inUse === false);

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
      deleteDedicatedWorkspace: deleteDedicatedWorkspace.value,
    });
    operation.value = result;
    if (result.phase === "completed") {
      reportWorkspaceCleanup(result);
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

/**
 * The dialog closes as soon as the Bot is retired, so the workspace cleanup
 * outcome has to reach the user elsewhere. A deleted folder needs no report;
 * a kept or failed one does, or the checkbox would look like it did nothing.
 */
function reportWorkspaceCleanup(result: LifecycleOperationDto): void {
  const cleanup = result.workspaceCleanup;
  if (!cleanup || cleanup.outcome === "deleted") return;
  if (cleanup.outcome === "kept") {
    pushToast("info", "bot.removal.workspaceKept", { path: cleanup.path });
    return;
  }
  pushToast("error", "bot.removal.workspaceFailed", { path: cleanup.path, code: cleanup.code ?? "" });
}
</script>

<template>
  <div class="fixed inset-0 z-[60] flex items-center justify-center bg-scrim p-4 backdrop-blur-sm" @click.self="emit('close')">
    <div role="dialog" aria-modal="true" class="flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl bg-glass-strong text-fg shadow-glass-float backdrop-blur-glass backdrop-saturate-glass">
      <header class="px-5 py-3.5">
        <h2 class="text-base font-semibold">{{ t("bot.removal.title", { name: botName }) }}</h2>
      </header>
      <div class="flex-1 space-y-3 overflow-y-auto px-5 py-4 text-sm text-fg-muted-overlay">
        <p>{{ t("bot.removal.body") }}</p>
        <p v-if="loading" data-test="removal-loading">{{ t("bot.removal.loading") }}</p>
        <p v-if="errorText" data-test="removal-error" class="text-danger-overlay">{{ errorText }}</p>
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
        <label v-if="canDeleteWorkspace && !finished" class="flex items-start gap-2 text-xs">
          <input v-model="deleteDedicatedWorkspace" data-test="removal-delete-workspace" type="checkbox" :disabled="pending" />
          <span>
            {{ t("bot.removal.workspace") }}
            <code data-test="removal-workspace-path" class="break-all text-[11px] opacity-70">{{ dedicatedWorkspace?.path }}</code>
          </span>
        </label>
        <p v-else-if="dedicatedWorkspace?.inUse && !finished" data-test="removal-workspace-in-use" class="text-xs">
          {{ t("bot.removal.workspaceInUse") }}
        </p>
      </div>
      <footer class="flex justify-end gap-2 px-5 py-3">
        <button type="button"
                class="h-8 rounded-btn border border-hairline bg-raised px-3 text-ui font-medium text-fg hover:bg-fill-hover"
                @click="emit('close')">{{ t("bot.removal.close") }}</button>
        <button
          v-if="!finished"
          type="button"
          data-test="removal-confirm"
          class="h-8 rounded-btn bg-danger px-3 text-ui font-semibold text-on-danger disabled:opacity-40"
          :disabled="loading || pending || blocked || (impact?.externalBindings.length ? !releaseDirectBindings : false)"
          @click="confirmRemove"
        >
          {{ needsRetry ? t("bot.removal.retry") : t("bot.removal.confirm") }}
        </button>
      </footer>
    </div>
  </div>
</template>
