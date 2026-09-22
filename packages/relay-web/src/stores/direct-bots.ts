import { defineStore } from "pinia";
import { computed, markRaw, ref } from "vue";
import {
  MSG,
  isErrorPayload,
  type BotDetailDto,
  type BotSummaryDto,
  type ConversationDetailDto,
  type ConversationHistoryResponseDto,
  type ConversationMessageDto,
  type ConversationPromptResponseDto,
  type ConversationRunDetailDto,
  type ConversationRunDto,
  type ConversationRunStateDto,
  type ConversationSummaryDto,
  type LiveTurnSnapshotDto,
  type MemberTurnSummaryDto,
  type PlanEntryDto,
  type ToolStepDto,
  type TopicSummaryDto,
  type TurnPartDto,
  type WebServerEvent,
} from "@ganglion/xacpx-relay-protocol";
import { api } from "../api/client";

export type DirectBotRunState = ConversationRunStateDto;

export interface DirectBotLiveTurn {
  parts: TurnPartDto[];
  status: "working" | "streaming";
  startedAt: number;
  /** Monotonic counter bumped on every in-place stream mutation (text /
   *  reasoning append, tool upsert). parts.length misses those (appendText
   *  does last.text += chunk; upsertTool replaces one row), so the transcript
   *  follower watches this revision instead of inferring growth. */
  revision: number;
}
export type DirectBotErrorCode =
  | "connectorOutdated"
  | "discoveryFailed"
  | "ownershipUnconfirmed"
  | "ownershipChecking"
  | "topicRecovering"
  | "botDisabled"
  | "runInProgress"
  | "cancelUnknown"
  | "instanceOffline";
export type DirectBotPromptErrorCode = "topicRecovering" | "botDisabled" | "runInProgress" | "connectorOutdated";
export type DirectBotCancelErrorCode = "ownershipUnconfirmed" | "ownershipChecking" | "cancelUnknown";
export type DirectBotHistoryErrorCode = "discoveryFailed";
export type DirectBotGeneralErrorCode = "instanceOffline";
class DirectBotRpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message || code);
    this.name = "DirectBotRpcError";
    this.code = code;
  }
}
function unwrapRpc<T>(result: T | { error: { code: string; message: string } }): T {
  if (isErrorPayload(result)) {
    if (result.error.code === "unknown-type") {
      throw new DirectBotRpcError(result.error.code, "connectorOutdated");
    }
    throw new DirectBotRpcError(result.error.code, result.error.message || result.error.code);
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
    return {
      ...incoming,
      state: current.state,
      completionReason: current.completionReason ?? incoming.completionReason,
      startedAt: current.startedAt ?? incoming.startedAt,
      finishedAt: current.finishedAt ?? incoming.finishedAt,
    };
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

function shouldUpdateMemberTurnState(current: MemberTurnSummaryDto["state"] | undefined, incoming: MemberTurnSummaryDto["state"]): boolean {
  if (!current) return true;
  const isCurrentTerminal = current === "completed" || current === "failed" || current === "cancelled" || current === "indeterminate";
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


const PERSISTED_BOT_SELECTION_KEY = "xrelay.selectedBot";

export interface PersistedBotSelection {
  instanceId: string;
  botId: string;
}

export function loadPersistedBotSelection(): PersistedBotSelection | null {
  try {
    const raw = localStorage.getItem(PERSISTED_BOT_SELECTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.instanceId === "string" && typeof parsed.botId === "string") {
      return { instanceId: parsed.instanceId, botId: parsed.botId };
    }
  } catch {
    // Ignore storage parse issues
  }
  return null;
}

function persistBotSelection(instanceId: string | null, botId: string | null): void {
  try {
    if (instanceId && botId) {
      localStorage.setItem(PERSISTED_BOT_SELECTION_KEY, JSON.stringify({ instanceId, botId }));
    } else {
      localStorage.removeItem(PERSISTED_BOT_SELECTION_KEY);
    }
  } catch {
    // Ignore storage issues
  }
}

export const useDirectBotsStore = defineStore("directBots", () => {
  let currentSelectionGeneration = 0;
  let recoveryGeneration = 0;
  let historyRequestSequence = 0;
  // Durable-owner discovery generation: minted per loadHistory call so a
  // superseded load cannot let its slow recovery overwrite a newer owner.
  // Transcript page freshness uses historyRequestSequence above; discovery
  // uses this counter so the two fences never conflate.
  let discoverySequence = 0;
  let transcriptRevision = 0;
  function touchTranscript(): void {
    transcriptRevision += 1;
  }
  // Contiguous-cursor advance for a single accepted/live seq: only chain onto
  // the proven window (seq === contiguous+1, or first claim). A seq that lands
  // above a hole (HTTP accept 121 while 51..120 unseen, live 601 while
  // 101..600 missing) must NOT jump the cursor — newestSeq still tracks the
  // display max, but the next load must see the interior hole and fill it.
  function advanceContiguousForSeq(seq: number): void {
    if (contiguousNewestSeq.value !== undefined && seq === contiguousNewestSeq.value + 1) {
      contiguousNewestSeq.value = seq;
    } else if (contiguousNewestSeq.value === undefined) {
      contiguousNewestSeq.value = seq;
    }
  }
  // Navigation / Selection identity
  const instanceId = ref<string | null>(null);
  const selectedBotId = ref<string | null>(null);
  const activeConversationId = ref<string | null>(null);
  const activeTopicId = ref<string | null>(null);

  // Bots state
  const botsByInstance = ref<Record<string, BotSummaryDto[]>>({});
  const botDetails = ref<Record<string, BotDetailDto>>({});
  // Per-instance in-flight counters: concurrent first-loads on two
  // instances must not clear each other's sidebar spinner (a global boolean
  // cleared by A's finally would flash "No bots" on still-pending B).
  const loadingBotsByInstance = ref<Record<string, number>>({});
  const loadingBots = computed<boolean>(() =>
    Object.values(loadingBotsByInstance.value).some((n) => n > 0),
  );
  const botsLoaded = ref<Record<string, boolean>>({});
  // Freshness fences for the Bot catalog: overlapping bots-list/detail
  // refreshes (e.g. back-to-back bots-changed events) must converge on the
  // latest response. Only the newest request per instance/bot may write the
  // cache or invalidate botsLoaded; stale responses are dropped.
  const botsListSeq: Record<string, number> = {};
  const botDetailSeq: Record<string, number> = {};
  // Retire in-flight catalog snapshots for one instance: any bots.list that
  // started before this point proves nothing about current state — its
  // snapshot membership predates the local write, so it must take the
  // stale-list branch instead of clearing tombstones or reinserting rows.
  // Deletion has no higher profileRevision to compare, so generation retire
  // is the only fence against a pre-delete snapshot resurrecting the row.
  function retireBotCatalogRequests(targetInstanceId: string): void {
    botsListSeq[targetInstanceId] = (botsListSeq[targetInstanceId] ?? 0) + 1;
  }
  // Authoritative detail hydration: a detailKey lands here only when a full
  // BotDetailDto arrived from bots.get/create/update (never from a list-row
  // synthesis like markBotHasRuntime's minimal seed). BotDialog gates Save on
  // this instead of sniffing the optional instructions field — a complete
  // detail with empty instructions legitimately omits the property.
  const botDetailHydrated: Record<string, number> = {};
  // Delete tombstones: an authoritative list that proves a Bot absent (or an
  // explicit delete) records the catalog generation that proved it. A late
  // mutation response for the same Bot must not resurrect the row — it only
  // proves the Bot existed at its own older revision.
  const botDeletedAtSeq: Record<string, number> = {};
  // Highest proven profileRevision per Bot, across every writer (list
  // snapshots, detail loads, mutation responses). A lower-revision response
  // that lands late must never roll the cache back.
  const botProvenRevision: Record<string, number> = {};
  // Monotonic lifecycle clock per instance: execution evidence
  // (member-turn-started / running / waiting-human rows) advances this, and
  // loadBots() merges locally-converged hasRuntime=true rows into whatever
  // snapshot lands. It never invalidates list snapshots: catalog freshness
  // stays owned by botsListSeq alone.
  const botLifecycleSeq: Record<string, number> = {};
  // Conversations state
  const conversationsByInstance = ref<Record<string, ConversationSummaryDto[]>>({});
  const conversationDetails = ref<Record<string, ConversationDetailDto>>({});

  // Topics state (keyed by `${instanceId}:${conversationId}`)
  const topicsByConversation = ref<Record<string, TopicSummaryDto[]>>({});
  // Freshness fence for the Topic strip: topics.list HTTP and
  // conversation-topic-changed WS share no transport ordering, so every
  // write (list snapshot, create merge, WS merge) mints a per-conversation
  // revision. A late list snapshot must merge into — never replace — newer
  // WS-merged rows.
  const topicsSeq: Record<string, number> = {};
  // Messages / History state for active conversation & topic
  const messages = ref<ConversationMessageDto[]>([]);
  const oldestSeq = ref<number | undefined>(undefined);
  const newestSeq = ref<number | undefined>(undefined);
  // Highest seq proven contiguous from the loaded window: gap retry decisions
  // must key on this, never on newestSeq (which the newest tail advances even
  // when an interior hole is still unfilled — retrying off newestSeq would
  // conclude "no gap" and present a holed transcript as recovered).
  const contiguousNewestSeq = ref<number | undefined>(undefined);
  const hasMoreBefore = ref<boolean>(false);
  const hasMoreAfter = ref<boolean>(false);
  const loadingHistory = ref<boolean>(false);
  const loadingOlder = ref<boolean>(false);
  // Pagination ownership: a deferred beforeSeq page for Topic A must not
  // block Topic B's pagination after a switch. The token is keyed to the
  // (instance, conversation, topic) the request was issued for; stale
  // requests exit via the view fence and only the owner clears the flag.
  let olderRequestToken = 0;
  let olderRequestOwner = "";
  // Release the UI spinner on navigation: the stale owner's view fence
  // already blocks transcript writes, and its finally is token+owner
  // checked, so clearing here cannot drop a new owner's spinner. Without
  // this the Load Older button stays disabled on the new Topic until the
  // old page settles, even though store.loadOlder() could take over.
  function retireOlderRequest(): void {
    olderRequestToken += 1;
    olderRequestOwner = "";
    loadingOlder.value = false;
  }
  const historyError = ref<DirectBotHistoryErrorCode | null>(null);
  const historyErrorDetail = ref<string | null>(null);
  // Fail-closed admission gate: false from topic selection until durable run
  // discovery (history + runs.list recovery) completes. Prevents sending a
  // prompt — and wrongly owning a second Run — while the authoritative active
  // Run is still unknown. History failure leaves it closed with historyError.
  const topicReady = ref<boolean>(true);
  // Active Run / Live Turn state
  const activeRun = ref<ConversationRunDto | null>(null);
  const activeMemberTurn = ref<MemberTurnSummaryDto | null>(null);
  const liveTurn = ref<DirectBotLiveTurn | null>(null);
  const planByRunId = ref<Record<string, PlanEntryDto[]>>({});
  const latestPlanRunId = ref<string | null>(null);
  const planEntries = computed<PlanEntryDto[]>(() => {
    const currentId = activeRun.value?.id ?? latestPlanRunId.value;
    if (!currentId) return [];
    return planByRunId.value[currentId] ?? [];
  });
  const cancellingRunId = ref<string | null>(null);

  // Accumulated trace parts retained per runId so completed assistant messages keep their rich cards
  const runParts = ref<Record<string, TurnPartDto[]>>({});
  // Completeness evidence: only a runId that actually received its stream's
  // turn-finished may keep its cached parts. A partial snapshot (stream cut
  // by disconnect) must never shadow the durable final row recovered later.
  const runPartsComplete = ref<Record<string, true>>({});
  // Truncation evidence: a state-sync snapshot the hub capped at
  // STATE_SYNC_TEXT_CAP stays gappy even after its stream's turn-finished —
  // later live deltas append post-cap content to the capped base, so the
  // merged trace must never certify the durable final answer.
  const runPartsTruncated = ref<Record<string, true>>({});
  // Finished-row rendering must only use traces proven complete AND untruncated
  // by their own stream. DirectBotPane binds this (never raw runParts).
  const completeRunParts = computed<Record<string, TurnPartDto[]>>(() => {
    const out: Record<string, TurnPartDto[]> = {};
    for (const [id, parts] of Object.entries(runParts.value)) {
      if (parts.length && runPartsComplete.value[id] && !runPartsTruncated.value[id]) out[id] = parts;
    }
    return out;
  });

  // Prompt / Idempotency state
  const currentDraftRequestId = ref<string | null>(null);
  const lastPromptText = ref<string>("");
  const promptInFlight = ref<boolean>(false);
  const promptError = ref<DirectBotPromptErrorCode | string | null>(null);
  const promptErrorDetail = ref<string | null>(null);
  // Cancel-outcome uncertainty is tracked separately from prompt submission errors:
  // a failed `runs.cancel` transport does not mean the durable Run terminated.
  const cancelError = ref<DirectBotCancelErrorCode | null>(null);
  const cancelUncertaintyRunId = ref<string | null>(null);
  function resolveCancelUncertainty(runId: string): void {
    if (cancelUncertaintyRunId.value === runId) {
      cancelUncertaintyRunId.value = null;
      cancelError.value = null;
    }
  }
  // Ownership uncertainty: when a foreign non-terminal run arrives while a local
  // non-terminal activeRun is tracked, ownership is unconfirmed until discovery
  // queries the authority (runs.list). While uncertain, cancelCurrentRun() fails
  // closed (will not cancel the old/unconfirmed owner) and triggers discovery.
  const ownershipUncertain = ref<boolean>(false);
  const ownerUnconfirmed = computed<boolean>(() => ownershipUncertain.value);

  // General error feedback
  const generalError = ref<string | null>(null);
  const generalErrorCode = ref<DirectBotGeneralErrorCode | null>(null);

  // Computed views
  const isBotSelected = computed(() => !!instanceId.value && !!selectedBotId.value);
  const currentBots = computed(() => (instanceId.value ? botsByInstance.value[instanceId.value] ?? [] : []));
  const currentBot = computed(() => {
    if (!instanceId.value || !selectedBotId.value) return undefined;
    const detailKey = `${instanceId.value}:${selectedBotId.value}`;
    return botDetails.value[detailKey] ?? currentBots.value.find((b) => b.id === selectedBotId.value);
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

  // RPC: Bot CRUD
  function dropBotDetail(targetInstanceId: string, botId: string): void {
    const detailKey = `${targetInstanceId}:${botId}`;
    // Invalidate any in-flight detail load so a stale response cannot
    // resurrect the dropped entry after a remote delete.
    botDetailSeq[detailKey] = (botDetailSeq[detailKey] ?? 0) + 1;
    // Tombstone so a late mutation response for the same id cannot reinsert
    // the row either. Cleared when an authoritative list re-proves presence.
    botDeletedAtSeq[detailKey] = (botDeletedAtSeq[detailKey] ?? 0) + 1;
    delete botDetailHydrated[detailKey];
    if (detailKey in botDetails.value) {
      const nextDetails = { ...botDetails.value };
      delete nextDetails[detailKey];
      botDetails.value = nextDetails;
    }
  }
  // Execution evidence flips the local lifecycle projection: dispatcher
  // execution-start (member-turn-started / running/waiting-human rows) proves
  // the hidden direct runtime actually materialized, but emits no
  // bots-changed. Converge immediately so delete/identity UI does not wait
  // for a later authoritative list/detail refetch.
  function markBotHasRuntime(targetInstanceId: string, botId: string): void {
    // PR5 has no public teardown/rebind: once a Bot has materialized a direct
    // runtime, hasRuntime is monotonic. Lifecycle evidence bumps a dedicated
    // lifecycle clock AND the detail generation (so a stale detail response
    // can never write back hasRuntime-unset rows), but it must NOT bump the
    // catalog request generation: that clock orders bots.list HTTP snapshots
    // only, and a member-turn-started for Bot A must never invalidate an
    // in-flight snapshot that also carries Bot C create/delete/update rows.
    botLifecycleSeq[targetInstanceId] = (botLifecycleSeq[targetInstanceId] ?? 0) + 1;
    const detailKey = `${targetInstanceId}:${botId}`;
    botDetailSeq[detailKey] = (botDetailSeq[detailKey] ?? 0) + 1;
    const list = botsByInstance.value[targetInstanceId];
    if (list) {
      const idx = list.findIndex((b) => b.id === botId);
      if (idx >= 0 && !list[idx]?.hasRuntime) {
        const next = [...list];
        next[idx] = { ...next[idx]!, hasRuntime: true as const };
        botsByInstance.value = { ...botsByInstance.value, [targetInstanceId]: next };
      }
    }
    const detail = botDetails.value[detailKey];
    if (detail) {
      if (!detail.hasRuntime) {
        botDetails.value = { ...botDetails.value, [detailKey]: { ...detail, hasRuntime: true as const } };
      }
    } else if (selectedBotId.value === botId && instanceId.value === targetInstanceId) {
      // No cached detail row yet (e.g. list-only selection): seed a minimal
      // lifecycle entry from the list row so currentBot (detail-first) still
      // converges hasRuntime. Full fields arrive on the next detail load,
      // which preserves true via the monotonic merge below.
      const listed = botsByInstance.value[targetInstanceId]?.find((b) => b.id === botId);
      if (listed) {
        botDetails.value = {
          ...botDetails.value,
          [detailKey]: {
            ...listed,
            hasRuntime: true as const,
            profileRevision: 1,
            createdAt: listed.updatedAt,
          },
        };
      }
    }
  }


  async function loadBots(targetInstanceId: string): Promise<BotSummaryDto[]> {
    const seq = (botsListSeq[targetInstanceId] ?? 0) + 1;
    botsListSeq[targetInstanceId] = seq;
    loadingBotsByInstance.value = {
      ...loadingBotsByInstance.value,
      [targetInstanceId]: (loadingBotsByInstance.value[targetInstanceId] ?? 0) + 1,
    };
    try {
      const res = unwrapRpc(
        await api.rpc<{ bots: BotSummaryDto[] }>(targetInstanceId, MSG.botsList, {}),
      );
      // A stale (superseded) list response must not clobber the newer cache,
      // nor may it pose as an authoritative answer for side effects (e.g. the
      // bots-changed ghost-selection check): return the current cache so a
      // late S1 cannot clear a selection made after S2 converged.
      if (botsListSeq[targetInstanceId] !== seq) {
        return botsByInstance.value[targetInstanceId] ?? res.bots;
      }
      // hasRuntime is monotonic (no public teardown/rebind): an older
      // snapshot that predates materialization evidence must not roll a
      // locally-converged true back to unset.
      const prevList = botsByInstance.value[targetInstanceId] ?? [];
      const prevRuntime: Record<string, true> = {};
      for (const b of prevList) {
        if (b.hasRuntime) prevRuntime[b.id] = true;
      }
      // A refreshed summary is authoritative: drop cached details that are
      // older than it. Field comparison alone cannot catch instructions-only
      // updates (instructions never appear on the summary); the monotonic
      // profileRevision covers those. Either signal invalidates.
      // Revision-monotonic merge: a row older than the proven revision (e.g.
      // a deferred list snapshot from rev2 landing after detail already
      // converged rev3) is stale — keep the local row and never let its
      // fieldsDiffer check delete the newer detail. Freshness is symmetric
      // with the mutation path: newer state always wins, regardless of which
      // response lands last.
      const nextDetails = { ...botDetails.value };
      const prevSummaries: Record<string, BotSummaryDto | undefined> = {};
      for (const b of prevList) prevSummaries[b.id] = b;
      const mergedRows: BotSummaryDto[] = [];
      const present = new Set<string>();
      for (const b of res.bots) {
        const detailKey = `${targetInstanceId}:${b.id}`;
        // Presence is snapshot membership, not adoption: a stale row for a
        // still-existing Bot proves presence (clears tombstones) even though
        // its fields are too old to merge.
        present.add(detailKey);
        const proven = botProvenRevision[detailKey];
        if (
          typeof b.profileRevision === "number"
          && proven !== undefined
          && b.profileRevision < proven
        ) {
          // Stale snapshot row: the server took this snapshot before newer
          // state we already converged. Keep the local row untouched —
          // details, generations, tombstones, and proven revision all stay.
          const prev = prevSummaries[b.id];
          if (prev) mergedRows.push(prev);
          continue;
        }
        const prev = prevSummaries[b.id];
        // A newer summary revision proves any in-flight detail for an older
        // revision stale — even when no detail is cached yet (sidebar Edit on
        // an unselected Bot starts D1 while bots-changed lands rev2). Bump
        // the generation unconditionally so the late rev1 D1 can neither
        // write the cache nor hand stale instructions to BotDialog.
        if (
          typeof prev?.profileRevision === "number"
          && typeof b.profileRevision === "number"
          && b.profileRevision > prev.profileRevision
        ) {
          botDetailSeq[detailKey] = (botDetailSeq[detailKey] ?? 0) + 1;
        }
        const cached = nextDetails[detailKey];
        if (cached) {
          const revisionStale =
            typeof cached.profileRevision === "number"
            && typeof b.profileRevision === "number"
            && b.profileRevision > cached.profileRevision;
          const fieldsDiffer =
            cached.name !== b.name
            || cached.agent !== b.agent
            || cached.workspace !== b.workspace
            || (cached.model ?? undefined) !== (b.model ?? undefined)
            || (cached.effort ?? undefined) !== (b.effort ?? undefined)
            || cached.enabled !== b.enabled
            || (cached.avatar ?? undefined) !== (b.avatar ?? undefined)
            || (cached.role ?? undefined) !== (b.role ?? undefined);
          if (revisionStale || fieldsDiffer) {
            delete nextDetails[detailKey];
            botDetailSeq[detailKey] = (botDetailSeq[detailKey] ?? 0) + 1;
          }
        }
        mergedRows.push(
          prevRuntime[b.id] && !b.hasRuntime ? { ...b, hasRuntime: true as const } : b,
        );
        if (typeof b.profileRevision === "number") {
          botProvenRevision[detailKey] = Math.max(proven ?? -1, b.profileRevision);
        }
      }
      // Tombstone maintenance on an authoritative snapshot: present ids are
      // alive (Bot ids are never reused, so presence clears the tombstone);
      // ids we previously tracked but the server no longer returns are proven
      // deleted — tombstone them so a late mutation response cannot resurrect
      // the row, and drop their cached details. First loads prove nothing:
      // with no previously known ids the absent set is empty by construction.
      // (`present` is raw snapshot membership: stale rows that kept their
      // local row still prove the Bot exists and clear tombstones.)
      const knownKeys = new Set<string>();
      for (const b of prevList) knownKeys.add(`${targetInstanceId}:${b.id}`);
      for (const key of Object.keys(nextDetails)) {
        if (key.startsWith(`${targetInstanceId}:`)) knownKeys.add(key);
      }
      for (const key of Object.keys(botProvenRevision)) {
        if (key.startsWith(`${targetInstanceId}:`)) knownKeys.add(key);
      }
      for (const key of Object.keys(botDeletedAtSeq)) {
        if (key.startsWith(`${targetInstanceId}:`)) knownKeys.add(key);
      }
      for (const key of knownKeys) {
        if (present.has(key)) {
          delete botDeletedAtSeq[key];
        } else {
          if (botDeletedAtSeq[key] === undefined) {
            botDeletedAtSeq[key] = (botDeletedAtSeq[key] ?? 0) + 1;
            // Invalidate any in-flight detail so a stale response cannot
            // resurrect the dropped entry either.
            botDetailSeq[key] = (botDetailSeq[key] ?? 0) + 1;
          }
          delete nextDetails[key];
          delete botDetailHydrated[key];
        }
      }
      botDetails.value = nextDetails;
      botsByInstance.value = {
        ...botsByInstance.value,
        [targetInstanceId]: mergedRows,
      };
      botsLoaded.value = {
        ...botsLoaded.value,
        [targetInstanceId]: true,
      };
      return res.bots;
    } catch (err: unknown) {
      // A failed refresh leaves no fresh cache: invalidate so the next Bots
      // tab entry retries instead of serving the stale list forever. Only the
      // latest request may invalidate; a stale failure must not clear a newer
      // success.
      if (botsListSeq[targetInstanceId] === seq) {
        botsLoaded.value = {
          ...botsLoaded.value,
          [targetInstanceId]: false,
        };
      }
      throw err;
    } finally {
      // Only this instance's counter decrements; a stale (superseded) A must
      // not clear B's spinner. Clamp at zero against double-decrement.
      const remaining = Math.max(0, (loadingBotsByInstance.value[targetInstanceId] ?? 1) - 1);
      if (remaining === 0) {
        const { [targetInstanceId]: _done, ...rest } = loadingBotsByInstance.value;
        loadingBotsByInstance.value = rest;
      } else {
        loadingBotsByInstance.value = { ...loadingBotsByInstance.value, [targetInstanceId]: remaining };
      }
    }
  }

  // True when the cache holds a full BotDetailDto from an authoritative
  // source (bots.get/create/update) — never a list synthesis. The revision
  // comparison keeps a stale hydration from gating a newer dialog open: if
  // the summary has since moved past the hydrated revision, a refetch is due.
  function isBotDetailHydrated(targetInstanceId: string, botId: string): boolean {
    const detailKey = `${targetInstanceId}:${botId}`;
    const hydratedRev = botDetailHydrated[detailKey];
    if (hydratedRev === undefined) return false;
    if (!(detailKey in botDetails.value)) return false;
    const summaryRev = botsByInstance.value[targetInstanceId]?.find((b) => b.id === botId)?.profileRevision;
    if (typeof summaryRev === "number" && summaryRev > hydratedRev) return false;
    return true;
  }

  async function loadBotDetail(targetInstanceId: string, botId: string): Promise<BotDetailDto> {
    const detailKey = `${targetInstanceId}:${botId}`;
    const seq = (botDetailSeq[detailKey] ?? 0) + 1;
    botDetailSeq[detailKey] = seq;
    const res = unwrapRpc(
      await api.rpc<{ bot: BotDetailDto }>(targetInstanceId, MSG.botsGet, { id: botId }),
    );
    // A stale (superseded) detail response must not clobber the newer cache,
    // nor may it pose as an authoritative answer for callers with side
    // effects (e.g. BotDialog instructions fill). When a newer cache row
    // exists, return it; when the cache is still empty (e.g. a rev1 D1 raced
    // by a rev2 summary that bumped the generation), the stale rev1 payload
    // must never reach the caller — refetch authoritatively instead.
    if (botDetailSeq[detailKey] !== seq) {
      const current = botDetails.value[detailKey];
      if (current) return current;
      return await loadBotDetail(targetInstanceId, botId);
    }
    const prevDetail = botDetails.value[detailKey];
    botDetails.value = {
      ...botDetails.value,
      [detailKey]:
        prevDetail?.hasRuntime && !res.bot.hasRuntime ? { ...res.bot, hasRuntime: true as const } : res.bot,
    };
    botProvenRevision[detailKey] = Math.max(botProvenRevision[detailKey] ?? -1, res.bot.profileRevision);
    botDetailHydrated[detailKey] = res.bot.profileRevision;
    return res.bot;
  }

  // Local list convergence for a committed Bot write: the follow-up list
  // refresh is best-effort, so the dialog must see its Bot immediately.
  // Keeps a sticky hasRuntime=true (execution evidence) the same way the
  // list snapshot merge does — a refresh row must never clear it.
  // Monotonic: a late mutation response at an older profileRevision never
  // rolls back a newer row, and a tombstoned (authoritatively deleted) Bot is
  // never resurrected. Returns true when the row was adopted.
  function mergeBotSummary(targetInstanceId: string, bot: BotDetailDto): boolean {
    const key = `${targetInstanceId}:${bot.id}`;
    if (botDeletedAtSeq[key] !== undefined) return false;
    const proven = botProvenRevision[key];
    if (proven !== undefined && bot.profileRevision < proven) return false;
    botProvenRevision[key] = Math.max(proven ?? -1, bot.profileRevision);
    const list = botsByInstance.value[targetInstanceId] ?? [];
    const prev = list.find((b) => b.id === bot.id);
    if (
      prev &&
      typeof prev.profileRevision === "number" &&
      bot.profileRevision < prev.profileRevision
    ) {
      return false;
    }
    const row: BotSummaryDto =
      prev?.hasRuntime && !bot.hasRuntime ? { ...bot, hasRuntime: true as const } : bot;
    const idx = list.findIndex((b) => b.id === bot.id);
    const next = idx >= 0 ? [...list.slice(0, idx), row, ...list.slice(idx + 1)] : [...list, row];
    botsByInstance.value = { ...botsByInstance.value, [targetInstanceId]: next };
    botsLoaded.value = { ...botsLoaded.value, [targetInstanceId]: true };
    return true;
  }

  async function createBot(
    targetInstanceId: string,
    payload: {
      name: string;
      agent: string;
      workspace: string;
      avatar?: string;
      role?: string;
      instructions?: string;
      model?: string;
      effort?: string;
      enabled?: boolean;
    },
  ): Promise<BotDetailDto> {
    const res = unwrapRpc(
      await api.rpc<{ bot: BotDetailDto }>(targetInstanceId, MSG.botsCreate, payload),
    );
    const detailKey = `${targetInstanceId}:${res.bot.id}`;
    // Monotonic detail write: a late create response (older revision, or a
    // tombstoned id) must not roll back newer converged state.
    if (
      botDeletedAtSeq[detailKey] === undefined &&
      (botProvenRevision[detailKey] === undefined || res.bot.profileRevision >= botProvenRevision[detailKey])
    ) {
      const prevDetail = botDetails.value[detailKey];
      botDetails.value = {
        ...botDetails.value,
        [detailKey]:
          prevDetail?.hasRuntime && !res.bot.hasRuntime
            ? { ...res.bot, hasRuntime: true as const }
            : res.bot,
      };
      botProvenRevision[detailKey] = Math.max(botProvenRevision[detailKey] ?? -1, res.bot.profileRevision);
      botDetailHydrated[detailKey] = res.bot.profileRevision;
      mergeBotSummary(targetInstanceId, res.bot);
    }
    botDetailSeq[detailKey] = (botDetailSeq[detailKey] ?? 0) + 1;
    // The mutation RPC already committed (every create mints a new Bot id):
    // a failed follow-up list refresh must not report the create as failed —
    // the user retrying would mint a second durable Bot. Merge locally and
    // let the refresh converge best-effort in the background.
    void loadBots(targetInstanceId).catch(() => {});
    return res.bot;
  }

  async function updateBot(
    targetInstanceId: string,
    botId: string,
    patch: {
      name?: string;
      avatar?: string | null;
      role?: string | null;
      instructions?: string | null;
      agent?: string;
      workspace?: string;
      model?: string | null;
      effort?: string | null;
      enabled?: boolean | null;
    },
  ): Promise<BotDetailDto> {
    const res = unwrapRpc(
      await api.rpc<{ bot: BotDetailDto }>(targetInstanceId, MSG.botsUpdate, { id: botId, ...patch }),
    );
    const detailKey = `${targetInstanceId}:${botId}`;
    // Same monotonic rule as create: a stale update response never rolls
    // back newer converged state or resurrects a deleted Bot.
    if (
      botDeletedAtSeq[detailKey] === undefined &&
      (botProvenRevision[detailKey] === undefined || res.bot.profileRevision >= botProvenRevision[detailKey])
    ) {
      const prevDetail = botDetails.value[detailKey];
      botDetails.value = {
        ...botDetails.value,
        [detailKey]:
          prevDetail?.hasRuntime && !res.bot.hasRuntime
            ? { ...res.bot, hasRuntime: true as const }
            : res.bot,
      };
      botProvenRevision[detailKey] = Math.max(botProvenRevision[detailKey] ?? -1, res.bot.profileRevision);
      botDetailHydrated[detailKey] = res.bot.profileRevision;
      mergeBotSummary(targetInstanceId, res.bot);
    }
    botDetailSeq[detailKey] = (botDetailSeq[detailKey] ?? 0) + 1;
    // Same committed-write rule as create: the update already persisted, so
    // merge locally and refresh best-effort instead of failing the save.
    void loadBots(targetInstanceId).catch(() => {});
    return res.bot;
  }

  async function deleteBot(targetInstanceId: string, botId: string): Promise<void> {
    unwrapRpc(await api.rpc<{ ok: boolean }>(targetInstanceId, MSG.botsDelete, { id: botId }));
    // Retire first: a deferred pre-delete list snapshot must land on the
    // stale branch — otherwise its membership would clear the tombstone
    // below and reinsert the just-deleted row.
    retireBotCatalogRequests(targetInstanceId);
    dropBotDetail(targetInstanceId, botId);

    const list = botsByInstance.value[targetInstanceId] ?? [];
    botsByInstance.value = {
      ...botsByInstance.value,
      [targetInstanceId]: list.filter((b) => b.id !== botId),
    };

    if (instanceId.value === targetInstanceId && selectedBotId.value === botId) {
      clearSelection();
    }
  }

  // RPC: Conversations & Topics
  async function loadConversations(
    targetInstanceId: string,
    filter?: { botId?: string },
  ): Promise<ConversationSummaryDto[]> {
    const res = unwrapRpc(
      await api.rpc<{ conversations: ConversationSummaryDto[] }>(
        targetInstanceId,
        MSG.conversationsList,
        filter ?? {},
      ),
    );
    conversationsByInstance.value = {
      ...conversationsByInstance.value,
      [targetInstanceId]: res.conversations,
    };
    return res.conversations;
  }

  async function loadTopics(targetInstanceId: string, conversationId: string): Promise<TopicSummaryDto[]> {
    const key = `${targetInstanceId}:${conversationId}`;
    const seq = (topicsSeq[key] ?? 0) + 1;
    topicsSeq[key] = seq;
    const res = unwrapRpc(
      await api.rpc<{ topics: TopicSummaryDto[] }>(targetInstanceId, MSG.topicsList, { conversationId }),
    );
    if (topicsSeq[key] !== seq) {
      // A newer write (create merge or WS event) landed while this snapshot
      // was in flight: merge the snapshot into the newer rows by id instead
      // of replacing them, so a late T1 cannot delete Topic B. Newer rows win
      // on id conflict.
      const currentList = topicsByConversation.value[key] ?? [];
      const merged: Record<string, TopicSummaryDto> = {};
      for (const t of res.topics) merged[t.id] = t;
      for (const t of currentList) merged[t.id] = t;
      const next = Object.values(merged);
      topicsByConversation.value = { ...topicsByConversation.value, [key]: next };
      return next;
    }
    topicsByConversation.value = {
      ...topicsByConversation.value,
      [key]: res.topics,
    };
    return res.topics;
  }

  async function createTopic(
    targetInstanceId: string,
    conversationId: string,
    title: string,
  ): Promise<TopicSummaryDto> {
    const res = unwrapRpc(
      await api.rpc<{ topic: TopicSummaryDto }>(targetInstanceId, MSG.topicsCreate, {
        conversationId,
        title,
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
      topicsByConversation.value = {
        ...topicsByConversation.value,
        [key]: [...currentList, res.topic],
      };
    }
    // A persisted Direct Conversation row alone does not lock identity:
    // only an actual binding/session (execution evidence) converges
    // hasRuntime. Delete stays fail-closed backend-side via bot_in_use.
    // Switch to new topic if in the same conversation
    if (instanceId.value === targetInstanceId && activeConversationId.value === conversationId) {
      await switchTopic(res.topic.id);
    }
    return res.topic;
  }

  // History loading and transcript convergence. Every load closes the
  // admission gate at (re)discovery start and reopens it only on proven
  // discovery (active candidate or authoritative no-candidate): the terminal
  // owner handoff below re-runs discovery instead of trusting a background
  // transcript refresh, so a queued next Run can never hide behind an open
  // gate. Transcript paging stays seq-cursor driven.
  // A durable bot row proves the final answer: an unproven (never
  // turn-finished) cached trace for the same Run is a stale partial that
  // must not shadow it — drop it so the canonical content renders.
  function pruneIncompleteTraces(): void {
    const completeFlags = runPartsComplete.value;
    const truncatedFlags = runPartsTruncated.value;
    let prunedParts: Record<string, TurnPartDto[]> | null = null;
    for (const m of messages.value) {
      // Unproven OR hub-truncated: neither may shadow the durable final row.
      if (m.runId && runParts.value[m.runId]?.length && (!completeFlags[m.runId] || truncatedFlags[m.runId])) {
        if (!prunedParts) prunedParts = { ...runParts.value };
        delete prunedParts[m.runId];
      }
    }
    if (prunedParts) runParts.value = prunedParts;
  }

  // Merge one newest-bounded page into the loaded window, preserving the
  // already-loaded left edge and newest cursor. Loaded rows win on id
  // conflict (same id with locally-merged stream state).
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
    // Monotonic max: a live message that arrived mid-load may already have
    // pushed newestSeq past this page's tail — never roll it back.
    if (res.newestSeq !== undefined && (newestSeq.value === undefined || res.newestSeq > newestSeq.value)) {
      newestSeq.value = res.newestSeq;
    }
    hasMoreAfter.value = res.hasMoreAfter;
  }
  // Fill an interior seq hole between the previously loaded newest row and a
  // bounded newest tail (e.g. >50 durable messages arrived while offline).
  // Pages forward with afterSeq until the cursor reaches the tail: each page
  // must strictly advance the cursor, so a wedged server terminates instead
  // of spinning. Four-state result: "complete" (window is contiguous),
  // "incomplete" (transport/progress failure — retryable), "superseded"
  // (view switched or a newer reload started — silent exit, never a stale
  // error write), "live-race" (a live message landed mid-fill — the caller
  // convergent-retries the whole load like the single-page fence does).
  async function fillHistoryGap(
    iId: string,
    cId: string,
    tId: string,
    requestSequence: number,
    revision: number,
    fromNewest: number,
    tailOldest: number,
    tailNewest: number | undefined,
    merged: Record<string, ConversationMessageDto>,
  ): Promise<"complete" | "incomplete" | "superseded" | "live-race"> {
    let cursor = fromNewest;
    // Claim contiguity only through the chained window: walk up from the
    // proven cursor through actually-present seqs (tail rows merged before
    // the fill plus live rows that chained onto the tail). Never jump to the
    // tail max — it may sit above an unfilled hole.
    const markComplete = (): "complete" => {
      const seqs = new Set<number>();
      for (const m of messages.value) seqs.add(m.seq);
      let c = cursor;
      while (seqs.has(c + 1)) c += 1;
      if (contiguousNewestSeq.value === undefined || c > contiguousNewestSeq.value) {
        contiguousNewestSeq.value = c;
      }
      return "complete" as const;
    };
    // Transcript revision the fill itself last produced: the fence below must
    // only fire on EXTERNAL mutations (live messages), not on the fill's own
    // merges. Re-anchor after every own write.
    let expectedRevision = revision;
    for (;;) {
      let gapRes: ConversationHistoryResponseDto;
      try {
        gapRes = unwrapRpc(
          await api.rpc<ConversationHistoryResponseDto>(iId, MSG.conversationHistory, {
            conversationId: cId,
            topicId: tId,
            afterSeq: cursor,
            limit: 50,
          }),
        );
      } catch {
        // Transport failure mid-fill: first check the supersede fence — a
        // reject that lands after a view switch / newer reload belongs to a
        // dead request and must exit silently, never paint the old error onto
        // the new view. Otherwise report incomplete so the caller keeps the
        // gate closed with a retryable error; the retry keys off the
        // contiguous cursor, not the tail max, so the hole is re-attempted.
        if (
          instanceId.value !== iId ||
          activeConversationId.value !== cId ||
          activeTopicId.value !== tId ||
          requestSequence !== historyRequestSequence
        ) {
          return "superseded";
        }
        return "incomplete";
      }
      if (
        instanceId.value !== iId ||
        activeConversationId.value !== cId ||
        activeTopicId.value !== tId ||
        requestSequence !== historyRequestSequence
      ) {
        return "superseded";
      }
      // A live message mutated the transcript while this page was in flight:
      // its rows are not in this page's snapshot, so adopting the page would
      // drop them. Report live-race so the caller convergent-retries the
      // whole load (same discovery id semantics as the single-page fence).
      if (expectedRevision !== transcriptRevision) {
        return "live-race";
      }
      if (gapRes.messages.length === 0) return markComplete();
      for (const m of gapRes.messages) {
        merged[m.id] = m;
      }
      // Re-merge live rows on top: a conversation-message that landed while
      // this page was in flight is newer than the page snapshot and must not
      // be clobbered by the write below.
      for (const m of messages.value) {
        if (m.seq > cursor) merged[m.id] = m;
      }
      messages.value = Object.values(merged).sort((a, b) => a.seq - b.seq);
      touchTranscript();
      expectedRevision = transcriptRevision;
      const pageNewest = Math.max(...gapRes.messages.map((m) => m.seq));
      // Strict progress: a page that does not move past the cursor (empty,
      // duplicate, or rewound) ends the fill instead of looping forever.
      if (pageNewest <= cursor) return "incomplete";
      cursor = pageNewest;
      if (cursor >= tailOldest - 1) return markComplete();
      if (tailNewest !== undefined && cursor >= tailNewest) return markComplete();
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
    // Every load owns durable-owner discovery: the id minted here fences
    // the recovery below, so concurrent loads cannot interleave owners. A
    // terminal handoff may share one pre-minted id across its retries so
    // concurrent terminal events for the same Run do not stack redundant
    // discovery round trips.
    const discoveryId = opts?.reuseDiscoveryId ?? ++discoverySequence;
    const revision = transcriptRevision;
    loadingHistory.value = true;
    historyError.value = null;
    // (Re)discovery starts: close admission until the owner is proven again.
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

      // Verify that the view hasn't switched while loading
      if (instanceId.value !== iId || activeConversationId.value !== cId || activeTopicId.value !== tId) {
        return;
      }
      // Same-view fence: a newer reload started after this request; the stale
      // page must not clobber the newer transcript.
      if (requestSequence !== historyRequestSequence) {
        return;
      }
      // A live event mutated the transcript while this request was in flight
      // (e.g. conversation-message arrived); retry against the same view so
      // persisted history and live state converge instead of overwriting. The
      // retry reuses the same discovery id AND harvest context: it is the
      // same logical discovery, not a newer one, so it must not invalidate
      // its own recovery or drop the handoff harvest.
      if (revision !== transcriptRevision) {
        void loadHistory(iId, cId, tId, {
          reuseDiscoveryId: discoveryId,
          ...(opts?.harvestTerminalHandoff ? { harvestTerminalHandoff: opts.harvestTerminalHandoff } : {}),
        });
        return;
      }

      // Merge the canonical newest page into the loaded window instead of
      // replacing it: the user may have paged back (loadOlder) and be reading
      // older rows. newestSeq tracks the max seen (display cursor);
      // contiguousNewestSeq tracks the max proven contiguous — the gap
      // decision and retry below must key on the latter, or a failed fill
      // would leave newestSeq at the tail max and the retry would conclude
      // "no gap" over a still-holed window.
      const prevContiguousBeforeMerge = contiguousNewestSeq.value;
      const merged: Record<string, ConversationMessageDto> = {};
      mergeHistoryPage(res, merged);
      hasMoreAfter.value = res.hasMoreAfter;
      // Gap fill: when the newest tail starts strictly after the previously
      // proven-contiguous row (e.g. >50 durable messages arrived while
      // offline), the merge above leaves an interior seq hole (1..50 +
      // 71..120). Page forward from the contiguous cursor until the tail is
      // reached so the merged window stays contiguous; Load Older alone
      // cannot repair it because the hole is in the middle, not at either
      // edge. Unbounded with strict per-page progress: only a page that
      // fails to advance the cursor ends the fill, and then recovery below
      // must NOT claim success.
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
        // Contiguous claim (if any) was made inside the fill; nothing to do.
      } else if (res.newestSeq !== undefined) {
        // No hole: the tail extends (or re-states) a contiguous window.
        if (contiguousNewestSeq.value === undefined || res.newestSeq > contiguousNewestSeq.value) {
          contiguousNewestSeq.value = res.newestSeq;
        }
      }
      // If any bot message in history corresponds to an active run, converge liveTurn
      if (activeRun.value) {
        const canonicalBotMsg = messages.value.find(
          (m) => m.role === "bot" && m.runId === activeRun.value?.id,
        );
        if (canonicalBotMsg) {
          liveTurn.value = null;
        }
      }
      // Durable active-run recovery: after the authoritative tail is in place,
      // query topic-scoped runs so refresh finds the authoritative owner even
      // when no live snapshot/event has arrived yet. The discovery id is
      // passed so a superseded load cannot let its slow recovery overwrite a
      // newer one. Admission opens only on proven discovery (active candidate
      // or authoritative no-candidate): a runs.list failure leaves the gate
      // closed so a prompt cannot take wrong ownership of an unseen Run. An
      // incomplete gap fill likewise keeps the gate closed with a retryable
      // history error instead of presenting a holed transcript as recovered.
      // A superseded fill (view switch / newer reload) exits silently: the
      // newer load owns the transcript now, so this stale one must not paint
      // an error over it. A live-race fill convergent-retries the whole load
      // against the same view (same discovery id, so its own recovery is not
      // invalidated), exactly like the single-page revision fence above.
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
      const discovered = await recoverActiveRun(
        iId,
        cId,
        tId,
        discoveryId,
        opts?.harvestTerminalHandoff,
      );
      // A stale load that lost the sequence fence returns above without
      // reaching here.
      if (discovered) {
        topicReady.value = true;
        ownershipUncertain.value = false;
        cancelError.value = null;
      } else if (
        // A superseded load (a newer discovery started, e.g. a terminal
        // handoff racing a deferred runs.get) must not pin a stale failure
        // over the newer recovery's outcome.
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
      // Same supersede rule as above: a stale history failure must not
      // overwrite a newer load's converged state.
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
  // Query durable topic Runs and adopt the authoritative active Run: the
  // executing Run, else the oldest queued (next-up) Run.
  // Uses exact product IDs (conversationId/topicId/runId/memberTurnId) only;
  // never session aliases, timestamps, or latest-turn heuristics.
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
      // Discovery and paging are separate semantics: the owner can arrive as
      // activeRun even when the bounded runs page omits it.
      const candidate = listed.activeRun
        ?? (listed.activeRunId ? listed.runs.find((run) => run.id === listed.activeRunId) : undefined);
      if (!candidate) {
        // No authoritative active Run: leave local state alone. The
        // reconcile rId branch (same active-state predicate) converges a
        // stale local Run via runsGet; clearing here would destroy the id it
        // needs and skip terminal convergence + history reload.
        // Authoritative no-candidate IS proven discovery: admission may open.
        return true;
      }
      // When an authoritative candidate differs from local non-terminal activeRun,
      // adopt the authoritative candidate (durable owner replaces optimistic local owner).
      if (activeRun.value && activeRun.value.id !== candidate.id && !isTerminalRunState(activeRun.value.state)) {
        activeRun.value = mergeRun(null, candidate);
        activeMemberTurn.value = null;
        liveTurn.value = null;
        latestPlanRunId.value = candidate.id;
      } else {
        activeRun.value = mergeRun(activeRun.value?.id === candidate.id ? activeRun.value : null, candidate);
      }
      // A terminal handoff that already applied the WS terminal row must not
      // be regressed: if the handoff named this exact Run and it is terminal
      // locally, converge without re-fetching detail (the detail response is
      // older than the event and mergeRun would keep the terminal state, but
      // the member-turn merge below could still clobber fresher turn state).
      if (
        harvestTerminalHandoff &&
        activeRun.value.id === harvestTerminalHandoff.runId &&
        isTerminalRunState(activeRun.value.state)
      ) {
        liveTurn.value = null;
        return true;
      }
      if (isTerminalRunState(activeRun.value.state)) {
        liveTurn.value = null;
        return true;
      }
      // Fetch authoritative Run detail (member turns) without touching live snapshots.
      try {
        const detail = unwrapRpc(
          await api.rpc<{ run: ConversationRunDetailDto }>(iId, MSG.runsGet, { runId: candidate.id }),
        );
        if (!isCurrentRecovery()) {
          return false;
        }
        // Defense in depth: the detail must describe the requested candidate.
        // A mismatched detail row must never silently swap the adopted owner
        // (mergeRun returns a different id verbatim); keep the proven owner
        // row and treat discovery as proven.
        if (detail?.run && detail.run.id !== candidate.id) {
          return true;
        }
        if (activeRun.value && activeRun.value.id !== candidate.id) {
          return true;
        }
        // Same handoff guard after the detail fetch: the WS terminal row is
        // newer than any in-flight detail response for the same Run.
        if (
          harvestTerminalHandoff &&
          activeRun.value.id === harvestTerminalHandoff.runId &&
          isTerminalRunState(activeRun.value.state)
        ) {
          liveTurn.value = null;
          return true;
        }
        if (detail?.run) {
          activeRun.value = mergeRun(activeRun.value, detail.run);
          const latestMember = detail.run.memberTurns?.length
            ? detail.run.memberTurns[detail.run.memberTurns.length - 1]
            : undefined;
          if (latestMember && (!activeMemberTurn.value || activeMemberTurn.value.runId === candidate.id)) {
            activeMemberTurn.value = mergeMemberTurn(activeMemberTurn.value, latestMember);
          }
        }
        if (isTerminalRunState(activeRun.value.state)) {
          liveTurn.value = null;
        }
        return true;
      } catch {
        // Keep the adopted Run row; detail fetch is best-effort recovery.
        // The owner row itself was proven above, so admission may open.
        return true;
      }
    } catch {
      // Runs discovery failed (network or older connector answering
      // unknown-type): the owner is unproven, so admission stays closed and
      // loadHistory surfaces a discovery error with retry. Never treat this
      // as proven no-candidate.
      return false;
    }
  }

  // Transcript-only convergence: reload the canonical history page on a
  // prompt-proven owner only (new-connector terminal accept that names the
  // accepted Run as owner). Admission stays as-is on success, but an
  // incomplete history/gap load closes it: the window is holed, so a further
  // prompt could queue behind an unseen Run. Retry reopens via loadHistory.
  // Never use on an unproven terminal accept — those run full rediscovery.
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
        // Same merge as loadHistory: never drop already-loaded older rows the
        // user paged back to read when the bounded newest page refreshes.
        const prevContiguousBeforeMerge = contiguousNewestSeq.value;
        const merged: Record<string, ConversationMessageDto> = {};
        mergeHistoryPage(res, merged);
        hasMoreAfter.value = res.hasMoreAfter;
        // Same interior-gap repair as loadHistory: a reused-completed accept
        // can land while >50 durable messages arrived, leaving the same
        // middle hole Load Older cannot reach.
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
          // Contiguous claim (if any) was made inside the fill; nothing to do.
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
            liveTurn.value = null;
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

  // Terminal owner handoff: a Run just reached a terminal state, so the next
  // queued Run (if any) is now the authoritative owner. Close the admission
  // gate, refresh the canonical transcript, then re-run durable discovery:
  // adopt queued B and keep the composer blocked, or open the gate only on
  // authoritative no-candidate. Pre-terminal B stream events stay fenced on
  // the old Run id, so discovery completing first cannot lose ownership.
  function rediscoverAfterTerminal(
    targetInstanceId: string | null,
    convId: string | null,
    topId: string | null,
    harvestRunId?: string,
  ): void {
    if (!targetInstanceId || !convId || !topId) return;
    const runId = harvestRunId;
    // Capture the discovery generation synchronously: concurrent terminal
    // events for the same Run share one handoff instead of stacking
    // redundant history+discovery round trips.
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
    if (!iId || !cId || !tId || !hasMoreBefore.value || oldestSeq.value === undefined) {
      return;
    }
    // Same-view singleflight: a second page for the SAME topic waits on the
    // first; a page for a DIFFERENT topic is never blocked by a stale owner.
    const owner = `${iId}:${cId}:${tId}`;
    if (loadingOlder.value && olderRequestOwner === owner) return;
    if (loadingOlder.value) {
      // A stale owner (Topic A) still holds the flag after a switch: retire
      // it — its view fence already prevents transcript writes, and its
      // finally below is token-checked so it cannot clear the new owner.
      olderRequestToken += 1;
    }
    const token = ++olderRequestToken;
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

      if (instanceId.value !== iId || activeConversationId.value !== cId || activeTopicId.value !== tId) {
        return;
      }

      if (res.messages.length > 0) {
        const existingMap = new Map<string, ConversationMessageDto>();
        for (const m of messages.value) {
          existingMap.set(m.id, m);
        }
        for (const m of res.messages) {
          existingMap.set(m.id, m);
        }
        messages.value = [...existingMap.values()].sort((a, b) => a.seq - b.seq);
        touchTranscript();
        if (res.oldestSeq !== undefined) {
          oldestSeq.value = res.oldestSeq;
        }
      }
      hasMoreBefore.value = res.hasMoreBefore;
    } catch (err: unknown) {
      // Non-fatal pagination error
      console.warn("loadOlder failed:", err);
    } finally {
      // Only the owning request clears the flag: a retired Topic-A page that
      // settles after Topic B re-acquired must not drop B's spinner.
      if (token === olderRequestToken && olderRequestOwner === owner) {
        loadingOlder.value = false;
      }
    }
  }

  // Selection & Navigation
  async function selectBot(targetInstanceId: string, botId: string): Promise<void> {
    const generation = ++currentSelectionGeneration;
    historyRequestSequence += 1;
    discoverySequence += 1;
    retireOlderRequest();
    touchTranscript();
    topicReady.value = false;
    instanceId.value = targetInstanceId;
    selectedBotId.value = botId;
    persistBotSelection(targetInstanceId, botId);

    // Reset topic, history, live state
    activeConversationId.value = null;
    activeTopicId.value = null;
    messages.value = [];
    oldestSeq.value = undefined;
    newestSeq.value = undefined;
    contiguousNewestSeq.value = undefined;
    hasMoreBefore.value = false;
    hasMoreAfter.value = false;
    activeRun.value = null;
    activeMemberTurn.value = null;
    liveTurn.value = null;
    latestPlanRunId.value = null;
    cancellingRunId.value = null;
    cancelUncertaintyRunId.value = null;
    cancelError.value = null;
    ownershipUncertain.value = false;
    promptInFlight.value = false;
    promptError.value = null;
    promptErrorDetail.value = null;
    currentDraftRequestId.value = null;
    lastPromptText.value = "";
    generalError.value = null;
    generalErrorCode.value = null;
    try {
      const bots = await loadBots(targetInstanceId);
      if (generation !== currentSelectionGeneration || instanceId.value !== targetInstanceId || selectedBotId.value !== botId) {
        return;
      }
      if (!bots.some((b) => b.id === botId)) {
        clearSelection();
        return;
      }
    } catch {
      // List refresh failed: keep the selection; history load below surfaces it.
    }

    // Resolve or find Direct Conversation
    try {
      const convs = await loadConversations(targetInstanceId, { botId });
      if (generation !== currentSelectionGeneration || instanceId.value !== targetInstanceId || selectedBotId.value !== botId) {
        return;
      }
      const conv = convs[0];
      if (conv) {
        activeConversationId.value = conv.id;
        const topics = await loadTopics(targetInstanceId, conv.id);
        if (generation !== currentSelectionGeneration || instanceId.value !== targetInstanceId || selectedBotId.value !== botId) {
          return;
        }
        const targetTopicId = conv.defaultTopicId ?? topics[0]?.id;
        if (targetTopicId) {
          activeTopicId.value = targetTopicId;
          await loadHistory(targetInstanceId, conv.id, targetTopicId);
        }
      }
    } catch (err: unknown) {
      if (generation === currentSelectionGeneration && selectedBotId.value === botId) {
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
    activeMemberTurn.value = null;
    liveTurn.value = null;
    latestPlanRunId.value = null;
    cancellingRunId.value = null;
    cancelUncertaintyRunId.value = null;
    cancelError.value = null;
    ownershipUncertain.value = false;
    promptInFlight.value = false;
    promptError.value = null;
    promptErrorDetail.value = null;
    currentDraftRequestId.value = null;
    lastPromptText.value = "";
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
    selectedBotId.value = null;
    activeConversationId.value = null;
    activeTopicId.value = null;
    messages.value = [];
    oldestSeq.value = undefined;
    newestSeq.value = undefined;
    contiguousNewestSeq.value = undefined;
    hasMoreBefore.value = false;
    hasMoreAfter.value = false;
    activeMemberTurn.value = null;
    activeRun.value = null;
    liveTurn.value = null;
    latestPlanRunId.value = null;
    planByRunId.value = {};
    cancellingRunId.value = null;
    cancelUncertaintyRunId.value = null;
    cancelError.value = null;
    ownershipUncertain.value = false;
    promptInFlight.value = false;
    promptError.value = null;
    promptErrorDetail.value = null;
    currentDraftRequestId.value = null;
    lastPromptText.value = "";
    generalError.value = null;
    generalErrorCode.value = null;
    persistBotSelection(null, null);
  }
  function preparePromptRequestId(text: string): string {
    if (!currentDraftRequestId.value || text !== lastPromptText.value) {
      currentDraftRequestId.value = mintRequestId();
      lastPromptText.value = text;
    }
    return currentDraftRequestId.value;
  }

  async function sendPrompt(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || !instanceId.value || !selectedBotId.value || !activeConversationId.value || !activeTopicId.value) {
      return;
    }

    // Fail-closed admission: while durable run discovery for this Topic has
    // not completed, the authoritative active Run is unknown. Sending now
    // could queue behind an unseen Run and take wrong ownership of it.
    if (!topicReady.value) {
      promptError.value = "topicRecovering";
      promptErrorDetail.value = null;
      return;
    }
    const bot = currentBot.value;
    if (bot && !bot.enabled) {
      promptError.value = "botDisabled";
      promptErrorDetail.value = null;
      return;
    }
    // Fence the slow accept RPC against a recovered durable Run: if recovery
    // adopted an active Run while this prompt was being composed, refuse to
    // send a second prompt into the same Topic.
    if (isRunActive.value) {
      promptError.value = "runInProgress";
      promptErrorDetail.value = null;
      return;
    }
    const targetInstId = instanceId.value;
    const targetBotId = selectedBotId.value;
    const targetConvId = activeConversationId.value;
    const targetTopicId = activeTopicId.value;
    const generation = currentSelectionGeneration;
    const isCurrent = (): boolean =>
      generation === currentSelectionGeneration &&
      instanceId.value === targetInstId &&
      selectedBotId.value === targetBotId &&
      activeConversationId.value === targetConvId &&
      activeTopicId.value === targetTopicId;
    latestPlanRunId.value = null;
    const reqId = preparePromptRequestId(trimmed);
    promptInFlight.value = true;
    promptError.value = null;
    promptErrorDetail.value = null;

    try {
      const res = unwrapRpc(
        await api.rpc<ConversationPromptResponseDto>(targetInstId, MSG.conversationPrompt, {
          conversationId: targetConvId,
          topicId: targetTopicId,
          requestId: reqId,
          text: trimmed,
          target: { botId: targetBotId },
        }),
      );

      // Only project into UI if view context is still current
      if (!isCurrent()) {
        return;
      }

      // Lifecycle projection converges only on evidence that can prove a
      // direct runtime actually materialized: a correlated execution event
      // (dispatcher materialize -> execution-start -> member-turn-started /
      // correlated turn stream) or an authoritative bots list/detail row that
      // already carries hasRuntime=true. HTTP accept only proves the Run is
      // durable (accept transaction + pending dispatch); a queued Run
      // cancelled before execution never creates a binding/session.
      // On successful acceptance, reset current draft requestId so subsequent prompt gets a new id
      currentDraftRequestId.value = null;
      lastPromptText.value = "";

      // Deduplicate human message into messages list
      const existing = messages.value.find((m) => m.id === res.message.id);
      if (!existing) {
        messages.value = [...messages.value, res.message].sort((a, b) => a.seq - b.seq);
        touchTranscript();
        newestSeq.value = Math.max(newestSeq.value ?? 0, res.message.seq);
        // Chained advance only: an accept whose seq lands above an interior
        // hole must not jump the contiguous cursor (see helper).
        advanceContiguousForSeq(res.message.seq);
      }

      // An HTTP accept proves the accepted Run is durable — never that it is
      // the topic-wide owner. A different-id nonterminal Run tracked locally
      // (adopted via authoritative discovery or an earlier accept) stays the
      // owner; the prompt's authoritative owner row (read atomically with the
      // accept) wins over the optimistic accept row: when it names a
      // different nonterminal Run, adopt it so Stop targets the true owner.
      const promptOwner = res.activeRun && !isTerminalRunState(res.activeRun.state)
        ? res.activeRun
        : undefined;
      // Older connectors omit the prompt-carried owner entirely: a nonterminal
      // accept then proves durability only, never topic-wide ownership. Only an
      // owner id that names the accepted Run proves it owns the Topic; anything
      // else (absent, or naming another Run without its row) fails closed
      // below via runs.list before Stop may target the optimistic row.
      const promptOwnerId = res.activeRunId ?? promptOwner?.id;
      const ownerProvesAccepted = promptOwnerId !== undefined && promptOwnerId === res.run.id;
      const ownerProvesOther = !!promptOwner && promptOwner.id !== res.run.id;
      const acceptOverwritesOwner =
        !activeRun.value ||
        activeRun.value.id === res.run.id ||
        isTerminalRunState(activeRun.value.state);
      // Track active run and member turn without regressing already-advanced state
      const priorRunId = activeRun.value?.id;
      const priorRunActive = !!activeRun.value && !isTerminalRunState(activeRun.value.state);
      // Background-confirm a fresh queued adopt with no owner id: the new row
      // is durability-only until runs.list elects the true owner. Fence the
      // cancel door whenever the accept does not prove ownership — whether
      // the local slot was empty (uncontested first adopt, now fenced until
      // discovery confirms) or contested (tracked owner stands, fenced until
      // discovery re-elects it).
      const freshOptimisticAdopt = acceptOverwritesOwner && res.run.state === "queued";
      const ownerUnproven = freshOptimisticAdopt && res.activeRunId === undefined && !promptOwner;
      const ownerUnknown = ownerUnproven;
      // A contested ownerless accept never adopts: the tracked nonterminal
      // owner stands, and the fence below confirms it. Only an empty/terminal
      // slot adopts the optimistic row (still fenced until discovery).
      const contestedOwnerless = priorRunActive && !ownerProvesAccepted && !ownerProvesOther && res.activeRunId === undefined && !promptOwner;
      if (contestedOwnerless) {
        // Contested ownerless accept: the tracked nonterminal owner stands;
        // the fence below confirms it. Never adopt the optimistic row here.
      } else if (promptOwner && promptOwner.id !== res.run.id) {
        // The Topic owner differs from the accepted Run (B durable before C):
        activeRun.value = mergeRun(null, promptOwner);
        activeMemberTurn.value = null;
        liveTurn.value = null;
        latestPlanRunId.value = promptOwner.id;
      } else if (acceptOverwritesOwner) {
        activeRun.value = mergeRun(activeRun.value, res.run);
        if (res.run.id !== activeRun.value.id) {
          activeMemberTurn.value = res.memberTurn;
        } else {
          activeMemberTurn.value = mergeMemberTurn(activeMemberTurn.value, res.memberTurn);
        }
      }
      // Null from here on means the accept did not overwrite: a different-id
      // nonterminal owner stayed tracked. Its HUD/discovery branches below
      // only run on the adopted owner — never on the unowned accept row.
      const adoptedRun = activeRun.value;
      if (!adoptedRun) {
        return;
      }
      // Terminal accept: the accepted Run row is authoritative for the
      // accepted Run only — never for topic-wide ownership. When the accept
      // names the accepted Run as owner (new connectors, prompt-carried id)
      // there is nothing to re-elect and the transcript converges below.
      // Otherwise a queued next Run (B durable while this tab retried A) may
      // own the Topic, so close admission and re-run full durable discovery
      // (history + runs.list): the old-connector idempotent-retry case has no
      // owner fields at all and must fail closed, never assume no-candidate.
      const ownerAdoptedFromPrompt = !!promptOwner && promptOwner.id !== res.run.id;
      const terminalOwnerProven = ownerProvesAccepted;
      if (isTerminalRunState(adoptedRun.state)) {
        liveTurn.value = null;
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
        const existingParts = isFreshRun || (adoptedRun.id === priorRunId && liveTurn.value?.parts.length)
          ? (liveTurn.value?.parts.length ? liveTurn.value.parts : [])
          : runParts.value[res.run.id]?.length
            ? runParts.value[res.run.id]
            : [];
        liveTurn.value = {
          parts: existingParts,
          status: liveTurn.value?.status ?? "working",
          startedAt: res.memberTurn.startedAt
            ? new Date(res.memberTurn.startedAt).getTime()
            : (liveTurn.value?.startedAt ?? Date.now()),
          revision: (liveTurn.value?.revision ?? 0) + 1,
        };
        if (existingParts.length && !runParts.value[res.run.id]) {
          runParts.value = {
            ...runParts.value,
            [res.run.id]: [...existingParts],
          };
        }
      }
      // latestPlanRunId follows the tracked owner only: when the accept did
      // not overwrite (a different-id nonterminal owner stayed), keep the
      // owner's plan context instead of pointing at the unowned accept row.
      if (acceptOverwritesOwner && !ownerAdoptedFromPrompt && !contestedOwnerless) {
        latestPlanRunId.value = res.run.id;
      }
      // Compat fallback: an older connector's queued accept carries no owner
      // id, so the optimistic row above is durability-only. Close the cancel
      // door until runs.list elects the true owner; Stop fails closed
      // meanwhile. New connectors name the accepted Run as owner when it owns
      // the Topic, so a proven owner never trips this fence.
      // Contested ownerless accepts keep the tracked owner above, so there
      // is no optimistic row to confirm — but the fence still closes the
      // cancel door until discovery re-elects the standing owner. Uncontested
      // ownerless adopts confirm in the background AND fence until discovery
      // elects the true owner.
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
      // WS may already have proved durable accept for this requestId (the
      // run-changed adoption branch converges to success and retires the
      // retry identity). A late HTTP failure must not rewrite that success.
      if (isCurrent() && currentDraftRequestId.value === reqId) {
        // Map known server business rejections to UI codes so the user sees
        // the translated banner, not raw backend English. Network/unknown
        // errors keep the raw text as detail.
        const code = err instanceof DirectBotRpcError ? err.code : null;
        if (code === "bot_disabled") {
          promptError.value = "botDisabled";
          promptErrorDetail.value = null;
        } else if (code === "unknown-type") {
          promptError.value = "connectorOutdated";
          promptErrorDetail.value = null;
        } else if (code === "conversation_target_mismatch" || code === "conversation_mismatch") {
          promptError.value = "topicRecovering";
          promptErrorDetail.value = err instanceof Error ? err.message : String(err);
        } else {
          promptError.value = err instanceof Error ? err.message : String(err);
          promptErrorDetail.value = promptError.value;
        }
      } else if (isCurrent() && promptError.value === "runInProgress") {
        // The blocked Prompt C was never sent and its Run is now durable:
        // drop the transient gate error instead of pinning a stale banner.
        promptError.value = null;
        promptErrorDetail.value = null;
      }
      // Retain currentDraftRequestId so a retry uses the exact same requestId
    } finally {
      if (isCurrent()) {
        promptInFlight.value = false;
      }
    }
  }

  // Explicitly retry authoritative run discovery when ownership is uncertain.
  // Returns true if discovery succeeded and confirmed/adopted the authoritative owner.
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
          {
            conversationId: targetConvId,
            topicId: targetTopicId,
          },
        ),
      );
      if (
        checkGeneration !== currentSelectionGeneration ||
        checkDiscoveryId !== discoverySequence ||
        instanceId.value !== targetInstId ||
        activeConversationId.value !== targetConvId ||
        activeTopicId.value !== targetTopicId
      ) {
        return false;
      }

      const authoritativeId = listed.activeRun?.id
        ?? (listed.activeRunId && listed.runs.some((r) => r.id === listed.activeRunId)
          ? listed.activeRunId
          : undefined);

      if (authoritativeId) {
        const authoritativeRow = listed.activeRun
          ?? listed.runs.find((r) => r.id === authoritativeId);
        if (authoritativeRow && !isTerminalRunState(authoritativeRow.state)) {
          if (!activeRun.value || activeRun.value.id !== authoritativeId || isTerminalRunState(activeRun.value.state)) {
            activeRun.value = mergeRun(null, authoritativeRow);
            activeMemberTurn.value = null;
            liveTurn.value = null;
            latestPlanRunId.value = authoritativeId;
          } else {
            activeRun.value = mergeRun(activeRun.value, authoritativeRow);
          }
          // Only an execution-started row proves the hidden direct runtime
          // materialized: queued accept echoes prove durability only, and a
          // queued Run cancelled before execution never creates a binding.
          if (
            (authoritativeRow.state === "running" || authoritativeRow.state === "waiting-human") &&
            instanceId.value && selectedBotId.value
          ) {
            markBotHasRuntime(instanceId.value, selectedBotId.value);
          }
        }
      } else {
        // No active run on backend: if local activeRun was non-terminal, check if listed as terminal
        if (activeRun.value && !isTerminalRunState(activeRun.value.state)) {
          const matchInList = listed.runs.find((r) => r.id === activeRun.value?.id);
          if (matchInList && isTerminalRunState(matchInList.state)) {
            activeRun.value = mergeRun(activeRun.value, matchInList);
            liveTurn.value = null;
          }
        }
      }
      topicReady.value = true;
      ownershipUncertain.value = false;
      cancelError.value = null;
      return true;
    } catch (err: unknown) {
      if (
        checkGeneration === currentSelectionGeneration &&
        checkDiscoveryId === discoverySequence &&
        instanceId.value === targetInstId &&
        activeConversationId.value === targetConvId &&
        activeTopicId.value === targetTopicId
      ) {
        ownershipUncertain.value = true;
        cancelError.value = "ownershipUnconfirmed";
      }
      return false;
    }
  }

  // Exact Run cancellation via runId
  async function cancelCurrentRun(): Promise<void> {
    if (!instanceId.value || !activeRun.value) return;
    // Store-level double-click fence: while a cancel RPC for this Run is in
    // flight the HUD keeps emitting; a second dispatch would race the first
    // and the late failure could re-mark uncertainty on a terminal Run.
    if (cancellingRunId.value === activeRun.value.id) return;
    // Fail closed if ownership is unconfirmed or topic discovery is in flight:
    // do NOT issue cancel RPC for an unconfirmed local owner!
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
      // Retirement rule: only hand off when this response retires the
      // locally-tracked nonterminal Run (not when it merely confirms an
      // already-terminal Run).
      const retiringActiveRun = !isTerminalRunState(activeRun.value.state);
      activeRun.value = mergeRun(activeRun.value, res.run);
      if (isTerminalRunState(activeRun.value.state)) {
        liveTurn.value = null;
        resolveCancelUncertainty(runId);
        if (retiringActiveRun && targetInstId && targetConvId && targetTopicId) {
          void rediscoverAfterTerminal(targetInstId, targetConvId, targetTopicId, activeRun.value.id);
        }
      }
    } catch (err: unknown) {
      console.warn("cancelCurrentRun error:", err);
      // Transport failure does NOT mean durable Run is terminal/indeterminate.
      // Keep activeRun active, track uncertainty separately from prompt errors,
      // and query instance state.
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
            if (isTerminalRunState(activeRun.value.state)) {
              liveTurn.value = null;
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

  // Reconcile on reconnect
  async function reconcileOnReconnect(): Promise<void> {
    // WS events are lost while disconnected: every previously loaded Bot
    // catalog may be stale (create/update/delete, hasRuntime). Mark all
    // known instances dirty AND invalidate their list generations so a
    // pre-reconnect in-flight response cannot re-validate the dirty barrier
    // when it lands late; then reconcile the selected instance in depth.
    // tracked generations: an instance with botsLoaded=false/undefined can
    // still have a list request in flight (first load or retry), and that
    // stale S1 must also lose to the barrier.
    const barrierIds: Record<string, true> = {};
    for (const id of Object.keys(botsLoaded.value)) barrierIds[id] = true;
    for (const id of Object.keys(botsByInstance.value)) barrierIds[id] = true;
    for (const id of Object.keys(botsListSeq)) barrierIds[id] = true;
    for (const loadedId of Object.keys(barrierIds)) {
      botsLoaded.value = { ...botsLoaded.value, [loadedId]: false };
      botsListSeq[loadedId] = (botsListSeq[loadedId] ?? 0) + 1;
    }
    const iId = instanceId.value;
    const bId = selectedBotId.value;
    const cId = activeConversationId.value;
    const tId = activeTopicId.value;
    const rId = activeRun.value?.id;
    const generation = currentSelectionGeneration;
    if (!iId) return;
    // Fail-closed from the first line: buffered WS events were lost, so the
    // durable owner is unknown until loadHistory + runs.list re-prove it.
    // Close admission synchronously — before the catalog RPCs can stall — and
    // invalidate in-flight history/discovery generations so a stale
    // pre-reconnect response cannot reopen the gate or plant an owner.
    if (tId) {
      topicReady.value = false;
      historyRequestSequence += 1;
      discoverySequence += 1;
    }
    // Catalog refresh is best-effort: a transient bots.list failure must
    // never strand the Topic gate closed with no recovery path. Only durable
    // owner discovery (loadHistory + runs.list) controls topicReady; the
    // catalog decides ghost-selection only, on whatever it managed to load.
    let bots: BotSummaryDto[] | null = null;
    try {
      bots = await loadBots(iId);
    } catch {
      // Fall through to durable recovery below: the dirty barrier already
      // marked catalogs stale, so the next Bots tab entry retries the list.
    }
    // The reconcile started before this await: the user may have selected
    // a different Bot while it was in flight. A stale reconcile must keep
    // its catalog refresh but never clear a selection it no longer owns.
    if (
      generation !== currentSelectionGeneration ||
      instanceId.value !== iId ||
      selectedBotId.value !== bId
    ) {
      return;
    }
    // The selected Bot may have been deleted on another client while this
    // page was offline/closed. Drop the ghost selection (plus cached detail
    // and persisted key) instead of restoring a pane that can only fail.
    // Only a successful catalog load may prove deletion: a failed refresh
    // proves nothing and must fall through to durable recovery.
    if (bots && bId && !bots.some((b) => b.id === bId)) {
      dropBotDetail(iId, bId);
      clearSelection();
      return;
    }

    if (bId) {
      try {
        await loadBotDetail(iId, bId).catch(() => {});
        if (generation !== currentSelectionGeneration || instanceId.value !== iId || selectedBotId.value !== bId) return;

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

    // Check active run if we believed one was active (same predicate as
    // isRunActive: queued/running/waiting-human).
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
            const latestMember = incomingRun.memberTurns[incomingRun.memberTurns.length - 1];
            if (latestMember) {
              activeMemberTurn.value = mergeMemberTurn(activeMemberTurn.value, latestMember);
            }
          }
          if (isTerminalRunState(activeRun.value.state)) {
            liveTurn.value = null;
            if (cId && tId) {
              await loadHistory(iId, cId, tId);
            }
          }
        } catch {
          // If run not found or error, reload history to converge
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

  // Handle server WebSocket events
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
      // Recover active turn from snapshot if correlated to current conversation & topic
      if (activeConversationId.value && activeTopicId.value) {
        const matchingTurn = event.turns.find(
          (t: LiveTurnSnapshotDto) =>
            t.conversation &&
            t.conversation.conversationId === activeConversationId.value &&
            t.conversation.topicId === activeTopicId.value,
        );

        if (matchingTurn) {
          liveTurn.value = {
            parts: [...matchingTurn.parts],
            status: matchingTurn.status,
            startedAt: matchingTurn.startedAt,
            revision: (liveTurn.value?.revision ?? 0) + 1,
          };
          const corr = matchingTurn.conversation;
          if (corr?.runId) {
            const matchingRunId = corr.runId;
            if (!activeRun.value || activeRun.value.id !== matchingRunId) {
              activeRun.value = {
                id: matchingRunId,
                conversationId: corr.conversationId,
                topicId: corr.topicId,
                requestMessageId: "",
                requestId: "",
                mode: "explicit",
                state: "running",
                profileRevision: 1,
                createdAt: new Date(matchingTurn.startedAt).toISOString(),
                startedAt: new Date(matchingTurn.startedAt).toISOString(),
              };
            }
            runParts.value = {
              ...runParts.value,
              [matchingRunId]: [...matchingTurn.parts],
            };
            // A fresh live snapshot restarts the stream: prior completeness
            // evidence no longer applies to the new turn.
            if (runPartsComplete.value[matchingRunId]) {
              const { [matchingRunId]: _dropped, ...rest } = runPartsComplete.value;
              runPartsComplete.value = rest;
            }
            // A hub-capped snapshot stays gappy: later deltas append onto the
            // capped base, so the merged trace can never become complete.
            if (matchingTurn.truncated) {
              runPartsTruncated.value = { ...runPartsTruncated.value, [matchingRunId]: true };
            } else if (runPartsTruncated.value[matchingRunId]) {
              const { [matchingRunId]: _dropped, ...rest } = runPartsTruncated.value;
              runPartsTruncated.value = rest;
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
                // Retirement rule: only hand off when this detail retires a
                // locally-tracked nonterminal Run.
                const retiringActiveRun = !!activeRun.value && !isTerminalRunState(activeRun.value.state);
                activeRun.value = mergeRun(activeRun.value, run);
                if (run.memberTurns?.length) {
                  const latestMember = run.memberTurns[run.memberTurns.length - 1];
                  if (latestMember) {
                    activeMemberTurn.value = mergeMemberTurn(activeMemberTurn.value, latestMember);
                  }
                }
                if (isTerminalRunState(activeRun.value.state)) {
                  liveTurn.value = null;
                  if (retiringActiveRun && targetConvId && targetTopicId) {
                    void rediscoverAfterTerminal(targetInstId, targetConvId, targetTopicId, activeRun.value.id);
                  }
                }
              })
              .catch(() => {});
          }
        } else if (activeRun.value && isActiveRunState(activeRun.value.state)) {
          // Turn completed while offline -> refetch history and active run
          const targetInstId = event.instanceId;
          const targetConvId = activeConversationId.value ?? undefined;
          const targetTopicId = activeTopicId.value ?? undefined;
          const targetRunId = activeRun.value.id;
          const targetGeneration = currentSelectionGeneration;

          liveTurn.value = null;
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
              if (isTerminalRunState(activeRun.value.state)) {
                liveTurn.value = null;
              }
            })
            .catch(() => {});
        }
      }
      return;
    }

    if (event.kind !== "control-event") return;
    const e = event.event;

    // Global Bot-lifecycle projection: member-turn-started proves the hidden
    // direct runtime materialized for memberTurn.botId on this instance, but
    // emits no bots-changed. Converge hasRuntime for every subscribed
    // instance BEFORE the selected-instance transcript fence below: the
    // transcript/HUD branches must stay selection-scoped, but the lifecycle
    // bit (sidebar rows, open BotDialog lock) must not depend on which Bot is
    // currently selected.
    if (e.type === "member-turn-started") {
      const startedBotId = e.memberTurn.botId;
      if (startedBotId) {
        markBotHasRuntime(event.instanceId, startedBotId);
      }
    }

    // Catalog invalidation events
    if (e.type === "bots-changed") {
      void (async () => {
        let bots: BotSummaryDto[];
        try {
          bots = await loadBots(event.instanceId);
        } catch {
          // List refresh failed: keep the previous list and selection.
          return;
        }
        // Remote delete of the selected Bot (possibly while this tab was
        // closed): the authoritative list no longer contains it. Drop the
        // ghost selection, its cached detail, and the persisted key instead
        // of rendering a stale pane that can only fail backend calls.
        if (
          event.instanceId === instanceId.value
          && selectedBotId.value
          && !bots.some((b) => b.id === selectedBotId.value)
        ) {
          dropBotDetail(event.instanceId, selectedBotId.value);
          clearSelection();
          return;
        }
        if (selectedBotId.value && event.instanceId === instanceId.value) {
          void loadBotDetail(event.instanceId, selectedBotId.value).catch(() => {});
        }
      })();
      return;
    }
    // Instance-scoped conversation/turn events: only for the currently selected instance
    if (event.instanceId !== instanceId.value) return;

    if (e.type === "conversations-changed") {
      void loadConversations(event.instanceId, selectedBotId.value ? { botId: selectedBotId.value } : undefined);
      return;
    }

    if (e.type === "conversation-topic-changed") {
      const topic = e.topic;
      if (topic.conversationId === activeConversationId.value) {
        const key = `${event.instanceId}:${topic.conversationId}`;
        topicsSeq[key] = (topicsSeq[key] ?? 0) + 1;
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
          // Same chained rule as the HTTP accept path (see helper).
          advanceContiguousForSeq(msg.seq);
          // Same durable-final rule as mergeHistoryPage: a live bot row for
          // a Run whose trace never finished proves the partial stale.
          pruneIncompleteTraces();
        }
        // If this message belongs to the active run and is from the bot, converge liveTurn
        if (msg.role === "bot" && activeRun.value && msg.runId === activeRun.value.id) {
          liveTurn.value = null;
        }
      }
      return;
    }

    if (e.type === "conversation-run-changed") {
      const run = e.run;
      if (run.conversationId === activeConversationId.value && run.topicId === activeTopicId.value) {
        // Same-owner merge, plus null-owner terminal rows (they carry no
        // ownership claim). A null owner with a *nonterminal* row must NOT
        // blind-adopt here: an older queued Run may sort ahead, and the later
        // authoritative discovery could no longer correct it past the
        // live-owner fence. Those rows fall through to the draft / foreign
        // branches below instead.
        if (
          (activeRun.value && activeRun.value.id === run.id) ||
          (!activeRun.value && isTerminalRunState(run.state))
        ) {
          // Only a locally-tracked nonterminal Run retiring on THIS event is
          // a terminal handoff: it closes admission and re-discovers the next
          // owner. A repeated/confirmatory terminal row for an already-terminal
          // Run (e.g. discovery echoing the owner back) must not churn the
          // gate or spawn redundant re-discovery.
          const retiringActiveRun = !!activeRun.value && !isTerminalRunState(activeRun.value.state);
          activeRun.value = mergeRun(activeRun.value, run);
          // Only an execution-started row proves the hidden direct runtime
          // materialized: the dispatcher emits running/waiting-human after
          // materialize + the execution-start fence. Queued accept echoes and
          // terminal rows for runs cancelled/failed before execution prove
          // nothing (no binding/session may ever exist).
          if (
            (run.state === "running" || run.state === "waiting-human") &&
            instanceId.value && selectedBotId.value
          ) {
            markBotHasRuntime(instanceId.value, selectedBotId.value);
          }
          if (isTerminalRunState(activeRun.value.state)) {
            liveTurn.value = null;
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
          // A nonterminal Run this tab does not own appeared for the current
          // Topic. With no live local owner (absent or already terminal, e.g.
          // a no-candidate handoff completed and a foreign Run queued
          // afterwards), the event evidences an unseen owner: close admission
          // synchronously and re-run authoritative topic-wide discovery to
          // elect the true owner instead of adopting blindly (an older queued
          // Run may sort ahead). With a live local owner tracked, the owner
          // may still be executing ahead of it — EXCEPT when the incoming row
          // is itself the authoritative owner: then fencing would strand B
          // invisibly behind an optimistic C that HTTP order (not durability)
          // elected. That check costs one runs.list and runs only in this
          // narrow window.
          // WS own identity is the exact draft requestId only. sendPrompt
          // mints the draft id synchronously before the RPC goes in flight,
          // so there is no legitimate "in flight but idless" window — a
          // mismatched requestId is foreign, never own.
          const isOwnDraft =
            run.requestId !== "" &&
            currentDraftRequestId.value !== null &&
            run.requestId === currentDraftRequestId.value;
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
            // Live owner tracked AND a foreign nonterminal row arrived: mark
            // ownership as uncertain until authority resolves, closing the
            // cancellation door on the old local owner.
            ownershipUncertain.value = true;
            cancelError.value = "ownershipChecking";
            void retryDiscovery();
          }
          if (isOwnDraft) {
            activeRun.value = mergeRun(null, run);
            activeMemberTurn.value = null;
            liveTurn.value = null;
            // The WS proves the accepted Run is durable, but a queued accept
            // row does not prove the hidden runtime materialized: execution
            // evidence below converges hasRuntime.
            promptError.value = null;
            promptErrorDetail.value = null;
            currentDraftRequestId.value = null;
            lastPromptText.value = "";
          }
        }
      }
      return;
    }
    if (e.type === "member-turn-started") {
      const { run, memberTurn } = e;
      if (run.conversationId === activeConversationId.value && run.topicId === activeTopicId.value) {
        // Same split as run-changed: same-owner merge, plus null-owner
        // terminal rows (no ownership claim). A null owner with a nonterminal
        // row falls through: own drafts adopt immediately, foreign rows
        // re-run authoritative discovery instead of blind-adopting ahead of
        // an older queued Run.
        if (
          (activeRun.value && activeRun.value.id === run.id) ||
          (!activeRun.value && isTerminalRunState(run.state))
        ) {
          activeRun.value = mergeRun(activeRun.value, run);
          activeMemberTurn.value = mergeMemberTurn(activeMemberTurn.value, memberTurn);
          // member-turn-started is emitted by the dispatcher only after
          // materialize + the execution-start fence, so it proves the hidden
          // direct runtime actually exists.
          if (instanceId.value && selectedBotId.value) {
            markBotHasRuntime(instanceId.value, selectedBotId.value);
          }
        } else if (!isTerminalRunState(run.state)) {
          const isOwnDraft =
            run.requestId !== "" &&
            currentDraftRequestId.value !== null &&
            run.requestId === currentDraftRequestId.value;
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
            activeMemberTurn.value = mergeMemberTurn(null, memberTurn);
            if (instanceId.value && selectedBotId.value) {
              markBotHasRuntime(instanceId.value, selectedBotId.value);
            }
            promptError.value = null;
            promptErrorDetail.value = null;
            currentDraftRequestId.value = null;
            lastPromptText.value = "";
          } else {
            return;
          }
        }
        if (!liveTurn.value || activeRun.value?.id === run.id) {
          liveTurn.value = {
            parts: [],
            status: "working",
            startedAt: memberTurn.startedAt ? new Date(memberTurn.startedAt).getTime() : Date.now(),
            revision: (liveTurn.value?.revision ?? 0) + 1,
          };
        }
      }
      return;
    }

    if (e.type === "member-turn-finished") {
      const { run, memberTurn } = e;
      if (run.conversationId === activeConversationId.value && run.topicId === activeTopicId.value) {
        // Same ownership fence as member-turn-started: a stale finished event
        // for another Run must not steal the active Run (mergeRun would return
        // the incoming Run verbatim on id mismatch).
        if (activeRun.value && activeRun.value.id !== run.id) {
          return;
        }
        // Same retirement rule as run-changed: only a locally-tracked
        // nonterminal Run retiring on this event hands off.
        const retiringActiveRun = !!activeRun.value && !isTerminalRunState(activeRun.value.state);
        activeRun.value = mergeRun(activeRun.value, run);
        activeMemberTurn.value = mergeMemberTurn(activeMemberTurn.value, memberTurn);
        if (isTerminalRunState(activeRun.value.state)) {
          liveTurn.value = null;
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

    // Correlation-driven turn events
    if ("conversation" in e && e.conversation) {
      const corr = e.conversation;
      if (
        corr.conversationId !== activeConversationId.value ||
        corr.topicId !== activeTopicId.value ||
        (activeRun.value && corr.runId !== activeRun.value.id)
      ) {
        return;
      }

      if (!liveTurn.value) {
        liveTurn.value = {
          parts: [],
          status: "working",
          startedAt: Date.now(),
          revision: 0,
        };
      }

      const parts = liveTurn.value.parts;
      const bumpStream = (): void => {
        if (liveTurn.value) liveTurn.value.revision += 1;
      };
      if (e.type === "turn-started") {
        liveTurn.value.startedAt = e.startedAt ?? Date.now();
      } else if (e.type === "turn-output") {
        appendText(parts, e.chunk);
        liveTurn.value.status = "streaming";
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
          // PlanPanel lives in the same scroll container: a first or growing
          // plan extends page height, so bump the presentation revision even
          // when no text/tool token arrives on the same frame.
          bumpStream();
        }
      } else if (e.type === "turn-finished") {
        liveTurn.value.status = "working";
        // Retain parts under runId — and only this event proves the snapshot
        // complete, so a reconnect that later recovers the durable final row
        // can trust it over the message content fallback.
        if (corr.runId) {
          runParts.value = {
            ...runParts.value,
            [corr.runId]: [...parts],
          };
          runPartsComplete.value = { ...runPartsComplete.value, [corr.runId]: true };
        }
      }

    }
  }

  return {
    instanceId,
    selectedBotId,
    activeConversationId,
    activeTopicId,
    botsByInstance,
    botDetails,
    loadingBots,
    loadingBotsByInstance,
    botsLoaded,
    conversationsByInstance,
    conversationDetails,
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
    activeMemberTurn,
    liveTurn,
    planEntries,
    cancellingRunId,
    cancelUncertaintyRunId,
    runParts,
    completeRunParts,
    currentDraftRequestId,
    lastPromptText,
    promptInFlight,
    promptError,
    promptErrorDetail,
    cancelError,
    generalError,
    generalErrorCode,
    ownershipUncertain,
    ownerUnconfirmed,
    retryDiscovery,
    isBotSelected,
    currentBots,
    currentBot,
    currentTopics,
    currentTopic,
    isRunActive,
    loadBots,
    loadBotDetail,
    isBotDetailHydrated,
    createBot,
    updateBot,
    deleteBot,
    loadConversations,
    loadTopics,
    createTopic,
    loadHistory,
    loadOlder,
    selectBot,
    switchTopic,
    clearSelection,
    preparePromptRequestId,
    sendPrompt,
    cancelCurrentRun,
    reconcileOnReconnect,
    applyEvent,
  };
});
