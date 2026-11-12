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
  InteractionValueDto,
  TopicSummaryDto,
} from "@ganglion/xacpx-relay-protocol";
import { isTerminalRunState, useGroupsStore, type GroupSendOutcome } from "../stores/groups";
import { useDirectBotsStore } from "../stores/direct-bots";
import {
  supportsConversationTimelineV1,
  supportsGroupTopicFork,
  supportsGroupTopicForkMessage,
  supportsGroupTopicIsolation,
  supportsRunsCancelMember,
  useInstancesStore,
} from "../stores/instances";
import ConversationTimeline from "./ConversationTimeline.vue";
import ConversationStatusBar from "./ConversationStatusBar.vue";
import TraceOverlay from "./TraceOverlay.vue";
import GroupComposer from "./GroupComposer.vue";
import GroupTopicDialog from "./GroupTopicDialog.vue";
import ForkTopicDialog, { type ForkTopicRequest } from "./ForkTopicDialog.vue";
import GroupDialog from "./GroupDialog.vue";
import ConversationWorktreePanel from "./ConversationWorktreePanel.vue";
import TopicSwitcher from "./TopicSwitcher.vue";
import MobileConnStrip from "./MobileConnStrip.vue";
import GroupAvatarStack from "./GroupAvatarStack.vue";
import GroupMemberPanel from "./GroupMemberPanel.vue";
import MobileSheet from "./MobileSheet.vue";
import { useIsMobile } from "../lib/use-dropdown";
import { backInFlight } from "../lib/mobile-back";
import { useGroupAvatarActivity } from "../lib/group-avatar-activity";
import { useConversationTimelineFeed } from "../lib/use-timeline-feed";
import {
  activeSpeakerTurnId,
  type RoomView,
  type TimelineLiveTurn,
} from "../lib/room-view";
import { textBubblesOf } from "../lib/turn-presentation";
import { mergeLiveTraceParts, traceEventsToParts } from "../lib/group-run-presentation";
import { compareMemberTurns, runBudgetOf } from "../lib/run-detail";
import { pushToast } from "../lib/use-toasts";

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
const forkSupported = computed(() => {
  const instId = groupsStore.instanceId;
  return instId ? supportsGroupTopicFork(instancesStore.byId(instId)) : false;
});
/**
 * The per-row entry additionally requires the message capability: under a new
 * web / old connector or core skew the validator would reject the shape with
 * `invalid-payload`, so the row control hides while the Topic-menu and
 * run-level entries keep working on the base capability.
 */
const forkMessageSupported = computed(() => {
  const instId = groupsStore.instanceId;
  return instId ? supportsGroupTopicForkMessage(instancesStore.byId(instId)) : false;
});

interface ForkDialogTarget {
  topic: TopicSummaryDto;
  sourcePoint:
    | { type: "latest_stable" }
    | { type: "run"; runId: string }
    | { type: "message"; messageId: string };
  resolvedRun?: ConversationRunDto;
}

const forkTarget = ref<ForkDialogTarget | null>(null);

/** Newest terminal Run the client already knows about for this Topic: label
 *  only. An empty cache means the dialog says "latest finished run". */
function newestCachedTerminalRun(topicId: string): ConversationRunDto | undefined {
  const cached = [
    ...Object.values(groupsStore.runHistoryDetails).filter((run) => run.topicId === topicId),
    ...(groupsStore.activeRun?.topicId === topicId ? [groupsStore.activeRun] : []),
  ].filter((run) => isTerminalRunState(run.state));
  return cached.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))[0];
}

function openForkFromTopic(topic: TopicSummaryDto): void {
  if (!forkSupported.value) return;
  const resolvedRun = newestCachedTerminalRun(topic.id);
  forkTarget.value = {
    topic,
    sourcePoint: { type: "latest_stable" },
    ...(resolvedRun ? { resolvedRun } : {}),
  };
}

function openForkFromRun(run: ConversationRunDto): void {
  const topic = groupsStore.currentTopics.find((candidate) => candidate.id === run.topicId);
  if (!topic || !forkSupported.value || !isTerminalRunState(run.state)) return;
  // The dialog is a separate modal: retire the drawer/sheet first so the two
  // never stack and the dialog's submit is the topmost hit target.
  closeTimelineDetail();
  forkTarget.value = { topic, sourcePoint: { type: "run", runId: run.id }, resolvedRun: run };
}

/**
 * Fork at one visible message row (design §5.2). The row hands over its id;
 * the pane proves the row is in the Topic currently on screen, so the control
 * never offers a boundary the core would refuse as cross-Topic.
 */
function openForkFromMessage(messageId: string): void {
  const topic = groupsStore.currentTopic;
  if (!topic || !forkMessageSupported.value) return;
  const entry = (timelineFeed.timeline.value?.entries ?? [])
    .find((candidate) => candidate.kind === "message" && candidate.message.id === messageId);
  if (!entry || entry.kind !== "message" || entry.message.topicId !== topic.id) return;
  forkTarget.value = { topic, sourcePoint: { type: "message", messageId } };
}

const detailRunForkable = computed(() =>
  forkSupported.value && !!detailRun.value && isTerminalRunState(detailRun.value.state));

const forkSourceAvailable = computed(() => {
  const sourceTopicId = groupsStore.currentTopic?.forkedFrom?.sourceTopicId;
  return !!sourceTopicId && groupsStore.currentTopics.some((topic) => topic.id === sourceTopicId);
});

function openForkSourceTopic(): void {
  const sourceTopicId = groupsStore.currentTopic?.forkedFrom?.sourceTopicId;
  if (sourceTopicId && groupsStore.currentTopics.some((topic) => topic.id === sourceTopicId)) {
    void groupsStore.switchTopic(sourceTopicId);
  }
}


/** The dialog's one call: the pane owns the instance and the store, so the
 *  dialog itself has no store dependency and both panes can share it. */
async function forkGroupTopicFromDialog(input: ForkTopicRequest): Promise<TopicSummaryDto> {
  const instanceId = groupsStore.instanceId;
  if (!instanceId) throw new Error("no active instance");
  return groupsStore.forkGroupTopic(instanceId, input);
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
  if (!instId) return;
  void directBotsStore.loadBots(instId).catch(() => null);
  // Mention resolution needs each member's agent + workspace to prove it is
  // runnable: an empty catalog would mark every member "No runtime" and turn a
  // valid `@Name` into an unresolved mention. A fresh login has neither list
  // (only the session list pulls agents), so load them here and reuse whatever
  // the instance already carries. Failures degrade to the previous behaviour.
  const instance = instancesStore.byId(instId);
  if (!instance?.agents.length || !instance.workspaces.length) {
    void instancesStore.loadFormOptions(instId).catch(() => null);
  }
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
/** The timeline is the only conversation surface. A daemon that does not
 *  advertise it cannot be served by this client at all: the pane says so once
 *  and disables its write controls. */
const timelineSupported = computed(() => supportsConversationTimelineV1(instance.value));

/** One Room for the timeline (P1c adds the run-wide drawer). Direct is the
 *  single-participant case of the same shape. */
const roomView = computed<RoomView>(() => ({
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
  })),
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
  enabled: timelineSupported,
  reloadKey: timelineReloadKey,
});

const activeSpeakerName = computed(() => {
  const id = activeSpeakerTurnId(timelineFeed.activeRound.value, groupsStore.memberTurns);
  const turn = groupsStore.memberTurns.find((member) => member.id === id);
  return turn ? memberBots.value.find((bot) => bot.id === turn.botId)?.name : undefined;
});

// --- One Run-wide detail drawer (design §8.4) ------------------------------
interface TimelineDetailTarget { runId: string; memberTurnId?: string }

const detailTarget = ref<TimelineDetailTarget | null>(null);
const detailAttempt = ref<number | undefined>(undefined);
const pendingDetail = ref<TimelineDetailTarget | null>(null);
/** A Run the read model proved absent for this scope: the drawer cannot open,
 *  and only an explicit Retry clears the store's negative cache for it. The
 *  clicked member rides along so Retry reopens the same trace. */
const unavailable = ref<{ runId: string; memberTurnId?: string } | null>(null);
const stopPendingMember = ref<string | null>(null);

function findRun(runId: string | undefined): ConversationRunDto | undefined {
  if (!runId) return groupsStore.activeRun ?? undefined;
  if (groupsStore.activeRun?.id === runId) return groupsStore.activeRun;
  return Object.values(groupsStore.runHistoryDetails).find((detail) => detail.id === runId);
}

/** Every durable member turn of one Run, active rows winning over a cached
 *  history snapshot for the same id. */
function membersOfRun(runId: string): MemberTurnSummaryDto[] {
  const byId = new Map<string, MemberTurnSummaryDto>();
  for (const detail of Object.values(groupsStore.runHistoryDetails)) {
    if (detail.id !== runId) continue;
    for (const turn of detail.memberTurns) byId.set(turn.id, turn);
  }
  if (groupsStore.activeRun?.id === runId) {
    for (const turn of groupsStore.memberTurns) {
      if (turn.runId === runId) byId.set(turn.id, turn);
    }
  }
  return [...byId.values()].sort(compareMemberTurns);
}

const detailRun = computed(() => detailTarget.value ? findRun(detailTarget.value.runId) : undefined);
const detailMembers = computed(() => detailTarget.value ? membersOfRun(detailTarget.value.runId) : []);
const detailSelectedMember = computed(() => {
  const target = detailTarget.value;
  if (!target) return undefined;
  return detailMembers.value.find((member) => member.id === target.memberTurnId)
    ?? detailMembers.value.find((member) => member.state === "running" || member.state === "dispatched")
    ?? detailMembers.value[detailMembers.value.length - 1];
});
const detailEffectiveAttempt = computed(() =>
  detailAttempt.value ?? detailSelectedMember.value?.attempt);

/** Reachable from bot meta, avatar, speaker label and the status bar: one key,
 *  one drawer, one process. */
function openTimelineDetail(payload: { runId?: string; memberTurnId?: string }): void {
  // Any successful open retires the previous Run's banner: the notice must not
  // outlive the failure that raised it.
  unavailable.value = null;
  const run = findRun(payload.runId);
  if (!run) {
    // The Run's durable detail is not cached yet: fetch it and retry once the
    // read model lands (the drawer needs a real Run, never a guess). A Run the
    // batch already reported missing shows the inline error instead.
    if (payload.runId) {
      if (groupsStore.isRunDetailMissing(payload.runId)) {
        pendingDetail.value = null;
        unavailable.value = { runId: payload.runId, ...(payload.memberTurnId ? { memberTurnId: payload.memberTurnId } : {}) };
        return;
      }
      pendingDetail.value = { runId: payload.runId, ...(payload.memberTurnId ? { memberTurnId: payload.memberTurnId } : {}) };
      groupsStore.ensureRunDetails([payload.runId]);
    }
    return;
  }
  const members = membersOfRun(run.id);
  const selected = members.find((member) => member.id === payload.memberTurnId)
    ?? members.find((member) => member.state === "running" || member.state === "dispatched")
    ?? members[members.length - 1];
  detailTarget.value = { runId: run.id, ...(selected ? { memberTurnId: selected.id } : {}) };
  detailAttempt.value = selected?.attempt;
  groupsStore.ensureRunDetails([run.id]);
  if (selected) {
    groupsStore.ensureTracePage(selected.id, selected.attempt);
    armTraceFollow(selected.id, selected.attempt);
  }
}

watch(() => groupsStore.runHistoryDetailRevision, () => {
  const pending = pendingDetail.value;
  if (!pending) return;
  if (groupsStore.isRunDetailMissing(pending.runId)) {
    pendingDetail.value = null;
    unavailable.value = { runId: pending.runId, ...(pending.memberTurnId ? { memberTurnId: pending.memberTurnId } : {}) };
    return;
  }
  pendingDetail.value = null;
  openTimelineDetail(pending);
});

/** Retry clears exactly this Run's negative entry and re-arms the open on the
 *  member that was clicked: the batch read either lands (drawer opens) or
 *  reports it missing again. */
function retryTimelineDetail(): void {
  const target = unavailable.value;
  if (!target) return;
  unavailable.value = null;
  groupsStore.retryRunDetail(target.runId);
  pendingDetail.value = { runId: target.runId, ...(target.memberTurnId ? { memberTurnId: target.memberTurnId } : {}) };
}

// --- Drawer trace follow ------------------------------------------------------
/** The member/attempt the store follows right now, so a revision bump within
 *  the same pair never re-arms (and re-reads) the open trace. */
let followedTrace: { memberTurnId: string; attempt: number } | null = null;

function armTraceFollow(memberTurnId: string, attempt: number | undefined): void {
  if (attempt === undefined) return;
  if (followedTrace?.memberTurnId === memberTurnId && followedTrace.attempt === attempt) return;
  followedTrace = { memberTurnId, attempt };
  groupsStore.setTraceFollow(memberTurnId, attempt);
}

/** The attempt selector inside the drawer: the followed cursor must move with
 *  it, or every frame of the new attempt is rejected as a mismatch. */
function handleTimelineAttempt(attempt: number): void {
  detailAttempt.value = attempt;
  const selected = detailSelectedMember.value;
  if (!selected) return;
  groupsStore.ensureTracePage(selected.id, attempt);
  armTraceFollow(selected.id, attempt);
}

// The read model can land after the drawer opened: retry the selected trace
// once its Run detail (which owns the member lookup) is present.
watch(
  () => [
    groupsStore.runHistoryDetailRevision,
    detailTarget.value?.runId,
    detailTarget.value?.memberTurnId,
    detailEffectiveAttempt.value ?? "",
  ].join(":"),
  () => {
    const selected = detailSelectedMember.value;
    const attempt = detailEffectiveAttempt.value;
    if (!selected || attempt === undefined) return;
    groupsStore.ensureTracePage(selected.id, attempt);
    armTraceFollow(selected.id, attempt);
  },
  { immediate: true },
);

// A Topic or instance switch leaves the previous scope entirely: neither the
// pending open nor the "Run unavailable" banner may survive it, and the store
// drops the drawer follow with the old scope — so the local cursor must too,
// or a reopened drawer after switching away and back can never re-arm it.
watch(
  () => [groupsStore.instanceId, groupsStore.activeConversationId, groupsStore.activeTopicId].join(":"),
  () => {
    unavailable.value = null;
    pendingDetail.value = null;
    followedTrace = null;
  },
);

function selectTimelineMember(memberTurnId: string): void {
  const member = detailMembers.value.find((candidate) => candidate.id === memberTurnId);
  if (!member || !detailTarget.value) return;
  detailTarget.value = { ...detailTarget.value, memberTurnId };
  detailAttempt.value = member.attempt;
  armTraceFollow(member.id, member.attempt);
}

function closeTimelineDetail(): void {
  followedTrace = null;
  groupsStore.clearTraceFollow();
  detailTarget.value = null;
  detailAttempt.value = undefined;
}

const detailTracePage = computed(() => {
  const selected = detailSelectedMember.value;
  const attempt = detailEffectiveAttempt.value;
  if (!selected || attempt === undefined) return null;
  const scope = [groupsStore.instanceId, groupsStore.activeConversationId, groupsStore.activeTopicId].join(":");
  return groupsStore.tracePages[`${scope}:${selected.id}:${attempt}`] ?? null;
});

const detailTraceParts = computed(() => {
  const selected = detailSelectedMember.value;
  if (!selected) return undefined;
  const replay = detailTracePage.value ? traceEventsToParts(detailTracePage.value.events).parts : undefined;
  const live = detailEffectiveAttempt.value === selected.attempt
    ? groupsStore.liveTurnForMember(selected.id)?.parts
    : undefined;
  return mergeLiveTraceParts(replay, live);
});

/** Open approvals of this Run, reachable from the drawer regardless of which
 *  member row is selected. */
const detailInteractions = computed(() => {
  const instId = groupsStore.instanceId;
  if (!instId) return [];
  return detailMembers.value
    .map((member) => directBotsStore.interactionForMember(instId, member))
    .filter((interaction): interaction is NonNullable<typeof interaction> => interaction !== null);
});

function detailInteraction(requestId: string) {
  return detailInteractions.value.find((interaction) => interaction.request.requestId === requestId);
}

function handleDetailAnswer(requestId: string, key: string, value: InteractionValueDto): void {
  const interaction = detailInteraction(requestId);
  if (interaction) directBotsStore.setInteractionAnswer(key, value, interaction);
}

function handleDetailSubmit(requestId: string): void {
  const interaction = detailInteraction(requestId);
  if (interaction) void directBotsStore.submitInteraction("accept", interaction);
}

function handleDetailDecline(requestId: string): void {
  const interaction = detailInteraction(requestId);
  if (interaction) void directBotsStore.declineInteraction(interaction);
}

function handleDetailCancel(requestId: string): void {
  const interaction = detailInteraction(requestId);
  if (interaction) void directBotsStore.cancelInteraction(interaction);
}

function handleDetailDismiss(requestId: string): void {
  const interaction = detailInteraction(requestId);
  if (interaction) directBotsStore.dismissResolvedInteraction(interaction);
}

async function handleDetailStopMember(memberTurnId: string): Promise<void> {
  const run = detailRun.value;
  const instId = groupsStore.instanceId;
  if (!run || !instId) return;
  stopPendingMember.value = memberTurnId;
  try {
    await groupsStore.cancelMember(instId, run.id, memberTurnId);
  } catch (err: unknown) {
    pushToast("error", "group.run.stopMemberFailed", { msg: err instanceof Error ? err.message : String(err) });
  } finally {
    if (stopPendingMember.value === memberTurnId) stopPendingMember.value = null;
  }
}

const detailCapability = computed(() => ({
  cancelMember: supportsRunsCancelMember(instance.value),
}));
const detailBudget = computed(() => detailRun.value ? runBudgetOf(detailRun.value) : undefined);


/** Durable Run details for the Runs the timeline shows: the process drawer and
 *  member names need them. Bounded by the loaded page, so history stays one batch. */
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
// An archived Topic stays browsable (its timeline is durable history), but it
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
          v-if="timelineSupported && isMobile && !needsFirstTopic"
          :topics="groupsStore.currentTopics"
          :active-topic-id="groupsStore.activeTopicId"
          :executing-topic-ids="groupsStore.executingTopicIds"
          :refresh-executing-topics="groupsStore.refreshExecutingTopics"
          :preview-topic="previewTopic"
          :rename-topic="renameTopic"
          :archive-topic="archiveTopic"
          :restore-topic="restoreTopic"
          :teardown-topic="teardownTopic"
          :clear-topic="clearTopic"
          :set-topic-isolation="isolationSupported ? setTopicIsolation : undefined"
          :fork-topic="forkSupported ? openForkFromTopic : undefined"
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
            v-if="timelineSupported && !isMobile && !needsFirstTopic"
            :topics="groupsStore.currentTopics"
            :active-topic-id="groupsStore.activeTopicId"
            :executing-topic-ids="groupsStore.executingTopicIds"
            :refresh-executing-topics="groupsStore.refreshExecutingTopics"
            :preview-topic="previewTopic"
            :rename-topic="renameTopic"
            :archive-topic="archiveTopic"
            :restore-topic="restoreTopic"
            :teardown-topic="teardownTopic"
            :clear-topic="clearTopic"
            :set-topic-isolation="isolationSupported ? setTopicIsolation : undefined"
            :fork-topic="forkSupported ? openForkFromTopic : undefined"
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

    <!-- A daemon without the timeline cannot be served at all: the upgrade
         notice alone occupies the pane, and every create/write entry point
         below it is either hidden or disabled, whatever the Topic state is. -->
    <div
      v-if="!timelineSupported"
      data-test="timeline-upgrade-required"
      class="flex min-h-0 flex-1 items-center justify-center px-6 text-center"
    >
      <p class="max-w-sm text-xs text-fg-muted">{{ $t("conversation.timeline.upgradeRequired") }}</p>
    </div>
    <div v-else-if="needsFirstTopic"
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
    <!-- One timeline for Group and Direct: the timeline state the upgrade gate
         above did not already claim. -->
    <ConversationTimeline
      v-else
      :room="roomView"
      :timeline="timelineFeed.timeline.value"
      :live-overlay="liveOverlay"
      :loading="timelineFeed.loading.value"
      :loading-older="timelineFeed.loadingOlder.value"
      :error="timelineFeed.error.value"
      :is-run-queued="groupsStore.isRunQueued"
      :load-older="timelineFeed.loadOlder"
      keep-mobile-identity
      @open-detail="openTimelineDetail"
      :forked-from="groupsStore.currentTopic?.forkedFrom ?? null"
      :fork-source-available="forkSourceAvailable"
      :fork-message="forkMessageSupported ? openForkFromMessage : undefined"
      @open-source-topic="openForkSourceTopic"
    />
    <ConversationWorktreePanel v-if="timelineSupported && groupsStore.currentTopic?.executionTarget?.isolation === 'worktree-per-member' && groupsStore.instanceId && worktreeRunId"
      :instance-id="groupsStore.instanceId" :run-id="worktreeRunId" />

    <ConversationStatusBar
      v-if="timelineSupported && !needsFirstTopic"
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
      :disabled="!timelineSupported || !groupsStore.activeTopicId || !groupsStore.topicReady || !isActiveTopic"
      :needs-first-topic="needsFirstTopic"
      :instance-id="groupsStore.instanceId"
      :send-outcome="sendPromptOutcome"
      @send="handleSend"
    />
    <div v-if="unavailable" data-test="run-detail-unavailable"
         class="flex items-center justify-between bg-warn/10 px-3 lg:px-5 py-2 text-xs text-fg">
      <span>{{ $t("conversation.runDetail.unavailable") }}</span>
      <button type="button" data-test="run-detail-retry"
              class="rounded-sm bg-raised text-fg hover:bg-surface-2 px-2 py-0.5 font-medium transition-colors"
              @click="retryTimelineDetail">
        {{ $t("bot.prompt.retry") }}
      </button>
    </div>
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
    <ForkTopicDialog
      v-if="forkTarget"
      :source-topic="forkTarget.topic"
      :source-point="forkTarget.sourcePoint"
      :resolved-run="forkTarget.resolvedRun ?? null"
      :conversation-id="groupsStore.activeConversationId ?? ''"
      :fork="forkGroupTopicFromDialog"
      @close="forkTarget = null"
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

    <!-- The one Run-wide detail drawer (design §8.4): every entry point
         (bot meta, avatar, speaker label, status bar) opens this key. -->
    <TraceOverlay
      v-if="detailRun && detailTarget"
      id="group-timeline-trace-overlay"
      :run="detailRun"
      :member-turns="detailMembers"
      :selected-member-turn-id="detailSelectedMember?.id"
      :participants="roomView.participants"
      :budget="detailBudget"
      :interactions="detailInteractions"
      :capability="detailCapability"
      :cancel-pending="!!stopPendingMember"
      :fork-available="detailRunForkable"
      :topic-title="groupsStore.currentTopic?.title"
      :attempt="detailEffectiveAttempt"
      :attempts="detailTracePage?.attempts"
      :parts="detailTraceParts"
      :recording-state="detailTracePage?.recordingState"
      :plan="detailTracePage?.plan"
      :trace-loading="detailTracePage?.loading"
      :trace-error="detailTracePage?.error"
      :trace-has-more="detailTracePage?.hasMore"
      :trace-has-earlier="detailTracePage?.hasEarlier"
      :trace-streaming="!detailTracePage?.events.length && !!detailSelectedMember && !!groupsStore.liveTurnForMember(detailSelectedMember.id)"
      @close="closeTimelineDetail"
      @attempt="handleTimelineAttempt"
      @select-member="selectTimelineMember"
      @stop-member="handleDetailStopMember"
      @fork="detailRun && openForkFromRun(detailRun)"
      @interaction-answer="handleDetailAnswer"
      @interaction-submit="handleDetailSubmit"
      @interaction-decline="handleDetailDecline"
      @interaction-cancel="handleDetailCancel"
      @interaction-dismiss="handleDetailDismiss"
      @load-more="detailSelectedMember && detailEffectiveAttempt !== undefined && groupsStore.ensureTracePage(detailSelectedMember.id, detailEffectiveAttempt)"
      @load-earlier="detailSelectedMember && detailEffectiveAttempt !== undefined && groupsStore.ensureTracePage(detailSelectedMember.id, detailEffectiveAttempt, 0)"
      @retry-trace="detailSelectedMember && detailEffectiveAttempt !== undefined && groupsStore.ensureTracePage(detailSelectedMember.id, detailEffectiveAttempt)"
    />
  </div>
</template>
