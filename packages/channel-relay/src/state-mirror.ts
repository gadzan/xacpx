// Connector-side mirror of the hub's per-instance runtime state (running turns,
// last-known usage / commands, turns that finished while the hub was unreachable).
// It sees the exact ControlEventDto stream forwarded to the hub, so on (re)connect
// the connector can push one `instance.state.sync` snapshot and the hub can recover
// running turns, meters and hints without any replay of business events.
//
// Everything here is bounded: per-turn text caps at STATE_SYNC_TEXT_CAP (then marked
// `truncated`), tool steps / reasoning cap at the hub's own limits (the caps are
// shared constants from the relay protocol), and the finished-while-offline FIFO
// drops its oldest entries past FINISHED_OFFLINE_MAX — a daemon left running against
// a long-dead hub must never leak memory.
import { randomUUID } from "node:crypto";

import {
  MAX_TOOL_STEPS,
  MSG,
  REASONING_CAP,
  STATE_SYNC_PARTS_CAP,
  STATE_SYNC_TEXT_CAP,
  type AgentCommandDto,
  type ControlEventDto,
  type InstanceEventPayload,
  type InstanceStateSyncPayload,
  type ScheduledOriginDto,
  type ToolStepDto,
  type TurnPartDto,
  type UsageBreakdownDto,
  type UsageCostDto,
} from "@ganglion/xacpx-relay-protocol";
import type { AppLogger } from "xacpx/plugin-api";

// Max turns retained as "finished while the hub was unreachable".
const FINISHED_OFFLINE_MAX = 32;

interface MirrorTurn {
  chatKey: string;
  prompt?: string;
  scheduled?: ScheduledOriginDto;
  queueItemId?: string;
  /** Stamped locally when the connector first saw `turn-started`, so a sync
   *  restores the ORIGINAL start time on the hub after a restart. */
  startedAt: number;
  text: string;
  reasoning: string;
  steps: Map<string, ToolStepDto>;
  parts: TurnPartDto[];
  truncated: boolean;
  recoveryId: string;
}

interface FinishedOfflineTurn {
  chatKey: string;
  sessionAlias: string;
  ok: boolean;
  errorMessage?: string;
  cancelled?: boolean;
  text?: string;
  /** The turn's prompt, retained so the hub can backfill the `in` row for turns
   *  that started during the outage (its answer must not be an orphan in history). */
  prompt?: string;
  /** The connector capped this turn's text at STATE_SYNC_TEXT_CAP; the hub must
   *  persist the flag so the recovered reply is not mistaken for a complete one. */
  truncated?: boolean;
  recoveryId: string;
}

export interface StateMirror {
  /** Consume one envelope the forwarder is about to send; non-instanceEvent types are ignored. */
  handleEnvelope(type: string, payload: unknown): string | undefined;
  /** Distinct chatKeys seen on mirrored events (used to resolve the live session list). */
  chatKeys(): string[];
  /** All session aliases mirrored for one chatKey (fallback keep-set when the live
   *  session list cannot be read — never prune what we cannot verify). */
  aliasesForChatKey(chatKey: string): string[];
  /** Snapshot for `instance.state.sync`. SIDE EFFECT: aliases absent from
   *  `liveAliases` are pruned from the mirror permanently (sessions removed while
   *  offline must not ship ghost state) — building the payload mutates the mirror,
   *  which is why the method is named `take` rather than `build`. */
  takeStateSync(liveAliases: ReadonlySet<string>): InstanceStateSyncPayload;
  /** Retire only the completed turns whose frames were confirmed flushed. */
  confirmFinished(recoveryIds: Iterable<string>): void;
}

export interface StateMirrorDeps {
  /** @deprecated Delivery is confirmed by send callbacks, never socket readiness. */
  isReady?: () => boolean;
  logger?: Pick<AppLogger, "warn">;
  /** Test seam for turn start timestamps. */
  now?: () => number;
  recoveryId?: () => string;
}

export function createStateMirror(deps: StateMirrorDeps): StateMirror {
  const now = deps.now ?? (() => Date.now());
  const recoveryId = deps.recoveryId ?? randomUUID;
  const turns = new Map<string, MirrorTurn>();
  const usage = new Map<string, { chatKey: string; used: number; size: number; cost?: UsageCostDto; breakdown?: UsageBreakdownDto }>();
  const commands = new Map<string, { chatKey: string; commands: AgentCommandDto[] }>();
  const finishedOffline: FinishedOfflineTurn[] = [];

  const pushTextPart = (turn: MirrorTurn, chunk: string): void => {
    if (!chunk) return;
    const last = turn.parts[turn.parts.length - 1];
    if (last?.type === "text") last.text += chunk;
    else if (turn.parts.length < STATE_SYNC_PARTS_CAP) turn.parts.push({ type: "text", text: chunk });
  };
  const pushReasoningPart = (turn: MirrorTurn, chunk: string): void => {
    if (!chunk.trim()) return;
    const last = turn.parts[turn.parts.length - 1];
    if (last?.type === "reasoning") last.text += chunk;
    else if (turn.parts.length < STATE_SYNC_PARTS_CAP) turn.parts.push({ type: "reasoning", text: chunk });
  };
  const pushToolPart = (turn: MirrorTurn, step: ToolStepDto): void => {
    const index = turn.parts.findIndex((part) => part.type === "tool" && part.step.toolCallId === step.toolCallId);
    if (index >= 0) (turn.parts[index] as Extract<TurnPartDto, { type: "tool" }>).step = step;
    else if (turn.parts.length < STATE_SYNC_PARTS_CAP) turn.parts.push({ type: "tool", step });
  };

  const handle = (event: ControlEventDto): string | undefined => {
    switch (event.type) {
      case "turn-started":
        turns.set(event.sessionAlias, {
          chatKey: event.chatKey,
          startedAt: now(),
          text: "",
          reasoning: "",
          steps: new Map(),
          parts: [],
          truncated: false,
          recoveryId: recoveryId(),
          ...(event.prompt !== undefined ? { prompt: event.prompt } : {}),
          ...(event.scheduled ? { scheduled: event.scheduled } : {}),
          ...(event.queueItemId ? { queueItemId: event.queueItemId } : {}),
        });
        return;
      case "turn-output": {
        const a = turns.get(event.sessionAlias);
        if (!a || a.truncated) return;
        const accepted = event.chunk.slice(0, STATE_SYNC_TEXT_CAP - a.text.length);
        a.text += accepted;
        pushTextPart(a, accepted);
        if (accepted.length < event.chunk.length) {
          a.truncated = true;
        }
        return;
      }
      case "tool-event": {
        const a = turns.get(event.sessionAlias);
        if (a && (a.steps.has(event.step.toolCallId) || a.steps.size < MAX_TOOL_STEPS)) {
          a.steps.set(event.step.toolCallId, event.step);
          pushToolPart(a, event.step);
        }
        return;
      }
      case "turn-thought": {
        const a = turns.get(event.sessionAlias);
        if (a) {
          const accepted = event.chunk.slice(0, REASONING_CAP - a.reasoning.length);
          a.reasoning += accepted;
          pushReasoningPart(a, accepted);
        }
        return;
      }
      case "turn-usage":
        usage.set(event.sessionAlias, {
          chatKey: event.chatKey, used: event.used, size: event.size,
          ...(event.cost ? { cost: event.cost } : {}),
          ...(event.breakdown ? { breakdown: event.breakdown } : {}),
        });
        return;
      case "agent-commands":
        commands.set(event.sessionAlias, { chatKey: event.chatKey, commands: event.commands });
        return;
      case "turn-finished": {
        const a = turns.get(event.sessionAlias);
        turns.delete(event.sessionAlias);
        const id = a?.recoveryId ?? recoveryId();
        // Carry the reply text only when it is real. The accumulator's `text`
        // starts as "" — a FAILED turn with no streamed output must surface its
        // errorMessage on the hub instead of an empty out row, so it ships no
        // `text` at all. A successful turn keeps its (possibly empty) reply:
        // an empty reply is still a reply on the hub.
        const text = a?.text ?? event.text;
        const hasText = (text !== undefined && text !== "")
          || (event.ok && (a !== undefined || event.text !== undefined));
        finishedOffline.push({
          chatKey: a?.chatKey ?? event.chatKey,
          sessionAlias: event.sessionAlias,
          ok: event.ok,
          ...(event.errorMessage !== undefined ? { errorMessage: event.errorMessage } : {}),
          ...(event.cancelled !== undefined ? { cancelled: event.cancelled } : {}),
          ...(hasText ? { text: text ?? "" } : {}),
          ...(a?.prompt !== undefined ? { prompt: a.prompt } : {}),
          ...(a?.truncated ? { truncated: true } : {}),
          recoveryId: id,
        });
        if (finishedOffline.length > FINISHED_OFFLINE_MAX) {
          finishedOffline.shift();
          void deps.logger?.warn(
            "relay.state_mirror.finished_offline_evicted",
            "evicted oldest finished-offline turn; relay mirror FIFO is full",
            { limit: FINISHED_OFFLINE_MAX },
          );
        }
        return id;
      }
      default:
        return;
    }
  };

  return {
    handleEnvelope(type, payload) {
      if (type !== MSG.instanceEvent) return;
      const event = (payload as InstanceEventPayload | undefined)?.event;
      if (event && typeof event === "object" && typeof (event as { type?: unknown }).type === "string") {
        return handle(event);
      }
    },
    chatKeys() {
      const out = new Set<string>();
      for (const a of turns.values()) out.add(a.chatKey);
      for (const u of usage.values()) out.add(u.chatKey);
      for (const c of commands.values()) out.add(c.chatKey);
      for (const f of finishedOffline) out.add(f.chatKey);
      return [...out];
    },
    aliasesForChatKey(chatKey) {
      const out = new Set<string>();
      for (const [alias, a] of turns) if (a.chatKey === chatKey) out.add(alias);
      for (const [alias, u] of usage) if (u.chatKey === chatKey) out.add(alias);
      for (const [alias, c] of commands) if (c.chatKey === chatKey) out.add(alias);
      for (const f of finishedOffline) if (f.chatKey === chatKey) out.add(f.sessionAlias);
      return [...out];
    },
    takeStateSync(liveAliases) {
      const payload: InstanceStateSyncPayload = {
        turns: [],
        usage: [],
        commands: [],
        finishedOffline: [],
      };
      for (const [alias, a] of turns) {
        if (!liveAliases.has(alias)) { turns.delete(alias); continue; }
        payload.turns.push({
          sessionAlias: alias,
          startedAt: a.startedAt,
          text: a.text,
          reasoning: a.reasoning,
          steps: [...a.steps.values()],
          parts: a.parts,
          ...(a.prompt !== undefined ? { prompt: a.prompt } : {}),
          ...(a.scheduled ? { scheduled: a.scheduled } : {}),
          ...(a.queueItemId ? { queueItemId: a.queueItemId } : {}),
          ...(a.truncated ? { truncated: true } : {}),
        });
      }
      for (const [alias, u] of usage) {
        if (!liveAliases.has(alias)) { usage.delete(alias); continue; }
        payload.usage.push({
          sessionAlias: alias, used: u.used, size: u.size,
          ...(u.cost ? { cost: u.cost } : {}),
          ...(u.breakdown ? { breakdown: u.breakdown } : {}),
        });
      }
      for (const [alias, c] of commands) {
        if (!liveAliases.has(alias)) { commands.delete(alias); continue; }
        payload.commands.push({ sessionAlias: alias, commands: c.commands });
      }
      for (let i = finishedOffline.length - 1; i >= 0; i--) {
        const f = finishedOffline[i]!;
        if (!liveAliases.has(f.sessionAlias)) { finishedOffline.splice(i, 1); continue; }
        payload.finishedOffline.unshift({
          sessionAlias: f.sessionAlias, ok: f.ok,
          ...(f.errorMessage !== undefined ? { errorMessage: f.errorMessage } : {}),
          ...(f.cancelled !== undefined ? { cancelled: f.cancelled } : {}),
          ...(f.text !== undefined ? { text: f.text } : {}),
          ...(f.prompt !== undefined ? { prompt: f.prompt } : {}),
          ...(f.truncated ? { truncated: true } : {}),
          recoveryId: f.recoveryId,
        });
      }
      return payload;
    },
    confirmFinished(recoveryIds) {
      const confirmed = new Set(recoveryIds);
      for (let i = finishedOffline.length - 1; i >= 0; i--) {
        if (confirmed.has(finishedOffline[i]!.recoveryId)) finishedOffline.splice(i, 1);
      }
    },
  };
}
