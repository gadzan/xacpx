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
    const detailKey = `${targetInstanceId}:${botId}`;
    const nextDetails = { ...botDetails.value };
    delete nextDetails[detailKey];
    botDetails.value = nextDetails;

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

  // History loading and seq-based pagination
  async function loadHistory(targetInstanceId?: string, convId?: string, topId?: string): Promise<void> {
    const iId = targetInstanceId ?? instanceId.value;
    const cId = convId ?? activeConversationId.value;
    const tId = topId ?? activeTopicId.value;
    if (!iId || !cId || !tId) return;

    loadingHistory.value = true;
    historyError.value = null;
    try {
      const res = unwrapRpc(
        await api.rpc<ConversationHistoryResponseDto>(iId, MSG.conversationHistory, {
          conversationId: cId,
          topicId: tId,
          limit: 50,
        }),
      );

      // Verify that the view hasn't switched while loading
      if (instanceId.value !== iId || activeConversationId.value !== cId || activeTopicId.value !== tId) {
        return;
      }

      const deduplicated = new Map<string, ConversationMessageDto>();
      for (const m of res.messages) {
        deduplicated.set(m.id, m);
      }
      messages.value = [...deduplicated.values()].sort((a, b) => a.seq - b.seq);
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
    } catch (err: unknown) {
      historyError.value = err instanceof Error ? err.message : String(err);
    } finally {
      loadingHistory.value = false;
    }
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
    // Load bot detail in background
    void loadBotDetail(targetInstanceId, botId).catch(() => {});

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
    if (instanceId.value && activeConversationId.value) {
      await loadHistory(instanceId.value, activeConversationId.value, topicId);
      if (generation !== currentSelectionGeneration || activeTopicId.value !== topicId) {
        return;
      }
    }
  }

  function clearSelection(): void {
    currentSelectionGeneration++;
    instanceId.value = null;
    selectedBotId.value = null;
    activeConversationId.value = null;
    activeTopicId.value = null;
    messages.value = [];
    oldestSeq.value = undefined;
    newestSeq.value = undefined;
    hasMoreBefore.value = false;
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

    const bot = currentBot.value;
    if (bot && !bot.enabled) {
      promptError.value = "Bot is disabled. Enable it before sending messages.";
      return;
    }
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

      // On successful acceptance, reset current draft requestId so subsequent prompt gets a new id
      currentDraftRequestId.value = null;
      lastPromptText.value = "";

      // Deduplicate human message into messages list
      const existing = messages.value.find((m) => m.id === res.message.id);
      if (!existing) {
        messages.value = [...messages.value, res.message].sort((a, b) => a.seq - b.seq);
        newestSeq.value = Math.max(newestSeq.value ?? 0, res.message.seq);
      }

      // Track active run and member turn without regressing already-advanced state
      const priorRunId = activeRun.value?.id;
      activeRun.value = mergeRun(activeRun.value, res.run);
      if (res.run.id !== activeRun.value.id) {
        activeMemberTurn.value = res.memberTurn;
      } else {
        activeMemberTurn.value = mergeMemberTurn(activeMemberTurn.value, res.memberTurn);
      }
      if (isTerminalRunState(activeRun.value.state)) {
        liveTurn.value = null;
        if (targetInstId && targetConvId && targetTopicId) {
          void loadHistory(targetInstId, targetConvId, targetTopicId);
        }
      } else {
        const isFreshRun = activeRun.value.id === res.run.id && activeRun.value.id !== priorRunId;
        const existingParts = isFreshRun || (activeRun.value.id === priorRunId && liveTurn.value?.parts.length)
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

      latestPlanRunId.value = res.run.id;
    } catch (err: unknown) {
      if (isCurrent()) {
        promptError.value = err instanceof Error ? err.message : String(err);
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
      activeRun.value = mergeRun(activeRun.value, res.run);
      if (isTerminalRunState(activeRun.value.state)) {
        liveTurn.value = null;
        resolveCancelUncertainty(runId);
        if (targetInstId && targetConvId && targetTopicId) {
          void loadHistory(targetInstId, targetConvId, targetTopicId);
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
            activeRun.value = mergeRun(activeRun.value, run);
            if (isTerminalRunState(activeRun.value.state)) {
              liveTurn.value = null;
              resolveCancelUncertainty(runId);
              if (targetInstId && targetConvId && targetTopicId) {
                void loadHistory(targetInstId, targetConvId, targetTopicId);
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
      await loadBots(iId);
      if (generation !== currentSelectionGeneration || instanceId.value !== iId || selectedBotId.value !== bId) return;

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

      // Check active run if we believed one was running
      if (rId && activeRun.value?.id === rId && (activeRun.value.state === "running" || activeRun.value.state === "queued")) {
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
                activeRun.value = mergeRun(activeRun.value, run);
                if (run.memberTurns?.length) {
                  const latestMember = run.memberTurns[run.memberTurns.length - 1];
                  if (latestMember) {
                    activeMemberTurn.value = mergeMemberTurn(activeMemberTurn.value, latestMember);
                  }
                }
                if (isTerminalRunState(activeRun.value.state)) {
                  liveTurn.value = null;
                  if (targetConvId && targetTopicId) {
                    void loadHistory(targetInstId, targetConvId, targetTopicId);
                  }
                }
              })
              .catch(() => {});
          }
        } else if (activeRun.value && (activeRun.value.state === "running" || activeRun.value.state === "queued")) {
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
      void loadBots(event.instanceId);
      if (selectedBotId.value) {
        void loadBotDetail(event.instanceId, selectedBotId.value).catch(() => {});
      }
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
        if (!activeRun.value || activeRun.value.id === run.id) {
          activeRun.value = mergeRun(activeRun.value, run);
          if (isTerminalRunState(activeRun.value.state)) {
            liveTurn.value = null;
            resolveCancelUncertainty(run.id);
            if (instanceId.value && activeConversationId.value && activeTopicId.value) {
              void loadHistory(instanceId.value, activeConversationId.value, activeTopicId.value);
            }
          }
        } else if (
          !isTerminalRunState(run.state) &&
          run.requestId !== "" &&
          currentDraftRequestId.value !== null &&
          run.requestId === currentDraftRequestId.value
        ) {
          activeRun.value = mergeRun(null, run);
          activeMemberTurn.value = null;
          liveTurn.value = null;
          latestPlanRunId.value = run.id;
        }
      }
      return;
    }

    if (e.type === "member-turn-started") {
      const { run, memberTurn } = e;
      if (run.conversationId === activeConversationId.value && run.topicId === activeTopicId.value) {
        if (!activeRun.value || activeRun.value.id === run.id) {
          activeRun.value = mergeRun(activeRun.value, run);
          activeMemberTurn.value = mergeMemberTurn(activeMemberTurn.value, memberTurn);
        } else {
          return;
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
        activeRun.value = mergeRun(activeRun.value, run);
        activeMemberTurn.value = mergeMemberTurn(activeMemberTurn.value, memberTurn);
        if (isTerminalRunState(activeRun.value.state)) {
          liveTurn.value = null;
          resolveCancelUncertainty(run.id);
          if (instanceId.value && activeConversationId.value && activeTopicId.value) {
            void loadHistory(instanceId.value, activeConversationId.value, activeTopicId.value);
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
