<script setup lang="ts">
import { computed } from "vue";
import { Plus } from "lucide-vue-next";
import AgentIcon from "./AgentIcon.vue";
import DropdownPanel from "./DropdownPanel.vue";
import { useDropdown } from "../lib/use-dropdown";

/** One row of the recent-sessions list. Identity is (instanceId, alias). */
export interface RecentSessionItem {
  instanceId: string;
  instanceName: string;
  alias: string;
  displayName?: string;
  agent: string;
  driver?: string;
}

/** An online instance the new-session button can create in. */
export interface CreateTarget {
  id: string;
  name: string;
}

const props = defineProps<{
  sessions: RecentSessionItem[];
  /** Online instances, last-used first. Empty disables the create button. */
  instances: CreateTarget[];
  /** Every instance the account knows about, online or not — the "N / M" readiness
   *  reading. Defaults to the online count when the caller has no wider view. */
  totalInstances?: number;
}>();

const emit = defineEmits<{
  select: [instanceId: string, alias: string];
  create: [instanceId: string];
}>();

const pickerDd = useDropdown();

/** Distinct agents across the recent sessions, most used first — the bento's mix panel. */
const agentMix = computed(() => {
  const counts = new Map<string, number>();
  for (const s of props.sessions) counts.set(s.agent, (counts.get(s.agent) ?? 0) + 1);
  const rows = [...counts.entries()].map(([agent, count]) => ({ agent, count })).sort((a, b) => b.count - a.count);
  const max = rows[0]?.count ?? 1;
  return rows.map((row) => ({ ...row, ratio: row.count / max }));
});

function onCreate(): void {
  if (props.instances.length === 1) emit("create", props.instances[0]!.id);
  else if (props.instances.length > 1) pickerDd.toggle();
}
function onPick(instanceId: string): void {
  pickerDd.closeMenu();
  emit("create", instanceId);
}
</script>

<template>
  <!-- Bento overview: the desktop home is a dashboard of what is reachable right now,
       not a centred "nothing selected" placeholder. Every number is derived from the
       same lists the sections below render, so the cards never claim more than the page
       can show. -->
  <div data-test="empty-session-state" class="thin-scroll h-full overflow-y-auto">
    <div class="mx-auto flex w-full max-w-3xl flex-col gap-3 p-5 lg:p-8">
      <!-- Hero: the one line that says where you are, the reason to act, and the action. -->
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div class="min-w-0">
          <h2 data-test="empty-state-title" class="text-xl font-semibold tracking-tight text-fg">{{ $t("chat.emptyStateTitle") }}</h2>
          <p class="mt-1 text-xs text-fg-muted">{{ $t("chat.bento.subtitle") }}</p>
        </div>
        <div class="relative">
          <DropdownPanel :dd="pickerDd" width="w-56" placement="top"
                         :title='$t("instance.newSession")' test-id="empty-instance-panel"
                         :nav-count="instances.length"
                         @navigate="(i) => onPick(instances[i]!.id)">
            <template #default="{ mobile }">
              <p class="px-2 pb-1 pt-1.5 text-xs text-fg-muted">{{ $t("instance.pickInstance") }}</p>
              <button v-for="(inst, i) in instances" :key="inst.id" type="button" data-test="empty-instance-option"
                      class="flex w-full items-center gap-2 rounded-item px-2 text-left text-ui text-fg"
                      :class="[mobile ? 'h-11' : 'h-[30px]', !mobile && i === pickerDd.highlight ? 'bg-fill-strong' : 'hover:bg-fill-hover']"
                      @click="onPick(inst.id)">
                <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-run ring-2 ring-run/20" aria-hidden="true" />
                <span class="min-w-0 truncate">{{ inst.name }}</span>
              </button>
            </template>
          </DropdownPanel>
          <button type="button" data-test="empty-new-session"
                  :ref="(el) => (pickerDd.trigger = el as HTMLElement | null)"
                  :aria-haspopup="true" :aria-expanded="pickerDd.open"
                  class="flex h-8 items-center gap-1.5 rounded-btn bg-accent bg-[linear-gradient(180deg,rgba(255,255,255,0.16),rgba(255,255,255,0))] px-3 text-ui font-medium text-on-accent shadow-btn transition-[transform,background-color,opacity] duration-150 ease-ui hover:bg-accent-hover active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
                  :disabled="instances.length === 0"
                  @click="onCreate">
            <Plus :size="15" />{{ $t("instance.newSession") }}
          </button>
        </div>
      </div>

      <!-- Metric cards: one hairline each, no fill — the raised sheet behind them is
           already the card tone. -->
      <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <div data-test="empty-stat" class="rounded-xl border border-hairline bg-bg/35 p-3 dark:bg-white/[0.02]">
          <div class="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
            <span class="h-1.5 w-1.5 rounded-full" :class="instances.length ? 'bg-run ring-2 ring-run/20' : 'bg-fg-muted opacity-45'" aria-hidden="true" />
            {{ $t("chat.bento.onlineInstances") }}
          </div>
          <div data-test="empty-stat-value" class="mt-1.5 flex items-baseline gap-1 font-mono text-2xl font-semibold tabular-nums tracking-tight text-fg">
            {{ instances.length }}<span class="text-sm font-medium text-fg-muted">/ {{ totalInstances ?? instances.length }}</span>
          </div>
          <div class="mt-1 truncate text-xs text-fg-muted">{{ instances.map((i) => i.name).join(" · ") || $t("chat.bento.noneOnline") }}</div>
        </div>

        <div data-test="empty-stat" class="rounded-xl border border-hairline bg-bg/35 p-3 dark:bg-white/[0.02]">
          <div class="flex items-center gap-1.5 text-xs font-medium text-fg-muted">{{ $t("chat.bento.sessions") }}</div>
          <div data-test="empty-stat-value" class="mt-1.5 font-mono text-2xl font-semibold tabular-nums tracking-tight text-fg">{{ sessions.length }}</div>
          <div class="mt-1 truncate text-xs text-fg-muted">{{ sessions[0] ? (sessions[0].displayName || sessions[0].alias) : $t("chat.bento.emptyRecent") }}</div>
        </div>

        <div data-test="empty-stat" class="rounded-xl border border-hairline bg-bg/35 p-3 dark:bg-white/[0.02]">
          <div class="flex items-center gap-1.5 text-xs font-medium text-fg-muted">{{ $t("chat.bento.agents") }}</div>
          <div data-test="empty-stat-value" class="mt-1.5 font-mono text-2xl font-semibold tabular-nums tracking-tight text-fg">{{ agentMix.length }}</div>
          <div class="mt-1 truncate text-xs text-fg-muted">{{ agentMix.map((a) => a.agent).join(" · ") || "—" }}</div>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-2.5 lg:grid-cols-[1.35fr_1fr]">
        <!-- Recent sessions: the same rows the old centred list had, now a panel. -->
        <section class="min-w-0 rounded-xl border border-hairline bg-bg/35 dark:bg-white/[0.02]">
          <header class="flex items-center justify-between gap-2 px-3 pb-1 pt-2.5">
            <h3 class="text-xs font-semibold tracking-wide text-fg-muted">{{ $t("chat.bento.recentSessions") }}</h3>
            <span class="text-xs text-fg-muted">{{ $t("chat.bento.resumeHint") }}</span>
          </header>
          <ul v-if="sessions.length" class="p-1.5 pt-0">
            <li v-for="s in sessions" :key="`${s.instanceId}::${s.alias}`">
              <button type="button" data-test="recent-session"
                      class="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-fill-hover"
                      @click="emit('select', s.instanceId, s.alias)">
                <AgentIcon :driver="s.driver" :title="s.agent" :size="15" class="shrink-0" />
                <span data-test="recent-session-name" class="min-w-0 flex-1 truncate text-sm text-fg">{{ s.displayName || s.alias }}</span>
                <span data-test="recent-session-instance" class="shrink-0 text-xs text-fg-muted">{{ s.instanceName }}</span>
                <span class="shrink-0 text-xs text-accent-text opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">{{ $t("chat.bento.resume") }}</span>
              </button>
            </li>
          </ul>
          <p v-else data-test="empty-no-recent" class="px-3 pb-3 pt-1 text-xs text-fg-muted">{{ $t("chat.bento.emptyRecent") }}</p>
        </section>

        <!-- Agent mix: a bar per agent in use, scaled to the busiest one. -->
        <section class="min-w-0 rounded-xl border border-hairline bg-bg/35 dark:bg-white/[0.02]">
          <header class="flex items-center justify-between gap-2 px-3 pb-1 pt-2.5">
            <h3 class="text-xs font-semibold tracking-wide text-fg-muted">{{ $t("chat.bento.agentMix") }}</h3>
          </header>
          <ul v-if="agentMix.length" class="space-y-2 px-3 pb-3 pt-1">
            <li v-for="row in agentMix" :key="row.agent" data-test="empty-agent-row" class="min-w-0">
              <div class="flex items-center justify-between gap-2 text-xs">
                <span class="min-w-0 truncate text-fg">{{ row.agent }}</span>
                <span class="shrink-0 font-mono tabular-nums text-fg-muted">{{ row.count }}</span>
              </div>
              <div class="mt-1 h-1 overflow-hidden rounded-full bg-fill-track">
                <div class="h-full rounded-full bg-accent/70" :style="{ width: `${Math.round(row.ratio * 100)}%` }" />
              </div>
            </li>
          </ul>
          <p v-else class="px-3 pb-3 pt-1 text-xs text-fg-muted">{{ $t("chat.bento.emptyRecent") }}</p>
        </section>
      </div>
    </div>
  </div>
</template>
