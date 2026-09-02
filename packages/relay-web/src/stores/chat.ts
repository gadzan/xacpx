import { defineStore } from "pinia";
import { computed, markRaw, ref } from "vue";
import type { AgentCommandDto, AttachmentMetadata, LiveTurnSnapshotDto, MessageRecordDto, PlanEntryDto, PromptAttachmentRef, QueueItemDto, ScheduledOriginDto, SessionCommandsSnapshotDto, SessionUsageSnapshotDto, ToolStepDto, TurnPartDto, UsageBreakdownDto, UsageCostDto, WebServerEvent } from "@ganglion/xacpx-relay-protocol";
import { api, ApiError } from "../api/client";
import { createDebouncedFlush } from "../lib/debounce-flush";
import { placeTurnsInSlots, slotAfterIndexFromAnchor } from "../lib/history-turn-slots";
import * as tailCache from "../lib/session-tail-cache";
import { useAuthStore } from "./auth";
import { useInstancesStore } from "./instances";
import { useSessionControlsStore } from "./session-controls";
import { showLocalTurnNotification, isSessionActiveInAnyTab, claimNotificationSlot, recordTabFocus } from "../lib/local-notification";

// Remember which session was open so a page refresh returns to it (selection is not
// part of the route). Paired with the active-turn snapshot, a refresh mid-turn lands
// back on the live conversation instead of an empty pane.
const SELECTION_KEY = "xrelay.selectedSession";
function persistSelection(instanceId: string, alias: string): void {
  try { localStorage.setItem(SELECTION_KEY, JSON.stringify({ instanceId, alias })); } catch { /* storage may be blocked */ }
}
function clearPersistedSelection(): void {
  try { localStorage.removeItem(SELECTION_KEY); } catch { /* storage may be blocked */ }
}
export function loadPersistedSelection(): { instanceId: string; alias: string } | null {
  try {
    const raw = localStorage.getItem(SELECTION_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { instanceId?: unknown; alias?: unknown };
    return typeof v.instanceId === "string" && typeof v.alias === "string" ? { instanceId: v.instanceId, alias: v.alias } : null;
  } catch { return null; }
}

export type TurnStatus = "working" | "streaming" | "done" | "cancelled" | "error";

/** Per-session context usage: window fill plus optional cost & token breakdown. */
export type SessionUsage = { used: number; size: number; cost?: UsageCostDto; breakdown?: UsageBreakdownDto };

/** One transcript entry, kept in arrival order to mirror the hub's persistence.
 *  Presentation may derive activity / narrative lanes without mutating wire order. */
export type TurnPart = TurnPartDto;

export interface LiveTurn {
  parts: TurnPart[];
  status: "working" | "streaming";
  startedAt: number;
  /**
   * Index of the last transcript message that existed at turn-started (inclusive).
   * The live bubble renders after this row so later received cards / queued prompts
   * can append below the still-running turn. `-1` = slot at the start of the list.
   * Omitted → render after the last current message (legacy / tests).
   * This is insert-order (transcript index at turn-start), never inferred from clocks.
   */
  slotAfterIndex?: number;
  /**
   * Hub `messages.id` of the last row at turn-start (0 = empty transcript). Used to
   * recompute `slotAfterIndex` after history apply. Absent on purely local live turns
   * whose transcript rows have not yet been assigned Hub ids.
   */
  slotAfterId?: number;
}

// Coalescing appenders — consecutive same-type chunks merge into one part. Text chunks
// already carry their own "\n\n" separators (restored at control-service), so text parts
// concatenate verbatim. Exported-free module helpers keep applyEvent terse.
function appendText(parts: TurnPart[], chunk: string): void {
  const last = parts[parts.length - 1];
  if (last?.type === "text") last.text += chunk;
  else parts.push({ type: "text", text: chunk });
}
function appendReasoning(parts: TurnPart[], chunk: string): void {
  const last = parts[parts.length - 1];
  if (last?.type === "reasoning") {
    // Block already open: append verbatim so internal whitespace/newlines survive.
    last.text += chunk;
    return;
  }
  // Don't OPEN a reasoning block on a blank chunk — some models (e.g. glm-5.2) emit
  // empty/whitespace thought deltas, which otherwise render as an empty "推理" panel.
  if (!chunk.trim()) return;
  parts.push({ type: "reasoning", text: chunk });
}
function upsertTool(parts: TurnPart[], step: ToolStepDto): void {
  const i = parts.findIndex((p) => p.type === "tool" && p.step.toolCallId === step.toolCallId);
  if (i >= 0) parts[i] = { type: "tool", step };
  else parts.push({ type: "tool", step });
}
const textOf = (parts: TurnPart[]): string => parts.filter((p) => p.type === "text").map((p) => p.text).join("");
const toolStepsOf = (parts: TurnPart[]): ToolStepDto[] => parts.filter((p) => p.type === "tool").map((p) => (p as Extract<TurnPart, { type: "tool" }>).step);
const reasoningOf = (parts: TurnPart[]): string => parts.filter((p) => p.type === "reasoning").map((p) => p.text).join("");

export interface ChatMessage extends MessageRecordDto {
  failed?: boolean;
  status?: TurnStatus;
  // Present on an inbound prompt produced by a fired scheduled task — drives the
  // "⏰ Scheduled" badge so a turn that appears on its own has visible provenance.
  scheduled?: ScheduledOriginDto;
}

// History rows are immutable once loaded (updates arrive as whole-row replacements), so
// deep-proxying their potentially huge `structured` payload (full tool diffs, command
// output, ordered parts) is pure overhead — markRaw keeps it out of Vue's reactivity.
function rawStructured<T extends MessageRecordDto>(row: T): T {
  if (row.structured) row.structured = markRaw(row.structured);
  return row;
}

function isFullStructured(structured: MessageRecordDto["structured"] | undefined): boolean {
  return structured !== undefined && structured.compact !== true;
}

/** Prefer already-hydrated / live-flushed structured over a compact list row so
 *  turn-finished convergence and a cache seed with full details don't regress. */
function keepRicherStructured(incoming: MessageRecordDto[], previous: ChatMessage[]): MessageRecordDto[] {
  if (previous.length === 0) return incoming;
  const byId = new Map<number, ChatMessage>();
  for (const m of previous) {
    if (typeof m.id === "number") byId.set(m.id, m);
  }
  const flushed = [...previous].reverse().find((m) => m.id === undefined && m.direction === "out" && isFullStructured(m.structured));
  let lastOutIndex = -1;
  for (let i = incoming.length - 1; i >= 0; i--) {
    if (incoming[i]?.direction === "out") { lastOutIndex = i; break; }
  }
  return incoming.map((row, i) => {
    const prev = typeof row.id === "number" ? byId.get(row.id) : undefined;
    let next: MessageRecordDto = row;
    if (row.structured?.compact === true && isFullStructured(prev?.structured)) {
      next = { ...row, structured: prev!.structured };
    } else if (i === lastOutIndex && flushed?.structured && row.structured?.compact === true && flushed.text === row.text) {
      next = { ...row, structured: flushed.structured };
    }
    const startedAt = next.startedAt ?? prev?.startedAt ?? (i === lastOutIndex ? flushed?.startedAt : undefined);
    if (startedAt !== undefined && next.startedAt === undefined) next = { ...next, startedAt };
    const slotAfterId = next.slotAfterId ?? prev?.slotAfterId ?? (i === lastOutIndex ? flushed?.slotAfterId : undefined);
    if (slotAfterId !== undefined && next.slotAfterId === undefined) next = { ...next, slotAfterId };
    const startedAfterSeq = next.startedAfterSeq ?? prev?.startedAfterSeq ?? (i === lastOutIndex ? flushed?.startedAfterSeq : undefined);
    if (startedAfterSeq !== undefined && next.startedAfterSeq === undefined) next = { ...next, startedAfterSeq };
    return next;
  });
}

export const useChatStore = defineStore("chat", () => {
  const instanceId = ref<string | null>(null);
  const sessionAlias = ref<string | null>(null);
  const messages = ref<ChatMessage[]>([]);
  const liveTurns = ref<Record<string, LiveTurn>>({});
  // The agent's plan/todo list, kept PER SESSION and OUTSIDE the live turn so it survives
  // turn-finished — an agent often ends a turn mid-plan to ask a question, and the panel
  // must not vanish. REPLACE semantics: a newer plan event for the session supersedes it.
  const plans = ref<Record<string, PlanEntryDto[]>>({});
  // Context-usage meter per session (latest `turn-usage`): `used` tokens in context +
  // `size` total window. Session-scoped like `plans` so it persists across turns (REPLACE
  // semantics). Absent for agents that don't report usage (e.g. codex) — the meter hides.
  const usage = ref<Record<string, SessionUsage>>({});
  // Agent-advertised slash commands per session (latest `agent-commands`). Session-scoped
  // like plans/usage (REPLACE), persists across turns. Empty for agents that don't advertise.
  const agentCommands = ref<Record<string, AgentCommandDto[]>>({});
  // Server-side prompt queue per session (latest `queue-updated`), REPLACE semantics like
  // plans/usage. Purely server-authoritative — populated only by the event, never by send().
  const queues = ref<Record<string, QueueItemDto[]>>({});
  // Sessions whose turn finished while NOT being viewed — drives the "unread" attention
  // dot in the session list. Reassigned (never mutated in place) so the Set stays reactive.
  const unread = ref<Set<string>>(new Set());
  // Keys whose most recent event was `turn-finished`. Guards the seed-vs-finish race: a
  // `turn-finished` can arrive (over the live ws) AFTER the hub served the active-turns
  // snapshot but BEFORE seedActiveTurns applies it — without this, the stale snapshot
  // would resurrect the finished turn and wedge the session "working" forever. Cleared
  // when a fresh `turn-started` supersedes the finish. Non-reactive: a plain guard set.
  const finishedTurns = new Set<string>();
  const bufKey = (instanceId: string, alias: string) => `${instanceId}\0${alias}`;

  /** Which attention signal a session should show in the list. `working` (a live turn)
   *  outranks `unread` (a finished-but-unviewed result); otherwise `idle`. */
  function sessionAttention(instId: string, alias: string): "working" | "unread" | "idle" {
    const k = bufKey(instId, alias);
    if (liveTurns.value[k]) return "working";
    if (unread.value.has(k)) return "unread";
    return "idle";
  }

  /** Epoch ms when the session's live turn began, or null if it isn't working. */
  function runningSince(instId: string, alias: string): number | null {
    return liveTurns.value[bufKey(instId, alias)]?.startedAt ?? null;
  }

  const selectedKey = computed(() =>
    instanceId.value && sessionAlias.value ? bufKey(instanceId.value, sessionAlias.value) : null,
  );
  const liveTurn = computed<LiveTurn | null>(() =>
    selectedKey.value ? liveTurns.value[selectedKey.value] ?? null : null,
  );
  const sessionPlan = computed<PlanEntryDto[] | null>(() =>
    selectedKey.value ? plans.value[selectedKey.value] ?? null : null,
  );
  const sessionUsage = computed<SessionUsage | null>(() =>
    selectedKey.value ? usage.value[selectedKey.value] ?? null : null,
  );
  const sessionCommands = computed<AgentCommandDto[]>(() =>
    selectedKey.value ? agentCommands.value[selectedKey.value] ?? [] : [],
  );
  const sessionQueue = computed<QueueItemDto[]>(() =>
    selectedKey.value ? queues.value[selectedKey.value] ?? [] : [],
  );
  const streaming = computed(() => (liveTurn.value ? textOf(liveTurn.value.parts) : ""));
  const liveToolSteps = computed(() => (liveTurn.value ? toolStepsOf(liveTurn.value.parts) : []));
  const busy = computed(() => liveTurn.value !== null);

  const sending = ref(false);
  // A turn-finished event may trigger history convergence while a queued prompt RPC
  // still has no queueItemId. Keep that session on its optimistic transcript until
  // the response establishes correlation; a later finish reloads authoritative rows.
  const pendingPromptRequests = new Map<string, number>();
  const deferredHistoryLoads = new Set<string>();
  const hydratingMessages = new Map<number, Promise<void>>();
  const error = ref("");
  // "View" on a fired scheduled task asks MessageList to scroll to that run. Nonce-keyed
  // so repeat clicks on the same task re-trigger the jump (a plain id wouldn't change).
  const scrollRequest = ref<{ taskId: string; nonce: number } | null>(null);
  let scrollNonce = 0;
  function requestScrollToScheduled(taskId: string): void {
    scrollRequest.value = { taskId, nonce: ++scrollNonce };
  }
  // Cursor pagination for "load older" on scroll-up. `hasMoreOlder` = older rows exist
  // beyond what's loaded; `loadingOlder` guards against overlapping fetches.
  // First screen is the newest 10 rows (~5 exchanges). Compact view omits bulky
  // tool details; expand hydrates the full row via ensureFullMessage().
  const HISTORY_PAGE = 10;
  const historyPath = (id: string, alias: string, before?: number): string => {
    const qs = before === undefined
      ? `limit=${HISTORY_PAGE}&view=compact`
      : `before=${before}&limit=${HISTORY_PAGE}&view=compact`;
    return `/api/instances/${id}/sessions/${alias}/messages?${qs}`;
  };
  const hasMoreOlder = ref(false);
  const loadingOlder = ref(false);
  // True while the initial history page for a freshly selected session is in flight —
  // drives the transcript skeleton. Background reloads (turn-finished convergence) set
  // it too, but the skeleton only renders when the pane is empty, so those never flash.
  const loadingHistory = ref(false);
  // An async history response may replace messages only if the user is still on
  // the same selection, it is the newest request, and no transcript mutation
  // happened while it was in flight.
  let historyRequestSequence = 0;
  let transcriptRevision = 0;
  const touchTranscript = (): void => { transcriptRevision += 1; };

  function ensureTurn(k: string): LiveTurn {
    let t = liveTurns.value[k];
    if (!t) {
      const selected = selectedKey.value === k;
      t = {
        parts: [],
        status: "working",
        startedAt: Date.now(),
        slotAfterIndex: selected ? messages.value.length - 1 : -1,
      };
      liveTurns.value[k] = t;
    }
    return t;
  }

  /** Place the live bubble after the Hub insert-order anchor (history/seed/snapshot). */
  function syncLiveSlot(k: string): void {
    const t = liveTurns.value[k];
    if (!t || selectedKey.value !== k) return;
    if (typeof t.slotAfterId === "number") {
      t.slotAfterIndex = slotAfterIndexFromAnchor(messages.value, t.slotAfterId);
    }
  }

  // Known transport incarnations (SessionDto.transportSession) per session, fed
  // by each instance's authoritative session list (reconcileTailCache). Binds
  // cache entries to the session's identity: a same-alias recreation must not
  // resurrect the deleted predecessor's tail. "" = not yet known (matches any).
  const sessionIncarnations = new Map<string, string>();
  const incarnationOf = (id: string, alias: string): string => sessionIncarnations.get(bufKey(id, alias)) ?? "";

  // Stale-while-revalidate tail cache (#205): select() kicks off an async seed
  // from IndexedDB (pendingSeed below); authoritative rows (loadHistory) are
  // written back debounced so bursty turn-finished convergence doesn't hammer
  // serialization. The writer reads selection/messages at FLUSH time, so a flush
  // always persists what is actually displayed for the session it is keyed to.
  const cacheWrite = createDebouncedFlush(() => {
    const user = useAuthStore().account?.username;
    if (!user || !instanceId.value || !sessionAlias.value) return;
    void tailCache.write(user, instanceId.value, sessionAlias.value, messages.value, incarnationOf(instanceId.value, sessionAlias.value));
  }, 500);
  // Best-effort: an IDB write started during unload may not commit (unlike the
  // old synchronous localStorage flush); loadHistory converges on the next visit.
  if (typeof window !== "undefined") window.addEventListener("pagehide", () => cacheWrite.flush());

  // True while `messages` holds ONLY rows seeded from the tail cache — i.e. no
  // optimistic/live rows a wholesale history replace could clobber. loadHistory's
  // pending-prompt guard treats such a transcript as empty (the #199 semantics:
  // fetching over it clobbers nothing), cleared by the first authoritative replace
  // or any local push.
  let seededFromCache = false;
  // True while ANY wildcard-seeded rows remain in the transcript (a live-turn
  // flush appends but does not remove them; only an authoritative replace or a
  // selection reset does). Unlike seededFromCache this survives flushTurn — it
  // marks the transcript as a possible predecessor tail for the recreation
  // guard in reconcileTailCache.
  let seedRowsPresent = false;
  // The in-flight cache seed for the current selection (null when none was kicked
  // off) — loadHistory awaits it so its guards observe the seeded transcript
  // before deciding to fetch/skeleton.
  let pendingSeed: Promise<void> | null = null;

  /** Purge one session's cached tail. Routed through the chat store (not called on
   *  the cache module directly) so a purge also cancels a pending debounced
   *  write-back targeting that session — otherwise a write scheduled just before an
   *  archive/remove would fire after the drop and resurrect the entry as a ghost. */
  function purgeTailCache(id: string, alias: string): void {
    if (instanceId.value === id && sessionAlias.value === alias) cacheWrite.cancel();
    sessionIncarnations.delete(bufKey(id, alias));
    const user = useAuthStore().account?.username;
    if (user) void tailCache.drop(user, id, alias);
  }

  /** Reconcile an instance's cached tails against its authoritative alive
   *  sessions (alias + incarnation), keeping the incarnation registry in sync
   *  (see purgeTailCache for why this lives on the chat store). */
  function reconcileTailCache(id: string, alive: tailCache.AliveSession[]): void {
    const aliveByAlias = new Map(alive.map((s) => [s.alias, s.incarnation ?? ""]));
    if (instanceId.value === id && sessionAlias.value !== null) {
      const incoming = aliveByAlias.get(sessionAlias.value);
      if (incoming === undefined) {
        cacheWrite.cancel();
      } else {
        // Same-alias recreation observed WHILE selected: the pane still shows the
        // predecessor's transcript, so a pending debounced write-back would
        // re-poison the cache under the NEW incarnation. Cancel it and refetch.
        // A still-unknown prev ("") counts as suspect while wildcard-seeded rows
        // remain in the transcript — the seed may be the predecessor's tail.
        const prev = incarnationOf(id, sessionAlias.value);
        const recreated = prev !== "" && incoming !== "" && prev !== incoming;
        if (recreated || (prev === "" && incoming !== "" && seedRowsPresent)) {
          cacheWrite.cancel();
          if (recreated) void loadHistory().catch(() => {});
        }
      }
    }
    // Refresh the registry, pruning this instance's dead aliases so a stale
    // incarnation cannot outlive its session.
    const prefix = bufKey(id, "");
    for (const key of sessionIncarnations.keys()) {
      if (key.startsWith(prefix) && !aliveByAlias.has(key.slice(prefix.length))) sessionIncarnations.delete(key);
    }
    for (const s of alive) {
      if (s.incarnation) sessionIncarnations.set(bufKey(id, s.alias), s.incarnation);
    }
    const user = useAuthStore().account?.username;
    if (user) void tailCache.reconcile(user, id, alive);
  }

  /** Finalize a live turn: clear it (so `busy`/HUD release) and, if it streamed any
   *  content into the selected session, flush it into a persisted-shaped message.
   *  Used by both turn-finished and the optimistic local cancel. Idempotent — a
   *  second call for an already-cleared turn is a no-op. */
  function flushTurn(instId: string, alias: string, status: TurnStatus, errorMessage?: string): void {
    const k = bufKey(instId, alias);
    const t = liveTurns.value[k];
    delete liveTurns.value[k];
    const selected = instId === instanceId.value && alias === sessionAlias.value;
    if (status === "error" && selected) error.value = errorMessage ?? "turn-failed";
    if (!t) return;
    const text = textOf(t.parts);
    const toolSteps = toolStepsOf(t.parts);
    const reasoning = reasoningOf(t.parts);
    const hasContent = text.length > 0 || toolSteps.length > 0 || reasoning.length > 0;
    if (hasContent && selected) {
      const hasStructured = toolSteps.length > 0 || reasoning.length > 0;
      const structured = hasStructured
        ? markRaw({ toolSteps, ...(reasoning ? { reasoning } : {}), parts: t.parts })
        : undefined;
      const insertAt = Math.min(Math.max((t.slotAfterIndex ?? messages.value.length - 1) + 1, 0), messages.value.length);
      messages.value.splice(insertAt, 0, {
        instanceId: instId,
        sessionAlias: alias,
        direction: "out",
        text,
        createdAt: new Date().toISOString(),
        startedAt: t.startedAt,
        ...(typeof t.slotAfterId === "number" ? { slotAfterId: t.slotAfterId } : {}),
        failed: status === "error",
        status,
        ...(structured ? { structured } : {}),
      });
      touchTranscript();
      seededFromCache = false;
      cacheWrite.schedule();
    }
  }

  function select(id: string, alias: string): void {
    // Persist the outgoing session's tail before the transcript resets, so a quick
    // back-and-forth switch still finds the freshest rows in the cache.
    cacheWrite.flush();
    instanceId.value = id;
    sessionAlias.value = alias;
    persistSelection(id, alias);
    recordTabFocus(id, alias);
    messages.value = [];
    touchTranscript();
    historyRequestSequence += 1;
    error.value = "";
    hasMoreOlder.value = false;
    loadingOlder.value = false;
    loadingHistory.value = false;
    // Stale-while-revalidate: seed the transcript from the cached tail so the first
    // screen renders near-instantly (an IndexedDB read is ms-scale; loadHistory
    // awaits pendingSeed before its guards/fetch so a hit still suppresses the
    // skeleton). loadHistory() replaces the seed wholesale when the authoritative
    // page arrives; stable p${id} row keys make that replace flicker-free.
    const user = useAuthStore().account?.username;
    seededFromCache = false;
    seedRowsPresent = false;
    pendingSeed = user ? seedFromCache(user, id, alias) : null;
    // Viewing a session clears its unread signal.
    const k = bufKey(id, alias);
    if (unread.value.has(k)) {
      const next = new Set(unread.value);
      next.delete(k);
      unread.value = next;
    }
    syncLiveSlot(k);
  }

  /** Apply the cached tail for a freshly selected session, unless the selection
   *  changed or the transcript gained rows (live turn / authoritative history)
   *  while the read was in flight — those must never be clobbered by a seed. */
  async function seedFromCache(user: string, id: string, alias: string): Promise<void> {
    const revision = transcriptRevision;
    const cached = await tailCache.read(user, id, alias, incarnationOf(id, alias));
    if (!cached || cached.length === 0) return;
    if (id !== instanceId.value || alias !== sessionAlias.value) return;
    if (messages.value.length > 0 || revision !== transcriptRevision) return;
    messages.value = placeTurnsInSlots(cached.map(rawStructured));
    touchTranscript();
    seededFromCache = true;
    seedRowsPresent = true;
    if (instanceId.value && sessionAlias.value) syncLiveSlot(bufKey(instanceId.value, sessionAlias.value));
  }

  /** Drop the active selection back to the empty "no session" state — used when the
   *  selected session is deleted out from under the view. */
  function clearSelection(): void {
    cacheWrite.flush();
    seededFromCache = false;
    seedRowsPresent = false;
    pendingSeed = null;
    instanceId.value = null;
    sessionAlias.value = null;
    recordTabFocus(null, null);
    clearPersistedSelection();
    messages.value = [];
    touchTranscript();
    historyRequestSequence += 1;
    error.value = "";
    hasMoreOlder.value = false;
    loadingOlder.value = false;
    loadingHistory.value = false;
  }

  async function loadHistory(): Promise<void> {
    if (!instanceId.value || !sessionAlias.value) return;
    // Let a cache seed kicked off by select() land first (ms-scale IndexedDB read):
    // the guards below must observe the seeded transcript, and a hit keeps the
    // skeleton suppressed during the fetch. No seed → stay synchronous. A select()
    // during the await replaces pendingSeed — loop until the awaited seed is the
    // current one, then clear it (consumed).
    for (let seed = pendingSeed; seed; seed = pendingSeed) {
      await seed;
      if (pendingSeed === seed) { pendingSeed = null; break; }
    }
    if (!instanceId.value || !sessionAlias.value) return;
    const id = instanceId.value;
    const alias = sessionAlias.value;
    const historyKey = bufKey(id, alias);
    // While a prompt RPC is pending, history is not yet authoritative for that prompt:
    // the hub persists the "in" row on enqueue, but its queueItemId is only stamped
    // once the RPC response arrives (markQueued). Rows fetched inside that window lack
    // the correlation id, so a later drain event can't match them and would push a
    // duplicate bubble. Always schedule a convergence reload for after the RPC settles
    // (send()'s finally) to pull the authoritative rows back. Beyond that, defer only
    // background convergence reloads: a non-empty transcript may hold an optimistic
    // prompt row whose queueItemId correlation the pending RPC hasn't established yet,
    // and replacing it would break the drain-event dedupe. A freshly selected pane is
    // empty or holds only cache-seeded persisted rows (select() cleared it, then may
    // have seeded the tail cache — spec #205), so fetching history there clobbers
    // nothing — skipping it would leave the stale tail + live turn (without the just
    // sent prompt) visible until the RPC settles.
    if ((pendingPromptRequests.get(historyKey) ?? 0) > 0) {
      deferredHistoryLoads.add(historyKey);
      if (messages.value.length > 0 && !seededFromCache) return;
    }
    const requestSequence = ++historyRequestSequence;
    const revision = transcriptRevision;
    loadingHistory.value = true;
    try {
      const { messages: rows, hasMore } = await api.get<{ messages: MessageRecordDto[]; hasMore?: boolean }>(
        historyPath(id, alias),
      );
      if (id !== instanceId.value || alias !== sessionAlias.value) return;
      if (requestSequence !== historyRequestSequence) return;
      // A live event may mutate the selected transcript while this request is in
      // flight (most notably turn-started when switching to a working session).
      // The response can no longer replace local state safely, but abandoning it
      // would leave the pane with only the live turn. Retry against the same
      // selection so persisted history and the current turn converge.
      if (revision !== transcriptRevision) return loadHistory();
      messages.value = placeTurnsInSlots(keepRicherStructured(rows, messages.value).map(rawStructured));
      touchTranscript();
      seededFromCache = false;
      seedRowsPresent = false;
      hasMoreOlder.value = hasMore ?? false;
      // Authoritative rows landed — refresh this session's cached tail (debounced).
      cacheWrite.schedule();
      syncLiveSlot(historyKey);
    } finally {
      // Only the newest request owns the flag — a stale response must not dismiss
      // the skeleton a newer selection just raised.
      if (requestSequence === historyRequestSequence) loadingHistory.value = false;
    }
  }

  /** Fetch the page of history immediately older than the oldest row we hold and PREPEND
   *  it (cursor = oldest persisted id). The caller (MessageList) preserves scroll position
   *  across the prepend. No-op while another page is in flight or when none remain. */
  async function loadOlder(): Promise<void> {
    if (!instanceId.value || !sessionAlias.value || loadingOlder.value || !hasMoreOlder.value) return;
    const oldestId = messages.value.find((m) => typeof m.id === "number")?.id;
    if (oldestId === undefined) return;
    const id = instanceId.value;
    const alias = sessionAlias.value;
    loadingOlder.value = true;
    try {
      const { messages: older, hasMore } = await api.get<{ messages: MessageRecordDto[]; hasMore?: boolean }>(
        historyPath(id, alias, oldestId),
      );
      // The session may have changed while awaiting; only apply if still selected.
      if (id !== instanceId.value || alias !== sessionAlias.value) return;
      if (older.length > 0) {
        messages.value = placeTurnsInSlots([...older.map(rawStructured), ...messages.value]);
        touchTranscript();
        const live = liveTurns.value[bufKey(id, alias)];
        if (live) live.slotAfterIndex = (live.slotAfterIndex ?? 0) + older.length;
        syncLiveSlot(bufKey(id, alias));
      }
      hasMoreOlder.value = hasMore ?? false;
    } catch {
      // Best-effort: leave hasMoreOlder set so a later scroll retries.
    } finally {
      loadingOlder.value = false;
    }
  }

  /** Rebuild live turns from the hub's in-flight snapshot (after a refresh/reconnect).
   *  Seeds by absolute (instance, session) key so sidebar "working" dots light up and
   *  the open conversation's HUD/streaming bubble reappear; subsequent ws events
   *  (turn-output / tool-event / turn-finished) continue and finalize each turn. */
  function seedActiveTurns(turns: LiveTurnSnapshotDto[]): void {
    for (const t of turns) {
      const k = bufKey(t.instanceId, t.sessionAlias);
      // Don't overwrite a live turn already tracked from the ws stream (it's fresher),
      // and don't resurrect one that finished in the snapshot→seed gap (see finishedTurns).
      if (liveTurns.value[k] || finishedTurns.has(k)) continue;
      liveTurns.value[k] = {
        parts: t.parts as TurnPart[],
        status: t.status,
        startedAt: t.startedAt,
        ...(typeof t.slotAfterId === "number" ? { slotAfterId: t.slotAfterId } : {}),
        slotAfterIndex: selectedKey.value === k && typeof t.slotAfterId === "number"
          ? slotAfterIndexFromAnchor(messages.value, t.slotAfterId)
          : selectedKey.value === k ? messages.value.length - 1 : -1,
      };
    }
  }

  /** Replace one instance's live state from the ordered subscription snapshot.
   *  Unlike the best-effort HTTP seed above, this is authoritative: frames sent
   *  before it are represented by the snapshot, and later deltas arrive after it
   *  on the same WebSocket. Clearing absent turns is what releases stale spinners
   *  when a turn completed while the browser was disconnected. */
  function applyStateSnapshot(
    instId: string,
    turns: LiveTurnSnapshotDto[],
    usageSnapshot: SessionUsageSnapshotDto[],
    commandsSnapshot: SessionCommandsSnapshotDto[],
  ): void {
    const prefix = `${instId}\0`;

    const nextTurns = { ...liveTurns.value };
    for (const k of Object.keys(nextTurns)) if (k.startsWith(prefix)) delete nextTurns[k];
    for (const turn of turns) {
      const k = bufKey(instId, turn.sessionAlias);
      nextTurns[k] = {
        parts: turn.parts as TurnPart[],
        status: turn.status,
        startedAt: turn.startedAt,
        ...(typeof turn.slotAfterId === "number" ? { slotAfterId: turn.slotAfterId } : {}),
        slotAfterIndex: selectedKey.value === k && typeof turn.slotAfterId === "number"
          ? slotAfterIndexFromAnchor(messages.value, turn.slotAfterId)
          : selectedKey.value === k ? messages.value.length - 1 : -1,
      };
    }
    liveTurns.value = nextTurns;

    // A snapshot is a newer ordering boundary than any finish guard retained from
    // the old socket. Active rows in it are real new/current turns, not stale seeds.
    for (const k of [...finishedTurns]) if (k.startsWith(prefix)) finishedTurns.delete(k);

    const nextUsage = { ...usage.value };
    for (const k of Object.keys(nextUsage)) if (k.startsWith(prefix)) delete nextUsage[k];
    usage.value = nextUsage;
    seedUsage(usageSnapshot);

    const nextCommands = { ...agentCommands.value };
    for (const k of Object.keys(nextCommands)) if (k.startsWith(prefix)) delete nextCommands[k];
    agentCommands.value = nextCommands;
    seedCommands(commandsSnapshot);
  }

  /** Seed the per-session context-usage meter from the hub's snapshot (after a
   *  refresh/reconnect), so the usage bar reappears without waiting for the next turn. */
  function seedUsage(snapshots: SessionUsageSnapshotDto[]): void {
    for (const u of snapshots) {
      usage.value[bufKey(u.instanceId, u.sessionAlias)] = { used: u.used, size: u.size, ...(u.cost ? { cost: u.cost } : {}), ...(u.breakdown ? { breakdown: u.breakdown } : {}) };
    }
  }

  /** Seed the per-session agent command list from the hub's snapshot (after a
   *  refresh/reconnect), so the composer's "/" hints reappear without waiting for the
   *  agent to re-advertise (which it typically only does at session start). */
  function seedCommands(snapshots: SessionCommandsSnapshotDto[]): void {
    for (const s of snapshots) {
      agentCommands.value[bufKey(s.instanceId, s.sessionAlias)] = s.commands;
    }
  }

  async function loadActiveTurns(): Promise<void> {
    const { turns, usage: usageSnapshot, commands: commandsSnapshot } = await api.get<{ turns: LiveTurnSnapshotDto[]; usage?: SessionUsageSnapshotDto[]; commands?: SessionCommandsSnapshotDto[] }>("/api/active-turns");
    seedActiveTurns(turns);
    if (usageSnapshot) seedUsage(usageSnapshot);
    if (commandsSnapshot) seedCommands(commandsSnapshot);
  }

  function applyEvent(event: WebServerEvent): void {
    if (event.kind === "instance-status" && !event.online) {
      const prefix = `${event.instanceId}\0`;
      for (const k of Object.keys(liveTurns.value)) if (k.startsWith(prefix)) delete liveTurns.value[k];
      const next = new Set([...unread.value].filter((k) => !k.startsWith(prefix)));
      if (next.size !== unread.value.size) unread.value = next;
      return;
    }
    if (event.kind === "state-snapshot") {
      applyStateSnapshot(event.instanceId, event.turns, event.usage, event.commands);
      return;
    }
    if (event.kind === "turn-completion") {
      const alias = event.sessionAlias;
      const selected = event.instanceId === instanceId.value && alias === sessionAlias.value;
      const isActiveInAnyTab = isSessionActiveInAnyTab(event.instanceId, alias, selected);
      if (!isActiveInAnyTab && claimNotificationSlot(event.notificationId)) {
        const instancesStore = useInstancesStore();
        const instName = instancesStore.byId(event.instanceId)?.name ?? event.instanceId;
        void showLocalTurnNotification({
          instanceId: event.instanceId,
          instanceName: instName,
          sessionAlias: alias,
          ok: event.ok !== false,
          text: event.text,
          errorMessage: event.errorMessage,
        });
      }
      return;
    }
    if (event.kind !== "control-event") return;
    const e = event.event;
    if (e.type === "turn-started") {
      const k = bufKey(event.instanceId, e.sessionAlias);
      finishedTurns.delete(k); // a fresh turn supersedes any prior finish on this key
      ensureTurn(k);
      // Scheduled turns have no optimistic bubble; drained queue turns use queueItemId
      // to move their existing bubble. Other clients can add the carried prompt here.
      const selected = event.instanceId === instanceId.value && e.sessionAlias === sessionAlias.value;
      if (e.queueItemId && selected) {
        const queuedIndex = messages.value.findIndex((message) => message.queueItemId === e.queueItemId);
        if (queuedIndex >= 0) {
          const [queued] = messages.value.splice(queuedIndex, 1);
          messages.value.push(queued!);
          touchTranscript();
        } else if (e.prompt) {
          messages.value.push({
            instanceId: event.instanceId,
            sessionAlias: e.sessionAlias,
            direction: "in",
            text: e.prompt,
            createdAt: new Date().toISOString(),
            queueItemId: e.queueItemId,
          });
          touchTranscript();
          seededFromCache = false;
        }
      } else if (e.prompt && selected) {
        messages.value.push({
          instanceId: event.instanceId,
          sessionAlias: e.sessionAlias,
          direction: "in",
          text: e.prompt,
          createdAt: new Date().toISOString(),
          ...(e.scheduled ? { scheduled: e.scheduled } : {}),
        });
        touchTranscript();
        seededFromCache = false;
      }
      // Anchor the live slot after whatever is now last (triggering received card,
      // the prompt just appended, or the drained queued bubble). Later mid-turn
      // rows append below this slot. Insert order — never infer from startedAt.
      if (selected) {
        const live = liveTurns.value[k];
        if (live) {
          live.slotAfterIndex = messages.value.length - 1;
          if (typeof e.slotAfterId === "number") live.slotAfterId = e.slotAfterId;
        }
      }
    } else if (e.type === "turn-output") {
      const t = ensureTurn(bufKey(event.instanceId, e.sessionAlias));
      appendText(t.parts, e.chunk);
      t.status = "streaming";
    } else if (e.type === "tool-event") {
      const t = ensureTurn(bufKey(event.instanceId, e.sessionAlias));
      upsertTool(t.parts, e.step);
    } else if (e.type === "turn-thought") {
      appendReasoning(ensureTurn(bufKey(event.instanceId, e.sessionAlias)).parts, e.chunk);
    } else if (e.type === "plan") {
      // Lifetime decoupled from the live turn: persists past turn-finished, replaced only
      // by a newer plan for this session. Keyed per session.
      plans.value[bufKey(event.instanceId, e.sessionAlias)] = e.entries;
    } else if (e.type === "turn-usage") {
      // Latest context-usage for the session (REPLACE). Like plans, persists across turns.
      usage.value[bufKey(event.instanceId, e.sessionAlias)] = { used: e.used, size: e.size, ...(e.cost ? { cost: e.cost } : {}), ...(e.breakdown ? { breakdown: e.breakdown } : {}) };
    } else if (e.type === "agent-commands") {
      // Latest agent slash-command list for the session (REPLACE). Drives composer "/" hints.
      agentCommands.value[bufKey(event.instanceId, e.sessionAlias)] = e.commands;
    } else if (e.type === "queue-updated") {
      // Server-authoritative snapshot of the session's pending prompt queue (REPLACE).
      queues.value[bufKey(event.instanceId, e.sessionAlias)] = e.items;
    } else if (e.type === "agent-message") {
      const selected = event.instanceId === instanceId.value && e.sessionAlias === sessionAlias.value;
      if (selected) {
        const existing = messages.value.find(
          (m) =>
            m.structured?.agentMessage &&
            m.structured.agentMessage.direction === e.message.direction &&
            m.structured.agentMessage.messageId === e.message.messageId,
        );
        if (existing) {
          existing.structured = markRaw({
            ...existing.structured,
            agentMessage: e.message,
          });
        } else {
          const direction = e.message.direction === "sent" ? "out" : "in";
          messages.value.push({
            instanceId: event.instanceId,
            sessionAlias: e.sessionAlias,
            direction,
            text: e.message.content,
            createdAt: new Date(e.message.createdAt).toISOString(),
            structured: markRaw({ agentMessage: e.message }),
          });
        }
        touchTranscript();
      } else {
        const k = bufKey(event.instanceId, e.sessionAlias);
        const next = new Set(unread.value);
        next.add(k);
        unread.value = next;
      }
    } else if (e.type === "agent-message-completion") {
      // v0.3 completion-status PATCH: flip the terminal status on the existing
      // sender card row. Never append or synthesize a row from this event.
      const selected = event.instanceId === instanceId.value && e.sessionAlias === sessionAlias.value;
      if (selected) {
        const existing = messages.value.find(
          (m) =>
            m.structured?.agentMessage &&
            m.structured.agentMessage.messageId === e.messageId,
        );
        if (existing && existing.structured?.agentMessage) {
          existing.structured = markRaw({
            ...existing.structured,
            agentMessage: {
              ...existing.structured.agentMessage,
              completionStatus: e.completionStatus,
            },
          });
          touchTranscript();
        }
      }
    } else if (e.type === "session-history") {
      // hub. If we're viewing it, reload history so the backlog appears (otherwise it's
      // already persisted and the next loadHistory on select will show it).
      if (event.instanceId === instanceId.value && e.sessionAlias === sessionAlias.value) {
        void loadHistory().catch(() => {});
      }
    } else if (e.type === "turn-finished") {
      const status: TurnStatus = e.cancelled ? "cancelled" : e.ok ? "done" : "error";
      const selected = event.instanceId === instanceId.value && e.sessionAlias === sessionAlias.value;
      // Mark finished so a late active-turns snapshot can't resurrect this turn, even if
      // the finish raced ahead of seedActiveTurns (no live turn existed to flush yet).
      finishedTurns.add(bufKey(event.instanceId, e.sessionAlias));
      flushTurn(event.instanceId, e.sessionAlias, status, e.errorMessage);
      // Keep the immediate live flush for responsiveness, then converge on the
      // persisted rows. Starting this request invalidates any older history read,
      // so HTTP/WS arrival order cannot delete or permanently duplicate the final.
      if (selected) void loadHistory().catch(() => {});
      // A result that landed in a session the user isn't viewing earns an unread dot.
      if (!selected && (status === "done" || status === "error")) {
        const k = bufKey(event.instanceId, e.sessionAlias);
        const next = new Set(unread.value);
        next.add(k);
        unread.value = next;
      }
    }
  }

  async function send(
    text: string,
    attachments: PromptAttachmentRef[] = [],
    agentMentions?: Array<{ range: [number, number]; handle: string }>,
  ): Promise<void> {
    if (!instanceId.value || !sessionAlias.value) return;
    const id = instanceId.value;
    const alias = sessionAlias.value;
    const pendingEffortSet = useSessionControlsStore().waitForEffortSet(id, alias);
    if (pendingEffortSet) await pendingEffortSet;
    const pendingKey = bufKey(id, alias);
    pendingPromptRequests.set(pendingKey, (pendingPromptRequests.get(pendingKey) ?? 0) + 1);
    error.value = "";
    sending.value = true;
    const optimistic: ChatMessage = {
      instanceId: id,
      sessionAlias: alias,
      direction: "in",
      text,
      createdAt: new Date().toISOString(),
      ...(attachments.length > 0
        ? { attachments: attachments.map((a): AttachmentMetadata => ({ id: a.id, filename: a.fileName, mimeType: a.mimeType, size: a.size, kind: a.kind, ...(a.previewUrl ? { previewUrl: a.previewUrl } : {}) })) }
        : {}),
    };
    messages.value.push(optimistic);
    touchTranscript();
    seededFromCache = false;
    // Sending a prompt wakes an archived session and warms a cold one server-side
    // (session-turn-runner clears both on prompt start), so flip the sidebar row's
    // indicators immediately. `archived` converges anyway via the sessions-changed
    // push, but cold→warm has NO push (markWarm deliberately skips the event), so
    // this optimistic clear is the ONLY way the cold icon disappears before the
    // next unrelated re-fetch. A failed send restores the prior values; if
    // loadSessions replaced the row meanwhile, the rollback mutates a detached
    // object and is a harmless no-op.
    const sessionRow = useInstancesStore().byId(id)?.sessions.find((s) => s.alias === alias);
    const prevWarm = sessionRow?.warm;
    const prevArchived = sessionRow?.archived === true;
    const clearedIndicators = sessionRow !== undefined && (sessionRow.warm === false || sessionRow.archived);
    if (sessionRow) {
      if (sessionRow.warm === false) sessionRow.warm = true;
      if (sessionRow.archived) sessionRow.archived = false;
    }
    // Conservative on ok:false: the prompt RPC resolves only after the turn ends, so
    // a failure may still have warmed the process (turn ran, agent errored). We can't
    // tell that apart from "turn never started", so restore the cold icon — worst
    // case it over-reports cold and the next send clears it again.
    const rollbackIndicators = (): void => {
      if (!sessionRow || !clearedIndicators) return;
      sessionRow.warm = prevWarm;
      sessionRow.archived = prevArchived;
    };
    // `optimistic` above is the RAW object; the array element is a reactive proxy. Mutating the
    // raw ref (optimistic.failed = true) never trips Vue's set-trap, so the failed bubble would
    // only surface on the next list change (the next message). Mark failure through the proxy so
    // the bubble turns red — and shows Failed/Resend — the instant the send errors.
    const entry = messages.value[messages.value.length - 1]!;
    let transportFailure = false;
    try {
      // The web dashboard is GUI-first: every message — including `/`-prefixed text —
      // is sent as a prompt so it streams as a normal turn. xacpx slash commands are
      // not handled here; the console forwards control-channel `/` text to the agent
      // verbatim (see command-router passthrough). Only WeChat/Feishu, which lack a
      // GUI, still rely on xacpx command handling.
      const res = await api.rpc<{ ok?: boolean; errorMessage?: string; queued?: boolean; queueItemId?: string }>(id, "control.prompt", {
        sessionAlias: alias,
        text,
        ...(attachments.length > 0 ? { media: attachments } : {}),
        ...(agentMentions && agentMentions.length > 0 ? { agentMentions } : {}),
      });
      if (res && res.ok === false) {
        error.value = res.errorMessage ?? "prompt-failed";
        entry.failed = true;
        rollbackIndicators();
        touchTranscript();
      } else if (res?.queued && res.queueItemId) {
        entry.queueItemId = res.queueItemId;
        if (messages.value.some((message) => message !== entry && message.queueItemId === res.queueItemId)) {
          // The drain event won the race with the RPC response. Keep the original
          // optimistic row (including attachments) at the event bubble's position.
          const entryIndex = messages.value.indexOf(entry);
          if (entryIndex >= 0) messages.value.splice(entryIndex, 1);
          const eventBubbleIndex = messages.value.findIndex((message) => message.queueItemId === res.queueItemId);
          if (eventBubbleIndex >= 0) messages.value.splice(eventBubbleIndex, 1, entry);
        }
        touchTranscript();
      }
    } catch (e) {
      const isTimeout = e instanceof ApiError && (e.status === 504 || e.code === "timeout");
      // Fetch reports a dropped connection as a bare TypeError, even when the Hub
      // already accepted the prompt and the turn is streaming over WebSocket. Its
      // delivery state is therefore indeterminate, just like a 504. Do not mark the
      // optimistic row as definitely failed (or invite an unsafe duplicate resend);
      // live events and the next history convergence provide the authoritative state.
      const isTransportFailure = e instanceof TypeError;
      transportFailure = isTransportFailure;
      if (!isTimeout && !isTransportFailure) {
        error.value = e instanceof ApiError ? e.code : "send-failed";
        entry.failed = true;
        rollbackIndicators();
        touchTranscript();
      }
    } finally {
      const remaining = (pendingPromptRequests.get(pendingKey) ?? 1) - 1;
      if (remaining > 0) pendingPromptRequests.set(pendingKey, remaining);
      else {
        pendingPromptRequests.delete(pendingKey);
      }
      // A transport failure is ambiguous: the prompt may have reached the Hub, or
      // it may never have left the browser. Once all overlapping prompt RPCs settle,
      // replace the optimistic transcript with the authoritative history page so a
      // never-delivered bubble cannot remain forever. If another prompt is pending,
      // defer the same convergence until that last request settles.
      if (transportFailure) deferredHistoryLoads.add(pendingKey);
      const shouldReload = remaining === 0 && deferredHistoryLoads.delete(pendingKey);
      if (shouldReload && selectedKey.value === pendingKey) void loadHistory().catch(() => {});
      sending.value = false;
    }
  }

  /** Retry a failed outbound user message. Drops the failed attempt from the transcript
   *  (send() re-adds it optimistically) so a successful retry leaves exactly one clean
   *  entry rather than a failed line plus a duplicate. */
  async function resend(message: ChatMessage): Promise<void> {
    if (!message.failed || message.direction !== "in") return;
    const idx = messages.value.indexOf(message);
    if (idx >= 0) {
      messages.value.splice(idx, 1);
      touchTranscript();
    }
    await send(message.text);
  }

  async function cancel(): Promise<void> {
    if (!instanceId.value || !sessionAlias.value) return;
    const id = instanceId.value;
    const alias = sessionAlias.value;
    // Optimistically finalize locally so the input/HUD release immediately instead of
    // waiting for the server's turn-finished echo (which may be lost if the agent dies).
    // Streamed content is preserved as a "cancelled" message; the later echo finds no
    // live turn and is a no-op, so there is no double-render.
    flushTurn(id, alias, "cancelled");
    try {
      await api.rpc(id, "control.prompt.cancel", { sessionAlias: alias });
    } catch (e) {
      error.value = e instanceof ApiError ? e.code : "cancel-failed";
    }
  }

  /** Cancel a still-pending queued prompt. Drops the chip optimistically (so the strip
   *  reacts immediately) and issues the RPC best-effort — if it fails, the next
   *  `queue-updated` snapshot re-syncs the truth anyway. */
  /** Replace a compact list row with the full persisted structured payload so
   *  expanding a tool/subagent card can show diffs and command output. No-op when
   *  the row is already full, missing, or the selection changed. */
  async function ensureFullMessage(messageId: number): Promise<void> {
    const existing = messages.value.find((m) => m.id === messageId);
    if (!existing?.structured?.compact) return;
    if (!instanceId.value || !sessionAlias.value) return;
    const inFlight = hydratingMessages.get(messageId);
    if (inFlight) return inFlight;
    const id = instanceId.value;
    const alias = sessionAlias.value;
    const work = (async () => {
      const { message } = await api.get<{ message: MessageRecordDto }>(
        `/api/instances/${id}/sessions/${alias}/messages/${messageId}`,
      );
      if (id !== instanceId.value || alias !== sessionAlias.value) return;
      const idx = messages.value.findIndex((m) => m.id === messageId);
      if (idx < 0) return;
      const current = messages.value[idx]!;
      // A live event may have already replaced this row with full structured.
      if (current.structured?.compact !== true) return;
      const next = [...messages.value];
      next[idx] = rawStructured({ ...current, ...message, structured: message.structured });
      messages.value = next;
      cacheWrite.schedule();
    })();
    hydratingMessages.set(messageId, work);
    try {
      await work;
    } finally {
      hydratingMessages.delete(messageId);
    }
  }

  async function cancelQueuedItem(instanceId: string, alias: string, itemId: string): Promise<void> {
    const key = bufKey(instanceId, alias);
    const list = queues.value[key];
    if (list) queues.value[key] = list.filter((i) => i.id !== itemId);
    try {
      await api.rpc(instanceId, "control.queue.cancel", { sessionAlias: alias, itemId });
    } catch {
      // best-effort; a queue-updated re-syncs
    }
  }

  return { instanceId, sessionAlias, messages, streaming, liveTurn, sessionPlan, sessionUsage, sessionCommands, liveToolSteps, busy, unread, sessionAttention, runningSince, sending, error, scrollRequest, requestScrollToScheduled, hasMoreOlder, loadingOlder, loadingHistory, queues, sessionQueue, select, clearSelection, loadHistory, loadOlder, ensureFullMessage, loadActiveTurns, seedActiveTurns, applyStateSnapshot, applyEvent, send, resend, cancel, cancelQueuedItem, purgeTailCache, reconcileTailCache };
});
