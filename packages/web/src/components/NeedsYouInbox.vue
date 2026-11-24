<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { X } from "lucide-vue-next";
import type { InteractionValueDto } from "@ganglion/xacpx-relay-protocol";
import { useDirectBotsStore, type PendingInteractionState } from "../stores/direct-bots";
import { useGroupsStore } from "../stores/groups";
import { useInstancesStore } from "../stores/instances";
import { useIsMobile } from "../lib/use-dropdown";
import MobileSheet from "./MobileSheet.vue";
import ConversationInteractionForm from "./ConversationInteractionForm.vue";

// Cross-instance "Needs you" inbox (UX1): one account-wide list over the
// existing open-interaction set. Reads only — the store owns the map, so an
// answer submitted here updates the same state the destination pane renders,
// and the existing close / snapshot / expiry paths retire the row everywhere.
const emit = defineEmits<{
  close: [];
  "open-session": [instanceId: string, alias: string];
  "open-bot": [instanceId: string, botId: string, conversationId: string, topicId: string | null];
  "open-group": [instanceId: string, groupId: string, conversationId: string, topicId: string | null];
}>();

export type NeedsYouDestination =
  | { kind: "session"; instanceId: string; alias: string }
  | { kind: "direct"; instanceId: string; botId: string; conversationId: string; topicId: string | null }
  | { kind: "group"; instanceId: string; groupId: string; conversationId: string; topicId: string | null }
  | { kind: "none"; instanceId: string };

const { t } = useI18n();
const directBots = useDirectBotsStore();
const groupsStore = useGroupsStore();
const instances = useInstancesStore();
const isMobile = useIsMobile();

const panel = ref<HTMLElement | null>(null);
const entries = computed(() => directBots.openInteractions);

/** The entry whose form is shown. Defaults to the oldest deadline; survives
 *  re-sorts while its request is still open, falls back when it closes. */
const selectedId = ref<string | null>(null);
const selectedEntry = computed<PendingInteractionState | null>(() => {
  const open = entries.value;
  return open.find((entry) => entry.request.requestId === selectedId.value) ?? open[0] ?? null;
});

/** The Direct Bot an entry belongs to. The correlation carries `botId` when
 *  the opener had it; otherwise the cached Direct conversation row names it
 *  (`ConversationSummaryDto.botId`). Null when neither proves it — the entry
 *  stays answerable in place rather than guessing a destination. */
function directBotId(state: PendingInteractionState): string | null {
  const conv = state.request.conversation;
  if (!conv) return null;
  if (conv.botId) return conv.botId;
  return directBots.conversationsByInstance[state.instanceId]?.find((c) => c.id === conv.conversationId)?.botId ?? null;
}

/** Resolve where an entry opens. The entry's own instanceId always wins:
 *  aliases and conversation ids are only unique per daemon, so a session on
 *  instance B must never open because instance A reuses the alias. A group
 *  owns its conversation id (selectGroup keys the conversation by group id),
 *  so a conversation that names a group on this instance is a group entry; a
 *  bot correlation is a direct entry. Anything else stays answerable here. */
function destinationFor(state: PendingInteractionState): NeedsYouDestination {
  const conv = state.request.conversation;
  if (!conv) {
    if (state.sessionAlias) return { kind: "session", instanceId: state.instanceId, alias: state.sessionAlias };
    return { kind: "none", instanceId: state.instanceId };
  }
  const knownGroups = groupsStore.groupsByInstance[state.instanceId] ?? [];
  const group = knownGroups.find((g) => g.id === conv.conversationId)
    ?? groupsStore.groupDetails[`${state.instanceId}:${conv.conversationId}`];
  if (group) {
    return {
      kind: "group", instanceId: state.instanceId, groupId: conv.conversationId,
      conversationId: conv.conversationId, topicId: conv.topicId ?? null,
    };
  }
  const botId = directBotId(state);
  if (botId) {
    return {
      kind: "direct", instanceId: state.instanceId, botId,
      conversationId: conv.conversationId, topicId: conv.topicId ?? null,
    };
  }
  return { kind: "none", instanceId: state.instanceId };
}

function instanceName(instanceId: string): string {
  return instances.byId(instanceId)?.name ?? instanceId;
}

function botName(instanceId: string, botId: string): string {
  return directBots.botsByInstance[instanceId]?.find((b) => b.id === botId)?.name ?? botId;
}

function groupName(instanceId: string, groupId: string): string {
  const fromList = groupsStore.groupsByInstance[instanceId]?.find((g) => g.id === groupId);
  const detail = groupsStore.groupDetails[`${instanceId}:${groupId}`];
  const title = fromList?.title ?? (detail as { title?: string } | undefined)?.title;
  return title || groupId;
}

function destinationLabel(state: PendingInteractionState): string {
  const dest = destinationFor(state);
  if (dest.kind === "session") return t("needsYou.session", { alias: dest.alias });
  if (dest.kind === "direct") return t("needsYou.direct", { name: botName(dest.instanceId, dest.botId) });
  if (dest.kind === "group") return t("needsYou.group", { name: groupName(dest.instanceId, dest.groupId) });
  return t("needsYou.unplaced");
}

/** Agent-controlled text, rendered as data: first non-blank line of the
 *  message, else the schema title. Never empty when the hub sent either. */
function questionFor(state: PendingInteractionState): string {
  const message = state.request.elicitation?.message ?? "";
  const firstLine = message.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
  if (firstLine) return firstLine;
  return (state.request.elicitation?.schemaTitle ?? "").trim();
}

function timeLeftFor(state: PendingInteractionState): string {
  const ms = Math.max(0, state.request.expiresAt - directBots.inboxNowMs);
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return t("needsYou.secondsLeft", { count: Math.max(1, seconds) });
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return t("needsYou.minutesLeft", { count: minutes });
  return t("needsYou.hoursLeft", { count: Math.ceil(minutes / 60) });
}

function agentName(state: PendingInteractionState): string {
  return state.request.elicitation?.agent?.name ?? "";
}

/** Names and group/direct classification read the per-instance catalogs, which
 *  a background instance may never have loaded. Fill the gaps once (the
 *  loaders are cached behind their loaded flags; failures stay fallback text
 *  and the entry remains answerable in place). */
async function ensureCatalogs(): Promise<void> {
  const ids = new Set(entries.value.map((entry) => entry.instanceId));
  for (const id of ids) {
    if (!directBots.botsLoaded[id]) {
      try { await directBots.loadBots(id); } catch { /* offline: keep id fallbacks */ }
    }
    if (!groupsStore.groupsLoaded[id]) {
      try { await groupsStore.loadGroups(id); } catch { /* offline: keep id fallbacks */ }
    }
  }
}

function openEntry(state: PendingInteractionState): void {
  const dest = destinationFor(state);
  if (dest.kind === "session") emit("open-session", dest.instanceId, dest.alias);
  else if (dest.kind === "direct") emit("open-bot", dest.instanceId, dest.botId, dest.conversationId, dest.topicId);
  else if (dest.kind === "group") emit("open-group", dest.instanceId, dest.groupId, dest.conversationId, dest.topicId);
  else selectedId.value = state.request.requestId;
}

function answerSelected(key: string, value: InteractionValueDto): void {
  const entry = selectedEntry.value;
  if (entry) directBots.setInteractionAnswer(key, value, entry);
}
function submitSelected(): void {
  const entry = selectedEntry.value;
  if (entry) void directBots.submitInteraction("accept", entry);
}
function declineSelected(): void {
  const entry = selectedEntry.value;
  if (entry) void directBots.declineInteraction(entry);
}
function cancelSelected(): void {
  const entry = selectedEntry.value;
  if (entry) void directBots.cancelInteraction(entry);
}
function dismissSelected(): void {
  const entry = selectedEntry.value;
  if (entry) directBots.dismissResolvedInteraction(entry);
}

watch(
  () => entries.value.map((entry) => entry.instanceId).join("\0"),
  () => { void ensureCatalogs(); },
);

let catalogsQueued = false;
onMounted(() => {
  directBots.startInboxClock();
  void ensureCatalogs().catch(() => {});
  // Desktop popover: Escape and outside-click close; the trigger button is
  // excluded so its own toggle click still owns the toggle.
  if (!isMobile.value) {
    document.addEventListener("keydown", onDesktopKeydown, true);
    document.addEventListener("pointerdown", onDesktopPointerdown, true);
    void nextTick(() => panel.value?.focus());
  }
});
onBeforeUnmount(() => {
  directBots.stopInboxClock();
  document.removeEventListener("keydown", onDesktopKeydown, true);
  document.removeEventListener("pointerdown", onDesktopPointerdown, true);
});
function onDesktopKeydown(e: KeyboardEvent): void {
  if (!isMobile.value && e.key === "Escape") emit("close");
}
function onDesktopPointerdown(e: PointerEvent): void {
  if (isMobile.value) return;
  const target = e.target as Element | null;
  if (target?.closest?.('[data-test="needs-you-button"]')) return;
  if (panel.value && target && !panel.value.contains(target)) emit("close");
}
</script>

<template>
  <!-- Mobile: bottom sheet. Desktop: anchored popover under the header. -->
  <MobileSheet v-if="isMobile" :title="t('needsYou.title')" test-id="needs-you-sheet" @close="emit('close')">
    <div v-if="entries.length === 0" data-test="needs-you-empty" class="px-4 py-6 text-center text-sm text-fg-muted">
      {{ t("needsYou.empty") }}
    </div>
    <ul v-else class="divide-y divide-hairline">
      <li v-for="entry in entries" :key="entry.request.requestId" data-test="needs-you-row"
          :data-request-id="entry.request.requestId"
          class="flex min-w-0 flex-col gap-1 px-4 py-3">
        <div class="flex min-w-0 items-baseline gap-2">
          <span class="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{{ agentName(entry) }}</span>
          <span class="shrink-0 text-xs tabular-nums text-fg-muted">{{ timeLeftFor(entry) }}</span>
        </div>
        <p class="min-w-0 truncate text-xs text-fg-muted">{{ instanceName(entry.instanceId) }} · {{ destinationLabel(entry) }}</p>
        <p class="min-w-0 break-words text-sm text-fg">{{ questionFor(entry) }}</p>
        <div class="flex items-center gap-2 pt-1">
          <button type="button" data-test="needs-you-select"
                  class="min-h-12 min-w-0 flex-1 truncate rounded-lg px-3 text-left text-sm text-accent-text transition-colors hover:bg-surface-2 lg:min-h-0 lg:py-1"
                  @click="selectedId = entry.request.requestId">
            {{ destinationLabel(entry) }}
          </button>
          <button v-if="destinationFor(entry).kind !== 'none'" type="button" data-test="needs-you-open"
                  class="flex h-11 shrink-0 items-center rounded-lg bg-accent px-4 text-sm font-semibold text-white transition-colors hover:brightness-110"
                  @click="openEntry(entry)">
            {{ t("needsYou.open") }}
          </button>
        </div>
      </li>
    </ul>
    <div v-if="selectedEntry" class="border-t border-hairline p-4">
      <ConversationInteractionForm
        :request="selectedEntry.request"
        :answers="selectedEntry.answers"
        :submitting="selectedEntry.submitting"
        :error-code="selectedEntry.errorCode"
        :outcome="selectedEntry.outcome"
        @answer="answerSelected"
        @submit="submitSelected"
        @decline="declineSelected"
        @cancel="cancelSelected"
        @dismiss="dismissSelected"
      />
    </div>
  </MobileSheet>

  <div v-else ref="panel" data-test="needs-you-popover" role="dialog" :aria-label="t('needsYou.title')" tabindex="-1"
       class="fixed right-3 top-[calc(2.75rem+env(safe-area-inset-top))] z-40 flex max-h-[32rem] w-[26rem] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl bg-glass-strong shadow-glass-float backdrop-blur-glass">
    <div class="flex shrink-0 items-center justify-between border-b border-hairline px-4 py-2.5">
      <h2 class="text-sm font-semibold text-fg">{{ t("needsYou.title") }}</h2>
      <button type="button" data-test="needs-you-close" :aria-label="t('common.close')"
              class="grid h-8 w-8 place-items-center rounded-btn text-fg-muted transition-colors hover:bg-fill-hover hover:text-fg"
              @click="emit('close')"><X :size="15" /></button>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div v-if="entries.length === 0" data-test="needs-you-empty" class="px-4 py-6 text-center text-sm text-fg-muted">
        {{ t("needsYou.empty") }}
      </div>
      <ul v-else class="divide-y divide-hairline">
        <li v-for="entry in entries" :key="entry.request.requestId" data-test="needs-you-row"
            :data-request-id="entry.request.requestId"
            class="flex min-w-0 flex-col gap-1 px-4 py-3">
          <div class="flex min-w-0 items-baseline gap-2">
            <span class="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{{ agentName(entry) }}</span>
            <span class="shrink-0 text-xs tabular-nums text-fg-muted">{{ timeLeftFor(entry) }}</span>
          </div>
          <p class="min-w-0 truncate text-xs text-fg-muted">{{ instanceName(entry.instanceId) }} · {{ destinationLabel(entry) }}</p>
          <p class="min-w-0 break-words text-sm text-fg">{{ questionFor(entry) }}</p>
          <div class="flex items-center gap-2 pt-1">
            <button type="button" data-test="needs-you-select"
                    class="min-w-0 flex-1 truncate rounded-lg px-2 py-1 text-left text-sm text-accent-text transition-colors hover:bg-surface-2"
                    @click="selectedId = entry.request.requestId">
              {{ destinationLabel(entry) }}
            </button>
            <button v-if="destinationFor(entry).kind !== 'none'" type="button" data-test="needs-you-open"
                    class="shrink-0 rounded-lg bg-accent px-3 py-1 text-sm font-semibold text-white transition-colors hover:brightness-110"
                    @click="openEntry(entry)">
              {{ t("needsYou.open") }}
            </button>
          </div>
        </li>
      </ul>
      <div v-if="selectedEntry" class="border-t border-hairline p-4">
        <ConversationInteractionForm
          :request="selectedEntry.request"
          :answers="selectedEntry.answers"
          :submitting="selectedEntry.submitting"
          :error-code="selectedEntry.errorCode"
          :outcome="selectedEntry.outcome"
          @answer="answerSelected"
          @submit="submitSelected"
          @decline="declineSelected"
          @cancel="cancelSelected"
          @dismiss="dismissSelected"
        />
      </div>
    </div>
  </div>
</template>
