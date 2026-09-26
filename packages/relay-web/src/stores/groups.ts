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

export interface GroupLiveTurn {
  parts: TurnPartDto[];
  status: "working" | "streaming";
  startedAt: number;
  revision: number;
}

export type GroupTargetSelection =
  | { mode: "members"; botIds: string[] }
  | { mode: "everyone" };

export type GroupErrorCode =
  | "connectorOutdated"
  | "discoveryFailed"
  | "ownershipUnconfirmed"
  | "ownershipChecking"
  | "topicRecovering"
  | "runInProgress"
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
    || code === "bot_not_found"
    || code === "no_eligible_members"
    || code === "conversation_target_mismatch"
    || code === "conversation_mismatch";
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

function shouldUpdateRunState(current: ConversationRunStateDto | undefined, incoming: ConversationRunStateDto): boolean {
  if (!current) return true;
  if (isTerminalRunState(current)) return false;
  return RUN_STATE_PRECEDENCE[incoming] >= RUN_STATE_PRECEDENCE[current];
}

function mergeRun(current: ConversationRunDto | null, incoming: ConversationRunDto): ConversationRunDto {
  if (!current || current.id !== incoming.id) {
    return incoming;
  }
  if (!shouldUpdateRunState(current.state, incoming.state)) {
    return current;
  }
  return incoming;
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
  const isCurrentTerminal =
    current === "completed" || current === "failed" || current === "cancelled" || current === "indeterminate";
  if (isCurrentTerminal) return false;
  return MEMBER_TURN_STATE_PRECEDENCE[incoming] >= MEMBER_TURN_STATE_PRECEDENCE[current];
}

function mergeMemberTurn(current: MemberTurnSummaryDto | null, incoming: MemberTurnSummaryDto): MemberTurnSummaryDto {
  if (!current || current.id !== incoming.id) {
    return incoming;
  }
  if (!shouldUpdateMemberTurnState(current.state, incoming.state)) {
    return {
      ...incoming,
      state: current.state,
      startedAt: current.startedAt ?? incoming.startedAt,
      finishedAt: current.finishedAt ?? incoming.finishedAt,
    };
  }
  return incoming;
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

  function resolveTarget(): { target: ConversationTargetDto } | { error: "targetRequired" | "targetEmpty" } {
    const selection = targetSelection.value;
    if (!selection) return { error: "targetRequired" };
    if (selection.mode === "everyone") return { target: { mode: "everyone" } };
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
    } else {
      targetSelection.value = { mode: "everyone" };
    }
  }

  function toggleTargetMember(botId: string): void {
    const current = targetSelection.value;
    if (!current || current.mode === "everyone") {
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
    if (current.mode === "everyone") {
      // Explicit mention narrows the target back to members: a Group stay in
      // everyone mode would ignore every later `@Name`.
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

  async function loadGroups(targetInstanceId: string): Promise<GroupSummaryDto[]> {
    const seq = (groupsListSeq[targetInstanceId] ?? 0) + 1;
    groupsListSeq[targetInstanceId] = seq;
    loadingGroupsByInstance.value = {
      ...loadingGroupsByInstance.value,
      [targetInstanceId]: (loadingGroupsByInstance.value[targetInstanceId] ?? 0) + 1,
    };
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
    // leaves the list.
    topicsByConversation.value = { ...topicsByConversation.value, [key]: res.topics };
    return res.topics;
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
        const droppedAny = previous.some((topic) => !next.some((item) => item.id === topic.id));
        if (droppedAny) {
          // Deletion observed: advance the epoch so in-flight list requests that
          // captured the older epoch discard their pre-deletion snapshots
          // instead of merging the deleted Topic back in.
          topicDeletionEpoch[key] = (topicDeletionEpoch[key] ?? 0) + 1;
        }
        topicsByConversation.value = { ...topicsByConversation.value, [key]: next };
        return next;
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
    target: { workspace: string; isolation: "shared" | "shared-single-writer" },
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
      const candidate = listed.activeRun
        ?? (listed.activeRunId ? listed.runs.find((run) => run.id === listed.activeRunId) : undefined);
      if (!candidate) {
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
            memberTurnsById.value = mergeMemberTurns(memberTurnsById.value, detail.run.memberTurns);
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
      // catalog's enabled flags. A listing failure (with no cache) must not
      // widen routing, so it falls back to the lead / first member and lets the
      // server be authoritative about disabled Bots.
      const bots = await directBotsStore.loadBots(targetInstanceId).catch(() => null);
      const cachedBots = directBotsStore.botsByInstance[targetInstanceId];
      const catalogKnown = Array.isArray(bots) && bots.length > 0
        || Array.isArray(cachedBots) && cachedBots.length > 0;
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

  async function sendPrompt(text: string, forcedTarget?: ConversationTargetDto): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || !instanceId.value || !selectedGroupId.value || !activeConversationId.value || !activeTopicId.value) {
      return;
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
      await runPromptSend(trimmed, forcedTarget, reqId);
      return;
    }
    if (!topicReady.value) {
      promptError.value = "topicRecovering";
      promptErrorDetail.value = null;
      return;
    }
    if (isRunActive.value) {
      promptError.value = "runInProgress";
      promptErrorDetail.value = null;
      return;
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
      return;
    }
    const resolved = resolveTarget();
    if ("error" in resolved) {
      promptError.value = resolved.error === "targetRequired" ? "targetRequired" : "targetEmpty";
      promptErrorDetail.value = null;
      return;
    }
    const reqId = preparePromptRequestId(trimmed, resolved.target);
    await runPromptSend(trimmed, resolved.target, reqId);
  }

  /** Transport half of a send: all fences, the RPC, and the projection. Kept
   *  separate so a frozen-tuple retry shares exactly one code path. */
  async function runPromptSend(
    runText: string,
    target: ConversationTargetDto,
    reqId: string,
  ): Promise<void> {
    // The caller's guards already proved these non-null; restate them here so
    // this shared path stays directly callable from the frozen-tuple retry.
    const targetInstId = instanceId.value ?? "";
    const targetGroupId = selectedGroupId.value ?? "";
    const targetConvId = activeConversationId.value ?? "";
    const targetTopicId = activeTopicId.value ?? "";
    if (!targetInstId || !targetConvId || !targetTopicId) {
      return;
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
        return;
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
        const turns = res.memberTurns?.length ? res.memberTurns : [res.memberTurn];
        memberTurnsById.value = mergeMemberTurns(memberTurnsById.value, turns);
      }
      const adoptedRun = activeRun.value;
      if (!adoptedRun) {
        return;
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
          const turns = res.memberTurns?.length ? res.memberTurns : [res.memberTurn];
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
    } catch (err: unknown) {
      if (isCurrent() && uncertainPrompt.value?.requestId === reqId) {
        const code = err instanceof GroupRpcError ? err.code : null;
        // A definitive rejection proves the durable accept never happened, so
        // the frozen tuple is dead weight: keeping it would trap the user on a
        // request that can never succeed. Only outcome-unknown failures
        // (transport loss, timeout, internal error) keep the tuple.
        if (isDefinitiveRejection(code)) {
          uncertainPrompt.value = null;
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
        } else if (code === "empty_target" || code === "target_required") {
          promptError.value = "targetEmpty";
          promptErrorDetail.value = err instanceof Error ? err.message : String(err);
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
      const candidate = listed.activeRun
        ?? (listed.activeRunId ? listed.runs.find((run) => run.id === listed.activeRunId) : undefined);
      if (!candidate) {
        ownershipUncertain.value = false;
        cancelError.value = null;
        topicReady.value = true;
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
            memberTurnsById.value = mergeMemberTurns(memberTurnsById.value, detail.run.memberTurns);
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
        memberTurnsById.value = mergeMemberTurns(memberTurnsById.value, res.run.memberTurns);
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
              memberTurnsById.value = mergeMemberTurns(memberTurnsById.value, run.memberTurns);
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
    if (rId && activeRun.value?.id === rId && isActiveRunState(activeRun.value.state)) {
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
          memberTurnsById.value = mergeMemberTurns(memberTurnsById.value, incomingRun.memberTurns);
        }
        resolveUncertainPromptAgainstRun(incomingRun);
        if (isTerminalRunState(activeRun.value.state)) {
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
                  memberTurnsById.value = mergeMemberTurns(memberTurnsById.value, run.memberTurns);
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
    if (event.instanceId !== instanceId.value) return;

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
      if (run.conversationId === activeConversationId.value && run.topicId === activeTopicId.value) {
        if (
          (activeRun.value && activeRun.value.id === run.id) ||
          (!activeRun.value && isTerminalRunState(run.state))
        ) {
          activeRun.value = mergeRun(activeRun.value, run);
                resolveUncertainPromptAgainstRun(run);
          memberTurnsById.value = mergeMemberTurns(memberTurnsById.value, [memberTurn]);
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
            memberTurnsById.value = mergeMemberTurns(memberTurnsById.value, [memberTurn]);
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
      if (run.conversationId === activeConversationId.value && run.topicId === activeTopicId.value) {
        if (activeRun.value && activeRun.value.id !== run.id) {
          return;
        }
        const retiringActiveRun = !!activeRun.value && !isTerminalRunState(activeRun.value.state);
        activeRun.value = mergeRun(activeRun.value, run);
                resolveUncertainPromptAgainstRun(run);
        memberTurnsById.value = mergeMemberTurns(memberTurnsById.value, [memberTurn]);
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
      if (
        corr.conversationId !== activeConversationId.value ||
        corr.topicId !== activeTopicId.value ||
        (activeRun.value && corr.runId !== activeRun.value.id)
      ) {
        return;
      }
      const key = corr.memberTurnId || corr.runId;
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
    uncertainPromptText,
    uncertainPromptTarget,
    hasUncertainPrompt,
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
