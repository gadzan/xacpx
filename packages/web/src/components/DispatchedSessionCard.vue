<script setup lang="ts">
import { computed, inject } from "vue";
import type { ConversationMessageDto } from "@ganglion/xacpx-relay-protocol";
import { useChatStore } from "../stores/chat";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useInstancesStore } from "../stores/instances";
import { primaryKeyFor, splitPrimaryKey, useSplitLayoutStore } from "../stores/split-layout";

const props = defineProps<{
  message: ConversationMessageDto;
  instanceId: string;
}>();

const chat = useChatStore();
const directBots = useDirectBotsStore();
const instances = useInstancesStore();
const splitLayout = useSplitLayoutStore();
/** Layout primary hosting this card (provided by SplitWorkbench; null standalone). */
const injectedPrimaryKey = inject(splitPrimaryKey, null);

const dispatched = computed(() => props.message.dispatchedSession ?? null);
const displayName = computed(() => dispatched.value?.displayName ?? dispatched.value?.sessionAlias ?? "");
const sessionAlias = computed(() => dispatched.value?.sessionAlias ?? "");
const agent = computed(() => dispatched.value?.agent ?? "");
const workspace = computed(() => dispatched.value?.workspace ?? "");

const sessionRow = computed(() => {
  if (!dispatched.value) return undefined;
  return instances.byId(props.instanceId)?.sessions.find((s) => s.alias === dispatched.value!.sessionAlias);
});
const isRunning = computed(() => !!sessionRow.value && sessionRow.value.running === true && sessionRow.value.archived !== true);

const currentPrimary = computed(() => {
  // The layout hosting this card knows best (injected by SplitWorkbench).
  // Fallbacks preserve standalone contexts: selected Bot, then selected session.
  if (injectedPrimaryKey?.value) return injectedPrimaryKey.value;
  if (chat.instanceId && chat.sessionAlias) {
    return primaryKeyFor({ kind: "session", instanceId: chat.instanceId, sessionAlias: chat.sessionAlias });
  }
  if (directBots.instanceId && directBots.selectedBotId) {
    return primaryKeyFor({ kind: "bot", instanceId: directBots.instanceId, botId: directBots.selectedBotId });
  }
  return primaryKeyFor({ kind: "session", instanceId: props.instanceId, sessionAlias: sessionAlias.value });
});

const isOpen = computed(() => {
  if (!dispatched.value) return false;
  const layout = splitLayout.layoutsByPrimary[currentPrimary.value];
  if (!layout) return false;
  return layout.columns.some(
    (c) => c.target.kind === "session" && c.target.instanceId === props.instanceId && c.target.sessionAlias === sessionAlias.value,
  );
});

function openInSplit(): void {
  if (!dispatched.value) return;
  splitLayout.reopenDispatchedSession(currentPrimary.value, props.instanceId, sessionAlias.value);
}
</script>

<template>
  <div
    v-if="dispatched"
    data-test="dispatched-session-card"
    class="mx-auto w-full max-w-3xl rounded-lg border border-hairline bg-bg/60 px-3 py-2.5 shadow-press dark:bg-white/[0.04]"
  >
    <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span data-test="dispatched-session-name" class="min-w-0 truncate text-sm font-semibold text-fg">
        {{ displayName }}
      </span>
      <span
        data-test="dispatched-session-status"
        :data-state="isRunning ? 'running' : 'idle'"
        class="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
        :class="isRunning ? 'bg-run/10 text-run' : 'bg-fg/5 text-fg-muted'"
      >
        <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="isRunning ? 'bg-run' : 'bg-fg-muted'" />
        {{ isRunning ? $t("split.dispatched.running") : $t("split.dispatched.idle") }}
      </span>
    </div>
    <div class="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-fg-muted">
      <span data-test="dispatched-session-agent" class="min-w-0 truncate">{{ agent }}</span>
      <span aria-hidden="true" class="shrink-0">·</span>
      <span data-test="dispatched-session-workspace" class="min-w-0 truncate">{{ workspace }}</span>
    </div>
    <div class="mt-2 flex justify-end">
      <button
        type="button"
        data-test="dispatched-session-open"
        class="inline-flex items-center gap-1 rounded-sm bg-accent-soft px-2 py-1 text-xs font-medium text-accent-text transition-colors hover:bg-accent/20"
        @click="openInSplit"
      >
        {{ isOpen ? $t("split.dispatched.locate") : $t("split.dispatched.open") }}
      </button>
    </div>
  </div>
</template>
