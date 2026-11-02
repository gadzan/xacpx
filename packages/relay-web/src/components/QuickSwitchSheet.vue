<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Check, Search, Users } from "lucide-vue-next";
import MobileSheet from "./MobileSheet.vue";
import BotAvatar from "./BotAvatar.vue";
import AgentIcon from "./AgentIcon.vue";
import { useInstancesStore } from "../stores/instances";
import { useChatStore } from "../stores/chat";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useGroupsStore } from "../stores/groups";
import { archivedLast, sessionPresentationName } from "../lib/sidebar-group-mode";

// Mobile "quick switch" half-screen (design mobile.md §6.1): tapping the conversation
// page's title opens ONE scrollable sheet with recent conversations first, then the
// current instance's Bots, then its groups. Tapping a row switches to it and closes.
//
// Mount with `v-if` at the call site: like every MobileSheet caller, the sheet owns a
// history entry (mobile back / iOS edge swipe) and the top-most Escape slot while it
// is mounted. The parent owns the selection side effects (its onSelect / onSelectBot /
// onSelectGroup); the sheet only reports the pick.
//
// Identity mirrors the sidebar: a conversation row shows the agent glyph + the session
// name (with the agent beneath), a bot row its avatar + name + role, a group row the
// Users tile + title + member count.
const props = defineProps<{
  /** The instance whose conversations, Bots and groups are listed. */
  instanceId: string;
}>();
const emit = defineEmits<{
  close: [];
  /** A conversation row was picked. The parent runs its own select + history load. */
  selectSession: [instanceId: string, alias: string];
  selectBot: [instanceId: string, botId: string];
  selectGroup: [instanceId: string, groupId: string];
}>();

const { t } = useI18n();
const instances = useInstancesStore();
const chat = useChatStore();
const directBotsStore = useDirectBotsStore();
const groupsStore = useGroupsStore();

const instance = computed(() => instances.byId(props.instanceId));

/** Recent conversations of the current instance. SessionDto carries no activity
 *  timestamp, so "recent" is the store's list order with the conversation being
 *  viewed bumped to the front (the same last-opened bump the empty state uses).
 *  Sleeping rows sink below the active ones (archivedLast), dimmed. */
const sessionRows = computed(() => {
  const inst = instance.value;
  if (!inst) return [];
  const active = inst.sessions.filter((s) => !s.archived);
  const sleeping = archivedLast(inst.sessions.filter((s) => s.archived));
  const rows = [...active, ...sleeping];
  const current = rows.findIndex((s) => s.alias === chat.sessionAlias);
  if (current > 0) rows.unshift(...rows.splice(current, 1));
  return rows;
});
/** Enabled bots first, then disabled ones (the sidebar's collapsed "disabled" group has
 *  no room in a switcher — the list just runs on). Retired bots are omitted: they have
 *  nothing left to switch to. */
const botRows = computed(() => {
  const all = (directBotsStore.botsByInstance[props.instanceId] ?? []).filter((b) => !b.retired);
  return [...all.filter((b) => b.enabled), ...all.filter((b) => !b.enabled)];
});
const groupRows = computed(() => groupsStore.groupsByInstance[props.instanceId] ?? []);

// Per-section filter, shown only when a section outgrows ~8 rows. One pattern, three
// independent queries: typing in one section never hides another. The fields are never
// autofocused (the sheet's initial focus lands on its ✕), so no keyboard opens before
// the user has results to filter.
const SEARCH_THRESHOLD = 8;
const sessionQuery = ref("");
const botQuery = ref("");
const groupQuery = ref("");
function matches(hay: string, q: string): boolean {
  return hay.toLowerCase().includes(q.trim().toLowerCase());
}
const filteredSessions = computed(() => {
  const q = sessionQuery.value.trim();
  if (!q) return sessionRows.value;
  return sessionRows.value.filter((s) => matches(`${s.displayName || ""} ${s.alias} ${s.agent}`, q));
});
const filteredBots = computed(() => {
  const q = botQuery.value.trim();
  if (!q) return botRows.value;
  return botRows.value.filter((b) => matches(`${b.name} ${b.role || ""}`, q));
});
const filteredGroups = computed(() => {
  const q = groupQuery.value.trim();
  if (!q) return groupRows.value;
  return groupRows.value.filter((g) => matches(g.title, q));
});

function driverForAgent(agentName: string): string | undefined {
  return instance.value?.agents.find((a) => a.name === agentName)?.driver;
}
function driverForSession(s: { agent: string; driver?: string }): string | undefined {
  return s.driver ?? driverForAgent(s.agent);
}
/** The name the sidebar shows for this row: the same presentation helper, so a
 *  grouped sidebar's deduped names read identically here. */
function sessionName(s: { alias: string; displayName?: string; workspace?: string; agent?: string }): string {
  return sessionPresentationName({
    displayName: s.displayName,
    alias: s.alias,
    workspace: s.workspace,
    agent: s.agent,
    groupMode: instances.groupModeFor(props.instanceId),
  });
}
function isSessionSelected(alias: string): boolean {
  return chat.instanceId === props.instanceId && chat.sessionAlias === alias;
}
function isBotSelected(botId: string): boolean {
  return directBotsStore.instanceId === props.instanceId && directBotsStore.selectedBotId === botId;
}
function isGroupSelected(groupId: string): boolean {
  return groupsStore.instanceId === props.instanceId && groupsStore.selectedGroupId === groupId;
}

function pickSession(alias: string): void {
  emit("selectSession", props.instanceId, alias);
  emit("close");
}
function pickBot(botId: string): void {
  emit("selectBot", props.instanceId, botId);
  emit("close");
}
function pickGroup(groupId: string): void {
  emit("selectGroup", props.instanceId, groupId);
  emit("close");
}
</script>

<template>
  <MobileSheet :title="t('quickSwitch.title')" test-id="quick-switch-sheet" @close="emit('close')">
    <!-- Section: recent conversations (52px rows, like the sidebar's session rows). -->
    <section v-if="sessionRows.length" aria-labelledby="qs-sessions">
      <h3 id="qs-sessions" data-test="quick-switch-sessions-title"
          class="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-fg-muted">
        {{ t("quickSwitch.sessions") }}
      </h3>
      <div v-if="sessionRows.length > SEARCH_THRESHOLD" class="px-3 pb-1">
        <div class="flex min-h-[44px] items-center gap-2 rounded-lg bg-fill-track px-3">
          <Search :size="16" class="shrink-0 text-fg-muted" aria-hidden="true" />
          <input v-model="sessionQuery" type="search" data-test="quick-switch-sessions-search"
                 :placeholder="t('quickSwitch.search')" :aria-label="t('quickSwitch.search')"
                 class="w-full bg-transparent text-base text-fg placeholder:text-fg-muted outline-none" />
        </div>
      </div>
      <button v-for="s in filteredSessions" :key="s.alias" type="button"
              data-test="quick-switch-session-row" :data-alias="s.alias"
              :aria-current="isSessionSelected(s.alias) ? 'true' : undefined"
              class="flex min-h-[52px] w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface-2"
              :class="isSessionSelected(s.alias) ? 'bg-accent-soft text-fg' : 'text-fg'"
              @click="pickSession(s.alias)">
        <AgentIcon :driver="driverForSession(s)" :title="s.agent" :size="14" class="shrink-0" />
        <span class="flex min-w-0 flex-1 flex-col">
          <span data-test="quick-switch-session-name" class="min-w-0 truncate text-sm font-medium"
                :class="s.archived ? 'text-fg-muted' : (isSessionSelected(s.alias) ? 'font-semibold text-fg' : 'text-fg')">
            {{ sessionName(s) }}
          </span>
          <span class="truncate text-xs text-fg-muted">{{ s.agent }}</span>
        </span>
        <Check v-if="isSessionSelected(s.alias)" :size="16" class="shrink-0 text-accent-text" aria-hidden="true" />
      </button>
      <p v-if="!filteredSessions.length" data-test="quick-switch-empty"
         class="px-3 py-2 text-sm text-fg-muted">{{ t("common.noMatch") }}</p>
    </section>

    <!-- Section: the current instance's bots (46px compact rows with their avatar). -->
    <section v-if="botRows.length" aria-labelledby="qs-bots">
      <h3 id="qs-bots" data-test="quick-switch-bots-title"
          class="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-fg-muted">
        {{ t("quickSwitch.bots") }}
      </h3>
      <div v-if="botRows.length > SEARCH_THRESHOLD" class="px-3 pb-1">
        <div class="flex min-h-[44px] items-center gap-2 rounded-lg bg-fill-track px-3">
          <Search :size="16" class="shrink-0 text-fg-muted" aria-hidden="true" />
          <input v-model="botQuery" type="search" data-test="quick-switch-bots-search"
                 :placeholder="t('quickSwitch.search')" :aria-label="t('quickSwitch.search')"
                 class="w-full bg-transparent text-base text-fg placeholder:text-fg-muted outline-none" />
        </div>
      </div>
      <button v-for="b in filteredBots" :key="b.id" type="button"
              data-test="quick-switch-bot-row" :data-bot-id="b.id"
              :aria-current="isBotSelected(b.id) ? 'true' : undefined"
              class="flex min-h-[46px] w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-surface-2"
              :class="isBotSelected(b.id) ? 'bg-accent-soft text-fg' : 'text-fg'"
              @click="pickBot(b.id)">
        <BotAvatar :avatar="b.avatar" :driver="driverForAgent(b.agent)" :name="b.name" :size="24"
                   :static="true" :disabled="!b.enabled" :class="!b.enabled ? 'opacity-50' : ''" />
        <span class="flex min-w-0 flex-1 flex-col">
          <span data-test="quick-switch-bot-name" class="min-w-0 truncate text-sm font-medium"
                :class="!b.enabled ? 'text-fg-muted' : (isBotSelected(b.id) ? 'font-semibold text-fg' : 'text-fg')">
            {{ b.name }}
          </span>
          <span v-if="b.role" class="truncate text-xs text-fg-muted">{{ b.role }}</span>
        </span>
        <Check v-if="isBotSelected(b.id)" :size="16" class="shrink-0 text-accent-text" aria-hidden="true" />
      </button>
      <p v-if="!filteredBots.length" data-test="quick-switch-empty"
         class="px-3 py-2 text-sm text-fg-muted">{{ t("common.noMatch") }}</p>
    </section>

    <!-- Section: the current instance's groups (46px compact rows, Users tile + members). -->
    <section v-if="groupRows.length" aria-labelledby="qs-groups">
      <h3 id="qs-groups" data-test="quick-switch-groups-title"
          class="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-fg-muted">
        {{ t("quickSwitch.groups") }}
      </h3>
      <div v-if="groupRows.length > SEARCH_THRESHOLD" class="px-3 pb-1">
        <div class="flex min-h-[44px] items-center gap-2 rounded-lg bg-fill-track px-3">
          <Search :size="16" class="shrink-0 text-fg-muted" aria-hidden="true" />
          <input v-model="groupQuery" type="search" data-test="quick-switch-groups-search"
                 :placeholder="t('quickSwitch.search')" :aria-label="t('quickSwitch.search')"
                 class="w-full bg-transparent text-base text-fg placeholder:text-fg-muted outline-none" />
        </div>
      </div>
      <button v-for="g in filteredGroups" :key="g.id" type="button"
              data-test="quick-switch-group-row" :data-group-id="g.id"
              :aria-current="isGroupSelected(g.id) ? 'true' : undefined"
              class="flex min-h-[46px] w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-surface-2"
              :class="isGroupSelected(g.id) ? 'bg-accent-soft text-fg' : 'text-fg'"
              @click="pickGroup(g.id)">
        <span class="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent" aria-hidden="true">
          <Users :size="14" />
        </span>
        <span class="flex min-w-0 flex-1 flex-col">
          <span data-test="quick-switch-group-name" class="min-w-0 truncate text-sm font-medium"
                :class="isGroupSelected(g.id) ? 'font-semibold text-fg' : 'text-fg'">
            {{ g.title }}
          </span>
          <span class="truncate text-xs text-fg-muted">{{ t("group.header.members", g.botIds.length) }}</span>
        </span>
        <Check v-if="isGroupSelected(g.id)" :size="16" class="shrink-0 text-accent-text" aria-hidden="true" />
      </button>
      <p v-if="!filteredGroups.length" data-test="quick-switch-empty"
         class="px-3 py-2 text-sm text-fg-muted">{{ t("common.noMatch") }}</p>
    </section>

    <p v-if="!sessionRows.length && !botRows.length && !groupRows.length" data-test="quick-switch-empty"
       class="px-3 py-4 text-center text-sm text-fg-muted">{{ t("quickSwitch.empty") }}</p>
  </MobileSheet>
</template>
