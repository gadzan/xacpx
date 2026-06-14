import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { MessageRecordDto, ToolStepDto, WebServerEvent } from "@ganglion/xacpx-relay-protocol";
import { api, ApiError } from "../api/client";

export type TurnStatus = "working" | "streaming" | "done" | "cancelled" | "error";

export interface LiveTurn {
  text: string;
  toolSteps: ToolStepDto[];
  reasoning: string;
  status: "working" | "streaming";
  startedAt: number;
}

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

  const selectedKey = computed(() =>
    instanceId.value && sessionAlias.value ? bufKey(instanceId.value, sessionAlias.value) : null,
  );
  const liveTurn = computed<LiveTurn | null>(() =>
    selectedKey.value ? liveTurns.value[selectedKey.value] ?? null : null,
  );
  const streaming = computed(() => liveTurn.value?.text ?? "");
  const busy = computed(() => liveTurn.value !== null);

  const sending = ref(false);
  const error = ref("");

  function ensureTurn(k: string): LiveTurn {
    let t = liveTurns.value[k];
    if (!t) { t = { text: "", toolSteps: [], reasoning: "", status: "working", startedAt: Date.now() }; liveTurns.value[k] = t; }
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
    const hasContent = !!t && (t.text.length > 0 || t.toolSteps.length > 0 || t.reasoning.length > 0);
    if (hasContent && selected) {
      const structured =
        t!.toolSteps.length > 0 || t!.reasoning.length > 0
          ? { toolSteps: t!.toolSteps, ...(t!.reasoning ? { reasoning: t!.reasoning } : {}) }
          : undefined;
      messages.value.push({
        instanceId: instId,
        sessionAlias: alias,
        direction: "out",
        text: t!.text,
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
      t.text += e.chunk;
      t.status = "streaming";
    } else if (e.type === "tool-event") {
      const t = ensureTurn(bufKey(event.instanceId, e.sessionAlias));
      const idx = t.toolSteps.findIndex((s) => s.toolCallId === e.step.toolCallId);
      if (idx >= 0) t.toolSteps[idx] = e.step; else t.toolSteps.push(e.step);
    } else if (e.type === "turn-thought") {
      ensureTurn(bufKey(event.instanceId, e.sessionAlias)).reasoning += e.chunk;
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

  return { instanceId, sessionAlias, messages, streaming, liveTurn, busy, unread, sessionAttention, sending, error, select, loadHistory, applyEvent, send, cancel };
});
