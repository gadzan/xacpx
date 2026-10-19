import { toolUseEventToStepDto } from "@ganglion/xacpx-relay-protocol";
import type { PlanEntryDto, ToolStepDto } from "@ganglion/xacpx-relay-protocol";
import type { PlanEntry, ToolUseEvent } from "../channels/types";
import type { ControlEvent, ControlEventBus } from "../control/control-event-bus";
import type { ConversationTurnCorrelation } from "../control/conversation-control-dtos";
import { ConversationError } from "./conversation-error";
import type { ConversationStore } from "./conversation-store";
import type { MemberTurnTraceInputEvent } from "./member-turn-trace";
import type { AppState } from "../state/types";

/** Bounded recorder input for one physical Group MemberTurn stream. */
export interface GroupMemberTraceRecorderInput {
  store: ConversationStore;
  state: AppState;
  events: ControlEventBus;
  now?: () => string;
  onError?: (error: unknown) => void;
}

interface RecorderIdentity {
  conversationId: string;
  topicId: string;
  runId: string;
  botId: string;
  memberTurnId: string;
  attempt: number;
  sourceTurnId: string;
}

interface PendingStream {
  identity: RecorderIdentity;
  text: string;
  reasoning: string;
  plan: PlanEntryDto[] | undefined;
}

const MAX_TEXT_CHUNK = 32 * 1024;
const MAX_REASONING_CHUNK = 32 * 1024;
const MAX_PLAN_ENTRIES = 200;
const MAX_PLAN_CONTENT = 4 * 1024;
const MAX_BATCH_EVENTS = 64;

function asText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function sanitizePlan(entries: PlanEntry[]): PlanEntryDto[] | undefined {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const sanitized: PlanEntryDto[] = [];
  for (const entry of entries.slice(0, MAX_PLAN_ENTRIES)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { content?: unknown; status?: unknown; priority?: unknown };
    const content = asText(record.content)?.slice(0, MAX_PLAN_CONTENT);
    if (!content || (record.status !== "pending" && record.status !== "in_progress" && record.status !== "completed")) continue;
    const sanitizedEntry: PlanEntryDto = { content, status: record.status };
    if (record.priority === "high" || record.priority === "medium" || record.priority === "low") {
      sanitizedEntry.priority = record.priority;
    }
    sanitized.push(sanitizedEntry);
  }
  return sanitized.length > 0 ? sanitized : undefined;
}

/** Durable recorder for the already-public Group MemberTurn execution surface. */
export class GroupMemberTraceRecorder {
  private readonly store: ConversationStore;
  private readonly state: AppState;
  private readonly events: ControlEventBus;
  private readonly now: () => string;
  private readonly onError?: (error: unknown) => void;
  private readonly pending = new Map<string, PendingStream>();
  private readonly batchIds = new Map<string, number>();
  private active = false;
  private activated = false;
  private readonly unsubscribe: () => void;

  constructor(input: GroupMemberTraceRecorderInput) {
    this.store = input.store;
    this.state = input.state;
    this.events = input.events;
    this.now = input.now ?? (() => new Date().toISOString());
    this.onError = input.onError;
    // Subscribe immediately so the recorder precedes channel/transport observers
    // in ControlEventBus insertion order. The callback stays inert until the
    // daemon holds its consumer lock, so nothing writes before activation.
    this.unsubscribe = this.events.subscribe((event) => {
      if (!this.active) return;
      try {
        this.handle(event);
      } catch (error) {
        this.report(error);
      }
    });
  }

  /** Mark pre-restart recording streams interrupted, then accept live events. */
  activate(): void {
    if (this.activated) return;
    this.activated = true;
    try {
      this.store.traces.activateConsumer(this.now());
    } catch (error) {
      this.report(error);
    }
    this.active = true;
  }

  /** Flush pending public events, then detach. Unclosed recording headers stay
   *  recording until the next consumer activation proves a restart; a clean
   *  shutdown must not rewrite them as interrupted. Dispatcher drain already
   *  ran before this hook, so pending events belong to complete work. Trace
   *  recording state still changes only on a committed terminal marker. */
  dispose(): void {
    this.active = false;
    const pending = [...this.pending.values()];
    this.pending.clear();
    this.batchIds.clear();
    try {
      for (const stream of pending) {
        this.flushText(stream.identity, stream, this.now());
      }
    } finally {
      try {
        this.unsubscribe();
      } catch {
        // Dispose must not throw; shutdown still closes SQLite below.
      }
    }
  }

  private report(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // Reporting must never throw back into agent execution.
    }
  }

  private handle(event: ControlEvent): void {
    switch (event.type) {
      case "turn-started":
        this.handleStart(event.conversation);
        return;
      case "turn-output":
        this.appendText(event.conversation, event.chunk, "text");
        return;
      case "turn-thought":
        this.appendText(event.conversation, event.chunk, "reasoning");
        return;
      case "tool-event":
        this.appendTool(event.conversation, event.event);
        return;
      case "plan":
        this.appendPlan(event.conversation, event.entries);
        return;
      case "turn-finished":
        this.finish(event.conversation, event.ok, event.cancelled, event.errorMessage);
        return;
      default:
        return;
    }
  }

  private identity(correlation: ConversationTurnCorrelation | undefined): RecorderIdentity | undefined {
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
      || member.attempt !== correlation.attempt || member.sourceTurnId !== correlation.sourceTurnId) {
      return undefined;
    }
    return {
      conversationId: run.conversationId, topicId: run.topicId, runId: run.id,
      botId: member.botId, memberTurnId: member.id, attempt: member.attempt,
      sourceTurnId: member.sourceTurnId ?? correlation.sourceTurnId,
    };
  }

  private keyFor(identity: Pick<RecorderIdentity, "memberTurnId" | "attempt">): string {
    return `${identity.memberTurnId}:${identity.attempt}`;
  }

  private nextBatchId(identity: Pick<RecorderIdentity, "memberTurnId" | "attempt">): string {
    const key = this.keyFor(identity);
    const next = (this.batchIds.get(key) ?? 0) + 1;
    this.batchIds.set(key, next);
    return `${key}:${next}`;
  }

  private pendingFor(identity: RecorderIdentity): PendingStream {
    const key = this.keyFor(identity);
    let stream = this.pending.get(key);
    if (!stream) {
      stream = { identity, text: "", reasoning: "", plan: undefined };
      this.pending.set(key, stream);
    } else {
      stream.identity = identity;
    }
    return stream;
  }

  private write(identity: RecorderIdentity, events: MemberTurnTraceInputEvent[]): void {
    try {
      this.store.traces.appendBatch(identity, this.nextBatchId(identity), events);
    } catch (error) {
      if (error instanceof ConversationError && error.code === "trace_event_too_large") {
        try {
          this.store.traces.interrupt(identity, "trace_event_too_large", this.now());
        } catch {
          // Fall through to error reporting below.
        }
      }
      this.report(error);
    }
  }

  private flushText(identity: RecorderIdentity, stream: PendingStream, createdAt: string): void {
    const events: MemberTurnTraceInputEvent[] = [];
    if (stream.text) {
      const text = stream.text;
      stream.text = "";
      for (let offset = 0; offset < text.length; offset += MAX_TEXT_CHUNK) {
        events.push({ kind: "text", payload: { text: text.slice(offset, offset + MAX_TEXT_CHUNK) }, createdAt });
        if (events.length >= MAX_BATCH_EVENTS) {
          this.write(identity, events.splice(0, events.length));
        }
      }
    }
    if (stream.reasoning) {
      const reasoning = stream.reasoning;
      stream.reasoning = "";
      for (let offset = 0; offset < reasoning.length; offset += MAX_REASONING_CHUNK) {
        events.push({ kind: "reasoning", payload: { text: reasoning.slice(offset, offset + MAX_REASONING_CHUNK) }, createdAt });
        if (events.length >= MAX_BATCH_EVENTS) {
          this.write(identity, events.splice(0, events.length));
        }
      }
    }
    if (events.length > 0) this.write(identity, events);
  }

  private handleStart(correlation: ConversationTurnCorrelation | undefined): void {
    const identity = this.identity(correlation);
    if (!identity) return;
    try {
      this.store.traces.appendBatch(identity, this.nextBatchId(identity), []);
    } catch (error) {
      this.report(error);
    }
  }

  private appendText(correlation: ConversationTurnCorrelation | undefined, chunk: string, kind: "text" | "reasoning"): void {
    const identity = this.identity(correlation);
    const text = asText(chunk);
    if (!identity || !text) return;
    const stream = this.pendingFor(identity);
    if (kind === "text") stream.text += text;
    else stream.reasoning += text;
    if (stream.text.length + stream.reasoning.length >= MAX_TEXT_CHUNK) {
      this.flushText(identity, stream, this.now());
    }
  }

  private appendTool(correlation: ConversationTurnCorrelation | undefined, event: ToolUseEvent): void {
    const identity = this.identity(correlation);
    if (!identity) return;
    let step: ToolStepDto;
    try {
      step = toolUseEventToStepDto(event);
    } catch (error) {
      this.report(error);
      return;
    }
    const stream = this.pendingFor(identity);
    this.flushText(identity, stream, this.now());
    this.write(identity, [{ kind: "tool", payload: { step }, createdAt: this.now() }]);
  }

  private appendPlan(correlation: ConversationTurnCorrelation | undefined, entries: PlanEntry[]): void {
    const identity = this.identity(correlation);
    if (!identity) return;
    const plan = sanitizePlan(entries);
    if (!plan) return;
    const stream = this.pendingFor(identity);
    this.flushText(identity, stream, this.now());
    stream.plan = plan;
    this.write(identity, [{ kind: "plan", payload: { entries: plan }, createdAt: this.now() }]);
  }

  private finish(correlation: ConversationTurnCorrelation | undefined, ok: boolean, cancelled: boolean | undefined, errorMessage: string | undefined): void {
    const identity = this.identity(correlation);
    if (!identity) return;
    const stream = this.pendingFor(identity);
    this.flushText(identity, stream, this.now());
    const createdAt = this.now();
    // Streamed tool frames flush synchronously before turn-finished already;
    // writing the accepted terminal marker here keeps the durable reader from
    // ever observing a complete trace whose final event was not committed.
    this.write(identity, [{
      kind: "terminal",
      payload: {
        ok,
        ...(cancelled !== undefined ? { cancelled } : {}),
        ...(errorMessage !== undefined ? { errorMessage: errorMessage.slice(0, 4000) } : {}),
      },
      createdAt,
    }]);
    this.pending.delete(this.keyFor(identity));
  }
}
