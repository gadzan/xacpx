<script setup lang="ts">
import { computed, provide, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Bot, MessagesSquare, X } from "lucide-vue-next";
import {
  SPLIT_MAX_COLUMNS,
  SPLIT_MIN_WIDTH_PX,
  paneKeyFor,
  primaryKeyFor,
  splitPrimaryKey,
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
import SplitAddButton, { type SplitPickItem } from "./SplitAddButton.vue";

const props = defineProps<{ primary: SplitPaneTarget }>();
const emit = defineEmits<{
  promote: [target: SplitPaneTarget];
  showFiles: [];
  navigateBot: [instanceId: string, botId: string];
  navigateGroup: [instanceId: string, groupId: string];
  back: [];
}>();

const { t } = useI18n();
const splitLayout = useSplitLayoutStore();
const instances = useInstancesStore();
const directBots = useDirectBotsStore();

const MIN_WIDTH_PX = SPLIT_MIN_WIDTH_PX;
const MAX_COLUMNS = SPLIT_MAX_COLUMNS;

const primaryKey = computed(() => primaryKeyFor(props.primary));
// Columns open dispatched sessions under the layout that hosts them (consumed
// via inject by DirectBotPane + DispatchedSessionCard).
provide(splitPrimaryKey, primaryKey);
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

// --- + 分栏 picker ---------------------------------------------------------------
// The button owns its open/query state (see SplitAddButton); the workbench only
// supplies the not-yet-open targets and performs the pick.
interface PickItem extends SplitPickItem {}

const pickItems = computed<PickItem[]>(() => {
  const taken = new Set(columns.value.map((column) => paneKeyFor(column.target)));
  const items: PickItem[] = [];
  for (const instance of instances.instances) {
    if (!instance.online) continue;
    for (const session of instance.sessions ?? []) {
      const target: SplitPaneTarget = { kind: "session", instanceId: instance.id, sessionAlias: session.alias };
      if (taken.has(paneKeyFor(target))) continue;
      const label = session.displayName || session.alias;
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
      items.push({ key: `bot:${instance.id}:${bot.id}`, kind: "bot", target, label: bot.name, sub: instance.name });
    }
  }
  return items;
});

function onPickerOpened(): void {
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
  }
}

// --- prune columns whose session/Bot vanished server-side ---------------------
// Only once every involved instance finished loading its lists: a paginated fetch
// that has not reached a row yet must never drop its column.
// Prune columns whose session/Bot vanished server-side. A session list is only
// authoritative once fully loaded (`sessionsLoaded && !sessionsHasMore`): a
// paginated fetch that has not reached a row yet must never drop its column.
const listsSignature = computed(() => {
  const ids = new Set<string>([props.primary.instanceId]);
  for (const column of columns.value) ids.add(column.target.instanceId);
  return [...ids]
    .map((id) => {
      const instance = instances.byId(id);
      return `${id}:${instance?.sessionsLoaded ? 1 : 0}:${instance?.sessionsHasMore ? 1 : 0}:${directBots.botsLoaded[id] ? 1 : 0}`;
    })
    .join("|");
});
watch(listsSignature, () => {
  if (columns.value.length === 0) return;
  const ids = new Set<string>([props.primary.instanceId]);
  for (const column of columns.value) ids.add(column.target.instanceId);
  const ready = [...ids].every((id) => {
    const instance = instances.byId(id);
    return !!instance?.sessionsLoaded && !instance.sessionsHasMore && !!directBots.botsLoaded[id];
  });
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
        <!-- Unsplit: no redundant headers/rail — the pane owns its chrome and the
             + button docks into its #actions slot next to ConversationActions. -->
        <header v-if="columns.length > 1" data-test="split-column-header"
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
          <!-- Split mode: the + button docks into the LAST column header
               (no standalone rail) while columns stay below the cap. -->
          <span v-if="index === columns.length - 1 && columns.length < MAX_COLUMNS"
                class="flex shrink-0 items-center">
            <SplitAddButton :items="pickItems" @opened="onPickerOpened" @pick="pick" />
          </span>
        </header>
        <div class="min-h-0 flex-1">
          <ChatPane v-if="column.target.kind === 'session'"
                    :instance-id="column.target.instanceId"
                    :session-alias="column.target.sessionAlias"
                    pane-mode="split"
                    @show-files="emit('showFiles')">
            <template #actions>
              <slot v-if="columns.length === 1" name="actions" />
              <SplitAddButton v-if="columns.length === 1" :items="pickItems" @opened="onPickerOpened" @pick="pick" />
            </template>
          </ChatPane>
          <DirectBotPane v-else
                         :instance-id="column.target.instanceId"
                         :bot-id="column.target.botId"
                         :topic-id="column.target.topicId"
                         pane-mode="split"
                         @navigate-bot="(instanceId, botId) => emit('navigateBot', instanceId, botId)"
                         @navigate-group="(instanceId, groupId) => emit('navigateGroup', instanceId, groupId)"
                         @back="emit('back')">
            <template #actions>
              <slot v-if="columns.length === 1" name="actions" />
              <SplitAddButton v-if="columns.length === 1" :items="pickItems" @opened="onPickerOpened" @pick="pick" />
            </template>
          </DirectBotPane>
        </div>
      </section>
    </template>
  </div>
</template>
