import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { serve, type ServerType } from "@hono/node-server";
import { WebSocketServer } from "ws";

import {
  MAX_TOOL_STEPS, MSG, REASONING_CAP, STATE_SYNC_PARTS_CAP, STATE_SYNC_TEXT_CAP,
  type AgentCommandDto, type ControlEventDto, type InstanceEventPayload, type InstanceNoticePayload, type InstanceStateSyncPayload, type LiveTurnSnapshotDto, type RelayEnvelope,
  type InstanceStateSnapshotDto, type SessionCommandsSnapshotDto, type SessionUsageSnapshotDto, type ToolStepDto, type TurnPartDto, type UsageBreakdownDto, type UsageCostDto,
  validControlEvent, validInstanceStateSync,
} from "@ganglion/xacpx-relay-protocol";

import { createSqlDriver, initSchema, type SqlDriver } from "./db.js";
import { AccountStore } from "./stores/accounts.js";
import { InstanceStore } from "./stores/instances.js";
import { MessageStore } from "./stores/messages.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, InstanceGateway } from "./gateway/instance-gateway.js";
import { WebGateway } from "./gateway/web-gateway.js";
import { handleWebClientMessage } from "./gateway/web-inbound.js";
import { createApp } from "./http/app.js";
import { createRelayUpdateChecker, readRelayVersion } from "./version.js";
import { startMaintenanceLoop } from "./maintenance.js";
import { createNoopRelayLogger, type RelayLogger } from "./logging.js";

const MAX_MESSAGES_PER_SESSION = 2000;
const WEB_CLIENT_MAX_PAYLOAD_BYTES = 256 * 1024;
// Per-string bound on tool-step / seeded-history content entering the turn buffer. Full
// file diffs or command output can reach megabytes; everything buffered is broadcast,
// snapshotted and persisted into the message's `structured` column, then served 100
// rows per history page. Compliant connectors already cap at 8000/4000 chars
// (tool-presentation.ts) — this is defence in depth against non-conforming connectors.
// Counted in UTF-16 code units (string.length), not bytes.
const TOOL_DETAIL_CAP = 32 * 1024;
// Bound on the hub-side in-memory set of finishedOffline fingerprints persisted via
// `instance.state.sync` (see the dedup logic in the sync handler). 32 turns is the
// connector FIFO's max, so a few restarts' worth fits comfortably.
const RECOVERY_FINGERPRINTS_MAX = 128;

const capText = (s: string): string => (s.length > TOOL_DETAIL_CAP ? `${s.slice(0, TOOL_DETAIL_CAP)}…` : s);

function hasOversizedString(value: unknown): boolean {
  if (typeof value === "string") return value.length > TOOL_DETAIL_CAP;
  if (Array.isArray(value)) return value.some(hasOversizedString);
  if (value !== null && typeof value === "object") return Object.values(value).some(hasOversizedString);
  return false;
}

function capDeep<T>(value: T): T {
  if (typeof value === "string") return capText(value) as T;
  if (Array.isArray(value)) return value.map(capDeep) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = capDeep(v);
    return out as T;
  }
  return value;
}

/** Returns the step with every oversized string truncated — title, error, and all
 *  detail variants (diff texts, command/search output, read preview, fields, …) —
 *  or the original step when everything already fits (the common case: no copies
 *  on the hot path). Deep-generic so future detail variants are covered by default. */
export function capToolStep(step: ToolStepDto): ToolStepDto {
  return hasOversizedString(step) ? capDeep(step) : step;
}

/** Same bound for a session-history seed's `structured` payload (toolSteps / parts /
 *  reasoning), which enters the DB without passing through the turn buffer. */
export function capSeededStructured<T>(structured: T): T {
  return hasOversizedString(structured) ? capDeep(structured) : structured;
}

function capSyncedParts(parts: TurnPartDto[]): TurnPartDto[] {
  let textRemaining = STATE_SYNC_TEXT_CAP;
  let reasoningRemaining = REASONING_CAP;
  let toolCount = 0;
  const out: TurnPartDto[] = [];
  for (const part of parts.slice(0, STATE_SYNC_PARTS_CAP)) {
    if (part.type === "text") {
      const text = part.text.slice(0, textRemaining);
      textRemaining -= text.length;
      if (text) out.push({ type: "text", text });
    } else if (part.type === "reasoning") {
      const text = part.text.slice(0, reasoningRemaining);
      reasoningRemaining -= text.length;
      if (text.trim()) out.push({ type: "reasoning", text });
    } else if (toolCount < MAX_TOOL_STEPS) {
      out.push({ type: "tool", step: capToolStep(part.step) });
      toolCount += 1;
    }
  }
  return out;
}

export interface RelayRuntime {
  db: SqlDriver;
  accounts: AccountStore;
  instances: InstanceStore;
  messages: MessageStore;
  gateway: InstanceGateway;
  webGateway: WebGateway;
  stateSnapshot(instanceId: string): InstanceStateSnapshotDto;
  app: ReturnType<typeof createApp>;
  close(): void;
}

export interface CreateRuntimeOptions {
  webRoot?: string;
  historyRetentionDays?: number;
  requestTimeoutMs?: number;
  trustProxy?: boolean;
  logger?: RelayLogger;
}

/** Testable assembly without any network listener. */
export async function createRelayRuntime(dbPath: string, options: CreateRuntimeOptions = {}): Promise<RelayRuntime> {
  const db = await createSqlDriver(dbPath);
  initSchema(db);
  const logger = options.logger ?? createNoopRelayLogger();
  const accounts = new AccountStore(db);
  const instances = new InstanceStore(db);
  const messages = new MessageStore(db);
  const webGateway = new WebGateway({ logger });

  // Accumulate streaming turn state per (instance, session); flush to history on finish.
  // `parts` records text / reasoning / tool events in arrival order so the web can
  // replay history inline (same model the live view builds). `steps`/`reasoning`/`text`
  // remain for the flat fallback + the persisted `text` column.
  interface TurnAccumulator { text: string; steps: Map<string, ToolStepDto>; reasoning: string; parts: TurnPartDto[]; startedAt: number }
  const turnBuffers = new Map<string, TurnAccumulator>();
  const key = (instanceId: string, alias: string) => `${instanceId}\0${alias}`;
  // Content fingerprints (`instanceId, alias, prompt, outText`) of finishedOffline
  // entries this runtime has already persisted from an `instance.state.sync`. A sync
  // is re-sent whenever the previous send wasn't confirmed, and this set makes the
  // redelivery exactly idempotent while a DIFFERENT turn that happens to produce the
  // same reply is still persisted. Bounded FIFO (insertion order) — see
  // RECOVERY_FINGERPRINTS_MAX.
  const recoveredFingerprints = new Set<string>();
  const rememberFingerprint = (fingerprint: string) => {
    recoveredFingerprints.add(fingerprint);
    if (recoveredFingerprints.size > RECOVERY_FINGERPRINTS_MAX) {
      recoveredFingerprints.delete(recoveredFingerprints.values().next().value!);
    }
  };
  const hasRecoveryReceipt = (instanceId: string, recoveryId: string): boolean =>
    db.get("SELECT 1 AS found FROM recovery_receipts WHERE instance_id = ? AND recovery_id = ?", [instanceId, recoveryId]) !== undefined;
  const rememberRecoveryReceipt = (instanceId: string, recoveryId: string): void => {
    db.run("INSERT OR IGNORE INTO recovery_receipts (instance_id, recovery_id, created_at) VALUES (?,?,?)", [instanceId, recoveryId, new Date().toISOString()]);
  };
  // Latest context-usage meter per (instance, session). Unlike turnBuffers this is
  // session-scoped — it survives turn-finished (replace-latest) so a (re)connecting web
  // client can restore the usage bar after a refresh (see GET /api/active-turns). Cleared
  // when the instance goes offline. Absent for agents/sessions that never report usage.
  interface UsageSnapshot { used: number; size: number; cost?: UsageCostDto; breakdown?: UsageBreakdownDto }
  const sessionUsage = new Map<string, UsageSnapshot>();
  const listSessionUsage = (instanceId: string): SessionUsageSnapshotDto[] => {
    const prefix = `${instanceId}\0`;
    const out: SessionUsageSnapshotDto[] = [];
    for (const [k, u] of sessionUsage) {
      if (!k.startsWith(prefix)) continue;
      out.push({ instanceId, sessionAlias: k.slice(prefix.length), used: u.used, size: u.size, ...(u.cost ? { cost: u.cost } : {}), ...(u.breakdown ? { breakdown: u.breakdown } : {}) });
    }
    return out;
  };
  // Latest agent-advertised slash commands per (instance, session). Like sessionUsage this
  // is session-scoped (replace-latest) so a (re)connecting web client can restore the
  // composer's "/" command hints after a refresh (see GET /api/active-turns). Agents
  // typically advertise once at session start, so without this the hints vanish on reload.
  // Cleared when the instance goes offline. Absent for sessions that advertised none.
  const sessionCommands = new Map<string, AgentCommandDto[]>();
  const listSessionCommands = (instanceId: string): SessionCommandsSnapshotDto[] => {
    const prefix = `${instanceId}\0`;
    const out: SessionCommandsSnapshotDto[] = [];
    for (const [k, commands] of sessionCommands) {
      if (!k.startsWith(prefix)) continue;
      out.push({ instanceId, sessionAlias: k.slice(prefix.length), commands });
    }
    return out;
  };
  // Snapshot the in-flight turns for one instance so a (re)connecting web client can
  // rebuild the live view after a refresh (see GET /api/active-turns). `parts` is the
  // live array — fine to hand out by reference since the route serializes it at once.
  const listActiveTurns = (instanceId: string): LiveTurnSnapshotDto[] => {
    const prefix = `${instanceId}\0`;
    const out: LiveTurnSnapshotDto[] = [];
    for (const [k, a] of turnBuffers) {
      if (!k.startsWith(prefix)) continue;
      out.push({
        instanceId,
        sessionAlias: k.slice(prefix.length),
        parts: a.parts,
        status: a.text ? "streaming" : "working",
        startedAt: a.startedAt,
      });
    }
    return out;
  };
  const stateSnapshot = (instanceId: string): InstanceStateSnapshotDto => ({
    turns: listActiveTurns(instanceId),
    usage: listSessionUsage(instanceId),
    commands: listSessionCommands(instanceId),
  });
  // Coalescing appenders — consecutive same-type chunks merge into one part.
  const pushTextPart = (a: TurnAccumulator, chunk: string) => {
    const last = a.parts[a.parts.length - 1];
    if (last?.type === "text") last.text += chunk;
    else a.parts.push({ type: "text", text: chunk });
  };
  const pushReasoningPart = (a: TurnAccumulator, chunk: string) => {
    const last = a.parts[a.parts.length - 1];
    if (last?.type === "reasoning") { last.text = (last.text + chunk).slice(0, REASONING_CAP); return; }
    // Don't open a reasoning part on a blank chunk: some models stream empty/whitespace
    // thought deltas, which would persist as an empty reasoning block in replayed history.
    if (!chunk.trim()) return;
    a.parts.push({ type: "reasoning", text: chunk.slice(0, REASONING_CAP) });
  };
  const pushToolPart = (a: TurnAccumulator, step: ToolStepDto) => {
    const i = a.parts.findIndex((p) => p.type === "tool" && p.step.toolCallId === step.toolCallId);
    if (i >= 0) (a.parts[i] as Extract<TurnPartDto, { type: "tool" }>).step = step;
    else a.parts.push({ type: "tool", step });
  };

  const gateway = new InstanceGateway({
    instances,
    accounts,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    logger,
    onStatusChange: (instanceId, accountId, online) => {
      if (!online) {
        const prefix = `${instanceId}\0`;
        for (const k of turnBuffers.keys()) if (k.startsWith(prefix)) turnBuffers.delete(k);
        for (const k of sessionUsage.keys()) if (k.startsWith(prefix)) sessionUsage.delete(k);
        for (const k of sessionCommands.keys()) if (k.startsWith(prefix)) sessionCommands.delete(k);
      }
      webGateway.broadcast(accountId, { kind: "instance-status", instanceId, online });
    },
    onEvent: (instanceId, accountId, envelope: RelayEnvelope) => {
      // Wraps the whole handler (not just messages.append): a throwing DB write must be
      // attributed to this instance's event persistence, not surface as the gateway's
      // generic relay.instance.message_failed (see instance-gateway's outer message guard).
      try {
        if (envelope.type === MSG.instanceEvent) {
          const raw = (envelope.payload as InstanceEventPayload | undefined)?.event;
          if (!validControlEvent(raw)) {
            // A malformed event from a buggy/hostile connector must not broadcast to
            // browsers or seed history. Drop it; log type + instanceId only (no payload).
            logger.debug("relay.event.invalid", "dropped malformed instance event", {
              instanceId,
              eventType: typeof raw === "object" && raw !== null ? String((raw as { type?: unknown }).type) : "(none)",
            });
            return;
          }
          // Cap oversized tool steps BEFORE broadcast so the live view and the
          // persisted history stay byte-identical, and an oversized event from a
          // non-conforming connector isn't fanned out untruncated to every browser.
          const event = ((): ControlEventDto => {
            const e = raw as ControlEventDto;
            return e.type === "tool-event" ? { ...e, step: capToolStep(e.step) } : e;
          })();
          webGateway.broadcast(accountId, { kind: "control-event", instanceId, event });
          if (event.type === "turn-started") {
            turnBuffers.set(key(instanceId, event.sessionAlias), { text: "", steps: new Map(), reasoning: "", parts: [], startedAt: Date.now() });
            if (event.queueItemId) {
              // A Web prompt was persisted at enqueue time; move that same row to its
              // actual execution point. Other origins have no HTTP row, so fall back to
              // the prompt carried by the event and reconcile if the HTTP response raced.
              const correlation = { instanceId, sessionAlias: event.sessionAlias, queueItemId: event.queueItemId };
              const promoted = messages.promoteQueued(correlation);
              if (!promoted && event.prompt) {
                messages.appendQueuedFallback(correlation, event.prompt);
              }
            } else if (event.prompt) {
              // Scheduled turns have no enqueue-time HTTP request; persist their prompt
              // directly when execution starts.
              messages.append(instanceId, event.sessionAlias, "in", event.prompt, event.scheduled ? { scheduled: event.scheduled } : undefined);
            }
          } else if (event.type === "turn-output") {
            // Only append to an existing buffer; never lazily resurrect one. A buffer
            // is created solely by turn-started, so a stray streaming event arriving
            // after an offline sweep (or with no turn-started) is dropped instead of
            // leaking a buffer that no turn-finished will ever clear.
            const a = turnBuffers.get(key(instanceId, event.sessionAlias));
            if (a) { a.text += event.chunk; pushTextPart(a, event.chunk); }
          } else if (event.type === "tool-event") {
            const a = turnBuffers.get(key(instanceId, event.sessionAlias));
            if (a && (a.steps.has(event.step.toolCallId) || a.steps.size < MAX_TOOL_STEPS)) {
              // Already capped before broadcast above.
              a.steps.set(event.step.toolCallId, event.step);
              pushToolPart(a, event.step);
            }
          } else if (event.type === "turn-thought") {
            const a = turnBuffers.get(key(instanceId, event.sessionAlias));
            if (a) { a.reasoning = (a.reasoning + event.chunk).slice(0, REASONING_CAP); pushReasoningPart(a, event.chunk); }
          } else if (event.type === "turn-finished") {
            const k = key(instanceId, event.sessionAlias);
            const a = turnBuffers.get(k);
            turnBuffers.delete(k);
            if (!a) {
              // No buffer (e.g. hub restarted mid-turn and the offline sweep dropped it).
              // The daemon carries the final reply text on turn-finished so the answer
              // can still land in history instead of leaving a prompt with no reply.
              // Presence (not truthiness): an empty-string reply is still a reply.
              if (event.text !== undefined) {
                messages.append(instanceId, event.sessionAlias, "out", event.text);
              } else {
                logger.warn("relay.event.turn_finished_without_content", "turn finished with no buffered content", {
                  instanceId, sessionAlias: event.sessionAlias,
                });
              }
              if (event.recoveryId) rememberRecoveryReceipt(instanceId, event.recoveryId);
              return;
            }
            const steps = [...a.steps.values()];
            // Treat whitespace-only reasoning as absent: it would otherwise persist as an
            // empty `structured.reasoning` and render as a blank reasoning panel in history.
            const hasReasoning = a.reasoning.trim().length > 0;
            const hasStructured = steps.length > 0 || hasReasoning;
            if (a.text || hasStructured) {
              const structured = hasStructured
                ? { toolSteps: steps, ...(hasReasoning ? { reasoning: a.reasoning } : {}), ...(a.parts.length ? { parts: a.parts } : {}) }
                : undefined;
              messages.append(instanceId, event.sessionAlias, "out", a.text, structured);
            }
            if (event.recoveryId) rememberRecoveryReceipt(instanceId, event.recoveryId);
          } else if (event.type === "turn-usage") {
            // Retain the latest usage per session (replace) so a refreshed web client can
            // restore the context-usage bar from the active-turns snapshot. Already
            // broadcast above; this is the persistence the snapshot reads back.
            sessionUsage.set(key(instanceId, event.sessionAlias), { used: event.used, size: event.size, ...(event.cost ? { cost: event.cost } : {}), ...(event.breakdown ? { breakdown: event.breakdown } : {}) });
          } else if (event.type === "agent-commands") {
            // Retain the latest advertised command list per session (replace) so a refreshed
            // web client can restore the composer's "/" hints from the active-turns snapshot.
            // Already broadcast above; this is the persistence the snapshot reads back.
            sessionCommands.set(key(instanceId, event.sessionAlias), event.commands);
          } else if (event.type === "session-history") {
            // Seed a freshly-attached native session's recovered prior conversation into
            // history (one-time). Guard against re-seeding an already-populated session so a
            // redelivered event can't duplicate the backlog.
            const existing = messages.listBySession(accountId, instanceId, event.sessionAlias, { limit: 1 });
            if (existing.messages.length === 0) {
              for (const row of event.messages) {
                messages.append(instanceId, event.sessionAlias, row.direction, row.text, row.structured ? capSeededStructured(row.structured) : row.structured);
              }
            }
          }
        } else if (envelope.type === MSG.instanceStateSync) {
          if (!validInstanceStateSync(envelope.payload)) {
            // Malformed sync from a buggy/hostile connector: drop it and leave this
            // instance's in-memory state untouched (same posture as relay.event.invalid).
            logger.debug("relay.event.invalid", "dropped malformed instance state sync", { instanceId });
            return;
          }
          const sync = envelope.payload as InstanceStateSyncPayload;
          // Replace, don't merge: the connector's mirror is authoritative for this
          // instance, and a re-sent sync must reconcile without duplicating entries.
          const prefix = `${instanceId}\0`;
          for (const k of turnBuffers.keys()) if (k.startsWith(prefix)) turnBuffers.delete(k);
          for (const k of sessionUsage.keys()) if (k.startsWith(prefix)) sessionUsage.delete(k);
          for (const k of sessionCommands.keys()) if (k.startsWith(prefix)) sessionCommands.delete(k);
          // Recency guards against duplicate persists. A sync is re-sent whenever the
          // previous send wasn't confirmed (or the connector simply reconnects again),
          // so blind appends would duplicate transcript rows. The last few rows are
          // enough precision: a recovered prompt/answer is always among the newest
          // entries in its session when the sync lands.
          const recentRows = (sessionAlias: string) =>
            messages.listBySession(accountId, instanceId, sessionAlias, { limit: 5 }).messages;
          const hasRecentRow = (sessionAlias: string, direction: "in" | "out", text: string): boolean =>
            recentRows(sessionAlias).some((m) => m.direction === direction && m.text === text);
          const hasTrailingPrompt = (sessionAlias: string, prompt: string): boolean => {
            const rows = recentRows(sessionAlias);
            const last = rows[rows.length - 1];
            return last?.direction === "in" && last.text === prompt;
          };
          // Pair matching for the finishedOffline out row: a previous sync persists a
          // recovered turn as an adjacent `in`(prompt) → `out`(reply) pair, so matching
          // the PAIR means two different turns that happen to produce identical reply
          // text ("ok", "/status" output, …) are NOT deduped into each other the way a
          // bare text match would — only an actual redelivery matches.
          const hasRecentTurnPair = (sessionAlias: string, prompt: string, outText: string): boolean => {
            const rows = recentRows(sessionAlias);
            for (let i = 0; i + 1 < rows.length; i++) {
              const cur = rows[i]!;
              const next = rows[i + 1]!;
              if (cur.direction === "in" && cur.text === prompt && next.direction === "out" && next.text === outText) return true;
            }
            return false;
          };
          for (const turn of sync.turns) {
            const text = turn.text.slice(0, STATE_SYNC_TEXT_CAP);
            const reasoning = turn.reasoning.slice(0, REASONING_CAP);
            const steps = turn.steps.slice(0, MAX_TOOL_STEPS).map(capToolStep);
            // The mirror ships flat text/reasoning/steps; rebuild the ordered `parts`
            // so snapshot and flush treat this identically to a live accumulator —
            // subsequent turn-output/tool-event appends and turn-finished flush keep
            // working unchanged (text last, as it postdates activity in live order).
            const parts: TurnPartDto[] = turn.parts
              ? capSyncedParts(turn.parts)
              : steps.map((step) => ({ type: "tool", step }));
            if (!turn.parts) {
              if (reasoning.trim()) parts.push({ type: "reasoning", text: reasoning });
              if (text) parts.push({ type: "text", text });
            }
            // Backfill the prompt for a turn that STARTED while the hub was down:
            // the live path persists it at turn-started, which this hub never saw.
            // A prompt persisted before the restart is found by the recency check.
            if (turn.prompt && !hasTrailingPrompt(turn.sessionAlias, turn.prompt)) {
              messages.append(instanceId, turn.sessionAlias, "in", turn.prompt, turn.scheduled ? { scheduled: turn.scheduled } : undefined);
            }
            turnBuffers.set(key(instanceId, turn.sessionAlias), {
              text,
              steps: new Map(steps.map((s) => [s.toolCallId, s])),
              reasoning,
              parts,
              // Restored original start so the elapsed-time HUD survives the restart.
              startedAt: turn.startedAt,
            });
          }
          for (const meter of sync.usage) {
            sessionUsage.set(key(instanceId, meter.sessionAlias), { used: meter.used, size: meter.size, ...(meter.cost ? { cost: meter.cost } : {}), ...(meter.breakdown ? { breakdown: meter.breakdown } : {}) });
          }
          for (const entry of sync.commands) {
            sessionCommands.set(key(instanceId, entry.sessionAlias), entry.commands);
          }
          // Turns that finished while the hub was unreachable: persist an out row
          // mirroring the turn-finished flush (reply text; error text for failed
          // turns), deduped so a re-sent sync can't duplicate them. Dedup order:
          // 1. in-memory fingerprint — exact redelivery to this SAME hub process
          //    (unconfirmed flush, extra reconnect) is dropped unconditionally,
          //    while a genuinely different turn with identical content still lands;
          // 2. SQLite recency fallback for a redelivery that crosses ANOTHER hub
          //    restart (fingerprint set died with the process) — pair-matched so a
          //    coincidence of reply text alone never suppresses a real turn.
          // A carried prompt is backfilled FIRST so the recovered answer never
          // shows as an orphan in history. Skip an alias ALSO listed in `turns` — a
          // contradictory payload means that turn is live again and will flush
          // normally. No web broadcast: browsers re-reconcile from state-snapshot
          // on their own reconnect.
          const syncedTurnAliases = new Set(sync.turns.map((t) => t.sessionAlias));
          for (const finished of sync.finishedOffline) {
            if (syncedTurnAliases.has(finished.sessionAlias)) continue;
            const text = finished.text ?? (!finished.ok ? finished.errorMessage : undefined);
            if (finished.recoveryId && hasRecoveryReceipt(instanceId, finished.recoveryId)) continue;
            const fingerprint = `${instanceId}\0${finished.sessionAlias}\0${finished.prompt ?? ""}\0${text ?? ""}`;
            if (!finished.recoveryId && recoveredFingerprints.has(fingerprint)) continue;
            const alreadyPersisted = !finished.recoveryId && text !== undefined
              ? finished.prompt !== undefined
                ? hasRecentTurnPair(finished.sessionAlias, finished.prompt, text)
                : hasRecentRow(finished.sessionAlias, "out", text)
              : false;
            if (!alreadyPersisted && finished.prompt && !hasTrailingPrompt(finished.sessionAlias, finished.prompt)) {
              messages.append(instanceId, finished.sessionAlias, "in", finished.prompt);
            }
            // Presence (not truthiness): an empty-string reply still gets its row.
            if (text !== undefined) {
              if (!alreadyPersisted) {
                messages.append(instanceId, finished.sessionAlias, "out", text);
              }
            }
            if (finished.recoveryId) {
              rememberRecoveryReceipt(instanceId, finished.recoveryId);
            } else {
              rememberFingerprint(fingerprint);
            }
          }
          webGateway.broadcast(accountId, { kind: "state-snapshot", instanceId, ...stateSnapshot(instanceId) });
        } else if (envelope.type === MSG.instanceNotice) {
          webGateway.broadcast(accountId, { kind: "notice", instanceId, notice: envelope.payload as InstanceNoticePayload });
        }
      } catch (err) {
        logger.error("relay.event.persist_failed", "failed to persist instance event", { instanceId, error: String(err) });
      }
    },
  });

  const app = createApp({
    accounts, instances, messages, gateway, webRoot: options.webRoot,
    historyRetentionDays: options.historyRetentionDays ?? 30,
    maxMessagesPerSession: MAX_MESSAGES_PER_SESSION,
    activeTurns: listActiveTurns,
    sessionUsage: listSessionUsage,
    sessionCommands: listSessionCommands,
    trustProxy: options.trustProxy,
    checkUpdate: createRelayUpdateChecker({ current: readRelayVersion() }),
    logger,
  });
  return { db, accounts, instances, messages, gateway, webGateway, stateSnapshot, app, close: () => db.close() };
}

export interface StartRelayOptions {
  dbPath: string;
  httpPort: number;
  /**
   * Dedicated instance-gateway port (legacy two-port layout). Omit (default) to
   * merge the gateway onto the HTTP port: connectors then reach it via a WS
   * upgrade at `/` or `/gateway`, so a single port + domain serves everything.
   */
  wsPort?: number;
  host?: string;
  webRoot?: string;
  historyRetentionDays?: number;
  requestTimeoutMs?: number;
  trustProxy?: boolean;
  logger?: RelayLogger;
}

export interface RunningRelay {
  runtime: RelayRuntime;
  httpPort: number;
  /** The dedicated gateway port, or `null` when the gateway is merged onto the HTTP port. */
  wsPort: number | null;
  close(): Promise<void>;
}

export async function startRelayServer(options: StartRelayOptions): Promise<RunningRelay> {
  const runtime = await createRelayRuntime(options.dbPath, {
    webRoot: options.webRoot,
    historyRetentionDays: options.historyRetentionDays,
    requestTimeoutMs: options.requestTimeoutMs,
    trustProxy: options.trustProxy,
    logger: options.logger,
  });
  const host = options.host ?? "0.0.0.0";

  const retention = { historyRetentionDays: options.historyRetentionDays ?? 30, maxPerSession: MAX_MESSAGES_PER_SESSION };
  const stopMaintenance = startMaintenanceLoop(
    { accounts: runtime.accounts, instances: runtime.instances, messages: runtime.messages },
    retention,
    60 * 60 * 1000,
  );

  // serve() returns the server synchronously; listeningListener fires when bound.
  const httpServer: ServerType = await new Promise((resolve, reject) => {
    let server: ServerType;
    try {
      server = serve(
        { fetch: runtime.app.fetch, port: options.httpPort, hostname: host },
        () => resolve(server),
      );
    } catch (err) {
      reject(err);
    }
  });

  // Default (merged): the instance gateway shares the HTTP port, handled as a
  // noServer WS upgrade alongside the dashboard's `/ws`. Passing `wsPort` opts
  // into the legacy dedicated-port layout (e.g. to firewall the gateway apart).
  const dedicated = options.wsPort !== undefined;
  let wss: WebSocketServer | undefined;
  let gatewayWss: WebSocketServer | undefined;
  if (dedicated) {
    wss = new WebSocketServer({ port: options.wsPort, host });
    await new Promise<void>((resolve) => wss!.on("listening", () => resolve()));
    wss.on("connection", (socket) => runtime.gateway.handleConnection(socket));
  } else {
    gatewayWss = new WebSocketServer({ noServer: true });
  }

  // Browser upstream frames are small control/terminal messages. Bound them so an
  // authenticated client cannot force ws to buffer an arbitrarily large subscribe
  // array or terminal paste before protocol validation runs.
  const webWss = new WebSocketServer({ noServer: true, maxPayload: WEB_CLIENT_MAX_PAYLOAD_BYTES });
  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/ws") {
      const token = parseCookie(req.headers.cookie ?? "")["xrelay_session"];
      const account = token ? runtime.accounts.getSessionAccount(token) : null;
      if (!account) { socket.destroy(); return; }
      webWss.handleUpgrade(req, socket, head, (ws) => {
        runtime.webGateway.register(account.id, ws);
        ws.on("message", (data: unknown) => handleWebClientMessage({
          instances: runtime.instances,
          gateway: runtime.gateway,
          webGateway: runtime.webGateway,
          stateSnapshot: runtime.stateSnapshot,
        }, account.id, ws, String(data)));
      });
      return;
    }
    // Merged gateway: connectors dial the bare host (root) or an explicit
    // `/gateway`. Auth is the gateway's own token/credential handshake, so no
    // cookie gate here. In dedicated mode `gatewayWss` is undefined → reject.
    if (gatewayWss && (path === "/" || path === "/gateway" || path.startsWith("/gateway/"))) {
      gatewayWss.handleUpgrade(req, socket, head, (ws) => runtime.gateway.handleConnection(ws));
      return;
    }
    socket.destroy();
  });

  const httpPort = (httpServer.address() as { port: number }).port;
  const wsPort = wss ? (wss.address() as { port: number }).port : null;
  return {
    runtime,
    httpPort,
    wsPort,
    close: async () => {
      stopMaintenance();
      await new Promise<void>((resolve) => webWss.close(() => resolve()));
      if (gatewayWss) await new Promise<void>((resolve) => gatewayWss!.close(() => resolve()));
      if (wss) await new Promise<void>((resolve) => wss!.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      runtime.close();
    },
  };
}

function parseCookie(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
