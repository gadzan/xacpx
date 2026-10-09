import { randomUUID } from "node:crypto";
import {
  createConversationMessageId,
  createConversationRunId,
  createDirectConversationId,
  createMemberTurnId,
  createPendingDispatchId,
} from "../domain/ids";
import type { BotProfileSnapshot } from "../bots/bot-types";
import { ConversationError } from "./conversation-error";
import { memberConcurrencyLimit } from "./conversation-scheduling-policy";
import { isExternalIngressRejectionCode } from "./conversation-ingress-rejection";
import type {
  AcceptMemberInput,
  AcceptPublicHandoffInput,
  GroupSendInput,
  PublicHandoffReceipt,
  AcceptRequestInput,
  AcceptRequestResult,
  AssertLiveDispatchForMaterializeInput,
  ReconcileLateResult,
  CancelMemberOutcome,
  CancelRunResult,
  ClaimedWork,
  ClaimFenceInput,
  ClaimNextDispatchInput,
  CompleteExecutionInput,
  CompleteExecutionResult,
  ConversationStore,
  FailClaimBeforeStartInput,
  FailExecutionInput,
  ListMessagesQuery,
  MarkExecutionStartedInput,
  ApplyRoutingDecisionInput,
  ApplyRoutingDecisionResult,
  ClaimRecoveryScope,
  RecoveredClaim,
  ReleaseClaimToPendingInput,
  RenewHeldClaimInput,
  RoutingAssignmentInput,
  RoutingDecisionRecord,
  SettleCancelBatchInput,
  SettleCancelBatchResult,
  SettledCancelMember,
} from "./conversation-store";
import { MAX_AUTOMATIC_MEMBER_TURNS, MAX_QUEUED_RUNS_PER_TOPIC, isRunCancelling, publicMessageMatchesRunScope, requestSnapshotMatches } from "./conversation-store";
import {
  conversationExecutionOrigin,
  parseHumanIngress,
} from "./conversation-execution";
import type {
  ConversationMessage,
  ConversationRun,
  ConversationRunState,
  ConversationRoutingState,
  HumanIngressContext,
  MemberTurnEffect,
  MemberTurnEffectProvenance,
  MemberTurnOrigin,
  MemberTurnRecord,
  MemberTurnState,
  PendingDispatch,
  PendingDispatchState,
} from "./conversation-types";
import { ACTIVE_RUN_STATES, TERMINAL_MEMBER_STATES, TERMINAL_RUN_STATES } from "./conversation-types";
import { createSqlDriver, isSqliteUniqueViolation, type SqlDriver } from "./sql-driver";
import { parseGroupSend } from "./group-handoff";

export interface ConversationIdFactory {
  messageId: () => string;
  runId: () => string;
  memberTurnId: () => string;
  dispatchId: () => string;
}

export interface SqliteConversationStoreOptions {
  ids?: ConversationIdFactory;
  beforeAcceptCommit?: () => void;
  /** Fault-injection seam for migration crash tests. Throwing inside aborts
   *  the dispatch table rebuild before it commits. */
  beforeDispatchMigrationCommit?: () => void;
  /** Fault-injection seam for lease renewal. Throwing aborts the renewal
   *  transaction before lease_expires_at changes. Not a closed database. */
  beforeLeaseRenewal?: () => void;
}

export interface ExternalStopRequest {
  key: string;
  fingerprint: string;
  chatKey: string;
  accountId: string;
  senderId: string;
}

export interface ExternalStopReceipt {
  reused: boolean;
  targetRunIds: string[];
}

export interface ExternalRejectionReceipt {
  code: string;
  message: string;
}

interface MessageRow {
  handoff_json?: string | null;
  id: string;
  conversation_id: string;
  topic_id: string;
  seq: number;
  role: string;
  sender_bot_id: string | null;
  content: string;
  run_id: string | null;
  source_turn_json: string | null;
  created_at: string;
}

interface RunRow {
  quarantined_bot_ids_json?: string | null;
  id: string;
  conversation_id: string;
  topic_id: string;
  request_message_id: string;
  request_id: string;
  mode: string;
  state: string;
  completion_reason: string | null;
  waiting_question?: string | null;
  routing_state?: string | null;
  routing_generation?: number;
  generation: number;
  active_batch: number | null;
  max_member_turns: number;
  consumed_member_turns: number;
  failed_bot_ids_json: string | null;
  unavailable_bot_ids_json: string | null;
  profile_revision: number;
  profile_snapshot_json: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface MemberTurnRow {
  id: string;
  run_id: string;
  conversation_id: string;
  topic_id: string;
  bot_id: string;
  session_alias: string | null;
  logical_session_id: string | null;
  source_turn_id: string | null;
  queue_item_id: string | null;
  batch: number;
  member_index: number | null;
  attempt: number;
  // Legacy DBs (pre-vocabulary-split) persist origin "human". Normalize at
  // the durable read boundary so every in-memory MemberTurnRecord speaks the
  // new vocabulary; writers only emit "human-explicit".
  origin: string;
  state: string;
  trigger_message_ids_json: string;
  profile_snapshot_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  failure_reason: string | null;
  // Absent on pre-effect databases (added by ensureMemberTurnAssignmentColumns).
  effect?: string | null;
  effect_provenance?: string | null;
  assignment_id: string | null;
  task: string | null;
  expected_output: string | null;
  depends_on_json: string | null;
  blocked_reason?: string | null;
}

interface DispatchRow {
  id: string;
  run_id: string;
  member_turn_id: string;
  generation: number;
  state: string;
  owner: string | null;
  lease_expires_at: string | null;
  authority_epoch: string | null;
  human_ingress: string | null;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
}

interface RoutingDecisionRow {
  id: string;
  run_id: string;
  decision_type: string;
  mode: string | null;
  question: string | null;
  reason: string | null;
  assignment_ids_json: string;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversation_bindings (
  chat_key TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, topic_id TEXT NOT NULL, revision TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS external_conversation_requests (
  source_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, run_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL, topic_id TEXT NOT NULL, stop_ingress TEXT
);
CREATE INDEX IF NOT EXISTS external_conversation_requests_run ON external_conversation_requests(run_id);
CREATE TABLE IF NOT EXISTS external_conversation_stops (
  source_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
  chat_key TEXT NOT NULL, account_id TEXT NOT NULL, sender_id TEXT NOT NULL,
  target_run_ids_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS external_conversation_rejections (
  source_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
  rejection_code TEXT NOT NULL, rejection_message TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS topic_seq (
  topic_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  next_seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_lifecycle (
  conversation_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS topic_lifecycle (
  topic_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  sender_bot_id TEXT,
  content TEXT NOT NULL,
  run_id TEXT,
  source_turn_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (topic_id, seq)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  request_message_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  state TEXT NOT NULL,
  completion_reason TEXT,
  generation INTEGER NOT NULL,
  active_batch INTEGER,
  max_member_turns INTEGER NOT NULL,
  consumed_member_turns INTEGER NOT NULL,
  failed_bot_ids_json TEXT NOT NULL DEFAULT '[]',
  unavailable_bot_ids_json TEXT NOT NULL DEFAULT '[]',
  profile_revision INTEGER NOT NULL,
  profile_snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (conversation_id, topic_id, request_id)
);

CREATE TABLE IF NOT EXISTS member_turns (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  session_alias TEXT,
  logical_session_id TEXT,
  source_turn_id TEXT,
  queue_item_id TEXT,
  batch INTEGER NOT NULL DEFAULT 1,
  member_index INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1,
  origin TEXT NOT NULL,
  state TEXT NOT NULL,
  trigger_message_ids_json TEXT NOT NULL,
  profile_snapshot_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  failure_reason TEXT,
  assignment_id TEXT,
  task TEXT,
  expected_output TEXT,
  depends_on_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS pending_dispatches (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  member_turn_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL,
  owner TEXT,
  lease_expires_at TEXT,
  authority_epoch TEXT,
  human_ingress TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  completed_at TEXT,
  UNIQUE (run_id, member_turn_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_topic_seq ON messages (topic_id, seq);
CREATE INDEX IF NOT EXISTS idx_runs_topic_state ON runs (topic_id, state, created_at);
CREATE INDEX IF NOT EXISTS idx_dispatches_state ON pending_dispatches (state, created_at);
CREATE INDEX IF NOT EXISTS idx_dispatches_run ON pending_dispatches (run_id, state);
CREATE INDEX IF NOT EXISTS idx_member_turns_run ON member_turns (run_id);
`;

/**
 * PR8 sequential-assignment scheduling fence (§13.1). A MemberTurn that
 * declares `dependsOn` may only be claimed after EVERY dependency this Run
 * knows about is terminal. Dependencies are matched by durable `assignment_id`
 * (the Router's assignment identity, persisted verbatim on each member turn),
 * so a chained sequential batch cannot start its second step before the first
 * step's public result exists.
 *
 * `member_turns.depends_on_json` holds assignment ids; a dependency that names
 * an assignment id with no member row yet is a forward reference inside the
 * same decision — the Router's own DAG requires it to be in the same batch, and
 * the gate rejects cyclic graphs. A dependency that exists but is not terminal
 * blocks; a dependency that never exists blocks forever, which is why the
 * routing gate resolves dependencies against durable assignments first.
 */
const SEQUENTIAL_DEPENDENCY_FENCE = `
           AND NOT EXISTS (
             SELECT 1 FROM json_each(m.depends_on_json) AS dep
             LEFT JOIN member_turns dep_turn
               ON dep_turn.run_id = m.run_id AND dep_turn.assignment_id = dep.value
             WHERE dep_turn.id IS NULL
                OR dep_turn.state IN ('queued', 'dispatched', 'running')
           )`;

function optionalString(value: string | null | undefined): string | undefined {
  return value == null || value === "" ? undefined : value;
}

function parseStoredHumanIngress(json: string | null | undefined): HumanIngressContext | undefined {
  if (!json) {
    return undefined;
  }
  try {
    return parseHumanIngress(JSON.parse(json));
  } catch {
    return undefined;
  }
}
function serializeHumanIngress(ingress: HumanIngressContext | undefined): string | null {
  const parsed = parseHumanIngress(ingress);
  return parsed ? JSON.stringify(parsed) : null;
}

function serializeStopIngress(ingress: HumanIngressContext | undefined): string | null {
  return ingress ? serializeHumanIngress({ chatKey: ingress.chatKey, senderId: ingress.senderId, accountId: ingress.accountId }) : null;
}

/** Strict durable BotProfileSnapshot decoder: syntactically valid JSON with
 *  the wrong shape (e.g. `{}`) is corrupt durable state, not a usable
 *  snapshot. Fail closed with member_turn_corrupt instead of letting dispatch
 *  claim a poison row and TypeError in a release-to-pending loop forever.
 *  Revision/capturedAt identify the accepted generation; execution must carry
 *  non-empty agent/workspace (model/effort optional strings); presentation
 *  and behavior stay structurally typed. */
function isSnapshotExecution(value: unknown): value is BotProfileSnapshot["execution"] {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const execution = value as Record<string, unknown>;
  if (typeof execution.agent !== "string" || execution.agent.length === 0) {
    return false;
  }
  if (typeof execution.workspace !== "string" || execution.workspace.length === 0) {
    return false;
  }
  if (execution.model !== undefined && typeof execution.model !== "string") {
    return false;
  }
  if (execution.effort !== undefined && typeof execution.effort !== "string") {
    return false;
  }
  return true;
}

function isSnapshotPresentation(value: unknown): value is BotProfileSnapshot["presentation"] {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const presentation = value as Record<string, unknown>;
  if (typeof presentation.name !== "string") {
    return false;
  }
  if (presentation.avatar !== undefined && typeof presentation.avatar !== "string") {
    return false;
  }
  if (presentation.role !== undefined && typeof presentation.role !== "string") {
    return false;
  }
  return true;
}

function isSnapshotBehavior(value: unknown): value is BotProfileSnapshot["behavior"] {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const behavior = value as Record<string, unknown>;
  if (behavior.instructions !== undefined && typeof behavior.instructions !== "string") {
    return false;
  }
  return true;
}

function decodeSnapshot(value: unknown): BotProfileSnapshot {
  if (typeof value !== "object" || value === null) {
    throw new ConversationError("member_turn_corrupt", "member turn has a malformed execution snapshot");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.revision !== "number" || typeof record.capturedAt !== "string") {
    throw new ConversationError("member_turn_corrupt", "member turn has a malformed execution snapshot");
  }
  if (!isSnapshotPresentation(record.presentation) || !isSnapshotBehavior(record.behavior) || !isSnapshotExecution(record.execution)) {
    throw new ConversationError("member_turn_corrupt", "member turn has a malformed execution snapshot");
  }
  return value as BotProfileSnapshot;
}

function parseSnapshot(json: string): BotProfileSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ConversationError("member_turn_corrupt", "member turn has a malformed execution snapshot");
  }
  return decodeSnapshot(parsed);
}
function mapMessage(row: MessageRow): ConversationMessage {
  const sourceTurn = row.source_turn_json
    ? JSON.parse(row.source_turn_json) as ConversationMessage["sourceTurn"]
    : undefined;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    topicId: row.topic_id,
    seq: Number(row.seq),
    role: row.role as ConversationMessage["role"],
    ...(optionalString(row.sender_bot_id) ? { senderBotId: row.sender_bot_id as string } : {}),
    content: row.content,
    ...(row.handoff_json ? { handoff: JSON.parse(row.handoff_json) as ConversationMessage["handoff"] } : {}),
    ...(optionalString(row.run_id) ? { runId: row.run_id as string } : {}),
    createdAt: row.created_at,
    ...(sourceTurn ? { sourceTurn } : {}),
  };
}

function mapRun(row: RunRow): ConversationRun {
  const mode = row.mode === "automatic" ? "automatic" : "explicit";
  const quarantinedBotIds = parseQuarantinedBotIds(row.quarantined_bot_ids_json);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    topicId: row.topic_id,
    requestMessageId: row.request_message_id,
    requestId: row.request_id,
    mode,
    state: row.state as ConversationRunState,
    ...(optionalString(row.completion_reason) ? { completionReason: row.completion_reason as string } : {}),
    ...(mode === "automatic" && row.state === "waiting-human" && optionalString(row.waiting_question)
      ? { waitingQuestion: row.waiting_question as string } : {}),
    // PR8 automatic routing substate. Explicit Runs must NEVER read a
    // routing state: explicit behavior stays "selected members terminal →
    // Run terminal" with no reevaluation, so a leftover durable value on an
    // explicit row is dropped rather than routed on.
    ...(mode === "automatic" && optionalString(row.routing_state)
      ? { routingState: row.routing_state as ConversationRoutingState }
      : {}),
    generation: Number(row.generation),
    ...(mode === "automatic" ? { routingGeneration: Number(row.routing_generation ?? 0) } : {}),
    ...(row.active_batch !== null && row.active_batch !== undefined
      ? { activeBatch: Number(row.active_batch) }
      : {}),
    maxMemberTurns: Number(row.max_member_turns),
    consumedMemberTurns: Number(row.consumed_member_turns),
    failedBotIds: parseBotIds(row.failed_bot_ids_json),
    unavailableBotIds: parseBotIds(row.unavailable_bot_ids_json),
    ...(quarantinedBotIds.length > 0 ? { quarantinedBotIds } : {}),
    profileRevision: Number(row.profile_revision),
    profileSnapshot: parseSnapshot(row.profile_snapshot_json),
    createdAt: row.created_at,
    ...(optionalString(row.started_at) ? { startedAt: row.started_at as string } : {}),
    ...(optionalString(row.finished_at) ? { finishedAt: row.finished_at as string } : {}),
  };
}

function parseBotIds(json: string | null | undefined): string[] {
  if (!json) {
    return [];
  }
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function parseQuarantinedBotIds(json: string | null | undefined): string[] {
  // Migration supplies NOT NULL '[]' before Run reads. Quarantine is a
  // scheduling fence: corruption must never restore a Bot's eligibility.
  let parsed: unknown;
  if (typeof json !== "string") {
    throw new ConversationError("run_corrupt", "Run has malformed quarantine state");
  }
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ConversationError("run_corrupt", "Run has malformed quarantine state");
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new ConversationError("run_corrupt", "Run has malformed quarantine state");
  }
  return parsed;
}

function parseDependsOn(json: string | null | undefined): string[] {
  // NULL/absent (legacy rows) means no dependencies. Non-null malformed JSON
  // is corrupt durable state: fail closed rather than silently scheduling
  // the turn as dependency-free.
  if (json === null || json === undefined) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ConversationError("member_turn_corrupt", "member turn has malformed dependencies");
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new ConversationError("member_turn_corrupt", "member turn has malformed dependencies");
  }
  return parsed;
}
function parseTriggerMessageIds(json: string | null | undefined): string[] {
  // Written NOT NULL at accept; a structurally wrong value is corrupt
  // durable state like the snapshot, not an empty trigger list.
  if (json === null || json === undefined) {
    throw new ConversationError("member_turn_corrupt", "member turn has malformed trigger message ids");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ConversationError("member_turn_corrupt", "member turn has malformed trigger message ids");
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new ConversationError("member_turn_corrupt", "member turn has malformed trigger message ids");
  }
  return parsed;
}

function parseMemberSnapshot(json: string | null | undefined): BotProfileSnapshot | undefined {
  // NULL/absent (pre-multi-member legacy rows) falls back to the Run's
  // snapshot at claim time. Non-null malformed JSON — syntactically broken
  // OR structurally wrong — is corrupt durable state: fail closed rather
  // than silently executing under another member's snapshot or looping a
  // poison claim through release-to-pending forever.
  if (json === null || json === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ConversationError("member_turn_corrupt", "member turn has a malformed execution snapshot");
  }
  return decodeSnapshot(parsed);
}

/** Effect values outside the vocabulary read as unproven. Writers only
 *  persist the vocabulary (or the "unknown" default); a damaged row must not
 *  launder an arbitrary string into scheduling trust. */
function isMemberTurnEffect(value: unknown): value is MemberTurnEffect {
  return value === "unknown" || value === "read-only" || value === "mutating";
}

function mapMemberTurn(row: MemberTurnRow): MemberTurnRecord {
  // Effects now carry an accepted security ceiling. Corruption cannot be
  // normalized to writable unknown work; only genuinely absent legacy data
  // may use the unproven default.
  if ((row.effect !== undefined && !isMemberTurnEffect(row.effect))
    || (row.effect_provenance != null && (row.effect_provenance !== "declared-enforced" || row.effect !== "read-only"))) {
    throw new ConversationError("invalid_effect_policy", `member turn "${row.id}" has a malformed execution ceiling`);
  }
  const dependsOn = parseDependsOn(row.depends_on_json);
  const snapshot = parseMemberSnapshot(row.profile_snapshot_json);
  return {
    id: row.id,
    runId: row.run_id,
    conversationId: row.conversation_id,
    topicId: row.topic_id,
    botId: row.bot_id,
    ...(optionalString(row.session_alias) ? { sessionAlias: row.session_alias as string } : {}),
    ...(optionalString(row.logical_session_id) ? { logicalSessionId: row.logical_session_id as string } : {}),
    ...(optionalString(row.source_turn_id) ? { sourceTurnId: row.source_turn_id as string } : {}),
    ...(optionalString(row.queue_item_id) ? { queueItemId: row.queue_item_id as string } : {}),
    batch: Number(row.batch),
    memberIndex: Number(row.member_index ?? 0),
    attempt: Number(row.attempt),
    origin: row.origin === "human" ? "human-explicit" : (row.origin as MemberTurnRecord["origin"]),
    state: row.state as MemberTurnState,
    triggerMessageIds: parseTriggerMessageIds(row.trigger_message_ids_json),
    ...(snapshot ? { profileSnapshot: snapshot } : {}),
    ...(optionalString(row.started_at) ? { startedAt: row.started_at as string } : {}),
    ...(optionalString(row.finished_at) ? { finishedAt: row.finished_at as string } : {}),
    ...(optionalString(row.failure_reason) ? { failureReason: row.failure_reason as string } : {}),
    ...(isMemberTurnEffect(row.effect) && row.effect !== "unknown" ? { effect: row.effect } : {}),
    ...(optionalString(row.effect_provenance) ? { effectProvenance: row.effect_provenance as MemberTurnRecord["effectProvenance"] } : {}),
    ...(optionalString(row.assignment_id) ? { assignmentId: row.assignment_id as string } : {}),
    ...(optionalString(row.task) ? { task: row.task as string } : {}),
    ...(optionalString(row.expected_output) ? { expectedOutput: row.expected_output as string } : {}),
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
    ...(optionalString(row.blocked_reason)
      ? { blockedReason: row.blocked_reason as MemberTurnRecord["blockedReason"] }
      : {}),
    createdAt: row.created_at,
  };
}

function mapDispatch(row: DispatchRow): PendingDispatch {
  const humanIngress = parseStoredHumanIngress(row.human_ingress);
  return {
    id: row.id,
    runId: row.run_id,
    memberTurnId: row.member_turn_id,
    generation: Number(row.generation),
    state: row.state as PendingDispatchState,
    ...(optionalString(row.owner) ? { owner: row.owner as string } : {}),
    ...(optionalString(row.lease_expires_at) ? { leaseExpiresAt: row.lease_expires_at as string } : {}),
    createdAt: row.created_at,
    ...(optionalString(row.authority_epoch) ? { authorityEpoch: row.authority_epoch as string } : {}),
    ...(humanIngress ? { humanIngress } : {}),
    ...(optionalString(row.claimed_at) ? { claimedAt: row.claimed_at as string } : {}),
    ...(optionalString(row.completed_at) ? { completedAt: row.completed_at as string } : {}),
  };
}

function defaultIds(): ConversationIdFactory {
  return {
    messageId: () => createConversationMessageId(),
    runId: () => createConversationRunId(),
    memberTurnId: () => createMemberTurnId(),
    dispatchId: () => createPendingDispatchId(),
  };
}

import { ConversationWorktreeStore } from "./conversation-worktree-store";

export class SqliteConversationStore implements ConversationStore {
  readonly worktrees: import("./conversation-worktree-store").ConversationWorktreeStore;
  private readonly ids: ConversationIdFactory;
  private readonly beforeAcceptCommit?: () => void;
  private readonly beforeDispatchMigrationCommit?: () => void;
  private readonly beforeLeaseRenewal?: () => void;

  private closed = false;

  constructor(
    private readonly db: SqlDriver,
    options?: SqliteConversationStoreOptions,
  ) {
    this.ids = options?.ids ?? defaultIds();
    this.beforeAcceptCommit = options?.beforeAcceptCommit;
    this.beforeDispatchMigrationCommit = options?.beforeDispatchMigrationCommit;
    this.beforeLeaseRenewal = options?.beforeLeaseRenewal;
    this.sqlite.exec(SCHEMA);
    this.worktrees = new ConversationWorktreeStore(this.sqlite);
    this.ensureDispatchAuthorityEpochColumn();
    this.ensureDispatchHumanIngressColumn();
    this.ensureMemberTurnAssignmentColumns();
    this.ensureMemberTurnSnapshotColumn();
    this.ensureRunAggregateColumns();
    this.ensureMemberTurnBlockedColumn();
    this.ensureRoutingDecisionTable();
    this.ensureWaitingQuestionColumn();
    this.ensureDispatchMultiMemberShape();
    this.ensurePublicHandoffSchema();
    this.ensureExternalStopIngress();
    this.ensureBindingRevision();
  }

  private ensureBindingRevision(): void {
    this.sqlite.transaction(() => {
      const columns = this.sqlite.all<{ name: string }>("PRAGMA table_info(conversation_bindings)");
      if (columns.some((column) => column.name === "revision")) return;
      this.sqlite.exec("ALTER TABLE conversation_bindings ADD COLUMN revision TEXT");
      for (const row of this.sqlite.all<{ chat_key: string }>("SELECT chat_key FROM conversation_bindings")) {
        this.sqlite.run("UPDATE conversation_bindings SET revision = ? WHERE chat_key = ?", [randomUUID(), row.chat_key]);
      }
    });
  }

  private ensureExternalStopIngress(): void {
    this.sqlite.transaction(() => {
      const columns = this.sqlite.all<{ name: string }>("PRAGMA table_info(external_conversation_requests)");
      if (!columns.some((column) => column.name === "stop_ingress")) {
        this.sqlite.exec("ALTER TABLE external_conversation_requests ADD COLUMN stop_ingress TEXT");
      }
      // Copy original route facts before recovery strips execution authority.
      // This column authorizes only Stop; it is never used for provider authority.
      for (const row of this.sqlite.all<{ source_key: string; human_ingress: string }>(
        `SELECT e.source_key, p.human_ingress FROM external_conversation_requests e
         JOIN pending_dispatches p ON p.run_id = e.run_id
         WHERE e.stop_ingress IS NULL AND p.human_ingress IS NOT NULL ORDER BY p.created_at, p.rowid`)) {
        const ingress = parseStoredHumanIngress(row.human_ingress);
        if (ingress) this.sqlite.run("UPDATE external_conversation_requests SET stop_ingress = ? WHERE source_key = ? AND stop_ingress IS NULL",
          [serializeStopIngress(ingress), row.source_key]);
      }
    });
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new ConversationError("store_closed", "conversation store is closed");
    }
  }

  private get sqlite(): SqlDriver {
    this.assertOpen();
    return this.db;
  }

  static async open(path: string, options?: SqliteConversationStoreOptions): Promise<SqliteConversationStore> {
    const db = await createSqlDriver(path);
    try { return new SqliteConversationStore(db, options); }
    catch (error) { db.close(); throw error; }
  }


  /** Test-only seam: overwrite one row's columns (durability corruption simulation). */
  directWriteForTest(table: string, id: string, patch: Record<string, string | null>): void {
    const keys = Object.keys(patch);
    if (!/^[a-z_]+$/.test(table) || keys.some((key) => !/^[a-z_]+$/.test(key))) {
      throw new ConversationError("invalid-test-write", "test write targets must be snake_case identifiers");
    }
    this.sqlite.run(
      `UPDATE ${table} SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE id = ?`,
      [...keys.map((key) => patch[key] ?? null), id],
    );
  }

  acceptRequest(input: AcceptRequestInput): AcceptRequestResult {
    if (input.externalRequest) {
      const replay = this.getExternalRequest(input.externalRequest);
      if (replay) return replay;
    }
    // Idempotent replay short-circuits BEFORE the bounded-queue check: a
    // retry of an already-accepted request at a full queue must return the
    // existing Run, never fail `topic_queue_full`. loadAccepted throws
    // `accepted_request_incomplete` for a crash-window row set — same
    // contract as the unique-violation fallback below.
    const existing = this.getRunByRequestId(input.conversationId, input.topicId, input.requestId);
    if (existing) {
      if (input.externalRequest) throw new ConversationError("external_request_conflict", "external request id exists without its platform receipt");
      const reused = this.loadAccepted(input.conversationId, input.topicId, input.requestId);
      if (reused) {
        return { reused: true, ...reused };
      }
    }
    try {
      return this.sqlite.transaction(() => {
        if (input.externalRequest && this.hasExternalStopRequest(input.externalRequest.key)) {
          throw new ConversationError("external_request_conflict", "platform message already identifies a Stop");
        }
        if (input.externalRequest && this.hasExternalRejection(input.externalRequest.key)) {
          throw new ConversationError("external_request_conflict", "platform message already identifies a rejection");
        }
        this.assertAcceptable(input.conversationId, input.topicId);
        const created = this.insertAccepted(input);
        if (input.externalRequest) {
          this.sqlite.run("INSERT INTO external_conversation_requests (source_key, fingerprint, run_id, conversation_id, topic_id, stop_ingress) VALUES (?, ?, ?, ?, ?, ?)",
            [input.externalRequest.key, input.externalRequest.fingerprint, created.run.id, created.run.conversationId, created.run.topicId, serializeStopIngress(input.humanIngress)]);
        }
        this.beforeAcceptCommit?.();
        return created;
      });
    } catch (error) {
      if (isSqliteUniqueViolation(error)) {
        if (input.externalRequest) {
          const replay = this.getExternalRequest(input.externalRequest);
          if (replay) return replay;
        }
        const reused = this.loadAccepted(input.conversationId, input.topicId, input.requestId);
        if (reused) {
          return { reused: true, ...reused };
        }
      }
      throw error;
    }
  }

  hasExternalRequest(key: string): boolean {
    return this.sqlite.get("SELECT 1 FROM external_conversation_requests WHERE source_key = ?", [key]) !== undefined;
  }

  hasExternalStopRequest(key: string): boolean {
    return this.sqlite.get("SELECT 1 FROM external_conversation_stops WHERE source_key = ?", [key]) !== undefined;
  }

  hasExternalRejection(key: string): boolean {
    return this.sqlite.get("SELECT 1 FROM external_conversation_rejections WHERE source_key = ?", [key]) !== undefined;
  }

  getExternalRejection(input: { key: string; fingerprint: string }): ExternalRejectionReceipt | undefined {
    const row = this.sqlite.get<{ fingerprint: string; rejection_code: string; rejection_message: string }>(
      "SELECT * FROM external_conversation_rejections WHERE source_key = ?", [input.key]);
    if (!row) return undefined;
    if (this.hasExternalRequest(input.key) || this.hasExternalStopRequest(input.key)
      || typeof row.fingerprint !== "string" || !row.fingerprint
      || !isExternalIngressRejectionCode(row.rejection_code) || typeof row.rejection_message !== "string" || !row.rejection_message) {
      throw new ConversationError("external_request_corrupt", "platform rejection receipt is invalid");
    }
    if (row.fingerprint !== input.fingerprint) throw new ConversationError("external_request_conflict", "platform rejection was recorded with different input");
    return { code: row.rejection_code, message: row.rejection_message };
  }

  recordExternalRejection(input: { key: string; fingerprint: string }, rejection: ExternalRejectionReceipt): ExternalRejectionReceipt {
    this.assertOpen();
    return this.sqlite.transaction(() => {
      const result = this.insertExternalRejection(input, rejection);
      this.beforeAcceptCommit?.();
      return result;
    });
  }

  /** Caller holds the write transaction; also used by atomic Stop admission. */
  private insertExternalRejection(input: { key: string; fingerprint: string }, rejection: ExternalRejectionReceipt): ExternalRejectionReceipt {
    if (this.hasExternalRequest(input.key) || this.hasExternalStopRequest(input.key)) {
      throw new ConversationError("external_request_conflict", "platform message already has an accepted receipt");
    }
    const replay = this.getExternalRejection(input);
    if (replay) return replay;
    if (!isExternalIngressRejectionCode(rejection.code) || !rejection.message) {
      throw new ConversationError("external_request_corrupt", "invalid external rejection decision");
    }
    this.sqlite.run("INSERT INTO external_conversation_rejections (source_key, fingerprint, rejection_code, rejection_message) VALUES (?, ?, ?, ?)",
      [input.key, input.fingerprint, rejection.code, rejection.message]);
    return rejection;
  }

  getExternalStopRequest(input: ExternalStopRequest): ExternalStopReceipt | undefined {
    if (this.hasExternalRejection(input.key)) throw new ConversationError("external_request_conflict", "platform message already identifies a rejection");
    const row = this.sqlite.get<{ fingerprint: string; chat_key: string; account_id: string; sender_id: string; target_run_ids_json: string }>(
      "SELECT * FROM external_conversation_stops WHERE source_key = ?", [input.key]);
    if (!row) return undefined;
    if (row.fingerprint !== input.fingerprint) throw new ConversationError("external_request_conflict", "platform Stop was already accepted with different input");
    if (row.chat_key !== input.chatKey || row.account_id !== input.accountId || row.sender_id !== input.senderId) {
      throw new ConversationError("external_stop_corrupt", "Stop receipt lost its original owner");
    }
    let ids: unknown;
    try { ids = JSON.parse(row.target_run_ids_json); }
    catch { throw new ConversationError("external_stop_corrupt", "Stop receipt has malformed targets"); }
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id || id !== id.trim()) || new Set(ids).size !== ids.length) {
      throw new ConversationError("external_stop_corrupt", "Stop receipt has invalid targets");
    }
    return { reused: true, targetRunIds: ids as string[] };
  }

  acceptExternalStop(input: ExternalStopRequest, selectTargets: () => string[],
    selectPending: () => Array<{ key: string; fingerprint: string }> = () => []): ExternalStopReceipt {
    this.assertOpen();
    return this.sqlite.transaction(() => {
      if (this.hasExternalRequest(input.key)) throw new ConversationError("external_request_conflict", "platform message already identifies a prompt");
      const replay = this.getExternalStopRequest(input);
      if (replay) return replay;
      const targetRunIds = selectTargets();
      for (const pending of selectPending()) {
        if (pending.key === input.key) throw new ConversationError("external_request_conflict", "Stop source also identifies a pending prompt");
        // A committed prompt is handled by the frozen Run targets, never by a
        // rejection. Pending sources need durable proof even if we crash before
        // their human signal fires or their own rejection can be written.
        if (!this.hasExternalRequest(pending.key)) this.insertExternalRejection(pending,
          { code: "external_request_aborted", message: "channel request was stopped before acceptance" });
      }
      this.sqlite.run("INSERT INTO external_conversation_stops (source_key, fingerprint, chat_key, account_id, sender_id, target_run_ids_json) VALUES (?, ?, ?, ?, ?, ?)",
        [input.key, input.fingerprint, input.chatKey, input.accountId, input.senderId, JSON.stringify(targetRunIds)]);
      this.beforeAcceptCommit?.();
      return { reused: false, targetRunIds };
    });
  }

  listLiveExternalRequests(): Array<{ accepted: AcceptRequestResult; ingress?: HumanIngressContext }> {
    return this.sqlite.all<{ source_key: string; fingerprint: string; stop_ingress: string | null }>(
      `SELECT e.source_key, e.fingerprint, e.stop_ingress FROM runs r
       JOIN external_conversation_requests e ON e.run_id = r.id
       WHERE r.state IN ('queued', 'running', 'waiting-human') ORDER BY r.created_at, r.rowid`)
      .map((row) => ({ accepted: this.getExternalRequest({ key: row.source_key, fingerprint: row.fingerprint })!,
        ingress: parseStoredHumanIngress(row.stop_ingress) }));
  }

  getExternalRequest(input: { key: string; fingerprint: string }): AcceptRequestResult | undefined {
    if (this.hasExternalRejection(input.key)) throw new ConversationError("external_request_conflict", "platform message already identifies a rejection");
    if (this.hasExternalStopRequest(input.key)) throw new ConversationError("external_request_conflict", "platform message already identifies a Stop");
    const row = this.sqlite.get<{ fingerprint: string; run_id: string; conversation_id: string; topic_id: string }>(
      "SELECT * FROM external_conversation_requests WHERE source_key = ?", [input.key]);
    if (!row) return undefined;
    if (row.fingerprint !== input.fingerprint) {
      throw new ConversationError("external_request_conflict", "platform message was already accepted with different input");
    }
    const run = this.getRun(row.run_id);
    if (!run) throw new ConversationError("external_request_retired", "platform message belongs to a deleted Run");
    if (run.conversationId !== row.conversation_id || run.topicId !== row.topic_id || run.requestId !== `external:${input.key}`) {
      throw new ConversationError("external_request_corrupt", "platform receipt lost its exact Run scope");
    }
    const accepted = this.getAcceptedRequest(run.conversationId, run.topicId, run.requestId);
    if (!accepted) throw new ConversationError("external_request_corrupt", "platform message lost its accepted request");
    return accepted;
  }

  listConversationBindings(): Array<{ chatKey: string; conversationId: string; topicId: string }> {
    return this.sqlite.all<{ chat_key: string; conversation_id: string; topic_id: string }>(
      "SELECT * FROM conversation_bindings ORDER BY chat_key").map((row) => {
      if (!row.chat_key || !row.conversation_id || !row.topic_id) {
        throw new ConversationError("binding_corrupt", "Conversation binding is incomplete");
      }
      return { chatKey: row.chat_key, conversationId: row.conversation_id, topicId: row.topic_id };
    });
  }

  getConversationBinding(chatKey: string): { chatKey: string; conversationId: string; topicId: string; revision: string } | undefined {
    const row = this.sqlite.get<{ conversation_id: string; topic_id: string; revision: string }>(
      "SELECT conversation_id, topic_id, revision FROM conversation_bindings WHERE chat_key = ?", [chatKey]);
    if (!row) return undefined;
    if (!row.conversation_id || !row.topic_id || typeof row.revision !== "string" || !row.revision || row.revision !== row.revision.trim()) {
      throw new ConversationError("binding_corrupt", "Conversation binding is incomplete");
    }
    return { chatKey, conversationId: row.conversation_id, topicId: row.topic_id, revision: row.revision };
  }

  setConversationBinding(binding: { chatKey: string; conversationId: string; topicId: string }): void {
    this.sqlite.run("INSERT INTO conversation_bindings (chat_key, conversation_id, topic_id, revision) VALUES (?, ?, ?, ?) ON CONFLICT(chat_key) DO UPDATE SET conversation_id = excluded.conversation_id, topic_id = excluded.topic_id, revision = excluded.revision",
      [binding.chatKey, binding.conversationId, binding.topicId, randomUUID()]);
  }

  removeConversationBinding(chatKey: string): void {
    this.sqlite.run("DELETE FROM conversation_bindings WHERE chat_key = ?", [chatKey]);
  }

  getPublicHandoff(sourceTurnId: string, invocationId: string, args: GroupSendInput): PublicHandoffReceipt | undefined {
    const row = this.sqlite.get<MemberTurnRow>(
      "SELECT * FROM member_turns WHERE handoff_source_turn_id = ? AND handoff_invocation_id = ?", [sourceTurnId, invocationId]);
    if (!row) return undefined;
    const memberTurn = mapMemberTurn(row);
    if (memberTurn.botId !== args.to || memberTurn.task !== args.task || memberTurn.expectedOutput !== args.expectedOutput) {
      throw new ConversationError("handoff_idempotency_conflict", "runtime invocation was already committed with different arguments");
    }
    const message = this.sqlite.get<MessageRow>(
      `SELECT * FROM messages WHERE json_extract(handoff_json, '$.memberTurnId') = ?
        AND conversation_id = ? AND topic_id = ? AND run_id = ? AND role = 'system'`,
      [memberTurn.id, memberTurn.conversationId, memberTurn.topicId, memberTurn.runId]);
    if (!message) throw new ConversationError("handoff_envelope_missing", "durable handoff lost its public envelope");
    const publicMessage = mapMessage(message);
    const envelope = publicMessage.handoff;
    const sender = envelope ? this.getMemberTurn(envelope.senderMemberTurnId) : undefined;
    if (!envelope || envelope.assignmentId !== memberTurn.assignmentId || envelope.to !== memberTurn.botId
      || envelope.task !== memberTurn.task || envelope.expectedOutput !== memberTurn.expectedOutput
      || !sender || sender.runId !== memberTurn.runId || sender.sourceTurnId !== sourceTurnId
      || sender.conversationId !== memberTurn.conversationId || sender.topicId !== memberTurn.topicId
      || publicMessage.senderBotId !== sender.botId) {
      throw new ConversationError("handoff_envelope_mismatch", "durable handoff public identity is corrupt");
    }
    return { reused: true, run: this.requireRun(memberTurn.runId), memberTurn, message: publicMessage };
  }

  acceptPublicHandoff(input: AcceptPublicHandoffInput): PublicHandoffReceipt {
    const args = parseGroupSend(input.args);
    return this.sqlite.transaction(() => {
      const prior = this.getPublicHandoff(input.sourceTurnId, input.invocationId, args);
      if (prior) return prior;
      const sender = this.requireMemberTurn(input.senderMemberTurnId);
      const run = this.requireRun(sender.runId);
      // Extending this admitted Run creates no new queued Run. Keep delete
      // barriers, while its own durable work budget bounds new assignments.
      this.assertLifecycleAcceptable(run.conversationId, run.topicId);
      const dispatch = this.requireDispatch(input.dispatchId);
      if (sender.state !== "running" || sender.sourceTurnId !== input.sourceTurnId
        || dispatch.runId !== run.id || dispatch.memberTurnId !== sender.id || dispatch.state !== "claimed"
        || dispatch.owner !== input.owner || dispatch.generation !== input.generation) {
        throw new ConversationError("stale_group_execution", "handoff sender is no longer the live execution");
      }
      if (run.state !== "running" || isRunCancelling(run)) {
        throw new ConversationError("run_not_runnable", "Run cannot accept handoff work");
      }
      if (run.quarantinedBotIds?.includes(args.to)) {
        throw new ConversationError("handoff_quarantined_member", "target is unavailable for this Run");
      }
      const members = this.listMemberTurns(run.id);
      if (this.allocatedWork(run.id) >= run.maxMemberTurns) {
        // Keep the active physical execution intact. The failed tool call is
        // durable Run intent; settlement gives budget exhaustion a stable reason.
        this.sqlite.run("UPDATE runs SET budget_exhausted = 1 WHERE id = ?", [run.id]);
        return undefined;
      }
      const memberTurnId = this.ids.memberTurnId();
      const assignmentId = `handoff_${memberTurnId}`;
      const messageId = this.ids.messageId();
      const envelope = { senderMemberTurnId: sender.id, to: args.to, assignmentId, memberTurnId,
        task: args.task, ...(args.expectedOutput !== undefined ? { expectedOutput: args.expectedOutput } : {}) };
      const triggerIds = new Set([run.requestMessageId, ...sender.triggerMessageIds]);
      const request = this.requireMessage(run.requestMessageId);
      if (!requestSnapshotMatches(request, run)) {
        throw new ConversationError("request_snapshot_mismatch", "handoff lost its exact human request snapshot");
      }
      for (const turn of members.filter((turn) => turn.state === "completed")) {
        const result = this.getMemberResult(turn);
        if (!result) throw new ConversationError("member_result_missing", "handoff lost completed public evidence");
        triggerIds.add(result.id);
      }
      // Completed, in-scope evidence only. No max-seq extension can absorb a
      // later human Run or a future sibling result.
      for (const id of triggerIds) {
        const message = this.requireMessage(id);
        if (!publicMessageMatchesRunScope(message, run, request)) {
          throw new ConversationError("trigger_message_not_found", "handoff context is outside the Topic");
        }
      }
      triggerIds.add(messageId);
      const seq = this.allocateSeq(run.conversationId, run.topicId);
      const content = `Public handoff: ${sender.botId} → ${args.to}\nRun: ${run.id}\nTask:\n${args.task}`
        + (args.expectedOutput === undefined ? "" : `\nExpected output:\n${args.expectedOutput}`);
      this.sqlite.run(`INSERT INTO messages (id, conversation_id, topic_id, seq, role, sender_bot_id, content, run_id, created_at, handoff_json)
        VALUES (?, ?, ?, ?, 'system', ?, ?, ?, ?, ?)`,
        [messageId, run.conversationId, run.topicId, seq, sender.botId, content, run.id, input.now, JSON.stringify(envelope)]);
      this.sqlite.run(`INSERT INTO member_turns (id, run_id, conversation_id, topic_id, bot_id, batch, member_index, attempt,
        origin, state, trigger_message_ids_json, profile_snapshot_json, created_at, assignment_id, task, expected_output,
        depends_on_json, effect, handoff_source_turn_id, handoff_invocation_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'handoff', 'queued', ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)`,
        [memberTurnId, run.id, run.conversationId, run.topicId, args.to, run.activeBatch ?? 1,
          Math.max(-1, ...members.filter((turn) => turn.batch === (run.activeBatch ?? 1)).map((turn) => turn.memberIndex)) + 1,
          JSON.stringify([...triggerIds]), JSON.stringify(input.profileSnapshot), input.now, assignmentId, args.task,
          args.expectedOutput ?? null, JSON.stringify(sender.dependsOn ?? []), input.sourceTurnId, input.invocationId]);
      this.sqlite.run(`INSERT INTO pending_dispatches (id, run_id, member_turn_id, generation, state, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?)`, [this.ids.dispatchId(), run.id, memberTurnId, run.generation, input.now]);
      return { reused: false, run: this.requireRun(run.id), memberTurn: this.requireMemberTurn(memberTurnId), message: this.requireMessage(messageId) };
    }) ?? (() => { throw new ConversationError("budget-exhausted", "Run work budget is exhausted"); })();
  }

  private allocatedWork(runId: string): number {
    return this.listMemberTurns(runId).length + Number(this.sqlite.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM recovery_attempts WHERE run_id = ?", [runId])?.n ?? 0);
  }

  getRun(runId: string): ConversationRun | undefined {
    const row = this.sqlite.get<RunRow>("SELECT * FROM runs WHERE id = ?", [runId]);
    return row ? mapRun(row) : undefined;
  }

  getRunByRequestId(conversationId: string, topicId: string, requestId: string): ConversationRun | undefined {
    const row = this.sqlite.get<RunRow>(
      "SELECT * FROM runs WHERE conversation_id = ? AND topic_id = ? AND request_id = ?",
      [conversationId, topicId, requestId],
    );
    return row ? mapRun(row) : undefined;
  }

  getAcceptedRequest(conversationId: string, topicId: string, requestId: string): AcceptRequestResult | undefined {
    const existing = this.loadAccepted(conversationId, topicId, requestId);
    return existing ? { reused: true, ...existing } : undefined;
  }

  listRuns(conversationId: string, topicId?: string): ConversationRun[] {
    // Tie-break by insertion order (rowid), not random UUID: accepts in the
    // same millisecond must keep durable seq order so "oldest queued" is stable.
    const rows = topicId
      ? this.sqlite.all<RunRow>(
        "SELECT * FROM runs WHERE conversation_id = ? AND topic_id = ? ORDER BY created_at ASC, rowid ASC",
        [conversationId, topicId],
      )
      : this.sqlite.all<RunRow>(
        "SELECT * FROM runs WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC",
        [conversationId],
      );
    return rows.map(mapRun);
  }

  getMessage(messageId: string): ConversationMessage | undefined {
    const row = this.sqlite.get<MessageRow>("SELECT * FROM messages WHERE id = ?", [messageId]);
    return row ? mapMessage(row) : undefined;
  }

  listMessages(query: ListMessagesQuery): ConversationMessage[] {
    const newestFirst = query.direction === "newest-first";
    const backward = query.beforeSeq !== undefined && query.afterSeq === undefined;
    const orderDescending = newestFirst ? !backward : backward;
    const rows = this.sqlite.all<MessageRow>(
      `SELECT * FROM messages
       WHERE conversation_id = ? AND topic_id = ?
         AND (? IS NULL OR seq > ?)
         AND (? IS NULL OR seq < ?)
       ORDER BY seq ${orderDescending ? "DESC" : "ASC"}
       LIMIT ?`,
      [
        query.conversationId,
        query.topicId,
        query.afterSeq ?? null,
        query.afterSeq ?? null,
        query.beforeSeq ?? null,
        query.beforeSeq ?? null,
        query.limit,
      ],
    );
    const messages = rows.map(mapMessage);
    return orderDescending ? messages.reverse() : messages;
  }

  getMemberTurn(memberTurnId: string): MemberTurnRecord | undefined {
    const row = this.sqlite.get<MemberTurnRow>("SELECT * FROM member_turns WHERE id = ?", [memberTurnId]);
    return row ? mapMemberTurn(row) : undefined;
  }

  listMemberTurns(runId: string): MemberTurnRecord[] {
    return this.sqlite.all<MemberTurnRow>(
      "SELECT * FROM member_turns WHERE run_id = ? ORDER BY batch ASC, member_index ASC, id ASC",
      [runId],
    ).map(mapMemberTurn);
  }

  getMemberResult(turn: MemberTurnRecord): ConversationMessage | undefined {
    if (!turn.sourceTurnId) return undefined;
    const row = this.sqlite.get<MessageRow>(
      `SELECT * FROM messages WHERE conversation_id = ? AND topic_id = ? AND run_id = ?
       AND role = 'bot' AND sender_bot_id = ?
       AND CASE WHEN json_valid(source_turn_json) THEN json_extract(source_turn_json, '$.turnId') END = ?`,
      [turn.conversationId, turn.topicId, turn.runId, turn.botId, turn.sourceTurnId],
    );
    return row ? mapMessage(row) : undefined;
  }

  getDispatchForRun(runId: string): PendingDispatch | undefined {
    const row = this.sqlite.get<DispatchRow>(
      `SELECT d.* FROM pending_dispatches d
       LEFT JOIN member_turns m ON m.id = d.member_turn_id
       WHERE d.run_id = ? ORDER BY m.batch ASC, m.member_index ASC, d.id ASC`,
      [runId],
    );
    return row ? mapDispatch(row) : undefined;
  }

  getDispatchForMemberTurn(memberTurnId: string): PendingDispatch | undefined {
    const row = this.sqlite.get<DispatchRow>("SELECT * FROM pending_dispatches WHERE member_turn_id = ?", [memberTurnId]);
    return row ? mapDispatch(row) : undefined;
  }

  listDispatchesForRun(runId: string): PendingDispatch[] {
    return this.sqlite.all<DispatchRow>(
      `SELECT d.* FROM pending_dispatches d
       LEFT JOIN member_turns m ON m.id = d.member_turn_id
       WHERE d.run_id = ? ORDER BY m.batch ASC, m.member_index ASC, d.id ASC`,
      [runId],
    ).map(mapDispatch);
  }

  recoverExpiredClaims(now: string, scope?: ClaimRecoveryScope): RecoveredClaim[] {
    return this.sqlite.transaction(() => {
      const claimed = this.expiredClaimRows(now, scope);
      const recovered: RecoveredClaim[] = [];
      for (const row of claimed) {
        const member = this.requireMemberTurn(row.member_turn_id);
        const run = this.requireRun(row.run_id);
        if (TERMINAL_RUN_STATES.includes(run.state)) {
          this.finishDispatch(row.id, now);
          continue;
        }
        if (member.startedAt) {
          if (this.retryEnforcedReadOnly(row, member, run, now)) {
            recovered.push({ dispatch: this.requireDispatch(row.id), run: this.requireRun(run.id),
              memberTurn: this.requireMemberTurn(member.id), outcome: "requeued" });
            continue;
          }
          const alreadyCounted = Boolean(member.finishedAt);
          this.sqlite.run(
            `UPDATE member_turns SET state = 'indeterminate', finished_at = COALESCE(finished_at, ?) WHERE id = ?`,
            [now, member.id],
          );
          if (!alreadyCounted) {
            this.sqlite.run(
              `UPDATE runs SET consumed_member_turns = consumed_member_turns + 1 WHERE id = ?`,
              [run.id],
            );
          }
          this.finishDispatchForMemberTurn(member.id, now);
          const settled = this.aggregateRunAfterMemberTerminal(run.id, member.id, now, "started_result_unknown");
          recovered.push({
            dispatch: this.requireDispatch(row.id),
            run: settled,
            memberTurn: this.requireMemberTurn(member.id),
            outcome: "indeterminate",
          });
          continue;
        }
        this.sqlite.run(
          `UPDATE pending_dispatches
           SET state = 'pending', owner = NULL, claimed_at = NULL, lease_expires_at = NULL, generation = generation + 1, authority_epoch = NULL, human_ingress = NULL
           WHERE id = ?`,
          [row.id],
        );
        this.sqlite.run(
          `UPDATE member_turns SET state = 'queued', attempt = attempt + 1, origin = 'recovery' WHERE id = ?`,
          [member.id],
        );
        this.recomputeRunSchedulingState(run.id, now);
        recovered.push({
          dispatch: this.requireDispatch(row.id),
          run: this.requireRun(run.id),
          memberTurn: this.requireMemberTurn(member.id),
          outcome: "requeued",
        });
      }
      return recovered;
    });
  }

  /**
   * Candidate selection is the scope fence. A Conversation or Topic teardown
   * must not see another resource's claims, even when those leases are already
   * expired. Unscoped recovery keeps the original dispatch scan so a corrupt
   * claim with no Run still fails closed inside the loop.
   */
  private expiredClaimRows(now: string, scope?: ClaimRecoveryScope): DispatchRow[] {
    const leasePredicate = `d.state = 'claimed'
           AND (
             (d.lease_expires_at IS NOT NULL AND d.lease_expires_at <= ?)
             OR (d.owner IS NULL AND d.lease_expires_at IS NULL)
           )`;
    if (scope?.conversationId === undefined && scope?.topicId === undefined) {
      return this.sqlite.all<DispatchRow>(
        `SELECT d.* FROM pending_dispatches d
         WHERE ${leasePredicate}`,
        [now],
      );
    }
    const conversationId = scope.conversationId ?? null;
    const topicId = scope.topicId ?? null;
    return this.sqlite.all<DispatchRow>(
      `SELECT d.* FROM pending_dispatches d
       JOIN runs r ON r.id = d.run_id
       WHERE ${leasePredicate}
         AND (? IS NULL OR r.conversation_id = ?)
         AND (? IS NULL OR r.topic_id = ?)`,
      [now, conversationId, conversationId, topicId, topicId],
    );
  }

  convergePreviousOwnerClaims(owner: string, now: string): RecoveredClaim[] {
    return this.sqlite.transaction(() => {
      const orphaned = this.sqlite.all<DispatchRow>(
        `SELECT * FROM pending_dispatches
         WHERE state = 'claimed'
           AND owner IS NOT NULL
           AND owner <> ?`,
        [owner],
      );
      const converged: RecoveredClaim[] = [];
      for (const row of orphaned) {
        const member = this.requireMemberTurn(row.member_turn_id);
        const run = this.requireRun(row.run_id);
        if (TERMINAL_RUN_STATES.includes(run.state)) {
          // Already finished business: finish the dispatch identically to
          // the normal recovery path (no entry — nothing converged).
          this.finishDispatch(row.id, now);
          continue;
        }
        if (member.startedAt) {
          if (this.retryEnforcedReadOnly(row, member, run, now)) {
            converged.push({ dispatch: this.requireDispatch(row.id), run: this.requireRun(run.id),
              memberTurn: this.requireMemberTurn(member.id), outcome: "requeued" });
            continue;
          }
          // Crash-after-start under the consumer lock: the previous owner is
          // proven gone, so seal immediately through the same started branch
          // as lease recovery — never wait out the old lease, never
          // re-execute. Statement-for-statement identical to
          // recoverExpiredClaims() above.
          const alreadyCounted = Boolean(member.finishedAt);
          this.sqlite.run(
            `UPDATE member_turns SET state = 'indeterminate', finished_at = COALESCE(finished_at, ?) WHERE id = ?`,
            [now, member.id],
          );
          if (!alreadyCounted) {
            this.sqlite.run(
              `UPDATE runs SET consumed_member_turns = consumed_member_turns + 1 WHERE id = ?`,
              [run.id],
            );
          }
          this.finishDispatchForMemberTurn(member.id, now);
          const settled = this.aggregateRunAfterMemberTerminal(run.id, member.id, now, "started_result_unknown");
          converged.push({
            dispatch: this.requireDispatch(row.id),
            run: settled,
            memberTurn: this.requireMemberTurn(member.id),
            outcome: "indeterminate",
          });
          continue;
        }
        this.sqlite.run(
          `UPDATE pending_dispatches
           SET state = 'pending', owner = NULL, claimed_at = NULL, lease_expires_at = NULL
           WHERE id = ?`,
          [row.id],
        );
        converged.push({
          dispatch: this.requireDispatch(row.id),
          run: this.requireRun(row.run_id),
          memberTurn: this.requireMemberTurn(row.member_turn_id),
          outcome: "requeued",
        });
      }
      // A late proof or partial cancel fan-out may have finished every member
      // before the old consumer died, leaving no claimed row to converge.
      // Settle that durable intent from evidence before any new consumer kick.
      const cancellations = this.sqlite.all<RunRow>(
        "SELECT * FROM runs WHERE state IN ('queued', 'running') AND completion_reason IS NOT NULL",
      );
      for (const row of cancellations) {
        const run = mapRun(row);
        if (!isRunCancelling(run)) continue;
        const batchMembers = this.listMemberTurns(run.id).filter((turn) => turn.batch === (run.activeBatch ?? 1));
        if (batchMembers.length === 0 || batchMembers.some((turn) => !TERMINAL_MEMBER_STATES.includes(turn.state))) continue;
        const anchor = batchMembers.find((turn) => turn.state === "indeterminate")
          ?? batchMembers.find((turn) => turn.state === "failed") ?? batchMembers[0]!;
        this.aggregateRunAfterMemberTerminal(run.id, anchor.id, now,
          anchor.state === "indeterminate" ? "started_result_unknown" : anchor.failureReason, true);
      }
      return converged;
    });
  }

  retirePreviousOwnerClaims(owner: string): string[] {
    return this.sqlite.transaction(() => {
      const orphaned = this.sqlite.all<DispatchRow>(
        `SELECT * FROM pending_dispatches
         WHERE state = 'claimed'
           AND owner IS NOT NULL
           AND owner <> ?`,
        [owner],
      );
      const retired: string[] = [];
      for (const row of orphaned) {
        const member = this.requireMemberTurn(row.member_turn_id);
        const run = this.requireRun(row.run_id);
        if (TERMINAL_RUN_STATES.includes(run.state)) {
          // Already finished business: leave it for the normal recovery path,
          // which finishes terminal-run dispatches identically.
          continue;
        }
        if (member.startedAt) {
          // Crash-after-start is indeterminate territory: converge seals it;
          // this unstarted-only seam leaves it untouched.
          continue;
        }
        this.sqlite.run(
          `UPDATE pending_dispatches
           SET state = 'pending', owner = NULL, claimed_at = NULL, lease_expires_at = NULL
           WHERE id = ?`,
          [row.id],
        );
        retired.push(row.id);
      }
      return retired;
    });
  }

  /**
   * Recompute Run scheduling state after one member re-queues (pre-start
   * recovery or claim release). Never blindly resets to queued: when any
   * sibling already started, the Run stays running with started_at intact so
   * one-active-Run-per-Topic keeps holding. Only a Run with zero started
   * members returns to queued (and clears started_at).
   */
  private recomputeRunSchedulingState(runId: string, now: string): void {
    const run = this.requireRun(runId);
    if (TERMINAL_RUN_STATES.includes(run.state)) {
      return;
    }
    const members = this.listMemberTurns(runId);
    const anyStarted = members.some((turn) => Boolean(turn.startedAt));
    if (anyStarted) {
      if (run.state === "queued") {
        this.sqlite.run(`UPDATE runs SET state = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?`, [now, runId]);
      }
      return;
    }
    this.sqlite.run(`UPDATE runs SET state = 'queued', started_at = NULL WHERE id = ?`, [runId]);
  }

  /** Only pre-execution enforced capability proves retry safety. At most one
   * started retry per assignment; not-started redelivery never spends again. */
  private retryEnforcedReadOnly(row: DispatchRow, member: MemberTurnRecord, run: ConversationRun, now: string): boolean {
    if (run.conversationId === createDirectConversationId(member.botId) || isRunCancelling(run)
      || member.effect !== "read-only" || member.effectProvenance !== "declared-enforced"
      || !member.sourceTurnId || TERMINAL_MEMBER_STATES.includes(member.state)
      || this.allocatedWork(run.id) >= run.maxMemberTurns
      // A read-only filesystem capability does not prove that repeating
      // orchestration after a committed downstream handoff is safe.
      || this.sqlite.get("SELECT 1 FROM member_turns WHERE handoff_source_turn_id = ?", [member.sourceTurnId])
      || this.sqlite.get("SELECT 1 FROM recovery_attempts WHERE member_turn_id = ?", [member.id])) return false;
    if (this.isConversationDeleting(run.conversationId) || this.isTopicDeleting(run.topicId)) return false;
    this.sqlite.run(`INSERT INTO recovery_attempts (member_turn_id, run_id, source_turn_id, generation, created_at)
      VALUES (?, ?, ?, ?, ?)`, [member.id, run.id, member.sourceTurnId, row.generation, now]);
    this.sqlite.run(`UPDATE member_turns SET state = 'queued', origin = 'recovery', attempt = attempt + 1,
      started_at = NULL, finished_at = NULL, source_turn_id = NULL, queue_item_id = NULL WHERE id = ?`, [member.id]);
    this.sqlite.run(`UPDATE pending_dispatches SET state = 'pending', generation = generation + 1,
      owner = NULL, claimed_at = NULL, lease_expires_at = NULL, authority_epoch = NULL, human_ingress = NULL WHERE id = ?`, [row.id]);
    this.sqlite.run("UPDATE runs SET consumed_member_turns = consumed_member_turns + 1 WHERE id = ?", [run.id]);
    return true;
  }

  claimNextDispatch(input: ClaimNextDispatchInput): ClaimedWork | undefined {
    return this.sqlite.transaction(() => {
      const limits = input.topicConcurrencyLimits ?? {};
      for (const limit of Object.values(limits)) {
        memberConcurrencyLimit(limit);
      }
      const capacityClause = Object.keys(limits).length === 0 ? "" : `AND NOT EXISTS (
        SELECT 1 FROM json_each(?) capacity WHERE capacity.key = r.topic_id
          AND (SELECT COUNT(*) FROM pending_dispatches reserved
            JOIN runs reserved_run ON reserved_run.id = reserved.run_id
            WHERE reserved_run.topic_id = r.topic_id AND reserved.state = 'claimed') >= capacity.value
      )`;
      const skipTopicIds = input.skipTopicIds ?? [];
      const skipClause = skipTopicIds.length === 0
        ? ""
        : `AND r.topic_id NOT IN (${skipTopicIds.map(() => "?").join(",")})`;
      const params: string[] = [...skipTopicIds];
      // Same-batch sibling cohort: once the drain launched one execution,
      // only siblings of that Run may be admitted concurrently. Unrelated
      // Topics/Bots wait for the next pass (global sequencing preserved).
      const runClause = input.runId !== undefined ? `AND r.id = ?` : "";
      if (input.runId !== undefined) {
        params.push(input.runId);
      }
      if (capacityClause) params.push(JSON.stringify(limits));
      const row = this.sqlite.get<DispatchRow>(
        `SELECT d.* FROM pending_dispatches d
         JOIN runs r ON r.id = d.run_id
         JOIN member_turns m ON m.id = d.member_turn_id
         LEFT JOIN messages msg ON msg.id = r.request_message_id
         WHERE d.state = 'pending'
           AND r.state IN ('queued', 'running')
           AND r.completion_reason IS NULL
           AND m.started_at IS NULL
           AND m.state IN ('queued', 'dispatched')
           AND NOT EXISTS (
             SELECT 1 FROM member_turns same_bot WHERE same_bot.run_id = m.run_id
               AND same_bot.bot_id = m.bot_id AND same_bot.id <> m.id
               AND same_bot.state IN ('running', 'dispatched')
           )
           AND NOT EXISTS (
             SELECT 1 FROM conversation_lifecycle c
             WHERE c.conversation_id = r.conversation_id AND c.state = 'deleting'
           )
           AND NOT EXISTS (
             SELECT 1 FROM topic_lifecycle t
             WHERE t.topic_id = r.topic_id AND t.state = 'deleting'
           )
           AND NOT EXISTS (
             SELECT 1 FROM pending_dispatches claimed
             JOIN runs claimed_run ON claimed_run.id = claimed.run_id
             WHERE claimed_run.topic_id = r.topic_id
               AND claimed_run.id <> r.id
               AND claimed.state = 'claimed'
           )
           AND NOT EXISTS (
             SELECT 1 FROM runs active
             WHERE active.topic_id = r.topic_id
               AND active.id <> r.id
               AND active.state IN ('running', 'waiting-human')
           )
           AND NOT EXISTS (
             SELECT 1 FROM runs earlier JOIN messages request ON request.id = earlier.request_message_id
             WHERE earlier.topic_id = r.topic_id AND earlier.id <> r.id
               AND earlier.state = 'queued' AND earlier.mode = 'automatic'
               AND request.seq < msg.seq
           )
           ${skipClause}
           ${runClause}
           ${capacityClause}
           ${SEQUENTIAL_DEPENDENCY_FENCE}
         ORDER BY msg.seq ASC, r.created_at ASC, r.topic_id ASC, m.batch ASC, m.member_index ASC, d.id ASC
         LIMIT 1`,
        params,
      );
      if (!row) {
        return undefined;
      }
      this.sqlite.run(
        `UPDATE pending_dispatches
         SET state = 'claimed', owner = ?, claimed_at = ?, lease_expires_at = ?
         WHERE id = ? AND state = 'pending'`,
        [input.owner, input.now, input.leaseExpiresAt, row.id],
      );
      const executionOrigin = conversationExecutionOrigin(
        optionalString(row.authority_epoch),
        input.authorityEpoch,
        parseStoredHumanIngress(row.human_ingress),
      );
      // Provenance is durable at accept and never rewritten by claim:
      // claiming only moves queued -> dispatched. Permission authority still
      // derives per-dispatch from authorityEpoch + ingress (human vs
      // orchestration), independent of this field.
      this.sqlite.run(
        `UPDATE member_turns SET state = 'dispatched' WHERE id = ? AND state = 'queued'`,
        [row.member_turn_id],
      );
      if (executionOrigin !== "human") {
        this.sqlite.run(
          `UPDATE pending_dispatches SET authority_epoch = NULL, human_ingress = NULL WHERE id = ?`,
          [row.id],
        );
      }
      return {
        dispatch: this.requireDispatch(row.id),
        run: this.requireRun(row.run_id),
        memberTurn: this.requireMemberTurn(row.member_turn_id),
        memberSnapshot: this.requireMemberTurn(row.member_turn_id).profileSnapshot
          ?? this.requireRun(row.run_id).profileSnapshot,
      };
    });
  }

  hasDurableBotWork(botId: string): boolean {
    const conversationId = createDirectConversationId(botId);
    if (this.sqlite.get("SELECT 1 AS ok FROM conversation_bindings WHERE conversation_id = ? LIMIT 1", [conversationId])) return true;
    if (this.sqlite.get("SELECT 1 AS ok FROM member_turns WHERE bot_id = ? LIMIT 1", [botId])) {
      return true;
    }
    if (this.sqlite.get("SELECT 1 AS ok FROM runs WHERE conversation_id = ? LIMIT 1", [conversationId])) {
      return true;
    }
    if (this.sqlite.get(
      "SELECT 1 AS ok FROM messages WHERE conversation_id = ? OR sender_bot_id = ? LIMIT 1",
      [conversationId, botId],
    )) {
      return true;
    }
    if (this.sqlite.get(
      `SELECT 1 AS ok FROM pending_dispatches d
       JOIN member_turns m ON m.id = d.member_turn_id
       WHERE m.bot_id = ?
       LIMIT 1`,
      [botId],
    )) {
      return true;
    }
    if (this.sqlite.get(
      "SELECT 1 AS ok FROM conversation_lifecycle WHERE conversation_id = ? LIMIT 1",
      [conversationId],
    )) {
      return true;
    }
    return Boolean(this.sqlite.get(
      "SELECT 1 AS ok FROM topic_lifecycle WHERE conversation_id = ? LIMIT 1",
      [conversationId],
    ));
  }

  hasDurableGroupWork(conversationId: string): boolean {
    if (this.sqlite.get("SELECT 1 AS ok FROM conversation_bindings WHERE conversation_id = ? LIMIT 1", [conversationId])) return true;
    if (this.sqlite.get("SELECT 1 AS ok FROM runs WHERE conversation_id = ? LIMIT 1", [conversationId])) {
      return true;
    }
    if (this.sqlite.get("SELECT 1 AS ok FROM messages WHERE conversation_id = ? LIMIT 1", [conversationId])) {
      return true;
    }
    if (this.sqlite.get(
      `SELECT 1 AS ok FROM pending_dispatches d
       JOIN member_turns m ON m.id = d.member_turn_id
       WHERE m.conversation_id = ?
       LIMIT 1`,
      [conversationId],
    )) {
      return true;
    }
    if (this.sqlite.get(
      "SELECT 1 AS ok FROM conversation_lifecycle WHERE conversation_id = ? LIMIT 1",
      [conversationId],
    )) {
      return true;
    }
    if (this.sqlite.get(
      "SELECT 1 AS ok FROM topic_lifecycle WHERE conversation_id = ? LIMIT 1",
      [conversationId],
    )) {
      return true;
    }
    return Boolean(this.sqlite.get(
      "SELECT 1 AS ok FROM topic_seq WHERE conversation_id = ? LIMIT 1",
      [conversationId],
    ));
  }

  hasNonterminalGroupMemberWork(conversationId: string, botId: string): boolean {
    const row = this.sqlite.get<{ ok: number }>(
      `SELECT 1 AS ok FROM member_turns
       WHERE conversation_id = ? AND bot_id = ?
         AND state IN ('queued', 'dispatched', 'running')
       LIMIT 1`,
      [conversationId, botId],
    );
    return Boolean(row);
  }

  listNonterminalRunRoots(): Array<{ conversationId: string; topicId: string }> {
    const rows = this.sqlite.all<{ conversation_id: string; topic_id: string }>(
      `SELECT DISTINCT conversation_id, topic_id FROM runs
       WHERE state IN ('queued', 'running', 'waiting-human')`,
    );
    return rows.map((row) => ({ conversationId: row.conversation_id, topicId: row.topic_id }));
  }
  renewHeldClaim(input: RenewHeldClaimInput): PendingDispatch {
    return this.sqlite.transaction(() => {
      // Held-claim fence: everything EXCEPT lease expiry. The renewing drain
      // is alive and holds this claim, so an expired lease means "sibling
      // ran long", never "owner died". All real races still reject.
      const dispatch = this.requireHeldClaim({
        dispatchId: input.dispatchId,
        owner: input.owner,
        generation: input.generation,
      });
      const run = this.requireRun(dispatch.run_id);
      if (TERMINAL_RUN_STATES.includes(run.state)) {
        throw new ConversationError("stale_claim", "held claim belongs to a terminal run");
      }
      this.beforeLeaseRenewal?.();
      this.sqlite.run(
        `UPDATE pending_dispatches
         SET lease_expires_at = ?
         WHERE id = ? AND state = 'claimed' AND owner = ? AND generation = ?`,
        [input.leaseExpiresAt, dispatch.id, input.owner, input.generation],
      );
      return this.requireLiveRenewal(dispatch.id, input.owner, input.generation);
    });
  }

  renewInFlightClaim(input: RenewHeldClaimInput): PendingDispatch {
    return this.sqlite.transaction(() => {
      const dispatch = this.sqlite.get<DispatchRow>("SELECT * FROM pending_dispatches WHERE id = ?", [input.dispatchId]);
      if (!dispatch || dispatch.state !== "claimed" || dispatch.owner !== input.owner
        || Number(dispatch.generation) !== input.generation) {
        throw new ConversationError("stale_claim", "execution no longer owns its reservation");
      }
      const member = this.requireMemberTurn(dispatch.member_turn_id);
      const run = this.requireRun(dispatch.run_id);
      // A terminal row must not have its lease extended: that would hide it
      // from recovery and look like the execution was still admitted. A
      // cancelling Run whose member is still running stays renewable until
      // that member actually reaches a terminal state.
      if (TERMINAL_RUN_STATES.includes(run.state) || TERMINAL_MEMBER_STATES.includes(member.state)) {
        throw new ConversationError("stale_claim", "execution no longer owns its reservation");
      }
      this.beforeLeaseRenewal?.();
      // The caller still awaits this exact execute() promise. Its lease expiry
      // is elapsed provider time, not process-death evidence. CAS identity is
      // still required; never renew a recovered/replaced claim. The UPDATE
      // itself is fenced so a lost race cannot move lease_expires_at.
      this.sqlite.run(
        `UPDATE pending_dispatches
         SET lease_expires_at = ?
         WHERE id = ? AND state = 'claimed' AND owner = ? AND generation = ?`,
        [input.leaseExpiresAt, dispatch.id, input.owner, input.generation],
      );
      return this.requireLiveRenewal(dispatch.id, input.owner, input.generation);
    });
  }

  private requireLiveRenewal(dispatchId: string, owner: string, generation: number): PendingDispatch {
    const updated = this.requireDispatch(dispatchId);
    if (updated.state !== "claimed" || updated.owner !== owner || updated.generation !== generation) {
      throw new ConversationError("stale_claim", "execution no longer owns its reservation");
    }
    return updated;
  }

  retireHeldClaim(input: ClaimFenceInput): PendingDispatch {
    return this.sqlite.transaction(() => {
      // Same held-claim fence as renewal: everything EXCEPT lease expiry.
      // Shutdown is orderly, so an unexpired-or-expired live hold retires
      // identically — provenance preserved either way.
      const dispatch = this.requireHeldClaim({
        dispatchId: input.dispatchId,
        owner: input.owner,
        generation: input.generation,
      });
      this.sqlite.run(
        `UPDATE pending_dispatches
         SET state = 'pending', owner = NULL, claimed_at = NULL, lease_expires_at = NULL
         WHERE id = ?`,
        [dispatch.id],
      );
      return this.requireDispatch(dispatch.id);
    });
  }

  releaseClaimToPending(input: ReleaseClaimToPendingInput): PendingDispatch {
    return this.sqlite.transaction(() => {
      const dispatch = this.requireLiveUnstartedClaim(input);
      this.sqlite.run(
        `UPDATE pending_dispatches
         SET state = 'pending', owner = NULL, claimed_at = NULL, lease_expires_at = NULL, generation = generation + 1, authority_epoch = NULL, human_ingress = NULL
         WHERE id = ?`,
        [dispatch.id],
      );
      this.sqlite.run(
        `UPDATE member_turns SET state = 'queued', origin = 'recovery' WHERE id = ?`,
        [dispatch.member_turn_id],
      );
      this.recomputeRunSchedulingState(dispatch.run_id, input.now);
      return this.requireDispatch(dispatch.id);
    });
  }

  markExecutionStarted(input: MarkExecutionStartedInput): MemberTurnRecord {
    return this.sqlite.transaction(() => {
      this.requireLiveUnstartedClaim(input);
      const run = this.requireRun(input.runId);
      const member = this.requireMemberTurn(input.memberTurnId);
      if (TERMINAL_RUN_STATES.includes(run.state) || isRunCancelling(run) || TERMINAL_MEMBER_STATES.includes(member.state)) {
        throw new ConversationError("run_not_runnable", `run "${input.runId}" is ${run.state}`);
      }
      if (run.quarantinedBotIds?.includes(member.botId)) {
        throw new ConversationError("member_quarantined", "Bot is quarantined for this Run");
      }
      this.sqlite.run(
        `UPDATE member_turns
         SET state = 'running',
             session_alias = ?,
             logical_session_id = ?,
             source_turn_id = ?,
             queue_item_id = COALESCE(?, queue_item_id),
             started_at = ?
         WHERE id = ? AND started_at IS NULL`,
        [
          input.sessionAlias,
          input.logicalSessionId,
          input.sourceTurnId,
          input.queueItemId ?? null,
          input.now,
          input.memberTurnId,
        ],
      );
      this.sqlite.run(
        `UPDATE runs SET state = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?`,
        [input.now, input.runId],
      );
      const started = this.requireMemberTurn(input.memberTurnId);
      if (!started.startedAt) {
        throw new ConversationError("stale_claim", `dispatch "${input.dispatchId}" lost the execution-start fence`);
      }
      return started;
    });
  }

  assertLiveDispatchForMaterialize(input: AssertLiveDispatchForMaterializeInput): void {
    this.sqlite.transaction(() => {
      if (this.isConversationDeleting(input.conversationId)) {
        throw new ConversationError("conversation_deleting", `conversation "${input.conversationId}" is deleting`);
      }
      if (this.isTopicDeleting(input.topicId)) {
        throw new ConversationError("topic_deleting", `topic "${input.topicId}" is deleting`);
      }
      this.requireLiveUnstartedClaim(input);
      const run = this.requireRun(input.runId);
      const member = this.requireMemberTurn(input.memberTurnId);
      if (run.conversationId !== input.conversationId || run.topicId !== input.topicId) {
        throw new ConversationError("stale_claim", `dispatch "${input.dispatchId}" does not match conversation scope`);
      }
      if (TERMINAL_RUN_STATES.includes(run.state) || isRunCancelling(run) || TERMINAL_MEMBER_STATES.includes(member.state)) {
        throw new ConversationError("run_not_runnable", `run "${input.runId}" is ${run.state}`);
      }
      if (run.quarantinedBotIds?.includes(member.botId)) {
        throw new ConversationError("member_quarantined", "Bot is quarantined for this Run");
      }
    });
  }

  completeExecution(input: CompleteExecutionInput): CompleteExecutionResult {
    return this.sqlite.transaction(() => {
      const run = this.requireRun(input.runId);
      const member = this.requireMemberTurn(input.memberTurnId);
      // Referential fence: a settlement must never cross Run boundaries.
      // A mismatched (runId, memberTurnId) pair fails closed with zero
      // writes — no message, no progress, no dispatch change, no aggregate.
      if (
        member.runId !== run.id
        || member.conversationId !== run.conversationId
        || member.topicId !== run.topicId
      ) {
        throw new ConversationError(
          "run_member_mismatch",
          `member turn "${member.id}" does not belong to run "${run.id}"`,
        );
      }
      // Source correlation fence: the persisted sourceTurn must join exactly
      // to this member's execution-start identity. A caller-supplied alias or
      // turn id pointing at another turn's session would otherwise write a
      // transcript row that misattributes provenance. Unstarted members carry
      // no identity yet, so there is nothing to join against — skip there.
      if (input.sourceTurn.turnId && this.sqlite.get(
        "SELECT 1 FROM recovery_attempts WHERE member_turn_id = ? AND source_turn_id = ?", [member.id, input.sourceTurn.turnId])) {
        throw new ConversationError("source_turn_mismatch", "result belongs to a retired recovery attempt");
      }
      if (
        (member.sessionAlias !== undefined && input.sourceTurn.sessionAlias !== member.sessionAlias)
        || (member.sourceTurnId !== undefined && input.sourceTurn.turnId !== member.sourceTurnId)
      ) {
        throw new ConversationError(
          "source_turn_mismatch",
          `source turn does not match member turn "${member.id}" execution identity`,
        );
      }
      if (run.state === "cancelled") {
        this.finishDispatchForMemberTurn(member.id, input.now);
        if (!member.finishedAt) {
          this.sqlite.run(
            `UPDATE member_turns SET state = 'cancelled', finished_at = ? WHERE id = ?`,
            [input.now, member.id],
          );
        }
        return {
          run: this.requireRun(run.id),
          memberTurn: this.requireMemberTurn(member.id),
          resurrected: false,
        };
      }
      if (run.state === "indeterminate") {
        // Sealed Run: scheduling stays dead, but proof from an execution
        // that was already admitted (started) before the seal is durable
        // evidence, not a scheduling decision — reconcile it (reclassify
        // this member, re-derive the Run from the whole batch; an unknown
        // sibling keeps it indeterminate). Anything without execution
        // identity falls through to the evidence no-op below.
        if (member.state === "indeterminate" && member.startedAt) {
          const evidence = this.persistSealedMemberEvidence({
            runId: run.id,
            memberTurnId: member.id,
            outcome: "completed",
            content: input.content,
            sourceTurn: input.sourceTurn,
            now: input.now,
          });
          return {
            run: evidence.run,
            memberTurn: evidence.memberTurn,
            assistantMessage: evidence.message,
            resurrected: false,
          };
        }
        this.finishDispatchForMemberTurn(member.id, input.now);
        return {
          run,
          memberTurn: member,
          resurrected: false,
        };
      }
      if (run.state === "completed" || run.state === "failed") {
        return { run, memberTurn: member, resurrected: false };
      }
      if (TERMINAL_MEMBER_STATES.includes(member.state)) {
        // Idempotent replay: this member already reached a terminal state
        // (late provider settlement, recovery redelivery). No new message,
        // no double progress count; the Run aggregate already observed it.
        return { run, memberTurn: member, resurrected: false };
      }
      const seq = this.allocateSeq(run.conversationId, run.topicId);
      const messageId = this.ids.messageId();
      this.sqlite.run(
        `INSERT INTO messages (
           id, conversation_id, topic_id, seq, role, sender_bot_id, content, run_id, source_turn_json, created_at
         ) VALUES (?, ?, ?, ?, 'bot', ?, ?, ?, ?, ?)`,
        [
          messageId,
          run.conversationId,
          run.topicId,
          seq,
          // Sender derives from the member turn itself, never from a
          // caller-supplied botId: a mismatched caller value cannot
          // misattribute the transcript.
          member.botId,
          input.content,
          run.id,
          JSON.stringify(input.sourceTurn),
          input.now,
        ],
      );
      this.sqlite.run(
        `UPDATE member_turns SET state = 'completed', finished_at = ? WHERE id = ?`,
        [input.now, member.id],
      );
      this.sqlite.run(
        `UPDATE runs SET consumed_member_turns = consumed_member_turns + 1 WHERE id = ?`,
        [run.id],
      );
      this.finishDispatchForMemberTurn(member.id, input.now);
      const aggregated = this.aggregateRunAfterMemberTerminal(
        run.id,
        member.id,
        input.now,
        input.completionReason,
        input.forceRunTerminalOnSettle ?? false,
      );
      return {
        run: aggregated,
        memberTurn: this.requireMemberTurn(member.id),
        assistantMessage: this.getMessage(messageId),
        resurrected: false,
      };
    });
  }
  /**
   * Persist proven evidence for a sealed indeterminate member WITHOUT
   * touching scheduling: reclassify this member to its proven outcome and
   * re-derive the Run from the whole batch (an unknown sibling keeps it
   * indeterminate). Shared by completeExecution/failExecution when a proof
   * lands for an already-started member after the Run sealed, and by
   * reconcileLateResult (late provider settlement). Progress counts exactly
   * once (the seal already counted this member); the Run aggregate never
   * resurrects scheduling — classifySettledBatch only sets Run-level
   * state/reason/finished_at.
   */
  private persistSealedMemberEvidence(input: {
    runId: string;
    memberTurnId: string;
    outcome: "completed" | "failed";
    content?: string;
    reason?: string;
    sourceTurn: { sessionAlias: string; turnId?: string };
    now: string;
  }): { run: ConversationRun; memberTurn: MemberTurnRecord; message?: ConversationMessage } {
    const run = this.requireRun(input.runId);
    const member = this.requireMemberTurn(input.memberTurnId);
    if (member.runId !== run.id || member.state !== "indeterminate") {
      throw new ConversationError("stale_claim", `member turn "${input.memberTurnId}" is not sealed evidence for run "${run.id}"`);
    }
    let message: ConversationMessage | undefined;
    if (input.outcome === "completed") {
      const seq = this.allocateSeq(run.conversationId, run.topicId);
      const messageId = this.ids.messageId();
      this.sqlite.run(
        `INSERT INTO messages (
           id, conversation_id, topic_id, seq, role, sender_bot_id, content, run_id, source_turn_json, created_at
         ) VALUES (?, ?, ?, ?, 'bot', ?, ?, ?, ?, ?)`,
        [
          messageId,
          run.conversationId,
          run.topicId,
          seq,
          member.botId,
          input.content ?? "",
          run.id,
          JSON.stringify(input.sourceTurn),
          input.now,
        ],
      );
      this.sqlite.run(
        `UPDATE member_turns SET state = 'completed', failure_reason = NULL WHERE id = ?`,
        [member.id],
      );
      message = this.getMessage(messageId);
    } else {
      this.sqlite.run(
        `UPDATE member_turns SET state = 'failed', failure_reason = ? WHERE id = ?`,
        [input.reason ?? "failed", member.id],
      );
      if (!this.requireRun(run.id).failedBotIds.includes(member.botId)) {
        const failed = [...this.requireRun(run.id).failedBotIds, member.botId];
        this.sqlite.run(
          `UPDATE runs SET failed_bot_ids_json = ? WHERE id = ?`,
          [JSON.stringify(failed), run.id],
        );
      }
    }
    this.finishDispatchForMemberTurn(member.id, input.now);
    const members = this.listMemberTurns(run.id);
    const batch = run.activeBatch ?? 1;
    const reconciledRun = this.classifySettledBatch(
      run.id,
      members.filter((turn) => turn.batch === batch),
      input.now,
      input.outcome === "failed" ? (input.reason ?? "execution-failed") : undefined,
    );
    return {
      run: reconciledRun,
      memberTurn: this.requireMemberTurn(member.id),
      ...(message ? { message } : {}),
    };
  }

  failExecution(input: FailExecutionInput): ConversationRun {
    return this.sqlite.transaction(() => this.applyFailExecution(input));
  }

  failClaimBeforeStart(input: FailClaimBeforeStartInput): ConversationRun {
    return this.sqlite.transaction(() => {
      this.requireLiveUnstartedClaim(input);
      return this.applyFailExecution(input);
    });
  }

  completeCancel(runId: string, memberTurnId: string, now: string, indeterminate = false, forceRunTerminal = false, sourceTurnId?: string): ConversationRun {
    return this.failExecution({
      runId,
      memberTurnId,
      sourceTurnId: sourceTurnId ?? this.requireMemberTurn(memberTurnId).sourceTurnId,
      now,
      reason: indeterminate ? "started_result_unknown" : "cancelled",
      terminalState: indeterminate ? "indeterminate" : "cancelled",
      // Unknown side effects always seal the Run: no sibling may start after
      // unproven execution, in either mode. Plain cancelled defers to the
      // caller; force=true persists whole-Run intent before siblings settle.
      forceRunTerminalOnSettle: forceRunTerminal || indeterminate,
    });
  }

  settleCancelBatch(input: SettleCancelBatchInput): SettleCancelBatchResult {
    return this.sqlite.transaction(() => {
      const run = this.requireRun(input.runId);
      // Referential fence FIRST (same invariant as the write path below):
      // resolve every outcome member and prove it belongs to input.runId
      // before the terminal idempotent early-return. Otherwise a terminal
      // Run A + MemberTurn B would return a mismatched pair to the caller,
      // and future event projection could emit the wrong Run/member join.
      // Zero writes happen on this path either way; the fence keeps the
      // returned join referentially sound.
      const seen = new Set<string>();
      const members = input.outcomes.map((entry) => {
        if (seen.has(entry.memberTurnId)) {
          throw new ConversationError("duplicate_member", `cancel batch lists member turn "${entry.memberTurnId}" twice`);
        }
        seen.add(entry.memberTurnId);
        return this.requireMemberTurn(entry.memberTurnId);
      });
      for (const member of members) {
        if (member.runId !== input.runId) {
          throw new ConversationError("stale_claim", `member turn "${member.id}" does not belong to run "${input.runId}"`);
        }
      }
      if (TERMINAL_RUN_STATES.includes(run.state)) {
        return {
          run,
          settled: input.outcomes.map((entry, index) => ({
            member: members[index]!,
            outcome: entry.outcome,
          })),
        };
      }
      // Phase 1: persist every member's observed physical outcome as member
      // evidence. Proven outcomes win per-member: a member that already
      // reached a terminal state keeps it (idempotent fence); an unknown
      // never overwrites a sibling's proven evidence, and proven evidence
      // is never downgraded by a later unknown.
      const settled: SettledCancelMember[] = [];
      for (let index = 0; index < input.outcomes.length; index++) {
        const entry = input.outcomes[index]!;
        const member = members[index]!;
        if (TERMINAL_MEMBER_STATES.includes(member.state)) {
          settled.push({ member, outcome: entry.outcome });
          continue;
        }
        if (entry.outcome === "completed") {
          // Source correlation fence (same invariant as completeExecution):
          // a completed entry's sourceTurn must join to this member's
          // execution-start identity, never another turn's session.
          if (
            (member.sessionAlias !== undefined
              && (entry.sourceTurn?.sessionAlias ?? member.sessionAlias ?? "") !== member.sessionAlias)
            || (member.sourceTurnId !== undefined && entry.sourceTurn?.turnId !== member.sourceTurnId)
          ) {
            throw new ConversationError(
              "source_turn_mismatch",
              `source turn does not match member turn "${member.id}" execution identity`,
            );
          }
          const seq = this.allocateSeq(run.conversationId, run.topicId);
          const messageId = this.ids.messageId();
          this.sqlite.run(
            `INSERT INTO messages (
               id, conversation_id, topic_id, seq, role, sender_bot_id, content, run_id, source_turn_json, created_at
             ) VALUES (?, ?, ?, ?, 'bot', ?, ?, ?, ?, ?)`,
            [
              messageId,
              run.conversationId,
              run.topicId,
              seq,
              member.botId,
              entry.content ?? "",
              run.id,
              JSON.stringify(entry.sourceTurn ?? { sessionAlias: member.sessionAlias ?? "" }),
              input.now,
            ],
          );
          this.sqlite.run(
            `UPDATE member_turns SET state = 'completed', finished_at = ? WHERE id = ?`,
            [input.now, member.id],
          );
          this.sqlite.run(
            `UPDATE runs SET consumed_member_turns = consumed_member_turns + 1 WHERE id = ?`,
            [run.id],
          );
          this.finishDispatchForMemberTurn(member.id, input.now);
          settled.push({
            member: this.requireMemberTurn(member.id),
            outcome: entry.outcome,
            message: this.getMessage(messageId),
          });
          continue;
        }
        const state = entry.outcome === "failed"
          ? "failed"
          : entry.outcome === "unknown"
            ? "indeterminate"
            : "cancelled";
        this.sqlite.run(
          `UPDATE member_turns SET state = ?, finished_at = ?, failure_reason = ? WHERE id = ?`,
          [state, input.now, entry.outcome === "failed" ? (entry.reason ?? "failed") : null, member.id],
        );
        this.sqlite.run(
          `UPDATE runs SET consumed_member_turns = consumed_member_turns + 1 WHERE id = ?`,
          [run.id],
        );
        this.finishDispatchForMemberTurn(member.id, input.now);
        settled.push({ member: this.requireMemberTurn(member.id), outcome: entry.outcome });
      }
      // Phase 2: aggregate the Run once, from whole-batch evidence — unless
      // deferred (a sibling physical cancel threw): then member evidence
      // stays durable without aggregation, and retry re-derives the outcome
      // from complete evidence. Whole-run cancel always force-terminals
      // (human cancel ends the Run, including automatic Runs awaiting
      // routing). Indeterminate outranks failed; proven member evidence above
      // is never rewritten by this step (it only sets Run-level
      // state/reason/finished_at). Accumulate failedBotIds for EVERY failed
      // member here: the aggregate only attributes its anchor member, which
      // may be the unknown one.
      const failedIds = new Set(this.requireRun(input.runId).failedBotIds);
      for (const entry of settled) {
        const fresh = this.requireMemberTurn(entry.member.id);
        if (fresh.state === "failed") {
          failedIds.add(fresh.botId);
        }
      }
      if (failedIds.size > 0) {
        this.sqlite.run(`UPDATE runs SET failed_bot_ids_json = ? WHERE id = ?`, [JSON.stringify([...failedIds]), input.runId]);
      }
      if (input.deferRunAggregate === true) {
        return {
          run: this.requireRun(input.runId),
          settled: settled.map((entry) => ({
            member: this.requireMemberTurn(entry.member.id),
            outcome: entry.outcome,
            ...(entry.message ? { message: entry.message } : {}),
          })),
        };
      }
      const anchorEntry = settled.find((entry) => entry.outcome === "unknown")
        ?? settled.find((entry) => TERMINAL_MEMBER_STATES.includes(entry.member.state))
        ?? settled[0];
      if (!anchorEntry) {
        return { run: this.requireRun(input.runId), settled };
      }
      // Anchor reason mirrors the anchor member's actual outcome — never a
      // hardcoded "cancelled". Single-member runs preserve the diagnostic
      // (failed reason, started_result_unknown); multi-member batches derive
      // theirs in the aggregate (unknown > failed/cancelled mixes).
      const anchorReason = anchorEntry.outcome === "unknown"
        ? "started_result_unknown"
        : anchorEntry.outcome === "failed"
          ? (input.outcomes.find((o) => o.memberTurnId === anchorEntry.member.id)?.reason ?? "failed")
          : anchorEntry.outcome === "cancelled"
            ? "cancelled"
            : undefined;
      const aggregated = this.aggregateRunAfterMemberTerminal(
        input.runId,
        anchorEntry.member.id,
        input.now,
        anchorReason,
        true,
      );
      return {
        run: aggregated,
        settled: settled.map((entry) => ({
          member: this.requireMemberTurn(entry.member.id),
          outcome: entry.outcome,
          ...(entry.message ? { message: entry.message } : {}),
        })),
      };
    });
  }
  cancelRun(runId: string, now: string, reason = "cancelled"): CancelRunResult {
    return this.sqlite.transaction(() => {
      const run = this.requireRun(runId);
      const members = this.listMemberTurns(runId);
      if (!TERMINAL_RUN_STATES.includes(run.state)) {
        // A real human Stop supersedes a prior execution cancellation while
        // the Run is still live. Keep this provenance across an unknown seal.
        this.sqlite.run("UPDATE runs SET cancellation_reason = 'human-cancelled' WHERE id = ?", [runId]);
      }
      const member = members[0];
      if (!member) {
        if (run.mode !== "automatic") {
          throw new ConversationError("member_turn_missing", `run "${runId}" has no member turn`);
        }
        const alreadyTerminal = TERMINAL_RUN_STATES.includes(run.state);
        if (!alreadyTerminal) {
          this.sqlite.run(
            "UPDATE runs SET state = 'cancelled', completion_reason = ?, routing_state = 'done', finished_at = ? WHERE id = ?",
            ["human-cancelled", now, runId],
          );
        }
        return { run: this.requireRun(runId), alreadyTerminal, executionStarted: false, activeMembers: [] };
      }
      if (TERMINAL_RUN_STATES.includes(run.state)) {
        return {
          run,
          memberTurn: member,
          dispatch: this.requireDispatchForMemberTurn(member.id),
          alreadyTerminal: true,
          executionStarted: false,
          activeMembers: [],
        };
      }
      if (run.mode === "automatic"
        && members.every((turn) => TERMINAL_MEMBER_STATES.includes(turn.state) && turn.state !== "indeterminate")) {
        // Settled members are evidence of earlier work, not the outcome of a
        // human Stop while the Router is deciding or waiting for input.
        this.sqlite.run(
          "UPDATE runs SET state = 'cancelled', completion_reason = ?, routing_state = 'done', finished_at = ? WHERE id = ?",
          ["human-cancelled", now, runId],
        );
        return {
          run: this.requireRun(runId), memberTurn: member,
          dispatch: this.requireDispatchForMemberTurn(member.id),
          alreadyTerminal: false, executionStarted: false, activeMembers: [],
        };
      }
      // Settle every never-started sibling in the same transaction so no new
      // dispatch can escape the cancel: queued/dispatched members become
      // cancelled and their dispatch intents complete. Started members stay
      // for the dispatcher to cancel exactly (per-active turn below).
      this.cancelUnstartedMembers(runId, now);
      const settled = this.listMemberTurns(runId);
      const stillActive = settled.filter(
        (turn) => Boolean(turn.startedAt) && !TERMINAL_MEMBER_STATES.includes(turn.state),
      );
      if (stillActive.length === 0) {
        // Nothing executing: the whole Run terminals now via the aggregate,
        // forced even on automatic Runs (human cancel ends the Run; the
        // Router never resumes a cancelled Run).
        const currentBatch = settled.filter((turn) => turn.batch === (run.activeBatch ?? 1));
        const aggregateAnchor = currentBatch.find((turn) => TERMINAL_MEMBER_STATES.includes(turn.state))
          ?? currentBatch[0] ?? settled[0]!;
        const terminal = this.aggregateRunAfterMemberTerminal(runId, aggregateAnchor.id, now, reason, true);
        return {
          run: terminal,
          memberTurn: this.requireMemberTurn(aggregateAnchor.id),
          dispatch: this.requireDispatchForMemberTurn(aggregateAnchor.id),
          alreadyTerminal: false,
          executionStarted: false,
          activeMembers: [],
        };
      }
      // Cancelling intent for active turns; the dispatcher records each
      // outcome after observing the underlying cancel. Aggregate stays
      // non-terminal until every active turn settles.
      this.sqlite.run(`UPDATE runs SET completion_reason = ? WHERE id = ?`, [reason, runId]);
      const firstActive = stillActive[0]!;
      return {
        run: this.requireRun(runId),
        memberTurn: this.requireMemberTurn(firstActive.id),
        dispatch: this.requireDispatchForMemberTurn(firstActive.id),
        alreadyTerminal: false,
        executionStarted: true,
        activeMembers: stillActive.map((turn) => this.requireMemberTurn(turn.id)),
      };
    });
  }

  failRun(runId: string, reason: string, state: "failed", now: string, routingGeneration?: number): ConversationRun {
    return this.sqlite.transaction(() => {
      const run = this.requireRun(runId);
      if (run.mode !== "automatic") {
        throw new ConversationError("routing_not_automatic", `run "${runId}" is not automatic`);
      }
      if (TERMINAL_RUN_STATES.includes(run.state)) {
        // Already sealed: a second settlement never rewrites the evidence
        // (idempotent, and a late Router failure cannot overwrite a cancel).
        return run;
      }
      if (isRunCancelling(run)) return run;
      if (routingGeneration !== undefined
        && (run.routingGeneration !== routingGeneration || run.routingState !== "routing")) {
        return run;
      }
      this.sqlite.run(
        `UPDATE runs SET state = ?, completion_reason = ?, routing_state = 'done',
           finished_at = COALESCE(finished_at, ?)
         WHERE id = ?`,
        [state, reason, now, runId],
      );
      this.finishDispatchForRun(runId, now);
      return this.requireRun(runId);
    });
  }

  markRoutingState(
    runId: string,
    state: ConversationRoutingState,
    now: string,
  ): ConversationRun {
    return this.sqlite.transaction(() => {
      const run = this.requireRun(runId);
      // Only automatic Runs route. An explicit Run NEVER gains a routing
      // state: routing on explicit work would invoke the Router against a
      // Run that already carries human-selected members (§14.1).
      if (run.mode !== "automatic") {
        throw new ConversationError(
          "routing_not_automatic",
          `run "${runId}" is ${run.mode}, not automatic; routing does not apply`,
        );
      }
      // Terminal Runs are sealed: their evidence is final and no routing
      // transition may resurrect scheduling (cancel/indeterminate/complete).
      if (TERMINAL_RUN_STATES.includes(run.state)) {
        throw new ConversationError("run_terminal", `run "${runId}" is ${run.state}; routing is sealed`);
      }
      if (isRunCancelling(run)) {
        throw new ConversationError("run_cancelling", `run "${runId}" has durable cancel intent`);
      }
      if (run.state === "waiting-human") {
        throw new ConversationError("routing_invalid_transition", "waiting-human requires a new human request");
      }
      if (this.isConversationDeleting(run.conversationId) || this.isTopicDeleting(run.topicId)) {
        throw new ConversationError("conversation_deleting", "routing cannot acquire a deleting Topic");
      }
      if (this.topicHasEarlierOrActiveRun(run)) {
        throw new ConversationError("routing_topic_busy", "routing must wait for the earlier Topic Run");
      }
      if (this.listMemberTurns(runId).some((turn) => !TERMINAL_MEMBER_STATES.includes(turn.state))) {
        throw new ConversationError("routing_batch_active", `run "${runId}" has unsettled members`);
      }
      if (state !== "routing") {
        // `done` is written together with a terminal Run state by
        // applyRoutingDecision, never on its own.
        throw new ConversationError("routing_invalid_transition", "only routing may acquire a decision generation");
      }
      this.sqlite.run(
        `UPDATE runs SET routing_state = ?, routing_generation = routing_generation + 1,
           state = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?`,
        [state, now, runId],
      );
      return this.requireRun(runId);
    });
  }

  applyRoutingDecision(input: ApplyRoutingDecisionInput): ApplyRoutingDecisionResult {
    return this.sqlite.transaction(() => {
      const run = this.requireRun(input.runId);
      if (run.mode !== "automatic") {
        throw new ConversationError(
          "routing_not_automatic",
          `run "${input.runId}" is ${run.mode}, not automatic; routing does not apply`,
        );
      }
      if (TERMINAL_RUN_STATES.includes(run.state)) {
        // A decision that arrives after the Run sealed is a no-op with an
        // explicit error — never a resurrection. Late Router output is a
        // durable audit row at most (see below, guarded by Run state).
        throw new ConversationError("run_terminal", `run "${run.id}" is ${run.state}; routing is sealed`);
      }
      if (isRunCancelling(run)) {
        throw new ConversationError("run_cancelling", `run "${run.id}" has durable cancel intent`);
      }
      if (run.routingState !== "routing" || run.routingGeneration !== input.routingGeneration) {
        throw new ConversationError("stale_routing_attempt", `run "${run.id}" routing ownership changed`);
      }
      if (input.requestMessageId !== run.requestMessageId
        || !requestSnapshotMatches(this.getMessage(run.requestMessageId), run)) {
        throw new ConversationError("request_snapshot_mismatch", `run "${run.id}" lost its request snapshot`);
      }
      const members = this.listMemberTurns(run.id);
      if (members.some((turn) => !TERMINAL_MEMBER_STATES.includes(turn.state))) {
        throw new ConversationError("routing_batch_active", `run "${run.id}" has unsettled members`);
      }
      const batch = Math.max(0, ...members.map((turn) => turn.batch));
      if (input.decision.type === "dispatch") {
        // Budget guardrail (design §14.2): a Router decision may never push
        // the Run past its member-turn budget. Budget exhaustion is an
        // explicit completion reason, not a silent truncation.
        const consumed = this.allocatedWork(run.id) + input.decision.assignments.length;
        if (consumed > run.maxMemberTurns) {
          this.sqlite.run(
            `UPDATE runs SET state = 'failed', completion_reason = 'budget-exhausted',
             finished_at = COALESCE(finished_at, ?), routing_state = 'done'
             WHERE id = ?`,
            [input.now, run.id],
          );
          this.writeRoutingDecisionRow(run.id, input.decision, input.now);
          return { run: this.requireRun(run.id), memberTurns: [], dispatches: [], terminal: "failed" };
        }
        // Domain fence (defence in depth — the gate already ran): every
        // assignment must map onto this Run's public transcript. `triggerMessageIds`
        // must name real public rows of this Conversation+Topic, so a Router
        // cannot fabricate or borrow context.
        this.assertAssignmentsMapToTranscript(run, input.decision.assignments, input.requestMessageId);
        const distinctIds = new Set(input.decision.assignments.map((assignment) => assignment.id));
        if (input.decision.assignments.some((assignment) => run.quarantinedBotIds?.includes(assignment.botId))) {
          throw new ConversationError("router_unavailable_member", "Bot is quarantined for this Run");
        }
        if (distinctIds.size !== input.decision.assignments.length
          || members.some((turn) => turn.assignmentId && distinctIds.has(turn.assignmentId))) {
          throw new ConversationError(
            "routing_assignment_duplicate",
            `run "${run.id}" routing dispatch repeats an assignment id`,
          );
        }
        const nextBatch = batch + 1;
        const memberTurns: MemberTurnRecord[] = [];
        const dispatches: PendingDispatch[] = [];
        for (const [index, assignment] of input.decision.assignments.entries()) {
          const memberTurnId = this.ids.memberTurnId();
          const dispatchId = this.ids.dispatchId();
          this.sqlite.run(
            `INSERT INTO member_turns (
               id, run_id, conversation_id, topic_id, bot_id, session_alias, logical_session_id, source_turn_id,
               queue_item_id, batch, member_index, attempt, origin, state, trigger_message_ids_json, profile_snapshot_json,
               created_at, started_at, finished_at,
               effect, effect_provenance, assignment_id, task, expected_output, depends_on_json
             ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 1, ?, 'queued', ?, ?, ?, NULL, NULL, 'unknown', NULL, ?, ?, ?, ?)`,
            [
              memberTurnId,
              run.id,
              run.conversationId,
              run.topicId,
              assignment.botId,
              nextBatch,
              index,
              run.quarantinedBotIds?.length ? "recovery" : "router",
              JSON.stringify(assignment.triggerMessageIds),
              // Router-selected members carry the snapshot derived at routing
              // time from the live Bot profile + this Topic's ExecutionTarget,
              // so the member executes against the Bot it was assigned to —
              // never the Run's snapshot carrier (which is just the accepted
              // execution identity of the Run, not of this member).
              JSON.stringify(assignment.profileSnapshot),
              input.now,
              assignment.id,
              assignment.task,
              assignment.expectedOutput ?? null,
              JSON.stringify(assignment.dependsOn ?? []),
            ],
          );
          this.sqlite.run(
            `INSERT INTO pending_dispatches (
               id, run_id, member_turn_id, generation, state, owner, lease_expires_at,
               authority_epoch, human_ingress, created_at, claimed_at, completed_at
             ) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, ?, NULL, NULL)`,
            [dispatchId, run.id, memberTurnId, run.generation, input.now],
          );
          memberTurns.push(this.requireMemberTurn(memberTurnId));
          dispatches.push(this.requireDispatch(dispatchId));
        }
        this.sqlite.run(
          `UPDATE runs SET state = 'running', routing_state = 'dispatching', active_batch = ?,
             failed_bot_ids_json = '[]', unavailable_bot_ids_json = '[]', started_at = COALESCE(started_at, ?)
           WHERE id = ?`,
          [nextBatch, input.now, run.id],
        );
        this.writeRoutingDecisionRow(run.id, input.decision, input.now);
        return { run: this.requireRun(run.id), memberTurns, dispatches };
      }
      if (input.decision.type === "need-human") {
        // Durable waiting-human: this is the only place the Router may park a
        // Run for the human, and it persists question + waiting state so a
        // reconnect/restart shows exactly the same blocked semantics.
        this.sqlite.run(
          `UPDATE runs SET state = 'waiting-human', completion_reason = 'needs-input',
             finished_at = NULL, routing_state = 'done', waiting_question = ?
           WHERE id = ?`,
          [input.decision.question, run.id],
        );
        this.writeRoutingDecisionRow(run.id, input.decision, input.now);
        return { run: this.requireRun(run.id), memberTurns: [], dispatches: [], terminal: "waiting-human" };
      }
      this.sqlite.run(
        `UPDATE runs SET state = 'completed', completion_reason = ?,
           finished_at = COALESCE(finished_at, ?), routing_state = 'done'
         WHERE id = ?`,
        [input.decision.reason, input.now, run.id],
      );
      this.writeRoutingDecisionRow(run.id, input.decision, input.now);
      return { run: this.requireRun(run.id), memberTurns: [], dispatches: [], terminal: "completed" };
    });
  }

  listRoutingDecisions(runId: string): RoutingDecisionRecord[] {
    const rows = this.sqlite.all<RoutingDecisionRow>(
      "SELECT * FROM routing_decisions WHERE run_id = ? ORDER BY created_at ASC, id ASC",
      [runId],
    );
    return rows.map((row) => ({
      runId: row.run_id,
      decisionType: row.decision_type as RoutingDecisionRecord["decisionType"],
      ...(row.mode ? { mode: row.mode as RoutingDecisionRecord["mode"] } : {}),
      ...(optionalString(row.question) ? { question: row.question as string } : {}),
      ...(optionalString(row.reason) ? { reason: row.reason as string } : {}),
      assignmentIds: parseTriggerMessageIds(row.assignment_ids_json),
      at: row.created_at,
    }));
  }

  automaticRunsAwaitingRouting(): Array<{ run: ConversationRun; batchMembers: MemberTurnRecord[] }> {
    const rows = this.sqlite.all<RunRow>(
      `SELECT * FROM runs
       WHERE mode = 'automatic' AND state IN ('queued', 'running') AND completion_reason IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM conversation_lifecycle c
           WHERE c.conversation_id = runs.conversation_id AND c.state = 'deleting'
         )
         AND NOT EXISTS (
           SELECT 1 FROM topic_lifecycle t
           WHERE t.topic_id = runs.topic_id AND t.state = 'deleting'
         )
         AND NOT EXISTS (
           SELECT 1 FROM member_turns m
           WHERE m.run_id = runs.id
             AND m.batch = COALESCE(runs.active_batch, 1)
             AND m.state IN ('queued', 'dispatched', 'running')
         )
       ORDER BY created_at ASC`,
    );
    const awaiting: Array<{ run: ConversationRun; batchMembers: MemberTurnRecord[] }> = [];
    for (const row of rows) {
      // Any other Run holding the Topic (running/waiting-human) blocks routing
      // on this one: one active Run per Topic keeps scheduling deterministic.
      if (this.topicHasEarlierOrActiveRun(mapRun(row))) {
        continue;
      }
      awaiting.push({ run: mapRun(row), batchMembers: this.listMemberTurns(row.id) });
    }
    return awaiting;
  }

  private topicHasEarlierOrActiveRun(run: ConversationRun): boolean {
    const request = this.getMessage(run.requestMessageId);
    // Let the routing owner fail a corrupt snapshot before any model call;
    // ordering must never hide the referential failure behind a busy Topic.
    if (!requestSnapshotMatches(request, run)) return false;
    return Boolean(this.sqlite.get(
      `SELECT active.id FROM runs active LEFT JOIN messages prior ON prior.id = active.request_message_id
       WHERE active.topic_id = ? AND active.id <> ?
         AND (active.state IN ('running', 'waiting-human')
           OR (active.state = 'queued' AND prior.seq < ?)) LIMIT 1`,
      [run.topicId, run.id, request!.seq],
    ));
  }

  /** A decision's assignments must resolve to real rows of THIS Run's
   *  Conversation+Topic: `triggerMessageIds` are the boundary evidence, and
   *  the request message must be included so the assignment reacts to its own
   *  request. Fails closed on fabricated/borrowed ids. */
  private assertAssignmentsMapToTranscript(
    run: ConversationRun,
    assignments: readonly RoutingAssignmentInput[],
    requestMessageId: string,
  ): void {
    const request = this.getMessage(run.requestMessageId);
    for (const assignment of assignments) {
      for (const messageId of assignment.triggerMessageIds) {
        const message = this.getMessage(messageId);
        if (!publicMessageMatchesRunScope(message, run, request)) {
          throw new ConversationError(
            "routing_message_not_found",
            `routing assignment "${assignment.id}" references message "${messageId}" outside this run's topic`,
          );
        }
      }
      if (!assignment.triggerMessageIds.includes(requestMessageId)) {
        throw new ConversationError(
          "routing_message_not_found",
          `routing assignment "${assignment.id}" must include the run request message "${requestMessageId}"`,
        );
      }
    }
  }

  private writeRoutingDecisionRow(
    runId: string,
    decision: ApplyRoutingDecisionInput["decision"],
    now: string,
  ): void {
    this.sqlite.run(
      `INSERT INTO routing_decisions (
         id, run_id, decision_type, mode, question, reason, assignment_ids_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        this.ids.memberTurnId(),
        runId,
        decision.type,
        decision.type === "dispatch" ? decision.mode : null,
        decision.type === "need-human" ? decision.question : null,
        decision.type === "complete" ? decision.reason : null,
        JSON.stringify(decision.type === "dispatch" ? decision.assignments.map((a) => a.id) : []),
        now,
      ],
    );
  }

  markConversationDeleting(conversationId: string, now: string): void {
    this.sqlite.transaction(() => {
      this.sqlite.run(
        `INSERT INTO conversation_lifecycle (conversation_id, state, updated_at)
         VALUES (?, 'deleting', ?)
         ON CONFLICT(conversation_id) DO UPDATE SET state = 'deleting', updated_at = excluded.updated_at`,
        [conversationId, now],
      );
    });
  }

  markTopicDeleting(topicId: string, conversationId: string, now: string): void {
    this.sqlite.transaction(() => {
      this.sqlite.run(
        `INSERT INTO topic_lifecycle (topic_id, conversation_id, state, updated_at)
         VALUES (?, ?, 'deleting', ?)
         ON CONFLICT(topic_id) DO UPDATE SET state = 'deleting', updated_at = excluded.updated_at`,
        [topicId, conversationId, now],
      );
    });
  }

  isConversationDeleting(conversationId: string): boolean {
    const row = this.sqlite.get<{ state: string }>(
      "SELECT state FROM conversation_lifecycle WHERE conversation_id = ?",
      [conversationId],
    );
    return row?.state === "deleting";
  }

  isTopicDeleting(topicId: string): boolean {
    const row = this.sqlite.get<{ state: string }>(
      "SELECT state FROM topic_lifecycle WHERE topic_id = ?",
      [topicId],
    );
    return row?.state === "deleting";
  }

  deleteTopicRows(conversationId: string, topicId: string): void {
    this.sqlite.transaction(() => {
      this.sqlite.run("DELETE FROM conversation_bindings WHERE conversation_id = ? AND topic_id = ?", [conversationId, topicId]);
      const owned = this.sqlite.get(
        `SELECT 1 AS ok FROM topic_seq WHERE conversation_id = ? AND topic_id = ?
         UNION ALL
         SELECT 1 AS ok FROM topic_lifecycle WHERE conversation_id = ? AND topic_id = ?
         UNION ALL
         SELECT 1 AS ok FROM runs WHERE conversation_id = ? AND topic_id = ?
         UNION ALL
         SELECT 1 AS ok FROM messages WHERE conversation_id = ? AND topic_id = ?
         LIMIT 1`,
        [conversationId, topicId, conversationId, topicId, conversationId, topicId, conversationId, topicId],
      );
      if (!owned) {
        return;
      }
      this.sqlite.run(
        `DELETE FROM pending_dispatches
         WHERE run_id IN (SELECT id FROM runs WHERE conversation_id = ? AND topic_id = ?)`,
        [conversationId, topicId],
      );
      this.sqlite.run(
        "DELETE FROM member_turns WHERE conversation_id = ? AND topic_id = ?",
        [conversationId, topicId],
      );
      this.sqlite.run(
        "DELETE FROM messages WHERE conversation_id = ? AND topic_id = ?",
        [conversationId, topicId],
      );
      this.sqlite.run(
        "DELETE FROM routing_decisions WHERE run_id IN (SELECT id FROM runs WHERE conversation_id = ? AND topic_id = ?)",
        [conversationId, topicId],
      );
      this.sqlite.run("DELETE FROM recovery_attempts WHERE run_id IN (SELECT id FROM runs WHERE conversation_id = ? AND topic_id = ?)",
        [conversationId, topicId]);
      this.sqlite.run(
        "DELETE FROM runs WHERE conversation_id = ? AND topic_id = ?",
        [conversationId, topicId],
      );
      this.sqlite.run(
        "DELETE FROM topic_seq WHERE conversation_id = ? AND topic_id = ?",
        [conversationId, topicId],
      );
      this.sqlite.run(
        "DELETE FROM topic_lifecycle WHERE conversation_id = ? AND topic_id = ?",
        [conversationId, topicId],
      );
    });
  }

  deleteConversationRows(conversationId: string): void {
    this.sqlite.transaction(() => {
      this.sqlite.run("DELETE FROM conversation_bindings WHERE conversation_id = ?", [conversationId]);
      this.sqlite.run(
        "DELETE FROM pending_dispatches WHERE run_id IN (SELECT id FROM runs WHERE conversation_id = ?)",
        [conversationId],
      );
      this.sqlite.run("DELETE FROM member_turns WHERE conversation_id = ?", [conversationId]);
      this.sqlite.run("DELETE FROM messages WHERE conversation_id = ?", [conversationId]);
      this.sqlite.run("DELETE FROM routing_decisions WHERE run_id IN (SELECT id FROM runs WHERE conversation_id = ?)", [conversationId]);
      this.sqlite.run("DELETE FROM recovery_attempts WHERE run_id IN (SELECT id FROM runs WHERE conversation_id = ?)", [conversationId]);
      this.sqlite.run("DELETE FROM runs WHERE conversation_id = ?", [conversationId]);
      this.sqlite.run("DELETE FROM topic_seq WHERE conversation_id = ?", [conversationId]);
      this.sqlite.run("DELETE FROM topic_lifecycle WHERE conversation_id = ?", [conversationId]);
      this.sqlite.run("DELETE FROM conversation_lifecycle WHERE conversation_id = ?", [conversationId]);
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.db.close();
    this.closed = true;
  }

  private ensurePublicHandoffSchema(): void {
    // The marker and backfill share one transaction: interrupted upgrades must
    // retry, and subsequent PR9 opens must never replenish a bounded budget.
    this.sqlite.transaction(() => {
      const upgrade = !this.sqlite.all<{ name: string }>("PRAGMA table_info(runs)").some((column) => column.name === "budget_exhausted");
      const ensure = (table: string, name: string, sqlType: string): void => {
        if (!this.sqlite.all<{ name: string }>(`PRAGMA table_info(${table})`).some((column) => column.name === name)) {
          this.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${sqlType}`);
        }
      };
      ensure("messages", "handoff_json", "TEXT");
      ensure("member_turns", "handoff_source_turn_id", "TEXT");
      ensure("member_turns", "handoff_invocation_id", "TEXT");
      ensure("runs", "quarantined_bot_ids_json", "TEXT NOT NULL DEFAULT '[]'");
      ensure("runs", "budget_exhausted", "INTEGER NOT NULL DEFAULT 0");
      const cancellationUpgrade = !this.sqlite.all<{ name: string }>("PRAGMA table_info(runs)")
        .some((column) => column.name === "cancellation_reason");
      ensure("runs", "cancellation_reason", "TEXT CHECK (cancellation_reason IN ('human-cancelled', 'execution-cancelled'))");
      if (cancellationUpgrade) {
        // Before this column, cancelRun was the sole writer of live intent.
        // Preserve that human provenance if a provider cancellation arrives
        // during the migrated fan-out. Do not infer lost terminal intent.
        this.sqlite.run(`UPDATE runs SET cancellation_reason = 'human-cancelled'
          WHERE (state IN ('queued', 'running') AND completion_reason IS NOT NULL)
             OR completion_reason = 'human-cancelled'`);
      }
      this.sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_invocation ON member_turns
        (handoff_source_turn_id, handoff_invocation_id) WHERE handoff_source_turn_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_envelope ON messages (json_extract(handoff_json, '$.memberTurnId')) WHERE handoff_json IS NOT NULL;
        CREATE TABLE IF NOT EXISTS recovery_attempts (
          member_turn_id TEXT NOT NULL, run_id TEXT NOT NULL, source_turn_id TEXT NOT NULL,
          generation INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(member_turn_id, source_turn_id));`);
      if (upgrade) {
        const oldRuns = this.sqlite.all<{ id: string; conversation_id: string }>(
          "SELECT id, conversation_id FROM runs WHERE mode = 'explicit' AND state IN ('queued', 'running', 'waiting-human') AND max_member_turns < ?",
          [MAX_AUTOMATIC_MEMBER_TURNS]);
        for (const run of oldRuns) {
          const member = this.sqlite.get<{ bot_id: string }>("SELECT bot_id FROM member_turns WHERE run_id = ? ORDER BY member_index LIMIT 1", [run.id]);
          // Direct has no Group handoff primitive; preserve its original budget.
          if (member && run.conversation_id === createDirectConversationId(member.bot_id)) continue;
          this.sqlite.run("UPDATE runs SET max_member_turns = MAX(max_member_turns, ?) WHERE id = ?", [MAX_AUTOMATIC_MEMBER_TURNS, run.id]);
        }
      }
    });
  }

  private ensureDispatchAuthorityEpochColumn(): void {
    const cols = this.sqlite.all<{ name: string }>("PRAGMA table_info(pending_dispatches)");
    if (cols.some((col) => col.name === "authority_epoch")) {
      return;
    }
    this.sqlite.exec("ALTER TABLE pending_dispatches ADD COLUMN authority_epoch TEXT");
  }

  private ensureDispatchHumanIngressColumn(): void {
    const cols = this.sqlite.all<{ name: string }>("PRAGMA table_info(pending_dispatches)");
    if (cols.some((col) => col.name === "human_ingress")) {
      return;
    }
    this.sqlite.exec("ALTER TABLE pending_dispatches ADD COLUMN human_ingress TEXT");
  }

  /**
   * PR6 multi-member durable shape (§9.3 + §9.4): assignment/task/expected
   * output/dependencies land on member_turns, and one Run may own many
   * pending dispatches — one per MemberTurn. Older databases created before
   * this change migrate in place: new columns default empty, and the legacy
   * UNIQUE(run_id) constraint is rebuilt as UNIQUE(run_id, member_turn_id).
   */
  private ensureMemberTurnAssignmentColumns(): void {
    const cols = this.sqlite.all<{ name: string }>("PRAGMA table_info(member_turns)");
    const names = new Set(cols.map((col) => col.name));
    if (!names.has("assignment_id")) {
      this.sqlite.exec("ALTER TABLE member_turns ADD COLUMN assignment_id TEXT");
    }
    if (!names.has("task")) {
      this.sqlite.exec("ALTER TABLE member_turns ADD COLUMN task TEXT");
    }
    if (!names.has("expected_output")) {
      this.sqlite.exec("ALTER TABLE member_turns ADD COLUMN expected_output TEXT");
    }
    if (!names.has("depends_on_json")) {
      this.sqlite.exec("ALTER TABLE member_turns ADD COLUMN depends_on_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!names.has("failure_reason")) {
      this.sqlite.exec("ALTER TABLE member_turns ADD COLUMN failure_reason TEXT");
    }
    if (!names.has("member_index")) {
      this.sqlite.exec("ALTER TABLE member_turns ADD COLUMN member_index INTEGER NOT NULL DEFAULT 0");
    }
    if (!names.has("effect")) {
      this.sqlite.exec("ALTER TABLE member_turns ADD COLUMN effect TEXT NOT NULL DEFAULT 'unknown'");
    }
    if (!names.has("effect_provenance")) {
      this.sqlite.exec("ALTER TABLE member_turns ADD COLUMN effect_provenance TEXT");
    }
    this.sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_member_assignment_unique ON member_turns (run_id, assignment_id) WHERE assignment_id IS NOT NULL");
  }

  private ensureMemberTurnSnapshotColumn(): void {
    const cols = this.sqlite.all<{ name: string }>("PRAGMA table_info(member_turns)");
    if (cols.some((col) => col.name === "profile_snapshot_json")) {
      return;
    }
    this.sqlite.exec("ALTER TABLE member_turns ADD COLUMN profile_snapshot_json TEXT");
  }

  private ensureRunAggregateColumns(): void {
    const cols = this.sqlite.all<{ name: string }>("PRAGMA table_info(runs)");
    const names = new Set(cols.map((col) => col.name));
    if (!names.has("active_batch")) {
      this.sqlite.exec("ALTER TABLE runs ADD COLUMN active_batch INTEGER");
    }
    if (!names.has("failed_bot_ids_json")) {
      this.sqlite.exec("ALTER TABLE runs ADD COLUMN failed_bot_ids_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!names.has("unavailable_bot_ids_json")) {
      this.sqlite.exec("ALTER TABLE runs ADD COLUMN unavailable_bot_ids_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!names.has("routing_state")) {
      // PR8 automatic-Run routing substate. NULL on explicit Runs and on
      // pre-PR8 rows: readers treat NULL as "not routing" (explicit), never
      // as `queued` — a pre-PR8 automatic Run therefore needs its routing
      // state established by the routing kick before it is dispatched again.
      this.sqlite.exec("ALTER TABLE runs ADD COLUMN routing_state TEXT");
    }
    if (!names.has("routing_generation")) {
      this.sqlite.exec("ALTER TABLE runs ADD COLUMN routing_generation INTEGER NOT NULL DEFAULT 0");
    }
  }

  /**
   * PR8 structured blocked-step evidence column. Separate from the runs
   * migration because it lives on member_turns, and tolerant of databases
   * that already carry it.
   */
  private ensureMemberTurnBlockedColumn(): void {
    const cols = this.sqlite.all<{ name: string }>("PRAGMA table_info(member_turns)");
    const names = new Set(cols.map((col) => col.name));
    if (!names.has("blocked_reason")) {
      this.sqlite.exec("ALTER TABLE member_turns ADD COLUMN blocked_reason TEXT");
    }
  }

  private ensureWaitingQuestionColumn(): void {
    this.sqlite.transaction(() => {
      const cols = this.sqlite.all<{ name: string }>("PRAGMA table_info(runs)");
      if (!cols.some((col) => col.name === "waiting_question")) {
        this.sqlite.exec("ALTER TABLE runs ADD COLUMN waiting_question TEXT");
      }
      // Upgrade existing PR8 waiting Runs without using audit for scheduling.
      // Repeat on open so an interrupted older migration cannot lose the seam.
      this.sqlite.exec(`UPDATE runs SET waiting_question = (
        SELECT question FROM routing_decisions WHERE run_id = runs.id AND decision_type = 'need-human'
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      ) WHERE mode = 'automatic' AND state = 'waiting-human' AND waiting_question IS NULL`);
    });
  }

  /**
   * PR8 durable Router decision audit (plan §11.4). Append-only: one row per
   * committed decision. Scheduling NEVER reads it — it is audit/reconciliation
   * evidence, so a torn history can never resurrect or drop a routing step.
   */
  private ensureRoutingDecisionTable(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS routing_decisions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        decision_type TEXT NOT NULL,
        mode TEXT,
        question TEXT,
        reason TEXT,
        assignment_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      )`);
    this.sqlite.exec(
      "CREATE INDEX IF NOT EXISTS idx_routing_decisions_run ON routing_decisions (run_id, created_at)",
    );
  }

  private ensureDispatchMultiMemberShape(): void {
    // NOTE: the legacy UNIQUE(run_id) surfaces as a sqlite_autoindex row with
    // NULL sql in sqlite_master, so text-scanning sqlite_master cannot detect
    // it. PRAGMA index_list/index_info is authoritative instead.
    //
    // Crash-atomicity: the whole rebuild runs inside one SQLite transaction,
    // so a crash at any point leaves either the complete old table or the
    // complete new table — never a dropped old table with rows stranded in
    // `pending_dispatches_next`. A leftover `_next` table from a crashed
    // migration is reconciled explicitly below instead of ignored.
    const leftover = this.sqlite.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending_dispatches_next'",
    );
    if (leftover) {
      this.reconcileLeftoverDispatchMigration();
      return;
    }
    const indexList = this.sqlite.all<{ name: string; unique: number }>(
      "PRAGMA index_list(pending_dispatches)",
    );
    let uniqueRunOnly = false;
    for (const index of indexList) {
      if (!index.unique) {
        continue;
      }
      const cols = this.sqlite.all<{ name: string }>(`PRAGMA index_info("${index.name}")`);
      const names = cols.map((col) => col.name).sort();
      if (names.length === 1 && names[0] === "run_id") {
        uniqueRunOnly = true;
        break;
      }
    }
    if (!uniqueRunOnly) {
      this.sqlite.exec(
        "CREATE INDEX IF NOT EXISTS idx_dispatches_run ON pending_dispatches (run_id, state)",
      );
      return;
    }
    this.sqlite.transaction(() => {
      this.sqlite.exec(`
        CREATE TABLE pending_dispatches_next (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          member_turn_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          state TEXT NOT NULL,
          owner TEXT,
          lease_expires_at TEXT,
          authority_epoch TEXT,
          human_ingress TEXT,
          created_at TEXT NOT NULL,
          claimed_at TEXT,
          completed_at TEXT,
          UNIQUE (run_id, member_turn_id)
        )`);
      this.sqlite.exec(`
        INSERT INTO pending_dispatches_next (
          id, run_id, member_turn_id, generation, state, owner, lease_expires_at,
          authority_epoch, human_ingress, created_at, claimed_at, completed_at
        )
        SELECT id, run_id, member_turn_id, generation, state, owner, lease_expires_at,
          authority_epoch, human_ingress, created_at, claimed_at, completed_at
        FROM pending_dispatches`);
      this.beforeDispatchMigrationCommit?.();
      this.sqlite.exec(`DROP TABLE pending_dispatches`);
      this.sqlite.exec(`ALTER TABLE pending_dispatches_next RENAME TO pending_dispatches`);
    });
    this.sqlite.exec(
      "CREATE INDEX IF NOT EXISTS idx_dispatches_state ON pending_dispatches (state, created_at)",
    );
    this.sqlite.exec(
      "CREATE INDEX IF NOT EXISTS idx_dispatches_run ON pending_dispatches (run_id, state)",
    );
  }

  /**
   * Reconcile a `pending_dispatches_next` table left behind by a migration
   * that crashed outside the transaction (or on a driver that could not roll
   * back DDL). Exactly one of the two tables can hold rows; the empty one is
   * dropped. Rows in both (should be impossible via the transactional path,
   * but possible if DDL committed piecemeal) fail closed loudly instead of
   * silently preferring one side.
   */
  private reconcileLeftoverDispatchMigration(): void {
    const mainCount = this.sqlite.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM pending_dispatches",
    )?.n ?? 0;
    const nextCount = this.sqlite.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM pending_dispatches_next",
    )?.n ?? 0;
    if (mainCount > 0 && nextCount > 0) {
      throw new ConversationError(
        "dispatch_migration_conflict",
        "both pending_dispatches and pending_dispatches_next hold rows after a crashed migration",
      );
    }
    if (nextCount > 0) {
      this.sqlite.transaction(() => {
        this.sqlite.exec(`DROP TABLE pending_dispatches`);
        this.sqlite.exec(`ALTER TABLE pending_dispatches_next RENAME TO pending_dispatches`);
      });
    } else {
      this.sqlite.exec(`DROP TABLE pending_dispatches_next`);
    }
    this.sqlite.exec(
      "CREATE INDEX IF NOT EXISTS idx_dispatches_state ON pending_dispatches (state, created_at)",
    );
    this.sqlite.exec(
      "CREATE INDEX IF NOT EXISTS idx_dispatches_run ON pending_dispatches (run_id, state)",
    );
    // Re-run the shape check so a still-legacy main table migrates normally.
    const leftover = this.sqlite.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending_dispatches_next'",
    );
    if (!leftover) {
      this.ensureDispatchMultiMemberShape();
    }
  }

  private assertLifecycleAcceptable(conversationId: string, topicId: string): void {
    if (this.isConversationDeleting(conversationId)) {
      throw new ConversationError("conversation_deleting", `conversation "${conversationId}" is deleting`);
    }
    if (this.isTopicDeleting(topicId)) {
      throw new ConversationError("topic_deleting", `topic "${topicId}" is deleting`);
    }
  }

  private assertAcceptable(conversationId: string, topicId: string): void {
    this.assertLifecycleAcceptable(conversationId, topicId);
    // §21 bounded queue: nonterminal Runs (active + queued) per Topic are
    // capped so a public Conversation cannot grow SQLite unboundedly with
    // fresh requestIds. One-active-Run-per-Topic dispatch serialization is
    // enforced separately at claim time; this is the accept-time bound.
    const counted = this.sqlite.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM runs
       WHERE conversation_id = ? AND topic_id = ?
         AND state IN ('queued', 'running', 'waiting-human')`,
      [conversationId, topicId],
    );
    const nonterminal = Number(counted?.n ?? 0);
    if (nonterminal >= MAX_QUEUED_RUNS_PER_TOPIC) {
      throw new ConversationError(
        "topic_queue_full",
        `topic "${topicId}" already has ${nonterminal} nonterminal runs (max ${MAX_QUEUED_RUNS_PER_TOPIC})`,
      );
    }
  }

  private insertAccepted(input: AcceptRequestInput): AcceptRequestResult {
    const seq = this.allocateSeq(input.conversationId, input.topicId);
    const messageId = this.ids.messageId();
    const runId = this.ids.runId();
    // The singular botId/profileSnapshot is always members[0]; `members`
    // holds extras (PR7/PR8), so merge as [legacy, ...extras] and write one
    // MemberTurn plus one pending dispatch intent per member in durable
    // member_index order. Direct accepts omit `members` (single member). A
    // `primaryMember` overlay carries assignment/provenance for members[0];
    // its type omits botId/profileSnapshot, so it cannot diverge the durable
    // order — members[0] is always the legacy singular by construction.
    //
    // PR8 automatic accepts are the ONE exception, by construction: a human
    // selected nobody, so the accepted Run owns ZERO MemberTurns and the
    // Router decides the first batch. The signal is `mode: "automatic"` with
    // an explicitly EMPTY `members` array. `members: []` means "no human
    // selected anyone"; an undefined `members` (or a populated one) keeps the
    // legacy singular as members[0] exactly as before, so every existing
    // accept shape — including durable assignment persistence tests — is
    // unchanged. The singular botId/profileSnapshot on the empty case then
    // carries the Run's own accepted execution identity (what the Run was
    // admitted against) and is never a dispatchable member.
    const mode = input.mode ?? "explicit";
    const members = input.mode === "automatic" && input.members?.length === 0
      ? []
      : [
        {
          botId: input.botId,
          profileSnapshot: input.profileSnapshot,
          ...(input.primaryMember ?? {}),
        },
        ...(input.members ?? []),
      ];
    // Automatic Runs default to the durable budget guardrail (§14.2): the
    // first batch settling must leave routing headroom, so the default is
    // the 24-turn cap rather than members.length. Explicit Runs stay bounded
    // by their accepted member list.
    const maxMemberTurns = input.maxMemberTurns
      ?? (mode === "automatic" ? MAX_AUTOMATIC_MEMBER_TURNS : members.length);
    if (!Number.isInteger(maxMemberTurns) || maxMemberTurns < members.length) {
      throw new ConversationError(
        "invalid-max-member-turns",
        `maxMemberTurns (${String(input.maxMemberTurns)}) must be a positive integer >= accepted member count (${members.length})`,
      );
    }
    if (mode === "automatic" && maxMemberTurns > MAX_AUTOMATIC_MEMBER_TURNS) {
      throw new ConversationError(
        "invalid-max-member-turns",
        `maxMemberTurns (${maxMemberTurns}) exceeds the automatic Run budget cap (${MAX_AUTOMATIC_MEMBER_TURNS})`,
      );
    }
    const runSnapshot = input.profileSnapshot;
    this.sqlite.run(
      `INSERT INTO messages (
         id, conversation_id, topic_id, seq, role, sender_bot_id, content, run_id, source_turn_json, created_at
       ) VALUES (?, ?, ?, ?, 'human', NULL, ?, ?, NULL, ?)`,
      [messageId, input.conversationId, input.topicId, seq, input.content, runId, input.now],
    );
    this.sqlite.run(
      `INSERT INTO runs (
         id, conversation_id, topic_id, request_message_id, request_id, mode, state, completion_reason,
         routing_state,
         generation, active_batch, max_member_turns, consumed_member_turns,
         failed_bot_ids_json, unavailable_bot_ids_json,
         profile_revision, profile_snapshot_json,
         created_at, started_at, finished_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'queued', NULL, ?, 1, ?, ?, 0, '[]', '[]', ?, ?, ?, NULL, NULL)`,
      [
        runId,
        input.conversationId,
        input.topicId,
        messageId,
        input.requestId,
        mode,
        // Automatic Runs enter the routing state machine at `queued`; the
        // first routing decision is taken by the Router (no human chose
        // anyone). Explicit Runs never carry a routing state — routing on
        // explicit work would violate §14.1.
        mode === "automatic" ? "queued" : null,
        members.length === 0 ? 0 : 1,
        maxMemberTurns,
        runSnapshot.revision,
        JSON.stringify(runSnapshot),
        input.now,
      ],
    );
    const ingressJson = serializeHumanIngress(input.humanIngress);
    if (input.worktreeBase) this.worktrees.create(runId, input.conversationId, input.topicId, input.worktreeBase, input.now);
    const authorityEpoch = ingressJson ? (input.authorityEpoch ?? null) : null;
    const defaultOrigin: MemberTurnOrigin = ingressJson && authorityEpoch ? "human-explicit" : "followup";
    const seenBotIds = new Set<string>();
    const memberTurnIds: string[] = [];
    const dispatchIds: string[] = [];
    for (const [index, member] of members.entries()) {
      if (seenBotIds.has(member.botId)) {
        throw new ConversationError("duplicate_member", `run accepts bot "${member.botId}" twice`);
      }
      seenBotIds.add(member.botId);
      const memberTurnId = this.ids.memberTurnId();
      const dispatchId = this.ids.dispatchId();
      this.sqlite.run(
        `INSERT INTO member_turns (
           id, run_id, conversation_id, topic_id, bot_id, session_alias, logical_session_id, source_turn_id,
           queue_item_id, batch, member_index, attempt, origin, state, trigger_message_ids_json, profile_snapshot_json,
           created_at, started_at, finished_at,
           effect, effect_provenance, assignment_id, task, expected_output, depends_on_json
         ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 1, ?, 1, ?, 'queued', ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
        [
          memberTurnId,
          runId,
          input.conversationId,
          input.topicId,
          member.botId,
          index,
          member.provenance ?? defaultOrigin,
          JSON.stringify([messageId]),
          JSON.stringify(member.profileSnapshot),
          input.now,
          // Normalize at the durable boundary: only `read-only` backed by the
          // exact `declared-enforced` proof persists as proven. A bare
          // `read-only` without proof persists as `unknown`; explicit mutating
          // persists without proof. Both remain conservative for scheduling.
          ...(member.effect === "read-only" && member.effectProvenance === "declared-enforced"
            ? ["read-only", "declared-enforced"]
            : [member.effect === "mutating" ? "mutating" : "unknown", null]),
          member.assignmentId ?? null,
          member.task ?? null,
          member.expectedOutput ?? null,
          JSON.stringify(member.dependsOn ?? []),
        ],
      );
      this.sqlite.run(
        `INSERT INTO pending_dispatches (
           id, run_id, member_turn_id, generation, state, owner, lease_expires_at, created_at, claimed_at, completed_at, authority_epoch, human_ingress
         ) VALUES (?, ?, ?, 1, 'pending', NULL, NULL, ?, NULL, NULL, ?, ?)`,
        [dispatchId, runId, memberTurnId, input.now, authorityEpoch, ingressJson],
      );
      memberTurnIds.push(memberTurnId);
      dispatchIds.push(dispatchId);
    }
    const memberTurns = memberTurnIds.map((id) => this.requireMemberTurn(id));
    const dispatches = dispatchIds.map((id) => this.requireDispatch(id));
    return {
      reused: false,
      message: this.requireMessage(messageId),
      run: this.requireRun(runId),
      ...(memberTurns[0] ? { memberTurn: memberTurns[0], dispatch: dispatches[0]! } : {}),
      memberTurns,
      dispatches,
    };
  }

  private allocateSeq(conversationId: string, topicId: string): number {
    const row = this.sqlite.get<{ next_seq: number }>(
      `INSERT INTO topic_seq (topic_id, conversation_id, next_seq)
       VALUES (?, ?, 1)
       ON CONFLICT(topic_id) DO UPDATE SET next_seq = next_seq + 1
       RETURNING next_seq`,
      [topicId, conversationId],
    );
    if (!row) {
      throw new ConversationError("seq_allocation_failed", `failed to allocate seq for topic "${topicId}"`);
    }
    return Number(row.next_seq);
  }

  private loadAccepted(
    conversationId: string,
    topicId: string,
    requestId: string,
  ): Omit<AcceptRequestResult, "reused"> | undefined {
    const run = this.getRunByRequestId(conversationId, topicId, requestId);
    if (!run) {
      return undefined;
    }
    const message = this.getMessage(run.requestMessageId);
    const memberTurns = this.listMemberTurns(run.id);
    const dispatches = this.listDispatchesForRun(run.id);
    const memberTurn = memberTurns[0];
    const dispatch = memberTurn ? this.getDispatchForMemberTurn(memberTurn.id) : undefined;
    if (!message || (run.mode !== "automatic" && (!memberTurn || !dispatch))
      || memberTurns.length !== dispatches.length
      || memberTurns.some((turn) => !dispatches.some((row) => row.memberTurnId === turn.id))
      || !requestSnapshotMatches(message, run)) {
      throw new ConversationError("accepted_request_incomplete", `request "${requestId}" is missing durable rows`);
    }
    return { message, run, ...(memberTurn ? { memberTurn, dispatch } : {}), memberTurns, dispatches };
  }

  private writeIndeterminate(runId: string, memberTurnId: string, now: string, reason: string): void {
    this.sqlite.run(
      `UPDATE member_turns SET state = 'indeterminate', finished_at = COALESCE(finished_at, ?) WHERE id = ?`,
      [now, memberTurnId],
    );
    this.sqlite.run(
      `UPDATE runs SET state = 'indeterminate', completion_reason = ?, routing_state = CASE WHEN mode = 'automatic' THEN 'done' ELSE routing_state END, finished_at = COALESCE(finished_at, ?) WHERE id = ?`,
      [reason, now, runId],
    );
    this.finishDispatchForMemberTurn(memberTurnId, now);
  }

  private finishDispatchForRun(runId: string, now: string): void {
    const rows = this.sqlite.all<DispatchRow>("SELECT * FROM pending_dispatches WHERE run_id = ?", [runId]);
    for (const dispatch of rows) {
      this.finishDispatch(dispatch.id, now);
    }
  }

  private finishDispatchForMemberTurn(memberTurnId: string, now: string): void {
    const dispatch = this.sqlite.get<DispatchRow>("SELECT * FROM pending_dispatches WHERE member_turn_id = ?", [memberTurnId]);
    if (dispatch) {
      this.finishDispatch(dispatch.id, now);
    }
  }

  private finishDispatch(dispatchId: string, now: string): void {
    this.sqlite.run(
      `UPDATE pending_dispatches
       SET state = 'completed', completed_at = COALESCE(completed_at, ?), lease_expires_at = NULL
       WHERE id = ?`,
      [now, dispatchId],
    );
  }

  private requireLiveUnstartedClaim(input: {
    dispatchId: string;
    owner: string;
    generation: number;
    now: string;
    runId?: string;
    memberTurnId?: string;
  }): DispatchRow {
    const dispatch = this.sqlite.get<DispatchRow>("SELECT * FROM pending_dispatches WHERE id = ?", [input.dispatchId]);
    if (
      !dispatch
      || dispatch.state !== "claimed"
      || dispatch.owner !== input.owner
      || Number(dispatch.generation) !== Number(input.generation)
      || (input.runId !== undefined && dispatch.run_id !== input.runId)
      || (input.memberTurnId !== undefined && dispatch.member_turn_id !== input.memberTurnId)
      || (dispatch.lease_expires_at !== null && dispatch.lease_expires_at <= input.now)
    ) {
      throw new ConversationError("stale_claim", `dispatch "${input.dispatchId}" is not the live claim`);
    }
    const member = this.requireMemberTurn(dispatch.member_turn_id);
    if (member.startedAt) {
      throw new ConversationError("stale_claim", `member turn "${member.id}" already started`);
    }
    return dispatch;
  }

  /** Same fence minus the lease-expiry check, for writer-slot-held claims
   *  ONLY. A held claim's owner drain is alive by construction (it holds the
   *  ClaimedWork object in memory and renews every pass), so expiry cannot
   *  mean owner death — it only means the sibling ran long. Every OTHER check
   *  still applies: wrong owner, bumped generation, recovered-to-pending,
   *  started member, or terminal Run all reject. Never use this for normal
   *  claims; the lease is the dead-owner detector there. */
  private requireHeldClaim(input: {
    dispatchId: string;
    owner: string;
    generation: number;
    memberTurnId?: string;
  }): DispatchRow {
    const dispatch = this.sqlite.get<DispatchRow>("SELECT * FROM pending_dispatches WHERE id = ?", [input.dispatchId]);
    if (
      !dispatch
      || dispatch.state !== "claimed"
      || dispatch.owner !== input.owner
      || Number(dispatch.generation) !== Number(input.generation)
      || (input.memberTurnId !== undefined && dispatch.member_turn_id !== input.memberTurnId)
    ) {
      throw new ConversationError("stale_claim", `dispatch "${input.dispatchId}" is not the live held claim`);
    }
    const member = this.requireMemberTurn(dispatch.member_turn_id);
    if (member.startedAt) {
      throw new ConversationError("stale_claim", `member turn "${member.id}" already started`);
    }
    return dispatch;
  }

  private applyFailExecution(input: FailExecutionInput): ConversationRun {
    const run = this.requireRun(input.runId);
    const attempt = this.requireMemberTurn(input.memberTurnId);
    const recovered = this.sqlite.get("SELECT 1 FROM recovery_attempts WHERE member_turn_id = ?", [attempt.id]);
    if ((input.sourceTurnId !== undefined && (input.sourceTurnId !== attempt.sourceTurnId
      || this.sqlite.get("SELECT 1 FROM recovery_attempts WHERE member_turn_id = ? AND source_turn_id = ?", [attempt.id, input.sourceTurnId])))
      || (recovered && attempt.startedAt && input.sourceTurnId === undefined)) {
      throw new ConversationError("stale_source_turn", "failure evidence does not name the current physical attempt");
    }
    if (run.state === "indeterminate") {
      const sealed = this.requireMemberTurn(input.memberTurnId);
      if (
        sealed.runId === run.id
        && sealed.state === "indeterminate"
        && sealed.startedAt
        && (input.terminalState === undefined || input.terminalState === "failed")
      ) {
        return this.persistSealedMemberEvidence({
          runId: run.id,
          memberTurnId: sealed.id,
          outcome: "failed",
          reason: input.reason,
          sourceTurn: {
            sessionAlias: sealed.sessionAlias ?? "",
            ...(sealed.sourceTurnId !== undefined ? { turnId: sealed.sourceTurnId } : {}),
          },
          now: input.now,
        }).run;
      }
      return run;
    }
    if (TERMINAL_RUN_STATES.includes(run.state)) {
      return run;
    }
    const member = this.requireMemberTurn(input.memberTurnId);
    if (
      member.runId !== run.id
      || member.conversationId !== run.conversationId
      || member.topicId !== run.topicId
    ) {
      throw new ConversationError(
        "run_member_mismatch",
        `member turn "${member.id}" does not belong to run "${run.id}"`,
      );
    }
    if (TERMINAL_MEMBER_STATES.includes(member.state)) {
      // Idempotent replay: this member already terminal; the aggregate
      // already observed it. No double progress count.
      return run;
    }
    const state = input.terminalState ?? "failed";
    this.sqlite.run(
      `UPDATE member_turns SET state = ?, finished_at = ?, failure_reason = ?, blocked_reason = ? WHERE id = ?`,
      [state, input.now, state === "failed" ? (input.reason ?? "failed") : null,
        member.origin !== "human-explicit" ? input.blockedReason ?? null : null, input.memberTurnId],
    );
    this.sqlite.run(
      `UPDATE runs SET consumed_member_turns = consumed_member_turns + 1 WHERE id = ?`,
      [input.runId],
    );
    this.finishDispatchForMemberTurn(input.memberTurnId, input.now);
    if (state === "cancelled") {
      // Provenance survives an indeterminate seal, whose completion_reason
      // must describe the unknown outcome instead of its cancellation source.
      this.sqlite.run(`UPDATE runs SET cancellation_reason = COALESCE(cancellation_reason, 'execution-cancelled') WHERE id = ?`, [run.id]);
      if (input.forceRunTerminalOnSettle) {
        // The first observed execution cancellation fences the whole Run in
        // the SAME transaction as member evidence. Later sibling completion
        // cannot forget an in-memory force flag and re-enter the Router.
        // Existing human cancellation intent/provenance takes precedence.
        this.sqlite.run(`UPDATE runs SET completion_reason = COALESCE(completion_reason, 'execution-cancelled') WHERE id = ?`, [run.id]);
        this.cancelUnstartedMembers(run.id, input.now);
      }
    }
    return this.aggregateRunAfterMemberTerminal(
      input.runId,
      input.memberTurnId,
      input.now,
      input.reason,
      input.forceRunTerminalOnSettle ?? false,
    );
  }

  private cancelUnstartedMembers(runId: string, now: string): void {
    for (const member of this.listMemberTurns(runId)) {
      if (member.startedAt || TERMINAL_MEMBER_STATES.includes(member.state)) continue;
      this.sqlite.run("UPDATE member_turns SET state = 'cancelled', finished_at = ? WHERE id = ?", [now, member.id]);
      this.finishDispatchForMemberTurn(member.id, now);
    }
  }

  /**
   * Aggregate Run lifecycle after one MemberTurn reaches a terminal state.
   * Member completion terminals only the member; explicit Runs terminal when
   * no member of the active batch is still runnable (no Router follows).
   * Automatic batch settle stays running for the PR8 Router — UNLESS
   * forceRunTerminal is set or durable cancel intent exists, in which case the
   * settled batch aggregates to its terminal outcome exactly like explicit.
   * Indeterminate (unproven side effects) always seals the Run in EITHER
   * mode — even with runnable siblings — and settles every still-runnable
   * sibling as indeterminate in the same transaction, so no further member
   * can be claimed afterwards. Only failed members accumulate in
   * failedBotIds; cancelled/indeterminate are read from MemberTurns.
   * unavailableBotIds is PR7+ reservation surface.
   */
  private aggregateRunAfterMemberTerminal(
    runId: string,
    memberTurnId: string,
    now: string,
    memberReason?: string,
    forceRunTerminal = false,
  ): ConversationRun {
    const run = this.requireRun(runId);
    if (TERMINAL_RUN_STATES.includes(run.state)) {
      return run;
    }
    const members = this.listMemberTurns(runId);
    const batch = run.activeBatch ?? 1;
    const batchMembers = members.filter((turn) => turn.batch === batch);
    const terminal = batchMembers.filter((turn) => TERMINAL_MEMBER_STATES.includes(turn.state));
    // Exact member that just terminalled: never re-derive by state lookup
    // (two members may share the same terminal state; the lookup would
    // attribute the second event to the first member and drop a failedBotId).
    const member = this.requireMemberTurn(memberTurnId);
    if (member.batch === batch && member.state === "failed") {
      const current = new Set(run.failedBotIds);
      current.add(member.botId);
      this.sqlite.run(`UPDATE runs SET failed_bot_ids_json = ? WHERE id = ?`, [JSON.stringify([...current]), runId]);
      if (run.conversationId !== createDirectConversationId(member.botId)) {
        const quarantine = new Set(run.quarantinedBotIds ?? []);
        quarantine.add(member.botId);
        this.sqlite.run("UPDATE runs SET quarantined_bot_ids_json = ? WHERE id = ?", [JSON.stringify([...quarantine]), runId]);
      }
    }
    const batchIndeterminate = batchMembers.filter((turn) => turn.state === "indeterminate");
    if (batchIndeterminate.length > 0) {
      // Unknown side effects seal the Run immediately, in either mode, even
      // with runnable siblings: settle every still-runnable sibling as
      // indeterminate in the same transaction so nothing further can be
      // claimed, then terminal the Run. Covers runner settlement
      // (completeCancel unknown), lease recovery, and consumer-lock
      // convergence identically: no sibling may start after unproven
      // execution.
      const reason = batchMembers.length === 1 ? (memberReason ?? "started_result_unknown") : "started_result_unknown";
      for (const turn of batchMembers) {
        if (TERMINAL_MEMBER_STATES.includes(turn.state)) {
          continue;
        }
        this.sqlite.run(
          `UPDATE member_turns SET state = 'indeterminate', finished_at = ? WHERE id = ?`,
          [now, turn.id],
        );
        this.sqlite.run(
          `UPDATE runs SET consumed_member_turns = consumed_member_turns + 1 WHERE id = ?`,
          [runId],
        );
        this.finishDispatchForMemberTurn(turn.id, now);
      }
      this.sqlite.run(
        `UPDATE runs SET state = 'indeterminate', completion_reason = ?, routing_state = CASE WHEN mode = 'automatic' THEN 'done' ELSE routing_state END, finished_at = ? WHERE id = ?`,
        [reason, now, runId],
      );
      return this.requireRun(runId);
    }
    if (terminal.length < batchMembers.length) {
      // Intermediate state: one member terminal, siblings still runnable.
      // The Run stays non-terminal while admitted siblings drain. Durable
      // cancel intent fences new work; otherwise dispatch serves the batch.
      if (run.state === "queued") {
        this.sqlite.run(`UPDATE runs SET state = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?`, [now, runId]);
      }
      return this.requireRun(runId);
    }
    const exhausted = this.settleExhaustedBudget(run, now);
    if (exhausted) return exhausted;
    if (run.mode === "automatic" && !forceRunTerminal && !isRunCancelling(run)) {
      // Batch settled but the Run is not done: PR8 Router decides the next
      // step from durable MemberTurns. (Indeterminate already sealed above,
      // in either mode, so only non-indeterminate batches reach here.)
      // Every other settled batch stays running awaiting routing.
      if (run.state === "queued") {
        this.sqlite.run(`UPDATE runs SET state = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?`, [now, runId]);
      }
      return this.requireRun(runId);
    }
    return this.classifySettledBatch(runId, batchMembers, now, memberReason);
  }

  private settleExhaustedBudget(run: ConversationRun, now: string): ConversationRun | undefined {
    const intent = this.sqlite.get<{ budget_exhausted: number; cancellation_reason: string | null }>(
      "SELECT budget_exhausted, cancellation_reason FROM runs WHERE id = ?", [run.id]);
    // Only live human Stop supersedes durable budget rejection. Execution
    // cancellation still fences scheduling, but cannot erase this failure;
    // an unknown seal retains its existing late-proof budget classification.
    if (intent?.budget_exhausted !== 1
      || (isRunCancelling(run) && intent.cancellation_reason === "human-cancelled")) return undefined;
    this.sqlite.run(`UPDATE runs SET state = 'failed', completion_reason = 'budget-exhausted', finished_at = ?,
      routing_state = CASE WHEN mode = 'automatic' THEN 'done' ELSE routing_state END WHERE id = ?`, [now, run.id]);
    return this.requireRun(run.id);
  }

  /**
   * Final Run classification once every batch member is terminal. Derive the
   * outcome from the whole batch, never from the last event's reason —
   * except single-member Runs, which preserve the member's diagnostic reason
   * (e.g. runtime_revision_mismatch on direct drift).
   *
   * Precedence: indeterminate (unproven side effects) > failed > cancelled >
   * completed. A completed+cancelled mix keeps proven completion evidence
   * and classifies as cancelled. Cancellation provenance distinguishes
   * human Stop from execution cancellation independently of settle order
   * and of an intervening indeterminate seal. Legacy rows keep their prior
   * human-cancelled classification when provenance is unavailable.
   */
  private classifySettledBatch(
    runId: string,
    batchMembers: MemberTurnRecord[],
    now: string,
    memberReason?: string,
  ): ConversationRun {
    const indeterminate = batchMembers.filter((turn) => turn.state === "indeterminate");
    if (indeterminate.length > 0) {
      const reason = batchMembers.length === 1 ? (memberReason ?? "started_result_unknown") : "started_result_unknown";
      this.sqlite.run(
        `UPDATE runs SET state = 'indeterminate', completion_reason = ?, routing_state = CASE WHEN mode = 'automatic' THEN 'done' ELSE routing_state END, finished_at = COALESCE(finished_at, ?) WHERE id = ?`,
        [reason, now, runId],
      );
      return this.requireRun(runId);
    }
    // Late proof can remove an indeterminate seal, but cannot erase the
    // durable budget rejection that normal batch settlement also observes.
    const exhausted = this.settleExhaustedBudget(this.requireRun(runId), now);
    if (exhausted) return exhausted;
    const failed = batchMembers.filter((turn) => turn.state === "failed");
    if (failed.length > 0) {
      const reason = batchMembers.length === 1 ? (memberReason ?? "execution-failed") : "execution-failed";
      this.sqlite.run(
        `UPDATE runs SET state = 'failed', completion_reason = ?, routing_state = CASE WHEN mode = 'automatic' THEN 'done' ELSE routing_state END, finished_at = COALESCE(finished_at, ?) WHERE id = ?`,
        [reason, now, runId],
      );
      return this.requireRun(runId);
    }
    const cancelled = batchMembers.filter((turn) => turn.state === "cancelled");
    if (cancelled.length > 0) {
      const reason = this.sqlite.get<{ cancellation_reason: string | null }>(
        "SELECT cancellation_reason FROM runs WHERE id = ?", [runId])?.cancellation_reason ?? "human-cancelled";
      this.sqlite.run(
        `UPDATE runs SET state = 'cancelled', completion_reason = ?, routing_state = CASE WHEN mode = 'automatic' THEN 'done' ELSE routing_state END, finished_at = COALESCE(finished_at, ?) WHERE id = ?`,
        [reason, now, runId],
      );
      return this.requireRun(runId);
    }
    this.sqlite.run(
      `UPDATE runs SET state = 'completed', completion_reason = ?, routing_state = CASE WHEN mode = 'automatic' THEN 'done' ELSE routing_state END, finished_at = COALESCE(finished_at, ?) WHERE id = ?`,
      ["members-completed", now, runId],
    );
    return this.requireRun(runId);
  }

  /**
   * Late provider proof reconciliation (§14.3) across two windows: the
   * cancel-settlement timeout already sealed the scheduling outcome as
   * indeterminate (reclassify that member + re-derive the Run), OR the Run
   * is still live under durable cancel intent with the batch unsettled
   * (persist member evidence only; settleCancelBatch reads it from fresh
   * member states). The provider settling afterwards is DURABLE EVIDENCE,
   * not a scheduling decision — so teardown's "reconcile indeterminate"
   * step has a real result instead of a permanent seal. Never resurrects
   * scheduling: a clean cancelled Run, a live Run without cancel intent, or
   * an already-proven member is a no-op (no dispatch/progress/scheduling
   * changes beyond the evidence write), and consumed_member_turns is counted
   * exactly once via the batch fence.
   */
  reconcileLateResult(input: {
    runId: string;
    memberTurnId: string;
    outcome: "completed" | "failed";
    content?: string;
    reason?: string;
    sourceTurn: { sessionAlias: string; turnId?: string };
    now: string;
  }): ReconcileLateResult {
    return this.sqlite.transaction(() => {
      const run = this.requireRun(input.runId);
      const member = this.requireMemberTurn(input.memberTurnId);
      // Same referential + source-correlation fences as completeExecution:
      // a late result may only ever reclassify its own started member.
      if (
        member.runId !== run.id
        || member.conversationId !== run.conversationId
        || member.topicId !== run.topicId
      ) {
        throw new ConversationError(
          "run_member_mismatch",
          `member turn "${member.id}" does not belong to run "${run.id}"`,
        );
      }
      // A safe retry clears the current source until its new start. The old
      // physical attempt remains retired even if a sibling seals that queued
      // retry before it starts; absent current identity cannot authorize it.
      if (input.sourceTurn.turnId && this.sqlite.get(
        "SELECT 1 FROM recovery_attempts WHERE member_turn_id = ? AND source_turn_id = ?", [member.id, input.sourceTurn.turnId])) {
        throw new ConversationError("source_turn_mismatch", "result belongs to a retired recovery attempt");
      }
      if (
        (member.sessionAlias !== undefined && input.sourceTurn.sessionAlias !== member.sessionAlias)
        || (member.sourceTurnId !== undefined && input.sourceTurn.turnId !== member.sourceTurnId)
      ) {
        throw new ConversationError(
          "source_turn_mismatch",
          `source turn does not match member turn "${member.id}" execution identity`,
        );
      }
      // Two reconciliation windows (§14.3):
      // (a) Sealed Run: cancel settlement already aggregated the Run to
      //     indeterminate. A proven late result reclassifies exactly the
      //     indeterminate member it belongs to and re-derives the Run.
      // (b) Live Run under durable cancel intent: store.cancelRun() wrote the
      //     cancel intent (completion_reason) but the fan-out has not settled
      //     the batch yet. Persist MEMBER EVIDENCE ONLY — no Run aggregate;
      //     settleCancelBatch derives the final outcome from fresh member
      //     states (its terminal-member fence skips this member, so progress
      //     is never double-counted). Without (b), a proof landing mid-fan-out
      //     would be dropped and the batch would seal indeterminate despite
      //     observed evidence.
      // Clean cancelled Runs stay sealed (late completion never resurrects a
      // cancel the user requested); live Runs WITHOUT cancel intent and
      // already-proven members have nothing to reconcile. No dispatch,
      // progress, or scheduling state changes beyond member evidence.
      if (!TERMINAL_RUN_STATES.includes(run.state)) {
        if (run.completionReason == null || TERMINAL_MEMBER_STATES.includes(member.state) || !member.startedAt) {
          return { run, memberTurn: member, reconciled: false };
        }
        // Progress was already counted when this member settled indeterminate
        // (deferred batch evidence); a still-running member counts now, and
        // the later batch settlement skips it via its terminal-member fence.
        const alreadyCounted = member.state === "indeterminate";
        let pendingMessage: ConversationMessage | undefined;
        if (input.outcome === "completed") {
          const seq = this.allocateSeq(run.conversationId, run.topicId);
          const messageId = this.ids.messageId();
          this.sqlite.run(
            `INSERT INTO messages (
               id, conversation_id, topic_id, seq, role, sender_bot_id, content, run_id, source_turn_json, created_at
             ) VALUES (?, ?, ?, ?, 'bot', ?, ?, ?, ?, ?)`,
            [
              messageId,
              run.conversationId,
              run.topicId,
              seq,
              member.botId,
              input.content ?? "",
              run.id,
              JSON.stringify(input.sourceTurn),
              input.now,
            ],
          );
          this.sqlite.run(
            `UPDATE member_turns SET state = 'completed', failure_reason = NULL, finished_at = COALESCE(finished_at, ?) WHERE id = ?`,
            [input.now, member.id],
          );
          if (!alreadyCounted) {
            this.sqlite.run(
              `UPDATE runs SET consumed_member_turns = consumed_member_turns + 1 WHERE id = ?`,
              [run.id],
            );
          }
          this.finishDispatchForMemberTurn(member.id, input.now);
          pendingMessage = this.getMessage(messageId);
        } else {
          this.sqlite.run(
            `UPDATE member_turns SET state = 'failed', failure_reason = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?`,
            [input.reason ?? "failed", input.now, member.id],
          );
          if (!alreadyCounted) {
            this.sqlite.run(
              `UPDATE runs SET consumed_member_turns = consumed_member_turns + 1 WHERE id = ?`,
              [run.id],
            );
          }
          if (!run.failedBotIds.includes(member.botId)) {
            const current = new Set(run.failedBotIds);
            current.add(member.botId);
            this.sqlite.run(
              `UPDATE runs SET failed_bot_ids_json = ? WHERE id = ?`,
              [JSON.stringify([...current]), input.runId],
            );
          }
          this.finishDispatchForMemberTurn(member.id, input.now);
        }
        return {
          run: this.requireRun(input.runId),
          memberTurn: this.requireMemberTurn(member.id),
          ...(pendingMessage ? { message: pendingMessage } : {}),
          reconciled: true,
        };
      }
      // Reconcile ONLY the indeterminate-sealed case. Clean cancelled Runs
      // stay sealed (late completion never resurrects a cancel the user
      // requested); live Runs and already-proven members have nothing to
      // reconcile. No dispatch, progress, or scheduling state changes.
      if (run.state !== "indeterminate" || member.state !== "indeterminate" || !member.startedAt) {
        return { run, memberTurn: member, reconciled: false };
      }
      const evidence = this.persistSealedMemberEvidence({
        runId: run.id,
        memberTurnId: member.id,
        outcome: input.outcome,
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        sourceTurn: input.sourceTurn,
        now: input.now,
      });
      return {
        run: evidence.run,
        memberTurn: evidence.memberTurn,
        ...(evidence.message ? { message: evidence.message } : {}),
        reconciled: true,
      };
    });
  }

  private requireRun(runId: string): ConversationRun {
    const run = this.getRun(runId);
    if (!run) {
      throw new ConversationError("run_not_found", `run "${runId}" does not exist`);
    }
    return run;
  }

  private requireMessage(messageId: string): ConversationMessage {
    const message = this.getMessage(messageId);
    if (!message) {
      throw new ConversationError("message_not_found", `message "${messageId}" does not exist`);
    }
    return message;
  }

  private requireMemberTurn(memberTurnId: string): MemberTurnRecord {
    const turn = this.getMemberTurn(memberTurnId);
    if (!turn) {
      throw new ConversationError("member_turn_not_found", `member turn "${memberTurnId}" does not exist`);
    }
    return turn;
  }

  private requireDispatch(dispatchId: string): PendingDispatch {
    const row = this.sqlite.get<DispatchRow>("SELECT * FROM pending_dispatches WHERE id = ?", [dispatchId]);
    if (!row) {
      throw new ConversationError("dispatch_not_found", `dispatch "${dispatchId}" does not exist`);
    }
    return mapDispatch(row);
  }

  private requireDispatchForRun(runId: string): PendingDispatch {
    const dispatch = this.getDispatchForRun(runId);
    if (!dispatch) {
      throw new ConversationError("dispatch_not_found", `run "${runId}" has no dispatch`);
    }
    return dispatch;
  }

  private requireDispatchForMemberTurn(memberTurnId: string): PendingDispatch {
    const dispatch = this.getDispatchForMemberTurn(memberTurnId);
    if (!dispatch) {
      throw new ConversationError("dispatch_not_found", `member turn "${memberTurnId}" has no dispatch`);
    }
    return dispatch;
  }
}

export function isActiveRunState(state: ConversationRunState): boolean {
  return (ACTIVE_RUN_STATES as readonly string[]).includes(state);
}
