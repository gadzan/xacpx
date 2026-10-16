<script setup lang="ts">
import { computed, ref } from "vue";
import { Archive, Check, ChevronDown, Plus, RotateCcw } from "lucide-vue-next";
import type { TopicImpactDto, TopicSummaryDto } from "@ganglion/xacpx-relay-protocol";
import { useTopicActions } from "../lib/use-topic-actions";
import DropdownPanel from "./DropdownPanel.vue";
import { useDropdown } from "../lib/use-dropdown";

const props = defineProps<{
  variant: "direct" | "group";
  topics: TopicSummaryDto[];
  activeTopicId: string | null;
  previewTopic: (topicId: string) => Promise<TopicImpactDto>;
  renameTopic: (topicId: string, title: string) => Promise<void>;
  archiveTopic: (topicId: string) => Promise<void>;
  restoreTopic: (topicId: string) => Promise<void>;
  teardownTopic: (topicId: string, requestId: string, releaseBindings: boolean) => Promise<void>;
  clearTopic: (topicId: string, requestId: string, releaseBindings: boolean) => Promise<void>;
}>();

const emit = defineEmits<{
  select: [topicId: string];
  create: [];
}>();

const dd = useDropdown();
const query = ref("");

const { editingId, draftTitle, pendingId, actionError, confirmKind, confirmImpact, releaseBindings, confirming,
  confirmBlocked, statusLabel, startRename, saveRename, archive, restore, openConfirm, closeConfirm, submitConfirm } =
  useTopicActions(props);

const active = computed(() => props.topics.find((topic) => topic.id === props.activeTopicId) ?? null);
const visible = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return props.topics.filter((topic) => {
    if (!needle) return true;
    return topic.title.toLowerCase().includes(needle);
  });
});

// A finished delete/clear dismisses the panel; a failed one keeps the confirm dialog open
// with its error, and cancelling leaves the panel where the user left it.
async function submitConfirmAndClose(): Promise<void> {
  await submitConfirm();
  if (!confirmKind.value) dd.closeMenu();
}
</script>

<template>
  <div class="relative flex min-w-0 flex-1 items-center gap-2">
    <button
      type="button"
      :ref="(el) => (dd.trigger = el as HTMLElement | null)"
      class="flex min-w-0 items-center gap-1 rounded-sm px-2 py-1 text-xs transition-colors"
      :class="dd.open ? 'bg-surface-2 text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'"
      :data-test="variant === 'group' ? 'group-topic-pill' : 'topic-menu'"
      :data-topic-status="active?.status ?? 'active'"
      :aria-haspopup="true"
      :aria-expanded="dd.open"
      @click="dd.toggle()"
    >
      <span class="truncate">{{ active?.title || $t("bot.topic.default") }}</span>
      <span v-if="active && statusLabel(active)" class="shrink-0 text-fg-muted">{{ statusLabel(active) }}</span>
      <ChevronDown :size="12" class="shrink-0 text-fg-muted transition-transform" :class="dd.open ? 'rotate-180' : ''" />
    </button>
    <button
      type="button"
      class="ml-auto flex shrink-0 items-center gap-1 rounded-sm px-2 py-1 text-xs font-medium text-accent hover:bg-accent-soft"
      :data-test="variant === 'group' ? 'group-new-topic-button' : 'new-topic-button'"
      @click="emit('create')"
    >
      <Plus :size="13" />
      <span>{{ $t("bot.topic.new") }}</span>
    </button>

    <!-- One panel (unified §F): popover on desktop, MobileSheet below lg. Row actions
         stay inline (rename/archive/delete chips), matching the manager's density. -->
    <DropdownPanel :dd="dd" tone="surface" width="w-80" placement="bottom-end"
                   :title='$t("mobileBar.switchTopic")' test-id="topic-panel"
                   :nav-count="visible.length" v-model:query="query"
                   @navigate="(i) => { const topic = visible[i]; if (topic) { emit('select', topic.id); dd.closeMenu(); } }">
      <template #default="{ mobile }">
        <div class="p-2">
          <input
            v-model="query"
            type="search"
            data-test="topic-search"
            :placeholder="$t('bot.topic.search')"
            class="w-full rounded-sm bg-surface-2 px-2 py-1 text-xs outline-none"
          />
        </div>
        <p v-if="!visible.length" class="px-2 py-3 text-sm text-fg-muted">{{ $t("bot.topic.empty") }}</p>
        <div v-for="(topic, i) in visible" :key="topic.id"
             data-test="topic-row" :data-topic-id="topic.id" :data-topic-status="topic.status"
             class="flex flex-col gap-1 rounded-sm px-2 py-1.5 text-sm"
             :class="[mobile ? 'min-h-11' : '', i === dd.highlight ? 'bg-surface-2' : '']">
          <div class="flex items-center gap-1">
            <button type="button" class="min-w-0 flex-1 truncate text-left"
                    :class="topic.id === activeTopicId ? 'font-medium text-fg' : 'text-fg'"
                    @click="emit('select', topic.id); dd.closeMenu()">
              {{ topic.title || $t("bot.topic.default") }}
            </button>
            <Archive v-if="topic.status === 'archived'" :size="12" class="shrink-0 text-fg-muted" />
            <RotateCcw v-if="topic.status === 'deleting'" :size="12" class="shrink-0 text-fg-muted" />
            <Check v-if="topic.id === activeTopicId" :size="14" class="shrink-0 text-accent" />
          </div>
          <form v-if="editingId === topic.id" class="flex gap-1" @submit.prevent="saveRename(topic)">
            <input v-model="draftTitle" data-test="topic-rename-input" maxlength="200" class="min-w-0 flex-1 rounded-sm bg-surface-2 px-1 py-0.5 text-xs" />
            <button type="submit" data-test="topic-rename-save" class="rounded-sm bg-accent px-2 py-0.5 text-xs text-on-accent">{{ $t("bot.topic.save") }}</button>
          </form>
          <div v-else class="flex flex-wrap gap-1">
            <button v-if="topic.status !== 'deleting'" type="button" data-test="topic-rename" class="rounded-sm px-1.5 py-0.5 text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg" :disabled="pendingId === topic.id" @click="startRename(topic)">{{ $t("bot.topic.rename") }}</button>
            <button v-if="topic.status === 'active'" type="button" data-test="topic-archive" class="rounded-sm px-1.5 py-0.5 text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg" :disabled="pendingId === topic.id" @click="archive(topic)">{{ $t("bot.topic.archive") }}</button>
            <button v-if="topic.status === 'archived'" type="button" data-test="topic-restore" class="rounded-sm px-1.5 py-0.5 text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg" :disabled="pendingId === topic.id" @click="restore(topic)">{{ $t("bot.topic.restore") }}</button>
            <button v-if="topic.defaultDirect === true && topic.status !== 'deleting'" type="button" data-test="topic-clear" class="rounded-sm px-1.5 py-0.5 text-danger transition-colors hover:bg-danger/10" :disabled="pendingId === topic.id" @click="openConfirm('clear', topic)">{{ $t("bot.topic.clear") }}</button>
            <button v-if="topic.defaultDirect !== true && topic.status !== 'deleting'" type="button" data-test="topic-delete" class="rounded-sm px-1.5 py-0.5 text-danger transition-colors hover:bg-danger/10" :disabled="pendingId === topic.id" @click="openConfirm('delete', topic)">{{ $t("bot.topic.delete") }}</button>
          </div>
        </div>
        <p v-if="actionError" data-test="topic-action-error" class="px-2 py-1 text-xs text-danger">{{ actionError }}</p>
      </template>
    </DropdownPanel>

    <div v-if="confirmKind" class="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-4 md:items-center" @click.self="closeConfirm">
      <div role="dialog" aria-modal="true" data-test="topic-confirm" class="w-full max-w-sm rounded-2xl bg-surface p-4 shadow-float">
        <h3 class="text-sm font-semibold">{{ confirmKind === "clear" ? $t("bot.topic.confirmClearTitle") : $t("bot.topic.confirmDeleteTitle") }}</h3>
        <p class="mt-2 text-xs text-fg-muted">{{ confirmKind === "clear" ? $t("bot.topic.confirmClearBody") : $t("bot.topic.confirmDeleteBody") }}</p>
        <p v-if="(confirmImpact?.worktreeRunIds.length ?? 0) > 0" data-test="topic-worktree-warning" class="mt-2 text-xs text-danger">{{ $t("bot.topic.worktreeWarning") }}</p>
        <label v-if="(confirmImpact?.bindings.length ?? 0) > 0" class="mt-3 flex items-start gap-2 text-xs">
          <input v-model="releaseBindings" data-test="topic-release-bindings" type="checkbox" class="mt-0.5" />
          <span>{{ $t("bot.topic.confirmUnbind") }}</span>
        </label>
        <p v-if="actionError" class="mt-2 text-xs text-danger">{{ actionError }}</p>
        <div class="mt-4 flex justify-end gap-2">
          <button type="button" class="rounded-lg px-3 py-1.5 text-xs" @click="closeConfirm">{{ $t("common.cancel") }}</button>
          <button
            type="button"
            data-test="topic-confirm-submit"
            class="rounded-lg bg-danger px-3 py-1.5 text-xs font-medium text-on-danger disabled:opacity-50"
            :disabled="confirmBlocked"
            @click="submitConfirmAndClose"
          >
            {{ confirmKind === "clear" ? $t("bot.topic.clear") : $t("bot.topic.delete") }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
