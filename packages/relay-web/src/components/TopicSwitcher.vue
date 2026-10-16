<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Archive, Check, ChevronDown, MoreHorizontal, Plus, RotateCcw } from "lucide-vue-next";
import type { TopicImpactDto, TopicSummaryDto } from "@ganglion/xacpx-relay-protocol";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu.vue";
import DropdownPanel from "./DropdownPanel.vue";
import { useDropdown } from "../lib/use-dropdown";
import { useTopicActions } from "../lib/use-topic-actions";

const props = defineProps<{
  topics: TopicSummaryDto[];
  activeTopicId: string | null;
  previewTopic: (topicId: string) => Promise<TopicImpactDto>;
  renameTopic: (topicId: string, title: string) => Promise<void>;
  archiveTopic: (topicId: string) => Promise<void>;
  restoreTopic: (topicId: string) => Promise<void>;
  teardownTopic: (topicId: string, requestId: string, releaseBindings: boolean) => Promise<void>;
  clearTopic: (topicId: string, requestId: string, releaseBindings: boolean) => Promise<void>;
  /** Which page hosts the switcher: only changes the test hooks (group chat vs Bot page). */
  variant?: "group" | "direct";
}>();
const emit = defineEmits<{ select: [topicId: string]; create: [] }>();

const { editingId, draftTitle, actionError, confirmKind, confirmImpact, releaseBindings, confirming, confirmBlocked,
  statusLabel, startRename, saveRename, archive, restore, openConfirm, closeConfirm, submitConfirm } = useTopicActions(props);

const { t } = useI18n();
const dd = useDropdown();
const query = ref("");
const rowMenu = ref<{ x: number; y: number; topic: TopicSummaryDto } | null>(null);

const active = computed(() => props.topics.find((topic) => topic.id === props.activeTopicId) ?? null);
const direct = computed(() => props.variant === "direct");
const visible = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return props.topics.filter((topic) => {
    if (!needle) return true;
    return topic.title.toLowerCase().includes(needle);
  });
});

function closePanel(): void {
  dd.closeMenu();
  query.value = "";
  rowMenu.value = null;
}

function selectTopic(topic: TopicSummaryDto): void {
  emit("select", topic.id);
  closePanel();
}

// 「新建话题」 lives only at the panel bottom: close the panel and park focus on the
// pill first, so the New Topic dialog restores focus there (the row button is gone).
function createTopic(): void {
  closePanel();
  dd.trigger?.focus();
  emit("create");
}

function openRowMenu(topic: TopicSummaryDto, event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  rowMenu.value = { x: rect.left, y: rect.bottom + 4, topic };
}

const rowMenuItems = computed<ContextMenuItem[]>(() => {
  const topic = rowMenu.value?.topic;
  if (!topic) return [];
  const items: ContextMenuItem[] = [];
  if (topic.status !== "deleting") items.push({ key: "rename", label: t("bot.topic.rename") });
  if (topic.status === "active") items.push({ key: "archive", label: t("bot.topic.archive") });
  if (topic.status === "archived") items.push({ key: "restore", label: t("bot.topic.restore") });
  if (topic.status !== "deleting") {
    items.push(topic.defaultDirect === true
      ? { key: "clear", label: t("bot.topic.clear"), danger: true }
      : { key: "delete", label: t("bot.topic.delete"), danger: true });
  }
  return items;
});

function onRowMenuSelect(key: string): void {
  const topic = rowMenu.value?.topic;
  rowMenu.value = null;
  if (!topic) return;
  if (key === "rename") { startRename(topic); return; }
  if (key === "archive") { void archive(topic); return; }
  if (key === "restore") { void restore(topic); return; }
  if (key === "delete" || key === "clear") void openConfirm(key, topic);
}

// A failed delete/clear keeps the confirm dialog open with its error, so only a closed
// confirm (success or plain cancel) dismisses the panel.
async function submitRowConfirm(): Promise<void> {
  await submitConfirm();
  if (!confirmKind.value) closePanel();
}
</script>

<template>
  <div class="relative min-w-0">
    <button
      type="button"
      :data-test="direct ? 'topic-menu' : 'group-topic-pill'"
      :ref="(el) => (dd.trigger = el as HTMLElement | null)"
      :data-topic-status="active?.status ?? 'active'"
      :aria-haspopup="true"
      :aria-expanded="dd.open"
      class="flex min-w-0 items-center gap-1 rounded-sm px-1 text-left text-xs transition-colors"
      :class="dd.open ? 'bg-surface-2 text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'"
      @click="dd.toggle()"
    >
      <span class="truncate">{{ active?.title || $t("bot.topic.default") }}</span>
      <span v-if="active && statusLabel(active)" data-test="topic-pill-status" class="shrink-0 text-fg-muted">{{ statusLabel(active) }}</span>
      <ChevronDown :size="12" class="shrink-0 transition-transform" :class="dd.open ? 'rotate-180' : ''" />
    </button>

    <!-- One panel (unified §F): popover on desktop, MobileSheet below lg. Rows are
         caller-rendered (status glyph, trailing ⋯, inline rename form). -->
    <DropdownPanel :dd="dd" tone="surface" width="w-80" placement="bottom"
                   :title='$t("mobileBar.switchTopic")' :test-id="'topic-panel'" :sheet-test-id="direct ? 'bot-topic-sheet' : 'group-topic-sheet'"
                   :searchable="topics.length > 7" :nav-count="visible.length"
                   v-model:query="query"
                   @navigate="(i) => selectTopic(visible[i]!)">
      <template #default="{ mobile }">
        <p v-if="!visible.length" class="px-2 py-3 text-sm text-fg-muted">{{ $t("bot.topic.empty") }}</p>
        <div v-for="(topic, i) in visible" :key="topic.id"
             data-test="topic-row" :data-topic-id="topic.id" :data-topic-status="topic.status"
             class="group/row">
          <div class="flex items-center gap-1 rounded-sm px-2 py-1.5 text-sm"
               :class="[mobile ? 'min-h-11' : 'h-8',
                        topic.id === activeTopicId ? 'font-medium text-fg' : 'text-fg',
                        topic.status === 'archived' ? 'text-fg-muted' : '',
                        !mobile && i === dd.highlight ? 'bg-surface-2' : '']">
            <button type="button" class="min-w-0 flex-1 truncate text-left" @click="selectTopic(topic)">
              {{ topic.title || $t("bot.topic.default") }}
            </button>
            <Archive v-if="topic.status === 'archived'" :size="12" class="shrink-0 text-fg-muted" />
            <RotateCcw v-if="topic.status === 'deleting'" :size="12" class="shrink-0 text-fg-muted" />
            <Check v-if="topic.id === activeTopicId" :size="14" class="ml-auto shrink-0 text-accent" />
            <button type="button" data-test="topic-row-more" :aria-label="$t('common.more')"
                    class="shrink-0 rounded-sm p-1 text-fg-muted transition-colors hover:bg-surface-2"
                    :class="[topic.id === activeTopicId ? '' : 'ml-auto',
                             mobile ? '' : 'opacity-0 group-hover/row:opacity-100',
                             i === dd.highlight && !mobile ? 'opacity-100' : '']"
                    @click.stop="openRowMenu(topic, $event)"><MoreHorizontal :size="14" /></button>
          </div>
          <form v-if="editingId === topic.id" class="mt-1 flex gap-1 px-2" @submit.prevent="saveRename(topic)">
            <input v-model="draftTitle" data-test="topic-rename-input" maxlength="200" class="min-w-0 flex-1 rounded-sm bg-surface-2 px-1 py-0.5 text-xs" />
            <button type="submit" data-test="topic-rename-save" class="rounded-sm bg-accent px-2 py-0.5 text-xs text-on-accent">{{ $t("bot.topic.save") }}</button>
          </form>
        </div>
        <p v-if="actionError" data-test="topic-action-error" class="px-2 py-1 text-xs text-danger">{{ actionError }}</p>
        <button type="button" :data-test="direct ? 'new-topic-button' : 'group-new-topic-button'"
                class="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm text-accent transition-colors hover:bg-surface-2"
                :class="mobile ? 'min-h-11' : 'h-8'"
                @click="createTopic"><Plus :size="14" class="shrink-0" /><span>{{ $t("bot.topic.new") }}</span></button>
      </template>
    </DropdownPanel>

    <ContextMenu v-if="rowMenu" :x="rowMenu.x" :y="rowMenu.y" :items="rowMenuItems"
                 @select="onRowMenuSelect" @close="rowMenu = null" />

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
            @click="submitRowConfirm"
          >
            {{ confirmKind === "clear" ? $t("bot.topic.clear") : $t("bot.topic.delete") }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
