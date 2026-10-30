<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { useI18n } from "vue-i18n";
import { spaceNameForCjk } from "../lib/cjk-name-spacing";
import {
  AlertCircle,
  CircleStop,
  HelpCircle,
  Loader2,
  Users,
} from "lucide-vue-next";
import type {
  BotSummaryDto,
  ConversationMessageDto,
  ConversationRunDto,
  MemberTurnSummaryDto,
  PlanEntryDto,
  TurnPartDto,
} from "@ganglion/xacpx-relay-protocol";
import { useGroupsStore } from "../stores/groups";
import { useDirectBotsStore } from "../stores/direct-bots";
import { supportsRunsCancelMember, supportsRunsPause, useInstancesStore } from "../stores/instances";
import { useConnectionStore } from "../stores/connection";
import TranscriptRow from "./TranscriptRow.vue";
import TranscriptJumpLatest from "./TranscriptJumpLatest.vue";
import GroupDispatchRow from "./GroupDispatchRow.vue";
import GroupDispatchLeaderStop from "./GroupDispatchLeaderStop.vue";
import ConversationBubble from "./ConversationBubble.vue";
import ConversationMeta from "./ConversationMeta.vue";
import BotAvatar from "./BotAvatar.vue";
import GroupAgentTurnRow from "./GroupAgentTurnRow.vue";
import AgentThinkingBubble, { type BubbleStatus } from "./AgentThinkingBubble.vue";
import GroupRunDetailPopover from "./GroupRunDetailPopover.vue";
import GroupRunDetailSheet from "./GroupRunDetailSheet.vue";
import { useIsMobile } from "../lib/use-dropdown";
import {
  presentGroupDispatch,
  type GroupDispatchPresentation,
} from "../lib/group-dispatch-presentation";
import { pushToast } from "../lib/use-toasts";
import { confirm } from "../lib/use-confirm";
import {
  projectGroupTranscript,
  traceEventsToParts,
  type GroupRunRecord,
  type GroupTranscriptItem,
  type TraceReplayStatus,
} from "../lib/group-run-presentation";

const props = defineProps<{
  bots: BotSummaryDto[];
}>();

const { t, locale } = useI18n();
const groupsStore = useGroupsStore();
const directBotsStore = useDirectBotsStore();
const instancesStore = useInstancesStore();
const isMobile = useIsMobile();

const group = computed(() => groupsStore.currentGroup);
const topic = computed(() => groupsStore.currentTopic);
const run = computed(() => groupsStore.activeRun);
const botById = computed<Record<string, BotSummaryDto>>(() => {
  const out: Record<string, BotSummaryDto> = {};
  for (const b of props.bots) out[b.id] = b;
  return out;
});

function driverForBot(botId: string): string | undefined {
  const instId = groupsStore.instanceId;
  if (!instId) return undefined;
  const inst = instancesStore.byId(instId);
  const agent = botById.value[botId]?.agent;
  return inst?.agents.find((a) => a.name === agent)?.driver;
}

function senderName(botId: string | undefined): string {
  if (!botId) return "Bot";
  const bot = botById.value[botId];
  if (!bot) return "Bot";
  if (bot.retired) return t("bot.removal.removedName", { name: bot.name });
  return bot.name;
}

// ---------------------------------------------------------------------------
// Scoped run records: history read-model first, activeRun identity as the
// authoritative fallback for the currently executing Run. Old rows keep their
// original run/member identities — never activeRun.
// ---------------------------------------------------------------------------
const runRecords = computed<Record<string, GroupRunRecord>>(() => {
  const out: Record<string, GroupRunRecord> = {};
  void groupsStore.runHistoryDetailRevision; // reactivity dependency
  const details = groupsStore.runHistoryDetails;
  for (const detail of Object.values(details)) {
    if (detail.conversationId !== groupsStore.activeConversationId || detail.topicId !== groupsStore.activeTopicId) continue;
    const scopeKey = `${groupsStore.instanceId}:${detail.conversationId}:${detail.topicId}:${detail.id}`;
    if (details[scopeKey] !== detail) continue;
    out[detail.id] = { run: detail, memberTurns: detail.memberTurns ?? [] };
  }
  const active = groupsStore.activeRun;
  if (active) {
    const activeTurns = groupsStore.memberTurns.filter(
      (turn) => turn.runId === active.id && turn.conversationId === active.conversationId && turn.topicId === active.topicId,
    );
    const existing = out[active.id];
    const merged = new Map<string, MemberTurnSummaryDto>();
    for (const turn of existing?.memberTurns ?? []) merged.set(turn.id, turn);
    for (const turn of activeTurns) merged.set(turn.id, turn);
    out[active.id] = {
      run: active,
      memberTurns: [...merged.values()],
    };
  }
  return out;
});

function canStopRun(candidate: ConversationRunDto | undefined): boolean {
  const active = groupsStore.activeRun;
  return !!candidate && !!active
    && groupsStore.topicReady
    && !groupsStore.ownershipUncertain
    && !groupsStore.ownerUnconfirmed
    && active.id === candidate.id
    && active.conversationId === candidate.conversationId
    && active.topicId === candidate.topicId
    && active.conversationId === groupsStore.activeConversationId
    && active.topicId === groupsStore.activeTopicId
    && groupsStore.isRunActive;
}

const items = computed<GroupTranscriptItem[]>(() =>
  projectGroupTranscript({
    messages: groupsStore.messages,
    runs: runRecords.value,
  }),
);

/** The core can cancel ONE member turn of a Run: the per-row ■ and the
 *  leader pill scope their stop to that member. An older core has no scoped
 *  cancellation, so only the confirmed round-level stop is offered there. */
const supportsCancelMember = computed(() => {
  const instanceId = groupsStore.instanceId;
  if (!instanceId) return false;
  return supportsRunsCancelMember(instancesStore.byId(instanceId));
});

/** Handoff groups of one leader round: same conversation, topic, run and
 *  issuing leader turn (`senderMemberTurnId`). Every round aggregates —
 *  a lone dispatch renders the same aggregate row as a fan-out round. */
const dispatchGroups = computed(() => {
  const messages = [...groupsStore.messages].sort((a, b) => a.seq - b.seq);
  const byLeader = new Map<string, ConversationMessageDto[]>();
  for (const message of messages) {
    const senderTurnId = message.handoff?.senderMemberTurnId;
    if (!senderTurnId) continue;
    const key = JSON.stringify([message.conversationId, message.topicId, message.runId ?? "", senderTurnId]);
    const list = byLeader.get(key);
    if (list) list.push(message);
    else byLeader.set(key, [message]);
  }
  const drivers: Record<string, string> = {};
  for (const bot of props.bots) {
    const driver = driverForBot(bot.id);
    if (driver !== undefined) drivers[bot.id] = driver;
  }
  const groups: {
    /** Stable identity of the round: scope, run and issuing leader turn. */
    roundId: string;
    handoffs: ConversationMessageDto[];
    anchorId: string;
    /** The leader's own turns: the dispatching turn and its wake turn. */
    leaderTurns: MemberTurnSummaryDto[];
    /** The round's run was cancelled (a whole-round stop). */
    runCancelled: boolean;
    presentation: GroupDispatchPresentation;
  }[] = [];
  for (const [roundId, handoffs] of byLeader) {
    const anchor = handoffs[0]!;
    const record = anchor.runId ? runRecords.value[anchor.runId] : undefined;
    const turnById = new Map((record?.memberTurns ?? []).map((turn) => [turn.id, turn]));
    const leaderTurn = turnById.get(anchor.handoff!.senderMemberTurnId);
    // The leader's own reply proves "项管那条消息": exact promptRequestId
    // match, exactly one candidate, or no anchor — never a guess.
    const leaderMessage = leaderTurn?.promptRequestId
      ? messages.filter((message) => message.role === "bot" && !message.handoff
        && message.runId === anchor.runId
        && message.conversationId === anchor.conversationId && message.topicId === anchor.topicId
        && message.senderBotId === anchor.senderBotId
        && message.promptRequestId === leaderTurn.promptRequestId
        && message.content.trim().length > 0)
      : [];
    // The wake turn the runtime creates for this leader once its own handoffs
    // settle. It may be absent: the dispatch has not settled yet, so the
    // wake row does not exist yet either.
    const wakeTurn = (record?.memberTurns ?? []).find(
      (turn) => turn.followupSenderMemberTurnId === anchor.handoff!.senderMemberTurnId,
    );
    const runCancelled = record?.run.state === "cancelled";
    const presentation = presentGroupDispatch({
      leader: {
        botId: anchor.senderBotId ?? "",
        ...(leaderTurn ? { memberTurnId: leaderTurn.id } : {}),
        // The leader's OWN durable state: it decides whether the leader can
        // still be stopped, never the aggregate row's outcome.
        ...(leaderTurn ? { state: leaderTurn.state } : {}),
        // Durable stop evidence: the leader turn itself was stopped by the
        // human while its members kept (or finished) their own proven
        // outcomes. The core reports this on the DTO; its own state may still
        // read `completed`.
        ...(leaderTurn?.cancellationReason ? { cancellationReason: leaderTurn.cancellationReason } : {}),
        // A whole-round stop cancels the run but writes no reason on the
        // leader's turn: the run's own state is the stop evidence then.
        ...(runCancelled ? { runCancelled: true } : {}),
        ...(wakeTurn ? { wake: wakeTurn } : {}),
      },
      dispatches: handoffs.map((message) => ({
        message: message as ConversationMessageDto & { handoff: NonNullable<ConversationMessageDto["handoff"]> },
        // Missing detail (history not loaded yet) still counts the bot: report
        // it as queued until the run's member turns arrive.
        memberTurn: turnById.get(message.handoff!.memberTurnId) ?? {
          id: message.handoff!.memberTurnId,
          runId: message.runId ?? "",
          conversationId: message.conversationId,
          topicId: message.topicId,
          botId: message.handoff!.to,
          batch: 0,
          attempt: 1,
          origin: "handoff" as const,
          state: "queued" as const,
          createdAt: message.createdAt,
        },
      })),
      bots: props.bots,
      drivers,
      // The core's own scoped-cancellation capability: without it the web
      // offers only the confirmed round-level stop.
      supportsCancelMember: supportsCancelMember.value,
      messages,
    });
    groups.push({
      roundId,
      handoffs,
      anchorId: leaderMessage.length === 1 ? leaderMessage[0]!.id : anchor.id,
      leaderTurns: [leaderTurn, wakeTurn].filter((turn): turn is MemberTurnSummaryDto => !!turn),
      runCancelled,
      presentation,
    });
  }
  return groups;
});

// ---------------------------------------------------------------------------
// Screen-reader announcement of a round's end. The polite live region below
// stays mounted and empty; it speaks one sentence only when THIS page watched
// a round go from in progress to finished (every member settled) or to a
// stopped leader. Rounds first seen already terminal — history load, older
// pages, a topic switch, a reconnect resync — are recorded silently, and a
// round is announced at most once.
// ---------------------------------------------------------------------------
const connectionStore = useConnectionStore();
/** Text of the polite live region: empty until a round ends live. */
const dispatchAnnouncement = ref("");
/** Round id → terminal, as this page last saw it in the current scope. */
const seenRounds = new Map<string, boolean>();
/** Rounds already announced in the current scope. */
const announcedRounds = new Set<string>();
/** Scope (instance / conversation / topic) the seen-map belongs to. */
let observedScope: string | null = null;
/** The socket dropped: state replayed by the reconnect resync is not live. */
let resyncPending = false;
let announceTicket = 0;

/** Clear first, write on the next tick: a repeated sentence is re-announced. */
function announceDispatch(text: string): void {
  const ticket = ++announceTicket;
  dispatchAnnouncement.value = "";
  void nextTick(() => {
    if (ticket === announceTicket) dispatchAnnouncement.value = text;
  });
}

/** One sentence for a round that just ended: the stopped leader wins over the
 *  member tally, which otherwise lists the non-zero outcomes in row order. */
function dispatchEndSentence(presentation: GroupDispatchPresentation): string {
  if (presentation.leaderStopped) {
    return t("group.dispatch.announce.leaderStopped", {
      name: spaceNameForCjk(presentation.leader.name, locale.value, "after"),
    });
  }
  const parts = [t("group.dispatch.announce.finished", { n: presentation.counts.completed })];
  for (const state of ["cancelled", "failed", "indeterminate"] as const) {
    const n = presentation.counts[state];
    if (n > 0) parts.push(t(`group.dispatch.announce.${state}`, { n }));
  }
  return parts.join(t("group.dispatch.announce.separator"));
}

watch(
  () => [
    `${groupsStore.instanceId ?? ""}\u0000${groupsStore.activeConversationId ?? ""}\u0000${groupsStore.activeTopicId ?? ""}`,
    connectionStore.online,
    groupsStore.topicReady,
    dispatchGroups.value,
  ] as const,
  ([scope, online, topicReady, groups]) => {
    if (scope !== observedScope) {
      observedScope = scope;
      seenRounds.clear();
      announcedRounds.clear();
      announceTicket++;
      dispatchAnnouncement.value = "";
    }
    if (!online) resyncPending = true;
    const quiet = resyncPending;
    const active = groupsStore.activeRun;
    const liveRunId = active && groupsStore.isRunActive ? active.id : null;
    let sentence = "";
    for (const group of groups) {
      const presentation = group.presentation;
      const terminal = presentation.summary !== "running" || presentation.leaderStopped;
      const previous = seenRounds.get(group.roundId);
      if (!terminal) {
        // Only the live run's own round counts as seen in progress: a history
        // round whose member turns have not loaded yet reads as queued, and
        // its details arriving must never sound like a live end.
        if (presentation.runId !== "" && presentation.runId === liveRunId) seenRounds.set(group.roundId, false);
        continue;
      }
      seenRounds.set(group.roundId, true);
      if (previous !== false || quiet || announcedRounds.has(group.roundId)) continue;
      announcedRounds.add(group.roundId);
      // One sentence at a time: the latest round in transcript order speaks.
      sentence = dispatchEndSentence(presentation);
    }
    // The resync is over once the topic is ready again on a live socket.
    if (resyncPending && online && topicReady) resyncPending = false;
    if (sentence) announceDispatch(sentence);
  },
  { immediate: true },
);

/** Anchor message id → aggregate row. The row renders below the leader's own
 *  message when it is in the transcript, else in place of the first handoff. */
const dispatchRows = computed<Record<string, GroupDispatchPresentation>>(() =>
  Object.fromEntries(dispatchGroups.value.map((group) => [group.anchorId, group.presentation])),
);

/** True when the leader's turn owns a row of its own in the transcript. */
function hasLeaderRow(turnId: string): boolean {
  return items.value.some((item) =>
    (item.kind === "message" && item.bubbleAnchor && item.memberTurn?.id === turnId) ||
    (item.kind === "member-activity" && item.memberTurn.id === turnId));
}

/**
 * The leader turn whose status slot names the human's stop.
 *
 * The stop is named once, in the leader's own bubble: the leader turn that
 * carries the durable stop evidence and owns a row of its own. A turn the
 * human cancelled — on its own, or with the whole round, which cancels the
 * run without a reason on the turn — reads "stopped" instead of
 * "cancelled"; a leader that
 * only carries the stop intent reads "stopped" instead of its own state.
 * A leader without any row has no status slot, so the stop stays unnamed
 * there — a second line below the message would say it twice.
 */
const stoppedLeaderTurnIds = computed<Set<string>>(() => {
  const ids = new Set<string>();
  for (const group of dispatchGroups.value) {
    if (!group.presentation.leaderStopped) continue;
    // A whole-round stop leaves no reason on the turns: in a cancelled run,
    // the cancelled turn itself is the evidence.
    const evidence = group.leaderTurns.filter((turn) =>
      (turn.cancellationReason === "human-cancelled" || (group.runCancelled && turn.state === "cancelled"))
      && hasLeaderRow(turn.id));
    // The cancelled turn first: it is the one whose own state the stop
    // replaces. Then the dispatch turn, which carries the stop intent.
    const turn = evidence.find((candidate) => candidate.state === "cancelled") ?? evidence[0];
    if (turn) ids.add(turn.id);
  }
  return ids;
});

/**
 * Anchor ids whose leader can still be stopped: the round's run is the live
 * one and the leader (or the wake turn that replaces it) still has work
 * left. A leader whose wake already settled has nothing left to cancel, so
 * the pill disappears with it.
 */
const leaderStopAnchorIds = computed<Set<string>>(() => {
  const ids = new Set<string>();
  const active = groupsStore.activeRun;
  // A terminal run has nothing left to cancel: the pill would offer a no-op.
  if (!active || !groupsStore.isRunActive) return ids;
  for (const group of dispatchGroups.value) {
    if (!group.presentation.leader.canStop) continue;
    if (group.presentation.runId !== active.id) continue;
    ids.add(group.anchorId);
  }
  return ids;
});

/** Handoff messages absorbed into an aggregate row: every grouped handoff
 *  except the anchor (when the anchor itself is a handoff) collapses. */
const collapsedHandoffIds = computed<Set<string>>(() => {
  const ids = new Set<string>();
  for (const group of dispatchGroups.value) {
    for (const message of group.handoffs) {
      if (message.id !== group.anchorId) ids.add(message.id);
    }
  }
  return ids;
});

/** Every run id visible in the transcript, batch-fetched non-blocking. */
const visibleRunIds = computed<string[]>(() => {
  const ids: string[] = [];
  for (const message of groupsStore.messages) {
    if (message.runId && !ids.includes(message.runId)) ids.push(message.runId);
  }
  if (groupsStore.activeRun && !ids.includes(groupsStore.activeRun.id)) {
    ids.push(groupsStore.activeRun.id);
  }
  return ids;
});

watch(
  [visibleRunIds, () => groupsStore.instanceId, () => groupsStore.activeConversationId, () => groupsStore.activeTopicId],
  () => {
    if (visibleRunIds.value.length) groupsStore.ensureRunDetails(visibleRunIds.value);
  },
  { immediate: true },
);
const openDetailKey = ref<string | null>(null);
const detailTriggerEl = ref<HTMLElement | null>(null);
const detailId = `group-detail-${useId()}`;
const selectedAttempt = ref<number | undefined>();

interface OpenDetail {
  itemKey: string;
  run: ConversationRunDto;
  memberTurn?: MemberTurnSummaryDto;
  explanation?: string;
  identityUncertain?: boolean;
}
const openDetail = computed<OpenDetail | null>(() => {
  if (!openDetailKey.value) return null;
  for (const item of items.value) {
    if (item.kind === "message" && item.bubbleAnchor && item.memberTurn && item.run) {
      const key = `bubble:${item.memberTurn.id}`;
      if (key === openDetailKey.value) return { itemKey: key, run: item.run.run, memberTurn: item.memberTurn };
    }
    if (item.kind === "member-activity" && `bubble:${item.memberTurn.id}` === openDetailKey.value) {
      const identityUncertain = !!item.explanation && item.explanation !== "missing-request" && item.explanation !== "request-mismatch";
      return { itemKey: openDetailKey.value, run: item.run.run, memberTurn: item.memberTurn, explanation: item.explanation, identityUncertain };
    }
    if (item.kind === "routing" && `routing:${item.run.run.id}` === openDetailKey.value) {
      const identityUncertain = !!item.explanation && item.explanation !== "missing-request" && item.explanation !== "request-mismatch";
      return { itemKey: openDetailKey.value, run: item.run.run, memberTurn: undefined, explanation: item.explanation, identityUncertain };
    }
  }
  return null;
});

watch(openDetail, (detail) => {
  if (detail === null && openDetailKey.value) closeDetail();
});

function closeDetail(): void {
  openDetailKey.value = null;
  detailTriggerEl.value = null;
  selectedAttempt.value = undefined;
  groupsStore.setOpenTrace(null);
}

watch(
  () => [openDetail.value?.memberTurn?.id ?? null, selectedAttempt.value ?? null, openDetail.value?.identityUncertain === true] as const,
  ([memberId, attempt, uncertain]) => {
    groupsStore.setOpenTrace(memberId && !uncertain ? memberId : null, typeof attempt === "number" ? attempt : undefined);
  },
  { immediate: true },
);
onBeforeUnmount(() => groupsStore.setOpenTrace(null));

watch(
  [() => groupsStore.instanceId, () => groupsStore.activeConversationId, () => groupsStore.activeTopicId],
  () => { closeDetail(); },
);

function toggleDetail(key: string, trigger: HTMLElement | null): void {
  if (openDetailKey.value === key) { closeDetail(); return; }
  openDetailKey.value = key;
  detailTriggerEl.value = trigger;
  selectedAttempt.value = undefined;
  const detail = openDetail.value;
  if (detail?.memberTurn) selectedAttempt.value = detail.memberTurn.attempt;
}

function changeAttempt(attempt: number): void {
  if (!detailAttempts.value.includes(attempt)) return;
  selectedAttempt.value = attempt;
}

function loadTrace(afterSeq?: number): void {
  const detail = openDetail.value;
  if (!detail?.memberTurn || detail.identityUncertain || selectedAttempt.value === undefined) return;
  void groupsStore.ensureTracePage(detail.memberTurn.id, selectedAttempt.value, afterSeq);
}

function bubbleKeyOf(memberTurnId: string): string { return `bubble:${memberTurnId}`; }

function partsForMember(memberTurn: MemberTurnSummaryDto): TurnPartDto[] | undefined {
  return groupsStore.completeRunPartsForMember(memberTurn.id, memberTurn.attempt);
}
function routingKeyOf(runId: string): string { return `routing:${runId}`; }

const detailPage = computed(() => {
  const detail = openDetail.value;
  if (!detail?.memberTurn || detail.identityUncertain || selectedAttempt.value === undefined) return null;
  const scope = [groupsStore.instanceId, groupsStore.activeConversationId, groupsStore.activeTopicId].join(":");
  return groupsStore.tracePages[`${scope}:${detail.memberTurn.id}:${selectedAttempt.value}`] ?? null;
});
const detailAttempts = computed(() => {
  const member = openDetail.value?.memberTurn;
  if (!member) return [];
  return [...new Set([member.attempt, selectedAttempt.value ?? 0, ...(detailPage.value?.attempts ?? [])])]
    .filter((attempt) => attempt > 0).sort((a, b) => a - b);
});
const detailReplay = computed(() => detailPage.value ? traceEventsToParts(detailPage.value.events) : undefined);
const detailLive = computed(() => {
  const detail = openDetail.value;
  if (!detail?.memberTurn || detail.identityUncertain || selectedAttempt.value !== detail.memberTurn.attempt) return undefined;
  const live = groupsStore.liveTurnForMember(detail.memberTurn.id);
  if (live && live.attempt !== undefined && live.attempt !== selectedAttempt.value) return undefined;
  return live;
});
const detailParts = computed<TurnPartDto[] | undefined>(() => {
  if (detailReplay.value?.parts.length || detailPage.value?.events.length) return detailReplay.value?.parts;
  return detailLive.value?.parts;
});

const detailRecordingState = computed<TraceReplayStatus | undefined>(() => {
  if (detailPage.value?.recordingState) return detailPage.value.recordingState;
  return detailLive.value?.status === "streaming" ? "recording" : undefined;
});
const detailTraceFailure = computed(() => {
  const terminal = detailReplay.value?.terminal;
  if (!terminal || terminal.ok) return undefined;
  return terminal.errorMessage || t(terminal.cancelled ? "bot.run.cancelled" : "bot.run.failed");
});
const detailPlan = computed<PlanEntryDto[] | undefined>(() => {
  const page = detailPage.value;
  if (page?.plan?.length) return page.plan;
  const detail = openDetail.value;
  if (detail && !detail.identityUncertain && selectedAttempt.value === detail.memberTurn?.attempt
    && groupsStore.activeRun?.id === detail.run.id) {
    const entries = groupsStore.planByRunId[detail.run.id];
    if (entries?.length) return entries;
  }
  return undefined;
});
const stopAvailable = computed(() => {
  const detail = openDetail.value;
  return !!detail && !detail.identityUncertain && canStopRun(detail.run);
});
const stopPending = computed(() => {
  const detail = openDetail.value;
  if (!detail) return false;
  return groupsStore.cancellingRunId === detail.run.id;
});
function handleStop(): void {
  if (stopAvailable.value && !stopPending.value) void groupsStore.cancelCurrentRun();
}

/** The core advertises durable Run pause/resume. An older core answers
 *  `unsupported-rpc`, so the control is hidden rather than shown broken. */
const supportsPause = computed(() => {
  const instanceId = groupsStore.instanceId;
  if (!instanceId) return false;
  return supportsRunsPause(instancesStore.byId(instanceId));
});
const pauseAvailable = computed(() => {
  const detail = openDetail.value;
  return supportsPause.value && !!detail && !detail.identityUncertain && canStopRun(detail.run);
});
const pausePending = computed(() => {
  const detail = openDetail.value;
  if (!detail) return false;
  return groupsStore.runControlPending === detail.run.id;
});
function handlePause(): void {
  if (!pauseAvailable.value || pausePending.value) return;
  const run = openDetail.value?.run;
  void groupsStore.setCurrentRunPaused(run?.state !== "paused");
}

/** Stop one dispatched member of a round. The request carries the durable
 *  run and member turn, so the leader and the other members keep running. */
async function handleStopMember(payload: { runId: string; memberTurnId: string }): Promise<void> {
  const instanceId = groupsStore.instanceId;
  if (!instanceId) return;
  try {
    await groupsStore.cancelMember(instanceId, payload.runId, payload.memberTurnId);
  } catch (err: unknown) {
    pushToast("error", "group.dispatch.stopMemberFailed", { msg: err instanceof Error ? err.message : String(err) });
  }
}

/** Round-level stop: confirm first, then cancel the run through the same path
 *  as the per-run Stop button. */
async function handleStopAll(presentation: GroupDispatchPresentation): Promise<void> {
  const runId = presentation.members[0]?.runId;
  if (!runId) return;
  const ok = await confirm({
    title: t("group.dispatch.stopAllConfirm.title"),
    message: t("group.dispatch.stopAllConfirm.message", {
      name: spaceNameForCjk(presentation.leader.name, locale.value, "after"),
      n: presentation.members.length,
    }),
    confirmLabel: t("group.dispatch.stopAllConfirm.confirm"),
    tone: "danger",
  });
  if (!ok) return;
  // The round may have ended while the dialog was open: never cancel a run
  // other than the one the user confirmed.
  if (groupsStore.activeRun?.id !== runId) return;
  void groupsStore.cancelCurrentRun();
}

/**
 * The leader pill's wording: a scoped stop names the leader it stops, while a
 * core without scoped cancellation stops the whole round and says so.
 */
function leaderStopLabel(presentation: GroupDispatchPresentation): string {
  if (presentation.capability.leaderStopAction === "leader-only") {
    return t("group.dispatch.stopLeader", { name: spaceNameForCjk(presentation.leader.name, locale.value, "before") });
  }
  return t("group.dispatch.stopAll");
}

/**
 * Stop the leader (项管): on a core with scoped cancellation this cancels the
 * leader's own member turn and nothing else — no confirmation, because the
 * dispatched members keep running. A leader that already ended its turn is
 * stopped through its wake turn while that one is still live. An older core
 * cannot scope the cancel, so the pill runs the confirmed round-level stop
 * instead.
 */
function handleStopLeader(presentation: GroupDispatchPresentation): void {
  if (presentation.capability.leaderStopAction === "leader-only" && presentation.leader.stopMemberTurnId) {
    void handleStopMember({ runId: presentation.runId, memberTurnId: presentation.leader.stopMemberTurnId });
    return;
  }
  void handleStopAll(presentation);
}
function handleToggle(key: string, event: unknown): void {
  toggleDetail(key, event instanceof HTMLElement ? event : null);
}
const explanationText = (explanation: string): string => {
  switch (explanation) {
    case "missing-request": return t("group.detail.requestMissing");
    case "request-mismatch": return t("group.detail.requestMismatch");
    case "ambiguous-owner": return t("group.bubble.unresolvedAmbiguous");
    case "owner-mismatch": return t("group.bubble.unresolvedMismatch");
    case "missing-run": return t("group.bubble.unresolvedMissingRun");
    case "no-member": return t("group.bubble.unresolvedNoMember");
    default: return t("group.bubble.unresolvedMissingRun");
  }
};
const scroller = ref<HTMLElement | null>(null);
const atBottom = ref(true);
const THRESHOLD = 64;
interface ScrollAnchor { rowId: string; offsetTop: number; }
const pendingAnchor = ref<ScrollAnchor | null>(null);
/** Where a reader parked above the tail is reading, re-taken on every scroll.
 *  The scroller opts out of browser scroll anchoring, so this is the one owner
 *  of the reading position when rows above the viewport change height. */
let readingAnchor: ScrollAnchor | null = null;
const content = ref<HTMLElement | null>(null);
let contentObserver: ResizeObserver | null = null;
/** Last read position in the detail's trace, per member and attempt; in-memory
 *  so reopening the same process resumes where the reader left off, while a
 *  fresh browser session still starts at the top. */
const detailScrollMemory = new Map<string, number>();
function onScroll(): void {
  const el = scroller.value;
  if (!el) return;
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= THRESHOLD;
  readingAnchor = atBottom.value ? null : captureAnchor();
}
function scrollToBottom(): void {
  const el = scroller.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight - el.clientHeight;
  // content-visibility rows paint at the contain-intrinsic-size estimate, and late
  // layout (fonts, avatars, code blocks) keeps growing the content after the first
  // jump, so a fixed-frame re-pin lands short (iOS Safari is the worst). Keep
  // re-pinning while the content keeps growing, and stop as soon as the reader
  // drifts off the bottom; rAF absent (jsdom tests) is a no-op.
  if (typeof requestAnimationFrame !== "function") return;
  let pinnedHeight = el.scrollHeight;
  let tries = 0;
  const settle = (): void => {
    const e = scroller.value;
    if (!e) return;
    if (pinnedHeight - e.scrollTop - e.clientHeight > THRESHOLD) return; // reader took over
    if (e.scrollHeight !== pinnedHeight) {
      pinnedHeight = e.scrollHeight;
      e.scrollTop = e.scrollHeight - e.clientHeight;
    }
    if (++tries < 40) requestAnimationFrame(settle);
  };
  requestAnimationFrame(settle);
}
function jumpToMessage(messageId: string): void {
  const el = scroller.value;
  if (!el) return;
  const row = Array.from(el.querySelectorAll<HTMLElement>("[data-message-id]"))
    .find((candidate) => candidate.dataset["messageId"] === messageId);
  if (!row) return;
  row.tabIndex = -1;
  row.focus({ preventScroll: true });
  el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top;
}
watch(() => groupsStore.topicReady, (ready) => {
  // A parked reader keeps their row: run rediscovery (e.g. after Stop) rebuilds
  // the transcript, but only a reader already at the tail is returned there -
  // the same rule live appends follow.
  if (ready && atBottom.value) void nextTick(() => scrollToBottom());
});
// Follow on item identity, not item count: a member activity promoted to its
// canonical reply (recovery/history) keeps the count, swaps the key and grows
// the row without any live revision. Content-only growth keeps its key and is
// followed by the live revision watch below.
watch(() => {
  let signature = "";
  for (const item of items.value) signature += `${item.key}\u0000`;
  return signature;
}, (next, prev) => {
  if (prev === undefined) return;
  if (pendingAnchor.value !== null) return;
  if (atBottom.value) void nextTick(() => scrollToBottom());
});
watch(() => {
  let max = 0;
  for (const live of Object.values(groupsStore.liveTurnsByMember)) {
    if (live.revision > max) max = live.revision;
  }
  return max;
}, () => {
  if (atBottom.value) void nextTick(() => scrollToBottom());
});
onMounted(() => {
  void nextTick(() => scrollToBottom());
  if (typeof ResizeObserver === "undefined" || !content.value) return;
  contentObserver = new ResizeObserver(() => holdReadingPosition());
  contentObserver.observe(content.value);
});
onBeforeUnmount(() => contentObserver?.disconnect());

// Rows keep changing height after they are inserted: a `content-visibility:
// auto` row is laid out at its 88px estimate and swaps in its real height a
// frame or more later, when it nears the viewport; a trace expands; a reply
// streams. Browser scroll anchoring would compensate some of that on its own,
// on its own schedule, and on top of our restores, so the same shift could be
// applied twice. The scroller opts out of it and every content resize re-applies
// the reader's position here, after layout and before paint.
function holdReadingPosition(): void {
  if (pendingAnchor.value !== null) return;
  if (atBottom.value) { scrollToBottom(); return; }
  if (readingAnchor !== null) restoreAnchor(readingAnchor);
}

function captureAnchor(): ScrollAnchor | null {
  const el = scroller.value;
  if (!el) return null;
  const rows = el.querySelectorAll<HTMLElement>("[data-anchor-id]");
  const viewport = el.getBoundingClientRect();
  // Rows are in document order, so their tops ascend: find the first row that
  // starts inside the viewport. A row cut by the top edge is a poor anchor,
  // because its own height may still be an estimate that changes under it.
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.getBoundingClientRect().top >= viewport.top) hi = mid;
    else lo = mid + 1;
  }
  const below = rows[lo];
  const row = below && (lo === 0 || below.getBoundingClientRect().top < viewport.top + el.clientHeight) ? below : rows[lo - 1];
  if (row) return { rowId: row.dataset["anchorId"] ?? "", offsetTop: row.getBoundingClientRect().top - viewport.top };
  const last = groupsStore.messages[groupsStore.messages.length - 1];
  return last ? { rowId: last.id, offsetTop: el.clientHeight } : null;
}
function restoreAnchor(anchor: ScrollAnchor): void {
  const el = scroller.value;
  if (!el) return;
  const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-anchor-id]"));
  const row = rows.find((candidate) => candidate.dataset["anchorId"] === anchor.rowId);
  if (!row) return;
  const viewportTop = el.getBoundingClientRect().top;
  const shift = row.getBoundingClientRect().top - viewportTop - anchor.offsetTop;
  if (shift !== 0) el.scrollTop += shift;
}
async function handleLoadOlder(): Promise<void> {
  const el = scroller.value;
  if (!el || groupsStore.loadingOlder) return;
  pendingAnchor.value = captureAnchor();
  try { await groupsStore.loadOlder(); }
  finally {
    await nextTick();
    const anchor = pendingAnchor.value;
    pendingAnchor.value = null;
    // The prepended rows settle their real heights over the next frames; the
    // content observer keeps holding this anchor through that.
    if (anchor !== null) {
      readingAnchor = anchor;
      restoreAnchor(anchor);
    }
  }
}
function zeroMemberRunStatus(state: ConversationRunDto["state"]): BubbleStatus {
  switch (state) {
    case "queued": return "queued";
    case "waiting-human": return "waiting";
    case "completed": return "done";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "indeterminate": return "indeterminate";
    default: return "routing";
  }
}
</script>

<template>
  <div class="relative flex min-h-0 flex-1 flex-col">
  <!-- Always mounted and initially empty: text is written only when a round
       ends live, so a screen reader hears the end, never the progress. -->
  <div data-test="group-dispatch-announcer" role="status" aria-live="polite" aria-atomic="true" class="sr-only">{{ dispatchAnnouncement }}</div>
  <div ref="scroller" data-test="group-transcript-scroller" class="thin-scroll min-h-0 flex-1 overflow-y-auto py-4 px-4 [overflow-anchor:none] lg:py-5 lg:pl-5 lg:pr-5" @scroll.passive="onScroll">
    <div v-if="!groupsStore.loadingHistory && groupsStore.messages.length === 0 && items.length === 0 && !(run && (run.state === 'failed' || run.state === 'cancelled' || run.state === 'indeterminate'))" class="my-auto flex flex-col items-center justify-center py-12 text-center">
      <div class="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-accent-soft text-accent">
        <Users :size="22" />
      </div>
      <h3 class="text-base font-semibold text-fg">{{ group?.title ?? "Group" }}</h3>
      <p class="mt-4 text-xs text-fg-muted">{{ $t("group.chat.emptyHint") }}</p>
    </div>

    <div v-if="groupsStore.loadingOlder || groupsStore.hasMoreBefore" class="mb-4 flex justify-center">
      <button
        type="button"
        data-test="group-load-older-button"
        :disabled="groupsStore.loadingOlder"
        class="flex items-center gap-1.5 rounded-full bg-surface px-3 py-1 text-xs font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-50"
        @click="handleLoadOlder"
      >
        <Loader2 v-if="groupsStore.loadingOlder" :size="12" class="animate-spin" />
        <span>{{ groupsStore.loadingOlder ? $t("common.loading") : $t("chat.loadOlder") }}</span>
      </button>
    </div>

    <div ref="content" class="mx-auto max-w-3xl space-y-5">
      <template v-for="item in items" :key="item.key">
        <!-- Durable message / handoff / system rows -->
        <template v-if="item.kind === 'message' && !(item.bubbleAnchor && item.memberTurn)">
          <TranscriptRow
            v-if="!item.memberTurn && !collapsedHandoffIds.has(item.message.id)"
            :key="item.key"
            :row-id="item.message.id"
            :data-anchor-id="item.message.id"
            :data-message-id="item.message.id"
            :own="item.message.role === 'human'"
            :driver="item.message.role === 'bot' && item.message.senderBotId ? driverForBot(item.message.senderBotId) : undefined"
            :speaker="!item.message.handoff && item.message.role === 'bot' ? senderName(item.message.senderBotId) : undefined"
            :speaker-role="item.message.senderBotId ? botById[item.message.senderBotId]?.role : undefined"
            :hide-leading-avatar="!!item.message.handoff"
          >
            <template v-if="item.message.role === 'bot' && !item.message.handoff" #avatar>
              <BotAvatar :avatar="item.message.senderBotId ? botById[item.message.senderBotId]?.avatar : undefined"
                         :driver="item.message.senderBotId ? driverForBot(item.message.senderBotId) : undefined"
                         :name="senderName(item.message.senderBotId)" :size="32" static
                         :retired="item.message.senderBotId ? botById[item.message.senderBotId]?.retired : false" />
            </template>
            <template v-if="item.message.role === 'human'">
              <ConversationBubble :message="item.message" :attachments="item.message.attachments" own />
            </template>

            <template v-else-if="item.message.role === 'bot'">
              <ConversationBubble :message="item.message" :attachments="item.message.attachments" />
              <ConversationMeta :message="item.message" />
              <GroupDispatchRow
                v-if="dispatchRows[item.message.id]"
                :presentation="dispatchRows[item.message.id]!"
                class="mt-2"
                @jump="jumpToMessage"
                @stop-member="handleStopMember"
                @stop-all="handleStopAll(dispatchRows[item.message.id]!)"
              />
              <GroupDispatchLeaderStop
                v-if="leaderStopAnchorIds.has(item.message.id)"
                :label="leaderStopLabel(dispatchRows[item.message.id]!)"
                @stop="handleStopLeader(dispatchRows[item.message.id]!)"
              />
            </template>

            <template v-else-if="item.message.handoff">
              <!-- Every handoff belongs to exactly one round, so the row is
                   always there: the round renders in place of its anchor
                   handoff, and every other handoff of the round collapses. -->
              <GroupDispatchRow
                :presentation="dispatchRows[item.message.id]!"
                @jump="jumpToMessage"
                @stop-member="handleStopMember"
                @stop-all="handleStopAll(dispatchRows[item.message.id]!)"
              />
              <GroupDispatchLeaderStop
                v-if="leaderStopAnchorIds.has(item.message.id)"
                :label="leaderStopLabel(dispatchRows[item.message.id]!)"
                @stop="handleStopLeader(dispatchRows[item.message.id]!)"
              />
            </template>

            <template v-else-if="item.message.role === 'system'">
              <p class="w-full py-1 text-center text-xs italic text-fg-muted">{{ item.message.content }}</p>
            </template>

            <template v-else>
              <ConversationBubble :message="item.message" :attachments="item.message.attachments" />
              <ConversationMeta :message="item.message" />
            </template>

            <template v-if="item.message.role === 'human'" #meta>
              <ConversationMeta :message="item.message" />
              <GroupDispatchRow
                v-if="dispatchRows[item.message.id]"
                :presentation="dispatchRows[item.message.id]!"
                class="mt-2"
                @jump="jumpToMessage"
                @stop-member="handleStopMember"
                @stop-all="handleStopAll(dispatchRows[item.message.id]!)"
              />
              <GroupDispatchLeaderStop
                v-if="leaderStopAnchorIds.has(item.message.id)"
                :label="leaderStopLabel(dispatchRows[item.message.id]!)"
                @stop="handleStopLeader(dispatchRows[item.message.id]!)"
              />
            </template>
          </TranscriptRow>
          <!-- Plain bot message that shares its member bubble with an earlier row.
               A collapsed (aggregated) handoff renders nothing: it must never
               fall through to the bubble below and print its raw content. -->
          <TranscriptRow
            v-else-if="item.memberTurn"
            :key="item.key"
            :row-id="item.message.id"
            :data-anchor-id="item.message.id"
            :data-message-id="item.message.id"
            :driver="item.message.senderBotId ? driverForBot(item.message.senderBotId) : undefined"
            :speaker="senderName(item.message.senderBotId)"
            :speaker-role="item.message.senderBotId ? botById[item.message.senderBotId]?.role : undefined"
          >
            <template #avatar>
              <BotAvatar :avatar="item.message.senderBotId ? botById[item.message.senderBotId]?.avatar : undefined"
                         :driver="item.message.senderBotId ? driverForBot(item.message.senderBotId) : undefined"
                         :name="senderName(item.message.senderBotId)" :size="32" static
                         :retired="item.message.senderBotId ? botById[item.message.senderBotId]?.retired : false" />
            </template>
            <ConversationBubble :message="item.message" :attachments="item.message.attachments" />
            <ConversationMeta :message="item.message" />
          </TranscriptRow>
        </template>

        <!-- Canonical bubble-anchored reply: bubble above the reply body.
             A leader's own reply can own the aggregate row: it renders below. -->
        <template v-else-if="item.kind === 'message' && item.bubbleAnchor && item.memberTurn">
          <GroupAgentTurnRow
          :key="item.key"
          :member-turn="item.memberTurn"
          :bot="item.memberTurn.botId ? botById[item.memberTurn.botId] : undefined"
          :driver="item.memberTurn.botId ? driverForBot(item.memberTurn.botId) : undefined"
          :message="item.message"
          :name="senderName(item.memberTurn.botId)"
          :expanded="openDetailKey === bubbleKeyOf(item.memberTurn.id)"
          :controls="openDetailKey === bubbleKeyOf(item.memberTurn.id) ? detailId : undefined"
          :observed-completion="groupsStore.liveCompletedMemberTurns?.runId === item.memberTurn.runId && groupsStore.liveCompletedMemberTurns.ids[item.memberTurn.id] === true"
          :disabled="item.memberTurn.botId ? botById[item.memberTurn.botId] ? !botById[item.memberTurn.botId]!.enabled : false : false"
          :stopped="stoppedLeaderTurnIds.has(item.memberTurn.id)"
          @toggle="handleToggle(bubbleKeyOf(item.memberTurn.id), $event)"
        >
          </GroupAgentTurnRow>
          <div v-if="dispatchRows[item.message.id]" class="mx-auto w-full max-w-3xl">
            <GroupDispatchRow
              :presentation="dispatchRows[item.message.id]!"
              @jump="jumpToMessage"
              @stop-member="handleStopMember"
              @stop-all="handleStopAll(dispatchRows[item.message.id]!)"
            />
            <GroupDispatchLeaderStop
              v-if="leaderStopAnchorIds.has(item.message.id)"
              :label="leaderStopLabel(dispatchRows[item.message.id]!)"
              @stop="handleStopLeader(dispatchRows[item.message.id]!)"
            />
          </div>
        </template>
        <!-- Projection order closes each Run's block with its activity/routing rows. -->
        <div v-else-if="item.kind === 'member-activity'"
          :data-member-turn-id="item.memberTurn.id"
        >
          <p v-if="item.explanation" class="mb-1 text-xs text-warning" data-test="group-unresolved-activity">{{ explanationText(item.explanation) }}</p>
          <GroupAgentTurnRow
            :member-turn="item.memberTurn"
            :bot="botById[item.memberTurn.botId]"
            :driver="driverForBot(item.memberTurn.botId)"
            :name="senderName(item.memberTurn.botId)"
            :expanded="openDetailKey === bubbleKeyOf(item.memberTurn.id)"
            :controls="openDetailKey === bubbleKeyOf(item.memberTurn.id) ? detailId : undefined"
            :observed-completion="groupsStore.liveCompletedMemberTurns?.runId === item.memberTurn.runId && groupsStore.liveCompletedMemberTurns.ids[item.memberTurn.id] === true"
            :disabled="botById[item.memberTurn.botId] ? !botById[item.memberTurn.botId]!.enabled : false"
            :stopped="stoppedLeaderTurnIds.has(item.memberTurn.id)"
            @toggle="handleToggle(bubbleKeyOf(item.memberTurn.id), $event)"
          >
          </GroupAgentTurnRow>
        </div>

        <!-- Neutral routing entry: no invented Bot identity -->
        <TranscriptRow
          v-else-if="item.kind === 'routing'"
          data-test="group-routing-row"
          :row-id="`routing:${item.run.run.id}`"
          :data-anchor-id="`routing:${item.run.run.id}`"
          :data-run-id="item.run.run.id"
        >
          <div class="min-w-0">
            <AgentThinkingBubble
              :status="zeroMemberRunStatus(item.run.run.state)"
              :label="$t('group.bubble.routingLabel')"
              :expanded="openDetailKey === routingKeyOf(item.run.run.id)"
              :controls="openDetailKey === routingKeyOf(item.run.run.id) ? detailId : undefined"
              @toggle="handleToggle(routingKeyOf(item.run.run.id), $event)"
            />
            <p v-if="item.run.run.waitingQuestion" class="mt-0.5 break-words text-xs text-fg">{{ item.run.run.waitingQuestion }}</p>
            <p v-if="item.explanation" class="mt-0.5 text-xs text-warning">{{ explanationText(item.explanation) }}</p>
          </div>
        </TranscriptRow>

        <!-- Unresolved public reply: labeled, never guessed -->
        <TranscriptRow
          v-else-if="item.kind === 'unresolved'"
          :row-id="item.message.id"
          :data-anchor-id="item.message.id"
          :data-message-id="item.message.id"
          :driver="item.message.senderBotId ? driverForBot(item.message.senderBotId) : undefined"
          :speaker="senderName(item.message.senderBotId)"
          :speaker-role="item.message.senderBotId ? botById[item.message.senderBotId]?.role : undefined"
        >
          <template #avatar>
            <BotAvatar :avatar="item.message.senderBotId ? botById[item.message.senderBotId]?.avatar : undefined"
                       :driver="item.message.senderBotId ? driverForBot(item.message.senderBotId) : undefined"
                       :name="senderName(item.message.senderBotId)" :size="32" static
                       :retired="item.message.senderBotId ? botById[item.message.senderBotId]?.retired : false" />
          </template>
          <div class="rounded-lg bg-warning/10 px-2.5 py-1.5 text-xs text-warning" data-test="group-unresolved">
            <HelpCircle :size="12" class="mr-1 inline" />
            {{ explanationText(item.explanation) }}
          </div>
          <ConversationBubble :message="item.message" :attachments="item.message.attachments" />
          <ConversationMeta :message="item.message" />
        </TranscriptRow>
      </template>
    </div>

  </div>

  <!-- One detail state; mobile owns a modal sheet, desktop follows the bubble. -->
  <component :is="isMobile ? GroupRunDetailSheet : GroupRunDetailPopover"
    v-if="openDetail"
    :id="detailId"
    :scroller-el="scroller"
    :anchor-el="detailTriggerEl"
    :run="openDetail.run"
    :member-turn="openDetail.memberTurn"
    :member-name="openDetail.memberTurn ? senderName(openDetail.memberTurn.botId) : undefined"
    :topic-title="topic?.title"
    :attempt="selectedAttempt"
    :attempts="detailAttempts"
    :explanation="openDetail.explanation ? explanationText(openDetail.explanation) : undefined"
    :parts="detailParts"
    :recording-state="detailRecordingState"
    :plan="detailPlan"
    :trace-loading="detailPage?.loading"
    :trace-error="detailPage?.error"
    :trace-has-more="detailPage?.hasMore"
    :trace-has-earlier="detailPage?.hasEarlier"
    :trace-streaming="!!detailLive && !detailPage?.events.length"
    :trace-failure="detailTraceFailure"
    :stop-available="stopAvailable"
    :stop-pending="stopPending"
    :pause-available="pauseAvailable"
    :pause-pending="pausePending"
    :scroll-memory="detailScrollMemory"
    @close="closeDetail"
    @stop="handleStop"
    @pause="handlePause"
    @attempt="changeAttempt"
    @load-more="loadTrace()"
    @load-earlier="loadTrace(0)"
    @retry-trace="loadTrace()"
  />

  <!-- Terminal run states remain visible without a banner card: the neutral
       routing entry (or member bubbles) carries them in the popover. -->
  <TranscriptJumpLatest :visible="!atBottom" @jump="scrollToBottom()" />
</div>
</template>
