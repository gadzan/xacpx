<script setup lang="ts">
import { ref } from "vue";
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
}>();
const emit = defineEmits<{
  select: [instanceId: string, alias: string];
  create: [instanceId: string];
}>();

const pickerDd = useDropdown();

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
  <div data-test="empty-session-state"
       class="flex h-full flex-col items-center justify-center gap-6 p-8">
    <h2 data-test="empty-state-title" class="text-lg font-semibold text-fg">{{ $t("chat.emptyStateTitle") }}</h2>
    <ul v-if="sessions.length" class="w-full max-w-sm space-y-1">
      <li v-for="s in sessions" :key="`${s.instanceId}::${s.alias}`">
        <button type="button" data-test="recent-session"
                class="flex w-full items-center gap-2.5 rounded-sm bg-surface-2 px-3 py-2 text-left transition-colors hover:bg-raised"
                @click="emit('select', s.instanceId, s.alias)">
          <AgentIcon :driver="s.driver" :title="s.agent" :size="16" class="shrink-0" />
          <span data-test="recent-session-name" class="min-w-0 flex-1 truncate text-sm text-fg">{{ s.displayName || s.alias }}</span>
          <span data-test="recent-session-instance" class="shrink-0 text-xs text-fg-muted">{{ s.instanceName }}</span>
        </button>
      </li>
    </ul>
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
            <span class="h-2 w-2 shrink-0 rounded-full bg-run" aria-hidden="true" />
            <span class="min-w-0 truncate">{{ inst.name }}</span>
          </button>
        </template>
      </DropdownPanel>
      <button type="button" data-test="empty-new-session"
              :ref="(el) => (pickerDd.trigger = el as HTMLElement | null)"
              :aria-haspopup="true" :aria-expanded="pickerDd.open"
              class="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent shadow-float transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="instances.length === 0"
              @click="onCreate">
        <Plus :size="16" />{{ $t("instance.newSession") }}
      </button>
    </div>
  </div>
</template>
