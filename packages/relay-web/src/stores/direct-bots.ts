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
}

function unwrapRpc<T>(result: T | { error: { code: string; message: string } }): T {
  if (isErrorPayload(result)) {
    if (result.error.code === "unknown-type") {
      throw new Error("This feature needs a newer connector — rebuild and reconnect the relay channel on that instance.");
    }
    throw new Error(result.error.message || result.error.code);
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
  // Navigation / Selection identity
  const instanceId = ref<string | null>(null);
  const selectedBotId = ref<string | null>(null);
  const activeConversationId = ref<string | null>(null);
  const activeTopicId = ref<string | null>(null);

  // Bots state
  const botsByInstance = ref<Record<string, BotSummaryDto[]>>({});
  const botDetails = ref<Record<string, BotDetailDto>>({});
  const loadingBots = ref<boolean>(false);
  const botsLoaded = ref<Record<string, boolean>>({});

  // Conversations state
  const conversationsByInstance = ref<Record<string, ConversationSummaryDto[]>>({});
  const conversationDetails = ref<Record<string, ConversationDetailDto>>({});

  // Topics state (keyed by `${instanceId}:${conversationId}`)
  const topicsByConversation = ref<Record<string, TopicSummaryDto[]>>({});

  // Messages / History state for active conversation & topic
  const messages = ref<ConversationMessageDto[]>([]);
  const oldestSeq = ref<number | undefined>(undefined);
  const newestSeq = ref<number | undefined>(undefined);
  const hasMoreBefore = ref<boolean>(false);
  const hasMoreAfter = ref<boolean>(false);
  const loadingHistory = ref<boolean>(false);
  const loadingOlder = ref<boolean>(false);
  const historyError = ref<string | null>(null);
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

  // Prompt / Idempotency state
  const currentDraftRequestId = ref<string | null>(null);
  const lastPromptText = ref<string>("");
  const promptInFlight = ref<boolean>(false);
  const promptError = ref<string | null>(null);
  // Cancel-outcome uncertainty is tracked separately from prompt submission errors:
  // a failed `runs.cancel` transport does not mean the durable Run terminated.
  const cancelError = ref<string | null>(null);
  const cancelUncertaintyRunId = ref<string | null>(null);
  function resolveCancelUncertainty(runId: string): void {
    if (cancelUncertaintyRunId.value === runId) {
      cancelUncertaintyRunId.value = null;
      cancelError.value = null;
    }
  }

  // General error feedback
  const generalError = ref<string | null>(null);

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
    if (detailKey in botDetails.value) {
      const nextDetails = { ...botDetails.value };
      delete nextDetails[detailKey];
      botDetails.value = nextDetails;
    }
  }

  // First durable accept proves the hidden direct runtime materialized, but
  // runtime materialization emits no bots-changed. Flip the local projection
  // to hasRuntime immediately so delete/identity UI converges without waiting
  // for a later list/detail refetch.
  function markBotHasRuntime(targetInstanceId: string, botId: string): void {
    const list = botsByInstance.value[targetInstanceId];
    if (list) {
      const idx = list.findIndex((b) => b.id === botId);
      if (idx >= 0 && !list[idx]?.hasRuntime) {
        const next = [...list];
        next[idx] = { ...next[idx]!, hasRuntime: true as const };
        botsByInstance.value = { ...botsByInstance.value, [targetInstanceId]: next };
      }
    }
    const detailKey = `${targetInstanceId}:${botId}`;
    const detail = botDetails.value[detailKey];
    if (detail && !detail.hasRuntime) {
      botDetails.value = { ...botDetails.value, [detailKey]: { ...detail, hasRuntime: true as const } };
    }
  }

  async function loadBots(targetInstanceId: string): Promise<BotSummaryDto[]> {
    loadingBots.value = true;
    try {
      const res = unwrapRpc(
        await api.rpc<{ bots: BotSummaryDto[] }>(targetInstanceId, MSG.botsList, {}),
      );
      botsByInstance.value = {
        ...botsByInstance.value,
        [targetInstanceId]: res.bots,
      };
      botsLoaded.value = {
        ...botsLoaded.value,
        [targetInstanceId]: true,
      };
      return res.bots;
    } finally {
      loadingBots.value = false;
    }
  }

  async function loadBotDetail(targetInstanceId: string, botId: string): Promise<BotDetailDto> {
    const res = unwrapRpc(
      await api.rpc<{ bot: BotDetailDto }>(targetInstanceId, MSG.botsGet, { id: botId }),
    );
    const detailKey = `${targetInstanceId}:${botId}`;
    botDetails.value = {
      ...botDetails.value,
      [detailKey]: res.bot,
    };
    return res.bot;
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
    botDetails.value = { ...botDetails.value, [detailKey]: res.bot };
    await loadBots(targetInstanceId);
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
    botDetails.value = { ...botDetails.value, [detailKey]: res.bot };
    await loadBots(targetInstanceId);
    return res.bot;
  }

  async function deleteBot(targetInstanceId: string, botId: string): Promise<void> {
    unwrapRpc(await api.rpc<{ ok: boolean }>(targetInstanceId, MSG.botsDelete, { id: botId }));
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
    const res = unwrapRpc(
      await api.rpc<{ topics: TopicSummaryDto[] }>(targetInstanceId, MSG.topicsList, { conversationId }),
    );
    const key = `${targetInstanceId}:${conversationId}`;
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

      const deduplicated = new Map<string, ConversationMessageDto>();
      for (const m of res.messages) {
        deduplicated.set(m.id, m);
      }
      messages.value = [...deduplicated.values()].sort((a, b) => a.seq - b.seq);
      transcriptRevision += 1;
      oldestSeq.value = res.oldestSeq;
      newestSeq.value = res.newestSeq;
      hasMoreBefore.value = res.hasMoreBefore;
      hasMoreAfter.value = res.hasMoreAfter;

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
      // closed so a prompt cannot take wrong ownership of an unseen Run.
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
      } else if (
        // A superseded load (a newer discovery started, e.g. a terminal
        // handoff racing a deferred runs.get) must not pin a stale failure
        // over the newer recovery's outcome.
        discoveryId === discoverySequence &&
        instanceId.value === iId &&
        activeConversationId.value === cId &&
        activeTopicId.value === tId
      ) {
        historyError.value = "Run discovery failed. History loaded, but the live Run owner is unknown — retry to confirm before sending.";
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
        historyError.value = err instanceof Error ? err.message : String(err);
      }
    } finally {
      loadingHistory.value = false;
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
      // A stale terminal activeRun must not block authoritative topic discovery:
      // the lost-response case is exactly activeRun=completed A while durable B
      // is queued/running. Only an active (non-terminal) different Run fences.
      if (activeRun.value && activeRun.value.id !== candidate.id && !isTerminalRunState(activeRun.value.state)) {
        // A different local nonterminal Run exists: keep it fenced but still
        // treat discovery as proven — the gate must not reopen admission for
        // a second prompt into the same Topic.
        return true;
      }
      activeRun.value = mergeRun(activeRun.value?.id === candidate.id ? activeRun.value : null, candidate);
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
        if (detail.run.id !== candidate.id) {
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
        activeRun.value = mergeRun(activeRun.value, detail.run);
        const latestMember = detail.run.memberTurns?.length
          ? detail.run.memberTurns[detail.run.memberTurns.length - 1]
          : undefined;
        if (latestMember && (!activeMemberTurn.value || activeMemberTurn.value.runId === candidate.id)) {
          activeMemberTurn.value = mergeMemberTurn(activeMemberTurn.value, latestMember);
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

  // Transcript-only convergence: reload the canonical history page without
  // touching the admission gate or durable-owner discovery. For callers whose
  // owner row is already authoritative (prompt accept reusing a completed
  // Run). Never use on a terminal handoff where a queued next Run may exist.
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
        const deduplicated = new Map<string, ConversationMessageDto>();
        for (const m of res.messages) {
          deduplicated.set(m.id, m);
        }
        messages.value = [...deduplicated.values()].sort((a, b) => a.seq - b.seq);
        transcriptRevision += 1;
        oldestSeq.value = res.oldestSeq;
        newestSeq.value = res.newestSeq;
        hasMoreBefore.value = res.hasMoreBefore;
        hasMoreAfter.value = res.hasMoreAfter;
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
          historyError.value = err instanceof Error ? err.message : String(err);
        }
      } finally {
        loadingHistory.value = false;
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
        runId ? { harvestTerminalHandoff: { runId }, reuseDiscoveryId: handoffDiscoveryId } : undefined,
      );
      if (generation !== currentSelectionGeneration) return;
    })();
  }

  async function loadOlder(): Promise<void> {
    const iId = instanceId.value;
    const cId = activeConversationId.value;
    const tId = activeTopicId.value;
    if (!iId || !cId || !tId || loadingOlder.value || !hasMoreBefore.value || oldestSeq.value === undefined) {
      return;
    }

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
      loadingOlder.value = false;
    }
  }

  // Selection & Navigation
  async function selectBot(targetInstanceId: string, botId: string): Promise<void> {
    const generation = ++currentSelectionGeneration;
    historyRequestSequence += 1;
    discoverySequence += 1;
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
    hasMoreBefore.value = false;
    hasMoreAfter.value = false;
    activeRun.value = null;
    activeMemberTurn.value = null;
    liveTurn.value = null;
    latestPlanRunId.value = null;
    cancellingRunId.value = null;
    cancelUncertaintyRunId.value = null;
    cancelError.value = null;
    promptInFlight.value = false;
    promptError.value = null;
    currentDraftRequestId.value = null;
    lastPromptText.value = "";
    generalError.value = null;
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
    touchTranscript();
    topicReady.value = false;
    activeTopicId.value = topicId;
    messages.value = [];
    oldestSeq.value = undefined;
    newestSeq.value = undefined;
    hasMoreBefore.value = false;
    hasMoreAfter.value = false;
    activeRun.value = null;
    activeMemberTurn.value = null;
    liveTurn.value = null;
    latestPlanRunId.value = null;
    cancellingRunId.value = null;
    cancelUncertaintyRunId.value = null;
    cancelError.value = null;
    promptInFlight.value = false;
    promptError.value = null;
    currentDraftRequestId.value = null;
    lastPromptText.value = "";
    generalError.value = null;
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
    touchTranscript();
    topicReady.value = true;
    instanceId.value = null;
    selectedBotId.value = null;
    activeConversationId.value = null;
    activeTopicId.value = null;
    messages.value = [];
    oldestSeq.value = undefined;
    newestSeq.value = undefined;
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
    promptInFlight.value = false;
    promptError.value = null;
    currentDraftRequestId.value = null;
    lastPromptText.value = "";
    generalError.value = null;
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
      promptError.value = "Topic is still recovering. Wait for history to finish loading before sending.";
      return;
    }
    const bot = currentBot.value;
    if (bot && !bot.enabled) {
      promptError.value = "Bot is disabled. Enable it before sending messages.";
      return;
    }
    // Fence the slow accept RPC against a recovered durable Run: if recovery
    // adopted an active Run while this prompt was being composed, refuse to
    // send a second prompt into the same Topic.
    if (isRunActive.value) {
      promptError.value = "A run is already in progress. Wait for it to finish or cancel it.";
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

      // HTTP accept proves the hidden direct runtime materialized (no
      // bots-changed is emitted for materialization). Flip the local
      // projection now so delete/identity UI converges without a refetch.
      markBotHasRuntime(targetInstId, targetBotId);
      // On successful acceptance, reset current draft requestId so subsequent prompt gets a new id
      currentDraftRequestId.value = null;
      lastPromptText.value = "";

      // Deduplicate human message into messages list
      const existing = messages.value.find((m) => m.id === res.message.id);
      if (!existing) {
        messages.value = [...messages.value, res.message].sort((a, b) => a.seq - b.seq);
        touchTranscript();
        newestSeq.value = Math.max(newestSeq.value ?? 0, res.message.seq);
      }

      // An HTTP accept proves the accepted Run is durable — never that it is
      // the topic-wide owner. A different-id nonterminal Run tracked locally
      // (adopted via authoritative discovery or an earlier accept) stays the
      // owner; the accept response only converges transcript + lifecycle, and
      // ownership is re-confirmed below via authoritative discovery.
      const acceptOverwritesOwner =
        !activeRun.value ||
        activeRun.value.id === res.run.id ||
        isTerminalRunState(activeRun.value.state);
      // Track active run and member turn without regressing already-advanced state
      const priorRunId = activeRun.value?.id;
      const priorRunActive = !!activeRun.value && !isTerminalRunState(activeRun.value.state);
      if (acceptOverwritesOwner) {
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
      // Reused-completed-run accept: the accepted Run row is authoritative
      // for the accepted Run, but a queued next Run may still own the Topic
      // (the accept response carries no topic-wide ownership). Converge the
      // transcript, then re-discover the owner exactly like a terminal event:
      // adopt queued B blocked, or open the gate on no-candidate.
      if (isTerminalRunState(adoptedRun.state)) {
        liveTurn.value = null;
        if (targetInstId && targetConvId && targetTopicId) {
          if (priorRunActive) {
            void rediscoverAfterTerminal(targetInstId, targetConvId, targetTopicId, adoptedRun.id);
          } else {
            void refreshTranscriptOnly(targetInstId, targetConvId, targetTopicId);
          }
        }
      } else if (acceptOverwritesOwner) {
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
      if (acceptOverwritesOwner) {
        latestPlanRunId.value = res.run.id;
      }
    } catch (err: unknown) {
      // WS may already have proved durable accept for this requestId (the
      // run-changed adoption branch converges to success and retires the
      // retry identity). A late HTTP failure must not rewrite that success.
      if (isCurrent() && currentDraftRequestId.value === reqId) {
        promptError.value = err instanceof Error ? err.message : String(err);
      } else if (isCurrent() && promptError.value === "A run is already in progress. Wait for it to finish or cancel it.") {
        // The blocked Prompt C was never sent and its Run is now durable:
        // drop the transient gate error instead of pinning a stale banner.
        promptError.value = null;
      }
      // Retain currentDraftRequestId so a retry uses the exact same requestId
    } finally {
      if (isCurrent()) {
        promptInFlight.value = false;
      }
    }
  }

  // Exact Run cancellation via runId
  async function cancelCurrentRun(): Promise<void> {
    if (!instanceId.value || !activeRun.value) return;
    // Store-level double-click fence: while a cancel RPC for this Run is in
    // flight the HUD keeps emitting; a second dispatch would race the first
    // and the late failure could re-mark uncertainty on a terminal Run.
    if (cancellingRunId.value === activeRun.value.id) return;
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
        cancelError.value = "Cancellation outcome unknown. Waiting for instance state...";
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
    const iId = instanceId.value;
    const bId = selectedBotId.value;
    const cId = activeConversationId.value;
    const tId = activeTopicId.value;
    const rId = activeRun.value?.id;
    const generation = currentSelectionGeneration;
    if (!iId) return;
    try {
      const bots = await loadBots(iId);
      if (generation !== currentSelectionGeneration || instanceId.value !== iId || selectedBotId.value !== bId) return;
      // The selected Bot may have been deleted on another client while this
      // page was offline/closed. Drop the ghost selection (plus cached detail
      // and persisted key) instead of restoring a pane that can only fail.
      if (bId && !bots.some((b) => b.id === bId)) {
        dropBotDetail(iId, bId);
        clearSelection();
        return;
      }

      if (bId) {
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
    } catch (err: unknown) {
      console.warn("reconcileOnReconnect error:", err);
    }
  }

  // Handle server WebSocket events
  function applyEvent(event: WebServerEvent): void {
    if (event.kind === "instance-status") {
      if (event.instanceId === instanceId.value && !event.online) {
        generalError.value = "Instance is offline";
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
    if (event.instanceId !== instanceId.value) return;
    const e = event.event;

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

    if (e.type === "conversations-changed") {
      void loadConversations(event.instanceId, selectedBotId.value ? { botId: selectedBotId.value } : undefined);
      return;
    }

    if (e.type === "conversation-topic-changed") {
      const topic = e.topic;
      if (topic.conversationId === activeConversationId.value) {
        const key = `${event.instanceId}:${topic.conversationId}`;
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
          // Any Run for this Topic proves the hidden direct runtime
          // materialized (no bots-changed covers it). Converge lifecycle now.
          if (instanceId.value && selectedBotId.value) {
            markBotHasRuntime(instanceId.value, selectedBotId.value);
          }
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
            // Live owner tracked AND a foreign nonterminal row arrived: ask
            // the authority whether the newcomer already owns the Topic
            // (C-before-B: our optimistic C is tracked, durable B sorts
            // ahead). The gate stays as-is until discovery answers — no
            // synchronous close, no blind adopt.
            const checkInstId = instanceId.value;
            const checkConvId = activeConversationId.value;
            const checkTopicId = activeTopicId.value;
            const checkGeneration = currentSelectionGeneration;
            const checkDiscoveryId = ++discoverySequence;
            void (async () => {
              let listed: { runs: ConversationRunDto[]; activeRunId?: string; activeRun?: ConversationRunDto };
              try {
                listed = unwrapRpc(
                  await api.rpc<{ runs: ConversationRunDto[]; activeRunId?: string; activeRun?: ConversationRunDto }>(checkInstId, MSG.runsList, {
                    conversationId: checkConvId,
                    topicId: checkTopicId,
                  }),
                );
              } catch {
                return;
              }
              if (
                checkGeneration !== currentSelectionGeneration ||
                checkDiscoveryId !== discoverySequence ||
                instanceId.value !== checkInstId ||
                activeConversationId.value !== checkConvId ||
                activeTopicId.value !== checkTopicId
              ) {
                return;
              }
              const authoritativeId = listed.activeRun?.id
                ?? (listed.activeRunId && listed.runs.some((r) => r.id === listed.activeRunId)
                  ? listed.activeRunId
                  : undefined);
              // Discovery decides, event does not: when the latest valid check
              // reports an authoritative nonterminal owner that differs from
              // our local activeRun, adopt it. Do NOT bind adoption to the
              // event's seenRunId — an earlier queued Run (e.g. B) must still be
              // adopted even if a later foreign event (e.g. D) was the one that
              // completed discovery.
              if (
                authoritativeId &&
                activeRun.value &&
                activeRun.value.id !== authoritativeId &&
                !isTerminalRunState(activeRun.value.state)
              ) {
                const authoritativeRow = listed.activeRun
                  ?? listed.runs.find((r) => r.id === authoritativeId);
                if (authoritativeRow && !isTerminalRunState(authoritativeRow.state)) {
                  activeRun.value = mergeRun(null, authoritativeRow);
                  activeMemberTurn.value = null;
                  liveTurn.value = null;
                  latestPlanRunId.value = authoritativeId;
                  if (instanceId.value && selectedBotId.value) {
                    markBotHasRuntime(instanceId.value, selectedBotId.value);
                  }
                }
              }
            })();
          }
          if (isOwnDraft) {
            activeRun.value = mergeRun(null, run);
            activeMemberTurn.value = null;
            liveTurn.value = null;
            // This Run exists, so the hidden direct runtime materialized (no
            // bots-changed covers it). Converge the lifecycle projection now.
            if (instanceId.value && selectedBotId.value) {
              markBotHasRuntime(instanceId.value, selectedBotId.value);
            }
            // The WS proved the submission is durably accepted, so retire the
            // retry identity now: a late HTTP catch cannot rewrite failure and
            // Retry cannot re-send the same requestId. promptInFlight stays true
            // until the HTTP settles, still reflecting the open request.
            promptError.value = null;
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
          // This Run exists, so the hidden direct runtime materialized (no
          // bots-changed covers it). Converge the lifecycle projection now.
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
        };
      }

      const parts = liveTurn.value.parts;
      if (e.type === "turn-started") {
        liveTurn.value.startedAt = e.startedAt ?? Date.now();
      } else if (e.type === "turn-output") {
        appendText(parts, e.chunk);
        liveTurn.value.status = "streaming";
      } else if (e.type === "turn-thought") {
        appendReasoning(parts, e.chunk);
      } else if (e.type === "tool-event") {
        upsertTool(parts, e.step);
      } else if (e.type === "plan") {
        if (corr.runId) {
          latestPlanRunId.value = corr.runId;
          planByRunId.value = {
            ...planByRunId.value,
            [corr.runId]: e.entries,
          };
        }
      } else if (e.type === "turn-finished") {
        liveTurn.value.status = "working";
        // Retain parts under runId
        if (corr.runId) {
          runParts.value = {
            ...runParts.value,
            [corr.runId]: [...parts],
          };
        }
      }

      // Also update runParts copy
      if (corr.runId) {
        runParts.value = {
          ...runParts.value,
          [corr.runId]: [...parts],
        };
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
    botsLoaded,
    conversationsByInstance,
    conversationDetails,
    topicsByConversation,
    messages,
    oldestSeq,
    newestSeq,
    hasMoreBefore,
    hasMoreAfter,
    loadingHistory,
    loadingOlder,
    historyError,
    topicReady,
    activeRun,
    activeMemberTurn,
    liveTurn,
    planEntries,
    cancellingRunId,
    cancelUncertaintyRunId,
    runParts,
    currentDraftRequestId,
    lastPromptText,
    promptInFlight,
    promptError,
    cancelError,
    generalError,
    isBotSelected,
    currentBots,
    currentBot,
    currentTopics,
    currentTopic,
    isRunActive,
    loadBots,
    loadBotDetail,
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
