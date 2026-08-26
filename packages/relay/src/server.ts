import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { serve, type ServerType } from "@hono/node-server";
import { WebSocketServer } from "ws";

import {
  MAX_TOOL_STEPS, MSG, REASONING_CAP, STATE_SYNC_PARTS_CAP, STATE_SYNC_TEXT_CAP,
  type AgentCommandDto, type ControlEventDto, type InstanceEventPayload, type InstanceNoticePayload, type InstanceRecoveryAckPayload, type InstanceStateSyncPayload, type LiveTurnSnapshotDto, type RelayEnvelope,
  type InstanceStateSnapshotDto, type ScheduledOriginDto, type SessionCommandsSnapshotDto, type SessionUsageSnapshotDto, type ToolStepDto, type TurnPartDto, type UsageBreakdownDto, type UsageCostDto,
  validControlEvent, validInstanceStateSync,
} from "@ganglion/xacpx-relay-protocol";

import { createSqlDriver, initSchema, type SqlDriver } from "./db.js";
import { AccountStore } from "./stores/accounts.js";
import { InstanceStore } from "./stores/instances.js";
import { MessageStore } from "./stores/messages.js";
import { PendingCompletionRouteStore } from "./stores/pending-completion-routes.js";
import { RecoveryReceiptStore } from "./stores/recovery-receipts.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, InstanceGateway } from "./gateway/instance-gateway.js";
import { WebGateway } from "./gateway/web-gateway.js";
import { PushNotifier, vapidFromEnv, validateVapidConfig, type VapidConfig } from "./push.js";
import { PushSubscriptionStore } from "./stores/push-subscriptions.js";
import { handleConnectorTerminalEvent, handleWebClientMessage } from "./gateway/web-inbound.js";
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
  recoveryReceipts: RecoveryReceiptStore;
  pushSubscriptions: PushSubscriptionStore;
  pushNotifier: PushNotifier;
  gateway: InstanceGateway;
  webGateway: WebGateway;
  stateSnapshot(instanceId: string): InstanceStateSnapshotDto;
  app: ReturnType<typeof createApp>;
  pendingWebPromptsCount?(): number;
  close(): void;
}

export interface CreateRuntimeOptions {
  webRoot?: string;
  historyRetentionDays?: number;
  requestTimeoutMs?: number;
  trustProxy?: boolean;
  /** Web push VAPID config; omitted = resolve from env, null = force-disable. */
  vapid?: VapidConfig | null;
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
  let gatewayRef: InstanceGateway | null = null;
  const webGateway = new WebGateway({
    logger,
    onAttachmentDetached: (info) => {
      gatewayRef?.sendEvent(info.instanceId, MSG.terminalDetach, {
        attachmentId: info.attachmentId,
        viewerId: info.viewerId,
      });
    },
  });
  const pushSubscriptions = new PushSubscriptionStore(db);
  // Validate ONCE here; both the notifier and the public-key endpoint use this
  // effective config, so a malformed key downgrades to fully-disabled instead
  // of leaving the browser half-configured against a broken sender.
  const rawVapid = options.vapid !== undefined ? options.vapid : vapidFromEnv(process.env);
  const vapid = validateVapidConfig(rawVapid);
  if (rawVapid && !vapid) {
    logger.warn("relay.push.disabled", "web push disabled: invalid VAPID config (subject must be mailto:/https:, keys must be valid P-256 base64url material)");
  } else if (!vapid) {
    logger.warn("relay.push.disabled", "web push disabled: no VAPID config (XACPX_RELAY_VAPID_* env or --vapid-* flags)");
  }
  const pushNotifier = new PushNotifier({ config: vapid, subscriptions: pushSubscriptions, logger });

  // Accumulate streaming turn state per (instance, session); flush to history on finish.
  // `parts` records text / reasoning / tool events in arrival order so the web can
  // replay history inline (same model the live view builds). `steps`/`reasoning`/`text`
  // remain for the flat fallback + the persisted `text` column. `truncated` rides the
  // state sync: a connector that capped this turn at STATE_SYNC_TEXT_CAP marks it so
  // the final flush persists structured.truncated instead of a silently-gappy reply.
  interface TurnNotificationContext {
    origin: "relay-web";
    promptRequestId: string;
  }
  interface TurnAccumulator {
    text: string;
    steps: Map<string, ToolStepDto>;
    reasoning: string;
    parts: TurnPartDto[];
    startedAt: number;
    truncated?: boolean;
    notification?: TurnNotificationContext;
  }
  const turnBuffers = new Map<string, TurnAccumulator>();
  interface WebPromptGrant {
    instanceId: string;
    sessionAlias: string;
    createdAt: number;
    queueItemId?: string;
    state: "pending" | "active";
  }
  const pendingWebPrompts = new Map<string, WebPromptGrant>();
  const queueItemToPromptRequestId = new Map<string, string>();
  const PENDING_WEB_PROMPTS_MAX = 4096;
  const PENDING_WEB_PROMPT_TTL_MS = 24 * 60 * 60_000;
  const queueKey = (instanceId: string, queueItemId: string) => `${instanceId}\0${queueItemId}`;

  const removePendingWebPrompt = (promptRequestId: string) => {
    const entry = pendingWebPrompts.get(promptRequestId);
    if (entry) {
      if (entry.queueItemId) {
        queueItemToPromptRequestId.delete(queueKey(entry.instanceId, entry.queueItemId));
      }
      pendingWebPrompts.delete(promptRequestId);
    }
  };

  const prunePendingWebPrompts = () => {
    const now = Date.now();
    for (const [id, entry] of pendingWebPrompts) {
      if (entry.state === "pending" && now - entry.createdAt > PENDING_WEB_PROMPT_TTL_MS) {
        removePendingWebPrompt(id);
      }
    }
  };

  const recordPendingWebPrompt = (promptRequestId: string, instanceId: string, sessionAlias: string): boolean => {
    prunePendingWebPrompts();
    while (pendingWebPrompts.size >= PENDING_WEB_PROMPTS_MAX) {
      // Evict oldest pending grant first to protect active turns under load
      let victimId: string | undefined;
      for (const [id, grant] of pendingWebPrompts) {
        if (grant.state === "pending") {
          victimId = id;
          break;
        }
      }
      if (!victimId) {
        logger.warn("relay.web_prompt.capacity_exhausted", "web prompt grant capacity exhausted by active turns", {
          instanceId,
          sessionAlias,
          capacity: PENDING_WEB_PROMPTS_MAX,
        });
        return false;
      }
      removePendingWebPrompt(victimId);
    }
    pendingWebPrompts.set(promptRequestId, {
      instanceId,
      sessionAlias,
      createdAt: Date.now(),
      state: "pending",
    });
    return true;
  };

  const associateQueueItem = (promptRequestId: string, instanceId: string, queueItemId: string) => {
    const entry = pendingWebPrompts.get(promptRequestId);
    if (entry && entry.instanceId === instanceId) {
      entry.queueItemId = queueItemId;
      queueItemToPromptRequestId.set(queueKey(instanceId, queueItemId), promptRequestId);
    }
  };

  const cancelPendingQueueItem = (instanceId: string, queueItemId: string) => {
    const qKey = queueKey(instanceId, queueItemId);
    const promptRequestId = queueItemToPromptRequestId.get(qKey);
    if (promptRequestId) {
      removePendingWebPrompt(promptRequestId);
    }
  };

  const clearPendingForSession = (instanceId: string, sessionAlias: string) => {
    for (const [id, grant] of pendingWebPrompts) {
      if (grant.instanceId === instanceId && grant.sessionAlias === sessionAlias && grant.state === "pending") {
        removePendingWebPrompt(id);
      }
    }
  };
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
  // Cross-restart dedup for recoveryId-carrying finishedOffline entries (see the
  // store's doc comment). Written in the SAME transaction as the message rows it
  // vouches for, so a receipt can never outlive its rows or vice versa.
  const recoveryReceipts = new RecoveryReceiptStore(db);
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

  const pendingCompletionRoutes = new PendingCompletionRouteStore(db);
  const gateway = new InstanceGateway({
    instances,
    accounts,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    logger,
    pendingCompletionRoutes,
    onDirectoryChange: (accountId, endpoints) => {
      webGateway.broadcast(accountId, { kind: "agent-directory", endpoints });
    },
    onStatusChange: (instanceId, accountId, online) => {
      if (!online) {
        const prefix = `${instanceId}\0`;
        for (const k of turnBuffers.keys()) if (k.startsWith(prefix)) turnBuffers.delete(k);
        for (const k of sessionUsage.keys()) if (k.startsWith(prefix)) sessionUsage.delete(k);
        for (const k of sessionCommands.keys()) if (k.startsWith(prefix)) sessionCommands.delete(k);
      }
      webGateway.broadcast(accountId, { kind: "instance-status", instanceId, online });
      webGateway.broadcast(accountId, {
        kind: "agent-directory",
        endpoints: gateway.getWebPublishedEndpoints(accountId),
      });
    },
    onEvent: (instanceId, accountId, envelope: RelayEnvelope) => {
      // Recoverable terminal streams are attachment-targeted and must never enter
      // the SQLite messages / turn accumulator / state-snapshot path (Task 20).
      if (handleConnectorTerminalEvent(webGateway, instanceId, envelope.type, envelope.payload)) {
        return;
      }
      // Shared inbound-prompt reconciliation (live turn-started AND state-sync
      // restore/backfill) — one code path so the two cannot drift apart. See the
      // helper body for the correlation order (queue association first, pre-write
      // correlation only when the row is truly absent).
      const recentRows = (sessionAlias: string) =>
        messages.listBySession(accountId, instanceId, sessionAlias, { limit: 5 }).messages;
      const hasTrailingPrompt = (sessionAlias: string, prompt: string): boolean => {
        const rows = recentRows(sessionAlias);
        const last = rows[rows.length - 1];
        return last?.direction === "in" && last.text === prompt;
      };
      const reconcileInboundPrompt = (
        sessionAlias: string,
        opts: { prompt?: string; queueItemId?: string; scheduled?: ScheduledOriginDto; promptRequestId?: string },
        liveFallback: boolean,
      ): void => {
        if (opts.queueItemId) {
          const correlation = { instanceId, sessionAlias, queueItemId: opts.queueItemId };
          const state = messages.queuedState(correlation);
          if (state === "pending") { messages.promoteQueued(correlation); return; }
          if (state === "fallback") { messages.finalizeQueuedFallback(correlation); return; }
          if (state === "executed") return; // already promoted/finalized — the row exists
          // absent: try the pre-write correlation before fabricating a row
          if (opts.promptRequestId) {
            const rowId = messages.findByPromptRequest(instanceId, sessionAlias, opts.promptRequestId);
            if (rowId !== undefined && messages.promoteQueuedRow(rowId, correlation)) return;
          }
          if (opts.prompt) {
            if (liveFallback) messages.appendQueuedFallback(correlation, opts.prompt);
            else messages.appendExecutedQueuedFallback(correlation, opts.prompt);
          }
          return;
        }
        if (opts.promptRequestId) {
          // Pre-written web prompt with no queue marker: the row already exists — do
          // not duplicate it (the queue response may have been lost entirely).
          if (messages.findByPromptRequest(instanceId, sessionAlias, opts.promptRequestId) !== undefined) return;
        }
        if (opts.prompt !== undefined) {
          if (opts.scheduled && messages.hasScheduledInbound(instanceId, sessionAlias, opts.scheduled.taskId)) return;
          if (!opts.scheduled && hasTrailingPrompt(sessionAlias, opts.prompt)) return;
          messages.append(instanceId, sessionAlias, "in", opts.prompt, opts.scheduled ? { scheduled: opts.scheduled } : undefined);
        }
      };
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
            const k = key(instanceId, event.sessionAlias);
            let notification: TurnNotificationContext | undefined;
            if (typeof event.promptRequestId === "string") {
              const grant = pendingWebPrompts.get(event.promptRequestId);
              if (grant && grant.instanceId === instanceId && grant.sessionAlias === event.sessionAlias) {
                if (!event.scheduled && !event.peerOrigin) {
                  grant.state = "active";
                  grant.createdAt = Date.now();
                  notification = { origin: "relay-web", promptRequestId: event.promptRequestId };
                } else {
                  removePendingWebPrompt(event.promptRequestId);
                }
              }
            }
            // Reconcile the inbound prompt FIRST (queued promotion / pre-write
            // correlation / scheduled append) and only install the streaming buffer
            // once it succeeded. A persistence failure here is NOT silent: it forces a
            // reconnect so the connector re-sends its state sync and the prompt row can
            // land — otherwise the turn would stream + persist its reply while the
            // prompt row is permanently missing (an orphan answer).
            try {
              reconcileInboundPrompt(
                event.sessionAlias,
                { prompt: event.prompt, queueItemId: event.queueItemId, scheduled: event.scheduled, promptRequestId: event.promptRequestId },
                true,
              );
              turnBuffers.set(k, {
                text: "",
                steps: new Map(),
                reasoning: "",
                parts: [],
                startedAt: Date.now(),
                ...(notification ? { notification } : {}),
              });
            } catch (err) {
              turnBuffers.delete(k);
              gateway.disconnect(instanceId);
              throw err;
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
            const promptRequestId = a?.notification?.promptRequestId;
            const flush = (): void => {
              if (!a) {
                // No buffer (e.g. hub restarted mid-turn and the offline sweep dropped it).
                // The daemon carries the final reply text on turn-finished so the answer
                // can still land in history instead of leaving a prompt with no reply.
                // Presence (not truthiness): an empty-string reply is still a reply.
                // A failed turn without a reply text falls back to its errorMessage —
                // an error row closes the hole for failures the same way text does
                // for successes.
                if (event.text !== undefined) {
                  messages.append(instanceId, event.sessionAlias, "out", event.text);
                } else if (!event.ok && event.errorMessage !== undefined) {
                  messages.append(instanceId, event.sessionAlias, "out", event.errorMessage);
                } else {
                  logger.warn("relay.event.turn_finished_without_content", "turn finished with no buffered content", {
                    instanceId, sessionAlias: event.sessionAlias,
                  });
                }
                return;
              }
              const steps = [...a.steps.values()];
              // Treat whitespace-only reasoning as absent: it would otherwise persist as an
              // empty `structured.reasoning` and render as a blank reasoning panel in history.
              const hasReasoning = a.reasoning.trim().length > 0;
              const hasStructured = steps.length > 0 || hasReasoning;
              // Same resolution as the recovered-offline path: streamed text wins; a
              // FAILED turn with no streamed output must surface its errorMessage
              // instead of leaving a prompt with no answer (the exact hole recovery
              // closes for successes).
              const text = a.text || (!event.ok && event.errorMessage !== undefined ? event.errorMessage : a.text);
              // Presence semantics, matching the no-buffer and recovered-offline paths:
              // an empty SUCCESSFUL reply is still a reply and gets its row — a buffered
              // turn that ran and returned nothing must not leave a prompt with no
              // answer (and its receipt is already committed, so the entry can never be
              // re-delivered to backfill it). A failed turn with truly nothing to say
              // still leaves no row.
              if (hasStructured || text !== "" || event.ok) {
                const structured = hasStructured
                  ? { toolSteps: steps, ...(hasReasoning ? { reasoning: a.reasoning } : {}), ...(a.parts.length ? { parts: a.parts } : {}), ...(a.truncated ? { truncated: true } : {}) }
                  : (a.truncated ? { truncated: true } : undefined);
                messages.append(instanceId, event.sessionAlias, "out", text, structured);
              }
            };
            const recoveryId = event.recoveryId;
            if (recoveryId) {
              // Message + receipt must commit as ONE unit: a crash between them would
              // either lose the dedup guard (double-persist on redelivery) or leak a
              // receipt for rows that never landed. The ack goes out ONLY after the
              // commit — confirming on the connector's ws flush would clear its FIFO
              // before the hub actually persisted, leaving a permanent history hole
              // if the hub dies in between.
              try {
                db.transaction(() => {
                  flush();
                  recoveryReceipts.remember(instanceId, recoveryId);
                });
              } catch (err) {
                // The connector only re-sends pending entries on reconnect, so a
                // silent persistence failure would strand this turn in its FIFO until
                // eviction. Force a reconnect: the re-auth pushes a fresh state sync
                // and the entry gets another chance (deduped by receipt if it already
                // landed on a partial write).
                gateway.disconnect(instanceId);
                throw err;
              }
              if (promptRequestId) {
                removePendingWebPrompt(promptRequestId);
              }
              gateway.sendEvent(instanceId, MSG.instanceRecoveryAck, { recoveryIds: [recoveryId] } satisfies InstanceRecoveryAckPayload);
            } else {
              flush();
              if (promptRequestId) {
                removePendingWebPrompt(promptRequestId);
              }
            }
            if (a?.notification?.origin === "relay-web" && !event.peerOrigin && event.cancelled !== true) {
              const instanceName = instances.getOwned(instanceId, accountId)?.name ?? instanceId;
              void pushNotifier.sendTurnCompletion(accountId, {
                instanceId,
                instanceName,
                sessionAlias: event.sessionAlias,
                text: a.text || event.text,
                ok: event.ok,
                errorMessage: event.errorMessage,
              });
            }
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
          } else if (event.type === "agent-message") {
            const updated = messages.updateAgentMessage(
              instanceId,
              event.sessionAlias,
              event.message,
            );
            if (!updated) {
              const direction = event.message.direction === "sent" ? "out" : "in";
              messages.append(
                instanceId,
                event.sessionAlias,
                direction,
                event.message.content,
                { agentMessage: event.message },
                undefined,
                undefined,
                new Date(event.message.createdAt).toISOString(),
              );
            }
          } else if (event.type === "agent-message-completion") {
            // v0.3: completion-status PATCH. Only flips the terminal status on
            // the already-persisted sender card — the durable row's content,
            // peer, conversation and completion mode are never rebuilt here.
            messages.patchAgentMessageCompletionStatus(
              instanceId,
              event.sessionAlias,
              event.messageId,
              event.completionStatus,
            );
          }
        } else if (envelope.type === MSG.instanceStateSync) {
          if (!validInstanceStateSync(envelope.payload)) {
            // Malformed sync from a buggy/hostile connector: drop it and leave this
            // instance's in-memory state untouched (same posture as relay.event.invalid).
            logger.debug("relay.event.invalid", "dropped malformed instance state sync", { instanceId });
            return;
          }
          const sync = envelope.payload as InstanceStateSyncPayload;
          // Recency guards against duplicate persists. A sync is re-sent whenever the
          // previous send wasn't confirmed (or the connector simply reconnects again),
          // so blind appends would duplicate transcript rows. The last few rows are
          // enough precision: a recovered prompt/answer is always among the newest
          // entries in its session when the sync lands.
          const hasRecentRow = (sessionAlias: string, direction: "in" | "out", text: string): boolean =>
            recentRows(sessionAlias).some((m) => m.direction === direction && m.text === text);
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
          // The WHOLE reconciliation is wrapped so ANY database failure — not just the
          // finished-entry transactions — forces a reconnect: the connector only
          // re-sends its state sync on re-auth, so a silent failure would strand the
          // active turn (its prompt row never lands) with no way to retry. Database
          // work happens BEFORE the in-memory replacement, so a failure never leaves
          // half-updated hub state behind.
          try {
            // 1. Finished turns are reconciled FIRST, so their rows land before any
            //    active-turn prompt backfill (message order). A finished entry and a
            //    running turn may share a sessionAlias legitimately (turn A finished
            //    while the queue started turn B on the same session) — they are
            //    distinguished by recoveryId, NOT by alias.
            const activeRecoveryIds = new Set(sync.turns.flatMap((t) => t.recoveryId ? [t.recoveryId] : []));
            // Recovery ids to ack once their (message + receipt) transactions below
            // have all committed — one ack frame, sent after the loop.
            const ackedRecoveryIds: string[] = [];
            for (const finished of sync.finishedOffline) {
              // Truly contradictory (the SAME turn listed as both finished and running):
              // trust the running turn; it will flush normally. Different turns on the
              // same alias are both persisted.
              if (finished.recoveryId && activeRecoveryIds.has(finished.recoveryId)) continue;
              let grant: WebPromptGrant | undefined;
              if (typeof finished.promptRequestId === "string") {
                const g = pendingWebPrompts.get(finished.promptRequestId);
                if (g && g.instanceId === instanceId && g.sessionAlias === finished.sessionAlias) {
                  grant = g;
                }
              }
              // A failed turn with no (or an empty) reply must surface its error text,
              // never an empty out row: the connector's accumulator starts text at ""
              // and a legacy/buggy sync may ship text:"" alongside errorMessage.
              const text = finished.ok
                ? finished.text
                : (finished.text ? finished.text : finished.errorMessage);
              const recoveryId = finished.recoveryId;
              if (recoveryId && recoveryReceipts.has(instanceId, recoveryId)) {
                // Already committed (live flush or a previous sync) but the connector
                // never got the ack — re-ack so its FIFO can finally drop the entry.
                ackedRecoveryIds.push(recoveryId);
                if (grant && finished.promptRequestId) {
                  removePendingWebPrompt(finished.promptRequestId);
                }
                continue;
              }
              const fingerprint = `${instanceId}\0${finished.sessionAlias}\0${finished.prompt ?? ""}\0${text ?? ""}`;
              if (!recoveryId && recoveredFingerprints.has(fingerprint)) {
                if (grant && finished.promptRequestId) {
                  removePendingWebPrompt(finished.promptRequestId);
                }
                continue;
              }
              const alreadyPersisted = !recoveryId && text !== undefined
                ? finished.prompt !== undefined
                  ? hasRecentTurnPair(finished.sessionAlias, finished.prompt, text)
                  : hasRecentRow(finished.sessionAlias, "out", text)
                : false;
              // The reply row(s) and the receipt are written in ONE transaction (the
              // same invariant as the live turn-finished flush): a crash between them
              // would re-append the whole group on redelivery. `truncated` rides the
              // structured metadata so a capped reply never reads as a complete one.
              const persist = (): void => {
                if (!alreadyPersisted) {
                  reconcileInboundPrompt(
                    finished.sessionAlias,
                    {
                      prompt: finished.prompt, queueItemId: finished.queueItemId, scheduled: finished.scheduled, promptRequestId: finished.promptRequestId,
                    },
                    false,
                  );
                }
                // Presence (not truthiness): an empty-string reply still gets its row.
                if (text !== undefined && !alreadyPersisted) {
                  messages.append(instanceId, finished.sessionAlias, "out", text, finished.truncated ? { truncated: true } : undefined);
                }
              };
              if (recoveryId) {
                db.transaction(() => {
                  persist();
                  recoveryReceipts.remember(instanceId, recoveryId);
                });
                ackedRecoveryIds.push(recoveryId);
                if (grant && finished.promptRequestId) {
                  removePendingWebPrompt(finished.promptRequestId);
                }
              } else {
                persist();
                rememberFingerprint(fingerprint);
                if (grant && finished.promptRequestId) {
                  removePendingWebPrompt(finished.promptRequestId);
                }
              }
              if (grant && !finished.scheduled && finished.cancelled !== true) {
                const instanceName = instances.getOwned(instanceId, accountId)?.name ?? instanceId;
                void pushNotifier.sendTurnCompletion(accountId, {
                  instanceId,
                  instanceName,
                  sessionAlias: finished.sessionAlias,
                  text: text,
                  ok: finished.ok,
                  errorMessage: finished.errorMessage,
                });
              }
            }
            if (ackedRecoveryIds.length > 0) {
              gateway.sendEvent(instanceId, MSG.instanceRecoveryAck, { recoveryIds: ackedRecoveryIds } satisfies InstanceRecoveryAckPayload);
            }
            // 2. Active-turn prompt reconciliation (database only) — still before any
            //    in-memory change, so a failure here leaves the OLD hub state intact
            //    and the connector retries the whole sync on reconnect.
            for (const turn of sync.turns) {
              reconcileInboundPrompt(
                turn.sessionAlias,
                { prompt: turn.prompt, queueItemId: turn.queueItemId, scheduled: turn.scheduled, promptRequestId: turn.promptRequestId },
                false,
              );
            }
            // 3. Replace in-memory state now that the DB work committed.
            const prefix = `${instanceId}\0`;
            for (const k of turnBuffers.keys()) if (k.startsWith(prefix)) turnBuffers.delete(k);
            for (const k of sessionUsage.keys()) if (k.startsWith(prefix)) sessionUsage.delete(k);
            for (const k of sessionCommands.keys()) if (k.startsWith(prefix)) sessionCommands.delete(k);
            for (const turn of sync.turns) {
              let notification: TurnNotificationContext | undefined;
              if (!turn.scheduled && typeof turn.promptRequestId === "string") {
                const grant = pendingWebPrompts.get(turn.promptRequestId);
                if (grant && grant.instanceId === instanceId && grant.sessionAlias === turn.sessionAlias) {
                  grant.state = "active";
                  grant.createdAt = Date.now();
                  notification = { origin: "relay-web", promptRequestId: turn.promptRequestId };
                }
              }
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
              turnBuffers.set(key(instanceId, turn.sessionAlias), {
                text,
                steps: new Map(steps.map((s) => [s.toolCallId, s])),
                reasoning,
                parts,
                // Restored original start so the elapsed-time HUD survives the restart.
                startedAt: turn.startedAt,
                // A mirror that capped this turn at STATE_SYNC_TEXT_CAP marks it so the
                // final flush persists structured.truncated instead of a gappy reply
                // that reads as complete.
                ...(turn.truncated ? { truncated: true } : {}),
                ...(notification ? { notification } : {}),
              });
            }
            for (const meter of sync.usage) {
              sessionUsage.set(key(instanceId, meter.sessionAlias), { used: meter.used, size: meter.size, ...(meter.cost ? { cost: meter.cost } : {}), ...(meter.breakdown ? { breakdown: meter.breakdown } : {}) });
            }
            for (const entry of sync.commands) {
              sessionCommands.set(key(instanceId, entry.sessionAlias), entry.commands);
            }
            webGateway.broadcast(accountId, { kind: "state-snapshot", instanceId, ...stateSnapshot(instanceId) });
          } catch (err) {
            // Same posture as the live flush: a persistence failure must never be
            // silent — force a reconnect so the connector re-sends its state sync and
            // the whole reconciliation gets a fresh attempt (old memory state intact).
            gateway.disconnect(instanceId);
            throw err;
          }
        } else if (envelope.type === MSG.instanceNotice) {
          const notice = envelope.payload as InstanceNoticePayload;
          webGateway.broadcast(accountId, { kind: "notice", instanceId, notice });
          if (notice.kind === "task-completion") {
            const instanceName = instances.getOwned(instanceId, accountId)?.name ?? instanceId;
            // Fire-and-forget: push delivery must never block the WS broadcast or
            // the persist path; failures are logged inside PushNotifier.
            void pushNotifier.sendTaskCompletion(accountId, { instanceId, instanceName, text: notice.text });
          }
        }
      } catch (err) {
        logger.error("relay.event.persist_failed", "failed to persist instance event", { instanceId, error: String(err) });
      }
    },
  });
  gatewayRef = gateway;
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
    vapidPublicKey: vapid ? () => vapid.publicKey : undefined,
    pushSubscriptions,
    onWebPromptCreated: ({ promptRequestId, instanceId, sessionAlias }) => {
      recordPendingWebPrompt(promptRequestId, instanceId, sessionAlias);
    },
    onWebPromptRejected: (promptRequestId) => {
      removePendingWebPrompt(promptRequestId);
    },
    onWebPromptQueued: ({ promptRequestId, instanceId, queueItemId }) => {
      associateQueueItem(promptRequestId, instanceId, queueItemId);
    },
    onWebPromptQueueCancelled: (instanceId, queueItemId) => {
      cancelPendingQueueItem(instanceId, queueItemId);
    },
    onWebPromptSessionCleared: (instanceId, sessionAlias) => {
      clearPendingForSession(instanceId, sessionAlias);
    },
  });
  const completionRouteSweepTimer = setInterval(
    () => gateway.sweepExpiredCompletionRoutes(),
    60 * 60_000,
  );
  completionRouteSweepTimer.unref?.();
  return {
    db,
    accounts,
    instances,
    messages,
    recoveryReceipts,
    pushSubscriptions,
    pushNotifier,
    gateway,
    webGateway,
    stateSnapshot,
    pendingWebPromptsCount: () => pendingWebPrompts.size,
    app,
    close: () => {
      clearInterval(completionRouteSweepTimer);
      db.close();
    },
  };
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
  /** Web push VAPID config; forwarded to createRelayRuntime. */
  vapid?: VapidConfig | null;
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
    vapid: options.vapid,
    trustProxy: options.trustProxy,
    logger: options.logger,
  });
  const host = options.host ?? "0.0.0.0";

  const retention = { historyRetentionDays: options.historyRetentionDays ?? 30, maxPerSession: MAX_MESSAGES_PER_SESSION };
  const stopMaintenance = startMaintenanceLoop(
    { accounts: runtime.accounts, instances: runtime.instances, messages: runtime.messages, recoveryReceipts: runtime.recoveryReceipts },
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
