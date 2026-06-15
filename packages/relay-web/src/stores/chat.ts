import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { MessageRecordDto, ToolStepDto, TurnPartDto, WebServerEvent } from "@ganglion/xacpx-relay-protocol";
import { api, ApiError } from "../api/client";

export type TurnStatus = "working" | "streaming" | "done" | "cancelled" | "error";

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
}

export const useChatStore = defineStore("chat", () => {
  const instanceId = ref<string | null>(null);
  const sessionAlias = ref<string | null>(null);
  const messages = ref<ChatMessage[]>([]);
  const liveTurns = ref<Record<string, LiveTurn>>({});
  // Sessions whose turn finished while NOT being viewed — drives the "unread" attention
  // dot in the session list. Reassigned (never mutated in place) so the Set stays reactive.
  const unread = ref<Set<string>>(new Set());
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
  const streaming = computed(() => (liveTurn.value ? textOf(liveTurn.value.parts) : ""));
  const liveToolSteps = computed(() => (liveTurn.value ? toolStepsOf(liveTurn.value.parts) : []));
  const busy = computed(() => liveTurn.value !== null);

  const sending = ref(false);
  const error = ref("");

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
    messages.value = [];
    error.value = "";
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
    const { messages: rows } = await api.get<{ messages: MessageRecordDto[] }>(
      `/api/instances/${instanceId.value}/sessions/${sessionAlias.value}/messages`,
    );
    messages.value = rows;
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
      ensureTurn(bufKey(event.instanceId, e.sessionAlias));
    } else if (e.type === "turn-output") {
      const t = ensureTurn(bufKey(event.instanceId, e.sessionAlias));
      appendText(t.parts, e.chunk);
      t.status = "streaming";
    } else if (e.type === "tool-event") {
      const t = ensureTurn(bufKey(event.instanceId, e.sessionAlias));
      upsertTool(t.parts, e.step);
    } else if (e.type === "turn-thought") {
      appendReasoning(ensureTurn(bufKey(event.instanceId, e.sessionAlias)).parts, e.chunk);
    } else if (e.type === "turn-finished") {
      const status: TurnStatus = e.cancelled ? "cancelled" : e.ok ? "done" : "error";
      const selected = event.instanceId === instanceId.value && e.sessionAlias === sessionAlias.value;
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

  async function send(text: string): Promise<void> {
    if (!instanceId.value || !sessionAlias.value) return;
    error.value = "";
    sending.value = true;
    const optimistic: ChatMessage = { instanceId: instanceId.value, sessionAlias: sessionAlias.value, direction: "in", text, createdAt: new Date().toISOString() };
    messages.value.push(optimistic);
    try {
      if (text.startsWith("/")) {
        const { output } = await api.rpc<{ output: string }>(instanceId.value, "control.command.execute", { sessionAlias: sessionAlias.value, text });
        messages.value.push({ instanceId: instanceId.value, sessionAlias: sessionAlias.value, direction: "out", text: output, createdAt: new Date().toISOString() });
      } else {
        const res = await api.rpc<{ ok?: boolean; errorMessage?: string }>(instanceId.value, "control.prompt", { sessionAlias: sessionAlias.value, text });
        if (res && res.ok === false) {
          error.value = res.errorMessage ?? "prompt-failed";
          optimistic.failed = true;
        }
      }
    } catch (e) {
      const isTimeout = e instanceof ApiError && (e.status === 504 || e.code === "timeout");
      if (text.startsWith("/") || !isTimeout) {
        error.value = e instanceof ApiError ? e.code : "send-failed";
        optimistic.failed = true;
      }
    } finally {
      sending.value = false;
    }
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

  return { instanceId, sessionAlias, messages, streaming, liveTurn, liveToolSteps, busy, unread, sessionAttention, runningSince, sending, error, select, loadHistory, applyEvent, send, cancel };
});
