<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowLeft, MessageSquare, MoreHorizontal, Pencil, Plus, Users, X } from "lucide-vue-next";
import type { BotSummaryDto, PromptAttachmentRef } from "@ganglion/xacpx-relay-protocol";
import { useGroupsStore, type GroupSendOutcome } from "../stores/groups";
import { useDirectBotsStore } from "../stores/direct-bots";
import { supportsGroupTopicIsolation, useInstancesStore } from "../stores/instances";
import GroupTranscript from "./GroupTranscript.vue";
import GroupComposer from "./GroupComposer.vue";
import GroupTopicDialog from "./GroupTopicDialog.vue";
import GroupDialog from "./GroupDialog.vue";
import ConversationWorktreePanel from "./ConversationWorktreePanel.vue";
import TopicSwitcher from "./TopicSwitcher.vue";
import MobileConnStrip from "./MobileConnStrip.vue";
import MobileSheet from "./MobileSheet.vue";
import { useIsMobile } from "../lib/use-dropdown";
import { backInFlight } from "../lib/mobile-back";

const emit = defineEmits<{
  /** Mobile top bar's ←: back to the home list (DashboardView clears the selection). */
  back: [];
}>();

const groupsStore = useGroupsStore();
const directBotsStore = useDirectBotsStore();
const instancesStore = useInstancesStore();
const { t, locale } = useI18n();

const newTopicDialogOpen = ref(false);
const groupDialogOpen = ref(false);
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

const group = computed(() => groupsStore.currentGroup);
/** One TopicSwitcher at a time: the mobile bar's below lg, the desktop header's from lg. */
const isMobile = useIsMobile();
const bots = computed<BotSummaryDto[]>(() => {
  const instId = groupsStore.instanceId;
  if (!instId) return [];
  return directBotsStore.botsByInstance[instId] ?? [];
});
const memberBots = computed<BotSummaryDto[]>(() => {
  const ids = new Set(group.value?.botIds ?? []);
  return bots.value.filter((b) => ids.has(b.id));
});

type MemberStatus =
  | { kind: "none-enabled" }
  | { kind: "some-disabled"; names: string; lead?: string; fallback?: string };
// An unconfirmed catalog would read as "every member disabled", so the
// status waits for it. The fallback comes from the same resolver the
// composer uses to pick the default target.
const memberStatus = computed<MemberStatus | null>(() => {
  const current = group.value;
  if (!current || !groupsStore.botCatalogKnown) return null;
  const disabled = memberBots.value.filter((b) => !b.enabled);
  if (disabled.length === 0) return null;
  const target = groupsStore.eligibleTargetFor(current, bots.value);
  if (target.mode !== "members") return { kind: "none-enabled" };
  return {
    kind: "some-disabled",
    names: new Intl.ListFormat(locale.value, { type: "conjunction" }).format(disabled.map((b) => b.name)),
    lead: disabled.find((b) => b.id === current.leadBotId)?.name,
    fallback: memberBots.value.find((b) => b.id === target.botIds[0])?.name,
  };
});

/**
 * P5 group header total (product §3.1), derived ONLY from data the store
 * already receives (active Run + its member turns). No new RPC route, no
 * task-board page, no activity page: the backend builder in
 * src/conversations/group-overview.ts is the same counting rule, and this
 * strip is its minimal rendering. When there is no active Run, the counts
 * read 0 and the strip reads as "nothing needs you".
 */
const overview = computed(() => {
  const turns = groupsStore.memberTurns;
  const inProgress = turns.filter((turn) => ["queued", "dispatched", "running"].includes(turn.state)).length;
  const stuck = turns.filter((turn) => ["failed", "indeterminate"].includes(turn.state)).length;
  const needsUser = stuck + (groupsStore.activeRun?.state === "waiting-human" ? 1 : 0);
  const latestByBot = new Map<string, (typeof turns)[number]>();
  for (const turn of turns) latestByBot.set(turn.botId, turn);
  const members = memberBots.value.map((bot) => {
    const turn = latestByBot.get(bot.id);
    const state = !turn ? "idle" : turn.state === "completed" ? "done" : turn.state === "dispatched" ? "running" : turn.state;
    return { id: bot.id, name: bot.name, state,
      stateLabel: state === "idle" ? t("group.overview.idle") : t(`group.bubble.status.${state}`),
      task: turn?.task ? turn.task.slice(0, 120) : undefined };
  });
  const finalAnswers = turns
    .filter((turn) => turn.state === "completed" && turn.finalReportVerdict)
    .map((turn) => ({ id: turn.id, botId: turn.botId,
      name: memberBots.value.find((bot) => bot.id === turn.botId)?.name ?? turn.botId,
      verdict: turn.finalReportVerdict === "achieved" ? t("group.bubble.finalVerdict.achieved")
        : turn.finalReportVerdict === "not-achieved" ? t("group.bubble.finalVerdict.notAchieved")
        : t("group.bubble.finalVerdict.interrupted") }));
  return { inProgress, stuck, needsUser, members, finalAnswers,
    leadName: memberBots.value.find((bot) => bot.id === group.value?.leadBotId)?.name };
});

/** Resolves once the current send attempt finishes, so the composer can keep the
 *  draft when the refusal was definitive. */
function sendPromptOutcome(): Promise<GroupSendOutcome> {
  return groupsStore.sendPromptOutcomePromise;
}

function handleSend(text: string, media: PromptAttachmentRef[] = []): void {
  void groupsStore.sendPrompt(text, undefined, media);
}

function handleCancel(): void {
  void groupsStore.cancelCurrentRun();
}

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
      <div class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
        <Users :size="16" />
      </div>
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
         dialog and row menu inside this 44px header. -->
    <header class="hidden lg:flex shrink-0 min-h-11 items-center gap-2.5 bg-surface px-3 lg:px-5 py-1.5">
      <div class="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
        <Users :size="15" />
      </div>
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

    <div v-if="group && groupsStore.activeTopicId" data-test="group-overview"
         class="space-y-0.5 bg-surface px-3 lg:px-5 py-1.5 text-xs text-fg">
      <p data-test="group-overview-head">
        <span v-if="overview.leadName">{{ $t("group.manage.lead") }}：{{ overview.leadName }} · </span>
        <span>{{ $t("group.overview.inProgress", { count: overview.inProgress }) }} · {{ $t("group.overview.stuck", { count: overview.stuck }) }} · {{ $t("group.overview.needsYou", { count: overview.needsUser }) }}</span>
        <span v-if="overview.needsUser === 0"> · {{ $t("group.overview.nothingNeedsYou") }}</span>
      </p>
      <p v-for="member in overview.members" :key="member.id" data-test="group-overview-member">
        {{ member.name }} · {{ member.stateLabel }}<span v-if="member.task"> · {{ member.task }}</span>
      </p>
      <p v-for="answer in overview.finalAnswers" :key="answer.id" data-test="group-overview-final-answer">
        {{ $t("group.overview.finalAnswer", { name: answer.name, verdict: answer.verdict }) }}
      </p>
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
    <GroupTranscript v-else :bots="memberBots" />
    <ConversationWorktreePanel v-if="groupsStore.currentTopic?.executionTarget?.isolation === 'worktree-per-member' && groupsStore.instanceId && worktreeRunId"
      :instance-id="groupsStore.instanceId" :run-id="worktreeRunId" />

    <GroupComposer
      :bots="memberBots"
      :disabled="!groupsStore.activeTopicId || !groupsStore.topicReady || !isActiveTopic"
      :needs-first-topic="needsFirstTopic"
      :instance-id="groupsStore.instanceId"
      :send-outcome="sendPromptOutcome"
      @send="handleSend"
      @cancel="handleCancel"
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

    <!-- Group ⋯ sheet (<lg): the desktop header's edit entry. -->
    <MobileSheet v-if="activeSheet === 'more'" :title='$t("common.more")' test-id="group-more-sheet" @close="closeSheet">
      <button type="button" data-test="sheet-group-edit"
              class="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-fg transition-colors hover:bg-surface-2"
              @click="groupDialogOpen = true; closeSheet()">
        <Pencil :size="18" class="shrink-0 text-fg-muted" />
        <span>{{ $t("group.manage.editTitle") }}</span>
      </button>
    </MobileSheet>
  </div>
</template>
