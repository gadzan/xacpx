<script setup lang="ts">
import { computed, ref } from "vue";
import { useModalA11y } from "../lib/use-modal-a11y";
import { useGroupsStore } from "../stores/groups";
import { useInstancesStore } from "../stores/instances";

const emit = defineEmits<{
  close: [];
}>();

const groupsStore = useGroupsStore();
const instancesStore = useInstancesStore();

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
       @click.self="emit('close')">
    <div ref="dialogEl" role="dialog" aria-modal="true" aria-labelledby="group-topic-title" tabindex="-1" class="w-full max-w-sm rounded-xl border border-border bg-surface p-4 shadow-xl">
      <h3 id="group-topic-title" class="mb-2 text-sm font-semibold">{{ $t("group.topic.createTitle") }}</h3>
      <p class="mb-3 text-xs text-fg-muted">{{ $t("group.topic.createHint") }}</p>
      <form @submit.prevent="handleCreate">
        <input
          v-model="title"
          type="text"
          required
          maxlength="60"
          :placeholder="$t('bot.topic.titlePlaceholder')"
          class="mb-3 w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none focus:border-accent"
        />
        <label class="mb-1 block text-xs font-medium text-fg-muted">{{ $t("bot.fields.workspace") }}</label>
        <select
          v-model="workspace"
          required
          class="mb-3 w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none focus:border-accent"
        >
          <option value="" disabled>{{ $t("group.topic.workspacePlaceholder") }}</option>
          <option v-for="w in workspaces" :key="w.name" :value="w.name">{{ w.name }}</option>
        </select>
        <label class="mb-1 block text-xs font-medium text-fg-muted">{{ $t("group.topic.isolationLabel") }}</label>
        <select
          v-model="isolation"
          class="mb-4 w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none focus:border-accent"
        >
          <option value="shared-single-writer">{{ $t("group.topic.isolationSingleWriter") }}</option>
          <option value="shared">{{ $t("group.topic.isolationShared") }}</option>
          <option value="worktree-per-member">{{ $t("group.topic.isolationWorktree") }}</option>
        </select>
        <div class="flex items-center justify-end gap-2">
          <button
            type="button"
            class="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg-muted hover:bg-raised"
            @click="emit('close')"
          >
            {{ $t("common.cancel") }}
          </button>
          <button
            type="submit"
            :disabled="creating || !title.trim() || !workspace"
            class="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
          >
            {{ $t("common.create") }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
