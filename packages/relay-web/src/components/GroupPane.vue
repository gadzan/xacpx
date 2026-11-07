<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowLeft, MessageSquare, MoreHorizontal, Pencil, Plus, Users, X } from "lucide-vue-next";
import type {
  BotSummaryDto,
  ConversationRunDto,
  ConversationTargetDto,
  MemberTurnSummaryDto,
  PromptAttachmentRef,
} from "@ganglion/xacpx-relay-protocol";
import { useGroupsStore, type GroupSendOutcome } from "../stores/groups";
import { useDirectBotsStore } from "../stores/direct-bots";
import {
  supportsConversationTimelineV1,
  supportsGroupTopicIsolation,
  supportsRoundtableV1,
  useInstancesStore,
} from "../stores/instances";
import GroupTranscript from "./GroupTranscript.vue";
import ConversationTimeline from "./ConversationTimeline.vue";
import ConversationStatusBar from "./ConversationStatusBar.vue";
import TraceOverlay from "./TraceOverlay.vue";
import GroupComposer from "./GroupComposer.vue";
import GroupTopicDialog from "./GroupTopicDialog.vue";
import GroupDialog from "./GroupDialog.vue";
import ConversationWorktreePanel from "./ConversationWorktreePanel.vue";
import TopicSwitcher from "./TopicSwitcher.vue";
import MobileConnStrip from "./MobileConnStrip.vue";
import GroupAvatarStack from "./GroupAvatarStack.vue";
import GroupMemberPanel from "./GroupMemberPanel.vue";
import GroupWorkingRow from "./GroupWorkingRow.vue";
import MobileSheet from "./MobileSheet.vue";
import { useIsMobile } from "../lib/use-dropdown";
import { backInFlight } from "../lib/mobile-back";
import { presentGroupWorkingMembers } from "../lib/group-members";
import { useGroupAvatarActivity } from "../lib/group-avatar-activity";
import { useConversationTimelineFeed } from "../lib/use-timeline-feed";
import {
  activeSpeakerTurnId,
  type RoomView,
  type TimelineLiveTurn,
} from "../lib/room-view";
import { textBubblesOf } from "../lib/turn-presentation";
import { mergeLiveTraceParts, traceEventsToParts } from "../lib/group-run-presentation";

const emit = defineEmits<{
  /** Mobile top bar's ←: back to the home list (DashboardView clears the selection). */
  back: [];
}>();

const groupsStore = useGroupsStore();
const directBotsStore = useDirectBotsStore();
const instancesStore = useInstancesStore();
const { locale } = useI18n();

const newTopicDialogOpen = ref(false);
const groupDialogOpen = ref(false);
const memberPanelOpen = ref(false);
const activeSheet = ref<"more" | null>(null);
function closeSheet(): void { activeSheet.value = null; }
// Zero Topics: the centre "Create first Topic" CTA is the only Topic entry, so
// the header pill (which would read "Default") is not mounted on either layout.
const needsFirstTopic = computed(() =>
  !!groupsStore.activeConversationId
  && groupsStore.topicReady
  && !groupsStore.activeTopicId
  && groupsStore.currentTopics.length === 0,
);

const perMemberGroup = computed(() => groupsStore.currentGroup?.workspaceMode === "per-member");

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

async function setTopicIsolation(topicId: string, isolation: "shared" | "shared-single-writer" | "worktree-per-member") {
  const ctx = requireTopicContext();
  if (!ctx) return;
  await groupsStore.setGroupTopicIsolation(ctx.instanceId, ctx.conversationId, topicId, isolation);
}

// An older core has no set-isolation RPC; offering the switch there would only
// produce an unactionable "unknown-type". Offer it where the instance advertises it.
const isolationSupported = computed(() => {
  const instId = groupsStore.instanceId;
  return instId ? supportsGroupTopicIsolation(instancesStore.byId(instId)) : false;
});

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

async function abandonUnknownRuns(runIds: string[]): Promise<void> {
  const ctx = requireTopicContext();
  if (!ctx) return;
  for (const runId of runIds) {
    await groupsStore.abandonRun(ctx.instanceId, runId);
  }
}

const group = computed(() => groupsStore.currentGroup);
/** One TopicSwitcher at a time: the mobile bar's below lg, the desktop header's from lg. */
const isMobile = useIsMobile();
const bots = computed<BotSummaryDto[]>(() => {
  const instId = groupsStore.instanceId;
  if (!instId) return [];
  return directBotsStore.botsByInstance[instId] ?? [];
});
// The pane renders member names itself, so it loads the catalog for the
// instance it shows. Readiness is the store's own botsLoaded, not a local flag:
// a later refresh from anywhere re-arms the status, and a failed refresh clears
// it, so stale rows can never read as every member disabled.
watch(() => groupsStore.instanceId, (instId) => {
  if (instId) void directBotsStore.loadBots(instId).catch(() => null);
}, { immediate: true });
// Member order follows the group's own botIds: the collage falls back to that
// order for members nobody has heard from yet.
const memberBots = computed<BotSummaryDto[]>(() => {
  const byId = new Map(bots.value.filter((b) => b.retired !== true).map((b) => [b.id, b]));
  return (group.value?.botIds ?? []).flatMap((id) => {
    const bot = byId.get(id);
    return bot ? [bot] : [];
  });
});
const disabledMemberCount = computed(() => memberBots.value.filter((b) => !b.enabled || b.retired).length);
const activityBotIds = useGroupAvatarActivity();

// The members that currently hold a turn. Both inputs are the store's live
// turn state: the active Run's durable member turns, and the live turn map
// that survives a reconnect. Empty when the Group is idle.
const workingMembers = computed(() => presentGroupWorkingMembers({
  memberTurns: groupsStore.memberTurns,
  liveTurnIds: Object.keys(groupsStore.liveTurnsByMember),
  bots: memberBots.value,
}));

type MemberStatus =
  | { kind: "none-enabled" }
  | { kind: "some-disabled"; names: string; lead?: string; fallback?: string };
// An unconfirmed catalog would read as "every member disabled", so the status
// waits for it. The fallback is the first enabled member by stable ID, which is
// display only: routing is the server's rule and the send may still be refused.
const memberStatus = computed<MemberStatus | null>(() => {
  const current = group.value;
  if (!current || !groupsStore.botCatalogKnown) return null;
  const disabled = memberBots.value.filter((b) => !b.enabled);
  if (disabled.length === 0) return null;
  const enabled = memberBots.value.filter((b) => b.enabled);
  if (enabled.length === 0) return { kind: "none-enabled" };
  return {
    kind: "some-disabled",
    names: new Intl.ListFormat(locale.value, { type: "conjunction" }).format(disabled.map((b) => b.name)),
    lead: disabled.find((b) => b.id === current.leadBotId)?.name,
    fallback: [...enabled].sort((a, b) => a.id.localeCompare(b.id))[0]?.name,
  };
});

/** Resolves once the current send attempt finishes, so the composer can keep the
 *  draft when the refusal was definitive. */
function sendPromptOutcome(): Promise<GroupSendOutcome> {
  return groupsStore.sendPromptOutcomePromise;
}

/** `target === null` is the implicit lead: the server resolves it. */
function handleSend(
  text: string,
  media: PromptAttachmentRef[] = [],
  target: ConversationTargetDto | null = null,
): void {
  void groupsStore.sendPromptTo(text, target, media);
}

function handleStopAll(): void {
  void groupsStore.stopCurrentAndQueued();
}

function driverForBot(bot: BotSummaryDto): string | undefined {
  const instId = groupsStore.instanceId;
  if (!instId) return undefined;
  return instancesStore.byId(instId)?.agents.find((agent) => agent.name === bot.agent)?.driver;
}

const instance = computed(() =>
  groupsStore.instanceId ? instancesStore.byId(groupsStore.instanceId) : undefined);
const timelineEnabled = computed(() => supportsConversationTimelineV1(instance.value));

/** One Room for the timeline, status bar and (in P1c) the drawer. Direct is the
 *  single-participant case of the same shape. */
const roomView = computed<RoomView>(() => ({
  kind: "group",
  instanceId: groupsStore.instanceId ?? null,
  conversationId: groupsStore.activeConversationId ?? null,
  topicId: groupsStore.activeTopicId ?? null,
  participants: memberBots.value.map((bot) => ({
    botId: bot.id,
    name: bot.name,
    ...(bot.role ? { role: bot.role } : {}),
    ...(driverForBot(bot) ? { driver: driverForBot(bot) } : {}),
    ...(bot.avatar ? { avatar: bot.avatar } : {}),
    enabled: bot.enabled,
    ...(bot.retired ? { retired: true } : {}),
    ...(group.value?.leadBotId === bot.id ? { lead: true } : {}),
  })),
  ...(group.value?.leadBotId ? { leadBotId: group.value.leadBotId } : {}),
  run: groupsStore.activeRun,
  capability: {
    timelineV1: timelineEnabled.value,
    roundtableV1: supportsRoundtableV1(instance.value),
  },
}));

/** Live text keyed by MemberTurn: coalesced streamed prose only. The durable
 *  message removes the overlay (the timeline dedupes by memberTurnId). */
const liveOverlay = computed<TimelineLiveTurn[]>(() =>
  Object.entries(groupsStore.liveTurnsByMember).map(([memberTurnId, live]) => {
    const member = groupsStore.memberTurns.find((turn) => turn.id === memberTurnId);
    return {
      memberTurnId,
      ...(member?.botId ? { botId: member.botId } : {}),
      text: textBubblesOf(live.parts).join("\n\n"),
      status: live.status === "streaming" ? "streaming" : "working",
      revision: live.revision,
    } satisfies TimelineLiveTurn;
  }));

/** Any store change that can move a durable row (message, Run, member turn,
 *  history detail) refreshes the newest timeline page. */
const timelineReloadKey = computed(() => [
  groupsStore.messages.length,
  groupsStore.newestSeq ?? 0,
  groupsStore.activeRun?.id ?? "",
  groupsStore.activeRun?.state ?? "",
  groupsStore.memberTurns.length,
  groupsStore.runHistoryDetailRevision,
].join(":"));

const timelineFeed = useConversationTimelineFeed({
  instanceId: computed(() => groupsStore.instanceId),
  conversationId: computed(() => groupsStore.activeConversationId),
  topicId: computed(() => groupsStore.activeTopicId),
  enabled: timelineEnabled,
  reloadKey: timelineReloadKey,
});

const activeSpeakerName = computed(() => {
  const id = activeSpeakerTurnId(timelineFeed.activeRound.value, groupsStore.memberTurns);
  const turn = groupsStore.memberTurns.find((member) => member.id === id);
  return turn ? memberBots.value.find((bot) => bot.id === turn.botId)?.name : undefined;
});

// --- Per-member detail drawer (P1c owns the run-wide drawer and the merge) ---
const traceTarget = ref<{ run: ConversationRunDto; memberTurn: MemberTurnSummaryDto } | null>(null);
const traceAttempt = ref<number | undefined>(undefined);
const pendingDetail = ref<{ runId?: string; memberTurnId?: string } | null>(null);

function findRun(runId: string | undefined): ConversationRunDto | undefined {
  if (!runId) return groupsStore.activeRun ?? undefined;
  if (groupsStore.activeRun?.id === runId) return groupsStore.activeRun;
  return Object.values(groupsStore.runHistoryDetails).find((detail) => detail.id === runId);
}

function findMember(runId: string | undefined, memberTurnId: string | undefined): MemberTurnSummaryDto | undefined {
  if (memberTurnId) {
    const active = groupsStore.memberTurns.find((turn) => turn.id === memberTurnId);
    if (active) return active;
  }
  for (const detail of Object.values(groupsStore.runHistoryDetails)) {
    if (runId && detail.id !== runId) continue;
    const hit = memberTurnId
      ? detail.memberTurns.find((turn) => turn.id === memberTurnId)
      : detail.memberTurns[detail.memberTurns.length - 1];
    if (hit) return hit;
  }
  if (!runId || groupsStore.activeRun?.id === runId) {
    return memberTurnId
      ? groupsStore.memberTurns.find((turn) => turn.id === memberTurnId)
      : groupsStore.memberTurns[groupsStore.memberTurns.length - 1];
  }
  return undefined;
}

function openTimelineDetail(payload: { runId?: string; memberTurnId?: string }): void {
  const run = findRun(payload.runId);
  const member = findMember(payload.runId, payload.memberTurnId);
  if (run && member) {
    traceTarget.value = { run, memberTurn: member };
    traceAttempt.value = member.attempt;
    groupsStore.ensureTracePage(member.id, member.attempt);
    return;
  }
  // The Run's durable detail is not cached yet: fetch it and retry once the
  // read model lands (the trace drawer needs a real Run, never a guess).
  if (payload.runId) {
    pendingDetail.value = payload;
    groupsStore.ensureRunDetails([payload.runId]);
  }
}

watch(() => groupsStore.runHistoryDetailRevision, () => {
  const pending = pendingDetail.value;
  if (!pending) return;
  pendingDetail.value = null;
  openTimelineDetail(pending);
});

function closeTimelineDetail(): void {
  traceTarget.value = null;
  traceAttempt.value = undefined;
}

const tracePage = computed(() => {
  const target = traceTarget.value;
  const attempt = traceAttempt.value;
  if (!target || attempt === undefined) return null;
  const scope = [groupsStore.instanceId, groupsStore.activeConversationId, groupsStore.activeTopicId].join(":");
  return groupsStore.tracePages[`${scope}:${target.memberTurn.id}:${attempt}`] ?? null;
});

const traceParts = computed(() => {
  const target = traceTarget.value;
  if (!target) return undefined;
  const replay = tracePage.value ? traceEventsToParts(tracePage.value.events).parts : undefined;
  const live = traceAttempt.value === target.memberTurn.attempt
    ? groupsStore.liveTurnForMember(target.memberTurn.id)?.parts
    : undefined;
  return mergeLiveTraceParts(replay, live);
});


/** Durable Run details for the Runs the timeline shows: the process drawer and
 *  member names need them, and the legacy transcript loaded them the same way.
 *  Bounded by the loaded page, so history stays one batch. */
const timelineRunIds = computed<string[]>(() => {
  const ids = new Set<string>();
  for (const entry of timelineFeed.entries.value) {
    if (entry.runId) ids.add(entry.runId);
  }
  return [...ids];
});

watch(timelineRunIds, (ids) => {
  if (ids.length > 0) groupsStore.ensureRunDetails(ids);
}, { immediate: true });
// An archived Topic stays browsable (its transcript is durable history), but it
// cannot accept new Runs — sending there is a guaranteed `topic_not_active`.
const isActiveTopic = computed(() => groupsStore.currentTopic?.status === "active");
const worktreeRunId = computed(() => {
  const run = groupsStore.activeRun;
  if (run?.topicId === groupsStore.activeTopicId) return run.id;
  // After reconnect there may be no active owner: integration belongs to the
  // latest durable result, even when that Run is already terminal.
  return [...groupsStore.messages].reverse().find(m => m.topicId === groupsStore.activeTopicId && m.runId)?.runId;
});
</script>

<template>
  <div class="flex h-full flex-col bg-bg text-fg">
    <!-- Mobile single top bar (<lg): group tile + title, the topic as a tappable subtitle
         (opens the topic sheet), and ⋯ for the desktop header's edit entry. The topic
         popover / confirm dialog live in TopicSwitcher, which stays clear of any
         backdrop-filtered ancestor (see the desktop header below). -->
    <div class="flex h-[calc(3.25rem+env(safe-area-inset-top))] shrink-0 items-center gap-1 bg-surface px-2 pt-[env(safe-area-inset-top)] lg:hidden">
      <button type="button" data-test="mobile-back" :aria-label='$t("nav.back")' :title='$t("nav.back")' :disabled="backInFlight"
              class="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
              @click="emit('back')"><ArrowLeft :size="20" /></button>
      <!-- The collage opens the member panel: it is the Group's membership at a
           glance, and the panel is the full list behind it. -->
      <button type="button" data-test="group-avatar-button" :aria-label="$t('group.panel.title')" :title="$t('group.panel.title')"
              class="grid h-11 w-11 shrink-0 place-items-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              @click="memberPanelOpen = true">
        <GroupAvatarStack :bots="memberBots" :instance-id="groupsStore.instanceId" :size="32" :name="group?.title ?? $t('group.nav.title')"
                          :total-count="group?.botIds.length ?? 0" :disabled-count="disabledMemberCount"
                          :lead-bot-id="group?.leadBotId" :activity-bot-ids="activityBotIds"
                          style="--avatar-ring: rgb(var(--c-surface))" />
      </button>
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex min-w-0 items-center gap-2"><span class="truncate text-sm font-semibold text-fg">{{ group?.title ?? $t("group.nav.title") }}</span></div>
        <TopicSwitcher
          v-if="isMobile && !needsFirstTopic"
          :topics="groupsStore.currentTopics"
          :active-topic-id="groupsStore.activeTopicId"
          :preview-topic="previewTopic"
          :rename-topic="renameTopic"
          :archive-topic="archiveTopic"
          :restore-topic="restoreTopic"
          :teardown-topic="teardownTopic"
          :clear-topic="clearTopic"
          :set-topic-isolation="isolationSupported ? setTopicIsolation : undefined"
          :abandon-unknown-runs="abandonUnknownRuns"
          @select="groupsStore.switchTopic"
          @create="newTopicDialogOpen = true"
        />
      </div>
      <button type="button" data-test="mobile-group-more" :aria-label='$t("common.more")'
              class="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              @click="activeSheet = 'more'"><MoreHorizontal :size="20" /></button>
    </div>
    <MobileConnStrip />

    <!-- Opaque on purpose: a backdrop-filtered ancestor becomes the containing block for
         fixed/absolute descendants, which would trap TopicSwitcher's popover, confirm
         dialog and row menu inside this header. -->
    <header data-conversation-header class="hidden lg:flex shrink-0 min-h-14 items-center gap-2.5 bg-surface px-3 lg:px-5 py-1.5">
      <!-- The desktop collage opens the same member panel as the mobile one. -->
      <button type="button" data-test="group-desktop-avatar-button" :aria-label="$t('group.panel.title')" :title="$t('group.panel.title')"
              class="grid h-11 w-11 shrink-0 place-items-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              @click="memberPanelOpen = true">
        <GroupAvatarStack :bots="memberBots" :instance-id="groupsStore.instanceId" :size="44" :name="group?.title ?? $t('group.nav.title')"
                          :total-count="group?.botIds.length ?? 0" :disabled-count="disabledMemberCount"
                          :lead-bot-id="group?.leadBotId" :activity-bot-ids="activityBotIds"
                          style="--avatar-ring: rgb(var(--c-surface))" />
      </button>
      <div class="flex min-w-0 flex-col">
        <div class="flex min-w-0 items-center gap-2"><h2 class="truncate text-sm font-semibold tracking-tight text-fg">{{ group?.title ?? $t("group.nav.title") }}</h2></div>
        <div class="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
          <TopicSwitcher
            v-if="!isMobile && !needsFirstTopic"
            :topics="groupsStore.currentTopics"
            :active-topic-id="groupsStore.activeTopicId"
            :preview-topic="previewTopic"
            :rename-topic="renameTopic"
            :archive-topic="archiveTopic"
            :restore-topic="restoreTopic"
            :teardown-topic="teardownTopic"
            :clear-topic="clearTopic"
            :set-topic-isolation="isolationSupported ? setTopicIsolation : undefined"
            :abandon-unknown-runs="abandonUnknownRuns"
            @select="groupsStore.switchTopic"
            @create="newTopicDialogOpen = true"
          />
          <span v-if="!needsFirstTopic" aria-hidden="true">·</span>
          <span data-test="group-pane-member-count" class="shrink-0 whitespace-nowrap">{{ $t("group.header.members", group?.botIds.length ?? 0) }}</span>
          <span v-if="group?.lifecycle === 'deleting'"
                data-test="group-pane-deleting-badge"
                class="shrink-0 rounded-sm bg-warn/15 px-1.5 py-px text-xs font-medium text-warn">
            {{ $t("group.list.deleting") }}
          </span>
        </div>
      </div>
      <button
        v-if="group && groupsStore.instanceId"
        type="button"
        data-test="group-edit-button"
        :title="$t('group.manage.editTitle')"
        :aria-label="$t('group.manage.editTitle')"
        class="ml-auto grid h-10 w-10 lg:h-7 lg:w-7 shrink-0 place-items-center rounded-sm text-fg-muted transition-colors hover:bg-raised hover:text-fg"
        @click="groupDialogOpen = true"
      >
        <Pencil :size="14" />
      </button>
    </header>

    <!-- "Who is working" is the legacy surface: the timeline path shows the same
         fact in the status bar and per-row activity instead. -->
    <GroupWorkingRow v-if="!timelineEnabled" :members="workingMembers" />

    <div v-if="groupsStore.generalErrorCode || groupsStore.generalError" class="flex items-center justify-between bg-danger/10 px-3 lg:px-5 py-2 text-xs text-danger">
      <span>{{ groupsStore.generalErrorCode ? $t(`bot.errors.${groupsStore.generalErrorCode}`) : groupsStore.generalError }}</span>
      <button type="button" @click="groupsStore.generalError = null; groupsStore.generalErrorCode = null">
        <X :size="14" />
      </button>
    </div>

    <div v-if="memberStatus" data-test="group-member-status"
         class="space-y-0.5 bg-warn/10 px-3 lg:px-5 py-1.5 text-xs text-fg">
      <p v-if="memberStatus.kind === 'none-enabled'">{{ $t("group.members.noneEnabled") }}</p>
      <template v-else>
        <p data-test="group-disabled-members">{{ $t("group.members.disabled", { names: memberStatus.names }) }}</p>
        <p v-if="memberStatus.lead && memberStatus.fallback" data-test="group-lead-disabled">
          {{ $t("group.members.leadDisabled", { lead: memberStatus.lead, fallback: memberStatus.fallback }) }}
        </p>
      </template>
    </div>

    <div v-if="needsFirstTopic"
         data-test="group-first-topic"
         class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <MessageSquare :size="22" class="text-fg-muted" />
      <p class="text-sm font-semibold">{{ $t("group.firstTopic.title") }}</p>
      <p class="max-w-sm text-xs text-fg-muted">{{ $t(perMemberGroup ? "group.firstTopic.hintPerMember" : "group.firstTopic.hint") }}</p>
      <button
        type="button"
        data-test="group-first-topic-button"
        class="mt-1 flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:opacity-90"
        @click="newTopicDialogOpen = true"
      >
        <Plus :size="13" />
        <span>{{ $t("group.firstTopic.action") }}</span>
      </button>
    </div>
    <!-- One timeline for Group and Direct. An old daemon without
         `conversations.timeline.v1` keeps the legacy transcript untouched. -->
    <ConversationTimeline
      v-if="timelineEnabled && !needsFirstTopic"
      :room="roomView"
      :timeline="timelineFeed.timeline.value"
      :live-overlay="liveOverlay"
      :loading="timelineFeed.loading.value"
      :loading-older="timelineFeed.loadingOlder.value"
      :error="timelineFeed.error.value"
      :load-older="timelineFeed.loadOlder"
      @open-detail="openTimelineDetail"
    />
    <GroupTranscript v-else-if="!timelineEnabled" :bots="memberBots" :lead-bot-id="group?.leadBotId" :activity-bot-ids="activityBotIds" />
    <ConversationWorktreePanel v-if="groupsStore.currentTopic?.executionTarget?.isolation === 'worktree-per-member' && groupsStore.instanceId && worktreeRunId"
      :instance-id="groupsStore.instanceId" :run-id="worktreeRunId" />

    <ConversationStatusBar
      v-if="timelineEnabled && !needsFirstTopic"
      :room="roomView"
      :run="groupsStore.activeRun"
      :member-turns="groupsStore.memberTurns"
      :round="timelineFeed.activeRound.value"
      :active-speaker-name="activeSpeakerName"
      :stopping="!!groupsStore.cancellingRunId"
      @stop-all="handleStopAll"
      @open-detail="openTimelineDetail"
    />
    <GroupComposer
      :bots="memberBots"
      :disabled="!groupsStore.activeTopicId || !groupsStore.topicReady || !isActiveTopic"
      :needs-first-topic="needsFirstTopic"
      :instance-id="groupsStore.instanceId"
      :send-outcome="sendPromptOutcome"
      :hide-stop="timelineEnabled"
      @send="handleSend"
    />
    <div v-if="groupsStore.historyError && groupsStore.activeTopicId"
         class="flex items-center justify-between bg-danger/10 px-3 lg:px-5 py-2 text-xs text-danger">
      <span>{{ groupsStore.historyErrorDetail ?? groupsStore.historyError }}</span>
      <button type="button"
              class="rounded-sm bg-raised text-fg hover:bg-surface-2 px-2 py-0.5 font-medium transition-colors"
              @click="groupsStore.instanceId && groupsStore.activeConversationId && groupsStore.loadHistory(groupsStore.instanceId, groupsStore.activeConversationId, groupsStore.activeTopicId)">
        {{ $t("bot.prompt.retry") }}
      </button>
    </div>

    <GroupTopicDialog
      v-if="newTopicDialogOpen"
      @close="newTopicDialogOpen = false"
    />
    <GroupDialog
      v-if="groupDialogOpen && group && groupsStore.instanceId"
      :instance-id="groupsStore.instanceId"
      :group="group"
      @close="groupDialogOpen = false"
    />
    <GroupMemberPanel v-if="memberPanelOpen" @close="memberPanelOpen = false" />

    <!-- Group ⋯ sheet (<lg): the desktop header's edit entry. -->
    <MobileSheet v-if="activeSheet === 'more'" :title='$t("common.more")' test-id="group-more-sheet" @close="closeSheet">
      <!-- The member panel: the second entry point (the top bar's ⋯ menu). -->
      <button type="button" data-test="sheet-group-members"
              class="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-fg transition-colors hover:bg-surface-2"
              @click="memberPanelOpen = true; closeSheet()">
        <Users :size="18" class="shrink-0 text-fg-muted" />
        <span>{{ $t("group.panel.title") }}</span>
      </button>
      <button type="button" data-test="sheet-group-edit"
              class="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-fg transition-colors hover:bg-surface-2"
              @click="groupDialogOpen = true; closeSheet()">
        <Pencil :size="18" class="shrink-0 text-fg-muted" />
        <span>{{ $t("group.manage.editTitle") }}</span>
      </button>
    </MobileSheet>

    <!-- Per-member process drawer: the same TraceOverlay the legacy transcript
         mounts. P1c owns the run-wide drawer and the legacy deletion. -->
    <TraceOverlay
      v-if="traceTarget"
      id="group-timeline-trace-overlay"
      :run="traceTarget.run"
      :member-turn="traceTarget.memberTurn"
      :member-name="memberBots.find((bot) => bot.id === traceTarget?.memberTurn.botId)?.name"
      :topic-title="groupsStore.currentTopic?.title"
      :attempt="traceAttempt"
      :parts="traceParts"
      :recording-state="tracePage?.recordingState"
      :plan="tracePage?.plan"
      :trace-loading="tracePage?.loading"
      :trace-error="tracePage?.error"
      :trace-has-more="tracePage?.hasMore"
      :trace-has-earlier="tracePage?.hasEarlier"
      :trace-streaming="!tracePage?.events.length && !!groupsStore.liveTurnForMember(traceTarget.memberTurn.id)"
      @close="closeTimelineDetail"
      @load-more="traceTarget && groupsStore.ensureTracePage(traceTarget.memberTurn.id, traceAttempt ?? traceTarget.memberTurn.attempt)"
      @load-earlier="traceTarget && groupsStore.ensureTracePage(traceTarget.memberTurn.id, traceAttempt ?? traceTarget.memberTurn.attempt, 0)"
      @retry-trace="traceTarget && groupsStore.ensureTracePage(traceTarget.memberTurn.id, traceAttempt ?? traceTarget.memberTurn.attempt)"
    />
  </div>
</template>
