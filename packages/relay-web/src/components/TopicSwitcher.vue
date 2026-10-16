<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Archive, ChevronDown, MoreHorizontal, Plus, RotateCcw } from "lucide-vue-next";
import type { TopicImpactDto, TopicSummaryDto } from "@ganglion/xacpx-relay-protocol";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu.vue";
import MobileSheet from "./MobileSheet.vue";
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
}>();
const emit = defineEmits<{ select: [topicId: string]; create: [] }>();

// pendingId stays inside the composable: the switcher's actions live in a row menu, not
// in inline per-row buttons, so nothing renders a pending state.
const { editingId, draftTitle, actionError, confirmKind, confirmImpact, releaseBindings, confirming, confirmBlocked,
  startRename, saveRename, archive, restore, openConfirm, closeConfirm, submitConfirm } = useTopicActions(props);

const { t } = useI18n();
const open = ref(false);
const query = ref("");
const rowMenu = ref<{ x: number; y: number; topic: TopicSummaryDto } | null>(null);
// The pill renders a bottom sheet below lg and an anchored popover above it. The two trees
// differ structurally (not just in CSS), so the breakpoint has to be a JS flag rather than
// a media query; keep it in sync with the Tailwind `lg` breakpoint.
const isMobile = ref(typeof window !== "undefined" && window.innerWidth < 1024);
function onResize(): void { isMobile.value = window.innerWidth < 1024; }
onMounted(() => window.addEventListener("resize", onResize));
onBeforeUnmount(() => window.removeEventListener("resize", onResize));

const active = computed(() => props.topics.find((topic) => topic.id === props.activeTopicId) ?? null);
const visible = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return props.topics.filter((topic) => {
    if (!needle) return true;
    return topic.title.toLowerCase().includes(needle);
  });
});

function closePanel(): void {
  open.value = false;
  query.value = "";
  rowMenu.value = null;
}

function selectTopic(topic: TopicSummaryDto): void {
  emit("select", topic.id);
  closePanel();
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
      data-test="group-topic-pill"
      :data-topic-status="active?.status ?? 'active'"
      :aria-expanded="open"
      class="flex min-w-0 items-center gap-1 rounded-sm px-1 text-left text-xs text-fg-muted transition-colors hover:bg-surface-2 active:bg-surface-2"
      @click="open = !open"
    >
      <span class="truncate">{{ active?.title || $t("bot.topic.default") }}</span>
      <ChevronDown :size="12" class="shrink-0" />
    </button>

    <MobileSheet v-if="open && isMobile" :title='$t("mobileBar.switchTopic")' test-id="group-topic-sheet" @close="closePanel">
      <div class="p-2">
        <input
          v-model="query"
          type="search"
          data-test="topic-search"
          :placeholder="$t('bot.topic.search')"
          class="w-full rounded-sm bg-surface-2 px-2 py-1 text-xs outline-none"
        />
      </div>
      <ul class="p-1">
        <li v-if="visible.length === 0" class="px-2 py-3 text-xs text-fg-muted">{{ $t("bot.topic.empty") }}</li>
        <li
          v-for="topic in visible"
          :key="topic.id"
          data-test="topic-row"
          :data-topic-id="topic.id"
          :data-topic-status="topic.status"
          class="min-h-12 rounded-sm px-2 py-1.5 text-sm"
          :class="[topic.id === activeTopicId ? 'bg-accent/10' : '', topic.status === 'archived' ? 'text-fg-muted' : '']"
        >
          <div class="flex items-center gap-1">
            <button type="button" class="min-w-0 flex-1 truncate text-left" @click="selectTopic(topic)">
              {{ topic.title || $t("bot.topic.default") }}
            </button>
            <Archive v-if="topic.status === 'archived'" :size="12" class="shrink-0 text-fg-muted" />
            <RotateCcw v-if="topic.status === 'deleting'" :size="12" class="shrink-0 text-fg-muted" />
            <button type="button" data-test="topic-row-more" :aria-label="$t('common.more')"
                    class="shrink-0 rounded-sm p-1 text-fg-muted transition-colors hover:bg-surface-2"
                    @click.stop="openRowMenu(topic, $event)"><MoreHorizontal :size="14" /></button>
          </div>
          <form v-if="editingId === topic.id" class="mt-1 flex gap-1" @submit.prevent="saveRename(topic)">
            <input v-model="draftTitle" data-test="topic-rename-input" maxlength="200" class="min-w-0 flex-1 rounded-sm bg-surface-2 px-1 py-0.5 text-xs" />
            <button type="submit" data-test="topic-rename-save" class="rounded-sm bg-accent px-2 py-0.5 text-xs text-on-accent">{{ $t("bot.topic.save") }}</button>
          </form>
        </li>
      </ul>
      <p v-if="actionError" data-test="topic-action-error" class="px-2 py-1 text-xs text-danger">{{ actionError }}</p>
      <button type="button" data-test="group-new-topic-button"
              class="flex min-h-12 items-center gap-2 rounded-sm px-2 py-2 text-left text-sm text-accent transition-colors hover:bg-surface-2"
              @click="emit('create'); closePanel()"><Plus :size="14" class="shrink-0" /><span>{{ $t("bot.topic.new") }}</span></button>
    </MobileSheet>

    <div v-else-if="open" data-test="topic-panel"
         class="absolute left-0 top-full z-30 mt-1 flex max-h-96 w-80 flex-col rounded-lg bg-surface p-1 shadow-float">
      <div class="p-2">
        <input
          v-model="query"
          type="search"
          data-test="topic-search"
          :placeholder="$t('bot.topic.search')"
          class="w-full rounded-sm bg-surface-2 px-2 py-1 text-xs outline-none"
        />
      </div>
      <ul class="min-h-0 flex-1 overflow-y-auto p-1">
        <li v-if="visible.length === 0" class="px-2 py-3 text-xs text-fg-muted">{{ $t("bot.topic.empty") }}</li>
        <li
          v-for="topic in visible"
          :key="topic.id"
          data-test="topic-row"
          :data-topic-id="topic.id"
          :data-topic-status="topic.status"
          class="rounded-sm px-2 py-1.5 text-sm"
          :class="[topic.id === activeTopicId ? 'bg-accent/10' : '', topic.status === 'archived' ? 'text-fg-muted' : '']"
        >
          <div class="flex items-center gap-1">
            <button type="button" class="min-w-0 flex-1 truncate text-left" @click="selectTopic(topic)">
              {{ topic.title || $t("bot.topic.default") }}
            </button>
            <Archive v-if="topic.status === 'archived'" :size="12" class="shrink-0 text-fg-muted" />
            <RotateCcw v-if="topic.status === 'deleting'" :size="12" class="shrink-0 text-fg-muted" />
            <button type="button" data-test="topic-row-more" :aria-label="$t('common.more')"
                    class="shrink-0 rounded-sm p-1 text-fg-muted transition-colors hover:bg-surface-2"
                    @click.stop="openRowMenu(topic, $event)"><MoreHorizontal :size="14" /></button>
          </div>
          <form v-if="editingId === topic.id" class="mt-1 flex gap-1" @submit.prevent="saveRename(topic)">
            <input v-model="draftTitle" data-test="topic-rename-input" maxlength="200" class="min-w-0 flex-1 rounded-sm bg-surface-2 px-1 py-0.5 text-xs" />
            <button type="submit" data-test="topic-rename-save" class="rounded-sm bg-accent px-2 py-0.5 text-xs text-on-accent">{{ $t("bot.topic.save") }}</button>
          </form>
        </li>
      </ul>
      <p v-if="actionError" data-test="topic-action-error" class="px-2 py-1 text-xs text-danger">{{ actionError }}</p>
      <button type="button" data-test="group-new-topic-button"
              class="flex items-center gap-2 rounded-sm px-2 py-2 text-left text-sm text-accent transition-colors hover:bg-surface-2"
              @click="emit('create'); closePanel()"><Plus :size="14" class="shrink-0" /><span>{{ $t("bot.topic.new") }}</span></button>
    </div>

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
