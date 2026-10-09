<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Users, X } from "lucide-vue-next";
import type { BotSummaryDto } from "@ganglion/xacpx-relay-protocol";
import { useGroupsStore, type GroupSendOutcome } from "../stores/groups";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useInstancesStore } from "../stores/instances";
import GroupTranscript from "./GroupTranscript.vue";
import GroupComposer from "./GroupComposer.vue";
import GroupTopicDialog from "./GroupTopicDialog.vue";
import ConversationWorktreePanel from "./ConversationWorktreePanel.vue";
import TopicManager from "./TopicManager.vue";

const groupsStore = useGroupsStore();
const directBotsStore = useDirectBotsStore();
const instancesStore = useInstancesStore();
const { t } = useI18n();

const newTopicDialogOpen = ref(false);

function requireTopicContext(): { instanceId: string; conversationId: string } | null {
  const instanceId = groupsStore.instanceId;
  const conversationId = groupsStore.activeConversationId;
  if (!instanceId || !conversationId) return null;
  return { instanceId, conversationId };
}

async function previewTopic(topicId: string) {
  const ctx = requireTopicContext();
  if (!ctx) throw new Error("topic unavailable");
  return groupsStore.previewTopic(ctx.instanceId, ctx.conversationId, topicId);
}

async function renameTopic(topicId: string, title: string) {
  const ctx = requireTopicContext();
  if (!ctx) return;
  await groupsStore.updateTopic(ctx.instanceId, ctx.conversationId, topicId, title);
}

async function archiveTopic(topicId: string) {
  const ctx = requireTopicContext();
  if (!ctx) return;
  await groupsStore.archiveTopic(ctx.instanceId, ctx.conversationId, topicId);
}

async function restoreTopic(topicId: string) {
  const ctx = requireTopicContext();
  if (!ctx) return;
  await groupsStore.restoreTopic(ctx.instanceId, ctx.conversationId, topicId);
}

async function teardownTopic(topicId: string, requestId: string, releaseBindings: boolean) {
  const ctx = requireTopicContext();
  if (!ctx) return;
  await groupsStore.teardownTopic(ctx.instanceId, ctx.conversationId, topicId, requestId, releaseBindings);
}

async function clearTopic(topicId: string, requestId: string, releaseBindings: boolean) {
  const ctx = requireTopicContext();
  if (!ctx) return;
  await groupsStore.clearTopic(ctx.instanceId, ctx.conversationId, topicId, requestId, releaseBindings);
}

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

/** Resolves the send against the store so the composer can decide whether to drop
 *  the draft. A definitive refusal returns "rejected" and the text stays put. */
/** Resolves once the current send attempt finishes, so the composer can keep the
 *  draft when the refusal was definitive. */
function sendPromptOutcome(): Promise<GroupSendOutcome> {
  return groupsStore.sendPromptOutcomePromise;
}

function handleSend(text: string): void {
  void groupsStore.sendPrompt(text);
}

function handleCancel(): void {
  void groupsStore.cancelCurrentRun();
}

// An archived Topic stays browsable (its transcript is durable history), but it
// cannot accept new Runs — sending there is a guaranteed `topic_not_active`.
const isActiveTopic = computed(() => groupsStore.currentTopic?.status === "active");
const worktreeRunId = computed(() => {
  if (groupsStore.activeRun?.topicId === groupsStore.activeTopicId) return groupsStore.activeRun.id;
  // After reconnect there may be no active owner: integration belongs to the
  // latest durable result, even when that Run is already terminal.
  return [...groupsStore.messages].reverse().find(m => m.topicId === groupsStore.activeTopicId && m.runId)?.runId;
});
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

    <div class="flex items-center border-b border-border bg-surface/50 px-4 py-1.5 text-xs">
      <TopicManager
        variant="group"
        :topics="groupsStore.currentTopics"
        :active-topic-id="groupsStore.activeTopicId"
        :preview-topic="previewTopic"
        :rename-topic="renameTopic"
        :archive-topic="archiveTopic"
        :restore-topic="restoreTopic"
        :teardown-topic="teardownTopic"
        :clear-topic="clearTopic"
        @select="groupsStore.switchTopic"
        @create="newTopicDialogOpen = true"
      />
    </div>

    <div v-if="groupsStore.generalErrorCode || groupsStore.generalError" class="flex items-center justify-between border-b border-danger/20 bg-danger/10 px-4 py-2 text-xs text-danger">
      <span>{{ groupsStore.generalErrorCode ? $t(`bot.errors.${groupsStore.generalErrorCode}`) : groupsStore.generalError }}</span>
      <button type="button" @click="groupsStore.generalError = null; groupsStore.generalErrorCode = null">
        <X :size="14" />
      </button>
    </div>

    <GroupTranscript :bots="memberBots" />
    <ConversationWorktreePanel v-if="groupsStore.currentTopic?.executionTarget?.isolation === 'worktree-per-member' && groupsStore.instanceId && worktreeRunId"
      :instance-id="groupsStore.instanceId" :run-id="worktreeRunId" />

    <GroupComposer
      :bots="memberBots"
      :disabled="!groupsStore.activeTopicId || !groupsStore.topicReady || !isActiveTopic"
      :instance-id="groupsStore.instanceId"
      :send-outcome="sendPromptOutcome"
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
