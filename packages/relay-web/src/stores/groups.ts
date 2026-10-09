import { defineStore } from "pinia";
import { computed, ref } from "vue";
import {
  MSG,
  isErrorPayload,
  type BotSummaryDto,
  type ConversationHistoryResponseDto,
  type ConversationMessageDto,
  type ConversationPromptResponseDto,
  type ConversationRunDetailDto,
  type ConversationRunDto,
  type ConversationRunStateDto,
  type ConversationTargetDto,
  type GroupDetailDto,
  type GroupsCreatePayload,
  type GroupsUpdatePayload,
  type GroupSummaryDto,
  type LiveTurnSnapshotDto,
  type MemberTurnSummaryDto,
  type PlanEntryDto,
  type ToolStepDto,
  type TopicSummaryDto,
  type TurnPartDto,
  type WebServerEvent,
} from "@ganglion/xacpx-relay-protocol";
import { api } from "../api/client";
import { useDirectBotsStore } from "./direct-bots";

/** Result of one send attempt.
 *  - `accepted`: the server durably took the prompt; the composer may drop the draft.
 *  - `uncertain`: transport/outcome-unknown; the frozen tuple replays the text, so
 *    the draft can be replaced by the Retry affordance.
 *  - `rejected`: a definitive refusal with no durable accept; nothing can replay
 *    the text, so the composer must KEEP the draft. */
export type GroupSendOutcome =
  /** The accept is confirmed: the text is in the transcript and the Run is projected. */
  | "accepted"
  /** Transport/ownership state is still unresolved: the frozen tuple replays the exact prompt. */
  | "uncertain"
  /** A definitive refusal: no durable accept exists, so the typed draft stays editable. */
  | "rejected"
  /** The send is no longer attributable to the current selection (Topic switched while
   *  it was in flight). Nothing may be projected, and the draft the user sees is not
   *  this prompt's. */
  | "orphaned";

export interface GroupLiveTurn {
  parts: TurnPartDto[];
  status: "working" | "streaming";
  startedAt: number;
  revision: number;
}

export type GroupTargetSelection =
  | { mode: "members"; botIds: string[] }
  | { mode: "everyone" }
  /** PR8 automatic routing: no human-selected member, the durable Run is
   *  accepted with zero MemberTurns and the capability-restricted Router
   *  decides each step. The state seam exists here; the composer affordance
   *  that CREATES this selection is separate UX work. A server that rejects
   *  automatic mode (`automatic_unsupported`) keeps the selection honest by
   *  failing the prompt rather than silently downgrading it. */
  | { mode: "automatic" };

/** An unfinished Run that holds one of the given members inside a Group. */
export interface GroupMemberWork {
  topic: TopicSummaryDto;
  run: ConversationRunDto;
  botIds: string[];
}

export type GroupErrorCode =
  | "connectorOutdated"
  | "discoveryFailed"
  | "ownershipUnconfirmed"
  | "ownershipChecking"
  | "topicRecovering"
  | "runInProgress"
  | "topicQueueFull"
  | "targetTooLarge"
  | "promptPendingConfirmation"
  | "cancelUnknown"
  | "instanceOffline"
  | "targetRequired"
  | "targetEmpty"
  | "targetUnknownMember";

class GroupRpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message || code);
    this.name = "GroupRpcError";
    this.code = code;
  }
}

function unwrapRpc<T>(result: T | { error: { code: string; message: string } }): T {
  if (isErrorPayload(result)) {
    if (result.error.code === "unknown-type") {
      throw new GroupRpcError(result.error.code, "connectorOutdated");
    }
    throw new GroupRpcError(result.error.code, result.error.message || result.error.code);
  }
  return result;
}

function appendText(parts: TurnPartDto[], chunk: string): void {
  const last = parts[parts.length - 1];
  if (last?.type === "text") last.text += chunk;
  else parts.push({ type: "text", text: chunk });
}

function appendReasoning(parts: TurnPartDto[], chunk: string): void {
  const last = parts[parts.length - 1];
  if (last?.type === "reasoning") {
    last.text += chunk;
    return;
  }
  if (!chunk.trim()) return;
  parts.push({ type: "reasoning", text: chunk });
}

function upsertTool(parts: TurnPartDto[], step: ToolStepDto): void {
  const i = parts.findIndex((p) => p.type === "tool" && p.step.toolCallId === step.toolCallId);
  if (i >= 0) parts[i] = { type: "tool", step };
  else parts.push({ type: "tool", step });
}

/** Server rejections that prove the durable accept never committed, so the
 *  frozen prompt tuple is dead weight and must be released.
 *
 *  This list mirrors the throw sites in ConversationRunService.acceptGroupPrompt()
 *  that sit BEFORE `store.acceptRequest()` — a rejection there can never have
 *  created durable rows. Everything else (transport loss, timeout, internal
 *  error, connector-too-old) is outcome-unknown and keeps the tuple frozen.
 *
 *  Codes (pre-acceptGroupPrompt): conversation_not_group
 *  Codes (parseGroupTarget): target_required, invalid-target, automatic_unsupported
 *  Codes (requireGroupTopic / barriers): topic_not_active, conversation_deleting,
 *    topic_deleting, topic_not_found
 *  Codes (requireExecutionTarget): execution_target_missing, cwd_unsupported,
 *    workspace_not_registered, invalid-isolation, worktree_unprovisioned
 *  Codes (resolveGroupMembers): empty_target, group_member_not_member
 *  Codes (snapshotGroupMemberProfile): bot_disabled
 *  Codes (isConversationDeleting / requester lookup): conversation_not_found,
 *    bot_not_found
 */
function isDefinitiveRejection(code: string | null): boolean {
  return code === "target_required"
    || code === "invalid-target"
    || code === "automatic_unsupported"
    || code === "conversation_not_group"
    || code === "conversation_not_found"
    || code === "conversation_deleting"
    || code === "topic_not_active"
    || code === "topic_deleting"
    || code === "topic_not_found"
    || code === "execution_target_missing"
    || code === "cwd_unsupported"
    || code === "workspace_not_registered"
    || code === "invalid-isolation"
    || code === "worktree_unprovisioned"
    || code === "empty_target"
    || code === "group_member_not_member"
    || code === "bot_disabled"
    || code === "target_too_large"
    || code === "bot_not_found"
    || code === "no_eligible_members"
    || code === "conversation_target_mismatch"
    || code === "conversation_mismatch"
    // AcceptRequest's own pre-insert guard: assertAcceptable() rejects a full
    // Topic queue BEFORE the transaction writes any durable row.
    || code === "topic_queue_full";
}

function mintRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

const RUN_STATE_PRECEDENCE: Record<ConversationRunStateDto, number> = {
  queued: 1,
  "waiting-human": 2,
  running: 2,
  completed: 3,
  failed: 3,
  cancelled: 3,
  indeterminate: 3,
};

function isTerminalRunState(state: ConversationRunStateDto | undefined): boolean {
  return state === "completed" || state === "failed" || state === "cancelled" || state === "indeterminate";
}

function isActiveRunState(state: ConversationRunStateDto | undefined): boolean {
  return state === "queued" || state === "running" || state === "waiting-human";
}

/** Mirrors the backend's group_member_has_work probe, which looks only at the
 *  member turn state. An indeterminate Run can still hold such a turn. */
function blocksMemberRemoval(state: MemberTurnSummaryDto["state"]): boolean {
  return state === "queued" || state === "dispatched" || state === "running";
}

function isClosedRunState(state: ConversationRunStateDto): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

/** Backend `indeterminate` seals scheduling but stays evidence-refinable:
 *  post-seal proof may move the Run `indeterminate → completed/failed/
 *  cancelled` (last unknown member reclassified) or refine an
 *  `indeterminate → indeterminate` snapshot (failedBotIds/progress). Only
 *  proved terminals reject stale nonterminal regressions, and the seal
 *  never reopens scheduling (`indeterminate → queued/running/waiting-human`
 *  stays rejected). */
function shouldUpdateRunState(current: ConversationRunStateDto | undefined, incoming: ConversationRunStateDto): boolean {
  if (!current) return true;
  if (current === incoming) return true;
  // PR8 waiting-human has no same-Run resume; delayed running reads are stale.
  if (current === "waiting-human" && incoming === "running") return false;
  // Proven terminals are evidence-final. Indeterminate is terminal for
  // SCHEDULING only — post-seal proof may still refine it (below).
  if (current === "completed" || current === "failed" || current === "cancelled") return false;
  if (current === "indeterminate") {
    return incoming === "completed" || incoming === "failed" || incoming === "cancelled" || incoming === "indeterminate";
  }
  return RUN_STATE_PRECEDENCE[incoming] >= RUN_STATE_PRECEDENCE[current];
}

function mergeRun(current: ConversationRunDto | null, incoming: ConversationRunDto): ConversationRunDto {
  if (!current || current.id !== incoming.id) {
    return incoming;
  }
  if (!shouldUpdateRunState(current.state, incoming.state)) {
    return current;
  }
  // PR8 routing substate and progress fields the incoming snapshot omits (an
  // older connector, or a projection built before the field existed) must not
  // erase the stored value: `routingState` is durable server state, not UI
  // state, and losing it re-opens "unknown" on a Run whose routing decision
  // is already known.
  const merged: ConversationRunDto = { ...incoming };
  if (merged.mode === "automatic" && merged.state === "waiting-human" && merged.waitingQuestion === undefined) {
    merged.waitingQuestion = current.waitingQuestion;
  } else if (merged.mode !== "automatic" || merged.state !== "waiting-human") {
    delete merged.waitingQuestion;
  }
  if (merged.routingState === undefined) merged.routingState = current.routingState;
  if (merged.activeBatch === undefined) merged.activeBatch = current.activeBatch;
  if (merged.maxMemberTurns === undefined) merged.maxMemberTurns = current.maxMemberTurns;
  if (merged.consumedMemberTurns === undefined) merged.consumedMemberTurns = current.consumedMemberTurns;
  if (merged.failedBotIds === undefined) merged.failedBotIds = current.failedBotIds;
  if (merged.unavailableBotIds === undefined) merged.unavailableBotIds = current.unavailableBotIds;
  // Run quarantine only grows. A delayed pre-failure snapshot cannot restore
  // an unavailable member; the global Bot catalog remains independent.
  if (current.quarantinedBotIds || incoming.quarantinedBotIds) {
    merged.quarantinedBotIds = [...new Set([...(current.quarantinedBotIds ?? []), ...(incoming.quarantinedBotIds ?? [])])];
  }
  if (merged.startedAt === undefined) merged.startedAt = current.startedAt;
  if (merged.finishedAt === undefined) merged.finishedAt = current.finishedAt;
  if (merged.completionReason === undefined) merged.completionReason = current.completionReason;
  // Same-state indeterminate snapshots still carry new evidence (failedBotIds
  // union, progress, timestamps): merge monotonically instead of swapping, so
  // a thinner stored snapshot never erases a richer one.
  if (current.state === "indeterminate" && incoming.state === "indeterminate") {
    const union = (...lists: Array<string[] | undefined>): string[] | undefined => {
      const seen: Record<string, true> = {};
      for (const list of lists) for (const id of list ?? []) seen[id] = true;
      const mergedIds = Object.keys(seen);
      return mergedIds.length > 0 ? mergedIds : undefined;
    };
    return {
      ...merged,
      state: "indeterminate",
      completionReason: incoming.completionReason ?? current.completionReason,
      failedBotIds: union(current.failedBotIds, incoming.failedBotIds),
      unavailableBotIds: union(current.unavailableBotIds, incoming.unavailableBotIds),
      consumedMemberTurns: current.consumedMemberTurns === undefined ? incoming.consumedMemberTurns : incoming.consumedMemberTurns === undefined ? current.consumedMemberTurns : Math.max(current.consumedMemberTurns, incoming.consumedMemberTurns),
      finishedAt: current.finishedAt ?? incoming.finishedAt,
    };
  }
  return merged;
}

const MEMBER_TURN_STATE_PRECEDENCE: Record<MemberTurnSummaryDto["state"], number> = {
  queued: 1,
  dispatched: 1,
  running: 2,
  completed: 3,
  failed: 3,
  cancelled: 3,
  indeterminate: 3,
};

function shouldUpdateMemberTurnState(
  current: MemberTurnSummaryDto["state"] | undefined,
  incoming: MemberTurnSummaryDto["state"],
): boolean {
  if (!current) return true;
  if (current === incoming) return true;
  // Proven terminals are final: stale nonterminal rows never regress them.
  if (current === "completed" || current === "failed" || current === "cancelled") return false;
  // Indeterminate seals SCHEDULING but stays evidence-refinable: post-seal
  // proof moves the member to its proven outcome. Anything that would
  // reopen scheduling (queued/dispatched/running) stays rejected.
  if (current === "indeterminate") {
    return incoming === "completed" || incoming === "failed";
  }
  return MEMBER_TURN_STATE_PRECEDENCE[incoming] >= MEMBER_TURN_STATE_PRECEDENCE[current];
}

/** Recovery reuses a MemberTurn ID. Attempt order precedes state order; an
 * older connector's omitted attempt is a thin snapshot of the known attempt. */
function memberAttemptOrder(current: MemberTurnSummaryDto, incoming: MemberTurnSummaryDto): number {
  return (incoming.attempt ?? current.attempt ?? 1) - (current.attempt ?? 1);
}

function mergeMemberTurn(current: MemberTurnSummaryDto | null, incoming: MemberTurnSummaryDto): MemberTurnSummaryDto {
  if (!current || current.id !== incoming.id) {
    return incoming;
  }
  const attemptOrder = memberAttemptOrder(current, incoming);
  if (attemptOrder < 0) return current;
  if (attemptOrder > 0) {
    // A new attempt may return to queued/dispatched. Execution evidence belongs
    // to that attempt only; preserve the durable assignment, never an old
    // source identity, start/finish timestamp or terminal failure evidence.
    const merged: MemberTurnSummaryDto = { ...incoming };
    if (merged.memberIndex === undefined) merged.memberIndex = current.memberIndex;
    if (merged.assignmentId === undefined) merged.assignmentId = current.assignmentId;
    if (merged.task === undefined) merged.task = current.task;
    if (merged.expectedOutput === undefined) merged.expectedOutput = current.expectedOutput;
    if (merged.dependsOn === undefined) merged.dependsOn = current.dependsOn;
    return merged;
  }
  if (!shouldUpdateMemberTurnState(current.state, incoming.state)) {
    // The stored row is newer than the incoming one (typically a terminal row
    // reconciled from a live event, followed by a stale `runs.get` or
    // recovery snapshot carrying an older non-terminal row). Keep the stored
    // row as the base — especially terminal evidence (failureReason,
    // promptRequestId) — and only fill fields the stored row is missing.
    // Spreading `incoming` first would let the older row's absent evidence
    // erase the newer row's proven terminal fields.
    const merged: MemberTurnSummaryDto = { ...current };
    if (merged.startedAt === undefined) merged.startedAt = incoming.startedAt;
    if (merged.finishedAt === undefined) merged.finishedAt = incoming.finishedAt;
    if (merged.promptRequestId === undefined) merged.promptRequestId = incoming.promptRequestId;
    if (merged.assignmentId === undefined) merged.assignmentId = incoming.assignmentId;
    if (merged.task === undefined) merged.task = incoming.task;
    if (merged.expectedOutput === undefined) merged.expectedOutput = incoming.expectedOutput;
    if (merged.dependsOn === undefined) merged.dependsOn = incoming.dependsOn;
    // PR8 blocked-step evidence is durable server state: a stale row that
    // omits it must not clear a turn the server marked as needing
    // human-origin authority.
    if (merged.blockedReason === undefined) merged.blockedReason = incoming.blockedReason;
    return merged;
  }
  const merged: MemberTurnSummaryDto = { ...incoming };
  if (merged.attempt === undefined) merged.attempt = current.attempt;
  if (merged.memberIndex === undefined) merged.memberIndex = current.memberIndex;
  if (merged.startedAt === undefined) merged.startedAt = current.startedAt;
  if (merged.finishedAt === undefined) merged.finishedAt = current.finishedAt;
  if (merged.promptRequestId === undefined) merged.promptRequestId = current.promptRequestId;
  if (merged.assignmentId === undefined) merged.assignmentId = current.assignmentId;
  if (merged.task === undefined) merged.task = current.task;
  if (merged.expectedOutput === undefined) merged.expectedOutput = current.expectedOutput;
  if (merged.dependsOn === undefined) merged.dependsOn = current.dependsOn;
  // Thin same-state snapshots do not revoke durable evidence. On a real
  // state transition, failure evidence belongs to the incoming outcome.
  if (current.state === incoming.state) {
    if (merged.failureReason === undefined) merged.failureReason = current.failureReason;
    if (merged.blockedReason === undefined) merged.blockedReason = current.blockedReason;
  }
  return merged;
}

function mergeMemberTurns(
  current: Record<string, MemberTurnSummaryDto>,
  incoming: MemberTurnSummaryDto[],
): Record<string, MemberTurnSummaryDto> {
  const next = { ...current };
  for (const turn of incoming) {
    const prior = next[turn.id] ?? null;
    next[turn.id] = mergeMemberTurn(prior, turn);
  }
  return next;
}

const PERSISTED_GROUP_SELECTION_KEY = "xrelay.selectedGroup";

export interface PersistedGroupSelection {
  instanceId: string;
  groupId: string;
}

export function loadPersistedGroupSelection(): PersistedGroupSelection | null {
  try {
    const raw = localStorage.getItem(PERSISTED_GROUP_SELECTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.instanceId === "string" && typeof parsed.groupId === "string") {
      return { instanceId: parsed.instanceId, groupId: parsed.groupId };
    }
  } catch {
    // Ignore storage parse issues
  }
  return null;
}

function persistGroupSelection(instanceId: string | null, groupId: string | null): void {
  try {
    if (instanceId && groupId) {
      localStorage.setItem(PERSISTED_GROUP_SELECTION_KEY, JSON.stringify({ instanceId, groupId }));
    } else {
      localStorage.removeItem(PERSISTED_GROUP_SELECTION_KEY);
    }
  } catch {
    // Ignore storage issues
  }
}

/**
 * PR7 explicit Group collaboration slice. Mirrors the Direct-Bot store's
 * durability contract (seq-cursor transcript, authoritative owner discovery,
 * exact-ID event joins) but keys selection by Group identity and routes every
 * prompt through a structured explicit target. No automatic routing: the
 * composer always sends an explicit members/everyone selection.
 */
export const useGroupsStore = defineStore("groups", () => {
  // Shared Bot catalog: Group default targets and member labels need the
  // enabled state the Direct list already resolves. Read-only consumer.
  const directBotsStore = useDirectBotsStore();
  let currentSelectionGeneration = 0;
  let recoveryGeneration = 0;
  let historyRequestSequence = 0;
  let discoverySequence = 0;
  let transcriptRevision = 0;
  function touchTranscript(): void {
    transcriptRevision += 1;
  }
  function advanceContiguousForSeq(seq: number): void {
    if (contiguousNewestSeq.value !== undefined && seq === contiguousNewestSeq.value + 1) {
      contiguousNewestSeq.value = seq;
    } else if (contiguousNewestSeq.value === undefined) {
      contiguousNewestSeq.value = seq;
    }
  }

  const instanceId = ref<string | null>(null);
  const selectedGroupId = ref<string | null>(null);
  const activeConversationId = ref<string | null>(null);
  const activeTopicId = ref<string | null>(null);

  const groupsByInstance = ref<Record<string, GroupSummaryDto[]>>({});
  const groupDetails = ref<Record<string, GroupDetailDto>>({});
  const loadingGroupsByInstance = ref<Record<string, number>>({});
  const loadingGroups = computed<boolean>(() =>
    Object.values(loadingGroupsByInstance.value).some((n) => n > 0),
  );
  const groupsLoaded = ref<Record<string, boolean>>({});
  const groupsListSeq: Record<string, number> = {};

  const topicsByConversation = ref<Record<string, TopicSummaryDto[]>>({});
  const topicsSeq: Record<string, number> = {};
  /** Revision bumped only by Topic events (never by a topics.list fetch), so a
   *  reconciler can tell "my own fetch moved the counter" from "a concurrent
   *  event changed Topic state while I was waiting". */
  const topicEventRevision: Record<string, number> = {};
  /** Deletion epoch, bumped ONLY when a Topic authoritatively disappears (a
   *  coarse reconciliation committing a snapshot that dropped Topics, or a Topic
   *  event deleting one). A Topic teardown publishes no tombstone, so a deletion
   *  is knowledge that exists only in the writer that observed it: any list
   *  request that captured an older epoch and returns afterwards is carrying a
   *  snapshot taken BEFORE that deletion, and must never be merged into the
   *  cache — doing so resurrects the deleted Topic. */
  const topicDeletionEpoch: Record<string, number> = {};
  /** Latest-request fence for coarse Topic refreshes: the newest refresh owns the
   *  commit, so two out-of-order conversations-changed responses cannot rewind
   *  each other's deletion. */
  const topicRefreshSeq: Record<string, number> = {};

  const messages = ref<ConversationMessageDto[]>([]);
  const oldestSeq = ref<number | undefined>(undefined);
  const newestSeq = ref<number | undefined>(undefined);
  const contiguousNewestSeq = ref<number | undefined>(undefined);
  const hasMoreBefore = ref<boolean>(false);
  const hasMoreAfter = ref<boolean>(false);
  const loadingHistory = ref<boolean>(false);
  const loadingOlder = ref<boolean>(false);
  let olderRequestToken = 0;
  let olderRequestOwner = "";
  function retireOlderRequest(): void {
    olderRequestToken += 1;
    olderRequestOwner = "";
    loadingOlder.value = false;
  }

  const historyError = ref<string | null>(null);
  const historyErrorDetail = ref<string | null>(null);
  const topicReady = ref<boolean>(true);

  const activeRun = ref<ConversationRunDto | null>(null);
  const memberTurnsById = ref<Record<string, MemberTurnSummaryDto>>({});
  const liveTurnsByMember = ref<Record<string, GroupLiveTurn>>({});
  const planByRunId = ref<Record<string, PlanEntryDto[]>>({});
  const latestPlanRunId = ref<string | null>(null);
  const planEntries = computed<PlanEntryDto[]>(() => {
    const currentId = activeRun.value?.id ?? latestPlanRunId.value;
    if (!currentId) return [];
    return planByRunId.value[currentId] ?? [];
  });
  const cancellingRunId = ref<string | null>(null);

  const runParts = ref<Record<string, TurnPartDto[]>>({});
  const runPartsComplete = ref<Record<string, true>>({});
  const runPartsTruncated = ref<Record<string, true>>({});
  const completeRunParts = computed<Record<string, TurnPartDto[]>>(() => {
    const out: Record<string, TurnPartDto[]> = {};
    for (const [id, parts] of Object.entries(runParts.value)) {
      if (parts.length && runPartsComplete.value[id] && !runPartsTruncated.value[id]) out[id] = parts;
    }
    return out;
  });

  /** A MemberTurn survives recovery, but its physical execution trace does not.
   * Retire all trace projections together whenever durable attempt identity
   * advances, including discovery/reconnect paths that see no start event. */
  function applyMemberTurns(incoming: MemberTurnSummaryDto[]): void {
    for (const turn of incoming) {
      const current = memberTurnsById.value[turn.id];
      if (!current || memberAttemptOrder(current, turn) <= 0) continue;
      const keys = [turn.id, ...(current.promptRequestId ? [current.promptRequestId] : [])];
      for (const key of keys) {
        delete liveTurnsByMember.value[key];
        delete runParts.value[key];
        delete runPartsComplete.value[key];
        delete runPartsTruncated.value[key];
      }
    }
    memberTurnsById.value = mergeMemberTurns(memberTurnsById.value, incoming);
  }

  /** A prompt whose accept outcome is uncertain (request sent, response lost or
   *  errored). The tuple is immutable and is what any retry replays verbatim:
   *  the server keyed the durable accept on (conversation, topic, requestId), so
   *  a retry must NOT re-resolve the current UI target — that would silently
   *  re-route an already-durable Run to different members. */
  interface UncertainPrompt {
    requestId: string;
    text: string;
    target: ConversationTargetDto;
  }
  const uncertainPrompt = ref<UncertainPrompt | null>(null);
  /** Promise of the in-flight send attempt; the composer awaits it to learn
   *  whether the draft still needs to be kept. */
  const inFlightSend = ref<Promise<GroupSendOutcome> | null>(null);
  /** False while the Bot catalog for the selected Group is unconfirmed. Derived
   *  from the Direct store's own botsLoaded rather than a sticky local flag, so a
   *  successful later refresh (bots-changed, navigating back) converges this back
   *  to known instead of pinning the composer in fail-narrow mode forever. */
  const botCatalogKnown = computed<boolean>(() => {
    const instId = instanceId.value;
    if (!instId) return true;
    return directBotsStore.botsLoaded[instId] === true;
  });
  /** Text of the pending-certainty prompt; drives the Retry affordance. */
  const uncertainPromptText = computed<string | null>(() => uncertainPrompt.value?.text ?? null);
  /** True while a sent prompt has an unknown durable outcome. The composer locks
   *  the target selector and Send until the user retries the frozen tuple (or
   *  reconciliation proves it landed). */
  const hasUncertainPrompt = computed<boolean>(() => uncertainPrompt.value !== null);
  /** Target frozen with the uncertain prompt. A retry replays exactly this. */
  const uncertainPromptTarget = computed<ConversationTargetDto | null>(() => uncertainPrompt.value?.target ?? null);
  const promptInFlight = ref<boolean>(false);
  const promptError = ref<string | null>(null);
  const promptErrorDetail = ref<string | null>(null);
  const cancelError = ref<string | null>(null);
  const cancelUncertaintyRunId = ref<string | null>(null);
  function resolveCancelUncertainty(runId: string): void {
    if (cancelUncertaintyRunId.value === runId) {
      cancelUncertaintyRunId.value = null;
      cancelError.value = null;
    }
  }
  const ownershipUncertain = ref<boolean>(false);
  const ownerUnconfirmed = computed<boolean>(() => ownershipUncertain.value);

  const generalError = ref<string | null>(null);
  const generalErrorCode = ref<string | null>(null);

  // Explicit target selection: IDs are authority, display names never route.
  // Default is the Group lead (explicit-only release), falling back to a
  // deterministic first-by-ID member when no lead is set.
  const targetSelection = ref<GroupTargetSelection | null>(null);

  const isGroupSelected = computed(() => !!instanceId.value && !!selectedGroupId.value);
  const currentGroups = computed(() => (instanceId.value ? groupsByInstance.value[instanceId.value] ?? [] : []));
  const currentGroup = computed<GroupSummaryDto | GroupDetailDto | undefined>(() => {
    if (!instanceId.value || !selectedGroupId.value) return undefined;
    const detailKey = `${instanceId.value}:${selectedGroupId.value}`;
    return groupDetails.value[detailKey] ?? currentGroups.value.find((g) => g.id === selectedGroupId.value);
  });
  const currentTopics = computed(() => {
    if (!instanceId.value || !activeConversationId.value) return [];
    return topicsByConversation.value[`${instanceId.value}:${activeConversationId.value}`] ?? [];
  });
  const currentTopic = computed(() => {
    if (!activeTopicId.value) return undefined;
    return currentTopics.value.find((t) => t.id === activeTopicId.value);
  });
  const isRunActive = computed(() => {
    const s = activeRun.value?.state;
    return s === "queued" || s === "running" || s === "waiting-human";
  });
  const memberTurns = computed<MemberTurnSummaryDto[]>(() => {
    const runId = activeRun.value?.id;
    if (!runId) return [];
    return Object.values(memberTurnsById.value)
      .filter((turn) => turn.runId === runId)
      .sort((a, b) => (a.memberIndex ?? 0) - (b.memberIndex ?? 0) || a.id.localeCompare(b.id));
  });
  const liveTurns = computed<Record<string, GroupLiveTurn>>(() => liveTurnsByMember.value);

  /** Default target for a freshly opened Group: the enabled lead if the lead is
   *  still executable, else the first enabled member in stable ID order, else
   *  everyone (which itself expands to the eligible set). A disabled lead must
   *  never become a default that the first send cannot execute. */
  /** Default target for a freshly opened Group.
   *
   *  `catalogKnown` must be false when the Bot catalog could not be confirmed
   *  (bots.list failed and nothing is cached). Eligibility metadata is
   *  presentation context, so an RPC failure must fail narrow — never widen:
   *  returning `everyone` on an unknown catalog would expand execution from the
   *  lead Bot to the whole Group because of a read-only listing failure.
   *
   *  With a known catalog the order is: enabled lead, then the first enabled
   *  member in stable ID order. Without one, the lead (or first member by ID)
   *  stays the single-member default and the server authoritatively rejects it
   *  if that Bot is disabled. */
  function defaultTargetFor(
    group: GroupSummaryDto | GroupDetailDto,
    bots: BotSummaryDto[],
    catalogKnown = true,
  ): GroupTargetSelection {
    const fallback = (): GroupTargetSelection => {
      if (group.leadBotId && group.botIds.includes(group.leadBotId)) {
        return { mode: "members", botIds: [group.leadBotId] };
      }
      const first = [...group.botIds].sort()[0];
      return first ? { mode: "members", botIds: [first] } : { mode: "everyone" };
    };
    if (!catalogKnown) {
      return fallback();
    }
    const eligible = group.botIds.filter((id) => bots.find((b) => b.id === id)?.enabled);
    if (group.leadBotId && eligible.includes(group.leadBotId)) {
      return { mode: "members", botIds: [group.leadBotId] };
    }
    const first = [...eligible].sort()[0];
    return first ? { mode: "members", botIds: [first] } : { mode: "everyone" };
  }

  /** Resolver for UI actions that must respect the unconfirmed-catalog rule.
   *  Takes the Bot rows the caller can see so it stays correct for both the
   *  Group-open default and the Lead shortcut. */
  function eligibleTargetFor(group: GroupSummaryDto | GroupDetailDto, bots: BotSummaryDto[]): GroupTargetSelection {
    return defaultTargetFor(group, bots, botCatalogKnown.value);
  }

  const sendPromptOutcomePromise = computed<Promise<GroupSendOutcome>>(
    () => inFlightSend.value ?? Promise.resolve("accepted" as GroupSendOutcome),
  );

  function resolveTarget(): { target: ConversationTargetDto } | { error: "targetRequired" | "targetEmpty" } {
    const selection = targetSelection.value;
    if (!selection) return { error: "targetRequired" };
    // PR8: automatic is a first-class wire target, not an empty member list.
    // Never synthesize `members: []` for it — that is a malformed target, not
    // an automatic Run.
    if (selection.mode === "everyone") return { target: { mode: "everyone" } };
    if (selection.mode === "automatic") return { target: { mode: "automatic" } };
    const deduped = [...new Set(selection.botIds)];
    if (deduped.length === 0) return { error: "targetEmpty" };
    return { target: { mode: "members", botIds: deduped } };
  }

  /** True when the current selection can be resolved into a wire target. Lets the
   *  composer disable Send (and keep the draft) instead of throwing the typed
   *  message away after the store rejects it. */
  const targetResolvable = computed<boolean>(() => !("error" in resolveTarget()));

  /** Surface the reason a prompt was refused without touching the draft. */
  function reportTargetProblem(): void {
    const resolved = resolveTarget();
    if ("error" in resolved) {
      promptError.value = resolved.error === "targetRequired" ? "targetRequired" : "targetEmpty";
      promptErrorDetail.value = null;
    }
  }

  function setTarget(selection: GroupTargetSelection): void {
    if (selection.mode === "members") {
      targetSelection.value = { mode: "members", botIds: [...new Set(selection.botIds)] };
    } else if (selection.mode === "automatic") {
      targetSelection.value = { mode: "automatic" };
    } else {
      targetSelection.value = { mode: "everyone" };
    }
  }

  function toggleTargetMember(botId: string): void {
    const current = targetSelection.value;
    // Automatic and everyone both mean "no member list yet": picking a member
    // from either is an explicit human selection and replaces it.
    if (!current || current.mode === "everyone" || current.mode === "automatic") {
      targetSelection.value = { mode: "members", botIds: [botId] };
      return;
    }
    const next = current.botIds.includes(botId)
      ? current.botIds.filter((id) => id !== botId)
      : [...current.botIds, botId];
    targetSelection.value = { mode: "members", botIds: [...new Set(next)] };
  }

  function mentionBot(botId: string): void {
    const group = currentGroup.value;
    if (!group) return;
    if (!group.botIds.includes(botId)) return;
    const current = targetSelection.value;
    if (!current) {
      targetSelection.value = { mode: "members", botIds: [botId] };
      return;
    }
    if (current.mode === "everyone" || current.mode === "automatic") {
      // Explicit mention narrows the target back to members: staying in
      // everyone (or letting the Router decide) would ignore every later
      // `@Name`.
      targetSelection.value = { mode: "members", botIds: [botId] };
      return;
    }
    if (!current.botIds.includes(botId)) {
      targetSelection.value = { mode: "members", botIds: [...current.botIds, botId] };
    }
  }

  function mentionEveryone(): void {
    targetSelection.value = { mode: "everyone" };
  }

  /** Per-instance groups-list failures. Empty state must only render for a
   *  SUCCESSFUL empty listing — a failed RPC is retryable, never an
   *  authoritative empty list. Kept separate from groupsLoaded so a failed
   *  fetch does not masquerade as "no groups". Cleared by the next load
   *  attempt; the tree retries automatically on every Groups-mode entry
   *  (groupsLoaded stays false) and via the inline retry affordance. */
  const groupsListErrorByInstance = ref<Record<string, string>>({});

  async function loadGroups(targetInstanceId: string): Promise<GroupSummaryDto[]> {
    const seq = (groupsListSeq[targetInstanceId] ?? 0) + 1;
    groupsListSeq[targetInstanceId] = seq;
    loadingGroupsByInstance.value = {
      ...loadingGroupsByInstance.value,
      [targetInstanceId]: (loadingGroupsByInstance.value[targetInstanceId] ?? 0) + 1,
    };
    // A new attempt supersedes the previous failure (stale or resolved).
    if (groupsListErrorByInstance.value[targetInstanceId] !== undefined) {
      const cleared = { ...groupsListErrorByInstance.value };
      delete cleared[targetInstanceId];
      groupsListErrorByInstance.value = cleared;
    }
    try {
      const res = unwrapRpc(
        await api.rpc<{ groups: GroupSummaryDto[] }>(targetInstanceId, MSG.groupsList, {}),
      );
      if (groupsListSeq[targetInstanceId] !== seq) {
        return groupsByInstance.value[targetInstanceId] ?? res.groups;
      }
      groupsByInstance.value = { ...groupsByInstance.value, [targetInstanceId]: res.groups };
      groupsLoaded.value = { ...groupsLoaded.value, [targetInstanceId]: true };
      return res.groups;
    } catch (err: unknown) {
      // Failed listings are NOT empty listings: record the failure so the
      // tree can offer retry instead of rendering "No groups".
      if (groupsListSeq[targetInstanceId] === seq) {
        groupsListErrorByInstance.value = {
          ...groupsListErrorByInstance.value,
          [targetInstanceId]: err instanceof Error ? err.message : String(err),
        };
      }
      throw err;
    } finally {
      const remaining = (loadingGroupsByInstance.value[targetInstanceId] ?? 1) - 1;
      if (remaining <= 0) {
        const next = { ...loadingGroupsByInstance.value };
        delete next[targetInstanceId];
        loadingGroupsByInstance.value = next;
      } else {
        loadingGroupsByInstance.value = { ...loadingGroupsByInstance.value, [targetInstanceId]: remaining };
      }
    }
  }

  async function loadGroupDetail(targetInstanceId: string, groupId: string): Promise<GroupDetailDto> {
    const res = unwrapRpc(
      await api.rpc<{ group: GroupDetailDto }>(targetInstanceId, MSG.groupsGet, { id: groupId }),
    );
    const detailKey = `${targetInstanceId}:${groupId}`;
    groupDetails.value = { ...groupDetails.value, [detailKey]: res.group };
    return res.group;
  }

  function mergeGroupSummary(targetInstanceId: string, group: GroupSummaryDto): void {
    const list = groupsByInstance.value[targetInstanceId] ?? [];
    const idx = list.findIndex((g) => g.id === group.id);
    const next = idx >= 0 ? [...list.slice(0, idx), group, ...list.slice(idx + 1)] : [...list, group];
    groupsByInstance.value = { ...groupsByInstance.value, [targetInstanceId]: next };
    groupsLoaded.value = { ...groupsLoaded.value, [targetInstanceId]: true };
    const detailKey = `${targetInstanceId}:${group.id}`;
    const detail = groupDetails.value[detailKey];
    if (detail) groupDetails.value = { ...groupDetails.value, [detailKey]: { ...detail, ...group } };
  }

  function forgetGroup(targetInstanceId: string, groupId: string): void {
    const list = groupsByInstance.value[targetInstanceId] ?? [];
    groupsByInstance.value = { ...groupsByInstance.value, [targetInstanceId]: list.filter((g) => g.id !== groupId) };
    const key = `${targetInstanceId}:${groupId}`;
    const { [key]: _detail, ...details } = groupDetails.value;
    groupDetails.value = details;
    const { [key]: _topics, ...topics } = topicsByConversation.value;
    topicsByConversation.value = topics;
    if (instanceId.value === targetInstanceId && selectedGroupId.value === groupId) clearSelection();
  }

  // The write already committed when the RPC resolves, so a failed follow-up
  // list refresh must not report it as failed. A retry would mint a second Group.
  async function createGroup(targetInstanceId: string, input: GroupsCreatePayload): Promise<GroupSummaryDto> {
    const res = unwrapRpc(
      await api.rpc<{ group: GroupSummaryDto }>(targetInstanceId, MSG.groupsCreate, input),
    );
    mergeGroupSummary(targetInstanceId, res.group);
    void loadGroups(targetInstanceId).catch(() => {});
    return res.group;
  }

  async function updateGroup(
    targetInstanceId: string,
    groupId: string,
    patch: Omit<GroupsUpdatePayload, "id">,
  ): Promise<GroupSummaryDto> {
    const res = unwrapRpc(
      await api.rpc<{ group: GroupSummaryDto }>(targetInstanceId, MSG.groupsUpdate, { id: groupId, ...patch }),
    );
    mergeGroupSummary(targetInstanceId, res.group);
    const selection = targetSelection.value;
    if (
      instanceId.value === targetInstanceId
      && selectedGroupId.value === groupId
      && selection?.mode === "members"
    ) {
      const kept = selection.botIds.filter((id) => res.group.botIds.includes(id));
      if (kept.length !== selection.botIds.length) {
        targetSelection.value = kept.length > 0
          ? { mode: "members", botIds: kept }
          : eligibleTargetFor(res.group, directBotsStore.botsByInstance[targetInstanceId] ?? []);
      }
    }
    void loadGroups(targetInstanceId).catch(() => {});
    return res.group;
  }

  // Group delete runs the full teardown and can outlive the RPC deadline. A
  // timeout or failure says nothing about whether the Group is gone, so the
  // list is re-read before the outcome is reported.
  async function deleteGroup(targetInstanceId: string, groupId: string): Promise<void> {
    try {
      unwrapRpc(await api.rpc<{ ok: boolean }>(targetInstanceId, MSG.groupsDelete, { id: groupId }));
    } catch (err: unknown) {
      const groups = await loadGroups(targetInstanceId).catch(() => null);
      if (!groups || groups.some((g) => g.id === groupId)) throw err;
    }
    forgetGroup(targetInstanceId, groupId);
    void loadGroups(targetInstanceId).catch(() => {});
  }

  async function findMemberWork(
    targetInstanceId: string,
    groupId: string,
    botIds: string[],
  ): Promise<GroupMemberWork[]> {
    const detail = await loadGroupDetail(targetInstanceId, groupId);
    const perTopic = await Promise.all(detail.topics.map(async (topic) => {
      const listed = unwrapRpc(
        await api.rpc<{ runs: ConversationRunDto[]; activeRun?: ConversationRunDto }>(targetInstanceId, MSG.runsList, {
          conversationId: groupId,
          topicId: topic.id,
          limit: 200,
        }),
      );
      const open = new Map<string, ConversationRunDto>();
      for (const run of [...listed.runs, ...(listed.activeRun ? [listed.activeRun] : [])]) {
        if (!isClosedRunState(run.state)) open.set(run.id, run);
      }
      return await Promise.all([...open.values()].map(async (run): Promise<GroupMemberWork | null> => {
        const { run: full } = unwrapRpc(
          await api.rpc<{ run: ConversationRunDetailDto }>(targetInstanceId, MSG.runsGet, { runId: run.id }),
        );
        const held = full.memberTurns
          .filter((turn) => botIds.includes(turn.botId) && blocksMemberRemoval(turn.state))
          .map((turn) => turn.botId);
        return held.length > 0 ? { topic, run, botIds: [...new Set(held)] } : null;
      }));
    }));
    return perTopic.flat().filter((work): work is GroupMemberWork => work !== null);
  }

  async function cancelRun(targetInstanceId: string, runId: string): Promise<void> {
    unwrapRpc(await api.rpc<{ run: ConversationRunDetailDto }>(targetInstanceId, MSG.runsCancel, { runId }));
  }

  /** The single way a wholesale Topic snapshot reaches the cache. Any writer
   *  that authoritatively replaces the list is, by construction, a writer that can
   *  observe a disappearance — so every such writer must advance the deletion
   *  epoch here rather than at its own call site. That keeps in-flight requests
   *  holding pre-deletion snapshots discarding them instead of merging the
   *  deleted Topic back in, regardless of which writer observed the deletion
   *  first (coarse refresh, or an ordinary newest-request list). */
  function commitTopicSnapshot(key: string, next: TopicSummaryDto[]): TopicSummaryDto[] {
    const previous = topicsByConversation.value[key] ?? [];
    const droppedAny = previous.some((topic) => !next.some((item) => item.id === topic.id));
    if (droppedAny) {
      topicDeletionEpoch[key] = (topicDeletionEpoch[key] ?? 0) + 1;
    }
    topicsByConversation.value = { ...topicsByConversation.value, [key]: next };
    return next;
  }

  async function loadTopics(targetInstanceId: string, conversationId: string): Promise<TopicSummaryDto[]> {
    const key = `${targetInstanceId}:${conversationId}`;
    const seq = (topicsSeq[key] ?? 0) + 1;
    topicsSeq[key] = seq;
    const epochBefore = topicDeletionEpoch[key] ?? 0;
    const res = unwrapRpc(
      await api.rpc<{ topics: TopicSummaryDto[] }>(targetInstanceId, MSG.topicsList, { conversationId }),
    );
    if (topicsSeq[key] !== seq) {
      // A newer request already landed, so this snapshot is stale. When the
      // cache moved because of a DELETION epoch, this response predates the
      // deletion and merging it would resurrect the deleted Topic: discard it
      // and read back the current cache.
      if ((topicDeletionEpoch[key] ?? 0) !== epochBefore) {
        return topicsByConversation.value[key] ?? [];
      }
      const currentList = topicsByConversation.value[key] ?? [];
      const merged: Record<string, TopicSummaryDto> = {};
      for (const t of res.topics) merged[t.id] = t;
      for (const t of currentList) merged[t.id] = t;
      const next = Object.values(merged);
      topicsByConversation.value = { ...topicsByConversation.value, [key]: next };
      return next;
    }
    // This is the newest request, so its snapshot is authoritative for the
    // cache: replace wholesale so a Topic deleted since the last fetch actually
    // leaves the list. The commit helper advances the deletion epoch, which is
    // what lets an older in-flight request discard instead of resurrect.
    return commitTopicSnapshot(key, res.topics);
  }

  /** Authoritative Topic snapshot for the selected Group, or null when none
   *  could be established.
   *
   *  A Topic teardown publishes no tombstone, so reconciliation can never merge
   *  event-driven state into an HTTP list — and `loadTopics` would do exactly
   *  that (it re-merges the previous cache whenever the Topic revision moved
   *  during its request), resurrecting a just-deleted Topic. This path therefore
   *  fetches raw, keeps its OWN revision counter instead of borrowing one that
   *  `loadTopics` increments, and only commits a snapshot taken in a window with
   *  no Topic event.
   *
   *  Returns null on any abort: selection went stale, or the Topic stream stayed
   *  too busy to produce a clean window. A null result means "not reconciled"
   *  and must never be mistaken for "the Topic list is now empty". */
  async function authoritativeTopics(
    instId: string,
    conversationId: string,
    isStale: () => boolean,
  ): Promise<TopicSummaryDto[] | null> {
    const key = `${instId}:${conversationId}`;
    // Latest-request fence for coarse refreshes: if a newer refresh is already
    // in flight, this one must not commit afterwards and undo its deletion.
    const requestId = (topicRefreshSeq[key] ?? 0) + 1;
    topicRefreshSeq[key] = requestId;
    for (let attempt = 0; attempt < 4; attempt++) {
      const revisionBefore = topicEventRevision[key] ?? 0;
      const res = unwrapRpc(
        await api.rpc<{ topics: TopicSummaryDto[] }>(instId, MSG.topicsList, { conversationId }),
      );
      if (isStale() || topicRefreshSeq[key] !== requestId) return null;
      if ((topicEventRevision[key] ?? 0) === revisionBefore) {
        // Clean window: commit this snapshot wholesale, replacing (not merging
        // with) the cache so a vanished Topic is actually removed from it.
        topicsSeq[key] = (topicsSeq[key] ?? 0) + 1;
        const previous = topicsByConversation.value[key] ?? [];
        const next = res.topics;
        return commitTopicSnapshot(key, next);
      }
      // A Topic event landed during this request: this snapshot says nothing
      // about what was deleted, so ask again.
    }
    return null;
  }

  /** Authoritative Topic refresh for the selected Group. Replaces the cached
   *  list wholesale (a teardown must disappear, not merge) and converges the
   *  active selection when the active Topic no longer exists: prefer the first
   *  active Topic, otherwise drop the selection so the composer cannot offer a
   *  send that the server would refuse. */
  async function refreshTopicsForSelection(conversationId: string): Promise<void> {
    const instId = instanceId.value;
    if (!instId || activeConversationId.value !== conversationId) return;
    // Capture the identity so the post-await writes cannot apply to a different
    // Group. Without this, a slow topics.list for Group A would land after the
    // user opened Group B and compare B's activeTopicId against A's Topic list.
    const generation = currentSelectionGeneration;
    const groupId = selectedGroupId.value;
    const isStale = (): boolean => generation !== currentSelectionGeneration
      || instanceId.value !== instId
      || selectedGroupId.value !== groupId
      || activeConversationId.value !== conversationId;
    const topics = await authoritativeTopics(instId, conversationId, isStale);
    if (topics === null) {
      // Not reconciled: either the selection changed ownership or the Topic
      // stream never produced an event-free snapshot. Fail closed — keep the
      // current cache and active Topic rather than commit an unproven list.
      return;
    }
    const stillThere = activeTopicId.value
      ? topics.some((topic) => topic.id === activeTopicId.value)
      : false;
    if (activeTopicId.value && !stillThere) {
      const nextActive = topics.find((topic) => topic.status === "active");
      if (nextActive) {
        await switchTopic(nextActive.id);
      } else {
        // No active Topic remains: clear the active selection entirely.
        const generation = ++currentSelectionGeneration;
        void generation;
        activeTopicId.value = null;
        messages.value = [];
        oldestSeq.value = undefined;
        newestSeq.value = undefined;
        contiguousNewestSeq.value = undefined;
        hasMoreBefore.value = false;
        hasMoreAfter.value = false;
        activeRun.value = null;
        memberTurnsById.value = {};
        liveTurnsByMember.value = {};
        topicReady.value = true;
        targetSelection.value = topics.length > 0 ? targetSelection.value : null;
        uncertainPrompt.value = null;
      }
    }
  }

  async function createGroupTopic(
    targetInstanceId: string,
    conversationId: string,
    title: string,
    target: { workspace: string; isolation: "shared" | "shared-single-writer" | "worktree-per-member" },
  ): Promise<TopicSummaryDto> {
    const res = unwrapRpc(
      await api.rpc<{ topic: TopicSummaryDto }>(targetInstanceId, MSG.groupTopicsCreate, {
        conversationId,
        title,
        target,
      }),
    );
    const key = `${targetInstanceId}:${conversationId}`;
    topicsSeq[key] = (topicsSeq[key] ?? 0) + 1;
    const currentList = topicsByConversation.value[key] ?? [];
    const idx = currentList.findIndex((t) => t.id === res.topic.id);
    if (idx >= 0) {
      const next = [...currentList];
      next[idx] = res.topic;
      topicsByConversation.value = { ...topicsByConversation.value, [key]: next };
    } else {
      topicsByConversation.value = { ...topicsByConversation.value, [key]: [...currentList, res.topic] };
    }
    if (instanceId.value === targetInstanceId && activeConversationId.value === conversationId) {
      await switchTopic(res.topic.id);
    }
    return res.topic;
  }

  function pruneIncompleteTraces(): void {
    const liveKeys = new Set(Object.keys(liveTurnsByMember.value));
    const owned = new Set(Object.keys(memberTurnsById.value));
    let prunedParts: Record<string, TurnPartDto[]> | null = null;
    for (const key of Object.keys(runParts.value)) {
      if (liveKeys.has(key) || owned.has(key)) continue;
      if (!prunedParts) prunedParts = { ...runParts.value };
      delete prunedParts[key];
    }
    if (prunedParts) runParts.value = prunedParts;
    const stillOwnedFlags: Record<string, true> = {};
    for (const key of Object.keys(runPartsComplete.value)) {
      if (liveKeys.has(key) || owned.has(key)) stillOwnedFlags[key] = true;
    }
    runPartsComplete.value = stillOwnedFlags;
    const stillTruncated: Record<string, true> = {};
    for (const key of Object.keys(runPartsTruncated.value)) {
      if (liveKeys.has(key) || owned.has(key)) stillTruncated[key] = true;
    }
    runPartsTruncated.value = stillTruncated;
  }

  function mergeHistoryPage(
    res: ConversationHistoryResponseDto,
    merged: Record<string, ConversationMessageDto>,
  ): void {
    for (const m of res.messages) {
      merged[m.id] = m;
    }
    for (const m of messages.value) {
      merged[m.id] = m;
    }
    messages.value = Object.values(merged).sort((a, b) => a.seq - b.seq);
    transcriptRevision += 1;
    pruneIncompleteTraces();
    const prevOldest = oldestSeq.value;
    if (res.oldestSeq !== undefined && (prevOldest === undefined || res.oldestSeq < prevOldest)) {
      oldestSeq.value = res.oldestSeq;
      hasMoreBefore.value = res.hasMoreBefore;
    }
    if (res.newestSeq !== undefined && (newestSeq.value === undefined || res.newestSeq > newestSeq.value)) {
      newestSeq.value = res.newestSeq;
    }
    hasMoreAfter.value = res.hasMoreAfter;
  }

  async function fillHistoryGap(
    iId: string,
    cId: string,
    tId: string,
    requestSequence: number,
    revision: number,
    fromSeq: number,
    tailOldest: number,
    newestCap: number | undefined,
    merged: Record<string, ConversationMessageDto>,
  ): Promise<"complete" | "incomplete" | "superseded" | "live-race"> {
    let cursor = fromSeq;
    for (;;) {
      if (
        requestSequence !== historyRequestSequence ||
        instanceId.value !== iId ||
        activeConversationId.value !== cId ||
        activeTopicId.value !== tId
      ) {
        return "superseded";
      }
      if (revision !== transcriptRevision) {
        return "live-race";
      }
      let res: ConversationHistoryResponseDto;
      try {
        res = unwrapRpc(
          await api.rpc<ConversationHistoryResponseDto>(iId, MSG.conversationHistory, {
            conversationId: cId,
            topicId: tId,
            afterSeq: cursor,
            limit: 50,
          }),
        );
      } catch {
        return "incomplete";
      }
      if (res.messages.length === 0) {
        return "incomplete";
      }
      for (const m of res.messages) {
        merged[m.id] = m;
      }
      const pageMax = Math.max(...res.messages.map((m) => m.seq));
      if (pageMax <= cursor) {
        return "incomplete";
      }
      cursor = pageMax;
      if (newestSeq.value === undefined || cursor > newestSeq.value) {
        newestSeq.value = cursor;
      }
      if (cursor >= tailOldest) {
        messages.value = Object.values(merged).sort((a, b) => a.seq - b.seq);
        transcriptRevision += 1;
        pruneIncompleteTraces();
        contiguousNewestSeq.value = newestCap !== undefined ? Math.max(cursor, newestCap) : cursor;
        return "complete";
      }
    }
  }

  async function loadHistory(
    targetInstanceId?: string,
    convId?: string,
    topId?: string,
    opts?: { harvestTerminalHandoff?: { runId: string }; reuseDiscoveryId?: number },
  ): Promise<void> {
    const iId = targetInstanceId ?? instanceId.value;
    const cId = convId ?? activeConversationId.value;
    const tId = topId ?? activeTopicId.value;
    if (!iId || !cId || !tId) return;
    const requestSequence = ++historyRequestSequence;
    const discoveryId = opts?.reuseDiscoveryId ?? ++discoverySequence;
    const revision = transcriptRevision;
    loadingHistory.value = true;
    historyError.value = null;
    topicReady.value = false;
    try {
      const res = unwrapRpc(
        await api.rpc<ConversationHistoryResponseDto>(iId, MSG.conversationHistory, {
          conversationId: cId,
          topicId: tId,
          limit: 50,
          direction: "newest-first",
        }),
      );
      if (instanceId.value !== iId || activeConversationId.value !== cId || activeTopicId.value !== tId) {
        return;
      }
      if (requestSequence !== historyRequestSequence) {
        return;
      }
      if (revision !== transcriptRevision) {
        void loadHistory(iId, cId, tId, {
          reuseDiscoveryId: discoveryId,
          ...(opts?.harvestTerminalHandoff ? { harvestTerminalHandoff: opts.harvestTerminalHandoff } : {}),
        });
        return;
      }
      const prevContiguousBeforeMerge = contiguousNewestSeq.value;
      const merged: Record<string, ConversationMessageDto> = {};
      mergeHistoryPage(res, merged);
      hasMoreAfter.value = res.hasMoreAfter;
      const tailOldest = res.messages.length > 0
        ? Math.min(...res.messages.map((m) => m.seq))
        : undefined;
      let gapStatus: "complete" | "incomplete" | "superseded" | "live-race" = "complete";
      if (
        tailOldest !== undefined &&
        prevContiguousBeforeMerge !== undefined &&
        tailOldest > prevContiguousBeforeMerge + 1
      ) {
        gapStatus = await fillHistoryGap(
          iId,
          cId,
          tId,
          requestSequence,
          transcriptRevision,
          prevContiguousBeforeMerge,
          tailOldest,
          res.newestSeq,
          merged,
        );
      } else if (res.newestSeq !== undefined) {
        if (contiguousNewestSeq.value === undefined || res.newestSeq > contiguousNewestSeq.value) {
          contiguousNewestSeq.value = res.newestSeq;
        }
      }
      if (activeRun.value) {
        const canonicalBotMsg = messages.value.find(
          (m) => m.role === "bot" && m.runId === activeRun.value?.id,
        );
        if (canonicalBotMsg) {
          liveTurnsByMember.value = {};
        }
      }
      if (gapStatus === "superseded") {
        return;
      }
      if (gapStatus === "live-race") {
        void loadHistory(iId, cId, tId, {
          reuseDiscoveryId: discoveryId,
          ...(opts?.harvestTerminalHandoff ? { harvestTerminalHandoff: opts.harvestTerminalHandoff } : {}),
        });
        return;
      }
      if (gapStatus === "incomplete") {
        historyError.value = "discoveryFailed";
        historyErrorDetail.value = `history gap ${prevContiguousBeforeMerge}..${tailOldest} did not converge; retry to complete recovery`;
        return;
      }
      const discovered = await recoverActiveRun(iId, cId, tId, discoveryId, opts?.harvestTerminalHandoff);
      if (discovered) {
        topicReady.value = true;
        ownershipUncertain.value = false;
        cancelError.value = null;
      } else if (
        discoveryId === discoverySequence &&
        instanceId.value === iId &&
        activeConversationId.value === cId &&
        activeTopicId.value === tId
      ) {
        historyError.value = "discoveryFailed";
        historyErrorDetail.value = null;
        if (activeRun.value && !isTerminalRunState(activeRun.value.state)) {
          ownershipUncertain.value = true;
          cancelError.value = "ownershipUnconfirmed";
        }
      }
    } catch (err: unknown) {
      if (
        requestSequence === historyRequestSequence &&
        instanceId.value === iId &&
        activeConversationId.value === cId &&
        activeTopicId.value === tId
      ) {
        historyError.value = "discoveryFailed";
        historyErrorDetail.value = err instanceof Error ? err.message : String(err);
      }
    } finally {
      if (requestSequence === historyRequestSequence) {
        loadingHistory.value = false;
      }
    }
  }

  /** A durable `runs.list` that reports NO active owner is the authority on
   *  Topic ownership, so it must never be overruled by a detail RPC: `runs.get`
   *  may not decide whether the composer unlocks. Concretely, one failing detail
   *  RPC after a correct list previously left `isRunActive` true forever.
   *
   *  If the stale run appears in the list, its terminal summary is merged so the
   *  card renders the real outcome rather than vanishing. Either way the local
   *  ownership is released — that is what unlocks the composer.
   *
   *  Returns the id of the Run that is tracked afterwards so callers can enrich
   *  its member rows best-effort: `runs.list` summaries carry none, and that
   *  display data must never be able to re-gate the composer. */
  function reconcileNoActiveOwner(
    instId: string,
    runs: ConversationRunDto[],
  ): { settledRunId: string | null } {
    const current = activeRun.value;
    if (!current || isTerminalRunState(current.state)) {
      return { settledRunId: null };
    }
    const runId = current.id;
    const summary = runs.find((run) => run.id === runId);
    const settled = summary ? mergeRun(current, summary) : null;
    if (settled) {
      activeRun.value = settled;
      if (isTerminalRunState(settled.state)) {
        liveTurnsByMember.value = {};
      } else {
        // Still nonterminal by the list's own summary: keep the ownership, the
        // list may simply lag behind a Run that started a moment ago.
        return { settledRunId: null };
      }
    } else {
      // The list no longer mentions our run at all (rolled off / foreign client):
      // drop the ownership instead of pinning the composer to a phantom Run.
      activeRun.value = null;
      liveTurnsByMember.value = {};
    }
    memberTurnsById.value = {};
    resolveCancelUncertainty(runId);
    cancellingRunId.value = null;
    cancelError.value = null;
    ownershipUncertain.value = false;
    void instId;
    return { settledRunId: activeRun.value?.id ?? null };
  }

  async function recoverActiveRun(
    iId: string,
    cId: string,
    tId: string,
    discoveryId?: number | null,
    harvestTerminalHandoff?: { runId: string },
  ): Promise<boolean> {
    const generation = ++recoveryGeneration;
    const ownedDiscoveryId = discoveryId ?? discoverySequence;
    const isCurrentRecovery = (): boolean =>
      generation === recoveryGeneration
      && ownedDiscoveryId === discoverySequence
      && instanceId.value === iId
      && activeConversationId.value === cId
      && activeTopicId.value === tId;
    try {
      const listed = unwrapRpc(
        await api.rpc<{ runs: ConversationRunDto[]; activeRunId?: string; activeRun?: ConversationRunDto }>(iId, MSG.runsList, {
          conversationId: cId,
          topicId: tId,
        }),
      );
      if (!isCurrentRecovery()) {
        return false;
      }
      // Uncertain-request reconciliation is independent of who owns the Topic.
      // runs.list returns every durable Run for the Topic regardless of state, so
      // our own request may already be terminal (completed while we were
      // offline) and therefore never appear as the active owner. Matching it
      // anywhere in the list is what releases the frozen prompt.
      const ownRequest = listed.runs.find(
        (run) => uncertainPrompt.value !== null && run.requestId === uncertainPrompt.value.requestId,
      );
      if (ownRequest) {
        resolveUncertainPromptAgainstRun(ownRequest);
      }
      const candidate = listed.activeRun
        ?? (listed.activeRunId ? listed.runs.find((run) => run.id === listed.activeRunId) : undefined);
      if (!candidate) {
        // The list is authoritative: the composer must be usable as soon as this
        // returns. Enrichment may hang until the transport times out, so it must
        // never gate the unlock — it fires and forgets behind its own fences.
        const { settledRunId } = reconcileNoActiveOwner(iId, listed.runs);
        if (settledRunId) {
          void enrichRunDetail(iId, settledRunId, ownedDiscoveryId);
        }
        return true;
      }
      if (activeRun.value && activeRun.value.id !== candidate.id && !isTerminalRunState(activeRun.value.state)) {
        activeRun.value = mergeRun(null, candidate);
        memberTurnsById.value = {};
        liveTurnsByMember.value = {};
        latestPlanRunId.value = candidate.id;
      } else {
        activeRun.value = mergeRun(activeRun.value?.id === candidate.id ? activeRun.value : null, candidate);
      }
      // Canonical recovery: a candidate for our own lost prompt is durable proof
      // the accept landed, so the prompt stops being outcome-unknown.
      resolveUncertainPromptAgainstRun(candidate);
      if (
        harvestTerminalHandoff &&
        activeRun.value.id === harvestTerminalHandoff.runId &&
        isTerminalRunState(activeRun.value.state)
      ) {
        liveTurnsByMember.value = {};
        return true;
      }
      if (isTerminalRunState(activeRun.value.state)) {
        liveTurnsByMember.value = {};
        return true;
      }
      try {
        const detail = unwrapRpc(
          await api.rpc<{ run: ConversationRunDetailDto }>(iId, MSG.runsGet, { runId: candidate.id }),
        );
        if (!isCurrentRecovery()) {
          return false;
        }
        if (detail?.run && detail.run.id !== candidate.id) {
          return true;
        }
        if (activeRun.value && activeRun.value.id !== candidate.id) {
          return true;
        }
        if (
          harvestTerminalHandoff &&
          activeRun.value.id === harvestTerminalHandoff.runId &&
          isTerminalRunState(activeRun.value.state)
        ) {
          liveTurnsByMember.value = {};
          return true;
        }
        if (detail?.run) {
          activeRun.value = mergeRun(activeRun.value, detail.run);
          if (detail.run.memberTurns?.length) {
            applyMemberTurns(detail.run.memberTurns);
          }
          resolveUncertainPromptAgainstRun(detail.run);
        }
        if (isTerminalRunState(activeRun.value.state)) {
          liveTurnsByMember.value = {};
        }
        return true;
      } catch {
        return true;
      }
    } catch {
      return false;
    }
  }

  function refreshTranscriptOnly(
    targetInstanceId: string | null,
    convId: string | null,
    topId: string | null,
  ): void {
    if (!targetInstanceId || !convId || !topId) return;
    void (async () => {
      const generation = currentSelectionGeneration;
      const requestSequence = ++historyRequestSequence;
      const revision = transcriptRevision;
      loadingHistory.value = true;
      try {
        const res = unwrapRpc(
          await api.rpc<ConversationHistoryResponseDto>(targetInstanceId, MSG.conversationHistory, {
            conversationId: convId,
            topicId: topId,
            limit: 50,
            direction: "newest-first",
          }),
        );
        if (
          generation !== currentSelectionGeneration ||
          instanceId.value !== targetInstanceId ||
          activeConversationId.value !== convId ||
          activeTopicId.value !== topId ||
          requestSequence !== historyRequestSequence
        ) {
          return;
        }
        if (revision !== transcriptRevision) {
          void refreshTranscriptOnly(targetInstanceId, convId, topId);
          return;
        }
        const prevContiguousBeforeMerge = contiguousNewestSeq.value;
        const merged: Record<string, ConversationMessageDto> = {};
        mergeHistoryPage(res, merged);
        hasMoreAfter.value = res.hasMoreAfter;
        const tailOldest = res.messages.length > 0
          ? Math.min(...res.messages.map((m) => m.seq))
          : undefined;
        let gapStatus: "complete" | "incomplete" | "superseded" | "live-race" = "complete";
        if (
          tailOldest !== undefined &&
          prevContiguousBeforeMerge !== undefined &&
          tailOldest > prevContiguousBeforeMerge + 1
        ) {
          gapStatus = await fillHistoryGap(
            targetInstanceId,
            convId,
            topId,
            requestSequence,
            transcriptRevision,
            prevContiguousBeforeMerge,
            tailOldest,
            res.newestSeq,
            merged,
          );
        } else if (res.newestSeq !== undefined) {
          if (contiguousNewestSeq.value === undefined || res.newestSeq > contiguousNewestSeq.value) {
            contiguousNewestSeq.value = res.newestSeq;
          }
        }
        if (gapStatus === "superseded") {
          return;
        }
        if (gapStatus === "live-race") {
          void refreshTranscriptOnly(targetInstanceId, convId, topId);
          return;
        }
        if (gapStatus === "incomplete") {
          historyError.value = "discoveryFailed";
          historyErrorDetail.value = `history gap ${prevContiguousBeforeMerge}..${tailOldest} did not converge; retry to complete recovery`;
          topicReady.value = false;
          return;
        }
        if (activeRun.value) {
          const canonicalBotMsg = messages.value.find(
            (m) => m.role === "bot" && m.runId === activeRun.value?.id,
          );
          if (canonicalBotMsg) {
            liveTurnsByMember.value = {};
          }
        }
      } catch (err: unknown) {
        if (
          requestSequence === historyRequestSequence &&
          instanceId.value === targetInstanceId &&
          activeConversationId.value === convId &&
          activeTopicId.value === topId
        ) {
          historyError.value = "discoveryFailed";
          historyErrorDetail.value = err instanceof Error ? err.message : String(err);
          topicReady.value = false;
        }
      } finally {
        if (requestSequence === historyRequestSequence) {
          loadingHistory.value = false;
        }
      }
    })();
  }

  function rediscoverAfterTerminal(
    targetInstanceId: string | null,
    convId: string | null,
    topId: string | null,
    harvestRunId?: string,
  ): void {
    if (!targetInstanceId || !convId || !topId) return;
    const runId = harvestRunId;
    const handoffDiscoveryId = ++discoverySequence;
    void (async () => {
      const generation = currentSelectionGeneration;
      await loadHistory(
        targetInstanceId,
        convId,
        topId,
        { harvestTerminalHandoff: runId ? { runId } : undefined, reuseDiscoveryId: handoffDiscoveryId },
      );
      if (generation !== currentSelectionGeneration) return;
    })();
  }

  async function loadOlder(): Promise<void> {
    const iId = instanceId.value;
    const cId = activeConversationId.value;
    const tId = activeTopicId.value;
    if (!iId || !cId || !tId) return;
    if (!hasMoreBefore.value || oldestSeq.value === undefined) return;
    const token = ++olderRequestToken;
    const owner = `${iId}:${cId}:${tId}`;
    olderRequestOwner = owner;
    loadingOlder.value = true;
    try {
      const res = unwrapRpc(
        await api.rpc<ConversationHistoryResponseDto>(iId, MSG.conversationHistory, {
          conversationId: cId,
          topicId: tId,
          beforeSeq: oldestSeq.value,
          limit: 50,
        }),
      );
      if (
        token !== olderRequestToken ||
        olderRequestOwner !== owner ||
        instanceId.value !== iId ||
        activeConversationId.value !== cId ||
        activeTopicId.value !== tId
      ) {
        return;
      }
      const merged: Record<string, ConversationMessageDto> = {};
      for (const m of messages.value) merged[m.id] = m;
      for (const m of res.messages) merged[m.id] = m;
      messages.value = Object.values(merged).sort((a, b) => a.seq - b.seq);
      touchTranscript();
      pruneIncompleteTraces();
      if (res.messages.length > 0) {
        if (res.oldestSeq !== undefined) {
          oldestSeq.value = res.oldestSeq;
        }
      }
      hasMoreBefore.value = res.hasMoreBefore;
    } catch (err: unknown) {
      console.warn("loadOlder failed:", err);
    } finally {
      if (token === olderRequestToken && olderRequestOwner === owner) {
        loadingOlder.value = false;
      }
    }
  }

  async function selectGroup(targetInstanceId: string, groupId: string): Promise<void> {
    const generation = ++currentSelectionGeneration;
    historyRequestSequence += 1;
    discoverySequence += 1;
    retireOlderRequest();
    touchTranscript();
    topicReady.value = false;
    instanceId.value = targetInstanceId;
    selectedGroupId.value = groupId;
    persistGroupSelection(targetInstanceId, groupId);

    activeConversationId.value = null;
    activeTopicId.value = null;
    messages.value = [];
    oldestSeq.value = undefined;
    newestSeq.value = undefined;
    contiguousNewestSeq.value = undefined;
    hasMoreBefore.value = false;
    hasMoreAfter.value = false;
    activeRun.value = null;
    memberTurnsById.value = {};
    liveTurnsByMember.value = {};
    latestPlanRunId.value = null;
    cancellingRunId.value = null;
    cancelUncertaintyRunId.value = null;
    cancelError.value = null;
    ownershipUncertain.value = false;
    promptInFlight.value = false;
    promptError.value = null;
    promptErrorDetail.value = null;
    uncertainPrompt.value = null;
    generalError.value = null;
    generalErrorCode.value = null;
    targetSelection.value = null;
    try {
      const groups = await loadGroups(targetInstanceId);
      if (generation !== currentSelectionGeneration || instanceId.value !== targetInstanceId || selectedGroupId.value !== groupId) {
        return;
      }
      const group = groups.find((g) => g.id === groupId);
      if (!group) {
        clearSelection();
        return;
      }
      activeConversationId.value = group.id;
      // The default target prefers an executable member, which needs the Bot
      // catalog's enabled flags. Freshness has exactly one authority — the Direct
      // store's botsLoaded, set by the newest loadBots() outcome. A NON-EMPTY
      // cached list is not evidence of freshness: loadBots() keeps the previous
      // rows when a later refresh fails, so treating a stale cache as confirmed
      // would let a failed read-only listing widen routing from the lead Bot to
      // the whole Group.
      const bots = await directBotsStore.loadBots(targetInstanceId).catch(() => null);
      const cachedBots = directBotsStore.botsByInstance[targetInstanceId];
      const catalogKnown = botCatalogKnown.value;
      const catalogBots = bots ?? cachedBots ?? [];
      // Fence BEFORE the write, not after: the slower Group's loadBots can
      // settle after the user has already opened another Group, and writing
      // here would overwrite that Group's target with the stale one's member.
      if (generation !== currentSelectionGeneration || instanceId.value !== targetInstanceId || selectedGroupId.value !== groupId) {
        return;
      }
      targetSelection.value = defaultTargetFor(group, catalogBots, catalogKnown);
      const topics = await loadTopics(targetInstanceId, group.id);
      if (generation !== currentSelectionGeneration || instanceId.value !== targetInstanceId || selectedGroupId.value !== groupId) {
        return;
      }
      // Prefer the Group's default, else the first ACTIVE Topic: opening a Group
      // whose oldest Topic is archived must not land the composer in a state
      // where every send is refused with topic_not_active.
      const targetTopicId = group.defaultTopicId
        ?? topics.find((topic) => topic.status === "active")?.id
        ?? topics[0]?.id;
      if (targetTopicId) {
        activeTopicId.value = targetTopicId;
        await loadHistory(targetInstanceId, group.id, targetTopicId);
      } else {
        topicReady.value = true;
      }
    } catch (err: unknown) {
      if (generation === currentSelectionGeneration && selectedGroupId.value === groupId) {
        generalError.value = err instanceof Error ? err.message : String(err);
      }
    }
  }

  async function switchTopic(topicId: string): Promise<void> {
    if (activeTopicId.value === topicId) return;
    // A Topic switch is a selection change: any prompt still in flight was sent
    // to the old Topic, and the composer enumerates Topic changes by bumping the
    // selection generation, so a background prompt cannot be credited to this
    // Topic. The old draft must be discarded here — the composer owns prose, the
    // store owns ownership, and the draft has no Topic identity.
    const generation = ++currentSelectionGeneration;
    historyRequestSequence += 1;
    discoverySequence += 1;
    retireOlderRequest();
    touchTranscript();
    topicReady.value = false;
    activeTopicId.value = topicId;
    messages.value = [];
    oldestSeq.value = undefined;
    newestSeq.value = undefined;
    contiguousNewestSeq.value = undefined;
    hasMoreBefore.value = false;
    hasMoreAfter.value = false;
    activeRun.value = null;
    memberTurnsById.value = {};
    liveTurnsByMember.value = {};
    latestPlanRunId.value = null;
    cancellingRunId.value = null;
    cancelUncertaintyRunId.value = null;
    cancelError.value = null;
    ownershipUncertain.value = false;
    promptInFlight.value = false;
    promptError.value = null;
    promptErrorDetail.value = null;
    uncertainPrompt.value = null;
    generalError.value = null;
    generalErrorCode.value = null;
    if (instanceId.value && activeConversationId.value) {
      await loadHistory(instanceId.value, activeConversationId.value, topicId);
      if (generation !== currentSelectionGeneration || activeTopicId.value !== topicId) {
        return;
      }
    }
  }

  function clearSelection(): void {
    currentSelectionGeneration++;
    historyRequestSequence += 1;
    discoverySequence += 1;
    retireOlderRequest();
    touchTranscript();
    topicReady.value = true;
    instanceId.value = null;
    selectedGroupId.value = null;
    activeConversationId.value = null;
    activeTopicId.value = null;
    messages.value = [];
    oldestSeq.value = undefined;
    newestSeq.value = undefined;
    contiguousNewestSeq.value = undefined;
    hasMoreBefore.value = false;
    hasMoreAfter.value = false;
    memberTurnsById.value = {};
    activeRun.value = null;
    liveTurnsByMember.value = {};
    latestPlanRunId.value = null;
    planByRunId.value = {};
    cancellingRunId.value = null;
    cancelUncertaintyRunId.value = null;
    cancelError.value = null;
    ownershipUncertain.value = false;
    promptInFlight.value = false;
    promptError.value = null;
    promptErrorDetail.value = null;
    uncertainPrompt.value = null;
    generalError.value = null;
    generalErrorCode.value = null;
    targetSelection.value = null;
    persistGroupSelection(null, null);
  }

  /** requestId for a fresh send. An existing uncertain tuple keeps its identity
   *  only when the text AND target still match it; any divergence means this is
   *  a genuinely new request and must get a new durable identity. */
  function preparePromptRequestId(text: string, target: ConversationTargetDto): string {
    const prior = uncertainPrompt.value;
    if (prior && prior.text === text && JSON.stringify(prior.target) === JSON.stringify(target)) {
      return prior.requestId;
    }
    const requestId = mintRequestId();
    uncertainPrompt.value = { requestId, text, target };
    return requestId;
  }

  /** Replay an uncertain prompt exactly as first sent. The frozen tuple is what
   *  the durable accept is keyed on, so a retry must never re-resolve the
   *  current UI target: switching targets under a live requestId would leave the
   *  UI claiming one routing while the server executes the original one. */
  async function retryUncertainPrompt(): Promise<void> {
    const prior = uncertainPrompt.value;
    if (!prior) return;
    await sendPrompt(prior.text, prior.target);
  }

  /** Resolve an uncertain prompt against a canonically observed Run. Durable
   *  recovery (state-snapshot runs.get, retryDiscovery, recoverActiveRun) proves
   *  our lost-response prompt really was accepted when the Run carries the same
   *  requestId. Clearing the tuple then is what makes reconnect self-healing:
   *  the user's request is durably represented, so there is nothing left to
   *  retry and no fresh-send block. A mismatch means this Run belongs to someone
   *  else's request and must not consume our pending identity. */
  function resolveUncertainPromptAgainstRun(run: ConversationRunDto | undefined | null): void {
    if (!run || run.requestId === "") return;
    const prompt = uncertainPrompt.value;
    if (!prompt || prompt.requestId !== run.requestId) return;
    uncertainPrompt.value = null;
    if (promptError.value === "promptPendingConfirmation") {
      promptError.value = null;
      promptErrorDetail.value = null;
    }
    ownershipUncertain.value = false;
    if (cancelError.value === "ownershipChecking") cancelError.value = null;
  }

  /** Best-effort detail enrichment. `runs.list` summaries carry no memberTurns,
   *  so a terminal Run reconciled from a list has a card with no per-member rows
   *  until a successful `runs.get` restores them. This call never decides
   *  ownership, `topicReady`, or `isRunActive` — a failure leaves the Run
   *  terminal-but-thin, which is strictly better than a stranded composer. */
  async function enrichRunDetail(
    iId: string,
    runId: string,
    discoveryId?: number | null,
  ): Promise<void> {
    const generation = currentSelectionGeneration;
    try {
      const res = unwrapRpc(
        await api.rpc<{ run: ConversationRunDetailDto }>(iId, MSG.runsGet, { runId }),
      );
      if (
        generation !== currentSelectionGeneration ||
        instanceId.value !== iId ||
        activeRun.value?.id !== runId
      ) {
        return;
      }
      if (discoveryId !== undefined && discoveryId !== null && discoveryId !== discoverySequence) {
        return;
      }
      const incomingRun = res.run;
      activeRun.value = mergeRun(activeRun.value, incomingRun);
      if (incomingRun.memberTurns?.length) {
        applyMemberTurns(incomingRun.memberTurns);
      }
      resolveUncertainPromptAgainstRun(incomingRun);
    } catch {
      // Display-only degradation: the list already settled ownership.
    }
  }

  async function sendPrompt(text: string, forcedTarget?: ConversationTargetDto): Promise<GroupSendOutcome> {
    const outcome = sendPromptInner(text, forcedTarget);
    inFlightSend.value = outcome;
    return await outcome;
  }

  async function sendPromptInner(text: string, forcedTarget?: ConversationTargetDto): Promise<GroupSendOutcome> {
    const trimmed = text.trim();
    if (!trimmed || !instanceId.value || !selectedGroupId.value || !activeConversationId.value || !activeTopicId.value) {
      return "rejected";
    }
    if (forcedTarget) {
      // Frozen-tuple replay, ranked ABOVE every other guard. It carries the exact
      // requestId/text/target the server may already have durably accepted, so it
      // is safe by construction: acceptConversationPrompt checks
      // getAcceptedRequest() before any live-state validation and returns the
      // existing Run. It must therefore still work once reconnection proves the
      // Run is active — otherwise Retry is unreachable for the entire duration of
      // a long-running Run, leaving the user stranded on their own lost response.
      const reqId = preparePromptRequestId(trimmed, forcedTarget);
      return await runPromptSend(trimmed, forcedTarget, reqId);
    }
    if (!topicReady.value) {
      promptError.value = "topicRecovering";
      promptErrorDetail.value = null;
      return "uncertain";
    }
    if (isRunActive.value) {
      promptError.value = "runInProgress";
      promptErrorDetail.value = null;
      return "uncertain";
    }
    // Invariant: an uncertain prompt may only be resolved by replaying its own
    // tuple (or by durable reconciliation discovering it). Minting a fresh
    // requestId meanwhile would leave the original Run executing AND run the new
    // members — exactly the double-execution the frozen tuple exists to prevent.
    // Enforced here, not only in the UI, so a future view cannot bypass it. The
    // forced-target branch above is the sole escape hatch (the replay itself).
    if (uncertainPrompt.value) {
      promptError.value = "promptPendingConfirmation";
      promptErrorDetail.value = null;
      return "uncertain";
    }
    const resolved = resolveTarget();
    if ("error" in resolved) {
      promptError.value = resolved.error === "targetRequired" ? "targetRequired" : "targetEmpty";
      promptErrorDetail.value = null;
      return "rejected";
    }
    const reqId = preparePromptRequestId(trimmed, resolved.target);
    return await runPromptSend(trimmed, resolved.target, reqId);
  }

  /** Transport half of a send: all fences, the RPC, and the projection. Kept
   *  separate so a frozen-tuple retry shares exactly one code path. */
  async function runPromptSend(
    runText: string,
    target: ConversationTargetDto,
    reqId: string,
  ): Promise<GroupSendOutcome> {
    // The caller's guards already proved these non-null; restate them here so
    // this shared path stays directly callable from the frozen-tuple retry.
    const targetInstId = instanceId.value ?? "";
    const targetGroupId = selectedGroupId.value ?? "";
    const targetConvId = activeConversationId.value ?? "";
    const targetTopicId = activeTopicId.value ?? "";
    if (!targetInstId || !targetConvId || !targetTopicId) {
      return "rejected";
    }
    const generation = currentSelectionGeneration;
    const isCurrent = (): boolean =>
      generation === currentSelectionGeneration &&
      instanceId.value === targetInstId &&
      selectedGroupId.value === targetGroupId &&
      activeConversationId.value === targetConvId &&
      activeTopicId.value === targetTopicId;
    latestPlanRunId.value = null;
    promptInFlight.value = true;
    promptError.value = null;
    promptErrorDetail.value = null;

    try {
      const res = unwrapRpc(
        await api.rpc<ConversationPromptResponseDto>(targetInstId, MSG.conversationPrompt, {
          conversationId: targetConvId,
          topicId: targetTopicId,
          requestId: reqId,
          text: runText,
          target,
        }),
      );
      if (!isCurrent()) {
        // The RPC landed on a Topic the user has since left. Report an orphan so
        // the composer clears its (new) draft instead of misreading this as its
        // own prompt being refused.
        return "orphaned";
      }
      // The accept is confirmed: drop the uncertain tuple so a later send with
      // the same text gets a fresh durable identity.
      uncertainPrompt.value = null;

      const existing = messages.value.find((m) => m.id === res.message.id);
      if (!existing) {
        messages.value = [...messages.value, res.message].sort((a, b) => a.seq - b.seq);
        touchTranscript();
        newestSeq.value = Math.max(newestSeq.value ?? 0, res.message.seq);
        advanceContiguousForSeq(res.message.seq);
      }

      const promptOwner = res.activeRun && !isTerminalRunState(res.activeRun.state)
        ? res.activeRun
        : undefined;
      const promptOwnerId = res.activeRunId ?? promptOwner?.id;
      const ownerProvesAccepted = promptOwnerId !== undefined && promptOwnerId === res.run.id;
      const ownerProvesOther = !!promptOwner && promptOwner.id !== res.run.id;
      const acceptOverwritesOwner =
        !activeRun.value ||
        activeRun.value.id === res.run.id ||
        isTerminalRunState(activeRun.value.state);
      const priorRunId = activeRun.value?.id;
      const priorRunActive = !!activeRun.value && !isTerminalRunState(activeRun.value.state);
      const freshOptimisticAdopt = acceptOverwritesOwner && res.run.state === "queued";
      const ownerUnproven = freshOptimisticAdopt && res.activeRunId === undefined && !promptOwner;
      const ownerUnknown = ownerUnproven;
      const contestedOwnerless = priorRunActive && !ownerProvesAccepted && !ownerProvesOther && res.activeRunId === undefined && !promptOwner;
      if (contestedOwnerless) {
        // Keep the tracked owner; fence below confirms it.
      } else if (promptOwner && promptOwner.id !== res.run.id) {
        activeRun.value = mergeRun(null, promptOwner);
        memberTurnsById.value = {};
        liveTurnsByMember.value = {};
        latestPlanRunId.value = promptOwner.id;
      } else if (acceptOverwritesOwner) {
        activeRun.value = mergeRun(activeRun.value, res.run);
        const turns = res.memberTurns ?? (res.memberTurn ? [res.memberTurn] : []);
        applyMemberTurns(turns);
      }
      const adoptedRun = activeRun.value;
      if (!adoptedRun) {
        return "accepted";
      }
      const ownerAdoptedFromPrompt = !!promptOwner && promptOwner.id !== res.run.id;
      const terminalOwnerProven = ownerProvesAccepted;
      if (isTerminalRunState(adoptedRun.state)) {
        liveTurnsByMember.value = {};
        if (targetInstId && targetConvId && targetTopicId) {
          if (terminalOwnerProven && !priorRunActive) {
            void refreshTranscriptOnly(targetInstId, targetConvId, targetTopicId);
          } else {
            topicReady.value = false;
            void rediscoverAfterTerminal(targetInstId, targetConvId, targetTopicId, adoptedRun.id);
          }
        }
      } else if (acceptOverwritesOwner && !ownerAdoptedFromPrompt) {
        const isFreshRun = adoptedRun.id === res.run.id && adoptedRun.id !== priorRunId;
        if (isFreshRun) {
          const now = Date.now();
          const next: Record<string, GroupLiveTurn> = {};
          const turns = res.memberTurns ?? (res.memberTurn ? [res.memberTurn] : []);
          for (const turn of turns) {
            next[turn.id] = {
              parts: [],
              status: "working",
              startedAt: turn.startedAt ? new Date(turn.startedAt).getTime() : now,
              revision: 1,
            };
          }
          liveTurnsByMember.value = next;
        }
      }
      if (acceptOverwritesOwner && !ownerAdoptedFromPrompt && !contestedOwnerless) {
        latestPlanRunId.value = res.run.id;
      }
      if ((ownerUnproven || contestedOwnerless) && adoptedRun.state === "queued") {
        if (targetInstId && targetConvId && targetTopicId) {
          void retryDiscovery();
        }
      }
      if ((ownerUnknown || contestedOwnerless) && adoptedRun.state === "queued") {
        ownershipUncertain.value = true;
        cancelError.value = "ownershipChecking";
      }
      return "accepted";
    } catch (err: unknown) {
      let outcome: GroupSendOutcome = "uncertain";
      if (isCurrent() && uncertainPrompt.value?.requestId === reqId) {
        const code = err instanceof GroupRpcError ? err.code : null;
        // A definitive rejection proves the durable accept never happened, so
        // the frozen tuple is dead weight: keeping it would trap the user on a
        // request that can never succeed. Only outcome-unknown failures
        // (transport loss, timeout, internal error) keep the tuple.
        if (isDefinitiveRejection(code)) {
          uncertainPrompt.value = null;
          outcome = "rejected";
        } else {
          outcome = "uncertain";
        }
        if (code === "unknown-type") {
          promptError.value = "connectorOutdated";
          promptErrorDetail.value = null;
        } else if (
          code === "conversation_target_mismatch" ||
          code === "conversation_mismatch" ||
          code === "conversation_not_group" ||
          code === "topic_not_found"
        ) {
          promptError.value = "topicRecovering";
          promptErrorDetail.value = err instanceof Error ? err.message : String(err);
        } else if (code === "topic_queue_full") {
          // A deterministic refusal: no durable accept happened. Report it as its
          // own condition instead of a raw error so the user understands the
          // request was never queued.
          promptError.value = "topicQueueFull";
          promptErrorDetail.value = null;
        } else if (code === "empty_target" || code === "target_required") {
          promptError.value = "targetEmpty";
          promptErrorDetail.value = err instanceof Error ? err.message : String(err);
        } else if (code === "bot_disabled") {
          promptError.value = "botDisabled";
          promptErrorDetail.value = null;
        } else if (code === "target_too_large") {
          // A deliberately user-visible refusal: the budget was exceeded, so it
          // must read as product copy rather than the backend's English message.
          promptError.value = "targetTooLarge";
          promptErrorDetail.value = null;
        } else if (
          code === "group_member_not_member" ||
          code === "bot_not_found" ||
          code === "no_eligible_members"
        ) {
          promptError.value = "targetUnknownMember";
          promptErrorDetail.value = err instanceof Error ? err.message : String(err);
        } else {
          promptError.value = err instanceof Error ? err.message : String(err);
          promptErrorDetail.value = promptError.value;
        }
      } else if (isCurrent() && promptError.value === "runInProgress") {
        promptError.value = null;
        promptErrorDetail.value = null;
      }
      if (!isCurrent()) {
        // The selection moved (or the Topic was deleted) while the RPC was in
        // flight: the outcome belongs to a Topic the user has left.
        return "orphaned";
      }
      return outcome;
    } finally {
      if (isCurrent()) {
        promptInFlight.value = false;
      }
    }
  }

  async function retryDiscovery(): Promise<boolean> {
    const targetInstId = instanceId.value;
    const targetConvId = activeConversationId.value;
    const targetTopicId = activeTopicId.value;
    if (!targetInstId || !targetConvId || !targetTopicId) return false;

    const checkGeneration = currentSelectionGeneration;
    const checkDiscoveryId = ++discoverySequence;
    try {
      const listed = unwrapRpc(
        await api.rpc<{ runs: ConversationRunDto[]; activeRunId?: string; activeRun?: ConversationRunDto }>(
          targetInstId,
          MSG.runsList,
          { conversationId: targetConvId, topicId: targetTopicId },
        ),
      );
      if (
        checkGeneration !== currentSelectionGeneration ||
        instanceId.value !== targetInstId ||
        activeConversationId.value !== targetConvId ||
        activeTopicId.value !== targetTopicId ||
        checkDiscoveryId !== discoverySequence
      ) {
        return false;
      }
      // Same rule as recoverActiveRun: our own terminal Run may not be the Topic
      // owner, so the uncertain prompt must be reconciled against the whole list.
      const ownRequest = listed.runs.find(
        (run) => uncertainPrompt.value !== null && run.requestId === uncertainPrompt.value.requestId,
      );
      if (ownRequest) {
        resolveUncertainPromptAgainstRun(ownRequest);
      }
      const candidate = listed.activeRun
        ?? (listed.activeRunId ? listed.runs.find((run) => run.id === listed.activeRunId) : undefined);
      if (!candidate) {
        // Same durable-owner rule as recoverActiveRun: a list with no owner
        // releases a locally cached nonterminal Run, so one detail failure
        // cannot strand the composer.
        const { settledRunId } = reconcileNoActiveOwner(targetInstId, listed.runs);
        // Settle the authority first: the composer must be unlocked before any
        // display-only enrichment is attempted, so a failing `runs.get` can
        // never leave the Topic looking owned by a finished Run.
        ownershipUncertain.value = false;
        cancelError.value = null;
        topicReady.value = true;
        if (settledRunId) {
          await enrichRunDetail(targetInstId, settledRunId, checkDiscoveryId);
        }
        return true;
      }
      if (activeRun.value && activeRun.value.id !== candidate.id && !isTerminalRunState(activeRun.value.state)) {
        activeRun.value = mergeRun(null, candidate);
        memberTurnsById.value = {};
        liveTurnsByMember.value = {};
        latestPlanRunId.value = candidate.id;
      } else {
        activeRun.value = mergeRun(activeRun.value?.id === candidate.id ? activeRun.value : null, candidate);
      }
      // Canonical discovery: a candidate for our own lost prompt is durable
      // proof the accept landed, so the prompt stops being outcome-unknown.
      resolveUncertainPromptAgainstRun(candidate);
      if (isTerminalRunState(activeRun.value.state)) {
        liveTurnsByMember.value = {};
        ownershipUncertain.value = false;
        cancelError.value = null;
        // Terminal ownership still needs member rows back: the list summary
        // carries none, so enrich best-effort before returning.
        await enrichRunDetail(targetInstId, activeRun.value.id, checkDiscoveryId);
        return true;
      }
      try {
        const detail = unwrapRpc(
          await api.rpc<{ run: ConversationRunDetailDto }>(targetInstId, MSG.runsGet, { runId: candidate.id }),
        );
        if (
          checkGeneration !== currentSelectionGeneration ||
          instanceId.value !== targetInstId ||
          activeConversationId.value !== targetConvId ||
          activeTopicId.value !== targetTopicId ||
          checkDiscoveryId !== discoverySequence
        ) {
          return false;
        }
        if (detail?.run && detail.run.id === candidate.id) {
          activeRun.value = mergeRun(activeRun.value, detail.run);
          if (detail.run.memberTurns?.length) {
            applyMemberTurns(detail.run.memberTurns);
          }
          resolveUncertainPromptAgainstRun(detail.run);
        }
        if (isTerminalRunState(activeRun.value.state)) {
          liveTurnsByMember.value = {};
        }
        ownershipUncertain.value = false;
        cancelError.value = null;
        topicReady.value = true;
        return true;
      } catch {
        ownershipUncertain.value = false;
        cancelError.value = null;
        topicReady.value = true;
        return true;
      }
    } catch {
      if (
        checkGeneration === currentSelectionGeneration &&
        instanceId.value === targetInstId &&
        activeConversationId.value === targetConvId &&
        activeTopicId.value === targetTopicId &&
        checkDiscoveryId === discoverySequence
      ) {
        ownershipUncertain.value = true;
        cancelError.value = "ownershipUnconfirmed";
      }
      return false;
    }
  }

  async function cancelCurrentRun(): Promise<void> {
    if (!instanceId.value || !activeRun.value) return;
    if (cancellingRunId.value === activeRun.value.id) return;
    if (ownershipUncertain.value || !topicReady.value) {
      void retryDiscovery();
      return;
    }
    const targetInstId = instanceId.value;
    const targetConvId = activeConversationId.value;
    const targetTopicId = activeTopicId.value;
    const runId = activeRun.value.id;
    const generation = currentSelectionGeneration;
    const isCurrent = (): boolean =>
      generation === currentSelectionGeneration &&
      instanceId.value === targetInstId &&
      activeConversationId.value === targetConvId &&
      activeTopicId.value === targetTopicId &&
      activeRun.value?.id === runId;

    cancellingRunId.value = runId;

    try {
      const res = unwrapRpc(
        await api.rpc<{ ok: boolean; run: ConversationRunDetailDto }>(
          targetInstId,
          MSG.runsCancel,
          { runId },
        ),
      );
      if (!isCurrent()) {
        return;
      }
      const retiringActiveRun = !isTerminalRunState(activeRun.value.state);
      activeRun.value = mergeRun(activeRun.value, res.run);
      if (res.run.memberTurns?.length) {
        applyMemberTurns(res.run.memberTurns);
      }
      if (isTerminalRunState(activeRun.value.state)) {
        liveTurnsByMember.value = {};
        resolveCancelUncertainty(runId);
        if (retiringActiveRun && targetInstId && targetConvId && targetTopicId) {
          void rediscoverAfterTerminal(targetInstId, targetConvId, targetTopicId, activeRun.value.id);
        }
      }
    } catch (err: unknown) {
      console.warn("cancelCurrentRun error:", err);
      if (isCurrent() && activeRun.value && activeRun.value.id === runId) {
        cancelUncertaintyRunId.value = runId;
        cancelError.value = "cancelUnknown";
        void api
          .rpc<{ run: ConversationRunDetailDto }>(targetInstId, MSG.runsGet, { runId })
          .then((getRes) => {
            if (!isCurrent()) return;
            const run = unwrapRpc(getRes).run;
            const retiringActiveRun = !!activeRun.value && !isTerminalRunState(activeRun.value.state);
            activeRun.value = mergeRun(activeRun.value, run);
                resolveUncertainPromptAgainstRun(run);
            if (run.memberTurns?.length) {
              applyMemberTurns(run.memberTurns);
            }
            if (isTerminalRunState(activeRun.value.state)) {
              liveTurnsByMember.value = {};
              resolveCancelUncertainty(runId);
              if (retiringActiveRun && targetInstId && targetConvId && targetTopicId) {
                void rediscoverAfterTerminal(targetInstId, targetConvId, targetTopicId, activeRun.value.id);
              }
            }
          })
          .catch(() => {});
      }
    } finally {
      if (cancellingRunId.value === runId) {
        cancellingRunId.value = null;
      }
    }
  }

  async function reconcileOnReconnect(): Promise<void> {
    const barrierIds: Record<string, true> = {};
    for (const id of Object.keys(groupsLoaded.value)) barrierIds[id] = true;
    for (const id of Object.keys(groupsByInstance.value)) barrierIds[id] = true;
    for (const id of Object.keys(groupsListSeq)) barrierIds[id] = true;
    for (const loadedId of Object.keys(barrierIds)) {
      groupsLoaded.value = { ...groupsLoaded.value, [loadedId]: false };
      groupsListSeq[loadedId] = (groupsListSeq[loadedId] ?? 0) + 1;
    }
    const iId = instanceId.value;
    const gId = selectedGroupId.value;
    const cId = activeConversationId.value;
    const tId = activeTopicId.value;
    const rId = activeRun.value?.id;
    const generation = currentSelectionGeneration;
    if (!iId) return;
    if (tId) {
      topicReady.value = false;
      historyRequestSequence += 1;
      discoverySequence += 1;
    }
    let groups: GroupSummaryDto[] | null = null;
    try {
      groups = await loadGroups(iId);
    } catch {
      // Fall through to durable recovery below.
    }
    if (
      generation !== currentSelectionGeneration ||
      instanceId.value !== iId ||
      selectedGroupId.value !== gId
    ) {
      return;
    }
    if (groups && gId && !groups.some((g) => g.id === gId)) {
      clearSelection();
      return;
    }
    if (gId) {
      try {
        if (cId) {
          await loadTopics(iId, cId).catch(() => {});
          if (generation !== currentSelectionGeneration || activeConversationId.value !== cId) return;
          if (tId) {
            await loadHistory(iId, cId, tId);
            if (generation !== currentSelectionGeneration || activeTopicId.value !== tId) return;
          }
        }
      } catch (err: unknown) {
        console.warn("reconcileOnReconnect error:", err);
      }
    }
    if (rId && activeRun.value?.id === rId) {
      // Enrichment only: the list already decided who owns the Topic, and this
      // call must never change `topicReady`/`isRunActive`. A terminal Run still
      // needs its member rows back, which `runs.list` summaries cannot carry.
      const wasTerminal = isTerminalRunState(activeRun.value.state);
      try {
        const res = unwrapRpc(
          await api.rpc<{ run: ConversationRunDetailDto }>(iId, MSG.runsGet, {
            runId: rId,
          }),
        );
        if (
          generation !== currentSelectionGeneration ||
          instanceId.value !== iId ||
          activeConversationId.value !== cId ||
          activeTopicId.value !== tId ||
          activeRun.value?.id !== rId
        ) {
          return;
        }
        const incomingRun = res.run;
        activeRun.value = mergeRun(activeRun.value, incomingRun);
        if (incomingRun.memberTurns?.length) {
          applyMemberTurns(incomingRun.memberTurns);
        }
        resolveUncertainPromptAgainstRun(incomingRun);
        if (!wasTerminal && isTerminalRunState(activeRun.value.state)) {
          liveTurnsByMember.value = {};
          if (cId && tId) {
            await loadHistory(iId, cId, tId);
          }
        }
      } catch {
        if (
          generation === currentSelectionGeneration &&
          activeConversationId.value &&
          activeTopicId.value
        ) {
          await loadHistory(iId, activeConversationId.value, activeTopicId.value);
        }
      }
    }
  }

  function liveTurnForMember(memberTurnId: string): GroupLiveTurn | null {
    return liveTurnsByMember.value[memberTurnId] ?? null;
  }

  function applyEvent(event: WebServerEvent): void {
    if (event.kind === "instance-status") {
      if (event.instanceId === instanceId.value) {
        if (!event.online) {
          generalErrorCode.value = "instanceOffline";
          generalError.value = null;
        } else if (generalErrorCode.value === "instanceOffline") {
          generalErrorCode.value = null;
        }
      }
      return;
    }

    if (event.kind === "state-snapshot") {
      if (event.instanceId !== instanceId.value) return;
      if (activeConversationId.value && activeTopicId.value) {
        const matchingTurns = event.turns.filter(
          (t: LiveTurnSnapshotDto) =>
            t.conversation &&
            t.conversation.conversationId === activeConversationId.value &&
            t.conversation.topicId === activeTopicId.value,
        );
        if (matchingTurns.length > 0) {
          const next: Record<string, GroupLiveTurn> = {};
          for (const matchingTurn of matchingTurns) {
            const corr = matchingTurn.conversation;
            const key = corr?.memberTurnId ?? corr?.runId ?? matchingTurn.sessionAlias;
            next[key] = {
              parts: [...matchingTurn.parts],
              status: matchingTurn.status,
              startedAt: matchingTurn.startedAt,
              revision: (liveTurnsByMember.value[key]?.revision ?? 0) + 1,
            };
          }
          liveTurnsByMember.value = next;
          const firstCorr = matchingTurns[0]?.conversation;
          if (firstCorr?.runId) {
            const matchingRunId = firstCorr.runId;
            if (!activeRun.value || activeRun.value.id !== matchingRunId) {
              activeRun.value = {
                id: matchingRunId,
                conversationId: firstCorr.conversationId,
                topicId: firstCorr.topicId,
                requestMessageId: "",
                requestId: "",
                mode: "explicit",
                state: "running",
                profileRevision: 1,
                createdAt: new Date(matchingTurns[0]?.startedAt ?? Date.now()).toISOString(),
                startedAt: new Date(matchingTurns[0]?.startedAt ?? Date.now()).toISOString(),
              };
            }
            for (const matchingTurn of matchingTurns) {
              const corr = matchingTurn.conversation;
              // Member identity is the trace key: a multi-member Run stores
              // one entry per memberTurnId, so sibling completions can never
              // overwrite each other's tool/thought/output parts.
              const partsKey = corr?.memberTurnId ?? matchingRunId;
              runParts.value = {
                ...runParts.value,
                [partsKey]: [...matchingTurn.parts],
              };
              if (runPartsComplete.value[partsKey]) {
                const { [partsKey]: _dropped, ...rest } = runPartsComplete.value;
                runPartsComplete.value = rest;
              }
              if (matchingTurn.truncated) {
                runPartsTruncated.value = { ...runPartsTruncated.value, [partsKey]: true };
              } else if (runPartsTruncated.value[partsKey]) {
                const { [partsKey]: _dropped, ...rest } = runPartsTruncated.value;
                runPartsTruncated.value = rest;
              }
            }
            const targetInstId = event.instanceId;
            const targetConvId = activeConversationId.value ?? undefined;
            const targetTopicId = activeTopicId.value ?? undefined;
            const targetGeneration = currentSelectionGeneration;
            void api
              .rpc<{ run: ConversationRunDetailDto }>(targetInstId, MSG.runsGet, {
                runId: matchingRunId,
              })
              .then((res) => {
                if (
                  targetGeneration !== currentSelectionGeneration ||
                  instanceId.value !== targetInstId ||
                  activeConversationId.value !== targetConvId ||
                  activeTopicId.value !== targetTopicId ||
                  activeRun.value?.id !== matchingRunId
                ) {
                  return;
                }
                const run = unwrapRpc(res).run;
                const retiringActiveRun = !!activeRun.value && !isTerminalRunState(activeRun.value.state);
                activeRun.value = mergeRun(activeRun.value, run);
                resolveUncertainPromptAgainstRun(run);
                if (run.memberTurns?.length) {
                  applyMemberTurns(run.memberTurns);
                }
                if (isTerminalRunState(activeRun.value.state)) {
                  liveTurnsByMember.value = {};
                  if (retiringActiveRun && targetConvId && targetTopicId) {
                    void rediscoverAfterTerminal(targetInstId, targetConvId, targetTopicId, activeRun.value.id);
                  }
                }
              })
              .catch(() => {});
          }
        } else if (activeRun.value && isActiveRunState(activeRun.value.state)) {
          const targetInstId = event.instanceId;
          const targetConvId = activeConversationId.value ?? undefined;
          const targetTopicId = activeTopicId.value ?? undefined;
          const targetRunId = activeRun.value.id;
          const targetGeneration = currentSelectionGeneration;
          liveTurnsByMember.value = {};
          void loadHistory(targetInstId, targetConvId, targetTopicId);
          void api
            .rpc<{ run: ConversationRunDetailDto }>(targetInstId, MSG.runsGet, {
              runId: targetRunId,
            })
            .then((res) => {
              if (
                targetGeneration !== currentSelectionGeneration ||
                instanceId.value !== targetInstId ||
                activeConversationId.value !== targetConvId ||
                activeTopicId.value !== targetTopicId ||
                activeRun.value?.id !== targetRunId
              ) {
                return;
              }
              const run = unwrapRpc(res).run;
              activeRun.value = mergeRun(activeRun.value, run);
                resolveUncertainPromptAgainstRun(run);
              if (isTerminalRunState(activeRun.value.state)) {
                liveTurnsByMember.value = {};
              }
            })
            .catch(() => {});
        }
      }
      return;
    }

    if (event.kind !== "control-event") return;
    const e = event.event;

    if (e.type === "bots-changed") {
      return;
    }
    if (event.instanceId !== instanceId.value) {
      if (e.type === "conversations-changed" && groupsLoaded.value[event.instanceId]) {
        void loadGroups(event.instanceId).catch(() => {});
      }
      return;
    }

    if (e.type === "conversations-changed") {
      const groupIdAtEvent = selectedGroupId.value;
      const generationAtEvent = currentSelectionGeneration;
      if (groupIdAtEvent) {
        void loadGroups(event.instanceId).then(async (groups) => {
          if (generationAtEvent !== currentSelectionGeneration
            || instanceId.value !== event.instanceId
            || selectedGroupId.value !== groupIdAtEvent) {
            return;
          }
          if (!groups.some((g) => g.id === groupIdAtEvent)) {
            clearSelection();
            return;
          }
          // A Topic teardown has no per-topic tombstone — the backend
          // deliberately broadcasts this coarse refetch instead — so the Topic
          // list must be re-fetched or a deleted pill (and a dead active Topic)
          // lingers until the next reconnect.
          await refreshTopicsForSelection(groupIdAtEvent);
        }).catch(() => {});
      } else {
        void loadGroups(event.instanceId).catch(() => {});
      }
      return;
    }

    if (e.type === "conversation-topic-changed") {
      const topic = e.topic;
      if (topic.conversationId === activeConversationId.value) {
        const key = `${event.instanceId}:${topic.conversationId}`;
        topicsSeq[key] = (topicsSeq[key] ?? 0) + 1;
        topicEventRevision[key] = (topicEventRevision[key] ?? 0) + 1;
        const currentList = topicsByConversation.value[key] ?? [];
        const idx = currentList.findIndex((t) => t.id === topic.id);
        if (idx >= 0) {
          const next = [...currentList];
          next[idx] = topic;
          topicsByConversation.value = { ...topicsByConversation.value, [key]: next };
        } else {
          topicsByConversation.value = { ...topicsByConversation.value, [key]: [...currentList, topic] };
        }
      }
      return;
    }

    if (e.type === "conversation-message") {
      const msg = e.message;
      if (msg.conversationId === activeConversationId.value && msg.topicId === activeTopicId.value) {
        const existing = messages.value.find((m) => m.id === msg.id);
        if (!existing) {
          messages.value = [...messages.value, msg].sort((a, b) => a.seq - b.seq);
          touchTranscript();
          newestSeq.value = Math.max(newestSeq.value ?? 0, msg.seq);
          advanceContiguousForSeq(msg.seq);
          pruneIncompleteTraces();
        }
        if (msg.role === "bot" && activeRun.value && msg.runId === activeRun.value.id) {
          const stillLive = Object.values(memberTurnsById.value).some(
            (turn) => turn.runId === activeRun.value?.id && !["completed", "failed", "cancelled", "indeterminate"].includes(turn.state),
          );
          if (!stillLive) {
            liveTurnsByMember.value = {};
          }
        }
      }
      return;
    }

    if (e.type === "conversation-run-changed") {
      const run = e.run;
      if (run.conversationId === activeConversationId.value && run.topicId === activeTopicId.value) {
        if (
          (activeRun.value && activeRun.value.id === run.id) ||
          (!activeRun.value && isTerminalRunState(run.state))
        ) {
          const retiringActiveRun = !!activeRun.value && !isTerminalRunState(activeRun.value.state);
          activeRun.value = mergeRun(activeRun.value, run);
                resolveUncertainPromptAgainstRun(run);
          if (isTerminalRunState(activeRun.value.state)) {
            liveTurnsByMember.value = {};
            resolveCancelUncertainty(run.id);
            ownershipUncertain.value = false;
            if (
              retiringActiveRun &&
              instanceId.value && activeConversationId.value && activeTopicId.value
            ) {
              rediscoverAfterTerminal(instanceId.value, activeConversationId.value, activeTopicId.value, activeRun.value.id);
            }
          }
        } else if (!isTerminalRunState(run.state)) {
          const isOwnDraft =
            run.requestId !== "" &&
            uncertainPrompt.value !== null &&
            run.requestId === uncertainPrompt.value.requestId;
          if (
            !isOwnDraft &&
            (!activeRun.value || isTerminalRunState(activeRun.value.state)) &&
            instanceId.value && activeConversationId.value && activeTopicId.value
          ) {
            ownershipUncertain.value = true;
            void rediscoverAfterTerminal(
              instanceId.value,
              activeConversationId.value,
              activeTopicId.value,
            );
          } else if (
            !isOwnDraft &&
            activeRun.value &&
            !isTerminalRunState(activeRun.value.state) &&
            instanceId.value && activeConversationId.value && activeTopicId.value
          ) {
            ownershipUncertain.value = true;
            cancelError.value = "ownershipChecking";
            void retryDiscovery();
          }
          if (isOwnDraft) {
            activeRun.value = mergeRun(null, run);
            memberTurnsById.value = {};
            liveTurnsByMember.value = {};
            promptError.value = null;
            promptErrorDetail.value = null;
            // The Run durably adopted our uncertain prompt, closing the retry
            // window: a later send with the same text needs a new requestId.
            uncertainPrompt.value = null;
          }
        }
      }
      return;
    }
    if (e.type === "member-turn-started") {
      const { run, memberTurn } = e;
      const priorMember = memberTurnsById.value[memberTurn.id];
      if (priorMember && memberAttemptOrder(priorMember, memberTurn) < 0) return;
      if (run.conversationId === activeConversationId.value && run.topicId === activeTopicId.value) {
        if (
          (activeRun.value && activeRun.value.id === run.id) ||
          (!activeRun.value && isTerminalRunState(run.state))
        ) {
          activeRun.value = mergeRun(activeRun.value, run);
                resolveUncertainPromptAgainstRun(run);
          applyMemberTurns([memberTurn]);
        } else if (!isTerminalRunState(run.state)) {
          const isOwnDraft =
            run.requestId !== "" &&
            uncertainPrompt.value !== null &&
            run.requestId === uncertainPrompt.value.requestId;
          if (
            !isOwnDraft &&
            (!activeRun.value || isTerminalRunState(activeRun.value.state)) &&
            instanceId.value && activeConversationId.value && activeTopicId.value
          ) {
            ownershipUncertain.value = true;
            void rediscoverAfterTerminal(
              instanceId.value,
              activeConversationId.value,
              activeTopicId.value,
            );
          }
          if (isOwnDraft) {
            activeRun.value = mergeRun(null, run);
            applyMemberTurns([memberTurn]);
            promptError.value = null;
            promptErrorDetail.value = null;
            uncertainPrompt.value = null;
          } else {
            return;
          }
        }
        const key = memberTurn.id;
        if (!liveTurnsByMember.value[key] || activeRun.value?.id === run.id) {
          liveTurnsByMember.value = {
            ...liveTurnsByMember.value,
            [key]: {
              parts: [],
              status: "working",
              startedAt: memberTurn.startedAt ? new Date(memberTurn.startedAt).getTime() : Date.now(),
              revision: (liveTurnsByMember.value[key]?.revision ?? 0) + 1,
            },
          };
        }
      }
      return;
    }

    if (e.type === "member-turn-finished") {
      const { run, memberTurn } = e;
      const priorMember = memberTurnsById.value[memberTurn.id];
      if (priorMember && memberAttemptOrder(priorMember, memberTurn) < 0) return;
      if (run.conversationId === activeConversationId.value && run.topicId === activeTopicId.value) {
        if (activeRun.value && activeRun.value.id !== run.id) {
          return;
        }
        const retiringActiveRun = !!activeRun.value && !isTerminalRunState(activeRun.value.state);
        activeRun.value = mergeRun(activeRun.value, run);
                resolveUncertainPromptAgainstRun(run);
        applyMemberTurns([memberTurn]);
        const next = { ...liveTurnsByMember.value };
        delete next[memberTurn.id];
        liveTurnsByMember.value = next;
        if (isTerminalRunState(activeRun.value.state)) {
          liveTurnsByMember.value = {};
          resolveCancelUncertainty(run.id);
          if (
            retiringActiveRun &&
            instanceId.value && activeConversationId.value && activeTopicId.value
          ) {
            rediscoverAfterTerminal(instanceId.value, activeConversationId.value, activeTopicId.value, activeRun.value.id);
          }
        }
      }
      return;
    }

    if ("conversation" in e && e.conversation) {
      const corr = e.conversation;
      // The correlation ids are optional on the wire (a connector opening an
      // interaction from a turn knows only the keys its route carried). A
      // per-member live trace NEEDS the member attribution: an uncorrelated
      // frame cannot be attributed and is skipped, never guessed.
      if (
        corr.memberTurnId === undefined ||
        corr.runId === undefined ||
        corr.conversationId !== activeConversationId.value ||
        corr.topicId !== activeTopicId.value ||
        (activeRun.value && corr.runId !== activeRun.value.id)
      ) {
        return;
      }
      const key = corr.memberTurnId;
      const existing = liveTurnsByMember.value[key];
      if (!existing) {
        liveTurnsByMember.value = {
          ...liveTurnsByMember.value,
          [key]: { parts: [], status: "working", startedAt: Date.now(), revision: 0 },
        };
      }
      const live = liveTurnsByMember.value[key]!;
      const parts = live.parts;
      const bumpStream = (): void => {
        const current = liveTurnsByMember.value[key];
        if (current) {
          liveTurnsByMember.value = {
            ...liveTurnsByMember.value,
            [key]: { ...current, revision: current.revision + 1 },
          };
        }
      };
      const setStatus = (status: "working" | "streaming"): void => {
        const current = liveTurnsByMember.value[key];
        if (current && current.status !== status) {
          liveTurnsByMember.value = { ...liveTurnsByMember.value, [key]: { ...current, status } };
        }
      };
      if (e.type === "turn-started") {
        const current = liveTurnsByMember.value[key];
        if (current) {
          liveTurnsByMember.value = {
            ...liveTurnsByMember.value,
            [key]: { ...current, startedAt: e.startedAt ?? Date.now() },
          };
        }
      } else if (e.type === "turn-output") {
        appendText(parts, e.chunk);
        setStatus("streaming");
        bumpStream();
      } else if (e.type === "turn-thought") {
        appendReasoning(parts, e.chunk);
        bumpStream();
      } else if (e.type === "tool-event") {
        upsertTool(parts, e.step);
        bumpStream();
      } else if (e.type === "plan") {
        if (corr.runId) {
          latestPlanRunId.value = corr.runId;
          planByRunId.value = {
            ...planByRunId.value,
            [corr.runId]: e.entries,
          };
          bumpStream();
        }
      } else if (e.type === "turn-finished") {
        const current = liveTurnsByMember.value[key];
        if (current) {
          liveTurnsByMember.value = { ...liveTurnsByMember.value, [key]: { ...current, status: "working" } };
        }
        // Complete traces are keyed by memberTurnId, never runId: a
        // multi-member Run writes one entry per member so a sibling's
        // finish cannot overwrite this member's tool/thought/output parts.
        if (key) {
          runParts.value = {
            ...runParts.value,
            [key]: [...parts],
          };
          runPartsComplete.value = { ...runPartsComplete.value, [key]: true };
        }
      }
    }
  }

  function senderNameFor(botId: string | undefined, bots: BotSummaryDto[]): string {
    if (!botId) return "Bot";
    return bots.find((b) => b.id === botId)?.name ?? "Bot";
  }

  return {
    instanceId,
    selectedGroupId,
    activeConversationId,
    activeTopicId,
    groupsByInstance,
    groupDetails,
    loadingGroups,
    loadingGroupsByInstance,
    groupsLoaded,
    groupsListErrorByInstance,
    topicsByConversation,
    messages,
    oldestSeq,
    newestSeq,
    contiguousNewestSeq,
    hasMoreBefore,
    hasMoreAfter,
    loadingHistory,
    loadingOlder,
    historyError,
    historyErrorDetail,
    topicReady,
    activeRun,
    memberTurns,
    memberTurnsById,
    liveTurns,
    liveTurnsByMember,
    liveTurnForMember,
    planEntries,
    cancellingRunId,
    cancelUncertaintyRunId,
    runParts,
    completeRunParts,
    uncertainPrompt,
    sendPromptOutcomePromise,
    uncertainPromptText,
    uncertainPromptTarget,
    hasUncertainPrompt,
    botCatalogKnown,
    eligibleTargetFor,
    promptInFlight,
    promptError,
    promptErrorDetail,
    cancelError,
    generalError,
    generalErrorCode,
    ownershipUncertain,
    ownerUnconfirmed,
    retryDiscovery,
    targetSelection,
    isGroupSelected,
    currentGroups,
    currentGroup,
    currentTopics,
    currentTopic,
    isRunActive,
    defaultTargetFor,
    resolveTarget,
    targetResolvable,
    reportTargetProblem,
    setTarget,
    toggleTargetMember,
    mentionBot,
    mentionEveryone,
    senderNameFor,
    loadGroups,
    loadGroupDetail,
    createGroup,
    updateGroup,
    deleteGroup,
    findMemberWork,
    cancelRun,
    loadTopics,
    createGroupTopic,
    loadHistory,
    loadOlder,
    selectGroup,
    switchTopic,
    clearSelection,
    preparePromptRequestId,
    sendPrompt,
    retryUncertainPrompt,
    cancelCurrentRun,
    reconcileOnReconnect,
    applyEvent,
  };
});
