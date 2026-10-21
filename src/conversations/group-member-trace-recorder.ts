import { randomUUID } from "node:crypto";
import { toolUseEventToStepDto } from "@ganglion/xacpx-relay-protocol";
import type { PlanEntryDto } from "@ganglion/xacpx-relay-protocol";
import type { PlanEntry, ToolUseEvent } from "../channels/types";
import type { ControlEvent, ControlEventBus } from "../control/control-event-bus";
import type { ConversationTurnCorrelation } from "../control/conversation-control-dtos";
import { ConversationError } from "./conversation-error";
import type { ConversationStore } from "./conversation-store";
import type { MemberTurnTraceIdentity, MemberTurnTraceInputEvent } from "./member-turn-trace";
import type { AppState } from "../state/types";

/** Records only the already-public provider events of observed Group turns. */
export interface GroupMemberTraceRecorderInput {
  store: ConversationStore;
  state: AppState;
  events: ControlEventBus;
  now?: () => string;
  onError?: (error: unknown) => void;
}

interface PendingStream {
  identity: MemberTurnTraceIdentity;
  events: MemberTurnTraceInputEvent[];
  bytes: number;
}

const MAX_EVENT_BYTES = 128 * 1024;
const MAX_BATCH_BYTES = 256 * 1024;
const MAX_BATCH_EVENTS = 64;
const MAX_ACTIVE_STREAMS = 128;
// Even JSON-escaped control characters occupy at most six bytes per code unit.
const TEXT_CHUNK_LENGTH = 16 * 1024;
const FLUSH_INTERVAL_MS = 25;

function publicPlan(entries: PlanEntry[]): PlanEntryDto[] {
  if (!Array.isArray(entries) || entries.length > 200) {
    throw new ConversationError("trace_plan_invalid", "trace plan exceeds its public bound");
  }
  return entries.map((entry) => {
    if (!entry || typeof entry.content !== "string" || entry.content.length > 4 * 1024
      || (entry.status !== "pending" && entry.status !== "in_progress" && entry.status !== "completed")) {
      throw new ConversationError("trace_plan_invalid", "trace plan cannot be recorded without loss");
    }
    const result: PlanEntryDto = { content: entry.content, status: entry.status };
    if (entry.priority === "high" || entry.priority === "medium" || entry.priority === "low") {
      result.priority = entry.priority;
    }
    return result;
  });
}

export class GroupMemberTraceRecorder {
  private readonly store: ConversationStore;
  private readonly state: AppState;
  private readonly now: () => string;
  private readonly onError?: (error: unknown) => void;
  private readonly streams = new Map<string, PendingStream>();
  private readonly batchPrefix = randomUUID();
  private batchNumber = 0;
  private timer: NodeJS.Timeout | undefined;
  private active = false;
  private activated = false;
  private acceptingStarts = true;
  private readonly unsubscribe: () => void;

  constructor(input: GroupMemberTraceRecorderInput) {
    this.store = input.store;
    this.state = input.state;
    this.now = input.now ?? (() => new Date().toISOString());
    this.onError = input.onError;
    this.unsubscribe = input.events.subscribe((event) => {
      if (!this.active) return;
      try {
        this.handle(event);
      } catch (error) {
        // An unexpected recorder error must never let later events claim completeness.
        this.acceptingStarts = false;
        for (const stream of this.streams.values()) this.fail(stream, error);
        this.report(error);
      }
    });
  }

  activate(): void {
    if (this.activated) return;
    this.activated = true;
    try {
      this.store.traces.activateConsumer(this.now());
      this.active = true;
    } catch (error) {
      this.report(error);
    }
  }

  /** Called before SQLite closes; commit buffered events before interrupting open turns. */
  dispose(): void {
    this.active = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    try {
      for (const stream of this.streams.values()) {
        if (this.flush(stream)) this.fail(stream, new ConversationError("recorder_disposed", "trace ended before its terminal event"));
      }
    } catch (error) {
      this.report(error);
    } finally {
      this.streams.clear();
      try {
        this.unsubscribe();
      } catch (error) {
        this.report(error);
      }
    }
  }

  private report(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // Recorder diagnostics cannot affect the provider turn or shutdown.
    }
  }

  private identity(correlation: ConversationTurnCorrelation | undefined): MemberTurnTraceIdentity | undefined {
    if (!correlation || correlation.attempt === undefined || !correlation.sourceTurnId) return undefined;
    if (!Number.isSafeInteger(correlation.attempt) || correlation.attempt < 1) return undefined;
    const conversation = this.state.conversations[correlation.conversationId];
    if (!conversation || conversation.kind !== "group") return undefined;
    const topic = this.state.conversation_topics[correlation.topicId];
    if (!topic || topic.conversationId !== correlation.conversationId || topic.peerScope) return undefined;
    const run = this.store.getRun(correlation.runId);
    if (!run || run.conversationId !== correlation.conversationId || run.topicId !== correlation.topicId) return undefined;
    const member = this.store.getMemberTurn(correlation.memberTurnId);
    if (!member || member.runId !== run.id || member.conversationId !== run.conversationId
      || member.topicId !== run.topicId || member.botId !== correlation.botId
      || member.attempt !== correlation.attempt || member.sourceTurnId !== correlation.sourceTurnId) return undefined;
    return {
      conversationId: run.conversationId, topicId: run.topicId, runId: run.id,
      botId: member.botId, memberTurnId: member.id, attempt: member.attempt,
      sourceTurnId: correlation.sourceTurnId,
    };
  }

  private key(identity: MemberTurnTraceIdentity): string {
    return JSON.stringify([identity.memberTurnId, identity.attempt, identity.sourceTurnId]);
  }

  private stream(correlation: ConversationTurnCorrelation | undefined): PendingStream | undefined {
    const identity = this.identity(correlation);
    return identity ? this.streams.get(this.key(identity)) : undefined;
  }

  private fail(stream: PendingStream, error: unknown): void {
    stream.events = [];
    stream.bytes = 0;
    this.streams.delete(this.key(stream.identity));
    try {
      const interrupted = this.store.traces.interrupt(stream.identity,
        error instanceof ConversationError ? error.code : "trace_write_failed", this.now());
      // If no failure marker landed, a stale physical execution must still lose
      // completeness without a fake terminal; refuse any further recorder starts.
      if (!interrupted && !this.store.traces.closeUnknownIdentity(stream.identity, this.now())) {
        this.acceptingStarts = false;
      }
    } catch (failure) {
      this.acceptingStarts = false;
      this.report(failure);
    }
    if (!(error instanceof ConversationError && error.code === "recorder_disposed")) this.report(error);
  }

  private write(stream: PendingStream, events: MemberTurnTraceInputEvent[]): boolean {
    try {
      if (!this.identity(stream.identity)) {
        throw new ConversationError("trace_identity_mismatch", "trace execution identity changed before flush");
      }
      this.store.traces.appendBatch(stream.identity, `${this.batchPrefix}:${++this.batchNumber}`, events);
      return true;
    } catch (error) {
      this.fail(stream, error);
      return false;
    }
  }

  private flush(stream: PendingStream): boolean {
    if (stream.events.length === 0) return true;
    const events = stream.events;
    stream.events = [];
    stream.bytes = 0;
    return this.write(stream, events);
  }

  private scheduleFlush(): void {
    if (this.timer !== undefined || !this.active) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const stream of this.streams.values()) this.flush(stream);
    }, FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  private enqueue(stream: PendingStream, event: MemberTurnTraceInputEvent): boolean {
    try {
      const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
      if (bytes > MAX_EVENT_BYTES) throw new ConversationError("trace_event_too_large", "trace event exceeds its public bound");
      if (stream.events.length >= MAX_BATCH_EVENTS || stream.bytes + bytes + stream.events.length + 2 > MAX_BATCH_BYTES) {
        if (!this.flush(stream)) return false;
      }
      stream.events.push(event);
      stream.bytes += bytes;
      this.scheduleFlush();
      return true;
    } catch (error) {
      this.fail(stream, error);
      return false;
    }
  }

  private start(correlation: ConversationTurnCorrelation | undefined): void {
    if (!this.acceptingStarts) return;
    const identity = this.identity(correlation);
    if (!identity || this.streams.has(this.key(identity)) || this.store.traces.get(identity)) return;
    const stream: PendingStream = { identity, events: [], bytes: 0 };
    if (this.streams.size >= MAX_ACTIVE_STREAMS) {
      if (this.write(stream, [])) {
        this.fail(stream, new ConversationError("trace_capacity_exceeded", "trace recorder active stream bound reached"));
      }
      return;
    }
    if (this.write(stream, [])) this.streams.set(this.key(identity), stream);
  }

  private appendText(stream: PendingStream, text: string, kind: "text" | "reasoning"): void {
    if (typeof text !== "string") {
      this.fail(stream, new ConversationError("trace_event_invalid", "trace text must be public text"));
      return;
    }
    const createdAt = this.now();
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(offset + TEXT_CHUNK_LENGTH, text.length);
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff
        && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
      const textChunk = text.slice(offset, end);
      const previous = stream.events.at(-1);
      const additionalBytes = Buffer.byteLength(JSON.stringify(textChunk), "utf8") - 2;
      if (previous?.kind === kind && (previous.kind === "text" || previous.kind === "reasoning")
        && previous.payload.text.length + textChunk.length <= TEXT_CHUNK_LENGTH
        && stream.bytes + additionalBytes + stream.events.length + 2 <= MAX_BATCH_BYTES) {
        previous.payload.text += textChunk;
        stream.bytes += additionalBytes;
        offset = end;
        continue;
      }
      if (!this.enqueue(stream, { kind, payload: { text: textChunk }, createdAt })) return;
      offset = end;
    }
  }

  private appendTool(stream: PendingStream, event: ToolUseEvent): void {
    try {
      if (this.enqueue(stream, { kind: "tool", payload: { step: toolUseEventToStepDto(event) }, createdAt: this.now() })) {
        this.flush(stream);
      }
    } catch (error) {
      this.fail(stream, error);
    }
  }

  private handle(event: ControlEvent): void {
    if (event.type === "turn-started") {
      this.start(event.conversation);
      return;
    }
    if (event.type !== "turn-output" && event.type !== "turn-thought" && event.type !== "tool-event"
      && event.type !== "plan" && event.type !== "turn-finished") return;
    const stream = this.stream(event.conversation);
    if (!stream) return;
    switch (event.type) {
      case "turn-output": this.appendText(stream, event.chunk, "text"); return;
      case "turn-thought": this.appendText(stream, event.chunk, "reasoning"); return;
      case "tool-event": this.appendTool(stream, event.event); return;
      case "plan":
        try {
          if (this.enqueue(stream, { kind: "plan", payload: { entries: publicPlan(event.entries) }, createdAt: this.now() })) {
            this.flush(stream);
          }
        } catch (error) {
          this.fail(stream, error);
        }
        return;
      case "turn-finished":
        if (this.enqueue(stream, {
          kind: "terminal",
          payload: {
            ok: event.ok,
            ...(event.cancelled !== undefined ? { cancelled: event.cancelled } : {}),
            ...(event.errorMessage !== undefined ? { errorMessage: event.errorMessage } : {}),
          },
          createdAt: this.now(),
        })) this.flush(stream);
        this.streams.delete(this.key(stream.identity));
    }
  }
}
