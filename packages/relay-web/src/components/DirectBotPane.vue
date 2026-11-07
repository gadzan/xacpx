<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  ChevronDown,
  ArrowLeft,
  Folder,
  MessagesSquare,
  Hash,
  MoreHorizontal,
  Pencil,
  Trash2,
  X,
} from "lucide-vue-next";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useGroupsStore } from "../stores/groups";
import {
  supportsBotDedicatedWorkspaceCleanup,
  supportsConversationTimelineV1,
  supportsRoundtableV1,
  useInstancesStore,
} from "../stores/instances";
import type {
  ConversationRunDetailDto,
  ConversationRunDto,
  InteractionValueDto,
  MemberTurnSummaryDto,
} from "@ganglion/xacpx-relay-protocol";
import { MSG, isErrorPayload } from "@ganglion/xacpx-relay-protocol";
import { api } from "../api/client";
import BotAvatar from "./BotAvatar.vue";
import MobileSheet from "./MobileSheet.vue";
import MobileConnStrip from "./MobileConnStrip.vue";
import { avatarHasOpenInteraction, botAvatarState } from "../lib/bot-avatar-state";
import ConversationMessageList from "./ConversationMessageList.vue";
import ConversationTimeline from "./ConversationTimeline.vue";
import ConversationStatusBar from "./ConversationStatusBar.vue";
import ConversationPromptInput from "./ConversationPromptInput.vue";
import ConversationInteractionForm from "./ConversationInteractionForm.vue";
import TraceOverlay from "./TraceOverlay.vue";
import { traceEventsToParts } from "../lib/group-run-presentation";
import { useConversationTimelineFeed } from "../lib/use-timeline-feed";
import { activeSpeakerTurnId, type RoomView, type TimelineLiveTurn } from "../lib/room-view";
import { textBubblesOf } from "../lib/turn-presentation";
import BotDialog from "./BotDialog.vue";
import BotRemovalDialog from "./BotRemovalDialog.vue";
import NewTopicDialog from "./NewTopicDialog.vue";
import TopicSwitcher from "./TopicSwitcher.vue";
import DropdownPanel from "./DropdownPanel.vue";
import { useDropdown, useIsMobile } from "../lib/use-dropdown";
import { backInFlight } from "../lib/mobile-back";
import type { DropdownGroup } from "../lib/use-dropdown";

const emit = defineEmits<{
  navigateBot: [instanceId: string, botId: string];
  navigateGroup: [instanceId: string, groupId: string];
  /** Mobile top bar's ←: back to the home list (DashboardView clears the selection). */
  back: [];
}>();

const directBotsStore = useDirectBotsStore();
const groupsStore = useGroupsStore();
const instancesStore = useInstancesStore();
const { t } = useI18n();

const bot = computed(() => directBotsStore.currentBot);
// One copy set for the empty Bot page: the intro hint follows the composer's
// state (enabled -> "send a message", disabled Bot -> enable it first, loading ->
// no hint while the composer shows the loading placeholder).
const emptyHint = computed<string | null>(() => {
  if (bot.value?.retired) return null;
  if (bot.value && !bot.value.enabled) return t("bot.chat.emptyHintDisabled");
  if (!directBotsStore.topicReady) return null;
  return t("bot.chat.emptyHint");
});
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
/** Execution-process drawer target: live turn or finished history run.
 *  The history path resolves run → member through runsGet. */
const traceTarget = ref<{ run: ConversationRunDto; memberTurn: MemberTurnSummaryDto } | null>(null);
function openTraceOverlay(): void {
  const run = directBotsStore.activeRun;
  const member = directBotsStore.activeMemberTurn;
  if (!run || !member) return;
  directBotsStore.ensureDirectTracePage(run.id, member.id, member.attempt);
  directBotsStore.setDirectTraceFollow(run.id, member.id, member.attempt);
  traceTarget.value = { run, memberTurn: member };
}
async function openTraceForHistoryRun(runId: string): Promise<void> {
  const iId = directBotsStore.instanceId;
  if (!iId) return;
  try {
    const raw = await api.rpc<{ run: ConversationRunDetailDto }>(iId, MSG.runsGet, { runId });
    if (isErrorPayload(raw)) return;
    const res = raw;
    const member = res.run.memberTurns[res.run.memberTurns.length - 1];
    if (!member) return;
    directBotsStore.ensureDirectTracePage(res.run.id, member.id, member.attempt);
    directBotsStore.setDirectTraceFollow(res.run.id, member.id, member.attempt);
    traceTarget.value = { run: res.run, memberTurn: member };
  } catch {
    // History detail unavailable: no drawer, the finished bubble stays.
  }
}
function closeTraceOverlay(): void {
  directBotsStore.clearDirectTraceFollow();
  traceTarget.value = null;
}
const traceRun = computed(() => traceTarget.value?.run ?? null);
const traceMemberTurn = computed(() => traceTarget.value?.memberTurn ?? null);
const tracePage = computed(() => {
  const run = traceRun.value;
  const member = traceMemberTurn.value;
  if (!run || !member) return null;
  const scope = directBotsStore.directTraceScopeKey();
  if (!scope) return null;
  return directBotsStore.directTracePages[directBotsStore.directTracePageKey(scope, run.id, member.id, member.attempt)] ?? null;
});
const traceDecoded = computed(() => traceEventsToParts(tracePage.value?.events ?? []));
const traceParts = computed(() => {
  const decoded = traceDecoded.value;
  if (decoded.parts.length || (tracePage.value?.events.length ?? 0) > 0) return decoded.parts;
  // While the drawer opens mid-stream the durable pages may still be empty:
  // fall back to the live parts so the drawer is never blank.
  return directBotsStore.liveTurn?.parts;
});
// Mobile (<lg) chrome: one 52px bar (avatar + name + topic switcher subtitle + ⋯) plus
// the sheets its ⋯ entries open. The topic switcher is the group chat's TopicSwitcher
// (popover on desktop, its own MobileSheet below lg).
// One bottom sheet at a time (same rule as DashboardView): opening "Talk with" from ⋯
// replaces the ⋯ sheet instead of stacking on it.
type BotSheetId = "more" | "nav";
const activeSheet = ref<BotSheetId | null>(null);
function openSheet(id: BotSheetId): void { activeSheet.value = id; }
function closeSheet(): void { activeSheet.value = null; }

/** One TopicSwitcher at a time: the desktop header's from lg down to… below lg it
 *  stays parked offscreen, because its own sheet has to outlive the ⋯ sheet that
 *  opens it — a switcher rendered INSIDE the ⋯ sheet is unmounted by the very click
 *  that should open its sheet. The ⋯ sheet's topic row clicks this parked trigger. */
const isMobile = useIsMobile();
const mobileTopicHost = ref<HTMLElement | null>(null);
function openMobileTopics(): void {
  closeSheet();
  void nextTick(() => mobileTopicHost.value?.querySelector("button")?.click());
}

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
  return (directBotsStore.botsByInstance[instanceId] ?? [])
    .filter((row) => row.id !== currentId && row.retired !== true);
});

const memberGroups = computed(() => {
  const instanceId = directBotsStore.instanceId;
  const currentId = bot.value?.id;
  if (!instanceId || !currentId) return [];
  return (groupsStore.groupsByInstance[instanceId] ?? []).filter((group) => group.botIds.includes(currentId));
});

const navDd = useDropdown();
const navGroups = computed<DropdownGroup[]>(() => [
  { label: t("bot.nav.talkWith"), rows: otherBots.value.map((other) => ({ value: `bot:${other.id}`, label: other.name, testId: "direct-nav-bot" })) },
  { label: t("bot.nav.collaborate"), rows: memberGroups.value.map((group) => ({ value: `group:${group.id}`, label: group.title, testId: "direct-nav-group" })) },
]);

function openOtherBot(botId: string): void {
  const instanceId = directBotsStore.instanceId;
  if (!instanceId) return;
  navDd.closeMenu();
  closeSheet();
  emit("navigateBot", instanceId, botId);
}

function openGroup(groupId: string): void {
  const instanceId = directBotsStore.instanceId;
  if (!instanceId) return;
  navDd.closeMenu();
  closeSheet();
  emit("navigateGroup", instanceId, groupId);
}

function onNavSelect(value: string): void {
  const [kind, id] = value.split(":") as ["bot" | "group", string];
  if (kind === "bot") openOtherBot(id);
  else openGroup(id);
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

async function abandonUnknownRuns(runIds: string[]): Promise<void> {
  const ctx = requireTopicContext();
  if (!ctx) return;
  for (const runId of runIds) {
    await directBotsStore.abandonRun(ctx.instanceId, runId);
  }
}

const removalOpen = ref(false);

function openRemoval(): void {
  if (!bot.value || bot.value.retired) return;
  removalOpen.value = true;
}

// --- One timeline, one status bar (design §8) -------------------------------
const timelineEnabled = computed(() => supportsConversationTimelineV1(instance.value));

/** Direct is the single-participant Room: same read model, same shell. */
const roomView = computed<RoomView>(() => ({
  kind: "direct",
  instanceId: directBotsStore.instanceId ?? null,
  conversationId: directBotsStore.activeConversationId ?? null,
  topicId: directBotsStore.activeTopicId ?? null,
  participants: bot.value
    ? [{
        botId: bot.value.id,
        name: bot.value.name,
        ...(bot.value.role ? { role: bot.value.role } : {}),
        ...(botDriver.value ? { driver: botDriver.value } : {}),
        ...(bot.value.avatar ? { avatar: bot.value.avatar } : {}),
        enabled: bot.value.enabled,
        ...(bot.value.retired ? { retired: true } : {}),
      }]
    : [],
  run: directBotsStore.activeRun,
  capability: {
    timelineV1: timelineEnabled.value,
    roundtableV1: supportsRoundtableV1(instance.value),
  },
}));

/** The live bubble exists only while the MemberTurn is known: the overlay is
 *  keyed by `memberTurnId`, so a reply can never attach to the wrong turn. */
const liveOverlay = computed<TimelineLiveTurn[]>(() => {
  const live = directBotsStore.liveTurn;
  const member = directBotsStore.activeMemberTurn;
  if (!live || !member) return [];
  return [{
    memberTurnId: member.id,
    botId: member.botId,
    text: textBubblesOf(live.parts).join("\n\n"),
    status: live.status,
    revision: live.revision,
  }];
});

const timelineReloadKey = computed(() => [
  directBotsStore.messages.length,
  directBotsStore.newestSeq ?? 0,
  directBotsStore.activeRun?.id ?? "",
  directBotsStore.activeRun?.state ?? "",
  directBotsStore.activeMemberTurn?.id ?? "",
  directBotsStore.activeMemberTurn?.state ?? "",
].join(":"));

const timelineFeed = useConversationTimelineFeed({
  instanceId: computed(() => directBotsStore.instanceId),
  conversationId: computed(() => directBotsStore.activeConversationId),
  topicId: computed(() => directBotsStore.activeTopicId),
  enabled: timelineEnabled,
  reloadKey: timelineReloadKey,
});

const timelineSpeakerName = computed(() => {
  const id = activeSpeakerTurnId(undefined, directBotsStore.activeMemberTurn ? [directBotsStore.activeMemberTurn] : []);
  return id ? bot.value?.name : undefined;
});

/** A bot row opens the same per-member drawer the legacy transcript opens. */
function openTimelineDetail(payload: { runId?: string; memberTurnId?: string }): void {
  if (payload.runId && payload.runId !== directBotsStore.activeRun?.id) {
    void openTraceForHistoryRun(payload.runId);
    return;
  }
  openTraceOverlay();
}

function handleStopAll(): void {
  void directBotsStore.stopCurrentAndQueued();
}
</script>

<template>
  <div class="relative flex h-full flex-col bg-bg text-fg">
    <!-- Mobile floating identity (<lg), modeled on the reference mock: the
         transcript runs full-height and the identity floats OVER it — back and ⋯ as
         glass discs at the edges, a centered glass pill (name only) with a large
         avatar disc overlapping its top edge; that disc is glass too (glass-disc),
         so avatars without art still read against the scrolling transcript. Content
         scrolls beneath. Zero layout height, so the transcript keeps the whole
         screen. The topic lives in the ⋯ sheet (TopicSwitcher renders its own
         MobileSheet). The transcript never repeats the avatar in front of bubbles
         (TranscriptRow hideIdentityOnMobile). pointer-events-none on the layer,
         auto on the two buttons, so scrolling over the pill still scrolls the
         transcript. Desktop keeps the opaque header below (a backdrop-filtered
         ANCESTOR would trap TopicSwitcher's popover — see that header's comment). -->
    <div class="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-start justify-between px-2 pt-[calc(0.5rem+env(safe-area-inset-top))] lg:hidden">
      <button type="button" data-test="mobile-back" :aria-label='$t("nav.back")' :title='$t("nav.back")' :disabled="backInFlight"
              class="glass-btn pointer-events-auto grid h-11 w-11 place-items-center rounded-full text-fg disabled:opacity-40"
              @click="emit('back')"><ArrowLeft :size="20" /></button>
      <div class="glass-chip absolute left-1/2 top-[calc(0.875rem+env(safe-area-inset-top))] mt-[2.7rem] flex -translate-x-1/2 flex-col items-center rounded-full px-3 py-1.5">
        <span class="glass-disc absolute -top-2 left-1/2 -mt-[2.7rem] grid h-14 w-14 -translate-x-1/2 place-items-center rounded-full">
          <BotAvatar :key="avatarActivityKey" :avatar="bot?.avatar" :driver="botDriver" :name="bot?.name" :size="56"
                     :state="avatarState" :activity-key="avatarActivityKey" :observed-completion="observedCompletion"
                     :disabled="bot ? !bot.enabled : false" :retired="bot?.retired" />
        </span>
        <span class="max-w-36 truncate text-xs font-semibold text-fg">{{ bot?.name ?? $t("bot.nav.title") }}</span>
      </div>
      <button type="button" data-test="mobile-bot-more" :aria-label='$t("common.more")'
              class="glass-btn pointer-events-auto grid h-11 w-11 place-items-center rounded-full text-fg"
              @click="openSheet('more')"><MoreHorizontal :size="20" /></button>
    </div>
    <!-- Parked topic trigger (<lg): see openMobileTopics. Only the TRIGGER moves
         offscreen — its sheet is a sibling, so it must not inherit clip, opacity or
         transform from this host (each of those would hide or re-anchor the sheet). -->
    <div v-if="isMobile" ref="mobileTopicHost" class="parked-topic">
      <TopicSwitcher
        variant="direct"
        :topics="directBotsStore.currentTopics"
        :active-topic-id="directBotsStore.activeTopicId"
        :preview-topic="previewTopic"
        :rename-topic="renameTopic"
        :archive-topic="archiveTopic"
        :restore-topic="restoreTopic"
        :teardown-topic="teardownTopic"
        :clear-topic="clearTopic"
        :abandon-unknown-runs="abandonUnknownRuns"
        @select="directBotsStore.switchTopic"
        @create="newTopicDialogOpen = true"
      />
    </div>
    <MobileConnStrip />

    <!-- Top Header: Bot metadata, topic switcher & actions (desktop only). Opaque on
         purpose (same as GroupPane): a backdrop-filtered ancestor becomes the containing
         block for fixed/absolute descendants and would trap TopicSwitcher's popover,
         confirm dialog and row menu inside this header. -->
    <header data-conversation-header class="hidden lg:flex shrink-0 min-h-11 items-center gap-2.5 bg-surface px-3 lg:px-5 py-1.5">
      <div class="flex items-center gap-3 min-w-0">
        <BotAvatar :key="avatarActivityKey" :avatar="bot?.avatar" :driver="botDriver" :name="bot?.name" :size="32"
                   :state="avatarState" :activity-key="avatarActivityKey" :observed-completion="observedCompletion"
                   :disabled="bot ? !bot.enabled : false" :retired="bot?.retired" />

        <!-- Name, Role & Chips -->
        <div class="flex min-w-0 flex-col">
          <div class="flex items-center gap-2">
            <h2 class="truncate text-sm font-semibold tracking-tight text-fg">{{ bot?.name ?? $t("bot.nav.title") }}</h2>
            <span
              class="h-2 w-2 rounded-full shrink-0"
              :class="bot?.enabled ? 'bg-run' : 'bg-fg-muted'"
              :title="bot?.enabled ? $t('bot.status.enabled') : $t('bot.status.disabled')"
            />
            <span v-if="bot && !bot.enabled" class="text-xs text-fg-muted font-medium">
              ({{ $t("bot.status.disabled") }})
            </span>
          </div>

          <div data-test="bot-header-meta" class="flex items-center gap-2 text-xs text-fg-muted flex-wrap">
            <TopicSwitcher
              v-if="!isMobile"
              variant="direct"
              :topics="directBotsStore.currentTopics"
              :active-topic-id="directBotsStore.activeTopicId"
              :preview-topic="previewTopic"
              :rename-topic="renameTopic"
              :archive-topic="archiveTopic"
              :restore-topic="restoreTopic"
              :teardown-topic="teardownTopic"
              :clear-topic="clearTopic"
              :abandon-unknown-runs="abandonUnknownRuns"
              @select="directBotsStore.switchTopic"
              @create="newTopicDialogOpen = true"
            />
            <span aria-hidden="true">·</span>
            <!-- Role segment and its separator render together, and only for a
                 non-blank role, so a role-less Bot reads "Default · repo · agent". -->
            <template v-if="bot?.role?.trim()">
              <span class="truncate font-medium text-fg/80">{{ bot.role }}</span>
              <span aria-hidden="true">·</span>
            </template>
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
            :ref="(el) => (navDd.trigger = el as HTMLElement | null)"
            data-test="direct-nav-button"
            :aria-haspopup="true"
            :aria-expanded="navDd.open"
            class="flex items-center gap-1 rounded-sm px-1 text-xs transition-colors"
            :class="navDd.open ? 'bg-surface-2 text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'"
            @click="navDd.toggle()"
          >
            {{ $t("bot.nav.talkWith") }}
            <ChevronDown :size="12" class="shrink-0 transition-transform" :class="navDd.open ? 'rotate-180' : ''" />
          </button>
          <DropdownPanel :dd="navDd" width="w-64" placement="bottom-end"
                         :title='$t("bot.nav.talkWith")' test-id="direct-nav-menu" role="menu"
                         :groups="navGroups" @select="onNavSelect" />
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

    <!-- Error Banner if any general error -->
    <div v-if="directBotsStore.generalErrorCode || directBotsStore.generalError" class="flex items-center justify-between bg-danger/10 px-3 lg:px-5 py-2 text-xs text-danger">
      <span>{{ directBotsStore.generalErrorCode ? $t(`bot.errors.${directBotsStore.generalErrorCode}`) : directBotsStore.generalError }}</span>
      <button type="button" @click="directBotsStore.generalError = null; directBotsStore.generalErrorCode = null">
        <X :size="14" />
      </button>
    </div>

    <!-- Message Area -->
    <!-- The floating identity chip costs no layout height, so the transcript
         reserves scroll padding instead: content starts below the chip, then
         scrolls beneath its glass. -->
    <!-- One timeline for Direct and Group. Without `conversations.timeline.v1`
         the legacy transcript is untouched, so an old daemon behaves exactly as
         before. -->
    <ConversationTimeline
      v-if="timelineEnabled"
      :room="roomView"
      :timeline="timelineFeed.timeline.value"
      :live-overlay="liveOverlay"
      :loading="timelineFeed.loading.value"
      :loading-older="timelineFeed.loadingOlder.value"
      :error="timelineFeed.error.value"
      :empty-hint="emptyHint"
      :is-run-queued="directBotsStore.isRunQueued"
      :load-older="timelineFeed.loadOlder"
      top-inset-class="pt-[calc(6rem+env(safe-area-inset-top))] lg:pt-5"
      @open-detail="openTimelineDetail"
    />
    <ConversationMessageList
      v-else
      :messages="directBotsStore.messages"
      top-inset-class="pt-[calc(6rem+env(safe-area-inset-top))] lg:pt-5"
      :empty-hint="emptyHint"
      :live-turn="directBotsStore.liveTurn"
      :active-run="directBotsStore.activeRun"
      :active-member-turn="directBotsStore.activeMemberTurn"
      :is-run-queued="directBotsStore.isRunQueued"
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
      :pending-interaction="directBotsStore.pendingInteraction"
      @answer="(key: string, value: InteractionValueDto) => directBotsStore.setInteractionAnswer(key, value)"
      @submit-interaction="directBotsStore.submitInteraction('accept')"
      @decline-interaction="directBotsStore.declineInteraction()"
      @cancel-interaction="directBotsStore.cancelInteraction()"
      @dismiss-interaction="directBotsStore.dismissResolvedInteraction()"
      @open-trace="openTraceOverlay"
      @open-trace-for-run="openTraceForHistoryRun"
    />
    <TraceOverlay
      v-if="traceTarget"
      id="direct-trace-overlay"
      :run="traceTarget.run"
      :member-turn="traceMemberTurn ?? undefined"
      :member-name="bot?.name"
      :topic-title="directBotsStore.currentTopic?.title"
      :attempt="traceMemberTurn?.attempt"
      :parts="traceParts"
      :recording-state="tracePage?.recordingState"
      :trace-loading="tracePage?.loading"
      :trace-error="tracePage?.error"
      :trace-has-more="tracePage?.hasMore"
      :trace-streaming="!tracePage?.events.length && !!directBotsStore.liveTurn"
      @close="closeTraceOverlay"
      @load-more="traceRun && traceMemberTurn ? directBotsStore.ensureDirectTracePage(traceRun.id, traceMemberTurn.id, traceMemberTurn.attempt) : undefined"
      @retry-trace="traceRun && traceMemberTurn ? directBotsStore.ensureDirectTracePage(traceRun.id, traceMemberTurn.id, traceMemberTurn.attempt) : undefined"
    />

    <!-- A pending human-authority ask stays answerable on the timeline path:
         the form belongs to the turn that asked, so it sits right above the
         composer rather than inside a bubble this shell no longer draws. -->
    <div
      v-if="timelineEnabled && directBotsStore.pendingInteraction"
      class="mx-auto w-full max-w-3xl px-4 lg:px-0"
    >
      <ConversationInteractionForm
        :request="directBotsStore.pendingInteraction.request"
        :answers="directBotsStore.pendingInteraction.answers"
        :submitting="directBotsStore.pendingInteraction.submitting"
        :error-code="directBotsStore.pendingInteraction.errorCode"
        :outcome="directBotsStore.pendingInteraction.outcome"
        @answer="(key: string, value: InteractionValueDto) => directBotsStore.setInteractionAnswer(key, value)"
        @submit="directBotsStore.submitInteraction('accept')"
        @decline="directBotsStore.declineInteraction()"
        @cancel="directBotsStore.cancelInteraction()"
        @dismiss="directBotsStore.dismissResolvedInteraction()"
      />
    </div>

    <ConversationStatusBar
      v-if="timelineEnabled"
      :room="roomView"
      :run="directBotsStore.activeRun"
      :member-turns="directBotsStore.activeMemberTurn ? [directBotsStore.activeMemberTurn] : []"
      :active-speaker-name="timelineSpeakerName"
      :stopping="!!directBotsStore.cancellingRunId"
      @stop-all="handleStopAll"
      @open-detail="openTimelineDetail"
    />

    <!-- Prompt Composer -->
    <ConversationPromptInput
      :disabled="bot?.retired === true || !directBotsStore.topicReady || (!!directBotsStore.activeTopicId && directBotsStore.currentTopic?.status !== 'active')"
      :deliver="directBotsStore.sendPrompt"
    />
    <!-- History failure: Retry reloads the topic (history + durable run
      discovery). Shown whenever the transcript failed to converge — the
      composer may still be enabled, but the newest window is stale/holed. -->
    <div v-if="directBotsStore.historyError && directBotsStore.activeTopicId"
         class="flex items-center justify-between bg-danger/10 px-3 lg:px-5 py-2 text-xs text-danger">
      <span>{{ $t(`bot.errors.${directBotsStore.historyError}`) }}</span>
      <button type="button"
              class="rounded-sm bg-raised text-fg hover:bg-surface-2 px-2 py-0.5 font-medium transition-colors"
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
      :abandon-run="(runId) => directBotsStore.abandonRun(directBotsStore.instanceId!, runId)"
      :supports-workspace-cleanup="supportsBotDedicatedWorkspaceCleanup(instance)"
      @close="removalOpen = false"
      @removed="removalOpen = false"
    />

    <NewTopicDialog
      v-if="newTopicDialogOpen"
      @close="newTopicDialogOpen = false"
    />

    <!-- Bot ⋯ sheet (<lg): the desktop header's nav / edit / delete entries. -->
    <MobileSheet v-if="activeSheet === 'more'" :title='$t("common.more")' test-id="mobile-bot-more-sheet" @close="closeSheet">
      <!-- Topics live here on mobile (the floating header has no subtitle row). The
           row hands off to the parked trigger, so the topic sheet outlives this one. -->
      <button type="button" data-test="sheet-bot-topic"
              class="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-fg transition-colors hover:bg-surface-2"
              @click="openMobileTopics">
        <Hash :size="18" class="shrink-0 text-fg-muted" />
        <span class="min-w-0 flex-1 truncate">{{ $t("mobileBar.switchTopic") }}</span>
        <span class="max-w-32 truncate text-xs text-fg-muted">{{ directBotsStore.currentTopic?.title ?? $t("bot.topic.default") }}</span>
        <ChevronDown :size="14" class="shrink-0 text-fg-muted" />
      </button>
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

  </div>
</template>

<style scoped>
/* Floating glass for the mobile identity (<lg): the back / ⋯ discs, the avatar
   disc and the name pill share one translucent pane. The edge is a foreground
   hairline at 6-8% alpha, not --c-border: at 1px the border token reads as a drawn
   ring on both themes, which is what made the old chip look like outlined plastic
   instead of glass. Depth comes from a top specular gradient plus one wide,
   low-alpha shadow; the previous 30%-white inset highlight drew a second hard
   edge. Scoped to the leaves themselves — a backdrop-filtered ANCESTOR would become
   the containing block for TopicSwitcher's popover and sheets and trap them
   inside this bar. */
.glass-btn,
.glass-disc,
.glass-chip {
  background:
    linear-gradient(180deg, rgb(255 255 255 / 0.55), rgb(255 255 255 / 0) 62%),
    rgb(var(--c-surface) / 0.88);
  -webkit-backdrop-filter: blur(24px) saturate(140%);
  backdrop-filter: blur(24px) saturate(140%);
  border: 1px solid rgb(var(--c-fg) / 0.08);
  --glass-shadow: 0 1px 2px rgb(0 0 0 / 0.04), 0 10px 24px -12px rgb(0 0 0 / 0.20);
  box-shadow: var(--glass-shadow);
}
/* The avatar disc is the one pane with something behind it that must not show
   through: the name pill's hairline crosses under its top half. */
.glass-disc {
  background:
    linear-gradient(180deg, rgb(255 255 255 / 0.55), rgb(255 255 255 / 0) 62%),
    rgb(var(--c-surface) / 0.94);
}
:global(html.dark .glass-btn),
:global(html.dark .glass-disc),
:global(html.dark .glass-chip) {
  background:
    linear-gradient(180deg, rgb(255 255 255 / 0.07), rgb(255 255 255 / 0) 62%),
    rgb(var(--c-raised) / 0.88);
  border-color: rgb(255 255 255 / 0.06);
  --glass-shadow: 0 1px 2px rgb(0 0 0 / 0.32), 0 10px 24px -12px rgb(0 0 0 / 0.55);
}
:global(html.dark .glass-disc) {
  background:
    linear-gradient(180deg, rgb(255 255 255 / 0.07), rgb(255 255 255 / 0) 62%),
    rgb(var(--c-raised) / 0.94);
}
/* Hover keeps the pane translucent: an opaque surface-2 utility would replace the
   glass fill and flash the blur off on tap. */
.glass-btn {
  transition: background-color 140ms ease, transform 140ms ease;
}
.glass-btn:hover { background-color: rgb(var(--c-surface-2) / 0.72); }
.glass-btn:active { transform: scale(0.96); }
@media (prefers-reduced-motion: reduce) {
  .glass-btn { transition: none; }
  .glass-btn:active { transform: none; }
}
/* The pane's box-shadow outranks the global button focus ring, so the indicator
   is drawn as an outline. Re-assert the shadow and the circle: the global
   button:focus-visible rule would otherwise swap in its 6px radius and halo. */
.glass-btn:focus-visible {
  outline: 2px solid rgb(var(--c-accent));
  outline-offset: 2px;
  border-radius: 9999px;
  box-shadow: var(--glass-shadow);
}

/* The parked TopicSwitcher trigger (<lg): out of sight and out of flow, but its
   sheet/dropdown siblings stay in the normal tree (fixed, unclipped). */
.parked-topic {
  position: relative;
  height: 0;
}
/* TopicSwitcher is a multi-root fragment, so Vue cannot stamp this component's
   scope id on its root: only :deep() reaches the trigger pill. */
.parked-topic :deep([data-test="topic-menu"]) {
  position: absolute;
  top: 0;
  left: -9999px;
}
</style>
