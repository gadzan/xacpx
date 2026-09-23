import {
  createConversationMessageId,
  createConversationRunId,
  createDirectConversationId,
  createMemberTurnId,
  createPendingDispatchId,
} from "../domain/ids";
import type { BotProfileSnapshot } from "../bots/bot-types";
import { ConversationError } from "./conversation-error";
import type {
  AcceptRequestInput,
  AcceptRequestResult,
  AssertLiveDispatchForMaterializeInput,
  CancelRunResult,
  ClaimedWork,
  ClaimNextDispatchInput,
  CompleteExecutionInput,
  CompleteExecutionResult,
  ConversationStore,
  FailClaimBeforeStartInput,
  FailExecutionInput,
  ListMessagesQuery,
  MarkExecutionStartedInput,
  RecoveredClaim,
  ReleaseClaimToPendingInput,
} from "./conversation-store";
import {
  conversationExecutionOrigin,
  memberTurnOriginFromExecution,
  parseHumanIngress,
} from "./conversation-execution";
import type {
  ConversationMessage,
  ConversationRun,
  ConversationRunState,
  HumanIngressContext,
  MemberTurnRecord,
  MemberTurnState,
  PendingDispatch,
  PendingDispatchState,
} from "./conversation-types";
import { ACTIVE_RUN_STATES, TERMINAL_MEMBER_STATES, TERMINAL_RUN_STATES } from "./conversation-types";
import { createSqlDriver, isSqliteUniqueViolation, type SqlDriver } from "./sql-driver";

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
}

interface MessageRow {
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
  id: string;
  conversation_id: string;
  topic_id: string;
  request_message_id: string;
  request_id: string;
  mode: string;
  state: string;
  completion_reason: string | null;
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
  attempt: number;
  origin: string;
  state: string;
  trigger_message_ids_json: string;
  profile_snapshot_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  assignment_id: string | null;
  task: string | null;
  expected_output: string | null;
  depends_on_json: string | null;
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

const SCHEMA = `
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
  attempt INTEGER NOT NULL DEFAULT 1,
  origin TEXT NOT NULL,
  state TEXT NOT NULL,
  trigger_message_ids_json TEXT NOT NULL,
  profile_snapshot_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
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

function parseSnapshot(json: string): BotProfileSnapshot {
  return JSON.parse(json) as BotProfileSnapshot;
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
    ...(optionalString(row.run_id) ? { runId: row.run_id as string } : {}),
    createdAt: row.created_at,
    ...(sourceTurn ? { sourceTurn } : {}),
  };
}

function mapRun(row: RunRow): ConversationRun {
  const mode = row.mode === "automatic" ? "automatic" : "explicit";
  return {
    id: row.id,
    conversationId: row.conversation_id,
    topicId: row.topic_id,
    requestMessageId: row.request_message_id,
    requestId: row.request_id,
    mode,
    state: row.state as ConversationRunState,
    ...(optionalString(row.completion_reason) ? { completionReason: row.completion_reason as string } : {}),
    generation: Number(row.generation),
    ...(row.active_batch !== null && row.active_batch !== undefined
      ? { activeBatch: Number(row.active_batch) }
      : {}),
    maxMemberTurns: Number(row.max_member_turns),
    consumedMemberTurns: Number(row.consumed_member_turns),
    failedBotIds: parseBotIds(row.failed_bot_ids_json),
    unavailableBotIds: parseBotIds(row.unavailable_bot_ids_json),
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

function parseDependsOn(json: string | null | undefined): string[] {
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

function parseMemberSnapshot(json: string | null | undefined): BotProfileSnapshot | undefined {
  if (!json) {
    return undefined;
  }
  try {
    return JSON.parse(json) as BotProfileSnapshot;
  } catch {
    return undefined;
  }
}

function mapMemberTurn(row: MemberTurnRow): MemberTurnRecord {
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
    attempt: Number(row.attempt),
    origin: row.origin as MemberTurnRecord["origin"],
    state: row.state as MemberTurnState,
    triggerMessageIds: JSON.parse(row.trigger_message_ids_json) as string[],
    ...(snapshot ? { profileSnapshot: snapshot } : {}),
    createdAt: row.created_at,
    ...(optionalString(row.started_at) ? { startedAt: row.started_at as string } : {}),
    ...(optionalString(row.finished_at) ? { finishedAt: row.finished_at as string } : {}),
    ...(optionalString(row.assignment_id) ? { assignmentId: row.assignment_id as string } : {}),
    ...(optionalString(row.task) ? { task: row.task as string } : {}),
    ...(optionalString(row.expected_output) ? { expectedOutput: row.expected_output as string } : {}),
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
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

export class SqliteConversationStore implements ConversationStore {
  private readonly ids: ConversationIdFactory;
  private readonly beforeAcceptCommit?: () => void;
  private readonly beforeDispatchMigrationCommit?: () => void;

  private closed = false;

  constructor(
    private readonly db: SqlDriver,
    options?: SqliteConversationStoreOptions,
  ) {
    this.ids = options?.ids ?? defaultIds();
    this.beforeAcceptCommit = options?.beforeAcceptCommit;
    this.beforeDispatchMigrationCommit = options?.beforeDispatchMigrationCommit;
    this.sqlite.exec(SCHEMA);
    this.ensureDispatchAuthorityEpochColumn();
    this.ensureDispatchHumanIngressColumn();
    this.ensureMemberTurnAssignmentColumns();
    this.ensureMemberTurnSnapshotColumn();
    this.ensureRunAggregateColumns();
    this.ensureDispatchMultiMemberShape();
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
    return new SqliteConversationStore(db, options);
  }

  acceptRequest(input: AcceptRequestInput): AcceptRequestResult {
    const existing = this.loadAccepted(input.conversationId, input.topicId, input.requestId);
    if (existing) {
      return { reused: true, ...existing };
    }
    try {
      return this.sqlite.transaction(() => {
        this.assertAcceptable(input.conversationId, input.topicId);
        const created = this.insertAccepted(input);
        this.beforeAcceptCommit?.();
        return created;
      });
    } catch (error) {
      if (isSqliteUniqueViolation(error)) {
        const reused = this.loadAccepted(input.conversationId, input.topicId, input.requestId);
        if (reused) {
          return { reused: true, ...reused };
        }
      }
      throw error;
    }
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
      "SELECT * FROM member_turns WHERE run_id = ? ORDER BY created_at ASC, id ASC",
      [runId],
    ).map(mapMemberTurn);
  }

  getDispatchForRun(runId: string): PendingDispatch | undefined {
    const row = this.sqlite.get<DispatchRow>(
      "SELECT * FROM pending_dispatches WHERE run_id = ? ORDER BY created_at ASC, id ASC",
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
      "SELECT * FROM pending_dispatches WHERE run_id = ? ORDER BY created_at ASC, id ASC",
      [runId],
    ).map(mapDispatch);
  }

  recoverExpiredClaims(now: string): RecoveredClaim[] {
    return this.sqlite.transaction(() => {
      const claimed = this.sqlite.all<DispatchRow>(
        `SELECT * FROM pending_dispatches
         WHERE state = 'claimed'
           AND (
             (lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
             OR (owner IS NULL AND lease_expires_at IS NULL)
           )`,
        [now],
      );
      const recovered: RecoveredClaim[] = [];
      for (const row of claimed) {
        const member = this.requireMemberTurn(row.member_turn_id);
        const run = this.requireRun(row.run_id);
        if (TERMINAL_RUN_STATES.includes(run.state)) {
          this.finishDispatch(row.id, now);
          continue;
        }
        if (member.startedAt) {
          this.writeIndeterminate(run.id, member.id, now, "started_result_unknown");
          recovered.push({
            dispatch: this.requireDispatch(row.id),
            run: this.requireRun(run.id),
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
        this.sqlite.run(`UPDATE runs SET state = 'queued', started_at = NULL WHERE id = ?`, [run.id]);
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

  claimNextDispatch(input: ClaimNextDispatchInput): ClaimedWork | undefined {
    return this.sqlite.transaction(() => {
      const skipTopicIds = input.skipTopicIds ?? [];
      const skipClause = skipTopicIds.length === 0
        ? ""
        : `AND r.topic_id NOT IN (${skipTopicIds.map(() => "?").join(",")})`;
      const row = this.sqlite.get<DispatchRow>(
        `SELECT d.* FROM pending_dispatches d
         JOIN runs r ON r.id = d.run_id
         JOIN member_turns m ON m.id = d.member_turn_id
         JOIN messages msg ON msg.id = r.request_message_id
         WHERE d.state = 'pending'
           AND r.state IN ('queued', 'running')
           AND m.started_at IS NULL
           AND m.state IN ('queued', 'dispatched')
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
           ${skipClause}
         ORDER BY msg.seq ASC, r.created_at ASC, r.topic_id ASC
         LIMIT 1`,
        skipTopicIds,
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
      this.sqlite.run(
        `UPDATE member_turns SET state = 'dispatched', origin = ? WHERE id = ?`,
        [memberTurnOriginFromExecution(executionOrigin), row.member_turn_id],
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
      this.sqlite.run(`UPDATE runs SET state = 'queued' WHERE id = ? AND state = 'running'`, [dispatch.run_id]);
      return this.requireDispatch(dispatch.id);
    });
  }

  markExecutionStarted(input: MarkExecutionStartedInput): MemberTurnRecord {
    return this.sqlite.transaction(() => {
      this.requireLiveUnstartedClaim(input);
      const run = this.requireRun(input.runId);
      const member = this.requireMemberTurn(input.memberTurnId);
      if (TERMINAL_RUN_STATES.includes(run.state) || TERMINAL_MEMBER_STATES.includes(member.state)) {
        throw new ConversationError("run_not_runnable", `run "${input.runId}" is ${run.state}`);
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
      if (TERMINAL_RUN_STATES.includes(run.state) || TERMINAL_MEMBER_STATES.includes(member.state)) {
        throw new ConversationError("run_not_runnable", `run "${input.runId}" is ${run.state}`);
      }
    });
  }

  completeExecution(input: CompleteExecutionInput): CompleteExecutionResult {
    return this.sqlite.transaction(() => {
      const run = this.requireRun(input.runId);
      const member = this.requireMemberTurn(input.memberTurnId);
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
          input.botId,
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
      const aggregated = this.aggregateRunAfterMemberTerminal(run.id, input.now, "completed");
      return {
        run: aggregated,
        memberTurn: this.requireMemberTurn(member.id),
        assistantMessage: this.getMessage(messageId),
        resurrected: false,
      };
    });
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

  completeCancel(runId: string, memberTurnId: string, now: string, indeterminate = false): ConversationRun {
    return this.failExecution({
      runId,
      memberTurnId,
      now,
      reason: indeterminate ? "started_result_unknown" : "cancelled",
      terminalState: indeterminate ? "indeterminate" : "cancelled",
    });
  }

  cancelRun(runId: string, now: string, reason = "cancelled"): CancelRunResult {
    return this.sqlite.transaction(() => {
      const run = this.requireRun(runId);
      const members = this.listMemberTurns(runId);
      const member = members[0];
      if (!member) {
        throw new ConversationError("member_turn_missing", `run "${runId}" has no member turn`);
      }
      const dispatch = this.requireDispatchForMemberTurn(member.id);
      const executionStarted = members.some((turn) => Boolean(turn.startedAt));
      if (TERMINAL_RUN_STATES.includes(run.state)) {
        return { run, memberTurn: member, dispatch, alreadyTerminal: true, executionStarted };
      }
      if (executionStarted) {
        // Cancellation of a started turn is recorded by the dispatcher after
        // it observes the underlying cancel outcome. Persist a cancelling
        // intent by completing the dispatch only when never started.
        this.sqlite.run(
          `UPDATE runs SET completion_reason = ? WHERE id = ?`,
          [reason, runId],
        );
        return {
          run: this.requireRun(runId),
          memberTurn: member,
          dispatch: this.requireDispatch(dispatch.id),
          alreadyTerminal: false,
          executionStarted: true,
        };
      }
      // Multi-member cancel: every unstarted member settles in one
      // transaction so no sibling dispatch survives the Run's terminal state.
      for (const turn of members) {
        this.sqlite.run(
          `UPDATE member_turns SET state = 'cancelled', finished_at = ? WHERE id = ? AND finished_at IS NULL`,
          [now, turn.id],
        );
        this.finishDispatchForMemberTurn(turn.id, now);
      }
      this.sqlite.run(
        `UPDATE runs SET state = 'cancelled', completion_reason = ?, finished_at = ? WHERE id = ?`,
        [reason, now, runId],
      );
      return {
        run: this.requireRun(runId),
        memberTurn: this.requireMemberTurn(member.id),
        dispatch: this.requireDispatch(dispatch.id),
        alreadyTerminal: false,
        executionStarted: false,
      };
    });
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
      this.sqlite.run(
        "DELETE FROM pending_dispatches WHERE run_id IN (SELECT id FROM runs WHERE conversation_id = ?)",
        [conversationId],
      );
      this.sqlite.run("DELETE FROM member_turns WHERE conversation_id = ?", [conversationId]);
      this.sqlite.run("DELETE FROM messages WHERE conversation_id = ?", [conversationId]);
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

  private assertAcceptable(conversationId: string, topicId: string): void {
    if (this.isConversationDeleting(conversationId)) {
      throw new ConversationError("conversation_deleting", `conversation "${conversationId}" is deleting`);
    }
    if (this.isTopicDeleting(topicId)) {
      throw new ConversationError("topic_deleting", `topic "${topicId}" is deleting`);
    }
  }

  private insertAccepted(input: AcceptRequestInput): AcceptRequestResult {
    const seq = this.allocateSeq(input.conversationId, input.topicId);
    const messageId = this.ids.messageId();
    const runId = this.ids.runId();
    const members = [
      {
        botId: input.botId,
        profileSnapshot: input.profileSnapshot,
      },
      ...(input.members ?? []),
    ];
    const maxMemberTurns = input.maxMemberTurns ?? members.length;
    const mode = input.mode ?? "explicit";
    this.sqlite.run(
      `INSERT INTO messages (
         id, conversation_id, topic_id, seq, role, sender_bot_id, content, run_id, source_turn_json, created_at
       ) VALUES (?, ?, ?, ?, 'human', NULL, ?, ?, NULL, ?)`,
      [messageId, input.conversationId, input.topicId, seq, input.content, runId, input.now],
    );
    this.sqlite.run(
      `INSERT INTO runs (
         id, conversation_id, topic_id, request_message_id, request_id, mode, state, completion_reason,
         generation, active_batch, max_member_turns, consumed_member_turns,
         failed_bot_ids_json, unavailable_bot_ids_json,
         profile_revision, profile_snapshot_json,
         created_at, started_at, finished_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'queued', NULL, 1, 1, ?, 0, '[]', '[]', ?, ?, ?, NULL, NULL)`,
      [
        runId,
        input.conversationId,
        input.topicId,
        messageId,
        input.requestId,
        mode,
        maxMemberTurns,
        input.profileSnapshot.revision,
        JSON.stringify(input.profileSnapshot),
        input.now,
      ],
    );
    const ingressJson = serializeHumanIngress(input.humanIngress);
    const authorityEpoch = ingressJson ? (input.authorityEpoch ?? null) : null;
    const memberOrigin = ingressJson && authorityEpoch ? "human" : "recovery";
    const seenBotIds = new Set<string>();
    const memberTurnIds: string[] = [];
    const dispatchIds: string[] = [];
    for (const member of members) {
      if (seenBotIds.has(member.botId)) {
        throw new ConversationError("duplicate_member", `run accepts bot "${member.botId}" twice`);
      }
      seenBotIds.add(member.botId);
      const memberTurnId = this.ids.memberTurnId();
      const dispatchId = this.ids.dispatchId();
      this.sqlite.run(
        `INSERT INTO member_turns (
           id, run_id, conversation_id, topic_id, bot_id, session_alias, logical_session_id, source_turn_id,
           queue_item_id, batch, attempt, origin, state, trigger_message_ids_json, profile_snapshot_json,
           created_at, started_at, finished_at,
           assignment_id, task, expected_output, depends_on_json
         ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 1, 1, ?, 'queued', ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
        [
          memberTurnId,
          runId,
          input.conversationId,
          input.topicId,
          member.botId,
          memberOrigin,
          JSON.stringify([messageId]),
          JSON.stringify(member.profileSnapshot),
          input.now,
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
      memberTurn: memberTurns[0]!,
      dispatch: dispatches[0]!,
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
    if (!message || !memberTurn || !dispatch || memberTurns.length !== dispatches.length) {
      throw new ConversationError("accepted_request_incomplete", `request "${requestId}" is missing durable rows`);
    }
    return { message, run, memberTurn, dispatch, memberTurns, dispatches };
  }

  private writeIndeterminate(runId: string, memberTurnId: string, now: string, reason: string): void {
    this.sqlite.run(
      `UPDATE member_turns SET state = 'indeterminate', finished_at = COALESCE(finished_at, ?) WHERE id = ?`,
      [now, memberTurnId],
    );
    this.sqlite.run(
      `UPDATE runs SET state = 'indeterminate', completion_reason = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?`,
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

  private applyFailExecution(input: FailExecutionInput): ConversationRun {
    const run = this.requireRun(input.runId);
    if (TERMINAL_RUN_STATES.includes(run.state)) {
      return run;
    }
    const state = input.terminalState ?? "failed";
    this.sqlite.run(
      `UPDATE member_turns SET state = ?, finished_at = ? WHERE id = ?`,
      [state, input.now, input.memberTurnId],
    );
    this.sqlite.run(
      `UPDATE runs SET consumed_member_turns = consumed_member_turns + 1 WHERE id = ?`,
      [input.runId],
    );
    this.finishDispatchForMemberTurn(input.memberTurnId, input.now);
    return this.aggregateRunAfterMemberTerminal(input.runId, input.now, state, input.reason);
  }

  /**
   * Aggregate Run lifecycle after one MemberTurn reaches a terminal state.
   * Member completion terminals only the member; the Run terminals when no
   * member of the active batch is still runnable. Explicit Runs aggregate
   * over the accepted batch (no Router follows); automatic Runs leave the
   * non-terminal intermediate state durable for the PR8 Router, which adds
   * later batches. Failed/cancelled/indeterminate members accumulate in
   * failedBotIds (durable progress); unavailableBotIds is PR7+ reservation
   * surface, defaulting empty.
   */
  private aggregateRunAfterMemberTerminal(
    runId: string,
    now: string,
    memberState: MemberTurnState,
    reason?: string,
  ): ConversationRun {
    const run = this.requireRun(runId);
    if (TERMINAL_RUN_STATES.includes(run.state)) {
      return run;
    }
    const members = this.listMemberTurns(runId);
    const batch = run.activeBatch ?? 1;
    const batchMembers = members.filter((turn) => turn.batch === batch);
    const terminal = batchMembers.filter((turn) => TERMINAL_MEMBER_STATES.includes(turn.state));
    const member = this.requireMemberTurn(
      members.find((turn) => turn.state === memberState)?.id ?? members[0]!.id,
    );
    if (memberState === "failed" || memberState === "cancelled" || memberState === "indeterminate") {
      const current = new Set(run.failedBotIds);
      current.add(member.botId);
      this.sqlite.run(`UPDATE runs SET failed_bot_ids_json = ? WHERE id = ?`, [JSON.stringify([...current]), runId]);
    }
    if (terminal.length < batchMembers.length) {
      // Intermediate state: one member terminal, siblings still runnable.
      // The Run stays non-terminal (running) so claimNextDispatch keeps
      // serving the batch; PR8 Router continues from this durable state.
      if (run.state === "queued") {
        this.sqlite.run(`UPDATE runs SET state = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?`, [now, runId]);
      }
      return this.requireRun(runId);
    }
    // All batch members terminal: aggregate.
    const failed = batchMembers.filter((turn) => turn.state === "failed" || turn.state === "indeterminate");
    const cancelled = batchMembers.filter((turn) => turn.state === "cancelled");
    if (failed.length > 0) {
      const firstBad = failed[0]!;
      const state = firstBad.state === "indeterminate" ? "indeterminate" : "failed";
      this.sqlite.run(
        `UPDATE runs SET state = ?, completion_reason = ?, finished_at = ? WHERE id = ?`,
        [state, reason ?? (state === "indeterminate" ? "started_result_unknown" : "execution-failed"), now, runId],
      );
      return this.requireRun(runId);
    }
    if (cancelled.length === batchMembers.length) {
      this.sqlite.run(
        `UPDATE runs SET state = 'cancelled', completion_reason = ?, finished_at = ? WHERE id = ?`,
        [reason ?? "human-cancelled", now, runId],
      );
      return this.requireRun(runId);
    }
    if (cancelled.length > 0) {
      this.sqlite.run(
        `UPDATE runs SET state = 'failed', completion_reason = ?, finished_at = ? WHERE id = ?`,
        [reason ?? "execution-failed", now, runId],
      );
      return this.requireRun(runId);
    }
    this.sqlite.run(
      `UPDATE runs SET state = 'completed', completion_reason = ?, finished_at = ? WHERE id = ?`,
      ["members-completed", now, runId],
    );
    return this.requireRun(runId);
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
