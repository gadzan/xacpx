// Connector-side mirror of the hub's per-instance runtime state (running turns,
// last-known usage / commands, and turns that finished but are still awaiting the
// hub's persistence ack). It sees the exact ControlEventDto stream forwarded to the
// hub, so on (re)connect the connector can push one `instance.state.sync` snapshot
// and the hub can recover running turns, meters and hints without any replay of
// business events.
//
// Everything here is bounded: per-turn text caps at STATE_SYNC_TEXT_CAP (then marked
// `truncated`), tool steps / reasoning cap at the hub's own limits (the caps are
// shared constants from the relay protocol), and the pending-finish FIFO drops its
// oldest entries past PENDING_FINISHED_MAX — a daemon left running against a
// long-dead hub must never leak memory.
import { randomUUID } from "node:crypto";

import {
  MAX_TOOL_STEPS,
  MSG,
  REASONING_CAP,
  RECOVERY_RETENTION_MS,
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

// Max turns retained as "finished but not yet acked by the hub" (whether the turn
// finished during an outage or live — a live finish also waits for its persistence
// ack before it can be dropped).
const PENDING_FINISHED_MAX = 32;

interface MirrorTurn {
  chatKey: string;
  prompt?: string;
  scheduled?: ScheduledOriginDto;
  queueItemId?: string;
  /** Hub-issued pre-write correlation (PromptPayload.promptRequestId); carried into
   *  the sync so the hub can tie the turn back to its pre-written inbound row. */
  promptRequestId?: string;
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

interface PendingFinishedTurn {
  chatKey: string;
  sessionAlias: string;
  ok: boolean;
  errorMessage?: string;
  cancelled?: boolean;
  text?: string;
  /** The turn's prompt, retained so the hub can backfill the `in` row for turns
   *  that started during the outage (its answer must not be an orphan in history). */
  prompt?: string;
  /** Queue/schedule origin, so the hub reconciles the queued `in` row (promote,
   *  not duplicate) exactly like the live path. */
  queueItemId?: string;
  scheduled?: ScheduledOriginDto;
  /** Hub-issued pre-write correlation (see MirrorTurn.promptRequestId). */
  promptRequestId?: string;
  /** The connector capped this turn's text at STATE_SYNC_TEXT_CAP; the hub must
   *  persist the flag so the recovered reply is not mistaken for a complete one. */
  truncated?: boolean;
  recoveryId: string;
  /** Local timestamp when the turn finished. Drives expiry (expirePendingFinished):
   *  past RECOVERY_RETENTION_MS the entry is dropped — the hub prunes its receipt on
   *  the same horizon, so an expired entry can never be re-delivered into a duplicate. */
  createdAt: number;
}

export interface StateMirror {
  /** Consume one envelope the forwarder is about to send; non-instanceEvent types are ignored. */
  handleEnvelope(type: string, payload: unknown): string | undefined;
  /** Distinct chatKeys seen on mirrored events (used to resolve the live session list). */
  chatKeys(): string[];
  /** All session aliases mirrored for one chatKey (fallback keep-set when the live
   *  session list cannot be read — never prune what we cannot verify). */
  aliasesForChatKey(chatKey: string): string[];
  /** Snapshot for `instance.state.sync` — a PURE copy: builds the payload with only
   *  aliases present in `liveAliases`, mutates nothing. Returns the payload plus the
   *  per-alias generation that existed at build time, so a later `pruneStateMirror`
   *  can compare-and-delete ONLY entries whose generation is unchanged — state that
   *  arrived (or a SAME alias that was re-created / produced new entries) after the
   *  snapshot is never GC'd by an older callback. Pruning itself is a separate,
   *  explicit step so a failed/aborted send can never destroy mirror state that a
   *  later sync might still need. */
  buildStateSync(liveAliases: ReadonlySet<string>): { snapshot: InstanceStateSyncPayload; aliases: ReadonlyMap<string, number> };
  /** Remove mirror state for aliases present at the LAST build (`aliasesAtBuild`,
   *  alias → generation) that are absent from `liveAliases` — BUT only when the
   *  alias's generation is unchanged since the build: a same-alias turn that was
   *  re-created or produced a new pending entry after the snapshot belongs to a newer
   *  generation and must not be GC'd by this older callback. Call only after the sync
   *  frame was CONFIRMED flushed — never on a failed/not-ready send, so a
   *  transiently-stale session list cannot discard state for a session that still
   *  exists. */
  pruneStateMirror(liveAliases: ReadonlySet<string>, aliasesAtBuild: ReadonlyMap<string, number>): void;
  /** Drop pendingFinished entries older than RECOVERY_RETENTION_MS. Call before
   *  building a sync so a stale entry can never ride it: the hub prunes its receipt
   *  on the same horizon, so an expired entry re-delivered after a long idle would
   *  re-append a duplicate reply. (Entries the hub never persisted are lost here by
   *  design — same accepted-loss posture as FIFO eviction.) */
  expirePendingFinished(): void;
  /** Retire pending-finished entries whose recovery ids the hub has ACKED (after its
   *  SQLite commit). No ack → the entry rides the next sync and is deduped by the
   *  hub's receipt. */
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
  const pendingFinished: PendingFinishedTurn[] = [];
  // Per-alias mutation generation. `buildStateSync` records each alias's generation
  // with the snapshot; `pruneStateMirror` only deletes an alias when its generation is
  // UNCHANGED since the build — a same-alias turn re-created or finished after the
  // snapshot belongs to a newer generation and must never be GC'd by an older prune.
  const gen = new Map<string, number>();
  const bump = (alias: string): void => {
    gen.set(alias, (gen.get(alias) ?? 0) + 1);
  };

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
  // Drop pendingFinished entries past the shared retention horizon (see
  // RECOVERY_RETENTION_MS). Called on every push AND by the channel before each sync,
  // so a stale entry can never ride a sync into a duplicate.
  const expirePendingFinished = (): void => {
    const cutoff = now() - RECOVERY_RETENTION_MS;
    let expired = 0;
    for (let i = pendingFinished.length - 1; i >= 0; i--) {
      if (pendingFinished[i]!.createdAt < cutoff) {
        bump(pendingFinished[i]!.sessionAlias);
        pendingFinished.splice(i, 1);
        expired += 1;
      }
    }
    if (expired > 0) {
      void deps.logger?.warn(
        "relay.state_mirror.pending_finished_expired",
        "dropped finished turns past the recovery retention window; the hub's receipts for them have expired too",
        { count: expired, retentionMs: RECOVERY_RETENTION_MS },
      );
    }
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
          ...(event.promptRequestId !== undefined ? { promptRequestId: event.promptRequestId } : {}),
        });
        bump(event.sessionAlias);
        return;
      case "turn-output": {
        const a = turns.get(event.sessionAlias);
        if (!a || a.truncated) return;
        const accepted = event.chunk.slice(0, STATE_SYNC_TEXT_CAP - a.text.length);
        a.text += accepted;
        pushTextPart(a, accepted);
        // Bump on the state change even when no text was accepted: a chunk arriving
        // exactly at the cap flips `truncated` false → true with accepted === "" —
        // the generation must reflect that change or an older prune callback could
        // still consider the alias unchanged and delete it.
        const wasTruncated = a.truncated;
        if (accepted.length < event.chunk.length) {
          a.truncated = true;
        }
        if (accepted || a.truncated !== wasTruncated) bump(event.sessionAlias);
        return;
      }
      case "tool-event": {
        const a = turns.get(event.sessionAlias);
        if (a && (a.steps.has(event.step.toolCallId) || a.steps.size < MAX_TOOL_STEPS)) {
          a.steps.set(event.step.toolCallId, event.step);
          pushToolPart(a, event.step);
          bump(event.sessionAlias);
        }
        return;
      }
      case "turn-thought": {
        const a = turns.get(event.sessionAlias);
        if (a) {
          const accepted = event.chunk.slice(0, REASONING_CAP - a.reasoning.length);
          a.reasoning += accepted;
          pushReasoningPart(a, accepted);
          if (accepted) bump(event.sessionAlias);
        }
        return;
      }
      case "turn-usage":
        usage.set(event.sessionAlias, {
          chatKey: event.chatKey, used: event.used, size: event.size,
          ...(event.cost ? { cost: event.cost } : {}),
          ...(event.breakdown ? { breakdown: event.breakdown } : {}),
        });
        bump(event.sessionAlias);
        return;
      case "agent-commands":
        commands.set(event.sessionAlias, { chatKey: event.chatKey, commands: event.commands });
        bump(event.sessionAlias);
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
        pendingFinished.push({
          chatKey: a?.chatKey ?? event.chatKey,
          sessionAlias: event.sessionAlias,
          ok: event.ok,
          ...(event.errorMessage !== undefined ? { errorMessage: event.errorMessage } : {}),
          ...(event.cancelled !== undefined ? { cancelled: event.cancelled } : {}),
          ...(hasText ? { text: text ?? "" } : {}),
          ...(a?.prompt !== undefined ? { prompt: a.prompt } : {}),
          ...(a?.queueItemId !== undefined ? { queueItemId: a.queueItemId } : {}),
          ...(a?.scheduled ? { scheduled: a.scheduled } : {}),
          ...(a?.promptRequestId !== undefined ? { promptRequestId: a.promptRequestId } : {}),
          ...(a?.truncated ? { truncated: true } : {}),
          recoveryId: id,
          createdAt: now(),
        });
        expirePendingFinished();
        bump(event.sessionAlias);
        if (pendingFinished.length > PENDING_FINISHED_MAX) {
          pendingFinished.shift();
          void deps.logger?.warn(
            "relay.state_mirror.pending_finished_evicted",
            "evicted oldest pending-finished turn; relay mirror FIFO is full",
            { limit: PENDING_FINISHED_MAX },
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
      for (const f of pendingFinished) out.add(f.chatKey);
      return [...out];
    },
    aliasesForChatKey(chatKey) {
      const out = new Set<string>();
      for (const [alias, a] of turns) if (a.chatKey === chatKey) out.add(alias);
      for (const [alias, u] of usage) if (u.chatKey === chatKey) out.add(alias);
      for (const [alias, c] of commands) if (c.chatKey === chatKey) out.add(alias);
      for (const f of pendingFinished) if (f.chatKey === chatKey) out.add(f.sessionAlias);
      return [...out];
    },
    buildStateSync(liveAliases) {
      const payload: InstanceStateSyncPayload = {
        turns: [],
        usage: [],
        commands: [],
        finishedOffline: [],
      };
      const aliases = new Map<string, number>();
      for (const [alias, a] of turns) {
        aliases.set(alias, gen.get(alias) ?? 0);
        if (!liveAliases.has(alias)) continue;
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
          ...(a.promptRequestId !== undefined ? { promptRequestId: a.promptRequestId } : {}),
          ...(a.truncated ? { truncated: true } : {}),
          recoveryId: a.recoveryId,
        });
      }
      for (const [alias, u] of usage) {
        aliases.set(alias, gen.get(alias) ?? 0);
        if (!liveAliases.has(alias)) continue;
        payload.usage.push({
          sessionAlias: alias, used: u.used, size: u.size,
          ...(u.cost ? { cost: u.cost } : {}),
          ...(u.breakdown ? { breakdown: u.breakdown } : {}),
        });
      }
      for (const [alias, c] of commands) {
        aliases.set(alias, gen.get(alias) ?? 0);
        if (!liveAliases.has(alias)) continue;
        payload.commands.push({ sessionAlias: alias, commands: c.commands });
      }
      for (let i = pendingFinished.length - 1; i >= 0; i--) {
        const f = pendingFinished[i]!;
        aliases.set(f.sessionAlias, gen.get(f.sessionAlias) ?? 0);
        if (!liveAliases.has(f.sessionAlias)) continue;
        payload.finishedOffline.unshift({
          sessionAlias: f.sessionAlias, ok: f.ok,
          ...(f.errorMessage !== undefined ? { errorMessage: f.errorMessage } : {}),
          ...(f.cancelled !== undefined ? { cancelled: f.cancelled } : {}),
          ...(f.text !== undefined ? { text: f.text } : {}),
          ...(f.prompt !== undefined ? { prompt: f.prompt } : {}),
          ...(f.queueItemId !== undefined ? { queueItemId: f.queueItemId } : {}),
          ...(f.scheduled ? { scheduled: f.scheduled } : {}),
          ...(f.promptRequestId !== undefined ? { promptRequestId: f.promptRequestId } : {}),
          ...(f.truncated ? { truncated: true } : {}),
          recoveryId: f.recoveryId,
        });
      }
      return { snapshot: payload, aliases };
    },
    pruneStateMirror(liveAliases, aliasesAtBuild) {
      // Compare-and-delete against the per-alias generations recorded when the
      // snapshot was built: state that arrived AFTER the build (a new session/turn
      // forwarded live, OR a SAME alias re-created / producing a new pending entry
      // while this sync frame was in flight) has bumped the alias's generation and is
      // left untouched — only an alias whose generation is unchanged since the build
      // and is absent from the live list is GC'd.
      for (const [alias, genAtBuild] of aliasesAtBuild) {
        if (liveAliases.has(alias)) continue;
        if ((gen.get(alias) ?? 0) !== genAtBuild) continue;
        turns.delete(alias);
        usage.delete(alias);
        commands.delete(alias);
        for (let i = pendingFinished.length - 1; i >= 0; i--) {
          if (pendingFinished[i]!.sessionAlias === alias) pendingFinished.splice(i, 1);
        }
      }
    },
    expirePendingFinished,
    confirmFinished(recoveryIds) {
      const confirmed = new Set(recoveryIds);
      for (let i = pendingFinished.length - 1; i >= 0; i--) {
        if (confirmed.has(pendingFinished[i]!.recoveryId)) {
          bump(pendingFinished[i]!.sessionAlias);
          pendingFinished.splice(i, 1);
        }
      }
    },
  };
}
