<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Bot, MessagesSquare, Plus, Search, X } from "lucide-vue-next";
import {
  SPLIT_MAX_COLUMNS,
  SPLIT_MIN_WIDTH_PX,
  paneKeyFor,
  primaryKeyFor,
  useSplitLayoutStore,
  type SplitColumn,
  type SplitLayoutState,
  type SplitPaneTarget,
} from "../stores/split-layout";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useInstancesStore } from "../stores/instances";
import { pushToast } from "../lib/use-toasts";
import ChatPane from "./ChatPane.vue";
import DirectBotPane from "./DirectBotPane.vue";

const props = defineProps<{ primary: SplitPaneTarget }>();
const emit = defineEmits<{ promote: [target: SplitPaneTarget] }>();

const { t } = useI18n();
const splitLayout = useSplitLayoutStore();
const instances = useInstancesStore();
const directBots = useDirectBotsStore();

const MIN_WIDTH_PX = SPLIT_MIN_WIDTH_PX;
const MAX_COLUMNS = SPLIT_MAX_COLUMNS;

const primaryKey = computed(() => primaryKeyFor(props.primary));
// Prime the layout for this primary (creates + persists on first access). The
// reactive read below then tracks column edits without side effects in render.
watch(primaryKey, (key) => { splitLayout.ensureLayout(key); }, { immediate: true });
const layout = computed<SplitLayoutState>(() => splitLayout.layoutsByPrimary[primaryKey.value] ?? {
  columns: [],
  focusedColumnId: "",
  dismissedSessionKeys: [],
});
const columns = computed<SplitColumn[]>(() => layout.value.columns);

function targetName(target: SplitPaneTarget): string {
  if (target.kind === "session") {
    return instances.findSessionRow(target.instanceId, target.sessionAlias)?.displayName
      || target.sessionAlias;
  }
  return (directBots.botsByInstance[target.instanceId] ?? []).find((b) => b.id === target.botId)?.name
    || target.botId;
}
function targetSub(target: SplitPaneTarget): string {
  const instanceName = instances.byId(target.instanceId)?.name ?? target.instanceId;
  if (target.kind === "session") {
    const agent = instances.findSessionRow(target.instanceId, target.sessionAlias)?.agent;
    return agent ? `${instanceName} · ${agent}` : instanceName;
  }
  return instanceName;
}

function focusColumn(columnId: string): void {
  splitLayout.focusColumn(primaryKey.value, columnId);
}
function closeColumn(column: SplitColumn): void {
  splitLayout.removeColumn(
    primaryKey.value,
    column.id,
    column.target.kind === "session" ? { dismiss: true } : undefined,
  );
}
function promoteColumn(column: SplitColumn): void {
  splitLayout.promoteToPrimary(primaryKey.value, column.id);
  emit("promote", column.target);
}

// --- column dividers: Pointer Events drag, dblclick equalizes ----------------
// Deltas are incremental (last-pointer vs current) over the container width, so a
// slow drag and a fast fling converge on the same fractions.
const containerRef = ref<HTMLElement | null>(null);
const dragState = ref<{ leftIndex: number; lastX: number; width: number; pointerId: number } | null>(null);
function onDividerPointerDown(event: PointerEvent, leftIndex: number): void {
  const width = containerRef.value?.getBoundingClientRect().width ?? 0;
  if (width <= 0) return;
  dragState.value = { leftIndex, lastX: event.clientX, width, pointerId: event.pointerId };
  (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
}
function onDividerPointerMove(event: PointerEvent, leftIndex: number): void {
  const drag = dragState.value;
  if (!drag || drag.pointerId !== event.pointerId || drag.leftIndex !== leftIndex) return;
  const dx = event.clientX - drag.lastX;
  drag.lastX = event.clientX;
  if (dx !== 0) splitLayout.resizeAdjacentColumns(primaryKey.value, drag.leftIndex, dx / drag.width);
}
function onDividerPointerUp(event: PointerEvent): void {
  if (dragState.value && dragState.value.pointerId === event.pointerId) dragState.value = null;
}
function onDividerDblClick(): void {
  splitLayout.equalizeColumns(primaryKey.value);
}

// --- + 分栏 picker ------------------------------------------------------------
const pickerOpen = ref(false);
const pickerQuery = ref("");

interface PickItem {
  key: string;
  kind: "session" | "bot";
  target: SplitPaneTarget;
  label: string;
  sub: string;
}

const pickItems = computed<PickItem[]>(() => {
  const query = pickerQuery.value.trim().toLowerCase();
  const taken = new Set(columns.value.map((column) => paneKeyFor(column.target)));
  const items: PickItem[] = [];
  for (const instance of instances.instances) {
    if (!instance.online) continue;
    for (const session of instance.sessions ?? []) {
      const target: SplitPaneTarget = { kind: "session", instanceId: instance.id, sessionAlias: session.alias };
      if (taken.has(paneKeyFor(target))) continue;
      const label = session.displayName || session.alias;
      if (query && !`${label} ${session.alias} ${session.agent} ${instance.name}`.toLowerCase().includes(query)) continue;
      items.push({
        key: `session:${instance.id}:${session.alias}`,
        kind: "session",
        target,
        label,
        sub: `${instance.name} · ${session.agent}`,
      });
    }
    for (const bot of directBots.botsByInstance[instance.id] ?? []) {
      if (!bot.enabled || bot.retired) continue;
      const target: SplitPaneTarget = { kind: "bot", instanceId: instance.id, botId: bot.id };
      if (taken.has(paneKeyFor(target))) continue;
      if (query && !`${bot.name} ${instance.name}`.toLowerCase().includes(query)) continue;
      items.push({ key: `bot:${instance.id}:${bot.id}`, kind: "bot", target, label: bot.name, sub: instance.name });
    }
  }
  return items;
});

function openPicker(): void {
  pickerOpen.value = true;
  pickerQuery.value = "";
  // Bots load lazily per instance; fetch whatever the picker may list.
  for (const instance of instances.instances) {
    if (!instance.online || directBots.botsLoaded[instance.id]) continue;
    void directBots.loadBots(instance.id).catch(() => {});
  }
}
function pick(item: PickItem): void {
  const added = splitLayout.addColumn(primaryKey.value, item.target, "manual");
  if (!added) {
    pushToast("info", columns.value.length >= MAX_COLUMNS ? "split.maxReached" : "split.alreadyOpen");
    return;
  }
  pickerOpen.value = false;
}

// --- prune columns whose session/Bot vanished server-side ---------------------
// Only once every involved instance finished loading its lists: a paginated fetch
// that has not reached a row yet must never drop its column.
const listsSignature = computed(() => {
  const ids = new Set<string>([props.primary.instanceId]);
  for (const column of columns.value) ids.add(column.target.instanceId);
  return [...ids]
    .map((id) => {
      const instance = instances.byId(id);
      return `${id}:${instance?.sessionsLoaded ? 1 : 0}:${directBots.botsLoaded[id] ? 1 : 0}`;
    })
    .join("|");
});
watch(listsSignature, () => {
  if (columns.value.length === 0) return;
  const ids = new Set<string>([props.primary.instanceId]);
  for (const column of columns.value) ids.add(column.target.instanceId);
  const ready = [...ids].every((id) => instances.byId(id)?.sessionsLoaded && directBots.botsLoaded[id]);
  if (!ready) return;
  splitLayout.pruneMissingTargets(
    primaryKey.value,
    (target) => target.kind === "session"
      ? !!instances.findSessionRow(target.instanceId, target.sessionAlias)
      : (directBots.botsByInstance[target.instanceId] ?? []).some((b) => b.id === target.botId && !b.retired),
    true,
  );
});
</script>

<template>
  <div ref="containerRef" data-test="split-workbench" class="flex h-full min-h-0 overflow-x-auto">
    <template v-for="(column, index) in columns" :key="column.id">
      <!-- Draggable divider between columns (Pointer Events; dblclick equalizes). -->
      <div v-if="index > 0" data-test="split-divider"
           class="w-1 shrink-0 cursor-col-resize touch-none select-none self-stretch transition-colors hover:bg-accent/30"
           @pointerdown="onDividerPointerDown($event, index - 1)"
           @pointermove="onDividerPointerMove($event, index - 1)"
           @pointerup="onDividerPointerUp"
           @pointercancel="onDividerPointerUp"
           @dblclick="onDividerDblClick" />
      <section data-test="split-column" :data-column-id="column.id"
               class="flex min-h-0 min-w-0 flex-col"
               :style="{ flex: `${column.widthFraction} 1 0%`, minWidth: `${MIN_WIDTH_PX}px` }"
               :class="column.id === layout.focusedColumnId ? 'ring-1 ring-inset ring-accent' : ''"
               @pointerdown="focusColumn(column.id)">
        <header data-test="split-column-header"
                class="flex h-9 shrink-0 items-center gap-1.5 border-b border-hairline px-2">
          <MessagesSquare v-if="column.target.kind === 'session'" :size="13" class="shrink-0 text-fg-muted" aria-hidden="true" />
          <Bot v-else :size="13" class="shrink-0 text-fg-muted" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate text-xs font-semibold text-fg"
                :title="targetSub(column.target)">{{ targetName(column.target) }}</span>
          <span v-if="index === 0" class="flex shrink-0 items-center gap-0.5">
            <slot name="actions" />
          </span>
          <span v-if="index > 0" class="flex shrink-0 items-center gap-1">
            <button type="button" data-test="split-promote"
                    class="rounded-md px-1.5 py-0.5 text-xs font-medium text-fg-muted transition-colors hover:bg-fill-hover hover:text-fg"
                    :title="t('split.setPrimary')"
                    @click.stop="promoteColumn(column)">{{ t("split.setPrimary") }}</button>
            <button type="button" data-test="split-close"
                    class="grid h-6 w-6 place-items-center rounded-md text-fg-muted transition-colors hover:bg-fill-hover hover:text-fg"
                    :title="t('split.closePane')" :aria-label="t('split.closePane')"
                    @click.stop="closeColumn(column)"><X :size="13" /></button>
          </span>
        </header>
        <div class="min-h-0 flex-1">
          <ChatPane v-if="column.target.kind === 'session'"
                    :instance-id="column.target.instanceId"
                    :session-alias="column.target.sessionAlias"
                    pane-mode="split" />
          <DirectBotPane v-else
                         :instance-id="column.target.instanceId"
                         :bot-id="column.target.botId"
                         :topic-id="column.target.topicId"
                         pane-mode="split" />
        </div>
      </section>
    </template>
    <div class="relative flex w-10 shrink-0 items-start justify-center pt-1">
      <button type="button" data-test="split-add"
              class="rounded-md px-1.5 py-1 text-xs font-medium text-fg-muted transition-colors hover:bg-fill-hover hover:text-fg"
              :title="t('split.addSplit')"
              @click="pickerOpen ? (pickerOpen = false) : openPicker()">{{ t("split.addSplit") }}</button>
      <div v-if="pickerOpen" data-test="split-picker"
           class="absolute right-0 top-10 z-40 max-h-80 w-72 overflow-y-auto thin-scroll rounded-lg border border-hairline bg-raised p-1.5 shadow-float">
        <div class="flex items-center gap-1.5 rounded-md border border-hairline bg-bg/50 px-2 py-1">
          <Search :size="12" class="shrink-0 text-fg-muted" aria-hidden="true" />
          <input data-test="split-picker-search" v-model="pickerQuery" type="text"
                 class="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-fg-muted"
                 :placeholder="t('split.searchPlaceholder')" />
        </div>
        <p class="px-2 pb-0.5 pt-2 text-xs font-medium text-fg-muted">{{ t("split.sessions") }}</p>
        <button v-for="item in pickItems.filter((i) => i.kind === 'session')" :key="item.key" type="button"
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
        <button v-for="item in pickItems.filter((i) => i.kind === 'bot')" :key="item.key" type="button"
                data-test="split-pick-bot"
                class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-fill-hover"
                @click="pick(item)">
          <Bot :size="13" class="shrink-0 text-fg-muted" aria-hidden="true" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-xs font-medium text-fg">{{ item.label }}</span>
            <span class="block truncate text-xs text-fg-muted">{{ item.sub }}</span>
          </span>
        </button>
        <p v-if="pickItems.length === 0" data-test="split-picker-empty"
           class="px-2 py-2 text-xs text-fg-muted">{{ t("split.empty") }}</p>
      </div>
    </div>
  </div>
</template>
