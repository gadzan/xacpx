<script setup lang="ts">
import { computed, ref } from "vue";
import {
  ChevronDown,
  Folder,
  Menu,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-vue-next";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useGroupsStore } from "../stores/groups";
import { useInstancesStore } from "../stores/instances";
import type { InteractionValueDto } from "@ganglion/xacpx-relay-protocol";
import BotAvatar from "./BotAvatar.vue";
import MobileSheet from "./MobileSheet.vue";
import MobileConnStrip from "./MobileConnStrip.vue";
import { avatarHasOpenInteraction, botAvatarState } from "../lib/bot-avatar-state";
import ConversationMessageList from "./ConversationMessageList.vue";
import ConversationPromptInput from "./ConversationPromptInput.vue";
import BotDialog from "./BotDialog.vue";
import BotRemovalDialog from "./BotRemovalDialog.vue";
import NewTopicDialog from "./NewTopicDialog.vue";
import TopicManager from "./TopicManager.vue";

const emit = defineEmits<{
  navigateBot: [instanceId: string, botId: string];
  navigateGroup: [instanceId: string, groupId: string];
  /** Mobile top bar's left button: open the instances drawer (owned by DashboardView). */
  openInstances: [];
}>();

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

const avatarState = computed(() => botAvatarState({
  retired: bot.value?.retired,
  online: instance.value?.online,
  runState: directBotsStore.activeRun?.state,
  liveStatus: directBotsStore.liveTurn?.status,
  waiting: avatarHasOpenInteraction(directBotsStore.pendingInteraction, {
    instanceId: directBotsStore.instanceId,
    botId: bot.value?.id,
    run: directBotsStore.activeRun,
    memberTurnId: directBotsStore.activeMemberTurn?.id,
  }),
}));
const avatarActivityKey = computed(() => [
  directBotsStore.instanceId, bot.value?.id, directBotsStore.activeConversationId,
  directBotsStore.activeTopicId, directBotsStore.activeRun?.id,
].join(":"));
const observedCompletion = computed(() => !!directBotsStore.activeRun
  && directBotsStore.liveCompletedRunId === directBotsStore.activeRun.id);

const editDialogOpen = ref(false);
const newTopicDialogOpen = ref(false);
// Mobile (<lg) chrome: one 52px bar (avatar + name + tappable topic subtitle + ⋯) plus
// the sheets its entries open. Desktop keeps the header/topic bar below untouched.
// One bottom sheet at a time (same rule as DashboardView): opening "Talk with" from ⋯
// replaces the ⋯ sheet instead of stacking on it.
type BotSheetId = "more" | "nav" | "topic";
const activeSheet = ref<BotSheetId | null>(null);
function openSheet(id: BotSheetId): void { activeSheet.value = id; }
function closeSheet(): void { activeSheet.value = null; }

/** Bar subtitle: the active topic, falling back to the bot's role, then its agent. */
const botSubtitle = computed(() =>
  directBotsStore.currentTopic?.title || bot.value?.role || bot.value?.agent || "");

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
  closeSheet();
  emit("navigateBot", instanceId, botId);
}

function openGroup(groupId: string): void {
  const instanceId = directBotsStore.instanceId;
  if (!instanceId) return;
  navOpen.value = false;
  closeSheet();
  emit("navigateGroup", instanceId, groupId);
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
    <!-- Mobile single top bar (<lg): avatar + name, topic title as a tappable subtitle
         (opens the topic sheet), and ⋯ for the entries the desktop header carries.
         Desktop keeps the header below. -->
    <div class="flex h-[calc(3.25rem+env(safe-area-inset-top))] shrink-0 items-center gap-1 bg-surface px-2 pt-[env(safe-area-inset-top)] lg:hidden">
      <button type="button" data-test="open-instances" :aria-label='$t("nav.openInstances")'
              class="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              @click="emit('openInstances')"><Menu :size="20" /></button>
      <BotAvatar :key="avatarActivityKey" :avatar="bot?.avatar" :driver="botDriver" :name="bot?.name" :size="32"
                 :state="avatarState" :activity-key="avatarActivityKey" :observed-completion="observedCompletion"
                 :disabled="bot ? !bot.enabled : false" :retired="bot?.retired" />
      <div class="flex min-w-0 flex-1 flex-col">
        <span class="truncate text-base font-semibold text-fg">{{ bot?.name ?? $t("bot.nav.title") }}</span>
        <button type="button" data-test="mobile-topic-switch"
                class="flex min-w-0 items-center gap-1 text-left"
                @click="openSheet('topic')">
          <span class="truncate text-xs text-fg-muted">{{ botSubtitle }}</span>
          <ChevronDown :size="12" class="shrink-0 text-fg-muted" />
        </button>
      </div>
      <button type="button" data-test="mobile-bot-more" :aria-label='$t("common.more")'
              class="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              @click="openSheet('more')"><MoreHorizontal :size="20" /></button>
    </div>
    <MobileConnStrip />

    <!-- Top Header: Bot metadata & Actions (desktop only). -->
    <header class="hidden lg:flex shrink-0 min-h-11 lg:h-11 items-center gap-2.5 bg-surface/60 px-3 lg:px-5 py-1.5 lg:py-0 backdrop-blur-md">
      <div class="flex items-center gap-3 min-w-0">
        <BotAvatar :key="avatarActivityKey" :avatar="bot?.avatar" :driver="botDriver" :name="bot?.name" :size="32"
                   :state="avatarState" :activity-key="avatarActivityKey" :observed-completion="observedCompletion"
                   :disabled="bot ? !bot.enabled : false" :retired="bot?.retired" />

        <!-- Name, Role & Chips -->
        <div class="flex min-w-0 flex-col">
          <div class="flex items-center gap-2">
            <h2 class="truncate text-[14px] font-semibold tracking-tight text-fg">{{ bot?.name ?? $t("bot.nav.title") }}</h2>
            <span
              class="h-2 w-2 rounded-full shrink-0"
              :class="bot?.enabled ? 'bg-run' : 'bg-fg-muted'"
              :title="bot?.enabled ? $t('bot.status.enabled') : $t('bot.status.disabled')"
            />
            <span v-if="bot && !bot.enabled" class="text-[10.5px] text-fg-muted font-medium">
              ({{ $t("bot.status.disabled") }})
            </span>
          </div>

          <div class="flex items-center gap-2 text-[10.5px] text-fg-muted flex-wrap">
            <span v-if="bot?.role" class="truncate font-medium text-fg/80">{{ bot.role }}</span>
            <span v-if="bot?.role">·</span>
            <span class="flex items-center gap-1">
              <Folder :size="10" />
              <span>{{ bot?.workspace }}</span>
            </span>
            <span>·</span>
            <span>{{ bot?.agent }}</span>
            <span v-if="bot?.model">· {{ bot.model }}</span>
          </div>
        </div>
      </div>

      <!-- Actions: Edit, Delete -->
      <div class="ml-auto flex shrink-0 items-center gap-0.5">
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
            class="absolute right-0 z-20 mt-1 w-64 overflow-hidden rounded-2xl bg-raised shadow-float"
          >
            <div class="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-fg-muted">{{ $t("bot.nav.talkWith") }}</div>
            <button
              v-for="other in otherBots"
              :key="other.id"
              type="button"
              data-test="direct-nav-bot"
              class="block w-full truncate px-3 py-1.5 text-left text-xs hover:bg-surface-2"
              @click="openOtherBot(other.id)"
            >
              {{ other.name }}
            </button>
            <p v-if="otherBots.length === 0" class="px-3 py-1.5 text-xs text-fg-muted">{{ $t("bot.nav.noOtherBot") }}</p>
            <div class="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-fg-muted">{{ $t("bot.nav.collaborate") }}</div>
            <button
              v-for="group in memberGroups"
              :key="group.id"
              type="button"
              data-test="direct-nav-group"
              class="block w-full truncate px-3 py-1.5 text-left text-xs hover:bg-surface-2"
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

    <div v-if="bot?.retired" data-test="removed-bot-banner" class="bg-surface/60 px-3 lg:px-5 py-1.5 text-xs text-fg-muted">
      {{ $t("bot.removal.removedBanner") }}
    </div>

    <div class="hidden lg:flex shrink-0 items-center bg-surface/60 px-3 lg:px-5 py-1 text-xs backdrop-blur-md">
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
    <div v-if="directBotsStore.generalErrorCode || directBotsStore.generalError" class="flex items-center justify-between bg-danger/10 px-3 lg:px-5 py-2 text-xs text-danger">
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
      :avatar-state="avatarState"
      :avatar-activity-key="avatarActivityKey"
      :observed-avatar-completion="observedCompletion"
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
      :deliver="(text, mentions) => directBotsStore.sendPrompt(text, mentions)"
      @cancel="directBotsStore.cancelCurrentRun"
    />
    <!-- History failure: Retry reloads the topic (history + durable run
      discovery). Shown whenever the transcript failed to converge — the
      composer may still be enabled, but the newest window is stale/holed. -->
    <div v-if="directBotsStore.historyError && directBotsStore.activeTopicId"
         class="flex items-center justify-between bg-danger/10 px-3 lg:px-5 py-2 text-xs text-danger">
      <span>{{ $t(`bot.errors.${directBotsStore.historyError}`) }}</span>
      <button type="button"
              class="rounded-sm bg-danger/20 px-2 py-0.5 font-medium hover:bg-danger/30 transition-colors"
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

    <!-- Bot ⋯ sheet (<lg): the desktop header's nav / edit / delete entries. -->
    <MobileSheet v-if="activeSheet === 'more'" :title='$t("common.more")' test-id="mobile-bot-more-sheet" @close="closeSheet">
      <button type="button" data-test="sheet-bot-nav"
              class="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-fg transition-colors hover:bg-surface-2"
              @click="openSheet('nav')">
        <MessagesSquare :size="18" class="shrink-0 text-fg-muted" />
        <span>{{ $t("bot.nav.talkWith") }}</span>
      </button>
      <button type="button" data-test="sheet-bot-edit"
              class="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-fg transition-colors hover:bg-surface-2"
              @click="editDialogOpen = true; closeSheet()">
        <Pencil :size="18" class="shrink-0 text-fg-muted" />
        <span>{{ $t("bot.actions.edit") }}</span>
      </button>
      <button type="button" data-test="sheet-bot-delete"
              :disabled="bot?.retired === true"
              :title="bot?.retired ? $t('bot.removal.removed') : $t('bot.removal.action')"
              class="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-danger transition-colors hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
              @click="openRemoval(); closeSheet()">
        <Trash2 :size="18" class="shrink-0" />
        <span>{{ $t("bot.removal.action") }}</span>
      </button>
    </MobileSheet>

    <!-- "Talk with" sheet: the same other-bots + groups lists as the desktop nav menu. -->
    <MobileSheet v-if="activeSheet === 'nav'" :title='$t("bot.nav.talkWith")' test-id="bot-nav-sheet" @close="closeSheet">
      <p class="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">{{ $t("bot.nav.talkWith") }}</p>
      <button v-for="other in otherBots" :key="other.id" type="button" data-test="sheet-bot-option"
              class="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-fg transition-colors hover:bg-surface-2"
              @click="openOtherBot(other.id)">
        <span class="truncate">{{ other.name }}</span>
      </button>
      <p v-if="otherBots.length === 0" class="px-3 py-1.5 text-xs text-fg-muted">{{ $t("bot.nav.noOtherBot") }}</p>
      <p class="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">{{ $t("bot.nav.collaborate") }}</p>
      <button v-for="group in memberGroups" :key="group.id" type="button" data-test="sheet-group-option"
              class="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-fg transition-colors hover:bg-surface-2"
              @click="openGroup(group.id)">
        <span class="truncate">{{ group.title }}</span>
      </button>
      <p v-if="memberGroups.length === 0" class="px-3 py-1.5 text-xs text-fg-muted">{{ $t("bot.nav.noGroup") }}</p>
    </MobileSheet>

    <!-- Topic sheet (<lg): switch topic from the bar subtitle; full management stays on
         desktop in TopicManager. -->
    <MobileSheet v-if="activeSheet === 'topic'" :title='$t("mobileBar.switchTopic")' test-id="bot-topic-sheet" @close="closeSheet">
      <button v-for="topic in directBotsStore.currentTopics" :key="topic.id" type="button" data-test="sheet-topic-option"
              class="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-sm transition-colors"
              :class="topic.id === directBotsStore.activeTopicId ? 'bg-accent-soft text-accent' : 'text-fg hover:bg-surface-2'"
              @click="directBotsStore.switchTopic(topic.id); closeSheet()">
        <MessagesSquare :size="18" class="shrink-0" />
        <span class="truncate">{{ topic.title }}</span>
      </button>
      <button type="button" data-test="sheet-new-topic"
              class="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-accent transition-colors hover:bg-surface-2"
              @click="newTopicDialogOpen = true; closeSheet()">
        <Plus :size="18" class="shrink-0" />
        <span>{{ $t("bot.topic.new") }}</span>
      </button>
    </MobileSheet>
  </div>
</template>
