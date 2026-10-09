<script setup lang="ts">
import { computed, ref } from "vue";
import {
  Bot,
  ChevronDown,
  Folder,
  Pencil,
  Trash2,
  X,
} from "lucide-vue-next";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useInstancesStore } from "../stores/instances";
import type { InteractionValueDto } from "@ganglion/xacpx-relay-protocol";
import AgentIcon from "./AgentIcon.vue";
import ConversationMessageList from "./ConversationMessageList.vue";
import ConversationPromptInput from "./ConversationPromptInput.vue";
import BotDialog from "./BotDialog.vue";
import BotRemovalDialog from "./BotRemovalDialog.vue";
import NewTopicDialog from "./NewTopicDialog.vue";
import TopicManager from "./TopicManager.vue";

const directBotsStore = useDirectBotsStore();
const instancesStore = useInstancesStore();

const bot = computed(() => directBotsStore.currentBot);
const instance = computed(() =>
  directBotsStore.instanceId ? instancesStore.byId(directBotsStore.instanceId) : undefined,
);

const botDriver = computed(() => {
  if (!bot.value || !instance.value) return undefined;
  return instance.value.agents.find((a) => a.name === bot.value?.agent)?.driver;
});

const editDialogOpen = ref(false);
const newTopicDialogOpen = ref(false);

function requireTopicContext(): { instanceId: string; conversationId: string } | null {
  const instanceId = directBotsStore.instanceId;
  const conversationId = directBotsStore.activeConversationId;
  if (!instanceId || !conversationId) return null;
  return { instanceId, conversationId };
}

async function previewTopic(topicId: string) {
  const ctx = requireTopicContext();
  if (!ctx) throw new Error("topic unavailable");
  return directBotsStore.previewTopic(ctx.instanceId, ctx.conversationId, topicId);
}

async function renameTopic(topicId: string, title: string) {
  const ctx = requireTopicContext();
  if (!ctx) return;
  await directBotsStore.updateTopic(ctx.instanceId, ctx.conversationId, topicId, title);
}

async function archiveTopic(topicId: string) {
  const ctx = requireTopicContext();
  if (!ctx) return;
  await directBotsStore.archiveTopic(ctx.instanceId, ctx.conversationId, topicId);
}

async function restoreTopic(topicId: string) {
  const ctx = requireTopicContext();
  if (!ctx) return;
  await directBotsStore.restoreTopic(ctx.instanceId, ctx.conversationId, topicId);
}

async function teardownTopic(topicId: string, requestId: string, releaseBindings: boolean) {
  const ctx = requireTopicContext();
  if (!ctx) return;
  await directBotsStore.teardownTopic(ctx.instanceId, ctx.conversationId, topicId, requestId, releaseBindings);
}

async function clearTopic(topicId: string, requestId: string, releaseBindings: boolean) {
  const ctx = requireTopicContext();
  if (!ctx) return;
  await directBotsStore.clearTopic(ctx.instanceId, ctx.conversationId, topicId, requestId, releaseBindings);
}

const removalOpen = ref(false);

function openRemoval(): void {
  if (!bot.value || bot.value.retired) return;
  removalOpen.value = true;
}
</script>

<template>
  <div class="flex h-full flex-col bg-bg text-fg">
    <!-- Top Header: Bot metadata & Actions -->
    <header class="flex shrink-0 items-center justify-between border-b border-border bg-surface px-4 py-2.5">
      <div class="flex items-center gap-3 min-w-0">
        <!-- Bot Icon / Avatar -->
        <div class="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent border border-accent/20">
          <AgentIcon v-if="botDriver" :driver="botDriver" :title="bot?.name ?? 'Bot'" :size="18" />
          <Bot v-else :size="18" />
        </div>

        <!-- Name, Role & Chips -->
        <div class="flex flex-col min-w-0">
          <div class="flex items-center gap-2">
            <h2 class="text-sm font-semibold truncate">{{ bot?.name ?? $t("bot.nav.title") }}</h2>
            <span
              class="h-2 w-2 rounded-full shrink-0"
              :class="bot?.enabled ? 'bg-run' : 'bg-fg-muted'"
              :title="bot?.enabled ? $t('bot.status.enabled') : $t('bot.status.disabled')"
            />
            <span v-if="bot && !bot.enabled" class="text-[10.5px] text-fg-muted font-medium">
              ({{ $t("bot.status.disabled") }})
            </span>
          </div>

          <div class="flex items-center gap-2 text-xs text-fg-muted flex-wrap">
            <span v-if="bot?.role" class="truncate font-medium text-fg/80">{{ bot.role }}</span>
            <span v-if="bot?.role">·</span>
            <span class="flex items-center gap-1">
              <Folder :size="11" />
              <span>{{ bot?.workspace }}</span>
            </span>
            <span>·</span>
            <span>{{ bot?.agent }}</span>
            <span v-if="bot?.model">· {{ bot.model }}</span>
          </div>
        </div>
      </div>

      <!-- Actions: Edit, Delete -->
      <div class="flex items-center gap-1">
        <button
          type="button"
          data-test="edit-bot-button"
          :title="$t('bot.actions.edit')"
          :aria-label="$t('bot.actions.edit')"
          class="grid h-8 w-8 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-raised hover:text-fg"
          @click="editDialogOpen = true"
        >
          <Pencil :size="14" />
        </button>
        <button
          type="button"
          data-test="delete-bot-button"
          :title="bot?.retired ? $t('bot.removal.removed') : $t('bot.removal.action')"
          :aria-label="$t('bot.removal.action')"
          :disabled="bot?.retired === true"
          class="grid h-8 w-8 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
          @click="openRemoval"
        >
          <Trash2 :size="14" />
        </button>
      </div>
    </header>

    <div v-if="bot?.retired" data-test="removed-bot-banner" class="border-b border-border bg-surface px-4 py-2 text-xs text-fg-muted">
      {{ $t("bot.removal.removedBanner") }}
    </div>

    <div class="flex items-center border-b border-border bg-surface/50 px-4 py-1.5 text-xs">
      <TopicManager
        variant="direct"
        :topics="directBotsStore.currentTopics"
        :active-topic-id="directBotsStore.activeTopicId"
        :preview-topic="previewTopic"
        :rename-topic="renameTopic"
        :archive-topic="archiveTopic"
        :restore-topic="restoreTopic"
        :teardown-topic="teardownTopic"
        :clear-topic="clearTopic"
        @select="directBotsStore.switchTopic"
        @create="newTopicDialogOpen = true"
      />
    </div>

    <!-- Error Banner if any general error -->
    <div v-if="directBotsStore.generalErrorCode || directBotsStore.generalError" class="flex items-center justify-between border-b border-danger/20 bg-danger/10 px-4 py-2 text-xs text-danger">
      <span>{{ directBotsStore.generalErrorCode ? $t(`bot.errors.${directBotsStore.generalErrorCode}`) : directBotsStore.generalError }}</span>
      <button type="button" @click="directBotsStore.generalError = null; directBotsStore.generalErrorCode = null">
        <X :size="14" />
      </button>
    </div>

    <!-- Message Area -->
    <ConversationMessageList
      :messages="directBotsStore.messages"
      :live-turn="directBotsStore.liveTurn"
      :active-run="directBotsStore.activeRun"
      :active-member-turn="directBotsStore.activeMemberTurn"
      :run-parts="directBotsStore.completeRunParts"
      :plan-entries="directBotsStore.planEntries"
      :has-more-older="directBotsStore.hasMoreBefore"
      :loading-older="directBotsStore.loadingOlder"
      :loading-history="directBotsStore.loadingHistory"
      :bot="bot"
      :instance-id="directBotsStore.instanceId"
      :load-older="directBotsStore.loadOlder"
      @load-older="directBotsStore.loadOlder"
      @cancel-run="directBotsStore.cancelCurrentRun"
      :pending-interaction="directBotsStore.pendingInteraction"
      @answer="(key: string, value: InteractionValueDto) => directBotsStore.setInteractionAnswer(key, value)"
      @submit-interaction="directBotsStore.submitInteraction('accept')"
      @decline-interaction="directBotsStore.declineInteraction()"
      @cancel-interaction="directBotsStore.cancelInteraction()"
      @dismiss-interaction="directBotsStore.dismissResolvedInteraction()"
    />

    <!-- Prompt Composer -->
    <ConversationPromptInput
      :disabled="bot?.retired === true || !directBotsStore.activeTopicId || !directBotsStore.topicReady || directBotsStore.currentTopic?.status !== 'active'"
      @send="(text) => directBotsStore.sendPrompt(text)"
      @cancel="directBotsStore.cancelCurrentRun"
    />
    <!-- History failure: Retry reloads the topic (history + durable run
      discovery). Shown whenever the transcript failed to converge — the
      composer may still be enabled, but the newest window is stale/holed. -->
    <div v-if="directBotsStore.historyError && directBotsStore.activeTopicId"
         class="flex items-center justify-between border-t border-danger/20 bg-danger/10 px-4 py-2 text-xs text-danger">
      <span>{{ $t(`bot.errors.${directBotsStore.historyError}`) }}</span>
      <button type="button"
              class="rounded bg-danger/20 px-2 py-0.5 font-medium hover:bg-danger/30 transition-colors"
              @click="directBotsStore.instanceId && directBotsStore.activeConversationId && directBotsStore.loadHistory(directBotsStore.instanceId, directBotsStore.activeConversationId, directBotsStore.activeTopicId)">
        {{ $t("bot.prompt.retry") }}
      </button>
    </div>
    <!-- Edit Bot Dialog -->
    <BotDialog
      v-if="editDialogOpen && directBotsStore.instanceId && bot"
      :instance-id="directBotsStore.instanceId"
      :instance-name="instance?.name ?? directBotsStore.instanceId"
      :bot="bot"
      @close="editDialogOpen = false"
    />

    <BotRemovalDialog
      v-if="removalOpen && directBotsStore.instanceId && bot"
      :bot-name="bot.name"
      :preview="() => directBotsStore.previewBotRemoval(directBotsStore.instanceId!, bot!.id)"
      :remove="(input) => directBotsStore.removeBot(directBotsStore.instanceId!, { botId: bot!.id, ...input })"
      :get-operation="(id) => directBotsStore.getLifecycleOperation(directBotsStore.instanceId!, id)"
      @close="removalOpen = false"
      @removed="removalOpen = false"
    />

    <NewTopicDialog
      v-if="newTopicDialogOpen"
      @close="newTopicDialogOpen = false"
    />
  </div>
</template>
