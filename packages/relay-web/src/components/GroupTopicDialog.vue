<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useModalA11y } from "../lib/use-modal-a11y";
import { navigateBack } from "../lib/mobile-back";
import { useGroupsStore } from "../stores/groups";
import { useInstancesStore } from "../stores/instances";
import SelectMenu, { type SelectGroup } from "./SelectMenu.vue";

const emit = defineEmits<{
  close: [];
}>();

const groupsStore = useGroupsStore();
const instancesStore = useInstancesStore();
const { t } = useI18n();

const dialogEl = ref<HTMLElement | null>(null);
useModalA11y(dialogEl, () => emit("close"));

const title = ref("");
const workspace = ref("");
const isolation = ref<"shared" | "shared-single-writer" | "worktree-per-member">("shared-single-writer");
const creating = ref(false);

const workspaces = computed(() => {
  const instId = groupsStore.instanceId;
  if (!instId) return [];
  return instancesStore.byId(instId)?.workspaces ?? [];
});

const workspacesLoad = ref<"loading" | "ready" | "failed">("loading");

const workspaceGroups = computed<SelectGroup[]>(() => [
  { options: workspaces.value.map((w) => ({ value: w.name, label: w.name })) },
]);
const isolationGroups = computed<SelectGroup[]>(() => [
  {
    options: [
      { value: "shared-single-writer", label: t("group.topic.isolationSingleWriter") },
      { value: "shared", label: t("group.topic.isolationShared") },
      { value: "worktree-per-member", label: t("group.topic.isolationWorktree") },
    ],
  },
]);

async function loadWorkspaces(): Promise<void> {
  const instId = groupsStore.instanceId;
  if (!instId) return;
  workspacesLoad.value = "loading";
  try {
    await instancesStore.loadWorkspaces(instId);
    workspacesLoad.value = "ready";
  } catch {
    workspacesLoad.value = "failed";
  }
}

void loadWorkspaces();

async function handleCreate(): Promise<void> {
  const name = title.value.trim();
  if (!name || !workspace.value || !groupsStore.instanceId || !groupsStore.activeConversationId) return;
  creating.value = true;
  try {
    await groupsStore.createGroupTopic(
      groupsStore.instanceId,
      groupsStore.activeConversationId,
      name,
      { workspace: workspace.value, isolation: isolation.value },
    );
    title.value = "";
    emit("close");
  } catch (err: unknown) {
    groupsStore.generalError = err instanceof Error ? err.message : String(err);
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
       @click.self="navigateBack">
    <div ref="dialogEl" role="dialog" aria-modal="true" aria-labelledby="group-topic-title" tabindex="-1" class="w-full max-w-sm rounded-2xl bg-surface p-4 shadow-float">
      <h3 id="group-topic-title" class="mb-2 text-sm font-semibold">{{ $t("group.topic.createTitle") }}</h3>
      <p class="mb-3 text-xs text-fg-muted">{{ $t("group.topic.createHint") }}</p>
      <form @submit.prevent="handleCreate">
        <input
          v-model="title"
          type="text"
          required
          maxlength="60"
          :placeholder="$t('bot.topic.titlePlaceholder')"
          class="mb-3 w-full rounded-lg bg-surface-2 px-3 py-1.5 text-sm outline-none"
        />
        <label class="mb-1 block text-xs font-medium text-fg-muted">{{ $t("bot.fields.workspace") }}</label>
        <SelectMenu
          v-model="workspace"
          data-test="group-topic-workspace"
          :aria-label='$t("bot.fields.workspace")'
          :title='$t("bot.fields.workspace")'
          :placeholder="workspacesLoad === 'loading' && !workspaces.length ? $t('common.loading') : $t('group.topic.workspacePlaceholder')"
          :groups="workspaceGroups"
        />
        <p v-if="workspacesLoad === 'failed'" data-test="group-topic-workspaces-failed" class="-mt-2 mb-3 flex items-center gap-2 text-xs text-danger">
          <span>{{ $t("group.topic.workspacesFailed") }}</span>
          <button type="button" data-test="group-topic-workspaces-retry" class="font-medium underline" @click="loadWorkspaces">
            {{ $t("common.retry") }}
          </button>
        </p>
        <label class="mb-1 block text-xs font-medium text-fg-muted">{{ $t("group.topic.isolationLabel") }}</label>
        <SelectMenu
          v-model="isolation"
          data-test="group-topic-isolation"
          :aria-label='$t("group.topic.isolationLabel")'
          :title='$t("group.topic.isolationLabel")'
          :groups="isolationGroups"
        />
        <p class="mb-4 text-xs text-fg-muted">{{ $t(isolation === 'worktree-per-member' ? "group.worktree.boundary" : "group.topic.isolationHint") }}</p>
        <div class="flex items-center justify-end gap-2">
          <button
            type="button"
            class="rounded-lg px-3 py-1.5 text-xs font-medium text-fg-muted hover:bg-raised"
            @click="navigateBack"
          >
            {{ $t("common.cancel") }}
          </button>
          <button
            type="submit"
            :disabled="creating || !title.trim() || !workspace"
            class="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:opacity-90 disabled:opacity-50"
          >
            {{ $t("common.create") }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
