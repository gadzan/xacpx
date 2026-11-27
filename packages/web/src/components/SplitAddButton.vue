<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Bot, MessagesSquare, Search } from "lucide-vue-next";
import type { SplitPaneTarget } from "../stores/split-layout";

export interface SplitPickItem {
  key: string;
  kind: "session" | "bot";
  target: SplitPaneTarget;
  label: string;
  sub: string;
}

const props = defineProps<{ items: SplitPickItem[] }>();
const emit = defineEmits<{
  pick: [item: SplitPickItem];
  /** The picker was opened: the host lazy-loads whatever the list may show. */
  opened: [];
}>();

const { t } = useI18n();
const open = ref(false);
const query = ref("");

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.items;
  return props.items.filter((item) =>
    `${item.label} ${item.sub}`.toLowerCase().includes(q),
  );
});

function toggle(): void {
  open.value = !open.value;
  if (open.value) {
    query.value = "";
    emit("opened");
  }
}
function pick(item: SplitPickItem): void {
  open.value = false;
  emit("pick", item);
}
</script>

<template>
  <span class="relative inline-flex shrink-0 items-center">
    <button type="button" data-test="split-add"
            class="rounded-md px-1.5 py-0.5 text-xs font-medium text-fg-muted transition-colors hover:bg-fill-hover hover:text-fg"
            :title="t('split.addSplit')"
            @click="toggle">{{ t("split.addSplit") }}</button>
    <div v-if="open" data-test="split-picker"
         class="absolute right-0 top-full z-40 mt-1 max-h-80 w-72 overflow-y-auto thin-scroll rounded-lg border border-hairline bg-raised p-1.5 shadow-float">
      <div class="flex items-center gap-1.5 rounded-md border border-hairline bg-bg/50 px-2 py-1">
        <Search :size="12" class="shrink-0 text-fg-muted" aria-hidden="true" />
        <input data-test="split-picker-search" v-model="query" type="text"
               class="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-fg-muted"
               :placeholder="t('split.searchPlaceholder')" />
      </div>
      <p class="px-2 pb-0.5 pt-2 text-xs font-medium text-fg-muted">{{ t("split.sessions") }}</p>
      <button v-for="item in filtered.filter((i) => i.kind === 'session')" :key="item.key" type="button"
              data-test="split-pick-session"
              class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-fill-hover"
              @click="pick(item)">
        <MessagesSquare :size="13" class="shrink-0 text-fg-muted" aria-hidden="true" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-xs font-medium text-fg">{{ item.label }}</span>
          <span class="block truncate text-xs text-fg-muted">{{ item.sub }}</span>
        </span>
      </button>
      <p class="px-2 pb-0.5 pt-2 text-xs font-medium text-fg-muted">{{ t("split.bots") }}</p>
      <button v-for="item in filtered.filter((i) => i.kind === 'bot')" :key="item.key" type="button"
              data-test="split-pick-bot"
              class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-fill-hover"
              @click="pick(item)">
        <Bot :size="13" class="shrink-0 text-fg-muted" aria-hidden="true" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-xs font-medium text-fg">{{ item.label }}</span>
          <span class="block truncate text-xs text-fg-muted">{{ item.sub }}</span>
        </span>
      </button>
      <p v-if="filtered.length === 0" data-test="split-picker-empty"
         class="px-2 py-2 text-xs text-fg-muted">{{ t("split.empty") }}</p>
    </div>
  </span>
</template>
