<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { MessageSquare, Plus, Users, X } from "lucide-vue-next";
import type { BotSummaryDto } from "@ganglion/xacpx-relay-protocol";
import { useGroupsStore } from "../stores/groups";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useInstancesStore } from "../stores/instances";
import GroupTranscript from "./GroupTranscript.vue";
import GroupComposer from "./GroupComposer.vue";
import GroupTopicDialog from "./GroupTopicDialog.vue";

const groupsStore = useGroupsStore();
const directBotsStore = useDirectBotsStore();
const instancesStore = useInstancesStore();
const { t } = useI18n();

const newTopicDialogOpen = ref(false);

const group = computed(() => groupsStore.currentGroup);
const bots = computed<BotSummaryDto[]>(() => {
  const instId = groupsStore.instanceId;
  if (!instId) return [];
  return directBotsStore.botsByInstance[instId] ?? [];
});
const memberBots = computed<BotSummaryDto[]>(() => {
  const ids = new Set(group.value?.botIds ?? []);
  return bots.value.filter((b) => ids.has(b.id));
});

function handleSend(text: string): void {
  void groupsStore.sendPrompt(text);
}

function handleCancel(): void {
  void groupsStore.cancelCurrentRun();
}
</script>

<template>
  <div class="flex h-full flex-col bg-bg text-fg">
    <header class="flex shrink-0 items-center justify-between border-b border-border bg-surface px-4 py-2.5">
      <div class="flex min-w-0 items-center gap-3">
        <div class="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
          <Users :size="18" />
        </div>
        <div class="flex min-w-0 flex-col">
          <h2 class="truncate text-sm font-semibold">{{ group?.title ?? $t("group.nav.title") }}</h2>
          <div class="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
            <span>{{ $t("group.header.members", { count: group?.botIds.length ?? 0 }) }}</span>
            <span v-if="groupsStore.currentTopic">· {{ groupsStore.currentTopic.title }}</span>
          </div>
        </div>
      </div>
    </header>

    <div class="flex items-center justify-between border-b border-border bg-surface/50 px-4 py-1.5 text-xs">
      <div class="thin-scroll flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-0.5">
        <span class="mr-1 flex shrink-0 items-center gap-1 text-[11px] font-medium text-fg-muted">
          <MessageSquare :size="12" />
          <span>{{ $t("bot.topic.label") }}:</span>
        </span>
        <button
          v-for="topic in groupsStore.currentTopics"
          :key="topic.id"
          type="button"
          data-test="group-topic-pill"
          class="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors"
          :class="groupsStore.activeTopicId === topic.id
            ? 'bg-accent/15 font-semibold text-accent'
            : 'text-fg-muted hover:bg-raised hover:text-fg'"
          @click="groupsStore.switchTopic(topic.id)"
        >
          <span class="max-w-[140px] truncate">{{ topic.title || $t("bot.topic.default") }}</span>
        </button>
      </div>
      <button
        type="button"
        data-test="group-new-topic-button"
        class="ml-2 flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10"
        @click="newTopicDialogOpen = true"
      >
        <Plus :size="13" />
        <span>{{ $t("bot.topic.new") }}</span>
      </button>
    </div>

    <div v-if="groupsStore.generalErrorCode || groupsStore.generalError" class="flex items-center justify-between border-b border-danger/20 bg-danger/10 px-4 py-2 text-xs text-danger">
      <span>{{ groupsStore.generalErrorCode ? $t(`bot.errors.${groupsStore.generalErrorCode}`) : groupsStore.generalError }}</span>
      <button type="button" @click="groupsStore.generalError = null; groupsStore.generalErrorCode = null">
        <X :size="14" />
      </button>
    </div>

    <GroupTranscript :bots="memberBots" />

    <GroupComposer
      :bots="memberBots"
      :disabled="!groupsStore.activeTopicId || !groupsStore.topicReady"
      :instance-id="groupsStore.instanceId"
      @send="handleSend"
      @cancel="handleCancel"
    />
    <div v-if="groupsStore.historyError && groupsStore.activeTopicId"
         class="flex items-center justify-between border-t border-danger/20 bg-danger/10 px-4 py-2 text-xs text-danger">
      <span>{{ groupsStore.historyErrorDetail ?? groupsStore.historyError }}</span>
      <button type="button"
              class="rounded bg-danger/20 px-2 py-0.5 font-medium transition-colors hover:bg-danger/30"
              @click="groupsStore.instanceId && groupsStore.activeConversationId && groupsStore.loadHistory(groupsStore.instanceId, groupsStore.activeConversationId, groupsStore.activeTopicId)">
        {{ $t("bot.prompt.retry") }}
      </button>
    </div>

    <GroupTopicDialog
      v-if="newTopicDialogOpen"
      @close="newTopicDialogOpen = false"
    />
  </div>
</template>
