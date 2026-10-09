<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  Bot,
  ChevronDown,
  Folder,
  MessageSquare,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-vue-next";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useGroupsStore } from "../stores/groups";
import { useInstancesStore } from "../stores/instances";
import type { InteractionValueDto } from "@ganglion/xacpx-relay-protocol";
import { confirm } from "../lib/use-confirm";
import AgentIcon from "./AgentIcon.vue";
import ConversationMessageList from "./ConversationMessageList.vue";
import ConversationPromptInput from "./ConversationPromptInput.vue";
import BotDialog from "./BotDialog.vue";
import NewTopicDialog from "./NewTopicDialog.vue";

const emit = defineEmits<{
  navigateBot: [instanceId: string, botId: string];
  navigateGroup: [instanceId: string, groupId: string];
}>();

const { t } = useI18n();
const directBotsStore = useDirectBotsStore();
const groupsStore = useGroupsStore();
const instancesStore = useInstancesStore();
const navOpen = ref(false);

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

const botHasRuntime = computed(() =>
  (bot.value && "hasRuntime" in bot.value && bot.value.hasRuntime) === true,
);

const otherBots = computed(() => {
  const instanceId = directBotsStore.instanceId;
  const currentId = bot.value?.id;
  if (!instanceId || !currentId) return [];
  return (directBotsStore.botsByInstance[instanceId] ?? []).filter((row) => row.id !== currentId);
});

const memberGroups = computed(() => {
  const instanceId = directBotsStore.instanceId;
  const currentId = bot.value?.id;
  if (!instanceId || !currentId) return [];
  return (groupsStore.groupsByInstance[instanceId] ?? []).filter((group) => group.botIds.includes(currentId));
});

function openOtherBot(botId: string): void {
  const instanceId = directBotsStore.instanceId;
  if (!instanceId) return;
  navOpen.value = false;
  emit("navigateBot", instanceId, botId);
}

function openGroup(groupId: string): void {
  const instanceId = directBotsStore.instanceId;
  if (!instanceId) return;
  navOpen.value = false;
  emit("navigateGroup", instanceId, groupId);
}

async function handleDeleteBot(): Promise<void> {
  if (!bot.value || !directBotsStore.instanceId) return;
  // Fail-closed backends reject deleting a used Bot (bot_in_use).
  // Teardown/rebind is a later lifecycle surface, so say so before confirming
  // instead of failing after.
  if (botHasRuntime.value) {
    directBotsStore.generalError = t("bot.lifecycle.deleteBlocked");
    return;
  }
  const confirmed = await confirm({
    title: t("bot.delete.confirmTitle"),
    message: t("bot.delete.confirmMessage", { name: bot.value.name }),
    confirmLabel: t("common.delete"),
    tone: "danger",
  });
  if (!confirmed) return;

  try {
    await directBotsStore.deleteBot(directBotsStore.instanceId, bot.value.id);
  } catch (err: unknown) {
    // A Bot with only a persisted Conversation row (topic created, never run)
    // has hasRuntime=false yet still fails closed backend-side (bot_in_use).
    // Map that code to the explanatory deleteBlocked copy instead of a raw
    // backend message.
    const code = err instanceof Error && "code" in err ? String(err.code ?? "") : "";
    directBotsStore.generalError = code === "bot_in_use"
      ? t("bot.lifecycle.deleteBlocked")
      : err instanceof Error ? err.message : String(err);
  }
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
        <div class="relative">
          <button
            type="button"
            data-test="direct-nav-button"
            class="rounded-lg px-2 py-1 text-xs font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg"
            @click="navOpen = !navOpen"
          >
            {{ $t("bot.nav.talkWith") }}
          </button>
          <div
            v-if="navOpen"
            data-test="direct-nav-menu"
            class="absolute right-0 z-20 mt-1 w-64 overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
          >
            <div class="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-fg-muted">{{ $t("bot.nav.talkWith") }}</div>
            <button
              v-for="other in otherBots"
              :key="other.id"
              type="button"
              data-test="direct-nav-bot"
              class="block w-full truncate px-3 py-1.5 text-left text-xs hover:bg-raised"
              @click="openOtherBot(other.id)"
            >
              {{ other.name }}
            </button>
            <p v-if="otherBots.length === 0" class="px-3 py-1.5 text-xs text-fg-muted">{{ $t("bot.nav.noOtherBot") }}</p>
            <div class="border-t border-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-fg-muted">{{ $t("bot.nav.collaborate") }}</div>
            <button
              v-for="group in memberGroups"
              :key="group.id"
              type="button"
              data-test="direct-nav-group"
              class="block w-full truncate px-3 py-1.5 text-left text-xs hover:bg-raised"
              @click="openGroup(group.id)"
            >
              {{ group.title }}
            </button>
            <p v-if="memberGroups.length === 0" class="px-3 py-1.5 text-xs text-fg-muted">{{ $t("bot.nav.noGroup") }}</p>
          </div>
        </div>
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
          :title="botHasRuntime ? $t('bot.lifecycle.deleteBlocked') : $t('bot.actions.delete')"
          :aria-label="$t('bot.actions.delete')"
          :disabled="botHasRuntime"
          class="grid h-8 w-8 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
          @click="handleDeleteBot"
        >
          <Trash2 :size="14" />
        </button>
      </div>
    </header>

    <!-- Topic Strip -->
    <div class="flex items-center justify-between border-b border-border bg-surface/50 px-4 py-1.5 text-xs">
      <div class="flex items-center gap-1.5 overflow-x-auto thin-scroll min-w-0 flex-1 py-0.5">
        <span class="text-fg-muted shrink-0 flex items-center gap-1 text-[11px] font-medium mr-1">
          <MessageSquare :size="12" />
          <span>{{ $t("bot.topic.label") }}:</span>
        </span>

        <!-- Topic Pills -->
        <button
          v-for="t in directBotsStore.currentTopics"
          :key="t.id"
          type="button"
          data-test="topic-pill"
          class="flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors shrink-0"
          :class="directBotsStore.activeTopicId === t.id
            ? 'bg-accent/15 text-accent font-semibold'
            : 'text-fg-muted hover:bg-raised hover:text-fg'"
          @click="directBotsStore.switchTopic(t.id)"
        >
          <span class="truncate max-w-[140px]">{{ t.title || $t("bot.topic.default") }}</span>
        </button>
      </div>

      <!-- New Topic Button -->
      <button
        type="button"
        data-test="new-topic-button"
        class="ml-2 flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10 transition-colors shrink-0"
        @click="newTopicDialogOpen = true"
      >
        <Plus :size="13" />
        <span>{{ $t("bot.topic.new") }}</span>
      </button>
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
      :disabled="!directBotsStore.activeTopicId || !directBotsStore.topicReady"
      :deliver="(text) => directBotsStore.sendPrompt(text)"
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

    <NewTopicDialog
      v-if="newTopicDialogOpen"
      @close="newTopicDialogOpen = false"
    />
  </div>
</template>
