<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Archive, ChevronDown, Plus, RotateCcw } from "lucide-vue-next";
import type { TopicImpactDto, TopicSummaryDto } from "@ganglion/xacpx-relay-protocol";

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

const { t } = useI18n();
const open = ref(false);
const query = ref("");
const editingId = ref<string | null>(null);
const draftTitle = ref("");
const pendingId = ref<string | null>(null);
const actionError = ref<string | null>(null);
const confirmKind = ref<"delete" | "clear" | null>(null);
const confirmTopicId = ref<string | null>(null);
const confirmRequestId = ref("");
const confirmImpact = ref<TopicImpactDto | null>(null);
const releaseBindings = ref(false);
const confirming = ref(false);

const active = computed(() => props.topics.find((topic) => topic.id === props.activeTopicId) ?? null);
const confirmBlocked = computed(() => {
  const bindings = confirmImpact.value?.bindings.length ?? 0;
  const worktrees = confirmImpact.value?.worktreeRunIds.length ?? 0;
  return confirming.value || (bindings > 0 && !releaseBindings.value) || worktrees > 0;
});
const visible = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return props.topics.filter((topic) => {
    if (!needle) return true;
    return topic.title.toLowerCase().includes(needle);
  });
});

function statusLabel(topic: TopicSummaryDto): string {
  if (topic.status === "archived") return t("bot.topic.archived");
  if (topic.status === "deleting") return t("bot.topic.deleting");
  return "";
}

async function run(topicId: string, action: () => Promise<void>): Promise<void> {
  pendingId.value = topicId;
  actionError.value = null;
  try {
    await action();
  } catch (error: unknown) {
    actionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    pendingId.value = null;
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
  await run(topic.id, async () => {
    await props.renameTopic(topic.id, title);
    editingId.value = null;
  });
}

async function openConfirm(kind: "delete" | "clear", topic: TopicSummaryDto): Promise<void> {
  confirmKind.value = kind;
  confirmTopicId.value = topic.id;
  confirmRequestId.value = crypto.randomUUID();
  releaseBindings.value = false;
  confirmImpact.value = null;
  actionError.value = null;
  try {
    confirmImpact.value = await props.previewTopic(topic.id);
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
      await props.teardownTopic(topicId, confirmRequestId.value, releaseBindings.value);
    } else {
      await props.clearTopic(topicId, confirmRequestId.value, releaseBindings.value);
    }
    closeConfirm();
    open.value = false;
  } catch (error: unknown) {
    actionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    confirming.value = false;
  }
}
</script>

<template>
  <div class="relative flex min-w-0 flex-1 items-center gap-2">
    <button
      type="button"
      class="flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-fg hover:bg-raised"
      :data-test="variant === 'group' ? 'group-topic-pill' : 'topic-menu'"
      :data-topic-status="active?.status ?? 'active'"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="truncate">{{ active?.title || $t("bot.topic.default") }}</span>
      <span v-if="active && statusLabel(active)" class="shrink-0 text-fg-muted">{{ statusLabel(active) }}</span>
      <ChevronDown :size="12" class="shrink-0 text-fg-muted" />
    </button>
    <button
      type="button"
      class="ml-auto flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10"
      :data-test="variant === 'group' ? 'group-new-topic-button' : 'new-topic-button'"
      @click="emit('create')"
    >
      <Plus :size="13" />
      <span>{{ $t("bot.topic.new") }}</span>
    </button>

    <div
      v-if="open"
      data-test="topic-panel"
      class="z-30 flex flex-col border border-border bg-surface shadow-lg max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:max-h-[70vh] max-md:rounded-t-xl md:absolute md:right-0 md:top-full md:mt-1 md:max-h-96 md:w-80 md:rounded-lg"
    >
      <div class="border-b border-border p-2">
        <input
          v-model="query"
          type="search"
          data-test="topic-search"
          :placeholder="$t('bot.topic.search')"
          class="w-full rounded-md border border-border bg-bg px-2 py-1 text-xs outline-none focus:border-accent"
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
          class="rounded-md px-2 py-1.5 text-xs"
          :class="topic.id === activeTopicId ? 'bg-accent/10' : ''"
        >
          <div class="flex items-center gap-1">
            <button type="button" class="min-w-0 flex-1 truncate text-left" @click="emit('select', topic.id); open = false">
              {{ topic.title || $t("bot.topic.default") }}
            </button>
            <Archive v-if="topic.status === 'archived'" :size="12" class="shrink-0 text-fg-muted" />
            <RotateCcw v-if="topic.status === 'deleting'" :size="12" class="shrink-0 text-fg-muted" />
          </div>
          <form v-if="editingId === topic.id" class="mt-1 flex gap-1" @submit.prevent="saveRename(topic)">
            <input v-model="draftTitle" data-test="topic-rename-input" maxlength="200" class="min-w-0 flex-1 rounded border border-border bg-bg px-1 py-0.5" />
            <button type="submit" data-test="topic-rename-save" class="rounded bg-accent px-2 py-0.5 text-accent-fg">{{ $t("bot.topic.save") }}</button>
          </form>
          <div v-else class="mt-1 flex flex-wrap gap-1">
            <button v-if="topic.status !== 'deleting'" type="button" data-test="topic-rename" class="rounded px-1.5 py-0.5 text-fg-muted hover:bg-raised" :disabled="pendingId === topic.id" @click="startRename(topic)">{{ $t("bot.topic.rename") }}</button>
            <button v-if="topic.status === 'active'" type="button" data-test="topic-archive" class="rounded px-1.5 py-0.5 text-fg-muted hover:bg-raised" :disabled="pendingId === topic.id" @click="run(topic.id, () => archiveTopic(topic.id))">{{ $t("bot.topic.archive") }}</button>
            <button v-if="topic.status === 'archived'" type="button" data-test="topic-restore" class="rounded px-1.5 py-0.5 text-fg-muted hover:bg-raised" :disabled="pendingId === topic.id" @click="run(topic.id, () => restoreTopic(topic.id))">{{ $t("bot.topic.restore") }}</button>
            <button v-if="topic.defaultDirect === true && topic.status !== 'deleting'" type="button" data-test="topic-clear" class="rounded px-1.5 py-0.5 text-danger hover:bg-danger/10" :disabled="pendingId === topic.id" @click="openConfirm('clear', topic)">{{ $t("bot.topic.clear") }}</button>
            <button v-if="topic.defaultDirect !== true && topic.status !== 'deleting'" type="button" data-test="topic-delete" class="rounded px-1.5 py-0.5 text-danger hover:bg-danger/10" :disabled="pendingId === topic.id" @click="openConfirm('delete', topic)">{{ $t("bot.topic.delete") }}</button>
          </div>
        </li>
      </ul>
      <p v-if="actionError" data-test="topic-action-error" class="border-t border-danger/20 px-2 py-1 text-xs text-danger">{{ actionError }}</p>
    </div>

    <div v-if="confirmKind" class="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-4 md:items-center" @click.self="closeConfirm">
      <div role="dialog" aria-modal="true" data-test="topic-confirm" class="w-full max-w-sm rounded-xl border border-border bg-surface p-4 shadow-xl">
        <h3 class="text-sm font-semibold">{{ confirmKind === "clear" ? $t("bot.topic.confirmClearTitle") : $t("bot.topic.confirmDeleteTitle") }}</h3>
        <p class="mt-2 text-xs text-fg-muted">{{ confirmKind === "clear" ? $t("bot.topic.confirmClearBody") : $t("bot.topic.confirmDeleteBody") }}</p>
        <p v-if="(confirmImpact?.worktreeRunIds.length ?? 0) > 0" data-test="topic-worktree-warning" class="mt-2 text-xs text-danger">{{ $t("bot.topic.worktreeWarning") }}</p>
        <label v-if="(confirmImpact?.bindings.length ?? 0) > 0" class="mt-3 flex items-start gap-2 text-xs">
          <input v-model="releaseBindings" data-test="topic-release-bindings" type="checkbox" class="mt-0.5" />
          <span>{{ $t("bot.topic.confirmUnbind") }}</span>
        </label>
        <p v-if="actionError" class="mt-2 text-xs text-danger">{{ actionError }}</p>
        <div class="mt-4 flex justify-end gap-2">
          <button type="button" class="rounded-lg border border-border px-3 py-1.5 text-xs" @click="closeConfirm">{{ $t("common.cancel") }}</button>
          <button
            type="button"
            data-test="topic-confirm-submit"
            class="rounded-lg bg-danger px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            :disabled="confirmBlocked"
            @click="submitConfirm"
          >
            {{ confirmKind === "clear" ? $t("bot.topic.clear") : $t("bot.topic.delete") }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
