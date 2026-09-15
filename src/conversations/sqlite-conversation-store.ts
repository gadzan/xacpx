import {
  createConversationMessageId,
  createConversationRunId,
  createMemberTurnId,
  createPendingDispatchId,
} from "../domain/ids";
import type { BotProfileSnapshot } from "../bots/bot-types";
import { ConversationError } from "./conversation-error";
import type {
  AcceptRequestInput,
  AcceptRequestResult,
  CancelRunResult,
  ClaimedWork,
  ClaimNextDispatchInput,
  CompleteExecutionInput,
  CompleteExecutionResult,
  ConversationStore,
  FailExecutionInput,
  ListMessagesQuery,
  MarkExecutionStartedInput,
  RecoveredClaim,
} from "./conversation-store";
import type {
  ConversationMessage,
  ConversationRun,
  ConversationRunState,
  MemberTurnRecord,
  MemberTurnState,
  PendingDispatch,
  PendingDispatchState,
} from "./conversation-types";
import { ACTIVE_RUN_STATES, TERMINAL_RUN_STATES } from "./conversation-types";
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
  max_member_turns: number;
  consumed_member_turns: number;
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
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface DispatchRow {
  id: string;
  run_id: string;
  member_turn_id: string;
  generation: number;
  state: string;
  owner: string | null;
  lease_expires_at: string | null;
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
  max_member_turns INTEGER NOT NULL,
  consumed_member_turns INTEGER NOT NULL,
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
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS pending_dispatches (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  member_turn_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL,
  owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_topic_seq ON messages (topic_id, seq);
CREATE INDEX IF NOT EXISTS idx_runs_topic_state ON runs (topic_id, state, created_at);
CREATE INDEX IF NOT EXISTS idx_dispatches_state ON pending_dispatches (state, created_at);
CREATE INDEX IF NOT EXISTS idx_member_turns_run ON member_turns (run_id);
`;

function optionalString(value: string | null | undefined): string | undefined {
  return value == null || value === "" ? undefined : value;
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
  return {
    id: row.id,
    conversationId: row.conversation_id,
    topicId: row.topic_id,
    requestMessageId: row.request_message_id,
    requestId: row.request_id,
    mode: "explicit",
    state: row.state as ConversationRunState,
    ...(optionalString(row.completion_reason) ? { completionReason: row.completion_reason as string } : {}),
    generation: Number(row.generation),
    maxMemberTurns: Number(row.max_member_turns),
    consumedMemberTurns: Number(row.consumed_member_turns),
    profileRevision: Number(row.profile_revision),
    profileSnapshot: parseSnapshot(row.profile_snapshot_json),
    createdAt: row.created_at,
    ...(optionalString(row.started_at) ? { startedAt: row.started_at as string } : {}),
    ...(optionalString(row.finished_at) ? { finishedAt: row.finished_at as string } : {}),
  };
}

function mapMemberTurn(row: MemberTurnRow): MemberTurnRecord {
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
    createdAt: row.created_at,
    ...(optionalString(row.started_at) ? { startedAt: row.started_at as string } : {}),
    ...(optionalString(row.finished_at) ? { finishedAt: row.finished_at as string } : {}),
  };
}

function mapDispatch(row: DispatchRow): PendingDispatch {
  return {
    id: row.id,
    runId: row.run_id,
    memberTurnId: row.member_turn_id,
    generation: Number(row.generation),
    state: row.state as PendingDispatchState,
    ...(optionalString(row.owner) ? { owner: row.owner as string } : {}),
    ...(optionalString(row.lease_expires_at) ? { leaseExpiresAt: row.lease_expires_at as string } : {}),
    createdAt: row.created_at,
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

  constructor(
    private readonly db: SqlDriver,
    options?: SqliteConversationStoreOptions,
  ) {
    this.ids = options?.ids ?? defaultIds();
    this.beforeAcceptCommit = options?.beforeAcceptCommit;
    this.db.exec(SCHEMA);
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
      return this.db.transaction(() => {
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
    const row = this.db.get<RunRow>("SELECT * FROM runs WHERE id = ?", [runId]);
    return row ? mapRun(row) : undefined;
  }

  getRunByRequestId(conversationId: string, topicId: string, requestId: string): ConversationRun | undefined {
    const row = this.db.get<RunRow>(
      "SELECT * FROM runs WHERE conversation_id = ? AND topic_id = ? AND request_id = ?",
      [conversationId, topicId, requestId],
    );
    return row ? mapRun(row) : undefined;
  }

  listRuns(conversationId: string, topicId?: string): ConversationRun[] {
    const rows = topicId
      ? this.db.all<RunRow>(
        "SELECT * FROM runs WHERE conversation_id = ? AND topic_id = ? ORDER BY created_at ASC, id ASC",
        [conversationId, topicId],
      )
      : this.db.all<RunRow>(
        "SELECT * FROM runs WHERE conversation_id = ? ORDER BY created_at ASC, id ASC",
        [conversationId],
      );
    return rows.map(mapRun);
  }

  getMessage(messageId: string): ConversationMessage | undefined {
    const row = this.db.get<MessageRow>("SELECT * FROM messages WHERE id = ?", [messageId]);
    return row ? mapMessage(row) : undefined;
  }

  listMessages(query: ListMessagesQuery): ConversationMessage[] {
    const rows = this.db.all<MessageRow>(
      `SELECT * FROM messages
       WHERE conversation_id = ? AND topic_id = ?
         AND (? IS NULL OR seq > ?)
         AND (? IS NULL OR seq < ?)
       ORDER BY seq ASC
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
    return rows.map(mapMessage);
  }

  getMemberTurn(memberTurnId: string): MemberTurnRecord | undefined {
    const row = this.db.get<MemberTurnRow>("SELECT * FROM member_turns WHERE id = ?", [memberTurnId]);
    return row ? mapMemberTurn(row) : undefined;
  }

  listMemberTurns(runId: string): MemberTurnRecord[] {
    return this.db.all<MemberTurnRow>(
      "SELECT * FROM member_turns WHERE run_id = ? ORDER BY created_at ASC, id ASC",
      [runId],
    ).map(mapMemberTurn);
  }

  getDispatchForRun(runId: string): PendingDispatch | undefined {
    const row = this.db.get<DispatchRow>("SELECT * FROM pending_dispatches WHERE run_id = ?", [runId]);
    return row ? mapDispatch(row) : undefined;
  }

  recoverExpiredClaims(now: string, ownerId?: string): RecoveredClaim[] {
    return this.db.transaction(() => {
      const claimed = ownerId
        ? this.db.all<DispatchRow>(
          `SELECT * FROM pending_dispatches
           WHERE state = 'claimed'
             AND (
               (lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
               OR owner IS NULL
               OR owner != ?
             )`,
          [now, ownerId],
        )
        : this.db.all<DispatchRow>(
          `SELECT * FROM pending_dispatches
           WHERE state = 'claimed'
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at <= ?`,
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
        this.db.run(
          `UPDATE pending_dispatches
           SET state = 'pending', owner = NULL, claimed_at = NULL, lease_expires_at = NULL, generation = generation + 1
           WHERE id = ?`,
          [row.id],
        );
        this.db.run(
          `UPDATE member_turns SET state = 'queued', attempt = attempt + 1 WHERE id = ?`,
          [member.id],
        );
        this.db.run(`UPDATE runs SET state = 'queued', started_at = NULL WHERE id = ?`, [run.id]);
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
    return this.db.transaction(() => {
      const row = this.db.get<DispatchRow>(
        `SELECT d.* FROM pending_dispatches d
         JOIN runs r ON r.id = d.run_id
         JOIN member_turns m ON m.id = d.member_turn_id
         WHERE d.state = 'pending'
           AND r.state = 'queued'
           AND m.started_at IS NULL
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
               AND claimed.state = 'claimed'
           )
           AND NOT EXISTS (
             SELECT 1 FROM runs active
             WHERE active.topic_id = r.topic_id
               AND active.state IN ('running', 'waiting-human')
           )
         ORDER BY r.created_at ASC, r.id ASC
         LIMIT 1`,
      );
      if (!row) {
        return undefined;
      }
      this.db.run(
        `UPDATE pending_dispatches
         SET state = 'claimed', owner = ?, claimed_at = ?, lease_expires_at = ?
         WHERE id = ? AND state = 'pending'`,
        [input.owner, input.now, input.leaseExpiresAt, row.id],
      );
      this.db.run(`UPDATE member_turns SET state = 'dispatched' WHERE id = ?`, [row.member_turn_id]);
      return {
        dispatch: this.requireDispatch(row.id),
        run: this.requireRun(row.run_id),
        memberTurn: this.requireMemberTurn(row.member_turn_id),
      };
    });
  }

  releaseClaimToPending(dispatchId: string, now: string): PendingDispatch | undefined {
    return this.db.transaction(() => {
      const dispatch = this.db.get<DispatchRow>("SELECT * FROM pending_dispatches WHERE id = ?", [dispatchId]);
      if (!dispatch || dispatch.state !== "claimed") {
        return dispatch ? mapDispatch(dispatch) : undefined;
      }
      const member = this.requireMemberTurn(dispatch.member_turn_id);
      if (member.startedAt) {
        return mapDispatch(dispatch);
      }
      this.db.run(
        `UPDATE pending_dispatches
         SET state = 'pending', owner = NULL, claimed_at = NULL, lease_expires_at = NULL, generation = generation + 1
         WHERE id = ?`,
        [dispatchId],
      );
      this.db.run(`UPDATE member_turns SET state = 'queued' WHERE id = ?`, [dispatch.member_turn_id]);
      this.db.run(`UPDATE runs SET state = 'queued' WHERE id = ? AND state = 'running'`, [dispatch.run_id]);
      void now;
      return this.requireDispatch(dispatchId);
    });
  }

  markExecutionStarted(input: MarkExecutionStartedInput): MemberTurnRecord {
    return this.db.transaction(() => {
      const run = this.requireRun(input.runId);
      if (run.state === "cancelled" || run.state === "failed" || run.state === "completed") {
        throw new ConversationError("run_not_runnable", `run "${input.runId}" is ${run.state}`);
      }
      if (run.state === "indeterminate") {
        throw new ConversationError("run_indeterminate", `run "${input.runId}" is indeterminate`);
      }
      this.db.run(
        `UPDATE member_turns
         SET state = 'running',
             session_alias = ?,
             logical_session_id = ?,
             source_turn_id = ?,
             queue_item_id = COALESCE(?, queue_item_id),
             started_at = ?
         WHERE id = ?`,
        [
          input.sessionAlias,
          input.logicalSessionId,
          input.sourceTurnId,
          input.queueItemId ?? null,
          input.now,
          input.memberTurnId,
        ],
      );
      this.db.run(
        `UPDATE runs SET state = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?`,
        [input.now, input.runId],
      );
      return this.requireMemberTurn(input.memberTurnId);
    });
  }

  completeExecution(input: CompleteExecutionInput): CompleteExecutionResult {
    return this.db.transaction(() => {
      const run = this.requireRun(input.runId);
      const member = this.requireMemberTurn(input.memberTurnId);
      if (run.state === "cancelled") {
        this.finishDispatchForRun(run.id, input.now);
        if (!member.finishedAt) {
          this.db.run(
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
        this.finishDispatchForRun(run.id, input.now);
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
      this.db.run(
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
      this.db.run(
        `UPDATE member_turns SET state = 'completed', finished_at = ? WHERE id = ?`,
        [input.now, member.id],
      );
      this.db.run(
        `UPDATE runs
         SET state = 'completed',
             completion_reason = ?,
             consumed_member_turns = consumed_member_turns + 1,
             finished_at = ?
         WHERE id = ?`,
        [input.completionReason ?? "completed", input.now, run.id],
      );
      this.finishDispatchForRun(run.id, input.now);
      return {
        run: this.requireRun(run.id),
        memberTurn: this.requireMemberTurn(member.id),
        assistantMessage: this.getMessage(messageId),
        resurrected: false,
      };
    });
  }

  failExecution(input: FailExecutionInput): ConversationRun {
    return this.db.transaction(() => {
      const run = this.requireRun(input.runId);
      if (TERMINAL_RUN_STATES.includes(run.state)) {
        return run;
      }
      const state = input.terminalState ?? "failed";
      this.db.run(
        `UPDATE member_turns SET state = ?, finished_at = ? WHERE id = ?`,
        [state, input.now, input.memberTurnId],
      );
      this.db.run(
        `UPDATE runs SET state = ?, completion_reason = ?, finished_at = ? WHERE id = ?`,
        [state, input.reason, input.now, input.runId],
      );
      this.finishDispatchForRun(input.runId, input.now);
      return this.requireRun(input.runId);
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
    return this.db.transaction(() => {
      const run = this.requireRun(runId);
      const member = this.listMemberTurns(runId)[0];
      if (!member) {
        throw new ConversationError("member_turn_missing", `run "${runId}" has no member turn`);
      }
      const dispatch = this.requireDispatchForRun(runId);
      const executionStarted = Boolean(member.startedAt);
      if (TERMINAL_RUN_STATES.includes(run.state)) {
        return { run, memberTurn: member, dispatch, alreadyTerminal: true, executionStarted };
      }
      if (executionStarted) {
        // Cancellation of a started turn is recorded by the dispatcher after
        // it observes the underlying cancel outcome. Persist a cancelling
        // intent by completing the dispatch only when never started.
        this.db.run(
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
      this.db.run(
        `UPDATE member_turns SET state = 'cancelled', finished_at = ? WHERE id = ?`,
        [now, member.id],
      );
      this.db.run(
        `UPDATE runs SET state = 'cancelled', completion_reason = ?, finished_at = ? WHERE id = ?`,
        [reason, now, runId],
      );
      this.finishDispatch(dispatch.id, now);
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
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO conversation_lifecycle (conversation_id, state, updated_at)
         VALUES (?, 'deleting', ?)
         ON CONFLICT(conversation_id) DO UPDATE SET state = 'deleting', updated_at = excluded.updated_at`,
        [conversationId, now],
      );
    });
  }

  markTopicDeleting(topicId: string, conversationId: string, now: string): void {
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO topic_lifecycle (topic_id, conversation_id, state, updated_at)
         VALUES (?, ?, 'deleting', ?)
         ON CONFLICT(topic_id) DO UPDATE SET state = 'deleting', updated_at = excluded.updated_at`,
        [topicId, conversationId, now],
      );
    });
  }

  isConversationDeleting(conversationId: string): boolean {
    const row = this.db.get<{ state: string }>(
      "SELECT state FROM conversation_lifecycle WHERE conversation_id = ?",
      [conversationId],
    );
    return row?.state === "deleting";
  }

  isTopicDeleting(topicId: string): boolean {
    const row = this.db.get<{ state: string }>(
      "SELECT state FROM topic_lifecycle WHERE topic_id = ?",
      [topicId],
    );
    return row?.state === "deleting";
  }

  deleteTopicRows(conversationId: string, topicId: string): void {
    this.db.transaction(() => {
      this.db.run("DELETE FROM pending_dispatches WHERE run_id IN (SELECT id FROM runs WHERE topic_id = ?)", [topicId]);
      this.db.run("DELETE FROM member_turns WHERE topic_id = ?", [topicId]);
      this.db.run("DELETE FROM messages WHERE topic_id = ?", [topicId]);
      this.db.run("DELETE FROM runs WHERE topic_id = ?", [topicId]);
      this.db.run("DELETE FROM topic_seq WHERE topic_id = ?", [topicId]);
      this.db.run("DELETE FROM topic_lifecycle WHERE topic_id = ?", [topicId]);
      void conversationId;
    });
  }

  deleteConversationRows(conversationId: string): void {
    this.db.transaction(() => {
      this.db.run(
        "DELETE FROM pending_dispatches WHERE run_id IN (SELECT id FROM runs WHERE conversation_id = ?)",
        [conversationId],
      );
      this.db.run("DELETE FROM member_turns WHERE conversation_id = ?", [conversationId]);
      this.db.run("DELETE FROM messages WHERE conversation_id = ?", [conversationId]);
      this.db.run("DELETE FROM runs WHERE conversation_id = ?", [conversationId]);
      this.db.run("DELETE FROM topic_seq WHERE conversation_id = ?", [conversationId]);
      this.db.run("DELETE FROM topic_lifecycle WHERE conversation_id = ?", [conversationId]);
      this.db.run("DELETE FROM conversation_lifecycle WHERE conversation_id = ?", [conversationId]);
    });
  }

  close(): void {
    this.db.close();
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
    const memberTurnId = this.ids.memberTurnId();
    const dispatchId = this.ids.dispatchId();
    const maxMemberTurns = input.maxMemberTurns ?? 1;
    this.db.run(
      `INSERT INTO messages (
         id, conversation_id, topic_id, seq, role, sender_bot_id, content, run_id, source_turn_json, created_at
       ) VALUES (?, ?, ?, ?, 'human', NULL, ?, ?, NULL, ?)`,
      [messageId, input.conversationId, input.topicId, seq, input.content, runId, input.now],
    );
    this.db.run(
      `INSERT INTO runs (
         id, conversation_id, topic_id, request_message_id, request_id, mode, state, completion_reason,
         generation, max_member_turns, consumed_member_turns, profile_revision, profile_snapshot_json,
         created_at, started_at, finished_at
       ) VALUES (?, ?, ?, ?, ?, 'explicit', 'queued', NULL, 1, ?, 0, ?, ?, ?, NULL, NULL)`,
      [
        runId,
        input.conversationId,
        input.topicId,
        messageId,
        input.requestId,
        maxMemberTurns,
        input.profileSnapshot.revision,
        JSON.stringify(input.profileSnapshot),
        input.now,
      ],
    );
    this.db.run(
      `INSERT INTO member_turns (
         id, run_id, conversation_id, topic_id, bot_id, session_alias, logical_session_id, source_turn_id,
         queue_item_id, batch, attempt, origin, state, trigger_message_ids_json, created_at, started_at, finished_at
       ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 1, 1, 'human', 'queued', ?, ?, NULL, NULL)`,
      [memberTurnId, runId, input.conversationId, input.topicId, input.botId, JSON.stringify([messageId]), input.now],
    );
    this.db.run(
      `INSERT INTO pending_dispatches (
         id, run_id, member_turn_id, generation, state, owner, lease_expires_at, created_at, claimed_at, completed_at
       ) VALUES (?, ?, ?, 1, 'pending', NULL, NULL, ?, NULL, NULL)`,
      [dispatchId, runId, memberTurnId, input.now],
    );
    return {
      reused: false,
      message: this.requireMessage(messageId),
      run: this.requireRun(runId),
      memberTurn: this.requireMemberTurn(memberTurnId),
      dispatch: this.requireDispatch(dispatchId),
    };
  }

  private allocateSeq(conversationId: string, topicId: string): number {
    const row = this.db.get<{ next_seq: number }>(
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
    const memberTurn = this.listMemberTurns(run.id)[0];
    const dispatch = this.getDispatchForRun(run.id);
    if (!message || !memberTurn || !dispatch) {
      throw new ConversationError("accepted_request_incomplete", `request "${requestId}" is missing durable rows`);
    }
    return { message, run, memberTurn, dispatch };
  }

  private writeIndeterminate(runId: string, memberTurnId: string, now: string, reason: string): void {
    this.db.run(
      `UPDATE member_turns SET state = 'indeterminate', finished_at = COALESCE(finished_at, ?) WHERE id = ?`,
      [now, memberTurnId],
    );
    this.db.run(
      `UPDATE runs SET state = 'indeterminate', completion_reason = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?`,
      [reason, now, runId],
    );
    this.finishDispatchForRun(runId, now);
  }

  private finishDispatchForRun(runId: string, now: string): void {
    const dispatch = this.db.get<DispatchRow>("SELECT * FROM pending_dispatches WHERE run_id = ?", [runId]);
    if (dispatch) {
      this.finishDispatch(dispatch.id, now);
    }
  }

  private finishDispatch(dispatchId: string, now: string): void {
    this.db.run(
      `UPDATE pending_dispatches
       SET state = 'completed', completed_at = COALESCE(completed_at, ?), lease_expires_at = NULL
       WHERE id = ?`,
      [now, dispatchId],
    );
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
    const row = this.db.get<DispatchRow>("SELECT * FROM pending_dispatches WHERE id = ?", [dispatchId]);
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
}

export function isActiveRunState(state: ConversationRunState): boolean {
  return (ACTIVE_RUN_STATES as readonly string[]).includes(state);
}
