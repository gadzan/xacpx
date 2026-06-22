import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { AttachmentMetadata, LiveTurnSnapshotDto, MessageRecordDto, PlanEntryDto, PromptAttachmentRef, ScheduledOriginDto, ToolStepDto, TurnPartDto, UsageBreakdownDto, UsageCostDto, WebServerEvent } from "@ganglion/xacpx-relay-protocol";
import { api, ApiError } from "../api/client";

// Remember which session was open so a page refresh returns to it (selection is not
// part of the route). Paired with the active-turn snapshot, a refresh mid-turn lands
// back on the live conversation instead of an empty pane.
const SELECTION_KEY = "xrelay.selectedSession";
function persistSelection(instanceId: string, alias: string): void {
  try { localStorage.setItem(SELECTION_KEY, JSON.stringify({ instanceId, alias })); } catch { /* storage may be blocked */ }
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

/** One transcript entry, kept in arrival order so text / reasoning / tool calls
 *  render inline exactly as the agent produced them (mirrors the hub's persistence). */
export type TurnPart = TurnPartDto;

export interface LiveTurn {
  parts: TurnPart[];
  status: "working" | "streaming";
  startedAt: number;
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
  if (last?.type === "reasoning") last.text += chunk;
  else parts.push({ type: "reasoning", text: chunk });
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
  const streaming = computed(() => (liveTurn.value ? textOf(liveTurn.value.parts) : ""));
  const liveToolSteps = computed(() => (liveTurn.value ? toolStepsOf(liveTurn.value.parts) : []));
  const busy = computed(() => liveTurn.value !== null);

  const sending = ref(false);
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
  const HISTORY_PAGE = 100;
  const hasMoreOlder = ref(false);
  const loadingOlder = ref(false);

  function ensureTurn(k: string): LiveTurn {
    let t = liveTurns.value[k];
    if (!t) { t = { parts: [], status: "working", startedAt: Date.now() }; liveTurns.value[k] = t; }
    return t;
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
        ? { toolSteps, ...(reasoning ? { reasoning } : {}), parts: t.parts }
        : undefined;
      messages.value.push({
        instanceId: instId,
        sessionAlias: alias,
        direction: "out",
        text,
        createdAt: new Date().toISOString(),
        failed: status === "error",
        status,
        ...(structured ? { structured } : {}),
      });
    }
  }

  function select(id: string, alias: string): void {
    instanceId.value = id;
    sessionAlias.value = alias;
    persistSelection(id, alias);
    messages.value = [];
    error.value = "";
    hasMoreOlder.value = false;
    loadingOlder.value = false;
    // Viewing a session clears its unread signal.
    const k = bufKey(id, alias);
    if (unread.value.has(k)) {
      const next = new Set(unread.value);
      next.delete(k);
      unread.value = next;
    }
  }

  async function loadHistory(): Promise<void> {
    if (!instanceId.value || !sessionAlias.value) return;
    const { messages: rows, hasMore } = await api.get<{ messages: MessageRecordDto[]; hasMore?: boolean }>(
      `/api/instances/${instanceId.value}/sessions/${sessionAlias.value}/messages?limit=${HISTORY_PAGE}`,
    );
    messages.value = rows;
    hasMoreOlder.value = hasMore ?? false;
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
        `/api/instances/${id}/sessions/${alias}/messages?before=${oldestId}&limit=${HISTORY_PAGE}`,
      );
      // The session may have changed while awaiting; only apply if still selected.
      if (id !== instanceId.value || alias !== sessionAlias.value) return;
      if (older.length > 0) messages.value = [...older, ...messages.value];
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
      liveTurns.value[k] = { parts: t.parts as TurnPart[], status: t.status, startedAt: t.startedAt };
    }
  }

  async function loadActiveTurns(): Promise<void> {
    const { turns } = await api.get<{ turns: LiveTurnSnapshotDto[] }>("/api/active-turns");
    seedActiveTurns(turns);
  }

  function applyEvent(event: WebServerEvent): void {
    if (event.kind === "instance-status" && !event.online) {
      const prefix = `${event.instanceId}\0`;
      for (const k of Object.keys(liveTurns.value)) if (k.startsWith(prefix)) delete liveTurns.value[k];
      const next = new Set([...unread.value].filter((k) => !k.startsWith(prefix)));
      if (next.size !== unread.value.size) unread.value = next;
      return;
    }
    if (event.kind !== "control-event") return;
    const e = event.event;
    if (e.type === "turn-started") {
      const k = bufKey(event.instanceId, e.sessionAlias);
      finishedTurns.delete(k); // a fresh turn supersedes any prior finish on this key
      ensureTurn(k);
      // A scheduled-origin turn has no optimistic user bubble (no one typed it), so
      // surface its prompt as an inbound message — with the schedule badge — when this
      // session is the one being viewed. History persists the same "in" row server-side.
      const selected = event.instanceId === instanceId.value && e.sessionAlias === sessionAlias.value;
      if (e.prompt && selected) {
        messages.value.push({
          instanceId: event.instanceId,
          sessionAlias: e.sessionAlias,
          direction: "in",
          text: e.prompt,
          createdAt: new Date().toISOString(),
          ...(e.scheduled ? { scheduled: e.scheduled } : {}),
        });
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
    } else if (e.type === "session-history") {
      // A freshly-attached native session's prior conversation was just seeded into the
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
      // A result that landed in a session the user isn't viewing earns an unread dot.
      if (!selected && (status === "done" || status === "error")) {
        const k = bufKey(event.instanceId, e.sessionAlias);
        const next = new Set(unread.value);
        next.add(k);
        unread.value = next;
      }
    }
  }

  async function send(text: string, attachments: PromptAttachmentRef[] = []): Promise<void> {
    if (!instanceId.value || !sessionAlias.value) return;
    error.value = "";
    sending.value = true;
    const optimistic: ChatMessage = {
      instanceId: instanceId.value,
      sessionAlias: sessionAlias.value,
      direction: "in",
      text,
      createdAt: new Date().toISOString(),
      ...(attachments.length > 0
        ? { attachments: attachments.map((a): AttachmentMetadata => ({ id: a.id, filename: a.fileName, mimeType: a.mimeType, size: a.size, kind: a.kind, ...(a.previewUrl ? { previewUrl: a.previewUrl } : {}) })) }
        : {}),
    };
    messages.value.push(optimistic);
    try {
      // The web dashboard is GUI-first: every message — including `/`-prefixed text —
      // is sent as a prompt so it streams as a normal turn. xacpx slash commands are
      // not handled here; the console forwards control-channel `/` text to the agent
      // verbatim (see command-router passthrough). Only WeChat/Feishu, which lack a
      // GUI, still rely on xacpx command handling.
      const res = await api.rpc<{ ok?: boolean; errorMessage?: string }>(instanceId.value, "control.prompt", {
        sessionAlias: sessionAlias.value,
        text,
        ...(attachments.length > 0 ? { media: attachments } : {}),
      });
      if (res && res.ok === false) {
        error.value = res.errorMessage ?? "prompt-failed";
        optimistic.failed = true;
      }
    } catch (e) {
      const isTimeout = e instanceof ApiError && (e.status === 504 || e.code === "timeout");
      if (!isTimeout) {
        error.value = e instanceof ApiError ? e.code : "send-failed";
        optimistic.failed = true;
      }
    } finally {
      sending.value = false;
    }
  }

  /** Retry a failed outbound user message. Drops the failed attempt from the transcript
   *  (send() re-adds it optimistically) so a successful retry leaves exactly one clean
   *  entry rather than a failed line plus a duplicate. */
  async function resend(message: ChatMessage): Promise<void> {
    if (!message.failed || message.direction !== "in") return;
    const idx = messages.value.indexOf(message);
    if (idx >= 0) messages.value.splice(idx, 1);
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

  return { instanceId, sessionAlias, messages, streaming, liveTurn, sessionPlan, sessionUsage, liveToolSteps, busy, unread, sessionAttention, runningSince, sending, error, scrollRequest, requestScrollToScheduled, hasMoreOlder, loadingOlder, select, loadHistory, loadOlder, loadActiveTurns, seedActiveTurns, applyEvent, send, resend, cancel };
});
